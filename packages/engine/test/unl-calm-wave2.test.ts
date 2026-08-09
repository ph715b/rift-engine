import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { implementingModule, isCardImplemented } from "../src/engine/coverage.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { cardMovesTarget } from "../src/engine/card-effects.js";
import { deflectSurcharge } from "../src/engine/granted-keywords.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed's SECOND Calm wave — engine/effects/calm.ts.
 *
 * Every test here drives a REAL path: `legalActions` to build the action,
 * `submit` to take it, focus passes to resolve the chain, and `answerDecisions`
 * for the questions. A resolver called directly passes whether or not the
 * dispatch hop that reaches it in a game carries the fields it needs — which is
 * how a card ships costing runes and doing nothing.
 *
 * **Every card has a NEGATIVE control**, because each effect here (a Might pump,
 * a draw, a stun, a token) is something other parts of a turn also do, and a
 * one-sided fixture cannot tell "my card fired" from "something fired". The two
 * `[Level 6]` cards get theirs from the SAME board at 5 XP and at 6, so the
 * control isolates the threshold rather than the card.
 *
 * Three cards from this wave are NOT here because they are not implemented, and
 * each has a test below saying so rather than being left silent — a refusal that
 * nothing asserts is indistinguishable from a card nobody looked at.
 */

const registry = defaultCardRegistry();

const COMBAT_EXPERIENCE = "UNL-031"; // [Reaction] +1 Might; [Level 6] +3 instead
const DOUBLE_TROUBLE = "UNL-032"; // look 3, may draw a unit, recycle the rest
const FRISKY_HUNTER = "UNL-033"; // on play: a 1-Might [Deflect] Bird token here
const SKYWARD_STRIKE = "UNL-038"; // REFUSED — see its describe block
const SOUL_SWORD = "UNL-039"; // [Equip] [Calm], and an art-only [Level 3] band
const WUJU_APPRENTICE = "UNL-040"; // [Hunt]; [Level 6] on play, draw 1
const ALLAY = "UNL-041"; // REFUSED — see its describe block
const BACK_OFF = "UNL-042"; // [Hidden][Action] stun; PARTIAL — see its block

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n: number) => Array.from({ length: n }, (_, i) => rune(`r${i}`));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties or a question is parked. A spell that
 *  asks something stops the chain dead — while a decision is pending the only
 *  legal action is an answer — so insisting the chain empties would hang. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8; guard += 1) {
    if (pendingDecision(current) !== undefined) return current;
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  return current;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Plays a unit from player 0's hand through the enumerator and `submit`, then
 *  settles the Pending Item its on-play trigger became (383). */
function playUnit(state: GameState, defId: string, destinationBattlefieldId?: string): GameState {
  const action = legalActions(state).find(
    (a) =>
      a.type === "PlayCard" &&
      a.card.defId === defId &&
      (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === destinationBattlefieldId,
  );
  expect(action, `${defId} was never enumerated as playable to ${destinationBattlefieldId ?? "base"}`).toBeDefined();
  return resolveHeldTriggers(accept(state, action!));
}

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

/** A caster holding one copy of `defId` with plenty of Calm runes. Calm pays the
 *  Energy of everything in this file and the Power of the two that print any. */
function caster(defId: string, xp = 0): { state: GameState; cardId: string } {
  const state = makeState({ phase: "Action" });
  const card = registry.get(defId).type === "Unit" ? realUnitInstance(defId) : spellInstance(defId);
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = runes(10);
  state.players[0]!.xp = xp;
  return { state, cardId: card.instanceId };
}

describe("Combat Experience (UNL-031): +1 Might, or +3 INSTEAD at [Level 6]", () => {
  /** A caster at `xp` with one enemy unit standing at bf1 to pump. Deliberately
   *  an ENEMY: the card names no owner (355.9.b), and a fixture that only ever
   *  targets your own cannot tell a missing owner clause from a friendly-only
   *  one. */
  function board(xp: number) {
    const { state, cardId } = caster(COMBAT_EXPERIENCE, xp);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", name: "Victim", might: 3 })] };
    return { state, cardId };
  }

  const mightThisTurn = (state: GameState) =>
    state.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "victim")!.mightThisTurn;

  function cast(xp: number): GameState {
    const { state, cardId } = board(xp);
    const play = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "victim");
    expect(play, "Combat Experience was never enumerated against the enemy unit").toBeDefined();
    return settle(accept(state, play!));
  }

  it("gives +1 with no XP at all", () => {
    expect(mightThisTurn(cast(0)), "the spell resolved and gave nothing").toBe(1);
  });

  it("gives +3 at 6 XP — and +3, not +4, because the text says INSTEAD", () => {
    // The off-by-one this card is most likely to produce. Written as a second
    // `giveMightThisTurn` on top of the first — the natural shape — it would read
    // as "the level clause works" and be wrong by exactly the printed amount.
    expect(mightThisTurn(cast(6))).toBe(3);
  });

  it("switches at exactly 6: 5 XP is still +1", () => {
    // The negative control for the THRESHOLD rather than for the card, and the
    // reason the two assertions share a board. 824.1.b.1 is "[N] or MORE XP", so
    // the boundary is inclusive on 6 and exclusive on 5; a `>` would pass every
    // test above and fail only here.
    expect(mightThisTurn(cast(5)), "5 XP crossed a [Level 6] band").toBe(1);
    expect(mightThisTurn(cast(6))).toBe(3);
  });

  it("reads the CASTER's XP, not the opponent's", () => {
    // 824.1.c makes the condition the controlling player's. An opponent sitting
    // on 6 XP must change nothing — and a fixture that gave both players XP
    // could not tell the two seats apart.
    const { state, cardId } = board(0);
    state.players[1]!.xp = 6;
    const play = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "victim")!;
    expect(mightThisTurn(settle(accept(state, play))), "the opponent's XP switched the level on").toBe(1);
  });

  it("its own text is registered, whatever coverage says about [Level]", () => {
    // NOT `isCardImplemented`: `[Level]` is in coverage's UNIMPLEMENTED_KEYWORDS,
    // so every card printing the bracket reports unimplemented no matter what is
    // written for it — which is the honest answer for the 13 Level cards nobody
    // has touched and the wrong one for this. Asked of the MODULE instead, which
    // is the question this file can answer.
    expect(implementingModule(COMBAT_EXPERIENCE)).toBe("card-effects");
  });
});

