import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { recordEnemyChoices } from "../src/engine/effect-helpers.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Ezreal - Prodigal Explorer (SFD-199) — "[Exhaust]: [Reaction] — Draw 1. Use
 * only if you've chosen enemy units and/or gear twice this turn with spells or
 * unit abilities."
 *
 * The draw is trivial; the CONDITION is the card, and it is a per-turn count of
 * CHOICES rather than of cards — one spell naming two enemy units satisfies him
 * on its own. That is 355's reading and already this engine's, since
 * `holdUnitsChosen` raises one event per chosen unit.
 *
 * Four ways to get the tally wrong, one test each:
 *  - counting FRIENDLY choices ("enemy units and/or gear");
 *  - missing the GEAR half, which no unit-target field carries;
 *  - counting a LEGEND's or a gear's ability ("spells or UNIT abilities") — and
 *    Jax - Grandmaster At Arms chooses a unit every single time he is used;
 *  - letting the count survive the turn ("twice THIS turn").
 */

const registry = defaultCardRegistry();
const EZREAL = "SFD-199";
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield."
const DORANS_BLADE = "SFD-095";
const CAITLYN_PATROLLING = "OGN-068"; // Unit — "Exhaust: Deal damage equal to my Might to a unit at a battlefield."
const MISS_FORTUNE = "OGN-267"; // Legend — "Exhaust: Give a unit [Ganking] this turn."
const IRON_BALLISTA = "OGN-017"; // Gear — names a unit at a battlefield

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (domain: RuneCard["domain"], n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

/** Ezreal in the Legend zone, an enemy unit at a battlefield to shoot, and a
 *  friendly one beside it so "enemy" is a real distinction rather than the only
 *  thing on the board. */
function board(): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: EZREAL };
  state.players[0]!.channeled = runes("Fury", 8);
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: {
      [state.players[0]!.id]: [makeUnit({ name: "Mine", instanceId: "mine", might: 9 })],
      // Might 9 so it SURVIVES two Hextech Rays — a dead unit cannot be chosen
      // again, and the second cast would have nothing to name.
      [state.players[1]!.id]: [makeUnit({ name: "Foe", instanceId: "foe", might: 9 })],
    },
  };
  return state;
}

const ezrealActions = (state: GameState): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
  );

const count = (state: GameState) => state.players[0]!.enemyChoicesThisTurn;

/** Puts a real unit with an activated ability at the same battlefield as the
 *  enemy, so it can legally name one. */
function withUnitAbility(defId: string): GameState {
  const state = board();
  const shooter = { ...realUnitInstance(defId), instanceId: "shooter" };
  const bf = state.battlefields[0]!;
  return {
    ...state,
    battlefields: [
      { ...bf, units: { ...bf.units, [state.players[0]!.id]: [...(bf.units[state.players[0]!.id] ?? []), shooter] } },
      ...state.battlefields.slice(1),
    ],
  };
}

function withLegendAbility(defId: string): GameState {
  const state = board();
  return { ...state, players: [{ ...state.players[0]!, legend: { ...state.players[0]!.legend, defId } }, state.players[1]!] };
}

function withGearAbility(defId: string): GameState {
  const state = board();
  return { ...state, players: [{ ...state.players[0]!, activeGear: [gear(defId)] }, state.players[1]!] };
}

/** Activates whatever ability can name `targetInstanceId` — the point of these
 *  three tests is the SOURCE's kind, so which card it is does not matter here
 *  beyond it being able to choose an enemy at all. */
