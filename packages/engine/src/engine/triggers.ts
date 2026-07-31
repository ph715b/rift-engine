import type { GameState, PlayerState } from "../model/game-state.js";
import type { GearInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
// effect-helpers imports dispatchOnUnitDied from here, so this is a cycle. It is
// safe because the binding is only read INSIDE a resolver, long after both
// modules have initialised — the same reason the registries here compose lazily.
// Doing module-init work across this cycle is what broke the engine once before.
import { drawCards } from "./effect-helpers.js";
import { domainDeathTriggers, domainEventTriggers, mergeRegistries } from "./effects/index.js";

/**
 * Events other than "a card was played", and the one place that answers "which
 * permanents could be listening?".
 *
 * unit-triggers.ts already carries four event tables (on-play, on-attack,
 * on-move, on-spell-cast) in exactly this shape, and they stay there — moving
 * them would be a pure refactor of working code. What they could NOT do is the
 * reason this module exists:
 *
 *  - each re-derives "walk the caster's units in base and at battlefields" by
 *    hand, so every new event repeats it;
 *  - none of them look at `activeGear`, and Gear is where a third of the
 *    remaining event listeners live (Scrapheap, Mistfall, Mushroom Pouch,
 *    Vanguard Helm, Solari Shrine…). A gear-only event had nowhere to go.
 *
 * So: `listeningPermanents` below is the shared walk, and new events are added
 * here as small keyed tables — the same "precise table, not a generic engine"
 * convention the rest of this codebase follows.
 */

/** A permanent that could be listening, with enough location context for the
 *  triggers that care where things are. */
export interface Listener {
  card: UnitInstance | GearInstance;
  ownerIndex: 0 | 1;
  /** undefined for a unit in base and for Gear (Gear is never at a
   *  battlefield in this pool — rule 323 step 5 recalls unattached gear). */
  battlefieldId?: string;
}

/**
 * Every permanent `playerIndex` controls that an event could reach: units in
 * base, units at each battlefield, and active Gear. Order is deliberate and
 * stable — base, then battlefields in board order, then gear — because several
 * triggers auto-select a target and a stable order is what makes their tests
 * meaningful rather than incidental.
 */
export function listeningPermanents(state: GameState, playerIndex: 0 | 1): Listener[] {
  const owner = state.players[playerIndex];
  const out: Listener[] = owner.baseUnits.map((card) => ({ card, ownerIndex: playerIndex }));
  for (const bf of state.battlefields) {
    for (const card of bf.units[owner.id] ?? []) out.push({ card, ownerIndex: playerIndex, battlefieldId: bf.id });
  }
  for (const card of owner.activeGear) out.push({ card, ownerIndex: playerIndex });
  return out;
}

/** Both players' listeners, active player first — turn order, which is the
 *  order the rules resolve simultaneous triggers in. */
export function allListeningPermanents(state: GameState): Listener[] {
  const active = state.activePlayerIndex;
  const other: 0 | 1 = active === 0 ? 1 : 0;
  return [...listeningPermanents(state, active), ...listeningPermanents(state, other)];
}

/**
 * Where a unit was when it died. Rule 809.1.b.3 is explicit that this has to be
 * captured BEFORE the card moves to the trash: "Before the card is moved to the
 * Trash, note its location, its attributes, and any other details related to the
 * effect of its triggered ability." Kog'Maw - Caustic ("deal 4 to all units at my
 * battlefield") is unimplementable without it.
 */
export interface DeathContext {
  unit: UnitInstance;
  ownerIndex: 0 | 1;
  /** undefined if it died in base. */
  battlefieldId?: string;
}

/**
 * A [Deathknell] effect — rule 808: "functionally short for 'When I die,
 * [Effect]'."
 *
 * Keyed by the DYING card's defId, and resolved with the controller of the dying
 * unit as the acting player, since every printed Deathknell reads "draw 1" /
 * "channel…" from that unit's controller's perspective.
 */
export type DeathknellEffect = (state: GameState, ctx: EffectContext, death: DeathContext) => GameState;

/** Triggers that fire when SOMEONE ELSE dies — Wraith of Echoes' "the first time
 *  a friendly unit dies each turn", Vanguard Helm's "when a buffed friendly unit
 *  dies". Keyed by the LISTENER's defId, and handed both the listener and the
 *  death, since "friendly" is relative to the listener's controller. */
export type DeathWatchEffect = (state: GameState, listener: Listener, death: DeathContext) => GameState;

let composedDeathknells: Record<string, DeathknellEffect> | null = null;

/** Composed lazily for the same import-cycle reason as card-effects.ts's
 *  ALL_CARD_EFFECTS — see that comment. */
function allDeathknells(): Record<string, DeathknellEffect> {
  composedDeathknells ??= mergeRegistries<DeathknellEffect>("Deathknell effect", [
    { name: "engine/triggers.ts", entries: {} },
    ...domainDeathTriggers(),
  ]);
  return composedDeathknells;
}

/** Every defId with a Deathknell or death-watch implementation, for coverage.ts. */
export function deathTriggerDefIds(): string[] {
  return [...Object.keys(allDeathknells()), ...Object.keys(DEATH_WATCH)];
}

/**
 * Death-watch listeners. Small enough to live inline; move to per-domain files
 * the moment a second card per domain needs one, same rule as everywhere else.
 */
const DEATH_WATCH: Record<string, DeathWatchEffect> = {
  // Wraith of Echoes — "The first time a friendly unit dies each turn, draw 1."
  //
  // "Friendly" is relative to the LISTENER, which is why a death-watch gets the
  // listener as well as the death: the Wraith cares about its own controller's
  // units, not the dying unit's controller's view of the world.
  //
  // "The first time ... each turn" needs real state — a per-turn flag on the
  // player (firstFriendlyDeathUsedThisTurn), set here and cleared by runEnd. It
  // has to be a flag rather than a count of deaths, because the death that arms
  // it may be one of several resolving from a single combat.
  "OGN-118": (state, listener, death) => {
    if (death.ownerIndex !== listener.ownerIndex) return state; // not friendly to the Wraith
    if (state.players[listener.ownerIndex].firstFriendlyDeathUsedThisTurn) return state;
    const players = [...state.players] as [PlayerState, PlayerState];
    players[listener.ownerIndex] = { ...players[listener.ownerIndex], firstFriendlyDeathUsedThisTurn: true };
    return drawCards({ ...state, players }, listener.ownerIndex, 1);
  },
};

/**
 * Fires everything that triggers on a unit's death — its own [Deathknell] first
 * (rule 808), then every death-watch listener in turn order.
 *
 * **Divergence, deliberate:** the rules put these on the Chain as Pending Items
 * (809.1.b.3, and 323 step 3a for lethal-damage deaths), so an opponent could
 * respond before a Deathknell resolves. Here they resolve immediately. That is
 * the same divergence this engine already makes for on-play unit triggers and
 * for the four event tables in unit-triggers.ts, and it is recorded in
 * docs/rules-conformance.md rather than papered over. Making it faithful means
 * building Pending Items on the chain, which is its own piece of work.
 *
 * The ONE part of 809.1.b that is honoured: a unit whose death was replaced (by
 * Highlander's ward or Zhonya's Hourglass) never reaches this function at all,
 * so its trigger is never added — which is exactly what 809.1.b.1 requires.
 */
export function dispatchOnUnitDied(state: GameState, death: DeathContext): GameState {
  let next = state;

  const deathknell = allDeathknells()[death.unit.defId];
  if (deathknell) next = deathknell(next, contextFor(death.ownerIndex), death);

  // Listeners are re-walked AFTER the Deathknell, not captured before it: a
  // Deathknell that kills things (Kog'Maw - Caustic) can remove a listener, and
  // a stale snapshot would fire a trigger for a permanent no longer in play.
  for (const listener of allListeningPermanents(next)) {
    const watch = DEATH_WATCH[listener.card.defId];
    if (watch) next = watch(next, listener, death);
  }

  return next;
}

/**
 * Events other than a death, each carrying only what its listeners need.
 *
 * One union rather than a table per event, so a card declares which event it
 * wants and `eventTriggers` in a per-domain file stays a single export — the
 * fan-out's one-file-one-owner rule holds only if adding an event listener
 * doesn't mean editing a shared file.
 */
export type GameEvent =
  /** A card was played by `casterIndex` — ANY card, on anyone's turn. Fired
   *  after the card has resolved into play, so a listener sees the new board. */
  | { kind: "cardPlayed"; casterIndex: 0 | 1 };

/** A listener, handed the event and its own permanent (so "I"/"my" resolve). */
export type EventTriggerEffect = (state: GameState, listener: Listener, event: GameEvent) => GameState;

export interface EventTriggerDefinition {
  on: GameEvent["kind"];
  resolve: EventTriggerEffect;
}

let composedEventTriggers: Record<string, EventTriggerDefinition> | null = null;

/** Composed lazily, same import-cycle reason as the registries in
 *  card-effects.ts and unit-triggers.ts. */
function allEventTriggers(): Record<string, EventTriggerDefinition> {
  composedEventTriggers ??= mergeRegistries<EventTriggerDefinition>("event trigger", [
    { name: "engine/triggers.ts", entries: {} },
    ...domainEventTriggers(),
  ]);
  return composedEventTriggers;
}

/** Every defId with an event listener, for coverage.ts. */
export function eventTriggerDefIds(): string[] {
  return Object.keys(allEventTriggers());
}

/**
 * Fires every listener registered for `event`, in turn order.
 *
 * Listeners are walked fresh rather than snapshotted, for the same reason
 * dispatchOnUnitDied does it: an earlier listener can remove a later one, and a
 * stale list would fire a trigger for a permanent no longer in play.
 *
 * Same deliberate divergence as every other trigger here — resolved immediately
 * rather than added to the Chain as a Pending Item (809.1.b.3). See
 * dispatchOnUnitDied.
 */
export function dispatchEvent(state: GameState, event: GameEvent): GameState {
  const registry = allEventTriggers();
  let next = state;
  for (const listener of allListeningPermanents(next)) {
    const trigger = registry[listener.card.defId];
    if (trigger?.on !== event.kind) continue;
    next = trigger.resolve(next, listener, event);
  }
  return next;
}
