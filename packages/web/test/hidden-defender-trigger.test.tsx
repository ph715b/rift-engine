import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  actingPlayerIndex,
  allPresetDecks,
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  presetDeckList,
  submit,
  type GameState,
  type UnitInstance,
} from "@rift-engine/engine";
import { BattlefieldView } from "../src/components/BattlefieldView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { createNewGame } from "../src/game-setup.js";

/**
 * **Playing a `[Hidden]` DEFENDER into a running combat.**
 *
 * Reported from playtesting: *"teemo strategist trigger did not go off wehen
 * playing from hidden"* — the opponent opened a Showdown at the battlefield he
 * was hidden at, and he was defending.
 *
 * The engine does this correctly, and that was measured before this file existed:
 * he is late-designated (464.2.c Step 1's second sentence), his defend trigger
 * reaches the chain, and on resolution it deals 1 per `[Hidden]` card revealed.
 * So the remaining suspect was the BOARD — the recurring shape where a mechanic
 * is correct, tested and reported exercised while a human has nothing to click.
 * Every instrument here drives `submit`; none renders a component.
 *
 * # What this file can and cannot assert
 *
 * `GameBoard` takes a `MatchConfig` and builds its own game, so a mid-Showdown
 * board cannot be handed to it — the two render tests this file first tried were
 * measuring nothing. The affordance itself lives in `BattlefieldView`, which IS
 * renderable on its own, so that is where the "does a human have something to
 * click" question is asked.
 *
 * The engine half goes through `submit` rather than through internals, because
 * that is the call the board actually makes.
 */

const registry = defaultCardRegistry();
const TEEMO_STRATEGIST = "OGN-121";
const FILLER_UNIT = "OGN-002";
const HUMAN_INDEX = 0;

afterEach(cleanup);

/** A REAL unit instance. Hand-written object literals were tried first and
 *  crashed inside `effectiveKeywords` on a missing field — a definition and an
 *  instance are different shapes, and the engine's own factory is the only thing
 *  that knows which. */
function unit(instanceId: string, name: string, might: number): UnitInstance {
  const made = createCardInstance(registry.get(FILLER_UNIT)) as UnitInstance;
  return { ...made, instanceId, name, might };
}

/**
 * A live game rewritten so the AI has contested bf1, the human garrisons it and
 * holds Focus, and Teemo is FACEDOWN there from a turn earlier.
 *
 * Mutated from a real `createNewGame` rather than written as a state literal —
 * the same reason its sibling tests do it, and the reason three headless probes
 * once drifted out of sync with GameState while reporting plausible numbers.
 */
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
    // The human holds Focus, which is what makes the from-hidden play legal —
    // `actingPlayerIndex` reads focusHolder during a Showdown.
    focusHolder: HUMAN_INDEX,
    chainPriority: HUMAN_INDEX,
    // A turn has passed since he was hidden (811's "the next turn").
    turnNumber: base.turnNumber + 1,
    battlefields: base.battlefields.map((b, i) =>
      i !== 0
        ? b
        : {
            ...b,
            controllerId: humanId,
            // `attackerIndexAt` reads THIS, not the unit lists. Without it the
            // late-designation path returns early and the whole test measures
            // nothing — which is how the first engine-side repro of this report
            // came back green for the wrong reason.
            contestedByIndex: 1 as const,
            // The combat is already RUNNING and these two are already in it, so
            // Teemo arrives as a late addition rather than riding the opening
            // designation. That distinction is the entire report.
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

describe("the ENGINE offers and honours the play", () => {
  it("offers a from-hidden play while the opponent's showdown runs", () => {
    // The precondition, asserted separately so "the board shows nothing" can be
    // told apart from "the engine offers nothing". Different bugs, different
    // owners, identical on screen.
    const state = boardWithHiddenDefender();
    expect(actingPlayerIndex(state), "the human does not hold Focus — the rest of this file is vacuous").toBe(HUMAN_INDEX);

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);
    expect(plays.length, "no from-hidden play was offered in the opponent's showdown").toBeGreaterThan(0);
  });

  it("puts the defend trigger on the chain when the play is submitted", () => {
    const state = boardWithHiddenDefender();
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined)!;
    const after = submit(state, play);

    expect(after.result.type, "the from-hidden play was refused").toBe("Ok");
    expect(
      after.state.battlefields[0]!.designatedInstanceIds ?? [],
      "the arriving defender was never designated",
    ).toContain(play.type === "PlayCard" ? play.card.instanceId : "");
    const chain = after.state.spellChain.map((e) => ("listenerName" in e ? e.listenerName : "spell"));
    expect(chain, "Teemo's defend trigger never reached the chain").toContain("Teemo - Strategist");
  });
});

