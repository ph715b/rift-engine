import { useState } from "react";
import { allPresetDecks, presetDeckList, type DeckList } from "@rift-engine/engine";
import { getProfileDecks } from "../profile.js";
import { DeckListPicker } from "./DeckListPicker.js";
import type { MatchConfig, MatchFormat } from "../game-setup.js";

const PRESET_DECK_LISTS = allPresetDecks().map(presetDeckList);

interface LobbyProps {
  onStartMatch: (config: MatchConfig) => void;
  onBack: () => void;
  /** Open the deck LIBRARY. The lobby used to carry building, importing,
   *  editing, exporting and deleting inline; all of that lives in the manager
   *  now, and this is the door to it. */
  onManageDecks: () => void;
}

/**
 * Setup screen: pick your deck and the AI's, each from the Proving Grounds
 * presets or anything in your profile (imported, built, or pasted from a
 * community list), then start the match. This is
 * the ONE place deck selection happens (per the user's own framing) —
 * rematch either reuses this exact config or jumps straight back here for
 * a quick swap, it never re-litigates the choice mid-game.
 */
export function Lobby({ onStartMatch, onBack, onManageDecks }: LobbyProps) {
  const [profileDecks, setProfileDecks] = useState(getProfileDecks);
  const [humanDeck, setHumanDeck] = useState<DeckList | null>(null);
  const [aiDeck, setAiDeck] = useState<DeckList | null>(PRESET_DECK_LISTS[0] ?? null);
  // Best of 1 is the default because it's the shorter commitment, and because
  // it's what every match up to now has implicitly been.
  const [format, setFormat] = useState<MatchFormat>("bo1");
  // SPECTATE — both seats driven by the AI. Off by default and deliberately not
  // remembered in the profile: it is a mode you opt into for one match to watch
  // or to instrument, never one you should find yourself in by accident.
  const [spectate, setSpectate] = useState(false);

  // **No refresh handler here.** Adding, editing and deleting all happen in the
  // deck manager, which is a separate SCREEN — returning remounts this component,
  // so `useState(getProfileDecks)` re-reads the library on the way back. A stale
  // list would need this screen to survive the round trip, and it does not.

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <button onClick={onBack}>Back</button>
      </div>

      <div className="zone">
        <div className="zone-label">{spectate ? "First bot's deck" : "Your deck"}</div>
        <DeckListPicker label="" decks={PRESET_DECK_LISTS} selectedName={humanDeck?.name ?? null} onSelect={setHumanDeck} />
        {/* **Selection only.** This zone used to carry six controls — build,
            import a file, import pasted text, edit, export, delete — of which
            exactly one was about the match being set up. Picking a deck felt
            like paperwork because it was surrounded by it. All of that lives in
            the deck manager now; what is left here answers the one question the
            lobby exists to ask. */}
        <DeckListPicker
          label="Your saved decks"
          decks={profileDecks}
          selectedName={humanDeck?.name ?? null}
          onSelect={setHumanDeck}
          emptyNote="No decks of your own yet — Manage decks to build or import one."
        />
        <button onClick={onManageDecks}>Manage decks</button>
      </div>

      <div className="zone">
        <DeckListPicker
          label={spectate ? "Second bot's deck" : "Opponent's deck"}
          decks={PRESET_DECK_LISTS}
          selectedName={aiDeck?.name ?? null}
          onSelect={setAiDeck}
        />
        {/* The AI plays your own decks too. It used to be presets only, on the
            reasoning that the opponent is a fixed built-in role — but the AI and
            the UI consume the same `legalActions` contract, and game-setup takes
            any pair of DeckLists, so the restriction was never an engine one.
            Testing a deck against itself, or against the list you actually
            expect to face, is the point of building one.

            Deliberately a SECOND picker rather than one merged list: which decks
            are yours stays visible, and it mirrors the human side above. */}
        <DeckListPicker
          label="Your saved decks"
          decks={profileDecks}
          selectedName={aiDeck?.name ?? null}
          onSelect={setAiDeck}
        />
      </div>

      {/* The two sanctioned 1v1 modes (rules 485 and 486). Labelled by game
          count first, since that's what a player is actually choosing, with the
          rules' own mode name and the consequences underneath — the battlefield
          rule genuinely differs between them, so it isn't just match length. */}
      <div className="zone">
        <div className="zone-label">Match format</div>
        <div className="format-picker">
          {(
            [
              {
                value: "bo1" as const,
                title: "Best of 1",
                mode: "1v1 Duel",
                detail: "One game decides it. Battlefields are rolled at random.",
              },
              {
                value: "bo3" as const,
                title: "Best of 3",
                mode: "1v1 Match",
                detail: "First to 2 game wins. You pick your battlefield each game, and used ones are out for the rest of the match.",
              },
            ] satisfies { value: MatchFormat; title: string; mode: string; detail: string }[]
          ).map((option) => (
            <button
              key={option.value}
              className={`format-option${format === option.value ? " selected" : ""}`}
              aria-pressed={format === option.value}
              onClick={() => setFormat(option.value)}
            >
              <span className="format-option-title">{option.title}</span>
              <span className="format-option-mode">{option.mode}</span>
              <span className="format-option-detail">{option.detail}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Spectate rides in the ACTIONS row rather than taking a zone of its own,
          and that is a layout constraint rather than a style preference: `.board`
          is a fixed `100dvh` with `overflow: hidden` and the zones are
          `flex: 0 1 auto`, so a fifth zone shrinks all of them — measured, it
          took the deck zone from 526px to 379px and pushed its own Parse button
          out under the zone below, where a click hits the wrong element. Anything
          added to this screen has to cost no vertical space. */}
      <div className="actions">
        <button
          className={`spectate-toggle${spectate ? " selected" : ""}`}
          aria-pressed={spectate}
          title="Both seats play themselves and the board is watched, not played."
          onClick={() => setSpectate((on) => !on)}
        >
          Spectate · AI vs AI
        </button>
        <button
          className="menu-primary-button"
          disabled={!humanDeck || !aiDeck}
          onClick={() => humanDeck && aiDeck && onStartMatch({ humanDeck, aiDeck, format, spectate })}
        >
          {spectate ? "Watch Match" : "Start Match"}
        </button>
      </div>
    </div>
  );
}
