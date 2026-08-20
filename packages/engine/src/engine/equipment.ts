import type { GameState, PlayerState } from "../model/game-state.js";
import { findUnitAnywhere } from "./target-lookup.js";
import type { GearInstance, UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
// effect-helpers imports `detachAllFrom` from here, so this is a CYCLE — and it
// is the one this module already had for the two payment helpers. Safe for the
// same reason recorded on target-lookup's: every binding is a hoisted function
// declaration read at call time, never at module initialisation.
import { payEnergyFromPool, payPowerFromChanneled, withMightTransitions } from "./effect-helpers.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { parkDecision, type DecisionDefinition } from "./decisions.js";
import type { Keyword } from "../model/keyword.js";
import { mergeGrantedKeyword } from "./keyword-stacking.js";
import { holdEventTrigger, type Listener } from "./triggers.js";

/**
 * Equipment attachment — SFD's headline subsystem, and the one the survey called
 * the set's largest single piece of work at 53 cards.
 *
 * # What an Equipment IS here
 *
 * A Gear carrying the printed `Equipment` tag. Attaching does NOT move it: it
 * stays in its controller's `activeGear` exactly as before, and
 * `attachedToInstanceId` is state layered on top. That field already existed on
 * `GearInstance` before any of this, for Fading Memories.
 *
 * # Three rules that shaped this, each read off a card rather than assumed
 *
 * **Re-equipping MOVES it; it does not require detaching first.**
 * `[Weaponmaster]`'s own reminder text is explicit — "you may [Equip] one of
 * your Equipment to me for 1 rainbow less, **even if it's already attached**".
 * So `attachEquipment` makes no attached-vs-unattached distinction.
 *
 * **A unit leaving play DETACHES its Equipment; it does not destroy it.** The
 * Zero Drive's "Use only if unattached" and Spinning Axe's "if this is
 * unattached, kill it" both presuppose a Gear outliving its wearer, sitting
 * unattached.
 *
 * **The `[Equip]` cost is completely independent of the Gear's PLAY cost.**
 * Doran's Blade is played for 2 Energy and equipped for 1 Body Power. A Gear is
 * played to `activeGear` exactly as before and `[Equip]` is a second,
 * separately-paid ability that attaches it later.
 *
 * # One choke point
 *
 * `attachEquipment` and `detachEquipment` are the only writers of
 * `attachedToInstanceId`. Nothing else assigns it, so a future attach source
 * cannot skip whatever these grow to do — the same convention that makes
 * `readyUnit` the only thing that fires `unitReadied`.
 */

/** Is this Gear an Equipment — i.e. does its printed card carry the tag? Asked
 *  of the DEFINITION rather than the instance, because the tag is printed and
 *  cannot change in play. */
export function isEquipmentGear(gear: { defId: string }): boolean {
  const def = defaultCardRegistry().tryGet(gear.defId);
  return def?.type === "Gear" && def.isEquipment === true;
}

/** The "+N Might" badge this Equipment grants, or 0. Art-only data — see
 *  `card-loader`'s EQUIP_MIGHT_BONUS for why it is a table. */
export function equipMightBonusOf(gear: { defId: string }): number {
  const def = defaultCardRegistry().tryGet(gear.defId);
  return def?.type === "Gear" ? (def.equipMightBonus ?? 0) : 0;
}

/**
 * Attaches `gearInstanceId` to `unitInstanceId`, moving it if it was already
 * attached elsewhere.
 *
 * A no-op when the gear is not the player's — attaching is always "an Equipment
 * YOU control to a unit YOU control", and a silent no-op is the same
 * target-vanished convention every other helper here follows.
 */
export function attachEquipment(
  state: GameState,
  ownerIndex: 0 | 1,
  gearInstanceId: string,
  unitInstanceId: string,
): GameState {
  const owner = state.players[ownerIndex];
  if (!owner.activeGear.some((g) => g.instanceId === gearInstanceId)) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.map((g) =>
      g.instanceId === gearInstanceId ? { ...g, attachedToInstanceId: unitInstanceId, attachedThisTurn: true as const } : g,
    ),
  };
  // Jax - Unrelenting and Aphelios - Exalted. HELD here rather than at the five
  // call sites, for the reason this module's own comment gives about being the
  // single writer of `attachedToInstanceId`: a sixth attach source gets the
  // trigger for free, and cannot skip it.
  //
  // After the write, so a listener reads a board where the gear is already worn
  // — the ordering every other hold in this engine takes.
  const attached = holdEventTrigger({ ...state, players }, {
    kind: "equipmentAttached",
    ownerIndex,
    gearInstanceId,
    unitInstanceId,
  });

  // **An [Equip] can make a unit [Mighty], and until 2026-08-08 nothing saw it.**
  //
  // Reported from playtesting against Fiora - Grand Duelist and Fiora - Worthy,
  // both of which read "when a unit becomes [Mighty]". The badge is part of the
  // wearer's CURRENT Might — `effectiveMight` adds `equipmentMightBonusFor` at
  // the gate — so 709's "its Might changes from being less than 5 to being 5 or
  // greater" is satisfied by the attach itself. Blade of the Ruined King is +4
  // and B.F. Sword +3; this is not a corner case, it is the set's main way of
  // getting there.
  //
  // Bracketed here rather than at the call sites for exactly the reason the hold
  // above is: this is the single writer, so the five attach sources get it by
  // construction. The OLD wearer needs no check — a move can only LOWER its
  // Might, and `withMightTransitions` fires on an upward crossing only.
  //
  // Placed after `equipmentAttached`, so under the chain's LIFO resolution (340.1)
  // the Mighty trigger is answered first. Both events come from one game action
  // and 383 would have their controller order them; this engine does not offer
  // that choice, and neither ordering is more correct than the other.
  return withMightTransitions(state, attached, [unitInstanceId]);
}

