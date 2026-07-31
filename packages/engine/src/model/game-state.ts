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
  /** Battlefields this player has SCORED this turn, by either method — Hold
   *  (Beginning Phase) or Conquer. The rules cap it at one score per
   *  battlefield per turn (rule 471.1.b), and the final-point rule asks
   *  whether every battlefield has been SCORED, not merely conquered
   *  (rule 474) — so holds must land in this list too. Cleared by runAwaken.
   *  Was `conqueredBattlefieldsThisTurn`, which tracked only half of it. */
  scoredBattlefieldsThisTurn: string[];
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
  /**
   * Has this player's "first time a friendly unit dies each turn" already
   * fired? Wraith of Echoes is the only card that asks, and the Java oracle
   * carries a field of the same shape and nearly the same name
   * (`wraithOfEchoesUsedThisTurn`) — this file's own note about those ~10 narrow
   * per-card fields says to add each one when the card that needs it is
   * implemented, which is now.
   *
   * "Each turn", not "each of your turns": reset by runEnd, which fires at the
   * end of EVERY turn, so a unit of yours dying on the opponent's turn arms it
   * for them and disarms it again afterwards.
   */
  firstFriendlyDeathUsedThisTurn: boolean;
  /**
   * Extra Might each Buff is worth to THIS player's units for the rest of the
   * turn — Stand United's "Buffs give an additional +1 Might to friendly units
   * this turn".
   *
   * A modifier on the buff's VALUE, not a buff itself and not a flat Might
   * bonus: it scales with how many of your units are buffed, applies to units
   * buffed later in the same turn, and is worth nothing on an unbuffed unit.
   * Cleared by runEnd alongside the other this-turn state.
   */
  extraMightPerBuffThisTurn: number;
  /**
   * Has this player discarded a card this turn? Raging Soul's "if you've
   * discarded a card this turn, I have [Assault] and [Ganking]" is the only
   * card that asks, and it asks about the PLAYER, not about any particular
   * discard — so a flag rather than a count. Set by `discardCards`, cleared by
   * runEnd.
   */
  discardedThisTurn: boolean;
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
  /**
   * Who applied Contested status here, or null if the battlefield isn't
   * Contested. Rule 458: "The Destination becomes Contested if it is an
   * Uncontested Battlefield not controlled by the controller of the Unit or
   * Units that moved" — so entering a battlefield you already control applies
   * nothing, and an already-Contested one isn't re-applied.
   *
   * This exists as real state because the rules separate the two halves in
   * time: a Move applies Contested, and the Showdown is only *staged* in the
   * following Cleanup (316.9 / 341), by which point the applier must still be
   * known — they gain Focus as the Showdown begins (345). Cleared once Control
   * is established or re-established (190.6.a), which is what ends the
   * Contested status rather than the Showdown merely closing.
   */
  contestedByIndex: 0 | 1 | null;
  /**
   * Cards hidden facedown here by the `[Hidden]` keyword (rule 811).
   *
   * A list rather than a single slot even though rule 811 allows at most one
   * ("a battlefield you control that doesn't already have a facedown card
   * hidden there") — because control can change, and the rules resolve that in
   * the Cleanup (323 step 5) rather than preventing it. Between a control
   * change and the next Cleanup two players' cards can briefly coexist here,
   * and a single slot would have to silently drop one.
   */
  hiddenCards: HiddenCard[];
}

/**
 * One facedown card at a battlefield.
 *
 * `hiddenOnTurn` is what makes "beginning on the next turn, this gains
 * [Reaction] and you may play this, ignoring its base cost" (811) checkable —
 * it is NOT the same as "not during this Action phase", since a turn can end
 * and return. Compared against `GameState.turnNumber`.
 *
 * `ownerIndex` rather than a controller: rule 323 step 5 sends a lost facedown
 * card to its OWNER's trash, and 811 ties the card's life to whether that same
 * player still controls the battlefield.
 */
export interface HiddenCard {
  ownerIndex: 0 | 1;
  card: CardInstance;
  hiddenOnTurn: number;
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
  /**
   * Who took the very first turn of this game — fixed for its whole lifetime.
   * Rule 117.x determines turn order by "any fair random method", so this is
   * genuinely either player and is NOT derivable from `activePlayerIndex`
   * (which rotates) or from the seat a player occupies.
   *
   * Two steps depend on it, and both were previously written against the
   * literal indices on the assumption that player 0 always started:
   *   - the going-second Channel bonus (rules 486.1 / 487.4) must land on
   *     `active !== firstPlayerIndex`, or the compensation for going first
   *     goes to the player who went first;
   *   - `turnNumber` advances when play wraps back to the First Player
   *     (rule 118's looping queue "starting with the First Player"), not when
   *     it reaches index 0.
   *
   * Equivalent to TurnManager.java's `startingPlayerIndex` instance field,
   * lifted onto GameState because this engine's turn steps are pure functions
   * with no instance to hang it off.
   */
  firstPlayerIndex: 0 | 1;
  turnNumber: number;
  phase: Phase;
  turnState: TurnState;
  /** Who currently acts during an open Showdown; meaningless while
   *  turnState is "Neutral". Mirrors GameState.java's focusHolder. */
  focusHolder: 0 | 1;
  /** Where the open Showdown is; null whenever turnState is "Neutral".
   *  Mirrors GameState.java's showdownBf (id only, not the object, since our
   *  BattlefieldState lives in the `battlefields` array).
   *
   *  One at a time, deliberately. The rules allow several Showdowns to be
   *  Staged at once (323's cleanup step 6 marks one per Contested battlefield);
   *  our Cleanup opens one and leaves any other battlefield Contested for the
   *  next Cleanup. Only reachable via an effect that contests two battlefields
   *  in a single action, of which this card pool has none — a divergence
   *  recorded in docs/rules-conformance.md rather than built. */
  showdownBattlefieldId: string | null;
  /**
   * Which kind of Showdown is open, or null when none is. Non-null exactly when
   * `turnState === "Showdown"` and `showdownBattlefieldId !== null`.
   *
   * A Showdown is NOT combat — rule 341 makes it a window in which players may
   * play cards in an alternating fashion, and only *some* Showdowns are part of
   * a Combat:
   *   - `"Combat"` — opened with units of different players present, so it
   *     "will be opened as the first step of Combat" (341). Closing it runs the
   *     remaining steps of Combat (351.1 / 463).
   *   - `"NonCombat"` — opened by moving onto a battlefield you don't control
   *     that has no opposing units. A stand-alone phase that "does not create a
   *     Combat" (317.1). Closing it just establishes Control (352.1).
   *
   * Stored rather than derived from the board, because it is a status that
   * *transitions*: a NonCombat Showdown becomes a Combat Showdown in the
   * following Cleanup if another player's units arrive (317.2). Board shape
   * can't stand in for it either — Combat step 3d recalls the attackers, so
   * "units of different players present" is false by the time a Combat
   * Showdown finishes.
   */
  showdownKind: "Combat" | "NonCombat" | null;
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
