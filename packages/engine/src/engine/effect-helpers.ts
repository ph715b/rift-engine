import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import type { Keyword } from "../model/keyword.js";
import { effectiveMight } from "./effective-might.js";
import { modifiedDamageAmount } from "./damage-modifiers.js";
import { matchesPowerDomain } from "./rune-payment.js";
import { isDeathWarded, reviveWithDeathWard } from "./death-ward.js";
import { dispatchEvent, dispatchOnUnitDied, dispatchSelfEvent } from "./triggers.js";
// legend-abilities imports drawCards from here, so this is a cycle — the same
// safe shape as the triggers.ts one above: the binding is only read inside
// stunUnits, long after both modules have initialised.
import { dispatchLegendOnUnitsStunned, offerDeathReplacement } from "./legend-abilities.js";
import { parkDecision } from "./decisions.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
import { applyContested } from "./cleanup.js";

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/**
 * Applies `change` to one unit wherever it is in play — base or battlefield.
 * The single place base-vs-battlefield branching lives: five helpers below
 * (damage, buff, ready, destroy, return-to-hand) all act on "a unit," and
 * Riftbound's text only sometimes restricts that to a battlefield, so each of
 * them would otherwise carry its own copy of this fork. No-ops if the unit
 * isn't in play at all, same convention as every other "target vanished" path.
 */
function updateUnitAnywhere(state: GameState, targetInstanceId: string, change: (unit: UnitInstance) => UnitInstance): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, zone } = location;
  const replace = (u: UnitInstance) => (u.instanceId === targetInstanceId ? change(u) : u);

  if (zone === "base") {
    return updatePlayer(state, ownerIndex, (p) => ({ ...p, baseUnits: p.baseUnits.map(replace) }));
  }
  const bf = state.battlefields[zone.battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[zone.battlefieldIndex] = { ...bf, units: { ...bf.units, [ownerId]: bf.units[ownerId]!.map(replace) } };
  return { ...state, battlefields };
}

/** Removes a unit from play (base or battlefield) WITHOUT deciding where it
 *  goes next — callers add it to trash/hand/base themselves, since that
 *  differs per effect (a kill trashes, Gust returns to hand, a death ward
 *  recalls). Counterpart to updateUnitAnywhere above. */
function removeUnitAnywhere(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, zone } = location;

  if (zone === "base") {
    return updatePlayer(state, ownerIndex, (p) => ({
      ...p,
      baseUnits: p.baseUnits.filter((u) => u.instanceId !== targetInstanceId),
    }));
  }
  const bf = state.battlefields[zone.battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[zone.battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };
  return { ...state, battlefields };
}

/**
 * The single place a unit dies.
 *
 * There were three: dealDamage's lethal branch, destroyUnit, and combat.ts's
 * processDefeated, each re-checking the death ward independently. Deathknell is
 * why that had to become one — rule 808 fires on ANY death, so three sites means
 * three chances to forget, and a forgotten one is invisible (the unit still dies,
 * its ability just never happens).
 *
 * `unit` must ALREADY be removed from wherever it was; `death` carries the
 * location and attributes it had at that moment, which rule 809.1.b.3 requires
 * be captured before the card reaches the trash.
 *
 * Order, and why:
 *  1. Death ward first. A warded death is *replaced*, not a death — so the
 *     Deathknell must not fire, which rule 809.1.b.1 states outright. Returning
 *     early here is that rule, not an optimisation.
 *  2. The Buff comes off (rule 709, "if a Unit leaves play, remove all Buffs
 *     from it") before the card lands in the trash, so a returned-from-trash copy
 *     can't smuggle a buff back into play.
 *  3. Trash, then triggers — the trigger has to see a board where the unit is
 *     already gone, or "all units at my battlefield" would include the corpse.
 */
export function killUnit(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  battlefieldId?: string,
  /** Who did it, when anyone did — see DeathContext.killerIndex. */
  killerIndex?: 0 | 1,
): GameState {
  if (isDeathWarded(state, unit.instanceId)) {
    return reviveWithDeathWard(state, unit, ownerIndex);
  }

  const death: PendingDeath = {
    unit,
    ownerIndex,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
    ...(killerIndex !== undefined ? { killerIndex } : {}),
  };

  // A replacement that has to be OFFERED, not one armed in advance. Asked before
  // the trash step for the same reason the ward is checked before it: 809.1.b.1
  // makes a replaced death not a death, so the card must not reach the trash and
  // the Deathknell must not fire while the answer is outstanding.
  const offer = offerDeathReplacement(state, death);
  if (offer) return offer;

  return completeDeath(state, death);
}

/**
 * The ordinary end of a death — trash, then triggers.
 *
 * Split out of killUnit so a DECLINED replacement offer can resume exactly here,
 * rather than re-entering killUnit and being offered the same replacement again
 * forever.
 */