function activateAt(state: GameState, targetInstanceId: string): GameState {
  const use = legalActions(state).find(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.targetUnitInstanceId === targetInstanceId,
  );
  expect(use, `nothing offered an activation naming ${targetInstanceId}`).toBeDefined();
  const { state: after, result } = submit(state, use!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return after;
}

/** Casts Hextech Ray at `targetInstanceId` through the real enumerate-and-submit
 *  path, so the choice is recorded where a game would record it. */
function shoot(state: GameState, targetInstanceId: string): GameState {
  const spell = spellInstance(HEXTECH_RAY);
  const withSpell: GameState = {
    ...state,
    players: [{ ...state.players[0]!, hand: [spell] }, state.players[1]!],
  };
  const play = legalActions(withSpell).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.targetUnitInstanceId === targetInstanceId,
  );
  expect(play, `no legal Hextech Ray at ${targetInstanceId}`).toBeDefined();
  const { state: next, result } = submit(withSpell, play!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  // Resolved before returning: a Spell CLOSES the chain, and a second cast into a
  // closed chain is illegal for anything without [Reaction] — so a test that
  // shoots twice has to let the first one resolve, exactly as a game would.
  return settle(next);
}

function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && !current.chainOpen; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

describe("the tally counts the right choices", () => {
  it("counts an enemy unit chosen with a spell", () => {
    expect(count(shoot(board(), "foe")), "an enemy choice was not counted").toBe(1);
  });

  /** "ENEMY units and/or gear" — choosing your own is choosing, but not this. */
  it("does NOT count a FRIENDLY unit chosen with the same spell", () => {
    expect(count(shoot(board(), "mine")), "a friendly choice was counted").toBe(0);
  });

  /** The GEAR half, which no unit-target field carries. */
  it("counts an enemy GEAR", () => {
    const state = board();
    const theirs = gear(DORANS_BLADE);
    const withGear: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, activeGear: [theirs] }],
    };
    expect(count(recordEnemyChoices(withGear, 0, [theirs.instanceId])), "an enemy gear was not counted").toBe(1);
  });

  it("does NOT count the player's OWN gear", () => {
    const state = board();
    const mine = gear(DORANS_BLADE);
    const withGear: GameState = {
      ...state,
      players: [{ ...state.players[0]!, activeGear: [mine] }, state.players[1]!],
    };
    expect(count(recordEnemyChoices(withGear, 0, [mine.instanceId])), "a friendly gear was counted").toBe(0);
  });

  /** One per CHOICE, not per card — a spell naming two enemy things gets there
   *  on its own, which is the whole reason this is a counter. */
  it("counts one per CHOICE, so two in one breath is enough", () => {
    const state = board();
    const theirs = gear(DORANS_BLADE);
    const withGear: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, activeGear: [theirs] }],
    };
    expect(count(recordEnemyChoices(withGear, 0, ["foe", theirs.instanceId]))).toBe(2);
  });

  /** "THIS turn" — the tally ends with the turn, like every other such field. */
  it("resets at end of turn", () => {
    const after = shoot(board(), "foe");
    expect(count(after)).toBe(1);
    expect(count(runEnd(after)), "the tally survived the turn").toBe(0);
  });

  /**
   * **"With spells or UNIT abilities"**, so a UNIT's ability choosing an enemy
   * DOES count. Caitlyn - Patrolling ("Exhaust: Deal damage equal to my Might to
   * a unit at a battlefield") is the positive control for the pair below.
   */
  it("counts a UNIT's ability choosing an enemy", () => {
    const state = withUnitAbility(CAITLYN_PATROLLING);
    const shot = activateAt(state, "foe");

    expect(count(shot), "a unit ability's enemy choice was not counted").toBe(1);
  });

  /**
   * And the negative that isolates the clause: a LEGEND's ability choosing the
   * SAME enemy unit counts for nothing.
   *
   * Miss Fortune - Bounty Hunter ("Exhaust: Give a unit [Ganking] this turn")
   * rather than Jax, deliberately: Jax can only name a FRIENDLY unit, so a test
   * built on him passes whether the source's kind is checked or not — it is the
   * enemy filter doing the work, not this clause. Proved by mutation: widening
   * the check to every ability leaves a Jax-based test green and this one red.
   */
  it("does NOT count a LEGEND's ability choosing the same enemy", () => {
    const state = withLegendAbility(MISS_FORTUNE);
    const ganked = activateAt(state, "foe");

    expect(count(ganked), "a Legend's ability was counted").toBe(0);
  });

  /** The third source kind, for completeness: a GEAR's ability is not a unit's
   *  either. Iron Ballista names a unit at a battlefield. */
  it("does NOT count a GEAR's ability choosing an enemy", () => {
    const state = withGearAbility(IRON_BALLISTA);
    const shot = activateAt(state, "foe");

    expect(count(shot), "a gear's ability was counted").toBe(0);
  });
});

describe("Ezreal's gate", () => {
  it("is not offered on ONE enemy choice", () => {
    const once = shoot(board(), "foe");
    expect(count(once)).toBe(1);
    expect(ezrealActions(once), "he was offered one choice short").toHaveLength(0);
  });

  it("is offered on the SECOND, and draws", () => {
    const twice = shoot(shoot(board(), "foe"), "foe");
    expect(count(twice)).toBe(2);

    const use = ezrealActions(twice);
    expect(use, "he was not offered at two choices").toHaveLength(1);

    const handBefore = twice.players[0]!.hand.length;
    const { state: after, result } = submit(twice, use[0]!);
    expect(result).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.hand.length, "no card was drawn").toBe(handBefore + 1);
    expect(after.players[0]!.legend.exhausted, "he was not exhausted").toBe(true);
  });

  /** Two FRIENDLY choices are still zero enemy choices. */
  it("is not offered after two friendly choices", () => {
    const twice = shoot(shoot(board(), "mine"), "mine");
    expect(ezrealActions(twice), "friendly choices opened the gate").toHaveLength(0);
  });

  /** An exhausted Ezreal cannot pay, however many choices have been made. */
  it("is not offered while exhausted", () => {
    const twice = shoot(shoot(board(), "foe"), "foe");
    const spent: GameState = {
      ...twice,
      players: [{ ...twice.players[0]!, legend: { ...twice.players[0]!.legend, exhausted: true } }, twice.players[1]!],
    };
    expect(ezrealActions(spent)).toHaveLength(0);
  });
});
