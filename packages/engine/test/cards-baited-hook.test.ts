import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { activationPayment } from "../src/engine/activated-abilities.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Baited Hook (OGN-242) — "[1 Energy][Order], Exhaust: Kill a friendly unit. Look
 * at the top 5 cards of your Main Deck. You may banish a unit from among them that
 * has Might up to 1 more than the killed unit and play it, ignoring its cost. Then
 * recycle the rest."
 *
 * **The first ability in the pool combining `energy` with `power`.** That path was
 * built earlier the same day and this file is the first thing to exercise it, so
 * the payment gets its own assertions rather than being taken on trust.
 *
 * Everything goes through `submit` — the ability is found via `legalActions` and
 * the decision answered with a real `AnswerDecision`. A resolver called by hand
 * would pass whether or not the ability is reachable, which for an activated
 * ability is the whole question: it has to be enumerated, priced and paid for.
 */

const registry = defaultCardRegistry();
const BAITED_HOOK = "OGN-242";

const gear = (): GearInstance => createCardInstance(registry.get(BAITED_HOOK)) as GearInstance;
const orderRunes = (n: number, state: RuneCard["state"] = "Ready"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i}`, domain: "Order" as const, state }));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** The gear in play, `victim` in base, `deck` on top, and runes to pay with. */
function hookState(victimMight: number, deck: UnitInstance[], runes = orderRunes(2)): { state: GameState; hook: GearInstance; victim: UnitInstance } {
  const hook = gear();
  const victim = makeUnit({ name: "Bait", might: victimMight, instanceId: "bait" });
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { channeled: runes, deck }), makePlayer("p2")],
  });
  state.players[0]!.activeGear = [hook];
  state.players[0]!.baseUnits = [victim];
  return { state, hook, victim };
}

const activation = (state: GameState, hook: GearInstance, victimId: string) => {
  const action = legalActions(state).find(
    (a) => a.type === "ActivateAbility" && a.permanentInstanceId === hook.instanceId && a.targetUnitInstanceId === victimId,
  );
  expect(action, "the ability was never enumerated against that victim").toBeDefined();
  return action!;
};

const answer = (state: GameState, optionId: string) => {
  const d = pendingDecision(state);
  expect(d, "Baited Hook never asked").toBeDefined();
  return accept(state, { type: "AnswerDecision", playerIndex: 0, decisionId: d!.id, optionId });
};

describe("Baited Hook (OGN-242): the first Energy+Power activation", () => {
  it("is OFFERED, and priced — one Ready Order rune covers BOTH halves", () => {
    // Rule 164.2: a Basic Rune has two abilities, `[E]: Add [1]` and
    // `Recycle this: Add [C]`. So a Ready rune can be exhausted for the Energy and
    // then recycled for the Power. This looks like a double-spend and is not; see
    // the rune double-duty row in docs/rules-conformance.md.
    const { state, hook, victim } = hookState(3, [], orderRunes(1));
    expect(activation(state, hook, victim.instanceId)).toBeDefined();

    expect(activationPayment(state, 0, { energy: 1, power: { domain: "Order", count: 1 }, exhaust: true })).toBeDefined();
  });

  it("is NOT offered when the Order rune is already exhausted", () => {
    // The negative half of the same arithmetic: an Exhausted rune can still be
    // recycled for Power, but it can no longer be exhausted for Energy.
    const { state, hook } = hookState(3, [], orderRunes(1, "Exhausted"));
    const offered = legalActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === hook.instanceId,
    );
    expect(offered).toEqual([]);
  });

  it("is NOT offered with only off-domain runes", () => {
    const { state, hook } = hookState(3, [], [{ id: "f0", domain: "Fury", state: "Ready" }]);
    expect(legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === hook.instanceId)).toEqual([]);
  });

  it("kills the chosen unit and offers only top-5 units within Might + 1", () => {
    const deck = [
      makeUnit({ name: "Small", might: 2, instanceId: "small" }),
      makeUnit({ name: "Exact", might: 4, instanceId: "exact" }), // victim 3 + 1
      makeUnit({ name: "TooBig", might: 5, instanceId: "toobig" }),
      makeUnit({ name: "Deep", might: 1, instanceId: "deep" }),
      makeUnit({ name: "Deep2", might: 1, instanceId: "deep2" }),
      makeUnit({ name: "Sixth", might: 1, instanceId: "sixth" }), // below the top 5
    ];
    const { state, hook, victim } = hookState(3, deck);

    const after = accept(state, activation(state, hook, victim.instanceId));

    expect(after.players[0]!.baseUnits.map((u) => u.name)).not.toContain("Bait");
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain("bait");
    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.id)).toEqual([
      "decline",
      "small",
      "exact",
      "deep",
      "deep2",
    ]);
  });

  it("plays the chosen unit free and recycles the other four to the bottom", () => {
    const deck = [
      makeUnit({ name: "A", might: 1, instanceId: "a" }),
      makeUnit({ name: "B", might: 1, instanceId: "b" }),
      makeUnit({ name: "C", might: 1, instanceId: "c" }),
      makeUnit({ name: "D", might: 1, instanceId: "d" }),
      makeUnit({ name: "E", might: 1, instanceId: "e" }),
      makeUnit({ name: "Bottom", might: 9, instanceId: "bottom" }),
    ];
    const { state, hook, victim } = hookState(3, deck);
    const runesBefore = state.players[0]!.channeled.length;

    const after = answer(accept(state, activation(state, hook, victim.instanceId)), "b");

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual(["b"]);
    // "Then recycle the rest" — the other four go to the BOTTOM, behind the card
    // that was already below the top 5 (416).
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["bottom", "a", "c", "d", "e"]);
    // Free: no Energy was charged for the unit itself. The ability's own cost did
    // recycle a rune for its Power, so the pool shrinks by exactly that one.
    expect(after.players[0]!.channeled.length).toBe(runesBefore - 1);
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(1);
  });

  it("recycles all five when the player declines — a separate instruction (135.2.b)", () => {
    const deck = ["a", "b", "c", "d", "e"].map((n) => makeUnit({ name: n, might: 1, instanceId: n }));
    const { state, hook, victim } = hookState(3, deck);

    const after = answer(accept(state, activation(state, hook, victim.instanceId)), "decline");

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(0);
  });

  it("offers nothing playable when every top-5 unit is too big, but still recycles", () => {
    const deck = ["a", "b", "c", "d", "e"].map((n) => makeUnit({ name: n, might: 9, instanceId: n }));
    const { state, hook, victim } = hookState(1, deck);

    const after = accept(state, activation(state, hook, victim.instanceId));
    // A one-option question auto-resolves, so the decline is taken for the player
    // and the recycle still happens — which is the 135.2.b point.
    expect(pendingDecision(after)).toBeUndefined();
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ignores SPELLS among the top 5 — 'banish a unit'", () => {
    const spell = createCardInstance(registry.get("OGN-224"));
    const deck = [spell as never, makeUnit({ name: "U", might: 1, instanceId: "u" })];
    const { state, hook, victim } = hookState(3, deck);

    const after = accept(state, activation(state, hook, victim.instanceId));
    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.id)).toEqual(["decline", "u"]);
  });

  it("reads the victim's EFFECTIVE Might, not its printed Might", () => {
    // A this-turn pump on the bait raises the cap. Recorded as Unverified: the
    // rules state the printed-cost convention for COSTS only, and the Fox-Fire
    // example treats a Might restriction as live and effective.
    const deck = [makeUnit({ name: "Big", might: 6, instanceId: "big" })];
    const { state, hook, victim } = hookState(3, deck);
    state.players[0]!.baseUnits = [{ ...victim, mightThisTurn: 2 }]; // effective 5, cap 6

    const after = accept(state, activation(state, hook, victim.instanceId));
    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.id)).toContain("big");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BAITED_HOOK))).toBe(true);
  });
});

/**
 * Reported from playtesting: "if I use Hook to sacrifice a LONE unit at a
 * battlefield, the unit I get off the top should be playable to the battlefield
 * that lone unit was on."
 *
 * The mechanism is exact. `free-play.destinationsFor` offers a battlefield only
 * where the player has a unit RIGHT NOW, and Baited Hook kills the only one it had
 * there as the first half of the same ability — so by the time the free play
 * happens presence is gone and base is the only destination.
 *
 * `bf-0` is CONTROLLED by the player in these tests, which is the whole point:
 * control is awarded when the battlefield is held and lapses only in a later
 * Cleanup (`lapseUnoccupiedControl`, 323.6). So between the kill and the free
 * play there is a real window where "a battlefield you control" and "a battlefield
 * where you have units" disagree, and this is it.
 *
 * Recorded **Unverified** in docs/rules-conformance.md: the 2026-07-16 PDF defines
 * the permission as `[Ambush]`, "a battlefield where you control Units", which
 * after the kill is false. The alternative readings are control (implemented here,
 * on the reporter's account of a rule change) and 359.3's linked instructions
 * judging the destination as the ability began.
 */
describe("Baited Hook: the replacement may land where the bait died", () => {
  /** The gear in play, a LONE `victim` at bf-0 which the player controls. */
  function loneAtBattlefield(controlled: boolean): { state: GameState; hook: GearInstance; victim: UnitInstance } {
    const hook = gear();
    const victim = makeUnit({ name: "Bait", might: 3, instanceId: "bait" });
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", { channeled: orderRunes(2), deck: [makeUnit({ name: "Fresh", might: 4, instanceId: "fresh" })] }),
        makePlayer("p2"),
      ],
    });
    state.players[0]!.activeGear = [hook];
    state.battlefields[0]!.units = { p1: [victim] };
    // The fixture names its battlefields `bf1`/`bf2`, not `bf-0` — read the id
    // rather than hardcoding one, which cost a red run that looked like a fix
    // failing when it had already worked.
    if (controlled) state.battlefields[0]!.controllerId = "p1";
    return { state, hook, victim };
  }

  it("offers the battlefield the bait died at, when the player still controls it", () => {
    const { state, hook, victim } = loneAtBattlefield(true);
    const afterKill = accept(state, activation(state, hook, victim.instanceId));
    const afterBanish = answer(afterKill, "fresh");

    const d = pendingDecision(afterBanish);
    expect(d, "no placement question was asked — the unit went straight to base").toBeDefined();
    expect(optionsFor(afterBanish, d!).map((o) => o.id)).toContain(state.battlefields[0]!.id);
  });

  it("still lands the unit there once chosen", () => {
    const { state, hook, victim } = loneAtBattlefield(true);
    const afterBanish = answer(accept(state, activation(state, hook, victim.instanceId)), "fresh");
    const placed = answer(afterBanish, state.battlefields[0]!.id);

    expect(placed.battlefields[0]!.units["p1"]?.map((u) => u.instanceId)).toEqual(["fresh"]);
    expect(placed.players[0]!.baseUnits).toEqual([]);
  });

  it("does NOT offer a battlefield the player neither occupies nor controls", () => {
    // The negative control that keeps this from becoming "free plays go anywhere".
    const { state, hook, victim } = loneAtBattlefield(false);
    const afterBanish = answer(accept(state, activation(state, hook, victim.instanceId)), "fresh");

    const d = pendingDecision(afterBanish);
    const ids = d ? optionsFor(afterBanish, d).map((o) => o.id) : [];
    expect(ids).not.toContain(state.battlefields[1]!.id);
  });
});
