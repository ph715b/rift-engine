import type { GameState, PendingDecision } from "../model/game-state.js";
import { isSpellChainEntry } from "../model/game-state.js";
import type { RunePayment } from "../actions/player-action.js";
import { domainDecisions, mergeRegistries } from "./effects/index.js";
import { equipmentDecisions, weaponmasterDecisions } from "./equipment.js";
import { legendDecisions } from "./legend-abilities.js";
import { battlefieldDecisions } from "./battlefield-abilities.js";
import { freePlayDecisions } from "./free-play.js";
import { discardCards, drawCards } from "./effect-helpers.js";
// A CYCLE, and the same safe shape as the others in this module: triggers.ts
// imports `parkDecision` from here, and both bindings are read only at runtime
// inside a resolver, never at module initialisation.
import { holdEventTrigger, tokenDecisions } from "./triggers.js";

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
/** The kind of the trigger-ordering question, written once because
 *  `cleanup.finalizePendingTriggers` parks it and this file answers it. */
export const ORDER_TRIGGERS = "order-triggers";

const GENERIC: Record<string, DecisionDefinition> = {
  /**
   * **383.3.d — "If more than one Triggered Ability is Triggered simultaneously,
   * then the player that controls the Abilities selects the order to place them
   * on the Chain."**
   *
   * Reported from playtesting: "triggers that happen at the same time should be
   * able to be stacked in whichever way the user wants. as an example if you have
   * two triggers that happen on conquer. You should be able to decide which one
   * happens first." That is the rule, and the engine placed them in
   * listener-walk order instead.
   *
   * **The APNAP half was already right** and is not touched here:
   * `finalizePendingTriggers`' own comment records that the pen is appended in
   * turn order, which under LIFO resolution (340.1) gives 383.3.d.1's "starting
   * with the Turn Player and proceeding in Turn Order, each player orders their
   * Triggered Abilities". What was missing is the choice WITHIN one player's
   * group.
   *
   * # The question is "which resolves FIRST", not "which is placed first"
   *
   * The chain is LIFO, so the item placed LAST resolves FIRST. Asking in
   * placement order would be asking the player to think backwards about their own
   * board. So an answer moves the chosen item to the LAST of the slots still
   * being ordered, and the question repeats over the rest — the same
   * `count`-free, shrink-the-subject shape the `discard` handler below uses,
   * with the subject in `chainSlots`.
   *
   * # Only the player's OWN slots move
   *
   * The permutation is confined to the slots this group already occupies, so the
   * other player's items keep their positions and 383.3.d.1's between-player
   * order survives. That also keeps `chainPriority` correct without recomputing
   * it: the topmost item may change identity but never changes CONTROLLER.
   */
  [ORDER_TRIGGERS]: {
    prompt: () => "Two of your abilities triggered at once — which resolves FIRST?",
    options: (state, d) =>
      (d.chainSlots ?? []).map((slot) => {
        const entry = state.spellChain[slot];
        const name = entry !== undefined && !isSpellChainEntry(entry) ? entry.listenerName : "an ability";
        return { id: String(slot), label: name };
      }),
    resolve: (state, d, optionId) => {
      const slots = d.chainSlots ?? [];
      const chosen = Number(optionId);
      if (slots.length < 2 || !slots.includes(chosen)) return state;

      // The chosen item takes the LAST slot (it resolves first); the rest keep
      // their relative order in the slots before it. Read the entries out, then
      // write them back into the same positions — the group never grows, moves or
      // interleaves with anyone else's.
      const others = slots.filter((slot) => slot !== chosen).map((slot) => state.spellChain[slot]!);
      const reordered = [...others, state.spellChain[chosen]!];
      const spellChain = [...state.spellChain];
      slots.forEach((slot, i) => {
        spellChain[slot] = reordered[i]!;
      });

      // That last slot is settled now. Ask again only while a real choice is left.
      const remaining = slots.slice(0, -1);
      const next: GameState = { ...state, spellChain };
      return remaining.length >= 2 ? repeatDecision(next, { ...d, chainSlots: remaining }) : next;
    },
  },
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
      // suppressEvent: this handler takes ONE card per answer, but the player
      // was given one instruction. Jinx - Rebel's "when you discard one or more
      // cards" pays out once for it, so the event waits for the last card —
      // firing per answer would ready her twice for a "discard 2".
      const discarded = discardCards(state, d.playerIndex, 1, [optionId], { suppressEvent: true });
      const remaining = (d.count ?? 1) - 1;
      if (remaining > 0) return repeatDecision(discarded, { ...d, count: remaining });
      // HELD (383), like the funnel's own site. The suppression above is what
      // makes one instruction one Pending Item however many answers it took —
      // holding per answer would put Jinx - Rebel on the chain twice.
      return holdEventTrigger(discarded, { kind: "cardsDiscarded", discarderIndex: d.playerIndex });
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
    // The shared placement step for a unit played free — owned by no card, so it
    // sits beside the generic questions rather than in a per-domain file.
    { name: "engine/free-play.ts", entries: freePlayDecisions },
    // `[Quick-Draw]`'s attach. Owned by the KEYWORD rather than by any card —
    // four Gear print it and Jax - Unmatched grants it to every Equipment its
    // controller has — so a per-domain file would be the wrong home twice over.
    { name: "engine/equipment.ts", entries: equipmentDecisions },
    { name: "engine/equipment.ts (weaponmaster)", entries: weaponmasterDecisions },
    // Legends' questions live with their abilities rather than in a per-domain
    // file — every Legend is dual-domain, so filing one by domain is meaningless
    // (see legend-abilities.ts's own note).
    { name: "engine/legend-abilities.ts", entries: legendDecisions },
    // Battlefields' questions, for the same reason the Legends' are here: every
    // printed Battlefield is Colorless, so filing one in a per-domain file would
    // be filing it nowhere.
    { name: "engine/battlefield-abilities.ts", entries: battlefieldDecisions },
    // A TOKEN's own printed question — the Shadow Clone's. Beside the Legends'
    // and the battlefields' for the same reason: a token has no domain, so a
    // per-domain file would be filing it nowhere, and its two MAKERS are in two
    // different files besides.
    { name: "engine/triggers.ts (tokens)", entries: tokenDecisions },
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

/**
 * The handler for a question's `kind`, or a THROW.
 *
 * An unregistered kind is a bug in card registration, not a game state. It used
 * to be tolerated in three different ways — `advanceDecisions` dropped the
 * question, `optionsFor` returned `[]` and `promptFor` returned `""` — and each
 * of those is silent: the card parks its question, nothing happens, it costs its
 * runes and goes to the trash, and `coverage.ts` still calls it IMPLEMENTED,
 * because it sees the card registered in this file's own map and cannot tell
 * that the seed names a key the map lacks.
 *
 * The old defence was "an unregistered kind cannot be answered by anyone, so
 * dropping it is the only option that doesn't deadlock the game" — true about
 * the runtime and wrong about the consequence. `resolvePendingTrigger` was
 * changed from exactly that shape to a throw, for exactly this reason: a silent
 * no-op is how all 7 legend hooks would have vanished with no failing test.
 *
 * What this must NOT do is collapse the other case. A REGISTERED definition
 * returning no options is legitimate — "discard 1" with an empty hand has
 * genuinely become moot — and `advanceDecisions` still drops that one. The
 * distinction is between having no handler and having nothing to ask.
 */
function definitionFor(decision: PendingDecision): DecisionDefinition {
  const definition = allDecisions()[decision.kind];
  if (!definition) {
    throw new Error(
      `No decision registered for kind "${decision.kind}" (id ${decision.id}). ` +
        `A card parked a question nothing can answer — register it in the owning ` +
        `per-domain effect file, or in GENERIC if it belongs to no card.`,
    );
  }
  return definition;
}

/** The question at the front of the queue, or undefined when the game is
 *  settled. Everything that asks "is the game paused?" asks this. */
export function pendingDecision(state: GameState): PendingDecision | undefined {
  return state.pendingDecisions[0];
}

/** The answers to the front question, for legal-actions and the board.
 *  An empty list here means the question has become moot, and ONLY that —
 *  `definitionFor` throws rather than returning nothing for a kind it does not
 *  know, so the two can no longer be confused. */
export function optionsFor(state: GameState, decision: PendingDecision): DecisionOption[] {
  return definitionFor(decision).options(state, decision);
}

export function promptFor(state: GameState, decision: PendingDecision): string {
  return definitionFor(decision).prompt(state, decision);
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
    // Throws on an unregistered kind rather than dropping the question — see
    // `definitionFor`. Dropping it was the silent path: the card did nothing and
    // still reported implemented.
    const definition = definitionFor(head);
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
export function repeatDecision(state: GameState, seed: DecisionSeed): GameState {
  const decision: PendingDecision = { ...seed, id: nextDecisionId() };
  return { ...state, pendingDecisions: [decision, ...state.pendingDecisions] };
}

/**
 * Applies an answer to the front question. Returns undefined when the answer
 * doesn't apply — a stale decision id, or an option that isn't on offer — so the
 * validator and the executor agree on what "legal" means without repeating the
 * check.
 *
 * An unregistered KIND is not one of those cases and no longer returns undefined
 * here: it is a bug rather than an inapplicable answer, and `definitionFor`
 * throws. Reporting it as "that answer doesn't apply" is what let a card park an
 * unanswerable question and read as merely un-answered.
 */
export function answerDecision(state: GameState, decisionId: string, optionId: string): GameState | undefined {
  const head = pendingDecision(state);
  if (!head || head.id !== decisionId) return undefined;
  const definition = definitionFor(head);
  if (!definition.options(state, head).some((o) => o.id === optionId)) return undefined;

  const popped = { ...state, pendingDecisions: state.pendingDecisions.slice(1) };
  return advanceDecisions(definition.resolve(popped, head, optionId));
}
