import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellDefinition, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import {
  addBuff,
  banishCard,
  borrowUnitInPlace,
  dealDamage,
  destroyUnit,
  legionActive,
  dealDamageToEnemyUnitsAtBattlefield,
  discardCards,
  drawCards,
  forceMoveToBattlefield,
  forceMoveToDestination,
  giveMightThisTurn,
  grantTriggerThisTurn,
  giveMightThisTurnToOwnUnit,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recallUnitToBase,
  removeUnitAnywhere,
  stunUnits,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { isHiddenCard } from "../hidden.js";
import { parkDecision } from "../decisions.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import type { CardInstance, GearInstance, UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { attachEquipment, isEquipmentGear, isMechUnit } from "../equipment.js";
import { SAND_SOLDIER_TOKEN, placeToken, type TokenDestination } from "../token.js";

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
const DANGER_ZONE_MIGHT = 1;

/**
 * The event-trigger registry key Relentless Pursuit grants — "When I conquer,
 * you may move me to my base."
 *
 * A named constant because it is written in two places that must agree: the
 * resolver that grants it and the registry entry that answers to it. A typo in
 * either would be SILENT — the grant would name an ability nothing implements,
 * and the unit would simply never trigger, which reads exactly like a card that
 * was never played.
 */
const RELENTLESS_PURSUIT_GRANT = "SFD-184-conquer-home";

export const cardEffects: Record<string, EffectDefinition> = {
  "SFD-182": {
    // Danger Zone (Fury + Mind) — "[Reaction] [Repeat] [1][rainbow] Give your
    // Mechs +1 Might this turn."
    //
    // Tribal, and the tag is PRINTED, so the filter is a definition-level
    // question — the same `tags.includes("Mech")` that granted-keywords.ts's
    // `isMech` asks for the three tribal keyword auras. Spelled out here rather
    // than imported because that predicate takes a DEFINITION and this walks
    // live `UnitInstance`s, which carry their own `tags`.
    //
    // **This is the card that the tribal-aura bug of 2026-08-06 was about**: three
    // auras granted their keyword to EVERY friendly unit because they consulted
    // `appliesTo` and never `appliesToDef`, and every test for them passed
    // because each only asserted that the Mech got the keyword. So the assertion
    // that matters for this card is the NEGATIVE — a non-Mech friendly gets
    // nothing — and the test carries it.
    //
    // "YOUR Mechs", so no enemy Mech is pumped and there is no "here": a Mech in
    // base is pumped too, which is `ownUnitsEverywhere`'s whole reason for
    // reaching both zones.
    //
    // `kind: "none"`: the card names no target, it names a GROUP. Nothing is
    // chosen, so 820.1.d's "may make different choices" has nothing to vary —
    // repeating this is simply +1 twice to whatever Mechs are standing when each
    // execution runs, and the second execution reads the board the first left.
    //
    // A caster with no Mechs at all still casts it for nothing; the group is the
    // instruction, not a condition on it.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => isMechUnit(state, u))
        .reduce((next, u) => giveMightThisTurn(next, u.instanceId, DANGER_ZONE_MIGHT), state),
  },
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
      const { targetUnitInstanceId: movedId, secondTargetUnitInstanceId: otherId } = event;
      if (!movedId || !otherId) return state;
      // The destination may be a BASE, and then "another enemy unit at its
      // destination" is another unit standing in that same base — which
      // `secondTargetIsAtDestination` has already enforced at announce.
      const moved = forceMoveToDestination(state, movedId, event);

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
    // forceMoveToBattlefield, not the MoveUnit executor: 414.3.a puts the
    // exhaust on the Standard Move ACTION, so a unit sent by a spell arrives
    // ready, and 450 contests the destination for the MOVED unit's controller.
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
  "SFD-196": {
    // Defiant Dance (Calm + Chaos) — "[Reaction] Give a unit +2 [M] this turn and
    // another unit -2 [M] this turn."
    //
    // `asymmetricSlots` is the whole correctness of this card and it is easy to
    // miss: both slots take the role "any", so without the flag `legal-actions`
    // prunes (B,A) once it has offered (A,B) — and here the two slots do OPPOSITE
    // things, so half the card would be unreachable. Exactly Convergent Mutation's
    // reasoning, and the second card in the pool to need it.
    //
    // `min: 2` — nothing says "up to", so 355.8 settles castability: valid choices
    // must be made for all targets before the spell goes on the chain, which makes
    // this uncastable with fewer than two units in play. The two chosen units are
    // always DISTINCT under `unitSlots`, which is what "ANOTHER unit" wants.
    //
    // `scope: "anywhere"`: "a unit" is 355.9.b's bare noun, so either player's base
    // is in reach — and either player's unit, since the card names no owner. Buffing
    // an enemy is legal and occasionally right (feeding a -2 to something that
    // matters more), so nothing narrows it here.
    //
    // NO floor on the debuff. Smoke Screen and Siphon Power print "to a minimum of
    // 1 [M]" and this does not, so `giveMightThisTurn` is called without one — a
    // 2-Might unit taken to 0 dies to the next point of damage, which is the card.
    targeting: { kind: "unitSlots", slots: ["any", "any"], min: 2, scope: "anywhere", asymmetricSlots: true },
    resolve: (state, _ctx, event) => {
      const pumped = event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 2) : state;
      return event.secondTargetUnitInstanceId ? giveMightThisTurn(pumped, event.secondTargetUnitInstanceId, -2) : pumped;
    },
  },
  "SFD-204": {
    // On the Hunt (Body + Chaos) — "Ready your units."
    //
    // "YOUR units", no location named, so base and every battlefield —
    // `ownUnitsEverywhere` is exactly that walk. Gear and the Legend are NOT
    // readied: the card says units, and `readyPermanent` exists precisely for the
    // card (Miss Fortune - Captain) that names no type.
    //
    // The id list is snapshotted BEFORE the first ready rather than re-walked per
    // step. Nothing here can remove a unit today — but `readyUnit` holds a
    // `unitReadied` event, and Pirate's Haven answers it, so the list this
    // instruction applies to is the one that existed when it began.
    //
    // One event PER UNIT, not one for the instruction, and that is the primitive's
    // contract rather than a choice made here: `unitReadied` is per-unit at all
    // thirteen call sites and the Awaken already fires one per exhausted unit, which
    // is what Pirate's Haven's "give IT +1 [M]" is written against. (Contrast
    // `unitsStunned`, which is batched because Leona reads "one or more".)
    //
    // Rule 415's already-Ready guard lives inside `readyUnit`, so a board that was
    // already awake produces no events and no Might.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .map((u) => u.instanceId)
        .reduce((next, id) => readyUnit(next, id), state),
  },
  "SFD-194": {
    // Counter Strike — "[Reaction] Choose a unit. The NEXT time that unit would
    // be dealt damage this turn, prevent it. Draw 1."
    //
    // The pool's first PER-UNIT, single-use prevention.
    // `preventsSpellDamageThisTurn` is the neighbouring shape and is a different
    // card: it is per-PLAYER and unlimited for the turn. This is one instance on
    // one unit and is then spent, which is what "the next time" means — so the
    // id is REMOVED by `dealDamage` when it fires rather than filtered at end of
    // turn.
    //
    // "Choose A UNIT", unqualified — either side's. Shielding your own attacker
    // and blanking an enemy's removal are both real plays, and `[Reaction]`
    // timing is what makes the second one possible.
    //
    // The id is PUSHED rather than set: two Counter Strikes on one unit prevent
    // two instances, because each is its own "next time".
    //
    // The draw is unconditional and on its own line (135.2.b), so it happens
    // even if the chosen unit is never damaged.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const shielded =
        event.targetUnitInstanceId === undefined
          ? state
          : {
              ...state,
              damagePreventedOnceInstanceIds: [
                ...state.damagePreventedOnceInstanceIds,
                event.targetUnitInstanceId,
              ],
            };
      return drawCards(shielded, ctx.casterIndex, 1);
    },
  },
  "SFD-200": {
    // Arcane Shift (Mind + Chaos) — "[Action] Banish a friendly unit, then its
    // owner plays it, ignoring its cost. Deal 3 to an enemy unit at a battlefield.
    // Banish this."
    //
    // Last Breath's slot shape, and for the same printed reason: the enemy is "at a
    // battlefield" and the friendly is not, so the two halves are scoped
    // differently. `min: 2` because neither half says "up to" — 355.8 again.
    //
    // **A BLINK, and it differs from Portal Rescue's by one printed word.** Portal
    // Rescue reads "plays it TO THEIR BASE" and so calls `playUnitToBase`; this one
    // says only "plays it", which is the ordinary permission — so it goes through
    // `playUnitFree`, which offers the destinations a paid play would have offered.
    // Reading the two the same way would silently delete the card's best line
    // (blinking a unit onto a battlefield you already hold).
    //
    // The banish is TRANSIENT — banished and replayed in one instruction, nothing
    // can observe the middle zone — so the unit goes straight to play rather than
    // through `PlayerState.banished`. "BANISH THIS" is the other kind: the spell
    // genuinely stays there, which is why `banishCard` is called for it and not for
    // the unit. Time Warp is the only other real writer of that zone.
    //
    // A fresh copy, exactly as Portal Rescue rebuilds one: 705 strips the Buff on
    // leaving play, and damage / this-turn Might / stun are properties of the body
    // that left.
    //
    // **Known ordering wrinkle, inherited rather than introduced:** when the blinked
    // unit has more than one legal destination, `playUnitFree` PARKS the question,
    // so the damage below lands before the unit actually arrives. The card's printed
    // order is play-then-damage. Nothing in this pool can observe the difference
    // (the damage target is an enemy, chosen at announce time), but it is a real
    // deferral and not a claim that the order is preserved.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      const found = friendlyId ? findUnitAnywhere(state, friendlyId) : undefined;
      let next = state;
      if (friendlyId && found) {
        const returning: UnitInstance = {
          ...found.unit,
          damage: 0,
          mightThisTurn: 0,
          buffed: false,
          stunned: false,
          movesThisTurn: 0,
        };
        // "ITS OWNER plays it", not the caster — `found.ownerIndex`, the same
        // reading Portal Rescue takes. Friendly-only targeting makes the two the
        // same player today; naming it is what keeps that an observation.
        next = playUnitFree(removeUnitAnywhere(state, friendlyId), found.ownerIndex, returning);
      }

      const enemyId = event.secondTargetUnitInstanceId;
      if (enemyId) next = dealDamage(next, ctx.casterIndex, enemyId, 3);
      // "Banish this" — the spell is already in the caster's trash by now (the
      // ordinary cast path trashes at announce), and `banishCard` looks there.
      return ctx.sourceCardInstanceId ? banishCard(next, ctx.casterIndex, ctx.sourceCardInstanceId) : next;
    },
  },
  "SFD-188": {
    // Void Rush (Fury + Order) — "Reveal the top 2 cards of your Main Deck. You may
    // banish one, then play it, reducing its cost by [2 Energy]. Draw any you
    // didn't banish."
    //
    // Baited Hook's structure — look at the top of the deck, optionally banish one
    // and play it, then dispose of the rest — with one difference that is the whole
    // card: the play is DISCOUNTED, not free. Nothing in the pool had done that
    // before, which is why `voidRushPayment` below is written out rather than
    // borrowed; The Harrowing and Soulgorger waive the Energy half outright and
    // Immortal Phoenix pays a fixed printed price.
    //
    // "REVEAL" is informational only. This engine has no per-player hidden view of
    // a deck, so revealing is not a state change; what the decision offers IS the
    // reveal, and the option list is the two cards.
    //
    // Parked rather than resolved inline, because "you may banish ONE" is a genuine
    // choice between two cards and a spell's resolution has no action to carry it.
    // With nothing affordable the list is a lone "decline" and `advanceDecisions`
    // retires it without a prompt — so a board that cannot pay simply draws both.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-188-banish", playerIndex: ctx.casterIndex }),
  },
  "SFD-206": {
    // Riposte (Body + Order) — "[Reaction] Choose a friendly unit AND a spell.
    // Counter that spell and give that unit +[Might] equal to that spell's
    // Energy cost this turn."
    //
    // # Both targets are announced, which is the whole of the card's shape
    //
    // It names TWO targets in one sentence, so it gets the `chainSpellAndUnit`
    // spec rather than a `chainSpell` plus a question asked at resolution. The
    // difference is not cosmetic: 355.8 makes a card with no legal target
    // **uncastable**, so printed Riposte cannot be played with no friendly unit
    // on the board, and choosing the unit later would make it castable in a state
    // the rules forbid — wider than printed. `riposte.test.ts` asserts the card is
    // NOT offered on an empty board, which is the assertion that would go red if
    // anyone re-approximated this.
    //
    // The response window is announced with it for the same reason: an opponent
    // seeing Riposte go on the chain knows which unit it will grow, and can
    // respond to that, exactly as in paper.
    //
    // # The rest
    //
    // **The Energy cost is read BEFORE the counter**, because `counterSpell` takes
    // the entry off the chain and the amount would be unrecoverable after. PRINTED
    // Energy, not what was paid — the same reading `matchesCostFilter` already
    // applies for Defy's cost filter, so a Repeat-boosted spell still gives its
    // printed number.
    //
    // **"A friendly unit" is a bare noun**, so `scope: "anywhere"` — 355.9.b's
    // reading reaches base, the same reading Blitzcrank - Impassive already uses.
    //
    // A vanished target is a no-op on both halves: two counters can name the same
    // spell and the second finds nothing, which `counterSpell`'s own comment calls
    // out as a real case rather than defensive padding. No spell means no cost to
    // read, so there is nothing to give either — and `giveMightThisTurnToOwnUnit`
    // re-checks ownership, so a unit that changed hands between announce and
    // resolution is not buffed by its new owner's opponent.
    targeting: { kind: "chainSpellAndUnit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetChainCardInstanceId || !event.targetUnitInstanceId) return state;
      const target = spellsOnChain(state).find((e) => e.entry.card.instanceId === event.targetChainCardInstanceId);
      if (!target) return state;
      const amount = target.entry.card.energyCost;
      const countered = counterSpell(state, event.targetChainCardInstanceId);
      return giveMightThisTurnToOwnUnit(countered, ctx.casterIndex, event.targetUnitInstanceId, amount);
    },
  },
  "SFD-202": {
    // Hostile Takeover (Mind + Order) — "[Hidden] Take control of an enemy unit
    // at a battlefield. Ready it. (Start a combat if other enemies are there.
    // Otherwise, conquer.) Lose control of that unit and recall it at end of
    // turn. (Send it to base. This isn't a move.)"
    //
    // # What was actually missing
    //
    // `takeControlOfUnit` existed and is the wrong half of the card: it recalls to
    // the taker's BASE, which is what makes Possession's permanent theft safe, and
    // this card's whole parenthetical is about the unit staying where it stands.
    // `borrowUnitInPlace` is that half — it leaves the unit at the battlefield and
    // applies Contested for its new controller (190.3.a's "or otherwise becomes
    // present"), which is what "start a combat if other enemies are there,
    // otherwise conquer" describes. Both outcomes fall out of Contested rather
    // than being branched on here: the Cleanup opens a Combat Showdown when both
    // players have units present and a Non-Combat one when they do not, and 348.2.a
    // is what turns the second into a conquest.
    //
    // The REVERSAL genuinely did not exist, exactly as the handoff said. In this
    // engine control IS which player's list a unit sits in — the row
    // docs/rules-conformance.md carries — so a stolen unit is indistinguishable
    // from an owned one and nothing could ever give it back. One optional field on
    // the unit (`returnControlAtEndOfTurnToIndex`) is the whole of the memory that
    // model lacked, and `runEnd` discharges it.
    //
    // # The ready, and the order
    //
    // "Ready it" AFTER the theft, printed order, and it matters: `readyUnit` is
    // gated by `mayReadyPermanent`, which refuses to ready an ENEMY unit under
    // Mageseeker Warden. By the time this runs the unit is ours, so the Warden
    // does not bite — which is right, since it is our unit being readied.
    //
    // A ready is also what makes the borrowed body worth having: it arrives on our
    // side able to fight, where a unit that had already attacked this turn would
    // otherwise stand exhausted.
    //
    // `scope` left at its default, so "an enemy unit AT A BATTLEFIELD" is enforced
    // by the targeting and a unit sheltering in the opponent's base is out of
    // reach — the same reading Possession takes of the same phrase.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const borrowed = borrowUnitInPlace(state, event.targetUnitInstanceId, ctx.casterIndex);
      return readyUnit(borrowed, event.targetUnitInstanceId);
    },
  },
  "SFD-184": {
    // Relentless Pursuit (Fury + Body) — "[Action] Move a friendly unit. You may
    // attach an Equipment with the same controller to it. This turn, that unit
    // has 'When I conquer, you may move me to my base.'"
    //
    // # Three instructions, three mechanisms, all chosen at ANNOUNCE time
    //
    // The MOVE rides `destinationBattlefieldId` through
    // `MOVE_TARGET_SPELL_DEF_IDS`, the same field Charm and Ride The Wind use.
    //
    // The ATTACH is `unitAndEquipment` with `optionalEquipment`, which is new
    // here: Angle Shot's version requires both halves and constrains neither
    // owner. Fanned out rather than asked at resolution, which is the standing
    // rule for an attach in this engine — `attachesEquipment` and
    // `attachesFromTargetToSelf` both do it, and 355 makes the Equipment a target
    // whose announcement an opponent can respond to.
    //
    // The GRANT is `grantTriggerThisTurn`, and it is the pool's first ability
    // given to a unit rather than a keyword or a number. The handoff that scoped
    // this card said "nothing grants a triggered ability" and named
    // `keywordsThisTurn` as the nearest shape; what it needed was one sibling
    // field holding a REGISTRY KEY, so the granted ability is written in the same
    // table a printed one is and resolves through the same path.
    //
    // # The order
    //
    // Move, then attach, then grant — the order the card prints them in. Only the
    // first two could interact and they do not: attaching reads no location.
    //
    // A vanished target is a no-op throughout: the unit can be killed in response
    // to the announcement, and each helper already answers safely for a unit it
    // cannot find.
    targeting: { kind: "unitAndEquipment", relation: "attachable", owner: "friendly", optionalEquipment: true },
    resolve: (state, ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const moved = forceMoveToDestination(state, unitId, event);
      // Attached by the PAIR's controller, not the caster's — "with the same
      // controller" relates the Equipment to the unit, and `attachEquipment`
      // writes into that player's `activeGear`. Angle Shot's note records the
      // same reasoning; passing the caster there looked for an enemy's gear in
      // our own list.
      const owner = findUnitAnywhere(moved, unitId);
      const attached =
        event.targetPermanentInstanceId !== undefined && owner !== undefined
          ? attachEquipment(moved, owner.ownerIndex, event.targetPermanentInstanceId, unitId)
          : moved;
      return grantTriggerThisTurn(attached, unitId, RELENTLESS_PURSUIT_GRANT);
    },
  },
  "SFD-198": {
    // Arise! (Calm + Order) — "Play a 2 [Might] Sand Soldier unit token for each
    // Equipment you control. Then do this: Ready up to two of them."
    //
    // # The count is the board's, read at resolution
    //
    // "For each Equipment you control" is `equipmentControlledBy` — the caster's
    // `activeGear` filtered to Equipment. It counts DETACHED Equipment too: the
    // card says control, not "attached", and a piece of gear sitting unworn in
    // `activeGear` is controlled just as much as one on a unit. It also counts an
    // Equipment taken from an opponent, because control is what `activeGear`
    // membership means here — the row rules-conformance.md carries about control
    // being which list a permanent sits in.
    //
    // Read at RESOLUTION rather than when the spell is announced, which is the
    // default for everything a resolver reads and matters here because a spell in
    // response can kill the gear.
    //
    // # The destination
    //
    // **Not a per-token choice.** The handoff that scoped this card said Arise!
    // shared Vanguard Armory's per-token destination axis; the printed text does
    // not — Vanguard Armory prints "(You may play them to different locations.)"
    // and this card prints no parenthetical at all. So it takes Recruit the
    // Vanguard's shape instead: one chosen destination for all of them, riding
    // `destinationBattlefieldId`, with SFD-198 added to
    // `TOKEN_PLACEMENT_SPELL_DEF_IDS` so the enumerator and the validator agree
    // about which battlefields are legal ("ones you CONTROL", which is stricter
    // than the Unit deploy rule).
    //
    // # "Ready up to two of them"
    //
    // Maxed out rather than asked, and `readyRunes` is the precedent that settles
    // it: readying is strictly beneficial and never wrong, so taking all of it IS
    // the faithful implementation of "up to N". Here the tokens are also
    // INDISTINGUISHABLE — same 2 Might, same tag, minted in the same instant — so
    // "which two" is not a choice a player could answer differently to any effect.
    //
    // "Of THEM" is the tokens this spell just made, so the ids are captured from
    // the placement rather than re-derived from the board afterwards: a Sand
    // Soldier already standing there from Desert's Call is not one of them.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const destination: TokenDestination =
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base";
      const count = equipmentControlledBy(state, ctx.casterIndex).length;
      let next = state;
      const placed: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const before = new Set(ownUnitsEverywhere(next, ctx.casterIndex).map((u) => u.instanceId));
        next = placeToken(next, ctx.casterIndex, destination, SAND_SOLDIER_TOKEN);
        // One at a time and diffed each time, the same recovery `placeSandSoldier`
        // in effects/order.ts uses and for the same reason: `placeToken` returns
        // only the state, and a token minted with a fresh instanceId is the only
        // new id in the caster's units. Undefined when nothing landed —
        // `placeToken` no-ops on a battlefield id that names nothing.
        const token = ownUnitsEverywhere(next, ctx.casterIndex).find((u) => !before.has(u.instanceId));
        if (token) placed.push(token.instanceId);
      }
      return placed.slice(0, ARISE_READY_COUNT).reduce((s, id) => readyUnit(s, id), next);
    },
  },
};

