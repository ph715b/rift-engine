import type { Domain } from "./domain.js";
import type { CardInstance, GearInstance, LegendInstance, SpellInstance, UnitInstance } from "./card.js";
import type { RuneCard } from "./rune.js";
import type { Phase, TurnState } from "./phase.js";

/** One pending Spell resolution on the chain. Mirrors GameState.java's
 *  `record ChainEntry(PlayerAction.PlayCard action, Player caster)`, trimmed
 *  to just what's needed since our PlayCardAction already carries the card. */
export interface ChainEntry {
  playerIndex: 0 | 1;
  card: SpellInstance;
  /** Only meaningful when the resolved card's registered effect has a
   *  "unit"-kind TargetingSpec (see engine/card-effects.ts). */
  targetUnitInstanceId?: string;
  /** Only meaningful for a "unitPair"-kind TargetingSpec (Gentlemen's
   *  Duel) — targetUnitInstanceId above is the pair's first target. */
  secondTargetUnitInstanceId?: string;
  /** Only meaningful for a "battlefield"-kind TargetingSpec. */
  targetBattlefieldId?: string;
  /** Only meaningful for an "ownTrashCard"-kind TargetingSpec. */
  trashCardInstanceId?: string;
  /** Only meaningful for a card with an optional exhaust-cost (Meditation)
   *  — see card-effects.ts's cardHasOptionalExhaustCost. */
  additionalCostUnitInstanceId?: string;
  /** Where a token-creating Spell deploys what it creates (Recruit the
   *  Vanguard); absent means base — see card-effects.ts's cardPlacesTokens. */
  destinationBattlefieldId?: string;
}

/**
 * All state owned by a single player. Mirrors model/Player.java's zones:
 * deck/hand/activeGear/trash/banished/runeDeck/channeled. Units at
 * battlefields live on `GameState.battlefields`, not here — same reasoning
 * as the Java original ("their location is a board property, not a hand
 * property," model/Player.java:22-24).
 *
 * Java's Player additionally carries ~10 narrow "this turn"/restricted-pool
 * fields for individual cards' effects (restrictedSpellEnergy,
 * dianaScornOfTheMoonEnergy, wraithOfEchoesUsedThisTurn, xp, etc.,
 * model/Player.java:57-166) accreted one at a time as each specific card's
 * effect was implemented. None of those are needed yet — add each when the
 * card that needs it is implemented, not preemptively.
 */
export interface PlayerState {
  id: string;
  name: string;
  legend: LegendInstance;
  /**
   * The one champion copy set aside at deck-build time — starts face-up
   * here, outside the draw deck, per Player.java:25 ("the champion starts
   * face-up in the base zone") and CardRegistry.buildPlayerWithChampion
   * (registry/CardRegistry.java:220-249), which pulls exactly one copy of
   * the chosen champion out of the 40-card deck before shuffling the rest.
   * Modeled as a field on PlayerState rather than a separate
   * GameState-level `Map<Player, Card.Unit>` (as Java's
   * `championZone`/`chosenChampion` are) since our GameState is already
   * player-indexed.
   */
  championZone: UnitInstance | null;
  deck: CardInstance[];
  hand: CardInstance[];
  trash: CardInstance[];
  banished: CardInstance[];
  activeGear: GearInstance[];
  runeDeck: RuneCard[];
  /** Rune pool for the current turn. */
  channeled: RuneCard[];
  baseUnits: UnitInstance[];
  points: number;
  floatingEnergy: number;
  floatingPower: Partial<Record<Domain, number>>;
  cardsPlayedThisTurn: number;
  /**
   * Battlefield ids this player has conquered so far this turn — needed for
   * the final-point rule (core rules §466.2): if a Conquest would be a
   * player's winning point, it's only awarded once they've conquered every
   * battlefield in that same turn; otherwise it's withheld (not rolled
   * back — the point simply never increments) and they draw a compensation
   * card instead. Mirrors GameState.conqueredThisTurn (a confirmed real
   * rules-vs-engine gap the Core-Rules-Audit found and fixed) and is reset
   * every Awaken (ScoringSystem.onTurnStart, engine/ScoringSystem.java:26-32).
   */
  conqueredBattlefieldsThisTurn: string[];
  /** Confront's "Units you play this turn enter ready" — reset every
   *  runEnd alongside the rest of this turn's transient state. */
  unitsEnterReadyThisTurn: boolean;
  /** Lux-Crownguard's activated ability ("Add 2 Energy. Use only to play
   *  spells.") — a separate, more restricted pool from floatingEnergy
   *  (that one can pay for anything; this one only Spells), drained first
   *  when paying a Spell's Energy cost (cost-modifiers.ts). Persists until
   *  spent, same as floatingEnergy, but still cleared at runEnd if unused
   *  — mirrors Player.java:74/TurnManager.java:335. */
  restrictedSpellEnergy: number;
}

