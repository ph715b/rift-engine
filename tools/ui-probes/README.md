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

Regenerate the deck when the card pool changes:

```
node -e "...builds tools/ui-probes/.buffdeck.txt from the registry..."
```

Three things the deck text has to get right, each of which cost a run:
the champion the parser picks is itself a card (Sett - Brawler), so adding 3 more
copies makes 4 and validation refuses; the main deck needs **39** lines because
`cardIds = [...mainDeck, championId]` adds the champion once; and the sideboard
must be a full 8.

Run it with `PORT` set — never assume 5173. Stale vite servers held 5173-5183 on
2026-08-02 and the live server came up on **5184**.

`GAMES` defaults to **6** because two is not enough: two consecutive 2-game runs
gave 30 trigger-row states and then zero, same deck and same code.

`decisionsSeen: 0` is honest reporting of an UNEXERCISED path, not a pass. The
human passes all game, so it is never asked anything.
