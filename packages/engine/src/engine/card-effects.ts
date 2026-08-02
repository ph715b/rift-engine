import type { CardInstance } from "../model/card.js";
import { domainCardEffects, mergeRegistries } from "./effects/index.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import type { EffectContext } from "./effect-context.js";
import {
  giveMightThisTurn,
  giveMightThisTurnToAllFriendlies,
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
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
import { placeRecruitToken, type TokenDestination } from "./token.js";

/**
 * What a card's effect needs from the player before it can resolve — kept
 * as DATA (not part of the resolver function) because target/choice
 * selection happens in validate-play-card.ts/legal-actions.ts, before a
 * PlayCardAction is ever submitted; `resolve` below only ever runs against
 * an already-fully-decided event.
 */
/**
 * Which units a "unit"-style target may be chosen from. Riftbound's card text
 * draws this distinction deliberately and it matters: "Deal 8 to a unit"
 * (Final Spark) can hit a unit standing in either player's BASE, while "Deal 2
 * to a unit at a battlefield" (Incinerate) cannot. Base is not a safe parking
 * spot against the former.
 *
 * Defaults to "battlefield" everywhere it's omitted, which is the majority of
 * this pool — a card only opts into the wider scope when its printed text
 * declines to name a battlefield.
 */
/** Where a "unit"-kind target may be drawn from. `"battlefield"` is the default
 *  because most text says "a unit at a battlefield"; `"anywhere"` is the bare
 *  noun "unit", which 355.9.b makes include Bases. `"base"` is the narrowest and
 *  the newest — Showstopper's "buff a friendly unit IN YOUR BASE, then move it to
 *  a battlefield", where reaching a unit already at a battlefield would make the
 *  move half meaningless. */
export type TargetScope = "battlefield" | "anywhere" | "base";

/** Who may fill one slot of a multi-target spell. `"any"` means either
 *  player's — Singularity's "up to two units" doesn't care whose. */
export type UnitSlotRole = "any" | "friendly" | "enemy";

export type TargetingSpec =
  | { kind: "none" }
  /** `exhaustedOnly` is Arena Bar's "buff an EXHAUSTED friendly unit" — a
   *  restriction on the target's state rather than its owner or its Might, and
   *  the first of that shape. Filtered during enumeration like every other part
   *  of this spec, so a ready unit is never offered and then refused. */
  | { kind: "unit"; owner?: "friendly" | "enemy"; maxMight?: number; scope?: TargetScope; exhaustedOnly?: true }
  | { kind: "battlefield" }
  | { kind: "ownTrashCard"; cardKind?: "Unit" | "Spell" }
  /**
   * Two ordered target slots with a MINIMUM number that must be filled —
   * the shape the Java oracle uses for every multi-target spell
   * (`TargetSpec(int min, List<Role> slotRoles, ...)`, EffectRegistry.java).
   * It subsumes what used to be a fixed `unitPair`:
   *   - Gentlemen's Duel: `min: 2, slots: ["friendly", "enemy"]`
   *   - Singularity:      `min: 0, slots: ["any", "any"]`      ("up to two")
   * `min: 0` is what makes "up to" real, and is why this isn't called
   * `unitPair` any more — a pair whose minimum is zero would be a lie.
   * The two chosen units must always be DISTINCT (no card in this pool lets
   * one unit fill both slots; the oracle's own `allowsDuplicateTargets` flag
   * exists for cards like Falling Star that do, none of which are here).
   */
  /**
   * `sameBattlefield` is Facebreaker's "stun a friendly unit and an enemy unit
   * **at the same battlefield**" — the first card here whose two targets are
   * related to each other rather than each independently legal. It has to be a
   * property of the SPEC rather than a check inside the resolver, because by the
   * time a resolver runs the choice has already been made and validated: a
   * resolver that refused would leave the card paid for and doing nothing.
   *
   * Implies both targets are at a battlefield, so it is only meaningful with the
   * default `scope`.
   */
  | {
      kind: "unitSlots";
      slots: readonly [UnitSlotRole, UnitSlotRole];
      min: number;
      scope?: TargetScope;
      /**
       * Per-slot scope, for the one card whose two targets are scoped
       * DIFFERENTLY: Zenith Blade's "Stun an enemy unit **at a battlefield**.
       * You may move **a friendly unit** to that enemy unit's battlefield." The
       * first half names a battlefield and the second does not, and rule 355.9.b
       * makes that difference load-bearing — the friendly being moved is usually
       * the one sitting at home.
       *
       * Overrides `scope` slot by slot; falls back to it where absent, so every
       * existing card is unaffected.
       */
      slotScopes?: readonly [TargetScope, TargetScope];
      sameBattlefield?: true;
    }
  /**
   * "A unit at a battlefield **or a gear**" — Fading Memories. One choice over
   * two different kinds of permanent, which no other spec expresses: `unit`
   * cannot name a gear, and a second field would let a caster name both.
   *
   * The chosen thing rides on `targetPermanentInstanceId` rather than
   * `targetUnitInstanceId`, so nothing that assumes a unit can be handed a gear.
   */
  | { kind: "unitOrGear" };

/** A slot's role as `eligibleTargets`/validation express owner constraints —
 *  `"any"` is the absence of a constraint, which is `undefined` there. */
export function slotOwner(role: UnitSlotRole): "friendly" | "enemy" | undefined {
  return role === "any" ? undefined : role;
}

/** The scope one slot draws its candidates from — its own if the spec gives it
 *  one, otherwise the spec's. One function rather than the same `??` written out
 *  in the enumerator, the validator and `hasAnyLegalEffectChoice`, which are
 *  exactly the three places that have drifted apart in this codebase before. */
export function slotScope(
  targeting: { scope?: TargetScope; slotScopes?: readonly [TargetScope, TargetScope] },
  slot: 0 | 1,
): TargetScope | undefined {
  return targeting.slotScopes?.[slot] ?? targeting.scope;
}

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
  /** Where a token-creating Spell puts what it creates (Recruit the
   *  Vanguard) — absent means base. Distinct from a "battlefield"-kind
   *  TARGET: nothing is being targeted, the caster is choosing a deployment
   *  zone. See cardPlacesTokens. */
  destinationBattlefieldId?: string;
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the multi-discards nobody names up front (Jinx, Undercover Agent's
   *  Deathknell) go through discardCards, which asks the player instead. */
  discardCardInstanceId?: string;
  /** The unit OR gear chosen by a `unitOrGear`-kind spec. Deliberately not
   *  `targetUnitInstanceId`: every reader of that field assumes a unit. */
  targetPermanentInstanceId?: string;
}

