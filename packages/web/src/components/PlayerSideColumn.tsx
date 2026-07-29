import type { GearInstance, LegendInstance, UnitInstance } from "@rift-engine/engine";
import { CardView, type DragPoint } from "./CardView.js";
import { PointTracker } from "./PointTracker.js";

interface PlayerSideColumnProps {
  label: string;
  points: number;
  handCount?: number;
  legend: LegendInstance;
  champion: UnitInstance | null;
  trashCount: number;
  /** Opens this player's trash for browsing. Wired for BOTH players — a
   *  trash pile is public information in Riftbound, so hiding the
   *  opponent's would be withholding something they could just ask to see
   *  across a real table. */
  onViewTrash?: () => void;
  banishedCount: number;
  runeDeckCount: number;
  activeGear: GearInstance[];
  isEnemy?: boolean;
  /** Pins the Legend/Champion block to the bottom of this column (near the
   *  human player's own hand) instead of the top (the AI's default, next
   *  to its base row) — a pure visual mirror, per the user's own layout
   *  note. */
  legendAtBottom?: boolean;
  isChampionSelectable?: boolean;
  /** The champion can't be played right now (on the viewer's own turn) —
   *  dimmed, matching how the hand renders its own unplayable cards. */
  isChampionUnplayable?: boolean;
  onChampionClick?: () => void;
  /** Clicking the champion while it ISN'T playable — explains why rather
   *  than doing nothing (see GameBoard's unplayableReason). */
  onChampionUnavailableClick?: () => void;
  /** The same explanation, surfaced on hover via the card preview. */
  championUnavailableNote?: () => string;
  onChampionDrag?: (point: DragPoint) => void;
  onChampionDragEnd?: (point: DragPoint) => void;
}

/**
 * A player's full "meta" column — everything that isn't hand/base/
 * battlefield/rune cards: Legend, Champion (reserve), score, and the
 * Trash/Banished/remaining-rune-deck counts. Lives in one of the two side
 * rails flanking the board's central column (battlefields/base/hand). The
 * channeled-rune pool itself lives in `RuneZone`, its own board zone next
 * to each player's Base zone — per the user's own layout note, runes used
 * to live here too, tucked into a narrow side rail where they were easy to
 * miss; as a peer zone to Base they read the same way the battlefield
 * boxes already do.
 */
export function PlayerSideColumn({
  label,
  points,
  handCount,
  legend,
  champion,
  trashCount,
  onViewTrash,
  banishedCount,
  runeDeckCount,
  activeGear,
  isEnemy,
  legendAtBottom,
  isChampionSelectable,
  isChampionUnplayable,
  onChampionClick,
  onChampionUnavailableClick,
  championUnavailableNote,
  onChampionDrag,
  onChampionDragEnd,
}: PlayerSideColumnProps) {
  const legendAndChampion = (
    <div className={`side-column-cards${legendAtBottom ? " at-bottom" : ""}`}>
      <CardView card={legend} isEnemy={isEnemy} />
      {champion && (
        <CardView
          card={champion}
          isEnemy={isEnemy}
          isSelectable={isChampionSelectable}
          isUnplayable={isChampionUnplayable}
          onClick={onChampionClick}
          onUnavailableClick={onChampionUnavailableClick}
          unavailableNote={championUnavailableNote}
          onDrag={onChampionDrag}
          onDragEnd={onChampionDragEnd}
        />
      )}
    </div>
  );

  return (
    <div className="zone side-column">
      <div className="side-column-header">
        <span>
          {label} — <strong>{points} pts</strong>
          {handCount !== undefined && <span className="side-column-hand-count"> · hand: {handCount}</span>}
        </span>
        <PointTracker points={points} />
      </div>

      {!legendAtBottom && legendAndChampion}

      <div className="side-column-meta">
        <span title="Rune deck remaining">Rune deck: {runeDeckCount}</span>
        {onViewTrash && trashCount > 0 ? (
          <button className="side-column-link" title="View this trash pile (public information)" onClick={onViewTrash}>
            Trash: {trashCount}
          </button>
        ) : (
          <span title="Trash">Trash: {trashCount}</span>
        )}
        <span title="Banished">Banished: {banishedCount}</span>
        <span title="Gear in play, unattached">Gear: {activeGear.length}</span>
      </div>

      {legendAtBottom && legendAndChampion}
    </div>
  );
}
