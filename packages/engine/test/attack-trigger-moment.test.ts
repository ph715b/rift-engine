import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * WHEN an Attack Trigger fires, and what it means to be attacking.
 *
 * Rule 383.4.f: Attack Triggers "trigger when a Unit or Player gains the
 * Attacker designation for the first time during a combat", and rule 465's
 * Combat Step 1 is where that designation is handed out — "Units at the
 * Contested Battlefield controlled by the Attacker or Defender gain the Attacker
 * or Defender designation now". So the moment is the COMBAT SHOWDOWN OPENING,
 * which this engine calls `combatBegan`, and NOT the Move that applied Contested.
 *
 * Three consequences, one per describe below, and all three are behaviour changes
 * rather than restatements:
 *
 *  1. The trigger is a Chain Pending Item at the combat, so the move that started
 *     the fight resolves with the ability still waiting and respondable.
 *  2. A unit that never moved gains the Attacker designation too, so a Non-Combat
 *     Showdown promoted to a Combat one by 317.2 fires the triggers of everyone
 *     already standing there.
 *  3. A Non-Combat Showdown has no Attacker designation to gain, so walking into
 *     an EMPTY enemy battlefield is not attacking and fires nothing.
 *
 * `test/cards-attack-triggers.test.ts` covers WHAT each of these cards does; this
 * file is only about when, and against whom.
 */

const registry = defaultCardRegistry();
const ANIVIA = "OGN-148";
const TWISTED_FATE = "OGN-200";
const MASK_OF_FORESIGHT = "OGN-060";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

