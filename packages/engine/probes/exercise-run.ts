/**
 * One self-play run — a deck set, N games, and the `ExerciseLog` they produced.
 *
 * # Why this is a module and not a second copy of the loop
 *
 * `exercised.ts` owned this loop, and `reachability.ts` needs the SAME loop over
 * four different deck sets. Copying it is the failure `CLAUDE.md` names first:
 * five docs each wrote their own copy of the verification loop, they drifted, and
 * the copy in front of the session beat the correct one. A probe loop is worse
 * than a doc, because a drifted copy still reports a plausible number.
 *
 * So the loop, the deck selection and the INSTRUMENT CONTROLS all live here and
 * both probes call them. `exercised.ts` reports one run; `reachability.ts`
 * reports the union of several. Neither owns the measurement.
 *
 * # Everything the header of `exercised.ts` says about counting still applies
 *
 * `record` reads the action that was SUBMITTED and `scanChain` reads only the
 * state `submit` returned — nothing here observes a resolver, because the
 * heuristic AI's lookahead applies every candidate action through the real
 * executors to score it, and a probe that wrapped one once reported a card
 * "played 259 times" when the true answer was zero.
 */
import { chooseAction, generateCoveringDecks, submit, activatedAbilityFor } from "@rift-engine/engine";
import type { CardRegistry, GameState } from "@rift-engine/engine";
import { at, legacyBattlefields, PRESET_DECKS, startedGame, type DeckList } from "./harness.ts";
import { ExerciseLog } from "./exercise-log.ts";

/** A game that has taken this many actions is not going to end; the run moves on
 *  rather than hanging. `ai-health` is the probe that gates on termination. */
const ACTION_CAP = 3000;

/** The mode name for the seven pinned preset decks, i.e. no `DECKS=`. */
export const PRESETS = "presets";

export interface ExerciseRun {
  /** `PRESETS`, or the set code of a covering run. */
  readonly mode: string;
  readonly games: number;
  readonly log: ExerciseLog;
  /** Every defId these decks could put in front of a player. Legend and champion
   *  included: they never appear in `cardIds` but are absolutely in play. */
  readonly inDecks: Set<string>;
  /**
   * The Legends and champions of these decks — the cards that begin the game ON
   * THE BOARD (`player-setup` pulls one copy of the champion into `championZone`).
   *
   * They are never drawn and never offered, by construction, so they must not be
   * read as either an enumeration gap or a sampling miss. Their only signals are
   * an activated ability or a trigger.
   */
  readonly startsInPlay: Set<string>;
  readonly decksUsed: Set<string>;
  /** Actions the engine REFUSED after the AI chose them. Expected to be zero —
   *  it is the offered-then-refused detector, a bug family this repo has shipped
   *  more than once. */
  readonly invalid: number;
  readonly gamesRun: number;
  /** Present only for a covering run. */
  readonly generated?: { readonly decks: number; readonly covered: number; readonly orphans: readonly string[] };
}

/**
 * The decks for a mode. `undefined` is the seven presets.
 *
 * A covering mode swaps them for one GENERATED deck per Legend of that set, with
 * every implemented card of the set deliberately seated. Opt-in rather than the
 * default, and the presets are untouched, because four other probes read
 * `PRESET_DECKS` and three of them pin recorded figures (walkout's 191/107/32,
 * chain-depth's Sett decks).
 *
 * Unbuildable decks THROW rather than being skipped: a covering run that quietly
 * covers less than it claims is the `make-buffdeck.mjs` defect — an instrument
 * reporting its input as its output.
 */
export function decksFor(
  deckSet: string | undefined,
  registry: CardRegistry,
): { decks: readonly DeckList[]; generated?: ExerciseRun["generated"] } {
  if (deckSet === undefined) return { decks: PRESET_DECKS };
  const setCode = deckSet.toUpperCase();
  const covering = generateCoveringDecks(setCode, registry);
  if (covering.unbuildable.length > 0) {
    throw new Error(`DECKS=${setCode}: ${covering.unbuildable.length} unbuildable — ${covering.unbuildable.join("; ")}`);
  }
  if (covering.decks.length === 0) throw new Error(`DECKS=${setCode}: no Legend in that set`);
  return {
    decks: covering.decks.map((d) => d.deck),
    generated: { decks: covering.decks.length, covered: covering.covered, orphans: covering.orphans },
  };
}

/**
 * `games` self-play games, paired and seeded exactly as `exercised.ts` has always
 * paired and seeded them, so a figure measured before this module still compares.
 *
 * Battlefields are PINNED (`legacyBattlefields`), per README.md: rolling them per
 * match makes successive runs incomparable — `walkout` once reported 236 walkouts
 * instead of the recorded 154 from that alone.
 */
