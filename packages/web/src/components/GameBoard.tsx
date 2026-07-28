import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  chooseAction,
  computeAutoPayment,
  effectForCard,
  legalActions,
  requiresTarget,
  startGame,
  submit,
  type CardInstance,
  type DeckList,
  type PlayCardAction,
  type PlayerAction,
  type RuneCard,
  type RunePayment,
  type UnitInstance,
} from "@rift-engine/engine";
import { createNewGame, type MatchConfig } from "../game-setup.js";
import { CardView, type DragPoint } from "./CardView.js";
import { BattlefieldView } from "./BattlefieldView.js";
import { RematchPanel } from "./RematchPanel.js";
import { PlayerSideColumn } from "./PlayerSideColumn.js";

const HUMAN_INDEX = 0;
const AI_INDEX = 1;
const AI_MOVE_DELAY_MS = 650;
const BASE_ZONE_ID = "base";

/** A hand/champion card armed for play but not yet fully resolved — covers
 *  three composable phases in order (target/destination, THEN payment),
 *  matching the header hint text's own established mental model:
 *   1. `targetUnitInstanceId`/`destinationBattlefieldId` start undefined and
 *      get filled in by clicking a legal target unit / battlefield / base
 *      zone — `destinationBattlefieldId` uses BASE_ZONE_ID as an explicit
 *      "resolved to base" sentinel, distinct from "not yet resolved"
 *      (plain `undefined`), so a Unit that can go to more than one place
 *      isn't silently treated as already-resolved-to-base before any click.
 *   2. Once resolved (or immediately, for a card needing neither), manual
 *      rune payment begins: `payment` starts empty and fills via rune-tile
 *      clicks or Auto Pay until it exactly matches the effective (floating-
 *      reduced) cost already known from the matching `legal` candidate —
 *      at which point an effect auto-submits and clears this.
 *  Switching to a different hand card discards this whole object rather
 *  than swapping just `.card`, so a rune proposal built for one card can
 *  never leak into another's submission. */
interface PendingPlay {
  card: CardInstance;
  targetUnitInstanceId?: string;
  destinationBattlefieldId?: string;
  payment: RunePayment;
}

/** Finds the drop zone (a battlefield id, or BASE_ZONE_ID) under a viewport
 *  point, via the `data-dropzone-id` attributes BattlefieldView/the base
 *  zone carry — simpler and more robust than manual rect math, since it
 *  goes through the browser's own hit-testing (z-index, overlap, etc.). */
function dropZoneAt(point: DragPoint): string | null {
  const el = document.elementFromPoint(point.x, point.y);
  return el?.closest("[data-dropzone-id]")?.getAttribute("data-dropzone-id") ?? null;
}

interface GameBoardProps {
  initialConfig: MatchConfig;
  onMainMenu: () => void;
}

