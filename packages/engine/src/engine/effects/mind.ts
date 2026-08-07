import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellEffect,
  DeathWatchDefinition,
  EventTriggerDefinition,
  SelfTriggerDefinition,
} from "../triggers.js";
import { killGear } from "../triggers.js";
import { isDefendingAt, isFightingAt } from "../combat-designation.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import { drawCards } from "../effect-helpers.js";
import { controlsAnyFacedownCard, isHiddenCard } from "../hidden.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import { MECH_TOKEN, placeGoldTokens, placeRecruitToken, placeToken, type TokenSpec } from "../token.js";
import {
  banishCard,
  channelRunesExhausted,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  exhaustAllFriendlyUnits,
  exhaustGear,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  giveMightThisTurnToAllEnemies,
  holdCardsRecycled,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  readyUnit,
  recycleUnitFromPlayToDeck,
  removeUnitAnywhere,
  returnCardFromTrash,
  returnUnitToHand,
} from "../effect-helpers.js";
import { playUnitToBase } from "../deploy.js";
import { playCardIgnoringCost } from "../play-free.js";
import { parkDecision } from "../decisions.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { wearerListener } from "../equipment.js";

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

const FRIGID_TOUCH_MIGHT = 2;
const BELLOWS_BREATH_DAMAGE = 1;
const ROCKET_BARRAGE_DAMAGE = 4;

/** The non-combat MightContext for a unit wherever it is standing — the same
 *  three lines Gentlemen's Duel and Kinkou Monk already write out, needed here
 *  because Convergent Mutation compares two units' Might across zones. */
function mightContextFor(state: GameState, location: AnyUnitLocation) {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}

