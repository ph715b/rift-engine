import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { VANGUARD_ARMORY_TOKENS } from "../src/engine/constants.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { answerDecisions, makeState, makeUnit, realGearInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The two SFD cards that mint several unit tokens at once, and differ on the one
 * thing that makes them different cards.
 *
 * **Vanguard Armory prints "(You may play them to different locations.)" and
 * Arise! prints no parenthetical at all.** The handoff that scoped these two
 * grouped them as sharing a "per-token destination axis"; reading the card data
 * says otherwise, and that difference is the subject of most of what is below.
 *
 * Arise! therefore takes Recruit the Vanguard's shape — all tokens to one chosen
 * destination on `destinationBattlefieldId` — and Vanguard Armory asks, once per
 * token, through a decision that re-parks itself.
 */

const registry = defaultCardRegistry();
const VANGUARD_ARMORY = "SFD-168";
const ARISE = "SFD-198";
/** Two real Equipment, so Arise!'s count is read off cards that genuinely carry
 *  the printed tag rather than off a stub that merely claims to. */
const LONG_SWORD = "SFD-022";
const DORANS_BLADE = "SFD-095";
/** A Gear that is NOT an Equipment — Vanguard Armory itself. It must not be
 *  counted by Arise!, which is the mutation that separates "counts Equipment"
 *  from "counts gear". */
const NOT_AN_EQUIPMENT = VANGUARD_ARMORY;

/** Every unit `playerIndex` has anywhere, named — the garrisons a controlled
 *  battlefield needs are units too, so the counts below filter by name rather
 *  than totalling the board. */
const ownUnitsNamed = (state: GameState, playerIndex: 0 | 1, name: string) => {
  const id = state.players[playerIndex]!.id;
  return [
    ...state.players[playerIndex]!.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[id] ?? []),
  ].filter((u) => u.name === name);
};

const recruits = (state: GameState, playerIndex: 0 | 1) => ownUnitsNamed(state, playerIndex, "Recruit");

const sandSoldiers = (state: GameState, playerIndex: 0 | 1) => ownUnitsNamed(state, playerIndex, "Sand Soldier");

