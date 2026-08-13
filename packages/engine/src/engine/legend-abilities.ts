import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { CardInstance, UnitInstance } from "../model/card.js";
import type { EventTriggerDefinition, GameEvent } from "./triggers.js";
import type { DecisionDefinition, DecisionOption } from "./decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  completeDeath,
  drawCards,
  giveMightThisTurn,
  holdCardsRecycled,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyRunes,
  readyUnit,
} from "./effect-helpers.js";
import { computeAutoPayment } from "./rune-payment.js";
import { modifiedEnergyCost } from "./cost-modifiers.js";
import { playCardIgnoringCost } from "./play-free.js";
import { placeGoldTokens } from "./token.js";
import { pendingDeathFor, releasePendingDeath } from "./death-ward.js";
import { RAINBOW } from "./hidden.js";
// Rule 708's "Might 5 or greater", already defined once for Fiora - Victorious.
// Imported rather than restated so Volibear and Fiora can never disagree about
// what Mighty means — the threshold is a rule, not a per-card number.
import { isMighty } from "./granted-keywords.js";
import { findUnitAnywhere } from "./target-lookup.js";
// decisions.ts pulls `legendDecisions` back out of this module, so this is a
// cycle — safe for the same reason every other registry cycle here is: both
// bindings are read inside functions, never at module load.
import { parkDecision } from "./decisions.js";

/** The `unitsStunned` payload, taken FROM the event union rather than restated,
 *  so a legend's view of a stun and a permanent's can never drift. Type-only, so
 *  it adds no runtime dependency on triggers.ts. */
export type StunEvent = Extract<GameEvent, { kind: "unitsStunned" }>;

/**
 * The four Proving Grounds Legends' abilities — the last cards in the OGS set
 * with printed text and no implementation. Every deck has exactly one Legend
 * in play from turn 1, so until now every game was played with one blank card
 * per side.
 *
 * Ported from engine/LegendAbilities.java, with one deliberate improvement:
 * that file dispatches by PREFIX-MATCHING the Legend's display name
 * (`legend.name.startsWith("Annie")`, LegendAbilities.java:34) because its own
 * `championTag` is derived as `name.split("\\s+")[0]` and so breaks for
 * multi-word names ("Master Yi" -> "MASTER") — a latent bug its doc comment
 * calls out at :16-18. We key by defId instead, exactly like CARD_EFFECTS and
 * UNIT_TRIGGERS already do, which has no such ambiguity.
 *
 * Three of the four are one-shot EVENT triggers, hooked at the exact moment
 * they fire (turn-manager.ts's runEnd, execute-pass-focus.ts's chain
 * resolution, scoring.ts's recordConquest). Master Yi's is not an event at
 * all: it's a continuous conditional modifier, recomputed inside
 * effective-might.ts every time Might is evaluated and never written into
 * state — persisting it would leak the bonus into unrelated later fights the
 * same turn (LegendAbilities.java:20-26 makes the same point).
 */
/** Irelia - Blade Dancer's "you may pay [1] to ready me". */
const IRELIA_READY_COST = 1;

/** Rek'sai - Void Burrower reveals the top 2. */
const REKSAI_REVEAL = 2;

/**
 * Pays a revealed card's FULL printed cost, or undefined when it cannot be paid.
 *
 * Void Rush's `voidRushPayment` with the discount removed, and it inherits that
 * function's three named limitations — all of which UNDER-offer, so the card is
 * withheld rather than handed over unpaid: floating Power is not counted, a split
 * Power pip is tried all-primary then all-alt but never mixed, and a Legend can
 * never be in a Main Deck so it is refused rather than priced.
 */
function reksaiPayment(state: GameState, playerIndex: 0 | 1, card: CardInstance): GameState | undefined {
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
  return payEnergyFromPool(paid, playerIndex, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId));
}

export interface LegendAbilityDefinition {
  /** "At the end of your turn..." — fires only for the player whose turn is
   *  ending, before the active player rotates. */
  onEndOfTurn?: (state: GameState, ownerIndex: 0 | 1) => GameState;
  /** "When you play a spell that costs N or more..." — `totalCost` is Energy
   *  PLUS Power, see dispatchLegendOnSpellCast. */
  onSpellCast?: (state: GameState, ownerIndex: 0 | 1, totalCost: number) => GameState;
  /** "When you conquer..." — fires after the conquest is recorded, with the
   *  battlefield just taken. */
  onConquer?: (state: GameState, ownerIndex: 0 | 1, battlefieldId: string) => GameState;
  /**
   * Garen's "**if** you have 4+ units at that battlefield" — the requirement
   * BESIDES conquering, asked when the event happens rather than when the ability
   * resolves.
   *
   * Separate from `onConquer` rather than a guard inside it, because the two are
   * different questions once the trigger is held: this one decides whether a
   * Pending Item is placed at all, and 383.4 settles it at the moment of the
   * event ("if those requirements are not fulfilled when the unit gains the
   * designation, it will not trigger"). Asked once, here — re-asking it in the
   * body would let an opponent cancel a fired trigger by killing a unit inside
   * the response window.
   *
   * Named for its own hook because it is the only one that needs a condition
   * today. The day a second does, this becomes a per-hook shape rather than a
   * second field beside it.
   */
  conquerCondition?: (state: GameState, ownerIndex: 0 | 1, battlefieldId: string) => boolean;
  /**
   * "When you win a combat..." — rule 466.3.a, the moment `combatWon` names.
   *
   * A Legend needs its own hook for this rather than riding the event trigger
   * registry, for the reason every hook here exists: a Legend is not on the
   * board, so no listener walk reaches it.
   *
   * NOT a conquest, and Draven - Glorious Executioner is exactly the card that
   * shows why: a walk-in conquers without a combat, and a combat can be won at
   * a battlefield its winner already controlled. Paying out on `onConquer`
   * would be wrong in both directions.
   */
  onCombatWon?: (state: GameState, ownerIndex: 0 | 1, battlefieldId: string) => GameState;
  /**
   * "When you choose a friendly unit..." — Irelia - Blade Dancer.
   *
   * Rides the `unitChosen` event, which already existed and already fires from
   * BOTH choosing paths (a spell's announcement and a unit ability's). Nothing
   * new was needed at the event end; what was missing was a Legend hook to hang
   * off it, and the ability to hold TWO hooks on one Legend — see
   * `legendEventTriggers`, which used to throw on the second.
   *
   * Handed the CHOSEN unit's id, because "ready IT" is about that unit and the
   * response window this trigger opens can move the board before it resolves.
   */
  onUnitChosen?: (state: GameState, ownerIndex: 0 | 1, unitInstanceId: string) => GameState;
  /**
   * "When you or an ally hold..." — Renata Glasc - Chem-Baroness.
   *
   * Rides `battlefieldHeld`, which already exists and already fires once PER
   * BATTLEFIELD held rather than once per Beginning Phase — see its own comment
   * for why that distinction is load-bearing.
   *
   * "OR AN ALLY" has no subject in a 1v1 game: there are two seats and the other
   * one is an opponent. Implemented as "you", which is the whole of the clause at
   * this player count, rather than inventing an ally relation the mode does not
   * have.
   */
  onBattlefieldHeld?: (state: GameState, ownerIndex: 0 | 1, battlefieldId: string) => GameState;
  /**
   * "When one of your units becomes [Mighty]..." — Fiora - Grand Duelist.
   *
   * Rides `unitBecameMighty`, a TRANSITION event rather than an ordinary one:
   * Might has no stored total, so `effect-helpers.withMightTransitions` brackets
   * the raise helpers and compares before with after. See that function for the
   * recorded partial (an aura arriving is not seen).
   */
  onUnitBecameMighty?: (state: GameState, ownerIndex: 0 | 1, unitInstanceId: string) => GameState;
  /** "When you recycle a rune..." — Sivir - Battle Mistress. Rides
   *  `runesRecycled`, one event per INSTRUCTION with a count (see that event for
   *  why it is not a widening of `cardsRecycled`). */
  onRunesRecycled?: (state: GameState, ownerIndex: 0 | 1, count: number) => GameState;
  /** "When one or more ENEMY units die..." — Sivir's second clause. Handed the
   *  death so the body can check whose unit it was. */
  onEnemyUnitDied?: (state: GameState, ownerIndex: 0 | 1) => GameState;
  /** "At start of your Beginning Phase..." — fires on the same event Mushroom
   *  Pouch listens to, before holds score (see turn-manager.runBeginning). */
  onBeginningPhase?: (state: GameState, ownerIndex: 0 | 1) => GameState;
  /** "When you stun one or more enemy units..." — handed the whole batch, since
   *  that phrasing pays out once however many were stunned. Fired by
   *  `effect-helpers.stunUnits` for BOTH players' legends, because a legend is
   *  not on the board and no listener walk reaches it. */
  onUnitsStunned?: (state: GameState, ownerIndex: 0 | 1, event: StunEvent) => GameState;
  /** "When an ENEMY unit attacks a battlefield you control..." — Ahri. Fired
   *  from the same on-attack moment `dispatchOnAttack` serves, but for the
   *  DEFENDER's legend rather than the attacker's, which is why it is a separate
   *  hook and not a branch inside that one. */
  onEnemyUnitAttacks?: (
    state: GameState,
    ownerIndex: 0 | 1,
    attack: { unitInstanceId: string; attackerIndex: 0 | 1; battlefieldId: string },
  ) => GameState;
  /** "When you play a [Mighty] unit..." — Volibear. A unit-specific companion to
   *  the `cardPlayed` event, which carries only the caster: this needs the unit
   *  itself to ask whether it is Mighty. */
  onUnitPlayed?: (state: GameState, ownerIndex: 0 | 1, played: { unit: UnitInstance; casterIndex: 0 | 1 }) => GameState;
  /** A continuous Might modifier for one of the owner's units, evaluated
   *  fresh per call — see effective-might.ts's own aura table. */
  mightBonus?: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: LegendMightContext) => number;
}

