import { findUnitAnywhere } from "./target-lookup.js";
import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { Keyword } from "../model/keyword.js";
import { effectiveMight } from "./effective-might.js";

/**
 * Keywords a unit has RIGHT NOW, printed ones plus any it is currently being
 * granted by its own text.
 *
 * Several cards read "While I'm X, I have [Keyword]" or "If <condition>, I have
 * [Keyword]", and a keyword granted that way has to behave exactly like a
 * printed one — which means every place that asks "does this unit have
 * [Ganking]?" has to ask THIS rather than `unit.keywords` directly. There were
 * three such places (validate-move-unit, legal-actions' move fan-out, and
 * effectiveMight's Assault/Shield terms) and they would each have grown their
 * own copy of the condition otherwise.
 *
 * Deliberately a small keyed table, not a general continuous-ability engine —
 * the same convention `effective-might.ts`'s aura list follows, and for the same
 * reason: three confirmed cards, no speculation.
 *
 * Nothing here is ever written into state. A granted keyword is recomputed on
 * every read, so there is nothing to expire and no way for it to go stale when
 * the condition stops holding mid-turn.
 */

/** Raging Soul: "If you've discarded a card this turn, I have [Assault] and
 *  [Ganking]." A per-turn condition on the PLAYER, not on the unit. */
const RAGING_SOUL = "OGN-019";
/** Bilgewater Bully: "While I'm buffed, I have [Ganking]." A condition on the
 *  unit itself, so it comes and goes as the buff is placed and spent. */
const BILGEWATER_BULLY = "OGN-125";
/** Fiora - Victorious: "While I'm [Mighty], I have [Deflect], [Ganking], and
 *  [Shield]." Mighty is rule 711 — Might 5 or greater, evaluated on the unit's
 *  CURRENT Might. */
const FIORA_VICTORIOUS = "OGN-232";

/** The cards whose printed text this module implements — for coverage.ts, which
 *  would otherwise report them inert. */
export function grantedKeywordDefIds(): string[] {
  return [RAGING_SOUL, BILGEWATER_BULLY, FIORA_VICTORIOUS];
}

/** A grant condition, evaluated fresh on every read. */
type Grant = { when: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1) => boolean; keywords: Keyword[] };

const CONDITIONAL_GRANTS: Record<string, Grant> = {
  [RAGING_SOUL]: {
    when: (state, _unit, ownerIndex) => state.players[ownerIndex].discardedThisTurn,
    keywords: ["Assault", "Ganking"],
  },
  [BILGEWATER_BULLY]: {
    when: (_state, unit) => unit.buffed,
    keywords: ["Ganking"],
  },
  [FIORA_VICTORIOUS]: {
    when: (state, unit, ownerIndex) => isMighty(state, unit, ownerIndex),
    // [Deflect] is granted faithfully and does nothing yet — the keyword itself
    // is an open divergence (docs/rules-conformance.md). Granting it anyway
    // keeps this table a statement of what the CARD says rather than of what the
    // engine happens to support.
    keywords: ["Deflect", "Ganking", "Shield"],
  },
};

/**
 * Rule 711: "A Unit 'is Mighty' as long as its Might is 5 or greater", evaluated
 * on its CURRENT Might.
 *
 * Asked with `isCombat: false` deliberately, and that is what keeps this from
 * being circular: the combat-only terms are exactly [Assault] and [Shield], one
 * of which Fiora is granted BY being Mighty. Excluding combat keeps Mighty a
 * property of the unit rather than of the fight it happens to be in — which is
 * also what 711 describes.
 */
export function isMighty(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): boolean {
  return effectiveMight(state, unit, ownerIndex, { isCombat: false }) >= 5;
}

/**
 * `unit.keywords` plus whatever its own text is currently granting it.
 *
 * A granted keyword with no printed value takes 1 — the rules' default when a
 * keyword's X is omitted, and what "[Assault]" with no number means on Raging
 * Soul. A printed value is never lowered by a grant.
 */
