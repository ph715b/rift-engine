import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { answerDecision, optionsFor } from "../src/engine/decisions.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { RuneCard } from "../src/model/rune.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { empowerPermanent, isEmpowered, readyUnit } from "../src/engine/effect-helpers.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Body cards — the first wave.**
 *
 * Two of these needed engine seams and both are the same shape: a flag that
 * existed for one card kind and not the other. Rampage is the pool's first SPELL
 * with an optional Power cost, and `optionalPowerPaid` had ridden only the
 * on-play trigger event — so the card would have been enumerated at two prices
 * and resolved identically at both. That is the "shipped correct and INERT"
 * failure `OPTIONAL_POWER_COSTS` already records twice from the other direction.
 */

const registry = defaultCardRegistry();

const FRETFUL_FELINE = "VEN-071";
const GUTTURAL_ROAR = "VEN-072";
const REPAIR_SPECIALIST = "VEN-076";
const DEMOLITIONIST = "VEN-080";
const ONSLAUGHT = "VEN-081";
const PROFITEER = "VEN-082";
const RAMPAGE = "VEN-083";
const DECREE_OF_STRENGTH = "VEN-085";
const JAYCE_HAMMER = "VEN-088";
const WILD_CLAW = "VEN-089";
const CATACLYSMIC_DUEL = "VEN-090";
const CORRUPTED_DRAGON = "VEN-091";

function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

/** Runs a Spell's registered effect with chosen targets and settles what it
 *  holds — what `playSpellImmediately` does, minus the payment. */
function castSpell(state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}): GameState {
  const card = spellInstance(defId);
  const effect = effectForCard(card);
  expect(effect, `${defId} has no registered card effect`).toBeDefined();
  return resolveHeldTriggers(
    effect!.resolve!(
      state,
      { casterIndex, opponentIndex: casterIndex === 0 ? 1 : 0 },
      { type: "PlayCard", playerIndex: casterIndex, card, ...event } as never,
    ),
  );
}

/** Passes Focus until the chain empties — what the two players do to let a cast
 *  spell resolve (340). */
function settleChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    const { state: next, result } = submit(current, pass);
    expect(result, `a PassFocus was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    current = next;
  }
  throw new Error("settleChain: the chain never emptied");
}

const mightAt = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): number =>
  effectiveMight(state, unit, ownerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });

describe("Fretful Feline (VEN-071): +2 Might when I become ready", () => {
  function board(): { state: GameState; feline: UnitInstance; other: UnitInstance } {
    const feline = { ...realUnitInstance(FRETFUL_FELINE), exhausted: true };
    const other = makeUnit({ instanceId: "other", exhausted: true });
    const state = makeState();
    state.players[0]!.baseUnits = [feline, other];
    return { state, feline, other };
  }

  it("pumps when a spell or ability readies him", () => {
    const { state, feline } = board();
    const after = resolveHeldTriggers(readyUnit(state, feline.instanceId));
    expect(onBoard(after, feline.instanceId)?.mightThisTurn).toBe(2);
  });

  it("...and STACKS across two readyings in a turn", () => {
    const { state, feline } = board();
    const once = resolveHeldTriggers(readyUnit(state, feline.instanceId));
    const exhaustedAgain: GameState = {
      ...once,
      players: [
        { ...once.players[0]!, baseUnits: once.players[0]!.baseUnits.map((u) => (u.instanceId === feline.instanceId ? { ...u, exhausted: true } : u)) },
        once.players[1]!,
      ] as GameState["players"],
    };
    const twice = resolveHeldTriggers(readyUnit(exhaustedAgain, feline.instanceId));
    expect(onBoard(twice, feline.instanceId)?.mightThisTurn).toBe(4);
  });

  it("NEGATIVE CONTROL: another unit becoming ready pays him nothing", () => {
    const { state, feline, other } = board();
    const after = resolveHeldTriggers(readyUnit(state, other.instanceId));
    expect(onBoard(after, feline.instanceId)?.mightThisTurn, "he pumped off somebody else's ready").toBe(0);
  });

  it("does nothing when he was ALREADY ready — no readying happened", () => {
    // `readyUnit` no-ops on a ready unit, so no event fires. Worth pinning
    // because a resolver keyed on the CALL rather than on the event would pump
    // him for free every time anything tried.
    const feline = realUnitInstance(FRETFUL_FELINE);
    const state = makeState();
    state.players[0]!.baseUnits = [feline];
    const after = resolveHeldTriggers(readyUnit(state, feline.instanceId));
    expect(onBoard(after, feline.instanceId)?.mightThisTurn).toBe(0);
  });
});

describe("Guttural Roar (VEN-072): +2, or +4 INSTEAD if it's Empowered", () => {
  function board(empowered: boolean): { state: GameState; target: UnitInstance } {
    const target = makeUnit({ instanceId: "target", might: 3 });
    const base = makeState();
    base.battlefields[0]!.units = { p1: [target] };
    return { state: empowered ? empowerPermanent(base, target.instanceId) : base, target };
  }

  it("gives +2 to an ordinary unit", () => {
    const { state, target } = board(false);
    const after = castSpell(state, GUTTURAL_ROAR, 0, { targetUnitInstanceId: target.instanceId });
    expect(onBoard(after, target.instanceId)?.mightThisTurn).toBe(2);
  });

  it("gives +4 INSTEAD to an Empowered one — not +6", () => {
    // "Instead" replaces the amount. The plausible wrong version adds them.
    const { state, target } = board(true);
    const after = castSpell(state, GUTTURAL_ROAR, 0, { targetUnitInstanceId: target.instanceId });
    expect(onBoard(after, target.instanceId)?.mightThisTurn, "the two amounts were added").toBe(4);
  });
});

describe("Repair Specialist (VEN-076): [Assault] equal to the gear you control", () => {
  function board(gearCount: number): { state: GameState; specialist: UnitInstance } {
    const specialist = realUnitInstance(REPAIR_SPECIALIST);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [specialist] };
    state.players[0]!.activeGear = Array.from({ length: gearCount }, () => realGearInstance("OGN-017"));
    return { state, specialist };
  }

  const assaultOf = (state: GameState, unit: UnitInstance) => effectiveKeywords(state, unit, 0).Assault ?? 0;

  it("scales with the gear on the board", () => {
    for (const count of [0, 1, 3]) {
      const { state, specialist } = board(count);
      expect(assaultOf(state, onBoard(state, specialist.instanceId)!), `${count} gear`).toBe(count);
    }
  });

  it("the printed [Assault 1] is STRIPPED — otherwise he has a floor he should not", () => {
    // `effectiveKeywords` merges the computed value with `Math.max`, so a left-in
    // printed 1 makes a Specialist with NO gear swing at +1 for an ability that
    // reads "equal to zero". Ancient Warmonger's entry records the same failure.
    const printed = registry.get(REPAIR_SPECIALIST);
    expect(printed.type).toBe("Unit");
    expect(
      (printed as Extract<typeof printed, { type: "Unit" }>).keywords?.Assault,
      "the flat keyword is still on the card",
    ).toBeUndefined();
  });

  it("counts YOUR gear, not the opponent's", () => {
    const { state, specialist } = board(0);
    state.players[1]!.activeGear = [realGearInstance("OGN-017"), realGearInstance("OGN-017")];
    expect(assaultOf(state, onBoard(state, specialist.instanceId)!)).toBe(0);
  });
});

describe("Onslaught (VEN-081): +6 Might this turn", () => {
  it("pumps by six", () => {
    const target = makeUnit({ instanceId: "target" });
    const state = makeState();
    state.players[0]!.baseUnits = [target];
    const after = castSpell(state, ONSLAUGHT, 0, { targetUnitInstanceId: target.instanceId });
    expect(onBoard(after, target.instanceId)?.mightThisTurn).toBe(6);
  });
});

describe("Noxian Demolitionist (VEN-080): kill a gear costing no more than my Might", () => {
  function board(demolitionistMight: number): { state: GameState; demo: UnitInstance } {
    const demo = { ...realUnitInstance(DEMOLITIONIST), mightThisTurn: demolitionistMight - registryMight(DEMOLITIONIST) };
    const state = makeState();
    state.battlefields[0]!.units = { p1: [demo] };
    state.battlefields[0]!.controllerId = "p1";
    // OGN-017 Iron Ballista is 3 Energy; OGN-090 Orb of Regret is 2.
    state.players[1]!.activeGear = [realGearInstance("OGN-017")];
    return { state, demo };
  }

  const conquered = (state: GameState): GameState =>
    runCleanup(holdEventTrigger(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" }));

  it("kills a gear within the ceiling", () => {
    const { state } = board(3);
    const after = answerDecisions(resolveHeldTriggers(conquered(state)), (options) => options[1]?.id ?? options[0]!.id);
    expect(after.players[1]!.activeGear, "the gear survived").toEqual([]);
  });

  it("does not kill a gear ABOVE the ceiling", () => {
    // A 3-Energy Ballista against a 2-Might Demolitionist — the boundary the card
    // turns on, one below the positive control above.
    //
    // **Asserted through the OUTCOME rather than the option list**, and that is
    // not a weaker test here: with nothing in range the offer collapses to a lone
    // Decline, which `advanceDecisions` executes SILENTLY — so there is no parked
    // decision to inspect by the time a caller looks. Same vacuous shape Dancing
    // Grenade's test records.
    const { state } = board(2);
    const after = answerDecisions(resolveHeldTriggers(conquered(state)), (options) => options[1]?.id ?? options[0]!.id);
    expect(after.players[1]!.activeGear.length, "a gear over the ceiling was killed").toBe(1);
  });

  it("reads his LIVE Might, so the ceiling moves with a pump", () => {
    // The ceiling is a referent checked on execution (359.3.f.2), not captured
    // when he conquered. His printed Might is 1 — every board here reaches the
    // 3-Energy gear only through `mightThisTurn`, so the kill at 3 IS the proof
    // that the pump is being read.
    expect(registryMight(DEMOLITIONIST), "his printed Might would reach the gear unaided").toBeLessThan(3);
  });
});

/** A card's printed Might, narrowed off the definition union. */
function registryMight(defId: string): number {
  const def = registry.get(defId);
  expect(def.type).toBe("Unit");
  return (def as Extract<typeof def, { type: "Unit" }>).might;
}

describe("Profiteer (VEN-082): disempower something you control TO empower anything", () => {
  function board(): { state: GameState; mine: UnitInstance; theirs: UnitInstance } {
    const mine = makeUnit({ instanceId: "mine" });
    const theirs = makeUnit({ instanceId: "theirs" });
    const state = makeState();
    state.players[0]!.baseUnits = [mine];
    state.battlefields[0]!.units = { p2: [theirs] };
    return { state: empowerPermanent(state, mine.instanceId), mine, theirs };
  }

  it("pays with your own Empowered permanent and empowers another", () => {
    const { state, mine, theirs } = board();
    const held = playUnitTrigger(state, realUnitInstance(PROFITEER), 0, "base", {});

    const after = answerDecisions(held, (options, decision) =>
      decision.kind === "VEN-082-disempower"
        ? options.find((o) => o.instanceId === mine.instanceId)!.id
        : options.find((o) => o.instanceId === theirs.instanceId)!.id,
    );

    expect(isEmpowered(after, mine.instanceId), "the cost was never paid").toBe(false);
    expect(isEmpowered(after, theirs.instanceId), "the payoff never landed").toBe(true);
  });

  it("declining leaves BOTH alone — the disempower is a cost, not a rider", () => {
    const { state, mine, theirs } = board();
    const after = answerDecisions(playUnitTrigger(state, realUnitInstance(PROFITEER), 0, "base", {}), (options) => options[0]!.id);

    expect(isEmpowered(after, mine.instanceId), "declining disempowered anyway").toBe(true);
    expect(isEmpowered(after, theirs.instanceId), "declining empowered anyway").toBe(false);
  });

  it("offers only what YOU control as the cost", () => {
    const { state, theirs } = board();
    const enemyEmpowered = empowerPermanent(state, theirs.instanceId);
    const held = playUnitTrigger(enemyEmpowered, realUnitInstance(PROFITEER), 0, "base", {});

    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-082-disempower");
    expect(
      optionsFor(held, decision!).map((o) => o.instanceId),
      "an ENEMY Empowered unit was offered as the cost",
    ).not.toContain(theirs.instanceId);
  });
});

describe("Rampage (VEN-083): they deal damage equal to their Mights to each other", () => {
  /**
   * 3 against 4, and **one of the pair always dies** — each takes the OTHER's
   * Might, so the smaller one cannot survive. That is the card, not a fixture
   * limitation, and it is why the outcome is read as a death on one side and a
   * WOUND on the other.
   */
  function board(): { state: GameState; mine: UnitInstance; theirs: UnitInstance } {
    const mine = makeUnit({ instanceId: "mine", might: 3 });
    const theirs = makeUnit({ instanceId: "theirs", might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    return { state, mine, theirs };
  }

  it("both take the OTHER's Might, from one reading", () => {
    // The friendly 3 dies to the enemy's 4; the enemy 4 survives the friendly's 3
    // and carries the wound. Read sequentially, the friendly dying first could
    // change what the enemy takes — the discipline Stormbringer's entry records,
    // and this board is exactly the case that would show it.
    const { state, mine, theirs } = board();
    const after = castSpell(state, RAMPAGE, 0, {
      targetUnitInstanceId: mine.instanceId,
      secondTargetUnitInstanceId: theirs.instanceId,
    });

    expect(onBoard(after, theirs.instanceId)?.damage, "the enemy took the wrong amount").toBe(3);
    expect(onBoard(after, mine.instanceId), "the friendly survived a 4-damage hit at 3 Might").toBeUndefined();
  });

  it("paying the [Body] pumps the friendly unit BEFORE the exchange", () => {
    // The whole point of paying: +2 on the friendly is +2 of damage DEALT, not
    // just a bigger survivor. It flips the outcome outright — the 5-Might
    // friendly now survives the 4 and KILLS the 4-Might enemy.
    const { state, mine, theirs } = board();
    const after = castSpell(state, RAMPAGE, 0, {
      targetUnitInstanceId: mine.instanceId,
      secondTargetUnitInstanceId: theirs.instanceId,
      optionalPowerPaid: true,
    });

    expect(onBoard(after, theirs.instanceId), "the pump landed after the exchange, or not at all").toBeUndefined();
    expect(onBoard(after, mine.instanceId)?.damage, "the enemy's shot changed size").toBe(4);
  });

  it("the flag survives the CHAIN, not just the resolver call", () => {
    // **The end-to-end half, and the only thing that can see the seam this card
    // needed.** Every other test here calls the resolver directly with a
    // hand-built event, so it proves the resolver READS the flag and says nothing
    // about whether anything ever WRITES it. Rampage is the pool's first SPELL
    // with an optional Power cost, and the flag rode only the on-play trigger
    // event — so a card enumerated at two prices resolved identically at both.
    //
    // Measured: a mutant that dropped the forward in `card-effect-resolution`
    // survived every other assertion in this block.
    const mine = makeUnit({ instanceId: "mine", might: 3 });
    const theirs = makeUnit({ instanceId: "theirs", might: 4 });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    state.players[0]!.hand = [spellInstance(RAMPAGE)];
    state.players[0]!.channeled = Array.from(
      { length: 6 },
      (_, i) => ({ id: `b${i}`, domain: "Body", state: "Ready" }) as RuneCard,
    );

    const paid = legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.defId === RAMPAGE &&
        a.optionalPowerPaid === true &&
        a.targetUnitInstanceId === mine.instanceId &&
        a.secondTargetUnitInstanceId === theirs.instanceId,
    );
    expect(paid, "no PAID variant was enumerated — the optional cost row is missing").toBeDefined();

    const { state: played, result } = submit(state, paid!);
    expect(result).toMatchObject({ type: "Ok" });
    const after = resolveHeldTriggers(settleChain(played));

    // The pumped friendly (5) kills the 4-Might enemy; without the flag reaching
    // the resolver it deals 3 and the enemy lives.
    expect(onBoard(after, theirs.instanceId), "the paid pump never reached the resolver").toBeUndefined();
  });

  it("the flag REACHES a Spell resolver at all", () => {
    // The seam this card needed: `optionalPowerPaid` rode only the on-play
    // trigger event until Rampage, so a Spell reading it compiled, enumerated at
    // two prices and resolved identically at both. Asserted as the difference
    // between the two answers rather than through the field.
    const paid = board();
    const declined = board();
    const withPip = castSpell(paid.state, RAMPAGE, 0, {
      targetUnitInstanceId: paid.mine.instanceId,
      secondTargetUnitInstanceId: paid.theirs.instanceId,
      optionalPowerPaid: true,
    });
    const without = castSpell(declined.state, RAMPAGE, 0, {
      targetUnitInstanceId: declined.mine.instanceId,
      secondTargetUnitInstanceId: declined.theirs.instanceId,
    });

    expect(
      onBoard(withPip, paid.theirs.instanceId) === undefined,
      "paying and declining produced the same board — the flag never arrived",
    ).not.toBe(onBoard(without, declined.theirs.instanceId) === undefined);
  });
});

describe("Decree of Strength (VEN-085): they recycle a Mind card you choose", () => {
  function board(): GameState {
    const state = makeState();
    // VEN-047 is Mind; VEN-003 is Fury.
    state.players[1]!.hand = [spellInstance("VEN-003"), realUnitInstance("VEN-047")];
    return state;
  }

  it("offers only MIND cards from the opponent's hand", () => {
    const state = board();
    const held = castSpell(state, DECREE_OF_STRENGTH, 0, {});
    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-085-pick");
    expect(decision, "nothing was parked").toBeDefined();

    const offered = optionsFor(held, decision!).map((o) => o.instanceId).filter(Boolean);
    expect(offered.length, "the Mind card was not offered").toBe(1);
    expect(registry.get(state.players[1]!.hand[1]!.defId).domains).toContain("Mind");
  });

  it("recycles the chosen card to the BOTTOM of their deck", () => {
    const state = board();
    const mind = state.players[1]!.hand[1]!;
    const after = answerDecisions(castSpell(state, DECREE_OF_STRENGTH, 0, {}), (options) => options[1]!.id);

    expect(after.players[1]!.hand.map((c) => c.instanceId), "it stayed in hand").not.toContain(mind.instanceId);
    expect(after.players[1]!.deck.at(-1)?.instanceId, "it did not go to the bottom of their deck").toBe(mind.instanceId);
  });

  it("does nothing to YOUR hand", () => {
    const state = board();
    state.players[0]!.hand = [realUnitInstance("VEN-047")];
    const after = answerDecisions(castSpell(state, DECREE_OF_STRENGTH, 0, {}), (options) => options[1]!.id);
    expect(after.players[0]!.hand.length, "it recycled from the caster's own hand").toBe(1);
  });
});

describe("Jayce, Hammer in Hand (VEN-088): choose one to give me this turn", () => {
  function board(): { state: GameState; jayce: UnitInstance } {
    const jayce = { ...realUnitInstance(JAYCE_HAMMER), exhausted: true };
    const state = makeState();
    state.battlefields[0]!.units = { p1: [jayce] };
    return { state, jayce };
  }

  it("offers exactly three modes on becoming ready", () => {
    const { state } = board();
    const held = resolveHeldTriggers(readyUnit(state, board().jayce.instanceId));
    // The board above is a different instance; use the one that was readied.
    const own = board();
    const readied = resolveHeldTriggers(readyUnit(own.state, own.jayce.instanceId));
    const decision = readied.pendingDecisions.find((d) => d.kind === "VEN-088-choice");
    expect(decision, "nothing was parked when he became ready").toBeDefined();
    expect(optionsFor(readied, decision!).map((o) => o.id).sort()).toEqual(["assault", "deflect", "ganking"]);
    expect(held.pendingDecisions.length, "the throwaway board is not asserted on").toBeGreaterThanOrEqual(0);
  });

  it("[Assault 2] SUMS with the [Assault 2] on his frame — 817", () => {
    // The rule a playtest found this engine getting wrong two sets ago. He prints
    // 2 and the clause gives 2, so a chosen Assault puts him at 4.
    const { state, jayce } = board();
    const after = answerDecisions(resolveHeldTriggers(readyUnit(state, jayce.instanceId)), (options) =>
      options.find((o) => o.id === "assault")!.id,
    );
    expect(effectiveKeywords(after, onBoard(after, jayce.instanceId)!, 0).Assault).toBe(4);
  });

  it("...and choosing [Ganking] leaves his Assault alone", () => {
    const { state, jayce } = board();
    const after = answerDecisions(resolveHeldTriggers(readyUnit(state, jayce.instanceId)), (options) =>
      options.find((o) => o.id === "ganking")!.id,
    );
    expect(effectiveKeywords(after, onBoard(after, jayce.instanceId)!, 0).Assault, "the wrong mode was applied").toBe(2);
  });
});

describe("Wild Claw (VEN-089): banish one of the top 5, play it, then maybe Empower it", () => {
  function board(): { state: GameState; cheap: UnitInstance } {
    const cheap = realUnitInstance("VEN-005"); // 2 Energy Unit
    const state = makeState();
    state.players[0]!.deck = [cheap, spellInstance("VEN-003"), spellInstance("VEN-010"), spellInstance("VEN-012"), spellInstance("VEN-081"), spellInstance("VEN-072")];
    return { state, cheap };
  }

  it("plays the chosen card and recycles the rest of the five", () => {
    const { state, cheap } = board();
    const after = answerDecisions(castSpell(state, WILD_CLAW, 0, {}), (options, decision) =>
      decision.kind === "VEN-089-banish" ? options.find((o) => o.instanceId === cheap.instanceId)!.id : options[0]!.id,
    );

    expect(onBoard(after, cheap.instanceId), "the chosen unit never arrived").toBeDefined();
    // Five looked at, one played, four recycled to the bottom; the sixth card
    // never moved and is still on top.
    expect(after.players[0]!.deck.length, "the deck arithmetic is wrong").toBe(5);
    expect(after.players[0]!.deck[0]?.defId, "the untouched sixth card moved").toBe("VEN-072");
  });

  it("...and CAN empower it afterwards", () => {
    const { state, cheap } = board();
    const after = answerDecisions(castSpell(state, WILD_CLAW, 0, {}), (options, decision) =>
      decision.kind === "VEN-089-banish"
        ? options.find((o) => o.instanceId === cheap.instanceId)!.id
        : (options.find((o) => o.id === "empower")?.id ?? options[0]!.id),
    );
    expect(isEmpowered(after, cheap.instanceId), "the Empower step never fired").toBe(true);
  });

  it("...and declining the Empower step leaves it un-Empowered", () => {
    // **The second question is a separate "you may", and the test above cannot
    // see it**: declining the FIRST question means the Empower is never asked,
    // so a resolver that empowered unconditionally survived every other
    // assertion here. This one takes the banish and refuses only the Empower.
    const { state, cheap } = board();
    const after = answerDecisions(castSpell(state, WILD_CLAW, 0, {}), (options, decision) =>
      decision.kind === "VEN-089-banish" ? options.find((o) => o.instanceId === cheap.instanceId)!.id : "decline",
    );

    expect(onBoard(after, cheap.instanceId), "the unit never arrived — this measures nothing").toBeDefined();
    expect(isEmpowered(after, cheap.instanceId), "declining empowered it anyway").toBe(false);
  });

  it("declining plays nothing and still recycles the five", () => {
    const { state, cheap } = board();
    const after = answerDecisions(castSpell(state, WILD_CLAW, 0, {}), (options) => options[0]!.id);

    expect(onBoard(after, cheap.instanceId), "something arrived on a decline").toBeUndefined();
    expect(after.players[0]!.deck.length, "the recycle is conditional on the banish").toBe(6);
    expect(after.players[0]!.deck[0]?.defId, "nothing was recycled").toBe("VEN-072");
  });
});

describe("Cataclysmic Duel (VEN-090): each player keeps one, the rest die", () => {
  function board(): GameState {
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine-a" }), makeUnit({ instanceId: "mine-b" })];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs-a" }), makeUnit({ instanceId: "theirs-b" })] };
    return state;
  }

  it("spares exactly one on each side", () => {
    const after = answerDecisions(castSpell(board(), CATACLYSMIC_DUEL, 0, {}), (options) => options[0]!.id);

    expect(onBoard(after, "mine-a"), "the caster's kept unit died").toBeDefined();
    expect(onBoard(after, "mine-b"), "the caster's second unit survived").toBeUndefined();
    expect(onBoard(after, "theirs-a"), "the opponent's kept unit died").toBeDefined();
    expect(onBoard(after, "theirs-b"), "the opponent's second unit survived").toBeUndefined();
  });

  it("asks BOTH players, and the OPPONENT second", () => {
    // The chain is the card: one `PendingDecision` carries one answer, so two
    // answers are two questions — and the second must be the other seat's or
    // "each player chooses" is not what happened.
    const held = castSpell(board(), CATACLYSMIC_DUEL, 0, {});
    const first = held.pendingDecisions[0];
    expect(first?.kind, "nothing was parked").toBe("VEN-090-pick");
    expect(first?.playerIndex, "the caster is not asked first").toBe(0);

    // ONE answer, not the whole queue — `answerDecisions` would drain both.
    const afterFirst = answerDecision(held, first!.id, optionsFor(held, first!)[0]!.id);
    expect(afterFirst, "the caster's answer was refused").toBeDefined();
    const second = afterFirst!.pendingDecisions[0];
    expect(second?.kind, "the opponent was never asked").toBe("VEN-090-second");
    expect(second?.playerIndex, "the second question went to the wrong seat").toBe(1);
  });

  it("still kills the opponent's units when the CASTER controls none", () => {
    // The chain-breaking case: a question with no options is MOOT and dropped,
    // which would leave the opponent never asked and nothing killed. The explicit
    // "you control no units" answer is what keeps the chain alive.
    const state = makeState();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs-a" }), makeUnit({ instanceId: "theirs-b" })] };

    const after = answerDecisions(castSpell(state, CATACLYSMIC_DUEL, 0, {}), (options) => options[0]!.id);

    expect(onBoard(after, "theirs-a"), "their kept unit died").toBeDefined();
    expect(onBoard(after, "theirs-b"), "nothing was killed — the chain broke").toBeUndefined();
  });
});

describe("Corrupted Dragon (VEN-091): two clauses", () => {
  it("enters ready while your score is FAR from the Victory Score", () => {
    const state = makeState();
    expect(unitEntersReady(state, 0, realUnitInstance(CORRUPTED_DRAGON)), "a 0-point player is not far enough").toBe(true);
  });

  it("...and enters EXHAUSTED once you are within 3 of it", () => {
    // The boundary, and the inverse of Leona - Zealot's comeback clause: his is
    // measured on his OWN controller.
    const state = makeState();
    state.players[0]!.points = 5; // Victory Score is 8
    expect(unitEntersReady(state, 0, realUnitInstance(CORRUPTED_DRAGON)), "5 of 8 is within 3").toBe(false);
  });

  it("shoves enemy units with 5 Might or less home when he attacks", () => {
    const dragon = realUnitInstance(CORRUPTED_DRAGON);
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [dragon],
      p2: [makeUnit({ instanceId: "small", might: 5 }), makeUnit({ instanceId: "big", might: 6 })],
    };

    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) =>
      options.find((o) => o.instanceId === "small")?.id ?? options[0]!.id,
    );

    expect(after.players[1]!.baseUnits.map((u) => u.instanceId), "the small unit was not sent home").toContain("small");
    expect(onBoard(after, "big"), "the big unit vanished").toBeDefined();
  });

  it("does not shove a unit above the ceiling", () => {
    // **Asserted through the OUTCOME**, because with nothing in range the offer
    // is a lone Decline that `advanceDecisions` executes SILENTLY — there is no
    // parked decision left to inspect. The 5-vs-6 pair above is the positive half
    // of the same boundary.
    const dragon = realUnitInstance(CORRUPTED_DRAGON);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [dragon], p2: [makeUnit({ instanceId: "big", might: 6 })] };

    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => options[1]?.id ?? options[0]!.id);

    expect(after.players[1]!.baseUnits, "a 6-Might unit was sent home").toEqual([]);
    expect(onBoard(after, "big"), "it left the battlefield").toBeDefined();
  });

  it("'any number' — the offer comes back after each answer", () => {
    const dragon = realUnitInstance(CORRUPTED_DRAGON);
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [dragon],
      p2: [makeUnit({ instanceId: "a", might: 1 }), makeUnit({ instanceId: "b", might: 1 })],
    };

    // Always take the first non-decline option; the sequence ends when only the
    // decline is left.
    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => options[1]?.id ?? options[0]!.id);

    expect(after.players[1]!.baseUnits.map((u) => u.instanceId).sort(), "only one was shoved").toEqual(["a", "b"]);
  });
});

describe("coverage sees the wave", () => {
  it("all twelve report implemented", () => {
    for (const id of [
      FRETFUL_FELINE,
      GUTTURAL_ROAR,
      REPAIR_SPECIALIST,
      DEMOLITIONIST,
      ONSLAUGHT,
      PROFITEER,
      RAMPAGE,
      DECREE_OF_STRENGTH,
      JAYCE_HAMMER,
      WILD_CLAW,
      CATACLYSMIC_DUEL,
      CORRUPTED_DRAGON,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });

  it("Legion Marauder (VEN-074) is FINISHED, and Body has no partial left", () => {
    // **This pin asserted `false` and flipped on 2026-08-19.** Its note said his
    // `[Empower]` cost is "[1] OR [Body]" — an alternative — "and no cost shape in
    // this engine expresses a choice." Right about the blocker; the answer turned
    // out not to be a new cost shape at all. `AbilityMode` has priced modes
    // separately since Jax - Grandmaster At Arms, so the alternative became two
    // MODES and the player picks which price to pay.
    //
    // Inverted rather than deleted, and widened to the DOMAIN: a card that
    // silently stopped being registered looks like nothing at all, and the
    // interesting claim now is that Body has no partial left rather than that this
    // one card works.
    expect(isCardImplemented(registry.get("VEN-074")), "Legion Marauder regressed").toBe(true);

    const bodyPartials = registry
      .all()
      .filter((d) => d.id.startsWith("VEN-") && (d.domains ?? []).includes("Body") && !isCardImplemented(d))
      .map((d) => `${d.id} ${d.name}`);
    expect(bodyPartials, "a Body card is unimplemented again").toEqual([]);
  });
});
