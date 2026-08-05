import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { executeMoveUnit } from "../src/actions/execute-move-unit.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { deflectSurcharge } from "../src/engine/granted-keywords.js";
import { addBuff } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision, type DecisionOption } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { SpellInstance, UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  beginCombatAt,
  makePlayer,
  makeState,
  makeUnit,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Spiritforged (SFD) cards owned by `src/engine/effects/body.ts`.
 *
 * **Nothing here calls a resolver closure.** Every card is driven the way a game
 * drives it — `legalActions` -> `executePlayCard` for the plays, `executeMoveUnit`
 * for Kato, `resolveShowdown` and `beginCombatAt` for the combat triggers — and
 * then through `resolveHeldTriggers`/`answerDecisions`, because a trigger is a
 * Chain Pending Item and a question is a queue entry. That is deliberate: this
 * codebase has twice shipped a card that was registered, reachable by name and
 * silently never fired, because the dispatch hop dropped it. A test that reached
 * past the hop would have passed both times.
 *
 * Each assertion is on the BOARD after the fact (a hand size, a Might, marked
 * damage, a Deflect surcharge), never on a function having been called.
 */

const registry = defaultCardRegistry();

const BUHRU_CAPTAIN = "SFD-091"; // "you may draw 1 or buff me"
const PUNCH_FIRST = "SFD-097"; // "Give a unit +5 Might this turn"
const SHOW_OF_STRENGTH = "SFD-106"; // "Draw 1 for each of your [Mighty] units"
const FIORA_PEERLESS = "SFD-110"; // "double my Might this combat"
const KATO_THE_ARM = "SFD-112"; // "give another friendly unit my keywords and +Might"
const SIVIR_AMBITIOUS = "SFD-120"; // "you may deal that much to an enemy unit"

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain, state });
const bodyRunes = (n: number) => Array.from({ length: n }, (_, i) => rune(`r${i}`, "Body"));
const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

/** A caster holding `card` with plenty of Body runes and a deck to draw from. */
function holding(card: SpellInstance | UnitInstance, deckSize = 6, extra: Partial<GameState> = {}): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [card],
        deck: Array.from({ length: deckSize }, () => spellInstance(PUNCH_FIRST)),
        channeled: bodyRunes(12),
      }),
      makePlayer("p2"),
    ],
    ...extra,
  });
}

/** The enumerated plays of one card — the real fan-out, so a card the enumerator
 *  refuses shows up here as an empty list rather than as a passing test. */
const playsOf = (state: GameState, card: { instanceId: string }) =>
  legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);

/** Plays `card` through the real executor and settles the chain and the queue. */
function play(state: GameState, card: { instanceId: string }, pick?: (options: DecisionOption[]) => string): GameState {
  const action = playsOf(state, card)[0];
  expect(action, "the enumerator offered no play for this card").toBeDefined();
  return answerDecisions(resolveHeldTriggers(executePlayCard(state, action as never)), pick);
}

describe("Punch First (SFD-097): give a unit +5 Might this turn", () => {
  it("adds 5 to a unit at a battlefield", () => {
    const target = makeUnit({ instanceId: "target", might: 2 });
    const card = spellInstance(PUNCH_FIRST);
    const state = holding(card);
    state.battlefields[0]!.units = { p1: [target] };

    // The target rides on the enumerated action, so this exercises the whole
    // announce path rather than a hand-built event.
    const action = playsOf(state, card).find(
      (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "target",
    );
    expect(action, "no play variant targeted the unit").toBeDefined();
    const after = answerDecisions(resolveHeldTriggers(executePlayCard(state, action as never)));

    const hit = after.battlefields[0]!.units["p1"]![0]!;
    expect(hit.mightThisTurn).toBe(5);
    expect(effectiveMight(after, hit, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(7);
  });

  it("reaches a unit in BASE — 'a unit' names no battlefield (355.9.b)", () => {
    // The whole difference between Primal Strength's scope and Incinerate's. A
    // battlefield-scoped spec would offer no variant at all here.
    const card = spellInstance(PUNCH_FIRST);
    const state = holding(card);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "homebody", might: 1 })];

    const after = play(state, card);
    expect(after.players[0]!.baseUnits[0]!.mightThisTurn).toBe(5);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PUNCH_FIRST))).toBe(true);
  });
});

