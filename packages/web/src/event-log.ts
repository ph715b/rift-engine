import { defaultCardRegistry, type CardInstance, type GameEvent, type GameState } from "@rift-engine/engine";

/** One line of the log, as the panel renders it. */
export interface LogLine {
  id: number;
  /** Who did it, for colouring. `null` when the event belongs to no one — a
   *  phase boundary. */
  actorIndex: 0 | 1 | null;
  text: string;
  /** Turn number when it happened, so the panel can group. */
  turn: number;
}

/**
 * **Turning the engine's events into sentences.**
 *
 * `submit` returns the events an action raised (29 kinds, the engine's own). They
 * are built for LISTENERS, not readers: they carry instance ids, player indices
 * and whole `DeathContext` payloads, because a triggered ability needs to ask
 * precise questions of them. A player needs a sentence.
 *
 * # Why this lives in the web and not the engine
 *
 * It is presentation. The engine deliberately does not know that player 0 is
 * called "You", that a battlefield has a display name, or that "Traveling
 * Merchant moved to Zaun Warrens" reads better than "unitMoved". Putting the
 * phrasing here also means it can change without touching a rules module.
 *
 * # Not every event is worth a line
 *
 * `describeEvent` returns `null` for the ones that are bookkeeping rather than
 * narration — `unitChosen` fires for targeting, `beginningPhase` fires every
 * turn, and a log that reported them would bury the three lines that matter. The
 * filter is deliberate and listed rather than a default: a new event kind gets no
 * line until someone decides what it should say, which is the safe direction.
 */

/** Resolves an instance id to a card name, wherever it currently is.
 *
 *  Searches the board and both hands; falls back to a generic word rather than an
 *  id, because a log line reading "card-14 moved" is worse than one reading "a
 *  unit moved". By the time an event is narrated the card may be in a trash or
 *  gone entirely — an event is a record of a moment that has passed. */
function nameOf(state: GameState, instanceId: string | undefined, fallback = "a card"): string {
  if (instanceId === undefined) return fallback;
  for (const player of state.players) {
    for (const unit of player.baseUnits) if (unit.instanceId === instanceId) return unit.name;
    for (const card of player.hand) if (card.instanceId === instanceId) return card.name;
    for (const card of player.trash) if (card.instanceId === instanceId) return card.name;
    for (const gear of player.activeGear) if (gear.instanceId === instanceId) return gear.name;
  }
  for (const bf of state.battlefields) {
    for (const units of Object.values(bf.units)) {
      for (const unit of units) if (unit.instanceId === instanceId) return unit.name;
    }
  }
  return fallback;
}

/** A battlefield's printed name, or its id if it is somehow not in play. */
function battlefieldName(state: GameState, id: string | undefined): string {
  if (id === undefined) return "a battlefield";
  return state.battlefields.find((bf) => bf.id === id)?.name ?? id;
}

/** "You" or "The AI", from a seat index — the log is written from the human's
 *  point of view because there is exactly one person reading it. */
const who = (index: 0 | 1, humanIndex: 0 | 1) => (index === humanIndex ? "You" : "The AI");

/**
 * One sentence for one event, or `null` for an event not worth a line.
 *
 * `state` is the board AFTER the action, which is what makes names resolvable —
 * a unit that just arrived is only findable there. A death is the exception and
 * needs none: `DeathContext` carries the whole unit, precisely because 808.1.d.3
 * requires its details be noted before it moved to the trash.
 */
