import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { PlayerAction } from "../actions/player-action.js";
import { legalActions } from "../engine/legal-actions.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";
import { executeRecallUnit } from "../actions/execute-recall-unit.js";
import { executePassFocus } from "../actions/execute-pass-focus.js";
import { executeActivateAbility } from "../actions/execute-activate-ability.js";
import { executeAnswerDecision } from "../actions/execute-answer-decision.js";
import {
  abilitiesAvailableTo,
  abilityBanksResource,
  availableModes,
  canPayActivationCost,
  findActivatable,
} from "../engine/activated-abilities.js";
import { eligibleTargets } from "../engine/target-lookup.js";
import { contextFor } from "../engine/effect-context.js";
import { maskHiddenCards } from "../engine/hidden.js";
import { effectiveMight } from "../engine/effective-might.js";
import { runCleanup } from "../engine/cleanup.js";
import { actingPlayerIndex } from "../engine/timing.js";

/**
 * A simple heuristic AI opponent — enough to be a real (if not yet strong)
 * opponent for playtesting, per PRD Goal 2/FR9. Deliberately NOT a port of
 * HeuristicAI.java (1955 lines of largely per-card scoring functions,
 * engine/HeuristicAI.java) — that scale of card-specific tuning only makes
 * sense once this engine has a comparable number of cards' effects
 * implemented. Instead this takes advantage of a real architectural win
 * from the engine being a pure `(state, action) -> nextState` reducer (PRD
 * Goal 4): rather than hand-rolling heuristics that approximate combat
 * math, every legal candidate action is actually APPLIED via the real
 * validator/executor pipeline to get a genuine resulting state, which is
 * then scored directly — a correct 1-ply lookahead by construction, not an
 * approximation. One of the AI's own actions deep, but each candidate's
 * DEFERRED resolution is driven to completion before scoring (see
 * settleDeferredResolution): in this engine both combat and Spells pay off
 * behind PassFocus rather than at the moment the action is taken, so scoring
 * the immediate state left the AI structurally unable to do either.
 * Java's own lookahead mode (HeuristicAI.java:55, `lookaheadEnabled`)
 * does something similar but bolted on top of static heuristics, since its
 * engine doesn't produce cheap immutable snapshots the way this one does.
 *
 * Extend this by widening `evaluate`'s board-state weighting or by adding a
 * real N-ply search once move ordering / branching factor matters — not by
 * porting HeuristicAI.java's per-card special cases wholesale.
 */

/**
 * Applies one candidate action the way the real game would.
 *
 * The `runCleanup` wrapper is load-bearing, not tidiness: `submit` runs a Cleanup
 * after every action (rule 323), and the Cleanup is what STAGES a Showdown at a
 * Contested battlefield (344.1) and what lapses control of an emptied one (323.6).
 * Calling the executors bare would let the lookahead score a state the real game
 * never passes through — in particular a Move onto an empty battlefield would
 * look like "my unit is somewhere else, no points", because the Non-Combat
 * Showdown that eventually scores it would never have opened.
 */
function applyAction(state: GameState, action: PlayerAction): GameState {
  const applied = applyBare(state, action);
  // Same suppression `submit` applies, and for the same rule (321): if the
  // action stopped to ask a question, the resolution is not finished and a
  // Cleanup must not run inside it. Skipping it here keeps the lookahead scoring
  // states the real game actually passes through.
  return applied.pendingDecisions.length > 0 ? applied : runCleanup(applied);
}

function applyBare(state: GameState, action: PlayerAction): GameState {
  switch (action.type) {
    case "Pass":
      return state;
    case "PlayCard":
      return executePlayCard(state, action);
    case "MoveUnit":
      return executeMoveUnit(state, action);
    case "RecallUnit":
      return executeRecallUnit(state, action);
    case "PassFocus":
      return executePassFocus(state, action);
    case "HideCard":
      // Never reached — chooseAction filters it out below, same reasoning as
      // FloatRune: hiding spends Power and a card now to buy a free play on a
      // LATER turn, and a 1-ply board evaluator cannot see that far. Scoring it
      // would only ever produce a meaningless tie with Pass.
      return state;
    case "FloatRune":
      // Never reached — chooseAction filters FloatRune (and
      // ActivateAbility, same reasoning) out of its own candidate pool
      // below. A safe no-op fallback so this switch stays exhaustive over
      // PlayerAction.
      return state;
    case "ActivateAbility":
      // Reachable now. It used to be filtered out wholesale on the same
      // "no evaluative basis" grounds as FloatRune, which held while the only
      // activated ability in the pool banked Energy. Gear abilities move Might,
      // and `evaluate` scores Might — so the ones it can price are played, and
      // only the resource-bankers are still skipped (see chooseAction).
      return executeActivateAbility(state, action);
    case "AnswerDecision":
      return executeAnswerDecision(state, action);
  }
}