describe("Vanguard Armory (SFD-168): three Recruits, each to a location you pick", () => {
  /** p1 controls the Armory, ready, in the Action phase. */
  function armoryBoard(controlled: string[] = []): GameState {
    const state = makeState({ phase: "Action" });
    const armory: GearInstance = { ...realGearInstance(VANGUARD_ARMORY), instanceId: "armory" };
    state.players[0]!.activeGear = [armory];
    for (const bfId of controlled) {
      const bf = state.battlefields.find((b) => b.id === bfId)!;
      bf.controllerId = state.players[0]!.id;
      // A garrison, because control LAPSES. 323.6: a player with no units at a
      // battlefield loses control of it in the following Cleanup, and the
      // activation runs one — a fixture that only sets `controllerId` reads as
      // uncontrolled by the time the question is asked.
      bf.units = { ...bf.units, [state.players[0]!.id]: [makeUnit({ name: `Garrison ${bfId}` })] };
    }
    return state;
  }

  const activate = (state: GameState): GameState => {
    const action = legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "armory");
    expect(action, "the Armory's ability was not enumerated").toBeDefined();
    return resolveHeldTriggers(executeActivateAbility(state, action as never));
  };

  it("makes three Recruit tokens", () => {
    const after = answerDecisions(activate(armoryBoard()));
    expect(recruits(after, 0)).toHaveLength(VANGUARD_ARMORY_TOKENS);
  });

  it("asks nothing at all when base is the only legal destination", () => {
    // A one-option decision is not a question — `advanceDecisions` executes it
    // rather than opening a modal. With no controlled battlefield the whole
    // ability resolves in the activation, which is the common case.
    const after = activate(armoryBoard());
    expect(pendingDecision(after), "a pointless question was left on the queue").toBeUndefined();
    expect(recruits(after, 0)).toHaveLength(VANGUARD_ARMORY_TOKENS);
    expect(after.players[0]!.baseUnits).toHaveLength(VANGUARD_ARMORY_TOKENS);
  });

  it("offers base AND every battlefield the activator controls", () => {
    const after = activate(armoryBoard(["bf1", "bf2"]));
    const decision = pendingDecision(after);
    expect(decision?.kind).toBe("SFD-168-place");
    expect(optionsFor(after, decision!).map((o) => o.id).sort()).toEqual(["base", "bf1", "bf2"]);
  });

  it("does NOT offer a battlefield the activator merely occupies", () => {
    // "Battlefields you CONTROL" — deliberately stricter than the Unit
    // direct-deploy rule, the same distinction Recruit the Vanguard's validator
    // makes. bf1 is contested by p1 and controlled by nobody.
    const state = armoryBoard();
    state.battlefields[0]!.contestedByIndex = 0;
    const after = activate(state);
    expect(pendingDecision(after)).toBeUndefined();
    expect(recruits(after, 0)).toHaveLength(VANGUARD_ARMORY_TOKENS);
    expect(after.players[0]!.baseUnits).toHaveLength(VANGUARD_ARMORY_TOKENS);
  });

  it("really does split them — three answers, three different places", () => {
    // The parenthetical, and the reason this card could not just reuse Recruit
    // the Vanguard's single destination.
    let current = activate(armoryBoard(["bf1", "bf2"]));
    for (const pick of ["bf1", "bf2", "base"]) {
      const decision = pendingDecision(current);
      expect(decision, `no question left when picking ${pick}`).toBeDefined();
      const answered = answerDecision(current, decision!.id, pick);
      expect(answered, `${pick} was not on offer`).toBeDefined();
      current = answered!;
    }
    expect(pendingDecision(current), "the queue did not empty after three answers").toBeUndefined();
    const placed = recruits(current, 0);
    expect(placed).toHaveLength(VANGUARD_ARMORY_TOKENS);
    const at = (bfIndex: number) =>
      (current.battlefields[bfIndex]!.units[current.players[0]!.id] ?? []).filter((u) => u.name === "Recruit");
    expect(at(0)).toHaveLength(1);
    expect(at(1)).toHaveLength(1);
    expect(current.players[0]!.baseUnits.filter((u) => u.name === "Recruit")).toHaveLength(1);
  });

  it("counts down to exactly three and stops", () => {
    // The termination argument: the count is the decision's, and nothing an
    // answer does can add to it. Answering "base" every time must not loop.
    const after = answerDecisions(activate(armoryBoard(["bf1", "bf2"])), (options) => options[0]!.id);
    expect(recruits(after, 0)).toHaveLength(VANGUARD_ARMORY_TOKENS);
  });

  it("exhausts the Armory, so it is once per turn", () => {
    const after = activate(armoryBoard());
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
    expect(legalActions(after).filter((a) => a.type === "ActivateAbility")).toHaveLength(0);
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(VANGUARD_ARMORY))).toBe(true);
  });
});

