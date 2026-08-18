import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import { slotOwner, slotScope, type TargetingSpec, type TargetScope } from "./card-effects.js";
import { effectiveMight } from "./effective-might.js";
import { canonicalDefId } from "../cards/card-loader.js";
import { counterableSpells } from "./counter-spell.js";
import { attackerIndexAt } from "./combat-designation.js";
// NOTE: equipment.ts imports findUnitAnywhere from this module, so this is a
// CYCLE. It resolves because both sides are hoisted function declarations called
// only at runtime, never at module initialisation — the same shape as the
// pre-existing card-effects cycle coverage.ts records. Duplicating the walk here
// instead would put the "same controller" rule in two places, which is the bug
// this repo keeps shipping.
import { equipmentPairedWith } from "./equipment.js";

export interface BattlefieldUnitLocation {
  unit: UnitInstance;
  ownerId: string;
  ownerIndex: 0 | 1;
  battlefieldIndex: number;
}

/** Where a unit found by findUnitAnywhere actually sits. `"base"` carries no
 *  battlefield index because a base unit isn't at one — callers that need a
 *  battlefield id must branch on this rather than assume. */
export type UnitZone = "base" | { battlefieldIndex: number };

export interface AnyUnitLocation {
  unit: UnitInstance;
  ownerId: string;
  ownerIndex: 0 | 1;
  zone: UnitZone;
}

/**
 * Finds a unit by instanceId ANYWHERE in play — either player's base or any
 * battlefield. The counterpart to findUnitOnBattlefield below, which stays
 * for the many cards whose text really does say "a unit at a battlefield".
 *
 * Riftbound's card text draws this distinction deliberately: "Deal 8 to a
 * unit" (Final Spark) reaches a unit sitting at home, "Deal 2 to a unit at a
 * battlefield" (Incinerate) does not. Which lookup a card uses is therefore
 * a per-card property — see TargetingSpec's `scope`.
 */
export function findUnitAnywhere(state: GameState, instanceId: string): AnyUnitLocation | undefined {
  for (const ownerIndex of [0, 1] as const) {
    const player = state.players[ownerIndex];
    const unit = player.baseUnits.find((u) => u.instanceId === instanceId);
    if (unit) return { unit, ownerId: player.id, ownerIndex, zone: "base" };
  }
  const atBattlefield = findUnitOnBattlefield(state, instanceId);
  if (!atBattlefield) return undefined;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = atBattlefield;
  return { unit, ownerId, ownerIndex, zone: { battlefieldIndex } };
}

/** Every unit satisfying a `"unit"`-style owner constraint relative to
 *  `playerIndex` — the same scan legal-actions.ts's own fan-out performs.
 *  `scope: "anywhere"` additionally includes both players' base units. */
export function eligibleTargets(
  state: GameState,
  playerIndex: 0 | 1,
  owner?: "friendly" | "enemy",
  scope: "battlefield" | "anywhere" | "base" = "battlefield",
): UnitInstance[] {
  const ownerMatches = (ownerIndex: 0 | 1) =>
    !(owner === "friendly" && ownerIndex !== playerIndex) && !(owner === "enemy" && ownerIndex === playerIndex);

  const inBase =
    scope === "anywhere" || scope === "base"
      ? ([0, 1] as const).flatMap((ownerIndex) =>
          ownerMatches(ownerIndex)
            ? // Ruin Runner. Filtered in the WALK rather than by each caller, so
              // every one of the six fan-out sites and both validator sites get
              // the negative from one place — see `unitChooseableBy`.
              state.players[ownerIndex].baseUnits.filter((u) => unitChooseableBy(state, u, ownerIndex, playerIndex))
            : [],
        )
      : [];
  // "base" is base and NOTHING else — the one scope that excludes battlefields
  // rather than adding to them.
  if (scope === "base") return inBase;
  return [...inBase, ...eligibleBattlefieldUnits(state, playerIndex, owner)];
}

function eligibleBattlefieldUnits(state: GameState, playerIndex: 0 | 1, owner?: "friendly" | "enemy"): UnitInstance[] {
  return state.battlefields.flatMap((bf) =>
    Object.entries(bf.units).flatMap(([ownerId, units]) => {
      const ownerIndex: 0 | 1 = state.players[0]!.id === ownerId ? 0 : 1;
      if (owner === "friendly" && ownerIndex !== playerIndex) return [];
      if (owner === "enemy" && ownerIndex === playerIndex) return [];
      return units.filter((u) => unitChooseableBy(state, u, ownerIndex, playerIndex));
    }),
  );
}

/**
 * Are these two units at the SAME battlefield — Facebreaker's "a friendly unit
 * and an enemy unit at the same battlefield"?
 *
 * False when either is in base, which is the right answer rather than an edge
 * case: a base is not a battlefield, so two units in the same base do not
 * satisfy "at the same battlefield" and neither does one of each.
 *
 * Lives here so the enumerator and the validator ask it in exactly the same
 * words. Those two disagreeing about what is legal is a bug this codebase has
 * shipped before, and it surfaces as the AI throwing on an action it was offered.
 */
