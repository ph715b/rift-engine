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
 * **FIVE left this list on 2026-08-08** — `modeId` went with the four below,
 * once modal cards could be told apart at all.
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
  repeatChoices: "A [Repeat]'s SECOND set of targets (820.1.d), which the engine accepts and the UI cannot name.",
  discardCardInstanceId: "WHICH card to discard — 2 cards (Brazen Buccaneer, Get Excited!, whose damage IS the discarded card's cost).",
  additionalCostUnitInstanceIds:
    "HOW MANY units to spend on a repeatable cost, and which — 2 cards (Kraken Hunter, Commander Ledros). Ledros KILLS them, so an arbitrary pick is destructive.",
  additionalCostPermanentInstanceId:
    "WHICH friendly gear to spend — 2 cards (Zaun Punk kills one, Legion Quartermaster returns one to hand).",
  destinationIsBase: "Carried by the action and never read here; the board uses `destinationBattlefieldId` plus a BASE sentinel instead.",
  // **Six gaps this instrument found the day it arrived on this branch, all of
  // them opened while it was absent.** It was written on master on 2026-08-08;
  // this branch forked the same day and only merged it back on 2026-08-26, and
  // every field below was added to `PlayCardAction` during Unleashed or Vendetta
  // in between. That is exactly the window the test exists to close, and the
  // list is dated rather than quietly absorbed so the cost of the gap is legible.
  //
  // Declared, NOT excused: each is a legal play a human cannot currently choose,
  // which is the fidelity bar this project holds itself to. Closing one means
  // deleting its line here.
  repeatDiscardCardInstanceId:
    "WHICH card to discard to buy a second [Repeat] execution. Distinct from `discardCardInstanceId`, which is a discount a card BUYS with a discard — a play can owe both.",
  replacedCostPaid:
    "Whether to use a card's \"you may play me for [Cost]\" price instead of its printed one (356.1.a). The cheaper line is simply never offered.",
  optionalXpPaid:
    "Whether to spend N XP as an additional cost (204.2) — Conscription and Safety Inspector. XP is not a Game Object (731), so nothing else on the action reveals the choice.",
  dragonRoostPaid:
    "Dragon Roost (VEN-157): pay [2 rainbow] to play a Dragon TO the Roost. The only optional cost here that buys a PLACEMENT rather than an effect, so the lost choice is where the unit lands.",
  exhaustLegendPaid:
    "Bard - Mercurial (SFD-079): exhaust your Legend as an additional cost. Master's UI expressed this and this branch's rewrite did not carry it across — the one entry here that is a REGRESSION rather than a never-built.",
  repeatExecutions:
    "The per-instance choices for a multi-[Repeat] play (820.1.c.2 — each cost paid or not paid individually). The board can pay a Repeat but cannot vary what each execution does.",
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

/**
 * Every step the board can ENTER must be one the player can answer.
 *
 * # Why this exists
 *
 * Added 2026-08-08, immediately after shipping a step that could not be answered.
 * The `optionalCost` step went in with its prompt and its buttons in the same
 * edit — and that edit threw on its last line, so the file was never written and
 * only a later, smaller edit landed. The step existed, `pendingStep` returned it,
 * and the board rendered no prompt and no controls. **The suite was green, the
 * typecheck was clean, and the card would simply have hung.**
 *
 * That is the same failure shape as the twelve gaps above, one level down: not a
 * choice the board cannot express, but a QUESTION the board cannot answer.
 *
 * # What it asserts
 *
 * Every member of the `PendingStep` union has a prompt case, and every step not
 * answered by clicking the board has a control keyed to it. Both lists are read
 * out of the component's own source, so a new step fails here by name rather than
 * hanging in play.
 */
const BOARD_SOURCE = join(HERE, "..", "src", "components", "GameBoard.tsx");

/** Steps answered by clicking a CARD or a BATTLEFIELD rather than a button —
 *  they need a prompt but no control of their own. Declared, because the source
 *  cannot say which; the test below fails if one is not a real step, so it
 *  cannot drift into an excuse for a step that has no affordance at all. */
const CLICK_ANSWERED = new Set(["firstTarget", "secondTarget", "listTarget", "battlefieldTarget", "placement"]);

function pendingSteps(): string[] {
  const source = readFileSync(BOARD_SOURCE, "utf8");
  const start = source.indexOf("type PendingStep =");
  expect(start, "PendingStep was renamed — this scan is measuring nothing").toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf(";", start));
  return [...new Set([...body.matchAll(/\|\s*"([a-zA-Z]+)"/g)].map((m) => m[1]!))];
}

describe("every step the board can enter can be answered", () => {
  it("finds the steps at all — the scan itself works", () => {
    const steps = pendingSteps();
    expect(steps.length, "no steps parsed").toBeGreaterThan(8);
    // **Was `optionalCost` until 2026-08-26.** That step no longer exists: the
    // optional costs became a LIST of yes/no flags (`OPTIONAL_COST_FLAGS` in
    // pending-match.ts) rather than a step of their own, so a play can owe several
    // at once. Re-pointed at a step that does exist rather than deleted — the
    // control is here so a broken parse cannot make this whole file vacuous, and
    // `firstTarget` is the step `targetUnitInstanceId` flows through, which is the
    // one Relentless Pursuit died on.
    expect(steps).toContain("firstTarget");
  });

  it("tells the player what each step is asking", () => {
    // A step with no prompt is a board that has stopped for a reason it will not
    // say. Every one needs a case in the hint switch.
    const source = readFileSync(BOARD_SOURCE, "utf8");
    // **A modal step is explained by its OVERLAY, not by the header hint.** The
    // board opens a ChoiceOverlay for some steps, and that overlay carries its own
    // title right where the player is already looking; a second line in the header
    // would say the same thing twice, in the place they are not looking. So those
    // steps are exempt from the hint switch and not from being explained.
    //
    // Read out of the board rather than listed here, for this file's own reason:
    // a hand-copied list of the board's shape is exactly what it exists to catch.
    const modalLine = source.slice(source.indexOf("const modalStepActive"));
    const modalSteps = new Set(
      [...modalLine.slice(0, modalLine.indexOf(";")).matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!),
    );
    expect(modalSteps.size, "no modal steps parsed — the board renamed `modalStepActive`").toBeGreaterThan(0);

    const unexplained = pendingSteps()
      .filter((step) => !modalSteps.has(step))
      .filter((step) => !source.includes(`case "${step}":`));
    expect(unexplained, "these steps stop the board and say nothing").toEqual([]);
  });

  it("gives every non-click step a control to answer it with", () => {
    // The one that would have caught the `optionalCost` slip: the step existed
    // and rendered nothing, so the play could never be completed.
    const source = readFileSync(BOARD_SOURCE, "utf8");
    const unanswerable = pendingSteps()
      .filter((step) => !CLICK_ANSWERED.has(step))
      .filter((step) => !source.includes(`currentStep === "${step}"`));
    expect(unanswerable, "these steps can be entered and never left").toEqual([]);
  });

  it("every CLICK_ANSWERED entry is a real step", () => {
    // Stops the declared list becoming a way to excuse a step that has no
    // affordance at all — a stale entry would silently exempt a new step of the
    // same name.
    const steps = new Set(pendingSteps());
    for (const step of CLICK_ANSWERED) expect(steps.has(step), `${step} is not a PendingStep`).toBe(true);
  });
});
