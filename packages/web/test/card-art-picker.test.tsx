import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createCardInstance, defaultCardRegistry, loadAlternateArt, type CardInstance } from "@rift-engine/engine";
import { CardView } from "../src/components/CardView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { chooseArt, chosenArt, chosenPrintingId, hasAlternateArt, printingsFor, resetArtCacheForTests } from "../src/card-art.js";

/**
 * Choosing a card's alternate-art printing, and having the board honour it.
 *
 * Reported from playtesting: there is no way to pick a card's alternate art. The
 * pool prints 99 of them and every one is dropped from the registry by
 * `shouldSkip` — correctly, since an alternate is the same card — so the art was
 * loadable and unreachable. `engine/test/alternate-art.test.ts` pins the loader
 * and the id join; this file pins the two things a player experiences: the
 * CHOICE persists, and the card PAINTS it.
 *
 * # Why this is not stored on the DeckList
 *
 * Art changes no legality, no cost and no identity. Putting it on `DeckList`
 * would widen a type the engine validates, that the `.deck` importer produces,
 * and that gets exported to other machines — carrying one player's taste with it.
 * It is a per-card profile preference beside `profile.ts`'s decks, and it applies
 * everywhere the card appears, including in preset decks the profile never
 * stores.
 */

const registry = defaultCardRegistry();

/** A real card that HAS an alternate printing, taken from the loader rather than
 *  hardcoded — a hardcoded id would rot the first time a set file is regenerated. */
const [WITH_ALT] = [...loadAlternateArt().keys()].filter((id) => registry.tryGet(id)?.type === "Unit");
/** …and one that does not, for the negative control. */
const WITHOUT_ALT = registry.all().find((d) => d.type === "Unit" && !loadAlternateArt().has(d.id))!.id;

/**
 * The engine's OWN factory, not a spread of the definition with a cast on it.
 *
 * Two things went wrong writing this fixture by hand, and both are the kind that
 * look like a broken feature:
 *
 *  - **A definition carries `id`; an instance carries `defId`.** Spreading the
 *    definition alone leaves `card.defId === undefined`, so `tryGet(undefined)`
 *    finds nothing and EVERY assertion in this file fails identically —
 *    including the ones about the default printing, which are nothing to do with
 *    alternate art.
 *  - **They do not overlap at all.** A definition has `type: "Unit"`, an instance
 *    has `kind: "Unit"` plus `exhausted` and `isToken`, so `as CardInstance` is a
 *    genuine type error — one `tsc` catches and `vitest` does not, which is how
 *    this suite ran green while `npm run typecheck` was red.
 */
function instance(defId: string): CardInstance {
  return { ...createCardInstance(registry.get(defId)), instanceId: `i-${defId}` };
}

function renderCard(defId: string) {
  return render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <CardView card={instance(defId)} inPile />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );
}

const artSrc = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src");

beforeEach(() => {
  localStorage.clear();
  resetArtCacheForTests();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetArtCacheForTests();
});

