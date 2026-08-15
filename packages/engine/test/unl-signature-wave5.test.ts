import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { optionsFor, pendingDecision, type DecisionOption } from "../src/engine/decisions.js";
import { implementingModules, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction, ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 5's DUAL-DOMAIN Unleashed cards — `effects/signature.ts`.
 *
 * Eight of the ten written, two of those by halves and one with a named pricing
 * divergence; two refused outright. Every partial is PINNED here by a test that
 * asserts the WRONG answer, so closing the gap fails loudly rather than silently
 * changing behaviour nobody is watching:
 *  - UNL-186 Death from Below — the replay from trash (`the trash copy is not
 *    offered`).
 *  - UNL-190 Lilting Lullaby — the spell lockout (`the countered player can
 *    still cast`).
 *  - UNL-189 Lillia — the scaling discount (`still costs 4 beside two
 *    Temporary units`).
 *  - UNL-191 Master Yi — the `[Level 11]` enter-ready clause.
 *
 * **Nothing here calls a resolver closure.** Every card is driven the way a game
 * drives it — `legalActions` for the fan-out, `submit` for the action, then
 * `resolveHeldTriggers`/`answerDecisions` because a trigger is a Chain Pending
 * Item and a question is a queue entry. Three of these cards are LEGENDS, which
 * is a dispatch path no domain file had used before: their abilities are reached
 * only if `listeningPermanents` really does end with `owner.legend` and if
 * `activateAbilityCandidates` really does scan the legend zone. A test that
 * called the trigger body would have passed with neither wired.
 *
 * Every "did nothing" assertion has a positive control off the same fixture with
 * one number changed.
 */

const registry = defaultCardRegistry();

const JHIN_VIRTUOSO = "UNL-181"; // refused — see the foot of this file
const CURTAIN_CALL = "UNL-182"; // 4 Energy, modal, [Repeat] x3 (the Repeats are NOT modelled)
const RENGAR_PRIDESTALKER = "UNL-183"; // Legend — "when you play a unit, give a unit +1 Might"
const THRILL_OF_THE_HUNT = "UNL-184"; // 2 Energy / 1 Fury-or-Body, [Reaction]
const PYKE_BLOODHARBOR = "UNL-185"; // Legend — "[1], [Exhaust]: bounce a friendly, make a Gold"
const DEATH_FROM_BELOW = "UNL-186"; // 4 Energy / 1 Fury-or-Chaos
const VI_PILTOVER = "UNL-187"; // Legend — "when you conquer, if 3+ excess..."
const LILLIA_BASHFUL = "UNL-189"; // Legend — "[4], [Exhaust]: play a ready Sprite"
const LILTING_LULLABY = "UNL-190"; // 2 Energy / 2 Calm-or-Mind, [Reaction]
const MASTER_YI_WUJU = "UNL-191"; // Legend — "[Level 6] your units have +1 Might"

/** A vanilla 2-Might body with no text but `[Shield]` — nothing it does can be
 *  mistaken for the card under test. */
const STALWART_PORO = "OGN-052";
/** Fury 1 Energy / 1 Power, "Deal 3 to a unit at a battlefield" — the spell the
 *  counter tests counter, chosen because its effect is loud enough to see. */
const HEXTECH_RAY = "OGN-009";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });
const runes = (domain: RuneCard["domain"], count: number) =>
  Array.from({ length: count }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const activationsOf = (state: GameState, instanceId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

const unitAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

const optionIds = (state: GameState): string[] => {
  const d = pendingDecision(state);
  return d ? optionsFor(state, d).map((o) => o.id) : [];
};

const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

/** Swaps `playerIndex`'s Legend for a real one, keeping the fixture's instance id
 *  so nothing that looked it up by id comes apart. */
function withLegend(state: GameState, playerIndex: 0 | 1, defId: string): GameState {
  const owner = state.players[playerIndex]!;
  state.players[playerIndex] = {
    ...owner,
    legend: { ...owner.legend, defId, name: registry.get(defId).name },
  };
  return state;
}

/** Plays a card through `submit` and settles the chain and the question queue. */
function playAndSettle(state: GameState, action: unknown, pick?: (options: DecisionOption[]) => string): GameState {
  return answerDecisions(resolveHeldTriggers(accept(state, action)), pick);
}

// ---------------------------------------------------------------------------
// UNL-183 Rengar - Pridestalker — a LEGEND registered in a domain file
// ---------------------------------------------------------------------------

describe("Rengar - Pridestalker (UNL-183): when you play a unit, give a unit +1 Might", () => {
  /** Rengar's controller holding one card, with `buddy` already in base as the
   *  pump's second candidate. */
  function rengarState(card: { instanceId: string }): GameState {
    const state = withLegend(makeState({ phase: "Action" }), 0, RENGAR_PRIDESTALKER);
    state.players[0]!.hand = [card as never];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Fury", 6);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "buddy", name: "buddy", might: 3 })];
    return state;
  }

  it("fires from the LEGEND zone on a real unit play, and the chosen unit grows", () => {
    // The whole point of the card here: nothing on the BOARD has defId UNL-183.
    // If `listeningPermanents` did not end with `owner.legend`, this trigger would
    // never be held and every assertion below would read as a card that did
    // nothing.
    const poro = realUnitInstance(STALWART_PORO);
    const state = rengarState(poro);

    const after = playAndSettle(state, playsOf(state, poro.instanceId)[0]!, choose("buddy"));
    expect(unitAnywhere(after, "buddy")!.mightThisTurn, "Rengar's pump never landed").toBe(1);
  });

  it("can pump the unit that was just played — it is on the board by then", () => {
    const poro = realUnitInstance(STALWART_PORO);
    const state = rengarState(poro);
    const after = playAndSettle(state, playsOf(state, poro.instanceId)[0]!, choose(poro.instanceId));
    expect(unitAnywhere(after, poro.instanceId)!.mightThisTurn).toBe(1);
  });

  it("does NOT fire on a SPELL, and the unit run beside it proves the check ran", () => {
    // `cardPlayed` fires for every card, so without `playedKind === "Unit"` a
    // spell would pump too. Both halves off one fixture.
    const ray = spellInstance(HEXTECH_RAY);
    const spellState = rengarState(ray);
    spellState.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    const afterSpell = playAndSettle(spellState, playsOf(spellState, ray.instanceId)[0]!);
    expect(unitAnywhere(afterSpell, "buddy")!.mightThisTurn, "a SPELL fired Rengar").toBe(0);

    const poro = realUnitInstance(STALWART_PORO);
    const unitState = rengarState(poro);
    const afterUnit = playAndSettle(unitState, playsOf(unitState, poro.instanceId)[0]!, choose("buddy"));
    expect(unitAnywhere(afterUnit, "buddy")!.mightThisTurn, "the zero above proves nothing — he never fires").toBe(1);
  });

  it("does not fire for the OPPONENT's unit play", () => {
    // "When YOU play a unit". The opponent casts, Rengar's controller watches.
    const poro = realUnitInstance(STALWART_PORO);
    const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 1 }), 0, RENGAR_PRIDESTALKER);
    state.players[1]!.hand = [poro];
    state.players[1]!.floatingEnergy = 6;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "buddy", might: 3 })];

    const after = playAndSettle(state, playsOf(state, poro.instanceId)[0]!);
    expect(unitAnywhere(after, "buddy")!.mightThisTurn).toBe(0);
  });

  it("on an EMPTY board the arriving unit is the only answer, and it is taken without a prompt", () => {
    // Which is why there is no "is there anything to choose" gate on the trigger:
    // playing a unit always leaves at least one legal choice. A single-option
    // decision is auto-resolved by `advanceDecisions`, so nothing is asked and the
    // pump still lands — the mandatory reading of "give A unit +1".
    const poro = realUnitInstance(STALWART_PORO);
    const state = withLegend(makeState({ phase: "Action" }), 0, RENGAR_PRIDESTALKER);
    state.players[0]!.hand = [poro];
    state.players[0]!.floatingEnergy = 6;

    const settled = resolveHeldTriggers(accept(state, playsOf(state, poro.instanceId)[0]!));
    expect(pendingDecision(settled), "a one-answer question was put to the player").toBeUndefined();
    expect(unitAnywhere(settled, poro.instanceId)!.mightThisTurn, "the forced choice never resolved").toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(RENGAR_PRIDESTALKER))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-187 Vi - Piltover Enforcer
// ---------------------------------------------------------------------------

describe("Vi - Piltover Enforcer (UNL-187): 3+ excess damage buys a ready", () => {
  /** Vi's controller attacking a lone `defenderMight` defender at a battlefield
   *  the opponent controls, with an exhausted body at home to ready. */
  function viState(attackerMight: number, defenderMight: number): GameState {
    const state = withLegend(makeState({ phase: "Action" }), 0, VI_PILTOVER);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "bruiser", might: attackerMight })],
      p2: [makeUnit({ instanceId: "foe", might: defenderMight })],
    };
    state.battlefields[0]!.controllerId = "p2";
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "tired", name: "tired", might: 3, exhausted: true })];
    return state;
  }

  const fight = (state: GameState) => resolveHeldTriggers(resolveShowdown(state, "bf1", 0));

  it("asks when the overkill reaches 3", () => {
    const asked = fight(viState(6, 3));
    expect(pendingDecision(asked)?.kind, "Vi's conquer trigger never fired").toBe("UNL-187-ready");
    expect(optionIds(asked)).toContain("tired");
  });

  it("readies the chosen unit and exhausts her", () => {
    const after = answerDecisions(fight(viState(6, 3)), choose("tired"));
    expect(unitAnywhere(after, "tired")!.exhausted, "the unit was never readied").toBe(false);
    expect(after.players[0]!.legend.exhausted, "'exhaust me' was not paid").toBe(true);
  });

  it("does nothing when declined, and the take beside it proves the question was real", () => {
    const asked = fight(viState(6, 3));
    expect(pendingDecision(asked)?.kind).toBe("UNL-187-ready");
    const declined = answerDecisions(asked, choose("decline"));
    expect(unitAnywhere(declined, "tired")!.exhausted).toBe(true);
    expect(declined.players[0]!.legend.exhausted).toBe(false);
  });

  it("does NOT ask at 2 excess, and the 3 run beside it proves the threshold ran", () => {
    expect(pendingDecision(fight(viState(6, 4))), "she fired one short of the threshold").toBeUndefined();
    expect(pendingDecision(fight(viState(6, 3)))?.kind, "the undefined above proves nothing").toBe("UNL-187-ready");
  });

  it("does not ask for a conquest with no fight behind it", () => {
    // Walking into an empty battlefield conquers and assigns nothing, so
    // `lastShowdownExcessDamage` was never written — the record's own battlefield
    // and attacking-side fields are what stop another fight's number being
    // borrowed.
    const state = viState(6, 3);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "bruiser", might: 6 })] };
    expect(pendingDecision(fight(state))).toBeUndefined();
  });

  it("asks nothing at all when she is already exhausted (414.4)", () => {
    // "You may EXHAUST ME" is a cost, so an exhausted Vi is never offered it —
    // and the check is at RESOLUTION, since the response window between the
    // conquest and this is exactly where a Legend can be exhausted out from
    // under it.
    const spent = viState(6, 3);
    spent.players[0]!.legend = { ...spent.players[0]!.legend, exhausted: true };
    expect(pendingDecision(fight(spent)), "an exhausted Vi was still offered her ability").toBeUndefined();

    // The positive control off the same fixture: ready, she asks.
    expect(pendingDecision(fight(viState(6, 3)))?.kind, "the undefined above proves nothing").toBe("UNL-187-ready");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VI_PILTOVER))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-191 Master Yi - Wuju Master
