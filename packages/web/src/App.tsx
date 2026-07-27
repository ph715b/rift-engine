import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  chooseAction,
  legalActions,
  startGame,
  submit,
  type GameState,
  type PlayerAction,
  type SubmitResult,
  type UnitInstance,
} from "@rift-engine/engine";
import { createNewGame } from "./game-setup.js";
import { CardView, type DragPoint } from "./components/CardView.js";
import { BattlefieldView } from "./components/BattlefieldView.js";

const HUMAN_INDEX = 0;
const AI_INDEX = 1;
const AI_MOVE_DELAY_MS = 650;
const BASE_ZONE_ID = "base";

function initialGame(): { state: GameState; result: SubmitResult } {
  return startGame(createNewGame(Date.now()));
}

/** Finds the drop zone (a battlefield id, or BASE_ZONE_ID) under a viewport
 *  point, via the `data-dropzone-id` attributes BattlefieldView/the base
 *  zone carry — simpler and more robust than manual rect math, since it
 *  goes through the browser's own hit-testing (z-index, overlap, etc.). */
function dropZoneAt(point: DragPoint): string | null {
  const el = document.elementFromPoint(point.x, point.y);
  return el?.closest("[data-dropzone-id]")?.getAttribute("data-dropzone-id") ?? null;
}

export function App() {
  const [{ state, result }, setGame] = useState(initialGame);
  const [selectedUnit, setSelectedUnit] = useState<UnitInstance | null>(null);
  const [dragOverZoneId, setDragOverZoneId] = useState<string | null>(null);
  // Tracks the last drop zone seen during the drag (from onDrag, updated on
  // every pointer move) — read at drop time instead of recomputing there.
  // onDragEnd fires as Framer Motion is already reverting the dragged
  // element's whileDrag styles (including the pointerEvents:none that makes
  // hit-testing find what's UNDER the card rather than the card itself), so
  // recomputing document.elementFromPoint at that exact moment is a race;
  // the continuously-updated ref isn't.
  const lastDragZoneRef = useRef<string | null>(null);

  const isHumanTurn = state.activePlayerIndex === HUMAN_INDEX;
  const isGameOver = result.type === "GameOver";

  const legal = useMemo(() => (isHumanTurn && !isGameOver ? legalActions(state) : []), [state, isHumanTurn, isGameOver]);

  function applyAction(action: PlayerAction) {
    setGame((prev) => submit(prev.state, action));
    setSelectedUnit(null);
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

  function isCardPlayable(cardInstanceId: string): PlayerAction | undefined {
    return legal.find((a) => a.type === "PlayCard" && a.card.instanceId === cardInstanceId);
  }

  function moveActionTo(unit: UnitInstance, battlefieldId: string): PlayerAction | undefined {
    return legal.find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds[0] === unit.instanceId && a.destinationBattlefieldId === battlefieldId,
    );
  }

  function canDragUnit(unit: UnitInstance): boolean {
    return isHumanTurn && !unit.exhausted;
  }

  function handleHandCardClick(cardInstanceId: string) {
    const action = isCardPlayable(cardInstanceId);
    if (action) applyAction(action);
  }

  function handleSelectUnit(unit: UnitInstance) {
    setSelectedUnit((prev) => (prev?.instanceId === unit.instanceId ? null : unit));
  }

  function handleBattlefieldClick(battlefieldId: string) {
    if (!selectedUnit) return;
    const action = moveActionTo(selectedUnit, battlefieldId);
    if (action) applyAction(action);
  }

  function handlePass() {
    const pass = legal.find((a) => a.type === "Pass");
    if (pass) applyAction(pass);
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
    const action = isCardPlayable(cardInstanceId);
    if (action) applyAction(action);
  }
  function handleUnitDragEnd(unit: UnitInstance) {
    const zone = lastDragZoneRef.current;
    setDragOverZoneId(null);
    lastDragZoneRef.current = null;
    if (!zone || zone === BASE_ZONE_ID) return;
    const action = moveActionTo(unit, zone);
    if (action) applyAction(action);
  }

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <span>
          Turn {state.turnNumber} · {state.phase} · {isHumanTurn ? "Your turn" : "AI's turn"}
        </span>
      </div>

      {isGameOver && (
        <div className="banner">{result.type === "GameOver" && result.winnerId === human.id ? "You win!" : "AI wins."}</div>
      )}

      <div className="player-row">
        <span>
          AI Opponent — <strong>{ai.points} pts</strong> · hand: {ai.hand.length}
        </span>
      </div>

      <div className="zone">
        <div className="zone-label">AI base</div>
        <div className="card-row">
          <AnimatePresence>
            {ai.baseUnits.map((unit) => (
              <CardView key={unit.instanceId} card={unit} isEnemy />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className="battlefields">
        {state.battlefields.map((bf) => (
          <BattlefieldView
            key={bf.id}
            battlefield={bf}
            human={human}
            ai={ai}
            selectedUnit={selectedUnit}
            isMoveTarget={isHumanTurn && selectedUnit !== null && Boolean(moveActionTo(selectedUnit, bf.id))}
            isDragOver={dragOverZoneId === bf.id}
            onSelectUnit={handleSelectUnit}
            onMoveHere={() => handleBattlefieldClick(bf.id)}
            canDragUnit={canDragUnit}
            onUnitDrag={(_unit, point) => trackDragZone(point)}
            onUnitDragEnd={(unit) => handleUnitDragEnd(unit)}
          />
        ))}
      </div>

      <div
        className={`zone${dragOverZoneId === BASE_ZONE_ID ? " drag-over" : ""}`}
        data-dropzone-id={BASE_ZONE_ID}
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

      <div className="zone">
        <div className="zone-label">Your hand</div>
        <div className="card-row">
          <AnimatePresence>
            {human.hand.map((card) => (
              <CardView
                key={card.instanceId}
                card={card}
                isSelectable={isHumanTurn && Boolean(isCardPlayable(card.instanceId))}
                onClick={() => handleHandCardClick(card.instanceId)}
                onDrag={isHumanTurn && isCardPlayable(card.instanceId) ? trackDragZone : undefined}
                onDragEnd={
                  isHumanTurn && isCardPlayable(card.instanceId) ? () => handleHandCardDragEnd(card.instanceId) : undefined
                }
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className="player-row">
        <span>
          You — <strong>{human.points} pts</strong>
        </span>
      </div>

      <div className="actions">
        <button onClick={handlePass} disabled={!isHumanTurn || isGameOver}>
          Pass
        </button>
      </div>
    </div>
  );
}