/** The slice of effective-might.ts's MightContext a Legend aura can read.
 *  Declared here rather than imported to keep the dependency one-way
 *  (effective-might.ts consumes this module, never the reverse). */
export interface LegendMightContext {
  isCombat: boolean;
  isAttackingSide?: boolean;
  battlefieldId?: string;
}

const LEGEND_ABILITIES: Record<string, LegendAbilityDefinition> = {
  "SFD-203": {
    // Sivir - Battle Mistress — "When you recycle a rune, you may exhaust me to
    // play a Gold gear token exhausted. When one or more enemy units die, ready
    // me."
    //
    // **The SECOND two-hook Legend**, after Irelia — and the one that shows the
    // adapter rework was not a one-card fix. Her two clauses are on different
    // events and, like Irelia's, their costs differ in the way that matters: the
    // first spends Sivir herself, so an exhausted Sivir is never offered it; the
    // second READIES her, so it is exactly for an exhausted Sivir and carries no
    // exhaust gate at all.
    //
    // Together they are an engine: recycle a rune for a Gold, kill something to
    // stand her back up, repeat.
    onRunesRecycled: (state, ownerIndex) => parkDecision(state, { kind: "SFD-203-gold", playerIndex: ownerIndex }),
    onEnemyUnitDied: (state, ownerIndex) => {
      const owner = state.players[ownerIndex];
      if (!owner.legend.exhausted) return state; // already ready — nothing to do
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ownerIndex] = { ...owner, legend: { ...owner.legend, exhausted: false } };
      return { ...state, players };
    },
  },
  "SFD-205": {
    // Fiora - Grand Duelist — "When one of your units becomes [Mighty], you may
    // exhaust me to channel 1 rune exhausted."
    //
    // The event is the whole difficulty and it is not hers: "becomes" is a
    // TRANSITION across 5 Might (709), on a value this engine recomputes on every
    // read. See `withMightTransitions`, which brackets the raise helpers, and the
    // recorded partial that comes with it.
    //
    // Singular — "one of your units" — so a mass pump that pushes three units
    // over the line offers this three times, once per unit. That is what the
    // event being per-unit buys, and it is answerable one at a time.
    onUnitBecameMighty: (state, ownerIndex) =>
      parkDecision(state, { kind: "SFD-205-channel", playerIndex: ownerIndex }),
  },
  "SFD-201": {
    // Renata Glasc - Chem-Baroness — "When you or an ally hold, you may exhaust
    // me to play a Gold gear token exhausted. While your score is within 3 points
    // of the Victory Score, your Gold [Add] an additional [1]."
    //
    // TWO clauses of DIFFERENT KINDS, which is what makes her worth having after
    // Irelia: one is a triggered ability and the other is a continuous modifier.
    // Only the first is in this table — the second is not a trigger at all and
    // lives where the Gold's ability RESOLVES (`goldAddsExtraEnergy`), the same
    // split `mightBonus` already makes for Master Yi.
    //
    // The second clause is a running condition on the SCORE, so it is read at use
    // time rather than baked into a token when it is minted: a Gold made while
    // behind still pays the bonus once its controller pulls ahead. And it adds
    // ENERGY on top of the Gold's printed rainbow POWER — two different pools,
    // and `floatingRainbowPower` is not `floatingEnergy`.
    //
    // "Your score within 3 of the Victory Score" is `selfNearVictory`, deliberately
    // NOT the existing `opponentNearVictory`: that one rewards being BEHIND (Leona
    // - Zealot, Find Your Center) and reading it here would invert the card.
    onBattlefieldHeld: (state, ownerIndex) =>
      parkDecision(state, { kind: "SFD-201-gold", playerIndex: ownerIndex }),
  },
  "UNL-193": {
    // Vex - Gloomist — "When you or an ally hold, you may exhaust me to draw 1."
    //
    // Renata Glasc's FIRST clause with the payout changed, and nothing else: same
    // moment (469.2's hold, raised as `battlefieldHeld`), same optional exhaust of
    // the Legend as the price, same parked question. She pays a Gold; this draws.
    //
    // The clone was confirmed BEHAVIOURALLY by a wave-8 agent rather than by
    // reading: a real `battlefieldHeld` with Renata seated parks `SFD-201-gold`,
    // and the same event with Vex seated parked nothing at all.
    //
    // "Or an ALLY" needs nothing in a two-player game — there is no ally — and is
    // written down rather than silently relied on, because a multiplayer mode
    // would make it load-bearing and the hook already receives only the owner.
    onBattlefieldHeld: (state, ownerIndex) =>
      parkDecision(state, { kind: "UNL-193-draw", playerIndex: ownerIndex }),
  },
  "SFD-187": {
    // Rek'sai - Void Burrower — "When you conquer, you may exhaust me to reveal
    // the top 2 cards of your Main Deck. You may banish one, then play it.
    // Recycle the rest."
    //
    // Void Rush (SFD-188) already does the reveal-2 / banish-one / play-it half,
    // and this borrows its shape wholesale. **Two differences, both printed:**
    //  - Void Rush DRAWS what it did not banish; this RECYCLES it (bottom of the
    //    deck, per 416).
    //  - Void Rush plays its card for 2 Energy less; this says only "play it", so
    //    the card is paid for IN FULL. Nothing unpayable is offered, which is
    //    416.3's "the action must be able to be completed for the cost to be
    //    paid" — the rule Void Rush's own option list already applies.
    //
    // TWO questions rather than one, because the card asks two: "you MAY exhaust
    // me" is a cost paid before anything is seen, and "you MAY banish one" is a
    // choice made after seeing. Collapsing them would make a player commit
    // Rek'sai to a reveal they have already been shown the results of.
    onConquer: (state, ownerIndex) =>
      // An exhausted Rek'sai cannot pay, so she is never asked — the same rule
      // Volibear and Irelia's first clause apply.
      state.players[ownerIndex].legend.exhausted
        ? state
        : parkDecision(state, { kind: "SFD-187-look", playerIndex: ownerIndex }),
  },
  "SFD-195": {
    // Irelia - Blade Dancer — "When you choose a friendly unit, you may exhaust
    // me and pay [rainbow] to ready it. When you conquer, you may pay [1] to
    // ready me."
    //
    // **The first Legend with TWO convertible hooks**, and the card that forced
    // `legendEventTriggers` to stop throwing on the second. Both clauses are
    // ordinary triggers on events that already exist — `unitChosen` (which fires
    // from both choosing paths) and `battlefieldConquered` — so nothing new was
    // needed at the event end.
    //
    // Both are "you MAY" with a COST, so both stop to ask rather than firing.
    // Their costs differ in a way that matters: the first spends the Legend
    // HERSELF (exhaust) plus a rainbow pip, so an exhausted Irelia is never
    // offered it; the second spends only Energy, so an exhausted Irelia IS
    // offered it — readying her is the whole point of that clause.
    onUnitChosen: (state, ownerIndex, unitInstanceId) =>
      parkDecision(state, { kind: "SFD-195-ready-chosen", playerIndex: ownerIndex, cardInstanceId: unitInstanceId }),
    onConquer: (state, ownerIndex) => parkDecision(state, { kind: "SFD-195-ready-me", playerIndex: ownerIndex }),
  },
  "SFD-185": {
    // Draven - Glorious Executioner (SFD) — "When you win a combat, draw 1."
    //
    // The card that shows why `combatWon` had to be its own event rather than
    // the cards reusing `battlefieldConquered`: a walk-in conquers with no
    // combat at all, and a combat can be won at a battlefield its winner
    // already controlled, which establishes no control and conquers nothing.
    // On a conquer hook he would draw for fights that never happened and miss
    // fights he won.
    //
    // 466.3.d's No Result shapes deliberately pay nothing — a mutual wipe is
    // not a win — and that is handled once, in `combat.combatWinner`, rather
    // than restated here.
    onCombatWon: (state, ownerIndex) => drawCards(state, ownerIndex, 1),
  },
  "OGS-017": {
    // Annie - Dark Child — "At the end of your turn, ready up to 2 runes."
    onEndOfTurn: (state, ownerIndex) => readyRunes(state, ownerIndex, 2),
  },
  "OGS-021": {
    // Lux - Lady of Luminosity — "When you play a spell that costs 5 or
    // more, draw 1."
    onSpellCast: (state, ownerIndex, totalCost) => (totalCost >= 5 ? drawCards(state, ownerIndex, 1) : state),
  },
  "OGS-023": {
    // Garen - Might of Demacia — "When you conquer, if you have 4+ units at
    // that battlefield, draw 2." Counts the units still standing AFTER the
    // fight that took the battlefield, which is what "you have ... at that
    // battlefield" reads as at the moment of the conquest (and what
    // ScoringSystem's own dispatch point gives it — LegendAbilities.java:301).
    //
    // The count is the trigger's CONDITION, so it lives in `conquerCondition`
    // and is asked once, when the conquest happens. It used to be a guard inside
    // the body, which was the same instant while this resolved inline and is a
    // full response window later now that it does not.
    conquerCondition: (state, ownerIndex, battlefieldId) =>
      (state.battlefields.find((b) => b.id === battlefieldId)?.units[state.players[ownerIndex].id] ?? []).length >= 4,
    onConquer: (state, ownerIndex) => drawCards(state, ownerIndex, 2),
  },
  "OGN-251": {
    // Jinx - Loose Cannon — "At start of your Beginning Phase, draw 1 if you have
    // one or fewer cards in your hand."
    //
    // The condition is checked when the ability resolves, not when the phase was
    // entered, and "one or fewer" includes an empty hand — the case the card is
    // really for, since Jinx's deck discards aggressively.
    onBeginningPhase: (state, ownerIndex) =>
      state.players[ownerIndex].hand.length <= 1 ? drawCards(state, ownerIndex, 1) : state,
  },
  "OGN-261": {
    // Leona - Radiant Dawn — "When you stun one or more enemy units, buff a
    // friendly unit."
    //
    // "ONE OR MORE ... buff A friendly unit" — one buff per instruction, however
    // many were stunned. That phrasing is the whole reason `unitsStunned` is a
    // batch event: a per-unit event would pay this out twice for Facebreaker.
    // Eclipse Herald's "when you stun AN enemy unit" is deliberately the other
    // shape and reads the same payload per unit.
    //
    // "You ... enemy" are both measured against this legend's controller, so a
    // stun by the opponent — or of your own units — offers nothing.
    //
    // WHICH friendly unit is a real choice with no action to hang it on (the
    // trigger fires inside a resolution), so it stops and asks. Routed through
    // addBuff, where rule 702.3.a's "not placed instead" lives: buffing an already
    // buffed unit is a no-op, which is what the card's own reminder text
    // describes.
    onUnitsStunned: (state, ownerIndex, event) => {
      if (event.stunnerIndex !== ownerIndex) return state;
      if (!event.stunned.some((s) => s.ownerIndex !== ownerIndex)) return state;
      return parkDecision(state, { kind: "OGN-261-buff", playerIndex: ownerIndex });
    },
  },
  "OGN-255": {
    // Ahri - Nine-Tailed Fox — "When an enemy unit attacks a battlefield you
    // control, give it -1 Might this turn, to a minimum of 1 Might."
    //
    // Two conditions, both printed. The unit must be an ENEMY of Ahri's
    // controller, and the battlefield must be one they CONTROL — not merely one
    // they have units at. A contested battlefield with no controller gives her
    // nothing, which is what makes her a defensive legend rather than a general
    // attack tax.
    //
    // The `floor` argument of giveMightThisTurn exists for exactly this "to a
    // minimum of 1" wording: it clamps against printed Might plus the
    // accumulated this-turn modifier, so repeated attacks cannot dig a hole a
    // later buff has to climb out of.
    onEnemyUnitAttacks: (state, ownerIndex, attack) => {
      if (attack.attackerIndex === ownerIndex) return state;
      const bf = state.battlefields.find((b) => b.id === attack.battlefieldId);
      if (bf?.controllerId !== state.players[ownerIndex].id) return state;
      return giveMightThisTurn(state, attack.unitInstanceId, -1, 1);
    },
  },
  "OGN-249": {
    // Volibear - Relentless Storm — "When you play a [Mighty] unit, you may
    // exhaust me to channel 1 rune exhausted."
    //
    // [Mighty] is "while it has 5+ Might" (rule 708), so it is asked of the unit
    // as it stands on the board right now — through effectiveMight, so a 4-Might
    // unit played under a Garen - Commander aura counts. Reading printed Might
    // would quietly disagree with what the board shows.
    //
    // **Since the higher-of-two combat ruling (2026-08-08) that includes a unit
    // that is Mighty only INSIDE a combat**, and it is reachable rather than
    // theoretical: `[Reaction]` units can be played into an open Combat Showdown,
    // so Shen - Kinkou (3 Might, `[Shield 2]`) played to a battlefield he defends
    // is 5 and fires this. Played to BASE, the same card fires nothing. Measured
    // through the real submit path in `test/becomes-mighty-routes.test.ts`. This
    // is why the check has to go through `isMighty` and not a hand-written `>= 5`.
    //
    // "You MAY exhaust me" makes this optional and gives it a cost, so it stops
    // to ask. An already-exhausted Volibear cannot pay and is not asked at all —
    // the same "never offer what cannot be paid" rule canPayActivationCost
    // applies to activated abilities.
    onUnitPlayed: (state, ownerIndex, played) => {
      if (played.casterIndex !== ownerIndex) return state;
      if (state.players[ownerIndex].legend.exhausted) return state;
      // Read off the BOARD rather than from the played instance: a unit standing
      // under an aura is Mighty at the Might it actually has, and the instance
      // handed to this hook carries only its own fields.
      const location = findUnitAnywhere(state, played.unit.instanceId);
      if (!location || !isMighty(state, location.unit, location.ownerIndex)) return state;
      return parkDecision(state, { kind: "OGN-249-channel", playerIndex: ownerIndex });
    },
  },
  "OGN-269": {
    // Sett - The Boss, second clause — "When you conquer, ready me."
    //
    // Readies the LEGEND, not a unit, so it goes straight at the legend zone
    // rather than through readyUnit. That matters because his first clause
    // spends the exhaust: conquering is what lets him save a second unit in a
    // turn. (The replacement half is its own piece of work — see
    // docs/rules-conformance.md.)
    onConquer: (state, ownerIndex) => {
      const owner = state.players[ownerIndex];
      if (!owner.legend.exhausted) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ownerIndex] = { ...owner, legend: { ...owner.legend, exhausted: false } };
      return { ...state, players };
    },
  },
  "OGS-019": {
    // Master Yi - Wuju Bladesman — "While a friendly unit defends alone, it
    // gets +2 Might." DEFENDS, not "attacks or defends": the Java oracle
    // audited its own implementation and found it had been applying the bonus
    // while attacking too, from an assumption never checked against the card
    // (LegendAbilities.java:135-139 records that fix and the rename to
    // soloDefenseBonus). Ported from the corrected version.
    mightBonus: (state, _unit, ownerIndex, ctx) => {
      if (!ctx.isCombat || ctx.isAttackingSide !== false || ctx.battlefieldId === undefined) return 0;
      const bf = state.battlefields.find((b) => b.id === ctx.battlefieldId);
      const ownHere = bf?.units[state.players[ownerIndex].id] ?? [];
      return ownHere.length === 1 ? 2 : 0;
    },
  },
};

