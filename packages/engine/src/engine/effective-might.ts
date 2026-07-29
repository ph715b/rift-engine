import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";

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

/**
 * Continuous, always-on Might modifiers — deliberately NOT a general aura
 * system, just the 3 confirmed cards that need one, hardcoded by defId
 * (matches this codebase's existing POWER_DOMAIN_ALT_OVERRIDES/
 * HIDDEN_KEYWORD_FALSE_POSITIVES precedent for "a small, precise, non-
 * speculative table" over a generic engine). Unlike `.bonus` (a "this
 * turn" value turn-manager.ts's runEnd resets unconditionally), these are
 * recomputed fresh every time effectiveMight runs — nothing ever writes
 * them into state, so there's nothing to reset.
 */
function continuousAuraBonus(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: MightContext): number {
  let bonus = 0;
  const ownLocation = ctx.battlefieldId ?? "base";

  // Garen - Commander (OGS-013): "Other friendly units have +1 Might here."
  const garenCommanderLocation = ownUnitLocation(state, ownerIndex, "OGS-013");
  if (garenCommanderLocation !== undefined && garenCommanderLocation === ownLocation) {
    const isGarenCommanderItself = unit.defId === "OGS-013";
    if (!isGarenCommanderItself) bonus += 1;
  }

  // Master Yi - Meditative (OGS-004): "While you have 8+ runes, I have +4 Might."
  if (unit.defId === "OGS-004" && state.players[ownerIndex].channeled.length >= 8) {
    bonus += 4;
  }

  // Wielder of Water (OGN-055): "While I'm attacking or defending alone, I have +2 Might."
  if (unit.defId === "OGN-055" && ctx.isCombat && ctx.battlefieldId !== undefined) {
    const bf = state.battlefields.find((b) => b.id === ctx.battlefieldId);
    const ownerId = state.players[ownerIndex].id;
    const aloneHere = (bf?.units[ownerId]?.length ?? 0) === 1;
    if (aloneHere) bonus += 2;
  }

  return bonus;
}

/**
 * The single choke point for a unit's effective Might — consolidates what
 * used to be 4+ independently-inlined `unit.might + unit.bonus (+keyword)`
 * computations (combat.ts's outgoingMight/remainingMight, effect-helpers.ts's
 * dealDamage lethal check, heuristic-ai.ts's board-Might sums), each of
 * which had subtly different extra terms. Combat-only terms ([Assault]/
 * [Shield]) only apply when `ctx.isCombat`; continuous auras always apply.
 */
export function effectiveMight(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: MightContext): number {
  let m = unit.might + unit.bonus;
  if (ctx.isCombat) {
    if (ctx.combatRole === "outgoing") {
      m += ctx.isAttackingSide ? (unit.keywords.Assault ?? 0) : 0;
    } else if (ctx.combatRole === "remaining") {
      m += ctx.isAttackingSide ? (unit.keywords.Assault ?? 0) : (unit.keywords.Shield ?? 0);
    }
  }
  m += continuousAuraBonus(state, unit, ownerIndex, ctx);
  return Math.max(0, m);
}
