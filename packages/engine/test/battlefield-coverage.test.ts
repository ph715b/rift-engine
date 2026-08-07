import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import {
  BATTLEFIELD_TRIGGERS,
  battlefieldAbilityDefIds,
  beginningPhaseBattlefieldDefIds,
} from "../src/engine/battlefield-abilities.js";
import { continuousBattlefieldDefIds } from "../src/engine/battlefield-continuous.js";
import { activatedAbilityDefIds } from "../src/engine/activated-abilities.js";
import { COMPLETE_BATTLEFIELD_SETS, implementingModule, setCodeOf } from "../src/engine/coverage.js";

/**
 * The completeness gate for battlefields — the only thing that can tell a
 * battlefield with no printed ability from one whose ability was never written.
 *
 * It exists because battlefields are invisible to every other measurement this
 * repo has. `card-loader`'s `shouldSkip` keeps Battlefield-type cards out of
 * `loadCardDefinitions` entirely, so `needsImplementation` never counts one and
 * `coverage.isCardImplemented` is never asked about one. A battlefield whose
 * ability is missing therefore costs nothing, breaks nothing, and reports
 * nothing — which is exactly how all 24 of them sat inert for the life of this
 * engine.
 *
 * The three tables are disjoint by construction and by intent: a TRIGGERED
 * ability is a Chain Pending Item, a CONTINUOUS one is read at a gate, and the
 * Beginning-Phase pair are resolved inline. Nothing should be in two of them.
 *
 * **Scoped to `COMPLETE_BATTLEFIELD_SETS` since 2026-08-04**, for the same reason the card
 * gates already are. SFD prints 15 battlefields and landed with none of them
 * implemented; leaving this whole-pool would have meant a suite that is red for
 * as long as the set takes, and a gate expected to be red says nothing when it
 * is. OGN's 24 keep their hard gate; SFD's 15 are reported as progress and
 * become gated the moment "SFD" joins COMPLETE_BATTLEFIELD_SETS — one line, in the same
 * place that promotes the cards.
 */

