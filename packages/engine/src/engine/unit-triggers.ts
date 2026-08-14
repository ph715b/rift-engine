import type { TriggerChainEntry, BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { CardInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
import { targetingForCard, xpWidenedTargetingFor, type TargetingSpec } from "./card-effects.js";
import {
  giveMightThisTurnToOwnUnit,
  channelRunesExhausted,
  dealDamage,
  discardCards,
  addBuff,
  discardThenDraw,
  drawCards,
  dealDamageToAllUnitsAtAllBattlefields,
  dealDamageToEnemyUnitsAtBattlefield,
  destroyUnit,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  stunUnits,
} from "./effect-helpers.js";
import { placeRecruitToken, type TokenDestination } from "./token.js";
import { hasKeyword, keywordOnEntry } from "./granted-keywords.js";
import { effectiveMight } from "./effective-might.js";
import { findUnitOnBattlefield } from "./target-lookup.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { grantsEnemyAlonePlacement, grantsOpenBattlefieldPlacement } from "./board-restrictions.js";
import { domainUnitTriggers, mergeRegistries } from "./effects/index.js";
import { parkDecision } from "./decisions.js";
import { attackerIndexAt, isAttackingAt, isStillHere } from "./combat-designation.js";
import type { EventTriggerDefinition } from "./triggers.js";
import { holdWeaponmasterOffer } from "./equipment.js";

export type UnitPlayDestination = TokenDestination;

/** Everything a Unit's on-play trigger might need, already fully decided
 *  before executePlayCard ever runs (this engine can't pause mid-
 *  resolution to ask — see card-effects.ts's TargetingSpec doc comment for
 *  the same rule applied to Spells). */
export interface UnitTriggerEvent {
  destination: UnitPlayDestination;
  targetUnitInstanceId?: string;
  /** The second unit named by a `unitSlots` spec — Kinkou Monk's "buff up to two
   *  other friendly units", the first UNIT trigger to want two targets. Spells
   *  have carried this since Gentlemen's Duel; the Unit path simply had no card
   *  that needed it, and a field that exists on the action, is validated and is
   *  enumerated but gets dropped on this hop is the exact bug shape this file's
   *  dispatch comment already records twice. */
  secondTargetUnitInstanceId?: string;
  /** The GEAR a `gear`-kind spec named — Akshan - Mischievous' "move an enemy
   *  gear to your base". Its own field for the reason the action's is: a gear
   *  must never reach a reader expecting a unit, and this is the first UNIT
   *  trigger to choose one. */
  targetPermanentInstanceId?: string;
  visionRecycle?: boolean;
  trashCardInstanceId?: string;
  /** The friendly unit named for this card's OPTIONAL additional cost, or
   *  undefined when the caster declined it — the same field a Spell already
   *  carries (see card-effects.ts's OPTIONAL_UNIT_COSTS). Absent here until
   *  Wildclaw Shaman needed it, which forced its "you may" onto the ordinary
   *  target field and lost the decline whenever every friendly unit was buffed. */
  additionalCostUnitInstanceId?: string;
  /** The friendly GEAR spent for an additional cost — Zaun Punk's kill,
   *  Legion Quartermaster's return-to-hand. Its own field for the reason the
   *  action's is: a gear must never reach a reader expecting a unit. */
  additionalCostPermanentInstanceId?: string;
  /** The units spent for a REPEATABLE additional cost (Kraken Hunter's buffs,
   *  Commander Ledros' kills) — a list, so nothing reading the single field
   *  above can be handed four of them. */
  additionalCostUnitInstanceIds?: readonly string[];
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the multi-discards nobody names up front (Jinx, Undercover Agent's
   *  Deathknell) go through discardCards, which asks the player instead. */
  discardCardInstanceId?: string;
  /** Did the caster pay `[Accelerate]`'s optional additional cost (805)? Tasty
   *  Faefolk's whole ability is gated on it, and the choice is made when the
   *  card is paid for — long before the trigger runs — so it has to ride here
   *  rather than be re-derived from a board that no longer remembers. */
  acceleratePaid?: boolean;
  /** Clockwork Keeper's optional Power cost — "if you PAID the additional cost,
   *  draw 1", so the trigger has to know, and only the action does. */
  optionalPowerPaid?: boolean;
  /** Bard - Mercurial's "if you PAID the additional cost" — his whole trigger is
   *  gated on it, and only the action knows: exhausting a Legend leaves the same
   *  mark on the board as an Awaken-less turn does. */
  exhaustLegendPaid?: boolean;
  /** Safety Inspector's "you may spend 3 XP as an additional cost" (204.2) —
   *  "if you paid my additional cost, you don't kill a unit this way", so the
   *  trigger has to know. Only the action does: XP is a bare number on the
   *  player and by the time this resolves it has already been spent, so the
   *  board cannot be asked whether it was spent FOR THIS. */
  optionalXpPaid?: boolean;
}

export interface UnitTriggerDefinition {
  targeting: TargetingSpec;
  resolve: (state: GameState, ctx: EffectContext, unitInstanceId: string, event: UnitTriggerEvent) => GameState;
}

/**
 * Will this card predict as it enters — fanned into two distinct legal PlayCard
 * actions (visionRecycle true/false) by legal-actions.ts, since the choice must
 * be decided in the submitted action rather than asked mid-resolution. Kept as
 * its own axis rather than folded into TargetingSpec, since it is orthogonal
 * (Mystic Poro's targeting is otherwise "none").
 *
 * **Was a hardcoded set of two defIds, and that was the shape of the bug.**
 * `[Vision]` is a keyword, not two cards' text: the rules make it "functionally
 * short for 'When this is played, predict'" with the trigger being *"the permanent
 * entering the Board"*, and Gemcraft Seer grants it to other friendly units. A set
 * keyed by the printed card could never see a granted one, so her aura would have
 * been silently inert — the card resolves, the unit arrives, and nothing looks
 * wrong.
 *
 * Now asks `keywordOnEntry`, which reads the printed keyword AND the auras in
 * play. The same function answers for `validate-play-card`, so the enumerator and
 * the validator cannot drift.
 */
export function unitTriggerHasVisionChoice(state: GameState, playerIndex: 0 | 1, defId: string): boolean {
  const def = defaultCardRegistry().tryGet(defId);
  return def !== undefined && keywordOnEntry(state, playerIndex, def, "Vision");
}

/**
 * Cards whose printed text carves out an exception to the universal
 * "reinforce only" rule (validate-play-card.ts's presence check) — mirrors
 * ActionValidator.validateUnitDirectToBattlefield's own small hardcoded
 * exception list (Sneaky Deckhand/Sai Scout/etc., ActionValidator.java:1306-1319).
 *
 * Keyed to WHICH place the card names, because the pool now has two different
 * grants and they are close to opposites. "You may play me to an open
 * battlefield" (Sneaky Deckhand, Sai Scout) names somewhere empty and
 * uncontrolled; Deadbloom Predator's "You may play me to an occupied enemy
 * battlefield" names somewhere the opponent is standing — which applies
 * Contested and opens a Showdown, and is the whole point of the card.
 *
 * A table rather than a second parallel `canPlayToOccupiedEnemy` predicate: the
 * two call sites are the validator and the enumerator, and them disagreeing is
 * the specific drift that has bitten this codebase before (see
 * mayPlaceWithoutPresence below).
 */
type PlacementGrant =
  | "openBattlefield"
  | "occupiedEnemyBattlefield"
  | "attackingBattlefield"
  /**
   * Arachnoid Horror's "an occupied battlefield **if an enemy unit is alone
   * there**".
   *
   * Distinct from `occupiedEnemyBattlefield` above by a COUNT, and the rules
   * define the word rather than leaving it to reading: **740.2.a** — "A unit is
   * alone when there are no other FRIENDLY units at the same location", with
   * 740.1.a making "friendly" mean sharing a controller. So this asks whether the
   * OPPONENT has exactly one unit there, and says nothing about how many the
   * player being asked has.
   *
   * The obvious reading — "the only unit at the battlefield at all" — is
   * STRICTER than printed and would have refused legal plays wherever the caster
   * already had a body there.
   */
  | "enemyUnitAloneBattlefield"
  /** Stalking Wolf's "you may play me to ITS battlefield" — the only grant
   *  that names a destination relative to the unit paying the card's
   *  additional cost rather than a property of the battlefield itself. */
  | "sacrificedUnitsBattlefield";

const PLACEMENT_GRANTS: Readonly<Record<string, PlacementGrant>> = {
  "OGN-176": "openBattlefield", // Sneaky Deckhand
  "OGN-174": "openBattlefield", // Sai Scout
  "OGN-161": "occupiedEnemyBattlefield", // Deadbloom Predator
  // Rengar - Trophy Hunter — "I can be played to a battlefield where there are
  // enemy units (even if you don't have units there)." Byte-identical to
  // Deadbloom Predator above; the parenthetical is the rule's own reminder that
  // this WIDENS 813's presence requirement rather than replacing it.
  //
  // His `[Ambush]` is separate and already works: that grants Reaction TIMING
  // into a battlefield where you DO have units, which is the other half of the
  // sentence and a different mechanism (timing.ambushReactionAt).
  "UNL-120": "occupiedEnemyBattlefield", // Rengar - Trophy Hunter
  // Stalking Wolf — "As an additional cost to play me, kill a Bird, Cat, Dog, or
  // Poro you control. You may play me to its battlefield (even if you don't have
  // other units there)."
  //
  // Unlike every grant above it, this one is not a question about the
  // battlefield: the SAME battlefield qualifies or not depending on which unit
  // was chosen to pay the cost. So `mayPlaceWithoutPresence` takes the cost unit,
  // and the two callers hand it the choice riding on the action they are judging.
  //
  // His `[Ambush]` is separate and already works, exactly as Rengar's is: that
  // grants Reaction TIMING into a battlefield where you DO have units. This
  // clause is what lets him land where he has nobody — the two halves of the card
  // pull in opposite directions and are deliberately different mechanisms.
  "UNL-166": "sacrificedUnitsBattlefield", // Stalking Wolf
  // Arachnoid Horror — "I can be played to an occupied battlefield if an enemy
  // unit is alone there. FRIENDLY UNITS can be played to an occupied battlefield
  // if an enemy unit is alone there."
  //
  // TWO clauses with one condition, and they need the two different mechanisms
  // this file already keeps apart: the first is a property of the card being
  // played (this row), the second is a property of the BOARD while he is in play
  // (`grantsEnemyAlonePlacement`, the shape Miss Fortune - Buccaneer has).
  "UNL-117": "enemyUnitAloneBattlefield", // Arachnoid Horror
  // SFD-093 Dauntless Vanguard — "You may play me to an occupied enemy
  // battlefield." Byte-identical to Deadbloom Predator above, which is why it
  // is one row and not a card implementation: the validator and the enumerator
  // both already read this table.
  "SFD-093": "occupiedEnemyBattlefield", // Dauntless Vanguard
  // Rengar - Pouncing — "I can be played to a battlefield you're ATTACKING."
  //
  // A GRANT like the three above, and it needs no new field on the action: the
  // Attacker designation is `contestedByIndex`, which is already on the
  // battlefield and is exactly what `attackerIndexAt` reads. His `[Reaction]`
  // timing is the loader's and is what makes the grant reachable at all — a
  // battlefield is only "one you're attacking" while a Showdown is open, and a
  // Default-tier card could never be played then.
  "SFD-025": "attackingBattlefield", // Rengar - Pouncing
};

export function canPlayToOpenBattlefield(defId: string): boolean {
  return PLACEMENT_GRANTS[defId] === "openBattlefield";
}

/** May this player put ANY friendly unit on an open battlefield — the per-card
 *  grant above, OR Miss Fortune - Buccaneer's board-wide one. Hers is not about
 *  which card is being played, which is why it cannot live in that table. */
function anyUnitMayTakeOpenBattlefield(state: GameState, playerIndex: 0 | 1, defId: string): boolean {
  return canPlayToOpenBattlefield(defId) || grantsOpenBattlefieldPlacement(state, playerIndex);
}

/** Is the OPPONENT standing here? Deadbloom Predator's "occupied enemy
 *  battlefield" — occupancy by the enemy specifically, not occupancy in general,
 *  so a battlefield holding only your own units is not a legal destination for
 *  it (that case is already covered by the ordinary presence rule anyway). */
/**
 * Is an enemy unit **alone** at this battlefield — i.e. does the opponent have
 * exactly ONE unit here?
 *
 * **740.2.a is the definition and it is not the obvious one**: "A unit is alone
 * when there are no other friendly units at the same location", where 740.1.a
 * makes two objects friendly if they share a controller. So "alone" is measured
 * against the unit's OWN side only — the asking player's units at the same
 * battlefield are irrelevant, and a reading that required the enemy to be the
 * only unit present would refuse legal plays.
 *
 * "Occupied" in the card's own wording needs no separate test: a battlefield
 * with an enemy unit standing on it is occupied by definition.
 */
function enemyUnitIsAloneAt(state: GameState, playerIndex: 0 | 1, battlefield: BattlefieldState): boolean {
  const opponentId = state.players[1 - playerIndex]!.id;
  return (battlefield.units[opponentId]?.length ?? 0) === 1;
}

function isOccupiedByEnemy(state: GameState, playerIndex: 0 | 1, battlefield: BattlefieldState): boolean {
  const opponentId = state.players[1 - playerIndex]!.id;
  return (battlefield.units[opponentId]?.length ?? 0) > 0;
}

/**
 * Is this battlefield **open**? Rule 170.11.c defines it exactly: "Battlefields
 * can be 'open.' This means they are **unoccupied and uncontrolled**."
 *
 * Both halves, and neither is redundant: a battlefield can be uncontrolled with
 * units standing on it (mid-Showdown, or after a control lapse), and a
 * controlled one can be momentarily empty before the Cleanup lapses it.
 */
export function isOpenBattlefield(battlefield: BattlefieldState): boolean {
  const occupied = Object.values(battlefield.units).some((units) => units.length > 0);
  return !occupied && battlefield.controllerId === null;
}

/**
 * May `defId` be played straight to `battlefield` on the strength of an
 * open-battlefield grant?
 *
 * One predicate rather than the two-part conjunction written out at each call
 * site, because the two sites are the validator and the enumerator and they must
 * never disagree — that specific drift has bitten this codebase before.
 *
 * **This used to be `canPlayToOpenBattlefield` alone**, which asked only whether
 * the CARD had the grant and never whether the battlefield was open. So Sai
 * Scout and Sneaky Deckhand could be played anywhere at all: onto a battlefield
 * you already controlled (reported from playtesting), and — worse — onto one the
 * OPPONENT held, which applies Contested and opens a Showdown, turning "play me
 * to an open battlefield" into a free 5-Might attack.
 *
 * Now asks the grant table which KIND of place the card names, so Deadbloom
 * Predator gets the destination its text describes and not Sai Scout's. Keeping
 * that decision here — rather than letting each call site pick a predicate — is
 * what makes it structurally impossible for the two to diverge.
 */
export function mayPlaceWithoutPresence(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string,
  battlefield: BattlefieldState,
  /** The unit chosen to pay the card's additional cost, when the action names
   *  one. Only `sacrificedUnitsBattlefield` reads it; every other grant is a
   *  property of the battlefield and ignores it. */
  costUnitInstanceId?: string,
): boolean {
  switch (PLACEMENT_GRANTS[defId]) {
    case "openBattlefield":
      return isOpenBattlefield(battlefield);
    case "occupiedEnemyBattlefield":
      return isOccupiedByEnemy(state, playerIndex, battlefield);
    case "enemyUnitAloneBattlefield":
      return enemyUnitIsAloneAt(state, playerIndex, battlefield);
    case "sacrificedUnitsBattlefield": {
      // "ITS battlefield" — where the unit being killed as the cost is standing.
      // A cost unit in BASE widens nothing: a base is not a battlefield, so the
      // Wolf falls back to the ordinary presence rule and can still be played
      // wherever he already has units.
      if (costUnitInstanceId === undefined) return false;
      const at = findUnitOnBattlefield(state, costUnitInstanceId);
      return at !== undefined && at.ownerIndex === playerIndex && state.battlefields[at.battlefieldIndex]?.id === battlefield.id;
    }
    case "attackingBattlefield":
      // "A battlefield you're ATTACKING" — the Attacker designation is 465 Step
      // 1's, i.e. the player who applied Contested, which is the same question
      // `isAttackingAt` asks for the "when I attack" triggers. Asking it through
      // the one function that answers "who is attacking here" is what stops a
      // card that is PLAYED to an attack and a card that TRIGGERS on attacking
      // from disagreeing about who is doing it.
      return attackerIndexAt(state, battlefield.id) === playerIndex;
    default:
      // Miss Fortune - Buccaneer grants the open-battlefield placement to EVERY
      // friendly unit while she is in play, so a card with no grant of its own
      // can still take one. Asked last, so a card that names its own kind of
      // place keeps getting that one — Deadbloom Predator wants an OCCUPIED
      // enemy battlefield, and her grant must not quietly widen him to open ones
      // as well.
      // Arachnoid Horror's SECOND clause rides here for the same reason hers does
      // — "friendly units can be played to..." is a property of the board, not of
      // the card arriving. An OR of the two board-wide grants, each against its
      // own battlefield test, so neither widens the other.
      return (
        (anyUnitMayTakeOpenBattlefield(state, playerIndex, defId) && isOpenBattlefield(battlefield)) ||
        (grantsEnemyAlonePlacement(state, playerIndex) && enemyUnitIsAloneAt(state, playerIndex, battlefield))
      );
  }
}

function applyVision(state: GameState, casterIndex: 0 | 1, recycle: boolean | undefined): GameState {
  if (!recycle) return state; // "keep it on top" — no state change needed
  const actor = state.players[casterIndex];
  if (actor.deck.length === 0) return state;
  const [top, ...rest] = actor.deck;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...actor, deck: [...rest, top!] };
  return { ...state, players };
}

/** Token placement moved to token.ts once a Spell (Recruit the Vanguard)
 *  needed it too — see placeRecruitToken's own doc comment for why it can't
 *  live in either caller. */
const placeTokenAtDestination = placeRecruitToken;

/**
 * On-play-unit triggers — the biggest gap this phase closes:
 * execute-play-card.ts's Unit branch previously never fired anything at
 * all on play, only Spells did (via the chain). Mirrors the Java oracle's
 * UnitAbilities.onPlay dispatch (engine/UnitAbilities.java), keyed by
 * defId instead of printed name like card-effects.ts's CARD_EFFECTS.
 */
const UNIT_TRIGGERS: Record<string, UnitTriggerDefinition> = {
  // Mystic Poro (OGN-171) and Sai Scout (OGN-174) used to sit here, each a
  // `targeting: "none"` entry whose whole body was `applyVision`. They are gone
  // because [Vision] is a KEYWORD and is now fired by `dispatchOnPlayUnit` for
  // any unit that has one — printed or granted. Leaving them would have made
  // those two predict TWICE. Sai Scout's open-battlefield placement is unaffected;
  // it lives in PLACEMENT_GRANTS above.
  "OGS-018": {
    // Tibbers — deal 3 to all units at battlefields, both owners.
    targeting: { kind: "none" },
    resolve: (state, ctx) => dealDamageToAllUnitsAtAllBattlefields(state, ctx.casterIndex, 3),
  },
  "OGN-132": {
    // First Mate — ready another unit. (Its own instanceId can't be a
    // legal target: legal-actions.ts enumerates candidates while this card
    // is still in hand, before it exists anywhere on the board.)
    // The `?:` guards here and below are load-bearing, not defensive noise:
    // a Unit is playable with its trigger's target OMITTED when the board
    // offered no legal one (validate-play-card.ts's targetOmissionAllowed),
    // so these resolvers really do run with nothing to act on.
    // "Ready another unit" names no battlefield, so a unit in base — the
    // likeliest thing you have exhausted — is a legal target.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? readyUnit(state, event.targetUnitInstanceId) : state,
  },
  "OGN-211": {
    // Faithful Manufactor — play a 1-Might Recruit unit token here (its own destination).
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeTokenAtDestination(state, ctx.casterIndex, event.destination),
  },
  "OGN-191": {
    // Maddened Marauder — move a unit from a battlefield to its base (either owner).
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
  },
  "OGS-010": {
    // Annie - Stubborn — return a spell from your own trash to your hand.
    targeting: { kind: "ownTrashCard", cardKind: "Spell" },
    resolve: (state, ctx, _unitId, event) =>
      event.trashCardInstanceId ? returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId) : state,
  },
  "OGN-087": {
    // Lecturing Yordle — "When you play me, draw 1." Its [Tank] keyword is a
    // combat-damage-ordering property (combat.ts), not part of this trigger.
    //
    // Was silently doing nothing despite being in a precon deck: the card is a
    // 3-of in Lux's list, so a real game drew one fewer card than it should
    // roughly every third game. Found by simulating the play and watching the
    // deck size not move, not by reading the code.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "OGN-137": {
    // Stormclaw Ursine — "When you play me, channel 1 rune exhausted." Also
    // [Tank]. Exhausted, so it can pay a Power cost this turn (a Power payment
    // recycles the rune regardless of state) but not an Energy one until Awaken
    // readies it — see channelRunesExhausted.
    targeting: { kind: "none" },
    resolve: (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1),
  },
};

