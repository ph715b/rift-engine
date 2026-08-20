import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { parseEmpowerCost } from "../src/cards/card-loader.js";
import { empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's last two compound `[Empower]` costs** — Legion Marauder's "[1] or
 * [Body]", and Mel, Defiant Soul's "Discard a spell".
 *
 * Both refusal notes named their blocker exactly right, and neither was closed
 * the way the note assumed:
 *
 *   - "[1] or [Body]" was refused because "either half alone is cheaper than the
 *     choice and both together are dearer, so neither is the card". Both still
 *     true — so it is NEITHER. It becomes two `AbilityMode`s, which have priced
 *     modes separately since Jax - Grandmaster At Arms, and the player picks.
 *   - "Discard a spell" was refused because `ActivationCost.discard` counts ANY
 *     card, "so charging it would let the player discard a unit instead… It needs
 *     a narrowed discard field." That field is `discardKind`, added in a different
 *     set for Sky Cruiser's "Discard a GEAR".
 *
 * **Mel's cost alone would have been a coverage lie**, and that is the half this
 * file spends the most on. Parsing her Empower cost registers a generated ability
 * under her defId, so `isCardImplemented` said yes the moment the cost read —
 * while her second sentence ("when I become [Empowered], banish an enemy unit at
 * a battlefield with 3 [Might] or less") did nothing at all. The clause is a new
 * `becameEmpowered` event fired from `empowerPermanent`, the single WRITER of the
 * status, so she triggers however she was empowered rather than only off her own
 * ability.
 */

const registry = defaultCardRegistry();

const MARAUDER = "VEN-074"; // Body Unit, 2 Energy 2 Might — [Empower] — [1] or [Body]
const MEL_DEFIANT = "VEN-110"; // Chaos Unit, 5 Energy 4 Might — [Empower] — Discard a spell
const A_SPELL = "OGN-004";
const A_UNIT = "OGN-003";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const activationsOf = (state: GameState) =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === "subject",
  );

describe("both report implemented — the premise", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [MARAUDER, MEL_DEFIANT]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });
});

