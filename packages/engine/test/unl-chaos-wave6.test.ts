import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { findUnitAnywhere } from "../src/engine/target-lookup.js";
import type { GameState } from "../src/model/game-state.js";
import type { CardInstance, GearInstance, UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  pickCard,
  realGearInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Unleashed wave 6, effects/chaos.ts — Heedless Resurrection (UNL-142) and
 * Cursed Sarcophagus (UNL-148).
 *
 * Everything here drives the REAL path: `legalActions` to find the action,
 * `submit` to take it, the chain passed out, the held triggers settled and the
 * parked questions answered. A resolver called directly proves only that the
 * resolver compiles, and this codebase has repeatedly shipped cards that were
 * written, typechecked and unreachable in the same commit.
 *
 * **One thing here is deliberately asserted WRONG, and it is labelled.**
 * Heedless Resurrection's "as an additional cost to play this, kill a friendly
 * unit" needs one row in `card-effects.OPTIONAL_UNIT_COSTS`
 * (`{ kind: "killFriendly", mandatory: true }`), a shared file this wave may not
 * edit. So the ENUMERATOR never offers a variant naming the victim, and the pin
 * below asserts exactly that. Adding the row must FLIP that test rather than
 * silently changing behaviour nobody was watching.
 *
 * The EFFECT is still exercised end to end, because `validate-play-card` guards
 * its additional-cost checks behind `optionalCost !== undefined` and
 * `execute-play-card` forwards the field onto the chain entry unconditionally —
 * so a hand-built action carrying the victim goes through `submit`, the chain and
 * `resolveCardEffect` exactly as an enumerated one would.
 */

const HEEDLESS = "UNL-142";
const SARCOPHAGUS = "UNL-148";
/** Chaos, 3 Energy, 3 Might, PRINTED BLANK — filler for a deck that must not be
 *  empty. Nothing draws in this file; it is here so a Cleanup can never read an
 *  empty deck as a loss mid-assertion. */
const VANILLA_UNIT = "OGN-175";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** A board where player 0 can pay for anything in this file, out of FLOATING
 *  resources — so a test that wants to make something unaffordable can do it by
 *  zeroing two fields rather than by emptying a rune deck. */
function richState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  for (const player of state.players) {
    player.floatingEnergy = 20;
    player.floatingPower = { Chaos: 9, Body: 9, Fury: 9, Mind: 9, Order: 9, Calm: 9 };
    player.deck = [spellInstance("OGN-198"), spellInstance("OGN-198")];
  }
  state.players[0]!.deck = [makeUnit({ defId: VANILLA_UNIT }), makeUnit({ defId: VANILLA_UNIT })];
  return state;
}

const playOf = (state: GameState, card: CardInstance): PlayCardAction => {
  const candidates = legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId,
  );
  expect(candidates.length, `no legal play for ${card.name}`).toBeGreaterThan(0);
  const match = candidates.find((a) => a.destinationBattlefieldId === undefined);
  expect(match, `no legal base play for ${card.name}`).toBeDefined();
  return match!;
};

/** Pops whatever is on the chain: both players pass, then the held items settle. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.spellChain.length > 0; guard += 1) {
    const pass = legalActions(next).find((a) => a.type === "PassFocus");
    if (!pass) break;
    next = accept(next, pass);
  }
  return resolveHeldTriggers(next);
}

const inPlay = (state: GameState, instanceId: string): UnitInstance | undefined =>
  findUnitAnywhere(state, instanceId)?.unit;

const trashIds = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.trash.map((c) => c.instanceId);

/** The UNITS in a trash. Its own accessor because the spell under test lands
 *  there too once it has resolved, and "the trash is unchanged" means unchanged
 *  in the units — the only thing either card here reads. */
const trashUnitIds = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.trash.filter((c) => c.kind === "Unit").map((c) => c.instanceId);

const banishedIds = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.banished.map((c) => c.instanceId);

// ---------------------------------------------------------------------------

