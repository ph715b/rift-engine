import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { dispatchOnSpellCast } from "../src/engine/unit-triggers.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Recruit the Vanguard (OGS-015) — "Play four 1-Might Recruit unit tokens.
 * (They can be played to your base or to battlefields you control.)" It was
 * the one OGS card with printed text and no registered effect at all: you
 * paid 3 Energy and got nothing.
 */
const CARD_ID = "OGS-015";

function funded(state: ReturnType<typeof makeState>, card: { energyCost: number; powerCost: number }) {
  state.players[0]!.channeled = Array.from({ length: card.energyCost + card.powerCost }, (_, i) => ({
    id: `r${i}`,
    domain: "Order" as const,
    state: "Ready" as const,
  }));
  return state.players[0]!.channeled.map((r) => r.id);
}

describe("Recruit the Vanguard: play four 1-Might Recruit tokens", () => {
  it("creates four tokens in base when no destination is chosen", () => {
    const effect = effectForCard(spellInstance(CARD_ID))!;
    const state = makeState();

    const result = effect.resolve(state, contextFor(0), {});

    expect(result.players[0]!.baseUnits).toHaveLength(4);
    expect(result.players[0]!.baseUnits.every((u) => u.isToken && u.might === 1)).toBe(true);
    expect(new Set(result.players[0]!.baseUnits.map((u) => u.instanceId)).size).toBe(4); // four distinct tokens
  });

  it("puts all four at the chosen battlefield", () => {
    const effect = effectForCard(spellInstance(CARD_ID))!;
    const state = makeState();

    const result = effect.resolve(state, contextFor(0), { destinationBattlefieldId: "bf2" });

    expect(result.battlefields[1]!.units["p1"]).toHaveLength(4);
    expect(result.players[0]!.baseUnits).toHaveLength(0);
  });

  it("legalActions offers base plus every battlefield you CONTROL, not merely occupy", () => {
    const card = spellInstance(CARD_ID);
    const state = makeState();
    state.players[0]!.hand = [card];
    funded(state, card);
    state.battlefields[0]!.controllerId = "p1"; // controlled
    state.battlefields[1]!.units = { p1: [makeUnit()] }; // occupied but uncontrolled

    const destinations = legalActions(state)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId)
      .map((a) => a.destinationBattlefieldId ?? "base");

    expect(new Set(destinations)).toEqual(new Set(["base", "bf1"]));
  });

  it("rejects a battlefield you don't control", () => {
    const card = spellInstance(CARD_ID);
    const state = makeState();
    state.players[0]!.hand = [card];
    const runeIds = funded(state, card);
    state.battlefields[0]!.controllerId = "p2";

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: { energyRunes: runeIds.slice(0, card.energyCost), powerRunes: runeIds.slice(card.energyCost) },
      destinationBattlefieldId: "bf1",
    };
    const result = validatePlayCard(state, action);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/control/);
  });

  it("rejects a destination on a Spell that doesn't place tokens", () => {
    const incinerate = spellInstance("OGS-003");
    const state = makeState();
    state.players[0]!.hand = [incinerate];
    const runeIds = funded(state, incinerate);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: incinerate,
      payment: { energyRunes: runeIds.slice(0, incinerate.energyCost), powerRunes: [] },
      targetUnitInstanceId: state.battlefields[0]!.units["p2"]![0]!.instanceId,
      destinationBattlefieldId: "bf1",
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });
});

describe("'costs 5 or more' counts Energy PLUS Power", () => {
  it("Lux - Illuminated triggers on a 4-Energy/1-Power spell", () => {
    // Previously handed energyCost alone, so this exact shape silently missed.
    const lux = realUnitInstance("OGS-006");
    const state = makeState();
    state.players[0]!.baseUnits = [lux];

    const next = dispatchOnSpellCast(state, 0, 4 + 1);

    expect(next.players[0]!.baseUnits[0]!.bonus).toBe(3);
  });

  it("...and not on a 4-total-cost spell", () => {
    const lux = realUnitInstance("OGS-006");
    const state = makeState();
    state.players[0]!.baseUnits = [lux];

    expect(dispatchOnSpellCast(state, 0, 4).players[0]!.baseUnits[0]!.bonus).toBe(0);
  });
});
