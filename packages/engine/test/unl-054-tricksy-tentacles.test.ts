import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardMayMoveToBase, cardMovesTarget } from "../src/engine/card-effects.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * UNL-054 Tricksy Tentacles — "Move any number of enemy units with the same
 * controller and a total Might of 8 or less to a single location."
 *
 * The pool's first card that both targets a LIST and names a destination, so the
 * interesting question is not whether the resolver moves units — it is whether
 * the plural target field and the destination field survive the same play. Two
 * separate mechanisms have to agree: `unitListCandidates` builds the group and
 * `withDestinations` fans the destination, and until this card nothing asked them
 * to appear on one action.
 *
 * So every assertion below rides `legalActions` -> `submit` -> chain resolution,
 * and the effect is measured on the BOARD. A test that called `resolve` directly
 * would have passed against the pre-change engine too, since the resolver is not
 * where either mechanism could fail.
 *
 * The negative controls are the point of the file:
 *   - a group over the printed 8 total Might is neither offered NOR accepted;
 *   - friendly units are never in the pool;
 *   - the BASE destination is still refused, because the enumerator gate for it
 *     is a `legal-actions` change nobody has made (see the pin at the bottom).
 */

const registry = defaultCardRegistry();
const TRICKSY_TENTACLES = "UNL-054";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** A Spell takes effect on RESOLUTION, not on being played — the hop where a
 *  dropped field would show up as "played fine, moved nobody". */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const unitsAt = (state: GameState, battlefieldId: string, playerId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

/** Two enemy units at bf1, Might 3 and 3 — total 6, inside the printed cap. */
function tentacleState(): { state: GameState; spellId: string } {
  const spell = spellInstance(TRICKSY_TENTACLES);
  const s = makeState({ phase: "Action" });
  s.players[0]!.hand = [spell];
  s.players[0]!.channeled = runes("Calm", 8);
  s.battlefields[0]!.units = {
    p2: [
      makeUnit({ name: "Tentacled A", instanceId: "enemy-a", might: 3 }),
      makeUnit({ name: "Tentacled B", instanceId: "enemy-b", might: 3 }),
    ],
  };
  return { state: s, spellId: spell.instanceId };
}

describe("UNL-054 Tricksy Tentacles: a group move with one destination", () => {
  it("is OFFERED with BOTH a group and a destination on the same action", () => {
    // The assertion that separates "implemented" from "registered and inert".
    // `targetUnitInstanceIds` comes from `unitListCandidates`, and
    // `destinationBattlefieldId` from `withDestinations` — the two mechanisms
    // that had never met before this card.
    const { state, spellId } = tentacleState();
    const plays = playsOf(state, spellId);

    expect(plays.length, "no play of Tricksy Tentacles was enumerated at all").toBeGreaterThan(0);
    for (const play of plays) {
      expect(play.targetUnitInstanceIds, "a variant carried no target list").toBeDefined();
      expect(
        play.destinationBattlefieldId !== undefined || play.destinationIsBase === true,
        "a variant carried no destination — the MOVE_TARGET_SPELL_DEF_IDS row is gone",
      ).toBe(true);
    }
    // Both battlefields are offered, including the one the units are standing at.
    // That is the RULED behaviour, not an accident of `withDestinations` deriving
    // its "already there" skip from a singular `targetUnitInstanceId` a list play
    // never sets: docs/rules-conformance.md carries a project-owner ruling that a
    // group naming a destination one of its units already occupies is a **partial
    // no-op** — a legal choice where that unit simply does not move. Asserted so
    // that a future "tidy-up" filtering it out fails instead of silently narrowing
    // the card.
    // **`undefined` is in this set because the BASE variant landed** on
    // 2026-08-13, the same day as the ruling: a base play carries
    // `destinationIsBase: true` and no battlefield id. Asserted as the pair plus
    // undefined rather than filtered out, so that losing either axis fails here.
    expect(new Set(plays.map((p) => p.destinationBattlefieldId))).toEqual(new Set(["bf1", "bf2", undefined]));
    expect(
      plays.filter((p) => p.destinationIsBase === true).length,
      "the base destination stopped being offered",
    ).toBeGreaterThan(0);

    // The whole group is among the offered sets — "any number" reaching 2 of 2.
    const groups = plays.map((p) => [...(p.targetUnitInstanceIds ?? [])].sort().join(","));
    expect(groups).toContain("enemy-a,enemy-b");
    // ...and so is the empty one, which is what `min: 0` means.
    expect(groups).toContain("");
  });

  it("MOVES the whole chosen group to the single chosen battlefield", () => {
    const { state, spellId } = tentacleState();
    const play = playsOf(state, spellId).find(
      (p) =>
        p.destinationBattlefieldId === "bf2" &&
        (p.targetUnitInstanceIds ?? []).length === 2,
    );
    expect(play, "no two-unit play toward bf2 was offered").toBeDefined();

    const after = resolveChain(accept(state, play));

    expect(unitsAt(after, "bf1", "p2"), "the units never left their battlefield").toHaveLength(0);
    expect(
      unitsAt(after, "bf2", "p2")
        .map((u) => u.name)
        .sort(),
    ).toEqual(["Tentacled A", "Tentacled B"]);
  });

  it("moves a group whose ORIGINS differ, including a unit in the enemy base", () => {
    // "Enemy units" is a bare plural (355.9.a.1), so a unit at home is a legal
    // choice — and 144.3.b's shape holds for the effect too: one destination,
    // many origins.
    const { state, spellId } = tentacleState();
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Tentacled A", instanceId: "enemy-a", might: 3 })] };
    state.players[1]!.baseUnits = [makeUnit({ name: "Homebody", instanceId: "enemy-home", might: 3 })];

    const play = playsOf(state, spellId).find(
      (p) =>
        p.destinationBattlefieldId === "bf2" &&
        (p.targetUnitInstanceIds ?? []).length === 2,
    );
    expect(play, "a mixed base/battlefield group was never offered").toBeDefined();

    const after = resolveChain(accept(state, play));

    expect(after.players[1]!.baseUnits, "the base unit was not moved").toHaveLength(0);
    expect(unitsAt(after, "bf1", "p2")).toHaveLength(0);
    expect(unitsAt(after, "bf2", "p2")).toHaveLength(2);
  });

  it("applies Contested, so moving a group in actually stages a Showdown", () => {
    // The reason this goes through `forceMoveToDestination` rather than splicing
    // the units into a list: a move onto a battlefield the mover does not control
    // is what stages the Showdown, for the MOVED unit's controller (450) rather
    // than for the caster who paid for it.
    const { state, spellId } = tentacleState();
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Holder", might: 4 })] };
    state.battlefields[1]!.controllerId = "p1";

    const play = playsOf(state, spellId).find(
      (p) => p.destinationBattlefieldId === "bf2" && (p.targetUnitInstanceIds ?? []).length === 2,
    );
    const after = resolveChain(accept(state, play!));

    expect(after.battlefields[1]!.contestedByIndex, "the arriving group contested nothing").toBe(1);
  });

  it("NEGATIVE CONTROL: a group over 8 total Might is neither offered nor accepted", () => {
    // 5 + 4 = 9. The pool is identical in shape to the passing fixture, so a
    // failure here is about the cap and not about the board.
    const { state, spellId } = tentacleState();
    state.battlefields[0]!.units = {
      p2: [
        makeUnit({ name: "Heavy A", instanceId: "enemy-a", might: 5 }),
        makeUnit({ name: "Heavy B", instanceId: "enemy-b", might: 4 }),
      ],
    };

    const plays = playsOf(state, spellId);
    expect(plays.length, "nothing was enumerated — the fixture is broken, not the cap").toBeGreaterThan(0);
    // Each unit ALONE is legal (5 and 4 are both under 8), so the pool is alive;
    // only the pair is refused. That contrast is what makes this a control.
    const groups = plays.map((p) => [...(p.targetUnitInstanceIds ?? [])].sort().join(","));
    expect(groups).toContain("enemy-a");
    expect(groups).toContain("enemy-b");
    expect(groups, "a 9-Might group was offered — maxTotalMight is not being applied").not.toContain("enemy-a,enemy-b");

    // ...and the VALIDATOR refuses it too, so the cap is not merely an
    // enumeration convenience the UI could click past.
    const card = state.players[0]!.hand.find((c) => c.instanceId === spellId)!;
    const { state: unmoved, result } = submit(state, {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: { energyRunes: ["Calm-0", "Calm-1", "Calm-2", "Calm-3"], powerRunes: ["Calm-4"], rainbowRunes: [] },
      targetUnitInstanceIds: ["enemy-a", "enemy-b"],
      destinationBattlefieldId: "bf2",
    } satisfies PlayCardAction);
    expect(result).toMatchObject({ type: "Invalid" });
    expect(JSON.stringify(result)).toContain("total Might");
    expect(unitsAt(unmoved, "bf1", "p2"), "a refused play still moved the units").toHaveLength(2);
  });

  it("NEGATIVE CONTROL: friendly units are never in the pool", () => {
    // "Enemy units" — `owner: \"enemy\"`. A friendly unit on the same board must
    // not appear in any offered group, and the enemy one must, so the check
    // cannot pass by enumerating nothing.
    const { state, spellId } = tentacleState();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Mine", instanceId: "friendly-a", might: 2 })],
      p2: [makeUnit({ name: "Theirs", instanceId: "enemy-a", might: 2 })],
    };

    const ids = new Set(playsOf(state, spellId).flatMap((p) => p.targetUnitInstanceIds ?? []));
    expect(ids, "the enemy unit was not offered — the fixture is broken").toContain("enemy-a");
    expect(ids, "a friendly unit was offered to an enemy-only spell").not.toContain("friendly-a");
  });

  it("the chosen group is fixed at ANNOUNCE, not re-derived at resolution", () => {
    // 355 makes the choice part of finalizing the spell, and the chain moves in
    // between. A third enemy unit arriving on the board before resolution must
    // not be dragged along.
    const { state, spellId } = tentacleState();
    const play = playsOf(state, spellId).find(
      (p) => p.destinationBattlefieldId === "bf2" && (p.targetUnitInstanceIds ?? []).length === 2,
    );
    const announced = accept(state, play!);
    announced.battlefields[0]!.units = {
      p2: [...(announced.battlefields[0]!.units.p2 ?? []), makeUnit({ name: "Latecomer", instanceId: "enemy-c", might: 1 })],
    };

    const after = resolveChain(announced);

    expect(unitsAt(after, "bf1", "p2").map((u) => u.name), "a unit that was never chosen was moved").toEqual(["Latecomer"]);
    expect(unitsAt(after, "bf2", "p2")).toHaveLength(2);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(TRICKSY_TENTACLES))).toBe(true);
    expect(cardMovesTarget(TRICKSY_TENTACLES), "the MOVE_TARGET_SPELL_DEF_IDS row is gone").toBe(true);
  });
});

