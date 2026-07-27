import type { CardDefinition } from "../model/card-definition.js";
import { loadCardDefinitions } from "./card-loader.js";

/** Indexed lookup over every loaded CardDefinition. Mirrors registry/CardRegistry.java. */
export class CardRegistry {
  private readonly byId = new Map<string, CardDefinition>();

  constructor(definitions: readonly CardDefinition[]) {
    for (const def of definitions) {
      this.byId.set(def.id, def);
    }
  }

  get(id: string): CardDefinition {
    const def = this.byId.get(id);
    if (!def) throw new Error(`No card registered for id: ${id}`);
    return def;
  }

  tryGet(id: string): CardDefinition | undefined {
    return this.byId.get(id);
  }

  all(): CardDefinition[] {
    return [...this.byId.values()];
  }
}

let sharedRegistry: CardRegistry | undefined;

/** The Origins + Proving Grounds card pool, loaded once and cached. */
export function defaultCardRegistry(): CardRegistry {
  sharedRegistry ??= new CardRegistry(loadCardDefinitions());
  return sharedRegistry;
}
