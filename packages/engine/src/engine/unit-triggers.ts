import type { GameState, PlayerState } from "../model/game-state.js";
import type { CardInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
import { targetingForCard, type TargetingSpec } from "./card-effects.js";
import {
  buffOwnUnitAnywhere,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
} from "./effect-helpers.js";
import { createRecruitToken } from "./token.js";

export type UnitPlayDestination = "base" | { battlefieldId: string };

/** Everything a Unit's on-play trigger might need, already fully decided
 *  before executePlayCard ever runs (this engine can't pause mid-
 *  resolution to ask — see card-effects.ts's TargetingSpec doc comment for
 *  the same rule applied to Spells). */
export interface UnitTriggerEvent {
  destination: UnitPlayDestination;
  targetUnitInstanceId?: string;
  visionRecycle?: boolean;
  trashCardInstanceId?: string;
}

export interface UnitTriggerDefinition {
  targeting: TargetingSpec;
  resolve: (state: GameState, ctx: EffectContext, unitInstanceId: string, event: UnitTriggerEvent) => GameState;
}

/** Cards whose entire printed ability is [Vision] ("look at the top card
 *  of your Main Deck. You may recycle it.") — fanned into two distinct
 *  legal PlayCard actions (visionRecycle true/false) by legal-actions.ts,
 *  since the choice must be decided in the submitted action, not asked
 *  mid-resolution. Exported as its own small set rather than folded into
 *  TargetingSpec, since it's an orthogonal axis (Mystic Poro/Sai Scout's
 *  targeting is otherwise "none"). */
const VISION_UNIT_DEF_IDS = new Set(["OGN-171", "OGN-174"]); // Mystic Poro, Sai Scout

export function unitTriggerHasVisionChoice(defId: string): boolean {
  return VISION_UNIT_DEF_IDS.has(defId);
}

/** Cards whose printed text ("You may play me to an open battlefield")
 *  carves out an exception to the universal "reinforce only" rule
 *  (validate-play-card.ts's presence check) — mirrors
 *  ActionValidator.validateUnitDirectToBattlefield's own small hardcoded
 *  exception list (Sneaky Deckhand/Sai Scout/etc., ActionValidator.java:1306-1319). */
const OPEN_PLACEMENT_UNIT_DEF_IDS = new Set(["OGN-176", "OGN-174"]); // Sneaky Deckhand, Sai Scout

export function canPlayToOpenBattlefield(defId: string): boolean {
  return OPEN_PLACEMENT_UNIT_DEF_IDS.has(defId);
}

function applyVision(state: GameState, casterIndex: 0 | 1, recycle: boolean | undefined): GameState {
  if (!recycle) return state; // "keep it on top" — no state change needed
  const actor = state.players[casterIndex];
  if (actor.deck.length === 0) return state;
  const [top, ...rest] = actor.deck;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...actor, deck: [...rest, top!] };
  return { ...state, players };
}

function placeTokenAtDestination(state: GameState, casterIndex: 0 | 1, destination: UnitPlayDestination): GameState {
  const token = createRecruitToken();
  const casterId = state.players[casterIndex].id;

  if (destination === "base") {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[casterIndex] = { ...players[casterIndex], baseUnits: [...players[casterIndex].baseUnits, token] };
    return { ...state, players };
  }

  const bfIndex = state.battlefields.findIndex((bf) => bf.id === destination.battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [casterId]: [...(bf.units[casterId] ?? []), token] } };
  return { ...state, battlefields };
}

/**
 * On-play-unit triggers — the biggest gap this phase closes:
 * execute-play-card.ts's Unit branch previously never fired anything at
 * all on play, only Spells did (via the chain). Mirrors the Java oracle's
 * UnitAbilities.onPlay dispatch (engine/UnitAbilities.java), keyed by
 * defId instead of printed name like card-effects.ts's CARD_EFFECTS.
 */
