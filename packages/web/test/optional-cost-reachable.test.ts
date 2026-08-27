import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  type GameState,
  type PlayCardAction,
  type RuneCard,
  type Domain,
} from "@rift-engine/engine";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import { costFlagAlternative, OPTIONAL_COST_FLAGS } from "../src/pending-match.js";

/**
 * **An optional cost a human can actually PAY.**
 *
 * `ui-can-express-every-choice.test.ts` asks whether the board READS a field.
 * That is necessary and it is not sufficient, which is the whole reason this file
 * exists beside it: adding a key to `OPTIONAL_COST_FLAGS` makes the field
 * mentioned, but the toggle only renders when `costFlagAlternative` actually
 * finds the other variant among the engine's candidates. A button that never
 * finds one never appears, and on screen that is indistinguishable from a card
 * that has no such cost — the same silence the six declared gaps had.
 *
 * So this drives the ENGINE's own enumeration and asks the board's own
 * derivation. Bard - Mercurial is the subject because he is the one axis of the
 * four that is a REGRESSION rather than a never-built: master's board expressed
 * `exhaustLegendPaid` and the rewrite on this branch did not carry it across, so
 * he was reachable once and then was not.
 */

const registry = defaultCardRegistry();
const BARD = "SFD-079"; // "You may exhaust your legend as an additional cost to play me."

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * A live game with Bard in the human's hand and the runes to pay for him.
 *
 * Mutated from a real `createNewGame` rather than written as a literal — the
 * reason its siblings give, and the reason three headless probes once drifted out
 * of sync with GameState while reporting plausible numbers.
 */
function boardWithBard(): { state: GameState; bardId: string } {
  const [first, second] = allPresetDecks();
  const base = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    99,
  );
  const bard = createCardInstance(registry.get(BARD));
  const state: GameState = {
    ...base,
    phase: "Action",
    activePlayerIndex: 0,
    players: [
      { ...base.players[0]!, hand: [bard], channeled: runes("Mind", 8) },
      base.players[1]!,
    ] as GameState["players"],
  };
  return { state, bardId: bard.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );

describe("Bard - Mercurial's Legend exhaust can be reached from the board", () => {
  it("the ENGINE offers both variants — the precondition", () => {
    // **The control.** Without both variants there is nothing for the board to
    // toggle between, and every assertion below would pass or fail for a reason
    // that has nothing to do with the UI.
    const { state, bardId } = boardWithBard();
    const variants = playsOf(state, bardId);

    expect(variants.length, "Bard was not playable at all — this file measures nothing").toBeGreaterThan(0);
    expect(variants.some((p) => p.exhaustLegendPaid === true), "no PAID variant offered").toBe(true);
    expect(variants.some((p) => (p.exhaustLegendPaid ?? false) === false), "no DECLINED variant offered").toBe(true);
  });

  it("the BOARD finds the paid variant, so the toggle renders", () => {
    // The half that was missing. The engine offered both all along; nothing on
    // the board could name the flag, so `costFlagAlternative` had no key to
    // search on and the button never existed.
    const { state, bardId } = boardWithBard();
    const alternative = costFlagAlternative(playsOf(state, bardId), {}, "exhaustLegendPaid");

    expect(alternative, "no alternative found — the toggle would not render").toBeDefined();
    expect(alternative!.exhaustLegendPaid, "the alternative is not the PAID variant").toBe(true);
  });

  it("and finds the way BACK, so the choice is not one-way", () => {
    // A toggle that can be turned on and not off is a trap: the player commits to
    // exhausting their Legend by exploring, with no way to undo short of
    // cancelling the whole play.
    const { state, bardId } = boardWithBard();
    const back = costFlagAlternative(playsOf(state, bardId), { exhaustLegendPaid: true }, "exhaustLegendPaid");

    expect(back, "the paid choice cannot be undone").toBeDefined();
    expect(back!.exhaustLegendPaid ?? false, "toggling back did not reach the declined variant").toBe(false);
  });

  it("offers no alternative on a card that has no such cost", () => {
    // The negative that stops the three above from being a property of
    // `costFlagAlternative` returning something for anything. An ordinary card
    // has one variant along this axis, so the button must NOT render for it.
    const { state } = boardWithBard();
    const other = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId !== BARD,
    );
    if (!other) return; // this seed's opening offers nothing else — the cases above still hold

    const alternatives = playsOf(state, other.card.instanceId);
    expect(
      costFlagAlternative(alternatives, {}, "exhaustLegendPaid"),
      `${other.card.name} offered a Legend-exhaust toggle it does not print`,
    ).toBeUndefined();
  });
});

