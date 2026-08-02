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