export function completeDeath(state: GameState, death: PendingDeath): GameState {
  const { unit, ownerIndex } = death;
  const trashed: UnitInstance = unit.buffed ? { ...unit, buffed: false } : unit;
  // The per-turn tally is bumped HERE rather than in killUnit, so a death that
  // was replaced (Sett) or warded (Highlander) does not count — neither of those
  // is a unit dying, and Spoils of War prices itself off units that actually did.
  const inTrash = updatePlayer(state, ownerIndex, (p) => ({
    ...p,
    trash: [...p.trash, trashed],
    unitsLostThisTurn: p.unitsLostThisTurn + 1,
  }));
  return dispatchOnUnitDied(inTrash, death);
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
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerIndex, zone, unit } = location;
  const modifiedAmount = modifiedDamageAmount(state, casterIndex, amount);

  const damagedUnit: UnitInstance = { ...unit, damage: unit.damage + modifiedAmount };
  // A base unit has no battlefield id — continuous auras keyed on location
  // (Garen - Commander) resolve it as "base" from the omitted field.
  const mightCtx = zone === "base" ? { isCombat: false } : { isCombat: false, battlefieldId: state.battlefields[zone.battlefieldIndex]!.id };
  const isLethal = effectiveMight(state, unit, ownerIndex, mightCtx) - damagedUnit.damage <= 0;

  if (isLethal) {
    const stateAfterRemoval = removeUnitAnywhere(state, targetInstanceId);
    // The damaged copy, not `unit` — a Deathknell reading "my" attributes
    // (rule 809.1.b.3) must see the state the unit died in.
    return killUnit(
      stateAfterRemoval,
      damagedUnit,
      ownerIndex,
      zone === "base" ? undefined : state.battlefields[zone.battlefieldIndex]!.id,
      // Damage that kills is a kill BY whoever dealt it — the one place a killer
      // was already known and simply had nowhere to go.
      casterIndex,
    );
  }

  return updateUnitAnywhere(state, targetInstanceId, () => damagedUnit);
}

/** Unconditionally removes a unit at a battlefield to its owner's trash —
 *  no damage/lethal math at all, unlike dealDamage — but still a "death,"
 *  so still honors Highlander's ward the same way dealDamage does.
 *
 *  `killerIndex` is optional rather than required because this funnel serves
 *  both a Kill Instruction with someone behind it (Blast of Power, Hidden Blade)
 *  and a death with nobody (a `[Temporary]` unit expiring at end of turn). */
export function destroyUnit(state: GameState, targetInstanceId: string, killerIndex?: 0 | 1): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex, zone } = location;

  const stateAfterRemoval = removeUnitAnywhere(state, targetInstanceId);
  return killUnit(
    stateAfterRemoval,
    unit,
    ownerIndex,
    zone === "base" ? undefined : state.battlefields[zone.battlefieldIndex]!.id,
    killerIndex,
  );
}

/**
 * Removes all marked damage from every unit in play — both players, base and
 * every battlefield.
 *
 * The rules heal at TWO moments and both are global: combat cleanup
 * (rule 461.1.a, "immediately after the combat damage has been dealt") and
 * the end of a player's turn. Crucially, combat cleanup "clears all marked
 * damage from every unit on the board, including units that were not involved
 * in the combat" (RiftJudge FAQ 7750/8993) — so a unit softened by a Spell at
 * some OTHER battlefield, or sitting in base, heals when an unrelated fight
 * finishes. Healing does NOT happen after a non-combat (uncontested) showdown
 * (FAQ 9016), which is why combat.ts only reaches this after a real exchange.
 *
 * Shared by turn-manager.ts's runEnd and combat.ts's cleanup so the two can't
 * drift on what "heal" covers.
 */
export function healAllUnits(state: GameState): GameState {
  const clear = (u: UnitInstance): UnitInstance => (u.damage === 0 ? u : { ...u, damage: 0 });

  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(clear) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(clear);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * "Give friendly units +N Might this turn" (Grand Strategem, Decisive Strike) —
 * every unit the caster controls, base and every battlefield.
 *
 * A this-turn modifier, expiring for free via turn-manager.ts's runEnd, which
 * resets `.mightThisTurn` to 0 every End of Turn for every unit, both players,
 * unconditionally. This is NOT buffing: see addBuff below for the game object
 * that persists.
 */
export function giveMightThisTurnToAllFriendlies(state: GameState, casterIndex: 0 | 1, amount: number): GameState {
  const caster = state.players[casterIndex];
  const grant = (u: UnitInstance): UnitInstance => ({ ...u, mightThisTurn: u.mightThisTurn + amount });

  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...caster, baseUnits: caster.baseUnits.map(grant) };

  const battlefields = state.battlefields.map((bf) => {
    const units = bf.units[caster.id];
    if (!units) return bf;
    return { ...bf, units: { ...bf.units, [caster.id]: units.map(grant) } };
  });

  return { ...state, players, battlefields };
}

/**
 * "Give a unit +N Might this turn" — negative `amount` is a debuff (Smoke
 * Screen, Orb of Regret). Works on a unit anywhere in play: En Garde and Stupefy
 * say "a unit," not "a unit at a battlefield". No-ops if the target isn't in
 * play.
 *
 * `floor` implements the "to a minimum of 1 Might" clause several debuffs carry.
 * It is applied against the unit's printed Might plus its accumulated this-turn
 * modifier, so a second -4 on an already-floored unit takes nothing further off
 * rather than digging a hole that a later buff would have to climb out of. Buffs
 * and continuous auras are deliberately NOT counted: they can appear and vanish
 * after this resolves, and the floor is fixed at resolution time.
 */
