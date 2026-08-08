/**
 * **What is actually ON the chain when `settleDeferredResolution` gives up?**
 *
 *     node packages/engine/probes/stuck-chain.ts
 *
 * Written for one incident and kept because the shape recurs: the AI's settle
 * loop throws "did not settle in 64 iterations" naming a COUNT and nothing else,
 * and a count cannot tell you which card is looping. This replays the same runs
 * and, on the throw, prints the chain entries by defId and name.
 *
 * The standing lesson it serves: **a crash in a probe may not be the card you
 * just wrote.** This one surfaced while un-breaking six cards that had been
 * dying to a mis-parsed `[Temporary]`, and the card whose survival exposed it
 * has no implementation and no triggers at all — so it cannot be the author.
 */
import { defaultCardRegistry } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { runExercise } from "./exercise-run.ts";

const GAMES = Number(process.env.GAMES ?? 60);
const MODE = process.env.MODE ?? "UNL";

const registry = defaultCardRegistry();
const nameOf = (defId: string): string => registry.tryGet(defId)?.name ?? "(not a card)";

/** One chain entry, flattened to strings. A named type because the array below
 *  is written inside a callback and read in a `catch`, and an inline literal
 *  plus `| null` narrows to `never` at the read — TypeScript cannot see that the
 *  callback ran. */
interface ChainSnapshotEntry {
  defId: string;
  name: string;
  kind: string;
  source: string;
}

/** Empty rather than `null`, for the same narrowing reason. */
let stuck: ChainSnapshotEntry[] = [];
let statesSeen = 0;
let deepest = 0;

try {
  runExercise(MODE, GAMES, registry, (state) => {
    statesSeen += 1;
    if (state.spellChain.length > deepest) deepest = state.spellChain.length;
    // Snapshot every state's chain; the last one before the throw is the one
    // that failed to settle. Cheap enough — it is ids, not objects.
    if (state.spellChain.length > 0) {
      stuck = state.spellChain.map((e) => ({
        defId: "listenerDefId" in e ? (e.listenerDefId ?? "?") : (e.card?.defId ?? "?"),
        name: "listenerName" in e && e.listenerName ? e.listenerName : "",
        kind: e.kind ?? "spell",
        source: "source" in e ? (e.source ?? "event") : "-",
      }));
    }
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  report(
    "stuck-chain",
    {
      mode: MODE,
      games: GAMES,
      statesObserved: statesSeen,
      deepestChain: deepest,
      threw: message,
      /** The last non-empty chain seen before the throw. */
      chainAtFailure: stuck.map((e) => `${e.defId} ${e.name || nameOf(e.defId)} [${e.kind}/${e.source}]`),
    },
    false,
  );
}

report("stuck-chain", { mode: MODE, games: GAMES, statesObserved: statesSeen, deepestChain: deepest, threw: null }, true);
