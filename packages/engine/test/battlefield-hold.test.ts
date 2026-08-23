import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { winner } from "../src/engine/win-condition.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { GameState, TriggerChainEntry } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import {
  answerDecisions,
  keepTriggerOrder,
  makeState,
  makeUnit,
  realUnitInstance,
  resolveHeldTriggers,
} from "./fixtures.js";

/**
 * The seven "when you hold here" battlefields.
 *
 * **These abilities did not exist before this file.** A battlefield in play was a
 * name, a controller and a list of units; `card-loader`'s `shouldSkip` keeps
 * Battlefield-type cards out of `loadCardDefinitions` entirely, so there was no
 * `CardDefinition` for any registry to key off and nothing that could have been
 * "broken". `BattlefieldState.defId` is the key that made the table possible.
 *
 * Every test here drives the REAL moment — `runBeginning`, which calls
 * `scoring.scoreHolds`, which is what fires 469.2's hold — and then settles the
 * chain, because a battlefield's ability is a Chain Pending Item like every other
 * trigger in this engine. A test that called the resolver directly would prove the
 * effect works and nothing about whether the hold reaches it.
 */

const ALTAR_TO_UNITY = "OGN-275";
const GROVE_OF_THE_GOD_WILLOW = "OGN-280";
const HALLOWED_TOMB = "OGN-281";
const NAVORI_FIGHTING_PIT = "OGN-283";
const RECKONERS_ARENA = "OGN-286";
const STARTIPPED_PEAK = "OGN-288";
const THE_GRAND_PLAZA = "OGN-293";

/** Sett - Brawler — "when I conquer, buff me", the conquer effect Reckoner's
 *  Arena activates without a conquest. */
const SETT_BRAWLER = "OGN-164";
/** Yeti Brawler — "when I conquer, IF you assigned 3 or more excess damage…".
 *  383.4.g.1's "non-conquer parts of the condition", on a card whose extra part
 *  is false at a hold by construction: no combat has happened. */
const YETI_BRAWLER = "UNL-018";

/** A Ready rune for the rune DECK — The Papertree channels from there. */
const rune = (id: string) => ({ id, domain: "Calm" as const, state: "Ready" as const });

/**
 * Player 0 in their Beginning Phase, holding bf1, which IS the named battlefield
 * card. `isHeldBy` wants units present and none of the opponent's.
 */
function holding(defId: string, units: UnitInstance[] = [makeUnit()]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: { p1: units },
    controllerId: "p1",
  };
  return state;
}

/** The whole moment: hold scoring, then the response window both players pass
 *  on, then whatever question the ability parked. */
function settleHold(state: GameState): GameState {
  return answerDecisions(resolveHeldTriggers(runBeginning(state)));
}

/**
 * Steps the chain just far enough for the BATTLEFIELD's own item to resolve, and
 * reports what it put on the chain behind it.
 *
 * Needed only by Reckoner's Arena, and only because of what 383.4.g.1 changed:
 * "placed on the chain as if it had just triggered" is observably different from
 * "run inside the Arena's resolution" for exactly one step of the chain, and
 * `settleHold` runs straight past it. Stopping here is the whole assertion.
 */
function settleArena(held: GameState): { state: GameState; activated: TriggerChainEntry[] } {
  const arenaOnChain = (s: GameState) =>
    s.spellChain.some((e) => !isSpellChainEntry(e) && e.source === "battlefield");
  let current = keepTriggerOrder(runCleanup(held));
  for (let guard = 0; guard < 8 && arenaOnChain(current); guard += 1) {
    current = keepTriggerOrder(
      runCleanup(executePassFocus(current, { type: "PassFocus", playerIndex: current.chainPriority })),
    );
  }
  const activated = current.spellChain.filter(
    (e): e is TriggerChainEntry => !isSpellChainEntry(e) && e.source !== "battlefield",
  );
  return { state: current, activated };
}

