import type { BattlefieldState } from "../model/game-state.js";
import type { Rng } from "../util/rng.js";
import type { DeckList } from "./deck-list.js";

/**
 * Chooses the battlefields for a 1v1 match: each player's deck carries its
 * own 3-battlefield pool (`DeckList.battlefieldNames`, validated by
 * `validateDeckList`), and exactly ONE battlefield from each player's own
 * pool ends up in play — a 1v1 game has 2 battlefields total, never 3
 * shared ones. Confirmed against the Java oracle's actual game-construction
 * path: `RiftboundApp.java:112-125` resolves one battlefield per player
 * independently (`resolveBattlefieldChoice`, called once per player against
 * that player's own `p1Battlefields`/`p2Battlefields`) before calling
 * `new GameEngine(List.of(p1, p2), List.of(bf1, bf2))` — always a 2-element
 * list, never each player's full pool combined.
 *
 * Mirrors the Java Bo1 path specifically (`Math.random()` pick from that
 * player's own eligible trio, RiftboundApp.java:283) since this engine
 * doesn't model best-of-3 matches (or the "exclude already-used-this-match"
 * tracking/player-choice dialog that path adds) yet — add that when Bo3
 * lands, not speculatively now.
 */
export function chooseMatchBattlefields(humanDeck: DeckList, aiDeck: DeckList, rng: Rng): [BattlefieldState, BattlefieldState] {
  const humanChoice = humanDeck.battlefieldNames[Math.floor(rng() * humanDeck.battlefieldNames.length)]!;
  const aiChoice = aiDeck.battlefieldNames[Math.floor(rng() * aiDeck.battlefieldNames.length)]!;

  return [
    { id: "bf-0", name: humanChoice, controllerId: null, units: {} },
    { id: "bf-1", name: aiChoice, controllerId: null, units: {} },
  ];
}
