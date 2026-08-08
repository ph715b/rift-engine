import { describe, expect, it } from "vitest";
import {
  combatSpellPowerDiscount,
  modifiedEnergyCost,
  rainbowSurchargeForPlay,
} from "../src/engine/cost-modifiers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Vex - Cheerless (SFD-146) — "While I'm in combat, friendly spells cost
 * [1][rainbow] less to a minimum of [1], and enemy spells cost [1][rainbow]
 * more."
 *
 * Three things here are firsts for this pool and each has its own tests below.
 *
 * **She points both ways.** Every other cost modifier in the engine only ever
 * reduces; this one reduces for one seat and taxes the other from the same
 * sentence. The two halves are not symmetric in implementation either — the
 * discount comes off the card's own domained Power, the tax is a rainbow debt in
 * the `[Deflect]` bucket — so the friendly and enemy cases are exercised
 * separately rather than one being assumed from the other.
 *
 * **"In combat" is a state, not an event.** `combat-designation.isFightingAt`
 * cannot answer it: that predicate takes a `GameEvent`, and a cost is priced with
 * no event in hand. The open Combat Showdown is what survives the whole fight, so
 * the tests set `showdownKind`/`showdownBattlefieldId` and prove that a
 * NonCombat Showdown and a Neutral turn both leave the price alone.
 *
 * **The three cost sites must agree.** The last test enumerates and then
 * validates, which is the only way an offered-then-refused split has ever shown
 * up in this codebase — see deflect-surcharge.test.ts, which exists for the same
 * reason and records three shipped instances.
 */

const registry = defaultCardRegistry();
const VEX_CHEERLESS = "SFD-146";
/** [Action], so it is castable INSIDE a Showdown, which is the only place Vex's
 *  clause can ever apply. 3 Energy and 1 Fury Power, so both axes move. */
const VOID_SEEKER = "OGN-024";

const runes = (domain: Domain, n: number, prefix = domain): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, domain, state: "Ready" as const }));

/**
 * A board with a Combat Showdown open at bf1, `vexFor` holding a Vex there (or
 * neither side when undefined), and player 0 holding Void Seeker with `pool`.
 *
 * The Showdown is built rather than played out, on the same reasoning every
 * combat fixture here uses: the states that matter are `showdownKind`,
 * `showdownBattlefieldId` and who is standing where, and reaching them through
 * real moves would test the move executor instead of this.
 */
function combatBoard(vexFor: 0 | 1 | undefined, pool: RuneCard[] = runes("Fury", 8)): { state: GameState; spellId: string } {
  const spell = spellInstance(VOID_SEEKER);
  const state = makeState({
    phase: "Action",
    turnState: "Showdown",
    showdownKind: "Combat",
    showdownBattlefieldId: "bf1",
    focusHolder: 0,
    players: [makePlayer("p1", { hand: [spell], channeled: pool }), makePlayer("p2")],
  });
  state.battlefields[0]!.contestedByIndex = 0;
  // Somebody has to be standing there for it to be a fight at all, and Void
  // Seeker needs an enemy unit to point at.
  state.battlefields[0]!.units = { p1: [makeUnit({ name: "Bystander" })], p2: [makeUnit({ name: "Target", instanceId: "target" })] };
  if (vexFor !== undefined) {
    const vex = realUnitInstance(VEX_CHEERLESS);
    const seat = vexFor === 0 ? "p1" : "p2";
    state.battlefields[0]!.units[seat] = [...state.battlefields[0]!.units[seat]!, vex];
  }
  return { state, spellId: spell.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

describe("Vex - Cheerless: the friendly half", () => {
  it("takes 1 Energy off her controller's spell while she is in the combat", () => {
    const { state } = combatBoard(0);
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(2);
  });

  it("takes 1 Power off it too — the [rainbow] half of the same sentence", () => {
    const { state } = combatBoard(0);
    expect(combatSpellPowerDiscount(state, 0, "Spell")).toBe(1);
  });

  it("floors the Energy at 1, which is what the card prints", () => {
    const { state } = combatBoard(0);
    expect(modifiedEnergyCost(state, 0, "Spell", 1, VOID_SEEKER)).toBe(1);
  });

  it("never RAISES a spell already priced below the floor", () => {
    // The trap in writing "to a minimum of 1" as a plain `Math.max(1, cost - 1)`:
    // a 0-Energy spell comes out at 1, i.e. the discount made it more expensive.
    // Reachable — Sky Splitter zeroes its own Energy behind a big enough body.
    const { state } = combatBoard(0);
    expect(modifiedEnergyCost(state, 0, "Spell", 0, VOID_SEEKER)).toBe(0);
  });

  it("owes her controller no rainbow surcharge", () => {
    const { state } = combatBoard(0);
    expect(rainbowSurchargeForPlay(state, 0, "Spell", [])).toBe(0);
  });
});

describe("Vex - Cheerless: the enemy half", () => {
  it("adds 1 Energy to the opponent's spell", () => {
    const { state } = combatBoard(0);
    expect(modifiedEnergyCost(state, 1, "Spell", 3, VOID_SEEKER)).toBe(4);
  });

  it("adds 1 RAINBOW Power, not 1 of the spell's own domain", () => {
    // The distinction the implementation turns on. `[1][rainbow]` more is the
    // [Deflect] shape — a debt payable with any rune — and folding it into the
    // card's `powerCost` would demand the spell's printed domain instead, which
    // is stricter than printed and would refuse legal plays.
    const { state } = combatBoard(0);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [])).toBe(1);
    expect(combatSpellPowerDiscount(state, 1, "Spell")).toBe(0);
  });

  it("taxes a spell that CHOOSES nothing — hers is keyed on the board, not on targets", () => {
    // What separates her from [Deflect], and the reason every enumerator branch
    // had to route through the shared surcharge instead of skipping an empty
    // target list.
    const { state } = combatBoard(0);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [undefined])).toBe(1);
  });
});

