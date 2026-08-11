import { describe, expect, it } from "vitest";
import { placeToken, placeGoldTokens, RECRUIT_TOKEN } from "../src/engine/token.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Two cards finished on 2026-08-10 with no new primitive between them, and both
 * had been REFUSED by card agents for mechanisms that turned out to be rows.
 *
 * **UNL-058 Lillia - Protector of Dreams** was refused TWICE, and neither refusal
 * was wrong when it was made: `placeToken` held no event at all, so "when you
 * play a token unit" could not be observed, and `KEYWORD_AURAS` had no way to ask
 * about the recipient's token nature. The first is fixed by the `isToken` field
 * on `cardPlayed`; the second by `appliesTo`, which already existed for Spirit's
 * Refuge's "buffed" and needed only to be pointed at `unit.isToken`.
 *
 * **UNL-091 Concentrate** was recorded as needing "a cost-modifiers entry", which
 * was exactly right and exactly that small — `modifiedEnergyCost` already takes
 * `state`, so reading XP needed no plumbing.
 *
 * # The two things worth testing rather than assuming
 *
 * Lillia is the pool's only POSITIVE reader of `isToken`; the three card-readers
 * are all negative. So a build that inverted the flag would leave those three
 * looking fine and break only her — which is why the gear-token negative below
 * matters as much as the unit-token positive.
 *
 * Concentrate prints "**instead**", so the deeper `[Level]` tier REPLACES the
 * shallower one: -4 at 11+ XP, never -6. That is the whole subtlety of the card
 * and it is asserted at every boundary rather than at one convenient value.
 */

const registry = defaultCardRegistry();

const LILLIA = "UNL-058";
const CONCENTRATE = "UNL-091";
const CONCENTRATE_PRINTED_ENERGY = 5;

const everyUnit = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
];

const find = (state: GameState, instanceId: string): UnitInstance | undefined =>
  everyUnit(state).find((u) => u.instanceId === instanceId);

const settle = (state: GameState): GameState => answerDecisions(resolveHeldTriggers(state));

function withLillia(): { state: GameState; lillia: UnitInstance } {
  const lillia = realUnitInstance(LILLIA);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.baseUnits = [lillia];
  return { state, lillia };
}

describe("Lillia - Protector of Dreams (UNL-058): when you play a token unit, +1 Might", () => {
  it("grows when a token unit is played", () => {
    const { state, lillia } = withLillia();
    const settled = settle(placeToken(state, 0, "base", RECRUIT_TOKEN));

    expect(find(settled, lillia.instanceId)!.mightThisTurn, "the token play did not reach her").toBe(1);
  });

  it("grows once PER token — she prints no cap", () => {
    // Three tokens is +3, each its own held item. Asserted because "no cap" is a
    // claim about the card and a once-per-turn guard would be invisible at one.
    const { state, lillia } = withLillia();
    let next = state;
    for (let i = 0; i < 3; i += 1) next = placeToken(next, 0, "base", RECRUIT_TOKEN);

    expect(find(settle(next), lillia.instanceId)!.mightThisTurn).toBe(3);
  });

  it("does NOT grow for a GEAR token — she says token UNIT", () => {
    // A Gold gear token is also a played token, so `isToken` alone would fire
    // her. This is the assertion that proves `playedKind` is being asked too.
    const { state, lillia } = withLillia();
    const settled = settle(placeGoldTokens(state, 0, 2));

    expect(find(settled, lillia.instanceId)!.mightThisTurn, "a gear token counted as a token unit").toBe(0);
  });

  it("does NOT grow for an OPPONENT's token — 'when YOU play'", () => {
    const { state, lillia } = withLillia();
    const settled = settle(placeToken(state, 1, "base", RECRUIT_TOKEN));

    expect(find(settled, lillia.instanceId)!.mightThisTurn, "an opponent's Recruit pumped her").toBe(0);
  });

  it("does NOT grow for a real card being played — 185: a token is not a card, and this wants a token", () => {
    // The mirror of the three card-reading listeners. She is the pool's only
    // POSITIVE reader of `isToken`, so an inverted flag would break only her.
    const { state, lillia } = withLillia();
    // A real unit play, identical in every field except token nature.
    const asRealCard = settle(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 0,
        playedKind: "Unit",
        playedInstanceId: "a-real-unit",
        playedPowerCost: 0,
        isToken: false,
      }),
    );

    expect(find(asRealCard, lillia.instanceId)!.mightThisTurn, "a real card fired her token trigger").toBe(0);
  });
});

