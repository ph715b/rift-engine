import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { grantedRepeatCostOf } from "../src/engine/card-effects.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Temporal Portal (SFD-078) — ":rb_rune_rainbow:, [Exhaust]: Give the next spell
 * you play this turn [Repeat] equal to its cost."
 *
 * **The first card that grants a keyword to a card not yet played**, and the
 * first place two instances of `[Repeat]` can meet. 3509 and 3525 are what make
 * that interesting rather than redundant: "if a spell or ability has more than
 * one instance of Repeat, each Cost may be paid or not paid individually", and
 * each paid instance adds one execution. A printed-[Repeat] spell under a Portal
 * therefore has four prices and three possible execution counts.
 *
 * What the tests here are actually about:
 *  - the grant is priced from the card's PRINTED cost, so the play costs it
 *    twice;
 *  - the grant is spent by playing a SPELL, whether or not it was paid for, and
 *    is not spent by playing a unit or gear;
 *  - both instances can be paid together, and then the spell resolves 3 times.
 */

const registry = defaultCardRegistry();
const PORTAL = "SFD-078";
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield."
const DESERTS_CALL = "SFD-031"; // Calm 2E, [Repeat] [2] — 820.1.d's own worked example

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (domain: RuneCard["domain"], n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}${i}`, domain, state: "Ready" as const }));

/** A Portal in play, plenty of Fury runes, and a fat enemy unit to shoot. */
function board(runeCount = 10): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.activeGear = [gear(PORTAL)];
  state.players[0]!.channeled = runes("Fury", runeCount);
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: { [state.players[1]!.id]: [makeUnit({ name: "Foe", instanceId: "foe", might: 20 })] },
  };
  return state;
}

/** Arms the Portal through the real activation path. */
function arm(state: GameState): GameState {
  const use = legalActions(state).find(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.activeGear[0]!.instanceId,
  );
  expect(use, "the Portal offered no activation").toBeDefined();
  const { state: after, result } = submit(state, use!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return after;
}

function withSpell(state: GameState, defId = HEXTECH_RAY) {
  const spell = spellInstance(defId);
  return {
    state: { ...state, players: [{ ...state.players[0]!, hand: [spell] }, state.players[1]!] } as GameState,
    spellId: spell.instanceId,
  };
}

const playsOf = (state: GameState, spellId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId);

const damageOn = (state: GameState, instanceId: string) =>
  state.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === instanceId)?.damage ?? 0;

/** Resolves the chain so a Spell's effect actually lands. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && !current.chainOpen; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

describe("the grant", () => {
  it("is armed by the Portal, exhausting it and recycling a rainbow rune", () => {
    const before = board();
    const after = arm(before);

    expect(after.players[0]!.nextSpellRepeatGrants, "nothing was armed").toBe(1);
    expect(after.players[0]!.activeGear[0]!.exhausted, "the Portal was not exhausted").toBe(true);
    // The rainbow pip recycles one rune (416), whatever its domain.
    expect(after.players[0]!.channeled.length, "the rainbow Power was not paid").toBe(9);
  });

  /** "Equal to ITS COST" — the card's whole printed cost, both pips. */
  it("costs exactly the card's printed cost", () => {
    // Hextech Ray's own printed figures, read off the registry through the same
    // narrowing the rest of this suite uses — `registry.get` returns the
    // CardDefinition union, and `energyCost` is not on every arm of it. (The
    // engine's `build` tsconfig excludes tests, so a bare access typechecks green
    // under `npm run build` and red under `npm run typecheck`.)
    const ray = registry.get(HEXTECH_RAY);
    expect(ray.type).toBe("Spell");
    const { energyCost, powerCost } = ray as { energyCost: number; powerCost: number };
    expect(energyCost, "the fixture assumes a 1-Energy Ray").toBe(1);

    expect(grantedRepeatCostOf({ energyCost, powerCost, kind: "Spell" }, 1)).toEqual({ energy: 1, power: 1 });
    // And nothing while no grant is armed — the shape `repeatCostOf` has.
    expect(grantedRepeatCostOf({ energyCost, powerCost, kind: "Spell" }, 0)).toBeUndefined();
    // "The next SPELL you play", so a Gear is never given one.
    expect(grantedRepeatCostOf({ energyCost, powerCost, kind: "Gear" }, 1)).toBeUndefined();
  });

  it("is spent by playing a spell even when the granted cost is NOT paid", () => {
    const { state, spellId } = withSpell(arm(board()));
    const plain = playsOf(state, spellId).find((a) => !a.grantedRepeatPaid)!;
    const after = submit(state, plain).state;

    expect(after.players[0]!.nextSpellRepeatGrants, "the grant survived a spell").toBe(0);
  });

  /** A GEAR is not a spell, so it neither gets the grant nor spends it. */
  it("is NOT spent by playing a gear", () => {
    const armed = arm(board());
    const extra = gear("SFD-095"); // Doran's Blade, an ordinary Equipment
    const withGear: GameState = {
      ...armed,
      players: [{ ...armed.players[0]!, hand: [extra] }, armed.players[1]!],
    };
    const play = legalActions(withGear).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === extra.instanceId,
    );
    expect(play, "the gear was not playable").toBeDefined();

    expect(submit(withGear, play!).state.players[0]!.nextSpellRepeatGrants, "a gear spent the grant").toBe(1);
  });

  it("expires with the turn", () => {
    expect(runEnd(arm(board())).players[0]!.nextSpellRepeatGrants, "the grant survived the turn").toBe(0);
  });
});

describe("paying the granted [Repeat]", () => {
  it("is offered, and costs the printed cost TWICE", () => {
    const { state, spellId } = withSpell(arm(board()));
    const plain = playsOf(state, spellId).find((a) => !a.grantedRepeatPaid)!;
    const granted = playsOf(state, spellId).find((a) => a.grantedRepeatPaid);

    expect(granted, "no granted-[Repeat] variant was offered").toBeDefined();
    // Hextech Ray is 1 Energy / 1 Power, so the granted play owes 2 and 2. The
    // Energy figures read one lower than that: arming the Portal RECYCLED a
    // Ready rune for its rainbow pip, and 164.2's double duty banks 1 floating
    // Energy for it — so the plain play's whole Energy pip is already covered
    // and the granted play names one rune for the two.
    expect(plain.payment!.energyRunes.length, "the plain play's Energy was not covered by the float").toBe(0);
    expect(plain.payment!.powerRunes.length).toBe(1);
    expect(granted!.payment!.energyRunes.length, "the granted play should owe 2 Energy less the float").toBe(1);
    expect(granted!.payment!.powerRunes.length, "the granted play should cost 2 Power").toBe(2);
  });

  it("is NOT offered without a Portal armed", () => {
    const { state, spellId } = withSpell(board());
    expect(playsOf(state, spellId).some((a) => a.grantedRepeatPaid), "offered with nothing armed").toBe(false);
  });

  /** The validator does not trust the flag: claiming an unarmed grant buys a
   *  second execution for nothing and must be refused. */
  it("is refused when claimed with no grant armed", () => {
    const { state, spellId } = withSpell(board());
    const plain = playsOf(state, spellId)[0]!;
    const forged: PlayCardAction = { ...plain, grantedRepeatPaid: true };

    expect(validatePlayCard(state, forged).ok, "an unarmed granted [Repeat] was accepted").toBe(false);
  });

  /** And the price is re-derived: the plain play's payment cannot buy the
   *  granted one. */
  it("is refused when paid at the plain price", () => {
    const { state, spellId } = withSpell(arm(board()));
    const plain = playsOf(state, spellId).find((a) => !a.grantedRepeatPaid)!;
    const underpaid: PlayCardAction = { ...plain, grantedRepeatPaid: true };

    expect(validatePlayCard(state, underpaid).ok, "the second execution was sold at the first's price").toBe(false);
  });

  /** The payoff: the spell's instructions run TWICE (3525). */
  it("executes the spell twice", () => {
    const { state, spellId } = withSpell(arm(board()));
    const plainPlay = playsOf(state, spellId).find((a) => !a.grantedRepeatPaid)!;
    const grantedPlay = playsOf(state, spellId).find((a) => a.grantedRepeatPaid)!;

    // 3 damage once...
    expect(damageOn(settle(submit(state, plainPlay).state), "foe")).toBe(3);
    // ...and 3 twice with the granted instance paid.
    expect(damageOn(settle(submit(state, grantedPlay).state), "foe"), "the granted execution did not happen").toBe(6);
  });

  /**
   * **Two instances, and 3525 says each paid one adds an execution.** Desert's
   * Call is 820.1.d's own worked example ("Play a 2 Might Sand Soldier unit
   * token", [Repeat] [2]), so under a Portal it can play ONE, TWO or THREE Sand
   * Soldiers depending on which of its two [Repeat] costs are paid — which is the
   * whole reason the granted instance is its own field rather than a second
   * `repeatPaid`.
   */
  it("stacks with a PRINTED [Repeat] — three executions when both are paid", () => {
    const { state, spellId } = withSpell(arm(board(20)), DESERTS_CALL);
    const plays = playsOf(state, spellId);

    const plain = plays.find((a) => !a.repeatPaid && !a.grantedRepeatPaid)!;
    const printedOnly = plays.find((a) => a.repeatPaid && !a.grantedRepeatPaid)!;
    const grantedOnly = plays.find((a) => !a.repeatPaid && a.grantedRepeatPaid)!;
    const both = plays.find((a) => a.repeatPaid && a.grantedRepeatPaid);
    expect(both, "the pay-both variant was not offered").toBeDefined();

    const soldiers = (from: PlayCardAction) => settle(submit(state, from).state).players[0]!.baseUnits.length;
    expect(soldiers(plain), "one execution").toBe(1);
    expect(soldiers(printedOnly), "two executions").toBe(2);
    expect(soldiers(grantedOnly), "two executions").toBe(2);
    expect(soldiers(both!), "three executions").toBe(3);

    // And the four prices really are four: 2, 4, 4 and 6 Energy, less the one
    // floating Energy that arming the Portal banked.
    const energy = (a: PlayCardAction) => a.payment!.energyRunes.length;
    expect([energy(plain), energy(printedOnly), energy(grantedOnly), energy(both!)]).toEqual([1, 3, 3, 5]);
  });

  /** Unaffordable is simply not offered — the rule every additional cost in this
   *  enumerator follows. */
  it("is not offered when the doubled cost is unaffordable", () => {
    // Two runes, one of which arms the Portal — the doubled cost cannot be met
    // from the one that is left, however the double duty is counted.
    const { state, spellId } = withSpell(arm(board(2)));
    const offered = playsOf(state, spellId);

    expect(offered.length, "the plain play should still be there").toBeGreaterThan(0);
    expect(offered.some((a) => a.grantedRepeatPaid), "offered a price the player cannot pay").toBe(false);
  });
});
