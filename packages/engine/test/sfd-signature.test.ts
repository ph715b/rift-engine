import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realGearInstance, spellInstance } from "./fixtures.js";

/**
 * The Spiritforged dual-domain signature cards that could be written against
 * primitives this engine already has.
 *
 * Every case here goes through `submit` and the real `legalActions` enumeration
 * rather than calling a resolver directly: a card can be registered, priced,
 * targetable and still never reach its resolver, and that is the failure mode
 * this repo has actually shipped. The assertions are on BOARD STATE after the
 * chain has settled.
 *
 * # What is still absent, and why — each is a missing primitive, not a gap in effort
 *
 *  - **Counter Strike (SFD-194)** "the next time that unit would be dealt damage
 *    this turn, prevent it" needs a per-unit, single-use prevention marker.
 *    `GameState` has the exact opposite (`markedForDeathOnDamageInstanceIds`) and
 *    nothing symmetric; the consume point is inside `dealDamage`.
 *  - **Hostile Takeover (SFD-202)** "lose control of that unit and recall it at
 *    end of turn". Control in this engine IS which player's list a unit sits in
 *    (`takeControlOfUnit`'s own comment says a temporary one "would need a real
 *    controller field and a way back"), so nothing on the state can say which unit
 *    to hand back when the `endOfTurn` event arrives. Writing only the steal would
 *    turn a one-turn loan into a permanent theft — strictly worse than leaving it.
 *  - **Spinning Axe (SFD-186), Forgefire Cape (SFD-190), Rabadon's Deathcrown
 *    (SFD-191)** print no rules text beyond keywords. Their `[Equip]` cost is a
 *    RAINBOW rune, which `ActivationCost.power` (one `Domain`) cannot express —
 *    see `equipAbilities()`, which names all four exclusions. Nothing about them
 *    belongs in this file.
 */

const registry = defaultCardRegistry();

const VOID_RUSH = "SFD-188"; // Fury+Order — reveal 2, banish one and play it 2 Energy cheaper, draw the rest
const SHURELYAS_REQUIEM = "SFD-192"; // Calm+Mind Gear — "when you play this, ready your units"
const DEFIANT_DANCE = "SFD-196"; // Calm+Chaos — +2 [M] to one unit, -2 [M] to another
const ARCANE_SHIFT = "SFD-200"; // Mind+Chaos — blink a friendly, deal 3, banish this
const ON_THE_HUNT = "SFD-204"; // Body+Chaos — ready your units

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/**
 * Passes the chain down and answers nothing — stops the moment a question is
 * outstanding, so a test that cares WHICH answer is given keeps control of it.
 * `submit` refuses a PassFocus while a decision is pending (323.2.a), so this
 * would otherwise spin.
 */
function settleChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    if (pendingDecision(current)) return current;
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

/** Casts a specific enumerated variant and settles the chain. */
function castAndSettle(state: GameState, play: PlayCardAction | undefined, label: string): GameState {
  expect(play, `${label} was not castable`).toBeDefined();
  return settleChain(accept(state, play!));
}

const runes = (count: number, domain: RuneCard["domain"]) =>
  Array.from({ length: count }, (_, i) => rune(`${domain}-${i}`, domain));

