import type { GameState } from "../model/game-state.js";
import { selfNearVictory } from "./constants.js";
import { canonicalDefId } from "../cards/card-loader.js";

/**
 * Static effects a permanent has just by being on the board — restrictions it
 * imposes on the OPPONENT, and the grants and permissions it gives its own side.
 *
 * Its own module because these are read at GATES rather than resolved as
 * effects: `timing.mayPlayCardNow` and `mayPlayUnitToBattlefield` for the ones
 * that restrict plays, `timing.mayPlayFromTrash` for the one that widens them,
 * `unit-triggers.mayPlaceWithoutPresence` for the placement grant,
 * `readyUnit`/`readyPermanent` for the ready-lock, `turn-manager.runDraw` for the
 * skipped draw and `effect-helpers.fileIntoTrash` for the trash replacement. A
 * card whose whole text is "you may not" — or "you may", said continuously — has
 * no resolver to live in.
 *
 * **A LEAF, deliberately.** It imports the model, the card loader and constants
 * and nothing else, which is what lets `timing`, `turn-manager`, `effect-helpers`
 * and `execute-play-card` all ask it without a cycle. Anything here that needed
 * to reach back into the effect machinery would belong somewhere else.
 *
 * The shared hazard, and the reason all three are together: every one of these
 * is asked by BOTH the enumerator and the validator, and them disagreeing is how
 * this codebase produces an action that is offered and then refused.
 */

/** Brynhir Thundersong: "When you play me, opponents can't play cards this
 *  turn." A one-shot lock armed by her on-play trigger, not a static — she can
 *  die and the turn is still locked, which is what "this turn" means. */
const BRYNHIR = "OGN-026";

/**
 * Endless Riches (VEN-022) — a Gear whose three continuous clauses are all read
 * from here:
 *
 *     "Skip your Draw Phase."
 *     "You may play cards from your trash."
 *     "If a card would go to your trash from anywhere other than your Main Deck,
 *      banish it instead."
 *
 * (Its FOURTH clause, "when you play this, banish your hand and trash, then
 * [Burn 7]", is an on-play self trigger and lives in `effects/fury.ts` with the
 * rest of the card's domain.)
 *
 * All three bind only its CONTROLLER — this is the module's first entry that
 * restricts and grants entirely on its own side — and all three are continuous,
 * so trashing or banishing the Gear lifts every one of them at once. No armed
 * state, nothing to sweep.
 *
 * **Read off `activeGear`, which is where a played Gear lives.** A Gear in a
 * trash or a hand does nothing, which is the ordinary continuous-ability reading
 * and the same positional care `atOwnBattlefield` takes for a unit.
 */
const ENDLESS_RICHES = "VEN-022";

/**
 * Does `playerIndex` have Endless Riches in play?
 *
 * One predicate for all three clauses rather than three, because they are one
 * card's presence asked three times — and a card that stopped answering one of
 * them while still answering the others would be a strictly stranger game object
 * than either the card that is there or the card that is not.
 *
 * Canonicalised, like `mayPlaySpellNamed` and `mayReadyPermanent`: an alternate
 * printing is the same card (132.1). VEN-022 has none today, and this costs
 * nothing to be right about in advance.
 */
export function controlsEndlessRiches(state: GameState, playerIndex: 0 | 1): boolean {
  return state.players[playerIndex].activeGear.some((g) => canonicalDefId(g.defId) === ENDLESS_RICHES);
}

/**
 * Ol' Poro (VEN-029) — "I can't be played on your first, second, or third turns."
 *
 * A restriction the CARD imposes on itself, which is a new direction for this
 * module: every other entry is a permanent in play restricting somebody. This one
 * is read while the card is still in hand, which is why it takes a defId rather
 * than walking the board.
 *
 * `turnNumber` is a ROUND counter (115.1.c's looping queue) and advances only
 * when play returns to the FIRST player, so "your Nth turn" is the same number
 * for either player — the reading Otterpus's entry below sets out at length.
 *
 * Read by `timing.mayPlayCardNow`, so the card is never OFFERED on turns 1-3
 * rather than being offered and refused.
 */
const OL_PORO = "VEN-029";
const OL_PORO_EARLIEST_TURN = 4;

/** May this card be played at all this turn, by its own printed text? */
export function mayPlayCardThisTurn(state: GameState, defId: string): boolean {
  if (canonicalDefId(defId) !== OL_PORO) return true;
  return state.turnNumber >= OL_PORO_EARLIEST_TURN;
}

/**
 * Sandstone Chimera (VEN-036) — "while I'm at a battlefield, players only channel
 * 1 rune at the start of their Channel Phase."
 *
 * Positional, like the Warden and the Feline: she does nothing from base. Bare
 * "players", so EITHER side's Chimera caps EVERYONE's channelling, which is why
 * this takes no player argument at all.
 */
const SANDSTONE_CHIMERA = "VEN-036";

