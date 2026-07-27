import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CardDefinition, CardInstance } from "@rift-engine/engine";

interface DragGhost {
  card: CardInstance;
  def: CardDefinition | undefined;
  x: number;
  y: number;
}

const DragGhostContext = createContext<((ghost: DragGhost | null) => void) | null>(null);

/**
 * Fixes a real bug: `.board`'s `overflow: hidden` (needed for the
 * no-scroll-at-any-window-size fix) clips Framer Motion's own drag
 * transform once the dragged card visually leaves its origin zone's
 * box — the card would vanish behind whatever zone it's passing over. The
 * fix is a floating "ghost" copy rendered via a portal straight onto
 * `document.body`, `position: fixed`, so it's never inside any clipped
 * ancestor. The ORIGINAL card (still driven by Framer Motion's own drag,
 * which is what fires onDrag/onDragEnd) is faded near-invisible during the
 * drag instead — the ghost is what's actually visible.
 */
export function useDragGhost(): (ghost: DragGhost | null) => void {
  const ctx = useContext(DragGhostContext);
  if (!ctx) throw new Error("useDragGhost must be used within DragGhostProvider");
  return ctx;
}

export function DragGhostProvider({ children }: { children: ReactNode }) {
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  return (
    <DragGhostContext.Provider value={setGhost}>
      {children}
      {ghost &&
        createPortal(
          <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
            {ghost.def?.imageUrl ? (
              <img src={ghost.def.imageUrl} alt={ghost.card.name} />
            ) : (
              <div className="drag-ghost-fallback">{ghost.card.name}</div>
            )}
          </div>,
          document.body,
        )}
    </DragGhostContext.Provider>
  );
}