describe("Defiant Dance (SFD-196): +2 to one unit, -2 to another", () => {
  function danceState(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", might: 4 })],
      p2: [makeUnit({ instanceId: "theirs", might: 4 })],
    };
    state.players[0]!.hand = [spellInstance(DEFIANT_DANCE)];
    state.players[0]!.channeled = runes(6, "Calm");
    return state;
  }

  const findAll = (state: GameState) => playsFor(state, DEFIANT_DANCE);

  it("pumps the first target and debuffs the second", () => {
    const state = danceState();
    const play = findAll(state).find(
      (a) => a.targetUnitInstanceId === "mine" && a.secondTargetUnitInstanceId === "theirs",
    );
    const settled = castAndSettle(state, play, DEFIANT_DANCE);

    const mine = settled.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "mine");
    const theirs = settled.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "theirs");
    expect(mine!.mightThisTurn, "the +2 half never landed").toBe(2);
    expect(theirs!.mightThisTurn, "the -2 half never landed").toBe(-2);
  });

  it("offers BOTH orderings — the whole point of asymmetricSlots", () => {
    // Without `asymmetricSlots` the enumerator prunes (B,A) once it has offered
    // (A,B), because both slots share the role "any". That would make exactly half
    // this card unreachable: the pruned ordering is the one that pumps the OTHER
    // unit. This is the check that fails if the flag is dropped.
    const pairs = findAll(danceState()).map((a) => `${a.targetUnitInstanceId}>${a.secondTargetUnitInstanceId}`);
    expect(pairs).toContain("mine>theirs");
    expect(pairs, "only one ordering was enumerated — asymmetricSlots is off").toContain("theirs>mine");
  });

  it("debuffs BELOW 1 — no floor is printed on this card", () => {
    // Siphon Power and Smoke Screen print "to a minimum of 1 [M]" and this does
    // not, so a 2-Might unit is taken to 0 rather than clamped.
    const state = danceState();
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "theirs", might: 2 })];
    const play = playsFor(state, DEFIANT_DANCE).find(
      (a) => a.targetUnitInstanceId === "mine" && a.secondTargetUnitInstanceId === "theirs",
    );
    const settled = castAndSettle(state, play, DEFIANT_DANCE);

    const theirs = settled.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "theirs");
    expect(theirs!.mightThisTurn).toBe(-2);
  });

  it("is uncastable with only one unit on the board — both targets are mandatory", () => {
    // 355.8: valid choices must be made for all targets before the spell goes on
    // the chain, and nothing here says "up to".
    const state = danceState();
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", might: 4 })] };
    expect(playsFor(state, DEFIANT_DANCE)).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(DEFIANT_DANCE))).toBe(true);
  });
});

describe("On the Hunt (SFD-204): ready your units", () => {
  function huntState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", exhausted: true })];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "front", exhausted: true }), makeUnit({ instanceId: "awake", exhausted: false })],
      p2: [makeUnit({ instanceId: "enemy", exhausted: true })],
    };
    state.players[0]!.hand = [spellInstance(ON_THE_HUNT)];
    state.players[0]!.channeled = runes(8, "Body");
    return state;
  }

  it("readies friendly units in BASE and at battlefields, and nothing of the opponent's", () => {
    // ONE state, enumerated and submitted against — calling the fixture twice
    // names a card instance that is not in the hand it is submitted to, which the
    // engine refuses by instanceId.
    const state = huntState();
    const settled = castAndSettle(state, playsFor(state, ON_THE_HUNT)[0], ON_THE_HUNT);

    expect(settled.players[0]!.baseUnits[0]!.exhausted, "the base unit stayed exhausted").toBe(false);
    const front = settled.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "front");
    expect(front!.exhausted, "the battlefield unit stayed exhausted").toBe(false);
    const enemy = settled.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "enemy");
    expect(enemy!.exhausted, "an ENEMY unit was readied — 'your units' is not 'all units'").toBe(true);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ON_THE_HUNT))).toBe(true);
  });
});