export function giveMightThisTurn(
  state: GameState,
  targetInstanceId: string,
  amount: number,
  floor?: number,
): GameState {
  return updateUnitAnywhere(state, targetInstanceId, (u) => {
    if (floor === undefined) return { ...u, mightThisTurn: u.mightThisTurn + amount };
    const lowest = floor - u.might;
    return { ...u, mightThisTurn: Math.max(lowest, u.mightThisTurn + amount) };
  });
}

/**
 * Grants `[Temporary]` (rule 816) to a unit at a battlefield or to a gear —
 * Fading Memories' "give a unit at a battlefield **or a gear** [Temporary]".
 *
 * One helper over both because the card makes one choice across both kinds, and
 * the caller should not have to know which it got. Multiple instances are
 * redundant (817.1.a), so re-granting is a harmless no-op.
 *
 * No-ops when the id names nothing in play — the usual "target vanished"
 * convention.
 */
export function grantTemporary(state: GameState, permanentInstanceId: string): GameState {
  const asUnit = findUnitAnywhere(state, permanentInstanceId);
  if (asUnit) {
    return updateUnitAnywhere(state, permanentInstanceId, (u) => ({
      ...u,
      keywords: { ...u.keywords, Temporary: 1 },
    }));
  }

  const players = [...state.players] as [PlayerState, PlayerState];
  let touched = false;
  for (const index of [0, 1] as const) {
    const owner = players[index];
    if (!owner.activeGear.some((g) => g.instanceId === permanentInstanceId)) continue;
    players[index] = {
      ...owner,
      activeGear: owner.activeGear.map((g) =>
        g.instanceId === permanentInstanceId ? { ...g, keywords: { ...g.keywords, Temporary: 1 } } : g,
      ),
    };
    touched = true;
  }
  return touched ? { ...state, players } : state;
}

/** Does this unit carry a Buff? The read half of rule 707's one-buff-at-a-time
 *  rule, and what "While I'm buffed" / "Other buffed friendly units" ask. */
export function isBuffed(unit: UnitInstance): boolean {
  return unit.buffed;
}

/**
 * `[Legion]` — "Get the effect if you've played **another** card this turn."
 *
 * `countingSelf` is not a convenience, it is the whole correctness of this
 * predicate, and getting it wrong is invisible: the effect simply happens a turn
 * too eagerly. `execute-play-card` increments `cardsPlayedThisTurn` as part of
 * the same update that puts the card into play, BEFORE `dispatchOnPlayUnit`
 * runs — so by the time a Legion on-play trigger asks, the count already
 * includes the card asking.
 *
 *  - **Cost time** (`countingSelf: false`) — the card has not been played yet,
 *    so one other card is one card: `>= 1`.
 *  - **Trigger time** (`countingSelf: true`) — this card is already counted, so
 *    "another" needs `>= 2`.
 *
 * Darius - Hand of Noxus reads "if you've played **a** card this turn" rather
 * than "another", because a Legend ability is not a card being played and
 * increments nothing; his check is the cost-time one and lives with his ability.
 */
export function legionActive(state: GameState, playerIndex: 0 | 1, countingSelf: boolean): boolean {
  return state.players[playerIndex].cardsPlayedThisTurn >= (countingSelf ? 2 : 1);
}

/**
 * "Give enemy units -N Might this turn" (Thousand-Tailed Watcher) — every unit
 * the OPPONENT of `casterIndex` controls, base and every battlefield.
 *
 * The mirror of `giveMightThisTurnToAllFriendlies` above, and separate from it
 * rather than a parameterised version, because the two differ in more than the
 * sign: this one carries a `floor` (every enemy-side debuff in this pool states
 * "to a minimum of 1"), and routing through `giveMightThisTurn` per unit is what
 * applies that floor per unit rather than to the group.
 */
export function giveMightThisTurnToAllEnemies(
  state: GameState,
  casterIndex: 0 | 1,
  amount: number,
  floor?: number,
): GameState {
  const enemyIndex: 0 | 1 = casterIndex === 0 ? 1 : 0;
  const enemy = state.players[enemyIndex];
  const targets = [
    ...enemy.baseUnits.map((u) => u.instanceId),
    ...state.battlefields.flatMap((bf) => (bf.units[enemy.id] ?? []).map((u) => u.instanceId)),
  ];
  return targets.reduce((next, id) => giveMightThisTurn(next, id, amount, floor), state);
}

