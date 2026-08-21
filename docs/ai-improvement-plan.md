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

## Measured correction, 2026-08-19 — the claim above is right and incomplete

Re-read against the source and then measured, because this plan was written from
a read and this repo's notes about its own mechanisms have been wrong ten times
out of eleven. Two findings, one confirming and one not.

**Confirmed, structurally.** `settleDeferredResolution`'s loop body has exactly
four branches — answer a pending decision, an opponent reply when `twoPly`,
`PassFocus` on a closed chain, `PassFocus` in a Showdown — and none of them takes
a discretionary action for the acting player. It cannot cross a turn boundary
either: `runEnd` is called from exactly one place in the whole engine,
`game-engine.ts:145`, `submit`'s `Pass`.

**And that is the hole.** `applyBare` has `case "Pass": return state;` — a
no-op — while the real `submit` runs `runStartOfTurn(runEnd(state))`: end the
turn, rotate, the opponent's Awaken, their `killTemporaryPermanents`, their
**hold scoring**, their draw. The single largest transition in the game, priced
at zero. So the horizon does not merely end at the settle; for the one action
that ends the turn there is no lookahead at all.

Measured over 30 preset self-play games:

| | |
|---|---|
| Passes chosen | 385 |
| …with a discretionary action legal | **385** (median 8 available) |
| …after which the OPPONENT scored | **136** |
| points handed over, scored as 0 | **155** |
| own Might shed to expiring this-turn state | 233 |
| discretionary actions per turn | median **2**, mean 2.53, max 11 |

**What this does to Phase 1 as written.** "Evaluate that terminal state" means
the state just *before* ending the turn — which is what is already being
evaluated. So Phase 1 does not close this and makes it worse in one direction:
extending the horizon to the end of own turn rewards accumulating this-turn Might
and Temporary permanents, which `runEnd` deletes one step later. The rollout's
terminal evaluation has to be `runStartOfTurn(runEnd(...))`.

**Fixing it alone was measured, and it does not pay.** Shipped as
`EvalWeights.passEndsTurn`, off, on the `twoPly` precedent:

| basis | games | win rate |
|---|---|---|
| presets | 400 | **49.25% ±4.9** |
| VEN covering | 240 | **47.92% ±6.3** |

Neutral to slightly negative on both. The behavioural half is where the answer
is: it barely moves how OFTEN the AI passes (2583 against 2579 — that count is
~one per turn and structural, not a preference) and moves heavily what it does
BEFORE passing. `RecallUnit` **454 against 7** on the presets and 222 against 2
on VEN, `ActivateAbility` **761 against 348** on VEN, `MoveUnit` +23%.

**The leading explanation, which Phase 1 will confirm or kill: it corrects one
side of the comparison.** Pass now carries the full turn-end cost while every
alternative still hides it, so the AI prefers doing something — anything — over
ending the turn. A 65x rise in Recalls is what a bias looks like, not what
recognition looks like, and shipping it would raise `reachability` for the wrong
reason. That is worse here than leaving the blind spot.

So the correction belongs inside a lookahead that applies the turn end to EVERY
candidate. Which is Phase 1 — and this measurement is the argument for its
terminal state being `runStartOfTurn(runEnd(...))` rather than the state before
it, now with a number behind it rather than a prediction.

**What Phase 1 will not fix, either.** Four of the five gear in the preset pool
are TRIGGERED — on your Beginning Phase, on a buff, when combat begins, on the
gear's own fate. Every one of those events is on a later turn or the opponent's,
so an end-of-own-turn rollout reaches none of them. The gear row in the table
above is not downstream of this horizon.

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