describe("UNL-054 Tricksy Tentacles: the BASE destination, ruled and now live", () => {
  /**
   * **This block was a PIN asserting the base was unreachable, and it fired on
   * 2026-08-13 — the same day the ruling landed.** It was pinned in BOTH
   * directions precisely so that landing one half alone would fail loudly, and
   * that is what happened: the integrator landed the `MOVE_TO_BASE_DEF_IDS` row
   * AND the `withDestinations` gate together, and both halves of the pin flipped.
   *
   * The ruling: "a single location" DOES include the enemy base (198.1 makes a
   * Base a Location, 355.4.a makes any Location the unit may occupy a valid Move
   * Destination). `forceMoveToDestination` routes `destinationIsBase` to
   * `forceMoveToBase`, which sends each unit to its OWN controller's base
   * (107.1.c) — well defined here because every target shares a controller.
   *
   * The gate that had to move: `toBase` was conditioned on
   * `currentBattlefieldIndex !== undefined`, derived from the singular
   * `targetUnitInstanceId` that a `unitList` play never sets. That condition is
   * right for a single target (a unit already in base has nowhere to go) and does
   * not apply to a group.
   */
  it("offers a base variant, and it really moves the group home", () => {
    const { state, spellId } = tentacleState();
    expect(cardMayMoveToBase(TRICKSY_TENTACLES), "the MOVE_TO_BASE_DEF_IDS row is gone").toBe(true);

    const basePlays = playsOf(state, spellId).filter((p) => p.destinationIsBase === true);
    expect(basePlays.length, "no base variant was enumerated — the withDestinations gate is back").toBeGreaterThan(0);

    const whole = basePlays.find((p) => (p.targetUnitInstanceIds ?? []).length === 2);
    expect(whole, "the whole group was not offered a base destination").toBeDefined();

    const after = resolveChain(accept(state, whole!));
    // Their OWN controller's base (107.1.c) — the enemy's, not the caster's.
    expect(after.players[1]!.baseUnits.map((u) => u.instanceId).sort(), "the group did not go home").toEqual([
      "enemy-a",
      "enemy-b",
    ]);
    expect(
      after.players[0]!.baseUnits.some((u) => u.instanceId === "enemy-a"),
      "the enemy units landed in the CASTER's base",
    ).toBe(false);
  });

  it("MEASURED: the enumerator gate, not just the table row, is what blocks it", () => {
    // Charm is the control — same board, same base, and it IS offered one. So the
    // `false` above is about UNL-054 and not about a base-less fixture.
    const spell = spellInstance("OGN-043");
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Calm", 8);
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Charmed", instanceId: "enemy-a", might: 3 })] };

    expect(playsOf(s, spell.instanceId).some((p) => p.destinationIsBase === true)).toBe(true);
  });
});