describe("every printed battlefield does something", () => {
  const defs = loadBattlefieldDefinitions();
  const gated = defs.filter((d) => COMPLETE_BATTLEFIELD_SETS.includes(setCodeOf(d.id)));
  const inProgress = defs.filter((d) => !COMPLETE_BATTLEFIELD_SETS.includes(setCodeOf(d.id)));

  /**
   * The FOUR places a battlefield's printed text can be implemented.
   *
   * The fourth is Forge of the Fluft, whose text is an ACTIVATED ability its
   * controller's Legend has — so it is keyed by the battlefield's own defId in
   * `ACTIVATED_ABILITIES` and offered through `abilitiesAvailableTo`, the same
   * borrow list Heimerdinger uses. This gate is the only thing that can see a
   * battlefield at all, so a source it does not know about reads as a
   * battlefield that does nothing.
   */
  const implemented = new Map<string, string>([
    ...battlefieldAbilityDefIds().map((id) => [id, "triggered"] as const),
    ...continuousBattlefieldDefIds().map((id) => [id, "continuous"] as const),
    ...beginningPhaseBattlefieldDefIds().map((id) => [id, "beginning-phase"] as const),
    ...activatedAbilityDefIds()
      .filter((id) => defs.some((d) => d.id === id))
      .map((id) => [id, "granted activated ability"] as const),
  ]);

  it("the pool is 39 battlefields — 24 OGN and 15 SFD, and OGS prints none", () => {
    // A positive control on the measurement itself: an empty or truncated
    // definition list would make every assertion below vacuously pass.
    expect(defs).toHaveLength(39);
    const bySet = new Map<string, number>();
    for (const d of defs) bySet.set(setCodeOf(d.id), (bySet.get(setCodeOf(d.id)) ?? 0) + 1);
    expect([...bySet].sort()).toEqual([
      ["OGN", 24],
      ["SFD", 15],
    ]);
    // The gate is only worth something while it actually gates something. All 39
    // now: OGN's 24 have been hard-gated since this file was written, and SFD's
    // 15 joined them when Forge of the Fluft — the last one — landed.
    expect(gated.length, "no battlefield is under a hard gate — COMPLETE_BATTLEFIELD_SETS has lost its subject").toBe(39);
  });

  it("every battlefield of a COMPLETE set has an implementation, and the failure NAMES it", () => {
    const missing = gated.filter((d) => !implemented.has(d.id)).map((d) => `${d.id} ${d.name}: ${d.text}`);
    expect(
      missing,
      `These battlefields are in play and do nothing. Add each to BATTLEFIELD_TRIGGERS,\n` +
        `BATTLEFIELD_CONTINUOUS, or runBattlefieldBeginningPhase:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("reports an in-progress set's battlefields as progress rather than failing", () => {
    // The SFD equivalent of `setProgressLine`. It prints what is left so the
    // number is watchable, and it asserts the one thing that would otherwise go
    // unnoticed: a set finishing its battlefields and never being promoted, at
    // which point this file stops protecting them.
    const done = inProgress.filter((d) => implemented.has(d.id));
    for (const set of new Set(inProgress.map((d) => setCodeOf(d.id)))) {
      const all = inProgress.filter((d) => setCodeOf(d.id) === set);
      const left = all.filter((d) => !implemented.has(d.id));
      console.log(
        `in progress — ${set} battlefields: ${all.length - left.length}/${all.length} implemented` +
          (left.length > 0 ? ` — left: ${left.map((d) => `${d.id} (${d.name})`).join(", ")}` : ""),
      );
      expect(
        left.length === 0 && !COMPLETE_BATTLEFIELD_SETS.includes(set),
        `${set}'s battlefields are all implemented — add ${set} to COMPLETE_BATTLEFIELD_SETS so this gate starts protecting them`,
      ).toBe(false);
    }
    expect(done.length + inProgress.filter((d) => !implemented.has(d.id)).length).toBe(inProgress.length);
  });

  it("every one of the 39 prints real rules text — there is nothing vacuous to cover", () => {
    // The other half of the gate. If a battlefield printed nothing, "implemented"
    // would be a claim about an empty string.
    for (const def of defs) {
      expect(def.text.length, `${def.name} has no printed text`).toBeGreaterThan(0);
    }
  });

  it("no battlefield is claimed by two of the three tables", () => {
    const all = [...battlefieldAbilityDefIds(), ...continuousBattlefieldDefIds(), ...beginningPhaseBattlefieldDefIds()];
    const seen = new Set<string>();
    const duplicates = all.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicates, "a battlefield is implemented twice — which of the two runs?").toEqual([]);
  });

  it("no table names something that is not a printed battlefield", () => {
    // The reverse direction, and the one that catches a typo'd defId: an entry
    // nothing in play can ever match is silent, and reads as implemented.
    const real = new Set(defs.map((d) => d.id));
    for (const id of implemented.keys()) {
      expect(real.has(id), `${id} is registered as a battlefield ability but is not a printed battlefield`).toBe(true);
    }
  });

  it("coverage.ts can say where each one is implemented", () => {
    // `implementingModule` is what the drift test and any "why is this card
    // marked implemented?" question go through. A battlefield it cannot place is
    // a battlefield a future audit will report as inert.
    // Scoped to the gated sets: an unimplemented SFD battlefield legitimately
    // has no module yet, and asserting otherwise would just be the same red as
    // the implementation gate above wearing a different message.
    for (const def of gated) {
      expect(implementingModule(def.id), `coverage.ts cannot place ${def.name}`).toBeDefined();
    }
  });

  it("every TRIGGERED battlefield declares a moment something actually fires", () => {
    // A registry entry whose `on` names a moment no site produces would be a
    // silent no-op — the shape `resolvePendingTrigger` was changed to throw for.
    const fired = new Set(["hold", "conquer", "defend", "unitMovedFrom", "unitChosenBySpell", "endOfTurn"]);
    for (const [defId, abilities] of Object.entries(BATTLEFIELD_TRIGGERS)) {
      expect(abilities.length, `${defId} has an empty ability list`).toBeGreaterThan(0);
      for (const ability of abilities) {
        expect(fired.has(ability.on), `${defId} listens for "${ability.on}", which nothing fires`).toBe(true);
      }
    }
  });
});
