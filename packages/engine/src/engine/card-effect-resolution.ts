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
  // Ravenborn Tome's charge ends HERE — "the next spell you play this turn"
  // stops being the next spell once that spell has finished resolving, and its
  // damage happens during the resolution, so the charge has to survive the
  // resolver and be cleared after it. That is one layer later than Raging
  // Firebrand's discount, which is consumed when the spell is paid for.
  //
  // Cleared for EVERY spell, registered or not: a spell with no implementation
  // is still a spell you played, and leaving the charge standing would hand it
  // to the next one.
  const clearCharge = (next: GameState): GameState => {
    if (next.players[entry.playerIndex].nextSpellBonusDamage === 0) return next;
    const players = [...next.players] as [typeof next.players[0], typeof next.players[1]];
    players[entry.playerIndex] = { ...players[entry.playerIndex], nextSpellBonusDamage: 0 };
    return { ...next, players };
  };
  if (!effect) return clearCharge(state);
  // The resolving card names itself through the context — Time Warp's
  // "Banish this" is the first text that needs it.
  return clearCharge(
    effect.resolve(state, contextFor(entry.playerIndex, entry.card.instanceId), {
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
    }),
  );
}
