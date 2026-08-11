import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
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
  returnPermanentToHand,
  stunUnits,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { eligibleTargets, findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { isHiddenCard } from "../hidden.js";
import { parkDecision } from "../decisions.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import type { CardInstance, GearInstance, UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { attachEquipment, isEquipmentGear, isMechUnit } from "../equipment.js";
import { SAND_SOLDIER_TOKEN, placeGoldTokens, placeToken, type TokenDestination, type TokenSpec } from "../token.js";
import { playUnitToBattlefield } from "../deploy.js";
import { applyContested } from "../cleanup.js";

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
      const moved = forceMoveToDestination(state, movedId, event, ctx.casterIndex);

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
    // `scope: "anywhere"`: "a unit" is 355.9.a.1's bare noun, so a unit in either
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
    // `scope: "anywhere"`: "a unit" is 355.9.a.1's bare noun, so either player's base
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
    // **"A friendly unit" is a bare noun**, so `scope: "anywhere"` — 355.9.a.1's
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
      const moved = forceMoveToDestination(state, unitId, event, ctx.casterIndex);
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
  "UNL-186": {
    // Death from Below (Fury + Chaos) — "Kill a unit at a battlefield. Then, if it
    // had 3 [Might] or less, you may play this from your trash for [rainbow]."
    //
    // **HALF a card, and the half that is missing is named rather than
    // approximated.** The kill is written; the recursion is not, because "play
    // THIS from your trash" is a per-INSTANCE play permission with a REPLACED
    // cost, and this engine's only trash-play permission (`timing.mayPlayFromTrash`)
    // is per-player, Units-only and charges the printed price. Both halves of that
    // would have to change in timing.ts plus a field on PlayerState — see the
    // report accompanying this change.
    //
    // Registering the kill alone is deliberate and the trade is stated because
    // registration is per defId: this card will report DONE. The alternative was
    // leaving a hard removal spell inert for the sake of a clause that fires at
    // most once per copy.
    //
    // `scope` left at its default, so "a unit AT A BATTLEFIELD" is enforced by the
    // targeting and a unit sheltering in either base is out of reach (355.9.b's
    // narrowing — the printed location word is a targeting restriction).
    //
    // Killed BY THE CASTER (`ctx.casterIndex`), which is not decoration: it is what
    // makes "when you kill a unit" (Solari Shrine) and "killed with a spell"
    // (Immortal Phoenix) see this death, the same reading Noxian Guillotine's
    // [Legion] half takes above.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "UNL-190": {
    // Lilting Lullaby (Calm + Mind) — "[Reaction] Counter a spell. Its controller
    // can't play spells this turn."
    //
    // **HALF a card.** The counter is written; the lockout is not, and the reason
    // is worth stating because a field that looks like it would do the job exists:
    // `PlayerState.cannotPlayCardsThisTurn` is Brynhir Thundersong's "opponents
    // can't play CARDS this turn", and reusing it here would also stop the victim
    // playing units and gear — WIDER than printed, which is the direction this
    // codebase does not ship. A spells-only twin needs game-state.ts,
    // board-restrictions.ts, player-setup.ts and turn-manager.ts, none of which
    // this file owns.
    //
    // 425.1.a is what the first sentence does — "a card or ability that is
    // Countered does nothing and is cleared from the chain" — and `counterSpell`
    // is the single writer of it.
    //
    // No cost filter: the card names none, so any spell on the chain is a legal
    // choice. 355.9.a.2 is why the target is a chain object rather than anything
    // on the board, and the PDF's own example under it ("a spell that says
    // 'Counter a spell' cannot target itself") is already enforced by
    // `counterableSpells` — this spell is not on the chain when its own targets
    // are chosen.
    //
    // A vanished target is a no-op: two counters can name the same spell and the
    // second finds nothing, which is a real case rather than defensive padding
    // (see `counterSpell`'s own note).
    targeting: { kind: "chainSpell" },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "UNL-184": {
    // Thrill of the Hunt (Fury + Body) — "[Reaction] Banish a friendly unit, then
    // its owner plays it to any battlefield, ignoring its cost."
    //
    // # Arcane Shift's blink with one printed word changed, and the word is the card
    //
    // SFD-200 above says only "plays it" — the ordinary permission — so it goes
    // through `playUnitFree`, which offers BASE and, among battlefields, only the
    // ones rule 813 already lets a paid play reach. This prints "to ANY
    // BATTLEFIELD", and neither half of that list is right for it:
    //  - Base is not an option. 198.1 — "Locations include the Battlefields and
    //    the Bases" — makes a base a Location that is not a Battlefield, so the
    //    sentence excludes it rather than this file choosing to.
    //  - EVERY battlefield is an option, presence or not. 813's restriction is
    //    precisely the default "any" is overriding; reading it as a plain "a
    //    battlefield" would delete the line the card exists for, which is dropping
    //    a body into a fight it was not already in.
    //
    // So the destination question is asked here rather than borrowed. What IS
    // borrowed is the holding pen: `unitsAwaitingFreePlacement`, because the unit
    // must be off the board while the question is outstanding — arriving is what
    // fires its on-play trigger and what contests a battlefield, and deploying it
    // at base first would fire both for the wrong place. free-play.ts's own
    // comment records that reasoning; only the option list differs here, which is
    // why the decision kind is this card's rather than `FREE_PLAY_PLACEMENT`.
    //
    // # The rest
    //
    // The banish is TRANSIENT — banished and replayed in one instruction, nothing
    // can observe the middle zone — so the unit goes straight back to play rather
    // than through `PlayerState.banished`. Arcane Shift makes the same call, and
    // for the same reason.
    //
    // A fresh copy: 705 strips the Buff on leaving play, and damage, this-turn
    // Might, stun and the move counter are properties of the body that left.
    //
    // "ITS OWNER plays it", not the caster — `found.ownerIndex`. Friendly-only
    // targeting makes the two the same player today; naming it is what keeps that
    // an observation rather than an assumption.
    //
    // "A friendly unit" carries an owner word and no location word, so
    // `scope: "anywhere"` under 355.9.a.1 — and the unit standing at home is
    // exactly the one this is usually cast on.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const found = findUnitAnywhere(state, unitId);
      if (!found) return state; // killed in the response window — 359.3
      const returning: UnitInstance = {
        ...found.unit,
        damage: 0,
        mightThisTurn: 0,
        buffed: false,
        stunned: false,
        movesThisTurn: 0,
      };
      const removed = removeUnitAnywhere(state, unitId);
      const parked: GameState = {
        ...removed,
        unitsAwaitingFreePlacement: [
          ...removed.unitsAwaitingFreePlacement,
          { unit: returning, playerIndex: found.ownerIndex },
        ],
      };
      return parkDecision(parked, {
        kind: THRILL_OF_THE_HUNT_PLACEMENT,
        playerIndex: found.ownerIndex,
        cardInstanceId: returning.instanceId,
      });
    },
  },
  "UNL-182": {
    // Curtain Call (Fury + Mind) — "[Repeat] — [1] / [rainbow] / [1][rainbow].
    // Choose one you haven't already chosen — Draw 1. / Deal 2 to a unit at a
    // battlefield. / Deal 3 to a unit at a base. / Give a unit at a battlefield
    // -4 [Might] this turn."
    //
    // # The four modes are written; the THREE `[Repeat]`s are not
    //
    // **This is the card 820.1.c.2 and c.3 were waiting for**, and card-effects.ts's
    // `REPEAT_COSTS` table says so in advance: "each of these prints exactly ONE
    // instance of Repeat, checked across the set ... this models one instance and
    // repeat-cost-table.test.ts asserts the premise — the day a set prints two,
    // that test fails and this shape is what changes." Curtain Call prints THREE,
    // each with its own cost, each payable or not payable individually. A
    // `RepeatCostSpec` is one cost, so no row in that table can express this; and
    // "one you haven't ALREADY chosen" additionally needs the mode to be re-chosen
    // per EXECUTION, where `modeId` is chosen once per action. Both live in
    // card-effects.ts, which this file does not own — see the report.
    //
    // So one execution, one mode. That is exactly the card with no Repeat paid,
    // which is how it will usually be cast; "you haven't already chosen" has
    // nothing to exclude when there is only one choice.
    //
    // # The modes
    //
    // The two damage modes differ ONLY in where they may point, and the printed
    // asymmetry is the point of the card — 2 into a fight, or 3 into somebody's
    // base, where almost nothing in this pool can reach. `scope: "base"` is the
    // one scope that EXCLUDES battlefields rather than adding to them, and with no
    // owner word it is either player's base.
    //
    // None of the three targeted modes names an owner, so each may be pointed at
    // your own units. Dealing yourself 3 is a bad play rather than an illegal one,
    // and the debuff on your own unit is occasionally right (nothing here reads it
    // as a benefit); 355.9.b is what makes the printed location words binding while
    // leaving ownership open.
    //
    // NO floor on the debuff. Smoke Screen and Siphon Power print "to a minimum of
    // 1 [M]" and this does not, so `giveMightThisTurn` is called without one — a
    // 4-Might unit taken to 0 dies to the next point of damage, which is the card.
    modes: [
      {
        id: "draw",
        label: "Draw 1",
        targeting: { kind: "none" },
        resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
      },
      {
        id: "burn-battlefield",
        label: "Deal 2 to a unit at a battlefield",
        targeting: { kind: "unit" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, CURTAIN_CALL_BATTLEFIELD_DAMAGE) : state,
      },
      {
        id: "burn-base",
        label: "Deal 3 to a unit at a base",
        targeting: { kind: "unit", scope: "base" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, CURTAIN_CALL_BASE_DAMAGE) : state,
      },
      {
        id: "shrink",
        label: "Give a unit at a battlefield -4 Might this turn",
        targeting: { kind: "unit" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -CURTAIN_CALL_SHRINK) : state,
      },
    ],
  },
};

