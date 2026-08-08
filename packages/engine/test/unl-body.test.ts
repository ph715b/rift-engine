import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed's Body cards, driven through `submit` rather than through their
 * resolvers.
 *
 * Every assertion here goes through a real `PlayCard` or `MoveUnit` action that
 * `legalActions` enumerated, for the reason this project keeps rediscovering: a
 * resolver called directly passes whether or not the dispatch hop that reaches
 * it in a game exists. Four of these six cards hang off a HELD trigger
 * (`cardPlayed`, `unitMoved`) or a parked decision, and both of those are exactly
 * the hops that have silently dropped an effect here before.
 */

const registry = defaultCardRegistry();

const DEMACIAN_DIPLOMAT = "UNL-092"; // "When you play me, gain 1 XP."
const KINKOU_INITIATE = "UNL-097"; // "draw 1 if your other units have total Might 5 or more"
const GENTLE_GEMDRAGON = "UNL-104"; // "When you play me or another Dragon, ready up to 2 runes."
const IMPOSING_CHALLENGER = "UNL-105"; // "When I move, you may move an enemy unit here…"
const CLASH_OF_GIANTS = "UNL-110"; // "Choose two units. They deal damage equal to their Mights…"
const IRRESISTIBLE_FAEFOLK = "UNL-112"; // "When I move to a battlefield, you may move an enemy unit…"

const DUNE_DRAKE = "OGN-131"; // a Body unit TAGGED Dragon, and nothing else — the "another Dragon" fixture

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** The PlayCard action `legalActions` offers for a card sitting in hand. Found
 *  rather than hand-built, so a card the enumerator never offers fails here
 *  instead of being tested through a path no game can take — which for a
 *  `unitSlots` spell is most of what there is to get wrong. */
function playOf(
  state: GameState,
  instanceId: string,
  extra: (a: { targetUnitInstanceId?: string; secondTargetUnitInstanceId?: string }) => boolean = () => true,
) {
  const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === instanceId && extra(a));
  expect(action, `no play of ${instanceId} was enumerated`).toBeDefined();
  return action!;
}

function moveOf(state: GameState, instanceId: string, destination: string) {
  const action = legalActions(state).find(
    (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === destination && a.unitInstanceIds.includes(instanceId),
  );
  expect(action, `no move of ${instanceId} to ${destination} was enumerated`).toBeDefined();
  return action!;
}

const rune = (id: string, state: RuneCard["state"]): RuneCard => ({ id, domain: "Body", state });

/** Where a unit is standing, as a battlefield id or "base"/"gone". */
function locate(state: GameState, playerId: string, instanceId: string): string {
  const player = state.players.find((p) => p.id === playerId)!;
  if (player.baseUnits.some((u) => u.instanceId === instanceId)) return "base";
  const bf = state.battlefields.find((b) => (b.units[playerId] ?? []).some((u) => u.instanceId === instanceId));
  return bf?.id ?? "gone";
}

function findAnywhere(state: GameState, instanceId: string): UnitInstance | undefined {
  return [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);
}

describe("Demacian Diplomat (UNL-092): when you play me, gain 1 XP", () => {
  it("moves the XP counter through a real play", () => {
    const diplomat = realUnitInstance(DEMACIAN_DIPLOMAT);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [diplomat];
    state.players[0]!.floatingEnergy = 10;
    expect(state.players[0]!.xp, "the fixture started with XP").toBe(0);

    const played = resolveHeldTriggers(accept(state, playOf(state, diplomat.instanceId)));
    expect(played.players[0]!.xp, "the on-play trigger never reached the counter").toBe(1);
    expect(played.players[1]!.xp, "the opponent gained XP too").toBe(0);
  });
});

describe("Kinkou Initiate (UNL-097): draw 1 if your OTHER units have total Might 5 or more", () => {
  function initiateState(others: number[]): { state: GameState; initiate: UnitInstance } {
    const initiate = realUnitInstance(KINKOU_INITIATE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [initiate];
    state.players[0]!.floatingEnergy = 10;
    state.players[0]!.deck = [makeUnit({ name: "Top of deck" })];
    state.players[0]!.baseUnits = others.map((might, i) => makeUnit({ instanceId: `friend-${i}`, might }));
    return { state, initiate };
  }

  const handAfter = (state: GameState, initiate: UnitInstance): number =>
    resolveHeldTriggers(accept(state, playOf(state, initiate.instanceId))).players[0]!.hand.length;

  it("draws at exactly 5", () => {
    // "5 OR MORE" — the off-by-one that would make the card read "6 or more".
    const { state, initiate } = initiateState([3, 2]);
    expect(handAfter(state, initiate), "the draw never fired").toBe(1);
  });

  it("does not draw at 4", () => {
    const { state, initiate } = initiateState([3, 1]);
    expect(handAfter(state, initiate)).toBe(0);
  });

  it("does NOT count its own 3 Might — 'your OTHER units'", () => {
    // The load-bearing control. The Initiate is a 3-Might body and he is already
    // on the board when this resolves, so a sum that forgot to exclude him reads
    // 3 + 3 = 6 here and draws. With him excluded it is 3, and it must not.
    const { state, initiate } = initiateState([3]);
    expect(handAfter(state, initiate), "his own Might was counted").toBe(0);
  });

  it("counts a friendly unit standing at a BATTLEFIELD, not just base", () => {
    // "Your units" names no location (355.9.b), and the sum reads each one where
    // it stands — so a body at a battlefield has to count.
    const { state, initiate } = initiateState([]);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "far", might: 5 })] };
    expect(handAfter(state, initiate)).toBe(1);
  });

  it("does not count the OPPONENT's units", () => {
    const { state, initiate } = initiateState([]);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "foe", might: 9 })] };
    expect(handAfter(state, initiate), "an enemy body fed the count").toBe(0);
  });
});

