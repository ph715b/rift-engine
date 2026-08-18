import type { GameState } from "../model/game-state.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { opponentNearVictory } from "./constants.js";
import { legionActive } from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { MIGHTY_THRESHOLD } from "./constants.js";
import { firstGearDiscountFor, repeatEnergyDiscountFor } from "./battlefield-continuous.js";
import type { UnitInstance } from "../model/card.js";
import { isMechUnit } from "./equipment.js";
import { deflectSurchargeForTargets } from "./granted-keywords.js";
import { COMPANION_TAGS } from "./constants.js";

/** Every unit a player controls, each with the MightContext its location
 *  implies — a base unit has no battlefield id, so a positional aura resolves it
 *  as "base". Written out here because Sky Splitter is the first COST that has
 *  to read effective Might, and cost time is before any target is chosen. */
function ownUnitsWithLocation(
  state: GameState,
  playerIndex: 0 | 1,
): { unit: UnitInstance; ctx: { isCombat: false; battlefieldId?: string } }[] {
  const owner = state.players[playerIndex];
  return [
    ...owner.baseUnits.map((unit) => ({ unit, ctx: { isCombat: false as const } })),
    ...state.battlefields.flatMap((bf) =>
      (bf.units[owner.id] ?? []).map((unit) => ({ unit, ctx: { isCombat: false as const, battlefieldId: bf.id } })),
    ),
  ];
}

/**
 * Cross-cutting cost modifiers — checked at every cost-computation call
 * site (validate-play-card.ts, legal-actions.ts, execute-play-card.ts's
 * float-deduction math), same choke-point convention as damage-modifiers.ts.
 * Deliberately narrow (one confirmed card) rather than a general modifier-
 * stacking system.
 */
/** Eager Apprentice: "While I'm at a battlefield, the Energy costs for spells
 *  you play is reduced by 1, to a minimum of 1." Battlefield presence only — a
 *  base-zone Eager Apprentice does not apply (unlike Annie - Fiery's
 *  base-or-battlefield damage modifier). */
const EAGER_APPRENTICE = "OGN-084";

/** Rhasa the Sunderer: "I cost 1 Energy less for each card in your trash." A
 *  self-scaling cost rather than a modifier on other cards — the only one of its
 *  shape in the pool, which is why it keys off the card being played rather than
 *  off the board. */
const RHASA_THE_SUNDERER = "OGN-195";

/** Sky Splitter: "This spell's Energy cost is reduced by the highest Might among
 *  units you control." Self-scaling off the BOARD rather than off a zone — the
 *  same shape as Rhasa above, reading the biggest body instead of a trash — and
 *  it reads EFFECTIVE Might, so an aura or a this-turn pump makes the spell
 *  cheaper. Printed at 8 Energy, so it is a dead card on an empty board and free
 *  behind an 8-Might unit. */
const SKY_SPLITTER = "OGN-014";

/**
 * `[Legion] — I cost N less.` (Noxus Hopeful)
 *
 * Handled as a RULE rather than as a per-card branch, because it already is
 * one: `card-loader.ts` derives `legionDiscount` from the printed text of every
 * card, so the discount is data the definition carries and any future
 * "[Legion] — I cost N less" card works with no edit here. That is the opposite
 * choice from the two hardcoded ids above, and it earns it — those two are
 * genuinely bespoke sentences, this is a keyword with a number.
 *
 * Cost time, so `countingSelf: false`: the card being priced has not been played
 * yet, and "another card" is any one card.
 */
function legionDiscountFor(state: GameState, playerIndex: 0 | 1, defId: string | undefined): number {
  if (defId === undefined) return 0;
  const def = defaultCardRegistry().tryGet(defId);
  const discount = def && "legionDiscount" in def ? def.legionDiscount : 0;
  if (discount <= 0) return 0;
  return legionActive(state, playerIndex, false) ? discount : 0;
}

/** Every card whose printed `[Legion] — I cost N less` this module implements.
 *  Derived from the pool rather than listed, for the same reason the discount
 *  itself is: a hand-kept list would drift the first time a card was added. */
function legionDiscountDefIds(): string[] {
  return defaultCardRegistry()
    .all()
    .filter((def) => "legionDiscount" in def && def.legionDiscount > 0)
    .map((def) => def.id);
}

/**
 * Find Your Center: "If an opponent's score is within 3 points of the Victory
 * Score, this costs 2 Energy less."
 *
 * The same comeback clause Leona - Zealot's enter-ready half reads, and asked
 * through the same shared predicate so the two can never disagree about what
 * "within 3" means. Its own half — draw 1 and channel 1 — is in effects/calm.ts;
 * only the cost can live here, because a cost has to be known before the card is
 * paid for.
 */
const FIND_YOUR_CENTER = "OGN-047";
const FIND_YOUR_CENTER_DISCOUNT = 2;

/** Monch — "If an opponent controls a stunned unit, I cost [2] less and enter
 *  ready." Two halves in two files; see `conditionalEntersReady` for the other. */
const MONCH = "UNL-035";
const MONCH_DISCOUNT = 2;

/** Keeper of Law (VEN-119): "I cost [2 Energy][Order] less if you control a
 *  battlefield with exactly two units there." Vendetta's first cost modifier,
 *  and the second card in the pool after Master Yi to discount BOTH axes. */
const KEEPER_OF_LAW = "VEN-119";
const KEEPER_OF_LAW_ENERGY = 2;
/** One `[Order]` pip. Named rather than a bare 1 beside the Energy figure, since
 *  the two are different currencies and reading them as a pair is the mistake. */
const KEEPER_OF_LAW_POWER = 1;
const KEEPER_OF_LAW_UNITS = 2;

/**
 * Does `playerIndex` control a battlefield with EXACTLY two units at it?
 *
 * Shared by Keeper of Law's two halves — the Energy branch in
 * `modifiedEnergyCost` and the Power one in `scaledPowerDiscount` — so a card
 * discounted on one axis can never fail to be discounted on the other. Monch's
 * predicate above exists for the same reason across two different modules, and
 * Master Yi's tier is shared between the same two functions this one is.
 *
 * **"Two UNITS", not "two of yours".** No owner is printed, so 355.9.a.1's
 * widening applies and both players' units at that battlefield are counted — a
 * board where you and an opponent each have one there satisfies it, which is the
 * commonest way it is satisfied.
 *
 * **"A battlefield YOU CONTROL" is the narrowing half**, and it is what stops
 * this reading the whole board: standing at a battlefield is not controlling it
 * (`controllerId`), the same distinction Vayne - Hunter's enter-ready draws.
 *
 * EXACTLY two. Three is as dead as one, which is the Order motif this set is
 * built on and the boundary a test has to sit on in both directions.
 */
function keeperOfLawConditionMet(state: GameState, playerIndex: 0 | 1): boolean {
  const ownerId = state.players[playerIndex].id;
  return state.battlefields.some(
    (bf) =>
      bf.controllerId === ownerId &&
      Object.values(bf.units).reduce((n, units) => n + units.length, 0) === KEEPER_OF_LAW_UNITS,
  );
}

/** Does the OPPONENT of `playerIndex` control a stunned unit, anywhere? Shared
 *  by both of Monch's halves so the discount and the enter-ready can never
 *  disagree about the condition they are both reading. */
