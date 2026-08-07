import ognRaw from "./ogn.json" with { type: "json" };
import ogsRaw from "./ogs.json" with { type: "json" };
import sfdRaw from "./sfd.json" with { type: "json" };
import type { Domain } from "../model/domain.js";
import { isDomain, lowestOrdinalDomain } from "../model/domain.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import type { CardDefinition } from "../model/card-definition.js";
import { extractCardItems, type RawCard } from "./raw-card-schema.js";

/**
 * Card pool in scope: Origins (OGN) + Proving Grounds (OGS) + Spiritforged
 * (SFD). SFD's milestone is now open, so it is loaded here; `unl.json`
 * (Unleashed) still exists only in the oracle repo and gets added the same
 * way when its own milestone opens.
 *
 * `sfd.json` was taken byte-for-byte from the frozen Java oracle
 * (A:\Projects\riftbound-engine\src\main\resources\cards\sfd.json), the same
 * provenance as ogn.json/ogs.json. 288 raw entries, of which `shouldSkip`
 * keeps 206; the other 82 are 15 Battlefields, 66 Showcase/alternate-art
 * prints and 1 Token. 206 + 15 = the set's printed 221.
 *
 * Note it is a BARE ARRAY, like ogn.json and unlike ogs.json's paginated
 * `{items}` envelope — `extractCardItems` already reads both. Unlike either
 * of the older two it carries no BOM, and unlike ogn.json it is free of the
 * latin-1 mojibake recorded in docs/rules-conformance.md.
 *
 * Statically imported (not read via `fs` at runtime) so this module works
 * unmodified in both Node and a bundled browser build (e.g. packages/web) —
 * a real constraint discovered building the web board, not a preference:
 * `fs`/`node:path` can't be bundled for the browser at all, and Rollup
 * fails the build outright if anything in the module graph imports them
 * unconditionally, even if the function that uses them is never called
 * client-side.
 */
const CARD_FILES: readonly unknown[] = [ognRaw, ogsRaw, sfdRaw];

/**
 * The bracket grammar `parseKeywords` reads. The trailing `-` in the character
 * class is load-bearing: SFD prints `[Quick-Draw]`, and without it this pattern
 * does not match that token AT ALL — the keyword parses onto no card, and the
 * Gear that prints it reads in play as simply not working, with nothing to see.
 * That is the same failure `[Deflect]` shipped with, arriving through the
 * grammar rather than through a missing implementation.
 *
 * Note the guard in coverage-drift.test.ts deliberately scans the WIDER
 * `\[([^\]]*)\]` instead, precisely so a token this pattern cannot see still
 * lands there rather than being invisible to both.
 */
const KW_PATTERN = /\[([A-Za-z][a-zA-Z-]*)(?: (\d+))?\]/g;

/**
 * Playtesting fix ported from CardLoader.java:188-213 — four cards MENTION
 * "[Hidden]" in reference to other cards rather than carrying the keyword
 * themselves. Confirmed present in the OGN/OGS pool (checked directly against
 * both files); every genuine [Hidden] card's text starts with "[Hidden] (Hide
 * now for...".
 *
 * **Keyed by defId, like every other per-card table here.** It was keyed by
 * NAME — the only one that was — which is safe exactly while no two cards in
 * the pool share a name, and there is nothing in the loader that says so or
 * would notice. A reprint or a cross-set name collision in an unseen set would
 * have silently mis-flagged the newcomer's `[Hidden]`: it would parse as not
 * having a keyword it prints, which reads in play as the card simply not
 * working, with nothing to see. `CONDITIONAL_KEYWORD_DEF_IDS`,
 * `GRANTED_ONLY_KEYWORDS` and `QUICK_TEXT_OVERRIDES` were already defId-keyed;
 * this is now the same shape as all three.
 */
const HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS = new Set([
  "OGN-018", // Noxus Saboteur — "Your opponents' [Hidden] cards can't be revealed here."
  "OGN-107", // Ava Achiever — "...play a card with [Hidden] from your hand, ignoring its cost."
  "OGN-167", // Ember Monk — "When you play a card from [Hidden], give me +2 Might this turn."
  "OGN-264", // Guerilla Warfare — "Return up to two cards with [Hidden] from your trash..."
]);

/** The four cards above, for the test that pins each entry to a real card whose
 *  text really does mention `[Hidden]`. Exported rather than the Set itself, on
 *  the same reasoning as `loaderHandledDefIds` below: the table stays private
 *  and only its contents are readable. */
export function hiddenKeywordFalsePositiveDefIds(): string[] {
  return [...HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS];
}

const LEGION_DISCOUNT_PATTERN = /\[Legion\].*?cost\s*:rb_energy_(\d+):\s*less/i;

