import { useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  BATTLEFIELD_COUNT,
  DECK_SIZE,
  LEGACY_BATTLEFIELDS,
  MAX_COPIES,
  RUNE_DECK_SIZE,
  SIDEBOARD_SIZE,
  defaultCardRegistry,
  implementableText,
  isCardImplemented,
  isCardLegalForLegend,
  isEligibleChampion,
  loadBattlefieldDefinitions,
  partialImplementationNote,
  serializeDeckFile,
  sortByDomainOrdinal,
  validateDeckList,
  type BattlefieldDefinition,
  type CardDefinition,
  type DeckList,
  type LegendDefinition,
  type UnitDefinition,
} from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { downloadTextFile } from "../download-file.js";
import { saveProfileDeck } from "../profile.js";
import { DecklistTextImport } from "./DecklistTextImport.js";
import { DeckPanel } from "./DeckPanel.js";
import { CardBrowserFilters } from "./CardBrowserFilters.js";
import { DeckStatsView, SampleHandView } from "./DeckStatsView.js";
import { EMPTY_FILTERS, filterAndSortCards, type CardFilters } from "../card-filters.js";
import { chooseArt, chosenPrintingId, printingsFor, subscribeToArt, artSnapshot } from "../card-art.js";

/** The left pane's tabs. `cards` first and default: it is the only one you
 *  return to, and every other step is a once-per-deck decision that used to sit
 *  above it as a permanent 1,150px of scroll. */
const LEFT_TABS = [
  { id: "cards", label: "Cards" },
  { id: "setup", label: "Setup" },
  { id: "battlefields", label: "Battlefields" },
  { id: "import", label: "Import" },
] as const;
type LeftTab = (typeof LEFT_TABS)[number]["id"];

const RIGHT_TABS = [
  { id: "deck", label: "Deck" },
  { id: "stats", label: "Stats" },
  { id: "hand", label: "Sample hand" },
] as const;
type RightTab = (typeof RIGHT_TABS)[number]["id"];

interface DeckBuilderProps {
  /** Present => editing that saved deck (prefills every field); absent => building fresh. */
  initialDeck?: DeckList;
  /** Names from a community decklist-text import that didn't resolve to a
   *  real card (out-of-scope cards, unmatched champion variants, etc.) —
   *  purely informational, shown as a dismissible banner so the user knows
   *  what to pick manually; nothing is blocked by it. */
  unresolvedNames?: string[];
  onSaved: () => void;
  onCancel: () => void;
}

interface SingleSelectListProps<T extends { id: string; name: string }> {
  label: string;
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyText: string;
  /** Returns why this entry is unimplemented, or undefined when it is fine.
   *  Omitted entirely for a picker whose items aren't cards. */
  markUnimplemented?: (item: T) => string | undefined;
}

/** The same "pick one of several named things" pattern Lobby.tsx's
 *  DeckListPicker already established (deck-list/deck-option classes) —
 *  reused here for the legend and champion pickers instead of a new markup.
 *
 *  Marks unimplemented entries the same way CardBrowserTile marks unimplemented
 *  cards. It did not, and that mattered more here than anywhere: every deck has
 *  exactly one Legend and it is in play from turn 1, so choosing an inert one
 *  meant playing the whole game a card down with nothing on screen saying so.
 *  The card browser below has always been honest about this; the two pickers
 *  that pick the ALWAYS-in-play cards were the ones that weren't. */
function SingleSelectList<T extends { id: string; name: string }>({
  label,
  items,
  selectedId,
  onSelect,
  emptyText,
  markUnimplemented,
}: SingleSelectListProps<T>) {
  return (
    <div>
      <div className="zone-label">{label}</div>
      <div className="deck-list">
        {items.map((item) => {
          const note = markUnimplemented?.(item);
          return (
            <div
              key={item.id}
              className={`deck-option${selectedId === item.id ? " selected" : ""}${note ? " not-implemented" : ""}`}
              title={note}
            >
              <button className="deck-option-button" onClick={() => onSelect(item.id)}>
                {item.name}
              </button>
            </div>
          );
        })}
        {items.length === 0 && <p className="deck-list-empty">{emptyText}</p>}
      </div>
    </div>
  );
}

