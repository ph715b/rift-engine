import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/engine/cleanup.js";
import { ORDER_TRIGGERS, answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { GameState, TriggerChainEntry } from "../src/model/game-state.js";
import { keepTriggerOrder, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **383.3.d — "If more than one Triggered Ability is Triggered simultaneously,
 * then the player that controls the Abilities selects the order to place them on
 * the Chain."**
 *
 * Reported from playtesting: *"triggers that happen at the same time should be
 * able to be stacked in whichever way the user wants. as an example if you have
 * two triggers that happen on conquer. You should be able to decide which one
 * happens first."*
 *
 * The engine placed them in listener-walk order and never asked. This file is the
 * one place that answers the question the OTHER way on purpose — everywhere else
 * `fixtures.keepTriggerOrder` takes the identity permutation so ~30 older files
 * keep asserting exactly what they always did.
 *
 * # What was already right, and is not touched
 *
 * **383.3.d.1's between-player order.** `finalizePendingTriggers`' own comment
 * records that the pen fills in turn order and the chain resolves LIFO (340.1),
 * which together give "starting with the Turn Player and proceeding in Turn
 * Order, each player orders their Triggered Abilities on the Chain" — the
 * NON-turn player's triggers resolve first. Only the choice WITHIN one player's
 * group was missing, and only that is added.
 */

/** Two friendly units that will each hold a trigger, plus an enemy for contrast. */
function boardWithTriggers(count: number, playerIndex: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  const owner = state.players[playerIndex]!;
  owner.baseUnits = Array.from({ length: count }, (_, i) => makeUnit({ instanceId: `u${i}`, name: `Unit ${i}` }));
  return state;
}

/**
 * Puts `count` triggers in the pen, one per unit, so each has a DISTINCT source.
 *
 * Distinct sources deliberately: the engine skips the question when every item in
 * a group is the same ability of the same permanent, because every ordering of
 * those is the same ordering. That skip has its own test below.
 */
function holdOnePerUnit(state: GameState, count: number, playerIndex: 0 | 1 = 0): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    next = {
      ...next,
      pendingTriggers: [
        ...next.pendingTriggers,
        {
          kind: "trigger",
          playerIndex,
          listenerInstanceId: `u${i}`,
          listenerDefId: `TEST-${i}`,
          listenerName: `Unit ${i}`,
        } as TriggerChainEntry,
      ],
    };
  }
  return next;
}

const chainNames = (state: GameState) =>
  state.spellChain.map((e) => (isSpellChainEntry(e) ? e.card.name : e.listenerName));

/** The order they RESOLVE in — the chain is LIFO (340.1), so last placed is first
 *  out. This is the sequence the player actually experiences, and the only one
 *  worth asserting. */
const resolutionOrder = (state: GameState) => [...chainNames(state)].reverse();

