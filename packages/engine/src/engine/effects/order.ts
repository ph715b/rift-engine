import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellDefinition, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  addDamagePreventionPool,
  canSpendXp,
  channelRunesExhausted,
  destroyUnit,
  disempowerPermanent,
  drawCards,
  exhaustGear,
  forceMoveToBattlefield,
  gainPoints,
  gainXp,
  giveMightThisTurn,
  giveMightThisTurnToAllFriendlies,
  giveMightThisTurnToOwnUnit,
  grantTemporary,
  legionActive,
  holdCardsRecycled,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recycleCardFromHand,
  recycleUnitFromPlayToDeck,
  returnCardFromTrash,
  nameSpellOn,
  setBaseMightThisTurn,
  spendBuff,
  spendXp,
  stunUnits,
  withSimultaneousDeaths,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { placeGoldTokens, placeRecruitToken, placeToken, type TokenDestination, type TokenSpec, BIRD_TOKEN, SAND_SOLDIER_TOKEN } from "../token.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { parkDecision, repeatDecision, type DecisionOption } from "../decisions.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import { banishFromHandUntilHold } from "../delayed-triggers.js";
import { playUnitToBase } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { isAttackingAt, isStillHere } from "../combat-designation.js";
import { hasKeyword, isMighty, otherOwnUnitsHere } from "../granted-keywords.js";
import { effectiveMight } from "../effective-might.js";
import type { UnitInstance } from "../../model/card.js";
import type { GameState, PendingDecision, PlayerState } from "../../model/game-state.js";
import { attachEquipment, effectiveTagsOf, wearerListener } from "../equipment.js";
import { mayPlayUnitAt } from "../battlefield-continuous.js";
// From the LEAF constants module, not from `activated-abilities.js` where the
// ability lives: that import closed a cycle through token.js and registered the
// Gold token's ability under the key "undefined". See the constant's own note.
import { VANGUARD_ARMORY_TOKENS } from "../constants.js";

/** Which of Vanguard Armory's three this question is about — counted UP from the
 *  remaining count, because "Recruit 1 of 3" is what a player is looking at and
 *  "2 left" is not. */
function vanguardTokenOrdinal(d: { count?: number }): string {
  const remaining = d.count ?? 1;
  return `${VANGUARD_ARMORY_TOKENS - remaining + 1} of ${VANGUARD_ARMORY_TOKENS}`;
}

/* Shurima's Sand Soldier now comes from `token.ts`, which already exported it.
 *
 * This file carried a THIRD private copy — after the two `SAND_SOLDIER_TOKEN`'s
 * own comment records being consolidated — and nobody noticed until a test
 * written for the Bird's triplication swept for the pattern and named this on its
 * first run. The local copy was byte-identical, so nothing was ever observably
 * wrong; it was simply one more place for the Might to drift. */

/**
 * Unleashed's Bird — "a 1 [Might] Bird unit token with [Deflect]", made by
 * Carrion Dredger's `[Deathknell]` and by Ultrasoft Poro's exhaust ability.
 *
 * A spec shared between the two rather than written twice, the same call
 * `SAND_SOLDIER_TOKEN` and `MECH_TOKEN` record: a stat line copied into two
 * entries is two places for the Might or the keyword to drift, and a Bird minted
 * without `Deflect` would be indistinguishable in play from one whose surcharge
 * simply was not charged.
 *
 * **It is LOCAL and it OWES A MOVE to `token.ts`.** Six printed cards make this
 * token and they are spread across four domains — UNL-044 Flurry of Feathers and
 * UNL-054 Frisky Hunter (Calm), UNL-088 Gutter Palace (Mind), UNL-130 Walking
 * Roost (Chaos), these two (Order) — plus the UNL-217 Trapping Grounds
 * battlefield. So the stat line will exist as a private copy in several domain
 * files until it is consolidated, which is precisely the drift
 * `SAND_SOLDIER_TOKEN`'s own note in `token.ts` records having already happened
 * once. It is here only because this change owns one file; `token.ts` is shared.
 *
 * No `entersReady`: 143.4.a's default stands and neither card overrides it.
 *
 * `[Deflect]` is a real keyword here (`deflectSurchargeForTargets` reads
 * `effectiveKeywords`, which reads a unit's own `keywords` map whether it came
 * from a printed card or from `createToken`), so the tokens genuinely tax the
 * opponent — pinned by a test, because a keyword that parses and is read by
 * nothing is exactly how `[Deflect]` shipped inert the first time.
 */

/** Ultrasoft Poro makes TWO of them; Carrion Dredger one. */
const ULTRASOFT_PORO_BIRDS = 2;
/** Heroic Charge's pump, beside the stun it is joined to. */
const HEROIC_CHARGE_MIGHT = 1;
/** Divining Shells' pump. */
const DIVINING_SHELLS_MIGHT = 2;
/** Shepherd's Heirloom gains this on play and spends it to attach. */
const HEIRLOOM_XP = 1;
/** Enthralling Protector's buff price. */
const ENTHRALLING_PROTECTOR_XP = 2;
/** Shadow's Call pays two cards for the unit it dooms. */
const SHADOWS_CALL_DRAW = 2;
/** Undying Loyalty's ceiling — "no more than [2] and no more than [rainbow]".
 *  The Power pip is unnumbered, which this pool's convention reads as 1 (Energy
 *  prints as a NUMBERED glyph, Power as COUNTED PIPS — see Defy in
 *  docs/rules-calls-resolved.md), the same reading `GLASC_MAX_POWER` records. */
const LOYALTY_MAX_ENERGY = 2;
const LOYALTY_MAX_POWER = 1;
/** LeBlanc - Fragmented's `[Deathknell]` draws this many, or twice as many in
 *  her controller's Beginning Phase. */
const LEBLANC_DRAW = 1;

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
const BONDS_OF_STRENGTH_MIGHT = 1;

/** Dragon Form's assignment — "its base Might BECOMES 5 this turn". */
const DRAGON_FORM_MIGHT = 5;
/** Ki Barrier's pool — "prevent the next 7 damage". */
const KI_BARRIER_PREVENTION = 7;
/** Lacerate's ceiling — "kill it if it has 3 [Might] or less". */
const LACERATE_MAX_MIGHT = 3;
/** Reluctant Leader's pump per OTHER unit played. */
const RELUCTANT_LEADER_MIGHT = 2;
/** Hungry Wolf's pump, and the one enemy choice that unlocks him. */
const HUNGRY_WOLF_MIGHT = 1;
const HUNGRY_WOLF_CHOICES_NEEDED = 1;
/** Kennen's toll, his stun bonus, and the question his "you may pay" parks. */
/** Fallen Feline (VEN-132) and her one question. */
const FALLEN_FELINE = "VEN-132";
const FALLEN_FELINE_NAME = "VEN-132-name";

/**
 * Every distinct SPELL name in the pool, sorted — what Fallen Feline's naming
 * offers, and rule 762's "a card that is legal in the Format being played".
 *
 * **Memoised, and that is not a micro-optimisation.** `options()` is called by
 * `legal-actions` on every enumeration and by `advanceDecisions` on every parked
 * question, so an un-memoised walk of the registry would run this on states that
 * have no Feline anywhere near them. The registry is immutable for a process's
 * life, which is what makes one computation safe — the same reasoning the trigger
 * registries' lazy `composed ??=` uses.
 *
 * Distinct by NAME (132.1), so two printings that share one collapse to a single
 * option — naming a card bans every printing of it, because they are one card.
 * **Against TODAY'S pool that `new Set` is a no-op**: all 233 spell defs have
 * distinct names and none of the 53 aliased printings is a spell. It is stated
 * rather than measured, and no mutant can kill it — the test asserts the
 * invariant (the offer has no duplicates) instead, which is the shape this repo
 * uses whenever the "it does something" half cannot be reached.
 *
 * Sorted, because 233 options in registry order is unreadable to a human and the
 * AI is indifferent. Sorting also makes the offer STABLE, which is what lets a
 * test assert a position in it.
 */
let spellNames: string[] | null = null;
function allSpellNames(): string[] {
  spellNames ??= [
    ...new Set(defaultCardRegistry().all().filter((def) => def.type === "Spell").map((def) => def.name)),
  ].sort();
  return spellNames;
}

const KENNEN = "VEN-135";
const KENNEN_STUN_ENERGY = 2;
const KENNEN_MIGHT = 2;
const KENNEN_STUN = "VEN-135-stun";
/** Shen's hold clause and Vendetta's Order motif — "exactly ONE other unit you
 *  control here". The same number `granted-keywords.otherOwnUnitsHere` is
 *  compared against by Disciple of Shen and Sacred Protector; kept as this file's
 *  own constant because it is Shen's printed number, not a shared rule. */
