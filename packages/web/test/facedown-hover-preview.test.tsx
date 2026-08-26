import { describe, expect, it } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  allPresetDecks,
  createCardInstance,
  defaultCardRegistry,
  presetDeckList,
  type BattlefieldState,
  type PlayerState,
} from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import { BattlefieldView } from "../src/components/BattlefieldView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";

/**
 * **Hovering your own facedown card shows what it is. The opponent's shows
 * nothing.**
 *
 * Reported by the project owner: *"want to be able to hover over hidden cards
 * and see the card info."* A `title` tooltip carried the NAME and nothing else,
 * so the one thing worth knowing before spending a turn setting a trap — what
 * the card actually does — was unreadable once it was face down.
 *
 * # Why this file is separate from facedown-secrecy.test.tsx
 *
 * That file guards the branch that keeps the OPPONENT's card secret, and its own
 * header records that nothing masks the state: `h.card` carries the real
 * identity for both players, so `mine ? … : …` IS the protection. Raising a
 * hover preview is a NEW way to leak exactly that, through a channel the
 * existing assertions cannot see — `everythingVisible` reads the rendered
 * subtree, and a preview raised through React context is not in it.
 *
 * So this drives the hover channel directly, both ways round. The two files are
 * the same rule from two sides, and neither subsumes the other.
 */

const registry = defaultCardRegistry();
/** Block — a real `[Hidden]` card, so a leak surfaces as a printed name a player
 *  would actually recognise rather than as a stub. */
const SECRET = registry.get("OGN-057");

function board(): { battlefield: BattlefieldState; human: PlayerState; ai: PlayerState } {
  const [first, second] = allPresetDecks();
  const state = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    12345,
  );
  return { battlefield: state.battlefields[0]!, human: state.players[0]!, ai: state.players[1]! };
}

function withFacedown(ownerIndex: 0 | 1) {
  const { battlefield, human, ai } = board();
  return {
    human,
    ai,
    battlefield: {
      ...battlefield,
      hiddenCards: [{ ownerIndex, card: createCardInstance(SECRET), hiddenOnTurn: 1 }],
    },
  };
}

/**
 * Renders inside the REAL provider; assertions read the preview overlay it puts
 * on screen.
 *
 * A first draft spied `useCardHover` instead. It did not work — `BattlefieldView`
 * binds the import directly, so the spy never reached it — and it was the worse
 * test anyway: it asserted which function was called rather than what the player
 * can see, which is what the report is about.
 */
function renderBoard(props: ReturnType<typeof withFacedown>) {
  const view = render(
    <HoverPreviewProvider>
      <BattlefieldView
        {...props}
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
  );
  return view;
}

const facedownButton = (container: HTMLElement) => container.querySelector(".facedown-card")!;
/** The overlay the provider renders while something is hovered, or null. */
const preview = (container: HTMLElement) => container.querySelector(".card-preview");

describe("your OWN facedown card previews on hover", () => {
  it("shows the card, with its RULES TEXT", () => {
    const view = renderBoard(withFacedown(0));
    const button = facedownButton(view.container);
    expect(button, "no facedown card rendered at all").not.toBeNull();
    expect(preview(view.container), "a preview was already up before any hover").toBeNull();

    fireEvent.mouseEnter(button);

    const shown = preview(view.container);
    expect(shown, "hovering your own facedown card showed nothing").not.toBeNull();
    expect(shown!.textContent, "the wrong card was previewed").toContain(SECRET.name);
    // The rules TEXT is the whole point of the report — the name was already on
    // the label and in the title, and a preview with only a name is what this
    // replaced.
    const printed = "text" in SECRET ? String(SECRET.text) : "";
    expect(printed.length, "the fixture card prints no text, so this proves nothing").toBeGreaterThan(0);
    expect(shown!.textContent, "the preview showed a name but no rules text").toContain(printed.slice(0, 24));
    cleanup();
  });

  it("clears on leave", () => {
    const view = renderBoard(withFacedown(0));
    fireEvent.mouseEnter(facedownButton(view.container));
    expect(preview(view.container), "the fixture never raised a preview to clear").not.toBeNull();

    fireEvent.mouseLeave(facedownButton(view.container));
    expect(preview(view.container), "the preview outlived the pointer").toBeNull();
    cleanup();
  });

  it("shows on FOCUS too, so the keyboard reaches it", () => {
    // These are real buttons and Tab reaches them; a preview only a mouse can
    // raise is half a feature.
    const view = renderBoard(withFacedown(0));
    fireEvent.focus(facedownButton(view.container));

    expect(preview(view.container)?.textContent, "focusing raised no preview").toContain(SECRET.name);
    cleanup();
  });
});

describe("the OPPONENT's facedown card previews NOTHING", () => {
  it("raises nothing on hover — the leak this would have been", () => {
    // The secrecy half, through the channel facedown-secrecy.test.tsx cannot
    // see. A handler attached for both sides would hand over the whole card,
    // rules text included, to anyone who moved a mouse.
    const view = renderBoard(withFacedown(1));
    const button = facedownButton(view.container);
    expect(button, "no facedown card rendered at all").not.toBeNull();

    fireEvent.mouseEnter(button);
    fireEvent.focus(button);

    expect(preview(view.container), "the opponent facedown card showed a preview").toBeNull();
    // And the name is nowhere in the subtree either — the belt the other file
    // already wears, re-asserted here because this file is the one that could
    // have broken it.
    expect(view.container.textContent, "the opponent card name leaked").not.toContain(SECRET.name);
    cleanup();
  });

  it("and the fixture really is the opponent's — the control", () => {
    // Without this, "raised nothing" would also be what a render with no
    // facedown card at all produces, and the assertion above would be vacuous.
    const view = renderBoard(withFacedown(1));
    const button = facedownButton(view.container);
    expect(button.className, "the card rendered as the human own").not.toContain("mine");
    expect(button.textContent, "the opponent card is not labelled Facedown").toContain("Facedown");
    cleanup();
  });
});
