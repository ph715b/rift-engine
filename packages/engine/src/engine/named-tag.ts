import type { GameState, PlayerState } from "../model/game-state.js";
import type { GearInstance, UnitInstance } from "../model/card.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { parkDecision } from "./decisions.js";

/**
 * "Name a tag" — UNL-138 The List's "as you play this, name a tag. (For example,
 * Miss Fortune, Demacia, and Poro are tags.)"
 *
 * # Why the name is asked at the gear-play site and not on the action
 *
 * 355's Make Relevant Choices step puts "as you play this" at ANNOUNCE, so the
 * strictly correct home for the name is a field on `PlayCardAction`, fanned out
 * by the enumerator like every other announce-time choice.
 *
 * **That is not what this does, and the reason is a measurement rather than a
 * preference.** There are 111 distinct tags in the pool. `legal-actions` fans
 * choices out unconditionally, so a 1-Energy gear would push 111 PlayCard actions
 * before targets are even considered — and the AI evaluates every action it is
 * offered, which is the cost that had just been measured on the move fan-out when
 * this was written (that one took `reachability` from ~120s to over ten minutes).
 * A DECISION costs one action to answer and builds its 111 options only when
 * asked.
 *
 * So the name is chosen immediately AFTER the gear enters play, parked as a
 * pending decision. Recorded as a divergence in docs/rules-conformance.md, and a
 * narrow one: a Gear does not use the chain (it goes straight into `activeGear`,
 * which is the other half of why this card was refused twice), so there is no
 * window between announce and this in which anything could respond differently.
 *
 * # Full list, not a filtered one
 *
 * Every tag in the pool is offered, including tags no unit on the board carries.
 * That is the project owner's call and it is the paper game's behaviour: naming
 * is a guess about what your opponent will play, so restricting it to what is
 * already visible would quietly turn a read into a tautology.
 */
const THE_LIST = "UNL-138";

/** Every distinct tag printed in the pool, sorted — the option set. Computed
 *  once: the registry is static, and this is 111 strings. */
let cachedTags: string[] | undefined;
export function allPrintedTags(): string[] {
  if (cachedTags === undefined) {
    const tags = new Set<string>();
    for (const def of defaultCardRegistry().all()) {
      // A Legend has no `tags` — only Units and some Gear print them, so this
      // narrows rather than casting. `LegendDefinition` genuinely lacks the field.
      for (const tag of ("tags" in def ? (def.tags ?? []) : [])) tags.add(tag);
    }
    cachedTags = [...tags].sort();
  }
  return cachedTags;
}

/** Parks The List's naming question when one is played. A no-op for every other
 *  Gear, so the single call site in `execute-play-card` stays honest about being
 *  the one place a Gear enters play. */
export function holdNamedTagChoice(state: GameState, playerIndex: 0 | 1, card: { defId: string; instanceId: string }): GameState {
  if (card.defId !== THE_LIST) return state;
  return parkDecision(state, { kind: "UNL-138-name", playerIndex, cardInstanceId: card.instanceId });
}

/** Writes the named tag onto the gear that was told it. */
export function setNamedTag(state: GameState, playerIndex: 0 | 1, gearInstanceId: string, tag: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  players[playerIndex] = {
    ...actor,
    activeGear: actor.activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, namedTag: tag } : g)),
  };
  return { ...state, players };
}

/** The tag `gearInstanceId` was told, or undefined if it was never told one. */
export function namedTagOf(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): string | undefined {
  return state.players[playerIndex].activeGear.find((g) => g.instanceId === gearInstanceId)?.namedTag;
}

/**
 * Every unit ANYWHERE carrying `tag` — The List's ability says "a unit", naming
 * no side and no location, so 355.9.a.1 widens it to the whole Board and both
 * players.
 */
export function unitsWithTag(state: GameState, tag: string): { unit: UnitInstance; ownerIndex: 0 | 1 }[] {
  const out: { unit: UnitInstance; ownerIndex: 0 | 1 }[] = [];
  for (const ownerIndex of [0, 1] as const) {
    const owner = state.players[ownerIndex];
    const everywhere = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
    for (const unit of everywhere) if (unit.tags.includes(tag)) out.push({ unit, ownerIndex });
  }
  return out;
}

/** For coverage.ts. */
export function namedTagDefIds(): string[] {
  return [THE_LIST];
}

/** Narrowing helper for the one place a `GearInstance` is read back for its tag. */
export function isTheList(card: GearInstance): boolean {
  return card.defId === THE_LIST;
}
