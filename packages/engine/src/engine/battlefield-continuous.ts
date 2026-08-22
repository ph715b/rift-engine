import type { GameState } from "../model/game-state.js";
import { canonicalDefId } from "../cards/card-loader.js";
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
  /**
   * "While you control this battlefield, friendly `[Repeat]` costs cost N
   * Energy less" (Marai Spire).
   *
   * **The first entry in this table that is neither positional nor symmetric**,
   * and it is both of those at once. Every other ability here is either "units
   * HERE" (read off the unit's own location) or applies to both players
   * (`extraPointsToWin`). This one is game-wide — it discounts a spell cast
   * from anywhere — but only for whoever CONTROLS the battlefield, so it cannot
   * be answered by `at()` from a location and needs its own controller-scoped
   * query. See `repeatEnergyDiscountFor`.
   */
  repeatEnergyDiscountForController?: number;
  /**
   * "Units can't be played here" (Rockfall Path).
   *
   * **PLAYED, not moved or placed.** The card restricts one verb, and the
   * distinction is the whole of it: a unit may still MOVE here, be forced here
   * by Charm or Temptation, or arrive by a Recall. Reading it as "no unit may
   * become present" would make it a far stronger card than it prints.
   *
   * Symmetric — "units", not "your units" — so it binds both players, like every
   * other unqualified battlefield ability here.
   */
  noUnitsPlayedHere?: true;
  /**
   * "While you control this battlefield, the FIRST friendly non-token gear played
   * each turn costs N Energy less" (Ornn's Forge).
   *
   * Controller-scoped and game-wide, like `repeatEnergyDiscountForController`
   * above — the gear is played to a base, not to this battlefield, so this cannot
   * be answered from a location.
   *
   * "The FIRST ... each turn" is why `PlayerState.gearPlayedThisTurn` exists: the
   * discount is not a property of the gear or of the board but of how many have
   * already gone this turn.
   */
  firstGearDiscountForController?: number;
  /**
   * "Units here WITH `[Keyword]` have +N Might" — Kinkou Temple's `[Tank]`.
   *
   * Its own field rather than a condition on `mightBonusHere`, because that one
   * is flat and unconditional by construction and every reader treats it that
   * way. The keyword is not looked up here: `battlefieldKeywordMightBonusAt`
   * takes the unit's ALREADY-COMPUTED keywords, which is what keeps this module
   * free of a `granted-keywords` import — see the note at the top about why it
   * imports nothing but types.
   */
  mightBonusHereForKeyword?: { readonly keyword: Keyword; readonly amount: number };
  /**
   * "Units here with `[X]` have `[Y]`" — Black Flame Altar's "units here with
   * `[Temporary]` have `[Shield]`".
   *
   * The first battlefield ability in this pool that reads a unit's keywords to
   * decide its keywords. `battlefieldConditionalKeywordsAt` is handed what the
   * unit has and returns what to add, so the decision stays in
   * `effectiveKeywords` where the merge rules (807.2/809.2/814.2/823.2's summing)
   * already live.
   */
  keywordsHereForKeyword?: { readonly ifKeyword: Keyword; readonly grants: readonly Keyword[] };
  /**
   * "While a unit here is defending ALONE, it has -N Might" — Forbidding Waste.
   *
   * **A PENALTY, stored positive and subtracted at the call site**, so the field
   * reads the way the card does. Positional AND combat-scoped AND owner-relative
   * all at once, which is why it cannot be a `mightBonusHere` row: that field is
   * a flat bonus to every unit standing here on both sides.
   *
   * "Alone" is the card's own reminder text — "there are no other FRIENDLY units
   * here" — so an enemy standing opposite does not keep you company. Wielder of
   * Water's "alone here" check in `effective-might` reads it the same way, and
   * this rides beside it.
   */
  lonelyDefenderMightPenalty?: number;
  /**
   * "Players ignore `[Deflect]` while paying for spells and abilities choosing
   * something here" — Heisho, Shell of the World.
   *
   * Rules 764-766's ignore mechanism, the same one Decree of Insight uses, but
   * POSITIONAL rather than per-card: read by `deflectSurchargeForTargets` per
   * TARGET, so a spell choosing one unit here and one elsewhere still owes the
   * second one's surcharge.
   */
  ignoresDeflectHere?: true;
  /**
   * "Each spell that chooses one or more units here that are FRIENDLY TO IT costs
   * N `[rainbow]` less" — Sandswept Tomb.
   *
   * "Friendly to it" is friendly to the SPELL, i.e. to its caster — so it
   * discounts your spell choosing your own unit here, and not your spell choosing
   * theirs. Applied ONCE however many qualifying units are chosen ("one or
   * more"), which is why it is an amount and not a per-unit rate.
   */
  friendlyChoiceRainbowDiscount?: number;
  /**
   * "During showdowns here, cards with `[Reaction]` cost N `[rainbow]` more" —
   * Mystic Vortex.
   *
   * Scoped to a Showdown AT THIS battlefield, so it is dead while the fight is
   * elsewhere. "(Hidden cards have [Reaction].)" is the card's own reminder that
   * this taxes an 811 play too.
   */
  reactionSurchargeDuringShowdownHere?: number;
  /**
   * "Any player may pay N `[rainbow]` as an additional cost to play a Dragon. If
   * they do, they play it to this battlefield" — Dragon Roost.
   *
   * A row here rather than a bare lookup so the battlefield is REPORTED: the
   * coverage gate reads `continuousBattlefieldDefIds()`, and this is the sixth
   * time this session a battlefield implemented off-table went on being called
   * inert. It is a standing permission on the board, which is what this table is
   * for.
   */
  dragonAdditionalCostRainbow?: number;
}

