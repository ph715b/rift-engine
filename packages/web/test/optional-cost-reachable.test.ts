import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  repeatCostsOf,
  repeatExecutionsOf,
  type GameState,
  type PlayCardAction,
  type RuneCard,
  type UnitInstance,
  type Domain,
} from "@rift-engine/engine";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import {
  costFlagAlternative,
  matchesRepeatInstances,
  OPTIONAL_COST_FLAGS,
  paidRepeatInstances,
  repeatCostLabel,
  repeatDiscardOptions,
} from "../src/pending-match.js";

/**
 * **An optional cost a human can actually PAY.**
 *
 * `ui-can-express-every-choice.test.ts` asks whether the board READS a field.
 * That is necessary and it is not sufficient, which is the whole reason this file
 * exists beside it: adding a key to `OPTIONAL_COST_FLAGS` makes the field
 * mentioned, but the toggle only renders when `costFlagAlternative` actually
 * finds the other variant among the engine's candidates. A button that never
 * finds one never appears, and on screen that is indistinguishable from a card
 * that has no such cost — the same silence the six declared gaps had.
 *
 * So this drives the ENGINE's own enumeration and asks the board's own
 * derivation. Bard - Mercurial is the subject because he is the one axis of the
 * four that is a REGRESSION rather than a never-built: master's board expressed
 * `exhaustLegendPaid` and the rewrite on this branch did not carry it across, so
 * he was reachable once and then was not.
 */

const registry = defaultCardRegistry();
const BARD = "SFD-079"; // "You may exhaust your legend as an additional cost to play me."

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * A live game with Bard in the human's hand and the runes to pay for him.
 *
 * Mutated from a real `createNewGame` rather than written as a literal — the
 * reason its siblings give, and the reason three headless probes once drifted out
 * of sync with GameState while reporting plausible numbers.
 */
function boardWithBard(): { state: GameState; bardId: string } {
  const [first, second] = allPresetDecks();
  const base = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    99,
  );
  const bard = createCardInstance(registry.get(BARD));
  const state: GameState = {
    ...base,
    phase: "Action",
    activePlayerIndex: 0,
    players: [
      { ...base.players[0]!, hand: [bard], channeled: runes("Mind", 8) },
      base.players[1]!,
    ] as GameState["players"],
  };
  return { state, bardId: bard.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );

describe("Bard - Mercurial's Legend exhaust can be reached from the board", () => {
  it("the ENGINE offers both variants — the precondition", () => {
    // **The control.** Without both variants there is nothing for the board to
    // toggle between, and every assertion below would pass or fail for a reason
    // that has nothing to do with the UI.
    const { state, bardId } = boardWithBard();
    const variants = playsOf(state, bardId);

    expect(variants.length, "Bard was not playable at all — this file measures nothing").toBeGreaterThan(0);
    expect(variants.some((p) => p.exhaustLegendPaid === true), "no PAID variant offered").toBe(true);
    expect(variants.some((p) => (p.exhaustLegendPaid ?? false) === false), "no DECLINED variant offered").toBe(true);
  });

  it("the BOARD finds the paid variant, so the toggle renders", () => {
    // The half that was missing. The engine offered both all along; nothing on
    // the board could name the flag, so `costFlagAlternative` had no key to
    // search on and the button never existed.
    const { state, bardId } = boardWithBard();
    const alternative = costFlagAlternative(playsOf(state, bardId), {}, "exhaustLegendPaid");

    expect(alternative, "no alternative found — the toggle would not render").toBeDefined();
    expect(alternative!.exhaustLegendPaid, "the alternative is not the PAID variant").toBe(true);
  });

  it("and finds the way BACK, so the choice is not one-way", () => {
    // A toggle that can be turned on and not off is a trap: the player commits to
    // exhausting their Legend by exploring, with no way to undo short of
    // cancelling the whole play.
    const { state, bardId } = boardWithBard();
    const back = costFlagAlternative(playsOf(state, bardId), { exhaustLegendPaid: true }, "exhaustLegendPaid");

    expect(back, "the paid choice cannot be undone").toBeDefined();
    expect(back!.exhaustLegendPaid ?? false, "toggling back did not reach the declined variant").toBe(false);
  });

  it("offers no alternative on a card that has no such cost", () => {
    // The negative that stops the three above from being a property of
    // `costFlagAlternative` returning something for anything. An ordinary card
    // has one variant along this axis, so the button must NOT render for it.
    const { state } = boardWithBard();
    const other = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId !== BARD,
    );
    if (!other) return; // this seed's opening offers nothing else — the cases above still hold

    const alternatives = playsOf(state, other.card.instanceId);
    expect(
      costFlagAlternative(alternatives, {}, "exhaustLegendPaid"),
      `${other.card.name} offered a Legend-exhaust toggle it does not print`,
    ).toBeUndefined();
  });
});