export function opponentControlsStunnedUnit(state: GameState, playerIndex: 0 | 1): boolean {
  const foe = state.players[playerIndex === 0 ? 1 : 0];
  return [...foe.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[foe.id] ?? [])].some((u) => u.stunned);
}

/** Spoils of War: "If an enemy unit has died this turn, this costs 2 Energy
 *  less." Read from the OPPONENT's `unitsLostThisTurn`, which the death funnel
 *  bumps — a replaced or warded death never reaches it, and neither should
 *  discount this. */
const SPOILS_OF_WAR = "OGN-144";
const SPOILS_OF_WAR_DISCOUNT = 2;

/**
 * Herald of Scales: "Your Dragons' Energy costs are reduced by :rb_energy_2:, to
 * a minimum of :rb_energy_1:."
 *
 * The first modifier here keyed off a card's TYPE LINE rather than its id or its
 * keyword — `CardDefinition.tags` already carries "Dragon" for the 8 cards that
 * are one, so this needs no new data. Keying off the tag rather than listing the
 * 8 ids is the same choice `legionDiscountFor` makes and for the same reason: a
 * hand-kept list drifts the first time the pool grows.
 *
 * **Not positional.** Eager Apprentice prints "while I'm at a battlefield" and is
 * therefore checked against battlefields only; Herald's text names no location,
 * so a Herald in base applies just as much. Two different sentences, two
 * different checks — reading them the same way is the mistake this comment
 * exists to prevent.
 *
 * **Two Heralds stack, to -4.** Continuous abilities are not keywords, so
 * 817.1.a's redundancy rule does not reach them; the precedent in this codebase
 * is effective-might's Garen - Commander and Darius - Executioner, which
 * explicitly stack when both are present. The floor is per-card and applies once,
 * after the whole reduction.
 *
 * The floor is dead weight against today's pool — all 8 Dragons cost 5 or more
 * Energy, so nothing reaches it — and is written anyway because it is printed.
 */
const HERALD_OF_SCALES = "OGN-140";
const HERALD_DISCOUNT = 2;
const HERALD_FLOOR = 1;
const DRAGON_TAG = "Dragon";

/** How many Heralds this player controls, anywhere — base and battlefields, since
 *  the card names no location. */
function heraldCount(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  const atBattlefields = state.battlefields.reduce(
    (sum, bf) => sum + (bf.units[player.id] ?? []).filter((u) => u.defId === HERALD_OF_SCALES).length,
    0,
  );
  return player.baseUnits.filter((u) => u.defId === HERALD_OF_SCALES).length + atBattlefields;
}

/**
 * Concentrate — "[Level 6][>] This costs [2] less. [Level 11][>] This costs [4]
 * less INSTEAD."
 *
 * **"Instead" is the whole subtlety and it is why these are a tiered lookup
 * rather than two independent reductions.** The deeper tier REPLACES the
 * shallower one, so a player at 11+ XP gets -4, not -6. `[Level]`'s own rule
 * (824) makes each clause active while the XP threshold is met, which without
 * the printed "instead" would leave both active at once.
 *
 * Read off `PlayerState.xp` through `state`, which `modifiedEnergyCost` already
 * takes — this needed no new plumbing, only a row. The card's draw half has been
 * written since wave 3 in effects/mind.ts; this closes it.
 */
const CONCENTRATE = "UNL-091";
/** Highest tier first, so the lookup below returns the deepest one that applies
 *  — which is exactly what "instead" means. */
const CONCENTRATE_TIERS: readonly { readonly xp: number; readonly discount: number }[] = [
  { xp: 11, discount: 4 },
  { xp: 6, discount: 2 },
];

/**
 * Master Yi - Unstoppable's three `[Level]` cost tiers — "[Level 3] I cost
 * [2][Calm] less. [Level 6] I cost [4][Calm][Calm] less INSTEAD. [Level 11] I
 * cost [6][Calm][Calm][Calm] less INSTEAD."
 *
 * Concentrate's table above is the same shape and the same "instead" reading:
 * highest tier first, `find` returns the deepest that applies, so a player at 11
 * XP gets -6 and never also -4. 824 makes each clause active once its threshold
 * is met, which without the printed "instead" would stack all three.
 *
 * **What is new is that this one discounts BOTH halves of a cost.** Concentrate
 * is Energy-only, so a single number sufficed and it could live entirely inside
 * `modifiedEnergyCost`. Yi's tiers move Energy AND Power together, and those are
 * computed by two different functions — so the tier is chosen by ONE helper that
 * both call, rather than by two `find`s that could drift apart at the boundary.
 * Two independent lookups is exactly how a card ends up -6 Energy but only
 * -2 Power at 11 XP, and nothing in either function would look wrong.
 *
 * His fourth clause, `[Level 16]`'s "I can't be chosen by enemy spells and
 * abilities", is not here — it is a `UNCHOOSEABLE_BY_ENEMIES` row in
 * target-lookup.ts and has worked since it landed.
 */
const MASTER_YI_UNSTOPPABLE = "UNL-059";
const MASTER_YI_TIERS: readonly { readonly xp: number; readonly energy: number; readonly power: number }[] = [
  { xp: 11, energy: 6, power: 3 },
  { xp: 6, energy: 4, power: 2 },
  { xp: 3, energy: 2, power: 1 },
];

/** The deepest `[Level]` tier this player has reached, or undefined below 3 XP.
 *  The single reader of `MASTER_YI_TIERS`, so the Energy and Power halves of one
 *  play can never come from different tiers. */
function masterYiTier(
  state: GameState,
  playerIndex: 0 | 1,
): { readonly xp: number; readonly energy: number; readonly power: number } | undefined {
  return MASTER_YI_TIERS.find((t) => state.players[playerIndex].xp >= t.xp);
}

/** Battering Ram — "I cost [1] less for each card you've played this turn, to a
 *  minimum of [1]." Both numbers are printed, so both are named. */
const BATTERING_RAM = "SFD-012";
const BATTERING_RAM_MINIMUM = 1;

/** Jaull-Fish — "I cost [2] less for each of your [Mighty] units." */
const JAULL_FISH = "SFD-103";
const JAULL_FISH_DISCOUNT = 2;

/** Production Surge — "This costs [2] less if you control a Mech." */
const PRODUCTION_SURGE = "SFD-076";
const PRODUCTION_SURGE_DISCOUNT = 2;

/** The printed tribe tag, shared with granted-keywords.ts's four Mech auras. */
const MECH_TAG = "Mech";

/** Does this player control a Mech? Asked of the DEFINITION's printed tag, which
 *  is what `granted-keywords.isMech` asks and what the Mech token carries. */
function controlsAMech(state: GameState, playerIndex: 0 | 1): boolean {
  // Through `isMechUnit`, which reads the instance's tags and adds any GRANTED
  // by an attached Equipment (Experimental Hexplate's "I am a Mech"). The
  // instance is the right thing to ask for a unit in play: a TOKEN has no
  // definition at all, which is why the Mech token carries the tag itself, and a
  // granted tag exists nowhere but the board.
  return ownUnitsWithLocation(state, playerIndex).some(({ unit }) => isMechUnit(state, unit));
}

