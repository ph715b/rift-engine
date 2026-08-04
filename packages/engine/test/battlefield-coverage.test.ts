import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import {
  BATTLEFIELD_TRIGGERS,
  battlefieldAbilityDefIds,
  beginningPhaseBattlefieldDefIds,
} from "../src/engine/battlefield-abilities.js";
import { continuousBattlefieldDefIds } from "../src/engine/battlefield-continuous.js";
import { implementingModule } from "../src/engine/coverage.js";

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
 */

describe("every printed battlefield does something", () => {
  const defs = loadBattlefieldDefinitions();

  /** The three places a battlefield's printed text can be implemented. */
  const implemented = new Map<string, string>([
    ...battlefieldAbilityDefIds().map((id) => [id, "triggered"] as const),
    ...continuousBattlefieldDefIds().map((id) => [id, "continuous"] as const),
    ...beginningPhaseBattlefieldDefIds().map((id) => [id, "beginning-phase"] as const),
  ]);

  it("the pool really is 24 battlefields, all of them OGN", () => {
    // A positive control on the measurement itself: an empty or truncated
    // definition list would make every assertion below vacuously pass.
    expect(defs).toHaveLength(24);
    expect(defs.every((d) => d.id.startsWith("OGN-"))).toBe(true);
  });

  it("every one of the 24 has an implementation, and the failure NAMES it", () => {
    const missing = defs.filter((d) => !implemented.has(d.id)).map((d) => `${d.id} ${d.name}: ${d.text}`);
    expect(
      missing,
      `These battlefields are in play and do nothing. Add each to BATTLEFIELD_TRIGGERS,\n` +
        `BATTLEFIELD_CONTINUOUS, or runBattlefieldBeginningPhase:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("every one of the 24 prints real rules text — there is nothing vacuous to cover", () => {
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

  it("no table names something that is not one of the 24", () => {
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
    for (const def of defs) {
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
