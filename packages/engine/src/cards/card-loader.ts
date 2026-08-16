import ognRaw from "./ogn.json" with { type: "json" };
import ogsRaw from "./ogs.json" with { type: "json" };
import sfdRaw from "./sfd.json" with { type: "json" };
import unlRaw from "./unl.json" with { type: "json" };
import venRaw from "./ven.json" with { type: "json" };
import type { Domain } from "../model/domain.js";
import { isDomain, lowestOrdinalDomain } from "../model/domain.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import type { CardDefinition } from "../model/card-definition.js";
import { extractCardItems, type RawCard } from "./raw-card-schema.js";

/**
 * Card pool in scope: Origins (OGN) + Proving Grounds (OGS) + Spiritforged
 * (SFD) + Unleashed (UNL). All four sets the oracle has are now loaded.
 *
 * `sfd.json` was taken byte-for-byte from the frozen Java oracle
 * (A:\Projects\riftbound-engine\src\main\resources\cards\sfd.json), the same
 * provenance as ogn.json/ogs.json. 288 raw entries, of which `shouldSkip`
 * keeps 206; the other 82 are 15 Battlefields, 66 Showcase/alternate-art
 * prints and 1 Token. 206 + 15 = the set's printed 221.
 *
 * `unl.json` has the same provenance, byte-for-byte, and landed 2026-08-08.
 * **280 raw entries, of which `shouldSkip` keeps 235** — the other 45 are 15
 * Battlefields and 30 alternate-art prints, with no Token and no Showcase
 * rarity at all. Kept: 126 Units, 54 Spells, 19 Gear, 36 Legends.
 *
 * **Two things about this set that the other three do not prepare you for**,
 * both measured against the file rather than inferred:
 *
 *   **36 Legends is 12 legends printed three times.** Every UNL legend has a
 *   plain printing, an "(Overnumbered)" one and a "(Signature)" one, with
 *   identical rules text. The Signature prints carry an ASTERISK in their
 *   collector number, so `deriveId` yields ids of the form `UNL-236*`. That is
 *   the first id in this pool that is not `[A-Z]{3}-\d+`, and it is a real id
 *   rather than something to strip: all 235 derived ids are distinct.
 *
 *   **It is the first set to bring HTML entities in VOLUME.** The raw
 *   `text.plain` holds `&gt;` 49 times and `&quot;` 10 times. `decodeTextEntities`
 *   below already handles both — it was written for SFD's two `&quot;` — so by
 *   the time anything downstream reads the text these are a bare `>` and `"`.
 *   That is why NON_KEYWORD_BRACKETS names the arrow as `>` and NOT as `&gt;`:
 *   the escaped spelling never reaches a gate, and allow-listing it would have
 *   matched nothing while looking deliberate.
 *
 * Note it is a BARE ARRAY, like ogn.json and sfd.json and unlike ogs.json's
 * paginated `{items}` envelope — `extractCardItems` already reads both. Like
 * sfd.json it carries no BOM.
 *
 * Statically imported (not read via `fs` at runtime) so this module works
 * unmodified in both Node and a bundled browser build (e.g. packages/web) —
 * a real constraint discovered building the web board, not a preference:
 * `fs`/`node:path` can't be bundled for the browser at all, and Rollup
 * fails the build outright if anything in the module graph imports them
 * unconditionally, even if the function that uses them is never called
 * client-side.
 */
/**
 * **Vendetta (VEN) is the first set NOT copied from the oracle**, which holds
 * only ogn/ogs/sfd/unl. It is generated from the Riftcodex API by
 * `tools/card-data/fetch-set.mjs`, and it is the first card file here that is
 * PARTIAL BY CONSTRUCTION — 209 of the set's 227 cards.
 *
 * The API serves VEN as two live ingests, and only the reconciled records carry
 * trustworthy `alternate_art`/`overnumbered` flags. The generator writes every
 * record whose printing status the data determines and drops the 18 it cannot.
 *
 * **The MAIN SET is complete**: all 166 collector numbers, no gaps, no duplicate
 * names, and all 9 main-set Legends reconciled — which is the one thing that had
 * to hold, since the old ingest drops a Legend's champion prefix and
 * `championTag` is the first word of the name.
 *
 * Missing are 17 alternate printings and `ven-sp1`, pinned by id in
 * `test/ven-partial-set.test.ts`. **VEN is deliberately NOT in `COMPLETE_SETS`**
 * and must not be added until the generator drops nothing — the gate is
 * `node tools/card-data/set-audit.mjs VEN`.
 */
const CARD_FILES: readonly unknown[] = [ognRaw, ogsRaw, sfdRaw, unlRaw, venRaw];

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

/**
 * `[Reaction]` that a card only MENTIONS, and does not have unconditionally.
 *
 * `isReaction` is parsed as `plain.includes("[Reaction]")`, and `[Ambush]`'s
 * reminder text is "(You may play me as a **[Reaction]** to a battlefield where
 * you have units.)" — so every Ambush card came out of the loader with
 * unconditional Reaction timing.
 *
 * **That is STRONGER than printed, and it hid a second bug that was weaker.**
 * 822.1.b grants Reaction only "as long as I'm being played to a battlefield
 * where you control Units", so an Ambush card could be played to BASE at reaction
 * speed, which the keyword does not permit — while at the same time it could not
 * reach the garrisoned battlefield the keyword exists for, because 813 narrows
 * Showdown destinations to battlefields you CONTROL. Too strong and too weak at
 * once, from one parse.
 *
 * The real permission is destination-dependent and lives in
 * `timing.ambushReactionAt`. This strips the flat one so the conditional grant is
 * the only source. Same shape as `GRANTED_ONLY_KEYWORDS` above: a bracket the
 * parser saw that is not a flat printed property.
 *
 * Keyed on the KEYWORD rather than a defId list, because every card printing
 * `[Ambush]` carries the same reminder and a list would need a row per card
 * forever.
 */
