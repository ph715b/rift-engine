import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { optionsFor, pendingDecision, type DecisionOption } from "../src/engine/decisions.js";
import { implementingModules, isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 6's `Body+X` dual-domain Unleashed cards — `effects/signature-body.ts`.
 *
 * Three of the four were written in wave 6; UNL-202 Void Assault was refused
 * outright and UNL-201 Kha'Zix written by two clauses of three. Both gaps were
 * PINNED here by a test asserting the WRONG answer, so closing either failed
 * loudly instead of silently changing behaviour nobody was watching.
 *
 * **Both pins have now expired** — Void Assault on 2026-08-12 (wave 7) and
 * Kha'Zix's third clause the same day (wave 8, once `ActivationCost.xp` landed).
 * Each was turned ROUND rather than deleted: same fixture, opposite assertion. A
 * deleted pin leaves nothing saying the gap ever closed, which is how a card
 * quietly reverts to inert.
 *
 * **Nothing here calls a resolver closure.** Every card is driven the way a game
 * drives it — `legalActions` for the fan-out, `submit` for the action,
 * `resolveShowdown`/`runBeginning` for the two moments, then
 * `resolveHeldTriggers`/`answerDecisions` because a trigger is a Chain Pending
 * Item and a question is a queue entry.
 *
 * Two of the three cards are LEGENDS, which matters more than usual here: their
 * triggers are reached ONLY if `listeningPermanents` really does end with
 * `owner.legend`, and their abilities only if `findActivatable` really does scan
 * the legend zone. Every "when you win a combat, gain 1 XP" style clause in this
 * project has to be measured this way — `reachability` cannot see an XP gain at
 * all, because a trigger that only moves XP registers nothing it counts.
 *
 * Every "did nothing" assertion has a positive control off the same fixture with
 * one number changed.
 */

const registry = defaultCardRegistry();

const KHAZIX_VOIDREAVER = "UNL-201"; // Legend — combat-win XP, plus a buff for 1 XP
const VOID_ASSAULT = "UNL-202"; // refused — see the foot of this file
const POPPY_KEEPER = "UNL-203"; // Legend — hold XP, plus a draw for 3 XP
const KEEPERS_VERDICT = "UNL-204"; // 2 Energy / 2 Power spell

/** A vanilla body with `[Shield]` and no text — nothing it does can be mistaken
 *  for the card under test. */
const STALWART_PORO = "OGN-052";

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

const legendId = (state: GameState, playerIndex: 0 | 1 = 0) => state.players[playerIndex]!.legend.instanceId;

/** p0 attacks bf1, and the held triggers and questions settle. The real entry —
 *  a test that hand-built a `combatWon` event would bypass `combatWinner`
 *  entirely and assert nothing. */
const fightAt = (state: GameState) => answerDecisions(resolveHeldTriggers(resolveShowdown(state, "bf1", 0)));

// ---------------------------------------------------------------------------
// UNL-201 Kha'Zix - Voidreaver
// ---------------------------------------------------------------------------

describe("Kha'Zix - Voidreaver (UNL-201): when you win a combat, gain 1 XP", () => {
  /** Kha'Zix seated on side 0, with `attacker` vs `defender` at bf1. */
  function khazixFight(attackerMight: number, defenderMight: number): GameState {
    const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, KHAZIX_VOIDREAVER);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "bruiser", might: attackerMight })],
      p2: [makeUnit({ instanceId: "foe", might: defenderMight })],
    };
    return state;
  }

  it("banks 1 XP when his side wins the fight", () => {
    // Nothing on the BOARD carries defId UNL-201. If `listeningPermanents` did not
    // end with `owner.legend`, this trigger would never be held and the assertion
    // would read exactly like a Legend that does nothing.
    expect(fightAt(khazixFight(9, 1)).players[0]!.xp, "Kha'Zix won a combat and banked no XP").toBe(1);
  });

  it("banks nothing on a mutual wipe — 466.3.d's No Result is not a win", () => {
    // ...and the win beside it, so a 0 is not mistaken for a Legend that never
    // fires at all.
    expect(fightAt(khazixFight(3, 3)).players[0]!.xp, "a No Result paid out").toBe(0);
    expect(fightAt(khazixFight(9, 1)).players[0]!.xp, "the zero above proves nothing").toBe(1);
  });

  it("banks nothing when the OPPONENT wins", () => {
    const lost = fightAt(khazixFight(1, 9));
    expect(lost.players[0]!.xp, "Kha'Zix banked XP off a loss").toBe(0);
    // And the winner does not get his XP either — the seat is checked, not just
    // "somebody won".
    expect(lost.players[1]!.xp, "the opponent inherited Kha'Zix's clause").toBe(0);
  });

  it("banks on a WALKOUT too — winning is not fighting (466.3.a)", () => {
    // The shape `probes/walkout` counts 191 of. A conquer hook would also catch
    // this one, which is exactly why the negative controls above matter more.
    const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, KHAZIX_VOIDREAVER);
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 4 })], p2: [] };
    expect(fightAt(state).players[0]!.xp).toBe(1);
  });
});