export function runExercise(
  deckSet: string | undefined,
  games: number,
  registry: CardRegistry,
  /**
   * Called with every state the AI was about to act on, for a probe that needs to
   * ask its OWN question of the same games (see `why-not-offered.ts`). Kept
   * optional and inert by default so the recorded figures cannot move.
   *
   * The GAME index is passed too, and it is not a convenience: a card sits in a
   * hand across every action of a turn, so counting states badly overstates how
   * many independent situations were sampled. An observer that wants to say "this
   * was never affordable" needs to know whether that was 40 games or 2.
   */
  onStep?: (before: GameState, game: number) => void,
): ExerciseRun {
  const { decks: DECKS, generated } = decksFor(deckSet, registry);
  const log = new ExerciseLog();
  const inDecks = new Set<string>();
  const startsInPlay = new Set<string>();
  const decksUsed = new Set<string>();
  let invalid = 0;
  let gamesRun = 0;

  for (let seed = 1; seed <= games; seed++) {
    const deckA = at(DECKS, seed);
    const deckB = at(DECKS, seed + 1);
    for (const deck of [deckA, deckB]) {
      decksUsed.add(deck.name);
      inDecks.add(deck.legendId);
      inDecks.add(deck.championId);
      startsInPlay.add(deck.legendId);
      startsInPlay.add(deck.championId);
      for (const id of deck.cardIds) inDecks.add(id);
      for (const id of deck.sideboardCardIds) inDecks.add(id);
    }

    let state = startedGame(deckA, deckB, seed, { battlefields: legacyBattlefields() });
    gamesRun++;

    for (let taken = 0; taken < ACTION_CAP; taken++) {
      const action = chooseAction(state);
      const before = state;
      const res = submit(state, action);
      if (res.result.type === "Invalid") {
        invalid++;
        break;
      }
      log.scanOffers(before);
      log.scanHands(before);
      onStep?.(before, seed);
      log.record(before, action);
      state = res.state;
      log.scanChain(state);
      if (res.result.type === "GameOver") break;
    }
  }

  return {
    mode: deckSet?.toUpperCase() ?? PRESETS,
    games,
    log,
    inDecks,
    startsInPlay,
    decksUsed,
    invalid,
    gamesRun,
    ...(generated ? { generated } : {}),
  };
}

export interface RunControls {
  readonly playedSeen: boolean;
  readonly activatedSeen: boolean;
  readonly triggeredSeen: boolean;
  /** Cards reached a hand at all. Zero would mean `scanHands` is looking in the
   *  wrong place and every "never drawn" verdict below it is manufactured. */
  readonly drawnSeen: boolean;
  readonly activationsResolve: boolean;
  readonly gamesRan: boolean;
  readonly takenWasOffered: boolean;
  readonly noInvalid: boolean;
  /** Reported beside `activatedSeen` because that control passes VACUOUSLY when
   *  this is 0, and a bare `true` cannot be told from "activations really
   *  happened". A `DECKS=SFD` run reads 0 here, and should. */
  readonly activatableInDecks: number;
}

/**
 * Whether the OBSERVER worked, for one run. Nothing here is a coverage threshold
 * — any threshold would be a number picked to pass.
 *
 * `activatedSeen` is conditioned on the decks containing something the AI would
 * ever activate. `DECKS=SFD` found that the hard way: 40 games, zero activations,
 * gate red — and correctly so, because the only activatable SFD card is the Gold
 * token, whose ability is flagged `banksResource` and is therefore dropped from
 * the AI's candidate pool ON PURPOSE (`evaluate` scores board state, so a banked
 * resource can only tie with Pass). There was nothing to activate and nothing
 * wrong, so the premise is checked instead of the gate being weakened.
 */
export function runControls(run: ExerciseRun): RunControls {
  const activatableInDecks = [...run.inDecks].filter((id) => {
    const ability = activatedAbilityFor(id);
    return ability !== undefined && ability.banksResource !== true;
  }).length;
  return {
    playedSeen: run.log.played.size > 0,
    activatedSeen: activatableInDecks === 0 || run.log.activated.size > 0,
    triggeredSeen: run.log.triggered.size > 0,
    drawnSeen: run.log.drawn.size > 0,
    activationsResolve: run.log.activationsUnresolved === 0,
    gamesRan: run.gamesRun === run.games,
    /** **Everything the AI played was something `legalActions` offered.** The one
     *  real invariant a self-play probe can assert rather than merely report, and
     *  the failure it catches is the offered-then-refused family that has now
     *  bitten this repo three times. */
    takenWasOffered: [...run.log.played.keys(), ...run.log.activated.keys()].every((id) => run.log.offered.has(id)),
    noInvalid: run.invalid === 0,
    activatableInDecks,
  };
}