export interface EffectDefinition {
  targeting: TargetingSpec;
  resolve: (state: GameState, ctx: EffectContext, event: ResolveEvent) => GameState;
}

/** The units a `unitSlots` effect was actually pointed at, in slot order,
 *  skipping empty slots — 0, 1 or 2 ids. The three "up to two" cards all
 *  apply the same thing to each chosen unit, so they just iterate this. */
function chosenTargets(event: ResolveEvent): string[] {
  return [event.targetUnitInstanceId, event.secondTargetUnitInstanceId].filter((id): id is string => id !== undefined);
}

/**
 * What a card's OPTIONAL additional cost asks the caster to pick, which decides
 * the candidate list legal-actions.ts fans out:
 *   - `exhaustReadyFriendly` — Meditation, "you may exhaust a friendly unit".
 *   - `spendBuffFriendly`    — Wildclaw Shaman, "you may spend a buff".
 * Both name a friendly unit, but a READY one and a BUFFED one are different
 * sets, so the shape has to be recorded rather than assumed.
 */
export type OptionalUnitCost = "exhaustReadyFriendly" | "spendBuffFriendly" | "killFriendly";

/** Whether the cost may be declined. Rule 805 calls Accelerate an "Optional
 *  Additional Cost"; Cruel Patron's "As an additional cost to play me, kill a
 *  friendly unit" carries no "you may" and so is mandatory — which also makes
 *  the card unplayable with no friendly unit to kill. */
