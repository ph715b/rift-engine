import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **No document may prescribe a verification loop that disagrees with
 * `CLAUDE.md`, unless it says up front that it is superseded.**
 *
 * `CLAUDE.md` records this as a failure that has already happened:
 *
 *   > "Every SFD/battlefield prompt in `docs/` wrote its own copy, they drifted,
 *   > and the copy in front of the session won over the correct one. Handoffs
 *   > link here."
 *
 * It was still happening when this was written. Measured 2026-08-11: **nine docs
 * carried eighteen copies of the loop**, and three of them named `exercised` —
 * which `reachability` REPLACED — while predating `hunt-xp` entirely. A session
 * following one of those would skip the regression pin and the only instrument
 * that can see XP, and would run a probe the canonical loop no longer lists.
 *
 * The rule was in prose and prose does not fail a build. This does.
 *
 * # What it allows
 *
 * A finished doc may keep its historical copy — deleting the record of what a
 * past session actually ran would be worse — as long as its first few lines warn
 * the reader. That is why the escape hatch is a BANNER rather than an allowlist
 * of filenames: a new stale doc is caught, and an old one is fixed by saying so
 * at the top rather than by editing an entry here.
 *
 * # Read from CLAUDE.md, never restated
 *
 * The canonical probe list is parsed out of `CLAUDE.md` itself. A hand-copied
 * expectation here would be the eleventh copy of the very thing this file exists
 * to stop.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCS = join(ROOT, "docs");

/** The `probes/{a,b,c}.ts` brace-list shorthand the loop is written in. */
const PROBE_LIST = /probes\/\{([^}]*)\}/g;

/**
 * What counts as a banner: a markdown BLOCKQUOTE in the opening of the file,
 * containing one of three deliberate markers.
 *
 * **Both halves are load-bearing, and the first version had neither.** It
 * matched a loose alternation anywhere in the opening — including the bare word
 * `done` — and its own synthetic control failed, because the throwaway sentence
 * "Run this when done." contains it. A marker common enough to appear in
 * ordinary prose waves through exactly the documents this exists to catch.
 *
 * So: UPPERCASE markers, and only inside a `>` quote — which is how every banner
 * in `docs/` is actually written, and not something a sentence stumbles into.
 */
const BANNER_MARKER = /SUPERSEDED|DRIFTED COPY|DONE/;
const BANNER_WINDOW = 800;

/** Is the opening of this file bannered? Quote lines only. */
function hasBanner(text: string): boolean {
  const opening = text.slice(0, BANNER_WINDOW);
  // Lines are found with a multiline regex rather than a split, so this function
  // contains no escape sequence at all — two attempts to write it through a shell
  // heredoc turned an escaped newline into a real one, which is a syntax error
  // that reads like a formatting accident.
  return (opening.match(/^[^\n]*$/gm) ?? [])
    .filter((line) => line.trimStart().startsWith(">"))
    .some((line) => BANNER_MARKER.test(line));
}

function probeNames(text: string): string[][] {
  return [...text.matchAll(PROBE_LIST)].map((m) =>
    m[1]!
      .split(",")
      .map((s) => s.trim().replace(/\.ts$/, ""))
      .filter(Boolean)
      .sort(),
  );
}

const canonical = (() => {
  const lists = probeNames(readFileSync(join(ROOT, "CLAUDE.md"), "utf8"));
  return lists[0];
})();

describe("no doc prescribes a stale verification loop", () => {
  it("finds the canonical loop in CLAUDE.md at all", () => {
    // The `tried > 0` rule: without this, a CLAUDE.md that stopped naming its
    // probes would make every assertion below vacuously pass.
    expect(canonical, "CLAUDE.md no longer names a probe list — this whole file is now blind").toBeDefined();
    expect(canonical!.length, "the canonical loop shrank to nothing").toBeGreaterThan(3);
    expect(canonical, "the loop lost reachability or hunt-xp — the two this drift keeps dropping").toEqual(
      expect.arrayContaining(["reachability", "hunt-xp"]),
    );
  });

  it("every docs/*.md loop either matches it or is bannered as historical", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const name of readdirSync(DOCS).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(DOCS, name), "utf8");
      const lists = probeNames(text);
      if (lists.length === 0) continue;
      checked += 1;
      const bannered = hasBanner(text);
      for (const list of lists) {
        const matches = JSON.stringify(list) === JSON.stringify(canonical);
        if (!matches && !bannered) offenders.push(`${name}: ${list.join(",")}`);
      }
    }

    // Positive control on the sweep itself — a check that scanned nothing would
    // report a clean bill of health.
    expect(checked, "no doc names a probe list at all — has the sweep stopped reaching docs/?").toBeGreaterThan(0);
    expect(
      offenders,
      "a doc prescribes a loop that disagrees with CLAUDE.md and does not say it is superseded. " +
        "Either fix the loop or put a banner in its first lines — see this file's header for why.",
    ).toEqual([]);
  });

  it("the detector really would catch a drifted loop — proved on a synthetic doc", () => {
    // The half that rots silently. Everything above passes on a build where
    // `probeNames` matched nothing, so the parser is exercised directly on text
    // that cannot be edited out from under it.
    const stale = "# A handoff\n\nRun `node probes/{ai-health,passive-human,exercised}.ts` when done.\n";
    const parsed = probeNames(stale);

    expect(parsed.length, "the parser stopped recognising the brace-list form").toBe(1);
    expect(parsed[0], "the parser lost a probe name").toEqual(["ai-health", "exercised", "passive-human"]);
    expect(JSON.stringify(parsed[0]) === JSON.stringify(canonical), "a stale list compared EQUAL to the canonical one").toBe(
      false,
    );
    expect(hasBanner(stale), "an unbannered doc read as bannered").toBe(false);

    // And the other direction, on the shape `docs/` actually uses — a detector
    // that answered `false` to everything would pass the line above.
    expect(
      hasBanner("> **SUPERSEDED - SFD is complete.**"),
      "a properly bannered doc read as unbannered",
    ).toBe(true);
    expect(
      hasBanner("A sentence that happens to say the work is done."),
      "prose containing the marker outside a quote counted as a banner",
    ).toBe(false);
  });
});
