import type { ChainEntry, GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { effectForCard } from "./card-effects.js";
import { findUnitOnBattlefield } from "./target-lookup.js";

/**
 * Deals direct (non-combat) damage to a unit at a battlefield and removes it
 * to its owner's trash if lethal. Lethal threshold is plain
 * `might + bonus - damage <= 0`, with NO keyword bonus — unlike combat.ts's
 * `remainingMight`, which applies [Shield] because that keyword's real text
 * is "+X Might while DEFENDING" (a Showdown-only bonus). Direct spell
 * damage isn't combat, so Shield doesn't apply here; a Shielded unit dies to
 * lethal direct damage the same as an unshielded one.
 */
export function applyDirectDamageAndCheckLethal(state: GameState, targetInstanceId: string, amount: number): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, battlefieldIndex, unit } = location;

  const damagedUnit: UnitInstance = { ...unit, damage: unit.damage + amount };
  const isLethal = damagedUnit.might + damagedUnit.bonus - damagedUnit.damage <= 0;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];

  if (isLethal) {
    battlefields[battlefieldIndex] = {
      ...bf,
      units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
    };
    const players = [...state.players] as [PlayerState, PlayerState];
    players[ownerIndex] = { ...players[ownerIndex], trash: [...players[ownerIndex].trash, damagedUnit] };
    return { ...state, battlefields, players };
  }

  battlefields[battlefieldIndex] = {
    ...bf,
    units: {
      ...bf.units,
      [ownerId]: bf.units[ownerId]!.map((u) => (u.instanceId === targetInstanceId ? damagedUnit : u)),
    },
  };
  return { ...state, battlefields };
}

/** Unconditionally removes a unit at a battlefield to its owner's trash —
 *  no damage/lethal math at all, unlike applyDirectDamageAndCheckLethal. */
export function destroyUnitDirectly(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], trash: [...players[ownerIndex].trash, unit] };
  return { ...state, battlefields, players };
}

/** Adds `amount` to `.bonus` on every unit the caster controls (base +
 *  every battlefield) — a "this turn" buff, expiring for free via
 *  turn-manager.ts's runEnd, which already resets `.bonus` to 0 every End
 *  of Turn for every unit, both players, unconditionally. */
export function buffAllFriendlies(state: GameState, casterIndex: 0 | 1, amount: number): GameState {
  const caster = state.players[casterIndex];
  const buff = (u: UnitInstance): UnitInstance => ({ ...u, bonus: u.bonus + amount });

  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...caster, baseUnits: caster.baseUnits.map(buff) };

  const battlefields = state.battlefields.map((bf) => {
    const units = bf.units[caster.id];
    if (!units) return bf;
    return { ...bf, units: { ...bf.units, [caster.id]: units.map(buff) } };
  });

  return { ...state, players, battlefields };
}

/**
 * Resolves a popped chain entry's registered effect, if any — no-ops for
 * any card with no CARD_EFFECTS entry, exactly like today (mirrors the Java
 * oracle's own EffectRegistry.has() safe-no-op guard for an unregistered
 * card name).
 */
export function resolveCardEffect(state: GameState, entry: ChainEntry): GameState {
  const effect = effectForCard(entry.card);
  if (!effect) return state;

  switch (effect.kind) {
    case "DealDamage":
      return entry.targetUnitInstanceId
        ? applyDirectDamageAndCheckLethal(state, entry.targetUnitInstanceId, effect.amount)
        : state;
    case "DestroyUnit":
      return entry.targetUnitInstanceId ? destroyUnitDirectly(state, entry.targetUnitInstanceId) : state;
    case "BuffAllFriendlies":
      return buffAllFriendlies(state, entry.playerIndex, effect.amount);
  }
}
