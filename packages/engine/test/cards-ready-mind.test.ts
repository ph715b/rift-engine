import { describe, expect, it } from "vitest";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { destroyUnit, giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * The five Mind cards from cluster 1 of docs/dead-card-survey.md.
 *
 * **Everything here drives `executePlayCard` (and `executePassFocus` for the
 * Spells), never a resolver by hand.** That is not ceremony: a resolver called
 * directly passes whether or not the registry entry exists, whether or not the
 * dispatch hop forwards its fields, and whether or not the card is reachable at
 * all — which is exactly how Annie - Stubborn shipped paying its cost and doing
 * nothing while a green test called `dispatchOnPlayUnit` directly.
 *
 * Helpers are local rather than added to fixtures.ts because that file is shared
 * and four other agents are in this tree.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const unitCard = (defId: string): UnitInstance => card(defId) as UnitInstance;

const RETREAT = "OGN-104";
const CONVERGENT_MUTATION = "OGN-108";
const PIT_CREW = "OGN-091";
const WATCHFUL_SENTRY = "OGN-096";
const SPRITE_MOTHER = "OGN-106";
const GARBAGE_GRABBER = "OGN-099"; // Gear, Mind, 2 Energy — Pit Crew's trigger food
const FALLING_COMET = "OGN-085"; // Spell, Mind, 5 Energy, [Action]: "Deal 6 to a unit at a battlefield"

/** Ready Mind runes, ids distinct across a whole test so a payment can never
 *  accidentally name the same rune for Energy and for Power. */
function mindRunes(count: number, prefix = "r"): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, domain: "Mind" as const, state: "Ready" as const }));
}

/**
 * Plays a card through the REAL executor, paying for it out of the actor's
 * channeled pool.
 *
 * The size of the payment comes from `computeEffectiveCost` — the validator's
 * own function — rather than the printed cost, because a Ready rune recycled
 * for Power banks 1 floating Energy, so the SECOND cast in a test is genuinely
 * cheaper than the first. Re-deriving that here by hand is exactly the drift
 * this repo keeps paying for.
 *
 * Energy takes the front of the pool and Power the back, so the two never
 * collide — `validatePlayCard` rejects a payment that reuses a rune id, and a
 * test that tripped over that would fail for a reason unrelated to the card.
 */
function play(
  state: GameState,
  playerIndex: 0 | 1,
  played: CardInstance,
  extra: Partial<Parameters<typeof executePlayCard>[1]> = {},
): GameState {
  const actor = state.players[playerIndex]!;
  const { energyCost, powerCost } = computeEffectiveCost(
    actor.floatingEnergy,
    actor.floatingPower,
    "energyCost" in played ? played.energyCost : 0,
    "powerCost" in played ? played.powerCost : 0,
    "powerDomain" in played ? played.powerDomain : null,
  );
  const pool = actor.channeled.filter((r) => r.state === "Ready");
  return executePlayCard(state, {
    type: "PlayCard",
    playerIndex,
    card: played,
    payment: {
      energyRunes: pool.slice(0, energyCost).map((r) => r.id),
      powerRunes: pool.slice(pool.length - powerCost).map((r) => r.id),
    },
    ...extra,
  });
}

/** Two consecutive passes per chain item, which is what actually resolves a
 *  Spell (340/343). A Spell that is only `executePlayCard`ed has done nothing
 *  but go on the chain. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && !next.chainOpen; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  if (!next.chainOpen) throw new Error("resolveChain: the chain never reopened");
  return next;
}

const cast = (state: GameState, playerIndex: 0 | 1, spell: CardInstance, extra = {}) =>
  resolveChain(play(state, playerIndex, spell, extra));

/** Might as the rest of the engine sees it, looked up fresh by instance id —
 *  never the raw `mightThisTurn` field, which is only part of the answer. */
