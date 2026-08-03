import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { runCleanup } from "../src/engine/cleanup.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * A unit's "when you play me" ability is a Chain **Pending Item** (383 /
 * 809.1.b.3), not something that happens as the unit lands.
 *
 * This is the file that asserts the TIMING. Every other test that plays a unit
 * settles the chain through a helper, deliberately — they are about what a card
 * does, and re-asserting the machinery in each of them would mean 48 cards'
 * tests all failing for one reason the next time it changes.
 *
 * What the conversion buys a player: an opponent can finally respond to a unit's
 * arrival trigger. Before this, every "when you play me" resolved inside the
 * executor, so a Reaction could never answer one — which quietly devalued the
 * whole counter archetype.
 */

const LECTURING_YORDLE = "OGN-087"; // "[Tank] When you play me, draw 1." — the simplest observable trigger
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** The Yordle in hand with runes to pay, and a deck to draw from. */
function yordleState(): GameState {
  const state = makeState({ phase: "Action" });
  const yordle = realUnitInstance(LECTURING_YORDLE);
  state.players[0]!.hand = [yordle];
  state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`r${i}`, "Body"));
  state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
  return state;
}

function play(state: GameState): GameState {
  const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === LECTURING_YORDLE);
  expect(action, "the Yordle was never enumerated as playable").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const triggersOn = (state: GameState) => state.spellChain.filter((e) => e.kind === "trigger");

describe("an on-play unit trigger waits on the chain", () => {
  it("does NOT resolve as the unit lands", () => {
    const played = play(yordleState());

    expect(played.players[0]!.baseUnits.map((u) => u.defId), "the unit itself should arrive immediately").toContain(
      LECTURING_YORDLE,
    );
    expect(played.players[0]!.hand, "the draw happened at play time").toHaveLength(0);
  });

  it("is on the chain, named, as a Pending Item", () => {
    const played = play(yordleState());
    const held = triggersOn(played);

    expect(held).toHaveLength(1);
    expect(held[0]!.listenerDefId).toBe(LECTURING_YORDLE);
    expect(held[0]!.source, "it was held as an event trigger rather than an on-play one").toBe("unitOnPlay");
    expect(held[0]!.listenerName, "the chain viewer has nothing to render").toBeTruthy();
  });

  it("opens a response window — the chain is CLOSED and someone must pass", () => {
    // The whole point of the conversion. A closed chain is what makes a Reaction
    // castable in answer to the trigger.
    const played = play(yordleState());

    expect(played.chainOpen).toBe(false);
    expect(legalActions(played).some((a) => a.type === "PassFocus"), "nobody could respond or pass").toBe(true);
  });

  it("resolves once the chain is passed out", () => {
    const settled = resolveHeldTriggers(play(yordleState()));

    expect(settled.players[0]!.hand.map((c) => c.name), "the draw never landed").toEqual(["Drawn"]);
    expect(triggersOn(settled), "it is still waiting").toHaveLength(0);
  });

  it("still resolves when its source is KILLED in the window (809.1.b)", () => {
    // Once a triggered ability is on the Chain it is independent of its source.
    // An opponent who answers the arrival by killing the unit removes the body,
    // not the ability — the opposite of an event-registry trigger, which bails
    // when its LISTENER has left play because that listener is a bystander.
    const played = play(yordleState());
    const yordleId = played.players[0]!.baseUnits.find((u) => u.defId === LECTURING_YORDLE)!.instanceId;

    const settled = resolveHeldTriggers(destroyUnit(played, yordleId, 1));

    expect(settled.players[0]!.hand.map((c) => c.name), "killing the unit cancelled its ability").toEqual(["Drawn"]);
    expect(settled.players[0]!.trash.some((c) => c.defId === LECTURING_YORDLE), "it should still have died").toBe(true);
  });

  it("a unit with NO trigger puts nothing on the chain", () => {
    // The control that keeps the assertions above meaningful: they would all
    // pass just as well if every unit play closed the chain.
    const state = makeState({ phase: "Action" });
    const plain = makeUnit({ instanceId: "plain", might: 3 });

    const played = runCleanup(dispatchOnPlayUnit(state, plain, 0, "base", {}));
    expect(triggersOn(played)).toHaveLength(0);
    expect(played.chainOpen, "an empty chain was left closed").toBe(true);
  });
});

describe("what is deliberately NOT held yet", () => {
  it("[Vision] still resolves inline, one family behind", () => {
    // Vision is a keyword whose "predict" the rules describe as its own trigger,
    // so by the letter it should be held too. It is not, because a family at a
    // time is what keeps a termination regression bisectable — recorded in
    // docs/rules-conformance.md rather than left to be discovered.
    //
    // Mystic Poro (OGN-171) has [Vision] and no other on-play text, so the deck
    // moving at play time IS the inline resolution.
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = [makeUnit({ name: "Top" }), makeUnit({ name: "Second" })];
    const poro = realUnitInstance("OGN-171");

    const played = dispatchOnPlayUnit(state, poro, 0, "base", { visionRecycle: true });

    expect(played.players[0]!.deck[0]!.name, "Vision was held rather than resolved inline").toBe("Second");
    expect(triggersOn(played), "Vision put something on the chain").toHaveLength(0);
  });
});
