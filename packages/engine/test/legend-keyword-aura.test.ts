import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { effectiveKeywords, hasKeyword, keywordOnEntry } from "../src/engine/granted-keywords.js";
import type { GameState } from "../src/model/game-state.js";
import type { Keyword } from "../src/model/keyword.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * Rumble - Mechanized Menace (SFD-181) — "Your Mechs have [Shield]."
 *
 * **The pool's first LEGEND-sourced keyword aura**, and the reason `KeywordAura`
 * gained a third `source`. A Legend sits in its own zone rather than on the
 * board, so neither the unit walk nor the gear list could ever find one — the
 * aura simply had no way to say where its source lived.
 *
 * The branch is the shortest of the three because a Legend is ALWAYS in play:
 * there is no "did it leave" question, which is also why `scope: "here"` is
 * meaningless for one (it is never at a battlefield), exactly as for gear.
 *
 * The two tests that matter are the negatives. A tribal aura that grants to
 * everything, or one that reaches an opponent's board, both look like a working
 * card from the granting side.
 */
const RUMBLE_MECHANIZED_MENACE = "SFD-181";
const GEM_JAMMER = "SFD-007"; // a Mech unit
const registry = defaultCardRegistry();

/** Player 0's Legend is Rumble unless `withRumble` is false; a Mech and a
 *  non-Mech stand in their base, and the opponent has a Mech of their own. */
function board(withRumble = true): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  if (withRumble) {
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: RUMBLE_MECHANIZED_MENACE, name: "Rumble - Mechanized Menace" };
  }
  state.players[0]!.baseUnits = [realUnitInstance(GEM_JAMMER), realUnitInstance("OGN-027")];
  state.players[1]!.baseUnits = [realUnitInstance(GEM_JAMMER)];
  return state;
}

const mechOf = (state: GameState, index: 0 | 1) => state.players[index]!.baseUnits.find((u) => u.defId === GEM_JAMMER)!;

describe("Rumble - Mechanized Menace (SFD-181): your Mechs have [Shield]", () => {
  it("grants [Shield] to a friendly Mech from the LEGEND ZONE", () => {
    // The whole point: the source is on no battlefield and in no `activeGear`.
    expect(hasKeyword(board(), mechOf(board(), 0), 0, "Shield"), "the Legend granted nothing").toBe(true);
    expect(hasKeyword(board(false), mechOf(board(false), 0), 0, "Shield"), "the Mech had [Shield] without Rumble").toBe(false);
  });

  it("is TRIBAL — a friendly non-Mech gets nothing", () => {
    // Darius - Trifarian Shield-Breaker carries no Mech tag. An aura that
    // granted to everything would still pass the test above.
    const state = board();
    const nonMech = state.players[0]!.baseUnits.find((u) => u.defId === "OGN-027")!;
    expect(hasKeyword(state, nonMech, 0, "Shield"), "a non-Mech was granted [Shield]").toBe(false);
  });

  it("reads \"YOUR Mechs\" — the opponent's Mech is untouched", () => {
    const state = board();
    expect(hasKeyword(state, mechOf(state, 1), 1, "Shield"), "it reached the opponent's board").toBe(false);
  });

  it("cannot be asked at ENTRY, because [Shield] has a positional granter", () => {
    // Not a gap in this card. `keywordOnEntry` REFUSES any keyword some aura
    // grants positionally, because the answer would depend on a destination the
    // question does not carry — and Taric - Protector (OGN-074) grants [Shield]
    // with `scope: "here"`. Asserted rather than omitted, so the day Taric
    // changes shape this says why the question became askable.
    expect(() => keywordOnEntry(board(), 0, registry.get(GEM_JAMMER), "Shield")).toThrow(/positional aura/);
  });

  it("merges with the unit's printed keywords rather than replacing them", () => {
    const state = board();
    const granted = effectiveKeywords(state, mechOf(state, 0), 0);
    expect(granted).toHaveProperty("Shield");
    // Read off the INSTANCE, not `registry.get`: `keywords` is declared on
    // UnitDefinition and `get` returns the CardDefinition union.
    for (const printed of Object.keys(realUnitInstance(GEM_JAMMER).keywords ?? {})) {
      expect(granted, `the printed ${printed} was dropped`).toHaveProperty(printed);
    }
  });

  it("is reported implemented, with no partial note", () => {
    expect(isCardImplemented(registry.get(RUMBLE_MECHANIZED_MENACE))).toBe(true);
    expect(partialImplementationNote(registry.get(RUMBLE_MECHANIZED_MENACE))).toBeUndefined();
  });
});

/**
 * A SWEEP, not a card test — the negative above widened into an invariant.
 *
 * `auraGrantedKeywords` consulted `aura.appliesTo` but never `aura.appliesToDef`
 * until 2026-08-06, so EVERY tribal aura in `KEYWORD_AURAS` granted its keyword
 * to every friendly unit rather than to the tribe. Three existing cards were
 * affected — Forecaster, Breakneck Mech and Rumble - Hotheaded — and every test
 * they had passed, because each asserted only that the MECH got the keyword.
 *
 * This asserts the other side for all of them at once, so a fourth tribal aura
 * added later cannot reintroduce it.
 */
describe("every tribal aura is actually tribal", () => {
  const NON_MECH = "OGN-027"; // Darius - Trifarian: no Mech tag, no printed keywords

  /** `sourceDefId` in play for player 0, plus a Mech and a non-Mech in base. */
  function withSource(sourceDefId: string): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [
      realUnitInstance(GEM_JAMMER),
      realUnitInstance(NON_MECH),
      realUnitInstance(sourceDefId),
    ];
    return state;
  }

  const TRIBAL: readonly (readonly [string, string, Keyword])[] = [
    ["SFD-065", "Forecaster", "Vision"],
    ["SFD-071", "Breakneck Mech", "Deflect"],
    ["SFD-026", "Rumble - Hotheaded", "Assault"],
  ];

  for (const [defId, name, keyword] of TRIBAL) {
    it(`${name} grants [${keyword}] to the Mech and NOT to the non-Mech`, () => {
      const state = withSource(defId);
      const mech = state.players[0]!.baseUnits.find((u) => u.defId === GEM_JAMMER)!;
      const other = state.players[0]!.baseUnits.find((u) => u.defId === NON_MECH)!;
      // The positive is the premise check: an aura whose source failed to be
      // found would make the negative pass for the wrong reason.
      expect(hasKeyword(state, mech, 0, keyword), `${name} granted the Mech nothing`).toBe(true);
      expect(hasKeyword(state, other, 0, keyword), `${name} granted a NON-Mech [${keyword}]`).toBe(false);
    });
  }
});
