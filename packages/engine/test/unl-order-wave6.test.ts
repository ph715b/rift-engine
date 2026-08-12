import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { implementingModule, isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isMighty } from "../src/engine/granted-keywords.js";
import { optionalUnitCostOf } from "../src/engine/card-effects.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { MoveUnitAction, PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Wave 6 — the RE-AUDIT of the seven Order cards earlier waves refused.
 *
 * One of them moved: **Galio - Indefatigable**. Its refusal named
 * `combat.DEALS_NO_COMBAT_DAMAGE_DEF_IDS` as "exactly one place it can go", and
 * that was one place too few — `mightModifiers` (the seam `effective-might.ts`
 * grew in August) reaches the same arithmetic, because `combatRole: "outgoing"`
 * has exactly two readers and only one of them decides anything. See his entry in
 * effects/order.ts.
 *
 * The other six stayed refused, and the two that had never been pinned anywhere
 * are pinned at the bottom of this file. UNL-151 is pinned in wave 2, UNL-169 and
 * UNL-173 in wave 3, UNL-178 in wave 4; there is no second copy here, because a
 * pin duplicated is a pin that goes stale in one place.
 *
 * **Galio is read through DEATHS, never through `damage`** — 466.1.a.1 inserts
 * "3c. Heal all Units" into the Combat Cleanup, so `damage` is 0 after
 * `resolveShowdown` whatever happened. Each test below therefore has a fixture
 * whose pool is decided by exactly the number under test.
 */

const registry = defaultCardRegistry();

const GALIO_INDEFATIGABLE = "UNL-171";
const MAGESEEKER_INVESTIGATOR = "UNL-163";
const STALKING_WOLF = "UNL-166";

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/** A contested bf1 with `attackers` on p1's side and `defenders` on p2's — the
 *  same shape `backline-keyword.test.ts` uses, and for its reason: the Attacker
 *  is the player who applied Contested (465). */
function combat(attackers: UnitInstance[], defenders: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    contestedByIndex: 0,
    units: { p1: attackers, p2: defenders },
  };
  return state;
}

/** Is this unit still standing at bf1 after the combat resolved? */
const alive = (state: GameState, instanceId: string): boolean => {
  const bf = state.battlefields[0]!;
  return [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])].some((u) => u.instanceId === instanceId);
};

