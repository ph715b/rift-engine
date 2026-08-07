import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { CardDefinition } from "../src/model/card-definition.js";
import { createToken, SAND_SOLDIER_TOKEN } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Azir - Emperor of the Sands (SFD-197) — "Your Sand Soldiers have
 * [Weaponmaster]. [1], [Exhaust]: Play a 2 Might Sand Soldier unit token to your
 * base. Use only if you've played an Equipment this turn."
 *
 * Two halves of different kinds: a keyword AURA (granted-keywords.ts) and an
 * ACTIVATED ability (activated-abilities.ts). Neither belongs in the other's
 * table, the same split Master Yi's `mightBonus` already makes.
 *
 * The condition is the sharp bit. **Equipment is a strict SUBSET of Gear**, so
 * the test that matters is the one where an ordinary non-Equipment gear has been
 * played: Ornn's Forge counts it and Azir must not. One counter serving both
 * would turn every gear into an Equipment for his purposes.
 */

const registry = defaultCardRegistry();
const AZIR = "SFD-197";

type GearDef = Extract<CardDefinition, { type: "Gear" }>;
const isGearDef = (d: CardDefinition): d is GearDef => d.type === "Gear";
const gearDefs = registry.all().filter(isGearDef);
/** An EQUIPMENT and a plain gear, so "subset" is a real distinction here. */
const EQUIPMENT = gearDefs.find((d) => d.isEquipment === true && d.powerCost === 0)!;
const PLAIN_GEAR = gearDefs.find((d) => d.isEquipment !== true && d.powerCost === 0)!;

function board(hand: GearInstance[] = []): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand,
        baseUnits: [makeUnit({ name: "Body", instanceId: "body" })],
        channeled: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: AZIR };
  return state;
}

const azirActivations = (state: GameState) =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
  );

function play(state: GameState, card: GearInstance): GameState {
  const action = legalActions(state).find(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId,
  );
  expect(action, `${card.name} was not offered`).toBeDefined();
  return executePlayCard(state, action!);
}

describe("Azir's aura: your Sand Soldiers have [Weaponmaster]", () => {
  it("grants it to a Sand Soldier token", () => {
    const state = board();
    const soldier = createToken(SAND_SOLDIER_TOKEN);
    state.players[0]!.baseUnits = [soldier];

    expect(effectiveKeywords(state, soldier, 0).Weaponmaster ?? 0).toBeGreaterThan(0);
  });

  /** The negative that makes the tag filter mean something — the bug this exact
   *  aura shape produced once already, when three tribal auras reached every
   *  friendly unit because they consulted `appliesTo` and never `appliesToDef`. */
  it("does NOT grant it to a friendly non-Sand-Soldier", () => {
    const state = board();
    const plain = makeUnit({ name: "Plain", instanceId: "plain", tags: [] });
    state.players[0]!.baseUnits = [plain];

    expect(effectiveKeywords(state, plain, 0).Weaponmaster ?? 0, "a non-Sand-Soldier got it").toBe(0);
  });

  it("does NOT grant it to an ENEMY Sand Soldier — 'YOUR Sand Soldiers'", () => {
    const state = board();
    const theirs = createToken(SAND_SOLDIER_TOKEN);
    state.players[1]!.baseUnits = [theirs];

    expect(effectiveKeywords(state, theirs, 1).Weaponmaster ?? 0, "the opponent's got it").toBe(0);
  });
});

describe("Azir's ability: only after you've played an EQUIPMENT", () => {
  it("is not offered before any Equipment has been played", () => {
    expect(azirActivations(board()), "offered with no Equipment played").toHaveLength(0);
  });

  it("IS offered once an Equipment has been played", () => {
    const equipment = createCardInstance(EQUIPMENT) as GearInstance;
    const after = play(board([equipment]), equipment);

    expect(after.players[0]!.equipmentPlayedThisTurn).toBe(1);
    expect(azirActivations(after).length, "not offered after playing an Equipment").toBeGreaterThan(0);
  });

  /**
   * **The assertion that separates the two counters.** A plain gear satisfies
   * Ornn's Forge's "gear played this turn" and must NOT satisfy Azir's
   * "Equipment played this turn".
   */
  it("is NOT offered after a plain, non-Equipment gear", () => {
    const plain = createCardInstance(PLAIN_GEAR) as GearInstance;
    const after = play(board([plain]), plain);

    expect(after.players[0]!.gearPlayedThisTurn, "the gear counter did not move").toBe(1);
    expect(after.players[0]!.equipmentPlayedThisTurn, "a plain gear counted as Equipment").toBe(0);
    expect(azirActivations(after), "a plain gear unlocked Azir").toHaveLength(0);
  });

  it("plays a Sand Soldier to your BASE and takes the Energy and the exhaust", () => {
    const equipment = createCardInstance(EQUIPMENT) as GearInstance;
    const ready = play(board([equipment]), equipment);
    const activation = azirActivations(ready)[0]!;
    const after = executeActivateAbility(ready, activation);

    const soldiers = after.players[0]!.baseUnits.filter((u) => u.name === "Sand Soldier");
    expect(soldiers, "no Sand Soldier was played").toHaveLength(1);
    expect(after.players[0]!.legend.exhausted, "the exhaust was not taken").toBe(true);
  });

  /** And the token he makes carries the tag, so his own aura reaches it. */
  it("the Sand Soldier he makes has [Weaponmaster] from his own aura", () => {
    const equipment = createCardInstance(EQUIPMENT) as GearInstance;
    const ready = play(board([equipment]), equipment);
    const after = executeActivateAbility(ready, azirActivations(ready)[0]!);

    const soldier = after.players[0]!.baseUnits.find((u) => u.name === "Sand Soldier")!;
    expect(effectiveKeywords(after, soldier, 0).Weaponmaster ?? 0).toBeGreaterThan(0);
  });
});
