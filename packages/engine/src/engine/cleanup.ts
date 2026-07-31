import type { BattlefieldState, GameState } from "../model/game-state.js";
import { removeUnheldHiddenCards } from "./hidden.js";

/**
 * The Cleanup, run after every resolved action.
 *
 * Rule 323 lists the Cleanup's steps in order; the ones implemented here are
 * **step 4** (control lapsing), **step 5** (removing facedown cards from
 * battlefields their owner no longer controls) and **step 6** (staging Showdowns
 * at Contested battlefields), in that order. The rest are either already handled
 * where they happen (lethal damage at the point damage is dealt, see
 * effect-helpers.dealDamage; Deathknell in effect-helpers.killUnit) or belong to
 * mechanics this engine doesn't model yet (unattached Gear/Rune recall). Add each
 * here as its mechanic lands, rather than building an empty framework for all
 * of them.
 *
 * Step order matters between the two that exist: control must lapse before
 * Showdowns are staged, because "Contested" is defined relative to who controls
 * the battlefield (458) — a battlefield whose control just lapsed is
 * Uncontrolled, and staging reads that.
 *
 * This is also a deliberate single pass, not rule 318's repeat-until-nothing-
 * notable loop — a known structural divergence tracked in
 * docs/rules-conformance.md.
 */
export function runCleanup(state: GameState): GameState {
  // Step 5 sits between them, and the ordering is forced: control must lapse
  // (step 4) before facedown cards are checked against who controls their
  // battlefield, or a card would survive one extra Cleanup at a battlefield its
  // owner had already lost.
  return stageShowdowns(removeUnheldHiddenCards(lapseUnoccupiedControl(state)));
}

/**
 * Applies Contested status at `battlefieldId` on behalf of `playerIndex`, if the
 * rules call for it.
 *
 * Rule 458: "The Destination becomes Contested if it is an Uncontested
 * Battlefield not controlled by the controller of the Unit or Units that moved."
 * Rule 190.4 says the same from the status side — Contested applies when a unit
 * of a player who "does not currently Control that Battlefield Moves or
 * otherwise becomes present there", and only "if that battlefield is not already
 * Contested".
 *
 * So this is a no-op in exactly two cases, both of which matter:
 *   - reinforcing a battlefield you already control (no Contested, no Showdown —
 *     otherwise every reinforcing move would open a window);
 *   - one that's already Contested (the status doesn't stack, and the Showdown
 *     already staged or running there is the one that resolves it).
 *
 * "or otherwise becomes present" is why this is a shared helper rather than
 * inline in the move path: a unit can arrive by being played directly to a
 * battlefield, or by a Spell creating tokens there (Recruit the Vanguard) —
 * which previously opened no Showdown at all.
 *
 * The Showdown itself is NOT opened here. That happens in the next Cleanup
 * (316.9 / 341), which is what `stageShowdowns` below does.
 */
export function applyContested(state: GameState, battlefieldId: string, playerIndex: 0 | 1): GameState {
  const bfIndex = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  if (bf.contestedByIndex !== null) return state;
  if (bf.controllerId === state.players[playerIndex].id) return state;

  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, contestedByIndex: playerIndex };
  return { ...state, battlefields };
}

/** Contested ends when Control is established or re-established (190.6.a) —
 *  i.e. when a Showdown closes, not merely when the window ends. Called by the
 *  close paths in combat.ts. */
export function clearContested(state: GameState, battlefieldId: string): GameState {
  const bfIndex = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  if (bf.contestedByIndex === null) return state;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, contestedByIndex: null };
  return { ...state, battlefields };
}

/** Do units belonging to both players stand here? The rules' test for whether a
 *  Contested battlefield produces a Combat (341) rather than a stand-alone
 *  Non-Combat Showdown (317.1). */
function unitsOfBothPlayers(state: GameState, bf: BattlefieldState): boolean {
  return ([0, 1] as const).every((index) => (bf.units[state.players[index].id]?.length ?? 0) > 0);
}

/**
 * Cleanup step 6 (rule 323, "Mark a Showdown as Staged at each Battlefield that
 * Contested was applied to"), plus rule 317.2's mid-window promotion.
 *
 * Rule 341 is where the conditions come from: "A Showdown begins when Control of
 * a Battlefield is Contested during a Cleanup and the turn is in a Neutral Open
 * State." Both halves matter — this is the *Cleanup* that opens the window, not
 * the Move that applied Contested, and it only happens from a Neutral Open
 * state, so a Showdown can't open while another is running or while a Spell is
 * on the chain.
 *
 * Which kind, per 341: "If Control of a Battlefield is Contested between two
 * players, then a Showdown will be opened as the first step of Combat", versus
 * "If Control of a Battlefield is Contested, there aren't units controlled by
 * different players there... a Showdown is opened during the next Cleanup" —
 * the Non-Combat case (317.1), which is the one entering an empty battlefield
 * produces and which this engine previously skipped entirely by claiming
 * control on the spot.
 *
 * Focus goes to whoever applied Contested (345: "As a Showdown begins, the
 * player who applied Contested status to the Battlefield gains Focus"), which is
 * why `contestedByIndex` records them rather than assuming the Turn Player.
 */
