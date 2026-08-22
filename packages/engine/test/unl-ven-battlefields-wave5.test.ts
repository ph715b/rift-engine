import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { holdBattlefieldTrigger } from "../src/engine/battlefield-abilities.js";
import { returnUnitToHand } from "../src/engine/effect-helpers.js";
import { readFileSync } from "node:fs";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL battlefields, wave 5 — two more new moments.**
 *
 *   UNL-205 Abandoned Hall — when a player plays a SPELL, they may give a unit
 *                            they control here +1 [Might] this turn
 *   UNL-214 Ripper's Bay   — when a unit HERE is returned to a player's hand,
 *                            that player may pay [1 Energy] to channel 1 rune
 *                            exhausted
 *
 * `spellPlayed` is raised for EVERY battlefield rather than for one a spell was
 * aimed at, because Abandoned Hall watches every spell in the game and then acts
 * "here". That makes it the second moment after `endOfTurn` fired for all of
 * them, and the reason its entry needs an `applies` — without one it would place
 * a Pending Item on every spell either player casts, all game.
 *
 * `unitReturnedToHandFrom` is raised from `effect-helpers.returnUnitToHand`, the
 * single funnel every bounce goes through, and BEFORE the removal: the
 * battlefield the unit was standing at is the whole question, and a removed unit
 * has no location.
 *
 * **UNL-211 Forgotten Library is deliberately absent** — see the note in
 * `battlefield-abilities.ts`. It needs a record of what a play COST (nothing
 * tracks that) and access to `[Predict]` (private to `effects/chaos.ts`), and
 * half-building either would be worse than the gate listing it as remaining.
 */

const ABANDONED_HALL = "UNL-205";
const RIPPERS_BAY = "UNL-214";

const rune = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Calm", state });

function board(defId: string, units: UnitInstance[] = [], enemies: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units, p2: enemies } };
  return state;
}

/** Raises the moment directly; the WIRING is asserted separately at the bottom. */
const castSpell = (state: GameState, playerIndex: 0 | 1 = 0) =>
  state.battlefields.reduce((next, bf) => holdBattlefieldTrigger(next, "spellPlayed", bf.id, playerIndex), state);

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [ABANDONED_HALL, "Abandoned Hall", "When a player plays a spell"],
      [RIPPERS_BAY, "Ripper's Bay", "returned to a player's hand"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Abandoned Hall (UNL-205): +1 Might on any spell", () => {
  const mine = () => makeUnit({ instanceId: "m", name: "Mine", might: 3 });

  it("offers your own unit here and pumps it", () => {
    const held = resolveHeldTriggers(castSpell(board(ABANDONED_HALL, [mine()])));
    const pending = pendingDecision(held);
    expect(pending?.kind, "no question was raised").toBe(`${ABANDONED_HALL}-pump`);

    const settled = answerDecision(held, pending!.id, "m")!;
    expect((settled.battlefields[0]!.units.p1 ?? [])[0]!.mightThisTurn, "it was not pumped").toBe(1);
  });

  it("places NO PENDING ITEM when that player has no unit here", () => {
    // Without the `applies`, every spell either player casts all game would place
    // a Pending Item on this battlefield — and the question would then be dropped
    // for having no options, so only the Pending Item shows the difference.
    const raised = castSpell(board(ABANDONED_HALL, [], [makeUnit({ instanceId: "e", name: "Enemy", might: 3 })]));
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed for a player with nothing here",
    ).toHaveLength(0);
  });

  it("...and DOES place one when they have — the control", () => {
    expect(
      castSpell(board(ABANDONED_HALL, [mine()])).pendingTriggers.filter((e) => e.source === "battlefield"),
      "nothing was held at all, so the test above proves nothing",
    ).toHaveLength(1);
  });

  it("fires on the OPPONENT's spell, for the OPPONENT — 'a player ... they'", () => {
    // Either player's spell, and the unit is theirs. A version scoped to the
    // battlefield's controller would be a different card.
    const state = board(ABANDONED_HALL, [mine()], [makeUnit({ instanceId: "e", name: "Enemy", might: 3 })]);
    const held = resolveHeldTriggers(castSpell(state, 1));
    const pending = pendingDecision(held);
    expect(pending?.playerIndex, "the opponent's spell did not offer the opponent the pump").toBe(1);
    expect(optionsFor(held, pending!).map((o) => o.id).sort(), "it offered them MY unit").toEqual(["decline", "e"]);
  });

  it("declining pumps nobody", () => {
    const held = resolveHeldTriggers(castSpell(board(ABANDONED_HALL, [mine()])));
    const settled = answerDecision(held, pendingDecision(held)!.id, "decline")!;
    expect((settled.battlefields[0]!.units.p1 ?? [])[0]!.mightThisTurn, "declining pumped anyway").toBe(0);
  });
});

