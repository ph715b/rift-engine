import type { ReactNode } from "react";

interface ChoiceOverlayProps {
  title: string;
  /** Secondary line under the title — the card's own printed reason for
   *  asking, when that's clearer than the title alone. */
  subtitle?: string;
  /** Omitted for a MANDATORY choice — see the note on cancellability below. */
  onCancel?: () => void;
  /** Defaults to "Cancel" — read-only uses (browsing a trash pile) say
   *  "Close" instead, since there's nothing being backed out of. */
  cancelLabel?: string;
  children: ReactNode;
}

/**
 * A modal panel over the board for the choices that AREN'T a board click —
 * picking a card out of your own trash, and [Vision]'s keep-or-recycle. Both
 * are choices about cards in zones the board doesn't render as clickable
 * cards at all (trash is a bare count in PlayerSideColumn; the deck's top
 * card is by definition unseen), which is exactly why they need a surface of
 * their own rather than another click target on the board.
 *
 * Mirrors the Java client's two equivalent dialogs — showTrashDialog
 * (ui/BoardController.java:2015-2111) and showPendingChoiceDialog (:2133+,
 * whose doc comment names "Vision's 'may recycle'" as one of its cases).
 *
 * Cancellable for the uses above, because nothing has been submitted at that
 * point (the whole PlayCardAction is still a local `pendingPlay` proposal), so
 * backing out is free.
 *
 * **Omit `onCancel` when it isn't.** A pending decision (engine/decisions.ts) is
 * the case this comment used to describe as Java's problem and ours to avoid:
 * the action HAS been submitted, the engine is halfway through resolving an
 * effect, and rule 321 means nothing else can happen until an answer comes
 * back. There is no state to return to, so offering a Cancel button would either
 * lie or strand the game. Without `onCancel` the panel renders no dismissal at
 * all and the only way out is to answer.
 *
 * The backdrop deliberately sits BELOW the hover card-preview's own z-index
 * (see .choice-overlay-backdrop in styles.css) so hovering a card in here
 * still shows its full art and rules text — the whole point of the panel is
 * choosing between cards, which is hard to do from a thumbnail alone.
 */
export function ChoiceOverlay({ title, subtitle, onCancel, cancelLabel = "Cancel", children }: ChoiceOverlayProps) {
  return (
    <div className="choice-overlay-backdrop">
      <div className="choice-overlay-panel">
        <div className="choice-overlay-title">{title}</div>
        {subtitle && <div className="choice-overlay-subtitle">{subtitle}</div>}
        {children}
        {onCancel && (
          <div className="choice-overlay-actions">
            <button onClick={onCancel}>{cancelLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}