describe("Shurelya's Requiem (SFD-192): a GEAR whose on-play clause readies your units", () => {
  /** An exhausted board on both sides, and the Requiem in hand with Calm runes to
   *  pay its 4 Energy / 2 Power. Its pip is a Calm|Mind split capsule
   *  (`POWER_DOMAIN_ALT_OVERRIDES`), so a Calm-only pool is a legal payment. */
  function requiemState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "home", exhausted: true })];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "front", exhausted: true }), makeUnit({ instanceId: "awake", exhausted: false })],
      p2: [makeUnit({ instanceId: "enemy", exhausted: true })],
    };
    state.players[0]!.hand = [realGearInstance(SHURELYAS_REQUIEM)];
    state.players[0]!.channeled = runes(12, "Calm");
    return state;
  }

  it("readies friendly units in BASE and at battlefields, and nothing of the opponent's", () => {
    // The measurement that matters: this is a SELF-trigger on a GEAR, a dispatch
    // hop that only `execute-play-card`'s Gear branch reaches. Calling the
    // resolver directly would pass whether or not the card is ever wired to it,
    // so the whole path is exercised — enumerate, submit, settle the chain.
    const state = requiemState();
    const settled = castAndSettle(state, playsFor(state, SHURELYAS_REQUIEM)[0], SHURELYAS_REQUIEM);

    expect(settled.players[0]!.activeGear.map((g) => g.defId), "the gear never entered play").toContain(SHURELYAS_REQUIEM);
    expect(settled.players[0]!.baseUnits[0]!.exhausted, "the base unit stayed exhausted").toBe(false);
    const front = settled.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "front");
    expect(front!.exhausted, "the battlefield unit stayed exhausted").toBe(false);
    const enemy = settled.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "enemy");
    expect(enemy!.exhausted, "an ENEMY unit was readied — 'your units' is not 'all units'").toBe(true);
  });

  it("HOLDS the clause on the chain rather than resolving it inline", () => {
    // 383 / 809.1.b.3: a self-trigger is a Chain Pending Item, finalized by the
    // Cleanup and resolved by a pass. So the board immediately after the play is
    // still asleep, and that is the respondable window. A version that readied
    // inside `executePlayCard` would pass the test above and fail this one.
    const state = requiemState();
    const played = accept(state, playsFor(state, SHURELYAS_REQUIEM)[0]);

    expect(played.spellChain.length, "nothing was put on the chain").toBeGreaterThan(0);
    expect(played.players[0]!.baseUnits[0]!.exhausted, "the ready happened inline, before anyone could respond").toBe(true);
  });

  it("is still reported as PARTIAL — the [Equip] half is a rainbow cost and is unwired", () => {
    // Registration is per defId, so writing one clause of a two-clause card makes
    // it read as finished unless something says otherwise. `PARTIALLY_IMPLEMENTED`
    // already carries this defId for the rainbow `[Equip]` cost, and this asserts
    // that note is still the thing standing between "one clause" and "done".
    expect(isCardImplemented(registry.get(SHURELYAS_REQUIEM))).toBe(false);
    expect(partialImplementationNote(registry.get(SHURELYAS_REQUIEM))).toContain("RAINBOW");
  });
});

