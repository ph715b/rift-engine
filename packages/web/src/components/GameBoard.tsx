import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  beginFirstTurn,
  cardHasOptionalExhaustCost,
  cardNeedsTarget,
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
  targetingForAnyCard,
  timingRejection,
  unitTriggerHasVisionChoice,
  type CardInstance,
  type ChainItemDescription,
  type DeckList,
  type FloatRuneAction,
  type GameState,
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
import { RuneZone } from "./RuneZone.js";
import { MulliganScreen } from "./MulliganScreen.js";
import { ChainView } from "./ChainView.js";
import { BattlefieldSelect } from "./BattlefieldSelect.js";
import { SeriesPanel } from "./SeriesPanel.js";

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
  targetUnitInstanceId?: string;
  /** Gentlemen's Duel's second ("unitPair") target — always chosen after
   *  `targetUnitInstanceId`, never before. */
  secondTargetUnitInstanceId?: string;
  targetBattlefieldId?: string;
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
  payment: RunePayment;
}

/** The one choice `pendingPlay` is currently waiting on, in the fixed order
 *  `pendingStep()` walks. Every board-click step comes before every modal
 *  (ChoiceOverlay) step, so a modal can never cover a zone the player still
 *  has to click — no card in the current pool combines the two, and this
 *  ordering keeps that safe if one ever does. */
type PendingStep = "firstTarget" | "secondTarget" | "battlefieldTarget" | "placement" | "additionalCost" | "trashCard" | "vision";

/** Finds the drop zone (a battlefield id, or BASE_ZONE_ID) under a viewport
 *  point, via the `data-dropzone-id` attributes BattlefieldView/the base
 *  zone carry — simpler and more robust than manual rect math, since it
 *  goes through the browser's own hit-testing (z-index, overlap, etc.). */
function dropZoneAt(point: DragPoint): string | null {
  const el = document.elementFromPoint(point.x, point.y);
  return el?.closest("[data-dropzone-id]")?.getAttribute("data-dropzone-id") ?? null;
}

