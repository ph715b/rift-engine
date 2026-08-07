import type { GameState, PlayerState } from "../model/game-state.js";
import type { GearInstance, LegendInstance, UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import { GOLD_TOKEN_DEF_ID, SAND_SOLDIER_TOKEN, placeToken } from "./token.js";
import { goldAddsExtraEnergy } from "./board-restrictions.js";
/** Ornn - Fire Below the Mountain adds one rainbow Power per activation. */
/** Ezreal - Prodigal Explorer's "TWICE this turn" — the whole of his condition,
 *  named so the test and the check quote one number. */
const EZREAL_CHOICES_NEEDED = 2;

const ORNN_GEAR_POWER = 1;
/** Renata Glasc - Chem-Baroness's "an additional [1]" on each Gold. */
const RENATA_GOLD_BONUS_ENERGY = 1;
import { contextFor, type EffectContext } from "./effect-context.js";
import {
  addBuff,
  dealDamage,
  drawCards,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  legionActive,
  payPowerFromChanneled,
  readyUnit,
  recallUnitToBase,
  recycleFromTrash,
  returnPermanentToHand,
  spendBuff,
  stunUnits,
} from "./effect-helpers.js";
import { placeRecruitToken } from "./token.js";
import { destroyUnit } from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
import { parkDecision } from "./decisions.js";
import { offerTopOfDeckBanish } from "./top-of-deck.js";
import { killGear } from "./triggers.js";
import { computeAutoPayment, energyAfterFloat } from "./rune-payment.js";
import type { RunePayment } from "../actions/player-action.js";
import { type TargetingSpec } from "./card-effects.js";
import { attachEquipment, attachableEquipment } from "./equipment.js";
import { defaultCardRegistry } from "../cards/card-registry.js";

/**
 * Abilities you activate by exhausting the permanent that has them — the
 * ":rb_exhaust::" cost printed on a third of this card pool.
 *
 * This replaces a single hardcoded case. validate-activate-ability.ts carried
 * `ACTIVATABLE_UNIT_DEF_IDS = new Set(["OGS-014"])` and execute-activate-ability
 * carried Lux - Crownguard's effect inline, with a comment saying to widen it
 * "the day a second activated-ability card is implemented". This is that day, and
 * the widening is a registry rather than a second branch because of the shape of
 * what's left: 20 of the 30 Gear in this pool are exactly "exhaust: do one thing",
 * and none of them could be reached at all before — the action only ever looked at
 * units.
 */

/** Where an activated ability lives. Gear and Units take the same action and pay
 *  the same exhaust cost; they differ only in which zone the permanent sits in,
 *  which is why one registry can serve both. */
export type ActivatableKind = "Unit" | "Gear" | "Legend";

export interface ActivatedAbilityEvent {
  /** Chosen ahead of the action, same constraint as every other effect in this
   *  engine — it cannot pause mid-resolution to ask. */
  targetUnitInstanceId?: string;
  /** Where the target is moved to, for a mode that declares `movesTarget` —
   *  Yasuo - Unforgiven's "from its base". */
  destinationBattlefieldId?: string;
  /** The unit OR gear OR facedown card a `unitOrGear`-kind spec named (Pack of
   *  Wonders). Separate from `targetUnitInstanceId` because a gear is not a unit
   *  and a facedown card is neither. */
  targetPermanentInstanceId?: string;
}

/**
 * What activating costs. Every ability in this pool so far exhausts its source,
 * but that is not universal — Vi - Destructive reads "Recycle 1 from your trash:"
 * with no exhaust symbol at all, so it is repeatable while the trash lasts.
 * Assuming the exhaust would have quietly made her once per turn.
 */
export interface ActivationCost {
  /** Exhaust the source. Absent means the ability does NOT exhaust. */
  exhaust?: true;
  /** Recycle this many cards from the controller's own trash (rule 416). */
  recycleFromTrash?: number;
  /**
   * Energy, paid from channeled runes and floating Energy exactly as a card's
   * Energy cost is — both preset Legend abilities read ":rb_energy_1:,
   * :rb_exhaust::", so the exhaust is only half the price.
   *
   * Unlike the other two, this one cannot be paid from state alone: which runes
   * go is a choice, so it rides on the action as a `payment`, the same way
   * PlayCardAction's does. The Java oracle's own action shape agrees —
   * `ActivateUnit(unit, target, RunePayment payment, String viaAbility)`.
   */
  energy?: number;
  /** Spend a Buff on the source (rule 704.1) — Udyr's whole cost. Like Vi's
   *  Recycle, this is a cost with no exhaust, so the ability repeats as long as
   *  buffs keep arriving. */
  spendBuff?: true;
  /**
   * Kill the source to pay — Forge of the Future's "Kill this:".
   *
   * The only cost that destroys what it is paid with, so it is once and only
   * once by construction rather than by an exhaust. Routed through `killGear`
   * when it is paid, so the gear's own "when I am killed" self-trigger still
   * fires: being spent as a cost is still being killed.
   */
  killSelf?: true;
  /**
   * Power of a specific domain, recycled from the channeled pool (rule 416) —
   * Treasure Trove's "[Chaos], Exhaust: Kill this".
   *
   * Distinct from `energy` above, which exhausts runes and rides a chosen
   * `payment` on the action: a Power cost RECYCLES the rune to the bottom of the
   * deck instead, and which rune goes is not a meaningful choice when they all
   * match the same domain. So it is paid from state through
   * `payPowerFromChanneled`, the same helper Flame Chompers and Mistfall use,
   * and needs nothing on the action.
   */
  /**
   * Power of a specific domain, recycled from the channeled pool (rule 416).
   *
   * `null` is RAINBOW — any domain pays — which is what `payPowerFromChanneled`
   * has always meant by `null` and what Temporal Portal's pip prints. Widened
   * rather than given a second field, because every consumer here already hands
   * this straight to that function.
   */
  power?: { domain: Domain | null; count: number };
  /**
   * Kill a friendly permanent to pay — Malzahar - Fanatic's "Kill a friendly unit
   * or gear, Exhaust:".
   *
   * The FIRST activation cost that carries a CHOICE. Every other cost here is
   * paid from state (an exhaust, a Recycle, a Power) or from a payment the action
   * already carries, so nothing had to be picked. This one names a permanent, so
   * it rides on the action as `costPermanentInstanceId` and `legal-actions` fans
   * out one candidate per eligible target — the same shape a targeted ability
   * already takes, one field over.
   *
   * Distinct from `killSelf` above, which destroys the SOURCE and so needs no
   * choice at all.
   */
  killFriendlyPermanent?: true;
  /**
   * Discard cards from hand to pay — Unlicensed Armory's "Discard 1, Exhaust:".
   *
   * A count rather than a boolean, matching `recycleFromTrash` above. WHICH card
   * goes is a real choice and rides on the action as `costDiscardCardInstanceId`,
   * for the same reason the kill above does.
   */
  discard?: number;
}

/**
 * One option of a modal ability — Udyr's "Choose one you've not chosen this
 * turn", whose four modes target differently from each other (two want a unit at
 * a battlefield, two want nothing). That is why targeting lives per MODE and not
 * on the ability: enumeration has to know what each option needs before the
 * player has picked one.
 */
export interface AbilityMode {
  id: string;
  /** What the board's button says. */
  label: string;
  targeting: TargetingSpec;
  /**
   * This mode moves its target somewhere the player must also choose, so
   * enumeration fans out per battlefield as well as per target — Yasuo -
   * Unforgiven's "move a friendly unit ... from its base".
   *
   * A flag on the MODE rather than on the ability because Yasuo's other mode
   * (going home) has an implicit destination and must not be fanned out.
   */
  movesTarget?: true;
  /**
   * This mode ATTACHES an Equipment to the unit it targets, so enumeration fans
   * out per Equipment as well as per unit — Jax - Grandmaster At Arms.
   *
   * The value says WHICH Equipment are eligible, because Jax's two modes differ
   * on exactly that: `"detached"` is his priced mode ("attach a DETACHED
   * Equipment"), `"attached"` his free one ("attach an ATTACHED Equipment",
   * i.e. move one). A single boolean would collapse the pair into one ability
   * that costs the cheaper of the two prices for either job.
   *
   * The Equipment rides `targetPermanentInstanceId` and the unit
   * `targetUnitInstanceId` — a gear must never reach a reader expecting a unit,
   * the same separation `unitOrGear` and `{ kind: "gear" }` already keep.
   */
  attachesEquipment?: "detached" | "attached" | "any";
  /**
   * What THIS mode costs, when the modes of one ability are priced differently —
   * Jax again, whose detached-attach costs `[1]` and whose re-attach is free.
   *
   * Overrides the ability's own `cost` entirely rather than merging with it: a
   * mode that names a price names the whole price, so reading one is never a
   * question of which fields came from where.
   *
   * Threaded through `activationCostOf(defId, modeId)`, which is what every
   * pricing site goes through — `canPayActivationCost`, `payActivationCost`, the
   * enumerator's payment and the validator's re-derivation. A per-mode price that
   * reached only some of those would be the offered-then-refused split this
   * codebase keeps paying for, and it would be silent.
   */
  cost?: ActivationCost;
  resolve: (state: GameState, ctx: EffectContext, event: ActivatedAbilityEvent, sourceInstanceId: string) => GameState;
}

export interface ActivatedAbilityDefinition {
  kind: ActivatableKind;
  /**
   * The options, for a modal ability. Declare EITHER this or the
   * `targeting`/`resolve` pair below — never both.
   *
   * Everything downstream works in modes regardless: `modesOf` turns a plain
   * ability into a single unnamed one, so enumeration, validation and execution
   * have one code path rather than a modal branch each. That is the difference
   * between adding a mechanic and adding it three times.
   */
  modes?: readonly AbilityMode[];
  /** "you've not chosen this turn" — each mode usable once per turn, tracked on
   *  the SOURCE (`UnitInstance.abilityModesUsedThisTurn`) so two copies of the
   *  card do not share one allowance. */
  modesOncePerTurn?: true;
  /** Defaults to `{ exhaust: true }` when omitted — the common case. */
  cost?: ActivationCost;
  /**
   * True when the ability banks a resource for a later play rather than changing
   * the board — Lux - Crownguard's "+2 Energy, spells only" is the whole category
   * today.
   *
   * The heuristic AI needs this. It filters candidates it has no evaluative basis
   * for, and `evaluate` scores board state only, so an ability that merely stores
   * Energy would score a meaningless tie with Pass. That reasoning was originally
   * written as a blanket "skip every ActivateAbility", which was correct while the
   * only such ability banked a resource and became wrong the moment a gear ability
   * moved Might — a change `evaluate` can see perfectly well. Flagging the
   * resource-bankers keeps the original judgement and drops the overreach.
   */
  banksResource?: true;
  /** What the player must choose before submitting. Reuses card-effects.ts's
   *  TargetingSpec so legal-actions' existing fan-out and the web UI's existing
   *  target picker both apply unchanged. */
  targeting?: TargetingSpec;
  /** A NON-modal ability that attaches an Equipment — Forge of the Fluft's
   *  grant. Carried onto the synthetic sole mode by `modesOf`, so the axis is
   *  declared in one place whether or not the ability has modes. */
  attachesEquipment?: "detached" | "attached" | "any";
  /**
   * A restriction on ACTIVATING rather than on resolving — Caitlyn - Patrolling's
   * "use this ability only while I'm at a battlefield".
   *
   * Has to be here rather than as a guard inside `resolve`: a resolver that
   * refused would already have taken the exhaust, so the player would pay for
   * nothing. Asked by `canPayActivationCost`, which both the enumerator and the
   * validator go through, so the ability cannot be offered and then refused.
   */
  availableWhile?: (state: GameState, playerIndex: 0 | 1, sourceInstanceId: string) => boolean;
  /** `sourceInstanceId` is the permanent being activated — needed by any ability
   *  whose text says "me" rather than naming a target. Omitted for a modal
   *  ability, whose modes each carry their own. */
  resolve?: (state: GameState, ctx: EffectContext, event: ActivatedAbilityEvent, sourceInstanceId: string) => GameState;
}

/**
 * Lux - Crownguard: "Exhaust: Add 2 Energy. Use only to play spells."
 *
 * Moved here verbatim from execute-activate-ability.ts — the granted Energy still
 * lands in PlayerState.restrictedSpellEnergy, the separate pool that only Spell
 * costs may drain (rune-payment.ts's computeEffectiveCost). Behaviour is
 * unchanged; only where it lives moved.
 */
const LUX_CROWNGUARD = "OGS-014";

/** Orb of Regret: "Exhaust: Give a unit -1 Might this turn, to a minimum of 1
 *  Might." The first Gear in this engine that does anything at all. */
const ORB_OF_REGRET = "OGN-090";
/** Heart of Dark Ice's pump — its own constant beside the Orb's, so the two
 *  mirror-image numbers are read from one place each. */
const HEART_OF_DARK_ICE_MIGHT = 3;
const VIKTOR_HERALD = "OGN-265";
const LEE_SIN_BLIND_MONK = "OGN-257";
const UDYR_WILDMAN = "OGN-157";

/**
 * Baited Hook: "[1 Energy][Order], Exhaust: Kill a friendly unit. Look at the top
 * 5 cards of your Main Deck. You may banish a unit from among them that has Might
 * up to 1 more than the killed unit and play it, ignoring its cost. Then recycle
 * the rest."
 *
 * **The first ability in the pool to combine `energy` with `power`** — the case
 * `activationPayment` was rewritten for, and which this file's own comment named
 * as hypothetical until now.
 *
 * Its cost is payable off a SINGLE Ready Order rune, which looks wrong and is
 * right: a Basic Rune has two printed abilities (164.2), `[E]: Add [1]` and
 * `Recycle this: Add [C]`, so a Ready rune can be exhausted for the Energy and
 * then recycled for the Power. See the rune double-duty row in
 * docs/rules-conformance.md.
 */
const BAITED_HOOK = "OGN-242";

/** Vi - Destructive: "Recycle 1 from your trash: Give me +1 Might this turn."
 *  The first ability whose cost is NOT an exhaust. */
const VI_DESTRUCTIVE = "OGN-036";

/** The four OGN Legends whose whole printed text is an activated ability. */
const MISS_FORTUNE_BOUNTY_HUNTER = "OGN-267";

/** Forge of the Fluft — a BATTLEFIELD whose printed text is an ability its
 *  controller's Legend has. Keyed here by the battlefield's own defId, the way
 *  the Gold token's ability is keyed by the token's. */
const FORGE_OF_THE_FLUFT = "SFD-208";
const DARIUS_HAND_OF_NOXUS = "OGN-253";
const KAISA_DAUGHTER_OF_THE_VOID = "OGN-247";
const YASUO_UNFORGIVEN = "OGN-259";

/** Sun Disc: "Exhaust: [Legion] — The next unit you play this turn enters
 *  ready." The first Gear whose ability arms a charge rather than changing the
 *  board. */
const SUN_DISC = "OGN-021";

/** Forge of the Future: "Kill this: Recycle up to 4 cards from trashes." The
 *  first ability in the pool paid for with the source's own destruction. */
const FORGE_OF_THE_FUTURE = "OGN-212";

/**
 * The six Seals — one per domain, and the same sentence six times: "Exhaust:
 * Add 1 <domain> Power."
 *
 * Generated rather than written out six times, because they are one card with a
 * parameter and six hand-copied entries is six chances to paste the wrong
 * domain. That is the opposite of the "small precise table" convention used
 * elsewhere in this file, and it earns the exception: those tables hold cards
 * that differ, this holds a card that does not.
 *
 * The Power lands in `floatingPower`, the per-domain pool a card's Power pip
 * already drains — so a Seal is a rune you keep, which is exactly what makes it
 * worth a card at 1 Power.
 */
const SEALS: ReadonlyArray<readonly [defId: string, domain: Domain]> = [
  ["OGN-040", "Fury"],
  ["OGN-081", "Calm"],
  ["OGN-120", "Mind"],
  ["OGN-163", "Body"],
  ["OGN-204", "Chaos"],
  ["OGN-245", "Order"],
];

function sealAbility(domain: Domain): ActivatedAbilityDefinition {
  return {
    kind: "Gear",
    targeting: { kind: "none" },
    // Banks a resource and changes nothing on the board, so the AI's
    // board-state evaluator cannot price it — same flag, same reason, as
    // Lux - Crownguard and Darius.
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = {
        ...actor,
        floatingPower: { ...actor.floatingPower, [domain]: (actor.floatingPower[domain] ?? 0) + 1 },
      };
      return { ...state, players };
    },
  };
}

