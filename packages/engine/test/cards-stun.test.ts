import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnAttack, dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { stunUnit, stunUnits, addBuff, dealDamage, destroyUnit } from "../src/engine/effect-helpers.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The eleven cards that read "stun", and the two events they needed.
 *
 * Everything here goes through the COMPOSED registries — `effectForCard`,
 * `dispatchOnPlayUnit`, `dispatchOnAttack`, `stunUnits` — never a resolver
 * closure directly. A card registered in a per-domain file has silently failed
 * to fire in this codebase before, and calling its closure would have passed.
 */

const registry = defaultCardRegistry();

const RUNE_PRISON = "OGN-050";
const SOLARI_SHIELDBEARER = "OGN-051";
const ECLIPSE_HERALD = "OGN-059";
const SOLARI_SHRINE = "OGN-072";
const LEONA_ZEALOT = "OGN-079";
const TWISTED_FATE = "OGN-200";
const FACEBREAKER = "OGN-220";
const SOLARI_CHIEF = "OGN-225";
const LEONA_DETERMINED = "OGN-238";
const LEONA_RADIANT_DAWN = "OGN-261";
const ZENITH_BLADE = "OGN-262";

const STUN_CARDS = [
  RUNE_PRISON,
  SOLARI_SHIELDBEARER,
  ECLIPSE_HERALD,
  SOLARI_SHRINE,
  LEONA_ZEALOT,
  TWISTED_FATE,
  FACEBREAKER,
  SOLARI_CHIEF,
  LEONA_DETERMINED,
  LEONA_RADIANT_DAWN,
  ZENITH_BLADE,
];

type SpellEvent = Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2];

function resolveSpell(defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
}

/** Plays a real Unit through the composed on-play dispatch, as
 *  execute-play-card would — never the per-domain closure. */
function playUnit(defId: string, casterIndex: 0 | 1, state: GameState, extra: Parameters<typeof dispatchOnPlayUnit>[4] = {}): {
  state: GameState;
  unit: UnitInstance;
} {
  const unit = realUnitInstance(defId);
  const ownerId = state.players[casterIndex].id;
  const bf = state.battlefields[0]!;
  const withUnit: GameState = {
    ...state,
    battlefields: state.battlefields.map((b) =>
      b.id === bf.id ? { ...b, units: { ...b.units, [ownerId]: [...(b.units[ownerId] ?? []), unit] } } : b,
    ),
  };
  return { state: dispatchOnPlayUnit(withUnit, unit, casterIndex, { battlefieldId: bf.id }, extra), unit };
}

const unitsAt = (state: GameState, playerId: string, bf = 0) => state.battlefields[bf]!.units[playerId] ?? [];
const firstAt = (state: GameState, playerId: string, bf = 0) => unitsAt(state, playerId, bf)[0]!;

