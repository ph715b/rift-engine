/**
 * Does a game still END when the human only ever passes? Expect 16/16.
 *
 * This models exactly what a Playwright driver does — click Pass, click Pass
 * Focus, never play anything — and it exists because that is a real way for the
 * engine to livelock without any single action being invalid. It found a state the
 * rules do not allow (a battlefield CONTROLLED but unoccupied) which was a dead end
 * for scoring: its controller could neither Hold it (no units present) nor Conquer
 * it (already controlled). Six of sixteen games froze, one running to turn 1988.
 *
 * The stall report is the useful half. A bare count says a game hung; the dump
 * says WHICH battlefield, held by whom, with how many units — which is what turned
 * that livelock into a one-line rule (323.6) rather than a hunt.
 */
import { chooseAction, legalActions, submit } from "@rift-engine/engine";
import type { GameState, PlayerAction } from "@rift-engine/engine";
import { at, PRESET_DECKS, report, startedGame } from "./harness.ts";

const GAMES = Number(process.env.GAMES ?? 16);
const ACTION_CAP = 4000;
const HUMAN = 0;

/** Whoever the engine is currently asking. Mirrors `timing.actingPlayerIndex`:
 *  chain closed -> priority holder; Showdown -> Focus holder; else turn player. */
function actingIndex(state: GameState): 0 | 1 {
  if (!state.chainOpen) return state.chainPriority;
  if (state.turnState === "Showdown") return state.focusHolder;
  return state.activePlayerIndex;
}

interface Stall {
  seed: number;
  turn: number;
  points: number[];
  controlledButEmpty: number;
  battlefields: { controller: string | null; units: Record<string, number> }[];
}

const stalls: Stall[] = [];
let ended = 0;

for (let seed = 1; seed <= GAMES; seed++) {
  const first: 0 | 1 = seed % 2 === 0 ? 0 : 1;
  let state = startedGame(at(PRESET_DECKS, seed), at(PRESET_DECKS, 0), seed, { firstPlayerIndex: first });
  let finished = false;

  for (let i = 0; i < ACTION_CAP; i++) {
    let action: PlayerAction;
    if (actingIndex(state) === HUMAN) {
      // The passive human: pass Focus if that is all there is, else pass the turn.
      action = legalActions(state).find((a) => a.type === "PassFocus") ?? { type: "Pass", playerIndex: HUMAN };
    } else {
      action = chooseAction(state);
    }
    const res = submit(state, action);
    if (res.result.type === "Invalid") break;
    state = res.state;
    if (res.result.type === "GameOver") {
      finished = true;
      break;
    }
  }

  if (finished) {
    ended++;
    continue;
  }
  stalls.push({
    seed,
    turn: state.turnNumber,
    points: state.players.map((p) => p.points),
    // The suspect state: controlled by someone with no units standing there.
    controlledButEmpty: state.battlefields.filter(
      (b) => b.controllerId !== null && (b.units[b.controllerId] ?? []).length === 0,
    ).length,
    battlefields: state.battlefields.map((b) => ({
      controller: b.controllerId,
      units: Object.fromEntries(Object.entries(b.units).map(([id, units]) => [id, units.length])),
    })),
  });
}

report("passive-human", { games: GAMES, ended, stalled: stalls.length, stalls: stalls.slice(0, 4) }, stalls.length === 0);
