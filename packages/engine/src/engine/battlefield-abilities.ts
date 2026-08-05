import type { BattlefieldState, GameState, PlayerState, TriggerChainEntry } from "../model/game-state.js";
import type { DecisionDefinition } from "./decisions.js";
import { parkDecision, repeatDecision } from "./decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  discardThenDraw,
  drawCards,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  holdCardsRecycled,
  readyRunes,
  relocateToBaseUnchanged,
  payEnergyFromPool,
  spendBuff,
} from "./effect-helpers.js";
import { placeRecruitToken, placeGoldTokens } from "./token.js";
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
  | "unitChosenBySpell"
  /** `playerIndex`'s turn is ending — the moment a DELAYED battlefield ability
   *  fires (Targon's Peak's "…at the end of this turn"). Fired by
   *  `turn-manager.runEnd` for every battlefield, so only an `applies` keeps it
   *  from placing a Pending Item every turn for a battlefield that did nothing. */
  | "endOfTurn";

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
  /**
   * What this ability has to note about the BOARD at the moment it triggered,
   * carried on the chain entry and handed back to `resolve` — the same slot, for
   * the same reason, as `EventTriggerDefinition.capture`.
   *
   * Targon's Peak is why it exists here: "ready up to 2 runes at the end of this
   * turn" arms a per-turn counter, and `runEnd` clears every "this turn" field
   * BEFORE the trigger it fired resolves (the recorded turn-boundary divergence).
   * Re-reading the counter at resolution would therefore always find 0.
   */
  capture?: (state: GameState, event: BattlefieldTriggerEvent) => unknown;
  resolve: (state: GameState, event: BattlefieldTriggerEvent, captured?: unknown) => GameState;
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

/** Monastery of Hirana — "When you conquer here, you may spend a buff to draw 1." */
const MONASTERY_OF_HIRANA = "OGN-282";
/** Sigil of the Storm — "When you conquer here, you must recycle one of your
 *  runes. (This doesn't choose anything.)" */
const SIGIL_OF_THE_STORM = "OGN-287";
/** Targon's Peak — "When you conquer here, ready up to 2 runes at the end of
 *  this turn." */
const TARGONS_PEAK = "OGN-289";

/** Spiritforged's first implemented battlefield. The other 14 are unwritten and
 *  reported as progress by battlefield-coverage.test.ts, which is scoped to
 *  COMPLETE_SETS so OGN's 24 stay hard-gated while SFD is under construction. */
const TREASURE_HOARD = "SFD-220";
const TREASURE_HOARD_ENERGY = 1;
/** How many runes Targon's Peak arms per conquest. */
const TARGONS_PEAK_RUNES = 2;
/** The Candlelit Sanctum — "When you conquer here, look at the top two cards of
 *  your Main Deck. You may recycle one or both of them. Put those you don't back
 *  in any order." */
const THE_CANDLELIT_SANCTUM = "OGN-291";
/** How deep The Candlelit Sanctum looks. */
const CANDLELIT_LOOK = 2;
/** Zaun Warrens — "When you conquer here, discard 1, then draw 1." */
const ZAUN_WARRENS = "OGN-298";

/** Fortified Position — "When you defend here, choose a unit. It gains
 *  [Shield 2] this combat." */
const FORTIFIED_POSITION = "OGN-279";
/** The value Fortified Position grants — `[Shield 2]`, not `[Shield]`. */
const FORTIFIED_POSITION_SHIELD = 2;
/** Reaver's Row — "When you defend here, you may move a friendly unit here to
 *  base." */
const REAVERS_ROW = "OGN-285";

/** Obelisk of Power — "At the start of each player's first Beginning Phase,
 *  that player channels 1 rune." */
const OBELISK_OF_POWER = "OGN-284";
/** The Arena's Greatest — "At the start of each player's first Beginning Phase,
 *  that player gains 1 point." */
const THE_ARENAS_GREATEST = "OGN-290";
/** Back-Alley Bar — "When a unit moves from here, give it +1 Might this turn." */
const BACK_ALLEY_BAR = "OGN-277";
/** The Dreaming Tree — "When a player chooses a friendly unit here with a spell
 *  for the first time each turn, they draw 1." */
