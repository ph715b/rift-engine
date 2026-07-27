/**
 * The four preconstructed Origins: Proving Grounds decks — reused directly
 * from registry/DeckPresets.java rather than re-sourced, per PRD decision
 * (these are also, per the resolved open-question #1, Origins' "starter
 * decks" — there is no separate starter-deck list). Decklists originally
 * sourced from riftmana.com, cross-referenced with riftDecks.com.
 */
export interface PresetDeck {
  name: string;
  legendId: string;
  championId: string;
  deckCardIds: string[];
}

function deck(...pairs: [count: number, id: string][]): string[] {
  const ids: string[] = [];
  for (const [count, id] of pairs) {
    for (let i = 0; i < count; i++) ids.push(id);
  }
  return ids;
}

const ANNIE: PresetDeck = {
  name: "Annie: Fury + Chaos",
  legendId: "OGS-017",
  championId: "OGS-010",
  deckCardIds: deck(
    [3, "OGN-169"], // Gust
    [3, "OGN-170"], // Morbid Return
    [3, "OGN-171"], // Mystic Poro
    [2, "OGN-013"], // Pouty Poro
    [3, "OGN-185"], // Traveling Merchant
    [3, "OGS-003"], // Incinerate
    [2, "OGS-011"], // Flash
    [3, "OGN-176"], // Sneaky Deckhand
    [2, "OGS-010"], // Annie, Stubborn
    [3, "OGN-005"], // Disintegrate
    [2, "OGS-001"], // Annie, Fiery
    [3, "OGN-191"], // Maddened Marauder
    [3, "OGS-002"], // Firestorm
    [3, "OGN-174"], // Sai Scout
    [2, "OGS-018"], // Tibbers
  ),
};

const GAREN: PresetDeck = {
  name: "Garen: Body + Order",
  legendId: "OGS-023",
  championId: "OGS-007",
  deckCardIds: deck(
    [3, "OGN-129"], // Confront
    [3, "OGN-210"], // Daring Poro
    [3, "OGN-130"], // Crackshot Corsair
    [3, "OGN-132"], // First Mate
    [3, "OGN-211"], // Faithful Manufactor
    [3, "OGN-222"], // Noxian Drummer
    [3, "OGN-206"], // Back to Back
    [3, "OGN-219"], // Vanguard Sergeant
    [2, "OGN-131"], // Dune Drake
    [2, "OGN-215"], // Petty Officer
    [2, "OGS-024"], // Decisive Strike
    [2, "OGS-007"], // Garen, Rugged
    [2, "OGS-013"], // Garen, Commander
    [3, "OGS-016"], // Vanguard Attendant
    [3, "OGS-015"], // Recruit the Vanguard
  ),
};

const LUX: PresetDeck = {
  name: "Lux: Mind + Order",
  legendId: "OGS-021",
  championId: "OGS-014",
  deckCardIds: deck(
    [3, "OGN-095"], // Stupefy
    [3, "OGN-210"], // Daring Poro
    [3, "OGN-103"], // Ravenbloom Student
    [3, "OGN-206"], // Back to Back
    [2, "OGN-084"], // Eager Apprentice
    [3, "OGN-087"], // Lecturing Yordle
    [2, "OGS-014"], // Lux, Crownguard
    [3, "OGN-219"], // Vanguard Sergeant
    [3, "OGN-085"], // Falling Comet
    [3, "OGS-012"], // Blast of Power
    [2, "OGS-006"], // Lux, Illuminated
    [3, "OGN-105"], // Singularity
    [3, "OGS-016"], // Vanguard Attendant
    [2, "OGN-088"], // Mega-Mech
    [2, "OGS-022"], // Final Spark
  ),
};

const MASTER_YI: PresetDeck = {
  name: "Master Yi: Calm + Body",
  legendId: "OGS-019",
  championId: "OGS-004",
  deckCardIds: deck(
    [3, "OGN-046"], // En Garde
    [3, "OGN-048"], // Meditation
    [3, "OGN-052"], // Stalwart Poro
    [3, "OGN-127"], // Cannon Barrage
    [3, "OGN-134"], // Mobilize
    [2, "OGN-129"], // Confront
    [3, "OGN-055"], // Wielder of Water
    [2, "OGS-020"], // Highlander
    [3, "OGN-049"], // Playful Phantom
    [2, "OGS-004"], // Master Yi, Meditative
    [3, "OGS-005"], // Zephyr Sage
    [3, "OGS-008"], // Gentlemen's Duel
    [3, "OGN-137"], // Stormclaw Ursine
    [2, "OGS-009"], // Master Yi, Honed
    [2, "OGN-142"], // Mountain Drake
  ),
};

const ALL_PRESETS: PresetDeck[] = [ANNIE, GAREN, LUX, MASTER_YI];

const BY_LEGEND = new Map(ALL_PRESETS.map((d) => [d.legendId, d]));

export function allPresetDecks(): PresetDeck[] {
  return ALL_PRESETS;
}

export function presetDeckForLegend(legendId: string): PresetDeck {
  const deckPreset = BY_LEGEND.get(legendId);
  if (!deckPreset) throw new Error(`No preset deck for legend: ${legendId}`);
  return deckPreset;
}
