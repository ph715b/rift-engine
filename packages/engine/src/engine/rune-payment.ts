import type { Domain } from "../model/domain.js";
import type { RuneCard } from "../model/rune.js";
import type { RunePayment } from "../actions/player-action.js";

/** null powerDomain means "no domain restriction" (rainbow) — matches every
 *  rune. In our current card pool this only ever happens when powerCost is
 *  0 (no printed card here has an actual rainbow Power cost yet), but the
 *  check mirrors ActionExecutor.matchesPowerDomain (engine/ActionExecutor.java:1841-1843)
 *  exactly rather than assuming powerCost > 0 implies a domain. */
function matchesPowerDomain(rune: RuneCard, powerDomain: Domain | null): boolean {
  return powerDomain === null || rune.domain === powerDomain;
}

/**
 * Builds a minimal, valid rune payment for a cost, or null if the pool
 * can't cover it. Mirrors ActionExecutor.computeAutoPayment
 * (engine/ActionExecutor.java:1422-1484), minus the Deflect rainbow-Power
 * surcharge parameter (no card here has ever needed it modeled yet).
 *
 * Domain-matching Exhausted runes pay Power first (free — they can't pay
 * Energy again regardless of what pays their Power cost); Ready runes
 * spent on Power still count toward the Energy cost too (the same
 * exhaust-then-recycle "double duty" the real rules and the oracle's own
 * doc comment describe) before reaching for additional plain-Energy runes.
 */
/** Mirrors ActionExecutor.energyAfterFloat: floating Energy reduces any
 *  Energy cost, no domain restriction. */
export function energyAfterFloat(floatingEnergy: number, rawEnergyCost: number): number {
  return Math.max(0, rawEnergyCost - floatingEnergy);
}

/** Mirrors ActionExecutor.powerAfterFloat: floating Power only reduces a
 *  Power cost of the matching domain (or the full rainbow pool when
 *  powerDomain is null, matching matchesPowerDomain's own null-is-wildcard
 *  convention above). A zero raw cost short-circuits regardless of domain. */
export function powerAfterFloat(
  floatingPower: Partial<Record<Domain, number>>,
  rawPowerCost: number,
  powerDomain: Domain | null,
): number {
  if (rawPowerCost === 0) return 0;
  const available =
    powerDomain === null
      ? Object.values(floatingPower).reduce((sum: number, n) => sum + (n ?? 0), 0)
      : (floatingPower[powerDomain] ?? 0);
  return Math.max(0, rawPowerCost - available);
}

/** Single source of truth for "what does this cost after floating resources
 *  are applied" — used identically by legal-actions, validate-play-card, and
 *  (re-derived independently from raw cost) execute-play-card, so the three
 *  can never drift out of sync with each other. */
export function computeEffectiveCost(
  floatingEnergy: number,
  floatingPower: Partial<Record<Domain, number>>,
  energyCost: number,
  powerCost: number,
  powerDomain: Domain | null,
): { energyCost: number; powerCost: number } {
  return {
    energyCost: energyAfterFloat(floatingEnergy, energyCost),
    powerCost: powerAfterFloat(floatingPower, powerCost, powerDomain),
  };
}

export function computeAutoPayment(
  channeled: readonly RuneCard[],
  energyCost: number,
  powerCost: number,
  powerDomain: Domain | null,
): RunePayment | null {
  const exhaustedMatch = channeled.filter((r) => r.state === "Exhausted" && matchesPowerDomain(r, powerDomain));
  const readyMatch = channeled.filter((r) => r.state === "Ready" && matchesPowerDomain(r, powerDomain));

  const powerRunes = exhaustedMatch.slice(0, powerCost);
  const stillNeededForPower = powerCost - powerRunes.length;
  const readyForPower = readyMatch.slice(0, Math.max(stillNeededForPower, 0));
  powerRunes.push(...readyForPower);
  if (powerRunes.length < powerCost) return null; // infeasible

  const powerRuneIds = new Set(powerRunes.map((r) => r.id));
  const energyRunes = readyForPower.slice(0, energyCost);
  const stillNeededEnergy = energyCost - energyRunes.length;

  const extraReady = channeled.filter((r) => r.state === "Ready" && !powerRuneIds.has(r.id));
  energyRunes.push(...extraReady.slice(0, Math.max(stillNeededEnergy, 0)));
  if (energyRunes.length < energyCost) return null; // infeasible

  return { energyRunes: energyRunes.map((r) => r.id), powerRunes: powerRunes.map((r) => r.id) };
}
