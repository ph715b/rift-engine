import type { CardInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import type { EffectContext } from "./effect-context.js";
import {
  buffAllFriendlies,
  buffUnit,
  dealDamage,
  dealDamageToEnemyUnitsAtBattlefield,
  destroyUnit,
  drawCards,
  exhaustOwnUnitAnywhere,
  recallUnitToBase,
  returnCardFromTrash,
  returnUnitToHand,
} from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { channelRunesForcedExhausted } from "./channel-cost.js";
import { findUnitOnBattlefield } from "./target-lookup.js";

/**
 * What a card's effect needs from the player before it can resolve — kept
 * as DATA (not part of the resolver function) because target/choice
 * selection happens in validate-play-card.ts/legal-actions.ts, before a
 * PlayCardAction is ever submitted; `resolve` below only ever runs against
 * an already-fully-decided event.
 */
export type TargetingSpec =
  | { kind: "none" }
  | { kind: "unit"; owner?: "friendly" | "enemy"; maxMight?: number }
  | { kind: "battlefield" }
  | { kind: "ownTrashCard"; cardKind?: "Unit" | "Spell" }
  | { kind: "unitPair"; firstOwner: "friendly" | "enemy"; secondOwner: "friendly" | "enemy" };

/** Everything about the caster's choice(s) needed to resolve an effect —
 *  all optional since most effects only need a subset (or none). */
export interface ResolveEvent {
  targetUnitInstanceId?: string;
  /** The second target of a "unitPair"-kind effect (Gentlemen's Duel) —
   *  `targetUnitInstanceId` above is always the FIRST (firstOwner) target. */
  secondTargetUnitInstanceId?: string;
  targetBattlefieldId?: string;
  trashCardInstanceId?: string;
  /** The friendly unit exhausted as Meditation's optional additional cost
   *  ("you may exhaust a friendly unit... if you do, draw 2") — absent means
   *  the caster declined it. See cardHasOptionalExhaustCost below. */
  additionalCostUnitInstanceId?: string;
}

export interface EffectDefinition {
  targeting: TargetingSpec;
  resolve: (state: GameState, ctx: EffectContext, event: ResolveEvent) => GameState;
}

/** Every battlefield unit belonging to `playerId`, across every
 *  battlefield, in a fixed deterministic order (battlefield array order) —
 *  used by cards that auto-select multiple targets rather than offering a
 *  real player choice (see the doc comment on OGN-206 below for why). */
function battlefieldUnitIdsFor(state: GameState, playerId: string): string[] {
  return state.battlefields.flatMap((bf) => (bf.units[playerId] ?? []).map((u) => u.instanceId));
}

/** Every battlefield unit, either owner, same deterministic order. */
function allBattlefieldUnitIds(state: GameState): string[] {
  return state.battlefields.flatMap((bf) => Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId)));
}

/** Cards whose additional cost is an OPTIONAL friendly-unit exhaust
 *  (Meditation: "you may exhaust a friendly unit... if you do, draw 2") —
 *  the choice must already be decided in the submitted action (fanned into
 *  a "decline" variant plus one variant per ready friendly unit by
 *  legal-actions.ts), same reasoning as every other targeting choice in
 *  this file, just orthogonal to TargetingSpec since it's a COST, not a
 *  target the effect acts on. */
const OPTIONAL_EXHAUST_COST_DEF_IDS = new Set(["OGN-048"]); // Meditation

export function cardHasOptionalExhaustCost(defId: string): boolean {
  return OPTIONAL_EXHAUST_COST_DEF_IDS.has(defId);
}

/**
 * The first slice of card-effect resolution, growing one phase at a time
 * per the project's phased card-effects plan — every other Spell/Gear/Unit
 * ability remains an honest no-op at resolution until it's added here,
 * mirroring the Java oracle's own EffectRegistry (registry/EffectRegistry.java),
 * a name-keyed registry of resolver closures, just keyed by defId instead
 * of printed name.
 *
 * Deliberately NOT registered, and why: Cannon Barrage (OGN-127, "Deal 2 to
 * all enemy units in combat") has an effect that only ever has real targets
 * while a Showdown is open — but this engine's reaction-speed timing is
 * still deferred (validate-play-card.ts rejects any PlayCard while a
 * Showdown is open), so this card can only ever be cast when there's
 * nothing "in combat" to hit. Implementing it now would mean writing code
 * that can never actually do anything — left as an honest no-op like any
 * other unregistered card, revisit once reaction-speed/mid-Showdown casting
 * exists.
 */