function moveTo(state: GameState, unit: UnitInstance, battlefieldId = "bf1"): unknown {
  const action = legalActions(state).find(
    (a) =>
      a.type === "MoveUnit" &&
      (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === battlefieldId &&
      ((a as { unitInstanceIds?: string[] }).unitInstanceIds ?? []).includes(unit.instanceId),
  );
  expect(action, `a move of ${unit.name} to ${battlefieldId} was never enumerated`).toBeDefined();
  return action;
}

/** The names of the triggered abilities waiting on the chain — what the chain
 *  viewer shows, and the only evidence that an ability triggered rather than
 *  merely resolved. */
const heldTriggerNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const enemiesAt = (state: GameState, battlefieldId = "bf1") =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units["p2"] ?? [];

/** `attacker` in base, ready to walk into a battlefield p2 holds with `defenders`. */
function attackState(attacker: UnitInstance, defenders: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = [attacker];
  state.battlefields[0]!.units = { p2: defenders };
  state.battlefields[0]!.controllerId = "p2";
  return state;
}

describe("an Attack Trigger is a Pending Item at the combat, not an effect of the move (383.4.f)", () => {
  it("does not resolve during the move that contests the battlefield", () => {
    const anivia = realUnitInstance(ANIVIA);
    const state = attackState(anivia, [makeUnit({ name: "Defender", might: 9 })]);

    const afterMove = accept(state, moveTo(state, anivia));

    // The Showdown is staged and her ability is on the chain, waiting — the whole
    // point of the conversion is that the opponent gets this window.
    expect(afterMove.showdownKind).toBe("Combat");
    expect(enemiesAt(afterMove).map((u) => u.damage), "she dealt her damage inside the move").toEqual([0]);
    expect(heldTriggerNames(afterMove)).toContain(registry.get(ANIVIA).name);
  });

  it("resolves when the chain pops it", () => {
    const anivia = realUnitInstance(ANIVIA);
    const state = attackState(anivia, [makeUnit({ name: "Defender", might: 9 })]);

    const settled = resolveHeldTriggers(accept(state, moveTo(state, anivia)));

    expect(enemiesAt(settled).map((u) => u.damage)).toEqual([3]);
    expect(heldTriggerNames(settled)).toEqual([]);
  });

  it("does NOT fire for the DEFENDER, even once the chain has fully settled", () => {
    // The negative control for the attacker-side filter. It has to settle the
    // chain before asserting: a held trigger that fired wrongly would be sitting
    // as a Pending Item, and a board asserted straight after `submit` looks
    // exactly like one where nothing triggered at all.
    const anivia = realUnitInstance(ANIVIA);
    const raider = makeUnit({ name: "Raider", might: 9 });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.baseUnits = [raider];
    state.battlefields[0]!.units = { p1: [anivia] };
    state.battlefields[0]!.controllerId = "p1";

    const action = legalActions(state).find(
      (a) => a.type === "MoveUnit" && (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === "bf1",
    );
    const settled = resolveHeldTriggers(accept(state, action));

    expect(heldTriggerNames(settled)).toEqual([]);
    expect((settled.battlefields[0]!.units["p2"] ?? []).every((u) => u.damage === 0)).toBe(true);
  });
});

describe("every unit on the attacking side gains the designation, not only the one that moved (465)", () => {
  it("fires for a unit already standing there when 317.2 promotes the Showdown to a Combat", () => {
    // The case the old move-time dispatch could not reach at all: Anivia
    // contested an EMPTY battlefield, so a Non-Combat Showdown opened with
    // nobody to fight. An opponent holding Focus then puts a unit there, and the
    // next Cleanup promotes the window to a Combat — which is the first moment
    // anyone gains the Attacker designation, and Anivia gains it without moving.
    const anivia = realUnitInstance(ANIVIA);
    const state = makeState({
      phase: "Action",
      turnState: "Showdown",
      showdownKind: "NonCombat",
      showdownBattlefieldId: "bf1",
      focusHolder: 0,
    });
    state.battlefields[0]!.units = { p1: [anivia], p2: [makeUnit({ name: "Latecomer", might: 9 })] };
    state.battlefields[0]!.controllerId = "p2";
    state.battlefields[0]!.contestedByIndex = 0;

    const settled = resolveHeldTriggers(state);

    expect(settled.showdownKind).toBe("Combat");
    expect(enemiesAt(settled).map((u) => u.damage)).toEqual([3]);
  });
});

describe("a Non-Combat Showdown hands out no designations, so nobody attacks", () => {
  it("fires nothing when a unit walks into an EMPTY enemy battlefield", () => {
    // Twisted Fate is the card that can show this: his trigger rotates the top
    // rune whether or not there is anything to hit, so "did he attack?" is
    // answerable on a battlefield with no defenders at all. Under move-time
    // dispatch he attacked an empty field and burned a rune for it.
    const tf = realUnitInstance(TWISTED_FATE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [tf];
    state.players[0]!.runeDeck = [
      { id: "r1", domain: "Mind", state: "Ready" } as never,
      { id: "r2", domain: "Calm", state: "Ready" } as never,
    ];
    state.players[0]!.deck = [makeUnit({ name: "Not drawn" })];
    state.battlefields[0]!.controllerId = "p2";

    const settled = resolveHeldTriggers(accept(state, moveTo(state, tf)));

    expect(settled.showdownKind).toBe("NonCombat");
    expect(settled.players[0]!.runeDeck.map((r) => r.id), "he revealed a rune with nobody to attack").toEqual(["r1", "r2"]);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });
});

describe("Mask of Foresight (OGN-060) is held too, and remembers who was alone", () => {
  /** Mask in play for p1, with `mine` units of theirs at bf1 opposite one enemy,
   *  contested by the enemy so the next Cleanup stages a Combat Showdown. */
  function maskState(mine: number): GameState {
    const mask = createCardInstance(registry.get(MASK_OF_FORESIGHT)) as GearInstance;
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [mask];
    state.battlefields[0]!.units = {
      p1: Array.from({ length: mine }, (_, i) => makeUnit({ name: `Mine${i}`, might: 3 })),
      p2: [makeUnit({ name: "Enemy", might: 3 })],
    };
    state.battlefields[0]!.contestedByIndex = 1;
    return state;
  }

  const mightOf = (state: GameState, name: string) =>
    (state.battlefields[0]!.units["p1"] ?? []).find((u) => u.name === name)?.mightThisTurn;

  it("waits on the chain rather than buffing inside the Cleanup that stages the combat", () => {
    const staged = runCleanup(maskState(1));

    expect(staged.showdownKind).toBe("Combat");
    expect(mightOf(staged, "Mine0"), "the gear resolved inline").toBe(0);
    expect(heldTriggerNames(staged)).toContain(registry.get(MASK_OF_FORESIGHT).name);
    expect(mightOf(resolveHeldTriggers(staged), "Mine0")).toBe(1);
  });

  it("buffs the unit that WAS alone, not whoever stands first when it resolves", () => {
    // "Alone" is a fire-time condition (383 fixes triggering at the moment of the
    // event), so the unit is captured then and the ability is about THAT unit.
    //
    // The discriminating case is the one where the two answers come apart: the
    // unit that was alone is killed during the response window and a different
    // one arrives. A resolver that re-derived "my only unit here" would find the
    // newcomer and buff it — an ability paying out for a unit it never triggered
    // for. Merely ADDING a second unit does not distinguish them, because the
    // newcomer is appended and the re-derived first entry is still the right one:
    // that version of this test passed against the broken resolver.
    //
    // Proved by mutation: replacing the `captured` read with a fresh battlefield
    // lookup fails this and only this.
    // TWO replacements, not one, and that is what makes the test unconfounded.
    // A single newcomer arriving at a running combat gains its own designation
    // (465 Step 1) and is then its controller's only unit there — so it triggers
    // the gear legitimately and ends on +1 whether the original entry captured or
    // re-derived. With two, "alone" is false for both, so the only thing that
    // could buff either is the ORIGINAL entry re-deriving `mine[0]`.
    const staged = runCleanup(maskState(1));
    const replaced = {
      ...staged,
      battlefields: staged.battlefields.map((bf, i) =>
        i === 0
          ? { ...bf, units: { ...bf.units, p1: [makeUnit({ name: "Latecomer", might: 3 }), makeUnit({ name: "Latecomer2", might: 3 })] } }
          : bf,
      ),
    };

    const settled = resolveHeldTriggers(replaced);

    expect(mightOf(settled, "Mine0"), "the unit it triggered for is gone, so nothing should carry the buff").toBeUndefined();
    expect(mightOf(settled, "Latecomer")).toBe(0);
    expect(mightOf(settled, "Latecomer2")).toBe(0);
  });

  it("still buffs the one that was alone when a reinforcement joins it", () => {
    // The other half, and the reason this is a capture rather than a re-check:
    // "alone" stopped being true, and the ability pays out anyway.
    const staged = runCleanup(maskState(1));
    const reinforced = {
      ...staged,
      battlefields: staged.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { ...bf.units, p1: [...(bf.units["p1"] ?? []), makeUnit({ name: "Latecomer", might: 3 })] } } : bf,
      ),
    };

    const settled = resolveHeldTriggers(reinforced);

    expect(mightOf(settled, "Mine0")).toBe(1);
    expect(mightOf(settled, "Latecomer")).toBe(0);
  });
});