/**
 * Sett - The Boss's replacement offer, or undefined when it does not apply —
 * "If a buffed unit you control would die, you may pay [rainbow Power], exhaust
 * me, and spend its buff to heal it, exhaust it, and recall it instead."
 *
 * Called from `killUnit` BEFORE the trash step. Every condition here is a cost
 * or a printed restriction, and all four must hold or the question is not worth
 * asking — offering a replacement nobody can pay would stall a death on a
 * prompt whose only real answer is "no":
 *
 *  - **a buffed unit** — the buff is spent as part of the price (702.2.b).
 *  - **you control** — his controller's own units, not anyone's.
 *  - **exhaust me** — so an exhausted Sett has already been used this turn.
 *    (His other clause, "when you conquer, ready me", is what buys a second.)
 *  - **pay rainbow Power** — priced through the same `computeAutoPayment` call
 *    Hide uses for its own rainbow pip, so "can I afford it" has one answer.
 *
 * Returns undefined rather than a state so `killUnit` can tell "no offer" from
 * "offered and now waiting", which a no-op state could not express.
 */
export function offerDeathReplacement(state: GameState, death: PendingDeath): GameState | undefined {
  const owner = state.players[death.ownerIndex];
  if (owner.legend.defId !== SETT_THE_BOSS) return undefined;
  if (!death.unit.buffed || owner.legend.exhausted) return undefined;
  // `null`, not undefined — computeAutoPayment's own failure value. Comparing
  // against undefined here made an unpayable cost read as payable, so a player
  // with no runes at all was still offered the save.
  if (computeAutoPayment(owner.channeled, 0, SETT_POWER_COST, RAINBOW) === null) return undefined;

  const held: GameState = {
    ...state,
    unitsAwaitingDeathReplacement: [...state.unitsAwaitingDeathReplacement, death],
  };
  return parkDecision(held, {
    kind: "OGN-269-save",
    playerIndex: death.ownerIndex,
    targetInstanceId: death.unit.instanceId,
  });
}

