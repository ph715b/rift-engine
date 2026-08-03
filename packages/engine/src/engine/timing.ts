import type { GameState } from "../model/game-state.js";
import type { Domain } from "../model/domain.js";
import { lowestOrdinalDomain } from "../model/domain.js";
import type { CardInstance } from "../model/card.js";
import { mayPlayCardsAtAll, mayPlayUnitToBattlefieldUnderRestrictions } from "./board-restrictions.js";

/**
 * Who may act right now.
 *
 * The rules hand the ability to act to a different player depending on the
 * state: with a Chain open it's whoever holds Priority (313), during a Showdown
 * it's whoever holds Focus (348: "During a Showdown, the player with Focus may
 * do one of the following"), and otherwise it's the Turn Player. That
 * precedence was previously written out separately in `heuristic-ai.chooseAction`,
 * in `GameBoard`, and implicitly in `legal-actions`' branch structure — three
 * copies of one rule. This is the single definition; the others call it.
 *
 * Mirrors GameState.java's `actingPlayer()`.
 */
export function actingPlayerIndex(state: GameState): 0 | 1 {
  // A pending decision outranks all three. It sits INSIDE a resolution, where
  // 323.2.a says Priority and Focus "are not passed or awarded" — so whoever
  // holds either of them is not the person the game is waiting on. Cull the Weak
  // asks the non-turn player a question on the turn player's turn, and without
  // this line the board and the AI would both look at the wrong player.
  //
  // One line here rather than three, because this function is already the single
  // definition legal-actions, GameBoard and heuristic-ai all call.
  const pending = state.pendingDecisions[0];
  if (pending) return pending.playerIndex;

  if (!state.chainOpen) return state.chainPriority;
  if (state.turnState === "Showdown") return state.focusHolder;
  return state.activePlayerIndex;
}

/**
 * A card's timing permission tier. The three tiers are cumulative, each adding
 * windows to the one below:
 *
 *   - `Default` — "A spell can be played during an Open State outside of
 *     Showdowns on its controller's turn" (rule 159).
 *   - `Action` — "in addition to being able to be played during an Open State,
 *     this spell may also be played during Open States during Showdowns"
 *     (159.2.a.1), which rule 806 spells out as "This can be played during
 *     showdowns on **any player's turn**".
 *   - `Reaction` — "Grants all cases and rules of Action. In addition to all
 *     prior cases, may also be played during all forms of Closed State" (161),
 *     i.e. rule 813's "played during Closed States on any player's turn".
 */
export type TimingTier = "Default" | "Action" | "Reaction";

/**
 * The tier a card actually has.
 *
 * Reaction is checked FIRST and short-circuits, because Reaction grants all of
 * Action's permissions (813) while the card data does not: the loader sets
 * `isAction` from the literal printed text, so every `[Reaction]`-only card —
 * Gust, Flash, Back to Back, Stupefy, En Garde, Meditation, Cannon Barrage,
 * Highlander, all 8 of them — has `isAction: false`. Deriving the tier here,
 * rather than testing the two flags at each call site, is what stops that from
 * becoming "Reaction spells can't be cast in Showdowns".
 *
 * Units and Gear carry `isReaction` too (Lux - Crownguard is a `[Reaction]`
 * Unit); only Spells carry `isAction` in this card pool, so a non-Spell is
 * either Reaction or Default.
 */
export function timingTierOf(card: CardInstance): TimingTier {
  // Only Unit and Spell instances carry isReaction; Gear and Legend don't have
  // the field at all, so this is a shape test rather than a kind test — adding
  // it to Gear later then needs no change here.
  if ("isReaction" in card && card.isReaction) return "Reaction";
  if (card.kind === "Spell" && card.isAction) return "Action";
  return "Default";
}

/**
 * Does `playerIndex`'s timing permission allow playing `card` in this state?
 *
 * Two independent questions, both of which must pass:
 *
 *  1. **May this player act at all** — they must be the acting player
 *     (`actingPlayerIndex`). This is why Action's "on any player's turn" needs
 *     no special case: during a Showdown the acting player is the Focus holder,
 *     which alternates between both players, so holding Focus on the opponent's
 *     turn is exactly the permission 806 describes.
 *  2. **Does the card's tier cover this state** — where "Open State" means the
 *     Chain is empty (310: "If a Chain exists, the turn is in a Closed State"),
 *     orthogonal to whether a Showdown is running.
 *
 * Does NOT check cost, targets, phase, or a Unit's destination restrictions —
 * validate-play-card owns those. This is only the timing gate.
 */
