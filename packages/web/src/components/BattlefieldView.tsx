import type { CSSProperties } from "react";
import { CardView, type DragPoint } from "./CardView.js";
import { useRowFit } from "./use-row-fit.js";
import { useArrivalOrder } from "./use-arrival-order.js";
import { battlefieldCard } from "../battlefield-cards.js";
import { useCardHover } from "../hover-preview.js";
import { defaultCardRegistry } from "@rift-engine/engine";
import type { BattlefieldState, PlayerState, UnitInstance } from "@rift-engine/engine";

interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  /** The attachment badges for a unit standing here — passed in rather than
   *  derived, so there is ONE answer to "what is attached to what" and it lives
   *  in `GameBoard.attachmentProps`. Optional so the many hand-built renders in
   *  tests are unaffected; absent means no badge, which is what every unit
   *  without Equipment shows anyway. */
  attachmentProps?: (unit: UnitInstance) => Record<string, unknown>;
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
  attachmentProps,
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
  const setHovered = useCardHover();
  const humanUnits = battlefield.units[human.id] ?? [];
  const aiUnits = battlefield.units[ai.id] ?? [];

  // Arrival cascade for 144.3's simultaneous moves — see use-arrival-order.ts.
  // Per SIDE, so your three units marching in do not have their timing offset
  // by however many of the opponent's happen to be standing there.
  const humanArrivals = useArrivalOrder(humanUnits.map((u) => u.instanceId));
  const aiArrivals = useArrivalOrder(aiUnits.map((u) => u.instanceId));
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
  // Looked up by name, the only handle BattlefieldState offers. Undefined is a
  // legitimate answer for a deck naming something with no card, and renders as it
  // did before this existed.
  const card = battlefieldCard(battlefield.name);
  const aiFit = useRowFit(aiUnits.length, undefined, aiUnits.filter((u) => u.exhausted).length);
  const humanFit = useRowFit(humanUnits.length, undefined, humanUnits.filter((u) => u.exhausted).length);

  /**
   * Facedown cards, rendered card-sized IN the unit row rather than as a strip.
   *
   * The strip existed for a real reason, recorded in styles.css: the board is a
   * fixed-height 100dvh column and "giving [a facedown card] card-sized real
   * estate would push the battlefield rows into the overflow this project keeps
   * having to defend against". Putting the back INSIDE the row it belongs to
   * settles that — `useRowFit` already fans that row to whatever width it has, so
   * a back costs exactly what one more unit costs and adds no new row. It is also
   * what was actually asked for: a card back where a unit would be.
   *
   * **The `mine` branch is load-bearing and must not be collapsed.** Nothing masks
   * this state — `h.card` carries the real identity for BOTH players — so this
   * branch IS what keeps the opponent's facedown card secret, in the label, the
   * title, the alt text and now the HOVER PREVIEW alike.
   *
   * # Hovering your own shows the card
   *
   * Reported by the project owner: *"want to be able to hover over hidden cards
   * and see the card info."* A `title` tooltip carried the name and nothing else,
   * so the one thing a player needs before spending a turn setting a trap — what
   * the card actually does — was unreadable once it was face down.
   *
   * The preview is raised for YOUR OWN facedown cards only, through the same
   * `useCardHover` channel every other card on the board uses. The opponent's
   * attaches no handler at all: hovering it raises nothing, and the previous
   * card's own `onMouseLeave` has already cleared the overlay, so the result is
   * an empty preview rather than a stale one. **Attaching a handler that fired
   * with `h.card` for both sides would leak the whole card**, which is precisely
   * what the `mine` branch exists to stop — so the guard is repeated here rather
   * than assumed from the label above it.
   */
  function facedownCards(ownerIndex: 0 | 1) {
    return battlefield.hiddenCards
      .filter((h) => h.ownerIndex === ownerIndex)
      .map((h) => {
        const mine = h.ownerIndex === humanIndex;
        const playable = mine && onPlayHidden !== undefined && playableHiddenIds?.has(h.card.instanceId);
        // Only ever built for YOUR OWN card — see the secrecy note above.
        const previewProps = mine
          ? {
              onMouseEnter: () =>
                setHovered({ card: h.card, def: defaultCardRegistry().tryGet(h.card.defId) }),
              onMouseLeave: () => setHovered(null),
              // Keyboard parity: these are real buttons and Tab reaches them, so
              // a preview only the mouse can raise is half a feature.
              onFocus: () => setHovered({ card: h.card, def: defaultCardRegistry().tryGet(h.card.defId) }),
              onBlur: () => setHovered(null),
            }
          : {};
        return (
          <button
            key={h.card.instanceId}
            type="button"
            className={`facedown-card${mine ? " mine" : ""}${playable ? " selectable" : ""}`}
            {...previewProps}
            // **`aria-disabled`, not `disabled`** — a genuinely disabled button
            // dispatches no pointer events and is not focusable, so the hover
            // preview above would be dead for exactly the card you most want to
            // read: one hidden THIS turn, which 811 makes unplayable until your
            // next. Measured, not assumed — the first version used `disabled` and
            // the preview test failed on a card that rendered perfectly.
            //
            // The click is already guarded (`onClick` is undefined unless
            // `playable`), so this changes nothing about what can be pressed. The
            // dimming moved from `:disabled` to `[aria-disabled="true"]` in
            // styles.css with it.
            aria-disabled={!playable}
            title={
              mine
                ? playable
                  ? `${h.card.name} — hidden here. Click to play it for free.`
                  : `${h.card.name} — hidden here. Playable from your next turn (rule 811).`
                : "A facedown card. You can see it is there, not what it is."
            }
            // `stopPropagation` because the battlefield itself is clickable while
            // a unit is selected or it is a target — without this, playing a
            // facedown card ALSO fired `onMoveHere`, so the play was immediately
            // followed by a move/target commit against the same battlefield.
            onClick={
              playable
                ? (event) => {
                    event.stopPropagation();
                    onPlayHidden!(h.card.instanceId, battlefield.id);
                  }
                : undefined
            }
          >
            <span className="facedown-back" aria-hidden="true" />
            <span className="facedown-label">{mine ? h.card.name : "Facedown"}</span>
          </button>
        );
      });
  }

  return (
    <div className={classes.join(" ")} onClick={isClickable ? onMoveHere : undefined} data-dropzone-id={battlefield.id}>
      {/* The battlefield's own CARD, at REAL card size and in its own column.
          Battlefield cards are printed LANDSCAPE, so "real size" is the same card
          stock rotated: its width is a portrait card's HEIGHT and its height is a
          portrait card's WIDTH. Both come from `--board-card-*`, so it scales with
          every other card on the board instead of being sized on its own.

          A COLUMN rather than a strip above the rows, and that is the whole reason
          this can be full size at all: the board is a fixed-height 100dvh grid and
          every card is sized from the SHORTEST row, so height spent here would
          shrink every card in the game (measured before: a hand ROW cost 30px of
          card height at 1600x950). Beside the rows it costs width, which the fan
          in use-row-fit.ts already absorbs.

          Hovering it opens the same preview a unit gets, which is where the full
          rules text now lives — the clamped text that used to sit beside a
          thumbnail had room for three lines and no more. */}
      {card && (
        <div
          className="battlefield-card"
          onMouseEnter={() =>
            setHovered({ kind: "battlefield", name: card.name, imageUrl: card.imageUrl, text: card.text })
          }
          onMouseLeave={() => setHovered(null)}
        >
          <img className="battlefield-card-art" src={card.imageUrl} alt={card.name} loading="lazy" />
        </div>
      )}
      <div className="battlefield-lanes">
        <div className="battlefield-name">
          <span>{battlefield.name}</span>
          <span>{isShowdownActive ? "Showdown!" : controllerName}</span>
        </div>
        {/* THEIR side, farthest from you — the paper table seen from your seat. */}
        <div
          className="battlefield-side enemy"
          ref={aiFit.rowRef}
          style={{ "--row-fit-margin": `${aiFit.marginLeft}px` } as CSSProperties}
        >
          {facedownCards(humanIndex === 0 ? 1 : 0)}
          {aiUnits.map((unit) => (
            <CardView
              key={unit.instanceId}
              card={unit}
              staggerIndex={aiArrivals.get(unit.instanceId) ?? 0}
              isEnemy
              {...(attachmentProps?.(unit) ?? {})}
              isSelectable={isUnitTargetable(unit)}
              isTargetable={isUnitTargetable(unit)}
              isChainTargeted={isUnitChainTargeted(unit)}
              isSelected={chosenUnitIds.has(unit.instanceId)}
              onClick={() => onUnitClick(unit)}
            />
          ))}
        </div>
        {/* YOUR side, nearest you. */}
        <div
          className="battlefield-side mine"
          ref={humanFit.rowRef}
          style={{ "--row-fit-margin": `${humanFit.marginLeft}px` } as CSSProperties}
        >
          {facedownCards(humanIndex)}
          {humanUnits.map((unit) => (
            <CardView
              key={unit.instanceId}
              card={unit}
              staggerIndex={humanArrivals.get(unit.instanceId) ?? 0}
              {...(attachmentProps?.(unit) ?? {})}
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
    </div>
  );
}