export function describeEvent(event: GameEvent, state: GameState, humanIndex: 0 | 1): string | null {
  switch (event.kind) {
    case "cardPlayed": {
      // `playedDefId` is optional on the event, so the registry fallback is only
      // consulted when it is there — a Spell has already left the board by now and
      // the definition is the last place its name survives.
      const printed = event.playedDefId === undefined ? undefined : defaultCardRegistry().tryGet(event.playedDefId)?.name;
      const name = nameOf(state, event.playedInstanceId, printed ?? "a card");
      const from = event.fromHidden ? " from hidden" : event.fromElsewhere ? " from outside their hand" : "";
      return `${who(event.casterIndex, humanIndex)} played ${name}${from}.`;
    }
    case "unitMoved": {
      // `to` is a battlefield id or undefined for a recall home. The distinction
      // is the whole line: "moved to X" and "pulled back to base" are different
      // events to a player watching the board.
      const name = nameOf(state, event.unitInstanceId, "a unit");
      return event.to === undefined
        ? `${who(event.moverIndex, humanIndex)} recalled ${name} to base.`
        : `${who(event.moverIndex, humanIndex)} moved ${name} to ${battlefieldName(state, event.to)}.`;
    }
    case "unitDied": {
      // The unit comes off the event, not the board — it is not on the board any
      // more, which is the point.
      const at = event.death.battlefieldId ? ` at ${battlefieldName(state, event.death.battlefieldId)}` : "";
      return `${event.death.unit.name} died${at}.`;
    }
    case "showdownBegan":
      return `A ${event.showdownKind === "Combat" ? "Combat" : "Non-Combat"} Showdown opened at ${battlefieldName(state, event.battlefieldId)}.`;
    case "combatWon":
      return `${who(event.winnerIndex, humanIndex)} won the combat at ${battlefieldName(state, event.battlefieldId)}.`;
    case "battlefieldConquered":
      return `${who(event.conquerorIndex, humanIndex)} conquered ${battlefieldName(state, event.battlefieldId)}.`;
    case "unitsStunned": {
      // Each entry carries its OWNER as well as the id — the event is built for a
      // listener asking "was one of mine stunned?", not for a reader.
      const names = event.stunned.map((s) => nameOf(state, s.unitInstanceId, "a unit")).join(", ");
      return event.stunned.length === 0 ? null : `${who(event.stunnerIndex, humanIndex)} stunned ${names}.`;
    }
    case "spellCast":
      return `${who(event.casterIndex, humanIndex)} cast ${nameOf(state, event.spellInstanceId, "a spell")}.`;
    case "endOfTurn":
      return "— end of turn —";

    // **Deliberately silent.** Each of these fires often enough that a line would
    // cost more than it tells: `unitChosen` fires for every targeting step,
    // `beginningPhase` and `mainPhaseStarted` fire every turn, and the rest are
    // bookkeeping a player infers from the line that caused them. Listed rather
    // than defaulted, so a NEW event kind falls through to the exhaustive check
    // below and has to be decided on.
    case "beginningPhase":
    case "mainPhaseStarted":
    case "combatBegan":
    case "combatEnded":
    case "unitChosen":
    case "unitBecameMighty":
    case "unitReadied":
    case "cardDrawn":
    case "battlefieldHeld":
    case "unitKilledBySpell":
    case "unitBuffed":
    case "cardsRecycled":
    case "runesRecycled":
    case "cardHidden":
    case "buffSpent":
    case "equipmentAttached":
    case "cardsDiscarded":
    case "abilityActivated":
    case "becameEmpowered":
      return null;
  }
  // An event kind this file has not been taught. Silent rather than throwing —
  // a log is not worth crashing a game over — but the compiler flags it first:
  // the switch above is exhaustive, so a new kind fails the build here.
  return null;
}

/** Renders a batch of events into log lines, dropping the silent ones. */
export function linesFrom(
  events: readonly GameEvent[],
  state: GameState,
  humanIndex: 0 | 1,
  nextId: () => number,
): LogLine[] {
  const lines: LogLine[] = [];
  for (const event of events) {
    const text = describeEvent(event, state, humanIndex);
    if (text === null) continue;
    lines.push({
      id: nextId(),
      actorIndex: actorOf(event, humanIndex),
      text,
      turn: state.turnNumber,
    });
  }
  return lines;
}

/** Who a line belongs to, for colouring. `null` where the event has no actor —
 *  a death has a victim rather than a doer, and a turn boundary has neither. */
