/**
 * Your four hidden/discard piles, as a cluster pinned to the bottom-left corner
 * of the BOARD rather than a list of counts in the side rail.
 *
 * The arrangement is the user's own:
 *
 *     [Deck]  [Rune deck]
 *     [Trash] [Banished]
 *
 * Deck bottom-left, Trash directly under the Deck, Banished beside the Trash,
 * Rune deck to the left of the rune zone — all four as specified. It was first
 * built as three stacked rows (rune deck, deck, then trash+banished), which is
 * the same set of relationships but half again as tall; at that height the
 * cluster pushed the AI's own rail into a scrollbar and cut its Banished row in
 * half. Two rows of two costs nothing and leaves the rail intact.
 *
 * It lives in the lower part of the left rail's column, which is empty space —
 * the AI's Legend and Champion sit at the TOP of that rail. Putting it there
 * rather than floating it over the centre column is what keeps it clear of the
 * hand fan, which occupies the bottom of the centre column and would otherwise
 * cover these whenever it opened.
 *
 * Only the human's piles move here. The AI's stay in the AI's own rail: they are
 * reference numbers you consult, not places you watch things land, and giving
 * both players a board-level cluster would put two players' piles in one rail.
 */

export type BoardPileKind = "deck" | "runeDeck" | "trash" | "banished";

interface BoardPileProps {
  kind: BoardPileKind;
  label: string;
  count: number;
  title: string;
  onClick?: (() => void) | undefined;
}

/** Cosmetic depth only. A 40-card deck and a 4-card one differ by their COUNT,
 *  which is printed on the tile — not by drawing forty rectangles. */
function stackDepth(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  return count < 6 ? 2 : 3;
}

function BoardPile({ kind, label, count, title, onClick }: BoardPileProps) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      className={`board-pile board-pile-${kind}${onClick ? " board-pile-clickable" : ""}`}
      title={title}
      // The anchor the flight layer looks up to find where a card should fly from
      // or to. An attribute rather than a ref registry so that every endpoint —
      // piles here, the hand fan and rune zone elsewhere — is discovered the same
      // way, by one query, with no wiring to keep in sync.
      data-flight-anchor={kind}
      {...(onClick ? { onClick, type: "button" as const } : {})}
    >
      <span className="board-pile-stack">
        {stackDepth(count) === 0 ? (
          <span className="board-pile-empty" aria-hidden />
        ) : (
          Array.from({ length: stackDepth(count) }, (_, i) => (
            <span
              key={i}
              className="board-pile-card"
              style={{ transform: `translate(${i * 2}px, ${i * -2}px)` }}
              aria-hidden
            />
          ))
        )}
        <span className="board-pile-count">{count}</span>
      </span>
      <span className="board-pile-label">{label}</span>
    </Wrapper>
  );
}

interface BoardPilesProps {
  deckCount: number;
  runeDeckCount: number;
  trashCount: number;
  banishedCount: number;
  /** Only ever supplied for a non-empty trash — it is the one public pile. */
  onViewTrash?: (() => void) | undefined;
}

export function BoardPiles({ deckCount, runeDeckCount, trashCount, banishedCount, onViewTrash }: BoardPilesProps) {
  return (
    <div className="board-piles" aria-label="Your piles">
      <BoardPile kind="deck" label="Deck" count={deckCount} title="Cards remaining in your main deck" />
      <BoardPile kind="runeDeck" label="Runes" count={runeDeckCount} title="Runes remaining in your rune deck" />
      <BoardPile
        kind="trash"
        label="Trash"
        count={trashCount}
        title={trashCount > 0 ? "View your trash pile (public information)" : "Your trash"}
        onClick={trashCount > 0 ? onViewTrash : undefined}
      />
      <BoardPile kind="banished" label="Banished" count={banishedCount} title="Your banished pile" />
    </div>
  );
}
