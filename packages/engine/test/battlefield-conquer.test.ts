import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The five "when you conquer here" battlefields, plus the one delayed ability
 * among them.
 *
 * Driven through `scoring.recordConquest`, which is the real moment — the same
 * call every unit's and Legend's conquer trigger rides — and then settled,
 * because a battlefield's ability is a Chain Pending Item like everything else.
 */

const MONASTERY_OF_HIRANA = "OGN-282";
const SIGIL_OF_THE_STORM = "OGN-287";
const TARGONS_PEAK = "OGN-289";
const THE_CANDLELIT_SANCTUM = "OGN-291";
const ZAUN_WARRENS = "OGN-298";

/** A cheap real card to fill decks and trashes with. */
const FILLER = "OGN-164";

const rune = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Calm", state });

/** bf1 IS the named battlefield card, and player 0 is about to take it. */
function withBattlefield(defId: string): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId };
  return state;
}

/** The whole moment: the conquest, the response window both players pass on, and
 *  whatever question the ability parked. */
function settleConquest(state: GameState, playerIndex: 0 | 1 = 0, battlefieldId = "bf1"): GameState {
  return answerDecisions(resolveHeldTriggers(recordConquest(state, playerIndex, battlefieldId)));
}

describe("the conquer moment reaches the battlefield's own card", () => {
  it("every name in the table is a battlefield that really prints that text", () => {
    for (const [defId, name] of [
      [MONASTERY_OF_HIRANA, "Monastery of Hirana"],
      [SIGIL_OF_THE_STORM, "Sigil of the Storm"],
      [TARGONS_PEAK, "Targon's Peak"],
      [THE_CANDLELIT_SANCTUM, "The Candlelit Sanctum"],
      [ZAUN_WARRENS, "Zaun Warrens"],
    ] as const) {
      expect(battlefieldDefIdFor(name), `${name} resolves to a different card`).toBe(defId);
    }
  });

  it("fires for the CONQUEROR, not the turn player", () => {
    const state = withBattlefield(ZAUN_WARRENS);
    state.players[1]!.deck = [realUnitInstance(FILLER)];
    state.players[1]!.hand = [spellInstance(FILLER)];
    // Player 1 conquers on player 0's turn — reachable via Charm, which contests
    // for the MOVED unit's controller.
    const settled = settleConquest(state, 1);
    expect(settled.players[1]!.hand).toHaveLength(1); // discarded 1, drew 1
    expect(settled.players[0]!.hand, "the turn player was made to discard").toHaveLength(0);
  });

  it("a conquest at a DIFFERENT battlefield fires nothing", () => {
    const state = withBattlefield(ZAUN_WARRENS);
    state.players[0]!.hand = [spellInstance(FILLER)];
    const settled = settleConquest(state, 0, "bf2");
    expect(settled.players[0]!.hand, "bf2's conquest ran bf1's ability").toHaveLength(1);
  });
});

describe("Zaun Warrens (OGN-298): discard 1, then draw 1", () => {
  it("discards first and draws after, so the drawn card cannot be the discarded one", () => {
    const state = withBattlefield(ZAUN_WARRENS);
    const inHand = spellInstance(FILLER);
    const inDeck = realUnitInstance(FILLER);
    state.players[0]!.hand = [inHand];
    state.players[0]!.deck = [inDeck];
    const settled = settleConquest(state);
    expect(settled.players[0]!.hand.map((c) => c.instanceId)).toEqual([inDeck.instanceId]);
    expect(settled.players[0]!.trash.map((c) => c.instanceId)).toEqual([inHand.instanceId]);
  });
});

describe("Sigil of the Storm (OGN-287): recycle one of your runes", () => {
  it("takes a rune out of the pool to the bottom of the RUNE deck, Ready", () => {
    const state = withBattlefield(SIGIL_OF_THE_STORM);
    state.players[0]!.channeled = [rune("a", "Exhausted"), rune("b")];
    state.players[0]!.runeDeck = [rune("z")];
    const settled = settleConquest(state);
    expect(settled.players[0]!.channeled.map((r) => r.id)).toEqual(["b"]);
    expect(settled.players[0]!.runeDeck.map((r) => r.id)).toEqual(["z", "a"]);
    expect(settled.players[0]!.runeDeck[1]!.state, "an exhausted rune recycled exhausted").toBe("Ready");
  });

  it("asks nothing — '(This doesn't choose anything.)'", () => {
    const state = withBattlefield(SIGIL_OF_THE_STORM);
    state.players[0]!.channeled = [rune("a"), rune("b")];
    const settled = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(settled.pendingDecisions, "the Sigil stopped to ask").toHaveLength(0);
  });

  it("is a safe no-op with an empty pool", () => {
    const state = withBattlefield(SIGIL_OF_THE_STORM);
    state.players[0]!.channeled = [];
    expect(() => settleConquest(state)).not.toThrow();
  });
});

