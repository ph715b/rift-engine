import { useMemo } from "react";
import { loadRuneArt, type RuneCard } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";

/** Present only while the human has a card armed that still owes a rune
 *  payment — turns the (otherwise inert) rune tiles into left-click-for-
 *  Energy / right-click-for-Power controls. A rune proposed both ways at
 *  once is legitimate "double duty" (recycled for Power, its Energy
 *  potential spent directly by the same payment), not a bug. */
export interface PaymentMode {
  proposedEnergyIds: string[];
  proposedPowerIds: string[];
  isRuneEligibleForEnergy: (rune: RuneCard) => boolean;
  isRuneEligibleForPower: (rune: RuneCard) => boolean;
  onRuneLeftClick: (rune: RuneCard) => void;
  onRuneRightClick: (rune: RuneCard) => void;
}

interface RuneZoneProps {
  runes: RuneCard[];
  paymentMode?: PaymentMode;
}

/**
 * A player's channeled-rune pool as its own board zone, sitting next to
 * that player's Base zone (per the user's own layout note — runes used to
 * live tucked into the side rail, easy to miss; as a peer zone to Base,
 * same row, they read the same way the battlefield boxes already do).
 * Keeps the exact tile rendering/interaction previously inline in
 * PlayerSideColumn.tsx — only the container moved, not the logic.
 */
export function RuneZone({ runes, paymentMode }: RuneZoneProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  return (
    <div className="zone card-zone">
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
    </div>
  );
}