/**
 * The actions worth scoring, for whoever is acting.
 *
 * Shared by the AI's own choice and by the opponent model, so the two cannot
 * disagree about what the opponent might do — an opponent model that considers
 * moves the AI itself would never make is not modelling the opponent, it is
 * modelling a different player.
 *
 * FloatRune and HideCard are out, and so are the ActivateAbility candidates that
 * only BANK a resource: `evaluate` scores board state, which cannot value
 * something stored for a future play this lookahead never sees, so scoring them
 * only ever produces a meaningless tie with Pass.
 */
function candidateActions(state: GameState): PlayerAction[] {
  return legalActions(state).filter(
    (a) =>
      a.type !== "FloatRune" &&
      a.type !== "HideCard" &&
      !(a.type === "ActivateAbility" && abilityBanksResource(findActivatable(state, a.playerIndex, a.permanentInstanceId)?.card.defId ?? "")),
  );
}

/**
 * How many iterations `settleDeferredResolution` will drive before giving up.
 *
 * This used to be 16, justified as "two per pending item... far more than anything
 * reachable". That miscounted what the loop spends: EVERY iteration costs one, not
 * two per chain item — decision answers and opponent replies burn an iteration each
 * alongside the passes. A single PlayCard that buffs (Cithria → `unitBuffed` →
 * Mistfall → a parked question) already costs ~12, and a combat-closing PassFocus
 * with two deaths and a conquest costs ~24. So the old bound was already reachable
 * before triggers start taking chain slots of their own.
 *
 * Raised, and — more importantly — exhaustion is now LOUD. It used to fall out of
 * the loop and hand a half-resolved board straight to `evaluate`, which scores
 * points/might/hand/gear and cannot tell that a chain is still closed. That is a
 * silent wrong answer, the failure mode this project keeps paying for.
 * `decisions.ts`'s MAX_ADVANCE_STEPS is the precedent: it throws.
 */
const MAX_SETTLE_PASSES = 1024;

/**
 * Iterations the settle loop may run WITHOUT the remaining work going down,
 * before it calls the resolution stuck.
 *
 * **This is the real bound; `MAX_SETTLE_PASSES` above is now only a backstop.**
 * A constant total was the wrong shape and it took a live failure to see why: it
 * conflates "this resolution is LONG" with "this resolution is STUCK", and those
 * want opposite responses. The old 64 was measured against "a combat-closing
 * PassFocus with two deaths and a conquest costs ~24" — an honest measurement of
 * every case that existed, and blind to the one that arrived later.
 *
 * What arrived: `killTemporaryPermanents` kills every Temporary permanent at
 * once, and a board holding death-watch listeners turns one mass death into one
 * triggered ability PER DEATH PER LISTENER. Measured from the trace this bound
 * now prints — **a chain of 40**, all of it UNL-068 Spectral Centaur and UNL-129
 * Vicious Snapjaws. That is rule 383 working, not a defect. A chain item needs
 * BOTH players to pass before it resolves, so 40 items cost ~80 iterations and
 * the loop died at 64 having done nothing wrong.
 *
 * Progress is measured as `chain + pendingDecisions + (staged Showdown ? 1 : 0)`
 * strictly DECREASING. 16 gives generous slack over the two-passes-per-item
 * floor while still catching a genuine non-terminating resolution in well under
 * a second — and, unlike a bigger constant, it does not have to be re-guessed
 * the next time a card makes a legitimately deeper chain.
 */
const MAX_SETTLE_PASSES_WITHOUT_PROGRESS = 16;

/** How much deferred work is outstanding. The quantity the loop must drive to
 *  zero, and the one a stall is defined against. */
function outstandingWork(state: GameState): number {
  return state.spellChain.length + state.pendingDecisions.length + (state.turnState === "Showdown" ? 1 : 0);
}

