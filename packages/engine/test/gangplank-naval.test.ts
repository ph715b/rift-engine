import { describe, expect, it } from "vitest";
import { giveMightThisTurn, returnUnitToHand, stunUnits, empowerPermanent } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { canonicalDefId } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * Gangplank, Naval — "[Empowered][>] If a spell or ability that chooses me would
 * stun me, give me -Might, or return me to hand, give me +3 Might instead."
 *
 * A REPLACEMENT EFFECT (369.1's "would"), asked at the three points the replaced
 * things are APPLIED rather than registered as a listener — the shape
 * `damageIsDoubledFor` already takes for Lotus Trap, and for the same reason:
 * there is no event to listen to, only an instruction about to be carried out.
 *
 * Three separate guards, because the three instructions have nothing in common in
 * this engine. That is why the card needed a seam per verb rather than one shared
 * "bad things happening" hook.
 *
 * **The sign check on the Might guard is load-bearing.** His text names "give me
 * -Might", so a positive pump is not being replaced — and without it the +3 the
 * replacement itself grants would replace itself, which is an infinite regress
 * rather than a card. That case is asserted below.
 */

const registry = defaultCardRegistry();
const GANGPLANK = "VEN-086";
const GANGPLANK_OVERNUMBERED = "VEN-181";
const PLAIN_UNIT = "OGN-164";

const unit = (defId: string, instanceId: string): UnitInstance => ({
  ...(createCardInstance(registry.get(defId)) as UnitInstance),
  instanceId,
});

function board(units: UnitInstance[], empoweredId?: string): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = units;
  return empoweredId ? empowerPermanent(state, empoweredId) : state;
}

const find = (state: GameState, id: string): UnitInstance | undefined =>
  state.players[0]!.baseUnits.find((u) => u.instanceId === id);

describe("Gangplank's replacement, while Empowered", () => {
  it("is NOT stunned — he grows instead", () => {
    const state = board([unit(GANGPLANK, "g")], "g");
    const after = stunUnits(state, 1, ["g"]);
    expect(find(after, "g")!.stunned, "an Empowered Gangplank was stunned").toBe(false);
    expect(find(after, "g")!.mightThisTurn, "the +3 was not given").toBe(3);
  });

  it("is NOT returned to hand — he stays and grows", () => {
    const state = board([unit(GANGPLANK, "g")], "g");
    const after = returnUnitToHand(state, "g");
    expect(find(after, "g"), "an Empowered Gangplank was bounced").toBeDefined();
    expect(after.players[0]!.hand, "he ended up in hand").toHaveLength(0);
    expect(find(after, "g")!.mightThisTurn).toBe(3);
  });

  it("turns a Might REDUCTION into +3", () => {
    const state = board([unit(GANGPLANK, "g")], "g");
    const after = giveMightThisTurn(state, "g", -2);
    expect(find(after, "g")!.mightThisTurn, "-2 was applied instead of being replaced").toBe(3);
  });

  it("does NOT replace a positive pump — and so cannot regress infinitely", () => {
    // The sign check. Without it the replacement's own +3 would be replaced by
    // another +3, forever.
    const state = board([unit(GANGPLANK, "g")], "g");
    expect(giveMightThisTurn(state, "g", 2).players[0]!.baseUnits[0]!.mightThisTurn, "a pump was replaced").toBe(2);
  });
});

describe("the replacement is gated and targeted", () => {
  it("does nothing un-Empowered (828.1.c)", () => {
    const state = board([unit(GANGPLANK, "g")]);
    expect(stunUnits(state, 1, ["g"]).players[0]!.baseUnits[0]!.stunned, "an un-Empowered Gangplank dodged a stun").toBe(true);
    expect(giveMightThisTurn(board([unit(GANGPLANK, "g")]), "g", -2).players[0]!.baseUnits[0]!.mightThisTurn).toBe(-2);
  });

  it("protects only HIM — another unit is stunned normally", () => {
    // The control. Without it, a guard that replaced for everybody would pass
    // every assertion above.
    const state = board([unit(GANGPLANK, "g"), unit(PLAIN_UNIT, "other")], "g");
    const after = stunUnits(state, 1, ["other"]);
    expect(find(after, "other")!.stunned, "a bystander was protected").toBe(true);
    expect(find(after, "other")!.mightThisTurn, "a bystander got the +3").toBe(0);
  });

  it("covers his (Overnumbered) printing, which is the same card", () => {
    // Asked through `canonicalDefId`, so the printing answers as he does —
    // `printing-aliases` is what says they are one card, and a raw defId compare
    // would silently leave the second printing unprotected.
    expect(canonicalDefId(GANGPLANK_OVERNUMBERED), "the printing does not alias to him").toBe(GANGPLANK);
    const state = board([unit(GANGPLANK_OVERNUMBERED, "g2")], "g2");
    expect(stunUnits(state, 1, ["g2"]).players[0]!.baseUnits[0]!.stunned, "the Overnumbered print was stunned").toBe(false);
  });
});

describe("coverage", () => {
  it("claims Gangplank, whose whole clause is the replacement", () => {
    expect(isCardImplemented(registry.get(GANGPLANK)), "Gangplank is written but unclaimed").toBe(true);
  });
});