describe("Targon's Peak (OGN-289): ready up to 2 runes at the end of this turn", () => {
  it("readies NOTHING at the conquest — the effect is delayed", () => {
    const state = withBattlefield(TARGONS_PEAK);
    state.players[0]!.channeled = [rune("a", "Exhausted"), rune("b", "Exhausted")];
    const settled = settleConquest(state);
    expect(settled.players[0]!.channeled.every((r) => r.state === "Exhausted")).toBe(true);
    expect(settled.players[0]!.readyRunesAtEndOfTurn).toBe(2);
  });

  it("readies 2 at the end of the turn", () => {
    const state = withBattlefield(TARGONS_PEAK);
    state.players[0]!.channeled = [rune("a", "Exhausted"), rune("b", "Exhausted"), rune("c", "Exhausted")];
    const armed = settleConquest(state);
    const ended = resolveHeldTriggers(runEnd(armed));
    expect(ended.players[0]!.channeled.filter((r) => r.state === "Ready").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("survives runEnd clearing the counter, because the count is CAPTURED", () => {
    // The trigger is held across the turn rotation and resolves in the next
    // player's Action phase, by which time `readyRunesAtEndOfTurn` is 0. Reading
    // it at resolution rather than capturing it would ready nothing at all.
    const state = withBattlefield(TARGONS_PEAK);
    state.players[0]!.channeled = [rune("a", "Exhausted")];
    const armed = settleConquest(state);
    const held = runEnd(armed);
    expect(held.players[0]!.readyRunesAtEndOfTurn, "the counter outlived its turn").toBe(0);
    expect(resolveHeldTriggers(held).players[0]!.channeled[0]!.state).toBe("Ready");
  });

  it("places nothing at the end of a turn it was never armed in", () => {
    const state = withBattlefield(TARGONS_PEAK);
    state.players[0]!.channeled = [rune("a", "Exhausted")];
    const held = runEnd(state);
    // On the PEN, which is the only thing that tells "was not placed" from "was
    // placed and did nothing".
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(0);
  });

  it("arms twice for two conquests in one turn", () => {
    // "When you CONQUER" — 471.1.b withholds the second POINT, not the trigger.
    const state = withBattlefield(TARGONS_PEAK);
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`r${i}`, "Exhausted"));
    const twice = settleConquest(settleConquest(state));
    expect(twice.players[0]!.readyRunesAtEndOfTurn).toBe(4);
    expect(resolveHeldTriggers(runEnd(twice)).players[0]!.channeled.every((r) => r.state === "Ready")).toBe(true);
  });
});

describe("Monastery of Hirana (OGN-282): you may spend a buff to draw 1", () => {
  it("spends the chosen buff and draws", () => {
    const state = withBattlefield(MONASTERY_OF_HIRANA);
    const buffed = realUnitInstance(FILLER);
    state.players[0]!.baseUnits = [{ ...buffed, buffed: true }];
    state.players[0]!.deck = [realUnitInstance(FILLER)];
    const settled = settleConquest(state);
    expect(settled.players[0]!.baseUnits[0]!.buffed).toBe(false);
    expect(settled.players[0]!.hand).toHaveLength(1);
  });

  it("asks nothing at all when no friendly unit is buffed", () => {
    const state = withBattlefield(MONASTERY_OF_HIRANA);
    state.players[0]!.baseUnits = [realUnitInstance(FILLER)];
    const settled = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(settled.pendingDecisions).toHaveLength(0);
  });

  it("can be declined, and then costs nothing", () => {
    const state = withBattlefield(MONASTERY_OF_HIRANA);
    state.players[0]!.baseUnits = [{ ...realUnitInstance(FILLER), buffed: true }];
    state.players[0]!.deck = [realUnitInstance(FILLER)];
    const asked = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(asked.pendingDecisions, "the Monastery never asked").toHaveLength(1);
    const settled = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);
    expect(settled.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });
});

describe("The Candlelit Sanctum (OGN-291): look at 2, recycle one or both", () => {
  /** Four distinguishable cards on top of the deck. */
  function deckOf(n: number) {
    return Array.from({ length: n }, () => realUnitInstance(FILLER));
  }

  it("recycles both when both are chosen, and neither ends up in hand", () => {
    const state = withBattlefield(THE_CANDLELIT_SANCTUM);
    const deck = deckOf(4);
    state.players[0]!.deck = deck;
    // Always pick the first offered card, which is a recycle rather than "keep".
    const settled = settleConquest(state);
    expect(settled.players[0]!.hand, "the Sanctum drew a card it only looks at").toHaveLength(0);
    expect(settled.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      deck[2]!.instanceId,
      deck[3]!.instanceId,
      deck[0]!.instanceId,
      deck[1]!.instanceId,
    ]);
  });

  it("keeps both and asks which goes on top — 'in any order'", () => {
    const state = withBattlefield(THE_CANDLELIT_SANCTUM);
    const deck = deckOf(3);
    state.players[0]!.deck = deck;
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), (options, decision) => {
      if (decision.kind === `${THE_CANDLELIT_SANCTUM}-look`) return options.find((o) => o.id === "keep")!.id;
      // The ordering question: put the SECOND card on top, which is the only
      // answer the original order would not have produced by itself.
      return options.find((o) => o.instanceId === deck[1]!.instanceId)!.id;
    });
    expect(settled.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      deck[1]!.instanceId,
      deck[0]!.instanceId,
      deck[2]!.instanceId,
    ]);
  });

  it("asks no ordering question when only one card survives", () => {
    const state = withBattlefield(THE_CANDLELIT_SANCTUM);
    const deck = deckOf(3);
    state.players[0]!.deck = deck;
    let orderAsked = false;
    answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), (options, decision) => {
      if (decision.kind === `${THE_CANDLELIT_SANCTUM}-order`) orderAsked = true;
      // Recycle the first card, then keep the rest — one card left, no order.
      const recycle = options.find((o) => o.instanceId === deck[0]!.instanceId);
      return recycle ? recycle.id : options.find((o) => o.id === "keep")!.id;
    });
    expect(orderAsked, "one card was offered an ordering choice").toBe(false);
  });

  it("looks at only the top two, however deep the deck", () => {
    const state = withBattlefield(THE_CANDLELIT_SANCTUM);
    const deck = deckOf(5);
    state.players[0]!.deck = deck;
    answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), (options, decision) => {
      const offered = options.filter((o) => o.instanceId !== undefined).map((o) => o.instanceId);
      expect(
        offered.every((id) => id === deck[0]!.instanceId || id === deck[1]!.instanceId),
        `${decision.kind} offered a card from deeper than the top two`,
      ).toBe(true);
      return options.find((o) => o.id === "keep")?.id ?? options[0]!.id;
    });
  });
});