const UNIT_TRIGGERS: Record<string, UnitTriggerDefinition> = {
  "OGN-171": {
    // Mystic Poro — [Vision]
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => applyVision(state, ctx.casterIndex, event.visionRecycle),
  },
  "OGN-174": {
    // Sai Scout — [Vision] (also open-battlefield placement, handled in validate-play-card.ts)
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => applyVision(state, ctx.casterIndex, event.visionRecycle),
  },
  "OGS-018": {
    // Tibbers — deal 3 to all units at battlefields, both owners.
    targeting: { kind: "none" },
    resolve: (state, ctx) => dealDamageToAllUnitsAtAllBattlefields(state, ctx.casterIndex, 3),
  },
  "OGN-132": {
    // First Mate — ready another unit. (Its own instanceId can't be a
    // legal target: legal-actions.ts enumerates candidates while this card
    // is still in hand, before it exists anywhere on the board.)
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) => readyUnit(state, event.targetUnitInstanceId!),
  },
  "OGN-211": {
    // Faithful Manufactor — play a 1-Might Recruit unit token here (its own destination).
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeTokenAtDestination(state, ctx.casterIndex, event.destination),
  },
  "OGN-191": {
    // Maddened Marauder — move a unit from a battlefield to its base (either owner).
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) => recallUnitToBase(state, event.targetUnitInstanceId!),
  },
  "OGS-010": {
    // Annie - Stubborn — return a spell from your own trash to your hand.
    targeting: { kind: "ownTrashCard", cardKind: "Spell" },
    resolve: (state, ctx, _unitId, event) => returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId!),
  },
};

export function unitTriggerForCard(defId: string): UnitTriggerDefinition | undefined {
  return UNIT_TRIGGERS[defId];
}

export function targetingForUnitTrigger(defId: string): TargetingSpec {
  return UNIT_TRIGGERS[defId]?.targeting ?? { kind: "none" };
}

/** A Unit's targeting comes from its own on-play trigger (this module); a
 *  Spell/Gear's comes from its registered card-effects.ts entry — the two
 *  are separate registries (different resolution mechanism), so this is
 *  the ONE place that branches on card.kind to pick the right one, reused
 *  by validate-play-card.ts, legal-actions.ts, and the web UI, instead of
 *  each re-deriving the same branch independently. */
export function targetingForAnyCard(card: CardInstance): TargetingSpec {
  return card.kind === "Unit" ? targetingForUnitTrigger(card.defId) : targetingForCard(card);
}

/** True when `card` needs a chosen unit, battlefield, or trash card before
 *  it can resolve — a plain boolean convenience for callers (like the web
 *  UI) that only need to know "does this require a choice," not the full
 *  spec. */
export function cardNeedsTarget(card: CardInstance): boolean {
  const kind = targetingForAnyCard(card).kind;
  return kind === "unit" || kind === "battlefield" || kind === "ownTrashCard" || kind === "unitPair";
}

/** Fires `unit`'s registered on-play trigger, if any — no-ops for any Unit
 *  with no registered trigger, same safe-no-op convention as
 *  card-effect-resolution.ts's resolveCardEffect. */
export function dispatchOnPlayUnit(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  destination: UnitPlayDestination,
  extra?: { targetUnitInstanceId?: string; visionRecycle?: boolean; trashCardInstanceId?: string },
): GameState {
  const trigger = UNIT_TRIGGERS[unit.defId];
  if (!trigger) return state;
  return trigger.resolve(state, contextFor(casterIndex), unit.instanceId, {
    destination,
    ...(extra?.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: extra.targetUnitInstanceId } : {}),
    ...(extra?.visionRecycle !== undefined ? { visionRecycle: extra.visionRecycle } : {}),
    ...(extra?.trashCardInstanceId !== undefined ? { trashCardInstanceId: extra.trashCardInstanceId } : {}),
  });
}

/** On-attack triggers — fired once per unit that just landed on a battlefield
 *  which turned out to be contested (execute-move-unit.ts / execute-play-card.ts's
 *  Unit-to-battlefield branch), before the Showdown window opens. Crackshot
 *  Corsair's and Dune Drake's targets are auto-selected (deterministic order)
 *  rather than offering a real player choice — same simplification
 *  precedent as card-effects.ts's Back to Back/Singularity entries (the
 *  Java oracle's own OriginEffects.java admits doing the same for at least
 *  one card: "Full 'choose 2' targeting arrives with the Part 2 UI"). */