describe("Double Trouble (UNL-032): look at 3, you may draw a unit, recycle the rest", () => {
  /** Three cards on top in a known order, so "what is in hand" and "what is on
   *  the bottom" are both unambiguous. */
  function board() {
    const { state, cardId } = caster(DOUBLE_TROUBLE);
    state.players[0]!.deck = [
      makeUnit({ name: "TopUnit" }),
      { ...spellInstance("OGN-064"), name: "MiddleSpell" },
      makeUnit({ name: "BottomUnit" }),
      makeUnit({ name: "Fourth" }),
    ] as never;
    return { state, cardId };
  }

  /** Cast the PLAIN variant and settle to the question.
   *
   *  `[0]` was unambiguous until UNL-032's "[Repeat] [2]" was priced on
   *  2026-08-09; the enumerator then emitted two candidates and the index started
   *  picking whichever came first. A repeat-paid cast asks the look TWICE, so a
   *  single-answer helper walked into the second question with the first's
   *  answer. The repeat is exercised deliberately at the end of this block. */
  const plainPlay = (state: GameState, cardId: string) => {
    const plain = playsOf(state, cardId).find((a) => !a.repeatPaid);
    expect(plain, "no plain variant — 820.1 makes the Repeat OPTIONAL").toBeDefined();
    return plain!;
  };
  const castAndAsk = (state: GameState, cardId: string) => settle(accept(state, plainPlay(state, cardId)));

  it("offers exactly the UNITS among the top 3, plus a decline", () => {
    const { state, cardId } = board();
    const asked = castAndAsk(state, cardId);
    const decision = pendingDecision(asked);
    expect(decision, "the spell resolved without asking anything").toBeDefined();

    // "A UNIT from among them" — the Spell sitting second is never a choice, and
    // neither is the fourth card, which was never looked at.
    expect(optionsFor(asked, decision!).map((o) => o.label)).toEqual(["Decline", "TopUnit", "BottomUnit"]);
  });

  it("draws the chosen unit and recycles the other two to the bottom", () => {
    const { state, cardId } = board();
    const answered = answerDecisions(castAndAsk(state, cardId), (options) => options.find((o) => o.label === "BottomUnit")!.id);

    expect(names(answered.players[0]!.hand), "the chosen unit was not drawn").toEqual(["BottomUnit"]);
    // "Recycle the REST" — 416.1's bottom of the Main Deck, so the fourth card is
    // now on top and the two that were passed over are underneath it.
    expect(names(answered.players[0]!.deck)).toEqual(["Fourth", "TopUnit", "MiddleSpell"]);
  });

  it("recycles all three and draws NOTHING when the look is declined", () => {
    // The negative control, and it is not a no-op: "recycle the rest" is a
    // separate instruction from the reveal-and-draw, so declining still moves
    // three cards. A resolver that returned `state` on decline would pass a
    // hand-is-empty assertion and fail this.
    const { state, cardId } = board();
    const answered = answerDecisions(castAndAsk(state, cardId), (options) => options[0]!.id);

    expect(answered.players[0]!.hand, "a card was drawn from a declined look").toHaveLength(0);
    expect(names(answered.players[0]!.deck)).toEqual(["Fourth", "TopUnit", "MiddleSpell", "BottomUnit"]);
  });

  it("asks nothing at all with an empty deck", () => {
    // 422's do-as-much-as-you-can: a question with no answers must not be parked,
    // and a parked one with zero options is silently dropped — which would look
    // exactly like this test passing for the wrong reason, hence also asserting
    // the chain actually emptied.
    const { state, cardId } = caster(DOUBLE_TROUBLE);
    const after = settle(accept(state, playsOf(state, cardId)[0]!));

    expect(pendingDecision(after)).toBeUndefined();
    expect(after.spellChain, "the chain stalled instead of resolving").toHaveLength(0);
  });

  it("offers a single option, and therefore no real question, with no unit up there", () => {
    // Only the mandatory recycle is left, so `advanceDecisions` executes it
    // unprompted. Asserted through the real path rather than by reading the
    // options list, because "one option" and "no question" are the same thing
    // only if the engine really does resolve it.
    const { state, cardId } = caster(DOUBLE_TROUBLE);
    state.players[0]!.deck = [
      { ...spellInstance("OGN-064"), name: "S1" },
      { ...spellInstance("OGN-064"), name: "S2" },
    ] as never;

    const after = settle(accept(state, playsOf(state, cardId)[0]!));
    expect(pendingDecision(after), "a one-option question was put to the player").toBeUndefined();
    expect(after.players[0]!.hand, "a spell was drawn by a card that names units").toHaveLength(0);
    expect(names(after.players[0]!.deck)).toEqual(["S1", "S2"]);
  });

  /**
   * **The pin did its job and is now the positive assertion.**
   *
   * It recorded that `REPEAT_COSTS` had no row, so the printed "[Repeat] [2]" was
   * unreachable while coverage called the card finished. The row landed on
   * 2026-08-09 and this failed loudly, which is the whole point of a pin.
   *
   * The claim it made in passing — "the resolver is repeat-SAFE regardless (it
   * re-slices the top 3)" — was reasoning, not a measurement. This now measures
   * it: paying the Repeat asks the look a SECOND time, and the second look sees
   * the cards the first one left, not the same three again.
   */
  it("the [Repeat] is priced, and paying it asks the look a SECOND time", () => {
    const { state, cardId } = board();
    const repeated = playsOf(state, cardId).find((a) => a.repeatPaid);
    expect(repeated, "the [Repeat] is inert again — REPEAT_COSTS lost its row").toBeDefined();

    // Answer every question the repeat raises, taking the first named unit each
    // time. Two executions means two looks, so a resolver that re-used the first
    // slice would draw the same card twice — which the deck contents below rule
    // out, since a card once drawn is no longer in the deck to be offered.
    const answered = answerDecisions(settle(accept(state, repeated!)), (options) => (options[1] ?? options[0]!).id);
    expect(answered.players[0]!.hand.length, "the second execution never happened").toBe(2);
    expect(new Set(names(answered.players[0]!.hand)).size, "the same card was drawn twice — the slice was re-used").toBe(2);
  });
});