export function mayPlayCardNow(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  /** True when the card is being played FROM a facedown state. Rule 811: a
   *  hidden card "gains [Reaction] while facedown or played from facedown, and
   *  may be played any time a card with Reaction may be played as a result" —
   *  whatever its printed timing says. */
  fromHidden = false,
): boolean {
  if (playerIndex !== actingPlayerIndex(state)) return false;
  // Brynhir Thundersong's lock. Before the tier switch, because it bars EVERY
  // card however it is timed — including a [Reaction], which is the whole point
  // of a card that shuts a turn down.
  if (!mayPlayCardsAtAll(state, playerIndex)) return false;

  switch (fromHidden ? "Reaction" : timingTierOf(card)) {
    case "Reaction":
      // Every window, including a closed Chain — the new item resolves before
      // what's already there (161.1.a), which the LIFO chain gives for free.
      return true;
    case "Action":
      // Any Open State, Showdown or not.
      return state.chainOpen;
    case "Default":
      // Open State, and outside Showdowns.
      return state.chainOpen && state.turnState === "Neutral";
  }
}

/**
 * May `playerIndex` play a Unit onto `battlefieldId` right now?
 *
 * Rule 813: "Playing Units with Reaction still has the inherent restrictions of
 * playing Units without Reaction. It can only be played to the controlling
 * player's base or a battlefield they control." Outside a Neutral Open state the
 * only way to be playing a Unit at all is via Action/Reaction, so that's exactly
 * where the restriction bites — and it's what stops a Reaction Unit from being
 * dropped onto a battlefield to open a brand-new Showdown inside an existing one.
 *
 * Shared by `validate-play-card` and `legal-actions` on purpose. When only the
 * validator knew this rule, enumeration offered a reinforce destination the
 * validator then refused, and the AI — which trusts `legalActions` and calls the
 * executor directly — threw on it.
 */
export function mayPlayUnitToBattlefield(state: GameState, playerIndex: 0 | 1, battlefieldId: string): boolean {
  // Mageseeker Warden bars every battlefield destination, in every turn state —
  // composed WITH rule 813's own restriction below rather than replacing it, so
  // both have to allow a destination for it to be offered.
  if (!mayPlayUnitToBattlefieldUnderRestrictions(state, playerIndex)) return false;
  if (state.turnState === "Neutral") return true;
  const destination = state.battlefields.find((bf) => bf.id === battlefieldId);
  return destination === undefined || destination.controllerId === state.players[playerIndex].id;
}

/** Why `card` can't be played right now, purely on timing — null when it can.
 *  Shared with the UI so the board's explanation and the validator's rejection
 *  can't drift apart (the same reason unplayableReason re-derives the engine's
 *  own gates rather than inventing messages). */
export function timingRejection(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  fromHidden = false,
): string | null {
  if (mayPlayCardNow(state, playerIndex, card, fromHidden)) return null;

  if (playerIndex !== actingPlayerIndex(state)) {
    if (!state.chainOpen) return "A spell is resolving and your opponent holds priority.";
    if (state.turnState === "Showdown") return "Your opponent holds Focus in this Showdown.";
    return "It is not your turn.";
  }
  const tier = timingTierOf(card);
  if (!state.chainOpen) {
    return `${card.name} needs [Reaction] to be played while a spell is on the chain.`;
  }
  // Open State, acting player, still rejected — so it's a Default-tier card in a
  // Showdown, the one remaining case.
  return tier === "Default"
    ? `${card.name} needs [Action] or [Reaction] to be played during a Showdown.`
    : `${card.name} can't be played right now.`;
}

/**
 * `[Accelerate]`'s additional cost — rule 805: "you may pay [1][C] as an
 * additional cost. If you do, I enter ready."
 *
 * The Power half is domain-restricted to the UNIT's own domain, not to its
 * printed Power pip: "if the unit has one or more domains, the Power portion of
 * the Accelerate cost can be paid only with a Power that matches one of the
 * domains of the unit" (805). That distinction is load-bearing for Lee Sin -
 * Centered, whose printed Power cost is 0 — so `powerDomain` is null there and
 * reading it would have made his Accelerate rainbow.
 *
 * **Simplification, named:** a card whose own Power pip is one domain while
 * Accelerate demands another would need two separate domain pools in a single
 * payment. Neither Accelerate card in this pool is like that (Jinx's pip and
 * domain are both Fury; Lee Sin has no pip), so the two are merged into one
 * domain here. Recorded in docs/rules-conformance.md.
 */
export const ACCELERATE_ENERGY = 1;
export const ACCELERATE_POWER = 1;

export function hasAccelerate(card: CardInstance): boolean {
  return card.kind === "Unit" && "Accelerate" in card.keywords;
}

/** The Power domain `[Accelerate]` must be paid in, or null for a unit with no
 *  domain at all (805: then it is rainbow). */
export function acceleratePowerDomain(card: CardInstance): Domain | null {
  const domains = card.domains ?? [];
  return domains.length > 0 ? lowestOrdinalDomain(domains) : null;
}