describe("the BOARD gives a human something to click", () => {
  /**
   * `offered` rather than a ready-made Set, because `createCardInstance` mints a
   * fresh instanceId per call: a set built outside this function names a Teemo
   * that is not the one being rendered, and every assertion then passes or fails
   * for the wrong reason.
   */
  function renderBattlefield(offered: boolean, onPlayHidden = (_id: string, _bf: string) => {}) {
    const state = boardWithHiddenDefender();
    const teemoId = state.battlefields[0]!.hiddenCards[0]!.card.instanceId;
    const playable = offered ? new Set([teemoId]) : new Set<string>();
    return {
      teemoId,
      battlefieldId: state.battlefields[0]!.id,
      ...render(
        <HoverPreviewProvider>
          <DragGhostProvider>
          <BattlefieldView
            battlefield={state.battlefields[0]!}
            human={state.players[0]!}
            ai={state.players[1]!}
            selectedUnitIds={new Set()}
            isMoveTarget={false}
            isTargetable={false}
            isChainTargeted={false}
            isChainSource={false}
            isDragOver={false}
            humanIndex={0}
            isShowdownActive
            isUnitTargetable={() => false}
            isUnitChainTargeted={() => false}
            isUnitChainSource={() => false}
            isFriendlySelectable={() => false}
            chosenUnitIds={new Set()}
            onUnitClick={() => {}}
            onMoveHere={() => {}}
            canDragUnit={() => false}
            onUnitDrag={() => {}}
            onUnitDragEnd={() => {}}
            playableHiddenIds={playable}
            onPlayHidden={onPlayHidden}
          />
          </DragGhostProvider>
        </HoverPreviewProvider>,
      ),
    };
  }

  it("renders the human's own facedown card as SELECTABLE when the engine offers it", () => {
    const { container } = renderBattlefield(true);
    const mine = container.querySelectorAll(".facedown-card.mine");
    expect(mine.length, "the human's own facedown card did not render at all").toBeGreaterThan(0);
    expect(
      [...mine].some((el) => el.classList.contains("selectable")),
      "the facedown card rendered but was not playable — the human had nothing to click",
    ).toBe(true);
  });

  it("...and NOT selectable when the engine is not offering it", () => {
    // The control. Without it, "selectable" above could be a class the facedown
    // card always carries.
    const { container } = renderBattlefield(false);
    const mine = container.querySelectorAll(".facedown-card.mine");
    expect(mine.length).toBeGreaterThan(0);
    expect(
      [...mine].some((el) => el.classList.contains("selectable")),
      "a facedown card the engine refuses was still offered",
    ).toBe(false);
  });

  it("calls back with the card and its battlefield when clicked", () => {
    const calls: [string, string][] = [];
    const { container, teemoId, battlefieldId } = renderBattlefield(true, (id: string, bf: string) => calls.push([id, bf]));
    fireEvent.click(container.querySelector(".facedown-card.mine.selectable") as HTMLElement);
    expect(calls.length, "clicking the facedown card did nothing").toBe(1);
    expect(calls[0]![0], "the callback named a different card").toBe(teemoId);
    // Read off the STATE, not written as a literal: the web's `createNewGame`
    // names battlefields `bf-0`, the engine test fixtures name them `bf1`, and a
    // hardcoded id here fails against a working board.
    expect(calls[0]![1], "the play was not tied to the battlefield it was hidden at").toBe(battlefieldId);
  });
});
