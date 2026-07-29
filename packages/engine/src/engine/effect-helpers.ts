import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { effectiveMight } from "./effective-might.js";
import { modifiedDamageAmount } from "./damage-modifiers.js";
import { isDeathWarded, reviveWithDeathWard } from "./death-ward.js";
import { findUnitOnBattlefield } from "./target-lookup.js";

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/**
 * Deals direct (non-combat) damage to a unit at a battlefield and removes it
 * to its owner's trash if lethal. `casterIndex` feeds damage-modifiers.ts's
 * modifiedDamageAmount (Annie - Fiery's +1-to-all-damage) — the single
 * choke point every damage-dealing card/trigger routes through, so no call
 * site has to remember to apply it itself. Lethal threshold routes through
 * effectiveMight with isCombat:false, so continuous auras (Garen - Commander,
 * Master Yi - Meditative) still apply, but [Shield]/[Assault] do NOT —
 * unlike combat.ts's remainingMight, which applies [Shield] because that
 * keyword's real text is "+X Might while DEFENDING" (a Showdown-only
 * bonus). Direct spell damage isn't combat, so Shield doesn't apply here;
 * a Shielded unit dies to lethal direct damage the same as an unshielded one.
 */
export function dealDamage(state: GameState, casterIndex: 0 | 1, targetInstanceId: string, amount: number): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, battlefieldIndex, unit } = location;
  const bfId = state.battlefields[battlefieldIndex]!.id;
  const modifiedAmount = modifiedDamageAmount(state, casterIndex, amount);

  const damagedUnit: UnitInstance = { ...unit, damage: unit.damage + modifiedAmount };
  const isLethal = effectiveMight(state, unit, ownerIndex, { isCombat: false, battlefieldId: bfId }) - damagedUnit.damage <= 0;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];

  if (isLethal) {
    battlefields[battlefieldIndex] = {
      ...bf,
      units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
    };
    const stateAfterRemoval = { ...state, battlefields };
    if (isDeathWarded(state, targetInstanceId)) {
      return reviveWithDeathWard(stateAfterRemoval, damagedUnit, ownerIndex);
    }
    const players = [...state.players] as [PlayerState, PlayerState];
    players[ownerIndex] = { ...players[ownerIndex], trash: [...players[ownerIndex].trash, damagedUnit] };
    return { ...stateAfterRemoval, players };
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
 *  no damage/lethal math at all, unlike dealDamage — but still a "death,"
 *  so still honors Highlander's ward the same way dealDamage does. */
export function destroyUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };
  const stateAfterRemoval = { ...state, battlefields };

  if (isDeathWarded(state, targetInstanceId)) {
    return reviveWithDeathWard(stateAfterRemoval, unit, ownerIndex);
  }

  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], trash: [...players[ownerIndex].trash, unit] };
  return { ...stateAfterRemoval, players };
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

/** Adds `amount` to a single unit's `.bonus` (a "this turn" buff/debuff,
 *  same expiry as buffAllFriendlies — negative amount is a debuff). No-ops
 *  if the target isn't found at any battlefield. */
export function buffUnit(state: GameState, targetInstanceId: string, amount: number): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, battlefieldIndex, unit } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: {
      ...bf.units,
      [ownerId]: bf.units[ownerId]!.map((u) => (u.instanceId === targetInstanceId ? { ...u, bonus: unit.bonus + amount } : u)),
    },
  };
  return { ...state, battlefields };
}

/** Draws up to `count` cards for `playerIndex`, stopping early (not
 *  crashing) if the deck runs out — matches this codebase's existing
 *  "documented, weaker-than-real-rules gap, not a crash" Burn Out
 *  convention (turn-manager.ts's runDraw) rather than modeling Burn Out's
 *  real trash-recycle-and-award-a-point rule here too. */
export function drawCards(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  return updatePlayer(state, playerIndex, (p) => {
    if (count <= 0 || p.deck.length === 0) return p;
    const drawn = p.deck.slice(0, count);
    return { ...p, deck: p.deck.slice(count), hand: [...p.hand, ...drawn] };
  });
}

/** Removes a unit from its battlefield and adds it to its OWNER's hand
 *  (not necessarily the caster's) — resets damage/bonus/exhausted since
 *  it's leaving play entirely and may be replayed fresh, unlike
 *  recallUnitToBase (which keeps a unit "in play," just relocated). */
export function returnUnitToHand(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };

  const returned: UnitInstance = { ...unit, damage: 0, bonus: 0, exhausted: false };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], hand: [...players[ownerIndex].hand, returned] };
  return { ...state, battlefields, players };
}

/** Moves a unit from its battlefield to its OWNER's base, exhausted —
 *  "retreating costs your readiness," the same rule execute-recall-unit.ts
 *  already applies for the player-initiated RecallUnit action. Unlike that
 *  action (self-only, validated against the acting player), this works on
 *  either owner's units, since some card effects (Flash: friendly-only:
 *  Maddened Marauder: either owner) need to move a unit that isn't
 *  necessarily the caster's own. */
