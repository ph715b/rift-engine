import type { GameState, PlayerState, TriggerChainEntry } from "../model/game-state.js";
import type { CardInstance, GearInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
// effect-helpers imports dispatchOnUnitDied from here, so this is a cycle. It is
// safe because the binding is only read INSIDE a resolver, long after both
// modules have initialised — the same reason the registries here compose lazily.
// Doing module-init work across this cycle is what broke the engine once before.
import { drawCards } from "./effect-helpers.js";
import { parkDecision } from "./decisions.js";
import {
  domainDeathTriggers,
  domainDeathWatch,
  domainEventTriggers,
  domainSelfTriggers,
  mergeRegistries,
} from "./effects/index.js";

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

/**
 * Both players' listeners, active player first.
 *
 * That IS the rules' order, but it is the order triggers are PLACED on the chain,
 * not the order they resolve — a distinction this comment used to get wrong by
 * claiming turn order "is the order the rules resolve simultaneous triggers in".
 *
 * Rule 383: "If multiple players separately control Triggered Abilities that are
 * Triggered simultaneously, then starting with the Turn Player and proceeding in
 * Turn Order, each player orders their Triggered Abilities on the Chain." Rule 343
 * then resolves the chain LIFO — newest first. So the turn player places first,
 * lands at the BOTTOM, and resolves LAST.
 *
 * While every trigger resolves inline at its dispatch site, placement order and
 * resolution order are the same thing and the error is invisible. They come apart
 * the moment a trigger is held as a Pending Item and flushed onto the chain, which
 * is why the correction is recorded here rather than left for whoever hits it.
 */
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
  return [...Object.keys(allDeathknells()), ...Object.keys(allDeathWatch())];
}

let composedDeathWatch: Record<string, DeathWatchEffect> | null = null;

/**
 * Death-watch listeners: the inline ones below plus whatever the per-domain
 * files contribute.
 *
 * This table used to be the whole story, with a note to "move to per-domain
 * files the moment a second card per domain needs one". Order reached two
 * (Vanguard Helm and Viktor - Leader), so the split happened — new death-watch
 * cards belong in `effects/<domain>.ts`, and the entries here stay put for the
 * same reason ALL_CARD_EFFECTS' inline ones do.
 */