/**
 * Drives deferred resolution to completion, so a candidate action can be
 * scored on what it ACHIEVES rather than on the moment it's taken.
 *
 * This is load-bearing, not a refinement. Both of this engine's payoffs are
 * deferred behind PassFocus: `MoveUnit` into a contested battlefield only
 * opens a Showdown (combat resolves two focus-passes later), and a Spell's
 * `PlayCard` only pushes a ChainEntry (its effect resolves two chain-passes
 * later). Scoring the immediate state therefore showed an attack as "my unit
 * is standing somewhere else" and a cast as literally no change at all — so
 * `evaluate` returned a tie, and ties go to `Pass` because legal-actions.ts
 * pushes it first and `chooseAction` compares with a strict `>`.
 *
 * Measured over 12 self-play games before this existed: of 139 states offering
 * an attack the AI would WIN, the immediate score rated the best one at a
 * median of 0 (range −1…+2 — pure location-aura noise, not the fight), and the
 * AI passed in 53 of them. Settling first rates those same attacks at a median
 * of +1003. Spells were worse: the immediate score was exactly 0 in all 211
 * states one was legal (runes and cards aren't in `evaluate`, so a cast
 * couldn't even score as a cost), and the AI cast a Spell 0 times in 40 games.
 *
 * Note this cuts BOTH ways, which is the point — the settled score runs as low
 * as −7 on a losing attack, so the AI now declines bad fights for the same
 * reason it takes good ones. It gains judgement, not just aggression.
 *
 * `opponentReplies` is what makes this 2-ply rather than 1. With it false, the
 * opponent is assumed to pass — which used to be the only behaviour, and was a
 * genuinely OPTIMISTIC assumption rather than the only legal outcome once
 * [Action]/[Reaction] casting existed: the AI scored every attack and every cast
 * as though it resolved unopposed, and walked into removal it could have
 * anticipated.
 *
 * With it true, whenever the player to act is not the one being evaluated for,
 * that player picks their own best action instead. Their evaluation of it is
 * settled with `opponentReplies: false` — the depth guard. Without it the two
 * sides would model each other forever; with it the search is exactly two plies
 * deep, which is what the branching factor here affords (measured: 0.16 ms and
 * a median of 16 candidates per decision before this).
 */
