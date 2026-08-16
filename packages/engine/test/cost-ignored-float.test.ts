import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { addBuff } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance } from "../src/model/card.js";
import { makeState, makeUnit } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * "If you do, ignore this spell's cost" has to zero what is SPENT, not only what
 * is owed in runes.
 *
 * # The fourth instance of one shape, all four in `execute-play-card`
 *
 * `validate-play-card` zeroes the whole effective cost when `ignoresCostWhenPaid`
 * applies and the additional cost was actually named, so the enumerated payment
 * correctly owes no runes. The executor priced from the RAW printed cost anyway
 * and took the Energy out of the float — so a caster paying from a bank spent the
 * buff AND the full printed cost, and the card's entire benefit vanished.
 *
 * Measured before the fix, on both cards in the pool that carry the flag: Call to
 * Glory (3 Energy) and Wallop (2 Energy) each spent their full printed cost out
 * of a 10-Energy bank on the PAID variant — byte-identical to declining.
 *
 * **Why nothing caught it, and why this file measures FLOAT rather than runes.**
 * The rune half was always right, because the validator prices it; every existing
 * test of these two cards therefore passes against a broken executor. The
 * executor is the last word on what a play actually costs and nothing re-checks
 * it, which is why this shape has landed here four times — see
 * `optional-cost-float.test.ts` for the sibling it was found beside, and
 * `engine/optional-additional-costs.ts` for why the enumerator is not the same
 * risk.
 */

const registry = defaultCardRegistry();

/** The two cards in the pool whose optional additional cost carries
 *  `ignoresCostWhenPaid`, with their printed Energy. */
const COST_IGNORING = [
  { defId: "OGN-207", name: "Call to Glory", printedEnergy: 3 },
  { defId: "OGN-146", name: "Wallop", printedEnergy: 2 },
] as const;

/** A caster holding the spell, with a buffed friendly unit to spend and a bank
 *  big enough that the whole cost could come out of it. */
function caster(defId: string): { state: GameState; spellId: string } {
  const spell = createCardInstance(registry.get(defId)) as SpellInstance;
  const base = makeState({ phase: "Action" });
  base.players[0]!.hand = [spell];
  base.players[0]!.floatingEnergy = 10;
  base.players[0]!.floatingPower = { Fury: 5, Body: 5, Order: 5, Calm: 5, Mind: 5, Chaos: 5 };
  base.players[0]!.baseUnits = [makeUnit({ instanceId: "ally0", might: 3 })];
  return { state: addBuff(base, "ally0"), spellId: spell.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

function floatSpent(state: GameState, action: PlayCardAction): number {
  const { state: after, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return state.players[0]!.floatingEnergy - after.players[0]!.floatingEnergy;
}

describe("a play whose cost is ignored spends nothing", () => {
  for (const { defId, name, printedEnergy } of COST_IGNORING) {
    it(`${name} pays 0 from the bank when the additional cost is paid`, () => {
      const { state, spellId } = caster(defId);
      const plays = playsOf(state, spellId);
      const paid = plays.find((p) => p.additionalCostUnitInstanceId !== undefined);
      const declined = plays.find((p) => p.additionalCostUnitInstanceId === undefined);
      expect(paid, "no cost-paying variant was offered — the assertion measures nothing").toBeDefined();
      expect(declined, "no declining variant was offered — the assertion measures nothing").toBeDefined();

      // The validator already owed no runes for the paid variant. That half was
      // always right, and asserting it is what makes the float figure below the
      // ONLY thing this test can be failing on.
      expect(paid!.payment.energyRunes.length, "no rune is owed for a cost that is ignored").toBe(0);

      expect(floatSpent(state, paid!), "the ignored cost takes nothing from the bank").toBe(0);
      // The control: declining leaves the printed cost standing, and it still
      // comes out of the float. Without this the assertion above would pass just
      // as well against an executor that had stopped charging anybody.
      expect(floatSpent(state, declined!), "declining still pays the printed cost").toBe(printedEnergy);
    });
  }
});
