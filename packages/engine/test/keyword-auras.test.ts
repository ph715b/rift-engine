import { describe, expect, it } from "vitest";
import { deflectSurcharge, effectiveKeywords, hasKeyword } from "../src/engine/granted-keywords.js";
import { dispatchOnPlayUnit, unitTriggerHasVisionChoice } from "../src/engine/unit-triggers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { addBuff, spendBuff } from "../src/engine/effect-helpers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, playUnitTrigger } from "./fixtures.js";

/**
 * Keyword auras — a keyword granted to OTHER permanents by a source card.
 *
 * Structurally unlike everything else in `granted-keywords.ts`, which is keyed by
 * the RECEIVING unit's own defId because every entry there is a card talking
 * about itself. An aura is keyed by its SOURCE and looked up from the other end.
 *
 * The rules put this in layer 2, "Ability-Altering Effects" (477), identified by
 * the words "have"/"has" — and their own worked example is one of these very
 * sentences: *"A permanent has the ability 'Other friendly units have [Vision].'
 * Other friendly units gain the Vision keyword in this layer."*
 *
 * Every assertion goes through `effectiveMight` or `deflectSurcharge` rather than
 * only `effectiveKeywords`, because the point of the shared layer is that a
 * granted keyword is indistinguishable from a printed one at the places that
 * actually consume it. A test that only reads the map would pass while combat
 * still ignored the grant.
 */

const registry = defaultCardRegistry();
const CAPTAIN_FARRON = "OGN-015"; // "Other friendly units here have [Assault]."
const TARIC_PROTECTOR = "OGN-074"; // "[Shield][Tank] Other friendly units here have [Shield]."
const SPIRITS_REFUGE = "OGN-063"; // "Friendly buffed units have [Deflect] if they didn't already."
const GEMCRAFT_SEER = "OGN-100"; // "[Vision] Other friendly units have [Vision]."

const unit = (defId: string, instanceId?: string): UnitInstance => {
  const made = createCardInstance(registry.get(defId)) as UnitInstance;
  return instanceId ? { ...made, instanceId } : made;
};
const gear = (defId: string, instanceId = "g1"): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId }) as GearInstance;

/** `p1`'s board, with each entry placed where it is named. */
function board(at: { bf1?: UnitInstance[]; bf2?: UnitInstance[]; base?: UnitInstance[] }): GameState {
  const state = makeState({ phase: "Action" });
  if (at.bf1) state.battlefields[0]!.units = { p1: at.bf1 };
  if (at.bf2) state.battlefields[1]!.units = { p1: at.bf2 };
  if (at.base) state.players[0]!.baseUnits = at.base;
  return state;
}

/** The Might an ATTACKER actually swings with — where [Assault] lands. */
const attacking = (state: GameState, u: UnitInstance, battlefieldId: string) =>
  effectiveMight(state, u, 0, { isCombat: true, isAttackingSide: true, combatRole: "outgoing", battlefieldId });

/** The Might a DEFENDER can still absorb — where [Shield] lands. */
const defending = (state: GameState, u: UnitInstance, battlefieldId: string) =>
  effectiveMight(state, u, 0, { isCombat: true, isAttackingSide: false, combatRole: "remaining", battlefieldId });

describe("Captain Farron (OGN-015): other friendly units HERE have [Assault]", () => {
  it("gives a neighbour +1 while attacking, through effectiveMight", () => {
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const withFarron = board({ bf1: [unit(CAPTAIN_FARRON), ally] });
    const alone = board({ bf1: [ally] });

    expect(attacking(alone, ally, "bf1"), "control: no aura, no bonus").toBe(3);
    expect(attacking(withFarron, ally, "bf1")).toBe(4);
  });

  it("reaches only his OWN battlefield — 'here'", () => {
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const split = board({ bf1: [unit(CAPTAIN_FARRON)], bf2: [ally] });

    expect(hasKeyword(split, ally, 0, "Assault")).toBe(false);
    expect(attacking(split, ally, "bf2")).toBe(3);
  });

  it("reaches nobody while he stands in BASE — a base is not a battlefield", () => {
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const homebound = board({ base: [unit(CAPTAIN_FARRON), ally] });

    expect(hasKeyword(homebound, ally, 0, "Assault")).toBe(false);
  });

  it("does not grant to HIMSELF — 'other friendly units'", () => {
    const farron = unit(CAPTAIN_FARRON, "farron");
    const state = board({ bf1: [farron] });

    expect(hasKeyword(state, farron, 0, "Assault"), "granted himself an [Assault] he does not print").toBe(false);
  });

  it("never PRINTED [Assault] in the first place — the loader was reading his own grant", () => {
    // A live bug this file found: `parseKeywords` sees brackets and cannot tell a
    // card claiming a keyword from a card handing one out, so Farron shipped with
    // `{Assault: 1}` and swung +1 as an attacker on a card that says nothing of
    // the sort. Asserted at the DEFINITION rather than only through
    // `effectiveKeywords`, because the two failure modes are different: an aura
    // that wrongly excluded him would also make the test above pass.
    //
    // Third instance of this shape after HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS and
    // CONDITIONAL_KEYWORD_DEF_IDS; the strip is `GRANTED_ONLY_KEYWORDS`, and it is
    // per-keyword because Taric below prints AND grants the same one.
    const farronDef = registry.get(CAPTAIN_FARRON);
    expect(farronDef.type).toBe("Unit");
    expect(farronDef.type === "Unit" && farronDef.keywords).toEqual({});
  });

  it("does not reach the OPPONENT's units standing at the same battlefield", () => {
    const enemy = makeUnit({ instanceId: "enemy", might: 3 });
    const state = board({ bf1: [unit(CAPTAIN_FARRON)] });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [enemy] };

    expect(hasKeyword(state, enemy, 1, "Assault")).toBe(false);
  });

  it("finds a SECOND copy at another battlefield", () => {
    // `effective-might.ownUnitLocation` returns where the FIRST copy is, which
    // would miss this. Farron is an ordinary unit, three to a deck, so two of
    // them at two battlefields is an ordinary board rather than an edge case —
    // which is why the aura asks "is a source HERE" instead.
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const state = board({ bf1: [unit(CAPTAIN_FARRON, "farron-a")], bf2: [unit(CAPTAIN_FARRON, "farron-b"), ally] });

    expect(attacking(state, ally, "bf2")).toBe(4);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(CAPTAIN_FARRON))).toBe(true);
  });
});

