import { motion } from "framer-motion";
import type { CardInstance } from "@rift-engine/engine";

interface CardViewProps {
  card: CardInstance;
  isEnemy?: boolean;
  isSelectable?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
}

/**
 * A single card, anywhere on the board (hand, base, or a battlefield).
 * `layoutId={card.instanceId}` is what gives us card-movement animation for
 * free: the same instanceId re-appearing in a different DOM position after
 * a state update (e.g. hand -> base) is exactly what Framer Motion's shared
 * layout animation detects and smoothly transitions between.
 */
export function CardView({ card, isEnemy, isSelectable, isSelected, onClick }: CardViewProps) {
  const classes = ["card"];
  if (isEnemy) classes.push("enemy");
  if (isSelectable) classes.push("selectable");
  if (isSelected) classes.push("selected");
  if (card.exhausted) classes.push("exhausted");

  return (
    <motion.div
      layoutId={card.instanceId}
      layout
      className={classes.join(" ")}
      onClick={isSelectable ? onClick : undefined}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
    >
      <div className="card-name">{card.name}</div>
      {card.kind === "Unit" && (
        <div className="card-stats">
          <span>{card.energyCost}⚡</span>
          <span>{card.might}💪</span>
        </div>
      )}
      {card.kind === "Legend" && <div className="card-stats">Legend</div>}
    </motion.div>
  );
}
