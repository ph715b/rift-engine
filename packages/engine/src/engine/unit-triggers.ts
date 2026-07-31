import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { CardInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
import { targetingForCard, type TargetingSpec } from "./card-effects.js";
import {
  giveMightThisTurnToOwnUnit,
  channelRunesExhausted,
  dealDamage,
  discardCards,
  drawCards,
  dealDamageToAllUnitsAtAllBattlefields,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
} from "./effect-helpers.js";
import { placeRecruitToken, type TokenDestination } from "./token.js";
import { domainUnitTriggers, mergeRegistries } from "./effects/index.js";

export type UnitPlayDestination = TokenDestination;

/** Everything a Unit's on-play trigger might need, already fully decided
 *  before executePlayCard ever runs (this engine can't pause mid-
 *  resolution to ask — see card-effects.ts's TargetingSpec doc comment for
 *  the same rule applied to Spells). */
export interface UnitTriggerEvent {
  destination: UnitPlayDestination;
  targetUnitInstanceId?: string;
  visionRecycle?: boolean;
  trashCardInstanceId?: string;
  /** The friendly unit named for this card's OPTIONAL additional cost, or
   *  undefined when the caster declined it — the same field a Spell already
   *  carries (see card-effects.ts's OPTIONAL_UNIT_COSTS). Absent here until
   *  Wildclaw Shaman needed it, which forced its "you may" onto the ordinary
   *  target field and lost the decline whenever every friendly unit was buffed. */
  additionalCostUnitInstanceId?: string;
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

/**
 * Is this battlefield **open**? Rule 170.11.c defines it exactly: "Battlefields
 * can be 'open.' This means they are **unoccupied and uncontrolled**."
 *
 * Both halves, and neither is redundant: a battlefield can be uncontrolled with
 * units standing on it (mid-Showdown, or after a control lapse), and a
 * controlled one can be momentarily empty before the Cleanup lapses it.
 */
export function isOpenBattlefield(battlefield: BattlefieldState): boolean {
  const occupied = Object.values(battlefield.units).some((units) => units.length > 0);
  return !occupied && battlefield.controllerId === null;
}

/**
 * May `defId` be played straight to `battlefield` on the strength of an
 * open-battlefield grant?
 *
 * One predicate rather than the two-part conjunction written out at each call
 * site, because the two sites are the validator and the enumerator and they must
 * never disagree — that specific drift has bitten this codebase before.
 *
 * **This used to be `canPlayToOpenBattlefield` alone**, which asked only whether
 * the CARD had the grant and never whether the battlefield was open. So Sai
 * Scout and Sneaky Deckhand could be played anywhere at all: onto a battlefield
 * you already controlled (reported from playtesting), and — worse — onto one the
 * OPPONENT held, which applies Contested and opens a Showdown, turning "play me
 * to an open battlefield" into a free 5-Might attack.
 */
export function mayPlaceOnOpenBattlefield(defId: string, battlefield: BattlefieldState): boolean {
  return canPlayToOpenBattlefield(defId) && isOpenBattlefield(battlefield);
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

/** Token placement moved to token.ts once a Spell (Recruit the Vanguard)
 *  needed it too — see placeRecruitToken's own doc comment for why it can't
 *  live in either caller. */
const placeTokenAtDestination = placeRecruitToken;

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
    // The `?:` guards here and below are load-bearing, not defensive noise:
    // a Unit is playable with its trigger's target OMITTED when the board
    // offered no legal one (validate-play-card.ts's targetOmissionAllowed),
    // so these resolvers really do run with nothing to act on.
    // "Ready another unit" names no battlefield, so a unit in base — the
    // likeliest thing you have exhausted — is a legal target.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? readyUnit(state, event.targetUnitInstanceId) : state,
  },
  "OGN-211": {
    // Faithful Manufactor — play a 1-Might Recruit unit token here (its own destination).
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeTokenAtDestination(state, ctx.casterIndex, event.destination),
  },
  "OGN-191": {
    // Maddened Marauder — move a unit from a battlefield to its base (either owner).
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
  },
  "OGS-010": {
    // Annie - Stubborn — return a spell from your own trash to your hand.
    targeting: { kind: "ownTrashCard", cardKind: "Spell" },
    resolve: (state, ctx, _unitId, event) =>
      event.trashCardInstanceId ? returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId) : state,
  },
  "OGN-087": {
    // Lecturing Yordle — "When you play me, draw 1." Its [Tank] keyword is a
    // combat-damage-ordering property (combat.ts), not part of this trigger.
    //
    // Was silently doing nothing despite being in a precon deck: the card is a
    // 3-of in Lux's list, so a real game drew one fewer card than it should
    // roughly every third game. Found by simulating the play and watching the
    // deck size not move, not by reading the code.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "OGN-137": {
    // Stormclaw Ursine — "When you play me, channel 1 rune exhausted." Also
    // [Tank]. Exhausted, so it can pay a Power cost this turn (a Power payment
    // recycles the rune regardless of state) but not an Energy one until Awaken
    // readies it — see channelRunesExhausted.
    targeting: { kind: "none" },
    resolve: (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1),
  },
};

/**
 * Every Unit on-play trigger: the ones written inline above plus whatever the
 * per-domain files under `effects/` contribute, merged with duplicate detection.
 * NEW units belong in `effects/<domain>.ts` — see the note on ALL_CARD_EFFECTS in
 * card-effects.ts for why the inline entries stay put.
 */