/** Forgotten Monument (SFD-209) — "players can't score here until their third
 *  turn". */
const FORGOTTEN_MONUMENT = "SFD-209";
/** Marai Spire (SFD-211) — "While you control this battlefield, friendly
 *  [Repeat] costs cost [1 Energy] less." */
const MARAI_SPIRE = "SFD-211";
/** Rockfall Path (SFD-216) — "Units can't be played here." */
const ROCKFALL_PATH = "SFD-216";
/** Ornn's Forge (SFD-213) — "While you control this battlefield, the first
 *  friendly non-token gear played each turn costs [1 Energy] less." */
const ORNNS_FORGE = "SFD-213";
/** Dragon Roost (VEN-157) — "Any player may pay [2 rainbow] as an additional
 *  cost to play a Dragon. If they do, they play it to this battlefield." */
const DRAGON_ROOST = "VEN-157";
export const DRAGON_ROOST_RAINBOW = 2;

/** Heisho, Shell of the World (VEN-158) — "Players ignore [Deflect] while paying
 *  for spells and abilities choosing something here." */
const HEISHO = "VEN-158";
/** Sandswept Tomb (VEN-164) — "Each spell that chooses one or more units here
 *  that are friendly to it costs [1 rainbow] less." */
const SANDSWEPT_TOMB = "VEN-164";
/** Mystic Vortex (VEN-160) — "During showdowns here, cards with [Reaction] cost
 *  [1 rainbow] more. (Hidden cards have [Reaction].)" */
const MYSTIC_VORTEX = "VEN-160";

/** Kinkou Temple (VEN-159) — "Units here with [Tank] have +1 [Might]." */
const KINKOU_TEMPLE = "VEN-159";
/** Black Flame Altar (UNL-208) — "Units here with [Temporary] have [Shield]." */
const BLACK_FLAME_ALTAR = "UNL-208";
/** Forbidding Waste (UNL-210) — "While a unit here is defending alone, it has
 *  -2 [Might]. (It's alone if there are no other friendly units here.)" */
