# Prompt — battlefield abilities, and the four UI gaps behind them

Everything below was measured on 2026-08-04 at `2eda208`, not recalled. Paste the
block under the line into a fresh session.

**Steps 1 and 2 below are DONE, and so are two of the four UI gaps.** They are kept
rather than deleted because what they establish is what the remaining work builds
on — read them, do not redo them.

---

Read `docs/handoff-2026-08-04.md` first, then the memory files it names, then
`docs/rules-conformance.md`'s **Divergent** table and the **Log**'s top five rows.

Your job is **the 24 battlefield abilities**. They are the only part of this
document still unbuilt: the card is on screen, `BattlefieldState` knows which card
it is, and the UI gaps behind the original reports are closed or settled.

## First, a premise to correct

The request that started this was "implement all the battlefields from OGS".
**OGS contains no battlefields.** Measured directly from the card data:

| set | Unit | Spell | Gear | Legend | Rune | **Battlefield** |
|---|---|---|---|---|---|---|
| OGN | 166 | 84 | 30 | 36 | 12 | **24** |
| OGS | 11 | 9 | 0 | 4 | 0 | **0** |

All 24 battlefields are **OGN**, and every one has real rules text and an
`image_url`. So the work is "implement the 24 battlefields in the pool", and SFD
will add more.

## What exists, and what does not

**Battlefields are currently names and nothing else.** `BattlefieldState` carries
`id`, `name`, `controllerId`, `units`, `contestedByIndex`, `hiddenCards` — no
`defId`, no ability, no art. `LEGACY_BATTLEFIELDS` is three hardcoded strings
(`"Zaun Warrens"`, `"Targon's Peak"`, `"Reaver's Row"`), and all three ARE real
cards in the data; the engine just never links them.

`card-loader.ts:83` deliberately skips `Battlefield` (and `Rune`) in
`shouldSkip`, so no `CardDefinition` is ever built. Its own comment states the
reason plainly: *"`BattlefieldState` carries no per-name ability yet, so there's
no playable CardDefinition to build."*

**So: battlefield abilities are not broken. They do not exist.** Say so before
anyone debugs one.

**But the art and text are already loadable.** `loadBattlefieldDefinitions()`
(`card-loader.ts:390`) returns `{ id, name, imageUrl, text, domains }` for all 24,
as a presentation-only side lookup. It is used **only** by `DeckBuilder.tsx` — the
game board never touches it, which is why you cannot see a battlefield's ability
while playing.

## The order to do this in

1. ~~**Show the battlefield card in game.**~~ **DONE** (`ea01259`). Art and
   ability text render per battlefield via `web/src/battlefield-cards.ts`. Five
   tests, two of which guard the name lookup rather than the pixels.
2. ~~**Give `BattlefieldState` a `defId`.**~~ **DONE** (`2eda208`).
   `battlefieldDefIdFor(name)` resolves it and `battlefieldPair` stamps it ONCE at
   construction — not per read, so a state carrying its own card id cannot drift
   from one that re-derives it. Absent means "no printed ability", never "look it
   up by name later". **This is your key into the ability table.**
3. **Then implement the abilities, in clusters by trigger moment.** Read them
   first and group them; do NOT go alphabetically. The 24 fall out roughly as:
   - **"When you hold here"** — Altar to Unity, Grove of the God-Willow, Hallowed
     Tomb, Navori Fighting Pit, Startipped Peak, Reckoner's Arena, The Grand Plaza
   - **"When you conquer here"** — Monastery of Hirana, Sigil of the Storm,
     Targon's Peak, The Candlelit Sanctum, Zaun Warrens
   - **"When you defend here"** — Fortified Position, Reaver's Row
   - **Continuous / static** — Trifarian War Camp (+1 Might here), Vilemaw's Lair
     (no moving to base), Windswept Hillock (`[Ganking]` here), Void Gate (+1 bonus
     damage here), Aspirant's Climb (points to win +1), Bandle Tree (an extra
     hidden card here)
   - **Beginning-Phase / one-off** — Obelisk of Power, The Arena's Greatest
   - **Other** — Back-Alley Bar (on moving FROM here), The Dreaming Tree (first
     time a unit here is chosen by a spell)

   Hold/conquer already exist as engine moments (`scoring.ts`, the conquer
   triggers), so those two clusters are cheapest and should go first. **The
   continuous ones are the interesting risk** — several modify Might or movement
   for units *at a place*, and `effective-might.ts` and the movement rules have no
   notion of a battlefield-sourced modifier today.

