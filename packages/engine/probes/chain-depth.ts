/**
 * POSITIVE CONTROL for triggers-as-Chain-Pending-Items.
 *
 * The termination gates (ai-health 40/40, passive-human 16/16) stay green whether
 * the conversion works or never fires at all — "no games broke" is equally true of
 * a change that does nothing. This measures that it DOES something:
 *
 *   - triggers are actually held in `pendingTriggers` (must be > 0, or nothing was
 *     converted in any reachable line of play and every other number is vacuous);
 *   - held triggers reach `spellChain` as `kind: "trigger"` entries;
 *   - the chain they open is actually PASSED on, so a response window really exists;
 *   - the pen is EMPTY in every settled state — a trigger left in it is one nobody
 *     can ever resolve, the same invariant `unitsAwaitingDeathReplacement` needed
 *     and did not have.
 *
 * **Two scenarios, and the second is not a duplicate of the first.**
 *
 *  1. `buff` — a purpose-built Sett buff deck. `unitBuffed` was the first converted
 *     event and this deck places ~2700 buffs per 300 games, so the sample is real
 *     rather than incidental. Its numbers are the recorded baseline; the deck is
 *     built the same way it always was so successive runs stay comparable.
 *  2. `awaken` — the same legend with **Pirate's Haven** forced into the list. The
 *     `unitReadied` event fires once per exhausted unit during the Awakening Phase
 *     (rule 415), which is the first thing in this engine that can make the chain
 *     deep through routine play rather than through a combo: a player with six
 *     exhausted units puts six Pending Items on the chain at the top of every turn,
 *     and each costs both players a PassFocus. Nothing in scenario 1 exercises
 *     that shape, and a gate that cannot see it would stay green if an Awaken-fired
 *     trigger were stranded every single turn.
 *
 * Everything is counted from the STATE STREAM, never from inside the engine. A
 * probe that wraps a trigger's `resolve` also counts the heuristic AI's LOOKAHEAD,
 * which applies every candidate action through the real executors in order to
 * score it — that is how one card was once reported "played 259 times" when the
 * true answer was zero.
 */
import { defaultCardRegistry, isEligibleChampion, LEGACY_BATTLEFIELDS, chooseAction, legalActions, submit } from "@rift-engine/engine";
import type { DeckList } from "./harness.ts";
import { legacyBattlefields, report, startedGame } from "./harness.ts";

const SETT_LEGEND = "OGN-269";
const MISTFALL = "OGN-152";
const PIRATES_HAVEN = "OGN-143";
const GAMES = Number(process.env.GAMES ?? 100);
const STEP_CAP = 400;

const registry = defaultCardRegistry();
const ALL = registry.all();

/**
 * A legal 40-card list for `legendId`, biased toward cards whose text mentions a
 * buff so the converted `unitBuffed` event actually fires often.
 *
 * `forced` ids are seeded ahead of everything else, at 3 copies each — that is how
 * the Awaken scenario guarantees Pirate's Haven is in the deck rather than hoping
 * the tail happens to reach it. Left empty, this builds exactly the list it always
 * did, so the buff scenario's recorded numbers are unaffected.
 */
function buildBuffDeck(legendId: string, forced: readonly string[] = []): DeckList {
  const legend = registry.get(legendId);
  const domains = legend.domains;
  const champion = ALL.find((d) => d.type === "Unit" && d.isChampion && isEligibleChampion(d, legend.name, domains));
  if (!champion) throw new Error(`no eligible champion for ${legend.name}`);

  const legal = ALL.filter(
    (d) => d.type !== "Legend" && (d.domains ?? []).every((x) => domains.includes(x)),
  );
  const cardIds: string[] = [champion.id, champion.id, champion.id];
  for (const id of forced) {
    if (!legal.some((d) => d.id === id)) throw new Error(`${id} is not legal in a ${legend.name} deck`);
    for (let i = 0; i < 3; i += 1) cardIds.push(id);
  }
  const buffers = legal.filter((d) => /buff/i.test(d.text ?? ""));
  for (const def of [...buffers, ...legal]) {
    if (cardIds.length >= 40) break;
    if (def.id === champion.id) continue;
    const already = cardIds.filter((id) => id === def.id).length;
    for (let i = already; i < 3 && cardIds.length < 40; i += 1) cardIds.push(def.id);
  }
  return {
    name: `${legend.name} (probe)`,
    legendId,
    championId: champion.id,
    cardIds,
    runeDomainACount: 6,
    runeDomainBCount: 6,
    battlefieldNames: LEGACY_BATTLEFIELDS,
    sideboardCardIds: [],
  };
}