describe("Kha'Zix - Voidreaver (UNL-201): Spend 1 XP, [Exhaust]: [Buff] a unit", () => {
  /** Kha'Zix at `xp`, with a friendly in base and an enemy at bf1. */
  function khazixBoard(xp: number): GameState {
    const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, KHAZIX_VOIDREAVER);
    state.players[0]!.xp = xp;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "mine", might: 3 })];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", might: 3 })] };
    return state;
  }

  it("buffs the chosen unit, spends exactly 1 XP and exhausts him", () => {
    const state = khazixBoard(4);
    const action = activationsOf(state, legendId(state)).find((a) => a.targetUnitInstanceId === "mine");
    expect(action, "the enumerator never offered the ability — the legend zone is not scanned").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, action!)));
    expect(unitAnywhere(after, "mine")!.buffed, "the buff never landed").toBe(true);
    expect(after.players[0]!.xp, "the XP cost was not 1").toBe(3);
    expect(after.players[0]!.legend.exhausted, "the printed exhaust was not paid").toBe(true);
  });

  it("is NOT offered at 0 XP, and the 1-XP run beside it proves the gate ran", () => {
    expect(activationsOf(khazixBoard(0), legendId(khazixBoard(0))).length, "a broke Kha'Zix could still buff").toBe(0);
    const funded = khazixBoard(1);
    expect(activationsOf(funded, legendId(funded)).length, "the zero above proves nothing").toBeGreaterThan(0);
  });

  it("is not offered again once he is exhausted", () => {
    const spent = khazixBoard(9);
    spent.players[0]!.legend = { ...spent.players[0]!.legend, exhausted: true };
    expect(activationsOf(spent, legendId(spent)).length, "an exhausted Legend paid an exhaust").toBe(0);
  });

  it("reaches a unit in BASE and an ENEMY unit alike — 'a unit' is a bare noun (355.9.a.1)", () => {
    const state = khazixBoard(4);
    const offered = activationsOf(state, legendId(state)).map((a) => a.targetUnitInstanceId);
    expect(offered, "a unit at home was unreachable").toContain("mine");
    expect(offered, "an enemy unit was excluded — the card names no owner").toContain("theirs");
  });

  it("RETIRED 2026-08-12: his 'Spend 2 XP, [Exhaust]: move an exhausted friendly home' clause now WORKS", () => {
    // This used to be a pin asserting the clause was UNWRITTEN, with the note
    // "retire when `ActivationCost.xp` exists". It exists (wave 8), the two
    // printed abilities are now priced MODES of one entry, and the pin has been
    // turned round rather than deleted: the same board, the opposite assertion.
    //
    // Kept here as well as in `unl-signature-body-wave8.test.ts` deliberately —
    // this is the fixture the refusal was measured on, so it is the one that says
    // the refusal is over. The wave-8 file carries the negative controls.
    const state = khazixBoard(9);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "tired", might: 3, exhausted: true })],
      p2: [makeUnit({ instanceId: "theirs", might: 3 })],
    };
    const offered = activationsOf(state, legendId(state));
    expect(offered.length, "no ability at all is offered — this measures nothing").toBeGreaterThan(0);
    const home = offered.find((a) => a.modeId === "home" && a.targetUnitInstanceId === "tired");
    expect(home, "the move-home clause is not offered for the unit it is printed for").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, home!)));
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === "tired"), "the unit never went home").toBe(true);
    expect(after.players[0]!.xp, "the printed 2-XP price was not paid").toBe(7);
  });

  it("is registered — both written clauses reach the composed registries", () => {
    expect(implementingModules(KHAZIX_VOIDREAVER), "neither clause is registered").not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// UNL-203 Poppy - Keeper of the Hammer
// ---------------------------------------------------------------------------

describe("Poppy - Keeper of the Hammer (UNL-203): when you hold, gain 1 XP", () => {
  /** Poppy's controller in their Beginning Phase, alone at each of `held`. A hold
   *  is 469.2's "maintains Control of a Battlefield they did not yet Score this
   *  turn", which `isHeldBy` reads as units present and none of the opponent's. */
  function holding(held: readonly number[]): GameState {
    const state = withLegend(makeState({ phase: "Beginning", activePlayerIndex: 0 }), 0, POPPY_KEEPER);
    for (const index of held) {
      state.battlefields[index]!.units = { p1: [makeUnit({ might: 3 })] };
      state.battlefields[index]!.controllerId = "p1";
    }
    return state;
  }

  it("banks 1 XP for a held battlefield", () => {
    const settled = resolveHeldTriggers(runBeginning(holding([0])));
    expect(settled.players[0]!.xp, "the hold scored but Poppy banked nothing").toBe(1);
    // The ordinary hold point still lands — Poppy adds to the moment, she does not
    // replace it.
    expect(settled.players[0]!.points, "the hold itself stopped scoring").toBe(1);
  });

  it("banks once PER BATTLEFIELD, not once per Beginning Phase", () => {
    // `battlefieldHeld` is per battlefield and that shape is load-bearing: a
    // phase-shaped event could not say which battlefield was meant.
    expect(resolveHeldTriggers(runBeginning(holding([0, 1]))).players[0]!.xp, "two holds paid once").toBe(2);
  });

  it("banks nothing when the opponent is also present — that is not a hold", () => {
    const contested = holding([0]);
    contested.battlefields[0]!.units = { p1: [makeUnit({ might: 3 })], p2: [makeUnit({ might: 3 })] };
    expect(resolveHeldTriggers(runBeginning(contested)).players[0]!.xp, "a contested battlefield counted as held").toBe(0);
    // The positive control off the same shape, so the zero is about the hold and
    // not about a Legend that never fires.
    expect(resolveHeldTriggers(runBeginning(holding([0]))).players[0]!.xp, "the zero above proves nothing").toBe(1);
  });

  it("banks nothing for the OPPONENT's hold", () => {
    // "When YOU hold." Poppy sits on side 0; side 1 is the one holding, and it is
    // side 1's Beginning Phase.
    const state = withLegend(makeState({ phase: "Beginning", activePlayerIndex: 1 }), 0, POPPY_KEEPER);
    state.battlefields[0]!.units = { p2: [makeUnit({ might: 3 })] };
    state.battlefields[0]!.controllerId = "p2";

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.xp, "Poppy banked XP off the opponent's hold").toBe(0);
    expect(settled.players[1]!.xp, "the opponent inherited Poppy's clause").toBe(0);
  });
});

describe("Poppy - Keeper of the Hammer (UNL-203): Spend 3 XP, [Exhaust]: Draw 1", () => {
  function poppyBoard(xp: number): GameState {
    const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, POPPY_KEEPER);
    state.players[0]!.xp = xp;
    state.players[0]!.deck = [realUnitInstance(STALWART_PORO), realUnitInstance(STALWART_PORO)];
    return state;
  }

  it("draws exactly 1, spends exactly 3 XP and exhausts her", () => {
    const state = poppyBoard(5);
    const action = activationsOf(state, legendId(state))[0];
    expect(action, "the enumerator never offered Poppy's ability").toBeDefined();

    const after = answerDecisions(resolveHeldTriggers(accept(state, action!)));
    expect(after.players[0]!.hand.length, "no card was drawn").toBe(1);
    expect(after.players[0]!.xp, "the XP cost was not 3").toBe(2);
    expect(after.players[0]!.legend.exhausted, "the printed exhaust was not paid").toBe(true);
  });

  it("is NOT offered at 2 XP, and the 3-XP run beside it proves the threshold ran", () => {
    const short = poppyBoard(2);
    expect(activationsOf(short, legendId(short)).length, "she drew one XP short of the price").toBe(0);
    const exact = poppyBoard(3);
    expect(activationsOf(exact, legendId(exact)).length, "the zero above proves nothing").toBeGreaterThan(0);
  });

  it("is whole — both clauses are written, so coverage reports her implemented", () => {
    expect(isCardImplemented(registry.get(POPPY_KEEPER))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-204 Keeper's Verdict
// ---------------------------------------------------------------------------

describe("Keeper's Verdict (UNL-204): its OWNER picks top or bottom", () => {
  /** p0 holds the Verdict with the runes to cast it; p1 has `victim` at bf1 and
   *  `sheltered` at home, plus two cards already in deck so "top" and "bottom" are
   *  distinguishable positions rather than the same empty slot. */
  function verdictState(): { state: GameState; cardId: string } {
    const card = spellInstance(KEEPERS_VERDICT);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Order", 6);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", name: "victim", might: 9 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "sheltered", might: 2 })];
    state.players[1]!.deck = [realUnitInstance(STALWART_PORO), realUnitInstance(STALWART_PORO)];
    return { state, cardId: card.instanceId };
  }

  const verdictOn = (state: GameState, cardId: string, target: string) =>
    playsOf(state, cardId).find((a) => a.targetUnitInstanceId === target);

  it("asks the VICTIM's controller, not the caster", () => {
    const { state, cardId } = verdictState();
    const asked = resolveHeldTriggers(accept(state, verdictOn(state, cardId, "victim")!));

    expect(pendingDecision(asked)?.kind, "the placement question was never raised").toBe("UNL-204-place");
    expect(pendingDecision(asked)?.playerIndex, "the CASTER was asked to place the opponent's unit").toBe(1);
    expect(optionIds(asked), "both ends must be on offer, or the choice is not a choice").toEqual(["top", "bottom"]);
  });

  it("puts it on TOP when they say top", () => {
    const { state, cardId } = verdictState();
    const after = answerDecisions(resolveHeldTriggers(accept(state, verdictOn(state, cardId, "victim")!)), choose("top"));

    expect(unitAnywhere(after, "victim"), "the unit is still on the board").toBeUndefined();
    expect(after.players[1]!.deck[0]!.instanceId, "it did not land on top").toBe("victim");
    expect(after.players[1]!.deck.length).toBe(3);
    // Not a death: nothing reaches the trash, so no [Deathknell] and no
    // death-watch sees it.
    expect(after.players[1]!.trash.map((c) => c.instanceId), "it went to the trash as well").not.toContain("victim");
  });

  it("puts it on the BOTTOM when they say bottom — the same fixture, the other answer", () => {
    const { state, cardId } = verdictState();
    const after = answerDecisions(resolveHeldTriggers(accept(state, verdictOn(state, cardId, "victim")!)), choose("bottom"));

    expect(after.players[1]!.deck[after.players[1]!.deck.length - 1]!.instanceId, "it did not land on the bottom").toBe("victim");
    expect(after.players[1]!.deck[0]!.instanceId, "it landed on top after all").not.toBe("victim");
  });

  it("returns a FRESH card — damage, the buff, the stun and the exhaust are all gone (705)", () => {
    const { state, cardId } = verdictState();
    state.battlefields[0]!.units = {
      p2: [makeUnit({ instanceId: "victim", might: 9, damage: 4, buffed: true, stunned: true, exhausted: true, mightThisTurn: 3 })],
    };
    const after = answerDecisions(resolveHeldTriggers(accept(state, verdictOn(state, cardId, "victim")!)), choose("top"));

    const filed = after.players[1]!.deck[0]! as UnitInstance;
    expect(filed.instanceId).toBe("victim");
    expect(filed.damage, "damage travelled into the deck").toBe(0);
    expect(filed.buffed, "705 did not strip the Buff").toBe(false);
    expect(filed.stunned, "the stun travelled into the deck").toBe(false);
    expect(filed.exhausted, "it will be redrawn already exhausted").toBe(false);
    expect(filed.mightThisTurn, "a this-turn pump travelled into the deck").toBe(0);
  });

  it("cannot reach a unit in BASE, nor a FRIENDLY one", () => {
    // Two printed narrowings on one line: "an ENEMY unit AT A BATTLEFIELD"
    // (355.9.b). The friendly control needs a friendly body at a battlefield, or
    // the owner filter would be untested.
    const { state, cardId } = verdictState();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "ally", might: 3 })],
      p2: [makeUnit({ instanceId: "victim", name: "victim", might: 9 })],
    };
    const offered = playsOf(state, cardId).map((a) => a.targetUnitInstanceId);
    expect(offered, "a unit sheltering in base was targetable").not.toContain("sheltered");
    expect(offered, "the caster's own unit was targetable").not.toContain("ally");
    expect(offered, "nothing was offered at all — the negatives above prove nothing").toContain("victim");
  });

  // 186 / 186.1, read against `pdftotext -raw`: "Tokens are Created on the board
  // or the Chain and cannot exist elsewhere" / "If a token is put into any
  // Non-Board Zone besides the chain, it ceases to exist immediately after moving
  // to its new zone." NOT 714/715, which `fileIntoNonBoardZone`'s own doc comment
  // cites for exactly these two sentences and which are in fact Bonus Damage.
  it("a TOKEN ceases to exist rather than becoming a card in the deck (186.1)", () => {
    const { state, cardId } = verdictState();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", name: "victim", might: 9, isToken: true })] };
    const after = answerDecisions(resolveHeldTriggers(accept(state, verdictOn(state, cardId, "victim")!)), choose("top"));

    expect(unitAnywhere(after, "victim"), "the token survived on the board").toBeUndefined();
    expect(after.players[1]!.deck.map((c) => c.instanceId), "a token was filed into a Main Deck").not.toContain("victim");
    expect(after.players[1]!.deck.length, "the rest of the deck was disturbed").toBe(2);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KEEPERS_VERDICT))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What was REFUSED
