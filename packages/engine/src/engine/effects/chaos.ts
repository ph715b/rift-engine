import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellEffect,
  DeathWatchEffect,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  channelRunesExhausted,
  dealDamage,
  discardCards,
  discardThenDraw,
  drawCards,
  forceMoveToBattlefield,
  giveMightThisTurnToOwnUnit,
  grantTemporary,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  returnUnitToHand,
  swapUnitLocations,
  takeOneFromTopAndRecycleRest,
  takeControlOfUnit,
} from "../effect-helpers.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { killGear } from "../triggers.js";
import { playUnitToBase } from "../deploy.js";
import { playCardIgnoringCost } from "../play-free.js";
import { RAINBOW } from "../hidden.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";

/**
 * Card implementations for **Chaos** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Chaos. A test in
 * test/effect-registry.test.ts enforces it, so a card filed in the wrong place
 * fails the suite rather than being merged and forgotten.
 *
 * Cards with TWO domains (the champion signature spells) belong in
 * effects/signature.ts, and Legends in engine/legend-abilities.ts — every Legend
 * is dual-domain by definition, so splitting those by domain is meaningless.
 *
 * To add a card:
 *   1. Register it under its defId in `cardEffects` (Spell/Gear) or
 *      `unitTriggers` (Unit's on-play ability), matching the shapes in
 *      card-effects.ts / unit-triggers.ts.
 *   2. Cite the rule or the oracle implementation the behaviour comes from —
 *      "mirrors <the Java oracle>" is not a rules citation, see
 *      docs/rules-conformance.md on why this project distinguishes them.
 *   3. Add an engine test. A silently-inert card is indistinguishable from a
 *      working one in play, which is exactly how the current gap went unnoticed.
 *
 * Composition rejects duplicates, so registering a defId that some other file
 * already handles throws at import rather than silently shadowing it.
 */
