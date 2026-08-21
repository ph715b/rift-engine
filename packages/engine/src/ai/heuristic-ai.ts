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
import { executeFloatRune } from "../actions/execute-float-rune.js";
import { executeHideCard } from "../actions/execute-hide-card.js";
import { ORDER_TRIGGERS, answerDecision } from "../engine/decisions.js";
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
import { runEnd, runStartOfTurn } from "../engine/turn-manager.js";
import { winner } from "../engine/win-condition.js";
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
function applyAction(state: GameState, action: PlayerAction, weights: EvalWeights): GameState {
  const applied = applyBare(state, action, weights);
  // Same suppression `submit` applies, and for the same rule (321): if the
  // action stopped to ask a question, the resolution is not finished and a
  // Cleanup must not run inside it. Skipping it here keeps the lookahead scoring
  // states the real game actually passes through.
  return applied.pendingDecisions.length > 0 ? applied : runCleanup(applied);
}

/**
 * `weights` is threaded here only for `passEndsTurn`, and it is a REQUIRED
 * parameter rather than a defaulted one on purpose: every call site already has
 * the weights in scope, and a default would let a future one silently score the
 * baseline's Pass while the rest of the search used the candidate's.
 */
function applyBare(state: GameState, action: PlayerAction, weights: EvalWeights): GameState {
  switch (action.type) {
    case "Pass":
      // **With the flag off this is a no-op, while `submit` runs
      // `runStartOfTurn(runEnd(state))`** — rotate the seat, then the OPPONENT's
      // Awaken, their `killTemporaryPermanents`, their hold scoring, their draw.
      // The largest transition in the game, scored at zero, and the only one the
      // settle can never reach: `runEnd` is called from exactly one place in the
      // engine and this is it.
      //
      // Off is internally consistent — Pass scores the board as it stands, so
      // every candidate is measured against "what if I did nothing" — which is
      // how it survived this long. The cost was measured rather than argued.
      // Over 30 preset self-play games: 385 Passes, every one with a
      // discretionary action legal (median 8 available), and in 136 of them the
      // opponent scored on the turn that followed — 155 points handed over,
      // priced at 0. The actor also sheds 233 Might to this-turn state expiring
      // in `runEnd`, equally unseen.
      //
      // `passEndsTurn` is the correction, behind a flag so `probes/ai-ab.ts` can
      // play it head-to-head — see the flag's own doc comment on `EvalWeights`
      // for what the measurement said. `applyAction` runs the Cleanup around
      // this, which is exactly `submit`'s `withCleanupAndWinnerCheck`; the winner
      // check itself only reads, and `evaluate` already prices points.
      //
      // **`ownTurnRollout` forces it too, and that is not a convenience — the
      // rollout is unusable without it.** Measured, at 0.25% over 400 games: with
      // Pass left as a no-op, `rolloutOwnTurn` would run on the Pass candidate
      // like any other and score it as "play my whole turn out, then end it",
      // which is exactly what the best REAL action also scores. Every candidate
      // therefore tied with Pass, ties go to Pass, and the AI ended its turns
      // having done nothing while its lookahead believed it had played them.
      // `MoveUnit` fell to 107 against the baseline's 1280.
      //
      // So Pass means "end the turn NOW, having done nothing else", and the
      // rollout's guard on `activePlayerIndex` then leaves this state alone. Both
      // sides of the comparison land after the turn end, which is the whole point
      // of the rollout and the thing `passEndsTurn` alone could not achieve.
      return weights.passEndsTurn || weights.ownTurnRollout ? runStartOfTurn(runEnd(state)) : state;
    case "PlayCard":
      return executePlayCard(state, action);
    case "MoveUnit":
      return executeMoveUnit(state, action);
    case "RecallUnit":
      return executeRecallUnit(state, action);
    case "PassFocus":
      return executePassFocus(state, action);
    case "HideCard":
      // Reachable when `hideCards` un-filters it. It used to be a no-op here on
      // the grounds that `candidateActions` never offered it — true, and exactly
      // the shape of trap this file keeps paying for: un-filtering the action
      // without wiring the executor would have scored every Hide as "nothing
      // happened", tied it with Pass, and reproduced the old behaviour while
      // looking like a change. Checked before measuring, not after.
      return executeHideCard(state, action);
    case "FloatRune":
      // Same, for the same reason — see the HideCard case one line up.
      return executeFloatRune(state, action);
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
 *
 * **That reasoning was exactly right and is conditional on the horizon.** All
 * three are stored value: a floated rune, a hidden card and a banked Energy all
 * buy a play LATER. With `ownTurnRollout` on, "later this turn" is inside the
 * window for the first time, so the same argument that excluded them stops
 * applying to whatever fraction of their value lands before the turn ends.
 *
 * So each is behind its own flag and each was measured separately — the results
 * are on the flags themselves. `bankAbilities` is the cheapest of the three
 * because `executeActivateAbility` is already wired; the other two also needed
 * `applyBare` to stop treating them as no-ops.
 */
function candidateActions(state: GameState, weights: EvalWeights): PlayerAction[] {
  return legalActions(state).filter(
    (a) =>
      (weights.floatRunes || a.type !== "FloatRune") &&
      (weights.hideCards || a.type !== "HideCard") &&
      (weights.bankAbilities ||
        !(a.type === "ActivateAbility" && abilityBanksResource(findActivatable(state, a.playerIndex, a.permanentInstanceId)?.card.defId ?? ""))),
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
 *  zero, and the one a stall is defined against.
 *
 *  **The ordering question's REMAINING CHOICES count**, and they have to: 383.3.d
 *  lets a player order N simultaneous triggers, which is N-1 answers that each
 *  re-park the question and change neither the chain length nor the queue depth.
 *  Without this the loop sees N-1 iterations of "no progress" and calls a
 *  perfectly healthy resolution stuck — which is exactly what a mass death did,
 *  the same case `MAX_SETTLE_PASSES_WITHOUT_PROGRESS` above was already widened
 *  for once. Each answer shortens `chainSlots` by one, so this decreases
 *  strictly. */
function outstandingWork(state: GameState): number {
  const ordering = state.pendingDecisions.reduce((total, d) => total + (d.chainSlots?.length ?? 0), 0);
  return state.spellChain.length + state.pendingDecisions.length + ordering + (state.turnState === "Showdown" ? 1 : 0);
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
    if (pending?.kind === ORDER_TRIGGERS) {
      // **383.3.d's ordering question is answered without scoring, deliberately.**
      //
      // `evaluate` reads points, Might, hand and gear. None of those can see the
      // difference between two orderings of the same set of triggers — the
      // interaction that makes an order matter is between the abilities
      // themselves. So the AI has no basis to prefer one, which is the same
      // reasoning `banksResource` records for an ability that only stores Energy.
      //
      // **And scoring them is not merely uninformative, it is quadratic.** Every
      // answer re-parks the question over the remaining slots, so an N-trigger
      // group costs N-1 answers of up to N options, each one a full apply-and-
      // evaluate — inside every lookahead candidate. Measured the hard way: the
      // heuristic-ai suite ran past ten minutes on a mass-death board before this
      // branch existed.
      //
      // The identity permutation: the chain is LIFO, so the item already in the
      // LAST slot already resolves first. Choosing it changes nothing, which is
      // exactly what "the AI has no preference" should mean — and it keeps the
      // AI's play identical to what it was before the choice existed.
      const slots = pending.chainSlots ?? [];
      const keep = slots[slots.length - 1];
      const answered = keep === undefined ? undefined : answerDecision(settled, pending.id, String(keep));
      if (answered) {
        settled = answered;
        continue;
      }
    }
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
        const value = evaluate(applyAction(current, answer, weights), pending.playerIndex, weights);
        if (value > bestValue) {
          bestValue = value;
          bestAnswer = answer;
        }
      }
      settled = applyAction(current, bestAnswer, weights);
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
        settled = applyAction(settled, reply, weights);
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
  /**
   * Let the lookahead's `Pass` actually END THE TURN, as `submit` does.
   *
   * Not a weight and not really a search-depth change either — a CORRECTION,
   * behind a flag purely so `probes/ai-ab.ts` can measure it, since that harness
   * compares two weight sets. See `applyBare`'s Pass case.
   *
   * Off, this file's oldest and largest blind spot: `applyBare` returns the state
   * unchanged while the real `submit` runs `runStartOfTurn(runEnd(state))` —
   * rotate, the opponent's Awaken, their `killTemporaryPermanents`, their hold
   * scoring, their draw. Measured over 30 preset games before the flag existed:
   * 385 Passes, every one with a discretionary action legal (median 8 available),
   * and in **136 of them the opponent scored on the turn that followed — 155
   * points handed over, scored as 0**. The actor also shed 233 Might to this-turn
   * state expiring in `runEnd`.
   *
   * It is internally consistent with it off, which is how it survived: Pass then
   * scores the current board, so every candidate is measured against "what if I
   * did nothing", and the turn-end cost is a constant that mostly cancels. Mostly
   * — it does NOT cancel across a battlefield the AI could have contested, which
   * is exactly the 136 above.
   *
   * **Measured, and it does not pay on its own — kept OFF, on the `twoPly`
   * precedent.** Both bases, `probes/ai-ab.ts`:
   *
   *   presets, 400 games   49.25% ±4.9
   *   VEN covering, 240    47.92% ±6.3
   *
   * Neutral to slightly negative, and the behavioural half is where the answer
   * is. Turning it on barely moves how OFTEN the AI passes (2583 against 2579 —
   * that count is ~one per turn and structural, not a preference), and moves
   * heavily what it does BEFORE passing: `RecallUnit` 454 against 7 on the
   * presets and 222 against 2 on VEN, `ActivateAbility` 761 against 348 on VEN,
   * `MoveUnit` +23%.
   *
   * The leading explanation, which the next experiment should confirm or kill:
   * this corrects ONE SIDE of the comparison. Pass now carries the full turn-end
   * cost while every alternative still hides it, so the AI prefers doing
   * something — anything — over ending the turn. That is a bias, not judgement,
   * and a 65x rise in Recalls is what a bias looks like rather than what
   * recognition looks like. Shipping it would raise `reachability` for the wrong
   * reason, which is a worse outcome here than leaving the blind spot.
   *
   * So the correction belongs in a lookahead that applies the turn end to EVERY
   * candidate, not to Pass alone — i.e. the own-turn rollout, whose terminal
   * state must therefore be `runStartOfTurn(runEnd(...))` rather than the state
   * before it. See docs/ai-improvement-plan.md.
   */
  passEndsTurn: boolean;
  /**
   * Score every candidate on the state at the END of the acting player's turn,
   * rather than on the state its own resolution settles into.
   *
   * The own-turn depth axis, and a different one from `twoPly` — that adds the
   * OPPONENT's ply, this one adds the rest of the AI's own. See
   * `rolloutOwnTurn`, which carries the design and the reason its terminal state
   * is post-`runEnd`.
   *
   * A flag rather than a replacement for the same reason `twoPly` and
   * `abilityValue` are flags: it is what lets `probes/ai-ab.ts` play it
   * head-to-head, and it keeps the result and the cost recorded next to the
   * switch whichever way the measurement lands.
   *
   * **It WINS, and by more than anything else this harness has measured.**
   *
   *                    unbeamed        with ROLLOUT_BEAM (what ships)
   *   presets          71.00% ±4.4     **69.50% ±4.5**   (400 games)
   *   VEN covering     59.17% ±6.2     **58.75% ±6.2**   (240 games)
   *
   *   presets, three independent 25-pair seed sets: 78% / 62% / 60%
   *   reverse control (baseline flipped ON, candidate OFF): **22%**, 11/39 —
   *     the exact mirror of the 39/11 the forward run gave on the same seeds
   *
   * The beam is free within measurement error — 1.5pp and 0.4pp, both well
   * inside overlapping intervals — and it takes the worst single decision from
   * 954 ms to 153 ms. See `ROLLOUT_BEAM`.
   *
   * The behavioural half passes the recognition-versus-bias test that
   * `passEndsTurn` failed. On VEN: `ActivateAbility` **848 against 385**,
   * `MoveUnit` +24%, `PlayCard` +9% — and `RecallUnit` stayed at 1 against 2,
   * where `passEndsTurn` had blown it up to 454 against 7. The extra actions are
   * concentrated in plays, moves and activations, which is what recognition looks
   * like; a 65x swing into one junk action is what bias looks like.
   *
   * **It is nevertheless off HERE, and the reason is runtime.** `ai-health` (40
   * self-play games) goes **4.4s → 51.7s, ~11.8x** — well above the ~5x this was
   * scoped against. `reachability` is already 292-496s, so a default flip puts
   * the verification loop's longest gate near an hour. Every pinned figure in
   * CLAUDE.md was measured with this off.
   *
   * So the split is deliberate: the instruments keep the cheap policy and the
   * person gets the good one. `HUMAN_OPPONENT_WEIGHTS` is that second policy and
   * carries the argument for why the resulting bias is the acceptable direction.
   */
  ownTurnRollout: boolean;
  /**
   * Offer the `ActivateAbility` candidates that only BANK a resource, which
   * `candidateActions` has always dropped.
   *
   * The first of the three action-space un-filters, and the cheapest: the
   * executor was already wired, so this is purely a question about the horizon.
   * Banking Energy buys a play later; whether that is priceable depends entirely
   * on whether "later" is inside the window, which is what `ownTurnRollout`
   * changed. **Measure it with `--baseline=ownTurnRollout=true`** or the answer
   * is about the old horizon.
   *
   * **ON, and kept on REACHABILITY rather than win rate — the `permanentInPlay`
   * precedent.** Win rate is *exactly* 50.0% in both configurations, 400 games
   * each, SFD covering decks: 200/200 against plain `BASELINE_WEIGHTS`, 100/100
   * against `BASELINE_WEIGHTS + ownTurnRollout=true`.
   *
   * The Phase 2 thesis is visible in the uptake rather than the win rate, and it
   * holds: WITHOUT the rollout the AI takes only **38 extra activations per 400
   * games**; WITH it, **202 per 200 games** — about 10x. A stored resource really
   * does become priceable once a later spend is inside the window.
   *
   * What settles it is `reachability`, read by NAME: union **798 → 800**, UNL
   * **205 → 207**, nothing lost, and both new cards are **UNL-234 Diana - Scorn
   * of the Moon** (Overnumbered and Signature). She is a LEGEND — never drawn,
   * never offered — whose single ability is `[Exhaust]: [Add] 1 Energy, spend it
   * only during showdowns`. Pure banking on a card that cannot be played. This
   * flag is the *only* mechanism in the engine that could ever exercise her, and
   * without it she was unreachable by construction rather than by sampling.
   *
   * `walkout` does not move (190/113/29), checked by control.
   *
   * It also squares the AI with the project's standing fidelity ruling — the
   * engine is the paper game, so never withhold a legal play.
   */
  bankAbilities: boolean;
  /**
   * Offer `FloatRune`. Same argument as `bankAbilities` — stored value, priceable
   * only if a later spend is in the window.
   *
   * **Catastrophic, and it stays off. 0% over 20 games** (presets, against
   * `ownTurnRollout`), which is not a win rate so much as a diagnosis. The AI
   * floated **415 times in 20 games** and played **70 cards against the
   * baseline's 161**. It floats instead of playing.
   *
   * The mechanism is not "the evaluator cannot price it" — with the rollout on,
   * it can: floating buys Power, the rollout spends the Power, the board improves,
   * `evaluate` sees the board. That is the whole Phase 2 thesis and it works.
   *
   * The mechanism is that **`chooseAction` returns only the first action of the
   * plan, and this plan's first step is repeatable.** Floating is always the
   * first move of a better line, so a greedy first-action policy takes it, then
   * re-plans, and floating is *still* the first move of an even better line. The
   * payoff is permanently one step away and the cards never get cast. Note this
   * is NOT the enumeration-order tie-break — `legalActions` pushes Pass before
   * `floatRuneCandidates`, so ties already go to Pass; floating is scoring
   * strictly higher.
   *
   * Fixing it needs the AI to COMMIT to a rollout's plan rather than re-derive it
   * every action, which is a different policy, not a flag. Worth knowing before
   * anyone tries `HideCard` or a banked resource with the same shape.
   */
  floatRunes: boolean;
  /**
   * Offer `HideCard`. Same argument again, with one difference worth knowing
   * before reading its result: hiding buys a free play on a LATER TURN (rule 811
   * keeps the card only while you hold the battlefield), so an own-turn rollout
   * does not reach its payoff the way it reaches a banked Energy's.
   *
   * **Off, and the honest reason is that it could not be measured rather than
   * that it lost.** 48% ±6.9 over 200 games on the SFD covering decks against
   * `ownTurnRollout=true` — indistinguishable from neutral, on **46 Hides in 200
   * games**. On the presets it was 1 Hide in 20 games, so the first basis tried
   * was very nearly vacuous.
   *
   * The rarity is structural, not sampling: `hideCardCandidates` needs a
   * `[Hidden]` card in hand AND a battlefield you already CONTROL with room under
   * 811's one-per-battlefield limit, at once. Whatever this flag is worth, the
   * blocker is that the action is barely enumerable — a reachability problem, not
   * a horizon one, and not something another A/B run will resolve.
   */
  hideCards: boolean;
}

/**
 * What ships, and what every candidate is measured against.
 *
 * Every number here was settled by an A/B harness — candidate against shipping,
 * both seats on the same seed, thousands of games per candidate.
 *
 * **That harness is `probes/ai-ab.ts` now, and the move is the point.** It was
 * `scratchpad/ai-ab.mjs` twice and was lost twice, while every figure below went
 * on being quoted as settled fact — a codebase whose standing rule is "no
 * speculative heuristic without a real evaluative basis" had its entire
 * evaluative basis in a deleted temp file. Read `tune-the-ai` before changing
 * anything here, and do not quote a figure whose instrument you cannot run.
 *
 * Reproduced on the rebuilt harness, presets, 400 games: `cardInHand: 2` measures
 * **38.5% ±4.8** against today's baseline (the 46.3% below was measured against
 * the then-shipping `cardInHand: 0.5`, on a smaller pool).
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
  passEndsTurn: false,
  ownTurnRollout: false,
  bankAbilities: true,
  floatRunes: false,
  hideCards: false,
};

/**
 * What a HUMAN plays against — `BASELINE_WEIGHTS` plus the own-turn rollout.
 *
 * **Two policies, on purpose, and the reason each is where it is.** The rollout
 * wins by 71% on the presets and 59% on the VEN covering decks, which is the
 * whole of PRD Goal 2/FR9 — a real opponent to practise against. It also costs
 * ~11.8x throughput, which would put `reachability` near an hour and make the
 * verification loop something nobody runs.
 *
 * So the instruments keep the cheap policy and the person gets the good one.
 * That is a real cost and it is worth naming rather than burying: **CLAUDE.md's
 * pinned figures now describe `BASELINE_WEIGHTS`, not the shipped opponent.**
 *
 * The direction of the resulting bias is the reason it is acceptable. The
 * rollout plays MORE cards, moves and abilities (`ActivateAbility` 848 against
 * 385 on VEN, `MoveUnit` +24%), so a probe running the cheap policy UNDERSTATES
 * what a real game reaches. `reachability` is a floor, and a floor measured with
 * the weaker player is a conservative floor. It would be the other way round —
 * a coverage figure claiming cards a human's opponent never actually plays — if
 * the split ran the other way, and that would not be acceptable.
 *
 * Tune against `BASELINE_WEIGHTS`; this is that plus one flag, so it inherits
 * every weight automatically and cannot silently drift into a second tuning.
 */
export const HUMAN_OPPONENT_WEIGHTS: EvalWeights = { ...BASELINE_WEIGHTS, ownTurnRollout: true };

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
 * Actions the rollout may take before it calls the turn unbounded.
 *
 * Measured rather than guessed: over 30 preset self-play games the acting player
 * takes a median of **2** discretionary actions per turn, mean 2.53, max **11**.
 * 32 is ~3x the observed worst case, so hitting it means something is generating
 * actions rather than consuming resources.
 *
 * Exhaustion THROWS, and that is deliberate rather than harsh. A silent
 * truncation reads as full lookahead — the exact complaint `MAX_GROUPED_MOVERS`
 * documents about its own boundary, and the failure mode
 * `settleDeferredResolution` was changed to stop having. If a real card ever
 * makes a legitimately longer turn, this bound gets raised on the evidence, the
 * way the settle's has been twice.
 */
const MAX_ROLLOUT_ACTIONS = 32;

/**
 * How many candidates get a full rollout when the fan-out is wide.
 *
 * **A beam, and it is here because the tail was measured rather than feared.**
 * Over 1271 real decisions, the rollout's median cost is 0.55 ms and its p95 is
 * 34 ms — both invisible behind `AI_MOVE_DELAY_MS`. But **4 decisions (0.3%),
 * every one of them with 41-80 candidates, took 22.4% of the total time**, and
 * the worst was **954 ms**. `chooseAction` runs synchronously on the browser's UI
 * thread, so that is a frozen tab rather than a slow spinner. Below 21 candidates
 * nothing exceeded 144 ms; below 11, nothing exceeded 76 ms.
 *
 * The cost is `candidates × rollout`, so the fan-out is the dial — the same
 * conclusion `walkout`'s note in CLAUDE.md reaches about its own sensitivity, and
 * the same one `MAX_GROUPED_MOVERS` exists for. 144.3's simultaneous move is what
 * makes a 65-candidate turn-4 decision possible at all.
 *
 * **A beam and not a time budget, and that distinction is load-bearing.** Every
 * probe here depends on `chooseAction` being a pure function of `(state,
 * weights)`, and `walkout` is pinned deterministic. Anything that consulted a
 * clock would make the AI's play depend on how busy the machine was, which
 * would quietly destroy every pinned figure in this repo rather than move it.
 *
 * The 1-ply score picks the beam, so this is a search truncation rather than a
 * different policy: the discarded candidates were evaluated, just not deeply.
 * `rolloutBeamTruncated` exports the boundary for the same reason
 * `groupedMoveTruncated` does — a truncation nobody can see reads as full
 * lookahead, so a test asserts it from both sides.
 */
const ROLLOUT_BEAM = 8;

/** Whether a fan-out this wide gets beamed rather than rolled out in full — the
 *  boundary `ROLLOUT_BEAM` draws, exported so a test can pin both sides of it. */
export function rolloutBeamTruncated(candidateCount: number): boolean {
  return candidateCount > ROLLOUT_BEAM;
}

/**
 * Plays out the REST OF THE ACTING PLAYER'S OWN TURN, then ends it, and hands
 * back the state to be scored.
 *
 * Off by default (`EvalWeights.ownTurnRollout`). With it off this returns its
 * argument, so the horizon stays exactly where it has always been.
 *
 * # Why it ends the turn rather than stopping just before
 *
 * "Play until you would end the turn, then evaluate" was the obvious shape and
 * it is wrong here, which was measured before this was written. `runEnd` expires
 * `mightThisTurn`, kills every [Temporary] permanent and empties floating
 * resources; `runStartOfTurn` then gives the OPPONENT their Awaken, their own
 * Temporary kill, their **hold scoring** and their draw. A rollout that stopped
 * one step short would count this-turn Might and Temporary bodies that are about
 * to vanish, and price the opponent's incoming points at zero — it would reward
 * accumulating precisely what the next step deletes.
 *
 * The measurement behind that: over 30 preset games the AI passed 385 times, and
 * in 136 of them the opponent scored on the turn that followed — 155 points,
 * every one of them invisible. `EvalWeights.passEndsTurn` fixed that for the
 * Pass candidate alone and measured NEUTRAL on both bases (49.25% presets, 47.92%
 * VEN), because correcting one side of a comparison is not half a correction: it
 * made Pass carry a cost every alternative still hid, and the AI answered by
 * doing anything at all instead of passing (`RecallUnit` 454 against 7). Here the
 * turn end lands on EVERY candidate, which is the whole difference.
 *
 * # One playout, not a tree
 *
 * Cost is linear in actions-remaining-this-turn, not exponential. This is not
 * minimax and must not become minimax.
 *
 * The rollout re-enters `bestActionFor` with the flag CLEARED, which is both the
 * depth guard and an honest compromise worth naming: the plan for this asked for
 * "the same policy for the rollout as for the real decision", and a policy that
 * recursed into itself would not terminate. So the inner policy is the 1-ply
 * settle-and-score the AI shipped before this flag existed — the same shape of
 * concession `twoPly` makes when it settles the opponent's reply with
 * `opponentReplies: false`.
 *
 * The opponent is assumed to PASS throughout, per the same plan. That is
 * optimistic in the way `twoPly: false` is already optimistic, and it is the
 * axis `twoPly` exists to change; stacking both is a separate measurement.
 *
 * # One thing to know before combining this with `twoPly`
 *
 * Ending the turn runs `runDraw` for the OPPONENT, so the rollout advances their
 * hand inside the lookahead. `maskHiddenCards` does not help: it masks facedown
 * cards at battlefields and nothing else, so this AI has always read the
 * opponent's hand and deck — pre-existing, not introduced here.
 *
 * It is inert today for two independent reasons: with `twoPly: false` the
 * modelled opponent never acts, and `evaluate` prices `cardInHand` at 0, so
 * WHICH card arrives cannot move the score. Both of those are things a future
 * change removes. `twoPly` + this flag would let the modelled opponent reply
 * with a card the AI cannot legally know it will draw, and Phase 3's feature
 * vector must be computed downstream of masking for exactly this reason. Measure
 * the combination on purpose rather than discovering it.
 */
function rolloutOwnTurn(state: GameState, forIndex: 0 | 1, weights: EvalWeights): GameState {
  if (!weights.ownTurnRollout) return state;
  // Nothing to roll out when this is not our turn — the AI acts on the
  // opponent's turn too, via [Reaction] casting and chain passes, and "the rest
  // of my own turn" is not a thing that exists there.
  if (state.activePlayerIndex !== forIndex) return state;

  // The depth guard. Also what makes the inner policy 1-ply; see the header.
  const inner: EvalWeights = { ...weights, ownTurnRollout: false };
  let current = state;
  let acted = 0;

  for (; acted <= MAX_ROLLOUT_ACTIONS; acted++) {
    // A game that ended inside the rollout is terminal — `runEnd` would throw on
    // it, and there is no next turn to price anyway.
    if (winner(current) !== null) return current;
    // Priority can sit with the opponent (a chain or a Showdown the settle left
    // open); the rollout only ever speaks for `forIndex`.
    if (current.activePlayerIndex !== forIndex || actingPlayerIndex(current) !== forIndex) break;

    const next = bestActionFor(current, forIndex, inner, false);
    // `Pass` IS the terminator: the rollout stops when the AI's own policy says
    // ending the turn beats anything else it could do. Read it as the decision it
    // is rather than special-casing a stopping heuristic — that keeps the rollout
    // consistent with the player it is modelling.
    if (next === undefined || next.type === "Pass") break;
    if (acted === MAX_ROLLOUT_ACTIONS) {
      throw new Error(
        `rolloutOwnTurn took ${MAX_ROLLOUT_ACTIONS} actions without the policy choosing to end the turn ` +
          `(turn ${current.turnNumber}, player ${forIndex}, next=${next.type}). ` +
          `Observed worst case when this bound was set was 11; either a card generates actions ` +
          `faster than it consumes resources, or MAX_ROLLOUT_ACTIONS is now too low — decide which before raising it.`,
      );
    }
    current = settleDeferredResolution(applyAction(current, next, inner), inner, forIndex, false);
  }

  // Ending the turn is the point of the whole exercise, so refusing to do it
  // silently would be the worst outcome here. These are `validatePass`'s own
  // preconditions, and the settle above is what establishes them; if they do not
  // hold, the turn genuinely cannot be ended from this state and the pre-end
  // board is the honest answer.
  if (current.activePlayerIndex !== forIndex || current.phase !== "Action" || current.turnState !== "Neutral" || !current.chainOpen) {
    return current;
  }
  // `runCleanup` around it, exactly as `submit`'s `withCleanupAndWinnerCheck`
  // does — and then settle again, because `runEnd` and `runStartOfTurn` HOLD
  // triggers (endOfTurn, the next player's beginningPhase) that the Cleanup
  // finalizes onto the chain. Scoring without draining it would evaluate a board
  // where those never happened, silently.
  return settleDeferredResolution(runCleanup(runStartOfTurn(runEnd(current))), inner, forIndex, false);
}

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
  const candidates = candidateActions(state, weights);
  if (candidates.length === 0) return undefined;

  // The shipping path, unchanged and deliberately kept as its own loop rather
  // than folded into the one below. Every pinned figure in CLAUDE.md was
  // measured through exactly these lines, including `walkout`'s deterministic
  // 190/113/29, and the rollout path allocates a settled state per candidate
  // that this one has no reason to hold on to.
  if (!weights.ownTurnRollout) {
    let best: PlayerAction | undefined;
    let bestScore = -Infinity;
    for (const action of candidates) {
      // Every candidate is scored on its SETTLED outcome — see
      // settleDeferredResolution for why scoring the immediate state made the AI
      // structurally unable to attack a contested battlefield or cast a Spell.
      // Only the scoring looks ahead; the action actually returned is still the
      // single candidate, so the real game still resolves through the real
      // PassFocus actions (and, in the UI, at the AI's own pacing).
      const settled = settleDeferredResolution(applyAction(state, action, weights), weights, forIndex, opponentReplies);
      const score = evaluate(settled, forIndex, weights);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }
    return best;
  }

  // The 1-ply pass, which is the loop above with its settled states KEPT. The
  // beam is chosen from these scores and the rollouts start from these states,
  // so widening the search costs no extra settles — only the rollouts.
  const scored = candidates.map((action, index) => {
    const settled = settleDeferredResolution(applyAction(state, action, weights), weights, forIndex, opponentReplies);
    return { action, settled, index, score: evaluate(settled, forIndex, weights) };
  });

  // Sorted by 1-ply score, cut to the beam, then put BACK in enumeration order.
  // The restore is not tidiness: the loop below breaks ties with a strict `>`,
  // so iteration order decides them, and `legalActions` pushes Pass first. Doing
  // this in score order would silently change which action wins a tie — a policy
  // change disguised as a performance change, and the hardest kind to attribute
  // later.
  const beam = rolloutBeamTruncated(scored.length)
    ? [...scored].sort((a, b) => b.score - a.score).slice(0, ROLLOUT_BEAM).sort((a, b) => a.index - b.index)
    : scored;

  let best: PlayerAction | undefined;
  let bestScore = -Infinity;
  for (const entry of beam) {
    const score = evaluate(rolloutOwnTurn(entry.settled, forIndex, weights), forIndex, weights);
    if (score > bestScore) {
      bestScore = score;
      best = entry.action;
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
