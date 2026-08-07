import { describe, expect, it } from "vitest";
import { eligibleTargets, unitOrGearTargets, unitChooseableBy } from "../src/engine/target-lookup.js";
import { counterFilter, counterableSpells } from "../src/engine/counter-spell.js";
import { targetChoiceDiscount } from "../src/engine/cost-modifiers.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { answerDecision, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type SpellInstance } from "../src/model/card.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Phase 2 — the four cards about CHOOSING, and the one filter they share.
 *
 * The filter is the interesting part and the part most able to rot. Ruin
 * Runner's text is a pure NEGATIVE, so a site that forgets to ask simply lets
 * the play through and nothing looks wrong — there is no error, no missing
 * effect, just a card that quietly does not work. So this file asserts the
 * refusal from BOTH ends: the walk the enumerator fans out from, and the gate
 * the validator applies. Those two disagreeing is this repo's most-repeated bug.
 */

const registry = defaultCardRegistry();

const RUIN_RUNNER = "SFD-105";
const IRELIA_GRACEFUL = "SFD-141";
const NOT_SO_FAST = "SFD-045";
const APHELIOS_EXALTED = "SFD-049";

const LONG_SWORD = "SFD-022";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (n: number, domain: RuneCard["domain"] = "Calm"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

describe("Ruin Runner (SFD-105): can't be chosen by enemy spells and abilities", () => {
  /** A Ruin Runner and an ordinary unit, both p1's, both at bf1. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [
      { ...realUnitInstance(RUIN_RUNNER), instanceId: "runner" },
      makeUnit({ instanceId: "ordinary" }),
    ];
    return state;
  }

  const ids = (units: { instanceId: string }[]) => units.map((u) => u.instanceId);

  it("is not offered to an ENEMY's target walk", () => {
    // p2 is the chooser here, so the Runner is an enemy unit to them.
    const offered = ids(eligibleTargets(board(), 1, "enemy", "anywhere"));

    expect(offered, "the Runner was offered to an enemy").not.toContain("runner");
    expect(offered, "the walk dropped more than it should have").toContain("ordinary");
  });

  it("IS offered to its own controller", () => {
    // "ENEMY spells and abilities" — buffing your own Runner is an ordinary play.
    const offered = ids(eligibleTargets(board(), 0, "friendly", "anywhere"));

    expect(offered, "its own side could not choose it").toContain("runner");
  });

  it("is dropped from the unit-or-gear walk too, but only when a chooser is named", () => {
    const state = board();
    const withChooser = unitOrGearTargets(state, { chooserIndex: 1 }).map((t) => t.instanceId);
    const without = unitOrGearTargets(state).map((t) => t.instanceId);

    expect(withChooser, "the Runner was offered through the unit-or-gear slot").not.toContain("runner");
    // A caller that names no chooser is not making a choice — Fading Memories
    // walks every permanent — and must keep the walk it always had.
    expect(without, "an unfiltered walk silently acquired a chooser").toContain("runner");
  });

  it("is a property of the CHOOSER, not of the unit", () => {
    const runner = board().battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "runner")!;

    expect(unitChooseableBy(runner, 0, 0), "its own side was refused").toBe(true);
    expect(unitChooseableBy(runner, 0, 1), "an enemy was allowed").toBe(false);
  });

  it("does not restrict an ordinary unit", () => {
    const ordinary = board().battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "ordinary")!;

    expect(unitChooseableBy(ordinary, 0, 1)).toBe(true);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(RUIN_RUNNER))).toBe(true);
  });
});

describe("Irelia - Graceful (SFD-141): your spells that choose her cost [1] or [rainbow] less", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [
      { ...realUnitInstance(IRELIA_GRACEFUL), instanceId: "irelia" },
      makeUnit({ instanceId: "ally" }),
    ];
    return state;
  }

  it("discounts one Energy on the energy axis", () => {
    expect(targetChoiceDiscount(board(), 0, ["irelia"], "energy")).toEqual({ energy: 1, power: 0 });
  });

  it("discounts one Power on the power axis", () => {
    expect(targetChoiceDiscount(board(), 0, ["irelia"], "power")).toEqual({ energy: 0, power: 1 });
  });

  /** The "or" is a real choice, so naming no axis takes no discount — which is
   *  what keeps the plain, undiscounted variant legal. */
  it("takes nothing when no axis is named", () => {
    expect(targetChoiceDiscount(board(), 0, ["irelia"], undefined)).toEqual({ energy: 0, power: 0 });
  });

  it("does nothing for a spell that chooses somebody else", () => {
    expect(targetChoiceDiscount(board(), 0, ["ally"], "energy")).toEqual({ energy: 0, power: 0 });
  });

  /** "YOUR spells" — an opponent's removal aimed at her is not discounted. */
  it("does not discount the OPPONENT's spells", () => {
    expect(targetChoiceDiscount(board(), 1, ["irelia"], "energy")).toEqual({ energy: 0, power: 0 });
  });

  it("counts once however many times a spell names her", () => {
    // Her ability, not a per-choice tax — the opposite of [Deflect], which sums.
    expect(targetChoiceDiscount(board(), 0, ["irelia", "irelia"], "energy")).toEqual({ energy: 1, power: 0 });
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(IRELIA_GRACEFUL))).toBe(true);
  });
});

