import { describe, expect, it } from "vitest";
import { resolveShowdown } from "../src/engine/combat.js";
import { gearEntersExhausted } from "../src/engine/deploy.js";
import { optionalPowerCostOf } from "../src/engine/card-effects.js";
import { isCardImplemented, partialImplementationNote, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { grantKeywordThisTurn } from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";

/**
 * `[Backline]` — **465.2.c**: "I must be assigned combat damage last", the mirror
 * of `[Tank]`'s "first".
 *
 * # None of this was a missing mechanism
 *
 * `combat.assignmentOrder` has sorted three tiers — Tanks, everyone else,
 * Backline — since Caitlyn - Patrolling was written, including the tie-break for a
 * unit that is somehow both. What it did NOT do was ask the keyword: it consulted
 * `ASSIGNED_LAST_DEF_IDS`, a set with one entry, because when it was written
 * `"Backline"` was not in `model/keyword.ts` and Caitlyn prints the sentence as
 * prose rather than as a bracket.
 *
 * `"Backline"` was added to `KEYWORDS` when Unleashed landed, whose four cards DO
 * print it. From that day the parser populated a keyword nothing asked about, the
 * comment in `combat.ts` saying the keyword did not exist went stale, and the
 * coverage flag blamed the four cards on a mechanism that was already written.
 * The fix is one `hasKeyword` call.
 *
 * # What is asserted here
 *
 * Damage ORDER, not damage totals — the whole keyword is about which unit a pool
 * reaches first. Every test therefore uses a pool that is deliberately too small
 * to reach everyone, because a pool that kills the whole board cannot tell a
 * correct order from a reversed one. That is the trap this file exists to avoid:
 * the natural fixture (big attacker, small defenders) passes either way.
 */

const registry = defaultCardRegistry();

/** The four UNL cards that print the bracket, plus Caitlyn who prints the prose. */
const PROMOTER = "UNL-043"; // Enthusiastic Promoter
const LEBLANC = "UNL-090"; // LeBlanc - Everywhere At Once — [Backline], and her own text is unwritten
const EVELYNN = "UNL-141"; // Evelynn - Entrancing
const PYKE_RETURNED = "UNL-145"; // Pyke - Returned
const CAITLYN = "OGN-068"; // prose, not a bracket — stays on the defId allowlist

/** Two defenders and an attacker whose Might kills exactly ONE of them.
 *
 *  **Read through DEATHS, never through `damage`.** Rule 466 step 3c heals every
 *  surviving unit at the end of combat, so `damage` is 0 after `resolveShowdown`
 *  no matter what happened — the first version of this file asserted on it and
 *  all six order tests failed identically, including the control. A pool of
 *  exactly one defender's Might kills whoever is assigned first and leaves
 *  nothing over, so the survivor names the order. */
function combat(defenders: UnitInstance[], attackerMight = 3): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    contestedByIndex: 0,
    units: {
      p1: [makeUnit({ name: "Attacker", might: attackerMight })],
      p2: defenders,
    },
  };
  return state;
}

/** Is this unit still standing at the battlefield after the combat resolved? */
const alive = (state: GameState, instanceId: string): boolean => {
  const bf = state.battlefields[0]!;
  const all = [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])];
  return all.some((u) => u.instanceId === instanceId);
};

/** A real instance of a printed card, so the keyword comes from the card data
 *  rather than from a hand-written `keywords` object — the difference between
 *  testing `assignmentOrder` and testing the fixture. */