const SHEN_ALLIES = 1;
const SHEN_POINTS = 1;

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-116": {
    // Dragon Form — "Choose a unit. Its BASE Might becomes 5 this turn.
    // [Flow] [3 Energy]."
    //
    // # A LEVELLER, and the LAYER is what makes it one
    //
    // 477.1.a.1 puts "assignment of Might" in layer 1 (Trait-Altering) and quotes
    // this card's sentence as its worked example — "A spell reads 'A unit's Might
    // becomes 4 this turn.' The unit's Might is set to 4 in this layer" — while
    // 477.3 puts arithmetic third. So the printed Might is REPLACED and every
    // other source still adds on top of the 5: a buff, an aura, a this-turn pump
    // and [Assault] all survive.
    //
    // That ordering is the card. Written as a delta it would be a pump on a small
    // unit and nothing on a big one; written as a floor it could never shrink
    // anything. It is neither — a 1-Might token becomes a 5 and a 7-Might
    // champion becomes a 5, which is why it is removal as often as a pump.
    //
    // `UnitInstance.baseMightThisTurn` is the field, and `effectiveMight` reads it
    // with `??` rather than `||` because **0 is a legal assignment**. Swept by
    // runEnd, DELETED rather than zeroed, for the same reason.
    //
    // "A unit", bare, so `scope: "anywhere"` — 355.9.a.1's widening. Setting an
    // ENEMY unit to 5 is a legal play and often the point of the card.
    //
    // [Flow] needs nothing here: 829.1.c.1's alternative cost is plumbed
    // generically, and a card effect is reached identically whichever cost paid
    // for it.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? setBaseMightThisTurn(state, event.targetUnitInstanceId, DRAGON_FORM_MIGHT)
        : state,
  },
  "VEN-126": {
    // Ki Barrier — "[Reaction] Choose a unit. Prevent the next 7 damage that
    // would be dealt to it this turn."
    //
    // # A POOL, not a shield, and the difference is the whole card
    //
    // Counter Strike prevents the next INSTANCE of any size and is spent; this
    // absorbs an AMOUNT across as many instances as it takes, and a 9-damage hit
    // against a full barrier still puts 2 through. The card's own reminder text
    // says so — "opponents can assign it extra combat damage to kill it" — which
    // is what makes 7 a number rather than a word.
    //
    // So it needed real state: `GameState.damagePreventionPoolByInstanceId`, the
    // remaining amount keyed by unit, spent inside `dealDamage` after the damage
    // modifiers and before the lethal test. 369.1 makes this a replacement on the
    // damage that WOULD be dealt, so it acts on what actually arrives — Annie -
    // Fiery's +1 is part of what the barrier eats, and a Lotus Trap doubling is
    // doubled before the barrier sees it.
    //
    // **A fully absorbed hit is damage that was NOT dealt**, which is why
    // `dealDamage` also gates Noxian Guillotine's and Imperial Decree's delayed
    // kills on something getting through. Without that, a 7-point barrier would
    // turn a death sentence into an execution it was bought to stop.
    //
    // **[Reaction] needs nothing here** — timing is `timing.timingTierOf` reading
    // `isReaction` off the card, and that is what lets this be cast into a combat
    // damage step, the only window it is worth anything in.
    //
    // "A unit", bare, so `scope: "anywhere"` (355.9.a.1). Barriering an ENEMY unit
    // is legal and pointless, and the card offers it.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? addDamagePreventionPool(state, event.targetUnitInstanceId, KI_BARRIER_PREVENTION)
        : state,
  },
  "VEN-127": {
    // Lacerate — "Choose a unit. If it's [Empowered], disempower it. Then kill it
    // if it has 3 [Might] or less. [Flow] [4 Energy][Order][Order]."
    //
    // # The ORDER of the two instructions is the card
    //
    // "Then" is sequential, and it has to be: an [Empowered] unit is carrying its
    // `empoweredGrant` — a Might bonus, keywords, or both — so disempowering
    // FIRST is what can drop it to 3 or less and make the kill land. A card that
    // measured Might before the disempower would fail against exactly the units
    // it is printed to answer.
    //
    // `disempowerPermanent` is the single writer of the status (441.1.a's binary
    // state) and no-ops on a unit that was never Empowered — so the "if it's
    // Empowered" guard is that helper's, not a branch here.
    //
    // "3 [Might] OR LESS" reads EFFECTIVE Might, not printed: an aura, a buff and
    // a this-turn pump all count, the reading every other Might threshold in this
    // pool takes. Non-combat context, so [Assault]/[Shield] do NOT — a defender's
    // Shield must not save it from a spell cast outside a damage step.
    //
    // **Re-read AFTER the disempower**, off the post-disempower state. Reading it
    // once at the top would measure the unit this card exists to strip.
    //
    // Killed through `destroyUnit` rather than by damage: "kill it" is a Kill
    // Instruction, so [Deathknell]s fire and nothing about the unit's damage track
    // enters into it.
    //
    // "A unit", bare — `scope: "anywhere"` (355.9.a.1), and a friendly target is a
    // legal if unusual play.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const disempowered = disempowerPermanent(state, targetId);
      // 359.3.e.12 — a check on something no longer available returns null.
      const found = findUnitAnywhere(disempowered, targetId);
      if (!found) return disempowered;
      const where =
        found.zone === "base"
          ? { isCombat: false as const }
          : { isCombat: false as const, battlefieldId: disempowered.battlefields[found.zone.battlefieldIndex]!.id };
      const might = effectiveMight(disempowered, found.unit, found.ownerIndex, where);
      return might <= LACERATE_MAX_MIGHT ? destroyUnit(disempowered, targetId, ctx.casterIndex) : disempowered;
    },
  },
  "VEN-131": {
    // Decree of Unity — "Kill an enemy Chaos ([Chaos]) unit or gear."
    //
    // **Two narrowings on the OFFER, not checks in the resolver**, and for a Spell
    // that is not a style choice: the targeting IS the effect, so a board with no
    // enemy Chaos permanent must make this card UNCASTABLE rather than
    // castable-and-inert. A resolver that refused would leave it spent.
    //
    // Both ride the shared `unitOrGearTargets` walk, which the enumerator and the
    // validator BOTH go through — the enumerate/execute split that has produced
    // five crashes here, every one found by a probe rather than a test. Neither
    // call site passed the spec's narrowings before this card; both do now.
    //
    // **"A CHAOS unit" means Chaos AMONG its domains**, so a Fury+Chaos unit is a
    // legal target. That is what a domain reads like everywhere else in the game,
    // and the alternative (sole-domain only) would exclude most of the set's
    // dual-domain cards.
    //
    // A TOKEN carries `domains: []` and is therefore never a Chaos unit — read off
    // the instance rather than the registry, which could not answer for a
    // `TOKEN-` defId at all.
    //
    // Killed through the kind-appropriate funnel: `killGear` for a gear so its own
    // "when I am killed" self-trigger fires (Treasure Trove, Scrapheap), and
    // `destroyUnit` for a unit so its [Deathknell] does. One `unitOrGear` target
    // and two kill paths is the shape Fading Memories already has.
    targeting: { kind: "unitOrGear", owner: "enemy", domain: "Chaos" },
    resolve: (state, ctx, event) => {
      const id = event.targetPermanentInstanceId;
      if (!id) return state;
      for (const ownerIndex of [0, 1] as const) {
        const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === id);
        if (gear) return killGear(state, gear, ownerIndex);
      }
      return destroyUnit(state, id, ctx.casterIndex);
    },
  },
  "SFD-151": {
    // Bonds of Strength — "[Reaction] [Repeat] [2] Give two friendly units each
    // +1 Might this turn."
    //
    // `min: 2` because the card says "two", not "up to two" — a play naming one
    // unit is not a legal announcement, and the enumerator will not offer this
    // card at all with fewer than two friendly units on the board. That is the
    // difference between this and the `min: 0` slot cards a few entries down,
    // and it is printed.
    //
    // `scope: "anywhere"`: "two friendly units" names no battlefield, so 355.9.a.1
    // reaches base.
    //
    // "EACH +1", so the same amount goes to both — one instruction applied per
    // chosen unit, which is what `chosenTargets`-style iteration is for. Repeating
    // it may name a DIFFERENT pair (820.1.d), so a repeat can spread +1 across
    // four units or stack +2 on the same two; both are legal and the choice is
    // the caster's.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      [event.targetUnitInstanceId, event.secondTargetUnitInstanceId]
        .filter((id): id is string => id !== undefined)
        .reduce((next, id) => giveMightThisTurn(next, id, BONDS_OF_STRENGTH_MIGHT), state),
  },
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
    // "anywhere" with no owner restriction, the reading 355.9.a.1 gives the bare
    // noun and the one Primal Strength and Discipline already take. Pumping an
    // enemy unit is a bad play, not an illegal one.
    //
    // giveMightThisTurn rather than a Buff — "this turn" expires in the
    // Expiration Step (317) instead of persisting (705). That matters doubly on
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
              // count — 055's do-as-much-as-you-can, and a question with nothing
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
    // fires [Deathknell] (808) and honours a death ward (808.1.d.1).
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
    // characteristics rather than chosen, which rule 355.10.d makes the
    // difference between targeting and merely affecting ("Kill all units at
    // battlefields doesn't target anything"). So there is no choice for
    // legal-actions.ts to fan out and nothing an enemy "can't be chosen"
    // effect could dodge.
    //
    // giveMightThisTurnToAllFriendlies, NOT buffing: this expires in the
    // Expiration Step (rule 317) via turn-manager.ts's runEnd zeroing every
    // unit's mightThisTurn, whereas a Buff (rule 705) persists, caps at one per
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
  "UNL-173": {
    // Sacrifice — "[Reaction] As an additional cost to play this, kill a
    // friendly [Mighty] unit. Draw 2 and channel 1 rune exhausted."
    //
    // Placed beside Salvage because it is a SPELL; Cruel Patron (OGN-208, in the
    // unit-triggers table below) has the same cost shape and pays it the same
    // way: on `additionalCostUnitInstanceId`, through `destroyUnit`
    // so [Deathknell] still fires (808) and a death ward can still replace it
    // (808.1.d.1), and with no `killerIndex` — paying a cost with your own unit
    // is not you "killing" it in the sense Solari Shrine asks about.
    //
    // # What was new, and why the card was refused twice
    //
    // "A friendly **[Mighty]** unit" is the first additional cost in the pool
    // that names a SUBSET of your units rather than all of them. `UnitCostSpec`
    // could say how a unit is spent (killed, exhausted, buff-stripped) but not
    // which units qualify, so there was no way to write this without either a
    // fourth `kind` per adjective or a filter that existed on only one side of
    // the enumerate/execute split. It now carries a `candidate` predicate,
    // applied in `legal-actions` AND `validate-play-card`; see card-effects.ts.
    //
    // The predicate is `isMighty`, not `might >= 5`. 708 defines Mighty on
    // CURRENT Might, so a unit standing in a +Might aura qualifies where it
    // stands and stops qualifying when it moves — which falls out of asking the
    // one function that answers this, and would not fall out of reading the
    // printed number.
    //
    // MANDATORY, so there is no decline: Sacrifice with nothing of yours at 5+
    // Might is not offered at all, and the two cards are never drawn for free.
    //
    // # The cost is paid HERE, at resolution, which is a divergence
    //
    // 204 has costs paid as the card is played, and this is a Spell — so between
    // playing and resolving, an opponent could in principle respond to a
    // Sacrifice whose price has not yet been paid. Every unit-valued additional
    // cost in the pool is paid this way (Cruel Patron, Call to Glory, Wallop,
    // Wildclaw Shaman, Kraken Hunter, Commander Ledros), and moving one card out
    // of step with the other six would be worse than the shared gap. Recorded in
    // docs/rules-conformance.md against all seven rather than this one.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const paid = event.additionalCostUnitInstanceId
        ? destroyUnit(state, event.additionalCostUnitInstanceId)
        : state;
      // "Draw 2 AND channel 1 rune exhausted" — one sentence, both halves
      // unconditional, and the channel is EXHAUSTED so it pays for nothing this
      // turn. Same helper Startipped Peak uses, so a player whose rune deck is
      // short channels as many as remain (315.3.b.1) rather than throwing.
      return channelRunesExhausted(drawCards(paid, ctx.casterIndex, 2), ctx.casterIndex, 1);
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
    // sheltering in either base is out of reach (355.9.a.1).
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
      // Consequence, stated: a victim saved by a death ward (808.1.d.1) still
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
    // (355.9.a.1).
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
      // (808.1.d.1), so the unit is still in play and the pump must not happen.
      // Asking the board is what distinguishes the two; a `killed !== state`
      // comparison would not, since a replacement changes the state too.
      if (findUnitAnywhere(killed, victimId)) return draw(killed);
      return draw(beneficiaryId ? giveMightThisTurn(killed, beneficiaryId, might) : killed);
    },
  },
  "SFD-166": {
    // Rally the Troops, SECOND clause only — "[Action] ... Draw 1."
    //
    // **The first clause is a DELAYED TRIGGER**: "When a friendly unit is played
    // this turn, buff it" is a DELAYED trigger armed by a spell, and this engine
    // has no general mechanism for one. Both existing delayed effects carry a
    // FIELD on the state that the firing site reads — Imperial Decree (OGN-221,
    // above) sets `killDamagedUnitsThisTurn` and `dealDamage` reads it; Targon's
    // Peak sets `readyRunesAtEndOfTurn` and `runEnd` reads it. Here the firing
    // site is a unit entering play, which only the shared play path sees, so the
    // clause needed a `PlayerState` flag plus a read in the play path — which is
    // exactly what it now has: `buffUnitsPlayedThisTurn`, armed here and read by
    // `deploy.ts` where a unit lands. A COUNT rather than a boolean, because two
    // Rallies in a turn are two instructions to buff.
    //
    // The event route is closed too, and not by preference: `cardPlayed` is a
    // held event, but a Spell that has resolved is in a TRASH, and
    // `listeningTrashCards` is a named two-card set in triggers.ts — a shared
    // file. No per-domain registration can reach the moment.
    //
    // The draw is its own instruction on its own line, unconditional on the
    // clause above it (135.2.b) — a Rally cast on a turn where no unit is ever
    // played still draws.
    //
    // [Action] is the default play timing (own turn or a showdown) and is
    // enforced by engine/timing.ts, not here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...players[ctx.casterIndex],
        buffUnitsPlayedThisTurn: players[ctx.casterIndex].buffUnitsPlayedThisTurn + 1,
      };
      return drawCards({ ...state, players }, ctx.casterIndex, 1);
    },
  },
  "UNL-180": {
    // The Ruination — "Kill all units." Nine Energy and three Power for every
    // body on the table, both sides, and it is the whole card.
    //
    // `targeting: none`, and that is 355.10.d rather than a shortcut: the units are
    // "programmatically selected based on their characteristics rather than
    // chosen", whose worked example in the PDF is literally "Kill all units at
    // battlefields doesn't target anything". So there is nothing for
    // legal-actions.ts to fan out and nothing a "can't be chosen" effect dodges.
    //
    // **BASE UNITS TOO.** No location is named, and 355.10.a.1 says "'Unit,'
    // 'gear,' and 'rune' refer to objects on the Board unless specified
    // otherwise" — a Base is on the Board (rule 197's Locations, and 90's
    // "Permanents and Runes in Bases are Public Information"). This is what
    // separates this card from the rules' own "kill all units AT BATTLEFIELDS"
    // example, and it is the reason the sweep is `ownUnitsEverywhere` on both
    // players rather than a walk of `state.battlefields`.
    //
    // The ids are snapshotted BEFORE the first kill and then reduced over, the
    // same shape `dealDamageToAllUnitsAtAllBattlefields` takes: each
    // `destroyUnit` rebuilds the board, so a captured unit object would go stale,
    // and `destroyUnit` no-ops on an id that is already gone.
    //
    // Every death is credited to the caster — including their own units, which
    // "all units" plainly reaches. Each fires its own [Deathknell] and each is
    // seen by every death-watch; all of them are HELD (383) rather than resolving
    // inside this loop, so the board this loop walks never shifts underneath it.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const doomed = ([0, 1] as const).flatMap((owner) => ownUnitsEverywhere(state, owner).map((u) => u.instanceId));
      return withSimultaneousDeaths(state, (inBatch) =>
        doomed.reduce((next, instanceId) => destroyUnit(next, instanceId, ctx.casterIndex), inBatch),
      );
    },
  },
  "UNL-159": {
    // Soul Harvest — "Kill a unit at a battlefield with 3 [Might] or less."
    //
    // Sandshifter's spec (SFD-158) minus the `owner`: this card names no side, so
    // it will happily eat one of your own — a bad play, not an illegal one.
    //
    // `scope: "battlefield"` is written out rather than left to the default,
    // because it is PRINTED and it is the difference between this card and
    // Vengeance ("kill a unit", scope "anywhere"): a small unit sheltering in
    // either base is out of reach (355.9.b, and the PDF's own "at a battlefield
    // is a restriction" example).
    //
    // `maxMight` is EFFECTIVE Might — `unitWithinMaxMight`'s reading, shared with
    // Blood Money and Sandshifter — so a 3-Might unit standing under Garen -
    // Commander's "+1 here" is a 4 and is not offered. Enforced by the enumerator
    // and the validator rather than here: a resolver check would come after the
    // spell was paid for.
    targeting: { kind: "unit", maxMight: 3, scope: "battlefield" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "UNL-155": {
    // Heroic Charge — "[Action] Give a friendly unit +1 [Might] this turn and
    // [Stun] an enemy unit at its location."
    //
    // Facebreaker's spec (OGN-220) exactly, and for the same three reasons: the
    // two halves are ONE instruction joined by "and", so `min: 2` makes the card
    // uncastable without a friendly and an enemy standing together; the relation
    // between the targets lives on the SPEC, where the enumerator and the
    // validator both enforce it, rather than in this resolver, which runs after
    // the spell is paid for; and the default `scope` is right because "at its
    // location" can only ever be a battlefield — no enemy unit is ever in your
    // base, so a friendly at home has no legal partner.
    //
    // **`sameBattlefield` is the printed "at its location", not an approximation
    // of it.** The rules' Special Terms give Location as a Base or a Battlefield
    // Zone, so the two readings differ only in the base case, which is
    // unreachable here for the reason above.
    //
    // ONE `stunUnits` call for the one enemy, matching Facebreaker's note: the
    // batch event (`unitsStunned`) is per INSTRUCTION, so Leona - Radiant Dawn
    // pays out once.
    //
    // Slot order is the printed order — friendly first, enemy second — and
    // `asymmetricSlots` is NOT needed, because the two slots take DIFFERENT
    // roles and legal-actions only prunes the mirrored pairing when both slots
    // share a role.
    //
    // [Action] is timing (engine/timing.ts), not this card's business.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, sameBattlefield: true },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: friendly, secondTargetUnitInstanceId: enemy } = event;
      // Each half independently guarded rather than bailing on the pair: the
      // spell is announced with both chosen, but either can leave play while it
      // sits on the chain, and 055's "do as much as you can" applies to what is
      // left. `giveMightThisTurn` and `stunUnits` both no-op on a vanished id.
      const pumped = friendly ? giveMightThisTurn(state, friendly, HEROIC_CHARGE_MIGHT) : state;
      return enemy ? stunUnits(pumped, ctx.casterIndex, [enemy]) : pumped;
    },
  },
  "UNL-165": {
    // Shadow's Call — "Choose a friendly unit WITHOUT [Temporary]. Give it
    // [Temporary]. Draw 2."
    //
    // Two cards for two Energy, paid for at the top of your next turn with a
    // body: 816.1.b makes `[Temporary]` "at the start of this permanent's
    // controller's Beginning Phase, kill this", and 816.1.c fixes the moment as
    // that Beginning Phase starting — which `turn-manager.killTemporaryPermanents`
    // runs BEFORE holds score, so the doomed unit cannot even pay for itself with
    // a point on the way out.
    //
    // `grantTemporary` writes the keyword onto the instance's own `keywords` map,
    // which is exactly what that kill step reads. A `giveKeywordThisTurn` grant
    // would have been silently inert twice over: `keywordsThisTurn` is not what
    // the step reads, and `runEnd` clears it before the Beginning Phase it is
    // supposed to survive to.
    //
    // "A friendly unit", no battlefield named, so `scope: "anywhere"` on
    // 355.9.a.1's bare noun — a unit sitting at home is as good a sacrifice as one
    // in the fight, and rather a better one.
    //
    // # DIVERGENCE: "without [Temporary]" is enforced at RESOLUTION, not announce
    //
    // 355.9.b — "It meets all targeting restrictions" — makes the printed
    // "without [Temporary]" a TARGETING restriction, so 355.8 ("in order to put a
    // spell or ability on the chain, valid choices must be made for all targets")
    // and 355.16 together mean an already-Temporary unit can never be named. No
    // `TargetingSpec` here can say that: the union carries `maxMight`,
    // `exhaustedOnly` and `attackingOnly`, but nothing about a keyword the target
    // must LACK, and adding one is an edit to card-effects.ts, legal-actions.ts,
    // validate-play-card.ts and target-lookup.ts — four shared files.
    //
    // So the check lands here, and it REFUSES THE WHOLE SPELL — the draw included.
    // That is deliberately NOT 359.3.e.5's shape, whose Void Seeker example keeps
    // the draw when a target has become illegal on the chain: this target was
    // never legal, a state the rules do not reach, so there is no printed
    // behaviour to be faithful to. What there IS is a direction, and it is the one
    // this codebase does not ship — naming an already-doomed Sprite token would
    // otherwise turn a 2-Energy "Draw 2 and lose a unit" into a 2-Energy "Draw 2",
    // and UNL prints six cards that make [Temporary] Sprites. Refusing outright is
    // never stronger than printed; obeying 359.3.e.5 here would be.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const location = findUnitAnywhere(state, event.targetUnitInstanceId);
      // 359.3.e.5's genuine case: the unit left play while this sat on the chain.
      // The instruction related to it is ignored — and the draw, a separate
      // instruction, still happens.
      if (!location) return drawCards(state, ctx.casterIndex, SHADOWS_CALL_DRAW);
      // Through `hasKeyword` rather than `"Temporary" in unit.keywords`, so a
      // granted instance counts exactly as a printed one does (816.3 makes having
      // Temporary a characteristic that "may be checked"). Nothing in this pool
      // grants it by aura, so the two readings agree today; the shared reader is
      // what keeps them agreeing.
      if (hasKeyword(state, location.unit, location.ownerIndex, "Temporary")) return state;
      return drawCards(grantTemporary(state, event.targetUnitInstanceId), ctx.casterIndex, SHADOWS_CALL_DRAW);
    },
  },
  "UNL-168": {
    // Undying Loyalty, SECOND clause only — "Play a unit with cost no more than
    // [2] and no more than [rainbow] from your trash, ignoring its cost."
    //
    // **The first clause is REFUSED**: "This costs [2] less if you CHOOSE a Bird,
    // Cat, Dog, or Poro" is a discount whose size depends on the card named, so it
    // has to be priced per enumerated variant at ANNOUNCE — `legal-actions` prices
    // `ignoresCostWhenPaid` that way already — and the tables that drive it
    // (`OPTIONAL_UNIT_COSTS`, `optionalPowerCostOf`) live in card-effects.ts with
    // their readers in legal-actions.ts and validate-play-card.ts. None of those
    // is this file's to edit. The card therefore always costs its printed [2] and
    // one rainbow: WEAKER than printed, which is the safe direction, and it is
    // the whole of what is missing.
    //
    // The ceiling is Spectral Matron's read exactly — "no more than [2]" is
    // Energy, "no more than [rainbow]" bounds the SIZE of the Power cost and not
    // its colour (a rainbow pip is any domain), and both are read off the PRINTED
    // cost, which is what a "costing no more than" filter asks: the rules' Defy
    // example says such an effect "always uses its printed or copied cost".
    //
    // A parked QUESTION rather than an `ownTrashCard` target, and here that is
    // forced rather than preferred: `{ kind: "ownTrashCard" }` carries a
    // `cardKind` and nothing else, so it would offer every unit in the trash
    // regardless of cost — a 10-Energy Atakhan played free, which is very much
    // stronger than printed. The option list below is this file's own, so the
    // ceiling is enforced exactly. The cost is the recorded family divergence
    // Starhound's entry already carries: 355.9.a.4 makes a card in a Public trash
    // a target, chosen as the spell is announced, and Spectral Matron, Glasc
    // Mixologist and Flame Chompers all choose a response window later.
    //
    // No decline: the card prints "Play a unit", not "you may".
    //
    // **Moved from a parked DECISION to an announce-time TARGET on 2026-08-12**,
    // which is what unblocked the first clause. The discount is "[2] less if you
    // CHOOSE a Bird, Cat, Dog, or Poro", and a cost has to be known when the card
    // is paid for — so as long as the unit was named at resolution the discount
    // could not exist at all.
    //
    // 355.4 puts a spell's choices at finalization and 355.9.a.4 makes a card in
    // a Public trash a legal target, so this is also the rules-correct timing;
    // the parked question was the recorded divergence, not the fix.
    //
    // **The Harrowing (OGN-198) deliberately did NOT move with it.** It looks
    // like the same card and is not: it plays the trash unit "paying only its
    // Power cost", and that payment happens at resolution out of the pool as it
    // then stands — it cannot ride the PlayCardAction that already paid this
    // spell's own cost. Undying Loyalty plays "IGNORING ITS COST", both halves,
    // so its payment is empty and there is nothing to defer. That difference is
    // the whole reason one could move and the other could not.
    //
    // Spectral Matron (OGN-226) is a THIRD case and neither argument reaches
    // her: she also ignores the whole cost, but she is a Unit, so her choice
    // belongs to a triggered ability on the chain rather than to a spell being
    // finalized. Pinned in test/undying-loyalty.test.ts, where the first draft of
    // this very note was wrong about her.
    targeting: { kind: "ownTrashCard", cardKind: "Unit", maxEnergy: LOYALTY_MAX_ENERGY, maxPower: LOYALTY_MAX_POWER },
    resolve: (state, ctx, event) => {
      // Re-derived against the live trash rather than trusted from the action:
      // the card is named at announce and resolves after a response window, so
      // the unit can be gone by now (banished, or played by something else).
      const chosen = loyaltyCandidates(state, ctx.casterIndex).find(
        (c) => c.instanceId === event.trashCardInstanceId,
      );
      if (chosen === undefined) return state;
      // Out of the trash BEFORE it is played, or the card would be in two zones
      // at once. `cardsPlayedThisTurn` still moves, because this is a play and
      // [Legion] counts plays rather than payments.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...players[ctx.casterIndex],
        trash: players[ctx.casterIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
        cardsPlayedThisTurn: players[ctx.casterIndex].cardsPlayedThisTurn + 1,
      };
      // Through the shared free-play funnel, so it enters exhausted (143.4.a)
      // unless something on the board says otherwise, both events a real play
      // fires go off, and the caster is asked WHERE it lands.
      return playUnitFree({ ...state, players }, ctx.casterIndex, chosen);
    },
  },
  "UNL-175": {
    // Tactical Retreat — "[Reaction] Choose a friendly unit. The next time it
    // would die this turn, heal it, exhaust it, and recall it instead."
    //
    // **Highlander's sentence, word for word** (OGS-020, in card-effects.ts), and
    // so it is Highlander's implementation: one id appended to
    // `deathWardedUnitInstanceIds`, which `killUnit` consults at every point a
    // unit would actually die. Writing a second ward mechanism for the same
    // printed words is the drift this file keeps a single `PET_TAGS` to avoid —
    // the three words "heal it, exhaust it, and recall it" are shared by five
    // cards now and `reviveToBase` is the one place they are spelled out.
    //
    // `[Reaction]` is a printed keyword read by `timing.timingTierOf` off
    // `SpellInstance.isReaction`; nothing about it belongs here. The reminder
    // "(Send it to base. This isn't a move.)" is 454's Recall and is likewise
    // already what `reviveToBase` does — it appends to `baseUnits` directly, so
    // no vacancy or Contested check fires and no `unitMoved` event is raised.
    //
    // "A friendly unit" names no battlefield, so `scope: "anywhere"` on
    // 355.9.a.1's bare noun — Highlander's entry records the same widening, and
    // for the same reason: `dealDamage` and `destroyUnit` both reach base now, so
    // warding a unit at home is a real play rather than a wasted one.
    //
    // # Inherited limitation, stated rather than papered over
    //
    // Two Retreats (or a Retreat and a Highlander) on the SAME unit are one ward,
    // not two: `reviveWithDeathWard` filters the id out of the list with
    // `!==`, which removes every copy. The printed reading is two independent
    // delayed effects, each replacing one death. Deduping on the way in would
    // change nothing — one entry and two-removed-together behave identically —
    // so this is not a guard that was forgotten, it is a property of the list
    // shape, and it is Highlander's already.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : { ...state, deathWardedUnitInstanceIds: [...state.deathWardedUnitInstanceIds, event.targetUnitInstanceId] },
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "VEN-120": {
    // Masa, Crashing Thunder — "You may pay [Order] as an additional cost to play
    // me. When you play me, if you paid the additional cost, [Stun] an enemy unit
    // at a battlefield."
    //
    // Clockwork Keeper's optional-Power shape with a stun instead of an
    // enter-ready: the row lives in `card-effects.OPTIONAL_POWER_COSTS`, the
    // enumerator fans out a paid and an unpaid variant at two prices, and the
    // flag reaches here as `event.optionalPowerPaid`.
    //
    // Read off the ACTION, because by the time this resolves nothing on the board
    // records how he was paid for — the reason Blast Corps Cadet's entry gives,
    // and the reason the flag exists at all.
    //
    // **The target is chosen whether or not the cost was paid**, a consequence of
    // targeting being declared per card rather than per branch. A Masa played
    // cheap names an enemy and then does nothing to it — harmless, and the
    // alternative is a second spec keyed on a flag the enumerator would have to
    // read. Blast Corps Cadet records the same trade.
    //
    // "An ENEMY unit AT A BATTLEFIELD" — both narrowings printed, so `owner:
    // "enemy"` and `scope: "battlefield"` (355.9.b's narrowing, the half that
    // makes a printed location load-bearing).
    //
    // `stunUnits` is the funnel, so Gangplank, Naval's replacement (369.1) still
    // applies and a "when you stun an enemy unit" listener still sees it.
    targeting: { kind: "unit", owner: "enemy", scope: "battlefield" },
    resolve: (state, ctx, _unitId, event) =>
      event.optionalPowerPaid && event.targetUnitInstanceId
        ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId])
        : state,
  },
  [FALLEN_FELINE]: {
    // Fallen Feline — "When you play me, name a spell. While I'm at a
    // battlefield, opponents can't play spells with that name."
    //
    // Two sentences and two mechanisms: this one records the name, and
    // `board-restrictions.mayPlaySpellNamed` is the ban, read at the gate
    // `timing.mayPlayCardNow` — a continuous "opponents can't" has no resolver to
    // live in, which is what that module exists for.
    //
    // # Naming is not TARGETING
    //
    // 761 makes naming an act of identifying a card, and 762 bounds it to "a card
    // that is legal in the Format being played" — a card, not an object in play.
    // So `targeting: "none"` and the name is asked as a DECISION, which is the
    // only mechanism here that can offer something that is not on the board.
    //
    // The question is parked unconditionally. "Name a spell" is not a "you may",
    // and there is always something legal to name, so it never resolves to a bare
    // decline the way an unaffordable optional cost does (416.3).
    //
    // Parked against HER instanceId, because the answer is written onto her —
    // `UnitInstance.namedSpell`, which is where the ban reads it from and which
    // dies with her, so a Feline killed in response to this very trigger records
    // nothing and bans nothing.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(state, { kind: FALLEN_FELINE_NAME, playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  [KENNEN]: {
    // Kennen, Keeper of Balance — "[Hidden] When you play me OR I attack, you may
    // pay [2 Energy] to [Stun] a unit. While there's a stunned enemy unit here, I
    // have +2 [Might]."
    //
    // THREE clauses across three mechanisms, and this entry is the first: the
    // ON-PLAY half of a trigger whose ATTACK half is a `combatBegan` listener in
    // `eventTriggers` below, and whose Might clause is a `mightModifiers` entry.
    // One card, three tables, because they are three different things — the split
    // Master Yi's and Scorchclaw's entries already record.
    //
    // **"When you play me OR I attack" is ONE ability with two moments**, and this
    // engine has no table keyed by both: on-play lives in `unitTriggers` (keyed by
    // the arriving unit) and on-attack in the event bus (keyed by a listener
    // walk). So it is registered twice and both park the SAME question kind, which
    // is what keeps the two moments from drifting into two different offers.
    //
    // **[Hidden] needs nothing here** — 811's facedown play is the timing layer's.
    //
    // "You MAY pay" is a cost, so this parks a question rather than firing, and
    // 416.3 means it is not asked at all when the Energy cannot be paid. Asked
    // through the very helper that will spend it, so affordability and payment
    // cannot disagree.
    //
    // "[Stun] A UNIT" — bare, so either player's and anywhere (355.9.a.1). Stunning
    // your own unit is a bad play rather than an illegal one, and the card offers
    // it; his Might clause reads "a stunned ENEMY unit", which is a different
    // sentence and is filtered separately.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      payEnergyFromPool(state, ctx.casterIndex, KENNEN_STUN_ENERGY) === undefined
        ? state
        : parkDecision(state, { kind: KENNEN_STUN, playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  "UNL-169": {
    // Ashe - Focused — "When you play me, choose an opponent. They reveal their
    // hand. Choose a card revealed this way and banish it. When they hold, return
    // it to their hand (even if I'm no longer on the board)."
    //
    // **Refused in waves 3, 6 and 7 on three blockers.** Two of them dissolved on
    // re-measurement and one was real but pointed at the wrong fix:
    //
    //   1. "no general mechanism for a delayed trigger armed by a resolved
    //      ability" — TRUE, and now there is one: `engine/delayed-triggers.ts`
    //      plus `TriggerChainEntry.source === "delayed"`. It is a real Chain item
    //      with a real response window, not the inline boolean the engine's two
    //      earlier delayed effects use, because this one is an ABILITY (383.3).
    //   2. "no per-instance memory of WHICH card was banished" — TRUE, and it is
    //      `PlayerState.banishedUntilHold`, a list of ids on the CARD's OWNER.
    //   3. "even if I'm no longer on the board / she is in no listener walk" —
    //      accurate as a measurement and a dead end as a plan. Three waves went
    //      looking for a way to make a dead Ashe listen from a trash or a banish
    //      pile. She never listens: the delayed ability exists independently of
    //      her the moment this resolves, which is what the parenthetical SAYS.
    //
    // "Choose an opponent" is settled by the game being two-handed. "They reveal
    // their hand" is INFORMATION and this engine has no hidden-information model
    // for the caster, so it needs no state — the same reading Sabotage (OGN-156)
    // and Scuttle Crab already take, and recorded with them.
    //
    // The CHOICE is the caster's and the HAND is the opponent's, exactly Sabotage's
    // shape. No filter on what may be chosen: Ashe says "a card", where Sabotage
    // says "a non-unit card". An empty hand asks nothing rather than asking a fake
    // question — `advanceDecisions` drops a question with no answers.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "UNL-169-banish", playerIndex: ctx.casterIndex }),
  },
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
      withSimultaneousDeaths(state, (inBatch) =>
        (event.additionalCostUnitInstanceIds ?? []).reduce((next, id) => destroyUnit(next, id), inBatch),
      ),
  },
  "SFD-160": {
    // Zaun Punk — "You may kill a friendly gear as an additional cost to play
    // me. When you play me, if you paid the additional cost, kill a gear."
    //
    // **A cost and an effect that look identical and are not.** The first kill
    // is a COST, paid with a gear the caster names on the action (rule 355.10.c —
    // a cost is not a target), and the second is the payoff: "kill A GEAR",
    // unqualified, so it reaches EITHER side. That asymmetry is the card — you
    // trade one of yours for any one of theirs.
    //
    // The cost rides `additionalCostPermanentInstanceId`, the pool's first
    // GEAR-valued additional cost, for the reason that field exists: a gear must
    // never reach a reader expecting a unit.
    //
    // `killGear`, not a hand-rolled removal: paying a cost with a permanent is
    // still killing it, so the gear's own "when I am killed" self-trigger fires.
    // The same reading Cruel Patron's kill-as-a-cost takes below.
    //
    // The payoff half is a parked decision because "a gear" with several on the
    // board is a real choice; with none left it is dropped whole rather than
    // offered as a lone decline.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      const paidWith = event.additionalCostPermanentInstanceId;
      if (paidWith === undefined) return state; // declined — "if you do" gives nothing
      const gear = state.players[ctx.casterIndex].activeGear.find((g) => g.instanceId === paidWith);
      if (gear === undefined) return state;
      const paid = killGear(state, gear, ctx.casterIndex);
      const anyGearLeft = paid.players.some((p) => p.activeGear.length > 0);
      return anyGearLeft ? parkDecision(paid, { kind: "SFD-160-kill", playerIndex: ctx.casterIndex }) : paid;
    },
  },
  "UNL-170": {
    // Atakhan, FIRST clause — "You may kill a friendly unit as an additional cost
    // to play me."
    //
    // Only the KILL is here. The discount that kill buys — "[1] less for each
    // Energy it costs and [Order] less for each Power it costs" — is
    // `sacrificeCostDiscount` in cost-modifiers.ts, priced per enumerated variant
    // because its size depends on which unit is named.
    //
    // Byte-identical in shape to Cruel Patron below, and paid the same way:
    // through `destroyUnit`, so a [Deathknell] on the sacrifice still fires (808)
    // and a death ward can still replace it (808.1.d.1), and with no
    // `killerIndex` — spending your own unit as a price is not you "killing" it.
    //
    // **OPTIONAL, unlike Cruel Patron's and Stalking Wolf's.** He prints "you
    // MAY", so a decline variant is enumerated and he stays castable at his
    // printed 10 and 3 with nothing to sacrifice. That is also why this guards on
    // the id being present rather than asserting it: the declined variant reaches
    // this resolve with no unit named and must do nothing at all.
    //
    // His other two clauses are elsewhere and neither belongs here: `[Ganking]`
    // is a printed keyword read through `effectiveKeywords`, and "when I attack,
    // the defender must kill one of their units here" is a `combatBegan` listener
    // further down this file.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostUnitInstanceId ? destroyUnit(state, event.additionalCostUnitInstanceId) : state,
  },
  "OGN-208": {
    // Cruel Patron — "As an additional cost to play me, kill a friendly unit."
    //
    // The card has no other text: the kill IS the whole entry, and it is a COST,
    // not an effect. That distinction is why it rides on
    // `additionalCostUnitInstanceId` (rule 355.10.c — a cost is not a target) and
    // why `targeting` is "none". Enumeration offers no decline variant for it,
    // so a Cruel Patron with nothing of yours to kill is never playable.
    //
    // It is paid here, on play, rather than at resolution — a Unit's trigger
    // fires the moment it enters play, which is when a cost is due.
    //
    // destroyUnit, not a bespoke removal: paying a cost with a unit is still a
    // death, so [Deathknell] fires (808) and a death ward can replace it
    // (808.1.d.1). Being a cost does not make it a quieter kill.
    targeting: { kind: "none" },
    // No killerIndex: paying a cost with your own unit is not you "killing" it
    // in the sense Solari Shrine asks about, and naming the caster here would
    // let a card that watches for kills fire on its controller's own upkeep.
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostUnitInstanceId ? destroyUnit(state, event.additionalCostUnitInstanceId) : state,
  },
  "UNL-166": {
    // Stalking Wolf — "[Ambush] As an additional cost to play me, kill a Bird,
    // Cat, Dog, or Poro you control. You may play me to its battlefield (even if
    // you don't have other units there)."
    //
    // Only the KILL is here. The card's three clauses land in three places, and
    // that split is the card:
    //
    //   - `[Ambush]` — already worked, via `timing.ambushReactionAt`. It grants
    //     Reaction TIMING into a battlefield where you DO have units.
    //   - the destination waiver — `PLACEMENT_GRANTS["UNL-166"]` in
    //     unit-triggers.ts, which lets him land where he has NOBODY, provided it
    //     is where his meal was standing. The opposite direction to `[Ambush]`,
    //     and a different mechanism.
    //   - the cost itself — `OPTIONAL_UNIT_COSTS` names which units qualify, and
    //     this line is what actually kills the one chosen.
    //
    // Paid exactly as Cruel Patron's is: through `destroyUnit`, so a [Deathknell]
    // on the meal still fires (808) and a death ward can still replace it
    // (808.1.d.1), and with no `killerIndex` — spending your own unit as a price
    // is not you "killing" it in the sense Solari Shrine asks about.
    //
    // **Ordering note.** The Wolf is already on the board when this runs: a unit
    // deploys, then its on-play trigger resolves. So the destination was decided
    // while the meal was still standing there, which is what the placement grant
    // needs, and the kill that follows cannot invalidate it.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostUnitInstanceId ? destroyUnit(state, event.additionalCostUnitInstanceId) : state,
  },
  "OGN-234": {
    // Harnessed Dragon — "When you play me, kill an enemy unit."
    //
    // "An enemy unit" with no battlefield named, so scope "anywhere": a unit
    // sheltering in the opponent's base is a legal target (355.9.a.1).
    //
    // destroyUnit, not damage: a Kill Instruction ignores Might and marked
    // damage, and routes through the funnel that fires [Deathknell] (808) and
    // honours a death ward (808.1.d.1). The caster is the killer.
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
    // addBuff's 702.3.a no-op handles the already-buffed ones without a filter.
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
    // addBuff on its own instanceId, so 702.3.a's "not placed instead" applies — a
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
    // Scope "anywhere": "an enemy unit" names no battlefield (355.9.a.1), so one
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
    // Undertitan's FIRST clause — "When you play me, give your other units +2
    // Might this turn." His second ("As I'm revealed from your deck, [Add] [2]
    // Energy") is not an on-play trigger at all and lives in `top-of-deck.ts`
    // beside Nocturne, at the funnel every reveal in the pool goes through.
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
    // (317) instead of persisting (705), and +2 is not a thing a Buff can be.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => u.instanceId !== unitId)
        .reduce((next, u) => giveMightThisTurn(next, u.instanceId, 2), state),
  },
  "UNL-157": {
    // Scrutinizing Sergeant — "When you play me, gain 1 XP for each friendly
    // unit."
    //
    // **He counts HIMSELF**, and that is the same reading Trifarian Gloryseeker's
    // `countingSelf` records for [Legion]: an on-play trigger already has the card
    // that caused it on the board, and he prints no "other" — every unit aura in
    // this pool that excludes its own source says "other friendly units" out loud
    // (see effective-might.ts's Sett - Kingpin note for the precedent).
    //
    // Counted at RESOLUTION rather than captured when the trigger fired. The
    // trigger is held (383) and the window in between is exactly when an opponent
    // would remove one of the bodies — "for each friendly unit" is a question
    // about the board the ability resolves against, not about the moment he
    // landed. No `capture` therefore, unlike Deathgrip's Might read, whose subject
    // is about to leave play.
    //
    // `ownUnitsEverywhere`, so a unit at home counts as much as one in the fight:
    // "friendly unit" names no battlefield (355.9.a.1), and 2869 makes "friendly"
    // simply "controlled by you".
    //
    // Through `gainXp` rather than `xp + n` inline — that helper is the choke
    // point its own doc argues for, and 3065-3075 make XP a plain uncapped
    // resource, so nothing here clamps.
    targeting: { kind: "none" },
    resolve: (state, ctx) => gainXp(state, ctx.casterIndex, ownUnitsEverywhere(state, ctx.casterIndex).length),
  },
  "UNL-167": {
    // Starhound — "When you play me, return a Bird, Cat, Dog, or Poro from your
    // trash to your hand."
    //
    // A TRIBAL filter, and the first of its shape in this file: the four names are
    // `tags` on the card, which `UnitInstance` carries and which Rumble - Scrapper
    // already reads for "your Mechs". Starhound is himself a Dog, which matters
    // only for a SECOND copy — he is on the board, not in the trash, when this
    // resolves.
    //
    // **Not a "you may".** The card says "return", so the question below offers no
    // decline; what it does have is the same "ask nothing when there is nothing to
    // offer" guard Spectral Matron uses, so a Starhound played over an empty trash
    // queues no Pending Item at all rather than one whose only answer is a
    // formality. Exactly one candidate is not a choice either, and `advanceDecisions`
    // performs it without ever showing a prompt.
    //
    // Asked at resolution rather than fanned onto the play, which is where a
    // Unit's on-play choice belongs (355's Make Relevant Choices excludes "making
    // choices for Triggered Abilities of permanents"). **A recorded divergence
    // sits underneath that**: the PDF says a card in a trash IS a target, because
    // "your trash is Public", and 355's example says the target "will be chosen
    // when the ability TRIGGERS" — this engine chooses when it RESOLVES, and has
    // no targeting kind that can name a card in a trash at all. The whole
    // trash-playing family (Spectral Matron, Glasc Mixologist, Flame Chompers)
    // already sits on that same simplification.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      starhoundCandidates(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "UNL-167-return", playerIndex: ctx.casterIndex }),
  },
  "UNL-164": {
    // Safety Inspector, SECOND clause only — "When you play me, each player must
    // kill one of their units."
    //
    // **The first clause was REFUSED and is WRITTEN as of 2026-08-10.** The
    // refusal was exact about what was missing — "a field on `PlayCardAction`
    // plus pricing in legal-actions.ts and validate-play-card.ts", four shared
    // files — and that is what was built: `OPTIONAL_XP_COSTS` in card-effects.ts,
    // `optionalXpPaid` on the action, an enumerated variant, a validator check
    // that enforces the rule independently, and the spend in execute-play-card.
    //
    // 204.2 is the sentence these cards print ("as an additional cost") and
    // 204.2.a is what makes it real: "Additional Costs must be paid to finalize
    // the spell or ability". 730.2 is the spend itself.
    //
    // **Its variant is the plain play plus a flag, and nothing else** — 731 makes
    // XP not a Game Object, so unlike an optional POWER cost there is no domain
    // to price against, no `[Deflect]` tax and no discount axis. That is why this
    // one did not need the pricing fan-out its refusal reasonably expected.
    //
    // So the third sentence — "if you paid my additional cost, you don't kill a
    // unit this way" — now has a reachable true branch, and it is read below.
    //
    // Cull the Weak's shape (OGN-209) for the clause that IS here, and for its
    // reasons: nothing is fanned onto the action, because each player chooses
    // their OWN victim and the caster has no say over it — a fan-out would commit
    // the choice at play time, and the window before this resolves is exactly
    // when a unit can be added or removed. APNAP, and the queue is FIFO, so
    // parking in that order IS the ordering.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitInstanceId, event) => {
      const first = state.activePlayerIndex;
      const second = (1 - first) as 0 | 1;
      // "EACH player must kill one of their units. If you paid my additional
      // cost, YOU don't kill a unit this way." So the exemption is the
      // Inspector's controller only — never the opponent, and never both.
      //
      // Expressed by not PARKING the question rather than by parking it and
      // auto-declining: a parked decision is a real prompt the caster would have
      // to dismiss, and 383.3.a's "may" shape is not what this prints. It is a
      // flat exemption from an otherwise mandatory kill.
      const asked = event.optionalXpPaid === true ? [second] : [first, second];
      return asked.reduce((next, playerIndex) => parkDecision(next, { kind: "UNL-164-kill", playerIndex }), state);
    },
  },
  "UNL-177": {
    // Ivern - Friend to All, FIRST clause — "As you play me, choose Bird, Cat,
    // Dog, or Poro. I gain that tag."
    //
    // # A parked QUESTION, and it is a recorded timing DIVERGENCE
    //
    // "AS you play me" is a choice made during the steps of Playing a Card, which
    // this engine expresses by fanning the variants onto the `PlayCardAction` —
    // `visionRecycle`, `acceleratePaid`, `exhaustLegendPaid` are all that shape.
    // There is no field for a TAG on that action, and adding one is a change to
    // actions/player-action.ts, legal-actions.ts and validate-play-card.ts: three
    // shared files. So the choice is asked at RESOLUTION of his on-play trigger
    // instead, one chain-pop after he arrives.
    //
    // The consequence was MEASURED rather than assumed — every `.tags` reader in
    // `src/engine` was read, twelve sites. Most cannot see the window at all
    // (definition-level Mech/Dragon/Sand Soldier checks, `starhoundCandidates`'
    // and `loyaltyCandidates`' trash walks, Rumble Scrapper's), and TWO can:
    // `friendshipTagCount` and the Poro check in effects/calm.ts are board-wide
    // counts of these very four tribes, and both are on `[Reaction]` cards that an
    // opponent — or their controller — may cast inside the window.
    //
    // It is named rather than waved away because that is the whole gap, and it
    // errs the safe way: a count taken before the answer sees one tribe FEWER, so
    // the divergence can only under-pay. Recorded in this change's report.
    //
    // # The tag is WRITTEN onto the instance, not derived
    //
    // "I GAIN that tag" is a one-shot event, not a continuous grant: nothing keeps
    // being true that could be re-derived, so there is no `effectiveTagsOf`-shaped
    // answer here. `UnitInstance.tags` is real mutable per-instance state — the
    // Mech token has no registry entry at all and its instance tags are its only
    // record, which is `equipment.ts`'s own finding after a note there claimed
    // tags were "printed-only".
    //
    // No decline and no "you may": the card says "choose", and all four options
    // always exist, so this is a real question that `advanceDecisions` never
    // auto-answers.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(state, { kind: "UNL-177-tag", playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
};

