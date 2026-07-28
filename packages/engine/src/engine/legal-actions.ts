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
import { effectForCard, requiresTarget } from "./card-effects.js";

/**
 * Enumerates every currently-legal PlayerAction for the active player (or,
 * during an open Showdown, for whoever holds Focus — not necessarily the
 * same player). Unlike the Java oracle (which has no single generic
 * enumerator — HeuristicAI builds its own ad hoc candidate list per action
 * type, engine/HeuristicAI.java:367-425), this is a real shared contract:
 * both the AI and the UI's "what can I click" logic consume the same
 * function, so they can't drift on what's legal.
 *
 * Scoped to what's implemented: PlayCard for Units/Spells/Gear from hand or
 * the Champion Zone (Unit only), with an auto-computed rune payment covering
 * both Energy and domain-restricted Power costs (no Legend play, no
 * Accelerate/additional costs, no destination battlefields, no EquipGear),
 * MoveUnit for every ready unit to every battlefield it can legally reach,
 * RecallUnit for every ready unit at a battlefield, and Pass.
 * `computeAutoPayment` picks a single minimal valid payment rather than
 * exploring every possible rune selection — which specific rune covers a
 * domain-agnostic Energy cost never changes the outcome, and for Power
 * there's exactly one eligible domain-matching pool to draw from anyway.
 * Every Spell in hand is a legal PlayCard candidate regardless of its
 * isAction/isReaction tags — those only gate Showdown/reaction-speed
 * timing (not modeled here), never a normal-turn cast. A Spell whose
 * registered effect (card-effects.ts) requires a target fans out into one
 * PlayCardAction per legal target — every unit at any battlefield, either
 * owner, per this slice's un-restricted targeting rule — mirroring the
 * MoveUnit double-loop below it in this same function.
 *
 * While a Showdown is open, none of the above are legal (mirrors
 * ActionValidator.validateShowdownOpen's hard rejection of MoveUnit/Pass,
 * plus the fact that no Spell/Reaction-speed card is castable there yet) —
 * the only candidate is PassFocus, for whoever currently holds Focus.
 * Likewise while the chain is closed (a Spell is pending resolution) — no
 * reaction-speed cards can be played onto an already-closed chain yet, so
 * the only candidate is PassFocus, for whoever holds chain priority.
 */
export function legalActions(state: GameState): PlayerAction[] {
  if (state.phase !== "Action") return [];

  if (state.turnState === "Showdown") {
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex: state.focusHolder };
    return [passFocus];
  }

  if (!state.chainOpen) {
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex: state.chainPriority };
    return [passFocus];
  }

  const playerIndex = state.activePlayerIndex;
  const actor = state.players[playerIndex];
  const actions: PlayerAction[] = [];

  const pass: PassAction = { type: "Pass", playerIndex };
  actions.push(pass);

  const playableSources = actor.championZone ? [...actor.hand, actor.championZone] : actor.hand;
  for (const card of playableSources) {
    if (card.kind === "Legend") continue;
    const payment = computeAutoPayment(actor.channeled, card.energyCost, card.powerCost, card.powerDomain);
    if (!payment) continue; // can't afford it — not a legal move

    if (requiresTarget(effectForCard(card))) {
      for (const bf of state.battlefields) {
        for (const targets of Object.values(bf.units)) {
          for (const target of targets) {
            const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, targetUnitInstanceId: target.instanceId };
            actions.push(play);
          }
        }
      }
      continue;
    }

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