describe("the battlefield card is what carries the ability", () => {
  it("a battlefield with no defId holds for its point and nothing else", () => {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [makeUnit()] }, controllerId: "p1" };
    const settled = settleHold(state);
    expect(settled.players[0]!.points).toBe(1);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });

  it("resolves as a Chain Pending Item, not at the hold", () => {
    // The whole point of the conversion this rides on: the ability is on the
    // chain and respondable BEFORE it does anything.
    const state = holding(GROVE_OF_THE_GOD_WILLOW);
    state.players[0]!.deck = [realUnitInstance(SETT_BRAWLER)];
    const held = runBeginning(state);
    expect(held.players[0]!.hand, "the draw happened at the hold rather than on the chain").toHaveLength(0);
    // Asserted on the PEN, which is the only thing that can tell "was placed" from
    // "was placed and did nothing" — see the standing note on negative controls.
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(1);
    const onChain = resolveHeldTriggers(held);
    expect(onChain.players[0]!.hand).toHaveLength(1);
  });

  it("every name in the table is a battlefield that really prints that text", () => {
    // A defId typo would make an ability silently unreachable — the battlefield
    // in play would carry a name this table has never heard of.
    for (const [defId, name] of [
      [ALTAR_TO_UNITY, "Altar to Unity"],
      [GROVE_OF_THE_GOD_WILLOW, "Grove of the God-Willow"],
      [HALLOWED_TOMB, "Hallowed Tomb"],
      [NAVORI_FIGHTING_PIT, "Navori Fighting Pit"],
      [RECKONERS_ARENA, "Reckoner's Arena"],
      [STARTIPPED_PEAK, "Startipped Peak"],
      [THE_GRAND_PLAZA, "The Grand Plaza"],
    ] as const) {
      expect(battlefieldDefIdFor(name), `${name} resolves to a different card`).toBe(defId);
    }
  });
});

describe("Altar to Unity (OGN-275): play a 1 Might Recruit token in your base", () => {
  it("puts the token in BASE, not at the battlefield", () => {
    const settled = settleHold(holding(ALTAR_TO_UNITY));
    expect(settled.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Recruit"]);
    expect(settled.players[0]!.baseUnits[0]!.might).toBe(1);
    // The battlefield still holds only the unit that was standing there — a token
    // arriving here would change what the next Showdown fights over.
    expect(settled.battlefields[0]!.units["p1"]).toHaveLength(1);
  });
});

describe("Grove of the God-Willow (OGN-280): draw 1", () => {
  it("draws for the holder", () => {
    const state = holding(GROVE_OF_THE_GOD_WILLOW);
    state.players[0]!.deck = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.hand).toHaveLength(1);
    expect(settled.players[1]!.hand, "the opponent drew from a battlefield they do not hold").toHaveLength(0);
  });
});

describe("Hallowed Tomb (OGN-281): return your Chosen Champion", () => {
  it("returns the CHOSEN champion from the trash to an empty Champion Zone", () => {
    const state = holding(HALLOWED_TOMB);
    const champion = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [champion];
    const settled = settleHold(state);
    expect(settled.players[0]!.championZone?.instanceId).toBe(champion.instanceId);
    expect(settled.players[0]!.trash).toHaveLength(0);
  });

  it("asks nothing when the Champion Zone is occupied — 'if it is empty'", () => {
    const state = holding(HALLOWED_TOMB);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.trash = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.trash, "the champion was pulled out of the trash anyway").toHaveLength(1);
  });

  it("does NOT return a champion card that is not YOUR Chosen Champion", () => {
    // The reason `chosenChampionDefId` exists: OGN prints 56 champions against 16
    // legends, so a champion in your trash need not be the one you chose.
    const state = holding(HALLOWED_TOMB);
    state.players[0]!.chosenChampionDefId = "OGN-999";
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.championZone).toBeNull();
    expect(settled.players[0]!.trash).toHaveLength(1);
  });

  it("can be declined — it is a 'you may'", () => {
    const state = holding(HALLOWED_TOMB);
    const champion = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [champion];
    const asked = resolveHeldTriggers(runBeginning(state));
    // Asserted before answering: without it this test passes vacuously against a
    // battlefield whose ability never fired at all, since declining and never
    // being asked leave the same board.
    expect(asked.pendingDecisions, "the Tomb never asked").toHaveLength(1);
    const settled = answerDecisions(asked, (options) => {
      const decline = options.find((o) => o.id === "decline");
      expect(decline, "no decline was offered for a 'you may'").toBeDefined();
      return decline!.id;
    });
    expect(settled.players[0]!.championZone).toBeNull();
    expect(settled.players[0]!.trash).toHaveLength(1);
  });
});