/**
 * A battlefield location on the board. Mirrors model/Battlefield.java.
 * `hiddenCards` (the [Hidden] keyword's facedown-card tracking,
 * model/Battlefield.java:43-55) isn't modeled yet — add it when Hidden is
 * implemented, since nothing reads it before then.
 */
export interface BattlefieldState {
  id: string;
  name: string;
  controllerId: string | null;
  units: Record<string, UnitInstance[]>;
}

/**
 * The full state of one Riftbound game. Mirrors model/GameState.java's
 * core shape (FR3): players, battlefields, turn/phase/priority, scoring
 * (on each PlayerState.points, matching Java — GameState itself has no
 * points field either).
 *
 * Java's GameState additionally carries a long tail (~700 lines) of
 * per-card "this turn" bookkeeping (Burn Out queue, damage-assignment
 * state, etc., model/GameState.java:291-748) — deliberately not
 * generalized into a clean TS shape up front (it's the least generalizable
 * part of the Java model). Add fields for that here card-by-card, as each
 * one's effect is actually implemented, the same way Player/Card already
 * defer their own long tails.
 */
export interface GameState {
  players: [PlayerState, PlayerState];
  battlefields: BattlefieldState[];
  activePlayerIndex: 0 | 1;
  turnNumber: number;
  phase: Phase;
  turnState: TurnState;
  /** Who currently acts during an open Showdown; meaningless while
   *  turnState is "Neutral". Mirrors GameState.java's focusHolder. */
  focusHolder: 0 | 1;
  /** Which battlefield is contested; null whenever turnState is "Neutral".
   *  Mirrors GameState.java's showdownBf (id only, not the object, since our
   *  BattlefieldState lives in the `battlefields` array). */
  showdownBattlefieldId: string | null;
  /** Consecutive PassFocus count while a Showdown is open; 2 resolves
   *  combat and closes it. Mirrors GameState.java's consecutiveFocusPasses.
   *  No separate showdownAttackerIndex field is needed the way Java's
   *  showdownAttacker is: that field only exists for Charm-style effects
   *  that let a caster move an *enemy's* unit (nothing like that is
   *  implemented here), so activePlayerIndex — frozen for the Showdown's
   *  whole lifetime, since Pass (the only thing that changes it) is illegal
   *  while turnState is "Showdown" — is always the attacker. */
  consecutiveFocusPasses: number;
  /** true = no spell pending resolution (an "Open State"); false = a Spell
   *  is on the chain and only PassFocus is legal until it resolves. Mirrors
   *  GameState.java's chainOpen — shared between Neutral and Showdown
   *  contexts, orthogonal to turnState (a Spell can't currently be cast
   *  during a Showdown, since validatePlayCard rejects all PlayCard outside
   *  turnState "Neutral", so in practice this only ever closes on a Neutral
   *  turn for now). */
  chainOpen: boolean;
  /** Who currently has priority to act while the chain is closed; meaningless
   *  while chainOpen (same "stale but harmless" convention as focusHolder).
   *  Mirrors GameState.java's chainPriority — kept non-nullable like
   *  focusHolder rather than `0 | 1 | null`, to match the existing
   *  convention and avoid a null-handling ripple through every fixture. */
  chainPriority: 0 | 1;
  /** Consecutive PassFocus count while the chain is closed; 2 resolves the
   *  top of the chain. Mirrors GameState.java's chainPasses — a sibling
   *  counter to consecutiveFocusPasses, not the same one, since a chain can
   *  close independently of any Showdown. */
  chainPasses: number;
  /** The actual LIFO stack of pending Spell resolutions. Mirrors
   *  GameState.java's `Deque<ChainEntry> spellChain`. A real array (not a
   *  single nullable slot) even though nothing can currently push a 2nd
   *  entry before the 1st resolves (no reaction-speed casting is
   *  implemented yet) — this is the correct general shape, not speculative:
   *  it needs no restructuring the moment reaction casting is added. */
  spellChain: ChainEntry[];
  /** Highlander's "the next time it would die this turn, heal it, exhaust
   *  it, and recall it instead" — a flat list of warded unit instanceIds
   *  (not per-player: instanceIds are globally unique), consumed at every
   *  point a unit would actually die (dealDamage's lethal branch in
   *  effect-helpers.ts, combat.ts's Showdown resolution) instead of
   *  trashing it, then cleared for that unit. Reset every runEnd, same
   *  "this turn" lifetime as GameState.java's own set
   *  (TurnManager.java:287-290). */
  deathWardedUnitInstanceIds: string[];
}