/**
 * Pays `count` Power of `domain` out of channeled runes, for the costs that are
 * NOT part of a PlayCardAction — Flame Chompers' "you may pay [Fury] to play me"
 * and Mistfall's "you may pay [Body] and exhaust this".
 *
 * Returns undefined when it cannot be paid, the same contract `spendBuff` and
 * `recycleFromTrash` use (416.3's "the action must be able to be completed for
 * the cost to be paid"), so the option is simply never offered rather than
 * handing over the payoff for free.
 *
 * Paying Power RECYCLES the rune — 416's "puts it on the bottom of the
 * corresponding deck", not an exhaust — and a rune that was still Ready when it
 * went had Energy-paying potential that recycling wastes, so it banks 1 floating
 * Energy. Both halves mirror executeFloatRune's Power mode exactly; they are the
 * same act, and two versions of it would drift.
 */
export function payPowerFromChanneled(
  state: GameState,
  playerIndex: 0 | 1,
  /** `null` is RAINBOW — any domain pays, rule 811's pip and Sett - The Boss's.
   *  Asked through `matchesPowerDomain`, which already means exactly that, so
   *  rainbow needed no new cost machinery here either. */
  domain: Domain | null,
  count: number,
): GameState | undefined {
  const actor = state.players[playerIndex];
  const spend = actor.channeled.filter((r) => matchesPowerDomain(r, domain)).slice(0, count);
  if (spend.length < count) return undefined;

  const spentIds = new Set(spend.map((r) => r.id));
  const readyCredit = spend.filter((r) => r.state === "Ready").length;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    channeled: p.channeled.filter((r) => !spentIds.has(r.id)),
    runeDeck: [...p.runeDeck, ...spend.map((r) => ({ ...r, state: "Ready" as const }))],
    floatingEnergy: p.floatingEnergy + readyCredit,
  }));
}

/**
 * Buffs a unit — rule 702.3.a, "a player chooses a Unit and then places a buff
 * on it".
 *
 * Rule 708 makes this idempotent rather than cumulative: "If a Buff is added, or
 * instructed to be added, on a Unit that already has a Buff, it is not placed
 * instead." That is exactly why several cards read "buff me. (If I don't have a
 * buff, I get a +1 Might buff.)" — the reminder text is describing the no-op.
 * Returns the state unchanged when the unit is already buffed or isn't in play.
 */
export function addBuff(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  // "When you BUFF a friendly unit" (Mistfall) is about a buff actually being
  // placed. 708 makes a second one on an already-buffed unit a no-op, and the
  // event has to agree — otherwise re-buffing a buffed unit would offer the
  // ready-me trigger over and over for nothing. Checked before the update, since
  // updateUnitAnywhere rebuilds the state either way.
  if (!location || location.unit.buffed) return updateUnitAnywhere(state, targetInstanceId, (u) => u);

  const buffed = updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, buffed: true }));
  return dispatchEvent(buffed, { kind: "unitBuffed", ownerIndex: location.ownerIndex, unitInstanceId: targetInstanceId });
}

/**
 * Moves a unit to a battlefield because an EFFECT said so — Charm's "Move an
 * enemy unit."
 *
 * Deliberately not `executeMoveUnit`, and the difference is a rule rather than
 * convenience. **415.1.b**: "a unit's Standard Move exhausts the unit **as a
 * cost**" — the exhaust belongs to the Standard Move action, not to the act of
 * moving, and **316.7.c** lists a move as possibly "the result of a Standard Move
 * Intrinsic Ability, a **Spell**, or other Game Effect". So a unit charmed across
 * the board arrives READY. Reusing the move executor would have exhausted it,
 * silently making Charm a removal-and-tap rather than a reposition.
 *
 * Contested still applies, and applies for the MOVED unit's controller —
 * **458**: "the Destination becomes Contested if it is an Uncontested Battlefield
 * not controlled by the controller of the Unit or Units that moved". Charming an
 * enemy onto neutral ground therefore contests it for THEM, which is the card's
 * real use and not something a caster-indexed call would have got right.
 *
 * On-move triggers deliberately do NOT fire: they read "when I move" on cards
 * whose controller chose to move them, and no card in this pool has one that
 * could be reached this way. Named here rather than left to be discovered.
 */
export function forceMoveToBattlefield(state: GameState, targetInstanceId: string, destinationBattlefieldId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex } = location;
  const destinationIndex = state.battlefields.findIndex((bf) => bf.id === destinationBattlefieldId);
  if (destinationIndex < 0) return state;
  // Already there: nothing moved, so nothing is contested by it either.
  if (location.zone !== "base" && state.battlefields[location.zone.battlefieldIndex]!.id === destinationBattlefieldId) {
    return state;
  }

  const removed = removeUnitAnywhere(state, targetInstanceId);
  const battlefields = [...removed.battlefields];
  const destination = battlefields[destinationIndex]!;
  battlefields[destinationIndex] = {
    ...destination,
    units: { ...destination.units, [ownerId]: [...(destination.units[ownerId] ?? []), unit] },
  };

  return applyContested({ ...removed, battlefields }, destinationBattlefieldId, ownerIndex);
}

/**
 * Grants a keyword to a unit for the rest of the turn — Udyr's "Give me
 * [Ganking] this turn".
 *
 * Lands on `keywordsThisTurn` rather than `keywords`, so it expires at runEnd
 * with the rest of this turn's state and cannot be smuggled into a later turn by
 * a card that reads the printed set.
 */