export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-203": {
    // Possession — "Choose an enemy unit at a battlefield. Take control of it and
    // recall it."
    //
    // The pool's first change of a UNIT's controller. In this engine control IS
    // which player's list the unit sits in, so taking it and recalling it are one
    // operation — see `takeControlOfUnit`.
    //
    // "AT A BATTLEFIELD" is printed, so the default scope stands and a unit
    // sitting in the opponent's base is safe from it. At 8 Energy and 3 Power
    // that restriction is most of what keeps the card honest.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? takeControlOfUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "OGN-173": {
    // Ride The Wind — "[Action] Move a friendly unit and ready it."
    //
    // The destination rides on `destinationBattlefieldId`, which is only
    // enumerated for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS
    // (`cardMovesTarget`) — without that entry this resolver would always be
    // handed `undefined` and the card would be castable, inert and reported as
    // done. It is the third card in that set, after Charm and Showstopper.
    //
    // `scope: "anywhere"`, not the default: "a friendly unit" is 355.9.b's bare
    // noun, so a unit in base is a legal choice — and it is the main one, since
    // this is how the card deploys. Charm's "an ENEMY unit" is the contrast.
    //
    // MOVE then READY, printed order. It matters: moving into a contested
    // battlefield is what opens the Showdown, and arriving ready is what lets the
    // unit fight in it. Readying first and moving second reaches the same board,
    // but through a state the card does not describe.
    //
    // `forceMoveToBattlefield` rather than a list splice, because the move must
    // apply Contested and stage the Showdown — the same funnel Charm uses. Note
    // this is a MOVE, so it is exactly the kind [Ganking] and the move validator
    // constrain for a player-initiated MoveUnit; a spell moving a unit is not
    // subject to those, which is what makes the card worth casting.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: unitId, destinationBattlefieldId: destination } = event;
      if (!unitId || !destination) return state;
      return readyUnit(forceMoveToBattlefield(state, unitId, destination), unitId);
    },
  },
  "OGN-172": {
    // Rebuke — "[Action] Return a unit at a battlefield to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong: a unit sitting in base is out of
    // reach, which is the whole limit on the card. That distinction is
    // load-bearing here and this codebase has got it wrong before.
    //
    // No owner restriction — "a unit", not "an enemy unit". Bouncing your own is
    // a real line (it resets damage and saves a unit about to die), not an
    // oversight, and 355.9.b's bare noun carries no side.
    //
    // returnUnitToHand sends it to its OWNER's hand rather than the caster's,
    // and strips Buffs on the way (709, "if a Unit leaves play, remove all Buffs
    // from it") — both already handled there, which is why this is one call.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state),
  },
  "OGN-183": {
    // Stacked Deck — "Look at the top 3 cards of your Main Deck. Put 1 into your
    // hand and recycle the rest."
    //
    // A decision rather than a fan-out on the action, and that is forced rather
    // than chosen: legal-actions enumerates from PUBLIC state, and the top of a
    // deck is not public. Fanning it out would put the three card identities
    // into the action list, which the AI reads — handing it knowledge of its own
    // deck order that a human casting the same spell would only learn on
    // resolution.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // Nocturne's offer first, for the reason Reinforce's own resolve gives.
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 3)), {
        kind: "OGN-183-keep",
        playerIndex: ctx.casterIndex,
      }),
  },
  "OGN-180": {
    // Fading Memories — "Give a unit at a battlefield or a gear [Temporary]."
    //
    // The only card in the pool that targets across two kinds of permanent, which
    // is why `unitOrGear` exists as its own targeting kind and why the choice
    // rides on `targetPermanentInstanceId`: handing a gear to anything that reads
    // `targetUnitInstanceId` would be a type error waiting to be a runtime one.
    //
    // "A unit AT A BATTLEFIELD" — base units are out, unlike the many cards that
    // just say "a unit". Gear has no such restriction; it lives in base by
    // definition, and the clause plainly doesn't apply to it.
    //
    // Rule 816 does the rest: the thing dies at the start of ITS CONTROLLER's
    // next Beginning Phase, before scoring. Aimed at an enemy that is delayed
    // removal; aimed at your own it is a sacrifice you have a turn to use.
    targeting: { kind: "unitOrGear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? grantTemporary(state, event.targetPermanentInstanceId) : state,
  },
  "OGN-168": {
    // Fight or Flight — "[Hidden][Action] Move a unit from a battlefield to its
    // base." Either player's: the text names no owner, so this is removal as
    // often as it is rescue.
    //
    // recallUnitToBase, not relocateToBaseUnchanged: "move ... to its base" is a
    // Move, so the unit arrives exhausted and move triggers see it. Rule 454's
    // distinction — a Recall is NOT a Move — is why the two helpers exist, and
    // picking the wrong one here would silently make this card better than
    // printed.
    //
    // Scope is battlefield-only ("from a battlefield"), which also means that
    // played from Hidden the only legal targets are the ones standing at that
    // battlefield — enforced by legal-actions, not here.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
  },
  "OGN-179": {
    // Acceptable Losses — "[Action] Each player kills one of their gear."
    //
    // Cull the Weak (OGN-209, effects/order.ts) with gear in place of units, and
    // it is the same card structurally: no targeting spec, because the caster
    // does not pick two victims — each player picks their OWN, at resolution,
    // through engine/decisions.ts. Fanning the choice onto the action would also
    // commit it at cast time, and the opponent may respond on the chain in
    // between; "one of their gear" means the gear they still have when this
    // resolves.
    //
    // APNAP by rule 894 ("Turn Order is referenced to organize the sequence of
    // actions, starting with the current Turn Player"), which the FIFO decision
    // queue implements for free: the order the questions are parked in is the
    // order they are answered in.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-179-kill", state.activePlayerIndex),
  },
  "OGN-187": {
    // Whirlwind — "Starting with the next player, each player may return a unit
    // to its owner's hand."
    //
    // "Starting with the NEXT player" is an explicit override of rule 894's
    // default, which sequences simultaneous actions "starting with the current
    // Turn Player" — so this is the one card in the pool that runs APNAP
    // backwards, and the non-turn player answers first. That difference is the
    // whole reason the card names an order at all, and it is real in play: the
    // opponent has to commit before you do.
    //
    // Anchored on `activePlayerIndex` rather than the caster because "next" is
    // defined against TURN ORDER (175/179), not against whoever is resolving.
    // The two coincide here anyway — Whirlwind prints neither [Action] nor
    // [Reaction], so only the turn player can ever cast it.
    //
    // "A unit", not "a unit at a battlefield" — 355.9.b's bare noun, so a unit
    // sitting in either base is on offer too. Rebuke (above) prints the narrower
    // wording and gets the narrower reach; the difference between them is
    // printed, and this codebase has got that distinction wrong before.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-187-return", (1 - state.activePlayerIndex) as 0 | 1),
  },
  "OGN-201": {
    // Invert Timelines — "Each player discards their hand, then draws 4."
    //
    // Not a decision, and that is the point: discarding your WHOLE hand leaves
    // nothing to choose, so this goes straight through `discardCards` with a
    // count equal to the hand — which its own "a hand no bigger than `count` is
    // not a choice" branch takes without a prompt. Each player's discard is one
    // instruction, so `cardsDiscarded` fires once per player (Jinx - Rebel
    // readies once, not once per card).
    //
    // `discardThenDraw`, not `drawCards(discardCards(...))`, because "then" is
    // printed and the discard can queue work behind it: a discarded Flame
    // Chompers parks its own "you may play me" question, and a draw wrapped
    // around the discard would resolve BEFORE that question — handing the player
    // four fresh cards while the engine still owes them an answer about the old
    // hand. The hand size is read from the live state per player for the same
    // reason.
    //
    // Turn order per rule 894, matching every other "each player" card here.
    targeting: { kind: "none" },
    resolve: (state) => {
      const first = state.activePlayerIndex;
      return [first, (1 - first) as 0 | 1].reduce(
        (next, playerIndex) => discardThenDraw(next, playerIndex, next.players[playerIndex].hand.length, 4),
        state,
      );
    },
  },
  "OGN-198": {
    // The Harrowing — "Play a unit from your trash, ignoring its Energy cost.
    // (You must still pay its Power cost.)"
    //
    // Soulgorger's decision (OGN-196, in this file) with the "you may" removed,
    // and it shares its two helpers rather than carrying a second copy of them.
    //
    // MANDATORY, so no decline option. That is not merely a missing button: with
    // no payable unit in the trash the option list is EMPTY, and
    // `advanceDecisions` drops a question nobody can answer instead of
    // deadlocking on it. That is 422's do-as-much-as-you-can, and it is the
    // failure mode worth naming — a mandatory instruction that stranded its own
    // decision would hang the game rather than doing nothing visible. Tested
    // directly in test/cards-harrowing.test.ts.
    //
    // A single payable unit is likewise not a question: one option, so
    // `advanceDecisions` executes it without interrupting anyone. There is no
    // choice to make, which is exactly what "play a unit from your trash" with
    // one unit in the trash means.
    //
    // A DECISION rather than an `ownTrashCard` target for Soulgorger's second
    // reason, which survives the loss of the first: the Power is paid AT
    // RESOLUTION out of the pool as it stands then, and cannot ride on the
    // PlayCardAction's payment — that action paid the Harrowing's own 6+2.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-198-play", playerIndex: ctx.casterIndex }),
  },
};

