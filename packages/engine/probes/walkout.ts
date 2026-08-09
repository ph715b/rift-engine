/**
 * POSITIVE CONTROL: a Combat Showdown that one side LEAVES must still award the
 * battlefield (466.3.a / 466.5).
 *
 * `resolveShowdown` used to early-return the state untouched whenever one side had
 * no units — "nothing to fight". The rules disagree: 466.3.a makes the only player
 * with units remaining the WINNER, 466.3.d reserves "No Result" for step-3d
 * recalls / both present / neither present, and 466.5.d makes Establishing Control
 * a Conquer. So an opponent who Flashed a unit out of a Showdown left the other
 * player standing alone and uncredited.
 *
 * The termination gates stay green either way — "no games broke" is equally true
 * of a change that does nothing — so this counts the situation ARISING and the
 * outcome being correct.
 *
 * Measured before -> after the fix, 200 games: points awarded from a walkout
 * 0 -> 95, control awarded 44 -> 154 of 154. Zero before, so the bug was total,
 * and it fires in roughly three of every four games.
 *
 * RUN IT AGAINST THE OLD CODE TOO. `git stash` the fix, rebuild, re-run: it must
 * FAIL. A check you cannot make fail has verified nothing.
 */
import { chooseAction, legalActions, submit } from "@rift-engine/engine";
import type { BattlefieldState, GameState } from "@rift-engine/engine";
import { at, legacyBattlefields, PRESET_DECKS, report, startedGame } from "./harness.ts";

const GAMES = Number(process.env.GAMES ?? 200);
const ACTION_CAP = 400;

// The Annie preset runs 2x Flash (OGS-011, "Move up to 2 friendly units to base")
// plus Gust and several removal spells — every one of which can empty one side of
// a Showdown. A deck without them would make this probe vacuous.
const ANNIE = PRESET_DECKS.find((d) => /annie/i.test(d.name)) ?? at(PRESET_DECKS, 0);

const unitsAt = (state: GameState, bf: BattlefieldState, index: 0 | 1): number =>
  (bf.units[state.players[index].id] ?? []).length;

let walkouts = 0;
let controlAwarded = 0;
let pointsAwarded = 0;
let closedWithNobodyPresent = 0;
let finished = 0;
let invalid = 0;

for (let seed = 0; seed < GAMES; seed++) {
  // Battlefields PINNED, not rolled: the recorded "0 -> 95 points per 200 games"
  // is only comparable against the same games.
  let state = startedGame(ANNIE, ANNIE, 4100 + seed * 13, { battlefields: legacyBattlefields() });

  for (let i = 0; i < ACTION_CAP; i++) {
    if (legalActions(state).length === 0) break;
    // Note the battlefield BEFORE the action: a closing PassFocus is what ends the
    // Showdown, so the interesting occupancy is the pre-action one.
    const combatAt = state.showdownKind === "Combat" ? state.showdownBattlefieldId : null;
    const res = submit(state, chooseAction(state));
    if (res.result.type === "Invalid") {
      invalid++;
      break;
    }
    const next = res.state;

    if (combatAt !== null && next.showdownBattlefieldId === null) {
      const before = state.battlefields.find((b) => b.id === combatAt);
      const after = next.battlefields.find((b) => b.id === combatAt);
      if (before && after) {
        const present = ([0, 1] as const).filter((index) => unitsAt(state, before, index) > 0);
        const only = present[0];
        if (present.length === 1 && only !== undefined) {
          walkouts++;
          if (after.controllerId === next.players[only].id) controlAwarded++;
          const gained = next.players[only].points - state.players[only].points;
          if (gained > 0) pointsAwarded += gained;
        } else if (present.length === 0) {
          closedWithNobodyPresent++;
        }
      }
    }

    state = next;
    if (res.result.type === "GameOver") {
      finished++;
      break;
    }
  }
}

report(
  "walkout",
  { games: GAMES, finished, invalid, deck: ANNIE.name, combatShowdownWalkouts: walkouts, controlAwarded, pointsAwarded, closedWithNobodyPresent },
  // The situation must actually occur, and every occurrence must award control.
  walkouts > 0 && controlAwarded === walkouts,
);