/**
 * Cards whose printed Power pip is VISUALLY split between two domains
 * (confirmed by direct inspection of the card art), as opposed to merely
 * listing two raw domains in classification.domain — the ordinary
 * multi-domain-identity case — a Signature card's inherited Legend colour
 * identity, used for deckbuilding rather than as a dual Power cost. Hardcoded rather than derived from card data — precise
 * and safe for a handful of confirmed cases, mirroring CARD_EFFECTS
 * (engine/card-effects.ts)'s identical "not worth a parsing scheme until
 * there are enough registered cases" reasoning. Add another entry here
 * ONLY after the same visual confirmation, never by assuming every
 * multi-domain card is hybrid.
 */
const POWER_DOMAIN_ALT_OVERRIDES: Record<string, Domain> = {
  "OGS-018": "Chaos", // Tibbers — Fury/Chaos split pip; lowestOrdinalDomain already yields "Fury" as the primary domain below

  // **OGN and OGS's eleven, added 2026-08-06 — and this table's own note used to
  // say the opposite about one of them.** It read "Decisive Strike's Body+Order,
  // whose pip is a solid single color and is NOT hybrid". That is false: pulled
  // off the CMS and read at 4x beside a single-domain control (Anivia, Body, 2
  // Power — one SOLID orange capsule with two Body glyphs), all eleven show the
  // same left/right two-colour capsule Tibbers has and that this table treats as
  // the definition of a hybrid pip.
  //
  // They were found as CONTROLS while confirming SFD's fourteen, which is the
  // only reason anyone looked: nothing in the pool distinguishes a mis-costed
  // card from a correctly-costed one, because the wrong answer is simply a cost
  // that cannot be paid off runes that should cover it.
  //
  // The alt is always the higher-ordinal of the card's two domains, exactly as
  // for SFD's.
  "OGN-248": "Mind", // Icathian Rain — Fury/Mind, 3 Power
  "OGN-250": "Body", // Stormbringer — Fury/Body, 2 Power
  "OGN-252": "Chaos", // Super Mega Death Rocket! — Fury/Chaos
  "OGN-254": "Order", // Noxian Guillotine — Fury/Order
  "OGN-258": "Body", // Dragon's Rage — Calm/Body
  "OGN-260": "Chaos", // Last Breath — Calm/Chaos, 2 Power
  "OGN-262": "Order", // Zenith Blade — Calm/Order, 2 Power
  "OGN-264": "Chaos", // Guerilla Warfare — Mind/Chaos
  "OGN-266": "Order", // Siphon Power — Mind/Order
  "OGN-270": "Order", // Showstopper — Body/Order
  "OGS-024": "Order", // Decisive Strike — Body/Order

  // SFD's fourteen, every one confirmed by pulling the card art off Riot's CMS
  // (the `media.image_url` already in the JSON) and looking at the pip at 4x
  // against a single-domain control. The distinction is unambiguous once you
  // put them side by side:
  //
  //   single domain  — ONE solid-colour capsule, N copies of that domain's icon
  //                    (Anivia, Body, 2 Power: solid orange, two Body glyphs)
  //   split pip      — ONE capsule divided left/right into the two domains'
  //                    colours, N glyphs inside it
  //
  // A pip's POWER COST is the glyph count, not the colour count — which is the
  // trap here. Three of these cost 2 Power and read at a glance like "two
  // pips, one per domain"; they are one split capsule holding two glyphs, the
  // same as Tibbers above. Every dual-domain card in SFD that has a Power cost
  // at all is one of these, with no exceptions, so the alt is always simply the
  // higher-ordinal of the card's two domains.
  //
  // Without an entry each of these silently takes `lowestOrdinalDomain` and
  // demands its whole Power cost in that ONE domain — so Forgefire Cape, whose
  // pip is half Calm and half Mind, could not be paid with a Mind rune at all.
  // That is the exact failure this table exists to prevent.
  "SFD-182": "Mind", // Danger Zone — Fury/Mind
  "SFD-184": "Body", // Relentless Pursuit — Fury/Body
  "SFD-186": "Chaos", // Spinning Axe — Fury/Chaos
  "SFD-188": "Order", // Void Rush — Fury/Order
  "SFD-190": "Mind", // Forgefire Cape — Calm/Mind, 2 Power in one split capsule
  "SFD-191": "Mind", // Rabadon's Deathcrown — Calm/Mind, 2 Power
  "SFD-192": "Mind", // Shurelya's Requiem — Calm/Mind, 2 Power
  "SFD-194": "Body", // Counter Strike — Calm/Body
  "SFD-196": "Chaos", // Defiant Dance — Calm/Chaos
  "SFD-198": "Order", // Arise! — Calm/Order
  "SFD-200": "Chaos", // Arcane Shift — Mind/Chaos
  "SFD-202": "Order", // Hostile Takeover — Mind/Order, 2 Power
  "SFD-204": "Chaos", // On the Hunt — Body/Chaos, 2 Power
  "SFD-206": "Order", // Riposte — Body/Order, 2 Power
};

