import type { GameState } from "../model/game-state.js";

/**
 * Static restrictions a permanent imposes on the OPPONENT — and one grant it
 * gives its own side.
 *
 * Its own module because these are read at GATES rather than resolved as
 * effects: `timing.mayPlayCardNow` and `mayPlayUnitToBattlefield` for the two
 * that restrict plays, `unit-triggers.mayPlaceWithoutPresence` for the grant, and
 * `readyUnit`/`readyPermanent` for the ready-lock. A card whose whole text is
 * "you may not" has no resolver to live in.
 *
 * The shared hazard, and the reason all three are together: every one of these
 * is asked by BOTH the enumerator and the validator, and them disagreeing is how
 * this codebase produces an action that is offered and then refused.
 */

/** Brynhir Thundersong: "When you play me, opponents can't play cards this
 *  turn." A one-shot lock armed by her on-play trigger, not a static — she can
 *  die and the turn is still locked, which is what "this turn" means. */
const BRYNHIR = "OGN-026";

/** Mageseeker Warden: "While I'm at a battlefield, opponents can only play units
 *  to their base. While I'm at a battlefield, spells and abilities can't ready
 *  enemy units and gear." Two restrictions, both positional and both continuous —
 *  she stops restricting the moment she is recalled or dies. */
const MAGESEEKER_WARDEN = "OGN-070";

/** Miss Fortune - Buccaneer: "You may play me to an open battlefield. FRIENDLY
 *  UNITS may be played to open battlefields." The second sentence is the card —
 *  the first is the ordinary per-card placement grant `PLACEMENT_GRANTS` already
 *  holds, and this widens it to the whole board while she is in play. */
const MISS_FORTUNE_BUCCANEER = "OGN-193";

/** The cards this module implements, for coverage.ts — they live at gates rather
 *  than in an effect registry, so nothing else would report them. */
const TIANNA_CROWNGUARD = "SFD-060";

export function boardRestrictionDefIds(): string[] {
  return [TIANNA_CROWNGUARD, BRYNHIR, MAGESEEKER_WARDEN, MISS_FORTUNE_BUCCANEER];
}

/** Is `defId` in play for `playerIndex`, AT A BATTLEFIELD? The positional test
 *  the Warden's two sentences share — she does nothing from base. */
function atOwnBattlefield(state: GameState, playerIndex: 0 | 1, defId: string): boolean {
  const owner = state.players[playerIndex];
  return state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some((u) => u.defId === defId));
}

/** Is `defId` in play for `playerIndex` anywhere — base or battlefield? */
function inPlayFor(state: GameState, playerIndex: 0 | 1, defId: string): boolean {
  const owner = state.players[playerIndex];
  return (
    owner.baseUnits.some((u) => u.defId === defId) ||
    state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some((u) => u.defId === defId))
  );
}

/**
 * Brynhir Thundersong's lock — may `playerIndex` play cards at all right now?
 *
 * Armed on HER play and cleared by `runEnd`, so it survives her death: "opponents
 * can't play cards this turn" is a fact about the turn, not a continuous ability,
 * and killing her in response must not undo it.
 */
export function mayPlayCardsAtAll(state: GameState, playerIndex: 0 | 1): boolean {
  return !state.players[playerIndex].cannotPlayCardsThisTurn;
}

/**
 * Mageseeker Warden's first sentence — "opponents can only play units to their
 * BASE" while she stands at a battlefield.
 *
 * Asked of the DESTINATION, so a play to base stays legal and every battlefield
 * destination is barred. Composes with rule 813's own destination rule rather
 * than replacing it: both have to allow a destination for it to be offered.
 */
export function mayPlayUnitToBattlefieldUnderRestrictions(state: GameState, playerIndex: 0 | 1): boolean {
  const opponentIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
  return !atOwnBattlefield(state, opponentIndex, MAGESEEKER_WARDEN);
}

/**
 * Mageseeker Warden's second sentence — "spells and abilities can't ready enemy
 * units and gear" while she stands at a battlefield.
 *
 * `ownerIndex` is whose permanent is being readied. The survey OVERSTATED what
 * this needed: it claimed the check had to know which effect was readying and
 * had to exempt Awaken and combat cleanup. Measured, the exemption is already
 * structural — `runAwaken` readies by its own inline map and combat never calls
 * either helper, so every caller of `readyUnit`/`readyPermanent` is a spell, an
 * ability or a trigger. The check can read board state alone.
 */
export function mayReadyPermanent(state: GameState, ownerIndex: 0 | 1): boolean {
  const opponentIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
  return !atOwnBattlefield(state, opponentIndex, MAGESEEKER_WARDEN);
}

/**
 * Miss Fortune - Buccaneer's second sentence — "friendly units may be played to
 * open battlefields" while she is in play.
 *
 * A BOARD-WIDE version of the per-card grant `PLACEMENT_GRANTS` holds for Sneaky
 * Deckhand and Sai Scout, which is why it is asked separately rather than added
 * to that table: hers is not about which card is being played.
 *
 * NOT positional — her text names no battlefield for herself, unlike the Warden's
 * two sentences, so she grants it from base as well.
 */
/**
 * Tianna Crownguard (SFD-060) — "While I'm AT A BATTLEFIELD, opponents can't
 * gain points."
 *
 * Positional, like the Mageseeker Warden's and unlike Miss Fortune's: her text
 * names a battlefield for herself, so she does nothing from base.
 *
 * Asked of the player who is ABOUT TO GAIN, and answers "is an ENEMY Tianna
 * standing at a battlefield" — she blocks her controller's opponents, not
 * everybody.
 */
export function mayGainPoints(state: GameState, playerIndex: 0 | 1): boolean {
  const opponentIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
  return !atOwnBattlefield(state, opponentIndex, TIANNA_CROWNGUARD);
}

export function grantsOpenBattlefieldPlacement(state: GameState, playerIndex: 0 | 1): boolean {
  return inPlayFor(state, playerIndex, MISS_FORTUNE_BUCCANEER);
}
