import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { addBuff, readyUnit } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { CardInstance, GearInstance, UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  pickCard,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * The Spiritforged (SFD) cards filed in engine/effects/calm.ts.
 *
 * Every test here drives a REAL path — `submit` for a play or a move,
 * `runBeginning` for a hold, `addBuff`/`readyUnit` for the two event listeners —
 * and asserts the effect landed on state. A resolver called directly would pass
 * whether or not the dispatch hop that reaches it in a game carries the fields
 * it needs, which is the failure this repo keeps rediscovering; so the choice of
 * driver here is the point of the file rather than incidental.
 *
 * Each `describe` also carries at least one NEGATIVE control — a board where the
 * card must NOT fire — because a trigger that fires for everyone is
 * indistinguishable from a correct one on a one-sided fixture.
 */

const registry = defaultCardRegistry();

const DISARMING_RAKE = "SFD-032";
const GUARDIAN_OF_THE_PASSAGE = "SFD-035";
const RIBBON_DANCER = "SFD-038";
const ROYAL_ENTOURAGE = "SFD-039";
const APPRENTICE_SMITH = "SFD-041";
const EMPERORS_DIVIDE = "SFD-043";
const SIMIAN_ANCESTOR = "SFD-047";
const STELLACORN_HERDER = "SFD-048";
const JANNA_SAVIOR = "SFD-053";
const IRELIA_FERVENT = "SFD-057";
const ORNN_BLACKSMITH = "SFD-058";

/** A gear with nothing but an activated ability, so a test that kills it or
 *  draws it is not also measuring some other card's trigger. */
const ORB_OF_REGRET = "OGN-090";

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n: number) => Array.from({ length: n }, (_, i) => rune(`r${i}`));

function gearInstance(defId = ORB_OF_REGRET): GearInstance {
  return createCardInstance(registry.get(defId)) as GearInstance;
}

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Plays `defId` from player 0's hand through the enumerator and `submit`, then
 *  settles the Pending Item its on-play trigger became. */
function playUnit(state: GameState, defId: string, destinationBattlefieldId?: string): GameState {
  const action = legalActions(state).find(
    (a) =>
      a.type === "PlayCard" &&
      a.card.defId === defId &&
      (a as PlayCardAction).destinationBattlefieldId === destinationBattlefieldId,
  );
  expect(action, `${defId} was never enumerated as playable to ${destinationBattlefieldId ?? "base"}`).toBeDefined();
  return resolveHeldTriggers(accept(state, action!));
}

/** Moves `unitInstanceId` from base to `battlefieldId` through the real action,
 *  then settles what the move held. */