const ON_ATTACK_TRIGGERS: Record<string, (state: GameState, ctx: EffectContext, unit: UnitInstance, battlefieldId: string) => GameState> = {
  "OGN-130": (state, ctx, unit, battlefieldId) => {
    // Crackshot Corsair — deal 1 to an enemy unit here (auto-selects the first one found).
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const enemyId = Object.entries(bf.units)
      .find(([ownerId]) => ownerId !== casterId)?.[1]
      .find((u) => u.instanceId !== unit.instanceId)?.instanceId;
    return enemyId ? dealDamage(state, ctx.casterIndex, enemyId, 1) : state;
  },
  "OGN-131": (state, ctx, unit, battlefieldId) => {
    // Dune Drake — +2 Might this turn if there's a ready enemy unit here.
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const hasReadyEnemy = Object.entries(bf.units).some(
      ([ownerId, units]) => ownerId !== casterId && units.some((u) => !u.exhausted),
    );
    return hasReadyEnemy ? buffOwnUnitAnywhere(state, ctx.casterIndex, unit.instanceId, 2) : state;
  },
};

export function dispatchOnAttack(state: GameState, unit: UnitInstance, casterIndex: 0 | 1, battlefieldId: string): GameState {
  const trigger = ON_ATTACK_TRIGGERS[unit.defId];
  if (!trigger) return state;
  return trigger(state, contextFor(casterIndex), unit, battlefieldId);
}

/** On-move triggers — fired once per completed move, contested or not
 *  (execute-move-unit.ts), independent of on-attack above. */
const ON_MOVE_TRIGGERS: Record<string, (state: GameState, ctx: EffectContext, unit: UnitInstance, battlefieldId: string) => GameState> = {
  "OGN-185": (state, ctx) => {
    // Traveling Merchant — When I move, discard 1, then draw 1.
    const actor = state.players[ctx.casterIndex];
    if (actor.hand.length === 0) return drawCardsAfterDiscard(state, ctx.casterIndex);
    const players = [...state.players] as [PlayerState, PlayerState];
    players[ctx.casterIndex] = { ...actor, hand: actor.hand.slice(1), trash: [...actor.trash, actor.hand[0]!] };
    return drawCardsAfterDiscard({ ...state, players }, ctx.casterIndex);
  },
  "OGN-222": (state, ctx, unit, battlefieldId) => {
    // Noxian Drummer — When I move to a battlefield, play a 1-Might Recruit unit token here.
    return placeTokenAtDestination(state, ctx.casterIndex, { battlefieldId });
  },
};

function drawCardsAfterDiscard(state: GameState, casterIndex: 0 | 1): GameState {
  const actor = state.players[casterIndex];
  if (actor.deck.length === 0) return state;
  const [drawn, ...rest] = actor.deck;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...actor, deck: rest, hand: [...actor.hand, drawn!] };
  return { ...state, players };
}

export function dispatchOnMove(state: GameState, unit: UnitInstance, casterIndex: 0 | 1, battlefieldId: string): GameState {
  const trigger = ON_MOVE_TRIGGERS[unit.defId];
  if (!trigger) return state;
  return trigger(state, contextFor(casterIndex), unit, battlefieldId);
}

/** On-spell-cast listeners — units that react to THEIR OWN controller
 *  casting a spell ("When you play a spell..."), fired once per resolved
 *  Spell (execute-pass-focus.ts's chain resolution), scanning only the
 *  caster's own units (base + battlefields) for a registered listener —
 *  never the opponent's, matching the printed "you" in both cards' text. */
const ON_SPELL_CAST_TRIGGERS: Record<string, (state: GameState, ctx: EffectContext, unit: UnitInstance, spellEnergyCost: number) => GameState> = {
  "OGN-103": (state, ctx, unit) => buffOwnUnitAnywhere(state, ctx.casterIndex, unit.instanceId, 1), // Ravenbloom Student
  "OGS-006": (state, ctx, unit, spellEnergyCost) =>
    spellEnergyCost >= 5 ? buffOwnUnitAnywhere(state, ctx.casterIndex, unit.instanceId, 3) : state, // Lux - Illuminated
};

export function dispatchOnSpellCast(state: GameState, casterIndex: 0 | 1, spellEnergyCost: number): GameState {
  const actor = state.players[casterIndex];
  const ownUnits: UnitInstance[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
  ];
  let next = state;
  const ctx = contextFor(casterIndex);
  for (const unit of ownUnits) {
    const trigger = ON_SPELL_CAST_TRIGGERS[unit.defId];
    if (!trigger) continue;
    next = trigger(next, ctx, unit, spellEnergyCost);
  }
  return next;
}