function reactionIsOnlyAmbushReminder(plain: string): boolean {
  if (!plain.includes("[Ambush]")) return false;
  // A card could print BOTH — a real [Reaction] and an [Ambush]. Strip only when
  // the sole mention sits inside Ambush's own reminder.
  return plain.split("[Reaction]").length - 1 === 1 && /\[Ambush\][^.]*\[Reaction\]/.test(plain);
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

  // **UNL's nine — CONFIRMED BY INSPECTION 2026-08-08**, each `media.image_url`
  // pulled and its pip cropped and read at 6x. Every one is a single capsule
  // split left/right into its two domains' colours, and in all nine the glyph
  // count equals the printed Power cost (four of them are 2-Power, which is the
  // case the colour-count trap bites).
  //
  // **The pool-wide pattern is now 35 of 35, across four sets, with no
  // exception**, and the project owner confirmed the rule it implies: a card
  // printing two domains in its cast cost can have its Power pip paid by
  // recycling EITHER of those domains. So this table is, today, exactly "alt =
  // the higher-ordinal of the card's two domains" for every dual-domain card
  // with a Power cost — see the note below on why it is still a table.
  "UNL-184": "Body", // Thrill of the Hunt — Fury/Body
  "UNL-186": "Chaos", // Death from Below — Fury/Chaos
  "UNL-190": "Mind", // Lilting Lullaby — Calm/Mind
  "UNL-192": "Body", // Alpha Strike — Calm/Body
  "UNL-196": "Order", // Daisy! — Calm/Order (a Unit, not a Spell — the only one)
  "UNL-198": "Chaos", // Moonfall — Mind/Chaos
  "UNL-200": "Order", // Mirror Image — Mind/Order
  "UNL-202": "Chaos", // Void Assault — Body/Chaos
  "UNL-204": "Order", // Keeper's Verdict — Body/Order

  // **Vendetta's six — CONFIRMED BY INSPECTION 2026-08-16**, each
  // `media.image_url` pulled and its pip cropped and read side by side. All six
  // are the same single capsule split left/right into their two printed domains'
  // colours, each holding ONE glyph against a printed Power cost of 1:
  //
  //   Shuriken Flip     red|green    Fury|Calm
  //   Death Mark        red|purple   Fury|Chaos
  //   Shadow Dash       green|yellow Calm|Order
  //   Acceleration Gate blue|orange  Mind|Body
  //   Rebuttal          blue|purple  Mind|Chaos
  //   Public Execution  orange|yellow Body|Order
  //
  // **The pool-wide pattern is now 41 of 41 across five sets with no exception**,
  // and the alt is again the higher-ordinal of the card's two domains — which is
  // simply `domains[1]` here, since the export lists them lowest-ordinal first.
  // The note below on why this stays a hand table is unchanged by that: the split
  // is a fact about the art that no field carries, and a sixth set could print a
  // solid dual-domain pip that a derivation would silently widen.
  "VEN-140": "Calm", // Shuriken Flip — Fury/Calm
  "VEN-144": "Chaos", // Death Mark — Fury/Chaos
  "VEN-148": "Order", // Shadow Dash — Calm/Order
  "VEN-150": "Body", // Acceleration Gate — Mind/Body
  "VEN-152": "Chaos", // Rebuttal — Mind/Chaos
  "VEN-154": "Order", // Public Execution — Body/Order
};

/**
 * **Why this is still a hand table when the rule would derive it.**
 *
 * All 35 entries are now "the higher-ordinal of the card's two domains", so
 * `powerDomainAlt = domains[1]` for every dual-domain card with a Power cost
 * would reproduce this table exactly, and would absorb the next set for free.
 *
 * It is deliberately not done yet, and the reason is what the table is FOR. The
 * split pip is a fact about the printed card that no field of the JSON carries —
 * it is in the art — and the 35/35 pattern is evidence about the cards printed
 * so far, not a rule this loader can check. Deriving it would silently grant an
 * alt domain to a future solid-pip card and make a cost payable that is not, and
 * nothing in the pipeline could see it: a too-wide Power domain never fails, it
 * just accepts a rune it should have refused.
 *
 * The census in card-loader.test.ts is the thing that makes the table cheap —
 * a new set's candidates arrive as a NAMED failure, which is one inspection per
 * set rather than a standing cost. Collapse this to a derivation only if the
 * rules text (not the pattern) says every dual-domain pip is split.
 */

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

  // **UNL's five, read off the art 2026-08-08**, the same way SFD's were and for
  // the same reason: `attributes.might` is null on all five and the badge is in
  // no text field. Every one of them carries a bonus, so the set added no
  // 0-badge Equipment.
  "UNL-019": 4, // Blighted Battleaxe
  "UNL-039": 1, // Soul Sword
  "UNL-096": 2, // Hunter's Machete
  "UNL-158": 2, // Shepherd's Heirloom
  "UNL-188": 3, // Hextech Gauntlets
};

/**
 * The `[Equip]` cost printed immediately after the keyword — e.g.
 * "[Equip] :rb_energy_1::rb_rune_fury:". Energy is optional and at most one
 * rune symbol follows it.
 *
 * **The two COMPOUND costs are matched by a SECOND pattern, not by loosening
 * this one**, and that is still the same rule rather than a reversal of it.
 * Last Rites reads "[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash"
 * and Blade of the Ruined King "[Equip] — :rb_rune_order:, Kill a friendly
 * unit". Loosening this pattern would have taken the rune out of both and handed
 * each an ability costing ONLY the rune — strictly CHEAPER than printed, the one
 * direction this codebase never ships. So the extra half is READ rather than
 * discarded: a card matches here only when nothing follows the rune, and
 * `EQUIP_EXTRA_PATTERNS` below claims the rest.
 *
 * The `(?!,)` is what enforces that. Without it this pattern would match the
 * rune in both compound costs and win, because it is tried first.
 */
const EQUIP_COST_PATTERN = /\[Equip\]\s*[\u2014\u2013-]?\s*(?::rb_energy_(\d+):)?\s*:rb_rune_([a-z]+):(?!,)/i;

/**
 * The SECOND half of a compound `[Equip]` cost, keyed by what it costs.
 *
 * Both extras already existed as `ActivationCost` fields — `recycleFromTrash`
 * takes a count and `killFriendlyPermanent` a boolean — so this is a parser
 * change plus one line of wiring rather than a new cost model, exactly as the
 * old comment here predicted.
 *
 * A pattern per shape rather than one general clause parser: there are two of
 * them in the whole pool, and a general "read the English after the comma"
 * reader is the kind of speculation this codebase refuses. A third card gets a
 * third entry.
 */
