import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { recordConquest } from "../src/engine/scoring.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { addBuff, dealDamage, destroyUnit } from "../src/engine/effect-helpers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { submit } from "../src/engine/game-engine.js";
import { winner } from "../src/engine/win-condition.js";
import { WIN_THRESHOLD_1V1 } from "../src/engine/constants.js";
import { implementingModule, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
} from "./fixtures.js";

/**
 * The OGN Legends whose printed text had no implementation.
 *
 * Everything that can be driven through the real ActivateAbility path is —
 * `legalActions` for what is offered, `executeActivateAbility` for what happens.
 * A Legend ability that resolves correctly but is never enumerated is the
 * "implemented but unreachable" failure this project has already hit once, and
 * only the enumeration half catches it.
 */

const registry = defaultCardRegistry();

const KAISA = "OGN-247";
const VOLIBEAR = "OGN-249";
const DARIUS = "OGN-253";
const AHRI = "OGN-255";
const YASUO = "OGN-259";
const MISS_FORTUNE = "OGN-267";
const SETT = "OGN-269";

/** A state whose player 0 has `defId` as their Legend. */
function withLegend(defId: string, overrides: Partial<GameState> = {}): GameState {
  const state = makeState({ phase: "Action", ...overrides });
  const def = registry.get(defId);
  state.players[0]!.legend = {
    instanceId: "legend-0",
    defId,
    name: def.name,
    domains: def.domains,
    exhausted: false,
    isToken: false,
    kind: "Legend",
    championTag: "TEST",
  };
  return state;
}

const legendActions = (state: GameState) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "legend-0");

const unitsAt = (state: GameState, playerId: string, bf = 0) => state.battlefields[bf]!.units[playerId] ?? [];

