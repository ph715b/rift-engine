import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import { drawCards } from "../effect-helpers.js";
import { controlsAnyFacedownCard } from "../hidden.js";
import { placeRecruitToken, placeToken, type TokenSpec } from "../token.js";
import { giveMightThisTurn, giveMightThisTurnToAllEnemies, recycleUnitFromPlayToDeck } from "../effect-helpers.js";
import type { PlayerState } from "../../model/game-state.js";

/**
 * Card implementations for **Mind** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Mind. A test in
 * test/effect-registry.test.ts enforces it, so a card filed in the wrong place
 * fails the suite rather than being merged and forgotten.
 *
 * Cards with TWO domains (the champion signature spells) belong in
 * effects/signature.ts, and Legends in engine/legend-abilities.ts — every Legend
 * is dual-domain by definition, so splitting those by domain is meaningless.
 *
 * To add a card:
 *   1. Register it under its defId in `cardEffects` (Spell/Gear) or
 *      `unitTriggers` (Unit's on-play ability), matching the shapes in
 *      card-effects.ts / unit-triggers.ts.
 *   2. Cite the rule or the oracle implementation the behaviour comes from —
 *      "mirrors <the Java oracle>" is not a rules citation, see
 *      docs/rules-conformance.md on why this project distinguishes them.
 *   3. Add an engine test. A silently-inert card is indistinguishable from a
 *      working one in play, which is exactly how the current gap went unnoticed.
 *
 * Composition rejects duplicates, so registering a defId that some other file
 * already handles throws at import rather than silently shadowing it.
 */
/** Sprite Call's token: 3 Might, enters ready, and dies at the start of its
 *  controller's next Beginning Phase (rule 816). */
const SPRITE_TOKEN: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };

