import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * The Spiritforged cards implemented in effects/chaos.ts.
 *
 * Everything here drives the REAL path — `submit` for a move or a play,
 * `legalActions` for the action itself, `resolveHeldTriggers` for the chain, and
 * `answerDecisions` for the questions — rather than calling a resolver directly.
 * That hop is what has broken repeatedly in this codebase: a card can be
 * written, typechecked and unreachable at the same time, and an inert card is
 * indistinguishable from a working one in play.
 *
 * Every assertion below was made to FAIL by commenting out its registry entry
 * before being kept.
 */

const registry = defaultCardRegistry();

const BLACK_MARKET_BROKER = "SFD-121";
const CORRUPT_ENFORCER = "SFD-123";
const FAE_PORTER = "SFD-125";
const LOYAL_PUP = "SFD-126";
const OVERZEALOUS_FAN = "SFD-128";
const BEAST_BELOW = "SFD-132";
const TREASURE_HUNTER = "SFD-130";
const HARPOON_SQUAD = "SFD-137";
const WINDSINGER = "SFD-138";
const SWITCHEROO = "SFD-145";
const DOWNWELL = "SFD-147";
const DRAVEN_AUDACIOUS = "SFD-148";
/** A [Hidden][Reaction] "Draw 2" from OGN — the facedown card Black Market
 *  Broker's tests actually play, chosen because it needs no target and 811 makes
 *  it free from facedown, so the fixture is about the Broker and nothing else. */
const CONSULT_THE_PAST = "OGN-083";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** The enumerated Standard Move of `unit` to `battlefieldId`. */
function moveTo(state: GameState, unit: UnitInstance, battlefieldId: string): unknown {
  const action = legalActions(state).find(
    (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === battlefieldId && a.unitInstanceIds.includes(unit.instanceId),
  );
  expect(action, `a move of ${unit.name} to ${battlefieldId} was never enumerated`).toBeDefined();
  return action!;
}

/** Pops a spell off the chain: both players pass, then the held triggers settle. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 6 && next.spellChain.length > 0; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  return resolveHeldTriggers(next);
}

/** Everywhere a unit could be, so an assertion can say "in play" without caring. */
function unitsInPlay(state: GameState): UnitInstance[] {
  return [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])]),
  ];
}

const at = (state: GameState, battlefieldId: string, playerId: "p1" | "p2"): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const findAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  unitsInPlay(state).find((u) => u.instanceId === instanceId);

/**
 * The defIds whose triggers are waiting on the CHAIN.
 *
 * Not `state.pendingTriggers`: `submit` runs the Cleanup, whose last step
 * finalizes the pen onto the chain, so any post-`submit` read of the pen finds an
 * empty array and every `not.toContain` against it passes vacuously. Measured —
 * two of the negative controls below survived having their condition mutated away
 * while they read the pen.
 */
const heldFor = (state: GameState): string[] =>
  state.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId as string);

/** The Gold gear tokens `playerIndex` currently has. Keyed off the token's own
 *  runtime defId rather than its name, so a rename upstream cannot make this
 *  count zero and read as a passing negative control. */
const goldOf = (state: GameState, playerIndex: 0 | 1) =>
  state.players[playerIndex]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

describe("Black Market Broker (SFD-121): a Gold token per card played from face down", () => {
  /**
   * The Broker in p1's base, and a REAL facedown card at bf2 hidden last turn.
   *
   * Deliberately a live facedown zone and a real enumerated play rather than a
   * hand-built `cardPlayed` event with `fromHidden: true` — which is how Ember
   * Monk (the same condition, cards-hidden.test.ts) is tested, and which would
   * assert nothing about whether `executePlayCard` actually sets the flag. That
   * dispatch hop is the one that has repeatedly been dead here.
   *
   * Consult the Past is [Hidden][Reaction] "Draw 2": no target, and free from
   * facedown by 811, so the play needs neither runes nor a board to point at.
   */
  function brokerState(hiddenOwner: 0 | 1 = 0): GameState {
    const state = makeState({
      phase: "Action",
      turnNumber: 3,
      activePlayerIndex: hiddenOwner,
      focusHolder: hiddenOwner,
      chainPriority: hiddenOwner,
    });
    state.players[0]!.baseUnits = [realUnitInstance(BLACK_MARKET_BROKER)];
    state.battlefields[1]!.hiddenCards = [{ ownerIndex: hiddenOwner, card: spellInstance(CONSULT_THE_PAST), hiddenOnTurn: 1 }];
    return state;
  }

  const hiddenPlay = (state: GameState) => {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);
    expect(action, "no from-hidden play was enumerated — the fixture measures nothing").toBeDefined();
    return action!;
  };

  it("makes one exhausted Gold token on a real play from facedown", () => {
    const state = brokerState();
    const after = resolveChain(accept(state, hiddenPlay(state)));

    const gold = goldOf(after, 0);
    expect(gold, "the facedown play minted no Gold").toHaveLength(1);
    // "Play a Gold gear token EXHAUSTED" — entering ready would be a free
    // rainbow Power on the turn it was made.
    expect(gold[0]!.exhausted).toBe(true);
    expect(gold[0]!.isToken).toBe(true);
    expect(gold[0]!.kind).toBe("Gear");
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the play", () => {
    const state = brokerState();
    const played = accept(state, hiddenPlay(state));
    expect(heldFor(played)).toContain(BLACK_MARKET_BROKER);
    expect(goldOf(played, 0), "resolved inline instead of waiting on the chain").toHaveLength(0);
  });

  it("does NOT fire on an ordinary play from hand", () => {
    // The whole point of the card, and the reason it needed `cardPlayed` to carry
    // `fromHidden`: without that fact the only available reading would be "when
    // you play a card", which is strictly stronger than printed.
    const card = spellInstance(DOWNWELL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [realUnitInstance(BLACK_MARKET_BROKER)];
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.floatingPower = { Chaos: 9 };

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);
    expect(play, "Downwell was never enumerated — the control measures nothing").toBeDefined();
    const played = accept(state, play);

    expect(heldFor(played)).not.toContain(BLACK_MARKET_BROKER);
    expect(goldOf(resolveChain(played), 0)).toHaveLength(0);
  });

  it("does NOT fire for the OPPONENT's facedown play — 'when YOU play'", () => {
    const state = brokerState(1);
    const played = accept(state, hiddenPlay(state));

    expect(heldFor(played)).not.toContain(BLACK_MARKET_BROKER);
    const after = resolveChain(played);
    expect(goldOf(after, 0), "the Broker paid out for the enemy's hidden card").toHaveLength(0);
    expect(goldOf(after, 1), "the opponent got a token they never had a Broker for").toHaveLength(0);
  });
});