/**
 * Parks one question of `kind` for each player, starting with `first`.
 *
 * `parkDecision` pushes onto the BACK of a FIFO queue, so the order they are
 * parked in IS the order they are answered in — which is the entire
 * implementation of both "each player, in turn order" (rule 894, Acceptable
 * Losses) and Whirlwind's "starting with the next player". Written once rather
 * than twice because the two differ only in where the sequence starts, and a
 * second hand-rolled copy is how the two would drift.
 */
function askInTurnOrder(state: GameState, kind: string, first: 0 | 1): GameState {
  return [first, (1 - first) as 0 | 1].reduce((next, playerIndex) => parkDecision(next, { kind, playerIndex }), state);
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-197": {
    // Teemo - Scout — "[Hidden] When you play me, give me +3 Might this turn."
    //
    // The keyword is the card: hidden for 1 Power, played later for 0 as a
    // 2-Energy 3-Might body that arrives swinging for 3 more. Nothing here
    // touches [Hidden] — engine/hidden.ts owns it.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unitId, 3),
  },
  "OGN-199": {
    // Tideturner — "[Hidden] When you play me, you may choose a unit you control
    // at ANOTHER location. Move me to its location and it to my original
    // location."
    //
    // A SWAP, not two moves: both units end up where the other was, so it cannot
    // be expressed as forceMoveToBattlefield twice (the first move would vacate
    // the square the second reads). swapUnitLocations does it in one step.
    //
    // "ANOTHER location" — base counts as a location, so a Tideturner played to
    // base can pull a unit home from a battlefield and take its place there,
    // which is the card's whole trick. The target spec is therefore "anywhere",
    // and the resolver rejects a same-location choice.
    //
    // "You MAY", and the choice rides on the action: enumeration offers the
    // no-target variant too, so declining is a real option.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, unitId, event) =>
      event.targetUnitInstanceId ? swapUnitLocations(state, ctx.casterIndex, unitId, event.targetUnitInstanceId) : state,
  },
  "OGN-192": {
    // Mindsplitter — "When you play me, choose an opponent. They reveal their
    // hand. Choose a card from it, and they discard that card."
    //
    // "Choose an opponent" is not a decision in a 2-player game: there is one,
    // and offering it would be theatre. The real choice is WHICH card, and it
    // belongs to the CASTER even though the cards are the opponent's — which is
    // why the decision's playerIndex is the caster and its options come from the
    // other player's hand.
    //
    // A decision rather than an action fan-out for the same reason Stacked Deck
    // needs one: enumeration is built from public state, and putting the
    // opponent's hand into the action list would leak it to the AI before the
    // reveal ever happened.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-192-discard", playerIndex: ctx.casterIndex }),
  },
  "OGN-165": {
    // Cemetery Attendant — "When you play me, return a unit from your trash to
    // your hand."
    //
    // The same shape Annie - Stubborn (OGS-010, engine/unit-triggers.ts) already
    // uses; the only difference is cardKind, since she returns a Spell and this
    // returns a Unit.
    //
    // The trash card is a real TARGET, not something the engine may pick for the
    // player: rule 355.9.a.4 makes "a unit from your trash" a target because a
    // trash is a Public zone. So this is an `ownTrashCard` spec that
    // legal-actions.ts fans out one candidate per eligible Unit, and WHICH unit
    // comes back stays the caster's decision.
    //
    // "YOUR trash" — ctx.casterIndex, never the opponent's; returnCardFromTrash
    // only ever looks in the named player's own trash. It also resets the
    // returned unit's damage / this-turn Might / Buff / exhausted, since the card
    // is re-entering hand and may be replayed fresh (rule 709 already took the
    // Buff off when it left play).
    //
    // The `?:` guard is load-bearing, not defensive noise: a Unit is playable
    // with its trigger's target OMITTED when the board offered no legal one
    // (validate-play-card.ts's targetOmissionAllowed). An empty trash, or a trash
    // holding only Spells, is exactly that case — the Attendant still deploys and
    // simply returns nothing, per the "do as much as you can, ignoring impossible
    // instructions" golden rule (~rule 100, see docs/rules-conformance.md).
    targeting: { kind: "ownTrashCard", cardKind: "Unit" },
    resolve: (state, ctx, _unitId, event) =>
      event.trashCardInstanceId ? returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId) : state,
  },
  "OGN-188": {
    // Zaunite Bouncer — "When you play me, return another unit at a battlefield
    // to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong — a unit at home is out of reach,
    // which is the limit on the card.
    //
    // No owner restriction ("another unit", not "an enemy unit"), so bouncing
    // your own is a legitimate line — it resets damage and rescues a unit about
    // to die, exactly as Rebuke's does.
    //
    // "ANOTHER" needs no check here, for the reason First Mate's entry in
    // engine/unit-triggers.ts already records: legal-actions enumerates the
    // candidates while this card is still in HAND, before it exists anywhere on
    // the board, so the Bouncer can never be offered as its own target and
    // validate-play-card would refuse an id that was not enumerated.
    //
    // The `?:` guard is load-bearing rather than defensive: with no unit at any
    // battlefield the Unit is still playable with its trigger's target omitted
    // (validate-play-card's targetOmissionAllowed), and the Bouncer simply
    // deploys and bounces nothing.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state,
  },
  "OGN-196": {
    // Soulgorger — "When you play me, you may play a unit from your trash,
    // ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // A DECISION rather than an `ownTrashCard` target, unlike Cemetery Attendant
    // above, and the two differences are both printed:
    //   - "You MAY". A fanned-out `ownTrashCard` spec offers the no-target
    //     variant only when the board offered no legal candidate, so with a
    //     stocked trash "you may" would silently become "you must" — the exact
    //     failure card-effects.ts's OPTIONAL_UNIT_COSTS comment records for
    //     Wildclaw Shaman.
    //   - The Power cost is paid AT RESOLUTION, out of the pool as it stands
    //     then. It is not part of the PlayCardAction's payment and cannot be:
    //     the action paid for the Soulgorger.
    // Flame Chompers (OGN-006, effects/fury.ts) is the precedent for both halves
    // — the same "offer it from the trash, pay Power, then playUnitToBase" shape.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-196-play", playerIndex: ctx.casterIndex }),
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Undercover Agent — "[Deathknell] Discard 2, then draw 2." (rule 808)
  //
  // Order matters and the card spells it out with "then": the two discards leave
  // hand before the two draws arrive, so a card just drawn can never be one of
  // the cards discarded. Doing it in one step would let that happen.
  //
  // A Deathknell has no action to carry the choice on, so the discard stops and
  // asks — which is exactly why "then" needs `discardThenDraw` rather than
  // wrapping drawCards around it: the draw has to queue behind the questions, or
  // the cards it adds join the pool being discarded from.
  "OGN-178": (state, ctx) => discardThenDraw(state, ctx.casterIndex, 2, 2),

  // Kog'Maw - Caustic — "[Deathknell] Deal 4 to all units at my battlefield."
  //
  // The card triggers.ts's DeathContext doc comment names as the reason
  // `battlefieldId` is captured before the corpse reaches the trash (809.1.b.3):
  // by the time this runs, asking the board where Kog'Maw is would find him in a
  // trash and "my battlefield" would have no answer.
  //
  // He is NOT among the 4 damage's targets, and that falls out of `killUnit`'s
  // ordering rather than needing a filter: the unit is removed from the board and
  // trashed before triggers fire, precisely so "all units at my battlefield"
  // cannot include the corpse.
  //
  // "ALL units", so his own side takes it too — the card names no owner, and this
  // is a symmetric blast that is often worse for the player who cast him.
  // Undefined `battlefieldId` means he died in base, where there is no
  // battlefield and so nothing to hit.
  //
  // `ctx.casterIndex` is his controller, which is who is dealing this damage —
  // so Annie - Fiery's +1 applies to it and a damage-modifier read from the
  // victim's side would be wrong.
  "OGN-190": (state, ctx, death) =>
    death.battlefieldId === undefined ? state : dealDamageToAllUnitsAt(state, ctx.casterIndex, death.battlefieldId, 4),
};

