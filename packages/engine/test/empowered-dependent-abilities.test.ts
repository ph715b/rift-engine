import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { empowerPermanent, disempowerPermanent } from "../src/engine/effect-helpers.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
// The Deathknell registry has no exported per-card accessor, so the domain table
// it actually lives in is read directly — which also proves the entry is in the
// file that merges into the shared registry, not merely defined somewhere.
import { deathTriggers as orderDeathTriggers } from "../src/engine/effects/order.js";
import { decisions as bodyDecisions } from "../src/engine/effects/body.js";
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
const APPLIED_RESEARCHERS = "VEN-055"; // [Empowered][>] Your spells cost [1][rainbow] less, to a minimum of [1].
const NOXIAN_EMISSARY = "VEN-128"; // [Empowered][>][>>][Deathknell][>] Play two 1-Might Recruit tokens to your base.
const DAME_THE_DESPOILER = "VEN-079"; // [Empowered][>] When I attack or defend, choose a unit here...
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


/** Dame and companions standing at the first battlefield — hers on side 0, any
 *  extra named "enemy" on side 1, so the option list can be checked across both. */
function atBattlefield(dame: UnitInstance, ...others: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  const bf = state.battlefields[0]!;
  bf.id = "bf1";
  bf.units[state.players[0]!.id] = [dame, ...others.filter((u) => u.instanceId !== "enemy")];
  bf.units[state.players[1]!.id] = others.filter((u) => u.instanceId === "enemy");
  // CONTESTED by the opponent, so Dame is a DEFENDER. `isFightingAt` returns
  // false at an uncontested battlefield — there is neither an attacker nor a
  // defender to be — and a fixture without this makes her gate untestable rather
  // than passing it.
  bf.contestedByIndex = 1;
  return state;
}

