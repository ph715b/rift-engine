import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const EFFECTS_DIR = join(import.meta.dirname, "..", "src", "engine", "effects");
import { createRecruitToken, BIRD_TOKEN } from "../src/engine/token.js";

describe("createRecruitToken", () => {
  it("builds a well-formed 1-Might token, never touching the card registry", () => {
    const token = createRecruitToken();
    expect(token.isToken).toBe(true);
    expect(token.kind).toBe("Unit");
    expect(token.might).toBe(1);
    expect(token.energyCost).toBe(0);
    expect(token.powerCost).toBe(0);
    expect(token.name).toBe("Recruit");
    expect(token.exhausted).toBe(true); // no card in scope grants "tokens enter ready"
  });

  it("gives every token a distinct instanceId", () => {
    const a = createRecruitToken();
    const b = createRecruitToken();
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});

/**
 * A token spec that more than one card mints lives in `token.ts`, ONCE.
 *
 * **This drift has now happened twice.** `SAND_SOLDIER_TOKEN` was two private
 * copies, one commented as "a local copy of effects/order.ts's private spec" —
 * naming a file that never held it. On 2026-08-09 `BIRD_TOKEN` was found as
 * THREE byte-identical declarations in calm/chaos/order, written independently by
 * three agents in one wave.
 *
 * None of those agents was wrong. The fan-out rule keeps each of them out of the
 * shared file, so a local copy is the only thing any of them CAN write — which
 * means this cannot be prevented by instruction and has to be caught here
 * instead, at integration.
 *
 * The Bird's `[Deflect 1]` is why it matters beyond tidiness: a copy that lost it
 * makes a Bird an opponent can choose for free, and nothing looks wrong until
 * someone tries to tax it.
 */
describe("shared token specs are not copied back into the domain files", () => {
  it("no domain file declares its own BIRD_TOKEN or SAND_SOLDIER_TOKEN", () => {
    const shared = ["BIRD_TOKEN", "SAND_SOLDIER_TOKEN", "GOLD_TOKEN", "RECRUIT_TOKEN"];
    const offenders: string[] = [];
    for (const file of readdirSync(EFFECTS_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(EFFECTS_DIR, file), "utf8");
      for (const name of shared) {
        // A `const X: TokenSpec =` declaration, not a mention or an import.
        //
        // **A plain string, not a template literal, and that is the whole story.**
        // The first version built the pattern as `` `const\s+${name}\s*:` ``, and a
        // template literal resolves `\s` to a bare `s` BEFORE `RegExp` sees it. The
        // pattern compiled to `consts+BIRD_TOKENs*:` and matched nothing, ever — so
        // the test passed on a tree that HAD three copies and on one that did not.
        //
        // Caught only by re-introducing a local copy and watching the test stay
        // green. A mutation that does not fail has proved nothing, and this one
        // did not fail twice: once for the missing escape, once because the fix
        // was applied through another layer of escaping that ate it again.
        const declaration = new RegExp("const\\s+" + name + "\\s*:");
        if (declaration.test(source)) offenders.push(`${file}:${name}`);
      }
    }
    expect(offenders, "these are declared locally instead of imported from token.ts").toEqual([]);
  });

  it("and the Bird really does carry [Deflect 1] — the half a copy loses", () => {
    // The positive control. A test that only forbade local copies would pass just
    // as well if the shared spec itself were wrong.
    expect(BIRD_TOKEN.keywords).toEqual({ Deflect: 1 });
    expect(BIRD_TOKEN.might).toBe(1);
    expect(BIRD_TOKEN.tag).toBe("Bird");
  });
});
