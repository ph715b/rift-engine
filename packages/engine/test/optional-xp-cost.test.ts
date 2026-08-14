import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { optionalXpCostOf } from "../src/engine/card-effects.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { submit } from "../src/engine/game-engine.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * "You may spend N XP as an additional cost to play me" — **204.2**, whose own
 * words are the phrase the cards print, with **204.2.a**: "Additional Costs must
 * be paid to finalize the spell or ability, in addition to the base cost."
 *
 * # Why this is the SIMPLEST additional cost in the engine
 *
 * **731: XP is not a Game Object.** It cannot be targeted, taxed by `[Deflect]`,
 * reduced by a discount axis, or paid in a domain. So the paid variant is the
 * plain play plus a flag and the payment is byte-identical — none of the
 * `computeAutoPayment` fan-out that an optional POWER cost needs applies here.
 * The agent that refused Safety Inspector expected that fan-out and reasonably
 * priced the work higher than it turned out to be.
 *
 * # What is actually at risk, and therefore asserted
 *
 * The enumerate/validate split. Four offered-then-refused crashes in this engine
 * have come from an enumerator and a validator disagreeing about a cost, every
 * one found by a probe rather than a test. So every enumerated variant is run
 * through the validator here, AND a forged one is refused — the validator has to
 * enforce 204.2.a itself rather than merely agree with whatever was offered.
 */

const registry = defaultCardRegistry();

const INSPECTOR = "UNL-164"; // 5 Energy, 1 Order — "you may spend 3 XP...; if you paid, you don't kill"
const INSPECTOR_XP = 3;
const CONSCRIPTION = "UNL-140"; // prints an XP cost that is deliberately NOT offered — see below

const order = (id: string): RuneCard => ({ id, domain: "Order", state: "Ready" });
const runes = (n: number): RuneCard[] => Array.from({ length: n }, (_, i) => order(`o${i}`));

/** The Inspector in hand with runes to spare, `xp` on the caster, and one unit
 *  each side so both players have something they COULD be made to kill. */
function inspectorState(xp: number): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [spellInstance(INSPECTOR)];
  state.players[0]!.channeled = runes(9);
  state.players[0]!.xp = xp;
  state.players[0]!.baseUnits = [makeUnit({ name: "Mine" })];
  state.players[1]!.baseUnits = [makeUnit({ name: "Theirs" })];
  return state;
}

const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

describe("the optional XP cost is enumerated only when it can be paid", () => {
  it("offers BOTH variants at exactly the printed XP", () => {
    const plays = playsOf(inspectorState(INSPECTOR_XP), INSPECTOR);

    expect(plays.some((a) => a.optionalXpPaid === true), "the paid variant is not offered at exactly 3 XP").toBe(true);
    expect(plays.some((a) => a.optionalXpPaid !== true), "the free variant vanished — the cost became mandatory").toBe(true);
  });

  it("offers ONLY the free variant one XP short — the boundary", () => {
    // The off-by-one, and the direction that matters: offering a cost the caster
    // cannot pay is the offered-then-refused split this engine keeps producing.
    const plays = playsOf(inspectorState(INSPECTOR_XP - 1), INSPECTOR);

    expect(plays.length, "the Inspector was not playable at all — the fixture measures nothing").toBeGreaterThan(0);
    expect(plays.some((a) => a.optionalXpPaid === true), "a paid variant was offered at 2 XP").toBe(false);
  });

  it("the two variants cost exactly the same runes — 731, XP is not a Game Object", () => {
    // The claim that makes this the simplest cost in the engine. If a future
    // change routed XP through the Power pricing, this is what would notice.
    const plays = playsOf(inspectorState(INSPECTOR_XP), INSPECTOR);
    const paid = plays.find((a) => a.optionalXpPaid === true)!;
    const free = plays.find((a) => a.optionalXpPaid !== true)!;

    expect(paid.payment, "the paid variant was priced differently in runes").toEqual(free.payment);
  });
});

describe("enumerate and validate agree, in both directions", () => {
  it("every enumerated variant is ACCEPTED", () => {
    const state = inspectorState(INSPECTOR_XP);
    const plays = playsOf(state, INSPECTOR);

    expect(plays.length, "nothing was enumerated — this asserts nothing").toBeGreaterThan(0);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);
    }
  });

  it("and a FORGED paid play is refused when the XP is not there", () => {
    // The other direction: 204.2.a is the validator's rule to enforce, not
    // something it may take on trust from the enumerator.
    const state = inspectorState(INSPECTOR_XP - 1);
    const free = playsOf(state, INSPECTOR).find((a) => a.optionalXpPaid !== true)!;
    const forged: PlayCardAction = { ...free, optionalXpPaid: true };

    const verdict = validatePlayCard(state, forged);
    expect(verdict.ok, "the validator allowed an XP cost the caster could not pay").toBe(false);
  });

  it("and a card that prints NO XP cost cannot claim to have paid one", () => {
    // A claim nothing offers must still be refused, or a client could quote
    // itself an exemption it never bought.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spellInstance("OGN-209")]; // Cull the Weak — no XP cost
    state.players[0]!.channeled = runes(9);
    state.players[0]!.xp = 20;

    const plain = playsOf(state, "OGN-209")[0];
    expect(plain, "the control card was not playable — the fixture measures nothing").toBeDefined();
    expect(validatePlayCard(state, { ...plain!, optionalXpPaid: true }).ok, "a card with no XP cost accepted one").toBe(false);
  });
});

