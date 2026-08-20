import type { Domain } from "./domain.js";
import type { Keyword } from "./keyword.js";
import type { EquipExtraCost } from "../cards/card-loader.js";

/**
 * A cost that reads the BOARD rather than a printed number — the "This ability
 * costs [N] less…" sentence three Vendetta units print after their `[Empower]`
 * pips.
 *
 * Both variants count **runes you control**, which is `channeled.length` — the
 * Rune Pool, the same count Tomb Raider Barbara, Esteemed Hierophant and
 * Siphoning Strike read for the same printed phrase.
 *
 * A discriminated union rather than one optional-field shape, so each variant
 * names the sentence it came from and neither can be half-filled:
 *
 *   `perRuneControlled`  "costs [1] less FOR EACH rune you control" — Frostcoat
 *                        Mother and Grumpy Rockbear, both 12 minus one per rune
 *   `ifRunesAtMost`      "costs [3] less IF you control 4 or fewer runes" —
 *                        Baccai Sandspinner, a flat discount behind a threshold
 *
 * Deliberately Energy-only: every printed instance reduces Energy, and a Power
 * pip is a domain requirement rather than an amount, so "3 less Power" would need
 * to say which pip goes. A card that prints one can widen this then.
 */
export type EnergyDiscountRule =
  | { kind: "perRuneControlled"; amount: number }
  | { kind: "ifRunesAtMost"; amount: number; max: number };

/**
 * Static, printed-card data — one entry per real card, loaded once from the
 * OGN/OGS JSON and never mutated. Mirrors registry/CardDefinition.java's
 * sealed interface, reshaped as a TS discriminated union on `type` instead
 * of a Java `permits` list (see PRD open-question #2's resolution).
 *
 * Spell/Gear here carry only the fields needed so far (cost, domains,
 * reaction/hidden timing). Java's SpellDef/GearDef additionally carry a long
 * tail of per-card text-derived targeting flags (requiresBattlefieldTarget,
 * maxMightTarget, repeatCost, equipCost, etc., registry/CardDefinition.java:43-99)
 * built up card-by-card alongside the effect/targeting system — those get
 * added here the same way, once spell/gear effects are actually implemented,
 * not speculatively now.
 */
export interface CardDefinitionBase {
  id: string;
  name: string;
  domains: Domain[];
  /** Null when the card has no Power cost; Legends never have one. */
  powerDomain: Domain | null;
  /** A hardcoded per-card second domain that can ALSO pay this card's Power
   *  cost — set only for a handful of cards whose printed Power pip is
   *  visually split between two domains (confirmed by inspecting the card
   *  art), e.g. Tibbers (Fury/Chaos). Absent for every other card, including
   *  ones that merely list two raw domains for deckbuilding-identity reasons
   *  without a hybrid pip (e.g. Decisive Strike). See card-loader.ts's
   *  POWER_DOMAIN_ALT_OVERRIDES. */
  powerDomainAlt?: Domain;
  /**
   * `[Empower]`'s printed activation cost (827.1.c), or undefined for a card
   * that prints none.
   *
   * On the BASE because 827.1.a puts the keyword on "permanents and legends" —
   * Units, Gear and Legends all print it in Vendetta, and declaring it three
   * times is how `text` came to be omitted from Legend for months.
   */
  empowerCost?: {
    energy: number;
    powerCost: number;
    powerDomain: Domain | null;
    /**
     * The NON-RESOURCE half of a compound Empower cost — 827.1.c.2, "Empower
     * costs may include both resource costs and non-resource costs."
     *
     * Deliberately shaped as the `ActivationCost` fields it becomes, so wiring is
     * a spread rather than a translation — the same choice `EquipExtraCost` makes
     * for `[Equip]`'s compound costs, and for the same reason: every one of these
     * already existed as an activation cost, so none needed a new cost model.
     */
    extra?: { exhaust?: true; discard?: number; killFriendlyPermanent?: true };
    /**
     * A SELF-MODIFYING Empower cost — the sentence that follows the pips and
     * changes what they mean.
     *
     * **827.1.c.3 is what makes this part of the cost rather than a rider on
     * it**: text of this kind "is taken into account when determining a card's
     * Empower cost for any reason". So Frostcoat Mother's printed 12 is not a 12
     * — it is a 12 minus one per rune you control, and a board with 9 runes pays
     * 3. Honouring the pips alone makes the ability far too EXPENSIVE and the card
     * unplayable at the price it actually means, which is why `parseEmpowerCost`
     * refused to read these at all until this field existed.
     *
     * Shaped as the `ActivationCost.energyDiscount` it becomes, the same
     * spread-not-translate choice `extra` above makes.
     */
    energyDiscount?: EnergyDiscountRule;
  };
  /**
   * What this card's `[Empowered][>]` clause grants it while it holds the status
   * (828.1.b.1, "While I have the Empowered status, this card gains `[Text]`"),
   * for the clauses whose payload is a static Might bonus and/or keywords.
   *
   * Undefined both for a card printing no such clause and for one whose payload
   * is a TRIGGER or an activated ability — those need per-card code and report
   * unimplemented until they get it, which is the honest answer rather than a
   * partially-granted card.
   */
  empoweredGrant?: { might: number; keywords: Partial<Record<Keyword, number>> };
  imageUrl: string;
  /**
   * The card's printed rules text, reminder text and all.
   *
   * On the BASE, not on each variant. It was declared separately on Unit, Spell
   * and Gear and simply omitted from Legend — so every Legend in the pool had an
   * empty text as far as the rest of the engine was concerned, and coverage.ts's
   * `needsImplementation` (which asks whether there is any text to implement)
   * answered "no" for all of them. Three preset legends whose entire printed
   * ability did nothing reported as fully implemented.
   *
   * Here, a new card type cannot forget it.
   */
  text: string;
}