describe("Taric - Protector (OGN-074): other friendly units here have [Shield]", () => {
  it("gives a neighbour +1 while DEFENDING, and nothing while attacking", () => {
    // [Shield] is purely defensive: it never contributes to outgoing damage,
    // whichever side the unit is on. That asymmetry is the whole difference
    // between his aura and Farron's, so it is asserted rather than assumed.
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const state = board({ bf1: [unit(TARIC_PROTECTOR), ally] });

    expect(defending(state, ally, "bf1")).toBe(4);
    expect(attacking(state, ally, "bf1"), "[Shield] leaked into outgoing damage").toBe(3);
  });

  it("keeps his OWN printed [Shield] and [Tank], and grants himself nothing extra", () => {
    const taric = unit(TARIC_PROTECTOR, "taric");
    const state = board({ bf1: [taric] });
    const keywords = effectiveKeywords(state, taric, 0);

    // Printed on the frame, so they must survive the aura fold rather than be
    // replaced by it.
    expect(keywords.Shield).toBe(1);
    expect(keywords.Tank).toBeDefined();
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(TARIC_PROTECTOR))).toBe(true);
  });
});

describe("Gemcraft Seer (OGN-100): other friendly units have [Vision]", () => {
  /** A card with no [Vision] of its own, and a deck to predict from. */
  function seerState(seerInPlay: boolean): { state: GameState; plain: UnitInstance } {
    const plain = makeUnit({ instanceId: "plain", name: "Plain" });
    const state = makeState({ phase: "Action" });
    if (seerInPlay) state.players[0]!.baseUnits = [unit(GEMCRAFT_SEER, "seer")];
    state.players[0]!.deck = [makeUnit({ instanceId: "top", name: "Top" }), makeUnit({ instanceId: "next", name: "Next" })];
    return { state, plain };
  }

  it("makes another unit's play need a recycle choice — and does not when she is absent", () => {
    // The question `legal-actions` fans out on and `validate-play-card` requires.
    // Both ask this one function, so they cannot drift.
    //
    // Daring Poro, a real card that prints no [Vision] — a synthetic defId would
    // pass the negative half for the wrong reason (the registry would not know it
    // at all) and the positive half would then be the only real assertion.
    const DARING_PORO = "OGN-210";
    const { state: withSeer } = seerState(true);
    const { state: without } = seerState(false);

    expect(unitTriggerHasVisionChoice(without, 0, DARING_PORO), "control: no aura, no choice").toBe(false);
    expect(unitTriggerHasVisionChoice(withSeer, 0, DARING_PORO)).toBe(true);
  });

  it("predicts when another friendly unit ENTERS — the trigger the rules name", () => {
    // Vision is "functionally short for 'When this is played, predict'", and the
    // trigger is *"the permanent entering the Board"*. That last clause is the
    // whole card: read as a "when you PLAY me" ability the grant would be inert,
    // because every unit already in play has had its play moment.
    const { state, plain } = seerState(true);
    const entered = { ...state, players: [{ ...state.players[0]!, baseUnits: [...state.players[0]!.baseUnits, plain] }, state.players[1]!] } as GameState;

    const predicted = playUnitTrigger(entered, plain, 0, "base", { visionRecycle: true });
    expect(predicted.players[0]!.deck.map((c) => c.instanceId), "the top card was not recycled").toEqual(["next", "top"]);
  });

  it("does NOT predict for a unit entering without her in play", () => {
    const { state, plain } = seerState(false);
    const entered = { ...state, players: [{ ...state.players[0]!, baseUnits: [plain] }, state.players[1]!] } as GameState;

    const after = playUnitTrigger(entered, plain, 0, "base", { visionRecycle: true });
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["top", "next"]);
  });

  it("does not predict for the OPPONENT's units", () => {
    const { state } = seerState(true);
    const enemy = makeUnit({ instanceId: "enemy" });
    const withEnemy = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, baseUnits: [enemy], deck: [makeUnit({ instanceId: "their-top" })] }],
    } as GameState;

    const after = playUnitTrigger(withEnemy, enemy, 1, "base", { visionRecycle: true });
    expect(after.players[1]!.deck.map((c) => c.instanceId)).toEqual(["their-top"]);
  });

  it("still predicts ONCE for a card that prints [Vision] herself", () => {
    // "Multiple instances of Vision trigger separately" — a Mystic Poro played
    // beside the Seer should predict TWICE. This engine's keyword map holds a
    // VALUE per keyword rather than a COUNT, so it predicts once. Recorded as a
    // divergence in docs/rules-conformance.md and asserted here so it is a known
    // number rather than an accident.
    const poro = { ...unit("OGN-171"), instanceId: "poro" };
    const { state } = seerState(true);
    const entered = { ...state, players: [{ ...state.players[0]!, baseUnits: [...state.players[0]!.baseUnits, poro] }, state.players[1]!] } as GameState;

    const after = playUnitTrigger(entered, poro, 0, "base", { visionRecycle: true });
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["next", "top"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(GEMCRAFT_SEER))).toBe(true);
  });
});

