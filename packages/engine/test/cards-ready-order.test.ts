import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { PlayerAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The Order half of the dead-card survey's "READY" cluster, plus one dual-domain
 * signature spell.
 *
 * Everything here is driven through `legalActions` -> `submit`, never a resolver
 * closure. Four of these five cards do their work through a pending DECISION
 * raised mid-resolution, which is two dispatch hops away from the action: the
 * play has to be enumerated, the chain has to resolve, the question has to be
 * raised, and only then does anything happen. A test that called the resolver
 * would clear the last hop and prove nothing about the first three.
 */

const registry = defaultCardRegistry();
const KINGS_EDICT = "OGN-237";
const SPECTRAL_MATRON = "OGN-226";
const ALBUS_FERROS = "OGN-230";
const MACHINE_EVANGEL = "OGN-239";
const LAST_BREATH = "OGN-260";
const VENGEANCE = "OGN-229"; // "Kill a unit." — the killer, for Machine Evangel's Deathknell
const SOLARI_SHRINE = "OGN-072"; // "When you kill a stunned enemy unit, you may exhaust this to draw 1."

/**
 * Enough Ready runes of a card's OWN Power domain to pay for it outright.
 * Energy is domain-agnostic, so one colour covers both halves of every cost in
 * this file (the dearest is King's Edict at 6 Energy + 2 Power).
 */
function runesFor(defId: string, count = 12) {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string) {
  return legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === instanceId);
}

/**
 * Plays a Spell and passes Focus until it RESOLVES.
 *
 * A Spell takes effect on the chain, not when it is played, so asserting
 * straight after `submit` reads an unresolved chain as a broken card. Stops if a
 * question is raised, since `submit` refuses a PassFocus while one is pending
 * (320.1) — that pause is the point for four of the five cards here.
 */
function castAndResolve(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the card was never enumerated as playable").toBeDefined();
  let current = submit(state, action!).state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

/** Answers the pending question by option id, through `submit` — so the answer
 *  is one the game would really accept, not a direct call into decisions.ts. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const result = submit(state, { type: "AnswerDecision", playerIndex: decision!.playerIndex, decisionId: decision!.id, optionId });
  expect(result.result, `the answer "${optionId}" was refused`).toEqual({ type: "Ok" });
  return result.state;
}

/** The labels currently on offer, for asserting WHICH choices a card gives. */
function offered(state: GameState): string[] {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.label);
}

describe("King's Edict (OGN-237): the OPPONENT names which of their units dies", () => {
  /** Edict in hand for p1, `theirs` on p2's board. */
  function edictState(theirs: string[]): { state: GameState; spellId: string } {
    const spell = spellInstance(KINGS_EDICT);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(KINGS_EDICT);
    state.players[1]!.baseUnits = theirs.map((name) => makeUnit({ name }));
    return { state, spellId: spell.instanceId };
  }

  it("asks the OPPONENT, and kills the unit they name", () => {
    const { state, spellId } = edictState(["Theirs A", "Theirs B"]);

    const asked = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(pendingDecision(asked)!.kind).toBe("OGN-237-kill");
    expect(pendingDecision(asked)!.playerIndex, "the caster must not answer their own Edict").toBe(1);
    expect(offered(asked)).toEqual(["Theirs A", "Theirs B"]);

    const option = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "Theirs B")!;
    const after = answer(asked, option.id);

    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Theirs A"]);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Theirs B"]);
  });

  it("never offers a unit the CASTER controls — 'a unit you don't control'", () => {
    // The whole difference from Cull the Weak. Without the restriction the
    // opponent would be handed the caster's board to prune.
    const { state, spellId } = edictState(["Theirs A", "Theirs B"]);
    state.players[0]!.baseUnits = [makeUnit({ name: "Mine" })];

    const asked = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(offered(asked)).not.toContain("Mine");
    expect(asked.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Mine"]);
  });

  it("kills without asking when the opponent has exactly one unit", () => {
    // Not a choice, so `advanceDecisions` executes it rather than opening a
    // prompt — and the kill must still happen.
    const { state, spellId } = edictState(["Only"]);

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[1]!.baseUnits).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Only"]);
  });

  it("reaches a unit at a battlefield as well as one in base", () => {
    const { state, spellId } = edictState([]);
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Forward" })] };

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(after.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Forward"]);
  });

  it("credits the CASTER with the kill, not the player who chose", () => {
    // The one substantive rules call on this card: "each other player CHOOSES a
    // unit... Kill those units" splits the choice from the kill. Solari Shrine
    // ("when YOU kill a stunned enemy unit") is the only thing on the board that
    // can tell the difference, so it is the instrument — its question appearing
    // for the caster IS the killer attribution.
    const { state, spellId } = edictState([]);
    state.players[0]!.activeGear = [createCardInstance(registry.get(SOLARI_SHRINE)) as GearInstance];
    state.players[1]!.baseUnits = [makeUnit({ name: "Stunned One", stunned: true })];

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Stunned One"]);
    expect(pendingDecision(after)?.kind, "the Shrine did not see the caster as the killer").toBe("OGN-072-draw");
    expect(pendingDecision(after)!.playerIndex).toBe(0);
  });
});

