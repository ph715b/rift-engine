import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { defaultCardRegistry, loadTokenArt, type CardInstance } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { useCardHover } from "../hover-preview.js";
import { useDragGhost } from "../drag-ghost.js";

export interface DragPoint {
  x: number;
  y: number;
}

/** Parsed once at module load, not per card: a created token (Recruit) has no
 *  CardDefinition to look art up from, since Token-supertype entries are
 *  filtered out of the playable pool — see loadTokenArt. */
const TOKEN_ART = loadTokenArt();

/** Framer Motion's own PanInfo.point coordinate space is ambiguous across
 *  versions/input types; reading clientX/Y straight off the raw event is
 *  what `document.elementFromPoint` (viewport coordinates) actually needs. */
function clientPoint(event: MouseEvent | TouchEvent | PointerEvent): DragPoint {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 };
}

interface CardViewProps {
  card: CardInstance;
  isEnemy?: boolean;
  isSelectable?: boolean;
  isSelected?: boolean;
  /** This card is a legal ANSWER to the question the currently-armed card is
   *  asking (a target, a pair's second target, an additional cost, a trash
   *  pick). Rendered far louder than plain `isSelectable`, which is true for
   *  most cards most of the time and so can only ever be a whisper: when the
   *  board is asking "which one?", exactly the valid ones must be obvious. */
  isTargetable?: boolean;
  /** This card is named as a target by something currently ON THE CHAIN — a
   *  spell that has been cast but hasn't resolved yet. Deliberately a
   *  different visual from `isTargetable` (see `.chain-targeted` in
   *  styles.css): that one means "you can click this", this one means
   *  "something is about to happen to this", and confusing the two would make
   *  the board look interactive during a window where it isn't. */
  isChainTargeted?: boolean;
  /** A hand/champion card that CAN'T be played right now — dimmed, so the
   *  hand reads at a glance, and still clickable via `onUnavailableClick` to
   *  say why. */
  isUnplayable?: boolean;
  onClick?: () => void;
  /** Fired instead of `onClick` when the card isn't selectable — the only
   *  way an unplayable card can explain itself, since `onClick` is
   *  deliberately not wired in that state. */
  onUnavailableClick?: () => void;
  /** Why this card is unplayable, as a thunk so the reason is only computed
   *  for the one card actually being hovered rather than for every card in
   *  hand on every render. Surfaces in the hover preview. */
  unavailableNote?: () => string;
  /** This card is being shown as part of a PILE (a trash browser, a chooser)
   *  rather than as a card in play, so its exhausted state — a fact about
   *  units on the board — isn't rendered. A unit that happened to die
   *  exhausted would otherwise lie on its side in the trash, implying a
   *  tapped state that means nothing there. */
  inPile?: boolean;
  /** Overrides the Framer Motion `layoutId`, which defaults to
   *  `card.instanceId` so the same card re-appearing elsewhere animates
   *  between the two positions. Needed wherever ONE card instance can be
   *  mounted TWICE at the same time, since a duplicated layoutId makes Framer
   *  Motion try to animate an element to itself: a cast Spell is put in the
   *  caster's trash immediately (execute-play-card.ts) while it's still on the
   *  chain, so the chain viewer and an open trash browser can render the same
   *  instance simultaneously. The chain passes a prefixed key; the cost is
   *  only that a card doesn't visually fly from hand INTO the chain (its own
   *  enter/exit spring still plays). */
  layoutKey?: string;
  /** When set, the card can be dragged; drop-zone detection is the caller's
   *  job (see App.tsx's `dropZoneAt`) since it needs the full board layout,
   *  not just this one card. */
  onDragEnd?: (point: DragPoint) => void;
  onDrag?: (point: DragPoint) => void;
  /**
   * The Equipment attached to this UNIT, and the Might they add.
   *
   * **Attachment was completely invisible on the board until 2026-08-07** —
   * nothing in `packages/web` read `attachedToInstanceId`, and `equipment.js`
   * was not even exported from the engine index. So a unit whose Might had gone
   * up by 2 showed the new number with nothing on screen saying why, and 43 SFD
   * cards turned on a relationship the player could not see.
   *
   * Passed in rather than looked up here, because this component is
   * presentational and resolves only the card DEFINITION — the attachment is
   * live game state and belongs to the caller that has it.
   */
  attachedEquipment?: readonly { instanceId: string; name: string; defId: string }[];
  /** The Might those Equipment add, for the badge's title. Separate from the
   *  list because it is the engine's sum (`equipmentMightBonusFor`), not
   *  something to re-derive from names here. */
  attachedMightBonus?: number;
  /** For a GEAR: the name of the unit wearing it. The other half of the same
   *  question — gear sits in a flat row with no visual link to its wearer, so
   *  without this an attached Equipment and a loose one look identical. */
  attachedToUnitName?: string;
  /** This unit's CURRENT Might — printed plus buffs, this-turn pumps, auras and
   *  attached Equipment. Supplied by `GameBoard.attachmentProps`, the one place
   *  that derives per-unit display facts, so the board cannot come to a
   *  different number than the engine. Absent for a card with no board context
   *  (hand, champion zone), where the printed Might IS the answer. */
  currentMight?: number;
}

