import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { legendMightBonus } from "./legend-abilities.js";
import { effectiveKeywords } from "./granted-keywords.js";

export interface MightContext {
  isCombat: boolean;
  /** Only meaningful when isCombat is true. */
  isAttackingSide?: boolean;
  /** Only meaningful when isCombat is true — these two are genuinely
   *  asymmetric, not "the same keyword bonus from two angles":
   *  - "outgoing" (damage this unit DEALS): only [Assault] ever applies,
   *    and only while attacking — [Shield] is purely defensive and NEVER
   *    contributes to outgoing damage, regardless of side.
   *  - "remaining" (damage this unit can still ABSORB): [Assault] while
   *    attacking, [Shield] while defending — both sides get a keyword
   *    bonus here, just different ones. */
  combatRole?: "outgoing" | "remaining";
  /** The battlefield `unit` currently sits at, if any — omitted when the
   *  unit being evaluated is in base. Needed for positional auras
   *  (Garen - Commander) and "alone here" checks (Wielder of Water). */
  battlefieldId?: string;
}

/** Finds where `ownerIndex`'s own copy of `defId` currently sits (there's
 *  at most one of any given champion/legend-tier unit in play at a time in
 *  practice, but this returns the first match either way) — "base" or a
 *  battlefield id, or undefined if it isn't in play at all. Used by
 *  Garen - Commander's positional aura to find ITS OWN location before
 *  comparing it to the unit being evaluated. */
function ownUnitLocation(state: GameState, ownerIndex: 0 | 1, defId: string): string | "base" | undefined {
  const owner = state.players[ownerIndex];
  if (owner.baseUnits.some((u) => u.defId === defId)) return "base";
  for (const bf of state.battlefields) {
    if ((bf.units[owner.id] ?? []).some((u) => u.defId === defId)) return bf.id;
  }
  return undefined;
}

/** Garen - Commander: "Other friendly units have +1 Might here." */
const GAREN_COMMANDER = "OGS-013";
/** Master Yi - Meditative: "While you have 8+ runes, I have +4 Might." */
const MASTER_YI_MEDITATIVE = "OGS-004";
/** Wielder of Water: "While I'm attacking or defending alone, I have +2 Might." */
const WIELDER_OF_WATER = "OGN-055";
/** Wizened Elder: "While I'm buffed, I have an additional +1 Might." */
const WIZENED_ELDER = "OGN-065";
/** Lee Sin - Centered: "Other buffed friendly units at my battlefield have +2
 *  Might." Positional like Garen - Commander, but conditional on the BUFF too. */
const LEE_SIN_CENTERED = "OGN-151";

/**
 * The cards whose printed text this module implements. Exported for
 * coverage.ts, which would otherwise report them all as unimplemented: they
 * live here as continuous modifiers rather than in an effect registry, and a
 * card reported inert while it works is exactly the wrong direction for a
 * measurement whose whole point is trust.
 *
 * Built from the same constants the logic below branches on, so the two cannot
 * disagree — a parallel list of ids would drift the first time one changed.
 */
export function effectiveMightDefIds(): string[] {
  return [GAREN_COMMANDER, MASTER_YI_MEDITATIVE, WIELDER_OF_WATER, WIZENED_ELDER, LEE_SIN_CENTERED];
}

/**
 * Continuous, always-on Might modifiers — deliberately NOT a general aura
 * system, just the handful of confirmed cards that need one, hardcoded by defId
 * (matches this codebase's existing POWER_DOMAIN_ALT_OVERRIDES/
 * HIDDEN_KEYWORD_FALSE_POSITIVES precedent for "a small, precise, non-
 * speculative table" over a generic engine). Unlike `.mightThisTurn` (a "this
 * turn" value turn-manager.ts's runEnd resets unconditionally), these are
 * recomputed fresh every time effectiveMight runs — nothing ever writes
 * them into state, so there's nothing to reset.
 */