describe("Heedless Resurrection (UNL-142): kill a friendly unit, play a no-larger one from the trash", () => {
  /**
   * Player 0 holds the spell, has one 4-Energy/2-Chaos-Power body in base to pay
   * with, and three units in the trash straddling both ceilings.
   *
   * Synthetic bodies (`makeUnit`) on purpose: the costs ARE the test, and a real
   * card's on-play trigger would put a second held item on the chain beside the
   * one under test. The card under test is real and is played through `submit`.
   *
   * Nothing stands at a battlefield, so a free play has exactly one destination
   * and asks no placement question — the resurrection's own choice is then the
   * only question in the queue.
   */
  function resurrectionState() {
    const state = richState();
    const spell = spellInstance(HEEDLESS);
    state.players[0]!.hand = [spell];
    const victim = makeUnit({ name: "Victim", energyCost: 4, powerCost: 2, powerDomain: "Chaos" });
    state.players[0]!.baseUnits = [victim];
    const cheap = makeUnit({ name: "Cheap", energyCost: 2 });
    const tooMuchEnergy = makeUnit({ name: "Too Much Energy", energyCost: 5 });
    const tooMuchPower = makeUnit({ name: "Too Much Power", energyCost: 1, powerCost: 3, powerDomain: "Chaos" });
    state.players[0]!.trash = [cheap, tooMuchEnergy, tooMuchPower];
    return { state, spell, victim, cheap, tooMuchEnergy, tooMuchPower };
  }

  it("is the 2-Energy, 1-Power Chaos Reaction these figures are written against", () => {
    const spell = spellInstance(HEEDLESS);
    expect(spell.energyCost).toBe(2);
    expect(spell.powerCost).toBe(1);
    expect(spell.isReaction, "[Reaction] never reached the instance").toBe(true);
  });

  // ***THIS TEST ASSERTS THE WRONG ANSWER ON PURPOSE.***
  //
  // The additional cost is one row in `card-effects.OPTIONAL_UNIT_COSTS` and this
  // wave may not add it. Adding `"UNL-142": { kind: "killFriendly", mandatory: true }`
  // must make BOTH halves of this fail: the enumerator will start naming the
  // victim, and the plain variant will stop being offered at all.
  it("is ENUMERATED with a victim named — was a pin, flipped at integration 2026-08-11", () => {
    // **Was `PINNED WRONG`, asserting the enumerator offered no victim.** The
    // effect had been written and was unreachable: `legal-actions` fans an
    // additional-cost variant only for a card `OPTIONAL_UNIT_COSTS` names, so the
    // spell could be played only by hand-building the action. The agent that
    // wrote the effect measured the missing row exactly — "one row, nothing
    // else" — and the integrator added it.
    //
    // Inverted rather than deleted, and made stronger than the pin was: every
    // offered variant must now NAME a victim, because the cost is MANDATORY
    // (204.2.a) and a variant without one would be the offered-then-refused
    // split this engine keeps producing.
    const { state, spell } = resurrectionState();

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spell.instanceId,
    );
    expect(offered.length, "the spell is not playable at all — the row went missing").toBeGreaterThan(0);
    expect(
      offered.filter((a) => a.additionalCostUnitInstanceId === undefined),
      "a variant was offered with no victim — the cost is mandatory (204.2.a)",
    ).toHaveLength(0);
  });

  it("kills the named victim and plays a cheaper unit out of the trash", () => {
    const { state, spell, victim, cheap } = resurrectionState();
    const paid = { ...playOf(state, spell), additionalCostUnitInstanceId: victim.instanceId };

    const resolved = resolveChain(accept(state, paid));
    expect(pendingDecision(resolved)?.kind, "the resurrection never asked").toBe("UNL-142-resurrect");
    const after = answerDecisions(resolved, pickCard(cheap.instanceId));

    expect(inPlay(after, victim.instanceId), "the additional cost did not kill anything").toBeUndefined();
    expect(trashIds(after, 0), "the victim never reached the trash").toContain(victim.instanceId);
    const raised = inPlay(after, cheap.instanceId);
    expect(raised, "nothing came back out of the trash").toBeDefined();
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "it did not land in base").toContain(cheap.instanceId);
    expect(trashIds(after, 0), "it was played but left in the trash too").not.toContain(cheap.instanceId);
    // "Ignoring its cost" — the 2 Energy the raised unit prints is not taken.
    expect(after.players[0]!.floatingEnergy, "a free play charged for the unit").toBe(
      resolved.players[0]!.floatingEnergy,
    );
  });

  it("offers only the units under BOTH ceilings — and the victim itself", () => {
    const { state, spell, victim, cheap, tooMuchEnergy, tooMuchPower } = resurrectionState();
    const paid = { ...playOf(state, spell), additionalCostUnitInstanceId: victim.instanceId };

    const resolved = resolveChain(accept(state, paid));
    const decision = pendingDecision(resolved);
    expect(decision, "the resurrection never asked").toBeDefined();
    const ids = optionsFor(resolved, decision!).map((o) => o.id);

    expect(ids, "the 2-Energy unit was not offered").toContain(cheap.instanceId);
    // The victim costs exactly as much as itself, so `<=` admits it and the card
    // is a self-contained flicker. Nothing in the text excludes it.
    expect(ids, "the victim could not raise itself").toContain(victim.instanceId);
    expect(ids, "the Energy ceiling did not hold").not.toContain(tooMuchEnergy.instanceId);
    expect(ids, "the Power ceiling did not hold").not.toContain(tooMuchPower.instanceId);
    expect(ids).toHaveLength(2);
  });

  // ***INVERTED 2026-08-23 — this used to assert two WRONG answers on purpose,
  // and the gap it named is now closed.***
  //
  // **124.1**: "Whenever a Game Object changes zones to or from a Non-Board Zone,
  // all Temporary Modifications of all kinds cease to be tracked on it in all
  // capacities", with the rule's own examples reading "Damage is cleared.
  // Counters are removed. Granted Keywords are no longer granted."
  //
  // `effect-helpers.completeDeath` filed the UNCHANGED instance into the trash —
  // it stripped the Buff (705) and nothing else — so a unit that died damaged
  // came back still damaged, with a this-turn pump riding along. Every "play a
  // unit from your trash" in the pool reached it (Soulgorger, The Harrowing, Last
  // Rites, Fizz - Trickster).
  //
  // Both exits now go through `effect-helpers.stripTemporaryModifications`, one
  // function for one rule — and BOTH were incomplete before it: the "correct"
  // `returnUnitToHand` path was silent on `extraBuffs`, `baseMightThisTurn`,
  // `empowered` and `unchooseableByEnemiesThisTurn`.
  //
  // Kept and pointed the other way rather than deleted: this card is what makes
  // the flicker cheap and repeatable — kill your own damaged body and raise it in
  // the same breath — so it is the natural place for the rule to regress.
  it("124.1: the raised victim comes back CLEAN — damage and this-turn pump gone", () => {
    const { state, spell, victim } = resurrectionState();
    state.players[0]!.baseUnits = [{ ...victim, damage: 2, mightThisTurn: 3 }];
    state.players[0]!.trash = []; // only the corpse can answer, so no pick is needed
    const paid = { ...playOf(state, spell), additionalCostUnitInstanceId: victim.instanceId };

    const after = resolveChain(accept(state, paid));

    const back = inPlay(after, victim.instanceId);
    expect(back, "the victim did not come back").toBeDefined();
    expect(back!.damage, "damage survived a trip through the trash (124.1)").toBe(0);
    expect(back!.mightThisTurn, "a this-turn pump survived a trip through the trash (124.1)").toBe(0);
    // These two ARE right, and they are the positive control that the flicker
    // really happened rather than the unit never having left.
    expect(back!.exhausted, "it should re-enter exhausted (143.4)").toBe(true);
    expect(trashUnitIds(after, 0), "the corpse was left in the trash as well as played").toHaveLength(0);
  });

  it("fizzles when the victim was a TOKEN — a named limitation, not a silent one", () => {
    const { state, spell, cheap } = resurrectionState();
    // **186.1**: "If a token is put into any Non-Board Zone besides the chain, it
    // ceases to exist immediately after" — so there is no corpse to read the two
    // ceilings off. A DIVERGENCE rather than a vacuous case: 206's own worked
    // example prices a token off the card it copies, so printed the token's cost
    // is a real ceiling. Under-offers, which is the safe direction; the
    // alternative is guessing at a cap.
    const token = makeUnit({ name: "Token Victim", energyCost: 4, powerCost: 2, powerDomain: "Chaos", isToken: true });
    state.players[0]!.baseUnits = [token];
    const paid = { ...playOf(state, spell), additionalCostUnitInstanceId: token.instanceId };

    const after = resolveChain(accept(state, paid));

    expect(inPlay(after, token.instanceId), "the cost was not paid").toBeUndefined();
    expect(trashIds(after, 0), "a token reached the trash (186 / 186.1)").not.toContain(token.instanceId);
    expect(pendingDecision(after), "a question was asked with no ceiling to enforce").toBeUndefined();
    expect(inPlay(after, cheap.instanceId), "a unit came back off a ceiling nobody could read").toBeUndefined();
  });

  // 359.3.e.12's own worked example is Baited Hook, which prints the same
  // kill-then-play-under-a-ceiling sentence: the bounced friendly unit "can't be
  // killed and its Might is treated as null", and its controller "can't choose
  // any unit from among them".
  it("is REFUSED when the named victim is not on the board (204.2.a)", () => {
    // **This test's premise changed with the cost, and the new one is stronger.**
    //
    // It used to assert that a Resurrection naming an absent victim resolved and
    // did nothing — the do-as-much-as-you-can reading of 359.3.e.12. That was the
    // right description while the cost was unenumerable and the action could only
    // be hand-built. With the `OPTIONAL_UNIT_COSTS` row in place the cost is
    // MANDATORY, and 204.2.a settles it earlier: "Additional Costs must be paid to
    // finalize the spell", so a play that cannot pay is not a play that fizzles —
    // it is not a legal action at all, and the validator says so.
    //
    // That is the better guarantee: the refusal happens before anything is spent.
    const { state, spell, victim } = resurrectionState();
    const paid = { ...playOf(state, spell), additionalCostUnitInstanceId: victim.instanceId };
    const vanished: GameState = {
      ...state,
      players: [{ ...state.players[0]!, baseUnits: [] }, state.players[1]!] as GameState["players"],
    };

    // **What is NOT covered, said here rather than in a test that asserts
    // nothing:** the genuine mid-chain shape — announced legally, victim
    // removed during the response window, resolves against nothing — needs a
    // unit to leave play between announcement and resolution, which no fixture
    // in this file can arrange. The resolver's guard for it exists and is
    // unproved. A placeholder test was written here and deleted: a vacuous
    // assertion is worse than a named gap.
    const { result } = submit(vanished, paid);
    expect(result, "a play whose additional cost cannot be paid was accepted").toMatchObject({ type: "Invalid" });
  });

});

