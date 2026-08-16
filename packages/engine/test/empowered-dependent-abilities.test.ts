import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { empowerPermanent, disempowerPermanent } from "../src/engine/effect-helpers.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * `[Empowered][>]` clauses whose payload is NOT a static grant — 828's dependent
 * abilities in their other three shapes.
 *
 * `card-loader.parseEmpoweredGrant` reads the 18 clauses that are "I have +N
 * Might and/or [Keywords]" and refuses everything else, because a trigger, an
 * aura or an activated ability needs per-card code. These are the first three of
 * that remainder.
 *
 * **828.1.c is the assertion every one of them shares**: the dependent ability is
 * active "as long as the Game Object has the Empowered status", so each test
 * below checks the effect is ABSENT before the Empower and PRESENT after — and,
 * where the effect is continuous, absent again after a Disempower (442). A test
 * that only checked the empowered case would pass against an ability that was
 * always on, which is the direction that makes a card strictly better than
 * printed.
 *
 * The status is read off the SOURCE's own instance in all three, because 441.1.a
 * makes Empowered a property of the game object — two copies of one card can
 * disagree, so a player-level read would be wrong even where it looks equivalent.
 */

const registry = defaultCardRegistry();

const NASUS_ASCENDED = "VEN-046"; // [Empowered][>] When I conquer, you score 1 point.
const COVERT_INFORMANT = "VEN-057"; // [Empowered][>] When I move, draw 1.
const AUROK_GENERAL = "VEN-130"; // [Empowered][>] Your units that are [Empowered] have +2 Might (including me).
const PLAIN_UNIT = "OGN-164"; // a vanilla body, for the aura's negative control

const unit = (defId: string, instanceId: string): UnitInstance => ({
  ...(createCardInstance(registry.get(defId)) as UnitInstance),
  instanceId,
});

function boardWith(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = units;
  return state;
}

const mightOf = (state: GameState, instanceId: string): number => {
  const found = state.players[0]!.baseUnits.find((u) => u.instanceId === instanceId)!;
  return effectiveMight(state, found, 0, { isCombat: false });
};

describe("a dependent TRIGGER exists only while the source is Empowered (828.1.c)", () => {
  it("Nasus's conquer trigger does not apply un-Empowered, and does Empowered", () => {
    const plain = boardWith([unit(NASUS_ASCENDED, "n1")]);
    const trigger = eventTriggerFor(NASUS_ASCENDED);
    expect(trigger, "no conquer trigger is registered for Nasus").toBeDefined();

    const listener = {
      card: plain.players[0]!.baseUnits[0]!,
      ownerIndex: 0 as const,
      battlefieldId: plain.battlefields[0]!.id,
    };
    const event = {
      kind: "battlefieldConquered" as const,
      conquerorIndex: 0 as const,
      battlefieldId: plain.battlefields[0]!.id,
      wasUncontrolled: false,
    };

    expect(
      trigger!.applies?.(plain, listener as never, event as never),
      "an un-Empowered Nasus scored a second point",
    ).toBe(false);

    const empowered = empowerPermanent(plain, "n1");
    const liveListener = { ...listener, card: empowered.players[0]!.baseUnits[0]! };
    expect(
      trigger!.applies?.(empowered, liveListener as never, event as never),
      "an Empowered Nasus did not gain his conquer trigger",
    ).toBe(true);
  });

  it("Nasus's trigger scores a point ON TOP of the ordinary one", () => {
    // The point of the card: the battlefield he stands on is worth two. Asserted
    // as a delta on the resolver rather than through a whole conquest, so it
    // measures HIS point and not the one `recordConquest` already awarded.
    const state = empowerPermanent(boardWith([unit(NASUS_ASCENDED, "n1")]), "n1");
    const trigger = eventTriggerFor(NASUS_ASCENDED)!;
    const listener = { card: state.players[0]!.baseUnits[0]!, ownerIndex: 0 as const, battlefieldId: state.battlefields[0]!.id };
    const event = { kind: "battlefieldConquered" as const, conquerorIndex: 0 as const, battlefieldId: state.battlefields[0]!.id, wasUncontrolled: false };
    const after = trigger.resolve!(state, listener as never, event as never);
    expect(after.players[0]!.points - state.players[0]!.points, "Nasus's extra point was not scored").toBe(1);
  });

  it("Covert Informant draws only for HIS OWN move, and only while Empowered", () => {
    const plain = boardWith([unit(COVERT_INFORMANT, "i1"), unit(PLAIN_UNIT, "other")]);
    const trigger = eventTriggerFor(COVERT_INFORMANT);
    expect(trigger, "no move trigger is registered for Covert Informant").toBeDefined();
    const listener = { card: plain.players[0]!.baseUnits[0]!, ownerIndex: 0 as const, battlefieldId: undefined };
    const moved = (id: string) => ({ kind: "unitMoved" as const, moverIndex: 0 as const, unitInstanceId: id, from: "base", to: "bf1", movesThisTurn: 1 });

    expect(trigger!.applies?.(plain, listener as never, moved("i1") as never), "an un-Empowered Informant drew").toBe(false);

    const empowered = empowerPermanent(plain, "i1");
    const live = { ...listener, card: empowered.players[0]!.baseUnits[0]! };
    expect(trigger!.applies?.(empowered, live as never, moved("i1") as never), "an Empowered Informant did not draw on his own move").toBe(true);
    // "When **I** move" — another unit walking is not his trigger.
    expect(trigger!.applies?.(empowered, live as never, moved("other") as never), "the Informant drew for someone else's move").toBe(false);
  });
});

