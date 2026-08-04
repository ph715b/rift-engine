import { describe, expect, it } from "vitest";
import { battlefieldDefIdFor, battlefieldPair } from "../src/decks/battlefield-setup.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { LEGACY_BATTLEFIELDS } from "../src/decks/deck-list.js";

/**
 * A battlefield in play now knows WHICH printed card it is.
 *
 * This is the change every battlefield ability depends on, and it is worth its own
 * file because it is load-bearing while doing nothing observable on its own —
 * exactly the shape that gets half-built and reported as finished.
 *
 * Why it did not exist before: `card-loader`'s `shouldSkip` excludes
 * Battlefield-type cards from `loadCardDefinitions`, and its comment gives the
 * reason — "`BattlefieldState` carries no per-name ability yet, so there's no
 * playable CardDefinition to build". That is circular, and this breaks the circle
 * from the state's side: `BattlefieldState.defId` gives an ability table something
 * to key off, without making a battlefield a playable card (it is not one — it is
 * never in a deck, never drawn and never played).
 *
 * All 24 printed battlefields carry real rules text. None of it is implemented
 * yet; see docs/battlefields-and-ui-prompt.md for the clusters.
 */
describe("a battlefield in play carries its printed card id", () => {
  it("resolves every name the engine can actually put into play", () => {
    // LEGACY_BATTLEFIELDS is the fallback a deck with no battlefields of its own
    // gets, so these three are the common case. If they do not resolve, the
    // feature is off for most games while looking present.
    for (const name of LEGACY_BATTLEFIELDS) {
      expect(battlefieldDefIdFor(name), `${name} has no printed card`).toBeDefined();
    }
  });

  it("covers the whole printed pool and round-trips by id", () => {
    const defs = loadBattlefieldDefinitions();
    expect(defs.length, "no battlefield cards loaded at all").toBeGreaterThan(0);
    for (const def of defs) {
      expect(battlefieldDefIdFor(def.name), `${def.name} did not round-trip`).toBe(def.id);
    }
  });

  it("stamps the id onto both battlefields at construction", () => {
    const [human, ai] = battlefieldPair("Zaun Warrens", "Targon's Peak");
    expect(human.defId).toBe(battlefieldDefIdFor("Zaun Warrens"));
    expect(ai.defId).toBe(battlefieldDefIdFor("Targon's Peak"));
    // The ids stay positional and stable — every action and target references
    // them, so they must not start depending on which card was drawn.
    expect([human.id, ai.id]).toEqual(["bf-0", "bf-1"]);
  });

  it("leaves defId ABSENT for a name no card matches, rather than guessing", () => {
    // A deck file can name anything. Absent means "no printed ability"; it must
    // never be a signal to go looking by name at read time, which is how two
    // copies of the same lookup start disagreeing.
    const [only] = battlefieldPair("Not A Real Battlefield", "Zaun Warrens");
    expect(only.defId).toBeUndefined();
  });

  it("names a card whose text is real, which is what an ability table will read", () => {
    const [human] = battlefieldPair("Zaun Warrens", "Zaun Warrens");
    const def = loadBattlefieldDefinitions().find((d) => d.id === human.defId);
    expect(def, "the stamped id matches no definition").toBeDefined();
    expect(def!.text.length).toBeGreaterThan(10);
  });
});
