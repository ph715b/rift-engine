import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type LegendInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { HideCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

const registry = defaultCardRegistry();
const PACK_OF_WONDERS = "OGN-181"; // "Exhaust: Return another friendly gear, unit, or facedown card to its owner's hand."
const TEEMO_SWIFT_SCOUT = "OGN-263"; // hide-for-Energy + "1 Energy, exhaust: put a Teemo unit into your hand"
const TEEMO_STRATEGIST = "OGN-121"; // a Teemo unit, and [Hidden] — so it doubles as the facedown fixture
const ENERGY_CONDUIT = "OGN-098"; // an ordinary friendly gear to bounce

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const gear = (defId: string, instanceId: string): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId }) as GearInstance;

const activationsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

describe("Pack of Wonders (OGN-181): return another friendly permanent", () => {
  /** The Pack plus a friendly unit, a friendly gear, an enemy unit, and one
   *  facedown card of the Pack's controller. */
  function packState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(PACK_OF_WONDERS, "pack"), gear(ENERGY_CONDUIT, "conduit")];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "friend", might: 3 })],
      p2: [makeUnit({ instanceId: "foe", might: 3 })],
    };
    state.battlefields[1]!.hiddenCards = [{ ownerIndex: 0, card: spellInstance(TEEMO_STRATEGIST), hiddenOnTurn: 1 }];
    return state;
  }

  it("offers the friendly unit, the friendly gear and the facedown card", () => {
    const offered = activationsOf(packState(), "pack").map((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId : undefined,
    );
    expect(offered).toContain("friend");
    expect(offered).toContain("conduit");
    expect(offered.length, "the facedown card was not offered").toBe(3);
  });

  it("never offers ITSELF — 'ANOTHER'", () => {
    // Its best line otherwise: exhaust, return the Pack, replay it.
    const offered = activationsOf(packState(), "pack").map((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId : undefined,
    );
    expect(offered).not.toContain("pack");
  });

  it("never offers an ENEMY unit — 'FRIENDLY'", () => {
    // Bouncing an enemy body would make a 2-Energy gear a repeatable Gust.
    const offered = activationsOf(packState(), "pack").map((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId : undefined,
    );
    expect(offered).not.toContain("foe");
  });

  it("returns a GEAR to hand", () => {
    const state = packState();
    const play = activationsOf(state, "pack").find((a) => a.type === "ActivateAbility" && a.targetPermanentInstanceId === "conduit")!;
    const settled = accept(state, play);

    expect(settled.players[0]!.activeGear.map((g) => g.instanceId), "the gear is still in play").toEqual(["pack"]);
    expect(settled.players[0]!.hand.map((c) => c.instanceId)).toContain("conduit");
  });

  it("returns a FACEDOWN card to its owner's hand, off the battlefield", () => {
    const state = packState();
    const facedownId = state.battlefields[1]!.hiddenCards[0]!.card.instanceId;
    const play = activationsOf(state, "pack").find(
      (a) => a.type === "ActivateAbility" && a.targetPermanentInstanceId === facedownId,
    )!;
    const settled = accept(state, play);

    expect(settled.battlefields[1]!.hiddenCards, "it is still facedown").toHaveLength(0);
    expect(settled.players[0]!.hand.map((c) => c.instanceId)).toContain(facedownId);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PACK_OF_WONDERS))).toBe(true);
  });
});

describe("Teemo - Swift Scout (OGN-263): two clauses on different layers", () => {
  /** Teemo as the seated legend, with a Teemo unit to fetch. */
  function teemoState(where: "champion" | "trash" | "nowhere"): GameState {
    const state = makeState({ phase: "Action" });
    const teemo = registry.get(TEEMO_SWIFT_SCOUT);
    state.players[0]!.legend = {
      ...state.players[0]!.legend,
      defId: TEEMO_SWIFT_SCOUT,
      name: teemo.name,
    } as LegendInstance;
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`m${i}`, "Mind"));
    if (where === "champion") state.players[0]!.championZone = realUnitInstance(TEEMO_STRATEGIST);
    if (where === "trash") state.players[0]!.trash = [realUnitInstance(TEEMO_STRATEGIST)];
    return state;
  }

  it("fetches from the CHAMPION ZONE first", () => {
    const state = teemoState("champion");
    const settled = accept(state, activationsOf(state, state.players[0]!.legend.instanceId)[0]!);

    expect(settled.players[0]!.championZone, "the zone was not emptied").toBeNull();
    expect(settled.players[0]!.hand.map((c) => c.defId)).toContain(TEEMO_STRATEGIST);
  });

  it("falls through to the TRASH", () => {
    const state = teemoState("trash");
    const settled = accept(state, activationsOf(state, state.players[0]!.legend.instanceId)[0]!);

    expect(settled.players[0]!.trash, "it was left in the trash").toHaveLength(0);
    expect(settled.players[0]!.hand.map((c) => c.defId)).toContain(TEEMO_STRATEGIST);
  });

  it("does nothing with no Teemo unit anywhere", () => {
    const state = teemoState("nowhere");
    const settled = accept(state, activationsOf(state, state.players[0]!.legend.instanceId)[0]!);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });

  it("offers hiding for ENERGY as well as for rainbow Power", () => {
    // A cost ALTERNATIVE, not a discount — the same-sized price in a different
    // currency, which changes what a turn can afford rather than what it costs.
    const state = teemoState("nowhere");
    state.players[0]!.hand = [spellInstance(TEEMO_STRATEGIST)];
    state.battlefields[0]!.controllerId = "p1";

    const hides = legalActions(state).filter((a): a is HideCardAction => a.type === "HideCard");
    expect(hides.length, "hiding was not offered at all").toBeGreaterThan(0);
    expect(hides.some((h) => h.payment.powerRunes.length === 1), "the rainbow route vanished").toBe(true);
    expect(hides.some((h) => h.payment.energyRunes.length === 1 && h.payment.powerRunes.length === 0), "no Energy route").toBe(true);
  });

  it("does NOT offer the Energy route to another legend", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(TEEMO_STRATEGIST)];
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`m${i}`, "Mind"));
    state.battlefields[0]!.controllerId = "p1";

    const hides = legalActions(state).filter((a): a is HideCardAction => a.type === "HideCard");
    expect(hides.length).toBeGreaterThan(0);
    expect(hides.every((h) => h.payment.powerRunes.length === 1), "a non-Teemo legend got the Energy route").toBe(true);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(TEEMO_SWIFT_SCOUT))).toBe(true);
  });
});