export interface UnitCostSpec {
  kind: OptionalUnitCost;
  mandatory?: true;
  /** Call to Glory's "If you do, **ignore this spell's cost**" — paying the
   *  additional cost replaces the printed one rather than adding to it.
   *
   *  IGNORED, not discounted, so it takes the same shape rule 811 gives a card
   *  played from Hidden: the payment must be EMPTY rather than merely small, and
   *  floating resources and cost modifiers all drop out with it. That also means
   *  the card is castable with no runes at all, which is the whole point — so
   *  affordability must be judged per variant, not once per card. */
  ignoresCostWhenPaid?: true;
}

/**
 * Cards with an optional friendly-unit cost. The choice must already be decided
 * in the submitted action — legal-actions.ts fans out a "decline" variant plus
 * one variant per eligible unit — same reasoning as every other choice in this
 * file, just orthogonal to TargetingSpec because it is a COST, not a target the
 * effect acts on.
 *
 * Units belong here as well as Spells. This was a `Set` gated on
 * `card.kind === "Spell"` at both call sites, which meant a Unit trigger could
 * not express "you may" at all: Wildclaw Shaman had to smuggle the choice onto
 * its ordinary target field, and the decline then vanished in the corner case
 * where every friendly unit was already buffed — turning "you may" into "you
 * must". The decline variant is now always offered.
 */
const OPTIONAL_UNIT_COSTS: Record<string, UnitCostSpec> = {
  "OGN-048": { kind: "exhaustReadyFriendly" }, // Meditation
  "OGN-147": { kind: "spendBuffFriendly" }, // Wildclaw Shaman
  // Cruel Patron — "As an additional cost to play me, kill a friendly unit."
  // No "you may", so there is no decline variant and the card simply cannot be
  // played with nothing of yours to kill.
  "OGN-208": { kind: "killFriendly", mandatory: true },
  // Call to Glory — "As you play this, you may spend a buff as an additional
  // cost. If you do, ignore this spell's cost." Same buff-spending cost as
  // Wildclaw Shaman; what is new is that paying it REPLACES the printed cost.
  "OGN-207": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true },
  // Wallop — "[Action] As you play this, you may spend a buff as an additional
  // cost. If you do, ignore this spell's cost. Ready a unit." Byte-identical in
  // shape to Call to Glory above; the second card in the pool to REPLACE its
  // printed cost rather than discount it, which is why `ignoresCostWhenPaid`
  // was built as a flag rather than as one card's special case.
  "OGN-146": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true },
};

/**
 * Cards that make the caster pick a card from hand to discard.
 *
 * Two different roles, one field, because both are "which card from hand":
 *  - `optional: false` — the discard is part of the EFFECT. Get Excited! deals
 *    damage equal to the discarded card's Energy cost, so which card is chosen
 *    changes the outcome and there is no declining it.
 *  - `optional: true` with an `energyDiscount` — the discard is an additional
 *    COST. Brazen Buccaneer's "you may discard 1 ... reduce my cost by 2", so
 *    declining is a real option and paying changes the price.
 */
export interface DiscardChoiceSpec {
  optional: boolean;
  /** Energy taken off the card's own cost when the discard is paid. */
  energyDiscount?: number;
}

const DISCARD_CHOICE_CARDS: Record<string, DiscardChoiceSpec> = {
  "OGN-008": { optional: false }, // Get Excited! — discard 1, damage = its Energy cost
  "OGN-002": { optional: true, energyDiscount: 2 }, // Brazen Buccaneer — optional cost, -2 Energy
};

/** How this card uses a discard choice, or undefined if it doesn't. */
export function discardChoiceOf(defId: string): DiscardChoiceSpec | undefined {
  return DISCARD_CHOICE_CARDS[defId];
}

/** Which additional cost this card asks for, or undefined if it has none. */
export function optionalUnitCostOf(defId: string): UnitCostSpec | undefined {
  return OPTIONAL_UNIT_COSTS[defId];
}

export function cardHasOptionalExhaustCost(defId: string): boolean {
  return OPTIONAL_UNIT_COSTS[defId] !== undefined;
}