/** Is this card one of Teemo's own units? A name-prefix match, the same idea
 *  `isEligibleChampion` uses to decide which champion belongs to which legend —
 *  one definition of "a Teemo" rather than a second tag nobody would maintain. */
function isTeemoUnit(card: { name: string; kind: string }): boolean {
  return card.kind === "Unit" && card.name.startsWith("Teemo - ");
}

/** Teemo - Swift Scout's retrieval: Champion Zone first, then the trash. */
function retrieveTeemo(state: GameState, playerIndex: 0 | 1): GameState {
  const actor = state.players[playerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];

  if (actor.championZone && isTeemoUnit(actor.championZone)) {
    players[playerIndex] = { ...actor, championZone: null, hand: [...actor.hand, actor.championZone] };
    return { ...state, players };
  }
  const fromTrash = actor.trash.find((c) => isTeemoUnit(c));
  if (!fromTrash) return state; // nothing to fetch — 422's do as much as you can
  players[playerIndex] = {
    ...actor,
    trash: actor.trash.filter((c) => c.instanceId !== fromTrash.instanceId),
    hand: [...actor.hand, fromTrash],
  };
  return { ...state, players };
}

/** Malzahar - Fanatic's yield — two rainbow Power for one friendly permanent. */
const MALZAHAR_POWER = 2;

/**
 * Every Gear whose printed `[Equip]` cost this engine can express, as a
 * generated activated ability.
 *
 * **This is what makes 25 Equipment cards need no per-card code at all.** The
 * cost parses out of the printed text, the attach is generic, and the ability
 * is the same shape for all of them — so a table entry per card would be 25
 * copies of one thing, each free to drift.
 *
 * Four are EXCLUDED and each is named rather than silently dropped:
 *
 *   The 4 rainbow-cost Equipment (Spinning Axe, Forgefire Cape, Rabadon's
 *   Deathcrown, Shurelya's Requiem). `ActivationCost.power` names ONE domain,
 *   and rainbow is not a domain — `Colorless` is a real printed identity, so
 *   reusing it would let a Colorless rune pay a rainbow cost and nothing else.
 *   The `rainbowRunes` payment bucket exists but belongs to the `[Deflect]`
 *   surcharge, and sharing it would make "what this ability costs" and "what
 *   the opponent taxed" indistinguishable. Needs its own cost kind.
 *
 * The two COMPOUND costs (Last Rites, Blade of the Ruined King) are excluded
 * one step earlier, by `parseEquipCost` refusing to match them — see its own
 * comment for why a looser pattern would make both cards cheaper than printed.
 */
function equipAbilities(): Record<string, ActivatedAbilityDefinition> {
  const out: Record<string, ActivatedAbilityDefinition> = {};
  for (const def of defaultCardRegistry().all()) {
    if (def.type !== "Gear" || def.equipCost === undefined) continue;
    const { energy, domain, count } = def.equipCost;
    out[def.id] = {
      kind: "Gear",
      // NO exhaust: the printed reminder is "<rune>: Attach this to a unit you
      // control", and an exhaust nobody printed would make every Equipment a
      // once-per-turn attach. Re-equipping is legal and is the point —
      // [Weaponmaster] says so outright ("even if it's already attached").
      // **RAINBOW is `null`**, which is what `payPowerFromChanneled` has always
      // meant by it (811's pip, Sett - The Boss's). These four — Spinning Axe,
      // Forgefire Cape, Rabadon's Deathcrown, Shurelya's Requiem — were skipped
      // outright while `ActivationCost.power.domain` was `Domain`, so they could
      // not be attached AT ALL. Temporal Portal widened the type for its own
      // rainbow pip; that is the whole of what these needed.
      //
      // Not mapped to `Colorless`, which is a real printed identity: conflating
      // the two would let a Colorless rune pay a rainbow cost and nothing else.
      // `parseEquipCost`'s own comment draws the same line for the same reason.
      cost: { power: { domain: domain === "rainbow" ? null : domain, count }, ...(energy > 0 ? { energy } : {}) },
      targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
      // `sourceInstanceId` is the 4th argument, not a field on the event — it
      // is the gear being activated, i.e. the thing that gets attached.
      resolve: (state, ctx, event, sourceInstanceId) =>
        event.targetUnitInstanceId === undefined
          ? state
          : attachEquipment(state, ctx.casterIndex, sourceInstanceId, event.targetUnitInstanceId),
    };
  }
  return out;
}

