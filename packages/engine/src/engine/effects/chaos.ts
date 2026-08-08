import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellDefinition,
  DeathWatchDefinition,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  channelRunesExhausted,
  dealDamage,
  destroyUnit,
  discardCards,
  discardThenDraw,
  drawCards,
  forceMoveToBattlefield,
  forceMoveToDestination,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  holdCardsRecycled,
  grantTemporary,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  payEnergyFromPool,
  exhaustGear,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  returnPermanentToHand,
  returnUnitToHand,
  swapUnitLocations,
  takeOneFromTopAndRecycleRest,
  takeControlOfUnit,
} from "../effect-helpers.js";
import { findUnitAnywhere, unitWithinMaxMight } from "../target-lookup.js";
import { attackerIndexAt, attackingUnitsAt, isDefendingAt } from "../combat-designation.js";
import { killGear } from "../triggers.js";
import { playUnitToBase } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { RAINBOW } from "../hidden.js";
import { placeGoldTokens } from "../token.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import { gainPoints } from "../effect-helpers.js";
import { wearerListener } from "../equipment.js";

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
/** Hard Bargain's ransom — "unless its controller pays [2]". */
const HARD_BARGAIN_RANSOM = 2;

export const cardEffects: Record<string, EffectDefinition> = {
  "SFD-135": {
    // Factory Recall — "[Action] Return a gear to its owner's hand."
    //
    // "A GEAR", unqualified, so it reaches EITHER side — which is what makes a
    // 1-Energy spell worth a card: it answers an enemy Equipment as readily as it
    // rescues your own from a board wipe.
    //
    // A `gear`-kind target rather than `unitOrGear`: the card names a gear and
    // nothing else, and the narrower spec is what stops a unit being offered and
    // then refused.
    //
    // "To its OWNER's hand" is what `returnPermanentToHand` already does — it
    // locates the permanent on either side rather than assuming the caster owns
    // it, which is exactly the case this card creates.
    targeting: { kind: "gear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? returnPermanentToHand(state, event.targetPermanentInstanceId) : state,
  },
  "OGN-203": {
    // Possession — "Choose an enemy unit at a battlefield. Take control of it and
    // recall it."
    //
    // The pool's first change of a UNIT's controller. In this engine control IS
    // which player's list the unit sits in, so taking it and recalling it are one
    // operation — see `takeControlOfUnit`.
    //
    // "AT A BATTLEFIELD" is printed, so the default scope stands and a unit
    // sitting in the opponent's base is safe from it. At 8 Energy and 3 Power
    // that restriction is most of what keeps the card honest.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? takeControlOfUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "OGN-173": {
    // Ride The Wind — "[Action] Move a friendly unit and ready it."
    //
    // The destination rides on `destinationBattlefieldId`, which is only
    // enumerated for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS
    // (`cardMovesTarget`) — without that entry this resolver would always be
    // handed `undefined` and the card would be castable, inert and reported as
    // done. It is the third card in that set, after Charm and Showstopper.
    //
    // `scope: "anywhere"`, not the default: "a friendly unit" is 355.9.b's bare
    // noun, so a unit in base is a legal choice — and it is the main one, since
    // this is how the card deploys. Charm's "an ENEMY unit" is the contrast.
    //
    // MOVE then READY, printed order. It matters: moving into a contested
    // battlefield is what opens the Showdown, and arriving ready is what lets the
    // unit fight in it. Readying first and moving second reaches the same board,
    // but through a state the card does not describe.
    //
    // `forceMoveToBattlefield` rather than a list splice, because the move must
    // apply Contested and stage the Showdown — the same funnel Charm uses. Note
    // this is a MOVE, so it is exactly the kind [Ganking] and the move validator
    // constrain for a player-initiated MoveUnit; a spell moving a unit is not
    // subject to those, which is what makes the card worth casting.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: unitId } = event;
      if (!unitId) return state;
      // "Move a friendly unit AND READY IT" — the ready happens whichever
      // Location it went to, including base (359.3.e names this card's base
      // move by example). Readying after the move, printed order.
      return readyUnit(forceMoveToDestination(state, unitId, event), unitId);
    },
  },
  "OGN-172": {
    // Rebuke — "[Action] Return a unit at a battlefield to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong: a unit sitting in base is out of
    // reach, which is the whole limit on the card. That distinction is
    // load-bearing here and this codebase has got it wrong before.
    //
    // No owner restriction — "a unit", not "an enemy unit". Bouncing your own is
    // a real line (it resets damage and saves a unit about to die), not an
    // oversight, and 355.9.b's bare noun carries no side.
    //
    // returnUnitToHand sends it to its OWNER's hand rather than the caster's,
    // and strips Buffs on the way (709, "if a Unit leaves play, remove all Buffs
    // from it") — both already handled there, which is why this is one call.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state),
  },
  "SFD-129": {
    // Temptation — "[Repeat] [2] Move an enemy unit to a location where there's
    // a unit with the same controller."
    //
    // Charm's move with the pool's first RESTRICTED destination. "The same
    // controller" is the MOVED unit's controller, not the caster's — the card
    // lures an enemy unit toward its own friends rather than toward yours, which
    // is what makes it a tempo card instead of a gift. See
    // `moveDestinationAllowed`, which the enumerator and the validator both ask.
    //
    // The moved unit does not count as the unit that is already there: it is not
    // at the destination yet, and counting it would make every destination legal
    // and the restriction meaningless.
    //
    // `scope: "anywhere"` — "an enemy unit" is 355.9.b's bare noun, so one
    // sitting in the enemy base is a legal target, and dragging it out is a real
    // line.
    //
    // **DIVERGENCE, pre-existing and shared**: the rules make a BASE a legal
    // destination for a spell's move (828 "Locations include the Battlefields and
    // the Bases", and 1442 works the example with Ride The Wind moving a unit "to
    // base"). This engine's `destinationBattlefieldId` carries only a
    // battlefield, so Charm, Showstopper, Ride The Wind, Stormbringer and
    // Dragon's Rage are all already battlefield-only, and this card joins them.
    // Recorded in docs/rules-conformance.md rather than half-fixed here, because
    // closing it changes five existing cards' enumeration.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: unitId } = event;
      if (!unitId) return state;
      // Through the shared destination helper like every other move: arriving at
      // a BATTLEFIELD applies Contested and can stage a Showdown the caster is
      // not part of, which for this card is frequently the entire point. A move
      // to BASE contests nothing — there is nothing there to contest — which is
      // why the card's own word is "location" and not "battlefield".
      return forceMoveToDestination(state, unitId, event);
    },
  },
  "SFD-136": {
    // Hard Bargain — "[Reaction] [Repeat] [2] Counter a spell unless its
    // controller pays [2]."
    //
    // Wind Wall's targeting with Shakedown's second half: the CASTER picks the
    // spell, and then the spell's CONTROLLER picks the poison — pay 2 Energy, or
    // be countered. So the target is an ordinary `chainSpell` fan-out on the
    // action and the ransom is a decision belonging to the other seat.
    //
    // No cost filter — unlike Defy, the card names none, so any spell on the
    // chain is a legal target including the caster's own. Countering your own
    // spell to dodge something worse is a real (if rare) line, and nothing in the
    // text forbids it; the decision then simply belongs to the caster.
    //
    // The controller is read from the CHAIN ENTRY when the question is raised and
    // travels on the decision, the same reasoning Shakedown records: by the time
    // it is answered the chain has moved.
    //
    // **Repeating it is a DOUBLE ransom, not a double counter, and that falls out
    // of the ordering rather than being arranged.** Both executions run back to
    // back inside one resolution (820.1.d) and decisions are answered afterwards,
    // so two ransom questions are queued against the same spell. Answering the
    // first by paying leaves the spell on the chain for the second to ask again —
    // 2 Energy, then 2 more. Answering the first by declining counters it, and
    // the second question then finds nothing to counter and resolves to nothing.
    // That second case is why the decision re-checks the chain at ANSWER time
    // instead of trusting that its target still exists (359.3).
    targeting: { kind: "chainSpell" },
    resolve: (state, _ctx, event) => {
      const spellId = event.targetChainCardInstanceId;
      if (!spellId) return state;
      const target = spellsOnChain(state).find((s) => s.entry.card.instanceId === spellId);
      if (!target) return state; // already countered — 359.3
      return parkDecision(state, {
        kind: "SFD-136-ransom",
        playerIndex: target.entry.playerIndex,
        cardInstanceId: spellId,
      });
    },
  },
  "SFD-122": {
    // Called Shot — "[Action] [Repeat] [Chaos] Look at the top 2 cards of your
    // Main Deck. Draw one and recycle the other."
    //
    // Stacked Deck (OGN-183, below) at 2 instead of 3. "Draw one" and "put 1
    // into your hand" are the same instruction, so it is the same helper —
    // `takeOneFromTopAndRecycleRest` — and a decision for the same forced
    // reason: `legal-actions` enumerates from PUBLIC state and the top of a deck
    // is not public, so fanning the choice onto the action would hand the AI its
    // own deck order.
    //
    // **Repeating this parks a SECOND decision**, and that is correct rather
    // than incidental. Both executions run back to back inside one resolution
    // (820.1.d), each parking its own question; `parkDecision` mints a fresh id
    // per call and appends FIFO, so the two are distinct queue entries answered
    // in order. The second decision's options are rebuilt from LIVE state when
    // it is answered, so it names the top 2 cards as they stand AFTER the first
    // draw-and-recycle — not a stale snapshot taken during resolution. That is
    // the whole reason `DecisionDefinition.options` is a function of state.
    //
    // Its Repeat cost is `[Chaos]` with NO Energy, the only such cost in the
    // set, which is why Marai Spire's Energy discount cannot touch it — see
    // `modifiedRepeatEnergy`'s floor.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // Nocturne's offer first, for the reason Reinforce's own resolve gives.
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 2)), {
        kind: "SFD-122-keep",
        playerIndex: ctx.casterIndex,
      }),
  },
  "OGN-183": {
    // Stacked Deck — "Look at the top 3 cards of your Main Deck. Put 1 into your
    // hand and recycle the rest."
    //
    // A decision rather than a fan-out on the action, and that is forced rather
    // than chosen: legal-actions enumerates from PUBLIC state, and the top of a
    // deck is not public. Fanning it out would put the three card identities
    // into the action list, which the AI reads — handing it knowledge of its own
    // deck order that a human casting the same spell would only learn on
    // resolution.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // Nocturne's offer first, for the reason Reinforce's own resolve gives.
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 3)), {
        kind: "OGN-183-keep",
        playerIndex: ctx.casterIndex,
      }),
  },
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
  },
  "OGN-179": {
    // Acceptable Losses — "[Action] Each player kills one of their gear."
    //
    // Cull the Weak (OGN-209, effects/order.ts) with gear in place of units, and
    // it is the same card structurally: no targeting spec, because the caster
    // does not pick two victims — each player picks their OWN, at resolution,
    // through engine/decisions.ts. Fanning the choice onto the action would also
    // commit it at cast time, and the opponent may respond on the chain in
    // between; "one of their gear" means the gear they still have when this
    // resolves.
    //
    // APNAP by rule 894 ("Turn Order is referenced to organize the sequence of
    // actions, starting with the current Turn Player"), which the FIFO decision
    // queue implements for free: the order the questions are parked in is the
    // order they are answered in.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-179-kill", state.activePlayerIndex),
  },
  "OGN-187": {
    // Whirlwind — "Starting with the next player, each player may return a unit
    // to its owner's hand."
    //
    // "Starting with the NEXT player" is an explicit override of rule 894's
    // default, which sequences simultaneous actions "starting with the current
    // Turn Player" — so this is the one card in the pool that runs APNAP
    // backwards, and the non-turn player answers first. That difference is the
    // whole reason the card names an order at all, and it is real in play: the
    // opponent has to commit before you do.
    //
    // Anchored on `activePlayerIndex` rather than the caster because "next" is
    // defined against TURN ORDER (175/179), not against whoever is resolving.
    // The two coincide here anyway — Whirlwind prints neither [Action] nor
    // [Reaction], so only the turn player can ever cast it.
    //
    // "A unit", not "a unit at a battlefield" — 355.9.b's bare noun, so a unit
    // sitting in either base is on offer too. Rebuke (above) prints the narrower
    // wording and gets the narrower reach; the difference between them is
    // printed, and this codebase has got that distinction wrong before.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-187-return", (1 - state.activePlayerIndex) as 0 | 1),
  },
  "OGN-201": {
    // Invert Timelines — "Each player discards their hand, then draws 4."
    //
    // Not a decision, and that is the point: discarding your WHOLE hand leaves
    // nothing to choose, so this goes straight through `discardCards` with a
    // count equal to the hand — which its own "a hand no bigger than `count` is
    // not a choice" branch takes without a prompt. Each player's discard is one
    // instruction, so `cardsDiscarded` fires once per player (Jinx - Rebel
    // readies once, not once per card).
    //
    // `discardThenDraw`, not `drawCards(discardCards(...))`, because "then" is
    // printed and the discard can queue work behind it: a discarded Flame
    // Chompers parks its own "you may play me" question, and a draw wrapped
    // around the discard would resolve BEFORE that question — handing the player
    // four fresh cards while the engine still owes them an answer about the old
    // hand. The hand size is read from the live state per player for the same
    // reason.
    //
    // Turn order per rule 894, matching every other "each player" card here.
    targeting: { kind: "none" },
    resolve: (state) => {
      const first = state.activePlayerIndex;
      return [first, (1 - first) as 0 | 1].reduce(
        (next, playerIndex) => discardThenDraw(next, playerIndex, next.players[playerIndex].hand.length, 4),
        state,
      );
    },
  },
  "OGN-198": {
    // The Harrowing — "Play a unit from your trash, ignoring its Energy cost.
    // (You must still pay its Power cost.)"
    //
    // Soulgorger's decision (OGN-196, in this file) with the "you may" removed,
    // and it shares its two helpers rather than carrying a second copy of them.
    //
    // MANDATORY, so no decline option. That is not merely a missing button: with
    // no payable unit in the trash the option list is EMPTY, and
    // `advanceDecisions` drops a question nobody can answer instead of
    // deadlocking on it. That is 422's do-as-much-as-you-can, and it is the
    // failure mode worth naming — a mandatory instruction that stranded its own
    // decision would hang the game rather than doing nothing visible. Tested
    // directly in test/cards-harrowing.test.ts.
    //
    // A single payable unit is likewise not a question: one option, so
    // `advanceDecisions` executes it without interrupting anyone. There is no
    // choice to make, which is exactly what "play a unit from your trash" with
    // one unit in the trash means.
    //
    // A DECISION rather than an `ownTrashCard` target for Soulgorger's second
    // reason, which survives the loss of the first: the Power is paid AT
    // RESOLUTION out of the pool as it stands then, and cannot ride on the
    // PlayCardAction's payment — that action paid the Harrowing's own 6+2.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-198-play", playerIndex: ctx.casterIndex }),
  },
  "SFD-145": {
    // Switcheroo — "[Hidden][Action] Swap the Might of two units at the same
    // battlefield this turn."
    //
    // `sameBattlefield` is Facebreaker's relation between two targets, and the
    // reason it has to live on the SPEC rather than in this resolver: by the time
    // a resolver runs the choice is already made and validated, so refusing here
    // would leave the card paid for and doing nothing.
    //
    // `min: 2` — both halves are one instruction joined by "of two units", so the
    // card is simply uncastable without a pair standing together (355: "valid
    // choices must be made for all targets"). The two slots are genuinely
    // interchangeable (a swap is the same either way round), so the default
    // symmetric pruning is right and `asymmetricSlots` would only double the
    // AI's search for one board.
    //
    // **WHICH Might is swapped is a rules call this file makes explicitly.** The
    // swap is expressed as two opposite `mightThisTurn` deltas, computed from
    // printed Might PLUS the accumulated this-turn modifier — NOT from
    // `effectiveMight`. That is `giveMightThisTurn`'s own floor convention,
    // written down there for this exact question: "Buffs and continuous auras are
    // deliberately NOT counted: they can appear and vanish after this resolves."
    // Baking an aura or a combat-only [Shield] into a delta that survives to the
    // end of the turn would keep paying out long after its source stopped
    // applying, which is a worse answer than under-counting it. So a buffed unit
    // keeps its own buff across the swap and only the base+this-turn figures
    // trade places. **Flagged as unverified** — 2236's worked example reads
    // "current Might" for a spell that references Might, which would argue the
    // other way.
    targeting: { kind: "unitSlots", slots: ["any", "any"], min: 2, sameBattlefield: true },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: firstId, secondTargetUnitInstanceId: secondId } = event;
      if (!firstId || !secondId) return state;
      const first = findUnitAnywhere(state, firstId);
      const second = findUnitAnywhere(state, secondId);
      // 359.3: a target that has left play makes the check return nothing rather
      // than making the spell fizzle loudly.
      if (!first || !second) return state;
      const delta = swappableMight(second.unit) - swappableMight(first.unit);
      if (delta === 0) return state; // equal Might: a swap nothing can observe
      // Applied to the first, then the second, reading `delta` once — the second
      // call must not re-derive from a board the first has already changed.
      return giveMightThisTurn(giveMightThisTurn(state, firstId, delta), secondId, -delta);
    },
  },
  "SFD-147": {
    // Downwell — "Return all units and gear to their owners' hands."
    //
    // No targeting at all, and that is 355.10.d rather than convenience: "Kill
    // all units at battlefields doesn't target anything" — an effect that names
    // every object of a kind chooses none of them, so there is nothing to pick
    // and nothing to validate.
    //
    // "ALL units" is BOTH bases as well as every battlefield (355.9.b's bare
    // noun, the same reading Whirlwind takes), so `allUnitsInPlay` — the walk
    // Whirlwind's own option list uses — is the right set and a battlefield-only
    // sweep would be wrong. At 8 Energy and 2 Power this is the pool's board
    // wipe, and leaving base units standing would make it a one-sided one.
    //
    // Ids are snapshotted before anything moves, for the reason
    // `dealDamageToAllUnitsAt` above snapshots its own: each return rewrites the
    // zones the walk reads.
    //
    // Units first, then gear, in printed order. It is observable: `killGear` is
    // NOT what happens to a gear here (it is returned, not killed), so no gear's
    // killed self-trigger fires, but a unit leaving play does strip its Buff
    // (709) and reset damage — both already inside `returnUnitToHand`.
    //
    // **Known gap, inherited rather than introduced**: `returnUnitToHand` puts a
    // TOKEN into its owner's hand instead of letting it cease to exist, and
    // nothing in this engine removes it there. Every bounce in the pool shares
    // it (Rebuke, Zaunite Bouncer, Whirlwind); this card just meets it more
    // often. Fixing it is a change to effect-helpers.ts.
    targeting: { kind: "none" },
    resolve: (state) => {
      const unitIds = allUnitsInPlay(state).map((u) => u.instanceId);
      const gearIds = ([0, 1] as const).flatMap((index) => state.players[index].activeGear.map((g) => g.instanceId));
      const bounced = unitIds.reduce((next, id) => returnUnitToHand(next, id), state);
      return gearIds.reduce((next, id) => returnPermanentToHand(next, id), bounced);
    },
  },
};