/** Curtain Call's two damage modes and its debuff, each named once so the mode
 *  and the test quote the same number. */
const CURTAIN_CALL_BATTLEFIELD_DAMAGE = 2;
const CURTAIN_CALL_BASE_DAMAGE = 3;
const CURTAIN_CALL_SHRINK = 4;

/** Thrill of the Hunt's "to any battlefield" question — written once because the
 *  resolver that raises it and the decision that answers it must agree, and a
 *  typo in either would be SILENT (a parked question nothing implements simply
 *  never appears, which reads exactly like a unit that was never banished). */
const THRILL_OF_THE_HUNT_PLACEMENT = "UNL-184-place";

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

/**
 * Every unit `playerIndex` could be asked to point a bare "a unit" at — either
 * player's, in either base or at any battlefield.
 *
 * `eligibleTargets` rather than a hand-rolled walk of the four zones, and that is
 * the whole reason it is a function: that helper is where `unitChooseableBy`
 * filters the units an opponent may not choose (Ruin Runner), and a decision that
 * walked the board itself would offer one and be the only place in the engine
 * that does. Two cards here ask the same question — Rengar's pump and Vi's ready
 * — so they ask it in one place.
 *
 * `scope: "anywhere"` and no owner: 355.9.a.1's bare "unit" is objects on the
 * Board, and neither card prints an owner word.
 */
