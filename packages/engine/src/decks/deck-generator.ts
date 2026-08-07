import type { CardRegistry } from "../cards/card-registry.js";
import type { CardDefinition, UnitDefinition } from "../model/card-definition.js";
import { isCardImplemented, needsImplementation } from "../engine/coverage.js";
import {
  BATTLEFIELD_COUNT,
  DECK_SIZE,
  LEGACY_BATTLEFIELDS,
  MAX_COPIES,
  RUNE_DECK_SIZE,
  type DeckList,
} from "./deck-list.js";
import { isCardLegalForLegend, isEligibleChampion, isUniqueCard } from "./deck-validation.js";

/**
 * Builds a legal deck for a Legend, weighted toward cards you want to SEE.
 *
 * # Why this exists
 *
 * `coverage.ts` measures whether a card is registered; `probes/exercised.ts`
 * measures whether one has ever run. The second number is the honest one and it
 * is bounded by something neither the engine nor the AI controls: **a card no
 * deck contains cannot be played, however many games run.** When Spiritforged's
 * first card waves landed, 60 SFD cards were implemented and `exercised` reported
 * 0 of them, because the seven preset decks are pinned and none holds an SFD
 * card. That gap grows with every wave.
 *
 * # One deck per LEGEND, not a minimal card-cover
 *
 * Measured on OGN+OGS before this existed, and the difference is structural
 * rather than marginal:
 *
 * | strategy | decks | result |
 * |---|---|---|
 * | the 7 preset decks | 7 | 81/270 needing code exercised |
 * | greedy card-cover | 6 | all unreachable cards covered, 183/217 subjects run |
 * | **one deck per Legend** | **16** | **zero cards uncovered; 197/270; 47/56 champions** |
 *
 * A minimal cover collapses onto whichever Legends hold the most cards — the
 * 6-deck cover used 4 distinct Legends of 16, leaving 12 Legends, their
 * abilities and their eligible champions played by nobody. **A Legend is a card
 * too, and it is never "played"**, so a Legend that is nobody's Legend is
 * exercised by nothing at all.
 *
 * # It THROWS rather than quietly shipping a deck that missed
 *
 * `make-buffdeck.mjs` once printed "priority present" for cards its 39-card fill
 * loop had silently dropped, which is an instrument reporting its INPUT as its
 * output. So every failure here is loud and NAMES what did not fit: an
 * ineligible champion, a priority card that could not be seated, a deck that
 * could not be filled to 40. A generator that returns a plausible-looking deck
 * on failure is worse than one that returns nothing.
 */

export interface GeneratedDeck {
  deck: DeckList;
  /** The priority subjects that actually got a seat, with how many copies. */
  seated: Map<string, number>;
  /** Implemented, non-vanilla cards in the finished deck — what this run could
   *  possibly exercise. The ceiling, not a claim about what will run. */
  subjects: string[];
}

export interface GenerateOptions {
  /** Cards to seat FIRST, at `copies` each, before the deck is filled out.
   *  Anything here that cannot be seated is an error, not a shrug. */
  priority?: readonly string[];
  /** Copies of each priority card. Capped at 1 for `[Unique]` cards and at
   *  MAX_COPIES otherwise. Three is the deliberate default: a game draws about
   *  ten distinct cards of 39, so a single copy usually never appears, and
   *  "more games" buys less than more copies. */
  copies?: number;
  battlefieldNames?: readonly string[];
  name?: string;
}

/** How many copies of `def` a legal deck may hold. `[Unique]` (SFD) tightens the
 *  ordinary cap to 1, and asking `deck-validation` rather than re-deriving it is
 *  what stops the generator producing a deck its own validator rejects. */
function copyCapFor(def: CardDefinition): number {
  return isUniqueCard(def) ? 1 : MAX_COPIES;
}

/** Every champion eligible for this legend, best first — a Champion the legend
 *  can actually lead is required for a legal deck, and Rek'Sai proved that a
 *  Legend can have none at all. */
