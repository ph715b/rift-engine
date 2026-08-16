import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { replacedCostFor } from "../src/engine/replaced-costs.js";
import { parseFlowCost } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance } from "../src/model/card.js";
import { makeState, makeUnit } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * `[Flow]` — rule **829**, read against `pdftotext -q -raw`.
 *
 * > 829.1.b "You may play this from your trash for its flow cost. Then banish it."
 * > 829.1.c "Flow is formatted as 'Flow [Cost]'"
 * > 829.1.c.1 "The cost is an alternate cost that replaces the base cost."
 * > 829.1.a "Flow is present on Spells."
 *
 * **Nothing new was built for it**, which is the finding worth pinning as much as
 * the behaviour: an alternate cost served from the TRASH is what
 * `replaced-costs.ts` has done since Undying Legion, banishing is
 * `effect-helpers.banishCard`, and the cost is printed on the card so it parses.
 * These tests therefore check the SEAMS — that the printed cost is read, that the
 * permission appears only from the trash, and that the spell is banished rather
 * than trashed — rather than re-testing the machinery underneath.
 */

const registry = defaultCardRegistry();

const TWILIGHT_SHROUD = "VEN-031"; // [Flow] 2 Energy, no rune
const BRITTLE_STEEL = "VEN-003"; // [Flow] 4 Energy + 1 Fury
const DEATH_MARK = "VEN-144"; // [Flow] 1 Energy + 2 rainbow
const LACERATE = "VEN-127"; // [Flow] 4 Energy + 2 Order
const STARGAZER = "VEN-098"; // a UNIT that only DISCOUNTS Flow spells
const KENNEN = "VEN-113"; // a UNIT that only GRANTS Flow

const spell = (defId: string) => createCardInstance(registry.get(defId)) as SpellInstance;

/** A caster with the spell in TRASH and enough banked Energy to pay any Flow
 *  cost in the set, so the permission is the only thing under test. */
function casterWithSpellInTrash(defId: string): { state: GameState; card: SpellInstance } {
  const card = spell(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.trash = [card];
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Fury: 5, Body: 5, Order: 5, Calm: 5, Mind: 5, Chaos: 5 };
  state.players[0]!.floatingRainbowPower = 5;
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "ally0", might: 3 })];
  return { state, card };
}

describe("[Flow] reads the printed cost (829.1.c)", () => {
  it("parses every shape the set prints, including multi-rune and rainbow", () => {
    expect(parseFlowCost("[Flow] :rb_energy_2:")).toEqual({ energy: 2, powerCost: 0, powerDomain: null });
    expect(parseFlowCost("[Flow] :rb_energy_4::rb_rune_fury:")).toEqual({
      energy: 4,
      powerCost: 1,
      powerDomain: "Fury",
    });
    // Two runes of one domain — Lacerate. A parser reading only the first would
    // make it a rune cheaper than printed, the direction this repo never ships.
    expect(parseFlowCost("[Flow] :rb_energy_4::rb_rune_order::rb_rune_order:")).toEqual({
      energy: 4,
      powerCost: 2,
      powerDomain: "Order",
    });
    // Rainbow is `null`, the spelling every payment site already reads as "any
    // domain" — so it needs no new machinery.
    expect(parseFlowCost("[Flow] :rb_energy_1::rb_rune_rainbow::rb_rune_rainbow:")).toEqual({
      energy: 1,
      powerCost: 2,
      powerDomain: null,
    });
  });

  it("refuses a cost it cannot read rather than half-reading it", () => {
    // `parseEquipCost`'s rule, for the same reason: half a cost is CHEAPER than
    // the printed one, and an alternate cost that is too cheap is a card that
    // plays out of the trash for free.
    expect(parseFlowCost("[Flow] equal to its cost this turn."), "a prose cost is not a price").toBeUndefined();
    expect(parseFlowCost("[Flow] :rb_rune_fury::rb_rune_order:"), "two DIFFERENT domains").toBeUndefined();
    expect(parseFlowCost("no keyword here")).toBeUndefined();
  });

  it("puts the cost on all 15 spells that print the keyword, and on no unit", () => {
    const withFlow = registry.all().filter((d) => d.type === "Spell" && d.flowCost !== undefined);
    expect(withFlow.length, "the sweep found a different number — re-read the set").toBe(15);
    // 829.1.a: "Flow is present on Spells." Both units that mention it are
    // stripped in GRANTED_ONLY_KEYWORDS, so neither parses the keyword at all.
    for (const defId of [STARGAZER, KENNEN]) {
      const unit = registry.get(defId);
      expect(unit.type, `${defId} should be the referencing UNIT`).toBe("Unit");
      expect("keywords" in unit && unit.keywords.Flow, `${defId} must not HOLD [Flow]`).toBeUndefined();
    }
  });
});

