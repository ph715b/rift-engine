import type { UnitInstance } from "../model/card.js";

let tokenCounter = 0;

/**
 * Builds a runtime-only "Recruit" token unit — a raw UnitInstance object
 * literal, deliberately NOT going through createCardInstance/CardRegistry,
 * since no CardDefinition exists for it (Token-supertype entries are
 * filtered out of the loaded card pool entirely, card-loader.ts's
 * shouldSkip). Mirrors the Java oracle's EffectContext.createRecruitToken
 * (constructs Card.Unit directly, isToken=true, bypassing the registry).
 * Every Recruit token in this round's cards is identical (1 Might, no
 * cost, no keywords, colorless) — a real per-card TokenSpec parameter can
 * be added the day a different token type is needed, not before.
 */
export function createRecruitToken(): UnitInstance {
  tokenCounter += 1;
  return {
    instanceId: `token-recruit-${tokenCounter}`,
    defId: "TOKEN-RECRUIT",
    name: "Recruit",
    domains: [],
    exhausted: true,
    isToken: true,
    kind: "Unit",
    energyCost: 0,
    powerCost: 0,
    powerDomain: null,
    might: 1,
    isChampion: false,
    keywords: {},
    isReaction: false,
    tags: [],
    damage: 0,
    bonus: 0,
  };
}
