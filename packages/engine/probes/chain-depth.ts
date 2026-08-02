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
 * Uses a purpose-built Sett buff deck rather than the presets: `unitBuffed` is the
 * converted event and this deck places ~2700 buffs per 300 games, so the sample is
 * real rather than incidental.
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
const GAMES = Number(process.env.GAMES ?? 100);
const STEP_CAP = 400;

const registry = defaultCardRegistry();
const ALL = registry.all();

/** A legal 40-card list for `legendId`, biased toward cards whose text mentions a
 *  buff so the converted `unitBuffed` event actually fires often. */
function buildBuffDeck(legendId: string): DeckList {
  const legend = registry.get(legendId);
  const domains = legend.domains;
  const champion = ALL.find((d) => d.type === "Unit" && d.isChampion && isEligibleChampion(d, legend.name, domains));
  if (!champion) throw new Error(`no eligible champion for ${legend.name}`);

  const legal = ALL.filter(
    (d) => d.type !== "Legend" && (d.domains ?? []).every((x) => domains.includes(x)),
  );
  const cardIds: string[] = [champion.id, champion.id, champion.id];
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

const list = buildBuffDeck(SETT_LEGEND);
console.log(`deck: ${list.name} — Mistfall present: ${list.cardIds.includes(MISTFALL)}`);

let heldStates = 0;
let maxHeldAtOnce = 0;
let triggerOnChainStates = 0;
let maxChain = 0;
let passFocusActions = 0;
let strandedPen = 0;
let finished = 0;
let invalid = 0;
/** Distinct trigger chain entries observed, so a trigger that sits on the chain
 *  through several passes counts once. Keyed by game + listener + depth. */
const byListener: Record<string, number> = {};
const seenChainEntries = new Set<string>();

for (let g = 0; g < GAMES; g += 1) {
  // Battlefields pinned so successive runs of this control are comparable.
  let state = startedGame(list, list, 7000 + g * 17, { battlefields: legacyBattlefields() });
  let over = false;

  for (let steps = 0; !over && steps < STEP_CAP; steps += 1) {
    if (legalActions(state).length === 0) break;
    const action = chooseAction(state);
    if (action.type === "PassFocus") passFocusActions += 1;
    const { state: next, result } = submit(state, action);
    if (result.type === "Invalid") {
      invalid += 1;
      console.log(`  INVALID g${g}: ${result.error}`);
      break;
    }

    if (next.pendingTriggers.length > 0) {
      heldStates += 1;
      maxHeldAtOnce = Math.max(maxHeldAtOnce, next.pendingTriggers.length);
    }
    maxChain = Math.max(maxChain, next.spellChain.length);
    if (next.spellChain.some((e) => e.kind === "trigger")) triggerOnChainStates += 1;

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
    for (const entry of next.spellChain) {
      if (entry.kind !== "trigger") continue;
      const id = `${g}:${entry.listenerInstanceId}:${entry.listenerDefId}:${next.spellChain.indexOf(entry)}`;
      if (seenChainEntries.has(id)) continue;
      seenChainEntries.add(id);
      byListener[entry.listenerName] = (byListener[entry.listenerName] ?? 0) + 1;
    }

    // Settled = chain open and nothing being asked. The pen MUST be empty there.
    if (next.chainOpen && next.pendingDecisions.length === 0 && next.pendingTriggers.length > 0) {
      strandedPen += 1;
      console.log(`  STRANDED PEN g${g}: [${next.pendingTriggers.map((t) => t.listenerName).join(", ")}]`);
    }

    state = next;
    if (result.type === "GameOver") over = true;
  }
  if (over) finished += 1;
}

report(
  "chain-depth",
  {
    games: GAMES,
    declaredGameOver: finished,
    invalid,
    passFocusActions,
    maxChainDepth: maxChain,
    positiveControls: { heldStates, maxHeldAtOnce, triggerOnChainStates, byListener },
    invariant: { strandedPen },
  },
  invalid === 0 && strandedPen === 0 && finished === GAMES && heldStates > 0 && triggerOnChainStates > 0,
);
