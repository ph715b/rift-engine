import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { repeatCostsOf } from "../src/engine/card-effects.js";
import { repeatSubsetsTruncated } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState, RepeatExecution } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * UNL-182 Curtain Call — the pool's only MULTI-INSTANCE `[Repeat]`.
 *
 * > "[Repeat] — :1: / :rainbow: / :1::rainbow: (You may pay **each** additional
 * > cost to repeat this spell's effect.) Choose one you haven't already chosen —
 * > Draw 1. / Deal 2 to a unit at a battlefield. / Deal 3 to a unit at a base. /
 * > Give a unit at a battlefield -4 [Might] this turn."
 *
 * **This is the card 820.1.c.2 and c.3 were waiting for.** Every other `[Repeat]`
 * in the pool prints one instance, so "was it paid" was a boolean and "what did
 * the extra execution choose" was one field. Three instances at three DIFFERENT
 * prices break both: which subset was bought decides the price AND the number of
 * executions, and 820.2 gives each execution its own Make Relevant Choices step.
 *
 * Four rules do the whole of it, and each has a test below by name:
 *  - **820.1.c.2** — "each Cost may be paid or not paid individually". All seven
 *    non-empty subsets are offered, at seven prices.
 *  - **820.1.c.3** — "each Repeat Cost can be paid only a single time".
 *  - **820.3** — "executed an additional time on resolution for each instance of
 *    Repeat that is paid for". Three paid means FOUR executions.
 *  - **820.2.a** — each execution chooses for itself. Here that is constrained by
 *    the card's own "you haven't already chosen", which is the pool's only
 *    printed exception to it.
 *
 * The prices are asserted off the RUNES an offered play names, on a board with no
 * floating Energy at all. Both halves of that are deliberate: floating Energy
 * would absorb the Energy-priced instance entirely (a separate, pre-existing bug
 * — see `optional-cost-float.test.ts`), and rule 164.2 credits a floating Energy
 * back for every Ready rune recycled to pay Power, so a post-play float figure is
 * measuring two rules at once.
 */

const registry = defaultCardRegistry();
const CURTAIN_CALL = "UNL-182";

/** The three printed instances, by their index in `repeatCostsOf`. */
const ENERGY_ONLY = 0; // [1]
const RAINBOW_ONLY = 1; // [rainbow]
const BOTH = 2; // [1][rainbow]

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

const settle = (state: GameState, action: unknown) => answerDecisions(resolveHeldTriggers(resolveChain(accept(state, action))));

/**
 * A caster with the card, enough runes for the dearest play, one enemy unit at a
 * battlefield and one in the enemy base.
 *
 * **NO floating Energy, deliberately.** An optional additional cost's Energy is
 * priced against the float by the validator and then not deducted from it by the
 * executor — a pre-existing gap recorded in `docs/rules-conformance.md` and
 * pinned in `optional-cost-float.test.ts`, which has nothing to do with this card
 * and would make every Energy figure here read as free. With the float at zero
 * the price is the RUNES the play names, which is what these assertions measure.
 *
 * Both bodies are 9 Might so nothing the card does can kill them — a death would
 * remove the very unit a later execution is measured on, and the point here is to
 * see all four instructions land.
 */