export function championsFor(legend: CardDefinition, registry: CardRegistry): UnitDefinition[] {
  return registry
    .all()
    .filter((c): c is UnitDefinition => c.type === "Unit" && c.isChampion)
    .filter((c) => isEligibleChampion(c, legend.name, legend.domains));
}

/**
 * Builds one legal deck led by `legendId`.
 *
 * Fill order is deliberate and is what makes the result reproducible: priority
 * subjects, then the champion's own copy, then everything else legal for the
 * legend in a stable id order — implemented-and-interesting cards first, so a
 * deck that has to drop something drops a vanilla body rather than a subject.
 */
export function generateDeckForLegend(
  legendId: string,
  registry: CardRegistry,
  options: GenerateOptions = {},
): GeneratedDeck {
  const legend = registry.tryGet(legendId);
  if (!legend) throw new Error(`generateDeckForLegend: unknown legend id ${legendId}`);
  if (legend.type !== "Legend") throw new Error(`generateDeckForLegend: ${legendId} is not a Legend`);
  if (legend.domains.length !== 2) {
    throw new Error(`generateDeckForLegend: ${legend.name} has ${legend.domains.length} domains, expected 2`);
  }

  const champions = championsFor(legend, registry);
  const champion = champions[0];
  if (!champion) {
    // The failure Rek'sai - Void Burrower really had: her Legend is cased
    // `Rek'sai` and both her champions `Rek'Sai`, so a literal prefix match found
    // none and NO legal deck existed for her. Named rather than returned as an
    // empty deck, because "this Legend cannot be played at all" is the finding.
    throw new Error(
      `generateDeckForLegend: ${legend.name} (${legendId}) has no eligible champion, ` +
        `so no legal deck can be built for it`,
    );
  }

  const copies = Math.max(1, Math.min(options.copies ?? MAX_COPIES, MAX_COPIES));
  const counts = new Map<string, number>();
  const seated = new Map<string, number>();
  const add = (def: CardDefinition, want: number): number => {
    const cap = copyCapFor(def);
    const already = counts.get(def.id) ?? 0;
    const room = Math.min(cap - already, want, DECK_SIZE - total());
    if (room <= 0) return 0;
    counts.set(def.id, already + room);
    return room;
  };
  const total = (): number => [...counts.values()].reduce((sum, n) => sum + n, 0);

  // 1. The champion's own copy, seated BEFORE the priority subjects.
  //
  // **It used to come second, and that was a real ordering bug rather than a
  // preference.** `validateDeckList` REQUIRES the champion, so its seat is not
  // optional — while the optional priority subjects were seated first, a set
  // with enough implemented cards could fill all 40 slots and crowd the
  // mandatory card out. That is exactly what happened as SFD's coverage grew:
  // `generateCoveringDecks` deals every implemented card of the set to the
  // Legend holding fewest, and at 161 implemented cards Draven - Glorious
  // Executioner's share finally reached 40 before his champion was placed.
  //
  // Found by `DECKS=sfd node probes/exercised.ts`, which is the sixth bug that
  // probe has found and the suite has not — and it surfaces as a THROW rather
  // than a wrong number, because a deck without its champion is illegal.
  //
  // A champion already named in `priority` is not double-seated: `add` is a
  // no-op once the copy cap is reached, and the `counts` check below skips it.
  if (add(champion, 1) === 0) {
    throw new Error(`generateDeckForLegend: no room for champion ${champion.name} in ${legend.name}'s deck`);
  }

  // 2. The priority subjects, seated in TWO PASSES: one copy of each first,
  //    then topped up to `copies` with whatever room is left.
  //
  // **One pass at `copies` each does not scale, and SFD is where it broke.**
  // `generateCoveringDecks` deals every implemented card of the set to the
  // Legend holding fewest; at 3 copies apiece, fourteen subjects want 42 of a
  // 39-card remainder, so the fourteenth was rejected and the whole deck threw —
  // even though all fourteen fit comfortably at one copy each. Since the stated
  // purpose of this generator is that every implemented card gets A SEAT, the
  // breadth pass has to come before the depth pass.
  //
  // The failure is therefore now honest: it throws only when there are more
  // DISTINCT subjects than slots, which is a real statement about the set rather
  // than an artefact of the copy count.
  const rejected: string[] = [];
  const eligible: CardDefinition[] = [];
  for (const defId of options.priority ?? []) {
    const def = registry.tryGet(defId);
    if (!def) {
      rejected.push(`${defId} (no such card)`);
      continue;
    }
    if (!isCardLegalForLegend(def, legend.domains)) {
      rejected.push(`${def.id} ${def.name} (shares no domain with ${legend.name})`);
      continue;
    }
    eligible.push(def);
  }
  for (const def of eligible) {
    const got = add(def, 1);
    if (got === 0) rejected.push(`${def.id} ${def.name} (no room left)`);
    else seated.set(def.id, got);
  }
  // Depth pass. A subject that missed its seat above is already recorded as
  // rejected and is not topped up.
  if (copies > 1) {
    for (const def of eligible) {
      if (!seated.has(def.id)) continue;
      const extra = add(def, copies - 1);
      if (extra > 0) seated.set(def.id, seated.get(def.id)! + extra);
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `generateDeckForLegend: ${legend.name} could not seat ${rejected.length} priority card(s): ` +
        rejected.join("; "),
    );
  }


  // 3. Fill to 40, most interesting first.
  //
  // **The legend's OWN SET comes first, and leaving that out made the whole
  // generator useless.** The first version sorted only by id, so `OGN-*` sorts
  // ahead of `SFD-*` and the older set filled all 40 slots before Spiritforged
  // was reached: 12 generated SFD decks between them contained THREE implemented
  // SFD cards. Every deck validated perfectly, which is the point — a deck of
  // legal filler is legal, and exercises nothing new.
  //
  // Then implemented-and-non-vanilla before the rest, so a deck that runs out of
  // room drops a vanilla body rather than a subject.
  const setCode = legend.id.split("-")[0];
  const ownSet = (c: CardDefinition): number => (c.id.startsWith(`${setCode}-`) ? 0 : 1);
  const worthWatching = (c: CardDefinition): number => (needsImplementation(c) && isCardImplemented(c) ? 0 : 1);
  const legal = registry
    .all()
    .filter((c) => isCardLegalForLegend(c, legend.domains))
    .sort(
      (a, b) => worthWatching(a) - worthWatching(b) || ownSet(a) - ownSet(b) || a.id.localeCompare(b.id),
    );
  for (const def of legal) {
    if (total() >= DECK_SIZE) break;
    add(def, copyCapFor(def));
  }
  if (total() < DECK_SIZE) {
    throw new Error(
      `generateDeckForLegend: only ${total()} of ${DECK_SIZE} cards are legal for ${legend.name} ` +
        `(${legend.domains.join("+")}) — the pool cannot fill this deck`,
    );
  }

  const cardIds: string[] = [];
  for (const [id, n] of counts) for (let i = 0; i < n; i += 1) cardIds.push(id);

  // An even split. `runeDomainACount`/`B` are positional — A is the legend's
  // lower-ordinal domain, per `sortByDomainOrdinal`, which is the call
  // `parseDecklistText` also makes — so an even split needs no opinion about
  // WHICH is A and cannot get it wrong. An uneven split would.
  const half = Math.floor(RUNE_DECK_SIZE / 2);

  return {
    deck: {
      name: options.name ?? `${legend.name} (generated)`,
      legendId,
      championId: champion.id,
      cardIds,
      runeDomainACount: half,
      runeDomainBCount: RUNE_DECK_SIZE - half,
      battlefieldNames: [...(options.battlefieldNames ?? LEGACY_BATTLEFIELDS)].slice(0, BATTLEFIELD_COUNT),
      sideboardCardIds: [],
    },
    seated,
    subjects: [...new Set(cardIds)].filter((id) => {
      const def = registry.get(id);
      return needsImplementation(def) && isCardImplemented(def);
    }),
  };
}