describe("Lillia's second sentence: your token units have [Tank]", () => {
  it("a token unit anywhere on the board has [Tank] while she is out", () => {
    // "Your token units" with no location clause — 355.9.a.1 widens a bare noun
    // to the whole Board, so a token in base is covered.
    const { state } = withLillia();
    const withToken = placeToken(state, 0, "base", RECRUIT_TOKEN);
    const token = withToken.players[0]!.baseUnits.find((u) => u.isToken)!;

    expect(hasKeyword(withToken, token, 0, "Tank"), "the aura did not reach a token in base").toBe(true);
  });

  it("a NON-token unit does not get it — the aura's whole condition", () => {
    const { state } = withLillia();
    const plain = makeUnit({ name: "Plain" });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, plain];

    expect(hasKeyword(state, plain, 0, "Tank"), "the aura reached a real card").toBe(false);
  });

  it("and the token loses it when Lillia is gone — the aura is continuous, not a grant", () => {
    // The control that separates an aura from a one-shot: remove the source and
    // the keyword must go with her. Without this, a `grantKeywordThisTurn` at
    // entry would pass every assertion above.
    const { state, lillia } = withLillia();
    const withToken = placeToken(state, 0, "base", RECRUIT_TOKEN);
    const token = withToken.players[0]!.baseUnits.find((u) => u.isToken)!;
    expect(hasKeyword(withToken, token, 0, "Tank")).toBe(true);

    const withoutHer: GameState = {
      ...withToken,
      players: [
        { ...withToken.players[0]!, baseUnits: withToken.players[0]!.baseUnits.filter((u) => u.instanceId !== lillia.instanceId) },
        withToken.players[1]!,
      ],
    };
    expect(hasKeyword(withoutHer, token, 0, "Tank"), "the [Tank] outlived its source").toBe(false);
  });

  it("an OPPONENT's token is not covered — 'YOUR token units'", () => {
    const { state } = withLillia();
    const theirs = placeToken(state, 1, "base", RECRUIT_TOKEN);
    const token = theirs.players[1]!.baseUnits.find((u) => u.isToken)!;

    expect(hasKeyword(theirs, token, 1, "Tank"), "the aura crossed to the opponent's tokens").toBe(false);
  });
});

describe("Concentrate (UNL-091): [Level 6] -2, [Level 11] -4 INSTEAD", () => {
  const costAt = (xp: number): number => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.xp = xp;
    return modifiedEnergyCost(state, 0, "Spell", CONCENTRATE_PRINTED_ENERGY, CONCENTRATE);
  };

  it("costs the printed 5 below 6 XP", () => {
    expect(costAt(0)).toBe(CONCENTRATE_PRINTED_ENERGY);
    // The boundary BELOW the first tier, which is where an off-by-one lives.
    expect(costAt(5), "the [Level 6] tier fired at 5 XP").toBe(CONCENTRATE_PRINTED_ENERGY);
  });

  it("costs 2 less from exactly 6 XP", () => {
    expect(costAt(6), "the [Level 6] tier did not fire at exactly 6").toBe(3);
    expect(costAt(10)).toBe(3);
  });

  it("costs 4 less — NOT 6 — from exactly 11 XP, because the card says 'instead'", () => {
    // The whole subtlety. Both `[Level]` clauses are active at 11+ XP (824 makes
    // each active while its threshold is met), and the printed "instead" is the
    // only thing that stops them stacking to -6.
    expect(costAt(11), "the [Level 11] tier did not fire at exactly 11").toBe(1);
    expect(costAt(30), "the tiers stacked — 'instead' was not honoured").toBe(1);
  });

  it("never goes below 0", () => {
    // A floor the card does not print, so it is the engine's rather than the
    // card's — asserted on a synthetic cheap cost so it cannot pass by accident
    // of Concentrate's printed 5 being large enough.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.xp = 11;
    expect(modifiedEnergyCost(state, 0, "Spell", 2, CONCENTRATE)).toBe(0);
  });

  it("leaves other cards alone", () => {
    // The discount is keyed by defId, and a widening that dropped the key would
    // silently discount the pool.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.xp = 30;
    expect(modifiedEnergyCost(state, 0, "Spell", 5, "OGN-001"), "the tier leaked onto another card").toBe(5);
  });
});

describe("both cards now report finished", () => {
  it("Lillia and Concentrate are whole", () => {
    for (const defId of [LILLIA, CONCENTRATE]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is greyed again`).toBe(true);
    }
  });
});
