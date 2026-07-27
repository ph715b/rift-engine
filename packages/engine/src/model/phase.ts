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
 * Phase transitions are driven by engine/turn-manager.ts's runAwaken ->
 * runBeginning -> runChannel -> runDraw -> Action -> runEnd loop.
 */
export const PHASES = ["Awaken", "Beginning", "Channel", "Draw", "Action", "End"] as const;

export type Phase = (typeof PHASES)[number];

/** Neutral — any action is legal for the active player (subject to the
 *  spell chain, not modeled yet). Showdown — entered the moment a unit
 *  steps onto a contested battlefield (engine/execute-move-unit.ts); with
 *  no reaction-speed cards implemented yet, the only legal action while a
 *  Showdown is open is PassFocus — two consecutive passes resolves combat
 *  (engine/execute-pass-focus.ts) and returns turnState to "Neutral".
 *  Mirrors model/TurnState.java. The full spell-chain/reaction system
 *  (which can also open/reopen this window mid-Showdown) is still
 *  deferred until Spells/Gear/Legend abilities are playable. */
export type TurnState = "Neutral" | "Showdown";