describe("Frisky Hunter (UNL-033): a 1-Might [Deflect] Bird token, here", () => {
  function board() {
    const { state } = caster(FRISKY_HUNTER);
    // An ally at bf1 makes the reinforce destination legal (813 presence). Not
    // part of any assertion — every count below excludes it by name.
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "ally", name: "Ally" })] };
    return state;
  }

  const birdsAt = (state: GameState, battlefieldId: string): UnitInstance[] =>
    (state.battlefields.find((b) => b.id === battlefieldId)!.units["p1"] ?? []).filter((u) => u.name === "Bird");

  it("puts the Bird at the battlefield he was played to", () => {
    const after = playUnit(board(), FRISKY_HUNTER, "bf1");
    const birds = birdsAt(after, "bf1");

    expect(birds, "no Bird was created at his battlefield").toHaveLength(1);
    expect(birds[0]!.might).toBe(1);
    expect(birds[0]!.isToken).toBe(true);
    expect(birds[0]!.tags).toEqual(["Bird"]);
  });

  it("the Bird really carries [Deflect] — an opponent pays to choose it", () => {
    // The keyword is asserted through `deflectSurcharge` rather than by reading
    // `keywords.Deflect` off the instance, because that is the function that
    // actually taxes a chooser. A token minted with the field set and nothing
    // reading it is the `[Deflect]`-shipped-inert shape, one level down.
    const after = playUnit(board(), FRISKY_HUNTER, "bf1");
    const bird = birdsAt(after, "bf1")[0]!;

    expect(deflectSurcharge(after, bird, 0, 1), "the opponent chooses it for free").toBe(1);
    // And the control: the ally standing beside it prints no [Deflect] at all, so
    // a surcharge function that answered 1 for everything would fail here.
    const ally = after.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "ally")!;
    expect(deflectSurcharge(after, ally, 0, 1)).toBe(0);
  });

  it("puts it in BASE when he is played there — 'here' is a Location, not a battlefield", () => {
    const after = playUnit(board(), FRISKY_HUNTER);

    expect(after.players[0]!.baseUnits.filter((u) => u.name === "Bird"), "no Bird at home").toHaveLength(1);
    expect(birdsAt(after, "bf1"), "the Bird went to a battlefield he was not played to").toHaveLength(0);
  });

  it("makes NO Bird for a unit without the clause — the negative control", () => {
    // Herald of Spring is the same file's other UNL on-play unit, and he makes
    // nothing. Without this, an engine that minted a token on every unit play
    // would pass everything above.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance("UNL-034")];
    state.players[0]!.channeled = runes(10);

    expect(playUnit(state, "UNL-034").players[0]!.baseUnits.filter((u) => u.name === "Bird")).toHaveLength(0);
  });

  it("is reported implemented", () => {
    // No `[Level]` on this one, so the ordinary question is askable and is the
    // one that matters: the card leaves the deck builder's greyed pool.
    expect(isCardImplemented(registry.get(FRISKY_HUNTER))).toBe(true);
  });
});

