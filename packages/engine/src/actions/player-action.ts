import type { CardInstance } from "../model/card.js";

/**
 * A rune payment: which specific channeled runes (by id) cover a cost's
 * Energy and Power portions. Mirrors engine/RunePayment.java.
 */
export interface RunePayment {
  energyRunes: string[];
  powerRunes: string[];
}

export interface PlayCardAction {
  type: "PlayCard";
  playerIndex: 0 | 1;
  card: CardInstance;
  payment: RunePayment;
  /** The unit instance this card's effect targets, if it has one (e.g. a
   *  damage/destroy Spell), OR — for a Unit card — the target its own
   *  on-play trigger needs (e.g. First Mate's "ready another unit"). Only
   *  meaningful when the card's registered effect/trigger has a "unit"-kind
   *  TargetingSpec — see engine/card-effects.ts / engine/unit-triggers.ts. */
  targetUnitInstanceId?: string;
  /** The second target of a "unitPair"-kind effect (Gentlemen's Duel only)
   *  — targetUnitInstanceId above is the pair's first target. */
  secondTargetUnitInstanceId?: string;
  /** The battlefield a "battlefield"-kind targeted effect applies to (e.g.
   *  Firestorm's "all enemy units at a battlefield"). */
  targetBattlefieldId?: string;
  /** The caster's own trash card an "ownTrashCard"-kind effect returns
   *  (Morbid Return, Annie-Stubborn's on-play trigger). */
  trashCardInstanceId?: string;
  /** The friendly unit (base or battlefield) exhausted as an optional
   *  additional cost (Meditation only) — absent means the caster declined
   *  it. See card-effects.ts's cardHasOptionalExhaustCost. */
  additionalCostUnitInstanceId?: string;
  /** For a Unit card only: deploy directly to this battlefield instead of
   *  base. Legal only when the acting player already has a unit of their
   *  own there — mirrors ActionValidator.validateUnitDirectToBattlefield's
   *  universal (exception-free) rule, `Battlefield.hasUnitsFor(actor)`. */
  destinationBattlefieldId?: string;
  /** Only meaningful for a Unit with the Vision on-play trigger (Mystic
   *  Poro, Sai Scout): whether the caster chose to recycle the revealed
   *  top card (send it to the bottom of the deck) rather than keep it on
   *  top. Fanned into two distinct legal actions by legal-actions.ts, since
   *  this engine can't pause mid-resolution to ask — the choice must
   *  already be decided in the submitted action. */
  visionRecycle?: boolean;
}

export interface PassAction {
  type: "Pass";
  playerIndex: 0 | 1;
}

/**
 * Moves one or more units (base -> battlefield, or battlefield ->
 * battlefield if [Ganking]) to `destinationBattlefieldId` in one action.
 * Mirrors PlayerAction.MoveUnit (engine/PlayerAction.java) — Java's variant
 * also carries a `payment` for the Mageseeker Investigator rainbow-Power
 * surcharge, a single named card's cost not modeled here.
 */
export interface MoveUnitAction {
  type: "MoveUnit";
  playerIndex: 0 | 1;
  unitInstanceIds: string[];
  destinationBattlefieldId: string;
}

/**
 * Moves one or more units from a battlefield back to base. Mirrors
 * PlayerAction.RecallUnit (engine/PlayerAction.java) — Java's variant is
 * just the unit list, no destination (there's only one base to return to).
 */
export interface RecallUnitAction {
  type: "RecallUnit";
  playerIndex: 0 | 1;
  unitInstanceIds: string[];
}

/**
 * Passes Focus/chain priority while a Showdown is open (engine/GameEngine.java's
 * PassFocus, handlePassFocus). Distinct from Pass: Pass ends the whole turn
 * and is illegal during an open Showdown; PassFocus only passes the
 * initiative within it. Two consecutive PassFocus actions resolve combat —
 * see execute-pass-focus.ts.
 */
export interface PassFocusAction {
  type: "PassFocus";
  playerIndex: 0 | 1;
}

/**
 * Taps a channeled rune directly into the player's floating pool,
 * independent of casting or activating anything — the real rule
 * (confirmed against both the official Core Rules and
 * engine/PlayerAction.java:164-173's `FloatRune(RuneCard rune, boolean
 * forPower)`): exhaust a Ready rune for 1 floating Energy (`forPower:
 * false`), or recycle a rune (Ready or Exhausted) for 1 floating Power of
 * its domain (`forPower: true`). Unlike Java's implicit owner-scan, this
 * carries an explicit `playerIndex` and an id (not an object reference),
 * matching every other action in this file.
 */
export interface FloatRuneAction {
  type: "FloatRune";
  playerIndex: 0 | 1;
  runeId: string;
  forPower: boolean;
}

/**
 * Activates a unit's own printed activated ability — narrowly scoped to
 * Lux-Crownguard's "Exhaust: Add 2 restricted Energy" for now (the only
 * activated ability in this card pool), mirroring engine/PlayerAction.java's
 * `ActivateUnit(Card.Unit unit, Card.Unit target, RunePayment payment,
 * String viaAbility)` shape, minus the target/payment fields no in-scope
 * ability needs yet (add them the day a card that does is implemented,
 * rather than speculatively).
 */
export interface ActivateAbilityAction {
  type: "ActivateAbility";
  playerIndex: 0 | 1;
  unitInstanceId: string;
}

/**
 * The player-submittable actions implemented so far. Mirrors a subset of
 * engine/PlayerAction.java's 17-variant sealed interface (PlayCard, MoveUnit,
 * RecallUnit, ActivateGear, ActivateUnit, FloatRune, PassFocus, Pass,
 * AssignDamage, ChooseTrashSpell, ChooseDiscard, ResolveVayneBounce,
 * ResolvePendingChoice, ActivateLegend, HideCard, RevealHiddenCard,
 * EquipGear, ResolveRepeatChoice) — the rest get added here as each one's
 * validate/execute pair is actually implemented (M1's turn/priority
 * skeleton), not stubbed out ahead of that logic.
 */
export type PlayerAction =
  | PlayCardAction
  | PassAction
  | MoveUnitAction
  | RecallUnitAction
  | PassFocusAction
  | FloatRuneAction
  | ActivateAbilityAction;