describe("Corrupt Enforcer (SFD-123): when I move to a battlefield, discard 1", () => {
  it("discards on a real MoveUnit, through the held chain", () => {
    const enforcer = realUnitInstance(CORRUPT_ENFORCER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [enforcer];
    // ONE card in hand: `discardCards` only stops to ask when there is a choice,
    // so this keeps the assertion about the discard rather than about the prompt.
    state.players[0]!.hand = [makeUnit({ name: "Doomed" })];

    const after = resolveHeldTriggers(accept(state, moveTo(state, enforcer, "bf1")));

    expect(after.players[0]!.hand, "the move did not discard").toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Doomed"]);
  });

  it("stops to ASK when the hand holds a choice, and the player picks", () => {
    const enforcer = realUnitInstance(CORRUPT_ENFORCER);
    const keep = makeUnit({ name: "Keep" });
    const pitch = makeUnit({ name: "Pitch" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [enforcer];
    state.players[0]!.hand = [keep, pitch];

    const asked = resolveHeldTriggers(accept(state, moveTo(state, enforcer, "bf1")));
    expect(pendingDecision(asked)?.kind, "the discard never asked").toBe("discard");

    const answered = answerDecisions(asked, (options) => options.find((o) => o.instanceId === pitch.instanceId)!.id);
    expect(answered.players[0]!.hand.map((c) => c.name)).toEqual(["Keep"]);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the move", () => {
    const enforcer = realUnitInstance(CORRUPT_ENFORCER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [enforcer];
    state.players[0]!.hand = [makeUnit({ name: "Doomed" })];

    const moved = accept(state, moveTo(state, enforcer, "bf1"));
    expect(moved.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId)).toContain(CORRUPT_ENFORCER);
    expect(moved.players[0]!.hand, "resolved inline instead of waiting on the chain").toHaveLength(1);
  });

  it("does NOT fire for someone else's move", () => {
    const enforcer = realUnitInstance(CORRUPT_ENFORCER);
    const other = makeUnit({ name: "Other" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [enforcer] };
    state.players[0]!.baseUnits = [other];
    state.players[0]!.hand = [makeUnit({ name: "Safe" })];

    const moved = accept(state, moveTo(state, other, "bf2"));
    expect(moved.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(CORRUPT_ENFORCER);
    expect(resolveHeldTriggers(moved).players[0]!.hand).toHaveLength(1);
  });
});

describe("Fae Porter (SFD-125): pay a Chaos rune to pull a unit in behind him", () => {
  /** The Porter and a friend in base, with one Chaos rune channeled. */
  function porterState(runeDomain: "Chaos" | "Fury" = "Chaos"): { state: GameState; porter: UnitInstance; ally: UnitInstance } {
    const porter = realUnitInstance(FAE_PORTER);
    const ally = makeUnit({ name: "Ally" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [porter, ally];
    state.players[0]!.channeled = [{ id: "rune-1", domain: runeDomain, state: "Ready" }];
    return { state, porter, ally };
  }

  it("moves the chosen friendly unit to his battlefield and SPENDS the rune", () => {
    const { state, porter, ally } = porterState();

    const asked = resolveHeldTriggers(accept(state, moveTo(state, porter, "bf1")));
    expect(pendingDecision(asked)?.kind, "the Porter never asked").toBe("SFD-125-move");

    const after = answerDecisions(asked, (options) => options.find((o) => o.instanceId === ally.instanceId)!.id);

    expect(at(after, "bf1", "p1").map((u) => u.name).sort()).toEqual(["Ally", "Fae Porter"]);
    expect(after.players[0]!.baseUnits, "the ally did not leave base").toHaveLength(0);
    // 416: paying Power RECYCLES the rune to the bottom of the rune deck.
    expect(after.players[0]!.channeled, "the Chaos rune was never spent").toHaveLength(0);
    // An effect-driven move does not exhaust (414.3.a puts that on the ACTION).
    expect(at(after, "bf1", "p1").find((u) => u.name === "Ally")!.exhausted).toBe(false);
  });

  it("declining leaves the rune and the ally alone", () => {
    const { state, porter } = porterState();

    const asked = resolveHeldTriggers(accept(state, moveTo(state, porter, "bf1")));
    // Asserted before the answer: `answerDecisions` never calls its picker when
    // no question was raised, so without this the test would pass on a board
    // where the trigger never fired at all.
    expect(pendingDecision(asked)?.kind).toBe("SFD-125-move");
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);

    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Ally"]);
    expect(after.players[0]!.channeled).toHaveLength(1);
  });

  it("places NO Pending Item when the Chaos rune cannot be paid — 416.3", () => {
    // A Fury rune cannot pay a Chaos pip, so the cost cannot be completed and the
    // "you may pay" is not an offer at all.
    //
    // Asserted on the CHAIN, not on `pendingTriggers`: `submit` runs the Cleanup,
    // whose last step drains the pen onto the chain, so a post-submit read of the
    // pen finds an empty array whatever happened. Measured — with the affordability
    // check mutated away this assertion still passed against the pen, and fails
    // against the chain.
    const { state, porter } = porterState("Fury");

    expect(heldFor(accept(state, moveTo(state, porter, "bf1")))).not.toContain(FAE_PORTER);
  });

  it("places NO Pending Item when there is nobody left to move", () => {
    const porter = realUnitInstance(FAE_PORTER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [porter];
    state.players[0]!.channeled = [{ id: "rune-1", domain: "Chaos", state: "Ready" }];

    expect(heldFor(accept(state, moveTo(state, porter, "bf1")))).not.toContain(FAE_PORTER);
  });

  it("...and DOES place one on the board that satisfies both — the positive control", () => {
    // The counterpart the two checks above need: a `not.toContain` on a list that
    // is always empty reads exactly like a pass.
    const { state, porter } = porterState();
    expect(heldFor(accept(state, moveTo(state, porter, "bf1")))).toContain(FAE_PORTER);
  });
});

describe("Loyal Pup (SFD-126): when YOU defend at a battlefield, he may join", () => {
  /** p0 defends bf1 with a Guard; the Pup waits at home. p1 is the attacker. */
  function pupState(pupAt: "base" | "bf1" = "base"): { state: GameState; pup: UnitInstance } {
    const pup = realUnitInstance(LOYAL_PUP);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: pupAt === "bf1" ? [makeUnit({ name: "Guard" }), pup] : [makeUnit({ name: "Guard" })], p2: [makeUnit({ name: "Raider" })] };
    if (pupAt === "base") state.players[0]!.baseUnits = [pup];
    // 464.2.c: the Attacker is whoever applied Contested, so p1 (index 1) attacking
    // makes p0 the Defender.
    state.battlefields[0]!.contestedByIndex = 1;
    return { state, pup };
  }

  it("moves from BASE into the fight when his controller says so", () => {
    const { state, pup } = pupState();

    const asked = resolveHeldTriggers(state);
    expect(pendingDecision(asked)?.kind, "the Pup never asked").toBe("SFD-126-join");

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "join")!.id);

    expect(at(after, "bf1", "p1").map((u) => u.name).sort()).toEqual(["Guard", "Loyal Pup"]);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("stays put when declined", () => {
    const { state } = pupState();
    const asked = resolveHeldTriggers(state);
    // Asked FIRST — an unfired trigger also leaves him in base, so without this
    // the assertion below would hold on a board where nothing triggered.
    expect(pendingDecision(asked)?.kind).toBe("SFD-126-join");
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "stay")!.id);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Loyal Pup"]);
  });

  it("does not fire for the ATTACKING side — 'when YOU defend'", () => {
    const pup = realUnitInstance(LOYAL_PUP);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Aggressor" })], p2: [makeUnit({ name: "Holder" })] };
    state.players[0]!.baseUnits = [pup];
    state.battlefields[0]!.contestedByIndex = 0; // p0 is the ATTACKER

    const settled = resolveHeldTriggers(state);
    expect(pendingDecision(settled)).toBeUndefined();
    expect(settled.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Loyal Pup"]);
  });

  it("does not fire when he is already standing in the fight", () => {
    const { state } = pupState("bf1");
    const settled = resolveHeldTriggers(state);
    expect(pendingDecision(settled)).toBeUndefined();
  });

  it("does not fire when the defender has no units there at all", () => {
    // **What this actually pins is the ENGINE, not the Pup's own guard.** A
    // battlefield contested with only one player's units present stages a
    // NON-COMBAT Showdown (341 / 316.8.b.1), and `beginCombatAt` — and therefore
    // `combatBegan` — is never reached, so no listener hears anything. The
    // presence check inside `pupJoins` is unreachable through this path and only
    // bites on `designateArrivals`, which fires `combatBegan` for a reinforcement
    // walking into a fight whose other side has since been wiped.
    //
    // The showdown KIND is asserted so the claim is about a measured board rather
    // than about an absence.
    const pup = realUnitInstance(LOYAL_PUP);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Raider" })] };
    state.players[0]!.baseUnits = [pup];
    state.battlefields[0]!.contestedByIndex = 1;

    const settled = resolveHeldTriggers(state);
    expect(settled.showdownKind, "this was a COMBAT showdown after all").toBe("NonCombat");
    expect(pendingDecision(settled)).toBeUndefined();
    expect(settled.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Loyal Pup"]);
  });
});

describe("Overzealous Fan (SFD-128): kill me to send an attacker home", () => {
  /** p1 attacks bf1 with a Raider; p0's Fan defends it. */
  function fanState(): { state: GameState; fan: UnitInstance; raider: UnitInstance } {
    const fan = realUnitInstance(OVERZEALOUS_FAN);
    const raider = makeUnit({ name: "Raider" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [fan], p2: [raider] };
    state.battlefields[0]!.contestedByIndex = 1;
    return { state, fan, raider };
  }

  it("kills him and recalls the chosen attacker BEFORE combat damage", () => {
    const { state, fan, raider } = fanState();

    const asked = resolveHeldTriggers(state);
    expect(pendingDecision(asked)?.kind, "the Fan never asked").toBe("SFD-128-sacrifice");

    const after = answerDecisions(asked, (options) => options.find((o) => o.instanceId === raider.instanceId)!.id);

    expect(findAnywhere(after, fan.instanceId), "he did not pay the cost").toBeUndefined();
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Overzealous Fan"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name), "the attacker was not sent home").toEqual(["Raider"]);
    expect(at(after, "bf1", "p2")).toHaveLength(0);
    // "MOVE ... to its base" is a Move, not a 454 Recall, so it arrives exhausted.
    expect(after.players[1]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("declining costs nothing — he lives and the attacker stays", () => {
    const { state, fan, raider } = fanState();
    const asked = resolveHeldTriggers(state);
    expect(pendingDecision(asked)?.kind, "nothing was asked, so 'decline' proves nothing").toBe("SFD-128-sacrifice");
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);

    expect(findAnywhere(after, fan.instanceId)).toBeDefined();
    expect(at(after, "bf1", "p2").map((u) => u.instanceId)).toEqual([raider.instanceId]);
  });

  it("does not fire while he is ATTACKING — 'when I DEFEND'", () => {
    const fan = realUnitInstance(OVERZEALOUS_FAN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [fan], p2: [makeUnit({ name: "Holder" })] };
    state.battlefields[0]!.contestedByIndex = 0; // the Fan's own side applied Contested

    const settled = resolveHeldTriggers(state);
    expect(pendingDecision(settled)).toBeUndefined();
    expect(findAnywhere(settled, fan.instanceId)).toBeDefined();
  });
});

describe("Beast Below (SFD-132): return a friendly AND an enemy unit", () => {
  it("bounces one of each, and never himself", () => {
    const beast = realUnitInstance(BEAST_BELOW);
    const ally = makeUnit({ name: "Ally" });
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally, beast];
    state.battlefields[0]!.units = { p2: [enemy] };

    const after = answerDecisions(playUnitTrigger(state, beast, 0, "base"));

    expect(findAnywhere(after, beast.instanceId), "he returned himself").toBeDefined();
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Ally"]);
    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Enemy"]);
    expect(at(after, "bf1", "p2")).toHaveLength(0);
  });

  it("does as much as it can: no enemy on the board still bounces the friendly", () => {
    // The whole reason these are two questions rather than one `unitSlots` spec —
    // a pair-only enumeration produces no variant at all here and the Beast would
    // return NOTHING.
    const beast = realUnitInstance(BEAST_BELOW);
    const ally = makeUnit({ name: "Ally" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally, beast];

    const after = answerDecisions(playUnitTrigger(state, beast, 0, "base"));

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Ally"]);
  });

  it("does as much as it can the other way: no other friendly still bounces the enemy", () => {
    const beast = realUnitInstance(BEAST_BELOW);
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.players[0]!.baseUnits = [beast];
    state.battlefields[0]!.units = { p2: [enemy] };

    const after = answerDecisions(playUnitTrigger(state, beast, 0, "base"));

    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Enemy"]);
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("fires through a REAL PlayCard, not merely through the dispatcher", () => {
    const beast = realUnitInstance(BEAST_BELOW);
    const ally = makeUnit({ name: "Ally" });
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [beast];
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.floatingEnergy = 9;
    state.players[0]!.floatingPower = { Chaos: 9 };
    state.battlefields[0]!.units = { p2: [enemy] };

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === beast.instanceId);
    expect(play, "Beast Below was never enumerated").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, play)));

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Ally"]);
    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Enemy"]);
  });
});

describe("Treasure Hunter (SFD-130): a Gold token every time I move", () => {
  /** The Hunter at `from`, with [Ganking] for the turn so a battlefield-to-
   *  battlefield redeploy is enumerable — he does not print the keyword. */
  function hunterState(from: "base" | "bf1"): { state: GameState; hunter: UnitInstance } {
    const hunter = { ...realUnitInstance(TREASURE_HUNTER), keywordsThisTurn: { Ganking: 1 } } as UnitInstance;
    const state = makeState({ phase: "Action" });
    if (from === "base") state.players[0]!.baseUnits = [hunter];
    else state.battlefields[0]!.units = { p1: [hunter] };
    return { state, hunter };
  }

  it("mints one exhausted Gold token walking out of base", () => {
    const { state, hunter } = hunterState("base");

    const after = resolveHeldTriggers(accept(state, moveTo(state, hunter, "bf1")));

    const gold = goldOf(after, 0);
    expect(gold, "the move minted no Gold").toHaveLength(1);
    expect(gold[0]!.exhausted, "it entered ready — a free rainbow Power").toBe(true);
    expect(goldOf(after, 1), "the opponent got one").toHaveLength(0);
  });

  it("mints one on a battlefield-to-battlefield move too — BARE 'when I move'", () => {
    // The contrast with Harpoon Squad below, whose printed "from a battlefield"
    // is exactly what the Hunter does not have. Both halves are asserted because
    // reading `event.from` here would silently narrow the card.
    const { state, hunter } = hunterState("bf1");

    const after = resolveHeldTriggers(accept(state, moveTo(state, hunter, "bf2")));

    expect(goldOf(after, 0)).toHaveLength(1);
  });

  it("mints one PER move, with distinct instance ids", () => {
    // Two tokens sharing an instanceId would make the second unkillable — every
    // lookup would find the first.
    //
    // Both battlefields are p1's ALREADY, so neither arrival applies Contested
    // (190.4) and the turn stays Neutral Open between the two moves. Without
    // that the first move stages a Showdown, `legalActions` offers PassFocus
    // alone, and the second move is simply never enumerated — measured, and it
    // is why this fixture differs from the ones above.
    const { state, hunter } = hunterState("base");
    state.battlefields.forEach((bf) => (bf.controllerId = "p1"));

    const once = resolveHeldTriggers(accept(state, moveTo(state, hunter, "bf1")));
    expect(goldOf(once, 0), "the first move already failed").toHaveLength(1);

    const moved = findAnywhere(once, hunter.instanceId)!;
    // The Standard Move exhausted him (414.3.a); ready him so the second is legal.
    const readied = {
      ...once,
      battlefields: once.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [{ ...moved, exhausted: false }] } } : bf,
      ),
    };
    const twice = resolveHeldTriggers(accept(readied, moveTo(readied, moved, "bf2")));

    const gold = goldOf(twice, 0);
    expect(gold, "the second move paid nothing").toHaveLength(2);
    expect(new Set(gold.map((g) => g.instanceId)).size).toBe(2);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the move", () => {
    const { state, hunter } = hunterState("base");

    const moved = accept(state, moveTo(state, hunter, "bf1"));
    expect(heldFor(moved)).toContain(TREASURE_HUNTER);
    expect(goldOf(moved, 0), "resolved inline instead of waiting on the chain").toHaveLength(0);
  });

  it("does NOT fire for someone else's move — 'when I move'", () => {
    const { state, hunter } = hunterState("bf1");
    const other = makeUnit({ name: "Other" });
    state.players[0]!.baseUnits = [other];

    const moved = accept(state, moveTo(state, other, "bf2"));
    expect(heldFor(moved)).not.toContain(TREASURE_HUNTER);
    expect(goldOf(resolveHeldTriggers(moved), 0)).toHaveLength(0);
    // The Hunter himself never moved, so this also pins that the fixture is real.
    expect(findAnywhere(moved, hunter.instanceId), "the Hunter vanished").toBeDefined();
  });
});

describe("Harpoon Squad (SFD-137): +2 Might when I move FROM a battlefield", () => {
  /** [Ganking] granted for the turn, since battlefield-to-battlefield is the only
   *  move that satisfies "from a battlefield" and he does not print the keyword. */
  function squadState(from: "bf1" | "base"): { state: GameState; squad: UnitInstance } {
    const squad = { ...realUnitInstance(HARPOON_SQUAD), keywordsThisTurn: { Ganking: 1 } } as UnitInstance;
    const state = makeState({ phase: "Action" });
    if (from === "bf1") state.battlefields[0]!.units = { p1: [squad] };
    else state.players[0]!.baseUnits = [squad];
    return { state, squad };
  }

  it("pumps on a battlefield-to-battlefield move", () => {
    const { state, squad } = squadState("bf1");

    const after = resolveHeldTriggers(accept(state, moveTo(state, squad, "bf2")));

    const moved = findAnywhere(after, squad.instanceId)!;
    expect(moved.mightThisTurn, "the redeploy did not pump him").toBe(2);
    expect(moved.might, "printed Might was touched").toBe(4);
  });

  it("pumps NOTHING walking out of base — 'from A BATTLEFIELD'", () => {
    const { state, squad } = squadState("base");

    const moved = accept(state, moveTo(state, squad, "bf1"));
    expect(moved.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(HARPOON_SQUAD);
    expect(findAnywhere(resolveHeldTriggers(moved), squad.instanceId)!.mightThisTurn).toBe(0);
  });
});

describe("Windsinger (SFD-138): you MAY bounce a small unit at a battlefield", () => {
  function windsingerState(): { state: GameState; windsinger: UnitInstance; small: UnitInstance; big: UnitInstance } {
    const windsinger = realUnitInstance(WINDSINGER);
    const small = makeUnit({ name: "Small", might: 3 });
    const big = makeUnit({ name: "Big", might: 4 });
    const state = makeState();
    state.players[0]!.baseUnits = [windsinger];
    state.battlefields[0]!.units = { p2: [small, big] };
    return { state, windsinger, small, big };
  }

  it("returns the chosen 3-Might unit to its owner's hand", () => {
    const { state, windsinger, small } = windsingerState();

    const after = answerDecisions(playUnitTrigger(state, windsinger, 0, "base"), (options) => {
      expect(options.map((o) => o.label), "the 4-Might unit was on offer").not.toContain("Big");
      return options.find((o) => o.instanceId === small.instanceId)!.id;
    });

    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Small"]);
    expect(at(after, "bf1", "p2").map((u) => u.name)).toEqual(["Big"]);
  });

  it("DECLINE is a real answer — 'you may' does not become 'you must'", () => {
    // The whole reason this is a decision rather than a `maxMight` target spec:
    // the fan-out only offers a no-target variant when there is nothing legal.
    const { state, windsinger } = windsingerState();

    const asked = playUnitTrigger(state, windsinger, 0, "base");
    expect(optionsFor(asked, pendingDecision(asked)!).map((o) => o.id)).toContain("decline");

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);
    expect(after.players[1]!.hand).toHaveLength(0);
    expect(at(after, "bf1", "p2")).toHaveLength(2);
  });

  it("never offers a unit in BASE — 'at a battlefield'", () => {
    // A 1-Might unit at HOME and a 2-Might unit at a battlefield. Asserting only
    // "the homebody survived" would pass on a board where the trigger never fired
    // at all, so the check is on the OPTION LIST — which requires the question to
    // have been raised, and requires it to hold the front-line unit.
    const windsinger = realUnitInstance(WINDSINGER);
    const homebody = makeUnit({ name: "Homebody", might: 1 });
    const frontline = makeUnit({ name: "Frontline", might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [windsinger];
    state.players[1]!.baseUnits = [homebody];
    state.battlefields[0]!.units = { p2: [frontline] };

    const asked = playUnitTrigger(state, windsinger, 0, "base");
    const offered = optionsFor(asked, pendingDecision(asked)!).map((o) => o.instanceId);
    expect(offered, "the front-line unit was not on offer").toContain(frontline.instanceId);
    expect(offered, "a unit in BASE was offered").not.toContain(homebody.instanceId);
  });
});

describe("Switcheroo (SFD-145): swap two units' Might at one battlefield", () => {
  function switcherooState(): { state: GameState; card: ReturnType<typeof spellInstance>; mine: UnitInstance; theirs: UnitInstance } {
    const card = spellInstance(SWITCHEROO);
    const mine = makeUnit({ name: "Mine", might: 6 });
    const theirs = makeUnit({ name: "Theirs", might: 2 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 9;
    state.players[0]!.floatingPower = { Chaos: 9 };
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    return { state, card, mine, theirs };
  }

  it("swaps them through a real cast, as this-turn Might on top of printed", () => {
    const { state, card, mine, theirs } = switcherooState();

    const play = legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.instanceId === card.instanceId &&
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === mine.instanceId &&
        (a as { secondTargetUnitInstanceId?: string }).secondTargetUnitInstanceId === theirs.instanceId,
    );
    expect(play, "Switcheroo was never enumerated against that pair").toBeDefined();

    const after = resolveChain(accept(state, play));

    const mineAfter = findAnywhere(after, mine.instanceId)!;
    const theirsAfter = findAnywhere(after, theirs.instanceId)!;
    expect(mineAfter.might, "printed Might was rewritten").toBe(6);
    expect(mineAfter.might + mineAfter.mightThisTurn).toBe(2);
    expect(theirsAfter.might + theirsAfter.mightThisTurn).toBe(6);
  });

  it("is not castable without a PAIR at one battlefield — 'at the SAME battlefield'", () => {
    const { state, card, mine } = switcherooState();
    // Split them up: one unit each at two different battlefields.
    state.battlefields[0]!.units = { p1: [mine] };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "Elsewhere", might: 2 })] };

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);
    expect(plays, "a split board still offered the swap").toHaveLength(0);
  });

  it("carries an existing this-turn modifier across the swap", () => {
    const { state, card, mine, theirs } = switcherooState();
    // Mine is printed 6 with -4 this turn (net 2); theirs printed 2 (net 2).
    // Equal after modifiers, so the swap is observably a no-op — which is the
    // reading this file took, and the one an `effectiveMight` reading would break.
    state.battlefields[0]!.units = { p1: [{ ...mine, mightThisTurn: -4 }], p2: [theirs] };

    const play = legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.instanceId === card.instanceId &&
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === mine.instanceId,
    );
    const after = resolveChain(accept(state, play));

    expect(findAnywhere(after, mine.instanceId)!.mightThisTurn).toBe(-4);
    expect(findAnywhere(after, theirs.instanceId)!.mightThisTurn).toBe(0);
  });
});

describe("Downwell (SFD-147): return ALL units and gear to their owners' hands", () => {
  it("clears both bases, both battlefields and both players' gear", () => {
    const card = spellInstance(DOWNWELL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.floatingPower = { Chaos: 9 };
    state.players[0]!.baseUnits = [makeUnit({ name: "MyHome" })];
    state.players[1]!.baseUnits = [makeUnit({ name: "TheirHome" })];
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "MyFront" })] };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "TheirFront" })] };
    state.players[0]!.activeGear = [{ ...makeUnit({ name: "MyGear" }), kind: "Gear" } as never];
    state.players[1]!.activeGear = [{ ...makeUnit({ name: "TheirGear" }), kind: "Gear" } as never];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);
    expect(play, "Downwell was never enumerated").toBeDefined();

    const after = resolveChain(accept(state, play));

    expect(unitsInPlay(after), "something was left standing").toHaveLength(0);
    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[1]!.activeGear).toHaveLength(0);
    // To the OWNER's hand, not the caster's.
    expect(after.players[0]!.hand.map((c) => c.name).sort()).toEqual(["MyFront", "MyGear", "MyHome"]);
    expect(after.players[1]!.hand.map((c) => c.name).sort()).toEqual(["TheirFront", "TheirGear", "TheirHome"]);
  });

  it("strips a Buff on the way out — rule 705", () => {
    const card = spellInstance(DOWNWELL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.floatingPower = { Chaos: 9 };
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Buffed", buffed: true, damage: 2 })] };

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);
    const after = resolveChain(accept(state, play));

    const returned = after.players[0]!.hand.find((c) => c.name === "Buffed") as UnitInstance;
    expect(returned.buffed).toBe(false);
    expect(returned.damage).toBe(0);
  });
});

