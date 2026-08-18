import { repeatExecutionsOf, type RepeatChoices, type SpellChainEntry, type GameState } from "../model/game-state.js";
import { cardModeOf, type ResolveEvent } from "./card-effects.js";
import { contextFor } from "./effect-context.js";

/**
 * The choices the caster made when this spell was announced, as the effect
 * registry wants them.
 *
 * One function rather than the spread-per-field list this used to be written as
 * inline, because `[Repeat]` needs the same set built twice and a second copy is
 * exactly how a field comes to be forwarded on one execution and dropped on the
 * other — the dropped-field bug execute-play-card.ts records having shipped.
 */
function choicesOf(entry: SpellChainEntry): ResolveEvent {
  return {
    ...(entry.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: entry.targetUnitInstanceId } : {}),
    ...(entry.secondTargetUnitInstanceId !== undefined ? { secondTargetUnitInstanceId: entry.secondTargetUnitInstanceId } : {}),
    ...(entry.targetUnitInstanceIds !== undefined ? { targetUnitInstanceIds: entry.targetUnitInstanceIds } : {}),
    ...(entry.targetChainCardInstanceId !== undefined ? { targetChainCardInstanceId: entry.targetChainCardInstanceId } : {}),
    ...(entry.xAmount !== undefined ? { xAmount: entry.xAmount } : {}),
    ...(entry.targetBattlefieldId !== undefined ? { targetBattlefieldId: entry.targetBattlefieldId } : {}),
    ...(entry.trashCardInstanceId !== undefined ? { trashCardInstanceId: entry.trashCardInstanceId } : {}),
    ...(entry.additionalCostUnitInstanceId !== undefined ? { additionalCostUnitInstanceId: entry.additionalCostUnitInstanceId } : {}),
    ...(entry.additionalCostUnitInstanceIds !== undefined ? { additionalCostUnitInstanceIds: entry.additionalCostUnitInstanceIds } : {}),
    ...(entry.destinationBattlefieldId !== undefined ? { destinationBattlefieldId: entry.destinationBattlefieldId } : {}),
    ...(entry.destinationIsBase === true ? { destinationIsBase: true as const } : {}),
    ...(entry.discardCardInstanceId !== undefined ? { discardCardInstanceId: entry.discardCardInstanceId } : {}),
    ...(entry.targetPermanentInstanceId !== undefined ? { targetPermanentInstanceId: entry.targetPermanentInstanceId } : {}),
    // Part of the COST, so it carries across a `[Repeat]`'s second execution with
    // `discardCardInstanceId` rather than being re-chosen — 820.1.c.1 pays the
    // cost once, as the card is played.
    ...(entry.optionalPowerPaid !== undefined ? { optionalPowerPaid: entry.optionalPowerPaid } : {}),
  };
}

/**
 * The choices for `[Repeat]`'s SECOND execution (820.1.d).
 *
 * `repeatChoices`, when present, WHOLLY REPLACES the seven fields it declares —
 * it does not merge field-by-field with the first execution's. That is what lets
 * a repeat DECLINE an optional slot the first execution filled: Piercing Light's
 * "then deal 2 to up to one other unit" is a real choice each time, and under a
 * merge an omitted second target would silently inherit the first execution's
 * and hit a unit the caster did not name.
 *
 * Everything OUTSIDE those six carries over unchanged, because it is not a
 * choice made per execution: `additionalCostUnitInstanceId(s)`,
 * `discardCardInstanceId` and `xAmount` are parts of the COST, and 820.1.c.1
 * pays the cost once, as the card is played.
 *
 * No choices at all means "the same choices again" — a legal thing to choose,
 * and what the enumerator samples.
 *
 * Takes the execution's own choice set rather than reading `entry.repeatChoices`
 * itself, because a card printing several instances (Curtain Call) has one such
 * set PER paid instance and they are not interchangeable — 820.2 gives each
 * execution its own Make Relevant Choices step. Every execution replaces against
 * the SAME first-execution baseline, which is what "do not have to be the same as
 * the choices made for the initial execution" (820.2.a) says: the additional
 * executions are each measured against the initial one, not chained off each
 * other.
 */
function repeatChoicesOf(entry: SpellChainEntry, second: RepeatChoices | undefined): ResolveEvent {
  const first = choicesOf(entry);
  if (second === undefined) return first;
  const {
    targetUnitInstanceId: _a,
    secondTargetUnitInstanceId: _b,
    targetUnitInstanceIds: _c,
    targetBattlefieldId: _d,
    targetChainCardInstanceId: _e,
    destinationBattlefieldId: _f,
    // Dropped with its battlefield twin: the two are one choice in two fields,
    // and carrying the base flag over while replacing the battlefield id would
    // let a second execution inherit "to base" from the first and then also name
    // a battlefield — the malformed pair the validator refuses.
    destinationIsBase: _h,
    targetPermanentInstanceId: _g,
    ...carriedOver
  } = first;
  return {
    ...carriedOver,
    ...(second.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: second.targetUnitInstanceId } : {}),
    ...(second.secondTargetUnitInstanceId !== undefined ? { secondTargetUnitInstanceId: second.secondTargetUnitInstanceId } : {}),
    ...(second.targetUnitInstanceIds !== undefined ? { targetUnitInstanceIds: second.targetUnitInstanceIds } : {}),
    ...(second.targetBattlefieldId !== undefined ? { targetBattlefieldId: second.targetBattlefieldId } : {}),
    ...(second.targetChainCardInstanceId !== undefined ? { targetChainCardInstanceId: second.targetChainCardInstanceId } : {}),
    ...(second.destinationBattlefieldId !== undefined ? { destinationBattlefieldId: second.destinationBattlefieldId } : {}),
    ...(second.destinationIsBase === true ? { destinationIsBase: true as const } : {}),
    ...(second.targetPermanentInstanceId !== undefined ? { targetPermanentInstanceId: second.targetPermanentInstanceId } : {}),
  };
}