function moveToBattlefield(state: GameState, unitInstanceId: string, battlefieldId = "bf1"): GameState {
  const action = legalActions(state).find(
    (a) =>
      a.type === "MoveUnit" &&
      (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === battlefieldId &&
      ((a as { unitInstanceIds?: string[] }).unitInstanceIds ?? []).includes(unitInstanceId),
  );
  expect(action, `a move of ${unitInstanceId} to ${battlefieldId} was never enumerated`).toBeDefined();
  return resolveHeldTriggers(accept(state, action!));
}

/** Two PassFocus actions resolve the top of a closed chain (a Spell). */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

/** Player 0 in their Beginning Phase holding bf1 with `units` — what fires
 *  `battlefieldHeld` (471.1.a: control maintained, not yet scored this turn). */
function holdingBf1(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { p1: units };
  state.battlefields[0]!.controllerId = "p1";
  return state;
}

const unitAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

const names = (cards: readonly CardInstance[]) => cards.map((c) => c.name);

describe("Emperor's Divide (SFD-043): move any number of friendly units at a battlefield to their base", () => {
  function divideState(): { state: GameState; a: UnitInstance; b: UnitInstance } {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(EMPERORS_DIVIDE)];
    state.players[0]!.channeled = runes(6);
    const a = makeUnit({ instanceId: "a", name: "A" });
    const b = makeUnit({ instanceId: "b", name: "B" });
    state.battlefields[0]!.units = { p1: [a, b] };
    return { state, a, b };
  }

  /** A play built by hand, the shape a human clicking targets produces. */
  function divide(state: GameState, ids: string[]): PlayCardAction {
    const template = legalActions(state).find(
      (act): act is PlayCardAction => act.type === "PlayCard" && act.card.defId === EMPERORS_DIVIDE,
    );
    expect(template, "the Divide was not castable at all").toBeDefined();
    return { ...template!, targetUnitInstanceIds: ids };
  }

  it("sends every chosen unit home, exhausted (454: a move, not a recall)", () => {
    const { state } = divideState();
    const resolved = resolveChain(accept(state, divide(state, ["a", "b"])));

    expect(resolved.battlefields[0]!.units["p1"] ?? [], "they never left the battlefield").toHaveLength(0);
    expect(names(resolved.players[0]!.baseUnits).sort()).toEqual(["A", "B"]);
    expect(
      resolved.players[0]!.baseUnits.every((u) => u.exhausted),
      "a MOVE to base exhausts (415.1.b) — relocateToBaseUnchanged was used instead",
    ).toBe(true);
  });

  it("moves only what was chosen — 'any number' is a real subset", () => {
    const { state } = divideState();
    const resolved = resolveChain(accept(state, divide(state, ["a"])));

    expect(names(resolved.players[0]!.baseUnits)).toEqual(["A"]);
    expect(names((resolved.battlefields[0]!.units["p1"] ?? []) as CardInstance[])).toEqual(["B"]);
  });

  it("is castable with NO targets, and then moves nothing", () => {
    const { state } = divideState();
    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === EMPERORS_DIVIDE,
    );
    expect(offered.some((a) => (a.targetUnitInstanceIds ?? []).length === 0), "min 0 was not offered").toBe(true);

    const resolved = resolveChain(accept(state, divide(state, [])));
    expect(resolved.players[0]!.baseUnits, "the empty choice still moved somebody").toHaveLength(0);
  });

  it("does NOT offer the ENEMY's units, nor one already in base", () => {
    // The negative control for both halves of "friendly units AT A BATTLEFIELD".
    const { state } = divideState();
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [makeUnit({ instanceId: "e", name: "Enemy" })] };
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];

    const chosen = new Set(
      legalActions(state)
        .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === EMPERORS_DIVIDE)
        .flatMap((a) => a.targetUnitInstanceIds ?? []),
    );
    expect(chosen.has("e"), "an enemy unit was offered").toBe(false);
    expect(chosen.has("home"), "a unit already in base was offered").toBe(false);
    expect(chosen.has("a"), "nothing was offered at all — the spec is not wired up").toBe(true);
  });
});

describe("Disarming Rake (SFD-032): when you play me, you may kill a gear", () => {
  function rakeState(gear: GearInstance[] = [gearInstance()], gearOwner: 0 | 1 = 1): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(DISARMING_RAKE)];
    state.players[0]!.channeled = runes(8);
    state.players[gearOwner]!.activeGear = gear;
    return state;
  }

  it("kills the chosen enemy gear, through the real play", () => {
    const gear = gearInstance();
    const played = playUnit(rakeState([gear]), DISARMING_RAKE);

    const decision = pendingDecision(played);
    expect(decision, "the Rake asked nothing").toBeDefined();
    const answered = answerDecisions(played, pickCard(gear.instanceId));

    expect(answered.players[1]!.activeGear, "the gear survived").toHaveLength(0);
    expect(names(answered.players[1]!.trash)).toContain(gear.name);
  });

  it("offers YOUR OWN gear too — the card names no owner", () => {
    const mine = gearInstance();
    const played = playUnit(rakeState([mine], 0), DISARMING_RAKE);

    const decision = pendingDecision(played)!;
    expect(optionsFor(played, decision).map((o) => o.instanceId)).toContain(mine.instanceId);
  });

  it("DECLINING leads, and leaves the gear alone", () => {
    const gear = gearInstance();
    const played = playUnit(rakeState([gear]), DISARMING_RAKE);

    const decision = pendingDecision(played)!;
    expect(optionsFor(played, decision)[0]!.id, "decline must lead so a mis-click does nothing").toBe("decline");
    expect(answerDecisions(played).players[1]!.activeGear, "declining killed it anyway").toHaveLength(1);
  });

  it("asks NOTHING with no gear anywhere (422)", () => {
    const played = playUnit(rakeState([]), DISARMING_RAKE);
    expect(played.pendingDecisions, "a question with no answers was parked").toHaveLength(0);
  });
});

