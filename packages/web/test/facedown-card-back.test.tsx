import { describe, expect, it } from "vitest";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { render, cleanup } from "@testing-library/react";
import {
  allPresetDecks,
  createCardInstance,
  defaultCardRegistry,
  presetDeckList,
  type BattlefieldState,
} from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import { BattlefieldView } from "../src/components/BattlefieldView.js";

/**
 * A facedown card should read as a CARD BACK where a unit would be.
 *
 * It used to be a small pill in a strip under the battlefield name, which was a
 * considered choice and is recorded as one in styles.css: the board is a
 * fixed-height 100dvh column, and card-sized real estate "would push the
 * battlefield rows into the overflow this project keeps having to defend
 * against". Reported from playtesting as too easy to miss.
 *
 * The resolution is not to overrule that constraint but to sidestep it — the back
 * goes INSIDE the owner's unit row, which `use-row-fit.ts` already fans to its
 * available width, so it costs exactly what one more unit costs and adds no row.
 *
 * What this file guards is the placement (right row, owner-correct) and the fact
 * that a back is drawn at all. Secrecy has its own file, facedown-secrecy.test.tsx,
 * and is deliberately not duplicated here.
 */
const registry = defaultCardRegistry();

function boardWithHidden(ownerIndex: 0 | 1): {
  battlefield: BattlefieldState;
  human: ReturnType<typeof createNewGame>["players"][0];
  ai: ReturnType<typeof createNewGame>["players"][0];
} {
  const [first, second] = allPresetDecks();
  const state = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    4242,
  );
  const card = createCardInstance(registry.get("OGN-013"));
  const battlefield: BattlefieldState = {
    ...state.battlefields[0]!,
    hiddenCards: [{ card, ownerIndex } as BattlefieldState["hiddenCards"][number]],
  };
  return { battlefield, human: state.players[0]!, ai: state.players[1]! };
}

function renderView(ownerIndex: 0 | 1) {
  const { battlefield, human, ai } = boardWithHidden(ownerIndex);
  cleanup();
  return render(
    <HoverPreviewProvider>
    <BattlefieldView
      battlefield={battlefield}
      human={human}
      ai={ai}
      selectedUnitIds={new Set()}
      isMoveTarget={false}
      isTargetable={false}
      isChainTargeted={false}
      isDragOver={false}
      humanIndex={0}
      isShowdownActive={false}
      isUnitTargetable={() => false}
      isUnitChainTargeted={() => false}
      isFriendlySelectable={() => false}
      chosenUnitIds={new Set()}
      onUnitClick={() => {}}
      onMoveHere={() => {}}
      canDragUnit={() => false}
      onUnitDrag={() => {}}
      onUnitDragEnd={() => {}}
    />
    </HoverPreviewProvider>,
  );
}

describe("a facedown card renders as a card back in the unit row", () => {
  it("draws a back rather than only a label", () => {
    // The back is CSS-drawn on purpose: every card image here comes from Riot's
    // CMS and there is no back among them, so an <img> would be a guessed URL
    // that breaks silently. Asserting the element exists is what catches the
    // markup being reverted to a bare pill.
    const { container } = renderView(0);
    expect(container.querySelector(".facedown-card .facedown-back")).not.toBeNull();
  });

  it("no longer uses the separate strip row", () => {
    const { container } = renderView(0);
    expect(container.querySelector(".battlefield-hidden-row")).toBeNull();
  });

  it("puts YOUR facedown card in your own row, not the opponent's", () => {
    const { container } = renderView(0);
    const sides = container.querySelectorAll(".battlefield-side");
    expect(sides).toHaveLength(2);
    // The human's row renders second — the AI's side is on top of the board.
    expect(sides[0]!.querySelector(".facedown-card")).toBeNull();
    expect(sides[1]!.querySelector(".facedown-card")).not.toBeNull();
  });

  it("puts the OPPONENT's facedown card in the opponent's row", () => {
    const { container } = renderView(1);
    const sides = container.querySelectorAll(".battlefield-side");
    expect(sides[0]!.querySelector(".facedown-card")).not.toBeNull();
    expect(sides[1]!.querySelector(".facedown-card")).toBeNull();
  });
});
