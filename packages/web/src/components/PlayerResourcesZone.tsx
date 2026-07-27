import { useMemo } from "react";
import { loadRuneArt, type LegendInstance, type RuneCard, type UnitInstance } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { CardView, type DragPoint } from "./CardView.js";

interface PlayerResourcesZoneProps {
  label: string;
  legend: LegendInstance;
  champion: UnitInstance | null;
  runes: RuneCard[];
  isEnemy?: boolean;
  isChampionSelectable?: boolean;
  onChampionClick?: () => void;
  onChampionDrag?: (point: DragPoint) => void;
  onChampionDragEnd?: (point: DragPoint) => void;
}

/**
 * One compact row per player combining three things that were previously
 * either missing or split across separate rows: the Legend (always face-up
 * in its own zone per Player.java's doc comment), the Champion (sitting in
 * reserve in its own zone until played — see execute-play-card.ts's
 * Champion Zone fix), and the channeled rune pool. Combined into one row
 * (rather than 3 separate compact zones per side) specifically to stay
 * within the no-scroll viewport budget — every extra row competes with the
 * same fixed vertical space.
 */
export function PlayerResourcesZone({
  label,
  legend,
  champion,
  runes,
  isEnemy,
  isChampionSelectable,
  onChampionClick,
  onChampionDrag,
  onChampionDragEnd,
}: PlayerResourcesZoneProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  return (
    <div className="zone compact-zone">
      <div className="zone-label">
        {label} — runes ({readyCount}/{runes.length} ready)
      </div>
      <div className="resources-row">
        <div className="resources-cards">
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
      </div>
    </div>
  );
}
