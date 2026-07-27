import type { Domain } from "./domain.js";
import type { Keyword } from "./keyword.js";
import type { CardDefinition } from "./card-definition.js";

/**
 * A live copy of a card in a game — as opposed to `CardDefinition`, the
 * static printed-card data it was created from. Mirrors model/Card.java's
 * sealed class hierarchy, reshaped as a discriminated union on `kind`.
 *
 * `instanceId` is unique per physical copy in the game (two "Daring Poro"
 * copies in the same deck are different CardInstances sharing one
 * `defId`); Java gives every `Card` its own `UUID id` for the same reason.
 *
 * Only the runtime fields actually exercised so far are included — Java's
 * Card.Unit additionally mutates `preventValue`/`movesThisTurn`/
 * `udyrOptionsChosenThisTurn`/`temporaryKeywordBonus`/`buffCount`
 * (model/Card.java:73-91), each added for a specific later mechanic
 * (Prevent, movement, buffs). Add them here when that mechanic lands.
 */
export interface CardInstanceBase {
  instanceId: string;
  defId: string;
  name: string;
  domains: Domain[];
  exhausted: boolean;
  isToken: boolean;
}

export interface LegendInstance extends CardInstanceBase {
  kind: "Legend";
  championTag: string;
}

export interface UnitInstance extends CardInstanceBase {
  kind: "Unit";
  energyCost: number;
  powerCost: number;
  /** Which domain a nonzero powerCost must be paid in — null whenever
   *  powerCost is 0. Needed at runtime (not just on CardDefinition) so
   *  auto-payment logic (legalActions/computeAutoPayment) can pick correctly
   *  domain-matching runes without a registry lookup. */
  powerDomain: Domain | null;
  might: number;
  isChampion: boolean;
  keywords: Partial<Record<Keyword, number>>;
  isReaction: boolean;
  tags: string[];
  damage: number;
  bonus: number;
}

export interface SpellInstance extends CardInstanceBase {
  kind: "Spell";
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  isReaction: boolean;
}

export interface GearInstance extends CardInstanceBase {
  kind: "Gear";
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  attachedToInstanceId: string | null;
}

export type CardInstance = LegendInstance | UnitInstance | SpellInstance | GearInstance;

let instanceCounter = 0;
/** Deterministic id generator (no crypto/UUID dependency) — fine for now since
 *  nothing depends on instance ids being unguessable, only unique per game. */
function nextInstanceId(): string {
  instanceCounter += 1;
  return `card-${instanceCounter}`;
}

/** Instantiates a fresh, zone-less live copy from a definition. Mirrors CardRegistry.fromDef/create. */
export function createCardInstance(def: CardDefinition): CardInstance {
  const base = {
    instanceId: nextInstanceId(),
    defId: def.id,
    name: def.name,
    domains: def.domains,
    exhausted: false,
    isToken: false,
  };

  switch (def.type) {
    case "Legend":
      return { ...base, kind: "Legend", championTag: def.championTag };
    case "Unit":
      return {
        ...base,
        kind: "Unit",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        might: def.might,
        isChampion: def.isChampion,
        keywords: def.keywords,
        isReaction: def.isReaction,
        tags: def.tags,
        damage: 0,
        bonus: 0,
      };
    case "Spell":
      return {
        ...base,
        kind: "Spell",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        isReaction: def.isReaction,
      };
    case "Gear":
      return {
        ...base,
        kind: "Gear",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        attachedToInstanceId: null,
      };
  }
}