/** Rune/Battlefield/Token-supertype/Showcase-rarity/alternate-art entries never become playable
 *  CardDefinitions. Mirrors CardLoader.java's `skip()` (registry/CardLoader.java:274-282). */
/**
 * The "+N Might" badge an Equipment grants the unit it is attached to.
 *
 * **This data is NOT in the card JSON anywhere**, and that was confirmed rather
 * than assumed: `attributes.might` is null on every Equipment, the badge appears
 * in neither `text.plain` nor `text.rich`, and it is absent from
 * `accessibility_text` too. It exists only on the printed card art — Doran's
 * Blade shows a shield reading "+2" in its bottom-right corner and its JSON says
 * nothing at all about it.
 *
 * So this is the same class of gap as `POWER_DOMAIN_ALT_OVERRIDES` above: data a
 * parser cannot reach because it is in the picture. Values are the frozen Java
 * oracle's `CardLoader.EQUIP_MIGHT_BONUS`, which hand-transcribed all 31 from
 * the art — and two of them (Doran's Blade 2, Forgefire Cape 3) were read off
 * the images independently here before that table was found, and agreed.
 *
 * **Keyed by defId, not by name.** The oracle keys this by card name; this repo
 * already learned why that is unsafe when `HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS`
 * was converted — a name key is correct exactly while no two cards in the pool
 * share a name, which nothing here states or would notice changing.
 *
 * **A second gap is NOT covered here and is the larger one.** The oracle records
 * that about 20 of these same 31 cards also carry a non-Might ability rendered
 * the same art-only way (Trinity Force: "When I hold, score 1 point"; Warmog's
 * Armor: "When I conquer, buff me"; Cloth Armor grants [Shield 2]). Those need
 * per-card wiring rather than one table, and until they exist those cards are
 * WEAKER than printed, never stronger.
 */
const EQUIP_MIGHT_BONUS: Record<string, number> = {
  "SFD-009": 0, // Serrated Dirk
  "SFD-016": 0, // Recurve Bow
  "SFD-022": 2, // Long Sword
  "SFD-030": 2, // Skyfall of Areion
  "SFD-033": 1, // Doran's Shield
  "SFD-042": 1, // Brutalizer
  "SFD-051": 1, // Guardian Angel
  "SFD-056": 3, // Sterak's Gage
  "SFD-059": 0, // Svellsongur
  "SFD-064": 0, // Cloth Armor
  "SFD-073": 1, // Experimental Hexplate
  "SFD-086": 2, // World Atlas
  "SFD-090": 2, // The Zero Drive
  "SFD-095": 2, // Doran's Blade
  "SFD-102": 1, // Hexdrinker
  "SFD-108": 1, // Warmog's Armor
  "SFD-115": 2, // Trinity Force
  "SFD-118": 2, // Boneshiver
  "SFD-124": 1, // Doran's Ring
  "SFD-133": 2, // Boots of Swiftness
  "SFD-134": 1, // Cull
  "SFD-139": 2, // Edge of Night
  "SFD-150": 2, // Last Rites
  "SFD-153": 0, // Eye of the Herald
  "SFD-161": 3, // B.F. Sword
  "SFD-172": 1, // Sacred Shears
  "SFD-178": 4, // Blade of the Ruined King
  "SFD-186": 3, // Spinning Axe
  "SFD-190": 3, // Forgefire Cape
  "SFD-191": 3, // Rabadon's Deathcrown
  "SFD-192": 2, // Shurelya's Requiem
};

/**
 * The `[Equip]` cost printed immediately after the keyword — e.g.
 * "[Equip] :rb_energy_1::rb_rune_fury:". Energy is optional and at most one
 * rune symbol follows it.
 *
 * **Deliberately does NOT match the two COMPOUND costs**, and that exclusion is
 * the point rather than a gap in the regex. Last Rites reads "[Equip] —
 * :rb_rune_chaos:, Recycle 2 cards from your trash" and Blade of the Ruined
 * King "[Equip] — :rb_rune_order:, Kill a friendly unit": both have a second,
 * non-rune half. A pattern loose enough to take the rune out of those would
 * hand each card an ability costing ONLY the rune, i.e. strictly CHEAPER than
 * printed — the one direction this codebase never ships. They are reported
 * unparsed instead, and pinned by a test so the exclusion cannot become
 * accidental. Both extras (`recycleFromTrash`, `killFriendlyPermanent`) already
 * exist as activation costs, so wiring them is a per-card job, not a parser one.
 */
const EQUIP_COST_PATTERN = /\[Equip\]\s*(?::rb_energy_(\d+):)?\s*:rb_rune_([a-z]+):/i;

/**
 * What a Gear's `[Equip]` ability costs, or undefined if it prints none.
 *
 * Parsed rather than tabulated, which is what makes the 25 single-domain
 * Equipment need no per-card code at all: the cost parses, the attach ability is
 * generic, done. `rainbow` is carried through as itself rather than mapped to a
 * Domain, because "any domain" is not a domain — `Colorless` is a real printed
 * identity and conflating the two would let a Colorless rune pay a rainbow cost
 * and nothing else.
 */
