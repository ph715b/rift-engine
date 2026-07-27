import type { GameState } from "../model/game-state.js";
import type {
  MoveUnitAction,
  PassAction,
  PassFocusAction,
  PlayCardAction,
  PlayerAction,
  RecallUnitAction,
} from "../actions/player-action.js";
import { computeAutoPayment } from "./rune-payment.js";

/**
 * Enumerates every currently-legal PlayerAction for the active player (or,
 * during an open Showdown, for whoever holds Focus — not necessarily the
 * same player). Unlike the Java oracle (which has no single generic
 * enumerator — HeuristicAI builds its own ad hoc candidate list per action
 * type, engine/HeuristicAI.java:367-425), this is a real shared contract:
 * both the AI and the UI's "what can I click" logic consume the same
 * function, so they can't drift on what's legal.
 *
 * Scoped to what's implemented: PlayCard for Units only, from hand or the
 * Champion Zone, with an auto-computed rune payment covering both Energy
 * and domain-restricted Power costs (no Spells/Gear/Legend play, no
 * Accelerate/additional costs, no destination battlefields), MoveUnit for
 * every ready unit to every battlefield it can legally reach, RecallUnit
 * for every ready unit at a battlefield, and Pass. `computeAutoPayment`
 * picks a single minimal valid payment rather than exploring every possible
 * rune selection — which specific rune covers a domain-agnostic Energy
 * cost never changes the outcome, and for Power there's exactly one
 * eligible domain-matching pool to draw from anyway.
 *
 * While a Showdown is open, none of the above are legal (mirrors
 * ActionValidator.validateShowdownOpen's hard rejection of MoveUnit/Pass,
 * plus the fact that no Spell/Reaction-speed card exists in this pool yet
 * to be the "something else" that's normally also legal there) — the only
 * candidate is PassFocus, for whoever currently holds Focus.
 */
export function legalActions(state: GameState): PlayerAction[] {
  if (state.phase !== "Action") return [];

  if (state.turnState === "Showdown") {
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex: state.focusHolder };
    return [passFocus];
  }

  const playerIndex = state.activePlayerIndex;
  const actor = state.players[playerIndex];
  const actions: PlayerAction[] = [];

  const pass: PassAction = { type: "Pass", playerIndex };
  actions.push(pass);

  const playableSources = actor.championZone ? [...actor.hand, actor.championZone] : actor.hand;
  for (const card of playableSources) {
    if (card.kind !== "Unit") continue;
    const payment = computeAutoPayment(actor.channeled, card.energyCost, card.powerCost, card.powerDomain);
    if (!payment) continue; // can't afford it — not a legal move
    const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment };
    actions.push(play);
  }

  for (const unit of actor.baseUnits) {
    if (unit.exhausted) continue;
    for (const bf of state.battlefields) {
      const move: MoveUnitAction = {
        type: "MoveUnit",
        playerIndex,
        unitInstanceIds: [unit.instanceId],
        destinationBattlefieldId: bf.id,
      };
      actions.push(move);
    }
  }

  for (const bf of state.battlefields) {
    const unitsHere = bf.units[actor.id] ?? [];
    for (const unit of unitsHere) {
      if (unit.exhausted) continue;

      const recall: RecallUnitAction = { type: "RecallUnit", playerIndex, unitInstanceIds: [unit.instanceId] };
      actions.push(recall);

      if (!("Ganking" in unit.keywords)) continue;
      for (const dest of state.battlefields) {
        if (dest.id === bf.id) continue;
        const move: MoveUnitAction = {
          type: "MoveUnit",
          playerIndex,
          unitInstanceIds: [unit.instanceId],
          destinationBattlefieldId: dest.id,
        };
        actions.push(move);
      }
    }
  }

  return actions;
}