describe("Royal Entourage (SFD-039): when you play me, ready or exhaust a legend", () => {
  function entourageState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(ROYAL_ENTOURAGE)];
    state.players[0]!.channeled = runes(8);
    return state;
  }

  it("EXHAUSTS the opponent's legend when that is the answer", () => {
    const played = playUnit(entourageState(), ROYAL_ENTOURAGE);
    const decision = pendingDecision(played);
    expect(decision, "the Entourage asked nothing").toBeDefined();

    const answered = answerDecisions(played, (options) => options.find((o) => o.id.startsWith("1-"))!.id);
    expect(answered.players[1]!.legend.exhausted, "the enemy legend is untouched").toBe(true);
    expect(answered.players[0]!.legend.exhausted, "the wrong legend moved").toBe(false);
  });

  it("READIES a spent legend — the other half of the same question", () => {
    const state = entourageState();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };

    const played = playUnit(state, ROYAL_ENTOURAGE);
    const answered = answerDecisions(played, (options) => options.find((o) => o.id === "0-ready")!.id);
    expect(answered.players[0]!.legend.exhausted, "the legend was never readied").toBe(false);
  });

  it("offers exactly one verb per legend, so it is always a real question", () => {
    // Two options is what stops `advanceDecisions` answering a genuine choice on
    // the player's behalf; one per legend is what makes the offer meaningful.
    const state = entourageState();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };

    const played = playUnit(state, ROYAL_ENTOURAGE);
    const ids = optionsFor(played, pendingDecision(played)!).map((o) => o.id);
    expect(ids).toEqual(["0-ready", "1-exhaust"]);
  });
});

