import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { hasAnyLegalEffectChoice } from "../src/engine/target-lookup.js";
import { targetingForCard } from "../src/engine/card-effects.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * `unitSlots` — two ordered target slots with a MINIMUM count, replacing the
 * old fixed `unitPair`. `min: 0` is what makes "up to two" real (Singularity,
 * Flash, Back to Back); `min: 2` keeps Gentlemen's Duel needing both duellists.
 */
function armed(defId: string, mutate: (state: ReturnType<typeof makeState>) => void) {
  const card = spellInstance(defId);
  const state = makeState();
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = Array.from({ length: card.energyCost + card.powerCost }, (_, i) => ({
    id: `r${i}`,
    domain: (card.powerDomain ?? "Order") as "Order",
    state: "Ready" as const,
  }));
  mutate(state);
  return { card, state };
}

function candidatesFor(state: ReturnType<typeof makeState>, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);
}

function play(card: any, state: ReturnType<typeof makeState>, extra: Partial<PlayCardAction>): PlayCardAction {
  const ids = state.players[0]!.channeled.map((r) => r.id);
  return {
    type: "PlayCard",
    playerIndex: 0,
    card,
    payment: { energyRunes: ids.slice(0, card.energyCost), powerRunes: ids.slice(card.energyCost) },
    ...extra,
  };
}

describe("fan-out enumerates every legal filling of the slots", () => {
  it("Singularity (min 0, symmetric) offers none, each single, and each PAIR ONCE", () => {
    const a = makeUnit();
    const b = makeUnit();
    const c = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p1: [a], p2: [b, c] };
    });

    const variants = candidatesFor(state, card.instanceId).map((v) => [v.targetUnitInstanceId, v.secondTargetUnitInstanceId]);

    // 1 empty + 3 singles + 3 unordered pairs = 7. Undeduped it would be 10.
    expect(variants).toHaveLength(7);
    expect(variants.filter(([f, s]) => f === undefined && s === undefined)).toHaveLength(1);
    expect(variants.filter(([f, s]) => f !== undefined && s === undefined)).toHaveLength(3);

    const pairs = variants.filter(([f, s]) => f !== undefined && s !== undefined);
    expect(pairs).toHaveLength(3);
    // No pair appears in both orderings.
    const keys = pairs.map(([f, s]) => [f, s].sort().join("|"));
    expect(new Set(keys).size).toBe(3);
  });

  it("never offers the same unit in both slots", () => {
    const a = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p1: [a] };
    });

    // Only meaningful for variants that fill BOTH slots — an empty choice has
    // undefined in both, which is not a duplicated unit.
    const bothFilled = candidatesFor(state, card.instanceId).filter(
      (v) => v.targetUnitInstanceId !== undefined && v.secondTargetUnitInstanceId !== undefined,
    );
    expect(bothFilled.every((v) => v.targetUnitInstanceId !== v.secondTargetUnitInstanceId)).toBe(true);
    // With a single unit on the board there IS no legal pair.
    expect(bothFilled).toHaveLength(0);
  });

  it("Gentlemen's Duel (min 2, ASYMMETRIC) offers no empty/single, and keeps both orderings distinct", () => {
    const friendlyA = makeUnit();
    const friendlyB = makeUnit();
    const enemy = makeUnit();
    const { card, state } = armed("OGS-008", (s) => {
      s.battlefields[0]!.units = { p1: [friendlyA, friendlyB], p2: [enemy] };
    });

    const variants = candidatesFor(state, card.instanceId);
    expect(variants.every((v) => v.targetUnitInstanceId !== undefined && v.secondTargetUnitInstanceId !== undefined)).toBe(true);
    // 2 friendly x 1 enemy — the slots have different roles, so nothing dedupes.
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.secondTargetUnitInstanceId === enemy.instanceId)).toBe(true);
  });

  it("an 'any' slot offers the CASTER's own units too, base and battlefield", () => {
    // Singularity's text names no owner, so every unit in play is a legal
    // target — including yours. The UI depends on this: it highlights exactly
    // what the fan-out offers, so anything missing here is unclickable.
    const myBase = makeUnit();
    const myBattlefield = makeUnit();
    const theirs = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.players[0]!.baseUnits = [myBase];
      s.battlefields[0]!.units = { p1: [myBattlefield], p2: [theirs] };
    });

    const offered = new Set(
      candidatesFor(state, card.instanceId).flatMap((v) => [v.targetUnitInstanceId, v.secondTargetUnitInstanceId]).filter(Boolean),
    );
    expect(offered).toContain(myBase.instanceId);
    expect(offered).toContain(myBattlefield.instanceId);
    expect(offered).toContain(theirs.instanceId);

    // ...and a pair of your OWN two units is a legal combination.
    const ownPair = candidatesFor(state, card.instanceId).some(
      (v) =>
        [v.targetUnitInstanceId, v.secondTargetUnitInstanceId].every((id) => id !== undefined) &&
        [v.targetUnitInstanceId, v.secondTargetUnitInstanceId].every((id) => id === myBase.instanceId || id === myBattlefield.instanceId),
    );
    expect(ownPair).toBe(true);
  });

  it("Flash's 'friendly' slots, by contrast, never offer an enemy unit", () => {
    const mine = makeUnit();
    const theirs = makeUnit();
    const { card, state } = armed("OGS-011", (s) => {
      s.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    });

    const offered = candidatesFor(state, card.instanceId).flatMap((v) => [v.targetUnitInstanceId, v.secondTargetUnitInstanceId]);
    expect(offered).toContain(mine.instanceId);
    expect(offered).not.toContain(theirs.instanceId);
  });

  it("a min-0 card is playable with nothing on the board at all", () => {
    const { card, state } = armed("OGN-105", () => {});
    expect(candidatesFor(state, card.instanceId)).toHaveLength(1); // just the empty choice
    expect(hasAnyLegalEffectChoice(state, 0, targetingForCard(card))).toBe(true);
  });

  it("a min-2 card is NOT playable without both roles present", () => {
    const { card, state } = armed("OGS-008", (s) => {
      s.battlefields[0]!.units = { p1: [makeUnit()] }; // friendly only
    });
    expect(candidatesFor(state, card.instanceId)).toHaveLength(0);
    expect(hasAnyLegalEffectChoice(state, 0, targetingForCard(card))).toBe(false);
  });

  it("Flash stays battlefield-scoped — a base unit is never offered", () => {
    const atBase = makeUnit();
    const atBf = makeUnit();
    const { card, state } = armed("OGS-011", (s) => {
      s.players[0]!.baseUnits = [atBase];
      s.battlefields[0]!.units = { p1: [atBf] };
    });

    const offered = candidatesFor(state, card.instanceId).flatMap((v) => [v.targetUnitInstanceId, v.secondTargetUnitInstanceId]);
    expect(offered).toContain(atBf.instanceId);
    expect(offered).not.toContain(atBase.instanceId);
  });
});

