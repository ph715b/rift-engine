/**
 * Keywords confirmed in Origins + Proving Grounds card text (model/Keyword.java's
 * own doc comment: "HIDDEN, DEATHKNELL, MIGHTY, TEMPORARY — confirmed in OGN/OGS
 * card text. LEGION — grants a token on play; confirmed in OGN."). The Java enum
 * also has EQUIP/WEAPONMASTER/QUICK_DRAW (SFD) and HUNT/LEVEL/AMBUSH/BACKLINE
 * (UNL) — those sets are out of scope for now (see PRD open-question #1) and
 * get added here the same way each set's cards get added.
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
  "Add",
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
