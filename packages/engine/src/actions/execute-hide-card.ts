import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import type { HideCardAction } from "./player-action.js";
import { validateHideCard } from "./validate-hide-card.js";

/**
 * Resolves a validated Hide — rule 811.
 *
 * What this deliberately does NOT do is as important as what it does:
 *
 *  - **No chain.** "Hiding a card does not open a chain" (811). Nothing here
 *    touches `spellChain`, `chainOpen` or priority, which is what separates a
 *    Discretionary Action from a play.
 *  - **No on-play trigger, no `cardsPlayedThisTurn`.** "Hide is not a subset of
 *    Play." A card hidden this turn has not been played, so [Legion]'s "if
 *    you've played another card this turn" must not see it either.
 *
 * The Power runes are recycled to the bottom of the rune deck exactly as a play
 * would recycle them — paying Power is paying Power, however the payment arose,
 * so this mirrors executePlayCard's own loop rather than inventing a second
 * settlement path. Ready runes spent on Power still bank their unspent
 * Energy-paying potential as floating Energy, for the same reason.
 */
export function executeHideCard(state: GameState, action: HideCardAction): GameState {
  const validation = validateHideCard(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const paidPowerIds = new Set(action.payment.powerRunes);

  let floatingEnergyGained = 0;
  const recycled: RuneCard[] = [];
  const remainingChanneled: RuneCard[] = [];
  for (const rune of actor.channeled) {
    if (paidPowerIds.has(rune.id)) {
      // Same rule as a play: a READY rune recycled for Power never got to pay
      // Energy, so that potential is banked rather than lost.
      if (rune.state === "Ready") floatingEnergyGained += 1;
      recycled.push({ ...rune, state: "Ready" });
    } else {
      remainingChanneled.push(rune);
    }
  }

  const playedFromChampionZone = actor.championZone?.instanceId === action.card.instanceId;

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = {
    ...actor,
    hand: actor.hand.filter((c) => c.instanceId !== action.card.instanceId),
    championZone: playedFromChampionZone ? null : actor.championZone,
    channeled: remainingChanneled,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy + floatingEnergyGained,
  };

  const battlefields = state.battlefields.map((bf): BattlefieldState =>
    bf.id === action.battlefieldId
      ? {
          ...bf,
          hiddenCards: [
            ...bf.hiddenCards,
            // The turn it was hidden on, so "beginning on the NEXT turn" (811)
            // is a comparison rather than a guess.
            { ownerIndex: action.playerIndex, card: action.card, hiddenOnTurn: state.turnNumber },
          ],
        }
      : bf,
  );

  return { ...state, players, battlefields };
}