export function chimeraCapsChannelling(state: GameState): boolean {
  return ([0, 1] as const).some((ownerIndex) => atOwnBattlefield(state, ownerIndex, SANDSTONE_CHIMERA));
}

/**
 * Otterpus (VEN-053) — "If a player would score 1 point from conquering or
 * holding during their first or second turn, they draw 1 instead."
 *
 * **"A PLAYER", bare, so it binds BOTH sides including its own controller.** That
 * is the first entry in this module that does, and it is what makes the card a
 * symmetrical clock rather than a defensive one: it slows whoever is ahead on
 * board early, which is as often the Otterpus's own side.
 *
 * # "Their first or second turn" is `turnNumber <= 2`
 *
 * `turnNumber` is a ROUND counter — 115.1.c's looping queue — and it advances
 * only when play returns to the FIRST player, so both players' first turns happen
 * during `turnNumber === 1` and both second turns during `turnNumber === 2`.
 * "Their Nth turn" is therefore the same number for either player, and no
 * per-player tally is needed. Written out because the alternative (a per-player
 * turn count) is the thing a reader will assume was missing.
 *
 * Read off the BOARD from either zone: nothing in the printed text says "while
 * I'm at a battlefield", unlike the Warden and the Feline above, so a base
 * Otterpus replaces just as well.
 */
const OTTERPUS = "VEN-053";
const OTTERPUS_TURNS = 2;

/**
 * Does a score of 1 point from conquering or holding become a draw instead?
 *
 * Asked at the two SCORING sites rather than inside `gainPoints`, and the
 * distinction is the card: it names "score 1 point from conquering or holding",
 * so a point from Swain's conquest clause, from Bottled Constellation, or from
 * any other source is untouched. `gainPoints` is the funnel for ALL of those, and
 * putting this there would silently widen the card to every point in the game.
 */
export function scoringBecomesDraw(state: GameState, playerIndex: 0 | 1): boolean {
  if (state.turnNumber > OTTERPUS_TURNS) return false;
  return ([0, 1] as const).some((ownerIndex) => inPlayFor(state, ownerIndex, OTTERPUS));
}

/** Fallen Feline: "When you play me, name a spell. While I'm at a battlefield,
 *  opponents can't play spells with that name." Positional and continuous, like
 *  the Warden below — but keyed to the NAME she recorded rather than to her
 *  defId alone, so the predicate takes the card being played. */
const FALLEN_FELINE = "VEN-132";

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

/** Arachnoid Horror: "I can be played to an occupied battlefield if an enemy
 *  unit is alone there. Friendly units can be played to an occupied battlefield
 *  if an enemy unit is alone there." The SECOND sentence is this module's — the
 *  first is the per-card grant `PLACEMENT_GRANTS` holds, exactly the split Miss
 *  Fortune - Buccaneer above has. */
const ARACHNOID_HORROR = "UNL-117";

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
  // Maduli's "I can't be readied" is a pure NEGATIVE with no effect behind it,
  // so it lives here beside the other restrictions. Coverage MERGES this claim
  // with the two his [Chaos] move ability already makes (pending decisions,
  // activated abilities) — the same split Concentrate and Master Yi have.
  // Otterpus's replacement is his ENTIRE printed text and lives in this module
  // plus the two scoring sites that read it, so this list is his only
  // registration anywhere — the Lucian - Purifier trap, which costs a working
  // card its place in generated decks and reports it unimplemented.
  //
  // Fallen Feline is deliberately NOT here: her naming half is a `unitTriggers`
  // entry in effects/order.ts, so coverage already sees her, and a second claim
  // would say the wrong thing about where her text lives.
  return [
    TIANNA_CROWNGUARD,
    RENATA_INDUSTRIALIST,
    BRYNHIR,
    MAGESEEKER_WARDEN,
    MISS_FORTUNE_BUCCANEER,
    MADULI_THE_GATEKEEPER,
    OTTERPUS,
    // Ol' Poro's "I can't be played on your first, second, or third turns" and
    // Sandstone Chimera's channel cap are each the card's ENTIRE printed text,
    // and both live here — the Lucian - Purifier trap, which reports a working
    // card unimplemented and drops it from generated decks.
    //
    // The Chimera's cap is applied in `turn-manager.runChannel`, which reads this
    // module's predicate; coverage is claimed HERE because this is where her
    // sentence is decided, and a second claim would say the wrong thing about
    // where her text lives.
    OL_PORO,
    SANDSTONE_CHIMERA,
  ];
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
 * Lilting Lullaby's "its controller can't play spells this turn".
 *
 * Its own predicate beside `mayPlayCardsAtAll` rather than a parameter on it:
 * the two bans are different widths and a player may be under both, so a caller
 * has to be able to ask each. Armed on the Lullaby's RESOLUTION and cleared by
 * `runEnd`, exactly as Brynhir's is — the ban is a fact about the turn, so
 * killing the caster in response must not undo it.
 */
export function mayPlaySpells(state: GameState, playerIndex: 0 | 1): boolean {
  return !state.players[playerIndex].cannotPlaySpellsThisTurn;
}

