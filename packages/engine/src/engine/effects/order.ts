import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  destroyUnit,
  drawCards,
  giveMightThisTurn,
  giveMightThisTurnToAllFriendlies,
  legionActive,
  ownUnitsEverywhere,
  readyUnit,
  spendBuff,
  stunUnits,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { placeRecruitToken } from "../token.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { playUnitToBase } from "../deploy.js";
import type { UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";

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
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/**
 * Listeners for someone ELSE dying, keyed by the LISTENING card's defId.
 * Distinct from `deathTriggers` above, which is a [Deathknell] keyed by the
 * DYING card — "when a buffed friendly unit dies" is a property of the watcher,
 * not of the corpse.
 */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {
  "OGN-228": (state, listener, death) => {
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
    if (death.ownerIndex !== listener.ownerIndex) return state; // not friendly to the Helm
    if (!death.unit.buffed) return state;
    const candidates = ownUnitsEverywhere(state, listener.ownerIndex);
    if (candidates.length === 0) return state;
    return parkDecision(state, { kind: "OGN-228-buff", playerIndex: listener.ownerIndex });
  },
  "OGN-246": (state, listener, death) => {
    // Viktor - Leader — "When another non-Recruit unit you control dies, play a
    // 1 Might Recruit unit token into your base."
    //
    // Two exclusions, both printed and both load-bearing: "ANOTHER" (Viktor's
    // own death does not pay out) and "NON-RECRUIT" — without the second he
    // would replace each token with another forever, which is a livelock rather
    // than a combo.
    if (death.ownerIndex !== listener.ownerIndex) return state;
    if (death.unit.instanceId === listener.card.instanceId) return state; // "another"
    if (death.unit.isToken) return state; // the Recruit tokens he makes
    return placeRecruitToken(state, listener.ownerIndex, "base");
  },
};

export const eventTriggers: Record<string, EventTriggerDefinition> = {};

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
      return playUnitToBase({ ...state, players }, d.playerIndex, card);
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
      const recycled: GameState = { ...state, players };
      // The banish is transient — the card is banished and played in the same
      // instruction, and nothing can observe the intermediate zone — so it goes
      // straight to play rather than through `PlayerState.banished`, which still
      // has no writers. Recorded in docs/rules-conformance.md.
      return chosen ? playUnitToBase(recycled, d.playerIndex, chosen as UnitInstance) : recycled;
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
};

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