const THE_DREAMING_TREE = "OGN-292";

/**
 * Every printed Battlefield's abilities, keyed by its card id.
 *
 * A LIST per card rather than one definition, because a battlefield can print
 * two abilities at two different moments — Targon's Peak is "when you conquer
 * here, ready up to 2 runes AT THE END OF THIS TURN", which is a conquer trigger
 * that arms a delayed one. A single-definition table could only have expressed
 * that by resolving the delayed half somewhere outside this registry, where
 * nothing would report it as part of the card.
 */
export const BATTLEFIELD_TRIGGERS: Record<string, readonly BattlefieldTriggerDefinition[]> = {
  [ALTAR_TO_UNITY]: [
    {
      on: "hold",
      // In your BASE, not here — the card says so, and it matters: a token placed
      // at the battlefield would be a unit arriving somewhere its controller
      // already holds, which contests nothing but does change what the next
      // Showdown fights over.
      resolve: (state, event) => placeRecruitToken(state, event.playerIndex, "base"),
    },
  ],

  [GROVE_OF_THE_GOD_WILLOW]: [
    {
      on: "hold",
      resolve: (state, event) => drawCards(state, event.playerIndex, 1),
    },
  ],

  [HALLOWED_TOMB]: [
    {
      on: "hold",
      // "If it is empty" is a question about the Champion Zone at RESOLUTION, and
      // so is "from your trash" — a response window can play the champion out of
      // the zone or recycle it out of the trash. Both stay here rather than in
      // `applies`; a trigger that fires and finds nothing is 422 working.
      resolve: (state, event) =>
        parkDecision(state, { kind: `${HALLOWED_TOMB}-return`, playerIndex: event.playerIndex }),
    },
  ],

  [NAVORI_FIGHTING_PIT]: [
    {
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
  ],

  [RECKONERS_ARENA]: [
    {
      on: "hold",
      resolve: (state, event) => activateConquerEffectsHere(state, event),
    },
  ],

  [STARTIPPED_PEAK]: [
    {
      on: "hold",
      resolve: (state, event) =>
        parkDecision(state, { kind: `${STARTIPPED_PEAK}-channel`, playerIndex: event.playerIndex }),
    },
  ],

  [THE_GRAND_PLAZA]: [
    {
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
  ],

  [MONASTERY_OF_HIRANA]: [
    {
      on: "conquer",
      // The buff is the COST of the draw, so an unbuffed board is nothing to offer
      // and nothing is asked — 416.3, and the shape `canPayActivationCost` uses.
      // Asked at resolution rather than in `applies`, because "do I control a
      // buffed unit" is a question about the BOARD, and the response window this
      // hold opens can buff one or spend the only one there was.
      resolve: (state, event) =>
        parkDecision(state, { kind: `${MONASTERY_OF_HIRANA}-spend`, playerIndex: event.playerIndex }),
    },
  ],

  [TREASURE_HOARD]: [
    {
      on: "conquer",
      // Treasure Hoard (SFD) — "When you conquer here, you may pay
      // :rb_energy_1: to play a Gold gear token exhausted."
      //
      // The FIRST battlefield in this table to make a gear token, and it could
      // not be written at all until `token.ts` learned to mint one: it minted
      // `UnitInstance` only, which is the blocker eleven SFD cards and this
      // battlefield shared.
      //
      // Asked at RESOLUTION rather than in `applies`, for the same reason
      // Monastery of Hirana is: "can I afford 1 Energy" is a question about
      // the board, and the response window this hold opens can spend the
      // Energy that was there when it fired.
      resolve: (state, event) =>
        parkDecision(state, { kind: `${TREASURE_HOARD}-buy`, playerIndex: event.playerIndex }),
    },
  ],

  [SIGIL_OF_THE_STORM]: [
    {
      on: "conquer",
      // "You MUST recycle one of your runes. (This doesn't choose anything.)" —
      // the parenthesis is the card telling you it is not a choice, so no decision
      // is parked and the rune is taken in pool order. The same call, and the same
      // reasoning, as `payEnergyFromPool`'s: deterministic, and recorded Unverified
      // because which rune goes decides which DOMAINS remain.
      resolve: (state, event) => {
        const rune = state.players[event.playerIndex].channeled[0];
        return rune ? recycleRuneToRuneDeck(state, event.playerIndex, rune.id) : state;
      },
    },
  ],

  [TARGONS_PEAK]: [
    {
      on: "conquer",
      // A DELAYED effect: the conquest arms it, `runEnd` is what fires it. Two
      // conquests here in one turn arm four, because the trigger is on conquering
      // and not on scoring — 471.1.b withholds the second POINT, not the trigger.
      resolve: (state, event) =>
        updatePlayer(state, event.playerIndex, (p) => ({
          ...p,
          readyRunesAtEndOfTurn: p.readyRunesAtEndOfTurn + TARGONS_PEAK_RUNES,
        })),
    },
    {
      // The delayed half — "…at the end of this turn". It is a second ability of
      // the same card, which is the whole reason a battlefield's entry is a LIST:
      // resolving it anywhere outside this registry would leave nothing able to
      // report it as part of Targon's Peak.
      on: "endOfTurn",
      // Nothing armed, nothing to hold — otherwise every end of turn would put a
      // Pending Item on the chain for a battlefield that did nothing this turn.
      applies: (state, event) => state.players[event.playerIndex].readyRunesAtEndOfTurn > 0,
      // CAPTURED, and this is the one ability in the table that has to be. `runEnd`
      // clears every "this turn" field before the trigger it fired resolves — the
      // recorded turn-boundary divergence — so re-reading the counter at
      // resolution would always find 0 and the card would silently do nothing.
      capture: (state, event) => state.players[event.playerIndex].readyRunesAtEndOfTurn,
      resolve: (state, event, captured) => readyRunes(state, event.playerIndex, captured as number),
    },
  ],

  [THE_CANDLELIT_SANCTUM]: [
    {
      on: "conquer",
      resolve: (state, event) =>
        parkDecision(state, {
          kind: `${THE_CANDLELIT_SANCTUM}-look`,
          playerIndex: event.playerIndex,
          count: CANDLELIT_LOOK,
        }),
    },
  ],

  [ZAUN_WARRENS]: [
    {
      on: "conquer",
      // "Discard 1, THEN draw 1" — the order is load-bearing and `discardThenDraw`
      // is the funnel that keeps it: the discard stops to ask, so the draw has to
      // be queued behind the question rather than composed around it, or a card
      // just drawn could be one of the cards discarded.
      resolve: (state, event) => discardThenDraw(state, event.playerIndex, 1, 1),
    },
  ],

  [FORTIFIED_POSITION]: [
    {
      on: "defend",
      resolve: (state, event) =>
        parkDecision(state, {
          kind: `${FORTIFIED_POSITION}-shield`,
          playerIndex: event.playerIndex,
          battlefieldId: event.battlefieldId,
        }),
    },
  ],

  [REAVERS_ROW]: [
    {
      on: "defend",
      resolve: (state, event) =>
        parkDecision(state, {
          kind: `${REAVERS_ROW}-retreat`,
          playerIndex: event.playerIndex,
          battlefieldId: event.battlefieldId,
        }),
    },
  ],

  [BACK_ALLEY_BAR]: [
    {
      on: "unitMovedFrom",
      // "GIVE IT +1 Might this turn" — the unit that left, which is why this is
      // the only moment that carries a `unitInstanceId`. The unit is no longer
      // here by the time this resolves, and it does not need to be: the Bar is
      // paying for the departure, not for standing there.
      resolve: (state, event) =>
        event.unitInstanceId === undefined
          ? state
          : giveMightThisTurnToOwnUnit(state, event.playerIndex, event.unitInstanceId, 1),
    },
  ],

  [THE_DREAMING_TREE]: [
    {
      on: "unitChosenBySpell",
      // "For the first time each turn" is checked at RESOLUTION rather than
      // here, following Wraith of Echoes: the per-turn allowance is a RESOURCE,
      // not a trigger condition, so a second choice in the same turn still
      // triggers and resolves to nothing. What DOES belong here — that the
      // chosen unit is friendly to the chooser and standing at this battlefield
      // — is already settled by the site that fires the moment.
      resolve: (state, event) => {
        const used = state.players[event.playerIndex].spellChoiceDrawnBattlefieldIds;
        if (used.includes(event.battlefieldId)) return state;
        return drawCards(
          updatePlayer(state, event.playerIndex, (p) => ({
            ...p,
            spellChoiceDrawnBattlefieldIds: [...p.spellChoiceDrawnBattlefieldIds, event.battlefieldId],
          })),
          event.playerIndex,
          1,
        );
      },
    },
  ],
};

/**
 * The Dreaming Tree's moment — a Spell has CHOSEN these units, at announce.
 *
 * Called from `execute-play-card` with every unit the played Spell named, and it
 * is this function rather than the trigger's `applies` that settles the card's
 * two conditions: "a FRIENDLY unit" (friendly to the CHOOSER, not to the
 * battlefield's controller) and "HERE" (standing at the battlefield, not in
 * base). Both are facts about the moment of the choice, which 355 puts at
 * announce — a unit moved or killed before the Spell resolves was still chosen.
 *
 * One Pending Item per chosen unit, because the Tree is about a unit being
 * chosen and a Spell that names two units here has chosen twice. Only the first
 * to RESOLVE draws, which is what "the first time each turn" means.
 */
export function holdUnitsChosenBySpell(
  state: GameState,
  chooserIndex: 0 | 1,
  chosenInstanceIds: readonly string[],
): GameState {
  let next = state;
  const chooserId = state.players[chooserIndex].id;
  for (const unitInstanceId of chosenInstanceIds) {
    const bf = next.battlefields.find((b) => (b.units[chooserId] ?? []).some((u) => u.instanceId === unitInstanceId));
    if (!bf) continue; // in base, or not the chooser's — neither is "a friendly unit here"
    next = holdBattlefieldTrigger(next, "unitChosenBySpell", bf.id, chooserIndex, unitInstanceId);
  }
  return next;
}

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

  [`${TREASURE_HOARD}-buy`]: {
    prompt: () => "Treasure Hoard: pay 1 Energy to play a Gold gear token exhausted?",
    options: (state, d) =>
      // Unaffordable is not a question — the decision is dropped whole rather
      // than offered as a lone "Decline", which would be theatre. Same shape,
      // and same reasoning, as the Monastery below.
      //
      // **Affordability is asked of `payEnergyFromPool` itself**, not
      // recomputed here. There is no `energy` FIELD to compare against —
      // Energy is floating Energy plus Ready channeled runes, and the first
      // draft of this compared a property that does not exist, so
      // `undefined < 1` was false, the option was always offered, and the
      // payment then failed silently. Asking the payer is also what stops an
      // offer and its validator disagreeing, which is the shape behind three
      // recorded offered-then-refused bugs in this codebase.
      payEnergyFromPool(state, d.playerIndex, TREASURE_HOARD_ENERGY) === undefined
        ? []
        : [
            { id: "buy", label: `Pay ${TREASURE_HOARD_ENERGY} Energy for a Gold token` },
            { id: "decline", label: "Decline" },
          ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Pay FIRST. `payEnergyFromPool` returns undefined when the pool cannot
      // cover it, and handing over the token for a cost that could not be paid
      // is the shape this file already records for Solari Shrine's exhaust —
      // the Energy can be gone by the time this resolves, because the hold
      // opened a response window.
      const paid = payEnergyFromPool(state, d.playerIndex, TREASURE_HOARD_ENERGY);
      return paid === undefined ? state : placeGoldTokens(paid, d.playerIndex, 1);
    },
  },

  [`${MONASTERY_OF_HIRANA}-spend`]: {
    prompt: () => "Monastery of Hirana: spend a buff to draw 1?",
    options: (state, d) => {
      const buffed = ownUnitsOf(state, d.playerIndex).filter((u) => u.buffed);
      // Nothing to pay with is not a question — the decision is dropped whole
      // rather than offered as a lone "Decline", which would be theatre.
      if (buffed.length === 0) return [];
      return [
        ...buffed.map((u) => ({ id: u.instanceId, label: `Spend ${u.name}'s buff`, instanceId: u.instanceId })),
        { id: "decline", label: "Decline" },
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Pay FIRST: `spendBuff` returns undefined when the spend is illegal (705),
      // and handing over the draw for a cost that could not be paid is the shape
      // this codebase already records for Solari Shrine's exhaust.
      const paid = spendBuff(state, d.playerIndex, optionId);
      return paid === undefined ? state : drawCards(paid, d.playerIndex, 1);
    },
  },

  /**
   * The Candlelit Sanctum's look — "you may recycle one or both of them".
   *
   * Asked ONE card at a time, like the generic `discard`, rather than as a
   * multi-select: an answer naming a set would have to be carried on the decision
   * and validated against itself, where a one-at-a-time cut is rebuilt from live
   * state like every other question here. `count` is how many of the top of the
   * deck are still under consideration — recycling sends a card to the BOTTOM, so
   * the ones still being looked at stay on top and the count simply drops.
   */
  [`${THE_CANDLELIT_SANCTUM}-look`]: {
    prompt: (state, d) => `The Candlelit Sanctum: recycle any of the top ${d.count ?? 0}?`,
    options: (state, d) => {
      const looked = state.players[d.playerIndex].deck.slice(0, d.count ?? 0);
      if (looked.length === 0) return [];
      return [
        ...looked.map((c) => ({ id: c.instanceId, label: `Recycle ${c.name}`, instanceId: c.instanceId })),
        { id: "keep", label: "Put the rest back" },
      ];
    },
    resolve: (state, d, optionId) => {
      const remaining = d.count ?? 0;
      if (optionId === "keep") return orderKeptCards(state, d.playerIndex, remaining);
      const looked = state.players[d.playerIndex].deck.slice(0, remaining);
      if (!looked.some((c) => c.instanceId === optionId)) return state;
      const recycled = holdCardsRecycled(
        updatePlayer(state, d.playerIndex, (p) => ({
          ...p,
          deck: [...p.deck.filter((c) => c.instanceId !== optionId), p.deck.find((c) => c.instanceId === optionId)!],
        })),
        d.playerIndex,
        1,
      );
      // Re-parked onto the FRONT: this is a continuation of the same look, not a
      // new question, so nothing raised later may run between the two halves.
      if (remaining - 1 <= 0) return recycled;
      return repeatDecision(recycled, { ...d, count: remaining - 1 });
    },
  },

  /** "Put those you don't back in any ORDER" — asked only when two survive, since
   *  one card has no order. The answer goes on TOP. */
  [`${THE_CANDLELIT_SANCTUM}-order`]: {
    prompt: () => "The Candlelit Sanctum: which goes back on top?",
    options: (state, d) =>
      state.players[d.playerIndex].deck
        .slice(0, d.count ?? 0)
        .map((c) => ({ id: c.instanceId, label: `${c.name} on top`, instanceId: c.instanceId })),
    resolve: (state, d, optionId) =>
      updatePlayer(state, d.playerIndex, (p) => {
        const top = p.deck.slice(0, d.count ?? 0);
        const chosen = top.find((c) => c.instanceId === optionId);
        if (!chosen) return p;
        return { ...p, deck: [chosen, ...top.filter((c) => c.instanceId !== optionId), ...p.deck.slice(top.length)] };
      }),
  },

  /**
   * Fortified Position — "choose a unit. It gains [Shield 2] this combat."
   *
   * **Every unit AT the battlefield is offered, on both sides**, because the card
   * names no owner — the same reading Adaptatron's "you may kill a gear" takes,
   * and for the same reason: shielding an enemy is a legal, occasionally sensible
   * play, and filtering to your own would quietly rewrite the card. Scoped to the
   * battlefield rather than the whole board because `[Shield]` only contributes
   * while DEFENDING, so it does nothing at all to a unit that is not in this
   * fight. Recorded Unverified.
   *
   * **"This combat" is implemented as this TURN**, which is the divergence: it
   * lands on `keywordsThisTurn`, so a second combat in the same turn would still
   * find the Shield there. There is no per-combat scope in this engine, and
   * inventing one for a single card would be a subsystem.
   */
  [`${FORTIFIED_POSITION}-shield`]: {
    prompt: () => "Fortified Position: give a unit [Shield 2] this combat",
    options: (state, d) => unitsAt(state, d.battlefieldId).map(({ unit }) => ({
      id: unit.instanceId,
      label: unit.name,
      instanceId: unit.instanceId,
    })),
    resolve: (state, _d, optionId) =>
      grantKeywordThisTurn(state, optionId, "Shield", FORTIFIED_POSITION_SHIELD),
  },

  /**
   * Reaver's Row — "you may move a friendly unit here to base."
   *
   * MOVE, not Recall, so it goes through `relocateToBaseUnchanged` and the unit
   * does not exhaust: 454 says a Recall leaves statuses untouched and this
   * engine's `recallUnitToBase` force-exhausts for the player-initiated retreat.
   * Nothing else about it is a move either — `movesThisTurn` is untouched and no
   * `unitMoved` event fires, for the reason that helper's own note gives.
   *
   * "FRIENDLY" is relative to the defender, so only their units are offered.
   */
  [`${REAVERS_ROW}-retreat`]: {
    prompt: () => "Reaver's Row: move a friendly unit here to base?",
    options: (state, d) => {
      const mine = unitsAt(state, d.battlefieldId).filter(({ ownerIndex }) => ownerIndex === d.playerIndex);
      if (mine.length === 0) return [];
      return [
        ...mine.map(({ unit }) => ({ id: unit.instanceId, label: `Retreat ${unit.name}`, instanceId: unit.instanceId })),
        { id: "decline", label: "Decline" },
      ];
    },
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : relocateToBaseUnchanged(state, optionId)),
  },
};

// ---------------------------------------------------------------------------
// The Beginning-Phase pair, which do NOT go on the chain
// ---------------------------------------------------------------------------

/**
 * "At the start of each player's FIRST Beginning Phase" — the two battlefields
 * whose ability happens once per player per game.
 *
 * **Resolved INLINE, not held**, and that is the same deliberate exception
 * `beginningPhase` already is for Dr. Mundo, Mushroom Pouch and Jinx - Loose
 * Cannon's Legend: holding it would resolve the ability AFTER `scoreHolds`,
 * breaking an ordering `runBeginning`'s own comment calls load-bearing. The
 * Arena's Greatest is the card that makes it matter — a point gained after holds
 * score is a point gained in the wrong phase.
 *
 * **"Their first" is `turnNumber === 1`, and that is exact rather than
 * approximate.** `runEnd` only advances the counter when play wraps back to the
 * FIRST player (118), so BOTH players' opening turns are turn 1 and each gets
 * exactly one. The one thing that could give a player two Beginning Phases at
 * turn 1 is an extra turn (Time Warp, which does not bump the counter) — and
 * Time Warp costs 10 Energy plus 4 Power against a turn-1 pool of two or three
 * runes, so it is unreachable rather than merely unlikely. Measured, not assumed.
 */
export function runBattlefieldBeginningPhase(state: GameState, playerIndex: 0 | 1): GameState {
  if (state.turnNumber !== 1) return state;
  let next = state;
  for (const bf of state.battlefields) {
    if (bf.defId === OBELISK_OF_POWER) next = channelRunes(next, playerIndex, 1);
    if (bf.defId === THE_ARENAS_GREATEST) {
      next = updatePlayer(next, playerIndex, (p) => ({ ...p, points: p.points + 1 }));
    }
  }
  return next;
}

/**
 * Obelisk of Power's "channels 1 rune" — READY, unlike Startipped Peak's
 * "channel 1 rune exhausted".
 *
 * Its own three lines rather than a shared helper, because the only existing one
 * (`channelRunesExhausted`) bakes the exhaust in for the card that asks for it,
 * and a parameter would be a flag on a function whose whole name is the answer.
 * Same "as many as possible if fewer remain" behaviour as `runChannel` (315.4.b).
 */
function channelRunes(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  return updatePlayer(state, playerIndex, (p) => {
    if (count <= 0 || p.runeDeck.length === 0) return p;
    const taken = p.runeDeck.slice(0, count).map((r) => ({ ...r, state: "Ready" as const }));
    return { ...p, runeDeck: p.runeDeck.slice(taken.length), channeled: [...p.channeled, ...taken] };
  });
}

/** The two battlefields `runBattlefieldBeginningPhase` implements. They are not
 *  in `BATTLEFIELD_TRIGGERS`, because nothing about them is a Chain Pending
 *  Item — so the completeness gate has to be told about them separately, which
 *  is exactly what this is for. */
export function beginningPhaseBattlefieldDefIds(): string[] {
  return [OBELISK_OF_POWER, THE_ARENAS_GREATEST];
}

/** Every unit standing at a battlefield, on both sides, with whose it is. */
function unitsAt(state: GameState, battlefieldId: string | undefined) {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  return ([0, 1] as const).flatMap((ownerIndex) =>
    (bf.units[state.players[ownerIndex].id] ?? []).map((unit) => ({ unit, ownerIndex })),
  );
}

/** The Candlelit Sanctum's last step: the cards the player kept go back "in any
 *  order", which is a real question only when two of them survived. */
function orderKeptCards(state: GameState, playerIndex: 0 | 1, kept: number): GameState {
  if (kept < 2) return state;
  return parkDecision(state, { kind: `${THE_CANDLELIT_SANCTUM}-order`, playerIndex, count: kept });
}

/** Every unit a player has in play, base and battlefields alike. */
function ownUnitsOf(state: GameState, playerIndex: 0 | 1) {
  const owner = state.players[playerIndex];
  return [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
}

/**
 * Recycles one rune out of the pool to the bottom of its owner's RUNE deck,
 * Ready — Sigil of the Storm's "you must recycle one of your runes".
 *
 * The rune deck, not the Main Deck, so this fires no `cardsRecycled`: Karma -
 * Channeler reads "when you recycle one or more cards **to your Main Deck**",
 * and a rune never goes there. Same shape as `execute-float-rune`'s Power mode
 * and `order.ts`'s activation-cost recycle, minus the floating credit — those
 * two are the player spending a rune on something, and this is a battlefield
 * taking one.
 */
function recycleRuneToRuneDeck(state: GameState, playerIndex: 0 | 1, runeId: string): GameState {
  const owner = state.players[playerIndex];
  const rune = owner.channeled.find((r) => r.id === runeId);
  if (!rune) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    channeled: p.channeled.filter((r) => r.id !== runeId),
    runeDeck: [...p.runeDeck, { ...rune, state: "Ready" as const }],
  }));
}