/** Spells that create units and let the caster pick where they land — "your
 *  base or battlefields you control" (Recruit the Vanguard). Orthogonal to
 *  TargetingSpec for the same reason the exhaust cost above is: it's a
 *  DEPLOYMENT zone, not a target the effect acts on, and it rides on the
 *  action's existing `destinationBattlefieldId` rather than a new field.
 *
 *  Note "control", not merely "have units at" — a strictly narrower rule than
 *  the Unit direct-deploy check in validate-play-card.ts, and deliberately so:
 *  the oracle flags the same distinction as a real difference rather than a
 *  copy-paste (ActionValidator.java:1487-1504). */
const TOKEN_PLACEMENT_SPELL_DEF_IDS = new Set(["OGS-015", "OGN-094"]); // Recruit the Vanguard, Sprite Call

export function cardPlacesTokens(defId: string): boolean {
  return TOKEN_PLACEMENT_SPELL_DEF_IDS.has(defId);
}

/** Spells that MOVE their target and so need a destination as well as a target —
 *  Charm's "Move an enemy unit." Rides on the same `destinationBattlefieldId`
 *  the token-placing spells use, for the same reason: it is a place, not a
 *  second target. Unlike those, it is mandatory — a move with nowhere to go is
 *  not a move, so a card here is not offered without one. */
const MOVE_TARGET_SPELL_DEF_IDS = new Set([
  "OGN-043", // Charm — "Move an enemy unit."
  // Showstopper — "Buff a friendly unit in your base, THEN MOVE IT to a
  // battlefield." The move is the second half of one instruction rather than a
  // separate effect, so it needs the same destination field; what differs from
  // Charm is only whose unit it is, which the targeting spec says.
  "OGN-270",
  // Ride The Wind — "[Action] Move a friendly unit and ready it."
  "OGN-173",
  // Stormbringer — "Choose a friendly unit in your base. Deal damage equal to
  // its Might to all enemy units at a battlefield, then move your unit there."
  // The destination is doing double duty here: it names both what is damaged and
  // where the unit ends up. One field, because the card names one battlefield.
  "OGN-250",
]);

export function cardMovesTarget(defId: string): boolean {
  return MOVE_TARGET_SPELL_DEF_IDS.has(defId);
}