function isDragon(defId: string | undefined): boolean {
  if (defId === undefined) return false;
  const def = defaultCardRegistry().tryGet(defId);
  // Narrowed, not asserted: `tags` lives on Unit/Spell/Gear and NOT on
  // LegendDefinition, so reading it straight off the union is `undefined` at
  // runtime for a Legend — which threw on every priced card rather than just on
  // Legends, because this is asked for all of them. The compiler says the same
  // thing; `legionDiscountFor` above already narrows for exactly this reason.
  return def !== undefined && "tags" in def && def.tags.includes(DRAGON_TAG);
}

/**
 * Irelia - Graceful — "Your spells that CHOOSE me cost [1] or [rainbow] less."
 *
 * The pool's first cost modifier keyed on the TARGET rather than on the card
 * being played, which is why it cannot live in `modifiedEnergyCost` above: that
 * function prices a card from its defId, and this price is not a property of the
 * card at all. Two spells of the same name have different costs depending on
 * what they point at.
 *
 * **"YOUR spells"** — her controller's, so an opponent's removal aimed at her is
 * not discounted. Measured from her owner exactly as `deflectSurcharge` is, and
 * for the same reason: the two are the same kind of target-keyed price question
 * pointing in opposite directions.
 *
 * **"[1] OR [rainbow]"** is a genuine choice between two axes, not a single
 * reduction that happens to be writable two ways. A player short of Energy wants
 * the Energy pip; one short of runes wants the Power pip. Neither default is
 * safe, so the axis rides the action as `targetDiscountAxis` and the enumerator
 * fans out both — the same shape `acceleratePaid` and `optionalPowerPaid` take,
 * and for the same reason those are on the action rather than inferred.
 *
 * Counted ONCE however many of her the spell chooses: it is her ability, not a
 * per-choice tax, which is the opposite of `[Deflect]`'s explicit per-target
 * summation. Two Irelias would be two separate sources and are not modelled —
 * she is a Champion, one to a board in practice.
 */
const IRELIA_GRACEFUL = "SFD-141";
const IRELIA_GRACEFUL_DISCOUNT = 1;

/**
 * How much a play's chosen targets take off its cost, split by axis.
 *
 * ONE function for the validator, the executor and the enumerator, because all
 * three price the same play and this codebase's most-repeated bug is two of them
 * disagreeing — the executor re-derives from the raw cost rather than trusting
 * the validator (see its `ignoresBaseCost` comment for the last time that
 * mattered), so a discount applied in only one of the two silently overspends
 * floating resources.
 *
 * Takes the id list `chosenUnitsOfPlay` builds, for the reason that helper
 * exists: listing the fields that can name a unit by hand got `[Deflect]` wrong
 * across five cards.
 */
/**
 * Ezreal - Prodigy — "Optional additional costs you pay cost [1] or [rainbow]
 * less."
 *
 * The same "or" as Irelia - Graceful's, so it shares her axis field rather than
 * adding a second one — and that sharing is a recorded SIMPLIFICATION rather
 * than an identity: with both effects live at once, one axis is chosen for both
 * discounts instead of one each. The alternative is a second fan-out axis on
 * every play in the game to separate two cards that rarely meet, and the
 * coupling can only ever cost the caster a pip they would have preferred
 * elsewhere — never let an illegal play through.
 *
 * **It discounts the ADDITIONAL cost, not the card's own**, which is why it is
 * applied to the optional-cost TERM at each cost site rather than to the printed
 * cost: an Accelerate paid under Ezreal is 1 pip cheaper, and the unit's own
 * price is untouched.
 *
 * **And it lands as the cost is ADDED, before anything that reduces the card's
 * TOTAL.** That ordering is not a preference here, it is the shape of the two
 * cost sites: `discountedOptionalCosts` produces a floored term which is then
 * ADDED to whatever `modifiedEnergyCost` made of the printed cost, and only the
 * sum is handed to `computeEffectiveCost` for floating Energy/Power to eat. So
 * every whole-card modifier (Eager Apprentice's minimum of 1, Vex's floor,
 * Herald's floor) clamps the printed cost alone and can never claw back a pip
 * Ezreal took off an additional cost, and float — the one thing that does reduce
 * a TOTAL — is applied strictly afterwards.
 *
 * Floored per axis at each site, so it can never turn an addition into a refund.
 *
 * **All FOUR optional additional costs, as of the 2026-08-08 playtest report.**
 * It shipped reaching only `[Accelerate]` and the `OPTIONAL_POWER_COSTS` table —
 * and reaching neither of those in a real game, because the axis it rides was
 * refused outright by a guard that asked only whether Irelia had been chosen, and
 * because the enumerator emitted the axis only from her branch. Every measurement
 * this card had called `optionalCostDiscount` directly and was green throughout.
 * `[Repeat]` is the case the report named and 820 calls it "an Optional
 * Additional Cost keyword" by name; Temporal Portal's granted instance is one for
 * the same reason.
 */
const EZREAL_PRODIGY = "SFD-149";
const EZREAL_DISCOUNT = 1;

/** Is Ezreal - Prodigy in play for this player? His clause is unpositioned — it
 *  names no battlefield — so base counts.
 *
 *  Asked without an axis by the enumerator, which needs to know whether to fan a
 *  variant out by axis at all before it knows which axis is worth pricing. */
export function optionalCostDiscountApplies(state: GameState, playerIndex: 0 | 1): boolean {
  return optionalCostDiscount(state, playerIndex, "energy").energy > 0;
}

export function optionalCostDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  axis: "energy" | "power" | undefined,
): { energy: number; power: number } {
  const none = { energy: 0, power: 0 };
  if (axis === undefined) return none;
  const owner = state.players[playerIndex];
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  if (!units.some((u) => u.defId === EZREAL_PRODIGY)) return none;
  return axis === "energy" ? { energy: EZREAL_DISCOUNT, power: 0 } : { energy: 0, power: EZREAL_DISCOUNT };
}

/** The three buckets a play's optional additional costs land in. Rainbow is its
 *  own bucket for the reason `RepeatCostSpec` gives one: Danger Zone's `[Repeat]`
 *  pip is not domain-checked, and folding it into `power` would price it against
 *  the card's own domain. */
export interface AdditionalCostBundle {
  energy: number;
  power: number;
  rainbow: number;
}

