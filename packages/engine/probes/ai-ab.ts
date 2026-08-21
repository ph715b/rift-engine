/**
 * **Candidate AI weights against the shipping ones, head to head.** The only
 * defensible way to add or change anything in `EvalWeights`.
 *
 *     npm run build --workspace=@rift-engine/engine
 *     node packages/engine/probes/ai-ab.ts                      # CALIBRATION — run this first
 *     node packages/engine/probes/ai-ab.ts cardInHand=2
 *     node packages/engine/probes/ai-ab.ts twoPly=true --games=1200 --decks=ven
 *
 * # Why this is a probe and not a scratchpad script again
 *
 * This is the THIRD time this harness has existed. It was `scratchpad/ai-ab.mjs`
 * twice (rebuilt 2026-08-01 after the first one was lost) and both times it went
 * with the session that wrote it — while every number it produced stayed quoted,
 * as settled fact, in the doc comments of `EvalWeights` and `BASELINE_WEIGHTS`.
 * A codebase whose standing rule is "no speculative heuristic without a real
 * evaluative basis" had its entire evaluative basis in a deleted temp file.
 *
 * So: here, typed, and inside `tsconfig.typecheck.json`, for exactly the reasons
 * `harness.ts` gives at length for the other probes. The specific failure that
 * argument is about has already happened to a hand-built `GameState` in
 * `ai-health`, and this file builds none of its own — it goes through
 * `harness.startedGame` and `exercise-run.decksFor` like everything else.
 *
 * # The measurement
 *
 * One PAIR of games per seed, on the same decks and the same battlefields, with
 * the policies swapped between seats:
 *
 *   game A   seat 0 = candidate,  seat 1 = baseline
 *   game B   seat 0 = baseline,   seat 1 = candidate
 *
 * Seat and first-player advantage therefore cancel by CONSTRUCTION rather than
 * by averaging — which is what makes the calibration below exact rather than
 * merely close. `firstPlayerIndex` is 0 in both halves, so the candidate goes
 * first in exactly half of the games and second in the other half.
 *
 * # Calibration is not optional, and it is the default
 *
 * With no candidate weights, this runs BASELINE against BASELINE. The two halves
 * of a pair are then the same game with the labels swapped, so the win rate must
 * be **exactly 50.0%** — not 49.8%, not "within noise". That is the gate.
 *
 * It is the default mode because a harness that cannot produce 50.0% against
 * itself is measuring something other than the change, and the only way to find
 * that out is to look. Run it first, every time, and after any engine change
 * that lands between two candidate runs.
 *
 * # `key=value`, never JSON
 *
 * PowerShell strips the inner quotes out of `'{"cardInHand":2}'` and hands the
 * process `{cardInHand:2}`, which is not JSON — the old harness silently ran the
 * baseline against itself and reported a very convincing 50%. Bare `key=value`
 * pairs are weights; `--key=value` are run options. An unknown weight name is a
 * hard error naming every legal one, rather than being ignored.
 *
 * # Say which decks it ran on, or the result means nothing
 *
 * This is the single most expensive lesson this instrument has taught, and it
 * cost a shipped weight. `cardInHand: 0.5` was adopted on a 52.2% measured
 * across the seven preset decks — decks taken to zero inert cards early, so
 * every card added since lives outside them. By the time eight pure-draw cards
 * existed, the basis that settled the weight contained none of them. The number
 * stayed true and stopped being about anything; re-measured on decks built to
 * hold cantrips, `cardInHand: 0` won and shipped instead.
 *
 * So the basis is printed in the result line, not in a comment somewhere, and
 * `--decks=<set>` runs the generated covering decks for a set — the same decks
 * `reachability` uses, via the same `decksFor`, so "which cards were even in the
 * pool" has one answer across both instruments.
 *
 * # A tuning run is a liveness probe whether or not you meant it to be
 *
 * The last round made the AI spend cards faster, which reached two empty decks,
 * which the then-missing Burn Out (431) could not resolve — self-play sat at 7-7
 * and passed to turn 538. Nothing else had found it; `ai-health`'s 40/40 had
 * been walking straight past it. So `errors` and `hitCap` are GATED here even
 * though this is a measurement rather than a gate, and anything either of them
 * turns up invalidates the tuning it interrupted: fix it, rebuild, re-measure.
 */
import { actingPlayerIndex, BASELINE_WEIGHTS, chooseAction, defaultCardRegistry, submit } from "@rift-engine/engine";
import type { EvalWeights, GameState } from "@rift-engine/engine";
import { at, report, startedGame, type DeckList } from "./harness.ts";
import { decksFor, PRESETS } from "./exercise-run.ts";

