import { useMemo } from "react";
import { useRowFit } from "./use-row-fit.js";
import { loadRuneArt, type RuneCard } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";

/** Active while the human has a card armed that still owes a rune payment
 *  — turns the (otherwise inert) rune tiles into left-click-for-Energy /
 *  right-click-for-Power controls that STAGE a proposal into that card's
 *  payment (not an immediate submit). A rune proposed both ways at once is
 *  legitimate "double duty" (recycled for Power, its Energy potential
 *  spent directly by the same payment), not a bug. */
export interface PaymentMode {
  kind: "payment";
  proposedEnergyIds: string[];
  proposedPowerIds: string[];
  isRuneEligibleForEnergy: (rune: RuneCard) => boolean;
  isRuneEligibleForPower: (rune: RuneCard) => boolean;
  onRuneLeftClick: (rune: RuneCard) => void;
  onRuneRightClick: (rune: RuneCard) => void;
}

/** Active whenever no card is armed — the real, standalone FloatRune
 *  action (confirmed against the official rules and the Java oracle):
 *  left-click a Ready rune immediately exhausts it for 1 floating Energy;
 *  right-click any rune (Ready or Exhausted) immediately recycles it for 1
 *  floating Power of its domain. Unlike PaymentMode, both clicks submit at
 *  once — there's no proposal being built toward a specific card, since
 *  floating is independent of casting anything. */
export interface FloatMode {
  kind: "float";
  isRuneEligibleForEnergy: (rune: RuneCard) => boolean;
  isRuneEligibleForPower: (rune: RuneCard) => boolean;
  onRuneLeftClick: (rune: RuneCard) => void;
  onRuneRightClick: (rune: RuneCard) => void;
}

/** A tile can only ever be in one mode at a time — a discriminated union
 *  makes that structural rather than a convention two sibling props would
 *  have to maintain by hand. */
export type RuneInteractionMode = PaymentMode | FloatMode;

interface RuneZoneProps {
  runes: RuneCard[];
  mode?: RuneInteractionMode;
}

const DEFAULT_TILE_GAP_PX = 6;

/**
 * A player's channeled-rune pool as its own board zone, sitting next to
 * that player's Base zone (per the user's own layout note — runes used to
 * live tucked into the side rail, easy to miss; as a peer zone to Base,
 * same row, they read the same way the battlefield boxes already do).
 * Keeps the exact tile rendering/interaction previously inline in
 * PlayerSideColumn.tsx — only the container moved, not the logic.
 *
 * Tiles are full card size now (uniform with every other card on screen),
 * which a fixed-width zone can't always fit side by side once the pool
 * grows toward the 12-rune deck's maximum — rather than wrapping to a
 * second row (which forced an internal vertical scrollbar, per the user's
 * own report), this measures the zone's actual available width and fans
 * the tiles out with a computed overlap, so any count always fits in one
 * row without ever scrolling.
 */
export function RuneZone({ runes, mode }: RuneZoneProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  // The fan that keeps any channelled count in one row is shared with the board's
  // other card rows now — see use-row-fit.ts, which this logic was extracted into.
  const { rowRef, marginLeft: tileOffsetPx } = useRowFit(runes.length, DEFAULT_TILE_GAP_PX);

  return (
    <div className="zone card-zone">
      <div className="zone-label">
        Runes ({readyCount}/{runes.length} ready)
      </div>
      <div className="rune-row" ref={rowRef}>
        {runes.map((rune, index) => {
          const art = runeArt[rune.domain];
          const proposedEnergy = (mode?.kind === "payment" && mode.proposedEnergyIds.includes(rune.id)) ?? false;
          const proposedPower = (mode?.kind === "payment" && mode.proposedPowerIds.includes(rune.id)) ?? false;
          const canLeftClick = mode ? proposedEnergy || mode.isRuneEligibleForEnergy(rune) : false;
          const canRightClick = mode ? proposedPower || mode.isRuneEligibleForPower(rune) : false;
          const classes = ["rune-tile"];
          if (rune.state === "Exhausted") classes.push("exhausted");
          if (proposedEnergy) classes.push("proposed-energy");
          if (proposedPower) classes.push("proposed-power");
          if (canLeftClick || canRightClick) classes.push("payable");
          return (
            <div
              key={rune.id}
              className={classes.join(" ")}
              style={{
                borderColor: DOMAIN_COLORS[rune.domain],
                marginLeft: index === 0 ? 0 : tileOffsetPx,
                // Later tiles stack visually on top of earlier ones so an
                // overlapped tile's near (left) edge — including its own
                // click/hover target — is never obscured by its neighbor.
                zIndex: index,
              }}
              title={`${rune.domain} — ${rune.state}${proposedEnergy ? " · proposed for Energy" : ""}${proposedPower ? " · proposed for Power" : ""}`}
              onClick={canLeftClick ? () => mode!.onRuneLeftClick(rune) : undefined}
              onContextMenu={
                canRightClick
                  ? (e) => {
                      e.preventDefault();
                      mode!.onRuneRightClick(rune);
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
