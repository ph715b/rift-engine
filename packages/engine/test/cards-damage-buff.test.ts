import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { recordConquest } from "../src/engine/scoring.js";
import { dispatchEvent } from "../src/engine/triggers.js";
import { addBuff, destroyUnit } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance, UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The damage / buff / might batch — cards built on machinery that already
 * existed, plus the four small additions they needed (a keyword VALUE, an
 * exhaust-all helper, a per-domain death-watch registry, and a second target
 * slot on the Unit trigger path).
 */

const registry = defaultCardRegistry();

const CLEAVE = "OGN-004";
const HEXTECH_RAY = "OGN-009";
const THERMO_BEAM = "OGN-022";
const DARIUS_TRIFARIAN = "OGN-027";
const PORO_HERDER = "OGN-061";
const WHITEFLAME = "OGN-082";
const RIPTIDE_REX = "OGN-092";
const AHRI_INQUISITIVE = "OGN-119";
const UNCHECKED_POWER = "OGN-123";
const FLURRY_OF_BLADES = "OGN-133";
const KINKOU_MONK = "OGN-141";
const PRIMAL_STRENGTH = "OGN-154";
const SETT_BRAWLER = "OGN-164";
const PEAK_GUARDIAN = "OGN-223";
const VANGUARD_HELM = "OGN-228";
const VENGEANCE = "OGN-229";
const HARNESSED_DRAGON = "OGN-234";
const VIKTOR_LEADER = "OGN-246";
const SIPHON_POWER = "OGN-266";

const BATCH = [
  CLEAVE, HEXTECH_RAY, THERMO_BEAM, DARIUS_TRIFARIAN, PORO_HERDER, WHITEFLAME, RIPTIDE_REX,
  AHRI_INQUISITIVE, UNCHECKED_POWER, FLURRY_OF_BLADES, KINKOU_MONK, PRIMAL_STRENGTH, SETT_BRAWLER,
  PEAK_GUARDIAN, VANGUARD_HELM, VENGEANCE, HARNESSED_DRAGON, VIKTOR_LEADER, SIPHON_POWER,
];

