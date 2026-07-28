import { useLayoutEffect, useMemo, useRef, useState } from "react";
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

  const rowRef = useRef<HTMLDivElement>(null);
  const [tileOffsetPx, setTileOffsetPx] = useState(DEFAULT_TILE_GAP_PX);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    function recompute() {
      const row = rowRef.current;
      const firstTile = row?.firstElementChild as HTMLElement | null | undefined;
      if (!row || !firstTile) return;

      const n = runes.length;
      const containerWidth = row.clientWidth;
      const tileWidth = firstTile.offsetWidth;
      if (n <= 1 || tileWidth === 0) {
        setTileOffsetPx(DEFAULT_TILE_GAP_PX);
        return;
      }

      const naturalTotal = n * tileWidth + (n - 1) * DEFAULT_TILE_GAP_PX;
      if (naturalTotal <= containerWidth) {
        setTileOffsetPx(DEFAULT_TILE_GAP_PX);
        return;
      }

      // No floor on how negative this gets — an earlier version clamped
      // overlap at 85% of a tile's width to always keep a visible sliver,
      // but since this row has no overflow:hidden, hitting that floor at
      // an extreme count/narrow width meant the total row width exceeded
      // the container and the excess spilled out past the zone's border
      // (a real breach the user caught visually). Fitting exactly, however
      // much overlap that takes, is what actually guarantees no breach.
      const fitOffset = (containerWidth - n * tileWidth) / (n - 1);
      setTileOffsetPx(fitOffset);
    }

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(row);
    const firstTile = row.firstElementChild;
    if (firstTile) observer.observe(firstTile);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runes.length]);

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