function anyUnitChooseableBy(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return eligibleTargets(state, playerIndex, undefined, "anywhere");
}

/**
 * How much excess damage `playerIndex` assigned in the fight at `battlefieldId`,
 * or 0 when the record is from another battlefield, from the other side of a
 * fight, or absent.
 *
 * A SECOND copy of effects/body.ts's `excessFor`, and deliberately so rather than
 * shared: that one is private to the file that owns Sivir - Ambitious, and moving
 * it would mean editing a file this one does not own. The two read the same single
 * field and are asserted against the same three conditions; if a third card ever
 * prints the clause, the shared home is effect-helpers.ts.
 */
function excessAssignedBy(state: GameState, playerIndex: 0 | 1, battlefieldId: string | undefined): number {
  const excess = state.lastShowdownExcessDamage;
  if (!excess || excess.battlefieldId !== battlefieldId || excess.attackerIndex !== playerIndex) return 0;
  return excess.amount;
}

/** Vi - Piltover Enforcer's "3 or more excess damage" — Sivir - Ambitious prints
 *  the same clause at 5, so the threshold is a per-card number and not a rule. */
const VI_EXCESS_REQUIRED = 3;

/** Rengar - Pridestalker's "+1 [Might] this turn". */
const RENGAR_MIGHT = 1;

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
  "UNL-183": {
    // Rengar - Pridestalker (Fury + Body) — "When you play a unit, give a unit
    // +1 [Might] this turn."
    //
    // # A LEGEND registered in a domain file, which is new and is the point
    //
    // Every other Legend in this engine lives in `LEGEND_ABILITIES`, a shared
    // table a fanned-out agent cannot touch. Nothing forced that: `Listener.zone`
    // already has a `"legend"` case and `listeningPermanents` already ends with
    // `owner.legend`, so an entry in THIS registry keyed by a Legend's defId is
    // found by the ordinary listener walk and held as an ordinary Chain Pending
    // Item (383). The `zone === "legend"` check below is what makes that explicit
    // rather than incidental — the same way Super Mega Death Rocket asserts
    // `zone === "trash"` above instead of assuming no other copy can exist.
    //
    // # "When YOU play a unit"
    //
    // `casterIndex === listener.ownerIndex` — an opponent's unit is not his
    // moment. `playedKind === "Unit"` because `cardPlayed` fires for every card,
    // and a Spell must not pump anything.
    //
    // The unit just played is itself a legal choice: `deploy.playUnitToBase` and
    // `playUnitToBattlefield` both fire `cardPlayed` AFTER the unit has landed, so
    // it is already on the board when this resolves. That is the ordinary line —
    // the new body arrives a point bigger.
    //
    // # There is deliberately NO "is there anything to choose" gate
    //
    // The obvious one — refuse to trigger on an empty board, 355.8/383.4 — was
    // written first and then removed as **unreachable and therefore untestable**:
    // the unit that fired this is already on the board, so "you played a unit"
    // guarantees at least one legal choice. A mutation that deleted the gate
    // survived every test in the wave-5 file, which is what settled it; a branch
    // no measurement can distinguish is a branch that will be wrong quietly.
    //
    // The one case the gate would have covered is the played unit dying inside the
    // response window before this resolves. Then the decision's option list is
    // empty and decisions.ts drops the question, which is the same outcome by a
    // different route.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      listener.zone === "legend" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit",
    resolve: (state, listener) => parkDecision(state, { kind: "UNL-183-pump", playerIndex: listener.ownerIndex }),
  },
  "UNL-187": {
    // Vi - Piltover Enforcer (Fury + Order) — "When you conquer, if you assigned
    // 3 or more excess damage, you may exhaust me to ready a unit."
    //
    // Sivir - Ambitious (SFD-120, effects/body.ts) prints the same condition at 5
    // and Tryndamere - Barbarian at 5 as well, so the reading is settled rather
    // than invented here: "excess damage" is a term the rules never define —
    // `excess` appears in the PDF only under Burn Out — and `combat.excessAssigned`
    // records why all three candidate readings coincide. The number is written
    // once, by the damage step, into `state.lastShowdownExcessDamage`.
    //
    // **Two clauses of Sivir's that this card does NOT print**, and dropping them
    // is what makes it a different card rather than a copy:
    //  - no "after an attack". The record carries a battlefield and an attacking
    //    side anyway, so a conquest by walking into an empty battlefield reads 0
    //    and this stays silent — which is the same outcome, reached from the data
    //    rather than from a clause.
    //  - no "when I conquer". This is a LEGEND, who stands at no battlefield, so
    //    there is no "here" for it to be at and the trigger is the player's
    //    conquest — the same distinction Super Mega Death Rocket's "when you
    //    conquer" draws against Kai'Sa - Survivor's "when I conquer".
    //
    // The excess threshold is the trigger's printed CONDITION ("IF you assigned"),
    // so it is asked in `applies`, at the moment of the event — 383.4: "if those
    // requirements are not fulfilled when the unit gains the designation, it will
    // not trigger". Re-asking it in the body would let an opponent cancel a fired
    // trigger inside the response window.
    //
    // The EXHAUST is a cost, not a condition, so it is NOT asked here: it is
    // re-derived when the question is answered (414.4, "the action must be able to
    // be completed for the cost to be paid"), which is the same split Rek'sai -
    // Void Burrower makes on the same event.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      listener.zone === "legend" &&
      event.conquerorIndex === listener.ownerIndex &&
      excessAssignedBy(state, listener.ownerIndex, event.battlefieldId) >= VI_EXCESS_REQUIRED,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // Re-checked because neither fact can change inside the response window
      // (only a combat's damage step writes the record, and a combat cannot open
      // mid-chain) — so a mismatch here means the trigger was resolved for the
      // wrong event, not that the board moved.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      if (excessAssignedBy(state, listener.ownerIndex, event.battlefieldId) < VI_EXCESS_REQUIRED) return state;
      // An exhausted Vi cannot pay, so she is not asked at all — Rek'sai - Void
      // Burrower's conquer clause makes the same check in the same place, and for
      // the same reason: the exhaust is a cost, so it is read at RESOLUTION rather
      // than when the trigger fired (414.4), and the response window in between is
      // exactly where a Legend can be exhausted out from under it.
      if (state.players[listener.ownerIndex].legend.exhausted) return state;
      return parkDecision(state, { kind: "UNL-187-ready", playerIndex: listener.ownerIndex });
    },
  },
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
   *
   * # The affirmative answer must carry its LABEL, not an `instanceId`
   *
   * Reported from play as *"unit didn't move to base after relentless pursuit"*.
   * The engine fires, asks and moves correctly — measured through `submit` and in
   * self-play — but the board never showed the player a way to say yes.
   *
   * `DecisionPrompt` splits a question's options in two: any option carrying an
   * `instanceId` the board can find is rendered as that CARD's art and its
   * `label` is DISCARDED; everything else becomes a labelled button. That is
   * right for a choice BETWEEN cards ("discard 1", "kill one of your units"),
   * where the prose says nothing the art doesn't. It is exactly wrong for a
   * yes/no, where the prose IS the answer: with the id attached, the only
   * labelled control on screen said **"Stay"**, and "Move to base" appeared
   * nowhere at all.
   *
   * So the unit is named in the PROMPT — which is rendered, as the overlay's
   * title — and the option carries only its label. Nothing is lost: the engine
   * never read that `instanceId` (`resolve` uses `d.targetInstanceId`), so it was
   * only ever a hint to the board, and the hint was wrong.
   *
   * **Not fixed by suppressing the option when the move is impossible**, which
   * was the first candidate: Vilemaw's Lair and Minotaur Reckoner both make
   * `recallUnitToBase` a no-op, and offering "Move to base" there does nothing.
   * 358.3.a settles it the other way — "if a Game Effect prevents the performance
   * of a game action, that effect doesn't prevent cards and abilities that
   * instruct a player to perform that game action from being played or finalized.
   * On resolution, that game action will be skipped as it is an impossible
   * instruction" — and 359.3.e.6 works Vilemaw's Lair BY NAME. Withholding the
   * option would have been the divergence.
   */
  "SFD-184-home": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId === undefined ? undefined : findUnitAnywhere(state, d.targetInstanceId);
      return `Relentless Pursuit: move ${unit?.unit.name ?? "that unit"} to your base?`;
    },
    options: (state, d) =>
      d.targetInstanceId !== undefined && findUnitOnBattlefield(state, d.targetInstanceId) !== undefined
        ? [
            { id: "decline", label: "Stay" },
            { id: "home", label: "Move to base" },
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
  /**
   * Rengar - Pridestalker's "give a unit +1 [Might] this turn", asked once per
   * unit its controller plays.
   *
   * **No decline, because the card prints none.** "Give a unit +1" is mandatory,
   * so with one unit on the board `advanceDecisions` auto-resolves it without a
   * prompt — which is right: a question with one legal answer is not a question.
   * The Rengar test asserts the pump lands in exactly that case, so an accidental
   * "Decline" option would be caught rather than silently making the card
   * optional.
   *
   * Either player's units, in either zone: the card names no owner and no
   * location (355.9.a.1). Buffing an enemy is a bad play rather than an illegal
   * one, and the case that matters is a board where the only unit is theirs —
   * "give A unit" then has exactly one answer, and it is not the one you want.
   */
  "UNL-183-pump": {
    prompt: () => "Rengar - Pridestalker: give a unit +1 Might this turn",
    options: (state, d) =>
      anyUnitChooseableBy(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => giveMightThisTurn(state, optionId, RENGAR_MIGHT),
  },
  /**
   * Vi - Piltover Enforcer's "you may exhaust me to ready a unit", raised by her
   * conquer trigger once the excess threshold is met.
   *
   * ONE question rather than two, unlike Rek'sai's pair: her cost buys nothing a
   * player could want to see first, so committing the exhaust and naming the unit
   * are the same decision. Rek'sai's are split because her cost buys a REVEAL,
   * and collapsing hers would make a player commit to results they have already
   * been shown.
   *
   * The exhaust is re-derived here rather than trusted from the trigger (414.4) —
   * a response window sits between them, and anything that exhausts a Legend in it
   * takes the offer away.
   *
   * **Only EXHAUSTED units are offered**, which is a narrowing and is 415.1.b's:
   * "a Unit that is already Ready cannot be Readied again", so offering one would
   * spend Vi on a no-op. Contrast Leona - Radiant Dawn, who deliberately DOES
   * offer already-buffed units — 702.3.a makes a second buff a no-op rather than
   * illegal, and there the whole answer can honestly be "nothing happens". Here
   * the player is paying an exhaust for it.
   *
   * "Ready A UNIT", no owner word, so either player's (355.9.a.1) — readying an
   * enemy is a bad play, not an illegal one, and `readyUnit`'s own
   * `mayReadyPermanent` gate is what refuses it under Mageseeker Warden.
   */
  "UNL-187-ready": {
    prompt: () => "Vi - Piltover Enforcer: exhaust her to ready a unit?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (state.players[d.playerIndex].legend.exhausted) return options;
      for (const unit of anyUnitChooseableBy(state, d.playerIndex)) {
        if (!unit.exhausted) continue;
        options.push({ id: unit.instanceId, label: `Exhaust Vi and ready ${unit.name}`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return readyUnit({ ...state, players }, optionId);
    },
  },
  /**
   * Thrill of the Hunt's "to any battlefield" — see the card above for why the
   * option list is every battlefield and not `playUnitFree`'s.
   *
   * No decline: the play is not a "you may". A board with one battlefield
   * auto-resolves, which is the correct reading of a mandatory choice with one
   * legal answer.
   *
   * An empty list when the pen no longer holds the unit is how decisions.ts drops
   * a question that no longer applies — the same shape Sett - The Boss's save
   * uses. Nothing in this pool can empty the pen between the park and the answer
   * (the queue is answered before any other action), so this is the "moot" branch
   * rather than a reachable one.
   */
  [THRILL_OF_THE_HUNT_PLACEMENT]: {
    prompt: (state, d) => `Thrill of the Hunt: where does ${awaitingThrillUnit(state, d.cardInstanceId)?.name ?? "it"} enter play?`,
    options: (state, d) =>
      awaitingThrillUnit(state, d.cardInstanceId) === undefined
        ? []
        : state.battlefields.map((bf) => ({ id: bf.id, label: bf.name })),
    resolve: (state, d, optionId) => {
      const held = state.unitsAwaitingFreePlacement.find((p) => p.unit.instanceId === d.cardInstanceId);
      if (!held) return state;
      const released: GameState = {
        ...state,
        unitsAwaitingFreePlacement: state.unitsAwaitingFreePlacement.filter((p) => p.unit.instanceId !== held.unit.instanceId),
      };
      const deployed = playUnitToBattlefield(released, held.playerIndex, held.unit, optionId);
      // Contested is applied by the CALLER, which deploy.ts's own note explains:
      // arriving at a battlefield can make it Contested and can be an attack, and
      // only the card that played the unit knows which. A unit appearing from a
      // card's text is a unit becoming present (190.3.a), so it contests exactly
      // as a walk-in does — which for this card is the whole point.
      return applyContested(deployed, optionId, held.playerIndex);
    },
  },
};

/** The unit Thrill of the Hunt's placement question is about, while it is still
 *  in the pen. */
function awaitingThrillUnit(state: GameState, cardInstanceId: string | undefined): UnitInstance | undefined {
  if (cardInstanceId === undefined) return undefined;
  return state.unitsAwaitingFreePlacement.find((p) => p.unit.instanceId === cardInstanceId)?.unit;
}

/**
 * Activated abilities contributed by this domain file.
 *
 * **Empty on purpose, and it is the seam that matters, not the contents.**
 * `ACTIVATED_ABILITIES` was module-private in `activated-abilities.ts`, so a
 * domain file could not register an activated ability AT ALL — the wave-1 agents
 * refused UNL-026 and UNL-093 on exactly that, and every future card with a
 * printed "[cost]: do something" would have hit the same wall or been written
 * into the shared file that the fan-out rule keeps agents out of.
 *
 * Merged lazily by `activated-abilities.ts`, through the same `mergeRegistries`
 * that throws on a duplicate defId — so a card registered both here and in the
 * built-in table is a named error at import, not a silent last-write-wins.
 */
/** Pyke - Bloodharbor Ripper's ":rb_energy_1:, :rb_exhaust::". */
const PYKE_ENERGY_COST = 1;

/**
 * Lillia - Bashful Bloom's printed ":rb_energy_4:", BEFORE her "[1] less for each
 * friendly unit with [Temporary]" — which is not applied. See her entry.
 */
const LILLIA_ENERGY_COST = 4;

/** Lillia's "ready 3 [Might] Sprite unit token with [Temporary]" — the fourth
 *  copy of this spec in the engine; see her entry for why it is local. */
const SPRITE_TOKEN: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };

export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-185": {
    // Pyke - Bloodharbor Ripper (Fury + Chaos) — "[1], [Exhaust]: Return a
    // friendly unit at a battlefield to its owner's hand. Play a Gold gear token
    // exhausted."
    //
    // Miss Fortune - Bounty Hunter's shape (`kind: "Legend"`, a targeted exhaust
    // ability) with a price on it, and `ActivationCost` already carries both
    // halves — `{ energy, exhaust }` is what the two preset Legend abilities
    // print. Nothing new was needed at the cost end.
    //
    // # The bounce is a COST-LIKE mandatory, so it gates the whole ability
    //
    // "Return a friendly unit AT A BATTLEFIELD" is the first instruction and it
    // names a target, so 355.8 makes the ability unusable with nothing at a
    // battlefield to return — which means Pyke cannot mint a Gold off an empty
    // board. That is the card rather than a limitation: the Gold is payment for
    // pulling one of your own bodies out of a fight, and enumeration refusing to
    // offer the ability with no legal target is what enforces it.
    //
    // `scope` left at its default so the printed "at a battlefield" binds
    // (355.9.b, the NARROWING half), and `owner: "friendly"` from the printed
    // word. "Its OWNER's hand" and the caster's are the same player under
    // friendly-only targeting; `returnPermanentToHand` files it by owner anyway,
    // which is what keeps that an observation.
    //
    // # The Gold is unconditional
    //
    // Two sentences, not one instruction with a rider, so the token lands even if
    // the returned unit died in the window between activation and resolution.
    // `placeGoldTokens` mints it EXHAUSTED already — 149.1 has gear entering
    // ready, so the sixteen cards printing "exhausted" are the ones overriding a
    // default (184.1), and the token's own "[Reaction][>] Kill this, [Exhaust]:
    // [Add] [rainbow]" is registered against `GOLD_TOKEN_DEF_ID` rather than here.
    kind: "Legend",
    cost: { energy: PYKE_ENERGY_COST, exhaust: true },
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const returned = event.targetUnitInstanceId ? returnPermanentToHand(state, event.targetUnitInstanceId) : state;
      return placeGoldTokens(returned, ctx.casterIndex, 1);
    },
  },
  "UNL-189": {
    // Lillia - Bashful Bloom (Calm + Mind) — "[4], [Exhaust]: Play a ready
    // 3 [Might] Sprite unit token with [Temporary]. This ability costs [1] less
    // for each friendly unit with [Temporary]."
    //
    // # DIVERGENCE: the discount is not applied, so this always costs [4]
    //
    // `ActivationCost.energy` is a NUMBER and `activationCostOf(defId, modeId)` is
    // handed no state, so an activation cost cannot depend on the board. Four
    // pricing sites go through that function — `canPayActivationCost`,
    // `payActivationCost`, the enumerator's payment and the validator's
    // re-derivation — and a discount that reached only some of them is exactly the
    // offered-then-refused split this codebase keeps paying for. Widening it is a
    // change to activated-abilities.ts and validate-activate-ability.ts, neither of
    // which this file owns.
    //
    // So the divergence is in the UNDER-offering direction: the ability is always
    // available at its printed base price and never cheaper. A Lillia standing
    // beside three Sprites pays 4 where she should pay 1. Reported rather than
    // approximated — the alternative (a discount applied in the resolver) would
    // hand the player a Sprite they had not paid for.
    //
    // # The token
    //
    // `SPRITE_TOKEN` is a fourth local copy of a spec that already exists in
    // effects/calm.ts and effects/mind.ts (twice). Not shared from token.ts,
    // because that file is not this one's to edit — the same position the wave-2
    // agents were in when three of them wrote byte-identical `BIRD_TOKEN`s. The
    // stat line is quoted from the printed text here so a future consolidation has
    // a source rather than three siblings.
    //
    // "A READY ... token" overrides 143.4.a's enters-exhausted default, which is
    // what `entersReady` is for; `[Temporary]` is the keyword that kills it at the
    // start of its controller's Beginning Phase, and it is conferred on the TOKEN
    // rather than on Lillia (card-loader's own note about OGN-106 Sprite Mother
    // makes the same distinction).
    //
    // BASE, because the card names no location and every other Sprite-maker in
    // this pool that names none places at base. An ability has no
    // `destinationBattlefieldId` axis to fan out over the way a spell in
    // `TOKEN_PLACEMENT_SPELL_DEF_IDS` does, so this is the convention rather than
    // a choice made against an alternative that exists.
    kind: "Legend",
    cost: { energy: LILLIA_ENERGY_COST, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", SPRITE_TOKEN),
  },
};


