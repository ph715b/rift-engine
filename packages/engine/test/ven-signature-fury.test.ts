import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardMayMoveToBase, cardModeOf, cardMovesTarget, cardPlacesTokens } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { abilitiesAvailableTo } from "../src/engine/activated-abilities.js";
import { DOMINUS_READY, SHADOW_CLONE_TOKEN_DEF_ID } from "../src/engine/constants.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { replacedCostFor } from "../src/engine/replaced-costs.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's dual-domain spell block, wave 1 — the three whose first domain in
 * canonical order is Fury.**
 *
 * Almost none of this wave is new machinery, and that is the finding rather than
 * a disappointment: `[Flow]` is read off the printed cost pool-wide, the Shadow
 * Clone is already shared out of `token.ts` because Zed mints the same one, and a
 * moving spell already has a destination axis. Death Mark is three lines and two
 * table rows.
 *
 * What each of the other two DID need is a distinction that looks like a detail
 * and is not:
 *
 *   - **Shuriken Flip's slot ORDER is the reverse of its printed sentence
 *     order**, and is forced twice over — once because `min: 1` means "slot 0 is
 *     required", and this card's optional half is the FIRST thing it prints;
 *     once because `withDestinations` finds the unit being moved under
 *     `targetUnitInstanceId`. Get it wrong and the enumerator fans destinations
 *     around the wrong unit while every test that only checks damage passes.
 *   - **Dominus grants an ACTIVATED ability**, which is a third kind of this-turn
 *     grant beside keywords and triggers, and the only one that has to reach the
 *     ACTION ENUMERATOR. A granted ability nothing offers is invisible: the card
 *     reports implemented, the Might doubles, and the second half is inert.
 */

const registry = defaultCardRegistry();

const SHURIKEN_FLIP = "VEN-140";
const DOMINUS = "VEN-142";
const DEATH_MARK = "VEN-144";

/** A plain Fury unit and a real spell, for hands and decks. */
const A_UNIT = "OGN-003";
const A_SPELL = "OGN-004";

const runes = (n: number, domain = "Fury"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" }) as RuneCard);

const resolveSpell = (state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}) =>
  cardModeOf(spellInstance(defId), undefined)!.resolve(state, contextFor(casterIndex, "src"), event as never);

describe("all three report implemented — the premise", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [SHURIKEN_FLIP, DOMINUS, DEATH_MARK]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });
});