describe("Spectral Matron (OGN-226): play a cheap unit out of your trash", () => {
  /** The Matron in hand, `trash` in p1's trash. */
  function matronState(trash: ReturnType<typeof makeUnit>[]): { state: GameState; matronId: string } {
    const matron = realUnitInstance(SPECTRAL_MATRON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [matron];
    state.players[0]!.channeled = runesFor(SPECTRAL_MATRON);
    state.players[0]!.trash = trash;
    return { state, matronId: matron.instanceId };
  }

  const cheap = () => makeUnit({ name: "Cheap", energyCost: 3, powerCost: 1 });
  const tooExpensive = () => makeUnit({ name: "Pricey", energyCost: 4, powerCost: 0 });
  const tooMuchPower = () => makeUnit({ name: "Heavy", energyCost: 1, powerCost: 2 });

  /** Plays the Matron and resolves what that puts on the chain.
   *
   *  This used to read "a Unit resolves on play, not on the chain", which was
   *  true until on-play triggers became Chain Pending Items — the unit still
   *  arrives immediately, but its ABILITY waits like a spell, so the same
   *  pass-until-resolved loop a Spell needs applies here too. */
  const play = (state: GameState, matronId: string) => {
    const action = castsOf(state, matronId)[0];
    expect(action, "the Matron was never enumerated as playable").toBeDefined();
    return castAndResolve(state, action);
  };

  it("offers only the units within BOTH cost limits", () => {
    // Two conditions, both printed, and each rules out a different card here —
    // a filter that checked only Energy would offer Heavy, and one that checked
    // only Power would offer Pricey.
    const { state, matronId } = matronState([cheap(), tooExpensive(), tooMuchPower()]);

    const asked = play(state, matronId);

    expect(pendingDecision(asked)!.kind).toBe("OGN-226-play");
    expect(offered(asked)).toEqual(["Decline", "Cheap"]);
  });

  it("puts the chosen unit into play from the trash, exhausted and free", () => {
    const { state, matronId } = matronState([cheap()]);
    const asked = play(state, matronId);

    const option = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "Cheap")!;
    const after = answer(asked, option.id);

    expect(after.players[0]!.trash.map((c) => c.name)).toEqual([]);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Spectral Matron", "Cheap"]);
    expect(after.players[0]!.baseUnits[1]!.exhausted, "143.4.a — it enters exhausted").toBe(true);

    // "Ignoring its cost" — measured against the declining branch rather than
    // against an arithmetic guess, since paying recycles some runes and exhausts
    // others. Every resource is identical either way: the Matron's own 4+2 was
    // paid, and nothing beyond it.
    const control = matronState([cheap()]);
    const declined = answer(play(control.state, control.matronId), "decline");
    expect(after.players[0]!.channeled).toEqual(declined.players[0]!.channeled);
    expect(after.players[0]!.runeDeck).toEqual(declined.players[0]!.runeDeck);
    expect(after.players[0]!.floatingEnergy).toEqual(declined.players[0]!.floatingEnergy);
  });

  it("declining leaves the trash untouched", () => {
    const { state, matronId } = matronState([cheap()]);
    const asked = play(state, matronId);

    const after = answer(asked, "decline");

    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Cheap"]);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Spectral Matron"]);
  });

  it("asks nothing at all when the trash holds nothing eligible", () => {
    const { state, matronId } = matronState([tooExpensive(), tooMuchPower()]);

    const after = play(state, matronId);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Pricey", "Heavy"]);
  });
});