describe("Wuju Apprentice (UNL-040): [Level 6] — when you play me, draw 1", () => {
  function board(xp: number) {
    const { state } = caster(WUJU_APPRENTICE, xp);
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return state;
  }

  it("draws at 6 XP", () => {
    expect(names(playUnit(board(6), WUJU_APPRENTICE).players[0]!.hand), "the level clause never fired").toEqual(["Drawn"]);
  });

  it("draws NOTHING below the band — 5 XP is the negative control", () => {
    expect(playUnit(board(5), WUJU_APPRENTICE).players[0]!.hand, "a [Level 6] clause fired at 5 XP").toHaveLength(0);
    expect(playUnit(board(0), WUJU_APPRENTICE).players[0]!.hand).toHaveLength(0);
  });

  it("gains no XP on the play — [Hunt] is a conquer/hold, not a play", () => {
    // He prints `[Hunt]` too, registered once for the whole pool under
    // HUNT_TRIGGER_KEY. A per-card re-implementation here would be invisible on
    // the draw tests above and would show up as XP arriving from nowhere.
    expect(playUnit(board(6), WUJU_APPRENTICE).players[0]!.xp, "XP moved on a play").toBe(6);
  });

  it("draws for the player who played him, not the opponent", () => {
    const state = board(6);
    state.players[1]!.deck = [makeUnit({ name: "TheirCard" })];
    const after = playUnit(state, WUJU_APPRENTICE);

    expect(after.players[1]!.hand, "the opponent was dealt the draw").toHaveLength(0);
  });

  it("its own text is registered", () => {
    expect(implementingModule(WUJU_APPRENTICE)).toBe("unit-triggers");
  });
});

