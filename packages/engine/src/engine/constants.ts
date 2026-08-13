import type { GameState } from "../model/game-state.js";
import { winThreshold } from "./battlefield-continuous.js";

/** 2-player Victory Score — model/GameState.java:17 (`WIN_THRESHOLD_1V1 = 8`).
 *  The multiplayer threshold (11) and the Aspirant's Climb battlefield's +1
 *  modifier (model/GameState.java:852-856) don't apply — this engine is
 *  2-player only for now, and Aspirant's Climb isn't a battlefield mechanic
 *  yet (battlefields currently carry no passive effects at all). Shared by
 *  scoring.ts and win-condition.ts (was two separately-declared copies). */
export const WIN_THRESHOLD_1V1 = 8;

/**
 * `[Mighty]` is "while it has 5+ Might" (rule 708).
 *
 * Here rather than beside `isMighty` in granted-keywords.ts because TWO modules
 * need it and they cannot import each other: `effect-helpers` fires the
 * "became Mighty" transition, and importing granted-keywords there would close
 * the cycle effect-helpers -> granted-keywords -> equipment -> effect-helpers.
 * A leaf module both can reach keeps the number written down once.
 */
export const MIGHTY_THRESHOLD = 5;

/**
 * "A Bird, Cat, Dog, or Poro" — the four creature tags two Unleashed cards name
 * as a set, word for word:
 *
 *   - UNL-166 Stalking Wolf — "kill a Bird, Cat, Dog, or Poro you control" (an
 *     additional cost, so it is a `UnitCostSpec.candidate`)
 *   - UNL-168 Undying Loyalty — "this costs [2] less if you CHOOSE a Bird, Cat,
 *     Dog, or Poro" (a discount priced per enumerated target)
 *
 * Two different mechanisms reading one printed list, which is why it lives here
 * rather than in either of them: `constants.ts` imports nothing from the engine,
 * so both `card-effects.ts` and `cost-modifiers.ts` can take it without opening
 * a cycle. Duplicating it would be the same class as this repo's hand-copied
 * trigger census — wrong four times, always by copying one of the sources.
 */
export const COMPANION_TAGS: readonly string[] = ["Bird", "Cat", "Dog", "Poro"];

/**
 * Vanguard Armory's "play THREE 1 [Might] Recruit unit tokens".
 *
 * Here for exactly the reason `MIGHTY_THRESHOLD` above is, and it was not a
 * guess: the ability lives in `activated-abilities.ts` and the question it parks
 * lives in `effects/order.ts`, and importing the number from the first into the
 * second closed a cycle through `token.js` that registered the Gold token's
 * ability under the key `"undefined"`. That module's own guard threw and named
 * it — this constant is the fix, not a precaution.
 */
export const VANGUARD_ARMORY_TOKENS = 3;

/**
 * "Your **Mechs**" — a printed tag, so it is answerable from a card DEFINITION
 * and not only from a live instance. That is what lets it be asked at ENTRY
 * (`keywordOnEntry`, before the unit exists as an instance) as well as on the
 * board.
 *
 * Here for the same reason `MIGHTY_THRESHOLD` above is: two modules that cannot
 * import each other both need it. `granted-keywords` asks it for the three
 * tribal keyword auras, and `effective-might` asks it for Rumble - Scrapper's
 * tribal MIGHT aura — and granted-keywords already imports effective-might, so
 * the predicate cannot live in either without the other reaching across.
 *
 * Takes the structural shape both callers can supply: a definition's key is
 * `id` and an instance's is `defId`, so neither is named here and only `tags`
 * is read.
 */
export const isMechDef = (def: { tags?: readonly string[] }): boolean => def.tags?.includes("Mech") === true;

/**
 * The Victory Score for THIS game — the constant above plus whatever the
 * battlefields in play add to it.
 *
 * Aspirant's Climb ("increase the points needed to win the game by 1") is why
 * this is a function of state: the constant's own comment used to say the card
 * "isn't a battlefield mechanic yet (battlefields currently carry no passive
 * effects at all)", which was true and is the sentence shape this codebase has
 * learned to read as "here is a hook that does not exist".
 *
 * Both readers must ask it: `win-condition.winner` and `scoring.recordConquest`'s
 * final-point rule (471.1.b). One of them using the bare constant is how a game ends
 * a point early.
 */
export function victoryScore(state: GameState): number {
  return winThreshold(state, WIN_THRESHOLD_1V1);
}

/**
 * "If an opponent's score is within 3 points of the Victory Score" — the
 * comeback clause printed on Leona - Zealot (enters ready) and Find Your Center
 * (costs 2 less).
 *
 * One definition rather than two, because the two cards would otherwise be free
 * to drift on whether "within 3" is inclusive. It is: at the 8-point Victory
 * Score, an opponent on 5 triggers it.
 *
 * Reads the OPPONENT's points, never the asking player's — both cards reward
 * being behind, so measuring the wrong side would invert them.
 */
export const COMEBACK_SCORE_GAP = 3;

/**
 * "While YOUR score is within 3 points of the Victory Score" — Renata Glasc -
 * Chem-Baroness.
 *
 * **The mirror of `opponentNearVictory` below, and the two must not be
 * confused.** That one reads the OPPONENT and rewards being BEHIND (Leona -
 * Zealot, Find Your Center); this reads the ASKING player and rewards being
 * AHEAD. Measuring the wrong side inverts the card, which is precisely why they
 * are two named functions over one shared gap rather than one function with a
 * flag someone could pass wrongly.
 *
 * Inclusive, and against THIS game's Victory Score rather than the printed 8 —
 * both for the reasons its sibling records.
 */
export function selfNearVictory(state: GameState, playerIndex: 0 | 1): boolean {
  return victoryScore(state) - state.players[playerIndex]!.points <= COMEBACK_SCORE_GAP;
}

export function opponentNearVictory(state: GameState, playerIndex: 0 | 1): boolean {
  const opponentIndex = playerIndex === 0 ? 1 : 0;
  // Measured against THIS game's Victory Score, not the printed 8: with
  // Aspirant's Climb in play the comeback clause has one more point to cover,
  // and both cards that read it say "within 3 points of the Victory Score".
  return victoryScore(state) - state.players[opponentIndex]!.points <= COMEBACK_SCORE_GAP;
}
