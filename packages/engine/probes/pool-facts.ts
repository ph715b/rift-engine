/**
 * The facts about the card pool that every reachability report needs, read from
 * the registry once.
 *
 * Shared for the same reason `exercise-run.ts` is: `exercised.ts` and
 * `reachability.ts` must agree on the DENOMINATOR. An instrument quietly using a
 * different denominator from the rest of the project is how a figure ends up
 * argued about instead of trusted — and two probes reporting different
 * "never exercised" counts for the same engine would be exactly that.
 */
import { needsImplementation, setCodeOf } from "@rift-engine/engine";
import type { CardRegistry } from "@rift-engine/engine";

export interface PoolFacts {
  /** Every defId in the registry. */
  readonly pool: readonly string[];
  /**
   * The subset with rules text that had to be WRITTEN, and the denominator every
   * other doc and gate in this repo quotes. A vanilla card being unexercised
   * costs nothing — there is no code behind it to be wrong.
   */
  readonly needsCode: ReadonlySet<string>;
  /** Set codes present in the pool, sorted. */
  readonly setCodes: readonly string[];
  /** Set codes that a covering run can be built for, i.e. that have a Legend. A
   *  set WITHOUT one is a real finding about the pool, not a mode to skip. */
  readonly setCodesWithLegend: readonly string[];
  /** "OGN-001 Name", plus the two annotations that stop a reader mistaking a
   *  blind spot for a defect. */
  label(defId: string): string;
}

export function poolFacts(registry: CardRegistry): PoolFacts {
  const defs = registry.all();
  const needsCode = new Set(defs.filter(needsImplementation).map((d) => d.id));
  const nameOf = new Map(defs.map((d) => [d.id, d.name]));
  const typeOf = new Map(defs.map((d) => [d.id, d.type]));
  const setCodes = [...new Set(defs.map((d) => setCodeOf(d.id)))].sort();
  const setCodesWithLegend = [...new Set(defs.filter((d) => d.type === "Legend").map((d) => setCodeOf(d.id)))].sort();

  return {
    pool: defs.map((d) => d.id),
    needsCode,
    setCodes,
    setCodesWithLegend,
    /** A Legend can never be OFFERED: it starts in play and is never played, so
     *  its only signals are an activated ability or a trigger. Marked rather than
     *  filtered, because "a Legend that never fired" is still worth seeing — just
     *  not as evidence of an enumeration gap. */
    label: (id: string): string =>
      `${id} ${nameOf.get(id) ?? "?"}` +
      (typeOf.get(id) === "Legend" ? " [Legend — never offerable]" : "") +
      (needsCode.has(id) ? "" : " (vanilla)"),
  };
}
