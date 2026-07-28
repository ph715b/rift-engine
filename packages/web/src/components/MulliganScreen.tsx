import { useState } from "react";
import type { CardInstance } from "@rift-engine/engine";
import { CardView } from "./CardView.js";

interface MulliganScreenProps {
  hand: CardInstance[];
  onConfirm: (setAsideInstanceIds: string[]) => void;
}

/** The pregame mulligan step: shows the player's 4 dealt cards and lets
 *  them toggle up to 2 to set aside and replace (the real rule — a
 *  one-shot, per-card exchange, not a full-hand redraw; see
 *  execute-mulligan.ts). Clicking past 2 silently no-ops rather than
 *  erroring, matching the "cap, don't error" feel of this app's other
 *  toggle-based selection UIs (e.g. the manual rune-payment feature). */
export function MulliganScreen({ hand, onConfirm }: MulliganScreenProps) {
  const [setAside, setAside_] = useState<Set<string>>(new Set());

  function toggle(instanceId: string) {
    setAside_((prev) => {
      const next = new Set(prev);
      if (next.has(instanceId)) next.delete(instanceId);
      else if (next.size < 2) next.add(instanceId);
      return next;
    });
  }

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <span>Mulligan</span>
      </div>

      <div className="mulligan-screen">
        <div className="banner">Choose up to 2 cards to set aside and replace</div>
        <div className="card-row">
          {hand.map((card) => (
            <CardView
              key={card.instanceId}
              card={card}
              isSelectable
              isSelected={setAside.has(card.instanceId)}
              onClick={() => toggle(card.instanceId)}
            />
          ))}
        </div>
        <div className="actions">
          <button className="menu-primary-button" onClick={() => onConfirm([...setAside])}>
            {setAside.size === 0 ? "Keep hand" : `Mulligan ${setAside.size} card${setAside.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
