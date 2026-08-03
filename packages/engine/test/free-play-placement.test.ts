import { describe, expect, it } from "vitest";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/**
 * A card that PLAYS a unit for free still gets to choose where it lands.
 *
 * Reported from playtesting against Dazzling Aurora: a Deadbloom Predator played
 * off her end-of-turn trigger could not be sent to an occupied enemy battlefield
 * (which is the Predator's entire printed text), and no unit played off her
 * could be sent to a battlefield its controller already held.
 *
 * The cause was not Aurora's: every one of the seven "play it, ignoring its
 * cost" sites in the pool called `playUnitToBase`, so a free unit ALWAYS landed
 * at base. A paid play fans its destinations onto the action; a free one has no
 * action to hang them on, which is what the decision queue is for.
 */

const DAZZLING_AURORA = "OGN-160"; // "...reveal until you reveal a unit and banish it. Play it, ignoring its cost."
const DEADBLOOM_PREDATOR = "OGN-161"; // "You may play me to an occupied enemy battlefield."
const PLAIN_UNIT_DEFID = "OGN-087"; // Lecturing Yordle — no placement grant of its own

const choose = (label: RegExp) => (options: DecisionOption[]) =>
  options.find((o) => label.test(o.label))?.id ?? options[0]!.id;

/** Aurora in play, with `topOfDeck` waiting to be revealed and played. */
function auroraState(topOfDeck: string): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.activeGear = [];
  state.players[0]!.baseUnits = [realUnitInstance(DAZZLING_AURORA)];
  state.players[0]!.deck = [realUnitInstance(topOfDeck)];
  return state;
}

/** Fires her end-of-turn trigger and settles up to the first question. */
const endTurn = (state: GameState) =>
  resolveHeldTriggers(holdEventTrigger(state, { kind: "endOfTurn", playerIndex: 0 }));

const at = (state: GameState, bf: string) => (state.battlefields.find((b) => b.id === bf)!.units["p1"] ?? []).map((u) => u.defId);

describe("a free unit play chooses its destination", () => {
  it("asks where to put it when more than one place is legal", () => {
    const state = auroraState(PLAIN_UNIT_DEFID);
    // A battlefield the player already occupies is a legal destination for any
    // unit — the ordinary reinforce rule.
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "anchor", might: 3 })] };

    const asked = endTurn(state);
    expect(pendingDecision(asked)?.kind, "no placement question was raised").toBe("free-play-placement");
    expect(optionsFor(asked, pendingDecision(asked)!).map((o) => o.label)).toContain("Your base");
  });

  it("puts it at a battlefield the player already holds, when that is chosen", () => {
    const state = auroraState(PLAIN_UNIT_DEFID);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "anchor", might: 3 })] };

    const settled = answerDecisions(endTurn(state), choose(/bf1|Battlefield 1/i));

    expect(at(settled, "bf1"), "the unit could not reach a battlefield the player holds").toContain(PLAIN_UNIT_DEFID);
    expect(settled.players[0]!.baseUnits.map((u) => u.defId)).not.toContain(PLAIN_UNIT_DEFID);
  });

  it("offers Deadbloom Predator the OCCUPIED ENEMY battlefield its text names", () => {
    // The reported case, and the sharpest: that placement IS the card. Landing
    // him at base makes his only printed sentence unreachable.
    const state = auroraState(DEADBLOOM_PREDATOR);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "prey", might: 3 })] };

    const asked = endTurn(state);
    const labels = optionsFor(asked, pendingDecision(asked)!).map((o) => o.label);
    expect(labels.length, "he was given no choice at all").toBeGreaterThan(1);

    const settled = answerDecisions(asked, choose(/bf1|Battlefield 1/i));
    expect(at(settled, "bf1"), "he never reached the enemy battlefield").toContain(DEADBLOOM_PREDATOR);
  });

  it("asks NOTHING when base is the only legal destination", () => {
    // One option is not a question — the engine retires it without prompting, so
    // an ordinary free play is unchanged for the player.
    const settled = endTurn(auroraState(PLAIN_UNIT_DEFID));

    expect(settled.pendingDecisions, "a pointless question was asked").toHaveLength(0);
    expect(settled.players[0]!.baseUnits.map((u) => u.defId)).toContain(PLAIN_UNIT_DEFID);
  });
});
