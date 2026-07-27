import { createContext, useContext, useState, type ReactNode } from "react";
import type { CardDefinition, CardInstance } from "@rift-engine/engine";

interface HoveredCard {
  card: CardInstance;
  def: CardDefinition | undefined;
}

const HoverContext = createContext<((hovered: HoveredCard | null) => void) | null>(null);

/** Cards on the board are too small to read comfortably — this is the
 *  escape hatch: hovering any CardView reports itself here, and a single
 *  fixed-position overlay (rendered once, at the provider) shows an
 *  enlarged version with full rules text. A context instead of prop-drilling
 *  a callback through BattlefieldView too — every CardView anywhere under
 *  the provider can report a hover with no extra plumbing per call site. */
export function useCardHover(): (hovered: HoveredCard | null) => void {
  const ctx = useContext(HoverContext);
  if (!ctx) throw new Error("useCardHover must be used within HoverPreviewProvider");
  return ctx;
}

export function HoverPreviewProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<HoveredCard | null>(null);
  return (
    <HoverContext.Provider value={setHovered}>
      {children}
      {hovered && <CardPreviewOverlay hovered={hovered} />}
    </HoverContext.Provider>
  );
}

function CardPreviewOverlay({ hovered }: { hovered: HoveredCard }) {
  const { card, def } = hovered;
  const text = def && "text" in def ? def.text : undefined;

  return (
    <div className="card-preview">
      {def?.imageUrl && <img src={def.imageUrl} alt={card.name} className="card-preview-art" />}
      <div className="card-preview-body">
        <div className="card-preview-name">{card.name}</div>
        {(card.kind === "Unit" || card.kind === "Spell" || card.kind === "Gear") && (
          <div className="card-stats">
            {card.energyCost > 0 && <span className="stat-badge stat-energy">{card.energyCost} Energy</span>}
            {card.powerCost > 0 && <span className="stat-badge stat-power">{card.powerCost} Power</span>}
            {card.kind === "Unit" && <span className="stat-badge stat-might">{card.might} Might</span>}
          </div>
        )}
        {text && <p className="card-preview-text">{text}</p>}
      </div>
    </div>
  );
}
