import type { DecisionDefinition } from "../decisions.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { TokenDestination } from "../token.js";
import { counterSpell } from "../counter-spell.js";
import { parkDecision } from "../decisions.js";
import { BRUSH, isBrush, replaceBattlefieldWithToken } from "../battlefield-tokens.js";
import {
  channelRunesExhausted,
  dealDamage,
  delayedDeathMark,
  destroyUnit,
  drawCards,
  forgetDelayedDeathMark,
  forceMoveToBattlefield,
  forceMoveToDestination,
  gainXp,
  giveMightThisTurn,
  ownUnitsEverywhere,
  readyUnit,
  recordModeUsed,
  stunUnits,
  withSimultaneousDeaths,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { attackerIndexAt, attackingUnitsAt } from "../combat-designation.js";
import { canonicalDefId } from "../../cards/card-loader.js";
import { eligibleTargets, findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { SAND_SOLDIER_TOKEN, placeToken } from "../token.js";
import {
  ARISE_READY_COUNT,
  LILLIA_ENERGY_COST,
  MASTER_YI_LEVEL,
  MASTER_YI_MIGHT,
  MASTER_YI_WUJU_MASTER,
  SPRITE_TOKEN,
  equipmentControlledBy,
} from "./signature-shared.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Calm**.
 *
 * So a `Calm+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Calm lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

/** Shadow's activated ability prints `[1][rainbow], [Exhaust]:` — one Energy and
 *  one Power pip of any domain. Named separately because they are paid from
 *  different pools and are not interchangeable, the same split `ActivationCost`
 *  keeps between `energy` and `power`. Declared here rather than in
 *  `signature-shared.ts`, which is not this change's file to edit. */
const SHADOW_ENERGY_COST = 1;
const SHADOW_POWER_COST = 1;

/** Vendetta's dual-domain spell block, wave 2 — the two whose first domain in
 *  canonical order is Calm. */
const SIPHONING_STRIKE = "VEN-146";
const SIPHONING_STRIKE_BASE = 4;
const SIPHONING_STRIKE_BIG = 7;
/** "If you control 7 or more runes" — `channeled.length`, the Rune Pool. */
const SIPHONING_STRIKE_RUNES = 7;
const SIPHONING_STRIKE_CHANNEL = 1;
const SHADOW_DASH_PAIR = 2;
const SHADOW_DASH_MIGHT = 1;

/** Siphoning Strike's delayed-death mark. A one-line wrapper over the shared
 *  builder, so the card's own defId is written once and the death-watch at the
 *  bottom of this file cannot key off a different one than the resolver. */
function siphoningStrikeMark(state: GameState, spellInstanceId: string): string {
  return delayedDeathMark(state, SIPHONING_STRIKE, spellInstanceId);
}

/**
 * How much damage would finish this unit off right now — effective Might minus
 * the damage already on it, floored at 1.
 *
 * The floor is **355.14.g**, "valid damage is a positive integer amount, greater
 * than or equal to 1": a unit already at or past lethal (a -[M] effect can put
 * one there without killing it, since 143.2.b only treats the negative as 0 when
 * it is READ) still has to be assigned at least 1 out of the pool, so it cannot
 * be a free kill that costs the split nothing.
 *
 * `undefined` for a unit that is not at a battlefield — either GONE (killed by a
 * sibling's `[Deathknell]` part-way through a split, which is what this answer is
 * really for) or in a BASE, which the split's own walk was already told to
 * exclude. **Measured 2026-08-11: that makes the base rule guarded twice, and
 * neither guard alone is observable** — widening the walk to `scope: "anywhere"`
 * changes no outcome, because a base unit sorts last on `MAX_SAFE_INTEGER` and is
 * then skipped here. Mutating both together does fail the test. Recorded rather
 * than tidied away: the overlap is incidental, and a reader who deletes either
 * one on the strength of a green run would be deleting a live rule.
 *
 * Its own function because the split loop asks it TWICE per unit — once to order
 * the allocations and once to size one — and both must be read against the state
 * as it is at that moment. Volibear - Furious's split re-reads it inside its loop
 * for the same reason, and states it: an earlier kill can take an aura off the
 * board and change what the next unit needs.
 */
function lethalDamageFor(state: GameState, instanceId: string): number | undefined {
  const at = findUnitOnBattlefield(state, instanceId);
  if (!at) return undefined;
  const battlefieldId = state.battlefields[at.battlefieldIndex]!.id;
  return Math.max(1, effectiveMight(state, at.unit, at.ownerIndex, { isCombat: false, battlefieldId }) - at.unit.damage);
}

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-146": {
    // Siphoning Strike (Calm + Mind) — "Deal 4 to a unit at a battlefield. If you
    // control 7 or more runes, deal 7 to it instead. When it dies this turn,
    // channel 1 rune exhausted."
    //
    // # "Instead" is one damage event, not two
    //
    // The amount is picked BEFORE the damage is dealt, so the card deals 4 or 7
    // and never both — which matters for everything that counts damage
    // INSTANCES rather than points (Dancing Grenade's escalation, Affectionate
    // Poro's "have I been dealt damage this turn"). A version that dealt 4 and
    // then 3 more would be two instances and a different card.
    //
    // "You control 7 or more runes" is `channeled.length` — the Rune Pool, the
    // same count Tomb Raider Barbara and Esteemed Hierophant read for the same
    // printed phrase. Read at RESOLUTION, so a rune recycled in the response
    // window drops the card to 4.
    //
    // # "When it dies this turn" is Deadly Flourish's mechanism, not a new one
    //
    // A delayed triggered ability (390.2) that has to outlive the death it
    // watches for. The victim is off the board by the time `completeDeath` fires
    // the event, so the join is a MARK written onto the victim before the damage
    // — `killUnit`'s snapshot (808.1.d.3) carries it into `DeathContext.unit` —
    // and read by a listener sitting in the caster's TRASH, where
    // `execute-play-card` filed this Spell when it was played. The death-watch
    // half is at the bottom of this file; `delayedDeathMark` is shared out of
    // `effect-helpers.ts` because two cards in two files now build the same key.
    //
    // **Marked BEFORE the damage**, because the damage is usually what kills: the
    // whole death funnel runs inside `dealDamage`, and a mark written after it
    // would arrive at an empty board.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (targetId === undefined) return state;
      // 359.3.e: a target that left play in the response window makes both
      // instructions no-ops, and marking a unit that is not there would be an
      // invention rather than a no-op.
      const victim = findUnitAnywhere(state, targetId);
      if (victim === undefined) return state;

      const marked =
        ctx.sourceCardInstanceId === undefined
          ? state
          : recordModeUsed(state, victim.ownerIndex, targetId, siphoningStrikeMark(state, ctx.sourceCardInstanceId));
      const amount =
        state.players[ctx.casterIndex].channeled.length >= SIPHONING_STRIKE_RUNES
          ? SIPHONING_STRIKE_BIG
          : SIPHONING_STRIKE_BASE;
      return dealDamage(marked, ctx.casterIndex, targetId, amount);
    },
  },
  "VEN-148": {
    // Shadow Dash (Calm + Order) — "Move an enemy unit to a battlefield where you
    // have units. If you have exactly two units there, they each get +1 [Might]
    // this turn. [Flow] [5][rainbow][rainbow]"
    //
    // # The destination restriction is measured from the CASTER
    //
    // "Where YOU have units" — the first move restriction in the pool that is not
    // derivable from the moved unit alone, which is why `moveDestinationAllowed`
    // now takes a caster. Temptation's neighbouring set asks about the MOVED
    // unit's controller, which for an enemy unit is the enemy's own board: on a
    // split board the two predicates name disjoint destinations, so reusing it
    // would have let this card send the enemy home.
    //
    // No base destination: the card names a battlefield.
    //
    // # "Exactly two" is counted AFTER the move, and counts only YOURS
    //
    // The enemy that just arrived is not one of "your units", so a battlefield
    // where you have two and they now have one still pays. Counted after the move
    // because that is printed order and because the move is what the sentence is
    // about — and read live off the board rather than from the pre-move count,
    // since a Deathknell fired by the arrival can change it.
    //
    // "THEY each get +1" is your two, not the newcomer. Exactly two, so a third
    // friendly there pays nothing — this is a reward for a specific board shape
    // rather than a scaling pump.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      const destinationId = event.destinationBattlefieldId;
      if (targetId === undefined || destinationId === undefined) return state;
      const moved = forceMoveToBattlefield(state, targetId, destinationId, ctx.casterIndex);

      const battlefield = moved.battlefields.find((bf) => bf.id === destinationId);
      const mine = battlefield?.units[moved.players[ctx.casterIndex].id] ?? [];
      if (mine.length !== SHADOW_DASH_PAIR) return moved;
      return mine.reduce((next, u) => giveMightThisTurn(next, u.instanceId, SHADOW_DASH_MIGHT), moved);
    },
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
    // **`scope: "anywhere"` added 2026-08-23, with Rampage's.** "Move an enemy
    // unit" names no location, and omitting the scope is not neutral:
    // `eligibleTargets` defaults to `"battlefield"`, so a silent spec is
    // NARROWER than a silent card. Charm prints the identical sentence and has
    // carried `scope: "anywhere"` all along — same phrase, two answers, which is
    // how this one was found while fixing Rampage rather than from a report.
    //
    // 355.9.a.1 widens a bare noun to the Board and 198.1 puts the Bases on it.
    // The SECOND slot is unaffected: `secondAtDestination` relates it to where
    // the first is going, and `secondTargetIsAtDestination` — shared by the
    // enumerator and the validator — already works the base-destination case for
    // this exact card.
    targeting: {
      kind: "unitSlots",
      slots: ["enemy", "enemy"],
      min: 2,
      asymmetricSlots: true,
      secondAtDestination: true,
      scope: "anywhere",
    },
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
      withSimultaneousDeaths(state, (inBatch) =>
        (event.targetUnitInstanceIds ?? []).reduce((next, id) => destroyUnit(next, id), inBatch),
      ),
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
    resolve: (state, ctx, event) => {
      if (!event.targetChainCardInstanceId) return state;
      // The countered spell's CONTROLLER is read off the chain entry before the
      // counter clears it — afterwards there is nothing left to ask.
      const entry = state.spellChain.find(
        (e) => "card" in e && e.card.instanceId === event.targetChainCardInstanceId,
      );
      const victim = entry !== undefined && "playerIndex" in entry ? entry.playerIndex : ctx.opponentIndex;
      const countered = counterSpell(state, event.targetChainCardInstanceId);
      // **"Its controller can't play spells this turn."** Armed here rather than
      // as a continuous ability, so it survives the Lullaby leaving play — a ban
      // on the turn, not on the card, exactly as Brynhir Thundersong's is.
      const players = [...countered.players] as [PlayerState, PlayerState];
      players[victim] = { ...players[victim], cannotPlaySpellsThisTurn: true };
      return { ...countered, players };
    },
  },
  "UNL-192": {
    // Alpha Strike (Calm + Body) — "[Action] Choose a friendly unit. It deals
    // damage equal to its Might split among enemy units at battlefields. Then for
    // each unit this kills, do this: Gain 1 XP."
    //
    // # The PDF works this card by name, under 355.14 "Splitting"
    //
    // Its worked example is Alpha Strike itself, and it settles three things that
    // would otherwise have been guesses: each unit the damage is split among is
    // TARGETED (355.14.a), the number of them is capped at the damage available
    // (355.14.c), and each must receive at least 1 (355.14.g). The loop below
    // honours all three — it never assigns 0, so it can never reach more units
    // than there is damage to spend.
    //
    // # The friendly unit is CHOSEN; the split targets are NOT — a divergence
    //
    // 355.14.b puts the split targets on the announcement, alongside the friendly
    // unit, and this engine cannot express that: `TargetingSpec` has no kind that
    // crosses a single `unit` with a `unitList`, and widening it is a change to
    // card-effects.ts plus the enumerator and validator that read it. So the
    // caster names the unit that swings and the ENGINE allocates its Might. That
    // is Volibear - Furious's split exactly (unit-triggers.ts, OGN-041), which is
    // this pool's only other "split among", and it is recorded in
    // docs/rules-conformance.md as an auto-selection rather than a rules reading.
    //
    // The cost is visible: an opponent gets no window to respond to the split
    // being aimed, and `[Deflect]` is never surcharged for a unit the split
    // reaches, because nothing announces choosing it.
    //
    // # CHEAPEST-LETHAL FIRST, not board order — and Volibear's order was rejected
    //
    // Volibear takes the enemies in board order and gives each exactly what kills
    // it. That is arbitrary between equally-good enemies, and his card gives no
    // reason to prefer one. **This card prints its own objective**: "for each unit
    // this kills, gain 1 XP" pays per BODY, so the allocation that maximises kills
    // is the one that reads the card. Sorting by what each unit needs and paying
    // the cheapest first is optimal for that (it is the greedy that maximises how
    // many items fit a fixed budget), where board order is not — three enemies of
    // 3, 2 and 2 Might under a 4-Might swing kill one in board order and two here.
    //
    // Still a choice a player might not make (finishing one big blocker instead of
    // two small ones is a real play), so it is Unverified in the same row as the
    // auto-selection above rather than claimed as the rules' answer.
    //
    // # What is read when
    //
    // The Might is read at RESOLUTION through `effectiveMight`, so a pump or an
    // aura in the response window makes the swing bigger — the PDF's own example
    // for this card turns on exactly that, an opponent shrinking the chosen unit
    // with Frigid Touch after it was named. A unit that is GONE by then deals
    // nothing (359.3.e.12) and the spell gains no XP.
    //
    // The targets come from `eligibleTargets(..., "enemy", "battlefield")` — the
    // same shared walk the announce path uses, so a unit an opponent may not
    // choose (Ruin Runner) is left out of the split for the same reason it would
    // be left out of a targeting fan-out, and "at battlefields" excludes both
    // bases without this file rewriting the scan.
    //
    // # DIVERGENCE: Bonus Damage is applied per HIT, not once to the pool (715.3)
    //
    // "If the Deal action Splits damage, then the Bonus Damage applies to the
    // amount of Damage that will be Split. This can alter the number of targets
    // eligible to be chosen" — and the PDF works that with Volibear, whose 5
    // becomes a 6 to be split. Here the pool is the raw Might and each allocation
    // then picks the bonus up separately inside `dealDamage`, which is the only
    // funnel that knows about Annie - Fiery, Ravenborn Tome, Rabadon's Deathcrown
    // and Void Gate. So with a Bonus Damage source out, the split reaches one
    // target FEWER than the rules allow and each unit it does reach is overkilled
    // by the bonus.
    //
    // Not corrected by pre-subtracting the bonus from each `hit`: the modifier is
    // battlefield-dependent (Void Gate) and additive only by today's accident, so
    // inverting it here would be a second, silently-drifting copy of
    // `modifiedDamageAmount`'s arithmetic living in one card. Volibear - Furious
    // has the identical gap; the fix for both is a split-aware entry point on the
    // damage funnel, which is not this file's to add. Recorded in
    // docs/rules-conformance.md.
    //
    // # "For each unit THIS kills"
    //
    // Counted per allocation, immediately after the damage that could have caused
    // it: alive before, absent after. A unit already dead when its turn comes —
    // killed by a sibling's `[Deathknell]` inside this same resolution — is
    // skipped and pays nothing, which is the honest reading of "this kills".
    //
    // One `gainXp` call with the total rather than N calls of 1. `gainXp` fires no
    // event and has no per-call side effect beyond `xpGainedThisTurn`, so the two
    // are indistinguishable; the total is written once for the same reason every
    // batch instruction here is (a per-item payout is how this engine has
    // double-paid before).
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const chosenId = event.targetUnitInstanceId;
      if (!chosenId) return state;
      // "A friendly unit" is a bare noun — 355.9.a.1's objects on the Board — so
      // the swinging unit may be standing in base; only its VICTIMS are printed
      // "at battlefields". Located anywhere, therefore, and its Might read in
      // whichever zone it is in.
      const source = findUnitAnywhere(state, chosenId);
      if (!source) return state;
      let remaining = effectiveMight(
        state,
        source.unit,
        source.ownerIndex,
        source.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: state.battlefields[source.zone.battlefieldIndex]!.id },
      );

      // Ordered ONCE, off the board as it stands at resolution — this is the
      // "which units does the split name" question, and 355.14.b asks it once.
      // Each allocation then re-reads what its own unit needs, since the previous
      // kill may have moved it.
      const order = eligibleTargets(state, ctx.casterIndex, "enemy", "battlefield")
        .map((u) => ({ instanceId: u.instanceId, cost: lethalDamageFor(state, u.instanceId) ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.cost - b.cost);

      let next = state;
      let kills = 0;
      for (const { instanceId } of order) {
        if (remaining <= 0) break;
        const lethal = lethalDamageFor(next, instanceId);
        if (lethal === undefined) continue; // died to a sibling's Deathknell, or left
        const hit = Math.min(remaining, lethal);
        next = dealDamage(next, ctx.casterIndex, instanceId, hit);
        // Spent whether or not the damage landed. A prevention (Counter Strike,
        // Unyielding Spirit) REPLACES the instance rather than un-assigning it, so
        // the pool is gone either way — and `dealDamage` is where every one of
        // those lives, which is why the split goes through it per unit rather than
        // doing its own arithmetic.
        remaining -= hit;
        if (!findUnitAnywhere(next, instanceId)) kills += 1;
      }
      return gainXp(next, ctx.casterIndex, kills);
    },
  },
};

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

export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
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
  "UNL-194": {
    // Shadow (Calm + Chaos), SECOND clause — "[Action][>] [1][rainbow],
    // [Exhaust]: [Stun] an enemy unit attacking here."
    //
    // # HALF a card: his FIRST clause is refused, and coverage will not say so
    //
    // "If you play me to a battlefield, I enter ready" is a deploy-time
    // REPLACEMENT, answered by `deploy.unitEntersReady` — a shared file this one
    // does not own, and one whose predicate is handed no destination at all, so
    // "to a battlefield" cannot be asked of it as it stands. Faking it as an
    // on-play `readyUnit` is rejected for the three measured reasons deploy.ts's
    // own comment lists (the unit sits exhausted through the response window, it
    // fires `unitReadied` for a readying the rules say never happened, and
    // Mageseeker Warden can block it). Registration is per defId, so writing this
    // clause reports the card DONE — the missing half is in the report and needs a
    // `coverage.PARTIALLY_IMPLEMENTED` row.
    //
    // # The cost is exactly what is printed
    //
    // `[1]` is Energy and `[rainbow]` is a Power pip of any domain, which is what
    // `power.domain: null` has always meant here (164.2 lets one Ready Basic Rune
    // serve both, since it prints `[E]: Add [1]` and `Recycle this: Add [C]` —
    // the rune double-duty row in docs/rules-conformance.md). Both are re-derived
    // by `validate-activate-ability` from `activationCostOf`, so there is nothing
    // to keep in step by hand.
    //
    // # "ATTACKING HERE", and the DIVERGENCE that gets it exactly right or not at all
    //
    // `TargetingSpec.attackingOnly` is 464.2.c Step 1's Attacker designation and
    // is the whole of "attacking" — but it says nothing about WHERE, and "here" is
    // a referent read from the ability's source (359.3.f.1). No field on
    // `TargetingSpec` relates a target to the source's location, and adding one is
    // a card-effects.ts / target-lookup.ts / legal-actions.ts /
    // validate-activate-ability.ts change this file cannot make.
    //
    // More than one Battlefield can be Contested at once — `cleanup.stage` takes
    // them one at a time and its own comment says "a battlefield stays Contested
    // until a Cleanup can legally stage it" — so `attackingOnly` alone would offer
    // an attacker at a DIFFERENT battlefield, which is stronger than printed.
    //
    // So the restriction is moved onto `availableWhile`, which is the one hook
    // both the enumerator and the validator pass through (`canPayActivationCost`),
    // and it is deliberately ALL-OR-NOTHING: the ability is offered only while
    // every enemy attacker on the board is standing at Shadow's own battlefield.
    // In that state the set `attackingOnly` produces IS "attacking here", exactly.
    // In the rare state where the enemy is attacking somewhere else as well, the
    // ability is simply not available — strictly WEAKER than printed, which is the
    // only direction this codebase ships, and never a target offered then refused.
    //
    // Rejected: filtering in `resolve`. By then the cost is paid, so the player
    // would spend `[1][rainbow]` and an exhaust on nothing.
    //
    // # No referent re-check in `resolve`, and that is measured rather than assumed
    //
    // 359.3.f.2 checks a referent on execution, which would matter if the target
    // could move between announcement and resolution. It cannot:
    // `execute-activate-ability` runs `mode.resolve` INLINE ("an ability's effect
    // runs inline rather than on the chain"), so there is no response window
    // between the two.
    //
    // `[Action]` needs nothing — `validate-activate-ability` applies no timing
    // check to any activation, a standing permissiveness recorded in that file.
    //
    // `availableWhile` carries ONLY that narrowing, and that is deliberate: "is
    // there an enemy attacker here at all" and "is this Shadow mine" both looked
    // like they belonged in it and are done already — the first by `attackingOnly`
    // (an ability with no legal target is not offered), the second by
    // `activateAbilityCandidates`, which walks the actor's own permanents. Both
    // were written, and both SURVIVED mutation; they are gone rather than kept as
    // lines the next reader would take for load-bearing.
    kind: "Unit",
    cost: { energy: SHADOW_ENERGY_COST, power: { domain: null, count: SHADOW_POWER_COST }, exhaust: true },
    targeting: { kind: "unit", owner: "enemy", attackingOnly: true },
    availableWhile: (state, playerIndex, sourceInstanceId) => {
      const at = findUnitOnBattlefield(state, sourceInstanceId);
      // A Shadow in base has no "here" for the referent to point at.
      if (!at) return false;
      const here = state.battlefields[at.battlefieldIndex]!.id;
      const enemyIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
      return !state.battlefields.some(
        (bf) => bf.id !== here && attackerIndexAt(state, bf.id) === enemyIndex && attackingUnitsAt(state, bf.id).length > 0,
      );
    },
    resolve: (state, ctx, event) =>
      // `stunUnits` drops an already-stunned unit before the event exists, so a
      // second Shadow aimed at the same attacker pays and re-stuns nothing — 423's
      // action, not a flag written twice.
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  // # The two Calm LEGENDS this wave refused, recorded beside their signature cards
  //
  // Neither belongs in this table — a Legend's ability lives in
  // `engine/legend-abilities.ts`, a shared file — but Shadow above is Vex's
  // signature card, so this is where the next reader of Vex will actually be.
  //
  // **UNL-193 Vex - Gloomist** — "When you or an ally hold, you may exhaust me to
  // draw 1." A structural CLONE of Renata Glasc - Chem-Baroness's (SFD-201) first
  // clause: the same `onBattlefieldHeld` hook, the same `parkDecision`, the same
  // "an exhausted Legend is not asked" guard, with `drawCards(state, index, 1)`
  // where hers calls `placeGoldTokens`. Two entries in that one file — a
  // `LEGEND_ABILITIES` row and a `legendDecisions` row — and nothing else anywhere.
  //
  // The clone claim was CHECKED rather than repeated: `unl-calm-wave8-refusals.
  // test.ts` fires a real `battlefieldHeld` with each Legend seated and shows
  // Renata parking `SFD-201-gold` where Vex parks nothing. "You or an ALLY" needs
  // no extra work in a two-player game, which is the only mode this engine has.
  //
  // **UNL-195 Ivern - Green Father** — "When you conquer or hold, you may exhaust
  // me to replace that battlefield with a Brush battlefield token." REFUSED
  // systemically: this engine has no way to replace a battlefield, and no Brush
  // exists to replace it with.
  //
  // A wave-7 note said "NO Brush card exists in the pool at all". Measured, that
  // is not quite what the data says and the correction sharpens it: the word
  // appears three times, and all three are Ivern's own printings (UNL-195 and
  // UNL-233's two) telling you to make one. Neither
  // `loadBattlefieldDefinitions()` nor `loadTokenDefinitions()` has a Brush —
  // and UNL prints no Token-supertype cards at all. So the token has no printed
  // source AND no battlefield to become, two independent blocks, and the smaller
  // of them is a data question rather than an engine one.
};

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
      // `canonicalDefId`, because every UNL Legend is printed three times as three
      // distinct ids for one card. The effect registries alias printings at merge
      // time; a literal comparison like this is what that cannot reach, so an
      // Overnumbered Master Yi would have granted nothing.
      canonicalDefId(state.players[ownerIndex].legend.defId) === MASTER_YI_WUJU_MASTER &&
      state.players[ownerIndex].xp >= MASTER_YI_LEVEL
        ? MASTER_YI_MIGHT
        : 0,
  },
};

