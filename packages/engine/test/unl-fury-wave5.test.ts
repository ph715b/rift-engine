import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { recordConquest } from "../src/engine/scoring.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { grantKeywordThisTurn } from "../src/engine/effect-helpers.js";
import { implementingModules, isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { ActivateAbilityAction, PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  pickCard,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Unleashed's FIFTH Fury wave — engine/effects/fury.ts.
 *
 * Two of the four cards are whole, one is half written on purpose, and one was
 * REFUSED outright. Naming the gaps here is the point: a card written against a
 * mechanism that does not exist reports DONE and does nothing, so each gap is
 * asserted as a WRONG ANSWER on purpose and closing it has to fail here rather
 * than change behaviour nobody was watching.
 *
 *   - **UNL-030 Vi - Hotheaded** — whole.
 *   - **UNL-029 Red Brambleback** — the conquer buff is written; "your conquer
 *     effects for conquering here trigger an additional time" is NOT, and is
 *     pinned below by a second conquer trigger firing exactly once.
 *   - **UNL-028 Pyke - Dockside Butcher** — WHOLE, but only after integration.
 *     The trigger shipped from this pass written and INERT, because his optional
 *     `[Fury]` cost is one row in `card-effects.OPTIONAL_POWER_COSTS` — a shared
 *     file the card pass did not own — so `optionalPowerPaid` could never be true
 *     in a real game. The integrator added `"UNL-028": { domain: "Fury", count: 1 }`
 *     with the wave; the pin that asserted the enumeration absent went red on the
 *     first root run and is now flipped to assert both variants are offered and
 *     that only the paid one readies and pumps.
 *   - **UNL-025 Undying Legion** — refused by this wave, and LANDED 2026-08-13.
 *     His refusal block was deleted rather than inverted; see the tombstone at
 *     the foot of this file and `test/replaced-costs.test.ts` for his coverage.
 *
 * Everything that CAN go through a real funnel does: `legalActions` to build the
 * action, `submit` to take it, focus passes to settle the chain, and
 * `answerDecisions` for the question. The one exception is Pyke's positive
 * control, which no real action can reach today and says so.
 */

const registry = defaultCardRegistry();

/** `registry.get` returns the `CardDefinition` UNION, and `might` / `keywords`
 *  live only on `UnitDefinition`. Narrow through this rather than through
 *  `def.type === "Unit" && def.might`, which yields `false` for a non-Unit and
 *  reports a type mistake as a wrong Might. */
function unitDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit definition`);
  return def;
}

const UNDYING_LEGION = "UNL-025"; // [Legion][>] play me from your trash for [3][Fury] — LANDED 2026-08-13, see test/replaced-costs.test.ts
const PYKE_BUTCHER = "UNL-028"; // optional [Fury] cost -> ready me and +2 Might
const RED_BRAMBLEBACK = "UNL-029"; // [Accelerate]; conquer effects here twice; when I conquer, [Buff]
const VI_HOTHEADED = "UNL-030"; // [Deflect]; [2][Fury]: double my Might this turn

/** Inviolus Vox — "when I conquer, give a friendly unit +8 Might this turn". A
 *  SECOND conquer effect for conquering at the Brambleback's battlefield, which
 *  is the only way to observe whether the doubling clause exists. */
const INVIOLUS_VOX = "UNL-027";

const VI_PRINTED_MIGHT = 3;
const BRAMBLEBACK_PRINTED_MIGHT = 4;

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });
const runes = (count: number): RuneCard[] => Array.from({ length: count }, (_, i) => fury(`f${i}`));

function accept(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the action was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain, the holding pen and any open Showdown have all
 *  settled — or until a question blocks, which is itself an answer worth
 *  asserting on. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (pendingDecision(current)) return current;
    if (current.turnState !== "Showdown" && current.spellChain.length === 0 && current.pendingTriggers.length === 0) {
      return current;
    }
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  throw new Error("settle: the chain never emptied");
}

function unitsInPlay(state: GameState): UnitInstance[] {
  return [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])]),
  ];
}

const findAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  unitsInPlay(state).find((u) => u.instanceId === instanceId);

/** The unit's Might as the board would report it outside combat — what "double my
 *  Might" is measured against, and the only figure that shows the pump landed
 *  where a reader will see it. */
const mightOf = (state: GameState, instanceId: string, ownerIndex: 0 | 1 = 0, battlefieldId?: string): number =>
  effectiveMight(state, findAnywhere(state, instanceId)!, ownerIndex, {
    isCombat: false,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
  });

const activationsOf = (state: GameState, instanceId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

/** Everything on the chain or still in the holding pen, by the defId that raised
 *  it. `submit` runs a Cleanup, so a trigger held by an action is usually already
 *  a Chain Item by the time the action returns — reading only the pen finds an
 *  empty array and every `toContain` against it lies. */
const chainDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId as string),
];

describe("the four cards this file is about are the cards the registry prints", () => {
  it("names match", () => {
    for (const [defId, name] of [
      [UNDYING_LEGION, "Undying Legion"],
      [PYKE_BUTCHER, "Pyke - Dockside Butcher"],
      [RED_BRAMBLEBACK, "Red Brambleback"],
      [VI_HOTHEADED, "Vi - Hotheaded"],
      [INVIOLUS_VOX, "Inviolus Vox"],
    ] as const) {
      expect(registry.get(defId)?.name, `${defId} is a different card`).toBe(name);
    }
  });

  it("the printed Might the doubling and the buff are measured against has not changed", () => {
    // `CardDefinition` is a union and only `UnitDefinition` carries `might`, so
    // this narrows through a helper that THROWS rather than through the
    // `def.type === "Unit" && def.might` idiom used elsewhere in the suite: that
    // expression yields `false` for a non-Unit, which reads as a Might mismatch
    // and would send the next reader looking at the card data instead of the type.
    expect(unitDef(VI_HOTHEADED).might).toBe(VI_PRINTED_MIGHT);
    expect(unitDef(RED_BRAMBLEBACK).might).toBe(BRAMBLEBACK_PRINTED_MIGHT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Vi - Hotheaded (UNL-030): [2][Fury]: double my Might this turn", () => {
  /** Vi at bf1 with a friendly bystander beside her, and enough Fury channeled to
   *  pay twice — the ability prints no exhaust, so a one-activation fixture could
   *  not tell a missing tap from an unaffordable second use. */
  function viState(overrides: { buffed?: boolean; runeCount?: number } = {}): { state: GameState; vi: UnitInstance } {
    const vi = { ...realUnitInstance(VI_HOTHEADED), ...(overrides.buffed ? { buffed: true } : {}) };
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [vi, makeUnit({ instanceId: "bystander", might: 2 })] };
    state.players[0]!.channeled = runes(overrides.runeCount ?? 9);
    return { state, vi };
  }

  function activate(state: GameState, vi: UnitInstance): GameState {
    const candidates = activationsOf(state, vi.instanceId);
    expect(candidates.length, "Vi's ability was never offered — the fixture cannot pay for it").toBeGreaterThan(0);
    return settle(accept(state, candidates[0]!));
  }

  it("doubles her printed Might through a REAL ActivateAbility", () => {
    const { state, vi } = viState();
    expect(mightOf(state, vi.instanceId, 0, "bf1"), "the fixture was already pumped").toBe(VI_PRINTED_MIGHT);

    const after = activate(state, vi);
    expect(findAnywhere(after, vi.instanceId)!.mightThisTurn, "the ability resolved but nothing was added").toBe(
      VI_PRINTED_MIGHT,
    );
    expect(mightOf(after, vi.instanceId, 0, "bf1")).toBe(VI_PRINTED_MIGHT * 2);
  });

  it("doubles the EFFECTIVE figure, so a buff is part of what gets doubled", () => {
    // 3 printed + 1 buff (703) = 4, so the pump is 4 and she ends at 8 — not 6,
    // which is what reading `unit.might` would give.
    const { state, vi } = viState({ buffed: true });
    expect(mightOf(state, vi.instanceId, 0, "bf1")).toBe(VI_PRINTED_MIGHT + 1);

    const after = activate(state, vi);
    expect(findAnywhere(after, vi.instanceId)!.mightThisTurn).toBe(VI_PRINTED_MIGHT + 1);
    expect(mightOf(after, vi.instanceId, 0, "bf1")).toBe((VI_PRINTED_MIGHT + 1) * 2);
  });

  it("NEGATIVE CONTROL: the unit standing beside her is untouched", () => {
    const { state, vi } = viState();
    const after = activate(state, vi);
    expect(findAnywhere(after, "bystander")!.mightThisTurn, "the pump hit the whole battlefield").toBe(0);
  });

  it("prints no [Exhaust], so it can be taken twice — and the second doubles the doubled figure", () => {
    // 317's this-turn effects are fixed amounts: the first activation snapshots 3
    // and the second snapshots the 6 it left, so she ends at 12 rather than at 9.
    const { state, vi } = viState();
    const once = activate(state, vi);
    expect(findAnywhere(once, vi.instanceId)!.exhausted, "the ability invented an exhaust cost").toBe(false);

    const twice = activate(once, vi);
    expect(mightOf(twice, vi.instanceId, 0, "bf1")).toBe(VI_PRINTED_MIGHT * 4);
  });

  it("spends 2 Energy and recycles a Fury rune — the price is really taken", () => {
    const { state, vi } = viState({ runeCount: 4 });
    const before = state.players[0]!.channeled.length;
    const after = activate(state, vi);

    // The Power pip is RECYCLED (416) — the rune leaves the channeled row entirely
    // — while the Energy exhausts runes that stay put. So the row is one shorter.
    expect(after.players[0]!.channeled.length, "the Fury rune was never recycled").toBe(before - 1);
    // **ONE exhausted rune, not two**, and that is 164.2's double duty rather than
    // an underpayment: `payPowerFromChanneled` credits 1 floating Energy for every
    // READY rune it recycles, and `payActivationEnergy` spends floating Energy
    // before it touches the named runes. So the Fury rune paid the pip and one of
    // the two Energy, and the credit is spent rather than banked.
    expect(after.players[0]!.channeled.filter((r) => r.state !== "Ready").length, "the Energy was never paid").toBe(1);
    expect(after.players[0]!.floatingEnergy, "the recycle credit was banked instead of spent").toBe(0);
    // Four runes in, three left, one of them spent: three of the four are gone or
    // spent for a 2-Energy-plus-a-pip price, which is what a reader can check.
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(2);
  });

  it("is NOT offered when the Fury rune cannot be paid", () => {
    // The positive control for the price above: three runes of the WRONG domain
    // pay the Energy and nothing else, so an ability that ignored its pip would
    // still be enumerated here.
    const { state, vi } = viState({ runeCount: 0 });
    state.players[0]!.channeled = [
      { id: "c0", domain: "Calm", state: "Ready" },
      { id: "c1", domain: "Calm", state: "Ready" },
      { id: "c2", domain: "Calm", state: "Ready" },
    ];
    expect(activationsOf(state, vi.instanceId), "the Fury pip is not being charged").toHaveLength(0);
  });

  it("works from BASE too — 'my Might' names no location", () => {
    const vi = realUnitInstance(VI_HOTHEADED);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [vi];
    state.players[0]!.channeled = runes(6);

    const after = activate(state, vi);
    expect(mightOf(after, vi.instanceId)).toBe(VI_PRINTED_MIGHT * 2);
  });

  /**
   * **The `[Assault]` half of the 432.1 divergence became UNREACHABLE on
   * 2026-08-24, and this test is what is left of the pin that used to assert it.**
   *
   * It read: *"PINS THE DIVERGENCE: an ATTACKING Vi with [Assault 2] doubles 3,
   * and 432.1 says 5"*, and its fixture opened a Combat Showdown so that
   * `[Assault]` would apply at all — **807.1.c** makes it short for "While I am
   * an attacker, I have +X [M]". Then it activated her ability inside that
   * Showdown.
   *
   * **That activation is now illegal.** Her ability prints no speed keyword, so
   * **310.1.a** times it to "a Neutral Open state" on its controller's turn.
   * `currentMightContext` reports `isCombat: true` for exactly one situation —
   * `showdownKind === "Combat"` at this unit's own battlefield — and a
   * default-speed ability can no longer be activated there. So there is no legal
   * board on which her doubling reads an attacking Might, and switching her
   * resolver to a combat-aware context would be provably inert.
   *
   * **The gap is unreachable rather than closed**, and the two are different
   * claims: `docs/rules-conformance.md` says so, and an ability that later prints
   * `[Action][>]` or `[Reaction][>]` AND reads current Might would make it
   * reachable again. Today none of the twenty speed-tagged abilities reads Might
   * at all — see `ability-timing.test.ts` for the list and what pins it.
   *
   * **Last Stand's half was already closed**, on 2026-08-23, by teaching that
   * card to read current Might. The deleted pin's failure message still said
   * "delete this pin and Last Stand's", which had been stale since that day.
   */
  it("her default-speed ability cannot be activated inside a Combat Showdown (310.1.a)", () => {
    const vi = realUnitInstance(VI_HOTHEADED);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [vi], p2: [makeUnit({ instanceId: "enemy", might: 1 })] };
    state.players[0]!.channeled = runes(6);
    const armed = grantKeywordThisTurn(state, vi.instanceId, "Assault", 2);

    // **The control, and it is the whole test.** Her ability IS offered on this
    // exact board while the turn is Neutral Open — same unit, same runes, same
    // grant. So the refusal below is the Showdown, not an unaffordable cost or a
    // fixture that never had a legal activation in it.
    expect(
      activationsOf(armed, vi.instanceId).length,
      "she was not activatable even in a Neutral Open state — this fixture measures nothing",
    ).toBeGreaterThan(0);

    // Player 0 applied Contested, so 464.2.c makes them the Attacker and Focus is
    // theirs — they hold priority and could pay. The ONLY thing standing in the
    // way is the timing tier.
    const fighting = beginCombatAt(armed, "bf1", 0);
    expect(fighting.turnState, "the fixture never opened a Showdown").toBe("Showdown");
    expect(fighting.showdownKind).toBe("Combat");

    expect(
      activationsOf(fighting, vi.instanceId),
      "a default-speed ability was offered inside a Showdown — 310.1.a times it to a Neutral Open state",
    ).toHaveLength(0);
  });

  it("...and [Assault] really would have applied there — why the divergence is unreachable, not absent", () => {
    // Without this, the test above would also pass on a board where the grant had
    // silently failed to land, and the claim "there is no legal board on which her
    // doubling reads 5" would be true for the wrong reason.
    const vi = realUnitInstance(VI_HOTHEADED);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [vi], p2: [makeUnit({ instanceId: "enemy", might: 1 })] };
    const fighting = beginCombatAt(grantKeywordThisTurn(state, vi.instanceId, "Assault", 2), "bf1", 0);

    const combatMight = effectiveMight(fighting, findAnywhere(fighting, vi.instanceId)!, 0, {
      isCombat: true,
      isAttackingSide: true,
      combatRole: "remaining",
      battlefieldId: "bf1",
    });
    expect(combatMight, "the [Assault] grant never landed").toBe(VI_PRINTED_MIGHT + 2);
  });
  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VI_HOTHEADED))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Red Brambleback (UNL-029): when I conquer, [Buff] a friendly unit", () => {
  /** The Brambleback at bf1 and a second friendly unit in base, so the question
   *  has two real answers and `advanceDecisions` cannot retire it unprompted. */
  function bramblebackState(): { state: GameState; brambleId: string; allyId: string } {
    const bramble = realUnitInstance(RED_BRAMBLEBACK);
    const ally = makeUnit({ name: "Ally" });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [bramble] };
    state.players[0]!.baseUnits = [ally];
    return { state, brambleId: bramble.instanceId, allyId: ally.instanceId };
  }

  it("buffs the unit its controller names", () => {
    const { state, allyId } = bramblebackState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), pickCard(allyId));
    expect(findAnywhere(settled, allyId)!.buffed, "the buff never landed").toBe(true);
  });

  it("can name himself — the text says no 'other'", () => {
    const { state, brambleId } = bramblebackState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf1")), pickCard(brambleId));
    expect(findAnywhere(settled, brambleId)!.buffed).toBe(true);
  });

  it("conquers by WALKING IN and buffs — the whole path through submit", () => {
    // `recordConquest` above is the engine's own conquest funnel, but it is called
    // by hand. This one moves him with a real `MoveUnit`, lets the Non-Combat
    // Showdown stage and close on its own (466.5 / 469.1), and answers the
    // question with a real `AnswerDecision`.
    const bramble = realUnitInstance(RED_BRAMBLEBACK);
    // A second friendly unit stays home, so the question has two answers. With one
    // candidate `advanceDecisions` retires it unprompted — correct behaviour, and
    // it would make `pendingDecision` undefined and this test measure nothing.
    const homebody = makeUnit({ name: "Homebody" });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [bramble, homebody];

    const move = legalActions(state).find(
      (a) =>
        a.type === "MoveUnit" &&
        a.destinationBattlefieldId === "bf1" &&
        a.unitInstanceIds.includes(bramble.instanceId),
    );
    const conquered = settle(accept(state, move));
    expect(conquered.players[0]!.points, "the walk-in was not a conquest").toBe(1);

    const question = pendingDecision(conquered);
    expect(question, "the Brambleback never asked").toBeDefined();
    expect(question!.playerIndex).toBe(0);
    expect(optionsFor(conquered, question!).map((o) => o.id).sort()).toEqual(
      [bramble.instanceId, homebody.instanceId].sort(),
    );

    const answered = accept(conquered, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: question!.id,
      optionId: bramble.instanceId,
    });
    expect(findAnywhere(answered, bramble.instanceId)!.buffed, "the real path dropped the buff").toBe(true);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the conquest", () => {
    const { state, allyId } = bramblebackState();
    const held = recordConquest(state, 0, "bf1");
    // Asserted BEFORE `resolveHeldTriggers`, which drains the pen.
    expect(held.pendingTriggers.map((e) => e.listenerDefId)).toContain(RED_BRAMBLEBACK);
    expect(findAnywhere(held, allyId)!.buffed, "the buff landed without a response window").toBe(false);
  });

  it("does NOT fire for a conquest at a DIFFERENT battlefield", () => {
    const { state, allyId } = bramblebackState();
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(state, 0, "bf2")));
    expect(pendingDecision(settled)).toBeUndefined();
    expect(findAnywhere(settled, allyId)!.buffed).toBe(false);
  });

  it("does NOT fire when the OPPONENT conquers the battlefield he stands at", () => {
    // "When *I* conquer" is his own controller's conquest. The listener walk finds
    // him wherever he is, so without the conqueror check he would pay out for the
    // other side's win.
    const { state, allyId, brambleId } = bramblebackState();
    const held = recordConquest(state, 1, "bf1");
    // **Asserted on the PEN, not only on the outcome.** `resolve` re-asks the
    // conqueror question, so a trigger wrongly HELD for the opponent's conquest
    // still buffs nobody — and a test that only checked the buff would pass with
    // the `applies` condition deleted. Measured: that mutation survived until this
    // line existed. A Pending Item that can only resolve to nothing still costs
    // both players a PassFocus, which is the thing `applies` is for.
    expect(chainDefIds(held), "he was held for the opponent's conquest").not.toContain(RED_BRAMBLEBACK);

    const settled = answerDecisions(resolveHeldTriggers(held));
    expect(findAnywhere(settled, allyId)!.buffed).toBe(false);
    expect(findAnywhere(settled, brambleId)!.buffed).toBe(false);
  });

  it("doubles conquer effects here — was a pin, flipped 2026-08-11", () => {
    // Inviolus Vox is a SECOND conquer effect for conquering at the same
    // battlefield. With the doubling clause implemented he would pump 16; the
    // multiplier does not exist (`holdEventTrigger` pushes exactly one entry per
    // listener, and there is no `times` outside `resolveHeldDeathknell`), so he
    // pumps 8 and the Brambleback asks once.
    //
    // Delete this test WITH the gap, not before it.
    const bramble = realUnitInstance(RED_BRAMBLEBACK);
    const vox = realUnitInstance(INVIOLUS_VOX);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [bramble, vox] };

    // **The doubling is ONE chain item that executes twice, not two items** —
    // deliberately matching Karthus - Eternal, who prints the identical sentence
    // and has been implemented that way since long before this card. 383.3
    // arguably wants two items with a response window between; that reading is
    // recorded as a divergence in docs/rules-conformance.md covering all three
    // cards, rather than applied to two of them and not the third.
    //
    // So the chain still holds ONE entry per listener — this half of the pin is
    // UNCHANGED and is what says the implementation took the consistent route.
    const held = recordConquest(state, 0, "bf1");
    expect(
      chainDefIds(held).filter((id) => id === RED_BRAMBLEBACK),
      "the doubling became two chain items — see the divergence row before changing this",
    ).toHaveLength(1);
    expect(
      chainDefIds(held).filter((id) => id === INVIOLUS_VOX),
      "the doubling became two chain items — see the divergence row before changing this",
    ).toHaveLength(1);

    // What DID change: that one entry now executes twice.
    const settled = answerDecisions(resolveHeldTriggers(held), pickCard(vox.instanceId));
    expect(findAnywhere(settled, vox.instanceId)!.mightThisTurn, "Vox's +8 stopped doubling").toBe(16);
  });

  it("is REGISTERED — which is why the gap above needs its pin and a PARTIAL entry", () => {
    // Asserted as registration rather than as `isCardImplemented`, deliberately.
    // Registration is per defId, so the conquer clause alone makes him report DONE
    // today; the moment the integrator adds his `coverage.PARTIALLY_IMPLEMENTED`
    // row for the unwritten doubling, `isCardImplemented` flips to FALSE — which is
    // the correct answer and must not read here as a regression.
    expect(implementingModules(RED_BRAMBLEBACK)).toContain("event triggers");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Pyke - Dockside Butcher (UNL-028): if you paid the additional cost, ready me and +2 Might", () => {
  /** Pyke in hand with plenty of Fury channeled — enough to pay his printed 3
   *  Energy AND the optional pip several times over, so an unoffered paid variant
   *  is a missing row and never a fixture that cannot afford it. */
  function pykeState(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spellInstance(PYKE_BUTCHER)];
    state.players[0]!.channeled = runes(9);
    return state;
  }

  // **This was a PIN and is now a real test.** It was written asserting that the
  // paid variant is NOT offered, because the missing half was one row in
  // `card-effects.OPTIONAL_POWER_COSTS` — a shared file the agent that wrote this
  // card could not edit while four siblings were writing. The integrator added
  // `"UNL-028": { domain: "Fury", count: 1 }` with the wave, the pin went red on
  // the first root run, and it is flipped here to assert the right answer rather
  // than deleted. Both variants are checked, so a build that offers only one is
  // still caught.
  it("offers BOTH variants, and only the paid one readies and pumps him", () => {
    const state = pykeState();
    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === PYKE_BUTCHER,
    );
    expect(plays.length, "Pyke was not playable at all — the fixture measures nothing").toBeGreaterThan(0);

    const paid = plays.find((a) => a.optionalPowerPaid === true);
    const unpaid = plays.find((a) => a.optionalPowerPaid !== true);
    expect(paid, "the optional [Fury] variant is not enumerated — the OPTIONAL_POWER_COSTS row is gone").toBeDefined();
    expect(unpaid, "the free variant vanished — the optional cost became mandatory").toBeDefined();

    const withCost = settle(accept(state, paid!));
    const pykePaid = unitsInPlay(withCost).find((u) => u.defId === PYKE_BUTCHER);
    expect(pykePaid, "the paid Pyke never reached the board").toBeDefined();
    expect(pykePaid!.exhausted, "the paid Pyke was never readied").toBe(false);
    // The PRINTED 2, deliberately not `fury.ts`'s own `PYKE_BUTCHER_MIGHT` —
    // asserting a value against the constant that produces it proves nothing.
    expect(pykePaid!.mightThisTurn, "the paid Pyke was never pumped").toBe(2);

    // The negative half, on the SAME fixture: declining the cost must change the
    // outcome, or the assertions above would pass on a build that ignores the flag.
    const without = settle(accept(state, unpaid!));
    const pykeFree = unitsInPlay(without).find((u) => u.defId === PYKE_BUTCHER);
    expect(pykeFree!.exhausted, "an unpaid Pyke readied himself").toBe(true);
    expect(pykeFree!.mightThisTurn, "an unpaid Pyke pumped himself").toBe(0);
  });

  it("and the clause itself works when the flag arrives", () => {
    // The positive control for the pin above: the clause is written and correct,
    // and only the enumeration of the cost is missing. Driven through
    // `dispatchOnPlayUnit`, which is the funnel `execute-play-card` calls — this is
    // the one assertion in this file that no real action can reach today.
    const pyke = { ...realUnitInstance(PYKE_BUTCHER), exhausted: true };
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [pyke];

    const after = playUnitTrigger(state, pyke, 0, "base", { optionalPowerPaid: true });
    const landed = findAnywhere(after, pyke.instanceId)!;
    expect(landed.exhausted, "the paid Pyke was never readied").toBe(false);
    expect(landed.mightThisTurn, "the paid Pyke was never pumped").toBe(2);
  });

  it("NEGATIVE CONTROL: the same dispatch WITHOUT the flag does neither", () => {
    const pyke = { ...realUnitInstance(PYKE_BUTCHER), exhausted: true };
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [pyke];

    const after = playUnitTrigger(state, pyke, 0, "base");
    const landed = findAnywhere(after, pyke.instanceId)!;
    expect(landed.exhausted, "the clause is not gated on the cost at all").toBe(true);
    expect(landed.mightThisTurn).toBe(0);
  });

  it("is REGISTERED, so he reports DONE while doing nothing — hence the pin and a PARTIAL entry", () => {
    // Same reasoning as the Brambleback's: registration is per defId, and the day
    // his `coverage.PARTIALLY_IMPLEMENTED` row lands `isCardImplemented` flips to
    // FALSE, which is correct rather than a regression.
    expect(implementingModules(PYKE_BUTCHER)).toContain("unit-triggers");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// **Undying Legion (UNL-025) LANDED on 2026-08-13, and his refusal block was
// deleted rather than inverted.** It lived here and asserted `isCardImplemented`
// was false, plus a positive control that he was unreachable in the trash.
//
// His tests are now `test/replaced-costs.test.ts`, alongside UNL-089 Jhin -
// Meticulous Killer, who prints the same sentence from hand. A second file
// claiming a fact about the same card is how the premise-flip class starts over,
// so this is a pointer and not a re-assertion.
//
// **The refusal named the blocker exactly and the fix is shaped by it**: the
// engine's only trash-play permission was Last Rites' `trashUnitPlaysThisTurn`,
// a per-PLAYER allowance for ANY unit at its ordinary cost. It is now joined by
// a per-CARD permission carrying a price of its own (rule 356.1.a), and the two
// are deliberately kept apart in `timing.ts` — `mayPlayFromTrashOnCharge` is the
// one that gets SPENT.
//
// The refusal's 366.1 citation was checked against `pdftotext -raw` and is
// exactly right: that rule works this very card as its example.