describe("Shuriken Flip (VEN-140): the slot order is the reverse of the sentence", () => {
  /** A friendly at bf1 and an enemy at bf2, so a move and a shot are both real. */
  function board(): { state: GameState; friendly: string; enemy: string } {
    const state = makeState();
    const friendly = makeUnit({ might: 4 });
    const enemy = makeUnit({ might: 4 });
    state.battlefields[0]!.units = { p1: [friendly] };
    state.battlefields[1]!.units = { p2: [enemy] };
    state.players[0]!.channeled = runes(6);
    return { state, friendly: friendly.instanceId, enemy: enemy.instanceId };
  }

  it("deals 2 to the enemy in the SECOND slot and moves the friendly in the FIRST", () => {
    const { state, friendly, enemy } = board();
    const after = resolveSpell(state, SHURIKEN_FLIP, 0, {
      targetUnitInstanceId: friendly,
      secondTargetUnitInstanceId: enemy,
      destinationBattlefieldId: "bf2",
    });

    expect(after.battlefields[1]!.units.p2![0]!.damage, "the enemy took no damage").toBe(2);
    // The MOVER is slot 0. Asserted by where it ended up rather than by reading a
    // field, because the failure this pins is the two slots being swapped — which
    // would damage the friendly and try to move the enemy, and a test that only
    // counted damage on "the target" would pass either way round.
    expect(after.battlefields[1]!.units.p1?.map((u) => u.instanceId), "the friendly did not arrive").toEqual([friendly]);
    expect(after.battlefields[0]!.units.p1 ?? [], "the friendly is still at its old battlefield").toEqual([]);
  });

  it("...and the enemy is UNTOUCHED when the friendly is the only choice made", () => {
    // "Up to one enemy unit" — the optional half is the FIRST thing printed, and
    // `min: 1` puts the optional slot second. This is the variant that proves it.
    const { state, friendly, enemy } = board();
    const after = resolveSpell(state, SHURIKEN_FLIP, 0, {
      targetUnitInstanceId: friendly,
      destinationBattlefieldId: "bf2",
    });

    expect(after.battlefields[1]!.units.p2![0]!.damage, "damage landed with no enemy chosen").toBe(0);
    expect(after.battlefields[1]!.units.p1?.map((u) => u.instanceId), "the move did not happen").toEqual([friendly]);
    expect(enemy).toBeDefined();
  });

  it("offers the damage-free variant AND the pair, and never a damage-only one", () => {
    // The enumerator's half of the same fact. `min: 1` must produce variants that
    // ALL name a friendly to move — a variant with only the enemy filled would be
    // the card doing its optional half and skipping its mandatory one.
    const { state, friendly } = board();
    state.players[0]!.hand = [spellInstance(SHURIKEN_FLIP)];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === SHURIKEN_FLIP);
    expect(plays.length, "the spell was not playable at all").toBeGreaterThan(0);
    for (const play of plays) {
      expect(play.type === "PlayCard" && play.targetUnitInstanceId, "a variant left the mandatory move unfilled").toBe(
        friendly,
      );
    }
    expect(
      plays.some((p) => p.type === "PlayCard" && p.secondTargetUnitInstanceId === undefined),
      "no variant declined the optional damage",
    ).toBe(true);
    expect(
      plays.some((p) => p.type === "PlayCard" && p.secondTargetUnitInstanceId !== undefined),
      "no variant took the optional damage",
    ).toBe(true);
  });

  it("is UNCASTABLE with no friendly unit — 355.8, not a resolver check", () => {
    // The move prints no "up to", so it is a required target, and a spell whose
    // targets cannot be validly chosen cannot be put on the chain. The damage half
    // does not rescue it: an enemy standing there is not enough.
    const state = makeState();
    state.battlefields[1]!.units = { p2: [makeUnit({ might: 4 })] };
    state.players[0]!.channeled = runes(6);
    state.players[0]!.hand = [spellInstance(SHURIKEN_FLIP)];

    expect(
      legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === SHURIKEN_FLIP),
      "castable with nothing to move",
    ).toEqual([]);
  });

  it("...but castable with NO enemy at a battlefield, for the move alone", () => {
    // The other direction, and it is the one that makes the "up to" real. Without
    // this the two facts are indistinguishable from "both targets required".
    const state = makeState();
    const friendly = makeUnit({ might: 4 });
    state.players[0]!.baseUnits = [friendly];
    state.players[0]!.channeled = runes(6);
    state.players[0]!.hand = [spellInstance(SHURIKEN_FLIP)];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === SHURIKEN_FLIP);
    expect(plays.length, "an empty enemy board made the spell uncastable").toBeGreaterThan(0);
    expect(
      plays.every((p) => p.type === "PlayCard" && p.secondTargetUnitInstanceId === undefined),
      "an enemy was named with none on the board",
    ).toBe(true);
  });

  it("scopes the two slots differently — the enemy must be AT A BATTLEFIELD", () => {
    // 355.9.b, the NARROWING half: the printed "at a battlefield" binds on the
    // enemy and is absent on the friendly. An enemy sitting in their base is not a
    // legal shot, and the friendly you most want to send is the one at home.
    const state = makeState();
    const friendly = makeUnit({ might: 4 });
    const enemyInBase = makeUnit({ might: 4 });
    state.players[0]!.baseUnits = [friendly];
    state.players[1]!.baseUnits = [enemyInBase];
    state.players[0]!.channeled = runes(6);
    state.players[0]!.hand = [spellInstance(SHURIKEN_FLIP)];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === SHURIKEN_FLIP);
    expect(plays.length, "the friendly in BASE was not offered as the mover").toBeGreaterThan(0);
    expect(
      plays.some((p) => p.type === "PlayCard" && p.secondTargetUnitInstanceId === enemyInBase.instanceId),
      "an enemy in their BASE was offered as a damage target",
    ).toBe(false);
  });

  it("may send the friendly to BASE — 355.4.a and 198.1", () => {
    expect(cardMayMoveToBase(SHURIKEN_FLIP), "base was excluded as a destination").toBe(true);
    expect(cardMovesTarget(SHURIKEN_FLIP), "the destination axis is not declared at all").toBe(true);

    const { state, friendly } = board();
    const after = resolveSpell(state, SHURIKEN_FLIP, 0, { targetUnitInstanceId: friendly, destinationIsBase: true });
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "it did not reach base").toEqual([friendly]);
  });

  it("does as much as it can when the shot kills something that was about to move", () => {
    // 359.3.e.11. The damage resolves first, so a Deathknell firing off it can
    // remove the friendly before the move — and the card must not throw. Modelled
    // directly by naming a mover that is no longer on the board.
    const { state, enemy } = board();
    const after = resolveSpell(state, SHURIKEN_FLIP, 0, {
      targetUnitInstanceId: "a-unit-that-left-play",
      secondTargetUnitInstanceId: enemy,
      destinationBattlefieldId: "bf1",
    });
    expect(after.battlefields[1]!.units.p2![0]!.damage, "the damage half was lost with the move").toBe(2);
  });
});

