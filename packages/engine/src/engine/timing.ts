import type { GameState } from "../model/game-state.js";
import { mayPlayUnitAt } from "./battlefield-continuous.js";
import type { Domain } from "../model/domain.js";
import { lowestOrdinalDomain } from "../model/domain.js";
import type { CardInstance } from "../model/card.js";
import {
  controlsEndlessRiches,
  mayPlaySpells,
  mayPlaySpellNamed,
  mayPlayCardsAtAll,
  mayPlayUnitToBattlefieldUnderRestrictions,
} from "./board-restrictions.js";
import { replacedCostFor } from "./replaced-costs.js";

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
  // 320.1 says Priority and Focus "are not passed or awarded" — so whoever
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
 *     prior cases, may also be played during all forms of Closed State" (159.2.b.2),
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
/**
 * `[Ambush]` — **822.1.b**: "I may be played to a battlefield where you control
 * Units" and "I have [Reaction] AS LONG AS I'm being played to a battlefield
 * where you control Units."
 *
 * # Why this takes a destination
 *
 * The permission is CONDITIONAL ON WHERE THE UNIT IS GOING, which is the whole
 * difficulty: `timingTierOf` answers per card, and the tier here is Reaction at
 * one battlefield and Default at another on the same board, in the same instant.
 * That is the same shape as a modal card whose targeting depends on the mode.
 *
 * The PLACEMENT half of 822.1.b needs nothing new — the ordinary reinforce rule
 * already lets a Unit be played to a battlefield where its controller has units.
 * Measured, not assumed: `legal-actions`' reinforce loop gates on `hasPresence`,
 * which is that sentence. So Ambush's only unimplemented half is the TIMING.
 *
 * # "where you control Units", not "a battlefield you hold"
 *
 * `coverage.ts` described this keyword as "can't yet be played as a [Reaction] to
 * a battlefield you hold", and holding is a different question — a battlefield can
 * be held by a player with no units standing on it right now, and units can stand
 * at a battlefield its owner does not hold. 822.1.b says units, so this asks
 * about units.
 *
 * 822.3 puts the check at announce: "if there are no units at the location chosen
 * before Finalization completes, then it is no longer a valid location by
 * Ambush's reasoning". Both callers ask at announce, so that is satisfied by
 * construction rather than by a re-check.
 */
export function hasAmbush(card: CardInstance): boolean {
  return card.kind === "Unit" && "Ambush" in card.keywords;
}

/** Does `[Ambush]` grant this card Reaction timing INTO `battlefieldId`? */
export function ambushReactionAt(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  battlefieldId: string,
): boolean {
  if (!hasAmbush(card)) return false;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (bf === undefined) return false;
  return (bf.units[state.players[playerIndex].id] ?? []).length > 0;
}

/** Is there ANY battlefield Ambush would let this card be played to right now?
 *  Used by the enumerator, which gates a card on timing before it knows where it
 *  is going — without this an Ambush unit is dropped whole in a Showdown. */