export function shareABattlefield(state: GameState, firstInstanceId: string, secondInstanceId: string): boolean {
  const first = findUnitOnBattlefield(state, firstInstanceId);
  const second = findUnitOnBattlefield(state, secondInstanceId);
  return first !== undefined && second !== undefined && first.battlefieldIndex === second.battlefieldIndex;
}

/**
 * Does this unit satisfy an `attackingOnly` restriction (Thwonk!'s "stun an
 * ATTACKING unit")?
 *
 * The Attacker designation is 464.2.c Step 1's: the units standing at a Contested
 * battlefield that belong to the player who contested it. Asked through
 * `attackerIndexAt`, which is the one function in this engine that answers "who
 * is attacking here" — the same one `isAttackingAt` uses for the "when I attack"
 * triggers, so a card that TARGETS attackers and a card that TRIGGERS on
 * attacking cannot come to disagree about who they are.
 *
 * A unit in BASE is never an attacker, so it is refused rather than waved
 * through. That is the opposite default from `unitWithinMaxMight` below, which
 * returns `true` for a unit it cannot locate — and deliberately: an unfindable
 * Might restriction should not silently forbid a target, while an unfindable
 * ATTACKER genuinely is not attacking.
 *
 * One shared predicate, called by the enumerator, the validator and
 * `hasAnyLegalEffectChoice`, for the reason this file keeps repeating: three
 * spellings of the same rule is how a target comes to be offered and refused.
 */
export function unitSatisfiesAttackingOnly(
  state: GameState,
  unit: UnitInstance,
  attackingOnly: true | undefined,
): boolean {
  if (attackingOnly !== true) return true;
  const at = findUnitOnBattlefield(state, unit.instanceId);
  if (!at) return false;
  return attackerIndexAt(state, state.battlefields[at.battlefieldIndex]!.id) === at.ownerIndex;
}

/**
 * Does this unit satisfy a `maxMight` restriction (Gust's "3 Might or less")?
 * Routes through effectiveMight rather than `might + mightThisTurn`, so a unit
 * standing under a continuous aura is judged at the Might it actually has —
 * three separate call sites used to inline the raw sum and would happily let
 * you Gust a 3-Might unit that Garen - Commander had made a 4. Non-combat
 * context, matching dealDamage: auras count, [Shield]/[Assault] don't.
 */
export function unitWithinMaxMight(state: GameState, unit: UnitInstance, maxMight: number | undefined): boolean {
  if (maxMight === undefined) return true;
  // findUnitAnywhere, not findUnitOnBattlefield: this used to return `true`
  // for anything it couldn't find at a battlefield, so once base units became
  // targetable a base unit would have skipped the Might restriction entirely.
  const location = findUnitAnywhere(state, unit.instanceId);
  if (!location) return true;
  const ctx =
    location.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
  return effectiveMight(state, unit, location.ownerIndex, ctx) <= maxMight;
}

/** Resolves a target under the spec's own scope, so validation looks in
 *  exactly the places legal-actions.ts enumerated from. Returns the fields
 *  both callers need (owner + the unit itself), flattening the two location
 *  shapes.
 *
 *  Lived in validate-play-card.ts while the validator was its only caller.
 *  Moved here when `unitListChoiceError` below — which BOTH the validator and
 *  the enumerator ask — needed it: a second copy is precisely how the two
 *  would come to disagree about where a target may stand. */
export function findUnitInScope(
  state: GameState,
  instanceId: string,
  scope: TargetScope | undefined,
): { unit: UnitInstance; ownerIndex: 0 | 1 } | undefined {
  if (scope === "anywhere") return findUnitAnywhere(state, instanceId);
  // "base" is narrower than "anywhere", not a synonym: found anywhere, then kept
  // only if it really is in a base. Without the second half, Showstopper would
  // accept a unit already at a battlefield that enumeration never offered.
  if (scope === "base") {
    const found = findUnitAnywhere(state, instanceId);
    const inBase = found !== undefined && state.players[found.ownerIndex].baseUnits.some((u) => u.instanceId === instanceId);
    return inBase ? found : undefined;
  }
  return findUnitOnBattlefield(state, instanceId);
}

export function scopeDescription(scope: TargetScope | undefined): string {
  if (scope === "anywhere") return "in play";
  return scope === "base" ? "in a base" : "at a battlefield";
}

/** The `unitList` variant of TargetingSpec, taken from the union rather than
 *  restated so the two can never drift. */
export type UnitListSpec = Extract<TargetingSpec, { kind: "unitList" }>;

/**
 * Why this set of ids is NOT a legal choice for `spec`, or undefined when it is.
 *
 * THE one place `unitList` legality is decided. `legal-actions` builds candidate
 * sets and `validate-play-card` accepts submitted ones, and them disagreeing is
 * the offered-then-refused shape this codebase has shipped three times — most
 * recently found only by self-play, because the AI takes an enumerated action
 * straight to the executor. A shared predicate is the only version of this that
 * cannot drift.
 *
 * Returns a MESSAGE rather than a boolean so the validator's failure says which
 * rule was broken, which is what the six separate checks below are worth.
 *
 * The group requirement (`maxTotalMight`) is read as EFFECTIVE Might, and that
 * is the rules' own reading — the PDF's Fox-Fire example turns on a Reaction
 * raising two Recruits' Might after the targets were chosen. This is the
 * ANNOUNCE-time check; the resolution-time re-check ("choose a legal subset of
 * the original targets") is the resolver's, and is deliberately not here.
 */