const EQUIP_EXTRA_PATTERNS: { pattern: RegExp; extra: (m: RegExpExecArray) => EquipExtraCost }[] = [
  {
    // "Recycle 2 cards from your trash"
    pattern: /,\s*Recycle\s+(\d+)\s+cards?\s+from\s+your\s+trash/i,
    extra: (m) => ({ recycleFromTrash: Number.parseInt(m[1]!, 10) }),
  },
  {
    // "Kill a friendly unit"
    pattern: /,\s*Kill\s+a\s+friendly\s+unit/i,
    extra: () => ({ killFriendlyPermanent: true }),
  },
];

/** The non-rune half of a compound `[Equip]` cost. Mirrors the `ActivationCost`
 *  fields it becomes, so wiring is a spread rather than a translation. */
export type EquipExtraCost = { recycleFromTrash?: number; killFriendlyPermanent?: true };

/** The rune half of a COMPOUND `[Equip]` cost — the same shape as the simple
 *  pattern, but requiring the comma that the simple one refuses. */
const EQUIP_COMPOUND_RUNE = /\[Equip\]\s*[\u2014\u2013-]?\s*(?::rb_energy_(\d+):)?\s*:rb_rune_([a-z]+):(?=,)/i;

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
export function parseEquipCost(
  plain: string,
): { energy: number; domain: Domain | "rainbow"; count: number; extra?: EquipExtraCost } | undefined {
  // The simple pattern first; it refuses a rune followed by a comma, so a
  // compound cost falls through to the branch below rather than being
  // half-read. Getting that order wrong is what would make both compound cards
  // cheaper than printed.
  const simple = EQUIP_COST_PATTERN.exec(plain);
  if (simple) return runeCost(simple);

  const compound = EQUIP_COMPOUND_RUNE.exec(plain);
  if (!compound) return undefined;
  const base = runeCost(compound);
  if (base === undefined) return undefined;
  for (const { pattern, extra } of EQUIP_EXTRA_PATTERNS) {
    const match = pattern.exec(plain);
    if (match) return { ...base, extra: extra(match) };
  }
  // A compound cost whose second half nothing here recognises is reported
  // UNPARSED rather than as the rune alone — the original refusal, kept for the
  // case it was written for. Half a cost is cheaper than the printed one.
  return undefined;
}

/** The rune-and-Energy half, shared by both branches above so the two cannot
 *  disagree about what a domain is. */
function runeCost(match: RegExpExecArray): { energy: number; domain: Domain | "rainbow"; count: number } | undefined {
  const energy = match[1] ? Number.parseInt(match[1], 10) : 0;
  const rune = match[2]!.toLowerCase();
  if (rune === "rainbow") return { energy, domain: "rainbow", count: 1 };
  const capitalized = rune.charAt(0).toUpperCase() + rune.slice(1);
  if (!isDomain(capitalized)) return undefined;
  return { energy, domain: capitalized, count: 1 };
}

/**
 * `[Flow]`'s printed alternate cost — "Flow [Cost]" (829.1.c).
 *
 * Parsed rather than tabulated, on `parseEquipCost`'s precedent and for the same
 * payoff: **all 15 Vendetta spells printing the keyword are covered with no
 * per-card code**, because every one of them prints Energy followed by runes of
 * a single domain. Measured over the loaded pool rather than assumed —
 * `:rb_energy_4::rb_rune_order::rb_rune_order:` (two Order) and
 * `:rb_energy_5::rb_rune_rainbow::rb_rune_rainbow:` (two rainbow) are the widest
 * shapes, and both are this pattern.
 *
 * A cost this cannot read is reported UNPARSED rather than half-read, which is
 * `parseEquipCost`'s rule and the one direction this codebase never ships: half
 * a cost is CHEAPER than the printed one, and an alternate cost that is too
 * cheap is a card that plays for free out of the trash.
 */
const FLOW_COST_PATTERN = /\[Flow\]\s*(?::rb_energy_(\d+):)?((?::rb_rune_[a-z]+:)*)/i;

export function parseFlowCost(plain: string): { energy: number; powerCost: number; powerDomain: Domain | null } | undefined {
  const match = FLOW_COST_PATTERN.exec(plain);
  if (!match) return undefined;
  // A bare `[Flow]` with no cost at all is not a cost this can price. Both cards
  // that produce one are UNITS referencing the keyword rather than printing it,
  // and they are stripped in GRANTED_ONLY_KEYWORDS — so reaching here means a
  // shape nobody has read, and undefined is the honest answer.
  //
  // The pip reading itself is shared with `[Empower]`, which prints its cost in
  // the same notation immediately after its own bracket. Two readers of one
  // notation is how they come to disagree.
  return costFromPips(match[1], match[2] ?? "");
}

/**
 * `[Empower]`'s printed activation cost — "Empower [Cost]" (827.1.c).
 *
 * Shares `parseFlowCost`'s grammar deliberately: both keywords print a cost
 * immediately after the bracket in the same `:rb_energy_N:` + `:rb_rune_X:`
 * notation, and two readers of one notation is how they come to disagree.
 *
 * **Refuses a COMPOUND cost rather than half-reading it**, which is
 * `parseEquipCost`'s rule and the reason it is stated again here: Vendetta
 * prints six Empower costs of the form "— Discard 1", "— Kill a friendly unit",
 * "— [Exhaust]", and reading only the resource half would make each of those
 * abilities free. Those cards report unimplemented, which is what they are.
 *
 * It also refuses the two costs carrying their own MODIFYING text ("This ability
 * costs [1] less for each rune you control"), for the same reason in the other
 * direction: 827.1.c.3 says such text "is taken into account when determining a
 * card's Empower cost for any reason", so honouring the printed number alone
 * would be too EXPENSIVE and the card would be unplayable at the price it means.
 */
