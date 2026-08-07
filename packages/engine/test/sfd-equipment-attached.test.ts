import { describe, expect, it } from "vitest";
import { attachEquipment } from "../src/engine/equipment.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { answerDecision, pendingDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * `equipmentAttached` — the event, and the two cards that needed it.
 *
 * It is held from `attachEquipment`, the single writer of
 * `attachedToInstanceId`, whose module comment already promised exactly this:
 * "nothing else assigns it, so a future attach source cannot skip whatever these
 * grow to do". Five paths reach it — an `[Equip]` cost, `[Quick-Draw]`,
 * `[Weaponmaster]`, Jax - Grandmaster's ability, Forge of the Fluft's — and that
 * is what makes the sixth free.
 *
 * Beside it, Ornn - Forge God, who needed no event at all: "+1 Might for each
 * friendly gear" is a zone count like Dr. Mundo's trash.
 */

const registry = defaultCardRegistry();
const JAX_UNRELENTING = "SFD-119";
const ORNN_FORGE_GOD = "SFD-085";
const DORANS_BLADE = "SFD-095";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Body" as const, state: "Ready" as const }));

describe("Jax - Unrelenting (SFD-119): pay [1] to draw when an Equipment lands on him", () => {
  /** Jax and a bystander in base, one Equipment, `energy` runes to pay with. */
  function board(energy = 3): { state: GameState; blade: GearInstance } {
    const blade = gear(DORANS_BLADE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(JAX_UNRELENTING), instanceId: "jax" },
      makeUnit({ instanceId: "bystander", might: 2 }),
    ];
    state.players[0]!.activeGear = [blade];
    state.players[0]!.channeled = runes(energy);
    state.players[0]!.deck = Array.from({ length: 4 }, () => gear(DORANS_BLADE));
    return { state, blade };
  }

  const settle = (state: GameState) => resolveHeldTriggers(state);
  const hand = (state: GameState) => state.players[0]!.hand.length;

  it("offers the draw when an Equipment is attached to HIM", () => {
    const { state, blade } = board();
    const after = settle(attachEquipment(state, 0, blade.instanceId, "jax"));

    expect(pendingDecision(after)?.kind, "no offer was made").toBe("SFD-119-draw");
  });

  it("draws and charges [1] when accepted", () => {
    const { state, blade } = board();
    const offered = settle(attachEquipment(state, 0, blade.instanceId, "jax"));
    const before = hand(offered);
    const after = answerDecision(offered, pendingDecision(offered)!.id, "pay")!;

    expect(hand(after), "no card was drawn").toBe(before + 1);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted"), "the [1] was not paid").toHaveLength(1);
  });

  it("costs nothing when declined", () => {
    const { state, blade } = board();
    const offered = settle(attachEquipment(state, 0, blade.instanceId, "jax"));
    const before = hand(offered);
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(hand(after)).toBe(before);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(0);
  });

  /** "TO ME" — an Equipment landing on the unit beside him is not his moment. */
  it("does NOT fire for an Equipment attached to another unit", () => {
    const { state, blade } = board();
    const after = settle(attachEquipment(state, 0, blade.instanceId, "bystander"));

    expect(pendingDecision(after), "he fired for somebody else's Equipment").toBeUndefined();
  });

  /**
   * **A MOVE is an attach.** An Equipment picked up off the bystander and put on
   * Jax has been attached to him — the cards draw no distinction and neither
   * does the event.
   */
  it("fires when an Equipment is MOVED onto him", () => {
    const { state, blade } = board();
    const worn = attachEquipment(state, 0, blade.instanceId, "bystander");
    const moved = settle(attachEquipment(worn, 0, blade.instanceId, "jax"));

    expect(pendingDecision(moved)?.kind, "a move did not count as an attach").toBe("SFD-119-draw");
  });

  /**
   * An offer nobody can pay is not made — and the assertion is on the PENDING
   * ITEM, not on `pendingDecision`.
   *
   * A decision whose only option is "decline" auto-resolves, so asking for the
   * prompt cannot tell the trigger firing uselessly apart from the trigger not
   * firing at all: removing the fire-time payability check leaves a
   * prompt-shaped test green. Only counting chain entries sees it. Measured, the
   * second time this exact shape has been caught here (Sivir - Battle Mistress
   * was the first).
   */
  it("is not offered with no Energy at all", () => {
    const { state, blade } = board(0);
    const attached = attachEquipment(state, 0, blade.instanceId, "jax");
    const held = runCleanup(attached).spellChain.filter(
      (e) => "listenerDefId" in e && e.listenerDefId === JAX_UNRELENTING,
    );

    expect(held, "an unpayable trigger was placed on the chain").toHaveLength(0);
    expect(pendingDecision(settle(attached)), "an unpayable offer was made").toBeUndefined();
  });

  /** And with no Jax, an attach is just an attach. */
  it("nothing fires without him", () => {
    const { state, blade } = board();
    const noJax: GameState = {
      ...state,
      players: [{ ...state.players[0]!, baseUnits: [makeUnit({ instanceId: "jax", might: 2 })] }, state.players[1]!],
    };
    expect(pendingDecision(settle(attachEquipment(noJax, 0, blade.instanceId, "jax")))).toBeUndefined();
  });
});

describe("Ornn - Forge God (SFD-085): +1 Might for each friendly gear", () => {
  /** Ornn in base with `gears` pieces of gear beside him. */
  function board(gears: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(ORNN_FORGE_GOD), instanceId: "ornn" }];
    state.players[0]!.activeGear = Array.from({ length: gears }, () => gear(DORANS_BLADE));
    return state;
  }

  const mightOf = (state: GameState) =>
    effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, { isCombat: false });

  const printedMight = (registry.get(ORNN_FORGE_GOD) as { might: number }).might;

  it("is his printed Might with no gear", () => {
    expect(mightOf(board(0))).toBe(printedMight);
  });

  it("gains one per gear", () => {
    expect(mightOf(board(1))).toBe(printedMight + 1);
    expect(mightOf(board(3))).toBe(printedMight + 3);
  });

  /** "FRIENDLY gear" — the opponent's armoury does nothing for him. */
  it("does not count the OPPONENT's gear", () => {
    const state = board(0);
    state.players[1]!.activeGear = [gear(DORANS_BLADE), gear(DORANS_BLADE)];
    expect(mightOf(state), "an enemy's gear pumped him").toBe(printedMight);
  });

  /**
   * **Every gear, not only what he WEARS** — "friendly gear" is the widest
   * phrase the set uses, and an unattached blade in the gear row is one.
   */
  it("counts gear that is attached to nobody", () => {
    const state = board(2);
    expect(state.players[0]!.activeGear.every((g) => g.attachedToInstanceId == null)).toBe(true);
    expect(mightOf(state)).toBe(printedMight + 2);
  });
});

describe("both report implemented", () => {
  it("their text is claimed", () => {
    for (const id of [JAX_UNRELENTING, ORNN_FORGE_GOD]) {
      expect(isCardImplemented(registry.get(id)), `${id}`).toBe(true);
    }
  });
});