describe("Albus Ferros (OGN-230): spend any number of buffs, channel one rune each", () => {
  /** Albus in hand, `buffed` friendly units in base, `runes` left in the rune deck. */
  function albusState(buffedNames: string[], runeDeckSize: number): { state: GameState; albusId: string } {
    const albus = realUnitInstance(ALBUS_FERROS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [albus];
    state.players[0]!.channeled = runesFor(ALBUS_FERROS);
    state.players[0]!.baseUnits = buffedNames.map((name) => makeUnit({ name, buffed: true }));
    state.players[0]!.runeDeck = Array.from({ length: runeDeckSize }, (_, i) => ({
      id: `deck-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));
    return { state, albusId: albus.instanceId };
  }

  // Through `castAndResolve` for the reason the Matron's helper records: his
  // on-play ability is a Chain Pending Item now, so it resolves a pass later.
  const play = (state: GameState, albusId: string) => {
    const action = castsOf(state, albusId)[0];
    expect(action, "Albus was never enumerated as playable").toBeDefined();
    return castAndResolve(state, action);
  };

  /** The runes channeled by Albus — the ones that came out of the rune deck. */
  const channeledFromDeck = (state: GameState) => state.players[0]!.channeled.filter((r) => r.id.startsWith("deck-"));

  it("channels one EXHAUSTED rune per buff spent, and stops when told to", () => {
    const { state, albusId } = albusState(["Alpha", "Beta"], 3);

    const asked = play(state, albusId);
    expect(pendingDecision(asked)!.kind).toBe("OGN-230-spend");
    expect(offered(asked)).toEqual(["Spend no more buffs", "Spend Alpha's buff", "Spend Beta's buff"]);

    const alpha = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "Spend Alpha's buff")!;
    const oneSpent = answer(asked, alpha.id);

    // Asked again — "any number" is discovered one answer at a time.
    expect(pendingDecision(oneSpent)!.kind).toBe("OGN-230-spend");
    expect(offered(oneSpent)).toEqual(["Spend no more buffs", "Spend Beta's buff"]);

    const after = answer(oneSpent, "stop");

    expect(after.pendingDecisions).toHaveLength(0);
    // Albus himself is standing in base by now, so name the two that were buffed.
    expect(after.players[0]!.baseUnits.filter((u) => u.name !== "Albus Ferros").map((u) => `${u.name}:${u.buffed}`)).toEqual([
      "Alpha:false",
      "Beta:true",
    ]);
    expect(channeledFromDeck(after).map((r) => r.state)).toEqual(["Exhausted"]);
    expect(after.players[0]!.runeDeck).toHaveLength(2);
  });

  it("spends every buff on the board when the player keeps saying yes", () => {
    const { state, albusId } = albusState(["Alpha", "Beta"], 3);

    let current = play(state, albusId);
    // Always take the LAST option — never "stop", which leads.
    for (let guard = 0; guard < 6 && pendingDecision(current); guard += 1) {
      const options = optionsFor(current, pendingDecision(current)!);
      if (options.length === 1) break;
      current = answer(current, options[options.length - 1]!.id);
    }

    expect(current.pendingDecisions, "the repeat never terminated").toHaveLength(0);
    expect(current.players[0]!.baseUnits.every((u) => !u.buffed)).toBe(true);
    expect(channeledFromDeck(current).map((r) => r.state)).toEqual(["Exhausted", "Exhausted"]);
  });

  it("asks nothing when nothing you control is buffed", () => {
    const { state, albusId } = albusState([], 3);

    const after = play(state, albusId);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(channeledFromDeck(after)).toHaveLength(0);
  });

  it("never offers the OPPONENT's buffs — 702.2.b.2 restricts spending to your own", () => {
    const { state, albusId } = albusState(["Mine"], 3);
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs", buffed: true })];

    const asked = play(state, albusId);

    expect(offered(asked)).toEqual(["Spend no more buffs", "Spend Mine's buff"]);
  });

  /**
   * **SETTLED 2026-08-23 — and the row's own citation was the wrong rule.**
   *
   * `rules-conformance.md` carried "Albus Ferros may spend a buff for nothing" as
   * *"**Unverified**, and the most arguable call in the sweep. The text is not
   * '[do X] to [do Y]' cost phrasing, so it reads as an instruction rather than a
   * cost, and 416.3's 'must be able to be completed' therefore does not gate
   * it."* **416 is RECYCLE** — 416.3 is "when Recycling is listed as a Cost…",
   * with Vi, Destructive as its example. It has nothing to say about buffs. The
   * reasoning was reaching for a general costs-must-be-payable principle and
   * grabbed the nearest sentence that sounded like one.
   *
   * Three rules settle it, and they all point the same way as the engine:
   *
   *  - **355.13** — "If a card specifies that a player chooses 'any number' or
   *    'up to' some number of Game Objects to be affected, they may choose any
   *    number of available targets, **including zero**." Nothing bounds the choice
   *    by what the payout can deliver.
   *  - **055** — "When executing card text, do as much as you can, ignoring
   *    impossible instructions", and **055.1** puts it beyond doubt: "**If all of
   *    a card's instructions are impossible, it is still played and resolved, but
   *    nothing happens.**"
   *  - **315.3.b.1** is the same shape for the Channel Phase itself — "if there
   *    are fewer than 2 runes in the Rune Deck, they channel as many as possible".
   *
   * So spending a buff into an empty rune deck is legal and yields nothing. It is
   * a bad play, and the rules do not forbid bad plays.
   */
  it("lets a buff be spent into an EMPTY rune deck, for nothing (055.1 / 355.13)", () => {
    const { state, albusId } = albusState(["Alpha"], 0);
    const asked = play(state, albusId);

    // The offer is made at all — the row's whole question. An engine that gated
    // the spend on the payout would show only "Spend no more buffs" here.
    expect(offered(asked), "the spend was withheld because it could not pay out").toEqual([
      "Spend no more buffs",
      "Spend Alpha's buff",
    ]);

    const alpha = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "Spend Alpha's buff")!;
    const after = answer(asked, alpha.id);

    // The buff is really gone and really bought nothing.
    expect(
      after.players[0]!.baseUnits.find((u) => u.name === "Alpha")!.buffed,
      "the buff was refunded when the channel found nothing",
    ).toBe(false);
    expect(channeledFromDeck(after), "a rune came out of an empty deck").toHaveLength(0);
  });
});

describe("Machine Evangel (OGN-239): [Deathknell] three Recruits into your base", () => {
  it("makes three tokens in the OWNER's base when it dies to a spell", () => {
    // Killed by a real cast rather than a direct destroyUnit call, so the whole
    // path is exercised: chain resolution -> kill funnel -> dispatchOnUnitDied.
    const evangel = realUnitInstance(MACHINE_EVANGEL);
    const vengeance = spellInstance(VENGEANCE);
    const state = makeState({ phase: "Action", activePlayerIndex: 1, focusHolder: 1 });
    state.players[0]!.baseUnits = [evangel];
    state.players[1]!.hand = [vengeance];
    state.players[1]!.channeled = runesFor(VENGEANCE);

    const action = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === vengeance.instanceId && a.targetUnitInstanceId === evangel.instanceId,
    );
    const after = castAndResolve(state, action);

    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Machine Evangel"]);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Recruit", "Recruit", "Recruit"]);
    // Three game objects, not one repeated.
    expect(new Set(after.players[0]!.baseUnits.map((u) => u.instanceId)).size).toBe(3);
    expect(after.players[1]!.baseUnits, "the tokens belong to the Evangel's controller").toHaveLength(0);
  });

  it("sends them home even when it dies at a battlefield — 'into your base'", () => {
    const evangel = realUnitInstance(MACHINE_EVANGEL);
    const vengeance = spellInstance(VENGEANCE);
    const state = makeState({ phase: "Action", activePlayerIndex: 1, focusHolder: 1 });
    state.battlefields[0]!.units = { p1: [evangel] };
    state.players[1]!.hand = [vengeance];
    state.players[1]!.channeled = runesFor(VENGEANCE);

    const action = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === vengeance.instanceId && a.targetUnitInstanceId === evangel.instanceId,
    );
    const after = castAndResolve(state, action);

    expect(after.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Recruit", "Recruit", "Recruit"]);
  });
});

describe("Last Breath (OGN-260): ready a friendly unit, then it swings for its Might", () => {
  /** Last Breath in hand for p1, with `friendly` in base and `enemy` at bf1. */
  function breathState(
    friendly: ReturnType<typeof makeUnit>,
    enemy: ReturnType<typeof makeUnit> | undefined,
  ): { state: GameState; spellId: string } {
    const spell = spellInstance(LAST_BREATH);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(LAST_BREATH);
    state.players[0]!.baseUnits = [friendly];
    if (enemy) state.battlefields[0]!.units = { p2: [enemy] };
    return { state, spellId: spell.instanceId };
  }

  const aimedAt = (state: GameState, spellId: string, friendlyId: string, enemyId: string) =>
    castsOf(state, spellId).find(
      (a) => a.type === "PlayCard" && a.targetUnitInstanceId === friendlyId && a.secondTargetUnitInstanceId === enemyId,
    );

  it("readies the friendly unit AND kills an enemy its Might can reach", () => {
    const friendly = makeUnit({ name: "Yasuo", instanceId: "yasuo", might: 4, exhausted: true });
    const enemy = makeUnit({ name: "Victim", instanceId: "victim", might: 3 });
    const { state, spellId } = breathState(friendly, enemy);

    const after = castAndResolve(state, aimedAt(state, spellId, "yasuo", "victim"));

    // Both halves. Either alone would pass with the card half-written.
    expect(after.players[0]!.baseUnits[0]!.exhausted, "the ready never happened").toBe(false);
    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Victim"]);
  });

  it("deals exactly its Might — a tougher enemy survives with damage marked", () => {
    const friendly = makeUnit({ name: "Yasuo", instanceId: "yasuo", might: 2, exhausted: true });
    const enemy = makeUnit({ name: "Tank", instanceId: "victim", might: 5 });
    const { state, spellId } = breathState(friendly, enemy);

    const after = castAndResolve(state, aimedAt(state, spellId, "yasuo", "victim"));

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(2);
  });

  it("counts a buff in the Might it swings for", () => {
    // effectiveMight rather than printed Might, the same read Gentlemen's Duel
    // takes: a buffed 2-Might unit kills a 3-Might enemy.
    const friendly = makeUnit({ name: "Yasuo", instanceId: "yasuo", might: 2, buffed: true });
    const enemy = makeUnit({ name: "Victim", instanceId: "victim", might: 3 });
    const { state, spellId } = breathState(friendly, enemy);

    const after = castAndResolve(state, aimedAt(state, spellId, "yasuo", "victim"));

    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Victim"]);
  });

  it("is not castable at all with no enemy at a battlefield — 355.8, both slots are targets", () => {
    // `min: 2`. An enemy sheltering in their own BASE is not a legal second
    // target either, which is the other half of the slot-scope split.
    const friendly = makeUnit({ name: "Yasuo", instanceId: "yasuo", might: 4 });
    const { state, spellId } = breathState(friendly, undefined);
    state.players[1]!.baseUnits = [makeUnit({ name: "AtHome", instanceId: "athome" })];

    expect(castsOf(state, spellId)).toEqual([]);
  });

  it("still offers a friendly unit standing at a battlefield — slot 0 is 'anywhere'", () => {
    // The scopes differ per slot and both directions matter: the friendly may be
    // anywhere, the enemy may not.
    const friendly = makeUnit({ name: "Yasuo", instanceId: "yasuo", might: 4 });
    const enemy = makeUnit({ name: "Victim", instanceId: "victim", might: 3 });
    const { state, spellId } = breathState(friendly, enemy);
    state.players[0]!.baseUnits = [];
    state.battlefields[1]!.units = { p1: [friendly] };

    expect(aimedAt(state, spellId, "yasuo", "victim"), "a friendly at another battlefield was not offered").toBeDefined();
  });
});

describe("coverage", () => {
  it("reports the five newly-landed cards as implemented", () => {
    for (const id of [KINGS_EDICT, SPECTRAL_MATRON, ALBUS_FERROS, MACHINE_EVANGEL, LAST_BREATH]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name}`).toBe(true);
    }
  });
});
