import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { restrictedPowerFor } from "../src/engine/rune-payment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { CardDefinition } from "../src/model/card-definition.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState } from "./fixtures.js";

/**
 * Ornn - Fire Below the Mountain (SFD-189) — "[Exhaust]: [Reaction] — [Add]
 * [rainbow]. Use only to play gear or use gear abilities."
 *
 * A THIRD restricted pool, beside Kai'Sa's `restrictedSpellEnergy` and
 * `restrictedSpellPower`. Rainbow like hers, so no domain is matched — and unlike
 * hers it is spendable on GEAR.
 *
 * The two pools are mutually exclusive by card kind, which is what lets
 * `restrictedPowerFor` pick between them rather than the cost function growing a
 * fourth parameter. The tests below are pointed at that: Ornn's pool must pay for
 * a Gear, and must NOT pay for a Spell or a Unit.
 */

const registry = defaultCardRegistry();
const ORNN = "SFD-189";

type GearDef = Extract<CardDefinition, { type: "Gear" }>;
const isGearDef = (d: CardDefinition): d is GearDef => d.type === "Gear";
/** A gear that really does cost Power — 23 of the 72 do. */
const POWER_GEAR = registry.all().filter(isGearDef).find((d) => d.powerCost === 1 && d.energyCost <= 2)!;

function board(gearPower: number, hand: GearInstance[] = []): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand,
        // No runes at all, so the ONLY way any Power gets paid is the pool.
        channeled: [],
        floatingEnergy: 9,
      }),
      makePlayer("p2"),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: ORNN };
  state.players[0]!.restrictedGearPower = gearPower;
  return state;
}

describe("Ornn's ability banks a gear-only rainbow Power", () => {
  it("is offered, and adds to the pool", () => {
    const state = board(0);
    const activation = legalActions(state).find(
      (a): a is ActivateAbilityAction =>
        a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
    );
    expect(activation, "Ornn's ability was not offered").toBeDefined();

    const after = executeActivateAbility(state, activation!);
    expect(after.players[0]!.restrictedGearPower, "the pool did not grow").toBe(1);
    expect(after.players[0]!.legend.exhausted, "the exhaust was not taken").toBe(true);
  });

  it("is not offered again once exhausted", () => {
    const state = board(0);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    const offered = legalActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
    );
    expect(offered).toHaveLength(0);
  });
});

describe("the pool pays for GEAR and nothing else", () => {
  /** `restrictedPowerFor` is the one accessor all five cost sites use. */
  it("is offered to a Gear, and never to a Spell or a Unit", () => {
    const actor = { restrictedSpellPower: 5, restrictedGearPower: 3 };

    expect(restrictedPowerFor(actor, "Gear"), "a Gear could not reach Ornn's pool").toBe(3);
    expect(restrictedPowerFor(actor, "Spell"), "a Spell reached the wrong pool").toBe(5);
    expect(restrictedPowerFor(actor, "Unit"), "a Unit reached a restricted pool").toBe(0);
  });

  it("lets a Power-costing gear be played with NO runes at all", () => {
    const held = createCardInstance(POWER_GEAR) as GearInstance;
    const state = board(POWER_GEAR.powerCost, [held]);

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === held.instanceId,
    );
    expect(play, "the gear was not playable off Ornn's pool").toBeDefined();
    expect(play!.payment.powerRunes, "a rune was spent when the pool should have paid").toHaveLength(0);
    expect(validatePlayCard(state, play!), "enumerated but refused").toMatchObject({ ok: true });
  });

  /** The negative: without the pool, the same gear with no runes is unplayable. */
  it("and that same gear is NOT playable without the pool", () => {
    const held = createCardInstance(POWER_GEAR) as GearInstance;
    const state = board(0, [held]);

    const play = legalActions(state).filter(
      (a) => a.type === "PlayCard" && a.card.instanceId === held.instanceId,
    );
    expect(play, "the gear was playable with neither runes nor pool").toHaveLength(0);
  });

  it("spends the pool, and only the gear pool", () => {
    const held = createCardInstance(POWER_GEAR) as GearInstance;
    const state = board(POWER_GEAR.powerCost, [held]);
    state.players[0]!.restrictedSpellPower = 4;

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === held.instanceId,
    )!;
    const after = executePlayCard(state, play);

    expect(after.players[0]!.restrictedGearPower, "the gear pool was not drained").toBe(0);
    expect(after.players[0]!.restrictedSpellPower, "a Gear drained the SPELL pool").toBe(4);
  });
});