/**
 * The first slice of card-effect resolution, growing one phase at a time
 * per the project's phased card-effects plan — every other Spell/Gear/Unit
 * ability remains an honest no-op at resolution until it's added here,
 * mirroring the Java oracle's own EffectRegistry (registry/EffectRegistry.java),
 * a name-keyed registry of resolver closures, just keyed by defId instead
 * of printed name.
 *
 * Cannon Barrage (OGN-127) used to be listed here as deliberately unregistered,
 * because it could only be cast when there was nothing "in combat" to hit. That
 * blocker was reaction-speed timing, which now exists — the card is implemented
 * in effects/body.ts.
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
    // Final Spark — "Deal 8 to a unit." No battlefield named, so this reaches
    // a unit in either player's base too.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 8),
  },
  "OGS-012": {
    // Blast of Power — Kill a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => destroyUnit(state, event.targetUnitInstanceId!, ctx.casterIndex),
  },
  "OGS-024": {
    // Decisive Strike — Give friendly units +2 Might this turn.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllFriendlies(state, ctx.casterIndex, 2),
  },
  "OGN-005": {
    // Disintegrate — Deal 3 to a unit at a battlefield. If this kills it, draw 1.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId!;
      const location = findUnitOnBattlefield(state, targetId);
      if (!location) return state;
      const damaged = dealDamage(state, ctx.casterIndex, targetId, 3);
      // "If this kills it" is answered by the BOARD, not by re-deriving the
      // arithmetic. Doing the math here got it wrong in both directions:
      // it ignored bonus damage (Annie - Fiery makes this deal 4, and she
      // sits in the same precon as this card, so a 4-Might unit died with no
      // draw), and it ignored continuous auras (a 3-Might unit standing with
      // Garen - Commander survives at 4, and drew a card anyway). Checking
      // the owner's trash also gets Highlander's ward right for free — a
      // warded unit is recalled to base instead of dying, so it never lands
      // in trash and correctly yields no draw.
      const died = damaged.players[location.ownerIndex].trash.some((c) => c.instanceId === targetId);
      return died ? drawCards(damaged, ctx.casterIndex, 1) : damaged;
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
    // Back to Back — "Give two friendly units each +2 Might this turn." No
    // battlefield named, so units at home count.
    //
    // `min: 0`, not 2, even though the text says "two": with only one friendly
    // unit the card still buffs that one rather than being uncastable. Same
    // "do as much as you can rather than withhold the card" rule the on-play
    // triggers follow (project owner's call). The oracle auto-picks here
    // (`Math.min(2, friendlies.size())`, OriginEffects.java:343-346) — that's
    // an oracle gap, not a rules statement: WHICH two units get +2 is a real
    // decision, so it's the player's.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 0, scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = giveMightThisTurn(next, id, 2);
      return next;
    },
  },
  "OGN-095": {
    // Stupefy — "Give a unit -1 Might this turn, to a minimum of 1 Might.
    // Draw 1." No battlefield named — reaches base units, either player's.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      // The floor is on the unit's REAL Might, so it routes through
      // effectiveMight like every other Might question — a unit printed at 1
      // but standing at 2 under an aura can still be debuffed by this.
      const currentMight = location
        ? effectiveMight(
            state,
            location.unit,
            location.ownerIndex,
            location.zone === "base"
              ? { isCombat: false }
              : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id },
          )
        : 0;
      const debuffed = currentMight > 1 ? giveMightThisTurn(state, event.targetUnitInstanceId!, -1) : state;
      return drawCards(debuffed, ctx.casterIndex, 1);
    },
  },
  "OGN-046": {
    // En Garde — "Give a friendly unit +1 Might this turn, then an additional
    // +1 if it is the only unit you control there." Names no battlefield, so
    // a unit in your own base is a legal target, and "there" then means the
    // base: a lone unit at home gets the full +2, exactly as a lone unit at a
    // battlefield does. (Project owner's rules call — base is a location.)
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      const boosted = giveMightThisTurn(state, event.targetUnitInstanceId!, 1);
      if (!location) return boosted;
      const caster = state.players[ctx.casterIndex];
      const unitsThere =
        location.zone === "base"
          ? caster.baseUnits.length
          : (state.battlefields[location.zone.battlefieldIndex]!.units[caster.id]?.length ?? 0);
      return unitsThere === 1 ? giveMightThisTurn(boosted, event.targetUnitInstanceId!, 1) : boosted;
    },
  },
  "OGN-105": {
    // Singularity — "Deal 6 to each of up to two units." Either owner's, and
    // no battlefield named so base counts.
    //
    // This used to auto-pick the first two units in play, which was not a
    // simplification but a self-inflicted wound: that list started with the
    // CASTER's own base units, so casting it with two units at home dealt 6
    // to each of them. Now it only ever hits what the caster actually chose.
    targeting: { kind: "unitSlots", slots: ["any", "any"], min: 0, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = dealDamage(next, ctx.casterIndex, id, 6);
      return next;
    },
  },
  "OGS-011": {
    // Flash — "Move up to 2 friendly units to base." Battlefield-scoped on
    // purpose despite naming no battlefield: moving a unit that's already in
    // base TO base is a no-op, so offering it as a target would be offering
    // a choice that does nothing.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 0 },
    resolve: (state, _ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = recallUnitToBase(next, id);
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
    // Highlander — "Choose a friendly unit. The next time it would die this
    // turn, heal it, exhaust it, and recall it instead." This used to be
    // battlefield-only on the reasoning that nothing could kill a base unit
    // anyway — no longer true now that dealDamage/destroyUnit reach base
    // (Final Spark, Singularity), so warding a unit at home is a real play.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
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
    // Neither target names a battlefield, so either duellist may be standing
    // in its owner's base. `min: 2` — unlike the "up to two" cards, a duel
    // needs both participants, so this stays uncastable without them.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId!;
      const enemyId = event.secondTargetUnitInstanceId!;
      const boosted = giveMightThisTurn(state, friendlyId, 3);

      const friendlyLocation = findUnitAnywhere(boosted, friendlyId);
      const enemyLocation = findUnitAnywhere(boosted, enemyId);
      if (!friendlyLocation || !enemyLocation) return boosted;

      const mightCtx = (location: typeof friendlyLocation) =>
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: boosted.battlefields[location.zone.battlefieldIndex]!.id };
      const friendlyMight = effectiveMight(boosted, friendlyLocation.unit, friendlyLocation.ownerIndex, mightCtx(friendlyLocation));
      const enemyMight = effectiveMight(boosted, enemyLocation.unit, enemyLocation.ownerIndex, mightCtx(enemyLocation));

      const afterEnemyDamage = dealDamage(boosted, ctx.casterIndex, enemyId, friendlyMight);
      return dealDamage(afterEnemyDamage, ctx.casterIndex, friendlyId, enemyMight);
    },
  },
  "OGS-015": {
    // Recruit the Vanguard — "Play four 1-Might Recruit unit tokens. (They
    // can be played to your base or to battlefields you control.)"
    //
    // All four go to ONE chosen destination, matching the oracle's own
    // resolution (`for (int i = 0; i < 4; i++) ctx.createRecruitToken(
    // ctx.chosenBattlefield())`, OriginEffects.java:672-674) — the card's
    // parenthetical describes where tokens MAY go, not a promise of a
    // per-token split. That destination rides on the action's own
    // `destinationBattlefieldId` (absent = base), the same field a Unit
    // already uses, rather than a new one; see cardPlacesTokens for how the
    // "battlefields you CONTROL" restriction is enforced, which is
    // deliberately stricter than the Unit deploy rule's mere presence check.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const destination: TokenDestination =
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base";
      let next = state;
      for (let i = 0; i < 4; i++) next = placeRecruitToken(next, ctx.casterIndex, destination);
      return next;
    },
  },
};

/**
 * Every Spell/Gear effect: the ones written inline above, plus everything the
 * per-domain files under `effects/` contribute. Merged with duplicate detection,
 * so a defId registered in two places throws at import rather than one
 * implementation silently shadowing the other — see effects/index.ts.
 *
 * NEW cards belong in `effects/<domain>.ts`, not in the record above. One file
 * per owning domain is what lets the rest of the card pool be worked on in
 * parallel without two editors ever touching the same file. The inline entries
 * stay where they are because they're already done and tested — file ownership
 * only matters for work in flight, and moving them would be churn.
 */
