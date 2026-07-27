/**
 * Every phase of a Riftbound turn, in order. Mirrors model/Phase.java.
 * ABCD is the mnemonic for the automatic start-of-turn sequence:
 *   Awaken    — ready all exhausted cards
 *   Beginning — score holds, resolve start-of-turn abilities
 *   Channel   — reveal 2 runes from rune deck (3 for P2 on turn 1)
 *   Draw      — draw 1 card; rune pool empties after this step
 * Then the active player enters Action until they pass priority, followed
 * by End where damage heals and any remaining rune pool empties.
 *
 * Phase transitions (TurnManager/GameEngine's job) aren't implemented yet —
 * this type exists now so GameState's shape is stable; M1 wires the actual
 * turn loop.
 */
export const PHASES = ["Awaken", "Beginning", "Channel", "Draw", "Action", "End"] as const;

export type Phase = (typeof PHASES)[number];

/** Neutral — any action is legal for the active player. Showdown — entered the
 *  moment a unit steps onto a contested battlefield; only spells and unit
 *  additions to that battlefield are legal until both players pass Focus
 *  consecutively. Mirrors model/TurnState.java. Unused until Showdown lands. */
export type TurnState = "Neutral" | "Showdown";