function settleDeferredResolution(
  state: GameState,
  weights: EvalWeights = BASELINE_WEIGHTS,
  forIndex?: 0 | 1,
  opponentReplies = false,
): GameState {
  let settled = state;
  /**
   * What each iteration DID, kept only to be printed if the loop gives up.
   *
   * The message used to name a count and nothing else, and a count cannot
   * distinguish the two failures that reach it: a chain that will not drain, and
   * a chain that drains while something refills it faster. Those want opposite
   * fixes, and telling them apart by re-reading the code is guesswork. One
   * bounded array of short strings costs nothing on the hot path — it is only
   * ever read on the throw.
   */
  const trace: string[] = [];
  let previousWork = outstandingWork(settled);
  let sinceProgress = 0;
  for (let i = 0; i < MAX_SETTLE_PASSES; i++) {
    // Progress is the work going down SINCE THE LAST ITERATION — not below the
    // lowest ever seen.
    //
    // The historic-minimum version of this was written first and was wrong, in a
    // way worth recording because it looked more principled: the work
    // legitimately RISES above where it started, since resolving one chain item
    // is what fires the triggers that add the next twelve. Measured on the real
    // failure — a chain of 1 becoming 12, then draining cleanly — a minimum-based
    // guard called a perfectly healthy resolution stuck at iteration 17, because
    // 12 down to 6 never dips below the 1 it began at.
    //
    // An oscillating resolution can evade a since-last-iteration test; that is
    // what `MAX_SETTLE_PASSES` is a backstop for, and it reports the difference.
    const work = outstandingWork(settled);
    if (work < previousWork) sinceProgress = 0;
    else sinceProgress += 1;
    previousWork = work;
    if (sinceProgress > MAX_SETTLE_PASSES_WITHOUT_PROGRESS) {
      throw new Error(
        `settleDeferredResolution stalled: ${sinceProgress} iterations with no fall in outstanding work ` +
          `(now ${work}) (chainOpen=${settled.chainOpen}, chain=${settled.spellChain.length}, ` +
          `pendingDecisions=${settled.pendingDecisions.length}, turnState=${settled.turnState})` +
          `\n  trace: ${trace.slice(-24).join(" ")}` +
          `\n  chain now: ${settled.spellChain
            .map((e) => ("listenerDefId" in e ? (e.listenerDefId ?? "?") : "spell"))
            .join(", ")}`,
      );
    }
    // Only the tail is ever printed, so the buffer stays small on a long but
    // healthy resolution — a 40-item chain is ~80 iterations of nothing wrong.
    trace.push(
      `${i}:chain=${settled.spellChain.length}${settled.chainOpen ? "o" : "c"}` +
        `,pend=${settled.pendingDecisions.length},ts=${settled.turnState},act=${actingPlayerIndex(settled)}`,
    );
    if (trace.length > 32) trace.shift();
    // A pending question comes first — nothing else is legal until it is
    // answered, so a settle that ignored it would spin on PassFocus actions the
    // engine is refusing and score a half-resolved board.
    //
    // Answered with the option that scores best FOR THE PLAYER BEING ASKED,
    // which is not always the AI: Cull the Weak asks the opponent to kill one of
    // their own units, and assuming they hand over their best one would make the
    // AI wildly overrate the card. Using each player's own interest is also what
    // keeps the lookahead self-consistent — it is exactly what the AI will do
    // when the question really reaches it.
    const pending = settled.pendingDecisions[0];
    if (pending) {
      const answers = legalActions(settled);
      // A question at the front of the queue always has an answer, and that is an
      // invariant of decisions.ts rather than a hope: `advanceDecisions` drains a
      // head with no options (it has become moot) and `definitionFor` throws on a
      // kind nothing registers. So reaching here means one of those broke.
      //
      // Returning `settled` was the silent response, and the same shape as the
      // exhaustion case below: `evaluate` reads points, might, hand and gear,
      // none of which reveal that a question is still outstanding, so the AI
      // would score a board the game can never reach and pick a move on it.
      // Measured before changing it — 18,823 pending-decision iterations across
      // ai-health, walkout and chain-depth (440 games), of which 0 reached here.
      if (answers.length === 0) {
        throw new Error(
          `settleDeferredResolution: a pending decision offers no answer ` +
            `(kind=${pending.kind}, id=${pending.id}, playerIndex=${pending.playerIndex}). ` +
            `advanceDecisions should have dropped it or definitionFor should have thrown.`,
        );
      }
      const current = settled;
      let bestAnswer = answers[0]!;
      let bestValue = -Infinity;
      // `applyAction`, not `applyBare`: `submit` runs a Cleanup after an
      // AnswerDecision like it does after every other action (game-engine.ts:113),
      // and `applyAction` carries the same 321 suppression at :68 for the case
      // where answering one question raises another. Scoring bare states here made
      // the lookahead judge answers on a board the real game never passes through —
      // an answer that empties a battlefield would not have lapsed control, and one
      // that contests a battlefield would not have staged the Showdown that scores it.
      //
      // It also matters for anything the Cleanup is the ONLY carrier of. Today that
      // is control lapsing and Showdown staging; once triggers are held as Chain
      // Pending Items and flushed by the Cleanup, a settle that skipped it here
      // would return with the holding pen full and `evaluate` would score a board
      // where the trigger never happened — silently, since nothing throws.
      for (const answer of answers) {
        const value = evaluate(applyAction(current, answer), pending.playerIndex, weights);
        if (value > bestValue) {
          bestValue = value;
          bestAnswer = answer;
        }
      }
      settled = applyAction(current, bestAnswer);
      continue;
    }
    // The opponent gets to answer back, rather than being assumed to pass.
    // Their reply is chosen in THEIR interest, by the same candidate list and
    // the same evaluator the AI uses on itself — an opponent model that
    // considers moves the AI would never make is modelling somebody else.
    if (opponentReplies && forIndex !== undefined && actingPlayerIndex(settled) !== forIndex) {
      const reply = bestActionFor(settled, actingPlayerIndex(settled), weights, false);
      // Passing is the one reply that changes nothing, so taking it here would
      // spin the loop; fall through to the PassFocus driving below instead.
      if (reply && reply.type !== "Pass") {
        settled = applyAction(settled, reply);
        continue;
      }
    }

    // A closed chain takes precedence over an open Showdown, mirroring
    // executePassFocus's own dispatch order (it checks `chainOpen` first).
    if (!settled.chainOpen) {
      // Cleanup after each pass, same as `submit` — a chain closing inside a
      // Showdown can restage or promote one (316.8.b.1.a), which the next iteration
      // must see.
      settled = runCleanup(executePassFocus(settled, { type: "PassFocus", playerIndex: settled.chainPriority }));
      continue;
    }
    if (settled.turnState === "Showdown") {
      settled = runCleanup(executePassFocus(settled, { type: "PassFocus", playerIndex: settled.focusHolder }));
      continue;
    }
    return settled;
  }
  // Falling out of the loop means the resolution never settled. Returning the
  // half-resolved state here is what made this a SILENT failure: `evaluate` reads
  // points, might, hand and gear, none of which reveal that a chain is still closed
  // or that work is still queued, so the AI would score a board the game can never
  // reach and pick a move on it. Throwing matches decisions.ts's MAX_ADVANCE_STEPS,
  // the same "a queue that will not drain is a bug, not a state" call.
  // The BACKSTOP, not the real bound — the stall guard above is what normally
  // fires. Reaching here means work kept falling for a thousand iterations,
  // which is a resolution making progress forever: unbounded generation, not a
  // deadlock. Different bug, so it says so rather than reusing the stall message.
  throw new Error(
    `settleDeferredResolution ran ${MAX_SETTLE_PASSES} iterations while still making progress — ` +
      `the resolution is unbounded rather than stuck ` +
      `(chainOpen=${settled.chainOpen}, chain=${settled.spellChain.length}, ` +
      `pendingDecisions=${settled.pendingDecisions.length}, turnState=${settled.turnState})` +
      `\n  trace: ${trace.join(" ")}` +
      `\n  chain now: ${settled.spellChain
        .map((e) => ("listenerDefId" in e ? (e.listenerDefId ?? "?") : "spell"))
        .join(", ")}`,
  );
}

