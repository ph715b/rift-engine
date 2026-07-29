import type { ChainEntry, GameState } from "../model/game-state.js";
import { effectForCard } from "./card-effects.js";
import { contextFor } from "./effect-context.js";

/**
 * Resolves a popped chain entry's registered effect, if any — no-ops for
 * any card with no CARD_EFFECTS entry, exactly like today (mirrors the Java
 * oracle's own EffectRegistry.has() safe-no-op guard for an unregistered
 * card name).
 */
export function resolveCardEffect(state: GameState, entry: ChainEntry): GameState {
  const effect = effectForCard(entry.card);
  if (!effect) return state;
  return effect.resolve(state, contextFor(entry.playerIndex), {
    ...(entry.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: entry.targetUnitInstanceId } : {}),
    ...(entry.secondTargetUnitInstanceId !== undefined ? { secondTargetUnitInstanceId: entry.secondTargetUnitInstanceId } : {}),
    ...(entry.targetBattlefieldId !== undefined ? { targetBattlefieldId: entry.targetBattlefieldId } : {}),
    ...(entry.trashCardInstanceId !== undefined ? { trashCardInstanceId: entry.trashCardInstanceId } : {}),
    ...(entry.additionalCostUnitInstanceId !== undefined ? { additionalCostUnitInstanceId: entry.additionalCostUnitInstanceId } : {}),
  });
}
