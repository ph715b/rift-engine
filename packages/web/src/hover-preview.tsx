import { createContext, useContext, useState, type ReactNode } from "react";
import type { CardDefinition, CardInstance } from "@rift-engine/engine";

interface HoveredCard {
  card: CardInstance;
  def: CardDefinition | undefined;
  /** Why this card can't be played right now, when it can't be — shown in
   *  the preview so the answer arrives where the eye already is, rather than
   *  requiring the player to guess that clicking a dimmed card explains it. */
  note?: string;
}

/**
 * A BATTLEFIELD hovered on the board.
 *
 * Its own shape rather than a synthesised `CardInstance`, because a battlefield
 * is not one and faking it would mean inventing an `instanceId`, a `kind` and
 * three cost fields the overlay would then have to special-case anyway. A
 * battlefield has a name, art and rules text and no costs, no Might and no
 * instance — this says exactly that.
 *
 * `loadBattlefieldDefinitions` is the only source of any of it; see
 * battlefield-cards.ts for why the lookup is by NAME.
 */
interface HoveredBattlefield {
  name: string;
  imageUrl?: string;
  text?: string;
}

/** What the overlay can show. Discriminated on `kind` so neither branch has to
 *  guess which fields the other left undefined. */
export type Hovered = ({ kind?: "card" } & HoveredCard) | ({ kind: "battlefield" } & HoveredBattlefield);

/** Is this a battlefield hover? A type guard rather than a bare `in` check, so
 *  the two branches of the overlay stay exhaustive as the shapes grow. */
function isBattlefieldHover(hovered: Hovered): hovered is { kind: "battlefield" } & HoveredBattlefield {
  return hovered.kind === "battlefield";
}

const HoverContext = createContext<((hovered: Hovered | null) => void) | null>(null);

/** Cards on the board are too small to read comfortably — this is the
 *  escape hatch: hovering any CardView reports itself here, and a single
 *  fixed-position overlay (rendered once, at the provider) shows an
 *  enlarged version with full rules text. A context instead of prop-drilling
 *  a callback through BattlefieldView too — every CardView anywhere under
 *  the provider can report a hover with no extra plumbing per call site. */
export function useCardHover(): (hovered: Hovered | null) => void {
  const ctx = useContext(HoverContext);
  if (!ctx) throw new Error("useCardHover must be used within HoverPreviewProvider");
  return ctx;
}

export function HoverPreviewProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  return (
    <HoverContext.Provider value={setHovered}>
      {children}
      {hovered && <CardPreviewOverlay hovered={hovered} />}
    </HoverContext.Provider>
  );
}

function CardPreviewOverlay({ hovered }: { hovered: Hovered }) {
  // A battlefield has no instance, no costs and no Might — it shares only the
  // art/name/text half of the overlay, so it returns early rather than threading
  // three undefined cost fields through the card branch below.
  if (isBattlefieldHover(hovered)) {
    return (
      <div className="card-preview">
        {hovered.imageUrl && <img src={hovered.imageUrl} alt={hovered.name} className="card-preview-art battlefield" />}
        <div className="card-preview-body">
          <div className="card-preview-name">{hovered.name}</div>
          <div className="card-stats">
            <span className="stat-badge">Battlefield</span>
          </div>
          {hovered.text && <p className="card-preview-text">{hovered.text}</p>}
        </div>
      </div>
    );
  }
  const { card, def, note } = hovered;
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
        {note && <p className="card-preview-note">{note}</p>}
      </div>
    </div>
  );
}