describe("Draven - Audacious (SFD-148): the first combat he wins each turn scores", () => {
  /**
   * **Every assertion here is a DELTA against a control board, never an absolute
   * point total, and that is a correction rather than a style.** Winning a combat
   * at a battlefield you did not control also CONQUERS it, and a conquest scores
   * 1 point of its own — so the first draft of these tests read `points === 1`
   * and every one of them failed at 2 against working code. An absolute total
   * cannot tell Draven's point from the conquest's.
   *
   * The control is the same board with a plain unit in his place, fought the same
   * way, so the difference between the two totals is exactly what his text adds.
   */
  const RIVAL_MIGHT = 1;
  const DRAVEN_MIGHT = 9;

  /** `hero` at bf1 for p0 against one rival, contested by `contestedBy`. */
  function boardWith(hero: UnitInstance, heroMight: number, rivalMight: number, contestedBy: 0 | 1): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [{ ...hero, might: heroMight }], p2: [makeUnit({ name: "Rival", might: rivalMight })] };
    state.battlefields[0]!.contestedByIndex = contestedBy;
    return state;
  }

  const dravenBoard = (heroMight = DRAVEN_MIGHT, rivalMight = RIVAL_MIGHT, contestedBy: 0 | 1 = 0) =>
    boardWith(realUnitInstance(DRAVEN_AUDACIOUS), heroMight, rivalMight, contestedBy);
  /** The same fight with a nobody in his place — the conquest baseline. */
  const controlBoard = (heroMight = DRAVEN_MIGHT, rivalMight = RIVAL_MIGHT, contestedBy: 0 | 1 = 0) =>
    boardWith(makeUnit({ name: "Nobody" }), heroMight, rivalMight, contestedBy);

  /**
   * Opens the Showdown through the real Cleanup and then CLOSES it the way a game
   * does — two consecutive PassFocus, which is `closeShowdown`'s only entry (348)
   * and therefore the only path `resolveShowdown` and its `combatWon` hold are
   * ever reached by.
   *
   * Deliberately not a direct `resolveShowdown` call, which is one hop below the
   * real path and exactly the kind of hop that has been dead here before.
   */
  function fightOut(state: GameState): GameState {
    let next = resolveHeldTriggers(state);
    for (let guard = 0; guard < 8 && next.turnState === "Showdown"; guard += 1) {
      next = executePassFocus(next, { type: "PassFocus", playerIndex: next.focusHolder });
    }
    return answerDecisions(resolveHeldTriggers(next));
  }

  const pointsAfter = (state: GameState): [number, number] => {
    const after = fightOut(state);
    return [after.players[0]!.points, after.players[1]!.points];
  };

  it("scores 1 point MORE than the same fight without him — through a real Showdown close", () => {
    const after = fightOut(dravenBoard());
    const control = fightOut(controlBoard());

    expect(at(after, "bf1", "p2"), "the rival survived — this fixture won nothing").toHaveLength(0);
    expect(at(control, "bf1", "p2"), "the control fixture won nothing either").toHaveLength(0);
    expect(after.players[0]!.points - control.players[0]!.points, "Draven won and scored nothing").toBe(1);
    expect(after.players[1]!.points, "the loser scored").toBe(0);
  });

  it("scores nothing when the OPPONENT wins the fight", () => {
    // Draven loses at 1 Might against 9, so his side is the one wiped out.
    //
    // **This control is WEAK by construction, and measured to be so** — the same
    // hole combat-won.test.ts's mutual-wipe test documents. Deleting the
    // `winnerIndex === listener.ownerIndex` condition from `applies` leaves this
    // PASSING, because a losing Draven is a dead Draven: 466.3.a makes the winner
    // "the only player that has units remaining", so a unit alive at the
    // battlefield where a combat was won is on the winning side by definition and
    // one on the losing side is not a listener at all. The condition is therefore
    // unfalsifiable here rather than untested — it is redundant with the
    // positional check the test below DOES fail on.
    //
    // **His SECOND clause landed after this test was written, and it changes the
    // answer.** "When I die in combat, choose an opponent. They score 1 point"
    // is now implemented, so a loss does NOT pay nobody — it pays the opponent,
    // by design. That is his drawback, and the price his win clause is written
    // against.
    //
    // What is still pinned, and is what this test was really for: the WIN clause
    // does not fire on a loss. Draven scores nothing himself, and the opponent
    // gets exactly ONE more than the control board — the death point, not a
    // stray win.
    const draven = realUnitInstance(DRAVEN_AUDACIOUS);
    const state = boardWith(draven, 1, 9, 0);

    const after = fightOut(state);
    const [, controlOpponent] = pointsAfter(boardWith(makeUnit({ name: "Nobody" }), 1, 9, 0));

    expect(findAnywhere(after, draven.instanceId), "Draven survived — this is not a loss").toBeUndefined();
    expect(after.players[1]!.points - controlOpponent, "his death clause paid the wrong amount").toBe(1);
    expect(after.players[0]!.points, "the dead Draven scored anyway").toBe(0);
  });

  it("scores nothing for a combat won somewhere ELSE — 'I win a combat' is positional", () => {
    // Draven sits at bf2 while his side wins at bf1. His CONTROLLER won a
    // combat; he did not, and the card says "I".
    const withDraven = controlBoard();
    withDraven.battlefields[1]!.units = { p1: [{ ...realUnitInstance(DRAVEN_AUDACIOUS), might: 4 }] };

    const after = fightOut(withDraven);
    const control = fightOut(controlBoard());

    expect(at(after, "bf1", "p2"), "nobody won the fixture's fight").toHaveLength(0);
    expect(after.players[0]!.points, "Draven scored for a fight he was not in").toBe(control.players[0]!.points);
  });

  it("scores ONCE a turn however many combats he wins", () => {
    // Two fights in one turn with the same Draven: he wins at bf1, then the
    // opponent contests bf1 again with a fresh unit and loses to him again. The
    // rematch conquers nothing (he already controls bf1 and already scored it),
    // so a second point could only come from his text.
    const first = fightOut(dravenBoard());
    const control = fightOut(controlBoard());
    expect(first.players[0]!.points - control.players[0]!.points, "the first win did not score — the rest proves nothing").toBe(1);

    const second = fightOut(rematchAt(first));

    expect(at(second, "bf1", "p2"), "the rematch was never fought").toHaveLength(0);
    expect(second.players[0]!.points, "the allowance did not hold — he scored twice in one turn").toBe(first.players[0]!.points);
  });

  it("re-arms at the end of the turn", () => {
    // The whole risk of recording the allowance on the unit: if it never expired
    // Draven would score once per GAME. This is the positive control for the
    // test above — the SAME rematch, with only a turn boundary in between.
    const first = fightOut(dravenBoard());
    const nextTurn = runEnd({ ...first, turnState: "Neutral", phase: "Action" });

    const second = fightOut({ ...rematchAt(nextTurn), phase: "Action", activePlayerIndex: 0 });

    expect(at(second, "bf1", "p2"), "the rematch was never fought").toHaveLength(0);
    expect(second.players[0]!.points - first.players[0]!.points, "the once-a-turn mark never expired").toBe(1);
  });

  it("holds the trigger on the CHAIN rather than resolving it inside the combat", () => {
    // 383: the win is a Pending Item, so the point lands a chain-pop later and
    // both players get a window in between.
    //
    // `runCleanup` is what finalizes the pen onto the chain, so it is run here
    // rather than reading `pendingTriggers` — the pen and the chain are different
    // places and this file's `heldFor` note records which one an assertion means.
    let opened = resolveHeldTriggers(dravenBoard());
    for (let guard = 0; guard < 8 && opened.turnState === "Showdown"; guard += 1) {
      opened = executePassFocus(opened, { type: "PassFocus", playerIndex: opened.focusHolder });
    }

    expect(opened.pendingTriggers.map((t) => t.listenerDefId), "the win never reached the pen").toContain(DRAVEN_AUDACIOUS);
    expect(heldFor(runCleanup(opened)), "the win never reached the chain").toContain(DRAVEN_AUDACIOUS);
    expect(opened.players[0]!.points, "the point was scored inline instead of waiting on the chain").toBe(1); // the conquest's, not his
  });

  /** p1 walks a fresh rival back into bf1 and contests it again. */
  function rematchAt(state: GameState): GameState {
    return {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p2: [makeUnit({ name: "Fresh Rival", might: RIVAL_MIGHT })] }, contestedByIndex: 1 as 0 | 1 }
          : bf,
      ),
    };
  }
});

