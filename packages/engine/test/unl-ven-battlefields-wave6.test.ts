import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { rainbowSurchargeForPlay } from "../src/engine/cost-modifiers.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **VEN battlefields, wave 6 — the three that change what a play COSTS.**
 *
 *   VEN-158 Heisho, Shell of the World — players ignore [Deflect] while paying
 *                                        for spells and abilities choosing
 *                                        something here
 *   VEN-164 Sandswept Tomb             — each spell that chooses one or more units
 *                                        here friendly to it costs [1 rainbow] less
 *   VEN-160 Mystic Vortex              — during showdowns here, cards with
 *                                        [Reaction] cost [1 rainbow] more
 *
 * All three land in `rainbowSurchargeForPlay`, the ONE function that prices a
 * play's rainbow term. That matters more than tidiness: this codebase's
 * offered-then-refused bugs all come from an enumerator and a validator pricing
 * the same play differently, and both go through this.
 *
 * Tested at that function rather than through a full play, because a full play
 * would depend on a payable board, a legal destination and a target list as well
 * as on the battlefield — and the three cards are exactly a claim about this
 * function's arithmetic. The WIRING (that both callers pass the Reaction flag) is
 * asserted separately at the bottom.
 */

const HEISHO = "VEN-158";
const SANDSWEPT_TOMB = "VEN-164";
const MYSTIC_VORTEX = "VEN-160";

/** A unit with `[Deflect]`, which is what makes a target cost extra to choose. */
const deflector = (instanceId: string) =>
  makeUnit({ instanceId, name: "Deflector", might: 3, keywords: { Deflect: 1 } });

/** bf1 IS the named battlefield; `mine` stand there for p1 and `theirs` for p2. */
function at(defId: string | undefined, mine: UnitInstance[] = [], theirs: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    ...(defId !== undefined ? { defId } : {}),
    units: { p1: mine, p2: theirs },
  };
  return state;
}

const priceOf = (state: GameState, chosen: string[], isReaction = false) =>
  rainbowSurchargeForPlay(state, 0, "Spell", chosen, undefined, isReaction);

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [HEISHO, "Heisho, Shell of the World", "ignore [Deflect]"],
      [SANDSWEPT_TOMB, "Sandswept Tomb", "friendly to it"],
      [MYSTIC_VORTEX, "Mystic Vortex", "[Reaction]"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Heisho (VEN-158): [Deflect] is ignored for targets standing here", () => {
  it("charges the [Deflect] surcharge at an ORDINARY battlefield — the control", () => {
    // Without this, "Heisho costs 0" below could be true of any board at all.
    expect(priceOf(at(undefined, [], [deflector("d")]), ["d"]), "an enemy Deflect cost nothing to choose").toBe(1);
  });

  it("...and NOT at Heisho", () => {
    expect(priceOf(at(HEISHO, [], [deflector("d")]), ["d"]), "Heisho did not waive the surcharge").toBe(0);
  });

  it("waives it PER TARGET, not for the whole payment", () => {
    // 764-766's ignore mechanism is positional here rather than per-card, so a
    // spell choosing one unit at Heisho and one elsewhere still owes the second.
    // A version that short-circuited the whole payment — the shape Decree of
    // Insight legitimately uses — would read 0.
    const state = at(HEISHO, [], [deflector("here")]);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p2: [deflector("far")] } };
    expect(priceOf(state, ["here", "far"]), "the far Deflect was waived too").toBe(1);
  });
});

