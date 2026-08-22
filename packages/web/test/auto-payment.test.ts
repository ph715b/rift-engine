import { describe, expect, it } from "vitest";
import {
  computeAutoPayment,
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  submit,
  type GameState,
  type PlayCardAction,
  type RuneCard,
  type RunePayment,
} from "@rift-engine/engine";
import { autoPayFill } from "../src/auto-payment.js";

/**
 * Auto Pay and rule 164.2's DOUBLE DUTY.
 *
 * Reported from play: "I can't cast Falling Star. I have the resources to cast
 * it but after choosing targets nothing happens, even using Auto Pay."
 *
 * The card was always castable. Falling Star is 2 Energy + 2 Fury Power, and the
 * engine pays it with TWO Fury runes listed in both buckets — 164.2, "N runes
 * cover any cost with E <= N and P <= N". The board's Auto Pay built its
 * remaining pool by removing every rune already proposed in EITHER bucket, so
 * once the player had left-clicked two runes for the Energy half there was
 * nothing left to fill the Power half with, and the button silently did nothing.
 */

const fury = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Fury", state });
const empty: RunePayment = { energyRunes: [], powerRunes: [] };

/** Falling Star's cost, as the engine enumerates it. */
function fallingStarRequired(pool: readonly RuneCard[]): RunePayment {
  const payment = computeAutoPayment(pool, 2, 2, "Fury");
  if (!payment) throw new Error("fixture pool cannot pay Falling Star");
  return payment;
}

describe("the engine's own payment is what the board has to be able to build", () => {
  it("pays 2 Energy + 2 Power from just TWO runes, listing them twice", () => {
    // The fact the board could not express. If this ever stops being true, the
    // premise of everything below has changed.
    const pool = [fury("f0"), fury("f1")];
    expect(fallingStarRequired(pool)).toEqual({
      energyRunes: ["f0", "f1"],
      powerRunes: ["f0", "f1"],
    });
  });
});

/**
 * The OLD algorithm, verbatim, kept as the thing this test file exists to catch —
 * the `REGRESS=1` pattern `piles-check.mjs` already uses. A fix nobody can make
 * fail is not verified.
 */
function oldAutoPayFill(
  channeled: readonly RuneCard[],
  proposed: RunePayment,
  required: RunePayment,
): { energyRunes: string[]; powerRunes: string[] } | null {
  const remainingEnergy = required.energyRunes.length - proposed.energyRunes.length;
  const remainingPower = required.powerRunes.length - proposed.powerRunes.length;
  if (remainingEnergy <= 0 && remainingPower <= 0) return null;
  // The defect: ONE pot for both buckets.
  const proposedIds = new Set([...proposed.energyRunes, ...proposed.powerRunes]);
  const remainingPool = channeled.filter((r) => !proposedIds.has(r.id));
  const fill = computeAutoPayment(remainingPool, Math.max(remainingEnergy, 0), Math.max(remainingPower, 0), "Fury");
  return fill ? { energyRunes: fill.energyRunes, powerRunes: fill.powerRunes } : null;
}

