import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/**
 * The first two activation costs that carry a CHOICE — Malzahar's kill and the
 * Armory's discard — plus the rainbow Power pool Malzahar fills.
 *
 * The shared risk is the one every enumerator/validator pair in this engine has:
 * a cost fanned out one way and re-derived another is an offered-then-refused
 * bug, and a cost choice that never reaches the executor is an ability that
 * pays nothing.
 */

const registry = defaultCardRegistry();
const MALZAHAR_FANATIC = "OGN-113"; // "Kill a friendly unit or gear, Exhaust: -> Add rainbow rainbow."
const UNLICENSED_ARMORY = "OGN-023"; // "Discard 1, Exhaust: Choose a friendly unit. ... may pay Fury ... instead."
const ENERGY_CONDUIT = "OGN-098"; // an ordinary friendly gear, so "unit OR gear" has both to offer
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — a card to discard, and a Power cost to pay with rainbow

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain, state });

const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const gear = (defId: string, instanceId: string): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId }) as GearInstance;

const activationsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

describe("Malzahar - Fanatic (OGN-113): a body for two rainbow Power", () => {
  /** Malzahar at base with one other friendly unit, one friendly gear, and an
   *  enemy unit standing where he could see it. */
  function malzaharState(): GameState {
    const state = makeState({ phase: "Action" });
    const malzahar = { ...realUnitInstance(MALZAHAR_FANATIC), instanceId: "malzahar" };
    state.players[0]!.baseUnits = [malzahar, makeUnit({ instanceId: "friend", might: 2 })];
    state.players[0]!.activeGear = [gear(ENERGY_CONDUIT, "conduit")];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "foe", might: 2 })] };
    return state;
  }

  it("offers one activation per friendly permanent it could kill", () => {
    const paying = activationsOf(malzaharState(), "malzahar").map((a) => a.costPermanentInstanceId);
    expect(paying).toContain("friend");
    expect(paying).toContain("conduit");
  });

  it("never offers to pay with an ENEMY unit, or with HIMSELF", () => {
    // Himself is the one that matters: `killSelf` is a different cost, and an
    // ability that both exhausted and killed its own unit could never be used.
    const paying = activationsOf(malzaharState(), "malzahar").map((a) => a.costPermanentInstanceId);
    expect(paying).not.toContain("foe");
    expect(paying).not.toContain("malzahar");
  });

  it("is not offered at all with nothing to kill (416.3)", () => {
    const state = malzaharState();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.filter((u) => u.instanceId === "malzahar");
    state.players[0]!.activeGear = [];
    expect(activationsOf(state, "malzahar")).toHaveLength(0);
  });

  it("kills what was named and banks 2 rainbow Power", () => {
    const state = malzaharState();
    const play = activationsOf(state, "malzahar").find((a) => a.costPermanentInstanceId === "friend")!;
    const settled = accept(state, play);

    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId), "the price was not paid").toEqual(["malzahar"]);
    expect(settled.players[0]!.floatingRainbowPower).toBe(2);
    expect(settled.players[0]!.baseUnits[0]!.exhausted, "he did not exhaust").toBe(true);
    expect(settled.players[0]!.trash.some((c) => c.instanceId === "friend"), "the body never reached the trash").toBe(true);
  });

  it("REFUSES a hand-built activation that names an enemy unit as the price", () => {
    const state = malzaharState();
    const play = activationsOf(state, "malzahar")[0]!;
    expect(validateActivateAbility(state, { ...play, costPermanentInstanceId: "foe" })).toMatchObject({ ok: false });
  });

  it("REFUSES an activation that names no price at all", () => {
    const state = malzaharState();
    const { costPermanentInstanceId: _dropped, ...noPrice } = activationsOf(state, "malzahar")[0]!;
    expect(validateActivateAbility(state, noPrice as ActivateAbilityAction)).toMatchObject({ ok: false });
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(MALZAHAR_FANATIC))).toBe(true);
  });
});