describe("Janna - Savior (SFD-053): heal your units here, then move up to one enemy home", () => {
  /** Janna's on-play trigger through the real dispatcher, with a damaged unit of
   *  each side at bf1 and a damaged friendly at HOME that must not be healed. */
  function jannaState(): { state: GameState; janna: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const janna = realUnitInstance(JANNA_SAVIOR);
    const friendHere = makeUnit({ instanceId: "friend", name: "Friend", damage: 3, might: 9 });
    const friendHome = makeUnit({ instanceId: "home", name: "Home", damage: 2, might: 9 });
    const enemyHere = makeUnit({ instanceId: "enemy", name: "Enemy", damage: 1, might: 9 });
    state.battlefields[0]!.units = { p1: [friendHere, janna], p2: [enemyHere] };
    state.players[0]!.baseUnits = [friendHome];
    return { state, janna };
  }

  it("heals only YOUR units at HER battlefield", () => {
    const { state, janna } = jannaState();
    const played = playUnitTrigger(state, janna, 0, { battlefieldId: "bf1" });

    expect(unitAnywhere(played, "friend")!.damage, "the friendly here was not healed").toBe(0);
    expect(unitAnywhere(played, "enemy")!.damage, "healAllUnits was used — the enemy healed too").toBe(1);
    expect(unitAnywhere(played, "home")!.damage, "'here' reached a unit in base").toBe(2);
  });

  it("moves the chosen enemy home, exhausted", () => {
    const { state, janna } = jannaState();
    const played = playUnitTrigger(state, janna, 0, { battlefieldId: "bf1" });
    expect(pendingDecision(played), "no move was offered").toBeDefined();

    const answered = answerDecisions(played, pickCard("enemy"));
    expect(answered.battlefields[0]!.units["p2"] ?? [], "the enemy is still contesting").toHaveLength(0);
    expect(answered.players[1]!.baseUnits.map((u) => u.instanceId)).toEqual(["enemy"]);
    expect(answered.players[1]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("'UP TO ONE' — declining leads and moves nobody", () => {
    const { state, janna } = jannaState();
    const played = playUnitTrigger(state, janna, 0, { battlefieldId: "bf1" });

    expect(optionsFor(played, pendingDecision(played)!)[0]!.id).toBe("decline");
    expect(answerDecisions(played).battlefields[0]!.units["p2"] ?? []).toHaveLength(1);
  });

  it("played to BASE, heals base and asks nothing", () => {
    const { state, janna } = jannaState();
    const played = playUnitTrigger(state, janna, 0, "base");

    expect(unitAnywhere(played, "home")!.damage, "base is 'here' for a unit played to base").toBe(0);
    expect(unitAnywhere(played, "friend")!.damage, "a battlefield was healed from base").toBe(3);
    expect(played.pendingDecisions, "no enemy can stand in your base — nothing to ask").toHaveLength(0);
  });
});

describe("Ornn - Blacksmith (SFD-058): look at the top 4, you may draw a gear, recycle the rest", () => {
  /** Top 4 = Unit, Gear, Unit, Unit, with a fifth card underneath so the deck
   *  order after the recycle is observable. */
  function ornnDeck(): CardInstance[] {
    return [
      makeUnit({ name: "T1" }),
      gearInstance(),
      makeUnit({ name: "T3" }),
      makeUnit({ name: "T4" }),
      makeUnit({ name: "T5" }),
    ];
  }

  it("draws the chosen gear and recycles the other three (on PLAY)", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(ORNN_BLACKSMITH)];
    state.players[0]!.channeled = runes(8);
    state.players[0]!.deck = ornnDeck();
    const gearName = state.players[0]!.deck[1]!.name;

    const played = playUnit(state, ORNN_BLACKSMITH);
    const answered = answerDecisions(played, (options) => options.find((o) => o.label === gearName)!.id);

    expect(names(answered.players[0]!.hand), "the gear never reached hand").toEqual([gearName]);
    expect(names(answered.players[0]!.deck), "the other three were not recycled to the bottom").toEqual([
      "T5",
      "T1",
      "T3",
      "T4",
    ]);
  });

  it("recycles all four when declined — 'then recycle the rest' is not conditional", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(ORNN_BLACKSMITH)];
    state.players[0]!.channeled = runes(8);
    state.players[0]!.deck = ornnDeck();

    const answered = answerDecisions(playUnit(state, ORNN_BLACKSMITH), (options) => options[0]!.id);
    expect(answered.players[0]!.hand, "declining still drew something").toHaveLength(0);
    expect(names(answered.players[0]!.deck)[0], "nothing was recycled").toBe("T5");
    expect(answered.players[0]!.deck).toHaveLength(5);
  });

  it("offers only GEAR from among the four", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(ORNN_BLACKSMITH)];
    state.players[0]!.channeled = runes(8);
    state.players[0]!.deck = ornnDeck();

    const played = playUnit(state, ORNN_BLACKSMITH);
    const labels = optionsFor(played, pendingDecision(played)!).map((o) => o.label);
    expect(labels, "a unit was offered as a 'gear'").not.toContain("T1");
    expect(labels).toHaveLength(2); // decline + the one gear
  });

  it("fires again WHEN HE HOLDS — the same ability, the second trigger", () => {
    const ornn = realUnitInstance(ORNN_BLACKSMITH);
    const state = holdingBf1([ornn]);
    state.players[0]!.deck = ornnDeck();
    const gearName = state.players[0]!.deck[1]!.name;

    const held = resolveHeldTriggers(runBeginning(state));
    expect(pendingDecision(held), "the hold trigger never fired").toBeDefined();

    const answered = answerDecisions(held, (options) => options.find((o) => o.label === gearName)!.id);
    expect(names(answered.players[0]!.hand)).toEqual([gearName]);
  });

  it("does NOT fire for a hold at a battlefield he is not standing at", () => {
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.battlefields[1]!.units = { p1: [realUnitInstance(ORNN_BLACKSMITH)] };
    state.battlefields[1]!.controllerId = "p1";
    state.players[0]!.deck = ornnDeck();

    // bf2 is held too, so he DOES fire once — for his own battlefield only.
    const held = resolveHeldTriggers(runBeginning(state));
    expect(held.pendingDecisions, "one hold, one look — he fired for bf1 as well").toHaveLength(1);
  });
});

describe("Guardian of the Passage (SFD-035): when I hold, return a unit or gear from your trash", () => {
  function guardianState(): { state: GameState; unit: UnitInstance; gear: GearInstance; spell: CardInstance } {
    const guardian = realUnitInstance(GUARDIAN_OF_THE_PASSAGE);
    const state = holdingBf1([guardian]);
    const unit = makeUnit({ name: "Dead Unit" });
    const gear = gearInstance();
    const spell = spellInstance(EMPERORS_DIVIDE);
    state.players[0]!.trash = [unit, spell, gear];
    return { state, unit, gear, spell };
  }

  it("returns the chosen gear to hand", () => {
    const { state, gear } = guardianState();
    const held = resolveHeldTriggers(runBeginning(state));
    expect(pendingDecision(held), "the hold trigger never fired").toBeDefined();

    const answered = answerDecisions(held, pickCard(gear.instanceId));
    expect(names(answered.players[0]!.hand)).toEqual([gear.name]);
    expect(answered.players[0]!.trash.map((c) => c.instanceId)).not.toContain(gear.instanceId);
  });

  it("does NOT offer a SPELL — the card names two kinds and stops", () => {
    const { state, spell, unit, gear } = guardianState();
    const held = resolveHeldTriggers(runBeginning(state));

    const offered = optionsFor(held, pendingDecision(held)!).map((o) => o.instanceId);
    expect(offered, "a spell was offered").not.toContain(spell.instanceId);
    expect(offered).toContain(unit.instanceId);
    expect(offered).toContain(gear.instanceId);
  });

  it("asks nothing with a trash holding only spells (422)", () => {
    const guardian = realUnitInstance(GUARDIAN_OF_THE_PASSAGE);
    const state = holdingBf1([guardian]);
    state.players[0]!.trash = [spellInstance(EMPERORS_DIVIDE)];

    expect(resolveHeldTriggers(runBeginning(state)).pendingDecisions).toHaveLength(0);
  });
});

