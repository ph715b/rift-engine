import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState, PendingDecision } from "../src/model/game-state.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import { answerDecisions, beginCombatAt, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The Unleashed cards implemented in effects/chaos.ts.
 *
 * Everything here drives the REAL path — `legalActions` to find the action,
 * `submit` to take it, `resolveHeldTriggers` for the chain, `answerDecisions` for
 * the questions — rather than calling a resolver directly. That hop is what has
 * broken repeatedly in this codebase: a card can be written, typechecked and
 * unreachable at the same time, and an inert card is indistinguishable from a
 * working one in play.
 *
 * Every assertion below was made to FAIL by commenting out its registry entry
 * before being kept.
 */

const registry = defaultCardRegistry();

const BEWITCHING_SPIRIT = "UNL-121";
const EVERSHADE_STALKER = "UNL-123";
const ISOLATE = "UNL-124";
const LUNAR_BOON = "UNL-125";
const VICIOUS_SNAPJAWS = "UNL-129";
const ANGLER_BEAST = "UNL-132";
const SINISTER_PORO = "UNL-137";
/** Jinx - Rebel, "when you discard ONE OR MORE cards, ready me and give me +1
 *  Might this turn" — the instrument that can see a per-card discard event, since
 *  she pays out once per INSTRUCTION and twice if the event double-fires. */
const JINX_REBEL = "OGN-202";
/** Hextech Ray, "[Action] Deal 3 to a unit at a battlefield" — no owner
 *  restriction, so it is the pool's way to kill one of your OWN units through a
 *  real spell play rather than by calling `destroyUnit` directly. */
const HEXTECH_RAY = "OGN-009";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/**
 * Answers every question and THEN pops the chain again.
 *
 * `cardsDiscarded` is HELD (383), and the discard that fires it is itself the
 * answer to a question — so a test that stops at `answerDecisions` is looking a
 * full chain-pop too early. Measured: the two Jinx - Rebel probes below reported
 * "Jinx never saw the discard at all" against working code until this existed,
 * which is exactly the shape of instrument defect this file's header warns about.
 */
const settleAfterAnswers = (state: GameState, pick?: Parameters<typeof answerDecisions>[1]): GameState =>
  resolveHeldTriggers(answerDecisions(state, pick));

/** Pops whatever is on the chain: both players pass, then the held triggers settle. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 6 && next.spellChain.length > 0; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  return resolveHeldTriggers(next);
}

/** The enumerated play of one card in hand, optionally at one target. */
function playOf(state: GameState, card: CardInstance, targetUnitInstanceId?: string): unknown {
  const action = legalActions(state).find(
    (a) =>
      a.type === "PlayCard" &&
      a.card.instanceId === card.instanceId &&
      (targetUnitInstanceId === undefined ||
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === targetUnitInstanceId),
  );
  expect(action, `${card.name} was never enumerated`).toBeDefined();
  return action!;
}

/** A board with the caster holding enough of everything to play any of these. */
function casterState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Chaos: 9, Fury: 9 };
  return state;
}

const at = (state: GameState, battlefieldId: string, playerId: "p1" | "p2"): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const unitsInPlay = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])]),
];

const findAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  unitsInPlay(state).find((u) => u.instanceId === instanceId);

const names = (cards: readonly CardInstance[]): string[] => cards.map((c) => c.name).sort();