export const cardEffects: Record<string, EffectDefinition> = {
  "SFD-076": {
    // Production Surge — "This costs [2] less if you control a Mech. Play a 3
    // Might Mech unit token to your base. Draw 1."
    //
    // The discount half lives in `cost-modifiers.ts`, where every cross-cutting
    // price question lives; this is the effect half. Two modules for one card,
    // which is why only the module that owns a card's TEXT claims it in
    // coverage — see `costModifierDefIds`'s note on exactly this card.
    //
    // "TO YOUR BASE" is printed and is the whole placement rule, so no
    // destination is chosen — the same reading Azir's Sand Soldier takes.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(placeToken(state, ctx.casterIndex, "base", MECH_TOKEN), ctx.casterIndex, 1),
  },
  "SFD-077": {
    // Rocket Barrage — "[Repeat] [4][Mind] (You may pay the additional cost to
    // repeat this spell's effect, AND MAY MAKE DIFFERENT CHOICES.) Choose one —
    // Deal 4 to a unit in a base. [or] Kill a gear."
    //
    // **The pool's first MODAL card**, and the one 820.1.d works its own example
    // on: *"If Rocket Barrage's controller pays its Repeat cost as they play it,
    // they may choose the same mode or a different one, and if they choose the
    // same mode, may choose the same target or a different one. If they choose
    // 'Kill a gear' twice and choose two different gear, they must specify which
    // gear is the first target and which is the second."*
    //
    // Three things follow from that sentence, and all three are why this card
    // could not be written until now:
    //  - the mode is a CHOICE, so it rides the action (`modeId`) like a target;
    //  - the mode is part of the REPEAT's choice set, not a property of the play
    //    — `RepeatChoices.modeId`, and resolution picks the mode per execution;
    //  - "which gear is the FIRST target" is targeting language, so the gear is a
    //    TARGET chosen at announce rather than a question asked at resolution.
    //    That is what `kind: "gear"` is for; a parked decision could not give the
    //    ordering at announce.
    //
    // Mode 1 is scoped `"base"`, the narrowest scope: "a unit IN A BASE" excludes
    // every unit at a battlefield, which is the opposite of the usual restriction
    // and makes this a reach-into-their-backline card rather than a combat trick.
    // No owner clause, so either base is fair game.
    //
    // Mode 2 kills through `killGear` so the dying gear's own trigger fires
    // (Treasure Trove, Scrapheap) — the same funnel Disarming Rake uses.
    modes: [
      {
        id: "damage",
        label: "Deal 4 to a unit in a base",
        targeting: { kind: "unit", scope: "base" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId
            ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, ROCKET_BARRAGE_DAMAGE)
            : state,
      },
      {
        id: "killGear",
        label: "Kill a gear",
        targeting: { kind: "gear" },
        resolve: (state, _ctx, event) => {
          const id = event.targetPermanentInstanceId;
          if (!id) return state;
          for (const ownerIndex of [0, 1] as const) {
            const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === id);
            if (gear) return killGear(state, gear, ownerIndex);
          }
          // Already gone — 359.3's "a check on something no longer available".
          return state;
        },
      },
    ],
  },
  "SFD-080": {
    // Bellows Breath — "[Action] [Repeat] [1][Mind] Deal 1 to up to three units
    // at the same location."
    //
    // "At the same LOCATION", not "at the same battlefield", and rule **828**
    // settles that they are different: "Locations include the Battlefields and
    // the Bases." So three units standing in one player's base are a legal
    // group, which `sameBattlefield` would refuse — its own comment records that
    // a base unit "is at no battlefield, so it can never join a group". Hence
    // `sameLocation`, and hence `scope: "anywhere"` to put base units in the
    // pool at all.
    //
    // Each base is its OWN location, so one unit in each base is two locations
    // and not a group — the reason the constraint is keyed by zone rather than
    // by "is it a battlefield".
    //
    // `min: 0` because "UP TO three" — the card is castable with an empty board
    // and deals nothing, which is what the rules say outright for a zero choice.
    // No owner clause, so a group of enemies, a group of your own, or a mix at a
    // contested battlefield are all legal.
    //
    // Distinct units (no `allowsDuplicates`): "three units" is three units, and
    // the 1 damage is dealt once per entry.
    targeting: { kind: "unitList", min: 0, max: 3, scope: "anywhere", sameLocation: true },
    resolve: (state, ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce(
        (next, id) => dealDamage(next, ctx.casterIndex, id, BELLOWS_BREATH_DAMAGE),
        state,
      ),
  },
  "SFD-066": {
    // Frigid Touch — "[Reaction] [Repeat] [2] Give a unit -2 Might this turn."
    //
    // Smoke Screen's shape with a smaller number and, importantly, **no floor**:
    // that card prints "to a minimum of 1 Might" and this one does not, so the
    // `floor` argument is deliberately omitted rather than defaulted to 1. A unit
    // can be taken to 0 Might and below by this card, which is how it kills a
    // 2-Might body outright — reading a minimum into text that has none would
    // have quietly removed the card's whole point.
    //
    // "A unit", so 355.9.b reaches base as well; no owner clause, so debuffing
    // your own is legal and pointless, the usual pair.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -FRIGID_TOUCH_MIGHT) : state,
  },
  "OGN-115": {
    // Promising Future — "Each player looks at the top 5 cards of their Main
    // Deck, banishes one of them, then recycles the rest. Starting with the next
    // player, each player plays those cards, ignoring Energy costs. (They must
    // still pay Power costs.)"
    //
    // Four questions in one spell, and their ORDER is the card: both players
    // choose before either plays, so neither is choosing against a board the
    // other has already changed. FIFO parking is the whole of that, the same way
    // it is the whole of Cull the Weak's APNAP.
    //
    // Two different orderings in one sentence, and they are not the same one.
    // The LOOK is APNAP — active player first, this engine's convention for
    // "each player" — while the PLAY is explicitly "starting with the NEXT
    // player", so the caster plays last. Reading both as APNAP would hand the
    // caster the tempo the card deliberately gives away.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const caster = ctx.casterIndex;
      const next = (1 - caster) as 0 | 1;
      const first = state.activePlayerIndex;
      const second = (1 - first) as 0 | 1;
      // Both players look, so both looks can wake a Nocturne — and his offer is
      // parked ahead of the banish questions for the FIFO reason Reinforce's
      // resolve records.
      const looked = [first, second].reduce(
        (acc, playerIndex) => offerTopOfDeckBanish(acc, playerIndex, acc.players[playerIndex].deck.slice(0, 5)),
        state,
      );
      return [
        ...[first, second].map((playerIndex) => ({ kind: "OGN-115-banish", playerIndex }) as const),
        ...[next, caster].map((playerIndex) => ({ kind: "OGN-115-play", playerIndex }) as const),
      ].reduce((acc, seed) => parkDecision(acc, seed), looked);
    },
  },
  "OGN-122": {
    // Time Warp — "Take a turn after this one. Banish this."
    //
    // At 10 Energy and 4 Power it is the most expensive card in the pool, and the
    // two sentences are both load-bearing.
    //
    // **"A turn", not "another Action phase"** — so the extra turn Awakens,
    // scores its holds, Channels and Draws like any other. That is why this is a
    // counter on GameState read by `runEnd`'s rotation rather than anything
    // clever: with the rotation suppressed, every other part of the turn loop is
    // already correct.
    //
    // **"BANISH this"** is what stops the card being recurred, and it is the
    // pool's FIRST real write to `PlayerState.banished` — every other banish here
    // is transient (banished and replayed in one instruction, nothing able to
    // observe the middle zone). A Spell is already in its caster's trash by
    // resolution time, so this moves it from there; without it, Spectral Matron
    // or Immortal Phoenix would hand back an unbounded chain of extra turns.
    //
    // The queue is a COUNT: casting it twice in one turn is two extra turns, which
    // is what the sentence says and what `runEnd` spends one at a time.
    targeting: { kind: "none" },
    resolve: (state, ctx) => ({
      ...banishCard(state, ctx.casterIndex, ctx.sourceCardInstanceId ?? ""),
      extraTurns: state.extraTurns + 1,
      extraTurnsForIndex: ctx.casterIndex,
    }),
  },
  "OGN-102": {
    // Portal Rescue — "Banish a friendly unit, then its owner plays it to their
    // base, ignoring its cost."
    //
    // A BLINK: the unit leaves play and comes back fresh. That is the card, and
    // it is why it goes through the banish-and-play path rather than
    // `relocateToBaseUnchanged` — leaving play strips the Buff (709), clears
    // damage and this-turn Might, and makes the return a genuine PLAY, so its
    // on-play trigger fires again and Cithria sees another unit arrive.
    //
    // The banish is TRANSIENT: banished and replayed in one instruction, with no
    // window in which anything could observe the middle zone. It therefore goes
    // straight to play rather than through `PlayerState.banished` — the same call
    // Baited Hook's decision already makes, and recorded in
    // docs/rules-conformance.md.
    //
    // "ITS OWNER plays it", not the caster: `playUnitToBase` is handed the unit's
    // own controller, so rescuing a friendly unit returns it to the right base.
    // Scope "anywhere" because the text names no battlefield; a unit already in
    // base is a legal (if pointless) target, which is 355.9.b rather than an
    // oversight.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const found = findUnitAnywhere(state, event.targetUnitInstanceId);
      if (!found) return state;
      // A fresh copy: 709 removes Buffs on leaving play, and damage/this-turn
      // Might are properties of the body that left. Rebuilt here rather than in
      // `playUnitToBase`, which is also used for cards that were never in play.
      const returning = { ...found.unit, damage: 0, mightThisTurn: 0, buffed: false, stunned: false, movesThisTurn: 0 };
      const removed = removeUnitAnywhere(state, event.targetUnitInstanceId);
      return playUnitToBase(removed, found.ownerIndex, returning);
    },
  },
  "OGN-123": {
    // Unchecked Power — "Exhaust all friendly units, then deal 12 to ALL units
    // at battlefields."
    //
    // The two clauses have deliberately different reach and the text says so:
    // the exhaust hits "all FRIENDLY units" (base included), the damage hits
    // "ALL units AT BATTLEFIELDS" (both players, base excluded). Reading either
    // as the other would change the card completely.
    //
    // Order matters and is printed: exhaust first, THEN damage. A unit that dies
    // to the 12 was exhausted on its way out, which is invisible here but not to
    // anything watching for exhaustion.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      dealDamageToAllUnitsAtAllBattlefields(exhaustAllFriendlyUnits(state, ctx.casterIndex), ctx.casterIndex, 12),
  },
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
  "OGN-104": {
    // Retreat — "[Reaction] Return a friendly unit to its owner's hand. Its
    // owner channels 1 rune exhausted."
    //
    // scope "anywhere": the text says "a friendly unit", not "at a battlefield",
    // and 355.9.b puts Bases among the public zones a target may be drawn from.
    // Bouncing a unit out of your own base is a real (if narrow) play — it
    // re-arms an on-play trigger — so it is not worth narrowing on a guess.
    //
    // The owner is looked up BEFORE the bounce rather than assumed to be the
    // caster. It always IS the caster today (control and ownership are the same
    // thing in this engine — OGN-203 is the only card that would separate them
    // and it is unimplemented), but "its owner" is what the card says, and the
    // lookup has to happen first either way: after returnUnitToHand the unit is
    // in a hand and findUnitAnywhere no longer sees it.
    //
    // A target that left play while this sat on the chain does NOTHING AT ALL,
    // including the channel. That is not the usual defensive no-op: rule 359.3.e
    // says "if any of the spell's targets are no longer legal ... any
    // instructions related to an illegal target can't be followed", and the
    // second sentence names "ITS owner" — it is an instruction about the target.
    // Contrast the rules' own Void Seeker example ("Deal 4 to a unit at a
    // battlefield. Draw 1."), where the draw survives because it refers to
    // nothing.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      if (!location) return state;
      return channelRunesExhausted(returnUnitToHand(state, location.unit.instanceId), location.ownerIndex, 1);
    },
  },
  "OGN-108": {
    // Convergent Mutation — "[Reaction] Choose a friendly unit. This turn,
    // increase its Might to the Might of another friendly unit."
    //
    // Two friendly targets and the slots are NOT interchangeable: slot 0 is the
    // unit that grows, slot 1 is only measured. See the reachability note below.
    //
    // "INCREASE its Might TO x" is arithmetic, not assignment, and the rules
    // separate those two layers explicitly (rule 477's layer list): "A unit's
    // Might becomes 4 this turn" is set in the assignment layer, whereas
    // "Increase a friendly unit's Might to 5" is worked in the Arithmetic layer
    // as a positive delta. That is why this is a `giveMightThisTurn` and not a
    // new set-to-a-value primitive — and why it stacks with, rather than wipes,
    // an existing modifier.
    //
    // The delta is clamped at 0 by the same rules text: "Players cannot increase
    // a numeric attribute by a negative amount. If an effect would instruct a
    // player to do so, they increase it by 0 instead." So naming a SMALLER donor
    // is legal and does nothing; it never shrinks the chosen unit.
    //
    // EFFECTIVE Might on both sides, not printed — the Arithmetic layer runs on
    // the value the rest of the game sees, so a donor pumped by Discipline
    // donates the pumped number and a chosen unit already under a buff needs
    // less to catch up. Rule 463 ("effects that calculate Might increases and
    // decreases use the actual value") is why a stunned donor still donates its
    // real Might rather than the 0 combat treats it as; `effectiveMight` does not
    // zero stunned units, so this gets that for free.
    //
    // Snapshotted, per the same Arithmetic-layer rule: the delta is computed once
    // at resolution and stored, so the chosen unit does not track the donor
    // afterwards. If the donor is killed a moment later the growth stays.
    //
    // `min: 2` — Gentlemen's Duel's precedent rather than Back to Back's `min: 0`.
    // "Increase its Might to the Might of ANOTHER friendly unit" has no reading
    // with one unit on the board: there is no value to increase to, so the card
    // is uncastable rather than castable-and-inert.
    //
    // `asymmetricSlots` is REQUIRED here and its absence was a real half-dead
    // card. legal-actions collapses a two-slot spec whose roles are equal and
    // enumerates one ordering of each pair, reasoning that (A,B) and (B,A) are
    // the same choice — true for Back to Back and Singularity, which apply the
    // same thing to each unit, and false here, where the ordering IS the
    // decision. Measured before the flag existed: with a 7-Might and a 2-Might
    // friendly, the single offered pairing was the one that increases by 0.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere", asymmetricSlots: true },
    resolve: (state, _ctx, event) => {
      const chosen = findUnitAnywhere(state, event.targetUnitInstanceId!);
      const donor = findUnitAnywhere(state, event.secondTargetUnitInstanceId!);
      if (!chosen || !donor) return state; // either target gone: 359.3.e again
      const chosenMight = effectiveMight(state, chosen.unit, chosen.ownerIndex, mightContextFor(state, chosen));
      const donorMight = effectiveMight(state, donor.unit, donor.ownerIndex, mightContextFor(state, donor));
      const increase = Math.max(0, donorMight - chosenMight);
      return increase > 0 ? giveMightThisTurn(state, chosen.unit.instanceId, increase) : state;
    },
  },
  "SFD-087": {
    // Premonition — "[Reaction] Draw 3."
    //
    // The plainest effect in the set behind the deepest Power cost in it (2
    // Energy and THREE Mind), which is the card: Consult the Past above draws 2
    // for one Power at Hidden speed, and this draws 3 at Reaction speed for
    // three. Nothing about that pricing is this resolver's business.
    //
    // [Reaction] is rule 813 and belongs entirely to engine/timing.ts — the
    // resolver is identical whenever it runs, so there is nothing timing-shaped
    // for this entry to do, exactly as Smoke Screen's own note records.
    //
    // A deck too short to cover three runs Burn Out (431) inside `drawCards`
    // rather than being clamped here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 3),
  },
  "SFD-070": {
    // Wages of Pain — "[Hidden][Action] Deal 3 to a unit at a battlefield. Play a
    // Gold gear token exhausted."
    //
    // Structurally Void Seeker (OGN-086) with a Gold token where the draw is, and
    // it takes Void Seeker's two readings wholesale rather than re-deriving them:
    //
    //  - **Default battlefield scope.** `{ kind: "unit" }` with no `scope`,
    //    because the printed complement names a battlefield — the rules'
    //    Instructions section (135.2) works this exact phrasing. A unit in either
    //    base is not a legal target, unlike Smoke Screen's bare "a unit" above.
    //    No owner word is printed either, so shooting your own is legal and bad.
    //
    //  - **Two instructions, ignored separately.** A target that left play while
    //    this sat on the chain makes `dealDamage` a no-op and the token STILL
    //    arrives (359.3.e, and 135.2.b's worked Void Seeker example). This is not
    //    Retreat's case: Retreat's second sentence names "ITS owner" and so is an
    //    instruction about the target, while "play a Gold gear token" refers to
    //    nothing that could become illegal.
    //
    // Damage FIRST, then the token — 359.3.e.5, "top to bottom of the rules text".
    // Observable rather than cosmetic: a lethal 3 kills mid-resolution and can run
    // a [Deathknell] before the gear exists for anything to count.
    //
    // [Hidden] and [Action] are the loader's and engine/timing.ts's; played from
    // facedown, 811 confines the target to that battlefield, which legal-actions
    // enforces rather than this resolver guessing.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      placeGoldTokens(dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 3), ctx.casterIndex, 1),
  },
};

