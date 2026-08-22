import { describe, expect, it } from "vitest";
import { clearContested, runCleanup } from "../src/engine/cleanup.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { BattlefieldState, GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * 464.2.c Step 1's second sentence: "If a Unit controlled by the Attacker or Defender
 * becomes present at this Battlefield AFTER this moment, it will gain the
 * Attacker or Defender designation during the Cleanup phase following the action
 * that caused it to become present."
 *
 * With 383.4.e — an Attack Trigger fires when its unit gains the designation "for
 * the first time during a combat" — that makes a reinforcement's attack trigger
 * fire a Cleanup after it arrives, and makes "for the first time" a real
 * constraint rather than a turn of phrase: the units already designated must not
 * fire again when the next one walks in.
 *
 * So `combatBegan` carries WHICH units are gaining a designation at this moment,
 * and the battlefield remembers who has already been designated for as long as
 * the combat lasts.
 */

const registry = defaultCardRegistry();
const ANIVIA_PRIMAL = "OGN-148"; // when I attack, deal 3 to all enemy units here

const chainNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

/**
 * bf1 CONTESTED by p1 with `p1Units` there, ready for the next Cleanup to stage
 * the Combat Showdown.
 *
 * Neutral rather than mid-Showdown: `stageShowdowns` opens a combat only from a
 * Neutral state, so a fixture that hands it a Showdown already in progress never
 * fires `combatBegan` at all — which the first version of this file did, and its
 * own setup assertion is what caught it.
 */
function contestedState(p1Units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.controllerId = "p2";
  state.battlefields[0]!.contestedByIndex = 0;
  state.battlefields[0]!.units = { p1: p1Units, p2: [makeUnit({ name: "Defender", might: 9 })] };
  return state;
}

/** Puts `unit` at bf1 for p1 — a reinforcement arriving mid-combat. */
function reinforce(state: GameState, unit: UnitInstance): GameState {
  return {
    ...state,
    battlefields: state.battlefields.map(
      (bf, i): BattlefieldState => (i === 0 ? { ...bf, units: { ...bf.units, p1: [...(bf.units["p1"] ?? []), unit] } } : bf),
    ),
  };
}

describe("a unit arriving mid-combat gains the designation at the next Cleanup", () => {
  it("fires the newcomer's Attack Trigger", () => {
    // Anivia walks into a fight already in progress. She gains the Attacker
    // designation in the Cleanup after she arrives, and that is when she attacks.
    const opened = runCleanup(contestedState([makeUnit({ name: "Vanguard", might: 4 })]));
    const anivia = realUnitInstance(ANIVIA_PRIMAL);

    const settled = resolveHeldTriggers(reinforce(opened, anivia));

    expect((settled.battlefields[0]!.units["p2"] ?? []).map((u) => u.damage), "the reinforcement never attacked").toEqual([3]);
  });

  it("does NOT re-fire a unit already designated — '<b>for the first time</b> during a combat'", () => {
    // Anivia is there from the start, so she attacks once as the combat opens. A
    // plain reinforcement then arrives; the Cleanup that designates IT must not
    // designate her again, or she deals another 3.
    const anivia = realUnitInstance(ANIVIA_PRIMAL);
    const opened = resolveHeldTriggers(contestedState([anivia]));
    expect((opened.battlefields[0]!.units["p2"] ?? []).map((u) => u.damage), "she did not attack at the opening").toEqual([3]);

    const settled = resolveHeldTriggers(reinforce(opened, makeUnit({ name: "Latecomer", might: 4 })));

    expect((settled.battlefields[0]!.units["p2"] ?? []).map((u) => u.damage), "she attacked twice in one combat").toEqual([3]);
  });

  it("places nothing when the arrival has no trigger", () => {
    const opened = runCleanup(contestedState([makeUnit({ name: "Vanguard", might: 4 })]));

    const after = runCleanup(reinforce(opened, makeUnit({ name: "Plain", might: 4 })));

    expect(chainNames(after)).toEqual([]);
  });

  it("attacks AGAIN in a SECOND combat at the same battlefield", () => {
    // **The other half of "for the first time during a combat", and the direction
    // that fails silently.** The record `designatedInstanceIds` makes that clause
    // enforceable belongs to one combat, not to the battlefield — so
    // `clearContested` empties it when a Showdown closes. If it did not, every
    // unit still standing here would read as long-since-designated in the NEXT
    // fight and its attack trigger would never fire again, for the rest of the
    // game, with nothing on screen to say why.
    //
    // Written after a playtest report of a trigger not firing sent me looking at
    // this record. That report turned out to be something else and this invariant
    // was already correct — but it was correct and UNPINNED, resting on one line
    // inside a function whose stated job is clearing Contested rather than
    // clearing designations.
    const anivia = realUnitInstance(ANIVIA_PRIMAL);
    const first = resolveHeldTriggers(contestedState([anivia]));
    expect((first.battlefields[0]!.units["p2"] ?? []).map((u) => u.damage), "she did not attack the first time").toEqual([3]);

    // The combat closes the way combat.ts closes one, and a fresh one is staged
    // by contesting the battlefield again.
    const closed: GameState = {
      ...clearContested(first, "bf1"),
      turnState: "Neutral",
      chainOpen: true,
      showdownKind: null,
      showdownBattlefieldId: null,
    };
    expect(
      closed.battlefields[0]!.designatedInstanceIds ?? [],
      "the closing combat left its designation record behind",
    ).toEqual([]);

    const restaged: GameState = {
      ...closed,
      battlefields: closed.battlefields.map((bf, i) => (i === 0 ? { ...bf, contestedByIndex: 0 as const } : bf)),
    };
    const second = resolveHeldTriggers(restaged);

    // 3 from the first combat plus 3 from the second. A unit that stayed put is
    // attacking for the first time in THIS combat, which is what the rule says.
    expect(
      (second.battlefields[0]!.units["p2"] ?? []).map((u) => u.damage),
      "she never attacked again — the designation record outlived its combat",
    ).toEqual([6]);
  });
});
