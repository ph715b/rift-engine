/**
 * Does the player who goes FIRST win more often than the player who goes second?
 *
 * # Why this needs its own probe
 *
 * **`ai-ab.ts` cannot answer it, by construction.** That harness pairs each game
 * with the same game and the labels swapped, and pins `firstPlayerIndex` to 0 in
 * both halves — deliberately, so the seat cancels and a weight change is measured
 * against nothing else. The seat effect is exactly what it removes. Mirroring
 * here would produce a guaranteed 50% and look like an answer.
 *
 * # Why the question matters
 *
 * **Tournament rule 407.4**: "For games after the first game of a match, the
 * loser of the previous game gets to choose if they play first or last." That is
 * a real decision the AI has to make in a Best of 3, and "the AI chooses to play
 * first" is a claim about the game that this repo requires be measured rather
 * than inferred.
 *
 * The inference would have been from the compensation: 1v1 gives the player going
 * SECOND an extra rune on their first Channel Phase (Core Rules 485.7 / 486.7),
 * which is the rules' own statement that going first is the seat worth
 * compensating against. Plausible, and not evidence.
 *
 * # The design
 *
 * **Mirror DECKS, not mirror games.** Both seats are dealt the same decklist and
 * play the same policy, so the only asymmetry left in the game is turn order.
 * Anything else — different decks, different weights — would measure that
 * instead.
 *
 * **`firstPlayerIndex` alternates across seeds**, so a bug that favoured seat 0
 * for some reason other than going first (a fixture asymmetry, an off-by-one in
 * the turn rotation) shows up as a split between the two halves rather than
 * being absorbed into the headline. The two halves are reported separately for
 * exactly that reason; they should agree.
 *
 * **Battlefields are PINNED** for the reason `walkout`'s note gives: a recorded
 * figure is only comparable against the same games.
 *
 * # Controls
 *
 * `sawBothSeats` — both `firstPlayerIndex` values were actually played, so an
 * accidental constant cannot report a one-sided sweep as a result.
 * `halvesAgree` — the two halves are within 10pp of each other. They measure the
 * same quantity from opposite seats, so a wide split means the instrument is
 * measuring a seat rather than a turn order, and the headline is meaningless.
 * `decided` — games that produced a winner; ties are reported and excluded from
 * the rate rather than silently counted as a loss.
 */
import {
  chooseAction,
  legalActions,
  submit,
  winner,
} from "@rift-engine/engine";
import {
  at,
  legacyBattlefields,
  PRESET_DECKS,
  report,
  startedGame,
} from "./harness.ts";

const GAMES = Number(process.env.GAMES ?? 400);
const ACTION_CAP = 600;

/** One deck, dealt to BOTH seats — the mirror that isolates turn order. */
const DECK =
  PRESET_DECKS.find((d) => /annie/i.test(d.name)) ?? at(PRESET_DECKS, 0);

interface Half {
  games: number;
  decided: number;
  firstPlayerWins: number;
}

const halves: Record<"first0" | "first1", Half> = {
  first0: { games: 0, decided: 0, firstPlayerWins: 0 },
  first1: { games: 0, decided: 0, firstPlayerWins: 0 },
};

let ties = 0;
let unfinished = 0;
let invalid = 0;

for (let seed = 0; seed < GAMES; seed++) {
  const firstPlayerIndex: 0 | 1 = seed % 2 === 0 ? 0 : 1;
  const half = halves[firstPlayerIndex === 0 ? "first0" : "first1"];
  half.games += 1;

  let state = startedGame(DECK, DECK, 9200 + seed * 17, {
    firstPlayerIndex,
    battlefields: legacyBattlefields(),
  });

  let finished = false;
  for (let i = 0; i < ACTION_CAP; i++) {
    if (legalActions(state).length === 0) break;
    const res = submit(state, chooseAction(state));
    if (res.result.type === "Invalid") {
      invalid += 1;
      break;
    }
    state = res.state;
    if (res.result.type === "GameOver") {
      finished = true;
      break;
    }
  }
  if (!finished) {
    unfinished += 1;
    continue;
  }

  const won = winner(state);
  if (won === null) {
    ties += 1;
    continue;
  }
  half.decided += 1;
  if (won === firstPlayerIndex) half.firstPlayerWins += 1;
}

const rate = (h: Half) => (h.decided === 0 ? 0 : h.firstPlayerWins / h.decided);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const decided = halves.first0.decided + halves.first1.decided;
const firstWins = halves.first0.firstPlayerWins + halves.first1.firstPlayerWins;
const overall = decided === 0 ? 0 : firstWins / decided;
const spread = Math.abs(rate(halves.first0) - rate(halves.first1));

const controls = {
  sawBothSeats: halves.first0.games > 0 && halves.first1.games > 0,
  halvesAgree: spread <= 0.1,
  decidedMost: decided >= GAMES * 0.8,
  noInvalid: invalid === 0,
};

report(
  "first-player",
  {
    basis: `${DECK.name} mirrored on both seats, battlefields pinned`,
    games: GAMES,
    decided,
    ties,
    unfinished,
    invalid,
    firstPlayerWinRate: pct(overall),
    byHalf: {
      "firstPlayerIndex=0": {
        ...halves.first0,
        rate: pct(rate(halves.first0)),
      },
      "firstPlayerIndex=1": {
        ...halves.first1,
        rate: pct(rate(halves.first1)),
      },
    },
    halfSpread: pct(spread),
    controls,
  },
  Object.values(controls).every(Boolean),
);