export function unitListChoiceError(
  state: GameState,
  playerIndex: 0 | 1,
  spec: UnitListSpec,
  ids: readonly string[],
): string | undefined {
  if (ids.length < spec.min) return `requires ${spec.min} target${spec.min === 1 ? "" : "s"}, got ${ids.length}`;
  if (spec.max !== undefined && ids.length > spec.max) return `takes at most ${spec.max} targets, got ${ids.length}`;
  if (spec.allowsDuplicates !== true && new Set(ids).size !== ids.length) {
    return "requires distinct units";
  }

  const battlefieldIds = new Set<string>();
  const locationKeys = new Set<string>();
  let totalMight = 0;
  for (const id of ids) {
    const location = findUnitInScope(state, id, spec.scope);
    if (!location) return `${id} is not a unit ${scopeDescription(spec.scope)}`;
    if (spec.owner === "friendly" && location.ownerIndex !== playerIndex) return `${location.unit.name} is not a friendly unit`;
    if (spec.owner === "enemy" && location.ownerIndex === playerIndex) return `${location.unit.name} is not an enemy unit`;

    if (spec.sameBattlefield) {
      const at = findUnitOnBattlefield(state, id);
      // A unit in base is at no battlefield, so it can never join a group the
      // card requires to be "at a battlefield" — the same reading `shareABattlefield`
      // takes for the two-slot case.
      if (!at) return `${location.unit.name} is not at a battlefield`;
      battlefieldIds.add(state.battlefields[at.battlefieldIndex]!.id);
    }
    // "At the same LOCATION" (198.1: Locations include the Battlefields and the
    // Bases). Keyed by zone rather than by battlefield id, so each base is its
    // own location and a unit in each base is two locations, not one group.
    if (spec.sameLocation) {
      const at = findUnitOnBattlefield(state, id);
      locationKeys.add(at ? `bf:${state.battlefields[at.battlefieldIndex]!.id}` : `base:${location.ownerIndex}`);
    }
    if (spec.maxTotalMight !== undefined) {
      const at = findUnitOnBattlefield(state, id);
      const ctx = at ? { isCombat: false, battlefieldId: state.battlefields[at.battlefieldIndex]!.id } : { isCombat: false };
      totalMight += effectiveMight(state, location.unit, location.ownerIndex, ctx);
    }
  }

  if (spec.sameBattlefield && battlefieldIds.size > 1) return "requires every unit at the SAME battlefield";
  if (spec.sameLocation && locationKeys.size > 1) return "requires every unit at the SAME location";
  if (spec.maxTotalMight !== undefined && totalMight > spec.maxTotalMight) {
    return `requires total Might ${spec.maxTotalMight} or less, got ${totalMight}`;
  }
  return undefined;
}

/**
 * How many candidate sets this repo is willing to enumerate exactly.
 *
 * **Measured, not picked**, and it is a trade between two consumers that want
 * opposite things. Exhaustive enumeration is what keeps the WEB UI honest, since
 * the board narrows its clickable targets against this pool; but the heuristic AI
 * SCORES every enumerated action by applying it through the real executors, so
 * the pool is also its per-decision cost.
 *
 * Measured on a board of 3 units: Icathian Rain's six slots come to 3^6 = **729**
 * variants for one card in hand — 729 full executions at every decision point,
 * which is not a cost worth paying for a card that is going to deal 12 damage
 * whatever the spread. At 200:
 *   - **Falling Star** (2 of N, duplicates) is exact up to a 14-unit board;
 *   - **Fox-Fire** (subsets under a Might cap) is exact up to 7 units, and its
 *     group cap prunes hard below that anyway;
 *   - **Icathian Rain** is exact to 2 units and sampled beyond.
 * So the one card whose UI is limited to sampled spreads is the one whose choice
 * matters least, and it is named in docs/rules-conformance.md rather than left
 * for a player to discover.
 */
const UNIT_LIST_EXHAUSTIVE_CAP = 200;

/** Every legal set, or undefined when there are too many to enumerate.
 *  Ordered tuples when duplicates are legal (the rules make the choices ordered),
 *  combinations otherwise. */
