import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence } from "framer-motion";
import { useRowFit } from "./use-row-fit.js";
import { useBoardCardSize, CARD_ASPECT_RATIO } from "./use-board-card-size.js";
import {
  beginFirstTurn,
  cardHasOptionalExhaustCost,
  cardModesOf,
  cardNeedsTarget,
  cardMovesTarget,
  targetingChoosesUnit,
  equipmentAttachedTo,
  effectiveMight,
  findUnitAnywhere,
  equipmentMightBonusFor,
  wearerOf,
  cardPlacesTokens,
  chooseAction,
  computeAutoPayment,
  computeEffectiveCost,
  actingPlayerIndex,
  dealOpeningHands,
  describeChain,
  executeMulligan,
  legalActions,
  matchesPowerDomain,
  pendingDecision,
  modifiedEnergyCost,
  submit,
    timingRejection,
  unitTriggerHasVisionChoice,
  victoryScore,
  type CardInstance,
  type ChainItemDescription,
  type DeckList,
  type FloatRuneAction,
  type GameState,
  type GearInstance,
  type PlayerState,
  type PlayCardAction,
  type PlayerAction,
  type RuneCard,
  type RunePayment,
  type SubmitResult,
  type UnitInstance,
} from "@rift-engine/engine";
import { createNewGame, rollAiBattlefield, winsNeeded, type MatchConfig } from "../game-setup.js";
import { CardView, type DragPoint } from "./CardView.js";
import { BattlefieldView } from "./BattlefieldView.js";
import { ChoiceOverlay } from "./ChoiceOverlay.js";
import { DecisionPrompt } from "./DecisionPrompt.js";
import { RematchPanel } from "./RematchPanel.js";
import { PlayerSideColumn } from "./PlayerSideColumn.js";
import { BoardPiles } from "./BoardPiles.js";
import { FlightLayer } from "./FlightLayer.js";
import { useZoneFlights } from "./use-zone-flights.js";
import { RuneZone } from "./RuneZone.js";
import { MulliganScreen } from "./MulliganScreen.js";
import { ChainView } from "./ChainView.js";
import { BattlefieldSelect } from "./BattlefieldSelect.js";
import { SeriesPanel } from "./SeriesPanel.js";
import { listTargetHint } from "../target-hint.js";
import { targetingForPlay } from "../targeting-for-play.js";
import { autoPayFill } from "../auto-payment.js";
import { submittedPlay } from "../submitted-play.js";
import { cardHasDestination } from "../card-destination.js";
import {
  matchesPendingChoices,
  matchesPendingCostFilter,
  modeFilterAllows,
  sameMode,
  sameOptionalCosts,
  OPTIONAL_COST_FLAGS,
  type OptionalCostKey,
} from "../pending-match.js";

const HUMAN_INDEX = 0;
const AI_INDEX = 1;
const AI_MOVE_DELAY_MS = 650;
const BASE_ZONE_ID = "base";
/** How long a just-resolved chain entry stays on screen after it's gone from
 *  `state.spellChain`. Purely a UI beat — it doesn't delay, gate, or reorder
 *  anything in the engine, it just keeps the cause visible while its effect
 *  lands on the board, so a spell no longer resolves as an unexplained board
 *  change. Roughly matches AI_MOVE_DELAY_MS so the two read as one rhythm. */
const CHAIN_RESOLVE_BEAT_MS = 800;

/** How far the outermost hand card tilts, and how high the middle of the fan
 *  rides above its ends. Both are small on purpose: the rotation widens each
 *  card's bounding box (by its HEIGHT times the sine of the angle, ~7px at a
 *  121px card), and the fan is already fitted to the exact width of the column
 *  by useRowFit, which has no spare room to give. */
const FAN_MAX_ANGLE_DEG = 3.2;
const FAN_ARC_LIFT_PX = 10;

/** The hand is drawn LARGER than the shared board card size. It can be: the fan
 *  is an overlay, so unlike every board row it feeds nothing back into the
 *  measurement that size comes from. Your own hand is also the thing you read
 *  most often and the only cards whose rules text you act on directly. */
const HAND_CARD_SCALE = 1.3;

/** How much of a card its neighbour covers while the hand still has room to
 *  spare. Deliberately overlapped rather than spaced out: hovering any card
 *  raises it clear and opens the full preview, so the fan only has to show
 *  enough of each card to pick it out — and a tighter fan leaves the bigger
 *  cards room to actually be bigger. */
const HAND_OVERLAP_FRACTION = 0.3;

/**
 * The hand fan's arc, per card.
 *
 * Inline rather than CSS because it is a function of both the index and the
 * CURRENT count — the same reason the overlap between cards is measured in
 * useRowFit rather than declared in the stylesheet. The slot pivots about its
 * bottom centre (see `.hand-fan-slot`), so the tilt splays the tops apart while
 * the held ends stay together, which is what makes it read as a hand rather than
 * as a row of slanted cards.
 */
function fanTransform(index: number, count: number): CSSProperties {
  if (count <= 1) return {};
  const centre = (count - 1) / 2;
  const offset = (index - centre) / centre; // -1 at the left edge, +1 at the right
  const angle = offset * FAN_MAX_ANGLE_DEG;
  const lift = (1 - offset * offset) * FAN_ARC_LIFT_PX;
  return { transform: `rotate(${angle.toFixed(2)}deg) translateY(${(-lift).toFixed(1)}px)` };
}

/** A hand/champion card armed for play but not yet fully resolved — covers
 *  two composable phases in order (every choice the card needs, THEN
 *  payment), matching the header hint text's own established mental model:
 *   1. One field per choice below starts undefined and gets filled in by
 *      clicking a legal unit / battlefield / base zone, or by picking from
 *      the ChoiceOverlay modal — in the fixed order `pendingStep()` defines.
 *      `destinationBattlefieldId` uses BASE_ZONE_ID as an explicit
 *      "resolved to base" sentinel, distinct from "not yet resolved"
 *      (plain `undefined`), so a Unit that can go to more than one place
 *      isn't silently treated as already-resolved-to-base before any click.
 *   2. Once every choice is made (or immediately, for a card needing none),
 *      manual rune payment begins: `payment` starts empty and fills via
 *      rune-tile clicks or Auto Pay until it exactly matches the effective
 *      (floating-reduced) cost already known from the matching `legal`
 *      candidate — at which point an effect auto-submits and clears this.
 *  Every field here mirrors one PlayCardAction field of the same name (see
 *  actions/player-action.ts), because the whole point of this object is to
 *  converge on exactly one of `legal`'s own already-fanned-out candidates —
 *  see matchesPending().
 *  Switching to a different hand card discards this whole object rather
 *  than swapping just `.card`, so a rune proposal built for one card can
 *  never leak into another's submission. */
interface PendingPlay {
  card: CardInstance;
  /**
   * Which mode of a modal card ("Choose one —") is being played.
   *
   * **The whole concept was missing from this workspace**: `modeId` appeared
   * zero times in all of `packages/web/src`, while every enumerated
   * `PlayCardAction` for a modal card carries one. The consequence was total —
   * `targetingForCard` answers `{kind:"none"}` for an unresolved mode (it
   * cannot guess which of two different specs applies), so `pendingStep()` saw
   * a card needing nothing, `matchesPending` compared a mode-less pending
   * against candidates that all name targets, and no candidate matched. Angle
   * Shot armed, showed no prompt, and could never be submitted. Reported from
   * playtesting as "no prompts or anything to choose a unit or gear".
   *
   * Rocket Barrage failed the same way with a worse symptom: its `killGear`
   * candidates carry no `targetUnitInstanceId`, so a mode-less pending matched
   * all four of THEM and none of the two `damage` ones — the board silently
   * played "kill a gear" at an arbitrary gear, sometimes the player's own, and
   * the damage mode was unreachable. A silent wrong play, not a stall.
   *
   * These are the only two modal cards in the pool today; this is the field that
   * stops the third from arriving broken.
   */
  modeId?: string;
  targetUnitInstanceId?: string;
  /** Gentlemen's Duel's second ("unitPair") target — always chosen after
   *  `targetUnitInstanceId`, never before. */
  secondTargetUnitInstanceId?: string;
  /** How much rainbow Power an X-cost card is paying — Bullet Time's "any
   *  amount". `0` is a real choice (cast it for nothing), so this is compared
   *  against `undefined` rather than falsily. */
  xAmount?: number;
  /** A `unitList` card's targets so far, in CLICK order and including repeats.
   *  Grows one entry per click rather than filling named slots, which is what
   *  lets one step serve two targets or six. */
  targetUnitInstanceIds?: readonly string[];
  targetBattlefieldId?: string;
  /** The GEAR a `unitAndEquipment` card named — Relentless Pursuit's "you may
   *  attach an Equipment with the same controller to it". Its own field rather
   *  than a second meaning for `targetUnitInstanceId`, because a gear must never
   *  reach a reader expecting a unit — the separation the engine's `unitOrGear`
   *  and `{kind:"gear"}` specs already keep. */
  targetPermanentInstanceId?: string;
  /** True once the Equipment step is finished, by picking one or declining —
   *  see `matchesPendingEquipment`, which cannot tell those apart without it. */
  equipmentChoiceResolved?: boolean;
  trashCardInstanceId?: string;
  visionRecycle?: boolean;
  additionalCostUnitInstanceId?: string;
  /** Meditation's additional cost is OPTIONAL, so an absent
   *  `additionalCostUnitInstanceId` is ambiguous between "declined it" and
   *  "hasn't chosen yet" — exactly the ambiguity BASE_ZONE_ID resolves for
   *  placement. This flag is the resolution: true once the player has either
   *  picked a unit or pressed Decline. `visionRecycle` needs no equivalent —
   *  it's a required boolean, so undefined there unambiguously means
   *  unresolved. */
  additionalCostResolved?: boolean;
  /** The player pressed Done on an "up to two" card (Singularity, Flash,
   *  Back to Back), settling for however many targets they'd picked. Same
   *  sentinel role as additionalCostResolved above: without it, "I'm happy
   *  with one target" can't be told apart from "I haven't picked a second
   *  one yet". Meaningless for a card whose targets are mandatory — those
   *  simply have no way to stop early. */
  optionalTargetsResolved?: boolean;
  destinationBattlefieldId?: string;
  /** Set when this armed card is being played from facedown (rule 811). Carried
   *  so `matchesPending` narrows to the from-hidden candidates rather than the
   *  from-hand ones — the same card can legitimately be both, at different
   *  costs and with different legal targets. */
  fromHiddenBattlefieldId?: string;
  /**
   * Whether this play pays [Accelerate]'s optional additional cost (805) to have
   * the unit enter READY.
   *
   * `legal` holds two candidates for such a card, identical but for this flag and
   * their payment. Without it here, `matchesPending` matched BOTH and `.find` took
   * whichever came first — the exact failure its own comment warns about, sizing
   * the payment against one action while submitting the other. An Accelerate card
   * would arm, ask for a cost belonging to the other variant, and then never
   * complete however many runes were clicked, which reads as the card being
   * unplayable. Kai'Sa - Survivor, Jinx - Demolitionist and Lee Sin - Centered are
   * all Accelerate CHAMPIONS, so it hit the champion zone hardest.
   *
   * Undefined until the card is armed, then always an explicit boolean, so the
   * comparison never has to guess a default.
   */
  acceleratePaid?: boolean;
  /**
   * The other four optional-cost variants a play can carry.
   *
   * **All four were missing, and the consequence was that a human could not pay
   * a `[Repeat]` at all.** `acceleratePaid` above was the only one the UI knew
   * about, so `matchesPending` treated a repeat-paid candidate and a plain one
   * as identical and `.find` took whichever came first — the plain, undiscounted
   * play, every time. Reported from playtesting as "Ezreal's discount does
   * nothing"; the engine was right and there was no way to reach it from the
   * board.
   *
   * They are separate fields rather than one enum because a card can carry more
   * than one at once — a printed `[Repeat]` under a Temporal Portal grant is
   * `repeatPaid` AND `grantedRepeatPaid`, and rule 820.1.c.2 makes those two separate
   * instances that are paid separately.
   *
   * `targetDiscountAxis` is not a boolean: Ezreal - Prodigy and Irelia - Graceful
   * share one axis field, and a play that claims an axis buying nothing is
   * REFUSED by the validator — so it has to match exactly like the rest, or the
   * board offers an action `submit` will reject.
   */
  optionalPowerPaid?: boolean;
  repeatPaid?: boolean;
  grantedRepeatPaid?: boolean;
  targetDiscountAxis?: "energy" | "power";
  payment: RunePayment;
}


/** The one choice `pendingPlay` is currently waiting on, in the fixed order
 *  `pendingStep()` walks. Every board-click step comes before every modal
 *  (ChoiceOverlay) step, so a modal can never cover a zone the player still
 *  has to click — no card in the current pool combines the two, and this
 *  ordering keeps that safe if one ever does.
 *
 *  **`"mode"` is the one exception, and it comes FIRST.** It is a ChoiceOverlay
 *  step, so by the rule above it would sort last — but the mode is what
 *  DETERMINES which board clicks are legal. Angle Shot's two modes want
 *  different units and different gear; asking for a target before the mode is
 *  asking a question that has no answer yet. The ordering rule exists so a modal
 *  never covers a zone the player must click; a mode step covers a board the
 *  player cannot yet be asked to click, which is the same principle, not an
 *  exception to it. */
type PendingStep =
  /** Which half of a "Choose one —" card is being played (Angle Shot, Rocket
   *  Barrage). Asked before everything, for the reason above. */
  | "mode"
  | "firstTarget"
  | "secondTarget"
  /** A `unitList` card accumulating its N ordered targets (Falling Star,
   *  Icathian Rain, Fox-Fire) — one step that repeats rather than one step per
   *  slot, because the slots are interchangeable and there can be six of them. */
  | "listTarget"
  /** An X-cost card choosing how much to pay (Bullet Time). Its variants differ
   *  ONLY by `xAmount`, so without a step of its own the board could not tell
   *  them apart and silently took the first — X = 0. */
  | "xAmount"
  | "battlefieldTarget"
  | "placement"
  /** A `unitAndEquipment` card choosing the GEAR half (Relentless Pursuit). Its
   *  own step because the click lands in a different field from every unit step,
   *  and because declining has to be distinguishable from not having chosen —
   *  see `matchesPendingEquipment`. */
  | "equipment"
  | "additionalCost"
  | "trashCard"
  | "vision";

/** Finds the drop zone (a battlefield id, or BASE_ZONE_ID) under a viewport
 *  point, via the `data-dropzone-id` attributes BattlefieldView/the base
 *  zone carry — simpler and more robust than manual rect math, since it
 *  goes through the browser's own hit-testing (z-index, overlap, etc.). */
function dropZoneAt(point: DragPoint): string | null {
  const el = document.elementFromPoint(point.x, point.y);
  return el?.closest("[data-dropzone-id]")?.getAttribute("data-dropzone-id") ?? null;
}

/** Where the pregame currently is. `selectBattlefield` only ever occurs in a
 *  Best of 3 (rule 486.5's per-game selection); a Best of 1 rolls instead
 *  (485.5) and so starts at `mulligan`, exactly as before this existed. */
type PregameStep = "selectBattlefield" | "mulligan" | "playing";

/** Match-level state, above any single game. All of it is Best-of-3 only; a
 *  Best of 1 leaves it untouched. */
interface SeriesState {
  humanGameWins: number;
  aiGameWins: number;
  /** 1-based, for "Game 2 of 3". */
  gameNumber: number;
  /** Battlefields each side has already presented in a DECIDED game — removed
   *  from selection for the rest of the match (rule 486.5). Tracked per side
   *  because each player's pool is their own. */
  humanUsedBattlefields: string[];
  aiUsedBattlefields: string[];
}

function freshSeries(): SeriesState {
  return { humanGameWins: 0, aiGameWins: 0, gameNumber: 1, humanUsedBattlefields: [], aiUsedBattlefields: [] };
}

interface GameBoardProps {
  initialConfig: MatchConfig;
  onMainMenu: () => void;
}

