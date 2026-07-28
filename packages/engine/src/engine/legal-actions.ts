import type { GameState, PlayerState } from "../model/game-state.js";
import type {
  FloatRuneAction,
  MoveUnitAction,
  PassAction,
  PassFocusAction,
  PlayCardAction,
  PlayerAction,
  RecallUnitAction,
} from "../actions/player-action.js";
import { computeAutoPayment, computeEffectiveCost } from "./rune-payment.js";
import { effectForCard, requiresTarget } from "./card-effects.js";

/** Every legal FloatRune candidate for `actor` — one Energy-mode candidate
 *  per Ready rune, one Power-mode (recycle) candidate per rune regardless
 *  of state (mirrors validateFloatRune's own Ready-only-for-Energy rule).
 *  Used in all three branches below (Neutral, Showdown, closed-chain),
 *  since the real rule lets a player float at essentially any time during
 *  the Action phase — see validate-float-rune.ts's own doc comment. */
function floatRuneCandidates(actor: PlayerState, playerIndex: 0 | 1): FloatRuneAction[] {
  const actions: FloatRuneAction[] = [];
  for (const rune of actor.channeled) {
    if (rune.state === "Ready") {
      actions.push({ type: "FloatRune", playerIndex, runeId: rune.id, forPower: false });
    }
    actions.push({ type: "FloatRune", playerIndex, runeId: rune.id, forPower: true });
  }
  return actions;
}

/**
 * Enumerates every currently-legal PlayerAction for the active player (or,
 * during an open Showdown, for whoever holds Focus — not necessarily the
 * same player). Unlike the Java oracle (which has no single generic
 * enumerator — HeuristicAI builds its own ad hoc candidate list per action
 * type, engine/HeuristicAI.java:367-425), this is a real shared contract:
 * both the AI and the UI's "what can I click" logic consume the same
 * function, so they can't drift on what's legal.
 *
 * Scoped to what's implemented: PlayCard for Units/Spells/Gear from hand or
 * the Champion Zone (Unit only), with an auto-computed rune payment covering
 * both Energy and domain-restricted Power costs (no Legend play, no
 * Accelerate/additional costs, no EquipGear), MoveUnit for every ready unit
 * to every battlefield it can legally reach, RecallUnit for every ready
 * unit at a battlefield, and Pass. `computeAutoPayment` picks a single
 * minimal valid payment rather than exploring every possible rune
 * selection — which specific rune covers a domain-agnostic Energy cost
 * never changes the outcome, and for Power there's exactly one eligible
 * domain-matching pool to draw from anyway. Every Spell in hand is a legal
 * PlayCard candidate regardless of its isAction/isReaction tags — those
 * only gate Showdown/reaction-speed timing (not modeled here), never a
 * normal-turn cast. A Spell whose registered effect (card-effects.ts)
 * requires a target fans out into one PlayCardAction per legal target —
 * every unit at any battlefield, either owner, per this slice's
 * un-restricted targeting rule. A Unit ALSO fans out into one additional
 * PlayCardAction per battlefield the actor already has a unit at
 * (direct-to-battlefield "reinforce" — see validate-play-card.ts's
 * presence rule), alongside its unconditional base-play candidate, never
 * replacing it — mirroring the MoveUnit double-loop below it in this same
 * function.
 *
 * While a Showdown is open, almost none of the above are legal (mirrors
 * ActionValidator.validateShowdownOpen's hard rejection of MoveUnit/Pass,
 * plus the fact that no Spell/Reaction-speed card is castable there yet) —
 * the only OTHER candidate is PassFocus, for whoever currently holds Focus.
 * Likewise while the chain is closed (a Spell is pending resolution) — no
 * reaction-speed cards can be played onto an already-closed chain yet, so
 * the only other candidate is PassFocus, for whoever holds chain priority.
 * FloatRune is the one exception to all of this: the real rule lets a
 * player float a rune essentially any time during the Action phase,
 * regardless of turnState/chainOpen, so it's included in every branch
 * below for whoever currently holds priority in that branch — see
 * validate-float-rune.ts's own doc comment for the full permissiveness
 * this mirrors (and the one deliberate scope cut: this engine still only
 * ever enumerates for the CURRENT priority-holder, not "either player
 * regardless of priority," since neither this function's per-call shape
 * nor the UI has ever supported acting outside that).
 */
export function legalActions(state: GameState): PlayerAction[] {
  if (state.phase !== "Action") return [];

  if (state.turnState === "Showdown") {
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex: state.focusHolder };
    return [passFocus, ...floatRuneCandidates(state.players[state.focusHolder], state.focusHolder)];
  }

  if (!state.chainOpen) {
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex: state.chainPriority };
    return [passFocus, ...floatRuneCandidates(state.players[state.chainPriority], state.chainPriority)];
  }

  const playerIndex = state.activePlayerIndex;
  const actor = state.players[playerIndex];
  const actions: PlayerAction[] = [];

  const pass: PassAction = { type: "Pass", playerIndex };
  actions.push(pass);
  actions.push(...floatRuneCandidates(actor, playerIndex));

  const playableSources = actor.championZone ? [...actor.hand, actor.championZone] : actor.hand;
  for (const card of playableSources) {
    if (card.kind === "Legend") continue;
    const effectiveCost = computeEffectiveCost(
      actor.floatingEnergy,
      actor.floatingPower,
      card.energyCost,
      card.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
    );
    const payment = computeAutoPayment(
      actor.channeled,
      effectiveCost.energyCost,
      effectiveCost.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
    );
    if (!payment) continue; // can't afford it — not a legal move

    if (requiresTarget(effectForCard(card))) {
      for (const bf of state.battlefields) {
        for (const targets of Object.values(bf.units)) {
          for (const target of targets) {
            const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, targetUnitInstanceId: target.instanceId };
            actions.push(play);
          }
        }
      }
      continue;
    }

    const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment };
    actions.push(play);

    // A Unit may ALSO be played directly to any battlefield where the actor
    // already has a unit of their own — "reinforce" — alongside the
    // unconditional base-play candidate just pushed above, never replacing
    // it. Mirrors validate-play-card.ts's presence rule exactly.
    if (card.kind === "Unit") {
      for (const bf of state.battlefields) {
        if ((bf.units[actor.id]?.length ?? 0) === 0) continue;
        const reinforce: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, destinationBattlefieldId: bf.id };
        actions.push(reinforce);
      }
    }
  }

  for (const unit of actor.baseUnits) {
    if (unit.exhausted) continue;
    for (const bf of state.battlefields) {
      const move: MoveUnitAction = {
        type: "MoveUnit",
        playerIndex,
        unitInstanceIds: [unit.instanceId],
        destinationBattlefieldId: bf.id,
      };
      actions.push(move);
    }
  }

  for (const bf of state.battlefields) {
    const unitsHere = bf.units[actor.id] ?? [];
    for (const unit of unitsHere) {
      if (unit.exhausted) continue;

      const recall: RecallUnitAction = { type: "RecallUnit", playerIndex, unitInstanceIds: [unit.instanceId] };
      actions.push(recall);

      if (!("Ganking" in unit.keywords)) continue;
      for (const dest of state.battlefields) {
        if (dest.id === bf.id) continue;
        const move: MoveUnitAction = {
          type: "MoveUnit",
          playerIndex,
          unitInstanceIds: [unit.instanceId],
          destinationBattlefieldId: dest.id,
        };
        actions.push(move);
      }
    }
  }

  return actions;
}
