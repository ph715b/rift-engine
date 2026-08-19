# Improving the heuristic AI

Scope: `packages/engine/src/ai/heuristic-ai.ts`. Read `CLAUDE.md` for the
verification loop and the pinned probe figures — this document does not restate
either, on purpose.

## The finding this plan rests on

`settleDeferredResolution` drives `chain + pendingDecisions + Showdown` to zero
and returns. **The AI's horizon is therefore exactly one action plus its forced
resolution — it never sees the rest of its own turn.**

Every blind spot currently attributed to the evaluator is downstream of that:

| symptom | where it is written down | actually |
|---|---|---|
| card advantage unpriceable — "would need to value the BOARD a drawn card becomes, which `evaluate` cannot see" | `cardInHand` doc comment | the drawn card's board is one action past the horizon |
| `FloatRune`, `HideCard` and resource-banking `ActivateAbility` excluded — "cannot value something stored for a future play this lookahead never sees" | `candidateActions` | same horizon; three classes of legal play removed from the action space |
| gear ~50% at every weight tried | `permanentInPlay` / `abilityValue` | a gear's value is its activation, later |
| no mulligan | `chooseAction` comment | same |

So the standing rule ("no speculative heuristic without a real evaluative
basis") has been applied correctly and has quietly become a capability cap: the
AI cannot express three strategies, and no weight or learned model can price an
action that is filtered out before scoring.

**The obvious objection does not apply.** `twoPly` measured 46.6% and was kept
off — but that is the *opponent's* ply. Own-turn depth is a different axis and
has never been measured here.

## Order, and why this order

Each phase makes the next one measurable. Do not reorder.

### Phase 0 — get the instrument back

`scratchpad/ai-ab.mjs` does not exist. Every number in the `EvalWeights` and
`BASELINE_WEIGHTS` doc comments is currently unreproducible, and this is the
**second** time the harness has been lost (the memory note says "Rebuilt
2026-08-01").

Rebuild it as `packages/engine/probes/ai-ab.ts`, not in a scratchpad. Typed,
built on `probes/harness.ts`, covered by `tsconfig.typecheck.json` — the reasons
are written out at the top of `harness.ts` and they are the same reasons.

Requirements, each of which is a trap that has already fired:

- **Seat swap on the same seed.** Candidate and baseline swap seats so seat and
  first-player advantage cancel by construction.
- **A calibration mode.** Baseline vs baseline must read exactly 50.0%. Run it
  first, every time. A harness that cannot produce 50.0% against itself is
  measuring something other than the change.
- **`key=value` args, not JSON.** PowerShell strips the inner quotes out of
  `'{"cardInHand":2}'`.
- **Reject an unknown weight name** rather than silently ignoring it.
- **Print the deck basis in the result line.** The single biggest lesson from
  the last round: `cardInHand: 0.5` shipped on a 52.2% measured across the seven
  preset decks, which contained no card whose value was drawing. The number
  stayed true and stopped being about anything. A result that does not say which
  decks it ran on is not a result.

Gate: calibration reads 50.0%, and one already-settled result reproduces
(`cardInHand: 2` should lose heavily on the presets).

### Phase 1 — extend the horizon to end of own turn

The main event. After the settle, let the acting player keep taking its own best
actions (opponent assumed to pass) until it would end the turn, then evaluate
that terminal state. Return only the first action; re-enumerate at the next real
decision.

**One playout, not a tree.** Cost is linear in actions-remaining-this-turn, the
same order as `twoPly`'s ~5x, which was affordable. It is not minimax and must
not become minimax.

- Ship it as a **flag on `EvalWeights`**, exactly as `twoPly` and `abilityValue`
  are. That is what lets the same harness A/B it, and it keeps the result and
  its cost recorded next to the switch whichever way the measurement lands.
- **Use the same policy for the rollout as for the real decision.** A second,
  cheaper rollout policy compounds evaluator error and makes the result
  uninterpretable.
- Reuse the depth guard shape: the rollout must not re-enter itself.
- Beam or cap the rollout if runtime demands it, and `log` the cap — a silent
  truncation reads as full lookahead.

Measure on **both** bases (presets and generated/covering decks), state both.

### Phase 2 — un-filter the action space

Only now, because these become priceable only once a later spend is inside the
window. One at a time, each separately measured, each with its own line in the
`candidateActions` comment:

1. resource-banking `ActivateAbility`
2. `FloatRune`
3. `HideCard`
4. mulligan

Expect some of these to be neutral in win rate and worth keeping anyway, on the
`permanentInPlay` precedent — they make those actions reachable in the self-play
probes for the first time, and they square the AI with the project's standing
"never withhold a legal play" ruling. Say which reason each one is kept for.

### Phase 3 — fit the evaluator from wins

Only after 1 and 2, so the fit runs on states the AI can actually reach.

1. Widen the feature vector with things computable from the **masked** state —
   per-battlefield contest/control, distance-to-win (points is a threshold, not
   linear at x1000), available Energy and runes, deck size (Burn Out proximity),
   unit count separate from Might sum.
   **Features must be computed downstream of `maskHiddenCards`**, or the model
   trains on information the AI cannot legally have at play time.
2. Log `(features, eventual winner)` per state across a few thousand self-play
   games. Fit a logistic regression to P(win). Keep it **linear** — `evaluate`
   stays readable and an action's score stays explainable.
3. Freeze the coefficients into a checked-in constant. **Nothing may carry state
   between games**: every probe depends on `chooseAction` being a pure function
   of `(state, weights)`, and `walkout` is pinned deterministic.
4. **Iterate 2-3 rounds** — refit, regenerate self-play with the new weights,
   refit again. Round one plateaus; the iteration is where the gain is.

### Phase 4 — make it a process, not an event

Refit per set. Hand-tuned weights have already gone stale once in exactly the
way that is now predictable: the pool grows past the basis that settled them.
A refit self-corrects for that; hand-tuning silently does not.

## Cheap experiment, any time

Ties go to `Pass`, because `legalActions` pushes it first and `bestActionFor`
compares with a strict `>`. That is an unmeasured policy choice affecting a
large fraction of decisions. An "act on ties" variant is a ten-minute A/B once
Phase 0 exists.

## What will break, and what to do about it

- **`walkout`'s 190 / 113 / 29 will move in Phase 1, and that is correct.**
  Decompose it by CONTROL, not by argument — and `npm run build` before the
  control run. A control that agrees with the unmutated run to four figures is
  exactly what a control measuring the previous `dist` looks like; that has
  already happened once.
- **`reachability` runtime multiplies.** It is already 292-496s on the same
  machine. `MAX_GROUPED_MOVERS` is the dial. The per-set figures (OGN 228,
  OGS 21, SFD 188, UNL 205) should NOT move; if one does, read
  `neverExercised` by name rather than the total.
- **Phases 2 and 3 should RAISE `reachability`** by making previously
  unreachable cards reachable. Bump the pin and say which cards moved.
- **Root `npm test` first, always.** An engine change that breaks a web test is
  invisible to the typecheck, the build and every probe.

## Skills worth writing

- **`tune-the-ai`** — how to measure an AI change here defensibly. Calibration
  first, the basis rule, `key=value` not JSON, a tuning run is also a liveness
  probe (the last one found a 538-turn livelock and the missing Burn Out), and
  re-measure after fixing anything the run uncovers. Best written by the session
  that finishes Phase 0, from real usage.
- **`move-a-pinned-figure`** — decompose by control; rebuild before the control;
  stash, re-run against the old sha, diff the BUCKETS not the total; one or two
  is noise on `reachability` and nothing is noise on `walkout`. Useful well
  beyond this plan — this procedure is currently prose in `CLAUDE.md` and has
  been got wrong repeatedly.