describe("Arise! (SFD-198): one Sand Soldier per Equipment, then ready two", () => {
  /** p1 holds Arise!, controls `gearDefIds`, and has runes enough to cast it —
   *  6 Energy and 1 Calm Power printed. */
  function ariseBoard(gearDefIds: string[]): { state: GameState; spellId: string } {
    const spell = spellInstance(ARISE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `r-${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    state.players[0]!.activeGear = gearDefIds.map((defId, i) => ({
      ...realGearInstance(defId),
      instanceId: `gear-${i}`,
    }));
    return { state, spellId: spell.instanceId };
  }

  /** Casts Arise! through the ENUMERATOR rather than a hand-built action, so
   *  every one of these also proves the card is offered at all — the discipline
   *  cards-gear.test.ts records: an effect that resolves correctly and is never
   *  enumerated is unreachable. */
  const cast = (state: GameState, spellId: string, destinationBattlefieldId?: string): GameState => {
    const play = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" &&
        a.card.instanceId === spellId &&
        a.destinationBattlefieldId === destinationBattlefieldId,
    );
    expect(play, `Arise! was not offered for destination ${destinationBattlefieldId ?? "base"}`).toBeDefined();
    return resolveHeldTriggers(executePlayCard(state, play!));
  };

  it("makes one Sand Soldier for each Equipment controlled", () => {
    const { state, spellId } = ariseBoard([LONG_SWORD, DORANS_BLADE]);
    expect(sandSoldiers(cast(state, spellId), 0)).toHaveLength(2);
  });

  it("makes none with no Equipment — the card is a blank on an empty board", () => {
    const { state, spellId } = ariseBoard([]);
    expect(sandSoldiers(cast(state, spellId), 0)).toHaveLength(0);
  });

  it("does NOT count gear that is not an Equipment", () => {
    // The mutation that separates "Equipment you control" from "gear you
    // control". Vanguard Armory is a Gear and carries no Equipment tag, so a
    // board of two Armories and one Long Sword makes ONE Sand Soldier.
    const { state, spellId } = ariseBoard([NOT_AN_EQUIPMENT, NOT_AN_EQUIPMENT, LONG_SWORD]);
    expect(sandSoldiers(cast(state, spellId), 0)).toHaveLength(1);
  });

  it("readies up to two of them and leaves the rest exhausted", () => {
    // Three Equipment, so three tokens: two ready, one exhausted. Anything that
    // readied all of them or none of them fails here.
    const { state, spellId } = ariseBoard([LONG_SWORD, DORANS_BLADE, "SFD-161"]);
    const made = sandSoldiers(cast(state, spellId), 0);
    expect(made).toHaveLength(3);
    expect(made.filter((u) => !u.exhausted)).toHaveLength(2);
    expect(made.filter((u) => u.exhausted)).toHaveLength(1);
  });

  it("readies only what it made when fewer than two exist", () => {
    const { state, spellId } = ariseBoard([LONG_SWORD]);
    const made = sandSoldiers(cast(state, spellId), 0);
    expect(made).toHaveLength(1);
    expect(made[0]!.exhausted).toBe(false);
  });

  it("readies only ITS OWN tokens, not a Sand Soldier already standing there", () => {
    // "Ready up to two of THEM". A Sand Soldier from Desert's Call sitting in
    // base must still be exhausted afterwards, which is why the ids are captured
    // from the placement rather than re-derived from the board.
    const { state, spellId } = ariseBoard([LONG_SWORD]);
    state.players[0]!.baseUnits = [
      { ...(sandSoldiers(cast(state, spellId), 0)[0]!), instanceId: "older", exhausted: true },
    ];
    const after = cast(state, spellId);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "older")!.exhausted).toBe(true);
  });

  it("sends all of them to ONE chosen destination", () => {
    // Not a per-token split: the printed text carries no parenthetical, unlike
    // Vanguard Armory's.
    const { state, spellId } = ariseBoard([LONG_SWORD, DORANS_BLADE]);
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    const after = cast(state, spellId, "bf1");
    expect(after.battlefields[0]!.units[after.players[0]!.id]).toHaveLength(2);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("is offered a battlefield destination only where the caster has CONTROL", () => {
    // Registered in `TOKEN_PLACEMENT_SPELL_DEF_IDS`, so the enumerator and the
    // validator apply Recruit the Vanguard's stricter rule. bf1 controlled, bf2
    // not.
    const { state, spellId } = ariseBoard([LONG_SWORD]);
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `r-${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    const destinations = legalActions(state)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId)
      .map((a) => a.destinationBattlefieldId);
    expect(destinations).toContain("bf1");
    expect(destinations).not.toContain("bf2");
    expect(destinations).toContain(undefined); // base
  });

  it("the validator accepts every destination the enumerator offers", () => {
    const { state, spellId } = ariseBoard([LONG_SWORD]);
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `r-${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId,
    );
    expect(plays.length).toBeGreaterThan(1);
    for (const play of plays) {
      const result = validatePlayCard(state, play);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(ARISE))).toBe(true);
  });
});