const FORBIDDING_WASTE = "UNL-210";

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
  // "While you control this battlefield, friendly [Repeat] costs cost [1] less."
  // The Energy half only — the pip printed is an Energy pip, and Called Shot's
  // Repeat is 0 Energy + 1 Chaos Power, which this therefore cannot touch.
  [MARAI_SPIRE]: { repeatEnergyDiscountForController: 1 },
  // "Units can't be played here." No controller clause, so it binds BOTH players
  // — including whoever controls the battlefield.
  [ROCKFALL_PATH]: { noUnitsPlayedHere: true },
  // "The FIRST friendly non-token gear played each turn costs [1] less."
  // Controller-scoped like Marai Spire, and like it this is game-wide rather
  // than positional: the gear is played to a base or anywhere else, not here.
  [ORNNS_FORGE]: { firstGearDiscountForController: 1 },
  // ── UNL and VEN, wave 2: the CONDITIONAL continuous ones ──────────────────
  // Every OGN and SFD entry above is either flat ("units here have +1") or a
  // board-wide rule. These three read the UNIT — its keywords, or how alone it
  // is — which is why the interface grew three fields rather than reusing
  // `mightBonusHere`/`keywordsHere`.
  //
  // "Units here with [Tank] have +1 [Might]." Both sides, like the War Camp: the
  // card names no owner.
  [KINKOU_TEMPLE]: { mightBonusHereForKeyword: { keyword: "Tank", amount: 1 } },
  // "Units here with [Temporary] have [Shield]." Both sides again.
  [BLACK_FLAME_ALTAR]: { keywordsHereForKeyword: { ifKeyword: "Temporary", grants: ["Shield"] } },
  // "While a unit here is defending alone, it has -2 [Might]."
  [FORBIDDING_WASTE]: { lonelyDefenderMightPenalty: 2 },
  // "Players ignore [Deflect] while paying for spells and abilities choosing
  // something here." Both sides — "players", not "you".
  [HEISHO]: { ignoresDeflectHere: true },
  // "Each spell that chooses one or more units here that are FRIENDLY TO IT costs
  // [1 rainbow] less." Once, however many qualify.
  [SANDSWEPT_TOMB]: { friendlyChoiceRainbowDiscount: 1 },
  // "During showdowns HERE, cards with [Reaction] cost [1 rainbow] more."
  [MYSTIC_VORTEX]: { reactionSurchargeDuringShowdownHere: 1 },
  // "Any player may pay [2 rainbow] as an additional cost to play a Dragon. If
  // they do, they play it to this battlefield." Both sides — "any player".
  [DRAGON_ROOST]: { dragonAdditionalCostRainbow: DRAGON_ROOST_RAINBOW },
};


/**
 * May `playerIndex` score `battlefieldId` at all right now?
 *
 * **Distinct from `mayGainPoints`, and the difference is the whole ruling.**
 * Tianna Crownguard blocks GAINING A POINT while the scoring still happens, so
 * 470's once-per-battlefield-per-turn lockout fires and the opponent cannot
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

/**
 * Rockfall Path's "Units can't be played here" — may a unit be PLAYED onto this
 * battlefield at all?
 *
 * Asked of the battlefield alone, with no player argument, because the card names
 * none: it binds both sides equally.
 *
 * The one function `mayPlayUnitToBattlefield` composes into, so the enumerator
 * and the validator cannot disagree — the split that produced an AI throwing on
 * an action it was offered, recorded on that very function.
 */
export function mayPlayUnitAt(state: GameState, battlefieldId: string): boolean {
  return at(state, battlefieldId)?.noUnitsPlayedHere !== true;
}

/** For coverage.ts, and for the completeness gate that asks whether all 24
 *  printed battlefields do something. */
export function continuousBattlefieldDefIds(): string[] {
  return Object.keys(BATTLEFIELD_CONTINUOUS);
}