// ---------------------------------------------------------------------------

describe("Cursed Sarcophagus (UNL-148): banish your trash's units, then play them at full price", () => {
  /**
   * Player 0 holds the gear, with two units and one spell in the trash and a unit
   * in the OPPONENT's trash that must not move.
   *
   * The units are synthetic so their costs are the test; the gear is real and is
   * played through `submit`, which is the only way its `selfTriggers` "when you
   * play this" is reached at all.
   */
  function sarcophagusState() {
    const state = richState();
    const gear = realGearInstance(SARCOPHAGUS);
    state.players[0]!.hand = [gear];
    const cheapUnit = makeUnit({ name: "Cheap Unit", energyCost: 1 });
    const pricyUnit = makeUnit({ name: "Pricy Unit", energyCost: 3, powerCost: 1, powerDomain: "Chaos" });
    const spellInTrash = spellInstance("OGN-198");
    state.players[0]!.trash = [cheapUnit, spellInTrash, pricyUnit];
    const enemyUnit = makeUnit({ name: "Enemy Corpse" });
    state.players[1]!.trash = [enemyUnit];
    return { state, gear, cheapUnit, pricyUnit, spellInTrash, enemyUnit };
  }

  /** Plays the gear through the real path and settles its held self-trigger. */
  function playGear(state: GameState, gear: CardInstance): GameState {
    return resolveChain(accept(state, playOf(state, gear)));
  }

  const liveGear = (state: GameState, instanceId: string): GearInstance => {
    const found = state.players[0]!.activeGear.find((g) => g.instanceId === instanceId);
    expect(found, "the Sarcophagus left play").toBeDefined();
    return found!;
  };

  const activationOf = (state: GameState, gearInstanceId: string) =>
    legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === gearInstanceId);

  it("is the 4-Energy, 1-Power Chaos Gear these figures are written against", () => {
    const gear = realGearInstance(SARCOPHAGUS);
    expect(gear.energyCost).toBe(4);
    expect(gear.powerCost).toBe(1);
  });

  it("banishes every UNIT from its controller's trash, and records them against itself", () => {
    const { state, gear, cheapUnit, pricyUnit, spellInTrash, enemyUnit } = sarcophagusState();

    const after = playGear(state, gear);

    expect(banishedIds(after, 0), "the units were not banished").toEqual([cheapUnit.instanceId, pricyUnit.instanceId]);
    expect(trashIds(after, 0), "a SPELL was banished — the card says units").toEqual([spellInTrash.instanceId]);
    expect(trashIds(after, 1), "the opponent's trash was raided").toEqual([enemyUnit.instanceId]);
    expect(liveGear(after, gear.instanceId).banishedInstanceIds, "nothing was recorded 'with this'").toEqual([
      cheapUnit.instanceId,
      pricyUnit.instanceId,
    ]);
  });

  it("plays a banished unit and CHARGES for it — Energy and Power both", () => {
    const { state, gear, cheapUnit, pricyUnit } = sarcophagusState();
    const played = playGear(state, gear);
    const beforeEnergy = played.players[0]!.floatingEnergy;
    const beforeChaos = played.players[0]!.floatingPower.Chaos ?? 0;

    const action = activationOf(played, gear.instanceId);
    expect(action, "the Sarcophagus' ability was never enumerated").toBeDefined();
    const activated = accept(played, action!);
    expect(pendingDecision(activated)?.kind, "the crack never asked").toBe("UNL-148-play");
    const after = answerDecisions(activated, pickCard(pricyUnit.instanceId));

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "the unit never arrived").toContain(
      pricyUnit.instanceId,
    );
    expect(banishedIds(after, 0), "it was played and left banished too").toEqual([cheapUnit.instanceId]);
    expect(after.players[0]!.floatingEnergy, "its 3 Energy was not taken").toBe(beforeEnergy - 3);
    expect(after.players[0]!.floatingPower.Chaos ?? 0, "its 1 Chaos Power was not taken").toBe(beforeChaos - 1);
    expect(liveGear(after, gear.instanceId).exhausted, "the ability's own exhaust was not paid").toBe(true);
  });

  it("offers nothing when nothing in the pit can be paid for — and everything when it can", () => {
    const { state, gear, cheapUnit, pricyUnit } = sarcophagusState();
    const played = playGear(state, gear);

    const broke: GameState = {
      ...played,
      players: [
        { ...played.players[0]!, floatingEnergy: 0, floatingPower: {}, floatingRainbowPower: 0, channeled: [] },
        played.players[1]!,
      ],
    };
    const brokeAction = activationOf(broke, gear.instanceId);
    expect(brokeAction, "the ability was not offered at all — this test proves nothing").toBeDefined();
    const cracked = accept(broke, brokeAction!);

    expect(pendingDecision(cracked), "a question was asked with no affordable answer").toBeUndefined();
    expect(banishedIds(cracked, 0), "a unit was played for free").toEqual([cheapUnit.instanceId, pricyUnit.instanceId]);
    expect(cracked.players[0]!.baseUnits, "a unit arrived unpaid").toHaveLength(0);
    // 419.3.c — "if there are no eligible cards to Play ... nothing happens", and
    // the exhaust is still spent. The positive control is the test above, which
    // plays the same unit off the same pit with the resources restored.
    expect(liveGear(cracked, gear.instanceId).exhausted).toBe(true);
  });

  it("does not empty the pit — a readied Sarcophagus plays the next one", () => {
    const { state, gear, cheapUnit, pricyUnit } = sarcophagusState();
    const played = playGear(state, gear);
    const first = answerDecisions(accept(played, activationOf(played, gear.instanceId)!), pickCard(pricyUnit.instanceId));

    const readied: GameState = {
      ...first,
      players: [
        {
          ...first.players[0]!,
          activeGear: first.players[0]!.activeGear.map((g) =>
            g.instanceId === gear.instanceId ? { ...g, exhausted: false } : g,
          ),
        },
        first.players[1]!,
      ],
    };
    const second = activationOf(readied, gear.instanceId);
    expect(second, "a readied Sarcophagus was not offered its ability again").toBeDefined();
    const after = answerDecisions(accept(readied, second!));

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "the second unit never arrived").toContain(
      cheapUnit.instanceId,
    );
    expect(banishedIds(after, 0), "the pit should be empty now").toEqual([]);
  });
});