describe("[Flow] grants a trash permission and nothing else (829.1.b, 829.1.b.2)", () => {
  it("offers the spell from the trash, priced at its Flow cost", () => {
    const { state, card } = casterWithSpellInTrash(BRITTLE_STEEL);
    const replaced = replacedCostFor(state, 0, card);
    expect(replaced, "no Flow permission was offered from the trash").not.toBeNull();
    expect(replaced).toEqual({ energyCost: 4, powerCost: 1, powerDomain: "Fury", zone: "trash" });
  });

  it("offers NOTHING while the spell is in hand — the zone is the permission", () => {
    // 366.1: a passive ability of a card outside the board self-describes its
    // context, and 829.1.b names the trash. `replacedCostFor` checks zone
    // membership itself so a permission for a card elsewhere cannot be handed out.
    const card = spell(BRITTLE_STEEL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    expect(replacedCostFor(state, 0, card), "a Flow cost was offered for a card in HAND").toBeNull();
  });

  it("gives a spell with no [Flow] no trash permission at all", () => {
    // The negative control. Without it every assertion here would pass against a
    // `replacedCostFor` that had started saying yes to everything in the trash.
    const plain = registry.all().find((d) => d.type === "Spell" && d.flowCost === undefined);
    expect(plain, "no Flow-less spell in the pool — this control checks nothing").toBeDefined();
    const card = createCardInstance(plain!) as SpellInstance;
    const state = makeState({ phase: "Action" });
    state.players[0]!.trash = [card];
    expect(replacedCostFor(state, 0, card)).toBeNull();
  });
});

describe("[Flow] banishes the spell instead of trashing it (829.1.b)", () => {
  const flowPlayOf = (state: GameState, instanceId: string): PlayCardAction | undefined =>
    legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === instanceId && a.replacedCostPaid === true,
    );

  it("the played spell ends in `banished`, not back in the trash", () => {
    const { state, card } = casterWithSpellInTrash(TWILIGHT_SHROUD);
    const play = flowPlayOf(state, card.instanceId);
    expect(play, "the Flow play was never offered — this assertion measures nothing").toBeDefined();

    const { state: after, result } = submit(state, play! as never);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const actor = after.players[0]!;
    expect(actor.banished.map((c) => c.instanceId), "the spell was not banished").toContain(card.instanceId);
    expect(actor.trash.map((c) => c.instanceId), "the spell went back to the trash").not.toContain(card.instanceId);
  });

  it("charges the FLOW cost, not the printed one", () => {
    // Death Mark prints 3 Energy and a Fury pip; its Flow cost is 1 Energy and
    // two RAINBOW. Asserting the Energy delta is what says the alternate cost
    // replaced the base rather than being added to or discounted from it
    // (829.1.c.1).
    const { state, card } = casterWithSpellInTrash(DEATH_MARK);
    const printed = registry.get(DEATH_MARK);
    const play = flowPlayOf(state, card.instanceId);
    expect(play, "the Flow play was never offered").toBeDefined();

    const before = state.players[0]!.floatingEnergy;
    const { state: after, result } = submit(state, play! as never);
    expect(result).toMatchObject({ type: "Ok" });
    const spent = before - after.players[0]!.floatingEnergy;
    expect(spent, "the Flow Energy was not what was charged").toBe(card.flowCost!.energy);
    expect(spent, "the PRINTED cost was charged instead").not.toBe(
      "energyCost" in printed ? printed.energyCost : -1,
    );
  });

  it("a Flow spell cast from HAND still trashes normally", () => {
    // The half that says the banish is gated on the Flow COST having been paid
    // rather than on the card carrying the keyword. Without this, every Flow
    // spell would banish itself on an ordinary cast and the trash would never
    // see it.
    const card = spell(LACERATE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.floatingPower = { Fury: 5, Body: 5, Order: 5, Calm: 5, Mind: 5, Chaos: 5 };
    state.players[0]!.floatingRainbowPower = 5;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "ally0", might: 3 })];

    const play = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === card.instanceId && a.replacedCostPaid !== true,
    );
    expect(play, "the ordinary hand play was never offered").toBeDefined();
    const { state: after, result } = submit(state, play! as never);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.trash.map((c) => c.instanceId), "a hand cast should trash, not banish").toContain(
      card.instanceId,
    );
    expect(after.players[0]!.banished.map((c) => c.instanceId)).not.toContain(card.instanceId);
  });
});