/**
 * Bird, Cat, Dog and Poro — Unleashed's four pet tribes, in the order every card
 * that names them prints them.
 *
 * Was `STARHOUND_TAGS` when one card in this file asked. THREE now do (Starhound's
 * trash return, Ivern - Friend to All's granted tag and his scoring condition),
 * and effects/calm.ts's Friendship asks a fourth time under its own copy. One
 * constant per FILE is as far as the one-file-one-owner rule lets this go; one per
 * CARD is how a list like this drifts, which is the drift `SAND_SOLDIER_TOKEN`'s
 * note in token.ts records having already happened once.
 */
const PET_TAGS: readonly string[] = ["Bird", "Cat", "Dog", "Poro"];

/**
 * The cards in a player's trash Starhound may return — "a Bird, Cat, Dog, or
 * Poro".
 *
 * `kind === "Unit"` is not a narrowing of the card's text but the whole of it:
 * only `UnitInstance` carries `tags` at all (`createCardInstance` gives a Spell
 * and a Gear none), and measured over unl.json every card bearing one of these
 * four tags is a Unit — 24 of them, alternate printings included.
 *
 * ONE walk for the fire-time "is there anything to offer" test and for the option
 * list, so the two cannot disagree — `glascCandidates`' reason exactly.
 */
function starhoundCandidates(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return state.players[playerIndex].trash.filter(
    (c): c is UnitInstance => c.kind === "Unit" && c.tags.some((t) => PET_TAGS.includes(t)),
  );
}

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
/** Glasc Mixologist's ceiling — "no more than [3] and no more than [rainbow]".
 *  The Power pip is unnumbered, which this pool's convention reads as 1 (Energy
 *  prints as a NUMBERED glyph, Power as COUNTED PIPS — see Defy in
 *  docs/rules-calls-resolved.md). */