describe("Gentle Gemdragon (UNL-104): when you play me OR another Dragon, ready up to 2 runes", () => {
  function gemdragonState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.floatingEnergy = 30;
    state.players[0]!.channeled = [rune("r1", "Exhausted"), rune("r2", "Exhausted"), rune("r3", "Exhausted")];
    return state;
  }

  const readyCount = (state: GameState, index: 0 | 1 = 0) =>
    state.players[index]!.channeled.filter((r) => r.state === "Ready").length;

  it("fires for HER OWN play — the half an 'another' guard would swallow", () => {
    // Cithria of Cloudfield's listener has to EXCLUDE her own arrival; this one
    // has to include it. `cardPlayed` is fired after the unit has landed, so the
    // listener walk reaches her — asserted rather than assumed, because a card
    // that never sees its own play is indistinguishable from an unwritten one.
    const state = gemdragonState();
    const gemdragon = realUnitInstance(GENTLE_GEMDRAGON);
    state.players[0]!.hand = [gemdragon];

    const played = resolveHeldTriggers(accept(state, playOf(state, gemdragon.instanceId)));
    expect(readyCount(played), "her own play readied nothing").toBe(2);
    expect(played.players[0]!.channeled[2]!.state, "'up to 2' readied a third").toBe("Exhausted");
  });

  it("fires for ANOTHER Dragon played while she is on the board", () => {
    const state = gemdragonState();
    const drake = realUnitInstance(DUNE_DRAKE); // tagged Dragon
    state.players[0]!.hand = [drake];
    state.players[0]!.baseUnits = [realUnitInstance(GENTLE_GEMDRAGON)];

    const played = resolveHeldTriggers(accept(state, playOf(state, drake.instanceId)));
    expect(readyCount(played), "the Dragon tag was never read").toBe(2);
  });

  it("does NOT fire for a non-Dragon unit — the tag is the condition", () => {
    const state = gemdragonState();
    const diplomat = realUnitInstance(DEMACIAN_DIPLOMAT); // Demacia, no Dragon tag
    state.players[0]!.hand = [diplomat];
    state.players[0]!.baseUnits = [realUnitInstance(GENTLE_GEMDRAGON)];

    const played = resolveHeldTriggers(accept(state, playOf(state, diplomat.instanceId)));
    expect(readyCount(played), "any unit at all readied her runes").toBe(0);
    expect(played.players[0]!.xp, "the Diplomat's own trigger did not fire either").toBe(1);
  });

  it("does NOT fire for the OPPONENT's Dragon — 'when YOU play'", () => {
    const state = gemdragonState();
    const drake = realUnitInstance(DUNE_DRAKE);
    state.players[0]!.baseUnits = [realUnitInstance(GENTLE_GEMDRAGON)];
    state.players[1]!.hand = [drake];
    state.players[1]!.floatingEnergy = 30;
    const theirTurn: GameState = { ...state, activePlayerIndex: 1, focusHolder: 1, chainPriority: 1 };

    const played = resolveHeldTriggers(accept(theirTurn, playOf(theirTurn, drake.instanceId)));
    expect(readyCount(played), "an opponent's Dragon readied her controller's runes").toBe(0);
  });
});

