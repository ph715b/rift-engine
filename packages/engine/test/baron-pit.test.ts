import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { BARON_PIT, addBattlefieldToken, battlefieldTokenDefIds } from "../src/engine/battlefield-tokens.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction, MoveUnitAction } from "../src/actions/player-action.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * UNL-147 Baron Nashor's first sentence, and the Baron Pit battlefield token.
 *
 * > "As you play me, add the Baron Pit battlefield token to the board if it's not
 * > there already. If you do, I enter there. (It has 'Units can move here from
 * > anywhere.')"
 *
 * # The refusal was right about the card data and wrong about the engine
 *
 * It said the clause was SYSTEMIC: "nothing in this engine can add a battlefield
 * at all, `battlefieldPair` builds exactly two at setup with ids stable for the
 * game, and the Pit has no card data in `unl.json`."
 *
 * The last clause is TRUE and re-measured — there is no Baron Pit card in any of
 * the four set files, so its definition is authored in
 * `engine/battlefield-tokens.ts` from the reminder text printed on Baron himself.
 * That is the same call `token.ts` makes for the Gold gear token.
 *
 * The rest was an inference from setup to the engine, and it does not hold.
 * `battlefieldPair` does build exactly two; `state.battlefields` is a LIST that
 * every engine site walks without assuming a length, and the web board already
 * sizes its grid from `state.battlefields.length`. What was missing was a
 * function, and the tests below are the measurement that says so: a third
 * battlefield is added, scored, moved to, and rendered as an ordinary one.
 *
 * Driven through `legalActions` + `submit` throughout — the whole claim is that
 * the LIVE play path creates the token, and a resolver called by hand would
 * prove nothing about that.
 */

const registry = defaultCardRegistry();
const BARON = "UNL-147";
const BARON_ULTIMATE = "UNL-238";
/** A body with no text at all, so nothing it does can be mistaken for Baron's. */
const VANILLA_UNIT = "OGN-052";

/** Baron costs 10 Energy and 3 Chaos, so the fixture pays out of floating. */
function richState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  for (const player of state.players) {
    player.floatingEnergy = 20;
    player.floatingPower = { Chaos: 9, Body: 9, Fury: 9, Mind: 9, Order: 9, Calm: 9 };
  }
  return state;
}

const baron = (defId = BARON): UnitInstance => realUnitInstance(defId);

function play(state: GameState, unit: UnitInstance, destinationBattlefieldId?: string): GameState {
  const action = legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" &&
      a.card.instanceId === unit.instanceId &&
      a.destinationBattlefieldId === destinationBattlefieldId,
  );
  expect(action, `no legal play of ${unit.name} to ${destinationBattlefieldId ?? "base"}`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

const pitOf = (state: GameState) => state.battlefields.find((bf) => bf.id === BARON_PIT.id);

const unitAt = (state: GameState, battlefieldId: string, instanceId: string) =>
  Object.values(state.battlefields.find((bf) => bf.id === battlefieldId)?.units ?? {})
    .flat()
    .some((u) => u.instanceId === instanceId);

describe("playing him adds the Pit, and he enters there", () => {
  it("a third battlefield appears, named Baron Pit", () => {
    const state = richState();
    const b = baron();
    state.players[0]!.hand = [b];
    expect(state.battlefields).toHaveLength(2);

    const after = play(state, b);

    expect(after.battlefields).toHaveLength(3);
    expect(pitOf(after)?.name).toBe("Baron Pit");
    expect(pitOf(after)?.defId).toBe(BARON_PIT.defId);
  });

  it("and he lands IN it rather than in the base he was played to", () => {
    const state = richState();
    const b = baron();
    state.players[0]!.hand = [b];

    const after = play(state, b);

    expect(unitAt(after, BARON_PIT.id, b.instanceId), "he stayed where the play named").toBe(true);
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === b.instanceId)).toBe(false);
  });

  /**
   * The Pit arrives controlled by NOBODY and uncontested, which is the state a
   * battlefield starts a game in. Baron establishes control the ordinary way.
   */
  it("the Pit enters unowned and uncontested", () => {
    const state = richState();
    const b = baron();
    state.players[0]!.hand = [b];

    expect(pitOf(play(state, b))?.controllerId).toBeNull();
  });

  /**
   * **"If you DO, I enter there"** — so with the Pit already on the board nothing
   * is added, the conditional is false, and a second Baron enters where his play
   * named. Reading the clause as "he always enters the Pit" would be a different
   * card, and this is the assertion that tells the two apart.
   */
  it("a SECOND Baron adds nothing and enters where he was played", () => {
    // The Pit is placed directly rather than by playing a first Baron, because a
    // Baron landing in it contests it and the following Cleanup opens a Non-Combat
    // Showdown — after which a Default-timed unit cannot be played at all. That is
    // ordinary engine behaviour and would make this test measure the timing rules
    // instead of the clause.
    const state = addBattlefieldToken(richState(), BARON_PIT);
    const second = baron();
    state.players[0]!.hand = [second];
    expect(state.battlefields).toHaveLength(3);

    const after = play(state, second);
    expect(after.battlefields, "a second Pit was added").toHaveLength(3);
    expect(
      after.players[0]!.baseUnits.some((u) => u.instanceId === second.instanceId),
      "the second Baron was pulled into the Pit anyway",
    ).toBe(true);
  });

  /**
   * `mergeRegistries` aliases the "(Ultimate)" printing to UNL-147's entry, and an
   * alias cannot reach a site comparing a defId to a literal — the trap his Might
   * aura's own comment records. So both ids are listed, and this is what proves it.
   */
  it("the (Ultimate) printing adds the Pit too", () => {
    const state = richState();
    const b = baron(BARON_ULTIMATE);
    state.players[0]!.hand = [b];

    const after = play(state, b);
    expect(after.battlefields).toHaveLength(3);
    expect(unitAt(after, BARON_PIT.id, b.instanceId)).toBe(true);
  });

  /** The negative that gives the assertions above their meaning: an ordinary unit
   *  played from the same hand adds nothing. */
  it("NEGATIVE CONTROL: an ordinary unit adds no battlefield", () => {
    const state = richState();
    const vanilla = realUnitInstance(VANILLA_UNIT);
    state.players[0]!.hand = [vanilla];

    expect(play(state, vanilla).battlefields).toHaveLength(2);
  });
});

