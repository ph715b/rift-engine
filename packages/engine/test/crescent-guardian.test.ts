import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { optionalPowerCostOf } from "../src/engine/card-effects.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **UNL-122 Crescent Guardian — "If you've played a spell this turn, you may pay
 * [Chaos] as an additional cost to play me. If you do, I enter ready."**
 *
 * The pool's first CONDITIONAL optional additional cost, and its refusal named
 * both blockers exactly:
 *
 *  - **Nothing recorded that a player had played a spell.** A census found eight
 *    spell-named fields on `PlayerState` and not one answers it. The near miss,
 *    `maxSpellEnergySpentThisTurn`, is a MAXIMUM over single spells, so a spell
 *    that cost nothing leaves it at 0 — and 811 makes a `[Hidden]` play cost
 *    nothing, so that is not a theoretical hole. `spellsPlayedThisTurn` is the
 *    ninth field.
 *  - **`OPTIONAL_POWER_COSTS` had no condition field**, so a bare row would have
 *    offered her cost on a turn the card forbids it — STRONGER than printed.
 *    The condition now lives in the lookup itself, so the enumerator and the
 *    validator get it without either having to remember to ask.
 *
 * # What these tests are built to catch
 *
 * **The offer must not exist before a spell is played**, and that is asserted
 * through the enumerator AND through a forged action. An enumerator that merely
 * declines to offer something is not a rule — and until this card there was NO
 * refusal at all for `optionalPowerPaid` on a card with no optional cost, so a
 * hand-built action collected the payout at the plain price.
 *
 * **She must ENTER ready, not enter exhausted and then get readied.** 369.3
 * makes "I enter ready" a replacement describing how she enters, so it belongs
 * in `deploy.unitEntersReady` beside `acceleratePaid` rather than in an on-play
 * trigger. The difference is observable: a trigger would leave her exhausted
 * through the response window and would fire `unitReadied`.
 */

const registry = defaultCardRegistry();

const CRESCENT_GUARDIAN = "UNL-122";
const GUARDIAN_ENERGY = 4;
/** Any cheap Chaos spell — she only needs one to have been PLAYED. */
const CHEAP_SPELL = "UNL-009"; // Upstage Comedy, 2 Energy

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const paidVariants = (plays: PlayCardAction[]): PlayCardAction[] => plays.filter((a) => a.optionalPowerPaid === true);
const plainVariants = (plays: PlayCardAction[]): PlayCardAction[] =>
  plays.filter((a) => a.optionalPowerPaid === undefined);

/** The Guardian in hand with `spellsPlayed` already recorded this turn. */
function board(spellsPlayed: number): { state: GameState; guardian: UnitInstance } {
  const guardian = realUnitInstance(CRESCENT_GUARDIAN);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [guardian];
  state.players[0]!.spellsPlayedThisTurn = spellsPlayed;
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`c${i}`, "Chaos"));
  return { state, guardian };
}

const findUnit = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

describe("the condition — 'if you've played a spell this turn'", () => {
  it("offers NO paid variant before a spell has been played", () => {
    const { state, guardian } = board(0);
    const plays = playsOf(state, guardian.instanceId);

    expect(plainVariants(plays).length, "she became uncastable — fixture is wrong").toBeGreaterThan(0);
    expect(paidVariants(plays), "her additional cost was offered on a turn she forbids it").toEqual([]);
  });

  it("offers both variants once a spell HAS been played", () => {
    const { state, guardian } = board(1);
    const plays = playsOf(state, guardian.instanceId);

    expect(plainVariants(plays).length, "the plain play stopped being offered — 'you MAY pay'").toBeGreaterThan(0);
    expect(paidVariants(plays).length, "the additional cost was never offered").toBeGreaterThan(0);
    // Her printed cost is 4 Energy and NO Power; the additional cost is the pip.
    expect(plainVariants(plays)[0]!.payment.powerRunes, "her plain play owes a pip she does not print").toHaveLength(0);
    expect(paidVariants(plays)[0]!.payment.powerRunes, "the additional [Chaos] pip was not charged").toHaveLength(1);
  });

  it("the condition is asked of the LOOKUP, so it cannot be forgotten by a caller", () => {
    // A positive control on the mechanism rather than on the card: the same call
    // answers differently on the same board depending only on the counter.
    const { state } = board(0);
    expect(optionalPowerCostOf(state, 0, CRESCENT_GUARDIAN), "the cost was offered with no spell played").toBeUndefined();

    const withSpell = { ...state, players: [{ ...state.players[0]!, spellsPlayedThisTurn: 1 }, state.players[1]!] } as GameState;
    expect(optionalPowerCostOf(withSpell, 0, CRESCENT_GUARDIAN), "the cost never becomes available").toEqual({
      domain: "Chaos",
      count: 1,
    });
    // And an UNCONDITIONAL entry in the same table is unaffected either way.
    expect(optionalPowerCostOf(state, 0, "OGN-044"), "the condition leaked onto Clockwork Keeper").toEqual({
      domain: "Calm",
      count: 1,
    });
  });

  it("REFUSES a forged paid action on a turn with no spell played", () => {
    // The validator half. Before this card there was NO refusal for
    // `optionalPowerPaid` on a card with no optional cost at all: the pricing
    // reads `optionalPower?.count ?? 0`, so a forged flag was priced at the plain
    // cost and collected the payout for free.
    const { state, guardian } = board(0);
    const plain = plainVariants(playsOf(state, guardian.instanceId))[0]!;
    const forged: PlayCardAction = { ...plain, optionalPowerPaid: true };

    expect(validatePlayCard(state, forged).ok, "a forged additional cost was accepted").toBe(false);
  });
});