/**
 * Deals `amount` to every unit at ONE battlefield, both owners' — the shape
 * "all units at my battlefield" needs, and the one variant effect-helpers does
 * not carry (it has enemy-units-at-one-battlefield and all-units-at-ALL-
 * battlefields, neither of which is this).
 *
 * The id list is snapshotted before any damage lands, for the same reason
 * `dealDamageToEnemyUnitsAtBattlefield` does it: a unit killed by an earlier
 * iteration must not shorten the loop, and `dealDamage` already no-ops on an id
 * that has since left play.
 */
function dealDamageToAllUnitsAt(state: GameState, casterIndex: 0 | 1, battlefieldId: string, amount: number): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const targetIds = Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId));
  return targetIds.reduce((next, id) => dealDamage(next, casterIndex, id, amount), state);
}

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-177": {
    // Stealthy Pursuer — "When a friendly unit moves FROM MY LOCATION, I may be
    // moved with it."
    //
    // Three conditions, and the first two are what make him a follower rather
    // than a second [Ganking] unit: the mover must be FRIENDLY, and it must have
    // left where he is standing. He does not follow an enemy, and he does not
    // teleport to a fight two battlefields away.
    //
    // **DIVERGENCE, and it is the unguessed rules call this card was blocked
    // on.** "Moved WITH it" reads as simultaneous, and this cannot be: the event
    // is a Chain Pending Item (383), so his move happens when the trigger
    // resolves — which `runCleanup` reaches AFTER `stageShowdowns`. He therefore
    // arrives at a battlefield whose Showdown is already staged, joining the
    // fight as an extra body rather than as part of the attack that opened it.
    // The alternative reading — that "with it" forbids being a held trigger at
    // all — would make him the only unit trigger in the pool resolved inline.
    // Recorded Unverified in docs/rules-conformance.md.
    //
    // He is deliberately NOT excluded from following a move he made himself:
    // nothing in this pool can move him and another friendly unit in one action
    // except a group MoveUnit, where the event fires per unit, and "a friendly
    // unit" includes his companions. `applies` does exclude the mover BEING him,
    // which is the one case that would let him chase his own move.
    on: "unitMoved",
    applies: (state, listener, event) => pursuerFollows(state, listener, event),
    resolve: (state, listener, event) => {
      if (!pursuerFollows(state, listener, event) || event.kind !== "unitMoved") return state;
      // "I MAY be moved" — a real choice, and one only its controller makes.
      return parkDecision(state, {
        kind: "OGN-177-follow",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.to,
      });
    },
  },
  "OGN-205": {
    // Yasuo - Windrider — "[Ganking] The third time I move in a turn, you score
    // 1 point."
    //
    // Reads `event.movesThisTurn`, the mover's count AFTER the move, rather than
    // looking the unit up again: `unitMoved` is a Chain Pending Item, so between
    // firing and resolving he can be moved again, bounced or killed, and "the
    // third time" is a fact about the move that happened.
    //
    // EXACTLY the third, not the third-or-later — a fourth and fifth move score
    // nothing, the same reading Darius - Trifarian's "your SECOND card" takes.
    //
    // **A plain `points + 1`, deliberately NOT routed through `recordConquest`.**
    // The Final Point restriction (rule 474) applies only to a point gained
    // "through a Conquer"; the rules are explicit that points from other sources
    // are not beholden to it. Sending this through the conquest path would make
    // the winning point silently withheld unless every battlefield had been
    // scored that turn.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.movesThisTurn === 3,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[listener.ownerIndex] = { ...players[listener.ownerIndex], points: players[listener.ownerIndex].points + 1 };
      return { ...state, players };
    },
  },
  "OGN-167": {
    // Ember Monk — "When you play a card from [Hidden], give me +2 Might this
    // turn."
    //
    // Note what he does NOT do: he has [Hidden] himself, but this triggers on
    // playing ANY card from facedown, his own arrival included if he was hidden.
    // The event carries `fromHidden` rather than existing as its own kind, so
    // nothing else that watches plays goes blind to hidden ones.
    //
    // "YOU play" — his own controller's hidden card, not the opponent's.
    on: "cardPlayed",
    // Both conditions are properties of the event, so they cannot drift between
    // firing and resolving — but they gate whether this reaches the chain at all,
    // which is what `applies` is for now that `cardPlayed` is held.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (!event.fromHidden) return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      return giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 2);
    },
  },
  "OGN-202": {
    // Jinx - Rebel — "When you discard one or more cards, ready me and give me
    // +1 Might this turn."
    //
    // "ONE OR MORE" pays out once per discard instruction, not once per card,
    // which is exactly why `cardsDiscarded` carries a count rather than firing
    // per card — a "discard 2" readies her once.
    //
    // "YOU discard" is her own controller: Mindsplitter making the OPPONENT
    // discard must not ready their Jinx.
    on: "cardsDiscarded",
    resolve: (state, listener, event) => {
      if (event.kind !== "cardsDiscarded") return state;
      if (event.discarderIndex !== listener.ownerIndex) return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, 1);
    },
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "OGN-186": {
    // Treasure Trove — "When this leaves the board, draw 1 and channel 1 rune
    // exhausted."
    //
    // Keyed on being KILLED, which is the only way it leaves the board in this
    // pool — its own "[Chaos], Exhaust: Kill this" (activated-abilities.ts) and
    // `[Temporary]` expiry both route through killGear, which fires this. The
    // payout lives HERE rather than in that ability so it cannot be paid twice
    // if the Trove ever dies some other way.
    on: ["killed"],
    resolve: (state, event) => channelRunesExhausted(drawCards(state, event.ownerIndex, 1), event.ownerIndex, 1),
  },
  // Scrapheap � "When this is played, discarded, or killed, draw 1."
  //
  // The only card in the pool that watches its OWN three-way fate, and the
  // reason self-triggers are keyed by defId rather than found by walking the
  // board: on the discarded branch this Gear is in hand at the moment it fires
  // (and in the trash immediately after), so no listener walk over permanents in
  // play would ever reach it.
  //
  // Not "when this ENTERS play" � a discarded Scrapheap was never in play at
  // all, and the printed text still pays. All three branches read the same, and
  // the draw goes to the card's owner in every one of them.
  "OGN-182": {
    on: ["played", "discarded", "killed"],
    resolve: (state, event) => drawCards(state, event.ownerIndex, 1),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** Nocturne - Horrifying's alternative price — "play me for [rainbow]". */
const NOCTURNE_POWER = 1;

export const decisions: Record<string, DecisionDefinition> = {
  /** Stealthy Pursuer's "I may be moved with it" — see his trigger above for the
   *  timing divergence this question inherits. */
  "OGN-177-follow": {
    prompt: () => "Stealthy Pursuer: follow the unit that just left?",
    options: (state, d) => {
      // Moot if he has since died or already been moved away — a question about
      // a board that no longer exists is dropped rather than answered.
      const location = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!location || location.zone === "base") return [];
      if (state.battlefields[location.zone.battlefieldIndex]!.id === d.battlefieldId) return [];
      return [
        { id: "stay", label: "Stay" },
        { id: "follow", label: "Follow it" },
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "follow" && d.cardInstanceId && d.battlefieldId
        ? // Through the real move funnel, so arriving contests the battlefield
          // and stages a Showdown exactly as a walk-in would. It fires no
          // on-move trigger, which `forceMoveToBattlefield`'s own note already
          // records as this engine's reading of a spell-driven move.
          forceMoveToBattlefield(state, d.cardInstanceId, d.battlefieldId)
        : state,
  },
  // Stacked Deck's "put 1 into your hand and recycle the rest".
  //
  // The options are the top 3 read from LIVE state when the question reaches the
  // front of the queue, not captured when it was raised — a question queued
  // behind another must not offer a card the earlier answer has since drawn.
  /**
   * Nocturne - Horrifying's "as you look at or reveal me from the top of your
   * deck, you may banish me. If you do, you may play me for [rainbow]."
   *
   * Two nested "you may"s, offered as THREE options rather than two questions:
   * banishing without playing is a real (if rare) line — it thins the deck and
   * denies a mill — and asking the second question separately would need a way
   * to remember that the first was answered yes.
   *
   * `cardInstanceId` names the copy that was seen. Not "the top card": half the
   * effects that look at a top-5 recycle it before this can be answered, so by
   * the time the offer resolves he may be at the BOTTOM of the deck — see
   * engine/top-of-deck.ts.
   *
   * **Unverified:** when the looking effect goes on to ask its own question about
   * the same cards (Reinforce, Stacked Deck, Baited Hook, Promising Future),
   * banishing him here means that question re-slices a top-N that has moved up
   * by one, so it sees a card the player never looked at. The rules would keep
   * the looked-at set fixed. Recorded in docs/rules-conformance.md.
   */
  "OGN-194-banish": {
    prompt: () => "Nocturne - Horrifying: banish him from the top of your deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Moot if he has left the deck since the offer was raised — no options is
      // how a question that no longer applies is dropped.
      if (!state.players[d.playerIndex].deck.some((c) => c.instanceId === d.cardInstanceId)) return [];
      options.push({ id: "banish", label: "Banish him" });
      if (payPowerFromChanneled(state, d.playerIndex, RAINBOW, NOCTURNE_POWER) !== undefined) {
        options.push({ id: "play", label: "Banish him and play him for 1 rainbow Power" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.cardInstanceId) return state;
      const actor = state.players[d.playerIndex];
      const card = actor.deck.find((c) => c.instanceId === d.cardInstanceId);
      if (!card) return state;

      // Out of the deck either way — the banish is what both live options share,
      // and it is what the play is conditional on ("IF YOU DO, you may play me").
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        deck: actor.deck.filter((c) => c.instanceId !== card.instanceId),
        banished: [...actor.banished, card],
      };
      const banished: GameState = { ...state, players };
      if (optionId !== "play") return banished;

      // Pay first, and stop at the banish if the Power has gone since the offer.
      const paid = payPowerFromChanneled(banished, d.playerIndex, RAINBOW, NOCTURNE_POWER);
      if (paid === undefined) return banished;
      const after = [...paid.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = {
        ...after[d.playerIndex],
        banished: after[d.playerIndex].banished.filter((c) => c.instanceId !== card.instanceId),
        // "PLAY me" — a card you played, so [Legion] and the play-watchers see it.
        cardsPlayedThisTurn: after[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // "Play me FOR [rainbow]" — the rainbow Power is the whole price, so his
      // 4 Energy and his Chaos pip are both waived.
      return playCardIgnoringCost({ ...paid, players: after }, d.playerIndex, card);
    },
  },
  "OGN-183-keep": {
    prompt: () => "Stacked Deck: put one into your hand, recycle the rest",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 3).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => takeOneFromTopAndRecycleRest(state, d.playerIndex, 3, optionId),
  },

  // Mindsplitter's "choose a card from it, and they discard that card".
  //
  // The chooser is the caster (`d.playerIndex`); the cards are the opponent's,
  // and so is the discard. Routed through discardCards so the discarded card
  // still fires its own on-discard trigger (Flame Chompers, Scrapheap) and still
  // sets `discardedThisTurn` for Raging Soul and Jinx - Rebel — a hand-rolled
  // move would silently skip all three.
  "OGN-192-discard": {
    prompt: () => "Mindsplitter: choose a card for your opponent to discard",
    options: (state, d) => {
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return opponent.hand.map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId }));
    },
    resolve: (state, d, optionId) => {
      const opponentIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      return discardCards(state, opponentIndex, 1, [optionId]);
    },
  },

  // Acceptable Losses' half of the work: one player picking which of their OWN
  // gear dies. Asked of both players, so it is written from the answering
  // player's point of view rather than the caster's — the same shape as
  // Cull the Weak's "OGN-209-kill".
  //
  // No decline option: the text carries no "you may", so a player with gear must
  // kill one. A player with NO gear produces no options at all and
  // advanceDecisions drops the question as moot (422's "do as much as you can");
  // a player with exactly one is not being offered a choice, and it dies without
  // a prompt.
  "OGN-179-kill": {
    prompt: () => "Acceptable Losses: kill one of your gear",
    options: (state, d) =>
      state.players[d.playerIndex].activeGear.map((g) => ({ id: g.instanceId, label: g.name, instanceId: g.instanceId })),
    // killGear, not a hand-rolled removal: it is the funnel that trashes a gear
    // and fires its own killed self-trigger, so a Treasure Trove taken by this
    // still pays out and a Scrapheap still draws.
    resolve: (state, d, optionId) => {
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      return gear ? killGear(state, gear, d.playerIndex) : state;
    },
  },

  // Whirlwind's half: one player choosing a unit — ANY unit, either owner's,
  // base or battlefield (355.9.b's bare noun) — to send to its owner's hand.
  //
  // The decline leads, and is what makes "MAY" mean may: with no unit in play at
  // all it is the only option, so the question is executed rather than asked and
  // nobody is interrupted to be told there is nothing to do. Leading also means a
  // mis-click and the AI's tie-break both land on doing nothing, the same
  // convention Flame Chompers' offer uses.
  //
  // `returnUnitToHand` sends it to its OWNER's hand rather than the answering
  // player's, and strips Buffs on the way (709) — both already handled there.
  "OGN-187-return": {
    prompt: () => "Whirlwind: you may return a unit to its owner's hand",
    options: (state): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...allUnitsInPlay(state).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },

  // Soulgorger's "you may play a unit from your trash, ignoring its Energy cost."
  //
  // The decline comes FIRST so that a mis-click and the AI's tie-break both land
  // on doing nothing, the same convention Whirlwind's offer above uses — and it
  // is the whole difference between this entry and The Harrowing's below, which
  // prints the same instruction without "you may".
  "OGN-196-play": {
    prompt: () => "Soulgorger: you may play a unit from your trash, paying only its Power cost",
    options: (state, d) => [{ id: "decline", label: "Decline" }, ...playableTrashUnits(state, d.playerIndex)],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : playUnitFromTrash(state, d.playerIndex, optionId)),
  },

  // The Harrowing's "Play a unit from your trash, ignoring its Energy cost."
  //
  // No decline: the instruction is mandatory, so the only options are the units
  // that can actually be played. With none the list is EMPTY and
  // `advanceDecisions` drops the question (422 — do as much as you can, then
  // nothing); with exactly one it executes it without asking, because one option
  // is not a choice. Both branches are asserted in test/cards-harrowing.test.ts,
  // since a mandatory question with no answer is the one shape that could hang
  // the game rather than fizzle.
  "OGN-198-play": {
    prompt: () => "The Harrowing: play a unit from your trash, paying only its Power cost",
    options: (state, d) => playableTrashUnits(state, d.playerIndex),
    resolve: (state, d, optionId) => playUnitFromTrash(state, d.playerIndex, optionId),
  },
};

