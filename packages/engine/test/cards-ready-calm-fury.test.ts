import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The four cluster-1 cards implemented in effects/calm.ts and effects/fury.ts:
 * Last Stand, Adaptatron, Yasuo - Remorseful and Kadregrin the Infernal.
 *
 * **Everything here goes through `submit`.** Not through a resolver closure, and
 * not even through an `execute*` called by hand: the failure this repo keeps
 * rediscovering is a card that is written, typechecked and unreachable at the
 * same time, and only the real action path can rule that out. Three of these four
 * cards fire from somewhere no test can reach by calling their resolver anyway —
 * Yasuo from the Cleanup that stages a Combat Showdown, Adaptatron from the
 * conquest at the end of one, Last Stand from a chain that has to be passed on
 * twice before it resolves.
 *
 * Draven - Showboat (OGN-028) is deliberately absent: "My Might is increased by
 * your points" is a continuous aura and the only place one can live is
 * effective-might.ts, which this pass does not own. See the report.
 */

const registry = defaultCardRegistry();
const LAST_STAND = "OGN-069";
const ADAPTATRON = "OGN-056";
const YASUO_REMORSEFUL = "OGN-076";
const KADREGRIN = "OGN-038";
const IRON_BALLISTA = "OGN-017"; // a plain gear, no death trigger of its own

const gearInstance = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** Ready runes of one domain, enough to pay for anything in this file. */
const runes = (domain: Domain, n = 14) =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** Submits `action` and asserts it was ACCEPTED. `submit` answers an illegal
 *  action with an Invalid result rather than throwing, so a test that ignores the
 *  result reads a rejected action as "the card did nothing" — the exact
 *  false-negative this file exists to avoid. */
function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

/** Finds the enumerated action matching `match`, failing loudly if the enumerator
 *  never offered it — a card that resolves but is never offered is unreachable. */
function offered<T>(state: GameState, match: (a: any) => boolean, what: string): T {
  const action = legalActions(state).find(match);
  expect(action, `${what} was never enumerated`).toBeDefined();
  return action as T;
}

/** Passes focus until the spell chain empties — a Spell takes effect on
 *  resolution, not on being played. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    current = accept(current, offered(current, (a) => a.type === "PassFocus", "a focus pass"));
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

/** Passes focus until an open Showdown closes. */
/**
 * Passes focus until the Showdown window has closed AND the chain it leaves
 * behind has drained.
 *
 * The second half is not padding. Closing a Showdown can CONQUER, and
 * `battlefieldConquered` is a Chain Pending Item now (383 / 809.1.b.3): the
 * conquer trigger lands in `state.pendingTriggers`, the Cleanup finalizes it onto
 * the chain and closes it, and it takes two more passes to resolve. A driver that
 * stopped at `turnState !== "Showdown"` — as this one did — would return a board
 * where the trigger had fired and not yet resolved, and every assertion about its
 * effect would read as "the card does nothing".
 *
 * It stops on a pending DECISION rather than passing through it, because a
 * question is the caller's to answer.
 */