describe("coverage sees each of them", () => {
  // Corrupt Enforcer IS in this list now: his second clause landed with
  // `combatWon`, so his PARTIALLY_IMPLEMENTED entry was deleted rather than
  // reworded, and the assertion below pins that.
  //
  // **Draven - Audacious (SFD-148) is deliberately NOT in this list.** Only his
  // combat-win clause is written; "when I die in combat" needs a `diedInCombat`
  // flag on `DeathContext` that does not exist. He is awaiting a
  // coverage.PARTIALLY_IMPLEMENTED entry, and asserting either answer here would
  // break the moment it lands — a card that is half written and a card that is
  // finished are exactly what this file must keep apart, so it says neither
  // until the entry is in.
  for (const defId of [
    CORRUPT_ENFORCER,
    BLACK_MARKET_BROKER,
    FAE_PORTER,
    LOYAL_PUP,
    OVERZEALOUS_FAN,
    TREASURE_HUNTER,
    BEAST_BELOW,
    HARPOON_SQUAD,
    WINDSINGER,
    SWITCHEROO,
    DOWNWELL,
  ]) {
    it(`${registry.get(defId).name} (${defId})`, () => {
      expect(isCardImplemented(registry.get(defId))).toBe(true);
      expect(partialImplementationNote(registry.get(defId))).toBeUndefined();
    });
  }


  it("Corrupt Enforcer is WHOLE now — both clauses, and no partial note", () => {
    // He was registered for his move clause only, and reported DONE on the
    // strength of it; "when I win a combat, draw 1" needed a combat-WON event
    // (466.3.a) that GameEvent did not carry. It does now, so his
    // PARTIALLY_IMPLEMENTED entry was DELETED rather than reworded.
    expect(registry.get(CORRUPT_ENFORCER).text).toContain("When I win a combat");
    expect(isCardImplemented(registry.get(CORRUPT_ENFORCER))).toBe(true);
    expect(partialImplementationNote(registry.get(CORRUPT_ENFORCER))).toBeUndefined();
  });
});