describe("the counter itself", () => {
  it("is raised by playing a real SPELL, and not by playing a unit", () => {
    // Driven through `submit` rather than by setting the field, because the whole
    // point of the field is that the play path writes it.
    const spell = spellInstance(CHEAP_SPELL);
    const guardian = realUnitInstance(CRESCENT_GUARDIAN);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spell, guardian];
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`c${i}`, "Chaos"));
    // Upstage Comedy reads "Ready a unit", so it is uncastable on an empty board
    // (355.8 needs a legal choice for every target at announce). The bystander is
    // fixture plumbing, not part of the claim.
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "bystander", exhausted: true })];

    expect(state.players[0]!.spellsPlayedThisTurn, "the fixture already counted a spell").toBe(0);

    const castSpell = playsOf(state, spell.instanceId)[0]!;
    const afterSpell = submit(state, castSpell);
    expect(afterSpell.result, `spell refused: ${JSON.stringify(afterSpell.result)}`).toMatchObject({ type: "Ok" });
    expect(afterSpell.state.players[0]!.spellsPlayedThisTurn, "playing a spell did not count").toBe(1);

    // The negative half, on the same board: a UNIT play must not count. Without
    // it the counter is indistinguishable from `cardsPlayedThisTurn`, which is
    // the field the refusal note explicitly ruled out.
    const playGuardian = plainVariants(playsOf(state, guardian.instanceId))[0]!;
    const afterUnit = submit(state, playGuardian);
    expect(afterUnit.result, `unit refused: ${JSON.stringify(afterUnit.result)}`).toMatchObject({ type: "Ok" });
    expect(afterUnit.state.players[0]!.spellsPlayedThisTurn, "playing a UNIT counted as a spell").toBe(0);
  });

  it("is cleared at end of turn", () => {
    // "THIS turn". Without the reset her cost becomes permanently offerable from
    // the first spell of the game onward.
    const { state } = board(3);
    const ended = runEnd({ ...state, phase: "Action" });
    expect(ended.players[0]!.spellsPlayedThisTurn, "the counter outlived the turn").toBe(0);
  });
});

describe("the payout — 'if you do, I enter ready'", () => {
  it("ENTERS ready when the cost was paid, and exhausted when it was not", () => {
    const { state, guardian } = board(1);
    const plays = playsOf(state, guardian.instanceId);

    const paid = submit(state, paidVariants(plays)[0]!);
    expect(paid.result, `refused: ${JSON.stringify(paid.result)}`).toMatchObject({ type: "Ok" });
    expect(findUnit(paid.state, guardian.instanceId)!.exhausted, "she did not enter ready").toBe(false);

    // The paired control on the same fixture, one flag apart — 143.4.a's default
    // is that a unit enters exhausted, so the paid case proves nothing alone.
    const declined = submit(state, plainVariants(plays)[0]!);
    expect(declined.result, `refused: ${JSON.stringify(declined.result)}`).toMatchObject({ type: "Ok" });
    expect(findUnit(declined.state, guardian.instanceId)!.exhausted, "declining readied her anyway").toBe(true);
  });

  it("does NOT ready another card that prints the same kind of optional cost", () => {
    // The clause is CARD-KEYED, unlike `acceleratePaid` beside it in
    // `unitEntersReady`. Clockwork Keeper (OGN-044) pays an optional [Calm] and
    // buys something else with it; a bare `optionalPowerPaid` term would ready
    // him too.
    const keeper = realUnitInstance("OGN-044");
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [keeper];
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`m${i}`, "Calm"));

    const paid = paidVariants(playsOf(state, keeper.instanceId))[0];
    expect(paid, "Clockwork Keeper's paid variant was not offered — this asserts nothing").toBeDefined();
    const after = submit(state, paid!);
    expect(after.result, `refused: ${JSON.stringify(after.result)}`).toMatchObject({ type: "Ok" });
    expect(findUnit(after.state, keeper.instanceId)!.exhausted, "the enter-ready leaked onto Clockwork Keeper").toBe(
      true,
    );
  });
});

describe("the enumerator and the validator agree", () => {
  it("every enumerated play of the Guardian validates", () => {
    const { state, guardian } = board(1);
    const plays = playsOf(state, guardian.instanceId);
    expect(plays.length, "nothing was enumerated, so this asserts nothing").toBeGreaterThan(1);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, `enumerated but refused: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });
});

describe("coverage", () => {
  it("reports her finished, from the source that holds her whole printed text", () => {
    const def = registry.get(CRESCENT_GUARDIAN);
    expect(isCardImplemented(def), "she still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "she carries a partial note").toBeUndefined();
    expect(implementingModules(CRESCENT_GUARDIAN), "her cost is not claimed").toContain("optional power costs");
  });
});
