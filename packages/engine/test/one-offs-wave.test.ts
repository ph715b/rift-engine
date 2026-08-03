import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

const registry = defaultCardRegistry();
const POSSESSION = "OGN-203"; // "Choose an enemy unit at a battlefield. Take control of it and recall it."
const SYMBOL_OF_THE_SOLARI = "OGN-227"; // "If a combat where you are the attacker ends in a tie, recall ALL units instead."
const CLOCKWORK_KEEPER = "OGN-044"; // "You may pay [1 Calm] as an additional cost... if you paid it, draw 1."

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    current = accept(current, legalActions(current).find((a) => a.type === "PassFocus")!);
  }
  return current;
}

describe("Possession (OGN-203): take control of an enemy unit", () => {
  function possessionState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(POSSESSION)];
    state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`c${i}`, "Chaos"));
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "prize", might: 6, buffed: true, damage: 2 })] };
    return state;
  }

  it("moves the unit into the CASTER's base and out of the opponent's list", () => {
    // Control in this engine IS which player's list a unit sits in, so taking it
    // and recalling it are one operation — done separately there would be a state
    // where it belongs to nobody.
    const state = possessionState();
    const settled = resolveChain(accept(state, playsFor(state, POSSESSION)[0]!));

    expect(settled.battlefields[0]!.units["p2"] ?? [], "it is still the opponent's").toHaveLength(0);
    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId), "it did not arrive in the caster's base").toContain("prize");
  });

  it("keeps its buff and its damage — it changes hands, it is not reprinted", () => {
    // 709 removes buffs on LEAVING PLAY, and this never does.
    const state = possessionState();
    const settled = resolveChain(accept(state, playsFor(state, POSSESSION)[0]!));
    const taken = settled.players[0]!.baseUnits.find((u) => u.instanceId === "prize")!;

    expect(taken.buffed).toBe(true);
    expect(taken.damage).toBe(2);
  });

  it("cannot reach a unit in the opponent's BASE — 'at a battlefield' is printed", () => {
    const state = possessionState();
    state.battlefields[0]!.units = {};
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "safe", might: 6 })];

    expect(playsFor(state, POSSESSION), "a base unit was offered as a target").toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(POSSESSION))).toBe(true);
  });
});

describe("Symbol of the Solari (OGN-227): a tie recalls ALL units", () => {
  /**
   * A stalemate: both sides survive the exchange, which is rule 466.5.d's No
   * Result and the branch where 3d recalls the attackers.
   *
   * **Plain units cannot tie**, which took a failed run to see. Outgoing Might
   * and remaining Might are the same number for a vanilla unit, so each side's
   * pool exactly equals its own lethal need — and both surviving would require
   * poolA < poolD and poolD < poolA at once. `[Assault]` and `[Shield]` are what
   * break the symmetry: Assault adds to both of the attacker's numbers, Shield
   * only to the defender's REMAINING. So a 4-Might `[Assault 2]` attacker swings
   * 6 into a 5-Might `[Shield 3]` defender who can absorb 8, and takes 5 back
   * against its own 6. Both live.
   */
  function tie(withGear: boolean): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "attacker", might: 4, keywords: { Assault: 2 } })],
      p2: [makeUnit({ instanceId: "defender", might: 5, keywords: { Shield: 3 } })],
    };
    if (withGear) {
      state.players[0]!.activeGear = [{ ...createCardInstance(registry.get(SYMBOL_OF_THE_SOLARI)), instanceId: "sym" } as GearInstance];
    }
    return state;
  }

  it("sends the DEFENDERS home too, clearing the battlefield", () => {
    // Without it, only the attacker is recalled and the defender keeps the
    // battlefield — which is exactly the failed attack the card is bought to fix.
    const without = resolveShowdown(tie(false), "bf1", 0);
    expect(without.battlefields[0]!.units["p2"] ?? [], "the control already cleared it").toHaveLength(1);

    const withIt = resolveShowdown(tie(true), "bf1", 0);
    expect(withIt.battlefields[0]!.units["p2"] ?? [], "the defenders stayed").toHaveLength(0);
    expect(withIt.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(withIt.players[1]!.baseUnits.map((u) => u.instanceId), "the defender was not recalled home").toContain("defender");
  });

  it("only helps its controller's OWN attacks — 'where YOU are the attacker'", () => {
    // The same board with the gear on the DEFENDING side: it must do nothing.
    const state = tie(false);
    state.players[1]!.activeGear = [
      { ...createCardInstance(registry.get(SYMBOL_OF_THE_SOLARI)), instanceId: "sym" } as GearInstance,
    ];

    const settled = resolveShowdown(state, "bf1", 0);
    expect(settled.battlefields[0]!.units["p2"] ?? [], "the defender's own gear recalled them").toHaveLength(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SYMBOL_OF_THE_SOLARI))).toBe(true);
  });
});

describe("Clockwork Keeper (OGN-044): an optional POWER additional cost", () => {
  function keeperState(runeCount: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [createCardInstance(registry.get(CLOCKWORK_KEEPER))];
    state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`c${i}`, "Calm"));
    state.players[0]!.deck = [makeUnit({ instanceId: "drawn", might: 1 })];
    return state;
  }

  it("offers both a paid and an unpaid variant, priced one Power apart", () => {
    const plays = playsFor(keeperState(6), CLOCKWORK_KEEPER).filter((p) => p.destinationBattlefieldId === undefined);
    const free = plays.find((p) => p.optionalPowerPaid !== true)!;
    const paid = plays.find((p) => p.optionalPowerPaid === true)!;

    expect(free, "the plain variant vanished").toBeDefined();
    expect(paid, "the paid variant was never offered").toBeDefined();
    expect(paid.payment.powerRunes.length - free.payment.powerRunes.length).toBe(1);
  });

  it("draws only when the cost was PAID", () => {
    const unpaidState = keeperState(6);
    const unpaid = accept(unpaidState, playsFor(unpaidState, CLOCKWORK_KEEPER).find((p) => p.optionalPowerPaid !== true)!);
    expect(unpaid.players[0]!.hand, "it drew without paying").toHaveLength(0);

    const paidState = keeperState(6);
    const paid = accept(paidState, playsFor(paidState, CLOCKWORK_KEEPER).find((p) => p.optionalPowerPaid === true)!);
    expect(paid.players[0]!.hand.map((c) => c.instanceId), "paying did not draw").toContain("drawn");
  });

  it("offers only the plain variant when the extra Power is unaffordable", () => {
    // Unaffordable by DOMAIN, not by count — and the first attempt at this test
    // got that wrong. Rule 164.2's double duty means recycling a Ready rune for
    // Power also banks the 1 floating Energy that rune could have paid, so N runes
    // cover any cost with E <= N and P <= N: two runes pay 2 Energy and 2 Energy
    // plus a Power equally well, and "give them fewer runes" can never isolate the
    // option.
    //
    // Fury runes pay the Keeper's 2 Energy perfectly well — Energy has no domain —
    // and cannot pay his Calm Power at all.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [createCardInstance(registry.get(CLOCKWORK_KEEPER))];
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`f${i}`, "Fury"));

    const plays = playsFor(state, CLOCKWORK_KEEPER);
    expect(plays.length, "the card became uncastable entirely").toBeGreaterThan(0);
    expect(plays.some((p) => p.optionalPowerPaid === true), "an unaffordable variant was offered").toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(CLOCKWORK_KEEPER))).toBe(true);
  });
});
