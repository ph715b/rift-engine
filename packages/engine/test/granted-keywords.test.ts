import { describe, expect, it } from "vitest";
import { effectiveKeywords, hasKeyword } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { addBuff, discardCards, spendBuff } from "../src/engine/effect-helpers.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { MoveUnitAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Keywords a card grants ITSELF conditionally.
 *
 * The point of the shared layer: a granted keyword has to be indistinguishable
 * from a printed one everywhere the question is asked — combat Might, the move
 * validator, and the move enumeration. Those were three separate reads of
 * `unit.keywords`, and each would otherwise have grown its own copy of the
 * condition.
 */

const registry = defaultCardRegistry();
const RAGING_SOUL = "OGN-019"; // "If you've discarded a card this turn, I have [Assault] and [Ganking]."
const BILGEWATER_BULLY = "OGN-125"; // "While I'm buffed, I have [Ganking]."
const MAGMA_WURM = "OGN-011"; // "Other friendly units enter ready."
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/** Two battlefields, both held by p1, with `u` standing at the first — the shape
 *  a battlefield-to-battlefield move needs. */
function movableState(u: UnitInstance): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.controllerId = "p1";
  state.battlefields[0]!.units = { p1: [u] };
  state.battlefields[1]!.controllerId = "p1";
  state.battlefields[1]!.units = { p1: [makeUnit({ name: "Anchor" })] };
  return state;
}

const moveAction = (u: UnitInstance): MoveUnitAction => ({
  type: "MoveUnit",
  playerIndex: 0,
  unitInstanceIds: [u.instanceId],
  destinationBattlefieldId: "bf2",
});

describe("Bilgewater Bully (OGN-125): [Ganking] while buffed", () => {
  it("cannot move battlefield-to-battlefield unbuffed, and can once buffed", () => {
    const bully = unit(BILGEWATER_BULLY);
    const state = movableState(bully);

    expect(hasKeyword(state, state.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(false);
    expect(validateMoveUnit(state, moveAction(bully)).ok).toBe(false);

    const buffed = addBuff(state, bully.instanceId);

    expect(hasKeyword(buffed, buffed.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(true);
    expect(validateMoveUnit(buffed, moveAction(bully)).ok).toBe(true);
  });

  it("the move ENUMERATION agrees with the validator", () => {
    // These were separate reads of `unit.keywords`. If only one learned about
    // grants, the board would offer a move the validator refuses (or hide a
    // legal one) — the exact failure this codebase has already had once.
    const bully = unit(BILGEWATER_BULLY);
    const state = movableState(bully);
    const movesFor = (s: GameState) =>
      legalActions(s).filter((a) => a.type === "MoveUnit" && a.unitInstanceIds.includes(bully.instanceId));

    expect(movesFor(state)).toHaveLength(0);
    expect(movesFor(addBuff(state, bully.instanceId)).length).toBeGreaterThan(0);
  });

  it("loses Ganking again when the buff is spent", () => {
    const bully = unit(BILGEWATER_BULLY);
    const buffed = addBuff(movableState(bully), bully.instanceId);
    const spent = spendBuff(buffed, 0, bully.instanceId)!;
    expect(hasKeyword(spent, spent.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(false);
  });
});

describe("Raging Soul (OGN-019): [Assault] and [Ganking] once you've discarded", () => {
  function soulState(): { state: GameState; soul: UnitInstance } {
    const soul = unit(RAGING_SOUL);
    const state = movableState(soul);
    state.players[0]!.hand = [makeUnit(), makeUnit()];
    return { state, soul };
  }

  it("has neither keyword before a discard, and both after", () => {
    const { state, soul } = soulState();
    expect(effectiveKeywords(state, soul, 0)).toEqual(soul.keywords);

    const after = discardCards(state, 0, 1);

    expect(after.players[0]!.discardedThisTurn).toBe(true);
    const onBoard = after.battlefields[0]!.units["p1"]![0]!;
    expect(hasKeyword(after, onBoard, 0, "Assault")).toBe(true);
    expect(hasKeyword(after, onBoard, 0, "Ganking")).toBe(true);
  });

  it("the granted [Assault] really adds Might in combat", () => {
    // A granted keyword must be indistinguishable from a printed one, and this
    // is the read that would silently ignore it: effectiveMight used to look at
    // `unit.keywords` directly.
    const { state, soul } = soulState();
    const combat = { isCombat: true, isAttackingSide: true, combatRole: "outgoing", battlefieldId: "bf1" } as const;
    const before = effectiveMight(state, state.battlefields[0]!.units["p1"]![0]!, 0, combat);

    const after = discardCards(state, 0, 1);

    expect(effectiveMight(after, after.battlefields[0]!.units["p1"]![0]!, 0, combat)).toBe(before + 1);
    void soul;
  });

  it("is a per-TURN condition — it lapses at end of turn", () => {
    const { state } = soulState();
    const discarded = discardCards({ ...state, phase: "Action" }, 0, 1);
    expect(discarded.players[0]!.discardedThisTurn).toBe(true);

    const ended = runEnd(discarded);

    expect(ended.players[0]!.discardedThisTurn).toBe(false);
  });

  it("reads the OWNER's discard, not the opponent's", () => {
    const { state } = soulState();
    state.players[1]!.hand = [makeUnit()];
    const theyDiscarded = discardCards(state, 1, 1);
    expect(hasKeyword(theyDiscarded, theyDiscarded.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(false);
  });
});

describe("Magma Wurm (OGN-011): other friendly units enter ready", () => {
  function withWurm(inPlay: boolean): { state: GameState; newcomer: UnitInstance } {
    const newcomer = unit("OGN-002"); // Brazen Buccaneer, no [Quick]
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          hand: [newcomer],
          baseUnits: inPlay ? [unit(MAGMA_WURM)] : [],
          channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });
    return { state, newcomer };
  }

  const play = (state: GameState, card: UnitInstance) =>
    executePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: {
        energyRunes: state.players[0]!.channeled.slice(0, card.energyCost).map((r) => r.id),
        powerRunes: state.players[0]!.channeled.slice(card.energyCost, card.energyCost + card.powerCost).map((r) => r.id),
      },
    });

  it("a unit played without a Wurm enters EXHAUSTED (143.4.a)", () => {
    const { state, newcomer } = withWurm(false);
    const after = play(state, newcomer);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === newcomer.instanceId)!.exhausted).toBe(true);
  });

  it("the same unit enters READY with a Wurm already on the board", () => {
    const { state, newcomer } = withWurm(true);
    const after = play(state, newcomer);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === newcomer.instanceId)!.exhausted).toBe(false);
  });

  it("does NOT ready itself — 'OTHER friendly units'", () => {
    const wurm = unit(MAGMA_WURM);
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          hand: [wurm],
          channeled: Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });

    const after = play(state, wurm);

    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("is the OPPONENT's problem only when it's theirs — it's caster-relative", () => {
    const { state, newcomer } = withWurm(false);
    state.players[1]!.baseUnits = [unit(MAGMA_WURM)]; // THEIR Wurm
    const after = play(state, newcomer);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === newcomer.instanceId)!.exhausted).toBe(true);
  });
});

describe("coverage counts all three", () => {
  it("reports them as implemented", () => {
    for (const id of [RAGING_SOUL, BILGEWATER_BULLY, MAGMA_WURM]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
