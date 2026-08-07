import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { unitOrGearTargets } from "../src/engine/target-lookup.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Fading Memories (OGN-180) and Mushroom Pouch (OGN-101) — the two cards that
 * needed gear to be a first-class thing rather than a count in a list.
 *
 * Fading Memories is the only card in the pool that targets across two KINDS of
 * permanent ("a unit at a battlefield or a gear"), which is why `unitOrGear` is
 * its own targeting kind and why the choice rides on a separate field: handing a
 * gear to anything reading `targetUnitInstanceId` would be a bug waiting.
 */

const registry = defaultCardRegistry();
const FADING_MEMORIES = "OGN-180";
const MUSHROOM_POUCH = "OGN-101";
const CONSULT_THE_PAST = "OGN-083"; // a [Hidden] card, for the Pouch's condition
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

const resolveFading = (state: GameState, targetPermanentInstanceId: string) =>
  cardModeOf(spellInstance(FADING_MEMORIES), undefined)!.resolve(state, contextFor(0), { targetPermanentInstanceId });

describe("Fading Memories: one choice across units AND gear", () => {
  function board(): { state: GameState; unitAtBf: ReturnType<typeof makeUnit>; inBase: ReturnType<typeof makeUnit>; myGear: GearInstance; theirGear: GearInstance } {
    const unitAtBf = makeUnit({ name: "AtBattlefield" });
    const inBase = makeUnit({ name: "InBase" });
    const myGear = gear(MUSHROOM_POUCH);
    const theirGear = gear("OGN-090"); // Orb of Regret
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { baseUnits: [inBase], activeGear: [myGear] }), makePlayer("p2", { activeGear: [theirGear] })],
    });
    state.battlefields[0]!.units = { p2: [unitAtBf] };
    return { state, unitAtBf, inBase, myGear, theirGear };
  }

  it("offers units at battlefields and gear on BOTH sides, but not base units", () => {
    const { state, unitAtBf, inBase, myGear, theirGear } = board();
    const ids = unitOrGearTargets(state).map((t) => t.instanceId);

    expect(ids).toContain(unitAtBf.instanceId);
    expect(ids).toContain(myGear.instanceId);
    expect(ids).toContain(theirGear.instanceId);
    // "a unit AT A BATTLEFIELD" — unlike the many cards that just say "a unit".
    expect(ids).not.toContain(inBase.instanceId);
  });

  it("grants [Temporary] to a unit", () => {
    const { state, unitAtBf } = board();
    const after = resolveFading(state, unitAtBf.instanceId);
    expect("Temporary" in after.battlefields[0]!.units["p2"]![0]!.keywords).toBe(true);
  });

  it("grants [Temporary] to a GEAR — the half that needed a new target kind", () => {
    const { state, theirGear } = board();
    const after = resolveFading(state, theirGear.instanceId);
    expect("Temporary" in after.players[1]!.activeGear[0]!.keywords).toBe(true);
  });

  it("no-ops on something that has left play", () => {
    const { state } = board();
    expect(resolveFading(state, "gone")).toBe(state);
  });

  it("a Temporary GEAR dies at the start of its controller's Beginning Phase (816)", () => {
    // The rule says "kill this PERMANENT", not "this unit" — so the Beginning
    // Phase step had to learn about gear once gear could carry the keyword.
    const { state, myGear } = board();
    const marked = resolveFading(state, myGear.instanceId);
    expect(marked.players[0]!.activeGear).toHaveLength(1);

    const after = runBeginning({ ...marked, phase: "Beginning", activePlayerIndex: 0 });

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(myGear.instanceId);
  });

  it("spares the OPPONENT's Temporary gear until their own Beginning Phase", () => {
    const { state, theirGear } = board();
    const marked = resolveFading(state, theirGear.instanceId);

    const myTurn = runBeginning({ ...marked, phase: "Beginning", activePlayerIndex: 0 });
    expect(myTurn.players[1]!.activeGear).toHaveLength(1); // still theirs to lose

    const theirTurn = runBeginning({ ...marked, phase: "Beginning", activePlayerIndex: 1 });
    expect(theirTurn.players[1]!.activeGear).toHaveLength(0);
  });

  it("is enumerated and validated through the same target list", () => {
    const spell = createCardInstance(registry.get(FADING_MEMORIES)) as CardInstance;
    const target = makeUnit({ name: "Target" });
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          hand: [spell],
          channeled: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, domain: "Chaos" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });
    state.battlefields[0]!.units = { p2: [target] };

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((a) => a.type === "PlayCard" && a.targetPermanentInstanceId !== undefined)).toBe(true);
    expect(validatePlayCard(state, plays[0]! as never).ok).toBe(true);

    const forged = { ...plays[0]!, targetPermanentInstanceId: "nowhere" };
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });
});

describe("Mushroom Pouch: a Beginning-Phase ability, unlocked by [Hidden]", () => {
  /** The Pouch in play, and optionally a facedown card at a battlefield you hold. */
  function pouchState(withFacedown: boolean, controlled = true): GameState {
    const pouch = gear(MUSHROOM_POUCH);
    const state = makeState({
      phase: "Beginning",
      activePlayerIndex: 0,
      players: [makePlayer("p1", { activeGear: [pouch], deck: [makeUnit(), makeUnit()] }), makePlayer("p2")],
    });
    if (withFacedown) {
      state.battlefields[0]!.controllerId = controlled ? "p1" : "p2";
      state.battlefields[0]!.hiddenCards = [
        { ownerIndex: 0, card: createCardInstance(registry.get(CONSULT_THE_PAST)), hiddenOnTurn: 1 },
      ];
    }
    return state;
  }

  it("draws 1 when you control a facedown card at a battlefield", () => {
    const after = runBeginning(pouchState(true));
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("draws nothing with no facedown card", () => {
    const after = runBeginning(pouchState(false));
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("draws nothing when the battlefield holding it isn't yours", () => {
    // "if you CONTROL a facedown card at a battlefield" — the same pairing rule
    // 811 ties the card's survival to. (Cleanup would take the card away too,
    // but the ability must not fire in the window before that.)
    const after = runBeginning(pouchState(true, false));
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("fires on YOUR Beginning Phase, not the opponent's", () => {
    const state = pouchState(true);
    const theirTurn = runBeginning({ ...state, activePlayerIndex: 1 });
    expect(theirTurn.players[0]!.hand).toHaveLength(0);
  });
});

describe("coverage counts both", () => {
  it("reports them as implemented", () => {
    for (const id of [FADING_MEMORIES, MUSHROOM_POUCH]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
