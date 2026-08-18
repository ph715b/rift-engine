import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { optionsFor } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isEmpowered } from "../src/engine/effect-helpers.js";
import { isOpenBattlefield, mayPlaceWithoutPresence } from "../src/engine/unit-triggers.js";
import { replacedCostFor } from "../src/engine/replaced-costs.js";
import { SHADOW_CLONE_TOKEN_DEF_ID } from "../src/engine/constants.js";
import { createToken, TENTACLE_TOKEN } from "../src/engine/token.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Chaos cards — the second wave**, the nine that needed machinery
 * rather than a card entry, plus VEN-182 through the alias.
 *
 * Four engine seams landed with them, and three are the same shape the session
 * has hit before: a fact the engine already knew that had never reached the
 * resolver that wanted it (`fromHidden` on a unit's own on-play trigger), an
 * axis one targeting kind had and its neighbour did not (`domain` on
 * `unitList`), and a discount that had only ever applied to a PRINTED price
 * (Stargazer, on a replaced one). The fourth is genuinely new: a delayed
 * end-of-turn disempower.
 */

const registry = defaultCardRegistry();

const STARGAZER = "VEN-098";
const TORNADO_WARRIOR = "VEN-099";
const UP_FROM_THE_DEEP = "VEN-100";
const GUST_MONK = "VEN-101";
const DECREE_OF_DISCORD = "VEN-107";
const ILLAOI = "VEN-109";
const ZED_SILENT = "VEN-112";
const KENNEN_SHURIKEN = "VEN-113";
const OCEAN_DRAKE = "VEN-115";
const ILLAOI_OVERNUMBERED = "VEN-182";

/** Lacerate — a Spell that prints `[Flow] 4 Energy + 2 Order`. */
const A_FLOW_SPELL = "VEN-127";
/** Wind and Ghosts — a Spell with NO Flow cost, for the negative control. */
const A_PLAIN_SPELL = "VEN-106";

function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const ownUnits = (state: GameState, index: 0 | 1): UnitInstance[] => [
  ...state.players[index]!.baseUnits,
  ...state.battlefields.flatMap((bf) => bf.units[state.players[index]!.id] ?? []),
];

function castSpell(state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}): GameState {
  const card = spellInstance(defId);
  const effect = effectForCard(card);
  expect(effect, `${defId} has no registered card effect`).toBeDefined();
  return resolveHeldTriggers(
    effect!.resolve!(
      state,
      { casterIndex, opponentIndex: casterIndex === 0 ? 1 : 0 },
      { type: "PlayCard", playerIndex: casterIndex, card, ...event } as never,
    ),
  );
}

/** Everything HELD or already on the chain, by the defId of whatever placed it —
 *  the instrument that separates "resolved to nothing" from "never placed". Both
 *  lists, because a Cleanup finalizes a held trigger ONTO the chain. */
const heldDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : e.card.defId)),
];

const mightAt = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): number =>
  effectiveMight(state, unit, ownerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });

const conquered = (state: GameState, conquerorIndex: 0 | 1 = 0, battlefieldId = "bf1"): GameState =>
  resolveHeldTriggers(runCleanup(holdEventTrigger(state, { kind: "battlefieldConquered", conquerorIndex, battlefieldId })));