export function parseEquipCost(plain: string): { energy: number; domain: Domain | "rainbow"; count: number } | undefined {
  const match = EQUIP_COST_PATTERN.exec(plain);
  if (!match) return undefined;
  const energy = match[1] ? Number.parseInt(match[1], 10) : 0;
  const rune = match[2]!.toLowerCase();
  if (rune === "rainbow") return { energy, domain: "rainbow", count: 1 };
  const capitalized = rune.charAt(0).toUpperCase() + rune.slice(1);
  if (!isDomain(capitalized)) return undefined;
  return { energy, domain: capitalized, count: 1 };
}

function shouldSkip(card: RawCard): boolean {
  const { classification, metadata } = card;
  if (classification.type === "Rune" || classification.type === "Battlefield") return true;
  if (classification.supertype === "Token") return true;
  if (classification.rarity === "Showcase") return true;
  return metadata.alternate_art;
}

/** "ogn-001-298" -> "OGN-001". Mirrors CardLoader.java's `deriveId` (registry/CardLoader.java:668-671). */
function deriveId(riftboundId: string): string {
  const parts = riftboundId.split("-");
  return `${parts[0]!.toUpperCase()}-${parts[1]}`;
}

function parseDomains(raw: string[]): Domain[] {
  return raw.map((d) => {
    const capitalized = d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
    if (!isDomain(capitalized)) throw new Error(`Unknown domain in card data: ${d}`);
    return capitalized;
  });
}

function parseKeywords(text: string): Partial<Record<Keyword, number>> {
  const result: Partial<Record<Keyword, number>> = {};
  for (const match of text.matchAll(KW_PATTERN)) {
    const keyword = keywordFromBracketText(match[1]!);
    if (!keyword) continue; // not one of our modeled keywords (e.g. a later-set keyword, or reminder-text noise)
    const magnitude = match[2] ? Number.parseInt(match[2], 10) : 1;
    result[keyword] = Math.max(result[keyword] ?? 0, magnitude);
  }
  return result;
}

/**
 * Cards whose printed text grants "enters ready" as plain prose ("I enter
 * ready.") rather than the bracketed `[Quick]` keyword tag `parseKeywords`
 * looks for — confirmed by direct inspection of each card's raw text
 * (Vanguard Attendant: "I enter ready."; Master Yi - Honed: "[Ganking] I
 * enter ready."; Warwick - Hunter: "I enter ready.When I attack, kill all
 * damaged enemy units here."). Mechanically identical to Quick
 * (execute-play-card.ts's `exhausted: !("Quick" in card.keywords)`), so reuse
 * that existing, already-correct mechanism rather than adding a redundant
 * on-play un-exhaust effect for the same outcome.
 *
 * Warwick carries a SECOND clause, which this does not cover — his attack
 * trigger lives in unit-triggers.ts's ON_ATTACK_TRIGGERS. Registration is per
 * defId, so a card with two clauses reports as done when one is written; both
 * of his are.
 */
const QUICK_TEXT_OVERRIDES = new Set([
  "OGS-016", // Vanguard Attendant — "I enter ready."
  "OGS-009", // Master Yi - Honed — "[Ganking] I enter ready."
  "OGN-159", // Warwick - Hunter — "I enter ready.When I attack, kill all damaged enemy units here."
  // SFD. Of the five Spiritforged cards printing "I enter ready", this is the
  // only UNCONDITIONAL one, so it is the only one that belongs here — the other
  // four read "I enter ready IF ...", and an override would turn each of them
  // into a strictly better card that enters ready unconditionally. They are
  // listed in card-loader.test.ts's CONDITIONAL map instead.
  "SFD-006", // Eager Drakehound — "I enter ready.", the same shape as Vanguard Attendant
]);

/**
 * Cards whose bracketed keywords are CONDITIONAL, so parsing them as printed
 * keywords makes the card strictly better than it reads.
 *
 * "While I'm buffed, I have [Ganking]" and "If you've discarded a card this
 * turn, I have [Assault] and [Ganking]" both put a real keyword inside a
 * condition, and the parser can only see the brackets. All three of these were
 * shipping with their keywords permanently on — Bilgewater Bully could move
 * battlefield-to-battlefield with no buff, Raging Soul attacked at +1 having
 * discarded nothing.
 *
 * The keywords are granted at runtime instead, under the real condition, by
 * engine/granted-keywords.ts. A named per-card set rather than a parser that
 * tries to understand conditions — the same choice, for the same reason, as
 * HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS above.
 */