describe("Galio - Indefatigable (UNL-171): 'I don't deal combat damage'", () => {
  it("a 5-Might defender SURVIVES him, where any other 6-Might attacker kills it", () => {
    // The control is the same fixture with a plain attacker of the same Might, so
    // this cannot pass by the defender being unkillable or the combat never
    // happening.
    const galio = realUnitInstance(GALIO_INDEFATIGABLE);
    expect(galio.might, "his printed Might changed — the fixture's numbers are chosen around 6").toBe(6);

    const byGalio = resolveShowdown(combat([galio], [makeUnit({ instanceId: "theirs", name: "Theirs", might: 5 })]), "bf1", 0);
    expect(alive(byGalio, "theirs"), "he dealt combat damage").toBe(true);

    const byPlain = resolveShowdown(
      combat([makeUnit({ instanceId: "plain", name: "Plain", might: 6 })], [makeUnit({ instanceId: "theirs", name: "Theirs", might: 5 })]),
      "bf1",
      0,
    );
    expect(alive(byPlain, "theirs"), "the CONTROL failed: a plain 6-Might attacker killed nothing either").toBe(false);
  });

  it("he still ABSORBS his full 6 — dealing nothing does not make him easier to kill", () => {
    // The load-bearing half, and the one that fails the moment the
    // `combatRole === "outgoing"` guard is dropped: with the penalty applied to
    // the "remaining" role too, `removeDefeated` sees 0 remaining Might and takes
    // him off the board in any combat at all, undamaged.
    const galio = realUnitInstance(GALIO_INDEFATIGABLE);
    const survives = resolveShowdown(combat([makeUnit({ instanceId: "theirs", name: "Theirs", might: 5 })], [galio]), "bf1", 0);
    expect(alive(survives, galio.instanceId), "5 damage killed a 6-Might unit").toBe(true);

    const dies = resolveShowdown(
      combat([makeUnit({ instanceId: "bigger", name: "Bigger", might: 6 })], [realUnitInstance(GALIO_INDEFATIGABLE)]),
      "bf1",
      0,
    );
    expect(alive(dies, galio.instanceId), "the CONTROL failed: 6 damage did not kill a 6-Might unit either").toBe(false);
  });

  it("the silence is HIS: a friendly standing beside him still deals its Might", () => {
    // A modifier that forgot to test `unit.defId` would silence the whole board,
    // and every assertion above would still pass.
    const galio = realUnitInstance(GALIO_INDEFATIGABLE);
    const ally = makeUnit({ instanceId: "ally", name: "Ally", might: 3 });
    const resolved = resolveShowdown(combat([galio, ally], [makeUnit({ instanceId: "theirs", name: "Theirs", might: 3 })]), "bf1", 0);

    expect(alive(resolved, "theirs"), "the ally's 3 Might vanished with Galio's").toBe(false);
  });

  it("reads 6 everywhere except the damage he deals — 143.2.b's floor, and nothing wider", () => {
    // The seam directly, because the three combats above cannot separate "0
    // outgoing" from "0 Might". `isMighty` is the one that would bite in play:
    // his `[Tank]` puts him at the front of every assignment, and a Galio who had
    // stopped being [Mighty] would silently stop satisfying every "your [Mighty]
    // units" clause in the pool.
    const galio = realUnitInstance(GALIO_INDEFATIGABLE);
    const state = combat([galio], [makeUnit({ instanceId: "theirs", name: "Theirs", might: 5 })]);
    const at = { isCombat: true, isAttackingSide: true, battlefieldId: "bf1" } as const;

    expect(effectiveMight(state, galio, 0, { isCombat: false }), "the penalty leaked out of combat").toBe(6);
    expect(effectiveMight(state, galio, 0, { ...at, combatRole: "remaining" }), "the penalty leaked into what he absorbs").toBe(6);
    expect(effectiveMight(state, galio, 0, { ...at, combatRole: "outgoing" }), "he still contributes to the damage pool").toBe(0);
    expect(isMighty(state, galio, 0), "a 6-Might unit stopped being [Mighty]").toBe(true);
  });

  it("coverage sees him, and says which module wrote him", () => {
    expect(isCardImplemented(registry.get(GALIO_INDEFATIGABLE))).toBe(true);
    // Not an assertion about where the card SHOULD live — if `combat.ts` is ever
    // open, moving him to `DEALS_NO_COMBAT_DAMAGE_DEF_IDS` makes this
    // "combat assignment" and every behavioural test above still passes. It is
    // here so that a card reported implemented always names its writer.
    expect(implementingModule(GALIO_INDEFATIGABLE)).toBe("effective-might");
  });
});

// ── The two refusals that had never been pinned ─────────────────────────────

