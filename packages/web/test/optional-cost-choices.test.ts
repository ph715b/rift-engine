import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  repeatCostOf,
  type CardInstance,
  type PlayCardAction,
} from "@rift-engine/engine";
import {
  OPTIONAL_COST_AXES,
  cardHasAxis,
  matchesOptionalCosts,
  pendingOptionalCostAxis,
} from "../src/optional-cost-choices.js";

/**
 * The yes/no additional costs, and the board finally asking about them.
 *
 * `ui-can-express-every-choice.test.ts` measured twelve choices the engine fans
 * out that the board could not express. Four are the same shape — a BOOLEAN the
 * enumerator emits two candidates for — and together they are about twenty
 * cards, **including the whole `[Repeat]` keyword, which was never offered at
 * all**, and the entire paid halves of Bard - Mercurial and Akshan -
 * Mischievous, both shipped the same week and both passing every engine gate.
 *
 * The board resolved all four by taking whichever candidate came first.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));

const DANGER_ZONE = "SFD-182"; // prints [Repeat]
const BARD = "SFD-079"; // exhaust your legend
const AKSHAN = "SFD-109"; // optional [Body][Body]
const CLOCKWORK_KEEPER = "OGN-044"; // optional [1 Calm]
const CHARM = "OGN-043"; // no optional cost at all

/** A pair of candidates differing only in `field` — what the enumerator emits
 *  for one of these cards. */
const pair = (field: keyof PlayCardAction): PlayCardAction[] =>
  [{ [field]: true } as unknown as PlayCardAction, {} as PlayCardAction];

describe("which cards carry a yes/no cost, asked of the engine", () => {
  it("recognises each axis on a real card", () => {
    expect(cardHasAxis(card(DANGER_ZONE), "repeatPaid")).toBe(true);
    expect(cardHasAxis(card(BARD), "exhaustLegendPaid")).toBe(true);
    expect(cardHasAxis(card(AKSHAN), "optionalPowerPaid")).toBe(true);
    expect(cardHasAxis(card(CLOCKWORK_KEEPER), "optionalPowerPaid")).toBe(true);
  });

  it("says no for a card with no optional cost — the control", () => {
    for (const axis of OPTIONAL_COST_AXES) {
      expect(cardHasAxis(card(CHARM), axis.field), `${axis.field} on Charm`).toBe(false);
    }
  });

  it("covers every printed [Repeat] card — this was the biggest single gap", () => {
    // 14 cards, and the keyword was entirely unreachable from the board.
    const repeatCards = registry
      .all()
      // No `Battlefield` check: `card-loader`'s `shouldSkip` keeps them out of the
      // loaded pool entirely, so the comparison is impossible and the compiler
      // says so.
      .filter((d) => d.type !== "Legend" && repeatCostOf(d.id) !== undefined);
    expect(repeatCards.length, "the [Repeat] card count moved — re-read the sweep").toBeGreaterThan(10);
    for (const d of repeatCards) {
      expect(cardHasAxis(card(d.id), "repeatPaid"), `${d.id} ${d.name}`).toBe(true);
    }
  });
});

describe("asking, and only when there is something to ask", () => {
  it("asks when the enumerator offered BOTH answers", () => {
    expect(pendingOptionalCostAxis(pair("repeatPaid"), {})?.field).toBe("repeatPaid");
  });

  it("does NOT ask when the paid variant was never offered", () => {
    // An unaffordable cost is not a question. The enumerator simply omits the
    // paid candidate (416.3), so a version keyed on the CARD rather than on the
    // candidates would stall on a question with one answer.
    const declineOnly = [{} as PlayCardAction];
    expect(pendingOptionalCostAxis(declineOnly, {})).toBeUndefined();
  });

  it("does NOT ask again once answered — including when the answer was NO", () => {
    // `false` is a real answer. Storing it is what keeps "declined" distinct from
    // "not yet asked"; without it the step would loop forever on a decline.
    expect(pendingOptionalCostAxis(pair("repeatPaid"), { repeatPaid: false })).toBeUndefined();
    expect(pendingOptionalCostAxis(pair("repeatPaid"), { repeatPaid: true })).toBeUndefined();
  });

  it("asks a SECOND axis when a card carries two", () => {
    // 3509 makes a printed [Repeat] and a granted one independently payable, so
    // a spell under Temporal Portal has two axes and four priced combinations.
    const candidates = [
      { repeatPaid: true, grantedRepeatPaid: true } as unknown as PlayCardAction,
      { repeatPaid: true } as unknown as PlayCardAction,
      { grantedRepeatPaid: true } as unknown as PlayCardAction,
      {} as PlayCardAction,
    ];
    expect(pendingOptionalCostAxis(candidates, {})?.field).toBe("repeatPaid");
    expect(pendingOptionalCostAxis(candidates, { repeatPaid: true })?.field).toBe("grantedRepeatPaid");
    expect(pendingOptionalCostAxis(candidates, { repeatPaid: true, grantedRepeatPaid: false })).toBeUndefined();
  });

  it("asks [Repeat] FIRST, because it changes what the card DOES", () => {
    // 820.1.d gives the additional execution its own choices, so naming targets
    // before deciding whether the spell resolves twice is choosing without the
    // fact that matters most.
    expect(OPTIONAL_COST_AXES[0]!.field).toBe("repeatPaid");
  });
});

describe("the answer selects the right candidate", () => {
  it("takes the PAID candidate on yes and the unpaid on no", () => {
    const [paid, unpaid] = pair("repeatPaid") as [PlayCardAction, PlayCardAction];
    expect(matchesOptionalCosts(paid, { repeatPaid: true })).toBe(true);
    expect(matchesOptionalCosts(unpaid, { repeatPaid: true })).toBe(false);
    expect(matchesOptionalCosts(unpaid, { repeatPaid: false })).toBe(true);
    expect(matchesOptionalCosts(paid, { repeatPaid: false })).toBe(false);
  });

  it("leaves an unanswered axis a wildcard", () => {
    // Before the question is answered both candidates must stay live, or the
    // step has nothing to offer — the same rule the Equipment step keeps.
    const [paid, unpaid] = pair("repeatPaid") as [PlayCardAction, PlayCardAction];
    expect(matchesOptionalCosts(paid, {})).toBe(true);
    expect(matchesOptionalCosts(unpaid, {})).toBe(true);
  });

  it("compares each axis independently", () => {
    const both = { repeatPaid: true, grantedRepeatPaid: true } as unknown as PlayCardAction;
    expect(matchesOptionalCosts(both, { repeatPaid: true, grantedRepeatPaid: true })).toBe(true);
    expect(matchesOptionalCosts(both, { repeatPaid: true, grantedRepeatPaid: false })).toBe(false);
  });
});

describe("the prompt says what the cost actually is", () => {
  it("names Danger Zone's [Repeat] pips rather than saying 'the additional cost'", () => {
    // A bare "pay the additional cost?" is a question a player cannot answer.
    const axis = OPTIONAL_COST_AXES.find((a) => a.field === "repeatPaid")!;
    const text = axis.prompt(card(DANGER_ZONE));
    expect(text).toContain("Danger Zone");
    expect(text, "the prompt does not say what it costs").toMatch(/Energy|Power/);
  });

  it("names the card in every axis's prompt", () => {
    for (const axis of OPTIONAL_COST_AXES) {
      expect(axis.prompt(card(BARD)), `${axis.field} does not name the card`).toContain("Bard");
    }
  });
});
