# Session brief — make the engine set-ready, before SFD (Spiritforged) lands

Written 2026-08-03 at `017752e`, branch `feat/showdowns-timing-and-chain-viewer`,
clean tree, 1711 engine + 53 web tests green.

---

## Read these first, in this order

Memory (`~/.claude/projects/a--Projects-Rift-Engine/memory/`):
`project_status.md`, `rift-engine-verification-loop.md`, `probe-instruments.md`,
`web-ui-layout.md`, `chain-pending-items-plan.md`. All five are load-bearing and
current; do not re-derive what they already record.

Then `docs/rules-conformance.md` — in particular the **Divergent** table and the
**Log**'s last six rows. The table was audited on 2026-08-03 and is accurate as
of this commit.

**Where the card data lives:** `packages/engine/src/cards/ogn.json` and
`ogs.json` are raw API dumps (`riftbound_id`, `set.set_id`, Riot CDN art);
`card-loader.ts` normalises them. Adding a set is a new JSON file plus one entry
in `CARD_FILES` (`card-loader.ts:23`). `deriveId` turns `"sfd-001-298"` into
`"SFD-001"` with no change, so ids are already set-agnostic.

---

## The state you are starting from

- **The OGN+OGS pool is 100% implemented — 270 of 270.** Both
  `coverage.PARTIALLY_IMPLEMENTED` and `coverage.UNIMPLEMENTED_KEYWORDS` are
  EMPTY. Keep both mechanisms; they are what stops a half-written card reporting
  DONE.
- The chain conversion is partial by design: 80 cards held, 30 still inline.
  Not this session's work.

---

## Task 1 — make the completeness gates PER SET

Two tests assert that the whole pool is implemented. Both are correct today and
both turn red the moment SFD lands, and stay red for weeks — a wall of noise
exactly when you need the suite to tell you what is left.

- `packages/engine/test/effect-registry.test.ts:160` — *"...and every real card
  in the pool is now implemented"*, asserts `[]`.
- `packages/engine/test/coverage-drift.test.ts:302` — the partial-note sweep,
  asserts `[]`.

**Done looks like:** a finished set is still a HARD gate (a regression in OGN or
OGS fails loudly), while a set under construction reports progress instead of
failing. Something like a `COMPLETE_SETS` list the gate iterates, so adding SFD
to it later is one line and is the moment the gate starts protecting it.

**Trap:** do not weaken the assertion into a count or a percentage. The value of
the current gate is that it names the cards. Keep the naming; change the scope.

---

## Task 2 — a guard for an UNKNOWN keyword (highest value here)

`parseKeywords` reads any `[Word]` bracket into `keywords`. If nothing consumes
it the card parses, decks, plays — and does nothing. This is exactly how
`[Deflect]` shipped inert for a while, and it is the failure that costs the most
because there is nothing to see.

There IS a test that every FLAGGED keyword is real
(`coverage-drift.test.ts`, "the mechanism is still WIRED"). **Nothing checks the
reverse** — a token in the card data that nothing knows about.

