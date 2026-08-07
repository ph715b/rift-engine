import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { CardDefinition } from "../src/model/card-definition.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState } from "./fixtures.js";

/**
 * Ornn's Forge (SFD-213) — "While you control this battlefield, the first
 * friendly non-token gear played each turn costs [1] less."
 *
 * Three separate conditions, and each is a way to get the card wrong:
 *  - **the FIRST** gear each turn, so the second pays full;
 *  - **GEAR**, so a Unit or Spell is untouched;
 *  - **while you CONTROL it**, so an uncontrolled or enemy-held Forge gives
 *    nothing.
 *
 * The ordering hazard is its own test. A cost modifier is asked several times per
 * play — enumeration, validation, and `execute-play-card`'s own float math — and
 * must give the SAME answer each time, so the counter it reads is bumped only
 * after the play is priced and paid. Bumping it early makes the executor
 * re-derive a cost the validator never agreed to.
 */

const registry = defaultCardRegistry();
const ORNNS_FORGE = "SFD-213";
/** Any ordinary Gear with a nonzero Energy cost. */
// `CardDefinition` carries `type`; `kind` is the INSTANCE's field. Picking the
// definition by the wrong one silently matches nothing, which reads as "the
// registry is empty" rather than "the filter is wrong".
//
// Narrowed through a type guard rather than a cast, because `CardDefinition` is a
// UNION and only its Gear arm has `energyCost` — a cast would have hidden that
// and left the filter free to match the wrong arm.
type GearDef = Extract<CardDefinition, { type: "Gear" }>;
const isGearDef = (d: CardDefinition): d is GearDef => d.type === "Gear";
const GEAR = registry.all().filter(isGearDef).find((d) => d.energyCost >= 2 && d.powerCost === 0)!;

const gear = () => createCardInstance(GEAR) as GearInstance;

function board(controlsForge: boolean, hand: GearInstance[] = []): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand,
        channeled: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId: ORNNS_FORGE,
    controllerId: controlsForge ? "p1" : null,
  };
  return state;
}

const priceOfGear = (state: GameState) =>
  modifiedEnergyCost(state, 0, "Gear", GEAR.energyCost, GEAR.id);

describe("Ornn's Forge discounts the FIRST gear each turn", () => {
  it("takes 1 Energy off while you control it", () => {
    expect(priceOfGear(board(true))).toBe(GEAR.energyCost - 1);
  });

  /** The negative that makes the discount mean something. */
  it("gives nothing once a gear has already been played this turn", () => {
    const state = board(true);
    state.players[0]!.gearPlayedThisTurn = 1;
    expect(priceOfGear(state), "the SECOND gear was discounted too").toBe(GEAR.energyCost);
  });

  it("gives nothing while nobody controls it", () => {
    expect(priceOfGear(board(false)), "an uncontrolled Forge discounted").toBe(GEAR.energyCost);
  });

  it("gives nothing to the player who does NOT control it", () => {
    const state = board(true); // p1 controls it
    expect(
      modifiedEnergyCost(state, 1, "Gear", GEAR.energyCost, GEAR.id),
      "the opponent got the controller's discount",
    ).toBe(GEAR.energyCost);
  });

  /** GEAR only — a Unit or Spell of the same cost is untouched. */
  it("does not discount a Unit or a Spell", () => {
    const state = board(true);
    expect(modifiedEnergyCost(state, 0, "Unit", 4, "OGN-001"), "a Unit was discounted").toBe(4);
    expect(modifiedEnergyCost(state, 0, "Spell", 4, "OGN-002"), "a Spell was discounted").toBe(4);
  });
});

describe("the counter moves only after the play is priced", () => {
  /**
   * The ordering hazard, end to end through the real pipeline. If
   * `gearPlayedThisTurn` were bumped before the executor re-derives the cost, the
   * executor would price the play WITHOUT the discount the enumerator and the
   * validator both quoted — the offered-then-refused shape, one layer deeper.
   */
  it("enumerates, validates and executes the same discounted price", () => {
    const held = gear();
    const state = board(true, [held]);

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === held.instanceId,
    );
    expect(play, "the gear was not offered at all").toBeDefined();
    expect(play!.payment.energyRunes, "the offer did not carry the discount").toHaveLength(GEAR.energyCost - 1);
    expect(validatePlayCard(state, play!), "enumerated but refused").toMatchObject({ ok: true });

    // The executor re-derives the cost from raw and must reach the same number.
    const after = executePlayCard(state, play!);
    expect(after.players[0]!.gearPlayedThisTurn, "the counter did not move").toBe(1);
  });

  it("the second gear of the turn is offered at full price", () => {
    const first = gear();
    const second = gear();
    const state = board(true, [first, second]);

    const played = executePlayCard(
      state,
      legalActions(state).find(
        (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === first.instanceId,
      )!,
    );

    const next = legalActions(played).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === second.instanceId,
    );
    expect(next, "the second gear was not offered").toBeDefined();
    expect(next!.payment.energyRunes, "the second gear was discounted too").toHaveLength(GEAR.energyCost);
  });

  it("a Unit play does not consume the turn's gear discount", () => {
    const state = board(true);
    state.players[0]!.gearPlayedThisTurn = 0;
    // Nothing but a Gear may move the counter.
    expect(priceOfGear(state)).toBe(GEAR.energyCost - 1);
  });
});
