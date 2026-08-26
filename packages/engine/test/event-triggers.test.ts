import { describe, expect, it } from "vitest";
import { dispatchEvent, eventTriggerDefIds, holdEventTrigger } from "../src/engine/triggers.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Fires a HELD event and drives it to resolution.
 *
 * `cardPlayed` is a Chain Pending Item now (383 / 808.1.d.3), so it is placed by
 * `holdEventTrigger` and only resolves once the Cleanup finalizes it onto the
 * chain and both players pass. Calling the old inline dispatcher here would not
 * merely be stale — it would bypass every `applies` predicate, which is where the
 * trigger CONDITIONS now live, and quietly test nothing.
 */
const fireHeld = (state: GameState, event: Parameters<typeof holdEventTrigger>[1]): GameState =>
  resolveHeldTriggers(holdEventTrigger(state, event));

/** Was the trigger even PLACED? The negative assertion that matters once events
 *  are held: "nothing happened" is true immediately after any hold, so a check on
 *  the board alone passes whether the condition worked or the trigger merely had
 *  not resolved yet. */
const heldFor = (state: GameState, event: Parameters<typeof holdEventTrigger>[1]): string[] =>
  holdEventTrigger(state, event).pendingTriggers.map((t) => t.listenerDefId);


/**
 * Board events other than a death, and the two cards that listen for them.
 *
 * The bus itself walks `listeningPermanents`, which — unlike the four older
 * dispatch tables in unit-triggers.ts — includes `activeGear`. The listeners
 * live in per-domain `eventTriggers` records so adding one never means editing
 * a shared file, which is what keeps the per-card fan-out collision-free.
 */

const registry = defaultCardRegistry();
const VIKTOR_INNOVATOR = "OGN-117";
const WRAITH_OF_ECHOES = "OGN-118";
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

describe("Viktor - Innovator (OGN-117): a card played on an OPPONENT'S turn", () => {
  /**
   * Viktor in base with a [Reaction] spell in hand, on the OPPONENT'S turn with
   * Focus held by us.
   *
   * This shape is forced, not incidental. A plain card cannot legally be played
   * on someone else's turn at all — the first version of this test used a vanilla
   * Unit and was correctly rejected with "It is not your turn". Only a
   * `[Reaction]` (or an `[Action]` inside a Showdown) reaches the trigger, which
   * is precisely why Viktor was unimplementable before reaction-speed timing.
   */
  function viktorState(activePlayerIndex: 0 | 1): { state: GameState; card: CardInstance } {
    const viktor = unit(VIKTOR_INNOVATOR);
    const reaction = createCardInstance(registry.get("OGN-083")); // Consult the Past, [Reaction], no target
    const state = makeState({
      phase: "Action",
      activePlayerIndex,
      // A Showdown with Focus on us is what makes player 0 the ACTING player
      // while player 1 is the active one (engine/timing.ts's actingPlayerIndex).
      turnState: activePlayerIndex === 0 ? "Neutral" : "Showdown",
      showdownBattlefieldId: activePlayerIndex === 0 ? null : "bf1",
      showdownKind: activePlayerIndex === 0 ? null : "NonCombat",
      focusHolder: 0,
      players: [
        makePlayer("p1", {
          baseUnits: [viktor],
          hand: [reaction],
          channeled: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, domain: "Mind" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });
    return { state, card: reaction };
  }

  // `resolveHeldTriggers` wraps the executor because `cardPlayed` is a Chain
  // Pending Item now (383): `executePlayCard` PLACES Viktor's trigger and the
  // Cleanup finalizes it. `submit` does this for free; a direct `execute*` call
  // leaves the pen full, and the assertion then reads "Viktor did nothing".
  const play = (state: GameState, card: CardInstance) =>
    resolveHeldTriggers(executePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: {
        energyRunes: state.players[0]!.channeled.slice(0, "energyCost" in card ? card.energyCost : 0).map((r) => r.id),
        powerRunes: [],
      },
    }));

  it("makes a Recruit token when you play a card on the opponent's turn", () => {
    // Only reachable at all because of reaction-speed timing: before
    // [Action]/[Reaction] you could never play anything on someone else's turn,
    // so this trigger could not have fired.
    const { state, card } = viktorState(1); // opponent is the active player
    const before = state.players[0]!.baseUnits.length;

    const after = play(state, card);

    // A Spell doesn't join base, so it's Viktor + the token.
    expect(after.players[0]!.baseUnits).toHaveLength(before + 1);
    expect(after.players[0]!.baseUnits.some((u) => u.isToken)).toBe(true);
  });

  it("makes NOTHING when you play a card on your own turn", () => {
    const { state, card } = viktorState(0);
    const after = play(state, card);
    expect(after.players[0]!.baseUnits.some((u) => u.isToken)).toBe(false);
  });

  it("ignores the OPPONENT's card played on their own turn", () => {
    // The condition compares the active player to the LISTENER's controller, not
    // to the caster — get that wrong and Viktor fires on the opponent's plays.
    const viktor = unit(VIKTOR_INNOVATOR);
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 1,
      players: [makePlayer("p1", { baseUnits: [viktor] }), makePlayer("p2")],
    });

    const after = fireHeld(state, { kind: "cardPlayed", casterIndex: 1, playedKind: "Spell", playedInstanceId: "synthetic", playedPowerCost: 0, isToken: false });

    expect(after.players[0]!.baseUnits.some((u) => u.isToken)).toBe(false);
    // **Was `expect(after).toBe(state)`** — "not even a copy was made". That
    // stopped being true on 2026-08-26, when `holdEventTrigger` began recording
    // the event it is handed: it now returns a fresh object every time, whether
    // or not anything listened.
    //
    // The line above already asserts the behaviour this test is named for (no
    // token was made). What the identity assertion added was "nothing about the
    // board moved either", and that is worth keeping — so it is asserted on the
    // board rather than on the reference.
    expect(after.players, "the board changed despite nothing triggering").toEqual(state.players);
    expect(after.battlefields).toEqual(state.battlefields);
    expect(after.spellChain, "something reached the chain").toHaveLength(0);
    expect(after.pendingTriggers, "something reached the holding pen").toHaveLength(0);
  });

  it("fires through executePlayCard, not only through a hand-built event", () => {
    // executePlayCard has three separate return paths; the event is fired by a
    // wrapper around all of them rather than at each `return`, because this
    // codebase has already shipped a bug where one hop dropped a field.
    const { state, card } = viktorState(1);
    const after = play(state, card);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(1); // exactly once
  });
});

