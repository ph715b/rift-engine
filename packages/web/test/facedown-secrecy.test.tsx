import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
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

/**
 * The opponent's facedown card (rule 811) must show that it is THERE and not
 * WHAT it is.
 *
 * This is the one branch in the whole app keeping that true. The state reaching
 * the board is not masked — `maskHiddenCards` exists in the engine but is not
 * exported from its index (`typeof m.maskHiddenCards` on the built dist is
 * `undefined`), so `h.card` carries the real identity for both players and
 * `mine ? h.card.name : "Facedown"` IS the protection, in the label and in the
 * `title` alike.
 *
 * It had never been exercised: a live Playwright driver (`facedown.mjs`) ran 400
 * steps without an enemy facedown card ever reaching the board, so that branch
 * was UNVERIFIED rather than verified. Driving it deliberately here is the point
 * — a rare branch sampled on a schedule that never runs reports 0/0, which reads
 * exactly like a pass.
 *
 * The card is a real registry card rather than a stub, so a leak would surface
 * as its real printed name — the thing a player would actually see.
 */

const registry = defaultCardRegistry();
const SECRET = registry.get("OGN-057"); // Block — a [Hidden] card, so a plausible facedown

/** A real game state, built through `createNewGame` rather than as an object
 *  literal. A hand-built literal is how three headless probes drifted out of
 *  sync with `GameState` while still reporting plausible numbers. */
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

function renderBattlefield(props: ReturnType<typeof withFacedown>) {
  return render(
    <BattlefieldView
      {...props}
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
    />,
  );
}

/** Every string the rendered subtree can show a player: text plus the attributes
 *  that surface on hover or to a screen reader. A name check on `textContent`
 *  alone would have missed the `title`, which is half of what this branch
 *  covers. */
function everythingVisible(container: HTMLElement): string {
  const attributes = [...container.querySelectorAll("*")].flatMap((el) =>
    ["title", "aria-label", "alt", "value"].map((name) => el.getAttribute(name) ?? ""),
  );
  return [container.textContent ?? "", ...attributes].join(" | ");
}

describe("an opponent's facedown card leaks neither its name nor a naming tooltip", () => {
  it("shows the card is there", () => {
    // Gate on the branch actually rendering. Without this the two assertions
    // below would pass just as happily against a battlefield that drew nothing
    // at all, which is the 0/0-reads-as-a-pass failure.
    const { container } = renderBattlefield(withFacedown(1));
    expect(container.querySelectorAll(".facedown-card")).toHaveLength(1);
    expect(container.textContent).toContain("Facedown");
    cleanup();
  });

  it("never names it, in text or in any attribute", () => {
    const { container } = renderBattlefield(withFacedown(1));
    expect(everythingVisible(container)).not.toContain(SECRET.name);
    cleanup();
  });

  it("DOES name the viewer's own — the positive control", () => {
    // Without this the test above would pass against a component that rendered
    // nothing readable at all, or against a query that cannot see names.
    const { container } = renderBattlefield(withFacedown(0));
    expect(everythingVisible(container)).toContain(SECRET.name);
    cleanup();
  });

  it("marks only the viewer's own as theirs", () => {
    const theirs = renderBattlefield(withFacedown(1));
    expect(theirs.container.querySelector(".facedown-card.mine")).toBeNull();
    cleanup();
    const mine = renderBattlefield(withFacedown(0));
    expect(mine.container.querySelector(".facedown-card.mine")).not.toBeNull();
    cleanup();
  });
});