function exhaustiveUnitLists(
  state: GameState,
  playerIndex: 0 | 1,
  spec: UnitListSpec,
  pool: readonly UnitInstance[],
): string[][] | undefined {
  const n = pool.length;
  const sizes: number[] = [];
  const maxSize = spec.max ?? n;
  for (let size = spec.min; size <= maxSize; size += 1) sizes.push(size);

  // Cheap upper bound before doing any work.
  //
  // With duplicates the choices are ordered tuples, so it is n^size summed over
  // the sizes wanted. WITHOUT duplicates every candidate is a distinct SUBSET, so
  // 2^n bounds them ALL AT ONCE rather than per size — summing 2^n per size (as
  // this first did) over-counted Fox-Fire by a factor of seven and pushed a
  // 64-set board over the cap into sampling for no reason.
  const bound = spec.allowsDuplicates ? sizes.reduce((total, size) => total + n ** size, 0) : 2 ** n;
  if (!Number.isFinite(bound) || bound > UNIT_LIST_EXHAUSTIVE_CAP) return undefined;

  const out: string[][] = [];
  const walk = (prefix: string[], startIndex: number) => {
    if (prefix.length >= spec.min && (spec.max === undefined || prefix.length <= spec.max)) {
      if (unitListChoiceError(state, playerIndex, spec, prefix) === undefined) out.push([...prefix]);
    }
    if (prefix.length >= maxSize) return;
    // With duplicates the choices are ORDERED and repeatable, so every index is
    // available at every position; without them a combination is enough, since
    // the resolvers all apply the same instruction per entry.
    const from = spec.allowsDuplicates ? 0 : startIndex;
    for (let i = from; i < n; i += 1) {
      prefix.push(pool[i]!.instanceId);
      walk(prefix, i + 1);
      prefix.pop();
    }
  };
  walk([], 0);
  return out;
}

/**
 * A BOUNDED sample of legal target sets for a `unitList` spec — what the AI
 * searches over and what `hasAnyLegalEffectChoice` asks for existence.
 *
 * **Bounded on purpose, and this is the one divergence the announce-time
 * decision costs.** Icathian Rain names six targets over a board of a dozen
 * units: the powerset is ~10^5 variants, which would swamp `legal-actions` and
 * the heuristic AI's per-action scoring. So this emits a handful of sensible
 * shapes rather than every combination:
 *
 *   - the empty choice, when `min` is 0;
 *   - **all on one unit**, for every candidate, when duplicates are legal — the
 *     "focus it down" play, and the only way Falling Star kills a 5-Might unit;
 *   - **spread across distinct units**, taking candidates in board order from
 *     each starting offset — the "clear the board" play;
 *   - for an unbounded `max`, the largest legal prefix and every shorter one down
 *     to `min`, which is what "any number" actually offers a player.
 *
 * The divergence is narrow and honest: *the AI considers a subset of target
 * combinations*. It is a search limitation in the same family as the existing
 * one-ply lookahead — `validate-play-card` accepts ANY legal set, and the UI
 * builds one by clicking, so nothing about what is LEGAL or what a human can do
 * is affected. Recorded in docs/rules-conformance.md.
 *
 * Deterministic — same board, same list, in board order. A sampler that reached
 * for randomness would make self-play runs incomparable, which this repo's probe
 * notes already have three examples of.
 */