export function parseEmpowerCost(plain: string): { energy: number; powerCost: number; powerDomain: Domain | null } | undefined {
  const at = plain.indexOf("[Empower]");
  if (at < 0) return undefined;
  const after = plain.slice(at + "[Empower]".length);
  const pips = /^\s*(?::rb_energy_(\d+):)?((?::rb_rune_[a-z]+:)*)/i.exec(after);
  if (!pips) return undefined;
  // **A COMPOUND cost has no pips here at all**, because its non-resource half is
  // introduced by an em dash — "[Empower] — Discard 1", "[Empower] — Kill a
  // friendly unit", "[Empower] — :rb_energy_1:, :rb_exhaust:". The dash is not a
  // pip, so nothing matches and `costFromPips` refuses below. That is
  // `parseEquipCost`'s rule: half a cost is CHEAPER than printed.
  //
  // **A SELF-MODIFYING cost is refused explicitly**, and it is the one shape a
  // pip check alone cannot see: "[Empower] :rb_energy_12:. This ability costs
  // :rb_energy_1: less for each rune you control" reads as a clean 12 and is not
  // one. 827.1.c.3 says such text "is taken into account when determining a
  // card's Empower cost for any reason", so honouring 12 alone is too EXPENSIVE
  // and the card is unplayable at the price it actually means.
  const rest = after.slice(pips[0].length);
  if (/^\s*\.\s*This ability costs/i.test(rest)) return undefined;
  // **A COMPOUND cost (827.1.c.2) is read term by term, not refused wholesale.**
  // The em dash introduces the non-resource half, and every term in it is a cost
  // this engine already has an `ActivationCost` field for. An UNKNOWN term still
  // refuses the whole cost — `parseEquipCost`'s rule, and the reason "Discard a
  // spell" and "[1] or [Body]" are still declined below rather than approximated
  // by a plain discard or by whichever half is cheaper.
  const compound = /^\s*[—–-]\s*(.+?)(?:\(|$)/s.exec(rest);
  if (compound) return compoundEmpowerCost(compound[1]!);
  // **Anything else may follow the pips, and MUST be allowed to.** This used to
  // demand a "(" — the reminder text's opening — and that quietly refused every
  // `(Overnumbered)` printing, whose text is the same card with the reminder
  // DROPPED. `printing-aliases.test.ts` caught it within the hour, exactly as its
  // own note says it is for: VEN-181 disagreed with VEN-086 about being
  // implemented, which is the same card twice.
  return costFromPips(pips[1], pips[2] ?? "");
}

/**
 * A compound `[Empower]` cost's terms — the half after the em dash (827.1.c.2).
 *
 * Comma-separated, and every term must be one this engine can already charge.
 * **An unrecognised term refuses the WHOLE cost**, which is `parseEquipCost`'s
 * rule and the only safe direction: reading the half you understand makes the
 * ability cheaper than printed, and an Empower that is too cheap turns on a
 * card's whole `[Empowered]` clause for free.
 *
 * Two Vendetta shapes are refused here on purpose rather than approximated:
 *
 *   **"Discard a spell"** (Mel, Defiant Soul) — `ActivationCost.discard` is a
 *   COUNT of any cards, so charging it would let the player discard a unit
 *   instead. That is cheaper than printed. It needs a narrowed discard field.
 *
 *   **"[1] or [Body]"** (Legion Marauder) — an ALTERNATIVE cost, which no field
 *   here expresses. Charging either half alone is cheaper than the choice, and
 *   charging both is dearer.
 */
function compoundEmpowerCost(
  terms: string,
): { energy: number; powerCost: number; powerDomain: Domain | null; extra?: { exhaust?: true; discard?: number; killFriendlyPermanent?: true } } | undefined {
  let energy = 0;
  const extra: { exhaust?: true; discard?: number; killFriendlyPermanent?: true } = {};
  for (const raw of terms.split(",")) {
    const term = raw.trim();
    if (term === "") continue;
    const energyPip = /^:rb_energy_(\d+):$/i.exec(term);
    if (energyPip) {
      energy += Number.parseInt(energyPip[1]!, 10);
      continue;
    }
    if (/^:rb_exhaust:$/i.test(term)) {
      extra.exhaust = true;
      continue;
    }
    const discard = /^Discard (\d+)$/i.exec(term);
    if (discard) {
      extra.discard = Number.parseInt(discard[1]!, 10);
      continue;
    }
    if (/^Kill a friendly unit$/i.test(term)) {
      extra.killFriendlyPermanent = true;
      continue;
    }
    return undefined; // a term this cannot charge — refuse the whole cost
  }
  if (energy === 0 && Object.keys(extra).length === 0) return undefined;
  return { energy, powerCost: 0, powerDomain: null, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
}

/** The shared `:rb_energy_N::rb_rune_X:` reading behind `[Flow]` and `[Empower]`.
 *  One domain across every rune; `rainbow` is `null`, the spelling every payment
 *  site already reads as "any domain". */
function costFromPips(
  energyPips: string | undefined,
  runePips: string,
): { energy: number; powerCost: number; powerDomain: Domain | null } | undefined {
  const energy = energyPips ? Number.parseInt(energyPips, 10) : 0;
  const runes = [...runePips.matchAll(/:rb_rune_([a-z]+):/gi)].map((m) => m[1]!.toLowerCase());
  if (energy === 0 && runes.length === 0) return undefined;
  if (runes.length === 0) return { energy, powerCost: 0, powerDomain: null };
  const first = runes[0]!;
  if (!runes.every((r) => r === first)) return undefined;
  if (first === "rainbow") return { energy, powerCost: runes.length, powerDomain: null };
  const capitalized = first.charAt(0).toUpperCase() + first.slice(1);
  if (!isDomain(capitalized)) return undefined;
  return { energy, powerCost: runes.length, powerDomain: capitalized };
}

/**
 * What an `[Empowered][>]` clause grants, for the payloads that are a static
 * Might bonus and/or keywords.
 *
 * **Parsed rather than tabulated, and 828.1.a is what makes that legitimate
 * rather than speculative**: the rules FIX the clause's format ("[Empowered][>]
 * [Text]"), and 828.1.b.1 fixes its meaning ("While I have the Empowered status,
 * this card gains `[Text]`"). Measured over the loaded pool, 21 of the 36
 * printed clauses are exactly "I have +N Might", "I have [Keyword]", or the two
 * joined by "and" — so one reader serves nineteen cards with no per-card row,
 * the same trade `parseEquipCost` makes.
 *
 * Everything else returns undefined and stays unwritten: a payload that is a
 * TRIGGER ("When I conquer, you score 1 point"), an activated ability, or a
 * replacement effect needs per-card code, and a partially-granted card is worse
 * than an unimplemented one because it looks finished.
 */
export function parseEmpoweredGrant(plain: string): { might: number; keywords: Partial<Record<Keyword, number>> } | undefined {
  const clause = /\[Empowered\]\[>\]\s*([^.]*)\./.exec(plain);
  if (!clause) return undefined;
  const text = clause[1]!.trim();
  // "I have ..." is the whole of the payload shape this reads. Anything that
  // does not open that way is a trigger or an ability.
  const body = /^I have\s+(.*)$/i.exec(text);
  if (!body) return undefined;
  let might = 0;
  const keywords: Partial<Record<Keyword, number>> = {};
  for (const part of body[1]!.split(/\s+and\s+|,\s*/)) {
    const term = part.trim();
    if (term === "") continue;
    const mightMatch = /^\+(\d+)\s*:rb_might:$/i.exec(term);
    if (mightMatch) {
      might += Number.parseInt(mightMatch[1]!, 10);
      continue;
    }
    const keywordMatch = /^\[([A-Za-z][a-zA-Z-]*)(?:\s+(\d+))?\]$/.exec(term);
    const keyword = keywordMatch ? keywordFromBracketText(keywordMatch[1]!) : undefined;
    if (keyword === undefined) return undefined; // a term this cannot read — grant nothing
    keywords[keyword] = keywordMatch![2] ? Number.parseInt(keywordMatch![2], 10) : 1;
  }
  if (might === 0 && Object.keys(keywords).length === 0) return undefined;
  return { might, keywords };
}

/**
 * The two `[Empower]`/`[Empowered]` fields, ready to spread into any card
 * variant.
 *
 * One helper rather than two reads per branch, because 827.1.a puts the keyword
 * on "permanents and legends" and Vendetta prints it on Units, Gear AND Legends
 * — three branches that must not drift. `text` is the standing warning here: it
 * was declared per variant and simply omitted from Legend, so every Legend's
 * printed ability was invisible to coverage for months.
 */
function empowerFields(plain: string): {
  empowerCost?: { energy: number; powerCost: number; powerDomain: Domain | null };
  empoweredGrant?: { might: number; keywords: Partial<Record<Keyword, number>> };
} {
  const empowerCost = plain.includes("[Empower]") ? parseEmpowerCost(plain) : undefined;
  const empoweredGrant = plain.includes("[Empowered]") ? parseEmpoweredGrant(plain) : undefined;
  return {
    ...(empowerCost !== undefined ? { empowerCost } : {}),
    ...(empoweredGrant !== undefined ? { empoweredGrant } : {}),
  };
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

/**
 * **`Math.max` here is deliberate and is NOT the merge rule the engine uses at
 * runtime.** `engine/keyword-stacking.ts` sums [Assault], [Deflect], [Shield] and
 * [Hunt] across sources, per 807.2/809.2/814.2/823.2. One card's printed text is
 * ONE source, and a second bracket in it is the card talking about the same
 * instance — so summing here would be wrong, and measurably so:
 *
 *   Taric - Protector prints `[Shield]` and then "other friendly units here have
 *   [Shield]" — two brackets, one printed keyword. Lucian - Gunslinger prints
 *   `[Assault]` and then "deal my [Assault]". Five UNL units print `[Deflect]`
 *   plus a reminder mention.
 *
 * Master Yi - Unstoppable is the one this loses information on, and it is a
 * different problem: he prints `[Level 3]`, `[Level 6]`, `[Level 11]` and
 * `[Level 16]`, four separate dependent clauses (824), and this keeps only 16.
 * `[Level]` is in UNIMPLEMENTED_KEYWORDS, so nothing reads the number yet.
 */
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
  // UNL. Seven Unleashed cards print the phrase and the split is the same as
  // SFD's: these two are UNCONDITIONAL, the other five are not and are listed in
  // card-loader.test.ts's CONDITIONAL map. One of those five is worth naming
  // here because it is a NEW shape rather than an "if" clause — UNL-151 Bandle
  // Soldier prints `[Level 3][>] I enter ready.`, so its readiness is gated on
  // an XP threshold, and an override would hand it out at 0 XP.
  "UNL-001", // Arena Kingpin — "I enter ready.", then an unrelated exhaust ability
  "UNL-196", // Daisy! — "I enter ready.", then a cost reduction and an attack trigger
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
  // Sivir - Mercenary — "If you've spent at least [rainbow][rainbow] this turn,
  // I have +2 Might and [Ganking]."
  //
  // The FIFTH instance of the bracket false-positive shape, and the second of
  // the self-granting kind after Ancient Warmonger above. Left in, she had
  // [Ganking] unconditionally — free battlefield-to-battlefield movement all
  // game for a condition she had not met.
  //
  // Per-KEYWORD rather than `CONDITIONAL_KEYWORD_DEF_IDS`, which returns `{}`
  // and would take her real printed [Accelerate] with it. Her runtime grant is
  // a `CONDITIONAL_GRANTS` entry sharing one predicate with her Might half.
  "SFD-143": ["Ganking"],

  // ---- Unleashed's four, found 2026-08-09 ----
  //
  // **Sivir's shape, four more times, and two agents found it independently.**
  // A keyword printed INSIDE a condition — a `[Level N]` band, or "if you've
  // gained XP this turn" — parses as a flat printed keyword, because `KW_PATTERN`
  // sees brackets and not sentences. All four shipped with the keyword live at 0
  // XP, and both keywords involved are ones a player can ACT on: `[Deflect]`
  // makes an opponent pay a rainbow surcharge they do not owe, and `[Ganking]`
  // permits a battlefield-to-battlefield move that should be illegal.
  //
  // Per-KEYWORD, not `CONDITIONAL_KEYWORD_DEF_IDS`, for exactly the reason Sivir's
  // note above gives: that table returns `{}` and would take Mosstomper's and
  // Gustwalker's real printed `[Hunt 2]` with it, leaving them worse than printed.
  // The first suggestion I received was the per-card table; it would have been a
  // net loss.
  "UNL-047": ["Deflect"], // Mosstomper — "[Level 3] I have +1 Might and [Deflect]"
  "UNL-075": ["Ganking"], // Gustwalker — "[Level 3] I have +1 Might and [Ganking]"
  "UNL-113": ["Deflect", "Ganking"], // Master Yi - Tempered — "[Level 6] I have [Deflect] and [Ganking]"
  // **UNL-108 Wily Newtfish is stripped WITHOUT a runtime re-grant**, and that is
  // deliberate rather than an oversight. Its condition is "if you've gained XP
  // this turn", and no state answers it — `gainXp` writes only the running total,
  // so nothing can distinguish "gained some this turn" from "has some". Stripping
  // alone leaves the card weaker than printed; leaving it alone leaves a player
  // able to make an illegal move all game. Weaker is the safer error, and this
  // card already reports unimplemented (its Might half needs the same missing
  // counter), so an inert keyword is CONSISTENT with what coverage says rather
  // than a second hidden gap. Recorded in docs/rules-conformance.md.
  "UNL-108": ["Ganking"],

  // ---- The `[Temporary]` false positives, found and fixed 2026-08-08 ----
  //
  // **This class is LETHAL, which is what separates it from every entry above.**
  // The others give a card a keyword it should not have and it plays slightly
  // too well. `turn-manager.killTemporaryPermanents` tests `"Temporary" in
  // u.keywords` and destroys what it finds, so a card here **dies at the start
  // of its controller's Beginning Phase, every game, for a keyword it does not
  // print**.
  //
  // **OGN-106 Sprite Mother is one of them**, which means a card in a set that
  // has been "complete and hard-gated" for months has never survived a turn. No
  // instrument in this repo could see it: coverage asks whether a card is
  // implemented, and reachability asks whether it was ever observed acting —
  // she IS observed, being played, and then quietly dying.
  //
  // Two shapes, and this table's own measurement note above missed both because
  // it scanned for text that grants a keyword "to other permanents":
  //
  //   **Conferred on a TOKEN the card creates** — "play a ready 3 Might Sprite
  //   unit token with [Temporary]". The token is Temporary; the maker is not.
  //   The grant is not to another PERMANENT, it is part of the token's own
  //   definition, which is why the earlier scan did not match it.
  //
  //   **Merely REFERENCED in a condition** — Petal Pixie counts "your units with
  //   [Temporary]", LeBlanc says "your [Temporary] effects don't trigger".
  //   Neither grants anything at all. `HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS`
  //   exists for exactly this shape for one keyword; this is the same thing for
  //   another, and the general lesson is that ANY keyword can appear in a
  //   condition.
  //
  // Per-KEYWORD is load-bearing for three of the six: Trevor prints a real
  // `[Shield]`, Lillia a real `[Accelerate]`, LeBlanc a real `[Backline]`, and
  // `CONDITIONAL_KEYWORD_DEF_IDS`' blanket `{}` would take those with it.
  //
  // **These six shipped one commit late, and the reason is worth keeping.**
  // Applying them made `settleDeferredResolution` throw, so they were held back
  // rather than ship a hang. The throw was not a loop: six units that used to
  // die every turn started surviving, a mass death fired one trigger per death
  // per death-watch listener, and the chain legitimately reached 40 — which the
  // AI's flat 64-iteration settle cap could not drain at the two passes per item
  // a chain costs. That cap is now a no-progress guard. The bug was in the
  // instrument, and the six cards were right all along.
  // ---- Vendetta's two `[Flow]` references, 2026-08-16 ----
  //
  // **829.1.a: "Flow is present on Spells." Both of these are UNITS**, so
  // neither can hold the keyword however its text reads — which makes this the
  // rare case where the rules settle the question outright instead of it being a
  // judgement about the sentence. Left in, each would parse a `[Flow]` it does
  // not have, and `replaced-costs` would then have to decide what a Unit playable
  // from its own trash means.
  //
  // The two shapes are the same two this table already holds, one each:
  //
  //   GRANTS it — VEN-113 Kennen, Storm of Shuriken: "When I conquer, give a
  //   spell in your trash [Flow] equal to its cost this turn." The grant itself
  //   is unwritten and Kennen reports unimplemented for it.
  //
  //   REFERENCES it — VEN-098 Stargazer: "Spells with [Flow] you play from your
  //   trash cost [2] less." A cost modifier that names the keyword, exactly as
  //   Petal Pixie only COUNTS `[Temporary]` units.
  "VEN-098": ["Flow"], // Stargazer — discounts Flow spells, does not have Flow
  "VEN-113": ["Flow"], // Kennen, Storm of Shuriken — grants Flow to a spell in your trash
  "OGN-106": ["Temporary"], // Sprite Mother — the token she plays is Temporary, not her
  "UNL-048": ["Temporary"], // Trevor Snoozebottom — same, and he keeps his [Shield]
  "UNL-076": ["Temporary"], // Petal Pixie — only COUNTS units that have it
  "UNL-082": ["Temporary"], // Lillia - Fae Fawn — same token shape, keeps [Accelerate]
  "UNL-084": ["Temporary"], // Sprite Queen — same token shape
  "UNL-090": ["Temporary"], // LeBlanc - Everywhere At Once — only REFERENCES it, keeps [Backline]
};

/** A card's printed keywords: what the brackets say, minus the ones it only
 *  grants, and nothing at all for a card whose keywords are conditional. */
function printedKeywords(id: string, plain: string): Partial<Record<Keyword, number>> {
  if (CONDITIONAL_KEYWORD_DEF_IDS.has(id)) return {};
  const parsed = parseKeywords(plain);
  for (const keyword of GRANTED_ONLY_KEYWORDS[id] ?? []) delete parsed[keyword];
  for (const keyword of empoweredOnlyKeywords(plain)) delete parsed[keyword];
  return parsed;
}

/**
 * Keywords a card holds ONLY inside its `[Empowered][>]` clause.
 *
 * **This is the sixth appearance of the bracket false-positive shape, and the
 * first one derived rather than listed.** `KW_PATTERN` sees brackets, not
 * sentences, so `[Empowered][>] I have [Assault 3]` handed Shadow Fiend a flat
 * printed `[Assault 3]` — live at all times, with no Empower paid. That is
 * exactly what `GRANTED_ONLY_KEYWORDS` records for UNL-047, UNL-075 and UNL-113,
 * whose `[Level N]` clauses produced the identical bug.
 *
 * Derived, because Vendetta prints EIGHTEEN of them and a hand list of eighteen
 * defIds is a list that falls behind the next set. 828.1.a fixes the clause's
 * format, so "inside the clause" is a well-defined region rather than a guess.
 *
 * **Only keywords appearing NOWHERE else are stripped**, which is the precision
 * `GRANTED_ONLY_KEYWORDS` needed for Taric (who prints `[Shield]` and also grants
 * it): Baccai Sandspinner's clause names `[Deflect]`, and a card printing
 * `[Deflect]` on its frame as well must keep the printed one. The keyword is
 * handed back under the real condition by `granted-keywords`' derived Empowered
 * grant — stripped here, re-granted there, the same pairing one file apart that
 * Sivir and the `[Level]` rows already use.
 */
function empoweredOnlyKeywords(plain: string): Keyword[] {
  const clause = /\[Empowered\]\[>\][^.]*\./.exec(plain);
  if (!clause) return [];
  const outside = plain.replace(clause[0], "");
  const inClause = new Set(Object.keys(parseKeywords(clause[0])) as Keyword[]);
  for (const keyword of Object.keys(parseKeywords(outside)) as Keyword[]) inClause.delete(keyword);
  // `Empowered` itself is the clause's own marker, not something it grants.
  inClause.delete("Empowered");
  return [...inClause];
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
  // **VEN-073 Jagged Cutlass — the third, and the first where the lost brackets
  // cost a COST rather than a keyword.** Its text is
  // `Equip :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.)`,
  // with the keyword unbracketed exactly as Laurent's and Windsinger's are.
  //
  // `parseEquipCost` matches on `[Equip]`, so without this the card is tagged
  // `Equipment` and carries NO equip ability at all — it is the one Vendetta
  // Equipment of four that fails to wire itself, and `equipment.test.ts` names it
  // rather than letting it count as a parser limitation.
  "VEN-073": ["Equip"],
};

/** The defIds above, for the test that pins each entry to a card whose text
 *  really does print the bare keyword. Exported rather than the table, on the
 *  same reasoning as `hiddenKeywordFalsePositiveDefIds`. */
export function proseKeywordDefIds(): string[] {
  return Object.keys(PROSE_KEYWORD_DEF_IDS);
}

/**
 * The EXACT OPPOSITE of the table above, and Unleashed is what forced the
 * distinction: cards printing a keyword's bare name that genuinely do **not**
 * have the keyword.
 *
 * `keyword-prose.test.ts` swept for "a bare keyword name with no bracketed form
 * anywhere in the text" and told you to add the card to PROSE_KEYWORD_DEF_IDS —
 * which BRACKETS the word, i.e. grants it. That instruction was right for both
 * SFD cards and is wrong for both of these, where following it would hand a unit
 * a keyword the card does not print. So the sweep needs two answers, and the one
 * it cannot infer from the text is this one.
 *
 * Neither entry is a judgement call; both were checked against the frozen Java
 * oracle rather than read off the string:
 *
 *   **UNL-094 Gemhand Hunter** — its text ends `...get the effect.)ambush`, a
 *   lowercase word glued on with no space, no brackets and no reminder text, and
 *   present identically in `plain`, `rich` and the accessibility text. The
 *   oracle names it outright as "Gemhand Hunter's own stray lowercase 'ambush'
 *   artifact" (engine\EffectContext.java:1007). It is upstream data noise. The
 *   card has `[Hunt]` and `[Level 6]` and nothing else.
 *
 *   **UNL-078 Sprite Fountain** — "[Deathknell][>] Repeat this gear's play
 *   effect." That "Repeat" is the English VERB. `[Repeat]` is a Spell keyword
 *   ("you may pay an additional cost to repeat this spell's effect") and this is
 *   a Gear; granting it here would offer an additional cost on a card that
 *   prints none.
 *
 * Nothing is rewritten for these — the entry exists so the gate can tell "a
 * keyword lost its brackets" from "a word that happens to be a keyword's name",
 * and so that each stays ASSERTED not to carry it.
 */
const BARE_KEYWORD_NOT_HELD: Record<string, readonly Keyword[]> = {
  "UNL-094": ["Ambush"], // Gemhand Hunter — upstream data artifact
  "UNL-078": ["Repeat"], // Sprite Fountain — the English verb
  //
  // ---- Vendetta's fifteen, 2026-08-16 — ONE decision applied to 20 rows ----
  //
  // **Every one is 827's own reminder VERB or 828's status NOUN, and the rules
  // define both printed forms precisely enough that this is not a judgement
  // call.** 827.1.c: the keyword is formatted `Empower [Cost]`. 828.1.a: the
  // dependent ability is formatted `[Empowered][>] [Text]`. Anything else that
  // says "empower" or "Empowered" is the sentence describing the action or the
  // status, exactly as `[Add]` is a verb and `[Stun]` an action word:
  //
  //   the VERB      — "Empower me.", "Empower another gear.", "you may
  //                   disempower something you control to empower a legend"
  //   the STATUS    — "Use only if not Empowered.", "It becomes Empowered if
  //                   it's not already."
  //
  // Following `keyword-prose.test.ts`'s other suggestion here would have been a
  // real bug in the opposite direction: `PROSE_KEYWORD_DEF_IDS` BRACKETS the
  // word, which would hand each of these cards an `[Empower]` activated ability
  // or an `[Empowered]` dependent ability it does not print. Two of them —
  // Questionable Tome and Glowstone — print a genuine bracketed `[Empower]` and
  // are listed here only for `Empowered`, which is exactly the per-KEYWORD
  // precision this table has and `CONDITIONAL_KEYWORD_DEF_IDS` does not.
  //
  // "disempower" never matches the sweep and needs no entry: the character
  // before "empower" is a word character, so the bare-word pattern does not fire.
  "VEN-054": ["Empowered"], // Questionable Tome — prints [Empower]; "not Empowered" is the status
  "VEN-062": ["Empower", "Empowered"], // Hextech Formula — "Empower another gear. (It becomes Empowered…)"
  "VEN-082": ["Empower"], // Profiteer — "…to empower a legend, unit, or gear"
  "VEN-087": ["Empowered"], // Hextech Disc
  "VEN-089": ["Empower", "Empowered"], // Wild Claw
  "VEN-099": ["Empower"], // Tornado Warrior — "you may empower something here"
  "VEN-133": ["Empowered"], // Glowstone — prints [Empower]; "not Empowered" is the status
  "VEN-143": ["Empower", "Empowered"], // Zed - Master of Shadows — "empower me. (I become Empowered…)"
  "VEN-151": ["Empower", "Empowered"], // Mel - Soul's Reflection
  "VEN-153": ["Empower", "Empowered"], // Ambessa - Matriarch of War
  "VEN-155": ["Empower"], // Yordle, Kennen - Heart of the Tempest
  // The four `(Overnumbered)` prints of the legends above. They are aliased for
  // IMPLEMENTATION but not for text parsing — `printedKeywords` runs per defId,
  // before any alias — so each needs its own row.
  "VEN-191": ["Empower"], // Zed - Master of Shadows (Overnumbered)
  "VEN-195": ["Empower"], // Mel - Soul's Reflection (Overnumbered)
  "VEN-196": ["Empower"], // Ambessa - Matriarch of War (Overnumbered)
  "VEN-197": ["Empower"], // Yordle, Kennen - Heart of the Tempest (Overnumbered)
};

/** The pairs above, for the test that both EXCLUDES them from the bare-keyword
 *  sweep and pins that each really does lack the keyword. */
export function bareKeywordNotHeld(): { id: string; keyword: Keyword }[] {
  return Object.entries(BARE_KEYWORD_NOT_HELD).flatMap(([id, keywords]) => keywords.map((keyword) => ({ id, keyword })));
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
        ...empowerFields(plain),
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
        ...empowerFields(plain),
        hidden: isGenuinelyHidden(plain, id),
        isReaction: plain.includes("[Reaction]") && !reactionIsOnlyAmbushReminder(plain),
        tags: card.tags ?? [],
        text: plain,
      };
    }
    case "Spell": {
      // 829.1.a puts `[Flow]` on Spells alone, so it is read only here — a Unit
      // that mentions the keyword cannot pick up a cost from this branch at all.
      const flowCost = plain.includes("[Flow]") ? parseFlowCost(plain) : undefined;
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
        isReaction: plain.includes("[Reaction]") && !reactionIsOnlyAmbushReminder(plain),
        isAction: plain.includes("[Action]"),
        hidden: isGenuinelyHidden(plain, id),
        ...(flowCost !== undefined ? { flowCost } : {}),
        text: plain,
      };
    }
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
        isReaction: plain.includes("[Reaction]") && !reactionIsOnlyAmbushReminder(plain),
        ...empowerFields(plain),
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
 * The printing suffixes this pool uses. A card named `X (Overnumbered)` is the
 * same card as `X` — a different PRINT, not a different card.
 *
 * `(Ultimate)` is here for Baron Nashor, the one card that uses it, and it
 * behaves identically: `UNL-238` is `UNL-147` with reminder text dropped.
 */
