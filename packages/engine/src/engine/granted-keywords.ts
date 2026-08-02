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

/**
 * Captain Farron: "Other friendly units here have [Assault]." The first keyword
 * aura in the pool whose SOURCE is a different card from the unit that gets the
 * keyword — every grant above is a card's own text about itself.
 */
const CAPTAIN_FARRON = "OGN-015";
/** Taric - Protector: "[Shield][Tank] Other friendly units here have [Shield]."
 *  The printed two are the card frame's; only the aura is written here. */
const TARIC_PROTECTOR = "OGN-074";
/**
 * Spirit's Refuge: "Friendly buffed units have [Deflect] if they didn't already."
 *
 * Two firsts, and both are why the aura table below needs more than a defId and a
 * keyword list. Its source is a **GEAR**, which is never at a battlefield in this
 * pool — so it can only be an unpositioned aura, which is also what its text says
 * (no "here"). And it carries a **per-target condition**: "buffed" is a property
 * of each receiving unit, re-asked as buffs are placed and spent.
 *
 * "If they didn't already" is not a third thing to implement — it is the
 * non-stacking that `Math.max` below already gives, and it is what stops the
 * grant LOWERING a printed `[Deflect 2]` to 1.
 */
const SPIRITS_REFUGE = "OGN-063";
/**
 * Gemcraft Seer: "[Vision] Other friendly units have [Vision]."
 *
 * **The rules use this exact sentence as their own worked example** of layer 2
 * (477): *"A permanent has the ability 'Other friendly units have [Vision].'
 * Other friendly units gain the Vision keyword in this layer."* So there is
 * nothing to guess about whether the aura is real.
 *
 * What it MEANS took the keyword's own definition: *"Vision is a Triggered
 * Ability keyword… functionally short for 'When this is played, predict.' **The
 * trigger is the permanent entering the Board.**"* That last sentence is the
 * whole card. Read as a "when you play me" ability the grant would be inert —
 * every unit already in play has had its play moment — but the trigger condition
 * is the ENTRY, so a unit arriving while the Seer stands predicts on arrival.
 *
 * `scope: "anywhere"`, because her text names no battlefield, unlike Farron's and
 * Taric's. That is also what makes her implementable without knowing where the
 * entering unit is going: see `unitEntersWithVision`.
 */
const GEMCRAFT_SEER = "OGN-100";

/** The cards whose printed text this module implements — for coverage.ts, which
 *  would otherwise report them inert. */
export function grantedKeywordDefIds(): string[] {
  return [RAGING_SOUL, BILGEWATER_BULLY, FIORA_VICTORIOUS, ...Object.keys(KEYWORD_AURAS)];
}

/**
 * A keyword granted to OTHER permanents by a source card — rule 477's layer 2,
 * "Ability-Altering Effects", which the rules identify by the words "have"/"has"
 * and whose own worked example is one of these very cards ("A permanent has the
 * ability 'Other friendly units have [Vision].' Other friendly units gain the
 * Vision keyword in this layer").
 *
 * Structurally different from `CONDITIONAL_GRANTS` above, which is keyed by the
 * RECEIVING unit's own defId because every entry there is a card talking about
 * itself. An aura is keyed by its SOURCE and has to be looked up from the other
 * end, which is why it could not be expressed as another `Grant`.
 *
 * Deliberately a small keyed table rather than a general continuous-ability
 * engine, the same convention `effective-might.ts`'s aura list follows and for the
 * same reason: three confirmed cards, no speculation.
 */
interface KeywordAura {
  /** Where the source lives. Gear is never at a battlefield here, so a gear
   *  source can only ever be `scope: "anywhere"`. */
  source: "unit" | "gear";
  /** `"here"` is the source's own battlefield and nothing else — so a source
   *  sitting in BASE reaches nobody, the same positional reading Lee Sin -
   *  Centered's and Leona - Zealot's Might auras take. */
  scope: "here" | "anywhere";
  /** "OTHER friendly units" — printed on both unit sources, and load-bearing:
   *  without it Taric grants himself a [Shield] he already has and Farron gives
   *  himself an [Assault] he does not print. */
  excludesSelf: boolean;
  /** A condition on the RECEIVING unit — Spirit's Refuge's "buffed". Asked fresh
   *  on every read, so it comes and goes with the buff. */
  appliesTo?: (unit: UnitInstance) => boolean;
  keywords: Keyword[];
}

