import { describe, expect, it } from "vitest";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords, isMighty } from "../src/engine/granted-keywords.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { recordConquest } from "../src/engine/scoring.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { UnitInstance } from "../src/model/card.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import { beginCombatAt, makePlayer, makeState, makeUnit, realGearInstance, realUnitInstance, spellInstance, keepTriggerOrder } from "./fixtures.js";

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
 * Rule 709 (the "Mighty" section): "A Unit 'becomes Mighty' at the moment its
 * Might changes from being less than 5 to being 5 or greater", and "Units on the
 * board are evaluated according to their CURRENT Might" — current, so auras,
 * Equipment badges and this-turn pumps all count towards the crossing.
 */

const GRAND_DUELIST = "SFD-205";
const WORTHY = "SFD-180";
const BFS = "SFD-161"; // B.F. Sword — [Equip] 1 Order, +3 Might badge
const TRIFARIAN_WAR_CAMP = "OGN-294"; // "Units here have +1 Might."
const FIORA_VICTORIOUS = "OGN-232"; // 4 Might, "While I'm [Mighty], I have [Deflect], [Ganking], and [Shield]."
const SHOW_OF_STRENGTH = "SFD-106"; // "[Reaction] Draw 1 for each of your [Mighty] units."
const DISCIPLINE = "OGN-058"; // "[Reaction] Give a unit +2 Might this turn. Draw 1."
const TARIC_PROTECTOR = "OGN-074"; // "Other friendly units here have [Shield]."
const SHEN_KINKOU = "OGN-241"; // 3 Might, [Reaction], [Shield 2] — 5 while defending
const VOLIBEAR_STORM = "OGN-249"; // "When you play a [Mighty] unit, you may exhaust me to channel 1 rune exhausted."
const SUNKEN_TEMPLE = "SFD-218"; // "When you conquer here with one or more [Mighty] units..."

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
 * chain resolves LIFO (340.1), so the legend's question is already parked and its
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
  // `keepTriggerOrder` runs on every step, not once at the end: 383.3.d's
  // ordering question is raised the moment the pen is finalized, and this loop
  // BREAKS on any pending decision — so leaving it unanswered here would stop the
  // walk before a single chain item resolved, and no card's question would ever
  // be reached.
  let current = keepTriggerOrder(runCleanup(state));
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = keepTriggerOrder(submit(current, pass).state);
  }
  return current;
}

/** The first offer actually PUT to the player. A held item nobody is ever asked
 *  about is not a working trigger. */