const CONDITIONAL_KEYWORD_DEF_IDS = new Set([
  "OGN-019", // Raging Soul — [Assault] and [Ganking] only once you've discarded
  "OGN-125", // Bilgewater Bully — [Ganking] only while buffed
  "OGN-232", // Fiora - Victorious — [Deflect]/[Ganking]/[Shield] only while Mighty
  // Udyr - Wildman — a fourth of the same shape, and the widest yet: "[Ganking]"
  // appears inside one of four MODES he has to spend a buff to choose, so he was
  // shipping able to move battlefield-to-battlefield all game for free. He is
  // the only one here whose grant is not a CONDITIONAL_GRANTS entry — his own
  // ability writes it to `keywordsThisTurn` when that mode is taken.
  "OGN-157",
]);

/**
 * Keywords a card's text mentions only because it GRANTS them to other
 * permanents — "Other friendly units here have [Assault]" is a statement about
 * the neighbours, and the parser can only see the brackets.
 *
 * Per KEYWORD rather than per card, which `CONDITIONAL_KEYWORD_DEF_IDS` above
 * could not be: **Taric - Protector prints `[Shield]` AND grants `[Shield]`** in
 * the same text, so stripping the card wholesale would take his real one with it.
 * The same reason Gemcraft Seer is absent here — her `[Vision]` is printed and
 * granted, and both are true of her.
 *
 * Measured across the whole pool rather than assumed, by scanning for text that
 * grants a bracketed keyword to other objects: **four cards match and exactly two
 * are false positives.** Captain Farron's was a live bug — he has been swinging
 * with an `[Assault]` he does not print, which is the third instance of this
 * shape after `HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS` and `CONDITIONAL_KEYWORD_DEF_IDS`,
 * and the second found by writing a test rather than by reading the card.
 *
 * Spirit's Refuge's is inert today — `deflectSurchargeForTargets` looks up units
 * and a gear is not one, so nothing charges for choosing it — but it is a lie in
 * the data either way, and `coverage.ts`'s own comment has been noting that it
 * "parses a `Deflect` it does not have and only grants" without anything acting
 * on it.
 *
 * The grants themselves live in engine/granted-keywords.ts's `KEYWORD_AURAS`.
 */
const GRANTED_ONLY_KEYWORDS: Readonly<Record<string, readonly Keyword[]>> = {
  "OGN-015": ["Assault"], // Captain Farron — "Other friendly units here have [Assault]"
  "OGN-063": ["Deflect"], // Spirit's Refuge — "Friendly buffed units have [Deflect]"
  // Ancient Warmonger — "I have [Assault] equal to the number of enemy units
  // here."
  //
  // **The keyword is his OWN, not a neighbour's**, which is a fourth shape for
  // this table rather than a third instance of the first: the two entries above
  // strip a keyword a card gives to somebody else, and this strips one the card
  // gives to ITSELF at a value only the board can supply. What both cases have
  // in common is the only thing this table acts on — a bracket the parser saw
  // that is not a FLAT PRINTED keyword, and that something at runtime is
  // responsible for instead.
  //
  // It cannot go in `CONDITIONAL_KEYWORD_DEF_IDS` above, which returns `{}` and
  // would take his real printed `[Accelerate]` with it. Per-keyword is the whole
  // reason this table exists separately — Taric's entry records the same
  // constraint from the other direction.
  //
  // Left in, he had a flat `[Assault 1]` floor: `effectiveKeywords` merges the
  // computed value with `Math.max`, so a Warmonger facing an EMPTY battlefield
  // swung at +1 for an ability that reads "equal to the number of enemy units
  // here" — i.e. equal to zero. The runtime value lives in
  // `granted-keywords.DYNAMIC_KEYWORD_VALUES`.
  "SFD-131": ["Assault"],
};

/** A card's printed keywords: what the brackets say, minus the ones it only
 *  grants, and nothing at all for a card whose keywords are conditional. */
function printedKeywords(id: string, plain: string): Partial<Record<Keyword, number>> {
  if (CONDITIONAL_KEYWORD_DEF_IDS.has(id)) return {};
  const parsed = parseKeywords(plain);
  for (const keyword of GRANTED_ONLY_KEYWORDS[id] ?? []) delete parsed[keyword];
  return parsed;
}

/**
 * The cards whose printed text the LOADER implements, by turning it into a
 * keyword the rules engine already honors.
 *
 * These are genuinely implemented — "I enter ready." is fully handled — but the
 * implementation is a parse-time keyword rather than a registered effect, so
 * coverage.ts has no other way to know. POWER_DOMAIN_ALT_OVERRIDES is
 * deliberately NOT included: a split Power pip is card data, not rules text, so
 * it never made the card look inert in the first place.
 */
export function loaderHandledDefIds(): string[] {
  return [...QUICK_TEXT_OVERRIDES];
}

