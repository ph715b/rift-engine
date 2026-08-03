# Live UI probes

These drive the real app in a real browser and assert things the unit tests
structurally cannot: that a row never scrolls, that a card is never clipped by the
board's `overflow: hidden`, that a rune tile you must click during a payment is
actually the thing a click would hit.

They live here rather than in a session scratchpad because a probe kept outside
version control drifts silently. Three of this project's engine gate probes once
reported green for weeks while broken, and the UI drivers imported Playwright from
a hardcoded path inside a *third* session's temp directory — one folder cleanup
away from the whole set dying at once.

## Running

```sh
npm run dev --workspace=@rift-engine/web     # note the port it prints
PORT=5173 node tools/ui-probes/measure.mjs   # never assume 5173
```

`PORT` is not optional in spirit: stale vite servers from old sessions have been
seen holding 5173-5182 at once, so a probe aimed at a fixed port may be measuring
a different server than the one you just started.

If `chromium.launch()` fails, the browser binary is missing:

```sh
npx playwright install chromium
```

| probe | asserts |
|---|---|
| `measure.mjs` | shared card size, every row's height, **`scrollableRows === 0`**, and that no card's *visible* region falls outside `.board` |
| `peek.mjs` | the hand overlay's contract: collapsed at rest, opens on hover, stays shut while pinned, and never blocks a rune tile |
| `piles-check.mjs` | the board pile cluster is on-screen, never overlaps the rail content above it, and the trash stays clickable |
| `mull2.mjs` | the mulligan screen fits four cards at every size, and the board's fitted sizing has not leaked into it |
| `facedown.mjs` | an opponent's facedown card leaks neither its name nor a naming tooltip |
| `flights.mjs` | cards actually travel between the right zones (`ACTIVE=1` also drives recycle/discard) |
| `live-triggers.mjs` | a triggered ability really reaches the ChainView, named, with no console or page errors |

Most take `<width> <height>`; without arguments they sweep all four sizes.

## Reading the output

- **`scrollableRows`** is the invariant. `hBreach` is reported but does not fail a
  run: `scrollWidth` counts transformed descendants, so Framer Motion exit
  transforms and the 90° rotation on a tapped card inflate it. A single-child row
  has reported a 106px "breach" that was pure paint.
- **`racedSamplesSkipped`** (peek) and **`enemyFacedownTilesObserved=0`** (facedown)
  are honest reporting, not noise. A check that never ran must not read as a pass —
  gate on `tried > 0`.
- **`piles-check.mjs` takes `REGRESS=1`**, which re-injects the old absolutely
  positioned layout and must FAIL. A check you cannot make fail has verified
  nothing; keep that property when you edit it.

## `live-triggers.mjs` — and why it needs an imported deck

**No preset deck contains a single `battlefieldConquered` listener or Mistfall**,
so a preset-vs-preset game can never put a triggered ability on the chain. The
first run of this probe reported `triggerRowStates: 0` and said **OK** — the
0/0-reads-as-a-pass failure, reproduced in a brand-new instrument. It now imports
a purpose-built Sett buff deck through the real lobby UI (paste → Parse → Save)
and uses it for BOTH seats, and it **fails** when it sees no trigger row.

Regenerate the decks when the card pool changes:

```
node tools/ui-probes/make-buffdeck.mjs            # .buffdeck.txt — Sett, Body + Order
DECK=calm node tools/ui-probes/make-buffdeck.mjs  # .calmdeck.txt — Ahri, Calm + Mind
```

and run either with the matching `DECK`:

```
PORT=5173 SPECTATE=1 node tools/ui-probes/live-triggers.mjs
PORT=5173 SPECTATE=1 DECK=calm node tools/ui-probes/live-triggers.mjs
PORT=5173 ACTIVE=1 node tools/ui-probes/live-triggers.mjs            # the older, brittler way in
```

## Reaching DECISIONS: `SPECTATE=1` beats `ACTIVE=1`

A passing human never reaches a decision prompt — it plays nothing, and the AI
answers its own questions with no prompt — so the default run reports
`decisionsSeen: 0` meaning **not reached**, never "no decisions render".

There are two ways past that, and they are not equal:

- **`SPECTATE=1`** turns on the app's own AI-vs-AI mode, so BOTH seats are played
  by `chooseAction` — engine code with its own tests. Measured over 6 games:
  **52 decision states across 7 distinct prompts**, including King's Edict, which
  this probe had listed as never-seen since it was written. The driver answers
  nothing; the prompts render read-only and the bot answers a beat later.
- **`ACTIVE=1`** clicks the human's hand through a measured-pixel flow. It works,
  and it is the only way to check that a prompt is ANSWERABLE by a person — but
  it is ~60 lines of actionability workarounds that this file's own history
  records failing silently once, reporting `playAttempts: 0`.

Use SPECTATE to ask "does this render, and does play continue"; use ACTIVE to ask
"can a human answer it". The stranded-question check differs accordingly:
ACTIVE gates on `raised == answered`, SPECTATE on the RATIO — a prompt that could
never be dismissed would be counted by every subsequent sample, so
`decisionsSeen` approaching `stepsTaken` is its signature (3.2% measured, 25%
gated).

**Two decks, because a domain pair is a hard ceiling on what one deck can reach.**
The Body/Order deck cannot contain a single Calm card, so Sona - Harmonious, Ahri
- Alluring and Blitzcrank - Impassive were unreachable by any run of this probe —
and unreachable looks exactly like broken from here, since both report the trigger
as never observed. The Calm deck's legend is chosen so that its eligible champion
IS Ahri - Alluring: a champion has guaranteed Champion-Zone access, so her hold
trigger is reachable every game rather than on a draw.

Each deck's `priority` list is the point: filling by registry order alone produced
a deck containing none of the cards the probe exists to observe, so the probe
honestly reported that their prompts never rendered. **Anything whose live
behaviour you are checking has to go in that list.** The generator also encodes three things the
deck text must get right, each of which cost a run: the champion the parser picks
is itself a card (Sett - Brawler), so adding 3 more copies makes 4 and validation
refuses; the main deck needs **39** lines because `cardIds = [...mainDeck,
championId]` adds the champion once; and the sideboard must be a full 8.

Run it with `PORT` set — never assume 5173. Stale vite servers held 5173-5183 on
2026-08-02 and the live server came up on **5184**.

`GAMES` defaults to **6** because two is not enough: two consecutive 2-game runs
gave 30 trigger-row states and then zero, same deck and same code.

**`ACTIVE=1` is what reaches decisions.** Passing alone never can — the human
plays nothing and the AI answers its own questions silently — so a default run's
`decisionsSeen: 0` means "not reached", never "no decisions render". Active mode
plays from hand and gets **raised == answered**, which is what rules out a
stranded question.

Clicking a hand card needs the TOP ~12% of it, twice. The hand rests collapsed to
a ~32% peek inside `overflow: hidden`, so the layout-box centre is clipped away —
clicking there arms nothing and reports `playAttempts: 0`. Hover the visible
strip, wait for the hand to open, then RE-MEASURE before clicking, because the
point that was over the card no longer is (measured: y=845 to y=700).