describe("Clash of Giants (UNL-110): choose two units, they deal their Mights to each other", () => {
  function clashState(): { state: GameState; clash: ReturnType<typeof spellInstance> } {
    const clash = spellInstance(CLASH_OF_GIANTS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [clash];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.channeled = [rune("r1", "Ready"), rune("r2", "Ready"), rune("r3", "Ready"), rune("r4", "Ready")];
    return { state, clash };
  }

  it("hits BOTH, and the one that dies still lands its full Might", () => {
    // The ordering the card's "to each other" depends on: a 4-Might dying to a
    // 6-Might must still put 4 on the 6 on its way out. Deal-then-read would
    // leave the survivor untouched, and would still look like a working card.
    const { state, clash } = clashState();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "big", might: 6 })],
      p2: [makeUnit({ instanceId: "small", might: 4 })],
    };

    const action = playOf(state, clash.instanceId, (a) => a.targetUnitInstanceId === "big" && a.secondTargetUnitInstanceId === "small");
    const cast = resolveHeldTriggers(accept(state, action));

    expect(locate(cast, "p2", "small"), "the 4-Might survived 6 damage").toBe("gone");
    expect(findAnywhere(cast, "big")?.damage, "the dying unit dealt no damage back").toBe(4);
  });

  it("offers TWO OF THE OPPONENT'S units — 'two units' names no owner", () => {
    // The one word that separates this from Challenge (OGN-128), which prints "a
    // friendly unit and an enemy unit". If the slots had been copied from
    // Challenge the card would still work and this pairing would be unreachable.
    const { state, clash } = clashState();
    state.battlefields[0]!.units = {
      p2: [makeUnit({ instanceId: "foe-a", might: 5 }), makeUnit({ instanceId: "foe-b", might: 5 })],
    };

    const action = playOf(
      state,
      clash.instanceId,
      (a) =>
        (a.targetUnitInstanceId === "foe-a" && a.secondTargetUnitInstanceId === "foe-b") ||
        (a.targetUnitInstanceId === "foe-b" && a.secondTargetUnitInstanceId === "foe-a"),
    );
    const cast = resolveHeldTriggers(accept(state, action));

    expect(locate(cast, "p2", "foe-a")).toBe("gone");
    expect(locate(cast, "p2", "foe-b")).toBe("gone");
  });

  it("reaches a unit sitting in a BASE — scope 'anywhere'", () => {
    // The printed text names no battlefield, so 355.9.b puts a body at home in
    // range. `scope: "battlefield"` (the default) would silently make this pairing
    // unenumerable.
    const { state, clash } = clashState();
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "front", might: 7 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "home", might: 2 })];

    const action = playOf(state, clash.instanceId, (a) =>
      [a.targetUnitInstanceId, a.secondTargetUnitInstanceId].includes("home"),
    );
    const cast = resolveHeldTriggers(accept(state, action));
    expect(locate(cast, "p2", "home"), "a unit in base was untouched").toBe("gone");
  });
});

describe("Irresistible Faefolk (UNL-112): when I move to a battlefield, you may drag an enemy there", () => {
  function faefolkState(): { state: GameState; faefolk: UnitInstance } {
    const faefolk = realUnitInstance(IRRESISTIBLE_FAEFOLK);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [faefolk];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "victim", might: 4 })];
    return { state, faefolk };
  }

  it("drags an enemy unit out of their BASE to the battlefield she entered", () => {
    const { state, faefolk } = faefolkState();
    const moved = resolveHeldTriggers(accept(state, moveOf(state, faefolk.instanceId, "bf1")));

    const question = pendingDecision(moved);
    expect(question?.kind, "her move raised no question").toBe("UNL-112-drag");
    const answered = answerDecisions(moved, (options) => options.find((o) => o.instanceId === "victim")!.id);

    expect(locate(answered, "p2", "victim"), "the enemy never moved").toBe("bf1");
  });

  it("DECLINING leaves the enemy where it was — 'you MAY'", () => {
    const { state, faefolk } = faefolkState();
    const moved = resolveHeldTriggers(accept(state, moveOf(state, faefolk.instanceId, "bf1")));
    const declined = answerDecisions(moved, (options) => options.find((o) => o.id === "decline")!.id);

    expect(locate(declined, "p2", "victim")).toBe("base");
  });

  it("asks nothing at all when the opponent controls no units", () => {
    const { state, faefolk } = faefolkState();
    state.players[1]!.baseUnits = [];
    const moved = resolveHeldTriggers(accept(state, moveOf(state, faefolk.instanceId, "bf1")));
    expect(pendingDecision(moved), "a question with no useful answer was raised").toBeUndefined();
  });
});