describe("floatingRainbowPower: any domain, any card kind", () => {
  /** Hextech Ray (1 Energy, 1 FURY Power) in hand, with a CALM pool — so the
   *  Power half can only come from the rainbow bucket. */
  function rainbowState(banked: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(HEXTECH_RAY)];
    state.players[0]!.channeled = [rune("c0", "Calm"), rune("c1", "Calm")];
    state.players[0]!.floatingRainbowPower = banked;
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "foe", might: 5 })] };
    return state;
  }

  const playsFor = (state: GameState) =>
    legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === HEXTECH_RAY);

  it("pays a Power pip of a domain the pool does not hold", () => {
    // The negative control first: two Calm runes can pay the Energy but never
    // the Fury pip, so the card is uncastable without the rainbow.
    expect(playsFor(rainbowState(0)), "a Calm pool paid a Fury pip").toHaveLength(0);
    expect(playsFor(rainbowState(1)).length, "the rainbow did not cover the pip").toBeGreaterThan(0);
  });

  it("is SPENT by the play, not merely counted", () => {
    const state = rainbowState(1);
    const settled = accept(state, playsFor(state)[0]!);
    expect(settled.players[0]!.floatingRainbowPower).toBe(0);
  });

  it("is drained BEFORE Kai'Sa's Spells-only pool — fungible before restricted", () => {
    // Order matters where the two overlap: spending the restricted pool first
    // would strand it on a turn whose only other card is a Unit.
    const priced = computeEffectiveCost(0, {}, 0, 2, "Fury", undefined, 0, 1, 1);
    expect(priced.powerCost, "the two pools did not both apply").toBe(0);

    const state = rainbowState(1);
    state.players[0]!.restrictedSpellPower = 1;
    const settled = accept(state, playsFor(state)[0]!);
    expect(settled.players[0]!.floatingRainbowPower, "the fungible pool was not spent first").toBe(0);
    expect(settled.players[0]!.restrictedSpellPower, "the restricted pool was raided needlessly").toBe(1);
  });
});

