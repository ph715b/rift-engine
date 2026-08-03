import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { DecisionDefinition, DecisionOption } from "./decisions.js";
import { parkDecision } from "./decisions.js";
import { playUnitToBase, playUnitToBattlefield } from "./deploy.js";
import { mayPlaceWithoutPresence } from "./unit-triggers.js";
import { applyContested } from "./cleanup.js";

/**
 * Where does a unit played FOR FREE land?
 *
 * Every "play it, ignoring its cost" in this pool used to answer "base", because
 * each of the seven sites called `playUnitToBase` directly. A PAID play fans its
 * destinations onto the PlayCard action and the player picks one; a free play
 * happens inside another card's resolution, where there is no action to hang the
 * choice on — so it took the only answer that needed no question.
 *
 * **That is not a simplification, it is a lost choice**, and playtesting found
 * the sharpest case: Deadbloom Predator's ENTIRE printed text is "you may play me
 * to an occupied enemy battlefield", so a Predator played off Dazzling Aurora
 * could never do the one thing it says. The same gap stopped any free unit
 * reinforcing a battlefield its controller already held.
 *
 * The mechanism is the one this engine already has for a choice with no action:
 * a parked decision. A single legal destination is not a choice, and
 * `advanceDecisions` retires a one-option question without prompting — so the
 * common case (base only) is unchanged for the player and costs no click.
 */
export const FREE_PLAY_PLACEMENT = "free-play-placement";

/** `"base"`, or a battlefield id. */
function destinationsFor(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): { id: string; label: string }[] {
  const actor = state.players[playerIndex];
  const out = [{ id: "base", label: "Your base" }];
  for (const bf of state.battlefields) {
    // The SAME two predicates a paid play uses — presence, or a card whose text
    // names a place of its own (Sneaky Deckhand, Sai Scout, Deadbloom Predator).
    // Shared rather than re-derived, so a free play can never reach somewhere a
    // paid one could not.
    //
    // Rule 813's Showdown narrowing is deliberately NOT applied: it restricts a
    // unit "played" during a Showdown, and these plays happen inside another
    // card's resolution rather than as a play action of the controller's own.
    // Recorded Unverified in docs/rules-conformance.md.
    const hasPresence = (bf.units[actor.id]?.length ?? 0) > 0;
    if (!hasPresence && !mayPlaceWithoutPresence(state, playerIndex, unit.defId, bf)) continue;
    out.push({ id: bf.id, label: bf.name });
  }
  return out;
}

/**
 * Plays `unit` for free, asking where it goes when there is more than one
 * answer.
 *
 * The CALLER has already removed the card from wherever it came from, exactly as
 * `playUnitToBase` requires — this only decides the destination and deploys.
 */
export function playUnitFree(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): GameState {
  const destinations = destinationsFor(state, playerIndex, unit);
  if (destinations.length <= 1) return playUnitToBase(state, playerIndex, unit);

  // The unit is parked WITH the question rather than deployed first and moved:
  // arriving is what fires its on-play trigger and what contests a battlefield,
  // and doing either at base first would fire them for the wrong place.
  const parked: GameState = {
    ...state,
    unitsAwaitingFreePlacement: [...state.unitsAwaitingFreePlacement, { unit, playerIndex }],
  };
  return parkDecision(parked, { kind: FREE_PLAY_PLACEMENT, playerIndex, cardInstanceId: unit.instanceId });
}

/** The unit a placement question is about, if it is still waiting. */
function awaiting(state: GameState, cardInstanceId: string | undefined) {
  if (cardInstanceId === undefined) return undefined;
  return state.unitsAwaitingFreePlacement.find((p) => p.unit.instanceId === cardInstanceId);
}

export const freePlayDecisions: Record<string, DecisionDefinition> = {
  [FREE_PLAY_PLACEMENT]: {
    prompt: (state, d) => `Where does ${awaiting(state, d.cardInstanceId)?.unit.name ?? "it"} enter play?`,
    options: (state, d): DecisionOption[] => {
      const held = awaiting(state, d.cardInstanceId);
      if (!held) return [];
      return destinationsFor(state, held.playerIndex, held.unit).map((dest) => ({ id: dest.id, label: dest.label }));
    },
    resolve: (state, d, optionId) => {
      const held = awaiting(state, d.cardInstanceId);
      if (!held) return state;
      const released: GameState = {
        ...state,
        unitsAwaitingFreePlacement: state.unitsAwaitingFreePlacement.filter(
          (p) => p.unit.instanceId !== held.unit.instanceId,
        ),
      };
      if (optionId === "base") return playUnitToBase(released, held.playerIndex, held.unit);
      // Contested is applied here rather than inside `playUnitToBattlefield` for
      // the reason that function's own note gives: arriving at a battlefield can
      // make it Contested and can be an attack, and only the caller knows which.
      // A unit appearing from a card's text is a unit becoming present (190.4),
      // so it contests exactly as a walk-in does.
      const deployed = playUnitToBattlefield(released, held.playerIndex, held.unit, optionId);
      return applyContested(deployed, optionId, held.playerIndex);
    },
  },
};

/** For coverage.ts — this module implements no card of its own; it is the shared
 *  placement step several cards' free plays now go through. */
export function freePlayDefIds(): string[] {
  return [];
}

/** Re-exported so a caller needing the raw deploy still has it — several free
 *  plays are genuinely base-only by their own text and should not ask. */
export { playUnitToBase };
export type { PlayerState };
