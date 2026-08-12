import { useEffect, useState, type ReactNode } from "react";

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
  /**
   * What makes this a DIFFERENT question from the last one, for the minimize
   * state below.
   *
   * Defaults to the title, which is right for the play-time overlays (a mode
   * choice, a trash pick) because each names its own card. A pending engine
   * decision passes `decision.id` instead, and must: two questions in a row can
   * share a title — Cull the Weak asks both players to kill one of their own
   * units, in the same words — and a title-keyed reset would leave the second
   * one collapsed behind a bar the player has already learned to ignore.
   */
  resetKey?: string;
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
 *
 * # Minimizing
 *
 * Requested from playtesting: *"would like to be able to minimize selection
 * popups so that you can see boardstate before making a decision."* The panel
 * covers the board at exactly the moment the board matters most — "kill one of
 * your units" is unanswerable without seeing which units you have and where.
 *
 * **Minimizing is DISMISSAL OF THE VIEW, never of the question.** It is offered
 * for mandatory decisions precisely because those are the ones you cannot cancel
 * your way out of, so the restore bar is always rendered and always says what is
 * waiting. Nothing is submitted, nothing is defaulted, and the game cannot
 * advance while it is collapsed — the engine still has no legal action but an
 * answer.
 *
 * The backdrop is dropped while minimized rather than made transparent. A
 * transparent backdrop would still swallow every click and hover, which would
 * leave the board visible and dead — worse than the modal, because it looks
 * interactive.
 */
export function ChoiceOverlay({ title, subtitle, onCancel, cancelLabel = "Cancel", resetKey, children }: ChoiceOverlayProps) {
  const [minimized, setMinimized] = useState(false);
  const identity = resetKey ?? title;

  // **A new question always opens EXPANDED.** Without this, minimizing one
  // decision and answering it would open the next one already collapsed — the
  // player would be waiting on a board that looks idle, with the only clue a bar
  // they just learned to ignore. Keyed on `identity` rather than on the children,
  // which change on every render.
  useEffect(() => {
    setMinimized(false);
  }, [identity]);

  if (minimized) {
    return (
      <div className="choice-overlay-minimized">
        <span className="choice-overlay-minimized-title">{title}</span>
        <button type="button" onClick={() => setMinimized(false)}>
          Show choices
        </button>
      </div>
    );
  }

  return (
    <div className="choice-overlay-backdrop">
      <div className="choice-overlay-panel">
        <div className="choice-overlay-header">
          <div className="choice-overlay-title">{title}</div>
          <button
            type="button"
            className="choice-overlay-minimize"
            // Titled rather than labelled with prose: the control sits in a
            // header whose width is the title's, and a text button there pushes
            // long prompts onto a second line.
            title="Minimize — see the board without answering"
            aria-label="Minimize"
            onClick={() => setMinimized(true)}
          >
            —
          </button>
        </div>
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