type SpellEvent = Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2];
const resolveSpell = (defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState => {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
};

function playUnit(
  defId: string,
  state: GameState,
  extra: Parameters<typeof dispatchOnPlayUnit>[4] = {},
  destination: Parameters<typeof dispatchOnPlayUnit>[3] = "base",
): { state: GameState; unit: UnitInstance } {
  const unit = realUnitInstance(defId);
  const actor = state.players[0]!;
  const withUnit: GameState =
    destination === "base"
      ? {
          ...state,
          players: [{ ...actor, baseUnits: [...actor.baseUnits, unit], cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1 }, state.players[1]!],
        }
      : {
          ...state,
          players: [{ ...actor, cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1 }, state.players[1]!],
          battlefields: state.battlefields.map((bf) =>
            bf.id === destination.battlefieldId ? { ...bf, units: { ...bf.units, p1: [...(bf.units["p1"] ?? []), unit] } } : bf,
          ),
        };
  return { state: dispatchOnPlayUnit(withUnit, unit, 0, destination, extra), unit };
}

const atBf = (s: GameState, playerId: string, bf = 0) => s.battlefields[bf]!.units[playerId] ?? [];

describe("straight damage and kill", () => {
  it("Hextech Ray deals 3 at a battlefield, and cannot reach base", () => {
    const enemy = makeUnit({ name: "Enemy", might: 9 });
    const atHome = makeUnit({ name: "Home", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };
    state.players[1]!.baseUnits = [atHome];

    const after = resolveSpell(HEXTECH_RAY, 0, state, { targetUnitInstanceId: enemy.instanceId });
    expect(atBf(after, "p2")[0]!.damage).toBe(3);

    // Its spec is battlefield-scoped, so the base unit is not an offered target.
    const spell = spellInstance(HEXTECH_RAY);
    const hand: GameState = { ...state, players: [{ ...state.players[0]!, hand: [spell], floatingEnergy: 9, floatingPower: { Fury: 9 } }, state.players[1]!] };
    const offered = legalActions(hand).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    expect(offered.some((a) => a.type === "PlayCard" && a.targetUnitInstanceId === atHome.instanceId)).toBe(false);
  });

  it("Riptide Rex deals 6 to an enemy at a battlefield", () => {
    const enemy = makeUnit({ name: "Enemy", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    const { state: after } = playUnit(RIPTIDE_REX, state, { targetUnitInstanceId: enemy.instanceId });
    expect(atBf(after, "p2")[0]!.damage).toBe(6);
  });

  it("Vengeance kills a unit anywhere, ignoring Might", () => {
    const huge = makeUnit({ name: "Huge", might: 99 });
    const state = makeState();
    state.players[1]!.baseUnits = [huge];

    const after = resolveSpell(VENGEANCE, 0, state, { targetUnitInstanceId: huge.instanceId });

    expect(after.players[1]!.baseUnits).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Huge"]);
  });

  it("Harnessed Dragon kills an enemy on play", () => {
    const enemy = makeUnit({ name: "Enemy", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    const { state: after } = playUnit(HARNESSED_DRAGON, state, { targetUnitInstanceId: enemy.instanceId });
    expect(atBf(after, "p2")).toHaveLength(0);
  });

  it("Flurry of Blades deals 1 to ALL units at battlefields, including the caster's", () => {
    const mine = makeUnit({ name: "Mine", might: 9 });
    const theirs = makeUnit({ name: "Theirs", might: 9 });
    const atHome = makeUnit({ name: "Home", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    state.players[0]!.baseUnits = [atHome];

    const after = resolveSpell(FLURRY_OF_BLADES, 0, state);

    expect(atBf(after, "p1")[0]!.damage).toBe(1);
    expect(atBf(after, "p2")[0]!.damage).toBe(1);
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(0); // "at battlefields"
  });

  it("Thermo Beam kills ALL gear, both players', and fires their killed-triggers", () => {
    const mkGear = (defId: string, instanceId: string): GearInstance => {
      const def = registry.get(defId);
      return { instanceId, defId, name: def.name, domains: def.domains, exhausted: false, isToken: false, kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {} } as GearInstance;
    };
    const state = makeState();
    // Treasure Trove's "when this leaves the board, draw 1 and channel 1" must
    // fire — proof the sweep goes through killGear rather than removing quietly.
    state.players[0]!.activeGear = [mkGear("OGN-186", "trove")];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.players[0]!.runeDeck = [{ id: "rd", domain: "Chaos", state: "Ready" }];
    state.players[1]!.activeGear = [mkGear("OGN-090", "orb")];

    const after = resolveSpell(THERMO_BEAM, 0, state);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[1]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("Unchecked Power exhausts friendlies EVERYWHERE but damages only battlefields", () => {
    const mineOut = makeUnit({ name: "MineOut", might: 20 });
    const mineHome = makeUnit({ name: "MineHome", might: 20 });
    const theirs = makeUnit({ name: "Theirs", might: 20 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mineOut], p2: [theirs] };
    state.players[0]!.baseUnits = [mineHome];

    const after = resolveSpell(UNCHECKED_POWER, 0, state);

    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true); // exhausted, not damaged
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(0);
    expect(atBf(after, "p1")[0]!.exhausted).toBe(true);
    expect(atBf(after, "p1")[0]!.damage).toBe(12);
    expect(atBf(after, "p2")[0]!.damage).toBe(12);
    expect(atBf(after, "p2")[0]!.exhausted).toBe(false); // only FRIENDLY units exhaust
  });
});

describe("Might modification", () => {
  it("Cleave grants [Assault 3], not [Assault 1]", () => {
    // The reason grantKeywordThisTurn took a value: it hardcoded 1, which is
    // right for [Ganking] and wrong here by two.
    const unit = makeUnit({ name: "Mine", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    const after = resolveSpell(CLEAVE, 0, state, { targetUnitInstanceId: unit.instanceId });
    const now = atBf(after, "p1")[0]!;

    expect(hasKeyword(after, now, 0, "Assault")).toBe(true);
    // +3 while ATTACKING only — [Assault] is an attacker's keyword.
    expect(effectiveMight(after, now, 0, { isCombat: true, isAttackingSide: true, combatRole: "outgoing", battlefieldId: "bf1" })).toBe(6);
    expect(effectiveMight(after, now, 0, { isCombat: true, isAttackingSide: false, combatRole: "outgoing", battlefieldId: "bf1" })).toBe(3);
  });

  it("Whiteflame Protector gives +8 this turn", () => {
    const ally = makeUnit({ name: "Ally", might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    const { state: after } = playUnit(WHITEFLAME, state, { targetUnitInstanceId: ally.instanceId });
    expect(after.players[0]!.baseUnits.find((u) => u.name === "Ally")!.mightThisTurn).toBe(8);
  });

  it("Primal Strength gives +7 this turn", () => {
    const ally = makeUnit({ name: "Ally", might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    const after = resolveSpell(PRIMAL_STRENGTH, 0, state, { targetUnitInstanceId: ally.instanceId });
    expect(after.players[0]!.baseUnits[0]!.mightThisTurn).toBe(7);
  });

  it("Siphon Power pumps friendlies and shrinks enemies at ONE battlefield only", () => {
    const mineHere = makeUnit({ name: "MineHere", might: 3 });
    const theirsHere = makeUnit({ name: "TheirsHere", might: 3 });
    const theirsElsewhere = makeUnit({ name: "Elsewhere", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mineHere], p2: [theirsHere] };
    state.battlefields[1]!.units = { p2: [theirsElsewhere] };

    const after = resolveSpell(SIPHON_POWER, 0, state, { targetBattlefieldId: "bf1" });

    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(1);
    expect(atBf(after, "p2")[0]!.mightThisTurn).toBe(-1);
    expect(atBf(after, "p2", 1)[0]!.mightThisTurn).toBe(0); // "there"
  });

  it("Siphon Power floors the debuff at 1", () => {
    const small = makeUnit({ name: "Small", might: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [small] };

    const after = resolveSpell(SIPHON_POWER, 0, state, { targetBattlefieldId: "bf1" });
    expect(effectiveMight(after, atBf(after, "p2")[0]!, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(1);
  });

  it("Ahri - Inquisitive shrinks an enemy when combat begins at HER battlefield", () => {
    const ahri = realUnitInstance(AHRI_INQUISITIVE);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [ahri], p2: [enemy] };

    const after = dispatchEvent(state, { kind: "combatBegan", battlefieldId: "bf1" });
    expect(atBf(after, "p2")[0]!.mightThisTurn).toBe(-2);
  });

  it("Ahri - Inquisitive ignores combat somewhere else", () => {
    const ahri = realUnitInstance(AHRI_INQUISITIVE);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [ahri] };
    state.battlefields[1]!.units = { p2: [enemy] };

    const after = dispatchEvent(state, { kind: "combatBegan", battlefieldId: "bf2" });
    expect(atBf(after, "p2", 1)[0]!.mightThisTurn).toBe(0);
  });

  it("Darius - Trifarian fires on EXACTLY the second card, not the third", () => {
    const darius = realUnitInstance(DARIUS_TRIFARIAN);
    darius.exhausted = true;
    const base = makeState();
    base.battlefields[0]!.units = { p1: [darius] };

    const second: GameState = { ...base, players: [{ ...base.players[0]!, cardsPlayedThisTurn: 2 }, base.players[1]!] };
    const afterSecond = dispatchEvent(second, { kind: "cardPlayed", casterIndex: 0 });
    expect(atBf(afterSecond, "p1")[0]!.mightThisTurn).toBe(2);
    expect(atBf(afterSecond, "p1")[0]!.exhausted).toBe(false);

    const third: GameState = { ...base, players: [{ ...base.players[0]!, cardsPlayedThisTurn: 3 }, base.players[1]!] };
    expect(atBf(dispatchEvent(third, { kind: "cardPlayed", casterIndex: 0 }), "p1")[0]!.mightThisTurn).toBe(0);
  });

  it("Darius - Trifarian ignores the OPPONENT's second card", () => {
    const darius = realUnitInstance(DARIUS_TRIFARIAN);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [darius] };
    state.players[0]!.cardsPlayedThisTurn = 2;

    const after = dispatchEvent(state, { kind: "cardPlayed", casterIndex: 1 });
    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(0);
  });
});

describe("buff cards", () => {
  it("Kinkou Monk buffs up to two — and none is a legal choice", () => {
    const a = makeUnit({ name: "A" });
    const b = makeUnit({ name: "B" });
    const state = makeState();
    state.players[0]!.baseUnits = [a, b];

    const both = playUnit(KINKOU_MONK, state, {
      targetUnitInstanceId: a.instanceId,
      secondTargetUnitInstanceId: b.instanceId,
    }).state;
    expect(both.players[0]!.baseUnits.filter((u) => u.buffed).map((u) => u.name)).toEqual(["A", "B"]);

    // min: 0 — the empty choice is legal and the Monk still deploys.
    const none = playUnit(KINKOU_MONK, state, {}).state;
    expect(none.players[0]!.baseUnits.some((u) => u.buffed)).toBe(false);
  });

  it("Peak Guardian buffs only himself in base, and the whole battlefield when played there", () => {
    const ally = makeUnit({ name: "Ally" });

    const inBase = makeState();
    inBase.players[0]!.baseUnits = [ally];
    const baseResult = playUnit(PEAK_GUARDIAN, inBase).state;
    expect(baseResult.players[0]!.baseUnits.find((u) => u.name === "Ally")!.buffed).toBe(false);
    expect(baseResult.players[0]!.baseUnits.find((u) => u.defId === PEAK_GUARDIAN)!.buffed).toBe(true);

    const atField = makeState();
    atField.battlefields[0]!.units = { p1: [ally] };
    const fieldResult = playUnit(PEAK_GUARDIAN, atField, {}, { battlefieldId: "bf1" }).state;
    expect(atBf(fieldResult, "p1").every((u) => u.buffed)).toBe(true);
  });

  it("Poro Herder needs a Poro — and is not one himself", () => {
    const withoutPoro = makeState();
    withoutPoro.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    const none = playUnit(PORO_HERDER, withoutPoro).state;
    expect(none.players[0]!.baseUnits.find((u) => u.defId === PORO_HERDER)!.buffed).toBe(false);
    expect(none.players[0]!.hand).toHaveLength(0);

    const withPoro = makeState();
    withPoro.players[0]!.baseUnits = [realUnitInstance("OGN-013")]; // Pouty Poro
    withPoro.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    const some = playUnit(PORO_HERDER, withPoro).state;
    expect(some.players[0]!.baseUnits.find((u) => u.defId === PORO_HERDER)!.buffed).toBe(true);
    expect(some.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("Sett - Brawler buffs on play, on conquer, and spends it for +4", () => {
    const state = makeState({ phase: "Action" });
    const played = playUnit(SETT_BRAWLER, state, {}, { battlefieldId: "bf1" }).state;
    expect(atBf(played, "p1")[0]!.buffed).toBe(true);

    // Conquering his own battlefield buffs him again (a no-op while buffed, 708).
    const conquered = recordConquest(played, 0, "bf1");
    expect(atBf(conquered, "p1")[0]!.buffed).toBe(true);

    // Spend it: +4 Might this turn, and no exhaust in the cost line.
    const sett = atBf(conquered, "p1")[0]!;
    const action = legalActions(conquered).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === sett.instanceId,
    )!;
    const after = executeActivateAbility(conquered, action as never);
    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(4);
    expect(atBf(after, "p1")[0]!.buffed).toBe(false);
    expect(atBf(after, "p1")[0]!.exhausted).toBe(false);
  });

  it("Vanguard Helm buffs another friendly when a BUFFED friendly dies", () => {
    const gearDef = registry.get(VANGUARD_HELM);
    const survivor = makeUnit({ name: "Survivor" });
    const doomed = makeUnit({ name: "Doomed", might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [doomed, survivor] };
    state.players[0]!.activeGear = [
      { instanceId: "helm", defId: VANGUARD_HELM, name: gearDef.name, domains: gearDef.domains, exhausted: false, isToken: false, kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {} } as GearInstance,
    ];
    state = addBuff(state, doomed.instanceId);

    const after = answerDecisions(destroyUnit(state, doomed.instanceId, 1));
    expect(atBf(after, "p1").find((u) => u.name === "Survivor")!.buffed).toBe(true);
  });

  it("Vanguard Helm ignores an UNBUFFED death", () => {
    const gearDef = registry.get(VANGUARD_HELM);
    const survivor = makeUnit({ name: "Survivor" });
    const doomed = makeUnit({ name: "Doomed", might: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [doomed, survivor] };
    state.players[0]!.activeGear = [
      { instanceId: "helm", defId: VANGUARD_HELM, name: gearDef.name, domains: gearDef.domains, exhausted: false, isToken: false, kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {} } as GearInstance,
    ];

    const after = destroyUnit(state, doomed.instanceId, 1);
    expect(after.pendingDecisions).toHaveLength(0);
    expect(atBf(after, "p1").find((u) => u.name === "Survivor")!.buffed).toBe(false);
  });
});

describe("Viktor - Leader (OGN-246): a Recruit for every other non-Recruit that dies", () => {
  function viktorState(): { state: GameState; viktor: UnitInstance; ally: UnitInstance } {
    const viktor = realUnitInstance(VIKTOR_LEADER);
    const ally = makeUnit({ name: "Ally", might: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [viktor, ally] };
    return { state, viktor, ally };
  }

  it("makes a token when another friendly unit dies", () => {
    const { state, ally } = viktorState();
    const after = destroyUnit(state, ally.instanceId, 1);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(1);
  });

  it("does NOT fire for his own death — 'another'", () => {
    const { state, viktor } = viktorState();
    const after = destroyUnit(state, viktor.instanceId, 1);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(0);
  });

  it("does NOT fire for a Recruit token dying — otherwise he replaces them forever", () => {
    // The exclusion that keeps this from being a livelock rather than a combo.
    const { state } = viktorState();
    const withToken = destroyUnit(state, state.battlefields[0]!.units["p1"]![1]!.instanceId, 1);
    const token = withToken.players[0]!.baseUnits.find((u) => u.isToken)!;

    const after = destroyUnit(withToken, token.instanceId, 1);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(0);
  });

  it("does NOT fire for an ENEMY unit dying", () => {
    const { state } = viktorState();
    const enemy = makeUnit({ name: "Enemy", might: 1 });
    const withEnemy: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [enemy] } } : bf,
      ),
    };

    const after = destroyUnit(withEnemy, enemy.instanceId, 0);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("reports all nineteen of this batch as implemented", () => {
    expect(BATCH.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });

  it("still knows the death-watch cards after the per-domain split", () => {
    // The split moved Vanguard Helm and Viktor - Leader out of the inline table;
    // coverage has to follow, or two working cards grey out in the deck builder.
    for (const id of [VANGUARD_HELM, VIKTOR_LEADER]) {
      expect(isCardImplemented(registry.get(id)), id).toBe(true);
    }
  });
});
