import type { BattlefieldState, GameState } from "../model/game-state.js";
import { removeUnheldHiddenCards } from "./hidden.js";
import { holdEventTrigger } from "./triggers.js";
import { attackerIndexAt, unitsPresentAt } from "./combat-designation.js";
import { holdBattlefieldTrigger } from "./battlefield-abilities.js";
import { returnLapsedGearControl } from "./equipment.js";

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
 * This is also a deliberate single pass, not rule 322's repeat-until-nothing-
 * notable loop — a known structural divergence tracked in
 * docs/rules-conformance.md.
 */
export function runCleanup(state: GameState): GameState {
  // Step 5 sits between them, and the ordering is forced: control must lapse
  // (step 4) before facedown cards are checked against who controls their
  // battlefield, or a card would survive one extra Cleanup at a battlefield its
  // owner had already lost.
  // `returnLapsedGearControl` sits beside step 4's control lapse, because it is
  // the same kind of thing one zone over: Akshan - Mischievous' borrowed gear goes
  // home the moment he leaves the board, and "leaves the board" is not "dies" —
  // a recall or a banish ends the loan too, which is why it is a per-Cleanup sweep
  // rather than a death-watch.
  return finalizePendingTriggers(
    designateArrivals(stageShowdowns(removeUnheldHiddenCards(returnLapsedGearControl(lapseUnoccupiedControl(state))))),
  );
}

/**
 * Moves triggers that have fired from the holding pen onto the chain, closing it —
 * the Finalize step of the chain's finalize/resolve loop (337-345).
 *
 * A trigger is on the Chain from the moment it fires (383), but as a **Pending
 * Item**, which is not respondable: 345 awards priority to the newest item's
 * controller only "if the Chain is not empty and there are **no Pending Items**".
 * `state.pendingTriggers` is that Pending portion; this is where they become
 * Finalized and a response window actually opens.
 *
 * **Why here.** `runCleanup` is the only hook that runs after every resolved action
 * in BOTH `submit` (via withCleanupAndWinnerCheck) and the AI's lookahead (via
 * heuristic-ai's applyAction and its settle loop). Finalizing in `submit` instead
 * would leave the lookahead scoring boards whose triggers never resolved — silently,
 * since `evaluate` reads points/might/hand/gear and none of those reveal a full pen.
 *
 * **Why last.** Staging a Showdown fires `combatBegan` (step 6, above), and those
 * triggers belong on the chain this Cleanup produces rather than waiting for the
 * next one. Running before `stageShowdowns` would also close the chain first, and
 * step 6 refuses to stage while the chain is closed.
 *
 * A pending DECISION never reaches here — `withCleanupAndWinnerCheck` returns before
 * `runCleanup` while the queue is non-empty (321, a Cleanup cannot occur inside
 * a resolution), so a mid-resolution question defers finalization with everything else.
 *
 * **Order.** The pen is appended to in listener-walk order, which is turn order
 * (383: "starting with the Turn Player and proceeding in Turn Order, each player
 * orders their Triggered Abilities on the Chain"), and the chain resolves LIFO
 * (340.1). Pushing in pen order therefore resolves the NON-turn player's triggers
 * first, which is what those two rules together require — see allListeningPermanents.
 */
function finalizePendingTriggers(state: GameState): GameState {
  if (state.pendingTriggers.length === 0) return state;

  const spellChain = [...state.spellChain, ...state.pendingTriggers];
  const newTop = spellChain[spellChain.length - 1]!;
  return {
    ...state,
    pendingTriggers: [],
    spellChain,
    chainOpen: false,
    chainPasses: 0,
    // 345: the controller of the newest item gains priority for a fresh round.
    chainPriority: newTop.playerIndex,
    // 346.1's exception is about how the chain OPENED, so it is only set when this
    // finalize is what closed it. A trigger finalized onto a chain a Spell already
    // opened leaves that answer alone.
    chainOpenedByTrigger: state.chainOpen ? true : state.chainOpenedByTrigger,
  };
}

/**
 * Applies Contested status at `battlefieldId` on behalf of `playerIndex`, if the
 * rules call for it.
 *
 * Rule 450: "The Destination becomes Contested if it is an Uncontested
 * Battlefield not controlled by the controller of the Unit or Units that moved."
 * Rule 190.3.a says the same from the status side — Contested applies when a unit
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
 * (323.8 / 341), which is what `stageShowdowns` below does.
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

/** Contested ends when Control is established or re-established (190.3.b) —
 *  i.e. when a Showdown closes, not merely when the window ends. Called by the
 *  close paths in combat.ts. */
