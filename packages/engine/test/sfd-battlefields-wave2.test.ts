import { describe, expect, it } from "vitest";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { mayScoreAt } from "../src/engine/battlefield-continuous.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, beginCombatAt, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Four more SFD battlefields — 7/15 to 11/15.
 *
 * Every test drives the REAL moment (`scoreHolds`, `recordConquest`,
 * `beginCombatAt`) and then settles the chain, because a battlefield's ability is
 * a Chain Pending Item like every other trigger here. Calling a resolver directly
 * would prove the effect works and nothing about whether the moment reaches it.
 *
 * The interesting one is **Forgotten Monument**, which is the first card in this
 * engine to block SCORING rather than to block GAINING A POINT. Tianna Crownguard
 * is the contrast and the ruling is the opposite: hers lets the scoring happen
 * and pays nothing, so 470's lockout fires; this one stops the scoring
 * outright, so nothing is recorded and the battlefield is still there to take
 * later. Both halves are asserted below.
 */
const EMPERORS_DAIS = "SFD-207";
const FORGOTTEN_MONUMENT = "SFD-209";
const POWER_NEXUS = "SFD-214";
const RAVENBLOOM = "SFD-215";

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });

/** bf1 IS the named battlefield, held by player 0 with `units` standing there. */
function at(defId: string, opts: { units?: number; turnNumber?: number; attackers?: number } = {}): GameState {
  const { units = 1, turnNumber = 5, attackers = 0 } = opts;
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.turnNumber = turnNumber;
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: {
      p1: Array.from({ length: units }, (_, i) => makeUnit({ instanceId: `u${i}`, name: `Unit ${i}` })),
      // Only for the defend fixture — an opponent present here would stop
      // `isHeldBy` and break every hold test in this file.
      ...(attackers > 0 ? { p2: Array.from({ length: attackers }, (_, i) => makeUnit({ instanceId: `e${i}` })) } : {}),
    },
    controllerId: "p1",
  };
  return state;
}

/** Player 0 DEFENDS bf1 — `beginCombatAt`'s third argument is who ATTACKS. */
const defendAt = (state: GameState) => resolveHeldTriggers(beginCombatAt(state, "bf1", 1));

describe("Power Nexus (SFD-214): when you hold here, you may pay 4 rainbow to score", () => {
  it("scores the extra point when the rainbow is paid", () => {
    const state = at(POWER_NEXUS);
    // FOUR runes of MIXED domains — the pips are rainbow, so a domain match is
    // not the question. Four of one domain would pass even if the check were
    // wrong about that.
    state.players[0]!.channeled = [rune("a", "Calm"), rune("b", "Fury"), rune("c", "Mind"), rune("d", "Body")];
    const settled = answerDecisions(resolveHeldTriggers(scoreHolds(state, 0)), (o) => o.find((x) => x.id === "pay")!.id);

    // 1 for the hold itself + 1 from Power Nexus. Measured against the control
    // below rather than asserted flat, since the hold already pays.
    expect(settled.players[0]!.points, "the battlefield's point did not land").toBe(2);
    expect(settled.players[0]!.channeled.filter((r) => r.state === "Ready"), "the Power was not spent").toHaveLength(0);
  });

  it("lets the player decline, and the hold still pays its own point", () => {
    const state = at(POWER_NEXUS);
    state.players[0]!.channeled = [rune("a"), rune("b"), rune("c"), rune("d")];
    const settled = answerDecisions(resolveHeldTriggers(scoreHolds(state, 0)), (o) => o.find((x) => x.id === "decline")!.id);
    expect(settled.players[0]!.points).toBe(1);
  });

  it("never asks when the 4 Power cannot be paid (416.3)", () => {
    // A held trigger costs both players a PassFocus even when it resolves to
    // nothing, so an unaffordable board must place no Pending Item at all.
    const state = at(POWER_NEXUS);
    state.players[0]!.channeled = [rune("a"), rune("b"), rune("c")]; // one short
    const settled = resolveHeldTriggers(scoreHolds(state, 0));
    expect(settled.pendingDecisions, "it asked for Power the board did not have").toHaveLength(0);
    expect(settled.players[0]!.points).toBe(1);
  });
});

