import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { targetingForAnyCard } from "../src/engine/unit-triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **Tideturner (OGN-199): "when you play me, you MAY choose a unit you control
 * at another location."**
 *
 * The decline is one of the choices, and until 2026-08-07 it was unreachable.
 * `legal-actions` pushed the no-target variant only when
 * `effectVariants.length === 0`, so it appeared exactly when there was nothing
 * to decline — with any friendly unit elsewhere, every enumerated variant named
 * one and the swap was forced.
 *
 * **402.1** puts the decision at the Make Relevant Choices step: "if the first
 * part of a Triggered Ability's effect is 'you may', its controller decides
 * whether or not to perform the Triggered Ability NOW". So the decline has to be
 * an enumerable variant, not a branch inside the resolver — a resolver that
 * declined would already have been paid for.
 *
 * The fix is one flag, `TargetingSpec.optionalChoice`, read by the enumerator AND
 * by `validate-play-card`'s `targetOmissionAllowed`. Both halves are asserted
 * here, because a decline offered and then refused is this repo's most repeated
 * bug shape and the one the flag exists to make impossible.
 *
 * Tideturner is the only card in the pool this reaches — swept 2026-08-05 over
 * every Unit whose text says "you may <verb>" and whose on-play trigger targets
 * at announce. The last test pins that the flag stayed rare.
 */

const registry = defaultCardRegistry();
const TIDETURNER = "OGN-199";

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** Tideturner in hand and a friendly unit at bf1 — so there IS something to
 *  decline, which is the whole point. */