/**
 * Does this card CARRY `[Hidden]`, as opposed to merely mentioning it?
 *
 * Exported for the test that pins the defId key. That key's whole value is a
 * case the loaded pool cannot show — a card at a new defId carrying a name one
 * of the four false positives already uses — so the only way to exercise it is
 * to call this with a synthetic pair. Under the old NAME key that case was
 * unrepresentable, which is why it went unnoticed.
 */
export function isGenuinelyHidden(plain: string, id: string): boolean {
  return plain.includes("[Hidden]") && !HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS.has(id);
}

/**
 * Decodes the HTML entities the upstream export leaves in `text.plain`.
 *
 * `plain` is supposed to be the de-tagged twin of `text.rich`, and mostly is —
 * but the de-tagging does not decode entities, so a card whose rules text
 * contains a quotation mark arrives carrying a literal `&quot;`. Four
 * occurrences across two SFD cards today (Relentless Pursuit and the Forge of
 * the Fluft battlefield); OGN and OGS have none, which is why nothing has
 * needed this before.
 *
 * It matters because this string is what RENDERS. Battlefield rules text is
 * drawn on the board, so `friendly legends have &quot;[Exhaust]: ...&quot;`
 * is visible to a player mid-game. It is also the string every keyword and
 * text-scanning gate in this repo reads.
 *
 * Done in the LOADER rather than by patching the JSON, deliberately: the card
 * files are upstream snapshots, and a hand-edit to one is silently undone by
 * the next data refresh — which is the recorded reason ogn.json's six mojibaked
 * apostrophes were left in place rather than corrected in the file.
 */
function decodeTextEntities(plain: string): string {
  return plain
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // `&amp;` LAST, so "&amp;quot;" decodes to the literal "&quot;" it encodes
    // rather than being re-decoded into a bare quote by an earlier pass.
    .replace(/&amp;/g, "&");
}

/**
 * Cards whose printed text names a keyword **without its brackets**, with the
 * defId mapped to the keywords affected.
 *
 * Two SFD cards do this, confirmed against the raw JSON rather than inferred —
 * the upstream data really is missing the brackets, `rich` and `plain` agree,
 * and neither is anything this loader did to them:
 *
 *   SFD-096 Laurent Bladekeeper — "Ganking (I can move from battlefield to
 *   battlefield.)"
 *   SFD-138 Windsinger — "Hidden (Hide now for ... to react with later ...)"
 *
 * **Both halves of this go wrong, and in opposite directions.** `parseKeywords`
 * only reads `[Bracketed]` tokens, so the unit does not HAVE the keyword —
 * Laurent could not move and Windsinger was not hidden, silently, with nothing
 * to see. And `coverage.implementableText` only strips BRACKETED keywords, so
 * the bare word survived as residue and the card reported as needing an
 * implementation — which would have sent someone to write "Ganking" as a card
 * effect, duplicating a keyword the engine already has.
 *
 * The fix is to BRACKET the word in the stored text, once, here. Everything
 * downstream — `parseKeywords`, `implementableText`, the deck builder, the
 * board's rules text — then sees the card the way every other card in the pool
 * is written, and none of them needs to know about the exception. Fixing it as
 * two separate tables (grant the keyword; suppress the residue) would have been
 * two things to keep in step.
 *
 * **Nothing else in the repo could have caught these.** The bracket sweep in
 * coverage-drift asks whether a bracketed token is known, and there is no
 * bracket here to be unknown. `keyword-prose.test.ts` is the guard for this
 * direction, and it is what will name the next one.
 *
 * This is the same problem `QUICK_TEXT_OVERRIDES` solves for "I enter ready",
 * and deliberately not merged with it: that table is about a card describing a
 * keyword's EFFECT in its own prose, while this one is about a card printing
 * the keyword's own NAME and losing the brackets in the data.
 */
const PROSE_KEYWORD_DEF_IDS: Record<string, readonly Keyword[]> = {
  "SFD-096": ["Ganking"], // Laurent Bladekeeper
  "SFD-138": ["Hidden"], // Windsinger
};

/** The defIds above, for the test that pins each entry to a card whose text
 *  really does print the bare keyword. Exported rather than the table, on the
 *  same reasoning as `hiddenKeywordFalsePositiveDefIds`. */
export function proseKeywordDefIds(): string[] {
  return Object.keys(PROSE_KEYWORD_DEF_IDS);
}

/** Rewrites a bare keyword name into its bracketed form, so the rest of the
 *  pipeline sees an ordinary card. Only the FIRST occurrence, and only for the
 *  keywords named for this defId — a blanket "bracket every keyword word you
 *  see" would rewrite Ember Monk's "play a card with [Hidden]" prose and every
 *  other card that MENTIONS a keyword without having it. */
function bracketProseKeywords(id: string, plain: string): string {
  let text = plain;
  for (const keyword of PROSE_KEYWORD_DEF_IDS[id] ?? []) {
    text = text.replace(new RegExp(`(^|[^\\[\\w])(${keyword})\\b`, "i"), (_m, before: string) => `${before}[${keyword}]`);
  }
  return text;
}

