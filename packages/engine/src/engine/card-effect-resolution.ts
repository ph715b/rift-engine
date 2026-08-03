import type { SpellChainEntry, GameState } from "../model/game-state.js";
import { effectForCard } from "./card-effects.js";
import { contextFor } from "./effect-context.js";

/**
 * Resolves a popped chain entry's registered effect, if any — no-ops for
 * any card with no CARD_EFFECTS entry, exactly like today (mirrors the Java
 * oracle's own EffectRegistry.has() safe-no-op guard for an unregistered
 * card name).
 */
export function resolveCardEffect(state: GameState, entry: SpellChainEntry): GameState {
  const effect = effectForCard(entry.card);
  if (!effect) return state;
  // The resolving card names itself through the context — Time Warp's
  // "Banish this" is the first text that needs it.
  return effect.resolve(state, contextFor(entry.playerIndex, entry.card.instanceId), {
    ...(entry.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: entry.targetUnitInstanceId } : {}),
    ...(entry.secondTargetUnitInstanceId !== undefined ? { secondTargetUnitInstanceId: entry.secondTargetUnitInstanceId } : {}),
    ...(entry.targetUnitInstanceIds !== undefined ? { targetUnitInstanceIds: entry.targetUnitInstanceIds } : {}),
    ...(entry.targetChainCardInstanceId !== undefined ? { targetChainCardInstanceId: entry.targetChainCardInstanceId } : {}),
    ...(entry.targetBattlefieldId !== undefined ? { targetBattlefieldId: entry.targetBattlefieldId } : {}),
    ...(entry.trashCardInstanceId !== undefined ? { trashCardInstanceId: entry.trashCardInstanceId } : {}),
    ...(entry.additionalCostUnitInstanceId !== undefined ? { additionalCostUnitInstanceId: entry.additionalCostUnitInstanceId } : {}),
    ...(entry.additionalCostUnitInstanceIds !== undefined ? { additionalCostUnitInstanceIds: entry.additionalCostUnitInstanceIds } : {}),
    ...(entry.destinationBattlefieldId !== undefined ? { destinationBattlefieldId: entry.destinationBattlefieldId } : {}),
    ...(entry.discardCardInstanceId !== undefined ? { discardCardInstanceId: entry.discardCardInstanceId } : {}),
    ...(entry.targetPermanentInstanceId !== undefined ? { targetPermanentInstanceId: entry.targetPermanentInstanceId } : {}),
  });
}
