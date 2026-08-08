import { describe, expect, it } from "vitest";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isMighty } from "../src/engine/granted-keywords.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, realGearInstance, realUnitInstance } from "./fixtures.js";

/**
 * "Becomes [Mighty]" — the ROUTES, not the two cards.
 *
 * Reported from playtesting: *"fiora legend doesn't trigger when one of my units
 * become mighty aswell as fiora, worthy."* Both cards were already written and
 * both had passing tests — `fiora-grand-duelist.test.ts` and
 * `sfd-existing-mechanisms.test.ts` — because both tested the ROUTES that work
 * (`giveMightThisTurn`, `addBuff`) or fired the event by hand.
 *
 * The bug is not in either card. `unitBecameMighty` is a before/after COMPARISON
 * (`withMightTransitions`), so it can only be seen by whatever the comparison is
 * wrapped around. This file is therefore a table of the WAYS a unit's Might can
 * cross 5, with the two Fiora listeners used only as the detector:
 *
 *  - SFD-205 Fiora - Grand Duelist (legend) — "when one of your units becomes
 *    [Mighty], you may exhaust me to channel 1 rune exhausted";
 *  - SFD-180 Fiora - Worthy (unit) — "when a unit you control becomes [Mighty],
 *    you may pay [Order] to ready it".
 *
 * Rule 715 (the "Mighty" section): "A Unit 'becomes Mighty' at the moment its
 * Might changes from being less than 5 to being 5 or greater", and "Units on the
 * board are evaluated according to their CURRENT Might" — current, so auras,
 * Equipment badges and this-turn pumps all count towards the crossing.
 */

const GRAND_DUELIST = "SFD-205";
const WORTHY = "SFD-180";
const BFS = "SFD-161"; // B.F. Sword — [Equip] 1 Order, +3 Might badge
const TRIFARIAN_WAR_CAMP = "OGN-294"; // "Units here have +1 Might."

/**
 * p1 runs Fiora - Grand Duelist as their legend and a real Fiora - Worthy in
 * base, with Order runes channeled so Worthy's own cost check passes.
 *
 * BOTH detectors on one board deliberately: the report names both cards, and a
 * route that misses the transition misses them together — which is exactly the
 * evidence that the fault is the transition and not either card.
 */
