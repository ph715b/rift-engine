import { describe, expect, it } from "vitest";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { executeFloatRune } from "../src/actions/execute-float-rune.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Sivir - Battle Mistress (SFD-203) — "When you recycle a rune, you may exhaust
 * me to play a Gold gear token exhausted. When one or more enemy units die,
 * ready me."
 *
 * The SECOND two-hook Legend, after Irelia, and the pair is an ENGINE rather
 * than two unrelated lines: the first clause spends her, the second stands her
 * back up, so the interesting assertions are about the two together.
 *
 * Three things can be wrong here and each has its own test:
 *  - **which recyclings count** — floating a rune for ENERGY exhausts it in
 *    place and is not a recycling, while floating for POWER is;
 *  - **whose deaths count** — "enemy" means not hers, and reading it the other
 *    way would ready her off her own losses;
 *  - **the exhaust gates, which point OPPOSITE ways** — clause one is never
 *    offered while she is exhausted, clause two is only interesting then.
 */

const SIVIR = "SFD-203";

function board(): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        channeled: [
          { id: "c0", domain: "Fury", state: "Ready" },
          { id: "c1", domain: "Fury", state: "Ready" },
        ],
      }),
      makePlayer("p2", { baseUnits: [makeUnit({ name: "Foe", instanceId: "foe" })] }),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: SIVIR };
  return state;
}

/** Drains the holding pen onto the chain and resolves until a question appears. */
function settle(state: GameState): GameState {
  let current = runCleanup(state);
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

/** The real action, not a hand-placed event — `forPower` is the branch that recycles. */
function float(state: GameState, forPower: boolean, runeId = "c0"): GameState {
  return executeFloatRune(state, { type: "FloatRune", playerIndex: 0, runeId, forPower });
}

describe("Sivir's recycle clause", () => {
  it("offers a Gold when a rune is recycled", () => {
    expect(pendingDecision(settle(float(board(), true)))?.kind).toBe("SFD-203-gold");
  });

  /**
   * **The distinction the whole clause rests on.** Floating for Energy exhausts
   * the rune IN PLACE — it stays in `channeled` and never reaches the rune deck.
   * Firing on both branches would double this card's output for free.
   */
  it("does NOT fire when a rune is floated for ENERGY", () => {
    const after = settle(float(board(), false));
    expect(pendingDecision(after), "she fired on a float that recycled nothing").toBeUndefined();
    // And the premise of that negative: the rune really did stay put.
    expect(after.players[0]!.channeled).toHaveLength(2);
  });

  it("mints the Gold EXHAUSTED and exhausts her", () => {
    const offered = settle(float(board(), true));
    const after = answerDecision(offered, pendingDecision(offered)!.id, "gold")!;

    const gold = after.players[0]!.activeGear.find((g) => g.defId === GOLD_TOKEN_DEF_ID);
    expect(gold, "no Gold was played").toBeDefined();
    expect(gold!.exhausted, "the Gold entered ready — the card prints exhausted").toBe(true);
    expect(after.players[0]!.legend.exhausted, "she was not exhausted as the cost").toBe(true);
  });

  it("declining costs nothing", () => {
    const offered = settle(float(board(), true));
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.legend.exhausted).toBe(false);
  });

  /**
   * An unpayable offer is not made — and the assertion is on the PENDING ITEM,
   * not on `pendingDecision`. A decision whose only option is "decline"
   * auto-resolves, so asking for the prompt cannot tell the trigger firing
   * uselessly apart from the trigger not firing; only counting chain entries can.
   */
  it("is not offered while she is already exhausted", () => {
    const state = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    const held = runCleanup(float(state, true)).spellChain.filter(
      (e) => "listenerDefId" in e && e.listenerDefId === SIVIR,
    );

    expect(held, "an unpayable trigger was placed on the chain").toHaveLength(0);
    expect(pendingDecision(settle(float(state, true))), "an unpayable offer was made").toBeUndefined();
  });

  /** "When YOU recycle" — the opponent's rune is not hers. */
  it("does not fire on the OPPONENT's recycling", () => {
    const state = board();
    state.players[1]!.channeled = [{ id: "o0", domain: "Fury", state: "Ready" }];
    const after = settle(
      executeFloatRune(state, { type: "FloatRune", playerIndex: 1, runeId: "o0", forPower: true }),
    );
    expect(pendingDecision(after), "she fired on the opponent's recycling").toBeUndefined();
  });
});

describe("Sivir's death clause", () => {
  function exhausted(): GameState {
    const state = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    return state;
  }

  it("readies her when an enemy unit dies", () => {
    const after = settle(destroyUnit(exhausted(), "foe", 0));
    expect(after.players[0]!.legend.exhausted, "she was left exhausted").toBe(false);
  });

  /**
   * **"ENEMY units"** — her own unit dying is not this trigger, and reading it as
   * "any unit" would ready her off her own losses. The mirror of the clause.
   */
  it("does NOT ready her when one of HER units dies", () => {
    const state = exhausted();
    state.players[0]!.baseUnits = [makeUnit({ name: "Mine", instanceId: "mine" })];
    const after = settle(destroyUnit(state, "mine", 1));
    expect(after.players[0]!.legend.exhausted, "her own unit's death readied her").toBe(true);
  });

  /** No exhaust gate on this clause: readying is the effect, so a ready Sivir is
   *  simply unchanged rather than an error. */
  it("is a no-op while she is already ready", () => {
    const after = settle(destroyUnit(board(), "foe", 0));
    expect(after.players[0]!.legend.exhausted).toBe(false);
  });

  /**
   * The two clauses as the engine the card is: recycle for a Gold, kill something
   * to stand her up, recycle again for a SECOND Gold. Neither clause alone proves
   * this, which is the point of testing them together.
   */
  it("the pair recharges — a kill lets her pay a second time", () => {
    const first = settle(float(board(), true));
    const paid = answerDecision(first, pendingDecision(first)!.id, "gold")!;
    expect(paid.players[0]!.legend.exhausted).toBe(true);

    const readied = settle(destroyUnit(paid, "foe", 0));
    expect(readied.players[0]!.legend.exhausted, "the kill did not stand her back up").toBe(false);

    const second = settle(float(readied, true, "c1"));
    const twice = answerDecision(second, pendingDecision(second)!.id, "gold")!;
    expect(
      twice.players[0]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID),
      "the second recycling did not pay",
    ).toHaveLength(2);
  });
});