/** The one-player update every resolver here needs. Local rather than shared,
 *  for the same reason `scoring.ts` and `turn-manager.ts` each keep their own. */
function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

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
  const trigger = BATTLEFIELD_TRIGGERS[bf.defId]?.find((t) => t.on === moment);
  if (!trigger) return state;
  const event: BattlefieldTriggerEvent = {
    moment,
    battlefieldId,
    playerIndex,
    ...(unitInstanceId !== undefined ? { unitInstanceId } : {}),
  };
  if (trigger.applies && !trigger.applies(state, event)) return state;
  // Captured against the board as it stands NOW — the moment of the event (383),
  // before anything else this same call fires has resolved.
  const captured = trigger.capture?.(state, event);
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
    ...(captured !== undefined ? { captured } : {}),
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
  const event = entry.event as BattlefieldTriggerEvent;
  // By MOMENT as well as by card, because a battlefield can print two abilities
  // (Targon's Peak). The entry says which one fired.
  const trigger = BATTLEFIELD_TRIGGERS[entry.listenerDefId]?.find((t) => t.on === event.moment);
  if (!trigger) return state;
  return trigger.resolve(state, event, entry.captured);
}

/** Every printed Battlefield card this module implements — the subject of the
 *  completeness gate in `battlefield-coverage.test.ts`, which is the only thing
 *  that can tell a battlefield with no ability from one whose ability was never
 *  written. */
export function battlefieldAbilityDefIds(): string[] {
  return Object.keys(BATTLEFIELD_TRIGGERS);
}
