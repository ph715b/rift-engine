import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  destroyUnit,
  drawCards,
  exhaustGear,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToAllFriendlies,
  legionActive,
  holdCardsRecycled,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  readyUnit,
  recycleCardFromHand,
  recycleUnitFromPlayToDeck,
  spendBuff,
  stunUnits,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { placeGoldTokens, placeRecruitToken, placeToken, type TokenDestination, type TokenSpec } from "../token.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { parkDecision, repeatDecision, type DecisionOption } from "../decisions.js";
import { playUnitToBase } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { isAttackingAt } from "../combat-designation.js";
import { isMighty } from "../granted-keywords.js";
import { effectiveMight } from "../effective-might.js";
import type { UnitInstance } from "../../model/card.js";
import type { GameState, PendingDecision, PlayerState } from "../../model/game-state.js";
import { wearerListener } from "../equipment.js";

/**
 * Shurima's Sand Soldier: a 2-Might unit token, entering exhausted like any
 * other unit (143.4.a) — nothing on either card that makes one says "ready".
 *
 * A spec rather than a second `placeRecruitToken`, for the reason token.ts's own
 * `TokenSpec` comment gives: the Recruit is 1 Might and this is 2, and a token
 * type is data, not a function.
 */
const SAND_SOLDIER_TOKEN: TokenSpec = { name: "Sand Soldier", might: 2, tag: "Sand Soldier" };

/** Divine Judgment's four categories, in the order the card names them. */
const JUDGMENT_CATEGORIES = ["units", "gear", "runes", "hand"] as const;
type JudgmentCategory = (typeof JUDGMENT_CATEGORIES)[number];
const JUDGMENT_KEEP = 2;

