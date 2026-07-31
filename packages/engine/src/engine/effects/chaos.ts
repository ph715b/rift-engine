import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import { discardCards, drawCards, grantTemporary, recallUnitToBase, returnCardFromTrash } from "../effect-helpers.js";

/**
 * Card implementations for **Chaos** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Chaos. A test in
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
export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-180": {
    // Fading Memories — "Give a unit at a battlefield or a gear [Temporary]."
    //
    // The only card in the pool that targets across two kinds of permanent, which
    // is why `unitOrGear` exists as its own targeting kind and why the choice
    // rides on `targetPermanentInstanceId`: handing a gear to anything that reads
    // `targetUnitInstanceId` would be a type error waiting to be a runtime one.
    //
    // "A unit AT A BATTLEFIELD" — base units are out, unlike the many cards that
    // just say "a unit". Gear has no such restriction; it lives in base by
    // definition, and the clause plainly doesn't apply to it.
    //
    // Rule 816 does the rest: the thing dies at the start of ITS CONTROLLER's
    // next Beginning Phase, before scoring. Aimed at an enemy that is delayed
    // removal; aimed at your own it is a sacrifice you have a turn to use.
    targeting: { kind: "unitOrGear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? grantTemporary(state, event.targetPermanentInstanceId) : state,
  },
  "OGN-168": {
    // Fight or Flight — "[Hidden][Action] Move a unit from a battlefield to its
    // base." Either player's: the text names no owner, so this is removal as
    // often as it is rescue.
    //
    // recallUnitToBase, not relocateToBaseUnchanged: "move ... to its base" is a
    // Move, so the unit arrives exhausted and move triggers see it. Rule 454's
    // distinction — a Recall is NOT a Move — is why the two helpers exist, and
    // picking the wrong one here would silently make this card better than
    // printed.
    //
    // Scope is battlefield-only ("from a battlefield"), which also means that
    // played from Hidden the only legal targets are the ones standing at that
    // battlefield — enforced by legal-actions, not here.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
  },};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-165": {
    // Cemetery Attendant — "When you play me, return a unit from your trash to
    // your hand."
    //
    // The same shape Annie - Stubborn (OGS-010, engine/unit-triggers.ts) already
    // uses; the only difference is cardKind, since she returns a Spell and this
    // returns a Unit.
    //
    // The trash card is a real TARGET, not something the engine may pick for the
    // player: rule 355.9.a.4 makes "a unit from your trash" a target because a
    // trash is a Public zone. So this is an `ownTrashCard` spec that
    // legal-actions.ts fans out one candidate per eligible Unit, and WHICH unit
    // comes back stays the caster's decision.
    //
    // "YOUR trash" — ctx.casterIndex, never the opponent's; returnCardFromTrash
    // only ever looks in the named player's own trash. It also resets the
    // returned unit's damage / this-turn Might / Buff / exhausted, since the card
    // is re-entering hand and may be replayed fresh (rule 709 already took the
    // Buff off when it left play).
    //
    // The `?:` guard is load-bearing, not defensive noise: a Unit is playable
    // with its trigger's target OMITTED when the board offered no legal one
    // (validate-play-card.ts's targetOmissionAllowed). An empty trash, or a trash
    // holding only Spells, is exactly that case — the Attendant still deploys and
    // simply returns nothing, per the "do as much as you can, ignoring impossible
    // instructions" golden rule (~rule 100, see docs/rules-conformance.md).
    targeting: { kind: "ownTrashCard", cardKind: "Unit" },
    resolve: (state, ctx, _unitId, event) =>
      event.trashCardInstanceId ? returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId) : state,
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Undercover Agent — "[Deathknell] Discard 2, then draw 2." (rule 808)
  //
  // Order matters and the card spells it out with "then": the two discards leave
  // hand before the two draws arrive, so a card just drawn can never be one of
  // the cards discarded. Doing it in one step would let that happen.
  //
  // Nobody picks the discards. A Deathknell has no action to carry a choice on,
  // so discardCards takes the front of hand — see its doc comment for why that
  // simplification is named rather than hidden.
  "OGN-178": (state, ctx) => drawCards(discardCards(state, ctx.casterIndex, 2), ctx.casterIndex, 2),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  // Scrapheap � "When this is played, discarded, or killed, draw 1."
  //
  // The only card in the pool that watches its OWN three-way fate, and the
  // reason self-triggers are keyed by defId rather than found by walking the
  // board: on the discarded branch this Gear is in hand at the moment it fires
  // (and in the trash immediately after), so no listener walk over permanents in
  // play would ever reach it.
  //
  // Not "when this ENTERS play" � a discarded Scrapheap was never in play at
  // all, and the printed text still pays. All three branches read the same, and
  // the draw goes to the card's owner in every one of them.
  "OGN-182": {
    on: ["played", "discarded", "killed"],
    resolve: (state, event) => drawCards(state, event.ownerIndex, 1),
  },
};
