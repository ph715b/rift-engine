import { LEGACY_BATTLEFIELDS, type DeckList } from "./deck-list.js";

/**
 * The preconstructed Origins decks.
 *
 * The first four (Annie/Garen/Lux/Master Yi) are the Proving Grounds precons,
 * reused directly from registry/DeckPresets.java rather than re-sourced, per PRD
 * decision. Decklists originally sourced from riftmana.com, cross-referenced
 * with riftDecks.com.
 *
 * **Correction:** this comment used to assert that those four were also Origins'
 * "starter decks" and that "there is no separate starter-deck list". That was
 * wrong — Origins has its own Jinx / Lee Sin / Viktor starter decks, whose
 * Legends (OGN-251 / OGN-257 / OGN-265) and champions have been in the card pool
 * all along. The Java oracle simply never carried those lists, which is why the
 * claim went unchallenged. Jinx and Lee Sin are below; Viktor is still missing
 * its list.
 */
export interface PresetDeck {
  name: string;
  legendId: string;
  championId: string;
  deckCardIds: string[];
  /**
   * The deck's own three battlefields, when it has a verified trio.
   *
   * Absent for the Proving Grounds four, which fall back to LEGACY_BATTLEFIELDS
   * because they have "no verified real battlefield trio of their own to draw
   * from" (registry/CustomDeckRegistry.java:16-18). The Origins starter decks DO
   * specify theirs, and it matters now that battlefield choice is a real
   * mechanic: Best-of-3 has you present one per game and eliminates it
   * afterwards (rule 487.2/487.3), so a deck presenting the wrong trio plays
   * differently.
   */
  battlefieldNames?: string[];
}

/**
 * Fills in the fields a PresetDeck doesn't carry (DeckPresets.java's own
 * record is just name/legendId/championId/deckCardIds) with the same
 * defaults `SetupController` uses for these specific presets: a 6/6 rune
 * split and the legacy battlefield trio, since the presets have "no
 * verified real battlefield trio of their own to draw from"
 * (registry/CustomDeckRegistry.java:16-18). No sideboard.
 */
export function presetDeckList(preset: PresetDeck): DeckList {
  return {
    name: preset.name,
    legendId: preset.legendId,
    championId: preset.championId,
    cardIds: preset.deckCardIds,
    runeDomainACount: 6,
    runeDomainBCount: 6,
    battlefieldNames: preset.battlefieldNames ?? LEGACY_BATTLEFIELDS,
    sideboardCardIds: [],
  };
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

/**
 * Origins starter deck. Unlike the Proving Grounds four this one carries its own
 * battlefield trio, and the champion's copy is counted inside the 40 (rule: the
 * one set-aside champion comes out of the main deck, see player-setup.ts).
 *
 * Every name in the supplied list resolved against the registry with zero
 * unresolved entries, and `validateDeckList` passes — checked by running the
 * list through the app's own `parseDecklistText` rather than transcribing ids by
 * hand.
 */
const JINX: PresetDeck = {
  name: "Jinx: Fury + Chaos",
  legendId: "OGN-251",
  championId: "OGN-030",
  battlefieldNames: ["Reaver's Row", "Targon's Peak", "Zaun Warrens"],
  deckCardIds: deck(
    [3, "OGN-002"], // Brazen Buccaneer
    [3, "OGN-003"], // Chemtech Enforcer
    [3, "OGN-006"], // Flame Chompers
    [3, "OGN-019"], // Raging Soul
    [3, "OGN-168"], // Fight or Flight
    [3, "OGN-169"], // Gust
    [3, "OGN-182"], // Scrapheap
    [3, "OGN-185"], // Traveling Merchant
    [2, "OGN-001"], // Blazing Scorcher
    [2, "OGN-008"], // Get Excited!
    [2, "OGN-024"], // Void Seeker
    [2, "OGN-165"], // Cemetery Attendant
    [2, "OGN-178"], // Undercover Agent
    [2, "OGN-180"], // Fading Memories
    [1, "OGN-011"], // Magma Wurm
    [1, "OGN-195"], // Rhasa the Sunderer
    [1, "OGN-036"], // Vi - Destructive
    [1, "OGN-030"], // Jinx - Demolitionist (the champion's own copy)
  ),
};

/** Origins starter deck — see JINX above for the sourcing note. */
const LEE_SIN: PresetDeck = {
  name: "Lee Sin: Calm + Body",
  legendId: "OGN-257",
  championId: "OGN-151",
  battlefieldNames: ["Grove of the God-Willow", "Monastery of Hirana", "Targon's Peak"],
  deckCardIds: deck(
    [3, "OGN-052"], // Stalwart Poro
    [3, "OGN-055"], // Wielder of Water
    [3, "OGN-058"], // Discipline
    [3, "OGN-065"], // Wizened Elder
    [3, "OGN-128"], // Challenge
    [3, "OGN-132"], // First Mate
    [3, "OGN-136"], // Pit Rookie
    [3, "OGN-147"], // Wildclaw Shaman
    [2, "OGN-043"], // Charm
    [2, "OGN-053"], // Stand United
    [2, "OGN-125"], // Bilgewater Bully
    [2, "OGN-135"], // Pakaa Cub
    [2, "OGN-137"], // Stormclaw Ursine
    [2, "OGN-142"], // Mountain Drake
    [1, "OGN-060"], // Mask of Foresight
    [1, "OGN-152"], // Mistfall
    [1, "OGN-157"], // Udyr - Wildman
    [1, "OGN-151"], // Lee Sin - Centered (the champion's own copy)
  ),
};

// Viktor's starter deck is deliberately absent: the list supplied for it was a
// verbatim duplicate of Lee Sin's (same Legend, champion, 17 entries,
// battlefields and rune split), so there is nothing to add yet. Its Legend
// (OGN-265 Viktor - Herald of the Arcane) and champions are already in the pool,
// so it only needs the real list.
const ALL_PRESETS: PresetDeck[] = [ANNIE, GAREN, LUX, MASTER_YI, JINX, LEE_SIN];

const BY_LEGEND = new Map(ALL_PRESETS.map((d) => [d.legendId, d]));

export function allPresetDecks(): PresetDeck[] {
  return ALL_PRESETS;
}

export function presetDeckForLegend(legendId: string): PresetDeck {
  const deckPreset = BY_LEGEND.get(legendId);
  if (!deckPreset) throw new Error(`No preset deck for legend: ${legendId}`);
  return deckPreset;
}
