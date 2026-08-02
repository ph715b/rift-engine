/**
 * Self-play termination gate. Expect 40/40 gameOver, 0 invalid.
 *
 * The state is built by `harness.newGameState`, typed as `GameState` — see that
 * file for why that matters. This probe is the one that proved it: it previously
 * hand-built its state, omitted `firstPlayerIndex`, and reported
 * `turns: {min:1, median:1, max:1}` for weeks while looking entirely healthy.
 *
 * The positive controls below exist because a termination gate is exactly the
 * shape of measurement that stays green when it has stopped measuring anything.
 * "40/40 games ended" is also true of 40 games that ended immediately.
 */
import { chooseAction, submit } from "@rift-engine/engine";
import { at, PRESET_DECKS, report, startedGame, stats } from "./harness.ts";

const GAMES = Number(process.env.GAMES ?? 40);
const ACTION_CAP = 3000;

const turns: number[] = [];
const actions: number[] = [];
const finalScores: string[] = [];
const winners: Record<string, number> = {};
const errors: string[] = [];
let gameOver = 0;
let hitCap = 0;
let invalid = 0;
let maxChain = 0;

for (let seed = 1; seed <= GAMES; seed++) {
  let state = startedGame(at(PRESET_DECKS, seed), at(PRESET_DECKS, seed + 1), seed);
  let taken = 0;
  let over = false;

  for (; taken < ACTION_CAP; taken++) {
    const res = submit(state, chooseAction(state));
    if (res.result.type === "Invalid") {
      invalid++;
      errors.push(`seed ${seed}: ${res.result.error}`);
      break;
    }
    state = res.state;
    maxChain = Math.max(maxChain, state.spellChain.length);
    if (res.result.type === "GameOver") {
      over = true;
      gameOver++;
      winners[res.result.winnerId] = (winners[res.result.winnerId] ?? 0) + 1;
      break;
    }
  }

  if (!over) hitCap++;
  turns.push(state.turnNumber);
  actions.push(taken);
  finalScores.push(`${state.players[0].points}-${state.players[1].points}`);
}

// A run that satisfies the gate but fails these is measuring something other than
// a game being played. `turnNumberAdvances` is the specific control that would
// have caught the silent `firstPlayerIndex` omission on day one.
const controls = {
  turnNumberAdvances: Math.max(...turns) > 1,
  gamesTakeActions: Math.min(...actions) > 0,
};

report(
  "ai-health",
  {
    games: GAMES,
    gameOver,
    hitCap,
    invalid,
    turns: stats(turns),
    actionsPerGame: stats(actions),
    maxChain,
    winners,
    controls,
    sampleFinalScores: finalScores.slice(0, 10),
    errors: errors.slice(0, 5),
  },
  gameOver === GAMES && invalid === 0 && controls.turnNumberAdvances && controls.gamesTakeActions,
);
