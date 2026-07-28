import { describe, expect, it } from "vitest";
import type { RuneCard } from "../src/model/rune.js";
import {
  computeAutoPayment,
  computeEffectiveCost,
  energyAfterFloat,
  matchesPowerDomain,
  powerAfterFloat,
} from "../src/engine/rune-payment.js";

function rune(id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard {
  return { id, domain, state };
}

describe("computeAutoPayment", () => {
  it("pays a pure-Energy cost (powerCost 0) with any Ready runes, ignoring domain", () => {
    const channeled = [rune("r1", "Order"), rune("r2", "Calm"), rune("r3", "Order")];
    const payment = computeAutoPayment(channeled, 2, 0, null);
    expect(payment).not.toBeNull();
    expect(payment!.energyRunes).toHaveLength(2);
    expect(payment!.powerRunes).toHaveLength(0);
  });

  it("prefers an already-Exhausted domain-matching rune to pay Power (free — it can't pay Energy again anyway)", () => {
    const channeled = [rune("exhausted-calm", "Calm", "Exhausted"), rune("ready-order", "Order")];
    const payment = computeAutoPayment(channeled, 0, 1, "Calm");
    expect(payment).toEqual({ energyRunes: [], powerRunes: ["exhausted-calm"] });
  });

  it("falls back to a Ready domain-matching rune for Power when no Exhausted match exists, and double-counts it toward Energy", () => {
    // 1 Energy + 1 Power(Calm), only one Calm rune (Ready) plus one other Ready rune available.
    const channeled = [rune("ready-calm", "Calm"), rune("ready-order", "Order")];
    const payment = computeAutoPayment(channeled, 1, 1, "Calm");
    expect(payment).not.toBeNull();
    expect(payment!.powerRunes).toEqual(["ready-calm"]);
    // The same Ready Calm rune pays both Energy and Power ("double duty") —
    // execute-play-card is what credits the floating-Energy make-good for this.
    expect(payment!.energyRunes).toEqual(["ready-calm"]);
  });

  it("returns null when there is no domain-matching rune available to cover Power", () => {
    const channeled = [rune("ready-order-1", "Order"), rune("ready-order-2", "Order")];
    const payment = computeAutoPayment(channeled, 0, 1, "Calm");
    expect(payment).toBeNull();
  });

  it("returns null when Power is coverable but not enough Ready runes remain for Energy", () => {
    const channeled = [rune("exhausted-calm", "Calm", "Exhausted")];
    // Power is paid for free by the Exhausted rune, but there's nothing left for the 1 Energy cost.
    const payment = computeAutoPayment(channeled, 1, 1, "Calm");
    expect(payment).toBeNull();
  });

  it("never reuses the same rune id across both energyRunes and powerRunes as separate entries beyond true double-duty", () => {
    const channeled = [rune("a", "Calm"), rune("b", "Calm"), rune("c", "Order")];
    const payment = computeAutoPayment(channeled, 2, 1, "Calm");
    expect(payment).not.toBeNull();
    // Power costs 1, paid by a Ready Calm rune (double duty covers 1 of the 2 Energy);
    // the remaining 1 Energy comes from a different rune.
    expect(payment!.powerRunes).toHaveLength(1);
    expect(payment!.energyRunes).toHaveLength(2);
    const powerId = payment!.powerRunes[0]!;
    const otherEnergyId = payment!.energyRunes.find((id) => id !== powerId);
    expect(otherEnergyId).toBeDefined();
    expect(otherEnergyId).not.toBe(powerId);
  });

  it("null powerDomain (rainbow) matches any rune's domain for Power", () => {
    const channeled = [rune("only-order", "Order")];
    const payment = computeAutoPayment(channeled, 0, 1, null);
    expect(payment).toEqual({ energyRunes: [], powerRunes: ["only-order"] });
  });

  it("pays a hybrid Power cost (e.g. Tibbers' Fury/Chaos) with pure Fury, pure Chaos, or a mix", () => {
    const twoFury = [rune("f1", "Fury"), rune("f2", "Fury")];
    expect(computeAutoPayment(twoFury, 0, 2, "Fury", "Chaos")!.powerRunes).toHaveLength(2);

    const twoChaos = [rune("c1", "Chaos"), rune("c2", "Chaos")];
    expect(computeAutoPayment(twoChaos, 0, 2, "Fury", "Chaos")!.powerRunes).toHaveLength(2);

    const mixed = [rune("f1", "Fury"), rune("c1", "Chaos")];
    expect(computeAutoPayment(mixed, 0, 2, "Fury", "Chaos")!.powerRunes).toHaveLength(2);

    const wrongDomain = [rune("o1", "Order"), rune("o2", "Order")];
    expect(computeAutoPayment(wrongDomain, 0, 2, "Fury", "Chaos")).toBeNull();
  });
});

describe("matchesPowerDomain", () => {
  it("accepts the alt domain when set, in addition to the primary", () => {
    expect(matchesPowerDomain(rune("r", "Chaos"), "Fury", "Chaos")).toBe(true);
    expect(matchesPowerDomain(rune("r", "Fury"), "Fury", "Chaos")).toBe(true);
    expect(matchesPowerDomain(rune("r", "Order"), "Fury", "Chaos")).toBe(false);
  });

  it("behaves exactly as before when no alt domain is passed", () => {
    expect(matchesPowerDomain(rune("r", "Chaos"), "Fury")).toBe(false);
    expect(matchesPowerDomain(rune("r", "Fury"), "Fury")).toBe(true);
    expect(matchesPowerDomain(rune("r", "Order"), null)).toBe(true);
  });
});

describe("energyAfterFloat / powerAfterFloat / computeEffectiveCost", () => {
  it("energyAfterFloat floors at 0 rather than going negative", () => {
    expect(energyAfterFloat(0, 3)).toBe(3);
    expect(energyAfterFloat(2, 3)).toBe(1);
    expect(energyAfterFloat(5, 3)).toBe(0);
  });

  it("powerAfterFloat only draws from the matching domain's floating pool", () => {
    expect(powerAfterFloat({ Calm: 1 }, 1, "Calm")).toBe(0);
    expect(powerAfterFloat({ Calm: 1 }, 1, "Order")).toBe(1); // wrong domain — unaffected
    expect(powerAfterFloat({}, 1, "Calm")).toBe(1); // nothing floating
  });

  it("powerAfterFloat short-circuits to 0 when the raw cost is already 0, regardless of domain", () => {
    expect(powerAfterFloat({}, 0, "Calm")).toBe(0);
    expect(powerAfterFloat({}, 0, null)).toBe(0);
  });

  it("powerAfterFloat sums every domain's floating Power when powerDomain is null (rainbow)", () => {
    expect(powerAfterFloat({ Calm: 1, Order: 2 }, 2, null)).toBe(0);
  });

  it("computeEffectiveCost is a no-op when nothing is floating (matches every existing zero-float fixture)", () => {
    expect(computeEffectiveCost(0, {}, 3, 1, "Calm")).toEqual({ energyCost: 3, powerCost: 1 });
  });

  it("computeEffectiveCost reduces both Energy and domain-matched Power together", () => {
    expect(computeEffectiveCost(1, { Calm: 1 }, 3, 1, "Calm")).toEqual({ energyCost: 2, powerCost: 0 });
  });

  it("powerAfterFloat sums both the primary and alt domain's floating Power for a hybrid cost", () => {
    expect(powerAfterFloat({ Chaos: 2 }, 2, "Fury", "Chaos")).toBe(0);
    expect(powerAfterFloat({ Fury: 1, Chaos: 1 }, 2, "Fury", "Chaos")).toBe(0);
    expect(powerAfterFloat({ Order: 5 }, 2, "Fury", "Chaos")).toBe(2); // wrong domain entirely, unaffected
  });
});
