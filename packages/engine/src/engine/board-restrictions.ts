import type { GameState } from "../model/game-state.js";
import { selfNearVictory } from "./constants.js";

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

/**
 * Renata Glasc - Industrialist (SFD-171) — "Your tokens enter ready."
 *
 * The one entry in this module that GRANTS at a gate rather than forbidding at
 * one, and it is here for the module's stated reason: a card whose whole text is
 * a statement about how the rules run has no resolver to live in.
 *
 * # Why this beats the printed word "exhausted"
 *
 * Sixteen SFD cards say "play a Gold gear token **exhausted**", and none of them
 * loses to her by accident — this was read off the rules and is worth writing
 * down, because the naive reading (a card's own explicit instruction is more
 * specific than a blanket grant, so it wins) is wrong here and looks right.
 *
 *  - **149.1: "Gear enter play Ready."** A Gold gear token's DEFAULT is ready.
 *    Unit tokens are the opposite — 359.2.c enters them exhausted.
 *  - **184.1**: a token-making effect "may state that the token enters ready or
 *    exhausted, **if that state is contrary to the default for the token's
 *    type**". That is the whole reason those sixteen cards print the word: they
 *    are overriding gear's ready default, not restating it.
 *  - **369.3** identifies a replacement effect applying as an object enters "by
 *    describing how the unit enters", and gives Master Yi, Honed — "I enter
 *    ready" — as the worked example: "the event of him entering exhausted is
 *    replaced by one where he enters ready". Renata's text is that shape.
 *  - **375**'s second example settles the collision: where a modification from
 *    the generating effect "cannot apply, **so we ignore it**". Her replacement
 *    fixes the entry state, so the generating effect's "exhausted" is ignored.
 *
 * So a ready Gold — a free rainbow Power the turn it is made — is the intended
 * payoff on a 4-cost champion, not an overreach. `createGearToken`'s comment
 * used to argue the other way and has been corrected in place.
 *
 * # Two things she is not
 *
 * **Not positional.** Her text names no battlefield for herself, so `inPlayFor`
 * and not `atOwnBattlefield` — she works from base, unlike Tianna above and the
 * Warden, and like Miss Fortune below.
 *
 * **Not restricted to unit tokens.** 185.2.d gives tokens a type and has them
 * follow their type's rules; a Gold gear token is still a token, and "your
 * tokens" carries no restriction. She reaches both kinds.
 */
const RENATA_INDUSTRIALIST = "SFD-171";
/** The OTHER Renata — Chem-Baroness, whose clause is about the score. */
const RENATA_CHEM_BARONESS = "SFD-201";

export function boardRestrictionDefIds(): string[] {
  return [TIANNA_CROWNGUARD, RENATA_INDUSTRIALIST, BRYNHIR, MAGESEEKER_WARDEN, MISS_FORTUNE_BUCCANEER];
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

/**
 * Renata Glasc - Industrialist's replacement effect — do `ownerIndex`'s tokens
 * enter ready regardless of what the effect making them asked for?
 *
 * Asked at the two placement gates in `token.ts` (`placeToken` for units,
 * `placeGearToken` for gear), which between them are the only paths that put a
 * token on the board — `token.ts` is the only module in the engine that sets
 * `isToken: true`, so there is no third way in for this to miss.
 *
 * Asked of the token's OWN controller, not an opponent: "YOUR tokens".
 */
export function tokensEnterReady(state: GameState, ownerIndex: 0 | 1): boolean {
  return inPlayFor(state, ownerIndex, RENATA_INDUSTRIALIST);
}

/**
 * Renata Glasc - CHEM-BARONESS (SFD-201), the other Renata — "While your score is
 * within 3 points of the Victory Score, your Gold [Add] an additional [1]."
 *
 * A continuous modifier on a TOKEN's printed ability, read where that ability
 * resolves rather than written into the token: the score moves during a game, so
 * a Gold minted while behind still pays the bonus once its controller pulls
 * ahead.
 *
 * **It does NOT use `inPlayFor`, and the two Renatas are exactly why.**
 * Industrialist (SFD-171) is a **Unit** — a Champion — so the board walk finds
 * her and `tokensEnterReady` above is right to use it. Chem-Baroness is a
 * **LEGEND**, which sits in its own zone and is on no battlefield and in no base,
 * so `inPlayFor` can never see her: written that way this clause was silently
 * dead, and the test that spends a Gold with her out is what said so. It is the
 * same gap `legendEventTriggers` records for the listener walk — "that walk
 * covered base units, battlefield units, active Gear and two trash cards — never
 * `players[i].legend`".
 *
 * A Legend needs no in-play test at all: it is always in its zone and cannot die,
 * so identity IS presence.
 */
export function goldAddsExtraEnergy(state: GameState, ownerIndex: 0 | 1): boolean {
  return state.players[ownerIndex].legend.defId === RENATA_CHEM_BARONESS && selfNearVictory(state, ownerIndex);
}
