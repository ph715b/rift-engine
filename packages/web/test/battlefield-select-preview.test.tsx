import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { loadBattlefieldDefinitions } from "@rift-engine/engine";
import { BattlefieldSelect } from "../src/components/BattlefieldSelect.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { battlefieldCard } from "../src/battlefield-cards.js";

/**
 * Best of 3's per-game battlefield choice must SHOW the battlefields.
 *
 * Reported from playtesting: you cannot hover the battlefields on the pre-game
 * selector. The screen asked for a decision under rule 486.5 — "select one of
 * their three Battlefields" — and rendered three names in three buttons, with no
 * art and no rules text, when the printed ABILITY is the entire basis for
 * choosing one over another.
 *
 * The machinery all existed: `battlefieldCard` is the by-name lookup the board
 * already uses, and `HoveredCard` grew a `battlefield` variant when the card went
 * onto the board. This screen was simply never wired to either — the recurring
 * shape where a mechanic is correct in the engine and unreachable in the UI.
 *
 * # Two things asserted apart
 *
 * **The ART is on the button**, so the choice is legible without a gesture.
 * **The TEXT is on the hover**, in the same preview the board opens, so the
 * ability reads identically here and in game.
 */

afterEach(cleanup);

/** Three real battlefields with distinct names, art and text. */
const NAMES = loadBattlefieldDefinitions().slice(0, 3).map((d) => d.name);

function renderSelect(used: string[] = []) {
  return render(
    <HoverPreviewProvider>
      <BattlefieldSelect names={NAMES} used={used} seriesNote="Game 1 of 3" onSelect={() => {}} />
    </HoverPreviewProvider>,
  );
}

describe("the pre-game battlefield selector shows the cards", () => {
  it("paints each battlefield's art on its own option", () => {
    const { container } = renderSelect();
    const arts = [...container.querySelectorAll("img.battlefield-select-art")];
    expect(arts.length, "the selector rendered names with no art — the reported bug").toBe(NAMES.length);

    // The join: each option's art is the art of ITS battlefield, not merely
    // three images. A loop that painted the same card three times would pass a
    // bare count.
    for (const name of NAMES) {
      const card = battlefieldCard(name)!;
      expect(
        arts.some((img) => img.getAttribute("src") === card.imageUrl),
        `${name} is not painting its own card`,
      ).toBe(true);
    }
  });

  it("opens the board's own preview on hover, with the printed ability", () => {
    const { container } = renderSelect();
    const option = container.querySelectorAll("button.battlefield-select-option")[0] as HTMLElement;
    const card = battlefieldCard(NAMES[0]!)!;

    expect(container.querySelector(".card-preview"), "a preview was open before anything was hovered").toBeNull();
    fireEvent.mouseEnter(option);

    // **Scoped to `.card-preview`, and that is load-bearing rather than tidy.**
    // The option's own `<img>` carries the same `src`, so searching the whole
    // document for the url is true whether the preview is open or not — the
    // first version of this test did exactly that and its close assertion failed
    // against working code. The overlay is a sibling of the button, so the
    // element itself is the only honest subject.
    const preview = () => container.querySelector(".card-preview");
    expect(preview(), "hovering an option opened no preview").not.toBeNull();
    // Attributes and text both — the art is a `src`, the ability is prose, and a
    // previous web test in this repo passed three of four assertions by reading
    // only textContent.
    expect(preview()!.outerHTML, "the preview opened without this battlefield's art").toContain(card.imageUrl);
    expect(preview()!.textContent, "the preview showed no rules text").toContain(card.text.slice(0, 24));

    fireEvent.mouseLeave(option);
    expect(preview(), "the preview stayed open after the pointer left").toBeNull();
  });

  it("still names a battlefield the engine has no card for", () => {
    // The control that keeps the screen honest for imported decklists: a deck
    // file can name anything, and `battlefieldCard` returns undefined for a name
    // no card matches. The option must still render and still be clickable —
    // failing to find art is not failing to offer the choice.
    const { container } = render(
      <HoverPreviewProvider>
        <BattlefieldSelect names={["Some Unprinted Field"]} used={[]} seriesNote="Game 1 of 3" onSelect={() => {}} />
      </HoverPreviewProvider>,
    );
    const option = container.querySelector("button.battlefield-select-option");
    expect(option, "an unknown battlefield rendered no option at all").not.toBeNull();
    expect(option!.textContent, "the name was dropped along with the missing art").toContain("Some Unprinted Field");
    expect(container.querySelector("img.battlefield-select-art"), "art was invented for an unknown name").toBeNull();
    // And hovering it must not throw — the handlers are omitted, not called with
    // an undefined card.
    fireEvent.mouseEnter(option as HTMLElement);
  });

  it("greys a used battlefield's art without hiding it (486.5)", () => {
    // Used ones are shown rather than hidden so the pool narrowing over the match
    // reads as the rule working. That argument only holds if the card is still
    // visible — a hidden art would make game 3 look like a broken screen.
    const { container } = renderSelect([NAMES[0]!]);
    const used = container.querySelector("button.battlefield-select-option.used");
    expect(used, "a used battlefield was hidden rather than struck out").not.toBeNull();
    expect(used!.querySelector("img.battlefield-select-art"), "a used battlefield lost its art").not.toBeNull();
    expect((used as HTMLButtonElement).disabled, "a used battlefield was still selectable").toBe(true);
  });
});