/**
 * What one point of marked damage is worth, relative to one point of Might.
 *
 * Deliberately BELOW 1, and that bound is the whole design. `effectiveMight`
 * ignores marked damage, so before this the evaluator could only see damage that
 * actually killed something — every non-lethal hit scored exactly 0. That made
 * each target choice for a damage spell a tie, and ties fall through to
 * enumeration order, which lists base units before battlefield ones: the
 * observable symptom was the AI aiming Singularity ("Deal 6 to each of up to two
 * units") at its OWN base unit while an enemy stood at a battlefield.
 *
 * Weighting damage at full value would fix the sign and introduce a new error:
 * chipping 6 onto an 8-Might unit (+6) would outbid killing a 4-Might one (+4),
 * when the chip heals at end of turn (runEnd) or at Combat Cleanup and the kill
 * is permanent. Keeping the weight under 1 means accumulated damage can never
 * outbid removing the unit outright, so this only ever breaks ties — which is
 * exactly the job. It is a tie-breaker, not a valuation of damage.
 */
const DAMAGE_WEIGHT = 0.25;

/** A unit's worth to its controller: its Might, less a discount for damage
 *  already marked on it (see DAMAGE_WEIGHT). */
function unitValue(state: GameState, unit: UnitInstance, playerIndex: 0 | 1, battlefieldId?: string): number {
  const might = effectiveMight(state, unit, playerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });
  return might - unit.damage * DAMAGE_WEIGHT;
}

function totalBoardMight(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  let total = player.baseUnits.reduce((sum, u) => sum + unitValue(state, u, playerIndex), 0);
  for (const bf of state.battlefields) {
    total += (bf.units[player.id] ?? []).reduce((sum, u) => sum + unitValue(state, u, playerIndex, bf.id), 0);
  }
  return total;
}

/**
 * What the evaluator prices, and at what.
 *
 * Named and passable so a candidate weighting can be played head-to-head against
 * the current one over hundreds of games — which is the only defensible way to
 * add a term here. This codebase's standing rule is no speculative heuristic
 * without a real evaluative basis (it is why the AI does not mulligan, does not
 * float runes, and skips resource-banking abilities), and "a card in hand feels
 * like about 2 Might" is exactly the kind of invented number that rule exists to
 * keep out. A win rate is not an invented number.
 *
 * Deliberately NOT a forked `heuristic-ai-v1.ts` to compare against: a copied
 * module rots the moment the engine underneath it changes, and a benchmark that
 * has quietly stopped meaning anything is worse than none.
 */
