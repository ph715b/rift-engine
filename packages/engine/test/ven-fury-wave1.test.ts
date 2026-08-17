import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { burn, burnCards, forceMoveToBattlefield } from "../src/engine/effect-helpers.js";
import { dispatchEvent } from "../src/engine/triggers.js";
import { optionsFor } from "../src/engine/decisions.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { dispatchOnPlayUnit, unitTriggerForCard } from "../src/engine/unit-triggers.js";
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
 * **Vendetta's Fury cards — the first wave.**
 *
 * Fourteen cards across five mechanisms (a card effect, an on-play trigger, two
 * Beginning-Phase triggers, three attack triggers, two move triggers, a
 * conditional enter-ready) plus rule 440's Burn, which arrives with them.
 *
 * Every card here is driven through the machinery that runs it in a real game
 * rather than by calling its resolver: an attack trigger goes through
 * `beginCombatAt`, which stages a real Showdown and hands out the designations
 * `applies` reads, and a move trigger goes through a real `MoveUnit`. The
 * `unitBuffed` conversion already sprang the trap of hand-building an event and
 * pushing it at a resolver — it bypasses `applies` entirely and asserts nothing.
 *
 * Each card that has a boundary is tested AT it, in both directions. Four of
 * these cards turn on a rune count and the plausible wrong version of each is an
 * off-by-one that no board set up lopsided could ever see.
 */

const registry = defaultCardRegistry();

const BRITTLE_STEEL = "VEN-003";
const RUTHLESS_STRIKE = "VEN-008";
const CONSUMING_CURSE = "VEN-010";
const PERFECT_EXECUTION = "VEN-012";
const FORSAKEN_BACCAI = "VEN-005";
const OASIS_RAIDER = "VEN-006";
const BACCAI_REAPER = "VEN-009";
const RENEKTON = "VEN-019";
const TWILIGHT_REVELER = "VEN-020";
const ECLIPSE_DRAGON = "VEN-016";
const MORGANA = "VEN-017";
const BLADE_TWIRLER = "VEN-002";
const SHADOW_ASSASSIN = "VEN-013";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });
const runes = (count: number, prefix = "f"): RuneCard[] =>
  Array.from({ length: count }, (_, i) => fury(`${prefix}${i}`));

/** The unit as the BOARD holds it, wherever it stands — the only honest way to
 *  read a unit after a resolver may have moved, damaged or replaced it. */
function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Everything HELD or already on the chain, by the defId of whatever placed it.
 *
 * The instrument that separates "the ability resolved to nothing" from "the
 * ability was never placed", which is the difference an `applies` filter makes
 * and the difference a resolver guard alone cannot show. Read before
 * `resolveHeldTriggers` drains the pen.
 */
const heldDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : e.card.defId)),
];

/** Runs a Spell's registered effect the way `playSpellImmediately` does — with a
 *  chosen target — and settles anything it holds. */
