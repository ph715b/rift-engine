import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { activationCostFor, canPayActivationCost } from "../src/engine/activated-abilities.js";
import { isEmpowered } from "../src/engine/effect-helpers.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * **Vendetta's three self-modifying `[Empower]` costs** — Baccai Sandspinner,
 * Frostcoat Mother and Grumpy Rockbear.
 *
 * All three were PARTIAL for one reason and one only: `parseEmpowerCost` refused
 * to read "This ability costs [N] less…" and so produced no `empowerCost` at all.
 * Their `[Empowered]` payloads already parsed. So the whole of this batch is one
 * sentence in the loader and one function on the shared pricing path.
 *
 * **827.1.c.3 is why the sentence is part of the COST rather than a discount on
 * it**: such text "is taken into account when determining a card's Empower cost
 * for any reason". Frostcoat Mother's printed 12 is not a 12 — it is a 12 minus
 * one per rune you control, and honouring the pips alone made her unplayable at a
 * price the card never asked for. Refusing to read it was the safe direction while
 * nothing could express the discount; it is not the safe direction now.
 *
 * The price is applied in `activationCostFor`, which already existed for Hextech
 * Gauntlets' target-scaled Energy and is the ONE function the enumerator,
 * `canPayActivationCost`, the validator and `payActivationCost` all reach.
 */

const registry = defaultCardRegistry();

const SANDSPINNER = "VEN-001"; // Fury Unit — [Empower] 5, costs 3 less if you control 4 or fewer runes
const FROSTCOAT = "VEN-032"; // Calm Unit — [Empower] 12, costs 1 less for each rune you control
const ROCKBEAR = "VEN-050"; // Mind Unit — the same 12/-1, with a different Empowered payload

const SANDSPINNER_PRINTED = 5;
const FROSTCOAT_PRINTED = 12;

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({
  id,
  domain,
  state,
});

/** The unit in play with `runeCount` runes in its controller's Rune Pool — which
 *  is exactly what "runes you control" means for all three cards. */
function board(defId: string, runeCount: number): { state: GameState; unitId: string } {
  const unit = { ...realUnitInstance(defId), instanceId: "subject" };
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.baseUnits = [unit];
  state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`r${i}`, "Fury"));
  return { state, unitId: unit.instanceId };
}

const energyOf = (state: GameState, defId: string) => activationCostFor(state, 0, defId).energy;

const empowerOf = (state: GameState) =>
  legalActions(state).find(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === "subject",
  );

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

describe("all three report implemented — the premise", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [SANDSPINNER, FROSTCOAT, ROCKBEAR]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });
});

describe("Frostcoat Mother (VEN-032): 12, minus one per rune", () => {
  it("costs the printed 12 with an empty Rune Pool", () => {
    expect(energyOf(board(FROSTCOAT, 0).state, FROSTCOAT), "the base price is not the printed one").toBe(
      FROSTCOAT_PRINTED,
    );
  });

  it("falls by exactly one per rune", () => {
    // Asserted at several counts rather than one, because a single sample cannot
    // tell "minus one each" from "minus one, once".
    for (const runes of [1, 4, 7, 11]) {
      expect(energyOf(board(FROSTCOAT, runes).state, FROSTCOAT), `${runes} runes priced wrong`).toBe(
        FROSTCOAT_PRINTED - runes,
      );
    }
  });

  it("floors at free, and stops naming an Energy cost at all", () => {
    // Twelve runes makes her free; thirteen must not pay the player back.
    // **The field goes AWAY rather than to 0**, which is not cosmetic:
    // `canPayActivationCost` and `activationPayment` both branch on the field's
    // PRESENCE, and a lingering `energy: 0` asks for a rune payment nobody owes.
    for (const runes of [12, 13, 20]) {
      expect(energyOf(board(FROSTCOAT, runes).state, FROSTCOAT), `${runes} runes produced a price`).toBeUndefined();
    }
  });

  it("grants its +3 Might once Empowered", () => {
    const { state, unitId } = board(FROSTCOAT, 12); // free, so nothing else is in the way
    const activate = empowerOf(state);
    expect(activate, "the Empower ability was not offered").toBeDefined();

    const after = accept(state, activate!);
    expect(isEmpowered(after, unitId), "paying the ability did not Empower her").toBe(true);
    const unit = after.players[0]!.baseUnits[0]!;
    expect(effectiveMight(after, unit, 0, { isCombat: false }), "the Empowered payload did not land").toBe(
      unit.might + 3,
    );
  });

  it("is not offered again once she holds the status (827.1.c.1)", () => {
    const { state } = board(FROSTCOAT, 12);
    const once = accept(state, empowerOf(state)!);
    expect(empowerOf(once), "an already-Empowered unit was offered its own Empower").toBeUndefined();
  });
});