function continuousAuraBonus(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: MightContext): number {
  let bonus = 0;
  const ownLocation = ctx.battlefieldId ?? "base";

  const garenCommanderLocation = ownUnitLocation(state, ownerIndex, GAREN_COMMANDER);
  if (garenCommanderLocation !== undefined && garenCommanderLocation === ownLocation) {
    const isGarenCommanderItself = unit.defId === GAREN_COMMANDER;
    if (!isGarenCommanderItself) bonus += 1;
  }

  if (unit.defId === MASTER_YI_MEDITATIVE && state.players[ownerIndex].channeled.length >= 8) {
    bonus += 4;
  }

  // "An ADDITIONAL +1" on top of the +1 the Buff itself is worth (rule 710),
  // so a buffed Wizened Elder is +2 over its printed Might, not +1. Lives here
  // rather than in the buff helper because it's a continuous property of one
  // card, recomputed on read — nothing to write into state or reset.
  if (unit.defId === WIZENED_ELDER && unit.buffed) {
    bonus += 1;
  }

  // Lee Sin - Centered: three conditions, and all three are printed. "OTHER"
  // excludes himself even though he can be buffed; "buffed" makes it worth
  // nothing to an unbuffed neighbour; "at my battlefield" makes it positional,
  // so it reaches nothing while he sits in base.
  const leeSinLocation = ownUnitLocation(state, ownerIndex, LEE_SIN_CENTERED);
  if (
    leeSinLocation !== undefined &&
    leeSinLocation !== "base" &&
    leeSinLocation === ownLocation &&
    unit.defId !== LEE_SIN_CENTERED &&
    unit.buffed
  ) {
    bonus += 2;
  }

  if (unit.defId === WIELDER_OF_WATER && ctx.isCombat && ctx.battlefieldId !== undefined) {
    const bf = state.battlefields.find((b) => b.id === ctx.battlefieldId);
    const ownerId = state.players[ownerIndex].id;
    const aloneHere = (bf?.units[ownerId]?.length ?? 0) === 1;
    if (aloneHere) bonus += 2;
  }

  // The owner's LEGEND can grant a continuous bonus too (Master Yi - Wuju
  // Bladesman's defend-alone +2). Kept in its own registry rather than
  // another branch here because a Legend is one card per deck that's always
  // in play — nothing about it is conditional on finding it on the board
  // first, which is what every check above spends its work on.
  bonus += legendMightBonus(state, unit, ownerIndex, ctx);

  return bonus;
}

/**
 * The single choke point for a unit's effective Might — consolidates what
 * used to be 4+ independently-inlined `unit.might + unit.mightThisTurn (+keyword)`
 * computations (combat.ts's outgoingMight/remainingMight, effect-helpers.ts's
 * dealDamage lethal check, heuristic-ai.ts's board-Might sums), each of
 * which had subtly different extra terms. Combat-only terms ([Assault]/
 * [Shield]) only apply when `ctx.isCombat`; continuous auras always apply.
 */
export function effectiveMight(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: MightContext): number {
  // A Buff is worth +1 Might (rule 710) and is a separate game object from
  // mightThisTurn: it survives end of turn, caps at one per unit, and can be
  // spent. Both land here so no caller has to remember either.
  //
  // Its VALUE can be raised for a turn (Stand United), which is why this reads
  // a per-player modifier rather than the literal 1 — and why the modifier
  // belongs to the unit's OWNER, not to whoever is asking.
  const buffValue = unit.buffed ? 1 + state.players[ownerIndex].extraMightPerBuffThisTurn : 0;
  let m = unit.might + unit.mightThisTurn + buffValue;
  if (ctx.isCombat) {
    // Granted keywords count: Raging Soul's [Assault] arrives from its own text
    // rather than from the card frame, and combat must not be able to tell the
    // difference.
    const keywords = effectiveKeywords(state, unit, ownerIndex);
    if (ctx.combatRole === "outgoing") {
      m += ctx.isAttackingSide ? (keywords.Assault ?? 0) : 0;
    } else if (ctx.combatRole === "remaining") {
      m += ctx.isAttackingSide ? (keywords.Assault ?? 0) : (keywords.Shield ?? 0);
    }
  }
  m += continuousAuraBonus(state, unit, ownerIndex, ctx);
  return Math.max(0, m);
}
