import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  allPresetDecks,
  createCardInstance,
  defaultCardRegistry,
  describeChain,
  legalActions,
  presetDeckList,
  submit,
  type GameState,
  type UnitInstance,
} from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import { chainHighlight } from "../src/chain-highlight.js";

/**
 * **What the chain lights up, and in what role.**
 *
 * A triggered ability was the one chain item the board could say nothing about.
 * It carries no targets — the engine pushes triggers already-finalized — so the
 * highlight loop skipped it, and the player got a `⚡` row naming a card they then
 * had to find among thirty on the board. The effect arrived from an unidentified
 * direction, which is the same complaint the log and the play announcer answered.
 *
 * # Driven against a REAL chain
 *
 * The trigger here is Teemo's defend trigger, produced by submitting a real
 * from-hidden play into a running combat — the same driver
 * `hidden-defender-trigger.test.tsx` uses, and for the same reason. A hand-built
 * `ChainItemDescription` would only prove this function can read a shape this
 * file invented; the shape that matters is the one `describeChain` emits.
 */

const registry = defaultCardRegistry();
const TEEMO_STRATEGIST = "OGN-121";
const FILLER_UNIT = "OGN-002";
const HUMAN_INDEX = 0;

/** A real unit instance — a definition and an instance are different shapes, and
 *  the engine's own factory is the only thing that knows which. */
function unit(instanceId: string, name: string, might: number): UnitInstance {
  const made = createCardInstance(registry.get(FILLER_UNIT)) as UnitInstance;
  return { ...made, instanceId, name, might };
}

/** The AI contests bf1, the human garrisons it and holds Focus, and Teemo is
 *  facedown there from a turn earlier. Mutated from a real `createNewGame`
 *  rather than written as a literal, for the reason its sibling records. */
function boardWithHiddenDefender(): GameState {
  const [first, second] = allPresetDecks();
  const base = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    4242,
  );
  const teemo = createCardInstance(registry.get(TEEMO_STRATEGIST));
  const humanId = base.players[HUMAN_INDEX]!.id;
  const aiId = base.players[1]!.id;

  return {
    ...base,
    phase: "Action",
    activePlayerIndex: 1,
    turnState: "Showdown",
    showdownKind: "Combat",
    showdownBattlefieldId: base.battlefields[0]!.id,
    chainOpen: false,
    focusHolder: HUMAN_INDEX,
    chainPriority: HUMAN_INDEX,
    turnNumber: base.turnNumber + 1,
    battlefields: base.battlefields.map((b, i) =>
      i !== 0
        ? b
        : {
            ...b,
            controllerId: humanId,
            contestedByIndex: 1 as const,
            designatedInstanceIds: ["garrison", "raider"],
            units: {
              [humanId]: [unit("garrison", "Garrison", 2)],
              [aiId]: [unit("raider", "Raider", 3)],
            },
            hiddenCards: [{ card: teemo, ownerIndex: HUMAN_INDEX, hiddenOnTurn: base.turnNumber }],
          },
    ),
  };
}

