import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **UNL-140 Conscription — "You may spend 5 XP as an additional cost to play
 * this. Choose an enemy unit at a battlefield with 3 [Might] or less. If you
 * paid the additional cost, choose ANY enemy unit at a battlefield instead. Take
 * control of it, exhaust it, and recall it."**
 *
 * The pool's only optional cost that buys a **wider CHOICE**. Safety Inspector's
 * XP changes what happens at resolution and Poppy's changes the price; both are
 * flags on an action whose targets were already chosen. This one changes which
 * targets EXIST, and the target fan-out runs above the cost fan-out — so a paid
 * variant built the ordinary way carries a target already capped at 3 Might and
 * sells the XP for nothing.
 *
 * Its refusal survived three waves and named the fix itself: "the targeting
 * filter has to be asked per variant, not once per card". So the wide-only
 * targets are enumerated as variants that carry `optionalXpPaid` FROM BIRTH, and
 * `validate-play-card.targetingRejection` re-derives the same spec from the same
 * table. The flag and the target that needs it cannot come apart.
 *
 * # What is asserted
 *
 *  - Without the XP, only the 3-Might-or-less enemy is offered.
 *  - With it, the big enemy is offered too — and ONLY on a variant that carries
 *    the flag.
 *  - A forged wide target without the flag is refused, which is the half an
 *    enumerator declining to offer something cannot establish.
 *  - The effect really fires on the widened target, so the flag buys the card
 *    rather than just a legal-looking action.
 */

const registry = defaultCardRegistry();
const CONSCRIPTION = "UNL-140";
const CONSCRIPTION_XP = 5;
const MIGHT_CAP = 3;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Conscription in hand with `xp` banked; a small and a big enemy at bf1. */
function board(xp: number): { state: GameState; spellId: string } {
  const spell = spellInstance(CONSCRIPTION);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [spell];
  state.players[0]!.xp = xp;
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`c${i}`, "Chaos"));
  state.battlefields[0]!.units = {
    [state.players[1]!.id]: [
      makeUnit({ instanceId: "small", might: MIGHT_CAP }),
      makeUnit({ instanceId: "big", might: 9 }),
    ],
    // A FRIENDLY unit at the same battlefield, and it is not decoration: "choose
    // any ENEMY unit" keeps the owner restriction on both halves of the card, and
    // without a friendly body present a widened spec that had quietly dropped
    // `owner: "enemy"` would look identical. Mutation testing found exactly that.
    [state.players[0]!.id]: [makeUnit({ instanceId: "friendly", might: 9 })],
  };
  return { state, spellId: spell.instanceId };
}

const targetsOf = (plays: PlayCardAction[]): (string | undefined)[] => plays.map((a) => a.targetUnitInstanceId);

describe("without the XP, the printed cap stands", () => {
  it("offers the 3-Might enemy and not the 9-Might one", () => {
    const { state, spellId } = board(0);
    const targets = targetsOf(playsOf(state, spellId));

    expect(targets, "the small enemy was not offered — this measures nothing").toContain("small");
    expect(targets, "the capped target was lifted with no XP paid").not.toContain("big");
  });

  it("offers no XP variant at all when the XP is unaffordable", () => {
    const { state, spellId } = board(CONSCRIPTION_XP - 1);
    expect(
      playsOf(state, spellId).filter((a) => a.optionalXpPaid === true),
      "a caster short of XP was offered the paid variant",
    ).toEqual([]);
  });
});