function printed(defId: string, overrides: Partial<UnitInstance> = {}): UnitInstance {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit`);
  return makeUnit({ defId, name: def.name, keywords: def.keywords, might: 3, ...overrides });
}

describe("[Backline] is read from the keyword, not from a one-entry allowlist", () => {
  it("a printed [Backline] unit is assigned damage AFTER a plain one", () => {
    const back = printed(EVELYNN);
    const plain = makeUnit({ name: "Plain", might: 3 });
    // Plain listed FIRST already, so a build that simply preserved input order
    // would also pass — which is why the reversed fixture below exists.
    const resolved = resolveShowdown(combat([plain, back]), "bf1", 0);

    expect(alive(resolved, plain.instanceId), "the plain unit survived — it was not assigned first").toBe(false);
    expect(alive(resolved, back.instanceId), "[Backline] was assigned damage before a plain unit").toBe(true);
  });

  it("...and still after it when the Backline unit is listed FIRST", () => {
    // The load-bearing half. With the keyword ignored, `assignmentOrder` returns
    // the list untouched and the Backline unit — being first — soaks the pool.
    // This is the assertion that was failing before the fix.
    const back = printed(EVELYNN);
    const plain = makeUnit({ name: "Plain", might: 3 });
    const resolved = resolveShowdown(combat([back, plain]), "bf1", 0);

    expect(alive(resolved, back.instanceId), "[Backline] soaked the pool from the front of the list").toBe(true);
    expect(alive(resolved, plain.instanceId), "nobody died — the fixture measures nothing").toBe(false);
  });

  it("a GRANTED [Backline] works too, which an allowlist could never do", () => {
    // The reason the fix reads the keyword rather than adding four defIds.
    const target = makeUnit({ name: "Granted", might: 3 });
    const plain = makeUnit({ name: "Plain", might: 3 });
    const state = grantKeywordThisTurn(combat([target, plain]), target.instanceId, "Backline");
    const resolved = resolveShowdown(state, "bf1", 0);

    expect(alive(resolved, target.instanceId), "a granted [Backline] was ignored").toBe(true);
    expect(alive(resolved, plain.instanceId), "nobody died — the fixture measures nothing").toBe(false);
  });

  it("[Tank] still beats [Backline] on the same unit — 465.2.c's exclusionary clause", () => {
    // Both requirements cannot be met, so the assigner picks one. This engine has
    // no interactive assignment and resolves it in Tank's favour; that choice is
    // legal and is recorded as a divergence because the RULES give the player the
    // choice. Asserted so the resolution cannot drift silently.
    //
    // **This does NOT prove `assignmentOrder`'s `!isTank(u)` guard**, and saying so
    // is the point: dropping that guard survived mutation. Without it the unit
    // lands in both tiers and appears TWICE in the order, which still puts it
    // first — and `distribute`'s arithmetic makes the surplus land identically, so
    // survivors and excess damage are unchanged. The guard is labelled
    // measured-redundant at its definition rather than pinned here by a test that
    // would imply it had been proved.
    const both = printed(EVELYNN);
    const plain = makeUnit({ name: "Plain", might: 3 });
    const state = grantKeywordThisTurn(combat([plain, both]), both.instanceId, "Tank");
    const resolved = resolveShowdown(state, "bf1", 0);

    expect(alive(resolved, both.instanceId), "Tank did not win the tie").toBe(false);
    expect(alive(resolved, plain.instanceId)).toBe(true);
  });

  it("Caitlyn keeps working from the allowlist — she prints no bracket at all", () => {
    // The control for the half of the fix that was NOT changed. She carries the
    // effect as prose, so `unimplementedKeywordsOn` sees nothing on her and
    // `hasKeyword` would answer false; only `ASSIGNED_LAST_DEF_IDS` reaches her.
    expect(registry.get(CAITLYN).text).not.toContain("[Backline]");

    const caitlyn = printed(CAITLYN);
    const plain = makeUnit({ name: "Plain", might: 3 });
    const resolved = resolveShowdown(combat([caitlyn, plain]), "bf1", 0);

    expect(alive(resolved, caitlyn.instanceId), "Caitlyn lost her Backline when the keyword arrived").toBe(true);
    expect(alive(resolved, plain.instanceId), "nobody died — the fixture measures nothing").toBe(false);
  });

  it("a board with NO Backline and no Tank is left in its original order", () => {
    // The negative that keeps the three-tier sort from being a no-op assertion:
    // if `assignmentOrder` reordered indiscriminately, the tests above would pass
    // for the wrong reason.
    const first = makeUnit({ name: "First", might: 3 });
    const second = makeUnit({ name: "Second", might: 3 });
    const resolved = resolveShowdown(combat([first, second]), "bf1", 0);

    expect(alive(resolved, first.instanceId), "the pool skipped the first unit in the list").toBe(false);
    expect(alive(resolved, second.instanceId)).toBe(true);
  });
});

describe("the keyword no longer greys any card", () => {
  it("four cards print it, and none is still blamed on it", () => {
    const bracketed = registry.all().filter((d) => (d.text ?? "").includes("[Backline]"));
    expect(bracketed.map((d) => d.id).sort(), "the sweep found different cards — the pattern drifted").toEqual(
      [PROMOTER, LEBLANC, EVELYNN, PYKE_RETURNED].sort(),
    );

    for (const def of bracketed) {
      expect(unimplementedKeywordsOn(def), `${def.id} is still greyed by a keyword`).toEqual([]);
    }
  });

  it("three of the four are now whole; LeBlanc is unimplemented for her OWN text", () => {
    // The partition, so "the keyword landed" cannot be confused with "every card
    // carrying it is finished". LeBlanc was never one keyword away — nothing is
    // registered for her at all — and she correctly gets no PARTIALLY_IMPLEMENTED
    // row, because that map is for cards which would otherwise look FINISHED.
    for (const defId of [PROMOTER, EVELYNN, PYKE_RETURNED]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} did not come whole`).toBe(true);
    }
    // **LeBlanc's own text landed on 2026-08-13.** Her second clause — "your
    // [Temporary] effects at my battlefield don't happen" — is a branch inside
    // `killTemporaryPermanents`, and the sweep had to stop flattening the board
    // to know which battlefield each doomed unit stands at.
    //
    // She needed her own coverage source (`turnManagerDefIds`) because nothing
    // else could claim her: the shelter is not a registry entry, and `[Backline]`
    // is a printed keyword the combat code already reads.
    expect(isCardImplemented(registry.get(LEBLANC)), "LeBlanc went back to unimplemented").toBe(true);
    expect(partialImplementationNote(registry.get(LEBLANC)), "she gained a partial note").toBeUndefined();
  });
});