describe("383.3.d: the controller orders their own simultaneous triggers", () => {
  it("ASKS when one player controls two that fired together", () => {
    const held = holdOnePerUnit(boardWithTriggers(2), 2);
    const finalized = runCleanup(held);

    const pending = pendingDecision(finalized);
    expect(pending?.kind, "no ordering question was raised").toBe(ORDER_TRIGGERS);
    expect(pending?.playerIndex, "the wrong player was asked").toBe(0);
    expect(
      optionsFor(finalized, pending!).map((o) => o.label).sort(),
      "the question did not offer both triggers",
    ).toEqual(["Unit 0", "Unit 1"]);
  });

  it("asks NOTHING for a single trigger — there is no order to choose", () => {
    const finalized = runCleanup(holdOnePerUnit(boardWithTriggers(1), 1));
    expect(pendingDecision(finalized), "a lone trigger raised an ordering question").toBeUndefined();
  });

  it("puts the CHOSEN trigger first in resolution order", () => {
    // The chain is LIFO, so "resolves first" means "placed last". The player is
    // asked the question in the direction they think in.
    const finalized = runCleanup(holdOnePerUnit(boardWithTriggers(2), 2));
    const pending = pendingDecision(finalized)!;
    const unit0 = optionsFor(finalized, pending).find((o) => o.label === "Unit 0")!;

    const answered = answerDecision(finalized, pending.id, unit0.id)!;
    expect(resolutionOrder(answered), "the chosen trigger does not resolve first").toEqual(["Unit 0", "Unit 1"]);
  });

  it("...and the OTHER answer gives the other order — the choice is real", () => {
    // The control that makes the test above mean something: without it, "Unit 0
    // resolved first" could just be the order the engine already had.
    const finalized = runCleanup(holdOnePerUnit(boardWithTriggers(2), 2));
    const pending = pendingDecision(finalized)!;
    const unit1 = optionsFor(finalized, pending).find((o) => o.label === "Unit 1")!;

    const answered = answerDecision(finalized, pending.id, unit1.id)!;
    expect(resolutionOrder(answered), "both answers produced the same order").toEqual(["Unit 1", "Unit 0"]);
  });

  it("repeats until the order is settled, and stops at the last pair", () => {
    // Three triggers is two questions: choose first, choose second, and the third
    // is whatever is left. A question with one option would be no question at all.
    let current = runCleanup(holdOnePerUnit(boardWithTriggers(3), 3));
    const picks = ["Unit 1", "Unit 2"];
    for (const want of picks) {
      const pending = pendingDecision(current);
      expect(pending?.kind, `no question before picking ${want}`).toBe(ORDER_TRIGGERS);
      const option = optionsFor(current, pending!).find((o) => o.label === want)!;
      current = answerDecision(current, pending!.id, option.id)!;
    }
    expect(pendingDecision(current), "a third question was asked for three triggers").toBeUndefined();
    expect(resolutionOrder(current), "the chosen order did not hold").toEqual(["Unit 1", "Unit 2", "Unit 0"]);
  });

  it("never asks about the SAME ability of the same permanent", () => {
    // Every ordering of one source's own copies is the same ordering — and this
    // is what keeps the question answerable at all. A mass death turns one
    // Cleanup into one ability per death PER LISTENER, and `heuristic-ai`'s own
    // note measures a real chain of 40 from two cards repeating. Asking a player
    // to order forty copies of one ability, 39 times, is not the choice 383.3.d
    // is giving them.
    const state = boardWithTriggers(1);
    let held = state;
    for (let i = 0; i < 5; i += 1) {
      held = {
        ...held,
        pendingTriggers: [
          ...held.pendingTriggers,
          {
            kind: "trigger",
            playerIndex: 0,
            listenerInstanceId: "u0",
            listenerDefId: "TEST-0",
            listenerName: "Unit 0",
          } as TriggerChainEntry,
        ],
      };
    }
    const finalized = runCleanup(held);
    expect(pendingDecision(finalized), "five copies of one ability raised a question").toBeUndefined();
    expect(finalized.spellChain, "the triggers were not finalized").toHaveLength(5);
  });

  it("leaves the OTHER player's items where they are (383.3.d.1)", () => {
    // The between-player order was already right and must survive the within-group
    // permutation: p1's single trigger is finalized after p0's pair, so under LIFO
    // it resolves FIRST, whichever way p0 orders their own two.
    let held = holdOnePerUnit(boardWithTriggers(2), 2, 0);
    held.players[1]!.baseUnits = [makeUnit({ instanceId: "e0", name: "Enemy" })];
    held = {
      ...held,
      pendingTriggers: [
        ...held.pendingTriggers,
        {
          kind: "trigger",
          playerIndex: 1,
          listenerInstanceId: "e0",
          listenerDefId: "TEST-E",
          listenerName: "Enemy",
        } as TriggerChainEntry,
      ],
    };

    const finalized = runCleanup(held);
    const pending = pendingDecision(finalized)!;
    expect(pending.playerIndex, "the turn player was not asked first").toBe(0);
    const unit1 = optionsFor(finalized, pending).find((o) => o.label === "Unit 1")!;
    const answered = answerDecision(finalized, pending.id, unit1.id)!;

    expect(resolutionOrder(answered), "the enemy's trigger moved").toEqual(["Enemy", "Unit 1", "Unit 0"]);
  });

  it("orders only THIS finalize's items, not ones already on the chain", () => {
    // A trigger finalized onto a chain that a Spell (or an earlier trigger) has
    // already closed must not drag that item into the ordering: it was placed in
    // an earlier round and its position is settled. 337.1.b — "Chain Items are
    // Finalized in the order they were appended to the Chain".
    let held = holdOnePerUnit(boardWithTriggers(2), 2);
    held = {
      ...held,
      spellChain: [
        {
          kind: "trigger",
          playerIndex: 0,
          listenerInstanceId: "earlier",
          listenerDefId: "TEST-EARLIER",
          listenerName: "Already On The Chain",
        } as TriggerChainEntry,
      ],
    };

    const finalized = runCleanup(held);
    const pending = pendingDecision(finalized)!;
    expect(
      optionsFor(finalized, pending).map((o) => o.label).sort(),
      "an item from an earlier round was offered for reordering",
    ).toEqual(["Unit 0", "Unit 1"]);

    // And it stays at the bottom whichever way the new pair is ordered — under
    // LIFO that means it still resolves LAST.
    const unit0 = optionsFor(finalized, pending).find((o) => o.label === "Unit 0")!;
    const answered = answerDecision(finalized, pending.id, unit0.id)!;
    expect(resolutionOrder(answered).at(-1), "the earlier item moved").toBe("Already On The Chain");
  });

  it("asks the TURN PLAYER first when both players must order (383.3.d.1)", () => {
    // "Starting with the Turn Player and proceeding in Turn Order, each player
    // orders their Triggered Abilities on the Chain." Both questions are raised in
    // the same Cleanup, so WHICH is asked first is the observable half of that
    // sentence — and it is only observable when both players have a group.
    let held = holdOnePerUnit(boardWithTriggers(2), 2, 0);
    held.players[1]!.baseUnits = [
      makeUnit({ instanceId: "e0", name: "Enemy 0" }),
      makeUnit({ instanceId: "e1", name: "Enemy 1" }),
    ];
    held = {
      ...held,
      pendingTriggers: [
        ...held.pendingTriggers,
        ...["e0", "e1"].map(
          (id) =>
            ({
              kind: "trigger",
              playerIndex: 1,
              listenerInstanceId: id,
              listenerDefId: `TEST-${id}`,
              listenerName: id === "e0" ? "Enemy 0" : "Enemy 1",
            }) as TriggerChainEntry,
        ),
      ],
    };

    const finalized = runCleanup(held);
    expect(finalized.pendingDecisions.map((d) => d.playerIndex), "both players were not asked, in turn order").toEqual([
      0, 1,
    ]);
    expect(finalized.activePlayerIndex, "the fixture is not on p0's turn — the assertion above means nothing").toBe(0);
  });

  it("is settled by the fixture helper without changing anything", () => {
    // `keepTriggerOrder` is what the ~30 files predating this question use. It has
    // to be the IDENTITY, or every one of them would be asserting against a board
    // the engine no longer produces.
    const finalized = runCleanup(holdOnePerUnit(boardWithTriggers(2), 2));
    const before = chainNames(finalized);
    const settled = keepTriggerOrder(finalized);

    expect(pendingDecision(settled), "the helper left the question outstanding").toBeUndefined();
    expect(chainNames(settled), "the helper reordered the chain").toEqual(before);
  });
});

