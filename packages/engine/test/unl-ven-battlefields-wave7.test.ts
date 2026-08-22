import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { ALTAR_OF_BLOOD_SAVE } from "../src/engine/death-ward.js";
import { killUnit } from "../src/engine/effect-helpers.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL battlefields, wave 7 — a death replacement and a self-inflicted tax.**
 *
 *   UNL-206 Altar of Blood  — if a unit here would die DURING COMBAT, its
 *                             controller may pay [3 rainbow] to heal, exhaust and
 *                             recall it instead
 *   UNL-219 Vaults of Helia — when you hold here, your NON-TOKEN units cost
 *                             [1 Energy] more to play this turn
 *
 * # Two firsts, and each needed a new seam
 *
 * **Altar of Blood is the pool's first POSITIONAL death replacement and its first
 * from a BATTLEFIELD.** Every other one is sourced from a card its controller
 * owns — Highlander's armed ward, Sett's legend ability, the Hourglass in play,
 * Guardian Angel attached, Soraka standing by. This one is a property of WHERE
 * the unit died, so it reaches both players and neither has to own anything.
 *
 * That also made it a FIFTH way a battlefield can be implemented, and
 * `battlefield-coverage.test.ts` — the only gate that can see a battlefield at
 * all — still listed four. It reported the card as doing nothing until told.
 *
 * **Vaults of Helia is the first cost INCREASE a player inflicts on themselves.**
 * It arms a this-turn number on the player, read by `modifiedEnergyCost`, which
 * BOTH the enumerator and the validator go through — a tax visible to only one of
 * them is this codebase's offered-then-refused bug.
 */

const ALTAR_OF_BLOOD = "UNL-206";
const VAULTS_OF_HELIA = "UNL-219";

const rune = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Calm", state });

/** bf1 IS the named battlefield, with `units` there for p1. */
function board(defId: string, units: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units } };
  return state;
}

/** Kills `unit` AT bf1, telling the funnel whether it was combat. */
function kill(state: GameState, unit: UnitInstance, inCombat: boolean): GameState {
  const without = {
    ...state,
    battlefields: state.battlefields.map((bf, i) =>
      i === 0 ? { ...bf, units: { p1: (bf.units.p1 ?? []).filter((u) => u.instanceId !== unit.instanceId) } } : bf,
    ),
  };
  // `killUnit`'s contract: the unit is already removed from wherever it was.
  return killUnit(without, unit, 0, "bf1", 1, inCombat || undefined);
}

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [ALTAR_OF_BLOOD, "Altar of Blood", "would die during combat"],
      [VAULTS_OF_HELIA, "Vaults of Helia", "cost"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Altar of Blood (UNL-206): pay 3 Power to undo a combat death", () => {
  const doomed = () => makeUnit({ instanceId: "d", name: "Doomed", might: 3 });

  function altar(pips: number): { state: GameState; unit: UnitInstance } {
    const unit = doomed();
    const state = board(ALTAR_OF_BLOOD, [unit]);
    state.players[0]!.channeled = Array.from({ length: pips }, (_, i) => rune(`r${i}`));
    return { state, unit };
  }

  it("offers the save for a unit that died IN COMBAT here", () => {
    const { state, unit } = altar(3);
    const after = kill(state, unit, true);
    expect(pendingDecision(after)?.kind, "no save was offered").toBe(ALTAR_OF_BLOOD_SAVE);
  });

  it("heals, exhausts and recalls it when paid", () => {
    const { state, unit } = altar(3);
    const after = kill(state, unit, true);
    const saved = answerDecision(after, pendingDecision(after)!.id, "save")!;

    const home = saved.players[0]!.baseUnits.find((u) => u.instanceId === "d");
    expect(home, "the unit was not recalled").toBeDefined();
    expect(home!.damage, "it was not healed").toBe(0);
    expect(home!.exhausted, "it was not exhausted").toBe(true);
    expect(saved.players[0]!.trash.map((c) => c.instanceId), "it reached the trash anyway").toEqual([]);
    expect(saved.players[0]!.channeled.filter((r) => r.state === "Ready"), "the 3 Power was not spent").toHaveLength(0);
  });

  it("lets it die when declined, and costs nothing", () => {
    const { state, unit } = altar(3);
    const after = kill(state, unit, true);
    const died = answerDecision(after, pendingDecision(after)!.id, "die")!;
    expect(died.players[0]!.trash.map((c) => c.instanceId), "declining still saved it").toEqual(["d"]);
    expect(died.players[0]!.channeled.filter((r) => r.state === "Ready"), "declining spent Power").toHaveLength(3);
  });

  it("does NOT offer for a death outside combat — 'would die DURING COMBAT'", () => {
    // The clause that makes this insurance against the damage step rather than
    // against removal. A unit killed here by a Spell is not covered.
    const { state, unit } = altar(3);
    const after = kill(state, unit, false);
    expect(pendingDecision(after), "a non-combat death was offered the save").toBeUndefined();
    expect(after.players[0]!.trash.map((c) => c.instanceId), "it did not simply die").toEqual(["d"]);
  });

  it("does NOT offer at another battlefield — 'a unit HERE'", () => {
    const unit = doomed();
    const state = makeState({ phase: "Action" });
    state.battlefields[1] = { ...state.battlefields[1]!, defId: ALTAR_OF_BLOOD };
    state.players[0]!.channeled = [rune("r0"), rune("r1"), rune("r2")];
    expect(pendingDecision(killUnit(state, unit, 0, "bf1", 1, true)), "a death elsewhere was offered it").toBeUndefined();
  });

  it("does NOT ask with fewer than 3 Power — 416.3", () => {
    const { state, unit } = altar(2);
    expect(pendingDecision(kill(state, unit, true)), "asked with too little Power").toBeUndefined();
  });

  it("reaches the OPPONENT's unit too — it is the battlefield's, not a player's", () => {
    // Every other death replacement in the pool is sourced from a card its
    // controller owns. This one is positional, so it insures whoever is standing
    // on it.
    const theirs = makeUnit({ instanceId: "t", name: "Theirs", might: 3 });
    const state = makeState({ phase: "Action" });
    state.battlefields[0] = { ...state.battlefields[0]!, defId: ALTAR_OF_BLOOD, units: { p2: [theirs] } };
    state.players[1]!.channeled = [rune("e0"), rune("e1"), rune("e2")];

    const after = killUnit(state, theirs, 1, "bf1", 0, true);
    expect(pendingDecision(after)?.kind, "the opponent was not offered it").toBe(ALTAR_OF_BLOOD_SAVE);
    expect(pendingDecision(after)?.playerIndex, "the wrong player was asked").toBe(1);
  });
});