export function recallUnitToBase(state: GameState, targetInstanceId: string): GameState {
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
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, { ...unit, exhausted: true }] };
  return { ...state, battlefields, players };
}

/** Sets a unit's `exhausted` to false regardless of its current state —
 *  First Mate's "ready another unit." No-ops if not found at a battlefield
 *  (base-zone units aren't a target here since none of this round's cards
 *  need it — widen findUnitOnBattlefield's search the day one does). */
export function readyUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, battlefieldIndex } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.map((u) => (u.instanceId === targetInstanceId ? { ...u, exhausted: false } : u)) },
  };
  return { ...state, battlefields };
}

/** Deals `amount` damage to every enemy (relative to `casterIndex`) unit at
 *  one battlefield — Firestorm's "all enemy units at a battlefield." Reads
 *  the unit list ONCE up front so units killed by an earlier iteration
 *  don't shrink the list mid-loop (dealDamage is safe to call on an
 *  already-removed id — it just no-ops via findUnitOnBattlefield). */
export function dealDamageToEnemyUnitsAtBattlefield(
  state: GameState,
  casterIndex: 0 | 1,
  battlefieldId: string,
  amount: number,
): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const casterId = state.players[casterIndex].id;
  const targetIds = Object.entries(bf.units)
    .filter(([ownerId]) => ownerId !== casterId)
    .flatMap(([, units]) => units.map((u) => u.instanceId));

  let next = state;
  for (const id of targetIds) next = dealDamage(next, casterIndex, id, amount);
  return next;
}

/** Deals `amount` damage to every unit at every battlefield, both owners —
 *  Tibbers' "deal 3 to all units at battlefields." Same up-front-snapshot
 *  reasoning as dealDamageToEnemyUnitsAtBattlefield. */
export function dealDamageToAllUnitsAtAllBattlefields(state: GameState, casterIndex: 0 | 1, amount: number): GameState {
  const targetIds = state.battlefields.flatMap((bf) => Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId)));
  let next = state;
  for (const id of targetIds) next = dealDamage(next, casterIndex, id, amount);
  return next;
}

/** Moves a card from `playerIndex`'s own trash to their own hand — Morbid
 *  Return ("a unit from your trash") and Annie-Stubborn's on-play trigger
 *  ("a spell from your trash"). Resets a returned Unit's damage/bonus/
 *  exhausted (same "leaving play, may be replayed fresh" reasoning as
 *  returnUnitToHand) — a Spell has no such fields to reset. No-ops if the
 *  card isn't in that player's trash. */
export function returnCardFromTrash(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const card = actor.trash.find((c) => c.instanceId === cardInstanceId);
  if (!card) return state;

  const returned = card.kind === "Unit" ? { ...card, damage: 0, bonus: 0, exhausted: false } : card;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    trash: actor.trash.filter((c) => c.instanceId !== cardInstanceId),
    hand: [...actor.hand, returned],
  };
  return { ...state, players };
}

/** Adds `amount` to a unit's `.bonus` regardless of whether it's in base or
 *  at a battlefield — needed for on-spell-cast listeners (Ravenbloom
 *  Student, Lux-Illuminated), which can legitimately sit in either zone,
 *  unlike buffUnit above (battlefield-only, matching this round's
 *  deliberate simplification for player-targeted buffs — see En Garde's
 *  registry entry). No-ops if `unitInstanceId` isn't found in either zone
 *  of `playerIndex`'s own units. */
export function buffOwnUnitAnywhere(state: GameState, playerIndex: 0 | 1, unitInstanceId: string, amount: number): GameState {
  const actor = state.players[playerIndex];
  const inBase = actor.baseUnits.some((u) => u.instanceId === unitInstanceId);
  if (inBase) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = {
      ...actor,
      baseUnits: actor.baseUnits.map((u) => (u.instanceId === unitInstanceId ? { ...u, bonus: u.bonus + amount } : u)),
    };
    return { ...state, players };
  }
  return buffUnit(state, unitInstanceId, amount);
}

/** Exhausts a unit `playerIndex` owns, wherever it is (base or a
 *  battlefield) — Meditation's optional additional cost ("exhaust a
 *  friendly unit"), which unlike most targeted effects in this codebase
 *  isn't restricted to battlefield-only. No-ops if not found in either of
 *  that player's own zones. */
export function exhaustOwnUnitAnywhere(state: GameState, playerIndex: 0 | 1, unitInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const inBase = actor.baseUnits.some((u) => u.instanceId === unitInstanceId);
  if (inBase) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = {
      ...actor,
      baseUnits: actor.baseUnits.map((u) => (u.instanceId === unitInstanceId ? { ...u, exhausted: true } : u)),
    };
    return { ...state, players };
  }
  const location = findUnitOnBattlefield(state, unitInstanceId);
  if (!location || location.ownerIndex !== playerIndex) return state;
  const { ownerId, battlefieldIndex } = location;
  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.map((u) => (u.instanceId === unitInstanceId ? { ...u, exhausted: true } : u)) },
  };
  return { ...state, battlefields };
}
