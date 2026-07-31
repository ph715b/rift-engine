import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { slotOwner, type TargetingSpec } from "./card-effects.js";
import { effectiveMight } from "./effective-might.js";

export interface BattlefieldUnitLocation {
  unit: UnitInstance;
  ownerId: string;
  ownerIndex: 0 | 1;
  battlefieldIndex: number;
}

/** Where a unit found by findUnitAnywhere actually sits. `"base"` carries no
 *  battlefield index because a base unit isn't at one — callers that need a
 *  battlefield id must branch on this rather than assume. */
export type UnitZone = "base" | { battlefieldIndex: number };

export interface AnyUnitLocation {
  unit: UnitInstance;
  ownerId: string;
  ownerIndex: 0 | 1;
  zone: UnitZone;
}

/**
 * Finds a unit by instanceId ANYWHERE in play — either player's base or any
 * battlefield. The counterpart to findUnitOnBattlefield below, which stays
 * for the many cards whose text really does say "a unit at a battlefield".
 *
 * Riftbound's card text draws this distinction deliberately: "Deal 8 to a
 * unit" (Final Spark) reaches a unit sitting at home, "Deal 2 to a unit at a
 * battlefield" (Incinerate) does not. Which lookup a card uses is therefore
 * a per-card property — see TargetingSpec's `scope`.
 */
export function findUnitAnywhere(state: GameState, instanceId: string): AnyUnitLocation | undefined {
  for (const ownerIndex of [0, 1] as const) {
    const player = state.players[ownerIndex];
    const unit = player.baseUnits.find((u) => u.instanceId === instanceId);
    if (unit) return { unit, ownerId: player.id, ownerIndex, zone: "base" };
  }
  const atBattlefield = findUnitOnBattlefield(state, instanceId);
  if (!atBattlefield) return undefined;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = atBattlefield;
  return { unit, ownerId, ownerIndex, zone: { battlefieldIndex } };
}

/** Every unit satisfying a `"unit"`-style owner constraint relative to
 *  `playerIndex` — the same scan legal-actions.ts's own fan-out performs.
 *  `scope: "anywhere"` additionally includes both players' base units. */
export function eligibleTargets(
  state: GameState,
  playerIndex: 0 | 1,
  owner?: "friendly" | "enemy",
  scope: "battlefield" | "anywhere" = "battlefield",
): UnitInstance[] {
  const ownerMatches = (ownerIndex: 0 | 1) =>
    !(owner === "friendly" && ownerIndex !== playerIndex) && !(owner === "enemy" && ownerIndex === playerIndex);

  const inBase =
    scope === "anywhere"
      ? ([0, 1] as const).flatMap((ownerIndex) => (ownerMatches(ownerIndex) ? state.players[ownerIndex].baseUnits : []))
      : [];
  return [...inBase, ...eligibleBattlefieldUnits(state, playerIndex, owner)];
}

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
 * Does this unit satisfy a `maxMight` restriction (Gust's "3 Might or less")?
 * Routes through effectiveMight rather than `might + mightThisTurn`, so a unit
 * standing under a continuous aura is judged at the Might it actually has —
 * three separate call sites used to inline the raw sum and would happily let
 * you Gust a 3-Might unit that Garen - Commander had made a 4. Non-combat
 * context, matching dealDamage: auras count, [Shield]/[Assault] don't.
 */
export function unitWithinMaxMight(state: GameState, unit: UnitInstance, maxMight: number | undefined): boolean {
  if (maxMight === undefined) return true;
  // findUnitAnywhere, not findUnitOnBattlefield: this used to return `true`
  // for anything it couldn't find at a battlefield, so once base units became
  // targetable a base unit would have skipped the Might restriction entirely.
  const location = findUnitAnywhere(state, unit.instanceId);
  if (!location) return true;
  const ctx =
    location.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
  return effectiveMight(state, unit, location.ownerIndex, ctx) <= maxMight;
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
      return eligibleTargets(state, playerIndex, targeting.owner, targeting.scope).some((u) =>
        unitWithinMaxMight(state, u, targeting.maxMight),
      );
    case "unitSlots": {
      // Nothing is REQUIRED when min is 0, so nothing can be missing — the
      // empty choice is itself legal ("up to two").
      if (targeting.min === 0) return true;
      const first = eligibleTargets(state, playerIndex, slotOwner(targeting.slots[0]), targeting.scope);
      if (targeting.min === 1) return first.length > 0;
      const second = eligibleTargets(state, playerIndex, slotOwner(targeting.slots[1]), targeting.scope);
      // Two slots must be two DISTINCT units — mirrors the fan-out's own
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