/**
 * Every Unit on-play trigger: the ones written inline above plus whatever the
 * per-domain files under `effects/` contribute, merged with duplicate detection.
 * NEW units belong in `effects/<domain>.ts` — see the note on ALL_CARD_EFFECTS in
 * card-effects.ts for why the inline entries stay put.
 */
/** Composed lazily for the same import-cycle reason as ALL_CARD_EFFECTS in
 *  card-effects.ts — see that comment. */
let composedUnitTriggers: Record<string, UnitTriggerDefinition> | null = null;

function allUnitTriggers(): Record<string, UnitTriggerDefinition> {
  composedUnitTriggers ??= mergeRegistries("unit trigger", [
    { name: "engine/unit-triggers.ts", entries: UNIT_TRIGGERS },
    { name: "engine/effects/*", entries: domainUnitTriggers },
  ]);
  return composedUnitTriggers;
}

export function unitTriggerForCard(defId: string): UnitTriggerDefinition | undefined {
  return allUnitTriggers()[defId];
}

export function targetingForUnitTrigger(defId: string): TargetingSpec {
  return allUnitTriggers()[defId]?.targeting ?? { kind: "none" };
}

/** Every defId with a registered on-play trigger — see cardEffectDefIds. */
export function unitTriggerDefIds(): string[] {
  return [
    ...Object.keys(allUnitTriggers()),
    // The on-move / on-spell-cast registries below are separate dispatch tables
    // with their own event, and reporting only the on-play one marked seven
    // working cards as inert — Crackshot Corsair, Dune Drake, Traveling Merchant,
    // Noxian Drummer, Ravenbloom Student, Lux - Illuminated and Sneaky Deckhand.
    // They're declared here rather than in coverage.ts so a new event table in
    // this file is one edit, not two.
    //
    // ATTACK_TRIGGERS is deliberately NOT in this list any more: it is registered
    // as `combatBegan` listeners now, so `eventTriggerDefIds` reports those eight
    // cards and repeating them here would make one table look like two sources.
    ...Object.keys(ON_MOVE_TRIGGERS),
    ...Object.keys(ON_SPELL_CAST_TRIGGERS),
    ...Object.keys(PLACEMENT_GRANTS),
  ];
}