function curtainState(): { state: GameState; cardId: string } {
  const card = spellInstance(CURTAIN_CALL);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = Array.from({ length: 9 }, (_, i) => ({
    id: `F${i}`,
    domain: "Fury" as const,
    state: "Ready" as const,
  }));
  state.players[0]!.deck = [spellInstance(CURTAIN_CALL), spellInstance(CURTAIN_CALL)];
  state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "front", might: 9 })] };
  state.players[1]!.baseUnits = [makeUnit({ instanceId: "backline", might: 9 })];
  return { state, cardId: card.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** The instances a play paid, sorted — its identity for the subset assertions. */
const instancesOf = (play: PlayCardAction) => (play.repeatExecutions ?? []).map((e) => e.instance).sort();

const unitAnywhere = (state: GameState, instanceId: string) =>
  [...state.players.flatMap((p) => p.baseUnits), ...state.battlefields.flatMap((b) => Object.values(b.units).flat())].find(
    (u) => u.instanceId === instanceId,
  );

describe("the table records three instances, at the three printed prices", () => {
  it("[1] / [rainbow] / [1][rainbow]", () => {
    expect(repeatCostsOf(CURTAIN_CALL)).toEqual([
      { energy: 1 },
      { energy: 0, rainbowPower: 1 },
      { energy: 1, rainbowPower: 1 },
    ]);
  });

  /** The middle instance costs NO Energy at all, which is a price and not a
   *  placeholder — Called Shot's `[Repeat] [Chaos]` is the same shape. */
  it("the rainbow-only instance really does ask for zero Energy", () => {
    expect(repeatCostsOf(CURTAIN_CALL)[RAINBOW_ONLY]!.energy).toBe(0);
  });

  /** Three is under the enumerator's stated bound, so nothing about this card is
   *  truncated — asserted from both sides so the bound cannot drift to a value
   *  that silently starts hiding plays. */
  it("three instances are BELOW the enumerator's bound, so every subset is offered", () => {
    expect(repeatSubsetsTruncated(repeatCostsOf(CURTAIN_CALL).length)).toBe(false);
    expect(repeatSubsetsTruncated(repeatCostsOf(CURTAIN_CALL).length + 1)).toBe(true);
  });
});

describe("820.1.c.2 — each Cost may be paid or not paid individually", () => {
  it("offers all seven non-empty subsets of the three instances, plus the play that pays none", () => {
    const { state, cardId } = curtainState();
    const subsets = new Set(playsOf(state, cardId).map((p) => JSON.stringify(instancesOf(p))));

    expect([...subsets].sort()).toEqual(
      ["[]", "[0]", "[0,1]", "[0,1,2]", "[0,2]", "[1]", "[1,2]", "[2]"].sort(),
    );
  });

  /**
   * The three prices are three different currencies, which is the whole reason a
   * COUNT of paid instances cannot price this card: one Energy, one rainbow pip,
   * or both.
   *
   * Measured against the play that pays NOTHING, off the same board, so nothing
   * but the additional cost differs.
   */
  it("prices each instance separately — Energy, a rainbow pip, or both", () => {
    const { state, cardId } = curtainState();
    const drawPlays = playsOf(state, cardId).filter((p) => p.modeId === "draw");
    const priceOf = (instances: number[]) => {
      const play = drawPlays.find((p) => JSON.stringify(instancesOf(p)) === JSON.stringify(instances));
      expect(play, `no play paid exactly ${JSON.stringify(instances)}`).toBeDefined();
      return {
        energy: play!.payment.energyRunes.length,
        rainbow: (play!.payment.rainbowRunes ?? []).length,
      };
    };

    // The printed base — 4 Energy, no Power at all.
    expect(priceOf([])).toEqual({ energy: 4, rainbow: 0 });
    // [1] — one more Energy, no pip.
    expect(priceOf([ENERGY_ONLY])).toEqual({ energy: 5, rainbow: 0 });
    // [rainbow] — one pip, and NO more Energy. `energy: 0` in the table is the
    // price rather than a placeholder, and this is where that shows.
    expect(priceOf([RAINBOW_ONLY])).toEqual({ energy: 4, rainbow: 1 });
    // [1][rainbow] — both.
    expect(priceOf([BOTH])).toEqual({ energy: 5, rainbow: 1 });
    // ...and all three together are the sum: two more Energy and two pips.
    expect(priceOf([ENERGY_ONLY, RAINBOW_ONLY, BOTH])).toEqual({ energy: 6, rainbow: 2 });
  });

  /**
   * The two same-priced-looking plans are NOT the same play, which is the
   * sharpest statement of why the subset is a dimension: instance 2 alone and
   * instances 0+1 together cost one Energy and one pip either way, and buy a
   * different NUMBER of executions.
   */
  it("paying {0,1} and paying {2} cost the same and buy different execution counts", () => {
    const { state, cardId } = curtainState();
    const drawPlays = playsOf(state, cardId).filter((p) => p.modeId === "draw");
    const pair = drawPlays.find((p) => JSON.stringify(instancesOf(p)) === "[0,1]")!;
    const single = drawPlays.find((p) => JSON.stringify(instancesOf(p)) === "[2]")!;

    expect(pair.payment.energyRunes.length).toBe(single.payment.energyRunes.length);
    expect((pair.payment.rainbowRunes ?? []).length).toBe((single.payment.rainbowRunes ?? []).length);
    expect(pair.repeatExecutions).toHaveLength(2);
    expect(single.repeatExecutions).toHaveLength(1);
  });

  /** A caster who cannot afford a pip is offered the Energy-only instance and
   *  not the two that need one — 204.2.a, an unpayable additional cost is simply
   *  not available. */
  it("withholds the rainbow instances from a caster with no runes to recycle", () => {
    const { state, cardId } = curtainState();
    // Banked Energy and no runes at all: a rainbow pip can only be paid by
    // recycling one, so the two instances that ask for one are unpayable while
    // the Energy-only instance is not.
    state.players[0]!.channeled = [];
    state.players[0]!.floatingEnergy = 8;
    const subsets = new Set(playsOf(state, cardId).map((p) => JSON.stringify(instancesOf(p))));

    expect(subsets).toContain("[0]");
    expect(subsets).not.toContain("[1]");
    expect(subsets).not.toContain("[2]");
  });
});

describe("820.3 — one additional execution per instance paid", () => {
  /**
   * The whole card in one play: pay all three, execute four times, and because
   * "choose one you haven't already chosen" runs out of modes at exactly four,
   * every printed instruction happens exactly once.
   */
  it("all three paid resolves FOUR executions, one per mode", () => {
    const { state, cardId } = curtainState();
    const allIn = playsOf(state, cardId).find(
      (p) => p.modeId === "draw" && JSON.stringify(instancesOf(p)) === "[0,1,2]",
    );
    expect(allIn, "the all-in play was never offered").toBeDefined();

    const handBefore = state.players[0]!.hand.length;
    const after = settle(state, allIn!);

    // Draw 1 — the base execution. Curtain Call itself left hand for the trash,
    // so the count is (hand - the spell) + 1.
    expect(after.players[0]!.hand.length).toBe(handBefore - 1 + 1);
    const front = unitAnywhere(after, "front")!;
    const backline = unitAnywhere(after, "backline")!;
    // Deal 2 at a battlefield, deal 3 at a base, and -4 Might at a battlefield.
    expect(front.damage).toBe(2);
    expect(backline.damage).toBe(3);
    expect(front.mightThisTurn).toBe(-4);
    expect(effectiveMight(after, front, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  /** The control that gives the figures above their meaning: the same base mode
   *  with NOTHING paid does one instruction and no other. */
  it("and paying none draws 1 and touches neither unit", () => {
    const { state, cardId } = curtainState();
    const plain = playsOf(state, cardId).find(
      (p) => p.modeId === "draw" && (p.repeatExecutions ?? []).length === 0,
    )!;
    const after = settle(state, plain);

    expect(after.players[0]!.hand.length).toBe(state.players[0]!.hand.length - 1 + 1);
    expect(unitAnywhere(after, "front")!.damage).toBe(0);
    expect(unitAnywhere(after, "backline")!.damage).toBe(0);
    expect(unitAnywhere(after, "front")!.mightThisTurn).toBe(0);
  });

  /** One instance paid is TWO executions, not four — the middle of the range,
   *  which is what proves the count follows the subset rather than the flag. */
  it("one instance paid is exactly two executions", () => {
    const { state, cardId } = curtainState();
    const one = playsOf(state, cardId).find(
      (p) =>
        p.modeId === "draw" &&
        JSON.stringify(instancesOf(p)) === "[0]" &&
        p.repeatExecutions?.[0]?.choices?.modeId === "burn-battlefield",
    )!;
    const after = settle(state, one);

    expect(unitAnywhere(after, "front")!.damage).toBe(2);
    expect(unitAnywhere(after, "backline")!.damage, "the base mode was executed too").toBe(0);
    expect(unitAnywhere(after, "front")!.mightThisTurn).toBe(0);
  });
});

describe('"Choose one you haven\'t already chosen"', () => {
  const build = (base: PlayCardAction, executions: readonly RepeatExecution[]): PlayCardAction => ({
    ...base,
    repeatPaid: true,
    repeatExecutions: executions,
  });

  it("every offered play chooses distinct modes across its executions", () => {
    const { state, cardId } = curtainState();
    for (const play of playsOf(state, cardId)) {
      const modes = [play.modeId, ...(play.repeatExecutions ?? []).map((e) => e.choices?.modeId)];
      expect(new Set(modes).size, `${JSON.stringify(modes)} repeats a mode`).toBe(modes.length);
    }
  });

  it("refuses an execution that repeats the base mode", () => {
    const { state, cardId } = curtainState();
    const base = playsOf(state, cardId).find((p) => p.modeId === "burn-battlefield")!;
    const repeated = build(base, [
      { instance: ENERGY_ONLY, choices: { modeId: "burn-battlefield", targetUnitInstanceId: "front" } },
    ]);

    expect(validatePlayCard(state, repeated)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already chose"),
    });
  });

  it("refuses two executions that repeat each other", () => {
    const { state, cardId } = curtainState();
    const base = playsOf(state, cardId).find((p) => p.modeId === "draw")!;
    const repeated = build(base, [
      { instance: ENERGY_ONLY, choices: { modeId: "shrink", targetUnitInstanceId: "front" } },
      { instance: RAINBOW_ONLY, choices: { modeId: "shrink", targetUnitInstanceId: "front" } },
    ]);

    expect(validatePlayCard(state, repeated)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already chose"),
    });
  });

  /**
   * An execution naming NO mode means "the same choices again" everywhere else in
   * this engine — which for this card is exactly the mode already chosen, so it
   * is refused rather than silently defaulted.
   */
  it("refuses an execution that names no mode at all", () => {
    const { state, cardId } = curtainState();
    const base = playsOf(state, cardId).find((p) => p.modeId === "draw")!;

    expect(validatePlayCard(state, build(base, [{ instance: ENERGY_ONLY }]))).toMatchObject({
      ok: false,
      error: expect.stringContaining("has not already chosen"),
    });
  });

  /** 820.1.c.3, on the card that can actually reach it. */
  it("refuses the same instance paid twice, even with two legal distinct modes", () => {
    const { state, cardId } = curtainState();
    const base = playsOf(state, cardId).find((p) => p.modeId === "draw")!;
    const twice = build(base, [
      { instance: ENERGY_ONLY, choices: { modeId: "shrink", targetUnitInstanceId: "front" } },
      { instance: ENERGY_ONLY, choices: { modeId: "burn-base", targetUnitInstanceId: "backline" } },
    ]);

    expect(validatePlayCard(state, twice)).toMatchObject({
      ok: false,
      error: expect.stringContaining("paid more than once"),
    });
  });

  /** The distinctness is a property of THIS card's text, not of `[Repeat]`. Every
   *  other modal Repeat keeps 820.2.a's default, "the same mode or a different
   *  one" — Rocket Barrage is the rulebook's own example of it. */
  it("does not leak onto other modal [Repeat] cards", () => {
    const rocketBarrage = registry.get("SFD-077");
    expect((rocketBarrage.text ?? "").includes("haven't already chosen")).toBe(false);
  });
});

describe("what the enumerator SAMPLES, stated so it is not mistaken for a rule", () => {
  /**
   * The additional executions' TARGETS are sampled to one per mode, which is this
   * file's standing answer to an unbounded choice space (see `legal-actions.ts`,
   * and `unitList` targeting, and the repeatable additional costs). The validator
   * accepts any legal set, so a human client can aim them freely — this asserts
   * that seam rather than leaving it as a comment.
   */
  it("the validator accepts a repeat target the enumerator never offered", () => {
    const { state, cardId } = curtainState();
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "flank", might: 9 })] };
    const offered = playsOf(state, cardId).filter((p) => p.modeId === "draw");
    const sampled = offered.find((p) => p.repeatExecutions?.[0]?.choices?.modeId === "burn-battlefield")!;

    expect(
      sampled.repeatExecutions![0]!.choices!.targetUnitInstanceId,
      "the sample is expected to be one unit, not both",
    ).not.toBe("flank");

    const aimedElsewhere: PlayCardAction = {
      ...sampled,
      repeatExecutions: [{ instance: sampled.repeatExecutions![0]!.instance, choices: { modeId: "burn-battlefield", targetUnitInstanceId: "flank" } }],
    };
    expect(validatePlayCard(state, aimedElsewhere)).toMatchObject({ ok: true });

    const after = settle(state, aimedElsewhere);
    expect(unitAnywhere(after, "flank")!.damage).toBe(2);
  });
});

describe("coverage", () => {
  it("is implemented, with no partial note left behind", () => {
    expect(isCardImplemented(registry.get(CURTAIN_CALL))).toBe(true);
    expect(partialImplementationNote(registry.get(CURTAIN_CALL))).toBeUndefined();
  });
});
