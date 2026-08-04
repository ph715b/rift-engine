/**
 * Records which cards actually DID something during a self-play run.
 *
 * # Why this exists
 *
 * `engine/coverage.ts` measures whether a card is IMPLEMENTED — `isCardImplemented`
 * is a static check that a `defId` is registered in some effect/trigger table. It
 * says nothing about whether the card has ever run. Those are different questions
 * and the repo only had an answer to the first one, so "270/270 implemented" sat
 * beside an unknown number of cards that no automated run had ever played.
 *
 * That gap is the `make-buffdeck.mjs` defect one level up: an instrument reporting
 * its INPUT (what was registered) as though it were its output (what was
 * exercised). This module reports the output.
 *
 * # What counts as exercised, exactly
 *
 * Three separate signals, kept separate in the report because they mean different
 * things and a single merged number would hide which one is missing:
 *
 *  - **played** — a `PlayCard` action was accepted for it. Its cost was paid and it
 *    went on the Chain. This is NOT "its effect resolved correctly" — a countered
 *    spell still counts as played. It is the honest floor: the card was reachable,
 *    legal, and the AI could pay for it.
 *  - **activated** — an `ActivateAbility` action named it. This is the only signal
 *    for the 20-odd "exhaust: do one thing" Gear, which are never otherwise
 *    distinguishable from Gear that merely sat on the board.
 *  - **triggered** — a `TriggerChainEntry` naming it appeared on `pendingTriggers`
 *    or `spellChain`. This is the signal for the 110 held-trigger cards, and the
 *    ONLY signal a Legend ever produces, since a Legend starts in play and is never
 *    "played".
 *
 * # The one thing it can miss, and why the union survives it
 *
 * A trigger that fires and fully resolves inside a SINGLE `submit` call is never
 * visible in a returned state, so this observer cannot see it. That is a real blind
 * spot and it is why `triggered` is a Set rather than a count — an occurrence count
 * taken this way would be a plausible number that is not the number of times the
 * ability ran.
 *
 * It costs much less than it looks like it should. A unit whose on-play trigger
 * resolves invisibly was still recorded by the `PlayCard` action that put it there,
 * so the card stays in `exercised()`. The blind spot moves cards between BUCKETS
 * far more often than it removes them from the union. The cards genuinely at risk
 * of vanishing are the ones with no action of their own — Legends and tokens — and
 * `legendsSeen` in the probe is the control that watches for exactly that.
 */
import { isSpellChainEntry } from "@rift-engine/engine";
import type { CardInstance, GameState, PlayerAction } from "@rift-engine/engine";

/** Every card instance currently sitting somewhere an ability could be activated
 *  from. Deliberately NOT the whole game — a card in a deck or a trash cannot be
 *  the subject of an `ActivateAbility`, and scanning for it there would let a
 *  lookup succeed against the wrong copy. */
function permanentsInPlay(state: GameState): CardInstance[] {
  const out: CardInstance[] = [];
  for (const player of state.players) {
    out.push(player.legend);
    if (player.championZone) out.push(player.championZone);
    out.push(...player.baseUnits, ...player.activeGear);
    for (const bf of state.battlefields) out.push(...(bf.units[player.id] ?? []));
  }
  return out;
}

export class ExerciseLog {
  /** defId → number of accepted PlayCard actions. Exact: one action, one play. */
  readonly played = new Map<string, number>();
  /** defId → number of accepted ActivateAbility actions. Exact, same reason. */
  readonly activated = new Map<string, number>();
  /** defIds seen on the Chain as a triggered ability. A SET, not a count — see the
   *  blind spot in this file's header for why a count here would be a lie. */
  readonly triggered = new Set<string>();
  /** ActivateAbility actions whose permanent could not be found in play. Should be
   *  zero; a non-zero value means this observer is looking in the wrong places and
   *  silently under-reporting, not that the engine is wrong. */
  activationsUnresolved = 0;

  /** Call with the state BEFORE the action, and only for actions the engine
   *  accepted — an Invalid result exercised nothing. */
  record(before: GameState, action: PlayerAction): void {
    if (action.type === "PlayCard") {
      bump(this.played, action.card.defId);
      return;
    }
    if (action.type === "ActivateAbility") {
      const found = permanentsInPlay(before).find((c) => c.instanceId === action.permanentInstanceId);
      if (found === undefined) this.activationsUnresolved++;
      else bump(this.activated, found.defId);
    }
  }

  /** Call with the state AFTER the action. Cheap enough to run every step: both
   *  arrays are single-digit in length in almost every state. */
  scanChain(state: GameState): void {
    for (const entry of state.pendingTriggers) this.triggered.add(entry.listenerDefId);
    for (const entry of state.spellChain) {
      if (!isSpellChainEntry(entry)) this.triggered.add(entry.listenerDefId);
    }
  }

  /** The union — every card that did any of the three things. */
  exercised(): Set<string> {
    return new Set([...this.played.keys(), ...this.activated.keys(), ...this.triggered]);
  }
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The top `limit` entries of a count map, most-used first — for eyeballing that
 *  the busy cards are the ones you would expect. */
export function topCounts(counts: ReadonlyMap<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, limit));
}
