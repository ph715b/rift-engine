import { useState, type CSSProperties } from "react";
import type { CardInstance } from "@rift-engine/engine";
import { CardView } from "./CardView.js";

interface MulliganScreenProps {
  hand: CardInstance[];
  /** Does the human take the first turn? Turn order is rolled per game (rule
   *  115), so this is genuinely unknown until now — and it belongs on THIS
   *  screen rather than only in the board header, because it's information the
   *  mulligan decision depends on: the player going second channels an extra
   *  rune on their first turn (485.7), so going second can afford a slightly
   *  greedier hand. */
  humanGoesFirst: boolean;
  /** Match context ("Game 2 of 3 — you lead 1–0"), shown only in a Best of 3;
   *  absent in a single game, where there's nothing to say. */
  seriesNote?: string;
  onConfirm: (setAsideInstanceIds: string[]) => void;
}

/** The pregame mulligan step: shows the player's 4 dealt cards and lets
 *  them toggle up to 2 to set aside and replace (the real rule — a
 *  one-shot, per-card exchange, not a full-hand redraw; see
 *  execute-mulligan.ts). Clicking past 2 silently no-ops rather than
 *  erroring, matching the "cap, don't error" feel of this app's other
 *  toggle-based selection UIs (e.g. the manual rune-payment feature). */
export function MulliganScreen({ hand, humanGoesFirst, seriesNote, onConfirm }: MulliganScreenProps) {
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
        <span>Mulligan{seriesNote ? ` · ${seriesNote}` : ""}</span>
      </div>

      {/* The card count drives the width half of the card size (see
          `.mulligan-screen` in styles.css) — handed over rather than hardcoded
          to 4 in the stylesheet, so the row keeps fitting if the opening hand
          ever stops being four cards. */}
      <div className="mulligan-screen" style={{ "--mulligan-count": hand.length } as CSSProperties}>
        <div className="banner">Choose up to 2 cards to set aside and replace</div>
        <div className="turn-order-note">
          {humanGoesFirst
            ? "You go first."
            : "The AI goes first — you channel an extra rune on your first turn to compensate."}
        </div>
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