describe("Legion Marauder (VEN-074): an alternative cost is two MODES", () => {
  /** The Marauder in play with `energy` Fury runes and `body` Body ones — two
   *  pools, because the whole card is that they are not interchangeable. */
  function board(energyRunes: number, bodyRunes: number): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(MARAUDER), instanceId: "subject" }];
    state.players[0]!.channeled = [
      ...Array.from({ length: energyRunes }, (_, i) => rune(`f${i}`, "Fury")),
      ...Array.from({ length: bodyRunes }, (_, i) => rune(`b${i}`, "Body")),
    ];
    return state;
  }

  it("declares two modes, priced differently", () => {
    const ability = activatedAbilityFor(MARAUDER);
    expect(ability?.modes?.map((m) => m.id), "the alternative did not become two modes").toEqual([
      "printed",
      "alternative",
    ]);
    expect(ability!.modes![0]!.cost, "the printed half is not [1] Energy").toEqual({ energy: 1 });
    expect(ability!.modes![1]!.cost, "the alternative is not one Body pip").toEqual({
      power: { domain: "Body", count: 1 },
    });
    // **`cost` must be ABSENT on the ability itself.** `AbilityMode.cost`
    // "overrides the ability's cost entirely", and a leftover ability-level cost
    // would be a second price nobody can see.
    expect(ability!.cost, "the ability kept a price of its own beside its modes").toBeUndefined();
  });

  it("refuses a half carrying anything but pips", () => {
    // `pipTermCost` is ANCHORED, and this is what the anchors are for: a loose
    // match would read the pips it recognised and silently drop the rest of the
    // half, charging a price the card does not print. Nothing in the pool prints
    // this, which is exactly why it needs a test rather than a card.
    expect(
      parseEmpowerCost("[Empower] — :rb_energy_1: and a promise or :rb_rune_body: (reminder)"),
      "a half with trailing text was read as a bare pip",
    ).toBeUndefined();
  });

  it("offers BOTH prices when both are payable", () => {
    // The card is a choice, so a board that can pay either way must show both —
    // an engine that picked one for the player would be choosing which resource
    // they spend.
    const modes = activationsOf(board(3, 3)).map((a) => a.modeId);
    expect(modes.sort(), "both prices were not offered").toEqual(["alternative", "printed"]);
  });

  it("offers ONLY the Energy half with no Body runes", () => {
    // The negative that makes the pair mean something: a Fury-only board cannot
    // pay a Body pip, and charging the cheaper half regardless is exactly the
    // misreading the old refusal named.
    const modes = activationsOf(board(3, 0)).map((a) => a.modeId);
    expect(modes, "a Body pip was offered with no Body rune to pay it").toEqual(["printed"]);
  });

  it("...and ONLY the Body half with no Energy to spare", () => {
    // One Body rune and nothing else. It cannot pay 1 Energy — a Power cost
    // RECYCLES its rune where an Energy cost exhausts one, and with a single rune
    // both are possible in principle, so the fixture is what settles it: this
    // asserts the offer list, and the next test asserts the rune really went.
    const modes = activationsOf(board(0, 1)).map((a) => a.modeId);
    expect(modes, "the Body half was not offered").toContain("alternative");
  });

  it("is offered NOT AT ALL with an empty pool", () => {
    expect(activationsOf(board(0, 0)), "an unpayable Empower was offered").toEqual([]);
  });

  it("charges the half the player picked, and empowers either way", () => {
    // Both halves lead to the same place — 827.1.c.1's "[Cost]: Empower this" —
    // so the assertion that separates them is WHICH resource left.
    const viaEnergy = board(3, 3);
    const energyPlay = activationsOf(viaEnergy).find((a) => a.modeId === "printed")!;
    const afterEnergy = accept(viaEnergy, energyPlay);
    expect(isEmpowered(afterEnergy, "subject"), "the Energy half did not Empower him").toBe(true);
    expect(afterEnergy.players[0]!.channeled.length, "the Energy half recycled a rune").toBe(6);

    const viaBody = board(3, 3);
    const bodyPlay = activationsOf(viaBody).find((a) => a.modeId === "alternative")!;
    const afterBody = accept(viaBody, bodyPlay);
    expect(isEmpowered(afterBody, "subject"), "the Body half did not Empower him").toBe(true);
    // A Power cost RECYCLES the rune (416), so the pool is one SHORTER — where the
    // Energy half above exhausted one in place and left the count alone.
    expect(afterBody.players[0]!.channeled.length, "the Body pip was not recycled").toBe(5);
  });

  it("grants its +1 Might, and stops offering itself", () => {
    const state = board(3, 3);
    const after = accept(state, activationsOf(state)[0]!);
    const unit = after.players[0]!.baseUnits[0]!;

    expect(effectiveMight(after, unit, 0, { isCombat: false }), "the Empowered payload did not land").toBe(
      unit.might + 1,
    );
    expect(activationsOf(after), "an already-Empowered unit was offered its own Empower").toEqual([]);
  });
});

