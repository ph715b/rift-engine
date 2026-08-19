import { useState } from "react";
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
 *
 * # A question can be 233 options wide, and a row of buttons is not a control
 *
 * Fallen Feline's "name a spell" offers every spell in the pool (rule 762 — any
 * card legal in the format), which is roughly twenty times the next widest
 * question here. `.choice-overlay-actions` is a single un-wrapped flex row, so
 * without this the engine would be asking a question the board physically could
 * not show — the exact shape of the four playtest reports above, where the
 * mechanic was right and the human had nothing to click.
 *
 * Past `SEARCHABLE_OPTIONS` the buttons get a filter box and a scrolling wrapped
 * grid. A filter rather than pagination because the player usually knows the name
 * they want before they open the dialog: naming is a decision about the format,
 * not about what is in front of them.
 *
 * The threshold is deliberately well ABOVE every other question in the pool
 * (Kennen's stun offer, the widest before her, tops out around a dozen) so that
 * nothing else changes shape, and well BELOW 233.
 */
const SEARCHABLE_OPTIONS = 20;

export function DecisionPrompt({ state, decision, onAnswer, readOnly = false }: DecisionPromptProps) {
  const options = optionsFor(state, decision);
  /**
   * The filter text, TIED TO THE QUESTION IT WAS TYPED FOR.
   *
   * This component stays mounted across consecutive decisions — `ChoiceOverlay`'s
   * `resetKey` exists for exactly that reason, and the note beside it records what
   * happens when a per-question piece of state is not reset: the second question
   * inherits the first one's UI. A filter is worse than a collapsed bar, because
   * a stale one HIDES options: the next question would open already narrowed to a
   * word typed at the last one, with no indication why most of it is missing.
   *
   * Derived during render rather than cleared in an effect, so there is no frame
   * where the wrong list is on screen.
   */
  const [typed, setTyped] = useState({ decisionId: decision.id, text: "" });
  const filter = typed.decisionId === decision.id ? typed.text : "";
  const setFilter = (text: string) => setTyped({ decisionId: decision.id, text });

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
  const searchable = buttonOptions.length > SEARCHABLE_OPTIONS;
  // Case-insensitive SUBSTRING, not a prefix: "shadow" should find "Twilight
  // Shroud"'s neighbours by the word a player actually remembers, and 761.2's
  // naming-by-trait ("the blue Kai'Sa") is the rules' own version of the same
  // habit. Unfiltered when the list is short enough to read whole.
  const shownOptions =
    searchable && filter.trim() !== ""
      ? buttonOptions.filter((option) => option.label.toLowerCase().includes(filter.trim().toLowerCase()))
      : buttonOptions;

  return (
    <ChoiceOverlay
      title={promptFor(state, decision)}
      subtitle={readOnly ? "Waiting for the bot to answer." : "This has to be answered before play can continue."}
      // The DECISION's id, not its title. Two questions running back to back can
      // share wording — Cull the Weak asks both players to kill one of their own
      // units, in the same words — and a title-keyed reset would leave the second
      // one collapsed behind a bar the player has just learned to ignore.
      resetKey={decision.id}
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
        <>
          {searchable && (
            <input
              className="decision-option-filter"
              type="search"
              // Named for what it does to the LIST rather than for the card, so
              // the next wide question inherits a control that already reads
              // correctly.
              placeholder={`Filter ${buttonOptions.length} options`}
              aria-label="Filter options"
              value={filter}
              disabled={readOnly}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <div className={searchable ? "choice-overlay-actions choice-overlay-actions-wide" : "choice-overlay-actions"}>
            {shownOptions.map((option) => (
              <button key={option.id} disabled={readOnly} onClick={() => onAnswer(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          {searchable && shownOptions.length === 0 && (
            // A filter that matches nothing must SAY so. An empty grid under a
            // box you have just typed into reads as a broken dialog, and this
            // question cannot be cancelled — see the note at the top.
            <p className="decision-option-empty">No option matches “{filter}”.</p>
          )}
        </>
      )}
    </ChoiceOverlay>
  );
}
