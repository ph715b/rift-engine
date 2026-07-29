import { CardView, type DragPoint } from "./CardView.js";
import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  human: PlayerState;
  ai: PlayerState;
  selectedUnitIds: Set<string>;
  isMoveTarget: boolean;
  /** Is this BATTLEFIELD ITSELF the target of the currently-armed card —
   *  e.g. Firestorm's "deal 3 to all enemy units at a battlefield"? Distinct
   *  from `isMoveTarget`, which is about moving/placing units HERE; both
   *  render the same `.selectable` affordance and both commit through
   *  `onMoveHere`, since GameBoard already knows which of the two a click
   *  means from its own pending-play step. */
  isTargetable: boolean;
  isDragOver: boolean;
  isShowdownActive: boolean;
  /** Is this unit a legal target for the currently-armed spell (if any)?
   *  Independent of whose unit it is — a targeted spell in this engine can
   *  affect either player's units at a battlefield. */
  isUnitTargetable: (unit: UnitInstance) => boolean;
  /** Should one of the viewer's OWN units here be clickable — ordinarily any
   *  ready unit (move-selection), but only a legal answer while an armed card
   *  is still asking for one. GameBoard owns that rule; this just renders it
   *  (see isFriendlyUnitSelectable there). */
  isFriendlySelectable: (unit: UnitInstance) => boolean;
  /** Units already picked as targets of the armed card — shown with the same
   *  `.selected` outline a move-selected unit gets, so a half-finished
   *  multi-target pick (Gentlemen's Duel) is visible on the board. Covers
   *  enemy units too, unlike `selectedUnitIds`. */
  chosenUnitIds: Set<string>;
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
  isTargetable,
  isDragOver,
  isShowdownActive,
  isUnitTargetable,
  isFriendlySelectable,
  chosenUnitIds,
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

  const isClickable = isMoveTarget || isTargetable;
  const classes = ["battlefield"];
  if (isClickable) classes.push("selectable");
  if (isDragOver) classes.push("drag-over");
  if (isShowdownActive) classes.push("showdown");

  return (
    <div className={classes.join(" ")} onClick={isClickable ? onMoveHere : undefined} data-dropzone-id={battlefield.id}>
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
            isSelected={chosenUnitIds.has(unit.instanceId)}
            onClick={() => onUnitClick(unit)}
          />
        ))}
      </div>
      <div className="battlefield-side">
        {humanUnits.map((unit) => (
          <CardView
            key={unit.instanceId}
            card={unit}
            isSelectable={isFriendlySelectable(unit)}
            isSelected={selectedUnitIds.has(unit.instanceId) || chosenUnitIds.has(unit.instanceId)}
            onClick={() => onUnitClick(unit)}
            onDrag={canDragUnit(unit) ? (info) => onUnitDrag(unit, info) : undefined}
            onDragEnd={canDragUnit(unit) ? (info) => onUnitDragEnd(unit, info) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
