import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { unitChooseableBy } from "../src/engine/target-lookup.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **The shared-file primitives landed for wave 8, tested before any card uses
 * them.**
 *
 * Wave 7's thirty refusals clustered on a handful of missing mechanisms rather
 * than on thirty separate problems. These are the ones the integrator can land
 * alone, and each is tested here rather than only through the first card that
 * happens to need it — a primitive proved solely by its first consumer is
 * indistinguishable from a primitive that only works for that consumer.
 *
 * Two are covered here. The third (`ActivationCost.xp`) has no consumer yet and
 * is exercised by the card that adopts it.
 */

const registry = defaultCardRegistry();
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

describe("Baron Nashor (UNL-147) can't be chosen by enemy spells and abilities", () => {
  /** Baron at bf1 for `ownerIndex`. */
  function board(ownerIndex: 0 | 1): { state: GameState; baron: ReturnType<typeof realUnitInstance> } {
    const baron = realUnitInstance("UNL-147");
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const key = ownerIndex === 0 ? "p1" : "p2";
    state.battlefields[0] = { ...state.battlefields[0]!, units: { [key]: [baron] } };
    return { state, baron };
  }

  it("refuses the ENEMY and allows his own side", () => {
    const { state, baron } = board(0);
    expect(unitChooseableBy(state, baron, 0, 1), "an enemy could choose Baron Nashor").toBe(false);
    expect(unitChooseableBy(state, baron, 0, 0), "his own controller could not choose him").toBe(true);
  });

  it("does not protect anyone standing beside him", () => {
    // The row is keyed by defId, so a bystander is the control that says this is
    // about Baron and not about the battlefield.
    const { state } = board(0);
    const bystander = makeUnit({ name: "Bystander", might: 3 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [...(state.battlefields[0]!.units["p1"] ?? []), bystander] },
    };
    expect(unitChooseableBy(state, bystander, 0, 1), "the protection leaked onto a neighbour").toBe(true);
  });

  it("is UNCONDITIONAL — unlike Master Yi's, which is gated on XP", () => {
    // Ruin Runner's shape, not Master Yi's. Asserted with the owner at 0 XP,
    // which is where a mistakenly XP-gated version would let him be chosen.
    const { state, baron } = board(0);
    state.players[0]!.xp = 0;
    expect(unitChooseableBy(state, baron, 0, 1), "his protection turned out to be conditional").toBe(false);
  });

  it("leaves him HALF written — the battlefield token is still unwritten", () => {
    // Two of three clauses now. The third is systemic: nothing in this engine can
    // add a battlefield at all, which is why it is a refusal rather than a to-do.
    expect(isCardImplemented(registry.get("UNL-147")), "Baron claims to be finished").toBe(false);
    expect(partialImplementationNote(registry.get("UNL-147")), "his remaining gap is unrecorded").toMatch(
      /two of three clauses/,
    );
  });
});

describe("a spell chain entry records the ENERGY actually spent", () => {
  /** Thermo Beam — 5 Energy, no Power, no target. */
  const BIG = "OGN-022";
  /** Cleave — 1 Energy, no Power, and crucially NOT a [Reaction]: En Garde was
   *  the first pick here and is a Reaction, so it is not enumerable in a plain
   *  Action phase at all and the test failed as "not playable". */
  const SMALL = "OGN-004";

  function caster(spellIds: string[]): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = spellIds.map((id) => spellInstance(id));
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`r${i}`, "Fury"));
    // A unit to point at. Cleave gives a friendly unit +Might, so with an empty
    // board it has no legal target and is not enumerated at all — which failed as
    // "not playable" and reads like a missing card rather than an empty board.
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "target", name: "Target", might: 3 })];
    return state;
  }

  /** The Energy recorded on the top chain entry.
   *
   *  `spellChain` holds a UNION — a spell entry and a trigger entry — and only the
   *  spell arm carries `energySpent`. The narrow is load-bearing rather than
   *  cosmetic: without it this file compiles under vitest (which transpiles
   *  without checking) and fails at `npm run typecheck`, which is precisely how it
   *  was caught. */
  const spentOnTop = (state: GameState): number | undefined => {
    const entry = state.spellChain[state.spellChain.length - 1];
    return entry !== undefined && "card" in entry ? entry.energySpent : undefined;
  };

  const play = (state: GameState, defId: string): GameState => {
    const action = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId,
    );
    expect(action, `${defId} was not playable`).toBeDefined();
    const { state: next, result } = submit(state, action!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    return next;
  };

  it("records the printed Energy when nothing discounts it", () => {
    const after = play(caster([BIG]), BIG);
    expect(spentOnTop(after), "the chain entry did not record what was spent").toBe(5);
  });

  it("records each spell's OWN figure, not a running maximum", () => {
    // The distinction that made this a new field rather than a reuse of
    // `maxSpellEnergySpentThisTurn`: a cheap spell after an expensive one must
    // record 1, or a per-spell threshold fires on a spell that never met it.
    // **Stated as one play against a pre-set maximum, rather than as two plays in
    // sequence.** The obvious fixture — cast the expensive spell, then the cheap
    // one — does not work: resolving the first hands priority to the opponent, so
    // the second is not enumerable for player 0 at all, and the failure reads as
    // "OGN-046 was not playable" rather than as anything about Energy.
    //
    // Setting the turn maximum directly is the sharper test anyway: it puts the
    // two fields side by side on ONE play, which is exactly where an
    // implementation that reused `maxSpellEnergySpentThisTurn` would be caught.
    const state = caster([SMALL]);
    state.players[0]!.maxSpellEnergySpentThisTurn = 5;

    const after = play(state, SMALL);

    expect(spentOnTop(after), "the cheap spell inherited the turn's maximum").toBe(1);
    expect(
      after.players[0]!.maxSpellEnergySpentThisTurn,
      "the turn maximum was lowered by a cheaper spell — the two fields would be the same field",
    ).toBe(5);
  });

  it("reflects a DISCOUNT rather than the printed cost", () => {
    // The whole reason the figure is recorded at play time instead of being
    // re-derived later. Eager Apprentice reduces spell Energy by 1 while at a
    // battlefield, to a minimum of 1.
    const state = caster([BIG]);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance("OGN-084")] } };

    expect(spentOnTop(play(state, BIG)), "the recorded figure is the printed cost, not what was spent").toBe(4);
  });
});
