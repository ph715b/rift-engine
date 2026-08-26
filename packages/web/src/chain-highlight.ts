import type { ChainItemDescription } from "@rift-engine/engine";

/** What the board should light up because of the chain. */
export interface ChainHighlight {
  /** Units something on the chain NAMES — a target, a second target, or a unit
   *  exhausted to pay for it. */
  units: Set<string>;
  /** Battlefields something on the chain names, as a target or a destination. */
  battlefields: Set<string>;
  /** Cards whose triggered ability IS the chain item — the cause rather than the
   *  subject. See below for why it is a separate set. */
  sources: Set<string>;
}

/**
 * **Which board objects the chain currently concerns, and in what role.**
 *
 * Lifted out of `GameBoard` so it can be tested against a real chain: it is a
 * pure function of the chain description, and everything it decides was
 * previously reachable only by rendering a three-thousand-line component.
 *
 * # Sources are not targets
 *
 * A triggered ability was the one chain item this board could say nothing about.
 * It carries no targets — the engine pushes triggers already-finalized, so
 * nothing was ever chosen (see `describeChain`) — so the target loop skipped it
 * entirely, and the player got a `⚡` row naming a card they then had to find
 * among thirty on the board. The effect arrived from an unidentified direction.
 *
 * Kept as its own set rather than folded into `units` because it is a different
 * claim: "this is about to DO something" and "something is about to happen TO
 * this" are opposite readings, and one highlight for both would say the wrong one
 * half the time. The board draws them differently for the same reason.
 *
 * # Why co-highlighting at all, rather than arrows
 *
 * The Java client drew real arrows and its own comment records why they were
 * unreliable: nodes added in the same layout pulse measured stale bounds, "and
 * that mismatch, not a logic bug, was why the arrow only sometimes appeared".
 * Framer Motion owns every card's transform here, so the same class of bug would
 * apply. Highlighting says the same thing with nothing measured.
 */
export function chainHighlight(
  items: readonly ChainItemDescription[],
  hoveredIndex: number | null,
): ChainHighlight {
  // Hovering ONE item narrows the board to that item's own concerns. With
  // several items up, the union answers "what does the chain touch" but never
  // "which item means which" — and that pairing is the whole reason to hover.
  const source = hoveredIndex !== null ? items.slice(hoveredIndex, hoveredIndex + 1) : items;
  const units = new Set<string>();
  const battlefields = new Set<string>();
  const sources = new Set<string>();

  for (const item of source) {
    // The listener is still on the BOARD (or in a trash, if it was a
    // [Deathknell]) — which is exactly what makes pointing at it worth doing,
    // unlike a spell, whose card the chain panel already shows.
    if (item.kind === "trigger") {
      sources.add(item.entry.listenerInstanceId);
      // Past here is TARGETS only, and a trigger has none.
      //
      // **This `continue` is held by the COMPILER, not by a test.** Removing it
      // survives the whole suite: `item.entry` would then be the union, every
      // target field reads `undefined` at runtime, and nothing is added — the
      // mutant is behaviourally equivalent. It is not equivalent to `tsc`, which
      // rejects five property accesses on `SpellChainEntry | TriggerChainEntry`.
      // Recorded rather than chased: a test that could tell the difference would
      // have to fabricate a trigger entry carrying target fields, which the
      // engine never produces.
      continue;
    }
    for (const id of [
      item.entry.targetUnitInstanceId,
      item.entry.secondTargetUnitInstanceId,
      item.entry.additionalCostUnitInstanceId,
    ]) {
      if (id !== undefined) units.add(id);
    }
    for (const id of [item.entry.targetBattlefieldId, item.entry.destinationBattlefieldId]) {
      if (id !== undefined) battlefields.add(id);
    }
  }
  return { units, battlefields, sources };
}