function firstQuestion(state: GameState): string | undefined {
  // **383.3.d's ordering question is settled first, and only then is the CARD's
  // question read.** Two Fioras are two distinct sources triggering at once, so
  // the engine now correctly asks their controller which resolves first — a
  // question about the chain, not about either card, and not what any assertion
  // in this file is about. `keepTriggerOrder` answers it with the order already
  // placed, so nothing else here moves.
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

  /**
   * **The higher-of-two ruling reaching the TRANSITION, through the real play
   * path.** `withMightTransitions` now asks `granted-keywords.isMighty` instead of
   * running its own comparison, so a pump landing INSIDE a combat is scored
   * against the combat Might — a 2-Might `[Shield 1]` defender is at 3 while the
   * Showdown is open, and Discipline's +2 takes it to 5 and no further out of it.
   *
   * With the old `isCombat: false` comparison this is 2 -> 4 and silent, which is
   * what makes this the positive control for that half of the change: the level
   * check and the transition check would otherwise have been changed by different
   * tests and could drift apart again.
   *
   * A `[Reaction]` is the only card that can be cast into an open Showdown, so
   * Discipline (OGN-058, "Give a unit +2 Might this turn. Draw 1.") is how this
   * route is reachable at all in a real game.
   */
  it("a [Reaction] pump cast INSIDE a combat, reaching 5 only via [Shield], fires both Fioras", () => {
    const state = board();
    state.activePlayerIndex = 1; // p2 attacks; p1's two Fioras are the defender's listeners
    const wall = makeUnit({ name: "Wall", instanceId: "wall", might: 2, keywords: { Shield: 1 } });
    state.battlefields[0]!.units = { p1: [wall], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.hand = [spellInstance(DISCIPLINE)];
    state.players[0]!.floatingEnergy = 2;
    state.players[0]!.deck = [makeUnit({ name: "Drawn", might: 1 })];

    let current = beginCombatAt(state, "bf1", 1);
    expect(current.showdownKind, "no combat opened — the fixture is wrong").toBe("Combat");
    // The premise both ways: 3 in combat now, and the pump lands exactly on 5.
    expect(isMighty(current, current.battlefields[0]!.units.p1![0]!, 0), "premise: not Mighty yet").toBe(false);

    // The attacker holds Focus first, so the defender only acts after a pass.
    current = submit(current, legalActions(current).find((a) => a.type === "PassFocus")!).state;

    const play = legalActions(current).find(
      (a) => a.type === "PlayCard" && (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === "wall",
    );
    expect(play, "Discipline was never offered on the Wall inside the Showdown").toBeDefined();
    const { state: cast, result } = submit(current, play!);
    expect(result, `the cast was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    let resolved = cast;
    // Stop as soon as the SPELL is off the chain — the Fiora triggers it fires go
    // straight back on, so waiting for an empty chain would never terminate.
    for (let guard = 0; guard < 4 && resolved.spellChain.some(isSpellChainEntry); guard += 1) {
      const pf = legalActions(resolved).find((a) => a.type === "PassFocus");
      if (!pf) break;
      resolved = submit(resolved, pf).state;
    }
    expect(
      resolved.battlefields[0]!.units.p1![0]!.mightThisTurn,
      "Discipline never resolved — the route below would be measuring nothing",
    ).toBe(2);

    expect(whoTriggered(resolved)).toEqual([WORTHY, GRAND_DUELIST].sort());
  });
});

describe("routes to [Mighty] that were MISSED (playtest report, 2026-08-08)", () => {
  /**
   * **The reported bug.** An Equipment's "+N Might" badge is part of the wearer's
   * current Might (`effectiveMight` reads `equipmentMightBonusFor`), so attaching
   * a +3 B.F. Sword to a 3-Might unit takes it from 3 to 6 and it becomes Mighty
   * by 709's definition. `attachEquipment` is the single writer of
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
   * fires a trigger that rule 709 says must not fire ("A Unit with Might 5 that
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

/**
 * **PROJECT-OWNER RULING, 2026-08-08: in combat, "is Mighty" takes the HIGHER of
 * the two combat roles.**
 *
 * The rules' own worked example (the pair of Fiora - Victorious examples that sit
 * under 476's layer loop, immediately before 477 lists the layer order) ends:
 * *"While a buffed Fiora, Victorious is in combat as a defender, an additional +1
 * Might will be applied in the Arithmetic layer, giving her 6 Might and the 3
 * keywords."* So `[Shield]`'s bonus is part of a defender's CURRENT Might, and
 * `[Assault]`'s is part of an attacker's — which means entering combat can make a
 * unit Mighty.
 *
 * This engine has no single combat Might: `MightContext.combatRole` splits it into
 * "outgoing" (what the unit deals — `[Assault]` while attacking, never `[Shield]`)
 * and "remaining" (what it can absorb — `[Assault]` while attacking, `[Shield]`
 * while defending). The ruling resolves that: EITHER reaching 5 is Mighty.
 *
 * Both halves are asserted here, because "higher of two" is only meaningful if the
 * two genuinely differ — a `[Shield]` unit is Mighty defending and not attacking,
 * and the mirror holds for `[Assault]`.
 */
describe("in combat, 'is Mighty' takes the HIGHER of the two roles (owner ruling)", () => {
  /** A Combat Showdown at bf1 with `unit` on p1's side and `attackerIndex`
   *  attacking. Staged through the real Cleanup (`beginCombatAt`) rather than by
   *  writing `showdownKind` by hand, so the designations are the ones a real
   *  attack hands out. */
  function inCombat(unit: UnitInstance, attackerIndex: 0 | 1): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: attackerIndex });
    state.battlefields[0]!.units = { p1: [unit], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = attackerIndex === 0 ? "p2" : "p1";
    return beginCombatAt(state, "bf1", attackerIndex);
  }

  const wall = () => makeUnit({ name: "Wall", instanceId: "wall", might: 4, keywords: { Shield: 1 } });
  const raider = () => makeUnit({ name: "Charger", instanceId: "charger", might: 4, keywords: { Assault: 1 } });

  it("a 4-Might [Shield 1] unit DEFENDING is Mighty", () => {
    const combat = inCombat(wall(), 1);
    const defender = combat.battlefields[0]!.units.p1![0]!;

    // The premise, measured through the two roles the engine really computes, so
    // a failure below cannot be a broken fixture: only "remaining" reaches 5.
    const ctx = { isCombat: true as const, isAttackingSide: false, battlefieldId: "bf1" };
    expect(effectiveMight(combat, defender, 0, { ...ctx, combatRole: "outgoing" })).toBe(4);
    expect(effectiveMight(combat, defender, 0, { ...ctx, combatRole: "remaining" })).toBe(5);

    expect(isMighty(combat, defender, 0), "[Shield]'s +1 was not counted towards Mighty").toBe(true);
  });

  it("...and the SAME unit attacking is not — [Shield] is never outgoing and never helps an attacker", () => {
    const combat = inCombat(wall(), 0);
    const attacker = combat.battlefields[0]!.units.p1![0]!;

    expect(isMighty(combat, attacker, 0), "[Shield] paid off on the attacking side").toBe(false);
  });

  it("a 4-Might [Assault 1] unit ATTACKING is Mighty", () => {
    const combat = inCombat(raider(), 0);
    const attacker = combat.battlefields[0]!.units.p1![0]!;

    // [Assault] is the asymmetric one: it lifts BOTH roles while attacking, which
    // is why this is the higher-of-two rule's other half rather than a repeat.
    const ctx = { isCombat: true as const, isAttackingSide: true, battlefieldId: "bf1" };
    expect(effectiveMight(combat, attacker, 0, { ...ctx, combatRole: "outgoing" })).toBe(5);

    expect(isMighty(combat, attacker, 0)).toBe(true);
  });

  it("...and the same unit defending is not", () => {
    const combat = inCombat(raider(), 1);
    expect(isMighty(combat, combat.battlefields[0]!.units.p1![0]!, 0)).toBe(false);
  });

  /** The negative control for the whole ruling: it is the COMBAT that makes these
   *  units Mighty, so out of one they must both read 4. Without this every
   *  assertion above would still pass if the threshold had simply been lowered. */
  it("neither is Mighty with no combat open", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [wall(), raider()] };

    for (const u of state.battlefields[0]!.units.p1!) {
      expect(isMighty(state, u, 0), `${u.name} was Mighty outside combat`).toBe(false);
    }
  });

  /**
   * A unit in a Combat Showdown SOMEWHERE ELSE is not in combat. `isMighty` has to
   * ask where the fight is, not merely whether one is happening — otherwise a
   * `[Shield]` unit sitting quietly at bf2 would gain a defender's +1.
   */
  it("a [Shield] unit at a different battlefield from the combat is not Mighty", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Bait", might: 1 })], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.units = { p1: [wall()] };
    const combat = beginCombatAt(state, "bf1", 1);

    expect(combat.showdownBattlefieldId, "the fixture opened the wrong Showdown").toBe("bf1");
    expect(isMighty(combat, combat.battlefields[1]!.units.p1![0]!, 0)).toBe(false);
  });
});

/**
 * The self-referential case, and the reason the ruling could not be a one-line
 * `isCombat: true` — Fiora - Victorious has `[Shield]` ONLY while she is Mighty,
 * so a naive read asks her Might to answer its own question.
 *
 * 476's layer loop settles it without a tie-break: *"Each effect in them is
 * applied as soon as able, and only a single time across all sequences."* Her
 * `[Shield]` is granted in the Ability-Altering layer, which is re-checked only
 * AFTER the Arithmetic layer has already produced a Might of 5 — so the +1 that
 * `[Shield]` is worth can never be part of the arithmetic that made her Mighty.
 * The two examples in the PDF walk the buffed case up (4 -> 5 -> 6 with three
 * keywords) and back down again (6 with three keywords -> 4 with none).
 */
describe("a keyword a unit has ONLY by being Mighty cannot make it Mighty (476)", () => {
  function fioraDefending(buffed: boolean): GameState {
    const fiora = { ...realUnitInstance(FIORA_VICTORIOUS), buffed };
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [fiora], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";
    return beginCombatAt(state, "bf1", 1);
  }

  it("an UNBUFFED Fiora - Victorious defending stays 4 Might with no keywords", () => {
    const combat = fioraDefending(false);
    const fiora = combat.battlefields[0]!.units.p1![0]!;

    // Terminates at all: a grant that read its own [Shield] would recurse until
    // the stack gave out, which is a hang rather than a wrong answer.
    expect(isMighty(combat, fiora, 0), "she bootstrapped herself Mighty off her own [Shield]").toBe(false);
    expect(Object.keys(effectiveKeywords(combat, fiora, 0))).toEqual([]);
    expect(
      effectiveMight(combat, fiora, 0, { isCombat: true, isAttackingSide: false, combatRole: "remaining", battlefieldId: "bf1" }),
    ).toBe(4);
  });

  it("a BUFFED Fiora - Victorious defending is 6 Might with the three keywords (the PDF's worked example)", () => {
    const combat = fioraDefending(true);
    const fiora = combat.battlefields[0]!.units.p1![0]!;

    expect(isMighty(combat, fiora, 0)).toBe(true);
    expect(Object.keys(effectiveKeywords(combat, fiora, 0)).sort()).toEqual(["Deflect", "Ganking", "Shield"]);
    expect(
      effectiveMight(combat, fiora, 0, { isCombat: true, isAttackingSide: false, combatRole: "remaining", battlefieldId: "bf1" }),
      "the rules example says 6",
    ).toBe(6);
  });

  /**
   * The suppression is TARGETED, and this is the test that says so. Taric -
   * Protector's "other friendly units here have [Shield]" is an ordinary aura, not
   * a Mighty-conditional grant, so the +1 it is worth to a defender IS part of the
   * arithmetic that decides Fiora is Mighty — and once she is, her own three
   * keywords land on top.
   *
   * That is 476's loop run out: Ability-Altering pass 1 gives her Taric's
   * `[Shield]` (his condition is a location, not her Might); Arithmetic makes her
   * 5; the layer is re-checked and now grants her own three. A blanket "ignore
   * all keywords while asking" would have left her at 4 with nothing.
   *
   * Her defending toughness then reads 6, not 5. 476's "each effect applied only
   * a single time" is about each EFFECT, and there are two here — Taric's and her
   * own — so 814.2 sums their Shield Values. This test asserted 5 while every
   * keyword merge in the engine took a `Math.max` on a citation of "817.1.a",
   * which is Vision's "It is present on Permanents". See keyword-stacking.ts.
   */
  it("a [Shield] from ANOTHER card does make Fiora - Victorious Mighty in combat", () => {
    const fiora = realUnitInstance(FIORA_VICTORIOUS); // 4 Might, unbuffed
    const taric = realUnitInstance(TARIC_PROTECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [fiora, taric], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";
    const combat = beginCombatAt(state, "bf1", 1);
    const her = combat.battlefields[0]!.units.p1!.find((u) => u.defId === FIORA_VICTORIOUS)!;

    expect(isMighty(combat, her, 0), "Taric's [Shield] was suppressed along with her own").toBe(true);
    expect(Object.keys(effectiveKeywords(combat, her, 0)).sort()).toEqual(["Deflect", "Ganking", "Shield"]);
    // 4 + Taric's [Shield 1] + her own [Shield 1], summed under 814.2.
    expect(effectiveKeywords(combat, her, 0).Shield, "the two [Shield] sources did not sum").toBe(2);
    expect(
      effectiveMight(combat, her, 0, { isCombat: true, isAttackingSide: false, combatRole: "remaining", battlefieldId: "bf1" }),
    ).toBe(6);
  });
});

/**
 * The ruling through a REAL card on the REAL submit path, not through `isMighty`
 * directly — Show of Strength is `[Reaction]`, so it is the one Mighty-counting
 * card that can actually be cast while a Combat Showdown is open, which makes it
 * the only place in the pool where this ruling is observable in play.
 *
 * It draws 0 before the ruling and 1 after, off exactly the same board.
 */
describe("a Mighty-counting card cast INSIDE a combat sees the combat Might", () => {
  it("Show of Strength draws for a defender that is Mighty only in combat", () => {
    const wall = makeUnit({ name: "Wall", instanceId: "wall", might: 4, keywords: { Shield: 1 } });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [wall], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.hand = [spellInstance(SHOW_OF_STRENGTH)];
    state.players[0]!.floatingEnergy = 2;
    state.players[0]!.channeled = [{ id: "b1", domain: "Body", state: "Ready" }];
    state.players[0]!.deck = [makeUnit({ name: "Drawn", might: 1 }), makeUnit({ name: "Spare", might: 1 })];

    let current = beginCombatAt(state, "bf1", 1);
    expect(current.showdownKind, "no combat opened — the fixture is wrong").toBe("Combat");

    // The attacker holds Focus first; the defender only gets to answer after a
    // pass. Both hops go through `submit`, because a dispatch hop is exactly
    // where a Reaction goes missing.
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "the attacker had no PassFocus").toBeDefined();
    current = submit(current, pass!).state;

    const play = legalActions(current).find((a) => a.type === "PlayCard");
    expect(play, "Show of Strength was never offered inside the Showdown").toBeDefined();
    const { state: cast, result } = submit(current, play!);
    expect(result, `the cast was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    // Resolve the chain without closing the Showdown — two passes pop the spell
    // and the combat is still open when it counts.
    let resolved = cast;
    for (let guard = 0; guard < 4 && resolved.spellChain.length > 0; guard += 1) {
      const pf = legalActions(resolved).find((a) => a.type === "PassFocus");
      if (!pf) break;
      resolved = submit(resolved, pf).state;
    }
    expect(resolved.spellChain, "the spell never resolved").toHaveLength(0);
    expect(resolved.showdownKind, "the combat closed before the spell resolved").toBe("Combat");

    expect(resolved.players[0]!.hand.map((c) => c.name), "the [Shield] defender was not counted as Mighty").toEqual([
      "Drawn",
    ]);
  });

  /**
   * Volibear - Relentless Storm — "when you play a `[Mighty]` unit". The second
   * card the ruling changes in play, and the route is the pool's OTHER way into an
   * open Showdown: a `[Reaction]` UNIT. Shen - Kinkou is 3 Might with `[Shield 2]`,
   * so he is 5 the instant he lands on a battlefield he is defending, and Volibear
   * fires for a body that reads 3 everywhere else.
   *
   * Played to the battlefield deliberately, not to base — the base copy of the same
   * action is enumerated alongside it and is the negative control for the whole
   * thing: a Shen in base is not in the combat and is not Mighty.
   *
   * `[Ambush]` is unimplemented, so the four `[Reaction]` units in OGN/SFD are the
   * only units that can reach an open combat at all; that is what bounds this
   * consequence to those cards for now.
   */
  it("Volibear fires for a [Shield 2] Reaction unit played INTO the combat it defends", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: VOLIBEAR_STORM };
    state.players[0]!.hand = [realUnitInstance(SHEN_KINKOU)];
    state.players[0]!.floatingEnergy = 3;
    state.players[0]!.channeled = [{ id: "o1", domain: "Order", state: "Ready" }];
    state.players[0]!.runeDeck = [{ id: "rd1", domain: "Order", state: "Ready" }];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Holder", might: 1 })],
      p2: [makeUnit({ name: "Raider", might: 2 })],
    };
    state.battlefields[0]!.controllerId = "p1";

    let current = beginCombatAt(state, "bf1", 1);
    current = submit(current, legalActions(current).find((a) => a.type === "PassFocus")!).state;

    const plays = legalActions(current).filter((a) => a.type === "PlayCard");
    const toBattlefield = plays.find((a) => (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === "bf1");
    const toBase = plays.find((a) => (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === undefined);
    expect(toBattlefield, "Shen was never offered into the combat").toBeDefined();
    expect(toBase, "the base play is the negative control and was not offered").toBeDefined();

    const { state: landed, result } = submit(current, toBattlefield!);
    expect(result, `the Reaction was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(
      landed.spellChain.filter((e) => "listenerDefId" in e).map((e) => (e as { listenerDefId: string }).listenerDefId),
    ).toEqual([VOLIBEAR_STORM]);

    // Same card, same combat, played to BASE: nothing. This is what makes the
    // assertion above about the COMBAT rather than about Shen's printed line.
    const { state: inBase } = submit(current, toBase!);
    expect(inBase.spellChain.filter((e) => "listenerDefId" in e)).toEqual([]);
  });
});

/**
 * **The SECOND answer to "is this unit Mighty" is gone.**
 *
 * `battlefield-abilities.mightyUnitsAt` — the condition on Sunken Temple's "when
 * you conquer here with one or more `[Mighty]` units" — used to spell out its own
 * `effectiveMight(..., { isCombat: false }) >= 5` against a LOCAL copy of the
 * threshold constant, and passed no `battlefieldId` either. So it missed both
 * fixes `isMighty` carries: the combat roles, and the positional auras.
 *
 * It was a genuine second ANSWER rather than a stale copy, and reachable: a
 * combat conquest calls `recordConquest` from inside `resolveShowdown`, and
 * `execute-pass-focus` nulls `showdownKind` only AFTER `closeShowdown` returns,
 * so the trigger's `applies` runs with the Combat Showdown still open. Measured
 * on one board: `isMighty` true, Sunken Temple counting zero.
 *
 * This block was written as a pin at the WRONG answer, per CLAUDE.md's rule for a
 * reachable divergence, and its failure message said what to do when it flipped.
 * It flipped in the same change. Now it asserts the agreement instead — two
 * functions that can disagree about one keyword is the defect, so what is pinned
 * is that there is only one.
 */
describe("Sunken Temple asks the SAME 'is Mighty' as everything else", () => {
  it("sees an attacker that is Mighty only through [Assault]", () => {
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
    });
    state.battlefields[0] = { ...state.battlefields[0]!, defId: SUNKEN_TEMPLE };
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Charger", might: 4, keywords: { Assault: 1 } })] };
    state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    state.players[0]!.deck = [makeUnit({ name: "Drawn", might: 1 })];

    // The two answers, side by side — now the same answer.
    expect(isMighty(state, state.battlefields[0]!.units.p1![0]!, 0), "premise: the shared answer says Mighty").toBe(true);
    expect(
      settled(recordConquest(state, 0, "bf1")).pendingDecisions,
      "Sunken Temple disagrees with isMighty again — it has grown a second comparison",
    ).toHaveLength(1);
  });

  it("still sees nothing when no unit is Mighty by any reading", () => {
    // The negative control: the test above must not pass because the battlefield
    // fires unconditionally.
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
    });
    state.battlefields[0] = { ...state.battlefields[0]!, defId: SUNKEN_TEMPLE };
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Small", might: 2 })] };
    state.players[0]!.channeled = [{ id: "r1", domain: "Body", state: "Ready" }];
    state.players[0]!.deck = [makeUnit({ name: "Drawn", might: 1 })];

    expect(isMighty(state, state.battlefields[0]!.units.p1![0]!, 0)).toBe(false);
    expect(settled(recordConquest(state, 0, "bf1")).pendingDecisions).toHaveLength(0);
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
   * does not have (rule 476.2's "the layers are re-checked"). Attaching the
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

  /**
   * **OPEN, and the route the higher-of-two ruling CREATED (2026-08-08).** A
   * 4-Might `[Shield 1]` unit is Mighty the instant a Combat Showdown opens over
   * its head, and by 709 that is a unit whose Might "changes from being less than
   * 5 to being 5 or greater" — a becoming.
   *
   * Nothing fires, and it is not an oversight that can be patched at one call
   * site. `withMightTransitions` brackets operations that change an INPUT to
   * `effectiveMight` (a pump, a buff, an [Equip]) and compares the unit's before
   * with its after. Combat entry changes the CONTEXT the unit is read in and
   * writes nothing about the unit at all — the same shape as the two rows above,
   * where an aura arrived or the unit walked under one, and unreachable for the
   * same reason. Closing it needs a re-evaluation pass over the layers this engine
   * does not have (476: "recur the process, and evaluate each layer again").
   *
   * Deliberately NOT patched onto the Showdown-staging step. That step is one of
   * several ways the context changes — a Non-Combat Showdown being PROMOTED to a
   * Combat one (316.8.b.1.a) is a second, a unit arriving at an open combat is a third,
   * and the combat CLOSING is the downward mirror — so bracketing the one that is
   * easy to reach would make the trigger fire for some combats and not others,
   * which is worse than the uniform silence.
   *
   * Driven through the real Cleanup that stages a Showdown, and the premise is
   * asserted both ways: not Mighty before, Mighty after, chain empty.
   */
  it("ENTERING combat as a [Shield] defender is not seen (open)", () => {
    const state = board();
    state.activePlayerIndex = 1; // p2 attacks, so p1's Fioras are the DEFENDER's listeners
    const wall = makeUnit({ name: "Wall", instanceId: "wall", might: 4, keywords: { Shield: 1 } });
    state.battlefields[0]!.units = { p1: [wall], p2: [makeUnit({ name: "Raider", might: 2 })] };
    state.battlefields[0]!.controllerId = "p1";

    expect(isMighty(state, wall, 0), "premise: not Mighty before the combat opens").toBe(false);

    const combat = beginCombatAt(state, "bf1", 1);
    expect(combat.showdownKind, "no combat opened — the fixture is wrong").toBe("Combat");
    expect(isMighty(combat, combat.battlefields[0]!.units.p1![0]!, 0), "premise: Mighty once it is open").toBe(true);

    expect(whoTriggered(combat), "the combat-entry gap has closed — update the docs row").toEqual([]);
  });
});