function stageShowdowns(state: GameState): GameState {
  // 317.2: a Non-Combat Showdown "will cause the Showdown to become a Combat
  // Showdown in the following cleanup" once another player's units arrive —
  // reachable now that an opponent holding Focus can cast a token-making Spell
  // at Action speed into the window.
  if (state.turnState === "Showdown" && state.showdownKind === "NonCombat") {
    const bf = state.battlefields.find((b) => b.id === state.showdownBattlefieldId);
    if (bf && unitsOfBothPlayers(state, bf)) return { ...state, showdownKind: "Combat" };
    return state;
  }

  // "the turn is in a Neutral Open State" — one Showdown at a time, and none
  // while a chain is pending. A battlefield stays Contested until a Cleanup can
  // legally stage it, so nothing is lost by waiting.
  if (state.turnState !== "Neutral" || !state.chainOpen) return state;

  const contested = state.battlefields.find((bf) => bf.contestedByIndex !== null);
  if (!contested) return state;

  return {
    ...state,
    turnState: "Showdown",
    showdownBattlefieldId: contested.id,
    showdownKind: unitsOfBothPlayers(state, contested) ? "Combat" : "NonCombat",
    focusHolder: contested.contestedByIndex!,
    consecutiveFocusPasses: 0,
  };
}

/**
 * Cleanup step 4 (rule 323.11): "Players lose control of any controlled
 * Battlefields without their Units occupying them if the turn is in an Open
 * State and there is no Showdown or Combat ongoing there." Rule 190.6 states the
 * same thing from the Control side: "If a player has no Units at a Battlefield
 * and the turn is in an Open state, they lose Control of that Battlefield in the
 * following cleanup unless there is a Combat or Showdown ongoing there."
 *
 * Before this existed, control was only ever lost through combat (the mutual-wipe
 * branch of `resolveShowdown`). A player who simply moved or recalled their last
 * unit away kept `controllerId` forever, which produced a state the rules don't
 * allow — controlled, but unoccupied — and that state is a dead end for scoring:
 * its controller can't Hold it (scoring.isHeldBy requires units present) and
 * can't Conquer it (they already control it). Reached by both players on both
 * battlefields with empty rune decks, nobody could act again: measured at 6 of 16
 * self-play games where one side only passes, one running to turn 1988 with the
 * leader frozen on 6 points.
 *
 * The two guards are the rule's own, and neither is optional:
 *
 *   - **Open State** is about the CHAIN, not about Showdowns: rule 310 defines
 *     the four states as Neutral/Showdown crossed with Open/Closed, where "if a
 *     Chain exists, the turn is in a Closed State". So this is `chainOpen`, and a
 *     Showdown does NOT by itself make the turn closed.
 *   - **"ongoing there"** is per-battlefield. A Showdown at one battlefield does
 *     not protect control of a different one, so the guard compares against
 *     `showdownBattlefieldId` rather than just checking `turnState`. This matters
 *     for the real case of moving your last unit off battlefield A into a
 *     contested battlefield B: B is protected, A must still lapse.
 */
function lapseUnoccupiedControl(state: GameState): GameState {
  // Closed State (a Spell pending resolution) — nothing lapses until it opens
  // again, and it will, since the chain always resolves.
  if (!state.chainOpen) return state;

  let changed = false;
  const battlefields = state.battlefields.map((bf) => {
    if (bf.controllerId === null) return bf; // already Uncontrolled
    // Rule 190.6 again: "While a Combat or Showdown is ongoing at a Battlefield,
    // Control of that Battlefield cannot change until instructed by steps of the
    // Combat or Showdown." Combat's own steps establish control when it ends
    // (466.7, see combat.establishControlAfterCombat).
    if (state.turnState === "Showdown" && state.showdownBattlefieldId === bf.id) return bf;
    if ((bf.units[bf.controllerId] ?? []).length > 0) return bf;
    changed = true;
    return { ...bf, controllerId: null };
  });

  // Returning the same object when nothing lapsed keeps this cheap to call after
  // every single action, and keeps referential equality for the UI's own
  // memoization (GameBoard re-derives from `state` identity).
  return changed ? { ...state, battlefields } : state;
}