/**
 * The Might figure Switcheroo trades between two units: printed plus the
 * accumulated this-turn modifier, and deliberately not `effectiveMight`.
 *
 * Named rather than inlined because it IS the card's rules call — see SFD-145's
 * entry for why a delta that outlives its source is the worse error.
 */
function swappableMight(unit: UnitInstance): number {
  return unit.might + unit.mightThisTurn;
}

/**
 * Parks one question of `kind` for each player, starting with `first`.
 *
 * `parkDecision` pushes onto the BACK of a FIFO queue, so the order they are
 * parked in IS the order they are answered in — which is the entire
 * implementation of both "each player, in turn order" (rule 894, Acceptable
 * Losses) and Whirlwind's "starting with the next player". Written once rather
 * than twice because the two differ only in where the sequence starts, and a
 * second hand-rolled copy is how the two would drift.
 */
function askInTurnOrder(state: GameState, kind: string, first: 0 | 1): GameState {
  return [first, (1 - first) as 0 | 1].reduce((next, playerIndex) => parkDecision(next, { kind, playerIndex }), state);
}

/** Fizz - Trickster's ceiling — "a spell from your trash with Energy cost no
 *  more than [3]". Only the ENERGY is capped; his text names no Power limit,
 *  which is consistent with him making you pay the Power yourself. */
const FIZZ_MAX_ENERGY = 3;

/**
 * The spells in `playerIndex`'s trash Fizz - Trickster could play RIGHT NOW.
 *
 * ONE walk for the fire-time "is there anything to offer" test and for the
 * option list, so the two cannot disagree.
 *
 * **Payability is part of the filter, and that is the card's own words.** "(You
 * must still pay its Power cost.)" means a spell whose Power cannot be paid is
 * not a legal thing to play — so it is not offered, the rule this file applies
 * to every other paid offer. `payPowerFromChanneled` is asked speculatively and
 * its result thrown away, which is safe: its only side effect is a held trigger,
 * and that goes with the discarded state.
 */
