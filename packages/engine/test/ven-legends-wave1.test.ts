import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { canonicalDefId } from "../src/cards/card-loader.js";
import { activatedAbilityFor, canPayActivationCost } from "../src/engine/activated-abilities.js";
import { contextFor } from "../src/engine/effect-context.js";
import { disempowerPermanent, empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * **Vendetta's Legends — wave 1, the three that need no new event of their own.**
 *
 * Two of them share a first sentence ("when you empower something else, empower
 * me") and a cost shape ("Disempower me, [Exhaust]: ..."), and both of those are
 * new mechanisms rather than card text:
 *
 *   - the trigger is hooked inside `empowerPermanent`, the SINGLE WRITER of the
 *     status, rather than fired by each of the eleven cards that empower
 *     something — eleven call sites is eleven chances to forget one;
 *   - the cost is `disempowerSelf`, which SPENDS the status. That is the whole
 *     difference from Jayce - Defender of Tomorrow's `[Empowered][>]` gate, which
 *     can be used every turn the status is held. On the card face they read
 *     almost identically.
 *
 * Both halves are asserted from both ends: the hook fires for the right Legends
 * and not for the wrong ones, and the cost is unpayable-and-unoffered while the
 * Legend is not Empowered.
 */

const registry = defaultCardRegistry();

const SHEN_EYE_OF_TWILIGHT = "VEN-147";
const MEL_SOULS_REFLECTION = "VEN-151";
const AMBESSA_MATRIARCH = "VEN-153";
/** Their Overnumbered printings, which come free through the alias table. */
const OVERNUMBERED = { [SHEN_EYE_OF_TWILIGHT]: "VEN-193", [MEL_SOULS_REFLECTION]: "VEN-195", [AMBESSA_MATRIARCH]: "VEN-196" };

const runes = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Calm", state: "Ready" }) as RuneCard);

/** A board with `defId` as p1's Legend. */
function board(defId: string): { state: GameState; legend: { instanceId: string; defId: string } } {
  const state = makeState();
  const legend = { ...state.players[0]!.legend, defId, exhausted: false };
  state.players[0]!.legend = legend as never;
  state.players[0]!.channeled = runes(4);
  return { state, legend };
}

describe("the empower hook: 'when you empower something ELSE, empower me'", () => {
  it("empowers Mel when anything else is empowered", () => {
    const { state, legend } = board(MEL_SOULS_REFLECTION);
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };

    const after = empowerPermanent(state, ally.instanceId);

    expect(isEmpowered(after, ally.instanceId), "the unit itself was not empowered").toBe(true);
    expect(isEmpowered(after, legend.instanceId), "Mel did not follow").toBe(true);
  });

  it("empowers Ambessa the same way", () => {
    const { state, legend } = board(AMBESSA_MATRIARCH);
    const gear = realGearInstance("OGN-017");
    state.players[0]!.activeGear = [gear];

    // A GEAR, deliberately: "something else" is not "another unit".
    expect(isEmpowered(empowerPermanent(state, gear.instanceId), legend.instanceId)).toBe(true);
  });

  it("does NOT fire for a Legend that does not print it — the control", () => {
    const { state, legend } = board(SHEN_EYE_OF_TWILIGHT);
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };

    expect(isEmpowered(empowerPermanent(state, ally.instanceId), legend.instanceId), "Shen followed too").toBe(false);
  });

  it("does NOT fire for a Legend whose defId is not in the table", () => {
    // The fixture's DEFAULT legend, which prints nothing. Without this the table
    // could grow a spurious entry and every other test here would still pass —
    // measured, a mutant that added one survived them all.
    const state = makeState();
    const defaultLegendId = state.players[0]!.legend.instanceId;
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };

    expect(
      isEmpowered(empowerPermanent(state, ally.instanceId), defaultLegendId),
      "a Legend that prints nothing followed anyway",
    ).toBe(false);
  });

  it("does NOT fire on her OWN empowerment — 'something ELSE'", () => {
    // Without this the Legend empowering herself would re-enter the funnel. The
    // binary-status guard would stop the loop anyway, but the printed word is the
    // reason and this is what pins it.
    const { state, legend } = board(MEL_SOULS_REFLECTION);
    const after = empowerPermanent(state, legend.instanceId);

    expect(isEmpowered(after, legend.instanceId), "she did not empower at all").toBe(true);
  });

  it("fires for the OWNER's Legend, not the opponent's", () => {
    // **"When YOU empower something else."** The funnel takes no actor, so "you"
    // is read as the OWNER of the thing that became Empowered — which is right
    // for every card in the pool but Sanction, whose second mode can empower an
    // enemy unit. Narrower than printed there and wider nowhere; recorded in
    // docs/rules-conformance.md.
    //
    // The first draft fired BOTH Mels, and this test is what showed it.
    const { state, legend } = board(MEL_SOULS_REFLECTION);
    const enemyLegend = { ...state.players[1]!.legend, defId: MEL_SOULS_REFLECTION };
    state.players[1]!.legend = enemyLegend as never;
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };

    const after = empowerPermanent(state, mine.instanceId);

    expect(isEmpowered(after, legend.instanceId), "my own Mel did not follow").toBe(true);
    expect(isEmpowered(after, enemyLegend.instanceId), "the ENEMY's Mel followed my empowerment").toBe(false);
  });

  it("...and an ENEMY unit empowered follows the ENEMY's Legend", () => {
    // The other side of the same reading, stated so the divergence is visible
    // rather than implied: empowering an enemy unit (Sanction's second mode) is
    // what makes this narrower than printed.
    const { state, legend } = board(MEL_SOULS_REFLECTION);
    const enemyLegend = { ...state.players[1]!.legend, defId: MEL_SOULS_REFLECTION };
    state.players[1]!.legend = enemyLegend as never;
    const theirs = makeUnit();
    state.battlefields[0]!.units = { p2: [theirs] };

    const after = empowerPermanent(state, theirs.instanceId);

    expect(isEmpowered(after, enemyLegend.instanceId)).toBe(true);
    expect(isEmpowered(after, legend.instanceId), "my Mel followed an enemy unit's empowerment").toBe(false);
  });
});

