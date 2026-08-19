import { describe, expect, it, vi } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { scoringBecomesDraw } from "../src/engine/board-restrictions.js";
import { ignoresDeflectWhilePaying, rainbowSurchargeForPlay } from "../src/engine/cost-modifiers.js";
import { activatedAbilityFor, canPayActivationCost, discardableForCost } from "../src/engine/activated-abilities.js";
import { scoreHolds, recordConquest } from "../src/engine/scoring.js";
import { eligibleTargets } from "../src/engine/target-lookup.js";
import { eventTriggerFor, holdEventTrigger } from "../src/engine/triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { empowerPermanent } from "../src/engine/effect-helpers.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Mind cards — wave 2, the four that are engine seams rather than
 * card text.**
 *
 * Each of these four needed something the engine did not have, and in each case
 * the new thing is shared: a replacement on SCORING (Otterpus), a KIND filter on
 * a discard cost (Sky Cruiser), rule 766's IGNORE mechanism (Decree of Insight),
 * and a `domain` axis on the plain `unit` targeting spec. So the tests are as
 * much about the seam as about the card — an axis honoured by the enumerator and
 * ignored by the validator is this codebase's most-repeated bug, and every
 * narrowing here is therefore asserted from BOTH ends.
 */

const registry = defaultCardRegistry();

const OTTERPUS = "VEN-053";
const SKY_CRUISER = "VEN-060";
const DECREE_OF_INSIGHT = "VEN-061";
const JAYCE = "VEN-068";

/** A real gear card, for Sky Cruiser's discard cost. */
const A_GEAR = "OGN-017";
/** A real spell, for the same cost's negative. */
const A_SPELL = "OGN-004";
/** A Body-domain unit and a non-Body one, for Decree of Insight's narrowing. */
const BODY_UNIT = "OGN-130";
const FURY_UNIT = "OGN-003";
/** A unit that actually prints [Deflect], for the surcharge test. */
const DEFLECTOR = "OGN-013";

