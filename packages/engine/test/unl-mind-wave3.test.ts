import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { Domain } from "../src/model/domain.js";
import {
  beginCombatAt,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Unleashed wave 3, effects/mind.ts.
 *
 * **Everything drives the real path** — `legalActions` to find the action,
 * `submit` to take it, and the Cleanup/chain to resolve what it held. Four of
 * these five cards are reached through a dispatch hop that did not exist for
 * them before this change (a gear's own death, a board-wide `unitMoved`, a
 * `combatBegan` designation, a continuous Might read), and every one of those
 * hops is somewhere the effect can be dropped while the registry still reports
 * the card implemented.
 *
 * Each card has a NEGATIVE control beside its happy path, and every "nothing
 * happened" assertion is preceded by a positive one on the same board — an empty
 * candidate list makes a no-op assertion vacuously true, which is exactly how a
 * wave-2 block passed for the wrong reason.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and being
 * edited by sibling agents in this tree.
 */

const registry = defaultCardRegistry();

const GUSTWALKER = "UNL-075"; // Unit, 3 Energy 3 Might — [Hunt 2] [Level 3] +1 Might and [Ganking]
const SPRITE_FOUNTAIN = "UNL-078"; // Gear, 2 Energy 1 Power — Sprite on play, and again on death
const DIANA_LUNARI = "UNL-079"; // Unit, 3 Energy 3 Might — showdown: pay [1], Predict, reveal
const HWEI = "UNL-080"; // Unit, 5 Energy 5 Might — on move: draw 1, discard 1, then branch
const LILLIA = "UNL-082"; // Unit, 3 Energy 3 Might — on move: a Sprite at the location left

const TURN_TO_DUST = "UNL-070"; // Spell, 2 Energy — gives a gear [Temporary]
const TIME_WARP = "OGN-122"; // Spell — a real SPELL for the deck/hand tests
const PROMISING_FUTURE = "OGN-115"; // Spell — a second one
const ORB_OF_REGRET = "OGN-090"; // a real GEAR card, for Hwei's Gear branch
const WATCHFUL_SENTRY = "OGN-096"; // a real UNIT card, for Hwei's Unit branch

function accept(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the action was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Enough Ready runes of a card's own Power domain to pay for it outright. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Mind";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/** Passes Focus until the chain and the holding pen are empty, or a question is
 *  outstanding (`submit` refuses a PassFocus while one is, 320.1). */
function passUntilSettled(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = submit(current, pass).state;
  }
  throw new Error("passUntilSettled: the chain never emptied");
}

/** Answers the pending question by option id, through `submit`. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const result = submit(state, {
    type: "AnswerDecision",
    playerIndex: decision!.playerIndex,
    decisionId: decision!.id,
    optionId,
  });
  expect(result.result, `the answer "${optionId}" was refused`).toEqual({ type: "Ok" });
  return passUntilSettled(result.state);
}

const offered = (state: GameState): string[] => {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.id);
};

/** The unit as the BOARD holds it, wherever it stands. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const baseUnitsOf = (state: GameState, playerIndex: 0 | 1): UnitInstance[] => state.players[playerIndex]!.baseUnits;
const unitsAt = (state: GameState, bfId: string, playerId: string): UnitInstance[] =>
  state.battlefields.find((b) => b.id === bfId)?.units[playerId] ?? [];
const handNames = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.hand.map((c) => c.name);
const deckOf = (...defIds: string[]): CardInstance[] => defIds.map((id) => spellInstance(id));

const moveTo = (state: GameState, unit: UnitInstance, battlefieldId: string): PlayerAction | undefined =>
  legalActions(state).find(
    (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === battlefieldId && a.unitInstanceIds.includes(unit.instanceId),
  );

// ---------------------------------------------------------------------------

describe("Sprite Fountain (UNL-078): a Sprite on play, and the same Sprite again on death", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SPRITE_FOUNTAIN))).toBe(true);
  });

  function fountainState() {
    const fountain = realGearInstance(SPRITE_FOUNTAIN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [fountain];
    state.players[0]!.channeled = runesFor(SPRITE_FOUNTAIN);
    return { state, fountain };
  }

  it("plays a READY 3-Might Sprite with [Temporary] to the caster's base", () => {
    const { state, fountain } = fountainState();

    const after = passUntilSettled(accept(state, castsOf(state, fountain.instanceId)[0]));

    const sprites = baseUnitsOf(after, 0);
    expect(sprites.map((u) => u.name), "no Sprite arrived").toEqual(["Sprite"]);
    expect(sprites[0]!.might).toBe(3);
    expect(sprites[0]!.exhausted, "the card prints 'ready'").toBe(false);
    expect(sprites[0]!.keywords).toMatchObject({ Temporary: 1 });
    // The gear itself is in play, which is what the [Deathknell] below needs.
    expect(after.players[0]!.activeGear.map((g) => g.name)).toEqual(["Sprite Fountain"]);
  });

  it("gives the OPPONENT nothing", () => {
    const { state, fountain } = fountainState();

    const after = passUntilSettled(accept(state, castsOf(state, fountain.instanceId)[0]));

    expect(baseUnitsOf(after, 0), "positive control: the caster did get one").toHaveLength(1);
    expect(baseUnitsOf(after, 1)).toEqual([]);
  });

  /**
   * The `[Deathknell]`, driven through the only route that reaches it today: Turn
   * to Dust grants the gear `[Temporary]`, and `runBeginning` kills it through
   * `killGear`, which holds the `"killed"` self-trigger.
   *
   * Both halves are real — a cast through `submit` and the real turn manager —
   * so a self-trigger that never reached the chain fails here.
   */
  it("plays a SECOND Sprite when the gear dies", () => {
    const dust = spellInstance(TURN_TO_DUST);
    const fountain = realGearInstance(SPRITE_FOUNTAIN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [fountain];
    state.players[0]!.hand = [dust];
    state.players[0]!.channeled = runesFor(TURN_TO_DUST);

    const cast = castsOf(state, dust.instanceId).find((a) => a.targetPermanentInstanceId === fountain.instanceId);
    const granted = passUntilSettled(accept(state, cast));
    expect(granted.players[0]!.activeGear[0]!.keywords, "Turn to Dust never landed").toMatchObject({ Temporary: 1 });
    expect(baseUnitsOf(granted, 0), "nothing should have been minted yet").toEqual([]);

    const beginning = resolveHeldTriggers(runBeginning({ ...granted, phase: "Beginning" }));

    expect(beginning.players[0]!.activeGear, "the Temporary gear survived its Beginning Phase").toEqual([]);
    expect(baseUnitsOf(beginning, 0).map((u) => u.name), "the [Deathknell] never fired").toEqual(["Sprite"]);
  });

  /**
   * **PIN — this asserts the WRONG answer on purpose.**
   *
   * Sprite Fountain prints `[Temporary]`, and the card loader parses it onto the
   * DEFINITION (`{Temporary: 1, Deathknell: 1}`). `createCardInstance` then builds
   * every `GearInstance` with a hardcoded `keywords: {}`, so the instance has
   * neither — and `turn-manager.killTemporaryPermanents` tests
   * `"Temporary" in g.keywords`. The Fountain therefore never dies on its own and
   * its `[Deathknell]` is reachable only through something else killing it.
   *
   * The fix is one line in model/card.ts, which the wave-3 mind pass does not
   * own. Closing it MUST fail this test, which is the point of pinning it.
   */
  it("PIN: its printed [Temporary] is dropped by createCardInstance, so it survives its own Beginning Phase", () => {
    const fountain = realGearInstance(SPRITE_FOUNTAIN);
    const def = registry.get(SPRITE_FOUNTAIN);
    // A Legend has no `keywords` at all, so the union has to be narrowed before
    // the definition can be asked — and the narrowing is a real check here, not
    // ceremony: a Gear is what this pin is about.
    expect(def.type === "Gear" ? def.keywords : undefined, "the DEFINITION does carry it").toMatchObject({
      Temporary: 1,
    });
    expect(fountain.keywords, "the INSTANCE drops it — this is the defect").toEqual({});

    const state = makeState({ phase: "Beginning" });
    state.players[0]!.activeGear = [fountain];

    const after = resolveHeldTriggers(runBeginning(state));

    expect(after.players[0]!.activeGear, "it died — the model defect is fixed, update this pin").toHaveLength(1);
    expect(baseUnitsOf(after, 0), "and no Deathknell fired").toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("Gustwalker (UNL-075): [Level 3] — +1 Might, continuously", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(GUSTWALKER))).toBe(true);
  });

  /** Gustwalker in base beside a plain 3-Might body, so "only him" is testable. */
  function gustwalkerState(xp: number) {
    const gust = realUnitInstance(GUSTWALKER);
    const bystander = makeUnit({ name: "Bystander", might: 3 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [gust, bystander];
    state.players[0]!.xp = xp;
    return { state, gust, bystander };
  }

  const mightOf = (state: GameState, unit: UnitInstance) => effectiveMight(state, unit, 0, { isCombat: false });

  it("is 3 below the threshold and 4 at it", () => {
    const below = gustwalkerState(2);
    expect(mightOf(below.state, below.gust), "he is pumped at 2 XP").toBe(3);

    const at = gustwalkerState(3);
    expect(mightOf(at.state, at.gust), "[Level 3] never fired").toBe(4);
  });

  it("turns OFF again when XP falls back below 3 — 824.1.d, not a one-shot pump", () => {
    const { state, gust } = gustwalkerState(5);
    expect(mightOf(state, gust), "positive control: he is 4 at 5 XP").toBe(4);

    const spent: GameState = { ...state, players: [{ ...state.players[0]!, xp: 1 }, state.players[1]!] };
    expect(mightOf(spent, gust)).toBe(3);
  });

  it("pumps only HIM — a modifier is asked about every unit on the board", () => {
    const { state, gust, bystander } = gustwalkerState(9);
    expect(mightOf(state, gust), "positive control").toBe(4);
    expect(mightOf(state, bystander)).toBe(3);
  });

  it("reads the OWNER's XP, not the opponent's", () => {
    const { state, gust } = gustwalkerState(0);
    const theirs: GameState = { ...state, players: [state.players[0]!, { ...state.players[1]!, xp: 99 }] };
    expect(mightOf(theirs, gust)).toBe(3);
  });

  /**
   * **PIN — this asserts the WRONG answer on purpose.**
   *
   * "[Level 3][>] I have +1 Might and [Ganking]" puts a real keyword inside a
   * condition, and the loader's parser can only see the bracket. Sivir -
   * Mercenary (SFD-143) prints the identical shape and needed a
   * `GRANTED_ONLY_KEYWORDS` row in card-loader.ts plus a `CONDITIONAL_GRANTS` row
   * in granted-keywords.ts. Gustwalker has neither, so he carries `[Ganking]` at
   * 0 XP and `validate-move-unit` lets him walk battlefield-to-battlefield from
   * the turn he lands.
   *
   * Both files are shared and were out of scope for this pass. Closing the gap
   * MUST fail this test.
   */
  it("PIN: he has [Ganking] at 0 XP — the loader parses the conditional bracket as printed", () => {
    const { state, gust } = gustwalkerState(0);
    // **Both of these asserted the WRONG answer and have been flipped.** The
    // bracket is stripped at load (`GRANTED_ONLY_KEYWORDS`) and handed back at
    // [Level 3] (`CONDITIONAL_GRANTS`) — Sivir - Mercenary's exact pairing, which
    // this pin correctly identified as the precedent.
    expect(gust.keywords, "the strip was dropped — [Ganking] is printed again").not.toHaveProperty("Ganking");
    expect(gust.keywords, "the strip took his real [Hunt 2] with it").toMatchObject({ Hunt: 2 });
    expect(hasKeyword(state, gust, 0, "Ganking"), "he can move battlefield-to-battlefield at 0 XP again").toBe(false);

    // ...and the other half of the fix, from the same board: at 3 XP he DOES get
    // it. Without this the strip alone would look correct while leaving the card
    // strictly weaker than printed.
    const levelled = { ...state, players: [{ ...state.players[0]!, xp: 3 }, state.players[1]!] } as typeof state;
    expect(hasKeyword(levelled, gust, 0, "Ganking"), "the [Level 3] re-grant never fires — he is now worse than printed").toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Diana - Lunari (UNL-079): a showdown here buys a Predict and a reveal", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(DIANA_LUNARI))).toBe(true);
  });

  /**
   * Diana defending at bf1 with an enemy body there, so `beginCombatAt` stages a
   * real Combat Showdown through the Cleanup and hands out the designations her
   * trigger reads.
   *
   * `topIsSpell` decides what the reveal turns over: the draw is the half that
   * has to be conditional.
   */
  function dianaState(energy: number, topIsSpell = true) {
    const diana = realUnitInstance(DIANA_LUNARI);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [diana], p2: [makeUnit({ name: "Raider" })] };
    state.players[0]!.floatingEnergy = energy;
    state.players[0]!.deck = topIsSpell
      ? deckOf(TIME_WARP, PROMISING_FUTURE)
      : [makeUnit({ name: "Deck Unit" }) as unknown as CardInstance, ...deckOf(PROMISING_FUTURE)];
    return { state, diana };
  }

  it("asks, and paying + declining the Predict reveals a Spell and DRAWS it", () => {
    const { state } = dianaState(1);

    const asked = beginCombatAt(state, "bf1", 1);
    expect(pendingDecision(asked)?.kind, "she never asked").toBe("UNL-079-pay");

    const predicting = answer(asked, "pay");
    expect(pendingDecision(predicting)?.kind, "the [Predict] was never raised").toBe("UNL-079-predict");

    const after = answer(predicting, "decline");
    expect(handNames(after, 0), "the revealed Spell was not drawn").toEqual(["Time Warp"]);
    expect(after.players[0]!.floatingEnergy, "the [1] was not paid").toBe(0);
  });

  it("does NOT draw when the revealed card is not a spell", () => {
    const { state } = dianaState(1, false);

    const after = answer(answer(beginCombatAt(state, "bf1", 1), "pay"), "decline");

    expect(after.players[0]!.floatingEnergy, "positive control: she still paid").toBe(0);
    expect(handNames(after, 0), "a Unit was drawn off 'if it's a spell'").toEqual([]);
    expect(after.players[0]!.deck, "and nothing left the deck").toHaveLength(2);
  });

  it("the [Predict]'s recycle changes what is revealed", () => {
    const { state } = dianaState(1);

    const predicting = answer(beginCombatAt(state, "bf1", 1), "pay");
    expect(offered(predicting), "the Predict offered no recycle").toContain("recycle");

    const after = answer(predicting, "recycle");
    // Time Warp went to the bottom, so Promising Future is what gets revealed and
    // drawn — the whole observable point of a Predict in front of a reveal.
    expect(handNames(after, 0)).toEqual(["Promising Future"]);
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["Time Warp"]);
  });

  it("declining buys nothing and spends nothing", () => {
    const { state } = dianaState(1);

    const after = answer(beginCombatAt(state, "bf1", 1), "decline");

    expect(after.players[0]!.floatingEnergy, "declining still charged").toBe(1);
    expect(handNames(after, 0)).toEqual([]);
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["Time Warp", "Promising Future"]);
  });

  it("asks NOTHING when the Energy is not there", () => {
    const rich = dianaState(1);
    expect(pendingDecision(beginCombatAt(rich.state, "bf1", 1)), "positive control: a paid board does ask").toBeDefined();

    const { state } = dianaState(0);
    expect(pendingDecision(beginCombatAt(state, "bf1", 1))).toBeUndefined();
  });

  it("does not fire for a combat at a DIFFERENT battlefield", () => {
    const { state } = dianaState(1);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Elsewhere" })], p2: [makeUnit({ name: "Their Body" })] };

    const after = beginCombatAt(state, "bf2", 1);

    expect(pendingDecision(after), "'here' reached another battlefield").toBeUndefined();
    expect(after.players[0]!.floatingEnergy).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("Hwei - Brooding Painter (UNL-080): draw 1, discard 1, then branch on what went", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(HWEI))).toBe(true);
  });

  /**
   * Hwei ready in base with a hand to discard from and a deck deep enough that
   * nothing empties.
   *
   * **The deck depth is load-bearing and was measured.** With a one-card deck the
   * Spell branch's second draw hits 431's Burn Out, which turns the trash back
   * into the deck and hands the just-discarded card straight back to hand — so
   * the discard appeared not to have happened at all. That is a correct engine
   * doing what the rules say, and a fixture that could not tell it from a broken
   * card.
   *
   * Three exhausted runes throughout, so the Gear branch's "up to 2" has a
   * ceiling to stop at AND every other branch has a negative control for it.
   */
  function hweiState(hand: CardInstance[]) {
    const hwei = realUnitInstance(HWEI);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [hwei];
    state.players[0]!.hand = hand;
    state.players[0]!.deck = deckOf(TIME_WARP, PROMISING_FUTURE, TURN_TO_DUST);
    state.players[0]!.channeled = [
      { id: "m1", domain: "Mind", state: "Exhausted" },
      { id: "m2", domain: "Mind", state: "Exhausted" },
      { id: "m3", domain: "Mind", state: "Exhausted" },
    ];
    return { state, hwei };
  }

  const runeStates = (state: GameState) => state.players[0]!.channeled.map((r) => r.state);

  it("draws FIRST, so the drawn card is itself the card discarded", () => {
    const { state, hwei } = hweiState([]);

    const moved = passUntilSettled(accept(state, moveTo(state, hwei, "bf1")));

    // An empty hand plus one draw is a one-option question, which
    // `advanceDecisions` executes — so Time Warp is drawn and immediately
    // discarded, which is only possible if the draw comes first.
    expect(moved.players[0]!.trash.map((c) => c.name), "the drawn card was not the one discarded").toEqual(["Time Warp"]);
    // It was a Spell, so the branch drew again: Promising Future.
    expect(handNames(moved, 0)).toEqual(["Promising Future"]);
  });

  it("Spell — draws a second card", () => {
    const spell = spellInstance(PROMISING_FUTURE);
    const gear = realGearInstance(ORB_OF_REGRET);
    const { state, hwei } = hweiState([spell, gear]);

    const asked = passUntilSettled(accept(state, moveTo(state, hwei, "bf1")));
    expect(pendingDecision(asked)?.kind, "he never asked which card to discard").toBe("UNL-080-discard");

    const after = answer(asked, spell.instanceId);

    // Time Warp on the way in, the Spell discarded, then Promising Future off the
    // branch — three hand movements, and the sorted list pins all three.
    expect(handNames(after, 0).sort()).toEqual(["Orb of Regret", "Promising Future", "Time Warp"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Promising Future"]);
    expect(runeStates(after), "the Gear branch fired as well").toEqual(["Exhausted", "Exhausted", "Exhausted"]);
  });

  it("Gear — readies UP TO 2 runes, and no more", () => {
    const gear = realGearInstance(ORB_OF_REGRET);
    const { state, hwei } = hweiState([gear, spellInstance(PROMISING_FUTURE)]);

    const after = answer(passUntilSettled(accept(state, moveTo(state, hwei, "bf1"))), gear.instanceId);

    expect(runeStates(after), "the Gear branch never fired, or did not stop at 2").toEqual([
      "Ready",
      "Ready",
      "Exhausted",
    ]);
    // Only the move's own draw — the Spell branch's second draw must not fire.
    expect(handNames(after, 0).sort()).toEqual(["Promising Future", "Time Warp"]);
  });

  it("Unit — gives HIM +3 Might this turn, and nobody else", () => {
    const unit = realUnitInstance(WATCHFUL_SENTRY);
    const bystander = makeUnit({ name: "Bystander" });
    const { state, hwei } = hweiState([unit as unknown as CardInstance, spellInstance(PROMISING_FUTURE)]);
    state.players[0]!.baseUnits = [hwei, bystander];

    const after = answer(passUntilSettled(accept(state, moveTo(state, hwei, "bf1"))), unit.instanceId);

    expect(unitOnBoard(after, hwei.instanceId)?.mightThisTurn, "the Unit branch never fired").toBe(3);
    expect(unitOnBoard(after, bystander.instanceId)?.mightThisTurn, "it reached somebody else").toBe(0);
    expect(runeStates(after), "the Gear branch fired as well").toEqual(["Exhausted", "Exhausted", "Exhausted"]);
    expect(handNames(after, 0).sort(), "the Spell branch fired as well").toEqual(["Promising Future", "Time Warp"]);
  });

  it("does not fire when a DIFFERENT unit moves", () => {
    const other = makeUnit({ name: "Other" });
    const { state, hwei } = hweiState([spellInstance(PROMISING_FUTURE)]);
    state.players[0]!.baseUnits = [hwei, other];

    // Positive control on the same board: HIS move does draw and ask.
    const his = passUntilSettled(accept(state, moveTo(state, hwei, "bf1")));
    expect(pendingDecision(his)?.kind, "positive control: his own move asked nothing").toBe("UNL-080-discard");

    const theirs = passUntilSettled(accept(state, moveTo(state, other, "bf1")));
    expect(pendingDecision(theirs), "'when I move' fired for somebody else").toBeUndefined();
    expect(handNames(theirs, 0), "somebody else's move drew for him").toEqual(["Promising Future"]);
    expect(theirs.players[0]!.trash).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("Lillia - Fae Fawn (UNL-082): a Sprite at the location she left", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(LILLIA))).toBe(true);
  });

  it("leaves the Sprite in BASE when she moves out of base — 828 makes a base a location", () => {
    const lillia = realUnitInstance(LILLIA);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [lillia];

    const after = passUntilSettled(accept(state, moveTo(state, lillia, "bf1")));

    expect(baseUnitsOf(after, 0).map((u) => u.name), "no Sprite was left behind").toEqual(["Sprite"]);
    expect(unitsAt(after, "bf1", "p1").map((u) => u.name), "she did not arrive").toEqual(["Lillia - Fae Fawn"]);
  });

  it("the Sprite is a 3-Might [Temporary] token that enters EXHAUSTED — she prints no 'ready'", () => {
    const lillia = realUnitInstance(LILLIA);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [lillia];

    const sprite = baseUnitsOf(passUntilSettled(accept(state, moveTo(state, lillia, "bf1"))), 0)[0];

    expect(sprite, "no token at all").toBeDefined();
    expect(sprite!.might).toBe(3);
    expect(sprite!.keywords).toMatchObject({ Temporary: 1 });
    expect(sprite!.exhausted, "hers is the one Sprite in the pool that is not printed 'ready'").toBe(true);
  });

  it("leaves it at the BATTLEFIELD she walked off, not the one she walked to", () => {
    // [Ganking] this turn, so a battlefield-to-battlefield move is legal at all —
    // the origin half is the only thing under test.
    const lillia = { ...realUnitInstance(LILLIA), keywordsThisTurn: { Ganking: 1 } };
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [lillia] };

    const after = passUntilSettled(accept(state, moveTo(state, lillia, "bf2")));

    expect(unitsAt(after, "bf1", "p1").map((u) => u.name), "the Sprite did not stay behind").toEqual(["Sprite"]);
    expect(unitsAt(after, "bf2", "p1").map((u) => u.name), "she is not where she went").toEqual(["Lillia - Fae Fawn"]);
    expect(baseUnitsOf(after, 0), "a base token appeared for a battlefield origin").toEqual([]);
  });

  it("does not fire when a DIFFERENT unit moves", () => {
    const lillia = realUnitInstance(LILLIA);
    const other = makeUnit({ name: "Other" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [lillia, other];

    const hers = passUntilSettled(accept(state, moveTo(state, lillia, "bf1")));
    expect(baseUnitsOf(hers, 0).map((u) => u.name), "positive control: her own move minted nothing").toContain("Sprite");

    const theirs = passUntilSettled(accept(state, moveTo(state, other, "bf1")));
    expect(baseUnitsOf(theirs, 0).map((u) => u.name), "'when I move' fired for somebody else").toEqual([
      "Lillia - Fae Fawn",
    ]);
  });
});