describe("two more tables that already existed, and the cards that were not in them", () => {
  it("UNL-049 and UNL-136 enter exhausted, like Iron Ballista", () => {
    // Both shipped from a card wave with the ability written and "This enters
    // exhausted" dropped, because `GEAR_ENTERING_EXHAUSTED` is a shared file. Both
    // were STRONGER than printed in the meantime — usable the turn they landed.
    expect(gearEntersExhausted("UNL-049"), "UNL-049 can still be used the turn it arrives").toBe(true);
    expect(gearEntersExhausted("UNL-136"), "UNL-136 can still be used the turn it arrives").toBe(true);
    expect(gearEntersExhausted("OGN-017"), "Iron Ballista lost her own row").toBe(true);
    // The negative: an ordinary gear must NOT have been dragged in by a widening.
    expect(gearEntersExhausted("OGN-227"), "an unrelated gear now enters exhausted").toBe(false);
  });

  it("Nami's optional [Calm] cost is enumerable, the same shape as Pyke's [Fury]", () => {
    // Two cards printing "You may pay [rune] as an additional cost to play me"
    // shipped with the trigger written and the cost unenumerable. Asserted as a
    // PAIR so the next one is checked against this table before being called
    // blocked.
    expect(optionalPowerCostOf("UNL-052"), "Nami's [Stun] can still never fire").toEqual({ domain: "Calm", count: 1 });
    expect(optionalPowerCostOf("UNL-028"), "Pyke's row regressed").toEqual({ domain: "Fury", count: 1 });
    expect(optionalPowerCostOf("UNL-043"), "an unrelated card gained an optional cost").toBeUndefined();
  });
});

describe("a 0-Power card with an optional Power cost, played on floating Power", () => {
  // **The FIFTH offered-then-refused crash in this engine, found by `hunt-xp` on
  // 2026-08-10 — and caused by the two table rows above.**
  //
  // `legal-actions` priced an optional Power cost by ADDING it to `effectiveCost`,
  // which has already had floating Power taken off. Its comment argued that was
  // safe because "float is already spent... the two differ only when float remains
  // unspent, which by construction it does not". That construction fails for a
  // card printing NO Power: there is nothing for the float to be spent on, so it
  // survives, and `validate-play-card` — which folds the additional cost in BEFORE
  // applying float — priced the play a pip lower. `executePlayCard` threw.
  //
  // Both cards this reaches were added the day before: Pyke (UNL-028) and Nami
  // (UNL-052) are the pool's only 0-Power cards with an optional Power cost. The
  // suite could not see it because it needs floating Power OF THE RIGHT DOMAIN
  // banked at the moment such a card is played.
  const PYKE = "UNL-028"; // 3 Energy, 0 Power, "you may pay [Fury]"
  const NAMI = "UNL-052"; // 3 Energy, 0 Power, "you may pay [Calm]"

  /** `defId` in hand, plenty of runes, and ONE floating Power of `domain` banked
   *  — the state that makes the enumerator and the validator disagree. */
  function withFloatingPower(defId: string, domain: "Fury" | "Calm"): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spellInstance(defId)];
    state.players[0]!.channeled = Array.from(
      { length: 9 },
      (_, i) => ({ id: `r${i}`, domain, state: "Ready" }) as RuneCard,
    );
    state.players[0]!.floatingPower = { ...state.players[0]!.floatingPower, [domain]: 1 };
    return state;
  }

  it.each([
    [PYKE, "Fury" as const],
    [NAMI, "Calm" as const],
  ])("%s: every enumerated variant is accepted by the validator", (defId, domain) => {
    const state = withFloatingPower(defId, domain);
    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId,
    );

    expect(plays.length, "the card was not playable at all — the fixture measures nothing").toBeGreaterThan(0);
    expect(plays.some((a) => a.optionalPowerPaid === true), "the paid variant is not offered — no split to test").toBe(true);

    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);
    }
  });

  it("the floating Power really does absorb the optional pip", () => {
    // The positive claim behind the fix, not just "nothing threw": with one Fury
    // floating, the paid variant should name ZERO Power runes, because the float
    // covers the additional cost. A build that merely stopped crashing by
    // enumerating fewer variants would not satisfy this.
    const state = withFloatingPower(PYKE, "Fury");
    const paid = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === PYKE && a.optionalPowerPaid === true,
    )!;

    expect(paid.payment.powerRunes, "the float was not applied to the optional cost").toHaveLength(0);
  });

  it("...and with NO float banked it still costs a rune — the control", () => {
    const state = withFloatingPower(PYKE, "Fury");
    state.players[0]!.floatingPower = { ...state.players[0]!.floatingPower, Fury: 0 };
    const paid = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === PYKE && a.optionalPowerPaid === true,
    )!;

    expect(paid.payment.powerRunes, "the optional cost became free without float").toHaveLength(1);
  });
});
