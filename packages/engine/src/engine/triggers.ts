import type { GameState, PlayerState, TriggerChainEntry } from "../model/game-state.js";
import type { CardInstance, GearInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
// effect-helpers imports dispatchOnUnitDied from here, so this is a cycle. It is
// safe because the binding is only read INSIDE a resolver, long after both
// modules have initialised — the same reason the registries here compose lazily.
// Doing module-init work across this cycle is what broke the engine once before.
import { banishCard, drawCards, fileIntoNonBoardZone } from "./effect-helpers.js";
import { parkDecision } from "./decisions.js";
// equipment.ts already imports this module for `Listener` and `holdEventTrigger`
// — the same cycle, and safe for the same reason: the binding is read inside a
// resolver, never at module init.
import { copiedTextSourceFor, recordBanishedWithGear, textCopiesAmong, wearerListener, wearerOf, wearsMomentMirror } from "./equipment.js";
// Same cycle, same reason, as the effect-helpers import above: the binding is
// read only inside `allEventTriggers`, which composes lazily.
import { attackEventTriggers, spellCastEventTriggers } from "./unit-triggers.js";
import { legendEventTriggers } from "./legend-abilities.js";
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
  /**
   * The permanent — or, for a TRASH listener, the card sitting in a trash.
   *
   * Widened from `UnitInstance | GearInstance` for Super Mega Death Rocket,
   * whose "when you conquer" fires from the trash and whose card is a SPELL. The
   * four places that read more than an id/defId/name narrow first; `zone` below
   * is what tells them which shape they have.
   */
  card: CardInstance;
  ownerIndex: 0 | 1;
  /** undefined for a unit in base and for Gear (Gear is never at a
   *  battlefield in this pool — rule 323 step 5 recalls unattached gear), and
   *  for the Legend, which is in its own zone and at no battlefield. */
  battlefieldId?: string;
  /** Where the listener is. `"board"` for everything the permanent walk finds;
   *  `"trash"` for the cards `listeningTrashCards` adds; `"legend"` for the
   *  player's Legend. A trigger that only makes sense in one of them says so
   *  rather than inferring it. */
  zone?: "board" | "trash" | "legend";
}

/**
 * Every permanent `playerIndex` controls that an event could reach: units in
 * base, units at each battlefield, active Gear, and their LEGEND. Order is
 * deliberate and stable — base, then battlefields in board order, then gear,
 * then the legend — because several triggers auto-select a target and a stable
 * order is what makes their tests meaningful rather than incidental.
 *
 * **The Legend is last, and that is a choice about resolution order.** The chain
 * resolves LIFO (343), so placing it last makes it resolve FIRST among its
 * controller's simultaneous triggers — which is exactly where the inline Legend
 * dispatches used to sit (`scoring.recordConquest` fired the Legend, then held
 * the permanents). Putting it anywhere else would have silently reordered every
 * board that has a Legend and a permanent watching the same moment. 383 in fact
 * lets a player CHOOSE the order among their own simultaneous triggers, and this
 * engine fixes it; the fixed order is now base -> battlefields -> gear -> legend,
 * recorded in docs/rules-conformance.md with the rest of that divergence.
 *
 * **A Legend is the one listener that can never leave play.** `resolvePendingTrigger`
 * bails when it cannot re-find a listener, which is right for a bystander that
 * has been killed and is simply unreachable for a Legend — it sits in its own
 * zone from turn 1 to the end of the game. That is a fact about the zone, not
 * luck, and it is why Legend abilities need no equivalent of the on-play
 * triggers' "resolves even though its source is gone" branch.
 */