describe("Arcane Shift (SFD-200): blink a friendly, deal 3, banish this", () => {
  /** A damaged, buffed, exhausted friendly at bf1 and a 5-Might enemy beside it. */
  function shiftState(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "shifted", might: 4, damage: 3, buffed: true, mightThisTurn: 2, exhausted: true })],
      p2: [makeUnit({ instanceId: "victim", might: 5 })],
    };
    state.players[0]!.hand = [spellInstance(ARCANE_SHIFT)];
    state.players[0]!.channeled = runes(8, "Mind");
    return state;
  }

  const shiftPlay = (state: GameState) =>
    playsFor(state, ARCANE_SHIFT).find(
      (a) => a.targetUnitInstanceId === "shifted" && a.secondTargetUnitInstanceId === "victim",
    );

  it("takes the unit off the board and puts a FRESH copy back into play", () => {
    // The blink is the card: 709 strips the Buff on leaving play, and damage and
    // this-turn Might are properties of the body that left. A relocation would have
    // kept all three and looked identical on the board.
    const state = shiftState();
    const settled = castAndSettle(state, shiftPlay(state), ARCANE_SHIFT);

    expect(settled.battlefields[0]!.units["p1"] ?? [], "the unit is still at the battlefield").toHaveLength(0);
    const back = settled.players[0]!.baseUnits.find((u) => u.instanceId === "shifted");
    expect(back, "the blinked unit never came back").toBeDefined();
    expect(back!.damage).toBe(0);
    expect(back!.buffed).toBe(false);
    expect(back!.mightThisTurn).toBe(0);
  });

  it("deals 3 to the enemy unit", () => {
    const state = shiftState();
    const settled = castAndSettle(state, shiftPlay(state), ARCANE_SHIFT);
    const victim = settled.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "victim");
    expect(victim!.damage, "the damage half never fired").toBe(3);
  });

  it("BANISHES itself rather than leaving the spell in the trash", () => {
    const state = shiftState();
    const settled = castAndSettle(state, shiftPlay(state), ARCANE_SHIFT);
    expect(settled.players[0]!.banished.map((c) => c.defId)).toEqual([ARCANE_SHIFT]);
    expect(settled.players[0]!.trash.some((c) => c.defId === ARCANE_SHIFT), "it is in BOTH zones").toBe(false);
  });

  it("does NOT leave the blinked unit in the banished zone — that banish is transient", () => {
    const state = shiftState();
    const settled = castAndSettle(state, shiftPlay(state), ARCANE_SHIFT);
    expect(settled.players[0]!.banished.some((c) => c.instanceId === "shifted")).toBe(false);
  });

  it("can put the unit back at a BATTLEFIELD — the word Portal Rescue does not print", () => {
    // Portal Rescue says "plays it TO THEIR BASE"; this says only "plays it". With
    // another friendly unit holding bf1, the free play has two destinations and
    // asks — which is exactly the line that would be lost if this were read as a
    // base-only blink.
    const state = shiftState();
    state.battlefields[0]!.units["p1"] = [
      ...state.battlefields[0]!.units["p1"]!,
      makeUnit({ instanceId: "anchor", might: 2 }),
    ];
    const cast = castAndSettle(state, shiftPlay(state), ARCANE_SHIFT);

    const question = pendingDecision(cast);
    expect(question, "no placement question was asked — the blink went straight to base").toBeDefined();
    const bf1 = optionsFor(cast, question!).find((o) => o.id === "bf1");
    expect(bf1, "the battlefield was not on offer").toBeDefined();

    const settled = answerDecisions(cast, () => "bf1");
    expect(
      settled.battlefields[0]!.units["p1"]!.map((u) => u.instanceId),
      "the blinked unit did not land at the battlefield",
    ).toContain("shifted");
  });

  it("is uncastable with no enemy unit at a battlefield — both halves are mandatory", () => {
    const state = shiftState();
    state.battlefields[0]!.units["p2"] = [];
    expect(playsFor(state, ARCANE_SHIFT)).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ARCANE_SHIFT))).toBe(true);
  });
});

