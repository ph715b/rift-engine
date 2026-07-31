import type { BattlefieldState } from "../model/game-state.js";
import type { Rng } from "../util/rng.js";
import type { DeckList } from "./deck-list.js";

/**
 * Builds the two battlefields that go into play from one already-decided name
 * per player. A 1v1 game has exactly 2 battlefields, one out of each player's
 * own 3-battlefield pool (`DeckList.battlefieldNames`, validated by
 * `validateDeckList`) — never 3 shared ones. Both sanctioned 1v1 modes agree
 * on that count (rules 485.5 and 486.6.a.1); they differ only in HOW each name
 * is decided, which is why picking is separate from building.
 *
 * Confirmed against the Java oracle's game-construction path:
 * `RiftboundApp.java:112-125` resolves one battlefield per player
 * independently (`resolveBattlefieldChoice`, called once per player against
 * that player's own `p1Battlefields`/`p2Battlefields`) before calling
 * `new GameEngine(List.of(p1, p2), List.of(bf1, bf2))`.
 *
 * The ids are positional (`bf-0` is the human's contribution, `bf-1` the
 * opponent's) and are what every action/target references, so they must stay
 * stable for a game's lifetime.
 */
export function battlefieldPair(humanName: string, aiName: string): [BattlefieldState, BattlefieldState] {
  return [
    { id: "bf-0", name: humanName, controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    { id: "bf-1", name: aiName, controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
  ];
}

/**
 * One random battlefield name out of `names`, skipping anything in `exclude`.
 *
 * `exclude` exists for 1v1 (Match): rule 487.3 removes the battlefields used
 * in a decided game from the rest of that match ("the Battlefields that were
 * used are to be removed and not selected again for this Match. One of the
 * remaining Battlefields that were set aside must be chosen instead"). With 3
 * battlefields per player and a best-of-3 needing at most 3 games, the
 * remaining pool can never be empty — but if a caller ever exhausts it anyway,
 * this falls back to the full list rather than throwing, since being unable to
 * present a battlefield should not be able to end a match with an exception.
 */
export function pickBattlefield(names: string[], exclude: string[], rng: Rng): string {
  const remaining = names.filter((name) => !exclude.includes(name));
  const pool = remaining.length > 0 ? remaining : names;
  return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * The all-random pairing: 1v1 (Duel)'s setup, where "each player randomly
 * selects one (1) of their three (3) Battlefields" (rule 485.5). Also the path
 * the AI's own side takes in 1v1 (Match), since only the human gets a chooser.
 *
 * `exclude` is threaded through to `pickBattlefield` so a Match-mode caller can
 * honour 487.3's elimination for whichever side is being picked randomly.
 */
export function chooseMatchBattlefields(
  humanDeck: DeckList,
  aiDeck: DeckList,
  rng: Rng,
  exclude: { human?: string[]; ai?: string[] } = {},
): [BattlefieldState, BattlefieldState] {
  return battlefieldPair(
    pickBattlefield(humanDeck.battlefieldNames, exclude.human ?? [], rng),
    pickBattlefield(aiDeck.battlefieldNames, exclude.ai ?? [], rng),
  );
}