/**
 * The Equipment `playerIndex` controls that could be attached to `unitInstanceId`
 * right now — Jax - Grandmaster At Arms's two modes, which differ only in this
 * list.
 *
 * ONE walk, exported so the enumerator and the validator ask it in the same
 * words. Two copies of this filter is precisely how an action gets offered and
 * then refused, which is this repo's most-repeated bug.
 *
 * `which` is the printed distinction: "attach a DETACHED Equipment" against
 * "attach an ATTACHED Equipment". The second excludes the unit the Equipment is
 * ALREADY on — re-attaching it where it sits is a no-op the player would have
 * paid an exhaust for, the same reason the move fan-out refuses a unit's current
 * battlefield as a destination.
 *
 * Only the player's OWN gear, because both modes read "an Equipment you control
 * to a unit you control" — and `attachEquipment` is a no-op on anyone else's
 * anyway, which would be a cost paid for nothing.
 */
export function attachableEquipment(
  state: GameState,
  playerIndex: 0 | 1,
  which: "detached" | "attached" | "any",
  unitInstanceId: string,
): GearInstance[] {
  return state.players[playerIndex].activeGear.filter((g) => {
    if (!isEquipmentGear(g)) return false;
    // `"any"` is Forge of the Fluft's grant, which draws no detached/attached
    // line at all — it is the UNION of Jax's two modes, not a third kind. The
    // only exclusion left is the no-op: an Equipment already on this very unit.
    if (which === "any") return g.attachedToInstanceId !== unitInstanceId;
    if (which === "detached") return g.attachedToInstanceId == null;
    return g.attachedToInstanceId != null && g.attachedToInstanceId !== unitInstanceId;
  });
}

/**
 * The Equipment that can pair with `unitInstanceId` under Angle Shot's "an
 * Equipment **with the same controller**".
 *
 * The one walk the enumerator and the validator both ask, the split
 * `attachableEquipment` above keeps for the ability path and for the same
 * reason: two sites deciding "is this pair legal" separately is how an offered
 * play comes to be refused.
 *
 * **The controller is the UNIT's, not the caster's** — that is the whole content
 * of "the same controller", and it is why this takes a unit id rather than a
 * player index. A unit that has somehow left the board pairs with nothing.
 */
export function equipmentPairedWith(
  state: GameState,
  unitInstanceId: string,
  relation: "attachable" | "attachedToIt",
): GearInstance[] {
  const found = findUnitAnywhere(state, unitInstanceId);
  if (!found) return [];
  if (relation === "attachedToIt") {
    return state.players[found.ownerIndex].activeGear.filter(
      (g) => isEquipmentGear(g) && g.attachedToInstanceId === unitInstanceId,
    );
  }
  // "Attach that Equipment to that unit" reaches a detached one AND one worn by
  // somebody else, since `attachEquipment` moves it — which is exactly
  // `attachableEquipment`'s `"any"`, whose only exclusion is the no-op.
  return attachableEquipment(state, found.ownerIndex, "any", unitInstanceId);
}

/**
 * Experimental Hexplate's art-only "**I am a Mech**".
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * **"I" is the WEARER, not the gear**, which is the reading the eight
 * wearer's-moments Equipment already establish for the pronoun on an Equipment —
 * and here it is also the only reading that does anything at all. Every Mech
 * check in this engine asks about a UNIT (Rumble Scrapper's Might aura, the
 * Mech-token discount, "another exhausted Mech", "your Mechs"), so a piece of
 * gear that was itself a Mech would satisfy none of them and the card would be
 * blank.
 *
 * **The note this replaces said `tags` is "printed-only", and that was wrong.**
 * `card.ts` copies a definition's tags onto every `UnitInstance` at creation, and
 * the Mech TOKEN already relies on that — it has no registry entry at all, so its
 * instance tags are its only record. So a granted tag needed no new storage; what
 * it needed was for the readers to ask one function.
 */
const EXPERIMENTAL_HEXPLATE = "SFD-073";
const MECH_TAG = "Mech";

/**
 * This unit's tags, printed AND granted — the one question every tribal check
 * should ask about a unit IN PLAY.
 *
 * Continuous rather than a stored mutation, exactly like
 * `equipmentMightBonusFor`: detaching the Hexplate takes the tag away in the same
 * instant, and nothing has to remember to undo a write.
 *
 * Only meaningful for a unit on the board. A unit in a TRASH or a deck wears
 * nothing, so those readers (Rumble Scrapper's "a Mech from your trash") keep
 * asking `tags` directly and are deliberately untouched.
 */
export function effectiveTagsOf(state: GameState, unit: UnitInstance): readonly string[] {
  const wearsHexplate = equipmentAttachedTo(state, unit.instanceId).some((g) => g.defId === EXPERIMENTAL_HEXPLATE);
  if (!wearsHexplate || unit.tags.includes(MECH_TAG)) return unit.tags;
  return [...unit.tags, MECH_TAG];
}

/** Is this unit a Mech right now — printed, tokened, or granted by a Hexplate? */
export function isMechUnit(state: GameState, unit: UnitInstance): boolean {
  return effectiveTagsOf(state, unit).includes(MECH_TAG);
}