const ACTIVATED_ABILITIES: Record<string, ActivatedAbilityDefinition> = {
  ...equipAbilities(),
  ...Object.fromEntries(SEALS.map(([defId, domain]) => [defId, sealAbility(domain)])),
  "SFD-189": {
    // Ornn - Fire Below the Mountain — "[Exhaust]: [Reaction] — [Add] [rainbow].
    // Use only to play gear or use gear abilities."
    //
    // A THIRD restricted pool, beside Kai'Sa's two. Rainbow like hers, so no
    // domain is matched; unlike hers it is spendable on GEAR — and since a Gear
    // is never a Spell, `restrictedPowerFor` picks between them rather than
    // `computeEffectiveCost` growing a fourth parameter.
    //
    // **DIVERGENCE, recorded in docs/rules-conformance.md: the "or use gear
    // ABILITIES" half does not reach an activation's Power cost.** An activated
    // ability's `power` cost is paid by `payPowerFromChanneled`, which RECYCLES a
    // matching rune out of the channeled pool and never reads a floating pool at
    // all — so no floating pool, restricted or otherwise, can pay one today. That
    // is structural and predates this card; the play half (23 of the 72 gear in
    // the pool carry a Power cost) works in full.
    //
    // `banksResource`, like the Seals and Malzahar: it changes nothing the board
    // evaluator can price, so the AI will not take it. Recorded rather than
    // worked around — this project has a standing rule against speculative
    // heuristics with no evaluative basis.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedGearPower: actor.restrictedGearPower + ORNN_GEAR_POWER };
      return { ...state, players };
    },
  },
  [FORGE_OF_THE_FLUFT]: {
    // Forge of the Fluft (SFD-208) — "While you control this battlefield,
    // friendly legends have '[Exhaust]: Attach an Equipment you control to a
    // unit you control.'"
    //
    // **A BATTLEFIELD that grants an ACTIVATED ability**, which no table modelled
    // until Heimerdinger's borrow list turned out to be the door: the ability
    // lives here under the battlefield's own id, and `abilitiesAvailableTo`
    // offers it to the Legend of whoever controls the Forge. That is the same
    // shape Heimerdinger already has ("I have all [Exhaust] abilities of all
    // friendly legends, units, and gear"), so the enumerator, the validator and
    // the executor needed nothing new — all three resolve an activation through
    // `resolveActivation`, which was already a (source, abilityDefId) pair.
    //
    // 416.1 decides whose exhaust pays: "the Exhaust symbol represents the cost
    // 'Exhaust this' or 'Exhaust me'", and the LEGEND is who has the ability. So
    // the Legend exhausts and the battlefield does not — the same reading
    // Heimerdinger's own comment records.
    //
    // "An Equipment", with no detached/attached line, so `attachesEquipment:
    // "any"` — the union of Jax - Grandmaster At Arms's two modes rather than a
    // third kind of eligibility.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    attachesEquipment: "any",
    resolve: (state, ctx, event) =>
      event.targetPermanentInstanceId && event.targetUnitInstanceId
        ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
        : state,
  },
  "SFD-082": {
    // Ezreal - Dashing, his THIRD clause — ":rb_rune_mind:: [Action] — Move me to
    // your base."
    //
    // The other two are written elsewhere and this was the whole of his partial
    // note: the attack/defend damage trigger and "I don't deal combat damage".
    //
    // **No exhaust**, because none is printed — the same call `equipAbilities`
    // makes for an `[Equip]` cost, and it is the difference between a unit that
    // can bail out repeatedly while the Power lasts and one that can do it once.
    // A cost this engine adds is a cost the card does not have.
    //
    // "Move ME", so there is nothing to target: the source IS the subject, which
    // arrives as `resolve`'s 4th argument. `recallUnitToBase` rather than the
    // MoveUnit executor, exactly as Yasuo - Unforgiven's own move does — 415.1.b
    // puts the exhaust on the Standard Move ACTION, and this is not one.
    //
    // `[Action]` needs nothing: `validate-activate-ability` applies no timing
    // check to any activation, a standing permissiveness recorded in that file.
    kind: "Unit",
    cost: { power: { domain: "Mind", count: 1 } },
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => recallUnitToBase(state, sourceInstanceId),
  },
  "SFD-078": {
    // Temporal Portal — ":rb_rune_rainbow:, [Exhaust]: Give the next spell you
    // play this turn [Repeat] equal to its cost."
    //
    // The first card that GRANTS a keyword to a card not yet played, and the
    // grant is a count rather than a flag: 3509 says "if a spell or ability has
    // more than one instance of Repeat, each Cost may be paid or not paid
    // individually", and 3525 adds one execution per instance paid. So two
    // Portals arm two instances.
    //
    // The rainbow pip needed no new cost machinery — `payPowerFromChanneled` has
    // always read `null` as "any domain", which is what rainbow means (811 uses
    // the same pip for Hide). Only the cost TYPE had to widen.
    //
    // `banksResource`: the grant changes nothing `evaluate` can price — it is a
    // discount on a card not yet played — so the heuristic AI would score it a
    // tie with Pass. Flagged like the Seals and Kai'Sa rather than given a
    // speculative heuristic, which this project has a standing rule against.
    kind: "Gear",
    cost: { power: { domain: null, count: 1 }, exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextSpellRepeatGrants: actor.nextSpellRepeatGrants + 1 };
      return { ...state, players };
    },
  },
  "SFD-193": {
    // Jax - Grandmaster At Arms — "[1], [Exhaust]: Attach a detached Equipment
    // you control to a unit you control. [Exhaust]: Attach an attached Equipment
    // you control to a unit you control."
    //
    // **Two activated abilities on one card, priced differently** — the first
    // card in the pool to need that, and the reason `AbilityMode` grew a `cost`.
    // They are modes rather than two registry entries because the registry is
    // keyed by defId: a second entry would need a second key, and every lookup
    // (`abilitiesAvailableTo`, `resolveActivation`, `hasActivatableAbility`,
    // coverage) starts from the card's own id.
    //
    // Both exhaust, so only one is usable per turn regardless. What the price
    // separates is which JOB costs Energy: putting an idle Equipment onto a unit
    // costs [1]; picking one up off a unit and moving it is free. Collapsing them
    // into one mode would sell the priced job at the free price.
    //
    // `attachesEquipment` fans the enumeration out over unit x Equipment. The
    // unit is the TARGET (`targetUnitInstanceId`) because that is what makes it a
    // chosen unit for [Deflect] and for The Dreaming Tree; the Equipment rides
    // `targetPermanentInstanceId`.
    kind: "Legend",
    modes: [
      {
        id: "detached",
        label: "Attach a detached Equipment",
        cost: { energy: 1, exhaust: true },
        // "A unit you control" — no battlefield in the text, so `anywhere`,
        // which is the scope that also reaches BASE units (the default is
        // battlefields only and would have made a home Equipment unmovable).
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        attachesEquipment: "detached",
        resolve: (state, ctx, event) =>
          event.targetPermanentInstanceId && event.targetUnitInstanceId
            ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
            : state,
      },
      {
        id: "attached",
        label: "Move an attached Equipment",
        cost: { exhaust: true },
        // "A unit you control" — no battlefield in the text, so `anywhere`,
        // which is the scope that also reaches BASE units (the default is
        // battlefields only and would have made a home Equipment unmovable).
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        attachesEquipment: "attached",
        // The same helper for both: `attachEquipment` already moves an Equipment
        // that was attached elsewhere, which is the whole of this mode.
        resolve: (state, ctx, event) =>
          event.targetPermanentInstanceId && event.targetUnitInstanceId
            ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
            : state,
      },
    ],
  },
  "SFD-199": {
    // Ezreal - Prodigal Explorer — "[Exhaust]: [Reaction] — Draw 1. Use only if
    // you've chosen enemy units and/or gear twice this turn with spells or unit
    // abilities."
    //
    // **The condition is the card**, and it is a per-turn count of CHOICES rather
    // than of cards: one spell naming two enemy units satisfies him on its own.
    // That reading is 355's and is already this engine's — `holdUnitsChosen`
    // raises one event per chosen unit and its comment says why.
    //
    // "Use only if" is a restriction on ACTIVATING, so it is `availableWhile`
    // and not a guard inside the resolver: a resolver that refused would have
    // taken the exhaust already, and the player would have paid for nothing. Both
    // the enumerator and the validator reach it through `canPayActivationCost`.
    //
    // The counting lives at the two ANNOUNCE sites (`execute-play-card` and
    // `execute-activate-ability`) rather than here, because "with spells or unit
    // abilities" is a fact about the SOURCE and only those sites know it. See
    // `recordEnemyChoices` for the three narrowings.
    //
    // The `[Reaction]` tag needs nothing: `validate-activate-ability` applies no
    // turnState, chain or priority check to ANY activation — a standing
    // permissiveness recorded in that file's own doc comment, not something this
    // card introduces.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => state.players[playerIndex].enemyChoicesThisTurn >= EZREAL_CHOICES_NEEDED,
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "SFD-197": {
    // Azir - Emperor of the Sands, second half — "[1], [Exhaust]: Play a 2 Might
    // Sand Soldier unit token to your base. Use only if you've played an
    // Equipment this turn."
    //
    // His first half ("Your Sand Soldiers have [Weaponmaster]") is a keyword AURA
    // and lives in granted-keywords.ts, not here — a continuous grant is not a
    // triggered or activated ability, the same split Master Yi's `mightBonus`
    // makes.
    //
    // **"Use only if" is a restriction on ACTIVATING**, so it goes in
    // `availableWhile` rather than into the resolver: a resolver that refused
    // would already have taken the Energy and the exhaust, and the player would
    // have paid for nothing. Both the enumerator and the validator reach it
    // through `canPayActivationCost`, so the ability cannot be offered and then
    // refused.
    //
    // It reads `equipmentPlayedThisTurn`, NOT `gearPlayedThisTurn`: Equipment is
    // a strict subset of Gear, so a Scrapheap played this turn satisfies Ornn's
    // Forge and must not satisfy Azir.
    //
    // "TO YOUR BASE" is printed and is the whole placement rule — no destination
    // is chosen, unlike Recruit the Vanguard's.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => state.players[playerIndex].equipmentPlayedThisTurn > 0,
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", SAND_SOLDIER_TOKEN),
  },
  [GOLD_TOKEN_DEF_ID]: {
    // The Gold token (SFD, printed card `sfd-t03` "Gold // Buff") — "Kill this,
    // [Exhaust]: [Reaction] — [Add] :rb_rune_rainbow:."
    //
    // **Keyed by a token's runtime defId, which is a first for this table.** A
    // token has no `CardDefinition` — `shouldSkip` filters Token-supertype
    // entries out of the playable pool — so `loadTokenDefinitions()` exists to
    // make this id traceable back to a real printed card, exactly as
    // `loadBattlefieldDefinitions()` does for the 24 battlefield abilities.
    // Without that, `coverage-drift`'s "no module claims a card that isn't
    // real" check would be asked about an id nothing in the repo could confirm.
    //
    // BOTH halves of the cost are real and both are printed. `killSelf` is what
    // makes a Gold a one-shot: it is paid before the ability resolves, so the
    // token is already dead when anything responds. `exhaust` on top of it looks
    // redundant — a card you are killing hardly needs exhausting — but it is
    // what stops a Gold that entered READY being usable twice in one chain if a
    // future card ever readies one, and it is what the card prints.
    //
    // The Power is RAINBOW, so it lands in `floatingRainbowPower` rather than
    // `floatingPower` (which is keyed by Domain) — the same pool Malzahar's
    // ritual uses, and for the same reason.
    kind: "Gear",
    cost: { killSelf: true, exhaust: true },
    targeting: { kind: "none" },
    // Banks a resource and changes nothing the board evaluator can price, so the
    // AI will not take it — the same flag, and the same known consequence, as
    // the Seals and Malzahar. Recorded rather than worked around: this project
    // has a standing rule against speculative heuristics with no evaluative
    // basis, so a Gold token will sit unspent in self-play.
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      // Renata Glasc - Chem-Baroness's "your Gold [Add] an additional [1]" — an
      // ENERGY pip on top of the printed rainbow Power, not more Power. Read
      // HERE, as the ability resolves, rather than baked into the token when it
      // is minted: her clause is a running condition on the SCORE, so a Gold made
      // while behind still pays once its controller pulls ahead.
      const extraEnergy = goldAddsExtraEnergy(state, ctx.casterIndex) ? RENATA_GOLD_BONUS_ENERGY : 0;
      players[ctx.casterIndex] = {
        ...actor,
        floatingRainbowPower: actor.floatingRainbowPower + 1,
        floatingEnergy: actor.floatingEnergy + extraEnergy,
      };
      return { ...state, players };
    },
  },
  "OGN-113": {
    // Malzahar - Fanatic — "Kill a friendly unit or gear, Exhaust: [Action] ->
    // Add [rainbow][rainbow]."
    //
    // A ritual: a body for two Power of any colour. The Power is RAINBOW, so it
    // cannot land in `floatingPower` (keyed by Domain) and gets its own pool —
    // see PlayerState.floatingRainbowPower for why that is not Kai'Sa's.
    //
    // The kill is a COST, not an effect, and that is the whole card: it is paid
    // before the ability resolves, so a unit killed this way is already dead when
    // anything responds, and paying with the last friendly permanent is legal.
    kind: "Unit",
    cost: { killFriendlyPermanent: true, exhaust: true },
    targeting: { kind: "none" },
    // Banks a resource and changes nothing the board evaluator can price — the
    // same flag the Seals carry. (The kill DOES change the board, but it is the
    // price rather than the point.)
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingRainbowPower: actor.floatingRainbowPower + MALZAHAR_POWER };
      return { ...state, players };
    },
  },
  "OGN-023": {
    // Unlicensed Armory — "Discard 1, Exhaust: Choose a friendly unit. The next
    // time it would die this turn, you may pay [Fury] to heal it, exhaust it, and
    // recall it instead."
    //
    // Two prices at two different moments, and both are real: a card and an
    // exhaust NOW to arm the ward, 1 Fury Power LATER only if the unit actually
    // dies. Arming it costs the discard whether or not the unit ever dies, which
    // is what makes it a gamble rather than insurance.
    //
    // The ward itself lives in death-ward.ts beside Highlander's free one; only
    // the arming is here.
    kind: "Gear",
    cost: { discard: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : {
            ...state,
            // Not de-duplicated: arming the same unit twice with two Armories is
            // two wards, and the second survives the first death — "the NEXT
            // time" consumes one entry, and the rules never merge two
            // replacement effects into one.
            paidDeathWardUnitInstanceIds: [...state.paidDeathWardUnitInstanceIds, event.targetUnitInstanceId],
          },
  },
  "OGN-181": {
    // Pack of Wonders — "Exhaust: Return ANOTHER friendly gear, unit, or facedown
    // card to its owner's hand."
    //
    // Three narrowings on one spec, all printed and all separately load-bearing.
    // **ANOTHER**: it cannot bounce itself, which would otherwise be its best
    // line — exhaust, return the Pack, replay it. **FRIENDLY**: it is a rescue,
    // not removal; bouncing an enemy body would make a 2-Energy gear a repeatable
    // Gust. **OR FACEDOWN CARD**: a facedown card is neither a unit nor a gear,
    // so it needed its own opt-in rather than falling out of the existing walk.
    //
    // A facedown card's NAME is deliberately withheld from the candidate list —
    // `hiddenCards` holds the real card and nothing may leak it, the same rule
    // the board follows by rendering "Facedown".
    kind: "Gear",
    targeting: { kind: "unitOrGear", owner: "friendly", excludesSelf: true, includesFacedown: true },
    resolve: (state, _ctx, event) => (event.targetPermanentInstanceId ? returnPermanentToHand(state, event.targetPermanentInstanceId) : state),
  },
  "OGN-263": {
    // Teemo - Swift Scout (Legend) — "[1 Energy], Exhaust: Put a Teemo unit you
    // own into your hand from your Champion Zone or the trash."
    //
    // His other sentence — "you may pay [1 Energy] to hide a card instead of
    // [1 rainbow]" — is a COST alternative and lives with the hide pricing in
    // hidden.ts, the same split every card whose two clauses touch different
    // layers takes.
    //
    // "A TEEMO unit YOU OWN" is a name match, not a tag: the pool's Teemo units
    // are named "Teemo - …", the same prefix `isEligibleChampion` already uses to
    // decide which champion belongs to which legend. Reusing that idea rather than
    // adding a tag keeps one definition of what makes a card "a Teemo".
    //
    // **The Champion Zone FIRST, then the trash** — the zone holds at most one
    // card and it is the one a player is most likely to want back, and taking it
    // from there is what makes the Legend a repeatable engine rather than a
    // graveyard rummage. Recorded Unverified: the card offers a choice of zone and
    // this takes them in a fixed order.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => retrieveTeemo(state, ctx.casterIndex),
  },
  "OGN-078": {
    // Lee Sin - Ascetic — "Exhaust: Buff me. I can have any number of buffs."
    //
    // The second sentence is the card: rule 708 makes a second buff on an
    // already-buffed unit a no-op, so without it this would be an exhaust for
    // nothing after the first use. `addBuff` names him in its own
    // `STACKING_BUFF_DEF_IDS` exception, and the stack lives in `extraBuffs`
    // rather than turning `buffed` into a number — which is what keeps every
    // other reader of that boolean (Sett - Kingpin's count, Lee Sin - Centered's
    // aura, Wildclaw Shaman's cost) correct and untouched.
    //
    // He readies at every Awaken, so this is +1 Might a turn, permanently. Each
    // buff is also a real Buff for every card that cares about one, and spending
    // one (705) takes an extra first and leaves him buffed.
    kind: "Unit",
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => addBuff(state, sourceInstanceId),
  },
  "OGN-068": {
    // Caitlyn - Patrolling — "Exhaust: Deal damage equal to my Might to a unit at
    // a battlefield. Use this ability only while I'm at a battlefield."
    //
    // Her other sentence — "I must be assigned combat damage last" — is Backline
    // printed as prose, and lives in `combat.assignmentOrder`'s third tier.
    //
    // **"Only while I'm at a battlefield"** is a restriction on ACTIVATING, so it
    // has to be asked where the ability is offered rather than inside the
    // resolver: a resolver that refused would have taken her exhaust for nothing.
    // `availableWhile` is that hook.
    //
    // "Damage equal to MY Might" is read at RESOLUTION, through `effectiveMight`
    // in her own location — so an aura or a this-turn pump makes the shot bigger,
    // the same reading Yasuo - Remorseful and Last Stand take.
    kind: "Unit",
    targeting: { kind: "unit" },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      findUnitOnBattlefield(state, sourceInstanceId)?.ownerIndex === playerIndex,
    resolve: (state, ctx, event, sourceInstanceId) => {
      if (!event.targetUnitInstanceId) return state;
      const self = findUnitOnBattlefield(state, sourceInstanceId);
      if (!self) return state;
      const might = effectiveMight(state, self.unit, ctx.casterIndex, {
        isCombat: false,
        battlefieldId: state.battlefields[self.battlefieldIndex]!.id,
      });
      return dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, might);
    },
  },
  "OGN-032": {
    // Ravenborn Tome — "Exhaust: The next spell you play this turn deals 1 Bonus
    // Damage."
    //
    // A CHARGE on the player, read by `modifiedDamageAmount` and cleared when a
    // Spell finishes resolving — which is where "the next spell" ends. Raging
    // Firebrand's discount takes the same shape one layer up, in the cost
    // pipeline; this one is on the damage side.
    //
    // "BONUS DAMAGE" is Annie - Fiery's wording, and it stacks with hers rather
    // than replacing it: two separate +1s, which is what two effects each saying
    // "1 Bonus Damage" means.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextSpellBonusDamage: actor.nextSpellBonusDamage + 1 };
      return { ...state, players };
    },
  },
  "OGN-098": {
    // Energy Conduit — "Exhaust: Add 1 Energy."
    //
    // The Seals' Energy counterpart, and unrestricted unlike Lux - Crownguard's
    // spells-only pool: it lands in `floatingEnergy`, which pays for anything.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + 1 };
      return { ...state, players };
    },
  },
  "OGN-017": {
    // Iron Ballista — "This enters exhausted. Exhaust: Deal 2 to a unit at a
    // battlefield."
    //
    // The enters-exhausted half is a play rule and lives in deploy.ts; it is the
    // card's whole cost, since without it a 3-Energy repeatable 2 damage would
    // fire the turn it lands.
    //
    // Default battlefield scope: "at a battlefield" is printed, so a unit in
    // base is out of range. Either player's is fair game — no owner is named.
    kind: "Gear",
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 2) : state,
  },
  "OGN-124": {
    // Arena Bar — "Exhaust: Buff an exhausted friendly unit."
    //
    // "EXHAUSTED" is a restriction on the target's state, which no spec could
    // express before — see TargetingSpec's `exhaustedOnly`. Filtered in
    // enumeration so a ready unit is never offered, rather than checked in this
    // resolver where the exhaust would already have been paid for nothing.
    //
    // addBuff, so 708 applies: buffing an already-buffed unit spends the exhaust
    // and does nothing, which is the rule rather than a case to dodge.
    kind: "Gear",
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", exhaustedOnly: true },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state),
  },
  "OGN-184": {
    // The Syren — "1 Energy, Exhaust: Move a friendly unit at a battlefield to
    // its base."
    //
    // recallUnitToBase, which exhausts the moved unit — see its doc comment for
    // why that is an open question rather than a settled reading, filed as
    // Unverified for Flash and Maddened Marauder and inherited here rather than
    // decided differently for a third card.
    kind: "Gear",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state),
  },
  "OGN-099": {
    // Garbage Grabber — "Recycle 3 from your trash, 1 Energy, Exhaust: Draw 1."
    //
    // Three costs at once and every one of them already existed: the Recycle
    // (Vi - Destructive), the Energy (the preset Legends) and the exhaust. Rule
    // 416.3 makes the Recycle all-or-nothing, so a trash of two cards cannot pay
    // it and the ability is simply not offered.
    kind: "Gear",
    cost: { recycleFromTrash: 3, energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "OGN-186": {
    // Treasure Trove — "When this leaves the board, draw 1 and channel 1 rune
    // exhausted. [Chaos], Exhaust: Kill this."
    //
    // The ability's whole function is to pay its own leave-the-board trigger,
    // which is why the effect here is empty: `killSelf` in the COST does the
    // work, and killGear fires the self-trigger that draws and channels. Putting
    // the draw in this resolver instead would double it the day the Trove leaves
    // the board some other way.
    kind: "Gear",
    cost: { power: { domain: "Chaos", count: 1 }, killSelf: true, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state) => state,
  },
  [LUX_CROWNGUARD]: {
    kind: "Unit",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedSpellEnergy: actor.restrictedSpellEnergy + 2 };
      return { ...state, players };
    },
  },
  [VI_DESTRUCTIVE]: {
    kind: "Unit",
    // "Recycle 1 from your trash: Give me +1 Might this turn." No exhaust symbol,
    // so `cost` names only the recycle — she can do this repeatedly as long as
    // the trash holds cards, which is the card's whole texture. Defaulting to an
    // exhaust here would have capped her at once per turn.
    cost: { recycleFromTrash: 1 },
    // "Give ME" — no target to choose.
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(state, ctx.casterIndex, sourceInstanceId, 1),
  },
  [VIKTOR_HERALD]: {
    // Viktor - Herald of the Arcane — "1 Energy, exhaust: Play a 1-Might Recruit
    // unit token."
    //
    // The first LEGEND ability in this registry. Nothing about the Legend zone
    // needed inventing for it: Awaken already readies the legend
    // (turn-manager's `legend: { ...p.legend, exhausted: false }`), so the
    // ready/exhaust cycle that makes a once-per-turn ability once-per-turn was
    // there all along and simply had nothing using it.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeRecruitToken(state, ctx.casterIndex, "base"),
  },
  [LEE_SIN_BLIND_MONK]: {
    // Lee Sin - Blind Monk — "1 Energy, exhaust: Buff a friendly unit."
    //
    // Routed through addBuff, which is where 708's "not placed instead" lives —
    // so buffing an already-buffed unit spends the Energy and the exhaust for
    // nothing, which is what the rules say and not a case to special-case away.
    // It also means this and Mistfall compose with no knowledge of each other:
    // addBuff fires `unitBuffed`, so buffing with the Legend can offer the gear
    // its ready-it trigger.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state),
  },
  [UDYR_WILDMAN]: {
    // Udyr - Wildman — "Spend my buff: Choose one you've not chosen this turn —
    // Deal 2 to a unit at a battlefield / Stun a unit at a battlefield / Ready me
    // / Give me [Ganking] this turn."
    //
    // No exhaust anywhere in that cost line, so like Vi - Destructive he can go
    // again — as often as buffs keep arriving, and up to four times a turn since
    // each mode is spent separately. Assuming the exhaust would have capped him
    // at once and quietly made the four-mode design pointless.
    kind: "Unit",
    cost: { spendBuff: true },
    modesOncePerTurn: true,
    modes: [
      {
        id: "damage",
        label: "Deal 2 to a unit at a battlefield",
        targeting: { kind: "unit" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 2) : state,
      },
      {
        id: "stun",
        label: "Stun a unit at a battlefield",
        targeting: { kind: "unit" },
        // stunUnits, not stunUnit: this is a real stun by a real player, so it
        // has to be visible to Eclipse Herald and Leona - Radiant Dawn. Reading
        // the primitive here instead would be the dispatch-hop bug this codebase
        // has already shipped three times — the ability would still stun, and
        // the watchers would silently never fire.
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
      },
      {
        id: "ready",
        label: "Ready me",
        targeting: { kind: "none" },
        resolve: (state, _ctx, _event, sourceInstanceId) => readyUnit(state, sourceInstanceId),
      },
      {
        id: "ganking",
        label: "Give me [Ganking] this turn",
        targeting: { kind: "none" },
        resolve: (state, _ctx, _event, sourceInstanceId) => grantKeywordThisTurn(state, sourceInstanceId, "Ganking"),
      },
    ],
  },
  [MISS_FORTUNE_BOUNTY_HUNTER]: {
    // Miss Fortune - Bounty Hunter — "Exhaust: Give a unit [Ganking] this turn."
    //
    // "A unit" with no owner and no battlefield named, so scope: "anywhere" and
    // either player's units are legal targets — the same reading Orb of Regret
    // below already has. Granting [Ganking] to an ENEMY unit is a bad play
    // rather than an illegal one, so `owner` stays unset.
    //
    // keywordsThisTurn, via grantKeywordThisTurn, so it expires at runEnd with
    // the rest of the turn rather than being written into the printed set —
    // exactly what Udyr's own [Ganking] mode needed.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Ganking") : state,
  },
  [DARIUS_HAND_OF_NOXUS]: {
    // Darius - Hand of Noxus — "Exhaust: [Reaction], [Legion] — Add 1 Energy."
    //
    // [Legion] is "get the effect if you've played a card this turn", and the
    // state for it already exists: `cardsPlayedThisTurn`, which execute-play-card
    // increments and runEnd resets. Nothing new is needed for the keyword here —
    // it is a condition on the effect, not a cost, so an unmet [Legion] still
    // spends the exhaust and yields nothing. That is what the keyword says.
    //
    // The Energy is UNRESTRICTED (unlike Lux - Crownguard's spells-only pool), so
    // it lands in `floatingEnergy` — the fungible pool every cost drains first.
    //
    // [Reaction] needs nothing here: activateAbilityCandidates is already offered
    // in every timing branch (legal-actions.ts), which is more permissive than
    // this keyword requires rather than less.
    //
    // banksResource, like Lux - Crownguard: the AI's evaluate() scores board
    // state, so an ability that only stores Energy would tie with Pass and be
    // chosen on a coin flip.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      if (actor.cardsPlayedThisTurn < 1) return state; // [Legion] unmet
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + 1 };
      return { ...state, players };
    },
  },
  [KAISA_DAUGHTER_OF_THE_VOID]: {
    // Kai'Sa - Daughter of the Void — "Exhaust: [Reaction] — Add 1 rainbow Power.
    // Use only to play spells."
    //
    // POWER, not Energy, and that is the difference from Lux - Crownguard: it
    // pays a card's Power pip. "Rainbow" means any domain (rule 811 uses the
    // same pip for Hide), so it cannot live in `floatingPower`, which is keyed by
    // Domain — a rainbow entry there would need a seventh fake domain that every
    // consumer would then have to know to ignore.
    //
    // So it gets its own scalar, `restrictedSpellPower`, drained after
    // floatingPower and only for Spells — a direct mirror of the
    // restrictedSpellEnergy pool that already exists for exactly this shape of
    // ability. See rune-payment.ts's computeEffectiveCost.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedSpellPower: actor.restrictedSpellPower + 1 };
      return { ...state, players };
    },
  },
  [YASUO_UNFORGIVEN]: {
    // Yasuo - Unforgiven — "2 Energy, exhaust: Move a friendly unit to or from
    // its base."
    //
    // TWO modes rather than one compound target, and the reason is that "to or
    // from" is genuinely two different moves with two different target shapes:
    // going home names only a unit, while leaving home also names a destination.
    // A single spec would have needed a unit-plus-battlefield pair that no other
    // card in this pool wants.
    //
    // `modesOncePerTurn` is deliberately NOT set. Udyr needs it because his cost
    // has no exhaust and he can go four times; Yasuo's exhaust already caps him
    // at once, so tracking spent modes would be bookkeeping with nothing to stop.
    //
    // Both moves are `forceMoveToBattlefield`/`recallUnitToBase`, not the
    // MoveUnit executor — 415.1.b puts the exhaust on the Standard Move ACTION,
    // so a unit Yasuo moves does not pay it again.
    kind: "Legend",
    cost: { energy: 2, exhaust: true },
    modes: [
      {
        id: "toBase",
        label: "Move a friendly unit to its base",
        // "To its base" — so the unit must be AT a battlefield to have somewhere
        // to come back from. The default battlefield scope says exactly that.
        targeting: { kind: "unit", owner: "friendly" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
      },
      {
        id: "fromBase",
        label: "Move a friendly unit from its base",
        // The destination rides on the action's own battlefield field, fanned
        // out per battlefield by legal-actions — the same field Charm already
        // uses to say where a moved unit lands.
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        movesTarget: true,
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId && event.destinationBattlefieldId
            ? forceMoveToBattlefield(state, event.targetUnitInstanceId, event.destinationBattlefieldId)
            : state,
      },
    ],
  },
  [FORGE_OF_THE_FUTURE]: {
    // Forge of the Future — "Kill this: Recycle up to 4 cards from trashes."
    // (Its "when you play this, play a Recruit token" half is a self-trigger in
    // effects/order.ts.)
    //
    // "From TRASHES", plural — either player's, which is what makes it a
    // graveyard-hate card rather than a self-recursion one. Taken from the
    // opponent's first, since that is the only reason to cast it at an opponent
    // and the caster's own trash is theirs to keep otherwise.
    //
    // "UP TO 4", so a short trash recycles what is there (422).
    kind: "Gear",
    cost: { killSelf: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const opponentIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      let next = state;
      let remaining = 4;
      for (const index of [opponentIndex, ctx.casterIndex] as const) {
        if (remaining <= 0) break;
        const owner = next.players[index];
        const taken = owner.trash.slice(0, remaining);
        if (taken.length === 0) continue;
        remaining -= taken.length;
        const players = [...next.players] as [PlayerState, PlayerState];
        players[index] = { ...owner, trash: owner.trash.slice(taken.length), deck: [...owner.deck, ...taken] };
        next = { ...next, players };
      }
      return next;
    },
  },
  [SUN_DISC]: {
    // Sun Disc — "Exhaust: [Legion] — The next unit you play this turn enters
    // ready."
    //
    // A CHARGE on the player (`nextUnitsEnterReady`), not Confront's blanket
    // this-turn flag: this readies exactly one unit and is then spent, which is
    // why deploy.ts consumes it rather than just reading it.
    //
    // [Legion] is checked with `countingSelf: false` — activating an ability is
    // not playing a card and increments nothing, so "another card this turn" is
    // any one card, the same reading Darius - Hand of Noxus takes.
    //
    // An unmet [Legion] still spends the exhaust and arms nothing: the keyword
    // gates the EFFECT, not the cost.
    //
    // banksResource: the AI's evaluate() scores board state, and an armed charge
    // changes nothing it can see until a unit is played into it.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      if (!legionActive(state, ctx.casterIndex, false)) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextUnitsEnterReady: actor.nextUnitsEnterReady + 1 };
      return { ...state, players };
    },
  },
  "OGN-164": {
    // Sett - Brawler — "Spend my buff: Give me +4 Might this turn." (His two
    // buff-me clauses are in effects/body.ts.)
    //
    // No exhaust anywhere in the cost line, exactly like Udyr and Vi, so he can
    // do this as often as buffs keep arriving — and his own text is what keeps
    // supplying them. Assuming an exhaust would have capped the engine of the
    // card at once per turn.
    kind: "Unit",
    cost: { spendBuff: true },
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(state, ctx.casterIndex, sourceInstanceId, 4),
  },
  [BAITED_HOOK]: {
    kind: "Gear",
    // Energy AND Power, which nothing else here has. `activationPayment` applies
    // the Power step first and prices the Energy against what it leaves, so the
    // two halves cannot double-spend a rune — and, per 164.2's two rune
    // abilities, a single Ready Order rune legitimately covers both.
    cost: { energy: 1, power: { domain: "Order", count: 1 }, exhaust: true },
    // "Kill a FRIENDLY unit" — an announce-time target, so it is chosen before
    // the ability resolves and `legal-actions` fans one candidate out per unit.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event, sourceInstanceId) => {
      const victimId = event.targetUnitInstanceId;
      if (!victimId) return state;
      const victim = findUnitAnywhere(state, victimId);
      // **359.3.e.14, and the PDF works THIS card as its example:** if the chosen
      // unit is no longer a legal target, "it can't be killed and its Might is
      // treated as null. Baited Hook's controller looks at the top 5 cards of
      // their Main Deck, but can't choose any unit from among them." The look and
      // the recycle are separate instructions and still execute — only the
      // banish-and-play is linked to the kill and is therefore ignored.
      //
      // Unreachable today and written anyway: this engine opens no response
      // window between submitting an ActivateAbility and resolving it, so nothing
      // can remove the victim in between. Reported as unexercised, not working.
      // Read BEFORE the kill, off the victim's own location — `findUnitAnywhere`
      // reports a zone (`"base"` or a battlefield INDEX), not an id.
      const victimBattlefieldId =
        victim && typeof victim.zone === "object" ? state.battlefields[victim.zone.battlefieldIndex]?.id : undefined;
      const cap = victim
        ? effectiveMight(state, victim.unit, victim.ownerIndex, { isCombat: false }) + 1
        : null;
      const killed = victim ? destroyUnit(state, victimId, ctx.casterIndex) : state;
      // "Look at the top 5" is a look, so Nocturne sees it — offered before the
      // Hook's own question for the FIFO reason Reinforce's resolve records.
      const looked = offerTopOfDeckBanish(killed, ctx.casterIndex, killed.players[ctx.casterIndex].deck.slice(0, 5));
      return parkDecision(looked, {
        kind: "OGN-242-banish",
        playerIndex: ctx.casterIndex,
        cardInstanceId: sourceInstanceId,
        // The Might cap rides on the decision rather than being re-derived: the
        // victim is in a trash by the time this is answered, and `null` is the
        // 359.3.e.14 case, which must stay distinguishable from a cap of 0.
        ...(cap !== null ? { count: cap } : {}),
        // WHERE the bait stood, for the same reason and a stronger one: the free
        // play this leads to may land there even though the kill just emptied it
        // (359.3's linked instructions — see free-play.ts's destinationsFor).
        // Nothing can recompute it later. The unit is in a trash by then, and the
        // Cleanup between this submit and the answer has already lapsed control of
        // a battlefield the player no longer occupies.
        ...(victimBattlefieldId !== undefined ? { battlefieldId: victimBattlefieldId } : {}),
      });
    },
  },
  "SFD-052": {
    // Heart of Dark Ice — "[Exhaust]: Give a unit +3 Might this turn."
    //
    // Orb of Regret's mirror, one entry down, and deliberately written the same
    // way: "a unit" names no owner and no battlefield, so either player's base
    // is a legal target — the reading base-targeting.test.ts already pins.
    //
    // **No floor**, unlike the Orb's. That is the card rather than an omission:
    // a floor exists to stop a REDUCTION digging below 1, and nothing needs
    // capping on the way up.
    kind: "Gear",
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, HEART_OF_DARK_ICE_MIGHT) : state,
  },
  [ORB_OF_REGRET]: {
    kind: "Gear",
    // "A unit" names no battlefield and no owner, so a unit in either player's
    // base is a legal target — the same reading base-targeting.test.ts already
    // pins for En Garde and Stupefy.
    targeting: { kind: "unit", scope: "anywhere" },
    // The floor is the card's own clause, not a safety net: giveMightThisTurn's
    // `floor` argument exists for exactly this wording, and it caps the stored
    // modifier rather than only the displayed Might, so repeated activations
    // can't dig a hole a later buff has to climb out of.
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -1, 1) : state,
  },
};