/**
 * Why this card is not fully implemented, or undefined when it is — the tooltip
 * text for both pickers and the flag that greys them.
 *
 * Two distinct cases, and they are worth telling apart on screen: a card with no
 * implementation at all, and one whose registration covers only PART of its text
 * (coverage.ts's partialImplementationNote). The second is the more misleading
 * of the two, because such a card visibly does something.
 */
function unimplementedNote(def: CardDefinition): string | undefined {
  const partial = partialImplementationNote(def);
  if (partial) return `Only partly implemented — ${partial}`;
  if (isCardImplemented(def)) return undefined;
  return `No effect implemented yet — this card's text does nothing:\n"${implementableText(def)}"`;
}

interface CardBrowserTileProps {
  def: CardDefinition;
  count: number;
  isChampion: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
  canIncrement: boolean;
  canDecrement: boolean;
}

/** A static CardDefinition tile — deliberately NOT CardView.tsx, which
 *  renders a live in-game CardInstance (drag/hover/exhaust wiring that
 *  doesn't apply to browsing the card pool). Mirrors CardView's own
 *  missing-art fallback markup (name + cost badges) since none of these
 *  definitions are missing art in the current OGN+OGS pool, but the
 *  fallback keeps this resilient the same way CardView already is. */
function CardBrowserTile({ def, count, isChampion, onIncrement, onDecrement, canIncrement, canDecrement }: CardBrowserTileProps) {
  const hasCost = def.type === "Unit" || def.type === "Spell" || def.type === "Gear";
  const powerDomainColor = def.powerDomain ? DOMAIN_COLORS[def.powerDomain] : undefined;
  // Most of the card pool's printed text has no implementation yet, and an
  // unimplemented card is invisible in play: it costs runes, goes to the trash
  // and quietly does nothing. Marking it here is the difference between a
  // playtest you can draw conclusions from and one you can't.
  //
  // Shared with the legend/champion pickers via unimplementedNote, so the whole
  // builder answers "is this card finished?" in one voice — including the
  // partly-implemented case, which used to read as fully working here.
  const notImplemented = unimplementedNote(def);

  // The PRINTINGS of this card, default first — see card-art.ts. 93 cards in the
  // pool have one alternate each; the rest get no control at all, which is why
  // this is a list rather than a boolean even though every case today is a
  // two-way toggle.
  //
  // Subscribed, so the tile repaints the moment its own toggle is clicked. The
  // store is module-level rather than component state on purpose: the same choice
  // has to reach `CardView` on the board, which shares no ancestor with this.
  useSyncExternalStore(subscribeToArt, artSnapshot, artSnapshot);
  const printings = printingsFor(def.id, def.name, def.imageUrl ?? "");
  const chosenId = chosenPrintingId(def.id);
  const chosenIndex = Math.max(
    0,
    printings.findIndex((p) => p.id === chosenId),
  );
  const shownArt = printings.length > 0 ? printings[chosenIndex]!.imageUrl : def.imageUrl;

  return (
    <div
      className={`card-tile${count > 0 ? " in-deck" : ""}${notImplemented ? " not-implemented" : ""}`}
      title={notImplemented}
    >
      {/* The printing picker, on the cards that have one. A CYCLE rather than a
          dropdown: every card in the pool has exactly one alternate, so a menu
          would be two clicks to express a toggle — and the tile's own art is the
          preview, so the control needs no separate one.

          Stops propagation because the tile is itself clickable in the
          battlefield picker's sibling and may become so here; a player reaching
          for the art must not add a copy. */}
      {printings.length > 1 && (
        <button
          className="card-tile-art-toggle"
          title={`Art: ${printings[chosenIndex]!.name} — click for the next printing`}
          aria-label={`Change printing for ${def.name}`}
          onClick={(e) => {
            e.stopPropagation();
            chooseArt(def.id, printings[(chosenIndex + 1) % printings.length]!.id);
          }}
        >
          ◈ {chosenIndex + 1}/{printings.length}
        </button>
      )}
      {shownArt ? (
        <img className="card-tile-art" src={shownArt} alt={def.name} draggable={false} loading="lazy" />
      ) : (
        <div className="card-tile-fallback">
          <div className="card-name">{def.name}</div>
          {hasCost && (
            <div className="card-stats">
              {"energyCost" in def && def.energyCost > 0 && <span className="stat-badge stat-energy">{def.energyCost}</span>}
              {"powerCost" in def && def.powerCost > 0 && (
                <span className="stat-badge stat-power" style={powerDomainColor ? { background: powerDomainColor } : undefined}>
                  {def.powerCost}
                </span>
              )}
              {def.type === "Unit" && <span className="stat-badge stat-might">{def.might}</span>}
            </div>
          )}
        </div>
      )}
      <div className="card-tile-controls">
        <button className="stepper-button" onClick={onDecrement} disabled={!canDecrement} title={isChampion && count <= 1 ? "Your champion must stay in the deck" : "Remove a copy"}>
          −
        </button>
        <span className="card-tile-count">
          {count}/{MAX_COPIES}
        </span>
        <button className="stepper-button" onClick={onIncrement} disabled={!canIncrement} title="Add a copy">
          +
        </button>
      </div>
    </div>
  );
}

