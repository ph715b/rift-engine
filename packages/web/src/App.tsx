import { useEffect, useMemo, useState } from "react";
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
import { CardView } from "./components/CardView.js";
import { BattlefieldView } from "./components/BattlefieldView.js";

const HUMAN_INDEX = 0;
const AI_INDEX = 1;
const AI_MOVE_DELAY_MS = 650;

function initialGame(): { state: GameState; result: SubmitResult } {
  return startGame(createNewGame(Date.now()));
}

export function App() {
  const [{ state, result }, setGame] = useState(initialGame);
  const [selectedUnit, setSelectedUnit] = useState<UnitInstance | null>(null);

  const isHumanTurn = state.activePlayerIndex === HUMAN_INDEX;
  const isGameOver = result.type === "GameOver";

  const legal = useMemo(() => (isHumanTurn && !isGameOver ? legalActions(state) : []), [state, isHumanTurn, isGameOver]);

  function applyAction(action: PlayerAction) {
    setGame((prev) => submit(prev.state, action));
    setSelectedUnit(null);
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
            onSelectUnit={handleSelectUnit}
            onMoveHere={() => handleBattlefieldClick(bf.id)}
          />
        ))}
      </div>

      <div className="zone">
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