describe("Void Rush (SFD-188): reveal 2, banish one and play it 2 Energy cheaper", () => {
  /** The top of the deck: a 3-Energy unit that is affordable at the discount, and
   *  a 40-Energy one that is not affordable at any. */
  function rushState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = [
      makeUnit({ instanceId: "prize", might: 4, energyCost: 3, powerCost: 0, powerDomain: null }),
      makeUnit({ instanceId: "brick", might: 9, energyCost: 40, powerCost: 0, powerDomain: null }),
      makeUnit({ instanceId: "deeper", might: 1 }),
    ];
    state.players[0]!.hand = [spellInstance(VOID_RUSH)];
    state.players[0]!.channeled = runes(10, "Fury");
    state.players[0]!.floatingEnergy = 6;
    return state;
  }

  const askedState = (state: GameState) => castAndSettle(state, playsFor(state, VOID_RUSH)[0], VOID_RUSH);

  it("asks about the top 2 and offers only the one it can pay for", () => {
    const asked = askedState(rushState());
    const question = pendingDecision(asked);
    expect(question, "Void Rush never parked its question").toBeDefined();

    const options = optionsFor(asked, question!);
    expect(options.map((o) => o.instanceId)).toContain("prize");
    expect(options.map((o) => o.instanceId), "a 40-Energy card was offered as affordable").not.toContain("brick");
  });

  it("prices the option at the DISCOUNTED cost, and charges exactly that", () => {
    // The measurement of the discount itself. A 3-Energy card is offered at 1 and
    // takes exactly 1 Energy out of the pool; without the reduction both numbers
    // would be 3.
    const asked = askedState(rushState());
    const question = pendingDecision(asked)!;
    const prize = optionsFor(asked, question).find((o) => o.instanceId === "prize");
    expect(prize!.label, "the option is not priced at the reduced cost").toContain("pay 1 Energy");

    const before = asked.players[0]!.floatingEnergy;
    const settled = answerDecisions(asked, () => prize!.id);
    expect(before, "no floating Energy left to measure the charge against").toBeGreaterThanOrEqual(1);
    expect(settled.players[0]!.floatingEnergy, "the reduced cost was not charged").toBe(before - 1);
  });

  it("plays the banished card and draws the other one", () => {
    const asked = askedState(rushState());
    const question = pendingDecision(asked)!;
    const prize = optionsFor(asked, question).find((o) => o.instanceId === "prize")!;
    const settled = answerDecisions(asked, () => prize.id);

    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId), "the banished card was never played").toContain("prize");
    expect(settled.players[0]!.hand.map((c) => c.instanceId), "the un-banished card was not drawn").toContain("brick");
    // Both revealed cards left the deck; the third is now on top.
    expect(settled.players[0]!.deck.map((c) => c.instanceId)).toEqual(["deeper"]);
    // A transient banish: banished and played in one instruction, so the zone stays
    // empty. (Arcane Shift's "banish this" is the other kind.)
    expect(settled.players[0]!.banished).toHaveLength(0);
    expect(settled.players[0]!.cardsPlayedThisTurn, "the free play was invisible to [Legion]").toBeGreaterThanOrEqual(2);
  });

  it("declining draws BOTH and plays nothing", () => {
    const asked = askedState(rushState());
    const settled = answerDecisions(asked, () => "decline");

    expect(settled.players[0]!.hand.map((c) => c.instanceId).sort()).toEqual(["brick", "prize"]);
    expect(settled.players[0]!.baseUnits, "something was played after declining").toHaveLength(0);
    expect(settled.players[0]!.deck.map((c) => c.instanceId)).toEqual(["deeper"]);
  });

  it("floors the discount at 0 rather than refunding Energy", () => {
    // A 1-Energy card minus 2 is 0, not -1. It still enters play, and the pool is
    // untouched.
    const state = rushState();
    state.players[0]!.deck = [
      makeUnit({ instanceId: "cheap", might: 1, energyCost: 1, powerCost: 0, powerDomain: null }),
      makeUnit({ instanceId: "brick", might: 9, energyCost: 40, powerCost: 0, powerDomain: null }),
    ];
    const asked = askedState(state);
    const question = pendingDecision(asked)!;
    const cheap = optionsFor(asked, question).find((o) => o.instanceId === "cheap")!;
    expect(cheap.label).toContain("pay 0 Energy");

    const before = asked.players[0]!.floatingEnergy;
    const settled = answerDecisions(asked, () => cheap.id);
    expect(settled.players[0]!.floatingEnergy).toBe(before);
    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId)).toContain("cheap");
  });

  it("retires the question without a prompt when nothing is affordable, and draws both", () => {
    // One option is not a choice: `advanceDecisions` executes the lone decline
    // itself, so an unaffordable pair never stops the game.
    const state = rushState();
    state.players[0]!.deck = [
      makeUnit({ instanceId: "brickA", energyCost: 40, powerCost: 0, powerDomain: null }),
      makeUnit({ instanceId: "brickB", energyCost: 40, powerCost: 0, powerDomain: null }),
    ];
    const settled = askedState(state);

    expect(pendingDecision(settled), "an unanswerable question was left standing").toBeUndefined();
    expect(settled.players[0]!.hand.map((c) => c.instanceId).sort()).toEqual(["brickA", "brickB"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VOID_RUSH))).toBe(true);
  });
});