describe("validation mirrors the fan-out", () => {
  it("accepts 0, 1 and 2 targets for a min-0 card", () => {
    const a = makeUnit();
    const b = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p2: [a, b] };
    });

    expect(validatePlayCard(state, play(card, state, {})).ok).toBe(true);
    expect(validatePlayCard(state, play(card, state, { targetUnitInstanceId: a.instanceId })).ok).toBe(true);
    expect(
      validatePlayCard(state, play(card, state, { targetUnitInstanceId: a.instanceId, secondTargetUnitInstanceId: b.instanceId })).ok,
    ).toBe(true);
  });

  it("rejects fewer than min for Gentlemen's Duel", () => {
    const friendly = makeUnit();
    const enemy = makeUnit();
    const { card, state } = armed("OGS-008", (s) => {
      s.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };
    });

    const result = validatePlayCard(state, play(card, state, { targetUnitInstanceId: friendly.instanceId }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/requires 2 target units/);
  });

  it("rejects the same unit in both slots", () => {
    const a = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p2: [a] };
    });

    const result = validatePlayCard(
      state,
      play(card, state, { targetUnitInstanceId: a.instanceId, secondTargetUnitInstanceId: a.instanceId }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/two different units/);
  });

  it("rejects a second target with no first", () => {
    const a = makeUnit();
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p2: [a] };
    });

    expect(validatePlayCard(state, play(card, state, { secondTargetUnitInstanceId: a.instanceId })).ok).toBe(false);
  });

  it("rejects a wrong-role slot (Flash can't move an enemy unit)", () => {
    const enemy = makeUnit();
    const { card, state } = armed("OGS-011", (s) => {
      s.battlefields[0]!.units = { p2: [enemy] };
    });

    const result = validatePlayCard(state, play(card, state, { targetUnitInstanceId: enemy.instanceId }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/must be friendly/);
  });
});

describe("fan-out size stays sane in a populated game", () => {
  it("a busy board doesn't explode the candidate count", () => {
    // 8 units on the board, both owners: 1 + 8 + 28 = 37 for Singularity.
    const mine = [makeUnit(), makeUnit(), makeUnit(), makeUnit()];
    const theirs = [makeUnit(), makeUnit(), makeUnit(), makeUnit()];
    const { card, state } = armed("OGN-105", (s) => {
      s.battlefields[0]!.units = { p1: mine.slice(0, 2), p2: theirs.slice(0, 2) };
      s.battlefields[1]!.units = { p1: mine.slice(2), p2: theirs.slice(2) };
    });

    expect(candidatesFor(state, card.instanceId)).toHaveLength(1 + 8 + 28);
    // The whole action list stays well clear of anything pathological.
    expect(legalActions(state).length).toBeLessThan(200);
  });
});
