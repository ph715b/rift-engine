import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";

export interface BattlefieldUnitLocation {
  unit: UnitInstance;
  ownerId: string;
  ownerIndex: 0 | 1;
  battlefieldIndex: number;
}

/**
 * Finds a unit by instanceId among units currently sitting at any
 * battlefield, across both players. Deliberately does NOT search
 * `PlayerState.baseUnits` — every card that needs targeting in this round's
 * effect slice (card-effects.ts) restricts itself to "a unit at a
 * battlefield," so a base-unit search isn't needed or testable yet. Add a
 * separate/generalized lookup when a card that can target base units is
 * implemented, rather than widening this one speculatively.
 */
export function findUnitOnBattlefield(state: GameState, instanceId: string): BattlefieldUnitLocation | undefined {
  for (let battlefieldIndex = 0; battlefieldIndex < state.battlefields.length; battlefieldIndex++) {
    const bf = state.battlefields[battlefieldIndex]!;
    for (const [ownerId, units] of Object.entries(bf.units)) {
      const unit = units.find((u) => u.instanceId === instanceId);
      if (unit) {
        const ownerIndex = state.players[0]!.id === ownerId ? 0 : 1;
        return { unit, ownerId, ownerIndex, battlefieldIndex };
      }
    }
  }
  return undefined;
}