/** A Unit's targeting comes from its own on-play trigger (this module); a
 *  Spell/Gear's comes from its registered card-effects.ts entry — the two
 *  are separate registries (different resolution mechanism), so this is
 *  the ONE place that branches on card.kind to pick the right one, reused
 *  by validate-play-card.ts, legal-actions.ts, and the web UI, instead of
 *  each re-deriving the same branch independently. */
export function targetingForAnyCard(
  card: CardInstance,
  modeId?: string,
  /**
   * Whether this play PAID its optional XP cost — UNL-140 Conscription's "if you
   * paid the additional cost, choose ANY enemy unit at a battlefield instead".
   *
   * The only optional cost in the pool that changes what may be CHOSEN rather
   * than what happens at resolution, and the reason this function takes an
   * argument at all: both readers (the enumerator's fan-out and
   * `validate-play-card.targetingRejection`) must derive the same spec from the
   * same flag, or a wide target is offered and then refused.
   */
  optionalXpPaid?: boolean,
): TargetingSpec {
  const widened = optionalXpPaid === true ? xpWidenedTargetingFor(card.defId) : undefined;
  if (widened) return widened;
  // A Unit's targeting is its on-play TRIGGER's and has no modes; only a
  // Spell/Gear effect can be modal, which is why the mode goes only to the
  // second branch.
  return card.kind === "Unit" ? targetingForUnitTrigger(card.defId) : targetingForCard(card, modeId);
}

