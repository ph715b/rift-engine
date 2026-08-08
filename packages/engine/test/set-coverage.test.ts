import { describe, expect, it } from "vitest";
import { COMPLETE_SETS, coverageBySet, setCodeOf, setProgressLine } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { CardDefinition } from "../src/model/card-definition.js";

const registry = defaultCardRegistry();

/**
 * The completeness gates are per SET, and this file is what makes that claim
 * checkable.
 *
 * Two tests assert that every card in the pool is implemented — one in
 * effect-registry.test.ts, one in coverage-drift.test.ts. Both were correct
 * while the pool was OGN+OGS and finished, and both would have turned red the
 * day a new set's JSON landed, staying red for the weeks it took to implement
 * it. A gate that is expected to be red says nothing when it is.
 *
 * Scoping them to `COMPLETE_SETS` fixes that and introduces a second failure
 * mode: a set finished and never promoted, silently unguarded forever. Both
 * directions are pinned here, and both are proved on input rather than on hope
 * — the "set under construction" case has no real subject yet, so it is
 * exercised with a synthetic definition and with the real pool under a
 * deliberately wrong `completeSets` argument.
 */
describe("per-set completeness gating", () => {
  /** A card shape with real rules text and a defId no registry claims, in a set
   *  that does not exist. It cannot be implemented out from under this file —
   *  the same reason effect-registry.test.ts's "unimplemented card" subject is
   *  synthetic.
   *
   *  **It used to be `SFD-001`, and that stopped being a set that does not
   *  exist on 2026-08-04**, when Spiritforged's JSON landed and SFD-001 became
   *  a real card (Against the Odds). The synthetic subject has to belong to a
   *  set the registry genuinely cannot hold, or "the pool plus one unwritten
   *  card" quietly becomes "the pool plus 206 unwritten cards" and the tests
   *  below measure something else. `ZZZ` is not a Riftbound set code and is not
   *  one of the four the oracle ships (OGN/OGS/SFD/UNL). */
  const unwrittenCard: CardDefinition = {
    ...registry.get("OGN-024"),
    id: "ZZZ-001",
    name: "Unwritten Card In No Set",
    text: "Deal 4 to a unit at a battlefield. Draw 1.",
  };

  it("reads the set off the defId, for a set it has never seen", () => {
    // deriveId already turns "sfd-001-298" into "SFD-001" with no change, so
    // ids are set-agnostic and this needs no table.
    expect(setCodeOf("OGN-001")).toBe("OGN");
    expect(setCodeOf("SFD-001")).toBe("SFD");
    // Degenerate input must not silently become a set of its own shape.
    expect(setCodeOf("TOKEN-RECRUIT")).toBe("TOKEN");
  });

  it("NAMES the unimplemented cards of a set declared complete", () => {
    // The half worth keeping from the old whole-pool gate. If SFD were declared
    // complete with this card unwritten, the gate says which card — not a count,
    // not a percentage.
    const [sfd] = coverageBySet([unwrittenCard], ["ZZZ"]);
    expect(sfd!.declaredComplete).toBe(true);
    expect(sfd!.unimplemented).toEqual(["ZZZ-001 (Unwritten Card In No Set)"]);
    expect(sfd!.finishedButUndeclared).toBe(false);
  });

  it("reports the same set as PROGRESS while it is under construction", () => {
    // The same card, the same answer about it, and no failure — this is what
    // lands the day SFD's JSON arrives and nothing else has happened yet.
    const [sfd] = coverageBySet([unwrittenCard], []);
    expect(sfd!.declaredComplete).toBe(false);
    expect(sfd!.implemented).toBe(0);
    expect(sfd!.needing).toBe(1);
    expect(setProgressLine(sfd!)).toBe("ZZZ: 0/1 implemented — left: ZZZ-001 (Unwritten Card In No Set)");
  });

  it("does not silently truncate the list of what is left", () => {
    // A capped list that does not say it was capped reads as "that is all of
    // them", which is the same lie as a bare count.
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...unwrittenCard,
      id: `ZZZ-${String(i + 1).padStart(3, "0")}`,
      name: `Card ${i + 1}`,
    }));
    const line = setProgressLine(coverageBySet(many, [])[0]!);
    expect(line).toContain("0/8 implemented");
    expect(line).toContain("and 3 more");
  });

  it("scopes per set rather than over the pool — a finished set is unaffected by an unfinished one", () => {
    // The property the whole change is for: OGN and OGS keep their hard gate
    // while an unfinished set sits beside them. As of 2026-08-04 this is no
    // longer hypothetical — SFD is that set, and the synthetic ZZZ card is kept
    // alongside it so the property is still proved on a subject nobody can
    // implement out from under this file.
    const coverage = coverageBySet([...registry.all(), unwrittenCard]);
    const ogn = coverage.find((c) => c.set === "OGN")!;
    const ogs = coverage.find((c) => c.set === "OGS")!;
    const zzz = coverage.find((c) => c.set === "ZZZ")!;
    const sfd = coverage.find((c) => c.set === "SFD")!;
    expect(ogn.declaredComplete).toBe(true);
    expect(ogn.unimplemented).toEqual([]);
    expect(ogs.declaredComplete).toBe(true);
    expect(ogs.unimplemented).toEqual([]);
    expect(zzz.declaredComplete).toBe(false);
    expect(zzz.unimplemented).toEqual(["ZZZ-001 (Unwritten Card In No Set)"]);
    // **SFD finished on 2026-08-07 and is declared**, so it is no longer the
    // in-progress subject — `ZZZ` above is, and it is synthetic precisely so this
    // scoping can be proved with no unfinished real set to borrow. The two halves
    // that still matter for SFD are kept: it is declared, and it is not empty —
    // if `needing` ever reads 0 the JSON stopped loading and every other SFD test
    // in the suite would be vacuously green.
    expect(sfd.declaredComplete).toBe(true);
    expect(sfd.unimplemented).toEqual([]);
    expect(sfd.needing).toBeGreaterThan(0);
  });

  it("flags a set that is FINISHED but still undeclared", () => {
    // The second failure mode this scoping introduces: a set completed and never
    // promoted to COMPLETE_SETS is unguarded forever, and nothing about the day
    // it finishes would say so.
    //
    // Proved against the REAL pool with a deliberately wrong argument, which is
    // exactly the mistake being caught: OGN and OGS are finished, so undeclaring
    // them must raise the flag on both.
    //
    // **All three real sets are finished as of 2026-08-07**, so undeclaring them
    // must raise the flag on all three. The real negative case SFD used to
    // provide is gone with it — the synthetic one below is what carries that half
    // now, and it always could: `coverageBySet` takes its complete-set list as an
    // ARGUMENT precisely so neither direction depends on a real set happening to
    // be in the right state.
    const undeclared = coverageBySet(registry.all(), []);
    expect(undeclared.map((c) => c.set)).toEqual(["OGN", "OGS", "SFD"]);
    expect(undeclared.filter((c) => c.finishedButUndeclared).map((c) => c.set)).toEqual(["OGN", "OGS", "SFD"]);
    // And declaring only one leaves the flag on the other, so the check is per
    // set rather than an all-or-nothing.
    const half = coverageBySet(registry.all(), ["OGN"]);
    expect(half.find((c) => c.set === "OGN")!.finishedButUndeclared).toBe(false);
    expect(half.find((c) => c.set === "OGS")!.finishedButUndeclared).toBe(true);
  });

  it("an unfinished set is NOT flagged as undeclared-but-finished", () => {
    // The flag must not fire for a set that simply has not been written yet, or
    // it is noise from the day the JSON lands until the day the set is done.
    const [sfd] = coverageBySet([unwrittenCard], []);
    expect(sfd!.finishedButUndeclared).toBe(false);
  });
});

