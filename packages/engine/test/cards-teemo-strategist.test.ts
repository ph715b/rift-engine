import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { isHiddenCard } from "../src/engine/hidden.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Teemo - Strategist (OGN-121) — "[Hidden] When I defend, choose an enemy unit
 * here and reveal the top 5 cards of your Main Deck. Deal 1 to that unit for each
 * card with [Hidden] revealed this way, then recycle the revealed cards."
 *
 * **Everything here goes through `submit`.** The trigger fires from the Cleanup
 * that stages a Combat Showdown, which is a place no resolver call can reach:
 * `dispatchEvent({kind: "combatBegan"})` by hand would skip the dispatch hop and
 * pass whether or not the listener is ever consulted in a real game. So each test
 * builds a board, submits the opponent's `MoveUnit` that contests Teemo's
 * battlefield, and asserts on what came back.
 *
 * Every test asserts the Combat Showdown actually opened before it asserts
 * anything about damage — otherwise a fixture that quietly failed to start a
 * fight would read as "the card correctly did nothing".
 */

const registry = defaultCardRegistry();

const TEEMO_STRATEGIST = "OGN-121";
const ANNIE_FIERY = "OGS-001"; // "Your spells and abilities deal 1 Bonus Damage"

/** Cards that really carry `[Hidden]`. */
const HIDDEN_DEF_IDS = ["OGN-083", "OGN-094", "OGN-053", "OGN-057", "OGN-097"];
/** Cards that do not. `OGN-018` Noxus Saboteur is the one that matters: his text
 *  MENTIONS "[Hidden]" without carrying it, so a text-scanning implementation
 *  would count him and still look like it works. */
const NOXUS_SABOTEUR = "OGN-018";
const PLAIN_DEF_IDS = ["OGN-114", "OGN-123", "OGN-116", "OGN-092", NOXUS_SABOTEUR];

const deckCard = (defId: string): CardInstance => createCardInstance(registry.get(defId));

/** Submits `action` and asserts it was ACCEPTED — `submit` answers an illegal
 *  action with an Invalid result rather than throwing, so a test that ignores the
 *  result reads a REFUSED move as "the card did nothing". */
function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Finds the enumerated action matching `match`, failing loudly if the enumerator
 *  never offered it. This is the `tried > 0` gate for this file: if the move is
 *  not on offer nothing is submitted and every later assertion would be vacuous. */
function offered(state: GameState, match: (a: any) => boolean, what: string): unknown {
  const action = legalActions(state).find(match);
  expect(action, `${what} was never enumerated`).toBeDefined();
  return action;
}

const unitAt = (state: GameState, battlefieldId: string, playerId: string, instanceId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId]!.find((u) => u.instanceId === instanceId)!;

const deckIds = (state: GameState, playerIndex: 0 | 1) => state.players[playerIndex]!.deck.map((c) => c.instanceId);

/** p1 (index 0) holds bf1 with Teemo standing on it; p2 (index 1) is the active
 *  player with a body in base, ready to walk in and start the fight. */
function defendingBoard(deckDefIds: string[], attackerMight = 9) {
  const teemo = realUnitInstance(TEEMO_STRATEGIST);
  const attacker = makeUnit({ might: attackerMight, name: "Attacker" });
  const state = makeState({ phase: "Action", activePlayerIndex: 1 });
  state.players[0]!.deck = deckDefIds.map(deckCard);
  state.players[1]!.baseUnits = [attacker];
  state.battlefields[0]!.units = { p1: [teemo] };
  state.battlefields[0]!.controllerId = "p1";
  return { state, teemo, attacker };
}

/** The real path: MoveUnit -> applyContested -> the Cleanup `submit` runs stages
 *  a Combat Showdown -> combatBegan -> Teemo's trigger. */
function walkIn(state: GameState, playerIndex: 0 | 1, destination = "bf1"): GameState {
  const after = accept(
    state,
    offered(
      state,
      (a) => a.type === "MoveUnit" && a.playerIndex === playerIndex && a.destinationBattlefieldId === destination,
      `a move by player ${playerIndex} into ${destination}`,
    ),
  );
  expect(after.turnState, "no Showdown was staged").toBe("Showdown");
  expect(after.showdownKind, "the Showdown was not a Combat").toBe("Combat");
  return after;
}

describe("the fixture's own premises", () => {
  // The whole card is a count of `[Hidden]` cards, so a test whose "hidden" pile
  // is not actually hidden would measure nothing. Asked of the same helper the
  // implementation asks, which is the point: the loader's
  // HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS is what makes the Saboteur answer false.
  it.each(HIDDEN_DEF_IDS)("%s really carries [Hidden]", (defId) => {
    expect(isHiddenCard(registry.tryGet(defId))).toBe(true);
  });

  it.each(PLAIN_DEF_IDS)("%s really does not", (defId) => {
    expect(isHiddenCard(registry.tryGet(defId))).toBe(false);
  });

  it("Noxus Saboteur is the trap: his printed text says [Hidden] and he has not got it", () => {
    const def = registry.get(NOXUS_SABOTEUR);
    expect("text" in def && (def.text as string).includes("[Hidden]")).toBe(true);
    expect(isHiddenCard(def)).toBe(false);
  });
});