/** Empty, and deliberately declared: `effects/index.ts` reads every registry
 *  off every module, so a missing export is `undefined` at merge time rather
 *  than an empty table. Declaring them keeps adding a card here to one line.
 */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {
  "VEN-146": {
    // Siphoning Strike's second sentence — "When it dies this turn, channel 1
    // rune exhausted." The first is in `cardEffects` above, which is where the
    // whole card is explained; this end only reads the mark that one wrote.
    //
    // **The listener is a SPELL in a trash**, which is why `TRASH_LISTENER_DEF_IDS`
    // names it: `allListeningPermanents` walks the board plus that set, and this
    // card is in its caster's trash from the moment it was played. Nothing on the
    // board could stand in for it — the victim is gone by the time
    // `completeDeath` fires the event.
    //
    // The mark is read off `death.unit`, the snapshot 808.1.d.3 requires be taken
    // "before the card is moved to the Trash", so this is a fact about the death
    // and settles whether the ability TRIGGERED at all. `state` is the board as
    // the unit died, so the turn half of the key is asked against the turn the
    // death happened on — exactly the printed "this turn".
    //
    // **It fires however the unit died**, not only off this spell's own damage.
    // The card says "when it dies", not "when this kills it", so a victim that
    // survives the 4 and falls in combat later the same turn still pays.
    applies: (state, listener, death) =>
      death.unit.abilityModesUsedThisTurn.includes(siphoningStrikeMark(state, listener.card.instanceId)),
    // The rune goes to the STRIKE's controller — "channel 1 rune exhausted" with
    // no owner word is the ability's controller doing it, and a trash listener's
    // `ownerIndex` is whose trash it is.
    resolve: (state, listener, death) =>
      channelRunesExhausted(
        forgetDelayedDeathMark(
          state,
          death.ownerIndex,
          death.unit.instanceId,
          siphoningStrikeMark(state, listener.card.instanceId),
        ),
        listener.ownerIndex,
        SIPHONING_STRIKE_CHANNEL,
      ),
  },
};
export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "UNL-195": {
    // Ivern - Green Father (Calm + Order) — "When you conquer or hold, you may
    // exhaust me to replace that battlefield with a Brush battlefield token."
    //
    // # A LEGEND registered in a domain file, the shape UNL-183 Rengar landed
    //
    // `Listener.zone` has a `"legend"` case and `listeningPermanents` ends with
    // `owner.legend`, so an entry keyed by a Legend's defId is found by the
    // ordinary listener walk and held as an ordinary Chain Pending Item (383). The
    // `zone === "legend"` check below makes that explicit rather than incidental,
    // the same way Super Mega Death Rocket asserts `zone === "trash"`.
    //
    // # "When you conquer OR HOLD" is two events, and both are the player's
    //
    // A Legend stands at no battlefield, so there is no "here" for this to be at —
    // it is the player's conquest, not a unit's, which is why `applies` compares
    // the event's actor to the listener's owner and never a location. The
    // battlefield the token replaces is "THAT battlefield", so it rides the event
    // rather than being re-derived.
    //
    // # The exhaust is a COST, so it gates the offer
    //
    // "You MAY exhaust me to" — 204.2's optional additional cost shape, and 416.3
    // makes an unpayable cost no option at all. An already-exhausted Ivern is
    // therefore not asked, checked here so the question never reaches the chain
    // rather than being parked and then found empty. Renata Glasc's gold offer in
    // this same file takes the identical guard for the identical reason.
    //
    // A battlefield that is ALREADY a Brush is skipped too: replacing a Brush with
    // a Brush is a cost paid for nothing, and it would overwrite the memory of what
    // the battlefield originally was.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (state, listener, event) => {
      if (listener.zone !== "legend") return false;
      const battlefieldId = ivernBattlefieldFor(listener.ownerIndex, event);
      if (battlefieldId === undefined) return false;
      if (state.players[listener.ownerIndex].legend.exhausted) return false;
      return !isBrush(state, battlefieldId);
    },
    resolve: (state, listener, event) => {
      const battlefieldId = ivernBattlefieldFor(listener.ownerIndex, event);
      if (battlefieldId === undefined) return state;
      if (state.players[listener.ownerIndex].legend.exhausted) return state;
      if (isBrush(state, battlefieldId)) return state;
      return parkDecision(state, {
        kind: IVERN_BRUSH,
        playerIndex: listener.ownerIndex,
        battlefieldId,
      });
    },
  },
};