function parseCardDefinition(card: RawCard): CardDefinition {
  const id = deriveId(card.riftbound_id);
  const name = card.name.replace(" (Starter)", "");
  const domains = parseDomains(card.classification.domain);
  const plain = bracketProseKeywords(id, decodeTextEntities(card.text.plain ?? ""));
  const imageUrl = card.media.image_url ?? "";
  const energyCost = card.attributes.energy ?? 0;
  const powerCost = card.attributes.power ?? 0;
  const powerDomain = powerCost > 0 ? lowestOrdinalDomain(domains) : null;
  const powerDomainAlt = powerCost > 0 ? POWER_DOMAIN_ALT_OVERRIDES[id] : undefined;

  switch (card.classification.type) {
    case "Legend":
      return {
        type: "Legend",
        id,
        name,
        domains,
        powerDomain: null,
        imageUrl,
        championTag: name.split(/\s+/)[0]!.toUpperCase(),
        // Was omitted, which made every Legend's printed ability invisible to
        // coverage.ts — see CardDefinitionBase.text.
        text: plain,
      };
    case "Unit": {
      const legionMatch = LEGION_DISCOUNT_PATTERN.exec(plain);
      return {
        type: "Unit",
        id,
        name,
        domains,
        powerDomain,
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
        imageUrl,
        energyCost,
        powerCost,
        might: card.attributes.might ?? 0,
        isChampion: card.classification.supertype === "Champion",
        keywords: {
          ...printedKeywords(id, plain),
          ...(QUICK_TEXT_OVERRIDES.has(id) ? { Quick: 1 } : {}),
        },
        legionDiscount: legionMatch ? Number.parseInt(legionMatch[1]!, 10) : 0,
        hidden: isGenuinelyHidden(plain, id),
        isReaction: plain.includes("[Reaction]"),
        tags: card.tags ?? [],
        text: plain,
      };
    }
    case "Spell":
      return {
        type: "Spell",
        id,
        name,
        domains,
        powerDomain,
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
        imageUrl,
        energyCost,
        powerCost,
        isReaction: plain.includes("[Reaction]"),
        isAction: plain.includes("[Action]"),
        hidden: isGenuinelyHidden(plain, id),
        text: plain,
      };
    case "Gear":
      return {
        type: "Gear",
        id,
        name,
        domains,
        powerDomain,
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
        imageUrl,
        energyCost,
        powerCost,
        keywords: printedKeywords(id, plain),
        isReaction: plain.includes("[Reaction]"),
        hidden: isGenuinelyHidden(plain, id),
        // The three Equipment fields. Two are parsed and one is a table,
        // because the badge is art-only data no parser can reach.
        ...(parseEquipCost(plain) !== undefined ? { equipCost: parseEquipCost(plain)! } : {}),
        ...(EQUIP_MIGHT_BONUS[id] !== undefined ? { equipMightBonus: EQUIP_MIGHT_BONUS[id] } : {}),
        // The rules' own marker for what `[Weaponmaster]` and Angle Shot mean
        // by "an Equipment", and it really is a printed tag — every one of the
        // 29 Gear printing `[Equip]` carries it, measured.
        ...((card.tags ?? []).includes("Equipment") ? { isEquipment: true } : {}),
        text: plain,
      };
    case "Rune":
    case "Battlefield":
      throw new Error(`${card.classification.type} cards should have been filtered out by shouldSkip()`);
  }
}

/** Every non-skipped CardDefinition from the in-scope card files (Origins + Proving Grounds). */
export function loadCardDefinitions(): CardDefinition[] {
  const defs: CardDefinition[] = [];
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (shouldSkip(item)) continue;
      defs.push(parseCardDefinition(item));
    }
  }
  return defs;
}

/**
 * One real (non-alternate-art) rune image per domain — Rune-type cards are
 * deliberately excluded from `loadCardDefinitions` (they're never a
 * playable CardDefinition), but their art is still needed for display.
 * Mirrors CardLoader.loadRuneArt (registry/CardLoader.java:224-238), the
 * same "presentation-only side lookup, not a real CardDefinition" pattern.
 */
export function loadRuneArt(): Partial<Record<Domain, string>> {
  const art: Partial<Record<Domain, string>> = {};
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.type !== "Rune") continue;
      if (item.metadata.alternate_art) continue;
      const domains = parseDomains(item.classification.domain);
      const domain = domains[0];
      const imageUrl = item.media.image_url;
      if (domain && imageUrl && !art[domain]) art[domain] = imageUrl;
    }
  }
  return art;
}

/**
 * Art for the runtime-only tokens this engine creates, keyed by the defId
 * token.ts stamps on them. Token-supertype cards are filtered out of the
 * loaded pool entirely (they're never playable cards, and the printed
 * "Recruit (271) // Buff" entries are three near-identical copies), so a
 * created token has no CardDefinition to look art up from and would otherwise
 * render as a blank fallback frame. Same presentation-only side-lookup
 * pattern as loadRuneArt above, and the same one CardLoader.java:677 uses for
 * exactly this card's tokens.
 */