function castSpell(
  state: GameState,
  defId: string,
  casterIndex: 0 | 1,
  event: Record<string, unknown> = {},
): GameState {
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

/** The Beginning Phase's inline dispatch, which is how the two rune-comparison
 *  units fire. Inline is deliberate (see trigger-census.test.ts), so there is no
 *  chain to settle. */
const beginningPhaseFor = (state: GameState, playerIndex: 0 | 1): GameState =>
  dispatchEvent(state, { kind: "beginningPhase", playerIndex });

describe("rule 440: Burn", () => {
  it("moves the TOP card of the Main Deck to the trash, in order", () => {
    const state = makeState();
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL), spellInstance(CONSUMING_CURSE), spellInstance(RUTHLESS_STRIKE)];

    const after = burn(state, 0, 2);

    expect(after.players[0]!.deck.map((c) => c.defId), "it took from the wrong end").toEqual([RUTHLESS_STRIKE]);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([BRITTLE_STEEL, CONSUMING_CURSE]);
  });

  it("burns the OTHER player's deck when told to — the chooser is not the burner", () => {
    // Blade Twirler's whole question is which seat burns, so a helper that could
    // only reach `playerIndex` 0 would make that question unanswerable.
    const state = makeState();
    state.players[1]!.deck = [spellInstance(BRITTLE_STEEL)];

    const after = burn(state, 1, 1);

    expect(after.players[1]!.trash.map((c) => c.defId)).toEqual([BRITTLE_STEEL]);
    expect(after.players[0]!.trash, "it burned the wrong seat").toEqual([]);
  });

  it("440.4: burns what it has, BURNS OUT, then burns the rest", () => {
    // The sentence that makes this more than a three-line loop. A Burn 3 against
    // a 1-card deck burns 1, recycles the trash into the deck (431) handing the
    // opponent a point, and burns 2 more.
    const state = makeState();
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL)];
    state.players[0]!.trash = [spellInstance(CONSUMING_CURSE), spellInstance(RUTHLESS_STRIKE)];

    const after = burn(state, 0, 3);

    expect(after.players[1]!.points, "no Burn Out ran — 440.4 stops short").toBe(1);
    // 1 burned, then the 3-card trash became the deck and 2 more were burned off
    // the front of it. One card is left in the deck.
    expect(after.players[0]!.deck.length).toBe(1);
    expect(after.players[0]!.trash.length).toBe(2);
  });

  it("stops rather than looping when deck AND trash are empty", () => {
    // The finiteness guard `drawCards` has for the same reason: with nothing in
    // either zone there is no card and no way to make one, so a further Burn Out
    // could only repeat. 431.3 does describe repeated burn-outs, but that takes
    // an effect that keeps asking.
    const state = makeState();

    const after = burn(state, 0, 7);

    expect(after.players[1]!.points, "it burned out against an empty trash").toBe(0);
    expect(after.players[0]!.trash).toEqual([]);
  });

  it("reports the cards it took, which is what Forgotten Relic will read", () => {
    const state = makeState();
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL), spellInstance(CONSUMING_CURSE)];

    const { burned } = burnCards(state, 0, 2);

    expect(burned.map((c) => c.defId)).toEqual([BRITTLE_STEEL, CONSUMING_CURSE]);
  });

  it("a Burn 0 is a no-op rather than a Burn 1", () => {
    const state = makeState();
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL)];

    expect(burn(state, 0, 0).players[0]!.trash).toEqual([]);
  });
});

describe("Brittle Steel (VEN-003): kill a gear", () => {
  it("kills the chosen gear, whoever owns it", () => {
    const gear = realGearInstance("OGN-017"); // Iron Ballista
    const state = makeState();
    state.players[1]!.activeGear = [gear];

    const after = castSpell(state, BRITTLE_STEEL, 0, { targetPermanentInstanceId: gear.instanceId });

    expect(after.players[1]!.activeGear, "the gear survived").toEqual([]);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toEqual([gear.instanceId]);
  });

  it("...and a FRIENDLY gear too — no owner is printed", () => {
    // 355.9.a.1's widening. Killing your own gear is a bad play rather than an
    // illegal one, and this card offers it; a resolver that only walked the
    // opponent would silently no-op.
    const gear = realGearInstance("OGN-017");
    const state = makeState();
    state.players[0]!.activeGear = [gear];

    const after = castSpell(state, BRITTLE_STEEL, 0, { targetPermanentInstanceId: gear.instanceId });

    expect(after.players[0]!.activeGear).toEqual([]);
  });

  it("does nothing when the gear has already left — 359.3.e.12", () => {
    const state = makeState();
    const after = castSpell(state, BRITTLE_STEEL, 0, { targetPermanentInstanceId: "gone" });
    expect(after.players[0]!.trash).toEqual([]);
    expect(after.players[1]!.trash).toEqual([]);
  });
});