const runes = (n: number, domain = "Mind"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${domain}${i}`, domain, state: "Ready" }) as RuneCard);

describe("Otterpus (VEN-053): a replacement on SCORING", () => {
  function board(turnNumber: number, withOtterpus = true): GameState {
    const state = makeState({ turnNumber });
    if (withOtterpus) state.players[0]!.baseUnits = [realUnitInstance(OTTERPUS)];
    state.players[0]!.deck = [spellInstance(A_SPELL), spellInstance(A_SPELL), spellInstance(A_SPELL)];
    state.players[1]!.deck = [spellInstance(A_SPELL), spellInstance(A_SPELL)];
    return state;
  }

  /** p1 holds bf1 — the state `scoreHolds` pays out for. */
  function holding(state: GameState): GameState {
    const bf = state.battlefields[0]!;
    bf.controllerId = "p1";
    bf.units = { p1: [makeUnit()] };
    return state;
  }

  it("turns a HOLD score into a draw on turn 1", () => {
    const before = holding(board(1));
    const after = scoreHolds(before, 0);

    expect(after.players[0]!.points, "it scored anyway").toBe(0);
    expect(after.players[0]!.hand, "it did not draw instead").toHaveLength(1);
  });

  it("turns a CONQUEST score into a draw on turn 1", () => {
    // The second of the two scoring sites. The card names both methods, so a
    // replacement written at one is half a card.
    const after = recordConquest(board(1), 0, "bf1", true);

    expect(after.players[0]!.points).toBe(0);
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("stops after the SECOND turn — the boundary in both directions", () => {
    expect(scoringBecomesDraw(board(1), 0), "turn 1 was not replaced").toBe(true);
    expect(scoringBecomesDraw(board(2), 0), "turn 2 was not replaced").toBe(true);
    expect(scoringBecomesDraw(board(3), 0), "turn 3 was STILL replaced").toBe(false);

    const third = scoreHolds(holding(board(3)), 0);
    expect(third.players[0]!.points, "turn 3 drew instead of scoring").toBe(1);
  });

  it("binds BOTH players, including the Otterpus's own controller", () => {
    // "A player", bare. It is the first entry in `board-restrictions` that binds
    // its own side, and that is the whole design: a symmetrical early clock.
    const state = board(1);
    expect(scoringBecomesDraw(state, 0), "his own controller was exempt").toBe(true);
    expect(scoringBecomesDraw(state, 1), "the opponent was exempt").toBe(true);

    const enemyConquest = recordConquest(state, 1, "bf1", true);
    expect(enemyConquest.players[1]!.points).toBe(0);
    expect(enemyConquest.players[1]!.hand).toHaveLength(1);
  });

  it("does nothing with no Otterpus in play — the CONTROL", () => {
    const after = scoreHolds(holding(board(1, false)), 0);
    expect(after.players[0]!.points, "the control did not score either").toBe(1);
    expect(after.players[0]!.hand).toEqual([]);
  });

  it("still records the battlefield as SCORED, so 470's lockout fires", () => {
    // Tianna Crownguard's treatment: blocking the point does not unrecord the
    // scoring. Recorded Unverified in docs/rules-conformance.md — the other
    // reading is that a replaced score never happened.
    const after = scoreHolds(holding(board(1)), 0);
    expect(after.players[0]!.scoredBattlefieldsThisTurn).toContain("bf1");
  });

  it("replaces per POINT, so two holds draw two", () => {
    const state = board(1);
    for (const bf of state.battlefields) {
      bf.controllerId = "p1";
      bf.units = { p1: [makeUnit()] };
    }
    const after = scoreHolds(state, 0);

    expect(after.players[0]!.points).toBe(0);
    expect(after.players[0]!.hand, "only one card was drawn for two holds").toHaveLength(2);
  });
});

describe("Sky Cruiser (VEN-060): a discard cost with a KIND", () => {
  function board(hand: string[]): { state: GameState; cruiser: UnitInstance } {
    const state = makeState();
    const cruiser = realUnitInstance(SKY_CRUISER);
    state.battlefields[0]!.units = { p1: [cruiser], p2: [makeUnit({ might: 9 })] };
    state.players[0]!.hand = hand.map((id) => (registry.get(id).type === "Gear" ? realGearInstance(id) : spellInstance(id)));
    state.players[0]!.channeled = runes(4);
    return { state, cruiser };
  }

  const cost = () => activatedAbilityFor(SKY_CRUISER)!.cost!;

  it("offers only GEAR to pay the discard", () => {
    const { state } = board([A_GEAR, A_SPELL]);
    const payable = discardableForCost(state, 0, cost()).map((c) => c.defId);

    expect(payable, "a spell was offered to pay a gear discard").toEqual([A_GEAR]);
  });

  it("is UNAFFORDABLE with no gear in hand, so it is never offered (416.3)", () => {
    // The narrowing decides whether the ability appears at all, which is why it
    // lives in the shared walk rather than in the resolver.
    const { state, cruiser } = board([A_SPELL, A_SPELL]);
    expect(canPayActivationCost(state, 0, cruiser), "a gearless hand could pay").toBe(false);

    const offered = legalActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === cruiser.instanceId,
    );
    expect(offered, "an unpayable ability was offered").toEqual([]);
  });

  it("...and IS offered once a gear is in hand — the control on that negative", () => {
    const { state, cruiser } = board([A_GEAR]);
    expect(canPayActivationCost(state, 0, cruiser)).toBe(true);

    const offered = legalActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === cruiser.instanceId,
    );
    expect(offered.length, "a payable ability was not offered").toBeGreaterThan(0);
  });

  it("the ENUMERATOR offers the gear and NOT the spell beside it", () => {
    // **A MIXED hand, deliberately.** The first draft of this assertion used a
    // hand holding only the gear, where a narrowed walk and an unnarrowed one
    // produce the same single variant — a mutant that dropped the narrowing from
    // the enumerator survived it untouched. Measured.
    const { state, cruiser } = board([A_GEAR, A_SPELL]);
    const gearId = state.players[0]!.hand.find((c) => c.defId === A_GEAR)!.instanceId;
    const spellId = state.players[0]!.hand.find((c) => c.defId === A_SPELL)!.instanceId;

    const discarded = new Set(
      legalActions(state)
        .filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === cruiser.instanceId)
        .map((a) => (a as { costDiscardCardInstanceId?: string }).costDiscardCardInstanceId),
    );

    expect(discarded, "the gear was not offered as the discard").toContain(gearId);
    expect(discarded, "a SPELL was offered to pay a gear-only discard").not.toContain(spellId);
  });

  it("deals 4 to a unit at a battlefield", () => {
    const { state, cruiser } = board([A_GEAR]);
    const victim = state.battlefields[0]!.units.p2![0]!;
    const ability = activatedAbilityFor(SKY_CRUISER)!;

    const after = ability.resolve!(
      state,
      contextFor(0, cruiser.instanceId),
      { targetUnitInstanceId: victim.instanceId } as never,
      cruiser.instanceId,
    );
    expect(after.battlefields[0]!.units.p2![0]!.damage).toBe(4);
  });
});

describe("Decree of Insight (VEN-061): rule 766's IGNORE, and a domain narrowing", () => {
  function board(): GameState {
    const state = makeState();
    state.battlefields[0]!.units = { p2: [realUnitInstance(BODY_UNIT), realUnitInstance(FURY_UNIT)] };
    return state;
  }

  it("targets only an enemy BODY unit, in the enumerator's walk", () => {
    const state = board();
    const spec = cardModeOf(spellInstance(DECREE_OF_INSIGHT), undefined)!.targeting;
    expect(spec, "the card declares no domain narrowing").toMatchObject({ domain: "Body" });

    const offered = eligibleTargets(state, 0, "enemy", "anywhere", "Body").map((u) => u.defId);
    expect(offered, "a non-Body unit was offered").toEqual([BODY_UNIT]);
  });

  it("...and the same walk WITHOUT the narrowing sees both — the control", () => {
    const offered = eligibleTargets(board(), 0, "enemy", "anywhere").map((u) => u.defId);
    expect(offered).toHaveLength(2);
  });

  it("narrows units in BASE too, which is a different branch of the walk", () => {
    // `eligibleTargets` walks bases and battlefields through two separate filters,
    // and a fixture that seats everything at a battlefield exercises only one of
    // them — measured, a mutant that dropped the domain check from the BASE
    // branch survived the assertion above.
    const state = makeState();
    state.players[1]!.baseUnits = [realUnitInstance(BODY_UNIT), realUnitInstance(FURY_UNIT)];

    expect(eligibleTargets(state, 0, "enemy", "anywhere", "Body").map((u) => u.defId), "a non-Body base unit was offered").toEqual([
      BODY_UNIT,
    ]);
    expect(eligibleTargets(state, 0, "enemy", "anywhere").map((u) => u.defId), "the control saw only one").toHaveLength(2);
  });

  it("gives -5 Might this turn", () => {
    const state = board();
    const victim = state.battlefields[0]!.units.p2![0]!;
    const mode = cardModeOf(spellInstance(DECREE_OF_INSIGHT), undefined)!;

    const after = mode.resolve(state, contextFor(0, "src"), { targetUnitInstanceId: victim.instanceId } as never);
    expect(after.battlefields[0]!.units.p2![0]!.mightThisTurn).toBe(-5);
  });

  it("IGNORES [Deflect] while paying — and only for this card", () => {
    // 764-766: the ability is treated as inactive for this payment only. The
    // keyword is NOT removed, which is why this is a surcharge question rather
    // than a `granted-keywords` one — a Decree that stripped [Deflect] would stop
    // the unit deflecting the NEXT spell too, and that is a different card.
    const state = makeState();
    const deflector = realUnitInstance(DEFLECTOR);
    state.battlefields[0]!.units = { p2: [deflector] };
    const chosen = [deflector.instanceId];

    const plain = rainbowSurchargeForPlay(state, 0, "Spell", chosen);
    expect(plain, "the fixture's unit has no [Deflect] — this measures nothing").toBeGreaterThan(0);

    expect(rainbowSurchargeForPlay(state, 0, "Spell", chosen, DECREE_OF_INSIGHT), "the Decree still paid").toBe(0);
    expect(rainbowSurchargeForPlay(state, 0, "Spell", chosen, A_SPELL), "another spell stopped paying").toBe(plain);
  });

  it("names the mechanism by card, so the next one is a row not a branch", () => {
    expect(ignoresDeflectWhilePaying(DECREE_OF_INSIGHT)).toBe(true);
    expect(ignoresDeflectWhilePaying(A_SPELL)).toBe(false);
  });
});

describe("Jayce, Brilliant Inventor (VEN-068): one ability, two moments", () => {
  function board(): { state: GameState; jayce: UnitInstance; ally: UnitInstance } {
    const state = makeState();
    const jayce = realUnitInstance(JAYCE);
    const ally = makeUnit({ exhausted: true });
    state.battlefields[0]!.units = { p1: [jayce, ally] };
    return { state, jayce, ally };
  }

  const readyOffer = (state: GameState) =>
    optionsFor(state, pendingDecision(state)!).map((o) => o.id);

  it("asks on PLAY", () => {
    const { state, jayce } = board();
    const asked = playUnitTrigger(state, jayce, 0, { battlefieldId: "bf1" }, {});

    expect(pendingDecision(asked)?.kind).toBe("VEN-068-ready");
  });

  it("asks again on the FIRST non-token gear each turn, and not the second", () => {
    // `gearPlayedThisTurn` is bumped inside `executePlayCardInner`, which runs
    // BEFORE this event is held — so the first gear arrives with the counter at
    // 1. The off-by-one this guards is the one that would fire him on the second
    // gear instead of the first.
    const { state, jayce } = board();
    const trigger = eventTriggerFor(JAYCE)!;
    const listener = { card: jayce, ownerIndex: 0 as const, battlefieldId: "bf1", defId: JAYCE };
    const event = (isToken?: true) => ({
      kind: "cardPlayed" as const,
      casterIndex: 0 as const,
      playedKind: "Gear" as const,
      playedInstanceId: "g1",
      playedPowerCost: 0,
      ...(isToken === undefined ? { isToken: false } : { isToken }),
    });

    const first = { ...state } as GameState;
    first.players[0]!.gearPlayedThisTurn = 1;
    expect(trigger.applies!(first, listener as never, event() as never), "the first gear did not fire him").toBe(true);

    const second = { ...state } as GameState;
    second.players[0]!.gearPlayedThisTurn = 2;
    expect(trigger.applies!(second, listener as never, event() as never), "the second gear fired him too").toBe(false);
  });

  it("ignores a gear TOKEN (185: tokens are not cards)", () => {
    const { state, jayce } = board();
    const trigger = eventTriggerFor(JAYCE)!;
    const listener = { card: jayce, ownerIndex: 0 as const, battlefieldId: "bf1", defId: JAYCE };
    const tokenPlay = {
      kind: "cardPlayed" as const,
      casterIndex: 0 as const,
      playedKind: "Gear" as const,
      playedInstanceId: "g1",
      playedPowerCost: 0,
      isToken: true as const,
    };
    const withCounter = { ...state } as GameState;
    withCounter.players[0]!.gearPlayedThisTurn = 1;

    expect(trigger.applies!(withCounter, listener as never, tokenPlay as never), "a Gold token fired him").toBe(false);
  });

  it("ignores the OPPONENT's gear", () => {
    const { state, jayce } = board();
    const trigger = eventTriggerFor(JAYCE)!;
    const listener = { card: jayce, ownerIndex: 0 as const, battlefieldId: "bf1", defId: JAYCE };
    const theirs = {
      kind: "cardPlayed" as const,
      casterIndex: 1 as const,
      playedKind: "Gear" as const,
      playedInstanceId: "g1",
      playedPowerCost: 0,
      isToken: false,
    };
    const withCounter = { ...state } as GameState;
    withCounter.players[0]!.gearPlayedThisTurn = 1;

    expect(trigger.applies!(withCounter, listener as never, theirs as never)).toBe(false);
  });

  it("offers everything EXHAUSTED besides himself, on either side", () => {
    const { state, jayce, ally } = board();
    const enemyGear = realGearInstance(A_GEAR);
    state.players[1]!.activeGear = [{ ...enemyGear, exhausted: true }];
    const readyAlly = makeUnit({ exhausted: false });

    // **Jayce himself must be EXHAUSTED on the BOARD, not merely in the argument.**
    // A unit enters exhausted, so this is the ordinary case — and a fixture that
    // left the board copy ready made "besides me" unobservable, which a mutant
    // dropping the self-filter walked straight through. Measured.
    const exhaustedJayce = { ...jayce, exhausted: true };
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p1: [exhaustedJayce, ally, readyAlly],
    };
    const asked = playUnitTrigger(state, exhaustedJayce, 0, { battlefieldId: "bf1" }, {});
    const offered = readyOffer(asked);

    expect(offered, "the exhausted ally was not offered").toContain(ally.instanceId);
    expect(offered, "an enemy exhausted gear was not offered").toContain(enemyGear.instanceId);
    expect(offered, "a READY permanent was offered").not.toContain(readyAlly.instanceId);
    expect(offered, "he offered HIMSELF").not.toContain(jayce.instanceId);
  });

  it("readies the chosen permanent", () => {
    const { state, jayce, ally } = board();
    const asked = playUnitTrigger(state, jayce, 0, { battlefieldId: "bf1" }, {});
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === ally.instanceId)!.id);

    const readied = after.battlefields[0]!.units.p1!.find((u) => u.instanceId === ally.instanceId)!;
    expect(readied.exhausted, "it stayed exhausted").toBe(false);
  });

  it("does nothing when declined — and the question was still ASKED", () => {
    // Answered with the DEFAULT pick, which is the decline, so the two halves are
    // separated: the offer is read off `pendingDecisions`, the outcome off the
    // board. That split is the lesson from Chaos wave 2's four survivors.
    const { state, jayce, ally } = board();
    const asked = playUnitTrigger(state, jayce, 0, { battlefieldId: "bf1" }, {});
    expect(pendingDecision(asked)?.kind, "he never asked").toBe("VEN-068-ready");

    const after = answerDecisions(asked);
    const untouched = after.battlefields[0]!.units.p1!.find((u) => u.instanceId === ally.instanceId)!;
    expect(untouched.exhausted, "declining readied it anyway").toBe(true);
  });
});

describe("coverage sees the wave", () => {
  it("all four report implemented", () => {
    for (const id of [OTTERPUS, SKY_CRUISER, DECREE_OF_INSIGHT, JAYCE]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });
});
