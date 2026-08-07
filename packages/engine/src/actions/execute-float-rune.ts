import type { GameState, PlayerState } from "../model/game-state.js";
import { holdRunesRecycled } from "../engine/effect-helpers.js";
import type { FloatRuneAction } from "./player-action.js";
import { validateFloatRune } from "./validate-float-rune.js";

/**
 * Resolves a validated FloatRune action. Mirrors
 * ActionExecutor.executeFloatRune (engine/ActionExecutor.java:1123-1157):
 *   - Energy mode (`forPower: false`): the rune is exhausted IN PLACE
 *     (stays in `channeled`, doesn't recycle) and floatingEnergy gains 1.
 *   - Power mode (`forPower: true`): the rune is fully recycled — removed
 *     from `channeled`, reset to Ready, sent to the bottom of the rune deck
 *     (the same recycle shape execute-play-card.ts already uses for a
 *     Power-cost payment) — and floatingPower of the rune's own domain
 *     gains 1. If the rune was STILL Ready at the moment it was recycled,
 *     its Energy-paying potential would otherwise be wasted, so
 *     floatingEnergy ALSO gains 1 (an already-Exhausted rune has nothing
 *     left to waste, so no such credit there).
 */
export function executeFloatRune(state: GameState, action: FloatRuneAction): GameState {
  const validation = validateFloatRune(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const rune = actor.channeled.find((r) => r.id === action.runeId)!;

  let updatedActor: PlayerState;
  if (action.forPower) {
    const wasReady = rune.state === "Ready";
    updatedActor = {
      ...actor,
      channeled: actor.channeled.filter((r) => r.id !== rune.id),
      runeDeck: [...actor.runeDeck, { ...rune, state: "Ready" }],
      floatingEnergy: actor.floatingEnergy + (wasReady ? 1 : 0),
      floatingPower: { ...actor.floatingPower, [rune.domain]: (actor.floatingPower[rune.domain] ?? 0) + 1 },
    };
  } else {
    updatedActor = {
      ...actor,
      channeled: actor.channeled.map((r) => (r.id === rune.id ? { ...r, state: "Exhausted" as const } : r)),
      floatingEnergy: actor.floatingEnergy + 1,
    };
  }

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;
  // Sivir - Battle Mistress. Only the `forPower` branch recycles — floating a
  // rune for ENERGY exhausts it and leaves it in the pool, which is not a
  // recycling at all. That asymmetry is the whole of this action's doc comment.
  return holdRunesRecycled({ ...state, players }, action.playerIndex, action.forPower ? 1 : 0);
}
