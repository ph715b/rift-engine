import { describe, expect, it } from "vitest";
import type { RuneCard } from "../src/model/rune.js";
import { computeAutoPayment } from "../src/engine/rune-payment.js";

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
});
