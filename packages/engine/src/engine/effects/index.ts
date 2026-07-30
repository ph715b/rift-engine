import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import * as body from "./body.js";
import * as calm from "./calm.js";
import * as chaos from "./chaos.js";
import * as fury from "./fury.js";
import * as mind from "./mind.js";
import * as order from "./order.js";
import * as signature from "./signature.js";

/** Every per-domain source file, in a stable order. Exported so the ownership
 *  test can walk them without re-listing the set (a new domain file added here
 *  is automatically covered by that test). */
export const EFFECT_SOURCES = [
  { domain: "Fury" as const, module: fury },
  { domain: "Chaos" as const, module: chaos },
  { domain: "Order" as const, module: order },
  { domain: "Mind" as const, module: mind },
  { domain: "Body" as const, module: body },
  { domain: "Calm" as const, module: calm },
  // null = "no single owning domain": the dual-domain signature cards.
  { domain: null, module: signature },
];

/**
 * Merges the per-file registries into one, **throwing on a duplicate defId**.
 *
 * The throw is the point. These files are meant to be edited independently, so
 * the realistic failure is two owners both registering the same card — a
 * Fury+Chaos spell landing in fury.ts as well as signature.ts, say. A silent
 * last-write-wins merge would pick one implementation arbitrarily and the loser
 * would look like it had simply never been written. Failing at import turns that
 * into an immediate, named error instead.
 *
 * Thrown at module load rather than returned as a result because there is no
 * sensible way to continue: the registry is a program invariant, not user input.
 */
export function mergeRegistries<T>(label: string, sources: { name: string; entries: Record<string, T> }[]): Record<string, T> {
  const merged: Record<string, T> = {};
  const owner = new Map<string, string>();
  for (const source of sources) {
    for (const [defId, entry] of Object.entries(source.entries)) {
      const existing = owner.get(defId);
      if (existing !== undefined) {
        throw new Error(`Duplicate ${label} for ${defId}: registered in both ${existing} and ${source.name}`);
      }
      owner.set(defId, source.name);
      merged[defId] = entry;
    }
  }
  return merged;
}

/** Spell/Gear effects contributed by the per-domain files. */
export const domainCardEffects: Record<string, EffectDefinition> = mergeRegistries(
  "card effect",
  EFFECT_SOURCES.map((s) => ({ name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`, entries: s.module.cardEffects })),
);

/** Unit on-play triggers contributed by the per-domain files. */
export const domainUnitTriggers: Record<string, UnitTriggerDefinition> = mergeRegistries(
  "unit trigger",
  EFFECT_SOURCES.map((s) => ({ name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`, entries: s.module.unitTriggers })),
);