describe("the Pit's own text — units can move here from anywhere", () => {
  /**
   * The Pit on the board with a friendly non-[Ganking] unit standing at bf1.
   *
   * The Pit is placed directly rather than by playing a Baron: a Baron landing in
   * it contests it, the following Cleanup opens a Non-Combat Showdown, and while
   * one is open `legalActions` offers combat actions rather than moves. The clause
   * under test is the Pit's, not Baron's, and the test that ties the two together
   * is the one above.
   */
  function withPit(): { state: GameState; walker: UnitInstance } {
    const placed = addBattlefieldToken(richState(), BARON_PIT);
    const walker = makeUnit({ instanceId: "walker", might: 2 });
    const battlefields = placed.battlefields.map((bf) =>
      bf.id === "bf1" ? { ...bf, units: { ...bf.units, [placed.players[0]!.id]: [walker] } } : bf,
    );
    return { state: { ...placed, battlefields }, walker };
  }

  it("a unit with no [Ganking] may move battlefield-to-battlefield INTO the Pit", () => {
    const { state, walker } = withPit();
    const move = legalActions(state).find(
      (a): a is MoveUnitAction =>
        a.type === "MoveUnit" && a.destinationBattlefieldId === BARON_PIT.id && a.unitInstanceIds.includes(walker.instanceId),
    );

    expect(move, "the Pit refused a non-Ganking mover").toBeDefined();
    expect(validateMoveUnit(state, move!), "offered and then refused").toMatchObject({ ok: true });
  });

  /**
   * The control, and it is the one that matters: 813's restriction is lifted for
   * the PIT and nowhere else. Without it, a change that lifted [Ganking] globally
   * would satisfy the assertion above just as happily.
   */
  it("NEGATIVE CONTROL: the same unit still cannot reach the OTHER battlefield", () => {
    const { state, walker } = withPit();
    const move = legalActions(state).find(
      (a): a is MoveUnitAction =>
        a.type === "MoveUnit" && a.destinationBattlefieldId === "bf2" && a.unitInstanceIds.includes(walker.instanceId),
    );

    expect(move, "[Ganking] stopped mattering everywhere").toBeUndefined();
  });

  /** The enumerator and the validator ask the same helper, so a hand-built move
   *  the enumerator never offered is refused for the printed reason. */
  it("and the validator refuses that same move by name", () => {
    const { state, walker } = withPit();
    const forged: MoveUnitAction = {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [walker.instanceId],
      destinationBattlefieldId: "bf2",
      payment: { energyRunes: [], powerRunes: [], rainbowRunes: [] },
    };

    expect(validateMoveUnit(state, forged)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ganking"),
    });
  });
});

describe("coverage", () => {
  it("the Pit is a real card as far as the drift gate is concerned", () => {
    expect(battlefieldTokenDefIds()).toContain(BARON_PIT.defId);
  });

  it("Baron Nashor is implemented, with no partial note left behind", () => {
    expect(partialImplementationNote(registry.get(BARON))).toBeUndefined();
    expect(isCardImplemented(registry.get(BARON))).toBe(true);
  });
});
