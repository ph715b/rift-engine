import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { drawCards } from "./effect-helpers.js";

/**
 * The four Proving Grounds Legends' abilities — the last cards in the OGS set
 * with printed text and no implementation. Every deck has exactly one Legend
 * in play from turn 1, so until now every game was played with one blank card
 * per side.
 *
 * Ported from engine/LegendAbilities.java, with one deliberate improvement:
 * that file dispatches by PREFIX-MATCHING the Legend's display name
 * (`legend.name.startsWith("Annie")`, LegendAbilities.java:34) because its own
 * `championTag` is derived as `name.split("\\s+")[0]` and so breaks for
 * multi-word names ("Master Yi" -> "MASTER") — a latent bug its doc comment
 * calls out at :16-18. We key by defId instead, exactly like CARD_EFFECTS and
 * UNIT_TRIGGERS already do, which has no such ambiguity.
 *
 * Three of the four are one-shot EVENT triggers, hooked at the exact moment
 * they fire (turn-manager.ts's runEnd, execute-pass-focus.ts's chain
 * resolution, scoring.ts's recordConquest). Master Yi's is not an event at
 * all: it's a continuous conditional modifier, recomputed inside
 * effective-might.ts every time Might is evaluated and never written into
 * state — persisting it would leak the bonus into unrelated later fights the
 * same turn (LegendAbilities.java:20-26 makes the same point).
 */
export interface LegendAbilityDefinition {
  /** "At the end of your turn..." — fires only for the player whose turn is
   *  ending, before the active player rotates. */
  onEndOfTurn?: (state: GameState, ownerIndex: 0 | 1) => GameState;
  /** "When you play a spell that costs N or more..." — `totalCost` is Energy
   *  PLUS Power, see dispatchLegendOnSpellCast. */
  onSpellCast?: (state: GameState, ownerIndex: 0 | 1, totalCost: number) => GameState;
  /** "When you conquer..." — fires after the conquest is recorded, with the
   *  battlefield just taken. */
  onConquer?: (state: GameState, ownerIndex: 0 | 1, battlefieldId: string) => GameState;
  /** "At start of your Beginning Phase..." — fires on the same event Mushroom
   *  Pouch listens to, before holds score (see turn-manager.runBeginning). */
  onBeginningPhase?: (state: GameState, ownerIndex: 0 | 1) => GameState;
  /** A continuous Might modifier for one of the owner's units, evaluated
   *  fresh per call — see effective-might.ts's own aura table. */
  mightBonus?: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, ctx: LegendMightContext) => number;
}

/** The slice of effective-might.ts's MightContext a Legend aura can read.
 *  Declared here rather than imported to keep the dependency one-way
 *  (effective-might.ts consumes this module, never the reverse). */
export interface LegendMightContext {
  isCombat: boolean;
  isAttackingSide?: boolean;
  battlefieldId?: string;
}

/** Readies up to `max` exhausted runes in `ownerIndex`'s channeled pool, in
 *  pool order. Which specific runes are readied is deliberately not offered
 *  as a choice: readying is strictly beneficial and never wrong, so maxing it
 *  out IS the faithful implementation rather than a shortcut around a real
 *  decision — the Java oracle makes exactly this call and says so
 *  (LegendAbilities.java:30-32). */
function readyRunes(state: GameState, ownerIndex: 0 | 1, max: number): GameState {
  const owner = state.players[ownerIndex];
  let readied = 0;
  const channeled = owner.channeled.map((rune) => {
    if (readied >= max || rune.state !== "Exhausted") return rune;
    readied += 1;
    return { ...rune, state: "Ready" as const };
  });
  if (readied === 0) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...owner, channeled };
  return { ...state, players };
}

