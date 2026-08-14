import type { CardRegistry } from "../cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../model/card.js";
import type { PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import type { Domain } from "../model/domain.js";
import { sortByDomainOrdinal } from "../model/domain.js";
import { shuffle, type Rng } from "../util/rng.js";
import { validateDeckList } from "./deck-validation.js";
import type { DeckList } from "./deck-list.js";

let runeInstanceCounter = 0;
function buildRuneDeck(domains: readonly Domain[], firstCount: number, secondCount: number): RuneCard[] {
  const ordered = sortByDomainOrdinal(domains);
  if (ordered.length !== 2) throw new Error(`Legend must have exactly 2 domains, got ${ordered.length}`);
  const [first, second] = ordered as [Domain, Domain];
  const runes: RuneCard[] = [];
  for (let i = 0; i < firstCount; i++) {
    runeInstanceCounter += 1;
    runes.push({ id: `rune-${runeInstanceCounter}`, domain: first, state: "Ready" });
  }
  for (let i = 0; i < secondCount; i++) {
    runeInstanceCounter += 1;
    runes.push({ id: `rune-${runeInstanceCounter}`, domain: second, state: "Ready" });
  }
  return runes;
}

/**
 * Builds a fresh, ready-to-play PlayerState from a validated DeckList:
 * pulls exactly one copy of the champion out into `championZone`, shuffles
 * the remaining 39 cards into the draw deck, and builds a 12-card rune deck
 * split across the legend's two domains. Mirrors
 * CardRegistry.buildPlayerWithChampion (registry/CardRegistry.java:220-249).
 * `rng` is required (not defaulted) so callers make the seeded-shuffle
 * choice explicit — determinism/replayability is a stated NFR.
 */
export function buildPlayerFromDeckList(
  id: string,
  name: string,
  deckList: DeckList,
  registry: CardRegistry,
  rng: Rng,
): PlayerState {
  const validation = validateDeckList(deckList, registry);
  if (!validation.ok) throw new Error(`Invalid deck "${deckList.name}": ${validation.error}`);

  const legendDef = registry.get(deckList.legendId);
  const legend = createCardInstance(legendDef) as LegendInstance;

  let championPulled = false;
  const deck = [];
  for (const cardId of deckList.cardIds) {
    if (!championPulled && cardId === deckList.championId) {
      championPulled = true;
      continue;
    }
    deck.push(createCardInstance(registry.get(cardId)));
  }
  shuffle(deck, rng);

  const championInstance = createCardInstance(registry.get(deckList.championId)) as UnitInstance;
  const runeDeck = buildRuneDeck(legendDef.domains, deckList.runeDomainACount, deckList.runeDomainBCount);
  // Real rune decks are shuffled too, same as the main deck — mirrors
  // CardRegistry.buildRuneDeck's `Collections.shuffle(runes)`
  // (registry/CardRegistry.java:214). Missing this meant every game
  // predictably drew one whole domain's runes before ever touching the other.
  shuffle(runeDeck, rng);

  return {
    id,
    name,
    legend,
    championZone: championInstance,
    // Recorded here because this is the only place that knows it: the zone goes
    // empty the moment the champion is played, and Hallowed Tomb asks after that.
    chosenChampionDefId: deckList.championId,
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    deck,
    hand: [],
    trash: [],
    banished: [],
    activeGear: [],
    runeDeck,
    channeled: [],
    baseUnits: [],
    points: 0,
    xp: 0,
    floatingEnergy: 0,
    floatingPower: {},
    floatingRainbowPower: 0,
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
    xpGainedThisTurn: false,
    scoredBattlefieldsThisTurn: [],
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
    restrictedSpellPower: 0,
    restrictedGearPower: 0,
    gearPlayedThisTurn: 0,
    enemyChoicesThisTurn: 0,
    nextSpellRepeatGrants: 0,
    equipmentPlayedThisTurn: 0,
    nextUnitsEnterReady: 0,
    freeGearPlaysThisTurn: 0,
    trashUnitPlaysThisTurn: 0,
    replacedCostPlays: [],
    banishedUntilHold: [],
    pointsFromHoldingThisTurn: 0,
    powerSpentThisTurn: 0,
    maxSpellEnergySpentThisTurn: 0,
    spellsPlayedThisTurn: 0,
    cardsDrawnThisTurn: 0,
    buffUnitsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    unitsLostThisTurn: 0,
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    cannotPlaySpellsThisTurn: false,
    unitsLostInBeginningPhaseThisTurn: 0,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
  };
}