describe("Evershade Stalker (UNL-123): discard 1, then draw 1", () => {
  /** The Stalker in hand with two spare cards to pick a discard from, and a
   *  named card on top of the deck so the draw is identifiable. */
  function stalkerState(): { state: GameState; stalker: UnitInstance } {
    const stalker = realUnitInstance(EVERSHADE_STALKER);
    const state = casterState();
    state.players[0]!.hand = [stalker, makeUnit({ name: "HandA" }), makeUnit({ name: "HandB" })];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return { state, stalker };
  }

  it("discards one and draws one through a REAL PlayCard", () => {
    const { state, stalker } = stalkerState();

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, stalker))));

    // One of the two spares went to the trash, and the top of the deck arrived.
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["HandA"]);
    expect(after.players[0]!.hand.map((c) => c.name).sort()).toEqual(["Drawn", "HandB"]);
    expect(after.players[0]!.deck, "the draw never happened").toHaveLength(0);
  });

  it("draws AFTER the discard — the card just drawn is never a discard candidate", () => {
    // The whole reason this is `discardThenDraw` rather than a draw wrapped round
    // a discard: the question is answered from the hand as it stood BEFORE the
    // draw. Answering "Drawn" would be possible only if the order had inverted.
    const { state, stalker } = stalkerState();

    const asked = resolveHeldTriggers(accept(state, playOf(state, stalker)));
    const decision = pendingDecision(asked);
    expect(decision?.kind, "the discard never stopped to ask").toBe("discard");
    const after = answerDecisions(asked, (options) => {
      expect(options.map((o) => o.label).sort(), "the freshly drawn card was offered as a discard").toEqual([
        "HandA",
        "HandB",
      ]);
      return options[0]!.id;
    });
    expect(after.players[0]!.hand.map((c) => c.name)).toContain("Drawn");
  });

  it("fires `cardsDiscarded` ONCE for the instruction, not once per card", () => {
    // Jinx - Rebel readies and pumps +1 per discard INSTRUCTION. A batch event
    // fired per item would show up here as +2 Might, which is the shape this
    // codebase double-pays in.
    const { state, stalker } = stalkerState();
    const jinx = { ...realUnitInstance(JINX_REBEL), exhausted: true };
    state.players[0]!.baseUnits = [jinx];

    const after = settleAfterAnswers(resolveHeldTriggers(accept(state, playOf(state, stalker))));

    const live = findAnywhere(after, jinx.instanceId)!;
    expect(live.exhausted, "Jinx never saw the discard at all").toBe(false);
    expect(live.mightThisTurn, "the discard event paid out twice").toBe(1);
  });
});

describe("Lunar Boon (UNL-125): [Reaction] discard 1, then draw 2", () => {
  function boonState(): { state: GameState; boon: CardInstance } {
    const boon = spellInstance(LUNAR_BOON);
    const state = casterState();
    state.players[0]!.hand = [boon, makeUnit({ name: "HandA" }), makeUnit({ name: "HandB" })];
    state.players[0]!.deck = [makeUnit({ name: "Drawn1" }), makeUnit({ name: "Drawn2" })];
    return { state, boon };
  }

  it("discards one and draws two through a REAL cast", () => {
    const { state, boon } = boonState();

    const after = answerDecisions(resolveChain(accept(state, playOf(state, boon))));

    expect(names(after.players[0]!.trash), "the spell or the discard went missing").toEqual(["HandA", "Lunar Boon"]);
    expect(names(after.players[0]!.hand)).toEqual(["Drawn1", "Drawn2", "HandB"]);
  });

  it("draws AFTER the discard — neither drawn card is offered as a discard", () => {
    const { state, boon } = boonState();

    const asked = resolveChain(accept(state, playOf(state, boon)));
    expect(pendingDecision(asked)?.kind, "the discard never stopped to ask").toBe("discard");
    answerDecisions(asked, (options) => {
      expect(options.map((o) => o.label).sort()).toEqual(["HandA", "HandB"]);
      return options[0]!.id;
    });
  });

  it("fires `cardsDiscarded` ONCE for the instruction", () => {
    const { state, boon } = boonState();
    const jinx = { ...realUnitInstance(JINX_REBEL), exhausted: true };
    state.players[0]!.baseUnits = [jinx];

    const after = settleAfterAnswers(resolveChain(accept(state, playOf(state, boon))));

    const live = findAnywhere(after, jinx.instanceId)!;
    expect(live.exhausted, "Jinx never saw the discard at all").toBe(false);
    expect(live.mightThisTurn, "the discard event paid out twice").toBe(1);
  });
});

