import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { targetingForCard } from "../src/engine/card-effects.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **The sweep that followed Rampage: a bare printed noun reaches the whole
 * Board, and an omitted `scope` is not neutral.**
 *
 * `eligibleTargets` defaults `scope` to `"battlefield"`, so a spec that says
 * nothing is NARROWER than a card that prints nothing — exactly backwards.
 * 355.9.a.1 is the widening ("'Unit,' 'gear,' and 'rune' refer to objects on the
 * Board unless specified otherwise") and 198.1 puts the Bases on the Board.
 *
 * VEN-083 Rampage was reported from play; `rampage-scope.test.ts` owns it and
 * OGN-258 Dragon's Rage. This file owns what the follow-up sweep found by
 * checking EVERY scopeless targeting spec against its card's printed text:
 *
 * | kind        | scopeless | genuinely bare |
 * |-------------|-----------|----------------|
 * | `unitSlots` | 8         | 2 (Rampage, Dragon's Rage) |
 * | `unit`      | 32        | 1 (Stand United) |
 * | `unitList`  | 3         | 1 (Decree of Discord) |
 *
 * **The false positives are the useful half of that table.** Most scopeless
 * specs are correct: the card really does print "at a battlefield", "there",
 * "from a battlefield", or names an ATTACKING unit, which is at a battlefield by
 * definition. `unitAndEquipment` hardcodes `"anywhere"` at its call site and
 * `unitOrGear` walks its own list, so neither can carry this defect at all.
 *
 * So the rule for a reviewer is not "every scopeless spec is a bug" — it is
 * "read the printed text, because the default disagrees with silence."
 */

const STAND_UNITED = "OGN-053";
const DECREE_OF_DISCORD = "VEN-107";
const registry = defaultCardRegistry();

const scopeOf = (defId: string) => {
  const t = targetingForCard(createCardInstance(registry.get(defId)));
  return t !== undefined && "scope" in t ? t.scope : undefined;
};

/** The printed text with keyword reminder parentheses stripped. */
const printed = (defId: string) => {
  const def = registry.get(defId);
  const text = "text" in def ? String(def.text) : "";
  return text.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
};

function payable(state: GameState): GameState {
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

describe("Stand United (OGN-053) buffs a friendly unit in a BASE", () => {
  it("prints no location for the unit it buffs", () => {
    // The premise. A printing that added a location would make the narrow scope
    // correct and this whole block wrong.
    const text = printed(STAND_UNITED);
    expect(text, "the buff clause has changed").toContain("Buff a friendly unit");
    expect(text.toLowerCase(), "the card now names a location for the buff").not.toContain(
      "buff a friendly unit at",
    );
  });

  it("its spec is board-wide", () => {
    expect(scopeOf(STAND_UNITED), "Stand United cannot reach a unit standing at home").toBe("anywhere");
  });

  it("is castable with the only friendly unit in base", () => {
    // A buff on a unit in base is the natural play — it is how the unit survives
    // to attack later — and it was unreachable.
    const state = payable(makeState({ phase: "Action", activePlayerIndex: 0 }));
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    state.players[0]!.hand = [createCardInstance(registry.get(STAND_UNITED))];
    const plays = playsOf(state, STAND_UNITED);
    expect(plays.length, "Stand United was unplayable with a friendly unit in base").toBeGreaterThan(0);
    expect(
      plays.map((a) => a.targetUnitInstanceId),
      "the unit in base was not offered as the buff target",
    ).toContain("home");
  });

  it("does not offer an ENEMY unit — the roles are untouched", () => {
    const state = payable(makeState({ phase: "Action", activePlayerIndex: 0 }));
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home" })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs" })];
    state.players[0]!.hand = [createCardInstance(registry.get(STAND_UNITED))];
    expect(
      playsOf(state, STAND_UNITED).filter((a) => a.targetUnitInstanceId === "theirs"),
      "widening the scope let it buff an enemy unit",
    ).toHaveLength(0);
  });
});

describe("Decree of Discord (VEN-107) returns an enemy Order unit from a BASE", () => {
  it("prints only a DOMAIN and a Might cap, no location", () => {
    const text = printed(DECREE_OF_DISCORD);
    expect(text, "the return clause has changed").toContain("Return any number of enemy Order");
    expect(text.toLowerCase(), "the card now names a location").not.toContain("at a battlefield");
  });

  it("its spec is board-wide", () => {
    expect(scopeOf(DECREE_OF_DISCORD), "Decree of Discord cannot reach an enemy unit at home").toBe("anywhere");
  });

  it("offers an enemy Order unit standing in their base", () => {
    const state = payable(makeState({ phase: "Action", activePlayerIndex: 0 }));
    state.players[1]!.baseUnits = [
      makeUnit({ instanceId: "theirs", name: "Theirs", might: 2, domains: ["Order"] }),
    ];
    state.players[0]!.hand = [createCardInstance(registry.get(DECREE_OF_DISCORD))];
    const named = playsOf(state, DECREE_OF_DISCORD).filter((a) =>
      (a.targetUnitInstanceIds ?? []).includes("theirs"),
    );
    expect(named.length, "an enemy Order unit in base could not be returned").toBeGreaterThan(0);
  });

  it("still refuses a unit of the WRONG DOMAIN — the printed narrowing survives", () => {
    // The control that keeps this from reading as "the card got wider". Domain
    // and Might cap are printed; the location was not.
    const state = payable(makeState({ phase: "Action", activePlayerIndex: 0 }));
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "fury", name: "Fury One", might: 2, domains: ["Fury"] })];
    state.players[0]!.hand = [createCardInstance(registry.get(DECREE_OF_DISCORD))];
    expect(
      playsOf(state, DECREE_OF_DISCORD).filter((a) => (a.targetUnitInstanceIds ?? []).includes("fury")),
      "a non-Order unit was offered",
    ).toHaveLength(0);
  });
});

describe("the cards the sweep cleared stay narrow", () => {
  // **The other half of the sweep, asserted rather than described.** Each of
  // these prints a location, so the battlefield default is correct for it — and
  // a future "fix everything scopeless" pass would break them. Naming them here
  // is what stops that being a silent regression.
  const PRINTS_A_LOCATION: readonly [string, string][] = [
    ["OGN-168", "from a battlefield"], // Fight or Flight
    ["UNL-072", "there"], // Crescent Strike
    ["UNL-106", "at a battlefield"], // Repulse
    ["OGN-256", "at a battlefield"], // Fox-Fire
    ["SFD-043", "at a battlefield"], // Emperor's Divide
  ];

  it("each still prints the phrase that justifies its narrow scope", () => {
    for (const [defId, phrase] of PRINTS_A_LOCATION) {
      expect(printed(defId).toLowerCase(), `${defId} no longer prints "${phrase}"`).toContain(phrase);
    }
  });

  it("and none of them was widened", () => {
    for (const [defId] of PRINTS_A_LOCATION) {
      expect(scopeOf(defId), `${defId} was widened despite printing a location`).not.toBe("anywhere");
    }
  });
});
