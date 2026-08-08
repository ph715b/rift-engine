/**
 * Keywords confirmed in Origins + Proving Grounds card text (model/Keyword.java's
 * own doc comment: "HIDDEN, DEATHKNELL, MIGHTY, TEMPORARY — confirmed in OGN/OGS
 * card text. LEGION — grants a token on play; confirmed in OGN."), plus the four
 * Spiritforged (SFD) brings.
 *
 * **The four SFD keywords are declared here and listed in coverage.ts's
 * `UNIMPLEMENTED_KEYWORDS`**, which is the shape that map exists for: the card
 * parses the keyword, and every card printing it reports NOT implemented until
 * the subsystem behind it lands. Declaring them without that entry is precisely
 * how `[Deflect]` shipped inert.
 *
 * `Quick-Draw` carries a hyphen. That is legal in a TS string literal and needs
 * no normalisation here — unlike Keyword.java, whose enum constants cannot hold
 * one, so CardLoader.parseKeywords strips it before the lookup. What it DID need
 * was widening `card-loader`'s `KW_PATTERN`, whose `[A-Za-z][a-zA-Z]*` could not
 * match the token at all and dropped it silently.
 *
 * The four UNL brings are declared the same way, on the day unl.json landed
 * (2026-08-08) rather than after somebody noticed a card doing nothing — and
 * all four are in `UNIMPLEMENTED_KEYWORDS` for exactly as long as the
 * subsystems behind them are unwritten.
 *
 * `[Predict]` is NOT among them, and that is a decision rather than an
 * oversight: it prints as an **action word** (`[Predict].` mid-sentence, like
 * `[Buff]` and `[Stun]`), not as something a card HAS. It is in
 * NON_KEYWORD_BRACKETS below.
 */