/**
 * A single card, anywhere on the board (hand, base, or a battlefield).
 * `layoutId={card.instanceId}` is what gives us card-movement animation for
 * free: the same instanceId re-appearing in a different DOM position after
 * a state update (e.g. hand -> base) is exactly what Framer Motion's shared
 * layout animation detects and smoothly transitions between.
 *
 * Drag is additive, not a replacement for click: `isSelectable` still
 * drives the click-to-select/click-target flow, `onDragEnd` layers a drag
 * gesture on top of the same legal-move check. `dragSnapToOrigin` means an
 * invalid drop (no matching drop zone) always springs back — the actual
 * move only ever happens by committing a real action and letting the
 * layout animation carry the card to its new state-driven position, never
 * by leaving the dragged element wherever it was released.
 *
 * `card` (the runtime CardInstance) only carries gameplay state — for
 * display-only data the definition has but the instance doesn't (art,
 * which Power domain a cost belongs to), this looks the definition up by
 * `defId` via the shared registry. Keeps the engine's runtime type lean;
 * this is purely a presentation concern.
 */

/**
 * One attached Equipment's face: its art, and ALWAYS its name.
 *
 * The name is not a no-art fallback. Only the bottom edge of this card sticks
 * out from under its wearer, so the band the player can actually read shows the
 * MIDDLE of the artwork — which does not say which Equipment it is. The name
 * strip is pinned to that protruding edge and drawn over the art.
 *
 * Its own component so the registry lookup is per gear rather than a second
 * branch inside CardView's already-long body.
 */
function AttachedFace({ defId, name }: { defId: string; name: string }) {
  const art = defaultCardRegistry().tryGet(defId)?.imageUrl;
  return (
    <>
      {art && <img className="attached-art" src={art} alt="" draggable={false} loading="lazy" />}
      <span className="attached-name">{name}</span>
    </>
  );
}

