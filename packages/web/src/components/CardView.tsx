import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { defaultCardRegistry, type CardInstance } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { useCardHover } from "../hover-preview.js";
import { useDragGhost } from "../drag-ghost.js";

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
 *
 * `card` (the runtime CardInstance) only carries gameplay state — for
 * display-only data the definition has but the instance doesn't (art,
 * which Power domain a cost belongs to), this looks the definition up by
 * `defId` via the shared registry. Keeps the engine's runtime type lean;
 * this is purely a presentation concern.
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

  const def = useMemo(() => defaultCardRegistry().tryGet(card.defId), [card.defId]);
  const setHovered = useCardHover();
  const setDragGhost = useDragGhost();

  const classes = ["card"];
  if (isEnemy) classes.push("enemy");
  if (isSelectable) classes.push("selectable");
  if (isSelected) classes.push("selected");
  if (card.exhausted) classes.push("exhausted");
  if (onDragEnd) classes.push("draggable");

  const powerDomainColor = def && "powerDomain" in def && def.powerDomain ? DOMAIN_COLORS[def.powerDomain] : undefined;

  return (
    <motion.div
      layoutId={card.instanceId}
      layout
      className={classes.join(" ")}
      style={isDragging ? { pointerEvents: "none" } : undefined}
      onClick={isSelectable ? onClick : undefined}
      onMouseEnter={() => setHovered({ card, def })}
      onMouseLeave={() => setHovered(null)}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, rotate: card.exhausted ? 90 : 0 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
      drag={Boolean(onDragEnd)}
      dragSnapToOrigin
      dragElastic={0.15}
      // opacity here (not just pointerEvents) because the ghost portal (see
      // drag-ghost.tsx) is now the actually-visible drag indicator — this
      // original element still exists and still moves (that's how Framer
      // Motion fires drag events at all), it's just faded near-invisible so
      // the ghost is what the eye follows.
      whileDrag={{ scale: 1.06, zIndex: 50, opacity: 0.12 }}
      onDragStart={
        onDragEnd
          ? (e) => {
              setIsDragging(true);
              const p = clientPoint(e);
              setDragGhost({ card, def, x: p.x, y: p.y });
            }
          : undefined
      }
      onDrag={
        onDrag
          ? (e) => {
              const p = clientPoint(e);
              onDrag(p);
              setDragGhost({ card, def, x: p.x, y: p.y });
            }
          : undefined
      }
      onDragEnd={
        onDragEnd
          ? (e) => {
              setIsDragging(false);
              setDragGhost(null);
              onDragEnd(clientPoint(e));
            }
          : undefined
      }
    >
      {def?.imageUrl ? (
        // The real card art already prints name/cost/might as part of its own
        // design — showing our own text overlay on top of it would just
        // duplicate that info. The overlay below is the fallback for the
        // (rare/never, in the current OGN+OGS pool) case where art is missing.
        <img className="card-art" src={def.imageUrl} alt={card.name} draggable={false} loading="lazy" />
      ) : (
        <div className="card-info card-info-fallback">
          <div className="card-name">{card.name}</div>
          {(card.kind === "Unit" || card.kind === "Spell" || card.kind === "Gear") && (
            <div className="card-stats">
              {card.energyCost > 0 && <span className="stat-badge stat-energy">{card.energyCost}</span>}
              {card.powerCost > 0 && (
                <span
                  className="stat-badge stat-power"
                  style={powerDomainColor ? { background: powerDomainColor } : undefined}
                >
                  {card.powerCost}
                </span>
              )}
              {card.kind === "Unit" && <span className="stat-badge stat-might">{card.might}</span>}
            </div>
          )}
        </div>
      )}
      {card.kind === "Unit" && (card.damage > 0 || card.bonus !== 0) && (
        // Rendered regardless of real-art-vs-fallback — real card art never
        // prints marked damage or a buff/debuff, since those are runtime
        // state, not part of the card's design.
        <div className="card-status-badges">
          {card.damage > 0 && (
            <span className="status-badge status-damage" title={`${card.damage} damage marked`}>
              −{card.damage}
            </span>
          )}
          {card.bonus !== 0 && (
            <span
              className={`status-badge ${card.bonus > 0 ? "status-buff" : "status-debuff"}`}
              title={`${card.bonus > 0 ? "+" : ""}${card.bonus} Might this turn`}
            >
              {card.bonus > 0 ? "+" : ""}
              {card.bonus}
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}
