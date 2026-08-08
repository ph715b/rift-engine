/**
 * **Does `[Hunt N]` actually pay in a real game?** — the question the coverage
 * gates cannot answer.
 *
 *     npm run build --workspace=@rift-engine/engine
 *     node packages/engine/probes/hunt-xp.ts
 *
 * `reachability` reports whether a card was ever observed ACTING, and it did not
 * move when Hunt landed. That is not evidence either way: the keyword is not a
 * registered card effect, so nothing in the exercise log records it, and a Hunt
 * that fires perfectly is invisible to that instrument. This probe asks the only
 * question that settles it — did any player's XP ever go up — and it asks it of
 * the same UNL covering run.
 *
 * XP has exactly one writer (`gainXp`) and, until `[Level]` and the XP costs
 * land, exactly one producer: Hunt. So a non-zero total here IS Hunt firing, and
 * a zero total means the keyword is inert in play whatever the unit tests say.
 * That is the `[Deflect]` failure mode, and this is what would have caught it.
 *
 * Reported per SEAT rather than summed, because a total hides the case where one
 * side's decks happen to hold every Hunter.
 */
import { defaultCardRegistry } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { runExercise } from "./exercise-run.ts";

const GAMES = Number(process.env.GAMES ?? 250);

const registry = defaultCardRegistry();

/** Every UNL card printing the keyword, so the probe can say what it was
 *  looking for rather than only what it found. */
const huntCards = registry
  .all()
  .filter((def) => (def.text ?? "").includes("[Hunt"))
  .map((def) => def.id);

let xpGains = 0;
let peakXp = 0;
let gamesWithXp = 0;
let statesSeen = 0;
let lastXp = [0, 0];
let currentGame = -1;

runExercise("UNL", GAMES, registry, (state, game) => {
  statesSeen += 1;
  if (game !== currentGame) {
    currentGame = game;
    lastXp = [0, 0];
  }
  let gainedThisGame = false;
  for (const index of [0, 1] as const) {
    const xp = state.players[index]!.xp;
    if (xp > lastXp[index]!) {
      xpGains += 1;
      gainedThisGame = true;
    }
    lastXp[index] = xp;
    if (xp > peakXp) peakXp = xp;
  }
  if (gainedThisGame) gamesWithXp += 1;
});

const controls = {
  /** The probe ran at all. A zero-state run would report zero gains and read
   *  exactly like a broken keyword. */
  sawStates: statesSeen > 0,
  /** The pool really does print the keyword — this probe is pointed at a real
   *  subject rather than measuring an empty set. */
  huntCardsExist: huntCards.length > 0,
  /** **The gate.** XP moved in a real game, so the keyword is not inert. */
  xpEverGained: xpGains > 0,
};

report(
  "hunt-xp",
  {
    games: GAMES,
    statesObserved: statesSeen,
    huntCardsInPool: huntCards.length,
    huntCards,
    /** How many times a player's XP was observed to have risen between two AI
     *  decisions. Not a trigger count — several Hunts resolving in one Cleanup
     *  are one observed rise — so treat it as a floor. */
    xpRises: xpGains,
    peakXp,
    gamesWithAnyXp: gamesWithXp,
    controls,
  },
  Object.values(controls).every(Boolean),
);