Measured on current data (script it, don't trust this): **15 distinct bracketed
tokens; 13 are `KEYWORDS`; 3 are known non-keywords — `[Action]`, `[Reaction]`,
`[Add]`.**

**Done looks like:** a test that scans every card's `text.plain` for `[Word]`
tokens and fails, NAMING the token and the cards, unless it is in `KEYWORDS` or
on a short explicit allow-list of non-keyword markers. Passes today with the
three above allow-listed.

**Trap:** the allow-list must be explicit and commented, not a regex that
happens to exclude them. The point is that a new token forces a decision.

---

## Task 3 — `HIDDEN_KEYWORD_FALSE_POSITIVES` is keyed by NAME

`card-loader.ts:35` — `new Set(["Guerilla Warfare", "Ava Achiever", "Ember
Monk", "Noxus Saboteur"])`. It is the only per-card table keyed by name rather
than defId. A reprint or a cross-set name collision silently mis-flags a card's
`[Hidden]`.

**Done looks like:** keyed by defId like every other table
(`CONDITIONAL_KEYWORD_DEF_IDS`, `GRANTED_ONLY_KEYWORDS`, `QUICK_TEXT_OVERRIDES`
are the models), with the four current entries converted and a test that the
same four cards still resolve the same way.

---

## Then: the pre-flight sweep before SFD

Not speculative work — these are the specific places a new set can go wrong
quietly. Check each and report what you find; only fix what is actually broken.

1. **`shouldSkip`** (`card-loader.ts:59`) drops `Rune`, `Battlefield`, `Token`
   supertype, `Showcase` rarity and `alternate_art`. Confirm SFD's data uses the
   same markers — a new variant type would silently import duplicates.
2. **`DOMAINS`** (`model/domain.ts:8`) is a closed 7-value union. If SFD adds a
   domain this is a compiler-guided change; confirm nothing switches on domain
   exhaustively in a way that would silently default.
3. **`isEligibleChampion`** (`decks/deck-validation.ts:15`) matches a champion to
   its legend by NAME PREFIX (`"Sett - "`). A new set's champion for an existing
   legend works; a legend or champion whose name format differs does not. Worth a
   test with a synthetic pair.
4. **`POWER_DOMAIN_ALT_OVERRIDES` and `QUICK_TEXT_OVERRIDES`** are per-defId
   corrections for data the loader cannot infer. Expect SFD to need its own
   entries; make sure there is a way to NOTICE (a card whose keywords look wrong)
   rather than discovering it in play.
5. **`parseDecklistText`** folds names (lowercase + collapsed whitespace) and has
   a test that no two card names collide once folded. Re-run that thinking for a
   larger pool — cross-set collisions are more likely.
6. **Coverage reporting** should be per set, so "how done is SFD" is a number you
   can watch the way `270/270` drove the last stretch. Lower priority than 1–3;
   do it if it falls out naturally.

---

## Discipline (standing, non-negotiable)

- **Prove every fix by making the check fail first.** A test that passed before
  the change tests nothing.
- **Fix the PREMISE, never weaken the assertion.** Implementing something breaks
  tests whose premise was that it did nothing; that is the mechanism working.
- **Record divergences in `docs/rules-conformance.md` in the same change**, and
  re-read what it already claims first — it has been stale three times, always in
  the direction of overstating difficulty.
- **Never bulk-edit source with PowerShell** (it mojibakes em-dashes and adds a
  BOM). Never run `npx prettier`.
- Write scratch files to the session scratchpad, NOT next to the source — two
  got committed by accident this week.
- Commit per task with a real message, and push.
- Do not call the Agent tool, workflows, or deep research unless asked.

## Verification loop — every time, in this order

1. `npm run test --workspace=@rift-engine/engine`
2. `npm run build --workspace=@rift-engine/engine` — **before** the web typecheck,
   because `@rift-engine/web` resolves the engine from `dist`
3. `npm run typecheck`, then `npm run build`
4. Probes: `npx tsx packages/engine/probes/{ai-health,passive-human,chain-depth,walkout}.ts`
5. Live only if a player can see the change: `PORT=<port> node
   tools/ui-probes/live-triggers.mjs` (add `SPECTATE=1` to reach decision
   prompts). Never hardcode 5173.

---

## DONE — 2026-08-03, `25f6f48`

All three tasks and the sweep landed. 1711 → **1748 engine tests**, 53 web,
typecheck + both builds + all four probes green. Four commits, pushed.

**Where the brief's own figures were wrong, measured:**

- **12 bracketed keywords, not 13.** 15 distinct bracketed words, 12 in
  `KEYWORDS` and the 3 non-keywords named above. **`Quick` appears in no bracket
  at all** — every card that has it prints it as prose, which is what
  `QUICK_TEXT_OVERRIDES` exists for. So "every bracket is a keyword" is a claim
  satisfied by twelve.
- **A variant print does NOT arrive as a duplicate defId.** Un-skipping all 54
  Showcase entries adds 54 definitions with 54 distinct ids, zero collisions —
  each variant carries its own card number. So sweep item 1's detector had to be
  a census of the markers, not a duplicate check.
- **The per-set split is 248 + 22, not 246 + 24.** The first guess written into
  the test failed, which is the test working.
- **The probe figures in `probe-instruments` are stale, and it is not this
  session.** walkout is 137 walkouts / 83 points and chain-depth's Awaken
  Mistfall is 50 — confirmed identical at `582bede`, before any of this work.

**One live bug found by the sweep, in a test rather than in the engine:** the
decklist collision check carried a hand-copy of the parser's fold that had
already drifted, omitting the curly-quote normalisation — in a pool holding
Kai'Sa, Kog'Maw, Zhonya's Hourglass and Spirit's Refuge. `foldCardName` is now
exported and shared.

**What SFD landing costs, now:** one JSON file, one `CARD_FILES` entry, and the
completeness gates report progress instead of failing. Finishing it is one line
in `COMPLETE_SETS` — and `finishedButUndeclared` is what tells you to write it.

## Out of scope this session

The chain conversion's remaining 30 cards, the AI, and anything in the deck
builder. If SFD's data arrives mid-session, do NOT start implementing cards —
finish the readiness work first, then survey and cluster, which is the sequence
that worked for OGN.