/**
 * Drops Brutalizer's freshness flag.
 *
 * The key is REMOVED rather than set to `undefined`: `attachedThisTurn` is
 * declared `?: true`, and under `exactOptionalPropertyTypes` an explicit
 * `undefined` is a different type from an absent key. Exported so `runEnd`'s
 * end-of-turn sweep clears it exactly the way a detach does — two spellings of
 * "not fresh" is how one of them comes to be wrong.
 */
/**
 * Records that `unitInstanceId` was banished WITH `gearInstanceId` — The Zero
 * Drive's list, and the only writer of `GearInstance.banishedInstanceIds`.
 *
 * Here rather than in triggers.ts for the reason this module is the single
 * writer of `attachedToInstanceId`: a gear field with two writers is a gear field
 * that drifts.
 *
 * Searches `activeGear` AND `banished`, because a Drive can be in either by the
 * time a death it was watching resolves — the ordinary case is in play, and its
 * own ability banishes it.
 *
 * A gear id that names nothing is a silent no-op, the same target-vanished
 * convention every other helper here follows.
 */
export function recordBanishedWithGear(
  state: GameState,
  ownerIndex: 0 | 1,
  gearInstanceId: string,
  unitInstanceId: string,
): GameState {
  const withRecord = (gear: GearInstance): GearInstance =>
    gear.instanceId === gearInstanceId
      ? { ...gear, banishedInstanceIds: [...(gear.banishedInstanceIds ?? []), unitInstanceId] }
      : gear;
  const owner = state.players[ownerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.map(withRecord),
    banished: owner.banished.map((c) => (c.kind === "Gear" ? withRecord(c) : c)),
  };
  return { ...state, players };
}

/**
 * Takes control of an enemy gear for as long as `whileInPlayInstanceId` is on the
 * board — Akshan - Mischievous' "move an enemy gear to your base. You control it
 * until I leave the board."
 *
 * Control of a gear is `activeGear` membership, so this is a move between the two
 * lists plus the record that says how to undo it. Detached on the way across:
 * whatever it was worn by belongs to the other player, and an Equipment cannot be
 * attached to a unit its controller does not own (`attachEquipment`'s own rule),
 * so leaving the link would be a state nothing else here can produce.
 *
 * A no-op when the gear is not the other player's — "an ENEMY gear", and taking
 * your own is the no-op the targeting already refuses.
 */
export function borrowGear(
  state: GameState,
  takerIndex: 0 | 1,
  gearInstanceId: string,
  whileInPlayInstanceId: string,
): GameState {
  const fromIndex: 0 | 1 = takerIndex === 0 ? 1 : 0;
  const gear = state.players[fromIndex].activeGear.find((g) => g.instanceId === gearInstanceId);
  if (!gear) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[fromIndex] = {
    ...players[fromIndex],
    activeGear: players[fromIndex].activeGear.filter((g) => g.instanceId !== gearInstanceId),
  };
  players[takerIndex] = {
    ...players[takerIndex],
    activeGear: [
      ...players[takerIndex].activeGear,
      // `attachedThisTurn` is dropped with the attachment it described; a gear
      // that arrives unworn is not freshly attached to anything.
      { ...withoutAttachFreshness(gear), attachedToInstanceId: null, borrowedControl: { fromIndex, whileInPlayInstanceId } },
    ],
  };
  return { ...state, players };
}

/**
 * Hands back every borrowed gear whose lender has left the board — the second
 * half of Akshan - Mischievous, run by `runCleanup`.
 *
 * In the Cleanup rather than at a death, and that is the point: "until I LEAVE
 * THE BOARD" is not "until I die". Being recalled to hand, banished, or returned
 * to a deck all end the loan too, and a death-watch would catch only the first.
 * The Cleanup is the one hook that runs after every resolved action in both
 * `submit` and the AI's lookahead — the reason `finalizePendingTriggers` lives
 * there.
 *
 * Detached on the way back for the same reason `borrowGear` detaches on the way
 * out: it is crossing between two players' lists, and an Equipment worn by a unit
 * its controller does not own is a state nothing else can produce.
 */
export function returnLapsedGearControl(state: GameState): GameState {
  const onBoard = new Set(
    state.players.flatMap((p, index) => [
      ...p.baseUnits.map((u) => u.instanceId),
      ...state.battlefields.flatMap((bf) => (bf.units[state.players[index as 0 | 1].id] ?? []).map((u) => u.instanceId)),
    ]),
  );
  const lapsed = state.players.flatMap((p) =>
    p.activeGear.filter((g) => g.borrowedControl !== undefined && !onBoard.has(g.borrowedControl.whileInPlayInstanceId)),
  );
  if (lapsed.length === 0) return state;

  const players = state.players.map((p) => ({
    ...p,
    activeGear: p.activeGear.filter((g) => !lapsed.some((l) => l.instanceId === g.instanceId)),
  })) as [PlayerState, PlayerState];
  for (const gear of lapsed) {
    const { borrowedControl, ...rest } = gear;
    players[borrowedControl!.fromIndex] = {
      ...players[borrowedControl!.fromIndex],
      activeGear: [...players[borrowedControl!.fromIndex].activeGear, { ...rest, attachedToInstanceId: null }],
    };
  }
  return { ...state, players };
}