/** True when `card` needs a chosen unit, battlefield, or trash card before
 *  it can resolve — a plain boolean convenience for callers (like the web
 *  UI) that only need to know "does this require a choice," not the full
 *  spec. */
export function cardNeedsTarget(card: CardInstance): boolean {
  const targeting = targetingForAnyCard(card);
  switch (targeting.kind) {
    case "unit":
    case "battlefield":
    case "ownTrashCard":
      return true;
    // "Up to two" (min 0) still needs a choice from the player even though
    // none of it is mandatory — the point of this pass is that WHICH units
    // get hit is theirs to decide, so the card must arm rather than fire.
    case "unitSlots":
    // Same for "any number" (Fox-Fire): the card must ARM so the player picks,
    // rather than fire on click with an empty set. `default: false` would have
    // made it cast instantly and kill nothing, which is a legal play the player
    // never chose — the quiet failure this switch exists to prevent.
    case "unitList":
      return true;
    default:
      return false;
  }
}

/** Fires `unit`'s registered on-play trigger, if any — no-ops for any Unit
 *  with no registered trigger, same safe-no-op convention as
 *  card-effect-resolution.ts's resolveCardEffect. */
export function dispatchOnPlayUnit(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  destination: UnitPlayDestination,
  extra?: {
    targetUnitInstanceId?: string;
    secondTargetUnitInstanceId?: string;
    targetPermanentInstanceId?: string;
    visionRecycle?: boolean;
    trashCardInstanceId?: string;
    additionalCostUnitInstanceId?: string;
    additionalCostPermanentInstanceId?: string;
    additionalCostUnitInstanceIds?: readonly string[];
    discardCardInstanceId?: string;
    acceleratePaid?: boolean;
    optionalPowerPaid?: boolean;
    exhaustLegendPaid?: boolean;
    optionalXpPaid?: boolean;
  },
): GameState {
  // **No Legend dispatch here.** Volibear - Relentless Storm used to be fired
  // from this funnel, and is a HELD `cardPlayed` listener now — a Legend is in
  // `allListeningPermanents`, and the event already carries the played unit's
  // instance id, which is all his ability ever read. Leaving the call here as
  // well would fire him twice for one play.

  // `[Vision]` fires HERE, for any unit that has it, rather than from a
  // per-card entry in the table below.
  //
  // It was two `UNIT_TRIGGERS` entries (Mystic Poro and Sai Scout) calling
  // `applyVision`, which is the wrong shape for a keyword and became wrong in
  // practice the moment Gemcraft Seer granted it: a granted Vision belongs to a
  // card with no entry in that table, or to one whose entry is about something
  // else entirely. Fired from the funnel, it reaches every unit that enters with
  // the keyword however it got it — which is what rule 818's "the trigger is the
  // permanent entering the Board" says.
  //
  // Read off the DEPLOYED unit, so the aura's own source is already in play and
  // the entering unit is already on the board — the moment the rules name. The
  // recycle choice rode in on the action, because this engine cannot pause
  // mid-resolution to ask.
  const withVision = hasKeyword(state, unit, casterIndex, "Vision")
    ? applyVision(state, casterIndex, extra?.visionRecycle)
    : state;

  // Rally the Troops' delayed "when a friendly unit is played this turn, buff
  // it" fires HERE, for the same reason `[Vision]` and `[Weaponmaster]` do:
  // this is the ONE function every unit entering play goes through — all four
  // call sites, paid and free, base and battlefield. A per-site read would be
  // four copies, and this codebase has already shipped the bug where one of
  // several hops forgot a field.
  //
  // Armed by the SPELL and read at the PLAY, which is what makes it delayed —
  // the shape `killDamagedUnitsThisTurn` and `readyRunesAtEndOfTurn` already
  // use, and the one the card's own entry predicted it would need.
  //
  // Buffed ONCE PER RALLY: a count, not a flag. 708 then makes the second buff
  // a no-op because the unit is already buffed, which is a fact about the unit
  // rather than about how many Rallies were cast — so the loop is honest and
  // the rule does the capping.
  //
  // "A FRIENDLY unit" is the caster's own, which `casterIndex` already is.
  const rallies = withVision.players[casterIndex].buffUnitsPlayedThisTurn;
  const withRally = Array.from({ length: rallies }).reduce<GameState>(
    (next) => addBuff(next, unit.instanceId),
    withVision,
  );

  // `[Weaponmaster]` (SFD) fires HERE, for the same reason `[Vision]` does: it
  // is a KEYWORD, so it belongs to the funnel rather than to eleven per-card
  // entries, and firing from the funnel reaches every unit that enters with it
  // however it got there.
  //
  // **It was first hooked in `execute-play-card` and that was UNREACHABLE.** A
  // Unit returns from one of two earlier branches (base play and battlefield
  // play), so the line at the foot of that function narrows to "Spell" | "Gear"
  // and the check could never be true. `tsc` caught it; the unit tests did not,
  // because vitest strips types and the tests called the helper directly. The
  // comment two branches above records the same class of bug on the same
  // function — a field dropped at "both call sites".
  const withWeaponmaster = holdWeaponmasterOffer(withRally, casterIndex, unit);

  // allUnitTriggers(), NOT the inline UNIT_TRIGGERS table: this read used to go
  // straight to the inline one, so a Unit registered in a per-domain effects
  // file validated, cost runes, deployed — and then its ability silently never
  // ran. Nothing caught it because no per-domain file had registered a Unit yet,
  // which is exactly when a per-card implementation pass would have hit it.
  // ── HELD, not resolved (383 / 809.1.b.3) ────────────────────────────────
  //
  // A unit's own "when you play me" ability goes onto the Chain as a Pending
  // Item, becomes respondable when the Cleanup finalizes it, and resolves
  // through `execute-pass-focus` like any other chain item. 48 cards.
  //
  // **The Legend hook and `[Vision]` above stay INLINE, deliberately.** Both are
  // separate families (the 7 legend hooks are their own row in the conformance
  // doc; Vision is a keyword whose "predict" the rules describe as its own
  // trigger), and converting a family at a time is what makes a termination
  // regression bisectable. Recorded as a divergence rather than left implicit.
  //
  // **No card in this pool has BOTH an on-play and an on-attack trigger** —
  // measured, all eight on-attack cards checked — so the ordering inversion this
  // creates (on-attack still resolves inline, i.e. BEFORE a held on-play) is
  // unobservable today. It becomes real for the first card with both.
  const trigger = allUnitTriggers()[unit.defId];
  if (!trigger) return withWeaponmaster;
  return holdUnitTrigger(withWeaponmaster, unit, casterIndex, {
    destination,
    ...(extra?.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: extra.targetUnitInstanceId } : {}),
    ...(extra?.secondTargetUnitInstanceId !== undefined
      ? { secondTargetUnitInstanceId: extra.secondTargetUnitInstanceId }
      : {}),
    // Forwarded for the reason every field beside it is, and this file records
    // the consequence of forgetting twice: enumerated, validated, then dropped on
    // this hop leaves the card paying its cost and doing nothing.
    ...(extra?.targetPermanentInstanceId !== undefined
      ? { targetPermanentInstanceId: extra.targetPermanentInstanceId }
      : {}),
    ...(extra?.visionRecycle !== undefined ? { visionRecycle: extra.visionRecycle } : {}),
    ...(extra?.trashCardInstanceId !== undefined ? { trashCardInstanceId: extra.trashCardInstanceId } : {}),
    ...(extra?.additionalCostUnitInstanceId !== undefined
      ? { additionalCostUnitInstanceId: extra.additionalCostUnitInstanceId }
      : {}),
    // Forwarded for the reason every field beside it is: enumerated,
    // validated, and then dropped on this hop leaves the card paying its cost
    // and doing nothing.
    ...(extra?.additionalCostPermanentInstanceId !== undefined
      ? { additionalCostPermanentInstanceId: extra.additionalCostPermanentInstanceId }
      : {}),
    ...(extra?.additionalCostUnitInstanceIds !== undefined
      ? { additionalCostUnitInstanceIds: extra.additionalCostUnitInstanceIds }
      : {}),
    ...(extra?.discardCardInstanceId !== undefined ? { discardCardInstanceId: extra.discardCardInstanceId } : {}),
    ...(extra?.acceleratePaid !== undefined ? { acceleratePaid: extra.acceleratePaid } : {}),
    ...(extra?.optionalPowerPaid !== undefined ? { optionalPowerPaid: extra.optionalPowerPaid } : {}),
    ...(extra?.exhaustLegendPaid !== undefined ? { exhaustLegendPaid: extra.exhaustLegendPaid } : {}),
    ...(extra?.optionalXpPaid !== undefined ? { optionalXpPaid: extra.optionalXpPaid } : {}),
  });
}