describe("Ruthless Strike (VEN-008): 3, or 5 if you paid", () => {
  function board(): { state: GameState; victim: UnitInstance } {
    const victim = makeUnit({ instanceId: "victim", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state.players[0]!.hand = [spellInstance(CONSUMING_CURSE)];
    return { state, victim };
  }

  it("deals 3 when the additional cost was declined", () => {
    const { state, victim } = board();
    const after = castSpell(state, RUTHLESS_STRIKE, 0, { targetUnitInstanceId: victim.instanceId });
    expect(onBoard(after, victim.instanceId)?.damage).toBe(3);
  });

  it("deals 5 INSTEAD when it was paid — not 8, and not two instances", () => {
    // "Instead" replaces the number. Dealing 3 and then 2 more would be a
    // different card: two instances trip a damage-triggered ability twice.
    const { state, victim } = board();
    const discard = state.players[0]!.hand[0]!;

    const after = castSpell(state, RUTHLESS_STRIKE, 0, {
      targetUnitInstanceId: victim.instanceId,
      discardCardInstanceId: discard.instanceId,
    });

    expect(onBoard(after, victim.instanceId)?.damage, "the two amounts were added").toBe(5);
  });

  it("...and the discard really happens", () => {
    const { state, victim } = board();
    const discard = state.players[0]!.hand[0]!;

    const after = castSpell(state, RUTHLESS_STRIKE, 0, {
      targetUnitInstanceId: victim.instanceId,
      discardCardInstanceId: discard.instanceId,
    });

    expect(after.players[0]!.hand, "the cost was never taken").toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(discard.instanceId);
  });
});

describe("Consuming Curse (VEN-010): 2, plus 1 Bonus Damage per copy in your trash", () => {
  function board(trash: string[]): { state: GameState; victim: UnitInstance } {
    const victim = makeUnit({ instanceId: "victim", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state.players[0]!.trash = trash.map((id) => spellInstance(id));
    return { state, victim };
  }

  it("deals its printed 2 against an empty trash", () => {
    const { state, victim } = board([]);
    const after = castSpell(state, CONSUMING_CURSE, 0, { targetUnitInstanceId: victim.instanceId });
    expect(onBoard(after, victim.instanceId)?.damage).toBe(2);
  });

  it("deals 3 with one copy in the trash, and 4 with two", () => {
    const one = board([CONSUMING_CURSE]);
    expect(
      onBoard(castSpell(one.state, CONSUMING_CURSE, 0, { targetUnitInstanceId: one.victim.instanceId }), one.victim.instanceId)
        ?.damage,
    ).toBe(3);

    const two = board([CONSUMING_CURSE, CONSUMING_CURSE]);
    expect(
      onBoard(castSpell(two.state, CONSUMING_CURSE, 0, { targetUnitInstanceId: two.victim.instanceId }), two.victim.instanceId)
        ?.damage,
    ).toBe(4);
  });

  it("counts only cards with THIS name — other trash is not a Curse", () => {
    const { state, victim } = board([BRITTLE_STEEL, RUTHLESS_STRIKE, PERFECT_EXECUTION]);
    const after = castSpell(state, CONSUMING_CURSE, 0, { targetUnitInstanceId: victim.instanceId });
    expect(onBoard(after, victim.instanceId)?.damage, "it counted the whole trash").toBe(2);
  });

  it("counts the OWN trash, not the opponent's", () => {
    const { state, victim } = board([]);
    state.players[1]!.trash = [spellInstance(CONSUMING_CURSE), spellInstance(CONSUMING_CURSE)];
    const after = castSpell(state, CONSUMING_CURSE, 0, { targetUnitInstanceId: victim.instanceId });
    expect(onBoard(after, victim.instanceId)?.damage).toBe(2);
  });

  it("is ONE instance of damage, not a base shot plus a bonus shot", () => {
    // 714: Bonus Damage is an addition to an instance, not a new one. Asserted
    // through a unit that would DIE to 2 and survive 3 separately — a 3-Might
    // victim takes 3 at once and dies; two instances of 2 and 1 would also kill
    // it, so the readable difference is the marked damage on a big body, above.
    // What this pins is that the escalated shot is lethal in one go.
    const { state, victim } = board([CONSUMING_CURSE]);
    const small = { ...victim, might: 3 };
    state.battlefields[0]!.units = { p2: [small] };

    const after = castSpell(state, CONSUMING_CURSE, 0, { targetUnitInstanceId: small.instanceId });

    expect(onBoard(after, small.instanceId), "3 damage did not kill a 3-Might unit").toBeUndefined();
  });
});

describe("Perfect Execution (VEN-012): ready a unit and give it [Assault 3]", () => {
  it("does BOTH to one target", () => {
    const target = makeUnit({ instanceId: "target", exhausted: true });
    const state = makeState();
    state.players[0]!.baseUnits = [target];

    const after = castSpell(state, PERFECT_EXECUTION, 0, { targetUnitInstanceId: target.instanceId });
    const landed = onBoard(after, target.instanceId)!;

    expect(landed.exhausted, "it was never readied").toBe(false);
    expect(effectiveKeywords(after, landed, 0).Assault, "the grant was 1, the keyword default").toBe(3);
  });

  it("still grants [Assault 3] to an ALREADY-READY unit", () => {
    // The fidelity point, and the one real decision on this card: the offer is
    // deliberately not narrowed to exhausted units the way Jayce's "ready a gear"
    // is, because there is a second instruction with its own value and pumping a
    // ready attacker is the commonest line. A `exhaustedOnly` spec would withhold
    // a legal play.
    const target = makeUnit({ instanceId: "target", exhausted: false });
    const state = makeState();
    state.players[0]!.baseUnits = [target];

    const after = castSpell(state, PERFECT_EXECUTION, 0, { targetUnitInstanceId: target.instanceId });

    expect(effectiveKeywords(after, onBoard(after, target.instanceId)!, 0).Assault).toBe(3);
  });

  it("the targeting spec offers a ready unit — the enumerator, not just the resolver", () => {
    const spec = effectForCard(spellInstance(PERFECT_EXECUTION))?.targeting;
    expect(spec, "no targeting spec at all").toMatchObject({ kind: "unit", scope: "anywhere" });
    expect(
      (spec as { exhaustedOnly?: true }).exhaustedOnly,
      "the offer was narrowed to exhausted units, withholding a legal play",
    ).toBeUndefined();
  });
});

describe("Forsaken Baccai (VEN-005) and Oasis Raider (VEN-006): if you control FEWER runes", () => {
  function board(defId: string, mine: number, theirs: number): { state: GameState; unit: UnitInstance } {
    const unit = realUnitInstance(defId);
    const state = makeState({ phase: "Beginning" });
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.channeled = runes(mine, "mine");
    state.players[1]!.channeled = runes(theirs, "theirs");
    return { state, unit };
  }

  it("Forsaken Baccai takes +1 Might while behind", () => {
    const { state, unit } = board(FORSAKEN_BACCAI, 2, 4);
    const after = beginningPhaseFor(state, 0);
    expect(onBoard(after, unit.instanceId)?.mightThisTurn).toBe(1);
  });

  it("...and nothing when LEVEL — 'fewer' is strict, and this is the boundary", () => {
    // The mutation this exists for: `<=` instead of `<`. No lopsided board can
    // see it, which is why the level case is asserted rather than assumed.
    const { state, unit } = board(FORSAKEN_BACCAI, 3, 3);
    const after = beginningPhaseFor(state, 0);
    expect(onBoard(after, unit.instanceId)?.mightThisTurn, "equal counted as fewer").toBe(0);
  });

  it("...and nothing when AHEAD", () => {
    const { state, unit } = board(FORSAKEN_BACCAI, 5, 1);
    expect(onBoard(beginningPhaseFor(state, 0), unit.instanceId)?.mightThisTurn).toBe(0);
  });

  it("...and nothing in the OPPONENT's Beginning Phase", () => {
    // "At the start of YOUR Beginning Phase". A trigger that fired on both would
    // pay out twice a round.
    const { state, unit } = board(FORSAKEN_BACCAI, 2, 4);
    expect(onBoard(beginningPhaseFor(state, 1), unit.instanceId)?.mightThisTurn).toBe(0);
  });

  it("Oasis Raider takes +2 Might AND [Ganking] while behind", () => {
    const { state, unit } = board(OASIS_RAIDER, 1, 4);
    const after = beginningPhaseFor(state, 0);
    const landed = onBoard(after, unit.instanceId)!;

    expect(landed.mightThisTurn).toBe(2);
    // He PRINTS [Ganking] too, so the grant is redundant on this board and must
    // still happen — see the card's entry. Asserted through the granted-keyword
    // table rather than the frame, so "he already had it" cannot pass for "the
    // clause fired".
    expect(landed.keywordsThisTurn.Ganking, "the granted half of the clause was dropped").toBeDefined();
  });

  it("...and neither half when level", () => {
    const { state, unit } = board(OASIS_RAIDER, 3, 3);
    const landed = onBoard(beginningPhaseFor(state, 0), unit.instanceId)!;
    expect(landed.mightThisTurn).toBe(0);
    expect(landed.keywordsThisTurn.Ganking).toBeUndefined();
  });
});

describe("Baccai Reaper (VEN-009): pay [Fury] on attack for [Assault 2]", () => {
  function board(power: number): { state: GameState; reaper: UnitInstance } {
    const reaper = realUnitInstance(BACCAI_REAPER);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [reaper], p2: [makeUnit({ instanceId: "blocker" })] };
    state.players[0]!.channeled = runes(power);
    return { state, reaper };
  }

  it("pays the pip and SUMS with his printed [Assault 2] — 817", () => {
    // The rule a playtest found this engine getting wrong two sets ago: valued
    // keywords from separate sources SUM. He prints 2 and the clause gives 2, so
    // a paid Reaper is at 4 — not at 2, which is what `mergeGrantedKeyword`
    // taking the higher would give if the grant were routed around.
    const { state, reaper } = board(2);
    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => {
      const pay = options.find((o) => o.id === "pay");
      expect(pay, "the offer was never made on an affordable board").toBeDefined();
      return pay!.id;
    });

    expect(effectiveKeywords(after, onBoard(after, reaper.instanceId)!, 0).Assault).toBe(4);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready").length, "the pip was never spent").toBe(1);
  });

  it("declining leaves him at his printed 2 and keeps the rune", () => {
    const { state, reaper } = board(2);
    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => options[0]!.id);

    expect(effectiveKeywords(after, onBoard(after, reaper.instanceId)!, 0).Assault).toBe(2);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready").length).toBe(2);
  });

  it("is not even ASKED with no Fury to pay — 416.3", () => {
    const { state } = board(0);
    const after = beginCombatAt(state, "bf1", 0);
    expect(after.pendingDecisions.map((d) => d.kind), "an unpayable offer was parked").not.toContain("VEN-009-assault");
  });

  it("NEGATIVE CONTROL: nothing is offered when he DEFENDS", () => {
    // "When I ATTACK", not "attack or defend" — Draven - Vanquisher's clause says
    // the second and takes a different predicate. Copying him wholesale would
    // have quietly widened this card.
    //
    // POSITIVE CONTROL on the same fixture first, so a silent board cannot pass.
    const attacking = board(2);
    expect(beginCombatAt(attacking.state, "bf1", 0).pendingDecisions.map((d) => d.kind)).toContain("VEN-009-assault");

    const defending = board(2);
    expect(
      beginCombatAt(defending.state, "bf1", 1).pendingDecisions.map((d) => d.kind),
      "he was offered the pump as a DEFENDER",
    ).not.toContain("VEN-009-assault");
  });
});

describe("Renekton, Rage Fueled (VEN-019): on attack, at 4 or fewer runes, deal 2 to all enemies here", () => {
  function board(runeCount: number): { state: GameState; renekton: UnitInstance; here: UnitInstance; there: UnitInstance; ally: UnitInstance } {
    const renekton = realUnitInstance(RENEKTON);
    const here = makeUnit({ instanceId: "here", might: 9 });
    const there = makeUnit({ instanceId: "there", might: 9 });
    const ally = makeUnit({ instanceId: "ally", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [renekton, ally], p2: [here] };
    state.battlefields[1]!.units = { p2: [there] };
    state.players[0]!.channeled = runes(runeCount);
    return { state, renekton, here, there, ally };
  }

  it("sweeps the enemies at HIS battlefield", () => {
    const { state, here } = board(4);
    const after = beginCombatAt(state, "bf1", 0);
    expect(onBoard(after, here.instanceId)?.damage).toBe(2);
  });

  it("...and not the enemies elsewhere, nor his own side", () => {
    const { state, there, ally } = board(4);
    const after = beginCombatAt(state, "bf1", 0);
    expect(onBoard(after, there.instanceId)?.damage, "it swept the whole board").toBe(0);
    expect(onBoard(after, ally.instanceId)?.damage, "it hit a friendly unit").toBe(0);
  });

  it("does nothing at FIVE runes — '4 or fewer' is the boundary", () => {
    // POSITIVE CONTROL at 4 above; this is the same board one rune richer, which
    // is the only difference a `>=` mutation would show.
    const { state, here } = board(5);
    const after = beginCombatAt(state, "bf1", 0);
    expect(onBoard(after, here.instanceId)?.damage, "the ceiling is off by one").toBe(0);
  });

  it("NEGATIVE CONTROL: nothing when he is the DEFENDER", () => {
    const { state, here } = board(4);
    const after = beginCombatAt(state, "bf1", 1);
    expect(onBoard(after, here.instanceId)?.damage).toBe(0);
  });
});

describe("Twilight Reveler (VEN-020): on attack, ready ANOTHER friendly unit", () => {
  it("readies an exhausted ally", () => {
    const reveler = { ...realUnitInstance(TWILIGHT_REVELER), exhausted: true };
    const ally = makeUnit({ instanceId: "ally", exhausted: true });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [reveler], p2: [makeUnit({ instanceId: "blocker" })] };
    state.players[0]!.baseUnits = [ally];

    const after = beginCombatAt(state, "bf1", 0);

    expect(onBoard(after, ally.instanceId)?.exhausted, "the ally was never readied").toBe(false);
  });

  it("never readies HIMSELF — 'another', and he is exhausted from attacking", () => {
    // The whole card. Without the self-exclusion he untaps himself every combat,
    // which is a different and much better unit; and he is the FIRST candidate
    // any board walk would reach, so the bug is the default outcome.
    const reveler = { ...realUnitInstance(TWILIGHT_REVELER), exhausted: true };
    const state = makeState();
    state.battlefields[0]!.units = { p1: [reveler], p2: [makeUnit({ instanceId: "blocker" })] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(onBoard(after, reveler.instanceId)?.exhausted, "he readied himself").toBe(true);
  });

  it("does not ready an ENEMY unit", () => {
    const reveler = { ...realUnitInstance(TWILIGHT_REVELER), exhausted: true };
    const enemy = makeUnit({ instanceId: "blocker", exhausted: true });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [reveler], p2: [enemy] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(onBoard(after, enemy.instanceId)?.exhausted).toBe(true);
  });
});

describe("Eclipse Dragon (VEN-016): when I move, at 4 or fewer runes, draw 1", () => {
  function board(runeCount: number): { state: GameState; dragon: UnitInstance; other: UnitInstance } {
    const dragon = realUnitInstance(ECLIPSE_DRAGON);
    const other = makeUnit({ instanceId: "other" });
    const state = makeState();
    state.players[0]!.baseUnits = [dragon, other];
    state.players[0]!.channeled = runes(runeCount);
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL), spellInstance(CONSUMING_CURSE)];
    return { state, dragon, other };
  }

  /** A force-move, which 449 makes a real Move and which therefore fires the
   *  same `unitMoved` event a Standard Move does. Used rather than a MoveUnit
   *  action so the rune count can be set independently of what a move costs. */
  function move(state: GameState, unit: UnitInstance): GameState {
    return resolveHeldTriggers(forceMoveToBattlefield(state, unit.instanceId, "bf1"));
  }

  it("draws on his own move", () => {
    const { state, dragon } = board(4);
    expect(move(state, dragon).players[0]!.hand.length).toBe(1);
  });

  it("does not draw at FIVE runes", () => {
    const { state, dragon } = board(5);
    expect(move(state, dragon).players[0]!.hand.length, "the ceiling is off by one").toBe(0);
  });

  it("NEGATIVE CONTROL: another unit's move draws nothing", () => {
    // POSITIVE CONTROL on the same board first, so a fixture that moves nothing
    // cannot pass this.
    const mine = board(4);
    expect(move(mine.state, mine.dragon).players[0]!.hand.length, "positive control failed").toBe(1);

    const theirs = board(4);
    expect(move(theirs.state, theirs.other).players[0]!.hand.length, "he drew off somebody else's move").toBe(0);
  });
});

