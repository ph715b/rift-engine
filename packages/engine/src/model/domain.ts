/**
 * The six domain identities in Riftbound, plus Colorless. Order matches
 * `Domain`'s ordinal order in the Java oracle (model/Domain.java) — rune
 * deck composition and "lowest-ordinal domain" tie-breaks (see
 * CardDefinition.powerDomain) depend on this exact order, not just set
 * membership.
 */
export const DOMAINS = ["Fury", "Calm", "Mind", "Body", "Chaos", "Order", "Colorless"] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_ORDER = new Map<Domain, number>(DOMAINS.map((d, i) => [d, i]));

/** Sorts a copy of `domains` into ordinal order. Matches CardRegistry.orderedDomains
 *  (registry/CardRegistry.java:190-194), which decides e.g. which legend domain
 *  "A"/"B" (a deck's runeDomainACount/B) refers to. */
export function sortByDomainOrdinal(domains: readonly Domain[]): Domain[] {
  return [...domains].sort((a, b) => DOMAIN_ORDER.get(a)! - DOMAIN_ORDER.get(b)!);
}

/** Lowest-ordinal domain in a set, matching CardLoader.java's `domains.stream().min(...)`. */
export function lowestOrdinalDomain(domains: readonly Domain[]): Domain {
  if (domains.length === 0) throw new Error("lowestOrdinalDomain: empty domain list");
  return sortByDomainOrdinal(domains)[0]!;
}

export function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}