const SETT_THE_BOSS = "OGN-269";
const SETT_POWER_COST = 1;

/**
 * Questions this file's Legends stop to ask — composed into engine/decisions.ts
 * alongside the per-domain ones.
 *
 * They live HERE rather than in an `effects/<domain>.ts` file for the same
 * reason the abilities do: every Legend is dual-domain by definition, so filing
 * one by domain is meaningless, and separating a legend's question from the
 * ability that raises it is how the two drift.
 *
 * Same `<defId>-<what it asks>` key convention as the per-domain decisions.
 */
export const legendDecisions: Record<string, DecisionDefinition> = {
  // Leona - Radiant Dawn's "buff a friendly unit" — see her entry above.
  "OGN-261-buff": {
    prompt: () => "Leona - Radiant Dawn: buff a friendly unit",
    // "A friendly unit" names no battlefield, so a unit in base is as eligible
    // as one at a battlefield (355.9.a.1). Already-buffed units are still offered:
    // 702.3.a makes a second buff a no-op rather than an illegal choice, and
    // filtering them here would silently change "buff a friendly unit" into
    // "buff an unbuffed friendly unit" — which matters when everything you
    // control is already buffed and the answer really is "nothing happens".
    options: (state, d) => {
      const owner = state.players[d.playerIndex];
      return [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])].map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      }));
    },
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },

  // Volibear - Relentless Storm's "you may exhaust me to channel 1 rune
  // exhausted" — see his entry above, which has already checked that the unit
  // played was Mighty and that he is still ready.
  //
  // Two options always, never one: a "you may" the engine answers for you is not
  // a "you may", and `advanceDecisions` auto-resolves anything with a single
  // option. Exhausting Volibear costs a later turn's use, so declining is a real
  // play rather than a formality.
  "SFD-203-gold": {
    prompt: () => "Sivir - Battle Mistress: exhaust her to play a Gold gear token exhausted?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!state.players[d.playerIndex].legend.exhausted) {
        options.push({ id: "gold", label: "Exhaust Sivir for a Gold" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "gold") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return placeGoldTokens({ ...state, players }, d.playerIndex, 1);
    },
  },

  "SFD-205-channel": {
    prompt: () => "Fiora - Grand Duelist: exhaust her to channel 1 rune exhausted?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!state.players[d.playerIndex].legend.exhausted) {
        options.push({ id: "channel", label: "Exhaust Fiora and channel 1" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "channel") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      // EXHAUSTED, not Ready — the rune can pay a Power cost this turn (a Power
      // payment recycles regardless of state) but no Energy until the next
      // Awaken. Same helper Volibear - Relentless Storm uses, and the same
      // printed wording.
      return channelRunesExhausted({ ...state, players }, d.playerIndex, 1);
    },
  },

  "UNL-193-draw": {
    // The decline leads, exactly as Renata's does: this is a "you MAY", so a
    // mis-click and the AI's tie-break both land on doing nothing.
    prompt: () => "Vex - Gloomist: exhaust her to draw 1?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!state.players[d.playerIndex].legend.exhausted) {
        options.push({ id: "draw", label: "Exhaust Vex to draw 1" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "draw") return state;
      const owner = state.players[d.playerIndex];
      // Re-checked at ANSWER time, not trusted from the option list: the question
      // waits on the chain, and the Legend can be exhausted by something else
      // while it does. Renata's entry makes the same re-check for the same reason.
      if (owner.legend.exhausted) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return drawCards({ ...state, players }, d.playerIndex, 1);
    },
  },
  "SFD-201-gold": {
    prompt: () => "Renata Glasc - Chem-Baroness: exhaust her to play a Gold gear token exhausted?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!state.players[d.playerIndex].legend.exhausted) {
        options.push({ id: "gold", label: "Exhaust Renata for a Gold" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "gold") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      // "EXHAUSTED" is printed, and `placeGoldTokens` already mints them that way
      // — 149.1 enters gear READY, so the sixteen cards printing "exhausted" are
      // the ones overriding a default (184.1). Renata - INDUSTRIALIST's "your
      // tokens enter ready" is a replacement effect that would override it right
      // back; she is a different card and not in play here by definition.
      return placeGoldTokens({ ...state, players }, d.playerIndex, 1);
    },
  },

  "SFD-187-look": {
    prompt: () => "Rek'sai - Void Burrower: exhaust her to reveal the top 2 of your deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const owner = state.players[d.playerIndex];
      // Nothing to reveal is nothing to pay for — an empty deck makes the whole
      // ability a no-op, so the exhaust is not offered for it.
      if (!owner.legend.exhausted && owner.deck.length > 0) {
        options.push({ id: "look", label: "Exhaust Rek'sai and reveal 2" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "look") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      // The reveal itself is not a state change — this engine has no per-player
      // hidden view of a deck, so what the NEXT decision offers IS the reveal.
      // Void Rush records the same reading.
      return parkDecision({ ...state, players }, { kind: "SFD-187-banish", playerIndex: d.playerIndex });
    },
  },

  "SFD-187-banish": {
    prompt: () => "Rek'sai - Void Burrower: banish one and play it? (the rest are recycled)",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline (recycle both)" }];
      for (const card of state.players[d.playerIndex].deck.slice(0, REKSAI_REVEAL)) {
        // Priced when the OPTIONS are built, at FULL cost — this card grants no
        // discount. A card that cannot be paid for is never offered.
        if (reksaiPayment(state, d.playerIndex, card) === undefined) continue;
        options.push({ id: card.instanceId, label: `Banish and play ${card.name}`, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      const revealed = state.players[d.playerIndex].deck.slice(0, REKSAI_REVEAL);
      const named = optionId === "decline" ? undefined : revealed.find((c) => c.instanceId === optionId);
      // Re-paid rather than trusted from an option list built against an earlier
      // state: if the pool drained inside the response window nothing is banished
      // and everything is recycled, which withholds the payoff rather than handing
      // it over free. Void Rush makes the same call.
      const paid = named ? reksaiPayment(state, d.playerIndex, named) : state;
      const chosen = paid ? named : undefined;
      const base = paid ?? state;

      // Every revealed card comes off the top first, whichever way this went — a
      // Spell played below can draw, and leaving one on top would let it be drawn
      // when the card says it was recycled.
      const recycled = revealed.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...base.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        // "RECYCLE the rest" — bottom of the deck (416), not the trash and not the
        // hand. That is the whole difference from Void Rush's "draw any you didn't
        // banish".
        deck: [...players[d.playerIndex].deck.slice(revealed.length), ...recycled],
        // "PLAY it" — a card you played, so [Legion] and Viktor - Innovator see it.
        ...(chosen ? { cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1 } : {}),
      };
      const offDeck: GameState = { ...base, players };
      if (!chosen) return holdCardsRecycled(offDeck, d.playerIndex, recycled.length);

      // The banish is transient — banished and played in one instruction — so the
      // card goes straight to play rather than through `PlayerState.banished`.
      // Inherits play-free.ts's recorded divergence: a SPELL played this way
      // resolves immediately and with no targets, because nothing announced it.
      const played = playCardIgnoringCost(offDeck, d.playerIndex, chosen);
      return holdCardsRecycled(played, d.playerIndex, recycled.length);
    },
  },

  /**
   * Irelia's first clause — "you may exhaust me and pay [rainbow] to ready it".
   *
   * TWO costs, and both are re-derived at answer time rather than trusted from
   * the offer: a response window sits between them, and either the Legend or the
   * Power can be gone by the time this resolves. `payPowerFromChanneled` with
   * `RAINBOW` is the same any-domain pip rule 811 and Sett - The Boss use.
   *
   * The chosen unit is looked up again too, for the reason 359.3 gives: a check
   * on something no longer available is ignored, so a unit that died inside the
   * window simply is not readied — and the cost is NOT paid for nothing.
   */
  "SFD-195-ready-chosen": {
    prompt: (state, d) => {
      const unit = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId)?.unit : undefined;
      return `Irelia - Blade Dancer: exhaust her and pay [rainbow] to ready ${unit?.name ?? "it"}?`;
    },
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const owner = state.players[d.playerIndex];
      const stillThere = d.cardInstanceId !== undefined && findUnitAnywhere(state, d.cardInstanceId) !== undefined;
      // Offered only when every part of the price can be paid AND there is still
      // something to ready — the "never offer what cannot be taken" rule this
      // file already applies to Volibear and Sett.
      if (stillThere && !owner.legend.exhausted && payPowerFromChanneled(state, d.playerIndex, RAINBOW, 1)) {
        options.push({ id: "ready", label: "Exhaust Irelia and pay [rainbow]" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "ready" || d.cardInstanceId === undefined) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, RAINBOW, 1);
      if (!paid) return state;
      const owner = paid.players[d.playerIndex];
      if (owner.legend.exhausted) return state;
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return readyUnit({ ...paid, players }, d.cardInstanceId);
    },
  },

  /**
   * Irelia's second clause — "when you conquer, you may pay [1] to ready me".
   *
   * Deliberately offered to an EXHAUSTED Irelia: readying her is what the clause
   * does, so refusing it while she is exhausted would make it unusable exactly
   * when it is worth using. It is her first clause that gates on the exhaust,
   * because there the exhaust is the COST.
   */
  "SFD-195-ready-me": {
    prompt: () => "Irelia - Blade Dancer: pay [1] to ready her?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Already ready — the payment would buy nothing, so it is not offered.
      if (!state.players[d.playerIndex].legend.exhausted) return options;
      if (payEnergyFromPool(state, d.playerIndex, IRELIA_READY_COST)) {
        options.push({ id: "ready", label: "Pay [1] and ready Irelia" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "ready") return state;
      const paid = payEnergyFromPool(state, d.playerIndex, IRELIA_READY_COST);
      if (!paid) return state;
      const owner = paid.players[d.playerIndex];
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: false } };
      return { ...paid, players };
    },
  },

  "OGN-249-channel": {
    prompt: () => "Volibear - Relentless Storm: exhaust him to channel 1 rune exhausted?",
    options: () => [
      { id: "channel", label: "Exhaust and channel 1" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "channel") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      // Exhausted, not Ready — the rune can pay a Power cost this turn (a Power
      // payment recycles regardless of state) but no Energy until the next
      // Awaken. Same helper Stormclaw Ursine and Soaring Scout use.
      return channelRunesExhausted({ ...state, players }, d.playerIndex, 1);
    },
  },

  /**
   * Sett - The Boss's "heal it, exhaust it, and recall it instead" — raised by
   * `offerDeathReplacement` above, which has already checked that every part of
   * the price can be paid.
   *
   * The two branches are genuinely different events, not two spellings of one:
   *  - **Save** replaces the death, so 808.1.d.1 applies and the unit's
   *    [Deathknell] never fires and no death-watch sees it. It simply never died.
   *  - **Let it die** resumes the ordinary death at `completeDeath` — trash,
   *    then triggers — rather than re-entering `killUnit`, which would offer the
   *    same replacement again and never terminate.
   */
  "OGN-269-save": {
    prompt: (state, d) => {
      const held = pendingDeathFor(state, d.targetInstanceId);
      return `Sett - The Boss: save ${held?.unit.name ?? "your unit"} instead of letting it die?`;
    },
    // Moot if the held death has gone (nothing to answer about) — returning no
    // options is how decisions.ts drops a question that no longer applies.
    options: (state, d) =>
      pendingDeathFor(state, d.targetInstanceId)
        ? [
            { id: "save", label: "Pay 1 Power, exhaust Sett, spend its buff" },
            { id: "die", label: "Let it die" },
          ]
        : [],
    resolve: (state, d, optionId) => {
      const held = pendingDeathFor(state, d.targetInstanceId);
      if (!held) return state;
      const released = releasePendingDeath(state, held.unit.instanceId);
      if (optionId !== "save") return completeDeath(released, held);

      // Pay first, and bail to the ordinary death if it cannot be paid after all
      // — the board can have changed between the offer and the answer, and a
      // half-paid replacement would hand over the save for free.
      const paid = payPowerFromChanneled(released, d.playerIndex, RAINBOW, SETT_POWER_COST);
      if (paid === undefined) return completeDeath(released, held);

      const owner = paid.players[d.playerIndex];
      const players = [...paid.players] as [PlayerState, PlayerState];
      // "heal it, exhaust it" — and spend its buff, which is part of the cost
      // rather than rule 705's leave-play cleanup: the unit never leaves play.
      const saved: UnitInstance = { ...held.unit, damage: 0, exhausted: true, buffed: false };
      players[d.playerIndex] = {
        ...owner,
        legend: { ...owner.legend, exhausted: true },
        baseUnits: [...owner.baseUnits, saved],
      };
      // A recall, not a move (454) — so no contest check and no on-move trigger.
      return { ...paid, players };
    },
  },
};

