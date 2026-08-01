import type { GameState, PlayerState } from "../model/game-state.js";
import type { CardInstance, GearInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
// effect-helpers imports dispatchOnUnitDied from here, so this is a cycle. It is
// safe because the binding is only read INSIDE a resolver, long after both
// modules have initialised — the same reason the registries here compose lazily.
// Doing module-init work across this cycle is what broke the engine once before.
import { drawCards } from "./effect-helpers.js";
import { parkDecision } from "./decisions.js";
import { domainDeathTriggers, domainEventTriggers, domainSelfTriggers, mergeRegistries } from "./effects/index.js";

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
  /**
   * Who killed it, for the cards that say "when **you** kill" rather than "when
   * a unit dies" — Solari Shrine's "When you kill a stunned enemy unit". Without
   * it neither "you" nor "enemy" has an answer, and the card would fire for the
   * victim's own controller cleaning up their board.
   *
   * Optional because an unattributed death is real and must stay expressible:
   * `[Temporary]` expiring at end of turn (rule 816) kills a unit with nobody
   * behind it, and naming a killer there would be an invention.
   */
  killerIndex?: 0 | 1;
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

  /**
   * Solari Shrine — "When you kill a stunned enemy unit, you may exhaust this to
   * draw 1."
   *
   * Three conditions, all printed and all separately load-bearing:
   *  - **you kill** — `death.killerIndex`, the field this card is the reason
   *    for. Without it the Shrine would fire when its own controller's units
   *    were cleaned up by the opponent, which is the opposite of the card.
   *  - **stunned** — read off the unit AS IT DIED (`death.unit`), which rule
   *    809.1.b.3 requires be captured before the card reaches the trash. Asking
   *    the board instead would find nothing: it is already in a trash.
   *  - **enemy** — relative to the SHRINE's controller, which is why a
   *    death-watch is handed the listener as well as the death.
   *
   * The exhaust is optional AND is the price of the draw, so it stops to ask —
   * a "you may" with a cost is a decision, not a freebie. An already-exhausted
   * Shrine cannot pay it, so it is not offered at all rather than offered and
   * refused (the same shape `canPayActivationCost` uses).
   */
  "OGN-072": (state, listener, death) => {
    if (death.killerIndex !== listener.ownerIndex) return state; // not YOUR kill
    if (death.ownerIndex === listener.ownerIndex) return state; // not an ENEMY unit
    if (!death.unit.stunned) return state;
    if (listener.card.exhausted) return state;
    return parkDecision(state, {
      kind: "OGN-072-draw",
      playerIndex: listener.ownerIndex,
      cardInstanceId: listener.card.instanceId,
    });
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
  | { kind: "cardPlayed"; casterIndex: 0 | 1 }
  /** `playerIndex`'s Beginning Phase is starting. Fired BEFORE holds score, for
   *  the same reason `[Temporary]`'s kill runs there: a Beginning-Phase ability
   *  that changes the board has to do so while there is still a scoring step
   *  left to be affected by it. */
  | { kind: "beginningPhase"; playerIndex: 0 | 1 }
  /** A Buff was PLACED on a unit (Mistfall). `ownerIndex` is whose unit it is,
   *  which is what "a FRIENDLY unit" is measured against — not who caused it, so
   *  buffing an enemy unit does not offer their gear its trigger. Fired only when
   *  a buff was really placed: rule 708 makes a second one on an already-buffed
   *  unit a no-op, and a no-op is not a buffing. */
  | { kind: "unitBuffed"; ownerIndex: 0 | 1; unitInstanceId: string }
  /** A Combat Showdown has just opened at `battlefieldId` — the moment units
   *  there become attackers and defenders (341/351.1). Fired for a freshly
   *  staged Combat and for a Non-Combat one promoted by 317.2, since both are a
   *  combat beginning as far as a card that says "when a unit attacks or
   *  defends" is concerned. */
  | { kind: "combatBegan"; battlefieldId: string }
  /**
   * `stunnerIndex` just stunned these units (rule 422) — ONE event per
   * instruction, carrying every unit that actually became stunned.
   *
   * The batch shape is the card text's doing, not tidiness: Leona - Radiant Dawn
   * buffs once for "one or more" stunned units while Eclipse Herald triggers per
   * unit, and a per-unit event cannot express the first. `ownerIndex` rides
   * along per unit because "an ENEMY unit" is measured against the LISTENER's
   * controller, which is not necessarily the stunner (a card can stun its own).
   *
   * Fired only by `effect-helpers.stunUnits`, which drops the units that were
   * already stunned — re-stunning is not a stunning.
   */
  | {
      kind: "unitsStunned";
      stunnerIndex: 0 | 1;
      stunned: readonly { unitInstanceId: string; ownerIndex: 0 | 1 }[];
    }
  /**
   * `conquerorIndex` just conquered `battlefieldId` — the same moment
   * `dispatchLegendOnConquer` serves, opened up to permanents.
   *
   * Kai'Sa - Survivor reads "when I conquer", which is a UNIT's own conquest;
   * Super Mega Death Rocket reads "when you conquer" from the TRASH, which no
   * listener walk reaches at all. Both are answered from this one event, with
   * each card checking for itself which of the two it meant — the alternative
   * was a third dispatch shape for a difference the cards do not treat as one.
   *
   * Fired after the conquest is recorded, so a listener sees the score it caused.
   */
  | { kind: "battlefieldConquered"; conquerorIndex: 0 | 1; battlefieldId: string }
  /**
   * `discarderIndex` discarded one or more cards — Jinx - Rebel's "when you
   * discard ONE OR MORE cards", which pays out once per discard INSTRUCTION
   * however many cards it took.
   *
   * Deliberately carries NO count. It could not carry an honest one: a "discard
   * 2" the player has to choose for is answered one card at a time through the
   * decision queue, so the funnel sees two separate single-card discards and
   * only the queue knows they were one instruction. Rather than pass a number
   * that would be wrong on exactly the path that matters, the event says the
   * only thing every card asks — that a discard happened. A card that one day
   * needs the count can have it added along with the plumbing to make it true.
   */
  | { kind: "cardsDiscarded"; discarderIndex: 0 | 1 };

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

/**
 * Triggers a card fires about ITSELF, keyed by its own defId.
 *
 * Structurally different from `eventTriggers` above, and the difference is not
 * cosmetic: those walk the permanents in play, but a card that triggers on being
 * DISCARDED is in hand at that moment, and one that triggers on being KILLED is
 * on its way to the trash. Neither is a listener the walk would ever reach.
 * `[Deathknell]` already had this shape for units; Scrapheap needs the same for
 * a Gear, across three moments at once.
 */
export type SelfEventKind = "played" | "discarded" | "killed";

/** The card this fired for, and whose it is. */
export interface SelfEvent {
  kind: SelfEventKind;
  card: CardInstance;
  ownerIndex: 0 | 1;
}

export type SelfEventEffect = (state: GameState, event: SelfEvent) => GameState;

export interface SelfTriggerDefinition {
  /** Every moment this card cares about — Scrapheap wants all three. */
  on: readonly SelfEventKind[];
  resolve: SelfEventEffect;
}

let composedSelfTriggers: Record<string, SelfTriggerDefinition> | null = null;

function allSelfTriggers(): Record<string, SelfTriggerDefinition> {
  composedSelfTriggers ??= mergeRegistries<SelfTriggerDefinition>("self trigger", [
    { name: "engine/triggers.ts", entries: {} },
    ...domainSelfTriggers(),
  ]);
  return composedSelfTriggers;
}

/** For coverage.ts. */
export function selfTriggerDefIds(): string[] {
  return Object.keys(allSelfTriggers());
}

/** Fires `card`'s own trigger for this moment, if it has one for it. */
export function dispatchSelfEvent(state: GameState, kind: SelfEventKind, card: CardInstance, ownerIndex: 0 | 1): GameState {
  const trigger = allSelfTriggers()[card.defId];
  if (!trigger || !trigger.on.includes(kind)) return state;
  return trigger.resolve(state, { kind, card, ownerIndex });
}

/**
 * Kills a Gear — the funnel gear did not have.
 *
 * Reachable since Fading Memories can grant a gear `[Temporary]`, and rule 816
 * kills a Temporary PERMANENT rather than only a unit. Before this the gear went
 * silently to the trash, which is the same invisible-omission shape that made
 * `killUnit` necessary for units.
 *
 * Deliberately NOT routed through `killUnit`: a gear is not a unit, has no
 * Might, no buff and no death ward, and pretending otherwise would mean teaching
 * that funnel about a kind of card it should not have to know.
 */
export function killGear(state: GameState, gear: GearInstance, ownerIndex: 0 | 1): GameState {
  const owner = state.players[ownerIndex];
  if (!owner.activeGear.some((g) => g.instanceId === gear.instanceId)) return state;

  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...owner,
    activeGear: owner.activeGear.filter((g) => g.instanceId !== gear.instanceId),
    trash: [...owner.trash, gear],
  };
  // Trash first, then trigger — the trigger has to see a board the gear has
  // already left, the same ordering killUnit uses.
  return dispatchSelfEvent({ ...state, players }, "killed", gear, ownerIndex);
}
