import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { CardInstance, GearInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { controlsEndlessRiches } from "../src/engine/board-restrictions.js";
import { mayPlayFromTrash } from "../src/engine/timing.js";
import { runDraw } from "../src/engine/turn-manager.js";
import { destroyUnit, discardCards, burn, fileIntoTrash } from "../src/engine/effect-helpers.js";
import { killGear } from "../src/engine/triggers.js";
import { playCardIgnoringCost } from "../src/engine/play-free.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import {
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";
import { holdSelfTrigger } from "../src/engine/triggers.js";

/**
 * **Endless Riches (VEN-022)** — "When you play this, banish your hand and trash,
 * then [Burn 7]. Skip your Draw Phase. You may play cards from your trash. If a
 * card would go to your trash from anywhere other than your Main Deck, banish it
 * instead."
 *
 * Four clauses, and only the first is card work. The other three are engine
 * seams, which is why this card was refused twice and left for its own change —
 * the pin in `ven-fury-wave2.test.ts` recorded exactly that and has now been
 * inverted.
 *
 * # The card is a LOOP, and the tests are shaped around it
 *
 * The four clauses only make sense together: the opening banish empties both
 * private zones, the Burn refills the trash FROM THE DECK (the one source clause
 * four exempts), clause three turns that trash into a hand, and clause four stops
 * anything else ever accumulating there. So the assertions come in pairs — what
 * the clause does, and the exemption or boundary that keeps the loop from eating
 * itself.
 *
 * # The one thing that could quietly be wrong
 *
 * "Banish it instead" replaces the RESTING PLACE, not the event. A unit under
 * Endless Riches still DIES: its `[Deathknell]` fires and `unitsLostThisTurn`
 * counts it. That is a different replacement from UNL-007 Smite's "if it would
 * die this turn, banish it instead", which replaces the death itself — and
 * getting the two the same way round is the whole risk in this card. It is
 * asserted directly rather than left to the funnel's placement.
 */

const registry = defaultCardRegistry();
const ENDLESS_RICHES = "VEN-022";
/** A plain 1-Energy [Action] spell, for the trash-permission tests. */
const CLEAVE = "OGN-004";
/** A plain 2-Energy Fury unit, for the trash-permission tests that need a UNIT —
 *  a Last Rites charge permits units only, so telling the two permissions apart
 *  needs a card both of them could reach. */
const CHEMTECH_ENFORCER = "OGN-003";

const gear = (): GearInstance => realGearInstance(ENDLESS_RICHES);

/** p1 holds the Gear in play. Nothing else is assumed — each test builds the one
 *  zone it is about. */
function board(withGear = true): { state: GameState; riches: GearInstance } {
  const state = makeState();
  const riches = gear();
  if (withGear) state.players[0]!.activeGear = [riches];
  return { state, riches };
}

/** Every card id in a player's two private zones, so a test can say where
 *  something came to rest without caring about instance identity. */
const zonesOf = (state: GameState, index: 0 | 1) => ({
  trash: state.players[index]!.trash.map((c) => c.defId),
  banished: state.players[index]!.banished.map((c) => c.defId),
});

describe("Endless Riches (VEN-022) — presence", () => {
  it("counts as implemented", () => {
    expect(isCardImplemented(registry.get(ENDLESS_RICHES))).toBe(true);
  });

  it("is read off ACTIVE GEAR, not off a hand or a trash", () => {
    // All three continuous clauses hang off this one predicate, so a Gear that
    // answered it from the wrong zone would switch on three rules at once.
    const { state } = board();
    expect(controlsEndlessRiches(state, 0)).toBe(true);
    expect(controlsEndlessRiches(state, 1), "the opponent's side answered true").toBe(false);

    const inHand = makeState();
    inHand.players[0]!.hand = [gear()];
    expect(controlsEndlessRiches(inHand, 0), "a Gear in hand was in play").toBe(false);

    const inTrash = makeState();
    inTrash.players[0]!.trash = [gear()];
    expect(controlsEndlessRiches(inTrash, 0), "a Gear in the trash was in play").toBe(false);
  });
});

describe("Endless Riches — 'banish your hand and trash, then [Burn 7]'", () => {
  /** Plays the Gear the way the engine does — the `played` self trigger — with a
   *  deck deep enough for the Burn. */
  function played(deckSize: number): { before: GameState; after: GameState; riches: GearInstance } {
    const state = makeState();
    const riches = gear();
    state.players[0]!.activeGear = [riches];
    state.players[0]!.hand = [spellInstance(CLEAVE), spellInstance(CLEAVE)];
    state.players[0]!.trash = [spellInstance("OGN-183")];
    state.players[0]!.deck = Array.from({ length: deckSize }, () => spellInstance("OGN-046"));
    return { before: state, after: resolveHeldTriggers(holdSelfTrigger(state, "played", riches, 0)), riches };
  }

  it("empties BOTH private zones and burns 7 from the deck", () => {
    const { after } = played(20);

    expect(after.players[0]!.hand, "the hand survived").toEqual([]);
    // The trash is not empty — it holds exactly the seven burned cards, which is
    // the whole point of the order. The two banished hand cards and the one
    // banished old trash card are elsewhere.
    expect(after.players[0]!.trash, "the burn did not refill the trash").toHaveLength(7);
    expect(after.players[0]!.deck, "the burn took the wrong number").toHaveLength(13);
    expect(after.players[0]!.banished.map((c) => c.defId).sort()).toEqual(["OGN-004", "OGN-004", "OGN-183"]);
  });

  it("burns FROM THE DECK, which is the source its own fourth clause exempts", () => {
    // The interaction that makes the card an engine rather than a blank. If the
    // Burn were replaced by the Gear's own trash-banish, this would be 0.
    const { after } = played(20);
    expect(after.players[0]!.trash, "the Gear banished its own fuel").toHaveLength(7);
  });

  it("does not banish ITSELF — it is in play by the time this fires", () => {
    const { after, riches } = played(20);
    expect(after.players[0]!.activeGear.map((g) => g.instanceId)).toContain(riches.instanceId);
  });

  it("survives a deck shorter than the Burn — 440.4's burn out, then burn the rest", () => {
    // Three cards and a Burn 7. 440.4 burns what is there, Burns Out, and burns
    // the rest — and `burnOut` moves the trash back into the DECK, which is not a
    // trash write, so this Gear's replacement never sees it. The three cards
    // therefore cycle rather than draining away, which is what makes the card's
    // loop stable rather than self-limiting.
    const { after } = played(3);

    const alive = after.players[0]!.deck.length + after.players[0]!.trash.length;
    expect(alive, "the burn out leaked cards out of the cycle").toBe(3);
    // ...and the three banished cards are the hand and old trash, not any of these.
    expect(after.players[0]!.banished).toHaveLength(3);
  });
});

describe("Endless Riches — 'Skip your Draw Phase'", () => {
  const drawPhase = (state: GameState): GameState => ({ ...state, phase: "Draw" });

  it("skips the draw for its controller", () => {
    const { state } = board();
    state.players[0]!.deck = [spellInstance(CLEAVE), spellInstance(CLEAVE)];

    const after = runDraw(drawPhase(state));

    expect(after.players[0]!.hand, "a card was drawn anyway").toEqual([]);
    expect(after.players[0]!.deck, "the deck moved").toHaveLength(2);
    // The PHASE still happened — only the draw was skipped.
    expect(after.phase).toBe("Action");
  });

  it("...and only for its controller — the CONTROL", () => {
    // Without this the test above would pass on a `runDraw` that never drew.
    const { state } = board(false);
    state.players[0]!.deck = [spellInstance(CLEAVE), spellInstance(CLEAVE)];

    const after = runDraw(drawPhase(state));
    expect(after.players[0]!.hand, "the control drew nothing either").toHaveLength(1);
  });

  it("leaves the OPPONENT's draw alone", () => {
    const { state } = board();
    const p2Turn = { ...drawPhase(state), activePlayerIndex: 1 as const };
    p2Turn.players[1]!.deck = [spellInstance(CLEAVE)];

    expect(runDraw(p2Turn).players[1]!.hand, "the enemy Gear stopped their draw").toHaveLength(1);
  });

  it("skips the Burn Out an empty deck would have caused (431)", () => {
    // A card bought to survive an empty deck must not lose to one. `drawCards` is
    // the funnel that burns you out, so not calling it is the whole of it.
    const { state } = board();
    state.players[0]!.deck = [];
    state.players[0]!.trash = [spellInstance(CLEAVE)];

    const after = runDraw(drawPhase(state));
    expect(after.players[0]!.trash, "an empty deck burned out through the skipped draw").toHaveLength(1);
  });
});

describe("Endless Riches — 'You may play cards from your trash'", () => {
  it("permits ANY card kind, at the printed price", () => {
    const { state } = board();
    const spell = spellInstance(CLEAVE);
    const unit = realUnitInstance(CHEMTECH_ENFORCER);
    state.players[0]!.trash = [spell, unit];

    // A Spell, which Last Rites' charge never permitted — the axis that makes
    // this a third permission rather than a wider second one.
    expect(mayPlayFromTrash(state, 0, spell), "a trash SPELL was not permitted").toBe(true);
    expect(mayPlayFromTrash(state, 0, unit)).toBe(true);
  });

  it("permits nothing without the Gear — the CONTROL", () => {
    const { state } = board(false);
    const spell = spellInstance(CLEAVE);
    state.players[0]!.trash = [spell];

    expect(mayPlayFromTrash(state, 0, spell)).toBe(false);
  });

  it("permits only cards actually IN that trash", () => {
    // The permission is about a zone, so a card in hand must not acquire it.
    const { state } = board();
    const inHand = spellInstance(CLEAVE);
    state.players[0]!.hand = [inHand];
    state.players[0]!.trash = [];

    expect(mayPlayFromTrash(state, 0, inHand), "a card in hand was 'in the trash'").toBe(false);
  });

  it("binds to its own side", () => {
    const { state } = board();
    const enemySpell = spellInstance(CLEAVE);
    state.players[1]!.trash = [enemySpell];

    expect(mayPlayFromTrash(state, 1, enemySpell), "the opponent got the permission").toBe(false);
  });

  it("is PLAYABLE end to end, not merely permitted", () => {
    // The half a predicate test cannot reach. `mayPlayFromTrash` says the zone is
    // allowed; `printedPriceAvailable` says the card can be PAID for there, and
    // those are different questions asked at different sites. The first draft of
    // this card passed every predicate assertion above while the enumerator
    // silently dropped the card as unpriceable — permitted, then refused, which is
    // this codebase's offered-then-refused class with its halves swapped.
    const { state } = board();
    state.players[0]!.trash = [spellInstance(CLEAVE)];
    state.players[0]!.channeled = [
      { id: "r1", domain: "Fury", state: "Ready" },
      { id: "r2", domain: "Fury", state: "Ready" },
    ] as never;
    state.battlefields[0]!.units = { p1: [makeUnit()] };

    const offered = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === CLEAVE);
    expect(offered, "the trash spell was never offered").toBeDefined();

    const { result, state: after } = submit(state, offered!);
    expect(result, "the validator refused what the enumerator offered").toMatchObject({ type: "Ok" });
    expect(after.players[0]!.trash.map((c) => c.defId), "it was played but never left the trash").not.toContain(
      CLEAVE,
    );
  });

  it("does NOT spend a banked Last Rites charge — the board already permits it", () => {
    // 372 leaves the choice of replacement to the controller, and a player with a
    // permanent permission would never choose to burn a one-shot charge. Both
    // predicates are true at once here, which is the only state that can tell the
    // two apart.
    const { state } = board();
    const unit = realUnitInstance(CHEMTECH_ENFORCER);
    state.players[0]!.trash = [unit];
    state.players[0]!.trashUnitPlaysThisTurn = 1;
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`,
      domain: "Fury",
      state: "Ready",
    })) as never;

    const offered = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === CHEMTECH_ENFORCER);
    expect(offered, "the trash unit was never offered").toBeDefined();

    const { state: after } = submit(state, offered!);
    expect(after.players[0]!.trashUnitPlaysThisTurn, "the charge was burnt anyway").toBe(1);
  });

  it("the ENUMERATOR offers the trash card, which is what makes it playable", () => {
    // The permission is only worth anything if `legal-actions` acts on it — the
    // enumerator and the gate reading the same predicate is what this repo's
    // offered-then-refused class is about.
    const { state } = board();
    state.players[0]!.trash = [spellInstance(CLEAVE)];
    state.players[0]!.channeled = [
      { id: "r1", domain: "Fury", state: "Ready" },
      { id: "r2", domain: "Fury", state: "Ready" },
    ] as never;
    state.battlefields[0]!.units = { p1: [makeUnit()] };

    const offered = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === CLEAVE);
    expect(offered.length, "the trash spell was never offered").toBeGreaterThan(0);
  });
});

describe("Endless Riches — 'banish it instead' replaces the RESTING PLACE", () => {
  it("banishes a dying unit — but it still DIED", () => {
    // The distinction that is the whole risk in this card. Smite's "if it would
    // die, banish it instead" replaces the death; this replaces only where the
    // card comes to rest, so everything downstream of the death still happens.
    const { state } = board();
    const victim = makeUnit();
    state.battlefields[0]!.units = { p1: [victim] };

    const after = destroyUnit(state, victim.instanceId, 1);

    expect(after.players[0]!.trash, "it rested in the trash").toEqual([]);
    expect(after.players[0]!.banished.map((c) => c.instanceId)).toContain(victim.instanceId);
    // ...and the death happened.
    expect(after.players[0]!.unitsLostThisTurn, "the death was replaced, not just the zone").toBe(1);
  });

  it("...and WITHOUT the Gear the same unit rests in the trash — the CONTROL", () => {
    const { state } = board(false);
    const victim = makeUnit();
    state.battlefields[0]!.units = { p1: [victim] };

    const after = destroyUnit(state, victim.instanceId, 1);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(victim.instanceId);
    expect(after.players[0]!.banished).toEqual([]);
  });

  it("banishes a DISCARD, and the discard still happened", () => {
    const { state } = board();
    const card = spellInstance(CLEAVE);
    state.players[0]!.hand = [card];

    const after = discardCards(state, 0, 1, [card.instanceId]);

    expect(zonesOf(after, 0)).toEqual({ trash: [], banished: [CLEAVE] });
    expect(after.players[0]!.discardedThisTurn, "the discard itself was replaced").toBe(true);
  });

  it("banishes a dying GEAR, including the Gear itself", () => {
    // Its own death is the one self-referential case: the ability is still in
    // play as the event it ends is replaced.
    const { state, riches } = board();

    const after = resolveHeldTriggers(killGear(state, riches, 0));

    expect(after.players[0]!.activeGear).toEqual([]);
    expect(zonesOf(after, 0)).toEqual({ trash: [], banished: [ENDLESS_RICHES] });
  });

  it("banishes a spell played for free, so it cannot be replayed next turn", () => {
    const { state } = board();

    const after = playCardIgnoringCost(state, 0, spellInstance(CLEAVE));

    expect(zonesOf(after, 0), "the spell returned to the trash it came from").toEqual({
      trash: [],
      banished: [CLEAVE],
    });
  });

  it("does NOT touch a Burn — the Main Deck exemption, which is the card's fuel", () => {
    const { state } = board();
    state.players[0]!.deck = [spellInstance(CLEAVE), spellInstance(CLEAVE)];

    const after = burn(state, 0, 2);

    expect(zonesOf(after, 0), "the Gear banished its own fuel").toEqual({
      trash: [CLEAVE, CLEAVE],
      banished: [],
    });
  });

  it("leaves the OPPONENT's trash alone", () => {
    const { state } = board();
    const theirs = makeUnit();
    state.battlefields[0]!.units = { p2: [theirs] };

    const after = destroyUnit(state, theirs.instanceId, 0);

    expect(after.players[1]!.trash.map((c) => c.instanceId), "the enemy's card was banished too").toContain(
      theirs.instanceId,
    );
  });
});

describe("Endless Riches — the funnel itself", () => {
  it("still drops TOKENS on both branches (186.1)", () => {
    // A token ceases to exist wherever it was bound for, so the replacement must
    // not turn a vanished token into a banished one.
    const { state } = board();
    const token = { ...makeUnit(), isToken: true } as unknown as CardInstance;

    const replaced = fileIntoTrash(state, 0, { trash: [], banished: [] }, token, "elsewhere");
    expect(replaced, "a token was filed somewhere").toEqual({ trash: [], banished: [] });

    const exempt = fileIntoTrash(state, 0, { trash: [], banished: [] }, token, "mainDeck");
    expect(exempt).toEqual({ trash: [], banished: [] });
  });

  it("files to the TRASH for everyone else — the control on the funnel", () => {
    const { state } = board(false);
    const card = spellInstance(CLEAVE);

    expect(fileIntoTrash(state, 0, { trash: [], banished: [] }, card, "elsewhere").trash).toHaveLength(1);
  });
});
