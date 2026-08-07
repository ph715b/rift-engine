import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { legendMightBonus } from "./legend-abilities.js";
import { effectiveKeywords } from "./granted-keywords.js";
import { battlefieldMightBonusAt } from "./battlefield-continuous.js";
import { equipmentMightBonusFor } from "./equipment.js";
import { isMechDef } from "./constants.js";
import { sivirConditionMet } from "./granted-keywords.js";
import { isMechUnit } from "./equipment.js";

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
 *  comparing it to the unit being evaluated.
 *
 *  **Returning the FIRST match is a known under-report with two copies in play**
 *  at different battlefields: a second Garen - Commander standing elsewhere is
 *  invisible to the unit beside him. Unreachable for the champion-tier cards here
 *  (one copy at a time in practice) and left alone rather than changed on
 *  speculation — `granted-keywords.ownUnitAtLocation` asks the question the other
 *  way round, "is a source HERE", for the auras where it is reachable. */
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
/** Darius - Executioner: "Other friendly units have +1 Might here." Positional
 *  and unconditional — the same shape as Garen - Commander's, and deliberately
 *  NOT gated on [Legion]: the keyword sits before his FIRST sentence (the
 *  ready-me), and this is his second. */
const DARIUS_EXECUTIONER = "OGN-243";
/** Ornn - Forge God: "I have +1 Might for each friendly gear." Self-scaling off
 *  a zone like Dr. Mundo's, and counting GEAR rather than Equipment. */
const ORNN_FORGE_GOD = "SFD-085";
/** Trusty Ramhound: "While you have another unit here, I have +1 Might."
 *  Positional and self-referential — the condition is about its OWN square. */
const TRUSTY_RAMHOUND = "SFD-159";
/**
 * Rumble - Scrapper: "Your Mechs have +1 Might (**including me**)."
 *
 * The first TRIBAL Might aura, and the first that includes its own source. Both
 * of those are the card's words rather than a convenience: every other unit aura
 * in this file prints "OTHER friendly units" and excludes itself as a class,
 * and this one prints the opposite in parentheses.
 *
 * He is himself tagged `Mech`, so "including me" needs no special case at all —
 * it is simply the absence of the exclusion the others have. Sett - Kingpin is
 * the precedent for reading a missing "other" as inclusive.
 *
 * Unpositioned: his text names no battlefield, so a Scrapper in base still
 * pumps a Mech at the far end of the board — the same reading Dr. Mundo -
 * Expert's and Ornn - Forge God's zone-scaling auras take.
 */
const RUMBLE_SCRAPPER = "SFD-089";
/** Sivir - Mercenary's Might half — see her entry in `continuousAuraBonus`. */
const SIVIR_MERCENARY = "SFD-143";
const SIVIR_MIGHT_BONUS = 2;
/** Dr. Mundo - Expert: "My Might is increased by the number of cards in your
 *  trash." Self-scaling off a zone, like Master Yi - Meditative's rune count —
 *  and like his, recomputed on read rather than written into state, so it falls
 *  as his own second clause recycles the trash away. */
const DR_MUNDO_EXPERT = "OGN-109";
/**
 * Leona - Zealot: "Stunned enemy units here have -8 Might, to a minimum of 1
 * Might."
 *
 * Two firsts, and both are why she cannot go in `continuousAuraBonus` with the
 * others:
 *  - **Enemy-side.** Every aura above is a player's own legend or unit helping
 *    their own units, found via `ownUnitLocation(state, ownerIndex, …)`. Leona
 *    hurts the OPPONENT's units, so she is looked up under the other index.
 *  - **Floored.** "To a minimum of 1" is a clamp, not a delta, and a function
 *    that sums bonuses cannot express one. Applied after the sum in
 *    `effectiveMight`.
 *
 * Her enter-ready clause is unrelated and lives in deploy.ts.
 */