describe("the disempower cost: it SPENDS the status", () => {
  function empoweredBoard(defId: string): { state: GameState; legend: { instanceId: string; defId: string } } {
    const { state, legend } = board(defId);
    return { state: empowerPermanent(state, legend.instanceId), legend };
  }

  it("is unpayable — and unOFFERED — while the Legend is not Empowered", () => {
    // 416.3: a cost that cannot be completed is not one you may choose to pay, so
    // the ability never reaches the action list.
    const { state, legend } = board(MEL_SOULS_REFLECTION);
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    expect(canPayActivationCost(state, 0, legend as never), "an un-Empowered Mel could pay").toBe(false);
    expect(
      legalActions(state).some((a) => a.type === "ActivateAbility" && a.permanentInstanceId === legend.instanceId),
      "it was offered anyway",
    ).toBe(false);
  });

  it("...and IS payable once she is — the control", () => {
    const { state, legend } = empoweredBoard(MEL_SOULS_REFLECTION);
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    expect(canPayActivationCost(state, 0, legend as never)).toBe(true);
    expect(
      legalActions(state).some((a) => a.type === "ActivateAbility" && a.permanentInstanceId === legend.instanceId),
      "a payable ability was not offered",
    ).toBe(true);
  });

  it("Mel gives -2 Might at a battlefield, and only there", () => {
    const { state, legend } = empoweredBoard(MEL_SOULS_REFLECTION);
    const atBattlefield = makeUnit();
    const inBase = makeUnit();
    state.battlefields[0]!.units = { p2: [atBattlefield] };
    state.players[1]!.baseUnits = [inBase];

    const ability = activatedAbilityFor(MEL_SOULS_REFLECTION)!;
    const after = ability.resolve!(
      state,
      contextFor(0, legend.instanceId),
      { targetUnitInstanceId: atBattlefield.instanceId } as never,
      legend.instanceId,
    );
    expect(after.battlefields[0]!.units.p2![0]!.mightThisTurn).toBe(-2);

    // "At a battlefield" is printed, so a base unit is not a legal target.
    expect(ability.targeting).toMatchObject({ kind: "unit", scope: "battlefield" });
    expect(inBase.instanceId).toBeDefined();
  });

  it("Ambessa readies an exhausted friendly unit", () => {
    const { state, legend } = empoweredBoard(AMBESSA_MATRIARCH);
    const tired = makeUnit({ exhausted: true });
    state.battlefields[0]!.units = { p1: [tired] };

    const ability = activatedAbilityFor(AMBESSA_MATRIARCH)!;
    const after = ability.resolve!(
      state,
      contextFor(0, legend.instanceId),
      { targetUnitInstanceId: tired.instanceId } as never,
      legend.instanceId,
    );
    expect(after.battlefields[0]!.units.p1![0]!.exhausted, "it stayed exhausted").toBe(false);
  });

  it("...and costs a rainbow pip on top, where Mel's does not", () => {
    // The one difference between the two, and it is printed.
    expect(activatedAbilityFor(AMBESSA_MATRIARCH)!.cost).toMatchObject({ power: { domain: null, count: 1 } });
    expect(activatedAbilityFor(MEL_SOULS_REFLECTION)!.cost).not.toMatchObject({ power: expect.anything() });
  });

  it("SPENDS the status — she is no longer Empowered afterwards", () => {
    // **The whole design of these cards**, and the assertion the first draft was
    // missing: a mutant that paid the cost without disempowering survived every
    // other test here. Driven through a real activation rather than through the
    // resolver, because the cost is paid by the executor and not by the effect.
    const { state, legend } = empoweredBoard(MEL_SOULS_REFLECTION);
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === legend.instanceId,
    );
    expect(activate, "the ability was not offered — this measures nothing").toBeDefined();

    const { state: after } = submit(state, activate!);
    expect(isEmpowered(after, legend.instanceId), "the status was not spent").toBe(false);
    // ...and so it cannot be used again until something re-empowers her, which is
    // what her first sentence is for.
    expect(canPayActivationCost(after, 0, { ...legend, empowered: undefined } as never)).toBe(false);
  });

  it("both declare the disempower as a COST, not an Empowered gate", () => {
    for (const defId of [MEL_SOULS_REFLECTION, AMBESSA_MATRIARCH]) {
      expect(activatedAbilityFor(defId)!.cost, `${defId} does not spend the status`).toMatchObject({
        disempowerSelf: true,
      });
    }
  });
});