describe("Spirit's Refuge (OGN-063): a GEAR-source aura with a per-target condition", () => {
  /** The Refuge in play for p1, with `units` on bf1. */
  function withRefuge(units: UnitInstance[]): GameState {
    const state = board({ bf1: units });
    state.players[0]!.activeGear = [gear(SPIRITS_REFUGE)];
    return state;
  }

  it("taxes an opponent for choosing a BUFFED friendly unit", () => {
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const state = addBuff(withRefuge([ally]), "ally");
    const buffed = state.battlefields[0]!.units["p1"]![0]!;

    expect(deflectSurcharge(state, buffed, 0, 1), "the opponent pays no [Deflect] surcharge").toBe(1);
    // "OPPONENTS must pay" — the unit's own controller never does.
    expect(deflectSurcharge(state, buffed, 0, 0)).toBe(0);
  });

  it("grants NOTHING to an unbuffed unit, and stops the moment the buff is spent", () => {
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const unbuffed = withRefuge([ally]);
    expect(hasKeyword(unbuffed, unbuffed.battlefields[0]!.units["p1"]![0]!, 0, "Deflect")).toBe(false);

    const buffed = addBuff(unbuffed, "ally");
    expect(hasKeyword(buffed, buffed.battlefields[0]!.units["p1"]![0]!, 0, "Deflect")).toBe(true);

    // Recomputed on read, so there is nothing to expire — spending the buff takes
    // the keyword with it in the same breath.
    const spent = spendBuff(buffed, 0, "ally");
    expect(spent, "the buff was not spendable").toBeDefined();
    expect(hasKeyword(spent!, spent!.battlefields[0]!.units["p1"]![0]!, 0, "Deflect")).toBe(false);
  });

  it("reaches a buffed unit in BASE — its text names no battlefield", () => {
    // Unlike Farron and Taric. A Gear is never at a battlefield in this pool, so
    // a positional reading would make the card grant nothing at all.
    const ally = makeUnit({ instanceId: "ally", might: 3 });
    const state = board({ base: [ally] });
    state.players[0]!.activeGear = [gear(SPIRITS_REFUGE)];
    const buffed = addBuff(state, "ally");

    expect(hasKeyword(buffed, buffed.players[0]!.baseUnits[0]!, 0, "Deflect")).toBe(true);
  });

  it("does not CHANGE a printed [Deflect 2] — 'if they didn't already'", () => {
    // **This is now the pin on a printed EXCEPTION, not on a merge default.**
    // While every keyword source merged with `Math.max` the clause was free, and
    // the only direction worth guarding was downward: a grant that overwrote
    // would quietly halve Volibear - Furious's tax. 809.2 sums granted [Deflect]
    // Values, so the live danger is now the other way — without the aura's
    // `onlyIfAbsent` flag a Refuge on the board would RAISE this to 3, which is
    // the opposite of what the card prints.
    const tough = makeUnit({ instanceId: "tough", might: 3, buffed: true, keywords: { Deflect: 2 } });
    const state = withRefuge([tough]);

    expect(deflectSurcharge(state, state.battlefields[0]!.units["p1"]![0]!, 0, 1)).toBe(2);
  });

  it("does not reach an ENEMY buffed unit — 'FRIENDLY buffed units'", () => {
    const enemy = makeUnit({ instanceId: "enemy", might: 3, buffed: true });
    const state = withRefuge([]);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [enemy] };

    expect(hasKeyword(state, enemy, 1, "Deflect")).toBe(false);
  });

  it("is whole — it was the pool's last PARTIALLY_IMPLEMENTED entry", () => {
    expect(partialImplementationNote(registry.get(SPIRITS_REFUGE))).toBeUndefined();
    expect(isCardImplemented(registry.get(SPIRITS_REFUGE))).toBe(true);
  });
});