function fizzCandidates(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter(
    (c) =>
      c.kind === "Spell" &&
      c.energyCost <= FIZZ_MAX_ENERGY &&
      (c.powerCost === 0 || payPowerFromChanneled(state, playerIndex, c.powerDomain, c.powerCost) !== undefined),
  );
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "SFD-149": {
    // Ezreal - Prodigy, FIRST clause — "When you play me, discard 1, then draw 2."
    //
    // His second ("Optional additional costs you pay cost [1] or [rainbow]
    // less") is a cost modifier and lives in cost-modifiers.ts, which also
    // carries his coverage claim. **Both halves landed in the same change on
    // purpose**: the claim went in first while this was still unwritten, and for
    // a few minutes he reported IMPLEMENTED while doing half his text — which is
    // precisely the over-report `PARTIALLY_IMPLEMENTED` exists to catch and the
    // reason coverage is asked per defId rather than per clause.
    //
    // "Discard 1, THEN draw 2" is ordered, and `discardThenDraw` keeps the order
    // by parking the draw behind the discard — a discard that hits the last card
    // in hand must not be refilled first.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 1, 2),
  },
  "SFD-140": {
    // Fizz - Trickster — "When you play me, you may play a spell from your trash
    // with Energy cost no more than [3], ignoring its Energy cost. Recycle that
    // spell after you play it. (You must still pay its Power cost.)"
    //
    // **Ignores the ENERGY only**, which is what separates him from Glasc
    // Mixologist's flat "ignoring its cost": the Power is paid for real, so the
    // offer is filtered by what can actually be afforded.
    //
    // A spell played this way resolves IMMEDIATELY rather than going on the
    // chain — `playCardIgnoringCost`'s own note, and the reason the recycle can
    // follow it in the same resolver.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      fizzCandidates(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-140-play", playerIndex: ctx.casterIndex }),
  },
  "OGN-197": {
    // Teemo - Scout — "[Hidden] When you play me, give me +3 Might this turn."
    //
    // The keyword is the card: hidden for 1 Power, played later for 0 as a
    // 2-Energy 3-Might body that arrives swinging for 3 more. Nothing here
    // touches [Hidden] — engine/hidden.ts owns it.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unitId, 3),
  },
  "OGN-199": {
    // Tideturner — "[Hidden] When you play me, you may choose a unit you control
    // at ANOTHER location. Move me to its location and it to my original
    // location."
    //
    // A SWAP, not two moves: both units end up where the other was, so it cannot
    // be expressed as forceMoveToBattlefield twice (the first move would vacate
    // the square the second reads). swapUnitLocations does it in one step.
    //
    // "ANOTHER location" — base counts as a location, so a Tideturner played to
    // base can pull a unit home from a battlefield and take its place there,
    // which is the card's whole trick. The target spec is therefore "anywhere",
    // and the resolver rejects a same-location choice.
    //
    // **"You MAY" — and it is genuinely optional now. FIXED 2026-08-07.**
    //
    // The history is worth keeping because it is one comment that has been wrong
    // in both directions: it first claimed the decline WAS offered ("enumeration
    // offers the no-target variant too"), which was false; the 2026-08-05
    // correction said it was forced, which was true and then stayed on the page
    // for two days after the mechanism to fix it was identified.
    //
    // `legal-actions.ts` pushed the empty variant only when
    // `effectVariants.length === 0`, so the decline appeared exactly when there
    // was nothing to decline: with any friendly unit at another location every
    // enumerated variant named one and the swap was forced. The resolver below
    // always handled an absent target, so the mechanism supported declining and
    // only the enumeration did not offer it.
    //
    // `optionalChoice` is that per-card marker, read by the enumerator AND by
    // `validate-play-card`'s `targetOmissionAllowed` — one flag, two readers, so
    // a decline cannot be offered and then refused. Deliberately NOT folded into
    // the `length === 0` rule, which says something different ("a trigger with
    // nothing to choose does nothing") and must keep applying to every on-play
    // trigger that is mandatory.
    //
    // **402.2** is the rule: "if the first part of a Triggered Ability's effect
    // is 'you may', its controller decides whether or not to perform the
    // Triggered Ability NOW" — at the Make Relevant Choices step, which is why
    // the decline is an enumerated variant rather than a branch in the resolver.
    //
    // **Tideturner is the ONLY card in the pool this reaches** — swept over
    // every Unit whose text says "you may <verb>" and whose on-play trigger
    // targets at announce time; every other optional on-play choice in the pool
    // is a parked decision, which can already be declined.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", optionalChoice: true },
    resolve: (state, ctx, unitId, event) =>
      event.targetUnitInstanceId ? swapUnitLocations(state, ctx.casterIndex, unitId, event.targetUnitInstanceId) : state,
  },
  "OGN-192": {
    // Mindsplitter — "When you play me, choose an opponent. They reveal their
    // hand. Choose a card from it, and they discard that card."
    //
    // "Choose an opponent" is not a decision in a 2-player game: there is one,
    // and offering it would be theatre. The real choice is WHICH card, and it
    // belongs to the CASTER even though the cards are the opponent's — which is
    // why the decision's playerIndex is the caster and its options come from the
    // other player's hand.
    //
    // A decision rather than an action fan-out for the same reason Stacked Deck
    // needs one: enumeration is built from public state, and putting the
    // opponent's hand into the action list would leak it to the AI before the
    // reveal ever happened.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-192-discard", playerIndex: ctx.casterIndex }),
  },
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
  "OGN-188": {
    // Zaunite Bouncer — "When you play me, return another unit at a battlefield
    // to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong — a unit at home is out of reach,
    // which is the limit on the card.
    //
    // No owner restriction ("another unit", not "an enemy unit"), so bouncing
    // your own is a legitimate line — it resets damage and rescues a unit about
    // to die, exactly as Rebuke's does.
    //
    // "ANOTHER" needs no check here, for the reason First Mate's entry in
    // engine/unit-triggers.ts already records: legal-actions enumerates the
    // candidates while this card is still in HAND, before it exists anywhere on
    // the board, so the Bouncer can never be offered as its own target and
    // validate-play-card would refuse an id that was not enumerated.
    //
    // The `?:` guard is load-bearing rather than defensive: with no unit at any
    // battlefield the Unit is still playable with its trigger's target omitted
    // (validate-play-card's targetOmissionAllowed), and the Bouncer simply
    // deploys and bounces nothing.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state,
  },
  "OGN-196": {
    // Soulgorger — "When you play me, you may play a unit from your trash,
    // ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // A DECISION rather than an `ownTrashCard` target, unlike Cemetery Attendant
    // above, and the two differences are both printed:
    //   - "You MAY". A fanned-out `ownTrashCard` spec offers the no-target
    //     variant only when the board offered no legal candidate, so with a
    //     stocked trash "you may" would silently become "you must" — the exact
    //     failure card-effects.ts's OPTIONAL_UNIT_COSTS comment records for
    //     Wildclaw Shaman.
    //   - The Power cost is paid AT RESOLUTION, out of the pool as it stands
    //     then. It is not part of the PlayCardAction's payment and cannot be:
    //     the action paid for the Soulgorger.
    // Flame Chompers (OGN-006, effects/fury.ts) is the precedent for both halves
    // — the same "offer it from the trash, pay Power, then playUnitToBase" shape.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-196-play", playerIndex: ctx.casterIndex }),
  },
  "SFD-132": {
    // Beast Below — "When you play me, return another friendly unit and an enemy
    // unit to their owners' hands."
    //
    // TWO DECISIONS rather than a `unitSlots` spec, and the difference is 422.
    // `unitSlots` with `min: 2` enumerates only complete pairs, so a board with a
    // spare friendly and no enemy (or the reverse) produces no variant at all,
    // `legal-actions` falls through to its "a Unit is playable with its trigger's
    // target omitted" branch, and the Beast returns NOTHING. The rules' golden
    // rule says do as much as you can and ignore the impossible instruction, so
    // the half that CAN happen must still happen. Asking the two halves
    // separately is the only shape that gets that right: a question with no
    // options is dropped by `advanceDecisions` while its sibling still runs.
    //
    // It is also the moment the rules name for a unit's on-play trigger. 355.10's
    // worked example is this card's shape exactly — "a unit with a triggered
    // ability that says 'When I'm played, kill a unit' does not require you to
    // choose a target as it's played; the target will be chosen when the ability
    // triggers" — so a resolution-time question is nearer the printed timing than
    // the announce-time fan-out, not a compromise away from it.
    //
    // "ANOTHER friendly" is enforced by carrying his own instanceId on the
    // question, NOT by the accident that enumeration happens while he is in hand
    // (Zaunite Bouncer's reason): by the time these resolve he is on the board and
    // would otherwise be on his own list.
    //
    // Both halves are MANDATORY — no "you may" — so neither offers a decline.
    // Friendly first, printed order; `parkDecision` is FIFO, so the order they are
    // raised in is the order they are asked in.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(parkDecision(state, { kind: "SFD-132-friendly", playerIndex: ctx.casterIndex, cardInstanceId: unitId }), {
        kind: "SFD-132-enemy",
        playerIndex: ctx.casterIndex,
      }),
  },
  "SFD-138": {
    // Windsinger — "[Hidden] When you play me, you may return another unit at a
    // battlefield with 3 Might or less to its owner's hand."
    //
    // A DECISION rather than `{ kind: "unit", maxMight: 3 }`, and the reason is
    // the printed "you MAY". A fanned-out spec offers the no-target variant ONLY
    // when the board offered no legal candidate at all — `legal-actions`' own
    // `card.kind === "Unit" && effectVariants.length === 0` branch — so with any
    // 3-Might unit standing anywhere "you may" would silently become "you must",
    // and a player whose only small unit is their OWN would be forced to bounce
    // it. That is the failure card-effects.ts's OPTIONAL_UNIT_COSTS comment
    // records for Wildclaw Shaman and Soulgorger takes the same way out of.
    //
    // (Tideturner's entry above claims enumeration offers a no-target variant for
    // an optional unit target. Measured against `legal-actions`, it does not —
    // that comment is wrong, and this card is not written on it.)
    //
    // "AT A BATTLEFIELD" is printed, so base units are out of reach; "3 Might or
    // less" is asked through `unitWithinMaxMight`, the same shared predicate the
    // enumerator and the validator use, so this card and a `maxMight` spec can
    // never disagree about what counts (it reads EFFECTIVE Might, which is 2236's
    // "current Might").
    //
    // "ANOTHER" rides on his own instanceId, for the reason Beast Below's entry
    // gives: this resolves with him already on the board.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(state, { kind: "SFD-138-return", playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {
  "SFD-148": {
    resolve: (state, ctx, death) => {
    // Draven - Audacious, SECOND clause — "When I die IN COMBAT, choose an
    // opponent. They score 1 point."
    //
    // A drawback, and it is the price his first clause is written against, so
    // shipping one without the other would have made him strictly stronger
    // than printed.
    //
    // `diedInCombat` is the whole test. A removal spell at a battlefield must
    // NOT pay out, which is exactly what a `battlefieldId !== undefined` check
    // would have done.
    //
    // "Choose an opponent" reduces to the one opponent in a 2-player game, so
    // no question is asked. Named rather than silently dropped: it is the line
    // that changes for multiplayer, not a simplification of a real choice.
    if (death.diedInCombat !== true) return state;
    // `ctx.opponentIndex` is the dying unit's controller's opponent, which is
    // who "an opponent" means — the effect context is built for the dead
    // Draven's side, not the killer's.
    const opponentIndex = ctx.opponentIndex;
    const players = [...state.players] as [PlayerState, PlayerState];
    // Through `gainPoints`, the single choke point every point-gain goes through
    // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints(state, opponentIndex, 1);
    },
  },
  // Undercover Agent — "[Deathknell] Discard 2, then draw 2." (rule 808)
  //
  // Order matters and the card spells it out with "then": the two discards leave
  // hand before the two draws arrive, so a card just drawn can never be one of
  // the cards discarded. Doing it in one step would let that happen.
  //
  // A Deathknell has no action to carry the choice on, so the discard stops and
  // asks — which is exactly why "then" needs `discardThenDraw` rather than
  // wrapping drawCards around it: the draw has to queue behind the questions, or
  // the cards it adds join the pool being discarded from.
  "OGN-178": { resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 2, 2) },

  // Kog'Maw - Caustic — "[Deathknell] Deal 4 to all units at my battlefield."
  //
  // The card triggers.ts's DeathContext doc comment names as the reason
  // `battlefieldId` is captured before the corpse reaches the trash (809.1.b.3):
  // by the time this runs, asking the board where Kog'Maw is would find him in a
  // trash and "my battlefield" would have no answer.
  //
  // He is NOT among the 4 damage's targets, and that falls out of `killUnit`'s
  // ordering rather than needing a filter: the unit is removed from the board and
  // trashed before triggers fire, precisely so "all units at my battlefield"
  // cannot include the corpse.
  //
  // "ALL units", so his own side takes it too — the card names no owner, and this
  // is a symmetric blast that is often worse for the player who cast him.
  // Undefined `battlefieldId` means he died in base, where there is no
  // battlefield and so nothing to hit.
  //
  // `ctx.casterIndex` is his controller, which is who is dealing this damage —
  // so Annie - Fiery's +1 applies to it and a damage-modifier read from the
  // victim's side would be wrong.
  "OGN-190": {
    resolve: (state, ctx, death) =>
      death.battlefieldId === undefined ? state : dealDamageToAllUnitsAt(state, ctx.casterIndex, death.battlefieldId, 4),
  },
};

