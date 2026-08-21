---
name: tune-the-ai
description: Measure a change to the heuristic AI defensibly with probes/ai-ab.ts — calibration first, the basis rule, and the traps that have made a plausible number mean nothing. Use when changing EvalWeights, the evaluator, the lookahead horizon or the candidate action space, when quoting an AI win rate, or when a note cites a figure from a harness that no longer exists.
---

# Tuning the heuristic AI

The instrument is `packages/engine/probes/ai-ab.ts`. Everything below is a trap
that has already fired here.

```bash
npm run build --workspace=@rift-engine/engine   # ALWAYS — the probes load dist
node packages/engine/probes/ai-ab.ts                          # calibration
node packages/engine/probes/ai-ab.ts cardInHand=2 --games=200
node packages/engine/probes/ai-ab.ts twoPly=true --games=200 --decks=ven
```

Bare `key=value` are weights, `--key=value` are run options
(`--games` = PAIRS, so `--games=200` plays 400 games; `--decks`, `--seed`).

## Calibration first, every time

Baseline vs baseline is the DEFAULT mode and it must read **exactly 50.0%**, not
"within noise". The two halves of a pair are the same game with the labels
swapped, so anything else means the seat swap is not cancelling what it claims.

Reference figures on this build, presets, `--games=200`: **50%, 400/400 decided,
0 hitCap, 0 errors, `mixesIdentical: true`**. Runtime ~4 min.

**Gate on `mixesIdentical`, not on the win rate.** Both controls exist and only
one of them works. Mutation-tested by feeding game B `seed + 1` so the pair is
no longer a mirror: `calibrationExact` stayed **true** — the two different games
happened to split 8/8 — and only the byte-identical action mix caught it. A
50/50 survives a broken swap easily; identical action counts cannot.

Re-run calibration after any engine change that lands between two candidate
runs. A candidate number measured across an engine change is two measurements.

## The basis matters more than the number

`cardInHand: 0.5` shipped on a 52.2% measured across the seven preset decks. The
presets were taken to zero inert cards early, so every card added since lives
outside them — by the time eight pure-draw cards existed, the basis that settled
the weight contained none of them. The number stayed true and stopped being about
anything. Re-measured on decks built to hold cantrips, `cardInHand: 0` won.

So:

- The harness **prints the basis in the result line** (`presets (7 decks, 49
  pairings)`, or `ven (17 decks, 6 pairings, 144 cards covered, 0 orphans)`).
  Quote it with the number, always. A result that does not say which decks it ran
  on is not a result.
- `--decks=<set>` runs the generated covering decks, through the same `decksFor`
  `reachability` uses. Measure a candidate on **both** bases and state both; they
  disagree, and that disagreement is the finding.
- Presets are 7 decks → 49 ordered pairings, so `--games` below ~49 does not even
  see the whole basis. VEN is 17 decks → 289.

## Read the behaviour, not only the win rate

The result prints `candidateActions` / `baselineActions` per POLICY. Twice now
this half has been the decisive one, and it is the half that says *why*:

- `cardInHand=2` on presets measures **38.5% ±4.8** — and plays 3679 cards
  against the baseline's 4391. Hoarding, visible directly, no argument needed.
- `permanentInPlay` is neutral in win rate at every weight tried and was kept
  anyway, because it takes gear plays from zero to ~22 per 40 games. An AI that
  never plays a third of its deck makes those cards unreachable in the self-play
  probes this project verifies with.

**Say which reason a change is kept for** — win rate, or reachability.

**And a behavioural swing is not automatically a reachability win.** `passEndsTurn`
measured 49.25% ±4.9 on presets and 47.92% ±6.3 on VEN — neutral, twice — while
taking `RecallUnit` from 7 to 454 and `ActivateAbility` from 348 to 761. On the
`permanentInPlay` precedent that reads like a keep. It is not: those extra
actions come from a **bias**, not recognition. The flag corrects the cost of Pass
without correcting the same cost hidden inside every alternative, so the AI
prefers doing anything over ending the turn. Shipping it would have raised
`reachability` for the wrong reason.