export function activatedAbilityFor(defId: string): ActivatedAbilityDefinition | undefined {
  return ACTIVATED_ABILITIES[defId];
}

export function hasActivatableAbility(defId: string): boolean {
  return defId in ACTIVATED_ABILITIES;
}

/**
 * What activating `defId` costs, with the common `{ exhaust: true }` default made
 * explicit so no caller has to remember it.
 *
 * `modeId` is what makes a MODAL ability able to price its options differently
 * (Jax - Grandmaster At Arms). Omitting it deliberately still answers — the
 * ability's own cost — because every existing caller of a non-modal ability
 * passes nothing, and because a mode with no `cost` of its own falls through to
 * exactly that answer anyway.
 */
export function activationCostOf(defId: string, modeId?: string): ActivationCost {
  const ability = ACTIVATED_ABILITIES[defId];
  if (modeId !== undefined) {
    const mode = modesOf(defId).find((m) => m.id === modeId);
    if (mode?.cost) return mode.cost;
  }
  return ability?.cost ?? { exhaust: true };
}

/**
 * Can `playerIndex` pay this ability's cost right now?
 *
 * Both halves are real refusals, not do-as-much-as-you-can: an exhausted source
 * can't pay an exhaust, and rule 416.3 says a Recycle cost "must be able to be
 * completed for the cost to be paid". Shared by the validator and the
 * enumerator so an ability is never offered and then refused.
 */