/**
 * The battlefield THIS player just conquered or held, or undefined when the event
 * is not theirs.
 *
 * One function for both events rather than two branches at each of the two call
 * sites, because `applies` and `resolve` have to agree exactly about which
 * battlefield is meant — and a question parked for one battlefield and resolved
 * against another is the dropped-field shape this repo keeps recording.
 */
function ivernBattlefieldFor(
  ownerIndex: 0 | 1,
  event: { kind: string; conquerorIndex?: 0 | 1; holderIndex?: 0 | 1; battlefieldId?: string },
): string | undefined {
  if (event.kind === "battlefieldConquered" && event.conquerorIndex === ownerIndex) return event.battlefieldId;
  if (event.kind === "battlefieldHeld" && event.holderIndex === ownerIndex) return event.battlefieldId;
  return undefined;
}

/** Ivern's question, named so the trigger and the registry cannot spell it
 *  differently. */
const IVERN_BRUSH = "UNL-195-brush";

export const decisions: Record<string, DecisionDefinition> = {
  [IVERN_BRUSH]: {
    prompt: (state, d) =>
      `Ivern - Green Father: exhaust him to replace ${battlefieldName(state, d.battlefieldId)} with a Brush?`,
    // Declining leads, the convention every "you may" in this engine follows. The
    // offer is withheld — not merely declined — once the cost cannot be paid or the
    // battlefield is already a Brush, both re-checked here because the option list
    // is rebuilt from live state and a response window sits between the trigger and
    // this question.
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(d.battlefieldId !== undefined &&
      !state.players[d.playerIndex].legend.exhausted &&
      !isBrush(state, d.battlefieldId)
        ? [{ id: "brush", label: `Exhaust Ivern and replace ${battlefieldName(state, d.battlefieldId)} with a Brush` }]
        : []),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.battlefieldId === undefined) return state;
      // Re-paid here rather than trusted from the option list, which was built
      // against the state one question ago — the convention `payPowerFromChanneled`
      // and `spendBuff` share. An Ivern exhausted in the window buys nothing.
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return replaceBattlefieldWithToken({ ...state, players }, d.battlefieldId, BRUSH);
    },
  },
};

/** A battlefield's name for a prompt, or a neutral word when it has gone. */
function battlefieldName(state: GameState, battlefieldId: string | undefined): string {
  return state.battlefields.find((bf) => bf.id === battlefieldId)?.name ?? "that battlefield";
}
