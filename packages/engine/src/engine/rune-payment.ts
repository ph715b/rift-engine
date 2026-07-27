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