describe("Stargazer (VEN-098): [Flow] spells from your trash cost 2 less, min 1", () => {
  function board(withStargazer: boolean): GameState {
    const state = makeState();
    if (withStargazer) state.battlefields[0]!.units = { p1: [realUnitInstance(STARGAZER)] };
    return state;
  }

  /** The FLOW price, which is the number this card reduces — priced the way both
   *  the enumerator and the validator price it: `playedFromHand: false`. */
  const flowPrice = (state: GameState, raw: number, defId = A_FLOW_SPELL) =>
    modifiedEnergyCost(state, 0, "Spell", raw, defId, false);

  it("takes 2 off a Flow cost played from the trash", () => {
    expect(flowPrice(board(true), 4)).toBe(2);
  });

  it("...and floors at 1 rather than 0 — the card's own minimum", () => {
    // Every other reduction in this module floors at 0. This one prints "to a
    // minimum of [1]", so a 2-Energy Flow cost becomes 1 and not 0.
    expect(flowPrice(board(true), 2), "it used the usual 0 floor").toBe(1);
    expect(flowPrice(board(true), 1), "the floor raised a price below it").toBe(1);
  });

  it("does NOT apply to the same spell played from HAND", () => {
    // "From your trash" is printed. The printed-price path passes
    // `playedFromHand: true`, which is the whole discriminator.
    expect(modifiedEnergyCost(board(true), 0, "Spell", 4, A_FLOW_SPELL, true)).toBe(4);
  });

  it("does NOT apply to a spell with no [Flow] cost", () => {
    expect(flowPrice(board(true), 4, A_PLAIN_SPELL), "a non-Flow spell was discounted").toBe(4);
  });

  it("NEGATIVE CONTROL: no discount without a Stargazer on the board", () => {
    expect(flowPrice(board(false), 4)).toBe(4);
  });

  it("reads YOUR board, so the opponent's Stargazer does not help you", () => {
    // **Both zones, deliberately.** `controlsStargazer` walks bases AND
    // battlefields, so a fixture that only puts the enemy's copy at a battlefield
    // leaves the base branch unexercised — measured, a mutant that read the
    // opponent's BASE survived exactly that.
    const atBattlefield = makeState();
    atBattlefield.battlefields[0]!.units = { p2: [realUnitInstance(STARGAZER)] };
    expect(flowPrice(atBattlefield, 4), "an enemy Stargazer at a battlefield discounted us").toBe(4);

    const inBase = makeState();
    inBase.players[1]!.baseUnits = [realUnitInstance(STARGAZER)];
    expect(flowPrice(inBase, 4), "an enemy Stargazer in base discounted us").toBe(4);
  });

  it("...and finds YOURS in either zone", () => {
    // The positive control on the same walk, so neither branch can rot unnoticed.
    const inBase = makeState();
    inBase.players[0]!.baseUnits = [realUnitInstance(STARGAZER)];
    expect(flowPrice(inBase, 4), "a Stargazer in your base was not found").toBe(2);
  });
});

describe("Tornado Warrior (VEN-099): empower on a FACE-DOWN play, disempower at end of turn", () => {
  function board(): { state: GameState; warrior: UnitInstance; ally: UnitInstance } {
    const warrior = realUnitInstance(TORNADO_WARRIOR);
    const ally = makeUnit({ instanceId: "ally" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [warrior, ally] };
    return { state, warrior, ally };
  }

  it("empowers something at his battlefield when played from face down", () => {
    const { state, warrior, ally } = board();
    const after = answerDecisions(
      playUnitTrigger(state, warrior, 0, { battlefieldId: "bf1" }, { fromHidden: true }),
      (options) => options.find((o) => o.instanceId === ally.instanceId)!.id,
    );
    expect(isEmpowered(after, ally.instanceId), "nothing was empowered").toBe(true);
  });

  it("does NOTHING on an ordinary play — 'from face down' is printed", () => {
    // **The question must not be ASKED**, which is a stronger claim than "nothing
    // was empowered": `answerDecisions` defaults to the first option and the first
    // option is the decline, so a wrongly-raised question produces an identical
    // board. Measured — that mutant survived the outcome-only assertion.
    const { state, warrior, ally } = board();
    const held = playUnitTrigger(state, warrior, 0, { battlefieldId: "bf1" }, {});

    expect(held.pendingDecisions.map((d) => d.kind), "an ordinary play raised the offer").not.toContain(
      "VEN-099-empower",
    );
    // ...and the outcome, taking the FIRST non-decline answer if one somehow exists.
    const after = answerDecisions(held, (options) => options[1]?.id ?? options[0]!.id);
    expect(isEmpowered(after, ally.instanceId), "an ordinary play empowered").toBe(false);
  });

  it("the status is stripped at END OF TURN", () => {
    const { state, warrior, ally } = board();
    const empowered = answerDecisions(
      playUnitTrigger(state, warrior, 0, { battlefieldId: "bf1" }, { fromHidden: true }),
      (options) => options.find((o) => o.instanceId === ally.instanceId)!.id,
    );
    expect(isEmpowered(empowered, ally.instanceId), "positive control failed").toBe(true);

    const ended = runEnd({ ...empowered, phase: "Action" });

    expect(isEmpowered(ended, ally.instanceId), "the delayed disempower never ran").toBe(false);
    expect(ended.disempowerAtEndOfTurn, "the armed list was not cleared").toEqual([]);
  });

  it("does not strip a permanent that was Empowered by something ELSE", () => {
    // The list is what says which objects to strip, so a unit Empowered by any
    // other means keeps the status through the turn.
    const state = makeState({ phase: "Action" });
    const other = makeUnit({ instanceId: "other" });
    state.battlefields[0]!.units = { p1: [other] };
    const empowered = { ...state, players: state.players } as GameState;
    const withStatus = answerDecisions(resolveHeldTriggers(empowerFor(empowered, other.instanceId)));

    const ended = runEnd({ ...withStatus, phase: "Action" });

    expect(isEmpowered(ended, other.instanceId), "an unrelated Empowered unit was stripped").toBe(true);
  });

  it("offers only things at HIS battlefield", () => {
    const { state, warrior } = board();
    const elsewhere = makeUnit({ instanceId: "elsewhere" });
    state.battlefields[1]!.units = { p1: [elsewhere] };

    const held = playUnitTrigger(state, warrior, 0, { battlefieldId: "bf1" }, { fromHidden: true });
    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-099-empower");
    expect(decision, "nothing was parked").toBeDefined();

    expect(optionsFor(held, decision!).map((o) => o.instanceId), "a unit elsewhere was offered").not.toContain(
      elsewhere.instanceId,
    );
  });
});

/** Empowers a permanent directly — for the control that proves the end-of-turn
 *  sweep strips only what Tornado Warrior armed. */
function empowerFor(state: GameState, instanceId: string): GameState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return { ...state, players: state.players, battlefields: state.battlefields.map((bf) => ({
    ...bf,
    units: Object.fromEntries(
      Object.entries(bf.units).map(([owner, units]) => [owner, units.map((u) => (u.instanceId === instanceId ? { ...u, empowered: true as const } : u))]),
    ),
  })) };
}