/**
 * Diana on a NON-COMBAT showdown — the half that was impossible when she landed.
 *
 * She reads "when a showdown begins here", and 344 makes that "when Control of a
 * Battlefield is Contested during a Cleanup and the turn is in a Neutral Open
 * State" — which says nothing about anyone being there to fight. A player walking
 * unopposed into a battlefield somebody else controls begins a Showdown.
 *
 * When she was written the only event was `combatBegan`, so she fired on combat
 * showdowns only and this case got nothing. `cleanup.stageShowdowns` now holds a
 * `showdownBegan` for BOTH kinds, and these are the tests that could not exist
 * before it.
 *
 * The over-trigger it also closed is asserted below: `combatBegan` fires again
 * when a reinforcement arrives, so Diana walking into an ONGOING combat used to
 * fire this — she gains a designation at that moment and no showdown began.
 */
describe("Diana - Lunari (UNL-079): a NON-COMBAT showdown is still a showdown", () => {
  const DIANA = "UNL-079";

  /** Diana alone at a battlefield the OPPONENT controls, contested by her side —
   *  nobody to fight, so `stageShowdowns` stages a Non-Combat Showdown. */
  function nonCombatBoard(energy = 1) {
    const diana = realUnitInstance(DIANA);
    const state = makeState({ phase: "Action" });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      controllerId: "p2",
      contestedByIndex: 0,
      units: { p1: [diana] },
    };
    state.players[0]!.floatingEnergy = energy;
    state.players[0]!.deck = deckOf(TIME_WARP, PROMISING_FUTURE);
    return { state, diana };
  }

  it("asks when she contests an EMPTY battlefield — no combat, still a showdown", () => {
    const { state } = nonCombatBoard();
    const settled = resolveHeldTriggers(runCleanup(state));

    // The premise first: this really is the non-combat branch, or the test proves
    // nothing about it.
    expect(settled.showdownKind, "the fixture staged a COMBAT showdown — wrong branch").toBe("NonCombat");
    expect(pendingDecision(settled)?.kind, "she got nothing from a non-combat showdown").toBe("UNL-079-pay");
  });

  it("does NOT ask when nothing is contested — the control", () => {
    // Without this, "she asked" above could just mean she asks on every Cleanup.
    const { state } = nonCombatBoard();
    state.battlefields[0] = { ...state.battlefields[0]!, contestedByIndex: null, controllerId: "p1" };
    const settled = resolveHeldTriggers(runCleanup(state));
    expect(settled.turnState, "a showdown staged anyway").not.toBe("Showdown");
    expect(pendingDecision(settled), "she asked with no showdown at all").toBeUndefined();
  });

  it("does not ask a SECOND time when the showdown is already running", () => {
    // 316.8.b.1.a promotes a Non-Combat Showdown to a Combat one at a LATER
    // Cleanup once an opponent arrives. The showdown began at the first; only a
    // combat begins at the second. Firing again there would date the showdown to
    // the wrong moment — which is exactly what listening to `combatBegan` did.
    const { state } = nonCombatBoard();
    const first = resolveHeldTriggers(runCleanup(state));
    expect(pendingDecision(first)?.kind).toBe("UNL-079-pay");

    const answered = submit(first, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: pendingDecision(first)!.id,
      optionId: "decline",
    }).state;
    expect(pendingDecision(answered), "the first question never cleared").toBeUndefined();

    // An opponent walks in: the showdown becomes a Combat one.
    const reinforced = { ...answered, battlefields: answered.battlefields.map((bf) => ({ ...bf })) };
    reinforced.battlefields[0]!.units = { ...reinforced.battlefields[0]!.units, p2: [makeUnit({ name: "Latecomer" })] };
    const promoted = resolveHeldTriggers(runCleanup(reinforced));

    expect(promoted.showdownKind, "it never promoted, so this asserts nothing").toBe("Combat");
    expect(pendingDecision(promoted), "she asked again when only a COMBAT began").toBeUndefined();
  });
});