describe("Wraith of Echoes (OGN-118): the FIRST friendly death each turn", () => {
  function wraithState(): { state: GameState; ally: UnitInstance; second: UnitInstance } {
    const wraith = unit(WRAITH_OF_ECHOES);
    const ally = makeUnit({ name: "Ally" });
    const second = makeUnit({ name: "Second" });
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          baseUnits: [wraith, ally, second],
          deck: [unit("OGN-002"), unit("OGN-002"), unit("OGN-002")],
        }),
        makePlayer("p2"),
      ],
    });
    return { state, ally, second };
  }

  it("draws 1 when a friendly unit dies", () => {
    const { state, ally } = wraithState();
    const after = resolveHeldTriggers(destroyUnit(state, ally.instanceId));
    expect(after.players[0]!.hand).toHaveLength(1);
    expect(after.players[0]!.firstFriendlyDeathUsedThisTurn).toBe(true);
  });

  it("draws only ONCE per turn, however many friendly units die", () => {
    const { state, ally, second } = wraithState();
    let next = resolveHeldTriggers(destroyUnit(state, ally.instanceId));
    next = resolveHeldTriggers(destroyUnit(next, second.instanceId));
    expect(next.players[0]!.hand).toHaveLength(1); // not 2
  });

  it("re-arms after the turn ends", () => {
    // "Each turn", not "each game" — and runEnd fires at the end of EVERY turn,
    // so a friendly death on the opponent's turn arms it for them too.
    const { state, ally, second } = wraithState();
    let next = resolveHeldTriggers(destroyUnit(state, ally.instanceId));
    expect(next.players[0]!.hand).toHaveLength(1);

    next = runEnd(next);
    expect(next.players[0]!.firstFriendlyDeathUsedThisTurn).toBe(false);

    next = resolveHeldTriggers(destroyUnit(next, second.instanceId));
    expect(next.players[0]!.hand).toHaveLength(2);
  });

  it("ignores an ENEMY unit dying — 'friendly' is relative to the Wraith", () => {
    const { state } = wraithState();
    const theirs = makeUnit({ name: "Theirs" });
    const withEnemy: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, baseUnits: [theirs] }] as GameState["players"],
    };

    const after = resolveHeldTriggers(destroyUnit(withEnemy, theirs.instanceId));

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.firstFriendlyDeathUsedThisTurn).toBe(false);
  });

  it("does not fire for the Wraith's own death being warded away", () => {
    // A replaced death is not a death (rule 808.1.d.1), so nothing watching a
    // death should see one either.
    const { state, ally } = wraithState();
    const warded: GameState = { ...state, deathWardedUnitInstanceIds: [ally.instanceId] };
    const after = resolveHeldTriggers(destroyUnit(warded, ally.instanceId));
    expect(after.players[0]!.hand).toHaveLength(0);
  });
});

describe("coverage counts event listeners", () => {
  it("reports Viktor and the Wraith as implemented", () => {
    expect(eventTriggerDefIds()).toContain(VIKTOR_INNOVATOR);
    expect(isCardImplemented(registry.get(VIKTOR_INNOVATOR))).toBe(true);
    expect(isCardImplemented(registry.get(WRAITH_OF_ECHOES))).toBe(true);
  });
});