/** Same cap as `ai-health` and `exercise-run`, and for the same reason: a game
 *  that has taken this many actions is not going to end. Unlike there, reaching
 *  it FAILS the run — see the liveness note in the header. */
const ACTION_CAP = 3000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The weight names and their kinds, both READ OFF `BASELINE_WEIGHTS` rather than
 * written out.
 *
 * Derived so that a new field on `EvalWeights` is A/B-able the moment it has a
 * baseline value, with nothing here to update — which matters, because the
 * alternative was tried and did not work. This started as a hand-written
 * `BOOLEAN_WEIGHTS = ["twoPly", "abilityValue"] as const satisfies readonly
 * (keyof EvalWeights)[]`, with a comment claiming a third flag would fail the
 * typecheck rather than parse `true` into `NaN`. It would not: `satisfies` checks
 * that the listed names are valid keys, never that the list is exhaustive. The
 * very next flag (`passEndsTurn`) typechecked clean against the stale list.
 *
 * `typeof` the baseline value cannot go stale the same way, because the thing it
 * reads IS the definition.
 */
const WEIGHT_NAMES = Object.keys(BASELINE_WEIGHTS) as (keyof EvalWeights)[];

function isBooleanWeight(name: keyof EvalWeights): boolean {
  return typeof BASELINE_WEIGHTS[name] === "boolean";
}

interface Options {
  readonly games: number;
  /** `PRESETS`, or a set code whose covering decks to use. */
  readonly decks: string;
  readonly firstSeed: number;
}

/**
 * One `name=value` weight, validated and written into `into`.
 *
 * Shared by the candidate and the `--baseline` side deliberately: the two must
 * agree about what a weight name is and what a flag accepts, or `--baseline`
 * becomes a second, laxer parser and the unknown-name guard only protects half
 * the run.
 */
