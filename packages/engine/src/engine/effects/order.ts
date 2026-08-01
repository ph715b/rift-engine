import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  destroyUnit,
  drawCards,
  giveMightThisTurnToAllFriendlies,
  legionActive,
  ownUnitsEverywhere,
  readyUnit,
  stunUnits,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { placeRecruitToken } from "../token.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { parkDecision } from "../decisions.js";
import type { GameState } from "../../model/game-state.js";

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
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
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
};

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
};

/** Every unit a player has in play, base and battlefields alike. */
function ownUnits(state: GameState, playerIndex: 0 | 1) {
  const actor = state.players[playerIndex];
  return [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
}