describe("Vaults of Helia (UNL-219): your own units cost more this turn", () => {
  function holding(): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: VAULTS_OF_HELIA,
      units: { p1: [makeUnit()] },
      controllerId: "p1",
    };
    return state;
  }

  const unitCost = (state: GameState, raw = 3) => modifiedEnergyCost(state, 0, "Unit", raw);

  it("taxes a non-token unit after the hold", () => {
    const before = holding();
    expect(unitCost(before), "the tax applied before the hold").toBe(3);

    const after = answerDecisions(resolveHeldTriggers(runBeginning(before)));
    expect(unitCost(after), "holding did not tax your units").toBe(4);
  });

  it("does NOT tax a SPELL or a GEAR — 'your units'", () => {
    const after = answerDecisions(resolveHeldTriggers(runBeginning(holding())));
    expect(modifiedEnergyCost(after, 0, "Spell", 3), "a spell was taxed").toBe(3);
    expect(modifiedEnergyCost(after, 0, "Gear", 3), "a gear was taxed").toBe(3);
  });

  it("does NOT tax the OPPONENT — 'YOUR non-token units'", () => {
    const after = answerDecisions(resolveHeldTriggers(runBeginning(holding())));
    expect(modifiedEnergyCost(after, 1, "Unit", 3), "the opponent was taxed").toBe(3);
  });

  it("does NOT tax a TOKEN unit", () => {
    // Belt-and-braces: a token is PLACED, never played, so nothing with such a
    // defId reaches the pricer today — but the card draws the distinction and a
    // later "play a token from hand" effect must not inherit the tax.
    const after = answerDecisions(resolveHeldTriggers(runBeginning(holding())));
    expect(modifiedEnergyCost(after, 0, "Unit", 3, "TOKEN-RECRUIT"), "a token was taxed").toBe(3);
  });

  it("expires at end of turn — 'this turn'", () => {
    const after = answerDecisions(resolveHeldTriggers(runBeginning(holding())));
    expect(unitCost(after), "setup failed — nothing to expire").toBe(4);
    // `runEnd` runs FROM the Action phase — it is the step that ends the turn,
    // not a step inside an "Ending" one.
    expect(unitCost(runEnd({ ...after, phase: "Action" })), "the tax outlived its turn").toBe(3);
  });

  it("STACKS, so two Vaults held in one turn tax twice", () => {
    // A number rather than a flag: each player brings their own three
    // battlefields, so a mirror puts two Vaults on the table and both are held in
    // the same Beginning Phase. A boolean would silently cap the tax at one.
    //
    // **Held through the REAL path, both of them.** The first version of this
    // test hand-wrote the second increment onto the state, which exercised the
    // pricer and not the ARMING — a mutant that assigned instead of adding
    // survived it untouched.
    const state = holding();
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      defId: VAULTS_OF_HELIA,
      units: { p1: [makeUnit({ instanceId: "g2", name: "Garrison 2" })] },
      controllerId: "p1",
    };

    const after = answerDecisions(resolveHeldTriggers(runBeginning(state)));
    expect(after.players[0]!.nonTokenUnitSurchargeThisTurn, "both holds did not arm the tax").toBe(2);
    expect(unitCost(after), "the second hold did not stack").toBe(5);
  });
});
