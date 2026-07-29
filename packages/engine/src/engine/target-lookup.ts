import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { TargetingSpec } from "./card-effects.js";

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
/** Every unit at any battlefield that satisfies a `"unit"`-style owner
 *  constraint relative to `playerIndex` — the same scan legal-actions.ts's
 *  own fan-out performs. */
function eligibleBattlefieldUnits(state: GameState, playerIndex: 0 | 1, owner?: "friendly" | "enemy"): UnitInstance[] {
  return state.battlefields.flatMap((bf) =>
    Object.entries(bf.units).flatMap(([ownerId, units]) => {
      const ownerIndex: 0 | 1 = state.players[0]!.id === ownerId ? 0 : 1;
      if (owner === "friendly" && ownerIndex !== playerIndex) return [];
      if (owner === "enemy" && ownerIndex === playerIndex) return [];
      return units;
    }),
  );
}

/**
 * Could this targeting spec be satisfied AT ALL right now — is there at least
 * one legal choice on the board? The boolean counterpart to legal-actions.ts's
 * effect-variant fan-out, asking the same question that fan-out answers
 * structurally by producing zero variants.
 *
 * Used by validate-play-card.ts to decide whether a Unit may be played with
 * its on-play trigger's target omitted: permitted only when there was nothing
 * to choose, so an omitted field can never be a way to duck a mandatory
 * trigger. Kept here rather than in either caller because it has to agree with
 * BOTH of them — see legal-actions.ts's own `card.kind === "Unit" &&
 * effectVariants.length === 0` note.
 */
export function hasAnyLegalEffectChoice(state: GameState, playerIndex: 0 | 1, targeting: TargetingSpec): boolean {
  switch (targeting.kind) {
    case "none":
      return true; // nothing to choose, nothing missing
    case "battlefield":
      return state.battlefields.length > 0;
    case "unit":
      return eligibleBattlefieldUnits(state, playerIndex, targeting.owner).some(
        (u) => targeting.maxMight === undefined || u.might + u.bonus <= targeting.maxMight,
      );
    case "unitPair": {
      const first = eligibleBattlefieldUnits(state, playerIndex, targeting.firstOwner);
      const second = eligibleBattlefieldUnits(state, playerIndex, targeting.secondOwner);
      // The pair must be two DISTINCT units — mirrors the fan-out's own
      // `first.instanceId === second.instanceId` skip.
      return first.some((a) => second.some((b) => a.instanceId !== b.instanceId));
    }
    case "ownTrashCard": {
      const trash = state.players[playerIndex].trash;
      return trash.some((c) => targeting.cardKind === undefined || c.kind === targeting.cardKind);
    }
  }
}

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