export const KEYWORDS = [
  "Ganking",
  "Quick",
  "Accelerate",
  "Assault",
  "Shield",
  "Deflect",
  "Tank",
  "Vision",
  "Hidden",
  "Deathknell",
  "Legion",
  "Mighty",
  "Temporary",
  // Spiritforged (SFD). All four are in UNIMPLEMENTED_KEYWORDS.
  "Equip", // Gear: an activated ability that attaches this to a unit you control.
  "Weaponmaster", // Unit, on play: may [Equip] one of your Equipment to me for 1 rainbow less.
  "Quick-Draw", // Gear: has [Reaction]; when played, attach it to a unit you control.
  "Repeat", // Spell: may pay an additional cost to repeat this spell's effect.
  // Unleashed (UNL). All four are in UNIMPLEMENTED_KEYWORDS. Card counts are
  // over the pool that LOADS (235 of 280 raw entries), not the raw file.
  "Hunt", // 12 cards. "When I conquer or hold, gain N XP." Bare = 1; also 2 and 3.
  "Level", // 16 cards. Dependent keyword (727): "While you have N+ XP, get the effect."
  "Ambush", // 12 cards. "You may play me as a [Reaction] to a battlefield where you have units."
  "Backline", // 4 cards. "I must be assigned combat damage last" — see combat.assignmentOrder.
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_BY_UPPER_NAME = new Map<string, Keyword>(KEYWORDS.map((k) => [k.toUpperCase(), k]));

export function keywordFromBracketText(word: string): Keyword | undefined {
  return KEYWORD_BY_UPPER_NAME.get(word.toUpperCase());
}

/**
 * Bracketed tokens in card text that are deliberately NOT keywords, each with
 * what reads it instead.
 *
 * `parseKeywords` takes any `[Word]` it does not recognise and drops it on the
 * floor — "not one of our modeled keywords", which is true and is also exactly
 * how a card can parse, deck, play and do nothing. `[Deflect]` shipped inert
 * that way, and an inert keyword is the most expensive kind of gap here because
 * there is nothing to see: the card costs runes, goes to the trash, and quietly
 * changes nothing.
 *
 * There is already a test that every keyword FLAGGED as unimplemented is real
 * (coverage-drift's "the mechanism is still WIRED"). This list is what makes
 * the reverse checkable — a token in the card DATA that nothing knows about —
 * and the sweep over it lives beside that test.
 *
 * It is a list, not a pattern. A regex that happened to exclude these three
 * would also silently swallow the next token an unseen set prints, and the
 * whole point is that a new one forces a decision: implement it as a keyword,
 * or name it here with what consumes it.
 *
 * Measured across the loaded pool rather than assumed, and re-measured each
 * time a set lands: 15 distinct bracketed words when the pool was OGN+OGS, 21
 * after SFD, and **27 after UNL** — 20 keywords and 7 entries here (`Add`
 * appearing in two castings makes 8 spellings). `coverage-drift.test.ts` states
 * that census card by card, which is what turns a new set's tokens into a
 * failing test rather than a silent drop.
 *
 * (`Quick` is still the one keyword that appears in NO bracket — every card
 * that has it prints it as prose, which is what `QUICK_TEXT_OVERRIDES` exists
 * for. So "every bracket is a keyword" is a claim satisfied by nineteen of the
 * twenty.)
 */
export const NON_KEYWORD_BRACKETS = [
  // The two timing tiers (rules 159 / 806 / 813). Read by card-loader's
  // `isAction`/`isReaction` flags and enforced in engine/timing.ts, not by the
  // keyword machinery — they are pure permission, not an ability.
  "Action",
  "Reaction",
  // The resource-adding instruction on the rune-producing Gear
  // (":rb_exhaust:: [Reaction] → [Add] :rb_rune_fury:."). Part of an activated
  // ability's text, implemented in engine/activated-abilities.ts. It is a verb,
  // and no card "has [Add]".
  //
  // SFD prints it uppercased as "[ADD]" on Renata Glasc - Chem-Baroness. That
  // needs no second entry: `isKnownBracketToken` compares upper-cased, so the
  // one name covers both castings.
  "Add",
  // "[Unique] (Your deck can have only 1 card with this name.)" — SFD's three
  // legendary Equipment. A DECKBUILDING restriction, not a gameplay ability:
  // nothing about a Unique card behaves differently once it is in play, so it
  // is not a keyword. Read by `decks/deck-validation.ts`'s `isUniqueCard`,
  // which tightens that card's copy cap from MAX_COPIES to 1.
  "Unique",
  //
  // ---- Unleashed (UNL), landed 2026-08-08 ----
  //
  // **The grant arrow, and the largest single token this set brings: 38 cards.**
  // It separates a condition from what the condition grants — `[Level 3][>] I
  // have +1 Might`, `[Legion][>] You may play me from your trash`,
  // `[Reaction][>] :rb_exhaust:: [Add] :rb_rune_rainbow:`.
  //
  // **Named here as `>` and not as `&gt;`**, which is the form the raw JSON
  // holds: `unl.json` carries the entity 49 times, and `card-loader`'s
  // `decodeTextEntities` — which predates this set, for SFD's `&quot;` — has
  // already turned it into a bare `>` by the time any of these gates read the
  // text. Allow-listing the escaped spelling would have matched nothing and
  // left all 38 cards reported as unknown, while the entry itself looked
  // deliberate.
  //
  // It is PUNCTUATION, so nothing "reads" it in the sense the entries above are
  // read — which is the whole reason it has to be named here. A separator that
  // no allow-list mentions is indistinguishable from a keyword nobody
  // implemented, and at 38 cards it would have been the loudest possible false
  // alarm on the day the set landed.
  ">",
  // The ability divider, on `UNL-049` Honeyfruit alone: its `[Level 6]` half
  // grants a SECOND activated ability, and this is what separates the two. One
  // card, named rather than folded into the arrow above, because they are
  // different glyphs doing different jobs.
  ">>",
  // Three ACTION WORDS — verbs inside an instruction, like `[Add]` above. No
  // card "has" one, so none is a keyword.
  //
  //   `[Stun]` (12 cards) and `[Buff]` (9) are mechanisms this engine already
  //   has: `UnitInstance.stunned` and `UnitInstance.buffed`/`spendBuff`. OGN and
  //   SFD print both as plain prose ("Stun a unit."); UNL is simply the first
  //   set to bracket them. So these two entries are the whole of their cost.
  //
  //   `[Predict]` (5 cards) is the one that needed deciding rather than
  //   recording, and it is NOT free. Its bare form is `engine/top-of-deck.ts`'s
  //   existing "look at the top card, you may recycle it". Its VALUED form
  //   `[Predict 2]` — `UNL-062` Dramatic Visionary and `UNL-136` Scryer's Bloom —
  //   reads "look at the top TWO, recycle any of them and put the rest back in
  //   any order", which is a subset choice plus an ordering decision and is not
  //   built. Both cards report unimplemented on their own text today, which is
  //   the correct answer and the reason this entry does not overstate anything.
  "Stun",
  "Buff",
  "Predict",
] as const;

const NON_KEYWORD_BRACKETS_UPPER = new Set<string>(NON_KEYWORD_BRACKETS.map((t) => t.toUpperCase()));

/**
 * Is a bracketed token accounted for — either a modelled keyword or an
 * explicitly allow-listed non-keyword?
 *
 * Reads `[Deflect]` and `[Deflect 2]` alike, through `keywordFromBracketText`
 * rather than a second copy of the bracket grammar, so this cannot come to a
 * different answer than the parser it is guarding.
 */
export function isKnownBracketToken(bracketInner: string): boolean {
  const word = bracketInner.trim().replace(/\s+\d+$/, "");
  return keywordFromBracketText(word) !== undefined || NON_KEYWORD_BRACKETS_UPPER.has(word.toUpperCase());
}