/**
 * Treasure Hunter walking HOME — the report that started this.
 *
 * *"I moved a treasure hunter back from a BF and it did not generate a gold gear
 * token."* His text is a bare "When I move", with no destination clause at all —
 * the block above already asserts that against a battlefield-to-battlefield move.
 * Walking home is the third direction, and it was the one that paid nothing.
 *
 * **455 defines a Recall as a relocation to base WITHOUT it being a Move**, so a
 * player sending their own unit home is a Move (446.1; 107.1.b makes a Base a
 * Location). The engine's action is named `RecallUnit` after the Java oracle, and
 * the name is what made a true sentence about Recalls look like it applied here.
 */
describe("Treasure Hunter walking home is still a move", () => {
  function atBattlefield(): { state: GameState; hunter: UnitInstance } {
    const hunter = realUnitInstance(TREASURE_HUNTER);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [hunter] };
    return { state, hunter };
  }

  it("mints a Gold token for the walk home", () => {
    const { state, hunter } = atBattlefield();

    const after = resolveHeldTriggers(
      accept(state, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [hunter.instanceId] }),
    );

    // Premise: he actually got home. "No gold" and "never moved" look identical.
    expect(after.players[0]!.baseUnits.map((u) => u.name), "he never came home").toContain("Treasure Hunter");
    expect(goldOf(after, 0), "walking home minted no Gold — the reported bug").toHaveLength(1);
    expect(goldOf(after, 0)[0]!.exhausted, "it entered ready").toBe(true);
  });

  it("and the opponent gets nothing — the control", () => {
    const { state, hunter } = atBattlefield();
    const after = resolveHeldTriggers(
      accept(state, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [hunter.instanceId] }),
    );
    expect(goldOf(after, 1)).toHaveLength(0);
  });
});
