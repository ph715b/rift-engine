import type { Domain } from "./domain.js";
import type { CardInstance, GearInstance, LegendInstance, SpellInstance, UnitInstance } from "./card.js";
import type { RuneCard } from "./rune.js";
import type { Phase, TurnState } from "./phase.js";

/** One pending Spell resolution on the chain. Mirrors GameState.java's
 *  `record ChainEntry(PlayerAction.PlayCard action, Player caster)`, trimmed
 *  to just what's needed since our PlayCardAction already carries the card.
 *
 *  `kind` is OPTIONAL here and required on TriggerChainEntry below, which is
 *  deliberate and is NOT the same judgement as `cardPlayed`'s required
 *  `playedKind`. There, omitting a field would silently produce WRONG behaviour,
 *  so the compiler had to name every producer. Here, an entry with no
 *  discriminant is unambiguously a Spell — `card: SpellInstance` is required on
 *  this shape and absent from the other — and omission reproduces exactly the
 *  behaviour that exists today. Making it required would churn a dozen test
 *  literals to assert something the type system already knows. */
export interface SpellChainEntry {
  kind?: "spell";
  playerIndex: 0 | 1;
  card: SpellInstance;
  /** Only meaningful when the resolved card's registered effect has a
   *  "unit"-kind TargetingSpec (see engine/card-effects.ts). */
  targetUnitInstanceId?: string;
  /** Only meaningful for a "unitPair"-kind TargetingSpec (Gentlemen's
   *  Duel) — targetUnitInstanceId above is the pair's first target. */
  secondTargetUnitInstanceId?: string;
  /** Only meaningful for a `unitList`-kind TargetingSpec (Falling Star,
   *  Icathian Rain, Fox-Fire). Ordered, possibly repeating, and chosen when
   *  the spell was ANNOUNCED — which is what lets a card read another chain
   *  item's target set while it waits here. */
  targetUnitInstanceIds?: readonly string[];
  /** Only meaningful for a `chainSpell`-kind TargetingSpec — the spell BELOW
   *  this one that it counters or takes control of. */
  targetChainCardInstanceId?: string;
  /** Only meaningful for a "battlefield"-kind TargetingSpec. */
  targetBattlefieldId?: string;
  /** Only meaningful for an "ownTrashCard"-kind TargetingSpec. */
  trashCardInstanceId?: string;
  /** Only meaningful for a card with an optional exhaust-cost (Meditation)
   *  — see card-effects.ts's cardHasOptionalExhaustCost. */
  additionalCostUnitInstanceId?: string;
  /** The units spent for a REPEATABLE additional cost (Kraken Hunter's buffs,
   *  Commander Ledros' kills). A list rather than more of the single field
   *  above, so nothing that reads "the one unit this cost named" can be handed
   *  four of them. */
  additionalCostUnitInstanceIds?: readonly string[];
  /** Where a token-creating Spell deploys what it creates (Recruit the
   *  Vanguard); absent means base — see card-effects.ts's cardPlacesTokens. */
  destinationBattlefieldId?: string;
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the unchosen multi-discards (Jinx, Undercover Agent's Deathknell)
   *  go through discardCards' front-of-hand convention instead. */
  /** The unit OR gear named by a `unitOrGear`-kind targeting spec (Fading
   *  Memories). Separate from `targetUnitInstanceId` because a gear is not a
   *  unit and must never reach a reader expecting one. */
  targetPermanentInstanceId?: string;
  discardCardInstanceId?: string;
}

/**
 * A triggered ability waiting on the chain — rule 809.1.b.3 / 323 step 3a's
 * **Pending Item**.
 *
 * The rules put a trigger on the Chain so the opponent may respond before it
 * resolves. This engine currently resolves every trigger IMMEDIATELY at its
 * source (14 `dispatch*` entry points across triggers.ts, unit-triggers.ts and
 * legend-abilities.ts), which is the largest recorded divergence in
 * docs/rules-conformance.md — an entire interaction layer is absent, because
 * nothing can ever be responded to.
 *
 * This type is the seam that work builds on, and it lands ahead of any dispatch
 * site being converted ON PURPOSE: the conversion is 14 sites that each change
 * observable ordering, and doing it in one step would make a termination
 * regression impossible to bisect. Nothing pushes one of these yet, so the
 * engine's behaviour is unchanged by its existence.
 *
 * `listenerInstanceId` rather than the listener object: by the time the entry
 * resolves the board may have moved on, and rule 809.1.b.3 is explicit that the
 * dying permanent's ATTRIBUTES are captured up front while its identity is
 * re-looked-up — the same split `triggers.DeathContext` already makes.
 */
export interface TriggerChainEntry {
  kind: "trigger";
  /** Whose trigger it is — the player who would get priority to respond, and
   *  the index the resolution runs under. */
  playerIndex: 0 | 1;
  /** The permanent whose ability this is, re-looked-up at resolution. */
  listenerInstanceId: string;
  /** Which card's registered trigger to run — kept alongside the instance id so
   *  resolution needs no board scan to know WHICH ability is pending. */
  listenerDefId: string;
  /** The listener's printed name, captured when the trigger fired.
   *
   *  Carried rather than looked up because the chain viewer has to name the item
   *  while it waits, and by then the source may be in a trash — a [Deathknell] is
   *  the common case, and it is precisely the one where a board lookup returns
   *  nothing. Same reasoning as `event` above: 809.1.b.3's "note its attributes
   *  before the card is moved to the Trash", applied to the one attribute the UI
   *  needs. */
  listenerName: string;
  /** Where the listener stood when the trigger fired. Positional triggers ("when
   *  I conquer", "here") read this rather than asking the board again, since the
   *  unit may have moved or died in between. */
  battlefieldId?: string;
  /** The event as it was when it fired, captured rather than recomputed — 809.1.b.3's
   *  "noted before it moves to the Trash" applied generally. Typed loosely here
   *  to keep model/ free of an import from engine/; triggers.ts narrows it. */
  event: unknown;
}

/** One item waiting on the chain: a played Spell, or a triggered ability. */
export type ChainEntry = SpellChainEntry | TriggerChainEntry;

/** Narrows a chain entry to the Spell case. An entry with no `kind` is a Spell —
 *  see SpellChainEntry's own note on why the discriminant is optional there. */
export function isSpellChainEntry(entry: ChainEntry): entry is SpellChainEntry {
  return entry.kind !== "trigger";
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
   * Kai'Sa - Daughter of the Void's activated ability ("Add 1 rainbow Power. Use
   * only to play spells.") — the Power counterpart of `restrictedSpellEnergy`
   * above, drained after `floatingPower` and only by a Spell's Power cost.
   *
   * A bare number rather than an entry in `floatingPower`, because that record
   * is keyed by Domain and this Power is RAINBOW: it pays a pip of any domain. A
   * seventh pseudo-domain would have to be understood, and ignored, by every
   * consumer of floatingPower. Cleared at runEnd if unused, same as the Energy
   * pool.
   */
  restrictedSpellPower: number;
  /**
   * Sun Disc's "the NEXT unit you play this turn enters ready" — a charge, not a
   * flag, and the difference is the whole card.
   *
   * Confront's `unitsEnterReadyThisTurn` above is a boolean because it readies
   * EVERY unit you play for the rest of the turn; this readies exactly one and
   * is then spent. Modelled as a count so two activations (Sun Disc plus a
   * borrowed copy via Heimerdinger) arm two units rather than collapsing into
   * one boolean. Cleared at runEnd with the rest of the turn.
   */
  nextUnitsEnterReady: number;
  /**
   * Has a unit THIS player controls died this turn? Spoils of War costs 2 less
   * "if an enemy unit has died this turn", which each player has to answer about
   * the other, so it is stored per victim rather than as a global flag.
   *
   * Set in the death funnel and cleared by runEnd — "this turn" means every
   * turn, not just your own, so a unit of yours dying on the opponent's turn
   * discounts their Spoils of War during it.
   */
  unitsLostThisTurn: number;
  /** Raging Firebrand's "the NEXT spell you play this turn costs [5] less" — a
   *  charge, not a standing discount, so it is a number that is spent rather
   *  than a flag that is read. Cleared by `runEnd` with the rest of the
   *  this-turn state, and consumed by the first Spell played. */
  nextSpellEnergyDiscount: number;
  /** Ravenborn Tome's "the NEXT spell you play this turn deals 1 Bonus Damage" —
   *  a charge like `nextSpellEnergyDiscount` above, but spent one layer later:
   *  the discount is consumed when the spell is PAID for, this one when the spell
   *  finishes RESOLVING, because that is where its damage happens. */
  nextSpellBonusDamage: number;
  /** Brynhir Thundersong's "opponents can't play cards this turn", set on the
   *  player who is locked out. A fact about the TURN rather than a continuous
   *  ability, so it survives her death — killing her in response must not undo
   *  it — and `runEnd` clears it with the rest. */
  cannotPlayCardsThisTurn: boolean;
  /** Unyielding Spirit's "prevent all spell and ability damage this turn" —
   *  whose damage is prevented, not who cast it. Global in effect, stored on
   *  the player because the card says "this turn" and turns belong to players. */
  preventsSpellDamageThisTurn: boolean;
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
 * One question the engine has stopped to ask a player, mid-resolution.
 *
 * Everything else in this engine decides its choices BEFORE an action is
 * submitted, fanned out as candidates by legal-actions.ts. That only works when
 * there is an action to hang the choice on, which a trigger does not have —
 * hence this. While one of these is pending the game is genuinely paused: no
 * Cleanup runs (323.2.b, "while Chain Items are Resolving, a Cleanup cannot
 * occur") and no other action is legal.
 *
 * `kind` is a registry key, and that is the whole trick: the CONTINUATION IS
 * DATA. The Java oracle resumes through closures — `beginDiscard(player, count,
 * () -> ...)` — which is unusable here, because states are immutable snapshots
 * the AI clones and rescores and a lambda cannot survive that.
 *
 * The available options are deliberately NOT stored. engine/decisions.ts
 * recomputes them from live state when the decision reaches the front of the
 * queue, so a decision parked behind another can never offer a unit the earlier
 * answer has since killed.
 */
export interface PendingDecision {
  /** Unique per decision. The answering action names it, so an answer aimed at
   *  a decision that has already been resolved cannot apply to its successor. */
  id: string;
  /** Which DecisionDefinition resolves this — see engine/decisions.ts. */
  kind: string;
  /** Who must answer. Not necessarily the turn player: Cull the Weak asks both. */
  playerIndex: 0 | 1;
  /** The card that asked, when the handler needs it back (Flame Chompers in the
   *  trash, Mistfall in play). */
  cardInstanceId?: string;
  /** How many more times this repeats — "discard 2" answers once and re-parks
   *  with one fewer, rather than needing a multi-select. */
  count?: number;
  /** What the question is ABOUT, when that is a different thing from the card
   *  asking it — Mistfall asks about its gear (`cardInstanceId`) and the unit
   *  that was just buffed (this). Captured when the question is raised, because
   *  "it" means the unit that was buffed, not whatever is buffed by the time the
   *  answer comes in. */
  targetInstanceId?: string;
  /** WHERE the question is about, for the questions whose answer is a
   *  destination rather than a thing — Blitzcrank - Impassive's "you may move an
   *  enemy unit to **here**", where "here" is the battlefield he was played to.
   *
   *  Captured when the question is raised for the same reason `targetInstanceId`
   *  is: "here" means where he landed, not wherever he happens to be standing by
   *  the time the answer arrives. Nothing can move him in between today, and that
   *  is exactly the kind of fact that stops being true without anyone noticing. */
  battlefieldId?: string;
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
/**
 * A unit that has been taken off the board because it is dying, but whose death
 * is not settled yet — Sett - The Boss's "if a buffed unit you control **would
 * die**, you may pay ... to heal it, exhaust it, and recall it **instead**".
 *
 * A holding pen is needed because a replacement is offered at the moment of
 * death, unlike Highlander's ward which is armed in advance
 * (`deathWardedUnitInstanceIds`). By the time the question can be asked the unit
 * has already been removed from wherever it was, and it must NOT be in the trash
 * — rule 809.1.b.1 makes a replaced death not a death at all, so its Deathknell
 * must never fire. It therefore exists nowhere the board can see, and a decision
 * carrying only its instanceId would have nothing to look it up in.
 *
 * Carries the same fields DeathContext does, because if the offer is declined
 * this is exactly what the ordinary death path is handed.
 */
export interface PendingDeath {
  unit: UnitInstance;
  ownerIndex: 0 | 1;
  battlefieldId?: string;
  killerIndex?: 0 | 1;
}

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
  /**
   * Whether the currently-open chain was opened by a triggered ability rather
   * than by a played card — rule 347's exception to 346's Focus pass.
   *
   * 347: "Focus will not pass in this way if the chain opened as a result of a
   * triggered ability being added to the chain, nor if it opened as a result of an
   * Add ability." Its printed example is the Combat Chain, which opens exactly that
   * way.
   *
   * STATE rather than a property of the popped entry, and that distinction is the
   * whole point: the rule asks how the chain OPENED, not what just resolved. A
   * [Reaction] Spell cast in response to a trigger pops last, so a per-entry test
   * would see a Spell and pass Focus — losing the Focus rule 345 had just awarded
   * to the player who contested the battlefield, before they had taken one action
   * in their own Showdown.
   *
   * Meaningless while `chainOpen` (same "stale but harmless" convention as
   * `chainPriority` and `focusHolder`); set when a flush closes an open chain and
   * cleared when the chain empties.
   */
  chainOpenedByTrigger: boolean;
  /**
   * Triggers that have fired but are not yet respondable — the Chain's **Pending
   * Item** portion of the chain (337-345), held here rather than in `spellChain`.
   *
   * The rules put a trigger on the Chain the instant it fires, in any state: 383
   * says "Triggered Abilities can be put on the Chain during Closed States or Open
   * States on any player's turn", and 323.3 allows it even mid-Cleanup ("New
   * Pending Items can be added, but Finalized Items cannot be executed and Priority
   * and Focus are not passed or awarded"). What a Pending Item is NOT is
   * respondable: 345 grants priority to "the controller of the newest item on the
   * chain" only once there are **no** Pending Items left.
   *
   * So this is not a queue invented to work around the dispatch sites firing where
   * nobody holds priority — it is that rules concept, given the one shape it can
   * have here. Most of the 14 `dispatch*` entry points fire during the Beginning
   * Phase, a Cleanup, scoring, or mid-resolution, and pushing straight onto
   * `spellChain` there would offer a response window at a moment the rules say
   * priority is not awarded.
   *
   * Drained by `runCleanup`'s flush, which is the engine's Finalize step: the one
   * hook that runs after every action in both `submit` and the AI's lookahead.
   * Empty in every settled state.
   */
  pendingTriggers: TriggerChainEntry[];
  /**
   * How many EXTRA turns the player at `extraTurnsForIndex` still has coming —
   * Time Warp's "take a turn after this one".
   *
   * A count rather than a boolean because the card can be cast twice in one
   * turn, and the rules give you both turns rather than collapsing them. Paired
   * with an index rather than being per-player, because only one player can be
   * owed extra turns at a time: a Time Warp cast on YOUR turn queues yours, and
   * `runEnd` hands the turn back to the same seat until the queue empties.
   *
   * Read once, in `runEnd`'s rotation. Everything else about a turn is unchanged
   * — an extra turn is a normal turn, with its own Awaken, scoring and draw.
   */
  /**
   * Imperial Decree's "when ANY unit takes damage this turn, kill it".
   *
   * On the STATE rather than on a player, and that is the card: it says *any*
   * unit, so it reaches both boards including the caster's own, and a per-player
   * field could not say that without being set on both.
   */
  killDamagedUnitsThisTurn: boolean;
  /**
   * Noxian Guillotine's "kill it the next time it takes damage this turn" —
   * units under a delayed, single-use death sentence.
   *
   * A list of instance ids, the same shape `deathWardedUnitInstanceIds` uses for
   * the opposite effect, and for the same reasons: it is per-unit, it expires
   * with the turn, and putting it on the unit would mean every helper that
   * rebuilds a unit had to remember to carry it.
   */
  markedForDeathOnDamageInstanceIds: string[];
  extraTurns: number;
  /** Whose extra turns those are. Meaningless while `extraTurns` is 0. */
  extraTurnsForIndex: 0 | 1;
  /** Highlander's "the next time it would die this turn, heal it, exhaust
   *  it, and recall it instead" — a flat list of warded unit instanceIds
   *  (not per-player: instanceIds are globally unique), consumed at every
   *  point a unit would actually die (dealDamage's lethal branch in
   *  effect-helpers.ts, combat.ts's Showdown resolution) instead of
   *  trashing it, then cleared for that unit. Reset every runEnd, same
   *  "this turn" lifetime as GameState.java's own set
   *  (TurnManager.java:287-290). */
  deathWardedUnitInstanceIds: string[];
  /**
   * Deaths waiting on a replacement offer — see PendingDeath above. Empty
   * except for the instant between Sett - The Boss's question being raised and
   * answered, which the pending-decision queue guarantees is before any other
   * action can be taken.
   *
   * NOT reset by runEnd, unlike the ward: a death sitting here is mid-resolution
   * rather than a this-turn status, and silently discarding one would make the
   * unit vanish into neither play nor a trash.
   */
  unitsAwaitingDeathReplacement: PendingDeath[];
  /**
   * Questions the engine has stopped to ask, oldest first.
   *
   * Empty in every settled state — a non-empty queue means a resolution is
   * halfway through, which is why `submit` suppresses the Cleanup while it is
   * (323.2.b) and `legalActions` offers nothing but answers to its head.
   *
   * A queue rather than a single slot because one effect can ask more than one
   * question: Cull the Weak asks both players, and "discard 2" asks twice.
   * Resolved strictly front-to-back, so the order questions are asked in is the
   * order they were raised in — which for Cull the Weak is APNAP.
   */
  pendingDecisions: PendingDecision[];
}