describe("Rune Prison (OGN-050): [Action] Stun a unit", () => {
  it("stuns a unit at a battlefield", () => {
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    const after = resolveSpell(RUNE_PRISON, 0, state, { targetUnitInstanceId: enemy.instanceId });

    expect(firstAt(after, "p2").stunned).toBe(true);
  });

  it("reaches a unit in BASE — the card says 'a unit', not 'a unit at a battlefield'", () => {
    // 355.9.b: the bare noun means objects on the Board, and Bases are Public.
    // The same reading Final Spark, Discipline and Stupefy already have. Getting
    // this wrong would make base a safe parking spot from a card that never says
    // it is one.
    const enemy = makeUnit({ name: "Enemy at home" });
    const state = makeState();
    state.players[1]!.baseUnits = [enemy];

    const after = resolveSpell(RUNE_PRISON, 0, state, { targetUnitInstanceId: enemy.instanceId });

    expect(after.players[1]!.baseUnits[0]!.stunned).toBe(true);
  });

  it("offers base units as targets in enumeration too, not just in the resolver", () => {
    // The resolver and the enumerator disagreeing is how the UI ends up offering
    // a click the validator refuses.
    const enemy = makeUnit({ name: "Enemy at home" });
    const spell = spellInstance(RUNE_PRISON);
    let state = makeState();
    state.players[1]!.baseUnits = [enemy];
    state = {
      ...state,
      players: [{ ...state.players[0]!, hand: [spell], floatingEnergy: 9, floatingPower: { Calm: 9 } }, state.players[1]!],
    };

    const offered = legalActions(state).filter(
      (a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId,
    );

    expect(offered.some((a) => a.type === "PlayCard" && a.targetUnitInstanceId === enemy.instanceId)).toBe(true);
  });
});

describe("Solari Shieldbearer (OGN-051): when you play me, stun a unit", () => {
  it("fires through the composed on-play dispatch", () => {
    const enemy = makeUnit({ name: "Enemy" });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    state = playUnit(SOLARI_SHIELDBEARER, 0, state, { targetUnitInstanceId: enemy.instanceId }).state;

    expect(firstAt(state, "p2").stunned).toBe(true);
  });

  it("does nothing when the board offered no target", () => {
    // A Unit is playable with its trigger's target omitted when nothing was
    // legal (validate-play-card's targetOmissionAllowed), so the resolver really
    // does run with nothing to act on.
    let state = makeState();
    state = playUnit(SOLARI_SHIELDBEARER, 0, state, {}).state;
    expect(state.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });
});

describe("Eclipse Herald (OGN-059): when you stun an enemy unit, ready me and give me +1 Might", () => {
  /** Herald (exhausted, so readying is visible) plus one enemy, both at bf1. */
  function heraldState(): { state: GameState; herald: UnitInstance; enemy: UnitInstance } {
    const herald = realUnitInstance(ECLIPSE_HERALD);
    herald.exhausted = true;
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [herald], p2: [enemy] };
    return { state, herald, enemy };
  }

  it("readies the Herald and pumps it when its controller stuns an enemy", () => {
    const { state, enemy } = heraldState();

    const after = stunUnits(state, 0, [enemy.instanceId]);
    const herald = firstAt(after, "p1");

    expect(herald.exhausted).toBe(false);
    expect(herald.mightThisTurn).toBe(1);
  });

  it("does NOT fire when the unit was already stunned — 422's own worked example", () => {
    // "A Stunned Unit can not be Stunned again", and the rules cite this card as
    // the reason it matters. The guard is in stunUnits, not in the Herald.
    const { state, enemy } = heraldState();
    const already = stunUnit(state, enemy.instanceId);

    const after = stunUnits(already, 0, [enemy.instanceId]);

    expect(firstAt(after, "p1").exhausted).toBe(true); // never readied
    expect(firstAt(after, "p1").mightThisTurn).toBe(0);
  });

  it("does NOT fire when the OPPONENT does the stunning", () => {
    // "When YOU stun" — the stunner has to be the Herald's own controller.
    const { state, herald } = heraldState();
    const ownUnit = makeUnit({ name: "Also mine" });
    state.players[0]!.baseUnits = [ownUnit];

    const after = stunUnits(state, 1, [ownUnit.instanceId]);

    expect(firstAt(after, "p1").instanceId).toBe(herald.instanceId);
    expect(firstAt(after, "p1").exhausted).toBe(true);
  });

  it("does NOT fire when the stunned unit is friendly", () => {
    // "an ENEMY unit" — measured against the Herald's controller.
    const { state } = heraldState();
    const ownUnit = makeUnit({ name: "Also mine" });
    state.players[0]!.baseUnits = [ownUnit];

    const after = stunUnits(state, 0, [ownUnit.instanceId]);

    expect(firstAt(after, "p1").exhausted).toBe(true);
  });

  it("pays out per enemy unit in one batch — 'AN enemy unit', singular", () => {
    // Deliberately the opposite of Leona - Radiant Dawn's "one or more", which
    // pays once. Two enemies stunned together is +2 Might, not +1.
    const { state } = heraldState();
    const second = makeUnit({ name: "Enemy 2" });
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, second];
    const ids = unitsAt(state, "p2").map((u) => u.instanceId);

    const after = stunUnits(state, 0, ids);

    expect(firstAt(after, "p1").mightThisTurn).toBe(2);
  });

  it("sees Udyr's stun mode — the funnel is not bypassed by the activated-ability path", () => {
    // The dispatch-hop trap this codebase has shipped three times: Udyr's mode
    // called the primitive directly, so the ability would still stun and every
    // watcher would silently never fire. Driven through the real executor.
    const herald = realUnitInstance(ECLIPSE_HERALD);
    herald.exhausted = true;
    const udyr = realUnitInstance("OGN-157");
    const enemy = makeUnit({ name: "Enemy" });
    let state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [udyr, herald], p2: [enemy] };
    state = addBuff(state, udyr.instanceId);

    const stun = legalActions(state).find(
      (a) =>
        a.type === "ActivateAbility" &&
        a.permanentInstanceId === udyr.instanceId &&
        a.modeId === "stun" &&
        a.targetUnitInstanceId === enemy.instanceId,
    )!;
    const after = executeActivateAbility(state, stun as never);

    expect(firstAt(after, "p2").stunned).toBe(true);
    expect(unitsAt(after, "p1").find((u) => u.defId === ECLIPSE_HERALD)!.exhausted).toBe(false);
  });
});

