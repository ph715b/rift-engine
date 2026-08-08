/**
 * **Why was this card never offered?** — the follow-up `reachability.ts` cannot
 * answer.
 *
 *     CARDS=OGN-080,SFD-097 node packages/engine/probes/why-not-offered.ts
 *
 * `reachability` puts a card in `drawnNeverOffered`: it reached a hand and
 * `legalActions` never enumerated it. That is a lead, not a diagnosis, and the
 * three things it can mean take completely different work:
 *
 *  - **The holder could never PAY for it.** OGN-158 Volibear is 12 Energy in a
 *    pool whose median is 3 and a game that lasts 5–8 turns. Nothing is wrong.
 *  - **The timing never came up.** A `[Reaction]` needs a chain to react to, and
 *    an `[Action]` needs the holder's turn or a showdown.
 *  - **It was affordable, legal-timed, and still not enumerated.** *That* is a
 *    bug, and it is the offered-then-refused family's mirror image.
 *
 * # It asks the ENGINE, it does not recompute
 *
 * Affordability is `computeAutoPayment` — the engine's own payment solver, the
 * one `legalActions` itself uses. A probe that reimplemented the rune math would
 * be a second opinion about the very thing under test, and this repo has a
 * standing record of instruments that disagreed with the engine and were
 * believed.
 *
 * **The one approximation, stated because it changes how to read the output:**
 * it passes the card's PRINTED cost, not its modified one. Discounts (Legion,
 * scaled power, optional costs) only ever make a card cheaper, so `affordable`
 * here is a LOWER bound — a card this reports as never affordable really was
 * never affordable. `[Deflect]` surcharges run the other way, so a card reported
 * affordable may still have been legitimately unpayable against a specific
 * target. Read `affordable > 0` as "worth investigating", never as "the engine is
 * wrong".
 *
 * # What is gated
 *
 * `inHand > 0` for every named card — a diagnosis about a card that never turned
 * up is not a diagnosis, and a silent `0/0` reads exactly like a clean result.
 * That is the `tried > 0` rule from README.md, which exists because a check that
 * never ran reports a pass.
 */
import { computeAutoPayment, defaultCardRegistry, legalActions, matchesPowerDomain } from "@rift-engine/engine";
import type { CardDefinition, GameState } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { poolFacts } from "./pool-facts.ts";
import { runExercise } from "./exercise-run.ts";

const GAMES = Number(process.env.GAMES ?? 40);
const CARDS = (process.env.CARDS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s.length > 0);

if (CARDS.length === 0) {
  console.error("CARDS=OGN-080,SFD-097 node probes/why-not-offered.ts  (comma-separated defIds, required)");
  process.exit(2);
}

const registry = defaultCardRegistry();
const facts = poolFacts(registry);

/**
 * Everything that can be in a hand and therefore have a cost. A `LegendDefinition`
 * has neither — it begins on the board — so it is excluded HERE rather than cast
 * away at each use, and asking about one is a usage error with an answer:
 * `reachability`'s `startsInPlayNeverActed` is the bucket for those.
 */
type PlayableDef = Extract<CardDefinition, { energyCost: number }>;
const defs = new Map<string, PlayableDef>(
  registry
    .all()
    .filter((d): d is PlayableDef => d.type !== "Legend")
    .map((d) => [d.id, d]),
);

for (const id of CARDS) {
  if (defs.has(id)) continue;
  const known = registry.all().some((d) => d.id === id);
  console.error(
    known
      ? `${id} is a Legend — it is never in a hand, so this probe cannot diagnose it. See reachability's startsInPlayNeverActed.`
      : `${id} is not in the registry`,
  );
  process.exit(2);
}

interface Tally {
  /**
   * **Distinct GAMES in which the card reached a hand — the honest denominator.**
   *
   * `inHand` below counts states, and a card sits in a hand across every action
   * of every turn until it is played, so the two differ by an order of magnitude
   * and the state count flatters the sample badly. Punch First read as "86
   * in-hand states, never affordable", which sounds like a thoroughly tested
   * negative and was really a handful of games.
   */
  gamesInHand: Set<string>;
  /** States where the card sat in somebody's hand. NOT independent samples. */
  inHand: number;
  /** …and the holder's channeled runes could cover the PRINTED cost. */
  affordable: number;
  /** …and it was the holder's turn (the timing an [Action] or a Unit needs). */
  affordableOnOwnTurn: number;
  /** …and there was something on the chain to react to (what a [Reaction] is
   *  for). Counted separately because a Reaction with no chain is correctly
   *  unoffered, and would otherwise read as a gap. */
  affordableWithChain: number;
  /** States where `legalActions` DID enumerate this exact card instance. Nonzero
   *  here contradicts `reachability` and means one of the two is wrong. */
  offered: number;
  /** States where the card was affordable on its holder's turn and the engine
   *  offered the holder SOME other card — so "nothing was playable at all" is
   *  ruled out as the explanation. */
  affordableWhileOthersOffered: number;
  /** The most runes the holder ever had channeled at once while holding it. */
  maxChanneled: number;
  /** …and the most of those that MATCHED this card's power domain. A
   *  "never affordable" verdict is only worth trusting beside these two: they say
   *  how close it came, and a card needing 2 matching runes that never saw more
   *  than 1 is a different story from one that saw 5. */
  maxMatchingRunes: number;
}