describe("Ripper's Bay (UNL-214): a rune when a unit here is bounced", () => {
  function bounceable(ownerUnits: UnitInstance[], ready = 1): GameState {
    const state = board(RIPPERS_BAY, ownerUnits);
    state.players[0]!.channeled = Array.from({ length: ready }, (_, i) => rune(`r${i}`));
    state.players[0]!.runeDeck = [rune("deck1")];
    state.players[0]!.floatingEnergy = 0;
    return state;
  }

  it("offers the rune to the unit's OWNER when it is bounced from here", () => {
    const state = bounceable([makeUnit({ instanceId: "m", name: "Mine", might: 3 })]);
    const held = resolveHeldTriggers(returnUnitToHand(state, "m"));
    expect(pendingDecision(held)?.kind, "the bounce raised nothing").toBe(`${RIPPERS_BAY}-channel`);
  });

  it("channels EXHAUSTED when paid", () => {
    const state = bounceable([makeUnit({ instanceId: "m", name: "Mine", might: 3 })]);
    const held = resolveHeldTriggers(returnUnitToHand(state, "m"));
    const settled = answerDecision(held, pendingDecision(held)!.id, "pay")!;

    const gained = settled.players[0]!.channeled.find((r) => r.id === "deck1");
    expect(gained, "no rune was channelled").toBeDefined();
    expect(gained!.state, "it arrived READY — the card says exhausted").toBe("Exhausted");
  });

  it("does NOT fire for a unit bounced from a BASE — the card says 'here'", () => {
    const state = bounceable([]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home", might: 3 })];
    const held = resolveHeldTriggers(returnUnitToHand(state, "home"));
    expect(pendingDecision(held), "a bounce from base triggered it").toBeUndefined();
  });

  it("places no Pending Item when the Energy cannot be paid", () => {
    const state = bounceable([makeUnit({ instanceId: "m", name: "Mine", might: 3 })], 0);
    const raised = returnUnitToHand(state, "m");
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed with nothing to pay with",
    ).toHaveLength(0);
  });

  it("pays the unit's OWNER even when the opponent did the bouncing", () => {
    // "That player" is whose hand it went to. The card rewards the player who
    // lost the body, not the one who caused it — so bouncing an enemy unit off
    // this battlefield hands THEM the rune.
    const state = board(RIPPERS_BAY, [], [makeUnit({ instanceId: "e", name: "Enemy", might: 3 })]);
    state.players[1]!.channeled = [rune("er0")];
    state.players[1]!.runeDeck = [rune("edeck")];
    const held = resolveHeldTriggers(returnUnitToHand(state, "e"));
    expect(pendingDecision(held)?.playerIndex, "the bouncer was paid instead of the owner").toBe(1);
  });
});

describe("both moments are actually WIRED", () => {
  // The half that rots silently: every test above raises its moment directly, so
  // all of them would keep passing if the firing site were deleted and both cards
  // became unreachable in a real game.
  it("execute-play-card raises spellPlayed", () => {
    expect(source("src/actions/execute-play-card.ts"), "the spellPlayed moment is no longer fired").toContain(
      '"spellPlayed"',
    );
  });

  it("returnUnitToHand raises unitReturnedToHandFrom", () => {
    expect(source("src/engine/effect-helpers.ts"), "the bounce moment is no longer fired").toContain(
      '"unitReturnedToHandFrom"',
    );
  });
});

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}
