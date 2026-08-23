import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, resolveHeldTriggers } from "./fixtures.js";

/**
 * **A `[Level N]` triggered ability is gated when it TRIGGERS, not when it
 * resolves — UNL-040 Wuju Apprentice.**
 *
 * "[Hunt] [Level 6][>] When you play me, draw 1."
 *
 * **727.1.c.1**: "Triggered Abilities of Dependent Keywords must be Active for
 * their trigger to be EVALUATED." So the XP question belongs at the moment the
 * play triggers, before the ability becomes a Chain Pending Item. Once it is on
 * the Chain it is independent of what made it (**383.3**, with **377.3.a.1**),
 * so the condition lapsing afterwards must not un-make it — the same shape
 * 727.1.c.3.a spells out for the Activated case.
 *
 * The gate used to be asked in `resolve`, which is wrong in BOTH directions, and
 * the window is the response window his own play opens:
 *
 *  - XP crossing 6 during that window wrongly switched the draw ON.
 *  - XP spent during it wrongly switched an already-triggered draw OFF.
 *
 * Recorded as a divergence since 2026-08-09 and found by a card agent, not by an
 * instrument — nothing here can see it, because the card works on a board where
 * XP does not move.
 *
 * # The one field it needed
 *
 * `UnitTriggerDefinition` carried only `targeting` and `resolve`. Its three
 * siblings — `EventTriggerDefinition`, `DeathWatchDefinition` and
 * `DeathknellDefinition` — all already have an `applies` hook, as do two other
 * definitions in `unit-triggers.ts` itself. The note that recorded this
 * divergence named exactly that, and was right.
 *
 * **UNL-040 is the only card that needs it today**, measured rather than assumed:
 * of the ten `atLevel` call sites, four are continuous Might modifiers (correctly
 * read live), two are spells resolving from the chain, one is an activated
 * ability that resolves inline, and this is the only one inside `unitTriggers`.
 */

const WUJU_APPRENTICE = "UNL-040";
const LEVEL = 6;
const registry = defaultCardRegistry();

/** Wuju Apprentice in hand and payable, with the caster on `xp`. */
function board(xp: number): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.xp = xp;
  state.players[0]!.hand = [createCardInstance(registry.get(WUJU_APPRENTICE))];
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  // A deck to draw from, so "drew 1" is observable rather than an empty-deck no-op.
  state.players[0]!.deck = [createCardInstance(registry.get("OGN-164"))];
  return state;
}

function play(state: GameState): GameState {
  const action = legalActions(state).find(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === WUJU_APPRENTICE,
  );
  expect(action, "Wuju Apprentice was not playable — the fixture measures nothing").toBeDefined();
  const after = submit(state, action!);
  expect(after.result.type, "the play was refused").toBe("Ok");
  return after.state;
}

/** His on-play ability, as a held Pending Item or a chain entry. */
const hisTrigger = (state: GameState) =>
  [...state.pendingTriggers, ...state.spellChain].filter(
    (e) => "listenerDefId" in e && e.listenerDefId === WUJU_APPRENTICE,
  );

const handSize = (state: GameState) =>
  state.players[0]!.hand.filter((c) => c.defId !== WUJU_APPRENTICE).length;

describe("the card is what this file thinks it is", () => {
  it("prints the Level clause", () => {
    const def = registry.get(WUJU_APPRENTICE);
    expect(def.name).toBe("Wuju Apprentice");
    const text = "text" in def ? String(def.text) : "";
    expect(text, "the Level clause has changed").toContain(`[Level ${LEVEL}]`);
    expect(text, "the draw has changed").toContain("draw 1");
  });
});

describe("the gate is asked when the ability TRIGGERS", () => {
  it("places NO pending item below the level", () => {
    // 727.1.c.1 — an Inactive triggered ability is not evaluated, so nothing
    // reaches the Chain at all. This is the assertion that separates "gated at
    // trigger time" from "gated at resolution": the old code held an item and
    // then resolved it to nothing, which costs both players a PassFocus and is
    // visible on the chain.
    const after = play(board(LEVEL - 1));
    expect(hisTrigger(after), "an Inactive Level ability was still put on the chain").toHaveLength(0);
  });

  it("...and DOES place one at exactly the level — the control", () => {
    expect(
      hisTrigger(play(board(LEVEL))),
      "nothing triggered at the threshold, so the assertion above proves nothing",
    ).toHaveLength(1);
  });

  it("draws at the level", () => {
    expect(handSize(resolveHeldTriggers(play(board(LEVEL)))), "no card was drawn at the level").toBe(1);
  });

  it("draws nothing below it", () => {
    expect(handSize(resolveHeldTriggers(play(board(LEVEL - 1)))), "it drew below the level").toBe(0);
  });
});

describe("once triggered, the ability survives the condition lapsing", () => {
  it("still draws when XP is SPENT in the response window", () => {
    // **383.3 / 377.3.a.1** — an ability on the Chain is independent of what made
    // it. The old code re-asked at resolution, so an opponent (or the caster's own
    // spend) could switch off a draw that had already triggered.
    const held = play(board(LEVEL));
    expect(hisTrigger(held), "nothing triggered").toHaveLength(1);
    held.players[0]!.xp = 0; // spent during the window
    expect(handSize(resolveHeldTriggers(held)), "an already-triggered draw was cancelled by losing XP").toBe(1);
  });

  it("does NOT draw when XP crosses the level in the response window", () => {
    // The other direction. Nothing triggered, so there is nothing on the Chain to
    // pay out — reaching the level afterwards is too late. The old code asked at
    // resolution and wrongly drew.
    const state = play(board(LEVEL - 1));
    state.players[0]!.xp = LEVEL + 3; // gained during the window
    expect(handSize(resolveHeldTriggers(state)), "a draw appeared for an ability that never triggered").toBe(0);
  });
});