describe("Leona - Radiant Dawn (OGN-261): when you stun one or more enemy units, buff a friendly unit", () => {
  /** p1's legend is Leona - Radiant Dawn, with a friendly unit to buff. */
  function leonaState(): { state: GameState; friendly: UnitInstance; enemies: UnitInstance[] } {
    const friendly = makeUnit({ name: "Friendly" });
    const enemies = [makeUnit({ name: "Enemy 1" }), makeUnit({ name: "Enemy 2" })];
    const state = makeState();
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: LEONA_RADIANT_DAWN, name: "Leona - Radiant Dawn" };
    state.battlefields[0]!.units = { p1: [friendly], p2: enemies };
    return { state, friendly, enemies };
  }

  it("buffs a chosen friendly unit when its controller stuns an enemy", () => {
    const { state, enemies } = leonaState();

    const after = answerDecisions(stunUnits(state, 0, [enemies[0]!.instanceId]));

    expect(firstAt(after, "p1").buffed).toBe(true);
  });

  it("pays out ONCE for a batch of two — 'one or more', not 'each'", () => {
    // A buff is capped at one per unit (708), so counting buffs would not show a
    // double trigger. Counting the QUESTIONS does: two triggers would queue two.
    const { state, enemies } = leonaState();
    const second = makeUnit({ name: "Second friendly" });
    state.players[0]!.baseUnits = [second];

    const after = stunUnits(state, 0, enemies.map((u) => u.instanceId));

    expect(after.pendingDecisions).toHaveLength(1);
    expect(after.pendingDecisions[0]!.kind).toBe("OGN-261-buff");
  });

  it("offers every friendly unit, base and battlefield alike", () => {
    const { state, enemies } = leonaState();
    const atHome = makeUnit({ name: "At home" });
    state.players[0]!.baseUnits = [atHome];

    const after = stunUnits(state, 0, [enemies[0]!.instanceId]);
    const options = optionsFor(after, pendingDecision(after)!);

    expect(options.map((o) => o.label).sort()).toEqual(["At home", "Friendly"]);
  });

  it("does not fire for the opponent's stun, nor for stunning your own", () => {
    const { state, friendly } = leonaState();

    expect(stunUnits(state, 1, [friendly.instanceId]).pendingDecisions).toHaveLength(0);
    expect(stunUnits(state, 0, [friendly.instanceId]).pendingDecisions).toHaveLength(0);
  });
});

describe("Solari Chief (OGN-225): stun an enemy unit, or kill it if already stunned", () => {
  function chiefState(enemyStunned: boolean): { state: GameState; enemy: UnitInstance } {
    const enemy = makeUnit({ name: "Enemy" });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };
    if (enemyStunned) state = stunUnit(state, enemy.instanceId);
    return { state, enemy };
  }

  it("stuns a ready enemy", () => {
    const { state, enemy } = chiefState(false);
    const after = playUnit(SOLARI_CHIEF, 0, state, { targetUnitInstanceId: enemy.instanceId }).state;

    expect(firstAt(after, "p2").stunned).toBe(true);
    expect(after.players[1]!.trash).toHaveLength(0);
  });

  it("KILLS an already-stunned enemy", () => {
    const { state, enemy } = chiefState(true);
    const after = playUnit(SOLARI_CHIEF, 0, state, { targetUnitInstanceId: enemy.instanceId }).state;

    expect(unitsAt(after, "p2")).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain(enemy.instanceId);
  });

  it("reads 'stunned' at RESOLUTION, not when the target was chosen", () => {
    // The choice rides on the action and an opponent may respond on the chain in
    // between. A stun landing there has to turn this into a kill.
    const { state, enemy } = chiefState(false);
    const stunnedMeanwhile = stunUnit(state, enemy.instanceId);

    const after = playUnit(SOLARI_CHIEF, 0, stunnedMeanwhile, { targetUnitInstanceId: enemy.instanceId }).state;

    expect(unitsAt(after, "p2")).toHaveLength(0);
  });
});