function abilitiesFor(state: GameState, ownerIndex: 0 | 1): LegendAbilityDefinition | undefined {
  return LEGEND_ABILITIES[state.players[ownerIndex].legend.defId];
}

/** Fires the ending player's Legend end-of-turn ability, if any. Called from
 *  runEnd BEFORE the active player rotates, so "your turn" means theirs. */
/** Every Legend defId with a registered ability — see engine/coverage.ts, which
 *  uses it to tell implemented cards from silently-inert ones. */
export function legendAbilityDefIds(): string[] {
  return Object.keys(LEGEND_ABILITIES);
}

/**
 * The keys of `LegendAbilityDefinition` that are NOT triggered abilities.
 *
 * A deliberately tiny denylist rather than a list of the trigger hooks, because
 * the failure this exists to prevent is a NEW hook being added and silently
 * missing from a census. Anything unrecognised counts as a trigger, so a new
 * `onWhatever` is included the day it is written; a new CONTINUOUS entry has to
 * be named here, and `trigger-census.test.ts` fails until it is.
 *
 * - `mightBonus` is a continuous modifier recomputed inside effective-might.ts.
 *   It dispatches nothing, and counting it is precisely how "9 Legend abilities"
 *   became a wrong answer to "how many Legend triggers" — Master Yi's only entry
 *   is this one.
 * - `conquerCondition` is a MODIFIER of `onConquer` (383.4's "a requirement
 *   besides the trigger"), not an ability of its own.
 */