export function grantKeywordThisTurn(state: GameState, targetInstanceId: string, keyword: Keyword): GameState {
  return updateUnitAnywhere(state, targetInstanceId, (u) => ({
    ...u,
    keywordsThisTurn: { ...u.keywordsThisTurn, [keyword]: Math.max(u.keywordsThisTurn[keyword] ?? 0, 1) },
  }));
}

/**
 * Stuns a unit — rule 422's Stun section. The PRIMITIVE: it changes the flag and
 * fires nothing.
 *
 * A no-op on an already-stunned unit, because "a Stunned Unit can not be Stunned
 * again" — and that is a real distinction, not tidiness: the rules' own example
 * is Eclipse Herald, which triggers "when you stun an enemy unit" and does NOT
 * trigger when the chosen unit was already stunned. Returning the state
 * unchanged is what makes that card correct.
 *
 * **A card implementation must call `stunUnits` below, not this.** This one is
 * for tests that need a stunned unit as a fixture, where there is no stunner and
 * inventing one would be a lie. Every real stun has a player behind it, and
 * Eclipse Herald / Leona - Radiant Dawn are watching for exactly that.
 */
export function stunUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location || location.unit.stunned) return state;
  return updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, stunned: true }));
}

/**
 * "`stunnerIndex` stuns these units" — the funnel every card's stun goes
 * through, and the only thing that fires the `unitsStunned` event.
 *
 * **One event for the whole instruction, not one per unit**, and the card text
 * forces it: Leona - Radiant Dawn reads "When you stun **one or more** enemy
 * units, buff a friendly unit" — one buff however many were stunned — while
 * Eclipse Herald reads "When you stun **an** enemy unit" and wants one trigger
 * each. A per-unit event would silently make Leona fire twice for Facebreaker;
 * a batch payload lets each listener read it its own way.
 *
 * Only units that ACTUALLY became stunned are reported. Rule 422's "a Stunned
 * Unit can not be Stunned again" means re-stunning is not a stunning, so it must
 * not offer Eclipse Herald its ready-me trigger over and over for nothing —
 * exactly the reasoning `addBuff` uses for `unitBuffed` under rule 708. A stun
 * that changed nothing at all fires no event and returns the state untouched.
 *
 * The Legend is dispatched separately because `allListeningPermanents` walks
 * base units, battlefield units and gear — a Legend is not on the board and no
 * listener walk can reach it. Board listeners resolve first, then each player's
 * Legend in turn order.
 */
export function stunUnits(state: GameState, stunnerIndex: 0 | 1, targetInstanceIds: readonly string[]): GameState {
  const stunned: { unitInstanceId: string; ownerIndex: 0 | 1 }[] = [];
  let next = state;
  for (const id of targetInstanceIds) {
    const location = findUnitAnywhere(next, id);
    if (!location || location.unit.stunned) continue;
    next = stunUnit(next, id);
    stunned.push({ unitInstanceId: id, ownerIndex: location.ownerIndex });
  }
  if (stunned.length === 0) return state;

  const event = { kind: "unitsStunned", stunnerIndex, stunned } as const;
  return dispatchLegendOnUnitsStunned(dispatchEvent(next, event), event);
}

/**
 * Spends a unit's Buff — rule 704.1, "Spending a Buff removes a single Buff
 * counter from a Unit".
 *
 * Returns undefined rather than an unchanged state when the spend is illegal, so
 * callers can't silently get the effect without paying: rule 705 forbids spending
 * from an unbuffed unit and 705.1 restricts it to units you control, and both are
 * costs for cards that give you something in return (Wildclaw Shaman, Udyr -
 * Wildman). A no-op state would hand over the payoff for free.
 */
export function spendBuff(state: GameState, playerIndex: 0 | 1, targetInstanceId: string): GameState | undefined {
  const owner = state.players[playerIndex];
  const ownsIt =
    owner.baseUnits.some((u) => u.instanceId === targetInstanceId) ||
    state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some((u) => u.instanceId === targetInstanceId));
  if (!ownsIt) return undefined;

  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location?.unit.buffed) return undefined;

  return updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, buffed: false }));
}

/**
 * Discards cards from `playerIndex`'s hand to their trash.
 *
 * Nine cards in the presets discard, and they split into two shapes that this
 * one function has to serve:
 *
 *  - **Already decided**, when the choice rode in on the submitted action (Get
 *    Excited!, Brazen Buccaneer). Pass `chosenInstanceIds`.
 *  - **Not yet decided**, which is every [Deathknell] and every on-move trigger,
 *    because a trigger has no action to carry a choice on. Omit
 *    `chosenInstanceIds` and this STOPS AND ASKS (engine/decisions.ts).
 *
 * Asking replaces a documented front-of-hand simplification: the rules give the
 * discarding player the choice in both cases, and the engine simply had no way
 * to ask until pending decisions existed. Discarding fewer than `count` when the
 * hand is short is correct, not a shortcut — "discard 2" with one card in hand
 * discards that one (422), and a hand no bigger than `count` is not a choice at
 * all, so it goes without a prompt.
 */
