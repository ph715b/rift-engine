import type { GearInstance, UnitInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import { applyContested } from "./cleanup.js";

/** Where a created token is put — "base", or a specific battlefield. */
export type TokenDestination = "base" | { battlefieldId: string };

let tokenCounter = 0;

/**
 * What a token is. Kept as a spec because the pool now has two shapes and the
 * old comment here promised exactly this: "a real per-card TokenSpec parameter
 * can be added the day a different token type is needed, not before". Sprite
 * Call is that day — a 3-Might Sprite that enters READY and carries
 * `[Temporary]`, where every Recruit is a 1-Might token that enters exhausted.
 */
export interface TokenSpec {
  name: string;
  might: number;
  /** Tokens normally enter exhausted like any other unit (143.4.a); a card that
   *  says "play a READY ... token" overrides that on its own authority. */
  entersReady?: boolean;
  keywords?: UnitInstance["keywords"];
  /** Tag line, e.g. "Recruit" or "Sprite" — the printed subtype. */
  tag: string;
}

export const RECRUIT_TOKEN: TokenSpec = { name: "Recruit", might: 1, tag: "Recruit" };

/**
 * Builds a runtime-only token unit — a raw UnitInstance object literal,
 * deliberately NOT going through createCardInstance/CardRegistry, since no
 * CardDefinition exists for it (Token-supertype entries are filtered out of the
 * loaded card pool entirely, card-loader.ts's shouldSkip). Mirrors the Java
 * oracle's EffectContext.createRecruitToken (constructs Card.Unit directly,
 * isToken=true, bypassing the registry).
 */
export function createToken(spec: TokenSpec): UnitInstance {
  tokenCounter += 1;
  return {
    instanceId: `token-${spec.tag.toLowerCase()}-${tokenCounter}`,
    defId: `TOKEN-${spec.tag.toUpperCase()}`,
    name: spec.name,
    domains: [],
    exhausted: spec.entersReady !== true,
    isToken: true,
    kind: "Unit",
    energyCost: 0,
    powerCost: 0,
    powerDomain: null,
    might: spec.might,
    isChampion: false,
    keywords: spec.keywords ?? {},
    isReaction: false,
    tags: [spec.tag],
    damage: 0,
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movesThisTurn: 0,
  };
}

/** The 1-Might Recruit every existing caller wanted. */
export function createRecruitToken(): UnitInstance {
  return createToken(RECRUIT_TOKEN);
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
  return placeToken(state, casterIndex, destination, RECRUIT_TOKEN);
}

/** Creates a token of any spec and puts it at `destination` — the general form
 *  placeRecruitToken now delegates to. */
export function placeToken(
  state: GameState,
  casterIndex: 0 | 1,
  destination: TokenDestination,
  spec: TokenSpec,
): GameState {
  const token = createToken(spec);
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

/**
 * What a GEAR token is.
 *
 * Separate from `TokenSpec` rather than a variant of it, because the two share
 * almost nothing: a gear has no Might, is never at a battlefield, never
 * attacks, and so needs none of the combat state every `UnitInstance` carries.
 * Folding them together would have meant a `might` field that is meaningless
 * for half its uses.
 */
export interface GearTokenSpec {
  name: string;
  /** Tag line — the printed subtype, and the source of the runtime defId. */
  tag: string;
}

/**
 * SFD's Gold token, the pool's first gear token.
 *
 * The printed card is `sfd-t03` "Gold // Buff" — one card with two faces, of
 * which the gear face is the one cards create ("play a Gold gear token"). Its
 * printed ability, "Kill this, [Exhaust]: [Reaction] — [Add] :rb_rune_rainbow:",
 * is implemented in `activated-abilities.ts` under this spec's runtime defId.
 *
 * `loadTokenDefinitions()` is what makes that ability's defId traceable to a
 * real printed card, and `token-definitions.test.ts` pins this spec's name and
 * runtime defId against the card data so a rename upstream cannot quietly leave
 * the ability keyed to nothing.
 */
export const GOLD_TOKEN: GearTokenSpec = { name: "Gold", tag: "Gold" };

/** The runtime defId a created Gold token carries, and the key its printed
 *  ability is registered under in `activated-abilities.ts`. Exported from HERE
 *  rather than written out again there, so the two cannot drift: a table keyed
 *  to an id nothing creates is silent, and reads exactly like an implemented
 *  ability. Derived from the spec for the same reason. */
export const GOLD_TOKEN_DEF_ID = `TOKEN-${GOLD_TOKEN.tag.toUpperCase()}`;

/**
 * Builds a runtime-only gear token — a raw `GearInstance`, on exactly the same
 * reasoning as `createToken` above: no `CardDefinition` exists for a token,
 * because `shouldSkip` filters Token-supertype entries out of the playable pool.
 *
 * `attachedToInstanceId` starts null. The field already existed for the
 * Equipment subsystem SFD also needs, and a Gold token is never attached — but
 * leaving it undefined would make a gear token structurally different from
 * every other gear on the board, which is the kind of difference that surfaces
 * later as a crash in code that assumed the field was there.
 */
export function createGearToken(spec: GearTokenSpec, entersExhausted: boolean): GearInstance {
  tokenCounter += 1;
  return {
    instanceId: `token-${spec.tag.toLowerCase()}-${tokenCounter}`,
    defId: `TOKEN-${spec.tag.toUpperCase()}`,
    name: spec.name,
    domains: [],
    // Every SFD card that makes one says "play a Gold gear token EXHAUSTED", so
    // the caller states it rather than defaulting: a gear token that quietly
    // entered ready would be a free rainbow Power on the turn it was made.
    exhausted: entersExhausted,
    isToken: true,
    kind: "Gear",
    energyCost: 0,
    powerCost: 0,
    powerDomain: null,
    attachedToInstanceId: null,
    keywords: {},
  };
}

/**
 * Creates a gear token and puts it into `casterIndex`'s `activeGear`.
 *
 * Deliberately NOT routed through `placeToken`'s destination machinery: gear is
 * a flat per-player list with no location at all (`activeGear` on
 * `PlayerState`), so there is no battlefield to place one at and no Contested
 * to apply. `Listener.battlefieldId`'s comment — "Gear is never at a
 * battlefield in this pool" — is still true of gear TOKENS even though SFD's
 * Equipment will falsify it for attached gear.
 */
export function placeGearToken(
  state: GameState,
  casterIndex: 0 | 1,
  spec: GearTokenSpec,
  entersExhausted: boolean,
): GameState {
  const token = createGearToken(spec, entersExhausted);
  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...players[casterIndex], activeGear: [...players[casterIndex].activeGear, token] };
  return { ...state, players };
}

/** `count` Gold tokens at once, all exhausted — the shape every SFD card that
 *  makes more than one asks for ("play two Gold gear tokens exhausted"). */
export function placeGoldTokens(state: GameState, casterIndex: 0 | 1, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = placeGearToken(next, casterIndex, GOLD_TOKEN, true);
  return next;
}