// ---------------------------------------------------------------------------

describe("the card this wave refused", () => {
  // **Void Assault's refusal EXPIRED on 2026-08-12, and it was right about the
  // engine while being wrong about the card.** Both facts it named still hold: a
  // `PlayCardAction` carries exactly one `destinationBattlefieldId`, and
  // `MOVE_TARGET_SPELL_DEF_IDS` is not this file's to edit.
  //
  // What it missed is that neither is required. Wave 7 took the parked-decision
  // route instead — two destination questions asked in the printed order — which
  // is the split Call to Battle (UNL-101) and Stare Down (UNL-107) already ship in
  // the same file. That carries its own divergence from 355.4 (the opponent's
  // response window no longer shows where the bodies will land), recorded in
  // docs/rules-conformance.md rather than hidden.
  //
  // The lesson worth keeping: a refusal that correctly identifies one closed door
  // is not proof the room has no other. Its coverage now lives in
  // `unl-body-wave7.test.ts`.

  it("...and the other three ARE registered", () => {
    // The positive half, so the refusal above cannot be mistaken for the whole
    // wave being inert.
    //
    // `implementingModules`, not `isCardImplemented`: Kha'Zix is written by two
    // clauses of three and will carry a PARTIALLY_IMPLEMENTED row, which makes
    // `isCardImplemented` correctly false. "Is anything registered for this defId"
    // is the question actually meant, and it cannot flip that way.
    for (const defId of [KHAZIX_VOIDREAVER, POPPY_KEEPER, KEEPERS_VERDICT]) {
      expect(implementingModules(defId), `${defId} is not registered`).not.toEqual([]);
    }
  });
});
