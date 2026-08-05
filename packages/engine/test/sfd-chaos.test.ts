import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
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

const CORRUPT_ENFORCER = "SFD-123";
const FAE_PORTER = "SFD-125";
const LOYAL_PUP = "SFD-126";
const OVERZEALOUS_FAN = "SFD-128";
const BEAST_BELOW = "SFD-132";
const HARPOON_SQUAD = "SFD-137";
const WINDSINGER = "SFD-138";
const SWITCHEROO = "SFD-145";
const DOWNWELL = "SFD-147";

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
    // An effect-driven move does not exhaust (415.1.b puts that on the ACTION).
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
    // 465: the Attacker is whoever applied Contested, so p1 (index 1) attacking
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
    // NON-COMBAT Showdown (341 / 317.1), and `beginCombatAt` — and therefore
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

  it("strips a Buff on the way out — rule 709", () => {
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

describe("coverage sees each of them", () => {
  // Corrupt Enforcer is NOT in this list: only his on-move half is written,
  // and "when I win a combat, draw 1" needs a combat-won event GameEvent does
  // not have. He now carries a coverage.PARTIALLY_IMPLEMENTED entry, so he must
  // report NOT implemented — asserted separately below, because a card that is
  // half written and a card that is finished are exactly what this file must
  // keep apart.
  for (const defId of [
    FAE_PORTER,
    LOYAL_PUP,
    OVERZEALOUS_FAN,
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


  it("Corrupt Enforcer is only HALF written, and nothing here claims otherwise", () => {
    // Registration is per defId, so his move clause makes the whole card report
    // DONE. "When I win a combat, draw 1" needs a combat-WON event this engine
    // does not have (466.5.a defines the concept; `GameEvent` has no producer for
    // it). The honest record is a coverage.PARTIALLY_IMPLEMENTED entry, which
    // the card-wave pass could not add because coverage.ts is shared — it has
    // since been written, so this test now asserts the RESULT rather than just
    // pinning the printed text and hoping somebody noticed.
    expect(registry.get(CORRUPT_ENFORCER).text).toContain("When I win a combat");
    expect(isCardImplemented(registry.get(CORRUPT_ENFORCER))).toBe(false);
    expect(partialImplementationNote(registry.get(CORRUPT_ENFORCER))).toContain("combat-won event");
  });
});
