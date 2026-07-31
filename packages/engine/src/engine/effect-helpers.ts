import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { effectiveMight } from "./effective-might.js";
import { modifiedDamageAmount } from "./damage-modifiers.js";
import { isDeathWarded, reviveWithDeathWard } from "./death-ward.js";
import { dispatchOnUnitDied, dispatchSelfEvent } from "./triggers.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";

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
export function killUnit(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): GameState {
  if (isDeathWarded(state, unit.instanceId)) {
    return reviveWithDeathWard(state, unit, ownerIndex);
  }

  const trashed: UnitInstance = unit.buffed ? { ...unit, buffed: false } : unit;
  const inTrash = updatePlayer(state, ownerIndex, (p) => ({ ...p, trash: [...p.trash, trashed] }));

  return dispatchOnUnitDied(inTrash, {
    unit,
    ownerIndex,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
  });
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
      ...(zone === "base" ? [] : [state.battlefields[zone.battlefieldIndex]!.id]),
    );
  }

  return updateUnitAnywhere(state, targetInstanceId, () => damagedUnit);
}

/** Unconditionally removes a unit at a battlefield to its owner's trash —
 *  no damage/lethal math at all, unlike dealDamage — but still a "death,"
 *  so still honors Highlander's ward the same way dealDamage does. */
export function destroyUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex, zone } = location;

  const stateAfterRemoval = removeUnitAnywhere(state, targetInstanceId);
  return killUnit(
    stateAfterRemoval,
    unit,
    ownerIndex,
    ...(zone === "base" ? [] : [state.battlefields[zone.battlefieldIndex]!.id]),
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
  return updateUnitAnywhere(state, targetInstanceId, (u) => (u.buffed ? u : { ...u, buffed: true }));
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
 *  - **A chosen discard**, where the player picks. Pass `chosenInstanceIds`. The
 *    engine cannot pause mid-resolution to ask (see card-effects.ts's
 *    TargetingSpec doc comment), so the choice arrives already decided in the
 *    submitted action, the same way `visionRecycle` does.
 *  - **An unchosen discard**, where nobody gets to pick — every [Deathknell] and
 *    every on-move trigger, since there is no action to carry a choice on. Omit
 *    `chosenInstanceIds` and the front of hand is taken.
 *
 * Taking the front of hand is a real simplification and worth naming: the rules
 * give the discarding player the choice in both cases. It follows the precedent
 * Traveling Merchant's on-move trigger already set rather than inventing a second
 * convention, and it is recorded in docs/rules-conformance.md. Discarding fewer
 * than `count` when the hand is short is correct, not a shortcut — "discard 2"
 * with one card in hand discards that one.
 */
export function discardCards(
  state: GameState,
  playerIndex: 0 | 1,
  count: number,
  chosenInstanceIds?: readonly string[],
): GameState {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];

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
  return chosen.reduce((next, c) => dispatchSelfEvent(next, "discarded", c, playerIndex), moved);
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
