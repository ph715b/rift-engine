import { describe, expect, it } from "vitest";
import { stripTemporaryModifications } from "../src/engine/effect-helpers.js";
import { makeUnit } from "./fixtures.js";
import type { UnitInstance } from "../src/model/card.js";

/**
 * **124.1 — what a Game Object stops tracking when it crosses to or from a
 * Non-Board Zone.**
 *
 * > "Whenever a Game Object changes zones to or from a Non-Board Zone, all
 * > Temporary Modifications of all kinds cease to be tracked on it in all
 * > capacities. Examples: **Damage is cleared. Counters are removed.** Granted
 * > Keywords are no longer granted. **Statuses are cleared.**"
 *
 * **124.2** enumerates the statuses; the ones an instance carries are Buffed,
 * Empowered and Exhausted.
 *
 * # Why this file exists rather than more per-card tests
 *
 * The divergence was recorded against ONE card's behaviour (a raised unit
 * keeping its damage) and pinned in that card's file. That pin was correct and
 * it only ever covered `damage` and `mightThisTurn` — the two fields the card in
 * front of the author happened to set. **Both zone exits were also silent on
 * `extraBuffs`, `baseMightThisTurn`, `empowered` and
 * `unchooseableByEnemiesThisTurn`**, and no per-card test would have found that,
 * because no single card sets them all.
 *
 * So this asserts the RULE against the funnel, field by field, and the per-card
 * pin stays where it is as the end-to-end proof that a real play reaches it.
 */

/** A unit carrying one of every temporary modification an instance can hold. */
function fullyModified(): UnitInstance {
  return {
    ...makeUnit({ might: 3, name: "Modified" }),
    damage: 4,
    mightThisTurn: 2,
    baseMightThisTurn: 5,
    buffed: true,
    extraBuffs: 2,
    exhausted: true,
    empowered: true,
    unchooseableByEnemiesThisTurn: true,
  };
}

describe("124.1: crossing a Non-Board Zone strips every temporary modification", () => {
  it("clears the two the old pin covered", () => {
    const before = fullyModified();
    // The fixture control: these must really be set, or clearing them proves
    // nothing. This is the shape that made the original pin partial.
    expect(before.damage).toBe(4);
    expect(before.mightThisTurn).toBe(2);

    const after = stripTemporaryModifications(before);
    expect(after.damage, "Damage is cleared").toBe(0);
    expect(after.mightThisTurn, "a this-turn Might modification survived").toBe(0);
  });

  it("clears the STATUSES 124.2 names — Buffed, Empowered, Exhausted", () => {
    const after = stripTemporaryModifications(fullyModified());
    expect(after.buffed, "Buffed survived").toBe(false);
    expect(after.empowered, "Empowered survived").toBeUndefined();
    expect(after.exhausted, "Exhausted survived").toBe(false);
  });

  it("removes the COUNTERS and the Layer alteration — the half nothing covered", () => {
    // `extraBuffs` is 124.1's "Counters are removed"; `baseMightThisTurn` is
    // 124.2's "any applied Layer alternations" (Dragon Form's "its base Might
    // becomes 5 this turn"). Neither zone exit touched either before 2026-08-23.
    const after = stripTemporaryModifications(fullyModified());
    expect(after.extraBuffs, "buff counters survived").toBeUndefined();
    expect(after.baseMightThisTurn, "a base-Might Layer alteration survived").toBeUndefined();
    expect(after.unchooseableByEnemiesThisTurn, "a this-turn protection survived").toBeUndefined();
  });

  it("DELETES the optional keys rather than setting them undefined", () => {
    // `exactOptionalPropertyTypes` makes a present-but-undefined key a different
    // type from an absent one, and `baseMightThisTurn` is read as
    // `?? unit.might` — a present `undefined` is a different question from an
    // absent key. `toBeUndefined` above passes either way, so this is the
    // assertion that says which.
    const after = stripTemporaryModifications(fullyModified());
    expect(Object.hasOwn(after, "baseMightThisTurn"), "the key was kept as undefined").toBe(false);
    expect(Object.hasOwn(after, "extraBuffs")).toBe(false);
    expect(Object.hasOwn(after, "empowered")).toBe(false);
    expect(Object.hasOwn(after, "unchooseableByEnemiesThisTurn")).toBe(false);
  });

  it("leaves the card's IDENTITY and printed traits alone", () => {
    // The negative control. A strip that reset the printed Might, the keywords or
    // the instance id would pass every assertion above and destroy the card.
    const before = fullyModified();
    const after = stripTemporaryModifications(before);
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.defId).toBe(before.defId);
    expect(after.might, "printed Might was reset").toBe(before.might);
    expect(after.keywords, "printed keywords were stripped").toEqual(before.keywords);
    expect(after.tags).toEqual(before.tags);
  });

  it("is a no-op on a unit carrying nothing", () => {
    // So the funnel can be called unconditionally at every zone exit without a
    // caller having to ask whether it is needed.
    const plain = makeUnit({ might: 2, name: "Plain" });
    expect(stripTemporaryModifications(plain)).toEqual(plain);
  });
});