/** One deck per Legend of `setCode` — the strategy measured to leave zero cards
 *  and almost no champions uncovered. Legends with no eligible champion are
 *  REPORTED rather than skipped silently, because that is a real defect in the
 *  pool and the only thing that would notice it. */
export function generateDecksForSet(
  setCode: string,
  registry: CardRegistry,
  options: GenerateOptions = {},
): { decks: GeneratedDeck[]; unbuildable: string[] } {
  const decks: GeneratedDeck[] = [];
  const unbuildable: string[] = [];
  for (const legend of registry.all().filter((c) => c.type === "Legend" && c.id.startsWith(`${setCode}-`))) {
    try {
      decks.push(generateDeckForLegend(legend.id, registry, options));
    } catch (error) {
      unbuildable.push(`${legend.id} ${legend.name}: ${(error as Error).message}`);
    }
  }
  return { decks, unbuildable };
}

/**
 * One deck per Legend, with every implemented card of the set deliberately
 * ASSIGNED a seat — the coverage-driven form.
 *
 * `generateDecksForSet` above builds twelve perfectly legal decks and still
 * leaves cards homeless, measured: on SFD's first waves it reached 47 of 60
 * implemented cards, because each deck fills to 40 and its fill order is a sort,
 * not a plan. The thirteen it missed were not marginal — they were simply
 * further down the list than 40 slots reach.
 *
 * So the subjects are dealt out FIRST, each to the eligible Legend currently
 * holding fewest, and then handed to the generator as `priority` — where a card
 * that cannot be seated throws by name instead of being dropped. The result is
 * the "every card covered" property the one-deck-per-Legend measurement claimed,
 * rather than an approximation of it.
 *
 * A subject no Legend of this set can legally hold is REPORTED in `orphans`, not
 * skipped. That is a real finding about the set — a card printed in a domain
 * pair no Legend covers is unplayable in any deck led from its own set.
 */
