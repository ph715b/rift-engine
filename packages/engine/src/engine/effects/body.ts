import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  dealDamageToEnemyUnitsAtBattlefield,
  drawCards,
  giveMightThisTurn,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  readyPermanent,
  readyUnit,
  recycleCardFromHand,
  spendBuff,
} from "../effect-helpers.js";
import { readyableOthers } from "../unit-triggers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";

/**
 * Card implementations for **Body** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Body. A test in
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
  "OGN-133": {
    // Flurry of Blades — "Deal 1 to all units at battlefields."
    //
    // ALL units, both players' including the caster's — symmetric, and the base
    // is excluded because "at battlefields" is printed. The existing helper is
    // exactly this sentence.
    targeting: { kind: "none" },
    resolve: (state, ctx) => dealDamageToAllUnitsAtAllBattlefields(state, ctx.casterIndex, 1),
  },
  "OGN-154": {
    // Primal Strength — "Give a unit +7 Might this turn."
    //
    // No owner, no battlefield, no floor: scope "anywhere" and the number as
    // printed. giveMightThisTurn rather than a Buff — this expires in the
    // Expiration Step (317) rather than persisting (710).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 7) : state,
  },
  "OGN-144": {
    // Spoils of War — "If an enemy unit has died this turn, this costs 2 Energy
    // less. Draw 2."
    //
    // Only the draw is here; the conditional discount is a COST and lives in
    // cost-modifiers.ts, the same split Find Your Center takes.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 2),
  },
  "OGN-156": {
    // Sabotage — "Choose an opponent. They reveal their hand. Choose a non-unit
    // card from it, and recycle that card."
    //
    // "NON-UNIT", which is the whole texture of the card: it takes the removal
    // and the card draw out of a hand and leaves the bodies. A hand of nothing
    // but units makes this a blank, and the decision correctly offers nothing —
    // advanceDecisions drops a question with no answers rather than deadlocking.
    //
    // Recycle, not discard: the card goes to the BOTTOM OF THEIR DECK (416), so
    // they will draw it again eventually. That distinction matters to anything
    // watching the trash, which is why this does not route through discardCards.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-156-recycle", playerIndex: ctx.casterIndex }),
  },
  "OGN-138": {
    // Catalyst of Aeons — "Channel 2 runes exhausted. If you couldn't channel 2
    // runes this way, draw 1."
    //
    // The consolation is measured off what ACTUALLY happened, not off the rune
    // deck's size beforehand: channelRunesExhausted takes as many as it can
    // (315.4.b), so comparing the channeled pool before and after is the only
    // reading that stays right if that helper's own short-deck behaviour ever
    // changes. "Couldn't channel 2" is fewer than 2, so a deck with exactly one
    // rune left both channels it AND draws.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const before = state.players[ctx.casterIndex].channeled.length;
      const channelled = channelRunesExhausted(state, ctx.casterIndex, 2);
      const gained = channelled.players[ctx.casterIndex].channeled.length - before;
      return gained < 2 ? drawCards(channelled, ctx.casterIndex, 1) : channelled;
    },
  },
  "OGN-127": {
    // Cannon Barrage — "[Reaction] Deal 2 to all enemy units in combat."
    //
    // card-effects.ts used to carry a paragraph explaining that this was
    // deliberately NOT registered, because the card "can only ever be cast when
    // there's nothing 'in combat' to hit": validate-play-card rejected every
    // PlayCard while a Showdown was open, so implementing it would have meant
    // writing code that could never run. [Action]/[Reaction] timing removed that
    // blocker, so the card is now implementable — and being a [Reaction] it can
    // be cast onto an already-closed chain, which is exactly its point.
    //
    // Hits enemy units at the battlefield where the Showdown is running, and
    // nothing at all outside one. That reading covers both Showdown kinds without
    // branching on `showdownKind`: a Non-Combat Showdown has no opposing units
    // present by definition (that is what makes it non-combat), so "all enemy
    // units in combat" is empty there either way.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      state.showdownBattlefieldId === null
        ? state
        : dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, state.showdownBattlefieldId, 2),
  },
  "OGN-128": {
    // Challenge — "[Action] Choose a friendly unit and an enemy unit. They deal
    // damage equal to their Mights to each other."
    //
    // Gentlemen's Duel (OGS-008, card-effects.ts) minus its +3 Might: same two
    // ordered slots, same `min: 2` (a duel with one participant isn't a duel, so
    // the card stays uncastable without both), and the same resolution order.
    //
    // That order is the only subtle part, and it is load-bearing. BOTH Mights are
    // read before EITHER damage instance is dealt, so the first duellist to die
    // still deals its full Might on the way out — deal-then-read would let the
    // enemy's death silently reduce the damage coming back at the friendly unit.
    // The two damages are still applied one after the other because dealDamage is
    // the single death choke point (Deathknells, death wards); simultaneity here
    // is about the AMOUNTS, which the snapshot already gives.
    //
    // Scope: the printed text names no battlefield, so either duellist may be
    // standing in its owner's BASE — including the opponent's. Same reading as
    // Final Spark's "deal 8 to a unit"; base is not a safe parking spot.
    //
    // The Might-in-its-zone lookup is now `unitsDuel` at the foot of this file —
    // the fold this comment used to ask for, taken the moment a second Body card
    // (Carnivorous Snapvine) printed the same sentence. Gentlemen's Duel still
    // carries its own copy in card-effects.ts, which this file's owner doesn't own.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) =>
      unitsDuel(state, ctx.casterIndex, event.targetUnitInstanceId!, event.secondTargetUnitInstanceId!),
  },
  "OGN-146": {
    // Wallop — "[Action] As you play this, you may spend a buff as an additional
    // cost. If you do, ignore this spell's cost. Ready a unit."
    //
    // **HALF-IMPLEMENTED, deliberately.** The optional additional cost and the
    // cost-ignoring are a COST, and costs live in card-effects.ts's
    // OPTIONAL_UNIT_COSTS — the entry this card needs is
    // `"OGN-146": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true }`,
    // exactly Call to Glory's (OGN-207). Without it `legal-actions` never
    // enumerates a paid variant and `validate-play-card` refuses one, so the
    // `spendBuff` branch below is currently unreachable: Wallop plays at its
    // printed 2 Energy and readies a unit, and the free-cast mode does not exist.
    // The branch is written anyway so the card is complete the moment that one
    // line lands, rather than needing a second author to notice it is missing.
    //
    // "Ready a unit" — the bare noun, so scope "anywhere" with no owner
    // restriction (355.9.b). Readying an ENEMY unit is a bad play, not an illegal
    // one; same reading Call to Glory's "a unit" and First Mate's "ready another
    // unit" already take, and base is where an exhausted unit usually sits.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const paid =
        event.additionalCostUnitInstanceId !== undefined
          ? (spendBuff(state, ctx.casterIndex, event.additionalCostUnitInstanceId) ?? state)
          : state;
      return event.targetUnitInstanceId ? readyUnit(paid, event.targetUnitInstanceId) : paid;
    },
  },
  "OGN-153": {
    // Overt Operation — "[Action] For each friendly unit, you may spend its buff
    // to ready it. Then buff all friendly units."
    //
    // Targeting is "none" because nothing here is chosen when the card is
    // announced: "for each friendly unit" is a sweep over the board as it stands
    // at RESOLUTION, and each "you may" is answered then. That is what
    // engine/decisions.ts exists for — the fan-out-onto-the-action approach
    // cannot express one question per unit, and 2^N variants would be a lie
    // about when the choice is made anyway.
    //
    // One question per BUFFED friendly unit. Unbuffed ones are skipped rather
    // than asked-and-declined: rule 705 forbids spending a buff that isn't there,
    // so their "you may" has no payable side and advanceDecisions would drop the
    // one-option question on sight.
    //
    // READY buffed units ARE still asked, even though readying a ready unit does
    // nothing. The spend is not wasted — "then buff all friendly units" hands the
    // buff straight back (708 makes it a no-op only for units that kept theirs),
    // so the answer is at worst neutral and at best fires `unitBuffed` again for
    // Mistfall. Filtering them out would take a legal, occasionally useful answer
    // away; the precedent for pruning (Mistfall's own exhausted-only offer) is
    // about an unpayable COST, which this is not.
    //
    // "THEN buff all friendly units" is queued as its own single-option decision
    // rather than applied here, and the "then" is what forces that: every spend
    // must land before any buff does, or a unit re-buffed early could have that
    // same buff spent by a later answer. Same reason Undercover Agent's "discard
    // 2, then draw 2" queues its draw (see decisions.ts's `draw`).
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const asked = ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => u.buffed)
        .reduce(
          (next, unit) =>
            parkDecision(next, {
              kind: "OGN-153-spend",
              playerIndex: ctx.casterIndex,
              targetInstanceId: unit.instanceId,
            }),
          state,
        );
      return parkDecision(asked, { kind: "OGN-153-buff-all", playerIndex: ctx.casterIndex });
    },
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-141": {
    // Kinkou Monk — "When you play me, buff up to two OTHER friendly units."
    //
    // `min: 0` is what makes "up to" real — the empty choice is legal, so a Monk
    // played with nothing else on board still deploys. "OTHER" is free here: he
    // is not yet a legal target of his own trigger, since legal-actions
    // enumerates while he is still in hand.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 0, scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      [event.targetUnitInstanceId, event.secondTargetUnitInstanceId]
        .filter((id): id is string => id !== undefined)
        .reduce((next, id) => addBuff(next, id), state),
  },
  "OGN-164": {
    // Sett - Brawler — "When I'm played AND when I conquer, buff me." (His
    // "Spend my buff: give me +4 Might this turn" is in activated-abilities.)
    //
    // Only the played half is here; the conquer half listens to
    // `battlefieldConquered` below. Two clauses, two mechanisms, one card —
    // splitting them is what lets each be the narrowest thing it needs.
    targeting: { kind: "none" },
    resolve: (state, _ctx, unitId) => addBuff(state, unitId),
  },
  "OGN-136": {
    // Pit Rookie — "When you play me, buff another friendly unit."
    //
    // The first card to place a real Buff. Rule 702.3.a: "To Buff a Unit, a
    // player chooses a Unit and then places a buff on it." Worth +1 Might
    // (rule 710) and, unlike a "+1 Might this turn" effect, it stays there —
    // rule 709 removes it only when the unit leaves play.
    //
    // "Another" excludes Pit Rookie itself, which comes for free: legal-actions
    // enumerates targets while this card is still in hand, so its own
    // instanceId is never a candidate. The guard below is for the case where the
    // board offered no legal target at all and the Unit was played with its
    // target omitted (validate-play-card's targetOmissionAllowed).
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state,
  },
  "OGN-147": {
    // Wildclaw Shaman — "When you play me, you may spend a buff to buff me and
    // ready me. (If I don't have a buff, I get a +1 Might buff.)"
    //
    // Spend first, payoff second, and only if the spend actually happened: the
    // buff is a COST, not a target. spendBuff returns `undefined` rather than an
    // unchanged state precisely so that can't be fudged — rule 705 forbids
    // spending from an unbuffed unit and rule 705.1 restricts it to units you
    // control, and either failure has to cancel the buff-and-ready, not hand it
    // over free. Rule 704.1 is the removal itself.
    //
    // The parenthetical is reminder text for rules 708/710, not a second mode:
    // a Buff is worth +1 Might (710) and adding one to an already-buffed unit
    // does nothing (708, "it is not placed instead"), which addBuff implements.
    // The Shaman has just entered play and so is never already buffed here, but
    // going through addBuff keeps the one-buff-at-a-time rule (707) in one place.
    //
    // "YOU MAY" rides on `additionalCostUnitInstanceId`, the field a Spell's
    // optional cost already used (Meditation) — NOT on the ordinary target
    // field. That distinction is the whole point: legal-actions always emits a
    // decline variant alongside one variant per BUFFED friendly unit, so
    // declining stays available even when every unit you control is buffed.
    // Routing it through the target field instead made "you may" collapse into
    // "you must" in exactly that case.
    //
    // Targeting is "none": this card chooses nothing to act ON. The unit whose
    // buff is spent is a cost, and rule 355.11's "included only as part of a
    // cost" clause says a cost is not a target.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitInstanceId, event) => {
      const donor = event.additionalCostUnitInstanceId;
      if (donor === undefined) return state; // declined — "you may"
      const paid = spendBuff(state, ctx.casterIndex, donor);
      if (paid === undefined) return state; // cost unpayable (rule 705/705.1) — no payoff
      return readyUnit(addBuff(paid, unitInstanceId), unitInstanceId);
    },
  },
  "OGN-149": {
    // Carnivorous Snapvine — "When you play me, choose an enemy unit at a
    // battlefield. We deal damage equal to our Mights to each other."
    //
    // Challenge's duel (above) with the friendly slot pinned to the Snapvine
    // itself, so it shares `unitsDuel` and inherits the ordering that matters:
    // both Mights are read BEFORE either damage lands, so a target killed
    // outright still hits back for its full Might.
    //
    // Scope differs from Challenge and it is printed, not incidental: "an enemy
    // unit AT A BATTLEFIELD", so the default battlefield scope stands and a unit
    // sitting in the opponent's base cannot be picked. The SNAPVINE, though, may
    // be anywhere — playing it to your own base and shooting across the board is
    // a legal (and expensive) line, which is why the duel looks its own location
    // up rather than assuming `event.destination`.
    //
    // Guarded on the target because a Unit is playable with its trigger's target
    // omitted when the board offered none (validate-play-card's
    // targetOmissionAllowed) — a Snapvine played into an empty board deploys and
    // fights nobody.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, unitInstanceId, event) =>
      event.targetUnitInstanceId
        ? unitsDuel(state, ctx.casterIndex, unitInstanceId, event.targetUnitInstanceId)
        : state,
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-158": {
    // Volibear - Imposing — "[Shield 3][Tank] When an opponent moves to a
    // battlefield other than mine, draw 1. (Bases are not battlefield.)"
    //
    // Fires PER UNIT MOVED, because `unitMoved` is fired per unit inside
    // `execute-move-unit`'s loop: a MoveUnitAction carries an ARRAY of units, and
    // three units walking together are three moves. Recorded as Unverified —
    // "when an opponent moves" could be read per ACTION, and the two differ by a
    // factor of three on the board this card is built to punish.
    //
    // "OTHER THAN MINE" is positional, so **he must be AT a battlefield for it to
    // name anything**: in base he has no "mine" for a destination to differ from,
    // and he draws nothing. The same reading Sett - Kingpin and Lee Sin -
    // Centered take of their own positional text. Also Unverified.
    //
    // The parenthetical is about the DESTINATION: a unit recalled or moved home
    // has not moved "to a battlefield". `unitMoved` only fires for a Standard
    // Move to a battlefield, so that is already true without a check here.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.moverIndex !== listener.ownerIndex &&
      listener.battlefieldId !== undefined &&
      event.to !== listener.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      if (event.moverIndex === listener.ownerIndex) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "OGN-139": {
    // Cithria of Cloudfield — "When you play another unit, buff me."
    //
    // Three conditions, all printed. **You**: only her controller's plays, so an
    // opponent building a board does not feed her. **Unit**: a Spell or Gear is
    // not a unit, and without the kind check she would grow off Showstopper and
    // Call to Glory — which is a lot, in the deck she is actually played in.
    // **Another**: her own arrival must not buff her, which matters because the
    // cardPlayed event fires for her too.
    //
    // She stacks: 710 makes a second Buff on an already-buffed unit a no-op, so
    // she is +1 Might once and then stops climbing. That is the rules working,
    // not a missing feature — the payoff for a board full of units is Sett -
    // Kingpin's aura counting her as one more buffed body.
    on: "cardPlayed",
    // All three printed conditions read the EVENT and the listener's own
    // identity, none of which the response window can change, so they are safe
    // in both places — and they belong here because `cardPlayed` is held now: a
    // trigger held for a Spell, or for the opponent's play, would cost both
    // players a PassFocus for an ability that resolves to nothing.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit" &&
      event.playedInstanceId !== listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      if (event.playedKind !== "Unit") return state;
      if (event.playedInstanceId === listener.card.instanceId) return state; // "another"
      return addBuff(state, listener.card.instanceId);
    },
  },
  "OGN-164": {
    // Sett - Brawler's second half — "and when I conquer, buff me."
    //
    // "When I conquer" is his own conquest, so he must be AT the battlefield
    // taken — the same reading Kai'Sa - Survivor takes, and what separates a
    // unit's conquer trigger from a Legend's "when you conquer".
    on: "battlefieldConquered",
    // Both conditions decide whether this goes ON THE CHAIN, so they belong here
    // and not only in `resolve` — `battlefieldConquered` is a held event now, and
    // a trigger held for a conquest that is not his opens a response window for
    // nothing.
    //
    // The LOCATION check is here and NOT re-checked in `resolve`, deliberately.
    // 383 fixes what triggered at the moment of the event; between then and the
    // resolution there is a real window in which Sett can be moved, killed or
    // bounced, and 809.1.b.3 exists precisely so a permanent that has left still
    // resolves its trigger. Re-asking at resolution would let the opponent cancel
    // a fired trigger by pushing him one battlefield sideways.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // The conqueror check survives here because it reads only the event and the
      // listener's owner, neither of which the response window can change. The
      // location check does not — see `applies`.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return addBuff(state, listener.card.instanceId);
    },
  },
  "OGN-152": {
    // Mistfall — "When you buff a friendly unit, you may pay [Body] and exhaust
    // this to ready it."
    //
    // Reachable at all only because addBuff is a single funnel: every card that
    // buffs anything goes through it, so this hears all of them without any of
    // them knowing it exists.
    //
    // "You MAY" is why this parks a question rather than just doing it. Readying
    // a unit is not always wanted (a ready unit can be forced into a Showdown),
    // the Power is real, and exhausting Mistfall spends its own turn — so the
    // decline has to be a genuine option, which it is by being one of the two
    // answers rather than an inference.
    on: "unitBuffed",
    // "A FRIENDLY unit" is measured against Mistfall's controller, not against
    // whoever caused the buff — buffing an ENEMY unit must not trigger this at all.
    //
    // Stated here as well as in `resolve` because the two answer different
    // questions once this trigger is held as a Chain Pending Item: this one decides
    // whether it goes on the chain (and so whether both players are asked to pass),
    // while `resolve`'s copy decides what happens when it gets there, on a board
    // that the response window may have changed.
    applies: (_state, listener, event) => event.kind === "unitBuffed" && event.ownerIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitBuffed") return state;
      if (event.ownerIndex !== listener.ownerIndex) return state;
      if (listener.card.exhausted) return state; // it exhausts itself to pay
      return parkDecision(state, {
        kind: "OGN-152-ready",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        // The unit to ready rides here rather than being re-derived: by the time
        // the question is answered the board may have moved on, and "it" means
        // the unit that was buffed.
        targetInstanceId: event.unitInstanceId,
      });
    },
  },
  "OGN-155": {
    // Qiyana - Victorious — "When I conquer, draw 1 or channel 1 rune exhausted."
    //
    // "When *I* conquer" is Kai'Sa - Survivor's reading (OGN-039, fury.ts): she
    // has to be AT the conquered battlefield, which is what separates it from a
    // "when you conquer" card that fires wherever it sits. Checked against the
    // listener's own location rather than the event alone, since the listener
    // walk reaches her anywhere.
    //
    // Her `[Deflect]` is a separate, still-unimplemented clause — the card stays
    // correctly reported as partial (coverage.ts's UNIMPLEMENTED_KEYWORDS).
    on: "battlefieldConquered",
    // Same shape as Sett - Brawler above, and for the same reasons: both
    // conditions gate whether this reaches the chain, and the location one is
    // deliberately not re-asked in `resolve`. Her question is worth more than his
    // buff, so cancelling it by moving her would be a real exploit.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return parkDecision(state, { kind: "OGN-155-conquer", playerIndex: listener.ownerIndex });
    },
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {
  // Qiyana - Victorious's "draw 1 OR channel 1 rune exhausted", raised by her
  // on-conquer trigger above.
  //
  // A genuine either/or with no decline — unlike Mistfall and Miss Fortune
  // below, the card offers no third answer, so neither option is listed as one.
  //
  // BOTH are offered unconditionally, even when the corresponding pile is empty,
  // and that is deliberate on each side. An empty rune deck channels nothing
  // (315.4.b, channelRunesExhausted's own "as many as it can"), and an empty
  // DECK is not a non-choice either — drawing from one is what triggers Burn Out
  // (431), a real and sometimes correct outcome. Suppressing an option here
  // would take a legal decision away from the player, and `advanceDecisions`
  // auto-resolves a one-option question, so pruning would silently pick for them.
  "OGN-155-conquer": {
    prompt: () => "Qiyana - Victorious: draw 1, or channel 1 rune exhausted?",
    options: () => [
      { id: "draw", label: "Draw 1" },
      { id: "channel", label: "Channel 1 rune exhausted" },
    ],
    resolve: (state, d, optionId) =>
      optionId === "draw" ? drawCards(state, d.playerIndex, 1) : channelRunesExhausted(state, d.playerIndex, 1),
  },
  // Sabotage's "choose a non-unit card from it, and recycle that card".
  //
  // Chooser is the caster; the hand and the deck it goes to the bottom of are
  // the opponent's. Filtering to non-units HERE rather than in the resolver is
  // what makes an all-units hand offer nothing at all, which is the card doing
  // as much as it can (422) rather than the player being asked a fake question.
  "OGN-156-recycle": {
    prompt: () => "Sabotage: choose a non-unit card to recycle",
    options: (state, d) => {
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return opponent.hand
        .filter((c) => c.kind !== "Unit")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId }));
    },
    resolve: (state, d, optionId) => recycleCardFromHand(state, d.playerIndex === 0 ? 1 : 0, optionId),
  },
  // Miss Fortune - Captain's "you may ready something else that's exhausted",
  // raised by her on-move trigger the first time she moves each turn.
  //
  // Options are rebuilt from live state, so a permanent readied by something
  // else between the trigger and the answer is simply no longer on offer.
  // Declining is always available and listed first, so a mis-click and the AI's
  // tie-break both land on doing nothing.
  "OGN-162-ready": {
    prompt: () => "Miss Fortune - Captain: ready something else that's exhausted?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...readyableOthers(state, d.playerIndex, d.cardInstanceId ?? "").map((c) => ({
        id: c.instanceId,
        label: `Ready ${c.name}`,
        instanceId: c.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : readyPermanent(state, d.playerIndex, optionId)),
  },
  "OGN-152-ready": {
    prompt: () => "Mistfall: pay 1 Body Power and exhaust it to ready the buffed unit?",
    options: (state, d) => {
      // Declining is always available — "you may". Listed first so that a player
      // (or the AI's tie-breaking) defaults to doing nothing rather than paying.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // The offer is only real if BOTH halves of the cost can still be paid and
      // there is still something to ready. 416.3's shape: a cost that cannot be
      // completed is not a cost you may choose to pay.
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId);
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      if (gear && !gear.exhausted && unit?.unit.exhausted && payPowerFromChanneled(state, d.playerIndex, "Body", 1)) {
        options.push({ id: "pay", label: "Pay 1 Body Power and exhaust Mistfall", instanceId: gear.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay") return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Body", 1);
      if (!paid) return state;
      return readyUnit(exhaustGear(paid, d.playerIndex, d.cardInstanceId!), d.targetInstanceId!);
    },
  },
  // Overt Operation's "for each friendly unit, you may spend its buff to ready
  // it" — one of these per buffed friendly unit, raised in board order.
  //
  // The unit rides on `targetInstanceId` rather than being re-derived from the
  // board, for Mistfall's reason above: "its buff" means THIS unit's, and by the
  // time this question reaches the front an earlier answer may have changed what
  // is buffed. Options are still rebuilt live, so a unit that lost its buff (or
  // died) in the meantime is simply no longer offered the spend.
  "OGN-153-spend": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      return `Overt Operation: spend ${unit?.unit.name ?? "this unit"}'s buff to ready it?`;
    },
    options: (state, d) => {
      // Declining first, so a mis-click and the AI's tie-break both do nothing —
      // the same ordering Mistfall and Miss Fortune - Captain use.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const found = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      // Ownership is re-checked as well as the buff: 705.1 restricts spending to
      // units you control, and control can move (Hostile Takeover) between the
      // question being raised and answered.
      if (found && found.ownerIndex === d.playerIndex && found.unit.buffed) {
        options.push({ id: "spend", label: `Spend ${found.unit.name}'s buff to ready it`, instanceId: found.unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "spend") return state;
      const paid = spendBuff(state, d.playerIndex, d.targetInstanceId!);
      if (!paid) return state; // cost unpayable (705/705.1) — no ready
      return readyUnit(paid, d.targetInstanceId!);
    },
  },
  // Overt Operation's "Then buff all friendly units."
  //
  // Never a real question — one option, so `advanceDecisions` executes it the
  // instant it reaches the front and no player is ever shown it. It exists only
  // to sit BEHIND the spend questions in the queue, which is the whole of what
  // "then" asks for. Exactly decisions.ts's `draw` precedent.
  //
  // The roster is re-read here rather than snapshotted when the card resolved,
  // because a unit that died to something on the chain must not be buffed and
  // one that arrived should be.
  "OGN-153-buff-all": {
    prompt: () => "Overt Operation: buff all friendly units",
    options: () => [{ id: "buff", label: "Buff all friendly units" }],
    resolve: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).reduce((next, unit) => addBuff(next, unit.instanceId), state),
  },
};

/**
 * Two units dealing damage equal to their Mights to each other — Challenge's
 * whole text, and Carnivorous Snapvine's second sentence.
 *
 * **Both Mights are read before either damage instance is dealt.** That ordering
 * is the load-bearing part: the first duellist to die still lands its full Might
 * on the way out, where deal-then-read would let its death silently shrink the
 * damage coming back. The two damages are still applied one after the other,
 * because `dealDamage` is the single death choke point (Deathknells, death
 * wards) — simultaneity here is about the AMOUNTS, which the snapshot gives.
 *
 * `firstId` takes damage second, so the caller's slot order survives: Challenge
 * passes (friendly, enemy) and the enemy is hit first, exactly as before.
 *
 * A duellist that is already gone (killed earlier on the chain, or never chosen)
 * cancels the whole exchange rather than half of it — the "target vanished"
 * no-op convention, and it returns the state untouched rather than merely equal.
 */
function unitsDuel(state: GameState, casterIndex: 0 | 1, firstId: string, secondId: string): GameState {
  const first = findUnitAnywhere(state, firstId);
  const second = findUnitAnywhere(state, secondId);
  if (!first || !second) return state;

  // A base unit has no battlefield id; auras keyed on location (Garen -
  // Commander) read that omission as "base".
  const mightCtx = (location: AnyUnitLocation) =>
    location.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
  const firstMight = effectiveMight(state, first.unit, first.ownerIndex, mightCtx(first));
  const secondMight = effectiveMight(state, second.unit, second.ownerIndex, mightCtx(second));

  const afterSecondDamage = dealDamage(state, casterIndex, secondId, firstMight);
  return dealDamage(afterSecondDamage, casterIndex, firstId, secondMight);
}

/** Exhausts a gear its controller owns — Mistfall pays with itself. */
function exhaustGear(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    activeGear: players[playerIndex].activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, exhausted: true } : g)),
  };
  return { ...state, players };
}
