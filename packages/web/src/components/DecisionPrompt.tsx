import type { GameState, PendingDecision } from "@rift-engine/engine";
import { optionsFor, promptFor } from "@rift-engine/engine";
import type { CardInstance } from "@rift-engine/engine";
import { ChoiceOverlay } from "./ChoiceOverlay.js";
import { CardView } from "./CardView.js";

interface DecisionPromptProps {
  state: GameState;
  decision: PendingDecision;
  onAnswer: (optionId: string) => void;
}

/**
 * The engine has stopped mid-resolution to ask you something.
 *
 * NOT cancellable, and that is the whole difference from every other use of
 * ChoiceOverlay. The others are local proposals the player can back out of
 * because nothing has been submitted yet; this one exists because an action
 * already went in and the engine cannot finish resolving it without an answer
 * (323.2.b — no Cleanup, no other action, nothing at all until it comes back).
 * A Cancel button here would have nothing to cancel.
 *
 * Options carrying an `instanceId` are rendered as the actual CARD wherever the
 * board can find it — "discard 1" and "kill one of your units" are choices
 * between cards, and choosing between them from four words of prose is
 * miserable. Everything else falls back to a button, which is what a plain
 * yes/no like Flame Chompers' offer wants anyway.
 */
export function DecisionPrompt({ state, decision, onAnswer }: DecisionPromptProps) {
  const options = optionsFor(state, decision);
  const owner = state.players[decision.playerIndex];

  /** Wherever this instance currently is — hand, base, a battlefield, gear or
   *  the trash. Flame Chompers is offered FROM the trash, so a hand-only lookup
   *  would silently render it as a bare button. */
  const findCard = (instanceId: string): CardInstance | undefined =>
    [
      ...owner.hand,
      ...owner.baseUnits,
      ...owner.activeGear,
      ...owner.trash,
      ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? []),
    ].find((c) => c.instanceId === instanceId);

  const cardOptions = options
    .map((option) => ({ option, card: option.instanceId ? findCard(option.instanceId) : undefined }))
    .filter((entry): entry is { option: (typeof options)[number]; card: CardInstance } => entry.card !== undefined);
  const buttonOptions = options.filter((option) => !cardOptions.some((entry) => entry.option.id === option.id));

  return (
    <ChoiceOverlay title={promptFor(state, decision)} subtitle="This has to be answered before play can continue.">
      {cardOptions.length > 0 && (
        <div className="choice-overlay-cards">
          {cardOptions.map(({ option, card }) => (
            <CardView key={option.id} card={card} isSelectable isTargetable inPile onClick={() => onAnswer(option.id)} />
          ))}
        </div>
      )}
      {buttonOptions.length > 0 && (
        <div className="choice-overlay-actions">
          {buttonOptions.map((option) => (
            <button key={option.id} onClick={() => onAnswer(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </ChoiceOverlay>
  );
}
