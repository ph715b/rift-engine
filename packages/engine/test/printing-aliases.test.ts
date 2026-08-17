import { describe, expect, it } from "vitest";
import { canonicalDefId, printingAliases } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, implementingModules } from "../src/engine/coverage.js";
import {
  cardPlacesTokens,
  discardChoiceOf,
  optionalUnitCostOf,
  repeatCostsOf,
  targetMustBeElsewhere,
} from "../src/engine/card-effects.js";
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

  it("every alias matches its twin on type, cost and Might", () => {
    // The check that makes deriving-by-name safe. If a print ever diverged, this
    // is what would say so — loudly, and before anything inherited the wrong
    // behaviour.
    //
    // **Unconditional, and it stayed unconditional when the alias rule widened
    // on 2026-08-16.** The printed numbers are the half that no reprint may
    // touch: a rewording is a templating decision, a different Might is a
    // different card. All ten of Vendetta's plain-name reprints match here
    // exactly, which is what made widening the derivation safe at all.
    for (const [alias, canonical] of printingAliases()) {
      const a = registry.get(alias);
      const c = registry.get(canonical);
      expect(a.type, `${alias} is a different card type from ${canonical}`).toBe(c.type);
      // Narrowed per type rather than read off the union: `CardDefinition` is
      // LegendDefinition | UnitDefinition | SpellDefinition | GearDefinition, and
      // only some carry a cost or Might. Twelve of these printings are Legends,
      // which carry neither.
      expect(stats(a), `${alias} and ${canonical} have different stats`).toEqual(stats(c));
    }
  });

  it("...and on rules text, apart from three named cross-set rewordings", () => {
    // **The premise this pin was built on was "every printing is a same-set
    // reprint", and Vendetta broke it.** Until 2026-08-16 the alias rule only
    // reached names carrying `(Overnumbered)`/`(Signature)`/`(Ultimate)`, which
    // are always laid out beside their twin and always print the identical
    // sentence. Vendetta reprints ten earlier cards under a PLAIN name and
    // re-templates three of them — the same card, said in the set's newer words.
    //
    // The repair is to NAME them, not to relax the comparison. Quoting both
    // sides means the assertion still fails on any OTHER divergence, including a
    // future edit to one of these three: the pair drops out of the exception
    // only by matching the text recorded here.
    //
    // Each was read against the twin before being listed, and none changes what
    // the card does:
    //  - VEN-176 / OGN-117 — "play a Recruit token TO your base" / "IN your base".
    //  - VEN-sp4 / OGN-164 — "When you play me or when I conquer" / "When I'm
    //    played and when I conquer". Vendetta's phrasing is the one every other
    //    on-play trigger in the pool uses.
    //  - VEN-sp6 / OGS-014 — "Spend this Energy only to play spells" / "Use only
    //    to play spells". `restrictedSpellEnergy` is that sentence either way.
    //
    // **`OGS-014`'s recorded text contains a MOJIBAKE, and that is deliberate.**
    // Its card data holds `â` where an em-dash belongs — the
    // UTF-8 bytes of `—` decoded as Latin-1 — so `rulesText`'s em-dash strip
    // walks straight past it and the pair reads as different for a reason that
    // has nothing to do with the reprint. Quoting the broken bytes pins the data
    // defect: if upstream ever repairs the character this assertion goes red and
    // whoever hits it deletes the exception, which is the outcome to want.
    const REWORDED: Record<string, { alias: string; twin: string }> = {
      "VEN-176": {
        alias: "Whenyouplayacardonanopponent'sturn,playa1:rb_might:Recruitunittokentoyourbase.",
        twin: "Whenyouplayacardonanopponent'sturn,playa1:rb_might:Recruitunittokeninyourbase.",
      },
      "VEN-sp4": {
        alias: "WhenyouplaymeorwhenIconquer,buffme.Spendmybuff:Giveme+4:rb_might:thisturn.",
        twin: "WhenI'mplayedandwhenIconquer,buffme.Spendmybuff:Giveme+4:rb_might:thisturn.",
      },
      "VEN-sp6": {
        alias: ":rb_exhaust::[Reaction][Add]:rb_energy_2:.SpendthisEnergyonlytoplayspells.",
        twin: ":rb_exhaust::[Reaction]â[Add]:rb_energy_2:.Useonlytoplayspells.",
      },
    };

    let exceptionsSeen = 0;
    for (const [alias, canonical] of printingAliases()) {
      const a = rulesText(registry.get(alias).text);
      const c = rulesText(registry.get(canonical).text);
      const known = REWORDED[alias];
      if (known === undefined) {
        expect(a, `${alias} and ${canonical} print different rules`).toBe(c);
        continue;
      }
      exceptionsSeen += 1;
      expect(a, `${alias}'s text is no longer the rewording recorded here`).toBe(known.alias);
      expect(c, `${canonical}'s text is no longer the rewording recorded here`).toBe(known.twin);
    }
    // The "tried > 0" rule. An exception list that stopped matching anything
    // would leave three pairs unchecked in silence.
    expect(exceptionsSeen, "no reworded pair was reached — the exception list is dead").toBe(
      Object.keys(REWORDED).length,
    );
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

describe("the COST tables keyed by defId reach a printing too", () => {
  it("no printing disagrees with its twin about any defId-keyed cost table", () => {
    // **The class `mergeRegistries` cannot reach, asserted as a partition.**
    // Those five tables in `card-effects.ts` are plain `Record`s looked up by raw
    // defId with no `canonicalDefId` — the same shape as the literal comparisons
    // this file's header describes, one level up. A printing of a card with a
    // `[Repeat]` cost or an optional discard would be enumerated as if it printed
    // neither, which is a silently CHEAPER card rather than an inert one.
    //
    // Measured 2026-08-16, after the alias rule widened to Vendetta's ten
    // plain-name reprints: nothing disagrees today, so this is a guard rather
    // than a bug report. Asserted as an invariant over every alias rather than
    // as a list, so the day a reprint lands in one of these tables it fails here
    // instead of in a playtest.
    const probes: Record<string, (defId: string) => unknown> = {
      "discard choice": (id) => discardChoiceOf(id) !== undefined,
      "[Repeat] costs": (id) => repeatCostsOf(id).length,
      "optional unit cost": (id) => optionalUnitCostOf(id) !== undefined,
      "token placement": (id) => cardPlacesTokens(id),
      "target must be elsewhere": (id) => targetMustBeElsewhere(id),
    };

    let checked = 0;
    for (const [alias, canonical] of printingAliases()) {
      for (const [label, probe] of Object.entries(probes)) {
        expect(probe(alias), `${alias} disagrees with ${canonical} about its ${label}`).toEqual(probe(canonical));
      }
      checked += 1;
    }
    // The "tried > 0" rule: an empty alias map would pass this in silence.
    expect(checked, "no printing pairs were checked at all — this test is blind").toBeGreaterThan(0);
  });

  it("...and the probes are not all vacuously false", () => {
    // The control on the test above. Every probe answers `false`/`0` for most of
    // the pool, so a probe pointed at a table that no longer exists would agree
    // with itself everywhere and prove nothing. Each is shown finding a real row.
    expect(discardChoiceOf("OGN-002"), "the discard table is empty or renamed").toBeDefined();
    expect(repeatCostsOf("UNL-017").length, "the [Repeat] table is empty or renamed").toBeGreaterThan(0);
    expect(optionalUnitCostOf("OGN-048"), "the optional-unit-cost table is empty or renamed").toBeDefined();
    expect(cardPlacesTokens("OGN-094"), "the token-placement set is empty or renamed").toBe(true);
    expect(targetMustBeElsewhere("OGN-199"), "the elsewhere set is empty or renamed").toBe(true);
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

  it("...and so do Vendetta's TEN plain-name reprints", () => {
    // **The second batch of inert printings, found 2026-08-16**, and the reason
    // they were invisible for a set and a half: `printingAliases` only aliased a
    // name carrying `(Overnumbered)`/`(Signature)`/`(Ultimate)`. Unleashed marks
    // every reprint that way and Vendetta marks none of these, so all ten had an
    // implemented twin and no implementation of their own — `VEN-167 Vi,
    // Destructive` had no ability at all while `OGN-036 Vi - Destructive` worked.
    //
    // NAMED rather than counted, for the reason the twelve above are: a count
    // cannot tell "the derivation reaches them" from "somebody wrote them by
    // hand". Every one of these is implemented ONLY through its twin — nothing in
    // `src/` mentions these ids — so this fails the moment the suffix filter
    // comes back, which is what a control on that change looks like.
    const PLAIN_NAME_REPRINTS = [
      "VEN-167", // Vi, Destructive        <- OGN-036
      "VEN-175", // Jayce, Man of Progress <- SFD-084
      "VEN-176", // Viktor, Innovator      <- OGN-117
      "VEN-179", // Rengar, Trophy Hunter  <- UNL-120
      "VEN-180", // Kha'Zix, Evolving Hunter <- UNL-119
      "VEN-sp2", // Sona, Harmonious       <- OGN-073
      "VEN-sp3", // Ahri, Inquisitive      <- OGN-119
      "VEN-sp4", // Sett, Brawler          <- OGN-164
      "VEN-sp5", // Ezreal, Prodigy        <- SFD-149
      "VEN-sp6", // Lux, Crownguard        <- OGS-014
    ];
    for (const id of PLAIN_NAME_REPRINTS) {
      expect(canonicalDefId(id), `${id} is not aliased to a twin at all`).not.toBe(id);
      expect(implementingModules(id), `${id} is still inert`).not.toEqual([]);
      expect(isCardImplemented(registry.get(id)), `${id} still reports unimplemented`).toBe(true);
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
