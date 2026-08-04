import { describe, expect, it } from "vitest";
import { computeAutoPayment, type RuneCard, type RunePayment } from "@rift-engine/engine";
import { autoPayFill } from "../src/auto-payment.js";

/**
 * Auto Pay and rule 164.2's DOUBLE DUTY.
 *
 * Reported from play: "I can't cast Falling Star. I have the resources to cast
 * it but after choosing targets nothing happens, even using Auto Pay."
 *
 * The card was always castable. Falling Star is 2 Energy + 2 Fury Power, and the
 * engine pays it with TWO Fury runes listed in both buckets — 164.2, "N runes
 * cover any cost with E <= N and P <= N". The board's Auto Pay built its
 * remaining pool by removing every rune already proposed in EITHER bucket, so
 * once the player had left-clicked two runes for the Energy half there was
 * nothing left to fill the Power half with, and the button silently did nothing.
 */

const fury = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Fury", state });
const empty: RunePayment = { energyRunes: [], powerRunes: [] };

/** Falling Star's cost, as the engine enumerates it. */
function fallingStarRequired(pool: readonly RuneCard[]): RunePayment {
  const payment = computeAutoPayment(pool, 2, 2, "Fury");
  if (!payment) throw new Error("fixture pool cannot pay Falling Star");
  return payment;
}

describe("the engine's own payment is what the board has to be able to build", () => {
  it("pays 2 Energy + 2 Power from just TWO runes, listing them twice", () => {
    // The fact the board could not express. If this ever stops being true, the
    // premise of everything below has changed.
    const pool = [fury("f0"), fury("f1")];
    expect(fallingStarRequired(pool)).toEqual({
      energyRunes: ["f0", "f1"],
      powerRunes: ["f0", "f1"],
    });
  });
});

/**
 * The OLD algorithm, verbatim, kept as the thing this test file exists to catch —
 * the `REGRESS=1` pattern `piles-check.mjs` already uses. A fix nobody can make
 * fail is not verified.
 */
function oldAutoPayFill(
  channeled: readonly RuneCard[],
  proposed: RunePayment,
  required: RunePayment,
): { energyRunes: string[]; powerRunes: string[] } | null {
  const remainingEnergy = required.energyRunes.length - proposed.energyRunes.length;
  const remainingPower = required.powerRunes.length - proposed.powerRunes.length;
  if (remainingEnergy <= 0 && remainingPower <= 0) return null;
  // The defect: ONE pot for both buckets.
  const proposedIds = new Set([...proposed.energyRunes, ...proposed.powerRunes]);
  const remainingPool = channeled.filter((r) => !proposedIds.has(r.id));
  const fill = computeAutoPayment(remainingPool, Math.max(remainingEnergy, 0), Math.max(remainingPower, 0), "Fury");
  return fill ? { energyRunes: fill.energyRunes, powerRunes: fill.powerRunes } : null;
}

describe("the OLD Auto Pay could not do it — the failure this file pins", () => {
  it("returned null for the reported board, which is the dead button", () => {
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    expect(
      oldAutoPayFill(pool, proposed, fallingStarRequired(pool)),
      "the old algorithm no longer reproduces the bug — has the premise changed?",
    ).toBeNull();
    // And the new one does not.
    expect(autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury")).not.toBeNull();
  });

  it("also spent FOUR runes on a 2+2 cost when the pool was big enough to hide it", () => {
    // The quieter half of the same bug: with four runes Auto Pay "worked", by
    // paying twice what 164.2 asks. Nothing surfaced it, because the play went
    // through.
    const pool = [fury("f0"), fury("f1"), fury("f2"), fury("f3")];
    const afterEnergy: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const old = oldAutoPayFill(pool, afterEnergy, fallingStarRequired(pool));
    expect(old).not.toBeNull();
    expect(new Set([...afterEnergy.energyRunes, ...old!.powerRunes]).size).toBe(4);

    const fresh = autoPayFill(pool, afterEnergy, fallingStarRequired(pool), "Fury");
    expect(new Set([...afterEnergy.energyRunes, ...fresh!.powerRunes]).size, "still spending four runes").toBe(2);
  });
});

describe("autoPayFill: a rune already spent on Energy still pays Power", () => {
  it("completes the payment when the player has claimed the whole pool for Energy", () => {
    // THE REPORTED CASE. Two Fury runes, both left-clicked for Energy. The old
    // pool-wide exclusion left nothing and returned null — the dead button.
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill, "Auto Pay still cannot finish a double-duty payment").not.toBeNull();
    expect(fill!.powerRunes).toHaveLength(2);
    expect(fill!.energyRunes).toEqual([]);
  });

  it("still completes it with three runes, where the old pool left only one", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes).toHaveLength(2);
  });

  it("fills BOTH halves from a clean start, and does not spend four runes on a 2+2 cost", () => {
    // The clean path has to keep working, and keep being frugal: the whole point
    // of double duty is that this costs two runes, not four.
    const pool = [fury("f0"), fury("f1"), fury("f2"), fury("f3")];
    const fill = autoPayFill(pool, empty, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).toHaveLength(2);
    expect(fill!.powerRunes).toHaveLength(2);
    const distinct = new Set([...fill!.energyRunes, ...fill!.powerRunes]);
    expect(distinct.size, "Auto Pay spent four runes on a cost two can cover").toBe(2);
  });

  it("completes the other way round too — Power claimed by hand, Energy owed", () => {
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: [], powerRunes: ["f0", "f1"] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).toHaveLength(2);
    expect(fill!.powerRunes).toEqual([]);
  });

  it("never proposes a rune the same bucket already holds", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const proposed: RunePayment = { energyRunes: ["f0"], powerRunes: ["f0"] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).not.toContain("f0");
    expect(fill!.powerRunes).not.toContain("f0");
  });

  it("returns null when there is genuinely nothing owed", () => {
    const pool = [fury("f0"), fury("f1")];
    const required = fallingStarRequired(pool);
    expect(autoPayFill(pool, required, required, "Fury")).toBeNull();
  });

  it("returns null when the pool really cannot pay — the honest refusal", () => {
    // One Fury rune against 2 Energy + 2 Power. Double duty covers E <= N and
    // P <= N, and N is 1, so this is a real no.
    const pool = [fury("f0")];
    const required: RunePayment = { energyRunes: ["x", "y"], powerRunes: ["x", "y"] };
    expect(autoPayFill(pool, empty, required, "Fury")).toBeNull();
  });

  it("respects the DOMAIN on the Power half while leaving Energy domain-free", () => {
    // Energy takes any Ready rune (415); Power must match the card's pip.
    const pool: RuneCard[] = [fury("f0"), { id: "c0", domain: "Calm", state: "Ready" }];
    const required: RunePayment = { energyRunes: ["a"], powerRunes: ["b"] };
    const fill = autoPayFill(pool, empty, required, "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes, "an off-domain rune was proposed for a Fury pip").toEqual(["f0"]);
  });

  it("uses an EXHAUSTED rune for Power, which a Power cost may (416)", () => {
    // A Power cost recycles rather than exhausts, so an exhausted rune pays it —
    // and the Energy half must not touch it.
    const pool = [fury("e0", "Exhausted"), fury("r0")];
    const required: RunePayment = { energyRunes: ["a"], powerRunes: ["b"] };
    const fill = autoPayFill(pool, empty, required, "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes).toEqual(["e0"]);
    expect(fill!.energyRunes, "an exhausted rune was proposed for Energy").toEqual(["r0"]);
  });
});
