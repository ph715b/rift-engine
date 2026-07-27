import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";
import { CardView } from "./CardView.js";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  human: PlayerState;
  ai: PlayerState;
  selectedUnit: UnitInstance | null;
  isMoveTarget: boolean;
  onSelectUnit: (unit: UnitInstance) => void;
  onMoveHere: () => void;
}

export function BattlefieldView({
  battlefield,
  human,
  ai,
  selectedUnit,
  isMoveTarget,
  onSelectUnit,
  onMoveHere,
}: BattlefieldViewProps) {
  const humanUnits = battlefield.units[human.id] ?? [];
  const aiUnits = battlefield.units[ai.id] ?? [];
  const controllerName =
    battlefield.controllerId === human.id ? "You" : battlefield.controllerId === ai.id ? "AI" : "Uncontrolled";

  return (
    <div
      className={`battlefield${isMoveTarget ? " selectable" : ""}`}
      onClick={isMoveTarget ? onMoveHere : undefined}
    >
      <div className="battlefield-name">
        <span>{battlefield.name}</span>
        <span>{controllerName}</span>
      </div>
      <div className="battlefield-side">
        {aiUnits.map((unit) => (
          <CardView key={unit.instanceId} card={unit} isEnemy />
        ))}
      </div>
      <div className="battlefield-side">
        {humanUnits.map((unit) => (
          <CardView
            key={unit.instanceId}
            card={unit}
            isSelectable={!unit.exhausted}
            isSelected={selectedUnit?.instanceId === unit.instanceId}
            onClick={() => onSelectUnit(unit)}
          />
        ))}
      </div>
    </div>
  );
}