describe("toggling one axis holds every OTHER settled choice fixed", () => {
  /**
   * **The mutant a single-axis card cannot kill.** Bard has one optional cost, so
   * with him on the board a candidate that matches on `exhaustLegendPaid` matches
   * on everything — and dropping the pairing guard entirely leaves every
   * assertion above green.
   *
   * It is not hypothetical: rule 820.1.c.2 makes a printed `[Repeat]` under a
   * Temporal Portal grant TWO instances paid separately, so `repeatPaid` and
   * `grantedRepeatPaid` are live on one play at once. Without the guard, turning
   * one on could silently jump to a candidate that also flipped the other — the
   * player pays a cost they never chose.
   *
   * Synthetic candidates here, deliberately. The property under test is SELECTION
   * among a list, not whether this code can read a shape the engine produces —
   * that is what the Bard cases above establish, on the engine's own enumeration.
   * Reaching a genuine two-axis board would need a Portal in play plus a printed
   * [Repeat] in hand, which tests the fixture rather than the guard.
   */
  const candidate = (flags: Partial<PlayCardAction>): PlayCardAction =>
    ({
      type: "PlayCard",
      playerIndex: 0,
      card: createCardInstance(registry.get(BARD)),
      payment: { energyRunes: [], powerRunes: [] },
      ...flags,
    }) as PlayCardAction;

  it("skips a candidate that also flips a different axis", () => {
    // Listed FIRST so a `find` with no guard takes it — the mutant's exact shape.
    const alsoFlipsAccelerate = candidate({ repeatPaid: true, acceleratePaid: true });
    const flipsOnlyRepeat = candidate({ repeatPaid: true });

    const found = costFlagAlternative([alsoFlipsAccelerate, flipsOnlyRepeat], { acceleratePaid: false }, "repeatPaid");

    expect(found, "no alternative found at all — the setup is wrong, not the guard").toBeDefined();
    expect(
      found!.acceleratePaid ?? false,
      "toggling [Repeat] silently turned [Accelerate] on as well — a cost the player never chose",
    ).toBe(false);
  });

  it("finds nothing when every candidate would disturb another axis", () => {
    // The honest outcome: no button, rather than a button that changes two things.
    const found = costFlagAlternative([candidate({ repeatPaid: true, acceleratePaid: true })], { acceleratePaid: false }, "repeatPaid");
    expect(found, "offered an alternative that flips an axis the player had settled").toBeUndefined();
  });
});