export function GameBoard({ initialConfig, onMainMenu }: GameBoardProps) {
  const [config, setConfig] = useState(initialConfig);
  // SPECTATE — the AI drives BOTH seats and nothing on the board is clickable.
  // Read off the config rather than held as its own state: it is a property of
  // the match, and a rematch that reused the config while dropping this would
  // silently hand a half-played game back to a human who is not there.
  const spectate = config.spectate === true;
  // Match-level state, above any single game. A Best of 1 leaves it at zeroes
  // and never reads it; a Best of 3 needs all of it — the score to know when
  // the MATCH is over (rule 486.6's two game wins) and the used-battlefield
  // lists to honour 486.5's elimination on the next game's selection.
  const [series, setSeries] = useState<SeriesState>(() => freshSeries());
  // Which pregame step is showing, or "playing" once the board is live. Best
  // of 3 adds a battlefield selection ahead of the mulligan — rule 486.5 puts
  // that selection in Setup, so it runs before EVERY game, not only between
  // them.
  // Spectate skips the battlefield step even in a Best of 3: 486.5's selection is
  // a PLAYER's choice, and with nobody at the seat the honest stand-in is the
  // roll `createNewGame` already makes for both sides — the same thing 1v1 Duel
  // does. Recorded as a deliberate narrowing rather than an oversight: a
  // spectated Bo3 is not a rules-faithful Bo3 on that one point.
  const [pregame, setPregame] = useState<PregameStep>(
    initialConfig.format === "bo3" && initialConfig.spectate !== true ? "selectBattlefield" : "mulligan",
  );
  // The seed for the CURRENT game, held rather than re-derived so a Best of 3's
  // battlefield choice can rebuild this game's state (with the chosen
  // battlefields) off the same shuffle the roll used.
  const [gameSeed, setGameSeed] = useState(() => Date.now());
  // Hands are dealt but the human hasn't confirmed a mulligan yet. Deliberately
  // kept NON-NULL for the whole pregame, including the battlefield step: every
  // derivation below this line reads `state`, so a null here would have to
  // ripple through all of them. During the battlefield step this holds a
  // throwaway state built with rolled battlefields that no screen renders —
  // selecting replaces it with the real one. Mirrors the real rule's own
  // pregame sequence (deal hands -> mulligan -> begin first turn), see
  // execute-mulligan.ts.
  const [pregameState, setPregameState] = useState<GameState | null>(() =>
    dealOpeningHands(createNewGame(initialConfig, Date.now())),
  );
  const [game, setGame] = useState<{ state: GameState; result: SubmitResult } | null>(null);
  const { state, result } = game ?? { state: pregameState!, result: { type: "Ok" } };
  // Every unit id currently selected for a group Move/Recall — plain click
  // toggles membership (click again to deselect; click a DIFFERENT unit adds
  // to the selection instead of replacing it), so several units can be moved
  // or recalled together in one action, matching the real rule that a single
  // MoveUnit/RecallUnit action already carries a list of units.
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  // The hand/champion card "armed" for play — set instead of playing
  // immediately whenever the card needs a target, a placement choice, or a
  // nonzero (post-floating) rune payment. A card needing none of those still
  // plays instantly on click, unchanged from before any of this existed.
  const [pendingPlay, setPendingPlay] = useState<PendingPlay | null>(null);
  // A Gear or Unit whose exhaust-cost ability has been clicked and which is now
  // waiting for a target. Deliberately NOT folded into `pendingPlay`: that state
  // machine narrows PlayCard candidates through up to seven ordered steps
  // (targets, placement, additional cost, trash, vision, payment), and an
  // activated ability has exactly one possible question — "which unit?" — with no
  // cost to pay beyond the exhaust. An ability needing no target never sets this
  // at all; it fires on the click.
  const [pendingAbility, setPendingAbility] = useState<string | null>(null);
  const [dragOverZoneId, setDragOverZoneId] = useState<string | null>(null);
  // Why the last-clicked unplayable card can't be played, shown in the header
  // until the next action. Before this, an unplayable card had NO onClick at
  // all and `.selectable` styling was a bare `cursor: pointer` — so "I can't
  // cast this and nothing tells me why" was the single most confusing thing
  // about the board (reported from live play for power-cost cards, whose
  // blocker is usually a missing domain rune rather than anything visible).
  const [unplayableNotice, setUnplayableNotice] = useState<string | null>(null);
  // A trash pile being browsed (either player's — it's public information).
  // Purely a viewer: it never feeds a pending play, which is why it's its own
  // state rather than another PendingStep.
  const [viewingTrash, setViewingTrash] = useState<{ label: string; cards: CardInstance[] } | null>(null);
  // Tracks the last drop zone seen during the drag (from onDrag, updated on
  // every pointer move) — read at drop time instead of recomputing there.
  // onDragEnd fires as Framer Motion is already reverting the dragged
  // element's whileDrag styles (including the pointerEvents:none that makes
  // hit-testing find what's UNDER the card rather than the card itself), so
  // recomputing document.elementFromPoint at that exact moment is a race;
  // the continuously-updated ref isn't.
  const lastDragZoneRef = useRef<string | null>(null);
  // A just-resolved chain entry, held on screen for CHAIN_RESOLVE_BEAT_MS —
  // see the resolution-beat effect below.
  const [resolvingChainItem, setResolvingChainItem] = useState<ChainItemDescription | null>(null);
  const beatTimerRef = useRef<number | null>(null);
  // Has the current game's result already been added to the series score? See
  // the banking effect below.
  const bankedGameRef = useRef(false);
  // Which chain item the pointer is over, so the board's co-highlight can
  // narrow from "everything the chain points at" to "what THIS item points
  // at". Only meaningful with a chain deeper than one item, which is
  // unreachable until reaction-speed casting lands — harmless and correct
  // until then, since a 1-deep chain highlights the same set either way.
  const [hoveredChainIndex, setHoveredChainIndex] = useState<number | null>(null);

  // Who may act right now — the engine owns this precedence (chain closed ->
  // chainPriority, Showdown -> focusHolder, else -> activePlayerIndex). It used
  // to be written out here as well as in the AI and implicitly in legal-actions;
  // now that a card can legally be played in all three states, one definition is
  // the only way those can't drift.
  const actingIndex = actingPlayerIndex(state);
  const isHumanTurn = actingIndex === HUMAN_INDEX;
  // Is the person LOOKING at the board allowed to act? Distinct from
  // `isHumanTurn`, which is a fact about the game — under spectate it is still
  // true for half the turns, and the board would happily offer a passer-by a
  // Pass button and a selectable hand while a bot is mid-decision.
  //
  // Every interaction below is gated on THIS; only the header prose ("your
  // priority" / "the AI's Focus") still reads `isHumanTurn`, because that
  // describes the game rather than what you may click.
  const canAct = isHumanTurn && !spectate;
  const isGameOver = result.type === "GameOver";
  const isShowdownOpen = state.turnState === "Showdown";
  const showdownBattlefield = isShowdownOpen
    ? state.battlefields.find((bf) => bf.id === state.showdownBattlefieldId)
    : undefined;
  // A spell is pending resolution — the same PassFocus action/button used
  // for Showdown-Focus-passing also passes chain priority here (they're the
  // same underlying mechanism, distinguished only by which state is closed).
  const isChainPending = !state.chainOpen;
  const showPassFocus = isShowdownOpen || isChainPending;

  // The chain, newest first — i.e. in resolution order (rule 340.1). Rendered by
  // ChainView; before this existed, `state.spellChain` reached the UI nowhere
  // at all.
  const chainItems = useMemo(() => describeChain(state), [state]);

  // Empty under spectate, which is what makes the board unclickable: every
  // affordance on it — an armable hand card, a selectable unit, the Pass button
  // — is derived from this list, so one guard here disables all of them rather
  // than each needing to learn about the mode.
  const legal = useMemo(
    () => (canAct && !isGameOver ? legalActions(state) : []),
    [state, canAct, isGameOver],
  );

  // A question the engine has stopped to ask, and it is yours to answer. It
  // outranks everything else on screen: while one is open, `legalActions` offers
  // nothing but its answers, so every other affordance on the board is already
  // dead and the panel is the only thing that can move the game on.
  //
  // `isHumanTurn` covers the ownership check on its own, because actingPlayerIndex
  // now yields whoever was ASKED — which for Cull the Weak is the player whose
  // turn it isn't.
  const awaitingHuman = isHumanTurn && !isGameOver ? pendingDecision(state) : undefined;

  /**
   * Submits an action and clears whatever was being built for it.
   *
   * **A refusal is SHOWN now.** `submit` can return `Invalid`, and this used to
   * store it, disarm the card and clear the notice — so an action the engine
   * rejected looked exactly like one that had never been sent. That is how a
   * missing `[Deflect]` surcharge bucket presented in play: the card un-armed,
   * the runes came back, and nothing said why.
   *
   * The engine's own message is used verbatim rather than reworded. It is
   * written for a player ("Cleave must pay 1 rainbow Power for [Deflect] on its
   * target, but named 0"), and paraphrasing it here would be a second copy of a
   * rule free to drift from the one that actually refused.
   *
   * This is a backstop, not the affordance. Everything the board offers should
   * already be legal — `legal-actions` is shared with the validator precisely so
   * — and a message appearing here means those two disagreed, which is a bug
   * worth seeing rather than hiding.
   */
  function applyAction(action: PlayerAction) {
    const next = submit(state, action);
    setGame(next);
    setSelectedUnitIds(new Set());
    setPendingPlay(null);
    setPendingAbility(null);
    setDragOverZoneId(null);
    setUnplayableNotice(next.result.type === "Invalid" ? next.result.error : null);
  }

  // The AI's turn plays itself, one action at a time, with a short delay for feel
  // — and under SPECTATE it plays the other seat's turns too.
  //
  // `chooseAction` derives the acting seat itself (and masks that seat's hidden
  // information for its own lookahead), so driving both seats is the absence of
  // the `isHumanTurn` guard rather than any new code. That is the whole feature:
  // everything else here is about not offering a human affordances.
  useEffect(() => {
    if (isGameOver) return;
    if (canAct) return;
    const timer = setTimeout(() => {
      const action = chooseAction(state);
      setGame(submit(state, action));
    }, AI_MOVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, canAct, isGameOver]);

  // SPECTATE's pregame: nobody is at the seat to keep or mulligan a hand, so it
  // keeps it — which is exactly what the AI already does at the other seat
  // (execute-mulligan.ts: the AI never mulligans), so both seats are treated
  // alike rather than one getting a free look the other never had.
  //
  // An effect rather than a branch in the initial state, because it has to run
  // AFTER the hands are dealt and it has to survive `resetForNewGame` starting
  // the next game's pregame the same way.
  useEffect(() => {
    if (!spectate || pregame !== "mulligan" || !pregameState) return;
    setGame(beginFirstTurn(pregameState));
    setPregame("playing");
  }, [spectate, pregame, pregameState]);

  // The resolution beat. A chain entry vanishes from `state.spellChain` in the
  // same tick its effect is applied, so without this a spell resolved as an
  // unexplained board change — the thing that was about to happen simply
  // stopped being on screen at the exact moment it happened. This keeps the
  // entry visible (as its pre-resolution description, so a target that just
  // died is still named) for a beat afterwards.
  //
  // Both refs are read-then-overwritten every run: the previous top is what
  // just resolved, and the length comparison is what says a resolution
  // happened at all. The timer lives in a ref rather than an effect cleanup on
  // purpose — this effect re-runs on EVERY state change, so a cleanup-based
  // timeout would be cancelled by any unrelated action mid-beat and strand the
  // ghost on screen permanently.
  const prevChainLengthRef = useRef(state.spellChain.length);
  const prevChainTopRef = useRef<ChainItemDescription | null>(chainItems[0] ?? null);
  useEffect(() => {
    const previousLength = prevChainLengthRef.current;
    const previousTop = prevChainTopRef.current;
    prevChainLengthRef.current = state.spellChain.length;
    prevChainTopRef.current = chainItems[0] ?? null;

    if (state.spellChain.length > previousLength) {
      // Something new was just cast — a stale ghost underneath it would read as
      // a second, phantom chain entry.
      clearResolutionBeat();
      setResolvingChainItem(null);
      return;
    }
    if (state.spellChain.length === previousLength || !previousTop) return;

    setResolvingChainItem(previousTop);
    clearResolutionBeat();
    beatTimerRef.current = window.setTimeout(() => {
      beatTimerRef.current = null;
      setResolvingChainItem(null);
    }, CHAIN_RESOLVE_BEAT_MS);
  }, [state.spellChain, chainItems]);

  useEffect(() => clearResolutionBeat, []);

  // Bank a finished game into the series exactly once. A ref rather than
  // deriving it from `result`, because `result` stays GameOver for every render
  // until the next game starts — without the guard the score would climb on
  // each one. Reset in resetForNewGame, which is the only way out of this state.
  useEffect(() => {
    if (result.type !== "GameOver" || bankedGameRef.current) return;
    bankedGameRef.current = true;
    const humanWon = result.winnerId === state.players[HUMAN_INDEX].id;
    setSeries((prev) => ({
      ...prev,
      humanGameWins: prev.humanGameWins + (humanWon ? 1 : 0),
      aiGameWins: prev.aiGameWins + (humanWon ? 0 : 1),
    }));
  }, [result, state]);

  function clearResolutionBeat() {
    if (beatTimerRef.current !== null) {
      clearTimeout(beatTimerRef.current);
      beatTimerRef.current = null;
    }
  }

  const human = state.players[HUMAN_INDEX];
  const ai = state.players[AI_INDEX];

  // One per card row. Each fans its cards to fit the width it actually has, so no
  // row wraps onto a second line and grows a scrollbar — the same measured fit
  // RuneZone has always used, now shared (see use-row-fit.ts).
  // One card size for the entire board, measured from the tightest row.
  const boardCardSize = useBoardCardSize();

  // The third argument is how many of the row's cards are TAPPED — rotated, so they
  // lie on their side and need their height's worth of room. Reserving it is what
  // lets an exhausted card stay the same size as a ready one. A hand card is never
  // exhausted, hence none there.
  const exhaustedIn = (p: typeof human) =>
    p.baseUnits.filter((u) => u.exhausted).length + p.activeGear.filter((g) => g.exhausted).length;
  const aiBaseFit = useRowFit(ai.activeGear.length + ai.baseUnits.length, undefined, exhaustedIn(ai));
  const yourBaseFit = useRowFit(human.activeGear.length + human.baseUnits.length, undefined, exhaustedIn(human));
  // A NEGATIVE gap, so the hand fans overlapped even when the row could space it
  // out. Derived from the measured card rather than being its own constant, so it
  // tracks the board at every viewport size. `useRowFit` still tightens beyond
  // this whenever the cards genuinely do not fit.
  const handCardWidth =
    boardCardSize.cardHeight === null ? null : boardCardSize.cardHeight * CARD_ASPECT_RATIO * HAND_CARD_SCALE;
  const handFit = useRowFit(
    human.hand.length,
    handCardWidth === null ? undefined : -Math.round(handCardWidth * HAND_OVERLAP_FRACTION),
  );
  // The opponent's backs fan tighter than real cards: they carry no information
  // beyond their own count, so there is nothing to keep readable.
  const aiHandFit = useRowFit(ai.hand.length, 4);

  // Cards that actually travel between your zones, recovered by diffing counts
  // between renders — the engine reports state, not events. Only YOUR zones: the
  // AI's piles are in its rail and a flight across the board to a rail would say
  // something about where the opponent's cards went that the board does not
  // otherwise show.
  const flights = useZoneFlights({
    deck: human.deck.length,
    hand: human.hand.length,
    trash: human.trash.length,
    banished: human.banished.length,
    runeDeck: human.runeDeck.length,
    channeled: human.channeled.length,
  });

  function playCardActionsFor(cardInstanceId: string): PlayCardAction[] {
    return legal.filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === cardInstanceId);
  }

  /** Is this hand/champion card interactable at all right now — drives
   *  isSelectable/highlighting. True whenever any legal PlayCard action
   *  exists, whether the card is targeted (arms on click) or not (plays
   *  immediately on click) — unlike `immediatePlayAction`, this doesn't
   *  care which. */
  function isCardInteractable(cardInstanceId: string): boolean {
    // Hideable counts. A [Hidden] card you cannot AFFORD is exactly the card
    // worth hiding — that is what the keyword is for (1 rainbow Power now, free
    // later) — and gating interactability on PlayCard candidates alone made
    // every such card unclickable, so the Hide button could never appear for it.
    return playCardActionsFor(cardInstanceId).length > 0 || hideActionsFor(cardInstanceId).length > 0;
  }

  /** Every legal Hide for one hand card. */
  function hideActionsFor(cardInstanceId: string) {
    return legal.filter(
      (a): a is Extract<PlayerAction, { type: "HideCard" }> => a.type === "HideCard" && a.card.instanceId === cardInstanceId,
    );
  }

  /** Does this card get to choose WHERE it lands — a Unit picking between
   *  base and a "reinforce" battlefield, or a token-placing Spell picking
   *  where its Recruits deploy (Recruit the Vanguard)? Everything else has
   *  no destination at all, and must not be offered one: an ordinary Spell's
   *  candidates all carry an absent destination, which normalizes to base
   *  and would otherwise read as a real choice. */

  /** True for a card with more than one distinct legal destination — keyed
   *  off distinct destinations, not a raw action count, so a future
   *  same-destination cost variant (e.g. Accelerate) can never falsely
   *  trigger arming for a card that only has one real place to go. */
  function unitNeedsPlacement(actions: PlayCardAction[]): boolean {
    const card = actions[0]?.card;
    if (!card || !cardHasDestination(card)) return false;
    const destinations = new Set(actions.map((a) => a.destinationBattlefieldId ?? BASE_ZONE_ID));
    return destinations.size > 1;
  }

  /** A payment with at least one rune slot to fill — the trigger for arming
   *  the manual-payment UI instead of auto-paying and submitting instantly.
   *  `legal`'s own candidate already carries the floating-reduced (effective)
   *  size here (legal-actions.ts computes it before auto-paying), so a card
   *  fully covered by floating Energy/Power correctly still plays instantly,
   *  same as a printed-zero-cost card always has. */
  function actionNeedsPayment(action: PlayCardAction): boolean {
    return action.payment.energyRunes.length + action.payment.powerRunes.length > 0;
  }

  /** Does this card need ANY choice from the player before it can resolve —
   *  a target (unit/battlefield/trash card/unit pair, via the engine's own
   *  cardNeedsTarget), a [Vision] recycle decision, or Meditation's optional
   *  exhaust cost? The two non-targeting axes are deliberately separate
   *  registries in the engine (they're orthogonal to TargetingSpec — see
   *  unit-triggers.ts's `unitTriggerHasVisionChoice` and card-effects.ts's
   *  OPTIONAL_EXHAUST_COST_DEF_IDS), and the `card.kind` guards here mirror
   *  exactly how legal-actions.ts gates its own fan-out for them.
   *
   *  The Vision question takes the BOARD as well as the card: `[Vision]` is a
   *  keyword rather than two cards' text, and Gemcraft Seer grants it to other
   *  friendly units — so whether a play needs a recycle step depends on what is
   *  already in play. Asking the engine's own function rather than re-deriving
   *  is what keeps the board's step list and the validator agreeing. */
  function cardNeedsChoice(card: CardInstance): boolean {
    return (
      // The MODE is a choice before any of the others, and `cardNeedsTarget`
      // cannot see it: it asks the mode-less targeting spec, which for a modal
      // card is `{kind:"none"}`. So a modal card claimed to need nothing, and
      // only its nonzero rune cost stopped `immediatePlayAction` from firing
      // mode #1 on click. Angle Shot and Rocket Barrage both cost runes today;
      // a free modal card would have played itself, at a mode nobody picked.
      cardModesOf(card).length > 1 ||
      cardNeedsTarget(card) ||
      (card.kind === "Unit" && unitTriggerHasVisionChoice(state, HUMAN_INDEX, card.defId)) ||
      (card.kind === "Spell" && cardHasOptionalExhaustCost(card.defId))
    );
  }

  /** The one action to submit immediately on click/drag — only when the
   *  card doesn't need any choice: not a targeted Spell (e.g. Incinerate),
   *  no [Vision]/additional-cost decision, not a Unit with more than one
   *  legal destination, and not a nonzero rune payment. Any of those
   *  returns undefined here even though the card IS interactable, since
   *  clicking it should arm it instead (see handleHandCardClick). */
  function immediatePlayAction(cardInstanceId: string): PlayCardAction | undefined {
    const actions = playCardActionsFor(cardInstanceId);
    const [first] = actions;
    if (!first) return undefined;
    if (cardNeedsChoice(first.card)) return undefined;
    if (unitNeedsPlacement(actions)) return undefined;
    if (actionNeedsPayment(first)) return undefined;
    return first;
  }

  /** Why is this hand/champion card not playable right now? Re-derives the
   *  engine's own gates in the engine's own order (timing, then cost, then
   *  targets) using the same exported helpers `legal-actions.ts` uses, so the
   *  explanation can't claim something different from the rule that actually
   *  rejected it. Only ever called for a card `legal` has no candidate for,
   *  so it always has a real answer to give.
   *
   *  The cost branch distinguishes a missing DOMAIN from a plain shortage,
   *  because they're the two genuinely different problems and the fix differs:
   *  a domain miss can't be solved by waiting a turn if the rune deck has
   *  already dealt you the wrong colours, whereas a shortage just needs more
   *  channeled runes. */
  function unplayableReason(card: CardInstance): string {
    if (state.phase !== "Action") return `Cards can only be played during the Action phase — it's currently ${state.phase}.`;
    if (card.kind === "Legend") return "Legend cards can't be played.";
    // Timing first, and from the engine, so the board's explanation is the same
    // rule the validator applies. This replaced three flat claims, two of which
    // are now false — a Showdown and a pending spell are both castable windows
    // for a card with the right printed keyword.
    const timing = timingRejection(state, HUMAN_INDEX, card);
    if (timing !== null) return timing;

    const effective = computeEffectiveCost(
      human.floatingEnergy,
      human.floatingPower,
      modifiedEnergyCost(state, HUMAN_INDEX, card.kind, card.energyCost, card.defId),
      card.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
      card.kind === "Spell" ? human.restrictedSpellEnergy : 0,
    );
    const payment = computeAutoPayment(
      human.channeled,
      effective.energyCost,
      effective.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
    );
    if (!payment) {
      const matching = human.channeled.filter((r) => matchesPowerDomain(r, card.powerDomain, card.powerDomainAlt));
      if (effective.powerCost > matching.length) {
        const domain = card.powerDomainAlt !== undefined ? `${card.powerDomain} or ${card.powerDomainAlt}` : `${card.powerDomain}`;
        return `${card.name} needs ${effective.powerCost} ${domain} Power, but you have ${matching.length} ${domain} rune${matching.length === 1 ? "" : "s"} channeled.`;
      }
      const ready = human.channeled.filter((r) => r.state === "Ready").length;
      const pool =
        ready === human.channeled.length
          ? `you only have ${ready} channeled rune${ready === 1 ? "" : "s"}`
          : `only ${ready} of your ${human.channeled.length} channeled runes ${ready === 1 ? "is" : "are"} ready`;
      return `${card.name} costs ${effective.energyCost} Energy, but ${pool}.`;
    }

    // Affordable, so the blocker is the effect's own targeting — the card
    // simply has nothing legal to point at yet.
    //
    // No mode is passed, deliberately: this is only reached when the card has NO
    // legal candidates at all, so there is no mode the player could have picked
    // that would work, and naming one of them would explain the wrong half. A
    // modal card lands in `default:` with the generic "can't be played right
    // now", which for "neither mode has a target" is the honest answer.
    const targeting = targetingForPlay(card, undefined);
    switch (targeting.kind) {
      case "unit": {
        const who = targeting.owner === "friendly" ? "friendly " : targeting.owner === "enemy" ? "enemy " : "";
        const might = targeting.maxMight !== undefined ? `with ${targeting.maxMight} Might or less ` : "";
        return `${card.name} needs a ${who}unit ${might}at a battlefield to target — there isn't one.`;
      }
      case "unitSlots": {
        // Only reachable for a mandatory-target card: a `min: 0` spec is
        // always satisfiable (the empty choice is legal), so it never lands
        // here — see hasAnyLegalEffectChoice.
        const roles = targeting.slots.map((r) => (r === "any" ? "any" : r)).join(" + ");
        return `${card.name} needs ${targeting.min} units to target (${roles}) — the board doesn't have them.`;
      }
      case "battlefield":
        return `${card.name} needs a battlefield to target.`;
      case "ownTrashCard":
        return `${card.name} needs a ${targeting.cardKind ?? "card"} in your trash — you have none there.`;
      case "chainSpellAndUnit": {
        // Two ways to be blocked and they look nothing alike from the player's
        // side, so they are named separately — "can't be played right now" on a
        // Reaction with a full chain reads as a bug.
        const who = targeting.owner === "friendly" ? "friendly " : targeting.owner === "enemy" ? "enemy " : "";
        return `${card.name} needs both a spell on the chain to counter and a ${who}unit to buff.`;
      }
      default:
        return `${card.name} can't be played right now.`;
    }
  }

  /** Do this card's two target slots take the same role (Singularity's
   *  "any + any", Back to Back's "friendly + friendly")? If so the fan-out
   *  deduped (A,B) and (B,A) into a single candidate, so the SET of chosen
   *  units identifies a candidate — not which slot each one landed in.
   *  Without this the player has to guess the enumeration order: clicking the
   *  two units "backwards" matched no candidate, so the UI silently refused
   *  to offer a second target at all. */
  function pendingSlotsAreSymmetric(card: CardInstance, modeId: string | undefined): boolean {
    const targeting = targetingForPlay(card, modeId);
    return targeting.kind === "unitSlots" && targeting.slots[0] === targeting.slots[1];
  }

  /** Do two `unitList` choices name the same units in the same ORDER? Order
   *  matters and repeats matter: the rules make the choices ordered, and two
   *  copies of a unit is a different play from one. */
  function sameTargetList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((id, i) => id === right[i]);
  }

  /** The units named by an action/pending-play, slot order discarded. */
  function targetSetOf(source: { targetUnitInstanceId?: string; secondTargetUnitInstanceId?: string }): string[] {
    return [source.targetUnitInstanceId, source.secondTargetUnitInstanceId].filter((id): id is string => id !== undefined);
  }

  /** Every `legal` candidate still consistent with the choices made on
   *  `pendingPlay` so far — a choice not yet made is a wildcard, so this
   *  narrows with each click. THE single source for "what can I click right
   *  now": every highlight predicate and every click handler below reads it,
   *  so the two can't drift (the same reason legal-actions.ts is shared
   *  between the AI and this UI in the first place). */
  function pendingCandidates(): PlayCardAction[] {
    const pending = pendingPlay;
    if (!pending) return [];
    const symmetric = pendingSlotsAreSymmetric(pending.card, pending.modeId);
    return playCardActionsFor(pending.card.instanceId).filter((a) => {
      // MODE first, and before origin: on a modal card every other field means
      // something different per mode, so narrowing on a target before narrowing
      // on the mode compares fields that are not comparable.
      if (!modeFilterAllows(a, pending)) return false;
      // Origin first. A card can be enumerated both from hand and from facedown
      // at once — different cost, different legal targets (rule 811) — and
      // mixing the two pools would let a target legal from hand be offered for a
      // from-hidden play that must stay at its battlefield.
      if ((a.fromHiddenBattlefieldId ?? null) !== (pending.fromHiddenBattlefieldId ?? null)) return false;
      if (symmetric) {
        // Subset, not equality: with one unit chosen, both the single-target
        // candidate and every pair containing it stay live — which is exactly
        // what lets a second target still be offered.
        const candidateTargets = targetSetOf(a);
        if (!targetSetOf(pending).every((id) => candidateTargets.includes(id))) return false;
      } else {
        if (pending.targetUnitInstanceId !== undefined && a.targetUnitInstanceId !== pending.targetUnitInstanceId) return false;
        if (pending.secondTargetUnitInstanceId !== undefined && a.secondTargetUnitInstanceId !== pending.secondTargetUnitInstanceId) {
          return false;
        }
      }
      // PREFIX, not equality: a half-made list must keep every candidate that
      // starts with it live, which is what leaves the next click something to
      // highlight. The same subset reasoning the symmetric-slots branch above
      // uses, applied to an ordered list.
      // The X variants are otherwise identical, so this is the only thing that
      // separates them — see pending-match.ts on why it was missing.
      if (!matchesPendingChoices(a, pending)) return false;
      const chosenList = pending.targetUnitInstanceIds;
      if (chosenList !== undefined) {
        const candidateList = a.targetUnitInstanceIds ?? [];
        if (candidateList.length < chosenList.length) return false;
        if (chosenList.some((id, i) => candidateList[i] !== id)) return false;
      }
      if (pending.targetBattlefieldId !== undefined && a.targetBattlefieldId !== pending.targetBattlefieldId) return false;
      if (pending.trashCardInstanceId !== undefined && a.trashCardInstanceId !== pending.trashCardInstanceId) return false;
      if (pending.visionRecycle !== undefined && a.visionRecycle !== pending.visionRecycle) return false;
      // Resolved-ness of the optional cost is the FLAG, not the id — see
      // PendingPlay.additionalCostResolved's own doc comment.
      if (pending.additionalCostResolved && (a.additionalCostUnitInstanceId ?? null) !== (pending.additionalCostUnitInstanceId ?? null)) {
        return false;
      }
      if (
        pending.destinationBattlefieldId !== undefined &&
        (a.destinationBattlefieldId ?? BASE_ZONE_ID) !== pending.destinationBattlefieldId
      ) {
        return false;
      }
      // An optional cost is a VARIANT, so it narrows the pool the same way a
      // chosen target does. Set the moment the card is armed, so the payment
      // being built and the action eventually submitted are always the same
      // variant. Only flags the armed play has actually SETTLED are compared —
      // an unset flag must not exclude candidates before the player has chosen.
      if (!matchesPendingCostFilter(a, pending)) return false;
      return true;
    });
  }

  /** The next choice `pendingPlay` is waiting on, or null once it's fully
   *  resolved and only a rune payment (if any) is left. Board-click steps
   *  come first, modal steps last — see PendingStep's own doc comment.
   *
   *  A step is only ever asked when the candidate set actually OFFERS that
   *  choice (`offers` below) — a question the player can only answer one way,
   *  or can't answer at all, is a dead end rather than a decision. Two real
   *  cases: Meditation with no ready friendly unit (legal-actions.ts fans out
   *  only the "decline" variant), and a Unit whose on-play trigger has
   *  nothing to point at — Annie-Stubborn on an empty trash, First Mate as
   *  your first unit — which the engine now plays with the trigger simply not
   *  firing (see validate-play-card.ts's targetOmissionAllowed). Without this,
   *  the UI would open an empty trash chooser over a card the engine was
   *  perfectly happy to play. */
  function pendingStep(): PendingStep | null {
    const pending = pendingPlay;
    if (!pending) return null;
    // BEFORE the targeting spec is even read, because on a modal card there is
    // no spec to read until the mode is known — `targetingForCard` answers
    // `{kind:"none"}` rather than guessing at one of them, and every branch
    // below would then decline to ask anything at all.
    if (pending.modeId === undefined && cardModesOf(pending.card).length > 1) return "mode";
    const targeting = targetingForPlay(pending.card, pending.modeId);
    // Narrowed by the choices already made, so e.g. a pair's second slot is
    // judged against the first target's own candidates.
    const candidates = pendingCandidates();
    const offers = (field: keyof PlayCardAction) => candidates.some((a) => a[field] !== undefined);

    // A `unitSlots` card whose targets are OPTIONAL (min 0 — "up to two")
    // stops asking the moment the player presses Done; without that flag
    // "chose to stop at one" would be indistinguishable from "hasn't picked a
    // second yet", exactly the ambiguity additionalCostResolved solves for
    // Meditation's cost.
    const stillChoosing = !pending.optionalTargetsResolved;
    // A `unitList` card keeps asking until it has its maximum, or until the
    // player presses Done — which is only offered once the minimum is met.
    // `max: undefined` ("any number") therefore asks until Done or until nothing
    // legal is left to click.
    if (targeting.kind === "unitList" && stillChoosing) {
      const chosen = pending.targetUnitInstanceIds ?? [];
      const room = targeting.max === undefined || chosen.length < targeting.max;
      if (room && offers("targetUnitInstanceIds")) return "listTarget";
    }
    if (
      // **Asked of the ENGINE, not of a union written out here.** This used to be
      // `kind === "unit" || "unitSlots" || "chainSpellAndUnit"` — a partial copy
      // of `TargetingSpec` living in this workspace, which silently answered "no
      // unit needed" for `unitAndEquipment` when that kind was added for
      // Relentless Pursuit. The card armed, took a destination, matched no
      // candidate and did nothing; reported from playtesting.
      //
      // `targetingChoosesUnit` is exhaustive over the union with no `default`,
      // so the next kind added breaks compilation here instead. Same reason
      // `cardMovesTarget` was extracted after Charm.
      targetingChoosesUnit(targeting) &&
      pending.targetUnitInstanceId === undefined &&
      // A `unitList` card fills its own field and is handled above; this branch
      // is the single-slot one.
      targeting.kind !== "unitList" &&
      stillChoosing
    ) {
      if (offers("targetUnitInstanceId")) return "firstTarget";
    }
    if (targeting.kind === "unitSlots" && pending.secondTargetUnitInstanceId === undefined && stillChoosing) {
      if (offers("secondTargetUnitInstanceId")) return "secondTarget";
    }
    // Asked BEFORE the target: X is what the card costs, and a player picking a
    // battlefield first would be choosing a target for a spell whose size they
    // have not set.
    if (pending.xAmount === undefined && candidates.some((a) => a.xAmount !== undefined)) return "xAmount";
    if (targeting.kind === "battlefield" && pending.targetBattlefieldId === undefined) {
      if (offers("targetBattlefieldId")) return "battlefieldTarget";
    }
    if (unitNeedsPlacement(candidates) && pending.destinationBattlefieldId === undefined) return "placement";
    // The Equipment half of a `unitAndEquipment` card, AFTER the destination —
    // Relentless Pursuit reads "Move a friendly unit. You may attach an
    // Equipment…", so the click order follows the card.
    //
    // Scoped to `unitAndEquipment` rather than to every spec that fills
    // `targetPermanentInstanceId`: `unitOrGear` and `{kind:"gear"}` also do, and
    // the UI has never let a player pick WHICH gear for those — it takes the
    // first candidate. Opening a step they have no affordance to satisfy would
    // stall Fading Memories and Rocket Barrage, turning an arbitrary-but-working
    // pick into the same silent no-op this is fixing. Widening it is note 3/4's
    // work, and it needs gear to become clickable on both sides first.
    if (
      targeting.kind === "unitAndEquipment" &&
      !pending.equipmentChoiceResolved &&
      offers("targetPermanentInstanceId")
    ) {
      return "equipment";
    }
    if (
      pending.card.kind === "Spell" &&
      cardHasOptionalExhaustCost(pending.card.defId) &&
      !pending.additionalCostResolved &&
      offers("additionalCostUnitInstanceId")
    ) {
      return "additionalCost";
    }
    if (targeting.kind === "ownTrashCard" && pending.trashCardInstanceId === undefined) {
      if (offers("trashCardInstanceId")) return "trashCard";
    }
    if (pending.card.kind === "Unit" && unitTriggerHasVisionChoice(state, HUMAN_INDEX, pending.card.defId) && pending.visionRecycle === undefined) {
      return "vision";
    }
    return null;
  }

  /** Which PendingPlay field the CURRENT step fills by clicking a unit, or
   *  null if this step isn't a unit click at all — what lets Gentlemen's
   *  Duel's two clicks land in two different fields without either handler
   *  needing to know about the other. */
  function pendingUnitSlot(): "targetUnitInstanceId" | "secondTargetUnitInstanceId" | "additionalCostUnitInstanceId" | null {
    switch (pendingStep()) {
      case "firstTarget":
        return "targetUnitInstanceId";
      case "secondTarget":
        return "secondTargetUnitInstanceId";
      case "additionalCost":
        return "additionalCostUnitInstanceId";
      default:
        return null;
    }
  }

  /** Does this `legal` candidate carry exactly the same choices `pendingPlay`
   *  has made? Compares EVERY field a PlayCardAction can be fanned out on,
   *  not just a subset: `legal` holds several candidates per card that differ
   *  only in a [Vision] boolean or a second target, so a partial comparison
   *  would happily resolve to a DIFFERENT variant than the player chose —
   *  and the auto-submit effect would then size its payment against one
   *  action while submitting another. Absent-vs-undefined is normalized the
   *  same way throughout (with BASE_ZONE_ID standing in for "no
   *  destination," per PendingPlay's doc comment). */
  function matchesPending(a: PlayCardAction, pending: PendingPlay): boolean {
    // Symmetric slots compare as an unordered set, and EXACTLY — unlike
    // pendingCandidates' subset test, since by this point targeting is settled
    // and a one-target choice must not resolve to a two-target candidate.
    // The mode, on both branches below — a modal card whose two modes carry the
    // same target would otherwise resolve to whichever was enumerated first.
    if (!sameMode(a, pending)) return false;
    if (pendingSlotsAreSymmetric(pending.card, pending.modeId)) {
      const chosen = [...targetSetOf(pending)].sort();
      const candidate = [...targetSetOf(a)].sort();
      if (chosen.length !== candidate.length || chosen.some((id, i) => id !== candidate[i])) return false;
      return (
        (a.targetBattlefieldId ?? null) === (pending.targetBattlefieldId ?? null) &&
        (a.trashCardInstanceId ?? null) === (pending.trashCardInstanceId ?? null) &&
        (a.visionRecycle ?? null) === (pending.visionRecycle ?? null) &&
        (a.additionalCostUnitInstanceId ?? null) === (pending.additionalCostUnitInstanceId ?? null) &&
        (a.destinationBattlefieldId ?? BASE_ZONE_ID) === (pending.destinationBattlefieldId ?? BASE_ZONE_ID) &&
        (a.fromHiddenBattlefieldId ?? null) === (pending.fromHiddenBattlefieldId ?? null) &&
        sameOptionalCosts(a, pending)
      );
    }
    return (
      (a.targetUnitInstanceId ?? null) === (pending.targetUnitInstanceId ?? null) &&
      (a.secondTargetUnitInstanceId ?? null) === (pending.secondTargetUnitInstanceId ?? null) &&
      // EXACTLY, unlike pendingCandidates' prefix test: by this point targeting
      // is settled, and a three-target choice resolving to a six-target candidate
      // would size the payment against one action and submit another — the
      // failure this whole function's doc comment is about.
      matchesPendingChoices(a, pending) &&
      sameTargetList(a.targetUnitInstanceIds, pending.targetUnitInstanceIds) &&
      (a.targetBattlefieldId ?? null) === (pending.targetBattlefieldId ?? null) &&
      (a.trashCardInstanceId ?? null) === (pending.trashCardInstanceId ?? null) &&
      (a.visionRecycle ?? null) === (pending.visionRecycle ?? null) &&
      (a.additionalCostUnitInstanceId ?? null) === (pending.additionalCostUnitInstanceId ?? null) &&
      (a.destinationBattlefieldId ?? BASE_ZONE_ID) === (pending.destinationBattlefieldId ?? BASE_ZONE_ID) &&
      (a.fromHiddenBattlefieldId ?? null) === (pending.fromHiddenBattlefieldId ?? null) &&
      sameOptionalCosts(a, pending)
    );
  }

  /** The armed Unit's PlayCardAction for a specific destination — `"base"`
   *  for the base-play candidate, a battlefield id for a reinforce
   *  candidate — or undefined if that destination isn't actually legal for
   *  the currently-armed card. Gated on the card actually HAVING a
   *  destination: letting an ordinary Spell match here would light up the
   *  base zone as a drop target for something that can never be placed. */
  function placementActionAt(destination: string): PlayCardAction | undefined {
    if (!pendingPlay || !cardHasDestination(pendingPlay.card)) return undefined;
    return pendingCandidates().find((a) => (a.destinationBattlefieldId ?? BASE_ZONE_ID) === destination);
  }

  /** The specific `legal` candidate `pendingPlay` currently resolves to —
   *  undefined until every choice it needs has actually been made. Once
   *  defined, its `payment` list lengths ARE the effective (floating-reduced)
   *  counts still owed — the manual payment step's completion target. */
  function pendingLegalAction(): PlayCardAction | undefined {
    const pending = pendingPlay;
    if (!pending) return undefined;
    if (pendingStep() !== null) return undefined;
    return playCardActionsFor(pending.card.instanceId).find((a) => matchesPending(a, pending));
  }

  /** Single-unit lookups — kept for drag (which resolves its own action from
   *  exactly the one dragged unit, independent of any click-based
   *  selection) and reused by the group helpers below as a per-unit legality
   *  hint (still reads `legal`'s real exhaustion/Ganking/domain checks). */
  function moveActionTo(unit: UnitInstance, battlefieldId: string): PlayerAction | undefined {
    return legal.find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds[0] === unit.instanceId && a.destinationBattlefieldId === battlefieldId,
    );
  }

  function recallActionFor(unit: UnitInstance): PlayerAction | undefined {
    return legal.find((a) => a.type === "RecallUnit" && a.unitInstanceIds[0] === unit.instanceId);
  }

  function canDragUnit(unit: UnitInstance): boolean {
    return canAct && !unit.exhausted;
  }

  /** Every currently-selected unit, resolved from ids to live instances —
   *  ids that no longer exist (e.g. the unit died) are silently dropped. */
  function selectedUnits(): UnitInstance[] {
    const everywhere = [...human.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[human.id] ?? [])];
    return everywhere.filter((u) => selectedUnitIds.has(u.instanceId));
  }

  /** Group-level "is this destination reachable for my WHOLE current
   *  selection" — every selected unit must individually reach it (reusing
   *  `moveActionTo`'s/`recallActionFor`'s single-unit `legal` lookups as a
   *  per-unit hint, not a group one — `legalActions()` never enumerates
   *  multi-unit combinations). Proactively gating on this, rather than
   *  submitting a partially-illegal group and letting the engine silently
   *  reject it, keeps this codebase's existing invariant: if a destination
   *  renders as `.selectable`, clicking it always works — there's no
   *  error/toast UI here to explain a silent no-op. */
  function isGroupMoveTarget(battlefieldId: string): boolean {
    const units = selectedUnits();
    return units.length > 0 && units.every((u) => Boolean(moveActionTo(u, battlefieldId)));
  }

  function isGroupRecallTarget(): boolean {
    const units = selectedUnits();
    return units.length > 0 && units.every((u) => Boolean(recallActionFor(u)));
  }

  /** Hand-constructs the real multi-unit action from local selection state
   *  and submits it directly — mirroring the manual rune-payment feature's
   *  precedent (`legal` is only ever consulted for per-unit legality hints
   *  above, never searched for a literal multi-unit candidate, since
   *  `legalActions()` intentionally never enumerates those). The engine's
   *  own `validateMoveUnit`/`executeMoveUnit` already process an arbitrary
   *  mixed-origin `unitInstanceIds` list correctly and are the real
   *  arbiter — this is just what the UI hands them. */
  function moveGroupTo(battlefieldId: string): PlayerAction | undefined {
    const units = selectedUnits();
    if (units.length === 0 || !units.every((u) => Boolean(moveActionTo(u, battlefieldId)))) return undefined;
    return {
      type: "MoveUnit",
      playerIndex: HUMAN_INDEX,
      unitInstanceIds: units.map((u) => u.instanceId),
      destinationBattlefieldId: battlefieldId,
    };
  }

  function recallGroup(): PlayerAction | undefined {
    const units = selectedUnits();
    if (units.length === 0 || !units.every((u) => Boolean(recallActionFor(u)))) return undefined;
    return { type: "RecallUnit", playerIndex: HUMAN_INDEX, unitInstanceIds: units.map((u) => u.instanceId) };
  }

  function handleHandCardClick(cardInstanceId: string) {
    const immediate = immediatePlayAction(cardInstanceId);
    if (immediate) {
      applyAction(immediate);
      return;
    }
    // A hideable-but-unplayable card still arms, so the Hide button can appear
    // for it — its `card` comes from the Hide candidate instead.
    const [firstPlay] = playCardActionsFor(cardInstanceId);
    const first = firstPlay ?? hideActionsFor(cardInstanceId)[0];
    if (!first) return;
    // A card needing a choice (target, placement, and/or payment) — arm it
    // (toggle off if clicking the same one again). Clears the unit selection
    // so at most one of the two "armed" states is ever live — otherwise a
    // stale unit selection could silently shadow this card's placement the
    // next time a battlefield/base-zone is clicked.
    setSelectedUnitIds(new Set());
    setUnplayableNotice(null);
    // Arms on the UNACCELERATED variant when both exist. [Accelerate] is an
    // optional additional cost (805), so declining it is the cheaper default and
    // the one a player who has never heard of the keyword expects; the toggle below
    // opts in. Set explicitly rather than left undefined so `pendingCandidates`
    // narrows to one variant immediately — leaving it open is what let the payment
    // be sized against one action and submitted as the other.
    setPendingPlay((prev) =>
      prev?.card.instanceId === first.card.instanceId
        ? null
        : {
            card: first.card,
            acceleratePaid: false,
            payment: { energyRunes: [], powerRunes: [] },
          },
    );
  }

  /** The armed card's OTHER cost variant, if [Accelerate] gives it one. Undefined
   *  whenever the card has no accelerated form, which is every card but a handful —
   *  so the toggle below simply doesn't render for them. */
  function costFlagAlternative(key: OptionalCostKey): PlayCardAction | undefined {
    const pending = pendingPlay;
    if (!pending) return undefined;
    const want = !(pending[key] ?? false);
    // Every OTHER settled choice must still match, or the "alternative" would be
    // a different card variant entirely — a repeat-paid candidate aimed at a
    // different target, say. This is the same pairing `pendingCandidates`
    // enforces, which is why it is asked of that list rather than of every
    // action for the card.
    return pendingCandidates().find(
      (a) =>
        (a[key] ?? false) === want &&
        OPTIONAL_COST_FLAGS.every((f) => f.key === key || (a[f.key] ?? false) === (pending[f.key] ?? false)),
    );
  }

  /**
   * Switches the armed card between paying an optional cost and not.
   *
   * Clears the payment: the two variants owe different runes, and carrying a
   * part-paid proposal across would leave runes committed against a cost that no
   * longer exists. That was a real bug for `[Accelerate]` — the card armed, asked
   * for a cost belonging to the other variant, and never completed however many
   * runes were clicked, which reads as the card being unplayable.
   */
  function toggleCostFlag(key: OptionalCostKey) {
    setPendingPlay((prev) =>
      prev ? { ...prev, [key]: !(prev[key] ?? false), payment: { energyRunes: [], powerRunes: [] } } : prev,
    );
  }

  function handleSelectUnit(unit: UnitInstance) {
    setPendingPlay(null);
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(unit.instanceId)) next.delete(unit.instanceId);
      else next.add(unit.instanceId);
      return next;
    });
  }

  /** Is clicking this unit right now a legal answer to the CURRENT step —
   *  not merely "a target of this card in some variant"? The distinction is
   *  what makes Gentlemen's Duel work: once its friendly first target is
   *  locked in, only enemy units still light up, because `pendingCandidates`
   *  has already narrowed to that first target's own candidates. */
  function isUnitLegalTarget(unit: UnitInstance): boolean {
    // An armed activated ability lights up its own targets through the same
    // predicate, so every board zone that already highlights card targets picks
    // ability targets up with no further wiring.
    if (pendingAbility !== null) return isAbilityTarget(unit);
    // The list step highlights whatever some live candidate names at the NEXT
    // position — which is how a unit already chosen stays clickable for a card
    // whose duplicates are legal, and stops being clickable for one whose are not.
    if (pendingStep() === "listTarget" && pendingPlay) {
      const next = (pendingPlay.targetUnitInstanceIds ?? []).length;
      return pendingCandidates().some((a) => (a.targetUnitInstanceIds ?? [])[next] === unit.instanceId);
    }
    const slot = pendingUnitSlot();
    if (!slot) return false;
    // Symmetric slots: a unit qualifies if any live candidate names it at ALL,
    // in either slot — the deduped fan-out may hold the pair in the opposite
    // order, and requiring a slot-position match would leave the second click
    // unhighlighted (and inert) exactly half the time.
    if (pendingPlay && slot !== "additionalCostUnitInstanceId" && pendingSlotsAreSymmetric(pendingPlay.card, pendingPlay.modeId)) {
      const alreadyChosen = targetSetOf(pendingPlay);
      if (alreadyChosen.includes(unit.instanceId)) return false;
      return pendingCandidates().some((a) => targetSetOf(a).includes(unit.instanceId));
    }
    return pendingCandidates().some((a) => a[slot] === unit.instanceId);
  }

  /**
   * Every ActivateAbility the human could submit for one permanent right now.
   * One entry when the ability targets nothing, one per legal target when it
   * does — legal-actions already fans it out that way, so the UI never has to
   * know what any particular ability targets.
   */
  function abilityCandidates(permanentInstanceId: string) {
    return legal.filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === permanentInstanceId);
  }

  /**
   * Does this permanent have an ability the human can use right now?
   *
   * Asked of `legal` rather than of the registry, so "Ready", "you control it",
   * "the Action phase" and "a legal target exists" are all answered by the
   * engine's own enumeration instead of being re-derived here.
   *
   * **It used to say "an exhaust-cost ability", and that description has been
   * outgrown rather than being wrong.** Unleashed prints abilities whose whole
   * cost is XP with no exhaust at all (UNL-102, UNL-126, UNL-162), which are
   * repeatable while the XP lasts. They need nothing here precisely because this
   * re-derives nothing — but a reader who believed the old wording would go
   * looking for the exhaust gate that makes them work, and there isn't one.
   */
  function canActivate(permanentInstanceId: string): boolean {
    return abilityCandidates(permanentInstanceId).length > 0;
  }

  /** Is `unit` a legal target for the ability currently waiting on one? */
  function isAbilityTarget(unit: UnitInstance): boolean {
    if (pendingAbility === null) return false;
    return abilityCandidates(pendingAbility).some(
      (a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === unit.instanceId,
    );
  }

  /**
   * Clicking a permanent with an activated ability. Fires immediately when the
   * ability asks nothing, otherwise arms it and waits for a target click — the
   * same two-shape flow a hand card already has, minus every step that only a
   * PlayCard can need.
   *
   * Re-clicking an armed permanent disarms it, matching how the armed hand card
   * cancels itself.
   */
  function handleActivateClick(permanentInstanceId: string) {
    if (pendingAbility === permanentInstanceId) {
      setPendingAbility(null);
      return;
    }
    const candidates = abilityCandidates(permanentInstanceId);
    if (candidates.length === 0) return;
    const untargeted = candidates.find((a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === undefined);
    if (untargeted) {
      applyAction(untargeted);
      return;
    }
    setPendingPlay(null); // arming an ability abandons a half-made card play
    setPendingAbility(permanentInstanceId);
  }

  /** The single selected unit whose ability the human could activate right now,
   *  if there is exactly one. Exactly one, because "Activate" has to name what
   *  it will do, and a multi-unit selection is a move selection. */
  function activatableSelectedUnit(): UnitInstance | undefined {
    if (selectedUnitIds.size !== 1) return undefined;
    const [id] = [...selectedUnitIds];
    if (!id || !canActivate(id)) return undefined;
    const everywhere = [...human.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[human.id] ?? [])];
    return everywhere.find((u) => u.instanceId === id);
  }

  /** What the armed ability belongs to, for the Cancel button's label. */
  function activatingPermanentName(): string {
    if (pendingAbility === null) return "";
    const everywhere = [
      ...human.activeGear,
      ...human.baseUnits,
      ...state.battlefields.flatMap((bf) => bf.units[human.id] ?? []),
      human.legend,
    ];
    return everywhere.find((c) => c.instanceId === pendingAbility)?.name ?? "ability";
  }

  /**
   * The human's own facedown cards that `legalActions` is offering right now —
   * i.e. hidden on an earlier turn AND with a legal target at that battlefield
   * (rule 811 refuses the play outright when there is none). Read off `legal`
   * rather than re-derived, so the board can never light up a card the engine
   * would then refuse.
   */
  const playableHiddenIds = useMemo(
    () =>
      new Set(
        legal
          .filter((a) => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined)
          .map((a) => (a.type === "PlayCard" ? a.card.instanceId : "")),
      ),
    [legal],
  );

  /** Every legal Hide for the currently-armed hand card — empty unless one is
   *  armed, so the actions row only offers it once the player has said which
   *  card they mean. */
  function hideOptions() {
    if (!pendingPlay || pendingPlay.fromHiddenBattlefieldId !== undefined) return [];
    return hideActionsFor(pendingPlay.card.instanceId);
  }

  /** Play a facedown card. It goes through the ordinary armed-card path, because
   *  a from-hidden play can still need a target chosen — legal-actions has
   *  already narrowed those to that battlefield. */
  function playHiddenCard(cardInstanceId: string, battlefieldId: string) {
    const candidates = legal.filter(
      (a) => a.type === "PlayCard" && a.card.instanceId === cardInstanceId && a.fromHiddenBattlefieldId === battlefieldId,
    );
    if (candidates.length === 0) return;
    // Exactly one option and nothing left to choose: play it outright.
    if (candidates.length === 1) {
      applyAction(candidates[0]!);
      return;
    }
    const first = candidates[0]!;
    if (first.type !== "PlayCard") return;
    setPendingAbility(null);
    setPendingPlay({ card: first.card, payment: first.payment, fromHiddenBattlefieldId: battlefieldId });
  }

  /** Should one of the human's own units render — and behave — as clickable
   *  right now? While the armed card is still asking something, only a legal
   *  answer qualifies: since handleUnitClick now ignores every other click,
   *  showing the ordinary move-selection affordance would promise something
   *  that no longer happens. Keeps this file's existing invariant that
   *  anything rendering `.selectable` actually does something when clicked
   *  (see isGroupMoveTarget's own doc comment). */
  function isFriendlyUnitSelectable(unit: UnitInstance): boolean {
    if (isUnitLegalTarget(unit)) return true;
    if (pendingAbility !== null) return false;
    if (pendingStep() !== null) return false;
    return !unit.exhausted;
  }

  /** Already-chosen targets of the armed card — rendered with the same
   *  `.selected` outline a move-selected unit gets, so a half-finished pair
   *  (Gentlemen's Duel's friendly target, Meditation's exhaust victim) is
   *  visible on the board rather than only in the header hint. The Java
   *  client shows literal `#1`/`#2` ordinal badges for the same reason
   *  (ui/BoardController.java:3227-3228). */
  function pendingChosenUnitIds(): Set<string> {
    const ids = new Set<string>();
    if (!pendingPlay) return ids;
    for (const id of [
      pendingPlay.targetUnitInstanceId,
      pendingPlay.secondTargetUnitInstanceId,
      pendingPlay.additionalCostUnitInstanceId,
    ]) {
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  /** Everything the chain currently points at, as ids the board can match —
   *  read off the raw ChainEntry rather than off `describeChain`'s output,
   *  which resolves ids to display names on purpose and so can't be matched
   *  back against a unit. Narrowed to a single item while one is hovered in
   *  ChainView, so a deep chain can be read one item at a time.
   *
   *  This is how a chain item points at its target: no arrows. The Java client
   *  draws real arrows and its own comment records why that was fragile —
   *  nodes added in the same layout pulse measured stale/zero bounds, "and
   *  that mismatch, not a logic bug, was why the arrow only sometimes
   *  appeared" (ui/BoardController.java's drawChainArrows, which needed both a
   *  deferred pulse and a forced applyCss()/layout()). Framer Motion owns
   *  every card's transform here, so co-highlighting the target instead says
   *  the same thing with nothing measured. */
  function chainHighlight(): { units: Set<string>; battlefields: Set<string> } {
    const source = hoveredChainIndex !== null ? chainItems.slice(hoveredChainIndex, hoveredChainIndex + 1) : chainItems;
    const units = new Set<string>();
    const battlefields = new Set<string>();
    for (const item of source) {
      // A triggered ability waiting as a Pending Item has no chosen targets to
      // co-highlight — it is pushed already-finalized, so nothing was ever picked.
      if (item.kind !== "spell") continue;
      for (const id of [
        item.entry.targetUnitInstanceId,
        item.entry.secondTargetUnitInstanceId,
        item.entry.additionalCostUnitInstanceId,
      ]) {
        if (id !== undefined) units.add(id);
      }
      for (const id of [item.entry.targetBattlefieldId, item.entry.destinationBattlefieldId]) {
        if (id !== undefined) battlefields.add(id);
      }
    }
    return { units, battlefields };
  }

  /** Unified click handler for any unit, friendly or enemy, at a battlefield
   *  OR in the human's own base. If an armed card is currently waiting on a
   *  unit click (a target, a pair's second target, or Meditation's optional
   *  exhaust cost) and this unit is a legal answer, resolves that step onto
   *  `pendingPlay` (which may still need further choices and/or a payment
   *  step afterward); otherwise falls through to ordinary move-selection. */
  function handleUnitClick(unit: UnitInstance) {
    // An armed ability is asking exactly one question, so answering it submits
    // straight away — there is no payment or later step to collect first.
    if (pendingAbility !== null) {
      const chosen = abilityCandidates(pendingAbility).find(
        (a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === unit.instanceId,
      );
      if (chosen) applyAction(chosen);
      // Any other click while an ability is armed does nothing, same rule the
      // armed-card path below follows: backing out is the explicit re-click.
      return;
    }
    if (pendingPlay && pendingStep() === "listTarget" && isUnitLegalTarget(unit)) {
      setPendingPlay({
        ...pendingPlay,
        targetUnitInstanceIds: [...(pendingPlay.targetUnitInstanceIds ?? []), unit.instanceId],
      });
      return;
    }
    const slot = pendingUnitSlot();
    if (pendingPlay && slot && isUnitLegalTarget(unit)) {
      setPendingPlay({
        ...pendingPlay,
        [slot]: unit.instanceId,
        // Picking a unit IS the answer to the optional-cost question, so the
        // step is resolved by the same click — see additionalCostResolved.
        ...(slot === "additionalCostUnitInstanceId" ? { additionalCostResolved: true } : {}),
      });
      return;
    }
    // While the armed card is still ASKING something, the board only accepts
    // answers to that question — a click on anything else does nothing rather
    // than falling through to move-selection (which clears pendingPlay). That
    // fall-through was harmless when every targeted card resolved in one
    // click, but Gentlemen's Duel and Meditation carry half-made choices, and
    // silently discarding one on a misclick — no undo, no feedback — is the
    // wrong default. Mirrors the Java client, whose own multi-target handler
    // no-ops an illegal target click rather than cancelling
    // (ui/BoardController.java:3567-3578's `if (!roleOk) { refresh(); return; }`).
    // Backing out is the explicit Cancel button in the actions row (or
    // re-clicking the armed card), never an accident.
    if (pendingStep() !== null) return;
    // Once only a rune payment is left there's no half-made choice to lose,
    // and clicking a unit reads naturally as "I'm done with this card" — so
    // the original fall-through stays exactly as it was.
    handleSelectUnit(unit);
  }

  /** "You may exhaust a friendly unit... otherwise draw 1" — the explicit
   *  no. The Java client's equivalent gesture is a base click ("click your
   *  base to confirm with 0 targets", ui/BoardController.java:2770-2772),
   *  but a base click here is already overloaded three ways (recall a
   *  selection, place a Unit, select a base unit), so this gets its own
   *  button next to Auto Pay instead of a fourth hidden meaning. */
  function declineAdditionalCost() {
    if (!pendingPlay) return;
    setPendingPlay({ ...pendingPlay, additionalCostResolved: true });
  }

  /** Declining the Equipment half of a `unitAndEquipment` card — Relentless
   *  Pursuit's "you MAY attach". Sets only the resolved flag, which is what
   *  makes a declined attach distinguishable from an unmade choice; see
   *  `matchesPendingEquipment`. */
  function declineEquipment() {
    if (!pendingPlay) return;
    setPendingPlay({ ...pendingPlay, equipmentChoiceResolved: true });
  }

  /** Picking the Equipment. Resolves the step in the same click, exactly as a
   *  unit click resolves the optional-cost step. */
  function handleEquipmentClick(gearInstanceId: string) {
    if (!pendingPlay) return;
    setPendingPlay({ ...pendingPlay, targetPermanentInstanceId: gearInstanceId, equipmentChoiceResolved: true });
  }

  /**
   * The attachment badges for any card on the board — Equipment worn, for a
   * unit; the wearer's name, for a gear.
   *
   * ONE derivation, passed down to `BattlefieldView` rather than reimplemented
   * there, because a second copy would be a second answer to "what is attached
   * to what" — and the first version of this question already had none at all.
   * Returns a props object so a caller spreads it and adds nothing when there is
   * nothing attached.
   */

  /**
   * The gear that still belongs in the flat gear ROW — i.e. everything NOT
   * attached to a unit.
   *
   * An attached Equipment now renders tucked under its wearer (see
   * `.attached-stack`), so leaving it in the row as well would show the same
   * card twice in two places, which is the confusion the paper layout is
   * fixing rather than a second helpful copy.
   *
   * Filtered at the ROW rather than removed from `activeGear`, because the
   * engine keeps an attached Equipment in that list on purpose — it is still
   * killable, readyable and countable there, and several cards read it back.
   * This is a display decision only.
   */
  function looseGear(player: PlayerState): GearInstance[] {
    return player.activeGear.filter((g) => g.attachedToInstanceId == null);
  }

  function attachmentProps(card: CardInstance): {
    attachedEquipment?: readonly { instanceId: string; name: string; defId: string }[];
    attachedMightBonus?: number;
    attachedToUnitName?: string;
    currentMight?: number;
  } {
    if (card.kind === "Unit") {
      // **CURRENT Might, which the board never showed.** Reported from
      // playtesting: "need to have UI accurately represent a unit's current
      // might". It was worse than a missing badge — `effectiveMight` was not
      // called ANYWHERE in this package, so the card face showed its PRINTED
      // Might and only three of the many modifiers had a badge of their own
      // (marked damage, a this-turn pump, a Buff). A unit wearing a +4 Blade of
      // the Ruined King, or standing under a Garen aura, showed its printed
      // number with nothing to indicate otherwise.
      //
      // Computed HERE for the same reason the attachment answer is: one
      // derivation, spread by the caller, so the board cannot come to a
      // different number than the engine. Asked out of combat — a unit in a
      // combat has two Mights (outgoing and remaining) and a card face has room
      // for one, so the neutral reading is the honest one to print.
      // `findUnitAnywhere` supplies both the owner and the LOCATION. The
      // location is not optional detail: positional auras (Garen - Commander's
      // "other friendly units here") are counted only when `battlefieldId` is
      // passed, and omitting it is the exact defect that made the engine's own
      // `isMighty` under-report until it was fixed earlier today.
      const found = findUnitAnywhere(state, card.instanceId);
      const currentMight = found
        ? effectiveMight(state, found.unit, found.ownerIndex, {
            isCombat: false,
            // `UnitZone` carries an INDEX, and `effectiveMight` wants the id.
            ...(found.zone === "base"
              ? {}
              : { battlefieldId: state.battlefields[found.zone.battlefieldIndex]!.id }),
          })
        : undefined;
      const worn = equipmentAttachedTo(state, card.instanceId);
      if (worn.length === 0) return currentMight === undefined ? {} : { currentMight };
      return {
        currentMight,
        attachedEquipment: worn,
        attachedMightBonus: equipmentMightBonusFor(state, card.instanceId),
      };
    }
    if (card.kind === "Gear" && card.attachedToInstanceId !== null) {
      const wearer = wearerOf(state, card);
      return wearer ? { attachedToUnitName: wearer.unit.name } : {};
    }
    return {};
  }

  /** Is this gear a legal pick for the Equipment step right now? Read off the
   *  live candidates rather than re-derived from the board, so the board can
   *  never light up a gear the engine would then refuse — the rule every
   *  highlight in this file follows. */
  function isEquipmentLegalTarget(gearInstanceId: string): boolean {
    if (pendingStep() !== "equipment") return false;
    return pendingCandidates().some((a) => a.targetPermanentInstanceId === gearInstanceId);
  }

  /** How many targets this card MUST have — 0 for the "up to two" cards,
   *  which is what makes stopping early legal at all. */
  function pendingMinTargets(): number {
    if (!pendingPlay) return 0;
    const targeting = targetingForPlay(pendingPlay.card, pendingPlay.modeId);
    if (targeting.kind === "unitSlots" || targeting.kind === "unitList") return targeting.min;
    // Riposte's unit is mandatory (355.8 makes it uncastable without one), so it
    // counts here exactly as a plain single-target card's does.
    return targeting.kind === "unit" || targeting.kind === "chainSpellAndUnit" ? 1 : 0;
  }

  /** Can the player stop picking targets right now — i.e. has an "up to N"
   *  card already got at least its minimum? Drives the Done button. */
  function canFinishTargeting(): boolean {
    const step = pendingStep();
    if (step !== "firstTarget" && step !== "secondTarget" && step !== "listTarget") return false;
    return pendingChosenTargetCount() >= pendingMinTargets();
  }

  function pendingChosenTargetCount(): number {
    if (!pendingPlay) return 0;
    return (
      [pendingPlay.targetUnitInstanceId, pendingPlay.secondTargetUnitInstanceId].filter((id) => id !== undefined).length +
      (pendingPlay.targetUnitInstanceIds ?? []).length
    );
  }

  /** Settles for the targets picked so far — see optionalTargetsResolved. */
  function finishTargeting() {
    if (!pendingPlay) return;
    setPendingPlay({ ...pendingPlay, optionalTargetsResolved: true });
  }

  /** Is this battlefield a legal answer to a "battlefield"-kind effect's own
   *  target step (Firestorm's "all enemy units AT A BATTLEFIELD")? Entirely
   *  separate from `placementActionAt`'s "where should this Unit be played"
   *  question, which happens to use the same click. */
  function isBattlefieldLegalTarget(battlefieldId: string): boolean {
    if (pendingStep() !== "battlefieldTarget") return false;
    return pendingCandidates().some((a) => a.targetBattlefieldId === battlefieldId);
  }

  /** The eligible own-trash cards for an "ownTrashCard" step, resolved from
   *  the candidate set rather than re-deriving TargetingSpec.cardKind here —
   *  so Annie-Stubborn offers only Spells and Morbid Return only Units
   *  without this UI knowing either rule. */
  function pendingTrashOptions(): CardInstance[] {
    if (pendingStep() !== "trashCard") return [];
    const eligible = new Set(pendingCandidates().map((a) => a.trashCardInstanceId));
    return human.trash.filter((c) => eligible.has(c.instanceId));
  }

  /** True if this rune could legally be added to the Energy list right now
   *  (only Ready runes can pay Energy, and only when the effective Energy
   *  cost is actually nonzero — otherwise every Ready rune would falsely
   *  read as "payable" for a card floating already covers entirely) — used
   *  both for click-eligibility and for the rune tile's own visual
   *  affordance. */
  function isRuneEligibleForEnergy(rune: RuneCard): boolean {
    if (rune.state !== "Ready") return false;
    return (pendingLegalAction()?.payment.energyRunes.length ?? 0) > 0;
  }

  /** True if this rune could legally be added to the Power list right now —
   *  domain-gated (or any domain, for a rainbow cost; or either of a
   *  confirmed handful of genuinely hybrid-pip cards' two domains, e.g.
   *  Tibbers' Fury/Chaos — see matchesPowerDomain), Ready or Exhausted, and
   *  only when the effective Power cost is actually nonzero. A null
   *  powerDomain only ever means "no Power cost" in this card pool (never a
   *  real rainbow cost), so without the nonzero check every rune would
   *  falsely read as Power-eligible for a plain Energy-only card. */
  function isRuneEligibleForPower(rune: RuneCard): boolean {
    if (!pendingPlay || pendingPlay.card.kind === "Legend") return false;
    if (!matchesPowerDomain(rune, pendingPlay.card.powerDomain, pendingPlay.card.powerDomainAlt)) return false;
    return (pendingLegalAction()?.payment.powerRunes.length ?? 0) > 0;
  }

  function toggleEnergyRune(rune: RuneCard) {
    if (!isRuneEligibleForEnergy(rune)) return;
    setPendingPlay((prev) => {
      if (!prev) return prev;
      const already = prev.payment.energyRunes.includes(rune.id);
      if (!already) {
        const required = pendingLegalAction()?.payment.energyRunes.length ?? 0;
        if (prev.payment.energyRunes.length >= required) return prev; // already fully proposed
      }
      const energyRunes = already ? prev.payment.energyRunes.filter((id) => id !== rune.id) : [...prev.payment.energyRunes, rune.id];
      return { ...prev, payment: { ...prev.payment, energyRunes } };
    });
  }

  function togglePowerRune(rune: RuneCard) {
    if (!isRuneEligibleForPower(rune)) return;
    setPendingPlay((prev) => {
      if (!prev) return prev;
      const already = prev.payment.powerRunes.includes(rune.id);
      if (!already) {
        const required = pendingLegalAction()?.payment.powerRunes.length ?? 0;
        if (prev.payment.powerRunes.length >= required) return prev; // already fully proposed
      }
      const powerRunes = already ? prev.payment.powerRunes.filter((id) => id !== rune.id) : [...prev.payment.powerRunes, rune.id];
      return { ...prev, payment: { ...prev.payment, powerRunes } };
    });
  }

  /**
   * Fills whatever's still owed, PER BUCKET — see `auto-payment.ts`.
   *
   * This used to build one remaining pool by removing every rune already
   * proposed in EITHER bucket, which cannot express rule 164.2's double duty:
   * a Ready rune pays one Energy AND one Power, and the engine's own payment
   * for Falling Star (2 Energy + 2 Fury Power) is two Fury runes listed twice.
   * So a player who left-clicked their two Fury runes for the Energy half — the
   * gesture the header asks for first — emptied the pool, the fill came back
   * null, and the button did NOTHING. Reported from play as "I have the
   * resources but nothing happens, even using Auto Pay".
   *
   * A genuine refusal now SAYS so. The old silent no-op made an unpayable
   * remainder and a dead button indistinguishable, which is the same failure
   * this file's own comment records for a silently-waiting target step.
   */
  function handleAutoPay() {
    if (!pendingPlay || pendingPlay.card.kind === "Legend") return;
    const required = pendingLegalAction();
    if (!required) return;

    const fill = autoPayFill(
      human.channeled,
      pendingPlay.payment,
      required.payment,
      pendingPlay.card.powerDomain,
      pendingPlay.card.powerDomainAlt,
    );
    if (!fill) {
      // Nothing owed is not a failure; anything else is one worth naming.
      const owesEnergy = required.payment.energyRunes.length > pendingPlay.payment.energyRunes.length;
      const owesPower = required.payment.powerRunes.length > pendingPlay.payment.powerRunes.length;
      if (owesEnergy || owesPower) {
        setUnplayableNotice(
          `Your channeled runes can't cover the rest of ${pendingPlay.card.name}'s cost. ` +
            `Right-click a rune to un-propose it and try again.`,
        );
      }
      return;
    }

    setPendingPlay((prev) =>
      prev
        ? {
            ...prev,
            payment: {
              energyRunes: [...prev.payment.energyRunes, ...fill.energyRunes],
              powerRunes: [...prev.payment.powerRunes, ...fill.powerRunes],
              // The `[Deflect]` surcharge. Spread only when it has entries, so a
              // card with no taxed target keeps sending the two-bucket payment
              // every stored action and every test literal already carries.
              ...(fill.rainbowRunes.length > 0 || (prev.payment.rainbowRunes ?? []).length > 0
                ? { rainbowRunes: [...(prev.payment.rainbowRunes ?? []), ...fill.rainbowRunes] }
                : {}),
            },
          }
        : prev,
    );
  }

  // Auto-submits the moment a fully-resolved pendingPlay's proposed payment
  // exactly matches the effective size `legal` already expects — covers
  // both the manual/Auto-Pay-built payment case and the "nothing to pay"
  // case (a card only needing choices resolves and submits the instant the
  // last one is made, same as before payment arming existed).
  useEffect(() => {
    if (!pendingPlay) return;
    const resolved = pendingLegalAction();
    if (!resolved) return;
    if (
      pendingPlay.payment.energyRunes.length !== resolved.payment.energyRunes.length ||
      pendingPlay.payment.powerRunes.length !== resolved.payment.powerRunes.length ||
      // **The `[Deflect]` surcharge counts too.** Without this line the gate
      // declared a payment complete while its third bucket was empty, submitted
      // it, and `validate-play-card` refused — "must pay 1 rainbow Power for
      // [Deflect] on its target, but named 0". Nothing rendered the refusal, so
      // every one of the 39 taxed cards simply un-armed when aimed at a Deflect
      // unit. That is the same silent shape the payment gap above produced.
      (pendingPlay.payment.rainbowRunes ?? []).length !== (resolved.payment.rainbowRunes ?? []).length
    ) {
      return;
    }
    // **Submitted as the ENUMERATED action, not rebuilt from the pending one.**
    //
    // This used to assemble a fresh `PlayCardAction` field by field, one spread
    // per optional field — and three never got a line: `targetUnitInstanceIds`
    // (every `unitList` card), `xAmount` (Bullet Time's X) and
    // `fromHiddenBattlefieldId` (811's play from facedown). Falling Star was
    // therefore submitted with NO targets and refused with "requires 2 targets,
    // got 0", which — before a refusal was ever rendered — read as the card
    // silently declining to cast. That is the SIXTH recorded instance of a
    // dispatch hop dropping a field in this codebase.
    //
    // `resolved` is already the one enumerated action matching every choice the
    // player made — `matchesPending` compares each of them exactly — so it
    // carries every field by construction, including any added later. The only
    // thing the board knows better is WHICH runes pay. See submitted-play.ts.
    applyAction(submittedPlay(resolved, pendingPlay.payment));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay, legal]);

  const isBaseZoneTarget =
    canAct && (selectedUnitIds.size > 0 ? isGroupRecallTarget() : Boolean(placementActionAt(BASE_ZONE_ID)));

  function handleBattlefieldClick(battlefieldId: string) {
    if (selectedUnitIds.size > 0) {
      const action = moveGroupTo(battlefieldId);
      if (action) applyAction(action);
      return;
    }
    if (!pendingPlay) return;
    // A "battlefield"-kind EFFECT target (Firestorm) is checked before
    // placement: the two never coexist on one card (only a Unit has a
    // placement, and no Unit's on-play trigger targets a battlefield), and
    // pendingStep() gates this branch anyway.
    if (isBattlefieldLegalTarget(battlefieldId)) {
      setPendingPlay({ ...pendingPlay, targetBattlefieldId: battlefieldId });
      return;
    }
    const placement = placementActionAt(battlefieldId);
    if (placement) setPendingPlay({ ...pendingPlay, destinationBattlefieldId: battlefieldId });
  }

  function handleBaseZoneClick() {
    if (selectedUnitIds.size > 0) {
      const action = recallGroup();
      if (action) applyAction(action);
      return;
    }
    if (!pendingPlay) return;
    const placement = placementActionAt(BASE_ZONE_ID);
    if (placement) setPendingPlay({ ...pendingPlay, destinationBattlefieldId: BASE_ZONE_ID });
  }

  function handlePass() {
    const pass = legal.find((a) => a.type === "Pass");
    if (pass) applyAction(pass);
  }

  function handlePassFocus() {
    const passFocus = legal.find((a) => a.type === "PassFocus");
    if (passFocus) applyAction(passFocus);
  }

  // Drag handlers — additive to the click flow above. Dragging never
  // relocates anything by itself; it only ever ends by committing a real
  // action (which then animates via the layoutId in CardView), or springing
  // back to origin (dragSnapToOrigin) if dropped somewhere illegal.
  function trackDragZone(point: DragPoint) {
    const zone = dropZoneAt(point);
    lastDragZoneRef.current = zone;
    setDragOverZoneId(zone);
  }
  /** Dropping a hand/champion Unit resolves its destination directly from
   *  wherever it was dropped (base, or a specific "reinforce" battlefield)
   *  — the whole point of drag-and-drop is that the drop location itself
   *  answers "where," so it shouldn't ALSO require a separate click on that
   *  same zone afterward. Plays instantly if nothing else is owed, or arms
   *  `pendingPlay` with the destination already resolved so only a still-
   *  owed rune payment needs further interaction (the auto-submit effect
   *  picks this up via `pendingLegalAction()` exactly as if a click had set
   *  `destinationBattlefieldId`). A Spell's target is a specific unit, not
   *  a zone, so dropping one just arms it (same as a plain click) regardless
   *  of where it landed — still better than the old behavior, which did
   *  nothing at all unless dropped on base specifically. Falls back to a
   *  plain arm for a Unit dropped somewhere that isn't a legal destination
   *  for it at all, rather than silently doing nothing. */
  function handleHandCardDragEnd(cardInstanceId: string) {
    const zone = lastDragZoneRef.current;
    setDragOverZoneId(null);
    lastDragZoneRef.current = null;
    if (!zone) return;

    const actions = playCardActionsFor(cardInstanceId);
    const [first] = actions;
    if (!first) return;

    // Token-placing Spells (Recruit the Vanguard) drop like Units do — the
    // zone you release over IS the answer to "where do these go".
    const placement = cardHasDestination(first.card)
      ? actions.find((a) => (a.destinationBattlefieldId ?? BASE_ZONE_ID) === zone)
      : undefined;

    if (!placement) {
      handleHandCardClick(cardInstanceId);
      return;
    }
    // Sai Scout is the case that makes this a two-part check: it can be
    // dropped straight onto an open battlefield (resolving its placement),
    // but its [Vision] recycle choice is still unanswered, so submitting
    // `placement` here would be submitting an action the engine rejects.
    // Arm instead and let the remaining steps run.
    if (!actionNeedsPayment(placement) && !cardNeedsChoice(placement.card)) {
      applyAction(placement);
      return;
    }

    setSelectedUnitIds(new Set());
    setPendingPlay({
      card: placement.card,
      payment: { energyRunes: [], powerRunes: [] },
      // `PlayCardAction.destinationBattlefieldId` is undefined to mean
      // "base," but `PendingPlay.destinationBattlefieldId` uses undefined
      // to mean "not yet resolved" and BASE_ZONE_ID as the explicit
      // resolved-to-base sentinel (see the PendingPlay doc comment) — this
      // MUST always be set here (never omitted), or a Unit with a reinforce
      // option available (unitNeedsPlacement true) dropped on base gets
      // wrongly treated by pendingLegalAction() as still needing a
      // placement click, defeating the whole point of the drag.
      destinationBattlefieldId: placement.destinationBattlefieldId ?? BASE_ZONE_ID,
    });
  }
  function handleUnitDragEnd(unit: UnitInstance) {
    const zone = lastDragZoneRef.current;
    setDragOverZoneId(null);
    lastDragZoneRef.current = null;
    if (!zone) return;
    const action = zone === BASE_ZONE_ID ? recallActionFor(unit) : moveActionTo(unit, zone);
    if (action) applyAction(action);
  }

  /** Clears everything scoped to one GAME, so the next one starts clean. Split
   *  out because a Best of 3's "next game" needs exactly this and must NOT
   *  touch the series, while starting a whole new match needs this plus a
   *  series reset. */
  function resetForNewGame(newConfig: MatchConfig, seed: number) {
    setGame(null);
    setGameSeed(seed);
    bankedGameRef.current = false;
    setPregameState(dealOpeningHands(createNewGame(newConfig, seed)));
    // Same narrowing as the initial state above: a spectated Bo3 rolls its
    // battlefields rather than stopping at a chooser nobody is sitting at.
    setPregame(newConfig.format === "bo3" && newConfig.spectate !== true ? "selectBattlefield" : "mulligan");
    setSelectedUnitIds(new Set());
    setPendingPlay(null);
    setPendingAbility(null);
    setDragOverZoneId(null);
    setUnplayableNotice(null);
    setViewingTrash(null);
    // A resolution beat left running from the finished game would otherwise
    // show a chain entry over the next one's opening board.
    clearResolutionBeat();
    setResolvingChainItem(null);
    setHoveredChainIndex(null);
  }

  /** Starts a brand-new match (rematch or quick-swap) — a fresh seed always,
   *  so "same decks" still reshuffles rather than replaying identically, and a
   *  fresh series, since a rematch is a new match rather than a continuation of
   *  the one that just ended. */
  function startNewMatch(newConfig: MatchConfig) {
    setConfig(newConfig);
    setSeries(freshSeries());
    resetForNewGame(newConfig, Date.now());
  }

  function handleQuickSwap(deck: DeckList) {
    startNewMatch({ ...config, humanDeck: deck });
  }

  /** Rule 486.5: the human presents one of their three battlefields, and the
   *  AI presents one of its own at the same time (rolled — see
   *  rollAiBattlefield). Rebuilds this game's state with both choices in place,
   *  replacing the throwaway rolled-battlefield state the chooser sat in front
   *  of, then moves on to the mulligan. */
  function handleBattlefieldSelect(humanName: string) {
    const aiName = rollAiBattlefield(config, gameSeed, series.aiUsedBattlefields);
    setPregameState(dealOpeningHands(createNewGame(config, gameSeed, { humanName, aiName })));
    setPregame("mulligan");
  }

  /** Applies the human's mulligan choice (the AI never mulligans — see
   *  execute-mulligan.ts's doc comment), then begins the first turn and
   *  switches from the pregame mulligan screen to the real board. */
  function handleMulliganConfirm(humanSetAsideIds: string[]) {
    const resolved =
      humanSetAsideIds.length > 0
        ? executeMulligan(pregameState!, { type: "Mulligan", playerIndex: HUMAN_INDEX, setAsideInstanceIds: humanSetAsideIds })
        : pregameState!;
    setGame(beginFirstTurn(resolved));
    setPregame("playing");
  }

  /** Rule 486.6's between-games reset: bank the game win, retire the
   *  battlefields that were just played (486.5), and set up the next game.
   *  Reads the battlefields off the state that just ended rather than
   *  remembering what was chosen, so it can't drift from what was actually in
   *  play. */
  function handleNextGame() {
    const humanBattlefield = state.battlefields[0]?.name;
    const aiBattlefield = state.battlefields[1]?.name;
    setSeries((prev) => ({
      ...prev,
      gameNumber: prev.gameNumber + 1,
      humanUsedBattlefields: humanBattlefield ? [...prev.humanUsedBattlefields, humanBattlefield] : prev.humanUsedBattlefields,
      aiUsedBattlefields: aiBattlefield ? [...prev.aiUsedBattlefields, aiBattlefield] : prev.aiUsedBattlefields,
    }));
    resetForNewGame(config, Date.now());
  }

  // Computed once per render for the header hint and the rune-payment UI —
  // both need to know exactly which phase `pendingPlay` is currently in.
  const pendingResolvedAction = pendingLegalAction();
  const currentStep = pendingStep();
  const chainTargets = chainHighlight();
  // A ChoiceOverlay is up. Its backdrop deliberately swallows board clicks,
  // which also puts the actions row out of reach — so the row's own Cancel
  // hides rather than sitting there visibly unpressable (the overlay carries
  // its own Cancel for exactly this window).
  const modalStepActive = currentStep === "trashCard" || currentStep === "vision";

  /** The header's "what do I click next" line for the armed card, phrased
   *  after the Java client's own prompts (ui/BoardController.java:2760-2779),
   *  including its `[1/2]` progress counter for a multi-target spell. The
   *  two modal steps get no line here — the overlay's own title says it,
   *  right where the player is already looking. */
  function pendingHintText(): string | null {
    // An armed ability asks one question and asks it here, for the same reason
    // the armed card does: an ability that silently waits for a click is
    // indistinguishable from one that did nothing.
    if (pendingAbility !== null) return ` — choose a target for ${activatingPermanentName()}'s ability`;
    if (!pendingPlay) return null;
    const name = pendingPlay.card.name;
    switch (currentStep) {
      case "firstTarget":
      case "secondTarget": {
        const targeting = targetingForPlay(pendingPlay.card, pendingPlay.modeId);
        if (targeting.kind !== "unitSlots") return ` — choose a target for ${name}`;
        const slot = currentStep === "firstTarget" ? 0 : 1;
        const role = targeting.slots[slot];
        const who = role === "any" ? "unit" : `${role} unit`;
        // "up to" when the minimum isn't met by the slots themselves — that's
        // the difference between Gentlemen's Duel (needs both) and Singularity
        // (stop whenever you like, hence the Done button this mentions).
        const optional = targeting.min <= slot;
        const progress = `  [${slot + 1}/2]`;
        return optional
          ? ` — choose ${slot === 0 ? "up to 2 units" : `another ${who}`} for ${name}, or press Done${progress}`
          : ` — choose ${slot === 0 ? "a" : "an"} ${who} for ${name}${progress}`;
      }
      // A `unitList` card had NO case here and fell through to `default: null`,
      // so Falling Star and its four siblings asked for two-to-six targets in
      // total silence. See target-hint.ts.
      case "listTarget":
        return listTargetHint(pendingPlay.card, pendingChosenTargetCount(), pendingPlay.modeId);
      case "xAmount":
        return ` — how much rainbow Power for ${name}? It deals that much.`;
      case "battlefieldTarget":
        return ` — choose a battlefield for ${name}`;
      case "placement":
        // A move spell is not placing ITSELF, and saying "where to play Charm"
        // when the answer is where the enemy unit goes is how the step reads as
        // broken even once it exists.
        return cardMovesTarget(pendingPlay.card.defId)
          ? ` — choose where to move the unit ${name} targets`
          : ` — choose where to play ${name}`;
      case "additionalCost":
        return ` — exhaust a ready friendly unit to boost ${name}, or Decline`;
      case "equipment":
        return ` — choose an Equipment to attach, or Decline`;
      case "mode":
        return ` — choose one for ${name}`;
      default:
        return null;
    }
  }
  /**
   * What the armed card STILL owes, counted down as runes are proposed.
   *
   * The prompt used to be a fixed sentence explaining the controls, which said the
   * same thing whether you had paid nothing or everything but one pip. That is what
   * makes a stuck payment read as "clicking does nothing" — the player gets no
   * signal that a click counted, and no way to see that the remaining cost is a
   * Power pip their left-clicks can never satisfy.
   */
  function paymentOwedText(): string {
    const resolved = pendingResolvedAction;
    const pending = pendingPlay;
    if (!resolved || !pending) return "";
    const energy = resolved.payment.energyRunes.length - pending.payment.energyRunes.length;
    const power = resolved.payment.powerRunes.length - pending.payment.powerRunes.length;
    const rainbow = (resolved.payment.rainbowRunes ?? []).length - (pending.payment.rainbowRunes ?? []).length;
    const owed = [
      energy > 0 ? `${energy} Energy (left-click)` : null,
      power > 0 ? `${power} Power (right-click)` : null,
      // The `[Deflect]` tax, named as what it is. It has no click gesture of its
      // own — it is any domain and cannot double-duty with the card's own cost,
      // so there is nothing for a player to decide — but it MUST be visible, or
      // a card that will not cast gives no reason why.
      rainbow > 0 ? `${rainbow} rainbow for [Deflect] (Auto Pay)` : null,
    ].filter(Boolean);
    // Rule 164.2's double duty, said out loud. The SAME rune pays one Energy
    // and one Power, so a 2+2 card is paid by two runes clicked twice each —
    // and that is invisible from the board, because a rune already proposed
    // looks spent. Exactly the gap `listTargetHint` exists to close for
    // targets: a player who cannot see the rule reads the second click as a
    // mistake and reaches for Auto Pay instead.
    const bothHalves = resolved.payment.energyRunes.length > 0 && resolved.payment.powerRunes.length > 0;
    const doubleDuty = bothHalves ? " — the same rune can pay one of each" : "";
    return `${owed.join(" + ")} still owed${doubleDuty}, or Auto Pay`;
  }

  const pendingStillOwesPayment = Boolean(
    pendingResolvedAction &&
      pendingPlay &&
      (pendingResolvedAction.payment.energyRunes.length > pendingPlay.payment.energyRunes.length ||
        pendingResolvedAction.payment.powerRunes.length > pendingPlay.payment.powerRunes.length ||
        (pendingResolvedAction.payment.rainbowRunes ?? []).length >
          (pendingPlay.payment.rainbowRunes ?? []).length),
  );

  // FloatRune: tap a rune directly into the floating pool, independent of
  // casting anything — the real standalone action (confirmed against the
  // official rules and the Java oracle), distinct from the payment-mode
  // clicks above (which stage a proposal for an already-armed card).
  // Gated on `!pendingPlay` rather than `!pendingStillOwesPayment` — the
  // latter is also false while a card is armed but not yet resolved (e.g.
  // a targeted Spell before its target is picked), and floating then would
  // silently clear the armed card (applyAction always resets pendingPlay),
  // which would be a surprising regression, not a feature.
  const floatModeActive = canAct && !isGameOver && !pendingPlay;

  /**
   * Is the hand fan barred from opening on hover right now?
   *
   * The hand rests collapsed to a peek and expands only while hovered, so the
   * zones it overlays — your runes and your base — are visible by default. This
   * pins it shut on top of that, for the moments when those zones are active
   * CLICK TARGETS: an armed card being paid for or asking for a target, and a
   * selected unit waiting for its destination.
   *
   * The reason it is worth pinning rather than relying on the player not to hover:
   * the cursor has to TRAVEL to a rune tile, and the fan's peek lies along the
   * bottom of exactly that path. Springing open under a cursor on its way to a
   * payment target is the failure mode, and it is the one that would be blamed on
   * the layout rather than on the hover.
   */
  const handPinned = Boolean(pendingPlay) || selectedUnitIds.size > 0;

  function canFloatEnergy(rune: RuneCard): boolean {
    return legal.some((a) => a.type === "FloatRune" && a.runeId === rune.id && !a.forPower);
  }
  function canFloatPower(rune: RuneCard): boolean {
    return legal.some((a) => a.type === "FloatRune" && a.runeId === rune.id && a.forPower);
  }
  function floatEnergy(rune: RuneCard) {
    const action = legal.find((a): a is FloatRuneAction => a.type === "FloatRune" && a.runeId === rune.id && !a.forPower);
    if (action) applyAction(action);
  }
  function floatPower(rune: RuneCard) {
    const action = legal.find((a): a is FloatRuneAction => a.type === "FloatRune" && a.runeId === rune.id && a.forPower);
    if (action) applyAction(action);
  }

  // Series bookkeeping shared by the pregame screens, the header and the
  // end-of-game panel.
  const isBo3 = config.format === "bo3";
  const targetWins = winsNeeded(config.format);
  const seriesNote = isBo3
    ? `Game ${series.gameNumber} of 3 · ${series.humanGameWins}–${series.aiGameWins}`
    : undefined;
  // In a Best of 3 the MATCH is only over once someone has the needed game
  // wins; every earlier game end goes to SeriesPanel instead.
  const isMatchOver = !isBo3 || series.humanGameWins >= targetWins || series.aiGameWins >= targetWins;

  if (pregame === "selectBattlefield") {
    return (
      <BattlefieldSelect
        names={config.humanDeck.battlefieldNames}
        used={series.humanUsedBattlefields}
        seriesNote={seriesNote ?? ""}
        onSelect={handleBattlefieldSelect}
      />
    );
  }

  if (pregame === "mulligan") {
    return (
      <MulliganScreen
        hand={pregameState!.players[HUMAN_INDEX].hand}
        humanGoesFirst={pregameState!.firstPlayerIndex === HUMAN_INDEX}
        {...(seriesNote ? { seriesNote } : {})}
        onConfirm={handleMulliganConfirm}
      />
    );
  }

  return (
    <div className="board">
      {/* Cards travelling between your zones. Rendered at board level rather than
          inside a zone: a flight belongs to neither of its endpoints, and the
          layer is fixed-position anyway. */}
      <FlightLayer flights={flights} />

      <div className="header">
        <h1>Rift-Engine</h1>
        <span>
          Turn {state.turnNumber} · {state.phase} ·{" "}
          {/* Showdown and chain are ORTHOGONAL now that Action-speed casting
              exists (rule 310's four states), so the header composes them
              instead of picking one. It used to test the Showdown first and stop
              — which meant a spell on the chain inside a Showdown was never
              announced, and the line claimed "your Focus" when what the player
              actually held was chain priority. Whoever holds what is the single
              thing this line has to get right. */}
          {isShowdownOpen
            ? // A Showdown is a window, not necessarily a fight — naming which
              // kind is the difference between "you're about to lose units" and
              // "someone is walking onto an empty battlefield" (316.8.b.1).
              `${state.showdownKind === "Combat" ? "Combat" : "Non-Combat"} Showdown at ${showdownBattlefield?.name ?? "?"}${
                isChainPending
                  ? ` · spell pending — ${isHumanTurn ? "your" : "AI's"} priority`
                  : ` — ${isHumanTurn ? "your" : "AI's"} Focus`
              }`
            : isChainPending
              ? `Spell pending resolution — ${isHumanTurn ? "your" : "AI's"} priority`
              : isHumanTurn
                ? "Your turn"
                : "AI's turn"}
          {pendingHintText()}
          {pendingStillOwesPayment && ` — pay for ${pendingPlay!.card.name}: ${paymentOwedText()}`}
        </span>
        {/* Appended as its own element rather than folded into the line above:
            the existing turn/phase text is matched verbatim by the throwaway
            Playwright drivers, and there's no reason to move it. */}
        {seriesNote && <span className="header-series">{seriesNote}</span>}
        {unplayableNotice && <span className="header-notice">{unplayableNotice}</span>}
      </div>

      {isGameOver &&
        (isMatchOver ? (
          <RematchPanel
            didHumanWin={result.type === "GameOver" && result.winnerId === human.id}
            // Only a Best of 3 has a series score to report; in a Best of 1 the
            // game result already IS the match result.
            {...(isBo3 ? { seriesScore: `${series.humanGameWins}–${series.aiGameWins}` } : {})}
            onRematch={() => startNewMatch(config)}
            onQuickSwap={handleQuickSwap}
            onMainMenu={onMainMenu}
          />
        ) : (
          <SeriesPanel
            didHumanWinGame={result.type === "GameOver" && result.winnerId === human.id}
            humanGameWins={series.humanGameWins}
            aiGameWins={series.aiGameWins}
            winsNeeded={targetWins}
            onNextGame={handleNextGame}
            onMainMenu={onMainMenu}
          />
        ))}

      {awaitingHuman && (
        <DecisionPrompt
          state={state}
          decision={awaitingHuman}
          readOnly={spectate}
          onAnswer={(optionId) =>
            applyAction({ type: "AnswerDecision", playerIndex: HUMAN_INDEX, decisionId: awaitingHuman.id, optionId })
          }
        />
      )}

      {viewingTrash && (
        // Read-only browser, ordered oldest-first exactly as the pile is
        // stacked in state — cards are hoverable for their full text like any
        // other CardView, which is the whole point of being able to look.
        <ChoiceOverlay
          title={`${viewingTrash.label} (${viewingTrash.cards.length})`}
          subtitle="Trash piles are public information — either player can look at any time."
          cancelLabel="Close"
          onCancel={() => setViewingTrash(null)}
        >
          <div className="choice-overlay-cards">
            {viewingTrash.cards.map((card) => (
              <CardView key={card.instanceId} card={card} inPile />
            ))}
          </div>
        </ChoiceOverlay>
      )}

      {currentStep === "mode" && pendingPlay && (
        // "Choose one —". The buttons read the engine's own `CardMode.label`,
        // which is documented as "what the board's button says" and had until now
        // never been shown to anyone. Only modes with a live candidate are
        // offered: Rocket Barrage's gear mode is uncastable with no gear in play,
        // and a button that arms a card into a dead end is the same silent stall
        // this step exists to fix.
        <ChoiceOverlay title={`${pendingPlay.card.name} — choose one`} onCancel={() => setPendingPlay(null)}>
          <div className="choice-overlay-actions">
            {cardModesOf(pendingPlay.card)
              .filter((mode) => playCardActionsFor(pendingPlay.card.instanceId).some((a) => a.modeId === mode.id))
              .map((mode) => (
                <button key={mode.id} onClick={() => setPendingPlay({ ...pendingPlay, modeId: mode.id })}>
                  {mode.label}
                </button>
              ))}
          </div>
        </ChoiceOverlay>
      )}

      {currentStep === "trashCard" && pendingPlay && (
        <ChoiceOverlay title={`${pendingPlay.card.name} — choose a card from your trash`} onCancel={() => setPendingPlay(null)}>
          <div className="choice-overlay-cards">
            {pendingTrashOptions().map((card) => (
              <CardView
                key={card.instanceId}
                card={card}
                isSelectable
                isTargetable
                inPile
                onClick={() => setPendingPlay({ ...pendingPlay, trashCardInstanceId: card.instanceId })}
              />
            ))}
          </div>
        </ChoiceOverlay>
      )}

      {currentStep === "vision" && pendingPlay && (
        // [Vision] is literally "look at the top card of your Main Deck. You
        // may recycle it" — so this shows the actual card being decided about
        // (human.deck[0]), not a bare yes/no. Recycling sends it to the
        // BOTTOM of the deck (see applyVision, engine/unit-triggers.ts:57-65),
        // which is what the button says rather than the jargon "recycle."
        <ChoiceOverlay
          title={`${pendingPlay.card.name} — [Vision]`}
          subtitle={
            human.deck.length > 0
              ? "The top card of your deck. Keep it there, or send it to the bottom?"
              : "Your deck is empty — there's nothing to look at, but the choice is still yours to make."
          }
          onCancel={() => setPendingPlay(null)}
        >
          <div className="choice-overlay-cards">
            {human.deck[0] && <CardView card={human.deck[0]} />}
          </div>
          <div className="choice-overlay-actions">
            <button onClick={() => setPendingPlay({ ...pendingPlay, visionRecycle: false })}>Keep on top</button>
            <button onClick={() => setPendingPlay({ ...pendingPlay, visionRecycle: true })}>Recycle to bottom</button>
          </div>
        </ChoiceOverlay>
      )}

      <div className="board-main" ref={boardCardSize.boardRef} style={boardCardSize.style}>
        {/* The left rail: the AI's column, with YOUR pile cluster pinned beneath
            it in the board's bottom-left corner. They share a grid cell rather
            than the cluster floating over it, so the two can never overlap —
            see `.board-rail` in styles.css. */}
        <div className="board-rail">
          <PlayerSideColumn
            label="AI Opponent"
            points={ai.points}
            victoryScore={victoryScore(state)}
            xp={ai.xp}
            handCount={ai.hand.length}
            legend={ai.legend}
            champion={ai.championZone}
            deckCount={ai.deck.length}
            trashCount={ai.trash.length}
            onViewTrash={() => setViewingTrash({ label: "AI Opponent's trash", cards: ai.trash })}
            banishedCount={ai.banished.length}
            runeDeckCount={ai.runeDeck.length}
            activeGear={looseGear(ai)}
            isEnemy
          />

          {/* Your piles, pinned to the bottom of this rail — the board's
              bottom-left corner, level with and immediately left of your rune
              zone. See BoardPiles.tsx for the arrangement. */}
          <BoardPiles
            deckCount={human.deck.length}
            runeDeckCount={human.runeDeck.length}
            trashCount={human.trash.length}
            banishedCount={human.banished.length}
            onViewTrash={() => setViewingTrash({ label: "Your trash", cards: human.trash })}
          />
        </div>

        <div className="board-center">
          {/* Absolutely positioned inside this column and mounted only while
              there's something to show, so it adds no row and can't push the
              fixed-height board into overflow. Nothing on the board is
              draggable while the chain is closed (legalActions offers only
              PassFocus/FloatRune/ActivateAbility there), so this can't shadow
              a drop zone's hit-test either. */}
          {(chainItems.length > 0 || resolvingChainItem) && (
            <ChainView
              items={chainItems}
              resolving={resolvingChainItem}
              humanIndex={HUMAN_INDEX}
              chainPasses={state.chainPasses}
              isHumanResponse={isChainPending && canAct}
              onHoverItem={setHoveredChainIndex}
            />
          )}

          {/* The opponent's hand, as backs.
              NOTE: the state reaching this component is NOT masked — `ai.hand`
              holds the real card identities, and nothing in the web package
              masks anything (`BattlefieldView` carries the same "already masked"
              claim, and it is wrong there too). So rendering only the COUNT is
              not a restatement of what is available, it is the thing that keeps
              the opponent's hand secret. Nothing here may read the elements. */}
          <div
            className="ai-hand-fan"
            ref={aiHandFit.rowRef}
            style={{ "--row-fit-margin": `${aiHandFit.marginLeft}px` } as CSSProperties}
            title={`AI Opponent's hand: ${ai.hand.length} card${ai.hand.length === 1 ? "" : "s"}`}
          >
            {Array.from({ length: ai.hand.length }, (_, i) => (
              <span key={i} className="hand-back" aria-hidden />
            ))}
          </div>

          <div className="base-and-runes">
            <div className="zone card-zone">
              <div className="zone-label">AI base</div>
              {/* --row-count drives the fan in styles.css: the row tucks its cards
                  under each other rather than wrapping onto a line it has no room
                  for. Counted from the same arrays that render below, so it cannot
                  drift from what is on screen. */}
              {/* useRowFit measures this row and fans the cards to fit it, so the
                  row can never wrap onto a line it has no height for. The margin it
                  returns is the ONLY spacing — see the hook on why there is no gap. */}
              <div
                className="card-row fitted"
                ref={aiBaseFit.rowRef}
                style={{ "--row-fit-margin": `${aiBaseFit.marginLeft}px` } as CSSProperties}
              >
                <AnimatePresence>
                  {/* Gear sits in its controller's base and is public information —
                      it was previously only a count in the side rail, which made
                      the opponent's board state partly invisible. Not clickable:
                      you can never activate an opponent's ability. */}
                  {looseGear(ai).map((gear) => (
                    <CardView key={gear.instanceId} card={gear} isEnemy {...attachmentProps(gear)} />
                  ))}
                  {ai.baseUnits.map((unit) => (
                    // Clickable ONLY as the answer to a pending target step —
                    // there's nothing else you can ever do to an enemy unit at
                    // home. Cards whose text names no battlefield ("Deal 8 to
                    // a unit") reach here, so base is no longer a safe parking
                    // spot and the board has to let you say so.
                    <CardView
                      key={unit.instanceId}
                      card={unit}
                      isEnemy
                      {...attachmentProps(unit)}
                      isSelectable={isUnitLegalTarget(unit)}
                      isTargetable={isUnitLegalTarget(unit)}
                      isChainTargeted={chainTargets.units.has(unit.instanceId)}
                      isSelected={pendingChosenUnitIds().has(unit.instanceId)}
                      onClick={() => handleUnitClick(unit)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>
            <RuneZone runes={ai.channeled} />
          </div>

          {/* Column count is dynamic, not hardcoded to the current 2-per-1v1-match
              rule: a real card (Baron Nashor) can add a 3rd battlefield mid-game. */}
          <div className="battlefields" style={{ gridTemplateColumns: `repeat(${state.battlefields.length}, 1fr)` }}>
            {state.battlefields.map((bf) => (
              <BattlefieldView
                key={bf.id}
                battlefield={bf}
                attachmentProps={attachmentProps}
                human={human}
                ai={ai}
                humanIndex={HUMAN_INDEX}
                playableHiddenIds={playableHiddenIds}
                onPlayHidden={playHiddenCard}
                selectedUnitIds={selectedUnitIds}
                isMoveTarget={
                  canAct && (selectedUnitIds.size > 0 ? isGroupMoveTarget(bf.id) : Boolean(placementActionAt(bf.id)))
                }
                isTargetable={canAct && isBattlefieldLegalTarget(bf.id)}
                isChainTargeted={chainTargets.battlefields.has(bf.id)}
                isDragOver={dragOverZoneId === bf.id}
                isShowdownActive={state.showdownBattlefieldId === bf.id}
                isUnitTargetable={isUnitLegalTarget}
                isUnitChainTargeted={(unit) => chainTargets.units.has(unit.instanceId)}
                isFriendlySelectable={isFriendlyUnitSelectable}
                chosenUnitIds={pendingChosenUnitIds()}
                onUnitClick={handleUnitClick}
                onMoveHere={() => handleBattlefieldClick(bf.id)}
                canDragUnit={canDragUnit}
                onUnitDrag={(_unit, point) => trackDragZone(point)}
                onUnitDragEnd={(unit) => handleUnitDragEnd(unit)}
              />
            ))}
          </div>

          <div className="base-and-runes">
            <RuneZone
              runes={human.channeled}
              flightAnchor="runes"
              floating={{
                energy: human.floatingEnergy,
                power: human.floatingPower,
                rainbow: human.floatingRainbowPower,
                restrictedEnergy: human.restrictedSpellEnergy,
                restrictedPower: human.restrictedSpellPower,
              }}
              mode={
                pendingResolvedAction
                  ? {
                      kind: "payment",
                      proposedRainbowIds: pendingPlay!.payment.rainbowRunes ?? [],
                      proposedEnergyIds: pendingPlay!.payment.energyRunes,
                      proposedPowerIds: pendingPlay!.payment.powerRunes,
                      isRuneEligibleForEnergy,
                      isRuneEligibleForPower,
                      onRuneLeftClick: toggleEnergyRune,
                      onRuneRightClick: togglePowerRune,
                    }
                  : floatModeActive
                    ? {
                        kind: "float",
                        isRuneEligibleForEnergy: canFloatEnergy,
                        isRuneEligibleForPower: canFloatPower,
                        onRuneLeftClick: floatEnergy,
                        onRuneRightClick: floatPower,
                      }
                    : undefined
              }
            />
            <div
              className={`zone card-zone${dragOverZoneId === BASE_ZONE_ID ? " drag-over" : ""}${isBaseZoneTarget ? " selectable" : ""}`}
              data-dropzone-id={BASE_ZONE_ID}
              onClick={isBaseZoneTarget ? handleBaseZoneClick : undefined}
            >
              <div className="zone-label">Your base</div>
              <div
                className="card-row fitted"
                ref={yourBaseFit.rowRef}
                style={{ "--row-fit-margin": `${yourBaseFit.marginLeft}px` } as CSSProperties}
              >
                <AnimatePresence>
                  {/* Gear renders here rather than in a zone of its own: it lives
                      in your base by the rules, and `.board` is a fixed-height
                      100dvh column where a new row costs something real. */}
                  {looseGear(human).map((gear) => (
                    <CardView
                      key={gear.instanceId}
                      card={gear}
                      {...attachmentProps(gear)}
                      isSelectable={canActivate(gear.instanceId)}
                      isSelected={pendingAbility === gear.instanceId}
                      // The Equipment step (Relentless Pursuit). Gear was
                      // clickable ONLY to activate its own ability until now,
                      // which is why a card that targets one had no affordance
                      // at all. Targeting wins over activating while the step is
                      // open: the player has already armed a card, so a click on
                      // gear can only mean answering it.
                      isTargetable={isEquipmentLegalTarget(gear.instanceId)}
                      onClick={
                        isEquipmentLegalTarget(gear.instanceId)
                          ? () => handleEquipmentClick(gear.instanceId)
                          : canActivate(gear.instanceId)
                            ? () => handleActivateClick(gear.instanceId)
                            : undefined
                      }
                    />
                  ))}
                  {human.baseUnits.map((unit) => (
                    <CardView
                      key={unit.instanceId}
                      card={unit}
                      {...attachmentProps(unit)}
                      // Routed through handleUnitClick, not handleSelectUnit:
                      // Meditation's optional exhaust cost accepts a friendly
                      // unit in BASE as well as at a battlefield (unlike every
                      // battlefield-only "unit" target — see
                      // validate-play-card.ts:136-148), so a base unit has to
                      // be able to answer a pending step too.
                      isSelectable={canAct && isFriendlyUnitSelectable(unit)}
                      isTargetable={isUnitLegalTarget(unit)}
                      isChainTargeted={chainTargets.units.has(unit.instanceId)}
                      isSelected={selectedUnitIds.has(unit.instanceId) || pendingChosenUnitIds().has(unit.instanceId)}
                      onClick={() => handleUnitClick(unit)}
                      onDrag={canDragUnit(unit) ? trackDragZone : undefined}
                      onDragEnd={canDragUnit(unit) ? () => handleUnitDragEnd(unit) : undefined}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* Your hand — an OVERLAY on the bottom of this column, not a row in
              it. It has no `.zone` chrome and no label on purpose: it is not a
              board zone any more, and a label would only reintroduce the
              vertical cost the overlay exists to remove.

              It rests COLLAPSED to a peek of each card's top edge and expands
              only while hovered, so the runes and base it covers stay visible
              unless you actually reach for the hand. `pinned` bars even that —
              see `handPinned`, and `.hand-fan-layer` in styles.css for why the
              open/shut is a height change rather than the translate it looks
              like it should be. */}
          <div
            className={`hand-fan-layer${handPinned ? " pinned" : ""}`}
            data-flight-anchor="hand"
            ref={handFit.rowRef}
            // The scale is handed to CSS rather than declared there, because the
            // overlap above is computed from the same number in JS. One constant,
            // two consumers.
            style={
              {
                "--row-fit-margin": `${handFit.marginLeft}px`,
                "--hand-card-scale": HAND_CARD_SCALE,
              } as CSSProperties
            }
          >
            <AnimatePresence>
              {human.hand.map((card, index) => (
                <div
                  key={card.instanceId}
                  className="hand-fan-slot"
                  // The fan's arc. Written inline because it is per-index and
                  // per-count, which a stylesheet cannot express — the same
                  // reason the overlap itself is measured rather than declared.
                  style={fanTransform(index, human.hand.length)}
                >
                  <CardView
                    card={card}
                    isSelectable={canAct && isCardInteractable(card.instanceId)}
                    isUnplayable={canAct && !isCardInteractable(card.instanceId)}
                    isSelected={pendingPlay?.card.instanceId === card.instanceId}
                    onClick={() => handleHandCardClick(card.instanceId)}
                    onUnavailableClick={() => setUnplayableNotice(unplayableReason(card))}
                    unavailableNote={() => unplayableReason(card)}
                    onDrag={canAct && isCardInteractable(card.instanceId) ? trackDragZone : undefined}
                    onDragEnd={
                      canAct && isCardInteractable(card.instanceId) ? () => handleHandCardDragEnd(card.instanceId) : undefined
                    }
                  />
                </div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <PlayerSideColumn
          label="You"
          points={human.points}
          victoryScore={victoryScore(state)}
          xp={human.xp}
          legend={human.legend}
          isLegendSelectable={canActivate(human.legend.instanceId)}
          isLegendSelected={pendingAbility === human.legend.instanceId}
          onLegendClick={() => handleActivateClick(human.legend.instanceId)}
          champion={human.championZone}
          deckCount={human.deck.length}
          trashCount={human.trash.length}
          onViewTrash={() => setViewingTrash({ label: "Your trash", cards: human.trash })}
          banishedCount={human.banished.length}
          runeDeckCount={human.runeDeck.length}
          activeGear={looseGear(human)}
          pilesOnBoard
          legendAtBottom
          isChampionSelectable={canAct && Boolean(human.championZone && isCardInteractable(human.championZone.instanceId))}
          // Gated on canAct exactly like the hand above — without it the
          // champion was the one card that dimmed during the AI's turn, when
          // NOTHING is playable and singling it out says nothing useful.
          isChampionUnplayable={canAct && Boolean(human.championZone && !isCardInteractable(human.championZone.instanceId))}
          onChampionClick={() => human.championZone && handleHandCardClick(human.championZone.instanceId)}
          onChampionUnavailableClick={() =>
            human.championZone && setUnplayableNotice(unplayableReason(human.championZone))
          }
          championUnavailableNote={() => (human.championZone ? unplayableReason(human.championZone) : "")}
          onChampionDrag={
            canAct && human.championZone && isCardInteractable(human.championZone.instanceId) ? trackDragZone : undefined
          }
          onChampionDragEnd={
            canAct && human.championZone && isCardInteractable(human.championZone.instanceId)
              ? () => human.championZone && handleHandCardDragEnd(human.championZone.instanceId)
              : undefined
          }
        />
      </div>

      <div className="actions">
        {showPassFocus ? (
          <button onClick={handlePassFocus} disabled={!canAct || isGameOver}>
            Pass Focus
          </button>
        ) : (
          <button onClick={handlePass} disabled={!canAct || isGameOver}>
            Pass
          </button>
        )}
        {currentStep === "additionalCost" && <button onClick={declineAdditionalCost}>Decline</button>}
        {currentStep === "equipment" && <button onClick={declineEquipment}>Decline</button>}
        {/* X, as one button per affordable amount. A stepper would need its own
            bounds; the engine already enumerated exactly the amounts this pool
            can pay for, so the buttons ARE the candidate list. */}
        {currentStep === "xAmount" && pendingPlay && (
          <div className="chip-group x-amount-picker">
            {[...new Set(pendingCandidates().map((a) => a.xAmount))]
              .filter((x): x is number => x !== undefined)
              .sort((a, b) => a - b)
              .map((x) => (
                <button key={x} className="filter-chip" onClick={() => setPendingPlay({ ...pendingPlay, xAmount: x })}>
                  {x}
                </button>
              ))}
          </div>
        )}
        {canFinishTargeting() && (
          <button onClick={finishTargeting}>
            {pendingChosenTargetCount() === 0 ? "Choose no targets" : `Done (${pendingChosenTargetCount()})`}
          </button>
        )}
        {/* Every optional additional cost the armed card can pay — [Accelerate]
            (805), [Repeat] (820), a granted [Repeat] (820.1.c.2), and the single-named
            optional Power costs. Each is a real choice with a real price, and the
            UI used to make all of them silently except Accelerate: two candidates
            existed and whichever the engine listed first was taken.

            **[Repeat] was the worst of them, and it is why this is a loop now.**
            The board had no concept of it at all, so a human could not pay one —
            free or otherwise — which is what a playtest report about Ezreal -
            Prodigy's discount "doing nothing" turned out to be. The engine was
            right and there was no way to reach it from here.

            Each button renders only when the armed card genuinely has BOTH
            variants available right now, with every other settled choice held
            fixed — so a card with no repeat form shows no repeat button. */}
        {pendingPlay &&
          OPTIONAL_COST_FLAGS.map(({ key, on, off }) =>
            costFlagAlternative(key) ? (
              <button key={key} onClick={() => toggleCostFlag(key)}>
                {pendingPlay[key] ? off : on}
              </button>
            ) : null,
          )}
        {pendingStillOwesPayment && <button onClick={handleAutoPay}>Auto Pay</button>}
        {/* The explicit way out of an armed card, shown for as long as one IS
            armed. Backing out used to be folklore — click any unit and the
            fall-through in handleUnitClick would quietly clear it — which is
            exactly the accident-prone behavior that handler no longer has.
            An always-visible button is what makes ignoring stray clicks safe
            rather than trapping. Nothing has been submitted at this point
            (pendingPlay is a purely local proposal), so this can't strand
            anything mid-resolution. */}
        {pendingPlay && !modalStepActive && <button onClick={() => setPendingPlay(null)}>Cancel {pendingPlay.card.name}</button>}
        {/* A UNIT with an exhaust-cost ability reaches it from here rather than
            by clicking the card, because clicking a friendly unit already means
            "select it to move" and overloading that would make one of the two
            unreachable. Gear has no such conflict — it can't move — so gear is
            clicked directly in the base zone. Appears only when exactly one unit
            is selected and the engine is currently offering its ability. */}
        {activatableSelectedUnit() && (
          <button onClick={() => handleActivateClick(activatableSelectedUnit()!.instanceId)}>
            Activate {activatableSelectedUnit()!.name}
          </button>
        )}
        {/* Hiding is a separate ACTION from playing (rule 811: "Hide is not a
            subset of Play"), so it gets its own button rather than a mode on the
            card click. Offered per battlefield, because which one you hide at
            decides where the card can later be played from and what it may
            target. */}
        {hideOptions().map((hide) => (
          <button key={hide.battlefieldId} onClick={() => applyAction(hide)}>
            Hide {hide.card.name} at {state.battlefields.find((b) => b.id === hide.battlefieldId)?.name}
          </button>
        ))}
        {pendingAbility !== null && (
          <button onClick={() => setPendingAbility(null)}>Cancel {activatingPermanentName()}</button>
        )}
      </div>
    </div>
  );
}
