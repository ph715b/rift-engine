import { describe, expect, it } from "vitest";
import {
  forceMoveToBase,
  forceMoveToBattlefield,
  relocateToBaseUnchanged,
} from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **A move an EFFECT caused is still a Move, and still triggers.**
 *
 * Reported from playtesting: *"Move triggers do not trigger if a unit is charmed
 * or moved by another effect."*
 *
 * `forceMoveToBattlefield` carried a comment claiming the opposite was
 * deliberate — that on-move triggers "read 'when I move' on cards whose
 * controller chose to move them", and that "no card in this pool has one that
 * could be reached this way". Both halves were wrong.
 *
 * **445.2** does not mention who chose: *"A Permanent changing its position from
 * any space on the Board to another space on the Board is a Move, unless it is
 * caused by a corrective Recall or an Attached Permanent changing locations to or
 * with its Top-Most Card."* And **316.7.c** lists a move as possibly "the result
 * of a Standard Move Intrinsic Ability, a **Spell**, or other Game Effect" — the
 * same sentence the helper already quoted for the exhaust, read only as far as
 * the half that suited.
 *
 * The pool claim was false too: fifteen listeners watch a move, and Stealthy
 * Pursuer's "a friendly unit moves FROM my location" is reachable by any Charm.
 *
 * # Why the whole suite stayed green
 *
 * All 3192 tests passed both before and after this fix. **Not one of them covered
 * an effect-caused move's triggers** — which is precisely how the bug shipped, and
 * why this file asserts the behaviour directly rather than trusting the count.
 */

const TRAVELING_MERCHANT = "OGN-185"; // "When I move, discard 1, then draw 1."
const NOXIAN_DRUMMER = "OGN-222"; // "When I move TO A BATTLEFIELD, play a Recruit here."
const MISS_FORTUNE_CAPTAIN = "OGN-162"; // "The FIRST time I move each turn ..."
const STEALTHY_PURSUER = "OGN-177"; // "When a friendly unit moves from my location, I may be moved with it."

/** A board with `defId` standing at bf1, controlled by p1. */
function standingAt(defId: string, overrides: Partial<GameState> = {}): GameState {
  const unit = { ...realUnitInstance(defId), instanceId: "mover" };
  const base = makeState(overrides);
  const battlefields = [...base.battlefields];
  battlefields[0] = { ...battlefields[0]!, units: { p1: [unit] } };
  return { ...base, battlefields };
}

const heldMoveTriggers = (s: GameState) => s.pendingTriggers.filter((t) => t.source === "unitOnMove");

describe("a spell-driven move fires the mover's own on-move trigger", () => {
  it("Traveling Merchant charmed to another battlefield triggers — the playtest report", () => {
    const moved = forceMoveToBattlefield(standingAt(TRAVELING_MERCHANT), "mover", "bf2");
    expect(heldMoveTriggers(moved), "the charmed unit's on-move trigger never fired").toHaveLength(1);
  });

  it("holds it rather than dispatching — the same response window a Standard Move gives", () => {
    // 383. If an effect-caused move resolved its trigger immediately while a
    // walk-in held it, the two paths would differ in a way a player can feel.
    const moved = forceMoveToBattlefield(standingAt(TRAVELING_MERCHANT), "mover", "bf2");
    expect(heldMoveTriggers(moved)[0]).toMatchObject({ kind: "trigger", listenerDefId: TRAVELING_MERCHANT });
  });

  it("counts the move, so Miss Fortune's 'FIRST time each turn' is spent by it", () => {
    // 445.2 makes it a Move, and hers asks about Moves. A spell-driven move that
    // triggered but did not count would let her fire twice in a turn.
    const first = forceMoveToBattlefield(standingAt(MISS_FORTUNE_CAPTAIN), "mover", "bf2");
    expect(heldMoveTriggers(first), "her first move did not trigger").toHaveLength(1);

    const second = forceMoveToBattlefield(first, "mover", "bf1");
    expect(heldMoveTriggers(second), "a SECOND move fired her 'first time each turn'").toHaveLength(1);
  });
});