describe("Show of Strength (SFD-106): draw 1 per Mighty unit", () => {
  /** `mights` friendly units, and one 9-Might ENEMY that must not be counted. */
  function board(mights: number[]): { state: GameState; card: SpellInstance } {
    const card = spellInstance(SHOW_OF_STRENGTH);
    const state = holding(card);
    state.battlefields[0]!.units = {
      p1: mights.map((might, i) => makeUnit({ instanceId: `mine-${i}`, might })),
      p2: [makeUnit({ instanceId: "theirs", might: 9 })],
    };
    return { state, card };
  }

  const handAfter = (mights: number[]) => {
    const { state, card } = board(mights);
    const before = state.players[0]!.hand.length - 1; // the card itself leaves hand
    return play(state, card).players[0]!.hand.length - before;
  };

  it("draws nothing when nothing is Mighty — the negative control", () => {
    // 4 is one short of rule 711's threshold, and the enemy's 9 is not "yours".
    expect(handAfter([4, 4])).toBe(0);
  });

  it("draws one per unit at 5+ Might", () => {
    expect(handAfter([5, 7, 2])).toBe(2);
  });

  it("counts a unit made Mighty by a BUFF, not just printed Might", () => {
    // Rule 711 asks about CURRENT Might, which is why this goes through
    // `isMighty` rather than a `>= 5` on the printed value. A 4-Might body with a
    // buff is Mighty (710) and a printed comparison would miss it.
    const card = spellInstance(SHOW_OF_STRENGTH);
    let state = holding(card);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "nearly", might: 4 })] };
    state = addBuff(state, "nearly");
    const before = state.players[0]!.hand.length - 1;

    expect(play(state, card).players[0]!.hand.length - before).toBe(1);
  });

  it("counts units in BASE too — nothing here is positional", () => {
    const card = spellInstance(SHOW_OF_STRENGTH);
    const state = holding(card);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", might: 6 })];
    const before = state.players[0]!.hand.length - 1;

    expect(play(state, card).players[0]!.hand.length - before).toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SHOW_OF_STRENGTH))).toBe(true);
  });
});

describe("Buhru Captain (SFD-091): you may draw 1 or buff me", () => {
  const captainState = () => {
    const captain = realUnitInstance(BUHRU_CAPTAIN);
    return { captain, state: holding(captain) };
  };

  const captainIn = (state: GameState) => state.players[0]!.baseUnits.find((u) => u.defId === BUHRU_CAPTAIN)!;

  it("asks the question when he lands", () => {
    const { captain, state } = captainState();
    const asked = resolveHeldTriggers(executePlayCard(state, playsOf(state, captain)[0]! as never));
    expect(pendingDecision(asked)?.kind).toBe("SFD-091-choose");
    expect(optionIds(asked)).toEqual(["decline", "draw", "buff"]);
  });

  it("draws 1 when the draw is chosen", () => {
    const { captain, state } = captainState();
    const before = state.players[0]!.hand.length - 1;
    const after = play(state, captain, choose("draw"));
    expect(after.players[0]!.hand.length - before).toBe(1);
    expect(captainIn(after).buffed).toBe(false); // ...and only one of the two
  });

  it("buffs HIM when the buff is chosen", () => {
    const { captain, state } = captainState();
    const before = state.players[0]!.hand.length - 1;
    const after = play(state, captain, choose("buff"));
    expect(captainIn(after).buffed).toBe(true);
    expect(effectiveMight(after, captainIn(after), 0, { isCombat: false })).toBe(4); // 3 printed + the buff (710)
    expect(after.players[0]!.hand.length - before).toBe(0);
  });

  it("does neither when declined — the printed 'you MAY'", () => {
    // The question has to be SEEN before it is declined, or this test passes
    // just as happily against a Captain that was never registered at all —
    // measured, with his entry disabled it did.
    const { captain, state } = captainState();
    const before = state.players[0]!.hand.length - 1;
    const asked = resolveHeldTriggers(executePlayCard(state, playsOf(state, captain)[0]! as never));
    expect(pendingDecision(asked)?.kind).toBe("SFD-091-choose");

    const after = answerDecisions(asked, choose("decline"));
    expect(after.players[0]!.hand.length - before).toBe(0);
    expect(captainIn(after).buffed).toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BUHRU_CAPTAIN))).toBe(true);
  });
});