describe("with the XP, the choice widens — and only on the paid variant", () => {
  it("offers the 9-Might enemy, flagged", () => {
    const { state, spellId } = board(CONSCRIPTION_XP);
    const plays = playsOf(state, spellId);

    const big = plays.filter((a) => a.targetUnitInstanceId === "big");
    expect(big.length, "the widened target was never offered").toBeGreaterThan(0);
    expect(
      big.every((a) => a.optionalXpPaid === true),
      "the big enemy was offered WITHOUT the XP flag — the cap was simply lifted",
    ).toBe(true);
  });

  it("still offers the small enemy unflagged, so paying stays optional", () => {
    // "You MAY spend". The narrow target must remain reachable for free, or the
    // cost stops being optional.
    const { state, spellId } = board(CONSCRIPTION_XP);
    const small = playsOf(state, spellId).filter((a) => a.targetUnitInstanceId === "small");

    expect(small.length, "the free play disappeared").toBeGreaterThan(0);
    expect(
      small.some((a) => a.optionalXpPaid === undefined),
      "every small-target variant demanded the XP",
    ).toBe(true);
  });

  it("widens the MIGHT cap and nothing else — a friendly unit is never offered", () => {
    // "Choose any ENEMY unit at a battlefield instead" lifts the Might
    // restriction; the owner and the location survive it. A 9-Might FRIENDLY unit
    // stands at the same battlefield, so a widened spec that dropped
    // `owner: "enemy"` would offer it.
    const { state, spellId } = board(CONSCRIPTION_XP);
    expect(targetsOf(playsOf(state, spellId)), "the XP made a friendly unit conscriptable").not.toContain("friendly");
    // ...and the widening did happen, so the absence above is a restriction
    // rather than an empty fan-out.
    expect(targetsOf(playsOf(state, spellId)), "nothing widened at all").toContain("big");
  });

  it("DOES offer the legal-but-pointless play: pay 5 XP for a target you already had", () => {
    // **This test was the exact opposite for about an hour, and the correction is
    // the point.** Paying 5 XP and then choosing the 3-Might unit is legal in the
    // paper game — pointless, but legal — so the engine offers it and the player
    // decides. Withholding a legal play because no reasonable person would take
    // it is not this engine's call to make.
    //
    // Distinct from "if uncertain, do not offer", which is about never
    // enumerating a play that might be ILLEGAL and which still stands.
    const { state, spellId } = board(CONSCRIPTION_XP);
    const paidSmall = playsOf(state, spellId).filter(
      (a) => a.targetUnitInstanceId === "small" && a.optionalXpPaid === true,
    );
    expect(paidSmall.length, "a legal play was withheld from the player").toBeGreaterThan(0);
  });
});

describe("the enumerator and the validator agree", () => {
  it("every enumerated play validates", () => {
    const { state, spellId } = board(CONSCRIPTION_XP);
    const plays = playsOf(state, spellId);
    expect(plays.length, "nothing was enumerated").toBeGreaterThan(1);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, `enumerated but refused: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it("REFUSES a forged wide target with no XP claimed", () => {
    // The half only a forged action reaches, and the one that makes the cap a
    // RULE rather than an enumeration habit.
    const { state, spellId } = board(CONSCRIPTION_XP);
    const wide = playsOf(state, spellId).find((a) => a.targetUnitInstanceId === "big")!;
    const { optionalXpPaid: _dropped, ...forged } = wide;

    expect(
      validatePlayCard(state, forged as PlayCardAction).ok,
      "a 9-Might enemy was conscripted without paying",
    ).toBe(false);
  });
});

describe("the widened play actually does the card", () => {
  it("takes control of the 9-Might enemy and spends the XP", () => {
    const { state, spellId } = board(CONSCRIPTION_XP);
    const wide = playsOf(state, spellId).find((a) => a.targetUnitInstanceId === "big")!;

    const { state: after, result } = submit(state, wide);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const settled = resolveHeldTriggers(after);

    expect(settled.players[0]!.xp, "the XP was not spent").toBe(0);
    expect(
      settled.players[0]!.baseUnits.some((u) => u.instanceId === "big"),
      "the conscripted unit did not arrive in the caster's base",
    ).toBe(true);
    expect(
      settled.battlefields[0]!.units[settled.players[1]!.id]?.some((u) => u.instanceId === "big") ?? false,
      "it is still standing on the enemy's side",
    ).toBe(false);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(CONSCRIPTION);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
