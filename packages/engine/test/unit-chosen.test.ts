import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { holdUnitsChosen } from "../src/engine/triggers.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The `unitChosen` event, and Irelia - Fervent (SFD-057), the card that was
 * waiting on it.
 *
 * # Why it is a second event rather than a widening of the first
 *
 * `battlefield-abilities.holdUnitsChosenBySpell` already existed, and Irelia's
 * own comment named the three reasons it could not be reused: it is keyed to a
 * BATTLEFIELD so it cannot reach a unit listener, it never sees an ABILITY
 * choosing her, and it drops a unit standing in base. The Dreaming Tree wants all
 * three restrictions ("a friendly unit HERE, with a spell"); she wants none.
 *
 * # The moment is ANNOUNCEMENT (355), not resolution
 *
 * Both firing sites are in the `execute-*` action handlers rather than in any
 * resolver, because by the time an effect runs "was it chosen" is unanswerable —
 * the unit may have moved or died while the Spell waited on the chain.
 *
 * # What the tests are shaped around
 *
 * Two DISPATCH HOPS, one per choosing path, each driven through the real
 * `submit` — this repo has five recorded incidents of an action field surviving
 * enumeration and validation and then being dropped on the hop, which is
 * invisible from a direct resolver call.
 */
const IRELIA_FERVENT = "SFD-057"; // "[Deflect] When you choose or ready me, give me +1 Might this turn."
const STAND_UNITED = "OGN-053"; // 3 Energy, no Power — "choose a friendly unit"
const UNLICENSED_ARMORY = "OGN-023"; // Gear: "Discard 1, Exhaust: Choose a friendly unit."
const registry = defaultCardRegistry();

const rune = (id: string): RuneCard => ({ id, domain: "Calm", state: "Ready" });

/** Irelia at bf1 for player 0. `scope` defaults to "battlefield" on both of the
 *  choosing cards below, so base would put her out of reach and prove nothing. */
function board(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance(IRELIA_FERVENT)] } };
  return state;
}

const irelia = (state: GameState) => state.battlefields.flatMap((b) => b.units["p1"] ?? [])[0]!;
const ireliaBonus = (state: GameState) => irelia(state).mightThisTurn;

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes until the chain is empty, so a held trigger actually resolves. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 10 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass!);
  }
  return current;
}

describe("the unitChosen event", () => {
  it("gives Irelia - Fervent +1 Might when her own side chooses her", () => {
    // ONE state, built once: `board()` mints a fresh Irelia each call, so
    // reading her id off a second board would name a unit this one has never
    // heard of — and the trigger would correctly do nothing.
    const state = board();
    const settled = resolveHeldTriggers(holdUnitsChosen(state, 0, [irelia(state).instanceId], true));
    expect(ireliaBonus(settled), "the choose half did not fire").toBe(1);
  });

  it("reads \"YOU choose\" — an opponent choosing her pays nothing", () => {
    // The sentence `[Deflect]` sits alongside rather than in tension with: an
    // opponent may still pay the rainbow to choose her, and she does not grow.
    const state = board();
    const settled = resolveHeldTriggers(holdUnitsChosen(state, 1, [irelia(state).instanceId], true));
    expect(ireliaBonus(settled), "she grew off an ENEMY choosing her").toBe(0);
  });

  it("ignores a choice that named a different unit", () => {
    const state = board();
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "someone-else" })];
    expect(ireliaBonus(resolveHeldTriggers(holdUnitsChosen(state, 0, ["someone-else"], true))), "she grew off another unit's").toBe(0);
  });

  it("is ONE event per choice, so choosing her twice pays twice", () => {
    // A `unitList` spec may legally name the same unit twice, and the rules make
    // those two separate choices. The card caps nothing, so neither does this.
    const state = board();
    const id = irelia(state).instanceId;
    expect(ireliaBonus(resolveHeldTriggers(holdUnitsChosen(state, 0, [id, id], true)))).toBe(2);
  });
});

describe("the two dispatch hops", () => {
  it("fires when a SPELL chooses her, through the real cast path", () => {
    const state = board();
    state.players[0]!.hand = [spellInstance(STAND_UNITED)];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`));

    const play = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === STAND_UNITED && a.targetUnitInstanceId === irelia(state).instanceId,
    );
    expect(play, "Stand United could not be aimed at her — the fixture is wrong").toBeDefined();

    const settled = settle(accept(state, play!));
    // +1 from her trigger. Stand United's own effect BUFFS, which sets `buffed`
    // rather than `mightThisTurn`, so this number is hers alone.
    expect(ireliaBonus(settled), "the spell hop dropped the choice").toBe(1);
  });

  it("fires when an ABILITY chooses her, through the real activate path", () => {
    // The half `holdUnitsChosenBySpell` never covered. Unlicensed Armory prints
    // "Choose a friendly unit" in as many words.
    const state = board();
    state.players[0]!.activeGear = [realGearInstance(UNLICENSED_ARMORY)];
    state.players[0]!.hand = [spellInstance(STAND_UNITED)]; // the discard the cost wants

    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === irelia(state).instanceId,
    );
    expect(activate, "the Armory's ability was not offered against her").toBeDefined();

    const settled = settle(accept(state, activate!));
    expect(ireliaBonus(settled), "the ability hop dropped the choice").toBe(1);
  });
});

describe("coverage", () => {
  it("reports Irelia - Fervent whole, with her partial note gone", () => {
    expect(isCardImplemented(registry.get(IRELIA_FERVENT))).toBe(true);
    expect(partialImplementationNote(registry.get(IRELIA_FERVENT)), "she is still listed as partial").toBeUndefined();
  });
});