describe("Fiora - Peerless (SFD-110): double my Might one on one", () => {
  /** Fiora at bf1 with `friends` companions against `foes` enemies. */
  function duelState(friends: number, foes: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [
        { ...realUnitInstance(FIORA_PEERLESS), instanceId: "fiora" },
        ...Array.from({ length: friends }, (_, i) => makeUnit({ instanceId: `friend-${i}`, might: 1 })),
      ],
      p2: Array.from({ length: foes }, (_, i) => makeUnit({ instanceId: `foe-${i}`, might: 1 })),
    };
    return state;
  }

  const fioraAt = (state: GameState) => state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "fiora")!;

  it("doubles her Might when both sides are alone", () => {
    // She prints 3, so the gift is +3 and she fights at 6.
    const after = beginCombatAt(duelState(0, 1), "bf1", 0);
    expect(fioraAt(after).mightThisTurn).toBe(3);
    expect(effectiveMight(after, fioraAt(after), 0, { isCombat: false, battlefieldId: "bf1" })).toBe(6);
  });

  it("fires while DEFENDING too — the attacker index is not hers", () => {
    const after = beginCombatAt(duelState(0, 1), "bf1", 1);
    expect(fioraAt(after).mightThisTurn).toBe(3);
  });

  it("does NOT fire with a friend beside her — she is not alone", () => {
    // The negative control that makes "one on one" mean something: without the
    // count on her own side this would be "double my Might whenever I fight".
    expect(fioraAt(beginCombatAt(duelState(1, 1), "bf1", 0)).mightThisTurn).toBe(0);
  });

  it("does NOT fire against two enemies — the enemy must be alone as well", () => {
    expect(fioraAt(beginCombatAt(duelState(0, 2), "bf1", 0)).mightThisTurn).toBe(0);
  });

  it("the doubling reaches the DAMAGE — she beats a 5-Might defender she would lose to", () => {
    // The end-to-end control, and the one that proves the trigger lands before
    // the Combat Damage Step rather than merely writing a number somewhere. A
    // 3-Might Fiora into a 5-Might body dies and leaves it standing; doubled to
    // 6 she kills it and survives on 5 damage.
    const state = duelState(0, 1);
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "foe-0", might: 5 })];

    const fought = resolveShowdown(beginCombatAt(state, "bf1", 0), "bf1", 0);
    expect(fought.battlefields[0]!.units["p2"] ?? [], "the 5-Might defender should be dead").toHaveLength(0);
    expect(fought.battlefields[0]!.units["p1"]!.map((u) => u.instanceId)).toEqual(["fiora"]);
  });

  it("doubles the CURRENT Might, buff and all", () => {
    // "Double my Might" is read at resolution off `effectiveMight`, so a buff
    // already on her is doubled with the rest. 3 printed + 1 buff = 4, so +4.
    let state = duelState(0, 1);
    state = addBuff(state, "fiora");
    const after = beginCombatAt(state, "bf1", 0);
    expect(fioraAt(after).mightThisTurn).toBe(4);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(FIORA_PEERLESS))).toBe(true);
  });
});

describe("Kato the Arm (SFD-112): hand over my keywords and my Might", () => {
  /** Kato in base with a companion at bf2, ready to walk to bf2. */
  function katoState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(KATO_THE_ARM), instanceId: "kato" }];
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "buddy", might: 2 })] };
    return state;
  }

  /** A real MoveUnit through the executor, then the held trigger and the question. */
  const walk = (state: GameState, pick?: (options: DecisionOption[]) => string) =>
    answerDecisions(
      resolveHeldTriggers(
        executeMoveUnit(state, {
          type: "MoveUnit",
          playerIndex: 0,
          unitInstanceIds: ["kato"],
          destinationBattlefieldId: "bf2",
        }),
      ),
      pick,
    );

  const buddyIn = (state: GameState) => state.battlefields[1]!.units["p1"]!.find((u) => u.instanceId === "buddy")!;

  it("gives the chosen unit +Might equal to Kato's", () => {
    // Kato prints 3 Might, so his companion gains exactly 3 for the turn.
    expect(buddyIn(walk(katoState(), choose("buddy"))).mightThisTurn).toBe(3);
  });

  it("gives it [Deflect] — and the surcharge is real, not just a flag", () => {
    // The measurement that matters. `grantKeywordThisTurn` writes to
    // `keywordsThisTurn`, and the only thing that makes that a KEYWORD rather
    // than a note is that the Deflect pricing reads it: an opponent now owes 1
    // rainbow Power to choose the companion, and owed 0 a moment ago.
    const before = katoState();
    expect(deflectSurcharge(before, buddyIn(before), 0, 1)).toBe(0);

    const after = walk(before, choose("buddy"));
    expect(after.battlefields[1]!.units["p1"]!.find((u) => u.instanceId === "buddy")!.keywordsThisTurn["Deflect"]).toBe(1);
    expect(deflectSurcharge(after, buddyIn(after), 0, 1)).toBe(1);
    expect(deflectSurcharge(after, buddyIn(after), 0, 0), "Deflect taxes OPPONENTS only").toBe(0);
  });

  it("does not offer KATO himself — 'ANOTHER friendly unit'", () => {
    // A SECOND companion is what makes this observable at all: with one
    // candidate the question has a single option and `advanceDecisions` executes
    // it without ever showing it, so the only way to read the offered list is to
    // give the player a genuine choice.
    const state = katoState();
    state.players[0]!.baseUnits.push(makeUnit({ instanceId: "spare", might: 1 }));
    const asked = resolveHeldTriggers(
      executeMoveUnit(state, { type: "MoveUnit", playerIndex: 0, unitInstanceIds: ["kato"], destinationBattlefieldId: "bf2" }),
    );
    expect(pendingDecision(asked)?.kind).toBe("SFD-112-gift");
    expect(optionIds(asked)).toEqual(["spare", "buddy"]); // base first, then battlefields — never "kato"
  });

  it("asks nothing at all when he moves alone", () => {
    // 422's do-as-much-as-you-can: no recipient, no question — rather than a
    // question with no answers, which `advanceDecisions` would have to drop.
    const state = katoState();
    state.battlefields[1]!.units = {};
    const after = walk(state);
    expect(pendingDecision(after)).toBeUndefined();
  });

  it("does not fire when SOMEONE ELSE moves — 'when I move'", () => {
    // The identity check. `unitMoved` fires for every unit either player walks,
    // so without it Kato would hand out his keywords on the opponent's turn.
    const state = katoState();
    // From BASE, because a battlefield-to-battlefield walk needs [Ganking] and
    // this test is about the listener, not about move legality.
    state.players[0]!.baseUnits.push(makeUnit({ instanceId: "stranger", might: 1 }));
    const after = answerDecisions(
      resolveHeldTriggers(
        executeMoveUnit(state, {
          type: "MoveUnit",
          playerIndex: 0,
          unitInstanceIds: ["stranger"],
          destinationBattlefieldId: "bf2",
        }),
      ),
    );
    expect(buddyIn(after).mightThisTurn).toBe(0);
    expect(buddyIn(after).keywordsThisTurn["Deflect"]).toBeUndefined();
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KATO_THE_ARM))).toBe(true);
  });
});