/**
 * Svellsongur — "As this is attached to a unit, copy that unit's text to this
 * Equipment's effect text for as long as this is attached to it."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * # What copying the text actually DOES
 *
 * An Equipment's effect text is read as its WEARER's — that is what the eight
 * wearer's-moments cards establish for "when I conquer" printed on a gear. So
 * copying the wearer's text onto the Equipment gives that unit its own abilities
 * a SECOND time: a Svellsongur on Ahri - Alluring means she scores her hold point
 * twice. Doubling is the whole of the card.
 *
 * # What is copied, and what is deliberately not
 *
 * A faithful copy has to reach every defId-keyed table — measured at 23 of them
 * over 256 units. Three groups:
 *
 *  - **FREE, but for a narrower reason than this used to claim.** An ON-PLAY
 *    trigger cannot re-fire, because the attach happens after the play. A doubled
 *    KEYWORD was written off as "redundant under 817.1.a", which is a citation to
 *    Vision's "It is present on Permanents" and says nothing of the kind — and
 *    for the four SUMMED keywords (807.2/809.2/814.2/823.2) it is the wrong
 *    answer: a copied `[Assault 2]` is a second source and is worth another 2.
 *    That half is now a DIVERGENCE, not free. The unvalued keywords genuinely are
 *    free, each by its own redundancy rule (805.4, 810.2, 811.4, 815.2, 816.2,
 *    822.2, 826.5). The gear copies its wearer's TEXT and this engine has no
 *    phantom keyword source to hang the copy on — the same missing concept the
 *    Might-aura and cost-modifier rows below record.
 *  - **DONE.** Event triggers (77 cards), their decision continuations (50),
 *    `[Deathknell]`s (13) and activated abilities (10).
 *  - **NOT DONE, and recorded as a divergence** in docs/rules-conformance.md:
 *    continuous Might auras (13 cards) and cost modifiers (11). Each walks its
 *    own list of UNITS and a gear is in none of them, so doubling them needs a
 *    phantom-source concept this engine has never had.
 */
const SVELLSONGUR = "SFD-059";

/**
 * The unit whose text `gear` is copying, or undefined — Svellsongur's wearer.
 *
 * Returns the WEARER rather than a boolean because every reader needs the unit:
 * the trigger walk needs its defId AND a listener standing where it stands, and
 * the ability registry needs its defId.
 */
export function copiedTextSourceFor(
  state: GameState,
  /** Structural for the reason `wearerOf` below is: `abilitiesAvailableTo` asks
   *  this about a source it knows only as a defId and an attachment link. */
  gear: { defId: string; attachedToInstanceId?: string | null },
): { unit: UnitInstance; ownerIndex: 0 | 1; battlefieldId?: string } | undefined {
  return gear.defId === SVELLSONGUR ? wearerOf(state, gear) : undefined;
}

/**
 * How many Svellsongurs are among `worn` — the multiplier that unit's own
 * abilities are worth.
 *
 * A count rather than a flag because two of them are two copies of the text, and
 * no rule makes a copied ABILITY redundant — the per-keyword redundancy rules
 * (805.4, 810.2, 811.4, 815.2, 816.2, 822.2, 826.5) are each about their own
 * keyword and reach no further. Two Deathknells fire twice; 808.2 says so
 * outright.
 *
 * **Takes the WORN LIST rather than a unit id**, which is what its one caller
 * needs: a `[Deathknell]` is held after `killUnit` has already detached
 * everything, so asking the board would always find nothing. `DeathContext`
 * carries `wornEquipment` for exactly this — the same field Sacred Shears reads,
 * and for the same reason.
 */
export function textCopiesAmong(worn: readonly GearInstance[] | undefined): number {
  return (worn ?? []).filter((g) => g.defId === SVELLSONGUR).length;
}

/**
 * Skyfall of Areion — "My hold effects are also conquer effects, and vice
 * versa."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * **"MY" is the WEARER's**, the reading the eight wearer's-moments Equipment
 * already establish for a pronoun on an Equipment — and here it is again the only
 * reading that does anything, because the gear has no hold or conquer effects of
 * its own to mirror.
 */
const SKYFALL_OF_AREION = "SFD-030";

/** Does this unit wear a Skyfall of Areion? Its own predicate rather than the
 *  `some` written out in triggers.ts, so the card's id lives beside the rest of
 *  the Equipment table it belongs to. */
export function wearsMomentMirror(state: GameState, unitInstanceId: string): boolean {
  return equipmentAttachedTo(state, unitInstanceId).some((g) => g.defId === SKYFALL_OF_AREION);
}

/** The units recorded against `gear`, in the order they were banished. Its own
 *  accessor so the ability that reads the list and the trigger that writes it
 *  quote one field name. */
export function unitsBanishedWith(gear: { banishedInstanceIds?: readonly string[] }): readonly string[] {
  return gear.banishedInstanceIds ?? [];
}

export function withoutAttachFreshness(gear: GearInstance): GearInstance {
  if (gear.attachedThisTurn === undefined) return gear;
  const { attachedThisTurn: _spent, ...rest } = gear;
  return rest;
}

/** Detaches one Equipment, leaving it in `activeGear` unattached. */
export function detachEquipment(state: GameState, ownerIndex: 0 | 1, gearInstanceId: string): GameState {
  const owner = state.players[ownerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.map((g) =>
      // Freshness goes with the attachment it described — a detached Brutalizer
      // re-attached next turn must be fresh again, not stale.
      g.instanceId === gearInstanceId ? withoutAttachFreshness({ ...g, attachedToInstanceId: null }) : g,
    ),
  };
  return { ...state, players };
}