export function GameBoard({ initialConfig, onMainMenu }: GameBoardProps) {
  const [config, setConfig] = useState(initialConfig);
  const [{ state, result }, setGame] = useState(() => startGame(createNewGame(config, Date.now())));
  const [selectedUnit, setSelectedUnit] = useState<UnitInstance | null>(null);
  // The hand/champion card "armed" for play — set instead of playing
  // immediately whenever the card needs a target, a placement choice, or a
  // nonzero (post-floating) rune payment. A card needing none of those still
  // plays instantly on click, unchanged from before any of this existed.
  const [pendingPlay, setPendingPlay] = useState<PendingPlay | null>(null);
  const [dragOverZoneId, setDragOverZoneId] = useState<string | null>(null);
  // Tracks the last drop zone seen during the drag (from onDrag, updated on
  // every pointer move) — read at drop time instead of recomputing there.
  // onDragEnd fires as Framer Motion is already reverting the dragged
  // element's whileDrag styles (including the pointerEvents:none that makes
  // hit-testing find what's UNDER the card rather than the card itself), so
  // recomputing document.elementFromPoint at that exact moment is a race;
  // the continuously-updated ref isn't.
  const lastDragZoneRef = useRef<string | null>(null);

  // The "acting player" — normally the active player, but during an open
  // Showdown it's whoever holds Focus, and while the chain is closed (a
  // spell pending resolution) it's whoever holds chain priority instead —
  // either can be either player regardless of whose turn it nominally is
  // (mirrors GameState.java's actingPlayer() precedence: chain closed ->
  // chainPriority, Showdown -> focusHolder, else -> activePlayerIndex).
  const actingPlayerIndex = !state.chainOpen
    ? state.chainPriority
    : state.turnState === "Showdown"
      ? state.focusHolder
      : state.activePlayerIndex;
  const isHumanTurn = actingPlayerIndex === HUMAN_INDEX;
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

  const legal = useMemo(() => (isHumanTurn && !isGameOver ? legalActions(state) : []), [state, isHumanTurn, isGameOver]);

  function applyAction(action: PlayerAction) {
    setGame((prev) => submit(prev.state, action));
    setSelectedUnit(null);
    setPendingPlay(null);
    setDragOverZoneId(null);
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
    return playCardActionsFor(cardInstanceId).length > 0;
  }

  /** True for a Unit with more than one distinct legal destination (base
   *  plus one or more "reinforce" battlefields it already occupies) — keyed
   *  off distinct destinations, not a raw action count, so a future
   *  same-destination cost variant (e.g. Accelerate) can never falsely
   *  trigger arming for a Unit that only has one real place to go. */
  function unitNeedsPlacement(actions: PlayCardAction[]): boolean {
    if (actions[0]?.card.kind !== "Unit") return false;
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

  /** The one action to submit immediately on click/drag — only when the
   *  card doesn't need any choice: not a targeted Spell (e.g. Incinerate),
   *  not a Unit with more than one legal destination, and not a nonzero
   *  rune payment. Any of those returns undefined here even though the card
   *  IS interactable, since clicking it should arm it instead (see
   *  handleHandCardClick). */
  function immediatePlayAction(cardInstanceId: string): PlayCardAction | undefined {
    const actions = playCardActionsFor(cardInstanceId);
    const [first] = actions;
    if (!first) return undefined;
    if (requiresTarget(effectForCard(first.card))) return undefined;
    if (unitNeedsPlacement(actions)) return undefined;
    if (actionNeedsPayment(first)) return undefined;
    return first;
  }

  /** The armed Unit's PlayCardAction for a specific destination — `"base"`
   *  for the base-play candidate, a battlefield id for a reinforce
   *  candidate — or undefined if that destination isn't actually legal for
   *  the currently-armed card. */
  function placementActionAt(destination: string): PlayCardAction | undefined {
    if (!pendingPlay) return undefined;
    return legal.find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" &&
        a.card.instanceId === pendingPlay.card.instanceId &&
        (a.destinationBattlefieldId ?? BASE_ZONE_ID) === destination,
    );
  }

  function pendingNeedsTarget(): boolean {
    return Boolean(pendingPlay) && requiresTarget(effectForCard(pendingPlay!.card));
  }

  function pendingNeedsPlacement(): boolean {
    if (!pendingPlay) return false;
    return unitNeedsPlacement(playCardActionsFor(pendingPlay.card.instanceId));
  }

  /** The specific `legal` candidate `pendingPlay` currently resolves to —
   *  undefined until its target/destination (whichever it needs, if any)
   *  has actually been chosen. Once defined, its `payment` list lengths ARE
   *  the effective (floating-reduced) counts still owed — the manual
   *  payment step's completion target. */
  function pendingLegalAction(): PlayCardAction | undefined {
    if (!pendingPlay) return undefined;
    if (pendingNeedsTarget() && pendingPlay.targetUnitInstanceId === undefined) return undefined;
    if (pendingNeedsPlacement() && pendingPlay.destinationBattlefieldId === undefined) return undefined;
    return legal.find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" &&
        a.card.instanceId === pendingPlay.card.instanceId &&
        (a.targetUnitInstanceId ?? null) === (pendingPlay.targetUnitInstanceId ?? null) &&
        (a.destinationBattlefieldId ?? BASE_ZONE_ID) === (pendingPlay.destinationBattlefieldId ?? BASE_ZONE_ID),
    );
  }

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

  function handleHandCardClick(cardInstanceId: string) {
    const immediate = immediatePlayAction(cardInstanceId);
    if (immediate) {
      applyAction(immediate);
      return;
    }
    const [first] = playCardActionsFor(cardInstanceId);
    if (!first) return;
    // A card needing a choice (target, placement, and/or payment) — arm it
    // (toggle off if clicking the same one again). Clears `selectedUnit` so
    // at most one of the two "armed" states is ever live — otherwise a
    // stale selected unit could silently shadow this card's placement the
    // next time a battlefield/base-zone is clicked.
    setSelectedUnit(null);
    setPendingPlay((prev) =>
      prev?.card.instanceId === first.card.instanceId ? null : { card: first.card, payment: { energyRunes: [], powerRunes: [] } },
    );
  }

  function handleSelectUnit(unit: UnitInstance) {
    setPendingPlay(null);
    setSelectedUnit((prev) => (prev?.instanceId === unit.instanceId ? null : unit));
  }

  function isUnitLegalTarget(unit: UnitInstance): boolean {
    if (!pendingPlay) return false;
    return legal.some(
      (a) => a.type === "PlayCard" && a.card.instanceId === pendingPlay.card.instanceId && a.targetUnitInstanceId === unit.instanceId,
    );
  }

  /** Unified click handler for any unit at a battlefield, friendly or enemy.
   *  If a targeted spell is armed and this unit is a legal target, resolves
   *  the target onto `pendingPlay` (which may still need a payment step
   *  afterward, handled by the auto-submit effect below); otherwise falls
   *  through to ordinary move-selection. */
  function handleUnitClick(unit: UnitInstance) {
    if (pendingPlay) {
      const isTarget = legal.some(
        (a) => a.type === "PlayCard" && a.card.instanceId === pendingPlay.card.instanceId && a.targetUnitInstanceId === unit.instanceId,
      );
      if (isTarget) {
        setPendingPlay({ ...pendingPlay, targetUnitInstanceId: unit.instanceId });
        return;
      }
    }
    handleSelectUnit(unit);
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
   *  domain-gated (or any domain, for a rainbow cost), Ready or Exhausted,
   *  and only when the effective Power cost is actually nonzero. A null
   *  powerDomain only ever means "no Power cost" in this card pool (never a
   *  real rainbow cost), so without the nonzero check every rune would
   *  falsely read as Power-eligible for a plain Energy-only card. */
  function isRuneEligibleForPower(rune: RuneCard): boolean {
    if (!pendingPlay || pendingPlay.card.kind === "Legend") return false;
    const domain = pendingPlay.card.powerDomain;
    if (domain !== null && rune.domain !== domain) return false;
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
    const fill = computeAutoPayment(remainingPool, Math.max(remainingEnergy, 0), Math.max(remainingPower, 0), pendingPlay.card.powerDomain);
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
  // case (a card only needing a target/placement choice resolves and
  // submits the instant that choice is made, same as before payment arming
  // existed).
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
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: HUMAN_INDEX,
      card: pendingPlay.card,
      payment: pendingPlay.payment,
      ...(pendingPlay.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: pendingPlay.targetUnitInstanceId } : {}),
      ...(pendingPlay.destinationBattlefieldId !== undefined && pendingPlay.destinationBattlefieldId !== BASE_ZONE_ID
        ? { destinationBattlefieldId: pendingPlay.destinationBattlefieldId }
        : {}),
    };
    applyAction(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay, legal]);

  const isBaseZoneTarget =
    isHumanTurn &&
    (selectedUnit !== null ? Boolean(recallActionFor(selectedUnit)) : Boolean(placementActionAt(BASE_ZONE_ID)));

  function handleBattlefieldClick(battlefieldId: string) {
    if (selectedUnit) {
      const action = moveActionTo(selectedUnit, battlefieldId);
      if (action) applyAction(action);
      return;
    }
    if (!pendingPlay) return;
    const placement = placementActionAt(battlefieldId);
    if (placement) setPendingPlay({ ...pendingPlay, destinationBattlefieldId: battlefieldId });
  }

  function handleBaseZoneClick() {
    if (selectedUnit) {
      const action = recallActionFor(selectedUnit);
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
  function handleHandCardDragEnd(cardInstanceId: string) {
    const zone = lastDragZoneRef.current;
    setDragOverZoneId(null);
    lastDragZoneRef.current = null;
    if (zone !== BASE_ZONE_ID) return;
    const action = immediatePlayAction(cardInstanceId);
    if (action) applyAction(action);
  }
  function handleUnitDragEnd(unit: UnitInstance) {
    const zone = lastDragZoneRef.current;
    setDragOverZoneId(null);
    lastDragZoneRef.current = null;
    if (!zone) return;
    const action = zone === BASE_ZONE_ID ? recallActionFor(unit) : moveActionTo(unit, zone);
    if (action) applyAction(action);
  }

  /** Starts a brand-new match (rematch or quick-swap) — a fresh seed always,
   *  so "same decks" still reshuffles rather than replaying identically. */
  function startNewMatch(newConfig: MatchConfig) {
    setConfig(newConfig);
    setGame(startGame(createNewGame(newConfig, Date.now())));
    setSelectedUnit(null);
    setPendingPlay(null);
    setDragOverZoneId(null);
  }

  function handleQuickSwap(deck: DeckList) {
    startNewMatch({ ...config, humanDeck: deck });
  }

  // Computed once per render for the header hint and the rune-payment UI —
  // both need to know exactly which phase `pendingPlay` is currently in.
  const pendingResolvedAction = pendingLegalAction();
  const pendingStillOwesPayment = Boolean(
    pendingResolvedAction &&
      pendingPlay &&
      (pendingResolvedAction.payment.energyRunes.length > pendingPlay.payment.energyRunes.length ||
        pendingResolvedAction.payment.powerRunes.length > pendingPlay.payment.powerRunes.length),
  );

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <span>
          Turn {state.turnNumber} · {state.phase} ·{" "}
          {isShowdownOpen
            ? `Showdown at ${showdownBattlefield?.name ?? "?"} — ${isHumanTurn ? "your" : "AI's"} Focus`
            : isChainPending
              ? `Spell pending resolution — ${isHumanTurn ? "your" : "AI's"} priority`
              : isHumanTurn
                ? "Your turn"
                : "AI's turn"}
          {pendingPlay && !pendingResolvedAction && pendingNeedsTarget() && ` — choose a target for ${pendingPlay.card.name}`}
          {pendingPlay && !pendingResolvedAction && pendingNeedsPlacement() && ` — choose where to play ${pendingPlay.card.name}`}
          {pendingStillOwesPayment &&
            ` — pay for ${pendingPlay!.card.name}: left-click a rune for Energy, right-click for Power (or Auto Pay)`}
        </span>
      </div>

      {isGameOver && (
        <RematchPanel
          didHumanWin={result.type === "GameOver" && result.winnerId === human.id}
          onRematch={() => startNewMatch(config)}
          onQuickSwap={handleQuickSwap}
          onMainMenu={onMainMenu}
        />
      )}

      <div className="board-main">
        <PlayerSideColumn
          label="AI Opponent"
          points={ai.points}
          handCount={ai.hand.length}
          legend={ai.legend}
          champion={ai.championZone}
          runes={ai.channeled}
          trashCount={ai.trash.length}
          banishedCount={ai.banished.length}
          runeDeckCount={ai.runeDeck.length}
          activeGear={ai.activeGear}
          isEnemy
        />

        <div className="board-center">
          <div className="zone card-zone">
            <div className="zone-label">AI base</div>
            <div className="card-row">
              <AnimatePresence>
                {ai.baseUnits.map((unit) => (
                  <CardView key={unit.instanceId} card={unit} isEnemy />
                ))}
              </AnimatePresence>
            </div>
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
                selectedUnit={selectedUnit}
                isMoveTarget={
                  isHumanTurn &&
                  (selectedUnit !== null ? Boolean(moveActionTo(selectedUnit, bf.id)) : Boolean(placementActionAt(bf.id)))
                }
                isDragOver={dragOverZoneId === bf.id}
                isShowdownActive={state.showdownBattlefieldId === bf.id}
                isUnitTargetable={isUnitLegalTarget}
                onUnitClick={handleUnitClick}
                onMoveHere={() => handleBattlefieldClick(bf.id)}
                canDragUnit={canDragUnit}
                onUnitDrag={(_unit, point) => trackDragZone(point)}
                onUnitDragEnd={(unit) => handleUnitDragEnd(unit)}
              />
            ))}
          </div>

          <div
            className={`zone card-zone${dragOverZoneId === BASE_ZONE_ID ? " drag-over" : ""}${isBaseZoneTarget ? " selectable" : ""}`}
            data-dropzone-id={BASE_ZONE_ID}
            onClick={isBaseZoneTarget ? handleBaseZoneClick : undefined}
          >
            <div className="zone-label">Your base</div>
            <div className="card-row">
              <AnimatePresence>
                {human.baseUnits.map((unit) => (
                  <CardView
                    key={unit.instanceId}
                    card={unit}
                    isSelectable={isHumanTurn && !unit.exhausted}
                    isSelected={selectedUnit?.instanceId === unit.instanceId}
                    onClick={() => handleSelectUnit(unit)}
                    onDrag={canDragUnit(unit) ? trackDragZone : undefined}
                    onDragEnd={canDragUnit(unit) ? () => handleUnitDragEnd(unit) : undefined}
                  />
                ))}
              </AnimatePresence>
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
                    isSelected={pendingPlay?.card.instanceId === card.instanceId}
                    onClick={() => handleHandCardClick(card.instanceId)}
                    onDrag={isHumanTurn && immediatePlayAction(card.instanceId) ? trackDragZone : undefined}
                    onDragEnd={
                      isHumanTurn && immediatePlayAction(card.instanceId) ? () => handleHandCardDragEnd(card.instanceId) : undefined
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
          runes={human.channeled}
          trashCount={human.trash.length}
          banishedCount={human.banished.length}
          runeDeckCount={human.runeDeck.length}
          activeGear={human.activeGear}
          legendAtBottom
          isChampionSelectable={isHumanTurn && Boolean(human.championZone && isCardInteractable(human.championZone.instanceId))}
          onChampionClick={() => human.championZone && handleHandCardClick(human.championZone.instanceId)}
          onChampionDrag={
            isHumanTurn && human.championZone && immediatePlayAction(human.championZone.instanceId) ? trackDragZone : undefined
          }
          onChampionDragEnd={
            isHumanTurn && human.championZone && immediatePlayAction(human.championZone.instanceId)
              ? () => human.championZone && handleHandCardDragEnd(human.championZone.instanceId)
              : undefined
          }
          paymentMode={
            pendingResolvedAction
              ? {
                  proposedEnergyIds: pendingPlay!.payment.energyRunes,
                  proposedPowerIds: pendingPlay!.payment.powerRunes,
                  isRuneEligibleForEnergy,
                  isRuneEligibleForPower,
                  onRuneLeftClick: toggleEnergyRune,
                  onRuneRightClick: togglePowerRune,
                }
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
        {pendingStillOwesPayment && <button onClick={handleAutoPay}>Auto Pay</button>}
      </div>
    </div>
  );
}