/** Composed lazily for the same import-cycle reason as ALL_CARD_EFFECTS in
 *  card-effects.ts — see that comment. */
let composedUnitTriggers: Record<string, UnitTriggerDefinition> | null = null;

function allUnitTriggers(): Record<string, UnitTriggerDefinition> {
  composedUnitTriggers ??= mergeRegistries("unit trigger", [
    { name: "engine/unit-triggers.ts", entries: UNIT_TRIGGERS },
    { name: "engine/effects/*", entries: domainUnitTriggers },
  ]);
  return composedUnitTriggers;
}

export function unitTriggerForCard(defId: string): UnitTriggerDefinition | undefined {
  return allUnitTriggers()[defId];
}

export function targetingForUnitTrigger(defId: string): TargetingSpec {
  return allUnitTriggers()[defId]?.targeting ?? { kind: "none" };
}

/** Every defId with a registered on-play trigger — see cardEffectDefIds. */
export function unitTriggerDefIds(): string[] {
  return [
    ...Object.keys(allUnitTriggers()),
    // The on-attack / on-move / on-spell-cast registries below are separate
    // dispatch tables with their own event, and reporting only the on-play one
    // marked seven working cards as inert — Crackshot Corsair, Dune Drake,
    // Traveling Merchant, Noxian Drummer, Ravenbloom Student, Lux - Illuminated
    // and Sneaky Deckhand. They're declared here rather than in coverage.ts so
    // a new event table in this file is one edit, not two.
    ...Object.keys(ON_ATTACK_TRIGGERS),
    ...Object.keys(ON_MOVE_TRIGGERS),
    ...Object.keys(ON_SPELL_CAST_TRIGGERS),
    ...OPEN_PLACEMENT_UNIT_DEF_IDS,
  ];
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
  const targeting = targetingForAnyCard(card);
  switch (targeting.kind) {
    case "unit":
    case "battlefield":
    case "ownTrashCard":
      return true;
    // "Up to two" (min 0) still needs a choice from the player even though
    // none of it is mandatory — the point of this pass is that WHICH units
    // get hit is theirs to decide, so the card must arm rather than fire.
    case "unitSlots":
      return true;
    default:
      return false;
  }
}

/** Fires `unit`'s registered on-play trigger, if any — no-ops for any Unit
 *  with no registered trigger, same safe-no-op convention as
 *  card-effect-resolution.ts's resolveCardEffect. */
export function dispatchOnPlayUnit(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  destination: UnitPlayDestination,
  extra?: {
    targetUnitInstanceId?: string;
    visionRecycle?: boolean;
    trashCardInstanceId?: string;
    additionalCostUnitInstanceId?: string;
  },
): GameState {
  // allUnitTriggers(), NOT the inline UNIT_TRIGGERS table: this read used to go
  // straight to the inline one, so a Unit registered in a per-domain effects
  // file validated, cost runes, deployed — and then its ability silently never
  // ran. Nothing caught it because no per-domain file had registered a Unit yet,
  // which is exactly when a per-card implementation pass would have hit it.
  const trigger = allUnitTriggers()[unit.defId];
  if (!trigger) return state;
  return trigger.resolve(state, contextFor(casterIndex), unit.instanceId, {
    destination,
    ...(extra?.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: extra.targetUnitInstanceId } : {}),
    ...(extra?.visionRecycle !== undefined ? { visionRecycle: extra.visionRecycle } : {}),
    ...(extra?.trashCardInstanceId !== undefined ? { trashCardInstanceId: extra.trashCardInstanceId } : {}),
    ...(extra?.additionalCostUnitInstanceId !== undefined
      ? { additionalCostUnitInstanceId: extra.additionalCostUnitInstanceId }
      : {}),
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
    return hasReadyEnemy ? giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 2) : state;
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
    // Traveling Merchant — "When I move, discard 1, then draw 1."
    //
    // This is where the front-of-hand discard convention started, inlined here.
    // It now routes through the shared discardCards, so the Deathknell discards
    // and this one can't drift apart on what "discard" means, and "then" keeps
    // the freshly drawn card out of the discard.
    return drawCards(discardCards(state, ctx.casterIndex, 1), ctx.casterIndex, 1);
  },
  "OGN-222": (state, ctx, unit, battlefieldId) => {
    // Noxian Drummer — When I move to a battlefield, play a 1-Might Recruit unit token here.
    return placeTokenAtDestination(state, ctx.casterIndex, { battlefieldId });
  },
};

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
const ON_SPELL_CAST_TRIGGERS: Record<string, (state: GameState, ctx: EffectContext, unit: UnitInstance, spellTotalCost: number) => GameState> = {
  "OGN-103": (state, ctx, unit) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 1), // Ravenbloom Student
  // Lux - Illuminated — "costs 5 or more" is Energy PLUS Power (see the call
  // site in execute-pass-focus.ts; this used to be handed energyCost alone).
  "OGS-006": (state, ctx, unit, spellTotalCost) =>
    spellTotalCost >= 5 ? giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 3) : state,
};

export function dispatchOnSpellCast(state: GameState, casterIndex: 0 | 1, spellTotalCost: number): GameState {
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
    next = trigger(next, ctx, unit, spellTotalCost);
  }
  return next;
}