describe("Dominus (VEN-142): doubling, and the pool's first granted ACTIVATED ability", () => {
  function board(might: number): { state: GameState; unitId: string } {
    const state = makeState();
    const unit = makeUnit({ might });
    state.battlefields[0]!.units = { p1: [unit] };
    state.players[0]!.channeled = runes(6);
    return { state, unitId: unit.instanceId };
  }

  it("doubles the unit's CURRENT Might, not its printed one", () => {
    // 143.2 is "current Might", so a unit already pumped this turn doubles the
    // pumped figure. A printed-Might read would double 4 and give 8 here, which is
    // the mutant this asserts against.
    const { state, unitId } = board(4);
    const pumped = giveMightThisTurn(state, unitId, 2); // 4 -> 6
    const after = resolveSpell(pumped, DOMINUS, 0, { targetUnitInstanceId: unitId });

    const unit = after.battlefields[0]!.units.p1![0]!;
    expect(
      effectiveMight(after, unit, 0, { isCombat: false, battlefieldId: "bf1" }),
      "it doubled the printed Might rather than the current one",
    ).toBe(12);
  });

  it("is a FIXED amount — a later pump is not re-doubled (432.1.a)", () => {
    const { state, unitId } = board(4);
    const doubled = resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId });
    const later = giveMightThisTurn(doubled, unitId, 3);

    const unit = later.battlefields[0]!.units.p1![0]!;
    // 4 doubled to 8, then +3. A continuous "×2" would give 14.
    expect(effectiveMight(later, unit, 0, { isCombat: false, battlefieldId: "bf1" }), "the doubling stayed live").toBe(11);
  });

  it("doubles a 0-Might unit to 0 rather than below it (143.2.b)", () => {
    // The pin for a floor that is enforced somewhere else. `effectiveMight` ends
    // in `Math.max(0, m)`, so a shrunk unit reads as 0 and doubling adds 0 — a
    // second floor in this card's resolver is dead code, which a mutant proved by
    // SURVIVING its removal. This assertion is what makes the behaviour a fact of
    // the card rather than an accident of the helper.
    const { state, unitId } = board(0);
    const shrunk = giveMightThisTurn(state, unitId, -3);
    const after = resolveSpell(shrunk, DOMINUS, 0, { targetUnitInstanceId: unitId });

    const unit = after.battlefields[0]!.units.p1![0]!;
    expect(unit.mightThisTurn, "a negative Might was doubled into a further penalty").toBe(-3);
    expect(
      effectiveMight(after, unit, 0, { isCombat: false, battlefieldId: "bf1" }),
      "the doubling pushed it below zero",
    ).toBe(0);
  });

  it("grants the ability, and the ACTION ENUMERATOR offers it", () => {
    // The half that is invisible if only the resolver is tested: the card reports
    // implemented and the Might doubles whether or not anything can ever be
    // activated. This is the assertion that the grant reached the funnel.
    const { state, unitId } = board(4);
    const after = resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId });

    const unit = after.battlefields[0]!.units.p1![0]!;
    expect(unit.grantedAbilitiesThisTurn, "nothing was granted").toEqual([DOMINUS_READY]);
    expect(
      abilitiesAvailableTo(after, 0, unit).map((a) => a.abilityDefId),
      "the funnel does not offer it",
    ).toContain(DOMINUS_READY);

    const activations = legalActions(after).filter(
      (a) => a.type === "ActivateAbility" && a.viaAbilityDefId === DOMINUS_READY,
    );
    expect(activations.length, "the enumerator never offered the granted ability").toBeGreaterThan(0);
  });

  it("...and using it READIES the unit, for two rainbow Power", () => {
    const { state, unitId } = board(4);
    state.battlefields[0]!.units.p1![0]!.exhausted = true;
    const after = resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId });

    const activation = legalActions(after).find(
      (a) => a.type === "ActivateAbility" && a.viaAbilityDefId === DOMINUS_READY,
    );
    expect(activation, "the granted ability was not offered on an exhausted unit").toBeDefined();

    const used = submit(after, activation!).state;
    expect(used.battlefields[0]!.units.p1![0]!.exhausted, "it did not ready").toBe(false);
    // Two rainbow pips, recycled from the channeled pool (416) — six runes in,
    // four left.
    expect(used.players[0]!.channeled.length, "the Power was not paid").toBe(4);
  });

  it("has NO exhaust, so it can be used again while the Power lasts", () => {
    const { state, unitId } = board(4);
    state.battlefields[0]!.units.p1![0]!.exhausted = true;
    const granted = resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId });

    const first = legalActions(granted).find((a) => a.type === "ActivateAbility" && a.viaAbilityDefId === DOMINUS_READY);
    const once = submit(granted, first!).state;
    // Exhaust it again by hand — the ability itself does not exhaust anything, so
    // the only thing that could stop a second use is a cost that was never
    // printed.
    once.battlefields[0]!.units.p1![0]!.exhausted = true;
    const again = legalActions(once).find((a) => a.type === "ActivateAbility" && a.viaAbilityDefId === DOMINUS_READY);
    expect(again, "a second use was refused, so an exhaust crept into the cost").toBeDefined();
  });

  it("grants ONCE even from two casts — a duplicate would be a phantom action", () => {
    const { state, unitId } = board(4);
    const twice = resolveSpell(resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId }), DOMINUS, 0, {
      targetUnitInstanceId: unitId,
    });
    expect(twice.battlefields[0]!.units.p1![0]!.grantedAbilitiesThisTurn, "the grant stacked").toEqual([DOMINUS_READY]);
  });

  it("expires at end of turn", () => {
    const { state, unitId } = board(4);
    const after = runEnd(resolveSpell(state, DOMINUS, 0, { targetUnitInstanceId: unitId }));
    const unit =
      after.battlefields[0]!.units.p1?.[0] ?? after.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!;
    expect(unit.grantedAbilitiesThisTurn, "a this-turn grant survived the turn").toBeUndefined();
    expect(unit.mightThisTurn, "the doubling survived the turn").toBe(0);
  });

  it("may name an ENEMY unit, and one in a base", () => {
    // No owner word and no "at a battlefield" is printed — 355.9.a.1 widens the
    // bare noun to the Board, and 198.1 puts the Bases on it. Offered even though
    // doubling an enemy is rarely what you want: withholding a legal play is the
    // one direction this engine does not take.
    const state = makeState();
    const enemy = makeUnit({ might: 4 });
    state.players[1]!.baseUnits = [enemy];
    state.players[0]!.channeled = runes(6);
    state.players[0]!.hand = [spellInstance(DOMINUS)];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === DOMINUS);
    expect(
      plays.some((p) => p.type === "PlayCard" && p.targetUnitInstanceId === enemy.instanceId),
      "an enemy unit in base was not offered",
    ).toBe(true);
  });
});

