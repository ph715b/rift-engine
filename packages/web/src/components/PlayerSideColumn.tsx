import { useMemo } from "react";
import { loadRuneArt, type GearInstance, type LegendInstance, type RuneCard, type UnitInstance } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { CardView, type DragPoint } from "./CardView.js";
import { PointTracker } from "./PointTracker.js";

/** Present only while the human has a card armed that still owes a rune
 *  payment — turns the (otherwise inert) rune tiles into left-click-for-
 *  Energy / right-click-for-Power controls. A rune proposed both ways at
 *  once is legitimate "double duty" (recycled for Power, its Energy
 *  potential spent directly by the same payment), not a bug. */
interface PaymentMode {
  proposedEnergyIds: string[];
  proposedPowerIds: string[];
  isRuneEligibleForEnergy: (rune: RuneCard) => boolean;
  isRuneEligibleForPower: (rune: RuneCard) => boolean;
  onRuneLeftClick: (rune: RuneCard) => void;
  onRuneRightClick: (rune: RuneCard) => void;
}

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
  /** Pins the Legend/Champion block to the bottom of this column (near the
   *  human player's own hand) instead of the top (the AI's default, next
   *  to its base row) — a pure visual mirror, per the user's own layout
   *  note. */
  legendAtBottom?: boolean;
  isChampionSelectable?: boolean;
  onChampionClick?: () => void;
  onChampionDrag?: (point: DragPoint) => void;
  onChampionDragEnd?: (point: DragPoint) => void;
  paymentMode?: PaymentMode;
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
  legendAtBottom,
  isChampionSelectable,
  onChampionClick,
  onChampionDrag,
  onChampionDragEnd,
  paymentMode,
}: PlayerSideColumnProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  const legendAndChampion = (
    <div className={`side-column-cards${legendAtBottom ? " at-bottom" : ""}`}>
      <CardView card={legend} isEnemy={isEnemy} />
      {champion && (
        <CardView
          card={champion}
          isEnemy={isEnemy}
          isSelectable={isChampionSelectable}
          onClick={onChampionClick}
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

      <div className="zone-label">
        Runes ({readyCount}/{runes.length} ready)
      </div>
      <div className="rune-row">
        {runes.map((rune) => {
          const art = runeArt[rune.domain];
          const proposedEnergy = paymentMode?.proposedEnergyIds.includes(rune.id) ?? false;
          const proposedPower = paymentMode?.proposedPowerIds.includes(rune.id) ?? false;
          const canLeftClick = paymentMode ? proposedEnergy || paymentMode.isRuneEligibleForEnergy(rune) : false;
          const canRightClick = paymentMode ? proposedPower || paymentMode.isRuneEligibleForPower(rune) : false;
          const classes = ["rune-tile"];
          if (rune.state === "Exhausted") classes.push("exhausted");
          if (proposedEnergy) classes.push("proposed-energy");
          if (proposedPower) classes.push("proposed-power");
          if (canLeftClick || canRightClick) classes.push("payable");
          return (
            <div
              key={rune.id}
              className={classes.join(" ")}
              style={{ borderColor: DOMAIN_COLORS[rune.domain] }}
              title={`${rune.domain} — ${rune.state}${proposedEnergy ? " · proposed for Energy" : ""}${proposedPower ? " · proposed for Power" : ""}`}
              onClick={canLeftClick ? () => paymentMode!.onRuneLeftClick(rune) : undefined}
              onContextMenu={
                canRightClick
                  ? (e) => {
                      e.preventDefault();
                      paymentMode!.onRuneRightClick(rune);
                    }
                  : undefined
              }
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

      {legendAtBottom && legendAndChampion}
    </div>
  );
}