/**
 * The units in a player's trash they could play right now for their Power cost
 * alone — Soulgorger's offer and The Harrowing's, which print the same
 * instruction and differ only in whether declining is allowed.
 *
 * Priced when the OPTIONS are built, so a unit whose Power cost cannot be paid
 * is never offered rather than offered and then refused — 416.3's "the action
 * must be able to be completed for the cost to be paid", and the same shape
 * Flame Chompers' offer uses.
 *
 * **Named limitation, inherited by both cards:** affordability is asked through
 * `payPowerFromChanneled`, which takes a single domain and reads only the
 * channeled pool. So a card with a split Power pip (`powerDomainAlt`, e.g.
 * Tibbers) is judged against its primary domain only, and floating Power does
 * not count. Both UNDER-offer — the option is withheld, never granted free — and
 * both come from that helper rather than being introduced here. Widening it is a
 * change to effect-helpers.ts, not to this file.
 */
function playableTrashUnits(state: GameState, playerIndex: 0 | 1): DecisionOption[] {
  const options: DecisionOption[] = [];
  for (const card of state.players[playerIndex].trash) {
    if (card.kind !== "Unit") continue;
    if (payUnitPowerCost(state, playerIndex, card) === undefined) continue;
    options.push({ id: card.instanceId, label: playLabel(card), instanceId: card.instanceId });
  }
  return options;
}

