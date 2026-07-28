import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  chooseAction,
  effectForCard,
  legalActions,
  requiresTarget,
  startGame,
  submit,
  type CardInstance,
  type DeckList,
  type PlayCardAction,
  type PlayerAction,
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
  // The hand/champion card "armed" for a targeted spell — set instead of
  // playing immediately when the card's effect requires a target (e.g.
  // Incinerate); the next matching unit click commits it. Untargeted cards
  // (Units, Gear, BuffAllFriendlies-style Spells) never arm — they still
  // play instantly on click, unchanged from before targeting existed.
  const [selectedHandCard, setSelectedHandCard] = useState<CardInstance | null>(null);
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
    setSelectedHandCard(null);
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

  /** The one action to submit immediately on click/drag — only for cards
   *  whose effect doesn't require a target. A targeted card (e.g.
   *  Incinerate) returns undefined here even though it's interactable,
   *  since clicking it should arm it instead (see handleHandCardClick). */
  function immediatePlayAction(cardInstanceId: string): PlayCardAction | undefined {
    const [first] = playCardActionsFor(cardInstanceId);
    if (!first) return undefined;
    return requiresTarget(effectForCard(first.card)) ? undefined : first;
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
    // A targeted card — arm it (toggle off if clicking the same one again).
    setSelectedHandCard((prev) => (prev?.instanceId === first.card.instanceId ? null : first.card));
  }

  function handleSelectUnit(unit: UnitInstance) {
    setSelectedUnit((prev) => (prev?.instanceId === unit.instanceId ? null : unit));
  }

  function isUnitLegalTarget(unit: UnitInstance): boolean {
    if (!selectedHandCard) return false;
    return legal.some(
      (a) => a.type === "PlayCard" && a.card.instanceId === selectedHandCard.instanceId && a.targetUnitInstanceId === unit.instanceId,
    );
  }

  /** Unified click handler for any unit at a battlefield, friendly or enemy.
   *  If a targeted spell is armed and this unit is a legal target, commits
   *  it; otherwise falls through to ordinary move-selection. */
  function handleUnitClick(unit: UnitInstance) {
    if (selectedHandCard) {
      const action = legal.find(
        (a): a is PlayCardAction =>
          a.type === "PlayCard" && a.card.instanceId === selectedHandCard.instanceId && a.targetUnitInstanceId === unit.instanceId,
      );
      if (action) {
        applyAction(action);
        return;
      }
    }
    handleSelectUnit(unit);
  }

  function handleBattlefieldClick(battlefieldId: string) {
    if (!selectedUnit) return;
    const action = moveActionTo(selectedUnit, battlefieldId);
    if (action) applyAction(action);
  }

  function handleBaseZoneClick() {
    if (!selectedUnit) return;
    const action = recallActionFor(selectedUnit);
    if (action) applyAction(action);
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
    setSelectedHandCard(null);
    setDragOverZoneId(null);
  }

  function handleQuickSwap(deck: DeckList) {
    startNewMatch({ ...config, humanDeck: deck });
  }

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
          {selectedHandCard && ` — choose a target for ${selectedHandCard.name}`}
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
                isMoveTarget={isHumanTurn && selectedUnit !== null && Boolean(moveActionTo(selectedUnit, bf.id))}
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
            className={`zone card-zone${dragOverZoneId === BASE_ZONE_ID ? " drag-over" : ""}${
              isHumanTurn && selectedUnit !== null && Boolean(recallActionFor(selectedUnit)) ? " selectable" : ""
            }`}
            data-dropzone-id={BASE_ZONE_ID}
            onClick={isHumanTurn && selectedUnit !== null && recallActionFor(selectedUnit) ? handleBaseZoneClick : undefined}
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
                    isSelected={selectedHandCard?.instanceId === card.instanceId}
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
      </div>
    </div>
  );
}