/**
 * The friendly permanents an ability could kill to pay — units anywhere plus
 * active gear, EXCLUDING the source itself.
 *
 * Excluding the source is not printed on Malzahar and is the right reading
 * anyway: `killSelf` is the cost that destroys the source, and an ability that
 * both exhausted and killed its own unit could never be used twice. The rules'
 * own separation of the two cost kinds is what says these are different things.
 */
export function killableFriendlyPermanents(
  state: GameState,
  playerIndex: 0 | 1,
  sourceInstanceId: string,
): { instanceId: string; name: string; isGear: boolean }[] {
  const owner = state.players[playerIndex];
  return [
    ...owner.baseUnits.map((u) => ({ instanceId: u.instanceId, name: u.name, isGear: false })),
    ...state.battlefields.flatMap((bf) => (bf.units[owner.id] ?? []).map((u) => ({ instanceId: u.instanceId, name: u.name, isGear: false }))),
    ...owner.activeGear.map((g) => ({ instanceId: g.instanceId, name: g.name, isGear: true })),
  ].filter((p) => p.instanceId !== sourceInstanceId);
}

export function canPayActivationCost(
  state: GameState,
  playerIndex: 0 | 1,
  card: { instanceId: string; defId: string; exhausted: boolean; buffed?: boolean },
  /** The ability being used, when it is not the source's own — Heimerdinger
   *  pays somebody else's cost with his own exhaust. Defaults to the source. */
  abilityDefId: string = card.defId,
  /** The mode being used, for an ability whose modes are priced differently —
   *  Jax. Omitted everywhere else, where there is one price to ask about. */
  modeId?: string,
): boolean {
  const ability = ACTIVATED_ABILITIES[abilityDefId];
  // A printed restriction on USING the ability, asked before any cost — see
  // `availableWhile`. Checked here so the enumerator and the validator, which
  // both come through this function, cannot disagree about whether it is legal.
  if (ability?.availableWhile && !ability.availableWhile(state, playerIndex, card.instanceId)) return false;
  const cost = activationCostOf(abilityDefId, modeId);
  if (cost.exhaust && card.exhausted) return false;
  if (cost.recycleFromTrash !== undefined && state.players[playerIndex].trash.length < cost.recycleFromTrash) return false;
  // Power is paid from state, so affordability is asked through the very helper
  // that will pay it — the two cannot disagree about what is payable.
  if (cost.power && payPowerFromChanneled(state, playerIndex, cost.power.domain, cost.power.count) === undefined) return false;
  // rule 705: only a buffed unit can spend one, so an unbuffed Udyr is simply
  // not offered rather than offered and refused.
  if (cost.spendBuff && !("buffed" in card && card.buffed === true)) return false;
  // The two costs that carry a CHOICE. Affordability is "is there anything to
  // choose", asked here so an ability with nothing to pay with is never offered
  // — 416.3's "a cost that cannot be completed is not one you may choose to pay".
  if (cost.killFriendlyPermanent && killableFriendlyPermanents(state, playerIndex, card.instanceId).length === 0) return false;
  if (cost.discard !== undefined && state.players[playerIndex].hand.length < cost.discard) return false;
  // `killSelf` needs no check here: the source was found in play by
  // resolveActivation before this was called, and unlike an exhaust there is no
  // second state it could be in — a Forge that has paid is gone, not spent.
  // The Energy half is a payment, so affordability is "could a payment be
  // computed", which is exactly what the enumerator will do — asked through the
  // same function so the two cannot disagree about what is affordable.
  if (cost.energy !== undefined && activationPayment(state, playerIndex, cost) === undefined) return false;
  return true;
}