/**
 * Detaches every Equipment attached to `unitInstanceId`, from BOTH players.
 *
 * Both, deliberately: nothing in the rules says an Equipment and the unit it is
 * attached to share a controller, and `takeControlOfUnit` already moves units
 * between lists. Scanning one side would leave a dangling
 * `attachedToInstanceId` pointing at a unit that no longer exists — which reads
 * as a Might bonus from a gear attached to nothing.
 *
 * **435.4.b is the rule**: "If the Attached card was Detached because the
 * Top-Most Card changed zones from a board zone to a non-board zone, then the
 * location that the Attached Card will Detach to is the last location the
 * Top-Most Card was at". The gear SURVIVES on the board — see the module
 * comment's two cards that presuppose exactly that.
 *
 * **This comment used to say "called from every path a unit leaves play by", and
 * that was false for three of the four.** Only `killUnit` called it; a bounce, a
 * Recycle to deck and a banish all left the gear pointing at a card sitting in a
 * hand or a deck. Reported from playtesting as "if equipped unit gets bounced to
 * hand the equipment detaches from the unit" — it did not, and the dangling
 * pointer is what the player was seeing.
 *
 * A stale claim about this codebase's own mechanism, which CLAUDE.md rates ten
 * times out of eleven. Now genuinely called from all four, and each caller cites
 * the rule so the next zone-change site has something to grep for.
 */
export function detachAllFrom(state: GameState, unitInstanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  let changed = false;
  for (const index of [0, 1] as const) {
    const player = players[index];
    if (!player.activeGear.some((g) => g.attachedToInstanceId === unitInstanceId)) continue;
    changed = true;
    players[index] = {
      ...player,
      activeGear: player.activeGear.map((g) =>
        g.attachedToInstanceId === unitInstanceId ? { ...g, attachedToInstanceId: null } : g,
      ),
    };
  }
  return changed ? { ...state, players } : state;
}

/** Every Equipment attached to this unit, from either side. */
export function equipmentAttachedTo(state: GameState, unitInstanceId: string): GearInstance[] {
  return state.players.flatMap((p) => p.activeGear.filter((g) => g.attachedToInstanceId === unitInstanceId));
}

/**
 * Gearhead — "Each Equipment attached to me gives **double its base** Might
 * bonus."
 *
 * A property of the WEARER, not of the gear, which is why it is applied here
 * rather than in `equipMightBonusOf`: the same Long Sword is +2 on Gearhead and
 * +1 the instant it is moved to the unit beside him.
 *
 * **"Its BASE Might bonus" is the printed badge and nothing else.** The badge is
 * the art-only `equipMightBonus` table, so doubling it doubles exactly what the
 * card says and leaves every other term alone — a `mightThisTurn` buff on the
 * wearer, a Buff counter, an aura are all added by `effectiveMight` AFTER this
 * returns and are not doubled. "Base" is the word that makes that the reading
 * rather than a convenience.
 */
const GEARHEAD = "SFD-068";

/** The total "+N Might" an attached Equipment grants this unit. Read at the
 *  gate by `effective-might`, so it is continuous rather than a stored buff —
 *  detaching the gear removes the Might in the same instant. */
export function equipmentMightBonusFor(state: GameState, unitInstanceId: string): number {
  // The wearer's own defId decides the multiplier, so it is looked up once
  // rather than per attached gear. A unit that is not on the board (nothing
  // wears anything) falls through to 1 and the reduce below finds no gear.
  const wearer = findUnitAnywhere(state, unitInstanceId)?.unit;
  const multiplier = wearer?.defId === GEARHEAD ? 2 : 1;
  return equipmentAttachedTo(state, unitInstanceId).reduce(
    (sum, g) => sum + (equipMightBonusOf(g) + brutalizerBonus(g)) * multiplier,
    0,
  );
}

/**
 * Brutalizer's art-only "**If this was attached to me THIS TURN**, I have an
 * additional +2 Might".
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * Inside the same reduce as the printed badge rather than beside it, so
 * Gearhead's "your Equipment give double Might" doubles this too. That is the
 * reading the multiplier's placement already commits to for every other bonus,
 * and splitting it out would silently exempt one card from an aura that says
 * "your Equipment".
 *
 * The freshness is a FLAG on the gear, not a turn number: `turnNumber` counts
 * ROUNDS by construction (`runEnd` bumps it only when play wraps to the first
 * player), so both players' turns share one, and a gear attached on my turn
 * would still read as fresh on the opponent's. The flag is written by
 * `attachEquipment` — the single writer of `attachedToInstanceId`, so no attach
 * source can skip it — and cleared for BOTH players by `runEnd`, the convention
 * every other "this turn" field here follows.
 */
const BRUTALIZER = "SFD-042";
const BRUTALIZER_FRESH_MIGHT = 2;

function brutalizerBonus(gear: GearInstance): number {
  return gear.defId === BRUTALIZER && gear.attachedThisTurn === true ? BRUTALIZER_FRESH_MIGHT : 0;
}

/**
 * `[Quick-Draw]` — "This has [Reaction]. When you play it, attach it to a unit
 * you control."
 *
 * Keyword-driven, so ONE implementation covers every card that prints it and
 * every card that GRANTS it — Jax - Unmatched gives "your Equipment everywhere"
 * the keyword, and nothing about this asks which Gear it started on.
 *
 * The `[Reaction]` half needs nothing: the keyword's reminder text literally
 * contains the substring "[Reaction]", and `card-loader` already sets
 * `isReaction` from exactly that. Measured, not assumed — all four printed
 * Quick-Draw Gear come out of the loader with `isReaction: true` already.
 *
 * The attach is a QUESTION rather than automatic, because "a unit you control"
 * is a choice and a board with several units has no canonical first. With no
 * friendly unit at all the decision is dropped whole rather than offered as a
 * lone Decline, matching Monastery of Hirana and Treasure Hoard.
 */
export const QUICK_DRAW_DECISION = "quick-draw-attach";