describe("Unlicensed Armory (OGN-023): a discard now, a Fury later", () => {
  /** The Armory plus a friendly unit to ward, a hand to discard from, and the
   *  Fury to pay the ward with. */
  function armoryState(handCount = 2, furyCount = 1): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(UNLICENSED_ARMORY, "armory")];
    state.players[0]!.hand = Array.from({ length: handCount }, () => spellInstance(HEXTECH_RAY));
    state.players[0]!.channeled = Array.from({ length: furyCount }, (_, i) => rune(`f${i}`, "Fury"));
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "ward-me", might: 3 })];
    return state;
  }

  it("offers one activation per card it could discard, naming the unit to ward", () => {
    const offered = activationsOf(armoryState(), "armory");
    expect(offered.length, "nothing was offered").toBeGreaterThan(0);
    for (const a of offered) {
      expect(a.costDiscardCardInstanceId, "no discard was named").toBeDefined();
      expect(a.targetUnitInstanceId).toBe("ward-me");
    }
  });

  it("is not offered with an EMPTY hand — the discard is a cost", () => {
    expect(activationsOf(armoryState(0), "armory")).toHaveLength(0);
  });

  it("takes the discard and arms the ward", () => {
    const state = armoryState();
    const discarded = state.players[0]!.hand[0]!.instanceId;
    const play = activationsOf(state, "armory").find((a) => a.costDiscardCardInstanceId === discarded)!;
    const settled = accept(state, play);

    expect(settled.players[0]!.hand.map((c) => c.instanceId), "the discard was not taken").not.toContain(discarded);
    expect(settled.players[0]!.trash.map((c) => c.instanceId)).toContain(discarded);
    expect(settled.paidDeathWardUnitInstanceIds).toEqual(["ward-me"]);
  });

  it("REFUSES a hand-built activation discarding a card not in hand", () => {
    const state = armoryState();
    const play = activationsOf(state, "armory")[0]!;
    expect(validateActivateAbility(state, { ...play, costDiscardCardInstanceId: "not-in-hand" })).toMatchObject({ ok: false });
  });

  describe("the ward itself", () => {
    /** The Armory already activated, so the ward is armed and the discard spent. */
    function armedState(furyCount = 1): GameState {
      const state = armoryState(2, furyCount);
      return accept(state, activationsOf(state, "armory")[0]!);
    }

    // Through `destroyUnit`, the real funnel: it removes the unit from wherever
    // it stood before calling killUnit, and calling killUnit directly on a unit
    // still standing in baseUnits leaves the board holding two of it — which is
    // what an earlier draft of this test did, and it read as "declining saved it".
    it("stops to ASK when the warded unit would die", () => {
      const state = armedState();
      const killed = destroyUnit(state, "ward-me");
      expect(killed.pendingDecisions[0]?.kind).toBe("OGN-023-save");
      expect(killed.players[0]!.trash.some((c) => c.instanceId === "ward-me"), "it reached the trash mid-question").toBe(false);
    });

    it("heals, exhausts and recalls it when the Fury is paid", () => {
      const state = armedState();
      const damaged: GameState = {
        ...state,
        players: [
          { ...state.players[0]!, baseUnits: state.players[0]!.baseUnits.map((u) => ({ ...u, damage: 3 })) },
          state.players[1]!,
        ],
      };
      const saved = answerDecisions(destroyUnit(damaged, "ward-me"), choose("save"));

      const back = saved.players[0]!.baseUnits.find((u) => u.instanceId === "ward-me");
      expect(back, "it was not recalled").toBeDefined();
      expect(back!.damage, "it was not healed").toBe(0);
      expect(back!.exhausted, "it came back ready").toBe(true);
      expect(saved.players[0]!.channeled.every((r) => r.state === "Exhausted"), "the Fury was not paid").toBe(true);
    });

    it("lets it die when the save is DECLINED, and the ward is spent either way", () => {
      const state = armedState();
      const died = answerDecisions(destroyUnit(state, "ward-me"), choose("die"));

      expect(died.players[0]!.baseUnits.some((u) => u.instanceId === "ward-me"), "declining still saved it").toBe(false);
      expect(died.players[0]!.trash.some((c) => c.instanceId === "ward-me"), "it never reached the trash").toBe(true);
      expect(died.paidDeathWardUnitInstanceIds, "'the NEXT time' outlived the death it named").toEqual([]);
    });

    it("is spent by a taken save too — the second death is a real one", () => {
      const state = armedState();
      const saved = answerDecisions(destroyUnit(state, "ward-me"), choose("save"));
      expect(saved.paidDeathWardUnitInstanceIds).toEqual([]);

      const again = destroyUnit(saved, "ward-me");
      expect(again.pendingDecisions, "it was offered a second save").toHaveLength(0);
      expect(again.players[0]!.trash.some((c) => c.instanceId === "ward-me")).toBe(true);
    });

    it("is not ASKED when the Fury cannot be paid (416.3)", () => {
      // Unpayable by DOMAIN, not by count: 164.2's double duty means a Ready
      // rune of the right colour covers it however few there are, so only a
      // wrong-coloured pool can make the price unreachable.
      const state = armedState(0);
      state.players[0]!.channeled = [rune("c0", "Calm"), rune("c1", "Calm")];

      const killed = destroyUnit(state, "ward-me");
      expect(killed.pendingDecisions).toHaveLength(0);
      expect(killed.players[0]!.trash.some((c) => c.instanceId === "ward-me"), "it did not simply die").toBe(true);
    });

    it("does not ward a unit it never named", () => {
      const state = armedState();
      const players = [...state.players] as typeof state.players;
      players[0] = { ...players[0]!, baseUnits: [...players[0]!.baseUnits, makeUnit({ instanceId: "stranger", might: 3 })] };

      const killed = destroyUnit({ ...state, players }, "stranger");
      expect(killed.pendingDecisions).toHaveLength(0);
      expect(killed.players[0]!.trash.some((c) => c.instanceId === "stranger"), "the stranger did not die").toBe(true);
    });
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(UNLICENSED_ARMORY))).toBe(true);
  });
});