/**
 * The runes that would pay an activation's Energy cost, or undefined if it
 * cannot be paid.
 *
 * Floating Energy first, exactly as a card's cost is priced — `energyAfterFloat`
 * is the same function `computeEffectiveCost` uses, so an activation and a play
 * agree on what a player can afford.
 *
 * Takes the whole COST, not just the Energy number, because `payActivationCost`
 * pays Power FIRST and paying Power RECYCLES the rune: the pool this prices
 * against has to be the one the Power step leaves behind, or a single rune can
 * be named for Energy and then be gone by the time the Energy is paid. Power is
 * applied here to a throwaway state for exactly that reason — the same helper,
 * in the same order, so the price and the payment cannot disagree.
 *
 * Note this is NOT a live fix: pricing it against the pre-Power pool happens to
 * come out the same, because recycling a READY rune banks 1 floating Energy,
 * which covers precisely the 1 Energy that rune could have paid — the two
 * errors cancel exactly, for every pool and every cost. It is written this way
 * so the agreement is by construction rather than by that coincidence. Nothing
 * in the pool combines `energy` with `power` yet; OGN-242 Baited Hook would be
 * the first, and it is the card that would inherit the coincidence.
 */
export function activationPayment(state: GameState, playerIndex: 0 | 1, cost: ActivationCost): RunePayment | undefined {
  if (cost.energy === undefined) return undefined;
  let next = state;
  if (cost.power) {
    const paid = payPowerFromChanneled(next, playerIndex, cost.power.domain, cost.power.count);
    if (paid === undefined) return undefined;
    next = paid;
  }
  const actor = next.players[playerIndex];
  return computeAutoPayment(actor.channeled, energyAfterFloat(actor.floatingEnergy, cost.energy), 0, null) ?? undefined;
}