**DONE, 2026-08-19.** `packages/engine/probes/ai-ab.ts`, in
`tsconfig.probes.json`. Both gates met on presets at `--games=200` (400 games):
calibration **50%, 400/400 decided, 0 hitCap, 0 errors**; `cardInHand=2`
**38.5% ±4.8**, playing 3679 cards against the baseline's 4391 — the hoarding
mechanism visible directly rather than argued. `--decks=<set>` runs the covering
decks through `exercise-run.decksFor`, so the basis line reads e.g. `ven (17
decks, 6 pairings, 144 cards covered, 0 orphans)`.

One requirement was added that the list above does not have, and it is the one
that matters: **a second calibration control on the action mix.** Mutation-tested
by feeding game B `seed + 1` so the pair is no longer a mirror — the win rate
control `calibrationExact` stayed **true** (the two different games split 8/8)
and only byte-identical `candidateActions`/`baselineActions` caught it. Gate on
`mixesIdentical`. A 50/50 survives a broken swap; identical action counts do not.

See the `tune-the-ai` skill for the run procedure and the reference figures.

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

**DONE, 2026-08-19 — `EvalWeights.ownTurnRollout`, and it wins big.**

| basis | games | unbeamed | with `ROLLOUT_BEAM` (ships) |
|---|---|---|---|
| presets | 400 | 71.00% ±4.4 | **69.50% ±4.5** |
| VEN covering | 240 | 59.17% ±6.2 | **58.75% ±6.2** |
| presets, three 25-pair seed sets | 150 | 78% / 62% / 60% | — |
| reverse control (baseline ON, candidate OFF) | 50 | **22%** — 11/39, exact mirror | — |

Largest gain this harness has ever measured; the previous best was ~54%. The
behavioural half passes the recognition-versus-bias test `passEndsTurn` failed:
`ActivateAbility` 848 against 385 on VEN, `MoveUnit` +24%, and `RecallUnit`
unchanged at 1 against 2 rather than blowing up to 454.

**The first version of it measured 0.25% — one win in four hundred — and the bug
is worth knowing, because nothing else could see it.** `Pass` is one of the
candidates. Roll it out like any other and it scores "play my whole turn out,
then end it", which is exactly what the best real action scores, because the
rollout would then play that action anyway. Everything tied with Pass, ties go to
Pass, and the AI ended its turns having done nothing while the lookahead believed
it had played them — `MoveUnit` fell to 107 against 1280. No exception, no
invalid action, no stall, and `ai-health` stayed 40/40, because passing terminates
games perfectly well. Only the win rate and the action mix showed it. Pinned now
in `test/ai-own-turn-rollout.test.ts`, mutation-tested.

So Pass under this flag means "end the turn NOW, having done nothing else", and
every candidate's terminal state is post-`runEnd`. That is the correction
`passEndsTurn` could not make on its own, and it is the whole difference between
0.25% and 71%.

**Two policies, and that is the decision taken.** `BASELINE_WEIGHTS` keeps the
rollout off — it costs **~11.8x** (`ai-health` 4.4s → 51.7s) against the ~5x this
phase was scoped for, and `reachability` at 292-496s would land near an hour.
`HUMAN_OPPONENT_WEIGHTS` turns it on, and that is what `GameBoard.tsx` passes, so
a person plays the good policy and the instruments keep the cheap one.

**CLAUDE.md's pinned figures therefore describe `BASELINE_WEIGHTS`, not the
shipped opponent.** A real cost, accepted because the bias runs the safe way: the
rollout plays MORE cards, moves and abilities, so a probe on the cheap policy
UNDERSTATES what a real game reaches, and `reachability` is a floor. It would not
be acceptable the other way round. The two constants differ by exactly one flag
and a test pins that they do, so a future weight tuning cannot quietly become a
second tuning nobody measures.

**The UI tail is why `ROLLOUT_BEAM` exists.** `chooseAction` runs synchronously
on the browser's UI thread, so its worst case is a frozen tab, not a slow
spinner. Measured over 1271 real decisions: 4 decisions (0.3%), every one with
41-80 candidates, took 22.4% of all time, worst **954 ms**. Beaming the rollout
to the top 8 candidates by 1-ply score takes the worst case to **153 ms** with
nothing over 250 ms, halves total cost, and costs 1.5pp / 0.4pp of win rate —
inside the intervals. A beam and NOT a time budget: anything consulting a clock
would make play depend on machine load and destroy every pinned figure here.