/**
 * Puts one on-play unit trigger in the holding pen, as `holdEventTrigger` does
 * for the event-registry kinds.
 *
 * The listener IS the unit that was just played, so `listenerInstanceId` names
 * it and `battlefieldId` is where it landed — a positional trigger ("an enemy
 * unit HERE") reads that rather than asking the board again, since the unit can
 * be moved or killed while the response window is open.
 *
 * The whole `UnitTriggerEvent` rides along, because every choice it carries was
 * made when the card was ANNOUNCED and must not be re-derived from a board that
 * has since changed — the same reason a SpellChainEntry carries its targets.
 */
function holdUnitTrigger(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  event: UnitTriggerEvent,
): GameState {
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "unitOnPlay",
    playerIndex: casterIndex,
    listenerInstanceId: unit.instanceId,
    listenerDefId: unit.defId,
    listenerName: unit.name,
    ...(typeof event.destination === "object" ? { battlefieldId: event.destination.battlefieldId } : {}),
    event,
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/**
 * Resolves a held on-play trigger when the chain pops it.
 *
 * **The unit is NOT required to still be in play.** Once a triggered ability is
 * on the Chain it is independent of its source (809.1.b), so an opponent who
 * kills the unit during the response window does not cancel the ability — they
 * only remove what it might have referred to, and each resolver already answers
 * for a unit it cannot find. That is the opposite of `resolvePendingTrigger`'s
 * event-registry branch, which bails when the LISTENER has gone, and the
 * difference is real: there the listener is a bystander that must still be in
 * play to act, here it is the ability's own source.
 */
export function resolveHeldOnPlayTrigger(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = allUnitTriggers()[entry.listenerDefId];
  if (!trigger) return state;
  return trigger.resolve(state, contextFor(entry.playerIndex), entry.listenerInstanceId, entry.event as UnitTriggerEvent);
}

/** What an attack trigger's body is handed: the board, its controller, itself,
 *  and the battlefield the COMBAT is at — which is not necessarily where the
 *  unit is standing by the time this runs (see `isStillHere`). */
type AttackTriggerBody = (state: GameState, ctx: EffectContext, unit: UnitInstance, battlefieldId: string) => GameState;

/**
 * Attack Triggers — "when I attack", for the units that print it.
 *
 * **These fire at `combatBegan`, not at the move.** Rule 383.4.f: an Attack
 * Trigger triggers "when a Unit or Player gains the Attacker designation for the
 * first time during a combat", and 465's Combat Step 1 hands that designation out
 * as the Combat Showdown opens. They used to be dispatched from inside
 * execute-move-unit.ts and execute-play-card.ts, one per unit that had just
 * landed — earlier than the rules' moment, and blind to a unit that was already
 * standing there when a friend walked in and started the fight.
 *
 * The bodies stayed here rather than moving into the per-domain effect files, and
 * `attackEventTriggers` below is what registers them: this is one ability shape
 * spread across eight cards, and the ONE thing every one of them needs — the
 * attacker-side filter — is a thing to be applied once, not copied eight times
 * into eight `applies` predicates that can each be forgotten. What a card's
 * trigger DOES still lives with the card, in this table.
 *
 * Crackshot Corsair's and Dune Drake's targets are auto-selected (deterministic
 * order) rather than offering a real player choice — same simplification
 * precedent as card-effects.ts's Back to Back/Singularity entries (the Java
 * oracle's own OriginEffects.java admits doing the same for at least one card:
 * "Full 'choose 2' targeting arrives with the Part 2 UI").
 *
 * **EVERY BODY IN THIS TABLE IS WHOLLY ABOUT "HERE", and the adapter drops it
 * when "here" is moot.** Each of the six prints exactly one instruction and that
 * instruction names "here", so a source that is no longer standing at the combat
 * makes the whole body ignorable (359.3.f.2.a) and `attackEventTriggers` never
 * calls it. The two attack triggers whose text ALSO says something that is not
 * about "here" — Ava Achiever and Twisted Fate - Gambler — are in
 * `ATTACK_TRIGGERS_PARTLY_HERE` below and are handed the answer instead of being
 * gated on it.
 */
const ATTACK_TRIGGERS: Record<string, AttackTriggerBody> = {
  // Volibear - Furious — "[Deflect 2] When I attack, deal 5 damage SPLIT among any
  // number of enemy units here."
  //
  // The rules spec the split completely (the "Splitting" section): each unit
  // chosen is Targeted, the targets are chosen when the ability is finalized on
  // the chain, and the number of targets is capped at the damage available — so
  // "split 5" reaches at most 5 units. That is a specification, not a design
  // problem, and the survey filed it as a missing subsystem.
  //
  // **AUTO-SELECTED, like every other attack trigger here**, and for the same
  // structural reason Crackshot Corsair and Twisted Fate record: an attack
  // trigger fires inside the move/play executor, with no action left to hang a
  // choice on. Recorded Unverified in docs/rules-conformance.md alongside the
  // others.
  //
  // The SPLIT itself is lethal-first in board order — each unit is assigned
  // exactly what kills it until the 5 runs out, with any remainder going to the
  // last one touched. That is the same model `combat.distribute` uses for damage
  // assignment (465.2.c), which is the closest thing the rules give to "how a
  // reasonable player splits", and it maximises bodies removed rather than
  // spreading uselessly. Also Unverified: a player might prefer to finish one big
  // unit instead.
  "OGN-041": (state, ctx, unit, battlefieldId) => {
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const enemies = Object.entries(bf.units)
      .filter(([ownerId]) => ownerId !== casterId)
      .flatMap(([, units]) => units);

    let remaining = 5;
    let next = state;
    for (const target of enemies) {
      if (remaining <= 0) break;
      // Read fresh each time: an earlier kill can change an aura and therefore
      // what the next unit needs.
      const alive = findUnitOnBattlefield(next, target.instanceId);
      if (!alive) continue;
      const lethal = Math.max(1, effectiveMight(next, alive.unit, alive.ownerIndex, { isCombat: false, battlefieldId }) - alive.unit.damage);
      const hit = Math.min(remaining, lethal);
      next = dealDamage(next, ctx.casterIndex, target.instanceId, hit);
      remaining -= hit;
    }
    return next;
  },
  "OGN-130": (state, ctx, unit, battlefieldId) => {
    // Crackshot Corsair — deal 1 to an enemy unit here (auto-selects the first one found).
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const enemyId = Object.entries(bf.units)
      .find(([ownerId]) => ownerId !== casterId)?.[1]
      .find((u) => u.instanceId !== unit.instanceId)?.instanceId;
    return enemyId ? dealDamage(state, ctx.casterIndex, enemyId, 1) : state;
  },
  "OGN-131": (state, ctx, unit, battlefieldId) => {
    // Dune Drake — +2 Might this turn if there's a ready enemy unit here.
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const hasReadyEnemy = Object.entries(bf.units).some(
      ([ownerId, units]) => ownerId !== casterId && units.some((u) => !u.exhausted),
    );
    return hasReadyEnemy ? giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 2) : state;
  },
  "OGN-238": (state, ctx, unit, battlefieldId) => {
    // Leona - Determined — "When I attack, stun an enemy unit here."
    //
    // "Here" is her own battlefield, so the candidates are the enemy units at
    // it — and the first is taken, the same auto-selection Crackshot Corsair
    // above already makes for the same structural reason: an on-attack trigger
    // fires inside the move/play executor, which has no action left to hang a
    // choice on. Recorded as Unverified in docs/rules-conformance.md.
    //
    // Her [Shield] is a combat-damage property (effective-might.ts), not part of
    // this trigger.
    const enemyId = firstEnemyAt(state, ctx.casterIndex, battlefieldId, unit.instanceId);
    return enemyId ? stunUnits(state, ctx.casterIndex, [enemyId]) : state;
  },
  "OGN-148": (state, ctx, _unit, battlefieldId) =>
    // Anivia - Primal — "When I attack, deal 3 to all enemy units here."
    //
    // "All enemy units HERE", so this is the battlefield sweep rather than
    // `enemiesAt`'s auto-selection: nothing is chosen, so none of the
    // auto-selection caveats the other entries carry apply to it. Anivia herself
    // is never in the list — `dealDamageToEnemyUnitsAtBattlefield` filters on
    // owner, not on instance.
    dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, battlefieldId, 3),
  "OGN-159": (state, ctx, unit, battlefieldId) => {
    // Warwick - Hunter — "I enter ready. When I attack, kill all damaged enemy
    // units here." (The enter-ready half is a play-time property and lives in
    // deploy.ts's table, not here.)
    //
    // "DAMAGED" is `damage > 0` — marked damage, which is what a unit carries
    // between showdowns until Combat Cleanup heals it (466 step 3c). So this is
    // a follow-up punisher: it reads damage an EARLIER fight left behind, and
    // finds nothing on a board that has just been healed.
    //
    // Read the ids up front and go through `destroyUnit`, not a filtered rebuild
    // of the unit list: a kill is a death, so each one must fire its own
    // [Deathknell] and death-watch listeners. Killing from a snapshot is also
    // what stops one death's trigger removing a unit still to be killed and
    // shrinking the list mid-loop — `destroyUnit` no-ops on an id already gone.
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    if (!bf) return state;
    const casterId = state.players[ctx.casterIndex].id;
    const damagedEnemyIds = Object.entries(bf.units)
      .filter(([ownerId]) => ownerId !== casterId)
      .flatMap(([, units]) => units)
      .filter((u) => u.damage > 0 && u.instanceId !== unit.instanceId)
      .map((u) => u.instanceId);
    return damagedEnemyIds.reduce((next, id) => destroyUnit(next, id, ctx.casterIndex), state);
  },
};