export const equipmentDecisions: Record<string, DecisionDefinition> = {
  [QUICK_DRAW_DECISION]: {
    prompt: (state, d) => {
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId);
      return `${gear?.name ?? "Equipment"}: attach it to which unit?`;
    },
    options: (state, d) => {
      const owner = state.players[d.playerIndex];
      const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
      // Nothing to attach to is not a question. `[Quick-Draw]` prints no "you
      // may", so with a unit available there is deliberately NO decline option:
      // the attach is mandatory and only the target is chosen.
      return units.map((u) => ({ id: u.instanceId, label: `Attach to ${u.name}`, instanceId: u.instanceId }));
    },
    resolve: (state, d, optionId) =>
      d.cardInstanceId === undefined ? state : attachEquipment(state, d.playerIndex, d.cardInstanceId, optionId),
  },
};

/**
 * Parks `[Quick-Draw]`'s attach for a Gear that has just been played, if it has
 * the keyword and there is anything to attach it to.
 *
 * Called from `execute-play-card`'s Gear branch — the one place a Gear enters
 * `activeGear` — so a Gear arriving by any other route does not silently skip
 * it, and neither does a future caller.
 */
export function holdQuickDrawAttach(state: GameState, playerIndex: 0 | 1, gear: GearInstance): GameState {
  if (!hasQuickDraw(state, playerIndex, gear)) return state;
  const owner = state.players[playerIndex];
  const anyUnit =
    owner.baseUnits.length > 0 || state.battlefields.some((bf) => (bf.units[owner.id] ?? []).length > 0);
  if (!anyUnit) return state;
  return parkDecision(state, { kind: QUICK_DRAW_DECISION, playerIndex, cardInstanceId: gear.instanceId });
}

/** Does this Gear have `[Quick-Draw]`, printed OR granted? Jax - Unmatched is
 *  the granting case ("Your Equipment everywhere have [Quick-Draw]"), and a
 *  keyword that only ever read the printed one would miss every card he arms. */
export function hasQuickDraw(state: GameState, ownerIndex: 0 | 1, gear: GearInstance): boolean {
  const def = defaultCardRegistry().tryGet(gear.defId);
  if (def?.type === "Gear" && def.keywords["Quick-Draw"] !== undefined) return true;
  return isEquipmentGear(gear) && grantsQuickDrawToEquipment(state, ownerIndex);
}

/** Jax - Unmatched (SFD-054): "Your Equipment everywhere have [Quick-Draw]."
 *  Positional-free — "everywhere" is the card's own word — and asked of the
 *  gear's controller, since it is HIS Equipment the card arms. */
function grantsQuickDrawToEquipment(state: GameState, ownerIndex: 0 | 1): boolean {
  const owner = state.players[ownerIndex];
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  return units.some((u) => u.defId === JAX_UNMATCHED);
}

const JAX_UNMATCHED = "SFD-054";

/** For coverage.ts — the cards this module implements by name rather than by
 *  keyword. Jax's grant is his whole second clause, and Gearhead's doubling is
 *  his whole text besides the `[Accelerate]` the loader already handles. */
export function equipmentDefIds(): string[] {
  return [JAX_UNMATCHED, GEARHEAD];
}

/**
 * `[Weaponmaster]` — "When you play me, you may [Equip] one of your Equipment to
 * me for :rb_rune_rainbow: less, even if it's already attached."
 *
 * Keyword-driven like `[Quick-Draw]`, so one implementation covers all eleven
 * cards that print it.
 *
 * **"For 1 rainbow LESS" is a discount on the Equipment's own `[Equip]` cost**,
 * not a cost of its own. Since 25 of the 31 print an `[Equip]` cost of exactly
 * one rune, the discount usually makes the attach FREE, which is the card's
 * whole point.
 *
 * **"Even if it's already attached"** is why the offer lists every Equipment its
 * controller has rather than only unattached ones: re-equipping is a relocation
 * and is explicitly legal.
 *
 * **The four rainbow-cost Equipment are no longer excluded.** They were, on the
 * reasoning that "a rainbow minus a rainbow is zero, but nothing here can
 * express the general case" — and the general case is expressible now: a rainbow
 * Power cost is `domain: null`, which `payPowerFromChanneled` has always read as
 * "any domain". So a hypothetical 2-rainbow `[Equip]` discounts to 1 rainbow and
 * is priced correctly rather than dropped.
 */
export const WEAPONMASTER_DECISION = "weaponmaster-equip";

/** The `[Equip]` cost after `[Weaponmaster]`'s one-rune discount, or undefined
 *  for an Equipment this engine cannot price. */
export function weaponmasterCostFor(defId: string): { energy: number; domain: Domain | null; count: number } | undefined {
  const def = defaultCardRegistry().tryGet(defId);
  if (def?.type !== "Gear" || def.equipCost === undefined) return undefined;
  const { energy, domain, count } = def.equipCost;
  // `null` is RAINBOW — see this function's doc comment, and
  // `payPowerFromChanneled`, which `canPayWeaponmaster` hands it straight to.
  return { energy, domain: domain === "rainbow" ? null : domain, count: Math.max(0, count - 1) };
}

/** Can this player pay the discounted cost right now? Asked of the same helpers
 *  that will take the payment, so the offer and the payment cannot disagree —
 *  the shape behind three recorded offered-then-refused bugs here. */
function canPayWeaponmaster(state: GameState, playerIndex: 0 | 1, defId: string): boolean {
  const cost = weaponmasterCostFor(defId);
  if (cost === undefined) return false;
  let next: GameState | undefined = state;
  if (cost.count > 0) next = payPowerFromChanneled(next, playerIndex, cost.domain, cost.count);
  if (next !== undefined && cost.energy > 0) next = payEnergyFromPool(next, playerIndex, cost.energy);
  return next !== undefined;
}