const PRINTING_SUFFIX = /\s*\((Overnumbered|Signature|Ultimate)\)\s*$/;

/**
 * The card's name with any printing suffix removed — the identity two prints of
 * one card share.
 *
 * **The title separator is normalised, and Vendetta is why.** That set prints
 * `Character, Title` where the first four print `Character - Title` — measured
 * over the loaded pool: 128 of 128 earlier champions use the dash, 38 of 38
 * Vendetta ones use the comma — and it REPRINTS eleven earlier cards under the
 * new convention. `VEN-168 Jinx, Demolitionist (Overnumbered)` is a printing of
 * `OGN-030 Jinx - Demolitionist`, and without this the two base names differ, no
 * canonical twin is found, and the printing lands with **no implementation at
 * all** — which is exactly the "12 of the 31 printings were INERT in a real
 * game" bug this alias table was built to end, arriving through the name instead
 * of through the id.
 *
 * Normalising toward the dash rather than the comma is arbitrary but must be
 * one-way and shared; `printingAliases` compares only values produced here, so
 * the direction never escapes this function.
 */
function printingBaseName(name: string): string {
  return name.replace(PRINTING_SUFFIX, "").replace(", ", " - ").trim();
}

/**
 * Alternate printings, mapped to the id of the print that carries the
 * implementation — **31 cards, and 12 of them were INERT in a real game.**
 *
 * # What this is
 *
 * Unleashed prints every Legend three times: a plain print, an `(Overnumbered)`
 * one and a `(Signature)` one, the last carrying an asterisk in its collector
 * number so `deriveId` yields ids like `UNL-231*`. It also reprints five Poros
 * from earlier sets. All 31 are DISTINCT ids — that is correct and deliberate,
 * since a deck list names a printing — but they are the SAME CARD, and every
 * registry in this engine is keyed by defId.
 *
 * So a player whose deck contained the Signature print of Rengar - Pridestalker
 * got a Legend with no ability at all. Measured before this existed: **12 of the
 * 31 printings had an implemented twin and no implementation of their own.** The
 * other 19 are aliased too, so they land implemented the day their twin does
 * rather than needing to be noticed again.
 *
 * # Why it is derived rather than listed
 *
 * A hand-written table is one more list to forget, and this pool has already
 * produced four wrong lists that were maintained by hand. The base NAME is the
 * identity, and it is checked: `printingsMatchTheirTwin` in
 * `test/printing-aliases.test.ts` asserts every alias has identical rules text
 * (reminder text stripped), type, cost and Might. A print that genuinely
 * differed would fail there rather than silently inherit the wrong behaviour.
 *
 * # What it does NOT do
 *
 * It does not merge the cards. Each printing keeps its own id, art, and place in
 * a deck list; only the IMPLEMENTATION lookup is redirected.
 */
