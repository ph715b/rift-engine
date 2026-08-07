import type { Domain } from "./domain.js";
import type { Keyword } from "./keyword.js";
import type { EquipExtraCost } from "../cards/card-loader.js";

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