const KEYWORD_AURAS: Record<string, KeywordAura> = {
  [CAPTAIN_FARRON]: { source: "unit", scope: "here", excludesSelf: true, keywords: ["Assault"] },
  [TARIC_PROTECTOR]: { source: "unit", scope: "here", excludesSelf: true, keywords: ["Shield"] },
  [GEMCRAFT_SEER]: { source: "unit", scope: "anywhere", excludesSelf: true, keywords: ["Vision"] },
  [SPIRITS_REFUGE]: {
    source: "gear",
    scope: "anywhere",
    excludesSelf: false,
    appliesTo: (unit) => unit.buffed,
    keywords: ["Deflect"],
  },
};

/** Where a unit in play stands, as the aura scopes express it. `undefined` for a
 *  unit that is not on the board at all — a card still in hand reaches here
 *  through `effectiveKeywords`, and it is nobody's neighbour. */
function locationOf(state: GameState, unit: UnitInstance): string | "base" | undefined {
  const found = findUnitAnywhere(state, unit.instanceId);
  if (!found) return undefined;
  return found.zone === "base" ? "base" : state.battlefields[found.zone.battlefieldIndex]?.id;
}

/**
 * Does `ownerIndex` have a copy of `defId` standing at `location`, OTHER than
 * `exceptInstanceId`?
 *
 * Asked this way round rather than through `effective-might.ownUnitLocation`,
 * which returns where the FIRST copy is. That is fine for the champion-tier cards
 * it serves, and wrong here: Captain Farron and Taric - Protector are ordinary
 * units, three copies to a deck, and two of them at two battlefields is an
 * ordinary board. Asking "is one HERE" cannot miss the second.
 *
 * **"Other" is a different OBJECT, not a different card.** Two Captain Farrons at
 * one battlefield each satisfy the other's "other friendly units", so each has
 * [Assault] and neither grants it to itself — which a defId comparison gets
 * exactly backwards, excluding both. That is why the exclusion is by instanceId
 * and lives here rather than as a check on the card's name.
 */
function ownUnitAtLocation(
  state: GameState,
  ownerIndex: 0 | 1,
  defId: string,
  location: string | "base",
  exceptInstanceId?: string,
): boolean {
  const owner = state.players[ownerIndex];
  const here = location === "base" ? owner.baseUnits : (state.battlefields.find((bf) => bf.id === location)?.units[owner.id] ?? []);
  return here.some((u) => u.defId === defId && u.instanceId !== exceptInstanceId);
}

/** Is a copy of `defId` in play for `ownerIndex` anywhere — base or any
 *  battlefield — other than `exceptInstanceId`? The unpositioned counterpart to
 *  `ownUnitAtLocation`, and instance-excluded for the same "other means a
 *  different object" reason. */
function ownUnitAnywhereExcept(state: GameState, ownerIndex: 0 | 1, defId: string, exceptInstanceId?: string): boolean {
  const owner = state.players[ownerIndex];
  const matches = (u: UnitInstance) => u.defId === defId && u.instanceId !== exceptInstanceId;
  if (owner.baseUnits.some(matches)) return true;
  return state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some(matches));
}

/** Every keyword an aura is currently granting `unit`. Empty for the overwhelming
 *  majority of reads, and it costs a board lookup only when a source is actually
 *  in play — `effectiveKeywords` runs per unit per damage step in combat. */