/**
 * A play's OPTIONAL ADDITIONAL costs after Ezreal - Prodigy's reduction — the ONE
 * function the enumerator and the validator both price with.
 *
 * Its own entry point beside `modifiedRepeatEnergy` rather than a branch inside
 * `modifiedEnergyCost`, for the reason that pair already records: this reduces
 * the additional-cost term 356.2 adds BESIDE the printed cost, and the term is
 * three components a single number cannot carry.
 *
 * **Once per QUALIFYING OPTIONAL ADDITIONAL COST, not once per play** —
 * project-owner ruling, 2026-08-08, which settles the question this function's
 * previous comment left open in favour of the distributive reading. The
 * reduction "applies to the optional additional cost itself as soon as that cost
 * is added, before discounts that apply to the card's total cost", so a play
 * paying two separate optional additional costs gets two separate pips off. Never
 * twice against the SAME cost, never against a mandatory one, and never against
 * the card's own printed cost.
 *
 * Hence a LIST rather than one summed bundle: the caller decides what counts as a
 * cost, because only the caller knows which flags the action set. An entry that
 * is all zeros is harmless — there is no shared budget for it to consume — which
 * is why 356.4.f.1's "it doesn't matter how much the player actually paid" needs
 * no separate `paying` flag any more. The callers gate each entry on its own flag,
 * which is the same thing said in the place that knows it.
 *
 * The MANDATORY exclusion is structural rather than a check here: the only
 * additional costs with an Energy or Power pip in this pool are
 * `OPTIONAL_POWER_COSTS`, `[Accelerate]` and the two `[Repeat]` instances, and
 * every one of them prints "you may". The mandatory ones (Cruel Patron's kill,
 * Legion Quartermaster's bounce, Stalking Wolf's kill) are paid with a permanent
 * and carry `UnitCostSpec.mandatory` — nothing this function could reduce, and no
 * caller passes them.
 *
 * **The `[rainbow]` axis spends on the DOMAINED pip before the rainbow one.**
 * Whose pip it comes off is the player's choice and both save exactly one rune,
 * so the tie is broken in the direction that is never worse: a remaining rainbow
 * pip accepts any rune, a remaining domained pip does not.
 */
export function discountedOptionalCosts(
  state: GameState,
  playerIndex: 0 | 1,
  axis: "energy" | "power" | undefined,
  costs: readonly AdditionalCostBundle[],
): AdditionalCostBundle {
  const discount = optionalCostDiscount(state, playerIndex, axis);
  const total = { energy: 0, power: 0, rainbow: 0 };
  for (const raw of costs) {
    // Floored per cost and per axis, so a pip can never turn one addition into a
    // refund that offsets another — which is the whole reason this sums AFTER
    // discounting rather than discounting a sum.
    const power = Math.max(0, raw.power - discount.power);
    // Whatever of the [rainbow] pip the domained Power did not absorb.
    const spentOnPower = raw.power - power;
    total.energy += Math.max(0, raw.energy - discount.energy);
    total.power += power;
    total.rainbow += Math.max(0, raw.rainbow - (discount.power - spentOnPower));
  }
  return total;
}

export function targetChoiceDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  chosenInstanceIds: readonly (string | undefined)[],
  axis: "energy" | "power" | undefined,
): { energy: number; power: number } {
  const none = { energy: 0, power: 0 };
  if (axis === undefined) return none;
  const owner = state.players[playerIndex];
  const chosen = new Set(chosenInstanceIds.filter((id): id is string => id !== undefined));
  // Her OWN controller's board only — "your spells that choose me" is a sentence
  // about her side casting, so she is looked up under `playerIndex`.
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  const chosenIrelia = units.some((u) => u.defId === IRELIA_GRACEFUL && chosen.has(u.instanceId));
  if (!chosenIrelia) return none;
  return axis === "energy"
    ? { energy: IRELIA_GRACEFUL_DISCOUNT, power: 0 }
    : { energy: 0, power: IRELIA_GRACEFUL_DISCOUNT };
}

/**
 * Jayce - Man of Progress — "you may play a gear with Energy cost no more than
 * [7] from hand this turn, ignoring its Energy cost."
 *
 * A PERMISSION rather than a play: every other "ignoring its cost" in this pool
 * happens as the granting card resolves, and this one is a window that stays
 * open. It therefore lives on `PlayerState.freeGearPlaysThisTurn` and is read
 * here, at the one place a card's Energy is priced.
 *
 * **The Energy only.** His reminder text says it out loud — "(You must still pay
 * its Power cost.)" — so a Gear with a Power pip still owes it, which is why this
 * zeroes the Energy term rather than the whole cost the way `fromHidden` does.
 *
 * **Applied to the FIRST gear played, not to a chosen one.** The permission is
 * consumed by playing a gear at all rather than by naming which. That is a real
 * simplification of "you MAY play a gear", and it is safe in the only direction
 * that matters: free is never worse than paid, and the window expires with the
 * turn, so there is nothing a player could sensibly be saving it for. Recorded
 * in docs/rules-conformance.md.
 */
const JAYCE_MAX_FREE_GEAR_ENERGY = 7;

/**
 * Void Drone and Drag Under — "I cost [2] less to play from anywhere other than
 * your hand."
 *
 * **Currently unreachable, and that is a fact about the ENGINE rather than about
 * these two cards.** Measured rather than assumed: there are exactly three
 * places a card can be played from here — hand, the Champion Zone, and facedown
 * at a battlefield — and of the two non-hand ones, a from-Hidden play already
 * prices at `{ energyCost: 0, powerCost: 0 }` (811, and `validate-play-card`
 * applies it before any modifier runs), while the Champion Zone can hold only
 * the one set-aside CHAMPION. Void Drone prints no Champion supertype and Drag
 * Under is a Spell, so neither can ever be there. Every other "play from
 * elsewhere" in the pool routes through `playCardIgnoringCost`, which bypasses
 * pricing entirely.
 *
 * So the rule is written where costs live, and it will start paying out the day
 * the engine gains a full-cost play from a non-hand zone. It is NOT recorded as
 * a partial: nothing about the card's text is missing, and the note would name
 * missing engine, which this repo's definition of done forbids.
 *
 * Passed the source explicitly rather than deriving it from state, because the
 * only state-derivable answer is "is a card with this defId in the Champion
 * Zone", which is wrong for a deck running further copies in the main deck.
 */
/**
 * Needlessly Large Yordle — "I cost [2][Calm] less for each point you scored
 * FROM HOLDING this turn."
 *
 * **It reduces BOTH axes, which is why it cannot live in `modifiedEnergyCost`
 * alone.** Two Energy AND one Calm Power come off per point, and that function
 * returns an Energy figure. So the Energy half is applied there and the Power
 * half is a separate term at each cost site — the same split Irelia - Graceful's
 * `targetChoiceDiscount` already takes, and it returns the same shape for the
 * same reason.
 *
 * "From HOLDING" is the method, not the total: a point from conquering is a
 * different sentence and `pointsFromHoldingThisTurn` counts only the one.
 *
 * Printed at 10 Energy and 3 Power, so it is a dead card on turn one and free
 * behind five held points — which is the card.
 */
const NEEDLESSLY_LARGE_YORDLE = "SFD-055";
const YORDLE_ENERGY_PER_POINT = 2;
const YORDLE_POWER_PER_POINT = 1;

/** The POWER half of Needlessly Large Yordle's discount. The Energy half is in
 *  `modifiedEnergyCost`; this is what the three cost sites subtract from the
 *  printed Power, and it is one function so they cannot disagree. */
export function scaledPowerDiscount(state: GameState, playerIndex: 0 | 1, defId: string | undefined): number {
  if (defId === NEEDLESSLY_LARGE_YORDLE) {
    return state.players[playerIndex].pointsFromHoldingThisTurn * YORDLE_POWER_PER_POINT;
  }
  // Master Yi's [Level] tiers, POWER half — the Energy half is the matching
  // branch in `modifiedEnergyCost`, and both take the tier from `masterYiTier`
  // so they cannot disagree about which one applies.
  if (defId === MASTER_YI_UNSTOPPABLE) {
    return masterYiTier(state, playerIndex)?.power ?? 0;
  }
  // Keeper of Law's POWER half — one `[Order]` pip off his printed one, so a
  // satisfied condition makes him free of Power entirely. The ENERGY half is the
  // matching branch in `modifiedEnergyCost`; both ask one predicate.
  if (defId === KEEPER_OF_LAW && keeperOfLawConditionMet(state, playerIndex)) {
    return KEEPER_OF_LAW_POWER;
  }
  return 0;
}