export function clearContested(state: GameState, battlefieldId: string): GameState {
  const bfIndex = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (bfIndex === -1) return state;
  const bf = state.battlefields[bfIndex]!;
  if (bf.contestedByIndex === null) return state;
  const battlefields = [...state.battlefields];
  // The designation record belongs to the combat that is ending, not to the
  // battlefield — leaving it would make the next combat here treat every unit
  // already standing there as long since designated.
  battlefields[bfIndex] = { ...bf, contestedByIndex: null, designatedInstanceIds: [] };
  return { ...state, battlefields };
}

/** Do units belonging to both players stand here? The rules' test for whether a
 *  Contested battlefield produces a Combat (344.1) rather than a stand-alone
 *  Non-Combat Showdown (316.8.b.1). */
function unitsOfBothPlayers(state: GameState, bf: BattlefieldState): boolean {
  return ([0, 1] as const).every((index) => (bf.units[state.players[index].id]?.length ?? 0) > 0);
}

/**
 * Cleanup step 6 (rule 323, "Mark a Showdown as Staged at each Battlefield that
 * Contested was applied to"), plus rule 316.8.b.1.a's mid-window promotion.
 *
 * Rule 341 is where the conditions come from: "A Showdown begins when Control of
 * a Battlefield is Contested during a Cleanup and the turn is in a Neutral Open
 * State." Both halves matter — this is the *Cleanup* that opens the window, not
 * the Move that applied Contested, and it only happens from a Neutral Open
 * state, so a Showdown can't open while another is running or while a Spell is
 * on the chain.
 *
 * Which kind, per 344.1: "If Control of a Battlefield is Contested between two
 * players, then a Showdown will be opened as the first step of Combat", versus
 * "If Control of a Battlefield is Contested, there aren't units controlled by
 * different players there... a Showdown is opened during the next Cleanup" —
 * the Non-Combat case (316.8.b.1), which is the one entering an empty battlefield
 * produces and which this engine previously skipped entirely by claiming
 * control on the spot.
 *
 * Focus goes to whoever applied Contested (345: "As a Showdown begins, the
 * player who applied Contested status to the Battlefield gains Focus"), which is
 * why `contestedByIndex` records them rather than assuming the Turn Player.
 */
function stageShowdowns(state: GameState): GameState {
  // 316.8.b.1.a: a Non-Combat Showdown "will cause the Showdown to become a Combat
  // Showdown in the following cleanup" once another player's units arrive —
  // reachable now that an opponent holding Focus can cast a token-making Spell
  // at Action speed into the window.
  if (state.turnState === "Showdown" && state.showdownKind === "NonCombat") {
    const bf = state.battlefields.find((b) => b.id === state.showdownBattlefieldId);
    if (bf && unitsOfBothPlayers(state, bf)) {
      return beginCombatAt({ ...state, showdownKind: "Combat" }, bf.id);
    }
    return state;
  }

  // "the turn is in a Neutral Open State" — one Showdown at a time, and none
  // while a chain is pending. A battlefield stays Contested until a Cleanup can
  // legally stage it, so nothing is lost by waiting.
  if (state.turnState !== "Neutral" || !state.chainOpen) return state;

  const contested = state.battlefields.find((bf) => bf.contestedByIndex !== null);
  if (!contested) return state;

  const isCombat = unitsOfBothPlayers(state, contested);
  const staged: GameState = {
    ...state,
    turnState: "Showdown",
    showdownBattlefieldId: contested.id,
    showdownKind: isCombat ? "Combat" : "NonCombat",
    focusHolder: contested.contestedByIndex!,
    consecutiveFocusPasses: 0,
  };
  // **344, and it fires for BOTH kinds** — "A Showdown begins when Control of a
  // Battlefield is Contested during a Cleanup and the turn is in a Neutral Open
  // State", which says nothing about anyone being there to fight. A Non-Combat
  // Showdown is a showdown that began, and before this event existed a "when a
  // showdown begins" listener saw nothing in that case, because `beginCombatAt`
  // below is the only thing that fired.
  //
  // Held BEFORE the combat is staged, so the two land on the chain in the order
  // they happened: the showdown began, and then (sometimes) a combat opened
  // inside it.
  const announced = holdEventTrigger(
    staged,
    {
      kind: "showdownBegan",
      battlefieldId: contested.id,
      showdownKind: isCombat ? "Combat" : "NonCombat",
      contestedByIndex: contested.contestedByIndex!,
    },
    contested.contestedByIndex!,
  );
  // Only a COMBAT Showdown has attackers and defenders — a Non-Combat one is a
  // window with nobody to fight, so "attacks or defends alone" is not true of
  // anyone in it, and nobody gains the Attacker designation an Attack Trigger
  // waits on. It fires later if 316.8.b.1.a promotes it.
  return isCombat ? beginCombatAt(announced, contested.id) : announced;
}