const LEONA_ZEALOT = "OGN-079";
const ZEALOT_PENALTY = 8;
const ZEALOT_FLOOR = 1;
/**
 * Sett - Kingpin: "I get +1 Might for each buffed friendly unit at my
 * battlefield."
 *
 * Self-scaling off the BOARD rather than off a zone — Dr. Mundo counts a trash,
 * this counts neighbours — so it moves as units are buffed, arrive, leave or
 * spend their buffs, which is exactly why it is recomputed on read.
 *
 * **He counts himself when buffed, and that is the printed text, not an
 * oversight.** Every other positional aura in this file that excludes its own
 * source says so out loud — Garen - Commander and Darius - Executioner print
 * "OTHER friendly units", Lee Sin - Centered prints "other" too. Sett - Kingpin
 * does not, and in a deck built to buff (his own list runs Cithria, Showstopper
 * and Call to Glory) the difference is a real point of Might, not a technicality.
 *
 * "At my battlefield" is positional, so he gets nothing while he stands in base —
 * the same reading, for the same reason, as Lee Sin's aura below.
 */
const SETT_KINGPIN = "OGN-240";
/**
 * Draven - Showboat: "My Might is increased by your points."
 *
 * Self-scaling off a PLAYER COUNTER rather than off a zone or the board — Dr.
 * Mundo counts a trash and Sett - Kingpin counts neighbours, this counts the
 * score — so it moves the instant a point is scored and is recomputed on read
 * like the rest of this file.
 *
 * "YOUR points" is the OWNER's, read through `ownerIndex` exactly as Dr. Mundo's
 * "your trash" is, and not whoever is asking about his Might.
 *
 * No recursion risk: nothing in the scoring path reads Might, so this cannot
 * re-enter `effectiveMight` the way a Might-conditional aura would. He is also
 * NOT positional — the text names no battlefield, so he carries it in base too,
 * unlike Sett - Kingpin and Lee Sin.
 */
const DRAVEN_SHOWBOAT = "OGN-028";

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
  return [
    GAREN_COMMANDER,
    MASTER_YI_MEDITATIVE,
    WIELDER_OF_WATER,
    WIZENED_ELDER,
    LEE_SIN_CENTERED,
    LEONA_ZEALOT,
    DARIUS_EXECUTIONER,
    DR_MUNDO_EXPERT,
    SETT_KINGPIN,
    DRAVEN_SHOWBOAT,
    TRUSTY_RAMHOUND,
    ORNN_FORGE_GOD,
    // Claims only his MIGHT aura. His second sentence ("when I hold, play a
    // Mech token") is an event trigger and lives in effects/mind.ts — coverage
    // is per defId, so either half alone would report him finished. Both landed
    // in the same change, which is what keeps him off PARTIALLY_IMPLEMENTED.
    RUMBLE_SCRAPPER,
  ];
}

/**
 * Is an enemy Leona - Zealot standing at the same battlefield as this stunned
 * unit? — the condition on her "Stunned enemy units **here** have -8 Might".
 *
 * All three clauses are printed and none is redundant. **Stunned**: she does
 * nothing to a ready unit. **Enemy**: measured from HER controller's side, so
 * she never weakens her own stunned units. **Here**: positional, so she reaches
 * nothing while she sits in base — `ownLocation` of "base" can never match, the
 * same reasoning Lee Sin - Centered's aura uses one step above.
 */
function zealotPenaltyApplies(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ownLocation: string): boolean {
  if (!unit.stunned || ownLocation === "base") return false;
  const enemyIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
  return ownUnitLocation(state, enemyIndex, LEONA_ZEALOT) === ownLocation;
}

/**
 * Continuous, always-on Might modifiers — deliberately NOT a general aura
 * system, just the handful of confirmed cards that need one, hardcoded by defId
 * (matches this codebase's existing POWER_DOMAIN_ALT_OVERRIDES/
 * HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS precedent for "a small, precise, non-
 * speculative table" over a generic engine). Unlike `.mightThisTurn` (a "this
 * turn" value turn-manager.ts's runEnd resets unconditionally), these are
 * recomputed fresh every time effectiveMight runs — nothing ever writes
 * them into state, so there's nothing to reset.
 */