const tally = new Map<string, Tally>(
  CARDS.map((id) => [
    id,
    {
      gamesInHand: new Set<string>(),
      inHand: 0,
      affordable: 0,
      affordableOnOwnTurn: 0,
      affordableWithChain: 0,
      offered: 0,
      affordableWhileOthersOffered: 0,
      maxChanneled: 0,
      maxMatchingRunes: 0,
    },
  ]),
);

const wanted = new Set(CARDS);

/**
 * Below this many distinct games, this probe refuses to draw a conclusion.
 *
 * Not a statistical threshold — a floor under the failure it actually hit.
 * Punch First reported "86 in-hand states, never affordable" and that read as a
 * thoroughly sampled negative; the state count was inflated by a card sitting in
 * hand across every action of a turn, and the real figure was a handful of games.
 * README.md's rule is `tried > 0`; this is the same rule at the sample size a
 * verdict actually needs.
 */
const THIN_SAMPLE = 5;

function canPay(state: GameState, playerIndex: number, def: PlayableDef): boolean {
  const player = state.players[playerIndex];
  if (player === undefined) return false;
  return computeAutoPayment(player.channeled, def.energyCost, def.powerCost, def.powerDomain ?? null) !== null;
}

/** Set by the mode loop below, so a game index can be told apart from the same
 *  index in another mode. */
let currentMode = "";

function observe(state: GameState, game: number): void {
  // Enumerated ONCE per state and reused: `legalActions` is the expensive call,
  // and asking it per card would multiply this probe's cost by |CARDS|.
  let offeredHere: Set<string> | undefined;
  let anyPlayOffered = false;

  for (let index = 0; index < state.players.length; index++) {
    const player = state.players[index];
    if (player === undefined) continue;
    for (const card of player.hand) {
      if (!wanted.has(card.defId)) continue;
      const row = tally.get(card.defId);
      const def = defs.get(card.defId);
      if (row === undefined || def === undefined) continue;

      row.inHand++;
      row.gamesInHand.add(`${currentMode}#${game}`);
      if (offeredHere === undefined) {
        offeredHere = new Set<string>();
        for (const action of legalActions(state)) {
          if (action.type === "PlayCard") {
            offeredHere.add(action.card.instanceId);
            anyPlayOffered = true;
          }
        }
      }
      if (offeredHere.has(card.instanceId)) row.offered++;

      row.maxChanneled = Math.max(row.maxChanneled, player.channeled.length);
      // `matchesPowerDomain` rather than a `r.domain === def.powerDomain`
      // comparison of this probe's own: the engine's rule already handles the
      // alt-domain and null cases, and a second opinion about the thing under
      // test is how an instrument here has been wrong before.
      row.maxMatchingRunes = Math.max(
        row.maxMatchingRunes,
        player.channeled.filter((r) => matchesPowerDomain(r, def.powerDomain ?? null)).length,
      );

      if (!canPay(state, index, def)) continue;
      row.affordable++;
      const ownTurn = state.activePlayerIndex === index;
      if (ownTurn) row.affordableOnOwnTurn++;
      if (state.spellChain.length > 0) row.affordableWithChain++;
      if (ownTurn && anyPlayOffered) row.affordableWhileOthersOffered++;
    }
  }
}

for (const mode of [undefined, ...facts.setCodesWithLegend]) {
  currentMode = mode ?? "presets";
  console.error(`why-not-offered: running ${currentMode}…`);
  runExercise(mode, GAMES, registry, observe);
}

const rows = CARDS.map((id) => {
  const def = defs.get(id)!;
  const row = tally.get(id)!;
  const { gamesInHand, ...counts } = row;
  return {
    card: facts.label(id),
    type: def.type,
    energyCost: def.energyCost,
    powerCost: def.powerCost,
    powerDomain: def.powerDomain,
    isReaction: def.isReaction,
    gamesInHand: gamesInHand.size,
    ...counts,
    /** The one-line reading, so the report does not need re-deriving each time.
     *  Deliberately conservative: anything it cannot explain says so. */
    verdict:
      row.inHand === 0
        ? "NEVER IN HAND — nothing measured"
        : gamesInHand.size < THIN_SAMPLE && row.offered === 0
          ? `THIN SAMPLE — reached a hand in only ${gamesInHand.size} game(s); raise GAMES before concluding anything`
        : row.offered > 0
          ? "OFFERED — it IS enumerable; if reachability listed it as never offered, the two instruments disagree and that comes first"
          : row.affordable === 0
            ? "NEVER AFFORDABLE — printed cost was never payable; not an engine defect"
            : row.affordableOnOwnTurn === 0 && def.isReaction !== true
              ? "AFFORDABLE, but never on its holder's turn"
              : def.isReaction === true && row.affordableWithChain === 0
                ? "AFFORDABLE, but never with a chain to react to"
                : "AFFORDABLE AND LEGAL-TIMED, still never offered — LEAD",
  };
});

const controls = {
  /** `tried > 0`, per card. A diagnosis about a card that never turned up is not
   *  a diagnosis, and 0/0 reads exactly like a clean result. */
  everyCardSeenInHand: rows.every((r) => r.inHand > 0),
};

report("why-not-offered", { gamesPerMode: GAMES, cards: rows, controls }, Object.values(controls).every(Boolean));
