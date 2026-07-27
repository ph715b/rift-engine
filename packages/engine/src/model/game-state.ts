import type { Domain } from "./domain.js";
import type { CardInstance, GearInstance, LegendInstance, UnitInstance } from "./card.js";
import type { RuneCard } from "./rune.js";
import type { Phase, TurnState } from "./phase.js";

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
  focusHolder: 0 | 1;
}