export function effectiveKeywords(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
): Partial<Record<Keyword, number>> {
  const grant = CONDITIONAL_GRANTS[unit.defId];
  const hasThisTurn = Object.keys(unit.keywordsThisTurn).length > 0;
  if (!hasThisTurn && (!grant || !grant.when(state, unit, ownerIndex))) return unit.keywords;

  const out: Partial<Record<Keyword, number>> = { ...unit.keywords };
  // A this-turn grant (Udyr's "[Ganking] this turn") is a fact that happened and
  // holds for the turn; a conditional grant is re-asked every time. Both end up
  // in the same answer, because every reader wants "does it have this NOW".
  for (const [kw, n] of Object.entries(unit.keywordsThisTurn)) {
    out[kw as Keyword] = Math.max(out[kw as Keyword] ?? 0, n ?? 1);
  }
  if (grant && grant.when(state, unit, ownerIndex)) {
    for (const kw of grant.keywords) out[kw] = Math.max(out[kw] ?? 0, 1);
  }
  return out;
}

/** Does this unit have `keyword` right now, printed or granted? The question
 *  every caller actually wants to ask. */
export function hasKeyword(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, keyword: Keyword): boolean {
  return keyword in effectiveKeywords(state, unit, ownerIndex);
}

/**
 * `[Deflect N]`: "Opponents must pay N rainbow Power to choose me with a spell or
 * ability." Returns the extra rainbow Power `chooserIndex` must pay to target
 * this unit, or 0.
 *
 * **OPPONENTS.** Measured against the unit's owner, so choosing your own
 * Deflect unit costs nothing — the keyword taxes the enemy, and a caster-blind
 * version would tax you for buffing your own Fiora.
 *
 * **N is a parameter, not a flat pip.** Volibear - Furious prints `[Deflect 2]`
 * and it parses as `{"Deflect": 2}`. An omitted value means 1, which is what
 * `effectiveKeywords` already returns for a granted keyword.
 *
 * Read through `effectiveKeywords`, so a GRANTED Deflect taxes exactly like a
 * printed one — Fiora - Victorious has it only while she is [Mighty], and
 * Spirit's Refuge grants it to buffed units, so the answer genuinely changes as
 * Might and Buffs move. That is also why this is computed on read rather than
 * stored: there is nothing to expire and no way for it to go stale.
 *
 * Pure and target-scoped on purpose. It is the whole reason the cost pipeline
 * has to price PER TARGET rather than once per card, and keeping the arithmetic
 * separate from the payment plumbing means the two can be tested — and got
 * wrong — independently.
 */
export function deflectSurcharge(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, chooserIndex: 0 | 1): number {
  if (chooserIndex === ownerIndex) return 0; // "OPPONENTS must pay"
  return effectiveKeywords(state, unit, ownerIndex)["Deflect"] ?? 0;
}

/**
 * The total `[Deflect]` surcharge a play owes for CHOOSING these units — the one
 * function `legal-actions`, `validate-play-card` and `execute-play-card` all ask,
 * so the enumerator and the validator cannot disagree about the price.
 *
 * Summed per target, because 355 makes each chosen unit a target in its own right
 * and two Deflect units chosen by one spell are two taxes. Ids that name nothing
 * on the board contribute 0 rather than throwing: a target can die between
 * enumeration and validation, and the pricing must not be the thing that explodes.
 *
 * Floating Power deliberately does NOT reduce this. That is the design recorded
 * in docs/rules-conformance.md and it is the conservative reading — it can only
 * make a play cost more, never let one through that should not be — but it is
 * genuinely UNVERIFIED against the rules, which say nothing about whether a
 * rainbow surcharge draws on a floating pool.
 */
export function deflectSurchargeForTargets(
  state: GameState,
  chooserIndex: 0 | 1,
  targetInstanceIds: readonly (string | undefined)[],
): number {
  let total = 0;
  for (const id of targetInstanceIds) {
    if (id === undefined) continue;
    const found = findUnitAnywhere(state, id);
    if (!found) continue;
    total += deflectSurcharge(state, found.unit, found.ownerIndex, chooserIndex);
  }
  return total;
}
