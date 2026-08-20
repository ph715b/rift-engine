import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { COMPLETE_SETS } from "../src/engine/coverage.js";

/**
 * **Vendetta's card FILE is partial, on purpose, and this is what says so — even
 * though the SET is now declared complete.**
 *
 * Those are two different claims and conflating them is the trap this file now
 * exists to keep open. `COMPLETE_SETS` means "every card the pool HAS is
 * implemented"; it does not mean "every card Riot printed for Vendetta is in this
 * repo". As of 2026-08-19 the first is true and the second is not: 18 records are
 * still dropped by the generator because upstream cannot classify them, and this
 * file is the only thing that says so.
 *
 * Every other set in `src/cards/` is the whole set. `ven.json` is 209 of the
 * set's 227 cards, because the Riftcodex API serves Vendetta as TWO live ingests
 * and only the reconciled one carries trustworthy `alternate_art` /
 * `overnumbered` flags. `tools/card-data/fetch-set.mjs` writes every record whose
 * printing status the data determines and drops the rest; `set-audit.mjs VEN` is
 * the gate, and exits 0 by itself once upstream finishes.
 *
 * A partial set is exactly the kind of thing that reads as finished six weeks
 * later, so the omission is asserted rather than described:
 *
 *   - the MAIN SET is whole — all 166 collector numbers, which is what makes the
 *     set playable at all;
 *   - the missing ids are named, so re-running the generator after upstream
 *     reconciles fails HERE and nowhere else;
 *   - VEN IS in `COMPLETE_SETS` as of 2026-08-19, and what that does and does
 *     not claim is asserted below rather than left to be inferred.
 *
 * Delete this file when the generator's dropped list empties — NOT when the set
 * is declared, which has already happened.
 */

const registry = defaultCardRegistry();
const ven = () => registry.all().filter((d) => d.id.startsWith("VEN-"));

/**
 * The 18 records `fetch-set.mjs` drops today, by id.
 *
 * Fourteen sit above the main-set band, where genuine additional cards and
 * alternate printings of main-set cards are interleaved and only
 * `metadata.overnumbered` separates them — so an unreconciled record there cannot
 * be classified from any field. Three carry a variant letter and would enter the
 * pool as duplicate playable cards, since their `alternate_art` reads false. One
 * is a special (`sp1`).
 *
 * **Both derivations that would rescue these were tested against records where
 * the answer is known, and both are false**: collector > set size has five
 * counterexamples, and name-matching fails on `VEN-194 "Defender of Tomorrow"`,
 * which is provably the Overnumbered print of `VEN-149 "Jayce - Defender of
 * Tomorrow"` yet shares no name with it.
 */
const NOT_YET_CLASSIFIABLE = [
  "VEN-084a",
  "VEN-092a",
  "VEN-113a",
  "VEN-170",
  "VEN-171",
  "VEN-172",
  "VEN-173",
  "VEN-174",
  "VEN-177",
  "VEN-178",
  "VEN-183",
  "VEN-184",
  "VEN-185",
  "VEN-186",
  "VEN-187",
  "VEN-188",
  "VEN-194",
  "VEN-sp1",
] as const;

describe("Vendetta is landed PARTIALLY, and says so", () => {
  it("loads the whole main set — every collector number 1..166", () => {
    // The half that makes the set playable. `shouldSkip` drops this set's 10
    // Battlefields and its Runes from the playable pool, so the loaded ids are a
    // subset of 1..166 rather than all of it — what must hold is that nothing in
    // the band is MISSING for the reason this file exists, i.e. dropped by the
    // generator.
    const dropped = NOT_YET_CLASSIFIABLE.filter((id) => /^VEN-\d+$/.test(id));
    const inMainBand = dropped.filter((id) => Number(id.slice(4)) <= 166);
    expect(inMainBand, "a MAIN-SET card was dropped — the set is no longer playable as printed").toEqual([]);
  });

  it("does not load the records whose printing status the data cannot settle", () => {
    const loaded = new Set(ven().map((d) => d.id));
    const present = NOT_YET_CLASSIFIABLE.filter((id) => loaded.has(id));
    expect(
      present,
      "the generator started emitting a record it used to drop — re-run tools/card-data/set-audit.mjs VEN, " +
        "and if it now reports CLEAR, delete this file and declare the set",
    ).toEqual([]);
  });

  it("IS declared complete — and that is a claim about the cards, not the file", () => {
    // **This pin asserted `not.toContain` and flipped on 2026-08-19**, when the
    // last card in the pool (VEN-069 Mel, Newly Awakened) landed. Its reasoning
    // was right for as long as it stood: declaring early turns on
    // `reachability.everyUnexercisedExplained` and would have held a set 173 cards
    // short to "every card no run has seen act is offered or excused" — a wall of
    // noise exactly when the instruments most need to be readable.
    //
    // Inverted rather than deleted, and paired with the negative that is STILL
    // TRUE, because the pair is the whole point: the set is declared while the
    // file is short 18 records. Anyone reading "VEN is complete" and expecting all
    // 227 printed cards is reading a claim nobody made.
    expect(COMPLETE_SETS, "the set was un-declared again").toContain("VEN");
    expect(
      NOT_YET_CLASSIFIABLE.length,
      "the dropped list emptied — re-run tools/card-data/set-audit.mjs VEN and delete this file",
    ).toBeGreaterThan(0);
  });

  it("loads 178 playable definitions from 209 records", () => {
    // The positive control: an empty or truncated file would make every
    // assertion above vacuously pass. 209 records minus this set's Battlefields,
    // Runes and reconciled alternate arts, which `shouldSkip` drops.
    expect(ven().length).toBe(178);
  });
});