export interface LegendDefinition extends CardDefinitionBase {
  type: "Legend";
  championTag: string;
}

export interface UnitDefinition extends CardDefinitionBase {
  type: "Unit";
  energyCost: number;
  powerCost: number;
  might: number;
  isChampion: boolean;
  keywords: Partial<Record<Keyword, number>>;
  /** "[Legion] — I cost N less." Derived from text, 0 if absent. */
  legionDiscount: number;
  hidden: boolean;
  isReaction: boolean;
  tags: string[];
}

export interface SpellDefinition extends CardDefinitionBase {
  type: "Spell";
  energyCost: number;
  powerCost: number;
  isReaction: boolean;
  isAction: boolean;
  hidden: boolean;
  /**
   * `[Flow]`'s alternate cost (829), or undefined for a spell that prints none.
   *
   * 829.1.b: "You may play this from your trash for its flow cost. Then banish
   * it." 829.1.c.1 makes it an ALTERNATE cost that REPLACES the base cost, which
   * is why this is a whole cost rather than a discount — and why it feeds
   * `replaced-costs.ts` rather than `cost-modifiers.ts`.
   *
   * **Spells only, per 829.1.a**, and that is load-bearing rather than
   * decorative: two Vendetta UNITS mention `[Flow]` (one grants it, one discounts
   * it) and would otherwise parse as having it. They are stripped in
   * `GRANTED_ONLY_KEYWORDS`.
   */
  flowCost?: { energy: number; powerCost: number; powerDomain: Domain | null };
}

export interface GearDefinition extends CardDefinitionBase {
  type: "Gear";
  energyCost: number;
  powerCost: number;
  keywords: Partial<Record<Keyword, number>>;
  isReaction: boolean;
  hidden: boolean;
  /**
   * What this Gear's `[Equip]` ability costs, or undefined for a Gear that has
   * none. **Completely independent of the Gear's own PLAY cost** — Doran's
   * Blade is played for 2 Energy and equipped for 1 Body Power, and the two
   * never interact. A Gear is played to `activeGear` exactly as before;
   * `[Equip]` is a second, separately-paid ability that attaches it later.
   */
  equipCost?: { energy: number; domain: Domain | "rainbow"; count: number; extra?: EquipExtraCost };
  /**
   * The "+N Might" badge an Equipment grants the unit it is attached to.
   *
   * **This is art-only data and is NOT in the card JSON at all** — not in
   * `attributes.might` (null on every Equipment), not in `text.plain`, not even
   * in `accessibility_text`. Same class of gap as `powerDomainAlt`, and hand
   * -transcribed for the same reason. See `card-loader`'s EQUIP_MIGHT_BONUS.
   */
  equipMightBonus?: number;
  /** Carries the printed "Equipment" tag — the rules' own marker, and what
   *  `[Weaponmaster]` and Angle Shot mean by "an Equipment". */
  isEquipment?: boolean;
}

export type CardDefinition = LegendDefinition | UnitDefinition | SpellDefinition | GearDefinition;