interface Counters {
  games: number;
  declaredGameOver: number;
  invalid: number;
  passFocusActions: number;
  maxChainDepth: number;
  heldStates: number;
  maxHeldAtOnce: number;
  /**
   * The largest number of trigger entries standing on the chain AT ONCE, and the
   * largest number from a single listener card.
   *
   * These are the batch measurement, and they are counted off the CHAIN for the
   * same reason `byListener` is. `maxHeldAtOnce` above samples `pendingTriggers`
   * after `submit`, and `runCleanup` drains the pen at the end of every submit —
   * so it is non-zero only when a decision was pending and the Cleanup was
   * skipped (323.2.b). It reported a flat `1` for an Awaken that really was
   * holding several triggers together, which is the third time this exact
   * pen-vs-chain confusion has produced a plausible wrong number here. Kept in
   * the payload rather than deleted, because "the pen coincided with a question
   * N times" is still a real thing to know — it just is not the batch size.
   */
  maxTriggersOnChain: number;
  maxPerListenerOnChain: number;
  triggerOnChainStates: number;
  byListener: Record<string, number>;
  strandedPen: number;
}

function playOut(label: string, list: DeckList, seedBase: number): Counters {
  const c: Counters = {
    games: GAMES,
    declaredGameOver: 0,
    invalid: 0,
    passFocusActions: 0,
    maxChainDepth: 0,
    heldStates: 0,
    maxHeldAtOnce: 0,
    maxTriggersOnChain: 0,
    maxPerListenerOnChain: 0,
    triggerOnChainStates: 0,
    byListener: {},
    strandedPen: 0,
  };
  /** Distinct trigger chain entries observed, so a trigger that sits on the chain
   *  through several passes counts once. Keyed by game + listener + depth. */
  const seenChainEntries = new Set<string>();

  for (let g = 0; g < GAMES; g += 1) {
    // Battlefields pinned so successive runs of this control are comparable.
    let state = startedGame(list, list, seedBase + g * 17, { battlefields: legacyBattlefields() });
    let over = false;

    for (let steps = 0; !over && steps < STEP_CAP; steps += 1) {
      if (legalActions(state).length === 0) break;
      const action = chooseAction(state);
      if (action.type === "PassFocus") c.passFocusActions += 1;
      const { state: next, result } = submit(state, action);
      if (result.type === "Invalid") {
        c.invalid += 1;
        console.log(`  INVALID ${label} g${g}: ${result.error}`);
        break;
      }

      if (next.pendingTriggers.length > 0) {
        c.heldStates += 1;
        c.maxHeldAtOnce = Math.max(c.maxHeldAtOnce, next.pendingTriggers.length);
      }
      c.maxChainDepth = Math.max(c.maxChainDepth, next.spellChain.length);
      if (next.spellChain.some((e) => e.kind === "trigger")) c.triggerOnChainStates += 1;

      // Which abilities actually REACH the chain, counted off the chain itself and
      // not off the pen.
      //
      // `byListener` used to be sampled from `next.pendingTriggers`, which was a
      // near-useless measure and quietly so: `runCleanup` drains the pen at the end
      // of every `submit`, so the pen is non-empty afterwards ONLY when a decision
      // was pending and the Cleanup was skipped (323.2.b). It was therefore
      // counting coincidences with a parked question rather than holdings, and it
      // reported a plausible per-card breakdown while doing it — when
      // `battlefieldConquered` was converted, Mistfall's count fell 6 → 0 and read
      // as a regression, when in fact Mistfall's holding was untouched and its
      // triggers had simply stopped overlapping with a decision.
      //
      // Counted per ENTRY-ID so one trigger sitting on the chain across several
      // passes is one observation, not one per step.
      const standing: Record<string, number> = {};
      for (const entry of next.spellChain) {
        if (entry.kind !== "trigger") continue;
        standing[entry.listenerDefId] = (standing[entry.listenerDefId] ?? 0) + 1;
        const id = `${g}:${entry.listenerInstanceId}:${entry.listenerDefId}:${next.spellChain.indexOf(entry)}`;
        if (seenChainEntries.has(id)) continue;
        seenChainEntries.add(id);
        c.byListener[entry.listenerName] = (c.byListener[entry.listenerName] ?? 0) + 1;
      }
      const onChain = Object.values(standing);
      if (onChain.length > 0) {
        c.maxTriggersOnChain = Math.max(c.maxTriggersOnChain, onChain.reduce((a, b) => a + b, 0));
        c.maxPerListenerOnChain = Math.max(c.maxPerListenerOnChain, ...onChain);
      }

      // Settled = chain open and nothing being asked. The pen MUST be empty there.
      if (next.chainOpen && next.pendingDecisions.length === 0 && next.pendingTriggers.length > 0) {
        c.strandedPen += 1;
        console.log(`  STRANDED PEN ${label} g${g}: [${next.pendingTriggers.map((t) => t.listenerName).join(", ")}]`);
      }

      state = next;
      if (result.type === "GameOver") over = true;
    }
    if (over) c.declaredGameOver += 1;
  }
  return c;
}