One thing to know before Phase 2 or 3 touches this: ending the turn runs
`runDraw` for the OPPONENT, so the rollout advances their hand inside the
lookahead. `maskHiddenCards` masks facedown cards at battlefields and nothing
else, so this AI has always read the opponent's hand — pre-existing, not new. It
is inert only because `twoPly` is off (the modelled opponent never acts) and
`cardInHand` is 0 (which card arrives cannot move the score). Both of those are
things Phase 2 and Phase 3 remove.

### Phase 2 — un-filter the action space

Only now, because these become priceable only once a later spend is inside the
window. One at a time, each separately measured, each with its own line in the
`candidateActions` comment:

1. resource-banking `ActivateAbility`
2. `FloatRune`
3. `HideCard`
4. mulligan

**DONE for 1-3, 2026-08-19. One kept, two refused, and each for a different
reason.** All measured with `--baseline=ownTurnRollout=true`, because these are
only priceable once a later spend is in the window — the harness grew a
`--baseline` option for exactly this, so the un-filter is one variable rather
than two runs compared by eye.

| flag | win rate | verdict |
|---|---|---|
| `bankAbilities` | **exactly 50.0%** (100/100 with rollout; 200/200 without) | **ON**, on reachability |
| `floatRunes` | **0%** | off — catastrophic |
| `hideCards` | 48% ±6.9 on 46 uses / 200 games | off — unmeasurable |

**The Phase 2 thesis is confirmed, but in the UPTAKE rather than the win rate.**
`bankAbilities` without the rollout takes 38 extra activations per 400 games;
with it, 202 per 200 games — about 10x. A stored resource does become priceable
once a later spend is inside the window.

**What earns `bankAbilities` its place is coverage, read by name.**
`reachability` 798 → 800, UNL 205 → 207, nothing lost, `walkout` unmoved at
190/113/29 — and both new cards are **UNL-234 Diana - Scorn of the Moon**
(Overnumbered and Signature). She is a LEGEND, never drawn and never offered,
whose only ability is `[Exhaust]: [Add] 1 Energy, spend only during showdowns`.
Pure banking on a card that cannot be played, so this flag is the only mechanism
in the engine that could ever exercise her. Also squares the AI with the standing
fidelity ruling: never withhold a legal play.

**`floatRunes` fails in a way worth knowing before anything else is un-filtered.**
0% over 20 games, floating 415 times while playing 70 cards against the
baseline's 161. It is NOT that the evaluator cannot price it — with the rollout
it can, and that is the thesis working. It is that **`chooseAction` returns only
the first action of a plan, and this plan's first step is repeatable**: floating
is always the first move of a better line, so the AI takes it, re-plans, and
floating is still the first move of an even better line. The payoff stays one
step away forever. Not the enumeration tie-break either — `legalActions` pushes
Pass before `floatRuneCandidates`, so floating is scoring strictly higher. Fixing
it needs the AI to COMMIT to a rollout's plan instead of re-deriving it every
action, which is a different policy, not a flag.

**`hideCards` was not refused, it was unmeasurable.** 46 Hides in 200 games on
SFD; 1 in 20 games on the presets, where the first attempt was very nearly
vacuous. `hideCardCandidates` needs a `[Hidden]` card in hand AND a battlefield
you already control with room under 811's limit, simultaneously. That is a
reachability problem, not a horizon one, and no further A/B run resolves it.

**Item 4, mulligan, is NOT done** — it is not a `candidateActions` filter at all;
the AI never mulligans because nothing calls a chooser at that point. Different
entry point, different piece of work.

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