describe("Aurok General's aura is gated on HIS status and filters on the receiver's", () => {
  it("pumps an Empowered unit only while the General is Empowered too", () => {
    const state = boardWith([unit(AUROK_GENERAL, "g1"), unit(PLAIN_UNIT, "ally")]);
    const bonus = 2;

    // Neither Empowered: no aura at all.
    const base = mightOf(state, "ally");

    // The RECEIVER Empowered but not the General — the aura does not exist yet
    // (828.1.c), so this must not pump.
    const receiverOnly = empowerPermanent(state, "ally");
    expect(mightOf(receiverOnly, "ally"), "the aura ran without its source being Empowered").toBe(base);

    // The GENERAL Empowered but not the receiver — the aura exists and the
    // receiver fails its filter.
    const generalOnly = empowerPermanent(state, "g1");
    expect(mightOf(generalOnly, "ally"), "an un-Empowered unit was pumped").toBe(base);

    // Both: the aura exists and the receiver matches.
    const both = empowerPermanent(receiverOnly, "g1");
    expect(mightOf(both, "ally") - base, "the aura did not pump an Empowered unit").toBe(bonus);

    // 828.1.c is "as long as" — Disempowering the SOURCE takes the aura away
    // from a receiver who is still Empowered.
    const off = disempowerPermanent(both, "g1");
    expect(mightOf(off, "ally"), "the aura outlived its source's status").toBe(base);
  });

  it("includes the General himself, whose text says so in parentheses", () => {
    // "(including me)" — the absence of the "other" every exclusive aura prints.
    // He satisfies his own filter by construction, since the aura only exists
    // while he is Empowered.
    const state = boardWith([unit(AUROK_GENERAL, "g1")]);
    const before = mightOf(state, "g1");
    const empowered = empowerPermanent(state, "g1");
    expect(mightOf(empowered, "g1") - before, "the General did not pump himself").toBe(2);
  });

  it("claims all three cards for coverage", () => {
    // The Lucian - Purifier trap: a card can work in play and report
    // UNIMPLEMENTED because no module claims it, which also drops it from
    // generated decks and hides it from `reachability`.
    for (const defId of [NASUS_ASCENDED, COVERT_INFORMANT, AUROK_GENERAL]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} works but no module claims it`).toBe(true);
    }
  });
});