The test that separates the two: ask *why* the action got more attractive. If the
answer is "the evaluator can now see what the action does" it is recognition; if
it is "the alternative got worse", it is bias. A 65x swing in one action type is
a strong hint of the second.

## Measuring "given X, does Y help"

`--baseline=ownTurnRollout=true` moves the BASELINE side, so the candidate is
built on it and the run isolates one variable. Without it you are comparing two
independent runs against a common third policy by eye. Calibration still applies:
`--baseline=X X` names both sides and must still read exactly 50.0%.

Use it whenever a change is only meaningful given another — every Phase 2
un-filter was in that shape, since stored value is unpriceable until a later
spend is inside the window.

## Smoke each flag for REACHABILITY before running it deep

Three Phase 2 flags were smoke-tested at 20 games first, and two would otherwise
have produced meaningless "neutral" numbers at depth:

- `bankAbilities` on presets: exactly 50%, `ActivateAbility` **18 vs 18** —
  byte-identical. No banking ability is in the preset decks at all, so the flag
  changed nothing. Re-based on `--decks=sfd` it became real (100 vs 84).
- `hideCards`: **1 use in 20 games**. Still only 46 in 200 on SFD.

**A flag that changes no action count has not been measured, whatever its win
rate says.** Read the action mix on a cheap run before spending an hour. An
un-filter that reads exactly 50.0% with identical counts is telling you the
basis is wrong, not that the change is neutral.

## A repeatable first step will eat a greedy policy

`floatRunes` measured **0%**, floating 415 times per 20 games while playing 70
cards against 161. The evaluator CAN price floating once the rollout is on — that
part works. The failure is that `chooseAction` returns only the first action of a
plan, and floating is always the first move of a better line, so the AI prepares,
re-plans, and prepares again. The payoff stays one step away forever.

Two things this rules out as explanations, both checked: it is not the
enumeration tie-break (`legalActions` pushes Pass before `floatRuneCandidates`,
so floating scores strictly higher), and it is not an evaluator gap. Before
un-filtering any action, ask whether it is **repeatable and preparatory**. If it
is, a first-action policy will loop on it no matter how good the lookahead is.

## Wire the executor before un-filtering the action

`applyBare` returned `state` for `FloatRune` and `HideCard` on the grounds that
`candidateActions` never offered them. Un-filtering without wiring the real
executors would have scored every one as "nothing happened", tied them with Pass,
and reproduced the old behaviour while looking like a change — a green run
measuring nothing. Check the apply path, not just the filter.

## A tuning run is a liveness probe

`errors` and `hitCap` are gated at zero in both modes, deliberately. The last
round's re-tuning made the AI spend cards faster, reached two empty decks that
the then-missing Burn Out (431) could not resolve, and self-play sat at 7-7
passing to turn 538. `ai-health`'s 40/40 had been walking straight past it.

`chooseAction` can also **throw** — `settleDeferredResolution` stalls loudly on a
chain that will not drain. The harness catches it, names the seed and the deck
pairing, and fails the run.

Anything either of these turns up **invalidates the tuning it interrupted**: fix
it, rebuild, re-measure from calibration. Do not keep the numbers.

## Before pricing a horizon change, measure the horizon

The plan for extending the lookahead was written from a read of the source and
its central claim was incomplete in the direction that costs points. Measure
first; this took twenty minutes:

- The settle takes only `AnswerDecision`, `PassFocus`, and (when `twoPly`) an
  opponent reply. It cannot cross a turn boundary — `runEnd` is called from
  exactly one place, `submit`'s `Pass`.
- But `applyBare`'s `case "Pass": return state;` is a **no-op**, while the real
  `submit` runs `runStartOfTurn(runEnd(state))`: end turn, rotate, opponent's
  Awaken, their `killTemporaryPermanents`, their **hold scoring**, their draw.
- Measured over 30 preset games: 385 Passes, and in **136 of them the opponent
  scored — 155 points handed over, priced at zero**. The actor also sheds 233
  Might to expiring this-turn buffs across those same passes.

