import type { GameState, PendingDecision } from "../model/game-state.js";
import type { RunePayment } from "../actions/player-action.js";
import { domainDecisions, mergeRegistries } from "./effects/index.js";
import { discardCards, drawCards } from "./effect-helpers.js";

/**
 * The engine stopping to ask a player a question, and carrying on with the
 * answer.
 *
 * Everywhere else, a choice is decided BEFORE an action is submitted and fanned
 * out as candidates by legal-actions.ts. That needs an action to hang the choice
 * on, and a trigger has none — "when you discard me, you may pay [Fury] to play
 * me" has no play to attach to, and "each player kills one of their units" has
 * to ask the opponent. This is the mechanism for both.
 *
 * ONE mechanism, deliberately. The Java oracle grew five parallel ones
 * (pendingChoicePlayer, pendingDiscardChoice, pendingRepeatChoice with three
 * companion fields, pendingVayneBounceChoice, pendingTrashSpellChoice), each
 * with its own action type, its own validator branch, its own AI branch and its
 * own line in a five-way if-chain answering "who acts now". Every one of those
 * is a place the next question has to be taught about separately.
 *
 * The resume is DATA, not a closure. The oracle resumes through
 * `beginDiscard(player, count, () -> ...)`, which cannot work here: states are
 * immutable snapshots the AI clones and rescores, and a lambda does not survive
 * that. A `kind` naming a registry entry does.
 */

/** One answer a player may give. */
export interface DecisionOption {
  /** Named by the answering action. Stable for a given state. */
  id: string;
  /** What the button says. */
  label: string;
  /**
   * The card or unit this option is ABOUT, when there is one, so the board can
   * highlight the thing instead of listing prose. The oracle added its
   * equivalent (`pendingChoiceCards`) later as an explicit "playtesting fix",
   * once text-only options turned out to be unusable for "pick one of your
   * units" — worth having from the start rather than rediscovering.
   */
  instanceId?: string;
  /** What answering costs, for the options that cost runes (Flame Chompers,
   *  Mistfall). Computed when the options are built, so an option that cannot
   *  be paid is simply never offered. */
  payment?: RunePayment;
}

export interface DecisionDefinition {
  /** The question, in the words the card uses. Shown to the human. */
  prompt: (state: GameState, decision: PendingDecision) => string;
  /**
   * The answers available RIGHT NOW. Rebuilt from live state rather than stored
   * on the decision, so a question queued behind another can never offer a unit
   * the earlier answer has since killed.
   *
   * Returning one option means no question worth asking — see `advanceDecisions`.
   * Returning none means the question has become moot.
   */
  options: (state: GameState, decision: PendingDecision) => DecisionOption[];
  resolve: (state: GameState, decision: PendingDecision, optionId: string) => GameState;
}

/** A decision before it has an id — what callers hand to `parkDecision`. */
export type DecisionSeed = Omit<PendingDecision, "id">;

/** Deterministic, like createCardInstance's — ids only need to be unique within
 *  a game, and the AI's cloned lookahead states are independent anyway. */
let decisionCounter = 0;
function nextDecisionId(): string {
  decisionCounter += 1;
  return `decision-${decisionCounter}`;
}

/** Generic questions with no owning card. Card-specific ones live in the
 *  per-domain effect files under the same one-file-one-owner rule. */
const GENERIC: Record<string, DecisionDefinition> = {
  /**
   * "Discard N" where the discarding player picks — rule 422's discard, with the
   * choice the rules always gave them. `count` is how many are still owed, so
   * answering takes one card and leaves the question at the FRONT of the queue
   * with one fewer.
   */
  discard: {
    prompt: (state, d) => `Discard ${d.count ?? 1} card${(d.count ?? 1) === 1 ? "" : "s"}`,
    options: (state, d) =>
      state.players[d.playerIndex].hand.map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const discarded = discardCards(state, d.playerIndex, 1, [optionId]);
      const remaining = (d.count ?? 1) - 1;
      return remaining > 0 ? repeatDecision(discarded, { ...d, count: remaining }) : discarded;
    },
  },

  /**
   * Draw N — never a real question (one option, so it is executed the instant it
   * reaches the front and is never shown to anyone).
   *
   * It exists because ORDER matters. Undercover Agent's Deathknell is "discard 2,
   * THEN draw 2", and the "then" is load-bearing: a card just drawn must never be
   * one of the cards discarded. Once the discard stops to ask, the draw can no
   * longer just be the outer call in `drawCards(discardCards(...))` — it has to
   * be queued behind the questions. Being a decision with a single option is what
   * lets that work without inventing a second kind of queued work.
   */
  draw: {
    prompt: (state, d) => `Draw ${d.count ?? 1}`,
    options: () => [{ id: "draw", label: "Draw" }],
    resolve: (state, d) => drawCards(state, d.playerIndex, d.count ?? 1),
  },
};

let composed: Record<string, DecisionDefinition> | null = null;

/** Lazy, like the trigger registries — these files import each other and
 *  composing at module load would depend on evaluation order. */