/**
 * The state of the real pool, stated per set. This is the "270/270" figure that
 * drove the last stretch, in the form that survives a second set arriving.
 */
describe("the pool, per set", () => {
  const coverage = coverageBySet(registry.all());
  /** Cards carrying rules text that needs implementing, per set — 288 loaded
   *  definitions, of which these need an implementation at all. */
  const OGN_CARDS = 248;
  const OGS_CARDS = 22;

  it("every set is either declared complete or reported as in progress", () => {
    // A set is never both, and never neither. `finishedButUndeclared` is what
    // makes "neither" impossible to sit in once the set is done.
    const inProgress = coverage.filter((c) => !c.declaredComplete);
    for (const set of inProgress) console.log(`in progress — ${setProgressLine(set)}`);
    expect(
      inProgress.filter((c) => c.finishedButUndeclared).map((c) => c.set),
      "this set is finished — add it to COMPLETE_SETS so its gate starts protecting it",
    ).toEqual([]);
  });

  it("every declared-complete set actually exists in the pool and gates something", () => {
    // A name in COMPLETE_SETS matching no cards gates nothing while reading
    // exactly like a pass — the 0/0 shape that has produced a green report
    // about an empty measurement before.
    for (const set of COMPLETE_SETS) {
      const found = coverage.find((c) => c.set === set);
      expect(found, `${set} is in COMPLETE_SETS but no card in the pool belongs to it`).toBeDefined();
      expect(found!.needing, `${set} gates 0 cards, which reads exactly like a pass`).toBeGreaterThan(0);
    }
  });

  it("OGN and OGS are complete, and the split is stated rather than implied", () => {
    // 270 of 270, and now split per set. Written down because the split is new
    // information: the pool total alone cannot tell you one set regressed while
    // the other grew.
    const ogn = coverage.find((c) => c.set === "OGN")!;
    const ogs = coverage.find((c) => c.set === "OGS")!;
    expect([ogn.implemented, ogn.needing]).toEqual([OGN_CARDS, OGN_CARDS]);
    expect([ogs.implemented, ogs.needing]).toEqual([OGS_CARDS, OGS_CARDS]);
    expect(OGN_CARDS + OGS_CARDS).toBe(270);
  });
});