export function discardCards(
  state: GameState,
  playerIndex: 0 | 1,
  count: number,
  chosenInstanceIds?: readonly string[],
  /**
   * Suppresses the `cardsDiscarded` event. Set ONLY by the `discard` decision as
   * it takes one card at a time: a "discard 2" the player chooses for arrives
   * here twice, and Jinx - Rebel's "one or more cards" must pay out once for the
   * instruction, not once per answer. The decision fires the event itself when
   * the last card is gone.
   */
  options?: { suppressEvent?: boolean },
): GameState {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];

  // Nobody named a card, and there is more than one to choose from — so ask.
  // This used to take the front of hand and say so apologetically; the rules
  // give the discarding player the choice, and now the engine can stop to ask
  // (engine/decisions.ts).
  //
  // Only when there is a real choice: "discard 2" holding exactly two cards is
  // not a decision, and opening a prompt to confirm it would be theatre. The
  // fall-through below still takes the whole hand in that case, which is also
  // what makes "discard 2" with one card in hand discard that one (422).
  if (chosenInstanceIds === undefined && actor.hand.length > count) {
    return parkDecision(state, { kind: "discard", playerIndex, count });
  }

  const chosen =
    chosenInstanceIds === undefined
      ? actor.hand.slice(0, count)
      : actor.hand.filter((c) => chosenInstanceIds.includes(c.instanceId)).slice(0, count);
  if (chosen.length === 0) return state;

  const discardedIds = new Set(chosen.map((c) => c.instanceId));
  const moved = updatePlayer(state, playerIndex, (p) => ({
    ...p,
    hand: p.hand.filter((c) => !discardedIds.has(c.instanceId)),
    trash: [...p.trash, ...chosen],
    // Raging Soul asks whether you have discarded THIS TURN, so the fact has to
    // outlive the discard itself. Set here rather than at each call site, since
    // this is the one funnel every discard goes through.
    discardedThisTurn: true,
  }));

  // A card can trigger on being discarded (Scrapheap), and at that moment it is
  // in the trash rather than in play — so it is dispatched by its own defId, not
  // found by walking the board. Fired after the move, so the trigger sees the
  // finished zones.
  const selfTriggered = chosen.reduce((next, c) => dispatchSelfEvent(next, "discarded", c, playerIndex), moved);

  // Then the board event, ONCE for the whole instruction (Jinx - Rebel's "one or
  // more cards"). After the per-card self-triggers, so a card that plays itself
  // out of the trash on being discarded has already done so.
  if (options?.suppressEvent) return selfTriggered;
  return dispatchEvent(selfTriggered, { kind: "cardsDiscarded", discarderIndex: playerIndex });
}

/**
 * "Discard N, **then** draw M" — Undercover Agent's Deathknell and Traveling
 * Merchant's on-move trigger.
 *
 * Its own function because the "then" is load-bearing and became fragile the
 * moment discarding could stop to ask. Written the obvious way,
 * `drawCards(discardCards(state, i, 2), i, 2)`, the draw now happens while the
 * discard is still a pending question — so the cards just drawn join the hand
 * the player is about to choose discards from, and "a card just drawn can never
 * be one of the cards discarded" silently inverts.
 *
 * The draw is therefore queued BEHIND the questions. It needs no special
 * machinery to do that: a draw is a decision with exactly one option, so
 * `parkDecision` executes it immediately when nothing is being asked and lines
 * it up after the questions when something is.
 */
export function discardThenDraw(state: GameState, playerIndex: 0 | 1, discardCount: number, drawCount: number): GameState {
  return parkDecision(discardCards(state, playerIndex, discardCount), { kind: "draw", playerIndex, count: drawCount });
}

/**
 * Recycles `count` cards from `playerIndex`'s own trash — rule 416: "takes one
 * or more cards from a specific zone and then puts it on the **bottom** of the
 * corresponding deck", and "each player Recycles cards to their own Main Deck
 * … regardless of which player is instructed to perform the Recycle action".
 *
 * Returns `undefined` when the trash holds fewer than `count`, because rule 416.3
 * makes this a payability question, not a do-as-much-as-you-can one: "When
 * Recycling is listed as a Cost, the action must be able to be completed for the
 * cost to be paid." Same contract as `spendBuff` — an unpayable cost must not
 * hand over the payoff, and a no-op state would.
 *
 * Which cards go back is not offered as a choice: taking the front of the trash
 * (the oldest cards) matches `discardCards`' convention, and the alternative —
 * fanning out every subset of a trash that can hold forty cards — is not
 * bounded. Recorded in docs/rules-conformance.md rather than hidden.
 */
export function recycleFromTrash(state: GameState, playerIndex: 0 | 1, count: number): GameState | undefined {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];
  if (actor.trash.length < count) return undefined;

  const recycled = actor.trash.slice(0, count);
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    trash: p.trash.slice(count),
    deck: [...p.deck, ...recycled], // bottom of the deck, per 416
  }));
}