describe("the board-wide unitMoved event, watched by a card that is not the mover", () => {
  /**
   * Stealthy Pursuer standing at bf1 next to a plain friendly unit — the exact
   * shape the playtester hit, and the one the old comment said could not exist:
   * *"no card in this pool has [an on-move trigger] that could be reached this
   * way."*
   *
   * Asserted through a REAL listener rather than by reading the held entry's
   * fields, because `holdEventTrigger` holds nothing at all when no permanent is
   * listening — a state with no Pursuer on it would have passed an entry-shape
   * assertion by being empty in the way the bug made it empty.
   */
  function pursuerWatching(): GameState {
    const pursuer = { ...realUnitInstance(STEALTHY_PURSUER), instanceId: "pursuer" };
    const friend = { ...makeUnit({ instanceId: "mover", name: "Friend" }), ownerId: "p1" };
    const base = makeState();
    const battlefields = [...base.battlefields];
    battlefields[0] = { ...battlefields[0]!, units: { p1: [pursuer, friend] } };
    return { ...base, battlefields };
  }

  const pursuerTriggers = (s: GameState) =>
    s.pendingTriggers.filter((t) => t.listenerInstanceId === "pursuer");

  it("a friendly unit CHARMED away from his location reaches him", () => {
    const moved = forceMoveToBattlefield(pursuerWatching(), "mover", "bf2");
    expect(pursuerTriggers(moved), "Stealthy Pursuer never saw the effect-caused move").toHaveLength(1);
  });

  it("reaches him when the friendly unit is sent to BASE — 'moved WITH IT'", () => {
    // His text is "I may be moved with it", not "to that battlefield", so a
    // friend going home is a friend he may follow home.
    const moved = forceMoveToBase(pursuerWatching(), "mover");
    expect(pursuerTriggers(moved), "a move home did not reach the Pursuer").toHaveLength(1);
  });

  it("a RECALL does not reach him — 454 again, from the listener's side", () => {
    const recalled = relocateToBaseUnchanged(pursuerWatching(), "mover");
    expect(pursuerTriggers(recalled), "a Recall reached a move listener").toHaveLength(0);
  });

  it("does not fire on his OWN move — the event is about one unit", () => {
    // `pursuerFollows` excludes the listener's own id. Pinned because the origin
    // check (`listener.battlefieldId === event.from`) is trivially true for the
    // mover itself, so this exclusion is the only thing stopping it.
    const moved = forceMoveToBattlefield(pursuerWatching(), "pursuer", "bf2");
    expect(pursuerTriggers(moved)).toHaveLength(0);
  });
});

describe("a move to BASE is a Move too — and 'to a battlefield' is a real restriction", () => {
  it("triggers a card that just says 'when I move'", () => {
    // 359.3.e works this case by name: base is a legal move destination.
    const moved = forceMoveToBase(standingAt(TRAVELING_MERCHANT), "mover");
    expect(heldMoveTriggers(moved), "a move home did not trigger 'when I move'").toHaveLength(1);
  });

  it("does NOT trigger Noxian Drummer, whose text says 'to a battlefield'", () => {
    // Unguarded until this change, because a Standard Move can only ever end at a
    // battlefield. Without the guard he answers a move home by placing a Recruit
    // at a battlefield whose id is the string "base".
    const home = forceMoveToBase(standingAt(NOXIAN_DRUMMER), "mover");
    expect(heldMoveTriggers(home), "'when I move to a battlefield' fired on a move to base").toHaveLength(0);

    // The control: he still triggers on the move he does care about.
    const across = forceMoveToBattlefield(standingAt(NOXIAN_DRUMMER), "mover", "bf2");
    expect(heldMoveTriggers(across), "Drummer stopped triggering on a real battlefield move").toHaveLength(1);
  });

  it("still actually puts the unit in base — the trigger did not replace the move", () => {
    const moved = forceMoveToBase(standingAt(TRAVELING_MERCHANT), "mover");
    expect(moved.players[0]!.baseUnits.map((u) => u.instanceId)).toContain("mover");
    expect(moved.battlefields[0]!.units.p1 ?? []).toHaveLength(0);
  });
});

describe("a RECALL is still not a Move — 454, the one real exclusion", () => {
  it("relocateToBaseUnchanged fires nothing", () => {
    // *"Recalls are not Moves. They do not cause Triggered Abilities to trigger
    // that are triggered by Move actions."* This is the distinction the old
    // comment reached for and landed on the wrong side of: the carve-out is
    // RECALLS, not effect-caused moves. If this ever goes green-by-accident the
    // fix above has over-reached.
    const recalled = relocateToBaseUnchanged(standingAt(TRAVELING_MERCHANT), "mover");
    expect(heldMoveTriggers(recalled), "a Recall fired a move trigger").toHaveLength(0);
    // The event half is asserted from the LISTENER's side above ("a RECALL does
    // not reach him"), which is the only place it can be seen: `holdEventTrigger`
    // holds nothing when nothing is listening, so an empty-board assertion here
    // would pass whether or not the event fired.
    expect(recalled.pendingTriggers, "a Recall held anything at all").toHaveLength(0);
  });

  it("still actually moves the unit home — the recall itself is not broken", () => {
    // The positive control, so the assertion above cannot pass because nothing
    // happened at all.
    const recalled = relocateToBaseUnchanged(standingAt(TRAVELING_MERCHANT), "mover");
    expect(recalled.players[0]!.baseUnits.map((u) => u.instanceId)).toContain("mover");
  });
});

describe("what a forced move still does NOT do", () => {
  it("leaves the unit READY — the exhaust is the Standard Move's COST", () => {
    // 415.1.b/144.4. The half of the original comment that was right, pinned so
    // this change cannot be read as making a forced move into a Standard one.
    const moved = forceMoveToBattlefield(standingAt(TRAVELING_MERCHANT), "mover", "bf2");
    const arrived = moved.battlefields[1]!.units.p1!.find((u) => u.instanceId === "mover");
    expect(arrived?.exhausted, "a charmed unit arrived exhausted").toBeFalsy();
  });

  it("fires nothing when the unit is already there — nothing moved", () => {
    const same = forceMoveToBattlefield(standingAt(TRAVELING_MERCHANT), "mover", "bf1");
    expect(heldMoveTriggers(same)).toHaveLength(0);
  });
});