const buffList = buildBuffDeck(SETT_LEGEND);
console.log(`deck: ${buffList.name} — Mistfall present: ${buffList.cardIds.includes(MISTFALL)}`);
const buff = playOut("buff", buffList, 7000);

const awakenList = buildBuffDeck(SETT_LEGEND, [PIRATES_HAVEN]);
console.log(`deck: ${awakenList.name} + Pirate's Haven x${awakenList.cardIds.filter((id) => id === PIRATES_HAVEN).length}`);
const awaken = playOut("awaken", awakenList, 31000);

// The Awaken control's own claim, separate from the shared invariants: Pirate's
// Haven's per-unit readying really does reach the chain. Named explicitly rather
// than folded into `triggerOnChainStates`, because that counter is already
// non-zero from `unitBuffed` alone and would stay green with the Awaken firing
// nothing at all — the exact "a green gate proves nothing about a new feature"
// shape this file exists to avoid.
const havenName = registry.get(PIRATES_HAVEN).name;
const awakenTriggers = awaken.byListener[havenName] ?? 0;

const clean = (c: Counters) => c.invalid === 0 && c.strandedPen === 0 && c.declaredGameOver === c.games;

report(
  "chain-depth",
  {
    buff: {
      ...buff,
      positiveControls: { heldStates: buff.heldStates, maxHeldAtOnce: buff.maxHeldAtOnce, triggerOnChainStates: buff.triggerOnChainStates },
    },
    awaken: {
      ...awaken,
      positiveControls: { awakenTriggers, maxPerListenerOnChain: awaken.maxPerListenerOnChain },
    },
  },
  clean(buff) &&
    clean(awaken) &&
    buff.heldStates > 0 &&
    buff.triggerOnChainStates > 0 &&
    // The Awaken really fired, and really fired in BATCHES — one Pending Item per
    // exhausted unit is the whole shape being controlled for, and a maximum of 1
    // from a single listener would mean the batching had silently collapsed into
    // one event per turn.
    awakenTriggers > 0 &&
    awaken.maxPerListenerOnChain > 1,
);