// ---------------------------------------------------------------------------

describe("Master Yi - Wuju Master (UNL-191): [Level 6] your units have +1 Might", () => {
  /** A 3-Might unit for each player, with Master Yi seated on side 0 at `xp`. */
  function yiState(xp: number): GameState {
    const state = withLegend(makeState({ phase: "Action" }), 0, MASTER_YI_WUJU);
    state.players[0]!.xp = xp;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", might: 3 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", might: 3 })];
    return state;
  }

  const mightOf = (state: GameState, id: string, ownerIndex: 0 | 1) =>
    effectiveMight(state, unitAnywhere(state, id)!, ownerIndex, { isCombat: false });

  it("turns ON at exactly 6 XP and is OFF at 5 (824.1.b.1)", () => {
    expect(mightOf(yiState(5), "mine", 0), "the aura applied below the threshold").toBe(3);
    expect(mightOf(yiState(6), "mine", 0), "the aura never applied — the 3 above proves nothing").toBe(4);
  });

  it("turns OFF again when XP is spent (824.1.d) — it is continuous, not a pump", () => {
    // The half a one-shot on-play pump would get wrong: XP goes up, then down.
    const rich = yiState(11);
    expect(mightOf(rich, "mine", 0)).toBe(4);
    const spent: GameState = { ...rich, players: [{ ...rich.players[0]!, xp: 2 }, rich.players[1]!] };
    expect(mightOf(spent, "mine", 0), "the bonus survived the XP being spent").toBe(3);
  });

  it("is YOUR units only — the opponent's are untouched at the same XP", () => {
    const state = yiState(9);
    expect(mightOf(state, "theirs", 1), "the aura reached across the table").toBe(3);
    expect(mightOf(state, "mine", 0), "the 3 above proves nothing — the aura never applied").toBe(4);
  });

  it("in a MIRROR each side reads its OWN controller's XP", () => {
    // The test above cannot see this: the opponent's unit is spared there because
    // their Legend is somebody else, so a bonus that read `max(p0.xp, p1.xp)`
    // would pass it. Two Master Yis at different XP is the only fixture that
    // separates "reads the unit owner's XP" from "reads anybody's" — and a
    // mutation to `Math.max(...)` survived until this existed.
    const state = withLegend(withLegend(makeState({ phase: "Action" }), 0, MASTER_YI_WUJU), 1, MASTER_YI_WUJU);
    state.players[0]!.xp = 9;
    state.players[1]!.xp = 0;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", might: 3 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", might: 3 })];

    expect(mightOf(state, "theirs", 1), "the poor Master Yi's units grew off the rich one's XP").toBe(3);
    expect(mightOf(state, "mine", 0), "the 3 above proves nothing — neither aura applied").toBe(4);
  });

  it("his [Level 11] 'your units enter ready' WORKS — was a pin, flipped 2026-08-10", () => {
    // Was half a card, pinned by asserting the wrong answer. `deploy.unitEntersReady`
    // is the only predicate that answers this and was not this file's to edit; the
    // agent refused the clause rather than fake it, which deploy.ts's own header
    // gives three measured reasons for. The fix was one board query beside Magma
    // Wurm's — an aura keyed on the CONTROLLER, not a case keyed on the arriving
    // card, since "your units" is every unit the player plays.
    //
    // Flipped rather than deleted, and driven end-to-end through a real play so it
    // asserts the deploy path rather than the predicate. The boundary (10 vs 11),
    // the wrong-Legend case and the opponent's-units case are in
    // test/level-enters-ready.test.ts.
    const poro = realUnitInstance(STALWART_PORO);
    const state = withLegend(makeState({ phase: "Action" }), 0, MASTER_YI_WUJU);
    state.players[0]!.xp = 20;
    state.players[0]!.hand = [poro];
    state.players[0]!.floatingEnergy = 6;

    const after = playAndSettle(state, playsOf(state, poro.instanceId)[0]!);
    expect(unitAnywhere(after, poro.instanceId)!.exhausted, "[Level 11] regressed — the Poro arrived exhausted").toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    // Registered, and coverage says WHY it is not whole. `isCardImplemented`
    // would be the wrong question: his `[Level 11]` "your units enter ready" is a
    // deploy-time replacement in a different table, so he is half a Legend and
    // carries a PARTIALLY_IMPLEMENTED row saying so. Asserting the note exists
    // makes closing that gap fail LOUDLY rather than silently.
    expect(implementingModules(MASTER_YI_WUJU), "the aura is not registered at all").not.toEqual([]);
    // **Was `.toContain("Level 11")`.** That gap is closed, the coverage row is
    // retired, and the honest answer is no note at all — asserted rather than
    // deleted so a note reappearing sends a reader to look for the new gap.
    expect(partialImplementationNote(registry.get(MASTER_YI_WUJU)), "a partial note came back — Yi has a gap again").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UNL-185 Pyke - Bloodharbor Ripper
// ---------------------------------------------------------------------------

describe("Pyke - Bloodharbor Ripper (UNL-185): bounce a friendly, mint a Gold", () => {
  function pykeState(unitAtBattlefield: boolean): GameState {
    const state = withLegend(makeState({ phase: "Action" }), 0, PYKE_BLOODHARBOR);
    state.players[0]!.floatingEnergy = 3;
    const body = makeUnit({ instanceId: "diver", name: "diver", might: 4, damage: 2 });
    if (unitAtBattlefield) state.battlefields[0]!.units = { p1: [body] };
    else state.players[0]!.baseUnits = [body];
    return state;
  }

  const legendId = (state: GameState) => state.players[0]!.legend.instanceId;

  it("returns the unit to hand, mints an EXHAUSTED Gold, and spends [1] + the exhaust", () => {
    const state = pykeState(true);
    const action = activationsOf(state, legendId(state)).find((a) => a.targetUnitInstanceId === "diver");
    expect(action, "the enumerator never offered Pyke's ability — the legend zone is not scanned").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, action!)));
    expect(unitAnywhere(after, "diver"), "the unit is still on the board").toBeUndefined();
    expect(after.players[0]!.hand.map((c) => c.instanceId), "it never reached hand").toContain("diver");

    const gold = after.players[0]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);
    expect(gold.length, "no Gold was minted").toBe(1);
    expect(gold[0]!.exhausted, "the Gold entered ready — 'exhausted' is printed").toBe(true);

    expect(after.players[0]!.legend.exhausted, "the exhaust was not paid").toBe(true);
    expect(after.players[0]!.floatingEnergy, "the [1] was not paid").toBe(2);
  });

  it("is NOT offered for a unit in BASE — 'at a battlefield' is a targeting restriction (355.9.b)", () => {
    // And the battlefield run beside it, so an empty list is not mistaken for an
    // ability that is never offered at all.
    expect(activationsOf(pykeState(false), legendId(pykeState(false))).length, "a unit in base was reachable").toBe(0);
    const on = pykeState(true);
    expect(activationsOf(on, legendId(on)).length, "the zero above proves nothing").toBeGreaterThan(0);
  });

  it("is not offered with no Energy — the [1] is a real cost", () => {
    const broke = pykeState(true);
    broke.players[0]!.floatingEnergy = 0;
    expect(activationsOf(broke, legendId(broke)).length).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PYKE_BLOODHARBOR))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-189 Lillia - Bashful Bloom