/** Pays an activation cost, or returns undefined if it cannot be paid. */
export function payActivationCost(
  state: GameState,
  playerIndex: 0 | 1,
  instanceId: string,
  defId: string,
  payment?: RunePayment,
  /** What the action named for a cost that carries a CHOICE — Malzahar's kill,
   *  Unlicensed Armory's discard. Absent for every cost paid from state. */
  chosen?: { costPermanentInstanceId?: string; costDiscardCardInstanceId?: string },
  /** The mode being paid for — see `activationCostOf`. */
  modeId?: string,
): GameState | undefined {
  const cost = activationCostOf(defId, modeId);
  let next = state;
  if (cost.recycleFromTrash !== undefined) {
    const recycled = recycleFromTrash(next, playerIndex, cost.recycleFromTrash);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  if (cost.spendBuff) {
    const spent = spendBuff(next, playerIndex, instanceId);
    if (spent === undefined) return undefined;
    next = spent;
  }
  if (cost.power) {
    const paid = payPowerFromChanneled(next, playerIndex, cost.power.domain, cost.power.count);
    if (paid === undefined) return undefined;
    next = paid;
  }
  if (cost.killSelf) {
    const gear = next.players[playerIndex].activeGear.find((g) => g.instanceId === instanceId);
    if (!gear) return undefined;
    // killGear, not a quiet removal: paying a cost with a permanent is still
    // killing it, so its own "when I am killed" self-trigger must fire — the
    // same reasoning Cruel Patron's kill-as-a-cost already follows.
    next = killGear(next, gear, playerIndex);
  }
  // The two costs that carry a CHOICE, paid from what the action named.
  if (cost.killFriendlyPermanent) {
    if (!chosen?.costPermanentInstanceId) return undefined;
    const gear = next.players[playerIndex].activeGear.find((g) => g.instanceId === chosen.costPermanentInstanceId);
    // Routed through the real funnels for the reason Cruel Patron's kill records:
    // paying a cost with a permanent is still killing it, so a unit's [Deathknell]
    // and a gear's "when I am killed" both fire. No `killerIndex` — paying a cost
    // with your own permanent is not "you killing it" in Solari Shrine's sense.
    next = gear ? killGear(next, gear, playerIndex) : destroyUnit(next, chosen.costPermanentInstanceId);
  }
  if (cost.discard !== undefined) {
    if (!chosen?.costDiscardCardInstanceId) return undefined;
    const actor = next.players[playerIndex];
    const card = actor.hand.find((c) => c.instanceId === chosen.costDiscardCardInstanceId);
    if (!card) return undefined;
    const players = [...next.players] as [PlayerState, PlayerState];
    players[playerIndex] = {
      ...actor,
      hand: actor.hand.filter((c) => c.instanceId !== card.instanceId),
      trash: [...actor.trash, card],
      discardedThisTurn: true,
    };
    next = { ...next, players };
  }
  if (cost.energy !== undefined) {
    const paid = payActivationEnergy(next, playerIndex, cost.energy, payment);
    if (paid === undefined) return undefined;
    next = paid;
  }
  // The `[Deflect]` surcharge on whatever this ability chose. Paid LAST, after
  // the ability's own cost, for the reason `computeAutoPayment` takes it last:
  // the ability's Power is domain-restricted and the tax is not, so spending a
  // matching rune on the tax first could make a payable ability unpayable.
  //
  // Not gated on `cost`: the surcharge is the OPPONENT's keyword, not part of
  // what the ability costs, so an ability whose only cost is an exhaust still
  // owes it. `validate-activate-ability` is what decides it is owed at all.
  const rainbow = payment?.rainbowRunes ?? [];
  if (rainbow.length > 0) {
    const recycled = recycleRunesForSurcharge(next, playerIndex, rainbow);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  if (cost.exhaust) next = exhaustActivated(next, playerIndex, instanceId);
  return next;
}

/**
 * Recycles the named runes to the bottom of the rune deck for a `[Deflect]`
 * surcharge — 416, a Power cost is paid by recycling.
 *
 * **No floating-Energy credit**, unlike a rune recycled for its owner's own
 * Power. 164.2's double duty is about paying YOUR cost; a tax handed to an
 * opponent refunds nothing, which is the same line `execute-play-card` draws
 * for a Spell's surcharge.
 */
function recycleRunesForSurcharge(state: GameState, playerIndex: 0 | 1, runeIds: readonly string[]): GameState | undefined {
  const actor = state.players[playerIndex];
  const spent = actor.channeled.filter((r) => runeIds.includes(r.id));
  if (spent.length < runeIds.length) return undefined;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    channeled: actor.channeled.filter((r) => !runeIds.includes(r.id)),
    runeDeck: [...actor.runeDeck, ...spent.map((r) => ({ ...r, state: "Ready" as const }))],
  };
  return { ...state, players };
}

/** Spends floating Energy first, then exhausts the named runes — the same order
 *  and the same arithmetic execute-play-card uses for a card's Energy cost. */
function payActivationEnergy(
  state: GameState,
  playerIndex: 0 | 1,
  energy: number,
  payment: RunePayment | undefined,
): GameState | undefined {
  const actor = state.players[playerIndex];
  const fromFloat = Math.min(actor.floatingEnergy, energy);
  const owed = energy - fromFloat;
  const runeIds = new Set(payment?.energyRunes ?? []);
  const usable = actor.channeled.filter((r) => runeIds.has(r.id) && r.state === "Ready");
  if (usable.length < owed) return undefined;

  const spend = new Set(usable.slice(0, owed).map((r) => r.id));
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    floatingEnergy: actor.floatingEnergy - fromFloat,
    channeled: actor.channeled.map((r) => (spend.has(r.id) ? { ...r, state: "Exhausted" as const } : r)),
  };
  return { ...state, players };
}

/** Does this ability only bank a resource? See `banksResource` — the AI skips
 *  these because a board-state evaluator cannot price them. */