describe("Morgana, Vindictive (VEN-017): deal damage equal to the damage marked on it", () => {
  it("doubles a wound", () => {
    const victim = makeUnit({ instanceId: "victim", might: 9, damage: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = playUnitTrigger(state, realUnitInstance(MORGANA), 0, "base", {
      targetUnitInstanceId: victim.instanceId,
    });

    expect(onBoard(after, victim.instanceId)?.damage, "the shot was not the marked amount").toBe(6);
  });

  it("does NOTHING to an undamaged unit — not even an INSTANCE of 0", () => {
    // The common case, unlike Lucian's zero-Assault edge: most units on a board
    // are untouched.
    //
    // **Asserted through Noxian Guillotine's marker, because marked damage alone
    // cannot see this.** A `dealDamage(..., 0)` leaves `damage` at 0 either way,
    // so a test reading the wound would pass against a resolver that fired a
    // zero-damage instance — the vacuous-pin shape this project keeps recording.
    // `markedForDeathOnDamageInstanceIds` is "kill it the NEXT time it takes
    // damage", and an instance of 0 is still an instance: with the guard removed
    // the victim dies here.
    const victim = makeUnit({ instanceId: "victim", might: 9, damage: 0 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state.markedForDeathOnDamageInstanceIds = [victim.instanceId];

    const after = playUnitTrigger(state, realUnitInstance(MORGANA), 0, "base", {
      targetUnitInstanceId: victim.instanceId,
    });

    expect(onBoard(after, victim.instanceId), "a zero-damage instance was dealt").toBeDefined();
    expect(onBoard(after, victim.instanceId)?.damage).toBe(0);
  });

  it("finishes a unit whose marked damage is half its Might", () => {
    const victim = makeUnit({ instanceId: "victim", might: 4, damage: 2 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = playUnitTrigger(state, realUnitInstance(MORGANA), 0, "base", {
      targetUnitInstanceId: victim.instanceId,
    });

    expect(onBoard(after, victim.instanceId), "2 + 2 did not kill a 4-Might unit").toBeUndefined();
  });

  it("reads the wound at RESOLUTION, not when the trigger was held", () => {
    // 383 fixes WHAT triggered at the moment of the event, not the numbers the
    // instruction reads; the response window between the two is exactly when
    // somebody else's damage lands. Driven by damaging the victim between the
    // hold and the settle.
    const victim = makeUnit({ instanceId: "victim", might: 9, damage: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const held = dispatchOnPlayUnit(state, realUnitInstance(MORGANA), 0, "base", {
      targetUnitInstanceId: victim.instanceId,
    });
    const worsened: GameState = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { p2: [{ ...victim, damage: 4 }] } } : bf,
      ),
    };

    const after = resolveHeldTriggers(worsened);

    expect(onBoard(after, victim.instanceId)?.damage, "it used the wound captured at hold time").toBe(8);
  });
});

describe("Blade Twirler (VEN-002): the FIRST time I move each turn, choose a player. They Burn 1", () => {
  function board(): { state: GameState; twirler: UnitInstance } {
    const twirler = realUnitInstance(BLADE_TWIRLER);
    const state = makeState();
    state.players[0]!.baseUnits = [twirler];
    state.players[0]!.deck = [spellInstance(BRITTLE_STEEL)];
    state.players[1]!.deck = [spellInstance(CONSUMING_CURSE)];
    return { state, twirler };
  }

  it("offers BOTH seats — 'a player', not 'an opponent'", () => {
    // Bewitching Spirit draws the same distinction, and it is printed: burning
    // your own top card is a live line. A card hard-coded to the opponent would
    // present one option and be auto-answered.
    const { state, twirler } = board();
    const moved = resolveHeldTriggers(forceMoveToBattlefield(state, twirler.instanceId, "bf1"));

    const decision = moved.pendingDecisions[0];
    expect(decision?.kind, "no question was parked at all").toBe("VEN-002-burn");
    expect(optionsFor(moved, decision!).length, "the choice of seat is not being offered").toBe(2);
  });

  it("burns the chosen seat's top card", () => {
    const { state, twirler } = board();
    const moved = resolveHeldTriggers(forceMoveToBattlefield(state, twirler.instanceId, "bf1"));

    // The OPPONENT leads, the convention every such offer here follows.
    const after = answerDecisions(moved, (options) => options[0]!.id);

    expect(after.players[1]!.trash.map((c) => c.defId), "the opponent's deck was not burned").toEqual([CONSUMING_CURSE]);
    expect(after.players[0]!.trash, "it burned the wrong seat as well").toEqual([]);
  });

  it("...and the OTHER answer burns your own", () => {
    const { state, twirler } = board();
    const moved = resolveHeldTriggers(forceMoveToBattlefield(state, twirler.instanceId, "bf1"));

    const after = answerDecisions(moved, (options) => options[1]!.id);

    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([BRITTLE_STEEL]);
  });

  it("fires on the FIRST move only, not the second", () => {
    const { state, twirler } = board();
    const first = answerDecisions(resolveHeldTriggers(forceMoveToBattlefield(state, twirler.instanceId, "bf1")));
    expect(first.players[1]!.trash.length, "positive control failed — the first move did nothing").toBe(1);

    const second = resolveHeldTriggers(forceMoveToBattlefield(first, twirler.instanceId, "bf2"));

    expect(second.pendingDecisions.map((d) => d.kind), "the second move asked again").not.toContain("VEN-002-burn");
  });

  it("...and the second move does not even PLACE the ability on the chain", () => {
    // **A stronger claim than "asked nothing", and the line exists because the
    // weaker one let a mutant through.** Loosening `applies` to fire on every
    // move SURVIVED the test above: `resolve` re-checks the ordinal and returns
    // the state unchanged, so no question is parked — while the Pending Item is
    // still placed and still costs both players a PassFocus for an ability that
    // resolves to nothing. Jhin - Murderous Artist's test records the identical
    // finding for the identical reason.
    //
    // Read BEFORE `resolveHeldTriggers` drains the holding pen, which is the
    // fixture trap this project has hit twice.
    const { state, twirler } = board();
    const first = answerDecisions(resolveHeldTriggers(forceMoveToBattlefield(state, twirler.instanceId, "bf1")));

    const secondHeld = forceMoveToBattlefield(first, twirler.instanceId, "bf2");

    expect(
      heldDefIds(secondHeld),
      "his ability was placed for a second move — `applies` is not filtering on the ordinal",
    ).not.toContain(BLADE_TWIRLER);
    // POSITIVE CONTROL on the same instrument: the FIRST move does place it, so
    // a `heldDefIds` that could never see anything cannot pass this pair.
    // A FRESH board, since the one above has already had its first move — and
    // its own twirler, because `realUnitInstance` mints a new instanceId per call
    // and reusing the outer one silently measures a unit that is not there.
    const fresh = board();
    expect(heldDefIds(forceMoveToBattlefield(fresh.state, fresh.twirler.instanceId, "bf1"))).toContain(BLADE_TWIRLER);
  });

  it("NEGATIVE CONTROL: another unit's move asks nothing, and places nothing", () => {
    const { state } = board();
    const other = makeUnit({ instanceId: "other" });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, other];

    const held = forceMoveToBattlefield(state, other.instanceId, "bf1");

    expect(heldDefIds(held), "he was placed for somebody else's move").not.toContain(BLADE_TWIRLER);
    expect(resolveHeldTriggers(held).pendingDecisions.map((d) => d.kind)).not.toContain("VEN-002-burn");
  });
});

describe("Shadow Assassin (VEN-013): I enter ready if a card with my name is in your trash", () => {
  const assassin = () => realUnitInstance(SHADOW_ASSASSIN);

  it("enters exhausted against an empty trash", () => {
    expect(unitEntersReady(makeState(), 0, assassin())).toBe(false);
  });

  it("enters ready with another copy of himself in the trash", () => {
    const state = makeState();
    state.players[0]!.trash = [realUnitInstance(SHADOW_ASSASSIN)];
    expect(unitEntersReady(state, 0, assassin()), "the name match never fired").toBe(true);
  });

  it("...matched on NAME, not defId — a reprint under another id still counts", () => {
    // The card says "a card with my name", and those two answers come apart in
    // this very pool: Vendetta reprints ten earlier cards under plain names.
    // `printingAliases` redirects an IMPLEMENTATION lookup, not a name question.
    const state = makeState();
    state.players[0]!.trash = [{ ...realUnitInstance(SHADOW_ASSASSIN), defId: "SOME-OTHER-PRINTING" }];
    expect(unitEntersReady(state, 0, assassin()), "it compared defIds").toBe(true);
  });

  it("...and a DIFFERENT card in the trash does not count", () => {
    const state = makeState();
    state.players[0]!.trash = [spellInstance(BRITTLE_STEEL), realUnitInstance(MORGANA)];
    expect(unitEntersReady(state, 0, assassin()), "any trash counted").toBe(false);
  });

  it("reads YOUR trash, not the opponent's", () => {
    const state = makeState();
    state.players[1]!.trash = [realUnitInstance(SHADOW_ASSASSIN)];
    expect(unitEntersReady(state, 0, assassin())).toBe(false);
  });

  it("NEGATIVE CONTROL: an ordinary unit is unaffected by a full trash", () => {
    // Proves the case is keyed on HIM rather than on the trash being non-empty.
    const state = makeState();
    state.players[0]!.trash = [realUnitInstance(SHADOW_ASSASSIN)];
    expect(unitEntersReady(state, 0, realUnitInstance(MORGANA))).toBe(false);
  });
});

describe("coverage sees every card in this wave", () => {
  it("all fourteen report implemented", () => {
    // The gate that turns "I wrote a resolver" into "the engine can find it" —
    // a registry table with the wrong arity type-checks and lands the card in a
    // table nothing reads.
    for (const id of [
      BRITTLE_STEEL,
      RUTHLESS_STRIKE,
      CONSUMING_CURSE,
      PERFECT_EXECUTION,
      FORSAKEN_BACCAI,
      OASIS_RAIDER,
      BACCAI_REAPER,
      RENEKTON,
      TWILIGHT_REVELER,
      ECLIPSE_DRAGON,
      MORGANA,
      BLADE_TWIRLER,
      SHADOW_ASSASSIN,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });

  it("Morgana is in the UNIT-trigger table, not the card-effect one", () => {
    // The registry-arity trap: a Unit's on-play trigger and a Spell's effect live
    // in different tables with different `resolve` signatures, and filing one as
    // the other type-checks as far as the editor is concerned.
    expect(unitTriggerForCard(MORGANA), "she is not registered as a unit trigger").toBeDefined();
    expect(effectForCard(spellInstance(MORGANA)), "she is ALSO a card effect").toBeUndefined();
  });
});
