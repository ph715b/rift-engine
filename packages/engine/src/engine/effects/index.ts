import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellDefinition, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { MightModifier } from "../effective-might.js";
import * as body from "./body.js";
import * as calm from "./calm.js";
import * as chaos from "./chaos.js";
import * as fury from "./fury.js";
import * as mind from "./mind.js";
import * as order from "./order.js";
import * as signatureFury from "./signature-fury.js";
import * as signatureCalm from "./signature-calm.js";
import * as signatureMind from "./signature-mind.js";
import * as signatureBody from "./signature-body.js";

/** Every per-domain source file, in a stable order. Exported so the ownership
 *  test can walk them without re-listing the set (a new domain file added here
 *  is automatically covered by that test). */
export const EFFECT_SOURCES = [
  { domain: "Fury" as const, name: "effects/fury.ts", module: fury },
  { domain: "Chaos" as const, name: "effects/chaos.ts", module: chaos },
  { domain: "Order" as const, name: "effects/order.ts", module: order },
  { domain: "Mind" as const, name: "effects/mind.ts", module: mind },
  { domain: "Body" as const, name: "effects/body.ts", module: body },
  { domain: "Calm" as const, name: "effects/calm.ts", module: calm },
  // **The dual-domain (champion signature) cards, split four ways on 2026-08-10.**
  //
  // `domain: null` means "no single owning domain", which is what makes these
  // cards signature cards. They shared one `signature.ts` until that file became
  // the largest remaining block of unwritten work AND the only one an agent
  // fan-out could not parallelise — six domain files, one signature file.
  //
  // A card's home is its FIRST domain in canonical order (Fury, Calm, Mind, Body,
  // Chaos, Order), so `Body+Fury` is Fury's and `Body+Order` is Body's. Nothing
  // lands in Chaos or Order today because every such card carries an earlier
  // domain; those files are not created until a card needs them.
  //
  // `name` is explicit now rather than derived from `domain`, which was null for
  // all of them and would have labelled four files "signature.ts".
  { domain: null, name: "effects/signature-fury.ts", module: signatureFury },
  { domain: null, name: "effects/signature-calm.ts", module: signatureCalm },
  { domain: null, name: "effects/signature-mind.ts", module: signatureMind },
  { domain: null, name: "effects/signature-body.ts", module: signatureBody },
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
  EFFECT_SOURCES.map((s) => ({ name: s.name, entries: s.module.cardEffects })),
);

/** Unit on-play triggers contributed by the per-domain files. */
export const domainUnitTriggers: Record<string, UnitTriggerDefinition> = mergeRegistries(
  "unit trigger",
  EFFECT_SOURCES.map((s) => ({ name: s.name, entries: s.module.unitTriggers })),
);

/** [Deathknell] effects contributed by the per-domain files, as mergeRegistries
 *  SOURCES rather than an already-merged record — triggers.ts composes them
 *  lazily to stay clear of the card-effects import cycle, so it needs the
 *  un-merged list. */
export function domainDeathTriggers(): { name: string; entries: Record<string, DeathknellDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: s.name,
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
    name: s.name,
    entries: s.module.deathWatchTriggers,
  }));
}

/** Event listeners contributed by the per-domain files, as mergeRegistries
 *  SOURCES — triggers.ts composes them lazily, same as domainDeathTriggers. */
export function domainEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: s.name,
    entries: s.module.eventTriggers,
  }));
}

/** Self-triggers contributed by the per-domain files. */
export function domainSelfTriggers(): { name: string; entries: Record<string, SelfTriggerDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: s.name,
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
    name: s.name,
    entries: s.module.activatedAbilities,
  }));
}

/**
 * Continuous Might modifiers contributed by the per-domain files.
 *
 * Lazy for the same reason as the activated abilities above: `effective-might.ts`
 * is imported by much of the engine, and composing at module scope would reach a
 * domain file before this module has finished initialising.
 */
export function domainMightModifierSources(): { name: string; entries: Record<string, MightModifier> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: s.name,
    entries: s.module.mightModifiers,
  }));
}

/** Pending-decision handlers contributed by the per-domain files. Lazy, like the
 *  trigger sources — decisions.ts and the effect files import each other. */
export function domainDecisions(): { name: string; entries: Record<string, DecisionDefinition> }[] {
  return EFFECT_SOURCES.map((s) => ({
    name: s.name,
    entries: s.module.decisions,
  }));
}