describe("Sandswept Tomb (VEN-164): a spell choosing your own unit here costs less", () => {
  it("discounts a spell that chose a FRIENDLY unit here", () => {
    // The surcharge total goes NEGATIVE, which is the discount — the caller
    // floors the final price, so this asserts the term rather than a price.
    expect(priceOf(at(SANDSWEPT_TOMB, [makeUnit({ instanceId: "m", name: "Mine", might: 3 })]), ["m"]), "no discount").toBe(
      -1,
    );
  });

  it("does NOT discount a spell choosing the OPPONENT's unit here — 'friendly to it'", () => {
    const state = at(SANDSWEPT_TOMB, [], [makeUnit({ instanceId: "t", name: "Theirs", might: 3 })]);
    expect(priceOf(state, ["t"]), "an enemy unit earned the caster a discount").toBe(0);
  });

  it("applies ONCE for two friendly units here — 'one or more'", () => {
    const state = at(SANDSWEPT_TOMB, [
      makeUnit({ instanceId: "a", name: "A", might: 3 }),
      makeUnit({ instanceId: "b", name: "B", might: 3 }),
    ]);
    expect(priceOf(state, ["a", "b"]), "the discount stacked per unit").toBe(-1);
  });

  it("nets against a [Deflect] surcharge rather than being applied elsewhere", () => {
    // A spell that both taxes and discounts must come out at 0, not pay twice.
    const state = at(SANDSWEPT_TOMB, [makeUnit({ instanceId: "m", name: "Mine", might: 3 })], [deflector("d")]);
    expect(priceOf(state, ["m", "d"]), "the two terms did not net").toBe(0);
  });
});

describe("Mystic Vortex (VEN-160): [Reaction] costs more during a showdown here", () => {
  function showdownAt(defId: string | undefined, where: string | null): GameState {
    const state = at(defId);
    return { ...state, turnState: "Showdown", showdownKind: "Combat", showdownBattlefieldId: where };
  }

  it("taxes a [Reaction] play while a showdown runs here", () => {
    expect(priceOf(showdownAt(MYSTIC_VORTEX, "bf1"), [], true), "the Reaction was not taxed").toBe(1);
  });

  it("does NOT tax a non-Reaction play — the control", () => {
    expect(priceOf(showdownAt(MYSTIC_VORTEX, "bf1"), [], false), "an Action-speed play was taxed").toBe(0);
  });

  it("does NOT tax while the showdown is at ANOTHER battlefield", () => {
    expect(priceOf(showdownAt(MYSTIC_VORTEX, "bf2"), [], true), "it taxed a fight somewhere else").toBe(0);
  });

  it("does NOT tax outside a showdown", () => {
    expect(priceOf(at(MYSTIC_VORTEX), [], true), "it taxed with no showdown running").toBe(0);
  });

  it("does NOT tax on a STALE battlefield id, and the invariant that makes that unreachable", () => {
    // **Recorded rather than tidied away.** `reactionSurchargeNow` guards on
    // `turnState !== "Showdown"` before it looks at `showdownBattlefieldId`, and
    // mutation-testing shows that guard is redundant against today's engine:
    // `execute-pass-focus` is the ONLY transition to Neutral and it nulls the id
    // in the same object, so "Neutral with a battlefield still named" cannot
    // arise and the id lookup alone would answer 0.
    //
    // The guard stays, because it states the card's condition ("during
    // showdowns") directly and is what a reader checks it against. What is
    // asserted instead is the INVARIANT that makes it redundant — so a second
    // Neutral transition that forgets to clear the id fails HERE, with a message
    // saying the guard has started to matter, rather than silently taxing every
    // Reaction for the rest of the game.
    const stale: GameState = { ...at(MYSTIC_VORTEX), turnState: "Neutral", showdownBattlefieldId: "bf1" };
    expect(priceOf(stale, [], true), "a stale showdown id taxed a Reaction outside a fight").toBe(0);

    const closing = source("src/actions/execute-pass-focus.ts");
    expect(
      /turnState: "Neutral",\s*\r?\n\s*showdownBattlefieldId: null,/.test(closing),
      "closing a showdown no longer clears the battlefield id in the same step — the guard above is now load-bearing",
    ).toBe(true);
  });
});

describe("the Reaction flag is actually WIRED to both pricers", () => {
  // Both the enumerator and the validator must pass it, or Mystic Vortex prices
  // one way when a play is OFFERED and another when it is CHECKED — the
  // offered-then-refused shape this repo has produced three times.
  it("legal-actions derives and passes it", () => {
    const src = source("src/engine/legal-actions.ts");
    expect(src, "the enumerator no longer derives a Reaction flag").toContain("const reactionPlay =");
    expect(src, "the enumerator does not pass it to the pricer").toContain("reactionPlay,");
  });

  it("validate-play-card derives and passes it", () => {
    expect(source("src/actions/validate-play-card.ts"), "the validator no longer passes a Reaction flag").toContain(
      'timingTierOf(card) === "Reaction"',
    );
  });
});

function source(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}
