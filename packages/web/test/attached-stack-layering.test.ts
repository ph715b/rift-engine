import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **A z-index inside `.attached-stack` must stay inside it.**
 *
 * This pins one regression and the coupling that caused it.
 *
 * The Equipment fan gives each attached card `z-index: 10, 9, 8...` so the first
 * piece paints over the second — that is the fix for the playtest report
 * "multiple equipment only show as 1 underneath the unit", and it is correct.
 *
 * But `.attached-stack` was `z-index: auto`, which is **not** a stacking context.
 * Those values therefore escaped into the card's context and outranked every
 * absolutely-positioned sibling painted later in the DOM: `.card-art`, the
 * `.might-overlay`, `.card-status-badges`. The next playtest report was the
 * consequence — "equipment is appearing above the unit it is equipped to
 * blocking me from seeing the updated might" — one cause, two symptoms, and the
 * second fix arrived in the same change as the first.
 *
 * # Why this is asserted on the stylesheet text
 *
 * jsdom computes no layout and resolves no stacking order, so a rendering test
 * of this in the existing suite would assert that the elements EXIST — which
 * they did throughout the bug. Reading the rule is weaker than reading a screen,
 * but it is honest about what it checks, and it fails on the exact edit that
 * would bring the bug back: removing the isolation while keeping the fan.
 */

/** This workspace's tests run under jsdom, where `import.meta.url` is an http
 *  URL and `fileURLToPath` throws — so the stylesheet is found from the working
 *  directory, which is `packages/web` when run directly and the repo root when
 *  run from the root `npm test`. Both are tried; neither is assumed. */
const CSS = (() => {
  const candidates = ["src/styles.css", "packages/web/src/styles.css"].map((p) => resolve(process.cwd(), p));
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error(`styles.css not found from ${process.cwd()} — tried ${candidates.join(", ")}`);
  return readFileSync(found, "utf8");
})();

/** The body of a single top-level rule, by selector. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} is gone from styles.css — this test is now blind`).toBeGreaterThan(-1);
  const end = CSS.indexOf("}", at);
  return CSS.slice(at, end);
}

describe("the attached-Equipment fan cannot escape its stack", () => {
  it("the fan really does set a z-index — the premise", () => {
    // Without this the assertion below is satisfied by a stylesheet that simply
    // stopped fanning, which would be the OTHER bug silently returning.
    expect(ruleBody(".attached-card"), "the descending fan z-index is gone — two Equipment will read as one").toMatch(
      /z-index:\s*calc\(10\s*-\s*var\(--fan\)\)/,
    );
  });

  it("...and the stack contains it", () => {
    expect(
      ruleBody(".attached-stack"),
      "`.attached-stack` no longer forms a stacking context, so the fan's z-index will outrank the card art and the Might overlay again",
    ).toMatch(/isolation:\s*isolate/);
  });

  it("the Might overlay and the status badges outrank the art in their own right", () => {
    // Belt and braces, deliberately: these two exist to contradict what the art
    // prints, so they should not depend on a sibling container behaving. The
    // isolation above is what fixed the reported bug; this is what stops the
    // next element that grows a z-index from re-creating it.
    for (const selector of [".might-overlay", ".card-status-badges"]) {
      expect(ruleBody(selector), `${selector} lost its explicit z-index and can be covered again`).toMatch(
        /z-index:\s*[1-9]/,
      );
    }
  });
});