function allDecisions(): Record<string, DecisionDefinition> {
  composed ??= mergeRegistries<DecisionDefinition>("decision", [
    { name: "engine/decisions.ts", entries: GENERIC },
    ...domainDecisions(),
  ]);
  return composed;
}

/**
 * For coverage.ts — the cards whose implementation IS (partly) a decision.
 *
 * Keys are `<defId>-<what it asks>` rather than a bare defId, because one card
 * can ask more than one kind of question, so the leading defId is peeled back
 * off here. That prefix convention is not decoration: it is what keeps the
 * one-file-one-owner rule meaningful for decisions and what lets coverage see
 * Cull the Weak as implemented at all.
 */
export function decisionDefIds(): string[] {
  return domainDecisions().flatMap((s) =>
    Object.keys(s.entries)
      .map((key) => /^([A-Z]+-\d+)-/.exec(key)?.[1])
      .filter((defId): defId is string => defId !== undefined),
  );
}

function definitionFor(decision: PendingDecision): DecisionDefinition | undefined {
  return allDecisions()[decision.kind];
}

/** The question at the front of the queue, or undefined when the game is
 *  settled. Everything that asks "is the game paused?" asks this. */
export function pendingDecision(state: GameState): PendingDecision | undefined {
  return state.pendingDecisions[0];
}

/** The answers to the front question, for legal-actions and the board. */
export function optionsFor(state: GameState, decision: PendingDecision): DecisionOption[] {
  return definitionFor(decision)?.options(state, decision) ?? [];
}

export function promptFor(state: GameState, decision: PendingDecision): string {
  return definitionFor(decision)?.prompt(state, decision) ?? "";
}

/** Safety net for a handler that re-parks its own question forever. Far above
 *  anything reachable — the deepest real case is "discard 2". */
const MAX_ADVANCE_STEPS = 64;

/**
 * Drains the front of the queue for as long as it needs no human input: a
 * question with no options at all has become moot and is dropped, and one with a
 * single option is not a question — it is executed.
 *
 * That second case is what keeps the board honest. "Discard 2" with exactly two
 * cards in hand is not a choice, and opening a modal to confirm it would be
 * theatre. It is also what lets a queued follow-up task (`draw`) exist without a
 * second mechanism.
 *
 * Only ever drains from the FRONT, so a one-option question queued behind a real
 * one still waits its turn — the order questions are asked in is the order they
 * were raised in.
 */
export function advanceDecisions(state: GameState): GameState {
  let current = state;
  for (let step = 0; step < MAX_ADVANCE_STEPS; step += 1) {
    const head = current.pendingDecisions[0];
    if (!head) return current;
    const definition = definitionFor(head);
    // An unregistered kind cannot be answered by anyone, so dropping it is the
    // only option that doesn't deadlock the game.
    if (!definition) {
      current = { ...current, pendingDecisions: current.pendingDecisions.slice(1) };
      continue;
    }
    const options = definition.options(current, head);
    if (options.length > 1) return current;
    const popped = { ...current, pendingDecisions: current.pendingDecisions.slice(1) };
    current = options.length === 1 ? definition.resolve(popped, head, options[0]!.id) : popped;
  }
  throw new Error("advanceDecisions did not settle — a decision handler is re-parking itself without end");
}

/**
 * Raises a new question, and settles whatever no longer needs asking.
 *
 * Pushed onto the BACK: anything already queued was raised earlier and must be
 * answered earlier. That is what makes Cull the Weak's two questions come out in
 * APNAP order from nothing more than the order it parks them.
 */
export function parkDecision(state: GameState, seed: DecisionSeed): GameState {
  const decision: PendingDecision = { ...seed, id: nextDecisionId() };
  return advanceDecisions({ ...state, pendingDecisions: [...state.pendingDecisions, decision] });
}

/**
 * Asks the SAME question again, one step further along ("discard 2" after the
 * first card).
 *
 * Onto the front, not the back: a continuation of the question being answered is
 * not a new question, and anything queued behind it was raised later. Sending it
 * to the back would let a follow-up task (draw 2) run between the two halves of
 * a single discard, which is exactly the ordering the follow-up exists to
 * protect.
 */
function repeatDecision(state: GameState, seed: DecisionSeed): GameState {
  const decision: PendingDecision = { ...seed, id: nextDecisionId() };
  return { ...state, pendingDecisions: [decision, ...state.pendingDecisions] };
}

/**
 * Applies an answer to the front question. Returns undefined when the answer
 * doesn't apply — a stale decision id, or an option that isn't on offer — so the
 * validator and the executor agree on what "legal" means without repeating the
 * check.
 */
export function answerDecision(state: GameState, decisionId: string, optionId: string): GameState | undefined {
  const head = pendingDecision(state);
  if (!head || head.id !== decisionId) return undefined;
  const definition = definitionFor(head);
  if (!definition) return undefined;
  if (!definition.options(state, head).some((o) => o.id === optionId)) return undefined;

  const popped = { ...state, pendingDecisions: state.pendingDecisions.slice(1) };
  return advanceDecisions(definition.resolve(popped, head, optionId));
}