describe("Up from the Deep (VEN-100): two Tentacle tokens from Bilgewater", () => {
  it("plays exactly two, at 1 Might each", () => {
    const state = makeState();
    const after = castSpell(state, UP_FROM_THE_DEEP, 0, {});

    const tentacles = ownUnits(after, 0).filter((u) => u.defId === createToken(TENTACLE_TOKEN).defId);
    expect(tentacles.length, "the wrong number of Tentacles arrived").toBe(2);
    expect(tentacles.every((u) => u.might === 1), "a Tentacle is not 1 Might").toBe(true);
  });

  it("...carrying BOTH printed tags — the creature type AND the region", () => {
    // "A Tentacle unit token FROM BILGEWATER". Nothing reads Bilgewater today, so
    // this is fidelity — and a region tag a later set asks about must already be
    // there, which is the silently-wrong shape this repo keeps finding.
    const state = makeState();
    const after = castSpell(state, UP_FROM_THE_DEEP, 0, {});
    const tentacle = ownUnits(after, 0).find((u) => u.defId === createToken(TENTACLE_TOKEN).defId)!;

    expect(tentacle.tags).toContain("Tentacle");
    expect(tentacle.tags, "the region tag was dropped").toContain("Bilgewater");
  });

  it("both land at the chosen battlefield when one is named", () => {
    const state = makeState();
    state.battlefields[0]!.controllerId = "p1";
    const after = castSpell(state, UP_FROM_THE_DEEP, 0, { destinationBattlefieldId: "bf1" });

    expect(after.battlefields[0]!.units.p1?.length, "they did not both arrive at the battlefield").toBe(2);
  });
});