let printingAliasCache: ReadonlyMap<string, string> | undefined;

export function printingAliases(): ReadonlyMap<string, string> {
  if (printingAliasCache) return printingAliasCache;
  const defs = loadCardDefinitions();
  const canonical = new Map<string, string>();
  for (const d of defs) {
    if (PRINTING_SUFFIX.test(d.name)) continue;
    // First plain print wins. Two sets can print the same card (UNL reprints
    // five Poros), and either implementation serves — they are the same card.
    //
    // **Keyed through `printingBaseName`, not on the raw name**, so both sides of
    // the lookup below normalise the title separator the same way. Keying this
    // raw while looking up normalised would work only for a printing whose twin
    // is in an OLDER set and fail for one whose twin is in its own — `VEN-023
    // Zed, From the Shadows` and its `(Overnumbered)` print are exactly that
    // case, and it is the majority case for Vendetta.
    const base = printingBaseName(d.name);
    if (!canonical.has(base)) canonical.set(base, d.id);
  }
  const aliases = new Map<string, string>();
  for (const d of defs) {
    if (!PRINTING_SUFFIX.test(d.name)) continue;
    const target = canonical.get(printingBaseName(d.name));
    // A printing with no plain twin would be a data problem, not something to
    // paper over: leaving it unaliased makes it report unimplemented, which is
    // the honest answer and is asserted in the test.
    if (target !== undefined && target !== d.id) aliases.set(d.id, target);
  }
  printingAliasCache = aliases;
  return aliases;
}

/**
 * The id whose implementation this card uses — itself, unless it is an alternate
 * printing of another card.
 *
 * Read this instead of `defId` anywhere an implementation is looked up by id.
 * The effect registries handle it centrally (see `mergeRegistries` in
 * effects/index.ts); the sites that need it individually are the ones comparing
 * a defId to a literal, which no merge can reach.
 */
export function canonicalDefId(defId: string): string {
  return printingAliases().get(defId) ?? defId;
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
