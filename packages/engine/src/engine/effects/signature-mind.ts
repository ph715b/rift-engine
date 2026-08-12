import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import type { UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import {
  banishCard,
  borrowUnitInPlace,
  dealDamage,
  discardCards,
  forceMoveToBattlefield,
  giveMightThisTurn,
  readyUnit,
  removeUnitAnywhere,
} from "../effect-helpers.js";
import { parkDecision } from "../decisions.js";
import { placeToken, type TokenDestination, type TokenSpec } from "../token.js";
import { playUnitFree } from "../free-play.js";
import { isHiddenCard } from "../hidden.js";
import { findUnitAnywhere } from "../target-lookup.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Mind**.
 *
 * So a `Mind+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Mind lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

/** Moonfall's "-2 [Might] this turn", as a POSITIVE number; the sign is applied
 *  at the call site so the ABSENT floor reads plainly beside Siphon Power's
 *  printed one two entries down. */
const MOONFALL_SHRINK = 2;

/** Moonfall's "you may move up to one enemy unit to that battlefield" — written
 *  once because the resolver that raises it and the entry that answers it must
 *  agree. A typo in either is SILENT: `definitionFor` throws only for a kind
 *  nothing registers, and a resolver naming the wrong kind would throw at the
 *  wrong moment rather than never firing, but the DEFINITION keyed to a kind
 *  nobody parks simply never runs and reads exactly like a card that was never
 *  cast. */
const MOONFALL_MOVE = "UNL-198-move";

/** LeBlanc - Deceiver's "you may discard 1 and exhaust me to…", for the same
 *  reason. */
const LEBLANC_COPY = "UNL-199-copy";

/**
 * The Reflection token both LeBlanc - Deceiver and Mirror Image play.
 *
 * **A FOURTH copy of this stat line in the engine, and knowingly so.**
 * `effects/mind.ts` carries a private `KEEPER_REFLECTION_TOKEN` for Keeper of
 * Masks; it is not exported and that file is another agent's. `SAND_SOLDIER_TOKEN`
 * and `BIRD_TOKEN` both record what happens next — three byte-identical private
 * copies, consolidated later by an integrator — so this is flagged rather than
 * pretended away: the shared home is `token.ts`, and merging the two is one line
 * once one owner holds both files.
 *
 * `might: 0` is **187.6** ("A 0 [M] Reflection token is a domainless unit token
 * with 0 Might") surviving the copy, because **477.1.b.1.a**'s list of copyable
 * traits — Name, Super Type, Type, Tags, Cost, Domain, Rules Text — does not
 * include Might, and the sibling layer gives Might its own dedicated clause
 * (**477.1.a.1**) rather than folding it into the copy. So a Reflection copying a
 * 7-Might body is a 7-Might body's TEXT on an 0-Might frame.
 *
 * `entersReady` because both cards print "a READY Reflection unit token",
 * overriding 143.4.a on their own authority (184.1).
 */
const REFLECTION_TOKEN: TokenSpec = { name: "Reflection", might: 0, tag: "Reflection", entersReady: true };

/** Every unit instance id on the board, either player's, base included. Used
 *  only to identify what `placeToken` just created — see `playReflectionCopy`. */
function unitIdsOnBoard(state: GameState): string[] {
  return [
    ...state.players.flatMap((p) => p.baseUnits.map((u) => u.instanceId)),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId))),
  ];
}

/**
 * Rewrites one unit wherever it stands.
 *
 * A local copy of `effect-helpers.updateUnitAnywhere`, which is module-PRIVATE
 * there. Duplicating it is the smaller evil than the alternative available to a
 * file that may not edit `effect-helpers.ts`: hand-rolling the copy INSIDE each
 * of the two card entries, which would be two copies rather than one.
 */
function rewriteUnitAnywhere(state: GameState, instanceId: string, change: (unit: UnitInstance) => UnitInstance): GameState {
  const players = state.players.map((p) => ({
    ...p,
    baseUnits: p.baseUnits.map((u) => (u.instanceId === instanceId ? change(u) : u)),
  })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => ({
    ...bf,
    units: Object.fromEntries(
      Object.entries(bf.units).map(([ownerId, units]) => [
        ownerId,
        units.map((u) => (u.instanceId === instanceId ? change(u) : u)),
      ]),
    ),
  }));
  return { ...state, players, battlefields };
}

/**
 * Plays a ready Reflection token at `destination` and makes it a copy of
 * `source`, with `[Temporary]` — the whole of LeBlanc - Deceiver's and Mirror
 * Image's shared body.
 *
 * # Why this is not a `TokenSpec`
 *
 * `effects/mind.ts` records, correctly, that a `TokenSpec` covers a copy whose
 * subject is known when the card is WRITTEN (Keeper of Masks copies herself) and
 * not one chosen at resolution. It carries name, Might, one tag and keywords, and
 * `createToken` hardcodes the other five copyable traits — `defId`, `domains`,
 * `tags`, the costs and `isChampion`. Of those, **`defId` is the one that
 * matters**: every rules-text table in this engine is keyed by it (event
 * triggers, unit triggers, Deathknells, activated abilities, Might modifiers,
 * granted keywords), so a token that keeps `TOKEN-REFLECTION` copies a NAME and
 * nothing a player would pay 3 Energy for.
 *
 * So the copy is applied as a LAYER on top of the placed token rather than baked
 * into its spec: `placeToken` does the playing (185.2.a — a token entering is a
 * play — plus 190.3.a's Contested and Renata Glasc's replacement), and the seven
 * copyable traits are then written over the body it left behind. Might is
 * deliberately not among them, and neither are damage, buffs, stun or exhaustion,
 * none of which 477.1.b.1.a lists.
 *
 * That order is also the printed one — "play a ready Reflection unit token there.
 * It BECOMES a copy" — and it is what keeps the copy's own on-play text from
 * firing: `placeToken` holds its `cardPlayed` against the board as it stands at
 * that instant (`holdEventTrigger` walks listeners at hold time), which is before
 * this function has given the token any text. Keeper of Masks reaches the same
 * answer structurally; here it is a consequence of sequencing, so it is asserted
 * rather than assumed.
 *
 * # The token is found by DIFFERENCE, not by position
 *
 * `placeToken` returns a state, not an id. Reading "the last unit at the
 * destination" would work today and would break silently the day anything else
 * lands in the same instruction; diffing the board's unit ids assumes only that
 * one token was created, which is what this call is.
 *
 * # Recorded limitation: a SNAPSHOT, not a re-derived layer
 *
 * 477.1.b.1.b makes copyable traits "the printed traits… updated to the new
 * traits it has received", and works the copy-of-a-copy case by name (a Mirror
 * Image aimed at a LeBlanc Reflection of Honest Broker yields a third Honest
 * Broker). That case is right here by construction, because the source's traits
 * are read off the INSTANCE and a Reflection's instance already carries its
 * copied ones. What is NOT modelled is re-derivation: if something later changed
 * the ORIGINAL's copyable traits, this engine has no layer pass to push that
 * through to the copy. No card in this pool can do it — see
 * docs/rules-conformance.md.
 *
 * # An absent source still plays the token
 *
 * `source` is optional because **359.3.e.5/e.6** are explicit: an illegal target
 * makes the instructions RELATED to it unfollowable and leaves the rest alone, and
 * the worked example (Void Seeker) still draws its card. "Play a ready Reflection
 * unit token" names no target, so it happens; "It becomes a copy of that unit"
 * does, so it does not. The `[Temporary]` still lands — a 0-Might blank that dies
 * next Beginning Phase, which is the honest outcome rather than a fizzle.
 */
function playReflectionCopy(
  state: GameState,
  casterIndex: 0 | 1,
  destination: TokenDestination,
  source: UnitInstance | undefined,
): GameState {
  const before = new Set(unitIdsOnBoard(state));
  const placed = placeToken(state, casterIndex, destination, REFLECTION_TOKEN);
  const tokenId = unitIdsOnBoard(placed).find((id) => !before.has(id));
  // `placeToken` no-ops on a battlefield id that names nothing — the usual
  // "target vanished" convention — and then there is no token to make a copy of.
  if (tokenId === undefined) return placed;

  // No source: only the grant lands. See the note above on 359.3.e.5.
  if (source === undefined) {
    return rewriteUnitAnywhere(placed, tokenId, (token) => ({ ...token, keywords: { ...token.keywords, Temporary: 1 } }));
  }

  return rewriteUnitAnywhere(placed, tokenId, (token) => ({
    ...token,
    // Rules Text. The defId IS the rules text in this engine, so this one
    // assignment is what carries the triggers, the abilities and the auras.
    defId: source.defId,
    name: source.name,
    // Super Type. `isChampion` is the only supertype a UnitInstance carries.
    isChampion: source.isChampion,
    tags: source.tags,
    domains: source.domains,
    energyCost: source.energyCost,
    powerCost: source.powerCost,
    powerDomain: source.powerDomain,
    ...(source.powerDomainAlt !== undefined ? { powerDomainAlt: source.powerDomainAlt } : {}),
    // Printed `[Reaction]` is part of the copied text. Inert on a body already in
    // play — it is a permission to PLAY the card — and copied for faithfulness
    // rather than for any reachable effect.
    isReaction: source.isReaction,
    // The copied keywords are the copied Rules Text, plus the `[Temporary]` both
    // cards then GRANT. Granted second so a source already printing it (Keeper of
    // Masks, say) is a no-op rather than a conflict — 816.2 makes a second
    // instance redundant.
    keywords: { ...source.keywords, Temporary: 1 },
  }));
}

export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-264": {
    // Guerilla Warfare (Mind + Chaos) — "Return up to two cards with [Hidden]
    // from your trash to your hand. You can hide cards ignoring costs this turn."
    //
    // The second sentence is a this-turn WAIVER, not a charge: it says "cards",
    // plural, so it is not spent by the first Hide. Read through
    // `hidden.hideCostFor`, which the enumerator, the validator and the executor
    // all price through — three sites that must agree about what a Hide costs.
    //
    // "UP TO two" is 0-2, so the spell is castable with an empty trash and does
    // only its second half. The return is taken from the front of the matching
    // cards rather than offered as a choice: every `[Hidden]` card in the trash is
    // interchangeable for the purpose ("return up to two", no restriction on
    // which), and this engine's convention is to ask only where the choice is
    // real. Recorded Unverified — a player might prefer a specific one.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const actor = state.players[ctx.casterIndex];
      // `isHiddenCard` takes a DEFINITION (the keyword is printed, not per
      // instance), so the trash card is resolved through the registry first.
      const returning = actor.trash.filter((c) => isHiddenCard(defaultCardRegistry().get(c.defId))).slice(0, 2);
      const ids = new Set(returning.map((c) => c.instanceId));
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...actor,
        trash: actor.trash.filter((c) => !ids.has(c.instanceId)),
        hand: [...actor.hand, ...returning],
        hideIgnoresCostThisTurn: true,
      };
      return { ...state, players };
    },
  },
  "OGN-266": {
    // Siphon Power (Mind + Order) — "Choose a battlefield. Give friendly units
    // there +1 Might this turn and enemy units there -1 Might this turn, to a
    // minimum of 1 Might."
    //
    // "THERE" on both halves, so this is strictly positional — nothing in base
    // moves. The floor is printed on the debuff half only, and applied per unit
    // by giveMightThisTurn.
    //
    // Both halves resolve off the SAME battlefield snapshot taken before either
    // is applied. Nothing here kills, so the lists cannot shrink, but reading
    // them once is what keeps that true if a modifier ever does.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const bf = state.battlefields.find((b) => b.id === event.targetBattlefieldId);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const friendly = (bf.units[casterId] ?? []).map((u) => u.instanceId);
      const enemy = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const pumped = friendly.reduce((next, id) => giveMightThisTurn(next, id, 1), state);
      return enemy.reduce((next, id) => giveMightThisTurn(next, id, -1, 1), pumped);
    },
  },
  "SFD-200": {
    // Arcane Shift (Mind + Chaos) — "[Action] Banish a friendly unit, then its
    // owner plays it, ignoring its cost. Deal 3 to an enemy unit at a battlefield.
    // Banish this."
    //
    // Last Breath's slot shape, and for the same printed reason: the enemy is "at a
    // battlefield" and the friendly is not, so the two halves are scoped
    // differently. `min: 2` because neither half says "up to" — 355.8 again.
    //
    // **A BLINK, and it differs from Portal Rescue's by one printed word.** Portal
    // Rescue reads "plays it TO THEIR BASE" and so calls `playUnitToBase`; this one
    // says only "plays it", which is the ordinary permission — so it goes through
    // `playUnitFree`, which offers the destinations a paid play would have offered.
    // Reading the two the same way would silently delete the card's best line
    // (blinking a unit onto a battlefield you already hold).
    //
    // The banish is TRANSIENT — banished and replayed in one instruction, nothing
    // can observe the middle zone — so the unit goes straight to play rather than
    // through `PlayerState.banished`. "BANISH THIS" is the other kind: the spell
    // genuinely stays there, which is why `banishCard` is called for it and not for
    // the unit. Time Warp is the only other real writer of that zone.
    //
    // A fresh copy, exactly as Portal Rescue rebuilds one: 705 strips the Buff on
    // leaving play, and damage / this-turn Might / stun are properties of the body
    // that left.
    //
    // **Known ordering wrinkle, inherited rather than introduced:** when the blinked
    // unit has more than one legal destination, `playUnitFree` PARKS the question,
    // so the damage below lands before the unit actually arrives. The card's printed
    // order is play-then-damage. Nothing in this pool can observe the difference
    // (the damage target is an enemy, chosen at announce time), but it is a real
    // deferral and not a claim that the order is preserved.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      const found = friendlyId ? findUnitAnywhere(state, friendlyId) : undefined;
      let next = state;
      if (friendlyId && found) {
        const returning: UnitInstance = {
          ...found.unit,
          damage: 0,
          mightThisTurn: 0,
          buffed: false,
          stunned: false,
          movesThisTurn: 0,
        };
        // "ITS OWNER plays it", not the caster — `found.ownerIndex`, the same
        // reading Portal Rescue takes. Friendly-only targeting makes the two the
        // same player today; naming it is what keeps that an observation.
        next = playUnitFree(removeUnitAnywhere(state, friendlyId), found.ownerIndex, returning);
      }

      const enemyId = event.secondTargetUnitInstanceId;
      if (enemyId) next = dealDamage(next, ctx.casterIndex, enemyId, 3);
      // "Banish this" — the spell is already in the caster's trash by now (the
      // ordinary cast path trashes at announce), and `banishCard` looks there.
      return ctx.sourceCardInstanceId ? banishCard(next, ctx.casterIndex, ctx.sourceCardInstanceId) : next;
    },
  },
  "SFD-202": {
    // Hostile Takeover (Mind + Order) — "[Hidden] Take control of an enemy unit
    // at a battlefield. Ready it. (Start a combat if other enemies are there.
    // Otherwise, conquer.) Lose control of that unit and recall it at end of
    // turn. (Send it to base. This isn't a move.)"
    //
    // # What was actually missing
    //
    // `takeControlOfUnit` existed and is the wrong half of the card: it recalls to
    // the taker's BASE, which is what makes Possession's permanent theft safe, and
    // this card's whole parenthetical is about the unit staying where it stands.
    // `borrowUnitInPlace` is that half — it leaves the unit at the battlefield and
    // applies Contested for its new controller (190.3.a's "or otherwise becomes
    // present"), which is what "start a combat if other enemies are there,
    // otherwise conquer" describes. Both outcomes fall out of Contested rather
    // than being branched on here: the Cleanup opens a Combat Showdown when both
    // players have units present and a Non-Combat one when they do not, and 348.2.a
    // is what turns the second into a conquest.
    //
    // The REVERSAL genuinely did not exist, exactly as the handoff said. In this
    // engine control IS which player's list a unit sits in — the row
    // docs/rules-conformance.md carries — so a stolen unit is indistinguishable
    // from an owned one and nothing could ever give it back. One optional field on
    // the unit (`returnControlAtEndOfTurnToIndex`) is the whole of the memory that
    // model lacked, and `runEnd` discharges it.
    //
    // # The ready, and the order
    //
    // "Ready it" AFTER the theft, printed order, and it matters: `readyUnit` is
    // gated by `mayReadyPermanent`, which refuses to ready an ENEMY unit under
    // Mageseeker Warden. By the time this runs the unit is ours, so the Warden
    // does not bite — which is right, since it is our unit being readied.
    //
    // A ready is also what makes the borrowed body worth having: it arrives on our
    // side able to fight, where a unit that had already attacked this turn would
    // otherwise stand exhausted.
    //
    // `scope` left at its default, so "an enemy unit AT A BATTLEFIELD" is enforced
    // by the targeting and a unit sheltering in the opponent's base is out of
    // reach — the same reading Possession takes of the same phrase.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const borrowed = borrowUnitInPlace(state, event.targetUnitInstanceId, ctx.casterIndex);
      return readyUnit(borrowed, event.targetUnitInstanceId);
    },
  },
  "UNL-198": {
    // Moonfall (Mind + Chaos) — "[Action] Choose a battlefield where you have
    // units. You may move up to one enemy unit to that battlefield. Then give
    // enemy units there -2 [Might] this turn."
    //
    // `[Action]` is the loader's, off the printed text; nothing here.
    //
    // # The battlefield restriction is NOT enforced at announce — DIVERGENCE
    //
    // `TargetingSpec`'s `battlefield` kind carries no filter and `legal-actions`
    // enumerates every battlefield for it; adding one means a field on that union
    // plus the enumerator plus the validator, three files this one does not own.
    // The restriction is therefore applied HERE, as a whole-card no-op when the
    // caster has no units at the battlefield they named.
    //
    // That is the "offered then refused" shape this codebase warns about, and it
    // is taken deliberately in one direction only: the effect is never WIDER than
    // printed, only the castability is. Choosing an empty battlefield wastes the
    // spell, where the alternative — enforcing nothing — would let it shrink
    // enemies at a battlefield the caster has never reached. Recorded in
    // docs/rules-conformance.md.
    //
    // 355.8's other half is unenforceable for the same reason: printed Moonfall
    // is UNCASTABLE with no units at any battlefield, and here it is castable and
    // inert.
    //
    // # The move is asked at RESOLUTION
    //
    // "You may move UP TO ONE enemy unit" is optional, and an optional target on a
    // Spell has no home on the action — `optionalChoice` exists but its own note
    // scopes it to a UNIT's on-play trigger, "a Spell's targeting IS its effect".
    // So it is a parked question, which is exactly the shape Blitzcrank -
    // Impassive's "you may move an enemy unit to here" already takes, down to the
    // `battlefieldId` the seed carries. The cost is that an opponent cannot
    // respond to WHICH unit was named; recorded with the row above.
    //
    // The debuff lives in that question's resolver rather than here, because
    // "THEN" is printed and load-bearing: a unit dragged in is standing there when
    // the -2 lands. Parking unconditionally — even with nothing to move — is what
    // keeps that one path; `advanceDecisions` executes a lone "Decline" without
    // showing anyone a question.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const battlefieldId = event.targetBattlefieldId;
      if (battlefieldId === undefined) return state;
      const bf = state.battlefields.find((b) => b.id === battlefieldId);
      if (!bf) return state;
      // "WHERE YOU HAVE UNITS" — see the divergence above.
      if ((bf.units[state.players[ctx.casterIndex].id] ?? []).length === 0) return state;
      return parkDecision(state, { kind: MOONFALL_MOVE, playerIndex: ctx.casterIndex, battlefieldId });
    },
  },
  "UNL-200": {
    // Mirror Image (Mind + Order) — "Choose a unit. Play a ready Reflection unit
    // token to your base. It becomes a copy of that unit. Give it [Temporary].
    // (Kill it at the start of its controller's Beginning Phase, before scoring.)"
    //
    // **"A unit", not "a unit at a battlefield"** — 355.9.a.1's bare noun is
    // objects on the Board, so `scope: "anywhere"` and no `owner`: copying an
    // opponent's body is the card's whole point, and a unit sheltering in either
    // base is a legal choice. Written out rather than defaulted, because the
    // default is the other answer.
    //
    // "TO YOUR BASE" is printed, so there is no destination to choose — unlike
    // LeBlanc's "there".
    //
    // The `[Temporary]` reminder text is `killTemporaryPermanents`', which reads
    // printed `keywords` on the instance; `playReflectionCopy` writes it there.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      // The chosen unit may have died in the response window. The token is still
      // played and still gets `[Temporary]`; only the copy is skipped — 359.3.e.5,
      // whose Void Seeker example still draws its card. `playReflectionCopy`
      // carries the reasoning.
      const source = findUnitAnywhere(state, event.targetUnitInstanceId);
      return playReflectionCopy(state, ctx.casterIndex, "base", source?.unit);
    },
  },
};

/** Still empty, and deliberately declared: `effects/index.ts` reads every
 *  registry off every module, so a missing export is `undefined` at merge time
 *  rather than an empty table. Declaring them keeps adding a card here to one
 *  line.
 */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "UNL-199": {
    // LeBlanc - Deceiver (Mind + Order) — "When you conquer or hold, you may
    // discard 1 and exhaust me to play a ready Reflection unit token there. It
    // becomes a copy of another unit there. Give it [Temporary]."
    //
    // # A LEGEND registered as an ordinary event trigger
    //
    // `listeningPermanents` ends with `owner.legend` (zone `"legend"`), so a
    // Legend is reachable by this registry exactly like a unit or a gear —
    // `legendEventTriggers()` exists to ADAPT `legend-abilities.ts`'s hook shape
    // onto the same walk, not to be the only door to it. Registering here rather
    // than there is what lets a dual-domain Legend live in the signature file
    // that owns its domain pair; `mergeRegistries` still throws if the other file
    // ever claims the same defId.
    //
    // # "When you conquer or hold" is the PLAYER's moment, not a unit's
    //
    // So `applies` compares the event's index to the listener's owner and asks
    // nothing about location — unlike `[Hunt]`, whose "I" makes
    // `listener.battlefieldId` the whole condition. A Legend has no battlefield
    // at all (its zone note says so), and a check against it would refuse every
    // conquest.
    //
    // "THERE" is therefore taken from the EVENT, which carries `battlefieldId`
    // on both kinds. Nothing is captured: `capture` is for facts the event cannot
    // carry, and this one does.
    //
    // # The cost is checked when the question is ANSWERED, not when it fires
    //
    // "You may discard 1 and exhaust me TO" is a cost paid on resolution (205),
    // so `applies` deliberately does NOT ask whether the hand is empty or whether
    // LeBlanc is already exhausted. Irelia - Blade Dancer draws the same line for
    // the same reason, one clause each way. A cost that has become unpayable in
    // the response window leaves the decision with only "Decline", which
    // `advanceDecisions` executes without showing anyone a question.
    //
    // No `listener.zone === "legend"` guard, and its absence was measured rather
    // than assumed: adding one changes no test, because this registry is keyed by
    // defId and only a Legend can carry a Legend's. A check that cannot fail is
    // worse than no check — `huntMomentIsMine` records the same deletion after the
    // same mutation run.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered"
        ? event.conquerorIndex === listener.ownerIndex
        : event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      const battlefieldId =
        event.kind === "battlefieldConquered" || event.kind === "battlefieldHeld" ? event.battlefieldId : undefined;
      if (battlefieldId === undefined) return state;
      return parkDecision(state, { kind: LEBLANC_COPY, playerIndex: listener.ownerIndex, battlefieldId });
    },
  },
};

export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

export const decisions: Record<string, DecisionDefinition> = {
  // Moonfall's "you may move up to one enemy unit to that battlefield", raised by
  // its resolver, which has already established that the caster has units there.
  //
  // **"AN ENEMY UNIT" carries no location word**, so 355.9.a.1's bare-noun reading
  // applies and a unit sitting in the opponent's base is a legal drag — the same
  // reading Blitzcrank - Impassive's near-identical question takes.
  //
  // A unit ALREADY at that battlefield is filtered out rather than offered and
  // no-oped: 355.4.a makes a valid move destination "one other than the Unit's
  // current Location", so moving it there is not a move at all.
  // `forceMoveToBattlefield` would return the state unchanged, which is the right
  // outcome by the wrong route — an option that does nothing is an option a player
  // has to reason about.
  //
  // Declining is listed FIRST, so a mis-click and the AI's tie-break both land on
  // the smaller effect. That default is the right way round here: dragging an
  // enemy in contests the caster's own battlefield.
  //
  // **The -2 is in BOTH branches and it is the reason this handler exists.**
  // "THEN give enemy units there -2" runs after the move, so the unit just dragged
  // in is shrunk too; putting the debuff in the spell's resolver would have shrunk
  // the board as it stood before the drag.
  [MOONFALL_MOVE]: {
    prompt: () => "Moonfall: move an enemy unit to that battlefield?",
    options: (state, d) => {
      const enemyIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      const enemyId = state.players[enemyIndex].id;
      const alreadyThere = new Set(
        (state.battlefields.find((bf) => bf.id === d.battlefieldId)?.units[enemyId] ?? []).map((u) => u.instanceId),
      );
      const elsewhere = [
        ...state.players[enemyIndex].baseUnits,
        ...state.battlefields.flatMap((bf) => bf.units[enemyId] ?? []),
      ].filter((u) => !alreadyThere.has(u.instanceId));
      return [
        { id: "decline", label: "Move nothing" },
        ...elsewhere.map((u) => ({ id: u.instanceId, label: `Move ${u.name} there`, instanceId: u.instanceId })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (d.battlefieldId === undefined) return state;
      // `causedByIndex` is the caster: this is their spell dragging the unit, and
      // the field is what a "when an enemy moves my unit" listener reads.
      const moved =
        optionId === "decline" ? state : forceMoveToBattlefield(state, optionId, d.battlefieldId, d.playerIndex);
      const enemyId = moved.players[d.playerIndex === 0 ? 1 : 0].id;
      const shrinking = (moved.battlefields.find((bf) => bf.id === d.battlefieldId)?.units[enemyId] ?? []).map(
        (u) => u.instanceId,
      );
      // No floor: Moonfall prints none, unlike Siphon Power's "to a minimum of 1
      // Might" two entries up. 143.2.b treats a negative total as 0 wherever it is
      // referenced, so the absent floor is a real difference and not a rounding.
      return shrinking.reduce((next, id) => giveMightThisTurn(next, id, -MOONFALL_SHRINK), moved);
    },
  },

  // LeBlanc - Deceiver's "you may discard 1 and exhaust me to play a ready
  // Reflection unit token there", raised by her conquer/hold trigger.
  //
  // **Both halves of the cost are checked here**, because both can lapse in the
  // response window her trigger opens: an emptied hand or an exhausted LeBlanc
  // leaves only "Decline". Re-checked inside `resolve` as well as in `options`,
  // the way `SFD-203-gold` does — `answerDecision` validates the option against
  // the live options list, so the second check is unreachable today and is the
  // cheap half of not depending on that.
  //
  // **"ANOTHER unit there"** is any unit at that battlefield, either player's —
  // no owner word is printed. In practice they are the caster's own: you conquer
  // by being the only one present, and you hold what nobody is contesting.
  // "Another" excludes the token itself, which is true by construction — it does
  // not exist until the copy subject has been named.
  //
  // With no unit there at all, only "Decline" is offered and the token is not
  // played. That is a narrowing of 359.3.e.5's "the unrelated instruction still
  // happens", and it is unreachable rather than decided: a conquest or a hold
  // requires a unit of the conqueror's standing there.
  [LEBLANC_COPY]: {
    prompt: () => "LeBlanc - Deceiver: discard 1 and exhaust her for a Reflection copy?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted || owner.hand.length === 0) return options;
      const here = state.battlefields.find((bf) => bf.id === d.battlefieldId);
      if (!here) return options;
      for (const units of Object.values(here.units)) {
        for (const unit of units) {
          options.push({ id: unit.instanceId, label: `Copy ${unit.name}`, instanceId: unit.instanceId });
        }
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.battlefieldId === undefined) return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted || owner.hand.length === 0) return state; // cost no longer payable
      const source = findUnitAnywhere(state, optionId);
      if (!source) return state;

      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      // WHICH card is discarded is the player's choice, so `discardCards` parks its
      // own question rather than taking the front of hand. That question queues
      // BEHIND this one and is therefore answered after the token has landed —
      // the discard is a cost and should precede the effect, but nothing here can
      // observe the order: the token's copy subject is on the board, not in hand.
      const paid = discardCards({ ...state, players }, d.playerIndex, 1);
      return playReflectionCopy(paid, d.playerIndex, { battlefieldId: d.battlefieldId }, source.unit);
    },
  },
};

/** Diana - Scorn of the Moon's ":rb_energy_1:". */
const DIANA_SHOWDOWN_ENERGY = 1;

export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-197": {
    // Diana - Scorn of the Moon (Mind + Chaos) — "[Reaction] -> [Exhaust]: [Add]
    // [1 Energy]. Spend this Energy only during showdowns. (Abilities that add
    // resources can't be reacted to.)"
    //
    // Darius - Hand of Noxus' ability with one printed sentence added, and that
    // sentence is the whole of what this engine cannot say.
    //
    // # DIVERGENCE: the Energy is not restricted once the Showdown closes
    //
    // A restricted pool is a field on `PlayerState` plus a drain in
    // `rune-payment.computeEffectiveCost` plus its threading through
    // `legal-actions` (6 sites), `validate-play-card` and `execute-play-card` and
    // a reset in `turn-manager.runEnd` — the eight-file shape
    // `restrictedSpellEnergy`, `restrictedSpellPower` and `restrictedGearPower`
    // each have. `model/game-state.ts` even names the Java oracle's field for
    // THIS card (`dianaScornOfTheMoonEnergy`) in its list of "add each when the
    // card that needs it is implemented". None of those files is this one's.
    //
    // So the Energy lands in `floatingEnergy`, and `availableWhile` narrows the
    // other end instead: the ability may only be activated while a Showdown is
    // open. That is deliberately the SMALLER of the two available errors.
    // Without it the card is strictly Darius — 1 unrestricted Energy at any
    // moment — where with it the Energy is only ever CREATED in the window it is
    // meant to be spent in, and the leak is bounded to the remainder of that turn
    // (`runEnd` clears `floatingEnergy` like every other pool).
    //
    // The narrowing costs the player nothing reachable: the ability is
    // `[Reaction]`-speed and `activateAbilityCandidates` is enumerated in every
    // timing branch, so the Showdown is always a moment at which it can still be
    // used. Recorded in docs/rules-conformance.md.
    //
    // `turnState === "Showdown"` covers BOTH kinds — 341 makes a Showdown a
    // window, and only some Showdowns are part of a Combat — which is what the
    // printed word means.
    //
    // `[Reaction]` itself needs nothing, and the parenthetical even less:
    // `validate-activate-ability` applies no turnState, chain or priority check to
    // any activation, and an ability that adds a resource never reaches the chain
    // in this engine at all.
    //
    // `banksResource`, like Darius and Lux - Crownguard: `evaluate` scores board
    // state, so an ability that only stores Energy would tie with Pass.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    availableWhile: (state) => state.turnState === "Showdown",
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + DIANA_SHOWDOWN_ENERGY };
      return { ...state, players };
    },
  },
};

export const mightModifiers: Record<string, MightModifier> = {};
