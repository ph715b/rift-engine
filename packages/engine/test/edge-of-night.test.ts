import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **SFD-139 Edge of Night — "When you play this from face down, attach it to a
 * unit you control (here)."**
 *
 * Reported by the project owner: *"Edge of night should attach to a unit when it
 * is played from hidden."* It did not. The clause was not implemented anywhere,
 * and **the card reported fully implemented with no partial note** — it is a Gear
 * with an `[Equip]` and an art-only Might badge, and that is enough for
 * `isCardImplemented`. So the whole first sentence was missing and nothing in the
 * repo could see it: the silently-inert-printing shape, found by a human playing
 * the game rather than by an instrument.
 *
 * The play itself WAS offered from hidden the whole time, which is what made the
 * gap invisible from the action side too — `reachability` counts a card as
 * exercised when it is played, not when its text does something.
 *
 * # The two readings this file pins
 *
 * **From FACE DOWN only.** `SelfEvent.fromHiddenBattlefieldId` is absent for an
 * ordinary play, which is exactly the distinction the sentence draws.
 *
 * **"(here)" is 811.1.d.2 printed on the card** — "if a hidden spell or a play
 * effect of a hidden permanent chooses any targets, those targets must be chosen
 * from among options at that battlefield."
 */

const EDGE_OF_NIGHT = "SFD-139";
const registry = defaultCardRegistry();

/** Edge of Night hidden at bf1, with `here` friendly units there and `elsewhere`
 *  friendly units at bf2 — the narrowing's negative control. */
function hiddenAt(opts: { here?: string[]; elsewhere?: string[] } = {}): {
  state: GameState;
  gearId: string;
} {
  const gear = createCardInstance(registry.get(EDGE_OF_NIGHT));
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnNumber: 3 });
  state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    domain: "Chaos" as const,
    state: "Ready" as const,
  }));
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    controllerId: "p1",
    units: { p1: (opts.here ?? []).map((id) => makeUnit({ instanceId: id, name: id })) },
    hiddenCards: [{ ownerIndex: 0, card: gear, hiddenOnTurn: 1 }],
  };
  state.battlefields[1] = {
    ...state.battlefields[1]!,
    units: { p1: (opts.elsewhere ?? []).map((id) => makeUnit({ instanceId: id, name: id })) },
  };
  return { state, gearId: gear.instanceId };
}

const hiddenPlay = (state: GameState): PlayCardAction =>
  legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.defId === EDGE_OF_NIGHT && a.fromHiddenBattlefieldId !== undefined,
  )!;

const wornBy = (state: GameState, gearId: string) =>
  state.players[0]!.activeGear.find((g) => g.instanceId === gearId)?.attachedToInstanceId;

/** Plays it from hidden and settles the trigger and whatever it asked. */
const playFromHidden = (state: GameState, answer?: (options: { id: string; label: string }[]) => string) => {
  const play = hiddenPlay(state);
  expect(play, "the from-hidden play was never offered").toBeDefined();
  const { state: next, result } = submit(state, play);
  expect(result, `the play was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return answerDecisions(resolveHeldTriggers(next), answer);
};

describe("played from FACE DOWN, it attaches itself", () => {
  it("attaches to the only friendly unit there, without asking", () => {
    // One option is not a question — `advanceDecisions` executes it.
    const { state, gearId } = hiddenAt({ here: ["mine"] });
    const after = playFromHidden(state);

    expect(wornBy(after, gearId), "the gear was played but never attached").toBe("mine");
  });

  it("asks WHICH when there are two, and the answer is real", () => {
    const { state, gearId } = hiddenAt({ here: ["a", "b"] });
    const after = playFromHidden(state, (options) => options.find((o) => o.label === "b")!.id);

    expect(wornBy(after, gearId), "the chosen unit was not the one it attached to").toBe("b");
  });

  it("offers ONLY the units at the battlefield it was hidden at (811.1.d.2)", () => {
    // The narrowing, with a friendly unit at another battlefield as the control.
    // Without it, "attached to the one here" would also be what an unnarrowed
    // implementation produced on a board with only one option.
    // TWO units here so the question is really asked and its options can be
    // read; a third friendly unit sits at bf2 and must not appear.
    const { state, gearId } = hiddenAt({ here: ["h1", "h2"], elsewhere: ["far"] });
    let offered: string[] = [];
    const after = playFromHidden(state, (options) => {
      offered = options.map((o) => o.label);
      return options[0]!.id;
    });

    expect(offered.sort(), "the option list was not narrowed to the hiding battlefield").toEqual(["h1", "h2"]);
    expect(wornBy(after, gearId), "it attached to a unit at another battlefield").toBe("h1");
  });

  it("is a no-op with nobody to wear it — 055, not a refusal", () => {
    // "Do as much as you can, ignoring impossible instructions." The play is
    // still legal and the gear still enters play; it simply arrives unworn.
    const { state, gearId } = hiddenAt({ here: [] });
    const after = playFromHidden(state);

    expect(after.players[0]!.activeGear.some((g) => g.instanceId === gearId), "the gear never entered play").toBe(true);
    expect(wornBy(after, gearId)).toBeNull();
    expect(after.pendingDecisions, "a question was parked with no answers").toHaveLength(0);
  });
});

describe("played from HAND, it attaches nothing", () => {
  it("enters play unworn — the sentence says 'from face down'", () => {
    // The other half of the reading. Without this the trigger could be attaching
    // on every play and the tests above would not notice.
    const gear = createCardInstance(registry.get(EDGE_OF_NIGHT));
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [gear];
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    }));
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === gear.instanceId,
    );
    expect(play, "the hand play was never offered").toBeDefined();
    const after = answerDecisions(resolveHeldTriggers(submit(state, play!).state));

    expect(wornBy(after, gear.instanceId), "a hand play attached it anyway").toBeNull();
  });
});
