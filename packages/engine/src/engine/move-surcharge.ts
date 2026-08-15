import type { GameState, PlayerState } from "../model/game-state.js";

/**
 * The rainbow Power an opponent owes to move several units at once onto a
 * battlefield somebody is guarding — UNL-163 Mageseeker Investigator's
 * "opponents must pay [rainbow] for each unit beyond the first to move multiple
 * units to my battlefield at the same time".
 *
 * # The rule being taxed, and why the move path had nothing to add to
 *
 * **144.3**: "Players may perform multiple Units' standard move simultaneously.
 * This is treated as one game action performed on multiple Units." That action's
 * entire cost is **144.2** — "Exhausting the Unit is the Cost for this action" —
 * so before this card there was no rune payment anywhere on the move path, at any
 * of its four sites. That is exactly what three waves refused him on, and it was
 * accurate: `MoveUnitAction` carried no `payment`, the validator named this very
 * surcharge in its own header as an omission, and the executor only exhausted.
 *
 * # It is an APPLIED COST, and the rules name this card as their own example
 *
 * **204.4** — "These Costs are applied to one or more Game Actions, and typically
 * take the form of a passive ability with a Cost within Instructions preceded by
 * 'must'" — and its worked example is this card, quoted in full. Three
 * consequences, all of them load-bearing here:
 *
 *   - **204.4.b**: "Applied Costs are paid as the Game Action is performed. They
 *     do not use the chain and cannot be reacted to." So this is not an effect at
 *     all and no per-card registry could hold it; it belongs on the move path,
 *     charged inline, with no chain item.
 *   - **204.4.c**: "If a player can't pay or chooses not to pay the Applied Cost,
 *     they cannot perform the associated Game Action." So refusing the unpaid
 *     move is not an over-reach — it is the printed rule.
 *   - The barred thing is THE ACTION, and 144.3 makes a simultaneous multi-unit
 *     move ONE action. Moving the same units one at a time is a different action
 *     and stays free. That is the line between "expensive" and "impossible", and
 *     it is what a wave-7 note warned about getting wrong in the other direction.
 *
 * # "Beyond the first", and per battlefield
 *
 * One rainbow per unit after the first, so a two-unit move costs 1 and a
 * single-unit move costs nothing — which is why an engine that only ever
 * enumerates single-unit moves sees this card do nothing. That limitation is the
 * enumerator's and is recorded in docs/rules-conformance.md; a human client
 * builds multi-unit moves directly, so the tax is live in play.
 *
 * Several Investigators at one battlefield do NOT stack: the card says opponents
 * must pay, not that each of them charges. Rule 366 makes each a separate
 * continuous ability, but they impose the same requirement rather than additive
 * ones — the same reading `[Deflect]` takes for two copies of one keyword value.
 */
const MAGESEEKER_INVESTIGATOR = "UNL-163";

/** Every unit `playerIndex` has standing at `battlefieldId`. */
function unitsAt(state: GameState, playerIndex: 0 | 1, battlefieldId: string) {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return bf?.units[state.players[playerIndex].id] ?? [];
}

/**
 * The rainbow Power `moverIndex` owes to move `unitCount` units to
 * `battlefieldId` in one action, or 0 when nothing taxes it.
 *
 * Asked by the validator and by the executor off the same function, so a move
 * that is accepted and a move that is charged cannot come apart — the split this
 * engine has shipped five times on the play path.
 */
export function moveSurchargeFor(
  state: GameState,
  moverIndex: 0 | 1,
  battlefieldId: string,
  unitCount: number,
): number {
  // **A floor, not the "beyond the first" rule** — that is the `- 1` below, and
  // the two are easy to confuse. Mutating this `2` to a `1` changes nothing for
  // any count a move can actually have (a one-unit move returns `1 - 1 = 0`
  // either way), which is measured rather than assumed. What it guards is
  // `unitCount === 0`, where the subtraction would return -1: the validator
  // refuses an empty move before this is ever asked, but this function is
  // exported and a negative surcharge would be a silent refund.
  if (unitCount < 2) return 0;
  const opponentIndex: 0 | 1 = moverIndex === 0 ? 1 : 0;
  const guarded = unitsAt(state, opponentIndex, battlefieldId).some((u) => u.defId === MAGESEEKER_INVESTIGATOR);
  return guarded ? unitCount - 1 : 0;
}

/**
 * Recycles the named runes to pay a move surcharge, or undefined when the pool
 * cannot cover them.
 *
 * **No floating-Energy credit**, unlike a rune recycled for the controller's own
 * Power. 164.2's double duty is about paying YOUR cost; a tax handed to an
 * opponent refunds nothing — the same line `execute-play-card` and
 * `recycleRunesForSurcharge` already draw for a `[Deflect]` surcharge, and this
 * is the same kind of thing.
 */
export function payMoveSurcharge(state: GameState, moverIndex: 0 | 1, runeIds: readonly string[]): GameState | undefined {
  if (runeIds.length === 0) return state;
  const actor = state.players[moverIndex];
  const spent = actor.channeled.filter((r) => runeIds.includes(r.id));
  if (spent.length < runeIds.length) return undefined;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[moverIndex] = {
    ...actor,
    channeled: actor.channeled.filter((r) => !runeIds.includes(r.id)),
    runeDeck: [...actor.runeDeck, ...spent.map((r) => ({ ...r, state: "Ready" as const }))],
  };
  return { ...state, players };
}

/** For coverage.ts — the cards whose whole implementation is this seam. */
export function moveSurchargeDefIds(): string[] {
  return [MAGESEEKER_INVESTIGATOR];
}
