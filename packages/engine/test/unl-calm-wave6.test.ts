import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardMovesTarget } from "../src/engine/card-effects.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { chooseRestrictionDefIds } from "../src/engine/target-lookup.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Wave 6 of the Unleashed Calm cards — the RE-AUDIT of nine refusals.
 *
 * One of the nine turned out to be writable with no shared-file change at all
 * (UNL-050 Iascylla); the other eight are still blocked, and each is asserted
 * here against the mechanism it is blocked ON rather than merely against
 * `isCardImplemented`. A refusal that only says "unimplemented" cannot tell the
 * day the blocker lands from the day somebody deleted the card.
 *
 * Everything about Iascylla drives the REAL path: `submit({type:"Pass"})` runs
 * the whole start of turn including the hold that scores her point, the trigger
 * is asserted as a Pending Item BEFORE it is drained, and the question is
 * answered with a real `AnswerDecision` action rather than by calling
 * `answerDecision`. Calling her resolver would clear every dispatch hop at once,
 * and the hops are where this engine has lost effects before.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and being
 * edited by sibling agents in this tree.
 */

const registry = defaultCardRegistry();

const IASCYLLA = "UNL-050"; // WRITTEN this wave — "When I hold, ... you may move an enemy unit to this battlefield."
const MONCH = "UNL-035"; // BLOCKED — cost-modifiers.ts + deploy.conditionalEntersReady
const SHADOW_WATCHER = "UNL-037"; // BLOCKED — a Beginning-Phase death is recorded nowhere
const SKYWARD_STRIKE = "UNL-038"; // BLOCKED — card-effects.MOVE_TARGET_SPELL_DEF_IDS
const ALLAY = "UNL-041"; // BLOCKED — granted-keywords.KEYWORD_AURAS
const SIGNPOST = "UNL-045"; // BLOCKED — ActivationCost has no "exhaust a unit you control"
const TRICKSY_TENTACLES = "UNL-054"; // BLOCKED — a move-destination for a unitLIST
const ALPHA_WILDCLAW = "UNL-057"; // BLOCKED — target-lookup.UNCHOOSEABLE_BY_ENEMIES is a flat Set
const MASTER_YI_UNSTOPPABLE = "UNL-059"; // BLOCKED — tiered Energy+Power discount, and the same flat Set

/** Player 0's turn is about to end; player 1 holds bf2 with `units` and nothing
 *  of player 0's is there. Passing from here runs player 1's whole start of turn
 *  — Awaken, Beginning (where the hold scores), Channel, Draw — as one action,
 *  which is the moment Iascylla's ability is generated. */
function holdingBf2(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[1]!.units = { p2: units };
  state.battlefields[1]!.controllerId = "p2";
  return state;
}

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** The defIds of the triggered abilities waiting on the chain — the positive
 *  control a "did nothing" assertion needs, since "fired and declined" and "never
 *  fired" are indistinguishable at the end state. Read BEFORE the chain drains. */
const heldTriggerDefIds = (state: GameState): string[] =>
  state.spellChain.flatMap((e) => ("kind" in e && e.kind === "trigger" ? [(e as { listenerDefId: string }).listenerDefId] : []));

const everyUnit = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
];

/** Where `instanceId` is standing: a battlefield id, "base", or undefined if it
 *  has left the board. Asserted rather than "did the battlefield grow", because a
 *  move is two facts and a test that checks only the destination cannot see a
 *  copy. */
function locationOf(state: GameState, instanceId: string): string | "base" | undefined {
  for (const bf of state.battlefields) {
    if (Object.values(bf.units).flat().some((u) => u.instanceId === instanceId)) return bf.id;
  }
  for (const p of state.players) {
    if (p.baseUnits.some((u) => u.instanceId === instanceId)) return "base";
  }
  return undefined;
}

/** Answers the one outstanding question through the REAL action, picking the
 *  option whose `instanceId` is `pick` — or "decline" when `pick` is undefined.
 *  Goes through `submit`, so the validator's re-derivation of the option list is
 *  exercised too; `answerDecision` alone would skip it. */
function answerDrag(state: GameState, pick?: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was asked").toBeDefined();
  const options = optionsFor(state, decision!);
  const chosen = pick === undefined ? "decline" : options.find((o) => o.instanceId === pick)?.id;
  expect(chosen, `${pick ?? "decline"} was not on offer among ${JSON.stringify(options.map((o) => o.label))}`).toBeDefined();
  return accept(state, {
    type: "AnswerDecision",
    playerIndex: decision!.playerIndex,
    decisionId: decision!.id,
    optionId: chosen!,
  });
}