const CARD_EFFECTS: Record<string, EffectDefinition> = {
  "OGS-003": {
    // Incinerate — Deal 2 to a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 2),
  },
  "OGN-085": {
    // Falling Comet — Deal 6 to a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 6),
  },
  "OGS-022": {
    // Final Spark — Deal 8 to a unit.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 8),
  },
  "OGS-012": {
    // Blast of Power — Kill a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) => destroyUnit(state, event.targetUnitInstanceId!),
  },
  "OGS-024": {
    // Decisive Strike — Give friendly units +2 Might this turn.
    targeting: { kind: "none" },
    resolve: (state, ctx) => buffAllFriendlies(state, ctx.casterIndex, 2),
  },
  "OGN-005": {
    // Disintegrate — Deal 3 to a unit at a battlefield. If this kills it, draw 1.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const location = findUnitOnBattlefield(state, event.targetUnitInstanceId!);
      if (!location) return state;
      const isLethal = location.unit.might + location.unit.bonus - location.unit.damage - 3 <= 0;
      const damaged = dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 3);
      return isLethal ? drawCards(damaged, ctx.casterIndex, 1) : damaged;
    },
  },
  "OGS-002": {
    // Firestorm — Deal 3 to all enemy units at a battlefield.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, event.targetBattlefieldId!, 3),
  },
  "OGN-129": {
    // Confront — Units you play this turn enter ready. Draw 1.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = { ...players[ctx.casterIndex], unitsEnterReadyThisTurn: true };
      return drawCards({ ...state, players }, ctx.casterIndex, 1);
    },
  },
  "OGN-206": {
    // Back to Back — Give two friendly units each +2 Might this turn.
    // The Java oracle itself doesn't do real "choose 2" targeting for this
    // card either (OriginEffects.java's own comment: "Full 'choose 2'
    // targeting arrives with the Part 2 UI" — it auto-picks the first 2).
    // Auto-selecting the first 2 eligible friendly battlefield units
    // (deterministic order, not a real player choice) mirrors that exact,
    // already-oracle-sanctioned simplification rather than building
    // interactive multi-select machinery this round.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const ids = battlefieldUnitIdsFor(state, state.players[ctx.casterIndex].id).slice(0, 2);
      let next = state;
      for (const id of ids) next = buffUnit(next, id, 2);
      return next;
    },
  },
  "OGN-095": {
    // Stupefy — Give a unit -1 Might this turn, to a minimum of 1 Might. Draw 1.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const location = findUnitOnBattlefield(state, event.targetUnitInstanceId!);
      const currentMight = location ? location.unit.might + location.unit.bonus : 0;
      const debuffed = currentMight > 1 ? buffUnit(state, event.targetUnitInstanceId!, -1) : state;
      return drawCards(debuffed, ctx.casterIndex, 1);
    },
  },
  "OGN-046": {
    // En Garde — Give a friendly unit +1 Might this turn, then an
    // additional +1 if it's the only unit the caster controls there.
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const location = findUnitOnBattlefield(state, event.targetUnitInstanceId!);
      const buffed = buffUnit(state, event.targetUnitInstanceId!, 1);
      if (!location) return buffed;
      const bf = state.battlefields[location.battlefieldIndex]!;
      const casterId = state.players[ctx.casterIndex].id;
      const isOnlyUnit = (bf.units[casterId]?.length ?? 0) === 1;
      return isOnlyUnit ? buffUnit(buffed, event.targetUnitInstanceId!, 1) : buffed;
    },
  },
  "OGN-105": {
    // Singularity — Deal 6 to each of up to two units. Same auto-select
    // simplification as Back to Back (see that entry's comment) — first 2
    // eligible battlefield units, either owner, deterministic order.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const ids = allBattlefieldUnitIds(state).slice(0, 2);
      let next = state;
      for (const id of ids) next = dealDamage(next, ctx.casterIndex, id, 6);
      return next;
    },
  },
  "OGS-011": {
    // Flash — Move up to 2 friendly units to base. Same auto-select
    // simplification (see OGN-206's comment).
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const ids = battlefieldUnitIdsFor(state, state.players[ctx.casterIndex].id).slice(0, 2);
      let next = state;
      for (const id of ids) next = recallUnitToBase(next, id);
      return next;
    },
  },
  "OGN-169": {
    // Gust — Return a unit at a battlefield with 3 Might or less to its owner's hand.
    targeting: { kind: "unit", maxMight: 3 },
    resolve: (state, _ctx, event) => returnUnitToHand(state, event.targetUnitInstanceId!),
  },
  "OGN-134": {
    // Mobilize — Channel 1 rune exhausted. If you can't, draw 1.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const actor = state.players[ctx.casterIndex];
      return actor.runeDeck.length > 0
        ? channelRunesForcedExhausted(state, ctx.casterIndex, 1)
        : drawCards(state, ctx.casterIndex, 1);
    },
  },
  "OGN-170": {
    // Morbid Return — Return a unit from your trash to your hand.
    targeting: { kind: "ownTrashCard", cardKind: "Unit" },
    resolve: (state, ctx, event) => returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId!),
  },
  "OGS-020": {
    // Highlander — Choose a friendly unit. The next time it would die this
    // turn, heal it, exhaust it, and recall it instead. Restricted to a
    // battlefield-present friendly (same "unit" targeting shape as En
    // Garde/Gust) since nothing in this engine can currently kill a
    // base-zone unit anyway — dealDamage/destroyUnit both only ever
    // operate on battlefield units (findUnitOnBattlefield).
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, _ctx, event) => ({
      ...state,
      deathWardedUnitInstanceIds: [...state.deathWardedUnitInstanceIds, event.targetUnitInstanceId!],
    }),
  },
  "OGN-048": {
    // Meditation — As an additional cost, you may exhaust a friendly unit.
    // If you do, draw 2. Otherwise draw 1. The unit can be in base OR at a
    // battlefield (the card's text has no battlefield restriction, unlike
    // most "unit" targeting in this file) — see cardHasOptionalExhaustCost.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      if (event.additionalCostUnitInstanceId !== undefined) {
        const exhausted = exhaustOwnUnitAnywhere(state, ctx.casterIndex, event.additionalCostUnitInstanceId);
        return drawCards(exhausted, ctx.casterIndex, 2);
      }
      return drawCards(state, ctx.casterIndex, 1);
    },
  },
  "OGS-008": {
    // Gentlemen's Duel — Give a friendly unit +3 Might this turn. Then
    // choose an enemy unit. They deal damage equal to their Mights to each
    // other. Both Mights are snapshotted (effectiveMight, post-buff) BEFORE
    // either damage instance is dealt, so neither unit's own damage from
    // this exchange can affect the other's dealt amount — mirrors the Java
    // oracle's own resolution order (OriginEffects.java: buff, snapshot
    // both currentMight, then deal both damages).
    targeting: { kind: "unitPair", firstOwner: "friendly", secondOwner: "enemy" },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId!;
      const enemyId = event.secondTargetUnitInstanceId!;
      const buffed = buffUnit(state, friendlyId, 3);

      const friendlyLocation = findUnitOnBattlefield(buffed, friendlyId);
      const enemyLocation = findUnitOnBattlefield(buffed, enemyId);
      if (!friendlyLocation || !enemyLocation) return buffed;

      const friendlyMight = effectiveMight(buffed, friendlyLocation.unit, friendlyLocation.ownerIndex, {
        isCombat: false,
        battlefieldId: buffed.battlefields[friendlyLocation.battlefieldIndex]!.id,
      });
      const enemyMight = effectiveMight(buffed, enemyLocation.unit, enemyLocation.ownerIndex, {
        isCombat: false,
        battlefieldId: buffed.battlefields[enemyLocation.battlefieldIndex]!.id,
      });

      const afterEnemyDamage = dealDamage(buffed, ctx.casterIndex, enemyId, friendlyMight);
      return dealDamage(afterEnemyDamage, ctx.casterIndex, friendlyId, enemyMight);
    },
  },
};

/**
 * Keyed by defId (e.g. "OGS-003"), the stable id every CardInstance/
 * CardDefinition shares (card-loader.ts's deriveId). Hardcoded rather than
 * derived from card text — precise and safe for a handful of cards; not
 * worth a text-parsing scheme until there are enough registered effects to
 * justify one.
 */
export function effectForCard(card: CardInstance): EffectDefinition | undefined {
  return CARD_EFFECTS[card.defId];
}

export function targetingForCard(card: CardInstance): TargetingSpec {
  return effectForCard(card)?.targeting ?? { kind: "none" };
}