/**
 * Combat Step 1 (464.2.c): the units at `battlefieldId` gain their Attacker and
 * Defender designations, and everything that watches for that moment fires.
 *
 * ONE mechanism, since 2026-08-03: `combatBegan` is HELD (383 / 808.1.d.3), so
 * every "when I attack", "when I defend" and "when a friendly unit attacks alone"
 * becomes a Chain Pending Item and is respondable. `runCleanup` finalizes the pen
 * immediately after `stageShowdowns` for exactly this reason.
 *
 * **Ahri - Nine-Tailed Fox's Legend hook is in that same call now.** It was fired
 * inline here, per attacking unit, for the one session in which `combatBegan` was
 * held but the Legend zone was still outside `allListeningPermanents`. It is a
 * listener like any other now; her per-unit multiplicity is carried by the
 * trigger's `capture` instead, which is recorded as a divergence — one Pending
 * Item covering every attacker, where the rules would give one per attacker.
 *
 * The guard stays: a battlefield that is not contested has no Attacker, so there
 * are no designations to hand out and nothing to fire.
 */
function beginCombatAt(state: GameState, battlefieldId: string): GameState {
  const attackerIndex = attackerIndexAt(state, battlefieldId);
  if (attackerIndex === null) return state;
  const designated = designate(state, battlefieldId, unitsPresentAt(state, battlefieldId), attackerIndex);

  // The BATTLEFIELD's own "when you defend here" (Fortified Position, Reaver's
  // Row), fired ONCE as the combat opens and deliberately NOT from
  // `designateArrivals` below. "You defend here" is a claim about the PLAYER, and
  // a player who is already defending does not begin to defend again because a
  // reinforcement walked in — that is 383.4.f's "for the first time during a
  // combat" applied to the side rather than to the unit.
  //
  // Guarded on the defender actually having units present, so a Non-Combat
  // Showdown promoted with nobody on the other side cannot fire it. Placed after
  // the units' own combat triggers, so it resolves before them under LIFO.
  const defenderIndex: 0 | 1 = attackerIndex === 0 ? 1 : 0;
  const bf = designated.battlefields.find((b) => b.id === battlefieldId);
  if ((bf?.units[designated.players[defenderIndex].id]?.length ?? 0) === 0) return designated;
  return holdBattlefieldTrigger(designated, "defend", battlefieldId, defenderIndex);
}

/**
 * Records `designated` against the battlefield and fires `combatBegan` for them.
 *
 * The record is what makes 383.4.f's "for the FIRST time during a combat"
 * enforceable: a unit already in it is not gaining a designation again.
 */
function designate(state: GameState, battlefieldId: string, designated: readonly string[], attackerIndex: 0 | 1): GameState {
  if (designated.length === 0) return state;
  const withRecord: GameState = {
    ...state,
    battlefields: state.battlefields.map((bf) =>
      bf.id === battlefieldId
        ? { ...bf, designatedInstanceIds: [...(bf.designatedInstanceIds ?? []), ...designated] }
        : bf,
    ),
  };
  // 465 Step 4: the ATTACKING player places first here, not the turn player.
  // Placement is the opposite of resolution (340.1), so this makes the defender's
  // combat triggers resolve first.
  return holdEventTrigger(withRecord, { kind: "combatBegan", battlefieldId, designated }, attackerIndex);
}

/**
 * 464.2.c Step 1, second sentence: a unit that becomes present at a battlefield where
 * a combat is running "will gain the Attacker or Defender designation during the
 * Cleanup phase following the action that caused it to become present".
 *
 * So a reinforcement's Attack Trigger fires a Cleanup after it walks in, and the
 * units already in the fight do not fire again — which is what the battlefield's
 * designation record is for.
 */
function designateArrivals(state: GameState): GameState {
  if (state.turnState !== "Showdown" || state.showdownKind !== "Combat") return state;
  const bf = state.battlefields.find((b) => b.id === state.showdownBattlefieldId);
  if (!bf) return state;
  const attackerIndex = attackerIndexAt(state, bf.id);
  if (attackerIndex === null) return state;
  const already = new Set(bf.designatedInstanceIds ?? []);
  const arrivals = unitsPresentAt(state, bf.id).filter((id) => !already.has(id));
  return designate(state, bf.id, arrivals, attackerIndex);
}

/**
 * Cleanup step 4 (rule 323.6): "Players lose control of any controlled
 * Battlefields without their Units occupying them if the turn is in an Open
 * State and there is no Showdown or Combat ongoing there." Rule 190.4.c states the
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
    // Rule 190.4.b again: "While a Combat or Showdown is ongoing at a Battlefield,
    // Control of that Battlefield cannot change until instructed by steps of the
    // Combat or Showdown." Combat's own steps establish control when it ends
    // (466.5, see combat.establishControlAfterCombat).
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
