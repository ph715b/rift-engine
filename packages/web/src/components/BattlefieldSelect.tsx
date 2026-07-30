interface BattlefieldSelectProps {
  /** The human's own three battlefields, straight off their DeckList. */
  names: string[];
  /** Names already presented in a decided game this match — struck out and
   *  unclickable (rule 487.3). */
  used: string[];
  /** "Game 2 of 3 — you lead 1–0", or similar. */
  seriesNote: string;
  onSelect: (name: string) => void;
}

/**
 * Best of 3's per-game battlefield choice. 1v1 (Match) setup has each player
 * "select one (1) of their three (3) Battlefields" (rule 487.2) rather than roll
 * for it the way 1v1 (Duel) does (485.5) — so this screen exists only in Best of
 * 3, and it runs before EVERY game including the first, because 487 puts the
 * selection in Setup rather than between games.
 *
 * Rule 487.3 then removes a decided game's battlefields from the rest of the
 * match: "the Battlefields that were used are to be removed and not selected
 * again for this Match. One of the remaining Battlefields that were set aside
 * must be chosen instead." Used ones are shown rather than hidden so the choice
 * narrowing over the match is visible — by game 3 there may be only one left,
 * and that should read as a consequence, not as a broken screen.
 *
 * Only the human chooses. The AI's side is rolled from its own remaining pool
 * (`rollAiBattlefield` in game-setup.ts), for the same reason it never
 * mulligans: nothing here gives it an evaluative basis to prefer one of its own
 * battlefields over another.
 */
export function BattlefieldSelect({ names, used, seriesNote, onSelect }: BattlefieldSelectProps) {
  const available = names.filter((name) => !used.includes(name));

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <span>Choose your battlefield · {seriesNote}</span>
      </div>

      <div className="mulligan-screen">
        <div className="banner">Which of your battlefields do you present this game?</div>
        <div className="battlefield-select">
          {names.map((name) => {
            const isUsed = used.includes(name);
            return (
              <button
                key={name}
                className={`battlefield-select-option${isUsed ? " used" : ""}`}
                disabled={isUsed}
                onClick={() => onSelect(name)}
              >
                <span className="battlefield-select-name">{name}</span>
                <span className="battlefield-select-note">{isUsed ? "Already played this match" : "Present this one"}</span>
              </button>
            );
          })}
        </div>
        <div className="turn-order-note">
          {available.length === 1
            ? "Only one battlefield left to present."
            : `${available.length} of your ${names.length} battlefields are still available. Your opponent presents one of theirs at the same time.`}
        </div>
      </div>
    </div>
  );
}