describe("Leona - Determined (OGN-238): when I attack, stun an enemy unit here", () => {
  it("stuns an enemy at her battlefield through the on-attack dispatch", () => {
    const leona = realUnitInstance(LEONA_DETERMINED);
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [leona], p2: [enemy] };

    const after = dispatchOnAttack(state, leona, 0, "bf1");

    expect(firstAt(after, "p2").stunned).toBe(true);
  });

  it("does not reach a unit at ANOTHER battlefield — 'here' is her own", () => {
    const leona = realUnitInstance(LEONA_DETERMINED);
    const elsewhere = makeUnit({ name: "Elsewhere" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [leona] };
    state.battlefields[1]!.units = { p2: [elsewhere] };

    const after = dispatchOnAttack(state, leona, 0, "bf1");

    expect(firstAt(after, "p2", 1).stunned).toBe(false);
  });

  it("makes the stunned defender deal no combat damage", () => {
    // The point of the card, asserted end to end rather than on the flag: a
    // 5-Might defender stunned on the way in kills nothing.
    const leona = realUnitInstance(LEONA_DETERMINED);
    const defender = makeUnit({ name: "Defender", might: 5 });
    const state = makeState({ turnState: "Showdown", showdownBattlefieldId: "bf1", showdownKind: "Combat" });
    state.battlefields[0]!.units = { p1: [leona], p2: [defender] };

    const attacked = dispatchOnAttack(state, leona, 0, "bf1");
    const after = resolveShowdown(attacked, "bf1", 0);

    // Leona survives (4 Might, took 0) and is recalled to base by cleanup 3d.
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toContain(LEONA_DETERMINED);
    expect(after.players[0]!.trash).toHaveLength(0);
  });
});

