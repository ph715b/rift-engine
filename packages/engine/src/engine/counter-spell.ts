import { isSpellChainEntry, type ChainEntry, type GameState, type SpellChainEntry } from "../model/game-state.js";
import type { SpellInstance } from "../model/card.js";
import { findUnitAnywhere } from "./target-lookup.js";

/**
 * Countering a spell, and taking control of one — the two things a chain item can
 * have done to it.
 *
 * Its own module because neither is an effect on the BOARD: every other helper in
 * this engine changes units, gear or a player's zones, and these change the chain
 * itself. Keeping them here also keeps `effect-helpers.ts` from having to import
 * the chain types.
 */

/** Every spell currently waiting on the chain, with its position — the pool a
 *  `chainSpell`-kind target is chosen from. */
export function spellsOnChain(state: GameState): { entry: SpellChainEntry; index: number }[] {
  return state.spellChain
    .map((entry, index) => ({ entry, index }))
    .filter((e): e is { entry: SpellChainEntry; index: number } => isSpellChainEntry(e.entry));
}

/**
 * Does this waiting spell satisfy a counter's printed-cost filter?
 *
 * PRINTED cost, which the PDF states as a general rule and then works using Defy
 * by name — a Rocket Barrage whose Repeat cost was paid is still a legal Defy
 * target, because Defy only checks what the card prints.
 *
 * The Power test is "no more than N Power **of any domain**", which is a count of
 * pips rather than a domain match: Defy's own text prints a single unnumbered
 * rainbow pip, and the card image is what settled that it means 1 (Energy prints
 * as a NUMBERED glyph, Power as COUNTED PIPS — see docs/rules-calls-resolved.md).
 */
export function matchesCostFilter(card: SpellInstance, maxPrintedEnergy?: number, maxPrintedPower?: number): boolean {
  if (maxPrintedEnergy !== undefined && card.energyCost > maxPrintedEnergy) return false;
  if (maxPrintedPower !== undefined && card.powerCost > maxPrintedPower) return false;
  return true;
}

/**
 * Not So Fast — "counter an ENEMY spell or ability that CHOOSES a friendly unit
 * or gear."
 *
 * Two filters neither Wind Wall nor Defy needed, and both are about the spell's
 * relationship to the counterer rather than about its printed cost — which is
 * why they take a player index and the cost filter does not.
 *
 * **"a friendly unit or GEAR"**, so this reads the same four target fields
 * `chosenUnitsOfPlay` collects and then resolves each against BOTH boards. The
 * field list is shared with that helper for the reason it exists: enumerating
 * the fields that can name a permanent by hand is what left `[Deflect]`
 * unpriced on five cards.
 *
 * **"or ABILITY" is a recorded divergence, not an omission.** An activated
 * ability's effect runs INLINE in this engine (see `execute-activate-ability`)
 * rather than waiting on the chain, so there is no ability item for a counter to
 * name. The spell half is complete; see docs/rules-conformance.md.
 */
function choosesAFriendlyPermanent(state: GameState, entry: SpellChainEntry, friendlyIndex: 0 | 1): boolean {
  const owner = state.players[friendlyIndex];
  return chosenIdsOf(entry).some((id) => {
    if (owner.activeGear.some((g) => g.instanceId === id)) return true;
    const unit = findUnitAnywhere(state, id);
    return unit !== undefined && unit.ownerIndex === friendlyIndex;
  });
}

/**
 * Every id this chain entry NAMED as a target.
 *
 * Extracted from `choosesAFriendlyPermanent` when Repulse needed the same list,
 * and shared for the reason that function's own comment gives: enumerating the
 * fields that can name a permanent by hand is what left `[Deflect]` unpriced on
 * five cards. Two copies of this list is two chances to miss the next field.
 */
function chosenIdsOf(entry: SpellChainEntry): string[] {
  return [
    entry.targetUnitInstanceId,
    entry.secondTargetUnitInstanceId,
    ...(entry.targetUnitInstanceIds ?? []),
    entry.targetPermanentInstanceId,
  ].filter((id): id is string => id !== undefined);
}