/**
 * Resolves a popped chain entry's registered effect, if any — no-ops for
 * any card with no CARD_EFFECTS entry, exactly like today (mirrors the Java
 * oracle's own EffectRegistry.has() safe-no-op guard for an unregistered
 * card name).
 */
export function resolveCardEffect(state: GameState, entry: SpellChainEntry): GameState {
  // The MODE this play chose, or the sole mode of an ordinary card.
  const effect = cardModeOf(entry.card, entry.modeId);
  // Ravenborn Tome's charge ends HERE — "the next spell you play this turn"
  // stops being the next spell once that spell has finished resolving, and its
  // damage happens during the resolution, so the charge has to survive the
  // resolver and be cleared after it. That is one layer later than Raging
  // Firebrand's discount, which is consumed when the spell is paid for.
  //
  // Cleared for EVERY spell, registered or not: a spell with no implementation
  // is still a spell you played, and leaving the charge standing would hand it
  // to the next one.
  //
  // Cleared AFTER both executions of a `[Repeat]`, which is not an oversight:
  // 820.1.d ends "regardless of the number of times a spell or ability's
  // instructions are executed with this keyword, it is only Played once", so a
  // repeated spell is one spell and the charge is spent on the whole of it.
  const clearCharge = (next: GameState): GameState => {
    if (next.players[entry.playerIndex].nextSpellBonusDamage === 0) return next;
    const players = [...next.players] as [typeof next.players[0], typeof next.players[1]];
    players[entry.playerIndex] = { ...players[entry.playerIndex], nextSpellBonusDamage: 0 };
    return { ...next, players };
  };
  if (!effect) return clearCharge(state);
  // Immortal Phoenix's "with a SPELL". Marked around the resolution and cleared
  // straight after, so nothing outside this call can see it — `killerIndex`
  // already says who killed, and this is the only place that knows with what.
  const marked: GameState = { ...state, spellResolvingForIndex: entry.playerIndex };
  // The resolving card names itself through the context — Time Warp's
  // "Banish this" is the first text that needs it.
  const ctx = contextFor(entry.playerIndex, entry.card.instanceId);
  let resolved = effect.resolve(marked, ctx, choicesOf(entry));
  // `[Repeat]` (820.1.d): "execute the instructions of this chain item one
  // additional time during resolution". BACK-TO-BACK, inside this one
  // resolution — 320/321 make Cleanup and resolution mutually exclusive, so
  // nothing can interleave between the two executions and neither needs
  // resuming. That is the whole of the keyword, and it is why this is four
  // lines rather than the suspend-and-continue state machine the engine's own
  // note predicted.
  //
  // The second execution reads the board the FIRST one left behind — Desert's
  // Call's two Sand Soldiers are played one after the other, and Piercing
  // Light's second pair of hits lands on units the first pair may already have
  // killed. 359.3 covers that: a check on something no longer available returns
  // null and calculations based on it are ignored, which is what every helper
  // here already does with a missing target.
  //
  // ONE EXECUTION PER PAID INSTANCE, in the order the action lists them — 820.3,
  // "the spell or ability's instructions will be executed an additional time on
  // resolution for each instance of Repeat that is paid for". For every card but
  // Curtain Call that list is at most one entry long and this loop runs the same
  // single extra pass it always did.
  for (const execution of repeatExecutionsOf(entry)) {
    // **The repeat may switch MODES**, so each additional execution resolves
    // through its own mode rather than reusing the first one's. 820.2.a works
    // this example on Rocket Barrage by name: "they may choose the same mode or a
    // different one, and if they choose the same mode, may choose the same
    // target or a different one." An execution that names no mode reuses the
    // first, which is what "the same choices again" means.
    const repeatMode = execution.choices?.modeId !== undefined
      ? cardModeOf(entry.card, execution.choices.modeId)
      : effect;
    if (repeatMode) resolved = repeatMode.resolve(resolved, ctx, repeatChoicesOf(entry, execution.choices));
  }
  // Temporal Portal's GRANTED instance — 820.3: "the spell or ability's
  // instructions will be executed an additional time on resolution for each
  // instance of Repeat that is paid for". A spell that is both printed-[Repeat]
  // and granted, with both paid, therefore runs THREE times.
  //
  // It reuses the first execution's choices rather than carrying its own, which
  // is the recorded partial: 820.2 gives each execution its own choices at the
  // Make Relevant Choices step, and only the printed instance has a field for
  // them. The same board-reads-the-previous-execution rule applies either way
  // (359.3), so the third pass sees what the second left behind.
  if (entry.grantedRepeatPaid) resolved = effect.resolve(resolved, ctx, choicesOf(entry));
  return { ...clearCharge(resolved), spellResolvingForIndex: null };
}
