import type { BattlefieldState, GameState, TriggerChainEntry } from "../model/game-state.js";
import type { DecisionDefinition } from "./decisions.js";
import { parkDecision } from "./decisions.js";
import { channelRunesExhausted, addBuff, drawCards } from "./effect-helpers.js";
import { placeRecruitToken } from "./token.js";
import { eventTriggerFor, type Listener } from "./triggers.js";

/**
 * The 24 printed Battlefield cards' abilities.
 *
 * **Battlefields carried no ability at all until now, and that was a gap rather
 * than a divergence.** `card-loader`'s `shouldSkip` excludes Battlefield-type
 * cards from `loadCardDefinitions`, so there is no `CardDefinition` to hang an
 * effect off and none of the six existing trigger registries can reach one.
 * `BattlefieldState.defId` is the key that made this table possible — it names
 * the printed card a battlefield in play IS.
 *
 * ## Why this is its own registry rather than an entry in `eventTriggers`
 *
 * `holdEventTrigger` walks `allListeningPermanents`, whose `Listener.card` is a
 * `CardInstance`. A battlefield is not a card instance: it has no owner, no
 * zone, no exhaust state, and it is not controlled by whoever it triggers for —
 * "when YOU hold here" fires for whichever player held it this turn, which can
 * be either. Manufacturing a fake `CardInstance` to squeeze it into that walk
 * would put a lie in the one structure every trigger resolution reads.
 *
 * So a battlefield ability is a fifth `TriggerChainEntry.source`, exactly like
 * `"deathknell"` and `"selfTrigger"`: the entry carries what resolution needs
 * and no board lookup happens. It shares those sources' rule — the ability
 * resolves regardless of what has happened to its source — and it shares it
 * more strongly than a Legend does, since a battlefield is in play from setup
 * to the end of the game and has no "it has gone" case at all.
 *
 * ## The moments
 *
 * Two of them are events this engine already has (`battlefieldHeld`,
 * `battlefieldConquered`) and are held by the same call that holds the
 * permanents' triggers; the rest are placed at their own site. A battlefield's
 * ability is placed LAST at every moment, which under the chain's LIFO
 * resolution (343) makes it resolve FIRST — the same choice, for the same
 * reason, as the Legend's position in `listeningPermanents`.
 */

/** What just happened at a battlefield, as its printed abilities read it. */
export type BattlefieldMoment =
  /** 471.1.a — `playerIndex` maintained Control here in their Beginning Phase
   *  and SCORED it. Fired by `scoring.scoreHolds`, once per battlefield held. */
  | "hold"
  /** 471.1 — `playerIndex` gained Control here. Fired by `scoring.recordConquest`. */
  | "conquer"
  /** 465 Step 1 — a Combat opened here and `playerIndex` is the Defender.
   *  Fired by `cleanup.beginCombatAt`, once per combat, never for an arrival. */
  | "defend"
  /** A unit completed a Standard Move OUT of here. `playerIndex` is the mover's
   *  controller and `unitInstanceId` is the unit that left. */
  | "unitMovedFrom"
  /** A Spell chose a unit standing here. `playerIndex` is the CHOOSING player
   *  and `unitInstanceId` is the unit that was chosen. */
  | "unitChosenBySpell";

/**
 * The moment, as the entry carries it.
 *
 * `playerIndex` is the ability's "you" and is therefore also whose Pending Item
 * it is — the player who gets priority to respond and the index the resolution
 * runs under. Which player that is differs per moment (the holder, the
 * conqueror, the defender, the mover's controller), which is exactly why it is
 * carried rather than re-derived from a board the response window can change.
 */
export interface BattlefieldTriggerEvent {
  moment: BattlefieldMoment;
  battlefieldId: string;
  playerIndex: 0 | 1;
  /** The unit this moment is ABOUT, for the two moments that have one. */
  unitInstanceId?: string;
}