const GLASC_MAX_ENERGY = 3;
const GLASC_MAX_POWER = 1;

/** The units in `playerIndex`'s trash that Glasc Mixologist could play. ONE walk
 *  for the fire-time "is there anything to offer" test and for the option list,
 *  so the two cannot disagree about what is within the ceiling. */
function glascCandidates(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter(
    (c) => c.kind === "Unit" && c.energyCost <= GLASC_MAX_ENERGY && c.powerCost <= GLASC_MAX_POWER,
  );
}

export const deathTriggers: Record<string, DeathknellDefinition> = {
  // Glasc Mixologist — "[Deathknell] — You may play a unit with cost no more
  // than [3] and no more than [rainbow] from your trash, ignoring its cost."
  //
  // "IGNORING ITS COST" is the whole cost, both halves — unlike Fizz - Trickster
  // and Jayce, whose reminder text says "you must still pay its Power cost".
  // That is why this goes straight through `playCardIgnoringCost` with no
  // payment step at all.
  //
  // The unit lands in BASE: `playCardIgnoringCost` defaults there, and the card
  // names no destination. A Deathknell that fired at a battlefield still sends
  // it home, the same reading Machine Evangel's "into your base" makes explicit.
  //
  // `ctx.casterIndex` is the dying unit's controller, which is what "your trash"
  // means for a Deathknell.
  "SFD-165": {
    resolve: (state, ctx) =>
      glascCandidates(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-165-play", playerIndex: ctx.casterIndex }),
  },
  // Soaring Scout — "[Deathknell] Channel 1 rune exhausted." (rule 808)
  //
  // Exhausted, not Ready: the rune can still be recycled to pay a Power cost
  // this turn but cannot pay Energy until the next Awaken readies it, which is
  // what makes it weaker than a free rune. Same helper Stormclaw Ursine's
  // on-play trigger uses, so the two cannot drift.
  "OGN-216": { resolve: (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1) },

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
  "OGN-239": {
    resolve: (state, ctx) => [0, 1, 2].reduce((next) => placeRecruitToken(next, ctx.casterIndex, "base"), state),
  },

  // Noxian Emissary — "[Empowered][>][>>][Deathknell][>] Play two 1-Might
  // Recruit unit tokens to your base. (When I die while Empowered, get the
  // effect.)"
  //
  // **Machine Evangel's Deathknell with a condition, and the card's own reminder
  // text is what settles the condition** — "When I die while Empowered" — so
  // there is nothing to infer from the bracket stack. That stack is a DEPENDENT
  // ability nested inside another: 828's `[Empowered][>]` gates 808's
  // `[Deathknell][>]`, with `[>>]` separating the two (the ability divider that
  // `NON_KEYWORD_BRACKETS` records for UNL-049 Honeyfruit, here doing the same
  // job one set later).
  //
  // **Asked on `death.unit`, not on the board.** By the time a Deathknell
  // resolves its source is off the board, so `isEmpowered(state, ...)` would
  // answer `false` for every Emissary that ever died — the status has to come off
  // the corpse the death context carries. That is exactly what `DeathContext.unit`
  // is for, and Unsung Hero below reads it the same way.
  //
  // `applies` rather than a guard inside `resolve`, on the split the interface
  // documents: a Deathknell whose condition is unmet must place NO Pending Item,
  // rather than one that costs both players a PassFocus and resolves to nothing.
  //
  // TWO separate placements rather than a count, for the Evangel's reason: each
  // token is its own game object with its own instanceId (185.1).
  "VEN-128": {
    applies: (_state, death) => death.unit.empowered === true,
    resolve: (state, ctx) => [0, 1].reduce((next) => placeRecruitToken(next, ctx.casterIndex, "base"), state),
  },

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
  "SFD-155": { resolve: (state, ctx) => placeGoldTokens(state, ctx.casterIndex, 1) },

  // Unsung Hero — "[Deathknell] — If I was [Mighty], draw 2." (rule 808)
  //
  // "WAS", past tense, and that is the card: he prints 2 Might, and the rules
  // evaluate a unit in a non-Board zone at its PRINTED Might ("A unit in the
  // trash is Mighty if its printed Might is 5 or greater"), so asking about the
  // copy in the trash would make this text unreachable. It is asked of
  // `death.unit` — the unit as it died, which 808.1.d.3 requires be captured
  // before the card moves — so the buff and the pumps that got him to 5 count.
  //
  // `isMighty` rather than a hand-written `>= 5`: the threshold is a rule, not a
  // per-card number, and the same predicate answers for Fiora - Victorious.
  //
  // **Known limitation, named:** a unit that was Mighty only because of a
  // POSITIONAL aura (Garen - Commander's "+1 here") is not seen — `isMighty`
  // asks with no battlefield, and by now the unit is at none. Everything the
  // unit carried on itself (Might, buff, this-turn pumps) is counted.
  "SFD-167": {
    resolve: (state, ctx, death) => (isMighty(state, death.unit, death.ownerIndex) ? drawCards(state, ctx.casterIndex, 2) : state),
  },

  // Black Rose Dignitary — "[Assault] [Deathknell][>] Channel 1 rune exhausted."
  //
  // Soaring Scout's Deathknell (OGN-216 above) on a 3-Energy 2-Might body with a
  // keyword bolted on, and it shares that card's helper for that reason: the two
  // print the same sentence, and a second hand-written channel would be a second
  // chance to make it Ready.
  //
  // **Only the second half is here.** `[Assault]` is a printed keyword — "+1
  // Might while I'm an attacker" — and it is applied by `effectiveMight`'s
  // combat branch off `keywords.Assault`, not by anything in this file. The
  // `[>]` between the two is the grant arrow (see model/keyword.ts's
  // NON_KEYWORD_BRACKETS entry); it separates `[Deathknell]` from what it
  // grants and is punctuation, not a third ability.
  //
  // Exhausted, not Ready: the rune can be recycled to pay Power this turn but
  // pays no Energy until the next Awaken. `ctx.casterIndex` is the dying unit's
  // controller, which is what an unqualified "channel" means for a Deathknell.
  "UNL-152": { resolve: (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1) },
  "UNL-153": {
    // Carrion Dredger — "[Deathknell][>] Play a 1 [Might] Bird unit token with
    // [Deflect] to your base."
    //
    // "TO YOUR BASE" is printed, so nothing is chosen and nothing depends on
    // where the Dredger died — the same reading Machine Evangel's "into your
    // base" gets two entries up, and the opposite of Vanguard Captain's "here".
    // `ctx.casterIndex` is the dying unit's controller, which is what "your"
    // means for a Deathknell.
    //
    // No `capture`: the destination is a fixed zone and the token's stat line is
    // printed, so there is no fact here that stops being true between the death
    // and the chain pop. `DeathknellDefinition.capture`'s own rule — capture only
    // what has MOVED — is why this is stated rather than added defensively.
    //
    // The Dredger's own `[Deathknell]` and `[Deflect]` keywords are printed and
    // handled by the keyword machinery; only the granted effect is written here.
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", BIRD_TOKEN),
  },
  "UNL-156": {
    // Loyal Poro — "[Deathknell][>] If I didn't die alone, draw 1. (I wasn't
    // alone if there were other friendly units here.)"
    //
    // **The exact inverse of Lonely Poro** (SFD-036 / UNL-221, in effects/calm.ts),
    // and it takes that card's shape rather than a fresh one because the two
    // stand or fall on the same question. The predicate is duplicated here rather
    // than shared: the one-file-one-owner rule puts it in the owning domain's
    // file, and the alternative is a helper in the shared `effect-helpers.ts`
    // this wave must not touch. See `otherFriendlyUnitsDiedWith` below for the
    // wording it is written from.
    //
    // `capture`, NOT a re-derivation in `resolve`, and this is the whole reason
    // the hook exists. 383 / Cleanup step 3a note a dying card's location and
    // "other relevant information" as the ability is ADDED TO THE CHAIN, and
    // `combat.processDefeated` kills a losing side one unit at a time — so a Poro
    // that died beside an ally reads as ALONE by the time its Deathknell pops.
    // For Lonely Poro that mistake draws a card it should not; here it points the
    // other way and SKIPS a draw the card is owed, which is the harder failure to
    // notice because a card that quietly does nothing looks exactly like one
    // whose condition was not met.
    capture: (state, death) => otherFriendlyUnitsDiedWith(state, death.ownerIndex, death.battlefieldId),
    resolve: (state, ctx, _death, captured) => (captured === true ? drawCards(state, ctx.casterIndex, 1) : state),
  },
  "UNL-172": {
    // LeBlanc - Fragmented — "[Assault] [Deathknell][>] Draw 1. If it's your
    // Beginning Phase, draw 2 instead."
    //
    // Only the granted effect is here. `[Assault]` is a printed keyword — 807.1.c,
    // "functionally short for 'While I am an attacker, I have +X [M]'" — applied
    // by `effectiveMight`'s combat branch, and the `[>]` is the grant arrow
    // (model/keyword.ts's
    // NON_KEYWORD_BRACKETS), punctuation rather than a third ability. Black Rose
    // Dignitary two entries up prints the same pair and splits it the same way.
    //
    // "INSTEAD", so it is 2 in the window and 1 outside it — never 3.
    //
    // # `capture`, and this is the card that cannot work without it
    //
    // "If it's YOUR Beginning Phase" is a question about the moment she DIED, and
    // asking `state.phase` in `resolve` would answer FALSE every single time. A
    // `[Deathknell]` is held (383) and finalised onto the chain by the Cleanup;
    // `turn-manager.runBeginning` kills, dispatches and scores and then returns
    // `{ ...scoreHolds(...), phase: "Channel" }` in one synchronous call, so the
    // phase has moved on before any player can pass on the chain. The one thing
    // that reliably kills a unit in that window is `killTemporaryPermanents`
    // itself (816.1.b, "before scoring") — a [Temporary] LeBlanc is precisely the
    // board this clause is printed for, and precisely the one a resolution-time
    // read gets wrong.
    //
    // Shard of Undoing (UNL-174, below) records the same finding from the
    // death-WATCH side and settles it at fire time for the same reason; this is
    // `DeathknellDefinition.capture`'s own rule — capture only what has MOVED —
    // and the phase is the fact that moves.
    //
    // BOTH halves of "your Beginning Phase" are captured, not just the phase:
    // "your" is the dying unit's controller (what an unqualified pronoun means for
    // a Deathknell, the same reading Honest Broker's "you" takes), so a LeBlanc
    // killed during the OPPONENT's Beginning Phase draws the ordinary 1.
    capture: (state, death) => state.phase === "Beginning" && state.activePlayerIndex === death.ownerIndex,
    resolve: (state, ctx, _death, captured) =>
      drawCards(state, ctx.casterIndex, captured === true ? LEBLANC_DRAW * 2 : LEBLANC_DRAW),
  },
  "UNL-179": {
    // Rift Herald, SECOND clause — "[Deathknell][>] Play a unit from your hand to
    // your base, ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // 808.1.b makes `[>]` the formatting between the keyword and its effect —
    // "It is formatted as '[Deathknell][>] [Effect]'" — so it is punctuation, the
    // same reading Black Rose Dignitary and LeBlanc - Fragmented above take.
    //
    // **Soulgorger's shape (OGN-196) with the zone changed and the "you may"
    // removed**, and both differences are printed:
    //   - FROM YOUR HAND, not from the trash. Nothing else in the pool plays a
    //     unit out of hand for free, so the walk below is this file's own.
    //   - "PLAY a unit", with no "you may" — The Harrowing's mandatory reading
    //     rather than Soulgorger's optional one, so no decline is offered.
    // "TO YOUR BASE" is printed too, so `playUnitToBase` and not `playUnitFree`:
    // nothing is chosen about where he lands, and a Herald that died at a
    // battlefield still sends the reinforcement home. Machine Evangel's "into
    // your base" is the same call.
    //
    // "You must still pay its POWER cost" is the split Glasc Mixologist's
    // "ignoring its cost" deliberately does NOT make — see `heraldPlayable`,
    // which prices it at offer time and again at answer time.
    //
    // Guarded at fire time on there being something payable in hand, so an
    // unplayable hand parks no question at all rather than one `advanceDecisions`
    // has to retire. `ctx.casterIndex` is the dying unit's controller, which is
    // what "your hand" means for a Deathknell.
    //
    // No `capture`: nothing this clause asks about has MOVED by the time it
    // resolves — the hand and the Power pool are both re-read live, and re-reading
    // them is the point. `DeathknellDefinition.capture`'s own rule.
    resolve: (state, ctx) =>
      heraldPlayable(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "UNL-179-play", playerIndex: ctx.casterIndex }),
  },
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
    // "BUFFED" is read off the unit AS IT DIED (`death.unit`), which 808.1.d.3
    // requires be captured before the card reaches the trash — by now it is in
    // one, and killUnit has already stripped the buff off the trashed copy
    // (rule 705). Asking the board would find nothing.
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
  "UNL-174": {
    // Shard of Undoing — "The first time a friendly unit dies during your
    // Beginning Phase each turn, each opponent must kill one of their units."
    //
    // Three printed conditions, and all three are facts about the DEATH or about
    // the moment it happened, so all three settle at FIRE time (383.4): a
    // death-watch is HELD, and the window it opens is over by the time it
    // resolves — the phase has advanced to Action long before then, so asking
    // `state.phase` at resolution would never once be true.
    //
    //  - "a FRIENDLY unit" — relative to the LISTENER, like every death-watch
    //    here; the Shard cares about its own controller's losses.
    //  - "during your BEGINNING PHASE" — both halves. `phase === "Beginning"`,
    //    and "your" meaning the Shard's controller is the player whose turn it
    //    is. That is a narrow window with exactly one reachable occupant today:
    //    `killTemporaryPermanents`, which runs inside `runBeginning` and kills
    //    the ACTIVE player's [Temporary] permanents (816, "before scoring").
    //    A battlefield's Beginning-Phase ability is the other candidate.
    //
    // **"THE FIRST TIME ... EACH TURN" is derived rather than stored, and the
    // derivation is exact.** `unitsLostThisTurn` is bumped by `completeDeath`
    // immediately before the trigger is held, and `runEnd` zeroes it for BOTH
    // players at the end of every turn — so during your own Beginning Phase it
    // counts only the deaths of this turn's Awaken (which kills nothing) and this
    // Beginning Phase. `=== 1` is therefore precisely "this is the first".
    //
    // The alternative was Wraith of Echoes' shape: a dedicated per-turn boolean
    // on PlayerState, checked and set at RESOLUTION. Rejected because it is a
    // different card's flag — sharing `firstFriendlyDeathUsedThisTurn` would let
    // a Wraith that drew first silently disarm the Shard — and a new field would
    // touch game-state.ts, player-setup.ts and turn-manager.ts, three files this
    // card has no business editing.
    //
    // One consequence of the two shapes differing is worth stating: with two
    // friendly units dying in the same Beginning Phase, the flag version places
    // TWO Pending Items and the second resolves to nothing, while this places
    // ONE. The player-visible outcome (a single kill demanded) is the same;
    // what differs is whether an ability that "triggered and did nothing" ever
    // existed. `destroyUnit` is called per unit in a sequence, so the two deaths
    // are never genuinely simultaneous here anyway.
    applies: (state, listener, death) =>
      state.phase === "Beginning" &&
      state.activePlayerIndex === listener.ownerIndex &&
      death.ownerIndex === listener.ownerIndex &&
      state.players[listener.ownerIndex].unitsLostThisTurn === 1,
    resolve: (state, listener) => {
      // "EACH OPPONENT" — with two seats that is the one other player. Written as
      // a walk of the other indices rather than `1 - ownerIndex` so a third seat
      // is a data change, the same care King's Edict's note takes over its own
      // multiplayer clauses.
      const opponents = ([0, 1] as const).filter((i) => i !== listener.ownerIndex);
      return opponents.reduce(
        // Nothing to kill is nothing to do (055), and a question with no answers
        // would be dropped by advanceDecisions anyway — guarded here so it is not
        // even asked, which is Vanguard Helm's shape one line up.
        (next, opponentIndex) =>
          ownUnits(next, opponentIndex).length === 0
            ? next
            : parkDecision(next, { kind: "UNL-174-kill", playerIndex: opponentIndex }),
        state,
      );
    },
  },
};