/**
 * The attack triggers whose printed text says something BESIDES its "here"
 * instruction — so a moot "here" must drop that instruction and leave the rest
 * standing (359.3.f.2.a ignores "all instructions related to it", not the whole
 * ability).
 *
 * They take the same shape as `ATTACK_TRIGGERS` plus `hereIsLive`, the answer
 * `isStillHere` gave, rather than being gated on it by the adapter. Two entries,
 * and they use it differently:
 *
 *  - Twisted Fate - Gambler reveals and recycles a rune before any branch, and
 *    two of his three branches ([Mind] draw, [Order] stun an enemy unit —
 *    location-less by print) name no "here" at all. A wholesale drop would have
 *    cost him the rune rotation and the draw as well as the damage.
 *  - Ava Achiever is here to be left ALONE, deliberately; see her entry.
 */
const ATTACK_TRIGGERS_PARTLY_HERE: Record<
  string,
  (state: GameState, ctx: EffectContext, unit: UnitInstance, battlefieldId: string, hereIsLive: boolean) => GameState
> = {
  "OGN-107": (state, ctx, _unit, battlefieldId, _hereIsLive) =>
    // Ava Achiever — "When I attack, you may pay [Mind] to play a card with
    // [Hidden] from your hand, ignoring its cost. If it's a unit, play it here."
    //
    // The one on-attack trigger in this file that ASKS rather than auto-selecting,
    // and it can: the thing being chosen is a card in hand and a payment, not a
    // target, so `decisions.ts` can carry it and nothing has to be committed to
    // the move action that triggered it. `battlefieldId` rides on the decision
    // because "here" means where she attacked, not wherever she stands when the
    // answer arrives.
    //
    // **`hereIsLive` is deliberately IGNORED, and this is the one attack trigger
    // that the 359.3.f pass did not settle.** Her "here" is real, but it is the
    // second of two instructions (135.2.b): "you may pay [Mind] to play a card
    // with [Hidden] ... ignoring its cost" names no referent and must survive an
    // Ava who has walked out, while "if it's a unit, play it HERE" does. What a
    // null referent does to a unit that has already been played — base, or no
    // play at all — the rules do not say here, and guessing it would change where
    // a card lands on a board. That is Teemo - Strategist's shape exactly
    // (OGN-121, whose "choose an enemy unit here" must drop while the reveal and
    // recycle still happen), and it is filed with him, unruled.
    //
    // So this entry keeps the pre-359.3.f behaviour verbatim — the captured
    // battlefield, whatever Ava has done since — rather than picking a reading.
    // Pinned in test/attack-trigger-here-referent.test.ts.
    parkDecision(state, { kind: "OGN-107-play", playerIndex: ctx.casterIndex, battlefieldId }),
  "OGN-200": (state, ctx, unit, battlefieldId, hereIsLive) => {
    // Twisted Fate - Gambler — "When I attack, reveal the top rune of your rune
    // deck, then recycle it. Do one of the following based on its domain:
    // [Fury] Deal 2 to an enemy unit here and 1 to all other enemy units here.
    // [Mind] Draw 1.  [Order] Stun an enemy unit."
    //
    // The reveal is the whole cost of the card's variance, so an empty rune deck
    // reveals nothing and does nothing — no branch, not a default one. Recycling
    // puts the rune on the BOTTOM of the rune deck (416), which is why this
    // rotates rather than discards.
    //
    // Three of the six domains do nothing. That is printed, not an omission: a
    // Calm, Body or Chaos rune is a whiff, and inventing a fallback would make
    // the card strictly better than it reads.
    const owner = state.players[ctx.casterIndex];
    const revealed = owner.runeDeck[0];
    if (!revealed) return state;

    const players = [...state.players] as [PlayerState, PlayerState];
    players[ctx.casterIndex] = { ...owner, runeDeck: [...owner.runeDeck.slice(1), revealed] };
    const recycled: GameState = { ...state, players };

    switch (revealed.domain) {
      case "Fury": {
        // "An enemy unit here" takes 2 and "all OTHER enemy units here" take 1 —
        // so this is 2 to the first and 1 to each of the rest, not 3 to one. The
        // list is snapshotted before any damage lands, so a unit killed by the 2
        // cannot shorten the loop (dealDamage no-ops on an id already gone).
        //
        // **The ONLY branch with a "here", so the only one a moot referent
        // silences** (359.3.f.2.a). The rune is already revealed and recycled
        // above — that instruction names nothing and happens either way.
        if (!hereIsLive) return recycled;
        const enemyIds = enemiesAt(recycled, ctx.casterIndex, battlefieldId, unit.instanceId);
        return enemyIds.reduce((next, id, index) => dealDamage(next, ctx.casterIndex, id, index === 0 ? 2 : 1), recycled);
      }
      case "Mind":
        return drawCards(recycled, ctx.casterIndex, 1);
      case "Order": {
        // "An enemy unit" — no "here" on this branch, unlike the Fury one. The
        // card distinguishes them in print, so this reaches an enemy anywhere on
        // the board, base included (355.9.a.1).
        const anyEnemy = enemiesAnywhere(recycled, ctx.casterIndex)[0];
        return anyEnemy ? stunUnits(recycled, ctx.casterIndex, [anyEnemy]) : recycled;
      }
      default:
        return recycled;
    }
  },
};

