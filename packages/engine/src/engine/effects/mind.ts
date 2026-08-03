import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellEffect,
  DeathWatchEffect,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import { drawCards } from "../effect-helpers.js";
import { controlsAnyFacedownCard, isHiddenCard } from "../hidden.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import { placeRecruitToken, placeToken, type TokenSpec } from "../token.js";
import {
  banishCard,
  channelRunesExhausted,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  exhaustAllFriendlyUnits,
  giveMightThisTurn,
  giveMightThisTurnToAllEnemies,
  payPowerFromChanneled,
  readyUnit,
  recycleUnitFromPlayToDeck,
  removeUnitAnywhere,
  returnUnitToHand,
} from "../effect-helpers.js";
import { playUnitToBase } from "../deploy.js";
import { playCardIgnoringCost } from "../play-free.js";
import { parkDecision } from "../decisions.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";
import type { GameState, PlayerState } from "../../model/game-state.js";

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

/** The non-combat MightContext for a unit wherever it is standing — the same
 *  three lines Gentlemen's Duel and Kinkou Monk already write out, needed here
 *  because Convergent Mutation compares two units' Might across zones. */
function mightContextFor(state: GameState, location: AnyUnitLocation) {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}

/**
 * "When I defend" — the other side of Yasuo - Remorseful's test, and the reason
 * neither card needs an event of its own.
 *
 * A Defend trigger fires when the unit gains the **Defender** designation, which
 * rule 465's Combat Step 1 puts at the opening of the Combat Showdown ("Units at
 * the Contested Battlefield controlled by the Attacker or Defender gain the
 * Attacker or Defender designation now"), i.e. at `combatBegan`. Which side
 * attacked is `bf.contestedByIndex` — 465's own definition of the Attacker,
 * still set here because `clearContested` runs only when the Showdown closes —
 * so everyone else standing at that battlefield is defending.
 *
 * Shared by Teemo's `applies` and his `resolve` so the two cannot drift. Both
 * need it: the inline dispatch path never consults `applies`, and once
 * `combatBegan` becomes a Chain Pending Item the two are separated by a response
 * window in which Teemo can be moved off the battlefield he was defending.
 */
function isDefendingAt(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "combatBegan") return false;
  if (listener.card.kind !== "Unit") return false;
  if (listener.battlefieldId !== event.battlefieldId) return false;
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  return bf !== undefined && bf.contestedByIndex !== null && bf.contestedByIndex !== listener.ownerIndex;
}

export const cardEffects: Record<string, EffectDefinition> = {
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
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
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
    // and card-loader.ts's HIDDEN_KEYWORD_FALSE_POSITIVES is where that is
    // already settled. A text scan would count them and still look like a working
    // card.
    //
    // "Recycle" is 416/425 — the bottom of the corresponding deck, in revealed
    // order. A deck shorter than 5 reveals what it has: this is an EFFECT, so
    // 422's do-as-much-as-you-can applies rather than `recycleFromTrash`'s
    // all-or-nothing cost rule, the same distinction Dr. Mundo - Expert draws
    // below.
    on: "combatBegan",
    // **Currently unread.** `combatBegan` is still dispatched inline by
    // cleanup.ts and only `holdEventTrigger` consults `applies`. Written anyway
    // because `combatBegan` is next in the Chain conversion queue and this is
    // exactly the predicate it will need — "when I defend" is a fact about the
    // board at the moment of the event, and holding the trigger for a Teemo who
    // is ATTACKING would open a response window for an ability that resolves to
    // nothing.
    applies: isDefendingAt,
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: the dispatcher filters by `on`, but
      // the compiler cannot see it, and `isDefendingAt` cannot hand back the
      // narrowed event.
      if (event.kind !== "combatBegan") return state;
      if (!isDefendingAt(state, listener, event)) return state;

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
      return offerTopOfDeckBanish({ ...damaged, players }, listener.ownerIndex, revealed);
    },
  },
  "OGN-119": {
    // Ahri - Inquisitive — "When I attack or defend, give an enemy unit here
    // -2 Might this turn, to a minimum of 1 Might."
    //
    // "Attacks OR DEFENDS" is why this listens to `combatBegan` rather than
    // riding the on-attack table: that one fires only for the unit that moved
    // in. The same distinction Mask of Foresight already draws — which side
    // started the fight is deliberately not consulted.
    //
    // She must be AT the battlefield in question, and the target is auto-selected
    // from the enemies there (same precedent as the other combat triggers, filed
    // Unverified). The floor is her own printed clause.
    on: "combatBegan",
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.battlefieldId !== event.battlefieldId) return state;
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
      return { ...state, players };
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
  },};