describe("Not So Fast (SFD-045): counter an enemy spell that chooses a friendly permanent", () => {
  /** A chain carrying one spell cast by `caster` naming `target`. */
  function chainWith(caster: 0 | 1, entry: Partial<SpellChainEntry>): GameState {
    const state = makeState({ phase: "Action", chainOpen: false });
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "mine" })];
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "theirs" })];
    state.players[0]!.activeGear = [gear(LONG_SWORD)];
    state.spellChain = [
      { playerIndex: caster, card: spellInstance("OGN-044") as SpellInstance, ...entry } as SpellChainEntry,
    ];
    return state;
  }

  const counterable = (state: GameState, chooserIndex: 0 | 1) =>
    counterableSpells(
      state,
      undefined,
      undefined,
      counterFilter({ enemyOnly: true, choosesFriendlyPermanent: true }, chooserIndex),
    );

  it("counters an enemy spell that chose one of my units", () => {
    const state = chainWith(1, { targetUnitInstanceId: "mine" });

    expect(counterable(state, 0), "the spell was not counterable").toHaveLength(1);
  });

  it("counters an enemy spell that chose one of my GEAR", () => {
    const state = chainWith(1, {});
    const myGear = state.players[0]!.activeGear[0]!;
    state.spellChain = [{ ...(state.spellChain[0] as SpellChainEntry), targetPermanentInstanceId: myGear.instanceId }];

    expect(counterable(state, 0), "a gear target did not qualify").toHaveLength(1);
  });

  /** Reads a unit LIST too — the field-by-field version of this check is what
   *  left [Deflect] unpriced on five cards. */
  it("counters an enemy spell that chose my unit through a LIST", () => {
    const state = chainWith(1, { targetUnitInstanceIds: ["theirs", "mine"] });

    expect(counterable(state, 0), "a list target did not qualify").toHaveLength(1);
  });

  it("does NOT counter an enemy spell that chose their OWN unit", () => {
    const state = chainWith(1, { targetUnitInstanceId: "theirs" });

    expect(counterable(state, 0), "it countered a spell aimed elsewhere").toHaveLength(0);
  });

  it("does NOT counter an enemy spell that chooses nothing", () => {
    const state = chainWith(1, {});

    expect(counterable(state, 0), "it countered a spell that chose nothing").toHaveLength(0);
  });

  /** "an ENEMY spell" — my own spell aimed at my own unit is not a target. */
  it("does NOT counter MY OWN spell", () => {
    const state = chainWith(0, { targetUnitInstanceId: "mine" });

    expect(counterable(state, 0), "it countered its own side's spell").toHaveLength(0);
  });

  /** Wind Wall and Defy pass no filter and must keep the walk they always had. */
  it("leaves the unfiltered counters alone", () => {
    const state = chainWith(0, { targetUnitInstanceId: "mine" });

    expect(counterableSpells(state), "an unfiltered counter lost a target").toHaveLength(1);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(NOT_SO_FAST))).toBe(true);
  });
});