export function CardView({
  card,
  isEnemy,
  isSelectable,
  isSelected,
  isTargetable,
  isChainTargeted,
  isUnplayable,
  attachedEquipment,
  attachedMightBonus,
  attachedToUnitName,
  currentMight,
  onClick,
  onUnavailableClick,
  unavailableNote,
  inPile,
  layoutKey,
  onDragEnd,
  onDrag,
}: CardViewProps) {
  // Real React state, not whileDrag: Framer Motion's whileDrag animation
  // object silently drops `pointerEvents` (confirmed via computed style —
  // it never reaches the DOM), so it has to be a genuine style prop instead.
  // Load-bearing, not cosmetic: Framer Motion moves this element via a CSS
  // transform without reparenting it, so mid-drag it's still visually on
  // top of whatever's underneath. Without pointerEvents:none while
  // dragging, document.elementFromPoint(x, y) (how App.tsx finds the drop
  // zone) hits THIS card instead of the battlefield/zone it's hovering
  // over, and .closest() then walks its ORIGINAL parent chain — every drop
  // silently resolves to the card's own starting zone.
  const [isDragging, setIsDragging] = useState(false);

  const def = useMemo(() => defaultCardRegistry().tryGet(card.defId), [card.defId]);
  const artUrl = def?.imageUrl || (card.isToken ? TOKEN_ART[card.defId] : undefined);
  const setHovered = useCardHover();
  const setDragGhost = useDragGhost();

  const classes = ["card"];
  if (isEnemy) classes.push("enemy");
  if (isSelectable) classes.push("selectable");
  if (isTargetable) classes.push("targetable");
  if (isChainTargeted) classes.push("chain-targeted");
  if (isUnplayable) classes.push("unplayable");
  if (isSelected) classes.push("selected");
  const showExhausted = Boolean(card.exhausted) && !inPile;
  if (showExhausted) classes.push("exhausted");
  if (onDragEnd) classes.push("draggable");
  // **The card clips its own overflow**, so an Equipment tucked under the
  // wearer is invisible without this — which is exactly how the first attempt
  // shipped: the elements were in the DOM, the tests asserted they were, and
  // nothing could be seen on the board. Opened up only for a unit that HAS
  // attachments, so every other card keeps its clipping.
  const hasAttached = card.kind === "Unit" && (attachedEquipment?.length ?? 0) > 0;
  if (hasAttached) classes.push("has-attached");

  const powerDomainColor = def && "powerDomain" in def && def.powerDomain ? DOMAIN_COLORS[def.powerDomain] : undefined;

  return (
    <motion.div
      layoutId={layoutKey ?? card.instanceId}
      layout
      className={classes.join(" ")}
      style={isDragging ? { pointerEvents: "none" } : undefined}
      onClick={
        isSelectable || onUnavailableClick
          ? (e) => {
              // A card's own click always wins over whatever zone it sits
              // inside (a battlefield/base zone with its own onClick for
              // moving/placing there) — without this, clicking a unit could
              // silently double-fire both handlers on the same click.
              e.stopPropagation();
              if (isSelectable) onClick?.();
              else onUnavailableClick?.();
            }
          : undefined
      }
      onMouseEnter={() => setHovered({ card, def, ...(isUnplayable && unavailableNote ? { note: unavailableNote() } : {}) })}
      onMouseLeave={() => setHovered(null)}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, rotate: showExhausted ? 90 : 0 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
      drag={Boolean(onDragEnd)}
      dragSnapToOrigin
      dragElastic={0.15}
      // opacity here (not just pointerEvents) because the ghost portal (see
      // drag-ghost.tsx) is now the actually-visible drag indicator — this
      // original element still exists and still moves (that's how Framer
      // Motion fires drag events at all), it's just faded near-invisible so
      // the ghost is what the eye follows.
      whileDrag={{ scale: 1.06, zIndex: 50, opacity: 0.12 }}
      onDragStart={
        onDragEnd
          ? (e) => {
              setIsDragging(true);
              const p = clientPoint(e);
              setDragGhost({ card, def, x: p.x, y: p.y });
            }
          : undefined
      }
      onDrag={
        onDrag
          ? (e) => {
              const p = clientPoint(e);
              onDrag(p);
              setDragGhost({ card, def, x: p.x, y: p.y });
            }
          : undefined
      }
      onDragEnd={
        onDragEnd
          ? (e) => {
              setIsDragging(false);
              setDragGhost(null);
              onDragEnd(clientPoint(e));
            }
          : undefined
      }
    >
      {hasAttached && (
        // **Attached Equipment, laid out the way paper does it**: the gear card
        // tucked UNDER its wearer and skewed, so the name line still reads.
        //
        // Reported from playtesting — "more clear view of what equipment is
        // attached to what unit". Before this the only signals were a small
        // badge on the unit and a badge on the gear naming its wearer, and the
        // gear itself stayed in the flat gear row: the relationship existed but
        // took two hovers in two places to read. 43 SFD cards plus UNL's five
        // turn on it.
        //
        // Rendered BEFORE the art in source order so it paints underneath
        // without needing a negative z-index, which would put it behind the card
        // background too. Each further piece fans a little more, so two
        // Equipment on one unit are individually visible rather than exactly
        // overlapping.
        <div className="attached-stack" aria-hidden="true">
          {attachedEquipment!.map((gear, i) => (
            <div key={gear.instanceId} className="attached-card" style={{ ["--fan" as string]: String(i) }}>
              <AttachedFace defId={gear.defId} name={gear.name} />
            </div>
          ))}
        </div>
      )}
      {artUrl ? (
        // The real card art already prints name/cost/might as part of its own
        // design — showing our own text overlay on top of it would just
        // duplicate that info. The overlay below is the fallback for the
        // (rare/never, in the current OGN+OGS pool) case where art is missing.
        <img className="card-art" src={artUrl} alt={card.name} draggable={false} loading="lazy" />
      ) : (
        <div className="card-info card-info-fallback">
          <div className="card-name">{card.name}</div>
          {(card.kind === "Unit" || card.kind === "Spell" || card.kind === "Gear") && (
            <div className="card-stats">
              {card.energyCost > 0 && <span className="stat-badge stat-energy">{card.energyCost}</span>}
              {card.powerCost > 0 && (
                <span
                  className="stat-badge stat-power"
                  style={powerDomainColor ? { background: powerDomainColor } : undefined}
                >
                  {card.powerCost}
                </span>
              )}
              {card.kind === "Unit" && <span className="stat-badge stat-might">{currentMight ?? card.might}</span>}
            </div>
          )}
        </div>
      )}
      {card.kind === "Unit" && currentMight !== undefined && currentMight !== card.might && (
        // **The current Might, drawn OVER the card art.**
        //
        // The stat block above renders only in the art-less FALLBACK — the real
        // art already prints name, cost and Might, so duplicating them was
        // pointless. But that means when a modifier moves a unit's Might, the
        // only number on screen is the printed one on the art, and it is wrong.
        // That is the reported complaint exactly: "a number over the actual
        // number on the card showing how much might it is at".
        //
        // So this renders ONLY when the two differ. A card sitting at its
        // printed Might shows nothing extra and the art speaks for itself, which
        // is why this is not simply the stat block moved out.
        //
        // The printed value rides along, struck through: a bare changed number
        // cannot be told from a card the player misremembered.
        <div
          className="might-overlay"
          title={`Might ${currentMight} — printed ${card.might}`}
          aria-label={`Current Might ${currentMight}, printed ${card.might}`}
        >
          <span className="stat-might-printed">{card.might}</span>
          <span className="stat-might-current">{currentMight}</span>
        </div>
      )}
      {card.kind === "Gear" && attachedToUnitName !== undefined && (
        // Gear renders in a flat row with no spatial link to its wearer, so an
        // attached Equipment and a loose one are otherwise identical on screen —
        // and "is this attached?" is a question several cards turn on (The Zero
        // Drive's "use only if unattached", Spinning Axe's "if this is
        // unattached, kill it").
        <div className="card-status-badges">
          <span className="status-badge status-attached" title={`Attached to ${attachedToUnitName}`}>
            ⚔
          </span>
        </div>
      )}
      {/* **`[Empowered]` (441 / 828) is on GEAR as well as units**, so it gets its
          own block rather than joining the unit badges below. 827.1.a puts the
          keyword on "permanents and legends", and Vendetta prints it on four
          Gear — folding it into a `kind === "Unit"` branch would have shipped the
          status visible on some of the cards that can hold it, which is the kind
          of half-delivery that reads as working. */}
      {card.kind === "Gear" && card.empowered === true && (
        <div className="card-status-badges">
          <span className="status-badge status-empowered" title="Empowered — its [Empowered] ability is active">
            ✦
          </span>
        </div>
      )}
      {card.kind === "Unit" &&
        (card.damage > 0 ||
          card.mightThisTurn !== 0 ||
          card.buffed ||
          card.stunned ||
          card.empowered === true ||
          (attachedEquipment?.length ?? 0) > 0) && (
        // Rendered regardless of real-art-vs-fallback — real card art never
        // prints marked damage, a Buff, or a this-turn modifier, since those are
        // runtime state, not part of the card's design.
        <div className="card-status-badges">
          {card.damage > 0 && (
            <span className="status-badge status-damage" title={`${card.damage} damage marked`}>
              −{card.damage}
            </span>
          )}
          {card.mightThisTurn !== 0 && (
            <span
              className={`status-badge ${card.mightThisTurn > 0 ? "status-buff" : "status-debuff"}`}
              title={`${card.mightThisTurn > 0 ? "+" : ""}${card.mightThisTurn} Might this turn`}
            >
              {card.mightThisTurn > 0 ? "+" : ""}
              {card.mightThisTurn}
            </span>
          )}
          {/* A Buff is its own badge, not folded into the number above: it's
              worth +1 Might but it PERSISTS past this turn and several cards
              read it back ("while I'm buffed"), so "does this unit have a buff"
              is a question the board has to be able to answer at a glance. */}
          {card.buffed && (
            <span className="status-badge status-buff" title="Buffed — +1 Might, until spent or this unit leaves play">
              ★
            </span>
          )}
          {/* Its own badge rather than folded into the Might number, for the
              reason the Buff above has one: the Might is already included in
              what the card shows, and the question a player is asking is WHICH
              Equipment — which only the title can answer. Counted, so two
              Equipment read as two without needing two badges. */}
          {(attachedEquipment?.length ?? 0) > 0 && (
            <span
              className="status-badge status-attached"
              title={
                `Equipped: ${attachedEquipment!.map((g) => g.name).join(", ")}` +
                ((attachedMightBonus ?? 0) > 0 ? ` (+${attachedMightBonus} Might)` : "")
              }
            >
              ⚔{attachedEquipment!.length > 1 ? attachedEquipment!.length : ""}
            </span>
          )}
          {/* **STUNNED has been an engine mechanic with no board affordance for
              longer than Empowered**, and it is the more urgent of the two: 423.1
              makes it a binary state that stops a unit contributing its Might in
              the damage step, so a player reading the board could not tell why
              their combat maths was wrong. It clears in step 3d of end-of-turn
              cleanup, which the title says so nobody reads it as permanent. */}
          {card.stunned && (
            <span className="status-badge status-stunned" title="Stunned — contributes no Might; clears at end of turn">
              ✷
            </span>
          )}
          {/* 828.1.c: the dependent ability is active "as long as" the status
              holds, and 442 lets an opponent take it away — so this is a
              question the board has to answer at a glance, exactly as the Buff
              above is. Distinct glyph from the Buff's ★, because a player who
              confuses them mis-reads which effects are live. */}
          {card.empowered === true && (
            <span className="status-badge status-empowered" title="Empowered — its [Empowered] ability is active">
              ✦
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}