describe("Twisted Fate - Gambler (OGN-200): reveal the top rune, then act on its domain", () => {
  function tfState(domain: string): { state: GameState; tf: UnitInstance; enemies: UnitInstance[] } {
    const tf = realUnitInstance(TWISTED_FATE);
    const enemies = [makeUnit({ name: "Enemy 1", might: 9 }), makeUnit({ name: "Enemy 2", might: 9 })];
    const state = makeState();
    state.battlefields[0]!.units = { p1: [tf], p2: enemies };
    state.players[0]!.runeDeck = [{ id: "r1", domain, state: "Ready" } as never, { id: "r2", domain: "Calm", state: "Ready" } as never];
    return { state, tf, enemies };
  }

  it("recycles the revealed rune to the BOTTOM of the rune deck (416)", () => {
    const { state, tf } = tfState("Mind");
    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(after.players[0]!.runeDeck.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("Mind: draws 1", () => {
    const { state, tf } = tfState("Mind");
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];

    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("Fury: 2 to the first enemy here and 1 to each other", () => {
    const { state, tf } = tfState("Fury");
    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(unitsAt(after, "p2").map((u) => u.damage)).toEqual([2, 1]);
  });

  it("Order: stuns an enemy", () => {
    const { state, tf } = tfState("Order");
    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(unitsAt(after, "p2").some((u) => u.stunned)).toBe(true);
  });

  it("a Calm rune is a whiff — three of the six domains do nothing, in print", () => {
    const { state, tf } = tfState("Calm");
    state.players[0]!.deck = [makeUnit({ name: "Not drawn" })];

    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(unitsAt(after, "p2").every((u) => u.damage === 0 && !u.stunned)).toBe(true);
  });

  it("does nothing at all on an empty rune deck — the reveal is the whole trigger", () => {
    const { state, tf } = tfState("Fury");
    state.players[0]!.runeDeck = [];

    const after = dispatchOnAttack(state, tf, 0, "bf1");

    expect(after).toBe(state);
  });
});

describe("Zenith Blade (OGN-262): stun an enemy, then you may move a friendly to it", () => {
  function bladeState(): { state: GameState; enemy: UnitInstance; friendly: UnitInstance } {
    const enemy = makeUnit({ name: "Enemy" });
    const friendly = makeUnit({ name: "Friendly" });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };
    state.players[0]!.baseUnits = [friendly];
    return { state, enemy, friendly };
  }

  it("stuns without moving anything when the second target is declined", () => {
    const { state, enemy } = bladeState();
    const after = resolveSpell(ZENITH_BLADE, 0, state, { targetUnitInstanceId: enemy.instanceId });

    expect(firstAt(after, "p2").stunned).toBe(true);
    expect(after.players[0]!.baseUnits).toHaveLength(1); // still home
  });

  it("moves a friendly unit out of BASE onto the enemy's battlefield", () => {
    // The friendly slot is scoped "anywhere" while the enemy slot is not — the
    // card names a battlefield for one and not the other, and the unit you most
    // want to send is the one at home.
    const { state, enemy, friendly } = bladeState();

    const after = resolveSpell(ZENITH_BLADE, 0, state, {
      targetUnitInstanceId: enemy.instanceId,
      secondTargetUnitInstanceId: friendly.instanceId,
    });

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(firstAt(after, "p1").name).toBe("Friendly");
  });

  it("the moved unit arrives READY — a spell's move is not a Standard Move (415.1.b)", () => {
    const { state, enemy, friendly } = bladeState();
    const after = resolveSpell(ZENITH_BLADE, 0, state, {
      targetUnitInstanceId: enemy.instanceId,
      secondTargetUnitInstanceId: friendly.instanceId,
    });

    expect(firstAt(after, "p1").exhausted).toBe(false);
  });

  it("enumerates the enemy slot at battlefields only and the friendly slot anywhere", () => {
    const { state, enemy, friendly } = bladeState();
    const spell = spellInstance(ZENITH_BLADE);
    const enemyAtHome = makeUnit({ name: "Enemy at home" });
    const withHand: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, hand: [spell], floatingEnergy: 9, floatingPower: { Calm: 9 } },
        { ...state.players[1]!, baseUnits: [enemyAtHome] },
      ],
    };

    const offered = legalActions(withHand).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    const firstTargets = new Set(offered.map((a) => (a.type === "PlayCard" ? a.targetUnitInstanceId : undefined)));
    const secondTargets = new Set(offered.map((a) => (a.type === "PlayCard" ? a.secondTargetUnitInstanceId : undefined)));

    expect(firstTargets.has(enemy.instanceId)).toBe(true);
    expect(firstTargets.has(enemyAtHome.instanceId)).toBe(false); // enemy is "at a battlefield"
    expect(secondTargets.has(friendly.instanceId)).toBe(true); // friendly is not
  });
});