/**
 * Marai Spire's discount on `[Repeat]` costs, in Energy, for this player.
 *
 * Controller-scoped rather than positional, so this walks the battlefields the
 * player CONTROLS instead of asking `at()` about one location — the spell being
 * discounted may be cast from anywhere, and "friendly" here means the caster's,
 * not "at this battlefield".
 *
 * SUMMED across controlled battlefields rather than taken as a max. Two copies
 * cannot happen in a real game (each battlefield is a distinct card), so this is
 * the general form of an unreachable case — but summing is what the text says
 * and a `max` would be inventing a non-stacking rule the card does not print.
 *
 * Floored by the CALLER, not here: this returns the discount, and the cost it
 * applies to cannot go below zero. Keeping the floor at the application site is
 * what lets Called Shot — whose Repeat is 0 Energy — be discounted by nothing
 * rather than into a negative that a later addition would silently unwind.
 */
/**
 * Ornn's Forge's discount on the FIRST gear this player plays this turn, in
 * Energy — zero once one has already been played, and zero for anything that is
 * not a Gear.
 *
 * Controller-scoped, so it walks the battlefields this player CONTROLS rather
 * than asking `at()` about a location: the gear being discounted is played to a
 * base, not to the Forge.
 */
export function firstGearDiscountFor(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  if (player === undefined || player.gearPlayedThisTurn > 0) return 0;
  let total = 0;
  for (const bf of state.battlefields) {
    if (bf.controllerId !== player.id || bf.defId === undefined) continue;
    total += BATTLEFIELD_CONTINUOUS[bf.defId]?.firstGearDiscountForController ?? 0;
  }
  return total;
}

