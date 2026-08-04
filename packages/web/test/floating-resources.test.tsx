import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { Domain, RuneCard } from "@rift-engine/engine";
import { RuneZone, type FloatingResources } from "../src/components/RuneZone.js";

/**
 * Banked-but-unspent resources have to be VISIBLE.
 *
 * Reported from playtesting as "using Seals doesn't seem to add power". The
 * engine was right the whole time — `activated-abilities` banks the Power into
 * `floatingPower[domain]` — but `GameBoard` read `floatingEnergy`/`floatingPower`
 * only to price affordability and rendered neither, so a Seal of Rage correctly
 * adding 1 Fury Power was indistinguishable from an ability that did nothing.
 *
 * That makes this a rendering guarantee rather than a styling detail, and the
 * bug it guards against is silence, not a wrong number. So the assertions are on
 * the presence and the content of each pool, including the ones that are easy to
 * forget because no preset deck reaches them often: rainbow Power (Kai'Sa,
 * Malzahar) and the two Spells-only restricted pools (Lux - Crownguard).
 */

const runes = (n: number, domain: Domain = "Fury"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

const nothing: FloatingResources = { energy: 0, power: {}, rainbow: 0, restrictedEnergy: 0, restrictedPower: 0 };

function textOf(floating: FloatingResources): string {
  cleanup();
  const { container } = render(<RuneZone runes={runes(3)} floating={floating} />);
  const readout = container.querySelector(".floating-readout");
  expect(readout, "the floating readout was not rendered at all").not.toBeNull();
  return readout!.textContent ?? "";
}

describe("the floating-resource readout", () => {
  it("renders even when nothing is floating", () => {
    // The empty state is deliberate. A counter that only appears once it has a
    // value teaches nothing about where a resource went — which is the exact
    // failure being fixed, one step removed.
    expect(textOf(nothing)).toContain("nothing");
  });

  it("shows floating Energy", () => {
    expect(textOf({ ...nothing, energy: 2 })).toContain("2 Energy");
  });

  it("shows Power PER DOMAIN, which is the thing a Seal actually banks", () => {
    const text = textOf({ ...nothing, power: { Fury: 1, Order: 2 } });
    expect(text).toContain("1 Fury");
    expect(text).toContain("2 Order");
  });

  it("omits a domain with no Power banked, rather than printing a zero", () => {
    const text = textOf({ ...nothing, power: { Fury: 1, Calm: 0 } });
    expect(text).toContain("1 Fury");
    expect(text).not.toContain("Calm");
  });

  it("distinguishes rainbow Power from a domain's own", () => {
    // Rainbow pays a pip of ANY domain, so collapsing it into a domain chip
    // would misstate what the player can afford.
    const text = textOf({ ...nothing, rainbow: 1, power: { Fury: 1 } });
    expect(text).toContain("1 Rainbow");
    expect(text).toContain("1 Fury");
  });

  it("marks the Spells-only pools as restricted", () => {
    // `restrictedSpellEnergy`/`restrictedSpellPower` are spendable only on
    // Spells. Shown as their own chips because a player counting them as general
    // resources would mis-plan a turn.
    const text = textOf({ ...nothing, restrictedEnergy: 2, restrictedPower: 1 });
    expect(text).toContain("2 Energy (spells)");
    expect(text).toContain("1 Power (spells)");
  });

  it("is omitted entirely when no floating prop is given — the AI's zone", () => {
    cleanup();
    const { container } = render(<RuneZone runes={runes(3)} />);
    expect(container.querySelector(".floating-readout")).toBeNull();
  });
});
