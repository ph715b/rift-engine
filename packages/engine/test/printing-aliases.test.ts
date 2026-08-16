import { describe, expect, it } from "vitest";
import { canonicalDefId, printingAliases } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, implementingModules } from "../src/engine/coverage.js";
import { eventTriggerDefIds } from "../src/engine/triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { answerDecisions, resolveHeldTriggers } from "./fixtures.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * **Alternate printings, and the twelve cards that were inert because of them.**
 *
 * Unleashed prints every Legend three times — a plain print, an
 * `(Overnumbered)` one and a `(Signature)` one whose collector number carries an
 * asterisk, so `deriveId` yields ids like `UNL-231*` — and it reprints five
 * Poros from earlier sets. All 31 are DISTINCT ids, which is correct: a deck
 * list names a printing, and the art differs.
 *
 * But they are the same CARD, and every registry in this engine is keyed by
 * defId. So a deck holding the Signature print of Rengar - Pridestalker had a
 * Legend with no ability at all. Measured before the fix: **12 of the 31
 * printings had an implemented twin and no implementation of their own**, and
 * nothing in the engine could see it — coverage reported them unimplemented,
 * which reads as "not written yet" rather than "silently broken".
 *
 * # The fix, and why it is in two places rather than one
 *
 * `mergeRegistries` aliases the effect registries centrally, which covers every
 * card whose implementation is an entry keyed by defId. That is most of them.
 *
 * It cannot cover a defId compared to a LITERAL — Master Yi's Legend check is
 * `player.legend.defId === "UNL-191"`, and no merge reaches an `if`. Those sites
 * go through `canonicalDefId` individually, and there are few: measured, only
 * ten of the 78 literal defId comparisons in `src/` name a card that has an
 * alternate printing at all.
 *
 * # Why the alias table is DERIVED
 *
 * A hand-written list is one more thing to forget, and this pool has produced
 * four wrong hand-maintained lists already. The base name is the identity — and
 * the derivation is checked below rather than trusted: every alias must match
 * its twin on rules text, type, cost and Might. A printing that genuinely
 * differed would fail here rather than silently inherit the wrong behaviour.
 */

const registry = defaultCardRegistry();
const PRINTING_SUFFIX = /\s*\((Overnumbered|Signature|Ultimate)\)\s*$/;

/** Printed text with REMINDER text removed. Reminders are the only thing that
 *  differs between printings — `(While you have 6+ XP, get the effect.)` is on
 *  the plain print of Master Yi and not on the Overnumbered one — so comparing
 *  raw text would report 14 false differences. */
const rulesText = (t: string | undefined): string =>
  (t ?? "")
    .replace(/\([^()]*\)/g, "")
    // `[Deathknell][>]` and `[Deathknell] —` are the same marker printed two
    // ways across sets; the Poro reprints use one and their twins the other.
    .replace(/\s*—\s*/g, "")
    .replace(/\[>\]/g, "")
    .replace(/\s+/g, "")
    .trim();


/** The printed numbers a card actually has, by type — a Legend has none, a Unit
 *  has all three. Compared as an object so a type change shows up as a shape
 *  change rather than as three separate undefineds matching by accident. */
function stats(def: ReturnType<typeof registry.get>): Record<string, number | undefined> {
  if (def.type === "Unit") return { energyCost: def.energyCost, powerCost: def.powerCost, might: def.might };
  if (def.type === "Spell") return { energyCost: def.energyCost };
  return {};
}

describe("the alias table is derived, and the derivation is sound", () => {
  it("finds every alternate printing in the pool", () => {
    // 31 from UNL's Legends and Poro reprints, plus **12 from VEN**
    // (2026-08-16) — its `(Overnumbered)` Legend prints. Vendetta's are the
    // RECONCILED ones only: its card file drops the printings upstream has not
    // yet flagged, so this number RISES when that reconciliation completes. See
    // `card-loader`'s CARD_FILES note.
    const printed = registry.all().filter((d) => PRINTING_SUFFIX.test(d.name));
    expect(printed.length, "the sweep found a different number — the pattern drifted").toBe(43);
    // Every one of them is aliased: a printing with no plain twin would be left
    // out, and that would be a data problem worth failing on.
    for (const d of printed) {
      expect(printingAliases().has(d.id), `${d.id} ${d.name} has no canonical twin`).toBe(true);
    }
  });

  it("every alias matches its twin on rules text, type, cost and Might", () => {
    // The check that makes deriving-by-name safe. If a print ever diverged, this
    // is what would say so — loudly, and before anything inherited the wrong
    // behaviour.
    for (const [alias, canonical] of printingAliases()) {
      const a = registry.get(alias);
      const c = registry.get(canonical);
      expect(rulesText(a.text), `${alias} and ${canonical} print different rules`).toBe(rulesText(c.text));
      expect(a.type, `${alias} is a different card type from ${canonical}`).toBe(c.type);
      // Narrowed per type rather than read off the union: `CardDefinition` is
      // LegendDefinition | UnitDefinition | SpellDefinition | GearDefinition, and
      // only some carry a cost or Might. Twelve of these printings are Legends,
      // which carry neither.
      expect(stats(a), `${alias} and ${canonical} have different stats`).toEqual(stats(c));
    }
  });

  it("a plain print is its own canonical id", () => {
    expect(canonicalDefId("UNL-191")).toBe("UNL-191");
    expect(canonicalDefId("OGN-013")).toBe("OGN-013");
  });

  it("...and an alternate print resolves to the plain one", () => {
    expect(canonicalDefId("UNL-231")).toBe("UNL-191");
    expect(canonicalDefId("UNL-231*")).toBe("UNL-191");
  });
});