export function repeatEnergyDiscountFor(state: GameState, playerIndex: 0 | 1): number {
  const playerId = state.players[playerIndex]?.id;
  if (playerId === undefined) return 0;
  let total = 0;
  for (const bf of state.battlefields) {
    if (bf.controllerId !== playerId || bf.defId === undefined) continue;
    total += BATTLEFIELD_CONTINUOUS[bf.defId]?.repeatEnergyDiscountForController ?? 0;
  }
  return total;
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
 * Kinkou Temple's "+1 [Might] to units here with `[Tank]`".
 *
 * **Takes the unit's keywords rather than looking them up**, which is what keeps
 * this module importing nothing but types — `granted-keywords` imports
 * `effective-might`, and `effective-might` is this function's only caller, so a
 * lookup here would close a three-module cycle. The caller already has the merged
 * set in hand at the point it asks.
 */
/**
 * Does this battlefield print a keyword-conditional Might rule at all?
 *
 * **Asked BEFORE the keywords are computed, and that is load-bearing.**
 * `granted-keywords` imports `effective-might`, so `effectiveKeywords` called on
 * every Might evaluation closes a cycle across the whole engine — the first
 * version of Kinkou Temple did exactly that and four unrelated tests died with
 * "Maximum call stack size exceeded". This makes the expensive half reachable
 * only at the one battlefield that needs it.
 */
/** Heisho — is `[Deflect]` ignored for a target standing at `battlefieldId`? */
export function deflectIsIgnoredAt(state: GameState, battlefieldId: string | undefined): boolean {
  return at(state, battlefieldId)?.ignoresDeflectHere === true;
}

/**
 * Sandswept Tomb's discount for a spell that chose any FRIENDLY unit standing at
 * such a battlefield.
 *
 * Applied ONCE — "one or more units here" is a condition, not a rate — and only
 * for units belonging to the CASTER, which is what "friendly to it" means about a
 * spell.
 */
export function friendlyChoiceRainbowDiscountFor(
  state: GameState,
  playerIndex: 0 | 1,
  chosenInstanceIds: readonly (string | undefined)[],
): number {
  const ownerId = state.players[playerIndex].id;
  let best = 0;
  for (const id of chosenInstanceIds) {
    if (id === undefined) continue;
    for (const bf of state.battlefields) {
      if (!(bf.units[ownerId] ?? []).some((u) => u.instanceId === id)) continue;
      best = Math.max(best, at(state, bf.id)?.friendlyChoiceRainbowDiscount ?? 0);
    }
  }
  return best;
}

/**
 * Mystic Vortex's surcharge on a `[Reaction]` card while a Showdown is running AT
 * that battlefield.
 *
 * The Showdown's location is read off the STATE rather than passed in, because
 * this is a fact about the board and not about the play — a Reaction cast into a
 * fight somewhere else is untaxed.
 */
export function reactionSurchargeNow(state: GameState): number {
  if (state.turnState !== "Showdown") return 0;
  return at(state, state.showdownBattlefieldId ?? undefined)?.reactionSurchargeDuringShowdownHere ?? 0;
}

/**
 * Dragon Roost (VEN-157) — the battlefield a Dragon may be paid onto, or
 * undefined when none is in play.
 *
 * "ANY player may pay" — both sides, like every other unqualified battlefield
 * ability, so this takes no player.
 *
 * Returns the ID rather than a boolean because the whole card is the
 * DESTINATION: the enumerator needs to know where to send the paid variant, and
 * the validator needs to check it went there.
 *
 * The FIRST such battlefield if two are somehow in play — two Roosts would offer
 * two destinations and this offers one, which is a narrowing recorded in
 * docs/rules-conformance.md rather than a claim that it cannot happen.
 */
export function dragonRoostBattlefieldId(state: GameState): string | undefined {
  // Off the TABLE rather than off the defId, so the row is what makes the card
  // real — and so the coverage gate, which reads the table, can see it.
  return state.battlefields.find((bf) => at(state, bf.id)?.dragonAdditionalCostRainbow !== undefined)?.id;
}

export function hasKeywordMightRuleAt(state: GameState, battlefieldId: string | undefined): boolean {
  return at(state, battlefieldId)?.mightBonusHereForKeyword !== undefined;
}

export function battlefieldKeywordMightBonusAt(
  state: GameState,
  battlefieldId: string | undefined,
  keywords: Partial<Record<Keyword, number>>,
): number {
  const rule = at(state, battlefieldId)?.mightBonusHereForKeyword;
  if (!rule) return 0;
  // PRESENCE, not magnitude: "units with [Tank]" is a yes/no about the keyword,
  // and a `[Tank]` from two sources is still one Tank unit.
  return (keywords[rule.keyword] ?? 0) > 0 ? rule.amount : 0;
}

/**
 * Black Flame Altar's "units here with `[Temporary]` have `[Shield]`".
 *
 * Handed what the unit HAS, returns what to ADD — so the merge itself stays in
 * `effectiveKeywords`, where 807.2/809.2/814.2/823.2's summing rules already
 * live and where a `[Shield]` from here correctly stacks with a printed one.
 */
export function battlefieldConditionalKeywordsAt(
  state: GameState,
  battlefieldId: string | undefined,
  keywords: Partial<Record<Keyword, number>>,
): readonly Keyword[] {
  const rule = at(state, battlefieldId)?.keywordsHereForKeyword;
  if (!rule) return [];
  return (keywords[rule.ifKeyword] ?? 0) > 0 ? rule.grants : [];
}

/**
 * Forbidding Waste's "-2 [Might] while defending alone", as a POSITIVE number the
 * caller subtracts.
 *
 * The "alone" and "defending" halves are the CALLER's to check — they need the
 * combat context and the unit's owner, neither of which this module has. This
 * answers only "does this battlefield have such a rule, and how big".
 */
export function lonelyDefenderPenaltyAt(state: GameState, battlefieldId: string | undefined): number {
  return at(state, battlefieldId)?.lonelyDefenderMightPenalty ?? 0;
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
  if (at(state, battlefieldId)?.blocksMoveToBase === true) return false;
  // Minotaur Reckoner (SFD-014) — "Units can't move to base."
  //
  // A UNIT source in a file of battlefield abilities, and it belongs here rather
  // than in a table of its own because this function is the one door: the
  // RecallUnit validator, `effect-helpers.recallUnitToBase` and the move
  // enumerator all come through it, so one check reaches every way a unit can go
  // home. A second predicate beside it would be the fourth place to keep in step.
  //
  // **GLOBAL and symmetric.** The card names no owner and no location — not
  // "your units", not "units here" — so a Minotaur in either player's base stops
  // both players' units everywhere. That is the widest reading and it is what is
  // printed; Vilemaw's Lair, one line up, is the positional one.
  //
  // Combat's own step-3d recall is deliberately NOT blocked, exactly as it is
  // not blocked by the Lair: it goes through `relocateToBaseUnchanged`, and it is
  // a step of the Combat Cleanup rather than a move a player makes.
  const minotaurs = state.players.flatMap((p) => [
    ...p.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[p.id] ?? []),
  ]);
  return !minotaurs.some((u) => u.defId === MINOTAUR_RECKONER);
}

