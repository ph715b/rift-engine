import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { BRUSH, battlefieldTokenDefIds, replaceBattlefieldWithToken } from "../src/engine/battlefield-tokens.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * UNL-195 Ivern - Green Father, and the Brush battlefield token.
 *
 * > "When you conquer or hold, you may exhaust me to replace that battlefield
 * > with a Brush battlefield token. (Bird, Cat, Dog, Poro, and Ivern units have
 * > +1 [Might] in Brush. It can be swapped back when scored.)"
 *
 * # The refusal, and the two halves of it
 *
 * > "REFUSED systemically: this engine has no way to replace a battlefield, and
 * > no Brush exists to replace it with. ... the word appears three times, and all
 * > three are Ivern's own printings telling you to make one. Neither
 * > `loadBattlefieldDefinitions()` nor `loadTokenDefinitions()` has a Brush."
 *
 * The data half is exactly right and was re-measured — the Brush is in no set
 * file, so `engine/battlefield-tokens.ts` authors it from the reminder text
 * printed on Ivern himself, which is where its rules text has been all along.
 * The engine half was a gap rather than a barrier: a replacement is the two
 * fields that say WHICH battlefield this is, swapped in place.
 *
 * # Replace means REPLACE, not remove-and-add
 *
 * The Brush takes over the battlefield's id, so the units standing there, its
 * controller, its Contested status and its hidden cards are all untouched — the
 * ground changed, nobody moved. Every assertion below about what survives the
 * swap is there because the alternative implementation (append a Brush, drop the
 * old one) would fail it while looking correct on the board.
 */

const registry = defaultCardRegistry();
const IVERN = "UNL-195";
/** Stalwart Poro — a real Poro-tagged body, so the aura is measured on a PRINTED
 *  tag rather than on one this test invented. `OGN-053` was the first pick and is
 *  Stand United, a SPELL: `realUnitInstance` cast it to a UnitInstance with no
 *  `tags` at all, and the aura crashed rather than reading false. */
const POUTY_PORO = "OGN-052";

/** A state whose Legend for `playerIndex` is `defId` — the shape
 *  `legend-abilities.test.ts` uses, spelled here because it is not exported. */
function withLegend(state: GameState, playerIndex: 0 | 1, defId: string): GameState {
  const players = [...state.players] as GameState["players"];
  players[playerIndex] = { ...players[playerIndex], legend: { ...players[playerIndex].legend, defId } };
  return { ...state, players };
}

function board(): { state: GameState; poro: UnitInstance; other: UnitInstance } {
  const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, IVERN);
  const poro = realUnitInstance(POUTY_PORO);
  const other = makeUnit({ instanceId: "plain", might: 3 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    controllerId: state.players[0]!.id,
    units: { [state.players[0]!.id]: [poro, other] },
  };
  return { state, poro, other };
}

const bfAt = (state: GameState, id: string) => state.battlefields.find((bf) => bf.id === id);

/** A conquest by player 0 at bf1, with the held triggers settled so Ivern's
 *  question is standing. */
const conquer = (state: GameState) => resolveHeldTriggers(recordConquest(state, 0, "bf1"));

/**
 * Answers the front question.
 *
 * Through `answerDecision` rather than `submit`, because this file drives the
 * trigger through `recordConquest` — a conquest is reached from combat and the
 * Cleanup rather than from an action, so there is no PlayerAction funnel to send
 * here. The options are asked through `optionsFor` first, which is the same list
 * `legal-actions` would offer, so an option this file answers is one a game would
 * have offered.
 */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  expect(optionsFor(state, decision!).map((o) => o.id), `"${optionId}" was not on offer`).toContain(optionId);
  const next = answerDecision(state, decision!.id, optionId);
  expect(next, "the answer did not apply").toBeDefined();
  return resolveHeldTriggers(next!);
}

describe("the offer — when you conquer or hold, you MAY exhaust him", () => {
  it("a conquest parks the question for Ivern's controller", () => {
    const after = conquer(board().state);
    const decision = pendingDecision(after);

    expect(decision, "no Brush question was parked").toBeDefined();
    expect(decision!.kind).toBe("UNL-195-brush");
    expect(decision!.playerIndex).toBe(0);
    expect(decision!.battlefieldId, "the question forgot which battlefield").toBe("bf1");
  });

  /**
   * "You MAY EXHAUST ME to" is an optional cost (204.2), and 416.3 makes an
   * unpayable cost no option at all — so an already-exhausted Ivern is not asked
   * rather than asked and then refused.
   */
  it("an ALREADY EXHAUSTED Ivern is never asked", () => {
    const { state } = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };

    expect(pendingDecision(conquer(state)), "the question was raised with the cost unpayable").toBeUndefined();
  });

  it("declining leaves the battlefield alone and Ivern ready", () => {
    const declined = answer(conquer(board().state), "decline");

    expect(bfAt(declined, "bf1")?.defId).not.toBe(BRUSH.defId);
    expect(declined.players[0]!.legend.exhausted, "he was exhausted for declining").toBe(false);
  });

  /** The battlefield is already a Brush, so the cost would buy nothing and the
   *  memory of what it originally was would be overwritten. */
  it("is not offered on a battlefield that is ALREADY a Brush", () => {
    const { state } = board();
    const already = replaceBattlefieldWithToken(state, "bf1", BRUSH);

    expect(pendingDecision(conquer(already))).toBeUndefined();
  });
});

