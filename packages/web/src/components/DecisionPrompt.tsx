import type { GameState, PendingDecision } from "@rift-engine/engine";
import { optionsFor, promptFor } from "@rift-engine/engine";
import type { CardInstance } from "@rift-engine/engine";
import { ChoiceOverlay } from "./ChoiceOverlay.js";
import { CardView } from "./CardView.js";

interface DecisionPromptProps {
  state: GameState;
  decision: PendingDecision;
  onAnswer: (optionId: string) => void;
  /**
   * SPECTATE — show the question and its options, but let nobody answer it: the
   * bot sitting at this seat will, a beat later.
   *
   * Rendered rather than suppressed, and that is the point. A spectated game is
   * the one place the questions this engine asks can be WATCHED being asked, and
   * a mode that hid them would make the most interesting thing on the board
   * invisible for the sake of tidiness.
   */
  readOnly?: boolean;
}

/**
 * The engine has stopped mid-resolution to ask you something.
 *
 * NOT cancellable, and that is the whole difference from every other use of
 * ChoiceOverlay. The others are local proposals the player can back out of
 * because nothing has been submitted yet; this one exists because an action
 * already went in and the engine cannot finish resolving it without an answer
 * (321 — no Cleanup, no other action, nothing at all until it comes back).
 * A Cancel button here would have nothing to cancel.
 *
 * Options carrying an `instanceId` are rendered as the actual CARD wherever the
 * board can find it — "discard 1" and "kill one of your units" are choices
 * between cards, and choosing between them from four words of prose is
 * miserable. Everything else falls back to a button, which is what a plain
 * yes/no like Flame Chompers' offer wants anyway.
 *
 * # The label is drawn too, and leaving it out cost a card
 *
 * Rendering the card used to DISCARD `option.label`, on the assumption that an
 * option naming a card is a choice *between* cards, where the art says
 * everything and the label is just the name again. That is one of two families
 * the engine actually emits, and the other one inverts it:
 *
 *   `{ id: c.instanceId, label: c.name, instanceId: c.instanceId }` — the card
 *   IS the choice. Discarding the label loses nothing.
 *
 *   `{ id: "home", label: "Move to base", instanceId: theUnit.instanceId }` — a
 *   yes/no whose affirmative names its SUBJECT. The label is the instruction and
 *   the card is what it acts on. Discarding the label loses the entire question.
 *
 * Relentless Pursuit is the second kind, and the consequence was that its
 * conquest trigger showed the player a picture of their unit and exactly one
 * labelled control: **"Stay"**. There was no way to say yes. Reported from
 * playtesting as "unit didn't move to base after relentless pursuit" — and the
 * engine had been doing its half correctly the whole time, measured at 6/6 over
 * 60 self-play games.
 *
 * **Six more decisions have the same shape and were silently just as broken** —
 * Mistfall's "Pay 1 Body Power and exhaust", Poro Snax's "Spend the buff to ready
 * it", Poro Captain's "Buff me", and one each in fury and order. None of them was
 * reported, because a yes/no where only "no" has a button looks like a decision
 * you already made.
 *
 * So the label is always drawn, and suppressed only when it is EXACTLY the card's
 * name — the one case where it is provably redundant. A rule about what the text
 * says beats a rule about which family the option came from, because the families
 * are not marked and the next card will belong to whichever one this guessed
 * wrong.
 */
export function DecisionPrompt({ state, decision, onAnswer, readOnly = false }: DecisionPromptProps) {
  const options = optionsFor(state, decision);

  /**
   * Wherever this instance currently is — ANY zone of EITHER player.
   *
   * It used to search five zones of the ANSWERING player only, and two cards in
   * the pool ask about cards that lookup could never reach, so both rendered as
   * bare buttons after a playtest asked for their images:
   *  - **Stacked Deck** offers the top 3 of your own **DECK**, which was not
   *    among the zones searched at all.
   *  - **Mindsplitter** offers the **OPPONENT's** hand — "they reveal their
   *    hand, choose a card from it" — so the cards are real and visible by the
   *    card's own instruction, but they belong to the other player.
   *
   * **Searching both players' private zones is safe HERE and nowhere else**, and
   * the reason is worth stating: this only ever looks up an instance the ENGINE
   * has already put on the option list. A decision's options are built by the
   * card that asked, so if an id is offered, that card has decided the answering
   * player may see it. This function cannot widen what is shown; it can only
   * find what was already going to be named.
   */
  const findCard = (instanceId: string): CardInstance | undefined =>
    state.players
      .flatMap((p) => [...p.hand, ...p.deck, ...p.baseUnits, ...p.activeGear, ...p.trash, ...p.banished])
      .concat(state.battlefields.flatMap((bf) => Object.values(bf.units).flat()))
      .find((c) => c.instanceId === instanceId);

  const cardOptions = options
    .map((option) => ({ option, card: option.instanceId ? findCard(option.instanceId) : undefined }))
    .filter((entry): entry is { option: (typeof options)[number]; card: CardInstance } => entry.card !== undefined);
  const buttonOptions = options.filter((option) => !cardOptions.some((entry) => entry.option.id === option.id));

  return (
    <ChoiceOverlay
      title={promptFor(state, decision)}
      subtitle={readOnly ? "Waiting for the bot to answer." : "This has to be answered before play can continue."}
    >
      {cardOptions.length > 0 && (
        <div className="choice-overlay-cards">
          {cardOptions.map(({ option, card }) => (
            <div className="decision-card-option" key={option.id}>
              <CardView
                card={card}
                isSelectable={!readOnly}
                isTargetable={!readOnly}
                inPile
                {...(readOnly ? {} : { onClick: () => onAnswer(option.id) })}
              />
              {option.label !== card.name && <span className="decision-option-label">{option.label}</span>}
            </div>
          ))}
        </div>
      )}
      {buttonOptions.length > 0 && (
        <div className="choice-overlay-actions">
          {buttonOptions.map((option) => (
            <button key={option.id} disabled={readOnly} onClick={() => onAnswer(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </ChoiceOverlay>
  );
}
