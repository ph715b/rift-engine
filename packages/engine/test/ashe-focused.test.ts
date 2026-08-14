import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { banishFromHandUntilHold } from "../src/engine/delayed-triggers.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **UNL-169 Ashe - Focused — "When you play me, choose an opponent. They reveal
 * their hand. Choose a card revealed this way and banish it. When they hold,
 * return it to their hand (even if I'm no longer on the board)."**
 *
 * Refused in waves 3, 6 and 7 on three named blockers. Two were real and are
 * built; the third was an accurate measurement attached to a dead-end plan, and
 * that is the part worth pinning.
 *
 *   1. **No delayed trigger armed by a resolved ability.** True. The engine's two
 *      earlier delayed effects are booleans on state read inline by the site that
 *      fires them, which is fine for a modifier and wrong for an ABILITY — 383.3
 *      puts a Triggered Ability on the Chain with a response window.
 *      `engine/delayed-triggers.ts` and `source: "delayed"` are that mechanism,
 *      and `it waits on the CHAIN` below is what proves it is not inline.
 *   2. **No per-instance memory of which card was banished.** True.
 *      `PlayerState.banishedUntilHold`, ids on the CARD's owner.
 *   3. **"even if I'm no longer on the board" — a dead Ashe is in no listener
 *      walk.** The measurement was right and three waves drew the wrong
 *      conclusion from it: they went looking for a way to make her listen from a
 *      trash or a banish pile. She never listens. The delayed ability exists
 *      independently of her the moment her on-play effect resolves, which is
 *      exactly what the parenthetical says — so `returns after Ashe has been
 *      killed` is the test that closes the blocker, and it kills her first.
 *
 * "They reveal their hand" is INFORMATION and needs no state, the same reading
 * Sabotage (OGN-156) and Scuttle Crab already take.
 */

const registry = defaultCardRegistry();
const ASHE = "UNL-169";

/** Player 0's turn is about to end; **player 1** holds bf2, so passing runs
 *  player 1's Beginning Phase and their hold is what fires the delayed ability.
 *  Player 1 is also the one whose hand Ashe empties, which is the whole point:
 *  "when THEY hold, return it to THEIR hand". */
function opponentHoldingBf2(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "holder" })] };
  state.battlefields[1]!.controllerId = "p2";
  state.players[1]!.hand = [spellInstance("OGN-009"), spellInstance("OGN-024")];
  return state;
}

const accept = (state: GameState, action: unknown): GameState => {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
};

const handIds = (state: GameState, p: 0 | 1) => state.players[p]!.hand.map((c) => c.instanceId).sort();
const banishedIds = (state: GameState, p: 0 | 1) => state.players[p]!.banished.map((c) => c.instanceId).sort();

/**
 * Plays Ashe for real, through `legalActions` + `submit`, and drains the chain
 * to the question she parks.
 *
 * Deliberately not a call to her resolver: her effect crosses the enumerator,
 * the validator, the on-play trigger hold and the decision park, and every one of
 * those hops is somewhere this engine has silently dropped an effect before.
 */
function playAshe(state: GameState): GameState {
  const ready = structuredClone(state);
  ready.players[0]!.hand = [realUnitInstance(ASHE)];
  ready.players[0]!.channeled = Array.from({ length: 9 }, (_, i) => ({
    id: `o${i}`,
    domain: "Order" as const,
    state: "Ready" as const,
  }));
  const play = legalActions(ready).find((a) => a.type === "PlayCard" && a.card.defId === ASHE);
  expect(play, "Ashe was not playable — the fixture measures nothing").toBeDefined();
  return resolveHeldTriggers(accept(ready, play));
}

/** Answers the parked question through the REAL action, so the validator's own
 *  re-derivation of the option list is exercised too. */
function answer(state: GameState, instanceId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was asked").toBeDefined();
  const option = optionsFor(state, decision!).find((o) => o.instanceId === instanceId);
  expect(option, `${instanceId} was not on offer`).toBeDefined();
  return resolveHeldTriggers(
    accept(state, {
      type: "AnswerDecision",
      playerIndex: decision!.playerIndex,
      decisionId: decision!.id,
      optionId: option!.id,
    }),
  );
}