/** The gear cards in `playerIndex`'s own trash — Aspiring Engineer's "a gear
 *  from your trash".
 *
 *  Its own function because the TRIGGER asks whether there is anything worth
 *  asking about and the DECISION asks what the answers are, and those two
 *  drifting apart is precisely how a question gets parked that nothing can
 *  answer — `advanceDecisions` would drop it silently and the card would report
 *  implemented. Same reason `evolutionaryCandidates` above is shared. */
function gearsInTrash(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter((c) => c.kind === "Gear");
}

/** The Mechs Bubble Bot could ready — "ANOTHER friendly Mech", exhausted ones
 *  only (see her entry for why the exhaustion filter is unobservable). Shared by
 *  her trigger and her decision for the same reason `gearsInTrash` is.
 *
 *  "Another" excludes her as an OBJECT, by instanceId — two Bubble Bots each
 *  satisfy the other's "another", which a defId comparison gets exactly
 *  backwards. Same reading granted-keywords.ts takes for "other friendly units". */
function readyableMechs(state: GameState, playerIndex: 0 | 1, selfInstanceId: string) {
  return ownUnitsEverywhere(state, playerIndex).filter(
    (u) => u.instanceId !== selfInstanceId && u.exhausted && u.tags.includes("Mech"),
  );
}

/** Frostcoat Cub's paid-for debuff, as a POSITIVE number — the sign is applied
 *  at the call site so the floor argument beside it reads plainly. */
const FROSTCOAT_DEBUFF = 2;

/** Pickpocket's "a gear with Energy cost no more than [1]" — the printed
 *  ceiling, inclusive ("no more than"). */