describe("Facebreaker (OGN-220): stun a friendly and an enemy at the SAME battlefield", () => {
  /** A friendly+enemy pair at bf1, and a second friendly parked at bf2. */
  function faceState(): { state: GameState; friendly: UnitInstance; enemy: UnitInstance; elsewhere: UnitInstance } {
    const friendly = makeUnit({ name: "Friendly here" });
    const enemy = makeUnit({ name: "Enemy here" });
    const elsewhere = makeUnit({ name: "Friendly elsewhere" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };
    state.battlefields[1]!.units = { p1: [elsewhere] };
    return { state, friendly, enemy, elsewhere };
  }

  it("stuns both", () => {
    const { state, friendly, enemy } = faceState();
    const after = resolveSpell(FACEBREAKER, 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(firstAt(after, "p1").stunned).toBe(true);
    expect(firstAt(after, "p2").stunned).toBe(true);
  });

  it("fires ONE stun event for the pair, not two", () => {
    // "Stun a friendly unit AND an enemy unit" is one instruction, so Leona -
    // Radiant Dawn buffs once. Two stunUnits calls would queue two questions.
    const { state, friendly, enemy } = faceState();
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: LEONA_RADIANT_DAWN, name: "Leona - Radiant Dawn" };

    const after = resolveSpell(FACEBREAKER, 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(after.pendingDecisions).toHaveLength(1);
  });

  it("is never OFFERED a pair at different battlefields", () => {
    const { state, enemy, elsewhere } = faceState();
    const spell = spellInstance(FACEBREAKER);
    const withHand: GameState = {
      ...state,
      players: [{ ...state.players[0]!, hand: [spell], floatingEnergy: 9 }, state.players[1]!],
    };

    const offered = legalActions(withHand).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);

    expect(offered.length).toBeGreaterThan(0); // the legal pair IS offered
    expect(
      offered.some(
        (a) =>
          a.type === "PlayCard" &&
          a.targetUnitInstanceId === elsewhere.instanceId &&
          a.secondTargetUnitInstanceId === enemy.instanceId,
      ),
    ).toBe(false);
  });

  it("REFUSES a forged split pair — the enumerator and the validator agree", () => {
    const { state, enemy, elsewhere } = faceState();
    const spell = spellInstance(FACEBREAKER);
    const withHand: GameState = {
      ...state,
      players: [{ ...state.players[0]!, hand: [spell], floatingEnergy: 9 }, state.players[1]!],
    };

    const forged = {
      type: "PlayCard" as const,
      playerIndex: 0 as const,
      card: spell,
      targetUnitInstanceId: elsewhere.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    };

    expect(validatePlayCard(withHand, forged as never).ok).toBe(false);
  });

  it("is not playable at all with no friendly and enemy standing together", () => {
    // min: 2 — the friendly stun is the price of the enemy one, so there is no
    // do-as-much-as-you-can variant.
    const spell = spellInstance(FACEBREAKER);
    const lone = makeUnit({ name: "Alone" });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [lone] };
    state = { ...state, players: [{ ...state.players[0]!, hand: [spell], floatingEnergy: 9 }, state.players[1]!] };

    const offered = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);

    expect(offered).toHaveLength(0);
  });
});

describe("Solari Shrine (OGN-072): when you kill a stunned enemy unit, you may exhaust to draw 1", () => {
  /** p1 holds a ready Shrine and a card to draw; p2 has one stunned unit at bf1. */
  function shrineState(options: { stunned?: boolean; shrineExhausted?: boolean } = {}): {
    state: GameState;
    victim: UnitInstance;
  } {
    const shrine = { ...realUnitInstance(SOLARI_SHIELDBEARER) }; // replaced below
    void shrine;
    const gear = defaultCardRegistry().get(SOLARI_SHRINE);
    const victim = makeUnit({ name: "Victim", might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state = {
      ...state,
      players: [
        {
          ...state.players[0]!,
          deck: [makeUnit({ name: "Drawn" })],
          activeGear: [
            {
              instanceId: "shrine-1",
              defId: gear.id,
              name: gear.name,
              domains: gear.domains,
              exhausted: options.shrineExhausted === true,
              isToken: false,
              kind: "Gear",
              energyCost: 0,
              powerCost: 0,
              powerDomain: null,
              keywords: {},
            } as never,
          ],
        },
        state.players[1]!,
      ],
    };
    if (options.stunned !== false) state = stunUnit(state, victim.instanceId);
    return { state, victim };
  }

  it("asks, and draws when accepted — exhausting the Shrine", () => {
    const { state, victim } = shrineState();

    const asked = destroyUnit(state, victim.instanceId, 0);
    expect(pendingDecision(asked)!.kind).toBe("OGN-072-draw");

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "draw")!.id);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
  });

  it("declining costs nothing — the Shrine stays ready and no card is drawn", () => {
    const { state, victim } = shrineState();

    const after = answerDecisions(destroyUnit(state, victim.instanceId, 0), (o) => o.find((x) => x.id === "decline")!.id);

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(false);
  });

  it("does not ask when the victim was not stunned", () => {
    const { state, victim } = shrineState({ stunned: false });
    expect(destroyUnit(state, victim.instanceId, 0).pendingDecisions).toHaveLength(0);
  });

  it("does not ask when somebody ELSE did the killing", () => {
    // "When YOU kill" — this is the whole reason DeathContext carries a killer.
    const { state, victim } = shrineState();
    expect(destroyUnit(state, victim.instanceId, 1).pendingDecisions).toHaveLength(0);
  });

  it("does not ask when the dead unit was FRIENDLY", () => {
    const gear = defaultCardRegistry().get(SOLARI_SHRINE);
    const own = makeUnit({ name: "Mine", might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [own] };
    state = {
      ...state,
      players: [
        {
          ...state.players[0]!,
          activeGear: [
            { instanceId: "shrine-1", defId: gear.id, name: gear.name, domains: gear.domains, exhausted: false, isToken: false, kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {} } as never,
          ],
        },
        state.players[1]!,
      ],
    };
    state = stunUnit(state, own.instanceId);

    expect(destroyUnit(state, own.instanceId, 0).pendingDecisions).toHaveLength(0);
  });

  it("does not ask when the Shrine is already exhausted — it cannot pay", () => {
    const { state, victim } = shrineState({ shrineExhausted: true });
    expect(destroyUnit(state, victim.instanceId, 0).pendingDecisions).toHaveLength(0);
  });

  it("fires on a COMBAT kill too — the killer is the opposing side", () => {
    const { state, victim } = shrineState();
    const attacker = makeUnit({ name: "Attacker", might: 5 });
    const fighting: GameState = {
      ...state,
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [attacker] } } : bf,
      ),
    };

    const after = resolveShowdown(fighting, "bf1", 0);

    expect(after.pendingDecisions.some((d) => d.kind === "OGN-072-draw")).toBe(true);
  });
});

