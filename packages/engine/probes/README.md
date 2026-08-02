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

All take `GAMES=<n>`.

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