export interface EvalWeights {
  /**
   * Model the opponent answering back, rather than assuming they pass.
   *
   * Not a weight — a change of SEARCH depth, not of valuation — but it lives
   * here so a candidate can be played head-to-head against the current
   * behaviour by exactly the same harness.
   *
   * **Off by default, and measured rather than assumed.** On its own it LOSES,
   * 46.6% over 3000 games, and the reason is a mispricing rather than the search:
   * with `cardInHand` at 0 the modelled opponent answers back for FREE, so the AI
   * over-fears a reply that really costs them a card. Priced properly the same
   * search wins (52.0%) — but that is indistinguishable from `cardInHand` alone
   * (52.2%), and it costs ~5x the compute per action.
   *
   * So it is kept, off, with its result written down: no measurable gain, real
   * cost. Worth revisiting when the pool has enough Reaction cards that a reply
   * is common rather than occasional, which is when a depth-2 search should
   * start to pay for itself.
   */
  twoPly: boolean;
  /** Points dominate — winning outranks any board consideration. */
  point: number;
  /** A unit's Might, the proxy for "whose position is developing better". */
  might: number;
  /**
   * A card in hand.
   *
   * **Back to zero, and this time zero is the measured answer rather than an
   * oversight.** It shipped at 0.5 on the strength of a 52.2% plateau measured
   * across the seven preset decks — which, it turned out, contained no card
   * whose value was drawing. Re-measured on decks built to contain them, 0 beats
   * 0.5 at ~53.9% (four independent seed sets: 54.3/54.9/53.7/52.7) and is
   * neutral on the presets themselves (~49%).
   *
   * The behavioural half points the same way and is the more decisive one: over
   * 72 games, `cardInHand: 0` casts the eight pure-draw cards **49** times
   * against **2** at 0.5. Valuing a card in hand makes the AI reluctant to spend
   * one even to draw three, so the cards go uncast — which also makes every card
   * of that shape unreachable in the self-play probes this project verifies with.
   *
   * The original rationale for adding it ("the evaluator charges nothing for
   * spending a card") was sound; the correction is that the term as written
   * charges for spending WITHOUT crediting what the spend buys, so it prices
   * hoarding rather than card advantage. A term that did the latter would need
   * to value the BOARD a drawn card becomes, which `evaluate` cannot see.
   */
  cardInHand: number;
  /**
   * A permanent on the board that is not a unit — gear. Zero today, which is why
   * the AI has played gear exactly zero times in 60 games: a gear changes no
   * Might on arrival, so it ties with Pass, and ties go to Pass.
   */
  permanentInPlay: number;
  /**
   * Price a permanent by what its ACTIVATED ability would actually do right now,
   * instead of (or alongside) the flat `permanentInPlay` weight. See
   * `activatedAbilityValue` — this is the difference between recognising a gear
   * and merely counting it.
   *
   * **Off by default, and the reason is a fact about the CARDS.** It works: with
   * it on, the AI plays Orb of Regret (the one gear in the pool with an
   * activated ability) and correctly declines the four whose value waits on a
   * future trigger. But it measures 50.7% against 52.2% without it — every
   * configuration that plays more gear lands at ~50%, whether the gear is
   * chosen well or badly. The recognition is accurate; the gear is marginal.
   * "-1 Might, to a minimum of 1" is not worth a card and an Energy here.
   *
   * Kept because it is the right MECHANISM the day the pool has gear worth
   * playing, and because turning it on is what makes gear reachable in the
   * self-play probes this project verifies with — today they cannot reach it.
   */
  abilityValue: boolean;
}

