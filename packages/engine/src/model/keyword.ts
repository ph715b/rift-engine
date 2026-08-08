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
 * Still out of scope, and named so the next set cannot reopen the hole: the Java
 * enum's HUNT/LEVEL (UNL Round 1's G-XP mechanic) and AMBUSH/BACKLINE (UNL Round
 * 2a). **None of the four is printed by a single SFD card** — measured over
 * sfd.json, not assumed — so the XP resource of rule 728 is a UNL problem, not
 * an SFD one.
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
] as const;

export type Keyword = (typeof KEYWORDS)[number];

/**
 * The keywords whose VALUE accumulates when more than one source grants it.
 *
 * **The rules say this per keyword, and for these three they all say "summed".**
 * Not a general principle — every other keyword has its own rule and most of
 * them say the opposite:
 *
 * - **807** (Assault): "If a Unit has Assault or has been granted Assault and is
 *   granted Assault by an additional source, the Assault Value of all granted
 *   Assault keywords is summed." Worked example: Petty Officer has Assault, is
 *   targeted by Cleave ("Give a unit [Assault 3] this turn"), and ends the turn
 *   on **Assault 4**.
 * - **815.1.c.2** (Shield) and **810.1.c.3** (Deflect): the same sentence, with
 *   the same worked example shape (Stalwart Poro + Block).
 *
 * Everything else is redundancy: "Multiple instances of Accelerate/Ganking/
 * Hidden/Tank/Temporary are redundant" each appear verbatim, and Quick-Draw's
 * says instances "have no effect beyond the first". Those take the presence, not
 * a sum, which is what the `Math.max` merge gives them.
 *
 * **This existed as the OPPOSITE claim until 2026-08-08.** `granted-keywords.ts`
 * asserted that "two sources granting [Shield] is still [Shield 1], and the
 * rules' redundancy rule (817.1.a) says so" — 817 is TEMPORARY's rule, and
 * reading it as a general one made Lucian - Purifier's "your Equipment each give
 * [Assault]" grant 1 no matter how many Equipment a unit wore. Found in
 * playtest.
 *
 * `[Vision]` is deliberately absent: its instances "trigger separately" (818),
 * which is a COUNT of triggers rather than a value, and this map holds values.
 * That remains a recorded divergence.
 */
export const SUMMED_KEYWORD_VALUES: ReadonlySet<Keyword> = new Set<Keyword>(["Assault", "Shield", "Deflect"]);

/**
 * Folds one granted instance of `keyword` into a running keyword map, on the
 * terms that keyword's own rule states.
 *
 * The ONE function every merge site calls, because the sites are six deep across
 * three files and six copies of a two-way branch is six chances to get the
 * second way wrong — the failure this codebase keeps rediscovering.
 */
export function mergeKeywordValue(
  into: Partial<Record<Keyword, number>>,
  keyword: Keyword,
  value: number,
): void {
  into[keyword] = SUMMED_KEYWORD_VALUES.has(keyword)
    ? (into[keyword] ?? 0) + value
    : Math.max(into[keyword] ?? 0, value);
}

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
 * Measured across the loaded pool rather than assumed: **15 distinct bracketed
 * words, 12 of them in KEYWORDS and these 3.** (`Quick` is the thirteenth
 * keyword and appears in no bracket at all — every card that has it prints it
 * as prose, which is what `QUICK_TEXT_OVERRIDES` exists for. So "every bracket
 * is a keyword" is a claim satisfied by twelve, not thirteen.)
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