/** Arise!'s "ready up to two of them". */
const ARISE_READY_COUNT = 2;

/**
 * Every Equipment `playerIndex` controls — `activeGear` filtered by the printed
 * Equipment tag.
 *
 * Its own function rather than the filter written inline, because "an Equipment
 * you control" is a phrase two cards in this set count and one of them is priced
 * off it. Attached or not: the phrase says control, and `activeGear` membership
 * is what control means for a permanent here.
 */
function equipmentControlledBy(state: GameState, playerIndex: 0 | 1): GearInstance[] {
  return state.players[playerIndex].activeGear.filter((g) => isEquipmentGear(g));
}

/** Void Rush's "reducing its cost by [2 Energy]". */
const VOID_RUSH_DISCOUNT = 2;

/** The two cards Void Rush reveals — read live rather than captured on the
 *  decision, because `PendingDecision` has no field for a card list and the deck
 *  cannot move between parking this question and answering it (a spell's
 *  resolution is one submit). A question queued BEHIND one that draws would see a
 *  different pair; nothing in this pool can produce that shape. */
function voidRushRevealed(state: GameState, playerIndex: 0 | 1): CardInstance[] {
  return state.players[playerIndex].deck.slice(0, 2);
}

/**
 * Pays a revealed card's cost with Void Rush's [2 Energy] taken off, or
 * `undefined` when the pool cannot cover it — the same contract
 * `payPowerFromChanneled` and `spendBuff` use, so an unpayable card is never
 * offered rather than offered and then played free.
 *
 * **POWER FIRST, then Energy**, and the order is not arbitrary:
 * `payPowerFromChanneled` recycles the rune and banks 1 floating Energy for one
 * that was still Ready, which is the same "a Ready rune spent on Power still
 * counts toward the Energy cost" arithmetic `computeAutoPayment` does. Paying
 * Energy first would exhaust that rune and lose the credit, refusing plays the
 * ordinary cost pipeline allows.
 *
 * The discount is applied AFTER the cross-cutting modifiers (`modifiedEnergyCost`)
 * rather than to the printed number, matching how `modifiedEnergyCost` already
 * orders its own conditional discounts against the printed cost, and floored at 0.
 *
 * **Three named limitations, all inherited from `payPowerFromChanneled` and all
 * UNDER-offering** — the card is withheld, never handed over unpaid:
 *  - Floating Power is not counted, only the channeled pool.
 *  - A split Power pip (`powerDomainAlt`) is tried as all-primary, then as
 *    all-alt; a MIXED payment (one Fury and one Order for a 2-Power hybrid) is not
 *    attempted, because the helper takes a single domain and widening it is a
 *    change to effect-helpers.ts. That matters more here than it did for The
 *    Harrowing, since SFD prints hybrid pips freely.
 *  - A Legend can never be in a Main Deck, so it is refused rather than priced.
 */
