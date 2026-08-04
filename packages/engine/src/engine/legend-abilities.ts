import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { EventTriggerDefinition, GameEvent } from "./triggers.js";
import type { DecisionDefinition } from "./decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  completeDeath,
  drawCards,
  giveMightThisTurn,
  payPowerFromChanneled,
  readyRunes,
} from "./effect-helpers.js";
import { computeAutoPayment } from "./rune-payment.js";
import { pendingDeathFor, releasePendingDeath } from "./death-ward.js";
import { RAINBOW } from "./hidden.js";
// Rule 711's "Might 5 or greater", already defined once for Fiora - Victorious.
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
    // addBuff, where rule 708's "not placed instead" lives: buffing an already
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
    // [Mighty] is "while it has 5+ Might" (rule 812), so it is asked of the unit
    // as it stands on the board right now — through effectiveMight, so a 4-Might
    // unit played under a Garen - Commander aura counts. Reading printed Might
    // would quietly disagree with what the board shows.
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
 *  - **a buffed unit** — the buff is spent as part of the price (704.1).
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
    // as one at a battlefield (355.9.b). Already-buffed units are still offered:
    // 708 makes a second buff a no-op rather than an illegal choice, and
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
   *  - **Save** replaces the death, so 809.1.b.1 applies and the unit's
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
      // rather than rule 709's leave-play cleanup: the unit never leaves play.
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
 * **Four of the eight Legend trigger hooks convert, and the other four are
 * blocked by their EVENT rather than by being on a Legend** — each is recorded in
 * docs/rules-conformance.md:
 *   - `onBeginningPhase` (Jinx) — `beginningPhase` must stay inline, because
 *     holding it would resolve Beginning-Phase abilities after `scoreHolds`.
 *   - `onSpellCast` (Lux) — there is no held on-spell-cast event kind yet, and
 *     the moment is a chain POP rather than a play.
 *   - `onUnitsStunned` (Leona) — `unitsStunned` is not a `HeldEventKind` yet.
 *   - `onUnitPlayed` (Volibear) — needs the unit that was played, which
 *     `cardPlayed` deliberately does not carry.
 *
 * `mightBonus` is not a trigger at all — it is a continuous modifier recomputed
 * inside effective-might.ts — so Master Yi is not in this adapter and is not a
 * Legend "still inline" either. Counting the table's KEYS reports him as one,
 * which is the count-by-dispatch-shape mistake in miniature.
 */
export function legendEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> } {
  const entries: Record<string, EventTriggerDefinition> = {};
  const add = (defId: string, entry: EventTriggerDefinition) => {
    // A Legend with two convertible hooks would need two registry entries under
    // one defId, which this shape cannot express. None has two today; the throw
    // is so the day one does is the day it is noticed, rather than the day one
    // of its two abilities quietly stops firing.
    if (entries[defId]) throw new Error(`legendEventTriggers: ${defId} has more than one convertible hook`);
    entries[defId] = entry;
  };

  for (const [defId, ability] of Object.entries(LEGEND_ABILITIES)) {
    const { onEndOfTurn, onConquer, conquerCondition, onEnemyUnitAttacks, onUnitsStunned, onSpellCast, onUnitPlayed } = ability;

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

    if (onEnemyUnitAttacks) {
      add(defId, {
        on: "combatBegan",
        // "When an ENEMY unit attacks a battlefield YOU CONTROL" — both halves
        // are requirements besides attacking, so 383.4.f settles them when the
        // designation is handed out, not when the ability resolves. Without this
        // the Legend would place a Pending Item at every combat on the board.
        applies: (state, listener, event) => attackersAgainst(state, listener.ownerIndex, event).length > 0,
        // ONE Pending Item PER attacking unit. Her text is singular — "when an
        // ENEMY UNIT attacks" — and 465 Step 1 designates every unit of the
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
/** Is the unit with this instance id [Mighty] (5+ Might, rule 812) as it stands
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