const PICKPOCKET_MAX_GEAR_COST = 1;

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "SFD-084": {
    // Jayce - Man of Progress — "When you play me, you may kill a friendly gear.
    // If you do, you may play a gear with Energy cost no more than [7] from hand
    // this turn, ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // **The odd one among the pool's free-play cards.** Every other "play a card
    // ignoring its cost" happens as the granting card RESOLVES, so it needs no
    // state; Jayce's is a permission that stays open for the rest of the turn.
    // It therefore lands on `PlayerState.freeGearPlaysThisTurn` and is read by
    // `modifiedEnergyCost`, the one place a card's Energy is priced.
    //
    // "If you do" ties the permission strictly to the kill, so it is granted in
    // the decision's paying branch and nowhere else — declining gives nothing.
    //
    // "a FRIENDLY gear", unlike Pickpocket's unqualified "a gear" one entry
    // below: this one costs you a permanent, which is what makes it a cost
    // rather than removal.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // No friendly gear is no question — the offer is dropped whole rather than
      // shown as a lone decline, matching every other optional kill here.
      state.players[ctx.casterIndex].activeGear.length === 0
        ? state
        : parkDecision(state, { kind: "SFD-084-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-074": {
    // Pickpocket — "When you play me, you may kill a gear with Energy cost no
    // more than [1]. If you do, play a Gold gear token exhausted."
    //
    // A parked decision rather than a target on the play action, because "you
    // MAY" with a filtered list of candidates is a question, and the same shape
    // every other optional on-play kill in this pool takes.
    //
    // **"A gear", unqualified — so EITHER side's.** The pool says "a friendly
    // gear" when it means one (Zaun Punk, Legion Quartermaster), and this card
    // does not; killing the opponent's Doran's Ring is the play that makes him
    // worth 3 Energy. Both players' `activeGear` are offered below.
    //
    // "If you do" ties the Gold strictly to the kill: declining gives nothing,
    // which is why the token is minted in the same branch rather than
    // unconditionally.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-074-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-067": {
    // Frostcoat Cub — "You may pay [Mind] as an additional cost to play me. When
    // you play me, if you paid the additional cost, give a unit -2 Might this
    // turn."
    //
    // A rune and no Energy, which is Clockwork Keeper's shape exactly.
    //
    // FLOORED AT 1, like Orb of Regret's reduction: `giveMightThisTurn`'s floor
    // caps the stored modifier rather than the displayed Might, so a Cub does
    // not dig a hole a later buff has to climb out of. The card does not print a
    // floor — 707.2 does, since Might cannot fall below 1.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.optionalPowerPaid && event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, -FROSTCOAT_DEBUFF, 1)
        : state,
  },
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
  "OGN-097": {
    // Blastcone Fae — "[Hidden] When you play me, give a unit -2 Might this
    // turn, to a minimum of 1 Might."
    //
    // [Hidden] is handled entirely by engine/hidden.ts and the loader; nothing
    // here is aware of it. What DOES follow from it: played from facedown, rule
    // 811 restricts the target to that battlefield, which legal-actions enforces
    // — this resolver takes whatever it is given either way.
    //
    // "A unit", no owner and no battlefield, so scope "anywhere".
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -2, 1) : state,
  },
  "OGN-092": {
    // Riptide Rex — "When you play me, deal 6 to an enemy unit at a
    // battlefield."
    //
    // Both restrictions printed: enemy, and at a battlefield. Six is enough to
    // kill almost anything in the pool outright, which is what the
    // battlefield-only clause is balancing.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 6) : state,
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
  "OGN-106": {
    // Sprite Mother — "When you play me, play a ready 3 Might Sprite unit token
    // with [Temporary] HERE."
    //
    // The same token Sprite Call makes (SPRITE_TOKEN above), so the spec is
    // shared rather than re-declared: two copies of "3 Might, ready, Temporary"
    // is exactly the drift token.ts's spec parameter was added to prevent.
    //
    // "Here" is wherever SHE landed, which the trigger event already carries as
    // `destination` — Faithful Manufactor's precedent. Played to base, "here" is
    // the base; that is not a special case, it is what `UnitPlayDestination`
    // means. Nothing is chosen, so targeting stays "none".
    //
    // placeToken applies Contested for a battlefield destination (190.4), which
    // matters: she can only be played to a battlefield she reinforces or one you
    // control, but a Showdown already staged there is promoted by the token
    // becoming present just as it would be by any other arrival.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeToken(state, ctx.casterIndex, event.destination, SPRITE_TOKEN),
  },
  "SFD-061": {
    // Aspiring Engineer — "When you play me, return a gear from your trash to
    // your hand."
    //
    // **Asked as a DECISION rather than as a target, and that is a divergence
    // rather than a preference.** 355.9.a.4 works this exact shape by name — "e.g.
    // 'Recycle a unit from your trash' TARGETS a unit card in your trash" — so the
    // choice belongs to the moment the ability goes on the Chain (355: valid
    // choices must be made for all targets), which is where Annie - Stubborn's
    // identical "a spell from your trash" makes it. The spec that expresses that,
    // `{ kind: "ownTrashCard", cardKind }`, cannot name a GEAR: its `cardKind` is
    // typed "Unit" | "Spell", and widening it is an edit to card-effects.ts, which
    // this pass does not own. So the card is chosen a response window later than
    // the rules place it. Unobservable in this pool — nothing here reaches a
    // trash at reaction speed, and the trash being chosen from is the chooser's
    // own — but it is a divergence and is recorded as one rather than left to be
    // discovered.
    //
    // MANDATORY: no "you may" anywhere in the text, so there is no decline option.
    // A trash with no gear in it asks nothing at all (422's do-as-much-as-you-can),
    // and a trash with exactly one gear is not a question — `advanceDecisions`
    // takes the single option without ever prompting.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      gearsInTrash(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-061-return", playerIndex: ctx.casterIndex }),
  },
  "SFD-062": {
    // Bubble Bot — "When you play me, ready another friendly Mech."
    //
    // A DECISION rather than a target, and here the reason is the TAG.
    // `TargetingSpec`'s unit kind restricts by owner, Might, scope and exhaustion
    // and by nothing else, so the only announce-time spec available is a bare "a
    // friendly unit" — which would enumerate every friendly unit as a legal choice
    // and then quietly do nothing whenever a non-Mech was named. The AI takes the
    // first candidate offered, so that reads as a working card that usually does
    // nothing, which is strictly worse than asking the question one response
    // window late. The lateness is the same 355 divergence Aspiring Engineer
    // records above, and it is slightly more visible here: with an announce-time
    // target, an opponent could kill the named Mech in response and 359.3.e would
    // make this do nothing, whereas a resolution-time chooser simply names another.
    //
    // Only EXHAUSTED Mechs are offered. Rule 415 — "A Unit that is already Ready
    // cannot be Readied again. If a Unit is instructed to be Readied while it is
    // already Ready, nothing additional happens" — makes the two boards identical,
    // `unitReadied` included, since `readyUnit` carries that same guard. What the
    // filter buys is that "no exhausted Mech" and "no Mech at all" ask the same
    // nothing instead of prompting for a choice with no consequence.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      readyableMechs(state, ctx.casterIndex, unitId).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-062-ready", playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  "SFD-072": {
    // Dropboarder — "When you play me, if you control two or more gear, ready me."
    //
    // A unit enters EXHAUSTED (143.4.a), so readying itself IS the card: 4 Energy
    // for a 4-Might body that can move, fight or be spent the turn it lands, but
    // only on a board that has already paid for two gear.
    //
    // "Gear" means gear on the BOARD (355.9.b: "'Unit,' 'gear,' and 'rune' refer
    // to objects on the Board unless specified otherwise"), which is `activeGear`
    // — a facedown card at a battlefield is not a gear until it is played, and one
    // in the trash is not one at all.
    //
    // **The "if" is part of the TRIGGER CONDITION, not the effect**, and the rules
    // say so in as many words (383.2.b): "Any additional conditional statement
    // immediately after the Condition must be true in order for the Condition to
    // be fulfilled. Such a conditional statement is part of the Trigger Condition
    // and not the Effect." Their worked example is Sona - Harmonious, whose
    // ability "will still resolve" if she is removed in reaction to it. So the
    // count should be read when the trigger FIRES and not re-asked here.
    // `UnitTriggerDefinition` has no `applies` hook — the event-trigger and
    // on-move families grew one, the on-play family has not — and adding one is an
    // edit to unit-triggers.ts, which this pass does not own. Read at resolution
    // instead, which differs only when a gear enters or leaves play during the
    // response window this trigger's own hold opens. Recorded as a divergence
    // rather than left implicit.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      state.players[ctx.casterIndex].activeGear.length >= 2 ? readyUnit(state, unitId) : state,
  },
  "SFD-081": {
    // Card Sharp — "When you play me, you and each opponent may play a Gold gear
    // token exhausted. For each opponent who did, you play a Gold gear token
    // exhausted."
    //
    // A Group Hug that pays you for being taken up, and the second sentence is
    // what makes the opponent's "may" a real question: accepting hands them a
    // rainbow Power and hands the CASTER one as well, so declining is a genuine
    // play rather than a formality. Party Favors (OGN-071) is the precedent for
    // asking the opponent a question on your own card at all.
    //
    // **Two parked questions, caster first.** "You and each opponent" is this
    // engine's APNAP convention (active player first), and the caster IS the
    // active player here — Card Sharp is a plain Unit with no printed [Action] or
    // [Reaction], so it can only be played on its controller's own turn. Text
    // order and APNAP therefore agree and nothing rests on which one is being
    // followed.
    //
    // Sequential rather than simultaneous, which is the one visible divergence:
    // the queue asks the caster, then the opponent, so the opponent answers
    // knowing what the caster chose. There is one decision queue and no
    // simultaneous-choice primitive; Promising Future records the identical shape
    // two entries up. Here it costs less than it does there — neither answer
    // constrains the other, and the caster's choice tells the opponent nothing
    // they could act on.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      [
        { kind: "SFD-081-mine", playerIndex: ctx.casterIndex } as const,
        { kind: "SFD-081-theirs", playerIndex: (1 - ctx.casterIndex) as 0 | 1 } as const,
      ].reduce((acc, seed) => parkDecision(acc, seed), state),
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Watchful Sentry — "[Deathknell] — Draw 1." (rule 808, "When I die, [Effect]".)
  //
  // The DYING unit's controller draws, not whoever killed it: dispatchOnUnitDied
  // builds this ctx from `death.ownerIndex`, which is the whole reason a
  // Deathknell is keyed by the dying card rather than walked as a listener.
  // Killing a Sentry therefore pays its owner, which is what makes a 2-Energy
  // 1-Might body worth playing at all.
  //
  // Nothing here is conditional on HOW it died: 808 is every death, and the
  // funnel dispatchOnUnitDied sits behind (damage, destroy, combat) is what
  // makes that true rather than three separate sites remembering to fire.
  "OGN-096": (state, ctx) => drawCards(state, ctx.casterIndex, 1),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "SFD-075": {
    // Prize of Progress — "When you use an activated ability of a GEAR, give me
    // +1 [Might] this turn."
    //
    // The first card to watch an ACTIVATION, which is why `abilityActivated`
    // exists. The moment is the USE, not the effect: an ability whose effect
    // ends up doing nothing was still used, and the event is raised before the
    // resolver for exactly that reason.
    //
    // "of a GEAR" is the whole condition, and it is answered by `sourceKind` off
    // the RESOLVED source — a unit's ability and a legend's are not a gear's. A
    // check against the action would have had only an instance id and no idea
    // what it named.
    //
    // "When YOU use" is his controller — an opponent exhausting their own gear
    // does not feed him.
    //
    // Not capped: every gear activation pays, which in a deck of Gold tokens and
    // Seals is the card. Nothing here says once per turn.
    on: "abilityActivated",
    applies: (_state, listener, event) =>
      event.kind === "abilityActivated" &&
      event.sourceKind === "Gear" &&
      event.activatorIndex === listener.ownerIndex,
    resolve: (state, listener) => giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 1),
  },
  "SFD-089": {
    // Rumble - Scrapper's SECOND sentence — "When I hold, play a 3 [Might] Mech
    // unit token to your base."
    //
    // His FIRST ("your Mechs have +1 Might, including me") is a continuous Might
    // aura and lives in effective-might.ts, which also carries his coverage
    // claim. Two halves, two modules, one change — see that claim's comment for
    // why landing them apart would have reported him finished at the halfway
    // point.
    //
    // "When **I** hold" is positional, like Ornn - Blacksmith's and Ahri -
    // Alluring's: the battlefield held has to be the one he is standing at.
    // Settled at fire time, so the response window this opens cannot be used to
    // move him off it and still collect.
    //
    // The token goes to BASE, not to the battlefield he just held — the card
    // says "to your base" and that is a real difference, since a token that
    // arrived at the battlefield would be a body in a fight already decided.
    //
    // It is a Mech, so his own aura pumps it to 4 the instant it lands — which
    // is the interaction the card is built out of and needs nothing here:
    // `MECH_TOKEN` carries the tag and `effectiveMight` reads it fresh.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener) => placeToken(state, listener.ownerIndex, "base", MECH_TOKEN),
  },
  "SFD-086": {
    // World Atlas — "When I hold, play two Gold gear tokens exhausted."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // Positional, like every "when I hold": the wearer has to be standing at the
    // battlefield that was held, which `listener.battlefieldId` on the rewritten
    // listener now genuinely answers.
    on: "battlefieldHeld",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldHeld" &&
        wearer !== undefined &&
        event.holderIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      // TWO tokens through one call — `placeGoldTokens` mints them as separate
      // game objects, which is what "two tokens" means.
      return wearer === undefined ? state : placeGoldTokens(state, wearer.ownerIndex, 2);
    },
  },
  "OGN-112": {
    // Kai'Sa - Evolutionary — "[Ganking] When I conquer, you may play a spell
    // from your trash with Energy cost less than your points without paying its
    // Energy cost. Then recycle it."
    //
    // "When I CONQUER" is the positional reading Adaptatron and Sett - Brawler
    // take: she has to be AT the battlefield taken, which is what separates a
    // unit's conquer trigger from a Legend's "when you conquer".
    //
    // **"Less than your points" is read at RESOLUTION, not at fire time**, and
    // that is deliberate rather than an oversight: `scoreHolds` and
    // `recordConquest` award the point BEFORE this trigger is held, so the
    // conquest that fired her has already raised the threshold she reads. That is
    // the card working — a first conquest makes 0-cost spells available, a fourth
    // makes most of the pool available.
    //
    // "You MAY", so it parks a question rather than firing. Nothing is asked when
    // no spell in the trash qualifies — 422's do-as-much-as-you-can, and the same
    // shape Adaptatron's gear check uses.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (evolutionaryCandidates(state, listener.ownerIndex).length === 0) return state;
      return parkDecision(state, { kind: "OGN-112-play", playerIndex: listener.ownerIndex });
    },
  },
  "OGN-121": {
    // Teemo - Strategist — "[Hidden] When I defend, choose an enemy unit here and
    // reveal the top 5 cards of your Main Deck. Deal 1 to that unit for each card
    // with [Hidden] revealed this way, then recycle the revealed cards."
    //
    // `[Hidden]` is entirely engine/hidden.ts and the loader; only the defend
    // trigger is written here, and the card is genuinely whole once it lands.
    //
    // **The rules PDF works this exact card twice, and both uses changed what is
    // below rather than confirming it.**
    //
    // *135.2.b (Instructions)* splits the trigger into FOUR instructions by name:
    // "choose an enemy unit here", "reveal the top 5 cards of your Main Deck",
    // "deal 1 to that unit for each card with [Hidden] revealed this way", and
    // "recycle the revealed cards". Separate instructions are ignored separately
    // (359.3.e: "Instructions that can't be followed... are ignored"), so with no
    // enemy unit here the choose and the deal drop out while the reveal and the
    // recycle still happen. That is the Void Seeker precedent the same section
    // works ("Deal 4 to a unit at a battlefield. Draw 1." — the draw survives an
    // illegal target), NOT Retreat's, whose second sentence names "ITS owner" and
    // so is an instruction about the target. Near-unreachable in play, since
    // defending means enemy units are standing here; it costs one branch.
    //
    // *718.5 (Bonus Damage)* is why zero `[Hidden]` cards skips `dealDamage`
    // rather than calling it with 0: "If no damage was Dealt, then Bonus Damage
    // will not apply" — worked on Teemo himself carrying Rabadon's Deathcrown,
    // "no deal action is performed for the Bonus Damage to apply to." This
    // engine's Bonus Damage is Annie - Fiery, and damage-modifiers.ts adds her +1
    // to any amount, so `dealDamage(..., 0)` beside her would deal 1 for
    // revealing nothing. The guard is the rule, not defensive coding.
    //
    // `[Hidden]` on a revealed card is asked of the DEFINITION through
    // `isHiddenCard`, never of the printed text: Noxus Saboteur, Ava Achiever,
    // Ember Monk and Guerilla Warfare all MENTION "[Hidden]" without carrying it,
    // and card-loader.ts's HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS is where that is
    // already settled. A text scan would count them and still look like a working
    // card.
    //
    // "Recycle" is 416/425 — the bottom of the corresponding deck, in revealed
    // order. A deck shorter than 5 reveals what it has: this is an EFFECT, so
    // 422's do-as-much-as-you-can applies rather than `recycleFromTrash`'s
    // all-or-nothing cost rule, the same distinction Dr. Mundo - Expert draws
    // below.
    on: "combatBegan",
    // "When I defend" is a fact about the board at the moment of the event, so it
    // is asked here: holding the trigger for a Teemo who is ATTACKING would open
    // a response window for an ability that resolves to nothing. The predicate is
    // combat-designation.ts's, shared with Yasuo's mirror-image "when I attack"
    // so the two sides cannot come to different answers about the same combat.
    applies: isDefendingAt,
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: the dispatcher filters by `on`, but
      // the compiler cannot see it, and `applies` cannot hand back the narrowed
      // event.
      //
      // `isDefendingAt` is deliberately NOT re-asked here. It was, while this
      // resolved inline and the two were the same instant; now they are separated
      // by a response window, and re-asking would let the opponent cancel a
      // trigger that has already fired by moving Teemo off the battlefield he was
      // defending. 383 fixes triggering at the moment of the event.
      if (event.kind !== "combatBegan") return state;

      const owner = state.players[listener.ownerIndex];
      // "Reveal the top 5" — revealing moves nothing (425: "Cards remain in the
      // zone they are being Revealed from"), so these are still the top of the
      // deck while the damage is dealt, and only the recycle below moves them.
      const revealed = owner.deck.slice(0, 5);
      if (revealed.length === 0) return state; // nothing revealed, nothing to recycle
      const registry = defaultCardRegistry();
      const hiddenCount = revealed.filter((c) => isHiddenCard(registry.tryGet(c.defId))).length;
      // "As you look at or REVEAL me" — this is the reveal half of Nocturne's
      // trigger, and the only two sites where it fires are this and Grasping
      // Roots' reveal-until-a-unit. Offered AFTER the reveal rather than before
      // it, because unlike the four look sites nothing here stops to ask: the
      // count and the recycle are both done by the time a player could answer.
      // His decision names the card instance for exactly that reason.

      // "An enemy unit HERE" — the first at this battlefield in board order,
      // auto-selected rather than asked. Same simplification, and the same
      // structural reason, as Yasuo - Remorseful, Crackshot Corsair and Leona -
      // Determined; filed Unverified in docs/rules-conformance.md.
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId)!;
      const enemy = Object.entries(bf.units)
        .filter(([id]) => id !== owner.id)
        .flatMap(([, units]) => units)[0];

      const damaged =
        enemy !== undefined && hiddenCount > 0
          ? dealDamage(state, listener.ownerIndex, enemy.instanceId, hiddenCount)
          : state;

      // Recycled by instance id off the POST-damage deck rather than by
      // re-slicing the top 5, because the deal runs the full death funnel and
      // that funnel can reach a deck: `[Deathknell]` draws exist (Watchful
      // Sentry, in this file). **Stated as unexercised rather than claimed:** no
      // card in this pool is known to draw from TEEMO'S controller's deck off an
      // enemy unit's death — a Deathknell pays its own owner — so the difference
      // between this and a re-slice is unreachable today. It is written this way
      // because a re-slice would silently recycle a card that was never revealed
      // the day such a card lands, and filtering costs nothing.
      const after = damaged.players[listener.ownerIndex];
      const revealedIds = new Set(revealed.map((c) => c.instanceId));
      const survivors = after.deck.filter((c) => revealedIds.has(c.instanceId));
      if (survivors.length === 0) return damaged;
      const players = [...damaged.players] as [PlayerState, PlayerState];
      players[listener.ownerIndex] = {
        ...after,
        deck: [...after.deck.filter((c) => !revealedIds.has(c.instanceId)), ...survivors],
      };
      const shuffled = holdCardsRecycled({ ...damaged, players }, listener.ownerIndex, survivors.length);
      return offerTopOfDeckBanish(shuffled, listener.ownerIndex, revealed);
    },
  },
  "OGN-119": {
    // Ahri - Inquisitive — "When I attack or defend, give an enemy unit here
    // -2 Might this turn, to a minimum of 1 Might."
    //
    // "Attacks OR DEFENDS" — which side started the fight is deliberately not
    // consulted, which is the whole of `isFightingAt`. The same indifference Mask
    // of Foresight shows, and the opposite of Yasuo and Teemo, who each name one
    // side. All four now ask combat-designation.ts rather than re-deriving it.
    //
    // Being AT the battlefield is a fire-time condition and lives in `applies`:
    // she triggered because she was in the combat, and an opponent moving her out
    // during the response window does not un-trigger it (383). The TARGET is a
    // resolution-time board read and stays below — auto-selected from the enemies
    // there, same precedent as the other combat triggers, filed Unverified. The
    // floor is her own printed clause.
    on: "combatBegan",
    applies: isFightingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      const ownerId = state.players[listener.ownerIndex].id;
      const enemy = Object.entries(bf?.units ?? {})
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units)[0];
      return enemy ? giveMightThisTurn(state, enemy.instanceId, -2, 1) : state;
    },
  },
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
    // "On an opponent's turn" is read at FIRE time and not re-asked in `resolve`.
    // `cardPlayed` is a Chain Pending Item now, so the trigger can outlive the
    // turn it fired in — a chain that is still resolving as the turn passes would
    // otherwise make Viktor refuse a trigger that had genuinely fired on the
    // opponent's turn. 383 fixes what triggered at the moment of the event.
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      state.activePlayerIndex !== listener.ownerIndex,
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: the dispatcher already filters by
      // `on`, but the compiler cannot see that, and the check documents which
      // event this listener is reading fields off.
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR card
      // "in your base" is stated, so the destination is fixed rather than chosen.
      return placeRecruitToken(state, listener.ownerIndex, "base");
    },
  },
  "OGN-091": {
    // Pit Crew — "When you play a gear, ready me."
    //
    // Rides the existing `cardPlayed` event, whose `playedKind` is a REQUIRED
    // field precisely so a listener can ask what was played without a producer
    // being able to omit the answer. No new event, no new field.
    //
    // "YOU play" is the caster against the listener's controller — the opponent
    // equipping their own board must not ready mine. Deliberately NOT the check
    // Viktor - Innovator makes above (his is caster vs the ACTIVE player, which
    // is a different question and would fire this only on the opponent's turn).
    //
    // `readyUnit` rather than `readyPermanent`: "ready me" is a unit readying
    // itself, and Pit Crew can be standing in base or at a battlefield, both of
    // which readyUnit reaches. Already-ready is a harmless no-op, so there is no
    // exhaustion guard — a trigger that fired and changed nothing and a trigger
    // that did not fire are the same board here.
    on: "cardPlayed",
    // Both conditions are properties of the EVENT, so they cannot drift across
    // the response window this hold opens — but they still belong here, because
    // `cardPlayed` is a Chain Pending Item and a trigger held for a Spell or for
    // the opponent's gear would cost both players a PassFocus for nothing.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.casterIndex === listener.ownerIndex && event.playedKind === "Gear",
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR gear
      if (event.playedKind !== "Gear") return state;
      return readyUnit(state, listener.card.instanceId);
    },
  },
  "SFD-069": {
    // Plundering Poro — "When I conquer, play a Gold gear token exhausted."
    //
    // "When I conquer" is the POSITIONAL reading, identical to Kai'Sa -
    // Evolutionary's above: the Poro has to be standing AT the battlefield taken.
    // That is what separates a unit's own conquest ("when I") from a Legend's or
    // Super Mega Death Rocket's "when YOU conquer", which the same
    // `battlefieldConquered` event serves and which each card asks for itself.
    //
    // Nothing is chosen and nothing is conditional, so the whole card is one call:
    // the token is the Poro's payout for having been the body that took the
    // battlefield, and 2 Energy for a 2-Might unit is priced against it.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // The conqueror is a fact about the EVENT, so re-asking it is free and
      // cannot come to a different answer across the response window. The
      // POSITION deliberately is not re-asked: 383 fixes what triggered at the
      // moment of the event, and an opponent moving the Poro off the battlefield
      // in response must not cancel a trigger that has already fired.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return placeGoldTokens(state, listener.ownerIndex, 1);
    },
  },
  "SFD-063": {
    // Chemtech Cask — "When you play a spell on an opponent's turn, you may
    // exhaust me to play a Gold gear token exhausted."
    //
    // Viktor - Innovator's trigger condition narrowed to SPELLS, and it is only
    // reachable at all because of reaction-speed timing: with no [Action] or
    // [Reaction] in the pool you could never play anything on someone else's turn,
    // so this would be a trigger that cannot fire. "On an opponent's turn" is the
    // ACTIVE player against the CASK's controller — not against the caster, which
    // is a different question and would fire this on the opponent's own plays.
    //
    // "You may EXHAUST ME TO play..." is a cost, not a rider, so it stops to ask:
    // Solari Shrine (OGN-072) is the shape, down to the split between the two
    // checks. The trigger CONDITIONS are facts about the event and settle whether
    // it fired; the Cask being ready is a fact about the BOARD when it resolves,
    // and the response window this hold opens can spend it. So the exhaustion is
    // asked at resolution and an already-spent Cask asks nothing rather than
    // offering a cost it cannot pay.
    //
    // One Cask, one token, per spell — a second Cask on the board is a second
    // listener with its own exhaust to pay, which is what "exhaust ME" means.
    on: "cardPlayed",
    // Held (383), so all three are asked before a Pending Item is placed: a
    // trigger held for the opponent's spell, or for your own Unit, would close the
    // chain and cost both players a PassFocus for a question with no answer.
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Spell" &&
      state.activePlayerIndex !== listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      // Both re-checks are of the EVENT, which the response window cannot alter —
      // and `activePlayerIndex` deliberately is NOT re-asked, for the reason
      // Viktor's entry records: `cardPlayed` is a Chain Pending Item, so a chain
      // still resolving as the turn passes would otherwise make the Cask refuse a
      // trigger that genuinely fired on the opponent's turn.
      if (event.casterIndex !== listener.ownerIndex || event.playedKind !== "Spell") return state;
      // A Gear in play, so the narrowing is a formality — but `Listener.card` is a
      // CardInstance now that trash listeners share the type, and a Spell has no
      // `exhausted`. Same two lines Solari Shrine writes.
      if (listener.card.kind === "Spell" || listener.card.exhausted) return state;
      return parkDecision(state, {
        kind: "SFD-063-gold",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-082": {
    // Ezreal - Dashing — "When I attack or defend, deal damage equal to my Might
    // to an enemy unit here. I don't deal combat damage. [Mind]: [Action] — Move
    // me to your base."
    //
    // **ONE of THREE clauses. Deliberately, and it is the clause that makes him
    // stronger rather than weaker, so it is worth being loud about:**
    //
    //  - "I don't deal combat damage" is a COMBAT-ASSIGNMENT fact and belongs
    //    beside `combatAssignmentDefIds` in engine/combat.ts. Without it this
    //    Ezreal deals his trigger damage AND his Might in the damage step, i.e.
    //    he is played better than he is printed. That is the drawback the trigger
    //    is priced against.
    //  - ":rb_rune_mind:: [Action] — Move me to your base" is an activated
    //    ability with a Power cost, which engine/activated-abilities.ts already
    //    expresses (`ActivationCost.power`, Treasure Trove's shape) — it needs a
    //    registry entry there, not a new subsystem.
    //
    // Neither file is this one's to edit. The clause below is whole on its own
    // terms and is written rather than withheld, the same call Wallop (OGN-146,
    // effects/body.ts) records for its unreachable half.
    //
    // "When I attack OR DEFEND" is `isFightingAt` — Ahri - Inquisitive's
    // indifference to which side started the fight, not Yasuo - Remorseful's
    // attacker-only reading. The designation is fixed when the combat opens
    // (383), so it is asked here and NOT re-asked below: moving him away during
    // the response window must not cancel an ability that has already triggered.
    on: "combatBegan",
    applies: isFightingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      if (!bf) return state;
      // **"MY Might" is read LIVE at resolution, not off `listener.card`**, and
      // the rules work this exact sentence to say so. 359.3.e.14's own example is
      // Strike Down — "It deals damage equal to its Might to an enemy unit" —
      // where the answer is "null" once the unit's information is no longer
      // available, "and the instructions related to it are ignored"; the very
      // next clause is that information about a permanent whose zone and status
      // HAVE NOT changed "is accessible". A fire-time snapshot gets both ends
      // wrong: it pays out for an Ezreal who has left the board, and it misses a
      // pump landed in the response window this hold opens.
      //
      // **This is a divergence from Yasuo - Remorseful (OGN-076, effects/calm.ts),
      // which reads `listener.card` for the same sentence.** Reported rather than
      // fixed — that file belongs to another owner.
      const self = findUnitAnywhere(state, listener.card.instanceId);
      if (!self) return state; // off the board: null Might, so the deal is ignored
      // `isCombat: false` for the reason Yasuo's entry records: `[Assault]` and
      // `[Shield]` are terms of the COMBAT damage step, and counting them in a
      // damage INSTRUCTION would pay them twice in one fight. Buffs, this-turn
      // pumps and continuous auras all count, and the context is built from where
      // he is standing NOW rather than from the event, so an aura at a
      // battlefield he was moved to is the one that applies.
      const might = effectiveMight(state, self.unit, self.ownerIndex, mightContextFor(state, self));
      // "An enemy unit HERE" — the first at the battlefield the combat opened at,
      // in board order, auto-selected rather than asked. Same simplification and
      // the same structural reason (no action to hang the choice on) as Yasuo,
      // Ahri, Teemo and Crackshot Corsair; filed Unverified in
      // docs/rules-conformance.md.
      const ownerId = state.players[listener.ownerIndex].id;
      const enemyId = Object.entries(bf.units)
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units.map((u) => u.instanceId))[0];
      if (enemyId === undefined) return state;
      // 718.5 — "If no damage was Dealt, then Bonus Damage will not apply." A
      // 0-Might Ezreal (Smoke Screen has a floor, Thousand-Tailed Watcher does
      // not reach him, but a future -Might card will) must skip `dealDamage`
      // rather than call it with 0, or Annie - Fiery's +1 in damage-modifiers.ts
      // would turn "no damage" into 1. Teemo - Strategist's guard, and the rule
      // is the same one.
      if (might <= 0) return state;
      return dealDamage(state, listener.ownerIndex, enemyId, might);
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
/** The spells in `playerIndex`'s trash that Kai'Sa - Evolutionary could play —
 *  "a spell ... with Energy cost less than your points". Read from the PRINTED
 *  cost, which is what every other effect asking about a card's cost uses, and
 *  strictly less than, as printed. */
function evolutionaryCandidates(state: GameState, playerIndex: 0 | 1) {
  const actor = state.players[playerIndex];
  return actor.trash.filter((c) => c.kind === "Spell" && c.energyCost < actor.points);
}

export const decisions: Record<string, DecisionDefinition> = {
  "SFD-084-kill": {
    // Jayce - Man of Progress's "you may kill a friendly gear. If you do, ..."
    prompt: () => "Jayce - Man of Progress: kill a friendly gear to play one free this turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].activeGear.map((g) => ({
        id: g.instanceId,
        label: `Kill ${g.name}`,
        instanceId: g.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      // Re-derived at answer time: the gear may have gone while the question
      // waited on the chain, and "if you do" then grants nothing.
      if (gear === undefined) return state;
      const killed = killGear(state, gear, d.playerIndex);
      // A COUNT, not a flag — two Jayces in a turn grant two windows. Same
      // reasoning as `nextUnitsEnterReady`, which this field sits beside.
      const players = [...killed.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        freeGearPlaysThisTurn: players[d.playerIndex].freeGearPlaysThisTurn + 1,
      };
      return { ...killed, players };
    },
  },
  "SFD-074-kill": {
    // Pickpocket's "you may kill a gear with Energy cost no more than [1]. If you
    // do, play a Gold gear token exhausted."
    prompt: () => "Pickpocket: kill a gear costing [1] or less?",
    options: (state) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // BOTH sides — see the trigger above for why "a gear" is unqualified. The
      // owner index is encoded in the option id, because `killGear` needs to be
      // told whose list to remove it from and an instance id alone does not say.
      for (const ownerIndex of [0, 1] as const) {
        for (const gear of state.players[ownerIndex].activeGear) {
          if (gear.energyCost > PICKPOCKET_MAX_GEAR_COST) continue;
          options.push({
            id: `${ownerIndex}:${gear.instanceId}`,
            label: `Kill ${gear.name}`,
            instanceId: gear.instanceId,
          });
        }
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const [ownerRaw, instanceId] = optionId.split(":");
      const ownerIndex = ownerRaw === "1" ? 1 : 0;
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === instanceId);
      // Re-derived at answer time, the convention every decision here follows:
      // the gear may have been killed by something else while this waited, and
      // "if you do" then means no Gold.
      if (gear === undefined || gear.energyCost > PICKPOCKET_MAX_GEAR_COST) return state;
      // The Gold goes to the PLAYER WHO ASKED, not to the gear's owner — "play a
      // Gold gear token" is Pickpocket's controller playing it. Exhausted, as
      // printed, which `placeGoldTokens` already does for every Gold in the pool.
      return placeGoldTokens(killGear(state, gear, ownerIndex), d.playerIndex, 1);
    },
  },
  /**
   * Promising Future's first half — one player banishing one of their own top 5.
   *
   * Asked of BOTH players (the caster has no say over the opponent's pick), and
   * "looks at" is exactly the moment Nocturne - Horrifying's own text watches
   * for, which is why this goes through `lookAtTopOfDeck` rather than slicing
   * the deck itself.
   */
  "OGN-115-banish": {
    prompt: () => "Promising Future: banish one of the top 5 of your deck (the rest are recycled)",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 5).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const looked = state.players[d.playerIndex].deck.slice(0, 5);
      const chosen = looked.find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Off the top FIRST, recycling the other four to the bottom in the order
      // they were looked at (416) — so the banish and the recycle are reckoned
      // against the same five, and a deck shorter than five simply looks at what
      // it has (422).
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [
          ...players[d.playerIndex].deck.slice(looked.length),
          ...looked.filter((c) => c.instanceId !== chosen.instanceId),
        ],
        // Only the second real writer of the banished zone (Time Warp's "banish
        // this" is the other), and the first whose banish is OBSERVABLE for more
        // than an instant: every other banish here is transient — banished and
        // played in one instruction — while these sit banished until the second
        // half of the card plays them, the opponent's waiting there while the
        // caster is still choosing.
        banished: [...players[d.playerIndex].banished, chosen],
      };
      // "then RECYCLES the rest" — the four that were not banished.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length - 1);
    },
  },
  /**
   * Promising Future's second half — one player playing what they banished,
   * "ignoring Energy costs. (They must still pay Power costs.)"
   *
   * A decision with exactly ONE option, which `advanceDecisions` resolves without
   * ever prompting. That is not a question dressed up as one: the step is
   * mandatory, and the queue is the only thing in this engine that can say
   * "after both players have finished choosing". Parked for the next player and
   * the caster behind the two banish questions, which is the whole of "starting
   * with the next player".
   *
   * **Unverified, and it is the card's one real gap:** a Spell played this way
   * resolves immediately with no targets, per `play-free`'s recorded divergence,
   * so a targeted Spell banished here does as much as it can and no more.
   */
  "OGN-115-play": {
    prompt: () => "Promising Future: play the card you banished, ignoring its Energy cost",
    options: () => [{ id: "play", label: "Play it" }],
    resolve: (state, d) => {
      const actor = state.players[d.playerIndex];
      // The LAST banished card is the one this player just banished. Safe
      // because a pending decision is the ONLY thing a player may act on
      // (legal-actions returns answers and nothing else while one is queued), so
      // no other card — not even Time Warp, the zone's other writer — can reach
      // the zone between the question above and this one.
      const card = actor.banished[actor.banished.length - 1];
      if (!card) return state;
      // "They must still pay Power costs" — and a player who cannot is a player
      // who does not play it (422). The card stays banished rather than being
      // played free, which is the difference between this and every other
      // ignoring-its-cost card in the pool.
      // A Legend is never in a Main Deck, so it can never be one of the five —
      // but `CardInstance` includes it and only the other three kinds print a
      // Power cost, so the narrowing is the compiler asking a real question.
      const powerCost = card.kind === "Legend" ? 0 : card.powerCost;
      const paid =
        powerCost > 0 && card.kind !== "Legend"
          ? payPowerFromChanneled(state, d.playerIndex, card.powerDomain, powerCost)
          : state;
      if (paid === undefined) return state;

      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        banished: players[d.playerIndex].banished.filter((c) => c.instanceId !== card.instanceId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      return playCardIgnoringCost({ ...paid, players }, d.playerIndex, card);
    },
  },
  /**
   * Ava Achiever's "when I attack, you may pay [Mind] to play a card with
   * [Hidden] from your hand, ignoring its cost. If it's a unit, play it here."
   *
   * ONE question, not two: which card and whether to pay are the same decision,
   * because paying without naming a card buys nothing. Every option carries its
   * own price, so a pool that cannot afford the [Mind] offers only "decline" and
   * `advanceDecisions` retires the question without a prompt.
   *
   * `[Hidden]` is asked of the DEFINITION, never of the printed text — Ava
   * herself is one of the four cards that MENTION the keyword without carrying
   * it, so a text scan would let her play herself out of hand.
   */
  "OGN-107-play": {
    prompt: () => "Ava Achiever: pay 1 Mind to play a [Hidden] card from your hand, ignoring its cost?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Payability is asked once, of the pool, rather than per card: the price is
      // the same [Mind] whichever card is named.
      if (payPowerFromChanneled(state, d.playerIndex, "Mind", 1) === undefined) return options;
      const registry = defaultCardRegistry();
      for (const card of state.players[d.playerIndex].hand) {
        if (!isHiddenCard(registry.tryGet(card.defId))) continue;
        options.push({ id: card.instanceId, label: `Pay 1 Mind: play ${card.name}`, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const chosen = state.players[d.playerIndex].hand.find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Pay first, and do nothing if the Mind has gone since the offer — a
      // half-paid free play is the card without its price.
      const paid = payPowerFromChanneled(state, d.playerIndex, "Mind", 1);
      if (paid === undefined) return state;

      // Out of hand BEFORE playing, so the card is never in two zones at once.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        hand: players[d.playerIndex].hand.filter((c) => c.instanceId !== chosen.instanceId),
        // "PLAY a card" — this one IS a card you played, unlike the free plays
        // that a card's own text performs on itself, so [Legion] and Viktor -
        // Innovator both see it.
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // "If it's a unit, play it HERE" — the battlefield she attacked, captured
      // when the question was raised. A Gear or a Spell ignores it, neither
      // being a thing that stands anywhere.
      return playCardIgnoringCost({ ...paid, players }, d.playerIndex, chosen, d.battlefieldId);
    },
  },
  // Kai'Sa - Evolutionary's "you may play a spell from your trash ... then
  // recycle it", raised by her conquer trigger.
  //
  // Declining leads, as everywhere else a "you may" is asked. "THEN RECYCLE IT"
  // is the card's own answer to the loop it would otherwise be: the spell goes to
  // the BOTTOM OF THE DECK rather than back to the trash, so a second conquest
  // cannot replay the same one.
  "OGN-112-play": {
    prompt: () => "Kai'Sa - Evolutionary: play a spell from your trash for free?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...evolutionaryCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const chosen = evolutionaryCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Out of the trash BEFORE playing, so the spell is not in two zones at once
      // and `playCardIgnoringCost`'s own trash step lands it exactly once.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
      };
      const played = playCardIgnoringCost({ ...state, players }, d.playerIndex, chosen);
      // "Then RECYCLE it" — bottom of the Main Deck (1924), taken back out of the
      // trash that `playCardIgnoringCost` just put it in.
      const after = [...played.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = {
        ...after[d.playerIndex],
        trash: after[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
        deck: [...after[d.playerIndex].deck, chosen],
      };
      return { ...played, players: after };
    },
  },
  /**
   * Aspiring Engineer's "return a gear from your trash to your hand".
   *
   * No decline option: the instruction carries no "you may", so with a gear in
   * the trash one comes back. Only GEAR is offered — the card names a kind, and
   * offering the rest of the trash would be a different, much better card.
   *
   * The one-gear case never reaches a human: `advanceDecisions` executes a
   * single-option question instead of prompting with it, which is also what makes
   * this shape usable for a mandatory instruction at all.
   */
  "SFD-061-return": {
    prompt: () => "Aspiring Engineer: return a gear from your trash to your hand",
    options: (state, d) =>
      gearsInTrash(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => returnCardFromTrash(state, d.playerIndex, optionId),
  },
  /**
   * Bubble Bot's "ready another friendly Mech".
   *
   * `cardInstanceId` is BUBBLE BOT herself, captured when the question was
   * raised, and it is what "another" is measured against. Captured rather than
   * re-derived because by the time the answer arrives she may have been killed in
   * the response window — 809.1.b makes the ability independent of its source, so
   * the Mech is still readied, and an exclusion that could not name her would
   * quietly become an exclusion of nobody.
   *
   * The options are rebuilt from live state (as every decision's are), so a Mech
   * that was readied or killed while this waited is simply not on the list.
   */
  "SFD-062-ready": {
    prompt: () => "Bubble Bot: ready another friendly Mech",
    options: (state, d) =>
      readyableMechs(state, d.playerIndex, d.cardInstanceId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => readyUnit(state, optionId),
  },
  /**
   * Chemtech Cask's "you may exhaust me to play a Gold gear token exhausted",
   * raised by its cardPlayed trigger — which has already established that the
   * spell was YOURS, that it was a spell, that it was played on the opponent's
   * turn, and that the Cask was still ready when the ability resolved.
   *
   * Two options always, so `advanceDecisions` can never answer it for you: a "you
   * may" the engine resolves is not a "you may". Declining is a real play — the
   * Cask's exhaust is worth keeping for a bigger spell later in the same window,
   * since the trigger fires on EVERY spell you play on their turn.
   *
   * No `instanceId` on either option, deliberately, for the reason Solari Shrine's
   * question records: the board renders an option carrying one as the CARD, which
   * is right for "pick one of your units" and wrong for a yes/no.
   */
  "SFD-063-gold": {
    prompt: () => "Chemtech Cask: exhaust it to play a Gold gear token exhausted?",
    options: () => [
      { id: "gold", label: "Exhaust and play a Gold token" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "gold" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then make the token: the exhaust is the COST, and
      // `exhaustGear` no-ops on a Cask that has left play or been spent since the
      // offer — so a state where the price cannot be paid must not hand over the
      // Gold. Identity against the input state is how that no-op is detected,
      // exactly as Solari Shrine's draw detects it.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : placeGoldTokens(paid, d.playerIndex, 1);
    },
  },
  /**
   * Card Sharp's own half — "YOU ... may play a Gold gear token exhausted".
   *
   * Free, and there is no board on which taking it is wrong, but it is printed
   * "may" and so it is asked. Two options for the same reason Solari Shrine's
   * question has two: `advanceDecisions` executes a single-option question without
   * prompting, which would quietly rewrite the word.
   *
   * Deliberately NOT merged with the opponent's question below even though the two
   * are worded identically: they are answered by different players, and one
   * decision has one `playerIndex`.
   */
  "SFD-081-mine": {
    prompt: () => "Card Sharp: play a Gold gear token exhausted?",
    options: () => [
      { id: "gold", label: "Play a Gold token" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => (optionId === "gold" ? placeGoldTokens(state, d.playerIndex, 1) : state),
  },
  /**
   * Card Sharp's opponent-facing half — "each opponent may play a Gold gear token
   * exhausted. For each opponent who did, you play a Gold gear token exhausted."
   *
   * `d.playerIndex` is the OPPONENT (the chooser); the caster is the other seat,
   * derived rather than carried, which is Party Favors' precedent and is exact
   * while this engine is two-player (`GameState.players` is a 2-tuple).
   *
   * **The caster's bonus token is paid HERE, inside the opponent's answer, rather
   * than by a third queued step.** "For each opponent who did" needs to know what
   * the opponent chose, and nothing on the board records a choice — counting Gold
   * tokens afterwards would be reading a total that the caster's own half, or a
   * Chemtech Cask, could also have moved. With exactly one opponent, folding the
   * bonus into their answer produces the same tokens in the same order as a
   * separate step would (their token, then the caster's). It is the one place this
   * entry would need rewriting if the engine ever seated three players, and it is
   * written down rather than left to be discovered.
   *
   * The prompt states the consequence, because it IS the decision: a Gold for you
   * costs a Gold to the player who just played the card.
   */
  "SFD-081-theirs": {
    prompt: () => "Card Sharp: play a Gold gear token exhausted? (if you do, the caster plays one too)",
    options: () => [
      { id: "gold", label: "Play a Gold token (the caster gets one)" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "gold") return state;
      const caster = (1 - d.playerIndex) as 0 | 1;
      return placeGoldTokens(placeGoldTokens(state, d.playerIndex, 1), caster, 1);
    },
  },
};
