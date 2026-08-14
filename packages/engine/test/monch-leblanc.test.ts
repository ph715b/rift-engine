import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Two cards whose refusals were one small edit each, in files I already knew.**
 *
 *   - **Monch (UNL-035)** — "If an opponent controls a stunned unit, I cost [2]
 *     less and enter ready." Two halves in two files, and BOTH are needed: a
 *     discount without the enter-ready is half the card, and the reverse is the
 *     other half. They ask one shared predicate so they cannot disagree.
 *   - **LeBlanc - Everywhere At Once (UNL-090)** — "Your [Temporary] effects at
 *     my battlefield don't happen." One branch inside the sweep, and the sweep
 *     had to stop flattening the board: it now knows which battlefield each
 *     doomed unit stands at.
 */

const registry = defaultCardRegistry();
const MONCH = "UNL-035";
const LEBLANC = "UNL-090";
const MONCH_PRINTED_ENERGY = 6;
const MONCH_DISCOUNT = 2;
/** Petricite Monument — a [Temporary] GEAR is not what LeBlanc shelters, so the
 *  fixtures below use a unit granted the keyword instead. */
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const temporary = (instanceId: string): UnitInstance =>
  makeUnit({ instanceId, name: instanceId, might: 2, keywords: { Temporary: 1 } });

describe("Monch (UNL-035): both halves, off one condition", () => {
  /** An opponent unit that is or is not stunned. */
  function board(stunned: boolean): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "foe", name: "Foe", might: 3, stunned })];
    state.players[0]!.hand = [realUnitInstance(MONCH)];
    state.players[0]!.floatingEnergy = 12;
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`r${i}`, "Calm"));
    return state;
  }

  it("costs 2 less while the opponent has a stunned unit", () => {
    expect(modifiedEnergyCost(board(true), 0, "Unit", MONCH_PRINTED_ENERGY, MONCH), "the discount never applied").toBe(
      MONCH_PRINTED_ENERGY - MONCH_DISCOUNT,
    );
  });

  it("...and its printed cost when nothing is stunned — the control", () => {
    expect(modifiedEnergyCost(board(false), 0, "Unit", MONCH_PRINTED_ENERGY, MONCH), "he was discounted anyway").toBe(
      MONCH_PRINTED_ENERGY,
    );
  });

  it("enters READY on the same condition, and exhausted without it", () => {
    // The half that would be silently missing if only the price were written.
    // Both readings come from one predicate, so a discounted Monch can never
    // arrive exhausted.
    const play = (state: GameState) => {
      const action = legalActions(state).find(
        (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === MONCH,
      );
      expect(action, "Monch was not playable").toBeDefined();
      const after = resolveHeldTriggers(submit(state, action!).state);
      return after.players[0]!.baseUnits.find((u) => u.defId === MONCH)!;
    };

    expect(play(board(true)).exhausted, "he arrived exhausted beside a stunned enemy").toBe(false);
    expect(play(board(false)).exhausted, "he arrived ready with nothing stunned").toBe(true);
  });

  it("reads the OPPONENT's units, not the caster's own", () => {
    // "An OPPONENT controls" — a stunned unit of the caster's own must not
    // discount him, which a walk over both boards would get wrong.
    const state = board(false);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine", might: 3, stunned: true })];

    expect(modifiedEnergyCost(state, 0, "Unit", MONCH_PRINTED_ENERGY, MONCH), "his own stunned unit paid him").toBe(
      MONCH_PRINTED_ENERGY,
    );
  });
});

describe("LeBlanc (UNL-090): [Temporary] effects at her battlefield don't happen", () => {
  /** Player 0's Beginning Phase, with `atBf1` and `atBf2` on their side. */
  function board(atBf1: UnitInstance[], atBf2: UnitInstance[]): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: atBf1 } };
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: atBf2 } };
    return state;
  }

  const survives = (state: GameState, id: string): boolean =>
    state.battlefields.some((bf) => Object.values(bf.units).flat().some((u) => u.instanceId === id));

  it("spares a Temporary unit standing WITH her, and kills one elsewhere", () => {
    // Both halves off one board, so "it survived" cannot be a sweep that did
    // nothing at all.
    const state = board([realUnitInstance(LEBLANC), temporary("sheltered")], [temporary("exposed")]);
    const after = runBeginning(state);

    expect(survives(after, "sheltered"), "her battlefield did not shelter it").toBe(true);
    expect(survives(after, "exposed"), "the sweep stopped killing anything at all").toBe(false);
  });

  it("does NOT shelter a Temporary unit in BASE — a base is not a battlefield", () => {
    // 198.1. She names a battlefield, and her controller's base is not one.
    const state = board([realUnitInstance(LEBLANC)], []);
    state.players[0]!.baseUnits = [temporary("homebody")];

    const after = runBeginning(state);
    expect(
      after.players[0]!.baseUnits.some((u) => u.instanceId === "homebody"),
      "a base unit was sheltered by a battlefield clause",
    ).toBe(false);
  });

  it("shelters her OWN controller's units — 'YOUR [Temporary] effects'", () => {
    // The sweep runs per controller, so this falls out; asserted because a
    // shelter keyed on the battlefield rather than the side would spare the
    // opponent's Temporary units too, on their own turn.
    const state = board([realUnitInstance(LEBLANC), temporary("mine")], []);
    expect(survives(runBeginning(state), "mine"), "her own side was not sheltered").toBe(true);
  });

  it("without her, the same unit dies — the control", () => {
    const state = board([temporary("sheltered")], []);
    expect(survives(runBeginning(state), "sheltered"), "the unit survived with no LeBlanc present").toBe(false);
  });
});

describe("coverage", () => {
  it("both cards are whole, with no partial note left", () => {
    for (const id of [MONCH, LEBLANC]) {
      expect(isCardImplemented(registry.get(id)), `${id} is greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(id)), `${id} still names a missing half`).toBeUndefined();
    }
  });
});