describe("the printing choice", () => {
  it("offers the default FIRST, then the alternates", () => {
    // Default-first is what lets "which am I on" be a position in one list rather
    // than a flag plus a list, which is what the cycling control counts through.
    const def = registry.get(WITH_ALT!);
    const printings = printingsFor(def.id, def.name, def.imageUrl ?? "");
    expect(printings.length, "a card with an alternate offered no choice").toBeGreaterThan(1);
    expect(printings[0]!.id, "the default printing is not first").toBe(def.id);
    expect(printings[0]!.imageUrl, "the default entry is not the registry's own art").toBe(def.imageUrl);
  });

  it("offers NOTHING for a card with no alternate", () => {
    // The negative control, and the reason the control is conditional in the UI:
    // most of the pool has one printing, and a 1/1 badge on every tile would be
    // noise on hundreds of cards.
    expect(hasAlternateArt(WITHOUT_ALT), "a card with no alternate reported one").toBe(false);
    const def = registry.get(WITHOUT_ALT);
    expect(printingsFor(def.id, def.name, def.imageUrl ?? ""), "a fake choice was offered").toEqual([]);
  });

  it("records a choice and reads it back", () => {
    const alt = loadAlternateArt().get(WITH_ALT!)![0]!;
    expect(chosenArt(WITH_ALT!), "something was chosen before anything was picked").toBeUndefined();

    chooseArt(WITH_ALT!, alt.id);
    expect(chosenPrintingId(WITH_ALT!)).toBe(alt.id);
    expect(chosenArt(WITH_ALT!), "the chosen art is not the alternate's").toBe(alt.imageUrl);
  });

  it("clears back to the default when the default is chosen again", () => {
    // The cycle wraps, so this is the second click on a two-printing card and has
    // to leave NO stored preference — a stored "default" would pin the card
    // against a future set adding a third printing.
    const alt = loadAlternateArt().get(WITH_ALT!)![0]!;
    chooseArt(WITH_ALT!, alt.id);
    chooseArt(WITH_ALT!, WITH_ALT!);
    expect(chosenArt(WITH_ALT!), "the default choice was stored rather than cleared").toBeUndefined();
    expect(JSON.parse(localStorage.getItem("rift-engine.cardArt") ?? "{}"), "storage kept a no-op entry").toEqual({});
  });

  it("survives a reload", () => {
    const alt = loadAlternateArt().get(WITH_ALT!)![0]!;
    chooseArt(WITH_ALT!, alt.id);
    resetArtCacheForTests(); // the in-memory copy is gone, as after a refresh
    expect(chosenArt(WITH_ALT!), "the choice did not persist").toBe(alt.imageUrl);
  });

  it("treats corrupted storage as no preference rather than crashing", () => {
    localStorage.setItem("rift-engine.cardArt", "{ not json");
    resetArtCacheForTests();
    expect(() => chosenArt(WITH_ALT!)).not.toThrow();
    expect(chosenArt(WITH_ALT!)).toBeUndefined();
  });
});

describe("the board paints the chosen printing", () => {
  it("shows the registry's art by default", () => {
    const { container } = renderCard(WITH_ALT!);
    expect(artSrc(container), "the default card did not paint its printed art").toBe(registry.get(WITH_ALT!).imageUrl);
  });

  it("...and the ALTERNATE once chosen — the choice is real", () => {
    // The control that makes the test above mean something: without it, "the card
    // painted an image" is true of any card at all.
    const alt = loadAlternateArt().get(WITH_ALT!)![0]!;
    chooseArt(WITH_ALT!, alt.id);
    const { container } = renderCard(WITH_ALT!);
    expect(artSrc(container), "the board ignored the chosen printing").toBe(alt.imageUrl);
    expect(artSrc(container), "the board painted the default anyway").not.toBe(registry.get(WITH_ALT!).imageUrl);
  });

  it("repaints a MOUNTED card when the choice changes", () => {
    // The subscription, not merely the read. The picker lives in the deck builder
    // and the card can be on screen elsewhere; a version that only read at mount
    // would look correct in every test that renders after choosing, and do
    // nothing in the app.
    const alt = loadAlternateArt().get(WITH_ALT!)![0]!;
    const { container } = renderCard(WITH_ALT!);
    expect(artSrc(container)).toBe(registry.get(WITH_ALT!).imageUrl);

    // Wrapped in `act`, because the store notifies OUTSIDE a React event here.
    // In the app the click IS a React event and flushes on its own; in jsdom an
    // unwrapped update is merely scheduled, and the assertion below would read a
    // stale DOM and report a working subscription as broken.
    act(() => chooseArt(WITH_ALT!, alt.id));
    expect(artSrc(container), "a card already on screen did not repaint").toBe(alt.imageUrl);
  });

  it("leaves a card with no alternate alone", () => {
    const { container } = renderCard(WITHOUT_ALT);
    expect(artSrc(container)).toBe(registry.get(WITHOUT_ALT).imageUrl);
  });
});