function continuousAuraBonus(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: MightContext): number {
  let bonus = 0;
  const ownLocation = ctx.battlefieldId ?? "base";

  // Garen - Commander and Darius - Executioner print the same sentence ("other
  // friendly units have +1 Might here"), so they share one loop rather than two
  // near-identical branches. Both stack if both are present, which is what
  // "other friendly units" means when there are two of them.
  for (const auraDefId of [GAREN_COMMANDER, DARIUS_EXECUTIONER]) {
    const auraLocation = ownUnitLocation(state, ownerIndex, auraDefId);
    if (auraLocation === undefined || auraLocation !== ownLocation) continue;
    if (unit.defId === auraDefId) continue; // "OTHER friendly units"
    bonus += 1;
  }

  if (unit.defId === MASTER_YI_MEDITATIVE && state.players[ownerIndex].channeled.length >= 8) {
    bonus += 4;
  }

  // "By the NUMBER of cards in your trash" — a scaling bonus rather than a
  // threshold, and read from the OWNER's trash ("your"), not from whoever is
  // asking about his Might.
  if (unit.defId === DR_MUNDO_EXPERT) {
    bonus += state.players[ownerIndex].trash.length;
  }

  // Draven - Showboat rides his controller's score. Sits beside Dr. Mundo
  // deliberately: same shape (a counter on the owner, not a board condition),
  // and no location test, because his text names no battlefield.
  if (unit.defId === DRAVEN_SHOWBOAT) {
    bonus += state.players[ownerIndex].points;
  }

  // Sett - Kingpin counts the buffed friendly units standing with him. Read off
  // the battlefield he is actually on, so it is 0 in base; and INCLUDING himself
  // when he is buffed, since his text omits the "other" every other aura here
  // prints (see his constant above).
  if (unit.defId === SETT_KINGPIN && ownLocation !== "base") {
    const ownerId = state.players[ownerIndex].id;
    const here = state.battlefields.find((b) => b.id === ownLocation)?.units[ownerId] ?? [];
    bonus += here.filter((u) => u.buffed).length;
  }

  // Ornn - Forge God — "I have +1 Might for each friendly gear."
  //
  // Self-scaling off a ZONE, like Dr. Mundo - Expert's trash count, and read the
  // same way: from the OWNER's side ("friendly" is his controller's), with no
  // location test at all, because his text names no battlefield.
  //
  // EVERY gear, not only Equipment and not only what he is wearing: "friendly
  // gear" is the widest phrase the set uses, and a Gold token sitting in the
  // gear row is one. `activeGear` is exactly that list.
  if (unit.defId === ORNN_FORGE_GOD) {
    bonus += state.players[ownerIndex].activeGear.length;
  }

  // Trusty Ramhound — "While you have ANOTHER unit here, I have +1 Might."
  //
  // Self-scaling off a board condition like Sett - Kingpin's, and read the same
  // way: off the battlefield it is actually standing on, so a Ramhound in BASE
  // gets nothing however many units are at home with it. "Here" means a
  // battlefield throughout this file, and a base is not one.
  //
  // "ANOTHER" is by INSTANCE, not by card: two Ramhounds standing together each
  // see the other and both get +1, which is what the word means. Excluding by
  // defId — the shortcut the two auras above take, because those cards say
  // "other FRIENDLY UNITS" and exclude themselves as a class — would make a pair
  // of Ramhounds the one board where the card does nothing.
  //
  // **The `!== "base"` test is belt-and-braces, and is kept deliberately.**
  // Proved inert by mutation: removing it changes nothing, because no battlefield
  // is ever named `"base"` and the lookup below therefore finds nothing to count.
  // It stays for the same reason Sett - Kingpin's identical test one branch up
  // does — it states the card's reading ("here" is a battlefield) at the place
  // that reading is applied, rather than leaving it resting on the id namespace.
  if (unit.defId === TRUSTY_RAMHOUND && ownLocation !== "base") {
    const ownerId = state.players[ownerIndex].id;
    const here = state.battlefields.find((b) => b.id === ownLocation)?.units[ownerId] ?? [];
    if (here.some((u) => u.instanceId !== unit.instanceId)) bonus += 1;
  }

  // Sivir - Mercenary — "If you've spent at least [rainbow][rainbow] this turn,
  // I have +2 Might and [Ganking]."
  //
  // ONE sentence, two halves, and they are asked through the SAME predicate
  // (`sivirConditionMet`) so they cannot come apart — the keyword half is a
  // `CONDITIONAL_GRANTS` entry in granted-keywords.ts. Her coverage claim lives
  // there; this is the Might half only.
  //
  // No recursion risk: the condition reads a spent-Power tally, not Might.
  if (unit.defId === SIVIR_MERCENARY && sivirConditionMet(state, ownerIndex)) {
    bonus += SIVIR_MIGHT_BONUS;
  }

  // Rumble - Scrapper — "Your Mechs have +1 Might (including me)."
  //
  // The receiving unit's tag is the whole filter, and it is read off the
  // INSTANCE: `UnitInstance` carries `tags`, and the Mech TOKEN carries it too,
  // so a token he makes is pumped by him exactly as a printed Mech is.
  //
  // No self-exclusion, and no location test — see his constant above for why
  // each of those is the card's text rather than an omission. `ownUnitLocation`
  // is therefore not consulted at all: only "is a Scrapper in play on this
  // side", which is what `!== undefined` asks.
  //
  // Two Scrappers stack, the same way two Garen - Commanders do — but only one
  // is seen, because `ownUnitLocation` reports the FIRST copy and this asks a
  // yes/no question of it. That under-report is the one already documented on
  // that helper, and it is unreachable in practice for a Champion.
  if (isMechUnit(state, unit) && ownUnitLocation(state, ownerIndex, RUMBLE_SCRAPPER) !== undefined) {
    bonus += 1;
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

  // The BATTLEFIELD itself can grant one — Trifarian War Camp's "units here have
  // +1 Might. (This includes attackers.)". It is not filtered by owner because
  // the card is not: "units here" is both sides, unlike every unit aura above.
  // The parenthetical is free here — the bonus is unconditional, so it lands in
  // the outgoing-damage context as well as the remaining one.
  bonus += battlefieldMightBonusAt(state, ctx.battlefieldId);

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
  // Each buff is worth 1 (710), plus whatever Stand United has made a buff worth
  // this turn. `extraBuffs` is the count BEYOND the first — Lee Sin - Ascetic is
  // the only card that can raise it, and every other unit leaves it undefined.
  const buffCount = unit.buffed ? 1 + (unit.extraBuffs ?? 0) : 0;
  const buffValue = buffCount * (1 + state.players[ownerIndex].extraMightPerBuffThisTurn);
  // The "+N Might" badge of every Equipment attached to this unit (SFD).
  //
  // Read at the GATE rather than stored as a buff, which is what makes it
  // continuous: detaching the Equipment removes the Might in the same instant,
  // and a gear that changes hands takes its badge with it. A stored bonus would
  // need every detach path to remember to undo it.
  //
  // The badge is ART-ONLY data — it is in no field of the card JSON — so it
  // comes from a hand-transcribed table. See card-loader's EQUIP_MIGHT_BONUS.
  let m = unit.might + unit.mightThisTurn + buffValue + equipmentMightBonusFor(state, unit.instanceId);
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

  // Leona - Zealot's -8, applied AFTER the sum and clamped rather than added,
  // because "to a minimum of 1 Might" is a floor and a floor is not a delta.
  // Ordering it last is what makes the floor mean what it says: a buff or aura
  // arriving alongside her lifts the unit before the clamp, so she can never
  // take a unit below 1 and a +2 aura can never be "spent" on the way down.
  if (zealotPenaltyApplies(state, unit, ownerIndex, ctx.battlefieldId ?? "base")) {
    m = Math.max(ZEALOT_FLOOR, m - ZEALOT_PENALTY);
  }
  return Math.max(0, m);
}
