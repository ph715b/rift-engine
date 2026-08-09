import type { Keyword } from "../model/keyword.js";

/**
 * Two sources of one keyword on one unit: does the value SUM, or is the second
 * instance redundant?
 *
 * **The rules answer this per keyword, and there is no general rule either way.**
 * This engine used to answer it with `Math.max` everywhere, justified at ~28
 * sites by citing "817.1.a's keyword redundancy rule". 817.1.a is *"It is present
 * on Permanents"*, under Vision. It says nothing of the kind, and no rule in the
 * document states redundancy in general — so every one of those merges was taking
 * the larger value on the strength of a citation that did not exist.
 *
 * What the PDF actually says:
 *
 *  - **SUMMED.** Four keywords, each in its own section and in identical wording.
 *    807.2 Assault: *"If a Unit has Assault or has been granted Assault and is
 *    granted Assault by an additional source, the Assault Value of all granted
 *    Assault keywords is summed."* Then 809.2 Deflect, 814.2 Shield, 823.2 Hunt.
 *    Assault and Shield each carry a worked example, and Assault's is reproducible
 *    in this pool card for card: Petty Officer (OGN-215) prints `[Assault]`,
 *    Cleave (OGN-004) gives `[Assault 3]`, and the rules' own answer is
 *    `[Assault 4]`. Ancient Warmonger (SFD-131) says the same thing from the other
 *    end in its reminder text — *"+1 Might while I'm an attacker **for each
 *    instance of Assault**"*.
 *
 *  - **REDUNDANT.** Stated per keyword, and only ever for the UNVALUED ones:
 *    805.4 Accelerate, 810.2 Ganking, 811.4 Hidden, 815.2 Tank, 816.2 Temporary,
 *    822.2 Ambush, 826.5 Backline.
 *
 * The four summed ones are exactly the four that carry a Value, and that is a
 * coincidence worth NOT generalising from — which is why this is a named list and
 * not "does the keyword have a number". `[Level N]`'s N is a THRESHOLD (824,
 * a Dependent Keyword: "while you have N+ XP"), not a magnitude, and UNL-049
 * Honeyfruit prints `[Level 3]` and `[Level 6]` on one card. Summing those would
 * be nonsense.
 *
 * Everything not named here takes the max branch, which is exactly what this
 * engine did before and so changes no behaviour: Vision, Deathknell, Legion,
 * Mighty, Quick, Equip, Weaponmaster, Quick-Draw, Repeat, Level. For most of them
 * the rules give a redundancy or an equivalence rule (818.4, 819.2, 820.3, 812.2,
 * 808.2) that a value map cannot express anyway. 817.2 — *"multiple instances of
 * Vision trigger separately"* — is the one that is genuinely wrong under max, and
 * it stays wrong here: it wants a COUNT, and this map holds a VALUE per keyword.
 * That divergence predates this module and is recorded in
 * docs/rules-conformance.md.
 */
export const SUMMED_KEYWORDS: ReadonlySet<Keyword> = new Set<Keyword>(["Assault", "Deflect", "Shield", "Hunt"]);

/**
 * Fold a granted `value` of `keyword` into a map that may already hold one, by
 * whichever of the two rules above governs that keyword.
 *
 * Mutates `out` rather than returning a new map. Every caller is building one
 * fresh object in a loop over sources, and the alternative — a pure
 * `mergedValue(keyword, a, b)` returning a number — was rejected because it left
 * `out[key] = merged(...)` at each site, which is precisely the shape that let
 * `Math.max` be copied into 28 places without anyone re-reading the rule.
 *
 * An absent entry reads as 0, so a first grant lands at its own value under
 * either branch. A summed grant of 0 (Ancient Warmonger with no enemies present)
 * therefore still CREATES the key at 0, exactly as `Math.max(undefined ?? 0, 0)`
 * did — `hasKeyword` asks `in`, so preserving that was deliberate rather than
 * incidental.
 */
export function mergeGrantedKeyword(out: Partial<Record<Keyword, number>>, keyword: Keyword, value: number): void {
  const existing = out[keyword] ?? 0;
  out[keyword] = SUMMED_KEYWORDS.has(keyword) ? existing + value : Math.max(existing, value);
}
