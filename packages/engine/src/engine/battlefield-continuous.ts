import type { GameState } from "../model/game-state.js";
import type { Keyword } from "../model/keyword.js";

/**
 * The battlefields whose ability is CONTINUOUS rather than triggered — six of
 * the 24.
 *
 * Its own module, and deliberately not part of `battlefield-abilities.ts`, for
 * two reasons. The first is a rule about this codebase: a continuous ability is
 * read at a GATE rather than resolved as an effect, which is the same split
 * `board-restrictions.ts` already exists for — a card whose whole text is "units
 * here have X" has no resolver to live in. The second is mechanical: these are
 * read from `effective-might.ts`, `granted-keywords.ts`, `constants.ts` and the
 * move/hide validators, and `battlefield-abilities.ts` imports `effect-helpers`,
 * which imports `effective-might`. Keeping the table in a module that imports
 * nothing but TYPES means no read site can create a cycle.
 *
 * **The shared hazard is the one `board-restrictions.ts` names**: several of
 * these are asked by BOTH an enumerator and a validator, and them disagreeing is
 * how this codebase produces an action that is offered and then refused. Each
 * query below is therefore the one function both sides call.
 */

/** Trifarian War Camp — "Units here have +1 Might. (This includes attackers.)" */
const TRIFARIAN_WAR_CAMP = "OGN-294";
/** Vilemaw's Lair — "Units can't move from here to base." */
const VILEMAWS_LAIR = "OGN-295";
/** Windswept Hillock — "Units here have [Ganking]. (They can move from
 *  battlefield to battlefield.)" */
const WINDSWEPT_HILLOCK = "OGN-297";
/** Void Gate — "Spells and abilities deal 1 Bonus Damage to units here. (Each
 *  instance of damage the spell deals to a unit here is increased by 1.)" */
const VOID_GATE = "OGN-296";
/** Aspirant's Climb — "Increase the points needed to win the game by 1." */
const ASPIRANTS_CLIMB = "OGN-276";
/** Bandle Tree — "You may hide an additional card here." */
const BANDLE_TREE = "OGN-278";

interface ContinuousBattlefield {
  /** "+N Might" to every unit standing here, on BOTH sides — the cards say
   *  "units here", not "friendly units here". */
  mightBonusHere?: number;
  /** Keywords every unit standing here has, on both sides, for the same reason. */
  keywordsHere?: readonly Keyword[];
  /** "Units can't move from here to base." */
  blocksMoveToBase?: boolean;
  /** "Spells and abilities deal N Bonus Damage to units here." */
  bonusDamageHere?: number;
  /** "Increase the points needed to win the game by N." Not positional — it is
   *  the only ability here that is about the GAME rather than about this
   *  battlefield, and it applies to both players. */
  extraPointsToWin?: number;
  /** "You may hide an ADDITIONAL card here" — a raise on 811's one-per-
   *  battlefield limit, not a replacement for it. */
  extraHiddenCards?: number;
  /** "Players can't score here until their Nth turn" (Forgotten Monument). A
   *  scoring rule rather than a board effect, and the only entry here that
   *  reaches into `scoring.ts` — see `mayScoreAt` below. */
  noScoringBeforeTurn?: number;
}

/** Forgotten Monument (SFD-209) — "players can't score here until their third
 *  turn". */
const FORGOTTEN_MONUMENT = "SFD-209";

const BATTLEFIELD_CONTINUOUS: Record<string, ContinuousBattlefield> = {
  [TRIFARIAN_WAR_CAMP]: { mightBonusHere: 1 },
  [VILEMAWS_LAIR]: { blocksMoveToBase: true },
  [WINDSWEPT_HILLOCK]: { keywordsHere: ["Ganking"] },
  [VOID_GATE]: { bonusDamageHere: 1 },
  [ASPIRANTS_CLIMB]: { extraPointsToWin: 1 },
  [BANDLE_TREE]: { extraHiddenCards: 1 },
  // "Players can't score here until their third turn." BOTH players, unlike
  // every other restriction in this repo, which is why it is read off the
  // battlefield rather than asked of an opponent's board.
  [FORGOTTEN_MONUMENT]: { noScoringBeforeTurn: 3 },
};


/**
 * May `playerIndex` score `battlefieldId` at all right now?
 *
 * **Distinct from `mayGainPoints`, and the difference is the whole ruling.**
 * Tianna Crownguard blocks GAINING A POINT while the scoring still happens, so
 * 471.1.b's once-per-battlefield-per-turn lockout fires and the opponent cannot
 * retry. Forgotten Monument blocks SCORING ITSELF — the event does not happen —
 * so nothing is recorded and the battlefield is still there to be scored on the
 * third turn. A card that says "can't score" and a card that says "can't gain
 * points" are two different sentences, and this engine now models both.
 *
 * "THEIR third turn" is read against `GameState.turnNumber`, which advances when
 * play wraps back to the First Player — so both players reach their third turn
 * at the same count. Recorded in docs/rules-conformance.md, because a per-player
 * turn counter would be the stricter reading and no field carries one.
 */