/** Fiora - Worthy's optional ready — one rune of her own domain. */
const FIORA_WORTHY_READY_COST = 1;

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "VEN-121": {
    // Reluctant Leader — "When you play ANOTHER unit, give me +2 [Might] this
    // turn."
    //
    // Cithria of Cloudfield's sentence, and the `cardPlayed` event carries both
    // fields it needs for exactly that card: `playedKind` (a Spell must not pump
    // him) and `playedInstanceId` (his own arrival must not).
    //
    // **"ANOTHER unit" excludes himself by INSTANCE**, so a second Reluctant
    // Leader played beside him does pump the first — "another" is a different
    // object, not a different card, the reading every "other" in this pool takes.
    //
    // **A TOKEN is not a card, and IS a unit.** 185 says "tokens are not cards";
    // this clause says "another UNIT", so `isToken` is deliberately NOT filtered
    // — a Recruit arriving pumps him. The event's own note draws exactly this
    // line, and it is the difference between the listeners that read "play a
    // card" and those that read "play a unit".
    //
    // "When YOU play" is his controller's play, not either player's: the event
    // fires for both sides, and `casterIndex` is what separates them.
    //
    // The pump stacks — three units played is +6 — because each play is its own
    // instruction and `giveMightThisTurn` adds. That is 477.3's arithmetic layer
    // and needs no special handling.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit" &&
      event.playedInstanceId !== listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      // Re-checked at resolution as well as in `applies`: the inline
      // `dispatchEvent` path does not consult `applies` at all, so a condition
      // asserted only there is asserted only on one of the two routes in.
      if (event.casterIndex !== listener.ownerIndex) return state;
      if (event.playedKind !== "Unit" || event.playedInstanceId === listener.card.instanceId) return state;
      return giveMightThisTurn(state, listener.card.instanceId, RELUCTANT_LEADER_MIGHT);
    },
  },
  [KENNEN]: {
    // Kennen, Keeper of Balance — the "or I ATTACK" half of the same offer his
    // `unitTriggers` entry parks on play. See that entry for why one printed
    // ability is registered in two tables.
    //
    // `combatBegan` + `isAttackingAt`, the shared adapter every "when I attack"
    // card in this pool uses, so Kennen and Yasuo cannot come to different answers
    // about who is attacking. The designation is fixed when the combat opens
    // (383), so it is settled in `applies`.
    //
    // The payment is asked SPECULATIVELY here so an unaffordable board places no
    // Pending Item — a held trigger that resolves to nothing still costs both
    // players a PassFocus, and this one would otherwise fire at every combat he is
    // in. Re-asked in `resolve`, because the window a hold opens is exactly when
    // that Energy could be spent elsewhere.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isAttackingAt(state, listener, event) &&
      payEnergyFromPool(state, listener.ownerIndex, KENNEN_STUN_ENERGY) !== undefined,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (payEnergyFromPool(state, listener.ownerIndex, KENNEN_STUN_ENERGY) === undefined) return state;
      return parkDecision(state, {
        kind: KENNEN_STUN,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "VEN-138": {
    // Shen, Leader of the Kinkou Order — "[Shield] When I hold, if there is
    // EXACTLY ONE other unit you control here, you score 1 point."
    //
    // Dunebreaker's positional hold reading with Vendetta's Order motif attached:
    // "when **I** hold" means the battlefield he is standing at, which is what
    // separates him from a "when you conquer" card.
    //
    // A hold is 469.2's SCORING moment rather than mere presence, so a battlefield
    // already scored this turn fires nothing — **470**: "A player may only Score,
    // from either method, once per Battlefield per turn."
    //
    // **EXACTLY one other unit**, so a third body at the battlefield turns him
    // off. That is the boundary this whole domain is built on, and the mutation
    // any board with a single ally would never see.
    //
    // Both conditions settle in `applies` because the event is held (383) and the
    // window a hold opens is precisely when he could be moved or killed — but the
    // COUNT is deliberately re-read in `resolve` as well: it is a condition on the
    // instruction rather than on the trigger, and a unit that arrived or died in
    // the response window changes it. 359.3.f.2 checks a referent on execution.
    //
    // The point goes through `gainPoints`, so Tianna's block and the Victory-Score
    // check apply exactly as they do to every other point in the game.
    on: "battlefieldHeld",
    applies: (state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      listener.card.kind === "Unit" &&
      otherOwnUnitsHere(state, listener.card, listener.ownerIndex) === SHEN_ALLIES,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      if (listener.card.kind !== "Unit") return state;
      if (otherOwnUnitsHere(state, listener.card, listener.ownerIndex) !== SHEN_ALLIES) return state;
      return gainPoints(state, listener.ownerIndex, SHEN_POINTS);
    },
  },
  "SFD-180": {
    // Fiora - Worthy — "When a unit you control becomes [Mighty], you may pay
    // [Order] to ready it."
    //
    // Rides `unitBecameMighty`, the TRANSITION event built for Fiora - Grand
    // Duelist, and inherits its recorded partial: a unit that becomes Mighty
    // because an AURA arrived is not seen, because nothing about that unit
    // changed. See the event's own doc and docs/rules-conformance.md.
    //
    // "A unit YOU control" is any of her controller's units INCLUDING herself —
    // she prints no "other", and at 3 Might a single buff plus an Equipment puts
    // her over the line. `ownerIndex` on the event is the unit's controller, so
    // the comparison is direct.
    //
    // The payment is a RUNE of her domain, not Energy — `payPowerFromChanneled`
    // rather than `payEnergyFromPool` — so it recycles the rune (416) instead of
    // exhausting it. Checked here so an offer nobody can pay is never made.
    on: "unitBecameMighty",
    applies: (state, listener, event) =>
      event.kind === "unitBecameMighty" &&
      event.ownerIndex === listener.ownerIndex &&
      payPowerFromChanneled(state, listener.ownerIndex, "Order", FIORA_WORTHY_READY_COST) !== undefined,
    resolve: (state, listener, event) =>
      event.kind === "unitBecameMighty"
        ? parkDecision(state, {
            // WHICH unit crossed is settled now and carried, not re-derived: the
            // question waits on the chain, and by the time it is answered
            // several units may be Mighty and only this one triggered.
            kind: "SFD-180-ready",
            playerIndex: listener.ownerIndex,
            targetInstanceId: event.unitInstanceId,
          })
        : state,
  },
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
      // Nothing to buff is nothing to do (055), and a held trigger with no
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
    // A hold is the SCORING moment (469.2 — "maintains Control of a Battlefield
    // they did not yet Score this turn"), so a battlefield already conquered this
    // turn fires nothing (471.1.b) and pays no Gold. That is the event's own
    // contract; nothing here has to check it.
    //
    // Both conditions are fixed at FIRE time, which matters more here than the
    // ordinary reason: this trigger is held, and the window it opens is exactly
    // when an opponent would move or kill him. Re-asking at resolution would let
    // them cancel a payout that has already been earned (383.3 / 377.3.a.1 — the ability is
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
    // shape without editing it (383.4.e: the trigger is gaining the Attacker
    // designation, which 464.2.c's Combat Step 1 hands out).
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
      // (383.3 / 377.3.a.1).
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
    // **BOTH claims that used to sit here were falsified on 2026-08-09**, and
    // both by the same change. They said this fires only for a Standard Move —
    // "a spell-driven relocation is deliberately outside the event too" — and
    // that "`to` is always a battlefield id (a MoveUnit action names one), so
    // 'to a battlefield' needs no test of its own".
    //
    // Neither holds now. 446.1/449 make an effect-driven relocation a Move and
    // `effect-helpers` emits the event for one; 455 makes a unit walking home a
    // Move too, and that one carries `to: "base"`.
    //
    // So the destination test is REAL and is written out. Without it she fired
    // on a walk home — silently, because `placeToken` returns the state unchanged
    // for an unknown battlefield id. Accidental safety, not correctness, and
    // exactly the shape Mister Root (UNL-127) was caught in the same day.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      // Identity, not ownership: the event is about ONE unit, and hers is the
      // only move she cares about. "When I move", not "when a friendly unit
      // moves".
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      // "TO A BATTLEFIELD" — home is not one.
      event.to !== "base",
    resolve: (state, listener, event) =>
      event.kind === "unitMoved"
        ? // Three separate placements rather than a count: `placeRecruitToken`
          // mints one token, and three tokens are three game objects.
          [0, 1, 2].reduce((next) => placeRecruitToken(next, listener.ownerIndex, { battlefieldId: event.to }), state)
        : state,
  },
  "UNL-170": {
    // Atakhan, THIRD clause only — "When I attack, the defender must kill one of
    // their units here."
    //
    // **The first clause is REFUSED**: "You may kill a friendly unit as an
    // additional cost to play me. If you do, I cost [1] less for each Energy it
    // costs and [Order] less for each Power it costs." The KILL is expressible —
    // `OPTIONAL_UNIT_COSTS`' `killFriendly` is Cruel Patron's and Commander
    // Ledros' — but the DISCOUNT is not: `repeatable` buys a flat 1 Power per
    // payment, and this scales with the printed cost of whatever was killed, on
    // both axes at once. Pricing it means new shape in card-effects.ts and new
    // arithmetic in legal-actions.ts and validate-play-card.ts, three shared
    // files. So he costs his printed 10 and 3 with no way to buy it down —
    // strictly weaker than printed, which is the safe direction, and the exact
    // half that is missing.
    //
    // `[Ganking]` is a printed keyword and is read by validate-move-unit and the
    // move fan-out through `effectiveKeywords`; nothing about it belongs here.
    //
    // Registered as a `combatBegan` listener rather than added to
    // unit-triggers.ts's ATTACK_TRIGGERS table — that table is shared, and
    // `isAttackingAt` is exported precisely so a per-domain file can take the same
    // shape without editing it. 383.4.e is the rule: an Attack Trigger fires when
    // a unit "gains the Attacker designation", which 464.2.c's Combat Step 1 hands
    // out. Rek'Sai - Swarm Queen and Azir - Sovereign are the two entries above
    // taking the same route.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      // "HERE" is a REFERENT, read from the ability's source at execution
      // (359.3.f.2) — so an Atakhan moved or killed inside the response window
      // this trigger opens leaves the instruction with nothing to point at, and it
      // is dropped rather than re-aimed. The PDF works this exact case on Yasuo -
      // Remorseful. 383 still fixes that the ability TRIGGERED; only its "here"
      // goes stale.
      if (!isStillHere(state, listener.card.instanceId, event.battlefieldId)) return state;
      // 464.2.c.2: "The Defender is the player who did not apply the Contested
      // status." `applies` has already established that this listener's
      // controller is the Attacker, so with two seats the defender is the other
      // one. Written as a walk of the other indices rather than `1 - ownerIndex`
      // so a third seat is a data change — King's Edict's and Shard of Undoing's
      // care over the same sentence.
      const defenders = ([0, 1] as const).filter((i) => i !== listener.ownerIndex);
      return defenders.reduce((next, defenderIndex) => {
        // Nothing of theirs standing here is nothing to do (055), and a question
        // with no answers would be dropped by `advanceDecisions` anyway — guarded
        // so it is not even asked. Note this is deliberately NOT "they have no
        // units": a defender with a full base and nothing at the contested
        // battlefield loses nothing, because the card says "here".
        return unitsAtFor(next, defenderIndex, event.battlefieldId).length === 0
          ? next
          : parkDecision(next, {
              kind: "UNL-170-kill",
              playerIndex: defenderIndex,
              // WHERE is carried rather than re-derived: the question waits on the
              // chain, and by the time it is answered the Showdown may have closed
              // and `showdownBattlefieldId` been nulled.
              battlefieldId: event.battlefieldId,
            });
      }, state);
    },
  },
  "UNL-176": {
    // Vi - Peacekeeper, SECOND clause only — "When I attack, [Stun] an enemy unit
    // here."
    //
    // **`[Ambush]` is REFUSED and it is not this file's to write.** "You may play
    // me as a [Reaction] to a battlefield where you have units" is a play
    // PERMISSION plus a timing tier, which lives in validate-play-card.ts and
    // legal-actions.ts (the same two files `PLACEMENT_GRANTS` in unit-triggers.ts
    // is read by). `coverage.ts`'s `UNIMPLEMENTED_KEYWORDS` already carries the
    // keyword with the note "[Ambush] is ignored — this can't yet be played as a
    // [Reaction] to a battlefield you hold", so this card stays greyed until the
    // keyword lands whatever is written here. That is the honest state and the
    // reason this entry exists anyway: the attack trigger is a separate ability
    // and there is no reason for it to be inert as well.
    //
    // Registered as a `combatBegan` listener rather than added to
    // unit-triggers.ts's shared ATTACK_TRIGGERS table, the route `isAttackingAt`
    // is exported for. 383.4.e is the rule — an Attack Trigger fires when a unit
    // "gains the Attacker designation", handed out by 464.2.c's Combat Step 1.
    // Rek'Sai, Azir - Sovereign and Atakhan above take the same route.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      // "HERE" is a REFERENT read from the ability's source at execution
      // (359.3.f.2), so a Vi moved or killed inside the response window this
      // trigger opens leaves the instruction pointing at nothing and it is
      // dropped rather than re-aimed. Atakhan's entry above works the same
      // sentence; the PDF works the case itself on Yasuo - Remorseful.
      if (!isStillHere(state, listener.card.instanceId, event.battlefieldId)) return state;
      const enemyIndex = (1 - listener.ownerIndex) as 0 | 1;
      // Nothing of theirs standing here is nothing to do (055). Note this counts
      // ALL enemy units here including already-stunned ones — see the question's
      // own note for why a stunned unit stays a legal choice.
      return unitsAtFor(state, enemyIndex, event.battlefieldId).length === 0
        ? state
        : parkDecision(state, {
            kind: "UNL-176-stun",
            playerIndex: listener.ownerIndex,
            // WHERE is carried rather than re-derived: the question waits on the
            // chain, and by the time it is answered the Showdown may have closed
            // and `showdownBattlefieldId` been nulled. Atakhan's reason exactly.
            battlefieldId: event.battlefieldId,
          });
    },
  },
  "UNL-177": {
    // Ivern - Friend to All, SECOND clause — "When I conquer or hold, score 1
    // point if your units have all of the following tags among them — Bird, Cat,
    // Dog, and Poro."
    //
    // The OR is what needs `on` to be a list: one defId, two moments, which is
    // the shape widening `on` was added for. Last Rites (SFD-150, effects/chaos.ts)
    // is the precedent and this is its predicate with the wearer indirection
    // dropped — Ivern is a unit, so the listener IS him.
    //
    // **"When I conquer or hold" is POSITIONAL**, the reading Eminent Benefactor,
    // Ahri - Alluring and Blitzcrank - Impassive all take of the same phrase: the
    // battlefield scored has to be the one he is standing at, not merely one his
    // controller scored somewhere. Both events carry a battlefield for exactly
    // that reason and `listener.battlefieldId` is where he stands.
    //
    // # The tag condition is checked at RESOLUTION, deliberately
    //
    // Everything in `applies` is a TRIGGER condition and is fixed at fire time,
    // which is what stops an opponent cancelling an earned payout by moving him
    // (383.3 / 377.3.a.1). The tag test is not one of those: "score 1 point IF your units
    // have..." is a condition inside the EFFECT, and 402.1 puts an effect's own
    // conditions at resolution. So a fourth tribe that arrives during the response
    // window this trigger opens DOES pay out, and one that dies in it does not.
    // That asymmetry is the rules working, not an oversight — it is why the two
    // checks are in different functions rather than one shared predicate.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (_state, listener, event) => {
      if (event.kind === "battlefieldConquered") {
        return event.conquerorIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId;
      }
      return (
        event.kind === "battlefieldHeld" &&
        event.holderIndex === listener.ownerIndex &&
        listener.battlefieldId === event.battlefieldId
      );
    },
    // Through `gainPoints`, the single choke point every point-gain goes through
    // so Tianna Crownguard's "opponents can't gain points" reaches it.
    resolve: (state, listener) =>
      hasEveryPetTag(state, listener.ownerIndex) ? gainPoints(state, listener.ownerIndex, 1) : state,
  },
  "UNL-179": {
    // Rift Herald, FIRST clause — "When I move to a battlefield, look at the top 3
    // cards of your Main Deck. You may reveal a unit from among them and draw it.
    // Recycle the rest."
    //
    // Corina Veraza's registration (SFD-179 above): the `unitMoved` EVENT rather
    // than unit-triggers.ts's shared ON_MOVE_TRIGGERS table, since the event is
    // already held (383) and already carries everything this needs.
    //
    // # "TO A BATTLEFIELD" is checked, and Corina's entry above shows why
    //
    // Her comment says "`to` is always a battlefield id (a MoveUnit action names
    // one)". That was true when it was written and is NOT true now: `unitMoved`
    // gained effect-driven emitters on 2026-08-09 (446.1/449), and
    // `forceMoveToBase` fires it with `to: "base"`. So a Herald sent home by an
    // opponent's Charm would otherwise look at three cards for free. Guarded here
    // by NAME rather than by asking the battlefield list, because "base" is the
    // literal sentinel `holdMoveEvents` is handed.
    //
    // (Corina is unguarded and remains so — `placeToken` returns the state
    // unchanged for an unknown battlefield id, so her bug is silent rather than
    // wrong, and fixing another card's clause is not this change's business. It is
    // named in this change's report.)
    //
    // Identity, not ownership: "when I move", so it matches his own instanceId and
    // fires whoever caused the move — the card names no mover.
    on: "unitMoved",
    applies: (state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.to !== "base" &&
      // An empty deck has nothing to look at, so there is no question — 055, and
      // it keeps a Pending Item off the chain rather than relying on
      // `advanceDecisions` to retire the prompt it would raise.
      state.players[listener.ownerIndex].deck.length > 0,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved" && state.players[listener.ownerIndex].deck.length > 0
        ? parkDecision(state, { kind: "UNL-179-look", playerIndex: listener.ownerIndex })
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
  "UNL-158": {
    // Shepherd's Heirloom, first clause — "When you play this, gain 1 XP."
    //
    // A SELF-trigger for the reason Forge of the Future's is: a Gear does not
    // push a chain entry when it is played (`execute-play-card`'s Spell branch is
    // the only one that does), so a `cardEffects` entry for this card would be
    // registered, enumerated, paid for and NEVER RUN. Measured before writing it
    // — the else-branch that files a Gear into `activeGear` never touches
    // `spellChain`.
    //
    // Its `[Equip] — Spend 1 XP` half is in `activatedAbilities` below.
    on: ["played"],
    resolve: (state, event) => gainXp(state, event.ownerIndex, HEIRLOOM_XP),
  },
  "UNL-161": {
    // Divining Shells, first clause — "[Vision] (When you play this, look at the
    // top card of your Main Deck. You may recycle it.)"
    //
    // **`[Vision]` does not fire for a Gear**, and that is the reason this entry
    // exists rather than the keyword machinery covering it. `applyVision` is
    // called from exactly one place, `dispatchOnPlayUnit`, and both the
    // enumerator and the validator gate the `visionRecycle` choice on
    // `card.kind === "Unit"`. So a Gear printing the keyword predicts nothing:
    // measured by reading all four call sites, not inferred from the keyword
    // being absent from `UNIMPLEMENTED_KEYWORDS`.
    //
    // **817.1.a settles that this is a gap rather than a reading**: "Vision …
    // is present on PERMANENTS", and a Gear is one. 817.1.b and 817.1.c give the
    // rest — "functionally short for 'When this is played, predict'", with "the
    // trigger [being] the permanent entering the Board".
    //
    // Asked as a QUESTION rather than fanned onto the action, which is the only
    // shape available here — `PlayCardAction.visionRecycle` is not enumerated for
    // a Gear — and it is also the more conformant one. 817.1.a makes Vision a
    // TRIGGERED ability, and 402.1 puts a triggered ability's "you may" at
    // RESOLUTION: "If the first part of a Triggered Ability's effect is 'you
    // may,' … its controller decides whether or not to perform it" then. The
    // Unit path decides it at announce instead, which is the pre-existing
    // divergence; this one does not inherit it.
    //
    // **Deliberately NOT firing `holdCardsRecycled`**, and not raising
    // `offerTopOfDeckBanish` either — `applyVision` does neither, and a Gear's
    // Vision behaving differently from a Unit's would be a worse answer than
    // both sharing one gap. Recorded rather than quietly fixed here.
    on: ["played"],
    resolve: (state, event) =>
      // An empty deck has nothing to look at, so there is no question to ask —
      // 055's "do as much as you can", and it keeps a one-option prompt off the
      // board rather than relying on `advanceDecisions` to retire it.
      state.players[event.ownerIndex].deck.length === 0
        ? state
        : parkDecision(state, { kind: "UNL-161-predict", playerIndex: event.ownerIndex }),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/**
 * Every unit in play, BOTH sides — Kennen's "[Stun] a unit", which names no owner
 * and no location (355.9.a.1's bare noun).
 *
 * A local composition of the shared `ownUnitsEverywhere` rather than an import:
 * `effects/chaos.ts` has a private `allUnitsInPlay` of its own, and the
 * one-file-one-owner rule that keeps these files independently editable is
 * exactly what makes a local copy the only thing a domain file CAN write. Two
 * copies of a two-line walk is the cheaper half of that trade; sweeping them into
 * one shared helper is integrator work, and is noted here so the next sweep can
 * find both.
 */
function bothSidesUnitsInPlay(state: GameState): UnitInstance[] {
  return [...ownUnitsEverywhere(state, 0), ...ownUnitsEverywhere(state, 1)];
}

export const decisions: Record<string, DecisionDefinition> = {
  /**
   * Kennen's "you may pay [2 Energy] to [Stun] a unit" — ONE question kind for
   * BOTH of his moments (played, and attacking), parked from two registrations.
   *
   * That is deliberate: a second kind would be a second option list to keep in
   * step, and the printed ability is one sentence with two triggers rather than
   * two abilities.
   *
   * **The payment is taken HERE and asked through the helper that takes it**, so
   * affordability and payment cannot disagree — the discipline every "you may
   * pay" in this pool keeps. The offer is rebuilt from live state, so a Kennen
   * who died in the response window, or Energy spent elsewhere, leaves a bare
   * Decline that `advanceDecisions` executes without prompting (416.3).
   *
   * The TARGET is part of the same question rather than a second one, because
   * declining to pay and declining to stun are the same answer — 355.10.d.1's
   * cost-within-an-instruction, the reading Sinister Poro's entry records.
   *
   * "A unit", bare, so every unit in play is offered including his controller's
   * own (355.9.a.1). Stunning your own is a bad play, not an illegal one.
   */
  /**
   * Fallen Feline's "name a spell".
   *
   * # EVERY spell in the pool, and that is the faithful reading
   *
   * 762 bounds a naming to "a card that is legal in the Format being played" and
   * 762.1 to a card that exists; nothing narrows it to a card in any zone, in any
   * deck, or in the opponent's colours. So the offer is the whole pool's SPELLS —
   * 233 of them, from the registry rather than from a list, so a set adding spells
   * needs no maintenance here.
   *
   * Distinct NAMES rather than defIds (132.1: a name identifies a card uniquely),
   * which is also what makes the option id the name itself — the ban compares
   * names, so the answer is already in the form the restriction reads.
   *
   * 762.2 excludes token names, and the registry gives that for free: tokens are
   * not card definitions and never appear in this walk.
   *
   * **This is the widest decision in the engine by an order of magnitude**, and
   * the cost is real rather than theoretical: `legal-actions` fans a pending
   * decision into one action PER OPTION, and the AI scores every one. Measured on
   * the probes rather than assumed — see docs/vendetta-scope.md. The narrower
   * alternatives all lose information the printed card has: offering only spells
   * in the opponent's DECK leaks hidden information, and offering only spells
   * already SEEN makes a naming that pre-empts the deck's best card impossible,
   * which is what the card is for.
   */
  [FALLEN_FELINE_NAME]: {
    prompt: () => "Fallen Feline: name a spell",
    options: () =>
      allSpellNames().map((name) => ({ id: name, label: name })),
    // Written onto HER rather than into a player- or state-level record: see
    // `UnitInstance.namedSpell`. `nameSpellOn` no-ops if she is already gone
    // (359.3.e.12), so a Feline killed in the response window names nothing.
    resolve: (state, d, optionId) =>
      d.cardInstanceId === undefined ? state : nameSpellOn(state, d.cardInstanceId, optionId),
  },
  [KENNEN_STUN]: {
    prompt: () => "Kennen: pay 2 Energy to stun a unit?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(payEnergyFromPool(state, d.playerIndex, KENNEN_STUN_ENERGY) === undefined
        ? []
        : bothSidesUnitsInPlay(state)
            // An already-stunned unit is not offered: 423 makes Stunned a binary
            // state and says outright that "a Stunned Unit can not be Stunned
            // again", so paying 2 Energy for it would buy nothing. `stunUnits`
            // skips it anyway; withholding it here is what stops the player being
            // charged for the discovery.
            .filter((unit) => !unit.stunned)
            .map((unit) => ({ id: unit.instanceId, label: `Stun ${unit.name}`, instanceId: unit.instanceId }))),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const paid = payEnergyFromPool(state, d.playerIndex, KENNEN_STUN_ENERGY);
      if (paid === undefined) return state;
      return stunUnits(paid, d.playerIndex, [optionId]);
    },
  },
  "UNL-169-banish": {
    // Ashe - Focused. Chooser is the caster; the hand, the banish zone and the
    // hand it comes back to are all the opponent's.
    prompt: () => "Ashe - Focused: choose a card from the revealed hand to banish",
    options: (state, d) =>
      state.players[d.playerIndex === 0 ? 1 : 0].hand.map((c) => ({
        id: c.instanceId,
        label: c.name,
        instanceId: c.instanceId,
      })),
    // No decline: "choose a card revealed this way and banish it" is not "you
    // may". An empty hand produces no options and the question is dropped whole.
    resolve: (state, d, optionId) => banishFromHandUntilHold(state, d.playerIndex === 0 ? 1 : 0, optionId),
  },
  "SFD-160-kill": {
    // Zaun Punk's payoff — "kill a gear", unqualified, so either side's.
    prompt: () => "Zaun Punk: kill a gear",
    options: (state) =>
      ([0, 1] as const).flatMap((owner) =>
        state.players[owner].activeGear.map((g) => ({
          id: `${owner}:${g.instanceId}`,
          label: `Kill ${g.name}`,
          instanceId: g.instanceId,
        })),
      ),
    // No decline: the card prints "kill a gear", not "you may". The trigger
    // already checked there is one to kill, so this is never an empty question.
    resolve: (state, _d, optionId) => {
      const [ownerRaw, instanceId] = optionId.split(":");
      const ownerIndex = ownerRaw === "1" ? 1 : 0;
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === instanceId);
      return gear ? killGear(state, gear, ownerIndex) : state;
    },
  },
  "SFD-165-play": {
    // Glasc Mixologist's "[Deathknell] — you may play a unit from your trash,
    // ignoring its cost."
    prompt: () => "Glasc Mixologist: play a unit from your trash, ignoring its cost?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...glascCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: `Play ${c.name}`, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Re-derived at ANSWER time against the same walk the offer came from: the
      // trash moves while a question waits on the chain — a Recycle can take the
      // very card being named.
      const chosen = glascCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (chosen === undefined) return state;
      // Out of the trash BEFORE it is played, or the card would be in two zones
      // at once — and `playCardIgnoringCost` fires the play events, which a
      // listener reads against the finished board.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
      };
      return playCardIgnoringCost({ ...state, players }, d.playerIndex, chosen);
    },
  },
  "SFD-180-ready": {
    // Fiora - Worthy's "you may pay [Order] to ready it."
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId)?.unit : undefined;
      return `Fiora - Worthy: pay [Order] to ready ${unit?.name ?? "the unit"}?`;
    },
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Re-asked at ANSWER time: the rune may have gone while the question
      // waited on the chain, and the unit may have died or been readied by
      // something else. A dead unit is not offered a ready.
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId)?.unit : undefined;
      if (
        unit &&
        unit.exhausted &&
        payPowerFromChanneled(state, d.playerIndex, "Order", FIORA_WORTHY_READY_COST) !== undefined
      ) {
        options.push({ id: "pay", label: `Pay [Order] to ready ${unit.name}` });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || d.targetInstanceId === undefined) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Order", FIORA_WORTHY_READY_COST);
      // Re-derived rather than trusted, the convention every paid decision
      // follows. `readyUnit` refuses an already-ready unit on its own, so an
      // unnecessary ready costs nothing and fires no event.
      return paid ? readyUnit(paid, d.targetInstanceId) : state;
    },
  },
  // Vanguard Helm's "buff another friendly unit", raised by its death-watch.
  //
  // WHICH unit is a real choice with no action to hang it on — the trigger fires
  // inside a death, mid-resolution. Already-buffed units stay on offer: 702.3.a
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
    // eligible as one at a battlefield — 355.9.a.1, the bare noun "unit" means
    // objects on the Board, and Bases are Public.
    //
    // No options at all when the player has no units: rule 055's "do as much as
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
  // Shard of Undoing's half of the work: one opponent naming which of their own
  // units the gear costs them. Cull the Weak's question with a different asker —
  // written from the ANSWERING player's point of view, since "one of THEIR units"
  // is theirs and not the Shard controller's.
  "UNL-174-kill": {
    prompt: () => "Shard of Undoing: kill one of your units",
    // "One of their units" names no battlefield, so a unit in base is as eligible
    // as one standing out (355.10.a.1 — the bare noun means objects on the Board,
    // and Bases are Public). Exactly one unit is not a choice and is killed
    // without a prompt; no units at all was already filtered at fire time.
    options: (state, d) =>
      ownUnits(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    // The KILLER is the player answering, exactly as in Cull the Weak and NOT as
    // in King's Edict: "each opponent must KILL one of their units" puts both the
    // choice and the kill on them, so a watcher asking "did you kill an ENEMY
    // unit" correctly sees a friendly death and stays quiet.
    resolve: (state, d, optionId) => destroyUnit(state, optionId, d.playerIndex),
  },
  // Safety Inspector's half of the work: one player naming which of their own
  // units the Inspector costs them. Cull the Weak's question with a different
  // card's name on it — asked of BOTH players, so it is written from the
  // ANSWERING player's point of view rather than the caster's.
  "UNL-164-kill": {
    prompt: () => "Safety Inspector: kill one of your units",
    // "One of their units" names no battlefield, so a unit in base is as eligible
    // as one standing out (355.9.a.1's bare noun, and 355.10.a.1 puts Bases among
    // the Public zones). No options at all when the player has nothing —
    // `advanceDecisions` drops the question rather than deadlocking on it — and
    // exactly one unit is not a choice, so it is killed without a prompt.
    options: (state, d) =>
      ownUnits(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    // The killer is the player answering, not the Inspector's controller: "each
    // player MUST KILL one of their units" puts both the choice and the kill on
    // them, so a watcher asking "did you kill an enemy unit" correctly sees a
    // friendly death and stays quiet. Cull the Weak's reading, and NOT King's
    // Edict's, where the spell does the killing.
    resolve: (state, d, optionId) => destroyUnit(state, optionId, d.playerIndex),
  },
  // Atakhan's half of the work: the DEFENDER naming which of their units at the
  // contested battlefield his attack costs them.
  "UNL-170-kill": {
    prompt: () => "Atakhan: kill one of your units here",
    // **"HERE" is the whole filter, and it is the difference between this
    // question and the three above.** Cull the Weak, King's Edict and Shard of
    // Undoing all reach every unit their answerer controls; this one reaches only
    // the contested battlefield, so a defender who left a reserve at home keeps
    // it. Re-derived from live state at answer time rather than captured as a
    // list: the question waits on the chain, and a unit that arrived or died in
    // between must be counted as it stands now.
    options: (state, d) =>
      (d.battlefieldId === undefined ? [] : unitsAtFor(state, d.playerIndex, d.battlefieldId)).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    // The defender kills their OWN, so the killer is the player answering —
    // "the defender MUST KILL one of their units", Cull the Weak's split rather
    // than King's Edict's.
    resolve: (state, d, optionId) => destroyUnit(state, optionId, d.playerIndex),
  },
  // Vi - Peacekeeper's half of the work: her controller naming the enemy unit at
  // the contested battlefield her attack stuns.
  "UNL-176-stun": {
    prompt: () => "Vi - Peacekeeper: stun an enemy unit here",
    // **Already-stunned units stay on the list, and that is a reading rather than
    // an oversight.** 423 makes Stun binary and says "a Stunned Unit can not be
    // Stunned again", so a second stun does nothing — but "an enemy unit here" is
    // the whole printed restriction, and 355.9.b ("It meets all targeting
    // restrictions") only narrows a target by what is PRINTED. Filtering them out
    // would quietly turn this into "stun an UNSTUNNED enemy unit here", which
    // matters on the one board where it differs: every enemy here already stunned,
    // where the printed card offers a legal choice that accomplishes nothing and a
    // filtered list would offer none at all. `stunUnits` drops a no-op stun on its
    // own, so nothing downstream double-fires.
    //
    // Re-derived from live state at answer time rather than captured as a list:
    // the question waits on the chain, and a unit that arrived or died in between
    // must be counted as it stands now. Atakhan's question one entry up.
    //
    // No decline: the card prints "[Stun] an enemy unit here", not "you may".
    options: (state, d) =>
      (d.battlefieldId === undefined ? [] : unitsAtFor(state, (1 - d.playerIndex) as 0 | 1, d.battlefieldId)).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    // `stunUnits`, not a flag write: it is the one thing that fires `unitsStunned`
    // (Leona - Radiant Dawn, Eclipse Herald, Solari Shrine all read it), and it is
    // ONE call for the one unit, so the batch event is raised once per
    // INSTRUCTION exactly as its own note requires.
    resolve: (state, d, optionId) => stunUnits(state, d.playerIndex, [optionId]),
  },
  // Ivern - Friend to All's "choose Bird, Cat, Dog, or Poro. I gain that tag."
  //
  // Four fixed options with no decline — the card says "choose", and all four
  // always exist, so this is a real question `advanceDecisions` never answers on
  // the player's behalf. That is unlike every other question in this file, whose
  // options come off the board.
  //
  // The unit is carried on `cardInstanceId` and re-found at ANSWER time: he can
  // have died in the response window between his arrival and this, in which case
  // there is nobody to give the tag to and the instruction is simply dropped
  // (359.3.e's shape, and 055's).
  "UNL-177-tag": {
    prompt: () => "Ivern - Friend to All: choose a tag he gains",
    options: () => PET_TAGS.map((tag) => ({ id: tag, label: tag })),
    resolve: (state, d, optionId) =>
      d.cardInstanceId === undefined || !PET_TAGS.includes(optionId)
        ? state
        : grantTagToUnit(state, d.cardInstanceId, optionId),
  },
  // Rift Herald's "look at the top 3 cards of your Main Deck. You may reveal a
  // unit from among them and draw it. Recycle the rest."
  //
  // Baited Hook's structure exactly (135.2.b's separate instructions): the recycle
  // is its OWN instruction and runs on EVERY answer, the decline included. Only
  // the reveal-and-draw is optional, which is what "You may" attaches to.
  "UNL-179-look": {
    prompt: (state, d) => {
      const top = state.players[d.playerIndex].deck.slice(0, HERALD_LOOK);
      // The cards are NAMED. A look whose prompt does not say what was looked at
      // is the one shape that makes the question unanswerable — Divining Shells'
      // finding, and this is a look at three instead of one.
      return `Rift Herald: ${top.map((c) => c.name).join(", ")} — draw a unit and recycle the rest?`;
    },
    options: (state, d) => [
      { id: "decline", label: "Recycle all three" },
      ...state.players[d.playerIndex].deck
        .slice(0, HERALD_LOOK)
        .filter((c): c is UnitInstance => c.kind === "Unit")
        .map((c) => ({ id: c.instanceId, label: `Reveal and draw ${c.name}`, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      const actor = state.players[d.playerIndex];
      const top = actor.deck.slice(0, HERALD_LOOK);
      // Re-derived against the same walk the offer came from, and re-CHECKED that
      // it is a Unit: the question can sit behind another whose answer moved the
      // deck, and a stale id must not name a Spell that has drifted into the top 3.
      const chosen = optionId === "decline" ? undefined : top.find((c) => c.instanceId === optionId && c.kind === "Unit");
      const rest = top.filter((c) => c.instanceId !== chosen?.instanceId);

      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        // "DRAW it" — it goes to hand, and the rest go to the BOTTOM of the deck,
        // which is what Recycle means (416). Both in one write, so the three cards
        // are off the top exactly once.
        deck: [...actor.deck.slice(top.length), ...rest],
        ...(chosen ? { hand: [...actor.hand, chosen] } : {}),
      };
      // The event, so Karma - Channeler sees it. ONE hold for the instruction
      // however many cards moved, which is `holdCardsRecycled`'s own contract.
      //
      // **Deliberately NOT `drawCards` for the reveal**, even though the card says
      // "draw it": that helper takes from the TOP, and the card being drawn may be
      // the second or the third of the three. A `drawCards(1)` here would take the
      // wrong card and then recycle the right one.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, rest.length);
    },
  },
  // Rift Herald's `[Deathknell]` — "Play a unit from your hand to your base,
  // ignoring its Energy cost. (You must still pay its Power cost.)"
  //
  // No decline: "Play a unit", not "you may play". The Harrowing's mandatory
  // reading, and the Deathknell has already checked there is something payable —
  // so with none this question is never raised, and with exactly one option
  // `advanceDecisions` performs it without a prompt, because one option is not a
  // choice.
  "UNL-179-play": {
    prompt: () => "Rift Herald: play a unit from your hand to your base, paying only its Power cost",
    options: (state, d) =>
      heraldPlayable(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: heraldLabel(c), instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const chosen = heraldPlayable(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (chosen === undefined) return state;
      // Re-paid here rather than trusted from the option list, which was built
      // from an earlier state: anything that drained the pool between the question
      // and the answer makes this fizzle rather than play a unit for free.
      const paid = payPrintedPower(state, d.playerIndex, chosen);
      if (paid === undefined) return state;

      // Out of the HAND before it is played, or the card would be in two zones at
      // once — and `playUnitToBase` fires the play events, which a listener reads
      // against the finished board. `cardsPlayedThisTurn` still moves, because this
      // IS a card being played and [Legion] counts plays rather than payments.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        hand: players[d.playerIndex].hand.filter((c) => c.instanceId !== chosen.instanceId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      return playUnitToBase({ ...paid, players }, d.playerIndex, chosen);
    },
  },
  // Starhound's "return a Bird, Cat, Dog, or Poro from your trash to your hand".
  //
  // No decline: the card prints "return", not "you may return", and the trigger
  // has already checked there is something to return — so this is never an empty
  // question. That is the one thing separating it from Spectral Matron's
  // otherwise identical trash question.
  "UNL-167-return": {
    prompt: () => "Starhound: return a Bird, Cat, Dog, or Poro from your trash to your hand",
    options: (state, d) =>
      starhoundCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      // Re-derived at ANSWER time against the same walk the offer came from — the
      // trash moves while a question waits on the chain, and a Recycle can take
      // the very card being named. Going through the candidate list rather than
      // straight to `returnCardFromTrash` is also what stops a stale id naming an
      // untagged card that happens to be sitting there.
      const chosen = starhoundCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      return chosen ? returnCardFromTrash(state, d.playerIndex, chosen.instanceId) : state;
    },
  },
  // **Undying Loyalty's "UNL-168-play" was REMOVED on 2026-08-12.** It used to
  // sit here — Spectral Matron's question with a tighter ceiling and no decline,
  // since she prints "you may play" and that card prints "Play a unit".
  //
  // It now names its trash unit as an announce-time target (355.4 makes a
  // spell's choices happen at finalization, 355.9.a.4 makes a card in a Public
  // trash a legal target) rather than parking a question, because its "[2] less
  // if you CHOOSE a Bird, Cat, Dog, or Poro" discount has to be priced when the
  // card is paid for. The whole handler moved into the card's own `resolve` in
  // this file; nothing else answered this question.
  //
  // Its two neighbours stayed put, for two DIFFERENT reasons — worth writing
  // down, because "why did this one move" is what a later tidy-up will ask:
  //
  //   - The Harrowing (OGN-198) is a SPELL, so 355.4 would put its choice at
  //     announce too. What stops it is the PAYMENT: it plays the unit "ignoring
  //     its Energy cost. (You must still pay its Power cost.)", and that Power is
  //     paid at resolution out of the pool as it then stands. It cannot ride the
  //     PlayCardAction that already paid the spell's own cost.
  //   - Spectral Matron (OGN-226) plays "ignoring its cost" exactly as this card
  //     does, so the payment argument does not touch her. She stays because she
  //     is a UNIT: her choice belongs to a triggered ability on the chain rather
  //     than to a spell being finalized, which is the separate held-trigger
  //     divergence.

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
  /**
   * Vanguard Armory's "(You may play them to different locations.)" — asked once
   * per token, with `count` counting down.
   *
   * The ability itself is in `activated-abilities.ts`; only the question lives
   * here, which is the same split `OGN-242-banish` above already has and for the
   * same reason: an activated ability belongs to that registry, and a decision
   * belongs to its card's domain file.
   *
   * **Why a question rather than a fan-out.** Three independent destinations is a
   * CROSS PRODUCT — 4³ candidate actions on a board with three controlled
   * battlefields — so enumerating it would put 64 near-identical activations in
   * front of the AI for one 7-Energy gear. Asked one at a time it is one action
   * and at most three cheap questions, and it re-parks itself exactly the way
   * `OGN-230-spend` below does. Terminates on the count rather than on the board:
   * every answer places a token and decrements, and nothing an answer does can
   * add to it.
   *
   * **The destinations are the ones a token may be PLAYED to**: base, or a
   * battlefield its controller CONTROLS. That is Recruit the Vanguard's rule,
   * asked through the same `mayPlayUnitAt` gate (Rockfall Path bars a
   * destination for both players) — deliberately stricter than the Unit
   * direct-deploy check, which accepts mere presence.
   *
   * With no controlled battlefield the list is one option long and
   * `advanceDecisions` executes it without ever showing it, so the ordinary case
   * costs the player nothing.
   */
  "SFD-168-place": {
    prompt: (state, d) => `Vanguard Armory: where does Recruit ${vanguardTokenOrdinal(d)} go?`,
    options: (state, d) => [
      { id: "base", label: "Your base" },
      ...state.battlefields
        .filter((bf) => bf.controllerId === state.players[d.playerIndex].id && mayPlayUnitAt(state, bf.id))
        .map((bf) => ({ id: bf.id, label: bf.name })),
    ],
    resolve: (state, d, optionId) => {
      const destination: TokenDestination = optionId === "base" ? "base" : { battlefieldId: optionId };
      const placed = placeRecruitToken(state, d.playerIndex, destination);
      const remaining = (d.count ?? 1) - 1;
      // Onto the FRONT, so the three placements stay one instruction — anything
      // else queued was raised later. `repeatDecision`'s own note.
      return remaining > 0 ? repeatDecision(placed, { ...d, count: remaining }) : placed;
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
      // is illegal (702.2.b.1), so an unpayable answer must not channel — the payoff
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
    // dropped as moot (055).
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
      // `forceMoveToBattlefield`, not the Move ACTION: 414.3.a makes the exhaust
      // part of a Standard Move's cost rather than of moving, and this is a
      // Game Effect moving them (316.7.b) — so the tokens arrive as they were.
      // It applies Contested for their controller (450), which is what makes
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
  /**
   * Ultrasoft Poro's placement, asked once per Bird with `count` counting down.
   *
   * **Why a question rather than a fan-out**, which is Vanguard Armory's
   * (`SFD-168-place`) reasoning and applies here even more sharply: `legal-actions`
   * has NO axis on which to fan a destination out for a target-less activated
   * ability. Its activation enumerator pushes a `{ kind: "none" }` mode with no
   * extra fields at all, and `destinationBattlefieldId` is only ever added on the
   * `movesTarget` branch, which needs a chosen unit. So an ability that places
   * tokens somewhere the player picks can only ask.
   *
   * The destinations are the ones a unit may be PLAYED to — 355.2.a: "By default,
   * Valid locations include the controller's Base or a Battlefield the controller
   * controls" — asked through the same `mayPlayUnitAt` gate Vanguard Armory uses,
   * so Rockfall Path bars a destination here too.
   *
   * "You may play them to different locations" is not printed on this card, but
   * asking per token is what 355.2 requires anyway: each Bird is its own play
   * with its own location choice.
   *
   * With no controlled battlefield the list is one option long and
   * `advanceDecisions` executes it without ever showing it, so the ordinary case
   * costs the player nothing. Terminates on the count, not on the board: every
   * answer places a Bird and decrements, and nothing an answer does can add to it.
   */
  "UNL-160-place": {
    prompt: (state, d) =>
      `Ultrasoft Poro: where does Bird ${ULTRASOFT_PORO_BIRDS - (d.count ?? 1) + 1} of ${ULTRASOFT_PORO_BIRDS} go?`,
    options: (state, d) => [
      { id: "base", label: "Your base" },
      ...state.battlefields
        .filter((bf) => bf.controllerId === state.players[d.playerIndex].id && mayPlayUnitAt(state, bf.id))
        .map((bf) => ({ id: bf.id, label: bf.name })),
    ],
    resolve: (state, d, optionId) => {
      const destination: TokenDestination = optionId === "base" ? "base" : { battlefieldId: optionId };
      const placed = placeToken(state, d.playerIndex, destination, BIRD_TOKEN);
      const remaining = (d.count ?? 1) - 1;
      // Onto the FRONT, so the two placements stay one instruction — anything
      // else queued was raised later. `repeatDecision`'s own note.
      return remaining > 0 ? repeatDecision(placed, { ...d, count: remaining }) : placed;
    },
  },
  /**
   * Divining Shells' `[Vision]` — "look at the top card of your Main Deck. You
   * may recycle it."
   *
   * The recycle is `applyVision`'s, reproduced rather than called because that
   * function is module-private to `unit-triggers.ts`: the top card goes to the
   * BOTTOM of the deck, and declining changes nothing at all.
   *
   * Both options always exist while the deck is non-empty, so this is a real
   * question and `advanceDecisions` never auto-answers it. The self-trigger that
   * raises it already refuses an empty deck.
   *
   * The card is NAMED in the label. The whole point of a look is that the player
   * sees what they are deciding about, and a prompt reading "recycle it?" with no
   * "it" is the one thing that makes this question unanswerable.
   */
  "UNL-161-predict": {
    prompt: (state, d) => `Divining Shells: ${state.players[d.playerIndex].deck[0]?.name ?? "your top card"} — recycle it?`,
    options: (state, d) => [
      { id: "keep", label: `Keep ${state.players[d.playerIndex].deck[0]?.name ?? "it"} on top` },
      { id: "recycle", label: `Recycle ${state.players[d.playerIndex].deck[0]?.name ?? "it"}` },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "recycle") return state;
      const actor = state.players[d.playerIndex];
      if (actor.deck.length === 0) return state;
      const [top, ...rest] = actor.deck;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...actor, deck: [...rest, top!] };
      return { ...state, players };
    },
  },
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

/**
 * The units in a player's trash Undying Loyalty may play — "cost no more than
 * [2] and no more than [rainbow]".
 *
 * `powerCost <= 1` rather than a domain check, for `matronPlayableFromTrash`'s
 * reason: a rainbow pip is any domain, so what is bounded is how MANY Power the
 * card costs, not which colour. Read off the PRINTED cost, which is what a
 * "costing no more than" filter asks (the rules' Defy example).
 *
 * ONE walk for the resolve-time "is there anything to offer" test and for the
 * option list, so the two cannot disagree about what is within the ceiling —
 * `glascCandidates`' reason exactly.
 */
function loyaltyCandidates(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return state.players[playerIndex].trash.filter(
    (c): c is UnitInstance =>
      c.kind === "Unit" && c.energyCost <= LOYALTY_MAX_ENERGY && c.powerCost <= LOYALTY_MAX_POWER,
  );
}

/**
 * The units `playerIndex` has standing at ONE battlefield — Atakhan's "here".
 *
 * Deliberately not `ownUnits` filtered afterwards: that walk flattens the whole
 * board and loses which battlefield each unit came from, which is the only thing
 * this question is about.
 */
function unitsAtFor(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return [...(bf?.units[state.players[playerIndex].id] ?? [])];
}

/**
 * Writes a granted tag onto the live unit, wherever it stands — Ivern - Friend to
 * All's "I gain that tag".
 *
 * Both zones and BOTH players' lists, for the reason Draven - Audacious'
 * `rememberCombatWinScored` walks the same way: the question is answered a
 * response window after he arrived, and he can have been moved (or taken control
 * of) in between. A walk of the caster's base alone would have written nothing on
 * exactly the boards where it mattered.
 *
 * Idempotent on the tag — a unit that already prints it (nothing in this pool does
 * for Ivern, but an Experimental Hexplate wearer prints "Mech" the same way) does
 * not get a duplicate entry, since `includes` is what every reader asks and a
 * second copy would only be visible as a longer array.
 *
 * # It SURVIVES into the trash, and that is a recorded divergence
 *
 * `completeDeath` files the very instance into `trash` (clearing only `buffed`),
 * so a dead Ivern still carries the tag he was given. The rules make a card in a
 * non-Board zone a new object with only its printed characteristics, and this
 * engine has exactly one reader that could be fooled by the difference:
 * `starhoundCandidates` above, whose "a Bird, Cat, Dog, or Poro from your trash"
 * would return a dead Ivern it should not. `loyaltyCandidates` cannot — its
 * ceiling is 2 Energy and he costs 6 — and `effectiveTagsOf` is a board-only
 * reader by its own note. Undoing the write would mean a hook in `completeDeath`,
 * which is `effect-helpers.ts`. Pinned by a test.
 */
function grantTagToUnit(state: GameState, unitInstanceId: string, tag: string): GameState {
  const grant = (u: UnitInstance): UnitInstance =>
    u.instanceId === unitInstanceId && !u.tags.includes(tag) ? { ...u, tags: [...u.tags, tag] } : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(grant) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(grant);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * "If your units have ALL of the following tags among them — Bird, Cat, Dog, and
 * Poro" — Ivern - Friend to All's scoring condition.
 *
 * `friendshipTagCount` in effects/calm.ts is the same count read the other way
 * (Friendship pumps by how many of the four it finds); this asks for all four. A
 * deliberate duplicate rather than a shared helper, for the one-file-one-owner
 * reason `otherFriendlyUnitsDiedWith` above records.
 *
 * "AMONG YOUR UNITS" is the LISTENER's controller's units wherever they stand
 * (`ownUnitsEverywhere`) — the card names no location, so a Poro sitting at home
 * counts exactly as one standing in the fight. Ivern himself is among them, which
 * is the point of the first clause.
 *
 * Through `effectiveTagsOf` rather than `unit.tags`, so a tag granted by an
 * Equipment counts as a printed one does. Nothing in this pool grants one of these
 * four that way today (only "Mech"), so the two readings agree — the shared reader
 * is what keeps them agreeing, and it is what makes Ivern's own granted tag and a
 * printed Poro indistinguishable here, which the card requires.
 */
function hasEveryPetTag(state: GameState, playerIndex: 0 | 1): boolean {
  const mine = ownUnitsEverywhere(state, playerIndex);
  return PET_TAGS.every((tag) => mine.some((u) => effectiveTagsOf(state, u).includes(tag)));
}

/** How deep Rift Herald looks — "the top 3 cards of your Main Deck". */
const HERALD_LOOK = 3;

/**
 * The units in a player's HAND that Rift Herald's `[Deathknell]` can actually put
 * into play — "ignoring its Energy cost. (You must still pay its Power cost.)"
 *
 * ONE walk for the fire-time "is there anything to offer" test, for the option
 * list and for the answer, so the three cannot disagree — `glascCandidates`' and
 * `starhoundCandidates`' reason exactly. A unit whose Power cannot be paid is not
 * offered at all, because the instruction is MANDATORY: offering it would mean
 * "play this", answered, and then nothing happening.
 *
 * The Power is read off the PRINTED cost. That is what a card played by another
 * card's instruction pays — the rules' Defy example says such an effect "always
 * uses its printed or copied cost" — and it is also all a card in hand has.
 */
function heraldPlayable(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return state.players[playerIndex].hand.filter(
    (c): c is UnitInstance => c.kind === "Unit" && payPrintedPower(state, playerIndex, c) !== undefined,
  );
}

/**
 * Pays a unit's printed Power cost, or `undefined` when it cannot be paid — the
 * contract `payPowerFromChanneled` and `spendBuff` already use, so an unpayable
 * cost withholds the payoff instead of handing it over free.
 *
 * A zero Power cost is payable and costs nothing; it is short-circuited rather
 * than passed through as `count: 0`, because `powerDomain` is null exactly when
 * the cost is 0 and null means RAINBOW to that helper — asking it for zero rainbow
 * runes works only by accident of the arithmetic. effects/chaos.ts's
 * `payUnitPowerCost` records the same trap for the trash-side cards.
 */
function payPrintedPower(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState | undefined {
  if (card.powerCost <= 0) return state;
  return payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost);
}

/** What one of Rift Herald's offers costs, said in the label — the Energy is
 *  ignored and the Power is not, and a player choosing between two units needs to
 *  see which. */
function heraldLabel(card: UnitInstance): string {
  return card.powerCost <= 0
    ? `Play ${card.name} (free)`
    : `Play ${card.name} (pay ${card.powerCost} ${card.powerDomain ?? "any"} Power)`;
}

/** Every unit a player has in play, base and battlefields alike. */
function ownUnits(state: GameState, playerIndex: 0 | 1) {
  const actor = state.players[playerIndex];
  return [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
}

/**
 * "Were there OTHER friendly units here?" — Loyal Poro's reminder text, and the
 * rules' Special Terms definition read the other way round: *"A unit is alone
 * when there are no other friendly units at the same location."*
 *
 * LOCATION, not battlefield, so a death in base asks about the base — 355.9.a.1's
 * bare-noun reading, and a Base is a place on the Board like any other. A Poro
 * that dies at home surrounded by its friends did not die alone, so it draws.
 *
 * "OTHER friendly" needs no self-exclusion: `completeDeath` files the corpse in
 * the trash BEFORE the `[Deathknell]` is held, so the dying unit is already gone
 * from whatever this counts.
 *
 * A deliberate duplicate of `noOtherFriendlyUnitsAt` in effects/calm.ts — see
 * the UNL-156 entry for why it is not shared. The two are inverses, and they are
 * pinned together by the fact that both cards' tests assert the mutual-wipe case
 * that only `capture` gets right.
 */
function otherFriendlyUnitsDiedWith(state: GameState, ownerIndex: 0 | 1, battlefieldId: string | undefined): boolean {
  if (battlefieldId === undefined) return state.players[ownerIndex].baseUnits.length > 0;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return (bf?.units[state.players[ownerIndex].id] ?? []).length > 0;
}

/** The buffed units a player controls — Albus Ferros' spendable buffs. Rule 702.2.b.2
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

/**
 * Activated abilities contributed by this domain file.
 *
 * **The seam matters as much as the contents.** `ACTIVATED_ABILITIES` was
 * module-private in `activated-abilities.ts`, so a domain file could not register
 * an activated ability AT ALL — the wave-1 agents refused UNL-026 and UNL-093 on
 * exactly that, and every future card with a printed "[cost]: do something"
 * would have hit the same wall or been written into the shared file that the
 * fan-out rule keeps agents out of.
 *
 * Merged lazily by `activated-abilities.ts`, through the same `mergeRegistries`
 * that throws on a duplicate defId — so a card registered both here and in the
 * built-in table is a named error at import, not a silent last-write-wins. That
 * throw is load-bearing for `UNL-158` below, which is an Equipment: had
 * `parseEquipCost` matched its printed cost, `equipAbilities()` would already
 * hold that key and this file would fail to import rather than shadow it.
 *
 * ---- XP AS AN ACTIVATION COST, and why it is paid in `resolve` here ----
 *
 * `ActivationCost` has no `xp` field, and two cards in this wave print one
 * (`UNL-158`'s `[Equip] — Spend 1 XP`, `UNL-162`'s `Spend 2 XP:`).
 * `docs/xp-and-unl-keywords-scope.md` plans that field, and it is the right
 * eventual home — but it lives in `activated-abilities.ts`, which this wave does
 * not own, and its readers (`canPayActivationCost`, `payActivationCost`) are
 * there too.
 *
 * So the price is taken through the two hooks that ARE available to a domain
 * file, and the split is exact rather than approximate:
 *
 *   - `availableWhile` asks `canSpendXp`. Both the enumerator and the validator
 *     reach it through `canPayActivationCost`, so the ability is never offered
 *     to a player who cannot pay — which is the whole job of a cost's
 *     affordability check, and is what `canSpendXp`'s own doc comment says it
 *     exists for ("the question the play enumerator and the activation offer
 *     both have to ask BEFORE offering the option").
 *   - `resolve` calls `spendXp`, whose `undefined` return is treated as a
 *     refusal rather than a free effect.
 *
 * **The one thing that would make this wrong is a gap between announcing and
 * resolving, and there is none**: `execute-activate-ability` pays the cost and
 * calls `mode.resolve` in the same synchronous action — its own comment says so
 * ("An ability's effect runs inline rather than on the chain"). Nothing can
 * change a player's XP in between. Measured by reading that executor, not
 * assumed.
 *
 * What it is NOT: a cost that `payActivationCost` can price. When the shared
 * field lands, both entries below should move onto it and lose their
 * `availableWhile`.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "VEN-125": {
    // Hungry Wolf — "[Order]: Ready me and give me +1 [Might] this turn. Use only
    // if you've chosen an enemy unit this turn and only once each turn."
    //
    // # No exhaust, and that is the card
    //
    // The ability READIES him, so `cost` names only the Power. An exhaust would
    // make readying himself a no-op with extra steps — he would exhaust to pay and
    // then ready, ending exactly where he started. Vi - Destructive's entry
    // records the same absence for the same reason.
    //
    // # "Only ONCE each turn" is `modesOncePerTurn`, not an exhaust
    //
    // Azir - Emperor's precedent: a single implicit mode with the per-source
    // record (`abilityModesUsedThisTurn`), which `runEnd` already clears for every
    // unit. An exhaust cannot express it here at all, since the ability's payload
    // is a ready.
    //
    // # "Use only if" is a restriction on ACTIVATING
    //
    // So it is `availableWhile` and not a guard inside the resolver: a resolver
    // that refused would already have taken the Power, and the player would have
    // paid for nothing. Both the enumerator and the validator reach it through
    // `canPayActivationCost`, so the ability cannot be offered and then refused.
    //
    // `enemyChoicesThisTurn` is the counter, and it is Ezreal - Prodigal
    // Explorer's — counted at the two ANNOUNCE sites, one per CHOICE rather than
    // one per card, and ENEMY-only. Reusing it rather than adding a second counter
    // is what stops the two cards disagreeing about what choosing is.
    kind: "Unit",
    cost: { power: { domain: "Order", count: 1 } },
    modesOncePerTurn: true,
    // "Ready ME and give ME" — no target to choose.
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) =>
      state.players[playerIndex].enemyChoicesThisTurn >= HUNGRY_WOLF_CHOICES_NEEDED,
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(readyUnit(state, sourceInstanceId), ctx.casterIndex, sourceInstanceId, HUNGRY_WOLF_MIGHT),
  },
  "UNL-158": {
    // Shepherd's Heirloom, second clause — "[Equip] — Spend 1 XP. (Pay the cost:
    // Attach this to a unit you control.)"
    //
    // **The one Equipment of the pool's 36 that does not self-wire**, which is
    // why it needs an entry at all: `parseEquipCost` requires a `:rb_rune_*:` in
    // the printed cost, this card prints XP instead, so `def.equipCost` is
    // undefined and `equipAbilities()` generates nothing for it. Its +2 Might
    // badge is already in `card-loader`'s EQUIP_MIGHT_BONUS and needs nothing
    // here.
    //
    // **818.1.c.3 is what makes an XP price legal rather than a data oddity**:
    // "Equip costs may include both resource costs and NON-RESOURCE costs." And
    // 818.1.c.2 gives the shape this entry is: "Equip is functionally short for
    // '[Cost]: Attach this gear to a unit you control.'" — an activated ability,
    // which is exactly the table it is written into.
    //
    // Everything else is `equipAbilities()`'s generated shape, copied
    // deliberately so the two cannot behave differently: the same targeting, the
    // same `attachEquipment(state, casterIndex, sourceInstanceId, target)`, and
    // the same absence of an exhaust — the printed reminder is "Pay the cost:
    // Attach this to a unit you control", and an exhaust nobody printed would
    // make every Equipment a once-per-turn attach. Re-equipping is legal, and
    // here it costs another XP each time, which is what makes it terminate.
    kind: "Gear",
    cost: {},
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    availableWhile: (state, playerIndex) => canSpendXp(state, playerIndex, HEIRLOOM_XP),
    resolve: (state, ctx, event, sourceInstanceId) => {
      if (event.targetUnitInstanceId === undefined) return state;
      const paid = spendXp(state, ctx.casterIndex, HEIRLOOM_XP);
      // `availableWhile` already refused an unaffordable activation, so this is
      // unreachable — and it is written out rather than asserted because a silent
      // free attach is the failure mode a cost helper's `undefined` exists to
      // prevent.
      if (paid === undefined) return state;
      return attachEquipment(paid, ctx.casterIndex, sourceInstanceId, event.targetUnitInstanceId);
    },
  },
  "UNL-160": {
    // Ultrasoft Poro — "[Exhaust]: Play two 1 [Might] Bird unit tokens with
    // [Deflect]. Use this ability only while I'm at a battlefield."
    //
    // "USE ONLY WHILE" is a restriction on ACTIVATING, so it is `availableWhile`
    // and not a guard in the resolver — a resolver that refused would already
    // have taken the exhaust and the player would have paid for nothing. The same
    // predicate Xerath - Freed (UNL-026) uses, and it asks `ownerIndex` as well as
    // presence so a unit the opponent somehow controls at a battlefield is not
    // this player's to activate.
    //
    // **The destination is a QUESTION, not part of the ability.** The card names
    // no location, so 355.2 applies — "For Units, choose a valid Location where
    // that Unit will enter upon being Played", with 355.2.a's default of the
    // controller's Base or a Battlefield they control. `legal-actions` cannot
    // fan that out for a target-less activation (see `UNL-160-place`), so it is
    // asked once per Bird.
    //
    // The tokens do NOT go automatically to the Poro's battlefield. That reading
    // is tempting because the ability is gated on being there, but "here" is not
    // printed, and Carrion Dredger — the other Bird-maker in this file — shows
    // this set does print a destination when it means one ("to your base").
    kind: "Unit",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      findUnitOnBattlefield(state, sourceInstanceId)?.ownerIndex === playerIndex,
    resolve: (state, ctx) =>
      parkDecision(state, { kind: "UNL-160-place", playerIndex: ctx.casterIndex, count: ULTRASOFT_PORO_BIRDS }),
  },
  "UNL-161": {
    // Divining Shells, second clause — "[Action][>] Kill this, [Exhaust]: Give a
    // unit +2 [Might] this turn." (Its `[Vision]` is in `selfTriggers` above.)
    //
    // BOTH halves of the cost are declared. `killSelf` is what makes it once and
    // only once, and `exhaust` is not redundant on top of it: `canPayActivationCost`
    // refuses an exhausted source, so a Divining Shells that has already been
    // exhausted by something else cannot be cashed in. `payActivationCost` runs
    // the kill first and the exhaust last, and `exhaustActivated` is a map over
    // the zones — so exhausting a gear that is already in the trash is a no-op
    // rather than a throw. Checked, not assumed.
    //
    // `killSelf` routes through `killGear`, so being spent as a cost is still
    // being killed — the gear reaches the trash and its own "when I am killed"
    // self-trigger (it has none) would fire.
    //
    // "A UNIT", not "a unit at a battlefield", so `scope: "anywhere"` on 355.9.a.1's
    // bare noun, and no `owner` — pumping an enemy is a bad play, not an illegal
    // one. Same reading Smoke Screen and Orb of Regret already get.
    //
    // `[Action]` needs nothing: `validate-activate-ability` applies no timing
    // check to any activation, a standing permissiveness recorded in that file.
    kind: "Gear",
    cost: { killSelf: true, exhaust: true },
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, DIVINING_SHELLS_MIGHT) : state,
  },
  "UNL-162": {
    // Enthralling Protector, second clause — "Spend 2 XP: [Buff] me." (Its
    // `[Hunt]` is the keyword's generic listener in triggers.ts, which is where
    // the XP to spend comes from.)
    //
    // **No exhaust**, because none is printed — the same call `equipAbilities`
    // makes for an `[Equip]` cost and Ezreal - Dashing's for his Power one. What
    // bounds it is the XP: every activation spends 2 and nothing here makes any,
    // so it terminates on the resource rather than on a cost this engine added.
    //
    // `[Buff] me` is `addBuff` on the source, and 702.3.a already makes a second
    // buff on a buffed unit a no-op — which is the card's own reminder text ("if
    // I don't have one"). The XP is still spent for that no-op, and that is
    // correct: 416 pays a cost when the ability is used, not when its effect
    // turns out to matter.
    //
    // See this table's doc comment for why the 2 XP is taken in `resolve` behind
    // an `availableWhile` rather than as an `ActivationCost`.
    kind: "Unit",
    cost: {},
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => canSpendXp(state, playerIndex, ENTHRALLING_PROTECTOR_XP),
    resolve: (state, ctx, _event, sourceInstanceId) => {
      const paid = spendXp(state, ctx.casterIndex, ENTHRALLING_PROTECTOR_XP);
      if (paid === undefined) return state;
      return addBuff(paid, sourceInstanceId);
    },
  },
};


/** Galio - Indefatigable — "[Deflect] [Tank] I don't deal combat damage." Only
 *  the third sentence is written below; the two keywords are the engine's own.
 *
 *  **Declared ABOVE the table, not beside its siblings at the foot of the file**:
 *  `defId` is evaluated when this module initialises, so a `const` below it is in
 *  the temporal dead zone and every import of effects/index.ts throws with
 *  "Cannot access 'GALIO_INDEFATIGABLE' before initialization". Measured, not
 *  guessed — that is what the first run of this entry did. */
const GALIO_INDEFATIGABLE = "UNL-171";
/** Big enough that no sum of printed Might, auras, buffs, Equipment badges and
 *  this-turn pumps in this pool can survive it, so `effectiveMight`'s closing
 *  `Math.max(0, m)` always lands on 0 (143.2.b). Not a Might value — a floor
 *  expressed in the one arithmetic this seam has. */
const NO_COMBAT_DAMAGE_PENALTY = 1000;

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
export const mightModifiers: Record<string, MightModifier> = {
  [KENNEN]: {
    // Kennen, Keeper of Balance — "While there's a STUNNED ENEMY unit HERE, I have
    // +2 [Might]." The third of his three clauses; the other two are the paired
    // stun offer in `unitTriggers` and `eventTriggers` above.
    //
    // A CONTINUOUS ability, so it is a Might modifier rather than a trigger: it
    // turns on and off with the board, and a stunned enemy that dies mid-combat
    // takes the +2 with it. A this-turn pump could not do that, and would also
    // survive the Stun expiring in the end-of-turn cleanup (423).
    //
    // **"HERE" is positional**, so a Kennen in base gets nothing however many
    // stunned enemies stand elsewhere — the same reading Garen - Commander's aura
    // and every other "here" in this file take. `ctx.battlefieldId` is the
    // location being asked about, which is how a Might context says where the
    // unit is standing.
    //
    // **"ENEMY" is measured from HIS controller**, not from whoever is asking:
    // `ownerIndex` is Kennen's seat, and the opponent's list at that battlefield
    // is what is walked. A stunned unit of his OWN does not pay him.
    //
    // Flat +2 however many stunned enemies are there — "while there's a stunned
    // enemy unit here" is a condition, not a count, which is the difference
    // between this and Ancient Warmonger's `[Assault]`.
    //
    // **The `ctx.battlefieldId === undefined` guard this used to carry was
    // DELETED as unreachable**, after mutation testing showed removing it changed
    // nothing: a context with no battlefield makes the `find` below return
    // `undefined`, and `?? []` already answers 0. Keeping a guard that cannot
    // fail reads as a live branch to the next person and is a line the tests
    // cannot pin. `dealDamage`'s own "did anything happen" check was deleted for
    // the same reason and after the same measurement.
    defId: KENNEN,
    bonus: (state, unit, ownerIndex, ctx) => {
      if (unit.defId !== KENNEN) return 0;
      const enemyId = state.players[ownerIndex === 0 ? 1 : 0].id;
      const enemiesHere = state.battlefields.find((bf) => bf.id === ctx.battlefieldId)?.units[enemyId] ?? [];
      return enemiesHere.some((u) => u.stunned) ? KENNEN_MIGHT : 0;
    },
  },
  "UNL-171": {
    // Galio - Indefatigable, THIRD sentence — "I don't deal combat damage."
    //
    // His other two are already live and neither needed a line: `[Deflect]`'s
    // surcharge is charged off `effectiveKeywords`, and `combat.assignmentOrder`
    // reads `[Tank]` through `hasKeyword`. This sentence was the whole of what was
    // unwritten, and a 3-Energy 6-Might `[Tank]` that also HITS for 6 is a much
    // better card than the printed one — which is why it was left unregistered
    // rather than half-written.
    //
    // # Why this is a Might modifier and not `combat.DEALS_NO_COMBAT_DAMAGE_DEF_IDS`
    //
    // That Set is the canonical home — one line, already holding Ezreal - Dashing
    // (SFD-082) for this exact printed sentence — and a wave-3 agent refused this
    // card on it, correctly as far as it went: `combat.ts` is shared and has no
    // per-domain seam. What the refusal missed is that `mightModifiers` reaches
    // the same arithmetic. `outgoingMight` is the only place a
    // `combatRole: "outgoing"` Might DECIDES anything — swept, and there are
    // exactly two callers: `combat.outgoingMight` (combat.ts:415-416's two damage
    // pools) and `granted-keywords.isMighty`, which takes the HIGHER of the two
    // roles and so can never be lowered by a penalty in one of them.
    //
    // **143.2.b is what makes this exact rather than an approximation**: "If a
    // unit's Might is ever less than 0, it is treated as 0 when referenced by
    // spells and abilities, **and when summing Might to be assigned as damage in
    // the Combat Damage Step**" — and `effectiveMight` ends in `Math.max(0, m)`.
    // So the sum Galio contributes to the pool is 0 and nothing else moves:
    // `remainingMight` is a separate context and is deliberately untouched, so he
    // is no easier to KILL for dealing nothing. That is the same split the Stun
    // rule beside that Set takes (423), and the same one Ezreal's entry records.
    //
    // A SATURATING sentinel rather than a Might value, and it has to be: the sum
    // it must cancel includes auras, Equipment badges and this-turn pumps that a
    // `MightModifier` cannot see from here. Nothing in the four-set pool comes
    // near it — the largest single term is Dr. Mundo - Expert's "+1 for each card
    // in your trash", bounded by a deck. 143.2.b.1 ("although the unit's Might is
    // treated as 0, it is not 0") is why this is safe to be a big number rather
    // than an exact cancellation: the actual value is only consulted by effects
    // that calculate increases and decreases, and this term exists solely in the
    // outgoing-damage context, where no such effect is evaluated.
    //
    // **If `combat.ts` is ever open, delete this entry and add "UNL-171" to that
    // Set instead.** It is the better shape and is behaviour-identical; the test
    // pinning him asserts that he deals 0 and still absorbs 6, not which module
    // says so, so it passes either way.
    defId: GALIO_INDEFATIGABLE,
    bonus: (_state, unit, _ownerIndex, ctx) =>
      unit.defId === GALIO_INDEFATIGABLE && ctx.combatRole === "outgoing" ? -NO_COMBAT_DAMAGE_PENALTY : 0,
  },
};