interface BattlefieldTileProps {
  def: BattlefieldDefinition;
  selected: boolean;
  onClick: () => void;
}

/** A real, named Battlefield card — clicking it fills whichever of the 3
 *  battlefield-name slots is currently focused (see `focusedBattlefieldIndex`
 *  below). Free text remains possible in those same slots for battlefields
 *  outside this engine's data (real decklists commonly reference some) —
 *  this is a convenience on top of that, not a replacement for it. */
function BattlefieldTile({ def, selected, onClick }: BattlefieldTileProps) {
  return (
    <button className={`card-tile battlefield-tile${selected ? " in-deck" : ""}`} onClick={onClick} title={def.text}>
      <img className="card-tile-art" src={def.imageUrl} alt={def.name} draggable={false} loading="lazy" />
    </button>
  );
}

/**
 * Builds (or edits) an arbitrary DeckList in-app — the missing piece behind
 * the PRD's "playtest a deck before buying it" motivation (Goal 3 / FR2c).
 * Everything downstream of the DeckList it produces is already real and
 * reused unchanged: validateDeckList (same legality rules as the .deck
 * importer) and saveProfileDeck (the same profile-persistence Lobby's
 * saved-decks picker already reads from).
 *
 * Battlefield names are free-text slots WITH a real-card picker alongside
 * them (loadBattlefieldDefinitions — real Battlefield-type cards, art and
 * all, excluded from the main registry the same way Rune-type cards are).
 * Clicking a picker tile fills whichever slot is currently focused; free
 * text stays available in the same slots for battlefields outside this
 * engine's data (real decklists commonly reference some) — the picker is a
 * convenience on top of that, not a replacement for it.
 */
