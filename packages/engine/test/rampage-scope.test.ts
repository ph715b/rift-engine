import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { targetingForCard } from "../src/engine/card-effects.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **Rampage (VEN-083) reaches a unit in a BASE.**
 *
 * "Choose a friendly unit and an enemy unit. … They deal damage equal to their
 * Mights to each other."
 *
 * Reported from play 2026-08-23: "rampage is unable to cast and I get a message
 * saying I need an enemy and a friendly unit to target when I have both."
 *
 * The card names NO location, and that is the whole question. **355.9.a.1** is
 * the widening — "'Unit,' 'gear,' and 'rune' refer to objects on the Board
 * unless specified otherwise" — and **198.1** is what puts the Bases on the
 * Board. So a bare "a friendly unit" includes one standing at home.
 *
 * `eligibleTargets` defaults `scope` to `"battlefield"`, so a spec that omits it
 * is silently NARROWER than a card that prints nothing. Rampage's entry omitted
 * it deliberately — "the default scope … unlike Facebreaker, whose 'at the same
 * battlefield' is printed" — which is the right contrast drawn from the wrong
 * default: the absence of a printed location is the wide case, not the narrow
 * one.
 *
 * That is the exact shape CLAUDE.md records for `355.9.b` vs `355.9.a.1`: both
 * sub-rules are real, one widens and one narrows, and reaching for the wrong
 * half resolves to a genuine sentence that does not say what is being relied on.
 */

const RAMPAGE = "VEN-083";
const registry = defaultCardRegistry();

/** Rampage in hand and payable, with the two units placed as asked. */
function board(opts: { friendlyInBase?: boolean; enemyInBase?: boolean }): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  const friendly = makeUnit({ instanceId: "mine", name: "Mine", might: 3 });
  const enemy = makeUnit({ instanceId: "theirs", name: "Theirs", might: 3 });

  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: {
      ...(opts.friendlyInBase ? {} : { p1: [friendly] }),
      ...(opts.enemyInBase ? {} : { p2: [enemy] }),
    },
  };
  if (opts.friendlyInBase) state.players[0]!.baseUnits = [friendly];
  if (opts.enemyInBase) state.players[1]!.baseUnits = [enemy];

  state.players[0]!.hand = [createCardInstance(registry.get(RAMPAGE))];
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Body", "Fury", "Calm", "Mind", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

const plays = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === RAMPAGE);

describe("the card is what this file thinks it is", () => {
  it("prints no location for either choice", () => {
    const def = registry.get(RAMPAGE);
    expect(def.name).toBe("Rampage");
    const text = "text" in def ? String(def.text) : "";
    expect(text, "the choose clause has changed").toContain("Choose a friendly unit and an enemy unit");
    // **The premise.** A printing that added "at a battlefield" would make the
    // narrow scope correct and this whole file wrong.
    expect(text.toLowerCase(), "the card now names a location").not.toContain("at a battlefield");
  });

  it("its spec says the choice is board-wide", () => {
    const targeting = targetingForCard(createCardInstance(registry.get(RAMPAGE)));
    expect(targeting?.kind).toBe("unitSlots");
    expect(
      targeting !== undefined && "scope" in targeting ? targeting.scope : undefined,
      "Rampage's scope is not 'anywhere', so a unit in a base cannot be chosen",
    ).toBe("anywhere");
  });
});

describe("it is castable however the two units are standing", () => {
  it("both at a battlefield — the case that already worked", () => {
    expect(plays(board({})).length, "Rampage was unplayable with both units at a battlefield").toBeGreaterThan(0);
  });

  it("the FRIENDLY unit in base — the reported board", () => {
    expect(
      plays(board({ friendlyInBase: true })).length,
      "Rampage refused a friendly unit standing in base — the reported bug",
    ).toBeGreaterThan(0);
  });

  it("the ENEMY unit in base", () => {
    expect(plays(board({ enemyInBase: true })).length, "Rampage refused an enemy unit in base").toBeGreaterThan(0);
  });

  it("BOTH in base", () => {
    expect(
      plays(board({ friendlyInBase: true, enemyInBase: true })).length,
      "Rampage refused two units that were both at home",
    ).toBeGreaterThan(0);
  });
});

