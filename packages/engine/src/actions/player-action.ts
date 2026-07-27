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
 * The player-submittable actions implemented so far. Mirrors a subset of
 * engine/PlayerAction.java's 17-variant sealed interface (PlayCard, MoveUnit,
 * RecallUnit, ActivateGear, ActivateUnit, FloatRune, PassFocus, Pass,
 * AssignDamage, ChooseTrashSpell, ChooseDiscard, ResolveVayneBounce,
 * ResolvePendingChoice, ActivateLegend, HideCard, RevealHiddenCard,
 * EquipGear, ResolveRepeatChoice) — the rest get added here as each one's
 * validate/execute pair is actually implemented (M1's turn/priority
 * skeleton), not stubbed out ahead of that logic.
 */
export type PlayerAction = PlayCardAction | PassAction | MoveUnitAction;