describe("an alternate printing actually WORKS in a game", () => {
  // The assertions that matter. Everything above is bookkeeping; these are the
  // twelve cards that did nothing.

  it("a Signature-print Rengar PUMPS a unit in a real game", () => {
    // End-to-end rather than a registry lookup, because the registry is only
    // half the claim: Rengar's ability is reached by a listener walk over
    // `listeningPermanents`, which ends at the LEGEND and looks it up by defId.
    // Before the alias, a Signature-print Rengar was walked past in silence.
    const state: GameState = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: "UNL-227*" };
    const poro = realUnitInstance("OGN-052");
    state.players[0]!.hand = [poro];
    state.players[0]!.floatingEnergy = 6;

    const play = legalActions(state).find((a) => a.type === "PlayCard");
    expect(play, "the unit was not playable — the fixture measures nothing").toBeDefined();
    const { state: played, result } = submit(state, play!);
    expect(result).toMatchObject({ type: "Ok" });
    const settled = answerDecisions(resolveHeldTriggers(played));

    const landed = [
      ...settled.players[0]!.baseUnits,
      ...settled.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
    ].find((u) => u.instanceId === poro.instanceId);
    expect(landed?.mightThisTurn, "the Signature print's trigger never fired").toBe(1);
  });

  it("...and both prints are in the merged event-trigger table", () => {
    // The registry half, kept beside the game-level one: `allEventTriggers`
    // merges through `mergeRegistries`, which is where the alias is expanded.
    const ids = eventTriggerDefIds();
    expect(ids, "the canonical Rengar lost his trigger").toContain("UNL-183");
    expect(ids, "the Signature print has no trigger").toContain("UNL-227*");
    expect(ids, "the Overnumbered print has no trigger").toContain("UNL-227");
  });

  it("an Overnumbered Master Yi readies your units at [Level 11]", () => {
    // The case a registry alias CANNOT fix: his enters-ready clause is a literal
    // comparison in `deploy.ts`, so this passes only because that site was routed
    // through `canonicalDefId`.
    const state: GameState = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.xp = 11;
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: "UNL-231" };

    expect(
      unitEntersReady(state, 0, realUnitInstance("OGN-002")),
      "an Overnumbered Master Yi does not ready your units — the literal comparison is unaliased",
    ).toBe(true);
  });

  it("...and the plain print still does, and a non-Yi Legend still does not", () => {
    // Both controls on the same fixture: the alias must not have replaced the
    // canonical answer, and must not have made the check vacuous.
    const yi: GameState = makeState({ phase: "Action", activePlayerIndex: 0 });
    yi.players[0]!.xp = 11;
    yi.players[0]!.legend = { ...yi.players[0]!.legend, defId: "UNL-191" };
    expect(unitEntersReady(yi, 0, realUnitInstance("OGN-002"))).toBe(true);

    const other: GameState = makeState({ phase: "Action", activePlayerIndex: 0 });
    other.players[0]!.xp = 20;
    other.players[0]!.legend = { ...other.players[0]!.legend, defId: "OGN-001" };
    expect(unitEntersReady(other, 0, realUnitInstance("OGN-002")), "any Legend now readies units").toBe(false);
  });
});

describe("coverage reports a printing exactly as it reports its twin", () => {
  it("no printing disagrees with its canonical print", () => {
    // The invariant, asserted as a PARTITION rather than as a count, so it
    // cannot go stale as cards are written: whatever the answer is for the card,
    // it is the answer for every print of it.
    for (const [alias, canonical] of printingAliases()) {
      expect(
        isCardImplemented(registry.get(alias)),
        `${alias} disagrees with ${canonical} about being implemented`,
      ).toBe(isCardImplemented(registry.get(canonical)));
    }
  });

  it("and the twelve that were inert now report implemented", () => {
    // Named rather than counted, because a count cannot tell "the alias works"
    // from "somebody implemented one by hand".
    for (const id of ["UNL-221", "UNL-222", "UNL-227", "UNL-227*", "UNL-228", "UNL-228*", "UNL-229", "UNL-229*", "UNL-230", "UNL-230*", "UNL-231", "UNL-231*"]) {
      expect(implementingModules(id), `${id} is still inert`).not.toEqual([]);
    }
  });

  it("every printing reports EXACTLY what its canonical twin reports", () => {
    // **Rewritten 2026-08-12, after flipping.** This was a negative control
    // naming Baron Nashor (UNL-147) as "deliberately unwritten" so its (Ultimate)
    // print must report nothing. Wave 7 gave Baron his +2 Might aura, the twin
    // started reporting `["effective-might"]`, and the control failed — correctly,
    // but for a reason that had nothing to do with aliasing.
    //
    // The premise was the problem: it pinned one card's implementation status to
    // make a point about a MECHANISM. Restated as the invariant the alias
    // actually owes — a printing claims neither more nor less than its twin —
    // which holds however many of them get written, and catches over-claiming in
    // both directions rather than only the one.
    let checked = 0;
    for (const [alias, canonical] of printingAliases()) {
      expect(implementingModules(alias), `${alias} disagrees with its twin ${canonical}`).toEqual(
        implementingModules(canonical),
      );
      checked += 1;
    }
    // The "tried > 0" rule: a run that enumerated no pairs would pass silently.
    expect(checked, "no printing pairs were checked at all — this test is blind").toBeGreaterThan(0);
  });
});