/**
 * UNL-106 Repulse — "counter an enemy spell or ability that chooses IT and NO
 * OTHER friendly unit", where "it" is the unit this Repulse announced.
 *
 * **The pool's only restriction BETWEEN two announced targets**, which is why it
 * lives here as a pair predicate rather than as a field on either target's
 * filter: `counterFilter` answers about the spell alone and `eligibleTargets`
 * about the unit alone, and neither can see the other's choice. The PDF uses this
 * card by name as its worked example of announce-time selection.
 *
 * Both halves are real and separable:
 *   - it must choose the named unit — a spell aimed elsewhere is not counterable
 *     by this Repulse even if it chooses some other friendly unit;
 *   - and NO OTHER friendly unit — a sweep that catches the named unit plus a
 *     second friendly one is out, which is the half that makes Repulse a
 *     protection card rather than a general counter.
 *
 * **"No other friendly UNIT", not permanent.** A chosen friendly GEAR does not
 * disqualify the counter: the printed word is "unit", and Not So Fast's
 * deliberately wider `choosesFriendlyPermanent` sits right above as the contrast.
 * An enemy unit chosen alongside is likewise irrelevant.
 */
export function choosesOnlyThisFriendlyUnit(
  state: GameState,
  entry: SpellChainEntry,
  unitInstanceId: string,
  counterorIndex: 0 | 1,
): boolean {
  const chosen = chosenIdsOf(entry);
  if (!chosen.includes(unitInstanceId)) return false;
  return !chosen.some((id) => {
    if (id === unitInstanceId) return false;
    const unit = findUnitAnywhere(state, id);
    return unit !== undefined && unit.ownerIndex === counterorIndex;
  });
}

/**
 * Builds `counterableSpells`' owner-relative filter from a targeting spec.
 *
 * Exists so the enumerator and the validator cannot spell it differently — all
 * four call sites read the same two fields off the same spec through this one
 * function. A counter that names neither field gets `undefined` and therefore
 * exactly the walk it had before these fields existed.
 */
export function counterFilter(
  targeting: { enemyOnly?: true; choosesFriendlyPermanent?: true },
  counterorIndex: 0 | 1,
): { counterorIndex: 0 | 1; enemyOnly?: true; choosesFriendlyPermanent?: true } | undefined {
  if (!targeting.enemyOnly && !targeting.choosesFriendlyPermanent) return undefined;
  return {
    counterorIndex,
    ...(targeting.enemyOnly ? { enemyOnly: targeting.enemyOnly } : {}),
    ...(targeting.choosesFriendlyPermanent ? { choosesFriendlyPermanent: targeting.choosesFriendlyPermanent } : {}),
  };
}

/** The waiting spells a counter with this filter could legally name. Asked by
 *  both `legal-actions` and `validate-play-card`, so the enumerator and the
 *  validator cannot disagree about what is counterable. */
export function counterableSpells(
  state: GameState,
  maxPrintedEnergy?: number,
  maxPrintedPower?: number,
  /** Not So Fast's two extra filters. Optional so Wind Wall, Defy, Mystic
   *  Reversal and Riposte get exactly the walk they always had — a counter that
   *  names no owner asks no owner question. */
  filter?: { counterorIndex: 0 | 1; enemyOnly?: true; choosesFriendlyPermanent?: true },
): { entry: SpellChainEntry; index: number }[] {
  return spellsOnChain(state).filter(({ entry }) => {
    if (!matchesCostFilter(entry.card, maxPrintedEnergy, maxPrintedPower)) return false;
    if (filter === undefined) return true;
    // "an ENEMY spell" — cast by the other seat. A counter that could name your
    // own spell is a different card.
    if (filter.enemyOnly && entry.playerIndex === filter.counterorIndex) return false;
    if (filter.choosesFriendlyPermanent && !choosesAFriendlyPermanent(state, entry, filter.counterorIndex)) return false;
    return true;
  });
}