describe("the replacement — in place, keeping everything but the identity", () => {
  it("swaps the name and defId, and exhausts him", () => {
    const { state } = board();
    const before = bfAt(state, "bf1")!.name;
    const after = answer(conquer(state), "brush");

    expect(bfAt(after, "bf1")?.name).toBe("Brush");
    expect(bfAt(after, "bf1")?.defId).toBe(BRUSH.defId);
    expect(bfAt(after, "bf1")?.swappedFrom?.name, "it forgot what it was").toBe(before);
    expect(after.players[0]!.legend.exhausted, "the cost was not paid").toBe(true);
  });

  /**
   * The assertions that tell a REPLACEMENT from a remove-and-add. An
   * implementation that appended a Brush and dropped the old battlefield would
   * look right on a board and fail every line here.
   */
  it("keeps the id, the units standing there, and the controller", () => {
    const { state, poro, other } = board();
    const after = answer(conquer(state), "brush");
    const bf = bfAt(after, "bf1")!;

    expect(after.battlefields, "a battlefield was added or dropped").toHaveLength(2);
    expect(Object.values(bf.units).flat().map((u) => u.instanceId).sort()).toEqual(
      [poro.instanceId, other.instanceId].sort(),
    );
    expect(bf.controllerId, "control was lost in the swap").toBe(after.players[0]!.id);
  });
});

describe("the Brush's own aura — Bird, Cat, Dog, Poro and Ivern units have +1", () => {
  it("a Poro standing in the Brush is +1", () => {
    const { state, poro } = board();
    const before = effectiveMight(state, poro, 0, { isCombat: false, battlefieldId: "bf1" });
    const after = answer(conquer(state), "brush");
    const inBrush = Object.values(bfAt(after, "bf1")!.units).flat().find((u) => u.instanceId === poro.instanceId)!;

    expect(effectiveMight(after, inBrush, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(before + 1);
  });

  /** The control that gives it meaning: an untagged body standing beside the Poro
   *  gets nothing, so this is the tag filter rather than a flat "+1 here". */
  it("NEGATIVE CONTROL: an untagged unit beside it gets nothing", () => {
    const { state, other } = board();
    const before = effectiveMight(state, other, 0, { isCombat: false, battlefieldId: "bf1" });
    const after = answer(conquer(state), "brush");
    const inBrush = Object.values(bfAt(after, "bf1")!.units).flat().find((u) => u.instanceId === other.instanceId)!;

    expect(effectiveMight(after, inBrush, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(before);
  });

  /** ...and the second control: the same Poro at the OTHER battlefield is not
   *  pumped, so the aura is positional rather than a property of the unit. */
  it("NEGATIVE CONTROL: the same Poro at the other battlefield gets nothing", () => {
    const { state, poro } = board();
    const after = answer(conquer(state), "brush");

    expect(effectiveMight(after, poro, 0, { isCombat: false, battlefieldId: "bf2" })).toBe(
      effectiveMight(state, poro, 0, { isCombat: false, battlefieldId: "bf2" }),
    );
  });
});

describe("it can be swapped back when SCORED", () => {
  it("scoring the Brush puts the original battlefield back", () => {
    const { state } = board();
    const originalName = bfAt(state, "bf1")!.name;
    const brushed = answer(conquer(state), "brush");
    expect(bfAt(brushed, "bf1")?.name).toBe("Brush");

    // A fresh turn's scoring — the first conquest already recorded bf1 as scored,
    // and 470 allows one scoring per battlefield per turn.
    const nextTurn = { ...brushed, players: [{ ...brushed.players[0]!, scoredBattlefieldsThisTurn: [] }, brushed.players[1]!] as GameState["players"] };
    const scored = recordConquest(nextTurn, 0, "bf1");

    expect(bfAt(scored, "bf1")?.name, "the Brush did not swap back").toBe(originalName);
    expect(bfAt(scored, "bf1")?.swappedFrom, "the memory was left behind").toBeUndefined();
  });

  /**
   * The distinction `recordConquest` already draws twice: taking a battlefield
   * and SCORING for it are different facts. A conquest that scores nothing —
   * here, a second one in the same turn — leaves the Brush standing.
   */
  it("a conquest that scores NOTHING leaves the Brush standing", () => {
    const { state } = board();
    const brushed = answer(conquer(state), "brush");

    // `scoredBattlefieldsThisTurn` still holds bf1 from the first conquest, so
    // this one records the conquest and pays no point.
    const again = recordConquest(brushed, 0, "bf1");

    expect(bfAt(again, "bf1")?.name).toBe("Brush");
  });
});

describe("coverage", () => {
  it("the Brush is a real card as far as the drift gate is concerned", () => {
    expect(battlefieldTokenDefIds()).toContain(BRUSH.defId);
  });

  it("Ivern is implemented, with no partial note left behind", () => {
    expect(partialImplementationNote(registry.get(IVERN))).toBeUndefined();
    expect(isCardImplemented(registry.get(IVERN))).toBe(true);
  });
});