describe("Navori Fighting Pit (OGN-283): buff a unit here", () => {
  it("buffs the only unit there without prompting — one option is not a question", () => {
    const settled = settleHold(holding(NAVORI_FIGHTING_PIT));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(true);
  });

  it("offers each unit standing HERE, and only those", () => {
    const mine = [makeUnit({ name: "A" }), makeUnit({ name: "B" })];
    const state = holding(NAVORI_FIGHTING_PIT, mine);
    // A unit of the holder's standing somewhere ELSE is not "here".
    state.players[0]!.baseUnits = [makeUnit({ name: "In base" })];
    const settled = answerDecisions(resolveHeldTriggers(runBeginning(state)), (options) => {
      expect(options.map((o) => o.label).sort()).toEqual(["A", "B"]);
      return options.find((o) => o.label === "B")!.id;
    });
    const here = settled.battlefields[0]!.units["p1"]!;
    expect(here.find((u) => u.name === "B")!.buffed).toBe(true);
    expect(here.find((u) => u.name === "A")!.buffed).toBe(false);
    expect(settled.players[0]!.baseUnits[0]!.buffed).toBe(false);
  });

  /**
   * **355.9.b — "a unit here" prints no owner, so it imposes none.** The engine
   * offered only the HOLDER's units until 2026-08-23, excused as "a held
   * battlefield has no enemy units on it by definition, so the filter is a
   * statement of the card rather than a live distinction". That premise is about
   * the moment of the HOLD; the ability resolves a response window later, and an
   * enemy unit arriving in that window is where the two readings come apart.
   *
   * The fixture inserts the arrival directly rather than casting something that
   * moves a unit, because the assertion is about the OPTIONS the resolution
   * builds — routing it through a real spell would test that spell instead.
   */
  it("offers an ENEMY unit that arrived while the ability waited (355.9.b)", () => {
    const state = holding(NAVORI_FIGHTING_PIT, [makeUnit({ name: "Mine" })]);
    const held = runBeginning(state);
    const gatecrashed: GameState = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [makeUnit({ name: "Theirs" })] } } : bf,
      ),
    };
    let offered: string[] = [];
    answerDecisions(resolveHeldTriggers(gatecrashed), (options) => {
      offered = options.map((o) => o.label);
      return options[0]!.id;
    });
    expect(offered.sort()).toEqual(["Mine", "Theirs (theirs)"]);
  });
});

describe("Startipped Peak (OGN-288): you may channel 1 rune exhausted", () => {
  it("channels one rune, EXHAUSTED", () => {
    const state = holding(STARTIPPED_PEAK);
    state.players[0]!.runeDeck = [{ id: "r1", domain: "Calm", state: "Ready" }];
    const settled = settleHold(state);
    expect(settled.players[0]!.channeled).toHaveLength(1);
    expect(settled.players[0]!.channeled[0]!.state, "channelled READY — the card says exhausted").toBe("Exhausted");
    expect(settled.players[0]!.runeDeck).toHaveLength(0);
  });

  it("asks nothing at all with an empty rune deck", () => {
    const state = holding(STARTIPPED_PEAK);
    state.players[0]!.runeDeck = [];
    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.pendingDecisions).toHaveLength(0);
  });
});