function voidRushPayment(state: GameState, playerIndex: 0 | 1, card: CardInstance): GameState | undefined {
  if (card.kind === "Legend") return undefined;

  let paid: GameState | undefined = state;
  if (card.powerCost > 0) {
    paid =
      payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost) ??
      (card.powerDomainAlt !== undefined
        ? payPowerFromChanneled(state, playerIndex, card.powerDomainAlt, card.powerCost)
        : undefined);
  }
  if (!paid) return undefined;

  const energy = Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - VOID_RUSH_DISCOUNT);
  return payEnergyFromPool(paid, playerIndex, energy);
}

/** What one revealed card's option says it costs, so the two prices a player is
 *  choosing between are visible rather than implied. */
function voidRushLabel(state: GameState, playerIndex: 0 | 1, card: CardInstance): string {
  if (card.kind === "Legend") return card.name;
  const energy = Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - VOID_RUSH_DISCOUNT);
  const power = card.powerCost > 0 ? `, ${card.powerCost} ${card.powerDomain ?? "any"} Power` : "";
  return `Banish and play ${card.name} (pay ${energy} Energy${power})`;
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {};

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
  /**
   * The ability Relentless Pursuit GRANTS — "When I conquer, you may move me to
   * my base."
   *
   * **Keyed by a grant key rather than by a defId**, which is the whole shape of
   * the mechanism: nothing on the board has the defId `SFD-184` (the spell is in
   * a trash by the time this can fire, and no trash listener walks it), so the
   * key names an ability rather than a card. `grantTriggersThisTurn` writes it
   * onto the unit and `triggers.triggerKeysOn` is what makes the listener walk
   * match it. Registering it under the bare `SFD-184` would have worked by
   * accident and read as a printed conquer trigger the spell does not have.
   *
   * **"When I conquer" is positional**, the reading every other "when I" in this
   * pool takes: the battlefield conquered must be the one the granted unit is
   * standing at, and the conqueror must be its controller.
   *
   * **"You MAY move me"** — a decision, not a freebie, and this one genuinely can
   * be wrong to take: leaving is giving up the battlefield you just took, which
   * is why a card that pushes a unit forward pairs it with a way home. Declining
   * leads, as everywhere else a "you may" is asked.
   *
   * "To my base" is `recallUnitToBase`, the helper Flash and Maddened Marauder
   * use — so it exhausts, and it is refused by Vilemaw's Lair's "units can't move
   * from here to base". Both are that helper's behaviour rather than choices
   * made here; the exhaustion question is already filed as Unverified in
   * docs/rules-conformance.md against those two cards, and this card inherits it
   * rather than adding a second reading.
   */
  [RELENTLESS_PURSUIT_GRANT]: {
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: "SFD-184-home",
        playerIndex: listener.ownerIndex,
        targetInstanceId: listener.card.instanceId,
      }),
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "SFD-192": {
    // Shurelya's Requiem (Calm + Mind) — "[Unique] [Equip] :rainbow:. When you
    // play this, ready your units."
    //
    // **HALF a card, deliberately, and the other half is not writable here.** Its
    // `[Equip]` cost is a RAINBOW rune, and `ActivationCost.power` names one
    // `Domain` — rainbow is not one. So `equipAbilities()` skips it by name along
    // with the other three rainbow-cost Equipment, and this Gear can be played and
    // will fire the clause below, but can never attach by its own ability.
    // `coverage.PARTIALLY_IMPLEMENTED` already carries exactly that note for this
    // defId, so the card keeps reporting as partial rather than flipping to done
    // the moment something was registered for it — which is the failure this
    // repo's registration-is-per-defId rule exists to catch.
    //
    // A SELF-trigger rather than an event listener, the same shape Forge of the
    // Future needs and for the same reason: a Gear's OWN arrival is not a moment
    // `allListeningPermanents` reaches for that Gear, so keying it by the played
    // card's defId is what makes it fire at all.
    //
    // The body is On the Hunt's (SFD-204 above) word for word, because the printed
    // clause is: "ready your units" — no location, so base and every battlefield,
    // and no type widening, so the Gear and the Legend stay exhausted
    // (`readyPermanent` exists for Miss Fortune - Captain, who names no type).
    // The id list is snapshotted before the first ready for the reason recorded
    // there: `readyUnit` holds a `unitReadied` event and Pirate's Haven answers
    // it, so the instruction applies to the units that existed when it began.
    //
    // `event.ownerIndex` is who PLAYED it — "your units" is the caster's board.
    // A self-trigger's owner is `action.playerIndex` at every hold site, so this
    // stays right for a free play (play-free.ts) as well as a paid one.
    on: ["played"],
    resolve: (state, event) =>
      ownUnitsEverywhere(state, event.ownerIndex)
        .map((u) => u.instanceId)
        .reduce((next, id) => readyUnit(next, id), state),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {
  /**
   * The "you may" inside the ability Relentless Pursuit grants — "you may move me
   * to my base", asked when the granted unit conquers.
   *
   * Offered only while the unit is actually AT a battlefield, so a unit already
   * home (or dead, or moved away in the response window) asks nothing rather than
   * offering a move that would resolve to nothing. `recallUnitToBase` is itself a
   * no-op off a battlefield, so this is about not asking a pointless question
   * rather than about correctness.
   *
   * `targetInstanceId` is the unit, captured when the trigger fired — "me" means
   * the unit that conquered, and by the time the answer arrives "the unit that
   * conquered" is not something the board can be asked for.
   */
  "SFD-184-home": {
    prompt: () => "Relentless Pursuit: move that unit to your base?",
    options: (state, d) =>
      d.targetInstanceId !== undefined && findUnitOnBattlefield(state, d.targetInstanceId) !== undefined
        ? [
            { id: "decline", label: "Stay" },
            { id: "home", label: "Move to base", instanceId: d.targetInstanceId },
          ]
        : [],
    resolve: (state, d, optionId) =>
      optionId === "home" && d.targetInstanceId !== undefined ? recallUnitToBase(state, d.targetInstanceId) : state,
  },
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
  },
  /**
   * Void Rush's "you may banish one, then play it, reducing its cost by
   * [2 Energy]. Draw any you didn't banish."
   *
   * Declining leads, as everywhere else a "you may" is asked, and it is a real
   * answer rather than a formality: declining draws BOTH revealed cards, which is
   * often better than paying for the one on top.
   *
   * "Draw any you didn't banish" runs on EVERY answer including the decline —
   * two instructions, not one, the same structure Baited Hook's "then recycle the
   * rest" has.
   */
  "SFD-188-banish": {
    prompt: () => "Void Rush: banish one of the top 2 and play it for 2 less Energy?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline (draw both)" }];
      for (const card of voidRushRevealed(state, d.playerIndex)) {
        // Priced when the OPTIONS are built, so a card whose reduced cost cannot be
        // paid is never offered — 416.3's "the action must be able to be completed
        // for the cost to be paid", the same shape Ava Achiever's offer uses.
        if (voidRushPayment(state, d.playerIndex, card) === undefined) continue;
        options.push({ id: card.instanceId, label: voidRushLabel(state, d.playerIndex, card), instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      const revealed = voidRushRevealed(state, d.playerIndex);
      const named = optionId === "decline" ? undefined : revealed.find((c) => c.instanceId === optionId);
      // Re-paid here rather than trusted from the option list, which was built
      // against an earlier state. If the pool has drained in between, nothing is
      // banished and both cards are drawn — an unpayable cost withholds the payoff
      // instead of handing it over free, exactly as The Harrowing's replay does.
      const paid = named ? voidRushPayment(state, d.playerIndex, named) : state;
      const chosen = paid ? named : undefined;
      const base = paid ?? state;

      // BOTH revealed cards come off the deck first, whichever way this went.
      // Necessary rather than tidy: a Spell played below can draw, and leaving the
      // un-banished card on top would let it be drawn twice.
      const drawn = revealed.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...base.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: players[d.playerIndex].deck.slice(revealed.length),
        // "PLAY it" — this one IS a card you played, so [Legion] and Viktor -
        // Innovator both see it. Baited Hook and Ava Achiever make the same call;
        // the free plays a card performs on ITSELF (Portal Rescue's blink) do not.
        ...(chosen ? { cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1 } : {}),
      };
      const offDeck: GameState = { ...base, players };

      // Printed order: play, THEN draw the other. The banish is transient — banished
      // and played in one instruction — so the card goes straight to play rather
      // than through `PlayerState.banished`.
      //
      // **Divergence, inherited from `playCardIgnoringCost` and named here because
      // this card can hit anything:** a revealed SPELL resolves IMMEDIATELY rather
      // than going on the chain, and with NO targets, because nothing announced it.
      // A targeted spell played this way therefore does as much as it can and no
      // more — which for Incinerate is nothing at all. Recorded in
      // docs/rules-conformance.md against play-free.ts.
      const played = chosen ? playCardIgnoringCost(offDeck, d.playerIndex, chosen) : offDeck;
      if (drawn.length === 0) return played;
      const after = [...played.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = { ...after[d.playerIndex], hand: [...after[d.playerIndex].hand, ...drawn] };
      return { ...played, players: after };
    },
  },
};
