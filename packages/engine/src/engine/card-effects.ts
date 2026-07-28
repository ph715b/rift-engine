import type { CardInstance } from "../model/card.js";

/**
 * The first, deliberately narrow slice of card-effect resolution — 3 generic
 * shapes covering 5 real cards already in the 4 preset decks, not a general
 * effect engine. Every other Spell/Gear/Unit ability remains an honest no-op
 * at resolution, exactly like today, until it's added here one card at a
 * time — mirrors the Java oracle's own EffectRegistry, which safely no-ops
 * for any unregistered card name (registry/EffectRegistry.java), just with
 * a handful of entries instead of one per printed card.
 */
export type CardEffect =
  | { kind: "DealDamage"; amount: number }
  | { kind: "DestroyUnit" }
  | { kind: "BuffAllFriendlies"; amount: number };

/**
 * Keyed by defId (e.g. "OGS-003"), the stable id every CardInstance/
 * CardDefinition shares (card-loader.ts's deriveId). Hardcoded rather than
 * derived from card text — precise and safe for a handful of cards; not
 * worth a text-parsing scheme until there are enough registered effects to
 * justify one.
 */
const CARD_EFFECTS: Record<string, CardEffect> = {
  "OGS-003": { kind: "DealDamage", amount: 2 }, // Incinerate
  "OGN-085": { kind: "DealDamage", amount: 6 }, // Falling Comet
  "OGS-022": { kind: "DealDamage", amount: 8 }, // Final Spark
  "OGS-012": { kind: "DestroyUnit" }, // Blast of Power
  "OGS-024": { kind: "BuffAllFriendlies", amount: 2 }, // Decisive Strike
};

export function effectForCard(card: CardInstance): CardEffect | undefined {
  return CARD_EFFECTS[card.defId];
}

/** DealDamage/DestroyUnit need a target unit; BuffAllFriendlies applies to
 *  every unit the caster controls and needs none. */
export function requiresTarget(effect: CardEffect | undefined): boolean {
  return effect?.kind === "DealDamage" || effect?.kind === "DestroyUnit";
}