describe("Teemo - Strategist (OGN-121): when I defend, deal 1 per [Hidden] revealed", () => {
  it("deals nothing when none of the revealed 5 is [Hidden]", () => {
    const { state, attacker } = defendingBoard(PLAIN_DEF_IDS);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });

  it("deals 1 for a single [Hidden] among the five", () => {
    const { state, attacker } = defendingBoard([HIDDEN_DEF_IDS[0]!, ...PLAIN_DEF_IDS.slice(0, 4)]);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(1);
  });

  it("scales: three [Hidden] among the five deal 3", () => {
    const { state, attacker } = defendingBoard([
      HIDDEN_DEF_IDS[0]!,
      PLAIN_DEF_IDS[0]!,
      HIDDEN_DEF_IDS[1]!,
      PLAIN_DEF_IDS[1]!,
      HIDDEN_DEF_IDS[2]!,
    ]);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(3);
  });

  it("counts all five when every revealed card is [Hidden]", () => {
    const { state, attacker } = defendingBoard(HIDDEN_DEF_IDS);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(5);
  });

  it("reads the DEFINITION, not the text — five Noxus Saboteurs deal nothing", () => {
    // A text scan for "[Hidden]" would deal 5 here. Paired with the run above,
    // where five genuinely hidden cards DO deal 5, so this cannot pass by the
    // trigger simply never firing.
    const { state, attacker } = defendingBoard([NOXUS_SABOTEUR, NOXUS_SABOTEUR, NOXUS_SABOTEUR, NOXUS_SABOTEUR, NOXUS_SABOTEUR]);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });

  it("only ever looks at the top 5 — a sixth [Hidden] card deeper in the deck is not counted", () => {
    const { state, attacker } = defendingBoard([...PLAIN_DEF_IDS, HIDDEN_DEF_IDS[0]!]);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });

  it("kills through the ordinary damage funnel when the count covers the attacker", () => {
    const { state, attacker } = defendingBoard(HIDDEN_DEF_IDS, 5);
    const after = walkIn(state, 1);
    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toEqual([attacker.instanceId]);
  });
});

describe("OGN-121: recycling the revealed cards (416/425)", () => {
  it("puts the revealed five on the BOTTOM in order, and shifts the rest up", () => {
    const { state } = defendingBoard([...HIDDEN_DEF_IDS, ...PLAIN_DEF_IDS.slice(0, 2)]);
    const before = deckIds(state, 0);
    const after = walkIn(state, 1);

    // [r1..r5, x, y] becomes [x, y, r1..r5] — bottom of the corresponding deck,
    // revealed order preserved, and nothing lost or duplicated.
    expect(deckIds(after, 0)).toEqual([before[5], before[6], ...before.slice(0, 5)]);
  });

  it("recycles even when nothing was [Hidden] — the reveal and the recycle are their own instructions", () => {
    const { state } = defendingBoard([...PLAIN_DEF_IDS, "OGN-104", "OGN-108"]);
    const before = deckIds(state, 0);
    const after = walkIn(state, 1);
    expect(deckIds(after, 0)).toEqual([before[5], before[6], ...before.slice(0, 5)]);
  });

  it("a deck shorter than 5 reveals what it has (422) and keeps every card", () => {
    const short = [HIDDEN_DEF_IDS[0]!, PLAIN_DEF_IDS[0]!, HIDDEN_DEF_IDS[1]!];
    const { state, attacker } = defendingBoard(short);
    const before = deckIds(state, 0);
    const after = walkIn(state, 1);

    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(2);
    // Recycling a whole deck is a rotation onto itself, so the assertion worth
    // making is that all three are still there, once each, in order.
    expect(deckIds(after, 0)).toEqual(before);
  });

  it("survives an empty deck: nothing revealed, nothing dealt, nothing thrown", () => {
    const { state, attacker } = defendingBoard([]);
    const after = walkIn(state, 1);
    expect(after.players[0]!.deck).toHaveLength(0);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });
});

