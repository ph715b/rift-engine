import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { recordConquest } from "../src/engine/scoring.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  pickCard,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * The Unleashed cards owned by src/engine/effects/fury.ts.
 *
 * Everything here drives the REAL path — `submit` for a play, `legalActions` for
 * the action itself, `recordConquest` for a conquest, the chain for the response
 * window, and `answerDecisions` for the question. Never a resolver imported by
 * hand: the dispatch hop is what has broken repeatedly in this codebase, and a
 * card that is registered and unreachable is indistinguishable in a test that
 * skips it.
 *
 * **Every assertion below was made to FAIL by commenting out its registry entry
 * before being kept.** The four registrations were removed one at a time and the
 * failure counted; see the wave report.
 *
 * ONE of these cards is registered for only PART of its printed text — Katarina -
 * Reckless, whose "when you hide a card, ready me" is unwritten because no
 * `cardHidden` event exists. Her describe block says so and asserts nothing about
 * that half; an assertion about text nobody wrote is what makes a partial look
 * finished.
 */

const registry = defaultCardRegistry();

const PREPARED_NEOPHYTE = "UNL-004";
const REVNA_THE_LOREKEEPER = "UNL-005";
const TOWERING_PAIROFANT = "UNL-008";
const FRESH_BEANS = "UNL-011";
const RIGHT_OF_CONQUEST = "UNL-015";
const KATARINA_RECKLESS = "UNL-023";
const XERATH_FREED = "UNL-026";
const INVIOLUS_VOX = "UNL-027";

/** Shen - Kinkou (OGN-241) — a `[Reaction]` Unit, 3 Energy + 1 Order Power. The
 *  only way to play a UNIT inside a Showdown short of a facedown card, so he is
 *  what makes Fresh Beans reachable at all. His `[Shield 2]` does nothing here. */
const SHEN_KINKOU = "OGN-241";
/** Consult the Past (OGN-083) — `[Hidden][Reaction]` "Draw 2". Free from facedown
 *  by 811 and it needs no target, so a fixture that plays it is measuring the
 *  LISTENER and nothing else. The same card the Black Market Broker tests use. */
const CONSULT_THE_PAST = "OGN-083";
/** A cheap real Unit to stack a deck with — Sett - Brawler, whose own triggers
 *  need a play or a conquest and so never fire from a deck. */
const FILLER = "OGN-164";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Both players pass on everything waiting on the chain. Deliberately NOT
 *  `resolveHeldTriggers` for the Showdown fixtures: with the chain closed
 *  `executePassFocus` takes the chain branch regardless of turnState, so this
 *  works identically inside and outside a Showdown. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.spellChain.length > 0; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  return next;
}

function unitsInPlay(state: GameState): UnitInstance[] {
  return [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])]),
  ];
}

const findAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  unitsInPlay(state).find((u) => u.instanceId === instanceId);

/**
 * The defIds whose triggers are waiting on the CHAIN.
 *
 * Not `state.pendingTriggers`: `submit` runs the Cleanup, whose last step
 * finalizes the pen onto the chain, so a post-`submit` read of the pen finds an
 * empty array and every `not.toContain` against it passes vacuously.
 */
const heldFor = (state: GameState): string[] =>
  state.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId as string);

