/**
 * Deterministic PRNG (mulberry32) + Fisher-Yates shuffle. The Java oracle
 * shuffles with an unseeded `Collections.shuffle` (registry/CardRegistry.java:242)
 * — fidelity to the oracle covers *rules*, not incidental implementation
 * details like which shuffle algorithm runs, and the PRD's own
 * non-functional requirement calls for seeded, replayable shuffles, so this
 * is a deliberate improvement rather than a deviation from any real rule.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle; returns the same array for convenience. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
