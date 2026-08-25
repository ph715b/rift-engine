import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { abilitiesAvailableTo } from "../src/engine/activated-abilities.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";

/**
 * **The two abilities the `[Empower]` key collision had swallowed.**
 *
 * `empowerAbilities()` synthesises an `[Empower]` ability keyed by the CARD'S OWN
 * defId, and `mergeRegistries` throws on a duplicate — so a card printing an
 * `[Empower]` cost *and* an ordinary activated ability could only register one of
 * the two, and the Empower synthesis is the one that won.
 *
 * `isCardImplemented` asks whether an entry exists and one did, so both cards
 * reported green while doing half of what they print. That is the
 * silently-inert-printing class, and **nothing in the repo could see it**: the
 * coverage gate was satisfied, `reachability` counts a card as exercised once any
 * ability of it fires, and no test named either card. It surfaced on 2026-08-25
 * only because `ability-timing.test.ts`'s bijection check reads PRINTED text and
 * found a keyword with nowhere to live.
 *
 * The fix is the shape VEN-149 Jayce already used — a suffixed key
 * (`VEN-075-add`, `VEN-139-recall`) offered from `abilitiesAvailableTo`.
 *
 * **Jayce is a fourth instance of the same collision and his second ability
 * prints no speed keyword**, so the check that found these three would never have
 * found him. A card with an `[Empower]` cost and a plain second ability is still
 * invisible to every instrument here.
 */

const registry = defaultCardRegistry();

const PLATEWYRM = "VEN-075";
const PLATEWYRM_ADD = "VEN-075-add";
const AKALI = "VEN-139";
const AKALI_OVERNUMBERED = "VEN-189";
const AKALI_RECALL = "VEN-139-recall";

/**
 * Activations of one permanent, filtered to ONE of its abilities.
 *
 * **`viaAbilityDefId` is absent when the ability is the permanent's own**, and set
 * only when the source is activating somebody else's — a granted or borrowed one.
 * Both cards here have two abilities: the generated `[Empower]`, which is theirs
 * and carries no `via`, and the suffixed printed one, which is granted from
 * `abilitiesAvailableTo` and does. Comparing `via` against the bare defId
 * therefore finds nothing, and the failure reads "the [Empower] was displaced" —
 * which is exactly the regression this file is meant to catch, from a fixture
 * bug. Hence the explicit `?? permanent's own defId` here.
 */
const activationsOf = (
  state: GameState,
  instanceId: string,
  abilityDefId: string,
  ownDefId: string,
): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" &&
      a.permanentInstanceId === instanceId &&
      (a.viaAbilityDefId ?? ownDefId) === abilityDefId,
  );