function allDeathWatch(): Record<string, DeathWatchEffect> {
  composedDeathWatch ??= mergeRegistries<DeathWatchEffect>("death watch", [
    { name: "engine/triggers.ts", entries: DEATH_WATCH },
    ...domainDeathWatch(),
  ]);
  return composedDeathWatch;
}

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
  const watchers = allDeathWatch();
  for (const listener of allListeningPermanents(next)) {
    const watch = watchers[listener.card.defId];
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
   *  after the card has resolved into play, so a listener sees the new board.
   *
   *  `fromHidden` is Ember Monk's "when you play a card FROM [Hidden]" — the
   *  same event, since a card played from facedown is still a card being played
   *  and everything watching `cardPlayed` should still see it. A separate event
   *  would have meant every existing listener silently missing hidden plays. */
  /** `playedKind` and `playedInstanceId` identify WHAT was played. Required, not
   *  optional, and deliberately so: Cithria of Cloudfield reads "when you play
   *  ANOTHER UNIT", which needs both the kind (a Spell must not buff her) and the
   *  identity (her own arrival must not). Optional fields would let a producer
   *  omit them and leave her silently doing nothing — the exact failure this
   *  codebase keeps rediscovering — whereas required ones make the compiler name
   *  every site that fires the event. */
  | {
      kind: "cardPlayed";
      casterIndex: 0 | 1;
      playedKind: CardInstance["kind"];
      playedInstanceId: string;
      fromHidden?: boolean;
    }
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
  /**
   * Whether the ability actually TRIGGERS for this listener and event, as opposed
   * to merely listening for the right event kind.
   *
   * `on` is only half a trigger condition. "When you buff a **friendly** unit" also
   * requires the buffed unit to be the listener's — a check that has always lived
   * inside `resolve`, where returning the state unchanged made "did not trigger"
   * and "triggered and did nothing" indistinguishable. Inline, they ARE
   * indistinguishable, which is why it went unnoticed.
   *
   * Deferral separates them. A held trigger becomes a Chain Pending Item: it closes
   * the chain and costs both players a PassFocus. Holding one whose condition was
   * never met would open a response window at every buff on the board, including an
   * opponent's, for an ability that will resolve to nothing.
   *
   * Optional, defaulting to "yes": a trigger with no condition beyond its event
   * kind needs nothing here, and omitting it reproduces today's behaviour exactly.
   * `resolve` must still re-check its own conditions — the inline `dispatchEvent`
   * path does not consult this, and a resolution is separated from its trigger by a
   * response window in which the board can change.
   */
  applies?: (state: GameState, listener: Listener, event: GameEvent) => boolean;
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
 * Resolves a triggered ability that was waiting on the chain as a Pending Item
 * (809.1.b.3) — the deferred counterpart to `dispatchEvent` below.
 *
 * The listener is re-looked-up by instance id rather than carried as an object,
 * because between the trigger firing and this resolving the opponent has had a
 * window to respond and the permanent may be gone. A listener that has left play
 * resolves to nothing, which is 422's "do as much as you can" and the same
 * safe-no-op convention every dispatch here already follows.
 *
 * **SCOPE — this reaches the EventTrigger registry and nothing else.** The engine
 * has six trigger registries, and the other five cannot be resolved through this
 * shape as it stands:
 *   - Deathknells and death-watch need the whole `DeathContext`; the dying card is
 *     already in a trash, and `killerIndex` is derivable from no board state.
 *   - Self-triggers fire for a card that has left play, so no lookup can find it.
 *   - Unit on-play/on-attack/on-move triggers carry action-time choices (destination,
 *     targets, `isFirstMoveThisTurn`) that are destroyed by the time this runs.
 *   - The 7 legend hooks are not on the board at all: `allListeningPermanents` walks
 *     baseUnits, battlefield units and activeGear, never `players[i].legend`.
 * Each needs its own carried payload before its dispatch sites can be converted.
 *
 * An unregistered defId therefore THROWS rather than returning `state`. Only the
 * Cleanup's finalize pushes these entries, and it only pushes for abilities this
 * can run — so reaching that line means an unsupported source was queued, and
 * silently returning `state` is precisely how all seven legend hooks would
 * disappear without a single failing test.
 */
export function resolvePendingTrigger(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = allEventTriggers()[entry.listenerDefId];
  if (!trigger) {
    throw new Error(
      `resolvePendingTrigger: no event trigger registered for ${entry.listenerDefId} ` +
        `(${entry.listenerName}). Only EventTrigger-registry abilities may be held as ` +
        `Pending Items today — see this function's scope note.`,
    );
  }
  const listener = allListeningPermanents(state).find((l) => l.card.instanceId === entry.listenerInstanceId);
  if (!listener) return state; // left play while the response window was open
  const event = entry.event as GameEvent;
  if (trigger.on !== event.kind) return state;
  return trigger.resolve(state, listener, event);
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
 * dispatchOnUnitDied. `holdEventTrigger` is the converted counterpart.
 */
/**
 * The CONVERTED form of `dispatchEvent`: instead of resolving each listener inline,
 * adds one Pending Item to the chain per listener that would have fired (383 /
 * 338.1.a.3). They become respondable when the Cleanup finalizes them — see
 * cleanup.finalizePendingTriggers.
 *
 * Listeners are walked ONCE here, unlike `dispatchEvent`, which re-walks after every
 * resolution because an earlier trigger can remove a later one. That difference is
 * required rather than incidental: 383 says the set of abilities that triggered is
 * determined at the moment of the event, all together, and a permanent leaving play
 * afterwards does not un-trigger it — 809.1.b.3 exists precisely so a dead
 * permanent's trigger still resolves. `resolvePendingTrigger` re-looks-up the
 * listener and no-ops if it has gone, which is where "it left play" is handled.
 *
 * Pushed in walk order — turn player first — which under the chain's LIFO
 * resolution (343) makes the NON-turn player's triggers resolve first. That is what
 * 383 and 343 together require; see allListeningPermanents for why placement order
 * and resolution order are opposites.
 */
export function holdEventTrigger(state: GameState, event: GameEvent): GameState {
  const registry = allEventTriggers();
  const held: TriggerChainEntry[] = [];
  for (const listener of allListeningPermanents(state)) {
    const trigger = registry[listener.card.defId];
    if (trigger?.on !== event.kind) continue;
    if (trigger.applies && !trigger.applies(state, listener, event)) continue;
    held.push({
      kind: "trigger",
      playerIndex: listener.ownerIndex,
      listenerInstanceId: listener.card.instanceId,
      listenerDefId: listener.card.defId,
      listenerName: listener.card.name,
      ...(listener.battlefieldId !== undefined ? { battlefieldId: listener.battlefieldId } : {}),
      event,
    });
  }
  if (held.length === 0) return state;
  return { ...state, pendingTriggers: [...state.pendingTriggers, ...held] };
}

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