/**
 * Recycles one named card out of a player's HAND — rule 416's "puts it on the
 * bottom of the corresponding deck", applied to a card that was never in the
 * trash (Sabotage).
 *
 * Distinct from `recycleFromTrash` above rather than a parameterised version of
 * it, and the difference is not the zone: that one is a COST and returns
 * undefined when it cannot be paid in full, while this is an effect on a card
 * someone else chose, so a card that has since left the hand is simply a no-op.
 */
export function recycleCardFromHand(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const card = actor.hand.find((c) => c.instanceId === cardInstanceId);
  if (!card) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    hand: p.hand.filter((c) => c.instanceId !== cardInstanceId),
    deck: [...p.deck, card], // bottom, per 416
  }));
}

/**
 * "Look at the top N of your Main Deck. Put 1 into your hand and recycle the
 * rest." (Stacked Deck) — takes `keptInstanceId` from among the top `count` and
 * sends the others to the bottom.
 *
 * Only ever touches the top `count`, so a card named from deeper in the deck
 * cannot be smuggled into hand by a forged answer. Recycling the rest preserves
 * their relative order, which matters because the next Stacked Deck will look at
 * whatever is on top now.
 */
export function takeOneFromTopAndRecycleRest(
  state: GameState,
  playerIndex: 0 | 1,
  count: number,
  keptInstanceId: string,
): GameState {
  const actor = state.players[playerIndex];
  const looked = actor.deck.slice(0, count);
  const kept = looked.find((c) => c.instanceId === keptInstanceId);
  if (!kept) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    deck: [...p.deck.slice(looked.length), ...looked.filter((c) => c.instanceId !== keptInstanceId)],
    hand: [...p.hand, kept],
  }));
}

/**
 * "Recycle me" paid with a unit already in play — Ekko - Recurrent. The unit
 * leaves the board for the BOTTOM of its owner's Main Deck (rule 416).
 *
 * Deliberately NOT a death and deliberately not routed through `killUnit`: a
 * Recycle is a zone change, so no `[Deathknell]` fires, no death-watch sees it,
 * and it never reaches the trash. Its damage and this-turn state are cleared for
 * the same reason `returnUnitToHand` clears them — the card may be drawn and
 * played again fresh.
 */
export function recycleUnitFromPlayToDeck(state: GameState, playerIndex: 0 | 1, unitInstanceId: string): GameState {
  const location = findUnitAnywhere(state, unitInstanceId);
  if (!location || location.ownerIndex !== playerIndex) return state;
  const clean: UnitInstance = {
    ...location.unit,
    damage: 0,
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    exhausted: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movedThisTurn: false,
  };
  const removed = removeUnitAnywhere(state, unitInstanceId);
  return updatePlayer(removed, playerIndex, (p) => ({ ...p, deck: [...p.deck, clean] }));
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

/**
 * Channels `count` runes from a player's rune deck into their channeled pool
 * **exhausted** — Stormclaw Ursine's "channel 1 rune exhausted".
 *
 * Distinct from `turn-manager.runChannel`, which is the Channel *Phase* and
 * always reveals runes Ready. An exhausted rune still counts for Power (a Power
 * cost recycles the rune regardless of its state, see execute-play-card) but
 * cannot pay Energy until it readies at the next Awaken — which is exactly what
 * makes "channel 1 exhausted" weaker than a free rune rather than equivalent.
 *
 * An empty rune deck channels as many as it can and no more, matching
 * runChannel's own "as many as possible if fewer remain" behaviour (rule
 * 315.4.b) rather than throwing.
 */
export function channelRunesExhausted(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  return updatePlayer(state, playerIndex, (p) => {
    if (count <= 0 || p.runeDeck.length === 0) return p;
    const taken = p.runeDeck.slice(0, count).map((r) => ({ ...r, state: "Exhausted" as const }));
    return { ...p, runeDeck: p.runeDeck.slice(taken.length), channeled: [...p.channeled, ...taken] };
  });
}

/** Removes a unit from its battlefield and adds it to its OWNER's hand
 *  (not necessarily the caster's) — resets damage/this-turn Might/exhausted
 *  and removes any Buff (rule 709, "if a Unit leaves play, remove all Buffs
 *  from it") since
 *  it's leaving play entirely and may be replayed fresh, unlike
 *  recallUnitToBase (which keeps a unit "in play," just relocated). */
export function returnUnitToHand(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex } = location;

  const returned: UnitInstance = { ...unit, damage: 0, mightThisTurn: 0, buffed: false, exhausted: false };
  const removed = removeUnitAnywhere(state, targetInstanceId);
  return updatePlayer(removed, ownerIndex, (p) => ({ ...p, hand: [...p.hand, returned] }));
}

/**
 * A true Recall in the rules' sense: relocate a unit to its owner's base
 * WITHOUT touching its state. "A Recall is when a Permanent is relocated from
 * anywhere to its Base without it being a Move... Damage and statuses of a
 * permanent will all remain unaffected by a Recall" (rule 454).
 *
 * Two things this deliberately does NOT do, both load-bearing:
 *   - It does not exhaust. Highlander reads "heal it, exhaust it, and recall
 *     it" precisely because a bare recall leaves readiness alone; the exhaust
 *     comes from the card, not from the recall.
 *   - It fires no move triggers. Recalls are explicitly not Moves (454), so
 *     Traveling Merchant's "when I move, discard 1, then draw 1" and Noxian
 *     Drummer's token must not fire. Do not add a dispatchOnMove call here.
 *
 * Used by combat cleanup step 3d. Distinct from recallUnitToBase below, which
 * force-exhausts for the player-initiated retreat.
 */
