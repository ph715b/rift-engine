import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellDefinition, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
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

/** [Deathknell] effects contributed by the per-domain files, as mergeRegistries
 *  SOURCES rather than an already-merged record — triggers.ts composes them
 *  lazily to stay clear of the card-effects import cycle, so it needs the
 *  un-merged list. */
export function domainDeathTriggers(): { name: string; entries: Record<string, DeathknellDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.deathTriggers,
  }));
}

/**
 * Death-WATCH listeners contributed by the per-domain files ("when a friendly
 * unit dies", as opposed to a `[Deathknell]`, which is keyed by the DYING card).
 *
 * Split out of the inline table in triggers.ts once Order had two of them
 * (Vanguard Helm and Viktor - Leader), which is exactly the condition that
 * table's own comment named for splitting.
 */
export function domainDeathWatch(): { name: string; entries: Record<string, DeathWatchDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.deathWatchTriggers,
  }));
}

/** Event listeners contributed by the per-domain files, as mergeRegistries
 *  SOURCES — triggers.ts composes them lazily, same as domainDeathTriggers. */
export function domainEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.eventTriggers,
  }));
}

/** Self-triggers contributed by the per-domain files. */
export function domainSelfTriggers(): { name: string; entries: Record<string, SelfTriggerDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.selfTriggers,
  }));
}

/**
 * Activated abilities contributed by the per-domain files.
 *
 * Lazy, like the trigger sources above: `activated-abilities.ts` is imported by
 * much of the engine, and composing at module scope would put it in the same
 * initialisation-order trap its own `"undefined" in ACTIVATED_ABILITIES` guard
 * exists to catch.
 */
export function domainActivatedAbilities(): { name: string; entries: Record<string, ActivatedAbilityDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.activatedAbilities,
  }));
}

/** Pending-decision handlers contributed by the per-domain files. Lazy, like the
 *  trigger sources — decisions.ts and the effect files import each other. */
export function domainDecisions(): { name: string; entries: Record<string, DecisionDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: `effects/${s.domain?.toLowerCase() ?? "signature"}.ts`,
    entries: s.module.decisions,
  }));
}
