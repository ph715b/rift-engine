import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * No source file carries a DOUBLED carriage return.
 *
 * `\r\r\n` is what you get when a script appends a CRLF to a line that already
 * ended in one — the exact mistake CLAUDE.md warns about for PowerShell bulk
 * edits, reached instead through a Python round-trip that joined with `\r\n`
 * inside a file already using it.
 *
 * **It was committed unnoticed** on 2026-08-09: nine lines across `coverage.ts`
 * and `triggers.ts`. Nothing caught it, and nothing would have — the compiler
 * accepts it, every test passed, and `git diff` renders it as an ordinary line.
 * It only surfaced when an exact-match edit kept failing against bytes that
 * looked identical on screen.
 *
 * That is the whole argument for this test: the failure mode is invisible to
 * every other instrument in the repo, and it silently defeats the exact-string
 * edits this codebase relies on.
 */
describe("source files have clean line endings", () => {
  const ROOTS = ["src", "test", "probes"];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx|json|md)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("no file contains a doubled carriage return", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(import.meta.dirname, "..", root))) {
        const raw = readFileSync(file);
        const count = raw.reduce(
          (acc, byte, i) => (byte === 0x0d && raw[i + 1] === 0x0d && raw[i + 2] === 0x0a ? acc + 1 : acc),
          0,
        );
        // `split(sep)` on the platform separator rather than a regex — the path is
        // only being shortened for the failure message.
        if (count > 0) offenders.push(`${file.split(sep).slice(-2).join("/")}: ${count}`);
      }
    }
    expect(offenders, "a write joined CRLF into lines that already had it").toEqual([]);
  });

  it("and the check can actually see one — the positive control", () => {
    // Without this, a broken walk or a wrong byte test would report a clean tree
    // forever. Asserts the detector against a string that definitely has one.
    const sample = Buffer.from("a\r\r\nb\r\nc", "utf8");
    const count = sample.reduce(
      (acc, byte, i) => (byte === 0x0d && sample[i + 1] === 0x0d && sample[i + 2] === 0x0a ? acc + 1 : acc),
      0,
    );
    expect(count, "the detector cannot see a doubled CR at all").toBe(1);
  });
});