function board(): GameState {
  const worthy = realUnitInstance(WORTHY);
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [worthy],
        // Order runes: Fiora - Worthy's `applies` refuses to offer a payment
        // nobody can make, so without these she is silent for a legitimate reason
        // and the test would measure the wrong thing.
        channeled: [
          { id: "o1", domain: "Order", state: "Ready" },
          { id: "o2", domain: "Order", state: "Ready" },
        ],
        // Fiora - Grand Duelist channels from here; an empty deck makes her
        // payoff a silent no-op.
        runeDeck: Array.from({ length: 4 }, (_, i) => ({ id: `rd${i}`, domain: "Order" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: GRAND_DUELIST };
  return state;
}

/**
 * Which of the two listeners PLACED a Pending Item for this moment.
 *
 * Read off the chain after `runCleanup` drains the pen — deliberately NOT after
 * resolving down to a `pendingDecision`, which is what the first draft of this
 * file did and which measured the wrong thing: both Fioras place items, the
 * chain resolves LIFO (343), so the legend's question is already parked and its
 * chain entry gone by the time the unit's is at the front. That reads as "only
 * one fired" for a board where both did.
 */
function whoTriggered(state: GameState): string[] {
  return runCleanup(state)
    .spellChain.filter((e): e is typeof e & { listenerDefId: string } => "listenerDefId" in e)
    .map((e) => e.listenerDefId)
    .filter((id) => id === GRAND_DUELIST || id === WORTHY)
    .sort();
}

/** Drains the pen onto the chain and passes focus until a question is on the
 *  table — the real path a player reaches these offers by. */
function settled(state: GameState): GameState {
  let current = runCleanup(state);
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

/** The first offer actually PUT to the player. A held item nobody is ever asked
 *  about is not a working trigger. */
function firstQuestion(state: GameState): string | undefined {
  return pendingDecision(settled(state))?.kind;
}

/**
 * Answers every offer this moment raises, taking `wanted` where it is on the
 * menu and declining otherwise.
 *
 * `fixtures.answerDecisions` is deliberately NOT used, and the reason is the
 * chain: it stops the instant `pendingDecision` is empty, which is true between
 * two triggers of the same moment — the second is still a chain ENTRY and needs
 * focus passed before it becomes a question. That made the second Fiora look
 * unanswered when she had simply not been asked yet.
 */
function takeEveryOffer(state: GameState, wanted: readonly string[]): GameState {
  let current = state;
  for (let guard = 0; guard < 8; guard += 1) {
    current = settled(current);
    const decision = pendingDecision(current);
    if (!decision) return current;
    const options = optionsFor(current, decision);
    const pick = options.find((o) => wanted.includes(o.id)) ?? options[0]!;
    current = answerDecision(current, decision.id, pick.id)!;
  }
  throw new Error("takeEveryOffer: the queue never emptied");
}

describe("routes to [Mighty] that DO fire", () => {
  /** The positive control for the harness itself: a route already bracketed by
   *  `withMightTransitions`. If this ever goes quiet, every negative below is
   *  meaningless. */
  it("a this-turn pump across 5 fires BOTH Fioras", () => {
    const state = board();
    const pumped = giveMightThisTurn(state, state.players[0]!.baseUnits[0]!.instanceId, 2); // Worthy is 3 Might

    expect(whoTriggered(pumped), "the control route stopped working").toEqual([WORTHY, GRAND_DUELIST].sort());
    expect(firstQuestion(pumped), "held but never asked").toBe("SFD-205-channel");
  });
});

describe("routes to [Mighty] that were MISSED (playtest report, 2026-08-08)", () => {
  /**
   * **The reported bug.** An Equipment's "+N Might" badge is part of the wearer's
   * current Might (`effectiveMight` reads `equipmentMightBonusFor`), so attaching
   * a +3 B.F. Sword to a 3-Might unit takes it from 3 to 6 and it becomes Mighty
   * by 715's definition. `attachEquipment` is the single writer of
   * `attachedToInstanceId` and holds its own `equipmentAttached` event — but it
   * was not bracketed by `withMightTransitions`, so the crossing was invisible.
   *
   * Driven through the REAL enumerate-and-submit `[Equip]` path, not
   * `attachEquipment` directly, because that is how a player reaches it and a
   * dispatch hop is exactly where an effect goes missing.
   */
  it("attaching an Equipment whose badge crosses 5 fires both Fioras", () => {
    const state = board();
    const sword = realGearInstance(BFS);
    state.players[0]!.activeGear = [sword];
    // Exhausted, so Fiora - Worthy's ready is worth something and can be SEEN.
    // An already-ready unit takes her "pay" option off the menu entirely.
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.map((u) => ({ ...u, exhausted: true }));
    const worthyId = state.players[0]!.baseUnits[0]!.instanceId;

    const equip = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === sword.instanceId,
    );
    expect(equip, "no [Equip] was offered — the fixture is wrong, not the engine").toBeDefined();

    const { state: attached, result } = submit(state, equip!);
    expect(result, `[Equip] refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    // The premise, asserted rather than assumed: the attach really happened and
    // the unit really is Mighty now. Without this the trigger assertions below
    // would read the same if the [Equip] had silently done nothing.
    const wearer = attached.players[0]!.baseUnits.find((u) => u.instanceId === worthyId)!;
    expect(effectiveMight(attached, wearer, 0, { isCombat: false }), "the badge did not land").toBe(6);

    expect(whoTriggered(attached)).toEqual([WORTHY, GRAND_DUELIST].sort());

    // ...and it is not merely HELD. Answered all the way through, both offers,
    // and the board moves: the legend's rune arrives and the unit stands up.
    // A Pending Item nobody is ever asked about is not a working trigger.
    const answered = takeEveryOffer(attached, ["channel", "pay"]);
    expect(answered.players[0]!.legend.exhausted, "Fiora - Grand Duelist never paid her exhaust").toBe(true);
    expect(answered.players[0]!.channeled.some((r) => r.state === "Exhausted"), "no rune was channeled").toBe(true);
    expect(
      answered.players[0]!.baseUnits.find((u) => u.instanceId === worthyId)!.exhausted,
      "Fiora - Worthy's ready never happened",
    ).toBe(false);
  });

  /**
   * A POSITIONAL aura is part of current Might too, and `withMightTransitions`
   * asked `effectiveMight` with no `battlefieldId` — so every unit standing at a
   * battlefield was measured as if it were in base.
   *
   * Trifarian War Camp ("units here have +1 Might") is the cheapest source: a
   * 3-Might unit standing there is really 4, and a +1 pump really makes it 5.
   * With the battlefield omitted the comparison saw 3 -> 4 and stayed silent.
   */
  it("a pump that only reaches 5 WITH the battlefield's aura fires both Fioras", () => {
    const state = board();
    state.battlefields[0] = { ...state.battlefields[0]!, defId: TRIFARIAN_WAR_CAMP };
    const grunt = makeUnit({ name: "Grunt", instanceId: "grunt", might: 3 });
    state.battlefields[0]!.units = { p1: [grunt] };
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits];

    expect(
      effectiveMight(state, grunt, 0, { isCombat: false, battlefieldId: state.battlefields[0]!.id }),
      "the War Camp aura is not applying — the fixture is wrong",
    ).toBe(4);

    const after = giveMightThisTurn(state, "grunt", 1); // 4 -> 5: Mighty
    expect(whoTriggered(after)).toEqual([WORTHY, GRAND_DUELIST].sort());
  });

  /**
   * The same omission in the other direction, and it is the worse half: a unit
   * that is ALREADY Mighty because of the aura reads as un-Mighty, so pumping it
   * fires a trigger that rule 715 says must not fire ("A Unit with Might 5 that
   * gets +1 does not become Mighty, because it was already Mighty").
   */
  it("does NOT fire for a unit the aura had already made Mighty", () => {
    const state = board();
    state.battlefields[0] = { ...state.battlefields[0]!, defId: TRIFARIAN_WAR_CAMP };
    const brute = makeUnit({ name: "Brute", instanceId: "brute", might: 4 }); // 5 here: already Mighty
    state.battlefields[0]!.units = { p1: [brute] };

    const after = giveMightThisTurn(state, "brute", 1); // 5 -> 6, not a crossing
    expect(whoTriggered(after), "fired on a unit that was already Mighty").toEqual([]);
  });
});

/**
 * The same omission in the OTHER Might question. `isMighty` — "while I'm
 * [Mighty]" (Fiora - Victorious) and "when you play a [Mighty] unit"
 * (Volibear) — asked `effectiveMight` with no `battlefieldId` too.
 *
 * Found while fixing the transition, and worth its own check because
 * `legend-abilities.ts`'s own comment CLAIMS the opposite: "his body already
 * looked the unit up on the BOARD by that id … so that a 4-Might unit under a
 * Garen aura counts as Mighty". Garen - Commander's aura is positional, so it
 * did not.
 */
describe("'is Mighty' counts the aura where the unit is STANDING", () => {
  it("a 4-Might unit at a Trifarian War Camp is Mighty", () => {
    const state = makeState();
    state.battlefields[0] = { ...state.battlefields[0]!, defId: TRIFARIAN_WAR_CAMP };
    const grunt = makeUnit({ name: "Grunt", instanceId: "grunt", might: 4 });
    state.battlefields[0]!.units = { p1: [grunt] };

    expect(isMighty(state, grunt, 0), "the +1 from the ground under it was not counted").toBe(true);
  });

  it("...and the same unit in base is not", () => {
    const state = makeState();
    const grunt = makeUnit({ name: "Grunt", instanceId: "grunt2", might: 4 });
    state.players[0]!.baseUnits = [grunt];

    expect(isMighty(state, grunt, 0)).toBe(false);
  });
});

describe("what still does NOT fire — one correct, two open", () => {
  /**
   * CORRECT. A unit ENTERING play already at 5+ Might is not a crossing, and that
   * is the rules rather than a gap: 715 evaluates a unit in a non-board zone by
   * its PRINTED Might, so a 5-Might unit in hand is already Mighty and playing it
   * changes nothing. Pinned so nobody "fixes" it into a trigger.
   */
  it("playing a unit that is already 5 Might is not a crossing", () => {
    const state = board();
    const giant = makeUnit({ name: "Giant", instanceId: "giant", might: 6 });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, giant];

    expect(whoTriggered(state), "entering play was treated as becoming Mighty").toEqual([]);
  });

  /**
   * **The recorded partial that remains open.** A unit that crosses 5 because an
   * AURA SOURCE arrived beside it never changed, and no operation on that unit
   * brackets the moment — closing it needs the layer re-evaluation this engine
   * does not have (rule 2701's "the layers are re-checked"). Attaching the
   * Equipment below is done to a DIFFERENT unit, so nothing about the grunt is
   * written and nothing compares its before with its after.
   *
   * Asserted as still-broken so that closing it fails loudly here rather than
   * silently changing behaviour nobody was watching.
   */
  it("an aura source ARRIVING is still not seen (open divergence)", () => {
    const state = board();
    // Move the grunt onto a battlefield that gains its War Camp identity only
    // after the grunt is standing on it — the cheapest "an aura appeared" there
    // is, and it writes nothing about the grunt.
    const grunt = makeUnit({ name: "Grunt", instanceId: "grunt", might: 4 });
    state.battlefields[0]!.units = { p1: [grunt] };

    const auraArrived = { ...state, battlefields: [{ ...state.battlefields[0]!, defId: TRIFARIAN_WAR_CAMP }, state.battlefields[1]!] };
    expect(effectiveMight(auraArrived, grunt, 0, { isCombat: false, battlefieldId: "bf1" }), "premise").toBe(5);
    expect(whoTriggered(auraArrived), "the aura-arrival partial has closed — update the docs row").toEqual([]);
  });

  /**
   * **OPEN, and the mirror of the row above.** A unit that WALKS INTO a positional
   * aura crosses 5 for the same reason a unit the aura walked up to does. This
   * half is now visible where it was not before — `withMightTransitions` reads the
   * battlefield — but nothing brackets a MOVE, so the comparison is never made.
   *
   * Deliberately NOT fixed here. A move reaches the board from four places (the
   * `MoveUnit` action, `effect-helpers.moveUnitToBattlefield` for Charm-shaped
   * cards, combat's own relocation, and the recall to base), and bracketing one
   * of them would make the trigger fire for a hand-moved unit and not for a
   * Charm-moved one — an inconsistency worse than the uniform silence.
   *
   * Measured through the REAL `MoveUnit` submit path: chain empty.
   */
  it("MOVING onto an aura battlefield is still not seen (open)", () => {
    const state = board();
    state.battlefields[0] = { ...state.battlefields[0]!, defId: TRIFARIAN_WAR_CAMP };
    state.players[0]!.baseUnits = [
      ...state.players[0]!.baseUnits,
      makeUnit({ name: "Grunt", instanceId: "grunt", might: 4 }),
    ];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds.includes("grunt") && a.destinationBattlefieldId === "bf1",
    );
    expect(move, "no move was offered — the fixture is wrong").toBeDefined();
    const { state: moved, result } = submit(state, move!);
    expect(result, `move refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    const grunt = moved.battlefields[0]!.units.p1!.find((u) => u.instanceId === "grunt")!;
    expect(effectiveMight(moved, grunt, 0, { isCombat: false, battlefieldId: "bf1" }), "premise").toBe(5);
    expect(whoTriggered(moved), "the move-into-aura gap has closed — update the docs row").toEqual([]);
  });
});