/**
 * Takes the named unit out of the trash, pays its Power, and plays it to base.
 *
 * Out of the trash, then into play through the shared deploy funnel — so it
 * enters exhausted (143.4.a) unless something says otherwise, and both events a
 * real play fires go off. "Play a unit" means play it.
 *
 * The printed Energy is not paid and not discounted: the card's text replaces
 * that half of the cost outright, exactly as rule 811 does for a card played
 * from Hidden. `cardsPlayedThisTurn` is bumped because this IS a card being
 * played, which is what [Legion] counts.
 *
 * The cost is re-paid here rather than trusted from the option list, because the
 * options were built from an earlier state — anything that drained the pool
 * between the question and the answer makes this fizzle rather than play a unit
 * for free.
 */
function playUnitFromTrash(state: GameState, playerIndex: 0 | 1, optionId: string): GameState {
  const card = state.players[playerIndex].trash.find((c) => c.instanceId === optionId);
  if (!card || card.kind !== "Unit") return state;
  const paid = payUnitPowerCost(state, playerIndex, card);
  if (!paid) return state;

  const players = [...paid.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    trash: players[playerIndex].trash.filter((c) => c.instanceId !== optionId),
    cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1,
  };
  return playUnitToBase({ ...paid, players }, playerIndex, card);
}

