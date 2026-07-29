import type { GameState, PlayerState } from "../model/game-state.js";

/**
 * Channels exactly `count` runes from the rune deck, forced Exhausted (not
 * Ready) — Mobilize's/Stormclaw Ursine's "channel N runes exhausted."
 * Deliberately NOT built on turn-manager.ts's runChannel, which channels a
 * fixed 2-3 count and always sets Ready (the normal per-turn channel step)
 * — wrong shape on both counts here. Even the Java oracle doesn't share
 * one function between these two cards and its own TurnManager.runChannel;
 * each site independently repeats the same poll/exhaust/append sequence.
 * No-ops (returns state unchanged) if the rune deck is empty — callers
 * that need "draw a card instead if you can't" (Mobilize) check
 * `runeDeck.length` themselves before calling this.
 */
export function channelRunesForcedExhausted(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  const actor = state.players[playerIndex];
  if (actor.runeDeck.length === 0 || count <= 0) return state;

  const toChannel = actor.runeDeck.slice(0, count).map((r) => ({ ...r, state: "Exhausted" as const }));
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    runeDeck: actor.runeDeck.slice(count),
    channeled: [...actor.channeled, ...toChannel],
  };
  return { ...state, players };
}