// ---------------------------------------------------------------------------

describe("Lillia - Bashful Bloom (UNL-189): a ready Temporary Sprite for [4]", () => {
  function lilliaState(energy: number, temporaryFriends = 0): GameState {
    const state = withLegend(makeState({ phase: "Action" }), 0, LILLIA_BASHFUL);
    state.players[0]!.floatingEnergy = energy;
    state.players[0]!.baseUnits = Array.from({ length: temporaryFriends }, (_, i) =>
      makeUnit({ instanceId: `sprite-${i}`, might: 3, keywords: { Temporary: 1 } }),
    );
    return state;
  }

  const legendId = (state: GameState) => state.players[0]!.legend.instanceId;

  it("plays a READY 3-Might Sprite carrying [Temporary]", () => {
    const state = lilliaState(4);
    const action = activationsOf(state, legendId(state))[0];
    expect(action, "the enumerator never offered Lillia's ability").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, action!)));
    const sprite = after.players[0]!.baseUnits.find((u) => u.isToken);
    expect(sprite, "no token was minted").toBeDefined();
    expect(sprite!.might).toBe(3);
    expect(sprite!.tags).toContain("Sprite");
    // 143.4.a would have it enter exhausted; "play a READY ... token" overrides it.
    expect(sprite!.exhausted, "the Sprite entered exhausted — 'ready' is printed").toBe(false);
    expect(sprite!.keywords["Temporary"], "the Sprite lost [Temporary]").toBe(1);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("PINNED DIVERGENCE: it still costs [4] beside two [Temporary] units", () => {
    // Printed, this would cost [2] with two Temporary friendlies and [4] with
    // none. `ActivationCost.energy` is a number and `activationCostOf` is handed
    // no state, so there is nowhere for the board to be read. When that changes,
    // this test goes red — which is the point.
    const discounted = lilliaState(2, 2);
    expect(activationsOf(discounted, legendId(discounted)).length, "the discount now applies — retire this pin").toBe(0);

    // The positive control: the SAME board with the full 4 Energy does offer it,
    // so the zero above is about the price and not about the ability being dead.
    const funded = lilliaState(4, 2);
    expect(activationsOf(funded, legendId(funded)).length).toBeGreaterThan(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(LILLIA_BASHFUL))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-186 Death from Below
// ---------------------------------------------------------------------------

describe("Death from Below (UNL-186): kill a unit at a battlefield", () => {
  function dfbState(): { state: GameState; cardId: string } {
    const card = spellInstance(DEATH_FROM_BELOW);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Fury", 4);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "sheltered", might: 2 })];
    return { state, cardId: card.instanceId };
  }

  it("kills the chosen unit outright, whatever its Might", () => {
    // 9 Might, so nothing about this is damage — a kill ignores the number.
    const { state, cardId } = dfbState();
    const action = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "victim");
    expect(action, "no play variant targeted the unit at the battlefield").toBeDefined();

    const after = playAndSettle(state, action!);
    expect(unitAnywhere(after, "victim"), "the unit survived").toBeUndefined();
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain("victim");
  });

  it("cannot reach a unit in BASE — 'at a battlefield' is printed", () => {
    const { state, cardId } = dfbState();
    const offered = playsOf(state, cardId).map((a) => a.targetUnitInstanceId);
    expect(offered, "a unit sheltering in base was targetable").not.toContain("sheltered");
    expect(offered, "nothing was offered at all — the negative above proves nothing").toContain("victim");
  });

  // **The "the replay is UNWRITTEN" pin was deleted on 2026-08-13, not
  // inverted.** It set a 2-Might victim, cast, and asserted `playsOf(after,
  // cardId).length` was 0. Both halves it was waiting for landed —
  // `engine/replaced-costs.ts` for rule 356.1.a's replaced base cost, and
  // `PlayerState.replacedCostPlays` for the granted per-instance permission — so
  // the clause is now covered in `test/replaced-costs.test.ts` alongside the rest
  // of that seam. A second file asserting the same fact is how the premise-flip
  // class starts over.
  //
  // Worth carrying over from the pin, because it was nearly a trap: its fixture
  // killed the board's ONLY unit, and Death from Below needs a target at a
  // battlefield. So "the replay is not offered" was true there for two reasons at
  // once, and the new tests leave a bystander standing to tell them apart.

  it("is reported as implemented by coverage, and carries no partial note", () => {
    expect(implementingModules(DEATH_FROM_BELOW), "the kill is not registered at all").not.toEqual([]);
    expect(isCardImplemented(registry.get(DEATH_FROM_BELOW)), "the card reports unfinished").toBe(true);
    expect(
      partialImplementationNote(registry.get(DEATH_FROM_BELOW)),
      "a partial note came back — the card is whole",
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UNL-190 Lilting Lullaby
// ---------------------------------------------------------------------------

describe("Lilting Lullaby (UNL-190): counter a spell", () => {
  /**
   * Player 1 has Hextech Ray on the chain aimed at player 0's unit; player 0
   * holds Lilting Lullaby and the Calm runes to react.
   *
   * The trailing pass is rule 345 and not a formality — the caster of the newest
   * chain item holds priority, so without it player 0 is never offered a
   * reaction and the card looks unplayable.
   */
  function chained(): { state: GameState; lullabyId: string; rayId: string } {
    const ray = spellInstance(HEXTECH_RAY);
    const lullaby = spellInstance(LILTING_LULLABY);
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "target", might: 9 })] };

    state.players[1]!.hand = [ray, spellInstance(HEXTECH_RAY)];
    state.players[1]!.channeled = runes("Fury", 10);
    state.players[1]!.floatingEnergy = 10;

    state.players[0]!.hand = [lullaby];
    state.players[0]!.channeled = runes("Calm", 8);
    state.players[0]!.floatingEnergy = 6;

    const cast = playsOf(state, ray.instanceId).find((a) => a.targetUnitInstanceId === "target");
    expect(cast, "Hextech Ray was not castable — the fixture is wrong").toBeDefined();
    const onChain = accept(state, cast!);
    const pass = legalActions(onChain).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
    return { state: accept(onChain, pass!), lullabyId: lullaby.instanceId, rayId: ray.instanceId };
  }

  /** Passes until the chain has emptied. */
  function settle(state: GameState): GameState {
    let current = state;
    for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
      const pass = legalActions(current).find((a) => a.type === "PassFocus");
      if (!pass) break;
      current = accept(current, pass);
    }
    return answerDecisions(current);
  }

  it("counters the spell, so its damage never lands (425.1.a)", () => {
    const { state, lullabyId, rayId } = chained();
    const counter = playsOf(state, lullabyId).find((a) => a.targetChainCardInstanceId === rayId);
    expect(counter, "no play variant named the spell on the chain").toBeDefined();

    const after = settle(accept(state, counter!));
    expect(unitAnywhere(after, "target")!.damage, "Hextech Ray still resolved").toBe(0);
    expect(after.spellChain.length).toBe(0);
  });

  it("...and the SAME fixture without the counter takes the 3 damage", () => {
    // The positive control. Without it, a 0 above is also what "the fixture never
    // put a spell on the chain" looks like.
    const { state } = chained();
    const after = settle(state);
    expect(unitAnywhere(after, "target")!.damage, "the ray never resolved — the counter test proves nothing").toBe(3);
  });

  it("PINNED: 'its controller can't play spells this turn' is UNWRITTEN", () => {
    // Half a card. `PlayerState.cannotPlayCardsThisTurn` exists but stops CARDS,
    // which is wider than printed; a spells-only twin needs game-state.ts and
    // three other shared files. Delete this pin when it lands.
    const { state, lullabyId, rayId } = chained();
    const after = settle(accept(state, playsOf(state, lullabyId).find((a) => a.targetChainCardInstanceId === rayId)!));

    const theirSecondRay = after.players[1]!.hand[0]!;
    expect(theirSecondRay, "the fixture left them no second spell").toBeDefined();
    // **INVERTED 2026-08-13, as this pin's own message asked.** The lockout is a
    // `cannotPlaySpellsThisTurn` ban, armed on the Lullaby's RESOLUTION so it
    // survives her leaving play — a fact about the turn, not a continuous
    // ability, exactly as Brynhir Thundersong's wider ban is.
    expect(
      playsOf(after, theirSecondRay.instanceId).length,
      "the countered player can cast again — the lockout stopped applying",
    ).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(implementingModules(LILTING_LULLABY), "the counter is not registered at all").not.toEqual([]);
    // The row went with the gap. Asserted as ABSENT rather than deleted, because
    // a partial note reappearing would mean the lockout had been un-written.
    expect(
      partialImplementationNote(registry.get(LILTING_LULLABY)),
      "a partial note came back — the spell lockout was un-written",
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UNL-184 Thrill of the Hunt
// ---------------------------------------------------------------------------

describe("Thrill of the Hunt (UNL-184): blink a friendly unit to ANY battlefield", () => {
  /** The caster holds the spell, one damaged and buffed unit sits in base, and
   *  the opponent holds bf2 alone — a battlefield the caster has no presence at,
   *  which is exactly what "any battlefield" is for. */
  function thrillState(): { state: GameState; cardId: string } {
    const card = spellInstance(THRILL_OF_THE_HUNT);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Fury", 4);
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "hunter", name: "hunter", might: 4, damage: 3, buffed: true, stunned: true, exhausted: true }),
    ];
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "prey", might: 2 })] };
    state.battlefields[1]!.controllerId = "p2";
    return { state, cardId: card.instanceId };
  }

  it("lands the unit at a battlefield the caster has NO presence at, and contests it", () => {
    // 813 would refuse bf2 to an ordinary play and `playUnitFree` refuses it too.
    // "To ANY battlefield" is the override, and this is the assertion that says so.
    const { state, cardId } = thrillState();
    const after = playAndSettle(state, playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "hunter")!, choose("bf2"));

    const landed = after.battlefields[1]!.units["p1"] ?? [];
    expect(landed.map((u) => u.instanceId), "the unit never reached the contested battlefield").toContain("hunter");
    expect(after.battlefields[1]!.contestedByIndex, "arriving did not contest (190.3.a)").toBe(0);
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).not.toContain("hunter");
  });

  it("returns a FRESH body — damage, the buff, the stun and the move counter all reset (705)", () => {
    const { state, cardId } = thrillState();
    const after = playAndSettle(state, playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "hunter")!, choose("bf1"));

    const hunter = unitAnywhere(after, "hunter")!;
    expect(hunter.damage, "damage came back with it").toBe(0);
    expect(hunter.buffed, "705 did not strip the Buff").toBe(false);
    expect(hunter.stunned, "the stun came back with it").toBe(false);
  });

  it("offers EVERY battlefield and never the base", () => {
    const { state, cardId } = thrillState();
    const asked = resolveHeldTriggers(accept(state, playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "hunter")!));
    expect(pendingDecision(asked)?.kind, "the placement question was never raised").toBe("UNL-184-place");
    expect(optionIds(asked).sort()).toEqual(["bf1", "bf2"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(THRILL_OF_THE_HUNT))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-182 Curtain Call
// ---------------------------------------------------------------------------

describe("Curtain Call (UNL-182): choose one of four", () => {
  function curtainState(): { state: GameState; cardId: string } {
    const card = spellInstance(CURTAIN_CALL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 8;
    state.players[0]!.deck = [spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "front", might: 9 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "backline", might: 9 })];
    return { state, cardId: card.instanceId };
  }

  const modeFor = (state: GameState, cardId: string, modeId: string, target?: string) =>
    playsOf(state, cardId).find((a) => a.modeId === modeId && a.targetUnitInstanceId === target);

  it("offers all four modes", () => {
    const { state, cardId } = curtainState();
    expect(new Set(playsOf(state, cardId).map((a) => a.modeId))).toEqual(
      new Set(["draw", "burn-battlefield", "burn-base", "shrink"]),
    );
  });

  it("draws 1", () => {
    const { state, cardId } = curtainState();
    const after = playAndSettle(state, modeFor(state, cardId, "draw")!);
    expect(after.players[0]!.hand.length).toBe(1);
  });

  it("deals 2 at a battlefield and 3 in a base, and neither mode can reach the other's zone", () => {
    // The asymmetry IS the card, and each half is proved by a mode that lands
    // beside a mode that is not offered.
    const { state, cardId } = curtainState();
    expect(modeFor(state, cardId, "burn-battlefield", "backline"), "the battlefield mode reached a base").toBeUndefined();
    expect(modeFor(state, cardId, "burn-base", "front"), "the base mode reached a battlefield").toBeUndefined();

    const hitFront = playAndSettle(state, modeFor(state, cardId, "burn-battlefield", "front")!);
    expect(unitAnywhere(hitFront, "front")!.damage).toBe(2);

    const hitBack = playAndSettle(state, modeFor(state, cardId, "burn-base", "backline")!);
    expect(unitAnywhere(hitBack, "backline")!.damage).toBe(3);
  });

  it("gives -4 Might with NO floor — nothing prints one", () => {
    const { state, cardId } = curtainState();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "front", might: 2 })] };
    const after = playAndSettle(state, modeFor(state, cardId, "shrink", "front")!);
    const hit = unitAnywhere(after, "front")!;
    expect(hit.mightThisTurn).toBe(-4);
    // 143.2.b treats a negative as 0 when the value is referenced; the modifier
    // itself is not clamped, which is what "no floor" means.
    expect(effectiveMight(after, hit, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(0);
  });

  /**
   * **The pin that used to sit here was retired on 2026-08-14, and it did its
   * job.** It asserted the WRONG answer — that no repeat-paying variant of this
   * card was ever offered — because `RepeatCostSpec` expressed exactly one
   * instance and no row in the table could hold three. It went red the moment
   * `REPEAT_COSTS` learned to hold a list, which is precisely what a pin on a
   * known gap is for.
   *
   * The whole of the multi-instance behaviour now lives in
   * `test/curtain-call-repeat.test.ts` — all seven payable subsets, the three
   * prices, the four executions, and "choose one you haven't already chosen".
   * What stays HERE is the modal half this wave wrote, plus the coverage claim.
   */
  it("now offers repeat-paying variants, and every one of them names which instances it paid", () => {
    const { state, cardId } = curtainState();
    const paid = playsOf(state, cardId).filter((a) => a.repeatPaid === true);

    expect(paid.length, "no repeat-paying variant is offered at all").toBeGreaterThan(0);
    for (const play of paid) {
      expect(play.repeatExecutions, `${play.modeId} paid a [Repeat] without saying which`).toBeDefined();
      expect(play.repeatExecutions!.length).toBeGreaterThan(0);
    }
  });

  it("is reported as implemented by coverage", () => {
    expect(implementingModules(CURTAIN_CALL), "the four modes are not registered at all").not.toEqual([]);
    expect(
      partialImplementationNote(registry.get(CURTAIN_CALL)),
      "a partial note came back — this card is whole as of 2026-08-14",
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What was REFUSED
// ---------------------------------------------------------------------------

describe("the two cards this wave refused", () => {
  it("Jhin - Virtuoso (UNL-181) WORKS now — the zone this wave asked for exists", () => {
    // **The refusal was right about the mechanism and precise about why.** "If
    // there are four spells banished WITH ME" needs a per-source attachment zone,
    // `PlayerState.banished` is one flat list, and every other writer of it
    // (Arcane Shift, Void Rush, Time Warp) would poison a count taken from it.
    //
    // Closed on 2026-08-14 as `LegendInstance.banishedInstanceIds` — one field
    // lower than this wave guessed. It is not on `PlayerState` at all, because
    // "with me" is an attachment to a permanent rather than a fact about a
    // player; `GearInstance` had carried exactly the same field for The Zero
    // Drive since SFD. Behaviour is pinned in `jhin-virtuoso.test.ts`, including
    // the flat-zone poisoning this comment predicted.
    expect(isCardImplemented(registry.get(JHIN_VIRTUOSO)), "Jhin went back to unimplemented").toBe(true);
  });

  it("...and every other card in this wave IS registered", () => {
    // The positive half, so the refusal above cannot be mistaken for the whole
    // wave being inert.
    //
    // **This asks `implementingModules`, not `isCardImplemented`, and the
    // difference is the whole point.** Four of these nine are written by halves
    // and carry a PARTIALLY_IMPLEMENTED row, which makes `isCardImplemented`
    // correctly false — so the original version of this test went red the moment
    // the integrator recorded those rows, and it would have gone red again for
    // every future partial. "Is anything registered for this defId" is the
    // question that was actually meant, and it cannot flip that way.
    const registered = [
      CURTAIN_CALL,
      RENGAR_PRIDESTALKER,
      THRILL_OF_THE_HUNT,
      PYKE_BLOODHARBOR,
      DEATH_FROM_BELOW,
      VI_PILTOVER,
      LILLIA_BASHFUL,
      LILTING_LULLABY,
      MASTER_YI_WUJU,
    ];
    for (const defId of registered) {
      expect(implementingModules(defId), `${defId} is not registered`).not.toEqual([]);
    }
    // **Jhin joined them on 2026-08-14**, so this list is now the whole wave and
    // the partition it used to prove is gone. Asserted positively rather than
    // deleted: a card silently losing its registration is exactly what this
    // question was asked to catch, and that risk did not go away when he landed.
    expect(implementingModules(JHIN_VIRTUOSO), "Jhin lost his registration").not.toEqual([]);
  });
});
