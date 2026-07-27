import { useState } from "react";
import { motion } from "framer-motion";
import type { CardInstance } from "@rift-engine/engine";

export interface DragPoint {
  x: number;
  y: number;
}

/** Framer Motion's own PanInfo.point coordinate space is ambiguous across
 *  versions/input types; reading clientX/Y straight off the raw event is
 *  what `document.elementFromPoint` (viewport coordinates) actually needs. */
function clientPoint(event: MouseEvent | TouchEvent | PointerEvent): DragPoint {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 };
}

interface CardViewProps {
  card: CardInstance;
  isEnemy?: boolean;
  isSelectable?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  /** When set, the card can be dragged; drop-zone detection is the caller's
   *  job (see App.tsx's `dropZoneAt`) since it needs the full board layout,
   *  not just this one card. */
  onDragEnd?: (point: DragPoint) => void;
  onDrag?: (point: DragPoint) => void;
}

/**
 * A single card, anywhere on the board (hand, base, or a battlefield).
 * `layoutId={card.instanceId}` is what gives us card-movement animation for
 * free: the same instanceId re-appearing in a different DOM position after
 * a state update (e.g. hand -> base) is exactly what Framer Motion's shared
 * layout animation detects and smoothly transitions between.
 *
 * Drag is additive, not a replacement for click: `isSelectable` still
 * drives the click-to-select/click-target flow, `onDragEnd` layers a drag
 * gesture on top of the same legal-move check. `dragSnapToOrigin` means an
 * invalid drop (no matching drop zone) always springs back — the actual
 * move only ever happens by committing a real action and letting the
 * layout animation carry the card to its new state-driven position, never
 * by leaving the dragged element wherever it was released.
 */
export function CardView({ card, isEnemy, isSelectable, isSelected, onClick, onDragEnd, onDrag }: CardViewProps) {
  // Real React state, not whileDrag: Framer Motion's whileDrag animation
  // object silently drops `pointerEvents` (confirmed via computed style —
  // it never reaches the DOM), so it has to be a genuine style prop instead.
  // Load-bearing, not cosmetic: Framer Motion moves this element via a CSS
  // transform without reparenting it, so mid-drag it's still visually on
  // top of whatever's underneath. Without pointerEvents:none while
  // dragging, document.elementFromPoint(x, y) (how App.tsx finds the drop
  // zone) hits THIS card instead of the battlefield/zone it's hovering
  // over, and .closest() then walks its ORIGINAL parent chain — every drop
  // silently resolves to the card's own starting zone.
  const [isDragging, setIsDragging] = useState(false);

  const classes = ["card"];
  if (isEnemy) classes.push("enemy");
  if (isSelectable) classes.push("selectable");
  if (isSelected) classes.push("selected");
  if (card.exhausted) classes.push("exhausted");
  if (onDragEnd) classes.push("draggable");

  return (
    <motion.div
      layoutId={card.instanceId}
      layout
      className={classes.join(" ")}
      style={isDragging ? { pointerEvents: "none" } : undefined}
      onClick={isSelectable ? onClick : undefined}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
      drag={Boolean(onDragEnd)}
      dragSnapToOrigin
      dragElastic={0.15}
      whileDrag={{ scale: 1.1, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}
      onDragStart={onDragEnd ? () => setIsDragging(true) : undefined}
      onDrag={onDrag ? (e) => onDrag(clientPoint(e)) : undefined}
      onDragEnd={
        onDragEnd
          ? (e) => {
              setIsDragging(false);
              onDragEnd(clientPoint(e));
            }
          : undefined
      }
    >
      <div className="card-name">{card.name}</div>
      {card.kind === "Unit" && (
        <div className="card-stats">
          <span>{card.energyCost}⚡</span>
          <span>{card.might}💪</span>
        </div>
      )}
      {card.kind === "Legend" && <div className="card-stats">Legend</div>}
    </motion.div>
  );
}