/**
 * Fallen Feline's second sentence — "while I'm at a battlefield, opponents can't
 * play spells with that name".
 *
 * **Its own predicate rather than a widening of `mayPlaySpells` above, because
 * it is a different KIND of ban.** The Lullaby's is a fact about the turn: armed
 * on resolution, cleared by `runEnd`, and deliberately outliving the caster. This
 * one is continuous and positional — it holds exactly while a Feline who has
 * named this spell stands at a battlefield, so killing her, recalling her, or
 * sending her back to base lifts it at once, and nothing needs sweeping. Both can
 * apply, so `mayPlayCardNow` asks each.
 *
 * # By NAME, which is what makes 132.1 load-bearing
 *
 * 132.1 — "each card has a name that identifies it uniquely" — so the ban
 * catches every printing and every copy, not one instance. This is the one
 * restriction here that has to look at the card being played rather than only at
 * the board, which is why it takes `cardName` where its neighbours take a player.
 *
 * `namedSpell === undefined` is a Feline who has not answered her question yet,
 * and she bans nothing: 762 makes naming an act the player performs, not a state
 * the card starts in.
 *
 * Canonicalised on the way in, like `mayReadyPermanent`'s Maduli check and unlike
 * `atOwnBattlefield` below — an alternate printing of the Feline is the same card
 * (132.1) and must impose the same ban. That is the silently-inert-printing class
 * this set has already produced ten of.
 */
export function mayPlaySpellNamed(state: GameState, playerIndex: 0 | 1, cardName: string): boolean {
  const opponentIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
  const opponent = state.players[opponentIndex];
  return !state.battlefields.some((bf) =>
    (bf.units[opponent.id] ?? []).some(
      (u) => canonicalDefId(u.defId) === FALLEN_FELINE && u.namedSpell === cardName,
    ),
  );
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
 * UNL-144 Maduli the Gatekeeper — "I can't be readied."
 *
 * **Per UNIT, which is why it cannot ride `mayReadyPermanent` above.** That one
 * asks a question about a SEAT (is an enemy Mageseeker Warden standing at a
 * battlefield), so it answers the same for every permanent that player controls.
 * Maduli's sentence is about one card, and no amount of parameterising a
 * per-player lock expresses it.
 *
 * **Both readying sources have to ask, and the Awaken half has a rule written
 * for exactly this.** 415.1 defines Readying once and 415.3 lists the two ways
 * it happens (415.3.a the Awakening Phase, 415.3.b effects and spells), so a
 * restriction on being Readied binds both. But the sharper citation for the
 * Awaken is **315.1.b.1**, which carries the qualifier in its own sentence:
 *
 * > "The Turn Player readies all Game Objects they control **that are able to be
 * > readied**."
 *
 * That clause is the hook — the Awaken is not "ready everything", it is "ready
 * everything that can be". Read against `pdftotext -raw`; the refusal pin in
 * `unl-chaos-wave4.test.ts` had already found this number and it checks out.
 *
 * That is what made this a LIVE DIVERGENCE rather than an absence: the engine's
 * two sites are `runAwaken`'s inline maps and `readyUnit`, `mayReadyPermanent`
 * covers only the second, and nothing covered him at all — so he readied every
 * Awaken and was strictly STRONGER than printed. `mayReadyPermanent`'s own
 * comment records the Awaken exemption as "structural", which is correct for the
 * Warden (a spells-and-abilities lock) and is exactly what must NOT be inherited
 * here.
 *
 * Takes the unit rather than an id: both call sites already hold the object, and
 * `runAwaken`'s map has no id to look up without re-walking the board it is
 * rebuilding.
 */
const MADULI_THE_GATEKEEPER = "UNL-144";

export function unitMayBeReadied(unit: { defId: string }): boolean {
  return canonicalDefId(unit.defId) !== MADULI_THE_GATEKEEPER;
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
 * Arachnoid Horror's SECOND sentence — "Friendly units can be played to an
 * occupied battlefield if an enemy unit is alone there."
 *
 * The board-wide twin of his own placement grant, and it lives here rather than
 * in `PLACEMENT_GRANTS` for exactly the reason Miss Fortune's does: that table is
 * keyed on the card BEING PLAYED, and this is a fact about the board while he
 * stands on it. Keying it there would have meant a row per card in the pool.
 *
 * **NOT positional.** His text names no battlefield for himself — unlike the
 * Mageseeker Warden's two sentences, which say "while I'm at a battlefield" — so
 * he grants it from base as well. Same reading Miss Fortune takes.
 *
 * The battlefield half of the question (`enemyUnitIsAloneAt`, 740.2.a) is asked
 * by the caller in `unit-triggers`, beside the open-battlefield test hers is
 * paired with.
 */
export function grantsEnemyAlonePlacement(state: GameState, playerIndex: 0 | 1): boolean {
  return inPlayFor(state, playerIndex, ARACHNOID_HORROR);
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
