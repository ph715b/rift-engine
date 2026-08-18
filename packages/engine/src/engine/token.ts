import type { GearInstance, UnitInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import { applyContested } from "./cleanup.js";
import { tokensEnterReady } from "./board-restrictions.js";
import { holdEventTrigger } from "./triggers.js";
// The Shadow Clone's TAG comes from the leaf constants module, not the other way
// round: `triggers.ts` keys the token's printed ability off the derived defId at
// MODULE SCOPE, and this file imports triggers.ts — so deriving it here and
// exporting it threw a temporal-dead-zone ReferenceError at import. See the
// constant's own note, and `GOLD_TOKEN_DEF_ID`'s, which records the silent half
// of the same bug.
import { SHADOW_CLONE_TAG } from "./constants.js";


/**
 * A token entering the board is a PLAY — **185.2.a**: "Tokens can be played by
 * their owner if their card type is played, following all the applicable steps
 * for playing a card", and **350.2**: "Tokens are not cards, but can still be
 * Played."
 *
 * Held (383) rather than fired inline, for the reason every other trigger in
 * this engine is: `placeToken` has 27 call sites, many of them inside a
 * resolver, and an inline dispatch would let a token's trigger re-enter the
 * resolution that created it.
 *
 * `isToken: true` is the whole point of the event — see its note in triggers.ts.
 * A listener reading "when you play a CARD" must refuse this; one reading "when
 * you play a UNIT" or "a gear" must accept it. Before this existed neither
 * fired, which made the first group accidentally right and the second silently
 * narrow.
 *
 * `playedPowerCost: 0` is not a placeholder: **185.3.a.1** gives a token no
 * printed cost, so the one card that reads the field (SFD-100, "a card with
 * Power cost [rainbow][rainbow] or more") would not match a token even if it
 * were not already excluded by `isToken`.
 */
function holdTokenPlayed(
  state: GameState,
  casterIndex: 0 | 1,
  playedKind: "Unit" | "Gear",
  playedInstanceId: string,
): GameState {
  return holdEventTrigger(state, {
    kind: "cardPlayed",
    casterIndex,
    playedKind,
    playedInstanceId,
    playedPowerCost: 0,
    isToken: true,
  });
}

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
 * Desert's Call's and Emperor's Dais' token — SHARED, because two owners make it.
 *
 * It lived as two private copies: one in `effects/calm.ts` for the spell, one in
 * `battlefield-abilities.ts` for the battlefield, the latter commented "a local
 * copy of effects/order.ts's private spec" — naming a file that never held it,
 * since Desert's Call is Calm. A stat line copied into two files under a comment
 * pointing at a third is the drift this repo keeps recording; `RECRUIT_TOKEN`
 * and `GOLD_TOKEN` are already shared from here for exactly this reason.
 *
 * No keywords and no "ready" clause, so it enters exhausted on 143.4.a's default
 * — unlike Sprite Call's, which overrides it.
 */
export const SAND_SOLDIER_TOKEN: TokenSpec = { name: "Sand Soldier", might: 2, tag: "Sand Soldier" };

/**
 * The Bird token — SHARED, because SIX printed cards across FOUR domains make it.
 *
 * **This is `SAND_SOLDIER_TOKEN`'s drift happening a second time, and further.**
 * That one was two private copies; on 2026-08-09 this was found as THREE
 * byte-identical `const BIRD_TOKEN` declarations — `effects/calm.ts`,
 * `effects/chaos.ts` and `effects/order.ts` — written independently by three
 * wave-2 agents who could not see each other's files. None of them was wrong to
 * do it: the fan-out rule kept each out of the shared file, so a local copy was
 * the only thing any of them could write. The consolidation is the integrator's.
 *
 * Its makers: UNL-033 and UNL-044 (Calm), UNL-088 (Mind), UNL-130 (Chaos),
 * UNL-153 and UNL-160 (Order), plus the UNL-217 battlefield.
 *
 * The `[Deflect 1]` is the part that made sharing urgent rather than tidy — a
 * copy that lost it would produce a Bird an opponent could target for free, and
 * the difference is invisible until someone taxes it. It is also what exposed a
 * crash in the [Deflect] surcharge the same day, since these tokens are what put
 * a taxable body on the board in ordinary play.
 */
export const BIRD_TOKEN: TokenSpec = { name: "Bird", might: 1, tag: "Bird", keywords: { Deflect: 1 } };

/**
 * The 3-Might Mech — Production Surge's and Rumble - Scrapper's, and shared from
 * here for the reason the Sand Soldier records above: a stat line copied into two
 * files drifts, and this one has two owners from the day it lands.
 *
 * **The `Mech` tag is load-bearing rather than flavour.** Four keyword auras in
 * `granted-keywords.ts` read it (`isMech`), so a Mech token minted without the
 * tag would be the only Mech on the board that Rumble - Mechanized Menace's
 * `[Shield]` and Breakneck Mech's grants did not reach — silently, since a
 * missing keyword looks exactly like a keyword that was never granted.
 */
export const MECH_TOKEN: TokenSpec = { name: "Mech", might: 3, tag: "Mech" };

/**
 * Vendetta's Shadow Clone — SHARED, because TWO cards in two different files
 * create it: `VEN-023 Zed, From the Shadows` (effects/fury.ts) and `VEN-144
 * Death Mark` (Fury+Chaos, so effects/signature-fury.ts).
 *
 * That is exactly the drift `SAND_SOLDIER_TOKEN` and `BIRD_TOKEN` both record —
 * a stat line copied into each maker's file, which then stops agreeing. Two
 * makers is the threshold this file already uses.
 *
 * **0 Might, and that is the card rather than a placeholder.** It dies to any
 * damage and contributes nothing to a combat pool; its whole value is the
 * printed ability below, which pays `[Assault 4]` for banishing a unit from the
 * trash. A 1-Might default would make it a materially different token.
 *
 * No `entersReady`, so it enters exhausted on 143.4.a's default like every other
 * token here — neither card says otherwise.
 */
export const SHADOW_CLONE_TOKEN: TokenSpec = { name: "Shadow Clone", might: 0, tag: SHADOW_CLONE_TAG };

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
  // Renata Glasc - Industrialist's "your tokens enter ready" (369.3), applied
  // HERE rather than in `createToken` because this is the first point that knows
  // whose token it is. It overrides the spec either way round: a Recruit that
  // would enter exhausted enters ready, and it is a no-op on Sprite Call, which
  // already asked for ready.
  const spawned = createToken(spec);
  const token = tokensEnterReady(state, casterIndex) ? { ...spawned, exhausted: false } : spawned;
  const casterId = state.players[casterIndex].id;

  if (destination === "base") {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[casterIndex] = { ...players[casterIndex], baseUnits: [...players[casterIndex].baseUnits, token] };
    return holdTokenPlayed({ ...state, players }, casterIndex, "Unit", token.instanceId);
  }

  const bfIndex = state.battlefields.findIndex((bf) => bf.id === destination.battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [casterId]: [...(bf.units[casterId] ?? []), token] } };
  // Rule 190.3.a applies Contested when a unit "Moves **or otherwise becomes
  // present**" at a battlefield its controller doesn't control — a created token
  // becoming present counts, and this path previously opened no Showdown at all.
  // It's also how a Non-Combat Showdown gets promoted to a Combat one (316.8.b.1.a):
  // token-making Spells are exactly what an opponent holding Focus can cast into
  // someone else's window now that Action speed exists.
  return holdTokenPlayed(
    applyContested({ ...state, battlefields }, destination.battlefieldId, casterIndex),
    casterIndex,
    "Unit",
    token.instanceId,
  );
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
    //
    // That word is the GENERATING EFFECT's modification, not the type's default —
    // 149.1 enters gear ready, and 184.1 is what lets those cards say otherwise.
    // So it is overridable, and `placeGearToken` below overrides it for Renata
    // Glasc - Industrialist. This comment previously read as though "exhausted"
    // were inherent to a gear token; it never was.
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
  // Renata Glasc - Industrialist replaces the entering event, so the caller's
  // `entersExhausted` — which is the generating effect's 184.1 modification, not
  // gear's 149.1 default — is ignored while she is in play (375).
  const token = createGearToken(spec, entersExhausted && !tokensEnterReady(state, casterIndex));
  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...players[casterIndex], activeGear: [...players[casterIndex].activeGear, token] };
  return holdTokenPlayed({ ...state, players }, casterIndex, "Gear", token.instanceId);
}

/** `count` Gold tokens at once, all exhausted — the shape every SFD card that
 *  makes more than one asks for ("play two Gold gear tokens exhausted"). */
export function placeGoldTokens(state: GameState, casterIndex: 0 | 1, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = placeGearToken(next, casterIndex, GOLD_TOKEN, true);
  return next;
}