describe("Iascylla (UNL-050): when I hold, you may drag an enemy unit to this battlefield", () => {
  it("reports implemented", () => {
    expect(isCardImplemented(registry.get(IASCYLLA))).toBe(true);
  });

  it("holds, HELD-triggers, and drags the chosen enemy unit out of its base", () => {
    const state = holdingBf2([realUnitInstance(IASCYLLA)]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Bystander" })];

    const passed = accept(state, { type: "Pass", playerIndex: 0 });

    // Positive controls, both needed. The hold is what generates the ability, and
    // the phase is the printed moment — 316's Main Phase is this engine's Action
    // phase, and the trigger is still a Pending Item at the end of the Pass.
    expect(passed.players[1]!.points, "nobody held, so nothing generated the ability").toBe(1);
    expect(passed.phase, "the start of turn did not reach the Main Phase").toBe("Action");
    expect(heldTriggerDefIds(passed), "the ability was not HELD — it resolved inline, in the Beginning Phase").toContain(IASCYLLA);
    expect(locationOf(passed, "victim"), "the drag happened before the question was asked").toBe("base");

    const asked = resolveHeldTriggers(passed);
    expect(pendingDecision(asked)?.kind, "the trigger resolved without asking").toBe("UNL-050-drag");

    const answered = answerDrag(asked, "victim");
    expect(locationOf(answered, "victim"), "the enemy unit did not move").toBe(asked.battlefields[1]!.id);
    // The other half of the move: a copy would satisfy the destination check alone.
    expect(everyUnit(answered).filter((u) => u.instanceId === "victim"), "the unit was copied rather than moved").toHaveLength(1);
  });

  it("offers DECLINE first, and declining leaves the board alone", () => {
    const state = holdingBf2([realUnitInstance(IASCYLLA)]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Bystander" })];

    const asked = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));
    const options = optionsFor(asked, pendingDecision(asked)!);
    // Two real answers, so `advanceDecisions` can never auto-resolve it: a "you
    // may" the engine answers for you is not a "you may" (402.1).
    expect(options.map((o) => o.id)[0], "the aggressive answer is the default").toBe("decline");
    expect(options.length, "the drag was not on offer at all").toBe(2);

    const declined = answerDrag(asked);
    expect(locationOf(declined, "victim"), "declining still dragged the unit").toBe("base");
  });

  it("does NOT fire for a battlefield she is not standing at", () => {
    const state = holdingBf2([realUnitInstance(IASCYLLA)]);
    // A second held battlefield with an ordinary body on it: two holds, two
    // points, and only ONE of them is hers.
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Outpost" })] };
    state.battlefields[0]!.controllerId = "p2";
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Bystander" })];

    const passed = accept(state, { type: "Pass", playerIndex: 0 });
    expect(passed.players[1]!.points, "only one battlefield was held, so this proves nothing").toBe(2);
    // ONE trigger from two holds. Without this the destination assertion below
    // could pass while a second copy quietly aimed at bf1.
    expect(heldTriggerDefIds(passed).filter((id) => id === IASCYLLA), "both holds generated the ability").toHaveLength(1);

    const answered = answerDrag(resolveHeldTriggers(passed), "victim");
    expect(locationOf(answered, "victim"), "she dragged the unit to the wrong battlefield").toBe(state.battlefields[1]!.id);
  });

  it("gives the OPPONENT's Iascylla nothing when you hold", () => {
    // Player 0 holds bf1; player 1's Iascylla stands at bf2 and must not fire.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Outpost" })] };
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.units = { p2: [realUnitInstance(IASCYLLA)] };
    state.battlefields[1]!.controllerId = "p2";
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Bystander" })];

    // **This negative is carried by the POSITIONAL check, not by the owner one**,
    // and that was measured: deleting `holderIndex === listener.ownerIndex` from
    // her `applies` leaves this green, because `scoring.isHeldBy` refuses a hold at
    // any battlefield an opponent's unit stands at — so an Iascylla can never be at
    // a battlefield somebody else held. The negative is kept because it is the
    // sentence a reader will want checked; the redundancy is noted at the site.
    const passed = accept(state, { type: "Pass", playerIndex: 1 });
    expect(passed.players[0]!.points, "player 0 never held, so this proves nothing").toBe(1);
    expect(heldTriggerDefIds(passed), "she fired off an OPPONENT's hold").not.toContain(IASCYLLA);
    expect(pendingDecision(resolveHeldTriggers(passed)), "a question was asked on the opponent's hold").toBeUndefined();
  });

  it("fires but asks NOTHING when the opponent has no unit anywhere (055)", () => {
    // The trigger is still generated — the hold happened — so this separates
    // "did as much as it could" from "never fired", which the end state cannot.
    //
    // **It does NOT prove the resolver's empty-candidate guard, and that was
    // measured rather than assumed**: deleting the guard leaves all 11 tests
    // green, because `parkDecision` -> `advanceDecisions` executes a one-option
    // question ("Decline") the instant it is parked. The two paths are
    // observationally identical, so this asserts the OUTCOME (no question reaches
    // a player) and the guard is labelled non-load-bearing at its own site.
    const state = holdingBf2([realUnitInstance(IASCYLLA)]);
    const passed = accept(state, { type: "Pass", playerIndex: 0 });

    expect(passed.players[1]!.points, "she did not hold, so this proves nothing").toBe(1);
    expect(heldTriggerDefIds(passed), "the ability was not generated at all").toContain(IASCYLLA);
    expect(pendingDecision(resolveHeldTriggers(passed)), "a question was parked with no legal answer").toBeUndefined();
  });

  it("does not offer an enemy unit already standing at the battlefield she held (355.4.a)", () => {
    // The exclusion can only be observed where the state can exist: an enemy unit
    // standing at bf2 would have BLOCKED the hold, so it has to arrive during the
    // response window this hold opens. Options are rebuilt from live state, which
    // is exactly what makes that reachable — and what makes the walked-in body's
    // absence a statement about the filter rather than about the setup.
    const state = holdingBf2([realUnitInstance(IASCYLLA)]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "far", name: "Far" })];

    const asked = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));
    const bf2Id = asked.battlefields[1]!.id;
    const intruded: GameState = {
      ...asked,
      battlefields: asked.battlefields.map((bf) =>
        bf.id === bf2Id ? { ...bf, units: { ...bf.units, p1: [makeUnit({ instanceId: "here", name: "Here" })] } } : bf,
      ),
    };
    const offered = optionsFor(intruded, pendingDecision(intruded)!).map((o) => o.instanceId);
    // Positive control: the walk still reaches the opponent's base at all.
    expect(offered, "the distant unit stopped being offered — the walk is broken, not the filter").toContain("far");
    expect(offered, "a unit already at that battlefield was offered a no-op move").not.toContain("here");
  });
});