describe("Ribbon Dancer (SFD-038): when I move to a battlefield, +1 Might to ANOTHER friendly", () => {
  function dancerState(): { state: GameState; dancer: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const dancer = realUnitInstance(RIBBON_DANCER);
    state.players[0]!.baseUnits = [
      dancer,
      makeUnit({ instanceId: "ally1", name: "Ally One" }),
      makeUnit({ instanceId: "ally2", name: "Ally Two" }),
    ];
    return { state, dancer };
  }

  it("gives the chosen ally +1 Might this turn, on a real MoveUnit", () => {
    const { state, dancer } = dancerState();
    const moved = moveToBattlefield(state, dancer.instanceId);
    expect(pendingDecision(moved), "the move trigger never fired").toBeDefined();

    const answered = answerDecisions(moved, pickCard("ally2"));
    expect(unitAnywhere(answered, "ally2")!.mightThisTurn, "the Might never landed").toBe(1);
    expect(unitAnywhere(answered, "ally1")!.mightThisTurn).toBe(0);
  });

  it("never offers HERSELF — 'ANOTHER friendly unit'", () => {
    const { state, dancer } = dancerState();
    const moved = moveToBattlefield(state, dancer.instanceId);

    const offered = optionsFor(moved, pendingDecision(moved)!).map((o) => o.instanceId);
    expect(offered, "the Dancer offered to buff herself").not.toContain(dancer.instanceId);
    expect(offered.sort()).toEqual(["ally1", "ally2"]);
  });

  it("does NOT fire when SOMEBODY ELSE moves", () => {
    const { state, dancer } = dancerState();
    const moved = moveToBattlefield(state, "ally1");

    expect(moved.pendingDecisions, "she fired for another unit's move").toHaveLength(0);
    expect(unitAnywhere(moved, dancer.instanceId)!.mightThisTurn).toBe(0);
  });

  it("asks nothing when she is her controller's only unit", () => {
    const state = makeState({ phase: "Action" });
    const dancer = realUnitInstance(RIBBON_DANCER);
    state.players[0]!.baseUnits = [dancer];

    expect(moveToBattlefield(state, dancer.instanceId).pendingDecisions).toHaveLength(0);
  });
});

describe("Apprentice Smith (SFD-041): when I move, reveal the top card", () => {
  function smithState(top: CardInstance): { state: GameState; smith: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const smith = realUnitInstance(APPRENTICE_SMITH);
    state.players[0]!.baseUnits = [smith];
    state.players[0]!.deck = [top, makeUnit({ name: "Under" })];
    return { state, smith };
  }

  it("DRAWS the top card when it is a gear", () => {
    const gear = gearInstance();
    const { state, smith } = smithState(gear);
    const moved = moveToBattlefield(state, smith.instanceId);

    expect(names(moved.players[0]!.hand), "the gear was not drawn").toEqual([gear.name]);
    expect(names(moved.players[0]!.deck)).toEqual(["Under"]);
  });

  it("RECYCLES it to the bottom otherwise", () => {
    const { state, smith } = smithState(makeUnit({ name: "Not Gear" }));
    const moved = moveToBattlefield(state, smith.instanceId);

    expect(moved.players[0]!.hand, "a non-gear was drawn").toHaveLength(0);
    expect(names(moved.players[0]!.deck), "it was not sent to the bottom").toEqual(["Under", "Not Gear"]);
  });

  it("does nothing at all on an empty deck — no Burn Out", () => {
    const state = makeState({ phase: "Action" });
    const smith = realUnitInstance(APPRENTICE_SMITH);
    state.players[0]!.baseUnits = [smith];

    const moved = moveToBattlefield(state, smith.instanceId);
    expect(moved.players[1]!.points, "an empty deck burned out on a reveal").toBe(0);
  });
});

