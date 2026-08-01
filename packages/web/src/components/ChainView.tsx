import { AnimatePresence, motion } from "framer-motion";
import type { ChainItemDescription, ChainTargetDescription } from "@rift-engine/engine";
import { CardView } from "./CardView.js";

interface ChainViewProps {
  /** Already newest-first — see the engine's `describeChain`. */
  items: ChainItemDescription[];
  /** The entry that just resolved, held on screen for a beat so the cause is
   *  still visible while its effect lands on the board. Rendered above the
   *  live items (it was the top one) and never interactive. */
  resolving: ChainItemDescription | null;
  humanIndex: 0 | 1;
  /** `state.chainPasses` — shown verbatim rather than translated into a
   *  friendlier fiction, because "how many passes has this had" IS the thing
   *  that decides when it resolves (rule 340). */
  chainPasses: number;
  /** Does the human hold chain priority right now — i.e. is the game waiting
   *  on THEM, or on the opponent? The single most important thing this panel
   *  says, and the thing the old one-line header said least clearly. */
  isHumanResponse: boolean;
  /** Which live item the pointer is over, so the board can narrow its
   *  co-highlight to that item's own targets; null clears it. Indexes into
   *  `items` (i.e. by depth from top), not by chain position. */
  onHoverItem: (index: number | null) => void;
}

/**
 * The chain, as an ordered column with the newest item on top — which is the
 * order it resolves in (rule 343: the newest finalized item resolves first).
 * Before this, `state.spellChain` was rendered nowhere at all: a cast spell
 * was one line of header text ("Spell pending resolution"), so the player had
 * no way to know what the AI had just cast or what it pointed at, and pressed
 * Pass Focus while the effect happened offscreen.
 *
 * Borrows the Java client's chain zone for its legibility only — the "⛓ CHAIN"
 * heading, the `▸` resolves-next marker, hover-for-full-card (ui/
 * BoardController.java's buildChainSection/buildChainRow) — and deliberately
 * NOT its target arrows: those needed a deferred draw plus a forced layout
 * pass, and its own comment records that measuring nodes added in the same
 * pulse returned stale bounds, which is "why the arrow only sometimes
 * appeared". Framer Motion animates via transforms and layoutId here, so the
 * same class of bug would apply. Targets are pointed at by co-highlighting
 * them on the board instead (`.chain-targeted`) — same information, no
 * geometry.
 *
 * Note this panel does NOT act: resolution still goes through the existing
 * Pass Focus button in the actions row. One action surface, not two.
 */
export function ChainView({ items, resolving, humanIndex, chainPasses, isHumanResponse, onHoverItem }: ChainViewProps) {
  const ownerLabel = (playerIndex: 0 | 1) => (playerIndex === humanIndex ? "You" : "AI Opponent");

  return (
    // pointer-events are off on the rail and back on for each live item, so
    // the empty space around the panel never swallows a board click.
    <div className="chain-rail">
      <div className="chain-panel">
        {/* No chain glyph: the Java client's "⛓ CHAIN" heading relies on a
            JavaFX font that has it, and Segoe UI renders U+26D3 as tofu here. */}
        <div className="chain-heading">Chain{items.length > 1 ? ` · ${items.length} items` : ""}</div>
        <AnimatePresence initial={false}>
          {resolving && (
            <ChainItem
              key="resolving"
              item={resolving}
              ownerLabel={ownerLabel(resolving.playerIndex)}
              badge="Resolving…"
              isResolving
            />
          )}
          {items.map((item, index) => (
            <ChainItem
              key={item.key}
              item={item}
              ownerLabel={ownerLabel(item.playerIndex)}
              badge={item.depthFromTop === 0 ? "▸ Resolves next" : `#${item.depthFromTop + 1}`}
              onHoverChange={(hovered) => onHoverItem(hovered ? index : null)}
            />
          ))}
        </AnimatePresence>
        {items.length > 0 && (
          <div className={`chain-status${isHumanResponse ? " chain-status-yours" : ""}`}>
            {isHumanResponse ? "Your response — Pass Focus to let it resolve" : "Waiting for AI Opponent…"}
            <span className="chain-passes">{chainPasses} of 2 passes</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface ChainItemProps {
  item: ChainItemDescription;
  ownerLabel: string;
  badge: string;
  isResolving?: boolean;
  onHoverChange?: (hovered: boolean) => void;
}

function ChainItem({ item, ownerLabel, badge, isResolving, onHoverChange }: ChainItemProps) {
  const classes = ["chain-item"];
  if (item.depthFromTop === 0 && !isResolving) classes.push("chain-item-next");
  if (isResolving) classes.push("resolving");

  return (
    <motion.div
      className={classes.join(" ")}
      // Opacity/transform only, deliberately: no `layout` prop and nothing
      // measured, so none of this can go wrong the way a geometry-based
      // overlay would (see this file's own note on arrows).
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18 }}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
    >
      <div className="chain-item-badge">{badge}</div>
      <div className="chain-item-body">
        {/* A distinct layoutKey, not the default instanceId: the spell is
            already in the caster's trash at this point (it's trashed at cast
            time), so an open trash browser would otherwise mount a second
            element sharing this one's layoutId. Hovering it still pops the
            full art/rules text through the ordinary hover-preview context —
            which is exactly why the card itself is here and not just its
            name.

            A triggered ability has no card of its own to show: its source is a
            permanent still on the board, or already in a trash if it was a
            [Deathknell]. It gets a marker instead, so the row still reads as a real
            chain item rather than a blank — the player is being asked to pass at
            it. */}
        {item.kind === "spell" ? (
          <CardView card={item.entry.card} layoutKey={`chain:${item.entry.card.instanceId}`} inPile />
        ) : (
          <div className="chain-item-trigger" aria-hidden>
            ⚡
          </div>
        )}
        <div className="chain-item-text">
          <div className="chain-item-name">{item.cardName}</div>
          <div className="chain-item-owner">{ownerLabel}</div>
          {item.targets.map((target, i) => (
            <div className="chain-item-target" key={i}>
              <span className="chain-item-target-line">{targetLine(target)}</span>
              {targetQualifier(target) && <span className="chain-item-target-where">{targetQualifier(target)}</span>}
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

/** What the entry points at, phrased per relationship — a target is not the
 *  same claim as a paid cost or a deployment destination, and flattening all
 *  five into one "→ X" list would say something untrue about three of them.
 *  The wording stays factual (what the entry names) rather than describing the
 *  effect: the card's own printed text is one hover away, and paraphrasing it
 *  here would need per-card knowledge this component has no business having. */
function targetLine(target: ChainTargetDescription): string {
  const gone = target.missing ? " (no longer there)" : "";
  switch (target.kind) {
    case "unit":
    case "battlefield":
      return `→ ${target.name}${gone}`;
    case "additionalCost":
      return `exhausting ${target.name}${gone}`;
    case "trashCard":
      return `returning ${target.name}${gone}`;
    case "destination":
      return `deploying to ${target.name}${gone}`;
  }
}

/** Where a targeted unit actually stands. Base matters as much as a
 *  battlefield does — a spell reaching into a base ("Deal 8 to a unit") is a
 *  real and easily-missed case. */
function targetQualifier(target: ChainTargetDescription): string | null {
  if (target.battlefieldName === undefined) return null;
  return target.battlefieldName ?? "in base";
}