function applyWeightArg(into: Partial<EvalWeights>, key: string, value: string, side: string): void {
  // The requirement that makes a run trustworthy: a typo'd weight name is a
  // STOP, not a silently-ignored argument that leaves the candidate identical
  // to the baseline and reports a perfectly plausible ~50%.
  if (!(WEIGHT_NAMES as string[]).includes(key)) {
    throw new Error(`unknown weight ${JSON.stringify(key)} in ${side} — the weights are: ${WEIGHT_NAMES.join(", ")}`);
  }
  const name = key as keyof EvalWeights;
  if (isBooleanWeight(name)) {
    if (value !== "true" && value !== "false") throw new Error(`${key} is a flag: pass ${key}=true or ${key}=false, not ${JSON.stringify(value)}`);
    (into as Record<string, unknown>)[name] = value === "true";
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} takes a number, not ${JSON.stringify(value)}`);
    (into as Record<string, unknown>)[name] = n;
  }
}

function parseArgs(argv: readonly string[]): {
  candidate: EvalWeights;
  baseline: EvalWeights;
  overrides: Partial<EvalWeights>;
  baseOverrides: Partial<EvalWeights>;
  options: Options;
} {
  const overrides: Partial<EvalWeights> = {};
  const baseOverrides: Partial<EvalWeights> = {};
  let games = Number(process.env.GAMES ?? 400);
  let decks = process.env.DECKS ?? PRESETS;
  let firstSeed = Number(process.env.SEED ?? 1);

  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `bad argument ${JSON.stringify(arg)}: this harness takes key=value pairs, never JSON — ` +
          `PowerShell strips the inner quotes out of '{"cardInHand":2}'. ` +
          `Weights: ${WEIGHT_NAMES.join(", ")}. Options: --games, --decks, --seed, --baseline.`,
      );
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);

    if (key.startsWith("--")) {
      switch (key) {
        case "--games":
          games = Number(value);
          break;
        case "--decks":
          decks = value;
          break;
        case "--seed":
          firstSeed = Number(value);
          break;
        case "--baseline":
          // `--baseline=ownTurnRollout=true`, or several comma-separated. Only
          // the FIRST `=` split the option from its value above, so the inner
          // `name=value` arrives intact.
          for (const pair of value.split(",")) {
            const inner = pair.indexOf("=");
            if (inner < 0) throw new Error(`--baseline takes name=value pairs, got ${JSON.stringify(pair)}`);
            applyWeightArg(baseOverrides, pair.slice(0, inner), pair.slice(inner + 1), "--baseline");
          }
          break;
        default:
          throw new Error(`unknown option ${key} — options are --games, --decks, --seed, --baseline`);
      }
      continue;
    }

    applyWeightArg(overrides, key, value, "the candidate");
  }

  if (!Number.isInteger(games) || games < 1) throw new Error(`--games must be a positive integer, got ${games}`);
  if (!Number.isInteger(firstSeed)) throw new Error(`--seed must be an integer, got ${firstSeed}`);

  // The candidate is built ON the baseline, not on `BASELINE_WEIGHTS`. That is
  // what makes `--baseline=ownTurnRollout=true floatRunes=true` mean "given the
  // rollout, does un-filtering FloatRune help" — one variable, measured directly,
  // rather than two independent runs against a common third policy compared by
  // eye.
  const baseline: EvalWeights = { ...BASELINE_WEIGHTS, ...baseOverrides };
  return { candidate: { ...baseline, ...overrides }, baseline, overrides, baseOverrides, options: { games, decks, firstSeed } };
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

type ActionMix = Record<string, number>;

interface GameResult {
  /** Seat that won, or null for a game that hit the cap or errored. */
  readonly winner: 0 | 1 | null;
  readonly error?: string;
  readonly hitCap: boolean;
  readonly turns: number;
  /** Actions taken, per seat, by action type. */
  readonly mix: readonly [ActionMix, ActionMix];
}

/**
 * One game between two policies.
 *
 * `weightsBySeat` is indexed by SEAT, and the acting player is read from
 * `actingPlayerIndex` rather than `activePlayerIndex` — a [Reaction] or a chain
 * pass is chosen by whoever holds priority, and scoring it with the other
 * player's weights would quietly mix the two policies inside a single decision.
 * `chooseAction` computes the same index internally for exactly this reason.
 */
function playGame(a: DeckList, b: DeckList, seed: number, weightsBySeat: readonly [EvalWeights, EvalWeights]): GameResult {
  let state: GameState = startedGame(a, b, seed);
  const mix: [ActionMix, ActionMix] = [{}, {}];
  for (let taken = 0; taken < ACTION_CAP; taken++) {
    const seat = actingPlayerIndex(state);
    let action;
    try {
      action = chooseAction(state, weightsBySeat[seat]);
    } catch (e) {
      // A settle stall or an unbounded resolution. Loud, named, and fatal to the
      // run — see the liveness note in the header.
      return { winner: null, error: `chooseAction threw: ${(e as Error).message}`, hitCap: false, turns: state.turnNumber, mix };
    }
    mix[seat][action.type] = (mix[seat][action.type] ?? 0) + 1;
    const res = submit(state, action);
    if (res.result.type === "Invalid") {
      // The offered-then-refused detector, same as `exercise-run`'s `invalid`.
      return { winner: null, error: `invalid: ${res.result.error}`, hitCap: false, turns: state.turnNumber, mix };
    }
    state = res.state;
    if (res.result.type === "GameOver") {
      const winner: 0 | 1 = state.players[0].id === res.result.winnerId ? 0 : 1;
      return { winner, hitCap: false, turns: state.turnNumber, mix };
    }
  }
  return { winner: null, hitCap: true, turns: state.turnNumber, mix };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { candidate, baseline, overrides, baseOverrides, options } = parseArgs(process.argv.slice(2));
// Calibration is "the two policies are the same", NOT "no arguments were given".
// With `--baseline` in play those differ: `--baseline=twoPly=true twoPly=true`
// names both sides explicitly and is still a calibration run, and it MUST still
// read exactly 50.0% or the swap is not cancelling what it claims.
const isCalibration = JSON.stringify(candidate) === JSON.stringify(baseline);

const registry = defaultCardRegistry();
const { decks: DECKS, generated } = decksFor(options.decks === PRESETS ? undefined : options.decks, registry);

/**
 * Every ORDERED pairing of the deck set, cycled by seed.
 *
 * Ordered and including the mirror (`a === b`), which is not an oversight:
 * seat 0 and seat 1 are not symmetric (first player), and a mirror match is the
 * cleanest possible A/B because the ONLY difference between the two players is
 * the policy. Seven presets give the 49 pairings the first round of this harness
 * used, so a figure measured then still compares.
 */
function pairingFor(index: number): { a: DeckList; b: DeckList; pair: string } {
  const n = DECKS.length;
  const p = ((index % (n * n)) + n * n) % (n * n);
  const i = Math.floor(p / n);
  const j = p % n;
  return { a: at(DECKS, i), b: at(DECKS, j), pair: `${i}v${j}` };
}

let candidateWins = 0;
let baselineWins = 0;
let hitCap = 0;
const errors: string[] = [];
const turns: number[] = [];
const pairsUsed = new Set<string>();
/** Action counts for each POLICY (not each seat) — the behavioural half of the
 *  answer, which has twice now been more decisive than the win rate. */
const candidateMix: ActionMix = {};
const baselineMix: ActionMix = {};

const addMix = (into: ActionMix, from: ActionMix) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

for (let pairIndex = 0; pairIndex < options.games; pairIndex++) {
  const seed = options.firstSeed + pairIndex;
  const { a, b, pair } = pairingFor(seed);
  pairsUsed.add(pair);

  // Same seed, same decks, same battlefields (rolled deterministically from the
  // seed inside `newGameState`) — only the policy-to-seat assignment differs.
  const gameA = playGame(a, b, seed, [candidate, baseline]);
  const gameB = playGame(a, b, seed, [baseline, candidate]);

  for (const [game, candidateSeat] of [
    [gameA, 0],
    [gameB, 1],
  ] as const) {
    turns.push(game.turns);
    addMix(candidateSeat === 0 ? candidateMix : baselineMix, game.mix[0]);
    addMix(candidateSeat === 0 ? baselineMix : candidateMix, game.mix[1]);
    if (game.error !== undefined) {
      errors.push(`seed ${seed} ${pair}: ${game.error}`);
      continue;
    }
    if (game.winner === null) {
      // The only remaining way to have no winner. There is deliberately no
      // "draw" bucket beside it: this engine has no draw, so a game with no
      // winner is a game that did not finish, and calling that a draw would let
      // a livelock average itself away into the win rate.
      hitCap++;
      continue;
    }
    if (game.winner === candidateSeat) candidateWins++;
    else baselineWins++;
  }
}

const decided = candidateWins + baselineWins;
const winRate = decided === 0 ? 0 : (candidateWins / decided) * 100;
/** 95% CI half-width. Printed so a 51% is read as the coin-flip it is — the
 *  plateau at 52.1-52.2% that settled `cardInHand` was three points wide. */
const ci = decided === 0 ? 0 : 1.96 * Math.sqrt((winRate / 100) * (1 - winRate / 100) / decided) * 100;

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * What was measured, in one line, in the result — never only in a comment.
 *
 * The deck basis is here because a result that does not say which decks it ran
 * on is not a result: see the header. `covered` is the generator's own count of
 * how many of the set's implemented cards the decks actually seat.
 */
const basis =
  `${options.decks} (${DECKS.length} decks, ${pairsUsed.size} pairings` +
  (generated !== undefined ? `, ${generated.covered} cards covered, ${generated.orphans.length} orphans` : "") +
  `), seeds ${options.firstSeed}..${options.firstSeed + options.games - 1}`;

const againstLabel = Object.keys(baseOverrides).length === 0
  ? "BASELINE_WEIGHTS"
  : `BASELINE_WEIGHTS + ${Object.entries(baseOverrides).map(([k, v]) => `${k}=${v}`).join(" ")}`;

const label = isCalibration
  ? "CALIBRATION (identical policies)"
  : Object.entries(overrides)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

/**
 * The gate.
 *
 * Calibration must be EXACTLY 50.0% — the two halves of each pair are the same
 * game with the labels swapped, so anything else means the swap is not cancelling
 * what it claims to and every candidate number from this build is worthless.
 *
 * Both modes gate `errors` and `hitCap` at zero, because a tuning run is a
 * liveness probe: the last one found a 538-turn livelock that 40/40 self-play
 * had been passing over, and a liveness bug in the middle of a basis invalidates
 * the tuning that ran on it.
 */
const live = errors.length === 0 && hitCap === 0;
/**
 * The second calibration control, and the stronger of the two.
 *
 * If the pair really is one game played twice with the labels swapped, the two
 * policies must have taken the IDENTICAL actions — not merely split the wins.
 * A 50/50 can survive a broken swap (two different games that happen to go one
 * each, which at 8 pairs is a coin flip away); byte-identical action mixes
 * cannot. This is the control that would catch a seat-dependent difference the
 * win column averages away.
 */
const sortedMix = (mix: ActionMix) => JSON.stringify(Object.entries(mix).sort(([x], [y]) => x.localeCompare(y)));
const mixesIdentical = sortedMix(candidateMix) === sortedMix(baselineMix);
const ok = live && (!isCalibration || (candidateWins === baselineWins && decided > 0 && mixesIdentical));

report(
  "ai-ab",
  {
    candidate: label,
    // What the candidate was measured AGAINST. Never omitted, for the same
    // reason the deck basis never is: with `--baseline` in play, "69.5%" means
    // nothing until you know which policy lost.
    against: againstLabel,
    basis,
    weights: candidate,
    baselineWeights: baseline,
    games: options.games * 2,
    pairs: options.games,
    winRate: `${round(winRate, 2)}% ±${round(ci, 1)}`,
    candidateWins,
    baselineWins,
    hitCap,
    turns: { min: Math.min(...turns), max: Math.max(...turns) },
    candidateActions: candidateMix,
    baselineActions: baselineMix,
    errors: errors.slice(0, 5),
    ...(isCalibration ? { calibrationExact: candidateWins === baselineWins, mixesIdentical } : {}),
  },
  ok,
);
