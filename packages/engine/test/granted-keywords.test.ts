import { describe, expect, it } from "vitest";
import { deflectSurcharge, effectiveKeywords, hasKeyword } from "../src/engine/granted-keywords.js";
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
import { answerDecisions, makePlayer, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

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

    // The discard asks which card, so the condition only becomes true once the
    // card has actually gone — "if you've discarded a card this turn" is about a
    // completed discard, not an intended one.
    const after = answerDecisions(discardCards(state, 0, 1));

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

    const after = answerDecisions(discardCards(state, 0, 1));

    expect(effectiveMight(after, after.battlefields[0]!.units["p1"]![0]!, 0, combat)).toBe(before + 1);
    void soul;
  });

  it("is a per-TURN condition — it lapses at end of turn", () => {
    const { state } = soulState();
    const discarded = answerDecisions(discardCards({ ...state, phase: "Action" }, 0, 1));
    expect(discarded.players[0]!.discardedThisTurn).toBe(true);

    const ended = runEnd(discarded);

    expect(ended.players[0]!.discardedThisTurn).toBe(false);
  });

  it("reads the OWNER's discard, not the opponent's", () => {
    const { state } = soulState();
    state.players[1]!.hand = [makeUnit()];
    const theyDiscarded = answerDecisions(discardCards(state, 1, 1));
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

/**
 * `[Deflect N]`'s surcharge arithmetic, on its own.
 *
 * Kept separate from the cost pipeline deliberately: this is the reason payment
 * has to be computed PER TARGET rather than once per card, and the two can be
 * got wrong independently. The keyword itself is still unimplemented in the cost
 * path — coverage.ts's UNIMPLEMENTED_KEYWORDS still lists it — so nothing here
 * claims a spell actually costs more yet.
 */
describe("deflectSurcharge: what an opponent must pay to choose this unit", () => {
  const POUTY_PORO = "OGN-013"; // [Deflect]
  const VOLIBEAR_FURIOUS = "OGN-041"; // [Deflect 2]
  const FIORA_VICTORIOUS = "OGN-232"; // [Deflect] only while [Mighty]

  it("is the printed value for an opponent", () => {
    const state = makeState();
    const poro = realUnitInstance(POUTY_PORO);
    state.players[0]!.baseUnits = [poro];
    // owner 0, chooser 1 — the opponent pays.
    expect(deflectSurcharge(state, poro, 0, 1)).toBe(1);
  });

  it("reads the VALUED form — Volibear is [Deflect 2], not a flat pip", () => {
    const state = makeState();
    const voli = realUnitInstance(VOLIBEAR_FURIOUS);
    state.players[0]!.baseUnits = [voli];
    expect(deflectSurcharge(state, voli, 0, 1)).toBe(2);
  });

  it("costs the OWNER nothing — the keyword taxes opponents", () => {
    // Without the side check, buffing your own Fiora would be taxed.
    const state = makeState();
    const poro = realUnitInstance(POUTY_PORO);
    state.players[0]!.baseUnits = [poro];
    expect(deflectSurcharge(state, poro, 0, 0)).toBe(0);
  });

  it("is 0 for a unit without the keyword", () => {
    const state = makeState();
    const plain = makeUnit({ might: 3 });
    expect(deflectSurcharge(state, plain, 0, 1)).toBe(0);
  });

  it("follows a GRANTED Deflect on and off as the condition changes", () => {
    // Fiora has it only while [Mighty] (Might 5+). A granted keyword must tax
    // exactly like a printed one, and must stop when the grant stops.
    const state = makeState();
    const fiora = realUnitInstance(FIORA_VICTORIOUS);

    const weak = { ...fiora, might: 4 };
    state.players[0]!.baseUnits = [weak];
    expect(deflectSurcharge(state, weak, 0, 1)).toBe(0);

    const mighty = { ...fiora, might: 5 };
    state.players[0]!.baseUnits = [mighty];
    expect(deflectSurcharge(state, mighty, 0, 1)).toBe(1);
  });
});

/**
 * A keyword printed INSIDE a condition is not a printed keyword.
 *
 * `card-loader`'s `KW_PATTERN` sees brackets, not sentences, so `[Deflect]`
 * written inside a `[Level 3]` band parses as a flat printed keyword and the card
 * ships with it live at 0 XP. Sivir - Mercenary (SFD-143) is the same shape and
 * was fixed for it; Unleashed added four more, found independently by two agents
 * in different domain files on 2026-08-09.
 *
 * **Both keywords involved are ones a player can ACT on**, which is why this is a
 * playable bug rather than a cosmetic one: `[Deflect]` makes an opponent pay a
 * rainbow surcharge they do not owe, and `[Ganking]` permits a
 * battlefield-to-battlefield move that should be illegal.
 *
 * The fix is two halves in two files — strip at load, re-grant at runtime — and
 * BOTH are asserted here, because either alone is wrong: the strip without the
 * grant leaves the card weaker than printed, and the grant without the strip
 * changes nothing.
 */
describe("Unleashed's conditional keywords are off until their condition is met", () => {
  const withXp = (defId: string, xp: number) => {
    const state = makeState({ phase: "Action" });
    const unit = realUnitInstance(defId);
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.xp = xp;
    return { state, unit };
  };
  const keywordsAt = (defId: string, xp: number) => {
    const { state, unit } = withXp(defId, xp);
    return effectiveKeywords(state, unit, 0);
  };

  it.each([
    ["UNL-047", 3, "Deflect"],
    ["UNL-075", 3, "Ganking"],
    ["UNL-113", 6, "Deflect"],
    ["UNL-113", 6, "Ganking"],
  ])("%s does not carry [%s] below %i XP, and does at it", (defId, level, keyword) => {
    expect(keywordsAt(defId as string, (level as number) - 1), `${defId} has [${keyword}] below the threshold`).not.toHaveProperty(
      keyword as string,
    );
    expect(keywordsAt(defId as string, level as number), `${defId} never gains [${keyword}]`).toHaveProperty(keyword as string);
  });

  it("and their REAL printed keywords survive the strip", () => {
    // The load-bearing negative, and the reason this uses the per-KEYWORD table
    // rather than the per-card one. `CONDITIONAL_KEYWORD_DEF_IDS` returns `{}`,
    // which would have taken Mosstomper's and Gustwalker's printed [Hunt 2] with
    // it — turning a card that was too strong into one that is too weak. The
    // first fix suggested to me was that table.
    for (const defId of ["UNL-047", "UNL-075", "UNL-113"]) {
      expect(keywordsAt(defId, 0), `${defId} lost its printed [Hunt]`).toHaveProperty("Hunt");
    }
  });

  it("PINNED: Wily Newtfish is stripped with NO re-grant, so its [Ganking] is inert", () => {
    // Asserts a WRONG answer on purpose. UNL-108's condition is "if you've gained
    // XP this turn", and nothing records that — `gainXp` writes only the running
    // total, so "gained some this turn" and "has some" are indistinguishable.
    //
    // Stripped anyway: weaker than printed is the safer error than letting a
    // player make an illegal move all game, and the card already reports
    // unimplemented for the same missing counter — so an inert keyword agrees
    // with coverage instead of hiding a second gap. Adding `xpGainedThisTurn`
    // flips this.
    expect(keywordsAt("UNL-108", 0)).not.toHaveProperty("Ganking");
    expect(keywordsAt("UNL-108", 99), "a re-grant landed — give it a CONDITIONAL_GRANTS entry and flip this pin").not.toHaveProperty(
      "Ganking",
    );
  });
});