describe("Miss Fortune - Bounty Hunter (OGN-267): exhaust, give a unit [Ganking]", () => {
  it("grants [Ganking] for this turn through the real activation path", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = withLegend(MISS_FORTUNE);
    state.battlefields[0]!.units = { p1: [mine] };

    const action = legendActions(state).find(
      (a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === mine.instanceId,
    )!;
    const after = executeActivateAbility(state, action as never);

    expect(hasKeyword(after, unitsAt(after, "p1")[0]!, 0, "Ganking")).toBe(true);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("reaches a unit in base and an ENEMY unit — the card says only 'a unit'", () => {
    const atHome = makeUnit({ name: "At home" });
    const enemy = makeUnit({ name: "Enemy" });
    const state = withLegend(MISS_FORTUNE);
    state.players[0]!.baseUnits = [atHome];
    state.battlefields[0]!.units = { p2: [enemy] };

    const targets = new Set(
      legendActions(state).map((a) => (a.type === "ActivateAbility" ? a.targetUnitInstanceId : undefined)),
    );

    expect(targets.has(atHome.instanceId)).toBe(true);
    expect(targets.has(enemy.instanceId)).toBe(true);
  });

  it("is not offered once exhausted", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = withLegend(MISS_FORTUNE);
    state.battlefields[0]!.units = { p1: [mine] };
    state.players[0]!.legend.exhausted = true;

    expect(legendActions(state)).toHaveLength(0);
  });
});

describe("Darius - Hand of Noxus (OGN-253): exhaust, [Legion] — add 1 Energy", () => {
  it("adds 1 floating Energy once a card has been played this turn", () => {
    const state = withLegend(DARIUS);
    state.players[0]!.cardsPlayedThisTurn = 1;

    const after = executeActivateAbility(state, legendActions(state)[0]! as never);

    expect(after.players[0]!.floatingEnergy).toBe(1);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("gives nothing when [Legion] is unmet — but still spends the exhaust", () => {
    // [Legion] is a condition on the EFFECT, not a cost. Rule-faithful and
    // deliberately not softened: paying for nothing is what the keyword means.
    const state = withLegend(DARIUS);
    state.players[0]!.cardsPlayedThisTurn = 0;

    const after = executeActivateAbility(state, legendActions(state)[0]! as never);

    expect(after.players[0]!.floatingEnergy).toBe(0);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("banks unrestricted Energy — a Unit can spend it, unlike Lux - Crownguard's", () => {
    const state = withLegend(DARIUS);
    state.players[0]!.cardsPlayedThisTurn = 1;
    const after = executeActivateAbility(state, legendActions(state)[0]! as never);

    // floatingEnergy, not restrictedSpellEnergy — the two pools are the whole
    // difference between this card and Lux - Crownguard's.
    expect(after.players[0]!.restrictedSpellEnergy).toBe(0);
    expect(computeEffectiveCost(after.players[0]!.floatingEnergy, {}, 1, 0, null).energyCost).toBe(0);
  });
});

describe("Kai'Sa - Daughter of the Void (OGN-247): exhaust, add 1 rainbow Power for spells", () => {
  it("banks 1 restricted Power", () => {
    const state = withLegend(KAISA);
    const after = executeActivateAbility(state, legendActions(state)[0]! as never);

    expect(after.players[0]!.restrictedSpellPower).toBe(1);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("pays a Power pip of ANY domain — it is rainbow", () => {
    // The point of a scalar rather than a floatingPower entry: a Domain-keyed
    // record cannot express "any".
    const banked = 1;
    for (const domain of ["Calm", "Fury", "Order"] as const) {
      expect(computeEffectiveCost(0, {}, 0, 1, domain, undefined, 0, banked).powerCost).toBe(0);
    }
  });

  it("is Spells only — the caller passes 0 for a Unit or Gear", () => {
    // Enforced at the call sites (legal-actions, validate-play-card,
    // execute-play-card) exactly as restrictedSpellEnergy is, so a Unit's cost
    // never sees the pool at all.
    expect(computeEffectiveCost(0, {}, 0, 1, "Calm", undefined, 0, 0).powerCost).toBe(1);
  });
});

describe("Yasuo - Unforgiven (OGN-259): 2 Energy, exhaust — move a friendly unit to or from its base", () => {
  /** Yasuo with 2 ready runes, one unit at bf1 and one at home. */
  function yasuoState(): { state: GameState; atField: UnitInstance; atHome: UnitInstance } {
    const atField = makeUnit({ name: "At bf1" });
    const atHome = makeUnit({ name: "At home" });
    const state = withLegend(YASUO);
    state.battlefields[0]!.units = { p1: [atField] };
    state.players[0]!.baseUnits = [atHome];
    state.players[0]!.channeled = [
      { id: "r1", domain: "Calm", state: "Ready" },
      { id: "r2", domain: "Chaos", state: "Ready" },
    ];
    return { state, atField, atHome };
  }

  it("offers both modes", () => {
    const { state } = yasuoState();
    const modes = new Set(legendActions(state).map((a) => (a.type === "ActivateAbility" ? a.modeId : undefined)));
    expect(modes).toEqual(new Set(["toBase", "fromBase"]));
  });

  it("sends a unit at a battlefield home, and pays the 2 Energy", () => {
    const { state, atField } = yasuoState();
    const action = legendActions(state).find(
      (a) => a.type === "ActivateAbility" && a.modeId === "toBase" && a.targetUnitInstanceId === atField.instanceId,
    )!;

    const after = executeActivateAbility(state, action as never);

    expect(unitsAt(after, "p1")).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toContain("At bf1");
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(0);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("sends a unit from base to a CHOSEN battlefield", () => {
    const { state, atHome } = yasuoState();
    const action = legendActions(state).find(
      (a) =>
        a.type === "ActivateAbility" &&
        a.modeId === "fromBase" &&
        a.targetUnitInstanceId === atHome.instanceId &&
        a.destinationBattlefieldId === "bf2",
    )!;

    const after = executeActivateAbility(state, action as never);

    expect(unitsAt(after, "p1", 1).map((u) => u.name)).toEqual(["At home"]);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("the moved unit arrives READY — the exhaust is on the Standard Move action (414.3.a)", () => {
    const { state, atHome } = yasuoState();
    const action = legendActions(state).find(
      (a) => a.type === "ActivateAbility" && a.modeId === "fromBase" && a.targetUnitInstanceId === atHome.instanceId,
    )!;

    const after = executeActivateAbility(state, action as never);
    const moved = [...unitsAt(after, "p1"), ...unitsAt(after, "p1", 1)].find((u) => u.name === "At home")!;

    expect(moved.exhausted).toBe(false);
  });

  it("never offers a destination the unit is already at", () => {
    const { state, atField } = yasuoState();
    const offered = legendActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.modeId === "fromBase" && a.targetUnitInstanceId === atField.instanceId,
    );

    expect(offered.every((a) => a.type === "ActivateAbility" && a.destinationBattlefieldId !== "bf1")).toBe(true);
  });

  it("REFUSES a forged move to where the unit already stands", () => {
    const { state, atField } = yasuoState();
    const template = legendActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "fromBase")!;
    const forged = { ...template, targetUnitInstanceId: atField.instanceId, destinationBattlefieldId: "bf1" };

    expect(validateActivateAbility(state, forged as never).ok).toBe(false);
  });

  it("is not offered without the 2 Energy", () => {
    const { state } = yasuoState();
    state.players[0]!.channeled = [{ id: "r1", domain: "Calm", state: "Ready" }];
    expect(legendActions(state)).toHaveLength(0);
  });
});

describe("Ahri - Nine-Tailed Fox (OGN-255): an enemy attacking a battlefield you control gets -1 Might", () => {
  /**
   * p1 controls bf1 and has Ahri and a defender there; p2 is about to attack it.
   *
   * **The defender is not decoration.** "Attacks" means gaining the Attacker
   * designation (383.4.f), and 464.2.c hands those out only when Combat opens — which
   * needs units of both players present (341). Walking into a battlefield you
   * control but do not occupy opens a NON-Combat Showdown, where nobody attacks
   * and nobody defends. These tests used to call `dispatchOnAttack` with a unit
   * and an index, so the board never had to be a board a combat could happen on.
   */
  function ahriState(controlled: boolean): { state: GameState; attacker: UnitInstance } {
    const attacker = makeUnit({ name: "Attacker", might: 4 });
    const state = withLegend(AHRI);
    state.battlefields[0]!.controllerId = controlled ? "p1" : null;
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Defender", might: 4 })], p2: [attacker] };
    return { state, attacker };
  }

  it("debuffs the attacker when the combat opens", () => {
    const { state } = ahriState(true);
    const after = beginCombatAt(state, "bf1", 1);

    expect(unitsAt(after, "p2")[0]!.mightThisTurn).toBe(-1);
  });

  it("does nothing at a battlefield its controller does NOT hold", () => {
    const { state } = ahriState(false);
    const after = beginCombatAt(state, "bf1", 1);

    expect(unitsAt(after, "p2")[0]!.mightThisTurn).toBe(0);
  });

  it("does not debuff its OWN controller's attacking units", () => {
    const mine = makeUnit({ name: "Mine", might: 4 });
    const state = withLegend(AHRI);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [mine], p2: [makeUnit({ name: "Theirs", might: 4 })] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(unitsAt(after, "p1")[0]!.mightThisTurn).toBe(0);
  });

  it("floors at 1 Might across repeated combats", () => {
    // 383.4.e checks an attack trigger's condition "once per combat", so the ten
    // firings this needs are ten separate combats rather than ten dispatches into
    // one. Between them the battlefield is returned to an uncontested Neutral
    // state, which is what closing a Showdown does (190.3.b).
    const { state } = ahriState(true);
    let after = state;
    for (let i = 0; i < 10; i += 1) {
      after = beginCombatAt(
        {
          ...after,
          turnState: "Neutral",
          showdownBattlefieldId: null,
          showdownKind: null,
          battlefields: after.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, contestedByIndex: null } : bf)),
        },
        "bf1",
        1,
      );
    }

    // 4 printed Might, floored at 1 -> the stored modifier stops at -3.
    expect(unitsAt(after, "p2")[0]!.mightThisTurn).toBe(-3);
  });
});

describe("Volibear - Relentless Storm (OGN-249): playing a [Mighty] unit may exhaust him to channel", () => {
  /** Volibear with a rune deck to channel from. */
  function voliState(): GameState {
    const state = withLegend(VOLIBEAR);
    state.players[0]!.runeDeck = [{ id: "r1", domain: "Fury", state: "Ready" }];
    return state;
  }

  /**
   * Plays a unit of `might` the way a real play does: the unit arrives, the
   * on-play dispatch runs, and `cardPlayed` is HELD.
   *
   * That last part is the whole of the fix. Volibear used to be fired from inside
   * `dispatchOnPlayUnit`, so `playUnitTrigger` alone reached him; he is a
   * `cardPlayed` listener now, and only the EXECUTORS hold that event — so a
   * helper that skips it stops reaching him, which is exactly what a card played
   * through a path that forgot the event would look like.
   */
  function play(state: GameState, might: number): GameState {
    const unit = makeUnit({ name: `M${might}`, might });
    const withUnit: GameState = {
      ...state,
      players: [{ ...state.players[0]!, baseUnits: [...state.players[0]!.baseUnits, unit] }, state.players[1]!],
    };
    const arrived = dispatchOnPlayUnit(withUnit, unit, 0, "base", {});
    return resolveHeldTriggers(
      holdEventTrigger(arrived, { kind: "cardPlayed", casterIndex: 0, playedKind: "Unit", playedInstanceId: unit.instanceId, playedPowerCost: 0 }),
    );
  }

  it("asks when a 5-Might unit is played, and channels 1 exhausted when accepted", () => {
    const asked = play(voliState(), 5);
    expect(pendingDecision(asked)!.kind).toBe("OGN-249-channel");

    const after = answerDecisions(asked, (o) => o.find((x) => x.id === "channel")!.id);

    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted"]);
    expect(after.players[0]!.runeDeck).toHaveLength(0);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("declining leaves him ready and channels nothing", () => {
    const after = answerDecisions(play(voliState(), 5), (o) => o.find((x) => x.id === "decline")!.id);

    expect(after.players[0]!.channeled).toHaveLength(0);
    expect(after.players[0]!.legend.exhausted).toBe(false);
  });

  it("does not ask for a 4-Might unit — [Mighty] is 5+ (rule 708)", () => {
    expect(play(voliState(), 4).pendingDecisions).toHaveLength(0);
  });

  it("counts Might the unit actually HAS, not its printed value", () => {
    // A 4-Might unit standing with Garen - Commander is a 5-Might unit, and
    // rule 710 asks about current Might. Reading `unit.might` would disagree
    // with what the board shows.
    const state = voliState();
    const garen = realUnitInstance("OGS-013"); // Garen - Commander, "+1 Might here"
    state.players[0]!.baseUnits = [garen];

    expect(play(state, 4).pendingDecisions.map((d) => d.kind)).toEqual(["OGN-249-channel"]);
  });

  it("does not ask when he is already exhausted — the cost is unpayable", () => {
    const state = voliState();
    state.players[0]!.legend.exhausted = true;

    expect(play(state, 5).pendingDecisions).toHaveLength(0);
  });

  it("does not fire for the OPPONENT's unit", () => {
    const state = voliState();
    const enemy = makeUnit({ name: "Enemy", might: 7 });
    const withEnemy: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, baseUnits: [enemy] }],
    };

    expect(playUnitTrigger(withEnemy, enemy, 1, "base", {}).pendingDecisions).toHaveLength(0);
  });
});

/**
 * A conquest, driven through the real `recordConquest` and then settled.
 *
 * These used to call `dispatchLegendOnConquer` directly; there is no such
 * dispatcher any more. A Legend's "when you conquer" is a Chain Pending Item like
 * the permanents watching the same moment (383), so it is held by
 * `recordConquest` and resolves a chain-pop later — see
 * `test/legend-triggers-held.test.ts` for the timing itself.
 */
const conquer = (state: GameState, index: 0 | 1 = 0, battlefieldId = "bf1") =>
  resolveHeldTriggers(recordConquest(state, index, battlefieldId));

describe("Sett - The Boss (OGN-269): when you conquer, ready me", () => {
  it("readies the legend on a conquest", () => {
    const state = withLegend(SETT);
    state.players[0]!.legend.exhausted = true;

    const after = conquer(state);

    expect(after.players[0]!.legend.exhausted).toBe(false);
  });

  it("is a no-op when he is already ready", () => {
    // Was `expect(after).toBe(state)`. Identity cannot survive this path — the
    // conquest awards a point and the settle runs a Cleanup, both of which return
    // fresh objects — and it was only ever standing in for "he is still ready".
    // 415: readying an already-ready permanent does nothing. He still TRIGGERS,
    // because "when you conquer, ready me" carries no other requirement, and a
    // trigger that resolves to nothing is the rules working.
    const state = withLegend(SETT);

    const after = conquer(state);

    expect(after.players[0]!.legend.exhausted).toBe(false);
  });
});

describe("Sett - The Boss (OGN-269): a buffed unit that would die may be saved instead", () => {
  /** Sett's controller has a buffed unit at bf1 and a rune to pay with. */
  function settState(options: { buffed?: boolean; power?: boolean; legendReady?: boolean } = {}): {
    state: GameState;
    victim: UnitInstance;
  } {
    const victim = makeUnit({ name: "Victim", might: 2 });
    let state = withLegend(SETT);
    state.battlefields[0]!.units = { p1: [victim] };
    state.players[0]!.legend.exhausted = options.legendReady === false;
    if (options.power !== false) state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    if (options.buffed !== false) state = addBuff(state, victim.instanceId);
    return { state, victim };
  }

  it("asks instead of killing — the unit is in neither play nor the trash yet", () => {
    const { state, victim } = settState();

    const asked = destroyUnit(state, victim.instanceId, 1);

    expect(pendingDecision(asked)!.kind).toBe("OGN-269-save");
    expect(asked.players[0]!.trash).toHaveLength(0);
    expect(unitsAt(asked, "p1")).toHaveLength(0);
    expect(asked.unitsAwaitingDeathReplacement.map((p) => p.unit.instanceId)).toEqual([victim.instanceId]);
  });

  /**
   * Rule 194.2 declares a win IN A CLEANUP, and 321 forbids a Cleanup while a
   * resolution is suspended. So points crossing the Victory Score while a question
   * is outstanding is not yet a win, and the answer must still be accepted.
   *
   * This is a `submit` test on purpose. Every other test in this describe drives
   * `destroyUnit` / `answerDecisions` directly, which bypasses submit's entry gate
   * entirely — and that gate was the bug: it read `winner` as a bare points
   * predicate and refused the AnswerDecision that would have finished the
   * resolution, leaving the unit in `unitsAwaitingDeathReplacement` forever, in
   * neither play nor a trash. Measured at 5 stranded units per 300 self-play games.
   */
  it("still accepts the answer when the same action crossed the Victory Score (194.2)", () => {
    const { state, victim } = settState();
    // The state an action leaves behind when it parks the offer and then scores:
    // question outstanding, unit held, points already over the threshold.
    const asked = destroyUnit(state, victim.instanceId, 1);
    expect(pendingDecision(asked)!.kind).toBe("OGN-269-save");

    const won: GameState = {
      ...asked,
      players: [{ ...asked.players[0]!, points: WIN_THRESHOLD_1V1 }, asked.players[1]!] as GameState["players"],
    };
    expect(winner(won)).toBe(0); // the points predicate alone says the game is over

    const decision = pendingDecision(won)!;
    const answer = legalActions(won).find((a) => a.type === "AnswerDecision");
    expect(answer).toBeDefined(); // the question is still on offer

    const { state: after, result } = submit(won, {
      type: "AnswerDecision",
      playerIndex: decision.playerIndex,
      decisionId: decision.id,
      optionId: "die",
    });

    expect(result.type).not.toBe("Invalid"); // was "Game is already over"
    expect(after.unitsAwaitingDeathReplacement).toHaveLength(0); // nothing stranded
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(victim.instanceId);
    expect(result).toEqual({ type: "GameOver", winnerId: "p1" }); // and NOW the win is declared
  });

  it("refuses every action once the win is actually declared, with no question pending", () => {
    // The other side of the same gate: no suspension, so the points predicate is
    // the whole answer and the game really is over.
    const over: GameState = {
      ...makeState(),
      players: [{ ...makeState().players[0]!, points: WIN_THRESHOLD_1V1 }, makeState().players[1]!] as GameState["players"],
    };
    const { result } = submit(over, { type: "Pass", playerIndex: 0 });
    expect(result).toEqual({ type: "Invalid", error: "Game is already over" });
  });

  it("saves it: healed, exhausted, recalled to base — and pays all three costs", () => {
    const { state, victim } = settState();
    const damaged = dealDamage(state, 1, victim.instanceId, 1); // 1 damage, not lethal
    expect(unitsAt(damaged, "p1")[0]!.damage).toBe(1);

    const after = answerDecisions(destroyUnit(damaged, victim.instanceId, 1), (o) => o.find((x) => x.id === "save")!.id);
    const saved = after.players[0]!.baseUnits.find((u) => u.instanceId === victim.instanceId)!;

    expect(saved.damage).toBe(0); // healed
    expect(saved.exhausted).toBe(true); // exhausted
    expect(saved.buffed).toBe(false); // buff spent as part of the cost
    expect(after.players[0]!.legend.exhausted).toBe(true); // Sett exhausted
    expect(after.players[0]!.channeled).toHaveLength(0); // 1 rainbow Power recycled
    expect(after.players[0]!.trash).toHaveLength(0); // it never died
    expect(after.unitsAwaitingDeathReplacement).toHaveLength(0);
  });

  it("a SAVED unit fires no [Deathknell] — 808.1.d.1, a replaced death is not a death", () => {
    // Soaring Scout's Deathknell channels a rune. Saving it must channel nothing.
    const scout = realUnitInstance("OGN-216");
    let state = withLegend(SETT);
    state.battlefields[0]!.units = { p1: [scout] };
    state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    state.players[0]!.runeDeck = [{ id: "r2", domain: "Order", state: "Ready" }];
    state = addBuff(state, scout.instanceId);

    const after = answerDecisions(destroyUnit(state, scout.instanceId, 1), (o) => o.find((x) => x.id === "save")!.id);

    // The Deathknell would have channelled a rune INTO `channeled`, exhausted.
    // Nothing is there: r1 was spent paying for the save (a Power payment
    // recycles the rune to the bottom of the rune deck, 416), and the Deathknell
    // never ran.
    expect(after.players[0]!.channeled).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toContain("OGN-216");
  });

  it("declining lets it die normally — trash, and its [Deathknell] DOES fire", () => {
    const scout = realUnitInstance("OGN-216");
    let state = withLegend(SETT);
    state.battlefields[0]!.units = { p1: [scout] };
    state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    state.players[0]!.runeDeck = [{ id: "r2", domain: "Order", state: "Ready" }];
    state = addBuff(state, scout.instanceId);

    const after = resolveHeldTriggers(answerDecisions(destroyUnit(state, scout.instanceId, 1), (o) => o.find((x) => x.id === "die")!.id));

    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(scout.instanceId);
    // Its Deathknell DID run: r2 came out of the rune deck into `channeled`,
    // exhausted. r1 is still there untouched, because declining pays nothing.
    expect(after.players[0]!.channeled.find((r) => r.id === "r2")).toMatchObject({ state: "Exhausted" });
    expect(after.players[0]!.channeled.find((r) => r.id === "r1")).toMatchObject({ state: "Ready" });
    expect(after.players[0]!.legend.exhausted).toBe(false); // declining costs nothing
  });

  it("strips the buff from a declined unit before it reaches the trash (705)", () => {
    const { state, victim } = settState();
    const after = answerDecisions(destroyUnit(state, victim.instanceId, 1), (o) => o.find((x) => x.id === "die")!.id);

    expect(after.players[0]!.trash.find((c) => c.instanceId === victim.instanceId)).toMatchObject({ buffed: false });
  });

  it("does not offer for an UNBUFFED unit", () => {
    const { state, victim } = settState({ buffed: false });
    const after = destroyUnit(state, victim.instanceId, 1);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(victim.instanceId);
  });

  it("does not offer with no Power to pay", () => {
    const { state, victim } = settState({ power: false });
    expect(destroyUnit(state, victim.instanceId, 1).pendingDecisions).toHaveLength(0);
  });

  it("does not offer while Sett is exhausted — and conquering gives him back", () => {
    const { state, victim } = settState({ legendReady: false });
    expect(destroyUnit(state, victim.instanceId, 1).pendingDecisions).toHaveLength(0);

    const readied = conquer(state);
    expect(destroyUnit(readied, victim.instanceId, 1).pendingDecisions).toHaveLength(1);
  });

  it("does not offer for the OPPONENT's buffed unit", () => {
    const enemy = makeUnit({ name: "Theirs" });
    let state = withLegend(SETT);
    state.battlefields[0]!.units = { p2: [enemy] };
    state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    state = addBuff(state, enemy.instanceId);

    expect(destroyUnit(state, enemy.instanceId, 0).pendingDecisions).toHaveLength(0);
  });

  it("saves a unit killed by COMBAT damage too, not just by an effect", () => {
    const { state, victim } = settState();
    const attacker = makeUnit({ name: "Attacker", might: 9 });
    const fighting: GameState = {
      ...state,
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [attacker] } } : bf)),
    };

    const after = answerDecisions(resolveShowdown(fighting, "bf1", 1), (o) => {
      const save = o.find((x) => x.id === "save");
      return save ? save.id : o[0]!.id;
    });

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toContain(victim.instanceId);
    expect(after.players[0]!.trash).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("reports the seven reachable OGN legends as implemented", () => {
    const done = [KAISA, VOLIBEAR, DARIUS, AHRI, YASUO, MISS_FORTUNE];
    expect(done.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });

  it("reports Sett as implemented now that BOTH his clauses work", () => {
    // He was on coverage's PARTIALLY_IMPLEMENTED list while only the on-conquer
    // half existed; the entry was deleted when the replacement landed rather
    // than reworded, which is the shape that list is meant to have.
    expect(isCardImplemented(registry.get(SETT))).toBe(true);
    expect(partialImplementationNote(registry.get(SETT))).toBeUndefined();
    expect(implementingModule(SETT)).toBe("legend-abilities");
  });

  it("never reports a partly-implemented card as implemented", () => {
    // The invariant the PARTIALLY_IMPLEMENTED list exists to hold. Vacuous right
    // now — the list is empty, which is the intended resting state — but it is
    // the assertion that will catch the next half-finished card, and writing it
    // only when one appears is how the mechanism rots in between.
    const lying = registry
      .all()
      .filter((def) => partialImplementationNote(def) !== undefined && isCardImplemented(def));
    expect(lying.map((d) => d.id)).toEqual([]);
  });
});
