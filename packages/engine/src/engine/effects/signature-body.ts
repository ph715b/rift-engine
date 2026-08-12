import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import { parkDecision } from "../decisions.js";
import { findUnitAnywhere } from "../target-lookup.js";
import {
  addBuff,
  canSpendXp,
  dealDamageToEnemyUnitsAtBattlefield,
  drawCards,
  fileIntoNonBoardZone,
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
/** ...and his "Spend 1 XP, [Exhaust]: [Buff] a unit." His third clause ("Spend
 *  2 XP, [Exhaust]: Move an exhausted friendly unit from a battlefield to its
 *  base") is NOT written — see his `activatedAbilities` entry for why the two
 *  cannot share one registry key today. */
const KHAZIX_BUFF_XP = 1;

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
 * `ActivationCost` has no `xp` field, so the price is split the only way that
 * cannot be offered-and-then-refused: `availableWhile` asks whether the XP is
 * there (both the enumerator and the validator reach it through
 * `canPayActivationCost`), and `resolve` spends it through `spendXp`, whose
 * `undefined` is a real refusal rather than a silent floor at zero. In this
 * engine those are the same instant — `executeActivateAbility` pays, holds the
 * `abilityActivated` event and calls `resolve` inline — so nothing can move a
 * player's XP between them. Only the PLACEMENT of the cost diverges from 204.1.b
 * (which makes it a base cost paid at finalization), and that is the
 * already-recorded "an activation does not go on the chain" divergence rather
 * than one these cards introduce. Crowd Favorite, Blood Rose and Megatusk took
 * the identical route.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-201": {
    // Kha'Zix - Voidreaver's SECOND clause — "Spend 1 XP, [Exhaust]: [Buff] a
    // unit."
    //
    // # HALF A CARD, and the missing half is a refusal rather than an oversight
    //
    // His THIRD clause — "Spend 2 XP, [Exhaust]: Move an exhausted friendly unit
    // from a battlefield to its base" — is NOT implemented, and it cannot be
    // until `activated-abilities.ts` grows one of two things:
    //
    //   an `ActivationCost.xp` field, checked in `canPayActivationCost` and paid
    //   in `payActivationCost`; or
    //
    //   a `modeId` argument threaded into `availableWhile`, which
    //   `canPayActivationCost` already receives and already drops.
    //
    // Two abilities on one card must be MODES of a single entry — the registry is
    // keyed by defId, and `abilitiesAvailableTo` hands a source exactly the one
    // ability under its own id (its three exceptions are Heimerdinger, Svellsongur
    // and Forge of the Fluft, all hardcoded). But `availableWhile` is declared on
    // the ABILITY, not the mode, so one predicate would have to answer for both
    // prices. Gating on 1 XP offers the 2-XP move to a player who cannot pay it:
    // the exhaust is taken by `payActivationCost` BEFORE `resolve` runs, so the
    // refusal inside `resolve` would leave a Legend spent for nothing — precisely
    // the offered-then-refused split `availableWhile` exists to prevent. Gating on
    // 2 XP instead makes the printed 1-XP buff unbuyable at exactly 1 XP, which is
    // the commonest state this card is in (one combat win). Neither is shippable,
    // so the clause is left out and named.
    //
    // # The clause that IS here
    //
    // `[Exhaust]` is printed, so `cost` is omitted and takes the default
    // `{ exhaust: true }` — the opposite call from Crowd Favorite, whose "Spend 2
    // XP:" prints no exhaust and therefore needs an explicit `cost: {}`. The
    // exhaust is what makes this once per turn, and it is also what makes the
    // missing third clause cost nothing extra in practice: both abilities exhaust
    // the same Legend, so only one of them was ever usable per turn.
    //
    // **"[Buff] A UNIT"** — a bare noun, so `scope: "anywhere"` and no owner
    // (355.9.a.1: "'Unit,' 'gear,' and 'rune' refer to objects on the Board unless
    // specified otherwise"). Base is where a unit usually waits to be grown, and
    // buffing an ENEMY unit is a bad play rather than an illegal one — the same
    // reading Blood Rose's "Ready a unit" and Wallop's already take.
    //
    // `addBuff` is the one-buff funnel (702.3.a), so buffing an already-buffed unit
    // spends the XP and places nothing. He is not in `STACKING_BUFF_DEF_IDS`; only
    // Lee Sin - Ascetic is.
    kind: "Legend",
    targeting: { kind: "unit", scope: "anywhere" },
    availableWhile: (state, playerIndex) => canSpendXp(state, playerIndex, KHAZIX_BUFF_XP),
    resolve: (state, ctx, event) => {
      if (event.targetUnitInstanceId === undefined) return state;
      const paid = spendXp(state, ctx.casterIndex, KHAZIX_BUFF_XP);
      // `availableWhile` already refused an unaffordable activation, so this is
      // unreachable on the real path — written out rather than asserted, because a
      // silent free buff is the failure mode `spendXp`'s `undefined` exists to
      // prevent (203.3: a cost that cannot be paid means the linked effect is not
      // executed).
      if (paid === undefined) return state;
      return addBuff(paid, event.targetUnitInstanceId);
    },
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