function actorOf(event: GameEvent, humanIndex: 0 | 1): 0 | 1 | null {
  void humanIndex;
  switch (event.kind) {
    case "cardPlayed":
    case "spellCast":
      return event.casterIndex;
    case "unitMoved":
      return event.moverIndex;
    case "combatWon":
      return event.winnerIndex;
    case "battlefieldConquered":
      return event.conquerorIndex;
    case "unitsStunned":
      return event.stunnerIndex;
    default:
      return null;
  }
}

/**
 * The instance ids of units that DIED in this batch of events.
 *
 * **The one thing on this board that only the event stream can answer.** Every
 * departure looks identical to a diff — recalled, bounced to hand, banished,
 * killed — because all a diff sees is a card that is no longer there. `unitDied`
 * is what separates them, and a death that animates like a recall is the
 * difference between "I lost that" and "I moved that".
 *
 * Read off the EVENT rather than the board, because by the time a caller asks,
 * the cards are gone from it. `DeathContext` carries the whole unit for exactly
 * this reason — 808.1.d.3 requires its details be noted before it moved.
 *
 * Lives here beside `describeEvent` because it is the same job: interpreting the
 * engine's events for a human-facing surface.
 */
export function unitsThatDied(events: readonly GameEvent[]): string[] {
  return events.filter((e) => e.kind === "unitDied").map((e) => e.death.unit.instanceId);
}

/** The card an announcement is about, and who played it. */
export interface PlayAnnouncement {
  card: CardInstance;
  casterIndex: 0 | 1;
}

/**
 * **The opponent's play, held up so it can be read.**
 *
 * The move this borrows from MTG Arena. A card the AI plays currently appears on
 * the board already resolved — a unit is simply THERE, and a spell is never seen
 * at all, since it goes straight to the trash. The player is left reconstructing
 * what happened from what changed, which is the same complaint several of this
 * project's playtest reports were really making.
 *
 * # Only the OPPONENT's
 *
 * Announcing your own play would hold up a card you just clicked, in front of the
 * board you are trying to act on. You already know what you played; you watched it
 * leave your hand. The opponent's play is the one that arrives with no warning.
 *
 * # The LAST one in the batch
 *
 * One action can raise several — a play that triggers a cast. The most recent is
 * the one the board is about to show the consequences of.
 */
export function announcedPlay(
  events: readonly GameEvent[],
  state: GameState,
  humanIndex: 0 | 1,
): PlayAnnouncement | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "cardPlayed" && event.kind !== "spellCast") continue;
    if (event.casterIndex === humanIndex) continue;
    const instanceId = event.kind === "cardPlayed" ? event.playedInstanceId : event.spellInstanceId;
    const card = instanceAnywhere(state, instanceId);
    // **No card, no announcement.** A countered or banished card can be nowhere
    // by now, and a blank frame in the middle of the board is worse than silence.
    if (card === undefined) continue;
    return { card, casterIndex: event.casterIndex };
  }
  return null;
}

/** The instance behind an id, wherever it now is — the same sweep `nameOf` does,
 *  returning the card itself because an announcement needs its ART. The trash is
 *  in the search on purpose: a Spell is already there by the time it is
 *  announced. */
function instanceAnywhere(state: GameState, instanceId: string | undefined): CardInstance | undefined {
  if (instanceId === undefined) return undefined;
  for (const player of state.players) {
    for (const unit of player.baseUnits) if (unit.instanceId === instanceId) return unit;
    for (const card of player.hand) if (card.instanceId === instanceId) return card;
    for (const card of player.trash) if (card.instanceId === instanceId) return card;
    for (const gear of player.activeGear) if (gear.instanceId === instanceId) return gear;
  }
  for (const bf of state.battlefields) {
    for (const units of Object.values(bf.units)) {
      for (const unit of units) if (unit.instanceId === instanceId) return unit;
    }
  }
  return undefined;
}