function mightOf(state: GameState, instanceId: string): number {
  for (const ownerIndex of [0, 1] as const) {
    const owner = state.players[ownerIndex]!;
    const inBase = owner.baseUnits.find((u) => u.instanceId === instanceId);
    if (inBase) return effectiveMight(state, inBase, ownerIndex, { isCombat: false });
    for (const bf of state.battlefields) {
      const here = (bf.units[owner.id] ?? []).find((u) => u.instanceId === instanceId);
      if (here) return effectiveMight(state, here, ownerIndex, { isCombat: false, battlefieldId: bf.id });
    }
  }
  throw new Error(`unit ${instanceId} is not in play`);
}

function unitAt(state: GameState, battlefieldId: string, ownerId: string): UnitInstance[] {
  return state.battlefields.find((bf) => bf.id === battlefieldId)!.units[ownerId] ?? [];
}

describe("Retreat (OGN-104): bounce a friendly unit, its owner channels 1 exhausted", () => {
  function retreatState(where: "battlefield" | "base"): { state: GameState; spell: CardInstance; target: UnitInstance } {
    const target = makeUnit({ might: 4 });
    const spell = card(RETREAT);
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [spell],
          channeled: mindRunes(2),
          runeDeck: [
            { id: "rd1", domain: "Mind", state: "Ready" },
            { id: "rd2", domain: "Mind", state: "Ready" },
          ],
        }),
        makePlayer("p2"),
      ],
    });
    if (where === "base") state.players[0]!.baseUnits = [target];
    else state.battlefields[0]!.units = { p1: [target] };
    return { state, spell, target };
  }

  it("returns the unit to hand and channels a rune EXHAUSTED, through the real cast", () => {
    const { state, spell, target } = retreatState("battlefield");
    const runesBefore = state.players[0]!.channeled.length;

    const after = cast(state, 0, spell, { targetUnitInstanceId: target.instanceId });

    expect(unitAt(after, "bf1", "p1")).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(target.instanceId);
    // One rune paid for the spell (Energy: exhausted, still in pool) and one
    // channeled by the effect, so the pool grew by exactly one.
    expect(after.players[0]!.channeled).toHaveLength(runesBefore + 1);
    expect(after.players[0]!.channeled.at(-1)!.state).toBe("Exhausted");
    expect(after.players[0]!.runeDeck).toHaveLength(1); // one taken off the rune deck
  });

  it("reaches a friendly unit standing in your own base", () => {
    // "A friendly unit", not "a friendly unit at a battlefield" — 355.9.b puts
    // Bases among the public zones a target may be drawn from.
    const { state, spell, target } = retreatState("base");

    const after = cast(state, 0, spell, { targetUnitInstanceId: target.instanceId });

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(target.instanceId);
    expect(after.players[0]!.runeDeck).toHaveLength(1);
  });

  it("a target that died while this sat on the chain gets NO channel either (359.3.e)", () => {
    // "Its owner channels" is an instruction about the target, so it goes with
    // it — unlike the rules' own Void Seeker example, where the unrelated
    // "Draw 1" survives an illegal target.
    const { state, spell, target } = retreatState("battlefield");
    const onChain = play(state, 0, spell, { targetUnitInstanceId: target.instanceId });
    const runesBefore = onChain.players[0]!.channeled.length;

    const after = resolveChain(destroyUnit(onChain, target.instanceId, 1));

    expect(after.players[0]!.runeDeck).toHaveLength(2); // untouched
    expect(after.players[0]!.channeled).toHaveLength(runesBefore);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).not.toContain(target.instanceId);
  });
});