/** Every unit in play, both players, base and battlefields — Whirlwind's "a
 *  unit" with no owner and no location named. Player order, then each player's
 *  own base-before-battlefields walk, so the option list is stable and the tests
 *  about WHICH unit was chosen mean something. */
function allUnitsInPlay(state: GameState): UnitInstance[] {
  return ([0, 1] as const).flatMap((playerIndex) => ownUnitsEverywhere(state, playerIndex));
}

/**
 * Pays a trashed unit's Power cost, or `undefined` when it cannot be paid — the
 * same contract `payPowerFromChanneled` and `spendBuff` use, so an unpayable cost
 * withholds the payoff instead of handing it over free.
 *
 * A zero Power cost is payable and costs nothing; it is short-circuited rather
 * than passed through as `count: 0` because `powerDomain` is null exactly when
 * the cost is 0, and null means RAINBOW to that helper — asking it to take zero
 * rainbow runes works, but only by accident of the arithmetic.
 */
function payUnitPowerCost(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState | undefined {
  if (card.powerCost <= 0) return state;
  return payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost);
}

function playLabel(card: UnitInstance): string {
  return card.powerCost <= 0
    ? `Play ${card.name} (free)`
    : `Play ${card.name} (pay ${card.powerCost} ${card.powerDomain ?? "any"} Power)`;
}

/** Stealthy Pursuer's three conditions, asked once so `applies` and `resolve`
 *  cannot disagree — a held trigger that re-derives them separately is how a
 *  response window turns into a trigger firing on a board that no longer
 *  qualifies. */
function pursuerFollows(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "unitMoved") return false;
  if (event.moverIndex !== listener.ownerIndex) return false; // "a FRIENDLY unit"
  if (event.unitInstanceId === listener.card.instanceId) return false; // not his own move
  // "FROM MY LOCATION" — where he is standing NOW, which is where he was when
  // the mover left, since nothing resolves in between.
  return listener.battlefieldId === event.from && event.to !== event.from;
}