export function generateCoveringDecks(
  setCode: string,
  registry: CardRegistry,
  options: GenerateOptions = {},
): { decks: GeneratedDeck[]; unbuildable: string[]; orphans: string[]; covered: number } {
  const legends = registry.all().filter((c) => c.type === "Legend" && c.id.startsWith(`${setCode}-`));
  const subjects = registry
    .all()
    .filter((c) => c.id.startsWith(`${setCode}-`) && c.type !== "Legend")
    .filter((c) => needsImplementation(c) && isCardImplemented(c))
    .sort((a, b) => a.id.localeCompare(b.id));

  const assignment = new Map<string, string[]>(legends.map((l) => [l.id, []]));
  const orphans: string[] = [];
  for (const subject of subjects) {
    const eligible = legends.filter((l) => isCardLegalForLegend(subject, l.domains));
    if (eligible.length === 0) {
      orphans.push(`${subject.id} ${subject.name} [${subject.domains.join("+")}]`);
      continue;
    }
    // Fewest-first, tie-broken by id so the deal is deterministic — a probe
    // figure measured against a deck that changes run to run compares with
    // nothing.
    const target = eligible
      .slice()
      .sort((a, b) => (assignment.get(a.id)!.length - assignment.get(b.id)!.length) || a.id.localeCompare(b.id))[0]!;
    assignment.get(target.id)!.push(subject.id);
  }

  const decks: GeneratedDeck[] = [];
  const unbuildable: string[] = [];
  for (const legend of legends) {
    try {
      decks.push(
        generateDeckForLegend(legend.id, registry, { ...options, priority: assignment.get(legend.id) ?? [] }),
      );
    } catch (error) {
      unbuildable.push(`${legend.id} ${legend.name}: ${(error as Error).message}`);
    }
  }
  const seatedIds = new Set(decks.flatMap((d) => [...d.seated.keys()]));
  return { decks, unbuildable, orphans, covered: seatedIds.size };
}
