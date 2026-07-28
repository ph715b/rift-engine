import { CardView, type DragPoint } from "./CardView.js";
import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  human: PlayerState;
  ai: PlayerState;
  selectedUnitIds: Set<string>;
  isMoveTarget: boolean;
  isDragOver: boolean;
  isShowdownActive: boolean;
  /** Is this unit a legal target for the currently-armed spell (if any)?
   *  Independent of whose unit it is — a targeted spell in this engine can
   *  affect either player's units at a battlefield. */
  isUnitTargetable: (unit: UnitInstance) => boolean;
  /** Unified click handler for any unit at this battlefield, friendly or
   *  enemy — GameBoard decides whether this commits an armed spell against
   *  the unit or falls through to ordinary move-selection. */
  onUnitClick: (unit: UnitInstance) => void;
  onMoveHere: () => void;
  canDragUnit: (unit: UnitInstance) => boolean;
  onUnitDrag: (unit: UnitInstance, point: DragPoint) => void;
  onUnitDragEnd: (unit: UnitInstance, point: DragPoint) => void;
}

export function BattlefieldView({
  battlefield,
  human,
  ai,
  selectedUnitIds,
  isMoveTarget,
  isDragOver,
  isShowdownActive,
  isUnitTargetable,
  onUnitClick,
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
          <CardView
            key={unit.instanceId}
            card={unit}
            isEnemy
            isSelectable={isUnitTargetable(unit)}
            onClick={() => onUnitClick(unit)}
          />
        ))}
      </div>
      <div className="battlefield-side">
        {humanUnits.map((unit) => (
          <CardView
            key={unit.instanceId}
            card={unit}
            isSelectable={!unit.exhausted || isUnitTargetable(unit)}
            isSelected={selectedUnitIds.has(unit.instanceId)}
            onClick={() => onUnitClick(unit)}
            onDrag={canDragUnit(unit) ? (info) => onUnitDrag(unit, info) : undefined}
            onDragEnd={canDragUnit(unit) ? (info) => onUnitDragEnd(unit, info) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