/** Minotaur Reckoner — "Units can't move to base." See `mayMoveToBaseFrom`. */
const MINOTAUR_RECKONER = "SFD-014";

/** Determined Sentry — "I can't move to base." His whole printed text. */
const DETERMINED_SENTRY = "UNL-111";

/**
 * May THIS unit go home?
 *
 * `mayMoveToBaseFrom` above asks a question about the BOARD — a Minotaur
 * anywhere, or a battlefield that blocks it — and answers the same way for every
 * unit. Determined Sentry's "I can't move to base" is a fact about one unit, so
 * it cannot live there, and a caller that asked only the board question would let
 * him walk home.
 *
 * Both are asked here so the four call sites keep coming through ONE door, which
 * is the argument `mayMoveToBaseFrom`'s own comment already makes: a second
 * predicate beside it would be the fourth place to keep in step.
 *
 * **Combat's step-3d recall is unaffected**, exactly as it is for the Minotaur:
 * it goes through `relocateToBaseUnchanged`, which calls neither predicate. 456.3
 * makes that right rather than accidental — a corrective Recall is not a Move,
 * and "can't MOVE to base" does not reach it.
 */
export function unitMayMoveToBase(
  state: GameState,
  unit: { defId: string },
  battlefieldId: string | undefined,
): boolean {
  if (canonicalDefId(unit.defId) === DETERMINED_SENTRY) return false;
  return mayMoveToBaseFrom(state, battlefieldId);
}

/**
 * May this unit MOVE AT ALL this turn?
 *
 * Vex - Apathetic's "they can't move it this turn" — a lock on one body, set when
 * she resolves and swept by `runEnd`. Distinct from exhaustion, which the mover
 * already checks: a readied unit is still locked, which is the whole point of the
 * clause and what made `unitsEnterReadyThisTurn` an insufficient stand-in.
 */
export function unitMayMoveThisTurn(state: GameState, unitInstanceId: string): boolean {
  // **`?? []` survives on one argument only, and it is not the one it started
  // with.** Adding the field made this predicate throw `Cannot read properties of
  // undefined` in 35 tests that build their own state literals — but those are all
  // fixed now, the field is REQUIRED on `GameState`, and typecheck catches any new
  // site. So as a guard against in-repo callers it is dead.
  //
  // It is kept for DESERIALIZED state: `packages/web` persists games through
  // `localStorage`, and a save written before this field existed has no list at
  // all. An absent list means exactly "nothing is locked", which is the correct
  // reading of an old save rather than a guess about a broken one.
  return !(state.movementLockedUnitInstanceIds ?? []).includes(unitInstanceId);
}

/** For coverage.ts — the cards this module implements that are not battlefields. */
export function moveRestrictionDefIds(): string[] {
  // Determined Sentry's whole printed text is "I can't move to base", so this is
  // his only registration anywhere — exactly the case `playCardDefIds`' comment
  // describes for a card whose text is one restriction.
  //
  // Vex - Apathetic is NOT here: her Stun is registered in effects/chaos.ts, and
  // the lock is a state field she writes rather than a rule this module owns.
  return [MINOTAUR_RECKONER, DETERMINED_SENTRY];
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
 * and `recordConquest`'s final-point rule (471.1.b) both compare against it, and a
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