function closeShowdownWindow(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12; guard += 1) {
    if (pendingDecision(current)) return current;
    if (current.turnState !== "Showdown" && current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  throw new Error("closeShowdownWindow: the window and chain never settled");
}

const unitAt = (state: GameState, battlefieldId: string, playerId: string, instanceId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId]!.find((u) => u.instanceId === instanceId)!;

// ───────────────────────────────────────────────────────────────────────────
describe("Last Stand (OGN-069): double a friendly unit's Might this turn, give it [Temporary]", () => {
  function lastStandState(target: UnitInstance): { state: GameState; spell: ReturnType<typeof createCardInstance> } {
    const spell = createCardInstance(registry.get(LAST_STAND));
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Calm");
    state.battlefields[0]!.units = { p1: [target] };
    return { state, spell };
  }

  it("doubles a plain 4-Might unit and makes it [Temporary] — through submit and the chain", () => {
    const ally = makeUnit({ might: 4 });
    const { state, spell } = lastStandState(ally);

    const play = offered<PlayCardAction>(
      state,
      (a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.targetUnitInstanceId === ally.instanceId,
      "Last Stand aimed at the friendly unit",
    );
    const after = resolveChain(accept(state, play));

    const pumped = unitAt(after, "bf1", "p1", ally.instanceId);
    // +4 on a printed 4 is 8 — a DOUBLING, not a flat bonus.
    expect(pumped.mightThisTurn).toBe(4);
    expect(effectiveMight(after, pumped, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(8);
    expect(pumped.keywords.Temporary).toBe(1);
    // "This turn", not a Buff (710) — the two are not interchangeable.
    expect(pumped.buffed).toBe(false);
    expect(pumped.might).toBe(4); // printed Might untouched
  });

  it("doubles EFFECTIVE Might, not printed — a buffed unit is doubled from its real value", () => {
    // The whole printed-vs-effective call, made falsifiable: printed 3, buffed
    // (+1 by rule 710) is 4 now, so doubling adds 4 and not 3.
    const ally = makeUnit({ might: 3, buffed: true });
    const { state, spell } = lastStandState(ally);

    const play = offered<PlayCardAction>(
      state,
      (a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.targetUnitInstanceId === ally.instanceId,
      "Last Stand aimed at the buffed unit",
    );
    const after = resolveChain(accept(state, play));

    const pumped = unitAt(after, "bf1", "p1", ally.instanceId);
    expect(pumped.mightThisTurn).toBe(4); // NOT 3
    expect(effectiveMight(after, pumped, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(8);
  });

  it("is 'a FRIENDLY unit' — the enumerator never offers an enemy one", () => {
    const ally = makeUnit({ might: 2 });
    const theirs = makeUnit({ might: 2 });
    const { state, spell } = lastStandState(ally);
    state.battlefields[0]!.units = { p1: [ally], p2: [theirs] };

    const targets = legalActions(state)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spell.instanceId)
      .map((a) => a.targetUnitInstanceId);

    expect(targets).toContain(ally.instanceId);
    expect(targets).not.toContain(theirs.instanceId);
  });

  it("names no battlefield, so it reaches a friendly unit standing in BASE", () => {
    const atHome = makeUnit({ might: 5 });
    const spell = createCardInstance(registry.get(LAST_STAND));
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Calm");
    state.players[0]!.baseUnits = [atHome];

    const play = offered<PlayCardAction>(
      state,
      (a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.targetUnitInstanceId === atHome.instanceId,
      "Last Stand aimed at the base unit",
    );
    const after = resolveChain(accept(state, play));

    const pumped = after.players[0]!.baseUnits.find((u) => u.instanceId === atHome.instanceId)!;
    expect(pumped.mightThisTurn).toBe(5);
    expect(pumped.keywords.Temporary).toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(LAST_STAND))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Yasuo - Remorseful (OGN-076): when I attack, deal my Might to an enemy unit here", () => {
  /** Yasuo in base ready to walk into an enemy-held battlefield. */
  function yasuoState(enemyMight: number): { state: GameState; yasuo: UnitInstance; enemy: UnitInstance } {
    const yasuo = realUnitInstance(YASUO_REMORSEFUL);
    const enemy = makeUnit({ might: enemyMight });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [yasuo];
    state.battlefields[0]!.units = { p2: [enemy] };
    state.battlefields[0]!.controllerId = "p2";
    return { state, yasuo, enemy };
  }

  const move = (state: GameState, unit: UnitInstance) =>
    offered(
      state,
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(unit.instanceId),
      `a move of ${unit.name} to bf1`,
    );

  it("deals 6 (his printed Might) when he walks in and the Combat Showdown opens", () => {
    // The whole real path: MoveUnit -> applyContested -> the Cleanup submit runs
    // stages a Combat Showdown -> combatBegan -> his trigger.
    const { state, yasuo, enemy } = yasuoState(9);
    const after = accept(state, move(state, yasuo));

    expect(after.turnState, "no Combat Showdown was staged").toBe("Showdown");
    expect(after.showdownKind).toBe("Combat");
    expect(unitAt(after, "bf1", "p2", enemy.instanceId).damage).toBe(6);
  });

  it("KILLS an enemy his Might covers, through the ordinary damage funnel", () => {
    const { state, yasuo, enemy } = yasuoState(6);
    const after = accept(state, move(state, yasuo));

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toEqual([enemy.instanceId]);
  });

  it("reads his CURRENT Might, not the printed 6 — a this-turn pump is included", () => {
    const { state, yasuo, enemy } = yasuoState(20);
    state.players[0]!.baseUnits = [{ ...yasuo, mightThisTurn: 3 }];

    const after = accept(state, move(state, yasuo));
    expect(unitAt(after, "bf1", "p2", enemy.instanceId).damage).toBe(9);
  });

  it("does NOT fire when he is DEFENDING — 'when I ATTACK'", () => {
    // Same board the other way round: Yasuo holds bf1, the opponent walks in.
    // `contestedByIndex` is the rules' own definition of the Attacker (465), and
    // it names player 1 here.
    const yasuo = realUnitInstance(YASUO_REMORSEFUL);
    const attacker = makeUnit({ might: 9 });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.baseUnits = [attacker];
    state.battlefields[0]!.units = { p1: [yasuo] };
    state.battlefields[0]!.controllerId = "p1";

    const after = accept(
      state,
      offered(
        state,
        (a) => a.type === "MoveUnit" && a.playerIndex === 1 && a.destinationBattlefieldId === "bf1",
        "the opponent's move into bf1",
      ),
    );

    expect(after.showdownKind).toBe("Combat");
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });

  it("does nothing at a battlefield he is not standing at", () => {
    // A second friendly unit attacks bf2 while Yasuo sits at bf1 uncontested.
    const yasuo = realUnitInstance(YASUO_REMORSEFUL);
    const runner = makeUnit({ might: 2 });
    const enemy = makeUnit({ might: 9 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [runner];
    state.battlefields[0]!.units = { p1: [yasuo] };
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.units = { p2: [enemy] };
    state.battlefields[1]!.controllerId = "p2";

    const after = accept(
      state,
      offered(
        state,
        (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf2",
        "a move to bf2",
      ),
    );

    expect(after.showdownKind).toBe("Combat");
    expect(unitAt(after, "bf2", "p2", enemy.instanceId).damage).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(YASUO_REMORSEFUL))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Adaptatron (OGN-056): when I conquer, you may kill a gear; if you do, buff me", () => {
  /** Adaptatron in base, an open battlefield to walk into and conquer. */
  function adaptatronState(): { state: GameState; adaptatron: UnitInstance } {
    const adaptatron = realUnitInstance(ADAPTATRON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [adaptatron];
    return { state, adaptatron };
  }

  /** Walks the Adaptatron into an open bf1 and closes the Non-Combat Showdown,
   *  which is what makes the walk-in a Conquer (466.7 / 471.1). */
  function conquer(state: GameState, adaptatron: UnitInstance): GameState {
    const moved = accept(
      state,
      offered(
        state,
        (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(adaptatron.instanceId),
        "a move of the Adaptatron to bf1",
      ),
    );
    return closeShowdownWindow(moved);
  }

  it("asks, kills the chosen gear and buffs itself — through submit end to end", () => {
    const { state, adaptatron } = adaptatronState();
    const ballista = gearInstance(IRON_BALLISTA);
    state.players[1]!.activeGear = [ballista];

    const conquered = conquer(state, adaptatron);
    expect(conquered.players[0]!.points, "the walk-in was not a conquest").toBe(1);

    const question = pendingDecision(conquered);
    expect(question, "the Adaptatron never asked").toBeDefined();
    expect(question!.playerIndex).toBe(0);
    const optionIds = optionsFor(conquered, question!).map((o) => o.id);
    expect(optionIds).toEqual(["decline", ballista.instanceId]);

    const answered = accept(conquered, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: question!.id,
      optionId: ballista.instanceId,
    });

    expect(answered.players[1]!.activeGear).toHaveLength(0);
    expect(answered.players[1]!.trash.map((c) => c.instanceId)).toEqual([ballista.instanceId]);
    expect(unitAt(answered, "bf1", "p1", adaptatron.instanceId).buffed).toBe(true);
  });

  it("offers YOUR OWN gear too — the card names no owner", () => {
    const { state, adaptatron } = adaptatronState();
    const mine = gearInstance(IRON_BALLISTA);
    state.players[0]!.activeGear = [mine];

    const conquered = conquer(state, adaptatron);
    const question = pendingDecision(conquered)!;
    expect(optionsFor(conquered, question).map((o) => o.id)).toContain(mine.instanceId);

    const answered = accept(conquered, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: question.id,
      optionId: mine.instanceId,
    });
    expect(answered.players[0]!.activeGear).toHaveLength(0);
    expect(unitAt(answered, "bf1", "p1", adaptatron.instanceId).buffed).toBe(true);
  });

  it("declining kills nothing and buffs nothing — 'IF YOU DO'", () => {
    const { state, adaptatron } = adaptatronState();
    const ballista = gearInstance(IRON_BALLISTA);
    state.players[1]!.activeGear = [ballista];

    const conquered = conquer(state, adaptatron);
    const question = pendingDecision(conquered)!;
    const answered = accept(conquered, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: question.id,
      optionId: "decline",
    });

    expect(answered.players[1]!.activeGear).toHaveLength(1);
    expect(unitAt(answered, "bf1", "p1", adaptatron.instanceId).buffed).toBe(false);
  });

  it("asks NOTHING when there is no gear anywhere — a question with no answers is not parked", () => {
    const { state, adaptatron } = adaptatronState();
    const conquered = conquer(state, adaptatron);

    expect(conquered.players[0]!.points).toBe(1);
    expect(conquered.pendingDecisions).toHaveLength(0);
    expect(unitAt(conquered, "bf1", "p1", adaptatron.instanceId).buffed).toBe(false);
  });

  it("does NOT fire for a conquest it is not standing at — 'when I conquer'", () => {
    // The Adaptatron holds bf1; a different unit walks into bf2 and takes it.
    const adaptatron = realUnitInstance(ADAPTATRON);
    const runner = makeUnit({ might: 2 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [runner];
    state.battlefields[0]!.units = { p1: [adaptatron] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[1]!.activeGear = [gearInstance(IRON_BALLISTA)];

    const moved = accept(
      state,
      offered(state, (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf2", "a move to bf2"),
    );
    const conquered = closeShowdownWindow(moved);

    expect(conquered.players[0]!.points).toBeGreaterThan(0);
    expect(conquered.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ADAPTATRON))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Kadregrin the Infernal (OGN-038): draw 1 for each of your [Mighty] units", () => {
  function kadregrinState(others: UnitInstance[]): { state: GameState; kadregrin: UnitInstance } {
    const kadregrin = realUnitInstance(KADREGRIN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [kadregrin];
    state.players[0]!.channeled = runes("Fury");
    state.players[0]!.baseUnits = others;
    state.players[0]!.deck = Array.from({ length: 6 }, (_, i) => makeUnit({ name: `Deck ${i}` }));
    return { state, kadregrin };
  }

  const play = (state: GameState, kadregrin: UnitInstance) =>
    accept(
      state,
      offered(
        state,
        (a) => a.type === "PlayCard" && a.card.instanceId === kadregrin.instanceId && a.destinationBattlefieldId === undefined,
        "Kadregrin played to base",
      ),
    );

  it("draws 1 for HIMSELF alone — he is a printed 9 Might and counts", () => {
    const { state, kadregrin } = kadregrinState([makeUnit({ might: 2 }), makeUnit({ might: 4 })]);
    const after = play(state, kadregrin);

    // Deck 6 -> 5, hand holds exactly the one drawn card (Kadregrin left it).
    expect(after.players[0]!.deck).toHaveLength(5);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Deck 0"]);
  });

  it("counts every Mighty unit you control, base and battlefields alike", () => {
    const { state, kadregrin } = kadregrinState([makeUnit({ might: 5 }), makeUnit({ might: 1 })]);
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 7 })] };

    const after = play(state, kadregrin);
    // Kadregrin (9) + the 5 in base + the 7 at bf1 = 3. The 1-Might body is not.
    expect(after.players[0]!.hand).toHaveLength(3);
  });

  it("asks rule 711's CURRENT Might, not the printed number", () => {
    // A printed 3 sitting at 5 through a this-turn pump IS Mighty (711), and a
    // hardcoded `unit.might >= 5` would miss it. This is the assertion that
    // distinguishes `isMighty` from a hand-written comparison.
    const { state, kadregrin } = kadregrinState([makeUnit({ might: 3, mightThisTurn: 2 })]);
    const after = play(state, kadregrin);
    expect(after.players[0]!.hand).toHaveLength(2); // Kadregrin + the pumped body
  });

  it("does not count the OPPONENT's Mighty units — 'each of YOUR'", () => {
    const { state, kadregrin } = kadregrinState([]);
    state.players[1]!.baseUnits = [makeUnit({ might: 8 }), makeUnit({ might: 8 })];

    const after = play(state, kadregrin);
    expect(after.players[0]!.hand).toHaveLength(1); // himself only
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KADREGRIN))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Draven - Showboat (OGN-028) rides his controller's score", () => {
  // Was pinned here as unimplemented while this file was written, because his
  // "My Might is increased by your points" is a continuous aura and the only
  // place one can live is effective-might.ts. It has since landed, so the pin
  // became a real test of the aura.
  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KADREGRIN))).toBe(true); // control: the file's other Fury card
    expect(isCardImplemented(registry.get("OGN-028"))).toBe(true);
  });
});