/**
 * **A BATTLEFIELD's own printed ability is one of the orderable triggers**, and
 * that had never been asserted anywhere.
 *
 * `battlefield-abilities.ts`' header and the `rules-conformance.md` row for the
 * "when you hold here" seven both said the opposite in as many words: "a
 * battlefield's ability is placed LAST at every moment, which under the chain's
 * LIFO resolution (340.1) makes it resolve FIRST", recorded as an Unverified
 * simplification because "383 in fact lets a player choose the order among their
 * own simultaneous triggers, and this engine fixes it". That was true when it was
 * written and stopped being true when 383.3.d was implemented — the placement is
 * now the SEED order for a question, not the answer. Corrected 2026-08-23 by the
 * unverified-row sweep.
 *
 * The rules corroborate it with a worked example that pairs exactly these two
 * kinds of source. **438.1.a**: "A player with Green Father as their legend
 * conquers Navori Fighting Pit. **They choose to place the Green Father conquer
 * effect on the chain after the Navori Fighting Pit conquer effect.**"
 *
 * Driven through the REAL moment — `runBeginning` -> `scoreHolds` -> 469.2's
 * hold — because a hand-built pen would prove only that `askForTriggerOrder`
 * groups by `playerIndex`, and the open question was whether a battlefield entry
 * reaches it at all.
 */
describe("383.3.d covers a battlefield's own ability", () => {
  /** Grove of the God-Willow — "when you hold here, draw 1". */
  const GROVE = "OGN-280";
  /** Scorchclaw's `[Hunt]` fires on the same `battlefieldHeld` event, from a
   *  DIFFERENT source — which is what makes an order choosable at all. */
  const SCORCHCLAW = "UNL-016";

  const heldGroveWithHunter = (): GameState => {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: GROVE,
      units: { p1: [realUnitInstance(SCORCHCLAW)] },
      controllerId: "p1",
    };
    return runCleanup(runBeginning(state));
  };

  it("asks, with the battlefield among the options", () => {
    const finalized = heldGroveWithHunter();
    const pending = pendingDecision(finalized);
    expect(pending?.kind).toBe(ORDER_TRIGGERS);
    // Both sources present: a fixture that produced only one would ask nothing,
    // and this test would then be asserting against its own setup.
    expect(finalized.spellChain.filter((e) => !isSpellChainEntry(e) && e.source === "battlefield")).toHaveLength(1);
    expect(optionsFor(finalized, pending!)).toHaveLength(2);
  });

  it("and the player can put the UNIT's trigger first, overriding the seed order", () => {
    const finalized = heldGroveWithHunter();
    const pending = pendingDecision(finalized)!;
    // The seed: the battlefield is placed last, so by default it resolves first.
    expect(resolutionOrder(finalized)[0]).toBe("Battlefield 1");
    const unit = optionsFor(finalized, pending).find((o) => o.label === "Scorchclaw")!;
    const answered = answerDecision(finalized, pending.id, unit.id)!;
    expect(resolutionOrder(answered)[0], "the answer did not move the battlefield off the top").toBe("Scorchclaw");
  });
});