/** The enemy units at one battlefield, in board order, excluding `selfInstanceId`
 *  (an on-attack trigger's own unit is standing there too). Shared by the
 *  auto-selecting on-attack triggers so they pick in the same, stable order —
 *  which is what makes their tests meaningful rather than incidental. */
function enemiesAt(state: GameState, casterIndex: 0 | 1, battlefieldId: string, selfInstanceId: string): string[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  const casterId = state.players[casterIndex].id;
  return Object.entries(bf.units)
    .filter(([ownerId]) => ownerId !== casterId)
    .flatMap(([, units]) => units.map((u) => u.instanceId))
    .filter((id) => id !== selfInstanceId);
}

function firstEnemyAt(state: GameState, casterIndex: 0 | 1, battlefieldId: string, selfInstanceId: string): string | undefined {
  return enemiesAt(state, casterIndex, battlefieldId, selfInstanceId)[0];
}

/** Every enemy unit in play, base and battlefields — for the triggers whose text
 *  names no location. Base first, then battlefields in board order, the same
 *  order `listeningPermanents` walks. */
function enemiesAnywhere(state: GameState, casterIndex: 0 | 1): string[] {
  const enemyIndex: 0 | 1 = casterIndex === 0 ? 1 : 0;
  const enemy = state.players[enemyIndex];
  return [
    ...enemy.baseUnits.map((u) => u.instanceId),
    ...state.battlefields.flatMap((bf) => (bf.units[enemy.id] ?? []).map((u) => u.instanceId)),
  ];
}

/**
 * The `ATTACK_TRIGGERS` table, presented to `triggers.ts` as ordinary
 * `combatBegan` listeners — so an Attack Trigger is a Chain Pending Item (383)
 * like every other converted event, respondable before it resolves.
 *
 * One adapter rather than eight hand-written entries, and the reason is the
 * filter. `combatBegan` fires for DEFENDERS too — that is why Ahri - Inquisitive
 * ("attack or defend") and Teemo listen to it — so each of these cards needs an
 * attacker-side test, and eight copies of it is eight chances to leave one out.
 * Here there is one, in `applies`, and a card cannot be registered without it.
 *
 * **`applies` decides whether it TRIGGERED, and nothing re-asks that.** 383 fixes
 * triggering at the moment of the event: asking "am I attacking" again at
 * resolution would let an opponent cancel a fired trigger by moving its unit, and
 * would open a response window at every combat for abilities that resolve to
 * nothing.
 *
 * **"HERE" is a separate question, and it IS re-asked — `isStillHere`.** This
 * used to cite 383 for both, which is the wrong rule for the second: "here" is a
 * REFERENT read from the ability's source (359.3.f.1), checked on EXECUTION of
 * the instruction (359.3.f.2), and an illegal one returns null so that "all
 * instructions related to it will be ignored" (359.3.f.2.a). The rules' own
 * worked example is one of these eight cards' sibling — Yasuo - Remorseful,
 * answered with Fight or Flight, whose attack trigger "mistargets" because "here"
 * is no longer where the combat is. So all eight still TRIGGER, still cost both
 * players a PassFocus, and the six wholly-"here" bodies then resolve to nothing.
 * Moved away and dead are the same case, and neither re-aims at wherever the unit
 * ended up. Lucian - Gunslinger, Sinister Poro, Recurve Bow, Ezreal - Dashing and
 * Icevale Archer already read their own "here" this way; this is the rest of the
 * family joining them.
 *
 * The bodies still re-read the BOARD (who is standing here now, what damage they
 * carry), which is the part that was always a resolution-time question.
 *
 * The listener is the attacking unit itself, so `contextFor(listener.ownerIndex)`
 * and the event's battlefield are the whole of the old dispatcher's payload —
 * which is why this family could convert without the carried-choice plumbing the
 * on-move and on-spell-cast tables still need.
 */
export function attackEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> } {
  const entries: Record<string, EventTriggerDefinition> = {};

  /** ONE registration path for both tables, so the attacker-side filter and the
   *  referent check cannot come apart between them. */
  const register = (
    defId: string,
    body: (state: GameState, ctx: EffectContext, unit: UnitInstance, battlefieldId: string, hereIsLive: boolean) => GameState,
  ) => {
    entries[defId] = {
      on: "combatBegan",
      applies: isAttackingAt,
      resolve: (state, listener, event) => {
        // Narrowing is not ceremony: the dispatcher filters by `on` and `applies`
        // already asked both questions, but neither can hand the compiler a
        // narrowed event or a UnitInstance.
        if (event.kind !== "combatBegan") return state;
        if (listener.card.kind !== "Unit") return state;
        return body(
          state,
          contextFor(listener.ownerIndex),
          listener.card,
          event.battlefieldId,
          isStillHere(state, listener.card.instanceId, event.battlefieldId),
        );
      },
    };
  };

  for (const [defId, effect] of Object.entries(ATTACK_TRIGGERS)) {
    register(defId, (state, ctx, unit, battlefieldId, hereIsLive) =>
      hereIsLive ? effect(state, ctx, unit, battlefieldId) : state,
    );
  }
  for (const [defId, effect] of Object.entries(ATTACK_TRIGGERS_PARTLY_HERE)) register(defId, effect);

  return { name: "engine/unit-triggers.ts (attack triggers)", entries };
}

/**
 * What a move trigger has to be told, captured when the move happened.
 *
 * Both fields are things the board stops being able to answer. `battlefieldId`
 * is where the unit moved TO — by resolution it may have been moved again or
 * killed. `isFirstMoveThisTurn` is the sharper one: `execute-move-unit` computes
 * it from `movesThisTurn` BEFORE incrementing, so a resolution that re-derived it
 * would find the unit already showing one move and answer FALSE every time —
 * Miss Fortune - Captain would simply never fire.
 */
export interface UnitMoveTriggerEvent {
  battlefieldId: string;
  isFirstMoveThisTurn: boolean;
}

/** On-move triggers — fired once per completed move, contested or not
 *  (execute-move-unit.ts), independent of the attack triggers above.
 *
 *  **HELD as Chain Pending Items** since 2026-08-03, through `holdMoveTrigger`
 *  below: the listener is the moving unit itself, so this is the on-PLAY shape
 *  rather than the event-registry one, and the entry carries `source:
 *  "unitOnMove"` to say which registry resolves it.
 *
 *  Takes the unit's INSTANCE ID rather than the unit, like `UnitTriggerDefinition`
 *  already does — none of the three needs more, and an id cannot go stale across
 *  the response window the way a captured object would.
 *
 *  `isFirstMoveThisTurn` exists for Miss Fortune - Captain alone ("the FIRST
 *  time I move each turn"); every other listener ignores it and fires on every
 *  move, which is what their own text says. */
