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
import { makeState, makeUnit } from "./fixtures.js";

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