describe("Stellacorn Herder (SFD-048): when I move, draw 1", () => {
  it("draws on a real move", () => {
    const state = makeState({ phase: "Action" });
    const herder = realUnitInstance(STELLACORN_HERDER);
    state.players[0]!.baseUnits = [herder, makeUnit({ instanceId: "other", name: "Other" })];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];

    expect(names(moveToBattlefield(state, herder.instanceId).players[0]!.hand)).toEqual(["Drawn"]);
  });

  it("does NOT draw when a different unit moves", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [realUnitInstance(STELLACORN_HERDER), makeUnit({ instanceId: "other", name: "Other" })];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];

    expect(moveToBattlefield(state, "other").players[0]!.hand, "he drew off someone else's move").toHaveLength(0);
  });
});

describe("Simian Ancestor (SFD-047): when you buff me, ready me", () => {
  function ancestorState(): { state: GameState; ancestor: UnitInstance } {
    const ancestor = { ...realUnitInstance(SIMIAN_ANCESTOR), exhausted: true };
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [ancestor, { ...makeUnit({ instanceId: "other", name: "Other" }), exhausted: true }] };
    return { state, ancestor };
  }

  it("readies him when the buff lands on HIM", () => {
    const { state, ancestor } = ancestorState();
    const settled = resolveHeldTriggers(addBuff(state, ancestor.instanceId));

    expect(unitAnywhere(settled, ancestor.instanceId)!.exhausted, "he was never readied").toBe(false);
  });

  it("does NOT ready him when another unit is buffed", () => {
    const { state, ancestor } = ancestorState();
    const settled = resolveHeldTriggers(addBuff(state, "other"));

    expect(unitAnywhere(settled, ancestor.instanceId)!.exhausted, "he readied off someone else's buff").toBe(true);
  });

  it("does not fire a SECOND time for a re-buff (708 makes it a no-op)", () => {
    const { state, ancestor } = ancestorState();
    const once = resolveHeldTriggers(addBuff(state, ancestor.instanceId));
    // Exhaust him again and re-buff: 708 says nothing happens, so no ready.
    const reExhausted = {
      ...once,
      battlefields: once.battlefields.map((bf, i) =>
        i === 0
          ? { ...bf, units: { ...bf.units, p1: (bf.units["p1"] ?? []).map((u) => ({ ...u, exhausted: true })) } }
          : bf,
      ),
    };
    const twice = resolveHeldTriggers(addBuff(reExhausted, ancestor.instanceId));

    expect(unitAnywhere(twice, ancestor.instanceId)!.exhausted, "a second buff readied him again").toBe(true);
  });
});

describe("Irelia - Fervent (SFD-057): when you READY me, +1 Might this turn", () => {
  // Only the READY half of "when you choose or ready me" is implemented — see her
  // entry in effects/calm.ts. There is no "choose" test here because there is no
  // choose half, which is deliberate: a test asserting the missing behaviour
  // would have to be written against a mechanism that does not exist.
  function ireliaState(): { state: GameState; irelia: UnitInstance } {
    const irelia = { ...realUnitInstance(IRELIA_FERVENT), exhausted: true };
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [irelia, { ...makeUnit({ instanceId: "other", name: "Other" }), exhausted: true }];
    return { state, irelia };
  }

  it("pumps herself when she is readied", () => {
    const { state, irelia } = ireliaState();
    const settled = resolveHeldTriggers(readyUnit(state, irelia.instanceId));

    expect(unitAnywhere(settled, irelia.instanceId)!.mightThisTurn, "the Might never landed").toBe(1);
    expect(unitAnywhere(settled, irelia.instanceId)!.exhausted).toBe(false);
  });

  it("does NOT pump when another unit is readied", () => {
    const { state, irelia } = ireliaState();
    const settled = resolveHeldTriggers(readyUnit(state, "other"));

    expect(unitAnywhere(settled, irelia.instanceId)!.mightThisTurn, "she grew off someone else's ready").toBe(0);
  });

  it("does NOT pump for a ready that never happened (415)", () => {
    const { state, irelia } = ireliaState();
    const alreadyReady: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, baseUnits: state.players[0]!.baseUnits.map((u) => ({ ...u, exhausted: false })) },
        state.players[1]!,
      ],
    };
    const settled = resolveHeldTriggers(readyUnit(alreadyReady, irelia.instanceId));

    expect(unitAnywhere(settled, irelia.instanceId)!.mightThisTurn).toBe(0);
  });
});