describe("the eight Calm cards this re-audit still REFUSES, each asserted against its blocker", () => {
  // A refusal nothing asserts is indistinguishable from a card nobody looked at,
  // and "unimplemented" alone cannot tell the day the blocker lands. So each of
  // these asserts the MECHANISM, and fails when the mechanism appears.

  it("FOUR still report unimplemented — Allay, Alpha Wildclaw, Skyward Strike and Master Yi have left", () => {
    // **ALLAY was removed from this list on 2026-08-11.** This re-audit correctly
    // measured her as blocked on a registration point rather than a mechanism —
    // "one row, structurally identical to Captain Farron's" — and the integrator
    // added that row. The other seven are unchanged and each is asserted against
    // its own blocker below.
    // **ALPHA_WILDCLAW left on 2026-08-11** — his refusal named the fix
    // (`unitChooseableBy` takes no state) and that fix landed, so he is whole.
    // **MASTER_YI left on 2026-08-12.** He was the interesting entry here: his
    // `[Level 16]` clause landed while his three `[Level]` COST reductions did
    // not, so he was a recorded PARTIAL rather than an unwritten card — and this
    // list asks `isCardImplemented`, which a partial correctly answers `false`.
    // The tiers are written now, so he answers `true` and belongs out of the list.
    // His refusal named the seam precisely and it needed no new plumbing:
    // Concentrate's tier table was already the same shape, and what Yi added was
    // a tier discounting Energy AND Power together.
    // **SKYWARD_STRIKE left on 2026-08-11** — two table rows in card-effects.ts,
    // exactly as this re-audit measured.
    // A counted list, not a bare loop: an id silently dropping out would shrink
    // the sweep without failing it, which is how a refusal list rots into a green
    // test that checks nothing. The length is asserted against the title.
    // **TRICKSY_TENTACLES left on 2026-08-13.** Its refusal was the most useful in
    // this file: it measured that the destination needed ONE shared row rather
    // than the three predicted, and the project owner then ruled that its "single
    // location" includes the enemy base. Both halves landed together.
    // **MONCH left on 2026-08-13.** His refusal named both files exactly — two
    // lines in `modifiedEnergyCost` and a `conditionalEntersReady` case — and
    // that is what was written.
    // **SHADOW_WATCHER left on 2026-08-13.** Only Forgotten Signpost remains of
    // this re-audit's eight, and its blocker is a genuine one: `ActivationCost`
    // has no "exhaust a unit you control", and the cost choice would have to be
    // constrained by the chosen destination.
    const stillRefused = [SIGNPOST];
    expect(stillRefused, "the refusal list changed size — update the title and say which card left").toHaveLength(1);
    for (const id of stillRefused) {
      expect(isCardImplemented(registry.get(id)), `${id} reports implemented — delete its refusal`).toBe(false);
    }
  });

  it("UNL-054 Tricksy Tentacles HAS its move-destination entry now — as does UNL-038", () => {
    // Both print "move" as their whole first instruction, and 355.4 makes the Move
    // Destination a choice made when the spell is FINALIZED — so it has to be a row
    // in `card-effects.MOVE_TARGET_SPELL_DEF_IDS`, without which the enumerator
    // never fans a destination and `event.destinationBattlefieldId` is always
    // undefined. Asking at resolution instead would be a real divergence, not a
    // shortcut: 355.4 puts the choice before the response window.
    // **Skyward Strike left on 2026-08-11; Tricksy Tentacles on 2026-08-13.**
    //
    // This pin's reasoning about the Tentacles was RIGHT and its conclusion was
    // half wrong. `withDestinations` really does read `targetUnitInstanceId`, and
    // a `unitList` variant really does carry only the plural field — but the
    // consequence is not that a row is insufficient for the BATTLEFIELD axis. An
    // undefined index means no battlefield is skipped, so all of them are offered.
    // It only blocked the BASE branch, which was gated on that same index, and
    // that gate moved when the owner ruled the base is a legal destination here.
    //
    // Inverted rather than deleted: both rows are pure enablers, and a card whose
    // row silently disappeared would enumerate no destination while still
    // reporting implemented.
    expect(cardMovesTarget(SKYWARD_STRIKE), "Skyward Strike lost its row").toBe(true);
    expect(cardMovesTarget(TRICKSY_TENTACLES), "the Tentacles lost their row").toBe(true);
  });

  it("UNL-045 Forgotten Signpost still has no activated ability, and the cost it needs does not exist", () => {
    // Two independent gaps, both re-measured against the code rather than
    // inherited from wave 3's note, and both still true: `ActivationCost` has no
    // "exhaust a unit you control" (its nearest neighbour `killFriendlyPermanent`
    // KILLS), and `execute-activate-ability` does not forward
    // `costPermanentInstanceId` into the `ActivatedAbilityEvent` — so even given
    // the cost, "the location of the unit you exhausted" is unanswerable.
    expect(activatedAbilityFor(SIGNPOST), "an ability appeared — write the card").toBeUndefined();
  });

  it("UNL-057 and UNL-059 CAN say 'unchooseable' conditionally — flipped 2026-08-11", () => {
    // **Was a refusal pin, and the refusal was exactly right.**
    // `unitChooseableBy` took no state and consulted a flat `Set<defId>`, so
    // neither a Might-conditional aura over OTHER units (Alpha Wildclaw) nor an
    // XP-gated prohibition (Master Yi) was expressible.
    //
    // The re-audit also measured the fix: widen the signature — all four call
    // sites already had `state` — and replace the Set with a per-defId predicate
    // table. It landed with a board query beside it for the aura, since that one
    // is keyed by the PROTECTOR rather than the protected.
    //
    // Inverted rather than deleted: this list is the only place a reader can see
    // which cards carry an absolute prohibition, and a card silently leaving it
    // would make a play legal that should be impossible.
    // **UNL-147 Baron Nashor joined the list on 2026-08-12.** His "I can't be
    // chosen by enemy spells and abilities" is Ruin Runner's shape exactly —
    // unconditional, `() => true` — and was one of the three clauses a wave-7
    // agent named as writable in one row. It is the row.
    expect(chooseRestrictionDefIds().sort(), "a card lost its choose restriction").toEqual(
      ["SFD-105", "UNL-057", "UNL-059", "UNL-147"].sort(),
    );
  });
});