/**
 * What ships, and what every candidate is measured against.
 *
 * Every number here was settled by `scratchpad/ai-ab.mjs`, candidate against
 * shipping, both seats, thousands of games per candidate.
 *
 * **The first round, across the seven preset decks:**
 *
 *   cardInHand 0.25 / 0.5 / 0.75   52.1-52.2%   win   (a flat plateau)
 *   cardInHand 2                   46.3%        LOSE
 *   cardInHand 4                   34.0%        LOSE
 *   permanentInPlay 0.5 .. 4       ~50%         neutral
 *   twoPly alone                   46.6%        LOSE
 *   twoPly + cardInHand 0.5        52.0%        win
 *
 * **The second round, and why it was needed.** The presets contain no card whose
 * value is drawing — they were taken to zero inert cards early, so every card
 * added since lives outside them. Once eight pure-draw cards existed, the basis
 * that settled `cardInHand` no longer exercised it. Measured on decks BUILT to
 * hold them, `cardInHand: 0` beat the shipped 0.5 at ~53.9% (four seed sets)
 * while staying neutral on the presets themselves.
 *
 * That run also exposed an ENGINE bug rather than an AI one: spending cards
 * faster reached two empty decks, which the missing Burn Out (431) could not
 * resolve, and self-play livelocked at turn 538. Burn Out is implemented now,
 * and everything was re-measured against the corrected engine, because a
 * liveness bug in the middle of a tuning basis invalidates the tuning:
 *
 *   (baseline is cardInHand 0)
 *   cardInHand 0.25   cantrip decks   44.5%   LOSE
 *   cardInHand 0.5    cantrip decks   45.7%   LOSE
 *   cardInHand 1      cantrip decks   46.9%   LOSE
 *   cardInHand 2      cantrip decks   38.8%   LOSE
 *   cardInHand 0.5    presets         49.9%   neutral
 *   cardInHand 1      presets         49.8%   neutral
 *
 * So 0 it is, and more clearly after the fix than before it. The behavioural
 * half agrees and is the more decisive one: 0 casts the eight pure-draw cards
 * 49 times per 72 games against 2 at 0.5.
 *
 * Two lessons, both about the BASIS rather than the number. A measurement is
 * only as good as the pool it ran on, and this one silently stopped being
 * representative the moment the card pool grew past it — any future tuning has
 * to say which decks it ran on. And a tuning run is a liveness probe whether or
 * not it is meant to be: this one found a 538-turn livelock that 40/40 self-play
 * had been passing over.
 *
 * `permanentInPlay` earns its place on behaviour rather than strength: it is
 * neutral in win rate at every weight tried, and it takes gear plays from ZERO
 * across 60 games to ~22 per 40. An AI that never plays a third of its deck is a
 * worse opponent to practise against and, worse, makes every gear card
 * unreachable in the self-play probes this project verifies with.
 */
export const BASELINE_WEIGHTS: EvalWeights = {
  point: 1000,
  might: 1,
  cardInHand: 0,
  permanentInPlay: 0.5,
  abilityValue: false,
  twoPly: false,
};

/**
 * What a permanent with an ACTIVATED ability is actually worth: whatever using
 * it right now would be worth.
 *
 * This is recognition rather than a fudge factor, and the difference shows in
 * play. A flat per-gear weight says every gear is worth the same, so the AI
 * plays a useless one as readily as a useful one and plays it when it does
 * nothing — which is why the flat weight costs win rate. This asks the actual
 * question: apply the ability through the real executor, and see if the board
 * got better.
 *
 * Scored on Might alone, deliberately, and NOT through `evaluate`: that would
 * recurse (evaluate -> gear value -> evaluate). Might is also the only thing an
 * activation can move in one step, so the cheaper metric loses nothing.
 *
 * Floored at zero. An ability that would make things worse is one the AI simply
 * would not use, so it does not make the gear a liability — it makes it worth
 * nothing, which is the honest valuation of a card you will not activate.
 *
 * Reaches only ACTIVATED abilities, and that is a real limit worth naming: four
 * of the five gear in the preset pool are TRIGGERED (Mushroom Pouch on your
 * Beginning Phase, Mistfall on a buff, Mask of Foresight when combat begins,
 * Scrapheap on its own fate). Their value depends on an event that has not
 * happened, so a position evaluator has nothing to price it with. Declining to
 * guess is the same judgement this AI already makes about [Hidden] and floating
 * runes.
 */
function activatedAbilityValue(state: GameState, playerIndex: 0 | 1): number {
  const actor = state.players[playerIndex];
  const before = totalBoardMight(state, playerIndex) - totalBoardMight(state, 1 - playerIndex as 0 | 1);
  let total = 0;

  for (const gear of actor.activeGear) {
    let best = 0;
    for (const { abilityDefId } of abilitiesAvailableTo(state, playerIndex, gear)) {
      if (!canPayActivationCost(state, playerIndex, gear, abilityDefId)) continue;
      for (const mode of availableModes(abilityDefId, gear)) {
        const targets =
          mode.targeting.kind === "unit"
            ? eligibleTargets(state, playerIndex, mode.targeting.owner, mode.targeting.scope, mode.targeting.domain).map((u) => u.instanceId)
            : [undefined];
        for (const targetUnitInstanceId of targets) {
          const used = mode.resolve(
            state,
            contextFor(playerIndex),
            targetUnitInstanceId !== undefined ? { targetUnitInstanceId } : {},
            gear.instanceId,
          );
          const after = totalBoardMight(used, playerIndex) - totalBoardMight(used, 1 - playerIndex as 0 | 1);
          best = Math.max(best, after - before);
        }
      }
    }
    total += best;
  }
  return total;
}

