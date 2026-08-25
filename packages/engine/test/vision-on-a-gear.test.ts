import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { unitTriggerHasVisionChoice } from "../src/engine/unit-triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **`[Vision]`'s keyword machinery covers UNITS only, and exactly one Gear in the
 * pool prints the keyword.**
 *
 * **817.1.a**: *"It is present on Permanents"* — and a Gear is a Permanent. But
 * `applyVision` is private to `unit-triggers.ts` and reached only from
 * `dispatchOnPlayUnit`, and both `legal-actions` and `validate-play-card` gate the
 * `visionRecycle` fan-out on `card.kind === "Unit"`. So a Gear printing `[Vision]`
 * predicts nothing.
 *
 * **UNL-161 Divining Shells is that Gear, and it is not broken** — its `[Vision]`
 * half is implemented as a per-card parked decision in `effects/order.ts`. Its own
 * note argues that implementation is MORE conformant than the Unit path, and it is
 * right: **817.1.a** makes Vision a *triggered* ability, and **402.1** puts a
 * triggered ability's "you may" at RESOLUTION — *"If the first part of a Triggered
 * Ability's effect is 'you may,' … its controller decides whether or not to
 * perform it"* then. The Unit path decides at ANNOUNCE, by fanning the action into
 * a recycle-true and a recycle-false copy.
 *
 * # So what is actually at risk
 *
 * Nothing today. **A SECOND Gear printing `[Vision]` would silently do nothing** —
 * no error, no red test, and `isCardImplemented` satisfied by whatever else the
 * card does. That is the silently-inert-printing class, and this file exists to
 * turn it into a loud failure rather than to change any behaviour.
 *
 * Generalising the Unit path to Permanents was considered and NOT done: it would
 * mean either giving the Gear the Unit path's announce-time choice — which
 * `effects/order.ts` already reasoned is the worse of the two, and would be a
 * deliberate step away from 402.1 — or rewriting the Unit path onto a parked
 * decision, which changes the action space, the `PlayCardAction` shape and the web
 * UI to fix a divergence with no observable consequence. The Unit path's
 * announce-time choice is recorded as its own row in `docs/rules-conformance.md`.
 */

const DIVINING_SHELLS = "UNL-161";
const registry = defaultCardRegistry();

const visionPrinters = () => registry.all().filter((c) => String(c.text ?? "").includes("[Vision]"));

describe("the population this rests on", () => {
  it("exactly one GEAR prints [Vision], and it is Divining Shells", () => {
    // **The whole point of this file.** If this goes red, a new Gear prints
    // `[Vision]` and the keyword machinery will NOT fire for it: either give it a
    // per-card parked decision the way UNL-161 has one, or generalise the Unit
    // path — see this file's header for why the second was not done.
    const gears = visionPrinters()
      .filter((c) => c.type === "Gear")
      .map((c) => `${c.id} ${c.name}`);

    expect(gears, "a Gear prints [Vision] and nothing will fire it").toEqual([`${DIVINING_SHELLS} Divining Shells`]);
  });

  it("...and several UNITS do — the control", () => {
    // Without this, the assertion above would also pass on a pool where the
    // keyword had been renamed and nothing printed it at all.
    const units = visionPrinters().filter((c) => c.type === "Unit");
    expect(units.length, "no unit prints [Vision] — the text scan has stopped matching").toBeGreaterThan(5);
  });

  it("and no Legend or Battlefield prints it, which would be a third path again", () => {
    const others = visionPrinters()
      .filter((c) => c.type !== "Unit" && c.type !== "Gear")
      .map((c) => `${c.id} ${c.name} (${c.type})`);
    expect(others, "a card type with no [Vision] path at all now prints it").toEqual([]);
  });
});

describe("the gate really is Unit-only — measured, not inferred", () => {
  /** One card in hand, with runes enough to cast it. */
  function inHand(defId: string): GameState {
    const card = createCardInstance(registry.get(defId));
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [card];
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      domain: (["Fury", "Chaos", "Calm", "Body", "Mind", "Order"] as const)[i % 6]!,
      state: "Ready" as const,
    }));
    state.players[0]!.deck = [createCardInstance(registry.get("OGN-029"))];
    return state;
  }

  const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
    legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

  it("a [Vision] UNIT is fanned into a recycle-true and a recycle-false variant", () => {
    // The positive control. `unitTriggerHasVisionChoice` is what both the
    // enumerator and the validator ask, so this is the shape a Gear does not get.
    const visionUnit = visionPrinters().find((c) => c.type === "Unit")!;
    const state = inHand(visionUnit.id);
    expect(unitTriggerHasVisionChoice(state, 0, visionUnit.id), "the predicate does not see this unit's keyword").toBe(
      true,
    );

    const variants = playsOf(state, visionUnit.id).map((a) => a.visionRecycle);
    expect(variants, "the recycle choice was never offered").toContain(true);
    expect(variants, "the keep choice was never offered").toContain(false);
  });

  it("the [Vision] GEAR gets no such variant — and asks at resolution instead", () => {
    // Not a bug, and this asserts the CURRENT shape so that a future change to
    // either path has to come here and say which one it meant.
    const state = inHand(DIVINING_SHELLS);
    const variants = playsOf(state, DIVINING_SHELLS).map((a) => a.visionRecycle);

    expect(variants.length, "Divining Shells was not offered at all — the fixture cannot cast it").toBeGreaterThan(0);
    expect(
      variants.every((v) => v === undefined),
      "a Gear gained the Unit path's announce-time recycle choice — 402.1 wants it asked at resolution",
    ).toBe(true);
  });
});
