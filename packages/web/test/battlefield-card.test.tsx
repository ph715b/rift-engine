import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LEGACY_BATTLEFIELDS, loadBattlefieldDefinitions } from "@rift-engine/engine";
import { battlefieldCard } from "../src/battlefield-cards.js";

/**
 * A battlefield's ability has to be readable from inside a game.
 *
 * Reported as "not sure if battlefield abilities are working — would like the card
 * images visible so we can see what the abilities are". Both halves are real and
 * they are different problems:
 *
 *  - The abilities genuinely are NOT implemented. `BattlefieldState` carries a
 *    name, a controller and units, and no ability at all; `card-loader`'s
 *    `shouldSkip` excludes Battlefield-type cards from ever becoming a
 *    `CardDefinition`. That is tracked in docs/battlefields-and-ui-prompt.md.
 *  - But the art and text were already loadable and simply never shown outside the
 *    deck builder, which is what made the first half unanswerable from a game.
 *
 * This file guards the second half, and the lookup underneath it — a name-keyed
 * map silently returning `undefined` for everything would render exactly like a
 * feature nobody had built.
 */
describe("the battlefield card behind a battlefield in play", () => {
  it("resolves every battlefield the engine can put into play", () => {
    // The real risk in a name-keyed lookup is a name that no longer matches.
    // LEGACY_BATTLEFIELDS is what a deck falls back to, so those three must
    // resolve or the common case shows nothing.
    for (const name of LEGACY_BATTLEFIELDS) {
      expect(battlefieldCard(name), `${name} has no card`).toBeDefined();
    }
  });

  it("covers the whole printed battlefield pool, not just the legacy three", () => {
    const defs = loadBattlefieldDefinitions();
    expect(defs.length, "no battlefield definitions loaded at all").toBeGreaterThan(0);
    for (const def of defs) {
      expect(battlefieldCard(def.name)?.id, `${def.name} did not round-trip`).toBe(def.id);
    }
  });

  it("carries art and real rules text, which is the whole point", () => {
    const card = battlefieldCard("Zaun Warrens")!;
    expect(card.imageUrl).toMatch(/^https?:\/\//);
    // Not merely non-empty — the text is the thing the player asked to see.
    expect(card.text.length).toBeGreaterThan(10);
  });

  it("returns undefined for a name no card matches, rather than throwing", () => {
    // A deck file can name anything, and a battlefield with no art must still
    // render — the component treats undefined as "draw it the old way".
    expect(battlefieldCard("Not A Real Battlefield")).toBeUndefined();
  });
});

describe("BattlefieldView renders that card", () => {
  it("shows the art and the ability text", async () => {
    const { BattlefieldView } = await import("../src/components/BattlefieldView.js");
    const { createNewGame } = await import("../src/game-setup.js");
    const { allPresetDecks, presetDeckList } = await import("@rift-engine/engine");
    // Built through the real setup path rather than as a state literal — the same
    // reason facedown-secrecy.test.tsx does, and the reason three headless probes
    // once drifted out of sync with GameState while reporting plausible numbers.
    const [first, second] = allPresetDecks();
    const state = createNewGame(
      { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
      12345,
    );
    const bf = { ...state.battlefields[0]!, name: "Zaun Warrens" };

    cleanup();
    const { container } = render(
      <BattlefieldView
        battlefield={bf}
        human={state.players[0]!}
        ai={state.players[1]!}
        selectedUnitIds={new Set()}
        isMoveTarget={false}
        isTargetable={false}
        isChainTargeted={false}
        isDragOver={false}
        humanIndex={0}
        isShowdownActive={false}
        isUnitTargetable={() => false}
        isFriendlySelectable={() => false}
        chosenUnitIds={new Set()}
        onUnitClick={() => {}}
        onMoveHere={() => {}}
        canDragUnit={() => false}
        onUnitDrag={() => {}}
        onUnitDragEnd={() => {}}
        isUnitChainTargeted={() => false}
      />,
    );

    const art = container.querySelector(".battlefield-card-art");
    expect(art, "the battlefield's art was not rendered").not.toBeNull();
    expect(art!.getAttribute("src")).toBe(battlefieldCard("Zaun Warrens")!.imageUrl);
    expect(container.querySelector(".battlefield-card-text")?.textContent).toBe(
      battlefieldCard("Zaun Warrens")!.text,
    );
  });
});