const NON_TRIGGER_KEYS: ReadonlySet<string> = new Set(["mightBonus", "conquerCondition"]);

/** The key that is still dispatched INLINE — `dispatchLegendBeginningPhase`
 *  rather than the held adapter — because holding it would resolve
 *  Beginning-Phase abilities after `scoreHolds`. */
const INLINE_TRIGGER_KEYS: ReadonlySet<string> = new Set(["onBeginningPhase"]);

const triggerKeysOf = (ability: LegendAbilityDefinition): string[] =>
  Object.keys(ability).filter((key) => !NON_TRIGGER_KEYS.has(key));

/**
 * Legend defIds carrying a TRIGGERED ability, which is not the same question as
 * `legendAbilityDefIds` above — that one returns the table's KEYS, so it counts
 * Master Yi, whose only entry is a continuous `mightBonus`.
 *
 * Counting a table's keys and counting its dispatch shapes are two different
 * wrong answers to "how many cards", and this repo has given both.
 */
export function legendTriggerDefIds(): string[] {
  return Object.entries(LEGEND_ABILITIES)
    .filter(([, ability]) => triggerKeysOf(ability).length > 0)
    .map(([defId]) => defId);
}

/** Of those, the ones with a hook that still resolves at its source. */
export function legendInlineTriggerDefIds(): string[] {
  return Object.entries(LEGEND_ABILITIES)
    .filter(([, ability]) => triggerKeysOf(ability).some((key) => INLINE_TRIGGER_KEYS.has(key)))
    .map(([defId]) => defId);
}

/** Every distinct hook key in use, for the census to assert against — a new one
 *  forces a decision about which side of the held/inline line it falls on. */
export function legendTriggerKeysInUse(): string[] {
  return [...new Set(Object.values(LEGEND_ABILITIES).flatMap((a) => Object.keys(a)))].sort();
}

/**
 * The Legend hooks whose moment is ALREADY a held event, presented to
 * triggers.ts as ordinary listeners — so a Legend's triggered ability is a Chain
 * Pending Item (383) like every other one, respondable before it resolves.
 *
 * **What this needed was not a registry but a WALK.** `resolvePendingTrigger`
 * re-looks its listener up by instance id through `allListeningPermanents`, and
 * that walk covered base units, battlefield units, active Gear and two trash
 * cards — never `players[i].legend`. A held Legend trigger would therefore have
 * resolved to nothing, silently, which is why this conversion was blocked and
 * said so in three separate source comments. `listeningPermanents` now ends with
 * the Legend; everything here follows from that.
 *
 * **Every hook this adapter destructures is now HELD.** `onBeginningPhase` is the
 * only one left inline, and it never comes through here at all —
 * `dispatchLegendBeginningPhase` dispatches it directly, because holding it would
 * resolve Beginning-Phase abilities after `scoreHolds`.
 *
 * This list used to say four of eight were blocked, and **all three of the other
 * blockers are gone** — `spellCast` and `unitsStunned` became `HeldEventKind`s,
 * and Volibear's was never real (see the `onUnitPlayed` clause below, which says
 * so). The stale version outlived the fixes by days and was corrected only by an
 * audit, in three places at once: here, and two rows of
 * docs/rules-conformance.md. **A comment listing what is BLOCKED is a note about
 * the engine as it was that day** — the shape this repo has now recorded against
 * `PARTIALLY_IMPLEMENTED`, the Divergent table and the verification loop. If you
 * unblock something, grep for the note that said it was blocked.
 *
 * `mightBonus` is not a trigger at all — it is a continuous modifier recomputed
 * inside effective-might.ts — so Master Yi is not in this adapter and is not a
 * Legend "still inline" either. Counting the table's KEYS reports him as one,
 * which is the count-by-dispatch-shape mistake in miniature.
 */
/**
 * One converted hook, before the per-Legend clauses are folded into a single
 * registry entry. Its `on` is a single kind — the fold below is what turns N of
 * these into one definition with a LIST.
 */
interface LegendClause {
  on: GameEvent["kind"];
  applies: NonNullable<EventTriggerDefinition["applies"]>;
  /** Ahri places ONE Pending Item per attacking unit, each carrying the unit it
   *  is about. Carried through the fold rather than dropped — a clause that lost
   *  its `captureEach` would silently collapse N triggers into one. */
  capture?: EventTriggerDefinition["capture"];
  captureEach?: EventTriggerDefinition["captureEach"];
  resolve: EventTriggerDefinition["resolve"];
}