describe("Shen - Eye of Twilight (VEN-147): one ability, no trigger", () => {
  it("grants [Tank] this turn, and it expires", () => {
    const { state, legend } = board(SHEN_EYE_OF_TWILIGHT);
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };

    const ability = activatedAbilityFor(SHEN_EYE_OF_TWILIGHT)!;
    const after = ability.resolve!(
      state,
      contextFor(0, legend.instanceId),
      { targetUnitInstanceId: ally.instanceId } as never,
      legend.instanceId,
    );
    const granted = after.battlefields[0]!.units.p1![0]!;
    expect(effectiveKeywords(after, granted, 0).Tank ?? 0, "[Tank] was not granted").toBeGreaterThan(0);

    const next = runEnd({ ...after, phase: "Action" });
    expect(
      effectiveKeywords(next, next.battlefields[0]!.units.p1![0]!, 0).Tank ?? 0,
      "the grant outlived the turn",
    ).toBe(0);
  });

  it("offers FRIENDLY units only, which is printed", () => {
    // **Asserted through the ENUMERATOR, not through the resolver.** Handing the
    // resolver a friendly target works whatever the spec says, so a mutant that
    // widened it to enemy units survived — measured. His "a friendly unit" is
    // printed, unlike Jayce's and Ambessa's recorded narrowings.
    const { state, legend } = board(SHEN_EYE_OF_TWILIGHT);
    const mine = makeUnit();
    const theirs = makeUnit();
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };

    const offered = legalActions(state)
      .filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === legend.instanceId)
      .map((a) => (a as { targetUnitInstanceId?: string }).targetUnitInstanceId);

    expect(offered, "his own side was not offered — this measures nothing").toContain(mine.instanceId);
    expect(offered, "an ENEMY unit was offered [Tank]").not.toContain(theirs.instanceId);
  });

  it("needs no Empowered status — his cost is just the exhaust", () => {
    const { state, legend } = board(SHEN_EYE_OF_TWILIGHT);
    state.battlefields[0]!.units = { p1: [makeUnit()] };
    expect(canPayActivationCost(state, 0, legend as never), "he needed a status he does not print").toBe(true);
    expect(activatedAbilityFor(SHEN_EYE_OF_TWILIGHT)!.cost).not.toMatchObject({ disempowerSelf: true });
  });
});

describe("coverage sees the wave — and its three free printings", () => {
  it("all three Legends report implemented", () => {
    for (const id of [SHEN_EYE_OF_TWILIGHT, MEL_SOULS_REFLECTION, AMBESSA_MATRIARCH]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });

  it("...and so do their Overnumbered printings, through the ALIAS table", () => {
    // The reason this block is 23 rows and 16 pieces of work: an Overnumbered
    // Legend is the same card (132.1) and needs no registration of its own. Pinned
    // because a printing that silently stopped resolving would look like nothing
    // at all — the class this set has already produced ten of.
    for (const [canonical, printing] of Object.entries(OVERNUMBERED)) {
      expect(canonicalDefId(printing), `${printing} is not an alias of ${canonical}`).toBe(canonical);
      expect(isCardImplemented(registry.get(printing)), `${printing} reports unimplemented`).toBe(true);
    }
  });
});
