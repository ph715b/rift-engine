import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { BattlefieldView } from "../src/components/BattlefieldView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { battlefieldCard } from "../src/battlefield-cards.js";
import { allPresetDecks, presetDeckList, type BattlefieldState } from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";

/**
 * Hovering a battlefield shows its card in the same preview a unit gets.
 *
 * This is where the battlefield's ability TEXT now lives. It used to sit clamped
 * to three lines beside a 2.4rem thumbnail; when the card became full size there
 * was no room for it on the board, and three lines could not show a long ability
 * anyway. So the board owes the art and the preview owes the text — and a card
 * whose ability is unreadable is the exact complaint that put the card on the
 * board in the first place ("not sure if battlefield abilities are working"),
 * which is why this is tested rather than assumed.
 */

const BATTLEFIELD = "Zaun Warrens";

afterEach(cleanup);

function renderBattlefield() {
  // Built through the real setup path rather than as a state literal — the same
  // reason its sibling tests do, and the reason three headless probes once
  // drifted out of sync with GameState while reporting plausible numbers.
  const [first, second] = allPresetDecks();
  const state = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    12345,
  );
  const card = battlefieldCard(BATTLEFIELD)!;
  const bf: BattlefieldState = {
    ...state.battlefields[0]!,
    name: BATTLEFIELD,
    units: {},
    hiddenCards: [],
  };
  return {
    card,
    ...render(
      <HoverPreviewProvider>
        <BattlefieldView
          battlefield={bf}
          human={state.players[0]!}
          ai={state.players[1]!}
          selectedUnitIds={new Set()}
          isMoveTarget={false}
          isTargetable={false}
          isChainTargeted={false}
          isChainSource={false}
          isDragOver={false}
          humanIndex={0}
          isShowdownActive={false}
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
        />
      </HoverPreviewProvider>,
    ),
  };
}

describe("hovering a battlefield previews its card", () => {
  it("shows nothing until it is hovered", () => {
    const { container } = renderBattlefield();
    expect(container.querySelector(".card-preview"), "the preview was open before any hover").toBeNull();
  });

  it("opens the preview with the battlefield's NAME and its full ability text", () => {
    const { container, card } = renderBattlefield();
    const board = container.querySelector(".battlefield-card")!;
    expect(board, "the battlefield's own card is not on the board").not.toBeNull();

    fireEvent.mouseEnter(board);

    const preview = container.querySelector(".card-preview");
    expect(preview, "hovering the battlefield opened no preview").not.toBeNull();
    expect(preview!.querySelector(".card-preview-name")?.textContent).toBe(BATTLEFIELD);
    // The FULL text, not a three-line clamp — that is the point of the move.
    expect(preview!.querySelector(".card-preview-text")?.textContent).toBe(card.text);
    expect(preview!.querySelector(".card-preview-art")?.getAttribute("src")).toBe(card.imageUrl);
  });

  it("closes again when the pointer leaves", () => {
    const { container } = renderBattlefield();
    const board = container.querySelector(".battlefield-card")!;

    fireEvent.mouseEnter(board);
    expect(container.querySelector(".card-preview")).not.toBeNull();
    fireEvent.mouseLeave(board);
    expect(container.querySelector(".card-preview"), "the preview stuck open after mouseleave").toBeNull();
  });

  /**
   * A battlefield has no costs and no Might. The card branch of the overlay reads
   * `card.energyCost` and friends, so a battlefield routed through it would throw
   * or render three empty badges — this is the assertion that keeps the two
   * branches genuinely separate.
   */
  it("shows no cost or Might badges — a battlefield has none", () => {
    const { container } = renderBattlefield();
    fireEvent.mouseEnter(container.querySelector(".battlefield-card")!);

    const badges = [...container.querySelectorAll(".card-preview .stat-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["Battlefield"]);
  });
});
