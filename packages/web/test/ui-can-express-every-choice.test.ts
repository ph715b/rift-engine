import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every CHOICE the engine offers a player must be one the board can express.
 *
 * # Why this exists
 *
 * `probes/reachability.ts` measures whether a card can be exercised by the
 * ENGINE — 430 of 468, with the rest enforced. **Relentless Pursuit passed every
 * one of those gates and was unplayable**: `legal-actions` enumerated it
 * correctly, and the UI never asked for its unit, so nothing matched and the card
 * silently did nothing. Charm was the same shape a set earlier. Two shipped
 * cards, both found by a human playing, neither by any gate.
 *
 * This is the missing half. A `PlayCardAction` carries one field per choice the
 * enumerator fanned out. If the UI never reads a field, it cannot let the player
 * make that choice — it takes whichever candidate `find` returns first, silently.
 * That is not always fatal (an arbitrary pick still submits a legal play) but it
 * is never right, and for `targetUnitInstanceId` it WAS fatal.
 *
 * # How it cannot go stale
 *
 * The field list is READ OUT OF `player-action.ts`, not copied here — the
 * technique `coverage-drift.test.ts` uses in the engine, and for the same reason
 * this whole file exists: a hand-copied list of the engine's own shape is exactly
 * what broke Relentless Pursuit. Adding a field to `PlayCardAction` without
 * teaching the UI fails this test by name.
 *
 * Closing a gap means DELETING its entry below. Leaving one in place after the UI
 * learns the field also fails — an allowlist that only ever grows is a list of
 * excuses.
 */

// Resolved from this file's own location. `import.meta.url` is not a file: URL
// under the web package's vitest config, so `fileURLToPath` on it throws — the
// same trap `probes/README.md` records for path resolution.
const HERE = join(process.cwd(), "test");
const WEB_SRC = join(HERE, "..", "src");
const ACTION_SOURCE = join(HERE, "..", "..", "engine", "src", "actions", "player-action.ts");

/** Fields that are not a CHOICE — the action's identity and its payment. The
 *  payment has its own whole UI; the rest are plumbing. */
const NOT_A_CHOICE = new Set(["type", "playerIndex", "card", "payment"]);

/**
 * The choice-bearing fields of `PlayCardAction`, read from the interface itself.
 *
 * Parsed rather than imported because TypeScript types do not survive to
 * runtime — the same constraint `coverage-drift` works around by scanning source.
 */
function choiceFields(): string[] {
  const source = readFileSync(ACTION_SOURCE, "utf8");
  const start = source.indexOf("export interface PlayCardAction");
  expect(start, "PlayCardAction was renamed — this scan is measuring nothing").toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}", start));
  const fields = [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
  return [...new Set(fields)].filter((f) => !NOT_A_CHOICE.has(f));
}

function webSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return webSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Does any file under `packages/web/src` mention this field at all? A
 *  deliberately WEAK test: mentioning a field is the floor, not proof the choice
 *  is offered well. A field nothing mentions is proof it is not offered. */
function fieldsTheUiMentions(): Set<string> {
  const all = webSourceFiles(WEB_SRC).map((f) => readFileSync(f, "utf8")).join("\n");
  return new Set(choiceFields().filter((field) => new RegExp(`\\b${field}\\b`).test(all)));
}

/**
 * Choices the board CANNOT express today, each with what it costs the player.
 *
 * **FOUR left this list on 2026-08-08** — `repeatPaid`, `grantedRepeatPaid`,
 * `optionalPowerPaid` and `exhaustLegendPaid`, about twenty cards including the
 * whole `[Repeat]` keyword. They turned out to be ONE shape — a yes/no
 * additional cost — and took one step; see `src/optional-cost-choices.ts`. The
 * `has no STALE gap` test below is what forced their deletion rather than
 * letting them sit here as excuses.
 *
 * Measured 2026-08-08. Every entry is a real card choice the engine fans out and
 * the UI resolves by taking the first candidate. None of them is fatal the way
 * Relentless Pursuit's was — each still submits a LEGAL play — but each is a
 * decision made for the player without being offered.
 */
