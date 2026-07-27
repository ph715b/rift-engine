import type { Domain } from "./domain.js";
import type { Keyword } from "./keyword.js";

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
  imageUrl: string;
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
  text: string;
}

export interface SpellDefinition extends CardDefinitionBase {
  type: "Spell";
  energyCost: number;
  powerCost: number;
  isReaction: boolean;
  isAction: boolean;
  hidden: boolean;
  text: string;
}

export interface GearDefinition extends CardDefinitionBase {
  type: "Gear";
  energyCost: number;
  powerCost: number;
  keywords: Partial<Record<Keyword, number>>;
  isReaction: boolean;
  hidden: boolean;
  text: string;
}

export type CardDefinition = LegendDefinition | UnitDefinition | SpellDefinition | GearDefinition;
