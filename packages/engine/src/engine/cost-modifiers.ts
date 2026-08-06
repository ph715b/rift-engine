import type { GameState } from "../model/game-state.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { opponentNearVictory } from "./constants.js";
import { legionActive } from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { repeatEnergyDiscountFor } from "./battlefield-continuous.js";
import type { UnitInstance } from "../model/card.js";

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

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function costModifierDefIds(): string[] {
  return [EAGER_APPRENTICE, RHASA_THE_SUNDERER, SKY_SPLITTER, FIND_YOUR_CENTER, SPOILS_OF_WAR, HERALD_OF_SCALES, ...legionDiscountDefIds()];
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
): number {
  const player = state.players[playerIndex];
  let cost = rawEnergyCost;

  // Before the other two: a discount that only sometimes applies should be taken
  // off the printed cost, not off an already-reduced one, and Eager Apprentice's
  // own "to a minimum of 1" then clamps whatever is left.
  cost = Math.max(0, cost - legionDiscountFor(state, playerIndex, defId));

  if (defId === FIND_YOUR_CENTER && opponentNearVictory(state, playerIndex)) {
    cost = Math.max(0, cost - FIND_YOUR_CENTER_DISCOUNT);
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