describe("Baccai Sandspinner (VEN-001): 5, minus 3 behind a threshold", () => {
  it("costs the printed 5 above the threshold", () => {
    for (const runes of [5, 6, 12]) {
      expect(energyOf(board(SANDSPINNER, runes).state, SANDSPINNER), `${runes} runes was discounted`).toBe(
        SANDSPINNER_PRINTED,
      );
    }
  });

  it("costs 2 at EXACTLY four runes — 'or fewer' includes the boundary", () => {
    // The off-by-one that turns "4 or fewer" into "fewer than 4" is the realistic
    // mistake, and only the boundary catches it.
    expect(energyOf(board(SANDSPINNER, 4).state, SANDSPINNER), "the boundary was excluded").toBe(
      SANDSPINNER_PRINTED - 3,
    );
    expect(energyOf(board(SANDSPINNER, 3).state, SANDSPINNER), "below the boundary was not discounted").toBe(
      SANDSPINNER_PRINTED - 3,
    );
  });

  it("does NOT scale — it is a flat discount, not one per rune", () => {
    // The two rules share a field, so the mistake worth pinning is one being
    // applied as the other. A per-rune reading of this card would price it at
    // 5 - 4 = 1 rather than 2 here, and at 5 - 0 = 5 with an empty pool rather
    // than 2.
    expect(energyOf(board(SANDSPINNER, 0).state, SANDSPINNER), "an empty pool did not get the flat discount").toBe(
      SANDSPINNER_PRINTED - 3,
    );
    expect(energyOf(board(SANDSPINNER, 4).state, SANDSPINNER), "the discount scaled with the rune count").toBe(
      SANDSPINNER_PRINTED - 3,
    );
  });

  it("grants [Deflect] and [Assault 2] once Empowered", () => {
    const { state, unitId } = board(SANDSPINNER, 4); // 2 Energy, and four runes to pay it
    const after = accept(state, empowerOf(state)!);

    expect(isEmpowered(after, unitId), "paying the ability did not Empower it").toBe(true);
    const keywords = effectiveKeywords(after, after.players[0]!.baseUnits[0]!, 0);
    expect(keywords.Deflect, "[Deflect] was not granted").toBe(1);
    expect(keywords.Assault, "[Assault 2] was not granted").toBe(2);
  });
});

describe("Grumpy Rockbear (VEN-050): the same rule, a different payload", () => {
  it("shares Frostcoat's pricing exactly", () => {
    // Two cards, one printed sentence. Asserted rather than assumed because the
    // parse is per-card text and a typo in one card's row would be invisible.
    for (const runes of [0, 5, 9]) {
      expect(energyOf(board(ROCKBEAR, runes).state, ROCKBEAR), `${runes} runes priced wrong`).toBe(
        FROSTCOAT_PRINTED - runes,
      );
    }
  });

  it("grants [Deflect] and [Shield 3]", () => {
    const { state } = board(ROCKBEAR, 12);
    const after = accept(state, empowerOf(state)!);
    const keywords = effectiveKeywords(after, after.players[0]!.baseUnits[0]!, 0);
    expect(keywords.Deflect, "[Deflect] was not granted").toBe(1);
    expect(keywords.Shield, "[Shield 3] was not granted").toBe(3);
  });
});

describe("the price is LIVE, and the gate never withholds an affordable play", () => {
  it("is re-read from the board rather than fixed at load time", () => {
    // The whole reason the rule travels on the cost instead of being resolved in
    // the loader: baking a number in at load time would freeze it at the rune
    // count of an empty game. Four runes recycled away is four Energy back on the
    // price.
    const { state } = board(FROSTCOAT, 9);
    expect(energyOf(state, FROSTCOAT)).toBe(3);

    const poorer: GameState = {
      ...state,
      players: [{ ...state.players[0]!, channeled: state.players[0]!.channeled.slice(0, 5) }, state.players[1]!],
    };
    expect(energyOf(poorer, FROSTCOAT), "the price did not follow the Rune Pool").toBe(7);
  });

  it("is OFFERED when only the discount makes it affordable", () => {
    // **The fidelity half**, and the same one Hextech Gauntlets records: a gate
    // that priced the un-discounted 12 would refuse Frostcoat Mother at every
    // rune count a real game reaches, and the player would never see a card they
    // can legally play. Eight runes cannot cover 12 and cover 4 exactly.
    const { state } = board(FROSTCOAT, 8);
    expect(energyOf(state, FROSTCOAT)).toBe(4);
    expect(canPayActivationCost(state, 0, state.players[0]!.baseUnits[0]!), "the gate priced the un-discounted cost").toBe(
      true,
    );
    expect(empowerOf(state), "an affordable Empower was withheld").toBeDefined();
  });

  it("...and is REFUSED when even the discounted price is out of reach", () => {
    // The negative beside it. Three runes discount her to 9 and pay 3 of it —
    // without this, "it was offered" proves only that something was offered.
    const { state } = board(FROSTCOAT, 3);
    expect(energyOf(state, FROSTCOAT)).toBe(9);
    expect(empowerOf(state), "an unpayable Empower was offered").toBeUndefined();
  });

  it("charges the DISCOUNTED price, not the printed one", () => {
    // The payment site, which is a different consumer of `activationCostFor` from
    // the offer. Eight runes, a price of 4: paying must leave four ready.
    const { state } = board(FROSTCOAT, 8);
    const after = accept(state, empowerOf(state)!);

    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready").length, "the printed 12 was charged").toBe(4);
    expect(isEmpowered(after, "subject"), "the payment did not buy the Empower").toBe(true);
  });
});
