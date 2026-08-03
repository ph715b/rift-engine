import type { GameState, HiddenCard, PlayerState } from "../model/game-state.js";
import type { CardDefinition } from "../model/card-definition.js";
import type { CardInstance } from "../model/card.js";

/**
 * `[Hidden]` — rule 811.
 *
 * Two things live here, and the rules keep them firmly apart:
 *
 *  - **Hide** is a *Discretionary Action*, not a play. It opens no chain, and it
 *    costs 1 rainbow Power regardless of what the card itself costs.
 *  - **Playing from Hidden** is a real play that DOES open a chain, costs 0, is
 *    available only from the turn AFTER the card was hidden, and happens at
 *    `[Reaction]` speed because the keyword grants Reaction while facedown.
 *
 * The card's own printed cost is irrelevant in both directions, which is the
 * whole appeal — and the price is that the card is a hostage: Cleanup step 5
 * (rule 323) trashes it the moment you stop controlling the battlefield.
 */

/** The Power cost to Hide, in ANY domain (rule 811's rainbow pip). */
export const HIDE_POWER_COST = 1;

/** What a Hide costs `playerIndex` RIGHT NOW — the flat 1 rainbow Power of 811,
 *  or nothing while Guerilla Warfare's "you can hide cards ignoring costs this
 *  turn" is up.
 *
 *  One function rather than the constant read directly, because the enumerator,
 *  the validator and the executor all price a Hide and all three have to agree —
 *  the same discipline `deflectSurchargeForTargets` enforces for the surcharge. */
export function hideCostFor(state: GameState, playerIndex: 0 | 1): number {
  return state.players[playerIndex].hideIgnoresCostThisTurn ? 0 : HIDE_POWER_COST;
}

/** Teemo - Swift Scout: "You may pay [1 Energy] to hide a card instead of
 *  [1 rainbow]." A legend the player controls, so it is a property of the seat
 *  rather than of the board. */
const TEEMO_SWIFT_SCOUT = "OGN-263";

/**
 * May this player hide by paying ENERGY instead of rainbow Power?
 *
 * A cost ALTERNATIVE, not a discount — the price is the same size, in a different
 * currency — which is why it is a separate question from `hideCostFor` above
 * rather than a number it returns. Being able to hide off Energy matters because
 * a rainbow Power costs a rune from the pool while Energy can come from floating,
 * so it changes what a turn can afford rather than what it costs.
 */
export function mayHideWithEnergy(state: GameState, playerIndex: 0 | 1): boolean {
  return state.players[playerIndex].legend.defId === TEEMO_SWIFT_SCOUT;
}

/** The cards this module implements beyond the keyword itself, for coverage.ts. */
export function hideCostDefIds(): string[] {
  return [TEEMO_SWIFT_SCOUT];
}

/** Rainbow: `computeAutoPayment(channeled, 0, HIDE_POWER_COST, RAINBOW)` already
 *  means "any domain" — `matchesPowerDomain` treats a null domain as matching
 *  every rune, so no new cost machinery was needed for this. */
export const RAINBOW: null = null;

/** Does this card's printed text carry the keyword? Reads the definition rather
 *  than the instance because `hidden` is parse-time data (card-loader.ts), and
 *  the loader already excludes the cards that merely MENTION "[Hidden]" in
 *  reminder text without having it. */
export function isHiddenCard(def: CardDefinition | undefined): boolean {
  return def !== undefined && "hidden" in def && def.hidden === true;
}

/** The facedown card `playerIndex` has at this battlefield, if any. */
export function hiddenCardAt(state: GameState, battlefieldId: string, playerIndex: 0 | 1): HiddenCard | undefined {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return bf?.hiddenCards.find((h) => h.ownerIndex === playerIndex);
}

/** Is `playerIndex` controlling a battlefield with a facedown card of theirs on
 *  it? Mushroom Pouch's condition, and the reason masking must preserve
 *  PRESENCE even when it removes identity. */
export function controlsAnyFacedownCard(state: GameState, playerIndex: 0 | 1): boolean {
  const ownerId = state.players[playerIndex].id;
  return state.battlefields.some((bf) => bf.controllerId === ownerId && bf.hiddenCards.some((h) => h.ownerIndex === playerIndex));
}