const LEGEND_ABILITIES: Record<string, LegendAbilityDefinition> = {
  "OGS-017": {
    // Annie - Dark Child — "At the end of your turn, ready up to 2 runes."
    onEndOfTurn: (state, ownerIndex) => readyRunes(state, ownerIndex, 2),
  },
  "OGS-021": {
    // Lux - Lady of Luminosity — "When you play a spell that costs 5 or
    // more, draw 1."
    onSpellCast: (state, ownerIndex, totalCost) => (totalCost >= 5 ? drawCards(state, ownerIndex, 1) : state),
  },
  "OGS-023": {
    // Garen - Might of Demacia — "When you conquer, if you have 4+ units at
    // that battlefield, draw 2." Counts the units still standing AFTER the
    // fight that took the battlefield, which is what "you have ... at that
    // battlefield" reads as at the moment the trigger resolves (and what
    // ScoringSystem's own dispatch point gives it — LegendAbilities.java:301).
    onConquer: (state, ownerIndex, battlefieldId) => {
      const bf = state.battlefields.find((b) => b.id === battlefieldId);
      if (!bf) return state;
      const ownUnits = bf.units[state.players[ownerIndex].id] ?? [];
      return ownUnits.length >= 4 ? drawCards(state, ownerIndex, 2) : state;
    },
  },
  "OGN-251": {
    // Jinx - Loose Cannon — "At start of your Beginning Phase, draw 1 if you have
    // one or fewer cards in your hand."
    //
    // The condition is checked when the ability resolves, not when the phase was
    // entered, and "one or fewer" includes an empty hand — the case the card is
    // really for, since Jinx's deck discards aggressively.
    onBeginningPhase: (state, ownerIndex) =>
      state.players[ownerIndex].hand.length <= 1 ? drawCards(state, ownerIndex, 1) : state,
  },
  "OGS-019": {
    // Master Yi - Wuju Bladesman — "While a friendly unit defends alone, it
    // gets +2 Might." DEFENDS, not "attacks or defends": the Java oracle
    // audited its own implementation and found it had been applying the bonus
    // while attacking too, from an assumption never checked against the card
    // (LegendAbilities.java:135-139 records that fix and the rename to
    // soloDefenseBonus). Ported from the corrected version.
    mightBonus: (state, _unit, ownerIndex, ctx) => {
      if (!ctx.isCombat || ctx.isAttackingSide !== false || ctx.battlefieldId === undefined) return 0;
      const bf = state.battlefields.find((b) => b.id === ctx.battlefieldId);
      const ownHere = bf?.units[state.players[ownerIndex].id] ?? [];
      return ownHere.length === 1 ? 2 : 0;
    },
  },
};

function abilitiesFor(state: GameState, ownerIndex: 0 | 1): LegendAbilityDefinition | undefined {
  return LEGEND_ABILITIES[state.players[ownerIndex].legend.defId];
}

/** Fires the ending player's Legend end-of-turn ability, if any. Called from
 *  runEnd BEFORE the active player rotates, so "your turn" means theirs. */
/** Every Legend defId with a registered ability — see engine/coverage.ts, which
 *  uses it to tell implemented cards from silently-inert ones. */
export function legendAbilityDefIds(): string[] {
  return Object.keys(LEGEND_ABILITIES);
}

export function dispatchLegendEndOfTurn(state: GameState, ownerIndex: 0 | 1): GameState {
  return abilitiesFor(state, ownerIndex)?.onEndOfTurn?.(state, ownerIndex) ?? state;
}

/** Fires the caster's Legend spell-cast ability, if any. `totalCost` is
 *  Energy + Power: "costs 5 or more" reads the whole printed cost, which is
 *  how the oracle evaluates it for both Lux cards
 *  (UnitAbilities.java:66, LegendAbilities.java:47). */
export function dispatchLegendOnSpellCast(state: GameState, ownerIndex: 0 | 1, totalCost: number): GameState {
  return abilitiesFor(state, ownerIndex)?.onSpellCast?.(state, ownerIndex, totalCost) ?? state;
}

/** Fires the conquering player's Legend conquest ability, if any. */
export function dispatchLegendOnConquer(state: GameState, ownerIndex: 0 | 1, battlefieldId: string): GameState {
  return abilitiesFor(state, ownerIndex)?.onConquer?.(state, ownerIndex, battlefieldId) ?? state;
}

/** This unit's owner's Legend's continuous Might contribution, if any. */
export function legendMightBonus(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  ctx: LegendMightContext,
): number {
  return abilitiesFor(state, ownerIndex)?.mightBonus?.(state, unit, ownerIndex, ctx) ?? 0;
}

/** Fires the active player's Legend Beginning-Phase ability, if it has one. */
export function dispatchLegendBeginningPhase(state: GameState, ownerIndex: 0 | 1): GameState {
  return abilitiesFor(state, ownerIndex)?.onBeginningPhase?.(state, ownerIndex) ?? state;
}
