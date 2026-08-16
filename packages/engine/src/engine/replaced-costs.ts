import type { GameState, GrantedReplacedCostPlay, PlayerState } from "../model/game-state.js";
import type { CardInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import { legionActive } from "./effect-helpers.js";

/**
 * "You may play me for [Cost]" — rule **356.1.a**, read against `-raw`:
 *
 * > "If an ability or instruction allows you to play a card 'for [Cost]',
 * > replace the card's Base Costs with [Cost]."
 *
 * **This is the sibling of `ignoresBaseCost`, not of a discount**, and that is
 * the whole design. 356.1.a and 356.1.b sit in the same step of Determine Total
 * Cost: one sets the Base Costs to zero, the other sets them to something else.
 * The engine already models the first as a flag that swaps the base before
 * `modifiedEnergyCost` sees it; this models the second the same way, by swapping
 * the base the three cost sites price FROM.
 *
 * A discount would have been the wrong shape and cheaper-than-printed the bug it
 * produces: UNL-025 Undying Legion's replacement is DEARER than what it prints
 * (3 Energy printed, `[3][Fury]` from the trash), so anything built out of
 * subtraction cannot express it at all.
 *
 * **Base cost MODIFICATIONS still apply on top**, because 356.1's own preamble is
 * "Apply base cost modifications in any order" and the replacement is one of
 * them. So the replaced Energy is handed to `modifiedEnergyCost` exactly where
 * `card.energyCost` used to go, rather than bypassing it — a `[Legion]` discount
 * or Void Drone's play-from-elsewhere reduction reaches a replaced cost the same
 * way it reaches a printed one.
 *
 * **"In any order" cannot be read literally here, and the choice is recorded
 * rather than hidden.** Replacement and subtraction do not commute: replacing
 * then reducing leaves the reduction worth something, while reducing then
 * replacing throws the reduction away. This module replaces FIRST. **No card in
 * the pool reaches the case** — neither card below is touched by any discount
 * currently written — so the choice is unobservable today and is deliberately
 * NOT pinned by a test, which would only assert an interaction nobody can reach.
 * It is filed as an open reading in docs/rules-conformance.md's Unverified
 * section; revisit when a third card makes it reachable.
 *
 * **Rule 829 `[Flow]` IS implemented here now, as of 2026-08-16**, and this
 * paragraph used to say the opposite. It read: "No card in any of the four sets
 * prints `[Flow]` — measured, all four JSONs have zero hits — so the keyword is
 * deliberately not implemented here." Both halves were true when written and the
 * measurement expired the day Vendetta landed: **15 VEN spells print it.**
 *
 * The note was right about the shape, which is why the keyword cost one function
 * and no new machinery: `[Flow]` is the keyword form of this same sentence ("You
 * may play this from your trash for its flow cost. Then banish it."), and
 * 829.1.c.1 says the same thing about replacement that 356.1.a does. See
 * `flowReplacedCostFor` below, which derives the permission from the cost printed
 * on each card instead of tabulating one row per spell.
 *
 * **Its warning about the BANISH clause still stands and is now load-bearing in
 * the other direction.** "Adding it would silently make a Spell's recursion
 * one-shot" is exactly right: the banish belongs to `[Flow]` alone and must not
 * be borrowed by the two printed replaced costs below, neither of which prints
 * the keyword. `execute-play-card` therefore gates the banish on the card having
 * a `flowCost`, not on a replaced cost having been paid.
 *
 * 829.1.b.2 is worth keeping in view anyway, since it is the ruling for what a
 * replaced cost does NOT change: "Playing a spell for its Flow cost does not
 * change the timing at which it can be played, nor any permissions for the spell
 * aside from the zone from which it can be played." So a replaced cost buys a
 * PRICE and (where the card says so) a ZONE, and nothing else — the timing
 * checks, the targeting and the play restrictions all stay exactly as they were.
 */
export interface ReplacedCost {
  /** Replaces `card.energyCost` as the base the cost sites price from. */
  energyCost: number;
  /** Replaces `card.powerCost`. */
  powerCost: number;
  /**
   * Replaces `card.powerDomain`. `null` is the RAINBOW pip — the same `null`
   * `hidden.ts`'s `RAINBOW` uses and that `computeEffectiveCost` and
   * `computeAutoPayment` already read as "any domain", so a `[rainbow]` price
   * needs no new payment machinery.
   */
  powerDomain: Domain | null;
  /**
   * Which zone this permission lets the card be played FROM — and, just as
   * importantly, the zone the card must BE in for the permission to exist.
   *
   * **Rule 366 is the authority, and it works one of these two cards by name.**
   * 366.1: "Passive Abilities of cards in zones that are outside of the Board
   * will self-describe their context", with the worked example
   *
   * > "Undying Legion has a passive ability that reads '[Legion][>] You may play
   * > me from your trash for [3][C].' That passive ability only applies when
   * > Undying Legion is in the trash."
   *
   * So the zone is not a convenience for the enumerator — it is a condition on
   * the ability existing at all, which is why `replacedCostFor` checks zone
   * membership itself rather than leaving it to its three callers.
   *
   * 366.2.a covers the other half and is why a `"hand"` entry is legitimate
   * rather than a special case: "Passive Abilities can alter the costs of cards
   * as they are played. These apply at all times in any zone from which the card
   * with the ability can be played." Jhin's permission is a cost alteration in
   * the zone he is ordinarily played from, so 419.3.a needs no exception for
   * him; `"trash"` is the one that also buys a zone, and is what
   * `mayPlayFromTrash` consults so the enumerator, the validator and the
   * executor all agree the card is reachable at all.
   */
  zone: "hand" | "trash";
}

/**
 * A card whose own printed text grants the replacement, with the condition it
 * prints.
 *
 * Keyed by defId and re-derived from state on every ask, which is what keeps
 * these two cards off `PlayerState` entirely. The handoff that scoped this block
 * predicted all four cards would need a new state field; two of them do not,
 * because "if you've spent [4] or more to play a spell this turn" and
 * "[Legion][>]" are both questions about state that is ALREADY recorded. A field
 * per printed condition would have been a field that can go stale.
 */
interface PrintedReplacedCost extends ReplacedCost {
  /** Asked at COST time — the card has not been played yet. */
  available: (state: GameState, playerIndex: 0 | 1) => boolean;
}

/**
 * UNL-089 Jhin - Meticulous Killer — "If you've spent [4] or more to play a
 * spell this turn, you may play me for :rb_rune_mind:."
 *
 * The condition needed NO new mechanism: `maxSpellEnergySpentThisTurn` was added
 * for UNL-004 Prepared Neophyte, and its own doc comment on `PlayerState` names
 * Jhin as the second card printing the sentence verbatim. A MAXIMUM over single
 * spells rather than a running total, which is that field's whole point — two
 * 2-Energy spells are not a 4-Energy one.
 *
 * `:rb_rune_mind:` is one POWER pip of Mind and no Energy, on the convention the
 * card loader's `EQUIP_COST_PATTERN` already reads: `:rb_energy_N:` is Energy,
 * `:rb_rune_X:` is a Power pip of domain X. So this is 4 Energy becoming 0
 * Energy + 1 Mind — a replacement that is cheaper in Energy and dearer in Power,
 * and expressible only as a replacement.
 *
 * Zone `"hand"`: he says "play me", not "play me from your trash", so this buys
 * a price and nothing else (829.1.b.2's ruling on what a replaced cost leaves
 * alone).
 */
const JHIN_METICULOUS_KILLER = "UNL-089";
const JHIN_SPELL_ENERGY_THRESHOLD = 4;

/**
 * UNL-025 Undying Legion — "[Legion][>] You may play me from your trash for
 * :rb_energy_3::rb_rune_fury:."
 *
 * **The replacement is DEARER than the print**, and that is the trap this card
 * exists to catch: it prints 3 Energy and 0 Power, and the trash price is 3
 * Energy plus a Fury pip. A "play from trash at a discount" mechanism would make
 * it cheaper than printed and strictly better than casting it from hand, which
 * is the opposite of the card. The test asserts the pip is really owed.
 *
 * `[Legion]` is rule **812** — 812.1.b.1, "If you have played another card this
 * turn, this card gains [Text]" — and `[>]` is the dependent-keyword gate
 * (812.1.a's "[Legion][>] [Text]" format). Asked with `countingSelf: false`
 * because this is COST time: the card has not been played yet, so "another card"
 * is one card. `legionActive`'s own comment records that getting this wrong is
 * invisible — the effect simply happens a turn too eagerly.
 */
const UNDYING_LEGION = "UNL-025";
const UNDYING_LEGION_TRASH_ENERGY = 3;

const PRINTED_REPLACED_COSTS: Record<string, PrintedReplacedCost> = {
  [JHIN_METICULOUS_KILLER]: {
    energyCost: 0,
    powerCost: 1,
    powerDomain: "Mind",
    zone: "hand",
    available: (state, playerIndex) =>
      state.players[playerIndex].maxSpellEnergySpentThisTurn >= JHIN_SPELL_ENERGY_THRESHOLD,
  },
  [UNDYING_LEGION]: {
    energyCost: UNDYING_LEGION_TRASH_ENERGY,
    powerCost: 1,
    powerDomain: "Fury",
    zone: "trash",
    available: (state, playerIndex) => legionActive(state, playerIndex, false),
  },
};

/** Every card this module prices. Coverage reads it so the two printed cards
 *  report as implemented from here rather than from a card-effects entry they
 *  do not have — neither card has an EFFECT, only a price. */
export function replacedCostDefIds(): string[] {
  return Object.keys(PRINTED_REPLACED_COSTS);
}

/**
 * The replaced cost `playerIndex` may play `card` for right now, or `null`.
 *
 * **The one predicate all three cost sites ask**, which is the point of it. The
 * handoff for this block recorded that there are THREE pricing sites and not two
 * — `legal-actions`, `validate-play-card` and `execute-play-card`, the last of
 * which re-prices from the raw cost to decide floating spend — and that missing
 * the third shipped a real bug this month. A single function they all call is
 * what keeps "was this offered", "was this legal" and "what was actually spent"
 * from coming apart.
 *
 * Zone membership is checked HERE rather than by the callers, so a permission
 * for a card that is not in the zone it names can never be handed out: a
 * `"trash"` entry answers only for a card actually in that trash.
 */
/**
 * `[Flow]`'s permission (829), derived from the card's own printed cost.
 *
 * **Derived, not tabulated, and that is the whole reason the keyword lands in one
 * change**: 829.1.c prints the cost on the card, `card-loader.parseFlowCost`
 * reads it, and every Vendetta spell carrying the keyword is served with no
 * per-card row — the same payoff `parseEquipCost` buys for 25 Equipment.
 *
 * It is exactly a replaced cost and needs no new machinery: 829.1.c.1 makes the
 * Flow cost "an alternate cost that REPLACES the base cost", and 829.1.b names
 * the trash as the zone, which is `ReplacedCost`'s two fields. Undying Legion
 * has been the same shape for two sets.
 *
 * 829.1.b.2 is why nothing else is touched here: "Playing a spell for its Flow
 * cost does not change the timing at which it can be played, nor any permissions
 * for the spell aside from the ZONE from which it can be played." So a
 * `[Reaction]` Flow spell is still a Reaction and an ordinary one is still
 * sorcery-speed; the zone is the only permission this grants.
 *
 * Zone membership is checked by the caller for the printed table and here for
 * this one, in the same place and for the same reason: a permission for a card
 * that is not in the trash can never be handed out.
 */
function flowReplacedCostFor(state: GameState, playerIndex: 0 | 1, card: CardInstance): ReplacedCost | null {
  const flow = card.kind === "Spell" ? card.flowCost : undefined;
  if (flow === undefined) return null;
  if (!state.players[playerIndex].trash.some((c) => c.instanceId === card.instanceId)) return null;
  return { energyCost: flow.energy, powerCost: flow.powerCost, powerDomain: flow.powerDomain, zone: "trash" };
}

export function replacedCostFor(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
): ReplacedCost | null {
  // A GRANTED permission is asked first, and wins if both somehow exist: it was
  // bought by something that happened this turn, while a printed one is always
  // available and so loses nothing by being deferred to. No card in this pool
  // has both, and the order is stated rather than incidental.
  const granted = grantedReplacedCostFor(state, playerIndex, card);
  if (granted !== null) return granted;

  const flow = flowReplacedCostFor(state, playerIndex, card);
  if (flow !== null) return flow;

  const printed = PRINTED_REPLACED_COSTS[card.defId];
  if (printed === undefined) return null;
  if (!printed.available(state, playerIndex)) return null;
  if (printed.zone === "trash" && !state.players[playerIndex].trash.some((c) => c.instanceId === card.instanceId)) {
    return null;
  }
  if (printed.zone === "hand" && !state.players[playerIndex].hand.some((c) => c.instanceId === card.instanceId)) {
    return null;
  }
  const { energyCost, powerCost, powerDomain, zone } = printed;
  return { energyCost, powerCost, powerDomain, zone };
}

/**
 * The GRANTED half — a permission `playerIndex` was handed for this specific
 * card instance, from `PlayerState.replacedCostPlays`.
 *
 * **Zone membership is re-checked here, exactly as the printed half re-checks
 * it**, and it is what makes granting safe at a moment when the card is not yet
 * in the trash: UNL-186 Death from Below grants the permission during its own
 * resolution, and a Spell does not reach its owner's trash until
 * `execute-play-card` finishes. So the grant is recorded eagerly and this
 * answers `null` until the card actually lands.
 *
 * The trash searched is the HOLDER's own. A grant naming somebody else's trash
 * was built and then removed as unreachable — see `GrantedReplacedCostPlay`.
 */
function grantedReplacedCostFor(state: GameState, playerIndex: 0 | 1, card: CardInstance): ReplacedCost | null {
  const grant = state.players[playerIndex].replacedCostPlays.find((g) => g.instanceId === card.instanceId);
  if (grant === undefined) return null;
  if (!state.players[playerIndex].trash.some((c) => c.instanceId === card.instanceId)) return null;
  return {
    energyCost: grant.energyCost,
    powerCost: grant.powerCost,
    powerDomain: grant.powerDomain,
    zone: "trash",
  };
}

/**
 * Record a granted "you may play THIS for [Cost]" permission.
 *
 * Additive and duplicate-tolerant by instance: a second grant for a card that
 * already has one replaces nothing, because the two would be identical — the
 * price comes from the granting card's printed text, and the same card granting
 * twice grants the same price. Filtering first keeps the list from growing
 * without bound across a long turn.
 */
export function grantReplacedCostPlay(
  state: GameState,
  playerIndex: 0 | 1,
  grant: GrantedReplacedCostPlay,
): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const holder = players[playerIndex];
  players[playerIndex] = {
    ...holder,
    replacedCostPlays: [...holder.replacedCostPlays.filter((g) => g.instanceId !== grant.instanceId), grant],
  };
  return { ...state, players };
}

/**
 * Does `playerIndex` hold a GRANTED permission for this exact card instance?
 *
 * The question `execute-play-card` asks to decide whether a play SPENT one —
 * 419.3.b's window is one play, and a permission that survived its own use would
 * let a single [rainbow] buy Death from Below out of the trash again every turn
 * until the game ended.
 *
 * Deliberately separate from `replacedCostFor`, which answers "what does this
 * cost": reading a price must never consume a permission, or the enumerator
 * would burn one every time it priced a card. The same split `mayPlayFromTrash`
 * keeps from the charge it does not spend.
 */
export function holdsGrantedReplacedCost(state: GameState, playerIndex: 0 | 1, instanceId: string): boolean {
  return state.players[playerIndex].replacedCostPlays.some((g) => g.instanceId === instanceId);
}
