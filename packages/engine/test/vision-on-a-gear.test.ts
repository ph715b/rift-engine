import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { unitTriggerHasVisionChoice } from "../src/engine/unit-triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **`[Vision]` fires from the UNIT path only, and exactly one Gear in the pool
 * prints the keyword.**
 *
 * **817.1.a**: *"It is present on Permanents"* — and a Gear is one. But
 * `dispatchOnPlayUnit` is the only thing that fires the keyword, so a Gear
 * printing `[Vision]` gets nothing from it.
 *
 * **UNL-161 Divining Shells is that Gear, and it is not broken** — its `[Vision]`
 * half is a per-card trigger in `effects/order.ts` that parks the same question
 * the Unit path now parks. Both routes end in `decisions.ts`' `vision-predict`.
 *
 * # What this file is actually for
 *
 * **A SECOND Gear printing `[Vision]` would silently do nothing** — no error, no
 * red test, and `isCardImplemented` satisfied by whatever else the card does.
 * That is the silently-inert-printing class, and the population assertions below
 * turn it into a loud failure by name.
 *
 * # What changed on 2026-08-25
 *
 * This file used to record the two paths as DIFFERENT, and argue that unifying
 * them was not worth it: the Unit path decided its "you may" at ANNOUNCE via a
 * `visionRecycle` fan-out, the Gear asked at resolution, and no player could see
 * the difference.
 *
 * That argument was wrong on its own terms, because the same refactor also closed
 * a divergence a player CAN see: **817.2**, *"Multiple instances of Vision trigger
 * separately"*, which a single boolean on the action cannot express — a Mystic
 * Poro played beside a Gemcraft Seer predicted once and should predict twice.
 * `keyword-auras.test.ts` measures that now. The Unit path was moved onto the
 * Gear's parked decision, not the other way round.
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

describe("both paths now ask the SAME parked question", () => {
  /**
   * **Rewritten 2026-08-25, and the header above it with it.** This block used to
   * assert that a `[Vision]` UNIT was fanned into a `visionRecycle: true` and a
   * `visionRecycle: false` variant while the GEAR got neither — the measurement
   * that showed the two paths differed.
   *
   * They no longer do. The Unit path was moved onto the Gear's parked decision,
   * which was always the conformant one (**402.1** decides a triggered "you may"
   * at resolution), and the shared question lives in `decisions.ts` as
   * `vision-predict`. So the assertion flips: NEITHER is fanned, and BOTH ask.
   */
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

  it("a [Vision] UNIT is no longer fanned into recycle-true / recycle-false", () => {
    // The action-space half. 817.2 makes multiple instances trigger separately, so
    // a faithful answer on the ACTION would have been 2^N variants multiplied
    // against every other variant of the play. As a parked question it is N
    // answers and no action-space growth at all.
    const visionUnit = visionPrinters().find((c) => c.type === "Unit")!;
    const state = inHand(visionUnit.id);
    expect(unitTriggerHasVisionChoice(state, 0, visionUnit.id), "the predicate does not see this unit's keyword").toBe(
      true,
    );

    const variants = playsOf(state, visionUnit.id).map((a) => a.visionRecycle);
    expect(variants.length, "the unit was not offered at all — the fixture cannot cast it").toBeGreaterThan(0);
    expect(
      variants.every((v) => v === undefined),
      "the announce-time recycle fan-out is back",
    ).toBe(true);
  });

  it("...and neither is the GEAR — the two paths agree now", () => {
    const state = inHand(DIVINING_SHELLS);
    const variants = playsOf(state, DIVINING_SHELLS).map((a) => a.visionRecycle);

    expect(variants.length, "Divining Shells was not offered at all").toBeGreaterThan(0);
    expect(variants.every((v) => v === undefined), "the Gear gained an announce-time choice").toBe(true);
  });
});
