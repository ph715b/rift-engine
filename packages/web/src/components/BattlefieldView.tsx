import type { CSSProperties } from "react";
import { CardView, type DragPoint } from "./CardView.js";
import { useRowFit } from "./use-row-fit.js";
import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  human: PlayerState;
  ai: PlayerState;
  selectedUnitIds: Set<string>;
  isMoveTarget: boolean;
  /** Is this BATTLEFIELD ITSELF the target of the currently-armed card —
   *  e.g. Firestorm's "deal 3 to all enemy units at a battlefield"? Distinct
   *  from `isMoveTarget`, which is about moving/placing units HERE; both
   *  render the same `.selectable` affordance and both commit through
   *  `onMoveHere`, since GameBoard already knows which of the two a click
   *  means from its own pending-play step. */
  isTargetable: boolean;
  /** Is this battlefield ITSELF named by something on the chain (Firestorm's
   *  "at a battlefield", or a token-placing Spell's destination)? Distinct
   *  from `isTargetable` in both meaning and appearance — see CardView's
   *  `isChainTargeted`. */
  isChainTargeted: boolean;
  isDragOver: boolean;
  /** Which side of the board the viewer is, so their own facedown cards can be
   *  shown face-up to them and the opponent's cannot. */
  humanIndex: 0 | 1;
  /** Facedown cards of the viewer's that can be played right now (rule 811's
   *  "beginning on the next turn"), by instanceId. */
  playableHiddenIds?: Set<string>;
  onPlayHidden?: (cardInstanceId: string, battlefieldId: string) => void;
  isShowdownActive: boolean;
  /** Is this unit a legal target for the currently-armed spell (if any)?
   *  Independent of whose unit it is — a targeted spell in this engine can
   *  affect either player's units at a battlefield. */
  isUnitTargetable: (unit: UnitInstance) => boolean;
  /** Is this unit named as a target by something on the chain? Owner-agnostic
   *  like `isUnitTargetable`, and applied to both sides here. */
  isUnitChainTargeted: (unit: UnitInstance) => boolean;
  /** Should one of the viewer's OWN units here be clickable — ordinarily any
   *  ready unit (move-selection), but only a legal answer while an armed card
   *  is still asking for one. GameBoard owns that rule; this just renders it
   *  (see isFriendlyUnitSelectable there). */
  isFriendlySelectable: (unit: UnitInstance) => boolean;
  /** Units already picked as targets of the armed card — shown with the same
   *  `.selected` outline a move-selected unit gets, so a half-finished
   *  multi-target pick (Gentlemen's Duel) is visible on the board. Covers
   *  enemy units too, unlike `selectedUnitIds`. */
  chosenUnitIds: Set<string>;
  /** Unified click handler for any unit at this battlefield, friendly or
   *  enemy — GameBoard decides whether this commits an armed spell against
   *  the unit or falls through to ordinary move-selection. */
  onUnitClick: (unit: UnitInstance) => void;
  onMoveHere: () => void;
  canDragUnit: (unit: UnitInstance) => boolean;
  onUnitDrag: (unit: UnitInstance, point: DragPoint) => void;
  onUnitDragEnd: (unit: UnitInstance, point: DragPoint) => void;
}

