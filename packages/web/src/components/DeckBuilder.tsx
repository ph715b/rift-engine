import { useMemo, useState } from "react";
import {
  BATTLEFIELD_COUNT,
  DECK_SIZE,
  LEGACY_BATTLEFIELDS,
  MAX_COPIES,
  RUNE_DECK_SIZE,
  SIDEBOARD_SIZE,
  defaultCardRegistry,
  isCardLegalForLegend,
  isEligibleChampion,
  loadBattlefieldDefinitions,
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
}

/** The same "pick one of several named things" pattern Lobby.tsx's
 *  DeckListPicker already established (deck-list/deck-option classes) —
 *  reused here for the legend and champion pickers instead of a new markup. */
function SingleSelectList<T extends { id: string; name: string }>({
  label,
  items,
  selectedId,
  onSelect,
  emptyText,
}: SingleSelectListProps<T>) {
  return (
    <div>
      <div className="zone-label">{label}</div>
      <div className="deck-list">
        {items.map((item) => (
          <div key={item.id} className={`deck-option${selectedId === item.id ? " selected" : ""}`}>
            <button className="deck-option-button" onClick={() => onSelect(item.id)}>
              {item.name}
            </button>
          </div>
        ))}
        {items.length === 0 && <p className="deck-list-empty">{emptyText}</p>}
      </div>
    </div>
  );
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

  return (
    <div className={`card-tile${count > 0 ? " in-deck" : ""}`}>
      {def.imageUrl ? (
        <img className="card-tile-art" src={def.imageUrl} alt={def.name} draggable={false} loading="lazy" />
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
  const [searchText, setSearchText] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);

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

  const browsableCards = useMemo(() => {
    if (!legendDef) return [];
    const query = searchText.trim().toLowerCase();
    return registry
      .all()
      .filter((c) => isCardLegalForLegend(c, legendDef.domains))
      .filter((c) => (query ? c.name.toLowerCase().includes(query) : true));
  }, [registry, legendDef, searchText]);

  const totalCount = cardIds.length;
  const sideboardTotal = sideboardCardIds.length;
  const runeTotal = runeDomainACount + runeDomainBCount;

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
        <button onClick={onCancel}>Back</button>
      </div>

      {unresolvedNames && unresolvedNames.length > 0 && !warningDismissed && (
        <div className="deck-import-warning">
          <button className="deck-import-warning-dismiss" onClick={() => setWarningDismissed(true)} title="Dismiss">
            ✕
          </button>
          <p>Couldn't find these in the card pool — pick something else for them below:</p>
          <p>{unresolvedNames.join(", ")}</p>
        </div>
      )}

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
        />
      </div>

      <div className="deck-builder-section">
        <SingleSelectList
          label="Champion"
          items={championOptions}
          selectedId={championId}
          onSelect={selectChampion}
          emptyText={legendDef ? "No eligible champions found." : "Pick a legend first."}
        />
      </div>

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

      <div className="deck-builder-section card-browser">
        <div className="zone-label">
          Main deck ({totalCount}/{DECK_SIZE})
        </div>
        {legendDef ? (
          <>
            <input
              className="deck-builder-search-input"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search cards..."
            />
            <div className="card-browser-grid">
              {browsableCards.map((def) => {
                const count = copyCounts.get(def.id) ?? 0;
                return (
                  <CardBrowserTile
                    key={def.id}
                    def={def}
                    count={count}
                    isChampion={def.id === championId}
                    onIncrement={() => incrementCard(def.id)}
                    onDecrement={() => decrementCard(def.id)}
                    canIncrement={combinedCount(def.id) < MAX_COPIES && totalCount < DECK_SIZE}
                    canDecrement={count > 0 && !(def.id === championId && count <= 1)}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <p className="deck-list-empty">Pick a legend to browse its legal cards.</p>
        )}
      </div>

      <div className="deck-builder-section card-browser">
        <div className="zone-label">
          Sideboard ({sideboardTotal}/{SIDEBOARD_SIZE})
        </div>
        {legendDef ? (
          <div className="card-browser-grid">
            {browsableCards.map((def) => {
              const count = sideboardCopyCounts.get(def.id) ?? 0;
              return (
                <CardBrowserTile
                  key={def.id}
                  def={def}
                  count={count}
                  isChampion={false}
                  onIncrement={() => incrementSideboardCard(def.id)}
                  onDecrement={() => decrementSideboardCard(def.id)}
                  canIncrement={combinedCount(def.id) < MAX_COPIES && sideboardTotal < SIDEBOARD_SIZE}
                  canDecrement={count > 0}
                />
              );
            })}
          </div>
        ) : (
          <p className="deck-list-empty">Pick a legend to browse its legal cards.</p>
        )}
      </div>

      <div className="actions">
        {saveError && <p className="deck-import-error">{saveError}</p>}
        <button onClick={handleDownload}>Download .deck</button>
        <button className="menu-primary-button" onClick={handleSave}>
          Save deck
        </button>
      </div>
    </div>
  );
}
