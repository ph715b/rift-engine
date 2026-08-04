import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  dealDamage,
  destroyUnit,
  legionActive,
  dealDamageToEnemyUnitsAtBattlefield,
  discardCards,
  forceMoveToBattlefield,
  giveMightThisTurn,
  readyUnit,
  stunUnits,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { isHiddenCard } from "../hidden.js";
import { parkDecision } from "../decisions.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import type { PlayerState } from "../../model/game-state.js";

/**
 * Card implementations for the **dual-domain** cards — one file, one owner.
 *
 * These are the champion signature cards: 15 Spells plus Tibbers (the pool's only
 * dual-domain Unit), each printed in two domains — Icathian Rain (Fury+Mind),
 * Super Mega Death Rocket! (Fury+Chaos), Zenith Blade (Calm+Order), and so on.
 *
 * They get their own file because per-domain ownership is genuinely ambiguous for
 * them: a Fury+Chaos card belongs equally to fury.ts and chaos.ts, so filing it
 * by "first domain" would be arbitrary and two owners could each reasonably
 * believe it was theirs. One explicit owner removes the question.
 *
 * The ownership rule is enforced by test/effect-registry.test.ts: a defId may
 * only appear here if its CardDefinition has exactly two domains. Single-domain
 * cards belong in the matching effects/<domain>.ts; Legends belong in
 * engine/legend-abilities.ts (all 16 are dual-domain, so splitting them by domain
 * would put every one of them here).
 *
 * See effects/fury.ts's header for what adding a card owes: registration, a rule
 * or oracle citation, and an engine test.
 */