function accept(state: GameState, action: ActivateAbilityAction | undefined): GameState {
  expect(action, "the activation was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

// ───────────────────────────────────────────────────────────────────────────
describe("Platewyrm Egg (VEN-075) — [Reaction][>] [Exhaust]: [Add] 1 Energy, 2 if Empowered", () => {
  /** The Egg in play and READY. It prints "this enters exhausted", so a fixture
   *  that skipped the ready would measure nothing — both its abilities cost an
   *  exhaust. */
  function eggState(empowered: boolean): { state: GameState; eggId: string } {
    const egg = realGearInstance(PLATEWYRM);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.activeGear = [{ ...egg, exhausted: false, ...(empowered ? { empowered: true } : {}) }];
    // Runes for the `[Empower]` half's `[1 Energy]`. The printed ability below
    // costs only an exhaust, so without these the last test in this block reads
    // "the [Empower] was displaced" when the truth is that nobody could pay for
    // it — a fixture failure that looks exactly like the regression it guards.
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => ({
      id: `r${i}`,
      domain: "Body" as const,
      state: "Ready" as const,
    }));
    return { state, eggId: egg.instanceId };
  }

  it("is OFFERED at all — the ability the collision had swallowed", () => {
    // The whole point. Before the suffixed key this list was empty, and every
    // other instrument in the repo was content.
    const { state, eggId } = eggState(false);
    expect(activationsOf(state, eggId, PLATEWYRM_ADD, PLATEWYRM).length, "the printed ability is still unregistered").toBeGreaterThan(
      0,
    );
  });

  it("adds 1 Energy when it is NOT Empowered", () => {
    const { state, eggId } = eggState(false);
    const after = accept(state, activationsOf(state, eggId, PLATEWYRM_ADD, PLATEWYRM)[0]);
    expect(after.players[0]!.floatingEnergy).toBe(1);
  });

  it("...and 2 when it IS — the branch is the second half of the printing", () => {
    // Without this the test above would pass on an implementation that ignored
    // "If this is [Empowered], [Add] 2 Energy instead" entirely.
    const { state, eggId } = eggState(true);
    const after = accept(state, activationsOf(state, eggId, PLATEWYRM_ADD, PLATEWYRM)[0]);
    expect(after.players[0]!.floatingEnergy, "the Empowered branch never fired").toBe(2);
  });

  it("reads the SOURCE's status, not the player's", () => {
    // "If THIS is [Empowered]" names the gear. A second, un-Empowered Egg beside
    // an Empowered one must still add 1 — which is what separates reading the
    // source from reading anything on the player.
    const empowered = realGearInstance(PLATEWYRM);
    const plain = realGearInstance(PLATEWYRM);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.activeGear = [
      { ...empowered, exhausted: false, empowered: true },
      { ...plain, exhausted: false },
    ];

    const after = accept(state, activationsOf(state, plain.instanceId, PLATEWYRM_ADD, PLATEWYRM)[0]);
    expect(after.players[0]!.floatingEnergy, "it read the other Egg's status").toBe(1);
  });

  it("still exhausts to pay — the cost is real", () => {
    const { state, eggId } = eggState(false);
    const after = accept(state, activationsOf(state, eggId, PLATEWYRM_ADD, PLATEWYRM)[0]);
    expect(after.players[0]!.activeGear.find((g) => g.instanceId === eggId)!.exhausted).toBe(true);
  });

  it("and the [Empower] ability it used to hide behind is STILL there", () => {
    // The collision is closed by ADDING a key, not by moving one. If the Empower
    // half had been displaced, this change would have swapped one silent ability
    // for another and every other test would still be green.
    const { state, eggId } = eggState(false);
    expect(activationsOf(state, eggId, PLATEWYRM, PLATEWYRM).length, "the [Empower] ability was displaced").toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Akali - Rogue Assassin (VEN-139) — [Action][>] [Exhaust]: recall a unit from a showdown", () => {
  /**
   * Akali as the Legend, a friendly unit at bf1, and a Showdown open there.
   *
   * `legendPrinting` is which of her two printings sits in the zone — the point of
   * the canonical-key wiring is that both behave identically.
   */
  function showdownState(opts: { empowered?: boolean; legendPrinting?: string } = {}): {
    state: GameState;
    akaliId: string;
    unitId: string;
  } {
    const akali = createCardInstance(registry.get(opts.legendPrinting ?? AKALI));
    const mine = makeUnit({ instanceId: "mine", name: "Mine" });
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      turnState: "Showdown",
      showdownKind: "Combat",
      showdownBattlefieldId: "bf1",
      focusHolder: 0,
    });
    state.players[0]!.legend = { ...akali, exhausted: false, ...(opts.empowered ? { empowered: true } : {}) } as never;
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [mine], p2: [makeUnit({ instanceId: "theirs", might: 1 })] },
    };
    return { state, akaliId: akali.instanceId, unitId: mine.instanceId };
  }

  const inBase = (s: GameState, id: string) => s.players[0]!.baseUnits.some((u) => u.instanceId === id);

  it("is OFFERED at all — the ability the collision had swallowed", () => {
    const { state, akaliId } = showdownState();
    expect(activationsOf(state, akaliId, AKALI_RECALL, AKALI).length, "the printed ability is still unregistered").toBeGreaterThan(
      0,
    );
  });

  it("moves the chosen friendly unit to base", () => {
    const { state, akaliId, unitId } = showdownState();
    const act = activationsOf(state, akaliId, AKALI_RECALL, AKALI).find((a) => a.targetUnitInstanceId === unitId);
    const after = accept(state, act);

    expect(inBase(after, unitId), "the unit never reached base").toBe(true);
  });

  it("does NOT ready it when Akali is not Empowered", () => {
    // A unit at a battlefield is normally exhausted; the ready is the Empowered
    // half of the printing and must not come free.
    const { state, akaliId, unitId } = showdownState();
    const withExhausted: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [makeUnit({ instanceId: unitId, exhausted: true })] } } : bf,
      ),
    };
    const act = activationsOf(withExhausted, akaliId, AKALI_RECALL, AKALI).find((a) => a.targetUnitInstanceId === unitId);
    const after = accept(withExhausted, act);

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!.exhausted, "it was readied for free").toBe(
      true,
    );
  });

  it("...and DOES when she is — the two halves, measured apart", () => {
    const { state, akaliId, unitId } = showdownState({ empowered: true });
    const withExhausted: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [makeUnit({ instanceId: unitId, exhausted: true })] } } : bf,
      ),
    };
    const act = activationsOf(withExhausted, akaliId, AKALI_RECALL, AKALI).find((a) => a.targetUnitInstanceId === unitId);
    const after = accept(withExhausted, act);

    expect(
      after.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!.exhausted,
      "the [Empowered] ready never fired",
    ).toBe(false);
  });

  it("offers no target when no showdown is open — 'a unit IN A SHOWDOWN'", () => {
    // The narrowing, and the reason she is unofferable rather than offerable-and-
    // inert: a unit-targeting ability with no legal target is never enumerated.
    const { state, akaliId } = showdownState();
    const neutral: GameState = { ...state, turnState: "Neutral", showdownKind: null, showdownBattlefieldId: null };
    expect(activationsOf(neutral, akaliId, AKALI_RECALL, AKALI), "a unit at a quiet battlefield was offered").toHaveLength(0);
  });

  it("does nothing on the OPPONENT's turn — 'If it's your turn'", () => {
    // 806.1.c.2 lets an [Action] ability be activated "during showdowns on ANY
    // player's turn", and then the printed effect asks whose turn it is. So this
    // activation is legal and inert, which reads like a bug and is the card.
    const { state, akaliId, unitId } = showdownState();
    const theirTurn: GameState = { ...state, activePlayerIndex: 1, focusHolder: 0 };
    const act = activationsOf(theirTurn, akaliId, AKALI_RECALL, AKALI).find((a) => a.targetUnitInstanceId === unitId);
    expect(act, "she was not activatable on their turn at all — [Action] should allow it").toBeDefined();

    const after = accept(theirTurn, act);
    expect(inBase(after, unitId), "the unit moved on the opponent's turn").toBe(false);
  });

  it("BOTH printings get her, from one registration", () => {
    // `printingAliases()` expands only keys that are exactly an aliased defId, so
    // `VEN-189-recall` is never derived. The grant site pushes the CANONICAL key
    // instead — without that, the Overnumbered printing keeps the silent half.
    const state = makeState({ phase: "Action" });
    for (const printing of [AKALI, AKALI_OVERNUMBERED]) {
      expect(
        abilitiesAvailableTo(state, 0, { defId: printing }).map((a) => a.abilityDefId),
        `${printing} did not get the recall`,
      ).toContain(AKALI_RECALL);
    }
  });

  it("and the [Empower] ability is STILL there for both", () => {
    const state = makeState({ phase: "Action" });
    for (const printing of [AKALI, AKALI_OVERNUMBERED]) {
      expect(
        abilitiesAvailableTo(state, 0, { defId: printing }).map((a) => a.abilityDefId),
        `${printing} lost its [Empower]`,
      ).toContain(printing);
    }
  });
});
