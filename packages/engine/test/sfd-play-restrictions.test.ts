import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { mayPlayUnitToBase, mayPlayUnitToBattlefield } from "../src/engine/timing.js";
import { mayPlaceWithoutPresence } from "../src/engine/unit-triggers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * The two card-keyed play restrictions, and they point opposite ways.
 *
 * Rengar - Pouncing GRANTS a destination the ordinary rules forbid, so he is a
 * `PLACEMENT_GRANTS` row. Perched Grimwyrm NARROWS his destinations to one set —
 * and "(You can't play me anywhere else.)" makes the narrowing total, so BASE is
 * refused too. That is why Grimwyrm could not be a row in that table, whose
 * default answer is "the ordinary rules apply".
 *
 * Both are asserted through the ENUMERATOR as well as the predicate, because a
 * restriction the enumerator does not know is a play offered and then refused —
 * the failure this codebase has shipped three times.
 */

const registry = defaultCardRegistry();

const PERCHED_GRIMWYRM = "SFD-015";
const RENGAR_POUNCING = "SFD-025";

const runes = (n: number, domain: RuneCard["domain"] = "Fury"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

function board(defId: string): { state: GameState; cardInstanceId: string } {
  const card = realUnitInstance(defId);
  const state = makeState({ phase: "Action", turnState: "Neutral" });
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = runes(8);
  state.players[0]!.floatingEnergy = 8;
  return { state, cardInstanceId: card.instanceId };
}

const playsOf = (state: GameState, cardInstanceId: string) =>
  legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === cardInstanceId) as PlayCardAction[];

describe("Perched Grimwyrm (SFD-015): only to a battlefield you conquered this turn", () => {
  it("may not be played to a battlefield NOT conquered this turn", () => {
    const { state } = board(PERCHED_GRIMWYRM);
    expect(mayPlayUnitToBattlefield(state, 0, "bf1", PERCHED_GRIMWYRM), "an unconquered battlefield was allowed").toBe(
      false,
    );
  });

  it("MAY be played to one conquered this turn", () => {
    const { state } = board(PERCHED_GRIMWYRM);
    state.players[0]!.conqueredBattlefieldsThisTurn = ["bf1"];
    expect(mayPlayUnitToBattlefield(state, 0, "bf1", PERCHED_GRIMWYRM), "a conquered battlefield was refused").toBe(
      true,
    );
  });

  /** "(You can't play me anywhere else.)" — the narrowing is TOTAL, so base is
   *  refused as well. That parenthetical is the whole reason this could not be a
   *  `PLACEMENT_GRANTS` row. */
  it("has NO base play at all", () => {
    expect(mayPlayUnitToBase(PERCHED_GRIMWYRM), "base was allowed").toBe(false);
  });

  it("is not OFFERED a base play by the enumerator", () => {
    const { state, cardInstanceId } = board(PERCHED_GRIMWYRM);
    const offered = playsOf(state, cardInstanceId);

    expect(
      offered.filter((a) => a.destinationBattlefieldId === undefined),
      "a base play was offered",
    ).toHaveLength(0);
  });

  /** The validator must refuse the same play the enumerator withholds, or a
   *  hand-built action walks straight past it. */
  it("is REFUSED a base play by the validator", () => {
    const { state, cardInstanceId } = board(PERCHED_GRIMWYRM);
    const card = state.players[0]!.hand[0]!;
    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: { energyRunes: [], powerRunes: [] },
    });

    expect(result.ok, "a hand-built base play was accepted").toBe(false);
    void cardInstanceId;
  });

  /** The ordinary rules are untouched for every other card. */
  it("does not restrict an ordinary unit's base play", () => {
    expect(mayPlayUnitToBase(RENGAR_POUNCING)).toBe(true);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(PERCHED_GRIMWYRM))).toBe(true);
  });
});

describe("Rengar - Pouncing (SFD-025): may be played to a battlefield you're ATTACKING", () => {
  /** `contestedByIndex` IS the Attacker designation (464.2.c Step 1). */
  function attacking(state: GameState, index: 0 | 1 | null): GameState {
    state.battlefields[0]!.contestedByIndex = index;
    return state;
  }

  it("may be placed at a battlefield he is attacking, with no presence there", () => {
    const { state } = board(RENGAR_POUNCING);
    const bf = attacking(state, 0).battlefields[0]!;

    expect(mayPlaceWithoutPresence(state, 0, RENGAR_POUNCING, bf), "the grant did not apply").toBe(true);
  });

  /** "A battlefield YOU'RE attacking" — the opponent's attack is not yours. */
  it("does NOT apply where the OPPONENT is the attacker", () => {
    const { state } = board(RENGAR_POUNCING);
    const bf = attacking(state, 1).battlefields[0]!;

    expect(mayPlaceWithoutPresence(state, 0, RENGAR_POUNCING, bf), "he rode the opponent's attack").toBe(false);
  });

  it("does NOT apply at an uncontested battlefield", () => {
    const { state } = board(RENGAR_POUNCING);
    const bf = attacking(state, null).battlefields[0]!;

    expect(mayPlaceWithoutPresence(state, 0, RENGAR_POUNCING, bf), "he was placed with no attack at all").toBe(false);
  });

  /** The grant is his, not everyone's — a card with no entry gets the ordinary
   *  presence rule. */
  it("does not grant the same placement to another unit", () => {
    const { state } = board(RENGAR_POUNCING);
    const bf = attacking(state, 0).battlefields[0]!;

    expect(mayPlaceWithoutPresence(state, 0, PERCHED_GRIMWYRM, bf), "the grant leaked to another card").toBe(false);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(RENGAR_POUNCING))).toBe(true);
  });
});