/**
 * Atakhan — "You may kill a friendly unit as an additional cost to play me. If
 * you do, I cost [1] less for each Energy it costs and [Order] less for each
 * Power it costs."
 *
 * The pool's first additional cost whose DISCOUNT is a function of what was
 * spent. Every other one is a fixed number: Commander Ledros and Kraken Hunter
 * buy a flat 1 Power per unit spent (`repeatable`), Call to Glory zeroes the
 * cost outright (`ignoresCostWhenPaid`). This one scales with the killed unit's
 * printed cost, on BOTH axes at once, so it is neither.
 *
 * # Read off the COST, not the body
 *
 * "For each Energy it COSTS" is the killed unit's cost — the same reading
 * Heedless Resurrection's ceiling takes, and the rules' Defy example ("always
 * uses its printed or copied cost"). So a pumped, damaged or buffed unit is
 * worth exactly what it costs as a sacrifice; nothing about the body it has
 * become on the board enters into it.
 *
 * A TOKEN carries 0 on both axes and therefore discounts nothing, which is the
 * right answer for a body with no printed cost.
 *
 * # Per VARIANT, not per card
 *
 * The size depends on WHICH unit is named, so it cannot be folded into
 * `modifiedEnergyCost` the way a board-keyed discount is: the same Atakhan is a
 * different price under each variant the enumerator emits. Both `legal-actions`
 * and `validate-play-card` therefore call this with the choice riding on the
 * action they are pricing, and both feed the result through
 * `computeEffectiveCost` rather than subtracting after it — the floating-Energy
 * bug that path already records having made once.
 */
const ATAKHAN = "UNL-170";

export function sacrificeCostDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string | undefined,
  costUnitInstanceId: string | undefined,
): { energy: number; power: number } {
  const none = { energy: 0, power: 0 };
  if (defId !== ATAKHAN || costUnitInstanceId === undefined) return none;

  const spent = ownUnitsWithLocation(state, playerIndex).find(({ unit }) => unit.instanceId === costUnitInstanceId);
  if (spent === undefined) return none;

  // **The INSTANCE's cost, not a registry lookup**, which is this repo's
  // convention for every "costing no more than" question — Glasc Mixologist's and
  // Undying Loyalty's trash ceilings both read `c.energyCost` off the instance.
  //
  // `UnitInstance` copies `energyCost`/`powerCost` from the definition when it is
  // created, so for a real card the two are the same number, and asking the
  // instance means this works for a unit whose definition is not in the registry
  // at all. A TOKEN carries 0 on both axes and so discounts nothing, which is the
  // right answer for a body with no printed cost.
  //
  // The first version looked the definition up and treated anything without one
  // as a token. That was equivalent for every real card and wrong for exactly the
  // case a wave-4 fixture had already built.
  return { energy: spent.unit.energyCost, power: spent.unit.powerCost };
}

/**
 * Undying Loyalty — "This costs [2] less if you CHOOSE a Bird, Cat, Dog, or
 * Poro."
 *
 * Priced off the TARGET, not the board, which is what kept it refused across
 * three waves: a cost has to be known when the card is paid for, and the card's
 * trash unit was named at RESOLUTION by a parked question. Moving that choice to
 * an announce-time target (355.4) is what made the discount expressible at all —
 * the missing piece was never a table.
 *
 * Reads the chosen card's own tags. A trash card is an instance, not a board
 * unit, so there is no equipment to grant it anything and nothing positional to
 * resolve — `effectiveTagsOf` would be the wrong question here, and the printed
 * tags are the whole answer.
 */
const UNDYING_LOYALTY = "UNL-168";
const UNDYING_LOYALTY_DISCOUNT = 2;

export function trashChoiceDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string | undefined,
  trashCardInstanceId: string | undefined,
): { energy: number; power: number } {
  const none = { energy: 0, power: 0 };
  if (defId !== UNDYING_LOYALTY || trashCardInstanceId === undefined) return none;

  const chosen = state.players[playerIndex].trash.find((c) => c.instanceId === trashCardInstanceId);
  // `CardInstance` is a union and only the Unit arm carries tags, so the narrow
  // is load-bearing. The card's own targeting spec is `cardKind: "Unit"` anyway,
  // so a non-Unit here means a hand-built action rather than a legal play.
  if (chosen === undefined || chosen.kind !== "Unit") return none;
  return COMPANION_TAGS.some((tag) => chosen.tags.includes(tag)) ? { energy: UNDYING_LOYALTY_DISCOUNT, power: 0 } : none;
}

/**
 * Every discount whose size depends on a CHOICE the play makes, summed.
 *
 * Two cards so far and they choose different things — Atakhan names a unit to
 * kill as an additional cost, Undying Loyalty names a card in its own trash as a
 * target — but both are priced the same way and at the same moment, so the two
 * pricing sites take one function rather than growing a branch per card.
 *
 * This is the seam that cannot be `modifiedEnergyCost`: that is computed once
 * per card, before any choice exists.
 */
export function variantCostDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string | undefined,
  choices: { additionalCostUnitInstanceId?: string; trashCardInstanceId?: string },
): { energy: number; power: number } {
  const sacrifice = sacrificeCostDiscount(state, playerIndex, defId, choices.additionalCostUnitInstanceId);
  const trash = trashChoiceDiscount(state, playerIndex, defId, choices.trashCardInstanceId);
  return { energy: sacrifice.energy + trash.energy, power: sacrifice.power + trash.power };
}

const PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS = new Set(["SFD-010", "SFD-164"]);
const PLAY_FROM_ELSEWHERE_DISCOUNT = 2;

/**
 * Vex - Cheerless — "While I'm in combat, friendly spells cost [1][rainbow] less
 * to a minimum of [1], and enemy spells cost [1][rainbow] more."
 *
 * The pool's first cost modifier that points BOTH WAYS at once, and the first
 * conditioned on a game state rather than on a board shape. Three things about it
 * are worth writing down, because each was a wrong first guess.
 *
 * **"In combat" is a STATE question here, not the event predicate.** The
 * handoff that scoped this card named `combat-designation.isFightingAt`, and that
 * function cannot answer it: it takes a `GameEvent` and asks whether a listener
 * was designated by THAT event. A cost is priced with no event in hand. The state
 * that survives the whole fight is the open Combat Showdown — `showdownKind` plus
 * `showdownBattlefieldId` — so "I'm in combat" is "I am standing at the
 * battlefield the open Combat Showdown is at".
 *
 * `designatedInstanceIds` was the rejected sharper alternative, and rejected for
 * the reason effects/fury.ts's Sudden Storm already records: it is written only by
 * a Cleanup, so a unit that walked in and started this very fight would read as
 * not being in it.
 *
 * **The two halves need two different mechanisms, and merging them would be
 * wrong.** The friendly half REDUCES the card's own Power, which is domain-
 * restricted and is what `powerCost` means. The enemy half is `[1][rainbow]` MORE
 * — a rainbow debt beside the card's own cost, which is exactly `[Deflect]`'s
 * shape, so it rides the same `rainbowRunes` bucket rather than inflating a
 * domained `powerCost` the card never printed. Adding it to `powerCost` would
 * demand the enemy pay the surcharge in the SPELL's domain, which is stricter
 * than printed and would refuse legal plays.
 *
 * **Two Vexes, one per side, cancel.** Counted as a signed swing rather than a
 * boolean for that reason: nothing in the rules makes her ability redundant with
 * an opponent's copy, and 817.1.a's redundancy rule reaches keywords, not
 * continuous abilities — the same reading `heraldCount` takes for two Heralds
 * stacking.
 *
 * The floor is on the ENERGY only, because that is what the card prints
 * (`to a minimum of :rb_energy_1:`); the Power reduction takes the shared clamp
 * at 0. Recorded in docs/rules-conformance.md.
 */