export const weaponmasterDecisions: Record<string, DecisionDefinition> = {
  [WEAPONMASTER_DECISION]: {
    prompt: () => "Weaponmaster: attach one of your Equipment to me for 1 less?",
    options: (state, d) => {
      const affordable = state.players[d.playerIndex].activeGear.filter(
        (g) => isEquipmentGear(g) && canPayWeaponmaster(state, d.playerIndex, g.defId),
      );
      // Nothing to offer is not a question. With something to offer the DECLINE
      // is real — the card prints "you MAY" — unlike [Quick-Draw]'s mandatory
      // attach one function up.
      if (affordable.length === 0) return [];
      return [
        ...affordable.map((g) => ({ id: g.instanceId, label: `Equip ${g.name}`, instanceId: g.instanceId })),
        { id: "decline", label: "Decline" },
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.cardInstanceId === undefined) return state;
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      if (!gear) return state;
      const cost = weaponmasterCostFor(gear.defId);
      if (cost === undefined) return state;
      // Pay FIRST, and bail if it cannot be paid — the response window this
      // question opened is exactly when that Power could be spent elsewhere.
      let paid: GameState | undefined = state;
      if (cost.count > 0) paid = payPowerFromChanneled(paid, d.playerIndex, cost.domain, cost.count);
      if (paid !== undefined && cost.energy > 0) paid = payEnergyFromPool(paid, d.playerIndex, cost.energy);
      if (paid === undefined) return state;
      return attachEquipment(paid, d.playerIndex, gear.instanceId, d.cardInstanceId);
    },
  },
};

/**
 * Parks `[Weaponmaster]`'s offer for a Unit that has just been played.
 *
 * Called from `execute-play-card`'s Unit branch — the one place a played Unit
 * enters play — for the same reason `holdQuickDrawAttach` is called from the
 * Gear branch.
 */
export function holdWeaponmasterOffer(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): GameState {
  const def = defaultCardRegistry().tryGet(unit.defId);
  if (def?.type !== "Unit" || def.keywords.Weaponmaster === undefined) return state;
  const anyAffordable = state.players[playerIndex].activeGear.some(
    (g) => isEquipmentGear(g) && canPayWeaponmaster(state, playerIndex, g.defId),
  );
  if (!anyAffordable) return state;
  return parkDecision(state, { kind: WEAPONMASTER_DECISION, playerIndex, cardInstanceId: unit.instanceId });
}

/**
 * Keywords an attached Equipment grants to the unit wearing it.
 *
 * **Transcribed from the card ART, like the Might badges, because it is not in
 * the JSON either.** The `text.plain` of every card below is nothing but its
 * `[Equip]` line — the granted keyword sits in the box the printed card devotes
 * to what the WEARER gains, and no field of the export carries it.
 *
 * Read off contact sheets built from `media.image_url` (all 31 Equipment, text
 * boxes cropped and stacked), which also re-verified every one of the 31 Might
 * badges in `card-loader`'s EQUIP_MIGHT_BONUS against the art independently of
 * the oracle they were ported from. All 31 matched.
 *
 * These five are the shared-mechanism subset. The other art-only abilities are
 * per-card work and are listed in `docs/sfd-equipment-abilities.md` rather than
 * left to be rediscovered by re-reading the images.
 */
/** Lucian - Purifier (SFD-183) — "Your Equipment each give [Assault]." */
const LUCIAN_PURIFIER = "SFD-183";
const LUCIAN_ASSAULT = 1;

const EQUIP_GRANTED_KEYWORDS: Record<string, Partial<Record<Keyword, number>>> = {
  "SFD-009": { Assault: 2 }, // Serrated Dirk — "[Assault 2]"
  "SFD-033": { Tank: 1 }, // Doran's Shield — "[Tank]"
  "SFD-064": { Shield: 2 }, // Cloth Armor — "[Shield 2]"
  "SFD-102": { Deflect: 1 }, // Hexdrinker — "[Deflect]"
  "SFD-133": { Ganking: 1 }, // Boots of Swiftness — "[Ganking]"
  // **UNL-096 Hunter's Machete — "[HUNT] (When I conquer or hold, gain 1 XP.)",
  // and it is on the ART, not in the card's text.** Read off the image
  // 2026-08-08.
  //
  // It is the first Equipment in the pool to grant a keyword that is a TRIGGER
  // rather than a combat modifier, and it falsified a claim made in
  // `triggerKeysOn` two days earlier: "nothing grants [Hunt], measured over all
  // four sets" — true of the card TEXT and false of the cards. The measurement
  // was of the wrong thing, which is the standing lesson about this data.
  "UNL-096": { Hunt: 1 },
};

/**
 * The keywords this unit gains from the Equipment attached to it.
 *
 * Folded into `effectiveKeywords` rather than stored, so it comes and goes with
 * the attachment exactly as the Might badge does — detaching Doran's Shield
 * takes `[Tank]` with it in the same instant.
 *
 * Two Equipment are two SOURCES, so `mergeGrantedKeyword` decides what that
 * means per keyword: two Cloth Armors are `[Shield 4]` (814.2 sums granted Shield
 * Values) and two Doran's Shields are still `[Tank]` (815.2 makes Tank redundant).
 * This used to take the higher of the two for everything, on a citation of
 * 817.1.a that says no such thing — see keyword-stacking.ts.
 */