describe("Sivir - Ambitious (SFD-120): 5+ excess damage becomes a strike", () => {
  /** Sivir attacking one defender of `defenderMight` at bf1, with a second
   *  enemy body parked in the opponent's base as a candidate for her strike. */
  function sivirState(defenderMight: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [{ ...realUnitInstance(SIVIR_AMBITIOUS), instanceId: "sivir" }],
      p2: [makeUnit({ instanceId: "foe", might: defenderMight })],
    };
    state.battlefields[0]!.controllerId = "p2";
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "bystander", might: 9 })];
    return state;
  }

  const fight = (state: GameState) => resolveHeldTriggers(resolveShowdown(state, "bf1", 0));

  it("asks when the overkill reaches 5", () => {
    // Sivir is a 7-Might body; a 2-Might defender needs 2, so 5 is excess.
    const asked = fight(sivirState(2));
    expect(pendingDecision(asked)?.kind).toBe("SFD-120-strike");
    expect(optionIds(asked)).toEqual(["decline", "bystander"]);
  });

  it("deals THAT MUCH to the chosen enemy unit", () => {
    const after = answerDecisions(fight(sivirState(2)), choose("bystander"));
    expect(after.players[1]!.baseUnits.find((u) => u.instanceId === "bystander")!.damage).toBe(5);
  });

  it("does nothing when declined — the printed 'you MAY'", () => {
    // Asserting the question exists FIRST, for Buhru Captain's reason: a decline
    // test on a card that never triggered passes without noticing.
    const asked = fight(sivirState(2));
    expect(pendingDecision(asked)?.kind).toBe("SFD-120-strike");

    const after = answerDecisions(asked, choose("decline"));
    expect(after.players[1]!.baseUnits.find((u) => u.instanceId === "bystander")!.damage).toBe(0);
  });

  it("does NOT ask at 4 excess — the threshold is real", () => {
    // 7 Might into a 3-Might defender is 4 excess, one short.
    expect(pendingDecision(fight(sivirState(3)))).toBeUndefined();
  });

  it("does not ask for a conquest that was not an attack", () => {
    // Walking into an empty battlefield conquers without a fight, so nothing was
    // ever assigned — "after an attack" is what stops it paying out.
    const state = sivirState(2);
    state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(SIVIR_AMBITIOUS), instanceId: "sivir" }] };
    expect(pendingDecision(fight(state))).toBeUndefined();
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SIVIR_AMBITIOUS))).toBe(true);
  });
});

/** The ids on offer for the question at the front of the queue — read through
 *  `optionsFor`, so a test about WHICH answers exist sees exactly the list the
 *  player and the AI would be handed. */
function optionIds(state: GameState): string[] {
  const decision = pendingDecision(state);
  return decision ? optionsFor(state, decision).map((o) => o.id) : [];
}
