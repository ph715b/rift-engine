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
  it("is WRITTEN now, and `legalActions` offers the group move his tax is about", () => {
    // **Written 2026-08-14.** This wave's analysis was the one that got it right:
    // 204.4 makes it an Applied Cost with this very card as the rules' worked
    // example, so it belongs on the MoveUnit path and not in any effects registry
    // — and `MoveUnitAction` already looped over `unitInstanceIds`, so the
    // multi-unit move was never the missing piece. What was missing was exactly
    // what this comment says: a `payment` on the action plus the surcharge in the
    // validator and the executor. Behaviour is in `mageseeker-investigator.test.ts`.
    //
    // **The enumerator half below is UNCHANGED and still true**, and it is kept
    // for that reason rather than deleted: the AI cannot make the move this taxes,
    // so the card is live for a human client and inert for a probe.
    expect(isCardImplemented(registry.get(MAGESEEKER_INVESTIGATOR)), "he went back to unimplemented").toBe(true);

    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "a", name: "A" }),
      makeUnit({ instanceId: "b", name: "B" }),
      makeUnit({ instanceId: "c", name: "C" }),
    ];
    state.battlefields[0]!.units = { p2: [realUnitInstance(MAGESEEKER_INVESTIGATOR)] };

    // **BROKE with no runes, and that is the card working.** Three base units make
    // 7 non-empty subsets (2^3 - 1) and there are two battlefields, so the complete
    // 144.3 enumeration is 14. This player holds nothing, so every group of 2+
    // headed for the Investigator's battlefield is unaffordable and 204.4.c drops
    // it: 3 singletons to bf1 plus all 7 to bf2 is 10.
    //
    // It used to be 6 — one action per unit per battlefield — and the whole of
    // this card's reachability is the difference.
    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    expect(moves.length, "the subset enumeration changed shape — recount it").toBe(10);
    expect(
      moves.filter((m) => m.destinationBattlefieldId === "bf1").every((m) => m.unitInstanceIds.length === 1),
      "a group move onto his battlefield was offered with no way to pay for it",
    ).toBe(true);
    expect(
      moves.some((m) => m.destinationBattlefieldId === "bf2" && m.unitInstanceIds.length > 1),
      "no group move at all is enumerable — the widening is gone, not just the tax",
    ).toBe(true);

    // Give the mover the two rainbow it owes for a three-unit group and the four
    // dropped actions come back. Measured as a pair so the 10 above is the tax
    // rather than a missing feature.
    const funded = { ...state, players: [{ ...state.players[0]!, channeled: runesFor(MAGESEEKER_INVESTIGATOR, 2) }, state.players[1]!] } as GameState;
    const richer = legalActions(funded).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    expect(richer.length, "funding the tax did not restore the group moves").toBe(14);
    const taxed = richer.filter((m) => m.destinationBattlefieldId === "bf1" && m.unitInstanceIds.length > 1);
    expect(
      taxed.every((m) => (m.payment?.rainbowRunes ?? []).length === m.unitInstanceIds.length - 1),
      "a group move onto his battlefield was offered untaxed",
    ).toBe(true);
  });
});

// **Stalking Wolf (UNL-166) is no longer refused — the pinned block that stood
// here was removed on 2026-08-12, not weakened.**
//
// Its refusal named both blockers and was right about both: `UnitCostSpec`
// carried no filter, so the cost could not say "a Bird, Cat, Dog, or Poro"; and
// no `PLACEMENT_GRANTS` entry could name a destination defined by the unit the
// cost killed. Both exist now — `UnitCostSpec.candidate`, and the
// `sacrificedUnitsBattlefield` grant, which is the first placement grant that is
// not a property of the battlefield alone.
//
// The pin's sharpest point is worth keeping, because it is what the new tests
// are built around: "a mandatory additional cost is enforced by the card being
// UNPLAYABLE (204.2.a), and a Unit that has already arrived cannot be un-played."
// So the `mandatory` flag, not the `resolve`, is what charges him — with no
// eligible pet he is never enumerated and never validated, and the kill in his
// trigger is only ever reached on a play that already named its price.
//
// See `stalking-wolf.test.ts`. Nothing is re-asserted here: two files claiming
// the same fact is how the premise-flip class starts over.