export function DeckBuilder({ initialDeck, unresolvedNames, onSaved, onCancel }: DeckBuilderProps) {
  const registry = useMemo(() => defaultCardRegistry(), []);
  const battlefieldDefs = useMemo(() => loadBattlefieldDefinitions(), []);

  const [name, setName] = useState(initialDeck?.name ?? "");
  const [legendId, setLegendId] = useState<string | null>(initialDeck?.legendId ?? null);
  const [championId, setChampionId] = useState<string | null>(initialDeck?.championId ?? null);
  const [cardIds, setCardIds] = useState<string[]>(initialDeck?.cardIds ?? []);
  const [runeDomainACount, setRuneDomainACount] = useState(initialDeck?.runeDomainACount ?? 6);
  const [runeDomainBCount, setRuneDomainBCount] = useState(initialDeck?.runeDomainBCount ?? 6);
  const [battlefieldNames, setBattlefieldNames] = useState<string[]>(() =>
    Array.from({ length: BATTLEFIELD_COUNT }, (_, i) => initialDeck?.battlefieldNames[i] ?? LEGACY_BATTLEFIELDS[i] ?? ""),
  );
  const [focusedBattlefieldIndex, setFocusedBattlefieldIndex] = useState(0);
  const [sideboardCardIds, setSideboardCardIds] = useState<string[]>(initialDeck?.sideboardCardIds ?? []);
  const [leftTab, setLeftTab] = useState<LeftTab>("cards");
  const [rightTab, setRightTab] = useState<RightTab>("deck");
  const [filters, setFilters] = useState<CardFilters>(EMPTY_FILTERS);
  /** Which list a browser click adds to. Replaces the second, identical card
   *  grid the sideboard used to render — see the render. */
  const [addTarget, setAddTarget] = useState<"main" | "sideboard">("main");
  const [columns, setColumns] = useState(6);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);
  /** Names a paste referenced that this pool does not have — the same report the
   *  lobby route shows as a banner, for a paste made from in here. */
  const [importedUnresolved, setImportedUnresolved] = useState<string[]>([]);

  const legendDef = legendId ? (registry.tryGet(legendId) as LegendDefinition | undefined) ?? null : null;

  const legendOptions = useMemo(() => registry.all().filter((c): c is LegendDefinition => c.type === "Legend"), [registry]);

  const championOptions = useMemo(() => {
    if (!legendDef) return [];
    return registry
      .all()
      .filter((c): c is UnitDefinition => c.type === "Unit" && c.isChampion)
      .filter((c) => isEligibleChampion(c, legendDef.name, legendDef.domains));
  }, [registry, legendDef]);

  const orderedDomains = legendDef ? sortByDomainOrdinal(legendDef.domains) : null;

  const copyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [cardIds]);

  const sideboardCopyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of sideboardCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [sideboardCardIds]);

  /** The real limit is 3 copies of a card across MAIN DECK + SIDEBOARD
   *  combined (validateDeckList's own rule) — not 3 independently in each. */
  function combinedCount(id: string): number {
    return (copyCounts.get(id) ?? 0) + (sideboardCopyCounts.get(id) ?? 0);
  }

  /** Every card legal for this legend — the denominator the filter row reports
   *  against, so "9 of 121 cards" means something. */
  const legalCards = useMemo(() => {
    if (!legendDef) return [];
    return registry.all().filter((c) => isCardLegalForLegend(c, legendDef.domains));
  }, [registry, legendDef]);

  const visibleCards = useMemo(() => filterAndSortCards(legalCards, filters), [legalCards, filters]);

  const totalCount = cardIds.length;
  const sideboardTotal = sideboardCardIds.length;
  const runeTotal = runeDomainACount + runeDomainBCount;

  /** How much of THIS deck is inert, in copies rather than distinct cards — the
   *  figure that decides whether a playtest of this list tells you anything. A
   *  3-of that does nothing is three dead draws, not one. */
  const { inertCopies, inertNames } = useMemo(() => {
    const names = new Set<string>();
    let copies = 0;
    for (const id of cardIds) {
      const def = registry.tryGet(id);
      if (!def || isCardImplemented(def)) continue;
      copies += 1;
      names.add(def.name);
    }
    return { inertCopies: copies, inertNames: [...names].sort() };
  }, [cardIds, registry]);

  function selectLegend(id: string) {
    setLegendId(id);
    setChampionId(null);
    setCardIds([]);
    // Sideboard cards are drawn from the same legend-filtered browsable
    // list as the main deck — without this, switching legends would leave
    // the old legend's sideboard picks invisibly stuck in state (they'd no
    // longer render, since the card browser filters by the NEW legend),
    // silently carried into the saved deck rather than actually cleared.
    setSideboardCardIds([]);
    setRuneDomainACount(6);
    setRuneDomainBCount(6);
    setSaveError(null);
  }

  function selectChampion(id: string) {
    setChampionId(id);
    setCardIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSaveError(null);
  }

  function incrementCard(id: string) {
    if (combinedCount(id) >= MAX_COPIES || totalCount >= DECK_SIZE) return;
    setCardIds((prev) => [...prev, id]);
  }

  /**
   * Replaces everything the builder is holding with a pasted list.
   *
   * Deliberately a REPLACE rather than a merge: a decklist is a whole deck, and
   * merging one into a half-built deck produces something the player did not ask
   * for and cannot easily undo. The button says "Replace deck" whenever there is
   * anything to lose — see DecklistTextImport's `replaces`.
   */
  function applyImportedDeck(deck: DeckList, unresolved: string[]) {
    setName(deck.name);
    setLegendId(deck.legendId);
    setChampionId(deck.championId);
    setCardIds(deck.cardIds);
    setSideboardCardIds(deck.sideboardCardIds ?? []);
    setRuneDomainACount(deck.runeDomainACount);
    setRuneDomainBCount(deck.runeDomainBCount);
    setBattlefieldNames(Array.from({ length: BATTLEFIELD_COUNT }, (_, i) => deck.battlefieldNames[i] ?? ""));
    setImportedUnresolved(unresolved);
    setSaveError(null);
  }

  /** Add/remove against whichever list the browser is pointed at. One pair of
   *  handlers rather than two grids' worth: the tile does not need to know which
   *  list it is editing, and neither does the limit check. */
  const activeCounts = addTarget === "main" ? copyCounts : sideboardCopyCounts;

  function addCard(id: string) {
    if (addTarget === "main") incrementCard(id);
    else incrementSideboardCard(id);
  }

  function removeCard(id: string) {
    if (addTarget === "main") decrementCard(id);
    else decrementSideboardCard(id);
  }

  function decrementCard(id: string) {
    const count = copyCounts.get(id) ?? 0;
    if (count <= 0) return;
    if (id === championId && count <= 1) return;
    setCardIds((prev) => {
      const idx = prev.lastIndexOf(id);
      if (idx === -1) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
  }

  function incrementSideboardCard(id: string) {
    if (combinedCount(id) >= MAX_COPIES || sideboardTotal >= SIDEBOARD_SIZE) return;
    setSideboardCardIds((prev) => [...prev, id]);
  }

  function decrementSideboardCard(id: string) {
    const count = sideboardCopyCounts.get(id) ?? 0;
    if (count <= 0) return;
    setSideboardCardIds((prev) => {
      const idx = prev.lastIndexOf(id);
      if (idx === -1) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
  }

  function setBattlefieldName(index: number, value: string) {
    setBattlefieldNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  }

  function clampRune(n: number): number {
    return Math.max(0, Math.min(RUNE_DECK_SIZE, n));
  }

  function buildDeckList(): DeckList | null {
    if (!legendId || !championId) {
      setSaveError("Pick a legend and a champion first.");
      return null;
    }
    if (!name.trim()) {
      setSaveError("Name your deck first.");
      return null;
    }
    return {
      name: name.trim(),
      legendId,
      championId,
      cardIds,
      runeDomainACount,
      runeDomainBCount,
      battlefieldNames,
      sideboardCardIds,
    };
  }

  function handleSave() {
    const deckList = buildDeckList();
    if (!deckList) return;
    const result = validateDeckList(deckList, registry);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    saveProfileDeck(deckList);
    onSaved();
  }

  function handleDownload() {
    const deckList = buildDeckList();
    if (!deckList) return;
    const result = validateDeckList(deckList, registry);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setSaveError(null);
    downloadTextFile(`${deckList.name}.deck`, serializeDeckFile(deckList));
  }

  return (
    <div className="board deck-builder">
      <div className="header">
        <h1>Rift-Engine</h1>
        <div className="deck-builder-header-actions">
          {saveError && <span className="deck-import-error">{saveError}</span>}
          <button onClick={handleDownload}>Download .deck</button>
          <button className="menu-primary-button" onClick={handleSave}>
            Save deck
          </button>
          <button onClick={onCancel}>Back</button>
        </div>
      </div>

      {unresolvedNames && unresolvedNames.length > 0 && !warningDismissed && (
        <div className="deck-import-warning">
          <button className="deck-import-warning-dismiss" onClick={() => setWarningDismissed(true)} title="Dismiss">
            ✕
          </button>
          <p>Couldn&apos;t find these in the card pool — pick something else for them:</p>
          <p>{unresolvedNames.join(", ")}</p>
        </div>
      )}

      {/* TWO PANES, each scrolling internally, instead of one long column.
          Measured before the change: a full 40-card deck stacked ~2290px of
          sections into an ~890px pane — 2.6 screens — with the card browser and
          the deck at the BOTTOM, under setup you touch once. Now the two things
          you use constantly are the only two things on screen, and each setup
          step costs 0px until you open its tab. */}
      <div className="builder-panes">
        <section className="builder-pane builder-left">
          <nav className="builder-tabs" role="tablist" aria-label="What to edit">
            {LEFT_TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={leftTab === tab.id}
                className={`builder-tab${leftTab === tab.id ? " on" : ""}`}
                onClick={() => setLeftTab(tab.id)}
              >
                {tab.label}
                {/* A dot on Setup while no legend is chosen: the browser is empty
                    until one is, and "pick a legend first" is easy to miss when
                    it is on a tab you are not looking at. */}
                {tab.id === "setup" && !legendDef ? " •" : ""}
              </button>
            ))}
          </nav>

          <div className="builder-pane-body">
            {leftTab === "cards" &&
              (legendDef ? (
                <>
                  <CardBrowserFilters
                    filters={filters}
                    onChange={setFilters}
                    domains={legendDef.domains}
                    resultCount={visibleCards.length}
                    poolCount={legalCards.length}
                  />
                  {/* WHERE a click adds to. Replaces the second full card grid the
                      sideboard used to render — two identical ~520px grids on one
                      page, one of which you touch once a tournament. */}
                  <div className="browser-target">
                    <span>Adding to</span>
                    <div className="chip-group">
                      <button
                        className={`filter-chip${addTarget === "main" ? " on" : ""}`}
                        aria-pressed={addTarget === "main"}
                        onClick={() => setAddTarget("main")}
                      >
                        Main deck ({totalCount}/{DECK_SIZE})
                      </button>
                      <button
                        className={`filter-chip${addTarget === "sideboard" ? " on" : ""}`}
                        aria-pressed={addTarget === "sideboard"}
                        onClick={() => setAddTarget("sideboard")}
                      >
                        Sideboard ({sideboardTotal}/{SIDEBOARD_SIZE})
                      </button>
                    </div>
                  </div>
                  {visibleCards.some((def) => !isCardImplemented(def)) && (
                    <div className="card-browser-legend">
                      Greyed-out cards have no effect implemented yet — they can still be added, but their printed text does nothing in
                      play. Hover one to see what it should do.
                    </div>
                  )}
                  <div className="card-browser-grid" style={{ "--browser-cols": String(columns) } as CSSProperties}>
                    {visibleCards.map((def) => {
                      const count = activeCounts.get(def.id) ?? 0;
                      const atLimit = addTarget === "main" ? totalCount >= DECK_SIZE : sideboardTotal >= SIDEBOARD_SIZE;
                      return (
                        <CardBrowserTile
                          key={def.id}
                          def={def}
                          count={count}
                          isChampion={addTarget === "main" && def.id === championId}
                          onIncrement={() => addCard(def.id)}
                          onDecrement={() => removeCard(def.id)}
                          canIncrement={combinedCount(def.id) < MAX_COPIES && !atLimit}
                          canDecrement={count > 0 && !(addTarget === "main" && def.id === championId && count <= 1)}
                        />
                      );
                    })}
                  </div>
                  {visibleCards.length === 0 && <p className="deck-list-empty">No cards match those filters.</p>}
                </>
              ) : (
                <p className="deck-list-empty">Pick a legend on the Setup tab to browse its legal cards.</p>
              ))}

            {leftTab === "setup" && (
              <div className="builder-setup">
                <div className="deck-builder-section">
                  <div className="zone-label">Deck name</div>
                  <input
                    className="deck-builder-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My hypothetical build"
                  />
                </div>

                <div className="deck-builder-section">
                  <SingleSelectList
                    label="Legend"
                    items={legendOptions}
                    selectedId={legendId}
                    onSelect={selectLegend}
                    emptyText="No legends available."
                    markUnimplemented={unimplementedNote}
                  />
                </div>

                <div className="deck-builder-section">
                  <SingleSelectList
                    label="Champion"
                    items={championOptions}
                    selectedId={championId}
                    onSelect={selectChampion}
                    emptyText={legendDef ? "No eligible champions found." : "Pick a legend first."}
                    markUnimplemented={unimplementedNote}
                  />
                </div>

                {legendDef && orderedDomains && (
                  <div className="deck-builder-section">
                    <div className="zone-label">
                      Rune deck ({runeTotal}/{RUNE_DECK_SIZE})
                    </div>
                    <div className="rune-stepper-row">
                      <div className="rune-stepper">
                        <span style={{ color: DOMAIN_COLORS[orderedDomains[0]!] }}>{orderedDomains[0]}</span>
                        <button className="stepper-button" onClick={() => setRuneDomainACount(clampRune(runeDomainACount - 1))}>
                          −
                        </button>
                        <span>{runeDomainACount}</span>
                        <button className="stepper-button" onClick={() => setRuneDomainACount(clampRune(runeDomainACount + 1))}>
                          +
                        </button>
                      </div>
                      <div className="rune-stepper">
                        <span style={{ color: DOMAIN_COLORS[orderedDomains[1]!] }}>{orderedDomains[1]}</span>
                        <button className="stepper-button" onClick={() => setRuneDomainBCount(clampRune(runeDomainBCount - 1))}>
                          −
                        </button>
                        <span>{runeDomainBCount}</span>
                        <button className="stepper-button" onClick={() => setRuneDomainBCount(clampRune(runeDomainBCount + 1))}>
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {leftTab === "battlefields" && (
              <div className="builder-setup">
                <div className="deck-builder-section">
                  <div className="zone-label">Battlefields</div>
                  <div className="battlefield-inputs">
                    {battlefieldNames.map((value, i) => (
                      <input
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        className={`deck-builder-name-input${focusedBattlefieldIndex === i ? " focused" : ""}`}
                        value={value}
                        onFocus={() => setFocusedBattlefieldIndex(i)}
                        onChange={(e) => setBattlefieldName(i, e.target.value)}
                        placeholder={LEGACY_BATTLEFIELDS[i] ?? "Battlefield name"}
                      />
                    ))}
                  </div>
                  <p className="deck-list-empty">Click a card below to fill the focused slot above, or type a custom name directly.</p>
                  <div className="battlefield-picker-grid">
                    {battlefieldDefs.map((def) => (
                      <BattlefieldTile
                        key={def.id}
                        def={def}
                        selected={battlefieldNames.includes(def.name)}
                        onClick={() => {
                          setBattlefieldName(focusedBattlefieldIndex, def.name);
                          setFocusedBattlefieldIndex((focusedBattlefieldIndex + 1) % BATTLEFIELD_COUNT);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {leftTab === "import" && (
              <div className="builder-setup">
                <div className="deck-builder-section">
                  <div className="zone-label">Import a decklist</div>
                  <DecklistTextImport onParsed={applyImportedDeck} replaces={cardIds.length > 0 || legendId !== null} />
                  {importedUnresolved.length > 0 && (
                    <p className="deck-builder-inert-note">
                      Couldn&apos;t find these in the card pool — pick something else for them: {importedUnresolved.join(", ")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="builder-pane builder-right">
          <nav className="builder-tabs" role="tablist" aria-label="Deck view">
            {RIGHT_TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={rightTab === tab.id}
                className={`builder-tab${rightTab === tab.id ? " on" : ""}`}
                onClick={() => setRightTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
            <label className="browser-cols">
              Cols
              <select value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
                {[4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </nav>

          <div className="builder-pane-body">
            {rightTab === "deck" && (
              <>
                {inertCopies > 0 && (
                  <div className="deck-builder-inert-note">
                    {inertCopies} of {totalCount} cards have no effect implemented yet
                    {inertNames.length > 0 && <span className="deck-builder-inert-names"> — {inertNames.join(", ")}</span>}
                  </div>
                )}
                <DeckPanel
                  cardIds={cardIds}
                  championId={championId}
                  deckSize={DECK_SIZE}
                  onRemove={decrementCard}
                  onAdd={incrementCard}
                  canAdd={(id) => combinedCount(id) < MAX_COPIES && totalCount < DECK_SIZE}
                />
                {sideboardTotal > 0 && (
                  <DeckPanel
                    cardIds={sideboardCardIds}
                    championId={null}
                    deckSize={SIDEBOARD_SIZE}
                    onRemove={decrementSideboardCard}
                    onAdd={incrementSideboardCard}
                    canAdd={(id) => combinedCount(id) < MAX_COPIES && sideboardTotal < SIDEBOARD_SIZE}
                    title="Sideboard"
                    showCurve={false}
                  />
                )}
              </>
            )}
            {rightTab === "stats" && <DeckStatsView cardIds={cardIds} />}
            {rightTab === "hand" && <SampleHandView cardIds={cardIds} />}
          </div>
        </section>
      </div>
    </div>
  );
}