/**
 * Card implementations for **Order** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Order. A test in
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
  "OGN-221": {
    // Imperial Decree — "When ANY unit takes damage this turn, kill it."
    //
    // A board wipe on a delay, and the delay is the card: it kills nothing on
    // resolution, and then every point of damage this turn is lethal — including
    // the caster's own units, since "any unit" names no owner. On GameState
    // rather than on a player for exactly that reason.
    //
    // Read at `dealDamage`, so it covers spells, abilities and combat's own
    // damage step alike wherever those funnel through it.
    targeting: { kind: "none" },
    resolve: (state) => ({ ...state, killDamagedUnitsThisTurn: true }),
  },
  "OGN-207": {
    // Call to Glory — "As you play this, you may spend a buff as an additional
    // cost. If you do, ignore this spell's cost. Give a unit +3 Might this turn."
    //
    // Only the payoff is here. The buff-spending cost and the cost-ignoring live
    // in card-effects.ts's OPTIONAL_UNIT_COSTS (`ignoresCostWhenPaid`), because
    // they are a COST — decided in the submitted action, priced by legal-actions
    // and re-derived by the validator — not something the effect can do at
    // resolution time. Same split Spoils of War and Find Your Center take.
    //
    // "A unit", not "a friendly unit" and not "at a battlefield": scope
    // "anywhere" with no owner restriction, the reading 355.9.b gives the bare
    // noun and the one Primal Strength and Discipline already take. Pumping an
    // enemy unit is a bad play, not an illegal one.
    //
    // giveMightThisTurn rather than a Buff — "this turn" expires in the
    // Expiration Step (317) instead of persisting (710). That matters doubly on
    // this card, since the buff it SPENDS is the persistent kind: it converts a
    // standing +1 into a bigger, temporary +3.
    // The buff is SPENT here rather than by a generic cost step, because there
    // is no such step: execute-play-card carries the chosen unit through to the
    // resolver and each card pays its own cost, the way Wildclaw Shaman already
    // does. A known simplification of "AS you play this" — the cost lands at
    // resolution rather than on announcement — shared with every other optional
    // cost in this pool, and it only becomes observable once something can
    // respond between the two (see the Chain Pending Items row).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const paid =
        event.additionalCostUnitInstanceId !== undefined
          ? (spendBuff(state, ctx.casterIndex, event.additionalCostUnitInstanceId) ?? state)
          : state;
      return event.targetUnitInstanceId ? giveMightThisTurn(paid, event.targetUnitInstanceId, 3) : paid;
    },
  },
  "OGN-209": {
    // Cull the Weak — "Each player kills one of their units."
    //
    // No targeting spec, and that is the point: this is not the caster choosing
    // two victims. Each player chooses their OWN, which the caster has no say
    // over — so both choices are made at resolution, by the player they belong
    // to, through engine/decisions.ts.
    //
    // Deliberately NOT fanned out onto the action the way every other choice in
    // this engine is. A fan-out commits the caster's victim at cast time, and the
    // opponent may respond on the chain in between — killing the unit that was
    // going to be chosen, or adding a better one. "One of their units" means the
    // ones alive when this resolves.
    targeting: { kind: "none" },
    resolve: (state) => {
      // APNAP: the active player answers first, and the queue is FIFO, so
      // parking in that order is the whole implementation of the ordering.
      const first = state.activePlayerIndex;
      const second = (1 - first) as 0 | 1;
      return [first, second].reduce(
        (next, playerIndex) => parkDecision(next, { kind: "OGN-209-kill", playerIndex }),
        state,
      );
    },
  },
  "OGN-244": {
    // Divine Judgment — "Each player chooses 2 units, 2 gear, 2 runes, and 2
    // cards in their hands. Recycle the rest."
    //
    // The pool's only symmetrical board wipe, and like Cull the Weak the choices
    // belong to the player they are about — so nothing is fanned out onto the
    // action and all eight questions are asked at resolution.
    //
    // **Asked as "which one goes", repeated until 2 remain, rather than "which
    // two stay".** The two are the same set of outcomes, and this needs no
    // accumulator: a multi-select answer would have to be carried on the pending
    // decision and validated against itself, while a one-at-a-time cut is
    // rebuilt from live state each time like every other question here. What the
    // player sees differs (they name victims, not survivors) and that is
    // recorded Unverified.
    targeting: { kind: "none" },
    resolve: (state) => {
      // APNAP, and per PLAYER rather than per category: one player makes all
      // four of their choices before the other starts, which is what "each
      // player chooses ..." reads as. FIFO parking is the whole implementation.
      const first = state.activePlayerIndex;
      const second = (1 - first) as 0 | 1;
      return [first, second].reduce(
        (next, playerIndex) =>
          JUDGMENT_CATEGORIES.reduce(
            (afterCategory, category) =>
              // Nothing to ask when the player is already at or under the keep
              // count — 422's do-as-much-as-you-can, and a question with nothing
              // to cut is not a question.
              judgmentPool(afterCategory, playerIndex, category).length > JUDGMENT_KEEP
                ? parkDecision(afterCategory, { kind: `OGN-244-cut-${category}`, playerIndex })
                : afterCategory,
            next,
          ),
        state,
      );
    },
  },
  "OGN-213": {
    // Hidden Blade — "[Hidden][Action] Kill a unit at a battlefield. Its
    // controller draws 2."
    //
    // The draw goes to the VICTIM's controller, not the caster — that's the
    // card's whole balance, and reading "its" as the caster would turn a
    // drawback into a bonus. The owner has to be read BEFORE the kill, since
    // afterwards the unit is in a trash and no longer at a battlefield.
    //
    // destroyUnit, not dealDamage: "kill" is a Kill Instruction, so Might and
    // marked damage are irrelevant and it goes through the same funnel that
    // fires [Deathknell] (808) and honours a death ward (809.1.b.1).
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const location = findUnitAnywhere(state, event.targetUnitInstanceId);
      if (!location) return state;
      const victimIndex = location.ownerIndex;
      return drawCards(destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex), victimIndex, 2);
    },
  },
  "OGN-233": {
    // Grand Strategem — "[Action] Give friendly units +5 Might this turn."
    //
    // Same shape as Decisive Strike (OGS-024, card-effects.ts), just bigger, so
    // it shares that card's helper rather than re-deriving "who is friendly":
    // every unit the CASTER controls, in base and at every battlefield. Note
    // the text says "friendly units", not "friendly units here" — a unit
    // sitting at home is pumped too, which matters when this is cast during a
    // showdown at one battlefield.
    //
    // targeting: none. The units are programmatically selected from their
    // characteristics rather than chosen, which rule 355.11 makes the
    // difference between targeting and merely affecting ("Kill all units at
    // battlefields doesn't target anything"). So there is no choice for
    // legal-actions.ts to fan out and nothing an enemy "can't be chosen"
    // effect could dodge.
    //
    // giveMightThisTurnToAllFriendlies, NOT buffing: this expires in the
    // Expiration Step (rule 317) via turn-manager.ts's runEnd zeroing every
    // unit's mightThisTurn, whereas a Buff (rule 710) persists, caps at one per
    // unit and is only worth +1.
    //
    // [Action] is the default play timing (own turn or a showdown) and is
    // enforced by engine/timing.ts, not here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllFriendlies(state, ctx.casterIndex, 5),
  },
  "OGN-229": {
    // Vengeance — "Kill a unit."
    //
    // The whole card. No battlefield named (scope "anywhere") and no owner
    // named, so it reaches either player's units wherever they stand — killing
    // your own is a bad play, not an illegal one.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "OGN-224": {
    // Salvage — "You may kill up to one gear. Draw 1."
    //
    // "UP TO one" and "you may", so the kill is optional in both directions and
    // the draw happens regardless — a Salvage cast with no gear on the board is
    // a 1-card cantrip, not an uncastable card. `unitOrGear` is the only spec
    // that can name a gear, and the decline variant is the empty choice
    // enumeration already produces when no target is given.
    //
    // killGear, not a hand-rolled removal: it is the funnel that fires a gear's
    // own "when I am killed" self-trigger (Scrapheap, Forge of the Future).
    // Either player's gear is fair game — the card names no owner.
    targeting: { kind: "unitOrGear" },
    resolve: (state, ctx, event) => {
      const drawn = () => drawCards(state, ctx.casterIndex, 1);
      const chosen = event.targetPermanentInstanceId;
      if (!chosen) return drawn();
      for (const ownerIndex of [0, 1] as const) {
        const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === chosen);
        // A unit named by the unitOrGear spec is simply not a legal thing for
        // this card to kill, so it falls through to the draw.
        if (gear) return drawCards(killGear(state, gear, ownerIndex), ctx.casterIndex, 1);
      }
      return drawn();
    },
  },
  "OGN-220": {
    // Facebreaker — "[Hidden][Action] Stun a friendly unit and an enemy unit at
    // the same battlefield."
    //
    // `min: 2`: both halves are mandatory, so the card is simply not playable
    // without a friendly and an enemy standing together somewhere. It is not a
    // "do as much as you can" — the two are one instruction joined by "and", and
    // the friendly stun is the price of the enemy one.
    //
    // `sameBattlefield` is a relation between the two targets, which no other
    // card here has, so it lives on the SPEC and is enforced by the enumerator
    // and the validator together (see card-effects.ts's TargetingSpec). A check
    // inside this resolver would come too late: the card would already be paid
    // for.
    //
    // ONE stunUnits call, not two. "Stun a friendly unit AND an enemy unit" is a
    // single instruction, so Leona - Radiant Dawn's "when you stun one or more
    // enemy units" pays out once, and Eclipse Herald sees the pair together.
    // Two calls would fire the batch event twice and double both.
    //
    // [Hidden] (811) and [Action] (159.2.a.1) are both handled by the engine —
    // engine/hidden.ts and engine/timing.ts — not here.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, sameBattlefield: true },
    resolve: (state, ctx, event) => {
      const chosen = [event.targetUnitInstanceId, event.secondTargetUnitInstanceId].filter(
        (id): id is string => id !== undefined,
      );
      return chosen.length > 0 ? stunUnits(state, ctx.casterIndex, chosen) : state;
    },
  },
  "OGN-237": {
    // King's Edict — "Starting with the next player, each other player chooses a
    // unit you don't control that hasn't been chosen for this spell. Kill those
    // units."
    //
    // targeting: none, and that is a rule rather than a shortcut. Rule 355.6's
    // Targeting list exempts a choice that "is part of a set of objects chosen in
    // whole or in part by other players", with "Each player kills a unit they
    // control" as its own worked example — so nothing here is targeted, and there
    // is nothing for legal-actions.ts to fan out onto the action. The same shape
    // Cull the Weak takes above, reached from the opposite direction: that card
    // asks everyone, this one asks everyone EXCEPT the caster.
    //
    // "A unit YOU don't control" — "you" is this spell's controller. With two
    // seats that set is exactly the answering player's own units, which is what
    // the decision offers. Both of the card's multiplayer clauses therefore have
    // nothing to do here: "starting with the next player" orders a single asker,
    // and "hasn't been chosen for this spell" excludes from a single choice. They
    // are written out rather than silently dropped, because the day a third seat
    // exists they are the whole card.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      parkDecision(state, { kind: "OGN-237-kill", playerIndex: ctx.casterIndex === 0 ? 1 : 0 }),
  },
  "SFD-154": {
    // Guards! — "[Hidden] Play a 2 Might Sand Soldier unit token. You may pay
    // [Order] to ready it."
    //
    // Sprite Call's shape (effects/mind.ts) with a payment bolted on: a Spell
    // that mints a token, so `targeting` is "none" — nothing is chosen, and the
    // DESTINATION is a deployment zone rather than a target.
    //
    // **The ready is asked, not fanned onto the action**, unlike the optional
    // costs a play carries. It is not a cost of playing Guards! — the spell is
    // already resolving when the question arises, and 355 excludes "making
    // choices for Triggered Abilities" from the choices made as a card is
    // played. Offered only when the token really exists, so a Guards! whose
    // token was somehow never placed asks nothing.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      // Base by default. `destinationBattlefieldId` is read so that the moment
      // this card is listed as a token-placing spell it lands where 811 puts a
      // hidden play — see the note on `placeSandSoldier` for what is missing.
      const destination: TokenDestination =
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base";
      const { state: placed, tokenInstanceId } = placeSandSoldier(state, ctx.casterIndex, destination);
      if (tokenInstanceId === undefined) return placed;
      return parkDecision(placed, {
        kind: "SFD-154-ready",
        playerIndex: ctx.casterIndex,
        // "IT" is the token this spell just made, captured now: the answer comes
        // in a submit later, by which time "the newest token" is not a thing the
        // board can be asked for.
        targetInstanceId: tokenInstanceId,
      });
    },
  },
  "SFD-162": {
    // Blood Money — "[Action] Kill a unit at a battlefield with 2 Might or less.
    // If it was an enemy unit, play a Gold gear token exhausted. If it was a
    // friendly unit, play two Gold gear tokens exhausted."
    //
    // No `owner` on the spec, and that is the card: it will happily eat one of
    // YOUR OWN small units, and pays double when it does. A 2-Energy spell that
    // turns a spent Recruit into two rainbow Power is the reason the friendly
    // branch is worth more than the enemy one.
    //
    // **`maxMight` is EFFECTIVE Might, not printed.** The rules evaluate a unit
    // on the board "according to their current Might" (the Mighty section's own
    // sentence), reserving printed Might for units in Non-Board Zones — so a
    // 2-Might unit standing under Garen - Commander's "+1 here" is a 3 and is not
    // a legal victim. `unitWithinMaxMight` is already that reading, and it is the
    // same route Gust's and Sandshifter's "N Might or less" take; the alternative
    // (printed) is the reading a "costing no more than" filter gets, and this is
    // not a cost filter. Enforced by the enumerator and the validator rather than
    // here, for Sandshifter's reason: a resolver check comes after the spell is
    // paid for.
    //
    // `scope` left at its default "battlefield" — the text names one, so a unit
    // sheltering in either base is out of reach (355.9.b).
    targeting: { kind: "unit", maxMight: 2 },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      // Whose it was, read BEFORE the kill — the same capture Hidden Blade above
      // makes for the same reason: by the time the second sentence is evaluated
      // the unit is in a trash and no longer anybody's at a battlefield. A lookup
      // afterwards would find nothing and pay out neither branch.
      const location = findUnitAnywhere(state, event.targetUnitInstanceId);
      // 359.3's null: the victim was gone by resolution, so "it" is nothing and
      // neither branch is satisfied — no Gold either way.
      if (!location) return state;
      const wasFriendly = location.ownerIndex === ctx.casterIndex;

      const killed = destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex);
      // **"If it WAS an enemy/friendly unit" is a question about WHOSE it was,
      // not about whether the kill landed** — so unlike Deathgrip's "if you do"
      // just below, this deliberately does NOT re-ask the board. The past tense
      // is forced by the ordering (the unit is in a trash by the time the clause
      // is read), and a card that meant to gate on the death says "if you do".
      // Consequence, stated: a victim saved by a death ward (809.1.b.1) still
      // pays out. Hidden Blade takes the same shape — its "its controller draws
      // 2" also survives a replaced kill.
      return placeGoldTokens(killed, ctx.casterIndex, wasFriendly ? 2 : 1);
    },
  },
  "SFD-163": {
    // Deathgrip — "[Reaction] Kill a friendly unit. If you do, give +Might equal
    // to its Might to another friendly unit this turn. Draw 1."
    //
    // `min: 2`, so the spell is simply not playable without two friendly units:
    // both the victim and the beneficiary are chosen and affected, so both are
    // Targets (355), and "in order to put a spell or ability on the chain, valid
    // choices must be made for all targets". Facebreaker above takes the same
    // reading of the same shape. It costs the caster the Draw on a one-unit
    // board, which is the price of the card being one instruction rather than
    // three.
    //
    // **`asymmetricSlots`, and it is the whole card.** Both slots are "friendly",
    // so enumeration would otherwise prune (B,A) once it had offered (A,B) — and
    // here the two are opposites: slot 0 DIES and slot 1 is pumped. Without it
    // half the plays are unreachable, which is exactly the gap Convergent
    // Mutation's note records.
    //
    // `scope: "anywhere"` for both — "a friendly unit", no battlefield named
    // (355.9.b).
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere", asymmetricSlots: true },
    resolve: (state, ctx, event) => {
      const victimId = event.targetUnitInstanceId;
      const beneficiaryId = event.secondTargetUnitInstanceId;
      // "Draw 1" is its own instruction on its own line, so it happens whatever
      // became of the other two — including a Deathgrip cast with no target left.
      const draw = (s: GameState) => drawCards(s, ctx.casterIndex, 1);
      if (!victimId) return draw(state);

      const location = findUnitAnywhere(state, victimId);
      if (!location) return draw(state);
      // "EQUAL TO ITS MIGHT", read BEFORE the kill and as EFFECTIVE Might: a
      // buffed or pumped unit grips harder, and by the time it is in a trash the
      // rules evaluate it at its printed Might instead ("Units in Non-Board Zones
      // are evaluated according to their printed Might"). Reading it after would
      // silently drop every modifier the unit was carrying.
      const might = effectiveMight(state, location.unit, location.ownerIndex, {
        isCombat: false,
        ...(location.zone === "base" ? {} : { battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id }),
      });

      const killed = destroyUnit(state, victimId, ctx.casterIndex);
      // "IF YOU DO" — a death ward or Zhonya's Hourglass REPLACES the death
      // (809.1.b.1), so the unit is still in play and the pump must not happen.
      // Asking the board is what distinguishes the two; a `killed !== state`
      // comparison would not, since a replacement changes the state too.
      if (findUnitAnywhere(killed, victimId)) return draw(killed);
      return draw(beneficiaryId ? giveMightThisTurn(killed, beneficiaryId, might) : killed);
    },
  },
  "SFD-166": {
    // Rally the Troops, SECOND clause only — "[Action] ... Draw 1."
    //
    // **The first clause is NOT implemented**: "When a friendly unit is played
    // this turn, buff it" is a DELAYED trigger armed by a spell, and this engine
    // has no general mechanism for one. Both existing delayed effects carry a
    // FIELD on the state that the firing site reads — Imperial Decree (OGN-221,
    // above) sets `killDamagedUnitsThisTurn` and `dealDamage` reads it; Targon's
    // Peak sets `readyRunesAtEndOfTurn` and `runEnd` reads it. Here the firing
    // site is a unit entering play, which only the shared play path sees, so the
    // clause needs a `PlayerState` flag plus a read in deploy/execute-play-card.
    //
    // The event route is closed too, and not by preference: `cardPlayed` is a
    // held event, but a Spell that has resolved is in a TRASH, and
    // `listeningTrashCards` is a named two-card set in triggers.ts — a shared
    // file. No per-domain registration can reach the moment.
    //
    // The draw is registered on its own because the card prints it as its own
    // instruction on its own line, unconditional on the clause above it
    // (135.2.b) — a Rally cast on a turn where no unit is ever played still
    // draws. Recorded for coverage.PARTIALLY_IMPLEMENTED.
    //
    // [Action] is the default play timing (own turn or a showdown) and is
    // enforced by engine/timing.ts, not here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-231": {
    // Commander Ledros — "As you play me, you may kill ANY NUMBER of friendly
    // units as an additional cost. Reduce my cost by [1 Order] for each killed
    // this way."
    //
    // Cruel Patron below, made repeatable and made to pay for itself. The
    // discount lives in the COST pipeline (`UnitCostSpec.repeatable`, priced per
    // variant in legal-actions and re-derived in validate-play-card); all that is
    // left here is spending what was named.
    //
    // `destroyUnit` per unit, for the reason Cruel Patron records: paying a cost
    // with a unit is still a death, so each fires its own [Deathknell] and can be
    // replaced by a death ward. Killing four bodies to land a free 6/4 is meant
    // to be expensive, and a quieter removal would make it cheaper than printed.
    //
    // No `killerIndex`, same as Cruel Patron — paying a cost with your own unit
    // is not "you killing it" in the sense Solari Shrine asks about.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitId, event) =>
      (event.additionalCostUnitInstanceIds ?? []).reduce((next, id) => destroyUnit(next, id), state),
  },
  "OGN-208": {
    // Cruel Patron — "As an additional cost to play me, kill a friendly unit."
    //
    // The card has no other text: the kill IS the whole entry, and it is a COST,
    // not an effect. That distinction is why it rides on
    // `additionalCostUnitInstanceId` (rule 355.11 — a cost is not a target) and
    // why `targeting` is "none". Enumeration offers no decline variant for it,
    // so a Cruel Patron with nothing of yours to kill is never playable.
    //
    // It is paid here, on play, rather than at resolution — a Unit's trigger
    // fires the moment it enters play, which is when a cost is due.
    //
    // destroyUnit, not a bespoke removal: paying a cost with a unit is still a
    // death, so [Deathknell] fires (808) and a death ward can replace it
    // (809.1.b.1). Being a cost does not make it a quieter kill.
    targeting: { kind: "none" },
    // No killerIndex: paying a cost with your own unit is not you "killing" it
    // in the sense Solari Shrine asks about, and naming the caster here would
    // let a card that watches for kills fire on its controller's own upkeep.
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostUnitInstanceId ? destroyUnit(state, event.additionalCostUnitInstanceId) : state,
  },
  "OGN-234": {
    // Harnessed Dragon — "When you play me, kill an enemy unit."
    //
    // "An enemy unit" with no battlefield named, so scope "anywhere": a unit
    // sheltering in the opponent's base is a legal target (355.9.b).
    //
    // destroyUnit, not damage: a Kill Instruction ignores Might and marked
    // damage, and routes through the funnel that fires [Deathknell] (808) and
    // honours a death ward (809.1.b.1). The caster is the killer.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "OGN-223": {
    // Peak Guardian — "When you play me, buff me. Then, if I am at a
    // battlefield, buff all other friendly units there."
    //
    // The second clause is conditional on WHERE he landed, which `destination`
    // carries: played to base he buffs only himself, played to a battlefield he
    // buffs the whole board there. Reading the board for his location instead
    // would work too, but the destination is what the play actually decided.
    //
    // "ALL OTHER" — every friendly unit at that battlefield except him, and
    // addBuff's 708 no-op handles the already-buffed ones without a filter.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) => {
      const buffedSelf = addBuff(state, unitId);
      const destination = event.destination;
      if (destination === "base") return buffedSelf;
      const bf = buffedSelf.battlefields.find((b) => b.id === destination.battlefieldId);
      const here = bf?.units[buffedSelf.players[ctx.casterIndex].id] ?? [];
      return here
        .filter((u) => u.instanceId !== unitId)
        .reduce((next, u) => addBuff(next, u.instanceId), buffedSelf);
    },
  },
  "OGN-217": {
    // Trifarian Gloryseeker — "[Legion] — When you play me, buff me."
    //
    // `countingSelf: true` (see legionActive): an on-play trigger already counts
    // the card that caused it.
    //
    // addBuff on its own instanceId, so 708's "not placed instead" applies — a
    // Gloryseeker that somehow arrives buffed gains nothing, which is the rule
    // rather than a case to special-case.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => (legionActive(state, ctx.casterIndex, true) ? addBuff(state, unitId) : state),
  },
  "OGN-218": {
    // Vanguard Captain — "[Legion] — When you play me, play two 1-Might Recruit
    // unit tokens here."
    //
    // "HERE" — the tokens land wherever the Captain did, which is what
    // `event.destination` carries; a Captain played to base makes them in base.
    // Two separate placements rather than a count, because placeRecruitToken
    // mints one token and two tokens are two game objects.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      if (!legionActive(state, ctx.casterIndex, true)) return state;
      const once = placeRecruitToken(state, ctx.casterIndex, event.destination);
      return placeRecruitToken(once, ctx.casterIndex, event.destination);
    },
  },
  "OGN-243": {
    // Darius - Executioner — "[Legion] — When you play me, ready me. Other
    // friendly units have +1 Might here."
    //
    // Two clauses with different lifetimes, so only the first is here: the
    // ready is a one-off gated on Legion, while the aura is continuous,
    // ungated, and lives in effective-might.ts with the other positional auras.
    // Reading the card as though Legion gated both would be a plausible
    // misreading — the keyword sits before the first sentence only.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => (legionActive(state, ctx.casterIndex, true) ? readyUnit(state, unitId) : state),
  },
  "OGN-225": {
    // Solari Chief — "When you play me, choose an enemy unit. If it is stunned,
    // kill it. Otherwise, stun it."
    //
    // The stunned check reads the board at RESOLUTION, not at the moment the
    // target was chosen: the choice rides on the action, and a stun landing in
    // between (another Solari card, an opponent's reaction) has to count. Asking
    // `findUnitAnywhere` here rather than caching anything is what gets that.
    //
    // "An enemy unit", with no battlefield named — so scope: "anywhere" and a
    // unit sheltering in the opponent's base is a legal target. The `owner`
    // constraint is printed, so it is not optional the way Rune Prison's is.
    //
    // destroyUnit, not dealDamage: "kill it" is a Kill Instruction, so Might and
    // marked damage are irrelevant, and the caster is the killer.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const location = findUnitAnywhere(state, targetId);
      if (!location) return state;
      return location.unit.stunned
        ? destroyUnit(state, targetId, ctx.casterIndex)
        : stunUnits(state, ctx.casterIndex, [targetId]);
    },
  },
  "OGN-226": {
    // Spectral Matron — "When you play me, you may play a unit costing no more
    // than [3] and no more than [rainbow] from your trash, ignoring its cost."
    //
    // The cost filter is genuinely TWO conditions and both are printed: no more
    // than 3 Energy AND no more than one RAINBOW Power pip. Rainbow means any
    // domain (see payPowerFromChanneled's `null`), so it constrains the SIZE of
    // the Power cost and not its colour — a 1-Fury-Power unit qualifies for an
    // Order card. Read off the printed cost, which is what a "costing no more
    // than" filter asks: the rules' own Defy example says such a filter "only
    // checks the printed or copied cost of its target".
    //
    // Asked at resolution rather than fanned onto the play, which is where a
    // Unit's on-play choice belongs anyway — rule 355 (Make Relevant Choices)
    // excludes "making choices for Triggered Abilities of permanents" from the
    // choices made as a card is played, and gives exactly this shape as its
    // example: "a unit with a triggered ability that says 'When I'm played, kill
    // a unit' does not require you to choose a target as it's played. The target
    // will be chosen when the ability triggers."
    //
    // Guarded on there being something to offer, so a Matron played with a trash
    // full of expensive units queues no question at all rather than one whose
    // only answer is "decline".
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      matronPlayableFromTrash(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "OGN-226-play", playerIndex: ctx.casterIndex }),
  },
  "OGN-230": {
    // Albus Ferros — "When you play me, spend any number of buffs. For each buff
    // spent, channel 1 rune exhausted."
    //
    // "ANY NUMBER" including zero, so this is a repeated question with a standing
    // "stop" answer rather than one multi-select: 355 makes "any number" mean the
    // player "may choose any number of available targets, including zero". The
    // buffs themselves are never targets — 355.6's Targeting list is explicit
    // that "'When you play me, you may spend a buff to move a friendly unit'
    // targets the friendly unit, but not the buff".
    //
    // The decision below re-parks itself after each spend, so the count is
    // discovered rather than declared. That is what makes "any number" honest
    // without a new multi-select mechanism, and it terminates because every
    // answer that continues also removes a buff from the board.
    //
    // Exhausted runes, via the same helper Stormclaw Ursine and Soaring Scout
    // use: a rune that can pay Power this turn but no Energy until Awaken.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      buffedOwnUnits(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "OGN-230-spend", playerIndex: ctx.casterIndex }),
  },
  "SFD-157": {
    // Royal Guard — "When you play me, play a 2 Might Sand Soldier unit token
    // here."
    //
    // "HERE" is `event.destination`, Vanguard Captain's reading exactly: a Royal
    // Guard played to base makes his Sand Soldier in base, and one reinforcing a
    // battlefield makes it there. Not "where he stands at resolution" — the
    // trigger is held, and the window between is when he can be moved or killed.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeToken(state, ctx.casterIndex, event.destination, SAND_SOLDIER_TOKEN),
  },
  "SFD-158": {
    // Sandshifter — "When you play me, kill an enemy unit with 3 Might or less."
    //
    // `maxMight` is a filter on the TARGET, enforced by the enumerator and the
    // validator (target-lookup's `unitWithinMaxMight`), which read EFFECTIVE
    // Might — so a 2-Might unit standing under an aura that makes it 4 is not
    // offered. Checking it in the resolver instead would come too late: the unit
    // would already be in play and the ability already on the chain.
    //
    // Scope "anywhere": "an enemy unit" names no battlefield (355.9.b), so one
    // sheltering in the opponent's base is a legal target — Harnessed Dragon's
    // reading of the same phrase.
    targeting: { kind: "unit", owner: "enemy", maxMight: 3, scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "SFD-174": {
    // Trove Golem — "When you play me, play four Gold gear tokens exhausted."
    //
    // An 8-Energy 2-Power 9-Might body that refunds four rainbow Power over the
    // following turns, which is the whole card.
    //
    // **No "here", and none is possible**: gear lives in `PlayerState.activeGear`,
    // a flat per-player list with no location at all, so `event.destination` —
    // load-bearing for Royal Guard and Vanguard Captain, whose tokens are UNITS —
    // has nothing to say here. A Golem played to a battlefield and one played to
    // base make the same four tokens.
    //
    // `placeGoldTokens` rather than four calls: it mints four distinct game
    // objects with four instanceIds (pinned in test/gear-tokens.test.ts), which is
    // the property Vanguard Captain's "two separate placements" note is really
    // about — one token per placement, not one placement per count.
    //
    // "EXHAUSTED" is printed, and the helper is the exhausted form. A ready Gold
    // token would be four rainbow Power on the turn the Golem lands, which is a
    // different and much better card.
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeGoldTokens(state, ctx.casterIndex, 4),
  },
  "SFD-175": {
    // Undertitan, FIRST clause only — "When you play me, give your other units +2
    // Might this turn."
    //
    // "YOUR OTHER units", so `giveMightThisTurnToAllFriendlies` is not it: that
    // helper has no way to exclude the source, and the Undertitan pumping itself
    // would be a 7-Might body rather than a 5-Might one that makes a board.
    // Per-unit `giveMightThisTurn` over the walk, with his own id filtered out.
    //
    // No "here": a unit at home is pumped too, which is Grand Strategem's
    // distinction and is printed the same way.
    //
    // The this-turn form rather than a Buff — it expires in the Expiration Step
    // (317) instead of persisting (710), and +2 is not a thing a Buff can be.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => u.instanceId !== unitId)
        .reduce((next, u) => giveMightThisTurn(next, u.instanceId, 2), state),
  },
};

/**
 * The units among the top 5 of `d.playerIndex`'s deck that Baited Hook may banish
 * and play — Might no more than `d.count`, which the ability captured as the
 * killed unit's effective Might plus 1.
 *
 * `d.count === undefined` means the victim was gone when the ability resolved
 * (359.3.e.14): the player still looks and still recycles, but nothing qualifies.
 *
 * A card in a DECK has no modifiers, so its Might is necessarily the printed one —
 * the asymmetry with the victim's effective Might is inherent to where the two
 * live, not a choice made here.
 */
