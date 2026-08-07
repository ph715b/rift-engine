import type { Domain } from "../model/domain.js";
import type { RuneCard } from "../model/rune.js";
import type { RunePayment } from "../actions/player-action.js";

/** null powerDomain means "no domain restriction" (rainbow) — matches every
 *  rune. In our current card pool this only ever happens when powerCost is
 *  0 (no printed card here has an actual rainbow Power cost yet), but the
 *  check mirrors ActionExecutor.matchesPowerDomain (engine/ActionExecutor.java:1841-1843)
 *  exactly rather than assuming powerCost > 0 implies a domain.
 *
 *  powerDomainAlt (optional) is a hardcoded per-card second domain that can
 *  ALSO pay the cost — currently only set for a confirmed handful of
 *  genuinely hybrid-pip cards (Tibbers, OGS-018; see card-loader.ts's
 *  POWER_DOMAIN_ALT_OVERRIDES). Undefined for every other card, so
 *  `rune.domain === powerDomainAlt` is always false there and this is
 *  byte-identical to the old two-arg behavior for the rest of the pool. */
export function matchesPowerDomain(rune: RuneCard, powerDomain: Domain | null, powerDomainAlt?: Domain): boolean {
  return powerDomain === null || rune.domain === powerDomain || rune.domain === powerDomainAlt;
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
 *  convention above). A zero raw cost short-circuits regardless of domain.
 *  For a hybrid card (powerDomainAlt set), the alt domain's floating pool
 *  is summed in alongside the primary's — mirroring how `null` already
 *  sums every domain for a full-rainbow cost. */
export function powerAfterFloat(
  floatingPower: Partial<Record<Domain, number>>,
  rawPowerCost: number,
  powerDomain: Domain | null,
  powerDomainAlt?: Domain,
): number {
  if (rawPowerCost === 0) return 0;
  const available =
    powerDomain === null
      ? Object.values(floatingPower).reduce((sum: number, n) => sum + (n ?? 0), 0)
      : (floatingPower[powerDomain] ?? 0) + (powerDomainAlt !== undefined ? (floatingPower[powerDomainAlt] ?? 0) : 0);
  return Math.max(0, rawPowerCost - available);
}

/** Single source of truth for "what does this cost after floating resources
 *  are applied" — used identically by legal-actions, validate-play-card, and
 *  (re-derived independently from raw cost) execute-play-card, so the three
 *  can never drift out of sync with each other.
 *
 *  `restrictedSpellEnergy` (Lux-Crownguard's activated ability, Spells
 *  only — callers pass 0 for a Unit/Gear) is drained AFTER floating Energy,
 *  never before — mirrors ActionExecutor.java:644's own order (`afterFloat`
 *  computed first, `afterRestricted` second). The two pools' final combined
 *  total is order-independent (both are simple floor-at-0 subtractions), but
 *  the ORDER matters for which pool execute-play-card.ts actually drains —
 *  floating (fungible for anything) is spent before restricted (Spells
 *  only), so this parameter stays a distinct, later step rather than being
 *  folded into `energyCost` before this function ever sees it. */
/**
 * The RESTRICTED rainbow Power pool this card kind may drain — Kai'Sa's for a
 * Spell, Ornn's for a Gear, nothing for a Unit.
 *
 * One accessor rather than the ternary written out at each of the five cost
 * sites (three in `legal-actions`, one in `validate-play-card`, one in
 * `execute-play-card`'s float math). Those five must agree exactly or a play is
 * offered at one price and refused at another, which is this codebase's most
 * repeated bug.
 *
 * It picks BETWEEN the pools rather than summing them, and that is not a
 * simplification: a Gear is not a Spell and a Spell is not a Gear, so no card can
 * ever be owed both.
 */
export function restrictedPowerFor(
  actor: { restrictedSpellPower: number; restrictedGearPower: number },
  cardKind: string,
): number {
  if (cardKind === "Spell") return actor.restrictedSpellPower;
  if (cardKind === "Gear") return actor.restrictedGearPower;
  return 0;
}

export function computeEffectiveCost(
  floatingEnergy: number,
  floatingPower: Partial<Record<Domain, number>>,
  energyCost: number,
  powerCost: number,
  powerDomain: Domain | null,
  powerDomainAlt?: Domain,
  restrictedSpellEnergy = 0,
  /** Kai'Sa's rainbow, Spells only — callers pass 0 for a Unit/Gear. Applied
   *  after floatingPower for the same reason the Energy pool is applied after
   *  floating Energy: the fungible resource is spent before the restricted one.
   *  Rainbow, so it needs no domain match — any leftover Power cost takes it. */
  restrictedSpellPower = 0,
  /** Malzahar - Fanatic's rainbow, ANY card kind. Rainbow like the pool above,
   *  but unrestricted, so it is drained FIRST of the two — fungible before
   *  restricted, the same order floating Energy precedes Lux's Spells-only pool. */
  floatingRainbowPower = 0,
): { energyCost: number; powerCost: number } {
  const afterFloat = energyAfterFloat(floatingEnergy, energyCost);
  const powerAfterFloatingPools = Math.max(
    0,
    powerAfterFloat(floatingPower, powerCost, powerDomain, powerDomainAlt) - floatingRainbowPower,
  );
  return {
    energyCost: Math.max(0, afterFloat - restrictedSpellEnergy),
    powerCost: Math.max(0, powerAfterFloatingPools - restrictedSpellPower),
  };
}

export function computeAutoPayment(
  channeled: readonly RuneCard[],
  energyCost: number,
  powerCost: number,
  powerDomain: Domain | null,
  powerDomainAlt?: Domain,
  /**
   * A RAINBOW Power surcharge on top of the card's own cost — `[Deflect N]`.
   *
   * Filled from runes of ANY domain that this payment has not already spent, and
   * returned in its own `rainbowRunes` bucket. Taken LAST, after the card's own
   * Energy and Power are covered, because the card's Power is domain-restricted
   * and the surcharge is not: spending a matching rune on the surcharge first
   * could make an otherwise-payable card unpayable.
   *
   * Unlike the Energy/Power halves this does NOT get the Ready-rune double duty:
   * a rune recycled for the surcharge is gone, and if it were also counted for
   * Energy the same rune would be paying an opponent's tax and its owner's cost
   * at once.
   */
  rainbowCost = 0,
): RunePayment | null {
  const exhaustedMatch = channeled.filter((r) => r.state === "Exhausted" && matchesPowerDomain(r, powerDomain, powerDomainAlt));
  const readyMatch = channeled.filter((r) => r.state === "Ready" && matchesPowerDomain(r, powerDomain, powerDomainAlt));

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

  const base = { energyRunes: energyRunes.map((r) => r.id), powerRunes: powerRunes.map((r) => r.id) };
  if (rainbowCost <= 0) return base;

  // Any domain, any state: a Power cost is paid by RECYCLING (416), and an
  // already-exhausted rune recycles just as well as a Ready one. Excluding what
  // this payment has already committed is what stops one rune paying twice.
  const spent = new Set([...base.energyRunes, ...base.powerRunes]);
  const rainbow = channeled.filter((r) => !spent.has(r.id)).slice(0, rainbowCost);
  if (rainbow.length < rainbowCost) return null; // the surcharge is unpayable
  return { ...base, rainbowRunes: rainbow.map((r) => r.id) };
}