export function loadTokenArt(): Partial<Record<string, string>> {
  const art: Partial<Record<string, string>> = {};
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.supertype !== "Token") continue;
      if (item.metadata.alternate_art) continue;
      if (!/^Recruit\b/.test(item.name)) continue;
      const imageUrl = item.media.image_url;
      if (imageUrl && !art["TOKEN-RECRUIT"]) art["TOKEN-RECRUIT"] = imageUrl;
    }
  }
  return art;
}

export interface BattlefieldDefinition {
  id: string;
  name: string;
  imageUrl: string;
  text: string;
  domains: Domain[];
}

/** A printed TOKEN card. Same shape as a battlefield's, and here for the same
 *  reason: `shouldSkip` keeps Token-supertype entries out of the playable pool,
 *  but they are real printed cards with real rules text. */
export interface TokenDefinition {
  id: string;
  /** The synthetic runtime defId a created token carries — `TOKEN-GOLD` for
   *  "Gold // Buff" — so a token instance on the board can be traced back to
   *  the card it is a copy of. Matches `token.ts`'s `TOKEN-${tag}` convention,
   *  which predates this and which `setCodeOf("TOKEN-RECRUIT")` already pins. */
  runtimeDefId: string;
  name: string;
  imageUrl: string;
  text: string;
  type: string;
}

/**
 * Real Token-supertype cards (name, art, rules text).
 *
 * These are excluded from `loadCardDefinitions` by `shouldSkip` for a good
 * reason — a token is never in a deck and never played from hand, so it has no
 * business in a deckbuilding pool — but "not deckbuildable" is not "not real",
 * and the pool has exactly the same blind spot for tokens that it had for
 * battlefields: **nothing could see one.**
 *
 * SFD is what forces the issue. Its Gold token is a GEAR with a printed
 * activated ability ("Kill this, [Exhaust]: [Reaction] — [Add] rainbow"), and
 * eleven SFD cards plus two SFD battlefields say "play a Gold gear token". That
 * ability has to be implemented somewhere and keyed by something, and keying it
 * to a card no measurement can see is how `[Deflect]` shipped inert.
 *
 * So this is the source `coverage-drift`'s "no module claims a card that isn't
 * real" check consults for token ids, exactly as it already consults
 * `loadBattlefieldDefinitions()` for battlefield ids — that test's own comment
 * makes the argument: "'Real' is not the same as 'in the CardRegistry'."
 */
export function loadTokenDefinitions(): TokenDefinition[] {
  const seen = new Set<string>();
  const defs: TokenDefinition[] = [];
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.supertype !== "Token") continue;
      if (item.metadata.alternate_art) continue;
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      // "Gold // Buff" is one printed card carrying two faces; the gear face is
      // the one cards create, and its tag is the first name. Splitting on "//"
      // rather than storing the whole string keeps the runtime defId readable
      // and matches how the cards refer to it ("a Gold gear token").
      const face = item.name.split("//")[0]!.trim();
      defs.push({
        id: deriveId(item.riftbound_id),
        runtimeDefId: `TOKEN-${face.toUpperCase()}`,
        name: item.name,
        imageUrl: item.media.image_url ?? "",
        text: decodeTextEntities(item.text.plain ?? ""),
        type: item.classification.type,
      });
    }
  }
  return defs;
}

/**
 * Real Battlefield-type cards (name, art, rules text) — like Rune-type
 * cards, Battlefields are deliberately excluded from `loadCardDefinitions`
 * (`shouldSkip` above; `BattlefieldState` carries no per-name ability yet,
 * so there's no playable CardDefinition to build), but a deck builder
 * still wants to offer real, named battlefields to pick from rather than
 * only free text. Same "presentation-only side lookup, not a real
 * CardDefinition" pattern as `loadRuneArt`.
 */
export function loadBattlefieldDefinitions(): BattlefieldDefinition[] {
  const seen = new Set<string>();
  const defs: BattlefieldDefinition[] = [];
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.type !== "Battlefield") continue;
      if (item.metadata.alternate_art) continue;
      if (seen.has(item.name)) continue;
      const imageUrl = item.media.image_url;
      if (!imageUrl) continue;
      seen.add(item.name);
      defs.push({
        id: deriveId(item.riftbound_id),
        name: item.name,
        imageUrl,
        // Entity-decoded on the same reasoning as parseCardDefinition's, and
        // this is the path where it is most visible: battlefield rules text is
        // rendered on the board, so Forge of the Fluft's `&quot;` is something
        // a player reads mid-game.
        text: decodeTextEntities(item.text.plain ?? ""),
        domains: parseDomains(item.classification.domain),
      });
    }
  }
  return defs;
}