describe("the on-play half: choose a card from the revealed hand and banish it", () => {
  it("asks the CASTER, and offers every card in the OPPONENT's hand", () => {
    const state = opponentHoldingBf2();
    const parked = playAshe(state);
    const decision = pendingDecision(parked);

    expect(decision?.kind, "Ashe asked nothing").toBe("UNL-169-banish");
    expect(decision?.playerIndex, "the OPPONENT was asked to choose their own card").toBe(0);
    expect(
      optionsFor(parked, decision!).map((o) => o.instanceId).sort(),
      "the options were not the opponent's whole hand",
    ).toEqual(handIds(state, 1));
  });

  it("banishes the chosen card out of their hand — not a discard", () => {
    const state = opponentHoldingBf2();
    const parked = playAshe(state);
    const victim = state.players[1]!.hand[0]!.instanceId;

    const after = answer(parked, victim);

    expect(handIds(after, 1), "the card is still in hand").not.toContain(victim);
    expect(banishedIds(after, 1), "the card did not reach the banish zone").toContain(victim);
    expect(after.players[1]!.trash.map((c) => c.instanceId), "it went to the TRASH — this is a banish").not.toContain(victim);
    expect(after.players[1]!.banishedUntilHold, "the return was never armed").toEqual([victim]);
  });

  it("asks NOTHING against an empty hand rather than asking a fake question", () => {
    const state = opponentHoldingBf2();
    state.players[1]!.hand = [];

    expect(pendingDecision(playAshe(state)), "an empty hand produced a question").toBeUndefined();
  });
});

