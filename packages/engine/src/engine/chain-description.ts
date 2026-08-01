import { isSpellChainEntry, type ChainEntry, type SpellChainEntry, type GameState } from "../model/game-state.js";
import { findUnitAnywhere } from "./target-lookup.js";

/**
 * One thing a ChainEntry points at, resolved from an instanceId to something
 * nameable. Deliberately STRUCTURED rather than prose: this is a rules-engine
 * projection, so the caller (packages/web's ChainView) writes the words. Any
 * English in here would be UI copy living in the engine.
 */
export interface ChainTargetDescription {
  /** Which ChainEntry field this came from — the caller phrases each kind
   *  differently ("→ X" for a target, "exhausting X" for an additional cost),
   *  and the kinds are genuinely different relationships, not one list. */
  kind: "unit" | "battlefield" | "trashCard" | "additionalCost" | "destination";
  /** The named thing: a unit's/card's name, or a battlefield's. */
  name: string;
  /** Where a targeted unit stands — a battlefield name, or null for a unit in
   *  base. Only set for the unit-ish kinds ("unit", "additionalCost"); a unit
   *  in base is a real, reachable case (base-scope targeting — Stupefy), which
   *  is why this is null rather than absent there. */
  battlefieldName?: string | null;
  /** Whose unit it is. Unit-ish kinds only. */
  ownerIndex?: 0 | 1;
  /** The referenced object couldn't be found. Can't happen today (nothing can
   *  act between a cast and its resolution), but the alternative to reporting
   *  it is a crash or a silent blank in the one surface whose whole job is
   *  saying what's about to happen — so it's reported. */
  missing?: boolean;
}

export interface ChainItemDescription {
  /** Narrowed to the Spell case: describeChain skips triggered abilities waiting
   *  as Pending Items, so a described item is always a played Spell. */
  entry: SpellChainEntry;
  /** The caster. Rule 343's resolution order is by position, not by owner, so
   *  this is display information only. */
  playerIndex: 0 | 1;
  cardName: string;
  /** Distance from the top of the chain. 0 resolves next (rule 343: the newest
   *  finalized item resolves first). */
  depthFromTop: number;
  targets: ChainTargetDescription[];
}

/**
 * `state.spellChain` projected NEWEST-FIRST — i.e. in the order the entries
 * will actually resolve (rule 343).
 *
 * Note the ordering, because it differs from the Java oracle's: our
 * `spellChain` is a plain array pushed and popped at the END (see
 * execute-play-card.ts and execute-pass-focus.ts's `slice(0, -1)`), so the
 * newest entry is the LAST element. Java's is a `Deque` pushed at the front,
 * which is why `BoardController.refreshChainZone` can treat index 0 as
 * "resolves first" and iterate forward. Copying that indexing here would show
 * the chain exactly backwards.
 *
 * Exists as an engine-side function rather than UI-local code for one concrete
 * reason: a chain deeper than one entry is unreachable through the UI until
 * reaction-speed casting lands (nothing can be cast onto an already-closed
 * chain), so the ordering can only be proved white-box — the same reasoning
 * that already keeps `resolveChainPass`'s multi-entry branch covered by a
 * hand-built fixture in spell-gear.test.ts.
 */
export function describeChain(state: GameState): ChainItemDescription[] {
  const items: ChainItemDescription[] = [];
  for (let i = state.spellChain.length - 1; i >= 0; i -= 1) {
    const entry = state.spellChain[i]!;
    // A triggered ability waiting as a Pending Item is not a Spell and has no
    // card name or targets to describe. Skipped rather than half-described,
    // because nothing pushes one yet (see TriggerChainEntry) and inventing a
    // label now would be guessing at a UI that has no case to show it. Giving
    // triggers a real chain-viewer row is part of converting the dispatch sites.
    if (!isSpellChainEntry(entry)) continue;
    items.push({
      entry,
      playerIndex: entry.playerIndex,
      cardName: entry.card.name,
      depthFromTop: state.spellChain.length - 1 - i,
      targets: describeTargets(state, entry),
    });
  }
  return items;
}

/** Every choice on one entry, in the order the player made them (see
 *  GameBoard's own PendingStep sequence: first target, second target,
 *  battlefield, placement, additional cost, trash card). */
function describeTargets(state: GameState, entry: SpellChainEntry): ChainTargetDescription[] {
  const targets: ChainTargetDescription[] = [];

  for (const instanceId of [entry.targetUnitInstanceId, entry.secondTargetUnitInstanceId]) {
    if (instanceId !== undefined) targets.push(describeUnit(state, instanceId, "unit"));
  }

  if (entry.targetBattlefieldId !== undefined) {
    const bf = state.battlefields.find((b) => b.id === entry.targetBattlefieldId);
    targets.push({
      kind: "battlefield",
      name: bf?.name ?? entry.targetBattlefieldId,
      ...(bf ? {} : { missing: true }),
    });
  }

  if (entry.trashCardInstanceId !== undefined) {
    // A Spell is trashed at cast time (execute-play-card.ts) but its chosen
    // trash card stays put until the effect resolves, so the caster's own
    // trash is where this always is while the entry is on the chain.
    const card = state.players[entry.playerIndex].trash.find((c) => c.instanceId === entry.trashCardInstanceId);
    targets.push({
      kind: "trashCard",
      name: card?.name ?? entry.trashCardInstanceId,
      ...(card ? {} : { missing: true }),
    });
  }

  if (entry.additionalCostUnitInstanceId !== undefined) {
    targets.push(describeUnit(state, entry.additionalCostUnitInstanceId, "additionalCost"));
  }

  if (entry.destinationBattlefieldId !== undefined) {
    const bf = state.battlefields.find((b) => b.id === entry.destinationBattlefieldId);
    targets.push({
      kind: "destination",
      name: bf?.name ?? entry.destinationBattlefieldId,
      ...(bf ? {} : { missing: true }),
    });
  }

  return targets;
}

function describeUnit(
  state: GameState,
  instanceId: string,
  kind: "unit" | "additionalCost",
): ChainTargetDescription {
  const found = findUnitAnywhere(state, instanceId);
  if (!found) return { kind, name: instanceId, missing: true };
  const battlefieldName =
    found.zone === "base" ? null : (state.battlefields[found.zone.battlefieldIndex]?.name ?? null);
  return { kind, name: found.unit.name, battlefieldName, ownerIndex: found.ownerIndex };
}