describe("Back Off (UNL-042): the stun lands; the draw is REFUSED and pinned", () => {
  function board() {
    const { state, cardId } = caster(BACK_OFF);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", name: "Victim" })] };
    state.players[0]!.deck = [makeUnit({ name: "Undrawn" })];
    return { state, cardId };
  }

  const victim = (state: GameState) => state.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "victim")!;

  function cast(state: GameState, cardId: string): GameState {
    const play = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "victim");
    expect(play, "Back Off was never enumerated against the enemy unit").toBeDefined();
    return settle(accept(state, play!));
  }

  it("stuns the unit it names", () => {
    const { state, cardId } = board();
    expect(victim(state).stunned, "the fixture arrived pre-stunned").toBe(false);
    expect(victim(cast(state, cardId)).stunned, "the spell resolved and stunned nobody").toBe(true);
  });

  it("stuns only the unit it names — the negative control", () => {
    const { state, cardId } = board();
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "bystander", name: "Bystander" })];

    const after = cast(state, cardId);
    expect(after.battlefields[0]!.units["p1"]![0]!.stunned, "a bystander was stunned too").toBe(false);
  });

  it("reaches a unit in BASE — 'a unit', not 'a unit at a battlefield' (355.9.b)", () => {
    const { state, cardId } = caster(BACK_OFF);
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "athome", name: "AtHome" })];

    const play = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "athome");
    expect(play, "base was treated as a safe parking spot").toBeDefined();
    expect(settle(accept(state, play!)).players[1]!.baseUnits[0]!.stunned).toBe(true);
  });

  it("PINNED DIVERGENCE: 'if you played this from your hand, draw 1' does not happen", () => {
    // Played from HAND, so the printed condition is satisfied and the card should
    // replace itself. It does not, and the reason is that no resolver can see it:
    // `PlayCardAction.fromHiddenBattlefieldId` is read by `execute-play-card` to
    // set the `cardPlayed` event's `fromHidden` flag, and neither
    // `SpellChainEntry` nor `ResolveEvent` carries anything equivalent — by the
    // time this resolves the card is in the trash and the hidden zone has been
    // emptied.
    //
    // Asserting the WRONG answer deliberately (CLAUDE.md's rule for a reachable
    // gap): the day the play source reaches resolution, this test fails and says
    // what to change instead of the behaviour shifting under a green suite.
    const { state, cardId } = board();
    expect(cast(state, cardId).players[0]!.hand, "the draw half now works — update this pin and the card's note").toHaveLength(0);
  });
});

describe("the three UNL Calm cards this wave REFUSED, asserted rather than left silent", () => {
  it("Skyward Strike (UNL-038) has no move-destination entry, so its first sentence cannot work", () => {
    // "Move an enemy unit." A move-target spell needs a row in
    // `card-effects.MOVE_TARGET_SPELL_DEF_IDS`, without which the enumerator
    // never fans a destination, `event.destinationBattlefieldId` is always
    // undefined, and `forceMoveToDestination` returns the state unchanged — a
    // card that costs 2 Energy and a Power and does nothing at all.
    //
    // That table is in a shared file, so this wave could not add it. The whole
    // card is refused rather than half-written: writing only the `[Level 6]`
    // stun would register the defId and report the card DONE while its printed
    // instruction was inert, which is the over-report this repo calls the worse
    // direction.
    expect(cardMovesTarget(SKYWARD_STRIKE), "the entry landed — write the card").toBe(false);
    expect(implementingModule(SKYWARD_STRIKE)).toBeUndefined();
  });

  it("Soul Sword (UNL-039) already HAS its [Equip] ability, generated from the printed cost", () => {
    // The reason nothing was written for it, and the reason nothing MUST be:
    // `equipAbilities()` generates an entry for every Gear whose `[Equip]` cost
    // parses, and `mergeRegistries` throws on a duplicate defId — so registering
    // it in `effects/calm.ts`'s new `activatedAbilities` seam would break the
    // engine at import rather than doing nothing.
    const ability = activatedAbilityFor(SOUL_SWORD);
    expect(ability, "the generated [Equip] ability is gone — Soul Sword now needs one").toBeDefined();
    // The Calm pip is the whole cost, so it is the whole assertion: a generated
    // ability priced in some other domain would attach for the wrong rune.
    expect(ability?.cost?.power).toEqual({ domain: "Calm", count: 1 });
    const def = registry.get(SOUL_SWORD);
    expect(def.type === "Gear" ? def.equipCost : undefined).toEqual({ energy: 0, domain: "Calm", count: 1 });
  });

  it("Allay (UNL-041) is unwritten: its aura needs granted-keywords.KEYWORD_AURAS", () => {
    // "While I'm at a battlefield, your other units here have [Deflect]" is
    // EXACTLY the shape `KEYWORD_AURAS` already expresses for Captain Farron and
    // Taric - Protector (`source: "unit", scope: "here", excludesSelf: true`), so
    // the mechanism exists and the registration point does not: that table is in
    // the shared `engine/granted-keywords.ts` and there is no per-domain seam for
    // it, unlike card effects, triggers, decisions and now activated abilities.
    expect(implementingModule(ALLAY)).toBeUndefined();
    expect(isCardImplemented(registry.get(ALLAY))).toBe(false);
  });
});
