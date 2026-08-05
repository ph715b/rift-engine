import { useMemo } from "react";
import { useRowFit } from "./use-row-fit.js";
import { loadRuneArt, type Domain, type RuneCard } from "@rift-engine/engine";
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
  /** Runes committed to a `[Deflect]` RAINBOW surcharge. A third list rather
   *  than more entries in `proposedPowerIds`, because the tax is genuinely a
   *  different commitment: it is any-domain, it pays an OPPONENT, and unlike
   *  the other two it can never double-duty with them (164.2 is about paying
   *  your own cost). Shown because a rune silently spent is how the board
   *  taught players nothing about where their runes went. */
  proposedRainbowIds: string[];
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

/**
 * The resources a player has already banked but not yet spent.
 *
 * Every one of these was invisible until now, and that is the whole reason this
 * exists: `GameBoard` read `floatingEnergy`/`floatingPower` only to price
 * affordability and rendered neither, so a Seal of Rage correctly adding 1 Fury
 * Power looked exactly like an ability that did nothing. The engine was right and
 * the board simply never said so — reported as "using Seals doesn't add power".
 *
 * Mirrors `PlayerState`'s own fields rather than flattening them, because the
 * three Power pools are genuinely different and a player has to be able to tell
 * them apart: `power` is per-domain and pays a matching pip, `rainbow` pays any
 * pip, and the two `restricted*` pools are spendable only on Spells.
 */
export interface FloatingResources {
  energy: number;
  power: Partial<Record<Domain, number>>;
  rainbow: number;
  restrictedEnergy: number;
  restrictedPower: number;
}

/** The banked-resource readout. Rendered ALWAYS, not only when something is
 *  floating: a counter that appears out of nowhere teaches nothing about where
 *  the resource went, and the empty state is what makes the filled one legible. */
function FloatingReadout({ floating }: { floating: FloatingResources }) {
  const powerChips = (Object.entries(floating.power) as [Domain, number | undefined][]).filter(
    ([, n]) => (n ?? 0) > 0,
  );
  const empty =
    floating.energy === 0 &&
    powerChips.length === 0 &&
    floating.rainbow === 0 &&
    floating.restrictedEnergy === 0 &&
    floating.restrictedPower === 0;

  return (
    <div className="floating-readout" title="Resources you have banked but not yet spent. They persist until spent or the turn ends.">
      <span className="floating-label">Floating</span>
      {empty ? (
        <span className="floating-chip empty">nothing</span>
      ) : (
        <>
          {floating.energy > 0 && (
            <span className="floating-chip energy" title={`${floating.energy} floating Energy`}>
              {floating.energy} Energy
            </span>
          )}
          {floating.restrictedEnergy > 0 && (
            <span className="floating-chip energy restricted" title={`${floating.restrictedEnergy} Energy usable only for Spells`}>
              {floating.restrictedEnergy} Energy (spells)
            </span>
          )}
          {powerChips.map(([domain, n]) => (
            <span
              key={domain}
              className="floating-chip power"
              style={{ borderColor: DOMAIN_COLORS[domain], color: DOMAIN_COLORS[domain] }}
              title={`${n} floating ${domain} Power`}
            >
              {n} {domain}
            </span>
          ))}
          {floating.rainbow > 0 && (
            <span className="floating-chip rainbow" title={`${floating.rainbow} rainbow Power — pays a pip of any domain`}>
              {floating.rainbow} Rainbow
            </span>
          )}
          {floating.restrictedPower > 0 && (
            <span className="floating-chip power restricted" title={`${floating.restrictedPower} Power usable only for Spells`}>
              {floating.restrictedPower} Power (spells)
            </span>
          )}
        </>
      )}
    </div>
  );
}

interface RuneZoneProps {
  runes: RuneCard[];
  mode?: RuneInteractionMode;
  /** Marks this zone as an endpoint for the flying-card animations (see
   *  use-zone-flights.ts). Set only on the human's zone — a rune channelled or
   *  recycled by the AI is not something this board draws a path for. */
  flightAnchor?: string;
  /** Banked-but-unspent resources. Omitted for the AI's zone, whose floating
   *  pools are its own business and are not something the human plays against. */
  floating?: FloatingResources;
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
export function RuneZone({ runes, mode, flightAnchor, floating }: RuneZoneProps) {
  const runeArt = useMemo(() => loadRuneArt(), []);
  const readyCount = runes.filter((r) => r.state === "Ready").length;

  // The fan that keeps any channelled count in one row is shared with the board's
  // other card rows now — see use-row-fit.ts, which this logic was extracted into.
  // Exhausted runes are TAPPED (rotated 90deg), so they lie on their side and need
  // their height's worth of room. Counted here so the fan reserves it and a spent
  // rune can stay the same size as a ready one.
  const exhaustedCount = runes.filter((r) => r.state === "Exhausted").length;
  const { rowRef, marginLeft: tileOffsetPx } = useRowFit(runes.length, DEFAULT_TILE_GAP_PX, exhaustedCount);

  return (
    <div className="zone card-zone" {...(flightAnchor ? { "data-flight-anchor": flightAnchor } : {})}>
      <div className="zone-label">
        Runes ({readyCount}/{runes.length} ready)
      </div>
      {floating && <FloatingReadout floating={floating} />}
      <div className="rune-row" ref={rowRef}>
        {runes.map((rune, index) => {
          const art = runeArt[rune.domain];
          const proposedEnergy = (mode?.kind === "payment" && mode.proposedEnergyIds.includes(rune.id)) ?? false;
          const proposedPower = (mode?.kind === "payment" && mode.proposedPowerIds.includes(rune.id)) ?? false;
          const proposedRainbow = (mode?.kind === "payment" && mode.proposedRainbowIds.includes(rune.id)) ?? false;
          const canLeftClick = mode ? proposedEnergy || mode.isRuneEligibleForEnergy(rune) : false;
          const canRightClick = mode ? proposedPower || mode.isRuneEligibleForPower(rune) : false;
          const classes = ["rune-tile"];
          if (rune.state === "Exhausted") classes.push("exhausted");
          if (proposedEnergy) classes.push("proposed-energy");
          if (proposedPower) classes.push("proposed-power");
          if (proposedRainbow) classes.push("proposed-rainbow");
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
              title={`${rune.domain} — ${rune.state}${proposedEnergy ? " · proposed for Energy" : ""}${proposedPower ? " · proposed for Power" : ""}${proposedRainbow ? " · proposed for [Deflect]" : ""}`}
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
