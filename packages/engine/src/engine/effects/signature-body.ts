import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import { parkDecision, repeatDecision } from "../decisions.js";
import { mayMoveToBaseFrom } from "../battlefield-continuous.js";
import { findUnitAnywhere } from "../target-lookup.js";
import {
  addBuff,
  canSpendXp,
  dealDamageToEnemyUnitsAtBattlefield,
  drawCards,
  fileIntoNonBoardZone,
  forceMoveToBase,
  forceMoveToBattlefield,
  gainXp,
  giveMightThisTurnToOwnUnit,
  ownUnitsEverywhere,
  readyUnit,
  removeUnitAnywhere,
  spendXp,
} from "../effect-helpers.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Body**.
 *
 * So a `Body+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Body lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

/** Kha'Zix - Voidreaver's "When you win a combat, gain 1 XP." */
const KHAZIX_COMBAT_XP = 1;
/** ...and his "Spend 1 XP, [Exhaust]: [Buff] a unit." */
const KHAZIX_BUFF_XP = 1;
/** ...and his third clause, "Spend 2 XP, [Exhaust]: Move an exhausted friendly
 *  unit from a battlefield to its base" — written 2026-08-12, once
 *  `ActivationCost.xp` landed. See his `activatedAbilities` entry. */
const KHAZIX_MOVE_HOME_XP = 2;

/** Poppy - Keeper of the Hammer's "When you hold, gain 1 XP." */
const POPPY_HOLD_XP = 1;
/** ...and her "Spend 3 XP, [Exhaust]: Draw 1." */
const POPPY_DRAW_XP = 3;

/**
 * Keeper's Verdict's "its owner places it on the top or bottom of their Main
 * Deck" — written once because the resolver that raises the question and the
 * decision that answers it must agree, and a typo in either would be SILENT: a
 * parked question nothing implements throws, but a MISMATCHED pair would park
 * one key and register another, which reads as a spell that chose a unit and
 * then did nothing.
 */
const KEEPERS_VERDICT_PLACEMENT = "UNL-204-place";

/** The two answers Keeper's Verdict prints, in printed order. */
type DeckEnd = "top" | "bottom";

/**
 * Takes a unit off the board and files its card at one end of its OWNER's Main
 * Deck — the whole of Keeper's Verdict's second sentence.
 *
 * **Not `recycleUnitFromPlayToDeck`, and the difference is a rule rather than a
 * convenience.** That helper is rule 416's Recycle: bottom of the deck, and it
 * calls `holdCardsRecycled`, which fires the `cardsRecycled` event Karma -
 * Channeler reads. 416.1 defines Recycling as *"the action in which a player
 * takes one or more cards from a specific zone and then puts it on the bottom of
 * the corresponding deck"* — a named action — and this card deliberately does not
 * use the word: it says "PLACES it on the top or bottom". A top placement is not
 * a Recycle at all, so firing the event for the bottom half and not the top would
 * make one instruction two different actions depending on the answer. Neither
 * half fires it. (Recorded as a divergence: a Karma - Channeler watching their own
 * unit get Verdicted to the bottom does not draw.)
 *
 * The cleaned fields are `recycleUnitFromPlayToDeck`'s, for the reason that one
 * gives: the card may be drawn and played again, so nothing about the body it used
 * to be may travel with it. `returnControlAtEndOfTurnToIndex` is dropped on top of
 * that list — a borrowed unit sent to a deck must not carry a live loan back into
 * play the next time it is cast.
 *
 * **"Its OWNER"**, which is not always the player it was taken from: a unit under
 * `borrowUnitInPlace` sits in the thief's zone, and 416.1.c's "each player Recycles
 * cards to their OWN Main Deck, regardless of which player is instructed" is the
 * same reading for a placement. So the loan field, when present, is who gets it.
 *
 * A token never reaches a deck, which is `fileIntoNonBoardZone`'s job — used here
 * on an empty list so the one token rule serves both ends rather than being
 * re-derived for the top. **186**: "Tokens are Created on the board or the Chain
 * and cannot exist elsewhere", with **186.1**: "If a token is put into any
 * Non-Board Zone besides the chain, it ceases to exist immediately after moving to
 * its new zone." (That helper's own doc comment cites 714 and 715 for those two
 * sentences. Read against `pdftotext -raw`, 714 and 715 are Bonus Damage — "all
 * instances are summed and applied once" — so the numbers are wrong there and the
 * quoted prose is right. Not corrected here because effect-helpers.ts is not this
 * file's to edit; flagged for whoever owns it.)
 */
function placeUnitIntoOwnersDeck(state: GameState, unitInstanceId: string, end: DeckEnd): GameState {
  const location = findUnitAnywhere(state, unitInstanceId);
  if (location === undefined) return state;
  const { returnControlAtEndOfTurnToIndex: loanedFrom, ...withoutLoan } = location.unit;
  const clean: UnitInstance = {
    ...withoutLoan,
    damage: 0,
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    exhausted: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movesThisTurn: 0,
  };
  const ownerIndex = loanedFrom ?? location.ownerIndex;
  const removed = removeUnitAnywhere(state, unitInstanceId);
  const players = [...removed.players] as [PlayerState, PlayerState];
  const owner = players[ownerIndex];
  const arriving = fileIntoNonBoardZone<UnitInstance>([], clean);
  players[ownerIndex] = { ...owner, deck: end === "top" ? [...arriving, ...owner.deck] : [...owner.deck, ...arriving] };
  return { ...removed, players };
}

/**
 * Void Assault's two destination questions, and the answer that means "there was
 * nowhere to go".
 *
 * Written once because a resolver parks a `kind` and a registry answers to it, and
 * a typo in either would be SILENT — the same reason Keeper's Verdict's key above
 * is a constant. The `UNL-202-` prefix is what lets `decisionDefIds` report the
 * card as implemented at all.
 */
const VOID_ASSAULT_FRIENDLY = "UNL-202-friendly-where";
const VOID_ASSAULT_ENEMY = "UNL-202-enemy-where";
/** Not a battlefield id and not `"base"`, so it can never collide with a real
 *  answer. See `voidAssaultDestinations` for when it is the only option. */
const VOID_ASSAULT_NOWHERE = "nowhere";
/** The answer meaning "its own base" — 107.1.c makes that the only base a unit
 *  can ever go to, so the option needs no seat on it. */
const MOVE_HOME = "base";

/**
 * Where may `unitInstanceId` be moved right now — Void Assault's option list, for
 * both halves of the card.
 *
 * **355.4.a**: "a valid Location for a Move Effect is one other than the Units'
 * current Location where they are allowed to be present." So the battlefield it
 * already stands at is excluded (offering it would be an answer that visibly does
 * nothing, and `forceMoveToBattlefield` returns the state untouched for it), and
 * **198.1** — "Locations include the Battlefields and the Bases" — puts base on the
 * list for a unit that is not already there.
 *
 * The base option is gated on `mayMoveToBaseFrom`, which is Vilemaw's Lair's and
 * Minotaur Reckoner's "units can't move to base". Asked HERE rather than left to
 * `forceMoveToBase`'s own guard, because that guard silently no-ops: a player who
 * picked an answer that does nothing would have spent the card's only real choice
 * on it. This is the same reading chaos.ts's Flash-shaped moves already take.
 *
 * An empty list is a real state — a unit whose only battlefield is the one it
 * stands at, with base locked — and the callers turn it into `VOID_ASSAULT_NOWHERE`
 * rather than dropping the question, because dropping it would take the SECOND
 * move down with it.
 */
function voidAssaultDestinations(state: GameState, unitInstanceId: string | undefined): DecisionOption[] {
  if (unitInstanceId === undefined) return [];
  const at = findUnitAnywhere(state, unitInstanceId);
  // 359.3 — the unit was chosen when the spell was announced and may have died in
  // the response window. Nothing to move, so nowhere to move it.
  if (at === undefined) return [];
  const standingAt = at.zone === "base" ? undefined : state.battlefields[at.zone.battlefieldIndex]!.id;
  const battlefields = state.battlefields
    .filter((bf) => bf.id !== standingAt)
    .map((bf) => ({ id: bf.id, label: bf.name, instanceId: unitInstanceId }));
  return standingAt !== undefined && mayMoveToBaseFrom(state, standingAt)
    ? [...battlefields, { id: MOVE_HOME, label: "Its base", instanceId: unitInstanceId }]
    : battlefields;
}

/**
 * Raises Void Assault's SECOND question — "then move an enemy unit".
 *
 * `toFront` is `repeatDecision` versus `parkDecision`, and the two callers want
 * different ones for the reason Call to Battle's second half records: asked from
 * inside the first question's answer this is the continuation of one instruction
 * and belongs at the FRONT of the queue, while asked from the spell's own resolver
 * (because the friendly unit is already gone) nothing is queued ahead of it and the
 * back is the ordinary place.
 */
function askVoidAssaultEnemy(state: GameState, casterIndex: 0 | 1, enemyInstanceId: string, toFront: boolean): GameState {
  // 359.3 again, on the other target. "Do as much as you can" (359.3.e.11) with
  // nothing left to do is nothing.
  if (findUnitAnywhere(state, enemyInstanceId) === undefined) return state;
  const seed = { kind: VOID_ASSAULT_ENEMY, playerIndex: casterIndex, targetInstanceId: enemyInstanceId };
  return toFront ? repeatDecision(state, seed) : parkDecision(state, seed);
}

/** Who owns a unit in play, honouring a `borrowUnitInPlace` loan — the seat
 *  Keeper's Verdict's "its owner" question is put to. Read at ANNOUNCE-adjacent
 *  resolution time and carried on the decision only as the unit's id, so a loan
 *  that expires between the two is re-read rather than stale. */
function owningSeatOf(state: GameState, unitInstanceId: string): 0 | 1 | undefined {
  const location = findUnitAnywhere(state, unitInstanceId);
  if (location === undefined) return undefined;
  return location.unit.returnControlAtEndOfTurnToIndex ?? location.ownerIndex;
}

export const cardEffects: Record<string, EffectDefinition> = {
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
  "UNL-202": {
    // Void Assault (Body + Chaos) — "Move a friendly unit, then move an enemy
    // unit. (If they both move to a battlefield you don't control, you're the
    // attacker.)"
    //
    // # Both units are TARGETS and are announced; both DESTINATIONS are not
    //
    // 355.7 makes each unit a target ("when a card Chooses one or more specific
    // Game Objects to affect, it is Targeted"), so they go on the spec and 355.8
    // makes the card uncastable without one of each — which is the card: with no
    // enemy on the board there is no second move to make.
    //
    // **The destinations are a recorded DIVERGENCE.** 355.4 is explicit — "for
    // spells and abilities that Move one or more Units, choose a valid Location as
    // the Move Destination **for each Move that will be performed**" — so both
    // should be named as the spell goes on the chain, and an opponent responding to
    // it should know where the two bodies are about to land. A `PlayCardAction`
    // carries exactly ONE `destinationBattlefieldId`, and the card would also need a
    // row in `MOVE_TARGET_SPELL_DEF_IDS` (engine/card-effects.ts) before the
    // enumerator offered even that one; neither file is this one's to edit. So both
    // destinations are parked questions instead — Call to Battle's (UNL-101) and
    // Stare Down's (UNL-107) split, and named here for the same reason it is named
    // there. It needs a row in docs/rules-conformance.md.
    //
    // The alternative — leave the card unregistered, as wave 6 did — was rejected
    // rather than overlooked: the divergence is in WHEN a choice is made, and the
    // two moves themselves are exactly as printed.
    //
    // # "A friendly unit" / "an enemy unit" are bare nouns
    //
    // No location word on either, so `scope: "anywhere"` (355.9.a.1) — dragging a
    // body out of the enemy's base is the card's sharpest line, and pushing your own
    // out of yours is its ordinary one.
    //
    // # The printed parenthetical falls out of the ORDER, not out of a special case
    //
    // The friendly moves FIRST, as printed, and `forceMoveToBattlefield` applies
    // Contested on behalf of the MOVED unit's controller — rule **450**, "the
    // Destination becomes Contested if it is an Uncontested Battlefield not
    // controlled by the controller of the Unit or Units that moved". `applyContested`
    // is a no-op on an already-Contested battlefield, so when both units land at the
    // same uncontrolled battlefield the caster is the one who applied it and keeps
    // Focus (345) — which is precisely "you're the attacker". Nothing here has to
    // say so.
    //
    // Where they land SEPARATELY, 450 answers each destination on its own and the
    // enemy's controller may become the attacker at theirs. That is the rule rather
    // than the reminder, which only speaks to the both-to-one case.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      const enemyId = event.secondTargetUnitInstanceId;
      if (friendlyId === undefined || enemyId === undefined) return state;
      // A friendly that died in the response window takes its own move with it and
      // nothing else — "then move an enemy unit" is a separate instruction and
      // 359.3.e.11 still performs it.
      if (findUnitAnywhere(state, friendlyId) === undefined) return askVoidAssaultEnemy(state, ctx.casterIndex, enemyId, false);
      return parkDecision(state, {
        kind: VOID_ASSAULT_FRIENDLY,
        playerIndex: ctx.casterIndex,
        targetInstanceId: friendlyId,
        // The enemy half of the announcement, carried so the continuation knows
        // which body the "then" is about. `cardInstanceId` is the generic id slot a
        // decision has spare — Imposing Challenger's shove uses it the same way.
        cardInstanceId: enemyId,
      });
    },
  },
  "UNL-204": {
    // Keeper's Verdict (Body + Order) — "[Action] Choose an enemy unit at a
    // battlefield. Its owner places it on the top or bottom of their Main Deck."
    //
    // # "AT A BATTLEFIELD" is printed, so the DEFAULT scope is the right one
    //
    // 355.9.b — "It meets all targeting restrictions" — is the narrowing half of
    // the bare-noun rule, and this card prints the narrowing out loud. So a unit
    // sheltering in base is out of reach, which is what makes a 2-Energy /
    // 2-Power hard answer a fair one. Written by taking the default rather than by
    // naming `scope: "battlefield"`, matching every other card here that prints
    // the phrase.
    //
    // # `[Action]` needs nothing here
    //
    // It is a TIMING permission and `card-loader` already sets it from the printed
    // token; timing.ts enforces it. The same standing arrangement `[Reaction]` has.
    //
    // # The CHOICE belongs to the victim, which is why this stops to ask
    //
    // "ITS OWNER places it" — the opponent picks the end, not the caster, and top
    // is far better for them than bottom. That is a question with no action to
    // hang it on (the spell has already been announced and paid for), so it is a
    // parked decision addressed to the OTHER seat — the same shape Cull the Weak
    // uses to ask an opponent something mid-resolution.
    //
    // Deliberately BOTH options always, never auto-resolved: `advanceDecisions`
    // executes a one-option question silently, and collapsing this to one end
    // would take the card's only interesting decision away from the only player
    // who gets to make it.
    //
    // A target that has left play between announcement and resolution is a no-op
    // (359.3.e.12) — asked here, before the question is raised at all, so no
    // question is parked about a unit that is already gone.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, _ctx, event) => {
      if (event.targetUnitInstanceId === undefined) return state;
      const ownerIndex = owningSeatOf(state, event.targetUnitInstanceId);
      if (ownerIndex === undefined) return state;
      return parkDecision(state, {
        kind: KEEPERS_VERDICT_PLACEMENT,
        playerIndex: ownerIndex,
        targetInstanceId: event.targetUnitInstanceId,
      });
    },
  },
};

/** Still empty, and deliberately declared: `effects/index.ts` reads every
 *  registry off every module, so a missing export is `undefined` at merge time
 *  rather than an empty table. Declaring them keeps adding a card here to one
 *  line. (`eventTriggers`, `decisions` and `activatedAbilities` have moved below
 *  this block now that they hold cards.)
 */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};
export const mightModifiers: Record<string, MightModifier> = {};

/**
 * Event listeners contributed by this file.
 *
 * **Both entries are LEGENDS, and that is the seam worth naming.** A Legend is
 * not on the board, and `legend-abilities.ts` grew a hook per moment precisely
 * because of that — its own comments still say "a Legend is not on the board, so
 * no listener walk reaches it". That stopped being true: `listeningPermanents`
 * now ENDS with `owner.legend` (`zone: "legend"`), which is why the four
 * convertible hooks in that file are adapted onto this very registry by
 * `legendEventTriggers()`. So a Legend registered here is reached by the same
 * walk, needs no hook of its own, and — since a Legend can never leave play —
 * needs none of the "its source is gone" handling an ordinary listener does.
 *
 * Verified rather than assumed: `test/unl-signature-body-wave6.test.ts` drives
 * both through a real `resolveShowdown` / `runBeginning` and asserts the XP
 * moved, which is the only instrument that can see an XP gain at all (a keyword
 * or trigger that gains XP registers nothing `reachability` can count).
 */
export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "UNL-201": {
    // Kha'Zix - Voidreaver's first clause — "When you win a combat, gain 1 XP."
    //
    // `combatWon` (466.3.a) and NOT `battlefieldConquered`, which is the same
    // distinction Draven - Glorious Executioner's hook is written against and it
    // cuts both ways: a walk-in conquers with no combat at all, and a combat can
    // be won at a battlefield its winner already controlled, establishing no
    // control and conquering nothing. On a conquer hook Kha'Zix would bank XP for
    // fights that never happened and miss fights he won.
    //
    // 466.3.d's two No Result shapes pay nothing, and that is handled once inside
    // `combat.combatWinner` (the event only fires when exactly one side is left)
    // rather than restated here.
    //
    // "When YOU win" — the whole clause is `winnerIndex === listener.ownerIndex`.
    // There is no positional half to check, unlike Nidalee - Cat Form's "when I
    // win a combat": a Legend stands at no battlefield, so every combat its
    // controller wins is one they won.
    on: "combatWon",
    applies: (_state, listener, event) => event.kind === "combatWon" && event.winnerIndex === listener.ownerIndex,
    // Through `gainXp`, the single writer — **730.1**, "To Gain XP, increase the
    // value of XP marked on the Player gaining it" — rather than `xp + 1` inline.
    // See that helper for why a per-site increment is the mess it exists to
    // prevent.
    resolve: (state, listener) => gainXp(state, listener.ownerIndex, KHAZIX_COMBAT_XP),
  },
  "UNL-203": {
    // Poppy - Keeper of the Hammer's first clause — "When you hold, gain 1 XP."
    //
    // `battlefieldHeld` is rule 469.2's hold — "maintains Control of a Battlefield
    // they did not yet Score this turn" — so this is the SCORING moment and not
    // mere presence. A battlefield already scored this turn by a Conquer is not
    // held again — **470**, "A player may only Score, from either method, once per
    // Battlefield per turn" — and so pays nothing, which is the event's own
    // guarantee rather than a check here. (`GameEvent.battlefieldHeld`'s own doc
    // comment cites 471.1.b for that sentence; read against `pdftotext -raw`,
    // 471.1.b is the Final Point's restrictions on gaining a point through a
    // Conquer near the Victory Score. Left alone because triggers.ts is not this
    // file's to edit.)
    //
    // **ONE event per BATTLEFIELD, not one per Beginning Phase**, so holding two
    // battlefields is 2 XP. That is the event's shape and it is the right reading
    // of this card: the two Legends that print "when I hold" are claims about a
    // battlefield, and "when YOU hold" is the same moment with the positional half
    // dropped. Renata Glasc - Chem-Baroness's `onBattlefieldHeld` is the identical
    // per-battlefield reading of an identical phrase.
    //
    // Not `[Hunt]`. That keyword is "when you conquer OR hold" and is served for
    // all twelve of its cards by one entry in triggers.ts; Poppy prints only the
    // hold half in longhand, so borrowing the keyword's trigger would pay her out
    // on conquests she does not mention.
    on: "battlefieldHeld",
    applies: (_state, listener, event) => event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex,
    resolve: (state, listener) => gainXp(state, listener.ownerIndex, POPPY_HOLD_XP),
  },
};

/** Questions this file's cards stop to ask. Keyed by a `kind` string prefixed
 *  with the asking card's defId, which is both the ownership convention and what
 *  lets `decisionDefIds` report the card as implemented. */
export const decisions: Record<string, DecisionDefinition> = {
  // Void Assault's FIRST move — "move a friendly unit" — asked of the CASTER,
  // because a move destination is the moving effect's controller's choice (355.4).
  //
  // The `VOID_ASSAULT_NOWHERE` fallback is what keeps the second instruction alive.
  // An empty option list tells `advanceDecisions` a question has become moot and it
  // is DROPPED — and this question's answer is the only thing that raises the enemy
  // half, so a dropped one would silently swallow the rest of the card. Offering a
  // single do-nothing answer instead means `advanceDecisions` executes it without
  // ever showing it to anyone, and the chain continues. 359.3.e.11: "instructions
  // that can be partially followed are followed as much as possible."
  //
  // NOT a "you may": the instruction is mandatory, so no decline is listed. The
  // only reason to answer `VOID_ASSAULT_NOWHERE` is that there is genuinely no legal
  // Location — a unit whose only other battlefield is locked behind Vilemaw's Lair
  // or a Minotaur Reckoner.
  [VOID_ASSAULT_FRIENDLY]: {
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      return `Void Assault: move ${unit?.unit.name ?? "your unit"} where?`;
    },
    options: (state, d) => {
      const destinations = voidAssaultDestinations(state, d.targetInstanceId);
      return destinations.length > 0 ? destinations : [{ id: VOID_ASSAULT_NOWHERE, label: "Nowhere it can go" }];
    },
    resolve: (state, d, optionId) => {
      const moved =
        d.targetInstanceId === undefined || optionId === VOID_ASSAULT_NOWHERE
          ? state
          : optionId === MOVE_HOME
            ? forceMoveToBase(state, d.targetInstanceId, d.playerIndex)
            : forceMoveToBattlefield(state, d.targetInstanceId, optionId, d.playerIndex);
      // "THEN move an enemy unit" — the second half of one instruction, so it goes
      // to the FRONT of the queue rather than the back. Read off `moved`, not
      // `state`: the friendly's arrival can contest a battlefield, and the enemy's
      // own options are judged after it.
      return d.cardInstanceId === undefined ? moved : askVoidAssaultEnemy(moved, d.playerIndex, d.cardInstanceId, true);
    },
  },
  // Void Assault's SECOND move — "then move an enemy unit". Also the CASTER's
  // choice: the card tells THEM to move it, so 355.4's destination is theirs, and
  // dragging an enemy body somewhere unhelpful is the point of the card.
  //
  // No `VOID_ASSAULT_NOWHERE` here, unlike the half above: nothing is waiting on
  // this answer, so an empty list is correctly the end of the card rather than a
  // swallowed instruction.
  //
  // `d.playerIndex` is the caster and is what `forceMove*` is handed as
  // `causedByIndex` — so "when YOU move an enemy unit" reads the right seat, which
  // is the one thing that would be silently wrong if the moved unit's own controller
  // were passed instead.
  [VOID_ASSAULT_ENEMY]: {
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      return `Void Assault: move ${unit?.unit.name ?? "their unit"} where?`;
    },
    options: (state, d) => voidAssaultDestinations(state, d.targetInstanceId),
    resolve: (state, d, optionId) =>
      d.targetInstanceId === undefined
        ? state
        : optionId === MOVE_HOME
          ? forceMoveToBase(state, d.targetInstanceId, d.playerIndex)
          : forceMoveToBattlefield(state, d.targetInstanceId, optionId, d.playerIndex),
  },
  [KEEPERS_VERDICT_PLACEMENT]: {
    // Keeper's Verdict's "its owner places it on the top or bottom of their Main
    // Deck" — asked of the VICTIM, which is the whole of what makes the card
    // interactive rather than a hard removal spell.
    prompt: (state, d) => {
      const name = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId)?.unit.name : undefined;
      return `Place ${name ?? "your unit"} on the top or bottom of your Main Deck`;
    },
    // Rebuilt from live state, per `DecisionDefinition.options`: a unit that has
    // left play between the spell resolving and this being answered makes the
    // question MOOT, and an empty list is how `advanceDecisions` is told to drop
    // it. Returning one option would instead execute that end silently.
    options: (state, d) =>
      d.targetInstanceId !== undefined && findUnitAnywhere(state, d.targetInstanceId) !== undefined
        ? [
            { id: "top", label: "Top of your Main Deck", instanceId: d.targetInstanceId },
            { id: "bottom", label: "Bottom of your Main Deck", instanceId: d.targetInstanceId },
          ]
        : [],
    resolve: (state, d, optionId) =>
      d.targetInstanceId === undefined ? state : placeUnitIntoOwnersDeck(state, d.targetInstanceId, optionId === "top" ? "top" : "bottom"),
  },
};

/**
 * Activated abilities contributed by this file — both on LEGENDS, and both
 * priced in XP.
 *
 * **Two routes to that price, and the difference is not cosmetic.** Kha'Zix
 * below uses `ActivationCost.xp`, which landed 2026-08-12; Poppy still uses the
 * older split (`availableWhile` asks whether the XP is there, `resolve` spends
 * it through `spendXp`). Both are sound for a card with ONE price — in this
 * engine the check and the spend are the same instant, since
 * `executeActivateAbility` pays, holds the `abilityActivated` event and calls
 * `resolve` inline, so nothing can move a player's XP between them. The split
 * fails only for a card whose MODES are priced differently, because
 * `availableWhile` is declared on the ability and receives no `modeId` — which
 * is precisely why Kha'Zix's third clause could not be written until the cost
 * field existed. Poppy is left on the old route deliberately: converting her is
 * a behaviour-neutral edit to a card this change does not otherwise touch, and
 * the two routes standing side by side is what documents the distinction.
 *
 * Only the PLACEMENT of the cost diverges from 204.1.b (which makes it a base
 * cost paid at finalization), and that is the already-recorded "an activation
 * does not go on the chain" divergence rather than one these cards introduce.
 * Crowd Favorite, Blood Rose and Megatusk took the identical route to Poppy's.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-201": {
    // Kha'Zix - Voidreaver's SECOND and THIRD clauses — "Spend 1 XP, [Exhaust]:
    // [Buff] a unit." and "Spend 2 XP, [Exhaust]: Move an exhausted friendly unit
    // from a battlefield to its base." (His first is the `combatWon` listener
    // above: three clauses, two mechanisms, all three written.)
    //
    // # Why these are MODES and why that needed a shared-file change first
    //
    // The registry is keyed by defId and `abilitiesAvailableTo` hands a source
    // exactly the one ability under its own id (its three exceptions —
    // Heimerdinger, Svellsongur, Forge of the Fluft — are hardcoded), so two
    // printed abilities on one card have no way to be two entries. They must be
    // two modes of one.
    //
    // That was blocked until 2026-08-12. The XP price used to be expressible only
    // through `availableWhile`, which is declared on the ABILITY and receives no
    // `modeId`, so one predicate would have had to answer for both prices: gating
    // on 1 XP offers the 2-XP move to a player who cannot pay it (the exhaust is
    // taken by `payActivationCost` BEFORE `resolve` runs, so a refusal inside
    // `resolve` leaves a Legend spent for nothing), and gating on 2 XP makes the
    // printed 1-XP buff unbuyable at exactly 1 XP — the commonest state this card
    // is in, being one combat win. `ActivationCost.xp` removed the choice: the
    // price rides the MODE, `activationCostOf(defId, modeId)` is what every
    // pricing site goes through, and 730.2's "reduce the value of XP marked on the
    // Player spending it" happens once, inside `payActivationCost`, through
    // `spendXp`. So neither `resolve` below spends anything — a resolver that also
    // charged would double-bill, which is the exact failure a per-mode price
    // exists to make impossible.
    //
    // `exhaust: true` is repeated on both modes rather than left to the ability's
    // `cost`, because a mode that names a price names the WHOLE price
    // (`activationCostOf` overrides rather than merges). Dropping it from either
    // would make that clause free and repeatable. The shared exhaust is also why
    // the third clause costs nothing extra in practice: both abilities exhaust the
    // same Legend, so at most one is usable per turn either way.
    //
    // NOT `modesOncePerTurn`. That flag is Udyr's "one you've not chosen this
    // turn"; Kha'Zix prints no such line, and the exhaust is already the brake.
    kind: "Legend",
    modes: [
      {
        id: "buff",
        label: "Spend 1 XP: [Buff] a unit",
        // **"[Buff] A UNIT"** — a bare noun, so `scope: "anywhere"` and no owner
        // (355.9.a.1: "'Unit,' 'gear,' and 'rune' refer to objects on the Board
        // unless specified otherwise"). Base is where a unit usually waits to be
        // grown, and buffing an ENEMY unit is a bad play rather than an illegal
        // one — the same reading Blood Rose's "Ready a unit" and Wallop's take.
        targeting: { kind: "unit", scope: "anywhere" },
        cost: { exhaust: true, xp: KHAZIX_BUFF_XP },
        // `addBuff` is the one-buff funnel (702.3.a), so buffing an already-buffed
        // unit spends the XP and places nothing. He is not in
        // `STACKING_BUFF_DEF_IDS`; only Lee Sin - Ascetic is.
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId === undefined ? state : addBuff(state, event.targetUnitInstanceId),
      },
      {
        id: "home",
        label: "Spend 2 XP: send an exhausted friendly unit home",
        // Every word of "an EXHAUSTED FRIENDLY unit FROM A BATTLEFIELD" is in the
        // spec rather than in the resolver, because by the time a resolver runs
        // the XP and the exhaust are already gone — the offered-then-refused split
        // `TargetingSpec.attackingOnly`'s own note records. `scope: "battlefield"`
        // is the printed "from a battlefield" and is load-bearing here in the
        // strong sense: without it a unit already in base would be offered, and
        // `forceMoveToBase` would silently no-op on it (355.4.a excludes a Unit's
        // current Location, so there is no move to make).
        targeting: { kind: "unit", owner: "friendly", scope: "battlefield", exhaustedOnly: true },
        cost: { exhaust: true, xp: KHAZIX_MOVE_HOME_XP },
        // NOT `movesTarget`. That flag fans enumeration out per DESTINATION
        // battlefield; this destination is printed ("to its base") and is the same
        // implicit one Yasuo - Unforgiven's going-home mode has.
        //
        // **A MOVE, not a Recall** — 446.1, "a Permanent changing its position
        // from any space on the Board to another space on the Board is a Move",
        // with 198.1 making a Base one of those spaces. `forceMoveToBase` is
        // therefore the right door and not `relocateToBaseUnchanged`: it counts
        // `movesThisTurn`, holds the `unitMoved` events, and — the half that
        // matters — asks `mayMoveToBaseFrom`, so Vilemaw's Lair and Minotaur
        // Reckoner stop this clause exactly as they stop every other way home.
        //
        // That guard makes the activation legal-but-inert under a Reckoner rather
        // than illegal, and that is the RULES answer rather than a shortcut: the
        // Reckoner is a continuous effect preventing a move, not a targeting
        // restriction, so an exhausted friendly at a battlefield still "meets all
        // targeting restrictions" (355.9.b) and 359.3.e.11's "instructions that can
        // be partially followed are followed as much as possible" is what is left.
        // Contrast `voidAssaultDestinations` above, which DOES gate on
        // `mayMoveToBaseFrom` — that one is a decision's option list, where an
        // illegal destination would be presented as a choice.
        //
        // `ctx.casterIndex` is passed as `causedByIndex`, so a "when you move a
        // unit" listener reads the seat that USED the ability. It is always the
        // moved unit's own controller here (the target is friendly), but the two
        // are distinct arguments and handing the wrong one over is silent.
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId === undefined
            ? state
            : forceMoveToBase(state, event.targetUnitInstanceId, ctx.casterIndex),
      },
    ],
  },
  "UNL-203": {
    // Poppy - Keeper of the Hammer's second clause — "Spend 3 XP, [Exhaust]:
    // Draw 1." (Her "when you hold, gain 1 XP" is the `battlefieldHeld` listener
    // above — two clauses, two mechanisms, one card, and both of them written.)
    //
    // The exhaust is printed, so `cost` is omitted and defaults to it — that is
    // the brake, since 3 XP is otherwise the only limit and XP keeps arriving from
    // the clause above.
    //
    // NOT `banksResource`. That flag is for an ability the board evaluator cannot
    // price at all (the Seals, Lux - Crownguard, Ornn's restricted pool); a card in
    // hand is something `evaluate` reads, and Ezreal - Prodigal Explorer's
    // identical "[Exhaust]: Draw 1" carries no flag either.
    kind: "Legend",
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => canSpendXp(state, playerIndex, POPPY_DRAW_XP),
    resolve: (state, ctx) => {
      const paid = spendXp(state, ctx.casterIndex, POPPY_DRAW_XP);
      if (paid === undefined) return state; // 203.3 — unreachable via `availableWhile`
      return drawCards(paid, ctx.casterIndex, 1);
    },
  },
};