describe("Ravenbloom Conservatory (SFD-215): when you defend here, reveal the top card", () => {
  it("puts a revealed SPELL into hand", () => {
    const state = at(RAVENBLOOM, { attackers: 1 });
    state.players[0]!.deck = [spellInstance("OGN-009"), spellInstance("OGN-022")];
    const settled = defendAt(state);

    expect(settled.players[0]!.hand.map((c) => c.defId), "the spell did not reach hand").toContain("OGN-009");
    expect(settled.players[0]!.deck, "it was not removed from the deck").toHaveLength(1);
  });

  it("recycles a NON-spell to the BOTTOM of the deck", () => {
    const state = at(RAVENBLOOM, { attackers: 1 });
    const unit = makeUnit({ instanceId: "top-unit" });
    state.players[0]!.deck = [unit, spellInstance("OGN-022")];
    const settled = defendAt(state);

    expect(settled.players[0]!.hand, "a non-spell was put into hand").toHaveLength(0);
    expect(settled.players[0]!.deck, "the deck changed size").toHaveLength(2);
    // The BOTTOM, which is what "recycle" means (416/425) — top would be a no-op
    // and would pass a naive length check.
    expect(settled.players[0]!.deck.at(-1)!.instanceId).toBe("top-unit");
  });

  it("does nothing on an empty deck (055)", () => {
    const state = at(RAVENBLOOM, { attackers: 1 });
    state.players[0]!.deck = [];
    expect(defendAt(state).players[0]!.hand).toHaveLength(0);
  });
});

describe("Emperor's Dais (SFD-207): when you conquer here, bounce a unit for a Sand Soldier", () => {
  it("returns the chosen unit to hand and plays a 2 Might Sand Soldier here", () => {
    const state = at(EMPERORS_DAIS, { units: 1 });
    state.players[0]!.floatingEnergy = 1;
    const settled = answerDecisions(
      resolveHeldTriggers(recordConquest(state, 0, "bf1")),
      (o) => o.find((x) => x.id === "u0")!.id,
    );

    expect(settled.players[0]!.hand.map((c) => c.instanceId), "the unit did not go back to hand").toContain("u0");
    const here = settled.battlefields.find((b) => b.id === "bf1")!.units["p1"] ?? [];
    expect(here, "the token did not arrive").toHaveLength(1);
    expect(here[0]!.might).toBe(2);
    expect(here[0]!.isToken).toBe(true);
    expect(settled.players[0]!.floatingEnergy, "the Energy was not paid").toBe(0);
  });

  it("declining pays nothing and makes nothing", () => {
    const state = at(EMPERORS_DAIS);
    state.players[0]!.floatingEnergy = 1;
    const settled = answerDecisions(
      resolveHeldTriggers(recordConquest(state, 0, "bf1")),
      (o) => o.find((x) => x.id === "decline")!.id,
    );
    expect(settled.players[0]!.floatingEnergy, "declining still charged the Energy").toBe(1);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });

  it("never asks with no unit here — the unit is HALF THE COST", () => {
    // "Pay [1] AND return a unit you control here" is one price. A conquest by a
    // Spell leaves exactly this board, so it is reachable rather than theoretical.
    const state = at(EMPERORS_DAIS, { units: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, controllerId: "p1", units: {} };
    state.players[0]!.floatingEnergy = 1;
    expect(resolveHeldTriggers(recordConquest(state, 0, "bf1")).pendingDecisions).toHaveLength(0);
  });

  it("never asks when the Energy cannot be paid", () => {
    const state = at(EMPERORS_DAIS);
    state.players[0]!.floatingEnergy = 0;
    expect(resolveHeldTriggers(recordConquest(state, 0, "bf1")).pendingDecisions).toHaveLength(0);
  });
});

describe("Forgotten Monument (SFD-209): players can't score here until their third turn", () => {
  it("blocks a HOLD before turn 3 and allows it from turn 3", () => {
    expect(scoreHolds(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), 0).players[0]!.points, "it scored on turn 2").toBe(0);
    expect(scoreHolds(at(FORGOTTEN_MONUMENT, { turnNumber: 3 }), 0).players[0]!.points, "it did not score on turn 3").toBe(1);
  });

  it("blocks a CONQUEST before turn 3", () => {
    expect(recordConquest(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), 0, "bf1").players[0]!.points).toBe(0);
    expect(recordConquest(at(FORGOTTEN_MONUMENT, { turnNumber: 3 }), 0, "bf1").players[0]!.points).toBe(1);
  });

  it("does NOT record the battlefield as scored — the opposite of Tianna's ruling", () => {
    // The half that separates "can't score" from "can't gain points". Tianna
    // lets the scoring happen and pays nothing, so 470's lockout fires and
    // the battlefield is spent for the turn. This stops the scoring itself, so
    // nothing is recorded and the battlefield is still there to be taken later.
    const blocked = scoreHolds(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), 0);
    expect(blocked.players[0]!.scoredBattlefieldsThisTurn, "the lockout wrongly fired").not.toContain("bf1");

    const conquered = recordConquest(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), 0, "bf1");
    expect(conquered.players[0]!.scoredBattlefieldsThisTurn).not.toContain("bf1");
  });

  it("is asked of the BATTLEFIELD, so an ordinary one is unaffected", () => {
    expect(mayScoreAt(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), "bf1")).toBe(false);
    expect(mayScoreAt(at(FORGOTTEN_MONUMENT, { turnNumber: 2 }), "bf2"), "it blocked a different battlefield").toBe(true);
    expect(mayScoreAt(at(POWER_NEXUS, { turnNumber: 1 }), "bf1"), "it blocked a battlefield with no such rule").toBe(true);
  });
});