/**
 * Deals `amount` to every unit at ONE battlefield, both owners' — the shape
 * "all units at my battlefield" needs, and the one variant effect-helpers does
 * not carry (it has enemy-units-at-one-battlefield and all-units-at-ALL-
 * battlefields, neither of which is this).
 *
 * The id list is snapshotted before any damage lands, for the same reason
 * `dealDamageToEnemyUnitsAtBattlefield` does it: a unit killed by an earlier
 * iteration must not shorten the loop, and `dealDamage` already no-ops on an id
 * that has since left play.
 */
function dealDamageToAllUnitsAt(state: GameState, casterIndex: 0 | 1, battlefieldId: string, amount: number): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const targetIds = Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId));
  return targetIds.reduce((next, id) => dealDamage(next, casterIndex, id, amount), state);
}

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

/** Spirit Wheel's optional draw. */
const SPIRIT_WHEEL_DRAW_COST = 1;

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "SFD-142": {
    // Jae Medarda — "When you choose me with a spell, draw 1."
    //
    // **"With a SPELL" is the whole reason `unitChosen` carries `bySpell`.** He
    // is the first card in the pool to narrow the moment to one of the two
    // choosing paths: Irelia - Fervent and Spirit Wheel both read a bare "when
    // you choose", and before him the event had no way to tell an ability's
    // choice from a spell's. Reading the wider sentence would have him draw off
    // Jax - Grandmaster At Arms pointing at him, which he does not say.
    //
    // "When YOU choose" is his own side, the same reading Irelia - Fervent's
    // entry takes — an opponent paying to choose him is a different sentence,
    // and one this card does not print.
    //
    // Not capped: one event per choice (see `holdUnitsChosen`), so a spell that
    // names him twice draws twice. The card says nothing about once per turn.
    on: "unitChosen",
    applies: (_state, listener, event) =>
      event.kind === "unitChosen" &&
      event.bySpell &&
      event.unitInstanceId === listener.card.instanceId &&
      event.chooserIndex === listener.ownerIndex,
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "SFD-144": {
    // Spirit Wheel — "When you choose a friendly unit, you may pay [1] and
    // exhaust this to draw 1."
    //
    // A GEAR watching a moment that happens to a UNIT, which the listener walk
    // already reaches: `allListeningPermanents` includes `activeGear`.
    //
    // Three conditions and all three are printed. **"YOU choose"** is its
    // controller doing the choosing. **"a FRIENDLY unit"** is friendly to that
    // same controller — so choosing an enemy unit with a removal spell is not
    // its moment, which is what makes it a build-around rather than a Cantrip on
    // every spell. **"exhaust this"** means a Wheel already exhausted cannot pay,
    // so it is once a turn by construction rather than by a counter.
    //
    // Both halves of the cost are checked at fire time, because an offer nobody
    // can take is not made — the rule this file applies throughout — and both
    // are re-derived at answer time in the decision below.
    //
    // Unlike Jae Medarda above it reads a bare "when you choose", so it takes
    // BOTH paths and does not consult `bySpell`.
    on: "unitChosen",
    applies: (state, listener, event) => {
      if (event.kind !== "unitChosen") return false;
      if (event.chooserIndex !== listener.ownerIndex) return false;
      const gear = state.players[listener.ownerIndex].activeGear.find((g) => g.instanceId === listener.card.instanceId);
      if (gear === undefined || gear.exhausted) return false;
      const chosen = findUnitAnywhere(state, event.unitInstanceId);
      if (chosen === undefined || chosen.ownerIndex !== listener.ownerIndex) return false;
      return payEnergyFromPool(state, listener.ownerIndex, SPIRIT_WHEEL_DRAW_COST) !== undefined;
    },
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: "SFD-144-draw",
        playerIndex: listener.ownerIndex,
        // The Wheel that fired is the one that must exhaust. Carried on the
        // decision rather than re-found at answer time, because a second Wheel
        // could be in play and paying with the wrong one is a different game.
        cardInstanceId: listener.card.instanceId,
      }),
  },
  "SFD-150": {
    // Last Rites — "When I conquer or hold, you may play a unit from your trash
    // (still paying costs)."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the compound `[Equip]` line and nothing else. Transcribed from the card
    // image; see docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER, so `wearerListener` as with the eight beside it. The
    // OR is what needs `on` to be a list: this is a two-moment ability on one
    // defId, the shape that widening `on` was added for.
    //
    // **The permission, and why it is not a play here.** 419.3.b makes this a
    // Limited Play Effect performed during resolution with every step of Play
    // normal — which includes paying. This engine cannot pay mid-resolution:
    // a play needs a RunePayment and `AnswerDecisionAction` carries only an
    // `optionId`. So the trigger opens a window that `legal-actions` offers and
    // `execute-play-card` spends, at the printed price. The divergence is that
    // the window outlives the trigger, and it is recorded in
    // docs/rules-conformance.md rather than left to be discovered.
    //
    // **"You MAY" needs nothing here.** The permission is an option the player
    // takes or ignores by acting; there is no question to park, and parking one
    // with a single option would auto-resolve anyway.
    //
    // Granted unconditionally on the moment rather than gated on the trash
    // holding a unit: the trash can gain one later in the same turn, and a
    // permission checked at grant time would wrongly have expired.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      if (wearer === undefined) return false;
      if (event.kind === "battlefieldConquered") {
        return event.conquerorIndex === wearer.ownerIndex && wearer.battlefieldId === event.battlefieldId;
      }
      return (
        event.kind === "battlefieldHeld" &&
        event.holderIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      if (wearer === undefined) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const owner = players[wearer.ownerIndex]!;
      players[wearer.ownerIndex] = { ...owner, trashUnitPlaysThisTurn: owner.trashUnitPlaysThisTurn + 1 };
      return { ...state, players };
    },
  },
  "SFD-124": {
    // Doran's Ring — "When I conquer, discard 1, then draw 1."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // `discardThenDraw`, NOT `drawCards(discardCards(...))`: the "then" is
    // load-bearing and the discard stops to ask, so the draw has to be queued
    // BEHIND the question or the card just drawn joins the hand being chosen
    // from. Scrapyard Champion's comment records the same trap.
    on: "battlefieldConquered",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldConquered" &&
        wearer !== undefined &&
        event.conquerorIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : discardThenDraw(state, wearer.ownerIndex, 1, 1);
    },
  },
  "SFD-134": {
    // Cull — "When I conquer, play a Gold gear token exhausted."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // Plundering Poro's sentence exactly, on a piece of gear instead of a body.
    on: "battlefieldConquered",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldConquered" &&
        wearer !== undefined &&
        event.conquerorIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : placeGoldTokens(state, wearer.ownerIndex, 1);
    },
  },
  "OGN-177": {
    // Stealthy Pursuer — "When a friendly unit moves FROM MY LOCATION, I may be
    // moved with it."
    //
    // Three conditions, and the first two are what make him a follower rather
    // than a second [Ganking] unit: the mover must be FRIENDLY, and it must have
    // left where he is standing. He does not follow an enemy, and he does not
    // teleport to a fight two battlefields away.
    //
    // **DIVERGENCE, and it is the unguessed rules call this card was blocked
    // on.** "Moved WITH it" reads as simultaneous, and this cannot be: the event
    // is a Chain Pending Item (383), so his move happens when the trigger
    // resolves — which `runCleanup` reaches AFTER `stageShowdowns`. He therefore
    // arrives at a battlefield whose Showdown is already staged, joining the
    // fight as an extra body rather than as part of the attack that opened it.
    // The alternative reading — that "with it" forbids being a held trigger at
    // all — would make him the only unit trigger in the pool resolved inline.
    // Recorded Unverified in docs/rules-conformance.md.
    //
    // He is deliberately NOT excluded from following a move he made himself:
    // nothing in this pool can move him and another friendly unit in one action
    // except a group MoveUnit, where the event fires per unit, and "a friendly
    // unit" includes his companions. `applies` does exclude the mover BEING him,
    // which is the one case that would let him chase his own move.
    on: "unitMoved",
    applies: (state, listener, event) => pursuerFollows(state, listener, event),
    resolve: (state, listener, event) => {
      if (!pursuerFollows(state, listener, event) || event.kind !== "unitMoved") return state;
      // "I MAY be moved" — a real choice, and one only its controller makes.
      return parkDecision(state, {
        kind: "OGN-177-follow",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.to,
      });
    },
  },
  "OGN-205": {
    // Yasuo - Windrider — "[Ganking] The third time I move in a turn, you score
    // 1 point."
    //
    // Reads `event.movesThisTurn`, the mover's count AFTER the move, rather than
    // looking the unit up again: `unitMoved` is a Chain Pending Item, so between
    // firing and resolving he can be moved again, bounced or killed, and "the
    // third time" is a fact about the move that happened.
    //
    // EXACTLY the third, not the third-or-later — a fourth and fifth move score
    // nothing, the same reading Darius - Trifarian's "your SECOND card" takes.
    //
    // **A plain `points + 1`, deliberately NOT routed through `recordConquest`.**
    // The Final Point restriction (rule 474) applies only to a point gained
    // "through a Conquer"; the rules are explicit that points from other sources
    // are not beholden to it. Sending this through the conquest path would make
    // the winning point silently withheld unless every battlefield had been
    // scored that turn.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.movesThisTurn === 3,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      // Through `gainPoints`, the single choke point every point-gain goes through
      // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints({ ...state, players }, listener.ownerIndex, 1);
      return { ...state, players };
    },
  },
  "OGN-167": {
    // Ember Monk — "When you play a card from [Hidden], give me +2 Might this
    // turn."
    //
    // Note what he does NOT do: he has [Hidden] himself, but this triggers on
    // playing ANY card from facedown, his own arrival included if he was hidden.
    // The event carries `fromHidden` rather than existing as its own kind, so
    // nothing else that watches plays goes blind to hidden ones.
    //
    // "YOU play" — his own controller's hidden card, not the opponent's.
    on: "cardPlayed",
    // Both conditions are properties of the event, so they cannot drift between
    // firing and resolving — but they gate whether this reaches the chain at all,
    // which is what `applies` is for now that `cardPlayed` is held.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (!event.fromHidden) return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      return giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 2);
    },
  },
  "OGN-202": {
    // Jinx - Rebel — "When you discard one or more cards, ready me and give me
    // +1 Might this turn."
    //
    // "ONE OR MORE" pays out once per discard instruction, not once per card,
    // which is exactly why `cardsDiscarded` carries a count rather than firing
    // per card — a "discard 2" readies her once.
    //
    // "YOU discard" is her own controller: Mindsplitter making the OPPONENT
    // discard must not ready their Jinx.
    on: "cardsDiscarded",
    // "YOU discard" reads only the event and the listener's owner, so it is a
    // fire-time condition and settles whether a Pending Item is placed at all.
    // Not re-asked below: 383 fixes triggering at the moment of the event.
    applies: (_state, listener, event) => event.kind === "cardsDiscarded" && event.discarderIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardsDiscarded") return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, 1);
    },
  },
  "SFD-121": {
    // Black Market Broker — "When you play a card from face down, play a Gold
    // gear token exhausted."
    //
    // "FROM FACE DOWN" is a play out of a Facedown Zone, which the rules
    // themselves gloss as the same thing as Hidden: "Playing a card from
    // facedown (or 'from Hidden') does open a chain" (811's discussion of the
    // keyword). So this is Ember Monk's (OGN-167, above) condition exactly, and
    // it is written against the same carried fact — `cardPlayed.fromHidden`,
    // which `executePlayCard` sets from `action.fromHiddenBattlefieldId`.
    //
    // That fact being on the EVENT is what makes this card implementable rather
    // than an approximation. Without it the only honest reading available would
    // be "when you play a card", which is strictly stronger than printed and
    // would pay out on every card the Broker's controller casts.
    //
    // "YOU play" — his own controller's facedown card, not the opponent's, the
    // same restriction Ember Monk carries. His own arrival counts if he was
    // himself played from facedown (Ember Monk's entry records the same), since
    // the event is fired after the card has resolved into play and the listener
    // walk therefore already finds him.
    //
    // Both conditions are properties of the event, so `applies` settles them at
    // fire time (383) and `resolve` cannot disagree with a board that has moved
    // on during the response window this hold opens.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex,
    resolve: (state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex
        ? placeGoldTokens(state, listener.ownerIndex, 1)
        : state,
  },
  "SFD-123": {
    // Corrupt Enforcer, FIRST clause only — "When I move to a battlefield,
    // discard 1."
    //
    // **WHOLE as of 2026-08-05.** The second clause — "When I win a combat,
    // draw 1" — needed a combat-WON event, which did not exist: `GameEvent`
    // carried only `combatBegan` and `battlefieldConquered`, and neither is
    // that. A conquest also fires on a walk-in, so paying out on one would
    // draw for a combat that never happened. `combatWon` now exists (466.5.a),
    // fired by combat.ts at both resolution shapes.
    //
    // It ALSO needed `EventTriggerDefinition.on` to accept a list: this
    // registry is keyed by defId, so before that a card could hold exactly one
    // event trigger and this clause had nowhere to live. Two blockers wearing
    // one symptom, and the wave report named only the first.
    //
    // Both clauses branch on `event.kind`, which is what makes one definition
    // able to serve two moments without the chain having to say which fired.
    //
    // The `unitMoved` EVENT rather than the per-card `ON_MOVE_TRIGGERS` table,
    // which lives in unit-triggers.ts and is not this file's to edit — Yasuo -
    // Windrider above is the precedent, and the event carries everything a "when
    // I move" card can ask.
    //
    // "TO A BATTLEFIELD" needs no destination check: a `MoveUnitAction` carries a
    // `destinationBattlefieldId`, so every Standard Move in this engine ends at
    // one. The event also never fires for a Recall (454, a Recall is not a Move)
    // or for a spell-driven relocation, which is the line the card wants.
    //
    // The discard goes through `discardCards`, so with more than one card in hand
    // it stops and ASKS rather than taking the front of hand, and it fires
    // `cardsDiscarded` once for the instruction — a Jinx - Rebel across the table
    // readies once, not never.
    on: ["unitMoved", "combatWon"],
    applies: (_state, listener, event) =>
      event.kind === "unitMoved"
        ? event.unitInstanceId === listener.card.instanceId
        : // "I win a combat" — my controller won, and I am standing where it
          // happened. A unit that died in the exchange is not a listener at all,
          // since the walk only finds permanents still in play, so surviving
          // needs no separate check.
          event.kind === "combatWon" &&
          event.winnerIndex === listener.ownerIndex &&
          listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved"
        ? discardCards(state, listener.ownerIndex, 1)
        : event.kind === "combatWon"
          ? drawCards(state, listener.ownerIndex, 1)
          : state,
  },
  "SFD-125": {
    // Fae Porter — "When I move to a battlefield, you may pay [Chaos] to move a
    // unit you control to the same battlefield."
    //
    // "The SAME battlefield" is `event.to`, captured on the question rather than
    // re-read from where the Porter is standing when it resolves: `unitMoved` is
    // held (383), and the window it opens is exactly when he could be bounced or
    // moved on. The destination the card means is the one he arrived at.
    //
    // "You may PAY" is a cost inside an instruction (355.10.d.1's "[do X] to [do
    // Y]"), so the Chaos rune is not a target and the moved unit is. Affordability
    // is asked in `applies` as well as at resolution, following Draven -
    // Vanquisher: 416.3 makes a cost that cannot be completed one you may not
    // choose to pay, and a held trigger that resolves to nothing still costs both
    // players a PassFocus.
    //
    // "A unit YOU CONTROL" carries no location (355.9.b's bare noun), so a unit
    // sitting in base is a legal choice — and it is the main one, since this is
    // how the Porter reinforces. Units already at the destination are excluded:
    // there is no move for them to make.
    //
    // `forceMoveToBattlefield`, so the arrival applies Contested and can promote a
    // Showdown. It fires no on-move trigger and does not exhaust, which that
    // helper's own note records as this engine's reading of an effect-driven move
    // (415.1.b puts the exhaust on the Standard Move ACTION, not on moving).
    on: "unitMoved",
    applies: (state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      payPowerFromChanneled(state, listener.ownerIndex, "Chaos", 1) !== undefined &&
      ownUnitsElsewhere(state, listener.ownerIndex, event.to).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      return parkDecision(state, {
        kind: "SFD-125-move",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.to,
      });
    },
  },
  "SFD-126": {
    // Loyal Pup — "When you defend at a battlefield, you may move me there."
    //
    // "YOU defend", not "I defend": the subject is the PLAYER, so this fires for a
    // Pup standing somewhere else entirely — which is the whole card. That also
    // means `isDefendingAt` is the wrong predicate (it requires the listener to be
    // one of the units designated in that combat), and `pupJoins` below is written
    // instead.
    //
    // 465 makes the Defender "the player who did not apply the Contested status",
    // which in a two-player game is simply the non-attacker. **This engine
    // additionally requires that player to have a unit at the battlefield**,
    // mirroring `cleanup.beginCombatAt`'s own guard on the battlefields' "when you
    // defend here" (Fortified Position, Reaver's Row) — the same printed wording,
    // so the two must agree. Recorded as this file's reading rather than derived:
    // 465 gives the PLAYER the designation regardless of presence.
    //
    // **Measured: that requirement is unreachable through the opening of a
    // combat.** `stageShowdowns` only reaches `beginCombatAt` when
    // `unitsOfBothPlayers` holds, so a one-sided contest stages a NON-Combat
    // Showdown and fires no `combatBegan` at all. The check therefore only bites
    // on `designateArrivals` — a reinforcement walking into a fight whose other
    // side has since been wiped — which is exactly where it should. Kept rather
    // than deleted for that path, and named here so nobody reads it as load-
    // bearing at the opening.
    //
    // Held (383), so the Pup arrives at a fight whose designations are already
    // handed out; 465 Step 1's second sentence covers him — he gains the Defender
    // designation at the Cleanup following his arrival, which is exactly what
    // `designateArrivals` does. He therefore reinforces the fight rather than
    // joining the opening of it, the same divergence Stealthy Pursuer records.
    on: "combatBegan",
    applies: (state, listener, event) => pupJoins(state, listener, event),
    resolve: (state, listener, event) => {
      if (!pupJoins(state, listener, event) || event.kind !== "combatBegan") return state;
      // "You MAY move me" — a real choice, and only his controller's.
      return parkDecision(state, {
        kind: "SFD-126-join",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-128": {
    // Overzealous Fan — "When I defend, you may kill me to move an attacking unit
    // to its base."
    //
    // "When I DEFEND" is the unit's own designation, so this one IS
    // `isDefendingAt` — 465's Attacker is `contestedByIndex` and everyone else
    // standing there is defending, and 383.4.f's "for the first time during a
    // combat" is already enforced by the event's `designated` list.
    //
    // The timing is what makes the card work: `combatBegan` items resolve on the
    // Combat Chain (465 Step 1 Task 4), which is BEFORE the Combat Damage Step —
    // so an attacker sent home is an attacker whose Might never joins the pool.
    //
    // "KILL ME TO move" is a cost (355.10.d.1), so it is paid first and the move
    // only happens if it was paid — and killing him is not targeting anything,
    // which is why only the attacking unit rides on the question. `destroyUnit`
    // with NO killerIndex, matching every other cost-kill in the pool (Cruel
    // Patron, Commander Ledros): nobody "killed" him in the sense a
    // `killerIndex`-reading card asks about.
    //
    // "MOVE an attacking unit to its base" is `recallUnitToBase`, the same helper
    // Fight or Flight's identically-worded "move a unit from a battlefield to its
    // base" uses — a Move, so the unit arrives exhausted, rather than 454's Recall
    // which would leave it ready.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isDefendingAt(state, listener, event) &&
      event.kind === "combatBegan" &&
      attackingUnitsAt(state, event.battlefieldId).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      return parkDecision(state, {
        kind: "SFD-128-sacrifice",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-130": {
    // Treasure Hunter — "When I move, play a Gold gear token exhausted."
    //
    // BARE "when I move" — no origin and no destination, which is exactly the
    // contrast Harpoon Squad's entry below already names ("what the printed
    // 'from a battlefield' buys over Treasure Hunter's bare 'when I move'"). So
    // walking out of base pays, and so does redeploying between battlefields;
    // neither `event.from` nor `event.to` is read at all.
    //
    // A Recall is still nothing (454 — a Recall is not a Move), and neither is a
    // spell-driven relocation, because `unitMoved` fires for neither. That is the
    // event's line rather than this card's, and it is the printed one.
    //
    // `placeGoldTokens(..., 1)` rather than `placeGearToken(..., GOLD_TOKEN,
    // true)`: same result, but the exhausted-ness is then stated in one place for
    // every SFD card that makes Gold, and a gear token that quietly entered ready
    // would be a free rainbow Power on the turn it was made.
    //
    // The token goes to `listener.ownerIndex`, the Hunter's controller — "play a
    // Gold gear token" with no player named is the ability's controller (355.9),
    // and `event.moverIndex` would say the same thing here only because the
    // condition below already requires the mover to BE him.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId
        ? placeGoldTokens(state, listener.ownerIndex, 1)
        : state,
  },
  "SFD-137": {
    // Harpoon Squad — "When I move FROM a battlefield, give me +2 Might this
    // turn."
    //
    // The one card in this file whose move trigger reads the ORIGIN, which is the
    // reason `unitMoved` carries `from` at all: by the time any move DISPATCHER
    // runs the unit has already been removed from where it was. `"base"` is what
    // the event carries for a unit leaving home, and it matches no battlefield —
    // so walking out of base pays nothing and only battlefield-to-battlefield
    // redeployment does, which is what the printed "from a battlefield" buys over
    // Treasure Hunter's bare "when I move".
    //
    // Read from the EVENT rather than re-derived, for Yasuo - Windrider's reason:
    // the trigger is held, and between firing and resolving he can be moved again.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.from !== "base",
    resolve: (state, listener, event) =>
      event.kind === "unitMoved" ? giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, HARPOON_PUMP) : state,
  },
  "SFD-148": {
    // Draven - Audacious, FIRST clause only — "The first time I win a combat
    // each turn, you score 1 point."
    //
    // His SECOND clause — "When I die in combat, choose an opponent. They score
    // 1 point" — lives in `deathTriggers` below, and needed the `diedInCombat`
    // flag on `DeathContext` that combat.ts's `processDefeated` now sets. That
    // flag exists because `battlefieldId !== undefined` is NOT the same question
    // (a spell kills units standing at battlefields too), and the Showdown state
    // is no substitute either — `execute-pass-focus` nulls
    // `showdownBattlefieldId` the instant `closeShowdown` returns, long before a
    // held death trigger resolves.
    //
    // His printed `[Deflect]` is the card frame's and needs nothing here.
    //
    // `combatWon` (466.5.a) rather than `battlefieldConquered`, for the reason
    // Corrupt Enforcer's entry above gives at length: a conquest also fires on a
    // walk-in that never fought, and a combat can be won at a battlefield its
    // winner already controlled, which conquers nothing.
    //
    // "**I** win a combat" is positional — my controller won and I am standing
    // where it happened — and it is settled at fire time (383). A unit that died
    // in the exchange is not a listener at all, since the walk only finds
    // permanents still in play, so surviving needs no separate check.
    //
    // **The `winnerIndex` half of that is REDUNDANT, and measured to be** —
    // deleting it leaves every test in test/sfd-chaos.test.ts green, because
    // 466.5.a defines the winner as "the only player that has units remaining",
    // so a listener alive at that battlefield is on the winning side by
    // construction. Kept because it is what the card says and because it is the
    // shape Corrupt Enforcer's identical clause above already uses; recorded here
    // so nobody reads the passing suite as evidence that it bites.
    //
    // "The FIRST TIME each turn" is deliberately NOT in `applies`. The allowance
    // is a RESOURCE, not a trigger condition: a second win still triggers and
    // resolves to nothing, which is the same reading (and the same wording) as
    // The Dreaming Tree's entry in battlefield-abilities.ts and Wraith of
    // Echoes' in triggers.ts.
    //
    // A plain `points + 1`, deliberately not routed through `recordConquest` —
    // rule 474's Final Point restriction covers only a point gained "through a
    // Conquer", and Yasuo - Windrider's entry above records the same call.
    on: "combatWon",
    applies: (_state, listener, event) =>
      event.kind === "combatWon" &&
      event.winnerIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "combatWon" ? scoreFirstCombatWin(state, listener.ownerIndex, listener.card.instanceId) : state,
  },
};

/**
 * Draven - Audacious's once-a-turn allowance, spent as it pays out.
 *
 * **The memory is written into `abilityModesUsedThisTurn`, a field named for
 * something else, and that is a choice with a rejected alternative rather than
 * an accident.** What "the first time I win a combat each turn" needs is a
 * PER-UNIT marker that expires with the turn: per-unit because two Dravens each
 * get their own point and a per-player flag would let one spend the other's, and
 * expiring because a new turn re-arms it. `abilityModesUsedThisTurn` is exactly
 * that and nothing else — turn-manager's `expireMightThisTurn` clears it for
 * every unit in base and at every battlefield, alongside `movesThisTurn` and
 * `keywordsThisTurn`, and `activated-abilities` is its only other reader, for
 * units that print an activated ability. Draven prints none, and the marker
 * below is prefixed with his defId so it could not collide with a mode id
 * anyway.
 *
 * The alternative — and what the pool's other two "first time each turn" cards
 * did — is a dedicated field: Wraith of Echoes has
 * `firstFriendlyDeathUsedThisTurn` on the PLAYER, The Dreaming Tree has
 * `spellChoiceDrawnBattlefieldIds`. Neither shape fits a per-unit allowance, and
 * adding a third field is a change to model/card.ts and turn-manager.ts, which
 * this file does not own. If a second per-unit once-a-turn card lands, that
 * field is the right answer and this is the entry to move onto it.
 */
const DRAVEN_WIN_SCORED = "SFD-148-win-scored";

/**
 * Scores the point unless this unit has already scored one this turn.
 *
 * The already-scored question is asked of the LIVE unit rather than of the
 * listener snapshot the chain carries: the snapshot was taken when the combat
 * was won, and a second win resolving off the same board must see the first
 * one's mark.
 */
function scoreFirstCombatWin(state: GameState, ownerIndex: 0 | 1, unitInstanceId: string): GameState {
  const live = findUnitAnywhere(state, unitInstanceId);
  if (live?.unit.abilityModesUsedThisTurn.includes(DRAVEN_WIN_SCORED)) return state;

  // Through `gainPoints`, the single choke point every point-gain goes through
  // so Tianna Crownguard's "opponents can't gain points" reaches it.
  //
  // The MARK is applied either way, below: "the first time I win a combat each
  // turn" is spent by winning, not by scoring, so a Tianna who blocks the point
  // does not also hand him a second attempt.
  const scored = gainPoints(state, ownerIndex, 1);

  // He can be GONE by the time this resolves — `resolvePendingTrigger` falls
  // back to the captured card rather than bailing (359.3, and its own note), so
  // the point is still his controller's. There is then nowhere to write the
  // memory and nothing that could spend it: a unit that has left play is not a
  // listener, so it cannot win a second combat this turn.
  return live ? rememberCombatWinScored(scored, unitInstanceId) : scored;
}

/** Writes the once-a-turn mark onto the live unit, wherever it stands. Both
 *  zones, because "I win a combat" only ever fires for a unit at a battlefield
 *  but a chain item can bounce it home before this resolves. */
function rememberCombatWinScored(state: GameState, unitInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === unitInstanceId
      ? { ...u, abilityModesUsedThisTurn: [...u.abilityModesUsedThisTurn, DRAVEN_WIN_SCORED] }
      : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(mark);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/** Harpoon Squad's redeployment bonus. */
const HARPOON_PUMP = 2;

/**
 * Loyal Pup's three conditions, asked once so `applies` and `resolve` cannot
 * disagree — the same shape (and the same reason) as `pursuerFollows` below.
 *
 * Deliberately NOT `isDefendingAt`: that predicate requires the listener to be
 * among the units designated in this combat, and the whole point of the Pup is
 * that he is somewhere else when the fight opens.
 */
function pupJoins(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "combatBegan") return false;
  const attackerIndex = attackerIndexAt(state, event.battlefieldId);
  if (attackerIndex === null || attackerIndex === listener.ownerIndex) return false; // "YOU defend"
  // Already standing in the fight: "move me THERE" has nothing to do.
  if (listener.battlefieldId === event.battlefieldId) return false;
  // The presence requirement — see the card's entry for why this engine adds it.
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  return (bf?.units[state.players[listener.ownerIndex].id]?.length ?? 0) > 0;
}

/**
 * The units `playerIndex` controls that are NOT already at `battlefieldId` —
 * Fae Porter's "a unit you control", which names no location (355.9.b) and so
 * reaches base as well as every other battlefield.
 *
 * Filtered rather than left to `forceMoveToBattlefield`'s own already-there
 * no-op, because this list is also the OPTIONS a player is shown: offering a
 * move that cannot happen and charging a Chaos rune for it is 416.3's
 * offered-then-refused shape.
 */
function ownUnitsElsewhere(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const here = new Set((bf?.units[state.players[playerIndex].id] ?? []).map((u) => u.instanceId));
  return ownUnitsEverywhere(state, playerIndex).filter((u) => !here.has(u.instanceId));
}

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "OGN-186": {
    // Treasure Trove — "When this leaves the board, draw 1 and channel 1 rune
    // exhausted."
    //
    // Keyed on being KILLED, which is the only way it leaves the board in this
    // pool — its own "[Chaos], Exhaust: Kill this" (activated-abilities.ts) and
    // `[Temporary]` expiry both route through killGear, which fires this. The
    // payout lives HERE rather than in that ability so it cannot be paid twice
    // if the Trove ever dies some other way.
    on: ["killed"],
    resolve: (state, event) => channelRunesExhausted(drawCards(state, event.ownerIndex, 1), event.ownerIndex, 1),
  },
  // Scrapheap — "When this is played, discarded, or killed, draw 1."
  //
  // The only card in the pool that watches its OWN three-way fate, and the
  // reason self-triggers are keyed by defId rather than found by walking the
  // board: on the discarded branch this Gear is in hand at the moment it fires
  // (and in the trash immediately after), so no listener walk over permanents in
  // play would ever reach it.
  //
  // Not "when this ENTERS play" — a discarded Scrapheap was never in play at
  // all, and the printed text still pays. All three branches read the same, and
  // the draw goes to the card's owner in every one of them.
  "OGN-182": {
    on: ["played", "discarded", "killed"],
    resolve: (state, event) => drawCards(state, event.ownerIndex, 1),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** Nocturne - Horrifying's alternative price — "play me for [rainbow]". */
const NOCTURNE_POWER = 1;

export const decisions: Record<string, DecisionDefinition> = {
  "SFD-140-play": {
    // Fizz - Trickster's "you may play a spell from your trash, ignoring its
    // Energy cost. Recycle that spell after you play it."
    prompt: () => "Fizz - Trickster: play a spell from your trash for its Power cost only?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...fizzCandidates(state, d.playerIndex).map((c) => ({
        id: c.instanceId,
        label: `Play ${c.name}`,
        instanceId: c.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Re-derived at ANSWER time against the same walk — and that re-derivation
      // covers the PAYMENT too, since payability is part of the filter: the
      // runes may have been spent while this waited on the chain.
      const chosen = fizzCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (chosen === undefined || chosen.kind !== "Spell") return state;
      // Power FIRST, so an unpayable cost hands over nothing — the rule every
      // paid effect in this file follows. Re-derived rather than trusted.
      const paid =
        chosen.powerCost === 0 ? state : payPowerFromChanneled(state, d.playerIndex, chosen.powerDomain, chosen.powerCost);
      if (paid === undefined) return state;
      // Out of the trash before it is played, or the card is in two zones at
      // once — the same ordering Glasc Mixologist's decision takes.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
      };
      const played = playCardIgnoringCost({ ...paid, players }, d.playerIndex, chosen);
      // "RECYCLE that spell after you play it" — bottom of the deck (416), not
      // the trash it came from, which is what stops him looping one spell every
      // turn. A resolved Spell has been put back in the trash by
      // `playSpellImmediately`, so it is taken from there by identity rather than
      // by the front-of-trash convention `recycleFromTrash` uses for a COUNT.
      const after = [...played.players] as [PlayerState, PlayerState];
      const owner = after[d.playerIndex];
      if (!owner.trash.some((c) => c.instanceId === chosen.instanceId)) return played;
      after[d.playerIndex] = {
        ...owner,
        trash: owner.trash.filter((c) => c.instanceId !== chosen.instanceId),
        deck: [...owner.deck, chosen],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one.
      return holdCardsRecycled({ ...played, players: after }, d.playerIndex, 1);
    },
  },
  "SFD-144-draw": {
    // Spirit Wheel's "you may pay [1] and exhaust this to draw 1."
    prompt: () => "Spirit Wheel: pay [1] and exhaust it to draw 1?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Both halves re-asked at ANSWER time, the convention every paid decision
      // here follows: the question waits on the chain, and in that time the
      // Energy can be spent elsewhere and the Wheel can be exhausted by
      // something else or leave play entirely.
      const gear = d.cardInstanceId
        ? state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId)
        : undefined;
      if (gear && !gear.exhausted && payEnergyFromPool(state, d.playerIndex, SPIRIT_WHEEL_DRAW_COST)) {
        options.push({ id: "pay", label: "Pay [1], exhaust Spirit Wheel, draw 1" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || d.cardInstanceId === undefined) return state;
      const paid = payEnergyFromPool(state, d.playerIndex, SPIRIT_WHEEL_DRAW_COST);
      // A payment that cannot be made draws nothing AND exhausts nothing — the
      // cost is one act, so neither half happens without the other.
      if (!paid) return state;
      return drawCards(exhaustGear(paid, d.playerIndex, d.cardInstanceId), d.playerIndex, 1);
    },
  },
  /** Stealthy Pursuer's "I may be moved with it" — see his trigger above for the
   *  timing divergence this question inherits. */
  "OGN-177-follow": {
    prompt: () => "Stealthy Pursuer: follow the unit that just left?",
    options: (state, d) => {
      // Moot if he has since died or already been moved away — a question about
      // a board that no longer exists is dropped rather than answered.
      const location = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!location || location.zone === "base") return [];
      if (state.battlefields[location.zone.battlefieldIndex]!.id === d.battlefieldId) return [];
      return [
        { id: "stay", label: "Stay" },
        { id: "follow", label: "Follow it" },
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "follow" && d.cardInstanceId && d.battlefieldId
        ? // Through the real move funnel, so arriving contests the battlefield
          // and stages a Showdown exactly as a walk-in would — and, since 445.2,
          // fires his own on-move triggers as well, because being moved by an
          // effect is still moving.
          //
          // **"I may be moved WITH IT"** — with the unit, not "to that
          // battlefield" — so when the friendly unit went home, so does he. The
          // dispatcher is what makes that one line instead of a branch that
          // would have quietly sent him to a battlefield named "base".
          forceMoveToDestination(
            state,
            d.cardInstanceId,
            d.battlefieldId === "base" ? { destinationIsBase: true } : { destinationBattlefieldId: d.battlefieldId },
          )
        : state,
  },
  // Stacked Deck's "put 1 into your hand and recycle the rest".
  //
  // The options are the top 3 read from LIVE state when the question reaches the
  // front of the queue, not captured when it was raised — a question queued
  // behind another must not offer a card the earlier answer has since drawn.
  /**
   * Nocturne - Horrifying's "as you look at or reveal me from the top of your
   * deck, you may banish me. If you do, you may play me for [rainbow]."
   *
   * Two nested "you may"s, offered as THREE options rather than two questions:
   * banishing without playing is a real (if rare) line — it thins the deck and
   * denies a mill — and asking the second question separately would need a way
   * to remember that the first was answered yes.
   *
   * `cardInstanceId` names the copy that was seen. Not "the top card": half the
   * effects that look at a top-5 recycle it before this can be answered, so by
   * the time the offer resolves he may be at the BOTTOM of the deck — see
   * engine/top-of-deck.ts.
   *
   * **Unverified:** when the looking effect goes on to ask its own question about
   * the same cards (Reinforce, Stacked Deck, Baited Hook, Promising Future),
   * banishing him here means that question re-slices a top-N that has moved up
   * by one, so it sees a card the player never looked at. The rules would keep
   * the looked-at set fixed. Recorded in docs/rules-conformance.md.
   */
  "OGN-194-banish": {
    prompt: () => "Nocturne - Horrifying: banish him from the top of your deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Moot if he has left the deck since the offer was raised — no options is
      // how a question that no longer applies is dropped.
      if (!state.players[d.playerIndex].deck.some((c) => c.instanceId === d.cardInstanceId)) return [];
      options.push({ id: "banish", label: "Banish him" });
      if (payPowerFromChanneled(state, d.playerIndex, RAINBOW, NOCTURNE_POWER) !== undefined) {
        options.push({ id: "play", label: "Banish him and play him for 1 rainbow Power" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.cardInstanceId) return state;
      const actor = state.players[d.playerIndex];
      const card = actor.deck.find((c) => c.instanceId === d.cardInstanceId);
      if (!card) return state;

      // Out of the deck either way — the banish is what both live options share,
      // and it is what the play is conditional on ("IF YOU DO, you may play me").
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        deck: actor.deck.filter((c) => c.instanceId !== card.instanceId),
        banished: [...actor.banished, card],
      };
      const banished: GameState = { ...state, players };
      if (optionId !== "play") return banished;

      // Pay first, and stop at the banish if the Power has gone since the offer.
      const paid = payPowerFromChanneled(banished, d.playerIndex, RAINBOW, NOCTURNE_POWER);
      if (paid === undefined) return banished;
      const after = [...paid.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = {
        ...after[d.playerIndex],
        banished: after[d.playerIndex].banished.filter((c) => c.instanceId !== card.instanceId),
        // "PLAY me" — a card you played, so [Legion] and the play-watchers see it.
        cardsPlayedThisTurn: after[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // "Play me FOR [rainbow]" — the rainbow Power is the whole price, so his
      // 4 Energy and his Chaos pip are both waived.
      return playCardIgnoringCost({ ...paid, players: after }, d.playerIndex, card);
    },
  },
  "OGN-183-keep": {
    prompt: () => "Stacked Deck: put one into your hand, recycle the rest",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 3).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => takeOneFromTopAndRecycleRest(state, d.playerIndex, 3, optionId),
  },
  // Hard Bargain's "unless its controller pays [2]" — answered by the SPELL'S
  // controller, whose seat is `d.playerIndex`.
  //
  // Every branch re-asks whether the spell is still on the chain, because a
  // repeated Hard Bargain queues two of these against the same target and the
  // first may already have countered it. 359.3: a check on something no longer
  // available returns null and the instruction is ignored.
  "SFD-136-ransom": {
    prompt: (state, d) => {
      const spell = spellsOnChain(state).find((s) => s.entry.card.instanceId === d.cardInstanceId);
      return spell ? `Hard Bargain: pay [2] or ${spell.entry.card.name} is countered` : "Hard Bargain: nothing left to counter";
    },
    options: (state, d) => {
      const spell = spellsOnChain(state).find((s) => s.entry.card.instanceId === d.cardInstanceId);
      // Already countered by the first execution's ransom. ONE option, which
      // `advanceDecisions` auto-resolves, so nobody is prompted for a question
      // that no longer has a subject.
      if (!spell) return [{ id: "gone", label: "Nothing to counter" }];
      // Declining first, so a mis-click and the AI's tie-break both land on the
      // option that costs nothing — the convention Flame Chompers records. Here
      // that means being countered, which is the card working as printed.
      const options: DecisionOption[] = [{ id: "decline", label: `Let ${spell.entry.card.name} be countered` }];
      // Offered only when the 2 Energy is really payable — floating first, then
      // Ready runes, which is what `payEnergyFromPool` does. A controller who
      // cannot pay is simply countered.
      if (payEnergyFromPool(state, d.playerIndex, HARD_BARGAIN_RANSOM)) {
        options.push({ id: "pay", label: `Pay [${HARD_BARGAIN_RANSOM}] to save it` });
      }
      return options;
    },
    // The "is it still there?" guard lives in `options` above, NOT here. A
    // duplicate scan in this function was written first and then deleted for
    // failing its own mutation test: removing it changed no observable
    // behaviour, because `options` never offers "pay" for a spell that is gone
    // and `counterSpell` on a missing id is a no-op. Deleting the `options`
    // guard, by contrast, throws. One of the two was load-bearing and it is that
    // one — so this branches on the option and trusts the offer, which is the
    // same contract every other decision here works under.
    resolve: (state, d, optionId) => {
      if (!d.cardInstanceId || optionId === "gone") return state;
      if (optionId === "pay") {
        // Re-derived rather than trusted: the Energy may have gone between the
        // offer and the answer, and a payment that cannot be made does not save
        // the spell.
        const paid = payEnergyFromPool(state, d.playerIndex, HARD_BARGAIN_RANSOM);
        return paid ?? counterSpell(state, d.cardInstanceId);
      }
      return counterSpell(state, d.cardInstanceId);
    },
  },
  "SFD-122-keep": {
    // Called Shot's half of Stacked Deck's question, at 2 rather than 3.
    //
    // `options` reads LIVE state rather than a snapshot, which is what makes a
    // repeated Called Shot correct: the second execution's question is asked of
    // the deck the first one left behind.
    prompt: () => "Called Shot: draw one, recycle the other",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 2).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => takeOneFromTopAndRecycleRest(state, d.playerIndex, 2, optionId),
  },

  // Mindsplitter's "choose a card from it, and they discard that card".
  //
  // The chooser is the caster (`d.playerIndex`); the cards are the opponent's,
  // and so is the discard. Routed through discardCards so the discarded card
  // still fires its own on-discard trigger (Flame Chompers, Scrapheap) and still
  // sets `discardedThisTurn` for Raging Soul and Jinx - Rebel — a hand-rolled
  // move would silently skip all three.
  "OGN-192-discard": {
    prompt: () => "Mindsplitter: choose a card for your opponent to discard",
    options: (state, d) => {
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return opponent.hand.map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId }));
    },
    resolve: (state, d, optionId) => {
      const opponentIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      return discardCards(state, opponentIndex, 1, [optionId]);
    },
  },

  // Acceptable Losses' half of the work: one player picking which of their OWN
  // gear dies. Asked of both players, so it is written from the answering
  // player's point of view rather than the caster's — the same shape as
  // Cull the Weak's "OGN-209-kill".
  //
  // No decline option: the text carries no "you may", so a player with gear must
  // kill one. A player with NO gear produces no options at all and
  // advanceDecisions drops the question as moot (422's "do as much as you can");
  // a player with exactly one is not being offered a choice, and it dies without
  // a prompt.
  "OGN-179-kill": {
    prompt: () => "Acceptable Losses: kill one of your gear",
    options: (state, d) =>
      state.players[d.playerIndex].activeGear.map((g) => ({ id: g.instanceId, label: g.name, instanceId: g.instanceId })),
    // killGear, not a hand-rolled removal: it is the funnel that trashes a gear
    // and fires its own killed self-trigger, so a Treasure Trove taken by this
    // still pays out and a Scrapheap still draws.
    resolve: (state, d, optionId) => {
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      return gear ? killGear(state, gear, d.playerIndex) : state;
    },
  },

  // Whirlwind's half: one player choosing a unit — ANY unit, either owner's,
  // base or battlefield (355.9.b's bare noun) — to send to its owner's hand.
  //
  // The decline leads, and is what makes "MAY" mean may: with no unit in play at
  // all it is the only option, so the question is executed rather than asked and
  // nobody is interrupted to be told there is nothing to do. Leading also means a
  // mis-click and the AI's tie-break both land on doing nothing, the same
  // convention Flame Chompers' offer uses.
  //
  // `returnUnitToHand` sends it to its OWNER's hand rather than the answering
  // player's, and strips Buffs on the way (709) — both already handled there.
  "OGN-187-return": {
    prompt: () => "Whirlwind: you may return a unit to its owner's hand",
    options: (state): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...allUnitsInPlay(state).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },

  // Soulgorger's "you may play a unit from your trash, ignoring its Energy cost."
  //
  // The decline comes FIRST so that a mis-click and the AI's tie-break both land
  // on doing nothing, the same convention Whirlwind's offer above uses — and it
  // is the whole difference between this entry and The Harrowing's below, which
  // prints the same instruction without "you may".
  "OGN-196-play": {
    prompt: () => "Soulgorger: you may play a unit from your trash, paying only its Power cost",
    options: (state, d) => [{ id: "decline", label: "Decline" }, ...playableTrashUnits(state, d.playerIndex)],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : playUnitFromTrash(state, d.playerIndex, optionId)),
  },

  // The Harrowing's "Play a unit from your trash, ignoring its Energy cost."
  //
  // No decline: the instruction is mandatory, so the only options are the units
  // that can actually be played. With none the list is EMPTY and
  // `advanceDecisions` drops the question (422 — do as much as you can, then
  // nothing); with exactly one it executes it without asking, because one option
  // is not a choice. Both branches are asserted in test/cards-harrowing.test.ts,
  // since a mandatory question with no answer is the one shape that could hang
  // the game rather than fizzle.
  "OGN-198-play": {
    prompt: () => "The Harrowing: play a unit from your trash, paying only its Power cost",
    options: (state, d) => playableTrashUnits(state, d.playerIndex),
    resolve: (state, d, optionId) => playUnitFromTrash(state, d.playerIndex, optionId),
  },

  // Fae Porter's "you may pay [Chaos] to move a unit you control to the same
  // battlefield." One question over both halves, not two: the payment is a cost
  // WITHIN the instruction (355.10.d.1), so declining to move and declining to
  // pay are the same answer and asking them separately would need a way to
  // remember that the first was said yes to.
  //
  // Priced when the OPTIONS are built and again when one is taken, the same split
  // `playableTrashUnits` makes: the question can sit behind others, and the Chaos
  // rune it was offered against may have been spent in between.
  "SFD-125-move": {
    prompt: () => "Fae Porter: pay 1 Chaos Power to move a unit you control to his battlefield?",
    options: (state, d) => {
      const decline: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!d.battlefieldId) return [];
      if (payPowerFromChanneled(state, d.playerIndex, "Chaos", 1) === undefined) return decline;
      return [
        ...decline,
        ...ownUnitsElsewhere(state, d.playerIndex, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Pay 1 Chaos Power: move ${u.name} here`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.battlefieldId) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Chaos", 1);
      if (paid === undefined) return state;
      return forceMoveToBattlefield(paid, optionId, d.battlefieldId);
    },
  },

  // Loyal Pup's "you may move me there". The decline leads, so a mis-click and
  // the AI's tie-break both land on doing nothing — the convention Whirlwind's
  // and Soulgorger's offers already use.
  "SFD-126-join": {
    prompt: () => "Loyal Pup: move him to the battlefield you are defending?",
    options: (state, d) => {
      // Moot if he has since died, or has already been moved into the fight — a
      // question about a board that no longer exists is dropped, not answered.
      const location = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!location || !d.battlefieldId) return [];
      if (location.zone !== "base" && state.battlefields[location.zone.battlefieldIndex]!.id === d.battlefieldId) return [];
      return [
        { id: "stay", label: "Stay" },
        { id: "join", label: "Move him to the fight" },
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "join" && d.cardInstanceId && d.battlefieldId
        ? forceMoveToBattlefield(state, d.cardInstanceId, d.battlefieldId)
        : state,
  },

  // Overzealous Fan's "you may kill me to move an attacking unit to its base."
  //
  // The attackers are re-read from LIVE state when the question reaches the front
  // of the queue rather than captured when it was raised, so a unit that has
  // since left the fight is not offered — and the battlefield is captured,
  // because by then the Fan may no longer be standing at it.
  "SFD-128-sacrifice": {
    prompt: () => "Overzealous Fan: kill him to send an attacking unit home?",
    options: (state, d) => {
      // The COST first: with the Fan already gone there is nothing to pay with,
      // so the question is moot rather than declinable.
      if (!d.cardInstanceId || !findUnitAnywhere(state, d.cardInstanceId) || !d.battlefieldId) return [];
      return [
        { id: "decline", label: "Decline" },
        ...attackingUnitsAt(state, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Kill him: send ${u.name} to its base`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.cardInstanceId) return state;
      if (!findUnitAnywhere(state, d.cardInstanceId)) return state; // the cost can no longer be paid
      // Cost, then effect. `destroyUnit` runs the full death funnel, so his own
      // death still reaches a death-watch and a Deathknell on the board.
      return recallUnitToBase(destroyUnit(state, d.cardInstanceId), optionId);
    },
  },

  // Beast Below's two halves. Both MANDATORY — the card carries no "you may" —
  // so neither offers a decline: with candidates the player must pick one, with
  // exactly one candidate it happens without a prompt, and with none the option
  // list is EMPTY and `advanceDecisions` drops that half while the other still
  // runs. That last case is the whole reason these are decisions; see the card's
  // entry.
  "SFD-132-friendly": {
    prompt: () => "Beast Below: return another friendly unit to its owner's hand",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex)
        .filter((u) => u.instanceId !== d.cardInstanceId) // "ANOTHER"
        .map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => returnUnitToHand(state, optionId),
  },
  "SFD-132-enemy": {
    prompt: () => "Beast Below: return an enemy unit to its owner's hand",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => returnUnitToHand(state, optionId),
  },

  // Windsinger's "you may return another unit at a battlefield with 3 Might or
  // less to its owner's hand." The decline leads, and is what makes "may" mean
  // may — with nothing small enough on the board it is the only option, so the
  // question is executed rather than shown and nobody is interrupted to be told
  // there is nothing to do.
  //
  // No owner restriction: "another unit", not "an enemy unit". Bouncing your own
  // resets its damage and rescues it from a fight, exactly as Rebuke's does.
  "SFD-138-return": {
    prompt: () => "Windsinger: you may return a unit at a battlefield with 3 Might or less to its owner's hand",
    options: (state, d): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...unitsAtBattlefields(state)
        .filter(({ unit }) => unit.instanceId !== d.cardInstanceId) // "ANOTHER"
        // The shared predicate the enumerator and the validator use for a
        // `maxMight` spec, so "3 Might or less" cannot come to mean two things.
        .filter(({ unit }) => unitWithinMaxMight(state, unit, WINDSINGER_MAX_MIGHT))
        .map(({ unit }) => ({ id: unit.instanceId, label: unit.name, instanceId: unit.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },
};

/** Windsinger's cap — "a unit at a battlefield with 3 [Might] or less". */
const WINDSINGER_MAX_MIGHT = 3;

/**
 * Every unit standing at a battlefield, either owner's, with the owner index the
 * caller needs to price it.
 *
 * Battlefield order then player order, so an option list built from it is stable
 * and a test about WHICH unit was offered means something — the same reason
 * `allUnitsInPlay` fixes its own walk.
 */
function unitsAtBattlefields(state: GameState): { unit: UnitInstance; ownerIndex: 0 | 1 }[] {
  const out: { unit: UnitInstance; ownerIndex: 0 | 1 }[] = [];
  for (const bf of state.battlefields) {
    for (const ownerIndex of [0, 1] as const) {
      for (const unit of bf.units[state.players[ownerIndex].id] ?? []) out.push({ unit, ownerIndex });
    }
  }
  return out;
}

/**
 * The units in a player's trash they could play right now for their Power cost
 * alone — Soulgorger's offer and The Harrowing's, which print the same
 * instruction and differ only in whether declining is allowed.
 *
 * Priced when the OPTIONS are built, so a unit whose Power cost cannot be paid
 * is never offered rather than offered and then refused — 416.3's "the action
 * must be able to be completed for the cost to be paid", and the same shape
 * Flame Chompers' offer uses.
 *
 * **Named limitation, inherited by both cards:** affordability is asked through
 * `payPowerFromChanneled`, which takes a single domain and reads only the
 * channeled pool. So a card with a split Power pip (`powerDomainAlt`, e.g.
 * Tibbers) is judged against its primary domain only, and floating Power does
 * not count. Both UNDER-offer — the option is withheld, never granted free — and
 * both come from that helper rather than being introduced here. Widening it is a
 * change to effect-helpers.ts, not to this file.
 */
function playableTrashUnits(state: GameState, playerIndex: 0 | 1): DecisionOption[] {
  const options: DecisionOption[] = [];
  for (const card of state.players[playerIndex].trash) {
    if (card.kind !== "Unit") continue;
    if (payUnitPowerCost(state, playerIndex, card) === undefined) continue;
    options.push({ id: card.instanceId, label: playLabel(card), instanceId: card.instanceId });
  }
  return options;
}

/**
 * Takes the named unit out of the trash, pays its Power, and plays it to base.
 *
 * Out of the trash, then into play through the shared deploy funnel — so it
 * enters exhausted (143.4.a) unless something says otherwise, and both events a
 * real play fires go off. "Play a unit" means play it.
 *
 * The printed Energy is not paid and not discounted: the card's text replaces
 * that half of the cost outright, exactly as rule 811 does for a card played
 * from Hidden. `cardsPlayedThisTurn` is bumped because this IS a card being
 * played, which is what [Legion] counts.
 *
 * The cost is re-paid here rather than trusted from the option list, because the
 * options were built from an earlier state — anything that drained the pool
 * between the question and the answer makes this fizzle rather than play a unit
 * for free.
 */
function playUnitFromTrash(state: GameState, playerIndex: 0 | 1, optionId: string): GameState {
  const card = state.players[playerIndex].trash.find((c) => c.instanceId === optionId);
  if (!card || card.kind !== "Unit") return state;
  const paid = payUnitPowerCost(state, playerIndex, card);
  if (!paid) return state;

  const players = [...paid.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    trash: players[playerIndex].trash.filter((c) => c.instanceId !== optionId),
    cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1,
  };
  return playUnitFree({ ...paid, players }, playerIndex, card);
}

/** Every unit in play, both players, base and battlefields — Whirlwind's "a
 *  unit" with no owner and no location named. Player order, then each player's
 *  own base-before-battlefields walk, so the option list is stable and the tests
 *  about WHICH unit was chosen mean something. */
function allUnitsInPlay(state: GameState): UnitInstance[] {
  return ([0, 1] as const).flatMap((playerIndex) => ownUnitsEverywhere(state, playerIndex));
}

/**
 * Pays a trashed unit's Power cost, or `undefined` when it cannot be paid — the
 * same contract `payPowerFromChanneled` and `spendBuff` use, so an unpayable cost
 * withholds the payoff instead of handing it over free.
 *
 * A zero Power cost is payable and costs nothing; it is short-circuited rather
 * than passed through as `count: 0` because `powerDomain` is null exactly when
 * the cost is 0, and null means RAINBOW to that helper — asking it to take zero
 * rainbow runes works, but only by accident of the arithmetic.
 */
function payUnitPowerCost(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState | undefined {
  if (card.powerCost <= 0) return state;
  return payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost);
}

function playLabel(card: UnitInstance): string {
  return card.powerCost <= 0
    ? `Play ${card.name} (free)`
    : `Play ${card.name} (pay ${card.powerCost} ${card.powerDomain ?? "any"} Power)`;
}

/** Stealthy Pursuer's three conditions, asked once so `applies` and `resolve`
 *  cannot disagree — a held trigger that re-derives them separately is how a
 *  response window turns into a trigger firing on a board that no longer
 *  qualifies. */
function pursuerFollows(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "unitMoved") return false;
  if (event.moverIndex !== listener.ownerIndex) return false; // "a FRIENDLY unit"
  if (event.unitInstanceId === listener.card.instanceId) return false; // not his own move
  // "FROM MY LOCATION" — where he is standing NOW, which is where he was when
  // the mover left, since nothing resolves in between.
  return listener.battlefieldId === event.from && event.to !== event.from;
}