function evaluate(state: GameState, forIndex: 0 | 1, weights: EvalWeights = BASELINE_WEIGHTS): number {
  const opponentIndex: 0 | 1 = forIndex === 0 ? 1 : 0;
  const side = (index: 0 | 1) => {
    const p = state.players[index];
    return (
      p.points * weights.point +
      totalBoardMight(state, index) * weights.might +
      p.hand.length * weights.cardInHand +
      p.activeGear.length * weights.permanentInPlay +
      (weights.abilityValue ? activatedAbilityValue(state, index) : 0)
    );
  };
  return side(forIndex) - side(opponentIndex);
}

/** Picks the legal action whose resulting state scores highest for the
 *  acting player, falling back to Pass when nothing beats it.
 *
 *  `forIndex` mirrors GameBoard.tsx's own `actingPlayerIndex` precedence
 *  (chain closed -> chainPriority, Showdown -> focusHolder, else ->
 *  activePlayerIndex) — this used to be hardcoded to `activePlayerIndex`,
 *  which was harmless only because `legalActions` used to return exactly
 *  one candidate (PassFocus) during a Showdown/closed chain, so the loop
 *  below always picked that single real action regardless of which index
 *  it was scored from. Now that FloatRune candidates can also appear
 *  alongside PassFocus in those states (see legal-actions.ts), scoring them
 *  "for activePlayerIndex" would be wrong whenever Focus/chain priority
 *  sits with the other player — this is that exact fix.
 *
 *  FloatRune and HideCard are filtered out of the candidate pool entirely, and
 *  so are the ActivateAbility candidates that only BANK a resource: `evaluate` scores
 *  board state (points/Might), which can't value something stored for a
 *  future play this 1-ply lookahead never sees — scoring those would only
 *  ever produce a meaningless tie with Pass/PassFocus. Matches this
 *  project's "no speculative heuristic without a real evaluative basis"
 *  precedent (e.g. the AI never mulligans either, for the same reason).
 *
 *  ActivateAbility used to be excluded wholesale under that same reasoning,
 *  which was right when Lux - Crownguard's Energy-banking was the only such
 *  ability and wrong once a Gear ability could change a unit's Might — that
 *  IS board state, so the evaluator prices it correctly and the AI should
 *  use it. `abilityBanksResource` is the line between the two. */
/**
 * The best action for `forIndex`, or undefined when there is nothing to choose.
 *
 * `opponentReplies` is passed straight through to the settle: true for the AI's
 * real decision (2-ply), false when this IS the opponent's reply being modelled
 * (the depth guard — see settleDeferredResolution).
 */
function bestActionFor(
  state: GameState,
  forIndex: 0 | 1,
  weights: EvalWeights,
  opponentReplies: boolean,
): PlayerAction | undefined {
  const candidates = candidateActions(state);
  if (candidates.length === 0) return undefined;

  let best: PlayerAction | undefined;
  let bestScore = -Infinity;
  for (const action of candidates) {
    // Every candidate is scored on its SETTLED outcome — see
    // settleDeferredResolution for why scoring the immediate state made the AI
    // structurally unable to attack a contested battlefield or cast a Spell.
    // Only the scoring looks ahead; the action actually returned is still the
    // single candidate, so the real game still resolves through the real
    // PassFocus actions (and, in the UI, at the AI's own pacing).
    const settled = settleDeferredResolution(applyAction(state, action), weights, forIndex, opponentReplies);
    const score = evaluate(settled, forIndex, weights);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

export function chooseAction(rawState: GameState, weights: EvalWeights = BASELINE_WEIGHTS): PlayerAction {
  const forIndex = actingPlayerIndex(rawState);
  // The AI may see THAT a facedown card is at a battlefield — it changes whether
  // attacking there is wise, and it is public information — but not WHICH card it
  // is (rule 811: "the property is granted to the card in its facedown state, and
  // is not publicly known"). Without this the AI reads the same GameState the
  // engine holds and can play around a card it cannot legally know, which would
  // look like the AI being sharp rather than the bug it is.
  //
  // Its OWN facedown cards are untouched, so it can still play them.
  const state = maskHiddenCards(rawState, forIndex);
  // `twoPly` here is what separates the real decision from the opponent model it
  // contains — see settleDeferredResolution's `opponentReplies`.
  return bestActionFor(state, forIndex, weights, weights.twoPly) ?? { type: "Pass", playerIndex: forIndex };
}
