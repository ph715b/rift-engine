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
  /**
   * Set when this card is being played FROM a facedown state at that
   * battlefield (rule 811). Three things follow, none of which are true of an
   * ordinary play: the base cost is ignored entirely, the card counts as
   * `[Reaction]` however it is printed, and every target must be chosen from
   * among options at THAT battlefield.
   */
  fromHiddenBattlefieldId?: string;
  /**
   * `[Accelerate]` (rule 805): the caster chose to pay the optional additional
   * cost, so this unit enters READY. A boolean choice decided in the action
   * rather than asked mid-resolution, exactly like `visionRecycle` — and like
   * that one, enumerated as two distinct candidates.
   *
   * When set, `payment` covers the card's own cost PLUS 1 Energy and 1 Power.
   */
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the unchosen multi-discards (Jinx, Undercover Agent's Deathknell)
   *  go through discardCards' front-of-hand convention instead. */
  discardCardInstanceId?: string;
  /** The unit OR gear named by a `unitOrGear`-kind targeting spec (Fading
   *  Memories). Separate from `targetUnitInstanceId` because a gear is not a
   *  unit and must never reach a reader expecting one. */
  targetPermanentInstanceId?: string;
  acceleratePaid?: true;
}

/**
 * Hide a card facedown at a battlefield you control — rule 811's Discretionary
 * Action, NOT a play. It opens no chain and does not pay the card's own cost;
 * the price is a flat 1 rainbow Power (`payment`, whose energyRunes are always
 * empty) plus the fact that losing the battlefield loses the card.
 */
export interface HideCardAction {
  type: "HideCard";
  playerIndex: 0 | 1;
  card: CardInstance;
  battlefieldId: string;
  payment: RunePayment;
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
  /** The permanent being activated. Named `permanentInstanceId`, not
   *  `unitInstanceId`, because Gear activates the same way and through the same
   *  action — 20 of the 30 Gear in this pool are "exhaust: do one thing", and
   *  while the field said "unit" they were unreachable. */
  permanentInstanceId: string;
  /** Chosen before submitting, like every other target in this engine — see
   *  card-effects.ts's TargetingSpec doc comment. Absent for abilities whose
   *  targeting is "none". */
  targetUnitInstanceId?: string;
}

/**
 * Answers the question the engine has stopped to ask — see engine/decisions.ts.
 *
 * ONE action type for every question, which is the difference between this and
 * the Java oracle's four (ResolvePendingChoice, ChooseDiscard,
 * ResolveVayneBounce, ResolveRepeatChoice, all listed below in the very comment
 * describing what to port). Each of those needed its own validator branch, its
 * own AI branch and its own "who acts now" case; one type needs one of each,
 * forever.
 *
 * `decisionId` rather than "the current one": an answer aimed at a question that
 * has already been resolved must not silently apply to whatever took its place.
 */
export interface AnswerDecisionAction {
  type: "AnswerDecision";
  playerIndex: 0 | 1;
  decisionId: string;
  /** Names one of `decisions.optionsFor(state, decision)`, which are rebuilt
   *  from live state rather than stored — so this is checked, not trusted. */
  optionId: string;
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
  | HideCardAction
  | PassAction
  | MoveUnitAction
  | RecallUnitAction
  | PassFocusAction
  | FloatRuneAction
  | ActivateAbilityAction
  | AnswerDecisionAction;