/**
 * Composed LAZILY, on first lookup, rather than at module load — and that is
 * load-bearing.
 *
 * This module sits in an import cycle that predates the domain files:
 * card-effects -> effect-helpers -> target-lookup -> card-effects (target-lookup
 * needs `slotOwner` at runtime). The cycle was harmless because nothing here ran
 * at import time; the CARD_EFFECTS literal only *stores* closures. Merging at
 * module scope broke that — it reads an imported binding from a module that is
 * still in flight, which surfaced as `Object.entries(undefined)` and took the
 * whole engine down at import.
 *
 * Deferring to first use means every module is fully initialised by the time this
 * runs, so import order stops mattering. Duplicate detection still throws
 * loudly, just on first lookup instead of at load.
 */
let composedCardEffects: Record<string, EffectDefinition> | null = null;

function allCardEffects(): Record<string, EffectDefinition> {
  composedCardEffects ??= mergeRegistries("card effect", [
    { name: "engine/card-effects.ts", entries: CARD_EFFECTS },
    { name: "engine/effects/*", entries: domainCardEffects },
  ]);
  return composedCardEffects;
}

/**
 * Keyed by defId (e.g. "OGS-003"), the stable id every CardInstance/
 * CardDefinition shares (card-loader.ts's deriveId). Hardcoded rather than
 * derived from card text — precise and safe for a handful of cards; not
 * worth a text-parsing scheme until there are enough registered effects to
 * justify one.
 */
export function effectForCard(card: CardInstance): EffectDefinition | undefined {
  return allCardEffects()[card.defId];
}

/** Every defId with a registered Spell/Gear effect. Exported for the coverage
 *  query (engine/coverage.ts) that tells the UI which cards actually do
 *  something — a silently-inert card is otherwise indistinguishable from a
 *  working one. */
export function cardEffectDefIds(): string[] {
  return Object.keys(allCardEffects());
}

export function targetingForCard(card: CardInstance): TargetingSpec {
  return effectForCard(card)?.targeting ?? { kind: "none" };
}