describe("Bewitching Spirit (UNL-121): choose a player, they discard 1", () => {
  /** The Spirit in hand, and TWO cards in each player's hand so that whoever is
   *  chosen has a real choice to make and the discard is visible either way. */
  function spiritState(): { state: GameState; spirit: UnitInstance } {
    const spirit = realUnitInstance(BEWITCHING_SPIRIT);
    const state = casterState();
    state.players[0]!.hand = [spirit, makeUnit({ name: "MineA" }), makeUnit({ name: "MineB" })];
    state.players[1]!.hand = [makeUnit({ name: "TheirsA" }), makeUnit({ name: "TheirsB" })];
    return { state, spirit };
  }

  /** Answers the choose-a-player question with `index`, then everything behind it. */
  const chooseSeat = (state: GameState, index: 0 | 1) =>
    answerDecisions(state, (options, decision: PendingDecision) =>
      decision.kind === "UNL-121-discard" ? String(index) : options[0]!.id,
    );

  it("makes the OPPONENT discard when they are chosen", () => {
    const { state, spirit } = spiritState();

    const after = chooseSeat(resolveHeldTriggers(accept(state, playOf(state, spirit))), 1);

    expect(after.players[1]!.trash.map((c) => c.name), "the opponent discarded nothing").toEqual(["TheirsA"]);
    expect(after.players[1]!.hand).toHaveLength(1);
    expect(after.players[0]!.trash, "the caster discarded as well").toHaveLength(0);
  });

  it("makes the CASTER discard when they choose themselves — 'a player', not 'an opponent'", () => {
    // The half that separates this card from Mindsplitter. A hard-coded
    // `opponentIndex` passes the test above and fails this one.
    const { state, spirit } = spiritState();

    const after = chooseSeat(resolveHeldTriggers(accept(state, playOf(state, spirit))), 0);

    expect(after.players[0]!.trash.map((c) => c.name), "the caster discarded nothing").toEqual(["MineA"]);
    expect(after.players[1]!.trash, "the opponent discarded anyway").toHaveLength(0);
  });

  it("offers exactly two seats, opponent first", () => {
    const { state, spirit } = spiritState();

    // TWO options, so it genuinely prompts rather than being executed as a
    // formality — the difference from Mindsplitter's "an opponent", which reduces
    // to one. The opponent leads so that a mis-click and the AI's tie-break land
    // on the ordinary answer.
    const asked = resolveHeldTriggers(accept(state, playOf(state, spirit)));
    const decision = pendingDecision(asked);
    expect(decision?.kind, "the Spirit never asked").toBe("UNL-121-discard");
    expect(optionsFor(asked, decision!).map((o) => o.id)).toEqual(["1", "0"]);
  });
});

describe("Vicious Snapjaws (UNL-129): 1 XP per OTHER friendly unit that dies", () => {
  /** Snapjaws and a doomed 1-Might ally at bf1, with a Hextech Ray in hand to
   *  kill through the real spell path. */
  function snapjawsState(): { state: GameState; snapjaws: UnitInstance; ally: UnitInstance; ray: CardInstance } {
    const snapjaws = realUnitInstance(VICIOUS_SNAPJAWS);
    const ally = makeUnit({ name: "Ally", might: 1 });
    const ray = spellInstance(HEXTECH_RAY);
    const state = casterState();
    state.battlefields[0]!.units = { p1: [snapjaws, ally] };
    state.players[0]!.hand = [ray];
    return { state, snapjaws, ally, ray };
  }

  it("gains 1 XP when a friendly unit is killed by a REAL spell", () => {
    const { state, ally, ray } = snapjawsState();
    expect(state.players[0]!.xp).toBe(0);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, ray, ally.instanceId))));

    expect(findAnywhere(after, ally.instanceId), "the ally survived — this fixture killed nothing").toBeUndefined();
    expect(after.players[0]!.xp, "the Snapjaws gained no XP").toBe(1);
  });

  /** The positive board, run again — the control that stops the two negatives
   *  below from passing merely because the card does nothing at all. */
  function xpFromAFriendlyDeath(): number {
    const { state, ally, ray } = snapjawsState();
    return answerDecisions(resolveChain(accept(state, playOf(state, ray, ally.instanceId)))).players[0]!.xp;
  }

  it("gains nothing for his OWN death — 'ANOTHER friendly unit'", () => {
    expect(xpFromAFriendlyDeath(), "the control board paid nothing either").toBe(1);
    // Hextech Ray deals 3, so the Snapjaws needs shrinking to 3 Might to die to
    // it. His printed 5 is irrelevant to the clause under test.
    const { state, snapjaws, ray } = snapjawsState();
    state.battlefields[0]!.units = { p1: [{ ...snapjaws, might: 3 }] };

    const after = answerDecisions(resolveChain(accept(state, playOf(state, ray, snapjaws.instanceId))));

    expect(findAnywhere(after, snapjaws.instanceId), "he survived — this is not a death").toBeUndefined();
    expect(after.players[0]!.xp, "he paid out on his own death").toBe(0);
  });

  it("gains nothing for an ENEMY unit dying — 'FRIENDLY'", () => {
    expect(xpFromAFriendlyDeath(), "the control board paid nothing either").toBe(1);
    const { state, ray } = snapjawsState();
    const enemy = makeUnit({ name: "Enemy", might: 1 });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [enemy] };

    const after = answerDecisions(resolveChain(accept(state, playOf(state, ray, enemy.instanceId))));

    expect(findAnywhere(after, enemy.instanceId), "the enemy survived").toBeUndefined();
    expect(after.players[0]!.xp, "he paid out for the opponent's loss").toBe(0);
  });
});

