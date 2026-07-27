import { useMemo } from "react";
import { loadRuneArt, type GearInstance, type LegendInstance, type RuneCard, type UnitInstance } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { CardView, type DragPoint } from "./CardView.js";
import { PointTracker } from "./PointTracker.js";

interface PlayerSideColumnProps {
  label: string;
  points: number;
  handCount?: number;
  legend: LegendInstance;
  champion: UnitInstance | null;
  runes: RuneCard[];
  trashCount: number;
  banishedCount: number;
  runeDeckCount: number;
  activeGear: GearInstance[];
  isEnemy?: boolean;
  isChampionSelectable?: boolean;
  onChampionClick?: () => void;
  onChampionDrag?: (point: DragPoint) => void;
  onChampionDragEnd?: (point: DragPoint) => void;
}

/**
 * A player's full "meta" column — everything that isn't hand/base/
 * battlefield cards: Legend, Champion (reserve), channeled runes, score, and
 * the Trash/Banished/remaining-rune-deck counts. Lives in one of the two
 * side rails flanking the board's central column (battlefields/base/hand),
 * per the user's own layout note: those rails were previously unused
 * horizontal space at wide aspect ratios, while Legend/Champion/rune-pool
 * used to eat a full-width row out of the vertical (scroll-constrained)
 * budget instead. Moving them here is a pure space trade, not a new zone —
 * Trash/Banished/rune-deck counts are the one genuinely new thing (state
 * that already existed on PlayerState but was never surfaced in the UI).
 */
export function PlayerSideColumn({
  label,
  points,
  handCount,
  legend,
  champion,
  runes,
  trashCount,
  banishedCount,
  runeDeckCount,
  activeGear,
  isEnemy,
  isChampionSelectable,
  onChampionClick,
  onChampionDrag,
  onChampionDragEnd,
}: PlayerSideColumnProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  return (
    <div className="zone side-column">
      <div className="side-column-header">
        <span>
          {label} — <strong>{points} pts</strong>
          {handCount !== undefined && <span className="side-column-hand-count"> · hand: {handCount}</span>}
        </span>
        <PointTracker points={points} />
      </div>

      <div className="side-column-cards">
        <CardView card={legend} isEnemy={isEnemy} compact />
        {champion && (
          <CardView
            card={champion}
            isEnemy={isEnemy}
            isSelectable={isChampionSelectable}
            onClick={onChampionClick}
            onDrag={onChampionDrag}
            onDragEnd={onChampionDragEnd}
            compact
          />
        )}
      </div>

      <div className="zone-label">
        Runes ({readyCount}/{runes.length} ready)
      </div>
      <div className="rune-row">
        {runes.map((rune) => {
          const art = runeArt[rune.domain];
          return (
            <div
              key={rune.id}
              className={`rune-tile${rune.state === "Exhausted" ? " exhausted" : ""}`}
              style={{ borderColor: DOMAIN_COLORS[rune.domain] }}
              title={`${rune.domain} — ${rune.state}`}
            >
              {art ? (
                <img src={art} alt={rune.domain} draggable={false} />
              ) : (
                <span className="rune-tile-fallback" style={{ background: DOMAIN_COLORS[rune.domain] }} />
              )}
            </div>
          );
        })}
      </div>

      <div className="side-column-meta">
        <span title="Rune deck remaining">Rune deck: {runeDeckCount}</span>
        <span title="Trash">Trash: {trashCount}</span>
        <span title="Banished">Banished: {banishedCount}</span>
        <span title="Gear in play, unattached">Gear: {activeGear.length}</span>
      </div>
    </div>
  );
}