export function ambushHasAnyDestination(state: GameState, playerIndex: 0 | 1, card: CardInstance): boolean {
  return hasAmbush(card) && state.battlefields.some((bf) => ambushReactionAt(state, playerIndex, card, bf.id));
}
export function mayPlayCardNow(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  /** True when the card is being played FROM a facedown state. Rule 811: a
   *  hidden card "gains [Reaction] while facedown or played from facedown, and
   *  may be played any time a card with Reaction may be played as a result" —
   *  whatever its printed timing says. */
  fromHidden = false,
  /** Where the Unit is being played, when that is known. `[Ambush]` grants
   *  Reaction timing only INTO a battlefield where its controller has units
   *  (822.1.b), so the tier cannot be answered without it. Omitted by every
   *  caller that is asking about the card rather than about one destination. */
  destinationBattlefieldId?: string,
): boolean {
  if (playerIndex !== actingPlayerIndex(state)) return false;
  // Brynhir Thundersong's lock. Before the tier switch, because it bars EVERY
  // card however it is timed — including a [Reaction], which is the whole point
  // of a card that shuts a turn down.
  if (!mayPlayCardsAtAll(state, playerIndex)) return false;
  // Lilting Lullaby's narrower ban. Beside Brynhir's rather than folded into it,
  // and for the same reason it is placed here: it bars a SPELL however it is
  // timed, including a [Reaction], which is the point of shutting spells down.
  if (card.kind === "Spell" && !mayPlaySpells(state, playerIndex)) return false;
  // Fallen Feline's named ban. Beside the two above and before the tier switch
  // for the same reason they are: it bars a spell HOWEVER it is timed, and a
  // [Reaction] slipping past a ban aimed at it would be the whole card's failure
  // mode. Continuous rather than a this-turn flag — see `mayPlaySpellNamed`.
  //
  // By NAME (132.1), so it catches every copy in the deck and every printing.
  if (card.kind === "Spell" && !mayPlaySpellNamed(state, playerIndex, card.name)) return false;

  const ambushed =
    destinationBattlefieldId !== undefined && ambushReactionAt(state, playerIndex, card, destinationBattlefieldId);
  switch (fromHidden || ambushed ? "Reaction" : timingTierOf(card)) {
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
/**
 * Perched Grimwyrm — "Play me ONLY to a battlefield you conquered this turn.
 * (You can't play me anywhere else.)"
 *
 * **A RESTRICTION, not a grant**, which is what separates it from everything in
 * `PLACEMENT_GRANTS`: those WIDEN where a card may go, and this narrows it to
 * one set — and the parenthetical makes the narrowing total, so BASE is refused
 * too. That is why it cannot live in that table, whose default answer for a card
 * with no entry is "the ordinary rules apply".
 *
 * Read from `conqueredBattlefieldsThisTurn` rather than
 * `scoredBattlefieldsThisTurn`: the latter records the once-per-turn SCORING
 * lockout and is also written by HOLDING, which is not conquering.
 */
const PLAY_ONLY_AT_CONQUERED = new Set(["SFD-015"]);

/** May this card be played to BASE at all? False only for a card whose text
 *  forbids everywhere but a named battlefield. Asked by the enumerator and the
 *  validator alike, so a base play cannot be offered and then refused. */
export function mayPlayUnitToBase(defId: string): boolean {
  return !PLAY_ONLY_AT_CONQUERED.has(defId);
}

/** For coverage.ts — Perched Grimwyrm's whole printed text is this restriction. */
export function playRestrictionDefIds(): string[] {
  return [...PLAY_ONLY_AT_CONQUERED];
}

/**
 * Is this card one `playerIndex` may play from their trash ON A LAST RITES
 * CHARGE — the permission that is SPENT by using it?
 *
 * Last Rites' permission (`trashUnitPlaysThisTurn`), and the one predicate the
 * validator, the enumerator and the executor all ask — the split
 * `freeGearPlayApplies` keeps for the same reason: three sites that must agree
 * on whether a play is legal, and a fourth copy of the rule is how they stop
 * agreeing. Reading it does NOT spend it; `execute-play-card` does that.
 *
 * **UNITS only**, and from the acting player's OWN trash: the card says "a unit
 * from your trash". A Spell or Gear sitting in the same trash is not offered.
 *
 * 419.3.a's default is that a player plays only from hand or Chosen Champion
 * zone, so this is the exception that needs a permission behind it — which is
 * why it asks the counter rather than merely asking whether the card is in a
 * trash.
 *
 * **Named for the CHARGE, not for the zone**, since a second trash permission
 * now exists that is not a charge and must not spend one. `mayPlayFromTrash`
 * below is the zone question; this is "and is a charge what pays for it".
 */
export function mayPlayFromTrashOnCharge(state: GameState, playerIndex: 0 | 1, card: CardInstance): boolean {
  if (card.kind !== "Unit") return false;
  const player = state.players[playerIndex]!;
  return player.trashUnitPlaysThisTurn > 0 && player.trash.some((c) => c.instanceId === card.instanceId);
}

/**
 * May `playerIndex` play this card from a trash at all, by ANY permission?
 *
 * The ZONE question — 419.3.a's "hand or Chosen Champion zone only" exception —
 * and the one the enumerator and validator ask, because they care whether the
 * card is reachable rather than which permission reached it.
 *
 * THREE permissions answer it and they are deliberately not merged:
 *
 *  - **A Last Rites charge** (`mayPlayFromTrashOnCharge`), Units only, at the
 *    PRINTED price, and consumed by being used.
 *  - **A card's own "play me from your trash for [Cost]"** (356.1.a), which is
 *    not consumed, is not Units-only, and carries a REPLACED price. UNL-025
 *    Undying Legion is the first.
 *  - **Endless Riches's "you may play cards from your trash"** (VEN-022), which
 *    is none of those things: continuous rather than banked, every card kind
 *    rather than Units, and at the PRINTED price rather than a replaced one. It
 *    is the first permission here that is a property of the BOARD instead of a
 *    property of the card or of a counter, which is why it takes no argument
 *    about the card at all.
 *
 * The executor keeps them apart for a reason worth stating: a player holding a
 * banked Last Rites charge who plays Undying Legion on ITS OWN permission must
 * not have the charge burnt. Both predicates can be true at once, and the
 * action's `replacedCostPaid` is what says which one the player chose. Endless
 * Riches makes that three-way, and it is settled the same way — see
 * `usedTrashCharge` in `execute-play-card.ts`.
 */
/**
 * May this trash play be made at the card's PRINTED price?
 *
 * The question `legal-actions` asks as `printedPriceAvailable` and
 * `validate-play-card` asks to refuse the play it declines to offer — and it is
 * NOT the same question as "may it be played from the trash at all". A card
 * reachable only through its own "play me from your trash for [Cost]" (UNL-025
 * Undying Legion) must not be playable there for the printed price it prints for
 * a play from HAND, which would drop the pip its trash price adds.
 *
 * **This used to be `mayPlayFromTrashOnCharge` read directly at both sites, and
 * that stopped being the same question when Endless Riches landed.** Its
 * permission is at the printed price and is not a charge, so a card in its
 * controller's trash was permitted by `mayPlayFromTrash`, offered by the
 * enumerator with `printedPriceAvailable: false`, and then priced out of every
 * variant — the enumerator dropped it silently and nothing anywhere was wrong.
 * That is this codebase's offered-then-refused class with the two halves swapped:
 * permitted, then unpriceable.
 *
 * One predicate, asked by both, so the next permission is added in one place.
 */
export function mayPlayFromTrashAtPrintedPrice(state: GameState, playerIndex: 0 | 1, card: CardInstance): boolean {
  if (mayPlayFromTrashOnCharge(state, playerIndex, card)) return true;
  return controlsEndlessRiches(state, playerIndex) && state.players[playerIndex].trash.some((c) => c.instanceId === card.instanceId);
}

export function mayPlayFromTrash(state: GameState, playerIndex: 0 | 1, card: CardInstance): boolean {
  if (mayPlayFromTrashAtPrintedPrice(state, playerIndex, card)) return true;
  return replacedCostFor(state, playerIndex, card)?.zone === "trash";
}

export function mayPlayUnitToBattlefield(
  state: GameState,
  playerIndex: 0 | 1,
  battlefieldId: string,
  /** The card being played, for the card-keyed restrictions above. Optional so
   *  callers that ask the board-wide question alone are unchanged. */
  defId?: string,
  /** The card instance, when `[Ambush]` should widen the destinations 813
   *  narrows. Separate from `defId` because the keyword lives on the INSTANCE
   *  (it can be granted), and omitted by callers asking the board-wide
   *  question. */
  ambushCard?: CardInstance,
): boolean {
  // Perched Grimwyrm's "only". Checked FIRST because it is the narrowest gate:
  // it refuses destinations the ordinary rules would allow, and composing it
  // with the rest the same way every other gate here composes keeps "every gate
  // must allow it" the single rule.
  if (defId !== undefined && PLAY_ONLY_AT_CONQUERED.has(defId)) {
    if (!state.players[playerIndex].conqueredBattlefieldsThisTurn.includes(battlefieldId)) return false;
  }
  // Mageseeker Warden bars every battlefield destination, in every turn state —
  // composed WITH rule 813's own restriction below rather than replacing it, so
  // both have to allow a destination for it to be offered.
  if (!mayPlayUnitToBattlefieldUnderRestrictions(state, playerIndex)) return false;
  // Rockfall Path bars THIS destination, for both players and in every turn
  // state. Composed the same way and for the same reason: every gate has to
  // allow a destination for it to be offered.
  if (!mayPlayUnitAt(state, battlefieldId)) return false;
  if (state.turnState === "Neutral") return true;
  // **822.1.c: `[Ambush]` "adds options to locations that are valid for a Unit to
  // be played to".** 813 narrows Showdown destinations to battlefields you
  // CONTROL; Ambush widens them to battlefields where you have UNITS, which is a
  // different and sometimes larger set — a battlefield can be garrisoned by a
  // player who does not control it, which is exactly the position an ambush is
  // launched from.
  //
  // Without this the keyword was unreachable: the card gained Reaction timing and
  // then had nowhere legal to go.
  if (ambushCard !== undefined && ambushReactionAt(state, playerIndex, ambushCard, battlefieldId)) return true;
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
  /** The destination the action names, so `[Ambush]` can be judged against it —
   *  the same argument `mayPlayCardNow` takes, passed through for the same
   *  reason. Omitting it here while the enumerator passes it is precisely how an
   *  offered-then-refused pair is born. */
  destinationBattlefieldId?: string,
): string | null {
  if (mayPlayCardNow(state, playerIndex, card, fromHidden, destinationBattlefieldId)) return null;

  if (playerIndex !== actingPlayerIndex(state)) {
    if (!state.chainOpen) return "A spell is resolving and your opponent holds priority.";
    if (state.turnState === "Showdown") return "Your opponent holds Focus in this Showdown.";
    return "It is not your turn.";
  }
  // The two SPELL bans, AFTER the priority branch above and before the tier
  // branches below. The order is the order `mayPlayCardNow` asks in, which is
  // what keeps the message describing the reason it actually stopped on: acting
  // out of turn outranks a ban, and a ban outranks a complaint about timing
  // tiers. Without these the message falls through to the tier text, which names
  // [Action]/[Reaction] at a card that already has them and sends the reader
  // looking in entirely the wrong place.
  if (card.kind === "Spell" && !mayPlaySpells(state, playerIndex)) {
    return "You can't play spells this turn.";
  }
  if (card.kind === "Spell" && !mayPlaySpellNamed(state, playerIndex, card.name)) {
    return `${card.name} was named by an enemy Fallen Feline at a battlefield.`;
  }

  const tier = timingTierOf(card);
  if (!state.chainOpen) {
    return `${card.name} needs [Reaction] to be played while a spell is on the chain.`;
  }
  // Open State, acting player, still rejected — so it's a Default-tier card in a
  // Showdown, the one remaining case.
  // An Ambush card refused at a SPECIFIC destination gets the reason that
  // actually applies — "you have no units there" — rather than the generic tier
  // complaint, which would be misleading for a card that plainly prints a
  // Showdown permission.
  if (hasAmbush(card) && destinationBattlefieldId !== undefined) {
    return `${card.name} can only [Ambush] to a battlefield where you have units.`;
  }
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

/** Rek'Sai - Breacher — "Friendly units played from anywhere other than a
 *  player's hand have [Accelerate]." */
const REKSAI_BREACHER = "SFD-029";

/**
 * Is Rek'Sai - Breacher granting `[Accelerate]` to a unit being played from a
 * non-hand zone?
 *
 * **"a PLAYER's hand", not "your hand"** — the card says either player's, which
 * makes no difference at this seat count but is what it prints, so nothing here
 * compares the hand's owner.
 *
 * Reachable only through the Champion Zone today, and that is a fact about the
 * engine rather than about the card: the other non-hand play paths either
 * ignore the whole cost (from-Hidden, 811) or bypass pricing entirely
 * (`playCardIgnoringCost`), and `[Accelerate]` is an additional COST — there is
 * nothing to add it to when the base is being ignored. See
 * `PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS` in cost-modifiers.ts, which records the
 * same measurement for the two cards that discount off the same condition.
 */
function accelerateGrantedTo(state: GameState, playerIndex: 0 | 1, card: CardInstance, playedFromHand: boolean): boolean {
  if (playedFromHand || card.kind !== "Unit") return false;
  const owner = state.players[playerIndex];
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  return units.some((u) => u.defId === REKSAI_BREACHER);
}

/**
 * Does this card have `[Accelerate]` right now — printed, or granted?
 *
 * `state`/`playerIndex`/`playedFromHand` are optional so the many callers that
 * only ever ask about a printed keyword are unchanged. Omitting them asks the
 * printed question, which is what every caller before Rek'Sai meant.
 */
export function hasAccelerate(
  card: CardInstance,
  state?: GameState,
  playerIndex?: 0 | 1,
  playedFromHand = true,
): boolean {
  if (card.kind !== "Unit") return false;
  if ("Accelerate" in card.keywords) return true;
  return state !== undefined && playerIndex !== undefined && accelerateGrantedTo(state, playerIndex, card, playedFromHand);
}

/** For coverage.ts — Rek'Sai's grant is his third clause; his `[Accelerate]` and
 *  `[Assault]` are the loader's. */
export function accelerateGrantDefIds(): string[] {
  return [REKSAI_BREACHER];
}

/** The Power domain `[Accelerate]` must be paid in, or null for a unit with no
 *  domain at all (805: then it is rainbow). */
export function acceleratePowerDomain(card: CardInstance): Domain | null {
  const domains = card.domains ?? [];
  return domains.length > 0 ? lowestOrdinalDomain(domains) : null;
}