describe("Gust Monk (VEN-101): banish from ANY trash to grant [Assault 2]", () => {
  function board(): { state: GameState; victim: UnitInstance; enemyTrashCard: ReturnType<typeof spellInstance> } {
    const victim = makeUnit({ instanceId: "victim" });
    const enemyTrashCard = spellInstance(A_PLAIN_SPELL);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [victim] };
    state.players[1]!.trash = [enemyTrashCard];
    return { state, victim, enemyTrashCard };
  }

  it("banishes from the OPPONENT's trash and grants", () => {
    const { state, victim, enemyTrashCard } = board();
    const after = answerDecisions(
      playUnitTrigger(state, realUnitInstance(GUST_MONK), 0, "base", { optionalPowerPaid: true }),
      (options, d) =>
        d.kind === "VEN-101-banish"
          ? options.find((o) => o.instanceId === enemyTrashCard.instanceId)!.id
          : options.find((o) => o.instanceId === victim.instanceId)!.id,
    );

    expect(after.players[1]!.trash, "the enemy trash card survived").toEqual([]);
    expect(after.players[1]!.banished.map((c) => c.instanceId)).toContain(enemyTrashCard.instanceId);
    expect(effectiveKeywords(after, onBoard(after, victim.instanceId)!, 0).Assault).toBe(2);
  });

  it("does NOTHING when the optional cost was declined", () => {
    // **Answered with the first NON-decline option**, not the default: the default
    // is the decline, so a card that wrongly raised the question would produce an
    // identical board. Measured — that mutant survived until this pick changed.
    const { state, victim, enemyTrashCard } = board();
    const held = playUnitTrigger(state, realUnitInstance(GUST_MONK), 0, "base", {});

    expect(held.pendingDecisions.map((d) => d.kind), "an unpaid play raised the offer").not.toContain(
      "VEN-101-banish",
    );

    const after = answerDecisions(held, (options) => options[1]?.id ?? options[0]!.id);
    expect(after.players[1]!.trash.map((c) => c.instanceId), "it banished without paying").toContain(
      enemyTrashCard.instanceId,
    );
    expect(effectiveKeywords(after, onBoard(after, victim.instanceId)!, 0).Assault ?? 0).toBe(0);
  });

  it("declining the banish grants nothing — it is a COST", () => {
    const { state, victim, enemyTrashCard } = board();
    const after = answerDecisions(
      playUnitTrigger(state, realUnitInstance(GUST_MONK), 0, "base", { optionalPowerPaid: true }),
      (options) => options[0]!.id,
    );

    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain(enemyTrashCard.instanceId);
    expect(effectiveKeywords(after, onBoard(after, victim.instanceId)!, 0).Assault ?? 0).toBe(0);
  });
});

describe("Decree of Discord (VEN-107): enemy ORDER units with total Might 5 or less", () => {
  /** VEN-129 Sacred Protector is Order and 6 Might; VEN-117 Disciple of Shen is
   *  Order and 1; VEN-094 Mask Mother is Chaos and 3. */
  function board(): GameState {
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [realUnitInstance("VEN-117")],
      p2: [realUnitInstance("VEN-117"), realUnitInstance("VEN-094")],
    };
    return state;
  }

  const spec = () => effectForCard(spellInstance(DECREE_OF_DISCORD))!.targeting;

  it("carries all three printed narrowings on its SPEC", () => {
    expect(spec()).toMatchObject({ kind: "unitList", min: 0, owner: "enemy", domain: "Order", maxTotalMight: 5 });
  });

  it("offers the enemy Order unit and not the enemy Chaos one", () => {
    const state = board();
    const enemyOrder = state.battlefields[0]!.units.p2![0]!;
    const enemyChaos = state.battlefields[0]!.units.p2![1]!;

    const sets = legalActionTargets(state);

    expect(sets.some((ids) => ids.includes(enemyOrder.instanceId)), "the enemy Order unit was never offered").toBe(true);
    expect(sets.some((ids) => ids.includes(enemyChaos.instanceId)), "an enemy CHAOS unit was offered").toBe(false);
  });

  it("...nor the FRIENDLY Order one", () => {
    const state = board();
    const friendly = state.battlefields[0]!.units.p1![0]!;
    expect(legalActionTargets(state).some((ids) => ids.includes(friendly.instanceId))).toBe(false);
  });

  it("the VALIDATOR refuses a set the enumerator never offered", () => {
    // **The enumerate/execute split, asserted in the direction the pool filter
    // alone cannot cover.** Filtering the candidate pool makes the enumerator
    // offer the right sets; only the check inside `unitListChoiceError` refuses a
    // FORGED one — and a mutant that removed that check survived every
    // enumeration assertion in this block.
    const state = board();
    const enemyChaos = state.battlefields[0]!.units.p2![1]!;
    state.players[0]!.hand = [spellInstance(DECREE_OF_DISCORD)];
    state.players[0]!.channeled = Array.from(
      { length: 6 },
      (_, i) => ({ id: `c${i}`, domain: "Chaos", state: "Ready" }) as RuneCard,
    );

    const legal = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === DECREE_OF_DISCORD);
    expect(legal, "the card was not castable at all — this measures nothing").toBeDefined();

    const forged = { ...legal!, targetUnitInstanceIds: [enemyChaos.instanceId] };
    const { result } = submit(state, forged);

    expect(result, "an enemy CHAOS unit was accepted").not.toMatchObject({ type: "Ok" });
  });

  it("returns what it is given", () => {
    const state = board();
    const enemyOrder = state.battlefields[0]!.units.p2![0]!;

    const after = castSpell(state, DECREE_OF_DISCORD, 0, { targetUnitInstanceIds: [enemyOrder.instanceId] });

    expect(onBoard(after, enemyOrder.instanceId)).toBeUndefined();
    expect(after.players[1]!.hand.map((c) => c.instanceId)).toContain(enemyOrder.instanceId);
  });

  /** Every target SET the enumerator offers for this card, from a board where it
   *  is castable. */
  function legalActionTargets(state: GameState): string[][] {
    const withCard = { ...state } as GameState;
    withCard.players[0]!.hand = [spellInstance(DECREE_OF_DISCORD)];
    withCard.players[0]!.channeled = Array.from(
      { length: 6 },
      (_, i) => ({ id: `c${i}`, domain: "Chaos", state: "Ready" }) as RuneCard,
    );
    return legalActions(withCard)
      .filter((a) => a.type === "PlayCard" && a.card.defId === DECREE_OF_DISCORD)
      .map((a) => [...((a as { targetUnitInstanceIds?: readonly string[] }).targetUnitInstanceIds ?? [])]);
  }
});

