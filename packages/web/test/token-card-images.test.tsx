import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  BIRD_TOKEN,
  GOLD_TOKEN,
  RECRUIT_TOKEN,
  createGearToken,
  createToken,
  loadTokenArt,
  type CardInstance,
} from "@rift-engine/engine";
import { CardView } from "../src/components/CardView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * A token on the board must show its printed art.
 *
 * Reported from playtesting: token cards have no image. The cause was entirely
 * in the ENGINE's loaders and entirely invisible to the engine's own suite —
 * `loadTokenArt` carried a scan hardcoded to `/^Recruit\b/`, so it could only
 * ever produce one key, and `loadTokenDefinitions` kept the print number in its
 * `runtimeDefId` ("Recruit (271)" -> `TOKEN-RECRUIT (271)`), an id nothing mints.
 * `test/token-art.test.ts` in the engine pins both.
 *
 * This file is the half that answers the report as it was made: does the board
 * PAINT one. Nothing in the engine suite or the probes renders a component, so a
 * correct art map and a blank card can coexist indefinitely — the shape recorded
 * in "the web lags the engine".
 *
 * **A card's name and art are in ATTRIBUTES, not text.** `CardView` renders an
 * `<img src alt>`; `textContent` is empty for a card in a pile. Every assertion
 * here reads `outerHTML` or queries the img directly, which is the trap a
 * previous web test in this repo fell into and only caught via its positive
 * control.
 */

function renderCard(card: CardInstance) {
  return render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <CardView card={card} inPile />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );
}

/** The `<img>` a card paints its art into, or null when it fell back to a frame. */
function artOf(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector("img.card-art") ?? container.querySelector("img");
}

describe("a created token paints its printed art", () => {
  it("renders art for a Recruit — the one that always worked", () => {
    // The positive control that was ALREADY true before the fix. Without it,
    // "Sprite and Gold now render" could be a test that passes for any card.
    const { container } = renderCard(createToken(RECRUIT_TOKEN) as unknown as CardInstance);
    const img = artOf(container);
    expect(img, "the Recruit token rendered no image at all").not.toBeNull();
    expect(img!.getAttribute("src"), "the Recruit's art url is empty").toBeTruthy();
    cleanup();
  });

  it("renders art for a GOLD gear token — the reported gap", () => {
    // Gold is a GEAR token, minted by a different function, and eleven SFD cards
    // plus two battlefields create it. Before the fix its defId resolved to
    // nothing and it painted a blank frame.
    const { container } = renderCard(createGearToken(GOLD_TOKEN, false) as unknown as CardInstance);
    const img = artOf(container);
    expect(img, "the Gold token rendered no image at all").not.toBeNull();
    expect(img!.getAttribute("src"), "the Gold token still has no art").toBeTruthy();
    cleanup();
  });

  it("paints the art the ENGINE's map names, not merely some image", () => {
    // The join, asserted rather than assumed: an `<img>` with any src would pass
    // the two tests above even if the board were painting a placeholder.
    const art = loadTokenArt();
    const gold = createGearToken(GOLD_TOKEN, false) as unknown as CardInstance;
    const { container } = renderCard(gold);
    expect(artOf(container)!.getAttribute("src"), "the board is painting something other than the printed art").toBe(
      art[gold.defId],
    );
    cleanup();
  });

  it("falls back to a frame for a token the pool prints no card for", () => {
    // The honest control. Five of the eight tokens this engine mints are authored
    // from their makers' reminder text and have no printed card anywhere, so a
    // frame is CORRECT for them — and a test suite that did not say so would
    // invite someone to "fix" it with a placeholder.
    const bird = createToken(BIRD_TOKEN) as unknown as CardInstance;
    expect(loadTokenArt()[bird.defId], "the pool gained a printed Bird card — good news, update the engine's list").toBeUndefined();
    const { container } = renderCard(bird);
    const img = artOf(container);
    expect(img?.getAttribute("src") ?? "", "a token with no printed card painted an image from somewhere").toBeFalsy();
    // …and it must still render SOMETHING, rather than collapsing to nothing.
    expect(container.querySelector(".card"), "the fallback frame did not render").not.toBeNull();
    cleanup();
  });
});