describe("Angler Beast (UNL-132): return ALL units with 2 Might or less", () => {
  it("clears both sides, both bases and both battlefields — and spares 3 Might", () => {
    const beast = realUnitInstance(ANGLER_BEAST);
    const state = casterState();
    state.players[0]!.hand = [beast];
    state.players[0]!.baseUnits = [makeUnit({ name: "MyHome1", might: 1 })];
    state.players[1]!.baseUnits = [makeUnit({ name: "TheirHome2", might: 2 })];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "MyFront3", might: 3 })],
      p2: [makeUnit({ name: "TheirFront1", might: 1 })],
    };

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, beast))));

    expect(names(after.players[0]!.hand), "the caster's small units are still standing").toEqual(["MyHome1"]);
    expect(names(after.players[1]!.hand), "to their OWNER's hand, not the caster's").toEqual([
      "TheirFront1",
      "TheirHome2",
    ]);
    expect(unitsInPlay(after).map((u) => u.name).sort(), "the 3-Might unit was swept too").toEqual([
      "Angler Beast",
      "MyFront3",
    ]);
  });

  it("reads EFFECTIVE Might, not printed", () => {
    // A printed 1 pumped to 3 survives; a printed 4 shrunk to 1 does not.
    // `unit.might` alone gets both of these backwards.
    const beast = realUnitInstance(ANGLER_BEAST);
    const state = casterState();
    state.players[0]!.hand = [beast];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Pumped", might: 1, mightThisTurn: 2 })],
      p2: [makeUnit({ name: "Shrunk", might: 4, mightThisTurn: -3 })],
    };

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, beast))));

    expect(names(after.players[1]!.hand), "the shrunk 4-Might unit stayed").toEqual(["Shrunk"]);
    expect(at(after, "bf1", "p1").map((u) => u.name), "the pumped 1-Might unit was swept").toEqual(["Pumped"]);
  });

  it("strips a Buff on the way out — rule 705", () => {
    const beast = realUnitInstance(ANGLER_BEAST);
    const state = casterState();
    state.players[0]!.hand = [beast];
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Buffed", might: 1, buffed: true, damage: 1 })] };

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, beast))));

    const returned = after.players[1]!.hand.find((c) => c.name === "Buffed") as UnitInstance;
    expect(returned, "nothing came back").toBeDefined();
    expect(returned.buffed).toBe(false);
    expect(returned.damage).toBe(0);
  });
});

describe("Isolate (UNL-124): send an enemy unit home, then draw if one is left alone", () => {
  /** `enemies` enemy units at bf1, plus one of the caster's own standing there —
   *  which must NOT count toward "alone", since "alone" is measured in units
   *  friendly to the ENEMY. */
  function isolateState(enemies: number): { state: GameState; isolate: CardInstance; targets: UnitInstance[] } {
    const isolate = spellInstance(ISOLATE);
    const targets = Array.from({ length: enemies }, (_, i) => makeUnit({ name: `Enemy${i + 1}`, might: 2 }));
    const state = casterState();
    state.players[0]!.hand = [isolate];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine" })], p2: targets };
    return { state, isolate, targets };
  }

  it("moves the chosen enemy to its base", () => {
    const { state, isolate, targets } = isolateState(2);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, isolate, targets[0]!.instanceId))));

    expect(at(after, "bf1", "p2").map((u) => u.name), "the target never left").toEqual(["Enemy2"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Enemy1"]);
    // A MOVE, not a Recall (454) — Fight or Flight's reading of the same sentence.
    expect(after.players[1]!.baseUnits[0]!.exhausted, "it arrived home ready").toBe(true);
  });

  it("draws when exactly ONE enemy unit is left at that battlefield", () => {
    // The caster's own unit is standing there too and must not spoil it: "alone"
    // counts units friendly to the ENEMY.
    const { state, isolate, targets } = isolateState(2);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, isolate, targets[0]!.instanceId))));

    expect(after.players[0]!.hand.map((c) => c.name), "the draw never happened").toEqual(["Drawn"]);
  });

  it("draws NOTHING when two enemies are left — 'alone' is a real condition", () => {
    const { state, isolate, targets } = isolateState(3);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, isolate, targets[0]!.instanceId))));

    expect(at(after, "bf1", "p2"), "the move itself did not happen").toHaveLength(2);
    expect(after.players[0]!.hand, "it drew off a crowded battlefield").toHaveLength(0);
  });

  it("draws NOTHING when the battlefield is emptied of enemies", () => {
    // One enemy, moved home: nobody is left, so there is no "enemy unit alone"
    // there. Zero is not one.
    const { state, isolate, targets } = isolateState(1);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, isolate, targets[0]!.instanceId))));

    expect(at(after, "bf1", "p2")).toHaveLength(0);
    expect(after.players[0]!.hand, "it drew off an empty battlefield").toHaveLength(0);
  });
});