describe("Mageseeker Investigator (UNL-163): refused, and its cost is unreachable anyway", () => {
  /**
   * "Opponents must pay [rainbow] for each unit beyond the first to move multiple
   * units to my battlefield at the same time."
   *
   * 204.4 names this card as the rules' own worked example of an **Applied Cost**:
   * "paid as the Game Action is performed. They do not use the chain and cannot be
   * reacted to", and 204.4.c makes not paying it a bar on the action rather than a
   * fizzle. So it is not an effect at all and no registry in effects/order.ts can
   * hold it — it belongs on the MoveUnit path.
   *
   * `MoveUnitAction` already carries `unitInstanceIds: string[]`, and
   * `validateMoveUnit`/`executeMoveUnit` both loop over it — so the multi-unit move
   * is not the missing piece the old note said it was. What is missing is a
   * `payment` on that action, plus the surcharge in the validator and the executor.
   * The test below measures the OTHER half of the refusal, which is the half that
   * makes the whole card moot today.
   */
  it("is unwritten, and `legalActions` never offers a move of more than one unit", () => {
    expect(isCardImplemented(registry.get(MAGESEEKER_INVESTIGATOR)), "someone wrote it — rewrite this pin").toBe(false);

    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "a", name: "A" }),
      makeUnit({ instanceId: "b", name: "B" }),
      makeUnit({ instanceId: "c", name: "C" }),
    ];
    state.battlefields[0]!.units = { p2: [realUnitInstance(MAGESEEKER_INVESTIGATOR)] };

    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    // Gate on having measured anything at all: an empty list would report "no
    // multi-unit move" just as loudly as a correct one. Three base units by two
    // battlefields, one action each — the exact number, so a fixture that stops
    // producing moves fails here instead of reporting a vacuous pass.
    expect(moves.length, "no move was enumerated — the fixture is wrong, not the refusal").toBe(6);
    expect(
      moves.every((m) => m.unitInstanceIds.length === 1),
      "a multi-unit move is enumerable now — the Investigator's applied cost has become reachable",
    ).toBe(true);
  });
});

describe("Stalking Wolf (UNL-166): refused, and the gap is that he is FREE", () => {
  /**
   * "[Ambush] As an additional cost to play me, kill a Bird, Cat, Dog, or Poro you
   * control. You may play me to its battlefield (even if you don't have other
   * units there)."
   *
   * Two things are missing and both are in shared files:
   *   - `OPTIONAL_UNIT_COSTS` (card-effects.ts) can express `{ kind: "killFriendly",
   *     mandatory: true }` — Cruel Patron's row — but `UnitCostSpec` carries **no
   *     filter**, so it cannot say "a Bird, Cat, Dog, or Poro". The same missing
   *     field is what keeps Sacrifice (UNL-173) refused for "[Mighty]";
   *   - the third sentence is a PLACEMENT GRANT whose destination is the unit the
   *     cost killed, which no `PLACEMENT_GRANTS` entry (unit-triggers.ts) can name.
   *
   * **Not approximable as an on-play trigger**, and that is the whole reason this
   * one cannot be written the way Sacrifice's payoff could: a mandatory additional
   * cost is enforced by the card being UNPLAYABLE (204.2.a), and a Unit that has
   * already arrived cannot be un-played. A resolution-time kill would leave a Wolf
   * played with no pet costing nothing at all — the direction this codebase does
   * not ship, and exactly what the assertion below pins.
   */
  it("has no additional cost registered, so he can be played with no pet to kill", () => {
    expect(optionalUnitCostOf(STALKING_WOLF), "the additional cost landed — check the tag filter came with it").toBeUndefined();
    expect(isCardImplemented(registry.get(STALKING_WOLF)), "someone wrote him — rewrite this pin").toBe(false);

    const wolf = realUnitInstance(STALKING_WOLF);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [wolf];
    state.players[0]!.channeled = runesFor(STALKING_WOLF);
    // A friendly unit that is NOT one of the four tribes, so the board can never
    // pay his cost even once it exists.
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "notapet", name: "Not A Pet", tags: ["Demacia"] })];

    const casts = castsOf(state, wolf.instanceId);
    expect(casts.length, "he is not enumerable at all — the fixture is wrong, not the refusal").toBeGreaterThan(0);

    const { state: after, result } = submit(state, casts[0]!);
    expect(result).toEqual({ type: "Ok" });
    expect(
      after.players[0]!.baseUnits.some((u) => u.instanceId === "notapet"),
      "something of the caster's died — the additional cost is being charged now",
    ).toBe(true);
    expect(after.players[0]!.trash, "a unit reached the trash paying for him").toHaveLength(0);
  });
});