Two consequences for any horizon work. A rollout that stops at "it would end the
turn" evaluates a **pre-`runEnd`** board, so it counts this-turn Might and
Temporary permanents that are about to vanish — extending the horizon that way
*rewards* accumulating exactly what the next step deletes. And the terminal
evaluation has to be `runStartOfTurn(runEnd(...))`, not the state before it, or
the opponent's incoming hold scoring stays invisible.

**Fixing Pass alone does not work, and that is measured** — `passEndsTurn`, off,
neutral on both bases. See the bias/recognition note above. Correcting one side
of a comparison is not half a correction; it is a new error in the other
direction, and it was not obviously so until the numbers came back.

**Fixing BOTH sides works enormously** — `ownTurnRollout`, 69.5% on presets and
58.8% on VEN (beamed; 71%/59.2% unbeamed), reverse control an exact mirror at 22%.

### Two policies now exist, and that changes what a probe figure means

`BASELINE_WEIGHTS` keeps the rollout OFF (~11.8x runtime; `reachability` would
land near an hour). `HUMAN_OPPONENT_WEIGHTS` turns it on and is what
`GameBoard.tsx` passes. **So CLAUDE.md's pinned figures describe the probe
policy, not the opponent a person plays.**

Accepted only because the bias runs the safe way — the rollout plays MORE cards,
moves and abilities, so a probe on the cheap policy UNDERSTATES a real game, and
`reachability` is a floor. Check that direction before adding any further split.
The two constants differ by exactly one flag and a test pins it, so tuning a
weight cannot quietly produce a second tuning nobody measures.

### Tuning against a UI thread

`chooseAction` runs synchronously in the browser, so its worst case is a frozen
tab. Measure the TAIL, not the mean: the rollout's median was 0.55 ms and its p95
28 ms while 4 decisions in 1271 — all with 41-80 candidates — took 22.4% of total
time, worst 954 ms. `ROLLOUT_BEAM` (top 8 candidates by 1-ply score) took that to
153 ms for 1.5pp of win rate.

**Never time-box.** Every probe depends on `chooseAction` being a pure function
of `(state, weights)` and `walkout` is pinned deterministic; anything consulting
a clock makes play depend on machine load and destroys every pinned figure rather
than moving it. Beam on a deterministic key instead, and export the boundary so a
test asserts it from both sides — the `groupedMoveTruncated` precedent.

### `Pass` is a candidate, and a rollout will eat it

The first `ownTurnRollout` measured **0.25%**, one win in four hundred. Rolling
out the Pass candidate scores it as "play my whole turn out, then end it" — the
same thing the best real action scores, since the rollout plays that action
anyway. Everything ties with Pass, ties go to Pass, and the AI ends its turns
having done nothing while the lookahead believes it played them.

**Nothing but this harness could see it.** No exception, no invalid action, no
stall, and `ai-health` stayed 40/40 — passing terminates games perfectly well.
The signals were the win rate and `MoveUnit` at 107 against 1280.

Whenever you extend the horizon, ask what the horizon does to the action that
ENDS the thing being extended. It must terminate the lookahead, not be absorbed
by it.

The blind spot is real and worth closing — median **2** discretionary actions per
turn, max 11 — but ~28% of turns have one or fewer, where it changes nothing.

## Recording a result

Weights live in `EvalWeights` / `BASELINE_WEIGHTS` doc comments with their win
rate **and their basis**, because a weight without its measurement is an invented
number and the standing rule here is no speculative heuristic without a real
evaluative basis.

This harness has been lost **twice** as a scratchpad script while its numbers
stayed quoted as settled fact. It is a probe now, in `tsconfig.probes.json`. Do
not rebuild it in a scratchpad, and do not quote a figure whose instrument you
cannot run.

## The checklist

1. `npm run build --workspace=@rift-engine/engine`.
2. Calibration — exactly 50.0%, `mixesIdentical: true`, 0 errors, 0 hitCap.
3. Candidate on presets AND on `--decks=<set>`. Record both, with the basis line.
4. Read `candidateActions` vs `baselineActions` and state the mechanism.
5. Anything red in `errors`/`hitCap` — fix, rebuild, restart from step 2.
6. Full loop from `CLAUDE.md` before landing. `walkout` is 190/113/29 and **will**
   move for a horizon or action-space change; decompose it by control, and
   rebuild before the control run.