const VEX_CHEERLESS = "SFD-146";
const VEX_ENERGY_SWING = 1;
const VEX_POWER_SWING = 1;
const VEX_FRIENDLY_ENERGY_FLOOR = 1;

/**
 * Applied Researchers — "[Empowered][>] Your spells cost [1][rainbow] less, to a
 * minimum of [1]."
 *
 * **Vex - Cheerless's friendly half, with a different condition and no enemy
 * half.** The sentence is hers almost verbatim, including the floor, so this
 * reuses her constants and her clamp rather than restating either — the floor
 * especially, whose `max(min(cost, FLOOR), ...)` form exists because a spell
 * already priced BELOW 1 (a Hidden play, or one Sky Splitter zeroed) must not be
 * RAISED to 1 by a discount.
 *
 * Three differences from Vex, all of them the card's:
 *
 *   The condition is the Researchers' own Empowered STATUS (828.1.c, active "as
 *   long as"), not a board state — so it is per-object (441.1.a) and read off the
 *   instance, and two copies with one Empowered still discount.
 *
 *   **No enemy half**, so no rainbow surcharge and nothing in
 *   `rainbowSurchargeForPlay`. Her tax exists because her card prints one; this
 *   card does not.
 *
 *   Position is not asked. Her "while I'm in combat" is a location question; this
 *   text names no battlefield, so a Researcher in base discounts exactly as one at
 *   a battlefield does — the reading Rumble - Scrapper's and Dr. Mundo's
 *   unpositioned auras take.
 *
 * COUNTED rather than boolean, on Vex's own reasoning: nothing in the rules makes
 * a second copy redundant (817.1.a's redundancy rule reaches keywords, not
 * continuous abilities), so two Empowered Researchers discount twice.
 */
const APPLIED_RESEARCHERS = "VEN-055";

/** How many Empowered Applied Researchers this player controls, anywhere.
 *  Unpositioned, so base and battlefields both count. */
function empoweredResearchers(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  const atBattlefields = state.battlefields.reduce(
    (n, bf) => n + (bf.units[player.id] ?? []).filter((u) => u.defId === APPLIED_RESEARCHERS && u.empowered === true).length,
    0,
  );
  return player.baseUnits.filter((u) => u.defId === APPLIED_RESEARCHERS && u.empowered === true).length + atBattlefields;
}

/**
 * Vex's swing on a spell `playerIndex` is playing, measured from THEIR seat:
 * positive is a tax they owe, negative is a discount they get, zero is no Vex in
 * the fight.
 *
 * Spells only — her sentence names them twice and says nothing about a Unit or a
 * Gear, so the kind is checked here rather than at each call site.
 */
function vexSpellSwing(state: GameState, playerIndex: 0 | 1, cardKind: string): number {
  if (cardKind !== "Spell") return 0;
  if (state.showdownKind !== "Combat" || state.showdownBattlefieldId === null) return 0;
  const bf = state.battlefields.find((b) => b.id === state.showdownBattlefieldId);
  if (bf === undefined) return 0;
  const vexesOf = (index: 0 | 1): number =>
    (bf.units[state.players[index].id] ?? []).filter((u) => u.defId === VEX_CHEERLESS).length;
  return vexesOf(playerIndex === 0 ? 1 : 0) - vexesOf(playerIndex);
}

/** The POWER half of Vex's FRIENDLY discount — what the three cost sites take
 *  off the printed Power, beside `scaledPowerDiscount`. Her enemy half is not
 *  here: it is a rainbow surcharge, and `rainbowSurchargeForPlay` owns it. */
export function combatSpellPowerDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: string,
): number {
  // Applied Researchers' rainbow pip rides here with Vex's, because both are
  // REDUCTIONS of the spell's own Power rather than debts beside it — the
  // distinction her note draws, and the reason her ENEMY half is in
  // `rainbowSurchargeForPlay` instead.
  const researchers = cardKind === "Spell" ? empoweredResearchers(state, playerIndex) : 0;
  return Math.max(0, -vexSpellSwing(state, playerIndex, cardKind)) * VEX_POWER_SWING + researchers * VEX_POWER_SWING;
}

/**
 * Every rainbow Power a PLAY owes ON TOP of the card's own cost — the one
 * function the enumerator, the validator and the executor all ask.
 *
 * Two contributors today, and they are different KINDS of debt that happen to be
 * payable with the same rune: `[Deflect]` is keyed on the units the play chooses,
 * Vex - Cheerless's tax is keyed on the board. Summed here rather than at each
 * site for the reason `deflectSurchargeForTargets` gives for existing at all —
 * this file's most repeated bug is the enumerator offering a play the validator
 * then refuses, and a second surcharge added at four sites minus one is exactly
 * how that happens for a sixth time.
 *
 * Does NOT include `[Repeat]`'s own rainbow pip or Bullet Time's X. Those are
 * printed COSTS the action opts into, not surcharges the board imposes, and the
 * validator checks each against its own flag.
 */
export function rainbowSurchargeForPlay(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: string,
  chosenInstanceIds: readonly (string | undefined)[],
): number {
  return (
    deflectSurchargeForTargets(state, playerIndex, chosenInstanceIds) +
    Math.max(0, vexSpellSwing(state, playerIndex, cardKind)) * VEX_POWER_SWING
  );
}

/** Does `playerIndex` have a Jayce permission that this card can use? Asked
 *  identically by the validator, the executor and the enumerator — the three
 *  that must agree on a price. Reading it does NOT spend it; `execute-play-card`
 *  does that, the same split `nextUnitsEnterReady` keeps for the same reason. */