describe("Illaoi, Prophet of the Great Kraken (VEN-109): a Tentacle on play AND on score", () => {
  const tentacleDefId = createToken(TENTACLE_TOKEN).defId;

  it("plays one when she arrives", () => {
    const after = playUnitTrigger(makeState(), realUnitInstance(ILLAOI), 0, "base", {});
    expect(ownUnits(after, 0).filter((u) => u.defId === tentacleDefId).length).toBe(1);
  });

  it("...and one when she CONQUERS", () => {
    const illaoi = realUnitInstance(ILLAOI);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [illaoi] };
    expect(ownUnits(conquered(state), 0).filter((u) => u.defId === tentacleDefId).length).toBe(1);
  });

  it("...and one when she HOLDS — 'when I score' is BOTH methods", () => {
    // 469 makes Scoring the umbrella and 470 says "from either method". A version
    // keyed to conquest alone would silently pay nothing on a turn spent holding.
    const illaoi = realUnitInstance(ILLAOI);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [illaoi] };

    const after = resolveHeldTriggers(
      runCleanup(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" })),
    );

    expect(ownUnits(after, 0).filter((u) => u.defId === tentacleDefId).length, "a hold paid nothing").toBe(1);
  });

  it("has +1 Might for each TOKEN unit — not just Tentacles", () => {
    const illaoi = realUnitInstance(ILLAOI);
    const printed = registry.get(ILLAOI);
    expect(printed.type).toBe("Unit");
    const base = (printed as Extract<typeof printed, { type: "Unit" }>).might;

    const state = makeState();
    state.players[0]!.baseUnits = [illaoi, createToken(TENTACLE_TOKEN), { ...makeUnit({ instanceId: "tok" }), isToken: true }];

    expect(mightAt(state, onBoard(state, illaoi.instanceId)!, 0), "a non-Tentacle token did not count").toBe(base + 2);
  });

  it("...and non-token units do not count", () => {
    const illaoi = realUnitInstance(ILLAOI);
    const printed = registry.get(ILLAOI) as Extract<ReturnType<typeof registry.get>, { type: "Unit" }>;
    const state = makeState();
    state.players[0]!.baseUnits = [illaoi, makeUnit({ instanceId: "ordinary" })];

    expect(mightAt(state, onBoard(state, illaoi.instanceId)!, 0)).toBe(printed.might);
  });

  it("her (Overnumbered) print does the same, through the alias", () => {
    const after = playUnitTrigger(makeState(), realUnitInstance(ILLAOI_OVERNUMBERED), 0, "base", {});
    expect(ownUnits(after, 0).filter((u) => u.defId === tentacleDefId).length, "the printing is inert").toBe(1);
  });
});

