import { describe, expect, it } from "vitest";
import {
  cardModesOf,
  cardNeedsTarget,
  createCardInstance,
  defaultCardRegistry,
  targetingForAnyCard,
  type CardInstance,
  type PlayCardAction,
} from "@rift-engine/engine";
import { modeFilterAllows, sameMode } from "../src/pending-match.js";

/**
 * A modal card could not be played, and a modal card played the wrong half.
 *
 * Reported from playtesting: *"angle shot not working. no prompts or anything to
 * choose a unit or gear."*
 *
 * # One cause: the board had no concept of a MODE
 *
 * Measured before the fix: **`modeId` appeared ZERO times in all of
 * `packages/web/src`**, while every enumerated `PlayCardAction` for a modal card
 * carries one and `validate-play-card.ts` validates against it. The engine half
 * was complete end to end; the field was lost on the hop into the UI. That is the
 * same shape as `targetPermanentInstanceId`, `xAmount` and the four optional-cost
 * flags before it — a field that exists, is enumerated, is validated, and gets
 * dropped by one reader.
 *
 * # Two different failures from it
 *
 * `targetingForCard` answers `{kind: "none"}` when the mode is unresolved — it
 * cannot guess which of two different specs applies, and guessing would be worse.
 * Every board call passed no mode, so every modal card looked like a card that
 * needs nothing:
 *
 *   **Angle Shot STALLED.** No target step was offered, and the resulting
 *   mode-less pending play then matched no candidate — all of them name a unit.
 *   It armed, asked nothing, and could never be submitted.
 *
 *   **Rocket Barrage played the WRONG MODE, silently.** Its `killGear`
 *   candidates carry no `targetUnitInstanceId` and its `damage` ones do, so a
 *   mode-less pending matched every gear candidate and neither damage one. The
 *   board destroyed an arbitrary gear — sometimes the player's own — and the
 *   damage mode was unreachable. Worse than a stall, because it looks like it
 *   worked.
 *
 * These are the only two modal cards in the pool today (swept with `cardModesOf`
 * over every non-Unit definition — the last block below keeps that sweep honest,
 * so a third cannot arrive unnoticed).
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));

const ANGLE_SHOT = "SFD-011";
const ROCKET_BARRAGE = "SFD-077";
const DISPOSAL_ORDER = "UNL-103"; // arrived in wave 2, after the mode step existed
const FLURRY_OF_FEATHERS = "UNL-044"; // wave 3 — its two modes want DIFFERENT target kinds
const CURTAIN_CALL = "UNL-182"; // wave 5 — FOUR modes, and one of them is scoped to base
const MESMERIZE = "VEN-052"; // Vendetta Mind wave 1 — two modes differing only in `owner`
const CHARM = "OGN-043"; // non-modal control: one mode, plain `unit` targeting

/** A candidate as the enumerator emits it — only the fields these comparisons
 *  read. Built by hand rather than by running a game, because what is under test
 *  is the BOARD's narrowing, and a hand-built pair states the ambiguity outright:
 *  two candidates that differ only in mode. */
const candidate = (modeId: string | undefined, extra: Partial<PlayCardAction> = {}): PlayCardAction =>
  ({ modeId, ...extra }) as PlayCardAction;

/** Every modal card in the pool, derived. The label check and the pin below both
 *  walk this, so a new modal card cannot be visible to one and not the other. */
const modalCardIds = (): string[] =>
  registry
    .all()
    .filter((definition) => {
      try {
        return cardModesOf(createCardInstance(definition)).length > 1;
      } catch {
        return false;
      }
    })
    .map((definition) => definition.id)
    .sort();