4. **The Grand Plaza is a second win condition** ("if you have 7+ units here, you
   win the game"). Check `win-condition.ts` before assuming points are the only
   way to end a game.

## The four UI gaps, all verified

These were reported as engine bugs. **Three of them were not.** All four are now
closed or settled; none needs work. They are recorded because each one is a way to
misread this engine.

1. ~~**Floating Energy and Power are never displayed.**~~ **DONE** (`4117aef`).
   The engine was always correct — `activated-abilities.ts:303` banks it into
   `floatingPower[domain]` — and `GameBoard` read those fields only to price
   affordability, rendering neither. That alone made "Seals don't add power" look
   like an engine bug. A readout now sits under the Runes zone label, keeping the
   pools distinct (per-domain, rainbow, and the two Spells-only pools) because
   collapsing them would misstate what the player can afford.
2. ~~**Playing from hidden.**~~ **DONE** (`160aec4`), and it always worked —
   `legalActions` enumerates it and `GameBoard` had the handlers. The report was
   the affordance, plus rule 811's "beginning on the next turn" reading as a bug.
   Facedown cards are now card-sized backs INSIDE the owner's unit row, which cost
   no extra row because `use-row-fit.ts` already fans it. **If you touch that code:
   do not collapse the `mine` branch** — nothing masks this state, so that branch
   IS the opponent's secrecy, in label, title and alt alike.
3. **Un-tap a rune exhausted by mistake — SETTLED: there is no such ability.**
   Rule **164.2.b** gives a Basic Rune exactly two abilities and neither reverses
   the other:

   > `[E]: [Reaction] — Add [1].`
   > `Recycle this: [Reaction] — Add [C].`

   Nothing readies an exhausted rune on demand, so an "un-tap" is a UI affordance,
   never a rules action. Do NOT add a `FloatRune`-style engine action for it. The
   options are (a) a confirm step before exhausting, or (b) a genuine
   undo-last-action at the app layer that replays from the previous `GameState` —
   this app already keeps state per submit, so (b) is cheap and honest, and it is
   the only one that cannot desync the engine. Prefer (b), and refuse the undo once
   any later action has been submitted.

4. **Auto-float Energy when recycling a Ready rune — SETTLED, and the requested
   behaviour is NOT automatic.** The same two abilities are separate: recycling
   does not exhaust, so `Recycle this` adds Power and nothing else. Granting Energy
   automatically would be inventing a third ability the rune does not have.

   But the resource need not be wasted, because a player may use BOTH abilities on
   the same rune: exhaust it for Energy, then recycle it for Power. That is the
   "double duty" this engine already implements and tests — Baited Hook's own test
   asserts one Ready Order rune covers an Energy and a Power cost, and
   `deflect-surcharge.test.ts` pins the limit (double duty serves the OWNER's cost;
   it does not make two Powers).

   So the correct fix is a **UI convenience, not an engine rule**: right-clicking a
   *Ready* rune should submit the exhaust-for-Energy action and then the
   recycle-for-Power action, in that order, as two real activations. `floatPower`
   in `GameBoard.tsx` currently submits one action; chaining needs the second to
   run against the state the first returned, so thread it rather than calling
   `applyAction` twice against stale state. Offer it only when BOTH actions are
   legal, and leave right-click on an already-Exhausted rune exactly as it is.

## Standing discipline — non-negotiable

- **Prove every fix by making the check fail first**, and confirm a mutation
  actually applied before believing a green run.
- **Verify a report before implementing it.** Of five suspected engine bugs in the
  last session, exactly one was real, and of the four items above, three are UI
  gaps behind a working engine. The Baited Hook fix in this same session had its
  obvious cause (control lapsing) disproved by a failing test before the real one
  (359.3 linked instructions) was found.
- **Fix the PREMISE, never weaken the assertion.**
- **Record divergences in `docs/rules-conformance.md` in the same change.**
- **Never bulk-edit source with PowerShell**; a python round-trip with explicit
  `utf-8` and `newline=""` is safe, the repo is CRLF, and every replacement should
  `assert`.
- Scratch files in the session scratchpad, not beside the source. Commit per task
  and push.

## Verification loop — every time, in this order

1. `npm run test --workspace=@rift-engine/engine`
2. `npm run build --workspace=@rift-engine/engine` — **before** the web typecheck
3. `npm run typecheck`, then `npm run build`
4. `npx tsx packages/engine/probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts`
5. Live, since all of this is visible to a player: `PORT=<port> node
   tools/ui-probes/live-triggers.mjs` with `SPECTATE=1`. Never hardcode 5173.

`exercised.ts` is new — it reports which cards have ever actually run, and splits
`inDeckButNeverOffered` (a possible engine gap) from `offeredButNeverTaken` (the
AI declining, by design). Read its header before quoting its numbers.