describe("Mel, Defiant Soul (VEN-110): a narrowed discard, and the clause behind it", () => {
  /** Mel in play, with `spells` spells and `units` units in hand and an enemy
   *  board of the given Mights at bf1. */
  function board(hand: { spells: number; units: number }, enemyMights: number[]): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(MEL_DEFIANT), instanceId: "subject" }];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Chaos"));
    state.players[0]!.hand = [
      ...Array.from({ length: hand.spells }, () => spellInstance(A_SPELL)),
      ...Array.from({ length: hand.units }, () => realUnitInstance(A_UNIT)),
    ];
    state.battlefields[0]!.units = {
      p2: enemyMights.map((might, i) => makeUnit({ instanceId: `enemy-${i}`, might })),
    };
    return state;
  }

  const enemiesLeft = (state: GameState) => (state.battlefields[0]!.units.p2 ?? []).map((u) => u.instanceId);

  it("costs a SPELL, and a hand of units cannot pay it", () => {
    // The whole reason the old refusal held out for `discardKind`: charging a
    // bare count would let a hand of units buy the Empower, which is cheaper than
    // printed.
    expect(activationsOf(board({ spells: 0, units: 3 }, [1])), "a hand of units paid a spell cost").toEqual([]);
    expect(activationsOf(board({ spells: 1, units: 0 }, [1])).length, "a spell in hand could not pay").toBe(1);
  });

  it("charges the spell and Empowers her", () => {
    const state = board({ spells: 1, units: 2 }, [1]);
    const after = accept(state, activationsOf(state)[0]!);

    expect(isEmpowered(after, "subject"), "paying did not Empower her").toBe(true);
    expect(after.players[0]!.hand.map((c) => c.kind), "the discard took the wrong card").toEqual(["Unit", "Unit"]);
  });

  it("banishes an enemy of 3 Might or less when she becomes Empowered", () => {
    const state = board({ spells: 1, units: 0 }, [2]);
    // The trigger is HELD, so it resolves a chain pop later — a test that read
    // the board straight after the activation would be looking too early.
    const settled = resolveHeldTriggers(accept(state, activationsOf(state)[0]!));

    expect(enemiesLeft(settled), "the enemy was not banished").toEqual([]);
    // BANISHED, not killed: no trash, no `[Deathknell]`, nothing to recur.
    expect(settled.players[1]!.banished.map((c) => c.instanceId), "it went somewhere other than banished").toEqual([
      "enemy-0",
    ]);
    expect(settled.players[1]!.trash, "a banish put the card in a trash").toHaveLength(0);
  });

  it("...and cannot reach one over 3 Might", () => {
    // The negative beside it. Without this, "she banished something" proves
    // nothing about the printed ceiling.
    const state = board({ spells: 1, units: 0 }, [4]);
    const settled = resolveHeldTriggers(accept(state, activationsOf(state)[0]!));

    expect(enemiesLeft(settled), "a 4-Might unit was banished by a 3-Might clause").toEqual(["enemy-0"]);
  });

  it("asks WHICH when several are in range, and takes only the answer", () => {
    const state = board({ spells: 1, units: 0 }, [1, 3, 9]);
    const asked = resolveHeldTriggers(accept(state, activationsOf(state)[0]!));

    const pending = pendingDecision(asked);
    expect(pending, "no question was asked with two legal victims").toBeDefined();
    // The 9-Might unit is not an option — the ceiling is part of the candidate
    // walk, not a check after the choice.
    expect(optionsFor(asked, pending!).map((o) => o.id).sort(), "the wrong victims were offered").toEqual([
      "enemy-0",
      "enemy-1",
    ]);

    const answered = accept(asked, {
      type: "AnswerDecision",
      playerIndex: pending!.playerIndex,
      decisionId: pending!.id,
      optionId: "enemy-1",
    });
    expect(enemiesLeft(answered), "the wrong unit was banished").toEqual(["enemy-0", "enemy-2"]);
  });

  it("fires however she was Empowered, not only off her own ability", () => {
    // `becameEmpowered` is raised by `empowerPermanent`, the single WRITER of the
    // status — so Sanction, a Legend hook, or anything else that empowers her
    // reaches this clause. Asserted by empowering her through the funnel directly,
    // with her own ability never used.
    const state = board({ spells: 0, units: 0 }, [2]);
    expect(activationsOf(state), "the fixture could pay her own cost — this proves nothing").toEqual([]);

    const settled = resolveHeldTriggers(empowerPermanent(state, "subject"));
    expect(isEmpowered(settled, "subject"), "the funnel did not Empower her").toBe(true);
    expect(enemiesLeft(settled), "an Empower from elsewhere did not fire her clause").toEqual([]);
  });

  it("does not fire a SECOND time — 441.1.a makes the status binary", () => {
    // ONE victim in range and one out of it. Two in range would park a QUESTION
    // rather than act — `advanceDecisions` only auto-resolves a single-option
    // decision — and the test would then be measuring an unanswered prompt. The
    // 9-Might survivor is what leaves something for a second firing to take.
    const state = board({ spells: 0, units: 0 }, [1, 9]);
    const once = resolveHeldTriggers(empowerPermanent(state, "subject"));
    expect(enemiesLeft(once), "the first Empower did not banish the one in range").toEqual(["enemy-1"]);

    const twice = resolveHeldTriggers(empowerPermanent(once, "subject"));
    expect(enemiesLeft(twice), "re-empowering an Empowered unit fired the clause again").toEqual(enemiesLeft(once));
  });

  it("fires for HER only — another permanent becoming Empowered does nothing", () => {
    // "When **I** become [Empowered]" is by INSTANCE. The event carries whichever
    // permanent crossed, and every permanent in the pool that can hold the status
    // raises it — so without the identity check Mel would banish something every
    // time anybody's unit was empowered anywhere.
    const state = board({ spells: 0, units: 0 }, [2]);
    state.players[0]!.baseUnits = [
      ...state.players[0]!.baseUnits,
      makeUnit({ instanceId: "somebody-else", might: 3 }),
    ];

    const settled = resolveHeldTriggers(empowerPermanent(state, "somebody-else"));
    expect(isEmpowered(settled, "somebody-else"), "the other unit was not Empowered").toBe(true);
    expect(isEmpowered(settled, "subject"), "Mel was Empowered by someone else's ability").toBe(false);
    expect(enemiesLeft(settled), "Mel fired for another unit's Empower").toEqual(["enemy-0"]);
  });

  it("never names a FRIENDLY unit, however small", () => {
    // "An ENEMY unit" is printed. A friendly 1-Might body is the cheapest possible
    // thing to banish and must never be offered — the negative that an
    // owner-blind candidate walk would fail.
    const state = board({ spells: 0, units: 0 }, [2]);
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p1: [makeUnit({ instanceId: "mine", might: 1 })],
    };

    const settled = resolveHeldTriggers(empowerPermanent(state, "subject"));
    expect(
      settled.battlefields[0]!.units.p1?.map((u) => u.instanceId),
      "a friendly unit was banished",
    ).toEqual(["mine"]);
    expect(enemiesLeft(settled), "the enemy was not the one taken").toEqual([]);
  });

  it("ignores a forged answer that names a unit it never offered", () => {
    // A client is not obliged to answer with something from the list, and "banish
    // whatever id you are given" is a spell that removes any unit on the board.
    //
    // **What REFUSES it is `validate-answer-decision`, not the card**, and that
    // was measured: a mutant making the resolver trust its id survives this test,
    // because the shared validator has already rejected any `optionId` outside
    // `optionsFor` before a resolver runs. The card's own re-derivation is
    // recorded at its site as redundant-and-kept. This test is still the right
    // one to have — it asserts the OUTCOME a player can observe, whichever layer
    // delivers it.
    const state = board({ spells: 0, units: 0 }, [1, 3, 9]);
    const asked = resolveHeldTriggers(empowerPermanent(state, "subject"));
    const pending = pendingDecision(asked);
    expect(pending, "no question was asked").toBeDefined();

    const { state: after } = submit(asked, {
      type: "AnswerDecision",
      playerIndex: pending!.playerIndex,
      decisionId: pending!.id,
      optionId: "enemy-2",
    } as never);
    expect(enemiesLeft(after), "a 9-Might unit was banished by a forged answer").toContain("enemy-2");
  });

  it("opens no response window when nothing is in range", () => {
    // `applies` refuses rather than holding a trigger that will resolve to
    // nothing — the exact reason that predicate exists. A held trigger closes the
    // chain and costs both players a PassFocus.
    const state = board({ spells: 0, units: 0 }, [9]);
    const empowered = empowerPermanent(state, "subject");

    expect(empowered.pendingTriggers, "a trigger was held with no legal victim").toHaveLength(0);
    expect(isEmpowered(empowered, "subject"), "she was not Empowered").toBe(true);
  });
});