describe("Death Mark (VEN-144): two built halves, and the trash they share", () => {
  function board(): GameState {
    const state = makeState();
    state.players[0]!.channeled = runes(6);
    state.players[0]!.deck = [spellInstance(A_SPELL), realUnitInstance(A_UNIT), spellInstance(A_SPELL)];
    return state;
  }

  it("burns 3 into the trash and plays the Shadow Clone", () => {
    const after = resolveSpell(board(), DEATH_MARK, 0, {});

    expect(after.players[0]!.trash.length, "the burn did not put 3 cards in the trash").toBe(3);
    expect(after.players[0]!.deck.length, "the burn did not come off the deck").toBe(0);

    const clone = after.players[0]!.baseUnits.find((u) => u.defId === SHADOW_CLONE_TOKEN_DEF_ID);
    expect(clone, "no Shadow Clone was played").toBeDefined();
    // The SHARED spec, not a second copy of the stat line — Zed mints the same
    // token from another file, and a drifted Might is invisible until someone
    // counts it.
    expect(clone!.might, "the Clone is not 0 Might").toBe(0);
    expect(clone!.isToken).toBe(true);
  });

  it("puts the burned cards in the TRASH, which is what arms the Clone", () => {
    // Rule 440 sends them to the trash, and the Clone's own ability banishes a
    // unit FROM YOUR TRASH — so a Death Mark cast off an empty trash still hands
    // the Clone something to spend. That is the composition worth pinning.
    //
    // **NOT an ordering assertion, deliberately.** The resolver burns before it
    // places the token because that is printed order, but nothing in `placeToken`
    // reads a trash, so swapping the two lines is unobservable in state and a
    // test claiming to catch it would be measuring nothing. Written in the card's
    // order so it stays right when something makes them disagree; asserted only
    // where the state can actually tell.
    const state = board();
    state.players[0]!.deck = [realUnitInstance(A_UNIT), realUnitInstance(A_UNIT), realUnitInstance(A_UNIT)];
    const after = resolveSpell(state, DEATH_MARK, 0, {});

    expect(
      after.players[0]!.trash.filter((c) => c.kind === "Unit").length,
      "the Clone has nothing in the trash to banish",
    ).toBe(3);
  });

  it("takes a chosen destination, unlike Zed's copy of the same token", () => {
    expect(cardPlacesTokens(DEATH_MARK), "the destination axis is not declared").toBe(true);

    const after = resolveSpell(board(), DEATH_MARK, 0, { destinationBattlefieldId: "bf2" });
    expect(
      after.battlefields[1]!.units.p1?.map((u) => u.defId),
      "the Clone did not go where it was sent",
    ).toEqual([SHADOW_CLONE_TOKEN_DEF_ID]);
  });

  it("carries a [Flow] cost read off the print, with no per-card wiring", () => {
    // 829 is pool-wide: `parseFlowCost` reads it from the printed text and
    // `replaced-costs.ts` grants the permission. Asserted here because this wave
    // adds three Flow spells and writes not one line for any of them.
    const card = spellInstance(DEATH_MARK);
    expect(card.flowCost, "the Flow cost was not parsed off the card").toBeDefined();
    expect(card.flowCost!.energy).toBe(1);

    const state = makeState();
    state.players[0]!.trash = [card];
    state.players[0]!.channeled = runes(6);
    expect(replacedCostFor(state, 0, card), "no replaced-cost play was offered from the trash").toBeDefined();
  });
});