function auraGrantedKeywords(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): Keyword[] {
  const owner = state.players[ownerIndex];
  const granted: Keyword[] = [];
  let location: string | "base" | undefined;
  let located = false;

  for (const [sourceDefId, aura] of Object.entries(KEYWORD_AURAS)) {
    if (aura.appliesTo && !aura.appliesTo(unit)) continue;
    // "OTHER friendly units" excludes this unit as an OBJECT, never as a card —
    // see ownUnitAtLocation. The exclusion is therefore applied to the SOURCE
    // search below rather than by comparing defIds here.
    const except = aura.excludesSelf ? unit.instanceId : undefined;

    if (aura.source === "gear") {
      if (!owner.activeGear.some((g) => g.defId === sourceDefId)) continue;
    } else if (aura.scope === "here") {
      if (!located) {
        location = locationOf(state, unit);
        located = true;
      }
      // A unit that is not on the board, or that is in BASE, is out of reach of
      // a "here" aura: a base is not a battlefield, so no source can share one
      // with it. Same reading, for the same reason, as Lee Sin - Centered's
      // positional Might aura.
      if (location === undefined || location === "base") continue;
      if (!ownUnitAtLocation(state, ownerIndex, sourceDefId, location, except)) continue;
    } else if (!ownUnitAnywhereExcept(state, ownerIndex, sourceDefId, except)) {
      continue; // an unpositioned aura still needs its source in play
    }
    granted.push(...aura.keywords);
  }
  return granted;
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
  const fromAuras = auraGrantedKeywords(state, unit, ownerIndex);
  if (!hasThisTurn && fromAuras.length === 0 && (!grant || !grant.when(state, unit, ownerIndex))) return unit.keywords;

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
  // Another permanent's aura, folded in on the same terms as the card's own
  // grants — every reader wants "does it have this NOW", and nothing downstream
  // should be able to tell where a keyword came from. `Math.max` is what makes
  // Spirit's Refuge's "if they didn't already" true: a printed `[Deflect 2]` is
  // never lowered to the granted 1.
  //
  // **Multiple instances of the same keyword collapse to one**, because this map
  // holds a VALUE per keyword and not a COUNT. That is right for the valued
  // keywords ([Assault], [Shield], [Deflect]) — two sources granting [Shield] is
  // still [Shield 1], and the rules' redundancy rule (817.1.a) says so. It is a
  // real divergence for [Vision], whose rules text says "multiple instances of
  // Vision trigger separately"; see docs/rules-conformance.md.
  for (const kw of fromAuras) out[kw] = Math.max(out[kw] ?? 0, 1);
  return out;
}

/**
 * Will a unit `playerIndex` is about to play have `keyword` at the moment it
 * ENTERS the board?
 *
 * The question `[Vision]` needs and that `effectiveKeywords` cannot answer: the
 * card is still in hand, so it is on nobody's battlefield and is not yet anyone's
 * "other friendly unit". Vision's trigger condition is the permanent entering the
 * Board, so what matters is whether an aura will be granting it one instant later.
 *
 * Asked by BOTH `legal-actions` (which fans out the recycle choice) and
 * `validate-play-card` (which requires it), so the enumerator and the validator
 * cannot disagree about whether a play needs the choice — the drift that has
 * produced three offered-then-refused bugs in this codebase.
 *
 * **Only unpositioned auras are consulted.** A `scope: "here"` aura would depend
 * on the destination, which is part of the action being built and not settled
 * when this is asked; no Vision aura in this pool is positional, and the
 * assertion below makes a future one a loud failure rather than a silent
 * half-answer.
 */
export function keywordOnEntry(state: GameState, playerIndex: 0 | 1, def: { id: string; keywords?: Partial<Record<Keyword, number>> }, keyword: Keyword): boolean {
  if (def.keywords && keyword in def.keywords) return true;
  for (const [sourceDefId, aura] of Object.entries(KEYWORD_AURAS)) {
    if (!aura.keywords.includes(keyword)) continue;
    if (aura.source === "unit" && aura.scope === "here") {
      throw new Error(
        `keywordOnEntry: ${keyword} is granted by a positional aura (${sourceDefId}), whose reach depends on ` +
          `a destination this question does not carry. See this function's scope note.`,
      );
    }
    // `appliesTo` is deliberately not consulted: it reads the entering unit,
    // which does not exist yet. No Vision aura has one, and a future conditional
    // grant of an entry-triggered keyword would need the card instance rather
    // than the definition.
    if (aura.source === "gear") {
      if (state.players[playerIndex].activeGear.some((g) => g.defId === sourceDefId)) return true;
    } else if (ownUnitAnywhereExcept(state, playerIndex, sourceDefId)) {
      // No instance exclusion: the card being played is not on the board yet, so
      // it cannot be the source it is asking about. A SECOND Gemcraft Seer played
      // while the first stands is genuinely "another friendly unit" to that first
      // one, and predicts on arrival — which a defId comparison would have refused.
      return true;
    }
  }
  return false;
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