export function BattlefieldView({
  battlefield,
  human,
  ai,
  selectedUnitIds,
  isMoveTarget,
  isTargetable,
  isChainTargeted,
  isDragOver,
  humanIndex,
  playableHiddenIds,
  onPlayHidden,
  isShowdownActive,
  isUnitTargetable,
  isUnitChainTargeted,
  isFriendlySelectable,
  chosenUnitIds,
  onUnitClick,
  onMoveHere,
  canDragUnit,
  onUnitDrag,
  onUnitDragEnd,
}: BattlefieldViewProps) {
  const humanUnits = battlefield.units[human.id] ?? [];
  const aiUnits = battlefield.units[ai.id] ?? [];
  const controllerName =
    battlefield.controllerId === human.id ? "You" : battlefield.controllerId === ai.id ? "AI" : "Uncontrolled";

  const isClickable = isMoveTarget || isTargetable;
  const classes = ["battlefield"];
  if (isClickable) classes.push("selectable");
  // The battlefield ITSELF is the answer being asked for (Firestorm) — same
  // louder treatment a targetable card gets, for the same reason.
  if (isTargetable) classes.push("targetable");
  if (isChainTargeted) classes.push("chain-targeted");
  if (isDragOver) classes.push("drag-over");
  if (isShowdownActive) classes.push("showdown");

  // Same measured fan as every other card row: the CSS-only tuck this replaced
  // could not know the row's width, so a crowded battlefield spilled past its box
  // (measured at 225px once cards became full board size). Exhausted units are
  // TAPPED — rotated, so they lie on their side — and their extra width is
  // reserved rather than absorbed by shrinking them.
  const aiFit = useRowFit(aiUnits.length, undefined, aiUnits.filter((u) => u.exhausted).length);
  const humanFit = useRowFit(humanUnits.length, undefined, humanUnits.filter((u) => u.exhausted).length);

  return (
    <div className={classes.join(" ")} onClick={isClickable ? onMoveHere : undefined} data-dropzone-id={battlefield.id}>
      <div className="battlefield-name">
        <span>{battlefield.name}</span>
        <span>{isShowdownActive ? "Showdown!" : controllerName}</span>
      </div>
      {/* Facedown cards (rule 811). Presence is public and changes how the
          battlefield reads — there is a trick waiting here — while identity is
          not, so the opponent's shows only a back.
          NOTE: this used to claim the state arrives "already masked", so the
          component "cannot leak what it was never given". That is false —
          nothing in the web package masks anything, and `h.card` carries the
          real identity for BOTH players. The `mine` branch below is not a
          convenience over already-safe data, it IS the thing keeping the
          opponent's facedown card secret, in the label and in the title alike.
          Do not collapse it. */}
      {battlefield.hiddenCards.length > 0 && (
        <div className="battlefield-hidden-row">
          {battlefield.hiddenCards.map((h) => {
            const mine = h.ownerIndex === humanIndex;
            const playable = mine && onPlayHidden !== undefined && playableHiddenIds?.has(h.card.instanceId);
            return (
              <button
                key={h.card.instanceId}
                type="button"
                className={`facedown-card${mine ? " mine" : ""}${playable ? " selectable" : ""}`}
                disabled={!playable}
                title={
                  mine
                    ? playable
                      ? `${h.card.name} — hidden here. Click to play it for free.`
                      : `${h.card.name} — hidden here. Playable from your next turn.`
                    : "A facedown card. You can see it is there, not what it is."
                }
                onClick={playable ? () => onPlayHidden!(h.card.instanceId, battlefield.id) : undefined}
              >
                {mine ? h.card.name : "Facedown"}
              </button>
            );
          })}
        </div>
      )}
      <div
        className="battlefield-side"
        ref={aiFit.rowRef}
        style={{ "--row-fit-margin": `${aiFit.marginLeft}px` } as CSSProperties}
      >
        {aiUnits.map((unit) => (
          <CardView
            key={unit.instanceId}
            card={unit}
            isEnemy
            isSelectable={isUnitTargetable(unit)}
            isTargetable={isUnitTargetable(unit)}
            isChainTargeted={isUnitChainTargeted(unit)}
            isSelected={chosenUnitIds.has(unit.instanceId)}
            onClick={() => onUnitClick(unit)}
          />
        ))}
      </div>
      <div
        className="battlefield-side"
        ref={humanFit.rowRef}
        style={{ "--row-fit-margin": `${humanFit.marginLeft}px` } as CSSProperties}
      >
        {humanUnits.map((unit) => (
          <CardView
            key={unit.instanceId}
            card={unit}
            isSelectable={isFriendlySelectable(unit)}
            isTargetable={isUnitTargetable(unit)}
            isChainTargeted={isUnitChainTargeted(unit)}
            isSelected={selectedUnitIds.has(unit.instanceId) || chosenUnitIds.has(unit.instanceId)}
            onClick={() => onUnitClick(unit)}
            onDrag={canDragUnit(unit) ? (info) => onUnitDrag(unit, info) : undefined}
            onDragEnd={canDragUnit(unit) ? (info) => onUnitDragEnd(unit, info) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