interface MoveTriggerDefinition {
  /**
   * Whether the ability TRIGGERED, as opposed to merely being a move.
   *
   * The same split `EventTriggerDefinition.applies` makes, and needed for the
   * same reason: 383.4 settles "requirements besides the trigger" at the moment
   * of the event, so a move that does not meet them must place NO Pending Item —
   * holding one anyway would close the chain and cost both players a PassFocus
   * for an ability that resolves to nothing. Miss Fortune - Captain's "the FIRST
   * time I move each turn" is the only one today.
   *
   * Reads the carried event only. It is asked before the entry exists, so there
   * is nothing else it could read.
   */
  applies?: (event: UnitMoveTriggerEvent) => boolean;
  resolve: (state: GameState, ctx: EffectContext, unitInstanceId: string, event: UnitMoveTriggerEvent) => GameState;
}

const ON_MOVE_TRIGGERS: Record<string, MoveTriggerDefinition> = {
  "OGN-185": { resolve: (state, ctx) => {
    // Traveling Merchant — "When I move, discard 1, then draw 1."
    //
    // This is where the front-of-hand discard convention started, inlined here,
    // and it is where it ends: the player picks now. "Then" is still the whole
    // point, and is now what `discardThenDraw` exists to protect — with the
    // discard able to stop and ask, the draw has to be queued behind the
    // question rather than wrapped around it.
      return discardThenDraw(state, ctx.casterIndex, 1, 1);
    },
  },
  "OGN-222": {
    // Noxian Drummer — When I move to a battlefield, play a 1-Might Recruit unit
    // token here. "HERE" is the battlefield he moved TO, taken from the carried
    // event rather than from where he stands now.
    resolve: (state, ctx, _unitInstanceId, event) => placeTokenAtDestination(state, ctx.casterIndex, { battlefieldId: event.battlefieldId }),
  },
  "OGN-162": {
    // Miss Fortune - Captain — "The first time I move each turn, you may ready
    // something else that's exhausted."
    //
    // "FIRST time each turn" is the reason UnitInstance carries movesThisTurn:
    // a per-player flag would let one unit's move spend another's allowance, and
    // "each turn" means it comes back, so it cannot be a one-shot.
    //
    // **It is a requirement BESIDES moving, so it decides whether she triggers at
    // all** (383.4) and lives here rather than in the body. Her second move of a
    // turn must place nothing: a Pending Item that closes the chain, costs both
    // players a PassFocus and then does nothing is not "the rules working", it is
    // an ability that never triggered pretending it did.
    applies: (event) => event.isFirstMoveThisTurn,
    // "SOMETHING ELSE that's exhausted" — not "a unit", so the Legend and Gear
    // are eligible too, and not herself. "You may", so it stops to ask.
    //
    // This one stays at RESOLUTION, and the difference from the condition above
    // is the point: whether anything is exhausted is a question about the board
    // when the ability resolves, and a trigger that fires and finds nothing is
    // 422's do-as-much-as-you-can rather than a trigger that never happened.
    resolve: (state, ctx, unitInstanceId) => {
      if (readyableOthers(state, ctx.casterIndex, unitInstanceId).length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-162-ready",
        playerIndex: ctx.casterIndex,
        cardInstanceId: unitInstanceId,
      });
    },
  },
};

/** Everything `playerIndex` controls that is exhausted and is not
 *  `excludeInstanceId` — Miss Fortune - Captain's "something ELSE that's
 *  exhausted", which names no card type, so the Legend and Gear count. */
export function readyableOthers(
  state: GameState,
  playerIndex: 0 | 1,
  excludeInstanceId: string,
): { instanceId: string; name: string }[] {
  const actor = state.players[playerIndex];
  return [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    actor.legend,
  ]
    .filter((c) => c.exhausted && c.instanceId !== excludeInstanceId)
    .map((c) => ({ instanceId: c.instanceId, name: c.name }));
}

/**
 * Puts a moving unit's own "when I move" trigger in the holding pen (383), the
 * counterpart to `holdUnitTrigger` for the on-play family.
 *
 * Nothing is dispatched here. The whole `UnitMoveTriggerEvent` rides along
 * because both of its fields stop being derivable the moment the move completes —
 * see the interface for which and why.
 *
 * Returns the state unchanged when the unit has no registered move trigger, so
 * the executor calls it unconditionally.
 */
export function holdMoveTrigger(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  event: UnitMoveTriggerEvent,
): GameState {
  const trigger = ON_MOVE_TRIGGERS[unit.defId];
  if (!trigger) return state;
  if (trigger.applies && !trigger.applies(event)) return state;
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "unitOnMove",
    playerIndex: casterIndex,
    listenerInstanceId: unit.instanceId,
    listenerDefId: unit.defId,
    listenerName: unit.name,
    battlefieldId: event.battlefieldId,
    event,
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/**
 * Resolves a held on-move trigger when the chain pops it.
 *
 * **The unit is NOT required to still be in play**, for the same reason
 * `resolveHeldOnPlayTrigger` gives: 809.1.b makes an ability on the Chain
 * independent of the card that made it, so an opponent who kills the mover during
 * the response window removes what the ability might have referred to, not the
 * ability. Noxian Drummer's token still arrives.
 */
export function resolveHeldOnMoveTrigger(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = ON_MOVE_TRIGGERS[entry.listenerDefId];
  if (!trigger) return state;
  return trigger.resolve(state, contextFor(entry.playerIndex), entry.listenerInstanceId, entry.event as UnitMoveTriggerEvent);
}

/** On-spell-cast listeners — units that react to THEIR OWN controller
 *  casting a spell ("When you play a spell..."), fired once per resolved
 *  Spell (execute-pass-focus.ts's chain resolution), scanning only the
 *  caster's own units (base + battlefields) for a registered listener —
 *  never the opponent's, matching the printed "you" in both cards' text. */
interface SpellCastTriggerDefinition {
  /** The card's own requirement BESIDES its controller having cast a spell.
   *  Asked at fire time (383.4), so a listener whose threshold is unmet places no
   *  Pending Item rather than one that resolves to nothing. */
  applies?: (totalCost: number) => boolean;
  resolve: (state: GameState, ctx: EffectContext, unit: UnitInstance, spellTotalCost: number) => GameState;
}

const ON_SPELL_CAST_TRIGGERS: Record<string, SpellCastTriggerDefinition> = {
  // Ravenbloom Student — no threshold, so any spell of its controller's.
  "OGN-103": { resolve: (state, ctx, unit) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 1) },
  // Lux - Illuminated — "costs 5 or more" is Energy PLUS Power (the same figure
  // her Legend reads; this used to be handed energyCost alone, which silently
  // missed every 4-Energy/1-Power spell in the pool).
  "OGS-006": {
    applies: (totalCost) => totalCost >= 5,
    resolve: (state, ctx, unit) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unit.instanceId, 3),
  },
};

/**
 * The on-spell-cast table, presented as `spellCast` listeners.
 *
 * The listeners are units in play, so this family needed no `source` of its own —
 * only a held event kind. The old dispatcher walked the CASTER's own units by
 * hand, which is exactly the "each re-derives the listener walk" duplication this
 * module's own header names; `allListeningPermanents` does it now, and "you" is
 * an `applies` check on the caster like every other converted card's.
 */
export function spellCastEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> } {
  const entries: Record<string, EventTriggerDefinition> = {};
  for (const [defId, trigger] of Object.entries(ON_SPELL_CAST_TRIGGERS)) {
    entries[defId] = {
      on: "spellCast",
      // "When YOU play a spell" is the caster check the old walk did structurally;
      // Lux - Illuminated's "costs 5 or more" is her own requirement besides that,
      // and both are facts about the event, so both settle at fire time (383.4).
      applies: (_state, listener, event) =>
        event.kind === "spellCast" && event.casterIndex === listener.ownerIndex && (trigger.applies?.(event.totalCost) ?? true),
      resolve: (state, listener, event) => {
        if (event.kind !== "spellCast") return state;
        if (listener.card.kind !== "Unit") return state;
        return trigger.resolve(state, contextFor(listener.ownerIndex), listener.card, event.totalCost);
      },
    };
  }
  return { name: "engine/unit-triggers.ts (on-spell-cast)", entries };
}