describe("OGN-121: 718.5 — no [Hidden] revealed means NO deal action at all", () => {
  /** The same defending board with Annie - Fiery ("your spells and abilities deal
   *  1 Bonus Damage") standing in Teemo's controller's base. */
  function withAnnie(deckDefIds: string[]) {
    const built = defendingBoard(deckDefIds);
    built.state.players[0]!.baseUnits = [realUnitInstance(ANNIE_FIERY) as UnitInstance];
    return built;
  }

  it("deals 0, not 1, with Bonus Damage available and nothing hidden revealed", () => {
    // The rules work this exact card: "If no damage was Dealt, then Bonus Damage
    // will not apply... no deal action is performed for the Bonus Damage to apply
    // to." A `dealDamage(..., 0)` would come out of damage-modifiers.ts as 1.
    const { state, attacker } = withAnnie(PLAIN_DEF_IDS);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(0);
  });

  it("and 2 with one hidden revealed — so the 0 above is the guard, not a dead trigger", () => {
    const { state, attacker } = withAnnie([HIDDEN_DEF_IDS[0]!, ...PLAIN_DEF_IDS.slice(0, 4)]);
    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(2); // 1 + Annie's bonus
  });
});

describe("OGN-121: 'when I DEFEND' — the negative controls", () => {
  it("does NOT fire when Teemo is the ATTACKER", () => {
    // Same fight, mirrored: Teemo walks into an enemy-held battlefield, so
    // `contestedByIndex` (465's own definition of the Attacker) names his own
    // controller and the trigger must stay silent.
    const teemo = realUnitInstance(TEEMO_STRATEGIST);
    const enemy = makeUnit({ might: 9, name: "Holder" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [teemo];
    state.players[0]!.deck = HIDDEN_DEF_IDS.map(deckCard);
    state.battlefields[0]!.units = { p2: [enemy] };
    state.battlefields[0]!.controllerId = "p2";
    const before = deckIds(state, 0);

    const after = walkIn(state, 0);

    // The gate against a vacuous pass: the fight really opened, Teemo really is
    // standing in it, there really is an enemy unit for him to have chosen, and
    // his own controller is the Attacker. Only then is "0 damage" a fact about
    // the card rather than about the fixture.
    expect(after.battlefields[0]!.contestedByIndex).toBe(0);
    expect(unitAt(after, "bf1", "p1", teemo.instanceId)).toBeDefined();
    expect(unitAt(after, "bf1", "p2", enemy.instanceId)).toBeDefined();
    expect(unitAt(after, "bf1", "p2", enemy.instanceId).damage).toBe(0);
    expect(deckIds(after, 0)).toEqual(before); // not even the reveal/recycle half

    // ...and the identical five-hidden deck DOES deal 5 when he defends instead,
    // so this fixture is demonstrably capable of firing the trigger.
    const mirrored = defendingBoard(HIDDEN_DEF_IDS);
    const fired = walkIn(mirrored.state, 1);
    expect(unitAt(fired, "bf1", "p2", mirrored.attacker.instanceId).damage).toBe(5);
  });

  it("does nothing when the combat opens at a battlefield he is not standing at", () => {
    const teemo = realUnitInstance(TEEMO_STRATEGIST);
    const bystander = makeUnit({ might: 4, name: "Bystander" });
    const attacker = makeUnit({ might: 9, name: "Attacker" });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.deck = HIDDEN_DEF_IDS.map(deckCard);
    state.players[1]!.baseUnits = [attacker];
    state.battlefields[0]!.units = { p1: [teemo] };
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.units = { p1: [bystander] };
    state.battlefields[1]!.controllerId = "p1";
    const before = deckIds(state, 0);

    const after = walkIn(state, 1, "bf2");

    expect(after.showdownBattlefieldId).toBe("bf2");
    expect(unitAt(after, "bf2", "p2", attacker.instanceId).damage).toBe(0);
    expect(deckIds(after, 0)).toEqual(before);
  });

  it("is 'an ENEMY unit here' — a friendly unit beside him is never the one damaged", () => {
    const { state, attacker } = defendingBoard(HIDDEN_DEF_IDS);
    const ally = makeUnit({ might: 6, name: "Ally" });
    const teemoAndAlly = state.battlefields[0]!.units["p1"]!;
    state.battlefields[0]!.units = { p1: [...teemoAndAlly, ally] };

    const after = walkIn(state, 1);
    expect(unitAt(after, "bf1", "p1", ally.instanceId).damage).toBe(0);
    expect(unitAt(after, "bf1", "p2", attacker.instanceId).damage).toBe(5);
  });
});

describe("OGN-121: coverage", () => {
  it("is reported as implemented, with nothing partial outstanding", () => {
    // The claim being checked is specifically that `[Hidden]` does not hold the
    // card back: the keyword is real (engine/hidden.ts), so it is absent from
    // coverage.ts's UNIMPLEMENTED_KEYWORDS and the defend trigger is the whole
    // remainder of his text.
    const def = registry.get(TEEMO_STRATEGIST);
    expect(partialImplementationNote(def)).toBeUndefined();
    expect(isCardImplemented(def)).toBe(true);
  });
});