export function mayScoreAt(state: GameState, battlefieldId: string): boolean {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const before = bf?.defId ? BATTLEFIELD_CONTINUOUS[bf.defId]?.noScoringBeforeTurn : undefined;
  return before === undefined || state.turnNumber >= before;
}

/** For coverage.ts, and for the completeness gate that asks whether all 24
 *  printed battlefields do something. */
export function continuousBattlefieldDefIds(): string[] {
  return Object.keys(BATTLEFIELD_CONTINUOUS);
}

/** The continuous ability of the battlefield with this id, if it has one.
 *  `battlefieldId` is optional and `undefined` means BASE, which no battlefield
 *  ability reaches — that is what lets every call site pass its location field
 *  straight through. */
function at(state: GameState, battlefieldId: string | undefined): ContinuousBattlefield | undefined {
  if (battlefieldId === undefined || battlefieldId === "base") return undefined;
  const defId = state.battlefields.find((bf) => bf.id === battlefieldId)?.defId;
  return defId === undefined ? undefined : BATTLEFIELD_CONTINUOUS[defId];
}

/**
 * Trifarian War Camp's "+1 Might" — added in `effective-might.continuousAuraBonus`
 * beside the unit auras.
 *
 * "(This includes attackers.)" is the card telling you it is not combat-scoped,
 * which is free here: the bonus is unconditional, so it lands in every
 * `MightContext` including the outgoing-damage one.
 */
export function battlefieldMightBonusAt(state: GameState, battlefieldId: string | undefined): number {
  return at(state, battlefieldId)?.mightBonusHere ?? 0;
}

/** Windswept Hillock's `[Ganking]` — folded into `effectiveKeywords`, so every
 *  place that asks "does this unit have Ganking" gets it without knowing where
 *  it came from. */
export function battlefieldKeywordsAt(state: GameState, battlefieldId: string | undefined): readonly Keyword[] {
  return at(state, battlefieldId)?.keywordsHere ?? [];
}

/**
 * Vilemaw's Lair — may a unit standing at `battlefieldId` move to base?
 *
 * Asked by `legal-actions`' Recall enumeration and by `validate-recall-unit`, so
 * the two cannot disagree, and again inside `effect-helpers.recallUnitToBase` so
 * a card that says "move a unit to base" (Flash, Maddened Marauder) is stopped
 * too — those say MOVE, which is what the Lair forbids.
 *
 * **Combat's own step-3d recall is deliberately NOT blocked.**
 * `relocateToBaseUnchanged` is a step of the Combat Cleanup (466), not a move a
 * player makes, and blocking it would strand the losing side's survivors at a
 * battlefield the rules have just sent them home from.
 */
export function mayMoveToBaseFrom(state: GameState, battlefieldId: string | undefined): boolean {
  return at(state, battlefieldId)?.blocksMoveToBase !== true;
}

/**
 * Void Gate — extra damage a spell or ability deals to a unit standing here.
 *
 * "EACH INSTANCE of damage the spell deals to a unit here is increased by 1", so
 * it is per instance of damage rather than per spell, which is exactly what
 * `dealDamage` is: one call per instance. Stacks with Annie - Fiery's aura and
 * Ravenborn Tome's charge for the reason those two already stack with each
 * other — two effects each saying "1 Bonus Damage" are two separate +1s.
 *
 * COMBAT damage is untouched, and that is structural rather than a choice:
 * combat.ts does its own Might arithmetic and never comes through `dealDamage`.
 * The card says "spells and abilities", so the two agree.
 */
export function battlefieldBonusDamageAt(state: GameState, battlefieldId: string | undefined): number {
  return at(state, battlefieldId)?.bonusDamageHere ?? 0;
}

/**
 * Bandle Tree — how many facedown cards may sit at `battlefieldId` at once.
 *
 * 811's own limit is one ("a battlefield you control that doesn't already have a
 * facedown card hidden there"), and the Tree raises it rather than replacing it.
 */
export function hiddenCardLimitAt(state: GameState, battlefieldId: string | undefined): number {
  return HIDDEN_CARDS_PER_BATTLEFIELD + (at(state, battlefieldId)?.extraHiddenCards ?? 0);
}

/** Rule 811's own limit: one facedown card per battlefield. */
const HIDDEN_CARDS_PER_BATTLEFIELD = 1;

/**
 * Aspirant's Climb — the Victory Score for THIS game.
 *
 * The only ability in this module that is not about its own battlefield: "the
 * points needed to win the game" is a property of the game, so it applies to
 * both players and is read wherever the threshold is. It is deliberately a
 * function of state rather than a constant for exactly that reason — `winner`
 * and `recordConquest`'s final-point rule (474) both compare against it, and a
 * constant that is right in one of them and stale in the other is how a game
 * ends a point early.
 */
export function winThreshold(state: GameState, base: number): number {
  let extra = 0;
  for (const bf of state.battlefields) {
    if (bf.defId === undefined) continue;
    extra += BATTLEFIELD_CONTINUOUS[bf.defId]?.extraPointsToWin ?? 0;
  }
  return base + extra;
}
