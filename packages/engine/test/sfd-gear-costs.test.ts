import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { answerDecision, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, resolveHeldTriggers } from "./fixtures.js";

/**
 * The pool's first additional costs paid with a GEAR — Zaun Punk's kill and
 * Legion Quartermaster's return-to-hand.
 *
 * They ride `additionalCostPermanentInstanceId` rather than the unit field,
 * because a gear must never reach a reader expecting a unit. The interesting
 * assertions here are the ENUMERATOR ones: a cost the enumerator offers on the
 * wrong field, or a mandatory cost it offers a decline for, is how a card gets
 * played without paying — and neither shows up as an error.
 */

const registry = defaultCardRegistry();

const ZAUN_PUNK = "SFD-160";
const LEGION_QUARTERMASTER = "SFD-044";
const LONG_SWORD = "SFD-022";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const unit = (defId: string): UnitInstance => createCardInstance(registry.get(defId)) as UnitInstance;
const runes = (n: number, domain: RuneCard["domain"]): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

/** `card` in hand, `ownGear` gears of the caster's, plenty of runes. */
function board(defId: string, domain: RuneCard["domain"], ownGear: number): { state: GameState; card: UnitInstance } {
  const card = unit(defId);
  const state = makeState({ phase: "Action", turnState: "Neutral" });
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = runes(8, domain);
  state.players[0]!.activeGear = Array.from({ length: ownGear }, () => gear(LONG_SWORD));
  return { state, card };
}

const playsOf = (state: GameState, card: UnitInstance) =>
  legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);

describe("Zaun Punk (SFD-160): OPTIONAL — kill a friendly gear, then kill a gear", () => {
  it("offers a decline variant plus one per friendly gear", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 2);
    const offered = playsOf(state, card).map(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId,
    );

    // "You MAY kill" — the decline is what makes may mean may.
    expect(offered, "no decline variant was offered").toContain(undefined);
    expect(offered.filter((id) => id !== undefined), "not one variant per gear").toHaveLength(2);
  });

  it("is playable with no gear at all, paying nothing", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 0);

    expect(playsOf(state, card).length, "an optional cost made him unplayable").toBeGreaterThan(0);
  });

  /** THREE gears, so that after the cost there are still two to choose between
   *  and the question is a real one. With only one left `advanceDecisions`
   *  auto-resolves it — correct, and asserted separately below. */
  it("kills the gear it was paid with, and then asks which to kill next", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 3);
    const paid = playsOf(state, card).find(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId !== undefined,
    )!;

    const after = resolveHeldTriggers(executePlayCard(state, paid as never));

    // One gear went to the COST; the payoff question is about the rest.
    expect(pendingDecision(after)?.kind, "the payoff was not asked").toBe("SFD-160-kill");
    expect(after.players[0]!.activeGear, "the cost gear was not killed").toHaveLength(2);
  });

  /** With exactly one gear left the payoff has one option, which
   *  `advanceDecisions` resolves without asking — so the assertion is on the
   *  BOARD, not on the prompt. A prompt-shaped test here would read as "the
   *  payoff never fired", which is the opposite of what happens. */
  it("kills the last remaining gear without asking when there is no choice", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 2);
    const paid = playsOf(state, card).find(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId !== undefined,
    )!;

    const after = resolveHeldTriggers(executePlayCard(state, paid as never));

    expect(pendingDecision(after), "a one-option question was still asked").toBeUndefined();
    // One to the cost, one to the payoff.
    expect(after.players[0]!.activeGear, "the payoff did not fire").toHaveLength(0);
  });

  /** "Kill A GEAR", unqualified — the payoff reaches EITHER side, which is the
   *  trade the card is built on. */
  it("offers the opponent's gear in the payoff", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 1);
    const enemyGear = gear(LONG_SWORD);
    state.players[1]!.activeGear = [enemyGear];
    const paid = playsOf(state, card).find(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId !== undefined,
    )!;

    // The cost eats the caster's only gear, so the enemy's is the payoff's one
    // remaining option and resolves without asking. That it is reachable AT ALL
    // is the point: "kill a gear" is unqualified.
    const after = resolveHeldTriggers(executePlayCard(state, paid as never));

    expect(after.players[1]!.activeGear, "the enemy gear was not killable").toHaveLength(0);
    expect(after.players[0]!.activeGear, "the caster kept the gear it paid with").toHaveLength(0);
  });

  /** "If you do" — declining the cost gives no payoff. */
  it("asks nothing when the cost is declined", () => {
    const { state, card } = board(ZAUN_PUNK, "Order", 2);
    const declined = playsOf(state, card).find(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId === undefined,
    )!;

    const after = resolveHeldTriggers(executePlayCard(state, declined as never));

    expect(pendingDecision(after), "declining still paid the payoff").toBeUndefined();
    expect(after.players[0]!.activeGear, "declining still killed a gear").toHaveLength(2);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(ZAUN_PUNK))).toBe(true);
  });
});

describe("Legion Quartermaster (SFD-044): MANDATORY — return a friendly gear to hand", () => {
  it("offers NO decline variant", () => {
    const { state, card } = board(LEGION_QUARTERMASTER, "Calm", 2);
    const offered = playsOf(state, card).map(
      (a) => (a as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId,
    );

    // No "you may", so there is nothing to decline — offering one would let him
    // be played for free.
    expect(offered, "a mandatory cost offered a decline").not.toContain(undefined);
    expect(offered, "not one variant per gear").toHaveLength(2);
  });

  /** A mandatory cost with nothing to pay it makes the card unplayable — the
   *  same consequence Cruel Patron's kill has. */
  it("is UNPLAYABLE with no gear of your own", () => {
    const { state, card } = board(LEGION_QUARTERMASTER, "Calm", 0);

    expect(playsOf(state, card), "he was playable without paying").toHaveLength(0);
  });

  it("returns the named gear to hand when played", () => {
    const { state, card } = board(LEGION_QUARTERMASTER, "Calm", 1);
    const play = playsOf(state, card)[0]!;
    const paidWith = (play as { additionalCostPermanentInstanceId?: string }).additionalCostPermanentInstanceId!;

    const after = resolveHeldTriggers(executePlayCard(state, play as never));

    expect(after.players[0]!.activeGear, "the gear was not returned").toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId), "it did not reach hand").toContain(paidWith);
  });

  /** The validator refuses a hand-built action that names a gear the caster does
   *  not control — the enumerator is not the only gate. */
  it("refuses a gear the caster does not control", () => {
    const { state, card } = board(LEGION_QUARTERMASTER, "Calm", 1);
    const enemyGear = gear(LONG_SWORD);
    state.players[1]!.activeGear = [enemyGear];
    const play = playsOf(state, card)[0]!;

    const result = validatePlayCard(state, {
      ...(play as PlayCardAction),
      additionalCostPermanentInstanceId: enemyGear.instanceId,
    });

    expect(result.ok, "an enemy gear paid a FRIENDLY cost").toBe(false);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(LEGION_QUARTERMASTER))).toBe(true);
  });
});