/**
 * Treasure Hoard (SFD-220) — "When you conquer here, you may pay 1 Energy to
 * play a Gold gear token exhausted."
 *
 * The first SFD battlefield implemented, and the first battlefield in this
 * engine to make a GEAR token. It could not be written at all until `token.ts`
 * learned to mint one — it minted `UnitInstance` only, which is the blocker it
 * shared with eleven SFD cards.
 */
describe("Treasure Hoard (SFD-220): pay 1 Energy for a Gold gear token", () => {
  const TREASURE_HOARD = "SFD-220";

  it("is the card it claims to be", () => {
    // The same pin the five OGN conquer battlefields carry: an ability keyed to
    // a defId that is not the card would fire on the wrong battlefield, silently.
    expect(battlefieldDefIdFor("Treasure Hoard")).toBe(TREASURE_HOARD);
  });

  it("plays ONE Gold token, exhausted, and takes the Energy", () => {
    const state = withBattlefield(TREASURE_HOARD);
    // Energy is floating Energy plus READY channeled runes — there is no
    // `energy` field, and the first draft of this test set one that does not
    // exist, which made it measure nothing.
    state.players[0]!.channeled = [rune("r1"), rune("r2")];

    const after = settleConquest(state);

    const gear = after.players[0]!.activeGear;
    expect(gear, "no Gold token was made").toHaveLength(1);
    expect(gear[0]!.name).toBe("Gold");
    expect(gear[0]!.kind).toBe("Gear");
    expect(gear[0]!.exhausted, "a ready Gold is a free rainbow Power this turn").toBe(true);
    expect(
      after.players[0]!.channeled.filter((r) => r.state === "Ready"),
      "the Energy was not paid",
    ).toHaveLength(1);
  });

  it("asks NOTHING when the Energy cannot be paid", () => {
    // Unaffordable is not a question. A lone "Decline" would be theatre, and it
    // is also the shape that has produced a prompt a player cannot answer.
    const state = withBattlefield(TREASURE_HOARD);
    // No floating Energy and no READY rune: genuinely unaffordable.
    state.players[0]!.channeled = [rune("r1", "Exhausted")];

    const after = settleConquest(state);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.pendingDecisions, "an unaffordable question was still asked").toHaveLength(0);
  });

  it("gives the token to the CONQUEROR, not the turn player", () => {
    // The conquer family fires for whoever conquered — reachable on the other
    // player's turn via Charm, which contests for the moved unit's controller.
    const state = withBattlefield(TREASURE_HOARD);
    state.players[1]!.channeled = [rune("r1"), rune("r2")];

    const after = settleConquest(state, 1);

    expect(after.players[1]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear, "the turn player got it instead").toHaveLength(0);
    expect(after.players[1]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(1);
  });
});
