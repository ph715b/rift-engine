import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { unitsBanishedWith } from "../src/engine/equipment.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The Zero Drive (SFD-090) — the pool's first banish that remembers its SOURCE.
 *
 * # The card is two halves and only one of them is in the card data
 *
 * `text.plain` carries the activation ("[3][Mind], Banish this: Play all units
 * banished with this, ignoring their costs. (Use only if unattached.)"). The half
 * that makes it mean anything — `[Deathknell] — Banish me`, granted to the wearer
 * — exists only on the card art, transcribed in docs/sfd-equipment-abilities.md.
 * Written apart, the activation is a sentence about an empty set.
 *
 * So the tests come in three groups: the list FILLS on a wearer's death, it
 * SURVIVES the Drive's own banishment, and the activation EMPTIES it.
 *
 * # What the old partial note said, and what it turned out to be
 *
 * "Needs banish-with-source tracking." That is one optional field on
 * `GearInstance` plus the death-watch that writes it — no subsystem. It is the
 * ninth note in this repo to be pessimistic about its own mechanism.
 */

const registry = defaultCardRegistry();
const ZERO_DRIVE = "SFD-090";
/** A cheap real Unit, so the free play goes through the ordinary path with a
 *  card the registry knows rather than a stub. */
const A_UNIT = "OGN-002";

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * p1 has a Zero Drive attached to a real unit at bf1, and runes enough to
 * activate (3 Energy + 1 Mind Power).
 *
 * Attached by writing the link directly rather than through `attachEquipment`,
 * the convention equipment-wearer-moments.test.ts records: paying an `[Equip]`
 * cost is a different subsystem with its own file.
 */
function drivenBoard(opts: { attached?: boolean } = {}): { state: GameState; wearerId: string } {
  const { attached = true } = opts;
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { channeled: runes("Mind", 6) }), makePlayer("p2")],
  });
  const wearer = realUnitInstance(A_UNIT);
  state.battlefields[0]!.units = { p1: [wearer] };
  state.players[0]!.activeGear = [
    { ...realGearInstance(ZERO_DRIVE), instanceId: "drive", attachedToInstanceId: attached ? wearer.instanceId : null },
  ];
  return { state, wearerId: wearer.instanceId };
}

/** The Drive as a GEAR, wherever it is. Narrowed rather than asserted, because
 *  `banished` is a `CardInstance[]` and a Legend has neither of the two fields
 *  every assertion below reads — the compiler says so, and it is the check the
 *  test run cannot make. */
const driveIn = (state: GameState, zone: "activeGear" | "banished"): GearInstance | undefined => {
  const found = state.players[0]![zone].find((c) => c.instanceId === "drive");
  return found?.kind === "Gear" ? found : undefined;
};

const activation = (state: GameState) =>
  legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "drive");

describe("The Zero Drive: the [Deathknell] half fills the list", () => {
  it("banishes its wearer instead of leaving it in the trash", () => {
    const { state, wearerId } = drivenBoard();
    const after = resolveHeldTriggers(destroyUnit(state, wearerId));
    expect(after.players[0]!.trash.map((c) => c.instanceId)).not.toContain(wearerId);
    expect(after.players[0]!.banished.map((c) => c.instanceId)).toContain(wearerId);
  });

  it("records the banished unit AGAINST THAT DRIVE", () => {
    const { state, wearerId } = drivenBoard();
    const after = resolveHeldTriggers(destroyUnit(state, wearerId));
    expect(unitsBanishedWith(driveIn(after, "activeGear")!)).toEqual([wearerId]);
  });

  it("does nothing while UNATTACHED — the load-bearing negative", () => {
    // A Drive sitting unworn watches nobody. Without this the card would banish
    // every unit its controller lost, which is not what an Equipment does.
    const { state, wearerId } = drivenBoard({ attached: false });
    const after = resolveHeldTriggers(destroyUnit(state, wearerId));
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(wearerId);
    expect(unitsBanishedWith(driveIn(after, "activeGear")!)).toEqual([]);
  });

  it("keeps two Drives' lists apart — 'with THIS', compared by instance", () => {
    const { state, wearerId } = drivenBoard();
    const other = realUnitInstance(A_UNIT);
    state.battlefields[0]!.units["p1"] = [...state.battlefields[0]!.units["p1"]!, other];
    state.players[0]!.activeGear = [
      ...state.players[0]!.activeGear,
      { ...realGearInstance(ZERO_DRIVE), instanceId: "drive2", attachedToInstanceId: other.instanceId },
    ];
    const after = resolveHeldTriggers(destroyUnit(state, wearerId));
    expect(unitsBanishedWith(driveIn(after, "activeGear")!)).toEqual([wearerId]);
    const second = after.players[0]!.activeGear.find((g) => g.instanceId === "drive2")!;
    expect(unitsBanishedWith(second), "the other Drive claimed a death that was not its wearer's").toEqual([]);
  });
});