export function legendEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> } {
  // **This used to THROW on a Legend's second convertible hook**, with a comment
  // saying "none has two today; the throw is so the day one does is the day it is
  // noticed". That day is now: **Irelia - Blade Dancer** prints "when you choose
  // a friendly unit" AND "when you conquer", and **Sivir - Battle Mistress**
  // prints "when you recycle a rune" AND "when one or more enemy units die".
  //
  // The fix has precedent and needs no new mechanism: `EventTriggerDefinition.on`
  // already accepts a LIST, widened for Corrupt Enforcer and Draven - Vanquisher
  // — the same one-defId-two-clauses problem, solved the same way. Its own
  // comment records WHY the list beats two definitions: `resolvePendingTrigger`
  // finds a definition by `listenerDefId` alone, so two entries per card would
  // need the chain item to say which, and an entry that cannot say resolves the
  // wrong half. One definition that branches on `event.kind` cannot get it wrong.
  const clauses: Record<string, LegendClause[]> = {};
  const add = (defId: string, clause: LegendClause) => {
    (clauses[defId] ??= []).push(clause);
  };

  for (const [defId, ability] of Object.entries(LEGEND_ABILITIES)) {
    const {
      onEndOfTurn,
      onConquer,
      conquerCondition,
      onEnemyUnitAttacks,
      onUnitsStunned,
      onSpellCast,
      onUnitPlayed,
      onCombatWon,
      onUnitChosen,
      onBattlefieldHeld,
      onUnitBecameMighty,
      onRunesRecycled,
      onEnemyUnitDied,
    } = ability;

    if (onEndOfTurn) {
      add(defId, {
        on: "endOfTurn",
        // Whose turn ended is taken from the EVENT, never from
        // `state.activePlayerIndex`: a turn-boundary trigger sits in the pen
        // across the rotation and resolves under the next player.
        applies: (_state, listener, event) => event.kind === "endOfTurn" && event.playerIndex === listener.ownerIndex,
        resolve: (state, listener, event) => (event.kind === "endOfTurn" ? onEndOfTurn(state, listener.ownerIndex) : state),
      });
    }

    if (onConquer) {
      add(defId, {
        on: "battlefieldConquered",
        applies: (state, listener, event) =>
          event.kind === "battlefieldConquered" &&
          event.conquerorIndex === listener.ownerIndex &&
          (conquerCondition?.(state, listener.ownerIndex, event.battlefieldId) ?? true),
        resolve: (state, listener, event) =>
          event.kind === "battlefieldConquered" ? onConquer(state, listener.ownerIndex, event.battlefieldId) : state,
      });
    }

    if (onRunesRecycled) {
      add(defId, {
        on: "runesRecycled",
        applies: (state, listener, event) =>
          event.kind === "runesRecycled" &&
          event.ownerIndex === listener.ownerIndex &&
          !state.players[listener.ownerIndex].legend.exhausted,
        resolve: (state, listener, event) =>
          event.kind === "runesRecycled" ? onRunesRecycled(state, listener.ownerIndex, event.count) : state,
      });
    }

    if (onEnemyUnitDied) {
      add(defId, {
        on: "unitDied",
        // "When one or more ENEMY units die" — the dying unit must not be the
        // listener's. `unitDied` fires per death, so a sweep that kills three
        // enemies places three Pending Items; readying an already-ready Legend is
        // idempotent, so that is harmless here rather than a triple payout. Said
        // out loud because the batch-event trap in this codebase is the opposite
        // case, where per-item firing DOUBLE-PAYS.
        //
        // No exhaust gate: readying her IS the effect, so an exhausted Sivir is
        // exactly who this clause is for.
        applies: (_state, listener, event) =>
          event.kind === "unitDied" && event.death.ownerIndex !== listener.ownerIndex,
        resolve: (state, listener, event) => (event.kind === "unitDied" ? onEnemyUnitDied(state, listener.ownerIndex) : state),
      });
    }

    if (onUnitBecameMighty) {
      add(defId, {
        on: "unitBecameMighty",
        // "One of YOUR units", and the exhaust must be payable — an offer nobody
        // can take is not made, the rule this file applies throughout.
        applies: (state, listener, event) =>
          event.kind === "unitBecameMighty" &&
          event.ownerIndex === listener.ownerIndex &&
          !state.players[listener.ownerIndex].legend.exhausted,
        resolve: (state, listener, event) =>
          event.kind === "unitBecameMighty" ? onUnitBecameMighty(state, listener.ownerIndex, event.unitInstanceId) : state,
      });
    }

    if (onBattlefieldHeld) {
      add(defId, {
        on: "battlefieldHeld",
        // The holder must be the Legend's owner, and the exhaust cost must be
        // payable — an offer nobody can take is not made, the rule this file
        // applies to Volibear, Irelia and Rek'sai alike.
        applies: (state, listener, event) =>
          event.kind === "battlefieldHeld" &&
          event.holderIndex === listener.ownerIndex &&
          !state.players[listener.ownerIndex].legend.exhausted,
        resolve: (state, listener, event) =>
          event.kind === "battlefieldHeld" ? onBattlefieldHeld(state, listener.ownerIndex, event.battlefieldId) : state,
      });
    }

    if (onUnitChosen) {
      add(defId, {
        on: "unitChosen",
        // "When YOU choose a FRIENDLY unit" — the chooser must be the Legend's
        // owner, and the unit must be theirs too. Both are settled at fire time
        // (383.4): a unit that changes hands inside the response window was still
        // friendly when it was chosen.
        //
        // The exhaust COST is checked here as well, for the reason Volibear's
        // records: an offer nobody can pay is not made, so an already-exhausted
        // Irelia places no Pending Item at all.
        applies: (state, listener, event) => {
          if (event.kind !== "unitChosen" || event.chooserIndex !== listener.ownerIndex) return false;
          if (state.players[listener.ownerIndex].legend.exhausted) return false;
          const chosen = findUnitAnywhere(state, event.unitInstanceId);
          return chosen !== undefined && chosen.ownerIndex === listener.ownerIndex;
        },
        resolve: (state, listener, event) =>
          event.kind === "unitChosen" ? onUnitChosen(state, listener.ownerIndex, event.unitInstanceId) : state,
      });
    }

    if (onUnitsStunned) {
      add(defId, {
        on: "unitsStunned",
        // Leona's "when you stun ONE OR MORE enemy units" — both halves read only
        // the event and the Legend's owner, so they settle at fire time. The
        // ability itself then pays out ONCE however many were stunned, which is
        // the whole reason `unitsStunned` is a batch event rather than per unit.
        applies: (_state, listener, event) =>
          event.kind === "unitsStunned" &&
          event.stunnerIndex === listener.ownerIndex &&
          event.stunned.some((s) => s.ownerIndex !== listener.ownerIndex),
        resolve: (state, listener, event) =>
          event.kind === "unitsStunned" ? onUnitsStunned(state, listener.ownerIndex, event) : state,
      });
    }

    if (onSpellCast) {
      add(defId, {
        on: "spellCast",
        // "When you play a spell that costs 5 or more" — the caster and the
        // threshold are both facts about the event, so both settle at fire time.
        // The threshold lives in the BODY as well, and that is not a duplicate to
        // remove: `onSpellCast` is still the hook's own contract, and nothing here
        // may quietly become the only place a printed number is written down.
        applies: (_state, listener, event) =>
          event.kind === "spellCast" && event.casterIndex === listener.ownerIndex && event.totalCost >= 5,
        resolve: (state, listener, event) =>
          event.kind === "spellCast" ? onSpellCast(state, listener.ownerIndex, event.totalCost) : state,
      });
    }

    if (onUnitPlayed) {
      add(defId, {
        on: "cardPlayed",
        // **The recorded blocker for this hook was wrong.** It said Volibear
        // "needs the played unit, which `cardPlayed` does not carry" — but the
        // event carries `playedInstanceId`, and his body already looked the unit
        // up on the BOARD by id rather than reading the instance it was handed,
        // deliberately, so that a 4-Might unit under a Garen aura counts as
        // Mighty. Nothing new was needed.
        //
        // **That last claim was itself false until 2026-08-08**, and it is worth
        // leaving the correction beside the correction it corrects. Looking the
        // unit up on the board is necessary but was not sufficient: `isMighty`
        // asked `effectiveMight` with no `battlefieldId`, so a POSITIONAL aura —
        // which Garen - Commander's "+1 Might **here**" is — was not counted, and
        // the 4-Might unit standing beside him did not qualify. Fixed in
        // `granted-keywords.isMighty`, which now passes the unit's location.
        //
        // [Mighty] and "you may exhaust me" are both settled here: the first is
        // the trigger's own condition (383.4), and the second is its COST — an
        // exhausted Legend cannot pay, and an offer nobody can take is not made.
        applies: (state, listener, event) =>
          event.kind === "cardPlayed" &&
          event.playedKind === "Unit" &&
          event.casterIndex === listener.ownerIndex &&
          !state.players[listener.ownerIndex].legend.exhausted &&
          isMightyById(state, event.playedInstanceId),
        resolve: (state, listener, event) =>
          event.kind === "cardPlayed"
            ? onUnitPlayed(state, listener.ownerIndex, { unit: { instanceId: event.playedInstanceId } as UnitInstance, casterIndex: event.casterIndex })
            : state,
      });
    }

    if (onCombatWon) {
      add(defId, {
        on: "combatWon",
        // Positional only in the sense that it is HIS combat: the event
        // already carries the winner, so this asks nothing about the board.
        applies: (_state, listener, event) => event.kind === "combatWon" && event.winnerIndex === listener.ownerIndex,
        resolve: (state, listener, event) =>
          event.kind === "combatWon" ? onCombatWon(state, listener.ownerIndex, event.battlefieldId) : state,
      });
    }

    if (onEnemyUnitAttacks) {
      add(defId, {
        on: "combatBegan",
        // "When an ENEMY unit attacks a battlefield YOU CONTROL" — both halves
        // are requirements besides attacking, so 383.4.e settles them when the
        // designation is handed out, not when the ability resolves. Without this
        // the Legend would place a Pending Item at every combat on the board.
        applies: (state, listener, event) => attackersAgainst(state, listener.ownerIndex, event).length > 0,
        // ONE Pending Item PER attacking unit. Her text is singular — "when an
        // ENEMY UNIT attacks" — and 464.2.c Step 1 designates every unit of the
        // attacking side at the same moment, so this is N triggered abilities
        // that an opponent may answer one at a time, not one that debuffs N.
        //
        // Each carries the unit it is about, noted at fire time: the response
        // window can add or remove units before any of them resolves, and a
        // reinforcement arriving then did not attack.
        captureEach: (state, listener, event) => attackersAgainst(state, listener.ownerIndex, event),
        resolve: (state, listener, event, captured) => {
          if (event.kind !== "combatBegan" || typeof captured !== "string") return state;
          return onEnemyUnitAttacks(state, listener.ownerIndex, {
            unitInstanceId: captured,
            attackerIndex: listener.ownerIndex === 0 ? 1 : 0,
            battlefieldId: event.battlefieldId,
          });
        },
      });
    }
  }

  // Fold each Legend's clauses into ONE definition. A Legend with a single hook
  // gets `on: [oneKind]`, which behaves exactly as the bare kind did — so nothing
  // about the ten single-hook Legends changes.
  //
  // `applies` and `resolve` both re-check the clause's own condition. That is not
  // belt-and-braces: `EventTriggerDefinition.applies` decides whether a Pending
  // Item is PLACED (383.4, settled at the moment of the event), while `resolve`
  // runs a response window later against a board that may have moved — and the
  // registry's own contract says "resolve must still re-check its own
  // conditions". Filtering again here is how a two-clause Legend avoids running
  // the wrong clause's body for an event the other clause matched.
  const entries: Record<string, EventTriggerDefinition> = {};
  for (const [defId, list] of Object.entries(clauses)) {
    const kinds = [...new Set(list.map((c) => c.on))];
    // `capture`/`captureEach` are per-CLAUSE and must NOT be folded by running
    // all of them: they decide how many Pending Items are placed and what each
    // one carries. Ahri's `captureEach` places one per attacking unit, and a fold
    // that ran a second clause's capture for a `combatBegan` would change that
    // count. So the clause that owns one answers only for ITS OWN event kind.
    const capturing = list.find((c) => c.capture !== undefined);
    const capturingEach = list.find((c) => c.captureEach !== undefined);
    entries[defId] = {
      on: kinds,
      ...(capturing
        ? { capture: (state, listener, event) => (event.kind === capturing.on ? capturing.capture!(state, listener, event) : undefined) }
        : {}),
      ...(capturingEach
        ? {
            captureEach: (state, listener, event) =>
              event.kind === capturingEach.on ? capturingEach.captureEach!(state, listener, event) : [],
          }
        : {}),
      applies: (state, listener, event) =>
        list.some((c) => c.on === event.kind && c.applies(state, listener, event)),
      // Folded rather than "first match wins": two clauses on the SAME kind would
      // both be printed clauses of one card and both are owed. None does today —
      // Irelia's and Sivir's pairs are on different kinds — so this is the
      // general form of an unreachable case rather than a guess about one.
      // `captured` is the FOURTH argument and must be forwarded. Dropping it made
      // Ahri place her Pending Items correctly and then resolve every one of them
      // to nothing, because her body reads the captured unit id and bails without
      // it — five tests, all of which said "no debuff" rather than "no trigger".
      resolve: (state, listener, event, captured) =>
        list
          .filter((c) => c.on === event.kind && c.applies(state, listener, event))
          .reduce((next, c) => c.resolve(next, listener, event, captured), state),
    };
  }
  return { name: "engine/legend-abilities.ts", entries };
}