describe("the [Deflect] surcharge — the bucket the board never had", () => {
  /** Cleave at a [Deflect 1] unit: the card's own cost plus 1 rainbow. */
  function withSurcharge(pool: readonly RuneCard[], energy: number, power: number, rainbow: number): RunePayment {
    const payment = computeAutoPayment(pool, energy, power, "Fury", undefined, rainbow);
    if (!payment) throw new Error("fixture pool cannot pay the surcharge");
    return payment;
  }

  it("the engine asks for a THIRD bucket, and it does NOT double-duty with the other two", () => {
    // 164.2's double duty is about paying YOUR cost. A tax handed to an opponent
    // refunds nothing, so a rune spent on the surcharge is spent.
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const required = withSurcharge(pool, 2, 2, 1);
    expect(required.rainbowRunes).toHaveLength(1);
    const spentOnOwnCost = new Set([...required.energyRunes, ...required.powerRunes]);
    expect(spentOnOwnCost.has(required.rainbowRunes![0]!), "a rune paid the tax AND the card").toBe(false);
  });

  it("fills the surcharge, which is the whole reason a Deflect target was uncastable", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const fill = autoPayFill(pool, empty, withSurcharge(pool, 2, 2, 1), "Fury");
    expect(fill, "Auto Pay cannot pay a [Deflect] surcharge").not.toBeNull();
    expect(fill!.rainbowRunes).toHaveLength(1);
  });

  it("never proposes a rune for the tax that it is also proposing for the card's own cost", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const fill = autoPayFill(pool, empty, withSurcharge(pool, 2, 2, 1), "Fury")!;
    const own = new Set([...fill.energyRunes, ...fill.powerRunes]);
    expect(own.has(fill.rainbowRunes[0]!), "one rune paid both the tax and the cost").toBe(false);
  });

  it("respects a rune the player has already claimed for the card's own cost", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: ["f0", "f1"], rainbowRunes: [] };
    const fill = autoPayFill(pool, proposed, withSurcharge(pool, 2, 2, 1), "Fury")!;
    expect(fill.rainbowRunes, "the tax reused a rune already paying the card").toEqual(["f2"]);
  });

  it("takes ANY domain for the tax — rainbow means rainbow", () => {
    const pool: RuneCard[] = [fury("f0"), fury("f1"), { id: "c0", domain: "Calm", state: "Ready" }];
    const required: RunePayment = { energyRunes: ["a", "b"], powerRunes: ["a", "b"], rainbowRunes: ["c"] };
    const fill = autoPayFill(pool, { energyRunes: ["f0", "f1"], powerRunes: ["f0", "f1"] }, required, "Fury")!;
    expect(fill.rainbowRunes).toEqual(["c0"]);
  });

  it("refuses honestly when the pool covers the card but not the tax", () => {
    // Two Fury runes pay 2+2 by double duty, and there is no third rune for the
    // surcharge. That is a real no, and it must not read as a dead button.
    const pool = [fury("f0"), fury("f1")];
    const required: RunePayment = { energyRunes: ["a", "b"], powerRunes: ["a", "b"], rainbowRunes: ["c"] };
    expect(autoPayFill(pool, empty, required, "Fury")).toBeNull();
  });

  it("reports nothing owed only when the TAX is settled too", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const required = withSurcharge(pool, 2, 2, 1);
    const ownCostPaid: RunePayment = { energyRunes: required.energyRunes, powerRunes: required.powerRunes };
    // Energy and Power are complete; the surcharge is not. The old length check
    // looked at those two buckets alone and called this finished, submitted it,
    // and the engine refused it — silently.
    expect(autoPayFill(pool, ownCostPaid, required, "Fury")).not.toBeNull();
    expect(autoPayFill(pool, required, required, "Fury")).toBeNull();
  });
});

