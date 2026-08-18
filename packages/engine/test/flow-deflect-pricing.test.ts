import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **The sixth instance of this codebase's offered-then-refused bug, pinned where
 * it was found.**
 *
 * `legal-actions` re-prices a variant when its target carries `[Deflect]` — the
 * surcharge is owed for choosing a particular unit, so two variants of one card
 * can cost differently. That re-pricing computed the tax against the card's
 * PRINTED cost unconditionally, which is right for a printed-price play and wrong
 * for the two alternative pricings beside it: a replaced cost (829.1's `[Flow]`)
 * and an XP-discounted one.
 *
 * The result was an action the enumerator offered and the validator refused, and
 * `execute-play-card` THROWS on that rather than returning a failure — so it
 * crashed the reachability probe outright rather than showing up as a refusal.
 *
 * It was latent from the day `[Flow]` landed and needed three things at once:
 * a Flow spell in the trash, a legal target carrying `[Deflect]`, and enough
 * runes for the untaxed play to look affordable. No test had all three, because
 * no test enumerates and then validates the same action — which this file's own
 * neighbours note is the only way this class ever shows up.
 *
 * Written as an INVARIANT over the whole action list rather than as one action's
 * price, so it cannot go stale as the pool grows: every action the enumerator
 * offers must validate.
 */

const registry = defaultCardRegistry();

/** Lacerate — 2 Energy / 1 Order printed, `[Flow] 4 Energy + 2 Order`. The only
 *  Flow cost in the pool with TWO pips of a NAMED domain, which is what made the
 *  mispricing large enough to be refused rather than coincidentally equal. */
const LACERATE = "VEN-127";
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Every Ready rune a generous board would have — mixed domains, because the
 *  crash state had Calm runes beside the Order ones and the payment walk
 *  interleaves them. */
const runes = (): RuneCard[] => [
  rune("o1", "Order"),
  rune("c1", "Calm"),
  rune("o2", "Order"),
  rune("o3", "Order"),
  rune("c2", "Calm"),
  rune("c3", "Calm"),
  rune("o4", "Order"),
  rune("c4", "Calm"),
];

/** A unit carrying `[Deflect N]`, found in the pool rather than invented — the
 *  surcharge is read off `effectiveKeywords`, so a hand-built instance with a
 *  made-up keyword would not exercise the same path. */
function deflectingUnitDefId(): string {
  const found = registry
    .all()
    .find((d) => d.type === "Unit" && ((d as { keywords?: Record<string, number> }).keywords?.Deflect ?? 0) > 0);
  expect(found, "no card in the pool prints [Deflect] — this test measures nothing").toBeDefined();
  return found!.id;
}

function board(): GameState {
  const state = makeState({ phase: "Action" });
  // Lacerate in the TRASH, which is the only zone its Flow cost may be paid from
  // (829.1.c.1).
  state.players[0]!.trash = [spellInstance(LACERATE)];
  state.players[0]!.channeled = runes();
  // A DEFLECTING enemy unit at a battlefield, which is what makes the target
  // carry a surcharge, plus an ordinary one so the untaxed variant exists too.
  state.battlefields[0]!.units = {
    p2: [realUnitInstance(deflectingUnitDefId()), makeUnit({ instanceId: "plain", might: 2 })],
  };
  return state;
}

describe("every enumerated play validates — the enumerate/execute split", () => {
  it("a [Flow] spell aimed at a [Deflect] unit is priced the same by both halves", () => {
    const state = board();
    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === LACERATE,
    );

    expect(plays.length, "Lacerate was not castable at all — the fixture measures nothing").toBeGreaterThan(0);
    expect(
      plays.some((p) => p.replacedCostPaid === true),
      "no [Flow] variant was enumerated — the fixture never reaches the branch this pins",
    ).toBe(true);

    for (const play of plays) {
      expect(validatePlayCard(state, play), `the enumerator offered a play the validator refuses: ${JSON.stringify(play)}`)
        .toMatchObject({ ok: true });
    }
  });

  it("...and submitting one is accepted rather than THROWN", () => {
    // `execute-play-card` throws on a validation failure rather than returning
    // one, so this class crashes a probe outright instead of being counted as a
    // refusal. Driven through `submit` so the real path is the one measured.
    const state = board();
    const flow = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === LACERATE && a.replacedCostPaid === true,
    );
    expect(flow, "no [Flow] variant to submit").toBeDefined();

    const { result } = submit(state, flow!);

    expect(result).toMatchObject({ type: "Ok" });
  });

  it("no payment ever spends one rune twice", () => {
    // The shape the crash's payment had: `rune-287` appeared in both
    // `energyRunes` and `powerRunes`. That is legal ONLY for the Ready-rune
    // double duty `computeAutoPayment` documents (a Ready rune exhausts for
    // Energy and recycles for Power), so it is asserted per BUCKET rather than
    // across them — a bucket that names the same rune twice is always wrong.
    const state = board();
    for (const play of legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard")) {
      for (const [bucket, ids] of Object.entries(play.payment)) {
        expect(new Set(ids as string[]).size, `${play.card.name} spends a rune twice in ${bucket}`).toBe(
          (ids as string[]).length,
        );
      }
    }
  });
});