export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-114": {
    // Progress Day — "Draw 4."
    //
    // Drawing on a short deck takes what is there rather than throwing: the
    // documented Burn Out gap in drawCards, not a decision made here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 4),
  },
  "OGN-083": {
    // Consult the Past — "[Hidden][Reaction] Draw 2."
    // The simplest card in the pool, and the one that shows what Hidden is worth
    // on its own: hidden for 1 Power, played later for 0 instead of 4 Energy.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 2),
  },
  "OGN-094": {
    // Sprite Call — "[Hidden][Action] Play a ready 3 Might Sprite unit token
    // with [Temporary]."
    //
    // Three things the Recruit token could not express, which is why token.ts
    // grew a spec: a Might other than 1, entering READY rather than exhausted
    // (143.4.a's default, overridden by the card's own "ready"), and carrying a
    // keyword. [Temporary] then works with no further wiring — rule 816's
    // Beginning-Phase kill already runs before scoring, which is what stops this
    // token holding a battlefield for a free point.
    //
    // Destination is the caster's base by default; played from Hidden, 811 makes
    // it that battlefield instead, which legal-actions supplies as the
    // destination rather than this resolver guessing.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) =>
      placeToken(
        state,
        ctx.casterIndex,
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base",
        SPRITE_TOKEN,
      ),
  },
  "OGN-093": {
    // Smoke Screen — "[Reaction] Give a unit -4 Might this turn, to a minimum
    // of 1 Might."
    //
    // scope: "anywhere", deliberately. The card says "a unit", NOT "a unit at a
    // battlefield", and rule 355.9.b settles what the bare noun means: the
    // targeting section's own list of Public zones names Bases alongside
    // Battlefield Zones, so a unit standing at home is a legal target. No owner
    // restriction is printed either, so `owner` is left unset — shrinking your
    // own unit is a bad play, not an illegal one. Same reading Orb of Regret,
    // Stupefy and Discipline already got; base is not a safe parking spot.
    //
    // The floor is the card's own "to a minimum of 1 Might" clause, and
    // giveMightThisTurn's `floor` argument exists for exactly this wording: it
    // caps the STORED modifier rather than only the displayed Might, so a
    // second Smoke Screen on an already-floored unit takes nothing further off
    // instead of digging a hole a later pump would have to climb out of. Buffs
    // and continuous auras are deliberately not counted towards the floor —
    // they can appear and vanish after this resolves, and the minimum is fixed
    // at resolution time. That simplification lives in the helper, not here.
    //
    // giveMightThisTurn, NOT a Buff. This expires in the Expiration Step ("all
    // 'this turn' effects expire simultaneously", rule 317), which
    // turn-manager.ts's runEnd gets for free by zeroing every unit's
    // mightThisTurn; a Buff (rule 710) is a persistent game object that would
    // survive the turn and only come off when the unit leaves play (rule 709).
    // A negative Buff isn't a thing in the first place.
    //
    // [Reaction] is rule 813 and is NOT implemented here — engine/timing.ts
    // owns when this may be played, including onto an already-open chain. The
    // resolver is identical whenever it runs, so there is nothing
    // timing-shaped for this entry to do.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => giveMightThisTurn(state, event.targetUnitInstanceId!, -4, 1),
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-110": {
    // Ekko - Recurrent — "[Accelerate] — Recycle me to ready your runes."
    //
    // Gated on the Accelerate cost having been PAID (805), like Tasty Faefolk.
    //
    // "Recycle ME" is a cost paid with the card itself: he goes from play to the
    // bottom of his owner's Main Deck (416), which is why this is not a death
    // and fires no [Deathknell]. Then every channeled rune readies — the whole
    // pool, which is what makes him a one-shot refuel rather than a body.
    //
    // He readies runes he did not pay for either: the Accelerate cost was
    // already spent by the time this resolves, so the refuel is real.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) => {
      if (!event.acceleratePaid) return state;
      const recycled = recycleUnitFromPlayToDeck(state, ctx.casterIndex, unitId);
      const players = [...recycled.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = {
        ...actor,
        channeled: actor.channeled.map((r) => (r.state === "Exhausted" ? { ...r, state: "Ready" as const } : r)),
      };
      return { ...recycled, players };
    },
  },
  "OGN-116": {
    // Thousand-Tailed Watcher — "When you play me, give enemy units -3 Might
    // this turn, to a minimum of 1 Might."
    //
    // "Enemy UNITS", not "enemy units here" and not "at a battlefield" — so this
    // reaches the opponent's base as well (355.9.b), which is what makes it a
    // board sweep rather than a combat trick.
    //
    // The floor is applied PER UNIT by giveMightThisTurn rather than to the
    // group: a 2-Might unit stops at 1 while a 7-Might one beside it still
    // loses the full 3.
    //
    // giveMightThisTurn, not a Buff — this expires in the Expiration Step
    // (rule 317) when runEnd zeroes every unit's mightThisTurn.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllEnemies(state, ctx.casterIndex, -3, 1),
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-109": {
    // Dr. Mundo - Expert — "At the start of your Beginning Phase, recycle 3 from
    // your trash." (His Might clause is a continuous modifier in
    // effective-might.ts.)
    //
    // The two clauses fight each other on purpose: he is bigger the fuller your
    // trash is, and every turn he empties it. That is the card, so this must NOT
    // be skipped when the trash is short.
    //
    // Which is why it does not use `recycleFromTrash`: that helper is a COST and
    // returns undefined unless it can move all 3 (416.3). Here recycling is an
    // EFFECT, so "do as much as you can" applies (422) — a 2-card trash recycles
    // both. Same distinction Salvage's "up to one gear" makes.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase") return state;
      if (event.playerIndex !== listener.ownerIndex) return state;
      const owner = state.players[listener.ownerIndex];
      const recycled = owner.trash.slice(0, 3);
      if (recycled.length === 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[listener.ownerIndex] = {
        ...owner,
        trash: owner.trash.slice(recycled.length),
        deck: [...owner.deck, ...recycled], // bottom, per 416
      };
      return { ...state, players };
    },
  },
  "OGN-101": {
    // Mushroom Pouch — "At the start of your Beginning Phase, if you control a
    // facedown card at a battlefield, draw 1."
    //
    // Only implementable now that [Hidden] exists: before facedown cards there
    // was nothing for the condition to be true OF. `controlsAnyFacedownCard`
    // asks it exactly — a facedown card of YOURS at a battlefield YOU control,
    // which is the same pairing rule 811 ties the card's survival to.
    //
    // "YOUR Beginning Phase": the event carries whose it is, and a gear only
    // reads its own controller's. Firing on both players' would double the draw
    // rate of a card that is meant to reward holding a hidden card for a turn.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      if (!controlsAnyFacedownCard(state, listener.ownerIndex)) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "OGN-117": {
    // Viktor - Innovator — "When you play a card on an opponent's turn, play a
    // 1 Might Recruit unit token in your base."
    //
    // "On an opponent's turn" is the whole card, and it only became reachable
    // with reaction-speed timing: before [Action]/[Reaction] existed you could
    // never play anything on someone else's turn, so this would have been a
    // trigger that could not fire.
    //
    // The condition is the ACTIVE player vs the listener's controller — not vs
    // the caster. Those differ: the event fires for both players' cards, and
    // Viktor must ignore the opponent's own plays on their own turn.
    on: "cardPlayed",
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: `dispatchEvent` already filters by
      // `on`, but the compiler cannot see that, and the check documents which
      // event this listener is reading fields off.
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR card
      if (state.activePlayerIndex === listener.ownerIndex) return state; // not an opponent's turn
      // "in your base" is stated, so the destination is fixed rather than chosen.
      return placeRecruitToken(state, listener.ownerIndex, "base");
    },
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {};