export function listeningPermanents(state: GameState, playerIndex: 0 | 1): Listener[] {
  const owner = state.players[playerIndex];
  const out: Listener[] = owner.baseUnits.map((card) => ({ card, ownerIndex: playerIndex, zone: "board" as const }));
  for (const bf of state.battlefields) {
    for (const card of bf.units[owner.id] ?? []) out.push({ card, ownerIndex: playerIndex, battlefieldId: bf.id, zone: "board" });
  }
  for (const card of owner.activeGear) out.push({ card, ownerIndex: playerIndex, zone: "board" });
  out.push({ card: owner.legend, ownerIndex: playerIndex, zone: "legend" });
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
export function allListeningPermanents(state: GameState, placesFirst?: 0 | 1): Listener[] {
  const first = placesFirst ?? state.activePlayerIndex;
  const second: 0 | 1 = first === 0 ? 1 : 0;
  return [
    ...listeningPermanents(state, first),
    ...listeningTrashCards(state, first),
    ...listeningPermanents(state, second),
    ...listeningTrashCards(state, second),
  ];
}

/**
 * Cards in `playerIndex`'s TRASH that can trigger from there — Super Mega Death
 * Rocket's "when you conquer, you may discard 1 to return this from your trash to
 * your hand".
 *
 * A NAMED SET rather than every card in the trash, and the difference is not
 * tidiness: a trash holds dozens of cards by mid-game, and walking all of them for
 * every event would make the listener scan proportional to the game's length
 * rather than to the board. Only the cards whose printed text says "from your
 * trash" can fire from there, and there are two.
 *
 * Kept beside the permanent walk rather than inside it because the two answer
 * different questions — "what is in play" and "what is watching from a graveyard"
 * — and only the first is what `resolvePendingTrigger`'s "did it leave play"
 * re-lookup is about.
 */
export function listeningTrashCards(state: GameState, playerIndex: 0 | 1): Listener[] {
  const owner = state.players[playerIndex];
  return owner.trash
    .filter((card) => TRASH_LISTENER_DEF_IDS.has(card.defId))
    .map((card) => ({ card, ownerIndex: playerIndex, zone: "trash" as const }));
}

/** Cards whose printed text triggers while they sit in a trash. Two in this pool,
 *  and both say "from your trash" out loud. */
const TRASH_LISTENER_DEF_IDS = new Set([
  "OGN-252", // Super Mega Death Rocket! — "when you conquer, you may discard 1 to return this from your trash"
  "OGN-037", // Immortal Phoenix — "when you kill a unit with a spell, you may pay ... to play me from your trash"
]);

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
  /**
   * True only for a death dealt in the COMBAT DAMAGE STEP.
   *
   * **`battlefieldId !== undefined` is NOT this question**, which is the whole
   * reason the flag exists: a spell kills units at a battlefield too, and
   * Draven - Audacious ("when I die IN COMBAT, choose an opponent — they score
   * 1 point") would hand an opponent a point for a removal spell.
   *
   * The Showdown state is no substitute either: `execute-pass-focus` nulls
   * `showdownBattlefieldId` the instant the Showdown closes, long before a held
   * death trigger resolves. Measured by the agent that refused to fake it.
   *
   * Set only by `combat.processDefeated`, which is the one site that knows.
   */
  diedInCombat?: true;
  /**
   * The Equipment the unit was WEARING as it died — Sacred Shears's
   * `[Deathknell]`, which is printed on the gear and fires on its wearer's
   * death.
   *
   * On the death because it cannot be asked afterwards: `killUnit` detaches
   * FIRST, before any ward or replacement, so by the time this event fires every
   * attachment is gone and a gear asking "was I worn by the unit that died?"
   * would always get no. The same 809.1.b.3 reasoning as `unit` itself — the
   * fact is captured at the moment of the death, not re-derived at resolution.
   */
  wornEquipment?: readonly GearInstance[];
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

export interface DeathWatchDefinition {
  /**
   * Whether the ability TRIGGERED, asked at the moment of the death.
   *
   * The same split `EventTriggerDefinition.applies` makes, arriving here for the
   * same reason: a death-watch is HELD now, so a listener whose printed condition
   * is unmet must place NO Pending Item rather than one that closes the chain,
   * costs both players a PassFocus and then resolves to nothing.
   *
   * Reads only the death and the listener — "friendly", "buffed", "your kill",
   * "stunned" are all facts about the death, and the response window cannot
   * change them because `DeathContext` captured them before the card reached the
   * trash (809.1.b.3). Anything about the BOARD at resolution stays in `resolve`.
   */
  applies?: (state: GameState, listener: Listener, death: DeathContext) => boolean;
  resolve: DeathWatchEffect;
}

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

let composedDeathWatch: Record<string, DeathWatchDefinition> | null = null;

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
function allDeathWatch(): Record<string, DeathWatchDefinition> {
  composedDeathWatch ??= mergeRegistries<DeathWatchDefinition>("death watch", [
    { name: "engine/triggers.ts", entries: DEATH_WATCH },
    ...domainDeathWatch(),
  ]);
  return composedDeathWatch;
}

const DEATH_WATCH: Record<string, DeathWatchDefinition> = {
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
  "OGN-118": {
    // "A FRIENDLY unit" is a fact about the death, so it decides whether the
    // Wraith triggers at all. The per-turn flag deliberately does NOT: it is a
    // resource, and with two friendly units dying at once both abilities trigger
    // (383 fixes the set at the moment of the event) while only the first to
    // resolve draws — which is what "the first time each turn" means.
    applies: (_state, listener, death) => death.ownerIndex === listener.ownerIndex,
    resolve: (state, listener) => {
      if (state.players[listener.ownerIndex].firstFriendlyDeathUsedThisTurn) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[listener.ownerIndex] = { ...players[listener.ownerIndex], firstFriendlyDeathUsedThisTurn: true };
      return drawCards({ ...state, players }, listener.ownerIndex, 1);
    },
  },

  /**
   * Sacred Shears (SFD-172) — `[Deathknell]` — Draw 1.
   *
   * **Printed on the ART, not in the card text** (`text.plain` holds only its
   * `[Equip]` line), so it is transcribed in docs/sfd-equipment-abilities.md
   * like the other thirty.
   *
   * A DEATH-WATCH rather than a `[Deathknell]`, and the distinction is the
   * card: 808's Deathknell is "when I die", keyed by the DYING card's defId —
   * and the gear does not die. Its WEARER does, and the gear survives (see
   * `killUnit`'s detach, which two other SFD cards presuppose by name). So the
   * gear watches for a death the way Wraith of Echoes does, and the condition is
   * "that death was mine to watch".
   *
   * `wornEquipment` carries the answer because nothing else can: the detach
   * happens before the event fires. Compared by INSTANCE, so two Sacred Shears
   * on two units are two separate answers rather than one shared defId.
   *
   * The draw is the LISTENER's controller — the gear's — which is the same
   * reading every death-watch here takes ("friendly is relative to the
   * listener"). It matters only when the two diverge, which `takeControlOfUnit`
   * makes reachable and `detachAllFrom`'s own comment already accounts for.
   */
  "SFD-172": {
    applies: (_state, listener, death) =>
      (death.wornEquipment ?? []).some((g) => g.instanceId === listener.card.instanceId),
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },

  /**
   * The Zero Drive (SFD-090) — `[Deathknell]` — Banish me.
   *
   * **Printed on the ART**, like Sacred Shears' just above and the other thirty;
   * `text.plain` carries only the `[Equip]` line and the activation. Transcribed
   * in docs/sfd-equipment-abilities.md.
   *
   * This is the half that FILLS the list its activated ability empties — without
   * it "play all units banished with this" is a sentence about an empty set, and
   * that is why the card's old partial note ("needs banish-with-source
   * tracking") named the storage rather than the trigger.
   *
   * A DEATH-WATCH on the same reasoning Sacred Shears records: 808's Deathknell
   * is keyed by the DYING card's defId and the gear does not die — its wearer
   * does, and `killUnit` detaches the gear first. So `wornEquipment` is the only
   * thing that can say the death was this Drive's, and it is compared by
   * INSTANCE so two Drives keep two separate lists.
   *
   * **The unit is banished FROM THE TRASH**, which is where `completeDeath` has
   * already filed it — a death-watch resolves after the death funnel, on purpose,
   * "so a listener sees a board the unit has already left". So this is not a
   * replacement of the death (809.1.b.1) and the unit's own `[Deathknell]` has
   * already fired, which is what "Deathknell — banish me" says: the banish is one
   * more death trigger, not an alternative to dying.
   *
   * The record is written to the gear WHEREVER it now is. `killUnit`'s detach
   * leaves it in `activeGear`, which is the only case reachable today; the
   * `banished` fallback is there because this card's own ability puts a Drive
   * there and a second Drive could in principle watch a death in between.
   */
  "SFD-090": {
    applies: (_state, listener, death) =>
      (death.wornEquipment ?? []).some((g) => g.instanceId === listener.card.instanceId),
    resolve: (state, listener, death) => {
      const banished = banishCard(state, death.ownerIndex, death.unit.instanceId);
      // Nothing to remember if the banish did not happen — a unit already
      // banished, or one some other effect has moved out of the trash.
      if (banished.players[death.ownerIndex].banished.every((c) => c.instanceId !== death.unit.instanceId)) {
        return banished;
      }
      return recordBanishedWithGear(banished, listener.ownerIndex, listener.card.instanceId, death.unit.instanceId);
    },
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
  "OGN-072": {
    // All three printed conditions are facts about the DEATH, captured before the
    // card reached the trash (809.1.b.3), so all three decide whether the Shrine
    // triggered rather than being re-asked later.
    applies: (_state, listener, death) =>
      death.killerIndex === listener.ownerIndex && // YOUR kill
      death.ownerIndex !== listener.ownerIndex && // an ENEMY unit
      death.unit.stunned,
    // The exhaust check stays at RESOLUTION, and the difference is the point: it
    // is the ability's COST, a question about the board when it resolves, and the
    // response window can exhaust the Shrine. Never offer what cannot be paid.
    resolve: (state, listener) => {
    // A Gear in play, so the narrowing is a formality — but `Listener.card` is a
    // CardInstance now that trash listeners share the type, and a Spell has no
    // `exhausted`.
    if (listener.card.kind === "Spell" || listener.card.exhausted) return state;
    return parkDecision(state, {
      kind: "OGN-072-draw",
      playerIndex: listener.ownerIndex,
      cardInstanceId: listener.card.instanceId,
    });
    },
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
/** Karthus - Eternal — "Your [Deathknell] effects trigger an additional time."
 *
 *  Counted from the board rather than registered as a listener: he is a
 *  CONTINUOUS effect on how another trigger resolves, not a trigger of his own,
 *  and a listener would fire alongside the Deathknell instead of multiplying it.
 *  He counts himself, so a dying Karthus's own Deathknell — if he had one —
 *  would already be gone from the board by the time this is asked, which is the
 *  right answer: he is not there to double it. */
export const KARTHUS_ETERNAL = "OGN-236";

/** For coverage.ts — the card this rule implements. Its own source rather than a
 *  line in `deathTriggerDefIds`, because Karthus has no death trigger: he
 *  changes how OTHER cards' triggers resolve, and filing him with them would
 *  make the coverage report say something untrue about where to look. */
export function deathknellModifierDefIds(): string[] {
  return [KARTHUS_ETERNAL];
}

function karthusCount(state: GameState, ownerIndex: 0 | 1): number {
  const owner = state.players[ownerIndex];
  return [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])].filter(
    (u) => u.defId === KARTHUS_ETERNAL,
  ).length;
}

/**
 * A unit died: place every ability that triggers on it, all at once (383).
 *
 * TWO mechanisms, because the two families have different listeners and only one
 * of them is on the board:
 *
 *  - the **[Deathknell]** belongs to the DYING card, which is already in a trash,
 *    so it is a `"deathknell"`-sourced entry carrying the whole `DeathContext`;
 *  - a **death-watch** listener is an ordinary permanent watching someone else
 *    die, so it rides the `unitDied` event through `holdEventTrigger` like every
 *    other converted kind, with its printed conditions in `applies`.
 *
 * **Two orderings changed here, and both are the rules arriving.** (1) The
 * Deathknell used to resolve before the death-watch listeners were even walked,
 * and the walk ran AFTER it with a comment explaining that a Deathknell which
 * kills things could remove a listener before it fired. 383 determines the whole
 * set of triggered abilities at the moment of the event, together — so a listener
 * the Deathknell later kills has still triggered, and 809.1.b makes its ability
 * resolve anyway. (2) The Deathknell is placed LAST so that under LIFO (343) it
 * still resolves FIRST, which is where it sat inline.
 */
export function holdUnitDied(state: GameState, death: DeathContext): GameState {
  const withWatchers = holdEventTrigger(state, { kind: "unitDied", death });
  return holdDeathknell(withWatchers, death);
}

/**
 * Puts the dying card's own `[Deathknell]` in the holding pen, if it has one.
 *
 * **The Karthus multiplier is counted NOW and carried**, not re-derived. "Your
 * [Deathknell] effects trigger an additional time" is a property of the moment
 * the ability triggered: a Karthus killed inside the response window — or by this
 * very death, in a board wipe — did not un-double a trigger that had already
 * fired. Reading the board at resolution would let it.
 */
function holdDeathknell(state: GameState, death: DeathContext): GameState {
  if (!allDeathknells()[death.unit.defId]) return state;
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "deathknell",
    playerIndex: death.ownerIndex,
    listenerInstanceId: death.unit.instanceId,
    listenerDefId: death.unit.defId,
    listenerName: death.unit.name,
    ...(death.battlefieldId !== undefined ? { battlefieldId: death.battlefieldId } : {}),
    // Karthus doubles every Deathknell its controller has; a Svellsongur doubles
    // the abilities of the ONE unit wearing it, so it is counted off the DEATH
    // rather than off the board. `wornEquipment` is what carries the answer —
    // `killUnit` detaches before this runs, exactly as Sacred Shears records.
    //
    // MULTIPLIED rather than summed: each is "an additional time" applied to
    // what the other leaves, so a Karthus and one copy is four executions, not
    // three. Both are read as the unit dies, for the reason Karthus's own note
    // gives — neither can be un-done inside the response window.
    event: {
      death,
      times: (1 + karthusCount(state, death.ownerIndex)) * (1 + textCopiesAmong(death.wornEquipment)),
    },
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/** What a held `[Deathknell]` carries: the death as it happened, and how many
 *  times to execute it (Karthus, counted at the moment of death). */
interface HeldDeathknell {
  death: DeathContext;
  times: number;
}

/**
 * Resolves a held `[Deathknell]` when the chain pops it.
 *
 * Nothing is looked up: the dying card is in a trash by now, which is the whole
 * reason this family needed its own source. 809.1.b again — an ability on the
 * Chain is independent of the card that made it.
 */
export function resolveHeldDeathknell(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = allDeathknells()[entry.listenerDefId];
  if (!trigger) return state;
  const { death, times } = entry.event as HeldDeathknell;
  let next = state;
  for (let i = 0; i < times; i += 1) next = trigger(next, contextFor(death.ownerIndex), death);
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
      /**
       * The PRINTED Power cost of the card played — Yordle Explorer's "when you
       * play a card with Power cost [rainbow][rainbow] or more".
       *
       * Carried on the event rather than looked up by the listener, because by
       * the time this resolves the card may be anywhere: a Spell is in the trash,
       * a Unit is on the board, and a countered card is in neither. The producer
       * holds the `CardInstance` and is the only place the answer is reliably
       * available.
       *
       * PRINTED, not paid. "A card WITH Power cost N" is a property of the card,
       * so a discount that reduced what was actually spent does not change it —
       * the same printed-vs-paid reading `modifiedEnergyCost` keeps separate.
       */
      playedPowerCost: number;
      fromHidden?: boolean;
    }
  /** `playerIndex`'s Beginning Phase is starting. Fired BEFORE holds score, for
   *  the same reason `[Temporary]`'s kill runs there: a Beginning-Phase ability
   *  that changes the board has to do so while there is still a scoring step
   *  left to be affected by it. */
  | { kind: "beginningPhase"; playerIndex: 0 | 1 }
  /**
   * `playerIndex`'s turn is ending — Sona - Harmonious's "at the end of your
   * turn", and the same moment `dispatchLegendEndOfTurn` already serves for
   * Annie - Dark Child.
   *
   * Fired from `runEnd` BEFORE the turn's "this turn" state is cleared and
   * before `activePlayerIndex` rotates, so `playerIndex` is the player whose
   * turn is ending and a listener asking "is it MY turn" gets the answer the
   * card means. It carries that index rather than leaving listeners to read
   * `state.activePlayerIndex`, because a held trigger resolves after the
   * rotation and would then read the wrong player — see the turn-boundary note
   * on `HeldEventKind`.
   */
  | { kind: "endOfTurn"; playerIndex: 0 | 1 }
  /**
   * A unit was CHOSEN as a target — Irelia - Fervent's "when you choose or ready
   * me", Irelia - Blade Dancer's "when you choose a friendly unit".
   *
   * **The moment is ANNOUNCEMENT, not resolution** (355): a unit moved or killed
   * while the Spell that named it waits on the chain was still chosen. That is
   * why both firing sites are in the `execute-*` action handlers rather than in
   * any resolver — by the time an effect runs, "was it chosen" is unanswerable.
   *
   * **Fired from BOTH choosing paths**, which is the half
   * `battlefield-abilities.holdUnitsChosenBySpell` never had: that one is keyed
   * to a BATTLEFIELD, is raised only for Spells, and drops a unit standing in
   * base. The Dreaming Tree wants exactly those restrictions ("a friendly unit
   * HERE"); a unit watching itself be chosen wants none of them, so this is a
   * second event rather than a widening of the first.
   *
   * `chooserIndex` is who did the choosing, which is not always the unit's
   * controller — "when YOU choose me" is satisfied only by its own side, and an
   * opponent paying `[Deflect]` to choose it is a different sentence. Cards ask
   * for themselves.
   *
   * `bySpell` says WHICH of the two paths raised it, and exists because the pool
   * prints both readings. Jae Medarda reads "when you choose me with a SPELL",
   * so an ability choosing him is not his moment; Spirit Wheel and Irelia -
   * Fervent read a bare "when you choose", so both paths are. Without the field
   * the narrower card can only be written as the wider one, which is the
   * direction this codebase does not ship.
   *
   * Required rather than optional, for the reason `cardPlayed`'s own
   * `playedKind` comment gives: an optional discriminator lets a producer omit
   * it and leaves the card that reads it silently doing nothing.
   */
  | { kind: "unitChosen"; chooserIndex: 0 | 1; unitInstanceId: string; bySpell: boolean }
  /**
   * A unit that was NOT `[Mighty]` now is — Fiora - Grand Duelist's "when one of
   * your units becomes [Mighty]".
   *
   * **A TRANSITION on a value that is recomputed on read**, which is what makes
   * it unlike every other event here. `effectiveMight` is derived from printed
   * Might plus buffs plus this-turn modifiers plus continuous auras plus
   * Equipment, so there is no stored field whose write could be the moment. The
   * only way to see a crossing is to compare before and after around something
   * that changes an input — which is what `withMightTransitions` does.
   *
   * **Fired from the RAISE helpers only, and that is a recorded partial**: a unit
   * that becomes Mighty because an AURA arrived (a Garen - Commander walking in)
   * is not seen, because nothing about that unit changed. See
   * docs/rules-conformance.md.
   */
  | { kind: "unitBecameMighty"; ownerIndex: 0 | 1; unitInstanceId: string }
  /**
   * A unit that was EXHAUSTED became Ready — Pirate's Haven's "when you ready a
   * friendly unit, give it +1 Might this turn".
   *
   * **Includes the Awakening Phase's mass ready**, which is the whole difference
   * between a combo trigger and +1 Might to a board every turn. Rule 415: "A
   * player Readies all non-spell Game Objects they Control during the Awakening
   * Phase on their turn", so the Awaken *is* a readying performed by the player
   * and "when you ready" is satisfied. Recorded in docs/rules-calls-resolved.md
   * as the strong reading, and it is the printed one.
   *
   * **Fires only for a unit that was actually exhausted.** 415 again: "A Unit
   * that is already Ready cannot be Readied again. If a Unit is instructed to be
   * Readied while it is already Ready, nothing additional happens." Same shape as
   * `addBuff`'s 708 guard and `stunUnits`' 422 one — a no-op is not an event.
   *
   * `ownerIndex` is whose unit it is, which is what "a FRIENDLY unit" is measured
   * against. There is deliberately no readier index: "you ready" and "a friendly
   * unit" collapse in this pool because every one of the thirteen `readyUnit`
   * call sites readies the actor's OWN unit (each is "ready me" or a
   * `owner: "friendly"` target), and the Awaken readies the active player's own
   * board. A carried readier would therefore be `ownerIndex` at every site — a
   * field that cannot be wrong yet, which is exactly the kind that goes wrong
   * silently later. The day a card readies an ENEMY unit, this is the field to
   * add, and the compiler will name every producer.
   */
  | { kind: "unitReadied"; ownerIndex: 0 | 1; unitInstanceId: string }
  /**
   * `holderIndex` HELD `battlefieldId` in their Beginning Phase — Ahri -
   * Alluring's "when I hold, you score 1 point".
   *
   * Held, in rule 471.1.a's sense: "maintains Control of a Battlefield they did
   * not yet Score this turn". So this is the SCORING event, not merely "still
   * has units there" — a battlefield already scored this turn by a Conquer is not
   * held again (471.1.b), and fires nothing.
   *
   * ONE event per battlefield, not one per Beginning Phase. Both cards that read
   * it say "when **I** hold", which is a claim about the battlefield the unit is
   * standing at, and a phase-shaped event could not say which battlefield was
   * meant when two are held at once.
   */
  | { kind: "battlefieldHeld"; holderIndex: 0 | 1; battlefieldId: string }
  /**
   * `killerIndex` killed a unit WITH A SPELL — Immortal Phoenix's condition, and
   * the only event in the union that is about HOW a death happened rather than
   * that it happened.
   *
   * Fired from `completeDeath` while `state.spellResolvingForIndex` names the
   * killer, which is the one place that knows both facts. Combat damage and
   * activated abilities never set that, so they never fire this — which is the
   * distinction the card draws.
   */
  | { kind: "unitKilledBySpell"; killerIndex: 0 | 1; unitInstanceId: string }
  /** A Buff was PLACED on a unit (Mistfall). `ownerIndex` is whose unit it is,
   *  which is what "a FRIENDLY unit" is measured against — not who caused it, so
   *  buffing an enemy unit does not offer their gear its trigger. Fired only when
   *  a buff was really placed: rule 708 makes a second one on an already-buffed
   *  unit a no-op, and a no-op is not a buffing. */
  | { kind: "unitBuffed"; ownerIndex: 0 | 1; unitInstanceId: string }
  /**
   * A unit completed a STANDARD move (a MoveUnit action), from `from` to `to`.
   *
   * Distinct from the per-card `ON_MOVE_TRIGGERS` table, which is keyed by the
   * MOVING unit's defId and so can never reach a listener on a different card —
   * Stealthy Pursuer watches "a friendly unit moves FROM my location" and
   * Volibear - Imposing watches an opponent's moves.
   *
   * `from` is `"base"` or a battlefield id, and it is the reason this event
   * exists rather than a widened `dispatchOnMove`: by the time that dispatcher
   * runs the unit has already been removed from where it was.
   *
   * Does NOT fire for a spell-driven relocation (`forceMoveToBattlefield`) or a
   * Recall (454 says a Recall is not a Move) — the same line
   * `movesThisTurn` draws, so the counter and the event never disagree.
   */
  | {
      kind: "unitMoved";
      moverIndex: 0 | 1;
      unitInstanceId: string;
      from: string;
      to: string;
      /** The mover's count AFTER this move — Yasuo - Windrider's "the third time
       *  I move in a turn" reads it here rather than re-deriving from a board
       *  the response window may have changed. */
      movesThisTurn: number;
    }
  /**
   * One or more cards were recycled to `ownerIndex`'s Main Deck — Karma -
   * Channeler's "when you recycle one or more cards to your Main Deck".
   *
   * ONE event per recycle INSTRUCTION however many cards it moved, the same
   * shape (and for the same reason) as `cardsDiscarded`: the card pays out once
   * for "one or more".
   *
   * **`ownerIndex` is whose DECK received the cards, not who performed the
   * recycle.** The rules leave "when YOU recycle" genuinely ambiguous — 1928
   * makes the two come apart, and this engine has a site that recycles the
   * opponent's trash at a caster's instruction — and the card's own wording
   * settles it as far as anything can: "to YOUR Main Deck". Recorded Unverified.
   */
  | { kind: "cardsRecycled"; ownerIndex: 0 | 1; count: number }
  /**
   * RUNES recycled to the rune deck — Sivir - Battle Mistress's "when you recycle
   * a rune".
   *
   * **Its own event, not a widening of `cardsRecycled` above**, and that one's
   * comment says why: "RUNES are deliberately not a caller: the card's own
   * reminder text says so." Karma - Channeler reads cards; Sivir reads runes.
   * Folding them would fire each card on the other's moment.
   *
   * One event per INSTRUCTION with a count, exactly as `cardsRecycled` is — a
   * cost that recycles two runes is one recycling, not two. That is the reading
   * this engine already applies to every batch event.
   */
  | { kind: "runesRecycled"; ownerIndex: 0 | 1; count: number }
  /**
   * A Buff was SPENT (704.1) — Fae Dragon's "when you spend a buff, play a Gold
   * gear token exhausted".
   *
   * The mirror of `unitBuffed`, which `addBuff` has always held, and it arrives
   * from the one place every spend goes through: `effect-helpers.spendBuff`
   * returns `undefined` rather than an unchanged state when the spend is
   * illegal, so a caller cannot take the payoff without paying — which makes it
   * the only site where a spend is known to have HAPPENED.
   *
   * `spenderIndex`, not the unit's owner: 705.1 already restricts spending to
   * units you control, so the two agree today — but the card says "when YOU
   * spend", and naming the spender is what keeps it true if a card ever spends
   * from a unit it does not own.
   *
   * ONE event per Buff. A stack of three spent twice is two events, because
   * `spendBuff` is called twice — there is no batch caller to be wrong about.
   */
  | { kind: "buffSpent"; spenderIndex: 0 | 1; unitInstanceId: string }
  /**
   * An Equipment was ATTACHED to a unit — Jax - Unrelenting's and Aphelios -
   * Exalted's "when you attach an Equipment to me".
   *
   * Fired from `equipment.attachEquipment`, which is the single writer of
   * `attachedToInstanceId` and says so in its module comment ("nothing else
   * assigns it, so a future attach source cannot skip whatever these grow to
   * do"). Five paths reach it — an `[Equip]` cost, `[Quick-Draw]`,
   * `[Weaponmaster]`, Jax - Grandmaster's ability and Forge of the Fluft's — and
   * this is what makes the sixth free.
   *
   * **A MOVE is an attach.** Jax - Grandmaster's second mode picks an Equipment
   * up off one unit and puts it on another, and the unit it lands on has had an
   * Equipment attached to it. The cards say "attach ... to me" and draw no
   * distinction, so neither does this.
   *
   * `unitInstanceId` is the WEARER, which is what both listeners key off — the
   * gear is the thing moving, and the unit is the thing being written about.
   */
  | { kind: "equipmentAttached"; ownerIndex: 0 | 1; gearInstanceId: string; unitInstanceId: string }
  /**
   * A Combat Showdown has just opened at `battlefieldId` — 465's Combat Step 1,
   * the moment units there gain the Attacker and Defender designations. Fired for
   * a freshly staged Combat and for a Non-Combat one promoted by 317.2, since
   * both are a combat beginning as far as a card that says "when a unit attacks
   * or defends" is concerned.
   *
   * **This is the moment ATTACK TRIGGERS fire** (383.4.f, "when a Unit or Player
   * gains the Attacker designation for the first time during a combat"), which is
   * why unit-triggers.ts's `ATTACK_TRIGGERS` register against this event rather
   * than being dispatched by the move that started the fight.
   *
   * Carries only the battlefield, deliberately: one event serves every listener
   * there, on BOTH sides, and which of them attacked is a question about the
   * board — `combat-designation.ts` answers it from `contestedByIndex`, which is
   * 465's own definition of the Attacker. A carried attacker index would be a
   * second copy of that fact, free to disagree with the field the Showdown
   * actually runs on.
   */
  | {
      kind: "combatBegan";
      battlefieldId: string;
      /**
       * The units gaining an Attacker or Defender designation AT THIS MOMENT —
       * everyone present when the combat opened, or just the arrivals at a later
       * Cleanup (465 Step 1).
       *
       * Carried rather than re-derived from the battlefield, because "everyone
       * standing here" and "everyone gaining the designation now" are the same
       * set only at the opening. 383.4.f's "for the first time during a combat"
       * is what makes the difference matter: without this, a reinforcement's
       * arrival would re-fire every attack trigger already in the fight.
       */
      designated: readonly string[];
    }
  /**
   * A combat WAS WON at `battlefieldId`, by `winnerIndex` — rule 466.5.a: a
   * player has won when they "are the only Player that has units remaining at
   * this battlefield during this step".
   *
   * **Not the same question as a conquest**, which is why this exists rather
   * than the cards reusing `battlefieldConquered`. A conquest also fires when a
   * unit simply walks into an empty battlefield, with no combat at all; and a
   * combat can be won at a battlefield the winner ALREADY controlled, which
   * establishes no new control and so conquers nothing. Three SFD cards read
   * "when I win a combat" and neither of those substitutes is that.
   *
   * **Only fired when exactly one side is left.** 466.5.d makes the other two
   * shapes a No Result rather than a win: both sides still standing after the
   * damage step (which is precisely when 466 step 3d recalls the attackers),
   * and neither side standing. So a mutual wipe wins nothing for anybody, and
   * a failed attack is not a defender's victory.
   *
   * Carries no unit list. A listener asks the ordinary positional question —
   * "am I at this battlefield and is my controller the winner" — and a unit
   * that died in the exchange is no longer a listener at all, because the walk
   * only finds permanents still in play. Carrying survivors would be a second
   * copy of the board, free to disagree with it.
   */
  | {
      kind: "combatWon";
      battlefieldId: string;
      winnerIndex: 0 | 1;
    }
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
  | {
      kind: "battlefieldConquered";
      conquerorIndex: 0 | 1;
      battlefieldId: string;
      /**
       * Was the battlefield UNCONTROLLED immediately before this conquest —
       * Yone - Blademaster's "when I conquer a battlefield that was uncontrolled".
       *
       * Carried on the event because it is unanswerable afterwards: control has
       * already moved to the conqueror by the time any listener runs, so a
       * listener asking the board would find the battlefield controlled and
       * could never tell "taken from nobody" from "taken from the opponent".
       * The one site that knows is `updateControl`, which compares the two.
       *
       * Optional rather than required, unlike `cardPlayed`'s `playedKind`: the
       * default (absent) reads as "not known to have been uncontrolled", which
       * is the CONSERVATIVE answer for a card that only ever pays out on the
       * positive — a producer that forgets it makes Yone silent, not wrong.
       */
      wasUncontrolled?: true;
    }
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
  | { kind: "cardsDiscarded"; discarderIndex: 0 | 1 }
  /**
   * A unit DIED — the event a death-watch listener watches, carrying the whole
   * `DeathContext` because every one of its conditions is about the unit as it
   * died rather than about the board now.
   *
   * 809.1.b.3 is the reason the payload is this shape: "before the card is moved
   * to the Trash, note its location, its attributes, and any other details
   * related to the effect of its triggered ability". By the time a held trigger
   * resolves the unit is in a trash with its Buff already stripped (709), so
   * "was it buffed", "was it stunned" and "where was it" have no other source.
   *
   * A `[Deathknell]` does NOT ride this event: its listener is the dying card
   * itself, which no walk over permanents in play can reach, so it is held as a
   * `"deathknell"`-sourced entry instead. Both are placed by the same call, at
   * the same moment.
   */
  | { kind: "unitDied"; death: DeathContext }
  /**
   * A Spell RESOLVED for `casterIndex` — Ravenbloom Student's and Lux -
   * Illuminated's "when you play a spell", and Lux - Lady of Luminosity's.
   *
   * `totalCost` is Energy PLUS Power, which is how both Lux cards read "costs 5
   * or more" (UnitAbilities.java:66 and LegendAbilities.java:47 are the same
   * `energyCost + powerCost >= 5`). It is carried because by the time a held
   * trigger resolves the Spell is in a trash and popped off the chain, so there
   * is nothing left to ask.
   *
   * **The MOMENT is the chain pop, not the play**, which is what this engine has
   * always done and is recorded as a divergence: the cards say "when you PLAY a
   * spell", and 383 would fire that as the Spell goes on the Chain. Converting
   * the mechanism does not move the moment — that is its own change, and the
   * Attack Triggers are the precedent for doing both at once only when the rules
   * tie them together.
   */
  | { kind: "spellCast"; casterIndex: 0 | 1; totalCost: number }
  /**
   * An ACTIVATED ABILITY was used — Prize of Progress's "when you use an
   * activated ability of a GEAR".
   *
   * `sourceKind` is the kind of the permanent whose ability it was, and it is
   * the whole condition for the one card that reads this: a unit's ability and
   * a legend's are not a gear's. Read off the RESOLVED source rather than from
   * the action, which names an instance and not what it is — the same reading
   * `execute-activate-ability` already takes for Ezreal - Prodigal Explorer's
   * "with spells or UNIT abilities" tally, two lines away in that file.
   *
   * Fired for the ACTIVATION rather than for the effect: an ability whose effect
   * ends up doing nothing was still used, the same reading the mode-use record
   * beside it takes.
   */
  | { kind: "abilityActivated"; activatorIndex: 0 | 1; sourceKind: CardInstance["kind"]; sourceInstanceId: string };

/**
 * The event kinds that have been CONVERTED to Chain Pending Items (383 /
 * 809.1.b.3) — held in `state.pendingTriggers` and finalized onto the chain by
 * `cleanup.finalizePendingTriggers` rather than resolved inline at their source.
 *
 * This exists so the compiler owns the conversion instead of a reviewer. Adding
 * a kind here makes `dispatchEvent` refuse it, which names every remaining
 * inline producer as a type error rather than leaving one behind to resolve the
 * same event immediately while its siblings go on the chain — a split that would
 * be invisible in play and would silently defeat every `applies` predicate.
 *
 * **An event kind must be converted ATOMICALLY, at every producer at once**, for
 * the same reason. `holdEventTrigger` consults `applies` and `dispatchEvent` does
 * not, so a half-converted kind resolves one way from one call site and the other
 * way from another.
 *
 * **A TURN-BOUNDARY event outlives the turn that fired it.** `submit`'s Pass runs
 * `runStartOfTurn(runEnd(state))` as one action with a single Cleanup at the end,
 * so a trigger held in `runEnd` is still in the pen while the turn rotates, the
 * next player Awakens, holds score and a card is drawn — and only finalizes onto
 * the chain after all of it. Every listener for such an event must therefore take
 * whose turn it was from the EVENT, never from `state.activePlayerIndex`, and must
 * settle any "am I still here" condition in `applies` at fire time. The divergence
 * this leaves (the End Phase's abilities resolve at the start of the next turn
 * rather than within the End Phase) is recorded in docs/rules-conformance.md, and
 * `test/turn-boundary-triggers.test.ts` pins the behaviour across the rotation.
 */
export type HeldEventKind =
  | "unitChosen"
  | "unitBecameMighty"
  | "unitBuffed"
  | "battlefieldConquered"
  | "cardPlayed"
  | "unitMoved"
  | "endOfTurn"
  | "unitReadied"
  | "battlefieldHeld"
  | "unitKilledBySpell"
  | "cardsRecycled"
  | "runesRecycled"
  | "buffSpent"
  | "equipmentAttached"
  | "combatBegan"
  | "combatWon"
  | "unitsStunned"
  | "cardsDiscarded"
  | "unitDied"
  | "spellCast"
  | "abilityActivated";

/** An event that is still resolved inline — everything not yet converted. */
export type InlineEvent = Exclude<GameEvent, { kind: HeldEventKind }>;

/** A listener, handed the event and its own permanent (so "I"/"my" resolve), plus
 *  whatever its `capture` noted at fire time (undefined when it has none). */
export type EventTriggerEffect = (state: GameState, listener: Listener, event: GameEvent, captured?: unknown) => GameState;

export interface EventTriggerDefinition {
  /**
   * The moment(s) this ability fires at.
   *
   * **A LIST is allowed, and SFD is why.** Corrupt Enforcer prints "when I move
   * to a battlefield, discard 1" AND "when I win a combat, draw 1"; Draven -
   * Vanquisher pairs an attack-or-defend trigger with a combat-won one. This
   * registry is keyed by defId, so before this a card could hold exactly one
   * event trigger and those second clauses had nowhere to live.
   *
   * Widening `on` rather than making the registry a list of definitions is the
   * smaller change and the one that keeps the chain honest:
   * `resolvePendingTrigger` finds a definition by `listenerDefId` alone, so two
   * separate definitions per card would need the chain entry to say WHICH, and
   * an entry that cannot say would resolve the wrong half. One definition that
   * branches on `event.kind` cannot get that wrong.
   *
   * `SelfTriggerDefinition.on` is already a list for the same reason (Scrapheap
   * wants all three of its moments), so this is the shape that file already
   * uses rather than a new idea. `applies` and `resolve` are handed the event,
   * so a multi-moment ability branches on `event.kind` exactly as they do.
   */
  on: GameEvent["kind"] | readonly GameEvent["kind"][];
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
  /**
   * What this ability has to note about the BOARD at the moment it triggered,
   * carried on the chain entry and handed back to `resolve`.
   *
   * `applies` answers whether the ability triggered; this answers what it
   * triggered ABOUT, and the two are different questions the moment a trigger is
   * held. "When a friendly unit attacks alone" triggers because exactly one unit
   * was there — and the ability is about THAT unit, which a resolution running a
   * response window later can no longer identify from the board.
   *
   * Only for facts the event cannot carry. An event is shared by every listener
   * (one `combatBegan` per battlefield, not one per card), so anything a
   * particular listener singled out belongs here rather than in a widened event.
   * Anything still true at resolution should simply be re-read there: capturing a
   * fact that has not moved just makes the entry bigger.
   *
   * Called only from `holdEventTrigger`, and only after `applies` has passed.
   */
  capture?: (state: GameState, listener: Listener, event: GameEvent) => unknown;
  /**
   * The plural of `capture`: place ONE Pending Item per value returned, each
   * carrying its own.
   *
   * For an ability whose printed subject is singular while the event that fires
   * it is plural. Ahri - Nine-Tailed Fox reads "when an ENEMY UNIT attacks a
   * battlefield you control", and 465 Step 1 designates every unit of the
   * attacking side at once — so three attackers is three triggered abilities,
   * each of which an opponent may respond to separately. One entry covering all
   * three would collapse three response windows into one, which is a smaller
   * board than the rules describe rather than a tidier one.
   *
   * Mutually exclusive with `capture` in practice: a definition wanting both
   * would be asking for one entry and many at the same time, so `capture` is
   * ignored when this is present.
   */
  captureEach?: (state: GameState, listener: Listener, event: GameEvent) => unknown[];
  resolve: EventTriggerEffect;
}

let composedEventTriggers: Record<string, EventTriggerDefinition> | null = null;

/** Composed lazily, same import-cycle reason as the registries in
 *  card-effects.ts and unit-triggers.ts. */
function allEventTriggers(): Record<string, EventTriggerDefinition> {
  composedEventTriggers ??= mergeRegistries<EventTriggerDefinition>("event trigger", [
    { name: "engine/triggers.ts", entries: {} },
    // The "when I attack" family, adapted from unit-triggers.ts's own table. It
    // is a merge SOURCE like a domain file rather than entries spliced in, so a
    // card registered in both places is the same named duplicate error as any
    // other — see attackEventTriggers for why the bodies did not move here.
    attackEventTriggers(),
    // The death-watch family, adapted onto the `unitDied` event. An adapter
    // rather than moving four cards into `eventTriggers`, for the reason the
    // attack one gives: their conditions are all about the DEATH, which the event
    // carries, and one shared narrowing beats four copies of it.
    deathWatchEventTriggers(),
    // The on-spell-cast family. Its listeners are units in play, so like the
    // death-watch it needed only a held event kind, not a `source`.
    spellCastEventTriggers(),
    // The LEGEND hooks whose moment is already a held event. A merge source like
    // any other, so a Legend defId colliding with a card's is the same named
    // error — see legendEventTriggers for why only four of the eight convert.
    legendEventTriggers(),
    ...domainEventTriggers(),
  ]);
  return composedEventTriggers;
}

/** Every defId with an event listener, for coverage.ts. */
export function eventTriggerDefIds(): string[] {
  return Object.keys(allEventTriggers());
}

/**
 * One card's event trigger, for the one caller that has to run an ability
 * WITHOUT its event having happened: Reckoner's Arena's "activate the conquer
 * effects of units here".
 *
 * Deliberately narrow — it hands back the definition rather than resolving
 * anything, so the battlefield decides which listeners it means (its own, and
 * only those standing there) instead of this module growing a card-shaped
 * function. `applies` is the caller's to ignore, and Reckoner's Arena does
 * ignore it: nothing triggered, so there is no trigger condition to test.
 */
/** Does this trigger fire at `kind`? One place, so the three dispatch sites
 *  cannot disagree about what a list-valued `on` means. */
export function listensFor(trigger: EventTriggerDefinition, kind: GameEvent["kind"]): boolean {
  return Array.isArray(trigger.on) ? trigger.on.includes(kind) : trigger.on === kind;
}

/**
 * Every event-trigger registry key this card answers to — its printed one, then
 * anything granted to it for the turn.
 *
 * One function so the walk and any future dispatch site cannot disagree about
 * what "this card's triggers" means. The printed key comes FIRST, which fixes the
 * order two abilities on one card are placed on the chain in; 383 in fact lets a
 * player choose that order, and this engine fixes it, which is the divergence
 * docs/rules-conformance.md already records for simultaneous triggers.
 *
 * Only a UNIT can carry a grant today — `grantedTriggersThisTurn` lives on
 * `UnitInstance` — so the `in` test is a shape test, the same one
 * `timingTierOf` uses for `isReaction`.
 */
export function triggerKeysOn(card: CardInstance): string[] {
  const granted = "grantedTriggersThisTurn" in card ? card.grantedTriggersThisTurn ?? [] : [];
  return [card.defId, ...granted];
}

/**
 * Every (listener, trigger key) pair this permanent answers to.
 *
 * Two pairs are ordinary — the card's own printed key and anything granted this
 * turn — and both keep the listener they were found with. The third is
 * Svellsongur's copied text, and it is the reason this is a pair rather than a
 * bare key list: a UNIT's trigger written against `listener.battlefieldId` and
 * `listener.ownerIndex` cannot run on a GEAR listener, which sits in a flat
 * `activeGear` list with no location at all. `wearerListener` is exactly that
 * rewrite, and it already exists for the eight wearer's-moments Equipment.
 *
 * **The copy resolves as the WEARER, which is what makes it a doubling.** The
 * rewritten listener carries the wearer's instanceId and defId, so the chain gets
 * a second entry identical to the one the unit placed for itself, and
 * `resolvePendingTrigger` re-finds the same unit and runs the same ability again.
 * Nothing about resolution had to learn anything.
 *
 * A Svellsongur's OWN defId is still asked and finds nothing registered, which is
 * correct: the gear has no printed effect text of its own to fire.
 */
function triggerCandidates(state: GameState, listener: Listener): { listener: Listener; key: string }[] {
  const own = triggerKeysOn(listener.card).map((key) => ({ listener, key }));
  if (listener.card.kind !== "Gear") return own;
  const copied = copiedTextSourceFor(state, listener.card);
  const asWearer = copied ? wearerListener(state, listener) : undefined;
  // A Svellsongur worn by a unit that has somehow left the board copies nothing —
  // the same target-vanished no-op `wearerListener` already answers with.
  return copied && asWearer ? [...own, { listener: asWearer, key: copied.unit.defId }] : own;
}

export function eventTriggerFor(defId: string): EventTriggerDefinition | undefined {
  return allEventTriggers()[defId];
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
  // The LIVE listener when it is still there, so an ability reading its own
  // current state sees the truth — otherwise the one captured when it fired.
  //
  // **This used to bail**, on the reading that an event-registry listener is a
  // bystander which must be in play to act. The rules do not say that. 359.3:
  // "If the spell checks information about a target that is no longer legal or a
  // card or permanent whose location, zone, or status has changed such that that
  // information is no longer available, that check returns 'null' and all
  // calculations based on it are ignored" — the item still resolves, and the
  // parts that referred to something gone are what drop out. The only rules that
  // REMOVE a triggered ability from the chain are a replaced death (809.1.b), the
  // controller declining to perform it, and declining to pay its cost. Bailing
  // silently discarded abilities the rules would have resolved, which was most
  // visible on a death-watch listener killed by the very Deathknell it triggered
  // on. Each resolver already answers safely for a unit it cannot find.
  const live = allListeningPermanents(state).find((l) => l.card.instanceId === entry.listenerInstanceId);
  const captured = entry.listenerCard as Listener["card"] | undefined;
  const listener: Listener | undefined =
    live ??
    (captured === undefined
      ? undefined
      : {
          card: captured,
          ownerIndex: entry.playerIndex,
          ...(entry.battlefieldId !== undefined ? { battlefieldId: entry.battlefieldId } : {}),
        });
  if (!listener) return state; // pre-`listenerCard` entry, and nothing on the board
  const event = entry.event as GameEvent;
  if (!listensFor(trigger, event.kind)) return state;
  return trigger.resolve(state, listener, event, entry.captured);
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
/**
 * Skyfall of Areion's rewritten moment — "My hold effects are also conquer
 * effects, and vice versa."
 *
 * # Why the moment is REWRITTEN rather than the trigger re-registered
 *
 * The card changes when an ability fires, and every "when I hold" in this pool
 * decides that in its own `applies`, against `event.kind`. So the cheapest honest
 * layer is to hand that predicate the OTHER moment: a hold, seen by a Skyfall
 * wearer's conquer trigger, arrives as a `battlefieldConquered` and every
 * existing condition works unchanged. Registering each trigger under both kinds
 * would instead need every one of the eleven cards edited, and would make the
 * mirror unconditional rather than a property of who is wearing what.
 *
 * The two events are structurally parallel — `{holderIndex, battlefieldId}` and
 * `{conquerorIndex, battlefieldId}` — which is what makes the translation total
 * rather than lossy.
 *
 * # What is deliberately dropped
 *
 * `wasUncontrolled` is NOT carried onto a mirrored conquest, and that is the
 * card rather than an omission: holding a battlefield means you already control
 * it, so "a battlefield that was uncontrolled" is false by construction. The
 * field's own note makes absent the conservative reading — Yone - Blademaster
 * stays silent rather than paying out wrongly.
 *
 * # Who it applies to
 *
 * A UNIT wearing one. "MY hold effects" is the WEARER's, the reading the eight
 * wearer's-moments Equipment establish for a pronoun on an Equipment, and the
 * only one that does anything here — the gear has no hold or conquer effects of
 * its own to mirror.
 */
function mirroredMoment(state: GameState, listener: Listener, event: GameEvent): GameEvent | undefined {
  if (event.kind !== "battlefieldHeld" && event.kind !== "battlefieldConquered") return undefined;
  // WHOSE moments these are. A unit's own, or — for a GEAR listener — its
  // wearer's, because the eight wearer's-moments Equipment write "when I
  // conquer" as the gear and mean the unit. A Warmog's Armor and a Skyfall on
  // the same body is exactly the case the card is for, and a check that only
  // looked at unit listeners would silently skip it.
  const unitInstanceId =
    listener.card.kind === "Unit"
      ? listener.card.instanceId
      : listener.card.kind === "Gear"
        ? wearerOf(state, listener.card)?.unit.instanceId
        : undefined;
  if (unitInstanceId === undefined || !wearsMomentMirror(state, unitInstanceId)) return undefined;
  return event.kind === "battlefieldHeld"
    ? { kind: "battlefieldConquered", conquerorIndex: event.holderIndex, battlefieldId: event.battlefieldId }
    : { kind: "battlefieldHeld", holderIndex: event.conquerorIndex, battlefieldId: event.battlefieldId };
}

export function holdEventTrigger(
  state: GameState,
  event: GameEvent,
  /**
   * Who places their abilities on the chain FIRST, when the moment has its own
   * order. Defaults to the turn player, which is 383's general rule.
   *
   * 465 Step 4 gives a combat its own: "The Attacking player, who has Focus,
   * places Triggered Abilities on the Chain first ... followed by the Defending
   * Player." Placement is the opposite of resolution (343, LIFO), so
   * attacker-first means the DEFENDER's combat triggers resolve first. The two
   * rules agree whenever the attacker IS the turn player, which is every combat a
   * Move starts; Charm is what pulls them apart, by contesting a battlefield for
   * the moved unit's controller on someone else's turn.
   */
  placesFirst?: 0 | 1,
): GameState {
  const registry = allEventTriggers();
  const held: TriggerChainEntry[] = [];
  for (const listener of allListeningPermanents(state, placesFirst)) {
    // The card's own printed trigger, plus anything GRANTED to it this turn —
    // Relentless Pursuit's "this turn, that unit has 'when I conquer…'". Both are
    // registry keys and both go through this one loop, so a granted ability
    // captures, holds, orders and resolves exactly as a printed one does.
    // Both of the ways a permanent can answer to a trigger that is not its own:
    // Relentless Pursuit's GRANT and Svellsongur's COPY. The copy brings its own
    // rewritten listener, which is why this is a pair.
    for (const { listener: seenBy, key } of triggerCandidates(state, listener)) {
      // Skyfall of Areion's mirror, computed against the listener this trigger
      // will actually run as — a copied one is the WEARER, whose Equipment is
      // what the mirror asks about.
      const mirror = mirroredMoment(state, seenBy, event);
      const trigger = registry[key];
      if (!trigger) continue;
      // WHICH event this trigger sees. The real one when it listens for that
      // moment; otherwise Skyfall of Areion's mirror of it, when there is one.
      //
      // In that order, and never both — a card that already lists BOTH moments
      // (Last Rites' "when I conquer or hold") is by its own text already what
      // the Skyfall would make it, and firing it twice for one moment would be
      // the mirror paying out where it has nothing to add.
      const seen = listensFor(trigger, event.kind)
        ? event
        : mirror !== undefined && listensFor(trigger, mirror.kind)
          ? mirror
          : undefined;
      if (seen === undefined) continue;
      if (trigger.applies && !trigger.applies(state, seenBy, seen)) continue;
      // Captured against the board as it stands NOW — before any other listener in
      // this same walk has resolved, which is what makes it a snapshot of the
      // moment of the event (383) rather than of whatever the chain did next.
      const entry = (captured: unknown): TriggerChainEntry => ({
        kind: "trigger",
        playerIndex: seenBy.ownerIndex,
        listenerInstanceId: seenBy.card.instanceId,
        // The KEY that matched, not the card's defId. `resolvePendingTrigger`
        // looks the definition back up by this field, so a granted ability
        // stamped with its wearer's defId would resolve as the wrong ability, or
        // throw for a card with no printed event trigger at all.
        listenerDefId: key,
        listenerName: seenBy.card.name,
        listenerCard: seenBy.card,
        ...(seenBy.battlefieldId !== undefined ? { battlefieldId: seenBy.battlefieldId } : {}),
        ...(captured !== undefined ? { captured } : {}),
        // `seen`, not the raw event — a mirrored moment must survive onto the
        // chain, or `resolvePendingTrigger` would hand this trigger an event of
        // a kind it does not listen for and drop it at the `listensFor` guard.
        event: seen,
      });
      if (trigger.captureEach) {
        for (const one of trigger.captureEach(state, seenBy, seen)) held.push(entry(one));
      } else {
        held.push(entry(trigger.capture?.(state, seenBy, seen)));
      }
    }
  }
  if (held.length === 0) return state;
  return { ...state, pendingTriggers: [...state.pendingTriggers, ...held] };
}

/**
 * `allDeathWatch()` presented as `unitDied` listeners, so a death-watch is an
 * ordinary held event with an ordinary `applies` predicate.
 *
 * The listener is a permanent in play, unlike a `[Deathknell]`'s — which is why
 * this family needs no `source` of its own and the other one does.
 */
function deathWatchEventTriggers(): { name: string; entries: Record<string, EventTriggerDefinition> } {
  const entries: Record<string, EventTriggerDefinition> = {};
  for (const [defId, watch] of Object.entries(allDeathWatch())) {
    entries[defId] = {
      on: "unitDied",
      applies: (state, listener, event) => event.kind === "unitDied" && (watch.applies?.(state, listener, event.death) ?? true),
      resolve: (state, listener, event) => (event.kind === "unitDied" ? watch.resolve(state, listener, event.death) : state),
    };
  }
  return { name: "engine/triggers.ts (death watch)", entries };
}

export function dispatchEvent(state: GameState, event: InlineEvent): GameState {
  const registry = allEventTriggers();
  let next = state;
  for (const listener of allListeningPermanents(next)) {
    const trigger = registry[listener.card.defId];
    if (!trigger || !listensFor(trigger, event.kind)) continue;
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

/**
 * Puts `card`'s own trigger for this moment in the holding pen (383), if it has
 * one — the counterpart to `holdUnitTrigger` and `holdMoveTrigger`.
 *
 * **The whole CARD rides on the entry**, which is what unblocked this family.
 * The old `dispatchSelfEvent` resolved inline with a comment explaining why it
 * had to: "it fires for a card that has just LEFT play or never entered it, so
 * `allListeningPermanents` cannot find it and `resolvePendingTrigger` could not
 * re-look it up". That is the right diagnosis of the wrong mechanism — the
 * unit-sourced entries had already stopped re-looking anything up. Carrying the
 * card is 809.1.b.3's "note its attributes before the card is moved to the
 * Trash" applied to all of them.
 *
 * Returns the state unchanged when the card has no trigger for this moment, so
 * every site can call it unconditionally.
 */
export function holdSelfTrigger(state: GameState, kind: SelfEventKind, card: CardInstance, ownerIndex: 0 | 1): GameState {
  const trigger = allSelfTriggers()[card.defId];
  if (!trigger || !trigger.on.includes(kind)) return state;
  const event: SelfEvent = { kind, card, ownerIndex };
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "selfTrigger",
    playerIndex: ownerIndex,
    listenerInstanceId: card.instanceId,
    listenerDefId: card.defId,
    listenerName: card.name,
    event,
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/**
 * Resolves a held self-trigger when the chain pops it.
 *
 * Nothing is looked up: the card is on the entry, and by now it is in a trash
 * (killed, discarded) or in play (played) — the ability does not care, and could
 * not find it in two of those three cases anyway. 809.1.b again: an ability on
 * the Chain is independent of the card that made it.
 */
export function resolveHeldSelfTrigger(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = allSelfTriggers()[entry.listenerDefId];
  if (!trigger) return state;
  return trigger.resolve(state, entry.event as SelfEvent);
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
    // A GEAR token (the Gold tokens) ceases to exist rather than resting in a
    // trash — rules 714/715, same as a unit token. See fileIntoNonBoardZone.
    trash: fileIntoNonBoardZone(owner.trash, gear),
  };
  // Trash first, then trigger — the trigger has to see a board the gear has
  // already left, the same ordering killUnit uses. HELD (383) rather than
  // dispatched, so the gear's payout is respondable like everything else.
  return holdSelfTrigger({ ...state, players }, "killed", gear, ownerIndex);
}

/**
 * Holds a `unitChosen` for each unit named as a target — the counterpart to
 * `battlefield-abilities.holdUnitsChosenBySpell`, and raised beside it.
 *
 * One event per chosen unit, because choosing two units is two choices: a Spell
 * that names the same unit twice (a `unitList` spec allows it) has chosen it
 * twice, and a card counting choices must count both.
 *
 * Deliberately does NOT check that the unit still exists. 355 fixes the choice
 * at announcement, and the only caller that could be wrong about it is one that
 * passes an id it never validated — which `validate-play-card` already refuses.
 *
 * `bySpell` is the caller's own path and is not inferred here — the two
 * `execute-*` handlers each know statically which they are, and asking the state
 * would be guessing at something already known.
 */
export function holdUnitsChosen(
  state: GameState,
  chooserIndex: 0 | 1,
  chosenInstanceIds: readonly string[],
  bySpell: boolean,
): GameState {
  return chosenInstanceIds.reduce(
    (next, unitInstanceId) => holdEventTrigger(next, { kind: "unitChosen", chooserIndex, unitInstanceId, bySpell }),
    state,
  );
}