const KNOWN_GAPS: Record<string, string> = {
  targetChainCardInstanceId:
    "WHICH spell on the chain to counter — 6 cards (Defy, Wind Wall, Mystic Reversal, Not So Fast, Hard Bargain, Riposte's spell half). With two spells waiting, the target is arbitrary. Recorded in rules-conformance.md since 2026-08-06.",
  modeId:
    "WHICH mode — 2 cards (Angle Shot, Rocket Barrage). Angle Shot's two modes are attach and DETACH, so the arbitrary pick can be the opposite of what the player wanted.",
  repeatChoices: "A [Repeat]'s SECOND set of targets (820.1.d), which the engine accepts and the UI cannot name.",
  discardCardInstanceId: "WHICH card to discard — 2 cards (Brazen Buccaneer, Get Excited!, whose damage IS the discarded card's cost).",
  additionalCostUnitInstanceIds:
    "HOW MANY units to spend on a repeatable cost, and which — 2 cards (Kraken Hunter, Commander Ledros). Ledros KILLS them, so an arbitrary pick is destructive.",
  additionalCostPermanentInstanceId:
    "WHICH friendly gear to spend — 2 cards (Zaun Punk kills one, Legion Quartermaster returns one to hand).",
  targetDiscountAxis:
    "Energy or Power for a target-keyed discount (Irelia - Graceful, Ezreal - Prodigal Explorer). Neither substitutes for the other when a player is short of one.",
  destinationIsBase: "Carried by the action and never read here; the board uses `destinationBattlefieldId` plus a BASE sentinel instead.",
};

describe("the board can express every choice the engine offers", () => {
  it("finds the action's fields at all — the scan itself works", () => {
    // A broken parse would make every assertion below vacuously pass, which is
    // the failure `coverage-drift` names first in the engine.
    const fields = choiceFields();
    expect(fields.length, "no choice fields parsed — the interface shape changed").toBeGreaterThan(10);
    expect(fields).toContain("targetUnitInstanceId");
  });

  it("expresses the fields it claims to", () => {
    // The positive control. `targetUnitInstanceId` is the one Relentless Pursuit
    // died on; if this ever goes false again, the same class of bug is back.
    const mentioned = fieldsTheUiMentions();
    for (const field of ["targetUnitInstanceId", "targetPermanentInstanceId", "xAmount", "destinationBattlefieldId"]) {
      expect(mentioned.has(field), `${field} is no longer read by the UI`).toBe(true);
    }
  });

  it("has no UNDECLARED gap — a new action field must teach the UI or be listed", () => {
    // The gate. Adding a choice to `PlayCardAction` and forgetting the board is
    // precisely how Relentless Pursuit shipped broken; this makes that failure
    // loud and names the field.
    const mentioned = fieldsTheUiMentions();
    const missing = choiceFields().filter((f) => !mentioned.has(f));
    const undeclared = missing.filter((f) => !(f in KNOWN_GAPS));
    expect(undeclared, "the engine offers a choice the board cannot express and nothing says so").toEqual([]);
  });

  it("has no STALE gap — an entry whose field the UI has since learned", () => {
    // The other direction, and the one an allowlist rots in: a list that only
    // grows is a list of excuses. Closing a gap must require deleting its entry.
    const mentioned = fieldsTheUiMentions();
    const stale = Object.keys(KNOWN_GAPS).filter((f) => mentioned.has(f));
    expect(stale, "the UI now reads these — delete their KNOWN_GAPS entries").toEqual([]);
  });

  it("every declared gap names a real field, and says what it costs", () => {
    // A typo'd key would silently excuse nothing while looking like coverage.
    const fields = new Set(choiceFields());
    for (const [field, why] of Object.entries(KNOWN_GAPS)) {
      expect(fields.has(field), `${field} is not a PlayCardAction field`).toBe(true);
      expect(why.length, `${field}'s entry does not say what it costs the player`).toBeGreaterThan(40);
    }
  });
});