describe("Zed, Without a Sound (VEN-112): a Clone on conquer, and a swap", () => {
  it("plays a Shadow Clone TO HIS BASE when he conquers", () => {
    const zed = realUnitInstance(ZED_SILENT);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [zed] };

    const after = conquered(state);

    expect(
      after.players[0]!.baseUnits.filter((u) => u.defId === SHADOW_CLONE_TOKEN_DEF_ID).length,
      "no Clone arrived in base",
    ).toBe(1);
  });

  it("swaps places with a Shadow Clone he controls", () => {
    const zed = realUnitInstance(ZED_SILENT);
    const clone = createToken({ name: "Shadow Clone", might: 0, tag: "Shadow Clone" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [zed] };
    state.players[0]!.baseUnits = [clone];
    state.players[0]!.channeled = Array.from(
      { length: 4 },
      (_, i) => ({ id: `c${i}`, domain: "Chaos", state: "Ready" }) as RuneCard,
    );

    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === zed.instanceId,
    );
    expect(activate, "his ability was not offered").toBeDefined();
    const { state: after, result } = submit(state, { ...activate!, targetUnitInstanceId: clone.instanceId } as never);
    expect(result).toMatchObject({ type: "Ok" });

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "Zed did not come home").toContain(zed.instanceId);
    expect(after.battlefields[0]!.units.p1?.map((u) => u.instanceId), "the Clone did not go out").toContain(
      clone.instanceId,
    );
  });

  it("does NOT swap with an ordinary friendly unit", () => {
    // The spec cannot express "a Shadow Clone", so the token filter lives in the
    // resolver — and a non-Clone target resolves to nothing rather than swapping.
    const zed = realUnitInstance(ZED_SILENT);
    const ordinary = makeUnit({ instanceId: "ordinary" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [zed] };
    state.players[0]!.baseUnits = [ordinary];
    state.players[0]!.channeled = Array.from(
      { length: 4 },
      (_, i) => ({ id: `c${i}`, domain: "Chaos", state: "Ready" }) as RuneCard,
    );

    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === zed.instanceId,
    );
    const { state: after } = submit(state, { ...activate!, targetUnitInstanceId: ordinary.instanceId } as never);

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "it swapped with a non-Clone").toContain(
      ordinary.instanceId,
    );
    expect(after.battlefields[0]!.units.p1?.map((u) => u.instanceId)).toContain(zed.instanceId);
  });
});