describe("Reckoner's Arena (OGN-286): activate the conquer effects of units here", () => {
  it("runs a unit's 'when I conquer' with no conquest at all", () => {
    const sett = realUnitInstance(SETT_BRAWLER);
    const settled = settleHold(holding(RECKONERS_ARENA, [sett]));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed, "Sett's conquer effect never ran").toBe(true);
    // No battlefield changed hands, so no conquest point was scored — only the
    // ordinary hold point.
    expect(settled.players[0]!.points).toBe(1);
  });

  it("reaches only the units standing HERE", () => {
    const here = realUnitInstance(SETT_BRAWLER);
    const elsewhere = realUnitInstance(SETT_BRAWLER);
    const state = holding(RECKONERS_ARENA, [here]);
    state.players[0]!.baseUnits = [elsewhere];
    const settled = settleHold(state);
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(true);
    expect(settled.players[0]!.baseUnits[0]!.buffed, "a unit in base had its conquer effect activated").toBe(false);
  });

  it("is a no-op for units with no conquer effect", () => {
    const settled = settleHold(holding(RECKONERS_ARENA, [makeUnit()]));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(false);
  });

  /**
   * **383.4.g.1 is written about this card by name**, and until 2026-08-23 the
   * engine took the opposite reading on both halves of it, on its own reasoning
   * rather than on the rule. The rule's worked example: "For each unit at the
   * battlefield, you will check the trigger condition of their conquer effects to
   * see if the condition has been fulfilled, treating the conquer portion of the
   * condition as having been fulfilled. If all of the conditions are fulfilled for
   * a conquer effect, **it is placed on the chain as if it had just triggered**.
   * **If any of the non-conquer parts of the condition are not fulfilled, it will
   * not be placed on the chain.**"
   *
   * The three tests above pass under BOTH readings — running the effect inline
   * and placing it on the chain end at the same board — which is why the change
   * needed its own assertions on the PEN.
   */
  it("places each activated effect on the CHAIN, not inside its own resolution", () => {
    const held = runBeginning(holding(RECKONERS_ARENA, [realUnitInstance(SETT_BRAWLER)]));
    // The Arena itself, and nothing of Sett's yet: his effect is activated when
    // the Arena RESOLVES, which is a chain item later.
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(1);
    expect(held.pendingTriggers.some((e) => e.listenerDefId === SETT_BRAWLER)).toBe(false);
    // Settle the Arena's own item, then look for Sett's as a separate item — and
    // assert the buff has NOT landed yet, which is what separates "placed on the
    // chain" from "run inline".
    const armed = settleArena(held);
    expect(armed.state.spellChain.some((e) => !isSpellChainEntry(e) && e.listenerDefId === SETT_BRAWLER)).toBe(true);
    expect(armed.state.battlefields[0]!.units["p1"]![0]!.buffed, "the buff landed inside the Arena's own resolution").toBe(
      false,
    );
  });

  it("does NOT place one whose non-conquer condition is unfulfilled (383.4.g.1)", () => {
    // Yeti Brawler — "When I conquer, IF you assigned 3 or more excess damage,
    // play two Gold gear tokens exhausted." The `if` sits immediately after the
    // Condition, so 383.2.a.1 makes it part of the Condition, and no combat has
    // happened at all: nothing was assigned, so it must not reach the chain.
    //
    // Paired with the Sett line below rather than asserted alone, because "no
    // Gold tokens" is also what an Arena that had stopped activating ANYTHING
    // produces — the contrast is what makes this about the condition.
    const yeti = settleArena(runBeginning(holding(RECKONERS_ARENA, [realUnitInstance(YETI_BRAWLER)])));
    expect(yeti.activated).toHaveLength(0);
    const sett = settleArena(runBeginning(holding(RECKONERS_ARENA, [realUnitInstance(SETT_BRAWLER)])));
    expect(sett.activated.map((e) => e.listenerDefId), "the Arena activated nothing at all").toEqual([SETT_BRAWLER]);
  });
});