/**
 * Continuous Might modifiers contributed by this domain file.
 *
 * The seam `effective-might.ts` had no equivalent of until 2026-08-09: every
 * conditional or scaling Might card had to be hand-added to that shared file,
 * which the fan-out rule keeps parallel agents out of — so three cards were
 * refused across two waves rather than written.
 *
 * Keyed by defId. A SELF bonus tests `unit.defId`; an AURA tests the board for
 * its source and ignores it. `bonus` is called for every unit on every
 * evaluation, so it must be pure and cheap.
 *
 * A `[Level N]` bonus belongs HERE and not in an on-play trigger: 824.1.d turns
 * the ability off again the moment XP drops below N, so a one-shot pump is wrong
 * in both directions.
 */
const MASTER_YI_WUJU_MASTER = "UNL-191";
/** His first clause's `[Level 6]` and the +1 it grants — 824.1.b.1's "[N] or
 *  more XP", so 6 is on and 5 is off. */
const MASTER_YI_LEVEL = 6;
const MASTER_YI_MIGHT = 1;

export const mightModifiers: Record<string, MightModifier> = {
  "UNL-191": {
    // Master Yi - Wuju Master (Calm + Body) — "[Level 6][>] Your units have
    // +1 [Might]. [Level 11][>] Your units enter ready."
    //
    // # HALF a card: the [Level 6] aura is here, the [Level 11] clause is not
    //
    // "Your units enter READY" is a replacement effect at deploy time, and the one
    // predicate that answers it — `deploy.unitEntersReady` — is a shared file this
    // one does not own. It cannot be faked as an on-play `readyUnit` either, and
    // deploy.ts's own comment says why in three measured ways: the trigger is a
    // held Chain Pending Item so the unit sits EXHAUSTED through the whole response
    // window, it fires `unitReadied` and pays out Pirate's Haven for a readying
    // that never happened, and it is blockable by Mageseeker Warden. Three agents
    // reached that conclusion independently. So the clause is REFUSED rather than
    // approximated — see the report.
    //
    // # Why the [Level 6] half is a continuous modifier and not a trigger
    //
    // 824.1.b.1 makes `[Level N]` "functionally short for 'While you have [N] or
    // more XP, this card gains [Text]'", and 824.1.d turns the Dependent Ability
    // Inactive "as soon as the controlling player has less than [N] XP". A one-shot
    // pump would be wrong in BOTH directions — applied below the threshold and
    // still applied after XP is spent — which is precisely the reasoning
    // `MightModifier` was added for.
    //
    // # The source is a LEGEND, which is what makes this entry unusual
    //
    // Every other aura in this table finds its source by walking the board for a
    // unit with the right defId. A Legend is in no location at all, so the test is
    // `players[ownerIndex].legend.defId` — asked of the UNIT's owner, since "YOUR
    // units" is measured against Master Yi's controller and this bonus is
    // evaluated for every unit on the board, both sides included.
    //
    // Unconditional otherwise: no "here", no combat clause, so it applies in base
    // as readily as at a battlefield and `ctx` is not read at all.
    defId: MASTER_YI_WUJU_MASTER,
    bonus: (state, _unit, ownerIndex) =>
      state.players[ownerIndex].legend.defId === MASTER_YI_WUJU_MASTER &&
      state.players[ownerIndex].xp >= MASTER_YI_LEVEL
        ? MASTER_YI_MIGHT
        : 0,
  },
};