export function abilityBanksResource(defId: string): boolean {
  return ACTIVATED_ABILITIES[defId]?.banksResource === true;
}

/** Targeting for an activated ability, defaulting to "none" — same shape and
 *  default as targetingForCard, so callers can treat the two alike. */
export function activatedAbilityTargeting(defId: string): TargetingSpec {
  return ACTIVATED_ABILITIES[defId]?.targeting ?? { kind: "none" };
}

/** Every defId with an activated ability, for coverage.ts. */
export function activatedAbilityDefIds(): string[] {
  return Object.keys(ACTIVATED_ABILITIES);
}

/** A permanent `playerIndex` controls that could be activated right now, found by
 *  instanceId across all three zones an activatable thing can sit in. Shared by
 *  the validator and the executor so "can I?" and "do it" can't disagree about
 *  where things are. */
export function findActivatable(
  state: GameState,
  playerIndex: 0 | 1,
  instanceId: string,
): { card: UnitInstance | GearInstance | LegendInstance; definition: ActivatedAbilityDefinition } | undefined {
  const actor = state.players[playerIndex];
  // The LEGEND is a fourth place an activatable thing sits, and it is not on the
  // board at all — it has its own zone. Two of the three OGN preset legends have
  // an exhaust ability, and while this list held only the board zones they were
  // unreachable rather than merely unimplemented: no action could name them.
  const candidates: (UnitInstance | GearInstance | LegendInstance)[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    actor.legend,
  ];
  const card = candidates.find((c) => c.instanceId === instanceId);
  if (!card) return undefined;
  const definition = ACTIVATED_ABILITIES[card.defId];
  return definition ? { card, definition } : undefined;
}

/** Exhausts the activated permanent, wherever it lives. The exhaust IS the cost
 *  (rule: an exhaust symbol in a cost line), so this runs whether or not the
 *  effect ends up doing anything — a fizzled target does not refund it. */
export function exhaustActivated(state: GameState, playerIndex: 0 | 1, instanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  const exhaust = <T extends { instanceId: string; exhausted: boolean }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, exhausted: true } : c;

  players[playerIndex] = {
    ...actor,
    baseUnits: actor.baseUnits.map(exhaust),
    activeGear: actor.activeGear.map(exhaust),
    // The legend zone. Missing it made a Legend ability free and repeatable
    // within a turn — the cost was silently not paid, which is the worst shape
    // of bug here because the effect still happened.
    legend: exhaust(actor.legend),
  };

  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    if (!mine) return bf;
    return { ...bf, units: { ...bf.units, [actor.id]: mine.map(exhaust) } };
  });

  return { ...state, players, battlefields };
}

/** Heimerdinger - Inventor: "I have all :rb_exhaust: abilities of all friendly
 *  legends, units, and gear." He has no ability of his own; he has everyone
 *  else's. */
const HEIMERDINGER_INVENTOR = "OGN-111";

/**
 * Every ability `source` can be used to activate right now, as (abilityDefId,
 * definition) pairs.
 *
 * Almost always exactly one — the source's own. Heimerdinger is the exception,
 * and the reason this is a list rather than a lookup: he offers every activated
 * ability any friendly permanent has, with himself as the source.
 *
 * Rule 416.1 decides whose exhaust pays: "In abilities, the Exhaust symbol
 * represents the cost 'Exhaust this' or **'Exhaust me'**." He HAS the ability, so
 * the exhaust is his — which also means the card he borrowed it from can be
 * exhausted already and it makes no difference.
 */
export function abilitiesAvailableTo(
  state: GameState,
  playerIndex: 0 | 1,
  source: { defId: string },
): { abilityDefId: string; definition: ActivatedAbilityDefinition }[] {
  if (source.defId === HEIMERDINGER_INVENTOR) {
    const actor = state.players[playerIndex];
    const friendly = [
      actor.legend,
      ...actor.baseUnits,
      ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
      ...actor.activeGear,
    ];
    // Deduplicated: two copies of the same gear grant one ability, not two
    // identical entries the board would render twice.
    const defIds = [...new Set(friendly.map((c) => c.defId).filter((defId) => defId in ACTIVATED_ABILITIES))];
    return defIds.map((abilityDefId) => ({ abilityDefId, definition: ACTIVATED_ABILITIES[abilityDefId]! }));
  }
  const own = ACTIVATED_ABILITIES[source.defId];
  const granted: { abilityDefId: string; definition: ActivatedAbilityDefinition }[] = [];
  // Forge of the Fluft — "while you control this battlefield, friendly LEGENDS
  // have ...". Offered here rather than by a new registry for the reason
  // Heimerdinger is: this function is the single answer to "what can this source
  // activate", and the enumerator, the validator and the executor all come
  // through it. A parallel path would be a fourth place to keep in step.
  if (source.defId === state.players[playerIndex].legend.defId && controlsForgeOfTheFluft(state, playerIndex)) {
    granted.push({ abilityDefId: FORGE_OF_THE_FLUFT, definition: ACTIVATED_ABILITIES[FORGE_OF_THE_FLUFT]! });
  }
  return own ? [{ abilityDefId: source.defId, definition: own }, ...granted] : granted;
}

/** Does this player CONTROL a Forge of the Fluft right now? Controller-scoped
 *  rather than positional — the ability is about the Legend, who is in no
 *  location at all, so `at()` has nothing to be asked about. */
function controlsForgeOfTheFluft(state: GameState, playerIndex: 0 | 1): boolean {
  const playerId = state.players[playerIndex]?.id;
  return playerId !== undefined && state.battlefields.some((bf) => bf.controllerId === playerId && bf.defId === FORGE_OF_THE_FLUFT);
}

/** Does this card offer anything to activate — its own ability or borrowed ones? */
export function hasAnyActivatableAbility(state: GameState, playerIndex: 0 | 1, source: { defId: string }): boolean {
  return abilitiesAvailableTo(state, playerIndex, source).length > 0;
}

/**
 * The source and ability one ActivateAbility action names, or undefined if the
 * pairing is not real.
 *
 * The single answer to "what is this action actually doing", shared by the
 * validator, the executor and the enumerator — the three places that have drifted
 * apart before in exactly this codebase.
 */
export function resolveActivation(
  state: GameState,
  playerIndex: 0 | 1,
  permanentInstanceId: string,
  viaAbilityDefId?: string,
): { card: UnitInstance | GearInstance | LegendInstance; abilityDefId: string; definition: ActivatedAbilityDefinition } | undefined {
  const actor = state.players[playerIndex];
  const source = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    actor.legend,
  ].find((c) => c.instanceId === permanentInstanceId);
  if (!source) return undefined;

  const available = abilitiesAvailableTo(state, playerIndex, source);
  const chosen = viaAbilityDefId === undefined ? available[0] : available.find((a) => a.abilityDefId === viaAbilityDefId);
  // A borrowed ability must still be one this source really offers — naming an
  // arbitrary defId must not let anyone activate a card they do not control.
  if (!chosen) return undefined;
  return { card: source, ...chosen };
}

/** For coverage.ts — Heimerdinger's whole printed text is implemented by the
 *  borrowing above, and he appears in no ability registry of his own. */
export function borrowedAbilityDefIds(): string[] {
  return [HEIMERDINGER_INVENTOR];
}

/** The synthetic id a non-modal ability's single mode carries. Never appears on
 *  an action, since enumeration omits `modeId` when there is only one. */
const SOLE_MODE = "";

/**
 * Every ability, as a list of modes.
 *
 * A plain ability becomes one unnamed mode built from its own targeting and
 * resolve, so enumeration, validation and execution never branch on "is this
 * modal" — they were three places that would each have needed the same new
 * branch, and three places is how a mechanic ends up working in two of them.
 */
export function modesOf(abilityDefId: string): readonly AbilityMode[] {
  const definition = ACTIVATED_ABILITIES[abilityDefId];
  if (!definition) return [];
  if (definition.modes) return definition.modes;
  if (!definition.resolve) return [];
  return [
    {
      id: SOLE_MODE,
      label: "",
      targeting: definition.targeting ?? { kind: "none" },
      ...(definition.attachesEquipment ? { attachesEquipment: definition.attachesEquipment } : {}),
      resolve: definition.resolve,
    },
  ];
}

/** The modes still available to `source` right now — all of them, unless the
 *  ability is "one you've not chosen this turn". */
export function availableModes(
  abilityDefId: string,
  /** Only a Unit carries the per-turn record — a Legend or Gear simply has none
   *  to spend, which reads as "nothing used yet" and is correct: no modal
   *  ability in this pool sits on either. */
  source: { abilityModesUsedThisTurn?: string[] } | object,
): readonly AbilityMode[] {
  const modes = modesOf(abilityDefId);
  if (!ACTIVATED_ABILITIES[abilityDefId]?.modesOncePerTurn) return modes;
  const used = new Set("abilityModesUsedThisTurn" in source ? (source.abilityModesUsedThisTurn ?? []) : []);
  return modes.filter((m) => !used.has(m.id));
}

/** The mode an action names, checked against what is actually still available. */
export function resolveMode(
  abilityDefId: string,
  source: { abilityModesUsedThisTurn?: string[] } | object,
  modeId: string | undefined,
): AbilityMode | undefined {
  const available = availableModes(abilityDefId, source);
  return modeId === undefined ? available.find((m) => m.id === SOLE_MODE) : available.find((m) => m.id === modeId);
}

/** Does this ability track its modes per turn? */
export function tracksModeUse(abilityDefId: string): boolean {
  return ACTIVATED_ABILITIES[abilityDefId]?.modesOncePerTurn === true;
}

/** Records that `modeId` has been used, so "you've not chosen this turn" holds. */
export function recordModeUsed(state: GameState, playerIndex: 0 | 1, instanceId: string, modeId: string): GameState {
  const remember = <T extends { instanceId: string; abilityModesUsedThisTurn?: string[] }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, abilityModesUsedThisTurn: [...(c.abilityModesUsedThisTurn ?? []), modeId] } : c;

  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  players[playerIndex] = { ...actor, baseUnits: actor.baseUnits.map(remember) };
  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    return mine ? { ...bf, units: { ...bf.units, [actor.id]: mine.map(remember) } } : bf;
  });
  return { ...state, players, battlefields };
}