function stateWithATarget(): { state: GameState; instanceId: string } {
  const card = createCardInstance(registry.get(TIDETURNER));
  const s = makeState({ phase: "Action" });
  s.players[0]!.hand = [card];
  s.players[0]!.channeled = runes("Chaos", 10);
  s.battlefields[0]!.units = { p1: [makeUnit({ name: "Ally", instanceId: "ally" })] };
  return { state: s, instanceId: card.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

describe("Tideturner's 'you may' is declinable (402.1)", () => {
  it("offers BOTH the swap and the decline while a legal target exists", () => {
    const { state, instanceId } = stateWithATarget();
    const plays = playsOf(state, instanceId);

    expect(plays.length, "Tideturner was not enumerated at all — the fixture is wrong").toBeGreaterThan(0);
    // The half that used to be missing.
    expect(
      plays.some((p) => p.targetUnitInstanceId === undefined),
      "no decline variant was offered, so the 'you may' is still forced",
    ).toBe(true);
    // And the half that must not regress: declining did not replace choosing.
    expect(plays.some((p) => p.targetUnitInstanceId === "ally"), "the swap itself is no longer offered").toBe(true);
  });

  it("the validator ACCEPTS the decline — the other half of the pair", () => {
    // A variant offered by the enumerator and refused by the validator is the
    // offered-then-refused split this codebase has shipped three times. Both
    // read the same `optionalChoice` flag; this is what proves it.
    const { state, instanceId } = stateWithATarget();
    const decline = playsOf(state, instanceId).find((p) => p.targetUnitInstanceId === undefined);
    expect(decline).toBeDefined();

    expect(validatePlayCard(state, decline!).ok).toBe(true);
  });

  it("declining leaves both units exactly where they were", () => {
    const { state, instanceId } = stateWithATarget();
    const decline = playsOf(state, instanceId).find((p) => p.targetUnitInstanceId === undefined)!;

    const { state: after, result } = submit(state, decline);
    expect(result).toMatchObject({ type: "Ok" });

    // The ally never moved; the swap simply did not happen.
    const allies = after.battlefields[0]!.units["p1"] ?? [];
    expect(allies.some((u) => u.instanceId === "ally"), "the ally moved despite the decline").toBe(true);
  });

  it("a MANDATORY on-play trigger is still forced — the flag did not leak", () => {
    // The `length === 0` rule says something different from `optionalChoice`
    // ("a trigger with nothing to choose does nothing"), and folding the two
    // together would quietly make every on-play trigger optional. Mindsplitter
    // (OGN-192) is one of the mandatory ones: it says "choose", not "you may".
    const mandatory = createCardInstance(registry.get("OGN-192"));
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [mandatory];
    s.players[0]!.channeled = runes("Mind", 10);
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Foe", instanceId: "foe" })] };

    const targeting = targetingForAnyCard(mandatory, undefined);
    expect(targeting.kind === "unit" && targeting.optionalChoice, "Mindsplitter must not be optional").not.toBe(true);
  });

  it("optionalChoice is still used by exactly one card in the pool", () => {
    // A census. It was swept as the only card this reaches; a second one is a
    // decision (is it really optional?) rather than something to absorb.
    const optional = registry
      .all()
      .filter((def) => def.type === "Unit")
      .filter((def) => {
        const spec = targetingForAnyCard(createCardInstance(def), undefined);
        return spec.kind === "unit" && spec.optionalChoice === true;
      })
      .map((def) => def.id);

    expect(optional).toEqual([TIDETURNER]);
  });
});

/**
 * "...a unit you control **at another location**" — the half that was not enforced.
 *
 * Reported from playtesting: *"tideturner is not working. I cant target unit in
 * base or another battlefield."*
 *
 * The engine offered every friendly unit as a target, INCLUDING one standing
 * where Tideturner was about to land. Its resolver is `swapUnitLocations`, so
 * that pair is a no-op: the card resolves, both units stay exactly where they
 * are, and nothing visible happens. A player who picked the nearest unit — the
 * one already at the destination — saw the card do nothing, which is
 * indistinguishable from an unimplemented card.
 *
 * **This is a TARGETING restriction, not a resolver check.** 355.9.b is the
 * narrowing half ("It meets all targeting restrictions") and 355.8 declares
 * targets at finalization, so an ineligible unit must never be offered in the
 * first place.
 *
 * It could not live in `TargetingSpec`: the constraint relates the TARGET to the
 * DESTINATION, and `scope` describes the target alone with no knowledge of where
 * the card is going. Hence a per-card marker read where the two are paired.
 */
describe("Tideturner's target must be at ANOTHER location", () => {
  const TIDETURNER = "OGN-199";

  /** A friendly unit in base and another at bf1, so both a base target and a
   *  battlefield target exist and each is same-location for exactly one
   *  destination. */
  function swapBoard() {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.floatingPower = { Mind: 9, Calm: 9, Chaos: 9, Fury: 9, Body: 9, Order: 9 };
    const tide = realUnitInstance(TIDETURNER);
    state.players[0]!.hand = [tide];
    state.players[0]!.baseUnits = [makeUnit({ name: "Homebody", instanceId: "home" })];
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Fielder", instanceId: "field" })] };
    return { state, tide };
  }

  const pairs = () => {
    const { state, tide } = swapBoard();
    return legalActions(state)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === tide.instanceId)
      .map((p) => `${p.destinationBattlefieldId ?? "base"}<-${p.targetUnitInstanceId ?? "none"}`)
      .sort();
  };

  it("offers only the CROSS-location swaps, plus the declines", () => {
    // The positive control is built in: if the filter over-reached and removed
    // everything, the two legal pairs would be missing too.
    expect(pairs()).toEqual(["base<-field", "base<-none", "bf1<-home", "bf1<-none"]);
  });

  it("never offers a target already at the destination — the no-op pair", () => {
    // Stated separately from the equality above because THIS is the bug: each of
    // these resolves to a swap between two units in the same place.
    expect(pairs(), "a base target for a base play — the swap does nothing").not.toContain("base<-home");
    expect(pairs(), "a bf1 target for a bf1 play — the swap does nothing").not.toContain("bf1<-field");
  });

  it("still offers the DECLINE at both destinations — 'you MAY choose'", () => {
    // The optional half this file is otherwise about must survive the new filter:
    // a card with no legal target is still castable, because declining is real.
    expect(pairs()).toContain("base<-none");
    expect(pairs()).toContain("bf1<-none");
  });
});