describe("the engine offers modes the board must ask about", () => {
  it("Angle Shot has two, each with its OWN targeting — the reason one spec cannot describe it", () => {
    const modes = cardModesOf(card(ANGLE_SHOT));
    expect(modes.map((m) => m.id)).toEqual(["attach", "detach"]);
    // Different `relation`, so the set of legal gear is different per mode. This
    // is the fact that makes asking the mode FIRST necessary rather than tidy.
    expect(modes.map((m) => m.targeting.kind)).toEqual(["unitAndEquipment", "unitAndEquipment"]);
    expect(modes.map((m) => JSON.stringify(m.targeting))).not.toEqual([
      JSON.stringify(modes[0]!.targeting),
      JSON.stringify(modes[0]!.targeting),
    ]);
  });

  it("Rocket Barrage's two modes do not even want the same KIND of thing", () => {
    const modes = cardModesOf(card(ROCKET_BARRAGE));
    expect(modes).toHaveLength(2);
    expect(new Set(modes.map((m) => m.targeting.kind)).size).toBe(2);
  });

  it("every mode carries a label — which is what the board's buttons say", () => {
    // `CardMode.label` is documented as "what the board's button says" and had
    // never been shown to anyone. A blank one is an unpressable button, and the
    // mode step has no other affordance — so this is the assertion that decides
    // whether a NEW modal card is playable at all.
    //
    // Walks the census rather than a hardcoded pair, deliberately: UNL-103
    // arrived from a card wave the day after this file was written, and a list
    // of two ids would have kept passing while saying nothing about it.
    for (const defId of modalCardIds()) {
      for (const mode of cardModesOf(card(defId))) {
        expect(mode.label.length, `${defId}/${mode.id} has no label — its button would be blank`).toBeGreaterThan(0);
      }
    }
  });
});

describe("without a mode, the board cannot see the question at all", () => {
  it("targeting reads as 'none' — the single fact that produced both bugs", () => {
    expect(targetingForAnyCard(card(ANGLE_SHOT)).kind).toBe("none");
    expect(targetingForAnyCard(card(ROCKET_BARRAGE)).kind).toBe("none");
  });

  it("and `cardNeedsTarget` therefore says NO, which is why arming had to gate on modes instead", () => {
    // The board's `cardNeedsChoice` used to be exactly `cardNeedsTarget` plus two
    // non-targeting axes. This assertion is why a `cardModesOf(...).length > 1`
    // clause had to be added to it: a free modal card would otherwise have been
    // auto-played by `immediatePlayAction` at whichever mode was enumerated first.
    expect(cardNeedsTarget(card(ANGLE_SHOT))).toBe(false);
  });

  it("but WITH one, the real spec appears", () => {
    expect(targetingForAnyCard(card(ANGLE_SHOT), "attach").kind).toBe("unitAndEquipment");
    expect(targetingForAnyCard(card(ANGLE_SHOT), "detach").kind).toBe("unitAndEquipment");
  });

  it("the non-modal control is unaffected — its sole mode needs no choosing", () => {
    expect(cardModesOf(card(CHARM))).toHaveLength(1);
    expect(targetingForAnyCard(card(CHARM)).kind).toBe("unit");
  });
});

describe("narrowing by mode", () => {
  const attach = candidate("attach", { targetUnitInstanceId: "mine", targetPermanentInstanceId: "myGear" });
  const detach = candidate("detach", { targetUnitInstanceId: "theirs", targetPermanentInstanceId: "theirGear" });

  it("keeps BOTH modes live before the player has picked", () => {
    // Unset must exclude nothing, for the same reason `matchesPendingCostFilter`
    // gives: narrowing on an unmade choice would empty the pool on arming.
    expect([attach, detach].filter((a) => modeFilterAllows(a, {}))).toHaveLength(2);
  });

  it("drops the other one the moment it is picked", () => {
    expect([attach, detach].filter((a) => modeFilterAllows(a, { modeId: "attach" }))).toEqual([attach]);
    expect([attach, detach].filter((a) => modeFilterAllows(a, { modeId: "detach" }))).toEqual([detach]);
  });

  it("leaves a non-modal card's candidates alone", () => {
    const plain = candidate(undefined, { targetUnitInstanceId: "u1" });
    expect(modeFilterAllows(plain, {})).toBe(true);
  });
});