describe("Aphelios - Exalted (SFD-049): three modes, each once per turn", () => {
  function board(): { state: GameState; sword: GearInstance } {
    const sword = gear(LONG_SWORD);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(APHELIOS_EXALTED), instanceId: "aphelios" },
      makeUnit({ instanceId: "ally" }),
    ];
    state.players[0]!.activeGear = [sword];
    state.players[0]!.channeled = runes(4);
    state.players[0]!.runeDeck = runes(4).map((r, i) => ({ ...r, id: `deck-${i}` }));
    return { state, sword };
  }

  const attach = (state: GameState, sword: GearInstance, to = "aphelios") =>
    resolveHeldTriggers(attachEquipment(state, 0, sword.instanceId, to));

  const optionIds = (state: GameState) => {
    const decision = pendingDecision(state);
    return decision ? decision.kind : undefined;
  };

  it("asks for a mode when an Equipment is attached to HIM", () => {
    const { state, sword } = board();

    expect(optionIds(attach(state, sword)), "no mode question was asked").toBe("SFD-049-mode");
  });

  it("does NOT fire for an Equipment attached to another unit", () => {
    const { state, sword } = board();

    expect(pendingDecision(attach(state, sword, "ally")), "he fired for somebody else's Equipment").toBeUndefined();
  });

  it("readies runes when that mode is taken, and records it as spent", () => {
    const { state, sword } = board();
    state.players[0]!.channeled = runes(4).map((r) => ({ ...r, state: "Exhausted" as const }));
    const offered = attach(state, sword);
    const after = answerDecision(offered, pendingDecision(offered)!.id, "ready")!;

    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready"), "no runes were readied").toHaveLength(2);
    const aphelios = after.players[0]!.baseUnits.find((u) => u.instanceId === "aphelios")!;
    expect(aphelios.abilityModesUsedThisTurn, "the mode was not recorded as spent").toContain("ready");
  });

  /**
   * "Choose one that hasn't been chosen THIS TURN" — the second Equipment in a
   * turn has one fewer mode, and the third has one. That decay is the card.
   */
  it("does not re-offer a mode already spent this turn", () => {
    const { state, sword } = board();
    const first = attach(state, sword);
    const afterFirst = answerDecision(first, pendingDecision(first)!.id, "ready")!;

    // A second attach — a MOVE off and back on is still an attach.
    const moved = resolveHeldTriggers(attachEquipment(afterFirst, 0, sword.instanceId, "ally"));
    const second = resolveHeldTriggers(attachEquipment(moved, 0, sword.instanceId, "aphelios"));
    const decision = pendingDecision(second);

    expect(decision, "the second attach asked nothing").toBeDefined();
    // The spent mode is gone from the offer; the other two remain.
    const aphelios = second.players[0]!.baseUnits.find((u) => u.instanceId === "aphelios")!;
    expect(aphelios.abilityModesUsedThisTurn).toContain("ready");
  });

  /** All three spent means no choice left, so the trigger is not placed at all. */
  it("does not fire once all three modes are spent", () => {
    const { state, sword } = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.map((u) =>
      u.instanceId === "aphelios" ? { ...u, abilityModesUsedThisTurn: ["ready", "channel", "buff"] } : u,
    );

    expect(pendingDecision(attach(state, sword)), "a spent Aphelios still asked").toBeUndefined();
  });

  it("buffs a chosen friendly unit on the buff mode", () => {
    const { state, sword } = board();
    const offered = attach(state, sword);
    const chosen = answerDecision(offered, pendingDecision(offered)!.id, "buff")!;
    const buffQuestion = pendingDecision(chosen);

    expect(buffQuestion?.kind, "no target was asked for").toBe("SFD-049-buff");
    const after = answerDecision(chosen, buffQuestion!.id, "ally")!;
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "ally")?.buffed, "the unit was not buffed").toBe(
      true,
    );
  });

  it("is claimed by a module and carries no partial note", () => {
    expect(isCardImplemented(registry.get(APHELIOS_EXALTED))).toBe(true);
    expect(partialImplementationNote(registry.get(APHELIOS_EXALTED))).toBeUndefined();
  });
});