/** A unit at bf1, whichever side it is on. */
function findAt(state: GameState, instanceId: string): UnitInstance {
  const bf = state.battlefields.find((b) => b.id === "bf1")!;
  for (const side of Object.values(bf.units)) {
    const found = (side ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  throw new Error(`no unit ${instanceId} at bf1`);
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

  it("Applied Researchers discounts your spells only while Empowered", () => {
    // Vex - Cheerless's friendly half with an Empowered condition. Asserted
    // through `modifiedEnergyCost`, the function all three cost sites ask, so
    // this measures the price a play is actually charged rather than a helper.
    const spellCost = 4;
    const plain = boardWith([unit(APPLIED_RESEARCHERS, "r1")]);
    expect(
      modifiedEnergyCost(plain, 0, "Spell", spellCost, "OGN-001", true),
      "an un-Empowered Researcher discounted a spell",
    ).toBe(spellCost);

    const empowered = empowerPermanent(plain, "r1");
    expect(
      modifiedEnergyCost(empowered, 0, "Spell", spellCost, "OGN-001", true),
      "an Empowered Researcher did not discount a spell",
    ).toBe(spellCost - 1);

    // "Your SPELLS" — a Unit is not discounted, which is the half a kind check
    // exists for and the half a careless implementation drops.
    expect(
      modifiedEnergyCost(empowered, 0, "Unit", spellCost, "OGN-001", true),
      "a UNIT was discounted by a spells-only clause",
    ).toBe(spellCost);
  });

  it("never raises a spell already priced below the printed floor", () => {
    // "To a minimum of [1]" cannot make a card MORE expensive. Vex's clamp is
    // written `max(min(cost, FLOOR), ...)` for exactly this, and reusing hers
    // rather than a plain `max(1, ...)` is what keeps a 0-cost spell at 0.
    const empowered = empowerPermanent(boardWith([unit(APPLIED_RESEARCHERS, "r1")]), "r1");
    expect(modifiedEnergyCost(empowered, 0, "Spell", 0, "OGN-001", true), "a free spell was raised to 1").toBe(0);
    // And the floor still holds from above: a 1-cost spell stays at 1.
    expect(modifiedEnergyCost(empowered, 0, "Spell", 1, "OGN-001", true), "the floor of 1 was breached").toBe(1);
  });

  it("Noxian Emissary's Deathknell fires only if he died Empowered", () => {
    // "(When I die while Empowered, get the effect.)" — the card's own reminder
    // text settles the condition, so nothing is inferred from the bracket stack.
    //
    // **Read off `death.unit`, not off the board**, and that is the whole trap:
    // by the time a Deathknell resolves its source is gone, so a board lookup
    // would answer `false` for every Emissary that ever died and the ability
    // would be permanently inert.
    const trigger = orderDeathTriggers[NOXIAN_EMISSARY];
    expect(trigger, "no Deathknell is registered for Noxian Emissary").toBeDefined();

    const corpse = unit(NOXIAN_EMISSARY, "e1");
    const plainDeath = { unit: corpse, ownerIndex: 0 as const };
    expect(trigger!.applies?.(makeState({}), plainDeath as never), "an un-Empowered Emissary made tokens").toBe(false);

    const empoweredDeath = { unit: { ...corpse, empowered: true as const }, ownerIndex: 0 as const };
    expect(
      trigger!.applies?.(makeState({}), empoweredDeath as never),
      "an Empowered Emissary's Deathknell did not fire",
    ).toBe(true);
  });

  it("plays TWO Recruit tokens into base, as two game objects", () => {
    // 185.1 — each token is its own game object, which is why this is two
    // placements rather than one with a count. Machine Evangel's three take the
    // same shape.
    const state = boardWith([]);
    const trigger = orderDeathTriggers[NOXIAN_EMISSARY]!;
    const after = trigger.resolve!(state, { casterIndex: 0 } as never, undefined as never);
    const made = after.players[0]!.baseUnits;
    expect(made, "two Recruit tokens were not played").toHaveLength(2);
    expect(new Set(made.map((u) => u.instanceId)).size, "the two tokens share an instanceId").toBe(2);
    for (const token of made) expect(token.might, "a Recruit is a 1-Might token").toBe(1);
  });

  it("Dame's trigger does not fire un-Empowered (828.1.c)", () => {
    // **This test exists because MUTATION TESTING found it missing.** Deleting
    // the `isEmpowered` gate from her `applies` left all of Dame's other tests
    // green — they drive the DECISION, which is downstream of the trigger — so
    // the clause that makes her ability dependent at all was unasserted. Every
    // other card in this file has the same assertion; hers was the one that did
    // not, which is the shape a whole file of green tests can hide.
    const dame = unit(DAME_THE_DESPOILER, "d1");
    const state = atBattlefield(dame, unit(PLAIN_UNIT, "ally"));
    const trigger = eventTriggerFor(DAME_THE_DESPOILER);
    expect(trigger, "no attack-or-defend trigger is registered for Dame").toBeDefined();

    const listener = { card: findAt(state, "d1"), ownerIndex: 0 as const, battlefieldId: "bf1" };
    const event = { kind: "combatBegan" as const, battlefieldId: "bf1", designated: ["d1", "ally"] };

    expect(trigger!.applies?.(state, listener as never, event as never), "an un-Empowered Dame triggered").toBe(false);

    const empowered = empowerPermanent(state, "d1");
    const live = { ...listener, card: findAt(empowered, "d1") };
    expect(
      trigger!.applies?.(empowered, live as never, event as never),
      "an Empowered Dame did not gain her attack-or-defend trigger",
    ).toBe(true);
  });

  it("Dame the Despoiler matches the chosen unit's Might, then adds 1", () => {
    // "Increase my Might to its Might this turn, then give me +1 Might this
    // turn." The match is a CLAMPED DELTA in rule 477's Arithmetic layer, not an
    // assignment — Convergent Mutation's entry settles the identical sentence —
    // so it stacks rather than wipes, and the +1 lands on top.
    const dame = { ...unit(DAME_THE_DESPOILER, "d1"), might: 3 } as UnitInstance;
    const bigger = { ...unit(PLAIN_UNIT, "big"), might: 7 } as UnitInstance;
    const state = atBattlefield(dame, bigger);
    const decision = bodyDecisions["VEN-079-match"]!;
    const after = decision.resolve(state, { playerIndex: 0, cardInstanceId: "d1", battlefieldId: "bf1" } as never, "big");

    const dameAfter = findAt(after, "d1");
    expect(effectiveMight(after, dameAfter, 0, { isCombat: false }), "3 matched to 7, then +1").toBe(8);
  });

  it("never SHRINKS her — naming a smaller unit is a legal no-op plus the 1", () => {
    // The clamp is the rules' own: "Players cannot increase a numeric attribute
    // by a negative amount... they increase it by 0 instead." Naming herself is
    // the degenerate case of the same thing.
    const dame = { ...unit(DAME_THE_DESPOILER, "d1"), might: 6 } as UnitInstance;
    const smaller = { ...unit(PLAIN_UNIT, "small"), might: 2 } as UnitInstance;
    const state = atBattlefield(dame, smaller);
    const decision = bodyDecisions["VEN-079-match"]!;

    const afterSmall = decision.resolve(state, { playerIndex: 0, cardInstanceId: "d1", battlefieldId: "bf1" } as never, "small");
    expect(effectiveMight(afterSmall, findAt(afterSmall, "d1"), 0, { isCombat: false }), "she shrank to a smaller unit").toBe(7);

    const afterSelf = decision.resolve(state, { playerIndex: 0, cardInstanceId: "d1", battlefieldId: "bf1" } as never, "d1");
    expect(effectiveMight(afterSelf, findAt(afterSelf, "d1"), 0, { isCombat: false }), "naming herself is +1 and nothing else").toBe(7);
  });

  it("offers every unit at the battlefield, both sides and herself included", () => {
    // "A unit" with no "friendly", "enemy" or "other" — and a missing "other" is
    // INCLUSIVE, the reading Sett - Kingpin and Rumble - Scrapper already take.
    const dame = unit(DAME_THE_DESPOILER, "d1");
    const state = atBattlefield(dame, unit(PLAIN_UNIT, "ally"), unit(PLAIN_UNIT, "enemy"));
    const ids = bodyDecisions["VEN-079-match"]!
      .options(state, { playerIndex: 0, cardInstanceId: "d1", battlefieldId: "bf1" } as never)
      .map((o) => o.id);
    expect(new Set(ids), "the option list is not every unit here").toEqual(new Set(["d1", "ally", "enemy"]));
  });

  it("claims all six cards for coverage", () => {
    // The Lucian - Purifier trap: a card can work in play and report
    // UNIMPLEMENTED because no module claims it, which also drops it from
    // generated decks and hides it from `reachability`.
    for (const defId of [NASUS_ASCENDED, COVERT_INFORMANT, AUROK_GENERAL, APPLIED_RESEARCHERS, NOXIAN_EMISSARY, DAME_THE_DESPOILER]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} works but no module claims it`).toBe(true);
    }
  });
});