describe("Kennen, Storm of Shuriken (VEN-113): Burn 2, then grant [Flow]", () => {
  it("burns two on arrival", () => {
    const state = makeState();
    state.players[0]!.deck = [spellInstance(A_PLAIN_SPELL), spellInstance(A_FLOW_SPELL), spellInstance(UP_FROM_THE_DEEP)];

    const after = playUnitTrigger(state, realUnitInstance(KENNEN_SHURIKEN), 0, "base", {});

    expect(after.players[0]!.trash.length, "it burned the wrong number").toBe(2);
    expect(after.players[0]!.deck.length).toBe(1);
  });

  it("grants a trashed spell [Flow] at ITS OWN cost when he conquers", () => {
    // "Equal to its cost" — the grant is priced from the spell's own printed
    // numbers, which is what `replacedCostFor` then reports back.
    const kennen = realUnitInstance(KENNEN_SHURIKEN);
    const spell = spellInstance(A_PLAIN_SPELL);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [kennen] };
    state.players[0]!.trash = [spell];

    const after = answerDecisions(conquered(state), (options) => options[0]!.id);

    const printed = registry.get(A_PLAIN_SPELL);
    expect(printed.type).toBe("Spell");
    expect(replacedCostFor(after, 0, spell), "no [Flow] permission was granted").toMatchObject({
      energyCost: (printed as Extract<typeof printed, { type: "Spell" }>).energyCost,
      zone: "trash",
    });
  });

  it("is not asked at all with no spell in the trash", () => {
    const kennen = realUnitInstance(KENNEN_SHURIKEN);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [kennen] };
    state.players[0]!.trash = [realUnitInstance(STARGAZER)];

    const held = runCleanup(holdEventTrigger(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" }));

    // Read off BOTH lists: the Cleanup finalizes a held trigger onto the chain, so
    // `pendingTriggers` alone is empty by now whether it was placed or not.
    // Measured — that is exactly how the mutant survived.
    expect(heldDefIds(held), "he was placed with nothing to grant").not.toContain(KENNEN_SHURIKEN);

    // POSITIVE CONTROL on the same instrument: a spell in the trash DOES place him.
    const withSpell = { ...state } as GameState;
    withSpell.players[0]!.trash = [spellInstance(A_PLAIN_SPELL)];
    expect(
      heldDefIds(runCleanup(holdEventTrigger(withSpell, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" }))),
    ).toContain(KENNEN_SHURIKEN);
  });
});

describe("Ocean Drake (VEN-115): an open battlefield, and a non-Dragon bounce", () => {
  it("may be played to an OPEN battlefield", () => {
    // 170.11.b: a battlefield "can be uncontrolled … no player controls them",
    // and `isOpenBattlefield` adds the empty requirement Origins established.
    const state = makeState();
    expect(isOpenBattlefield(state.battlefields[0]!), "the fixture battlefield is not open").toBe(true);
    expect(mayPlaceWithoutPresence(state, 0, OCEAN_DRAKE, state.battlefields[0]!)).toBe(true);
  });

  it("...and NOT to one somebody controls", () => {
    const state = makeState();
    state.battlefields[0]!.controllerId = "p2";
    expect(mayPlaceWithoutPresence(state, 0, OCEAN_DRAKE, state.battlefields[0]!)).toBe(false);
  });

  it("NEGATIVE CONTROL: an ordinary unit gets no such grant", () => {
    const state = makeState();
    expect(mayPlaceWithoutPresence(state, 0, STARGAZER, state.battlefields[0]!)).toBe(false);
  });

  it("bounces a non-Dragon unit", () => {
    const victim = makeUnit({ instanceId: "victim" });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = answerDecisions(playUnitTrigger(state, realUnitInstance(OCEAN_DRAKE), 0, "base", {}), (options) =>
      options.find((o) => o.instanceId === victim.instanceId)!.id,
    );

    expect(onBoard(after, victim.instanceId)).toBeUndefined();
    expect(after.players[1]!.hand.map((c) => c.instanceId)).toContain(victim.instanceId);
  });

  it("never offers a DRAGON — including himself", () => {
    const dragon = makeUnit({ instanceId: "dragon", tags: ["Dragon"] });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [dragon] };

    const drake = realUnitInstance(OCEAN_DRAKE);
    const held = playUnitTrigger(state, drake, 0, "base", {});
    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-115-bounce");

    if (decision) {
      const offered = optionsFor(held, decision).map((o) => o.instanceId);
      expect(offered, "a Dragon was offered").not.toContain(dragon.instanceId);
      expect(offered, "he offered to bounce himself").not.toContain(drake.instanceId);
    }
    // With only Dragons on the board the offer collapses to a lone Decline, which
    // `advanceDecisions` executes silently — so the absence of a decision is the
    // same claim, and the branch above covers the case where one survives.
    expect(onBoard(answerDecisions(held), dragon.instanceId), "a Dragon was bounced").toBeDefined();
  });
});

describe("coverage sees the wave", () => {
  it("all nine report implemented, and VEN-182 with them", () => {
    for (const id of [
      STARGAZER,
      TORNADO_WARRIOR,
      UP_FROM_THE_DEEP,
      GUST_MONK,
      DECREE_OF_DISCORD,
      ILLAOI,
      ZED_SILENT,
      KENNEN_SHURIKEN,
      OCEAN_DRAKE,
      ILLAOI_OVERNUMBERED,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });

  it("Chaos is finished apart from its one PARTIAL", () => {
    // VEN-110 Mel, Defiant Soul — `[Empower] — Discard a spell` is a compound cost
    // this engine cannot price (`ActivationCost.discard` counts any cards), so she
    // waits with the other five partials.
    expect(isCardImplemented(registry.get("VEN-110"))).toBe(false);
  });
});