export function freeGearPlayApplies(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: "Unit" | "Spell" | "Gear" | "Legend",
  rawEnergyCost: number,
): boolean {
  return (
    cardKind === "Gear" &&
    state.players[playerIndex].freeGearPlaysThisTurn > 0 &&
    rawEnergyCost <= JAYCE_MAX_FREE_GEAR_ENERGY
  );
}

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function costModifierDefIds(): string[] {
  return [
    EZREAL_PRODIGY,
    VEX_CHEERLESS,
    // Applied Researchers' whole printed effect is the cost modifier above, so
    // nothing else claims him — the Lucian - Purifier trap, which costs a working
    // card its place in generated decks and its visibility to `reachability`.
    APPLIED_RESEARCHERS,
    NEEDLESSLY_LARGE_YORDLE,
    ...PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS,
    IRELIA_GRACEFUL,
    EAGER_APPRENTICE,
    RHASA_THE_SUNDERER,
    SKY_SPLITTER,
    FIND_YOUR_CENTER,
    SPOILS_OF_WAR,
    HERALD_OF_SCALES,
    BATTERING_RAM,
    JAULL_FISH,
    // Concentrate's two [Level] tiers. Its DRAW half is registered in
    // effects/mind.ts, so both modules claim the card and coverage merges them —
    // the same split Production Surge's note below describes, except that here
    // both halves are genuinely implemented rather than one.
    CONCENTRATE,
    // Master Yi's three [Level] cost tiers. His fourth clause ([Level 16]'s
    // unchooseable-by-enemies) is registered by target-lookup.ts, so both modules
    // claim him and coverage merges them — the same split Concentrate has.
    MASTER_YI_UNSTOPPABLE,
    // Undying Loyalty's "-[2] if you choose a Bird, Cat, Dog, or Poro". Its free
    // play is registered in effects/order.ts, so coverage merges both claims —
    // and the discount only became expressible once that card's trash choice
    // moved from a parked question to an announce-time target.
    UNDYING_LOYALTY,
    // Atakhan's scaled sacrifice discount. His attack trigger is registered in
    // effects/order.ts and his `[Ganking]` is a printed keyword, so coverage
    // merges this claim with that one — the same split Concentrate and Master Yi
    // both have.
    ATAKHAN,
    // Keeper of Law's two-axis discount is his ENTIRE printed text, so nothing
    // else claims him — the Applied Researchers case above, and the Lucian -
    // Purifier trap: a working card that no module claims reports UNIMPLEMENTED
    // and is dropped from generated decks.
    KEEPER_OF_LAW,
    // NOT Production Surge: its discount is only half the card, and its effect
    // half (the Mech token and the draw) is registered in effects/mind.ts. A
    // claim here as well would be harmless but would say the wrong thing about
    // where its text lives.
    ...legionDiscountDefIds(),
  ];
}

/**
 * A card's Energy cost after every cross-cutting modifier.
 *
 * `defId` is optional so that existing callers computing a cost for a card they
 * only know structurally keep working; pass it and self-scaling costs apply too.
 * Floored at 0, not at 1: the general rule has no minimum, and the one card in
 * this pool that DOES state a minimum ("to a minimum of 1") states it on itself.
 */