export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-258": {
    // Dragon's Rage (Calm + Body) — "Move an enemy unit. Then do this: Choose
    // another enemy unit at its destination. They deal damage equal to their
    // Mights to each other."
    //
    // Two enemy targets and a destination, and the relationship between them is
    // what makes the card: the second is chosen at the FIRST one's destination,
    // not where either currently stands. `secondAtDestination` is that — distinct
    // from `sameBattlefield`, which compares present locations, because here the
    // first unit is about to move somewhere the board does not yet reflect.
    //
    // `min: 2`: both choices are mandatory (355), so the card is uncastable
    // without a second enemy somewhere to send the first into. That is the card
    // rather than a limitation — it is a way to make an opponent's own units
    // fight, and one unit cannot.
    //
    // BOTH Mights are read before EITHER damage is dealt, the same ordering
    // Gentlemen's Duel and Challenge record: the first to die still deals its
    // full Might on the way out, where deal-then-read would silently reduce the
    // damage coming back.
    //
    // The move happens FIRST, printed order, so the duel is fought at the
    // destination — and `forceMoveToBattlefield` applies Contested for the MOVED
    // unit's controller, which can open a Showdown the caster never joined.
    targeting: { kind: "unitSlots", slots: ["enemy", "enemy"], min: 2, asymmetricSlots: true, secondAtDestination: true },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: movedId, secondTargetUnitInstanceId: otherId, destinationBattlefieldId } = event;
      if (!movedId || !otherId || !destinationBattlefieldId) return state;
      const moved = forceMoveToBattlefield(state, movedId, destinationBattlefieldId);

      const first = findUnitAnywhere(moved, movedId);
      const second = findUnitAnywhere(moved, otherId);
      if (!first || !second) return moved;
      const ctxFor = (loc: typeof first) =>
        loc.zone === "base" ? { isCombat: false as const } : { isCombat: false as const, battlefieldId: moved.battlefields[loc.zone.battlefieldIndex]!.id };
      const firstMight = effectiveMight(moved, first.unit, first.ownerIndex, ctxFor(first));
      const secondMight = effectiveMight(moved, second.unit, second.ownerIndex, ctxFor(second));

      const hurt = dealDamage(moved, ctx.casterIndex, otherId, firstMight);
      return dealDamage(hurt, ctx.casterIndex, movedId, secondMight);
    },
  },
  "OGN-268": {
    // Bullet Time (Body + Chaos) — "Pay any amount of [rainbow] to deal that much
    // damage to all enemy units at a battlefield."
    //
    // The pool's only X cost. X rides on the action as `xAmount` rather than
    // being counted off `payment.rainbowRunes.length`, because that bucket ALSO
    // holds a [Deflect] surcharge — a Bullet Time aimed at a battlefield holding
    // a Deflect unit would otherwise read its own X as the tax plus the payment.
    // (The two cannot actually collide today: this targets a BATTLEFIELD, and
    // Deflect taxes choosing a UNIT. Carrying X explicitly is what keeps that an
    // observation rather than a dependency.)
    //
    // "ALL ENEMY units at a battlefield" — the caster's own units there are
    // untouched, which is what makes it castable into a fight you are losing.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const amount = event.xAmount ?? 0;
      if (amount <= 0 || !event.targetBattlefieldId) return state;
      return dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, event.targetBattlefieldId, amount);
    },
  },
  "OGN-264": {
    // Guerilla Warfare (Mind + Chaos) — "Return up to two cards with [Hidden]
    // from your trash to your hand. You can hide cards ignoring costs this turn."
    //
    // The second sentence is a this-turn WAIVER, not a charge: it says "cards",
    // plural, so it is not spent by the first Hide. Read through
    // `hidden.hideCostFor`, which the enumerator, the validator and the executor
    // all price through — three sites that must agree about what a Hide costs.
    //
    // "UP TO two" is 0-2, so the spell is castable with an empty trash and does
    // only its second half. The return is taken from the front of the matching
    // cards rather than offered as a choice: every `[Hidden]` card in the trash is
    // interchangeable for the purpose ("return up to two", no restriction on
    // which), and this engine's convention is to ask only where the choice is
    // real. Recorded Unverified — a player might prefer a specific one.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const actor = state.players[ctx.casterIndex];
      // `isHiddenCard` takes a DEFINITION (the keyword is printed, not per
      // instance), so the trash card is resolved through the registry first.
      const returning = actor.trash.filter((c) => isHiddenCard(defaultCardRegistry().get(c.defId))).slice(0, 2);
      const ids = new Set(returning.map((c) => c.instanceId));
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...actor,
        trash: actor.trash.filter((c) => !ids.has(c.instanceId)),
        hand: [...actor.hand, ...returning],
        hideIgnoresCostThisTurn: true,
      };
      return { ...state, players };
    },
  },
  "OGN-254": {
    // Noxian Guillotine (Fury + Order) — "Choose a unit. Kill it the next time it
    // takes damage this turn. [Legion] -> Kill it now instead."
    //
    // **This card's second half was recorded as `[Repeat]` — a paid additional
    // cost this engine models nowhere — and it is `[Legion]`, which has been
    // implemented since Darius.** The card's own text says so ("Get the effect
    // if you've played another card this turn"); the note that blocked it was a
    // misreading, and the fix was two lines rather than a subsystem. Worth
    // stating plainly: a PARTIALLY_IMPLEMENTED entry is a claim about a card,
    // and this one was wrong for as long as nobody re-read the card.
    //
    // `countingSelf: true` — the Guillotine itself is already counted by the
    // time it resolves, since `execute-play-card` increments
    // `cardsPlayedThisTurn` when the card goes on the chain. "ANOTHER card"
    // therefore needs 2, which is exactly what the flag means.
    //
    // A DEATH SENTENCE, not damage: the unit is marked, and the next damage of
    // any size kills it however much Might it has left. Marked by instance id on
    // GameState — the same shape `deathWardedUnitInstanceIds` uses for the exact
    // opposite effect, and for the same reasons: per-unit, expires with the turn,
    // and keeping it off the unit means no helper that rebuilds a unit has to
    // remember to carry it.
    //
    // "A unit", no owner and no battlefield named, so scope "anywhere".
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      // "Kill it NOW **instead**" — the two halves are alternatives, so a Legion
      // kill never also marks. A unit that dies here is killed BY THE CASTER, so
      // "when you kill a unit" (Solari Shrine) and "with a spell" (Immortal
      // Phoenix) both see it, which the delayed half cannot promise.
      if (legionActive(state, ctx.casterIndex, true)) {
        return destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex);
      }
      return state.markedForDeathOnDamageInstanceIds.includes(event.targetUnitInstanceId)
        ? state
        : { ...state, markedForDeathOnDamageInstanceIds: [...state.markedForDeathOnDamageInstanceIds, event.targetUnitInstanceId] };
    },
  },
  "OGN-248": {
    // Icathian Rain (Fury + Mind) — "Deal 2 to a unit." x6.
    //
    // SIX separate instructions, each naming its own target, so this is six
    // ordered choices rather than "deal 12 split six ways". The rules settle both
    // halves of what that means, using their own Rocket Barrage example: valid
    // choices must be made for ALL targets before the spell goes on the chain
    // (355), and the same unit may be chosen more than once provided the caster
    // says which choice is which. So the card is uncastable with an empty board
    // and deals all 12 to a lone survivor.
    //
    // `min: 6, max: 6` — not "up to six". Nothing in the text offers fewer.
    // `scope: "anywhere"`: "a unit" is 355.9.b's bare noun, so a unit in either
    // base is a legal target, the same reading Final Spark already takes.
    targeting: { kind: "unitList", min: 6, max: 6, scope: "anywhere", allowsDuplicates: true },
    resolve: (state, ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => dealDamage(next, ctx.casterIndex, id, 2), state),
  },
  "OGN-256": {
    // Fox-Fire (Calm + Mind) — "Kill any number of units at a battlefield with
    // total Might 4 or less."
    //
    // **The PDF works this exact card**, and three things fall out of its example,
    // all load-bearing and none guessed:
    //  - **ONE battlefield.** "at a single battlefield", "units at the same
    //    battlefield" — hence `sameBattlefield`.
    //  - **EFFECTIVE Might**, so a this-turn pump or an aura changes the answer.
    //    That is the whole point of the example, in which a Reaction gives two of
    //    four chosen Recruits +1 [M] after they were chosen.
    //  - **A GROUP requirement**: the set must collectively satisfy the
    //    restriction when the card is FINALIZED, which is what `maxTotalMight`
    //    checks at announce time.
    //
    // "Any number" is genuinely `min: 0` — the rules say so outright ("If they
    // choose zero, the spell or ability can be played without any targets"), so
    // this is castable on an empty board and kills nothing.
    //
    // **The resolution-time re-choice is NOT implemented**, and it is the half the
    // PDF's example is really about: if the group stops qualifying before the
    // spell resolves, its controller "can choose a subset of the original targets
    // that fulfills the targeting requirement". Here the kill simply proceeds on
    // the units still present. Recorded in docs/rules-conformance.md — it needs a
    // mid-resolution question, which is a decision-queue shape rather than a
    // targeting one.
    //
    // Either player's units: the card names no owner, and killing your own is a
    // real (if rare) play — clearing a battlefield you are about to lose.
    targeting: { kind: "unitList", min: 0, sameBattlefield: true, maxTotalMight: 4 },
    resolve: (state, _ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => destroyUnit(next, id), state),
  },
  "OGN-270": {
    // Showstopper (Body + Order) — "Buff a friendly unit in your base, then move
    // it to a battlefield."
    //
    // `scope: "base"` is the narrowest targeting in the pool and it is
    // load-bearing, not decoration: under the usual battlefield scope the card
    // would offer a unit already at a battlefield and "then move it" would be a
    // sideways shuffle rather than the deploy the card is for. It is also what
    // makes the spell honestly uncastable with an empty base.
    //
    // Buff FIRST, then move — printed order, and it matters rather than being
    // pedantry: Sett - Kingpin counts buffed friendly units AT HIS BATTLEFIELD,
    // so a unit that arrives already buffed is worth a point of his Might the
    // moment it lands. Doing it the other way round would still buff the right
    // unit, but through an intermediate state the card never describes.
    targeting: { kind: "unit", owner: "friendly", scope: "base" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId && event.destinationBattlefieldId
        ? forceMoveToBattlefield(addBuff(state, event.targetUnitInstanceId), event.targetUnitInstanceId, event.destinationBattlefieldId)
        : state,
  },
  "OGN-266": {
    // Siphon Power (Mind + Order) — "Choose a battlefield. Give friendly units
    // there +1 Might this turn and enemy units there -1 Might this turn, to a
    // minimum of 1 Might."
    //
    // "THERE" on both halves, so this is strictly positional — nothing in base
    // moves. The floor is printed on the debuff half only, and applied per unit
    // by giveMightThisTurn.
    //
    // Both halves resolve off the SAME battlefield snapshot taken before either
    // is applied. Nothing here kills, so the lists cannot shrink, but reading
    // them once is what keeps that true if a modifier ever does.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const bf = state.battlefields.find((b) => b.id === event.targetBattlefieldId);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const friendly = (bf.units[casterId] ?? []).map((u) => u.instanceId);
      const enemy = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const pumped = friendly.reduce((next, id) => giveMightThisTurn(next, id, 1), state);
      return enemy.reduce((next, id) => giveMightThisTurn(next, id, -1, 1), pumped);
    },
  },
  "OGN-262": {
    // Zenith Blade (Calm + Order) — "[Action] Stun an enemy unit at a
    // battlefield. You may move a friendly unit to that enemy unit's
    // battlefield."
    //
    // `min: 1`: the stun is mandatory, the move is "you may". That is exactly
    // what a two-slot spec with a minimum of one expresses — enumeration offers
    // both the stun-only variant and every stun+move pair, so declining is a
    // real choice rather than a target the player leaves blank.
    //
    // `slotScopes` because the two halves are scoped differently in print: the
    // enemy is "at a battlefield", the friendly is not, and the friendly you
    // most want to send is the one standing in base. Reading one scope for both
    // would either forbid that or make the enemy targetable in their own base.
    //
    // The destination is NOT chosen — it is "that enemy unit's battlefield",
    // read off the board at resolution. A unit that has left the battlefield in
    // between (killed on the chain, moved) leaves nothing to move to, and the
    // stun still happens: the move is the optional half.
    //
    // forceMoveToBattlefield, not the MoveUnit executor: 415.1.b puts the
    // exhaust on the Standard Move ACTION, so a unit sent by a spell arrives
    // ready, and 458 contests the destination for the MOVED unit's controller.
    // Here that is the caster's own unit walking into the enemy's battlefield,
    // which is the whole point of the card.
    targeting: {
      kind: "unitSlots",
      slots: ["enemy", "friendly"],
      min: 1,
      slotScopes: ["battlefield", "anywhere"],
    },
    resolve: (state, ctx, event) => {
      const enemyId = event.targetUnitInstanceId;
      if (!enemyId) return state;
      // Where the enemy is must be read BEFORE the stun, not because stunning
      // moves anything (it does not) but because Eclipse Herald and Leona fire
      // inside stunUnits and either could kill or relocate it.
      const enemyBattlefield = findUnitOnBattlefield(state, enemyId);
      const stunned = stunUnits(state, ctx.casterIndex, [enemyId]);

      const friendlyId = event.secondTargetUnitInstanceId;
      if (!friendlyId || !enemyBattlefield) return stunned;
      return forceMoveToBattlefield(stunned, friendlyId, state.battlefields[enemyBattlefield.battlefieldIndex]!.id);
    },
  },
  "OGN-260": {
    // Last Breath (Calm + Chaos) — "[Action] Ready a friendly unit. It deals
    // damage equal to its Might to an enemy unit at a battlefield."
    //
    // `slotScopes`, the second card in the pool to need them (Zenith Blade above
    // is the first) and for the same printed reason: the enemy is "at a
    // battlefield" and the friendly is not. The unit you most want to ready is
    // usually the exhausted one sitting at home, and a single scope would either
    // forbid that or make the enemy reachable in their own base.
    //
    // `min: 2` — BOTH halves are mandatory and both are targets, so 355.8 settles
    // castability outright: "in order to put a spell or ability on the chain,
    // valid choices must be made for all targets." This is not a "do as much as
    // you can" card the way Back to Back's "two friendly units" is; there is no
    // "up to" anywhere in the text, so with no enemy at a battlefield the spell
    // simply cannot be played, ready or no ready.
    //
    // Ready FIRST, then damage — printed order. Nothing in this pool makes
    // readying change a Might, so the two orders agree today; doing it in the
    // card's order is what keeps that true when something does (and it is the
    // order a player watching the board expects).
    //
    // Might is read through effectiveMight at resolution, like Gentlemen's Duel's
    // exchange: buffs, this-turn modifiers and continuous auras all count, and
    // the damage lands from the CASTER (`ctx.casterIndex`) because the unit
    // dealing it is theirs — which is what feeds Annie - Fiery's damage bonus.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      if (!friendlyId) return state;
      const readied = readyUnit(state, friendlyId);

      const enemyId = event.secondTargetUnitInstanceId;
      if (!enemyId) return readied;
      // Located AFTER the ready rather than before, so the Might read is the one
      // the board holds at the moment the damage is dealt.
      const location = findUnitAnywhere(readied, friendlyId);
      if (!location) return readied; // it left play while this sat on the chain
      const might = effectiveMight(
        readied,
        location.unit,
        location.ownerIndex,
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: readied.battlefields[location.zone.battlefieldIndex]!.id },
      );
      return dealDamage(readied, ctx.casterIndex, enemyId, might);
    },
  },
  "OGN-250": {
    // Stormbringer (Fury + Body) — "Choose a friendly unit in your base. Deal
    // damage equal to its Might to all enemy units at a battlefield, then move
    // your unit there."
    //
    // Showstopper's exact shape: a `unit` target scoped to BASE plus a
    // battlefield riding on `destinationBattlefieldId`, which is only enumerated
    // for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS. Registering
    // this without that entry would be worse than leaving the card dead — it
    // would be castable, the destination would always arrive undefined, and
    // coverage would report a card that does nothing as done.
    //
    // `scope: "base"` is printed ("in your base") and load-bearing for the same
    // reason as Showstopper's: "then move your unit there" is a deploy, and a
    // unit already at a battlefield would make it a sideways shuffle.
    //
    // **Damage FIRST, then move, and the order is the card.** The unit is in
    // BASE while it fires, so it is not at the battlefield it is bombarding —
    // which means it takes nothing back, and it is not counted among "all enemy
    // units at a battlefield" by anything reading that battlefield's occupants.
    // Moving first would walk it into a fight it then damages from inside.
    //
    // Might is read ONCE, before the damage, and read EFFECTIVE (auras and
    // this-turn pumps count, `isCombat: false` because this is not a Showdown —
    // the same reading Gentlemen's Duel and Last Breath already take). Reading it
    // per target would let the first kill's Deathknell change what the rest take.
    targeting: { kind: "unit", owner: "friendly", scope: "base" },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: unitId, destinationBattlefieldId: destination } = event;
      if (!unitId || !destination) return state;
      const location = findUnitAnywhere(state, unitId);
      if (!location) return state;

      const might = effectiveMight(state, location.unit, ctx.casterIndex, { isCombat: false });
      const bf = state.battlefields.find((b) => b.id === destination);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const enemyIds = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const bombarded = enemyIds.reduce((next, id) => dealDamage(next, ctx.casterIndex, id, might), state);
      // "THEN move your unit there" — unconditional, so the unit deploys even if
      // the damage killed nothing and even if it killed everything. Through
      // forceMoveToBattlefield, which is what applies Contested and stages the
      // Showdown; a raw list splice would deploy it into a fight that never opens.
      return forceMoveToBattlefield(bombarded, unitId, destination);
    },
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-252": {
    // Super Mega Death Rocket! (Fury + Chaos) — "Deal 5 to a unit. When you
    // conquer, you may discard 1 to return this from your trash to your hand."
    //
    // The second sentence fires FROM THE TRASH, which is why `Listener` had to
    // reach beyond the board at all — no walk of permanents can see a spell in a
    // graveyard. `zone === "trash"` is asserted rather than assumed: the same
    // card sitting in HAND must not fire, and nothing else distinguishes them.
    //
    // "When YOU conquer" is the LEGEND's reading, not a unit's — a spell in the
    // trash is at no battlefield, so there is no "here" for it to be at. That is
    // the difference between this and Kai'Sa - Survivor's "when I conquer", and
    // it is why the two cannot share a condition.
    //
    // "You may DISCARD 1" is a cost, so nothing is asked with an empty hand
    // (416.3) — and that check is what stops the question appearing on every
    // conquest for the rest of the game.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.zone === "trash" &&
      state.players[listener.ownerIndex].hand.length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (state.players[listener.ownerIndex].hand.length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-252-return",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
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
  // Super Mega Death Rocket's "you may discard 1 to return this from your trash
  // to your hand", raised by its conquer trigger.
  //
  // Declining leads. The discard goes through `discardCards`, so anything
  // watching a discard (Jinx - Rebel's "when you discard one or more cards")
  // still fires — being spent as a cost is still a discard, the same reasoning
  // Cruel Patron's kill records.
  "OGN-252-return": {
    prompt: () => "Super Mega Death Rocket!: discard 1 to return it from your trash to your hand?",
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "discard", label: "Discard 1 and return it" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "discard" || !d.cardInstanceId) return state;
      const discarded = discardCards(state, d.playerIndex, 1);
      const actor = discarded.players[d.playerIndex];
      const rocket = actor.trash.find((c) => c.instanceId === d.cardInstanceId);
      // Gone from the trash between the trigger and the answer — a second copy
      // of this same question, or anything that churned the trash. The discard
      // has already been paid, which is the rules' own order for a cost.
      if (!rocket) return discarded;
      const players = [...discarded.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        trash: actor.trash.filter((c) => c.instanceId !== d.cardInstanceId),
        hand: [...actor.hand, rocket],
      };
      return { ...discarded, players };
    },
  },};