/**
 * The enemy units attacking `ownerIndex`'s battlefield at this combat — the
 * subject of "when an enemy unit attacks a battlefield you control".
 *
 * Empty unless BOTH printed conditions hold: the attacker is someone else, and
 * the battlefield is one `ownerIndex` CONTROLS rather than merely has units at.
 * A contested battlefield with no controller gives nothing, which is what makes
 * Ahri a defensive Legend rather than a general attack tax.
 */
/** Is the unit with this instance id [Mighty] (5+ Might, rule 708) as it stands
 *  on the board right now? Read through `effectiveMight`, so an aura counts —
 *  which is why the id is looked up rather than trusting a captured instance. */
function isMightyById(state: GameState, instanceId: string): boolean {
  const location = findUnitAnywhere(state, instanceId);
  return location !== undefined && isMighty(state, location.unit, location.ownerIndex);
}

function attackersAgainst(state: GameState, ownerIndex: 0 | 1, event: GameEvent): string[] {
  if (event.kind !== "combatBegan") return [];
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  if (!bf || bf.controllerId !== state.players[ownerIndex].id) return [];
  if (bf.contestedByIndex === null || bf.contestedByIndex === ownerIndex) return [];
  // Only the units gaining the Attacker designation at THIS moment — "when an
  // enemy unit attacks" is the gaining, so a reinforcement walking into a fight
  // she has already taxed triggers her once more, for itself alone.
  return (bf.units[state.players[bf.contestedByIndex].id] ?? [])
    .map((u) => u.instanceId)
    .filter((id) => event.designated.includes(id));
}

/** This unit's owner's Legend's continuous Might contribution, if any. */
export function legendMightBonus(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  ctx: LegendMightContext,
): number {
  return abilitiesFor(state, ownerIndex)?.mightBonus?.(state, unit, ownerIndex, ctx) ?? 0;
}

/** Fires the active player's Legend Beginning-Phase ability, if it has one. */
export function dispatchLegendBeginningPhase(state: GameState, ownerIndex: 0 | 1): GameState {
  return abilitiesFor(state, ownerIndex)?.onBeginningPhase?.(state, ownerIndex) ?? state;
}

/**
 * Runs `hook` for both players' Legends, active player first — turn order, the
 * order the rules resolve simultaneous triggers in, and the same order
 * `allListeningPermanents` uses for board listeners.
 *
 * Both players rather than only the one who acted: whose ability it is and whose
 * turn it is are different questions, and "when YOU stun" / "when an ENEMY unit
 * attacks" are conditions for the ability itself to check against the event.
 * Filtering here would make these hooks unusable for the mirror-image card.
 */
function bothLegends(state: GameState, hook: (state: GameState, ownerIndex: 0 | 1) => GameState | undefined): GameState {
  const active = state.activePlayerIndex;
  const other: 0 | 1 = active === 0 ? 1 : 0;
  return [active, other].reduce<GameState>((next, ownerIndex) => hook(next, ownerIndex) ?? next, state);
}