export function modifiedEnergyCost(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: "Unit" | "Spell" | "Gear" | "Legend",
  rawEnergyCost: number,
  defId?: string,
  /** WHERE the card is being played from. Only the three PLAY-path callers
   *  know this; every inner caller prices a from-hand play and takes the
   *  default. See `PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS`. */
  playedFromHand = true,
): number {
  const player = state.players[playerIndex];
  let cost = rawEnergyCost;

  // Jayce's permission zeroes the Energy outright, so it short-circuits every
  // percentage-style discount below rather than stacking with them — "ignoring
  // its Energy cost" is not a reduction, and taking 2 more off 0 is still 0.
  // The Power half is untouched by design; see `freeGearPlayApplies`.
  if (freeGearPlayApplies(state, playerIndex, cardKind, rawEnergyCost)) return 0;

  // Void Drone and Drag Under. Taken off the PRINTED cost, before the
  // conditional discounts below, on the same reasoning their own comment gives
  // for going first: a sometimes-discount should reduce what the card prints,
  // not something already reduced.
  if (!playedFromHand && defId !== undefined && PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS.has(defId)) {
    cost = Math.max(0, cost - PLAY_FROM_ELSEWHERE_DISCOUNT);
  }

  // Before the other two: a discount that only sometimes applies should be taken
  // off the printed cost, not off an already-reduced one, and Eager Apprentice's
  // own "to a minimum of 1" then clamps whatever is left.
  cost = Math.max(0, cost - legionDiscountFor(state, playerIndex, defId));

  if (defId === FIND_YOUR_CENTER && opponentNearVictory(state, playerIndex)) {
    cost = Math.max(0, cost - FIND_YOUR_CENTER_DISCOUNT);
  }

  // Monch — "If an opponent controls a stunned unit, I cost [2] less and enter
  // ready." The DISCOUNT half; the enter-ready half is a `conditionalEntersReady`
  // case in deploy.ts, and both are needed or the card is half-priced or
  // half-ready.
  //
  // "An OPPONENT controls" — the opponent's units wherever they stand, base
  // included, since the card names no location. Read live, so a unit that stops
  // being stunned before the card is paid for stops discounting it.
  if (defId === MONCH && opponentControlsStunnedUnit(state, playerIndex)) {
    cost = Math.max(0, cost - MONCH_DISCOUNT);
  }
  // Keeper of Law's ENERGY half. His POWER half is the matching branch in
  // `scaledPowerDiscount`, and both read `keeperOfLawConditionMet` so they cannot
  // disagree — Master Yi's two tiers are split the same way and for the same
  // reason.
  if (defId === KEEPER_OF_LAW && keeperOfLawConditionMet(state, playerIndex)) {
    cost = Math.max(0, cost - KEEPER_OF_LAW_ENERGY);
  }
  if (defId === SPOILS_OF_WAR && state.players[playerIndex === 0 ? 1 : 0].unitsLostThisTurn > 0) {
    cost = Math.max(0, cost - SPOILS_OF_WAR_DISCOUNT);
  }

  if (defId === SKY_SPLITTER) {
    // "The HIGHEST Might among units you control" — one unit's Might, not a sum,
    // and read through `effectiveMight` so an aura or a this-turn pump counts.
    // Non-combat context, matching every other cost- and target-side Might
    // question: auras count, [Assault]/[Shield] do not.
    const own = ownUnitsWithLocation(state, playerIndex);
    const highest = own.reduce((best, { unit, ctx }) => Math.max(best, effectiveMight(state, unit, playerIndex, ctx)), 0);
    cost = Math.max(0, cost - highest);
  }

  // Needlessly Large Yordle's ENERGY half. Its Power half is `scaledPowerDiscount`.
  if (defId === NEEDLESSLY_LARGE_YORDLE) {
    cost = Math.max(0, cost - player.pointsFromHoldingThisTurn * YORDLE_ENERGY_PER_POINT);
  }

  if (defId === BATTERING_RAM) {
    // "I cost [1] less for each card you've played this turn, to a minimum of
    // [1]." The minimum is PRINTED on the card, which is why it is clamped here
    // rather than at the shared floor of 0 below — Eager Apprentice states its
    // own the same way, and this function's doc comment records the distinction.
    //
    // `cardsPlayedThisTurn` counts the Ram itself only AFTER it is played, so a
    // Ram played first is priced at its full cost. That is the counter's meaning
    // rather than a decision here: `execute-play-card` bumps it as the card is
    // played, and pricing happens before.
    cost = Math.max(BATTERING_RAM_MINIMUM, cost - player.cardsPlayedThisTurn);
  }

  if (defId === JAULL_FISH) {
    // "I cost [2] less for each of your [Mighty] units." Read through
    // `effectiveMight` against 708's threshold, so a unit made Mighty by an aura
    // or a this-turn pump counts — the same non-combat reading Sky Splitter's
    // highest-Might question takes one branch up.
    const mighty = ownUnitsWithLocation(state, playerIndex).filter(
      ({ unit, ctx }) => effectiveMight(state, unit, playerIndex, ctx) >= MIGHTY_THRESHOLD,
    ).length;
    cost = Math.max(0, cost - JAULL_FISH_DISCOUNT * mighty);
  }

  if (defId === PRODUCTION_SURGE && controlsAMech(state, playerIndex)) {
    // "This costs [2] less if you control a Mech." A flat conditional, unlike
    // the two scaling ones above — and the Mech it makes does not pay for
    // itself, since the discount is priced before the token exists.
    cost = Math.max(0, cost - PRODUCTION_SURGE_DISCOUNT);
  }

  if (defId === RHASA_THE_SUNDERER) {
    // "For EACH card in your trash" — your own trash only, and every card in it,
    // not just units. A long game makes this free, which is the card's point.
    cost = Math.max(0, cost - player.trash.length);
  }

  // A Dragon being played while its Herald is on the board. Applied after the
  // conditional discounts above for the same reason they precede each other: a
  // sometimes-discount comes off the printed cost, and a printed floor clamps
  // whatever is left rather than being applied mid-stack.
  if (isDragon(defId)) {
    const heralds = heraldCount(state, playerIndex);
    if (heralds > 0) cost = Math.max(HERALD_FLOOR, cost - HERALD_DISCOUNT * heralds);
  }

  // Concentrate's [Level] tiers. Applied before the floors below on the same
  // reasoning as every conditional discount here: a sometimes-discount comes off
  // the printed cost. `find` on a highest-first list is what makes the printed
  // "instead" true — at 11+ XP this returns 4 and never also applies the 2.
  if (defId === CONCENTRATE) {
    const tier = CONCENTRATE_TIERS.find((t) => player.xp >= t.xp);
    if (tier !== undefined) cost = Math.max(0, cost - tier.discount);
  }

  // Master Yi's [Level] tiers, ENERGY half. Same placement and same reasoning as
  // Concentrate's directly above; the POWER half is in `scaledPowerDiscount`, and
  // both read the tier from `masterYiTier` so one play cannot take its Energy
  // from one tier and its Power from another.
  if (defId === MASTER_YI_UNSTOPPABLE) {
    const tier = masterYiTier(state, playerIndex);
    if (tier !== undefined) cost = Math.max(0, cost - tier.energy);
  }

  // Raging Firebrand's charge. Applied to SPELLS only ("the next SPELL you play")
  // and before Eager Apprentice's floor below, so a discount that only sometimes
  // applies comes off the printed cost and the printed floor clamps what is left.
  //
  // Read here and SPENT in execute-play-card — a cost modifier is asked several
  // times per play (enumeration, validation, the float math) and must give the
  // same answer each time, so it cannot be the thing that consumes the charge.
  if (cardKind === "Spell" && player.nextSpellEnergyDiscount > 0) {
    cost = Math.max(0, cost - player.nextSpellEnergyDiscount);
  }

  if (cardKind === "Spell") {
    const hasEagerApprenticeAtBattlefield = state.battlefields.some((bf) =>
      (bf.units[player.id] ?? []).some((u) => u.defId === EAGER_APPRENTICE),
    );
    // Eager Apprentice's own floor of 1, stated on the card.
    if (hasEagerApprenticeAtBattlefield) cost = Math.max(1, cost - 1);
  }

  // Vex - Cheerless's ENERGY half, both directions. Her Power halves are
  // `combatSpellPowerDiscount` (friendly) and `rainbowSurchargeForPlay` (enemy).
  //
  // The friendly floor is written as `max(min(cost, FLOOR), ...)` rather than as
  // Eager Apprentice's plain `max(1, ...)` on purpose: a spell already priced
  // BELOW the floor — a Hidden play, or one Sky Splitter has zeroed — would be
  // RAISED to 1 by the plain form. "Costs 1 less to a minimum of 1" cannot make a
  // card more expensive, and the clamp is only ever meant to stop the reduction
  // going past 1.
  const vexSwing = vexSpellSwing(state, playerIndex, cardKind);
  if (vexSwing < 0) {
    cost = Math.max(Math.min(cost, VEX_FRIENDLY_ENERGY_FLOOR), cost + vexSwing * VEX_ENERGY_SWING);
  } else if (vexSwing > 0) {
    // No floor on the tax — a surcharge has no minimum to clamp against.
    cost += vexSwing * VEX_ENERGY_SWING;
  }

  // Applied Researchers' ENERGY half — Vex's friendly discount with an Empowered
  // condition instead of a combat one. Its Power half is in
  // `combatSpellPowerDiscount` beside hers, since both take a rainbow pip off the
  // spell's own Power rather than adding a debt.
  //
  // The SAME clamp as hers, reused rather than restated: "to a minimum of [1]"
  // must not raise a spell already priced below 1.
  if (cardKind === "Spell") {
    const researchers = empoweredResearchers(state, playerIndex);
    if (researchers > 0) {
      cost = Math.max(Math.min(cost, VEX_FRIENDLY_ENERGY_FLOOR), cost - researchers * VEX_ENERGY_SWING);
    }
  }

  // Ornn's Forge — "the FIRST friendly non-token gear played each turn costs [1]
  // less". GEAR only, and only while `gearPlayedThisTurn` is still zero;
  // `firstGearDiscountFor` asks both. Floored at 0 rather than at 1: the card
  // states no minimum, unlike Eager Apprentice's above, and reading one in would
  // quietly refuse the discount to every 1-Energy gear in the set.
  //
  // Read here and never spent here — the counter it depends on is bumped in
  // `execute-play-card`'s shared updates, AFTER this has priced the play, for the
  // reason this function's own Firebrand note gives.
  if (cardKind === "Gear") cost = Math.max(0, cost - firstGearDiscountFor(state, playerIndex));

  return cost;
}

/**
 * A `[Repeat]` cost's Energy after Marai Spire's discount — the ONE function the
 * enumerator and the validator both call.
 *
 * Its own entry point rather than a branch inside `modifiedEnergyCost`, because
 * the two modify different things and stack independently: `modifiedEnergyCost`
 * prices the card's PRINTED cost, this prices the ADDITIONAL cost 820.1.c.1
 * charges beside it. Folding them together would have let Eager Apprentice's
 * "spells cost 1 less, minimum 1" clamp the repeat surcharge too, which is not
 * what either card says.
 *
 * Floored at 0, which is where Called Shot lands: its Repeat is `[Chaos]` with
 * no Energy at all, so Marai Spire discounts it by nothing. A card cannot be
 * paid a negative cost, and letting it go below zero would silently offset the
 * Power half when the two are summed downstream.
 */
export function modifiedRepeatEnergy(state: GameState, playerIndex: 0 | 1, printedRepeatEnergy: number): number {
  return Math.max(0, printedRepeatEnergy - repeatEnergyDiscountFor(state, playerIndex));
}
