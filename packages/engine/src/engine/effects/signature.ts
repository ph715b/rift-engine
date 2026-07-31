import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";

/**
 * Card implementations for the **dual-domain** cards — one file, one owner.
 *
 * These are the champion signature cards: 15 Spells plus Tibbers (the pool's only
 * dual-domain Unit), each printed in two domains — Icathian Rain (Fury+Mind),
 * Super Mega Death Rocket! (Fury+Chaos), Zenith Blade (Calm+Order), and so on.
 *
 * They get their own file because per-domain ownership is genuinely ambiguous for
 * them: a Fury+Chaos card belongs equally to fury.ts and chaos.ts, so filing it
 * by "first domain" would be arbitrary and two owners could each reasonably
 * believe it was theirs. One explicit owner removes the question.
 *
 * The ownership rule is enforced by test/effect-registry.test.ts: a defId may
 * only appear here if its CardDefinition has exactly two domains. Single-domain
 * cards belong in the matching effects/<domain>.ts; Legends belong in
 * engine/legend-abilities.ts (all 16 are dual-domain, so splitting them by domain
 * would put every one of them here).
 *
 * See effects/fury.ts's header for what adding a card owes: registration, a rule
 * or oracle citation, and an engine test.
 */
export const cardEffects: Record<string, EffectDefinition> = {};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {};
