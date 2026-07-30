import type { UnitInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import { applyContested } from "./cleanup.js";

/** Where a created token is put — "base", or a specific battlefield. */
export type TokenDestination = "base" | { battlefieldId: string };

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

/**
 * Creates a Recruit token and puts it at `destination` for `casterIndex`.
 * Lives here rather than in either caller because BOTH a Unit trigger
 * (Faithful Manufactor, Noxian Drummer — unit-triggers.ts) and a Spell effect
 * (Recruit the Vanguard — card-effects.ts) create tokens, and those two
 * modules can't import each other (unit-triggers.ts already imports
 * card-effects.ts for TargetingSpec).
 *
 * A battlefield id that doesn't exist is a silent no-op rather than a throw,
 * matching every other "target vanished" path in this engine.
 */
export function placeRecruitToken(state: GameState, casterIndex: 0 | 1, destination: TokenDestination): GameState {
  const token = createRecruitToken();
  const casterId = state.players[casterIndex].id;

  if (destination === "base") {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[casterIndex] = { ...players[casterIndex], baseUnits: [...players[casterIndex].baseUnits, token] };
    return { ...state, players };
  }

  const bfIndex = state.battlefields.findIndex((bf) => bf.id === destination.battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [casterId]: [...(bf.units[casterId] ?? []), token] } };
  // Rule 190.4 applies Contested when a unit "Moves **or otherwise becomes
  // present**" at a battlefield its controller doesn't control — a created token
  // becoming present counts, and this path previously opened no Showdown at all.
  // It's also how a Non-Combat Showdown gets promoted to a Combat one (317.2):
  // token-making Spells are exactly what an opponent holding Focus can cast into
  // someone else's window now that Action speed exists.
  return applyContested({ ...state, battlefields }, destination.battlefieldId, casterIndex);
}