export function unitListCandidates(state: GameState, playerIndex: 0 | 1, spec: UnitListSpec): string[][] {
  const pool = eligibleTargets(state, playerIndex, spec.owner, spec.scope);
  const out: string[][] = [];
  const push = (ids: string[]) => {
    if (unitListChoiceError(state, playerIndex, spec, ids) === undefined) out.push(ids);
  };

  if (spec.min === 0) push([]);
  if (pool.length === 0) return out;

  // EXHAUSTIVE when the space is small enough to afford, sampled only when it is
  // not — and the distinction is not an optimisation, it is what keeps the WEB UI
  // honest. The board narrows its clickable targets against this same enumeration,
  // so a set the enumeration never emitted is a set a human cannot build; a
  // permanently-sampled pool would quietly cap what a player may choose, which is
  // a far worse divergence than the AI searching a subset.
  //
  // In practice this makes Falling Star (2 of N, duplicates) and Fox-Fire (a
  // group at one battlefield under a Might cap) exact on any real board, and
  // leaves only Icathian Rain's six slots sampled once the board passes ~3 units.
  const exhaustive = exhaustiveUnitLists(state, playerIndex, spec, pool);
  if (exhaustive) return exhaustive;

  // "Any number" has no natural size, so the sample is every prefix length; a
  // fixed-size spec has exactly one size to fill.
  const sizes = spec.max === undefined ? Array.from({ length: pool.length }, (_, i) => i + 1) : [spec.max];
  for (const size of sizes) {
    if (size < spec.min) continue;
    // All on one target — only meaningful, and only legal, with duplicates.
    if (spec.allowsDuplicates) {
      for (const unit of pool) push(Array.from({ length: size }, () => unit.instanceId));
    }
    // Spread across distinct units, from each starting offset, so a board bigger
    // than the requirement still offers every unit a chance to be included.
    for (let offset = 0; offset < pool.length; offset += 1) {
      const picked = Array.from({ length: size }, (_, i) => pool[(offset + i) % pool.length]!.instanceId);
      if (new Set(picked).size !== picked.length && spec.allowsDuplicates !== true) continue;
      push(picked);
    }
  }

  // Distinct sets only — the offsets above overlap heavily on a small board, and
  // a duplicate variant is a duplicate legal action the AI would score twice.
  const seen = new Set<string>();
  return out.filter((ids) => {
    const key = ids.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Could this targeting spec be satisfied AT ALL right now — is there at least
 * one legal choice on the board? The boolean counterpart to legal-actions.ts's
 * effect-variant fan-out, asking the same question that fan-out answers
 * structurally by producing zero variants.
 *
 * Used by validate-play-card.ts to decide whether a Unit may be played with
 * its on-play trigger's target omitted: permitted only when there was nothing
 * to choose, so an omitted field can never be a way to duck a mandatory
 * trigger. Kept here rather than in either caller because it has to agree with
 * BOTH of them — see legal-actions.ts's own `card.kind === "Unit" &&
 * effectVariants.length === 0` note.
 */
export function hasAnyLegalEffectChoice(state: GameState, playerIndex: 0 | 1, targeting: TargetingSpec): boolean {
  switch (targeting.kind) {
    case "none":
      return true; // nothing to choose, nothing missing
    case "battlefield":
      return state.battlefields.length > 0;
    case "unit":
      return eligibleTargets(state, playerIndex, targeting.owner, targeting.scope).some(
        (u) =>
          unitWithinMaxMight(state, u, targeting.maxMight) &&
          unitSatisfiesAttackingOnly(state, u, targeting.attackingOnly),
      );
    case "unitSlots": {
      // Nothing is REQUIRED when min is 0, so nothing can be missing — the
      // empty choice is itself legal ("up to two").
      if (targeting.min === 0) return true;
      const first = eligibleTargets(state, playerIndex, slotOwner(targeting.slots[0]), slotScope(targeting, 0));
      if (targeting.min === 1) return first.length > 0;
      const second = eligibleTargets(state, playerIndex, slotOwner(targeting.slots[1]), slotScope(targeting, 1));
      // Two slots must be two DISTINCT units — mirrors the fan-out's own
      // `first.instanceId === second.instanceId` skip — and must share a
      // battlefield when the spec says so, mirroring its `sameBattlefield` skip.
      return first.some((a) =>
        second.some(
          (b) =>
            a.instanceId !== b.instanceId &&
            (!targeting.sameBattlefield || shareABattlefield(state, a.instanceId, b.instanceId)),
        ),
      );
    }
    case "unitList": {
      // Nothing is REQUIRED when min is 0, so nothing can be missing — Fox-Fire
      // with an empty board is castable and kills nothing, which the rules state
      // outright for "any number" ("If they choose zero, the spell or ability can
      // be played without any targets").
      if (targeting.min === 0) return true;
      // Otherwise: is there ANY legal set of the required size? Asked through the
      // shared predicate rather than by counting candidates, because the group
      // requirements (`sameBattlefield`, `maxTotalMight`) mean "enough units
      // exist" is not the same question as "a legal choice exists".
      return unitListCandidates(state, playerIndex, targeting).length > 0;
    }
    case "unitAndEquipment": {
      // Angle Shot. BOTH halves are required (355), so a board with units but no
      // Equipment on the right side of them offers nothing and the card is
      // uncastable — "the targeting IS the effect" for a Spell.
      //
      // Asked through the same walk the enumerator and the validator use, so all
      // three agree about which pairs exist. Scope is `anywhere`; the owner is
      // unconstrained unless the card names one, for the reason the spec records:
      // "the same controller" relates the two targets to each other, not to the
      // caster, and only a card whose UNIT half says "friendly" needs more.
      const units = eligibleTargets(state, playerIndex, targeting.owner, "anywhere");
      // When the Equipment is a "you may", a bare unit is a complete choice —
      // Relentless Pursuit moves a friendly unit whether or not any Equipment
      // exists to attach, so an Equipment-less board must not make it uncastable.
      if (targeting.optionalEquipment) return units.length > 0;
      return units.some((u) => equipmentPairedWith(state, u.instanceId, targeting.relation).length > 0);
    }
    case "gear":
      // Akshan - Mischievous' "an enemy gear" — asked through the same predicate
      // the enumerator and the validator use, so a board with only friendly gear
      // makes his paid half do nothing rather than being offered and refused.
      return gearTargets(state).some((g) => gearOwnerMatches(targeting.owner, g.ownerIndex, playerIndex));
    case "ownTrashCard": {
      const trash = state.players[playerIndex].trash;
      return trash.some((c) => targeting.cardKind === undefined || c.kind === targeting.cardKind);
    }
    case "chainSpell":
      // Every counter in this pool is a [Reaction], so "is there a spell to
      // counter" is genuinely the whole question — with an empty chain the card
      // is uncastable rather than castable-and-inert, which is what the spec's
      // own "targeting IS the effect" rule for Spells requires.
      return counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower).length > 0;
    case "chainSpellAndUnit":
      // BOTH, and this `&&` IS rule 355.8 for Riposte: with a spell to counter
      // but no friendly unit the card is uncastable, not castable-and-half-inert.
      // Splitting this into two independent questions is the bug it exists to
      // prevent — the enumerator's cross product answers the same way by
      // producing zero variants.
      return (
        counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower).length > 0 &&
        eligibleTargets(state, playerIndex, targeting.owner, targeting.scope).length > 0
      );
    case "unitOrGear":
      return (
        unitOrGearTargets(state, {
          playerIndex,
          ...(targeting.owner !== undefined ? { owner: targeting.owner } : {}),
          ...(targeting.domain !== undefined ? { domain: targeting.domain } : {}),
          ...(targeting.includesFacedown !== undefined ? { includesFacedown: targeting.includesFacedown } : {}),
        }).length > 0
      );
  }
}

/**
 * Everything a `unitOrGear`-kind spec can name: units at BATTLEFIELDS (the card
 * says "a unit at a battlefield", so base is out) plus every gear in play,
 * either player's.
 *
 * Gear is returned with its owner, because a gear lives in a player's
 * `activeGear` rather than on the board and there is otherwise no way back to
 * whose it is.
 */
/** Every GEAR in play, on both sides — the candidate list for a `gear`-kind
 *  spec. Derived from `unitOrGearTargets` rather than walking `activeGear`
 *  again, so "what counts as a gear in play" is answered in exactly one place. */
export function gearTargets(state: GameState): { instanceId: string; name: string; ownerIndex: 0 | 1 }[] {
  return unitOrGearTargets(state).filter((t) => t.isGear);
}

/**
 * The gear an ACTIVATED ability may name — `gearTargets` plus the two narrowings
 * an ability's spec can carry.
 *
 * **One walk for the enumerator and the validator**, which is the whole reason it
 * is here rather than inline in either: this codebase's most-repeated bug is the
 * enumerator offering a choice the validator then refuses, and a filter applied
 * at one of the two is exactly how it happens again.
 *
 * `exhaustedOnly` is what keeps "Ready a gear" off an ability with nothing to
 * ready — `legal-actions`' own rule that "a mode with no legal target is simply
 * not offered, since paying for nothing is never what the player meant".
 */
export function activatableGearTargets(
  state: GameState,
  playerIndex: 0 | 1,
  spec: { owner?: "friendly" | "enemy"; exhaustedOnly?: true },
): { instanceId: string; name: string; ownerIndex: 0 | 1 }[] {
  return gearTargets(state).filter((g) => {
    if (!gearOwnerMatches(spec.owner, g.ownerIndex, playerIndex)) return false;
    if (spec.exhaustedOnly !== true) return true;
    const owner = state.players[g.ownerIndex];
    return owner.activeGear.some((c) => c.instanceId === g.instanceId && c.exhausted);
  });
}

/**
 * Does a gear owned by `ownerIndex` satisfy `owner`, measured from `chooserIndex`?
 *
 * One function for the enumerator, the validator and `hasAnyLegalEffectChoice` —
 * the three that must agree about which gear is offered, and the three this
 * codebase's most-repeated bug is a disagreement between. `undefined` means no
 * constraint, so the two cards that name none are unfiltered.
 */
export function gearOwnerMatches(
  owner: "friendly" | "enemy" | undefined,
  ownerIndex: 0 | 1,
  chooserIndex: 0 | 1,
): boolean {
  if (owner === undefined) return true;
  return owner === "friendly" ? ownerIndex === chooserIndex : ownerIndex !== chooserIndex;
}

export function unitOrGearTargets(
  state: GameState,
  /** Pack of Wonders' three narrowings — all default to off, so Fading Memories
   *  gets exactly the walk it always had. */
  opts: {
    playerIndex?: 0 | 1;
    owner?: "friendly" | "enemy";
    /** Decree of Unity's "an enemy CHAOS unit or gear" — the permanent must have
     *  this domain AMONG its domains, so a Fury+Chaos unit qualifies. Needs
     *  `playerIndex` to be meaningful only through `owner`; the domain half is
     *  measured off the permanent alone. */
    domain?: Domain;
    excludeInstanceId?: string;
    includesFacedown?: true;
    /** WHO is choosing — Ruin Runner's "enemy spells and abilities". Separate
     *  from `playerIndex` above, which exists only to resolve `owner:
     *  "friendly"`: a caller can want an unfiltered walk (Fading Memories asks
     *  for every permanent) and must not silently acquire a chooser. Omitted
     *  means "not a choice", and no restriction applies. */
    chooserIndex?: 0 | 1;
  } = {},
): { instanceId: string; name: string; ownerIndex: 0 | 1; isGear: boolean }[] {
  const out: { instanceId: string; name: string; ownerIndex: 0 | 1; isGear: boolean }[] = [];
  // A permanent's DOMAINS, when the spec names one. Read off the instance rather
  // than re-looked-up from the registry: a token carries `domains: []` and is
  // therefore not a Chaos unit, which is the right answer and one a registry
  // lookup by defId could not give (`TOKEN-…` is not a card).
  const domainOk = (domains: readonly Domain[]): boolean =>
    opts.domain === undefined || domains.includes(opts.domain);
  for (const bf of state.battlefields) {
    for (const [ownerId, units] of Object.entries(bf.units)) {
      const ownerIndex: 0 | 1 = state.players[0]!.id === ownerId ? 0 : 1;
      for (const u of units) {
        if (opts.chooserIndex !== undefined && !unitChooseableBy(state, u, ownerIndex, opts.chooserIndex)) continue;
        if (!domainOk(u.domains)) continue;
        out.push({ instanceId: u.instanceId, name: u.name, ownerIndex, isGear: false });
      }
    }
  }
  for (const index of [0, 1] as const) {
    for (const g of state.players[index].activeGear) {
      if (!domainOk(g.domains)) continue;
      out.push({ instanceId: g.instanceId, name: g.name, ownerIndex: index, isGear: true });
    }
  }
  // A FACEDOWN card is neither a unit nor a gear — it is a card at a battlefield
  // whose identity is hidden — so it is added only when the spec asks. Its NAME is
  // deliberately withheld: `hiddenCards` holds the real card and nothing may leak
  // it, which is the same rule `BattlefieldView` follows by rendering "Facedown".
  if (opts.includesFacedown) {
    for (const bf of state.battlefields) {
      for (const hidden of bf.hiddenCards) {
        out.push({ instanceId: hidden.card.instanceId, name: "Facedown card", ownerIndex: hidden.ownerIndex, isGear: false });
      }
    }
  }
  return out.filter(
    (t) =>
      t.instanceId !== opts.excludeInstanceId &&
      !(opts.owner === "friendly" && opts.playerIndex !== undefined && t.ownerIndex !== opts.playerIndex) &&
      // The mirror of the line above, and it needs `playerIndex` for the same
      // reason: "enemy" is measured from the CHOOSER's seat, and a walk with no
      // chooser has nothing to measure it against.
      !(opts.owner === "enemy" && opts.playerIndex !== undefined && t.ownerIndex === opts.playerIndex),
  );
}

/**
 * Ruin Runner — "I can't be chosen by enemy spells and abilities."
 *
 * **An ABSOLUTE prohibition, and deliberately NOT built on `[Deflect]`.** The
 * two read alike and are different rules: `[Deflect]` is a TAX an opponent may
 * pay, so it is priced per target and answered in Power; this cannot be paid for
 * at any price. Folding it into `deflectSurcharge` as "an infinite surcharge"
 * would have made an unchooseable unit merely expensive, and would have inherited
 * that keyword's open question about floating Power reducing the price.
 *
 * "ENEMY spells and abilities" — so its own controller chooses it freely. That
 * is the same measured-from-the-owner reading `deflectSurcharge` takes, and it
 * matters: buffing your own Ruin Runner is an ordinary play.
 *
 * A named per-card table rather than a parsed restriction, matching every other
 * small precise table in this engine.
 *
 * **A predicate per card, not a bare Set — widened 2026-08-11.** Ruin Runner's
 * prohibition is unconditional and was the only one in the pool; Master Yi -
 * Unstoppable's is gated on `[Level 16]`, which is a fact about the CONTROLLER
 * and cannot be answered by a defId alone.
 */
const UNCHOOSEABLE_BY_ENEMIES: Readonly<Record<string, (state: GameState, unitOwnerIndex: 0 | 1) => boolean>> = {
  // Ruin Runner — "I can't be chosen by enemy spells and abilities." No
  // condition at all, which is why this was a Set until a conditional one landed.
  "SFD-105": () => true,
  // Baron Nashor — "I can't be chosen by enemy spells and abilities." Byte-
  // identical to Ruin Runner above: no condition, so it takes the same `() => true`.
  //
  // One of his three sentences. His +2 Might aura landed in wave 7 as a
  // `mightModifiers` entry; his "add the Baron Pit battlefield token" is refused
  // as SYSTEMIC rather than as a card — nothing in this engine can add a
  // battlefield at all, which a wave-7 agent checked rather than assumed.
  "UNL-147": () => true,
  // Master Yi - Unstoppable — "[Level 16][>] I can't be chosen by enemy spells
  // and abilities." Read LIVE off the owner's XP: 824.1.b.1 makes `[Level N][>]`
  // "while you have N or more XP", and 824.1.d turns it Inactive the moment XP
  // drops below — so spending back under 16 makes him choosable again mid-turn.
  "UNL-059": (state, unitOwnerIndex) => state.players[unitOwnerIndex].xp >= MASTER_YI_UNSTOPPABLE_LEVEL,
};

const MASTER_YI_UNSTOPPABLE_LEVEL = 16;

/**
 * Alpha Wildclaw — "Your units HERE with less Might than me can't be chosen by
 * enemy spells and abilities."
 *
 * **An aura over OTHER units, so it cannot be a row in the table above.** That
 * table is keyed by the defId of the unit being PROTECTED; this is keyed by the
 * defId of the unit doing the protecting, and has to be looked up from the other
 * end — the same split `deploy.unitEntersReady` makes between its per-card switch
 * and Magma Wurm's board query, and for the same reason.
 *
 * "HERE" is the Wildclaw's own battlefield, so a protected unit must be standing
 * with him; a unit in base is unprotected however small it is. "YOUR units" is
 * measured from HIS controller, which is the same seat the protected unit's
 * owner sits in — an enemy unit beside him gets nothing.
 *
 * "LESS MIGHT THAN ME" is strict and read through `effectiveMight` (143.2's
 * current Might), so a buff on either side moves the line live. He does not
 * protect himself: nothing has less Might than itself.
 */
const ALPHA_WILDCLAW = "UNL-057";

function shieldedByWildclaw(state: GameState, unit: UnitInstance, unitOwnerIndex: 0 | 1): boolean {
  for (const bf of state.battlefields) {
    const here = bf.units[state.players[unitOwnerIndex].id] ?? [];
    if (!here.some((u) => u.instanceId === unit.instanceId)) continue;
    const mine = effectiveMight(state, unit, unitOwnerIndex, { isCombat: false, battlefieldId: bf.id });
    return here.some(
      (u) =>
        u.defId === ALPHA_WILDCLAW &&
        // **MEASURED-REDUNDANT, kept deliberately.** Removing this survived
        // mutation on 2026-08-11: the comparison below is a strict `>`, so a
        // Wildclaw checked against himself gives `might > might` and excludes
        // himself anyway. It becomes load-bearing the instant that `>` is
        // relaxed, which is why it stays — labelled, so a green run is not read
        // as proof it does something.
        u.instanceId !== unit.instanceId &&
        effectiveMight(state, u, unitOwnerIndex, { isCombat: false, battlefieldId: bf.id }) > mine,
    );
  }
  return false;
}

/** For coverage.ts — this restriction IS Ruin Runner's whole printed text, so
 *  nothing else claims the card, and it is Alpha Wildclaw's second sentence. */
export function chooseRestrictionDefIds(): string[] {
  return [...Object.keys(UNCHOOSEABLE_BY_ENEMIES), ALPHA_WILDCLAW];
}

/**
 * May `chooserIndex` choose this unit at all?
 *
 * The ONE question both the enumerator and the validator ask. Two spellings of
 * this rule is exactly how a target comes to be offered and then refused, which
 * is this repo's most-repeated bug and the failure this card is most likely to
 * reproduce — it is a pure negative, so a missed site does not look wrong, it
 * just quietly allows the play.
 *
 * Cheap on the hot path: the Set is consulted only when the chooser is not the
 * unit's own controller, which is the minority of reads in a fan-out.
 */
export function unitChooseableBy(
  state: GameState,
  unit: UnitInstance,
  unitOwnerIndex: 0 | 1,
  chooserIndex: 0 | 1,
): boolean {
  if (chooserIndex === unitOwnerIndex) return true; // "ENEMY spells and abilities"
  // `state` was added 2026-08-11 and every one of the four call sites already had
  // it in scope, which is why this stayed a pure function of the unit for so
  // long: nothing needed the board until a CONDITIONAL prohibition arrived.
  if (UNCHOOSEABLE_BY_ENEMIES[canonicalDefId(unit.defId)]?.(state, unitOwnerIndex) === true) return false;
  return !shieldedByWildclaw(state, unit, unitOwnerIndex);
}

/**
 * The name of the first unit in `chosenInstanceIds` that `chooserIndex` may not
 * choose, or undefined.
 *
 * Takes the SAME id list `deflectSurchargeForTargets` is handed —
 * `chosenUnitsOfPlay` / `chosenUnitsOfActivation` — and that is the whole design
 * rather than a convenience. Those helpers exist because listing the fields that
 * can name a unit BY HAND got it wrong: a spell choosing through a list, or
 * through a unit-or-gear slot, paid no `[Deflect]` at all until they were
 * written. A chooseability check assembled field-by-field here would reproduce
 * that bug exactly, and silently, since the failure is a play going through
 * rather than one being refused.
 *
 * Ids naming nothing on the board are skipped rather than refused, matching
 * `deflectSurchargeForTargets`: a target can die between enumeration and
 * validation, and this must not be the thing that explodes.
 */
export function unchooseableAmong(
  state: GameState,
  chooserIndex: 0 | 1,
  chosenInstanceIds: readonly (string | undefined)[],
): string | undefined {
  for (const instanceId of chosenInstanceIds) {
    if (instanceId === undefined) continue;
    const found = findUnitAnywhere(state, instanceId);
    // A gear named by a unit-or-gear slot finds no unit and is skipped — gear
    // carries no such restriction in this pool.
    if (found === undefined) continue;
    if (!unitChooseableBy(state, found.unit, found.ownerIndex, chooserIndex)) return found.unit.name;
  }
  return undefined;
}

export function findUnitOnBattlefield(state: GameState, instanceId: string): BattlefieldUnitLocation | undefined {
  for (let battlefieldIndex = 0; battlefieldIndex < state.battlefields.length; battlefieldIndex++) {
    const bf = state.battlefields[battlefieldIndex]!;
    for (const [ownerId, units] of Object.entries(bf.units)) {
      const unit = units.find((u) => u.instanceId === instanceId);
      if (unit) {
        const ownerIndex = state.players[0]!.id === ownerId ? 0 : 1;
        return { unit, ownerId, ownerIndex, battlefieldIndex };
      }
    }
  }
  return undefined;
}