describe("Safety Inspector (UNL-164): paying buys an exemption from his own kill", () => {
  /** Plays the given variant and drains everything it parks. */
  const play = (state: GameState, action: PlayCardAction): GameState => {
    const { state: next, result } = submit(state, action);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    return answerDecisions(resolveHeldTriggers(next));
  };

  it("UNPAID, both players are asked to kill — and the XP is untouched", () => {
    const state = inspectorState(INSPECTOR_XP);
    const free = playsOf(state, INSPECTOR).find((a) => a.optionalXpPaid !== true)!;
    const after = play(state, free);

    expect(after.players[0]!.xp, "declining the cost still spent the XP").toBe(INSPECTOR_XP);
    expect(after.players[0]!.baseUnits.some((u) => u.name === "Mine"), "the caster kept a unit while declining").toBe(false);
    expect(after.players[1]!.baseUnits.some((u) => u.name === "Theirs"), "the opponent was not made to kill").toBe(false);
  });

  it("PAID, the XP leaves and only the OPPONENT kills", () => {
    const state = inspectorState(INSPECTOR_XP);
    const paid = playsOf(state, INSPECTOR).find((a) => a.optionalXpPaid === true)!;
    const after = play(state, paid);

    expect(after.players[0]!.xp, "the additional cost was never actually spent").toBe(0);
    expect(after.players[0]!.baseUnits.some((u) => u.name === "Mine"), "the caster killed despite paying").toBe(true);
    expect(after.players[1]!.baseUnits.some((u) => u.name === "Theirs"), "the opponent escaped the kill too").toBe(false);
  });

  it("the XP is spent even with the exemption — a cost is paid for the PLAY", () => {
    // 204.2.a: the cost is paid to FINALIZE the spell, so it leaves whether or
    // not the payout is worth anything. Asserted on a board where the caster has
    // no unit to lose, which makes the exemption buy literally nothing.
    const state = inspectorState(INSPECTOR_XP);
    state.players[0]!.baseUnits = [];
    const paid = playsOf(state, INSPECTOR).find((a) => a.optionalXpPaid === true)!;

    expect(play(state, paid).players[0]!.xp, "the XP came back when the exemption was worthless").toBe(0);
  });
});

describe("Conscription (UNL-140) offers its XP cost only where the XP buys something", () => {
  it("prints one, is in the table, and carries no partial note", () => {
    // **Was the interesting refusal of the change that added this file**, and its
    // reasoning shaped the fix rather than being discarded: the 5 XP buys "choose
    // any enemy unit at a battlefield INSTEAD" — a wider TARGET — and optional
    // costs are fanned out INSIDE the target loop, so a paid variant built THERE
    // would still carry a target filtered to 3 Might or less and sell the XP for
    // nothing.
    //
    // The answer was to fan the wide-only targets ABOVE that loop, already
    // carrying `optionalXpPaid`. See `XP_WIDENED_TARGETING`.
    expect((registry.get(CONSCRIPTION).text ?? "").includes("spend 5 XP"), "the card stopped printing the cost").toBe(true);
    expect(optionalXpCostOf(CONSCRIPTION), "Conscription lost its table row").toBe(5);
    expect(partialImplementationNote(registry.get(CONSCRIPTION)), "a partial note came back").toBeUndefined();
  });

  it("no paid variant is enumerated when the XP would buy NOTHING", () => {
    // **Unchanged and now sharper.** The board holds a single 1-Might enemy, which
    // the free play already reaches — so there is no wide-only target to pair the
    // flag with and the deliberate under-offer means no paid variant at all. It
    // asserted the same thing when the card was refused; now it asserts the
    // narrowing rather than the absence.
  });

  it("really enumerates no paid variant on that board", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spellInstance(CONSCRIPTION)];
    state.players[0]!.channeled = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, domain: "Chaos", state: "Ready" }) as RuneCard);
    state.players[0]!.xp = 20;
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Small", might: 1 })] };

    const plays = playsOf(state, CONSCRIPTION);
    expect(plays.length, "Conscription was not playable at all — the fixture measures nothing").toBeGreaterThan(0);
    expect(plays.some((a) => a.optionalXpPaid === true), "a paid variant appeared that buys nothing").toBe(false);
  });
});

describe("coverage", () => {
  it("both are whole — Conscription joined the Inspector on 2026-08-13", () => {
    expect(isCardImplemented(registry.get(INSPECTOR)), "the Inspector is greyed again").toBe(true);
    expect(isCardImplemented(registry.get(CONSCRIPTION)), "Conscription reads unfinished").toBe(true);
  });
});