describe("resolving to exactly one candidate", () => {
  it("REFUSES to settle a modal card until the mode is chosen — the Rocket Barrage bug", () => {
    // The failure this pins is not "no match". It is a WRONG match: a mode-less
    // pending used to be compared only on the target fields, so it selected
    // whichever candidate happened to be enumerated first. Here the strict
    // comparison rejects both, which is what forces the mode step to be asked.
    const damage = candidate("damage", { targetUnitInstanceId: "victim" });
    const killGear = candidate("killGear", { targetPermanentInstanceId: "someGear" });
    expect([damage, killGear].filter((a) => sameMode(a, {}))).toHaveLength(0);
  });

  it("settles on exactly the mode chosen", () => {
    const damage = candidate("damage", { targetUnitInstanceId: "victim" });
    const killGear = candidate("killGear", { targetPermanentInstanceId: "someGear" });
    expect([damage, killGear].filter((a) => sameMode(a, { modeId: "damage" }))).toEqual([damage]);
  });

  it("still settles a NON-modal card, whose actions carry no mode at all", () => {
    // The load-bearing negative. `sameMode` is strict, and a strictness that also
    // rejected ordinary cards would break every card in the game — which is the
    // shape `matchesPendingEquipment`'s gate exists to avoid one field over.
    const plain = candidate(undefined, { targetUnitInstanceId: "u1" });
    expect(sameMode(plain, {})).toBe(true);
  });

  it("and a mode chosen for a card that has none matches nothing", () => {
    const plain = candidate(undefined, { targetUnitInstanceId: "u1" });
    expect(sameMode(plain, { modeId: "attach" })).toBe(false);
  });
});

describe("the census of modal cards", () => {
  /**
   * Two cards is a number worth pinning, not because two is special, but because
   * every claim above ("these are the only modal cards in the pool") rests on it.
   * A third arriving is exactly when this fix stops being complete — and the
   * failure mode of a modal card is silent, so nothing else would say so.
   */
  it("is Angle Shot, Rocket Barrage, Disposal Order, Flurry of Feathers, Curtain Call and Mesmerize", () => {
    // **UNL-103 Disposal Order arrived from a card wave the day after the mode
    // step was built, and this is the assertion that noticed.** It needed no UI
    // change: the step fires for any card with more than one mode, so the card
    // was playable on arrival. Had the fix been written around the two cards that
    // were reported instead of around the mechanism, this would have been a third
    // silent stall — and a modal card fails quietly, so nothing else would say so.
    //
    // The premise is FIXED rather than the assertion weakened: still an exact
    // equality, because the point is that a new one forces a deliberate look.
    // **A FOURTH arrived in wave 3, and it is the sharpest case yet.** Flurry of
    // Feathers counters a spell OR plays four Bird tokens — `{kind:"chainSpell"}`
    // against `{kind:"none"}`. A board that guessed one spec for the card would
    // offer a chain target for the token mode or no target for the counter mode;
    // asking the mode first is the only thing that makes either playable.
    //
    // Still needed no UI change. Two modal cards have now arrived AFTER the mode
    // step was built and both worked on landing, which is the payoff for having
    // fixed the mechanism rather than the two cards that were reported.
    // **A FIFTH arrived in wave 5, and it is the first with FOUR modes.** Curtain
    // Call is draw / burn-at-a-battlefield / burn-at-a-base / shrink, and its two
    // burn modes differ in SCOPE rather than in target kind — one is `scope:
    // "base"`. That is a narrower difference than Flurry's, and it lands on
    // `pendingSlotsAreSymmetric` rather than on the mode step itself.
    //
    // **This test is the reason it was looked at at all.** It failed in the ROOT
    // run of a wave that touched only engine domain files — the exact shape
    // CLAUDE.md's step 1 exists for, and the third time an engine change has been
    // caught by a WEB test. Three modal cards have now arrived after the mode step
    // was built and all three worked on landing; that is the payoff for having
    // fixed the mechanism rather than the two cards originally reported.
    // **A SIXTH arrived with Vendetta's Mind wave 1: VEN-052 Mesmerize**, and it
    // is the plainest case of the lot — "return a FRIENDLY unit to hand" against
    // "give an ENEMY unit -2 [Might]". The two modes differ only in `owner`, which
    // is the narrowest difference yet (Curtain Call's differ in `scope`, Flurry's
    // in target KIND). A board that guessed one spec would offer each mode targets
    // it cannot legally use, and the failure would be silent both ways.
    //
    // Needed no UI change, again — the fourth modal card to arrive after the mode
    // step was built and work on landing. And this test failed in the ROOT run of
    // a wave that touched only engine domain files, for the FOURTH time: exactly
    // what CLAUDE.md's step 1 is for.
    expect(modalCardIds()).toEqual(
      [ANGLE_SHOT, ROCKET_BARRAGE, DISPOSAL_ORDER, FLURRY_OF_FEATHERS, CURTAIN_CALL, MESMERIZE].sort(),
    );
  });
});