describe("the eight cards this file is about are the cards the registry prints", () => {
  it("names match", () => {
    for (const [defId, name] of [
      [PREPARED_NEOPHYTE, "Prepared Neophyte"],
      [REVNA_THE_LOREKEEPER, "Revna the Lorekeeper"],
      [TOWERING_PAIROFANT, "Towering Pairofant"],
      [FRESH_BEANS, "Fresh Beans"],
      [RIGHT_OF_CONQUEST, "Right of Conquest"],
      [KATARINA_RECKLESS, "Katarina - Reckless"],
      [XERATH_FREED, "Xerath - Freed"],
      [INVIOLUS_VOX, "Inviolus Vox"],
    ] as const) {
      expect(registry.get(defId)?.name, `${defId} is a different card`).toBe(name);
    }
  });

  it("the three FULLY implemented report as implemented, and the four refused do not", () => {
    for (const defId of [FRESH_BEANS, RIGHT_OF_CONQUEST, INVIOLUS_VOX]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is registered but coverage cannot see it`).toBe(true);
    }

    // **Katarina is deliberately HALF and must NOT report implemented.** Only her
    // "when you play a card from face down" clause is written; "when you hide a
    // card, ready me" is not. She now carries a `PARTIALLY_IMPLEMENTED` note,
    // which is what makes coverage tell the truth about her.
    //
    // She is also the card that made a known instrument defect real: without that
    // note, `decisionDefIds()` peels her defId off the `UNL-023-shot` decision key
    // and reports her finished on the strength of the half that IS written —
    // measured, with her event trigger deleted. So this assertion is not
    // bookkeeping; it is the only thing standing between a half-written card and
    // a green coverage figure.
    // **Inverted on 2026-08-13.** Her missing clause needed an EVENT that did not
    // exist — nothing raised "a card was hidden" — and the `cardHidden` arm
    // landed as a wave-8 primitive, so both her clauses now work.
    //
    // The paragraph above is kept because its warning outlives the card: without a
    // PARTIALLY_IMPLEMENTED note, `decisionDefIds()` peels her defId off the
    // `UNL-023-shot` decision key and reports her finished on the strength of the
    // half that IS written. That instrument defect is unchanged; what changed is
    // that she no longer needs the note, so the over-report is no longer wrong
    // about HER. The next half-written card with a decision key will need it.
    expect(isCardImplemented(registry.get(KATARINA_RECKLESS)), "Katarina went back to being half-written").toBe(true);
    expect(partialImplementationNote(registry.get(KATARINA_RECKLESS)), "a partial note came back").toBeUndefined();
    // The negative half is what keeps this test honest: it fails the moment a
    // sibling implements one of the refusals, which is exactly when this file's
    // report about them has gone stale and should be re-read.
    //
    // **It did its job the same day.** TOWERING_PAIROFANT and XERATH_FREED were
    // refused here because `deploy.ts` and `ACTIVATED_ABILITIES` are shared
    // files no domain agent may touch; both were implemented in the follow-up
    // primitives pass and are pinned in `test/unl-primitives.test.ts` instead.
    //
    // **And PREPARED_NEOPHYTE left on 2026-08-11**, for the same reason and by
    // the same route: his refusal named the missing state precisely — a record of
    // Energy actually spent on a spell — and `maxSpellEnergySpentThisTurn` is it.
    // He is covered by `test/spell-energy-spent.test.ts` now.
    //
    // **And REVNA left on 2026-08-13, by the same route as the Neophyte** — her
    // refusal named the missing state precisely, and it was NOT the field he
    // reads. `maxSpellEnergySpentThisTurn` is a turn MAXIMUM, which answers "have
    // you spent [4] on a spell this turn" and not "did you spend [4] on THIS
    // spell"; the second needed `spellCast.energySpent`, added as a wave-8
    // primitive. She is covered by `test/unl-fury-wave8.test.ts`.
    //
    // **The refusal list is now EMPTY**, so the loop that walked it is gone rather
    // than left iterating over nothing — a `for` over an empty array generates no
    // assertions and reports green forever.
    //
    // Both are asserted whole here so this file cannot go on describing either as
    // refused while the pool says otherwise.
    expect(isCardImplemented(registry.get(PREPARED_NEOPHYTE)), "the Neophyte went back to unwritten").toBe(true);
    expect(isCardImplemented(registry.get(REVNA_THE_LOREKEEPER)), "Revna went back to unwritten").toBe(true);
  });
});

describe("Right of Conquest (UNL-015): draw 1, then 1 per battlefield you control", () => {
  /** The spell in hand, a deck deep enough for the biggest draw, and whatever
   *  control map the case wants. Cast through `submit`, so payment, the chain and
   *  the resolution hop are all exercised. */
  function conquestState(control: { bf1?: "p1" | "p2"; bf2?: "p1" | "p2" }): { state: GameState; cardId: string } {
    const card = spellInstance(RIGHT_OF_CONQUEST);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.deck = Array.from({ length: 5 }, () => realUnitInstance(FILLER));
    state.players[0]!.floatingEnergy = 10;
    state.players[0]!.floatingPower = { Fury: 5 };
    state.battlefields = state.battlefields.map((bf) => ({
      ...bf,
      controllerId: control[bf.id as "bf1" | "bf2"] ?? null,
    }));
    return { state, cardId: card.instanceId };
  }

  function cast(state: GameState, cardId: string): GameState {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === cardId);
    expect(action, "Right of Conquest was never enumerated — the fixture measures nothing").toBeDefined();
    return resolveChain(accept(state, action));
  }

  it("draws 1 with no battlefield controlled", () => {
    const { state, cardId } = conquestState({});
    expect(cast(state, cardId).players[0]!.hand).toHaveLength(1);
  });

  it("draws 2 with one battlefield controlled", () => {
    const { state, cardId } = conquestState({ bf1: "p1" });
    expect(cast(state, cardId).players[0]!.hand).toHaveLength(2);
  });

  it("draws 3 with both battlefields controlled", () => {
    const { state, cardId } = conquestState({ bf1: "p1", bf2: "p1" });
    expect(cast(state, cardId).players[0]!.hand).toHaveLength(3);
  });

  it("does NOT count the OPPONENT's battlefields", () => {
    // The one reading of "you or allies" that is definitely wrong in a two-player
    // game. A resolver counting every controlled battlefield answers 3 here.
    const { state, cardId } = conquestState({ bf1: "p1", bf2: "p2" });
    expect(cast(state, cardId).players[0]!.hand).toHaveLength(2);
  });

  it("counts CONTROL, not presence", () => {
    const { state, cardId } = conquestState({});
    state.battlefields[0]!.units = { p1: [makeUnit()] };
    // Standing at an uncontrolled battlefield is not controlling it.
    expect(cast(state, cardId).players[0]!.hand).toHaveLength(1);
  });
});

describe("Inviolus Vox (UNL-027): when I conquer, give a friendly unit +8 Might this turn", () => {
  /** Vox at bf1 and a second friendly unit in base, so the question has two real
   *  answers and cannot be auto-resolved into meaninglessness. */
  function voxState(): { state: GameState; voxId: string; allyId: string } {
    const vox = realUnitInstance(INVIOLUS_VOX);
    const ally = makeUnit({ name: "Ally" });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [vox] };
    state.players[0]!.baseUnits = [ally];
    return { state, voxId: vox.instanceId, allyId: ally.instanceId };
  }

  it("pumps the unit the controller names, by 8", () => {
    const { state, allyId } = voxState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), pickCard(allyId));
    expect(findAnywhere(settled, allyId)!.mightThisTurn).toBe(8);
  });

  it("can name Vox himself — the text says no 'other'", () => {
    const { state, voxId } = voxState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), pickCard(voxId));
    expect(findAnywhere(settled, voxId)!.mightThisTurn).toBe(8);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the conquest", () => {
    const { state } = voxState();
    const held = recordConquest(state, 0, "bf1");
    // Before the Cleanup the item is in the pen; after it, on the chain. Either
    // way nothing has been pumped yet.
    expect(held.pendingTriggers.map((e) => e.listenerDefId)).toContain(INVIOLUS_VOX);
    expect(unitsInPlay(held).every((u) => u.mightThisTurn === 0)).toBe(true);
  });

  it("does NOT fire for a conquest at a DIFFERENT battlefield", () => {
    const { state, allyId } = voxState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf2")));
    expect(pendingDecision(settled)).toBeUndefined();
    expect(findAnywhere(settled, allyId)!.mightThisTurn).toBe(0);
  });

  it("does NOT fire when the OPPONENT conquers the battlefield Vox stands at", () => {
    // "When *I* conquer" is his own controller's conquest. A listener walk finds
    // him wherever he is, so without the conqueror check he would pump for the
    // other side's win.
    const { state, allyId } = voxState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 1, "bf1")));
    expect(findAnywhere(settled, allyId)!.mightThisTurn).toBe(0);
  });
});

describe("Fresh Beans (UNL-011): a unit played during a showdown may exhaust it to draw 1", () => {
  /**
   * A ready Fresh Beans, a `[Reaction]` unit in hand and a live Showdown.
   *
   * The Showdown is deliberately EMPTY of contested battlefields: staging one
   * would open a combat and fire designations, and this card is about the play,
   * not about the fight.
   */
  function beansState(overrides: { exhausted?: boolean; caster?: 0 | 1 } = {}): { state: GameState; shenId: string } {
    const beans = realGearInstance(FRESH_BEANS);
    const shen = realUnitInstance(SHEN_KINKOU);
    const caster = overrides.caster ?? 0;
    const state = makeState({
      phase: "Action",
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      focusHolder: caster,
      activePlayerIndex: 0,
    });
    state.players[0]!.activeGear = [{ ...beans, exhausted: overrides.exhausted ?? false }];
    state.players[0]!.deck = Array.from({ length: 3 }, () => realUnitInstance(FILLER));
    state.players[caster]!.hand = [shen];
    state.players[caster]!.floatingEnergy = 10;
    state.players[caster]!.floatingPower = { Order: 5 };
    return { state, shenId: shen.instanceId };
  }

  function playShen(state: GameState, shenId: string): GameState {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === shenId);
    expect(action, "Shen was never enumerated inside the Showdown — the fixture measures nothing").toBeDefined();
    return accept(state, action);
  }

  it("draws 1 and exhausts itself when the controller accepts", () => {
    const { state, shenId } = beansState();
    const settled = answerDecisions(resolveChain(playShen(state, shenId)), (options) => {
      expect(options.map((o) => o.id), "the offer was not a real yes/no").toEqual(["draw", "decline"]);
      return "draw";
    });
    expect(settled.players[0]!.hand, "no card was drawn").toHaveLength(1);
    expect(settled.players[0]!.activeGear[0]!.exhausted, "the cost was not paid").toBe(true);
  });

  it("declining draws nothing and leaves the gear ready", () => {
    const { state, shenId } = beansState();
    const settled = answerDecisions(resolveChain(playShen(state, shenId)), () => "decline");
    expect(settled.players[0]!.hand).toHaveLength(0);
    expect(settled.players[0]!.activeGear[0]!.exhausted).toBe(false);
  });

  it("is HELD — the offer reaches the chain rather than firing at the play", () => {
    const { state, shenId } = beansState();
    const played = playShen(state, shenId);
    expect(heldFor(played)).toContain(FRESH_BEANS);
    expect(pendingDecision(played), "the question was asked inline instead of on the chain").toBeUndefined();
  });

  it("does NOT fire OUTSIDE a showdown", () => {
    // The whole restriction. Without it this would be "when you play a unit",
    // which is a strictly stronger card and would draw off every deploy.
    const { state, shenId } = beansState();
    const neutral: GameState = { ...state, turnState: "Neutral", showdownBattlefieldId: null };
    const played = playShen(neutral, shenId);
    expect(heldFor(played)).not.toContain(FRESH_BEANS);
    expect(answerDecisions(resolveChain(played)).players[0]!.hand).toHaveLength(0);
  });

  it("does NOT fire for the OPPONENT's unit", () => {
    const { state, shenId } = beansState({ caster: 1 });
    const played = playShen(state, shenId);
    expect(heldFor(played)).not.toContain(FRESH_BEANS);
  });

  it("is not offered when the gear is already exhausted — the exhaust is the cost", () => {
    const { state, shenId } = beansState({ exhausted: true });
    const played = playShen(state, shenId);
    expect(heldFor(played), "a Pending Item was placed for a cost that cannot be paid").not.toContain(FRESH_BEANS);
  });

  it("does NOT fire for a SPELL played during the showdown", () => {
    // "A UNIT", so a Reaction-speed spell into the same window pays nothing.
    // Consult the Past from HAND: `[Reaction]`, so it clears the Showdown timing
    // gate, and its "Draw 2" is unrelated to the gear.
    const { state } = beansState();
    const spell = spellInstance(CONSULT_THE_PAST);
    const withSpell: GameState = { ...state };
    withSpell.players[0]!.hand = [spell];
    const action = legalActions(withSpell).find((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    expect(action, "the control spell was never enumerated — this negative measures nothing").toBeDefined();
    expect(heldFor(accept(withSpell, action))).not.toContain(FRESH_BEANS);
  });
});

describe("Katarina - Reckless (UNL-023): the facedown half", () => {
  /**
   * Katarina in p1's base, a real facedown card at bf2 hidden last turn, and an
   * enemy unit to shoot.
   *
   * A live facedown zone and a real enumerated play, not a hand-built `cardPlayed`
   * with `fromHidden: true` — the latter asserts nothing about whether
   * `executePlayCard` actually sets the flag, which is the hop that dies.
   */
  function katarinaState(hiddenOwner: 0 | 1 = 0): { state: GameState; victimId: string; sparedId: string } {
    const victim = makeUnit({ name: "Victim", might: 5 });
    const spared = makeUnit({ name: "Spared", might: 5 });
    const state = makeState({
      phase: "Action",
      turnNumber: 3,
      activePlayerIndex: hiddenOwner,
      focusHolder: hiddenOwner,
      chainPriority: hiddenOwner,
    });
    state.players[0]!.baseUnits = [realUnitInstance(KATARINA_RECKLESS)];
    state.players[1]!.baseUnits = [victim, spared];
    state.battlefields[1]!.hiddenCards = [{ ownerIndex: hiddenOwner, card: spellInstance(CONSULT_THE_PAST), hiddenOnTurn: 1 }];
    return { state, victimId: victim.instanceId, sparedId: spared.instanceId };
  }

  const hiddenPlay = (state: GameState) => {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);
    expect(action, "no from-hidden play was enumerated — the fixture measures nothing").toBeDefined();
    return action!;
  };

  it("deals 2 to the enemy unit its controller names", () => {
    const { state, victimId, sparedId } = katarinaState();
    const settled = answerDecisions(resolveChain(accept(state, hiddenPlay(state))), pickCard(victimId));
    expect(findAnywhere(settled, victimId)!.damage, "the named unit took nothing").toBe(2);
    expect(findAnywhere(settled, sparedId)!.damage, "the shot splashed").toBe(0);
  });

  it("offers every enemy unit, base included — the clause names no battlefield", () => {
    const { state, victimId, sparedId } = katarinaState();
    const played = resolveChain(accept(state, hiddenPlay(state)));
    const decision = pendingDecision(played);
    expect(decision?.kind).toBe("UNL-023-shot");
    expect(optionsFor(played, decision!).map((o) => o.instanceId).sort()).toEqual([victimId, sparedId].sort());
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the play", () => {
    const { state } = katarinaState();
    const played = accept(state, hiddenPlay(state));
    expect(heldFor(played)).toContain(KATARINA_RECKLESS);
  });

  it("does NOT fire on an ordinary play from hand", () => {
    // Without `cardPlayed.fromHidden` the only available reading would be "when
    // you play a card", which pays out on everything she is played alongside.
    const { state } = katarinaState();
    const fromHand = spellInstance(CONSULT_THE_PAST);
    const withHand: GameState = { ...state, battlefields: state.battlefields.map((bf) => ({ ...bf, hiddenCards: [] })) };
    withHand.players[0]!.hand = [fromHand];
    withHand.players[0]!.floatingEnergy = 10;
    const action = legalActions(withHand).find((a) => a.type === "PlayCard" && a.card.instanceId === fromHand.instanceId);
    expect(action, "the control play was never enumerated — this negative measures nothing").toBeDefined();
    expect(heldFor(accept(withHand, action))).not.toContain(KATARINA_RECKLESS);
  });

  it("does NOT fire on the OPPONENT's facedown play", () => {
    const { state, victimId } = katarinaState(1);
    const settled = answerDecisions(resolveChain(accept(state, hiddenPlay(state))));
    expect(findAnywhere(settled, victimId)!.damage).toBe(0);
  });

  it("her 'when you hide a card, ready me' half is UNWRITTEN, and nothing here claims otherwise", () => {
    // A statement of the gap rather than an assertion about behaviour: there is
    // no `cardHidden` GameEvent for the clause to listen to, so a test that drove
    // a Hide and expected her to ready would be asserting a feature nobody wrote.
    // Kept so the refusal is discoverable from the test file too.
    expect(registry.get(KATARINA_RECKLESS)?.text).toContain("When you hide a card, ready me.");
  });
});
