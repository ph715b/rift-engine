import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { runBeginning, runEnd } from "../src/engine/turn-manager.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { mayPlaySpells } from "../src/engine/board-restrictions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Two cards, one shape: a this-turn fact nothing recorded.**
 *
 *   - **Shadow Watcher (UNL-037)** — "If a friendly unit died during YOUR
 *     BEGINNING PHASE this turn, I enter ready." `unitsLostThisTurn` is strictly
 *     wider and cannot stand in.
 *   - **Lilting Lullaby (UNL-190)** — "…its controller can't play SPELLS this
 *     turn." `cannotPlayCardsThisTurn` stops every card, which is wider than
 *     printed.
 *
 * Both bans and both counters are facts about the TURN rather than continuous
 * abilities, so both are armed where they happen and swept by `runEnd` — killing
 * the source in response must not undo them.
 */

const registry = defaultCardRegistry();
const SHADOW_WATCHER = "UNL-037";
const LILTING_LULLABY = "UNL-190";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

describe("Shadow Watcher (UNL-037): a death in YOUR Beginning Phase", () => {
  /** Player 0's Beginning Phase with a doomed [Temporary] unit of theirs. */
  function beginningWithDeath(activePlayerIndex: 0 | 1): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex });
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "doomed", name: "Doomed", might: 2, keywords: { Temporary: 1 } }),
    ];
    return state;
  }

  it("enters ready after a Temporary unit dies in that phase", () => {
    // The [Temporary] sweep is the reachable case the refusal named — it kills in
    // the Beginning Phase, which is exactly the window this counts.
    const after = runBeginning(beginningWithDeath(0));
    expect(after.players[0]!.unitsLostInBeginningPhaseThisTurn, "the death was not counted").toBe(1);
    expect(
      unitEntersReady(after, 0, realUnitInstance(SHADOW_WATCHER), undefined, "base"),
      "he arrived exhausted after a Beginning-Phase death",
    ).toBe(true);
  });

  it("does NOT count a death in the OPPONENT's Beginning Phase", () => {
    // **This test was VACUOUS as first written and mutation said so.** It drove
    // `runBeginning` with the opponent active — but the [Temporary] sweep only
    // touches the ACTIVE player's units, so player 0's unit never died and the
    // assertion passed because nothing happened at all. Dropping the seat check
    // from the engine survived it.
    //
    // Rewritten to kill the unit DIRECTLY in that phase and seat, which is the
    // reachable case: an effect killing your unit during the opponent's
    // Beginning Phase. The positive control below is what makes the zero mean
    // "the seat was checked" rather than "nothing died".
    const state = makeState({ phase: "Beginning", activePlayerIndex: 1 });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Victim", might: 2 })];

    const after = destroyUnit(state, "victim");
    expect(after.players[0]!.unitsLostThisTurn, "the unit did not die — this proves nothing").toBe(1);
    expect(after.players[0]!.unitsLostInBeginningPhaseThisTurn, "a death in the ENEMY's phase counted").toBe(0);
  });

  it("does NOT count a death outside the Beginning Phase", () => {
    // The distinction that made `unitsLostThisTurn` insufficient: a combat death
    // later the same turn must not ready him.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Victim", might: 2 })];
    const after = destroyUnit(state, "victim");

    expect(after.players[0]!.unitsLostInBeginningPhaseThisTurn, "an Action-phase death counted").toBe(0);
    expect(after.players[0]!.unitsLostThisTurn, "the wider counter stopped counting — this proves nothing").toBe(1);
  });

  it("arrives exhausted with no death at all — the control", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    expect(
      unitEntersReady(state, 0, realUnitInstance(SHADOW_WATCHER), undefined, "base"),
      "he entered ready on an untouched board",
    ).toBe(false);
  });

  it("the counter expires with the turn", () => {
    const after = runBeginning(beginningWithDeath(0));
    expect(after.players[0]!.unitsLostInBeginningPhaseThisTurn).toBe(1);
    const ended = runEnd({ ...after, phase: "Action" });
    expect(ended.players[0]!.unitsLostInBeginningPhaseThisTurn, "the count outlived its turn").toBe(0);
  });
});

describe("Lilting Lullaby (UNL-190): its controller can't play SPELLS this turn", () => {
  /** A board where player 1 is banned from spells and holds one of each kind. */
  function banned(banSpells: boolean): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.cannotPlaySpellsThisTurn = banSpells;
    state.players[1]!.hand = [spellInstance("OGN-022"), realUnitInstance("OGN-002")];
    state.players[1]!.floatingEnergy = 20;
    state.players[1]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`r${i}`, "Fury"));
    return state;
  }

  const kindsPlayable = (state: GameState): Set<string> =>
    new Set(
      legalActions(state)
        .filter((a): a is PlayCardAction => a.type === "PlayCard")
        .map((a) => a.card.kind),
    );

  it("bars SPELLS and leaves UNITS alone — the whole point of the narrower ban", () => {
    // Both halves off one board. A ban that stopped everything would satisfy the
    // first assertion and fail the second, which is the bug the wider field had.
    const kinds = kindsPlayable(banned(true));
    expect(kinds.has("Spell"), "a spell was still playable under the ban").toBe(false);
    expect(kinds.has("Unit"), "the ban stopped units too — it is the WIDER one").toBe(true);
  });

  it("...and bars nothing without it — the control", () => {
    const kinds = kindsPlayable(banned(false));
    expect(kinds.has("Spell"), "spells were unplayable with no ban set").toBe(true);
  });

  it("is its own field, readable beside the wider ban", () => {
    const state = banned(true);
    expect(mayPlaySpells(state, 1), "the predicate does not see the ban").toBe(false);
    expect(mayPlaySpells(state, 0), "the ban leaked onto the other player").toBe(true);
    // Both may be set at once, and the wider one must stay readable.
    expect(state.players[1]!.cannotPlayCardsThisTurn, "the narrow ban set the wide one").toBe(false);
  });

  it("expires with the turn", () => {
    const ended = runEnd(banned(true));
    expect(ended.players[1]!.cannotPlaySpellsThisTurn, "the ban outlived its turn").toBe(false);
  });
});

describe("coverage", () => {
  it("both cards are whole, with no partial note left", () => {
    for (const id of [SHADOW_WATCHER, LILTING_LULLABY]) {
      expect(isCardImplemented(registry.get(id)), `${id} is greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(id)), `${id} still names a missing half`).toBeUndefined();
    }
  });
});