export interface BattlefieldTriggerDefinition {
  on: BattlefieldMoment;
  /**
   * Whether the ability TRIGGERED, asked at the moment of the event — the same
   * split `EventTriggerDefinition.applies` makes, and here for the same reason:
   * a held trigger closes the chain and costs both players a PassFocus, so one
   * whose printed condition was never met must place no Pending Item at all.
   *
   * A condition about the BOARD at resolution stays in `resolve`, where a
   * trigger that fires and finds nothing is 422 working.
   */
  applies?: (state: GameState, event: BattlefieldTriggerEvent) => boolean;
  resolve: (state: GameState, event: BattlefieldTriggerEvent) => GameState;
}

/** The battlefield `event` happened at, or undefined if it has somehow gone.
 *  Every resolver re-reads it rather than capturing it: a battlefield cannot
 *  leave play, but its UNITS move constantly, and "here" means where they are
 *  when the ability resolves. */
function battlefieldOf(state: GameState, event: BattlefieldTriggerEvent): BattlefieldState | undefined {
  return state.battlefields.find((bf) => bf.id === event.battlefieldId);
}

/** `playerIndex`'s units standing at the battlefield this moment is about. */
function ownUnitsHere(state: GameState, event: BattlefieldTriggerEvent) {
  const bf = battlefieldOf(state, event);
  return bf?.units[state.players[event.playerIndex].id] ?? [];
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** Altar to Unity — "When you hold here, play a 1 Might Recruit unit token in
 *  your base." */
const ALTAR_TO_UNITY = "OGN-275";
/** Grove of the God-Willow — "When you hold here, draw 1." */
const GROVE_OF_THE_GOD_WILLOW = "OGN-280";
/** Hallowed Tomb — "When you hold here, you may return your Chosen Champion
 *  from your trash to your Champion Zone if it is empty." */
const HALLOWED_TOMB = "OGN-281";
/** Navori Fighting Pit — "When you hold here, buff a unit here." */
const NAVORI_FIGHTING_PIT = "OGN-283";
/** Reckoner's Arena — "When you hold here, activate the conquer effects of
 *  units here." */
const RECKONERS_ARENA = "OGN-286";
/** Startipped Peak — "When you hold here, you may channel 1 rune exhausted." */
const STARTIPPED_PEAK = "OGN-288";
/** The Grand Plaza — "When you hold here, if you have 7+ units here, you win
 *  the game." */
const THE_GRAND_PLAZA = "OGN-293";
/** How many units The Grand Plaza wants standing there. */
const GRAND_PLAZA_UNITS_TO_WIN = 7;

export const BATTLEFIELD_TRIGGERS: Record<string, BattlefieldTriggerDefinition> = {
  [ALTAR_TO_UNITY]: {
    on: "hold",
    // In your BASE, not here — the card says so, and it matters: a token placed
    // at the battlefield would be a unit arriving somewhere its controller
    // already holds, which contests nothing but does change what the next
    // Showdown fights over.
    resolve: (state, event) => placeRecruitToken(state, event.playerIndex, "base"),
  },

  [GROVE_OF_THE_GOD_WILLOW]: {
    on: "hold",
    resolve: (state, event) => drawCards(state, event.playerIndex, 1),
  },

  [HALLOWED_TOMB]: {
    on: "hold",
    // "If it is empty" is a question about the Champion Zone at RESOLUTION, and
    // so is "from your trash" — a response window can play the champion out of
    // the zone or recycle it out of the trash. Both stay here rather than in
    // `applies`; a trigger that fires and finds nothing is 422 working.
    resolve: (state, event) =>
      parkDecision(state, { kind: `${HALLOWED_TOMB}-return`, playerIndex: event.playerIndex }),
  },

  [NAVORI_FIGHTING_PIT]: {
    on: "hold",
    // Not a "you may", so the buff is mandatory — but WHICH unit is a real
    // choice, and with one unit standing there `advanceDecisions` executes it
    // without ever prompting.
    resolve: (state, event) =>
      parkDecision(state, {
        kind: `${NAVORI_FIGHTING_PIT}-buff`,
        playerIndex: event.playerIndex,
        battlefieldId: event.battlefieldId,
      }),
  },

  [RECKONERS_ARENA]: {
    on: "hold",
    resolve: (state, event) => activateConquerEffectsHere(state, event),
  },

  [STARTIPPED_PEAK]: {
    on: "hold",
    resolve: (state, event) =>
      parkDecision(state, { kind: `${STARTIPPED_PEAK}-channel`, playerIndex: event.playerIndex }),
  },

  [THE_GRAND_PLAZA]: {
    on: "hold",
    // "If you have 7+ units HERE" is counted at RESOLUTION rather than at the
    // hold. A response window can kill a unit standing there, and a win the
    // opponent could no longer prevent by removing the seventh unit would be a
    // stronger card than the one printed.
    resolve: (state, event) => {
      if (ownUnitsHere(state, event).length < GRAND_PLAZA_UNITS_TO_WIN) return state;
      // Declared rather than scored — see GameState.declaredWinnerIndex.
      return { ...state, declaredWinnerIndex: event.playerIndex };
    },
  },
};

/**
 * Reckoner's Arena — "activate the conquer effects of units here".
 *
 * ACTIVATE, not trigger: the units here have not conquered anything, so this is
 * the Arena causing their effects to happen. Each one's `resolve` is run
 * directly with a `battlefieldConquered` event naming this battlefield, which is
 * the event those abilities are written against.
 *
 * Two consequences, both deliberate. The activated effects resolve INSIDE the
 * Arena's own resolution rather than becoming Pending Items of their own — the
 * Arena is one triggered ability and this is what it does, the same way a spell
 * that kills three units is one chain item. And a unit's `applies` is NOT
 * consulted: `applies` answers whether the ability triggered, and nothing here
 * triggered — the Arena is activating it regardless.
 *
 * Only the HOLDER's units, and only those standing here. A held battlefield has
 * no enemy units on it by definition (`scoring.isHeldBy`), so the filter is a
 * statement of the card rather than a live distinction — but it stops the
 * ability from reaching a unit that arrives between the hold and the resolution.
 */
function activateConquerEffectsHere(state: GameState, event: BattlefieldTriggerEvent): GameState {
  const bf = battlefieldOf(state, event);
  if (!bf) return state;
  let next = state;
  for (const unit of ownUnitsHere(state, event)) {
    const trigger = eventTriggerFor(unit.defId);
    if (trigger?.on !== "battlefieldConquered") continue;
    const listener: Listener = {
      card: unit,
      ownerIndex: event.playerIndex,
      battlefieldId: bf.id,
      zone: "board",
    };
    next = trigger.resolve(
      next,
      listener,
      { kind: "battlefieldConquered", conquerorIndex: event.playerIndex, battlefieldId: bf.id },
      undefined,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * The questions the battlefields ask. Registered here rather than in a
 * per-domain effect file because every battlefield is Colorless — filing one by
 * domain would be meaningless, which is the same reason the Legends' decisions
 * live beside their abilities.
 */
export const battlefieldDecisions: Record<string, DecisionDefinition> = {
  [`${HALLOWED_TOMB}-return`]: {
    prompt: () => "Hallowed Tomb: return your Chosen Champion to your Champion Zone?",
    options: (state, d) => {
      const player = state.players[d.playerIndex];
      if (player.championZone !== null) return []; // "if it is empty"
      const inTrash = player.trash.find((c) => c.defId === player.chosenChampionDefId);
      if (!inTrash) return [];
      return [
        { id: inTrash.instanceId, label: `Return ${inTrash.name}`, instanceId: inTrash.instanceId },
        { id: "decline", label: "Decline" },
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const player = state.players[d.playerIndex];
      const card = player.trash.find((c) => c.instanceId === optionId);
      // Re-checked at the moment of the answer, not only when the options were
      // built: the zone is empty and the card is in the trash when this is
      // offered, and nothing between those two points may be assumed.
      if (!card || card.kind !== "Unit" || player.championZone !== null) return state;
      const players = [...state.players] as GameState["players"];
      players[d.playerIndex] = {
        ...player,
        trash: player.trash.filter((c) => c.instanceId !== optionId),
        championZone: card,
      };
      return { ...state, players };
    },
  },

  [`${NAVORI_FIGHTING_PIT}-buff`]: {
    prompt: () => "Navori Fighting Pit: buff a unit here",
    options: (state, d) => {
      const bf = state.battlefields.find((b) => b.id === d.battlefieldId);
      return (bf?.units[state.players[d.playerIndex].id] ?? []).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      }));
    },
    // `addBuff` is the funnel, not a field write: rule 708 makes a second buff on
    // an already-buffed unit a no-op, and the `unitBuffed` event Mistfall watches
    // is fired from there.
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },

  [`${STARTIPPED_PEAK}-channel`]: {
    prompt: () => "Startipped Peak: channel 1 rune exhausted?",
    options: (state, d) =>
      state.players[d.playerIndex].runeDeck.length === 0
        ? []
        : [
            { id: "channel", label: "Channel 1 rune exhausted" },
            { id: "decline", label: "Decline" },
          ],
    resolve: (state, d, optionId) => (optionId === "channel" ? channelRunesExhausted(state, d.playerIndex, 1) : state),
  },
};

// ---------------------------------------------------------------------------
// Holding and resolving
// ---------------------------------------------------------------------------

/**
 * Puts a battlefield's own printed ability in the holding pen (383), if the
 * battlefield in play is a card that has one for this moment.
 *
 * Returns the state unchanged otherwise, so every site can call it
 * unconditionally — including for a battlefield with no `defId` at all, which is
 * an ordinary state (a deck file may name a battlefield no card matches, and
 * most hand-built test states name none).
 *
 * **Called AFTER the permanents' triggers for the same moment**, so the
 * battlefield is placed last and resolves first under LIFO (343). Same choice,
 * and same reason, as the Legend's position in `listeningPermanents`: the
 * battlefield's printed effect is the frame the moment happens inside.
 */
export function holdBattlefieldTrigger(
  state: GameState,
  moment: BattlefieldMoment,
  battlefieldId: string,
  playerIndex: 0 | 1,
  unitInstanceId?: string,
): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf?.defId) return state;
  const trigger = BATTLEFIELD_TRIGGERS[bf.defId];
  if (trigger?.on !== moment) return state;
  const event: BattlefieldTriggerEvent = {
    moment,
    battlefieldId,
    playerIndex,
    ...(unitInstanceId !== undefined ? { unitInstanceId } : {}),
  };
  if (trigger.applies && !trigger.applies(state, event)) return state;
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "battlefield",
    playerIndex,
    // The battlefield's own id and printed card. A battlefield cannot leave play,
    // so unlike every other source these can never go stale — but they are
    // carried all the same, because the chain viewer names an item while it waits.
    listenerInstanceId: battlefieldId,
    listenerDefId: bf.defId,
    listenerName: bf.name,
    battlefieldId,
    event,
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/**
 * Resolves a held battlefield ability when the chain pops it.
 *
 * Nothing is looked up through a listener walk: the battlefield is named on the
 * entry and is still in play by construction. An unregistered defId returns the
 * state unchanged rather than throwing, and that is the one place this differs
 * from `resolvePendingTrigger` — every one of the 24 printed battlefields is in
 * the table (pinned by `battlefield-coverage.test.ts`), so the only way to reach
 * this line is a state carrying a `defId` from outside the loaded pool, which is
 * data rather than a registration bug.
 */
export function resolveHeldBattlefieldTrigger(state: GameState, entry: TriggerChainEntry): GameState {
  const trigger = BATTLEFIELD_TRIGGERS[entry.listenerDefId];
  if (!trigger) return state;
  return trigger.resolve(state, entry.event as BattlefieldTriggerEvent);
}

/** Every printed Battlefield card this module implements — the subject of the
 *  completeness gate in `battlefield-coverage.test.ts`, which is the only thing
 *  that can tell a battlefield with no ability from one whose ability was never
 *  written. */
export function battlefieldAbilityDefIds(): string[] {
  return Object.keys(BATTLEFIELD_TRIGGERS);
}