describe("Leona - Zealot (OGN-079)", () => {
  it("enters ready when an opponent is within 3 of the Victory Score", () => {
    // 8 - 5 = 3, inclusive.
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const state = makeState();
    state.players[1]!.points = 5;

    expect(unitEntersReady(state, 0, zealot)).toBe(true);
  });

  it("enters exhausted while the opponent is further behind", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const state = makeState();
    state.players[1]!.points = 4; // gap of 4

    expect(unitEntersReady(state, 0, zealot)).toBe(false);
  });

  it("reads the OPPONENT's score, not her controller's", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const state = makeState();
    state.players[0]!.points = 7; // her own controller is about to win

    expect(unitEntersReady(state, 0, zealot)).toBe(false);
  });

  it("takes 8 Might off a stunned enemy at her battlefield, floored at 1", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [zealot], p2: [enemy] };
    state = stunUnit(state, enemy.instanceId);

    const might = effectiveMight(state, firstAt(state, "p2"), 1, { isCombat: false, battlefieldId: "bf1" });

    expect(might).toBe(1); // 5 - 8, floored
  });

  it("leaves a READY enemy alone", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [zealot], p2: [enemy] };

    expect(effectiveMight(state, enemy, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  it("leaves a stunned enemy at ANOTHER battlefield alone — 'here' is positional", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [zealot] };
    state.battlefields[1]!.units = { p2: [enemy] };
    state = stunUnit(state, enemy.instanceId);

    expect(effectiveMight(state, firstAt(state, "p2", 1), 1, { isCombat: false, battlefieldId: "bf2" })).toBe(5);
  });

  it("never weakens her controller's OWN stunned units", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const friend = makeUnit({ name: "Friend", might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [zealot, friend] };
    state = stunUnit(state, friend.instanceId);

    expect(effectiveMight(state, unitsAt(state, "p1")[1]!, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  it("does nothing while she sits in base", () => {
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    let state = makeState();
    state.players[0]!.baseUnits = [zealot];
    state.battlefields[0]!.units = { p2: [enemy] };
    state = stunUnit(state, enemy.instanceId);

    expect(effectiveMight(state, firstAt(state, "p2"), 1, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  it("does NOT make the weakened unit easier to kill (422's other half still holds)", () => {
    // Stun alone never lowers the damage needed. Leona's -8 DOES, because it is
    // a Might reduction rather than the Stun status — the two are different and
    // this pins which is which: 5 Might down to 1 dies to 1 damage.
    const zealot = realUnitInstance(LEONA_ZEALOT);
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [zealot], p2: [enemy] };
    state = stunUnit(state, enemy.instanceId);

    const after = dealDamage(state, 0, enemy.instanceId, 1);

    expect(unitsAt(after, "p2")).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("reports all eleven stun cards as implemented", () => {
    const inert = STUN_CARDS.filter((id) => !isCardImplemented(registry.get(id)));
    expect(inert).toEqual([]);
  });
});