describe("Square Up's [Repeat] discard can be chosen, not guessed", () => {
  /**
   * **The pool's only [Repeat] whose cost is CARDS rather than resources** — "[Repeat]
   * — Discard 1". The engine fans out one variant per discardable card, so the
   * choice of WHICH card was always there in the action; the board had no field
   * for it, so `matchesPending` compared candidates that differed only in the
   * discard and `.find` took whichever came first. A player paid the Repeat and
   * the engine picked their card for them.
   *
   * It is a modal step rather than a flag because there is nothing boolean about
   * it, which is why it outlived the four axes closed alongside it.
   */
  const SQUARE_UP = "UNL-017";

  function boardWithSquareUp(): { state: GameState; cardId: string } {
    const [first, second] = allPresetDecks();
    const base = createNewGame(
      { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
      7,
    );
    const card = createCardInstance(registry.get(SQUARE_UP));
    // Two spare cards, so "which one" is a real question rather than a forced move.
    const spare = [createCardInstance(registry.get("OGN-004")), createCardInstance(registry.get("OGN-004"))];
    const state: GameState = {
      ...base,
      phase: "Action",
      activePlayerIndex: 0,
      players: [
        {
          ...base.players[0]!,
          hand: [card, ...spare],
          floatingEnergy: 10,
          channeled: runes("Fury", 8),
          // Square Up gives a unit [Assault 4], so without one on the board it is
          // not playable at all and every assertion below would be about an empty
          // list. The control in the first case is what surfaced that.
          baseUnits: [createCardInstance(registry.get("OGN-002")) as UnitInstance],
        },
        base.players[1]!,
      ] as GameState["players"],
    };
    return { state, cardId: card.instanceId };
  }

  it("the ENGINE fans out one variant per discardable card — the precondition", () => {
    const { state, cardId } = boardWithSquareUp();
    const repeats = playsOf(state, cardId).filter((a) => a.repeatPaid === true);

    expect(repeats.length, "no repeat variant offered — this test measures nothing").toBeGreaterThan(0);
    const discards = new Set(repeats.map((a) => a.repeatDiscardCardInstanceId));
    expect(discards.size, "the engine offered only one card to discard — no choice to express").toBeGreaterThan(1);
  });

  it("the choice is a real one — the variants differ ONLY in which card is discarded", () => {
    // What makes the missing field fatal rather than untidy: with everything else
    // equal, a board that cannot name the discard has no way to tell these apart,
    // so it takes the first and the player never learns a choice existed.
    const { state, cardId } = boardWithSquareUp();
    const repeats = playsOf(state, cardId).filter((a) => a.repeatPaid === true);
    const [a, b] = repeats;
    expect(b, "fewer than two repeat variants — nothing to distinguish").toBeDefined();

    expect(a!.repeatDiscardCardInstanceId).not.toBe(b!.repeatDiscardCardInstanceId);
    expect(a!.targetUnitInstanceId ?? null, "the variants differ in more than the discard").toBe(
      b!.targetUnitInstanceId ?? null,
    );
  });

  it("the card being played is never itself an option", () => {
    // It is in hand, so a naive hand-filter would offer it. The engine already
    // excludes it and the board reads the options off the CANDIDATES, which is
    // what keeps that rule in one place.
    const { state, cardId } = boardWithSquareUp();
    const discards = playsOf(state, cardId)
      .filter((a) => a.repeatPaid === true)
      .map((a) => a.repeatDiscardCardInstanceId);

    expect(discards, "Square Up was offered as its own discard").not.toContain(cardId);
  });

  it("the BOARD offers exactly those cards, and not the spell itself", () => {
    // The half `ui-can-express-every-choice` cannot see: it asks whether the field
    // is READ, and a list that silently comes back empty reads the field and shows
    // an overlay with nothing in it — which looks like a card that asks no
    // question at all.
    const { state, cardId } = boardWithSquareUp();
    const candidates = playsOf(state, cardId).filter((a) => a.repeatPaid === true);
    const hand = state.players[0]!.hand;

    const options = repeatDiscardOptions(candidates, hand);

    expect(options.length, "the discard overlay would be empty").toBeGreaterThan(1);
    expect(options.map((c) => c.instanceId), "Square Up offered itself as its own discard").not.toContain(cardId);
    expect(
      options.every((c) => hand.some((h) => h.instanceId === c.instanceId)),
      "an option that is not in hand",
    ).toBe(true);
  });

  it("offers nothing when the play is not paying a Repeat at all", () => {
    // The negative. Unpaid candidates carry no discard, so the list must be empty
    // rather than falling back to the whole hand — an overlay listing every card
    // would invite a discard the play never asked for.
    const { state, cardId } = boardWithSquareUp();
    const unpaid = playsOf(state, cardId).filter((a) => (a.repeatPaid ?? false) === false);
    expect(unpaid.length, "no unpaid variant — nothing to check").toBeGreaterThan(0);

    expect(repeatDiscardOptions(unpaid, state.players[0]!.hand)).toEqual([]);
  });
});

describe("Curtain Call's three [Repeat] prices are separately payable", () => {
  /**
   * **820.1.c.2 — "if a spell or ability has more than one instance of Repeat,
   * each Cost may be paid or not paid individually".** UNL-182 Curtain Call is the
   * pool's only card that prints more than one: three, at `[1]`, `[rainbow]` and
   * `[1][rainbow]`. So "how many" does not describe the play — paying the cheap
   * instance and paying the dear one buy the same extra execution for different
   * runes, which is exactly why a single `repeatPaid` boolean cannot say it.
   *
   * The engine enumerates all eight subsets. The board could reach exactly one of
   * them, because `repeatPaid` is the one-instance spelling and Curtain Call's
   * candidates carry `repeatExecutions` instead — so its repeat button never
   * rendered at all, and the card was playable only with no repeat.
   */
  const CURTAIN_CALL = "UNL-182";

  const enemy = (instanceId: string): UnitInstance => ({
    ...(createCardInstance(registry.get("OGN-002")) as UnitInstance),
    instanceId,
    might: 9,
  });

  function boardWithCurtainCall(): { state: GameState; cardId: string } {
    const [first, second] = allPresetDecks();
    const base = createNewGame(
      { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
      11,
    );
    const card = createCardInstance(registry.get(CURTAIN_CALL));
    const domains = ["Fury", "Calm", "Mind", "Body", "Chaos", "Order"] as const;
    const state: GameState = {
      ...base,
      phase: "Action",
      activePlayerIndex: 0,
      players: [
        {
          ...base.players[0]!,
          hand: [card],
          floatingEnergy: 12,
          // Rainbow prices need several DOMAINS present, not merely several runes.
          channeled: domains.flatMap((d, i) => runes(d, 2).map((r) => ({ ...r, id: `${d}-${i}-${r.id}` }))),
          deck: [createCardInstance(registry.get(CURTAIN_CALL)), createCardInstance(registry.get(CURTAIN_CALL))],
        },
        { ...base.players[1]!, baseUnits: [enemy("backline")] },
      ] as GameState["players"],
    };
    // Curtain Call chooses a mode it has NOT already chosen (820.2 gives each
    // execution its own choices), so the number of legal TARGETS bounds how many
    // executions can be bought. With one enemy unit the board affords only single
    // instances — measured, after a hardcoded two-instance pick failed here.
    return {
      state: {
        ...state,
        battlefields: state.battlefields.map((b, i) =>
          i === 0 ? { ...b, units: { ...b.units, [state.players[1]!.id]: [enemy("front")] } } : b,
        ),
      },
      cardId: card.instanceId,
    };
  }

  const subsetsOffered = (state: GameState, cardId: string) =>
    new Set(playsOf(state, cardId).map((p) => paidRepeatInstances(p).join(",")));

  it("the ENGINE offers more than one subset — the precondition", () => {
    const { state, cardId } = boardWithCurtainCall();

    expect(playsOf(state, cardId).length, "Curtain Call was not playable — this measures nothing").toBeGreaterThan(0);
    expect(subsetsOffered(state, cardId).size, "only one subset offered — no choice to express").toBeGreaterThan(1);
  });

  it("an unset pick matches every subset, so arming the card drops nothing", () => {
    // The distinction that makes an empty array mean something different from
    // "not yet chosen". Collapsing them would filter every paid variant away the
    // moment the card was armed — which is how it ended up unrepeatable.
    const { state, cardId } = boardWithCurtainCall();
    const all = playsOf(state, cardId);

    expect(all.every((a) => matchesRepeatInstances(a, undefined)), "an unset pick excluded a candidate").toBe(true);
    expect(
      all.filter((a) => matchesRepeatInstances(a, [])).length,
      "paying NONE matched everything — the empty array is being read as unset",
    ).toBeLessThan(all.length);
  });

  it("picking one instance reaches candidates that pay exactly it", () => {
    const { state, cardId } = boardWithCurtainCall();
    const all = playsOf(state, cardId);

    for (const instance of [0, 1, 2]) {
      const matched = all.filter((a) => matchesRepeatInstances(a, [instance]));
      expect(matched.length, `no candidate pays instance ${instance} alone`).toBeGreaterThan(0);
      for (const a of matched) expect(paidRepeatInstances(a)).toEqual([instance]);
    }
  });

  it("order does not matter — a pick is a SET, not a sequence", () => {
    // The toggles append in CLICK order, so the pick arrives unsorted. A
    // comparison that respected order would make the same subset reachable or not
    // depending on which button was pressed first.
    //
    // The pair is taken from what this board actually AFFORDS rather than named
    // outright: the three instances have three different prices, and which
    // combinations are payable is the engine's business. Hardcoding [0,2] failed
    // here for exactly that reason — a fact about the fixture, not about order.
    const { state, cardId } = boardWithCurtainCall();
    const all = playsOf(state, cardId);
    const pair = [...subsetsOffered(state, cardId)]
      .map((key) => key.split(",").filter(Boolean).map(Number))
      .find((subset) => subset.length === 2);
    expect(pair, "this board affords no two-instance subset — nothing to reorder").toBeDefined();

    const forward = all.filter((a) => matchesRepeatInstances(a, pair!)).length;
    const reversed = all.filter((a) => matchesRepeatInstances(a, [...pair!].reverse())).length;

    expect(forward, "the offered subset matched nothing").toBeGreaterThan(0);
    expect(reversed, "click order changed which candidates matched").toBe(forward);
  });

  it("labels each instance by its PRICE, and the zero-Energy one is not [0]", () => {
    // Curtain Call's middle instance asks for no Energy at all — a price, not a
    // placeholder. A button reading "[0][rainbow]" would claim a cost the card
    // does not print, and "Repeat #2" would make the player guess which they were
    // buying when the three differ only in price.
    const [cheap, rainbowOnly, both] = repeatCostsOf(CURTAIN_CALL);

    expect(repeatCostLabel(cheap!)).toBe("[1]");
    expect(repeatCostLabel(rainbowOnly!), "the zero-Energy instance rendered its zero").toBe("[rainbow]");
    expect(repeatCostLabel(both!)).toBe("[1][rainbow]");
  });

  /**
   * **The half that is still open, pinned so closing it fails loudly.**
   *
   * 820.2 gives every additional execution its own Make Relevant Choices step, and
   * 820.2.a's worked example is Rocket Barrage choosing a different MODE the second
   * time. So a subset does not describe the play either: with the instances picked,
   * the executions still differ in what they each do.
   *
   * The board has no field for that, so `matchesPending` cannot tell these
   * candidates apart and `.find` takes whichever the engine enumerated first. The
   * player buys a second execution and the engine chooses what it does.
   *
   * This asserts the WRONG answer on purpose — the repo's rule for a recorded
   * divergence. When per-execution choices become expressible, the count below
   * drops to 1 and this test fails, which is the point: a silent fix is how a gap
   * stops being tracked. See docs/rules-conformance.md.
   */
  it("DIVERGENCE: with the subset picked, each execution's own choices are still arbitrary", () => {
    const { state, cardId } = boardWithCurtainCall();
    const all = playsOf(state, cardId);

    const oneInstance = all.filter((a) => matchesRepeatInstances(a, [0]));
    expect(oneInstance.length, "no candidate pays instance 0 alone — the pin measures nothing").toBeGreaterThan(0);

    // Same base mode AND same instance paid, differing only in what that
    // execution does. More than one means the board must guess.
    const byBaseMode = oneInstance.filter((a) => a.modeId === oneInstance[0]!.modeId);
    expect(
      byBaseMode.length,
      "per-execution choices became expressible — narrow the KNOWN_GAPS entry and update rules-conformance.md",
    ).toBeGreaterThan(1);

    const executionChoices = new Set(
      byBaseMode.map((a) => JSON.stringify(repeatExecutionsOf(a).map((e) => e.choices ?? null))),
    );
    expect(executionChoices.size, "the candidates do not actually differ in their execution choices").toBeGreaterThan(1);
  });

  it("a single-instance card gets no per-instance toggles at all", () => {
    // The other twenty keep the `repeatPaid` boolean. Rendering three buttons for
    // a card that prints one Repeat would be worse than the gap was.
    expect(repeatCostsOf("SFD-031").length, "Desert's Call stopped printing exactly one Repeat").toBe(1);
  });
});

describe("every declared axis is one the board could actually toggle", () => {
  it("names a flag the engine can vary — an invented key renders nothing, silently", () => {
    /**
     * `costFlagAlternative` searches for a candidate differing in ONE key. A key
     * the enumerator never varies can never produce one, so the button is absent
     * on every card forever — which is exactly the failure the six gaps were, and
     * it leaves no trace to notice.
     *
     * Asserted against the engine's own enumerator surface rather than a roster:
     * `optional-cost-variants.test.ts` checks each key is a real
     * `PlayCardAction` field, and this checks the list is non-empty and shaped so
     * a lookup is possible at all. Together they mean a typo cannot survive.
     */
    for (const { key, on, off } of OPTIONAL_COST_FLAGS) {
      expect(on.length, `${key} has no ON label — the button would be blank`).toBeGreaterThan(0);
      expect(off.length, `${key} has no OFF label`).toBeGreaterThan(0);
      expect(on, `${key}'s two labels are identical — the button would not say what it does`).not.toBe(off);
    }
  });
});