function hookPlayableFromTop5(state: GameState, d: { playerIndex: 0 | 1; count?: number }): UnitInstance[] {
  if (d.count === undefined) return [];
  return state.players[d.playerIndex].deck
    .slice(0, 5)
    .filter((c): c is UnitInstance => c.kind === "Unit" && c.might <= d.count!);
}

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Soaring Scout — "[Deathknell] Channel 1 rune exhausted." (rule 808)
  //
  // Exhausted, not Ready: the rune can still be recycled to pay a Power cost
  // this turn but cannot pay Energy until the next Awaken readies it, which is
  // what makes it weaker than a free rune. Same helper Stormclaw Ursine's
  // on-play trigger uses, so the two cannot drift.
  "OGN-216": (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1),

  // Machine Evangel — "[Deathknell] — Play three 1-Might Recruit unit tokens
  // into your base." (rule 808)
  //
  // "INTO YOUR BASE" is printed, so unlike Vanguard Captain's "here" this ignores
  // where the Evangel died — a Deathknell that fired at a battlefield still sends
  // all three home. `ctx.casterIndex` is the dying unit's controller, which is
  // what "your" means for a Deathknell.
  //
  // Three separate placements rather than a count: placeRecruitToken mints one
  // token and three tokens are three game objects with three instanceIds.
  "OGN-239": (state, ctx) =>
    [0, 1, 2].reduce((next) => placeRecruitToken(next, ctx.casterIndex, "base"), state),

  // Honest Broker — "[Deathknell] — Play a Gold gear token exhausted." (rule 808)
  //
  // A 2-Energy 2-Might body that cashes itself in when it dies: the token is
  // GEAR, so it outlives the unit that made it and sits in `activeGear` waiting
  // to be spent, which is what makes trading the Broker off a gain rather than a
  // loss.
  //
  // `ctx.casterIndex` is the dying unit's controller — what "you" means for a
  // Deathknell — and NOT whoever killed it. Reading the killer would hand the
  // Gold to an opponent who removed him, which inverts the card.
  //
  // Nothing is read off `death.unit`, unlike Unsung Hero below: this Deathknell
  // has no condition, so there is nothing about the corpse to ask about.
  "SFD-155": (state, ctx) => placeGoldTokens(state, ctx.casterIndex, 1),

  // Unsung Hero — "[Deathknell] — If I was [Mighty], draw 2." (rule 808)
  //
  // "WAS", past tense, and that is the card: he prints 2 Might, and the rules
  // evaluate a unit in a non-Board zone at its PRINTED Might ("A unit in the
  // trash is Mighty if its printed Might is 5 or greater"), so asking about the
  // copy in the trash would make this text unreachable. It is asked of
  // `death.unit` — the unit as it died, which 809.1.b.3 requires be captured
  // before the card moves — so the buff and the pumps that got him to 5 count.
  //
  // `isMighty` rather than a hand-written `>= 5`: the threshold is a rule, not a
  // per-card number, and the same predicate answers for Fiora - Victorious.
  //
  // **Known limitation, named:** a unit that was Mighty only because of a
  // POSITIONAL aura (Garen - Commander's "+1 here") is not seen — `isMighty`
  // asks with no battlefield, and by now the unit is at none. Everything the
  // unit carried on itself (Might, buff, this-turn pumps) is counted.
  "SFD-167": (state, ctx, death) => (isMighty(state, death.unit, death.ownerIndex) ? drawCards(state, ctx.casterIndex, 2) : state),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/**
 * Listeners for someone ELSE dying, keyed by the LISTENING card's defId.
 * Distinct from `deathTriggers` above, which is a [Deathknell] keyed by the
 * DYING card — "when a buffed friendly unit dies" is a property of the watcher,
 * not of the corpse.
 */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {
  "OGN-228": {
    // Vanguard Helm — "When a buffed friendly unit dies, buff another friendly
    // unit."
    //
    // "BUFFED" is read off the unit AS IT DIED (`death.unit`), which 809.1.b.3
    // requires be captured before the card reaches the trash — by now it is in
    // one, and killUnit has already stripped the buff off the trashed copy
    // (rule 709). Asking the board would find nothing.
    //
    // "ANOTHER" excludes the unit that died, which is free here since it is no
    // longer in play; what it really excludes is nothing else, so any surviving
    // friendly unit is eligible.
    // Both printed conditions are facts about the DEATH — whose unit it was, and
    // whether it was buffed as it died — so both decide whether the Helm
    // triggered. "Is there anything left to buff" is a question about the board
    // at resolution and stays below: a trigger that fires and finds nothing is
    // 422 working.
    applies: (_state, listener, death) => death.ownerIndex === listener.ownerIndex && death.unit.buffed,
    resolve: (state, listener) => {
      const candidates = ownUnitsEverywhere(state, listener.ownerIndex);
      if (candidates.length === 0) return state;
      return parkDecision(state, { kind: "OGN-228-buff", playerIndex: listener.ownerIndex });
    },
  },
  "OGN-246": {
    // Viktor - Leader — "When another non-Recruit unit you control dies, play a
    // 1 Might Recruit unit token into your base."
    //
    // Two exclusions, both printed and both load-bearing: "ANOTHER" (Viktor's
    // own death does not pay out) and "NON-RECRUIT" — without the second he
    // would replace each token with another forever, which is a livelock rather
    // than a combo.
    // All three are facts about the death, so all three are fire-time.
    applies: (_state, listener, death) =>
      death.ownerIndex === listener.ownerIndex &&
      death.unit.instanceId !== listener.card.instanceId && // "another"
      !death.unit.isToken, // the Recruit tokens he makes
    resolve: (state, listener) => placeRecruitToken(state, listener.ownerIndex, "base"),
  },
  "SFD-169": {
    // Altar of Memories — "When a friendly unit dies, you may exhaust me to draw
    // 1, then put a card from your hand on the top or bottom of your Main Deck."
    //
    // Solari Shrine's shape (triggers.ts) with a second half: the same
    // "you may exhaust this to draw 1" split, so the same division of labour.
    // "A FRIENDLY unit" is a fact about the death, measured against the ALTAR's
    // controller, so it settles at fire time (383.4) — a gear that triggered for
    // the opponent's losses would be a different card.
    //
    // The EXHAUST is deliberately not asked here. It is the ability's cost, a
    // question about the board when it resolves, and the response window can
    // exhaust the Altar; never offer what cannot be paid.
    applies: (_state, listener, death) => death.ownerIndex === listener.ownerIndex,
    resolve: (state, listener) => {
      // A Gear in play, so the narrowing is a formality — `Listener.card` is a
      // CardInstance since trash listeners share the type, and a Spell has no
      // `exhausted`.
      if (listener.card.kind === "Spell" || listener.card.exhausted) return state;
      return parkDecision(state, {
        kind: "SFD-169-draw",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "SFD-153": {
    // Eye of the Herald — "When I move, play a 1 [Might] Recruit unit token here."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // The only one of the eight that is NOT positional: it fires on the wearer's
    // own move, so it matches on the moving unit's id rather than on a
    // battlefield. "HERE" is where the wearer ARRIVED — `event.to` — which is why
    // the destination comes off the event and not off the listener, whose
    // battlefieldId is re-derived and would be right only by luck.
    on: "unitMoved",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return event.kind === "unitMoved" && wearer !== undefined && event.unitInstanceId === wearer.card.instanceId;
    },
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : placeRecruitToken(state, wearer.ownerIndex, { battlefieldId: event.to });
    },
  },
  "OGN-235": {
    // Karma - Channeler — "[Vision] When you recycle one or more cards to your
    // Main Deck, buff a friendly unit."
    //
    // Her [Vision] is printed and handled by the play funnel; only this half is
    // here. The event is `cardsRecycled`, held like every other Pending Item,
    // and it exists because recycling happens in nine unrelated places — a
    // per-card table keyed by the recycling card could never see her.
    //
    // "ONE OR MORE cards" pays out ONCE per instruction however many moved,
    // which is what the event's own shape already guarantees, and why she does
    // not read `event.count` at all.
    on: "cardsRecycled",
    applies: (state, listener, event) =>
      event.kind === "cardsRecycled" &&
      // "to YOUR Main Deck" — the deck that RECEIVED the cards, which is the
      // reading the event carries; see its own note for why it is Unverified.
      event.ownerIndex === listener.ownerIndex &&
      // Nothing to buff is nothing to do (422), and a held trigger with no
      // effect is a response window opened for nothing.
      ownUnits(state, listener.ownerIndex).length > 0,
    resolve: (state, listener, event) =>
      event.kind === "cardsRecycled" && ownUnits(state, listener.ownerIndex).length > 0
        ? parkDecision(state, { kind: "OGN-235-buff", playerIndex: listener.ownerIndex })
        : state,
  },
  "SFD-152": {
    // Eminent Benefactor — "When I hold, play two Gold gear tokens exhausted."
    //
    // "When **I** hold" is the positional reading Ahri - Alluring and
    // Blitzcrank - Impassive take of the same phrase (effects/calm.ts): the
    // battlefield being held has to be the one the Benefactor is standing at, not
    // merely one his controller held somewhere. The event carries a battlefield
    // for exactly that reason, and `listener.battlefieldId` is where he stands.
    //
    // A hold is the SCORING moment (471.1.a — "maintains Control of a Battlefield
    // they did not yet Score this turn"), so a battlefield already conquered this
    // turn fires nothing (471.1.b) and pays no Gold. That is the event's own
    // contract; nothing here has to check it.
    //
    // Both conditions are fixed at FIRE time, which matters more here than the
    // ordinary reason: this trigger is held, and the window it opens is exactly
    // when an opponent would move or kill him. Re-asking at resolution would let
    // them cancel a payout that has already been earned (809.1.b — the ability is
    // independent of its source once it is on the chain).
    //
    // No guard on there being anything to do: `placeGoldTokens` always has
    // somewhere to put them, so unlike Karma - Channeler there is no "nothing to
    // affect" case worth suppressing the Pending Item for.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "battlefieldHeld" ? placeGoldTokens(state, listener.ownerIndex, 2) : state,
  },
  "SFD-170": {
    // Rek'Sai - Swarm Queen — "When I attack, you may reveal the top 2 cards of
    // your Main Deck. You may banish one, then play it. If it is a unit, you may
    // play it here. Recycle the rest."
    //
    // Registered as a `combatBegan` listener rather than added to
    // unit-triggers.ts's ATTACK_TRIGGERS table — that table is a shared file, and
    // `isAttackingAt` is exported precisely so a per-domain file can take the same
    // shape without editing it (383.4.f: the trigger is gaining the Attacker
    // designation, which 465's Combat Step 1 hands out).
    //
    // Guarded on there being a deck to look at, so an empty one places no Pending
    // Item at all rather than one whose only answer is "decline".
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (state.players[listener.ownerIndex].deck.length === 0) return state;
      // "HERE" rides on the decision, not on where she stands when it is
      // answered: a held trigger's response window is exactly when an opponent
      // would move or kill her, and the ability is independent of her by then
      // (809.1.b).
      return parkDecision(state, {
        kind: "SFD-170-reveal",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-177": {
    // Azir - Sovereign — "When I attack, you may move any number of your token
    // units to this battlefield." (His [Accelerate] is a cost keyword the play
    // path handles — rule 805 — and is not part of this trigger.)
    //
    // Same `combatBegan` + `isAttackingAt` registration as Rek'Sai above.
    //
    // "ANY NUMBER" including zero, so it is a repeated question with a standing
    // "stop" rather than one multi-select — Albus Ferros' shape, and it terminates
    // for the same reason his does: every answer that continues also removes a
    // candidate from the list (the token is now here).
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      // Nothing to move is not a question. A held trigger that resolves to
      // nothing still closes the chain and costs both players a PassFocus.
      if (movableTokensFor(state, listener.ownerIndex, event.battlefieldId).length === 0) return state;
      return parkDecision(state, {
        kind: "SFD-177-move",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-179": {
    // Corina Veraza — "When I move to a battlefield, play three 1 Might Recruit
    // unit tokens here." (Her [Accelerate] is handled by the play path, 805.)
    //
    // Registered against the `unitMoved` EVENT rather than in unit-triggers.ts's
    // ON_MOVE_TRIGGERS table, for the same reason the two attack triggers above
    // are event listeners: that table is a shared file, while this event is
    // already held (383) and already carries everything she needs. The two
    // mechanisms fire at the same moment and both resolve a chain-pop later, so
    // the choice costs nothing but the file it lives in.
    //
    // It fires only for a STANDARD move (execute-move-unit), which is what the
    // card says: a Recall is not a Move (454), and a spell-driven relocation
    // (`forceMoveToBattlefield`) is deliberately outside the event too — so
    // Corina dragged somewhere by an opponent's card makes nothing.
    //
    // `to` is always a battlefield id (a MoveUnit action names one), so "to a
    // battlefield" needs no test of its own.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      // Identity, not ownership: the event is about ONE unit, and hers is the
      // only move she cares about. "When I move", not "when a friendly unit
      // moves".
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved"
        ? // Three separate placements rather than a count: `placeRecruitToken`
          // mints one token, and three tokens are three game objects.
          [0, 1, 2].reduce((next) => placeRecruitToken(next, listener.ownerIndex, { battlefieldId: event.to }), state)
        : state,
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "OGN-212": {
    // Forge of the Future — "When you play this, play a 1-Might Recruit unit
    // token at your base." (Its "Kill this:" ability is in activated-abilities.)
    //
    // A SELF-trigger rather than an event listener: a Gear entering play is not
    // something the listener walk reaches for its own arrival, which is the same
    // reason Scrapheap is keyed this way.
    //
    // "At YOUR BASE" is printed, so the token goes home regardless of anything
    // else on the board — unlike Faithful Manufactor's "here".
    on: ["played"],
    resolve: (state, event) => placeRecruitToken(state, event.ownerIndex, "base"),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {
  // Vanguard Helm's "buff another friendly unit", raised by its death-watch.
  //
  // WHICH unit is a real choice with no action to hang it on — the trigger fires
  // inside a death, mid-resolution. Already-buffed units stay on offer: 708
  // makes a second buff a no-op rather than an illegal choice, and filtering
  // them would quietly change "another friendly unit" into "another UNBUFFED
  // friendly unit", which matters when everything you control is already buffed.
  /** Karma - Channeler's "buff a friendly unit" — Vanguard Helm's question with
   *  her name on it, and no "another" narrowing, so she may buff herself. */
  "OGN-235-buff": {
    prompt: () => "Karma - Channeler: buff a friendly unit",
    options: (state, d) =>
      ownUnits(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
  "OGN-228-buff": {
    prompt: () => "Vanguard Helm: buff another friendly unit",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
  // Cull the Weak's half of the work: one player picking which of their own
  // units dies. Asked of BOTH players, so it is written from the answering
  // player's point of view rather than the caster's.
  "OGN-209-kill": {
    prompt: () => "Cull the Weak: kill one of your units",
    // "One of their units" names no battlefield, so a unit in base is as
    // eligible as one at a battlefield — 355.9.b, the bare noun "unit" means
    // objects on the Board, and Bases are Public.
    //
    // No options at all when the player has no units: rule 422's "do as much as
    // you can" shape, and advanceDecisions drops a question with no answers
    // rather than deadlocking on it. Exactly one unit is likewise not a choice,
    // and is killed without a prompt.
    options: (state, d) =>
      ownUnits(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    // The killer is the player answering, not the caster: 209 makes each player
    // kill one of THEIR OWN, so a watcher asking "did you kill an enemy unit"
    // correctly sees a friendly death and stays quiet.
    resolve: (state, d, optionId) => destroyUnit(state, optionId, d.playerIndex),
  },
  // King's Edict's half of the work: the OPPONENT naming which of their units
  // the spell kills. `d.playerIndex` is the answering player, so the caster is
  // the other seat — the same way Shakedown's question reads its caster back.
  "OGN-237-kill": {
    prompt: () => "King's Edict: choose one of your units to be killed",
    // "A unit YOU don't control", read from the answering player's side: with two
    // seats, the units the caster does not control are exactly this player's own.
    // No battlefield is named, so a unit in base is as eligible as one standing
    // out — the bare noun "unit" means objects on the Board, and Bases are Public.
    //
    // No options with no units, which advanceDecisions drops rather than
    // deadlocking on; exactly one unit is not a choice and is killed unprompted.
    options: (state, d) =>
      ownUnits(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    // The KILLER is the spell's controller, not the player answering. "Each other
    // player CHOOSES a unit... Kill those units" splits the two: the choice is
    // theirs, the kill is the spell's, and the spell is the caster's. That is the
    // one place this card differs from Cull the Weak, where each player kills
    // their own — and it decides whether Solari Shrine's "when YOU kill a stunned
    // enemy unit" pays out for the caster.
    resolve: (state, d, optionId) => destroyUnit(state, optionId, d.playerIndex === 0 ? 1 : 0),
  },
  // Spectral Matron's "you may play a unit ... from your trash, ignoring its
  // cost". Flame Chompers' question in every respect but the filter and who
  // asks: same decline-first shape, same out-of-trash-then-playUnitToBase path.
  "OGN-226-play": {
    prompt: () => "Spectral Matron: play a unit from your trash, ignoring its cost?",
    options: (state, d) => {
      // "You may" — declining leads, so doing nothing is what a mis-click and the
      // AI's tie-break both land on. Same convention as Flame Chompers.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const card of matronPlayableFromTrash(state, d.playerIndex)) {
        options.push({ id: card.instanceId, label: card.name, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Re-checked against the live list rather than trusted from the option id:
      // the question can sit behind another whose answer emptied the trash.
      const card = matronPlayableFromTrash(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (!card) return state;

      // "IGNORING ITS COST" — nothing is paid and nothing is discounted, the same
      // reading rule 811 gives a hidden play: the payment is EMPTY rather than
      // small. `cardsPlayedThisTurn` still moves, because this is a play and
      // [Legion] counts plays rather than payments.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== optionId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // Through the shared deploy funnel, so it enters exhausted (143.4.a) unless
      // something on the board says otherwise and both events a real play fires
      // go off. The card says "play a unit"; this is what playing one means.
      return playUnitFree({ ...state, players }, d.playerIndex, card);
    },
  },
  /**
   * Baited Hook's "look at the top 5, you may banish a unit from among them with
   * Might up to 1 more than the killed unit and play it, ignoring its cost. Then
   * recycle the rest."
   *
   * The ability itself lives in `engine/activated-abilities.ts` — there is no
   * per-domain registry for those — and it kills the chosen unit before parking
   * this. The Might cap rides on `d.count`, captured at kill time because the
   * victim is in a trash by now.
   *
   * **`count === undefined` is 359.3.e.14's null, not a cap of zero**, and the
   * PDF works this exact card: if the victim was no longer a legal target, "its
   * Might is treated as null. Baited Hook's controller looks at the top 5 cards of
   * their Main Deck, but can't choose any unit from among them." So the look and
   * the recycle still happen and nothing is playable — which is why the two cases
   * are kept distinguishable rather than collapsed to a number.
   *
   * "Then recycle the rest" runs on EVERY answer including the decline, because
   * it is a separate instruction from the banish-and-play (135.2.b's four
   * instructions, the same structure as Teemo - Strategist's trigger).
   */
  "OGN-242-banish": {
    prompt: () => "Baited Hook: banish a unit from the top 5 and play it free?",
    options: (state, d) => {
      // Decline leads, as everywhere else a "you may" is asked.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const card of hookPlayableFromTop5(state, d)) {
        options.push({ id: card.instanceId, label: card.name, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      const top5 = state.players[d.playerIndex].deck.slice(0, 5);
      const chosen = optionId === "decline" ? undefined : hookPlayableFromTop5(state, d).find((c) => c.instanceId === optionId);

      // Recycle the rest FIRST, so the deck arithmetic is done against the five
      // that were actually looked at. Whatever was banished-and-played is simply
      // not among them.
      const rest = top5.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(top5.length), ...rest],
        ...(chosen ? { cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1 } : {}),
      };
      const recycled = holdCardsRecycled({ ...state, players }, d.playerIndex, rest.length);
      // The banish is transient — the card is banished and played in the same
      // instruction, and nothing can observe the intermediate zone — so it goes
      // straight to play rather than through `PlayerState.banished`, which still
      // has no writers. Recorded in docs/rules-conformance.md.
      // `d.battlefieldId` is where the bait stood when it was killed, captured on
      // the decision because the board no longer knows: the unit is in a trash and
      // the Cleanup between the two submits has already lapsed control there.
      return chosen ? playUnitFree(recycled, d.playerIndex, chosen as UnitInstance, d.battlefieldId) : recycled;
    },
  },
  // Albus Ferros' "spend any number of buffs". Asked once per buff, with a
  // standing "stop" — see his trigger above for why the count is discovered
  // rather than declared.
  "OGN-230-spend": {
    prompt: () => "Albus Ferros: spend a buff to channel 1 rune exhausted?",
    options: (state, d) => {
      // "Stop" leads for the same reason Flame Chompers' decline does, and it is
      // ALWAYS present — which is also what lets advanceDecisions retire the
      // question on its own once the last buff is gone (one option, no prompt).
      const options: DecisionOption[] = [{ id: "stop", label: "Spend no more buffs" }];
      for (const unit of buffedOwnUnits(state, d.playerIndex)) {
        options.push({ id: unit.instanceId, label: `Spend ${unit.name}'s buff`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "stop") return state;
      // spendBuff returns undefined rather than an unchanged state when the spend
      // is illegal (705), so an unpayable answer must not channel — the payoff
      // would otherwise be free.
      const spent = spendBuff(state, d.playerIndex, optionId);
      if (!spent) return state;
      // Channelled per buff rather than counted up and channelled once. Identical
      // in outcome ("for EACH buff spent"), and it keeps the two halves of one
      // answer together, so a rune deck that runs dry mid-sequence stops paying
      // out exactly where it ran out.
      const channelled = channelRunesExhausted(spent, d.playerIndex, 1);
      // And ask again — "any number".
      return parkDecision(channelled, { kind: "OGN-230-spend", playerIndex: d.playerIndex });
    },
  },
  // Guards!'s "you may pay [Order] to ready it", raised as the spell resolves.
  //
  // A "you may" with a PRICE, so it is a decision rather than something the
  // caster is simply given — and the price is checked twice on purpose: once to
  // decide whether to offer the option at all (never offer what cannot be paid,
  // the same shape `canPayActivationCost` uses) and once when the answer arrives,
  // because the rune can be gone by then.
  "SFD-154-ready": {
    prompt: () => "Guards!: pay 1 Order to ready the Sand Soldier?",
    options: (state, d) => {
      // Declining leads, as everywhere else a "you may" is asked.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (d.targetInstanceId === undefined) return options;
      // 359.3's null: the token can be killed between the spell resolving and
      // this being answered, and there is then nothing to ready.
      const token = findUnitAnywhere(state, d.targetInstanceId);
      if (!token || !token.unit.exhausted) return options;
      if (payPowerFromChanneled(state, d.playerIndex, "Order", 1) === undefined) return options;
      options.push({ id: "pay", label: "Pay 1 Order: ready it", instanceId: d.targetInstanceId });
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || d.targetInstanceId === undefined) return state;
      if (!findUnitAnywhere(state, d.targetInstanceId)) return state;
      // `payPowerFromChanneled` returns undefined rather than an unchanged state
      // when it cannot be paid (416.3), so an unpayable answer must not ready —
      // the payoff would otherwise be free.
      const paid = payPowerFromChanneled(state, d.playerIndex, "Order", 1);
      if (paid === undefined) return state;
      return readyUnit(paid, d.targetInstanceId);
    },
  },
  // Altar of Memories' two halves, asked in the order the card prints them.
  //
  // Two questions rather than one, because the second is not optional: once the
  // Altar is exhausted, "draw 1, THEN put a card from your hand on the top or
  // bottom" is a mandatory follow-up, and folding it into the first would let a
  // player take the draw and skip the cost of it.
  "SFD-169-draw": {
    prompt: () => "Altar of Memories: exhaust it to draw 1?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId);
      if (gear && !gear.exhausted) options.push({ id: "exhaust", label: "Exhaust: draw 1", instanceId: gear.instanceId });
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "exhaust" || d.cardInstanceId === undefined) return state;
      // `exhaustGear` no-ops on a gear that has left play or is already
      // exhausted, so comparing states is how the cost is confirmed paid — and
      // an unpaid cost must not draw.
      const exhausted = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      if (exhausted === state) return state;
      // "THEN" — the placement question is parked AFTER the draw, so the card
      // just drawn is one of the cards that may be put back. Parking it before
      // would invert that, which is the trap `discardThenDraw` exists for.
      return parkDecision(drawCards(exhausted, d.playerIndex, 1), { kind: "SFD-169-place", playerIndex: d.playerIndex });
    },
  },
  "SFD-169-place": {
    prompt: () => "Altar of Memories: put a card from your hand on the top or bottom of your Main Deck",
    // Both destinations per card, in ONE question rather than "which card" then
    // "which end": the card offers them as a single choice, and two questions
    // would let a player commit a card and then discover the end they wanted was
    // the same either way. An empty hand offers nothing and the question is
    // dropped as moot (422).
    options: (state, d) =>
      state.players[d.playerIndex].hand.flatMap((c) => [
        { id: `top:${c.instanceId}`, label: `${c.name} — top of deck`, instanceId: c.instanceId },
        { id: `bottom:${c.instanceId}`, label: `${c.name} — bottom of deck`, instanceId: c.instanceId },
      ]),
    resolve: (state, d, optionId) => {
      const separator = optionId.indexOf(":");
      if (separator === -1) return state;
      const cardInstanceId = optionId.slice(separator + 1);
      // The BOTTOM is a Recycle in rule 416's sense — "puts it on the bottom of
      // the corresponding deck" — so it goes through the shared helper and fires
      // `cardsRecycled` for Karma - Channeler. The TOP is not a Recycle and
      // deliberately fires nothing.
      if (optionId.slice(0, separator) === "bottom") return recycleCardFromHand(state, d.playerIndex, cardInstanceId);
      const actor = state.players[d.playerIndex];
      const card = actor.hand.find((c) => c.instanceId === cardInstanceId);
      if (!card) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...actor, hand: actor.hand.filter((c) => c.instanceId !== cardInstanceId), deck: [card, ...actor.deck] };
      return { ...state, players };
    },
  },
  /**
   * Rek'Sai - Swarm Queen's "you may reveal the top 2 ... you may banish one,
   * then play it ... recycle the rest".
   *
   * **Two printed "may"s flattened into one question**, and the flattening is
   * lossless: the outcomes are decline-and-touch-nothing, reveal-and-recycle-both,
   * and reveal-banish-play-one-and-recycle-the-other, all three of which are
   * options here. Asked as two questions it would be the same three outcomes at
   * the cost of a second Pending Item, and the first question's answer ("yes,
   * reveal") tells the player nothing they do not already see in the second.
   *
   * "RECYCLE THE REST" runs on every answer except the decline, because the
   * reveal is what it is about — a Rek'Sai who never looked has nothing to put
   * back. Same instruction structure as Baited Hook's, one instruction further
   * along.
   */
  "SFD-170-reveal": {
    prompt: () => "Rek'Sai - Swarm Queen: reveal the top 2 of your Main Deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const top2 = state.players[d.playerIndex].deck.slice(0, 2);
      if (top2.length === 0) return options;
      options.push({ id: "none", label: `Reveal ${top2.map((c) => c.name).join(", ")} and banish nothing` });
      for (const card of top2) {
        options.push({ id: card.instanceId, label: `Banish and play ${card.name}`, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const actor = state.players[d.playerIndex];
      const top2 = actor.deck.slice(0, 2);
      const chosen = top2.find((c) => c.instanceId === optionId);
      const rest = top2.filter((c) => c.instanceId !== chosen?.instanceId);

      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        deck: [...actor.deck.slice(top2.length), ...rest],
        // "PLAY it" — this is a card being played, so [Legion] and every
        // `cardPlayed` listener count it. `playCardIgnoringCost` fires the events
        // but deliberately does not pay or tally; the caller does.
        ...(chosen ? { cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1 } : {}),
      };
      const recycled = holdCardsRecycled({ ...state, players }, d.playerIndex, rest.length);
      if (!chosen) return recycled;
      // The banish is transient — banished and played in one instruction, with
      // nothing able to observe the intermediate zone — so it goes straight to
      // play rather than through `PlayerState.banished`, exactly as Baited Hook
      // does and as docs/rules-conformance.md records.
      //
      // **No destination is passed, and that is "you may play it here":** a free
      // unit play parks the shared placement question, which offers base and every
      // battlefield the player has presence at — Rek'Sai's own among them, since
      // she is standing in the fight. Passing `d.battlefieldId` would have made
      // "here" mandatory and dropped the "may". The known cost is that a player
      // with units at a THIRD battlefield may also send it there, which the shared
      // question allows and the card does not name.
      return playCardIgnoringCost(recycled, d.playerIndex, chosen);
    },
  },
  // Azir - Sovereign's "move any number of your token units to this
  // battlefield" — asked once per token, with a standing "stop".
  "SFD-177-move": {
    prompt: () => "Azir - Sovereign: move a token unit to this battlefield?",
    options: (state, d) => {
      // "Stop" is ALWAYS present, which is also what lets advanceDecisions retire
      // the question on its own once the last token has arrived.
      const options: DecisionOption[] = [{ id: "stop", label: "Move no more tokens" }];
      if (d.battlefieldId === undefined) return options;
      for (const token of movableTokensFor(state, d.playerIndex, d.battlefieldId)) {
        options.push({ id: token.instanceId, label: `Move ${token.name}`, instanceId: token.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "stop" || d.battlefieldId === undefined) return state;
      // `forceMoveToBattlefield`, not the Move ACTION: 415.1.b makes the exhaust
      // part of a Standard Move's cost rather than of moving, and this is a
      // Game Effect moving them (316.7.c) — so the tokens arrive as they were.
      // It applies Contested for their controller (458), which is what makes
      // walking reinforcements into someone else's battlefield an attack.
      const moved = forceMoveToBattlefield(state, optionId, d.battlefieldId);
      // Onto the FRONT: this is a continuation of the question being answered,
      // not a new one, so it must not be interleaved with another trigger's
      // question that was raised in the same combat.
      return repeatDecision(moved, { kind: "SFD-177-move", playerIndex: d.playerIndex, battlefieldId: d.battlefieldId });
    },
  },
  // Divine Judgment's eight questions, one definition — the four categories
  // differ only in what they list and what "recycle" means for it, and writing
  // them out four times would be four chances to paste the wrong pool.
  ...Object.fromEntries(
    JUDGMENT_CATEGORIES.map((category) => [
      `OGN-244-cut-${category}`,
      {
        prompt: (state: GameState, d: PendingDecision) =>
          `Divine Judgment: recycle one of your ${category} (keep ${JUDGMENT_KEEP}, ${judgmentPool(state, d.playerIndex, category).length} left)`,
        options: (state: GameState, d: PendingDecision) =>
          judgmentPool(state, d.playerIndex, category).map((item) => ({
            id: item.instanceId,
            label: item.name,
            instanceId: item.instanceId,
          })),
        resolve: (state: GameState, d: PendingDecision, optionId: string) => {
          const cut = recycleJudgmentItem(state, d.playerIndex, category, optionId);
          // Ask again from LIVE state rather than counting down: the pool is what
          // decides, and a unit that left play between two answers must not still
          // be owed a cut. Onto the FRONT, so this player finishes a category
          // before their next one starts.
          return judgmentPool(cut, d.playerIndex, category).length > JUDGMENT_KEEP
            ? repeatDecision(cut, { kind: `OGN-244-cut-${category}`, playerIndex: d.playerIndex })
            : cut;
        },
      },
    ]),
  ),
};

/** What one category holds for one player, as { instanceId, name } — a rune has
 *  no name of its own, so it is labelled by its domain. */
function judgmentPool(
  state: GameState,
  playerIndex: 0 | 1,
  category: JudgmentCategory,
): { instanceId: string; name: string }[] {
  const actor = state.players[playerIndex];
  switch (category) {
    case "units":
      return ownUnits(state, playerIndex).map((u) => ({ instanceId: u.instanceId, name: u.name }));
    case "gear":
      return actor.activeGear.map((g) => ({ instanceId: g.instanceId, name: g.name }));
    case "runes":
      return actor.channeled.map((r) => ({ instanceId: r.id, name: `${r.domain} rune` }));
    case "hand":
      return actor.hand.map((c) => ({ instanceId: c.instanceId, name: c.name }));
  }
}

/**
 * Recycles one named item out of one category.
 *
 * "Recycle" means the bottom of the owning deck (416) — the Main Deck for a
 * unit, a gear or a card in hand, the RUNE deck for a rune, which is the one
 * place the four categories genuinely differ. A recycled rune goes back Ready:
 * `state` is a rune's position in the turn, not a property of the card, and
 * every other path that returns a rune to its deck resets it the same way.
 */
function recycleJudgmentItem(
  state: GameState,
  playerIndex: 0 | 1,
  category: JudgmentCategory,
  instanceId: string,
): GameState {
  if (category === "units") return recycleUnitFromPlayToDeck(state, playerIndex, instanceId);
  if (category === "hand") return recycleCardFromHand(state, playerIndex, instanceId);
  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  if (category === "gear") {
    const gear = actor.activeGear.find((g) => g.instanceId === instanceId);
    if (!gear) return state;
    players[playerIndex] = {
      ...actor,
      activeGear: actor.activeGear.filter((g) => g.instanceId !== instanceId),
      // Not a death and not a trash: a Recycle is a zone change, so no
      // "when I am killed" fires — the same split `recycleUnitFromPlayToDeck`
      // spells out for units.
      deck: [...actor.deck, gear],
    };
    return holdCardsRecycled({ ...state, players }, playerIndex, 1);
  }
  const rune = actor.channeled.find((r) => r.id === instanceId);
  if (!rune) return state;
  players[playerIndex] = {
    ...actor,
    channeled: actor.channeled.filter((r) => r.id !== instanceId),
    runeDeck: [...actor.runeDeck, { ...rune, state: "Ready" as const }],
  };
  return { ...state, players };
}

/** Every unit a player has in play, base and battlefields alike. */
function ownUnits(state: GameState, playerIndex: 0 | 1) {
  const actor = state.players[playerIndex];
  return [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
}

/** The buffed units a player controls — Albus Ferros' spendable buffs. Rule 705.1
 *  restricts spending to units you control, so this never walks the opponent's. */
function buffedOwnUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return ownUnitsEverywhere(state, playerIndex).filter((u) => u.buffed);
}

/**
 * The units in a player's trash that Spectral Matron may play: "costing no more
 * than [3] and no more than [rainbow]".
 *
 * Both conditions, and `powerCost <= 1` rather than a domain check — a rainbow
 * pip is any domain, so what is bounded is how MANY Power the card costs. A
 * 0-Power unit passes trivially, which is most of the pool.
 */
function matronPlayableFromTrash(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return state.players[playerIndex].trash.filter(
    (c): c is UnitInstance => c.kind === "Unit" && c.energyCost <= 3 && c.powerCost <= 1,
  );
}

/**
 * Places one Sand Soldier and hands back the id of the token it made.
 *
 * `placeToken` returns only the new state, which is all every other caller
 * wants — and Guards! has to READY the token afterwards, so it needs to know
 * which one it is. Recovered by diffing the caster's units rather than by
 * teaching token.ts to return the token: every token is minted with a fresh
 * instanceId, so exactly one id is new, and the shared file stays untouched.
 *
 * `tokenInstanceId` is undefined when nothing was placed — `placeToken` no-ops
 * on a battlefield id that names nothing, the usual "target vanished" path.
 */
function placeSandSoldier(
  state: GameState,
  casterIndex: 0 | 1,
  destination: TokenDestination,
): { state: GameState; tokenInstanceId?: string } {
  const before = new Set(ownUnitsEverywhere(state, casterIndex).map((u) => u.instanceId));
  const placed = placeToken(state, casterIndex, destination, SAND_SOLDIER_TOKEN);
  const token = ownUnitsEverywhere(placed, casterIndex).find((u) => !before.has(u.instanceId));
  return { state: placed, ...(token ? { tokenInstanceId: token.instanceId } : {}) };
}

/**
 * The token units Azir - Sovereign could still move to `battlefieldId` — every
 * token its controller has anywhere ELSE, base included.
 *
 * `isToken` is the whole filter: "your TOKEN units" says nothing about where they
 * are or which token they are, so a Sand Soldier at another battlefield and a
 * Recruit sitting at home are equally eligible.
 *
 * Tokens already standing there are excluded, and that is what makes "any
 * number" terminate: every answer that moves one shortens this list.
 */
function movableTokensFor(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const here = new Set((bf?.units[state.players[playerIndex].id] ?? []).map((u) => u.instanceId));
  return ownUnitsEverywhere(state, playerIndex).filter((u) => u.isToken && !here.has(u.instanceId));
}
