import { CardView, type DragPoint } from "./CardView.js";
import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  human: PlayerState;
  ai: PlayerState;
  selectedUnit: UnitInstance | null;
  isMoveTarget: boolean;
  isDragOver: boolean;
  isShowdownActive: boolean;
  onSelectUnit: (unit: UnitInstance) => void;
  onMoveHere: () => void;
  canDragUnit: (unit: UnitInstance) => boolean;
  onUnitDrag: (unit: UnitInstance, point: DragPoint) => void;
  onUnitDragEnd: (unit: UnitInstance, point: DragPoint) => void;
}

export function BattlefieldView({
  battlefield,
  human,
  ai,
  selectedUnit,
  isMoveTarget,
  isDragOver,
  isShowdownActive,
  onSelectUnit,
  onMoveHere,
  canDragUnit,
  onUnitDrag,
  onUnitDragEnd,
}: BattlefieldViewProps) {
  const humanUnits = battlefield.units[human.id] ?? [];
  const aiUnits = battlefield.units[ai.id] ?? [];
  const controllerName =
    battlefield.controllerId === human.id ? "You" : battlefield.controllerId === ai.id ? "AI" : "Uncontrolled";

  const classes = ["battlefield"];
  if (isMoveTarget) classes.push("selectable");
  if (isDragOver) classes.push("drag-over");
  if (isShowdownActive) classes.push("showdown");

  return (
    <div className={classes.join(" ")} onClick={isMoveTarget ? onMoveHere : undefined} data-dropzone-id={battlefield.id}>
      <div className="battlefield-name">
        <span>{battlefield.name}</span>
        <span>{isShowdownActive ? "Showdown!" : controllerName}</span>
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
            onDrag={canDragUnit(unit) ? (info) => onUnitDrag(unit, info) : undefined}
            onDragEnd={canDragUnit(unit) ? (info) => onUnitDragEnd(unit, info) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