/**
 * Can this hidden card be played yet?
 *
 * Rule 811: "**Beginning on the next turn**, this gains [Reaction] and you may
 * play this, ignoring its base cost." Not "not during this Action phase" — a
 * turn can end and come back to you — so it compares turn NUMBERS, which
 * `turn-manager.runEnd` only advances on wrapping back to the First Player.
 */
export function hiddenCardIsPlayable(state: GameState, hidden: HiddenCard): boolean {
  return state.turnNumber > hidden.hiddenOnTurn;
}

/**
 * What the opponent's facedown card looks like to everyone who isn't its owner.
 *
 * Presence, owner and timing survive; identity does not. That split is the whole
 * requirement: both the human and the AI must be able to see THAT something is
 * hidden there — it changes how you attack the battlefield, and Mushroom Pouch
 * asks the question directly — while neither may know WHICH card it is.
 */
const FACEDOWN_PLACEHOLDER: CardInstance = {
  instanceId: "hidden-facedown",
  defId: "HIDDEN-FACEDOWN",
  name: "Facedown card",
  domains: [],
  exhausted: false,
  isToken: false,
  kind: "Spell",
  energyCost: 0,
  powerCost: 0,
  powerDomain: null,
  isReaction: false,
  isAction: false,
};

/** Is this the placeholder rather than a real card? */
export function isFacedownPlaceholder(card: CardInstance): boolean {
  return card.defId === FACEDOWN_PLACEHOLDER.defId;
}

/**
 * `state` as `forPlayerIndex` is entitled to see it: every facedown card that
 * isn't theirs replaced by an opaque placeholder.
 *
 * Applied at exactly two boundaries — `heuristic-ai.chooseAction`, so the AI
 * cannot play around a card it may not know about, and the board's rendering of
 * the opponent's battlefields.
 *
 * **The limitation, stated rather than hidden:** the engine still holds the
 * truth behind this mask. A consumer that skips the mask sees everything. The
 * correct answer is a per-player view projection so no consumer can ever hold
 * another player's private information at all; that touches everything which
 * reads GameState and is much larger than this keyword. Recorded in
 * docs/rules-conformance.md.
 *
 * Returns the SAME state object when nothing needed masking, so the common case
 * (no hidden cards on the board at all) costs nothing.
 */
export function maskHiddenCards(state: GameState, forPlayerIndex: 0 | 1): GameState {
  let changed = false;
  const battlefields = state.battlefields.map((bf) => {
    if (!bf.hiddenCards.some((h) => h.ownerIndex !== forPlayerIndex)) return bf;
    changed = true;
    return {
      ...bf,
      hiddenCards: bf.hiddenCards.map((h) =>
        h.ownerIndex === forPlayerIndex ? h : { ...h, card: FACEDOWN_PLACEHOLDER },
      ),
    };
  });
  return changed ? { ...state, battlefields } : state;
}

/**
 * Cleanup step 5 (rule 323): "Remove all Hidden cards from all Battlefields that
 * are not controlled by the same player and place them in their **owner's**
 * Trash."
 *
 * This is what makes hiding a real decision rather than a free discount — the
 * card is a hostage to a battlefield you may not hold. Rule 811 says the same
 * from the other direction: the card stays "for as long as you control that
 * battlefield".
 *
 * Owner's trash, not the controller's: the two differ if control of the
 * battlefield changed, which is exactly the case this step exists for.
 */
export function removeUnheldHiddenCards(state: GameState): GameState {
  const orphaned: HiddenCard[] = [];
  const battlefields = state.battlefields.map((bf) => {
    if (bf.hiddenCards.length === 0) return bf;
    const kept = bf.hiddenCards.filter((h) => {
      const stillHeld = bf.controllerId === state.players[h.ownerIndex].id;
      if (!stillHeld) orphaned.push(h);
      return stillHeld;
    });
    return kept.length === bf.hiddenCards.length ? bf : { ...bf, hiddenCards: kept };
  });
  if (orphaned.length === 0) return state;

  const players = [...state.players] as [PlayerState, PlayerState];
  for (const h of orphaned) {
    players[h.ownerIndex] = { ...players[h.ownerIndex], trash: [...players[h.ownerIndex].trash, h.card] };
  }
  return { ...state, players, battlefields };
}