/** Where the pregame currently is. `selectBattlefield` only ever occurs in a
 *  Best of 3 (rule 487.2's per-game selection); a Best of 1 rolls instead
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
   *  from selection for the rest of the match (rule 487.3). Tracked per side
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
  // Match-level state, above any single game. A Best of 1 leaves it at zeroes
  // and never reads it; a Best of 3 needs all of it — the score to know when
  // the MATCH is over (rule 487.4's two game wins) and the used-battlefield
  // lists to honour 487.3's elimination on the next game's selection.
  const [series, setSeries] = useState<SeriesState>(() => freshSeries());
  // Which pregame step is showing, or "playing" once the board is live. Best
  // of 3 adds a battlefield selection ahead of the mulligan — rule 487.2 puts
  // that selection in Setup, so it runs before EVERY game, not only between
  // them.
  const [pregame, setPregame] = useState<PregameStep>(initialConfig.format === "bo3" ? "selectBattlefield" : "mulligan");
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

  // The chain, newest first — i.e. in resolution order (rule 343). Rendered by
  // ChainView; before this existed, `state.spellChain` reached the UI nowhere
  // at all.
  const chainItems = useMemo(() => describeChain(state), [state]);

  const legal = useMemo(() => (isHumanTurn && !isGameOver ? legalActions(state) : []), [state, isHumanTurn, isGameOver]);

  // A question the engine has stopped to ask, and it is yours to answer. It
  // outranks everything else on screen: while one is open, `legalActions` offers
  // nothing but its answers, so every other affordance on the board is already
  // dead and the panel is the only thing that can move the game on.
  //
  // `isHumanTurn` covers the ownership check on its own, because actingPlayerIndex
  // now yields whoever was ASKED — which for Cull the Weak is the player whose
  // turn it isn't.
  const awaitingHuman = isHumanTurn && !isGameOver ? pendingDecision(state) : undefined;

  function applyAction(action: PlayerAction) {
    setGame(submit(state, action));
    setSelectedUnitIds(new Set());
    setPendingPlay(null);
    setPendingAbility(null);
    setDragOverZoneId(null);
    setUnplayableNotice(null);
  }

  // The AI's turn plays itself, one action at a time, with a short delay for feel.
  useEffect(() => {
    if (isHumanTurn || isGameOver) return;
    const timer = setTimeout(() => {
      const action = chooseAction(state);
      setGame(submit(state, action));
    }, AI_MOVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, isHumanTurn, isGameOver]);

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
  function cardHasDestination(card: CardInstance): boolean {
    return card.kind === "Unit" || (card.kind === "Spell" && cardPlacesTokens(card.defId));
  }

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
   *  unit-triggers.ts's VISION_UNIT_DEF_IDS and card-effects.ts's
   *  OPTIONAL_EXHAUST_COST_DEF_IDS), and the `card.kind` guards here mirror
   *  exactly how legal-actions.ts:196/208 gates its own fan-out for them. */
  function cardNeedsChoice(card: CardInstance): boolean {
    return (
      cardNeedsTarget(card) ||
      (card.kind === "Unit" && unitTriggerHasVisionChoice(card.defId)) ||
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
    const targeting = targetingForAnyCard(card);
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
  function pendingSlotsAreSymmetric(card: CardInstance): boolean {
    const targeting = targetingForAnyCard(card);
    return targeting.kind === "unitSlots" && targeting.slots[0] === targeting.slots[1];
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
    const symmetric = pendingSlotsAreSymmetric(pending.card);
    return playCardActionsFor(pending.card.instanceId).filter((a) => {
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
    const targeting = targetingForAnyCard(pending.card);
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
    if (
      (targeting.kind === "unit" || targeting.kind === "unitSlots") &&
      pending.targetUnitInstanceId === undefined &&
      stillChoosing
    ) {
      if (offers("targetUnitInstanceId")) return "firstTarget";
    }
    if (targeting.kind === "unitSlots" && pending.secondTargetUnitInstanceId === undefined && stillChoosing) {
      if (offers("secondTargetUnitInstanceId")) return "secondTarget";
    }
    if (targeting.kind === "battlefield" && pending.targetBattlefieldId === undefined) {
      if (offers("targetBattlefieldId")) return "battlefieldTarget";
    }
    if (unitNeedsPlacement(candidates) && pending.destinationBattlefieldId === undefined) return "placement";
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
    if (pending.card.kind === "Unit" && unitTriggerHasVisionChoice(pending.card.defId) && pending.visionRecycle === undefined) {
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
    if (pendingSlotsAreSymmetric(pending.card)) {
      const chosen = [...targetSetOf(pending)].sort();
      const candidate = [...targetSetOf(a)].sort();
      if (chosen.length !== candidate.length || chosen.some((id, i) => id !== candidate[i])) return false;
      return (
        (a.targetBattlefieldId ?? null) === (pending.targetBattlefieldId ?? null) &&
        (a.trashCardInstanceId ?? null) === (pending.trashCardInstanceId ?? null) &&
        (a.visionRecycle ?? null) === (pending.visionRecycle ?? null) &&
        (a.additionalCostUnitInstanceId ?? null) === (pending.additionalCostUnitInstanceId ?? null) &&
        (a.destinationBattlefieldId ?? BASE_ZONE_ID) === (pending.destinationBattlefieldId ?? BASE_ZONE_ID) &&
        (a.fromHiddenBattlefieldId ?? null) === (pending.fromHiddenBattlefieldId ?? null)
      );
    }
    return (
      (a.targetUnitInstanceId ?? null) === (pending.targetUnitInstanceId ?? null) &&
      (a.secondTargetUnitInstanceId ?? null) === (pending.secondTargetUnitInstanceId ?? null) &&
      (a.targetBattlefieldId ?? null) === (pending.targetBattlefieldId ?? null) &&
      (a.trashCardInstanceId ?? null) === (pending.trashCardInstanceId ?? null) &&
      (a.visionRecycle ?? null) === (pending.visionRecycle ?? null) &&
      (a.additionalCostUnitInstanceId ?? null) === (pending.additionalCostUnitInstanceId ?? null) &&
      (a.destinationBattlefieldId ?? BASE_ZONE_ID) === (pending.destinationBattlefieldId ?? BASE_ZONE_ID) &&
      (a.fromHiddenBattlefieldId ?? null) === (pending.fromHiddenBattlefieldId ?? null)
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
    return isHumanTurn && !unit.exhausted;
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
    setPendingPlay((prev) =>
      prev?.card.instanceId === first.card.instanceId ? null : { card: first.card, payment: { energyRunes: [], powerRunes: [] } },
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
    const slot = pendingUnitSlot();
    if (!slot) return false;
    // Symmetric slots: a unit qualifies if any live candidate names it at ALL,
    // in either slot — the deduped fan-out may hold the pair in the opposite
    // order, and requiring a slot-position match would leave the second click
    // unhighlighted (and inert) exactly half the time.
    if (pendingPlay && slot !== "additionalCostUnitInstanceId" && pendingSlotsAreSymmetric(pendingPlay.card)) {
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

  /** Does this permanent have an exhaust-cost ability the human can use right
   *  now? Asked of `legal` rather than of the registry, so "Ready", "you control
   *  it", "the Action phase" and "a legal target exists" are all answered by the
   *  engine's own enumeration instead of being re-derived here. */
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

  /** How many targets this card MUST have — 0 for the "up to two" cards,
   *  which is what makes stopping early legal at all. */
  function pendingMinTargets(): number {
    if (!pendingPlay) return 0;
    const targeting = targetingForAnyCard(pendingPlay.card);
    return targeting.kind === "unitSlots" ? targeting.min : targeting.kind === "unit" ? 1 : 0;
  }

  /** Can the player stop picking targets right now — i.e. has an "up to N"
   *  card already got at least its minimum? Drives the Done button. */
  function canFinishTargeting(): boolean {
    const step = pendingStep();
    if (step !== "firstTarget" && step !== "secondTarget") return false;
    return pendingChosenTargetCount() >= pendingMinTargets();
  }

  function pendingChosenTargetCount(): number {
    if (!pendingPlay) return 0;
    return [pendingPlay.targetUnitInstanceId, pendingPlay.secondTargetUnitInstanceId].filter((id) => id !== undefined).length;
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

  /** Fills whatever's still owed using the remaining (not-yet-proposed)
   *  channeled pool. The remainder can be infeasible even though the full
   *  pool would've worked (e.g. the player manually claimed the only
   *  domain-matching rune for Energy, leaving nothing for a Power slot) —
   *  computeAutoPayment correctly returns null there, and this simply no-ops
   *  rather than erroring. */
  function handleAutoPay() {
    if (!pendingPlay || pendingPlay.card.kind === "Legend") return;
    const required = pendingLegalAction();
    if (!required) return;
    const remainingEnergy = required.payment.energyRunes.length - pendingPlay.payment.energyRunes.length;
    const remainingPower = required.payment.powerRunes.length - pendingPlay.payment.powerRunes.length;
    if (remainingEnergy <= 0 && remainingPower <= 0) return;

    const proposedIds = new Set([...pendingPlay.payment.energyRunes, ...pendingPlay.payment.powerRunes]);
    const remainingPool = human.channeled.filter((r) => !proposedIds.has(r.id));
    const fill = computeAutoPayment(
      remainingPool,
      Math.max(remainingEnergy, 0),
      Math.max(remainingPower, 0),
      pendingPlay.card.powerDomain,
      pendingPlay.card.powerDomainAlt,
    );
    if (!fill) return; // infeasible remainder — no-op

    setPendingPlay((prev) =>
      prev
        ? {
            ...prev,
            payment: {
              energyRunes: [...prev.payment.energyRunes, ...fill.energyRunes],
              powerRunes: [...prev.payment.powerRunes, ...fill.powerRunes],
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
      pendingPlay.payment.powerRunes.length !== resolved.payment.powerRunes.length
    ) {
      return;
    }
    // Every optional field is spread in only when actually set: the engine
    // distinguishes absent from present for several of them (an absent
    // additionalCostUnitInstanceId means "declined the cost," an absent
    // destinationBattlefieldId means "base"), so writing them unconditionally
    // as undefined would not be equivalent.
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: HUMAN_INDEX,
      card: pendingPlay.card,
      payment: pendingPlay.payment,
      ...(pendingPlay.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: pendingPlay.targetUnitInstanceId } : {}),
      ...(pendingPlay.secondTargetUnitInstanceId !== undefined
        ? { secondTargetUnitInstanceId: pendingPlay.secondTargetUnitInstanceId }
        : {}),
      ...(pendingPlay.targetBattlefieldId !== undefined ? { targetBattlefieldId: pendingPlay.targetBattlefieldId } : {}),
      ...(pendingPlay.trashCardInstanceId !== undefined ? { trashCardInstanceId: pendingPlay.trashCardInstanceId } : {}),
      ...(pendingPlay.visionRecycle !== undefined ? { visionRecycle: pendingPlay.visionRecycle } : {}),
      ...(pendingPlay.additionalCostUnitInstanceId !== undefined
        ? { additionalCostUnitInstanceId: pendingPlay.additionalCostUnitInstanceId }
        : {}),
      ...(pendingPlay.destinationBattlefieldId !== undefined && pendingPlay.destinationBattlefieldId !== BASE_ZONE_ID
        ? { destinationBattlefieldId: pendingPlay.destinationBattlefieldId }
        : {}),
    };
    applyAction(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay, legal]);

  const isBaseZoneTarget =
    isHumanTurn && (selectedUnitIds.size > 0 ? isGroupRecallTarget() : Boolean(placementActionAt(BASE_ZONE_ID)));

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
    setPregame(newConfig.format === "bo3" ? "selectBattlefield" : "mulligan");
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

  /** Rule 487.2: the human presents one of their three battlefields, and the
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

  /** Rule 487.4's between-games reset: bank the game win, retire the
   *  battlefields that were just played (487.3), and set up the next game.
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
        const targeting = targetingForAnyCard(pendingPlay.card);
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
      case "battlefieldTarget":
        return ` — choose a battlefield for ${name}`;
      case "placement":
        return ` — choose where to play ${name}`;
      case "additionalCost":
        return ` — exhaust a ready friendly unit to boost ${name}, or Decline`;
      default:
        return null;
    }
  }
  const pendingStillOwesPayment = Boolean(
    pendingResolvedAction &&
      pendingPlay &&
      (pendingResolvedAction.payment.energyRunes.length > pendingPlay.payment.energyRunes.length ||
        pendingResolvedAction.payment.powerRunes.length > pendingPlay.payment.powerRunes.length),
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
  const floatModeActive = isHumanTurn && !isGameOver && !pendingPlay;

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
              // "someone is walking onto an empty battlefield" (317.1).
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
          {pendingStillOwesPayment &&
            ` — pay for ${pendingPlay!.card.name}: left-click a rune for Energy, right-click for Power (or Auto Pay)`}
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

      <div className="board-main">
        <PlayerSideColumn
          label="AI Opponent"
          points={ai.points}
          handCount={ai.hand.length}
          legend={ai.legend}
          champion={ai.championZone}
          trashCount={ai.trash.length}
          onViewTrash={() => setViewingTrash({ label: "AI Opponent's trash", cards: ai.trash })}
          banishedCount={ai.banished.length}
          runeDeckCount={ai.runeDeck.length}
          activeGear={ai.activeGear}
          isEnemy
        />

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
              isHumanResponse={isChainPending && isHumanTurn}
              onHoverItem={setHoveredChainIndex}
            />
          )}

          <div className="base-and-runes">
            <div className="zone card-zone">
              <div className="zone-label">AI base</div>
              <div className="card-row">
                <AnimatePresence>
                  {/* Gear sits in its controller's base and is public information —
                      it was previously only a count in the side rail, which made
                      the opponent's board state partly invisible. Not clickable:
                      you can never activate an opponent's ability. */}
                  {ai.activeGear.map((gear) => (
                    <CardView key={gear.instanceId} card={gear} isEnemy />
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
                human={human}
                ai={ai}
                humanIndex={HUMAN_INDEX}
                playableHiddenIds={playableHiddenIds}
                onPlayHidden={playHiddenCard}
                selectedUnitIds={selectedUnitIds}
                isMoveTarget={
                  isHumanTurn && (selectedUnitIds.size > 0 ? isGroupMoveTarget(bf.id) : Boolean(placementActionAt(bf.id)))
                }
                isTargetable={isHumanTurn && isBattlefieldLegalTarget(bf.id)}
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
              mode={
                pendingResolvedAction
                  ? {
                      kind: "payment",
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
              <div className="card-row">
                <AnimatePresence>
                  {/* Gear renders here rather than in a zone of its own: it lives
                      in your base by the rules, and `.board` is a fixed-height
                      100dvh column where a new row costs something real. */}
                  {human.activeGear.map((gear) => (
                    <CardView
                      key={gear.instanceId}
                      card={gear}
                      isSelectable={canActivate(gear.instanceId)}
                      isSelected={pendingAbility === gear.instanceId}
                      onClick={canActivate(gear.instanceId) ? () => handleActivateClick(gear.instanceId) : undefined}
                    />
                  ))}
                  {human.baseUnits.map((unit) => (
                    <CardView
                      key={unit.instanceId}
                      card={unit}
                      // Routed through handleUnitClick, not handleSelectUnit:
                      // Meditation's optional exhaust cost accepts a friendly
                      // unit in BASE as well as at a battlefield (unlike every
                      // battlefield-only "unit" target — see
                      // validate-play-card.ts:136-148), so a base unit has to
                      // be able to answer a pending step too.
                      isSelectable={isHumanTurn && isFriendlyUnitSelectable(unit)}
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

          <div className="zone card-zone">
            <div className="zone-label">Your hand</div>
            <div className="card-row">
              <AnimatePresence>
                {human.hand.map((card) => (
                  <CardView
                    key={card.instanceId}
                    card={card}
                    isSelectable={isHumanTurn && isCardInteractable(card.instanceId)}
                    isUnplayable={isHumanTurn && !isCardInteractable(card.instanceId)}
                    isSelected={pendingPlay?.card.instanceId === card.instanceId}
                    onClick={() => handleHandCardClick(card.instanceId)}
                    onUnavailableClick={() => setUnplayableNotice(unplayableReason(card))}
                    unavailableNote={() => unplayableReason(card)}
                    onDrag={isHumanTurn && isCardInteractable(card.instanceId) ? trackDragZone : undefined}
                    onDragEnd={
                      isHumanTurn && isCardInteractable(card.instanceId) ? () => handleHandCardDragEnd(card.instanceId) : undefined
                    }
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <PlayerSideColumn
          label="You"
          points={human.points}
          legend={human.legend}
          champion={human.championZone}
          trashCount={human.trash.length}
          onViewTrash={() => setViewingTrash({ label: "Your trash", cards: human.trash })}
          banishedCount={human.banished.length}
          runeDeckCount={human.runeDeck.length}
          activeGear={human.activeGear}
          legendAtBottom
          isChampionSelectable={isHumanTurn && Boolean(human.championZone && isCardInteractable(human.championZone.instanceId))}
          // Gated on isHumanTurn exactly like the hand above — without it the
          // champion was the one card that dimmed during the AI's turn, when
          // NOTHING is playable and singling it out says nothing useful.
          isChampionUnplayable={isHumanTurn && Boolean(human.championZone && !isCardInteractable(human.championZone.instanceId))}
          onChampionClick={() => human.championZone && handleHandCardClick(human.championZone.instanceId)}
          onChampionUnavailableClick={() =>
            human.championZone && setUnplayableNotice(unplayableReason(human.championZone))
          }
          championUnavailableNote={() => (human.championZone ? unplayableReason(human.championZone) : "")}
          onChampionDrag={
            isHumanTurn && human.championZone && isCardInteractable(human.championZone.instanceId) ? trackDragZone : undefined
          }
          onChampionDragEnd={
            isHumanTurn && human.championZone && isCardInteractable(human.championZone.instanceId)
              ? () => human.championZone && handleHandCardDragEnd(human.championZone.instanceId)
              : undefined
          }
        />
      </div>

      <div className="actions">
        {showPassFocus ? (
          <button onClick={handlePassFocus} disabled={!isHumanTurn || isGameOver}>
            Pass Focus
          </button>
        ) : (
          <button onClick={handlePass} disabled={!isHumanTurn || isGameOver}>
            Pass
          </button>
        )}
        {currentStep === "additionalCost" && <button onClick={declineAdditionalCost}>Decline</button>}
        {canFinishTargeting() && (
          <button onClick={finishTargeting}>
            {pendingChosenTargetCount() === 0 ? "Choose no targets" : `Done (${pendingChosenTargetCount()})`}
          </button>
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
