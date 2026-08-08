# Engine probes

Self-play measurements that the unit tests structurally cannot make: does a game
always *end*, does a converted trigger actually reach the chain, does a rules fix
change the outcome in real games rather than only in a fixture.

## Running

```sh
npm run build --workspace=@rift-engine/engine   # they import the built dist
node packages/engine/probes/ai-health.ts
```

Node runs the `.ts` files directly (native type stripping, Node 22.18+/24). There
is no build step for the probes themselves — but `npm run typecheck` covers them,
which is the entire reason they are TypeScript.

`npm run probes --workspace=@rift-engine/engine` runs the two termination gates.

| probe | asserts | gate |
|---|---|---|
| `ai-health.ts` | self-play terminates | 40/40 gameOver, 0 invalid, **and** turnNumber advances |
| `passive-human.ts` | a game where the human only passes still ends | 16/16, 0 stalled |
| `chain-depth.ts` | triggers are held, reach the chain, and strand nothing | held > 0, onChain > 0, strandedPen === 0 |
| `walkout.ts` | a Combat Showdown one side leaves still awards the battlefield | walkouts > 0 **and** every one awards control |
| `exercised.ts` | which cards have ever actually *run*, as opposed to being registered, for ONE deck set | instrument health only — all three signals fired, nothing unresolved, something still unexercised |
| `reachability.ts` | the same question over the WHOLE pool: presets plus one covering run per set, unioned | every run healthy with `invalid: 0`, the union beats every single run, and it has not fallen below the pinned 429 |
| `why-not-offered.ts` | why one named card was never offered — affordability, timing, or a real gap | `CARDS=` reached a hand in at least one game (the `tried > 0` rule) |

All take `GAMES=<n>`. `reachability` defaults to **250** and takes ~60s; the rest
default to 40.

### `reachability.ts` is the one in the loop

`exercised.ts` measures one deck set per invocation, and the loop only ever ran
two of its four modes — so the pool-wide number had no answer anybody could read,
and the answer it *did* give was misleading in a specific direction: all seven
preset decks are OGN/OGS, so the default run reports **SFD 0%** and always will.
198 cards shipped in a month had never been in a game unless somebody typed
`DECKS=sfd`.

Union across all four modes: **429 of 468 cards needing code**, leaving 39 that no
automated run has ever seen act. Every one is NAMED and split five ways, because
those take completely different work and lumping them together manufactures a
backlog of broken cards that are not broken.

**Sample depth is load-bearing — read the buckets only from the default run.**

| games/mode | exercised | never | `drawnNeverOffered` | wall clock |
|---|---|---|---|---|
| 40 | 367 | 101 | 8 | 10s |
| 100 | 417 | 51 | 4 | 25s |
| **250** (default) | **429** | **39** | **1** | **60s** |
| 500 | 435 | 33 | 0 | 120s |

At 40 games the list is dominated by sampling: **7 of its 8 "the engine never
offered this" leads were offered freely at depth** — Punch First 59 times, Blood
Money 71. That is the OGS-011 Flash lesson one level up, and it is why the pin
and the allowlist are asserted only at 250.

What survives at 500 is 28 cards the engine offers and the 1-ply AI declines
(Sabotage, Stacked Deck, Party Favors — the `ai-ab-harness` category) plus 5
Legends that are observer blind spots. **Zero enumeration defects.**

The modes are derived from the registry, not listed. A hardcoded
`["OGN","OGS","SFD"]` would be correct today and silently wrong the day
`unl.json` lands, which is this exact failure one set earlier.

`probes/unexercised-allowlist.ts` is where a card earns an excuse instead of a
fix — a structural AI limitation or a documented observer blind spot, and nothing
else. A card listed there that turns up exercised **fails the gate by name**,
because an excuse nobody re-reads is the failure mode this repo has recorded
against `PARTIALLY_IMPLEMENTED`, the Divergent table, and the verification loop
itself.

### `exercised.ts` is a report, not a threshold

`coverage.ts` answers "is this card implemented"; this answers "has it ever run".
They are different questions and only the first had an answer, so "270/270
implemented" sat beside an unknown number of cards no automated run had played.

Read its three numbers together. `exercised / inDecks` measures the engine and the
AI; `inDecks / inPool` measures the **decks**, and that is the one that is low — at
`9105527` the seven preset decks contain 105 of 288 definitions, so **189 of the 270
cards needing code cannot be reached by any probe at all.** A low `exercised` almost
always means a deck problem, and reporting it without `inDecks` beside it would
invite the same misreading `make-buffdeck.mjs` once invited.

Deliberately **not** gated on a coverage percentage — any threshold would be a
number picked to pass. The gate is that the instrument still works.

It reports three *reasons* a card went unexercised, and they are not
interchangeable:

| bucket | meaning | is it a defect? |
|---|---|---|
| `inDeckButNeverOffered` | `legalActions` never enumerated it | maybe — but check it was ever DRAWN first; `reachability` now measures that for you |
| `offeredButNeverTaken` | offered, and the AI declined every time | **no.** `abilityBanksResource` drops resource abilities on purpose, and a 1-ply evaluator cannot price a deferred effect |
| `inDeckButNeverExercised` | the union of both | — |

The middle column is why the split exists. Six `Seal of X`, Kai'Sa and Darius are
offered thousands of times and never taken, by design; Cleave was offered 265 times
and taken once. Reporting those beside genuinely unreachable cards manufactures a
backlog of broken cards that are not broken.

**A game draws about 10 of 39 cards.** Games last 5–8 turns, so one copy of a card
very likely never appears. And the pairing scheme gives each deck only ~5 distinct
shuffles across 40 games. OGS-011 Flash sat in a deck for 10 games, was never drawn
once, and read convincingly as an enumeration bug. Check a card was drawn before
calling it a defect.

## Why these are TypeScript

They used to be untyped `.mjs` in a session-local scratchpad, importing the engine
from a hardcoded `file:///A:/...` path. Both properties cost real time:

- **They drifted silently.** A probe that hand-builds `GameState` as an object
  literal keeps working forever as the real type grows. `ai-health` omitted
  `firstPlayerIndex`, so `turnNumber` never incremented and it reported
  `turns: {min:1, median:1, max:1}` for weeks — beside numbers that were real. That
  also meant `[Hidden]` was never exercised in *any* self-play run.
- **They only ran on one machine**, pinned to a drive letter.

Now there is exactly **one** `GameState` literal, in `harness.ts`, typed. Add a
required field to `GameState` and typecheck fails, naming that file.

## Rules for changing them

- **A green gate proves nothing about a new feature.** ai-health and
  passive-human stay green whether your change works or never fires. Anything
  behavioural needs its own positive control that counts the new path being taken —
  that is what `chain-depth` and `walkout` are.
- **Gate on `tried > 0`.** A check that never ran reports `0/0`, which reads as a
  pass.
- **Prove a fix by making the probe fail.** `git stash` the fix, rebuild, re-run.
  `walkout` reports `0` points awarded against the pre-fix engine and `95` after,
  over the same 200 games.
- **Count from the state stream, never from inside the engine.** A probe that wraps
  a trigger's `resolve` also counts the heuristic AI's *lookahead*, which applies
  every candidate action through the real executors to score it. One card was once
  reported "played 259 times" when the true answer was zero.
- **Pin the battlefields** (`legacyBattlefields()`) whenever a probe's numbers are
  quoted anywhere. Rolling them per match makes successive runs incomparable —
  `walkout` reported 236 walkouts instead of the recorded 154 purely from that.