describe("The Zero Drive: the activation empties it", () => {
  /** A board where the Drive has already eaten its wearer and been detached. */
  function loadedDrive(): { state: GameState; wearerId: string } {
    const { state, wearerId } = drivenBoard();
    return { state: resolveHeldTriggers(destroyUnit(state, wearerId)), wearerId };
  }

  it("is not offered while the Drive is still attached", () => {
    // "(Use only if unattached.)" — refused by `availableWhile`, before any cost.
    // A guard inside the resolver would come after the 3 Energy, the Mind Power
    // and the Drive itself were already spent.
    const { state } = drivenBoard();
    expect(activation(state), "an attached Drive was offered its ability").toBeUndefined();
  });

  it("is offered once its wearer has died and it has detached", () => {
    const { state } = loadedDrive();
    expect(driveIn(state, "activeGear")!.attachedToInstanceId, "the wearer's death did not detach it").toBeNull();
    expect(activation(state), "the unattached Drive was not offered its ability").toBeDefined();
  });

  it("plays every unit banished with it, back onto the board", () => {
    const { state, wearerId } = loadedDrive();
    const after = resolveHeldTriggers(executeActivateAbility(state, activation(state) as never));
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toContain(wearerId);
    expect(after.players[0]!.banished.map((c) => c.instanceId)).not.toContain(wearerId);
  });

  it("brings back ALL of them, not just the first", () => {
    // "All units banished with this." Two wearers in turn, one Drive.
    const { state, wearerId } = drivenBoard();
    const second = realUnitInstance(A_UNIT);
    state.battlefields[0]!.units["p1"] = [...state.battlefields[0]!.units["p1"]!, second];
    const afterFirst = resolveHeldTriggers(destroyUnit(state, wearerId));
    // Re-attach to the survivor, which is what a player would do.
    afterFirst.players[0]!.activeGear = afterFirst.players[0]!.activeGear.map((g) =>
      g.instanceId === "drive" ? { ...g, attachedToInstanceId: second.instanceId } : g,
    );
    const loaded = resolveHeldTriggers(destroyUnit(afterFirst, second.instanceId));
    expect(unitsBanishedWith(driveIn(loaded, "activeGear")!)).toEqual([wearerId, second.instanceId]);

    const after = resolveHeldTriggers(executeActivateAbility(loaded, activation(loaded) as never));
    const back = after.players[0]!.baseUnits.map((u) => u.instanceId);
    expect(back).toContain(wearerId);
    expect(back).toContain(second.instanceId);
  });

  it("banishes the Drive to pay, and does NOT kill it", () => {
    // The distinction `banishSelf` exists for: a killed gear reaches a trash a
    // dozen cards here can recur, and fires its own "when I am killed". Banishing
    // does neither, and that is the cost the card prints.
    const { state } = loadedDrive();
    const after = resolveHeldTriggers(executeActivateAbility(state, activation(state) as never));
    expect(driveIn(after, "activeGear"), "the Drive survived its own cost").toBeUndefined();
    expect(after.players[0]!.trash.map((c) => c.instanceId), "banishing is not killing").not.toContain("drive");
    expect(driveIn(after, "banished")).toBeDefined();
  });

  it("reads its list out of the BANISHED zone, because the cost is paid first", () => {
    // The load-bearing ordering. `banishCard` moves the INSTANCE rather than
    // re-creating it, so `banishedInstanceIds` is still there when the effect
    // runs — and the effect looks for the Drive where the cost just put it.
    const { state, wearerId } = loadedDrive();
    const after = resolveHeldTriggers(executeActivateAbility(state, activation(state) as never));
    expect(unitsBanishedWith(driveIn(after, "banished")!)).toEqual([wearerId]);
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toContain(wearerId);
  });

  it("spends the printed price — 3 Energy and 1 Mind Power", () => {
    const { state } = loadedDrive();
    const before = state.players[0]!.channeled.filter((r) => r.state === "Ready").length;
    const after = resolveHeldTriggers(executeActivateAbility(state, activation(state) as never));
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready").length).toBeLessThan(before);
  });

  it("is not offered with too few runes", () => {
    const { state } = loadedDrive();
    state.players[0]!.channeled = runes("Mind", 1);
    expect(activation(state)).toBeUndefined();
  });

  it("the validator accepts what the enumerator offers", () => {
    const { state } = loadedDrive();
    const action = activation(state);
    expect(action).toBeDefined();
    const result = validateActivateAbility(state, action as never);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });
});

describe("The Zero Drive: coverage", () => {
  it("no longer carries a partial note", () => {
    expect(partialImplementationNote(registry.get(ZERO_DRIVE))).toBeUndefined();
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(ZERO_DRIVE))).toBe(true);
  });
});