describe("the delayed half: when they hold, it returns", () => {
  /** Arms a return for player 1's first hand card and passes the turn to them,
   *  which runs their Beginning Phase and the hold that fires it. */
  function armedAndHeld(): { armed: GameState; victim: string } {
    const state = opponentHoldingBf2();
    const victim = state.players[1]!.hand[0]!.instanceId;
    return { armed: banishFromHandUntilHold(state, 1, victim), victim };
  }

  it("waits on the CHAIN as a held trigger, not inline in the Beginning Phase", () => {
    // **383.3.** The blocker this card was refused on was "no general mechanism
    // for a delayed trigger", and an inline mutation at the hold site would have
    // satisfied every other assertion in this file while giving the opponent no
    // response window at all. This is the one that can tell the two apart.
    const { armed, victim } = armedAndHeld();

    const passed = accept(armed, { type: "Pass", playerIndex: 0 });

    expect(passed.players[1]!.points, "nobody held — nothing would have fired either way").toBe(1);
    // Read off the CHAIN, not `pendingTriggers`: the single Cleanup at the end of
    // the Pass has already flushed the pen onto it. Either way the claim is the
    // same one — the ability is an item waiting with a response window open in
    // front of it, which is what an inline mutation would not be.
    expect(
      passed.spellChain.flatMap((e) => ("kind" in e && e.kind === "trigger" ? [e.listenerDefId] : [])),
      "the return did not reach the chain",
    ).toContain(ASHE);
    expect(handIds(passed, 1), "it resolved inline, before anyone could respond").not.toContain(victim);
  });

  it("returns the card to THEIR hand once the chain drains", () => {
    const { armed, victim } = armedAndHeld();

    const settled = resolveHeldTriggers(accept(armed, { type: "Pass", playerIndex: 0 }));

    expect(handIds(settled, 1), "the card did not come back").toContain(victim);
    expect(banishedIds(settled, 1), "it was copied out of the banish zone rather than moved").not.toContain(victim);
    expect(settled.players[1]!.banishedUntilHold, "the arming was not spent").toEqual([]);
    // It is THEIR hand, not the caster's — the half a mirrored index would break.
    expect(handIds(settled, 0), "the card went to Ashe's controller").not.toContain(victim);
  });

  it("returns it after Ashe has been KILLED — the parenthetical, and blocker 3", () => {
    // "**even if I'm no longer on the board**". Three waves hunted for a listener
    // walk that could reach a dead Ashe; there is none and there needs to be none.
    // She is put in the trash here before the hold, and the return is unaffected.
    const { armed, victim } = armedAndHeld();
    const dead = structuredClone(armed);
    dead.players[0]!.trash = [realUnitInstance(ASHE)];

    const settled = resolveHeldTriggers(accept(dead, { type: "Pass", playerIndex: 0 }));

    expect(handIds(settled, 1), "a dead Ashe cancelled her own delayed ability").toContain(victim);
  });

  it("does NOT fire on the CASTER's hold — it is their hold that returns it", () => {
    // The mirror-image error, and it needs its own test: an implementation keyed
    // to the wrong player passes every assertion above, because in those fixtures
    // the holder and the owner are the same person.
    const state = opponentHoldingBf2();
    const victim = state.players[1]!.hand[0]!.instanceId;
    const armed = banishFromHandUntilHold(state, 1, victim);
    // Player 0 holds bf1 instead; player 1 holds nothing.
    armed.battlefields[1]!.controllerId = null;
    armed.battlefields[1]!.units = {};
    armed.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine" })] };
    armed.battlefields[0]!.controllerId = "p1";

    // Pass to player 1 and back, so player 0's own Beginning Phase runs its hold.
    const theirTurn = resolveHeldTriggers(accept(armed, { type: "Pass", playerIndex: 0 }));
    const mineAgain = resolveHeldTriggers(accept(theirTurn, { type: "Pass", playerIndex: 1 }));

    expect(mineAgain.players[0]!.points, "the caster never held — the fixture measures nothing").toBeGreaterThan(0);
    expect(handIds(mineAgain, 1), "the caster's hold returned the opponent's card").not.toContain(victim);
    expect(mineAgain.players[1]!.banishedUntilHold, "the arming was spent by the wrong player's hold").toEqual([victim]);
  });

  it("survives the turn — 'when they hold' names no turn at all", () => {
    // Every other per-turn field on PlayerState is cleared at runEnd, and this one
    // must not be: an opponent who does not hold this turn still owes the card
    // whenever they next do. Asserted across a full turn of both players.
    const { armed, victim } = armedAndHeld();
    armed.battlefields[1]!.controllerId = null;
    armed.battlefields[1]!.units = {};

    const theirTurn = resolveHeldTriggers(accept(armed, { type: "Pass", playerIndex: 0 }));
    const backToMe = resolveHeldTriggers(accept(theirTurn, { type: "Pass", playerIndex: 1 }));

    expect(backToMe.players[1]!.banishedUntilHold, "the arming was cleared with the turn").toEqual([victim]);
    expect(handIds(backToMe, 1), "it came back without a hold").not.toContain(victim);
  });

  it("returns BOTH cards when two are armed", () => {
    // Two Ashes against one opponent arm two delayed abilities. This engine puts
    // ONE chain item that returns both — the same divergence, for the same
    // reason, that `TriggerChainEntry.times` records for Karthus - Eternal.
    const state = opponentHoldingBf2();
    const [a, b] = state.players[1]!.hand.map((c) => c.instanceId);
    const armed = banishFromHandUntilHold(banishFromHandUntilHold(state, 1, a!), 1, b!);
    expect(armed.players[1]!.banishedUntilHold, "the second arming overwrote the first").toEqual([a, b]);

    const settled = resolveHeldTriggers(accept(armed, { type: "Pass", playerIndex: 0 }));
    expect(handIds(settled, 1), "only one of the two came back").toEqual([a, b].sort());
  });
});

describe("arming is refused when there is nothing to banish", () => {
  it("does nothing for a card that is not in that hand", () => {
    // 359.3.e.12 — a check on something no longer available returns null. The
    // decision's options are rebuilt from live state, so this is the shape of a
    // card that left the hand between the reveal and the answer.
    const state = opponentHoldingBf2();
    const after = banishFromHandUntilHold(state, 1, "not-a-card");

    expect(after.players[1]!.banishedUntilHold, "a return was armed for nothing").toEqual([]);
    expect(banishedIds(after, 1), "something was banished out of nowhere").toEqual([]);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(ASHE);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