describe("Convergent Mutation (OGN-108): increase a friendly unit's Might TO another's", () => {
  /** Two friendly units and the spell, with runes for 2 Energy + 1 Mind Power. */
  function mutationState(chosenMight: number, donorMight: number) {
    const chosen = makeUnit({ might: chosenMight });
    const donor = makeUnit({ might: donorMight });
    const spell = card(CONVERGENT_MUTATION);
    const state = makeState({
      players: [makePlayer("p1", { hand: [spell], channeled: mindRunes(4) }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p1: [chosen, donor] };
    return { state, spell, chosen, donor };
  }

  const mutate = (state: GameState, spell: CardInstance, chosen: UnitInstance, donor: UnitInstance) =>
    cast(state, 0, spell, { targetUnitInstanceId: chosen.instanceId, secondTargetUnitInstanceId: donor.instanceId });

  it("raises the chosen unit to the donor's Might through the real cast", () => {
    const { state, spell, chosen, donor } = mutationState(2, 7);

    const after = mutate(state, spell, chosen, donor);

    expect(mightOf(after, chosen.instanceId)).toBe(7);
    expect(mightOf(after, donor.instanceId)).toBe(7); // the donor is measured, not moved
  });

  it("increases by 0 rather than SHRINKING when the donor is smaller — but grows the other way round", () => {
    // Rule 477's Arithmetic layer: "Players cannot increase a numeric attribute
    // by a negative amount. If an effect would instruct a player to do so, they
    // increase it by 0 instead." This is the whole difference between "increase
    // its Might TO x" and "its Might BECOMES x", which the rules put in
    // different layers.
    //
    // Both directions in ONE test on purpose. The +0 half alone passes just as
    // happily against an unregistered card, so it proves nothing by itself; the
    // second cast is the positive control that makes the whole test fail if the
    // card is inert.
    const big = makeUnit({ might: 7 });
    const small = makeUnit({ might: 2 });
    const first = card(CONVERGENT_MUTATION);
    const second = card(CONVERGENT_MUTATION);
    const state = makeState({
      players: [makePlayer("p1", { hand: [first, second], channeled: mindRunes(10) }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p1: [big, small] };

    const shrinkAttempt = cast(state, 0, first, {
      targetUnitInstanceId: big.instanceId,
      secondTargetUnitInstanceId: small.instanceId,
    });
    expect(mightOf(shrinkAttempt, big.instanceId)).toBe(7);
    expect(mightOf(shrinkAttempt, small.instanceId)).toBe(2);

    const grown = cast(shrinkAttempt, 0, second, {
      targetUnitInstanceId: small.instanceId,
      secondTargetUnitInstanceId: big.instanceId,
    });
    expect(mightOf(grown, small.instanceId)).toBe(7);
  });

  it("reads the donor's EFFECTIVE Might, not its printed Might", () => {
    // A donor pumped this turn donates the pumped number — the Arithmetic layer
    // works on the value the rest of the game sees.
    const { state, spell, chosen, donor } = mutationState(2, 4);
    const pumped = giveMightThisTurn(state, donor.instanceId, 3); // 4 -> 7

    const after = mutate(pumped, spell, chosen, donor);

    expect(mightOf(after, chosen.instanceId)).toBe(7);
  });

  it("counts the CHOSEN unit's existing modifier too, so it does not overshoot", () => {
    // Chosen is 2 printed but already standing at 5; the donor is 7, so it needs
    // +2, not +7. Reading printed Might on this side would put it at 9.
    const { state, spell, chosen, donor } = mutationState(2, 7);
    const pumped = giveMightThisTurn(state, chosen.instanceId, 3); // 2 -> 5

    const after = mutate(pumped, spell, chosen, donor);

    expect(mightOf(after, chosen.instanceId)).toBe(7);
  });

  it("SNAPSHOTS: the chosen unit does not follow the donor afterwards", () => {
    // The Arithmetic layer stores a fixed delta rather than a live link, which
    // is what "it will snapshot" means for a non-passive source.
    const { state, spell, chosen, donor } = mutationState(2, 7);
    const after = mutate(state, spell, chosen, donor);

    const donorShrunk = giveMightThisTurn(after, donor.instanceId, -5); // 7 -> 2

    expect(mightOf(donorShrunk, chosen.instanceId)).toBe(7);
  });

  it("reaches a friendly unit in base on either side (scope: anywhere)", () => {
    const chosen = makeUnit({ might: 1 });
    const donor = makeUnit({ might: 6 });
    const spell = card(CONVERGENT_MUTATION);
    const state = makeState({
      players: [makePlayer("p1", { hand: [spell], channeled: mindRunes(4), baseUnits: [chosen] }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p1: [donor] };

    const after = mutate(state, spell, chosen, donor);

    expect(mightOf(after, chosen.instanceId)).toBe(6);
  });

  it("KNOWN GAP: enumeration offers only ONE of the two orderings", () => {
    // Pinned, not asserted as desirable. legal-actions.ts collapses a two-slot
    // spec whose roles are equal (`symmetric = slots[0] === slots[1]`) and keeps
    // one ordering of each pair — correct for Back to Back and Singularity,
    // where both units get the same thing, and wrong here, where slot 0 is the
    // beneficiary and slot 1 is only measured.
    //
    // The consequence is concrete: with a 7-Might and a 2-Might friendly unit,
    // the only ordering on offer is whichever the scan reaches first, so half
    // the time the only legal cast is the one that increases by 0. Fixing it
    // needs an `asymmetricSlots` opt-out in legal-actions.ts, which this agent
    // does not own.
    //
    // If this test starts failing with a count of 2, the gap has been fixed and
    // this test should be replaced with one asserting BOTH orderings resolve.
    const { state, chosen, donor } = mutationState(7, 2);
    const pairs = legalActions(state).filter(
      (a) => a.type === "PlayCard" && a.card.defId === CONVERGENT_MUTATION && a.secondTargetUnitInstanceId !== undefined,
    );

    // Both orderings are individually legal — the validator accepts either.
    expect(pairs.length).toBeGreaterThan(0); // gate: the card IS enumerated at all
    const orderings = new Set(
      pairs.map((a) => (a.type === "PlayCard" ? `${a.targetUnitInstanceId}->${a.secondTargetUnitInstanceId}` : "")),
    );
    expect(orderings).toEqual(new Set([`${chosen.instanceId}->${donor.instanceId}`]));
    expect(orderings.has(`${donor.instanceId}->${chosen.instanceId}`)).toBe(false);
  });
});

describe("Pit Crew (OGN-091): when you play a GEAR, ready me", () => {
  /** Pit Crew exhausted, a gear in hand, and runes to pay for it. */
  function pitCrewState(zone: "base" | "battlefield", handCard: CardInstance) {
    const pitCrew = { ...unitCard(PIT_CREW), exhausted: true };
    const state = makeState({
      players: [makePlayer("p1", { hand: [handCard], channeled: mindRunes(6) }), makePlayer("p2")],
    });
    if (zone === "base") state.players[0]!.baseUnits = [pitCrew];
    else state.battlefields[0]!.units = { p1: [pitCrew] };
    return { state, pitCrew };
  }

  const findPitCrew = (state: GameState): UnitInstance =>
    [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => bf.units.p1 ?? [])].find(
      (u) => u.defId === PIT_CREW,
    )!;

  it("readies through executePlayCard when you play a gear", () => {
    const gear = card(GARBAGE_GRABBER);
    const { state } = pitCrewState("base", gear);
    expect(findPitCrew(state).exhausted).toBe(true); // gate: it really started exhausted

    const after = play(state, 0, gear);

    expect(findPitCrew(after).exhausted).toBe(false);
  });

  it("readies a Pit Crew standing at a battlefield too", () => {
    // "Ready me" names no zone, and readyUnit reaches both — a battlefield-only
    // helper would have left the version of this card that matters inert.
    const gear = card(GARBAGE_GRABBER);
    const { state } = pitCrewState("battlefield", gear);

    const after = play(state, 0, gear);

    expect(findPitCrew(after).exhausted).toBe(false);
  });

  it("does NOT fire for a Unit or a Spell — only a gear", () => {
    const sentry = unitCard(WATCHFUL_SENTRY); // Unit, Mind, 2 Energy
    const { state } = pitCrewState("base", sentry);

    const after = play(state, 0, sentry);

    expect(findPitCrew(after).exhausted).toBe(true);
  });

  it("does NOT fire for the OPPONENT's gear", () => {
    // "When YOU play a gear" is the caster against the LISTENER's controller.
    const pitCrew = { ...unitCard(PIT_CREW), exhausted: true };
    const gear = card(GARBAGE_GRABBER);
    const state = makeState({
      activePlayerIndex: 1,
      players: [makePlayer("p1", { baseUnits: [pitCrew] }), makePlayer("p2", { hand: [gear], channeled: mindRunes(4) })],
    });

    const after = play(state, 1, gear);

    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });
});

describe("Watchful Sentry (OGN-096): [Deathknell] — Draw 1", () => {
  it("draws for the SENTRY'S owner when an opponent's spell kills it", () => {
    // The whole path: the opponent casts Falling Comet through executePlayCard,
    // two passes resolve it, the damage kills a 1-Might Sentry, and the funnel
    // fires the Deathknell for the DYING unit's controller.
    const sentry = unitCard(WATCHFUL_SENTRY);
    const state = makeState({
      activePlayerIndex: 1,
      chainPriority: 1,
      players: [
        makePlayer("p1", { deck: [card("OGN-114"), card("OGN-114")] }),
        makePlayer("p2", { hand: [card(FALLING_COMET)], channeled: mindRunes(5) }),
      ],
    });
    state.battlefields[0]!.units = { p1: [sentry] };
    const handBefore = state.players[0]!.hand.length;

    const after = cast(state, 1, state.players[1]!.hand[0]!, { targetUnitInstanceId: sentry.instanceId });

    expect(after.players[0]!.trash.map((c) => c.defId)).toContain(WATCHFUL_SENTRY); // it really died
    expect(after.players[0]!.hand).toHaveLength(handBefore + 1);
    expect(after.players[0]!.deck).toHaveLength(1);
    expect(after.players[1]!.hand).toHaveLength(0); // the killer draws nothing
  });
});

describe("Sprite Mother (OGN-106): play a ready 3-Might [Temporary] Sprite here", () => {
  function motherState(): { state: GameState; mother: UnitInstance } {
    const mother = unitCard(SPRITE_MOTHER); // 4 Energy + 1 Mind Power
    const state = makeState({
      players: [makePlayer("p1", { hand: [mother], channeled: mindRunes(6) }), makePlayer("p2")],
    });
    return { state, mother };
  }

  it("makes the token in your base when she is played to base", () => {
    const { state, mother } = motherState();

    const after = play(state, 0, mother);

    const tokens = after.players[0]!.baseUnits.filter((u) => u.isToken);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe("Sprite");
    expect(tokens[0]!.might).toBe(3);
    expect(tokens[0]!.exhausted).toBe(false); // "a READY ... token" overrides 143.4.a
    expect(tokens[0]!.keywords.Temporary).toBe(1);
    // She is there too, and she is NOT a token.
    expect(after.players[0]!.baseUnits.filter((u) => u.defId === SPRITE_MOTHER)).toHaveLength(1);
  });

  it("makes the token AT THE BATTLEFIELD she reinforced — 'here', not base", () => {
    const { state, mother } = motherState();
    state.battlefields[0]!.units = { p1: [makeUnit()] }; // presence, so a reinforce play is legal

    const after = play(state, 0, mother, { destinationBattlefieldId: "bf1" });

    const there = unitAt(after, "bf1", "p1");
    expect(there.filter((u) => u.isToken)).toHaveLength(1);
    expect(there.find((u) => u.isToken)!.might).toBe(3);
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(0); // not at home
  });
});
