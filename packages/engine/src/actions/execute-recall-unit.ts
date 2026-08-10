import type { GameState, PlayerState } from "../model/game-state.js";
import { holdEventTrigger } from "../engine/triggers.js";
import { holdBattlefieldTrigger } from "../engine/battlefield-abilities.js";
import type { RecallUnitAction } from "./player-action.js";
import { validateRecallUnit } from "./validate-recall-unit.js";

/**
 * A unit walking home from a battlefield.
 *
 * # This is a MOVE, and the name is a misnomer inherited from the Java oracle
 *
 * **455: "A Recall is when a Permanent is relocated from anywhere to its Base
 * WITHOUT it being a Move."** A player sending their own unit home is a Move —
 * 446.1 makes any permanent changing position from one space on the Board to
 * another a Move, and 107.1.b/198.1 make a Base a Location like any other. The
 * rules' own Recalls are system relocations: 457.1's automatic gear recall, and
 * 446.1's "corrective Recall".
 *
 * The engine already treated it as a move everywhere EXCEPT its events: it
 * exhausts (144.2, the standard move cost — this function's own comment said
 * "same as any other move"), and `validate-recall-unit` gates it through
 * `mayMoveToBaseFrom`, which is Minotaur Reckoner's "units can't move to base".
 * Only the `unitMoved` event was missing.
 *
 * **Reported from playtesting**: "I moved a treasure hunter back from a BF and it
 * did not generate a gold gear token." Treasure Hunter reads "When I move, play a
 * Gold gear token exhausted", and it was right to expect one. I had first called
 * this correct behaviour on 456.1 ("Recalls do not cause Triggered Abilities to
 * trigger that are triggered by Move actions") — which is a true sentence about
 * Recalls, applied to something that is not one.
 *
 * The ACTION is still called RecallUnit because renaming it reaches the web, the
 * AI and every fixture; the name is wrong and the behaviour is now right, which
 * is the safer order.
 *
 * Deliberately does NOT touch the battlefield's `controllerId` — hold-scoring is
 * derived fresh from live unit presence each Beginning Phase (see scoring.ts's
 * `isHeldBy`), not from a cached flag; `controllerId` only changes hands via an
 * actual conquest.
 */
export function executeRecallUnit(state: GameState, action: RecallUnitAction): GameState {
  const validation = validateRecallUnit(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const recallIds = new Set(action.unitInstanceIds);

  const battlefields = state.battlefields.map((bf) => {
    const ownUnits = bf.units[actor.id];
    if (!ownUnits || !ownUnits.some((u) => recallIds.has(u.instanceId))) return bf;
    return { ...bf, units: { ...bf.units, [actor.id]: ownUnits.filter((u) => !recallIds.has(u.instanceId)) } };
  });

  // The ORIGIN of each unit, captured before it is removed — `unitMoved` carries
  // `from`, and by the time the event is held the unit is no longer there.
  const originOf = new Map<string, string>();
  for (const bf of state.battlefields) {
    for (const u of bf.units[actor.id] ?? []) {
      if (recallIds.has(u.instanceId)) originOf.set(u.instanceId, bf.id);
    }
  }

  const recalledUnits = state.battlefields
    .flatMap((bf) => bf.units[actor.id] ?? [])
    .filter((u) => recallIds.has(u.instanceId))
    // `movesThisTurn` counts this unit's moves, and walking home is one — the
    // same increment `execute-move-unit` makes. Without it a unit could move out
    // and back all turn and read as never having moved.
    .map((u) => ({ ...u, exhausted: true, movesThisTurn: u.movesThisTurn + 1 }));

  const updatedActor: PlayerState = {
    ...actor,
    baseUnits: [...actor.baseUnits, ...recalledUnits],
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  let next: GameState = { ...state, players, battlefields };

  // **The events a Move owes**, held rather than dispatched (383), exactly as
  // `execute-move-unit` holds them. One pair per unit, because a group walk-home
  // is several moves and "when I move" is asked of each mover.
  //
  // `to: "base"` mirrors the `from: "base"` that `execute-move-unit` already
  // emits for a unit leaving base — the event has always been able to name a
  // base at one end, and this is the other.
  for (const unit of recalledUnits) {
    const from = originOf.get(unit.instanceId);
    if (from === undefined) continue;
    next = holdEventTrigger(next, {
      kind: "unitMoved",
      moverIndex: action.playerIndex,
      unitInstanceId: unit.instanceId,
      from,
      to: "base",
      movesThisTurn: unit.movesThisTurn,
    });
    // "When a unit moves FROM here" — Back-Alley Bar. A unit walking home has
    // moved from that battlefield as surely as one walking sideways has.
    next = holdBattlefieldTrigger(next, "unitMovedFrom", from, action.playerIndex, unit.instanceId);
  }

  return next;
}