describe("the OLD Auto Pay could not do it — the failure this file pins", () => {
  it("returned null for the reported board, which is the dead button", () => {
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    expect(
      oldAutoPayFill(pool, proposed, fallingStarRequired(pool)),
      "the old algorithm no longer reproduces the bug — has the premise changed?",
    ).toBeNull();
    // And the new one does not.
    expect(autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury")).not.toBeNull();
  });

  it("also spent FOUR runes on a 2+2 cost when the pool was big enough to hide it", () => {
    // The quieter half of the same bug: with four runes Auto Pay "worked", by
    // paying twice what 164.2 asks. Nothing surfaced it, because the play went
    // through.
    const pool = [fury("f0"), fury("f1"), fury("f2"), fury("f3")];
    const afterEnergy: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const old = oldAutoPayFill(pool, afterEnergy, fallingStarRequired(pool));
    expect(old).not.toBeNull();
    expect(new Set([...afterEnergy.energyRunes, ...old!.powerRunes]).size).toBe(4);

    const fresh = autoPayFill(pool, afterEnergy, fallingStarRequired(pool), "Fury");
    expect(new Set([...afterEnergy.energyRunes, ...fresh!.powerRunes]).size, "still spending four runes").toBe(2);
  });
});

describe("autoPayFill: a rune already spent on Energy still pays Power", () => {
  it("completes the payment when the player has claimed the whole pool for Energy", () => {
    // THE REPORTED CASE. Two Fury runes, both left-clicked for Energy. The old
    // pool-wide exclusion left nothing and returned null — the dead button.
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill, "Auto Pay still cannot finish a double-duty payment").not.toBeNull();
    expect(fill!.powerRunes).toHaveLength(2);
    expect(fill!.energyRunes).toEqual([]);
  });

  it("still completes it with three runes, where the old pool left only one", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const proposed: RunePayment = { energyRunes: ["f0", "f1"], powerRunes: [] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes).toHaveLength(2);
  });

  it("fills BOTH halves from a clean start, and does not spend four runes on a 2+2 cost", () => {
    // The clean path has to keep working, and keep being frugal: the whole point
    // of double duty is that this costs two runes, not four.
    const pool = [fury("f0"), fury("f1"), fury("f2"), fury("f3")];
    const fill = autoPayFill(pool, empty, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).toHaveLength(2);
    expect(fill!.powerRunes).toHaveLength(2);
    const distinct = new Set([...fill!.energyRunes, ...fill!.powerRunes]);
    expect(distinct.size, "Auto Pay spent four runes on a cost two can cover").toBe(2);
  });

  it("completes the other way round too — Power claimed by hand, Energy owed", () => {
    const pool = [fury("f0"), fury("f1")];
    const proposed: RunePayment = { energyRunes: [], powerRunes: ["f0", "f1"] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).toHaveLength(2);
    expect(fill!.powerRunes).toEqual([]);
  });

  it("never proposes a rune the same bucket already holds", () => {
    const pool = [fury("f0"), fury("f1"), fury("f2")];
    const proposed: RunePayment = { energyRunes: ["f0"], powerRunes: ["f0"] };
    const fill = autoPayFill(pool, proposed, fallingStarRequired(pool), "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.energyRunes).not.toContain("f0");
    expect(fill!.powerRunes).not.toContain("f0");
  });

  it("returns null when there is genuinely nothing owed", () => {
    const pool = [fury("f0"), fury("f1")];
    const required = fallingStarRequired(pool);
    expect(autoPayFill(pool, required, required, "Fury")).toBeNull();
  });

  it("returns null when the pool really cannot pay — the honest refusal", () => {
    // One Fury rune against 2 Energy + 2 Power. Double duty covers E <= N and
    // P <= N, and N is 1, so this is a real no.
    const pool = [fury("f0")];
    const required: RunePayment = { energyRunes: ["x", "y"], powerRunes: ["x", "y"] };
    expect(autoPayFill(pool, empty, required, "Fury")).toBeNull();
  });

  it("respects the DOMAIN on the Power half while leaving Energy domain-free", () => {
    // Energy takes any Ready rune (415); Power must match the card's pip.
    const pool: RuneCard[] = [fury("f0"), { id: "c0", domain: "Calm", state: "Ready" }];
    const required: RunePayment = { energyRunes: ["a"], powerRunes: ["b"] };
    const fill = autoPayFill(pool, empty, required, "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes, "an off-domain rune was proposed for a Fury pip").toEqual(["f0"]);
  });

  it("uses an EXHAUSTED rune for Power, which a Power cost may (416)", () => {
    // A Power cost recycles rather than exhausts, so an exhausted rune pays it —
    // and the Energy half must not touch it.
    const pool = [fury("e0", "Exhausted"), fury("r0")];
    const required: RunePayment = { energyRunes: ["a"], powerRunes: ["b"] };
    const fill = autoPayFill(pool, empty, required, "Fury");
    expect(fill).not.toBeNull();
    expect(fill!.powerRunes).toEqual(["e0"]);
    expect(fill!.energyRunes, "an exhausted rune was proposed for Energy").toEqual(["r0"]);
  });
});

/**
 * The loop closed: a payment this module builds must be one the ENGINE accepts.
 *
 * The unit tests above are arithmetic. This is the part that was actually broken
 * in play — the board assembled a payment, the engine refused it, and nothing
 * said so. Driven through the real `legalActions` and the real `submit`, because
 * that is the pair that disagreed.
 */
const registry = defaultCardRegistry();
const instance = (defId: string) => createCardInstance(registry.get(defId));

const POUTY_PORO = "OGN-013"; // a UNIT whose entire printed text is [Deflect 1]

function player(id: string) {
  return {
    id,
    name: id,
    legend: {
      instanceId: `${id}-legend`,
      defId: "TEST-LEGEND",
      name: "Test Legend",
      domains: [],
      exhausted: false,
      isToken: false,
      kind: "Legend" as const,
      championTag: "TEST",
    },
    championZone: null,
    chosenChampionDefId: "TEST-CHAMPION",
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    starSpringUsedBattlefieldIds: [],
    nonTokenUnitSurchargeThisTurn: 0,
    gearAbilitiesActivatedThisTurn: 0,
    energySpentOnLastPlay: 0,
    deck: [], hand: [], trash: [], banished: [], activeGear: [], runeDeck: [], channeled: [], baseUnits: [],
    points: 0, xp: 0, floatingEnergy: 0, floatingPower: {}, floatingRainbowPower: 0, cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false, extraMightPerBuffThisTurn: 0, discardedThisTurn: false,
    scoredBattlefieldsThisTurn: [], unitsEnterReadyThisTurn: false, restrictedSpellEnergy: 0,
    restrictedUnitEnergy: 0,
    restrictedSpellPower: 0, nextUnitsEnterReady: 0, unitsLostThisTurn: 0, nextSpellEnergyDiscount: 0,
    nextCardEnergyDiscount: 0,
    nextCardPowerDiscount: 0,
    nextSpellBonusDamage: 0, cannotPlayCardsThisTurn: false, hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false, replacedCostPlays: [],
  };
}

/** A real board: an enemy [Deflect 1] unit at bf1 and a pool deep enough in
 *  every domain that nothing here can fail for want of runes. */
function boardWithDeflector(): { state: GameState; poroId: string } {
  const poro = instance(POUTY_PORO);
  const state = {
    players: [player("p1"), player("p2")],
    battlefields: [
      { id: "bf1", name: "BF1", controllerId: null, units: { p2: [poro] }, contestedByIndex: null, hiddenCards: [] },
      { id: "bf2", name: "BF2", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    ],
    activePlayerIndex: 0, firstPlayerIndex: 0, turnNumber: 4, phase: "Action", turnState: "Neutral",
    focusHolder: 0, showdownBattlefieldId: null, showdownKind: null, consecutiveFocusPasses: 0,
    chainOpen: true, chainPriority: 0, chainPasses: 0, chainOpenedByTrigger: false, spellChain: [],
    pendingTriggers: [], declaredWinnerIndex: null, killDamagedUnitsThisTurn: false, spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [], extraTurns: 0, extraTurnsForIndex: 0, lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [], banishOnDeathUnitInstanceIds: [], damageDoubledUnitInstanceIds: [], paidDeathWardUnitInstanceIds: [], unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [], pendingDecisions: [],
  } as unknown as GameState;
  state.players[0].channeled = (["Fury", "Body", "Calm", "Mind", "Order", "Chaos"] as const).flatMap((domain, d) =>
    Array.from({ length: 4 }, (_, i) => ({ id: `${domain}-${d}-${i}`, domain, state: "Ready" as const })),
  );
  return { state, poroId: poro.instanceId };
}

describe("end to end: the board's payment is one the engine accepts", () => {
  /** The first enumerated play that names the Poro AND owes a surcharge. */
  function taxedPlay(): { state: GameState; action: PlayCardAction } {
    for (const def of registry.all()) {
      if (def.type !== "Spell") continue;
      const { state, poroId } = boardWithDeflector();
      state.players[0].hand = [instance(def.id)];
      let found: PlayCardAction | undefined;
      try {
        found = legalActions(state).find(
          (a): a is PlayCardAction =>
            a.type === "PlayCard" && a.card.defId === def.id && a.targetUnitInstanceId === poroId,
        );
      } catch {
        continue;
      }
      if (found && (found.payment.rainbowRunes ?? []).length > 0) return { state, action: found };
    }
    throw new Error("no taxed play found — has [Deflect] pricing changed?");
  }

  it("finds a real card the engine taxes, so the rest of this is about something", () => {
    const { action } = taxedPlay();
    expect((action.payment.rainbowRunes ?? []).length).toBeGreaterThan(0);
  });

  it("the OLD two-bucket payment is REFUSED — the bug, in the engine's own words", () => {
    const { state, action } = taxedPlay();
    const asTheBoardUsedToBuildIt: PlayCardAction = {
      ...action,
      payment: { energyRunes: action.payment.energyRunes, powerRunes: action.payment.powerRunes },
    };
    const { result } = submit(state, asTheBoardUsedToBuildIt);
    expect(result.type, "the two-bucket payment is no longer refused — has the premise changed?").toBe("Invalid");
    expect((result as { error: string }).error).toMatch(/rainbow Power for \[Deflect\]/);
  });

  it("the payment autoPayFill builds from an empty proposal is ACCEPTED", () => {
    const { state, action } = taxedPlay();
    const fill = autoPayFill(
      state.players[0].channeled,
      { energyRunes: [], powerRunes: [] },
      action.payment,
      // A Spell by construction — `taxedPlay` only looks at Spells — but the
      // union includes a Legend, which has no Power pip at all.
      action.card.kind === "Legend" ? null : action.card.powerDomain,
      action.card.kind === "Legend" ? undefined : action.card.powerDomainAlt,
    );
    expect(fill, "Auto Pay could not build a payment for a taxed target").not.toBeNull();
    const built: PlayCardAction = {
      ...action,
      payment: {
        energyRunes: fill!.energyRunes,
        powerRunes: fill!.powerRunes,
        ...(fill!.rainbowRunes.length > 0 ? { rainbowRunes: fill!.rainbowRunes } : {}),
      },
    };
    const { result } = submit(state, built);
    expect(result, `the engine refused the board's own payment: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  });
});
