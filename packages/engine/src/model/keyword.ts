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