describe("The Grand Plaza (OGN-293): 7+ units here wins the game", () => {
  const seven = () => Array.from({ length: 7 }, (_, i) => makeUnit({ name: `U${i}` }));

  it("wins on 7, with nothing like enough points to", () => {
    const settled = settleHold(holding(THE_GRAND_PLAZA, seven()));
    expect(settled.players[0]!.points, "this must not be a win by points").toBeLessThan(8);
    expect(winner(settled)).toBe(0);
  });

  it("does not win on 6", () => {
    const settled = settleHold(holding(THE_GRAND_PLAZA, seven().slice(0, 6)));
    expect(winner(settled)).toBeNull();
  });

  it("does not even TRIGGER on 6 — the count is part of the Condition (383.2.a.1)", () => {
    // Asserted on the PEN, because that is the only thing that can tell "never
    // triggered" from "triggered and found nothing" — the same reason the
    // Grove's test above reads `pendingTriggers` rather than the board.
    const held = runBeginning(holding(THE_GRAND_PLAZA, seven().slice(0, 6)));
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(0);
  });

  /**
   * **INVERTED 2026-08-23 by the unverified-row sweep.** This block used to read
   * "counts at RESOLUTION, so the seventh unit can be answered", and pinned the
   * opposite of what it now asserts. Its reasoning was a BALANCE argument — "a
   * win the opponent could no longer prevent by removing the seventh unit would
   * be a stronger card than the one printed" — made against a rule nobody had
   * read.
   *
   * **383.2.a.1** reads it the other way: "Any additional conditional statement
   * immediately after the Condition must be true in order for the Condition to be
   * fulfilled. Such a conditional statement is part of the Trigger Condition and
   * not the Effect." The Plaza's `if` sits immediately after "when you hold here",
   * so the count is asked at the hold. The rule's own Sona - Harmonious example
   * then supplies the consequence in as many words: "If she is removed in reaction
   * to the triggered ability, it will still resolve."
   *
   * Kept and pointed the other way rather than deleted, because this is exactly
   * the negative the skill warns about: an ability that quietly went back to
   * re-counting at resolution would just make a won game not-won, and nothing
   * else here would notice.
   */
  it("cannot be answered — a seventh unit killed in the window does NOT stop the win", () => {
    const held = runBeginning(holding(THE_GRAND_PLAZA, seven()));
    const oneFewer: GameState = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { p1: (bf.units["p1"] ?? []).slice(1) } } : bf,
      ),
    };
    expect(oneFewer.battlefields[0]!.units["p1"], "the fixture must really have removed one").toHaveLength(6);
    expect(winner(resolveHeldTriggers(oneFewer))).toBe(0);
  });
});

/**
 * The Papertree (SFD-219) — "When you hold here, each player channels 1 rune
 * exhausted."
 *
 * Symmetric, which is the whole card: the holder gains a rune and so does the
 * opponent. That symmetry is the only thing worth testing here, and it is the
 * thing a "channel for the holder" implementation would get wrong while looking
 * right from the holder's side.
 */
describe("The Papertree (SFD-219): each player channels 1 exhausted", () => {
  const THE_PAPERTREE = "SFD-219";

  it("is the card it claims to be", () => {
    expect(battlefieldDefIdFor("The Papertree")).toBe(THE_PAPERTREE);
  });

  it("channels for BOTH players, exhausted", () => {
    const state = holding(THE_PAPERTREE);
    state.players[0]!.runeDeck = [rune("a1"), rune("a2")];
    state.players[1]!.runeDeck = [rune("b1"), rune("b2")];

    const after = settleHold(state);

    for (const index of [0, 1] as const) {
      const channeled = after.players[index]!.channeled;
      expect(channeled, `player ${index} channeled nothing`).toHaveLength(1);
      expect(channeled[0]!.state, `player ${index}'s rune arrived ready`).toBe("Exhausted");
      expect(after.players[index]!.runeDeck).toHaveLength(1);
    }
  });

  it("does not throw when a player's rune deck is empty", () => {
    // `channelRunesExhausted` channels what it can, so an empty deck simply
    // gains nothing rather than failing the hold.
    const state = holding(THE_PAPERTREE);
    state.players[0]!.runeDeck = [rune("a1")];
    state.players[1]!.runeDeck = [];
    expect(() => settleHold(state)).not.toThrow();
    expect(settleHold(state).players[1]!.channeled).toHaveLength(0);
  });
});