export function relocateToBaseUnchanged(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex } = location;
  const removed = removeUnitAnywhere(state, targetInstanceId);
  return updatePlayer(removed, ownerIndex, (p) => ({ ...p, baseUnits: [...p.baseUnits, unit] }));
}

/** Moves a unit from its battlefield to its OWNER's base, exhausted —
 *  "retreating costs your readiness," the same rule execute-recall-unit.ts
 *  already applies for the player-initiated RecallUnit action. Unlike that
 *  action (self-only, validated against the acting player), this works on
 *  either owner's units, since some card effects (Flash: friendly-only:
 *  Maddened Marauder: either owner) need to move a unit that isn't
 *  necessarily the caster's own.
 *
 *  NOTE: whether those two card effects should exhaust at all is an open
 *  question — rule 454 says a Recall leaves statuses untouched, and both cards
 *  say "move"/"to its base" without mentioning exhaustion. Filed as Unverified
 *  in docs/rules-conformance.md rather than changed on a guess. */
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
 *  First Mate's "ready another unit," which names no battlefield and so
 *  reaches a unit in base too (this comment used to say base units "aren't a
 *  target here... widen the search the day one does" — this is that day). */
export function readyUnit(state: GameState, targetInstanceId: string): GameState {
  return updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, exhausted: false }));
}

/**
 * Readies ANY permanent a player controls — a unit in either zone, a Gear, or
 * the Legend.
 *
 * `readyUnit` above deliberately only knows about units, because every card that
 * says "ready a unit" means one. Miss Fortune - Captain says "something else
 * that's exhausted", naming no type at all, so she needs the wider reach — and
 * the Legend zone is not on the board, which is exactly the gap that made Legend
 * abilities unreachable before `findActivatable` learned about it.
 */
export function readyPermanent(state: GameState, playerIndex: 0 | 1, instanceId: string): GameState {
  const ready = <T extends { instanceId: string; exhausted: boolean }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, exhausted: false } : c;

  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  players[playerIndex] = {
    ...actor,
    baseUnits: actor.baseUnits.map(ready),
    activeGear: actor.activeGear.map(ready),
    legend: ready(actor.legend),
  };
  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    return mine ? { ...bf, units: { ...bf.units, [actor.id]: mine.map(ready) } } : bf;
  });
  return { ...state, players, battlefields };
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
 *  ("a spell from your trash"). Resets a returned Unit's damage / this-turn
 *  Might / Buff / exhausted (same "leaving play, may be replayed fresh"
 *  reasoning as returnUnitToHand) — a Spell has no such fields to reset.
 *  No-ops if the card isn't in that player's trash. */
export function returnCardFromTrash(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const card = actor.trash.find((c) => c.instanceId === cardInstanceId);
  if (!card) return state;

  const returned = card.kind === "Unit" ? { ...card, damage: 0, mightThisTurn: 0, buffed: false, exhausted: false } : card;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    trash: actor.trash.filter((c) => c.instanceId !== cardInstanceId),
    hand: [...actor.hand, returned],
  };
  return { ...state, players };
}

/** "Give ME +N Might this turn" for a unit that might be in base OR at a
 *  battlefield — the shape self-buffing listeners need (Ravenbloom Student,
 *  Lux - Illuminated, Dune Drake), which can legitimately sit in either zone.
 *  The only thing this adds over giveMightThisTurn is the ownership check: it
 *  refuses to move an opponent's unit, since every caller's printed text says
 *  "me" or "a friendly unit". */
export function giveMightThisTurnToOwnUnit(state: GameState, playerIndex: 0 | 1, unitInstanceId: string, amount: number): GameState {
  const actor = state.players[playerIndex];
  const owned =
    actor.baseUnits.some((u) => u.instanceId === unitInstanceId) ||
    state.battlefields.some((bf) => (bf.units[actor.id] ?? []).some((u) => u.instanceId === unitInstanceId));
  return owned ? giveMightThisTurn(state, unitInstanceId, amount) : state;
}

/**
 * Exhausts a Gear its owner controls — the exhaust that is a TRIGGER's cost
 * rather than an activated ability's ("you may exhaust this to draw 1", Solari
 * Shrine).
 *
 * Distinct from `activated-abilities.exhaustActivated`, which is reached through
 * an ActivateAbility action and covers all three zones a source can sit in. A
 * trigger has no action, so it cannot go through that path at all; this is the
 * gear-only counterpart. No-ops if the gear is not in play or is already
 * exhausted, so a caller cannot pay the cost twice.
 */
export function exhaustGear(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): GameState {
  const owner = state.players[playerIndex];
  if (!owner.activeGear.some((g) => g.instanceId === gearInstanceId && !g.exhausted)) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    activeGear: p.activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, exhausted: true } : g)),
  }));
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