describe("Sinister Poro (UNL-137): when I attack, pay 1 Energy to send an enemy home", () => {
  /**
   * The Poro attacking at bf1 against one enemy, with `energy` in the pool.
   *
   * Contested by p0 is what makes him the ATTACKER (465), and `beginCombatAt`
   * stages the Showdown through the real Cleanup — so the designations his
   * trigger waits on are handed out the way a game hands them out.
   */
  function poroState(energy: number, contestedBy: 0 | 1 = 0): { state: GameState; poro: UnitInstance; enemy: UnitInstance } {
    const poro = realUnitInstance(SINISTER_PORO);
    const enemy = makeUnit({ name: "Enemy", might: 4 });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.floatingEnergy = energy;
    state.battlefields[0]!.units = { p1: [poro], p2: [enemy] };
    return { state: beginCombatAt(state, "bf1", contestedBy), poro, enemy };
  }

  it("sends an enemy unit home for 1 Energy, before combat damage", () => {
    const { state, enemy } = poroState(1);

    const decision = pendingDecision(state);
    expect(decision?.kind, "the attack trigger never asked").toBe("UNL-137-move");

    const after = answerDecisions(state, (options) => options.find((o) => o.instanceId === enemy.instanceId)!.id);

    expect(at(after, "bf1", "p2"), "the enemy is still in the fight").toHaveLength(0);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Enemy"]);
    expect(after.players[0]!.floatingEnergy, "the Energy was never spent").toBe(0);
  });

  it("can be declined, and then nothing is paid", () => {
    const { state } = poroState(1);
    expect(pendingDecision(state)?.kind, "the offer was never made, so declining proves nothing").toBe("UNL-137-move");

    const after = answerDecisions(state, (options) => options.find((o) => o.id === "decline")!.id);

    expect(at(after, "bf1", "p2"), "the enemy went home despite the decline").toHaveLength(1);
    expect(after.players[0]!.floatingEnergy, "declining still charged 1 Energy").toBe(1);
  });

  it("never asks when the Energy cannot be paid — 416.3", () => {
    // Paired with its own POSITIVE control: an empty pool must be the ONLY
    // difference between the two boards, or "nothing was asked" would also be
    // what an unregistered trigger looks like.
    expect(pendingDecision(poroState(1).state)?.kind, "the control board never asked either").toBe("UNL-137-move");

    const { state } = poroState(0);

    expect(pendingDecision(state), "an unaffordable offer was made anyway").toBeUndefined();
    expect(at(state, "bf1", "p2"), "an unaffordable offer moved something").toHaveLength(1);
  });

  it("never asks when he is DEFENDING — 'when I ATTACK'", () => {
    // Same pairing: the attacking board is the positive control for the same
    // fixture, so an inert card fails here instead of passing quietly.
    expect(pendingDecision(poroState(1, 0).state)?.kind, "the attacking control never asked").toBe("UNL-137-move");

    const { state } = poroState(1, 1);

    expect(pendingDecision(state), "a defending Poro was offered his attack trigger").toBeUndefined();
  });
});

describe("coverage", () => {
  /**
   * **This gate is WEAKER than it looks for two of the seven, measured.**
   * `decisionDefIds` derives a defId from every decision KEY, so
   * `"UNL-121-discard"` and `"UNL-137-move"` each claim their card on their own:
   * deleting Bewitching Spirit's unit trigger or Sinister Poro's event trigger
   * leaves this test green. The behavioural tests above are what actually catch
   * that, and both were confirmed to go red for it.
   */
  it("reports this batch as implemented", () => {
    const batch = [BEWITCHING_SPIRIT, EVERSHADE_STALKER, ISOLATE, LUNAR_BOON, VICIOUS_SNAPJAWS, ANGLER_BEAST, SINISTER_PORO];
    expect(batch.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });

  it("does NOT claim Crescent Guardian (UNL-122), which is refused", () => {
    // Its optional additional cost, the "you've played a spell this turn"
    // condition on that cost, and the "if you do, I enter ready" that reads the
    // flag all live in files this wave does not own. A coverage claim without
    // them would report a card that does nothing.
    expect(isCardImplemented(registry.get("UNL-122"))).toBe(false);
  });
});