describe("Vex - Cheerless: when she does NOT apply", () => {
  it("does nothing on a Neutral turn — she has to be in a combat", () => {
    const { state } = combatBoard(0);
    state.turnState = "Neutral";
    state.showdownKind = null;
    state.showdownBattlefieldId = null;
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(3);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [])).toBe(0);
  });

  it("does nothing during a NON-combat Showdown", () => {
    // A Showdown is a window, not a fight (341). Only some are combats, and the
    // card says combat.
    const { state } = combatBoard(0);
    state.showdownKind = "NonCombat";
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(3);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [])).toBe(0);
  });

  it("does nothing while she stands at a DIFFERENT battlefield from the fight", () => {
    const { state } = combatBoard(undefined);
    state.battlefields[1]!.units = { p1: [realUnitInstance(VEX_CHEERLESS)] };
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(3);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [])).toBe(0);
  });

  it("does nothing while she sits in base", () => {
    const { state } = combatBoard(undefined);
    state.players[0]!.baseUnits = [realUnitInstance(VEX_CHEERLESS)];
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(3);
  });

  it("touches SPELLS only — her sentence names them twice and no other kind once", () => {
    const { state } = combatBoard(0);
    expect(modifiedEnergyCost(state, 0, "Unit", 3)).toBe(3);
    expect(modifiedEnergyCost(state, 1, "Gear", 3)).toBe(3);
    expect(combatSpellPowerDiscount(state, 0, "Unit")).toBe(0);
    expect(rainbowSurchargeForPlay(state, 1, "Gear", [])).toBe(0);
  });

  it("cancels when both sides have one in the same fight", () => {
    // Counted as a signed swing rather than a boolean. 817.1.a's redundancy rule
    // reaches keywords, not continuous abilities, so two Vexes are two sources —
    // and pointed at each other they come to nothing.
    const { state } = combatBoard(0);
    const theirs = realUnitInstance(VEX_CHEERLESS);
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, theirs];
    expect(modifiedEnergyCost(state, 0, "Spell", 3, VOID_SEEKER)).toBe(3);
    expect(modifiedEnergyCost(state, 1, "Spell", 3, VOID_SEEKER)).toBe(3);
    expect(rainbowSurchargeForPlay(state, 0, "Spell", [])).toBe(0);
    expect(rainbowSurchargeForPlay(state, 1, "Spell", [])).toBe(0);
  });
});

describe("Vex - Cheerless: the three cost sites agree", () => {
  it("prices the friendly discount into the offered payment", () => {
    // 3 Energy + 1 Fury Power printed, so 4 runes buys it untaxed and 3 buys it
    // under her discount. Enumerating with exactly 3 proves the discount reached
    // the enumerator rather than merely the pricing function.
    const { state, spellId } = combatBoard(0, runes("Fury", 3));
    const plays = playsOf(state, spellId);
    expect(plays.length, "the discounted play was not offered at all").toBeGreaterThan(0);
  });

  it("does NOT offer that play once Vex is on the other side", () => {
    // The mutation. Same board, same 3 runes, Vex swapped seats: the spell now
    // costs 4 Energy and 1 Power plus a rainbow, and 3 runes cannot buy it. If
    // this passed both ways the test above would be proving nothing.
    const { state, spellId } = combatBoard(1, runes("Fury", 3));
    expect(playsOf(state, spellId)).toHaveLength(0);
  });

  it("makes the enemy pay a rainbow rune on top", () => {
    // Player 1 casts into player 0's Vex. Focus has to be theirs to act at all.
    const spell = spellInstance(VOID_SEEKER);
    const { state } = combatBoard(0, []);
    state.focusHolder = 1;
    state.players[1]!.hand = [spell];
    state.players[1]!.channeled = runes("Fury", 8);

    const play = playsOf(state, spell.instanceId)[0];
    expect(play, "the taxed play was not offered").toBeDefined();
    expect(play!.payment.rainbowRunes ?? []).toHaveLength(1);
  });

  it("every offered play is accepted by the validator, on both sides of her", () => {
    // The failure this describe block exists for: one of the three sites pricing
    // differently shows up as an offered-then-refused play, never as a wrong
    // number. Run for BOTH seats, since the two halves take different code paths.
    for (const vexFor of [0, 1] as const) {
      const { state, spellId } = combatBoard(vexFor);
      const plays = playsOf(state, spellId);
      expect(plays.length, `no plays offered with Vex for player ${vexFor}`).toBeGreaterThan(0);
      for (const play of plays) {
        const result = validatePlayCard(state, play);
        expect(result.ok, `${result.ok ? "" : result.error} (Vex for player ${vexFor})`).toBe(true);
      }
    }
  });
});

describe("Vex - Cheerless: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(VEX_CHEERLESS))).toBe(true);
  });
});