describe("the roles are still enforced", () => {
  it("names the friendly unit first and the enemy second", () => {
    // Widening the SCOPE must not loosen the ROLES: slot 0 is "friendly" and
    // slot 1 "enemy", and the resolver pumps the first and reads both Mights.
    // A pair offered the wrong way round would buff the opponent's unit.
    for (const play of plays(board({ friendlyInBase: true }))) {
      expect(play.targetUnitInstanceId, "the first slot was not the friendly unit").toBe("mine");
      expect(play.secondTargetUnitInstanceId, "the second slot was not the enemy unit").toBe("theirs");
    }
  });

  it("never pairs TWO FRIENDLY units, even with two to choose from", () => {
    // **One unit per side cannot see this**, which is what let a mutant swapping
    // `["friendly", "enemy"]` for `["any", "any"]` survive: with a single unit
    // each, symmetric pruning offers one ordering and it happens to be the right
    // one. Two friendlies make the roles observable.
    //
    // It matters beyond enumeration: the resolver pumps the FIRST slot and both
    // units deal their Might to each other, so a friendly-friendly pair would be
    // the caster shooting their own board.
    const state = board({});
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: {
        p1: [makeUnit({ instanceId: "mine", might: 3 }), makeUnit({ instanceId: "mine2", might: 4 })],
        p2: [makeUnit({ instanceId: "theirs", might: 3 })],
      },
    };
    const offered = plays(state);
    expect(offered.length, "nothing was offered, so this proves nothing").toBeGreaterThan(0);
    for (const play of offered) {
      expect(
        [play.targetUnitInstanceId, play.secondTargetUnitInstanceId].filter((id) => id === "mine" || id === "mine2"),
        `a pair of friendly units was offered: ${play.targetUnitInstanceId} + ${play.secondTargetUnitInstanceId}`,
      ).toHaveLength(1);
      expect(play.secondTargetUnitInstanceId, "the enemy did not land in the second slot").toBe("theirs");
    }
    // Both friendly units really were candidates, so the assertion above is not
    // passing because only one pair existed at all.
    expect(
      new Set(offered.map((a) => a.targetUnitInstanceId)),
      "only one friendly unit was ever offered as the first slot",
    ).toEqual(new Set(["mine", "mine2"]));
  });

  it("offers nothing when there is no ENEMY unit at all", () => {
    // The message the player saw is correct on a board that really lacks one —
    // this keeps the fix from turning into "always castable".
    const state = board({});
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [makeUnit({ instanceId: "mine", might: 3 })] } };
    state.players[1]!.baseUnits = [];
    expect(plays(state), "Rampage was offered with no enemy unit anywhere").toHaveLength(0);
  });

  it("offers nothing when there is no FRIENDLY unit at all", () => {
    const state = board({});
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p2: [makeUnit({ instanceId: "theirs", might: 3 })] } };
    state.players[0]!.baseUnits = [];
    expect(plays(state), "Rampage was offered with no friendly unit anywhere").toHaveLength(0);
  });
});

/**
 * **Dragon's Rage (OGN-258) — the second card the audit found, not a report.**
 *
 * "Move an enemy unit. Then do this: Choose another enemy unit at its
 * destination." The first choice names no location, and Charm prints the
 * identical "Move an enemy unit" while carrying `scope: "anywhere"` — same
 * sentence, two answers, which is what made this one visible while fixing
 * Rampage.
 *
 * Its SECOND slot is deliberately untouched: `secondAtDestination` relates it to
 * where the first is going, and that relation is enforced by
 * `secondTargetIsAtDestination`, shared by the enumerator and the validator.
 */
describe("Dragon's Rage reaches an enemy unit in a base", () => {
  const DRAGONS_RAGE = "OGN-258";
  const CHARM = "OGN-043";

  it("prints no location for the unit it moves", () => {
    const def = registry.get(DRAGONS_RAGE);
    expect(def.name).toBe("Dragon's Rage");
    const text = "text" in def ? String(def.text) : "";
    expect(text, "the move clause has changed").toContain("Move an enemy unit");
  });

  it("carries the same scope as Charm, which prints the same sentence", () => {
    // The cross-check that found it. If Charm is ever narrowed, this fails and
    // says so, rather than the two drifting apart again in silence.
    const rage = targetingForCard(createCardInstance(registry.get(DRAGONS_RAGE)));
    const charm = targetingForCard(createCardInstance(registry.get(CHARM)));
    const scopeOf = (t: typeof rage) => (t !== undefined && "scope" in t ? t.scope : undefined);
    expect(scopeOf(charm), "Charm no longer reaches the whole board").toBe("anywhere");
    expect(scopeOf(rage), "Dragon's Rage is narrower than Charm for the same printed sentence").toBe(
      scopeOf(charm),
    );
  });
});
