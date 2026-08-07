import type { GameState } from "../model/game-state.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { opponentNearVictory } from "./constants.js";
import { legionActive } from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { MIGHTY_THRESHOLD } from "./constants.js";
import { firstGearDiscountFor, repeatEnergyDiscountFor } from "./battlefield-continuous.js";
import type { UnitInstance } from "../model/card.js";
import { isMechUnit } from "./equipment.js";

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
 * Floored per axis at each site, so it can never turn an addition into a refund.
 */
const EZREAL_PRODIGY = "SFD-149";
const EZREAL_DISCOUNT = 1;

/** Is Ezreal - Prodigy in play for this player? His clause is unpositioned — it
 *  names no battlefield — so base counts. */
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
  if (defId !== NEEDLESSLY_LARGE_YORDLE) return 0;
  return state.players[playerIndex].pointsFromHoldingThisTurn * YORDLE_POWER_PER_POINT;
}

const PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS = new Set(["SFD-010", "SFD-164"]);
const PLAY_FROM_ELSEWHERE_DISCOUNT = 2;

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
    // `effectiveMight` against 711's threshold, so a unit made Mighty by an aura
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