describe("toggling one axis holds every OTHER settled choice fixed", () => {
  /**
   * **The mutant a single-axis card cannot kill.** Bard has one optional cost, so
   * with him on the board a candidate that matches on `exhaustLegendPaid` matches
   * on everything — and dropping the pairing guard entirely leaves every
   * assertion above green.
   *
   * It is not hypothetical: rule 820.1.c.2 makes a printed `[Repeat]` under a
   * Temporal Portal grant TWO instances paid separately, so `repeatPaid` and
   * `grantedRepeatPaid` are live on one play at once. Without the guard, turning
   * one on could silently jump to a candidate that also flipped the other — the
   * player pays a cost they never chose.
   *
   * Synthetic candidates here, deliberately. The property under test is SELECTION
   * among a list, not whether this code can read a shape the engine produces —
   * that is what the Bard cases above establish, on the engine's own enumeration.
   * Reaching a genuine two-axis board would need a Portal in play plus a printed
   * [Repeat] in hand, which tests the fixture rather than the guard.
   */
  const candidate = (flags: Partial<PlayCardAction>): PlayCardAction =>
    ({
      type: "PlayCard",
      playerIndex: 0,
      card: createCardInstance(registry.get(BARD)),
      payment: { energyRunes: [], powerRunes: [] },
      ...flags,
    }) as PlayCardAction;

  it("skips a candidate that also flips a different axis", () => {
    // Listed FIRST so a `find` with no guard takes it — the mutant's exact shape.
    const alsoFlipsAccelerate = candidate({ repeatPaid: true, acceleratePaid: true });
    const flipsOnlyRepeat = candidate({ repeatPaid: true });

    const found = costFlagAlternative([alsoFlipsAccelerate, flipsOnlyRepeat], { acceleratePaid: false }, "repeatPaid");

    expect(found, "no alternative found at all — the setup is wrong, not the guard").toBeDefined();
    expect(
      found!.acceleratePaid ?? false,
      "toggling [Repeat] silently turned [Accelerate] on as well — a cost the player never chose",
    ).toBe(false);
  });

  it("finds nothing when every candidate would disturb another axis", () => {
    // The honest outcome: no button, rather than a button that changes two things.
    const found = costFlagAlternative([candidate({ repeatPaid: true, acceleratePaid: true })], { acceleratePaid: false }, "repeatPaid");
    expect(found, "offered an alternative that flips an axis the player had settled").toBeUndefined();
  });
});

describe("every declared axis is one the board could actually toggle", () => {
  it("names a flag the engine can vary — an invented key renders nothing, silently", () => {
    /**
     * `costFlagAlternative` searches for a candidate differing in ONE key. A key
     * the enumerator never varies can never produce one, so the button is absent
     * on every card forever — which is exactly the failure the six gaps were, and
     * it leaves no trace to notice.
     *
     * Asserted against the engine's own enumerator surface rather than a roster:
     * `optional-cost-variants.test.ts` checks each key is a real
     * `PlayCardAction` field, and this checks the list is non-empty and shaped so
     * a lookup is possible at all. Together they mean a typo cannot survive.
     */
    for (const { key, on, off } of OPTIONAL_COST_FLAGS) {
      expect(on.length, `${key} has no ON label — the button would be blank`).toBeGreaterThan(0);
      expect(off.length, `${key} has no OFF label`).toBeGreaterThan(0);
      expect(on, `${key}'s two labels are identical — the button would not say what it does`).not.toBe(off);
    }
  });
});
