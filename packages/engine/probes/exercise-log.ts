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
 * of vanishing are the ones with no action of their own — Legends and tokens.
 *
 * # Two categories it CANNOT see, and they are Legends
 *
 * Found by building one deck per Legend and watching six of sixteen stay
 * unexercised while each was its own deck's Legend. Three of those six were real
 * leads, but two were this observer being blind, and the distinction matters:
 *
 *  - **A continuous effect never happens.** OGS-019 Master Yi - Wuju Bladesman is
 *    "while a friendly unit defends alone, it gets +2 Might" — a `mightBonus`, read
 *    during a calculation. There is no action, no Chain item and no event, so
 *    nothing here can ever record it. It is not a trigger at all.
 *  - **`beginningPhase` is still resolved INLINE.** It is the one held-trigger
 *    conversion deliberately left undone (holding it would resolve Beginning-Phase
 *    abilities after `scoreHolds`), so it never reaches `pendingTriggers` and this
 *    observer never sees it. OGN-251 Jinx - Loose Cannon's Legend is exactly that,
 *    and so are Dr. Mundo and Mushroom Pouch.
 *
 * **Both categories report as never-exercised no matter how much they run.** Treat
 * a card of either shape as unmeasured rather than untested — and do not "fix" it
 * by marking such cards exercised, which would convert a known blind spot into a
 * silent lie. If `beginningPhase` is ever converted to a held trigger, that half
 * disappears on its own.
 */
import { isSpellChainEntry, legalActions } from "@rift-engine/engine";
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
  /**
   * defIds `legalActions` OFFERED as a PlayCard or ActivateAbility, whether or not
   * the AI took them.
   *
   * This is the difference between "the engine cannot do this" and "the AI will not
   * choose this", and without it the two are indistinguishable in the report — a
   * card that is offered 2250 times and never taken looks exactly like a card no
   * deck contains.
   *
   * That is not hypothetical. Six `Seal of X`, Kai'Sa and Darius all read
   * `[Exhaust]: [Add] <resource>`, and `heuristic-ai`'s `abilityBanksResource`
   * DELIBERATELY drops them from the candidate pool: `evaluate` scores board state,
   * so a banked resource can only ever tie with Pass, and this project's standing
   * rule is no speculative heuristic without a real evaluative basis. Miss Fortune's
   * `[Ganking]`, Sun Disc, Ravenborn Tome and Pack of Wonders are not filtered but
   * lose for the same reason — their value lands on a FUTURE turn the 1-ply
   * evaluator cannot see.
   *
   * None of those is an engine defect, and a report that cannot say so turns a
   * documented AI limitation into a fake backlog of broken cards.
   */
  readonly offered = new Set<string>();

  /**
   * defIds that ever reached a player's HAND.
   *
   * This is the signal that separates the two things "never offered" used to
   * mean, and they are not the same finding at all: a card `legalActions` refused
   * to enumerate is a lead, and a card that was never DRAWN is sampling. The
   * README has carried the warning since OGS-011 Flash sat in Annie's deck for 10
   * games, reached a hand in none of them, and read convincingly as an
   * enumeration bug — but the warning was something a reader had to remember to
   * act on, and nothing measured it. Now it is measured.
   *
   * A game lasts 5–8 turns and only about **10 distinct cards of a 39-card deck**
   * ever reach a hand, so this bucket is expected to be large and is not a defect.
   *
   * Hand only, deliberately. It is the zone `PlayCard` is enumerated from for
   * nearly everything; a card that went deck → trash was never playable, and a
   * card that reached the board was played and is therefore already exercised.
   */
  readonly drawn = new Set<string>();

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

  /**
   * Call with the state BEFORE the action, alongside `record`.
   *
   * Reads `legalActions` directly rather than anything inside the AI. That is the
   * same state-stream discipline the header describes: this asks the engine what is
   * LEGAL, which is a fact about the engine, and compares it with what the AI
   * actually did. Scoring is deliberately not observed — the point is to separate
   * the two, so instrumenting the scorer would defeat it.
   */
  scanOffers(state: GameState): void {
    for (const action of legalActions(state)) {
      if (action.type === "PlayCard") {
        this.offered.add(action.card.defId);
      } else if (action.type === "ActivateAbility") {
        const found = permanentsInPlay(state).find((c) => c.instanceId === action.permanentInstanceId);
        if (found !== undefined) this.offered.add(found.defId);
      }
    }
  }

  /** Call with the state BEFORE the action, alongside `scanOffers` — the pairing
   *  is the point, since the question is what was enumerable from the hand the AI
   *  was actually looking at. */
  scanHands(state: GameState): void {
    for (const player of state.players) {
      for (const card of player.hand) this.drawn.add(card.defId);
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