/** The state with Teemo's defend trigger genuinely sitting on the chain. */
function stateWithTriggerOnChain(): GameState {
  const state = boardWithHiddenDefender();
  const play = legalActions(state).find((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);
  expect(play, "no from-hidden play was offered — this file would measure nothing").toBeDefined();
  const after = submit(state, play!);
  expect(after.result.type, "the from-hidden play was refused").toBe("Ok");
  return after.state;
}

describe("a trigger on the chain points at the card that CAUSED it", () => {
  it("names the listener as a source", () => {
    const items = describeChain(stateWithTriggerOnChain());
    const triggers = items.filter((i) => i.kind === "trigger");
    // **The control.** Without a trigger actually on the chain, "no sources" and
    // "the function is broken" are the same result.
    expect(triggers.length, "no trigger reached the chain — nothing to highlight").toBeGreaterThan(0);

    const { sources } = chainHighlight(items, null);
    for (const trigger of triggers) {
      expect(
        sources.has(trigger.entry.listenerInstanceId),
        `the chain named ${trigger.cardName} and the board pointed at nothing`,
      ).toBe(true);
    }
  });

  it("does NOT call the source a target", () => {
    // The two are opposite claims — "this is about to DO something" against
    // "something is about to happen TO this" — and the board draws them
    // differently. Folding them together would say the wrong one half the time.
    const items = describeChain(stateWithTriggerOnChain());
    const triggers = items.filter((i) => i.kind === "trigger");
    expect(triggers.length, "no trigger on the chain").toBeGreaterThan(0);

    const { units } = chainHighlight(items, null);
    for (const trigger of triggers) {
      expect(
        units.has(trigger.entry.listenerInstanceId),
        "a trigger's source was highlighted as its target",
      ).toBe(false);
    }
  });

  it("finds no source at all in a chain with no triggers", () => {
    // An empty chain is the honest floor: the highlight is derived, never
    // remembered, so nothing lingers once the chain drains.
    expect(chainHighlight([], null).sources.size, "an empty chain highlighted something").toBe(0);
  });
});

describe("hovering one item narrows the board to that item", () => {
  it("restricts the highlight to the hovered item's own concerns", () => {
    /**
     * With several items up, the union answers "what does the chain touch" but
     * never "which item means which" — and that pairing is the entire reason to
     * hover. It is also why this board does not need target arrows: the Java
     * client drew real ones and its own comment records that they only sometimes
     * appeared.
     */
    const items = describeChain(stateWithTriggerOnChain());
    if (items.length === 0) return;

    const whole = chainHighlight(items, null);
    const narrowed = chainHighlight(items, 0);
    const size = (h: ReturnType<typeof chainHighlight>) => h.units.size + h.battlefields.size + h.sources.size;

    expect(size(narrowed), "hovering an item widened the highlight").toBeLessThanOrEqual(size(whole));
    // And it is the hovered item's OWN concerns, not an arbitrary subset.
    const first = items[0]!;
    if (first.kind === "trigger") {
      expect(narrowed.sources.has(first.entry.listenerInstanceId), "hovering a trigger lost its source").toBe(true);
    }
  });

  it("an out-of-range hover highlights nothing rather than everything", () => {
    // `slice` past the end yields an empty array, which is the safe direction:
    // a stale index from a chain that just drained lights nothing up, instead of
    // falling back to the union and pointing at the whole board.
    const items = describeChain(stateWithTriggerOnChain());
    const stale = chainHighlight(items, items.length + 3);
    expect(stale.units.size + stale.battlefields.size + stale.sources.size, "a stale hover lit the board up").toBe(0);
  });
});

describe("the rail's width and the room made for it cannot drift apart", () => {
  /**
   * **The bug this pins is silent and was the original complaint.** The chain is
   * an overlay over the left of the centre column, and the left battlefield lives
   * under it — so a trigger firing during a combat there hid the cards being
   * fought over, at the moment they mattered most. The fix insets the column by
   * the rail's width instead of covering it.
   *
   * Two numbers now have to agree: how wide the panel is, and how much room is
   * reserved. If they drift, the board is either inset with no panel in the gap
   * or covered by a panel with no gap — and neither shows up in a type error, a
   * render test, or jsdom, which applies no stylesheet at all. Naming one custom
   * property in both places is what makes them unable to disagree, so THAT is
   * what is asserted.
   *
   * It reads the stylesheet as text deliberately. There is no computed style to
   * ask: this suite renders into jsdom, which never loads `styles.css`.
   */
  // Located from the working directory rather than from `import.meta.url`: under
  // this suite's transform that URL is not a `file:` one, and `fileURLToPath`
  // throws on it. The two candidates cover being run from the package and from
  // the repo root, which the root `npm test` does.
  const stylesheet = ["src/styles.css", "packages/web/src/styles.css"]
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  expect(stylesheet, "styles.css was not found from either root — this suite would measure nothing").toBeDefined();
  const css = readFileSync(stylesheet!, "utf8");

  const ruleBody = (selector: string): string => {
    const at = css.indexOf(selector + " {");
    expect(at, `${selector} is not in the stylesheet at all`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("sizes the panel from the shared variable", () => {
    expect(ruleBody(".chain-panel"), "the panel has its own hardcoded width again").toContain(
      "var(--chain-rail-w)",
    );
  });

  it("reserves the same variable's width on the column", () => {
    const inset = ruleBody(".board-center.chain-inset");
    expect(inset, "the inset is not derived from the rail width").toContain("var(--chain-rail-w)");
    expect(inset, "the inset is not a horizontal one — height is the scarce dimension here").toContain(
      "padding-left",
    );
  });

  it("defines that variable exactly once", () => {
    // Two definitions is how they drift: one gets updated and the other does not.
    const definitions = css.match(/--chain-rail-w:/g) ?? [];
    expect(definitions.length, "--chain-rail-w is defined more than once").toBe(1);
  });
});