export function equipmentKeywordsFor(state: GameState, unitInstanceId: string): Partial<Record<Keyword, number>> {
  const out: Partial<Record<Keyword, number>> = {};
  const worn = equipmentAttachedTo(state, unitInstanceId);
  for (const gear of worn) {
    for (const [keyword, value] of Object.entries(EQUIP_GRANTED_KEYWORDS[gear.defId] ?? {})) {
      mergeGrantedKeyword(out, keyword as Keyword, value);
    }
  }
  // Lucian - Purifier — "YOUR Equipment each give [Assault]."
  //
  // A modifier on what every Equipment grants rather than a keyword of his own,
  // so it belongs HERE, folded in beside the per-card table, and not in
  // `KEYWORD_AURAS`: an aura would grant [Assault] to units wearing nothing.
  // Being equipped is the condition.
  //
  // "YOUR Equipment" is the WEARER's controller — the gear and the unit it is
  // attached to always share one, since `attachEquipment` only ever attaches to
  // "a unit you control".
  //
  // **"EACH give", once per worn Equipment, and every one of them SUMS** — 807.2:
  // "the Assault Value of all granted Assault keywords is summed". So Serrated
  // Dirk's own [Assault 2] under Lucian is [Assault 3], and a unit wearing the
  // Dirk and a Boots of Swiftness is [Assault 4] (2 from the Dirk, 1 from Lucian
  // for each of the two).
  //
  // This site used to read `worn.length > 0` and `Math.max`, and its comment
  // asserted the opposite answer — "still [Assault 2], not 3" — citing 817.1.a,
  // which is Vision's "It is present on Permanents" and says nothing about
  // redundancy. The two errors were independent and each hid the other: with a
  // max merge, per-gear and per-wearer are indistinguishable.
  if (worn.length > 0) {
    const wearer = findUnitAnywhere(state, unitInstanceId);
    if (wearer && state.players[wearer.ownerIndex]?.legend.defId === LUCIAN_PURIFIER) {
      for (const _gear of worn) mergeGrantedKeyword(out, "Assault", LUCIAN_ASSAULT);
    }
  }
  return out;
}

/**
 * For coverage.ts — the cards whose granted keyword is their whole ability, and
 * which are therefore implemented HERE.
 *
 * **Lucian - Purifier is in this list although he is a LEGEND, not an Equipment.**
 * Coverage is per-defId and asks which module claims a card; his "your Equipment
 * each give [Assault]" is a modifier on what every Equipment grants, so it lives
 * in `equipmentKeywordsFor` above and nothing else can claim him. Without this
 * line he works in play and reports INERT — the exact split coverage.ts exists to
 * close, and the reason `effectiveMightDefIds` exists for Master Yi.
 */
export function equipmentKeywordDefIds(): string[] {
  return [...Object.keys(EQUIP_GRANTED_KEYWORDS), LUCIAN_PURIFIER];
}

/**
 * The unit an attached Equipment is worn by, with where it is standing.
 *
 * `attachedToInstanceId` points one way only — gear -> unit — so this is the
 * reverse of `equipmentAttachedTo` and is the lookup every "when I ..." ability
 * printed on a piece of Equipment needs.
 */
export function wearerOf(
  state: GameState,
  /** Structural rather than a `GearInstance`, because the only field read is the
   *  attachment link and one caller (`abilitiesAvailableTo`) is handed a bare
   *  `{ defId, attachedToInstanceId }` source rather than the instance. */
  gear: { attachedToInstanceId?: string | null },
): { unit: UnitInstance; ownerIndex: 0 | 1; battlefieldId?: string } | undefined {
  const wornBy = gear.attachedToInstanceId;
  if (!wornBy) return undefined;
  for (const ownerIndex of [0, 1] as const) {
    const player = state.players[ownerIndex];
    const inBase = player.baseUnits.find((u) => u.instanceId === wornBy);
    if (inBase) return { unit: inBase, ownerIndex };
    for (const bf of state.battlefields) {
      const atBattlefield = (bf.units[player.id] ?? []).find((u) => u.instanceId === wornBy);
      if (atBattlefield) return { unit: atBattlefield, ownerIndex, battlefieldId: bf.id };
    }
  }
  return undefined;
}

/**
 * An attached Equipment's listener, rewritten as its WEARER's.
 *
 * **This is the whole wearer's-moments mechanism**, and it is one function
 * because of what `listeningPermanents` already does: every piece of active Gear
 * is ALREADY walked as a listener. What it lacks is a location — gear sits in a
 * flat `activeGear` list with no battlefield — so a "when I conquer" written
 * against `listener.battlefieldId` could never match.
 *
 * Rather than teach the walk about attachment (which would change what a Gear
 * listener means for Mask of Foresight and every future one), this hands a card
 * the listener its wearer WOULD have had: same owner, the wearer's card, the
 * wearer's battlefield. Every existing predicate then works unchanged —
 * `isFightingAt`'s `listener.card.kind === "Unit"` check passes because the card
 * really is the unit, and `listener.battlefieldId === event.battlefieldId` means
 * what it says.
 *
 * `undefined` for anything that is not an ATTACHED Equipment, which is the
 * card's own "I am not being worn, so nothing of mine happens" — an unattached
 * Recurve Bow sitting in base watches no combats.
 */
export function wearerListener(state: GameState, listener: Listener): Listener | undefined {
  if (listener.card.kind !== "Gear") return undefined;
  const worn = wearerOf(state, listener.card as GearInstance);
  if (!worn) return undefined;
  return {
    card: worn.unit,
    ownerIndex: worn.ownerIndex,
    zone: "board",
    ...(worn.battlefieldId !== undefined ? { battlefieldId: worn.battlefieldId } : {}),
  };
}