/**
 * Removes a spell from the chain without resolving it — rule: a Countered spell
 * is put into its owner's trash and its effect never happens.
 *
 * **The card is already in the trash** and that is not an oversight: this engine
 * trashes a Spell when it is CAST, not when it resolves (see
 * execute-play-card's chain push and execute-pass-focus's note that "the spell is
 * already in the caster's trash at this point"). So countering is purely the
 * removal of the pending item.
 *
 * **The subtle half: a countered card was never PLAYED.** The rules are explicit —
 * "A card that is Countered is not considered to have been played for abilities
 * that trigger on cards being played" — and this engine fires `cardPlayed` when a
 * spell is CAST rather than when it resolves. So by the time a counter resolves,
 * that event's triggers have already been held, and possibly already finalized
 * onto the chain. Both places have to be swept, and getting it wrong is invisible
 * in play: Cithria still grows, Darius still counts, and nothing errors.
 *
 * **`cardsPlayedThisTurn` is deliberately NOT decremented.** The same rules
 * passage says `[Legion]` and cost-counting are explicitly unaffected by a
 * counter — only the TRIGGERS are undone.
 *
 * A no-op when the id names nothing on the chain, which is a real case rather
 * than defensive padding: two counters can be cast at the same target, and the
 * second resolves after the first has already removed it.
 */
export function counterSpell(state: GameState, spellCardInstanceId: string): GameState {
  const target = spellsOnChain(state).find(({ entry }) => entry.card.instanceId === spellCardInstanceId);
  if (!target) return state;

  const spellChain = state.spellChain
    .filter((_, index) => index !== target.index)
    .filter((entry) => !isPlayedTriggerFor(entry, spellCardInstanceId));
  const pendingTriggers = state.pendingTriggers.filter((entry) => !isPlayedTriggerFor(entry, spellCardInstanceId));

  // **Emptying the chain returns the turn to an Open State** — 334 ("the turn is
  // said to be in an Open State if no Chain exists") and 345 Step 4 ("if the
  // Chain is empty, play proceeds in an Open State"). Left closed and empty, the
  // very next PassFocus pops `undefined` off the chain and the engine throws.
  //
  // Unreachable while every counter resolved from the chain, which is why it was
  // missing: an ordinary counter removes its victim while its OWN entry is still
  // on the chain, so the pop it is in the middle of sees the empty chain and
  // `finishChainPop` reopens it. **Hard Bargain counters when its RANSOM IS
  // ANSWERED**, long after its own entry was popped — so the last item can vanish
  // with no pop in flight. Found by `DECKS=sfd`, not by the suite.
  //
  // Reopened here rather than by calling the pop path, because Focus must NOT
  // pass: 346 passes Focus when the last item RESOLVES, and a countered spell
  // never resolves. `chainOpenedByTrigger` goes with it — it is only meaningful
  // while a chain exists, and `finishChainPop` clears it for the same reason.
  if (spellChain.length === 0 && !state.chainOpen) {
    return { ...state, spellChain, pendingTriggers, chainOpen: true, chainPasses: 0, chainOpenedByTrigger: false };
  }

  return { ...state, spellChain, pendingTriggers };
}

/** Is this chain entry a `cardPlayed` trigger that fired for the countered card?
 *  Those are the ones a counter unwinds — a trigger that fired for anything else,
 *  including one the countered spell's own resolution would have caused, stays. */
function isPlayedTriggerFor(entry: ChainEntry, spellCardInstanceId: string): boolean {
  if (isSpellChainEntry(entry)) return false;
  const event = entry.event as { kind?: string; playedInstanceId?: string };
  return event?.kind === "cardPlayed" && event.playedInstanceId === spellCardInstanceId;
}

/**
 * Moves a waiting spell's control to `playerIndex` — Mystic Reversal's "gain
 * control of a spell".
 *
 * Control of a chain item is `playerIndex` on the entry, and it decides three
 * separate things, which is why taking it is worth more than redirecting the
 * effect: whose Legend fires on-spell-cast when it resolves, who gets priority
 * for the fresh round of passes on it (345), and — for every effect that reads
 * `ctx.casterIndex` — who "you" is. A card that draws now draws for the thief.
 *
 * **"You may make new choices for it" is NOT implemented**, and it is the half
 * that needs a mid-resolution question the engine cannot yet ask: the choices
 * were made when the spell was announced, and re-making them means offering the
 * new controller the original spec's candidate list while a resolution is
 * suspended. Recorded in docs/rules-conformance.md; the control change alone is
 * the card's larger half and works on its own.
 */
export function gainControlOfSpell(state: GameState, spellCardInstanceId: string, playerIndex: 0 | 1): GameState {
  const target = spellsOnChain(state).find(({ entry }) => entry.card.instanceId === spellCardInstanceId);
  if (!target) return state;

  const spellChain = [...state.spellChain];
  spellChain[target.index] = { ...target.entry, playerIndex };
  return { ...state, spellChain };
}
