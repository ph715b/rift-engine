import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import {
  BATTLEFIELD_TRIGGERS,
  battlefieldAbilityDefIds,
  beginningPhaseBattlefieldDefIds,
} from "../src/engine/battlefield-abilities.js";
import { continuousBattlefieldDefIds } from "../src/engine/battlefield-continuous.js";
import { abilityDiscountBattlefieldDefIds, activatedAbilityDefIds } from "../src/engine/activated-abilities.js";
import { deathReplacementBattlefieldDefIds } from "../src/engine/death-ward.js";
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
   * The SIX places a battlefield's printed text can be implemented.
   *
   * The fourth is Forge of the Fluft, whose text is an ACTIVATED ability its
   * controller's Legend has — so it is keyed by the battlefield's own defId in
   * `ACTIVATED_ABILITIES` and offered through `abilitiesAvailableTo`, the same
   * borrow list Heimerdinger uses.
   *
   * The fifth is Altar of Blood, whose text is a DEATH REPLACEMENT: "if a unit
   * here would die during combat, its controller may pay [3 rainbow] to heal it,
   * exhaust it, and recall it instead". Nothing dispatches on "a unit would die"
   * except `killUnit`, so it lives in `death-ward.ts` beside the Armory's and
   * Sett's offers rather than in any of the tables above.
   *
   * **This gate is the only thing that can see a battlefield at all, so a source
   * it does not know about reads as a battlefield that does nothing** — which is
   * exactly what happened when Altar of Blood landed and this list still had four
   * entries.
   *
   * The sixth is Risen Altar and Piltovan Forge, whose whole text is a DISCOUNT on
   * some OTHER ability's cost. They are not keyed by their own defId anywhere —
   * there is no ability entry to find — so they are reported by their own export
   * from `activated-abilities.ts`. Same lesson, one wave later.
   */
  const implemented = new Map<string, string>([
    ...battlefieldAbilityDefIds().map((id) => [id, "triggered"] as const),
    ...continuousBattlefieldDefIds().map((id) => [id, "continuous"] as const),
    ...beginningPhaseBattlefieldDefIds().map((id) => [id, "beginning-phase"] as const),
    ...activatedAbilityDefIds()
      .filter((id) => defs.some((d) => d.id === id))
      .map((id) => [id, "granted activated ability"] as const),
    ...deathReplacementBattlefieldDefIds().map((id) => [id, "death replacement"] as const),
    ...abilityDiscountBattlefieldDefIds().map((id) => [id, "ability cost discount"] as const),
  ]);

  it("the pool is 64 battlefields — 24 OGN, 15 SFD, 15 UNL, 10 VEN, and OGS prints none", () => {
    // A positive control on the measurement itself: an empty or truncated
    // definition list would make every assertion below vacuously pass.
    //
    // **VEN's 10 are UNIMPLEMENTED and that is expected**, not a regression: the
    // set landed 2026-08-16 with its cards unwritten, and `COMPLETE_BATTLEFIELD_SETS`
    // deliberately does not name VEN, so the per-set gate below does not hold it
    // to anything yet. That list is separate from `COMPLETE_SETS` for exactly this
    // reason — battlefields finish on their own schedule.
    expect(defs).toHaveLength(64);
    const bySet = new Map<string, number>();
    for (const d of defs) bySet.set(setCodeOf(d.id), (bySet.get(setCodeOf(d.id)) ?? 0) + 1);
    expect([...bySet].sort()).toEqual([
      ["OGN", 24],
      ["SFD", 15],
      ["UNL", 15],
      ["VEN", 10],
    ]);
    // **ALL 64, as of 2026-08-22.** OGN's 24 have been hard-gated since this file
    // was written, SFD's 15 joined when Forge of the Fluft landed, and UNL's 15
    // and VEN's 10 joined together when the nine-wave pass finished the pool.
    //
    // Every printed battlefield in the game is now under the hard gate, so the
    // in-progress branch below has no subject left — which is itself worth
    // asserting: a future set landing with unimplemented battlefields will drop
    // this number, and that is the signal to expect rather than a failure.
    expect(gated.length, "no battlefield is under a hard gate — COMPLETE_BATTLEFIELD_SETS has lost its subject").toBe(64);
    expect(inProgress, "a set is unexpectedly out of COMPLETE_BATTLEFIELD_SETS").toEqual([]);
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
    //
    // **DERIVED from the source, not a hand-written list.** This used to carry a
    // copy of the six moments that existed when it was written, so adding a
    // seventh (`unitPlayedHere`, for Star Spring and Valley of Idols) turned it
    // red for the one reason it is not meant to catch: a moment that IS fired and
    // was simply missing from the copy. That is the premise-pin failure this repo
    // keeps recording — a list maintained in two places drifts, and the copy in
    // front of you wins.
    //
    // Scanning for the call sites asserts the RELATIONSHIP instead: a moment is
    // legitimate exactly when some file passes it to `holdBattlefieldTrigger`. A
    // new moment that is declared and never fired still fails, which is the whole
    // point; a new moment that is properly wired passes without editing this.
    const fired = firedMoments();
    expect(fired.size, "no firing site was found at all — the scan is measuring nothing").toBeGreaterThan(5);
    for (const [defId, abilities] of Object.entries(BATTLEFIELD_TRIGGERS)) {
      expect(abilities.length, `${defId} has an empty ability list`).toBeGreaterThan(0);
      for (const ability of abilities) {
        expect(
          fired.has(ability.on),
          `${defId} listens for "${ability.on}", which no call to holdBattlefieldTrigger produces`,
        ).toBe(true);
      }
    }
  });
});

/**
 * Every moment string handed to `holdBattlefieldTrigger` anywhere in `src`.
 *
 * A source scan rather than a runtime hook, because the firing sites are spread
 * across `cleanup`, `execute-move-unit`, `execute-recall-unit`,
 * `execute-play-card` and `effect-helpers` — there is no single place to
 * instrument, and a registry of firers would be the same two-copies problem one
 * level up.
 */
function firedMoments(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        for (const m of readFileSync(full, "utf8").matchAll(/holdBattlefieldTrigger\(\s*[^,]+,\s*"([A-Za-z]+)"/g)) {
          found.add(m[1]!);
        }
      }
    }
  };
  walk(fileURLToPath(new URL("../src", import.meta.url)));
  return found;
}