describe("Imposing Challenger (UNL-105): when I move, shove a weaker enemy here elsewhere", () => {
  /** The Challenger walking from base into `bf1`, where the opponent is standing. */
  function challengerState(enemyMight: number): { state: GameState; challenger: UnitInstance } {
    const challenger = realUnitInstance(IMPOSING_CHALLENGER); // 5 Might
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [challenger];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "weakling", might: enemyMight })] };
    return { state, challenger };
  }

  it("moves a WEAKER enemy at his destination to the other battlefield", () => {
    const { state, challenger } = challengerState(3);
    const moved = resolveHeldTriggers(accept(state, moveOf(state, challenger.instanceId, "bf1")));

    const question = pendingDecision(moved);
    expect(question?.kind, "his move raised no question").toBe("UNL-105-shove");
    // The destination question auto-resolves: with two battlefields, "a DIFFERENT
    // battlefield" leaves exactly one answer and `advanceDecisions` takes it.
    const answered = answerDecisions(moved, (options) => options.find((o) => o.instanceId === "weakling")!.id);

    expect(locate(answered, "p2", "weakling"), "the weaker enemy stayed put").toBe("bf2");
    expect(locate(answered, "p1", challenger.instanceId), "the Challenger moved himself").toBe("bf1");
  });

  it("never offers an EQUAL-Might enemy — 'LESS Might than me'", () => {
    // Strictly less, as printed. A `<=` would make a 5-Might Challenger able to
    // shove every 5-Might body in the set, which is most of them.
    const { state, challenger } = challengerState(5);
    const moved = resolveHeldTriggers(accept(state, moveOf(state, challenger.instanceId, "bf1")));
    expect(pendingDecision(moved), "an equal-Might body was offered").toBeUndefined();
  });

  it("DECLINING leaves the enemy where it was — 'you MAY'", () => {
    const { state, challenger } = challengerState(3);
    const moved = resolveHeldTriggers(accept(state, moveOf(state, challenger.instanceId, "bf1")));
    const declined = answerDecisions(moved, (options) => options.find((o) => o.id === "decline")!.id);
    expect(locate(declined, "p2", "weakling")).toBe("bf1");
  });

  it("ignores an enemy standing SOMEWHERE ELSE — 'an enemy unit HERE'", () => {
    const { state, challenger } = challengerState(3);
    // Move the weakling off his destination; nothing qualifies at bf1 any more.
    state.battlefields[0]!.units = {};
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "elsewhere", might: 1 })] };
    const moved = resolveHeldTriggers(accept(state, moveOf(state, challenger.instanceId, "bf1")));
    expect(pendingDecision(moved), "a unit at another battlefield was offered").toBeUndefined();
  });

  it("offers only battlefields OTHER than the one he just entered", () => {
    const { state, challenger } = challengerState(3);
    const three: GameState = {
      ...state,
      battlefields: [...state.battlefields, { id: "bf3", name: "Battlefield 3", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] }],
    };
    const moved = resolveHeldTriggers(accept(three, moveOf(three, challenger.instanceId, "bf1")));
    const chosen = answerDecisions(moved, (options, decision) =>
      decision.kind === "UNL-105-shove"
        ? options.find((o) => o.instanceId === "weakling")!.id
        : (expect(options.map((o) => o.id).sort(), "'a DIFFERENT battlefield' offered the one he is standing on").toEqual(["bf2", "bf3"]),
          options[0]!.id),
    );
    expect(locate(chosen, "p2", "weakling")).toBe("bf2");
  });
});

describe("coverage reports all six as implemented", () => {
  it("each defId is registered", () => {
    // Registration is per defId, so this proves only that SOMETHING answers for
    // each card — the behavioural assertions above are what prove it is the right
    // thing. It is here to catch the shape where a card lands in the wrong table
    // and reports done while doing nothing.
    for (const defId of [DEMACIAN_DIPLOMAT, KINKOU_INITIATE, GENTLE_GEMDRAGON, IMPOSING_CHALLENGER, CLASH_OF_GIANTS, IRRESISTIBLE_FAEFOLK]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} reports unimplemented`).toBe(true);
    }
  });
});
