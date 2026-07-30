import type { GameState, PlayerState } from "../model/game-state.js";
import type {
  ActivateAbilityAction,
  FloatRuneAction,
  MoveUnitAction,
  PassAction,
  PassFocusAction,
  PlayCardAction,
  PlayerAction,
  RecallUnitAction,
} from "../actions/player-action.js";
import { computeAutoPayment, computeEffectiveCost } from "./rune-payment.js";
import { canPlayToOpenBattlefield, targetingForAnyCard, unitTriggerHasVisionChoice } from "./unit-triggers.js";
import { eligibleTargets, unitWithinMaxMight } from "./target-lookup.js";
import { modifiedEnergyCost } from "./cost-modifiers.js";
import { cardHasOptionalExhaustCost, cardPlacesTokens, slotOwner } from "./card-effects.js";
import { hasActivatableAbility } from "../actions/validate-activate-ability.js";
import { actingPlayerIndex, mayPlayCardNow, mayPlayUnitToBattlefield } from "./timing.js";

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

/** Every legal ActivateAbility candidate for `actor` — one per Ready unit
 *  (base or any battlefield) they control with an activated ability
 *  (currently just Lux-Crownguard). Included in all three branches below,
 *  same permissiveness as floatRuneCandidates — see
 *  validate-activate-ability.ts's own doc comment for why. */
function activateAbilityCandidates(state: GameState, actor: PlayerState, playerIndex: 0 | 1): ActivateAbilityAction[] {
  const ownUnits = [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
  return ownUnits
    .filter((u) => !u.exhausted && hasActivatableAbility(u.defId))
    .map((u) => ({ type: "ActivateAbility", playerIndex, unitInstanceId: u.instanceId }));
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
 * domain-matching pool to draw from anyway. Which cards are candidates in which
 * state is decided per card by `timing.mayPlayCardNow`, reading the printed
 * [Action]/[Reaction] keywords — the same predicate validate-play-card uses.
 * A Spell whose registered effect (card-effects.ts)
 * requires a target fans out into one PlayCardAction per legal target —
 * every unit at any battlefield, either owner, per this slice's
 * un-restricted targeting rule. A Unit ALSO fans out into one additional
 * PlayCardAction per battlefield the actor already has a unit at
 * (direct-to-battlefield "reinforce" — see validate-play-card.ts's
 * presence rule), alongside its unconditional base-play candidate, never
 * replacing it — mirroring the MoveUnit double-loop below it in this same
 * function.
 *
 * Enumerated FOR whoever may act right now — `timing.actingPlayerIndex`: the
 * chain-priority holder while a chain is closed (313), the Focus holder during a
 * Showdown (348), the Turn Player otherwise. That is how "[Action] on any
 * player's turn" (806) needs no special case here: during a Showdown the acting
 * player alternates between both players as Focus passes.
 *
 * Outside a Neutral Open state, MoveUnit/RecallUnit/Pass drop out (their
 * validators reject there, and Action/Reaction are card-play permissions that
 * grant nothing for moving), leaving PassFocus, FloatRune, ActivateAbility, and
 * whichever cards their timing permits. FloatRune is deliberately offered in
 * every state — the real rule lets a player float essentially any time during
 * the Action phase, see validate-float-rune.ts. One scope cut remains: this only
 * ever enumerates for the CURRENT acting player, not "either player regardless
 * of priority."
 */
export function legalActions(state: GameState): PlayerAction[] {
  if (state.phase !== "Action") return [];

  // ONE enumeration path for every state, rather than the three it used to be
  // (a Showdown branch, a closed-chain branch, and the real one). The old shape
  // hard-coded "only PassFocus/FloatRune/ActivateAbility exist outside a Neutral
  // Open state", which is exactly the assumption [Action]/[Reaction] break — and
  // it tested `turnState === "Showdown"` BEFORE `!chainOpen`, so a spell cast
  // into a Showdown would have enumerated for the Focus holder when the rules
  // give priority to the chain (313). `actingPlayerIndex` has that precedence in
  // one place now.
  const playerIndex = actingPlayerIndex(state);
  const actor = state.players[playerIndex];
  const actions: PlayerAction[] = [];

  // "Neutral Open" in rule 310's sense: no Showdown or Combat in progress AND no
  // chain. It's what separates the actions that end a turn or reposition units
  // from the ones a Showdown window allows.
  const isNeutralOpen = state.chainOpen && state.turnState === "Neutral";

  if (isNeutralOpen) {
    const pass: PassAction = { type: "Pass", playerIndex };
    actions.push(pass);
  } else {
    // Passing Focus is the "I decline to respond" move that advances a Showdown
    // (349) or a chain (340).
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex };
    actions.push(passFocus);
  }
  actions.push(...floatRuneCandidates(actor, playerIndex));
  actions.push(...activateAbilityCandidates(state, actor, playerIndex));

  const playableSources = actor.championZone ? [...actor.hand, actor.championZone] : actor.hand;
  for (const card of playableSources) {
    if (card.kind === "Legend") continue;
    // The per-card timing gate, and the whole reason this loop now runs in every
    // state: a Default-tier card is only offered in a Neutral Open state, an
    // [Action] card additionally during Showdowns, a [Reaction] card also onto a
    // closed chain. Same predicate validate-play-card uses, so enumeration and
    // validation can't disagree about what's castable.
    if (!mayPlayCardNow(state, playerIndex, card)) continue;
    const effectiveCost = computeEffectiveCost(
      actor.floatingEnergy,
      actor.floatingPower,
      modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost),
      card.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
      card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
    );
    const payment = computeAutoPayment(
      actor.channeled,
      effectiveCost.energyCost,
      effectiveCost.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
    );
    if (!payment) continue; // can't afford it — not a legal move

    const targeting = targetingForAnyCard(card);

    // Base "effect choice" fan-out: one partial-action-fields variant per
    // legal target (or a single empty variant for "none"/unregistered).
    const effectVariants: Partial<PlayCardAction>[] = [];
    if (targeting.kind === "unit") {
      // eligibleTargets applies the owner constraint AND the spec's scope —
      // "a unit" (Final Spark) includes both bases, "a unit at a battlefield"
      // (Incinerate) does not. Enumerating it here by hand is what let the
      // two gates drift apart in the first place.
      for (const target of eligibleTargets(state, playerIndex, targeting.owner, targeting.scope)) {
        if (!unitWithinMaxMight(state, target, targeting.maxMight)) continue;
        effectVariants.push({ targetUnitInstanceId: target.instanceId });
      }
    } else if (targeting.kind === "battlefield") {
      for (const bf of state.battlefields) effectVariants.push({ targetBattlefieldId: bf.id });
    } else if (targeting.kind === "ownTrashCard") {
      for (const trashCard of actor.trash) {
        if (targeting.cardKind !== undefined && trashCard.kind !== targeting.cardKind) continue;
        effectVariants.push({ trashCardInstanceId: trashCard.instanceId });
      }
    } else if (targeting.kind === "unitSlots") {
      // Every legal FILLING of the two slots, down to `min`:
      //   - min 0 -> the empty choice is legal ("up to two")
      //   - one target -> fills slot 0, so it must satisfy slot 0's role
      //   - two -> slot-0 x slot-1, distinct units
      // The two targets need not share a location; no card here restricts that.
      const forSlot = (slot: 0 | 1) => eligibleTargets(state, playerIndex, slotOwner(targeting.slots[slot]), targeting.scope);
      const firstSlot = forSlot(0);
      const secondSlot = forSlot(1);
      // When both slots take the same role the pair is symmetric, so (A,B) and
      // (B,A) are the SAME choice — enumerating both would double the AI's
      // search space and offer the player a distinction that doesn't exist.
      const symmetric = targeting.slots[0] === targeting.slots[1];

      if (targeting.min === 0) effectVariants.push({});
      if (targeting.min <= 1) {
        for (const only of firstSlot) effectVariants.push({ targetUnitInstanceId: only.instanceId });
      }
      for (const [i, first] of firstSlot.entries()) {
        for (const [j, second] of secondSlot.entries()) {
          if (first.instanceId === second.instanceId) continue;
          if (symmetric && j < i) continue; // keep one ordering of each pair
          effectVariants.push({ targetUnitInstanceId: first.instanceId, secondTargetUnitInstanceId: second.instanceId });
        }
      }
    } else {
      effectVariants.push({});
    }

    // A UNIT's targeting comes from its on-play TRIGGER, and a trigger with
    // no legal choice simply does nothing — it never makes the unit itself
    // unplayable. Without this, Annie-Stubborn was uncastable with an empty
    // trash, First Mate uncastable as your first unit, and Maddened Marauder
    // uncastable with an empty board — in every case a body you paid for,
    // withheld because a bonus couldn't happen. Mirrors the Java oracle,
    // whose UnitAbilities call sites check `candidates.isEmpty()` before
    // opening a choice at all rather than gating the play (see
    // ui/BoardController.java:2143-2151's note on that convention).
    // Spells are deliberately NOT given this treatment: their targeting IS
    // the effect, so "no legal target" really does mean "can't cast."
    if (card.kind === "Unit" && effectVariants.length === 0) effectVariants.push({});

    // [Vision] choice fan-out: every effect variant above also needs a
    // recycle-true and recycle-false copy, since the choice must already be
    // decided in the submitted action (this engine can't pause mid-resolution
    // to ask).
    const hasVision = card.kind === "Unit" && unitTriggerHasVisionChoice(card.defId);
    const afterVision: Partial<PlayCardAction>[] = hasVision
      ? effectVariants.flatMap((v) => [
          { ...v, visionRecycle: true },
          { ...v, visionRecycle: false },
        ])
      : effectVariants;

    // Meditation's optional additional cost: a "decline" copy of every
    // variant above, plus one copy per ready friendly unit (base or
    // battlefield) the caster could exhaust instead — same "the choice must
    // already be decided" reasoning as Vision above.
    const hasOptionalExhaustCost = card.kind === "Spell" && cardHasOptionalExhaustCost(card.defId);
    const variants: Partial<PlayCardAction>[] = hasOptionalExhaustCost
      ? afterVision.flatMap((v) => {
          const readyFriendlyUnits = [
            ...actor.baseUnits.filter((u) => !u.exhausted),
            ...state.battlefields.flatMap((bf) => (bf.units[actor.id] ?? []).filter((u) => !u.exhausted)),
          ];
          return [v, ...readyFriendlyUnits.map((u) => ({ ...v, additionalCostUnitInstanceId: u.instanceId }))];
        })
      : afterVision;

    for (const variant of variants) {
      const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, ...variant };
      actions.push(play);

      // A Unit may ALSO be played directly to a battlefield where the actor
      // already has a unit of their own — "reinforce" — alongside the
      // unconditional base-play candidate just pushed above, never replacing
      // it. Mirrors validate-play-card.ts's presence rule exactly, including
      // the small open-battlefield-placement exception (Sneaky Deckhand, Sai
      // Scout) — those additionally get every OTHER battlefield too, not
      // just ones they already occupy.
      if (card.kind === "Unit") {
        const openPlacement = canPlayToOpenBattlefield(card.defId);
        for (const bf of state.battlefields) {
          const hasPresence = (bf.units[actor.id]?.length ?? 0) > 0;
          if (!hasPresence && !openPlacement) continue;
          // Rule 813 narrows a Unit's destinations outside a Neutral Open state to
          // your base or a battlefield you control. Checked here as well as in the
          // validator, via the same shared predicate: without it, enumeration
          // offered a [Reaction] Unit a reinforce destination the validator then
          // refused, and the AI (which trusts legalActions and calls the executor
          // directly) threw on it mid-game.
          if (!mayPlayUnitToBattlefield(state, playerIndex, bf.id)) continue;
          const reinforce: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, ...variant, destinationBattlefieldId: bf.id };
          actions.push(reinforce);
        }
      }

      // A token-placing Spell (Recruit the Vanguard) fans out the same way,
      // but over battlefields the actor CONTROLS rather than merely occupies
      // — see validate-play-card.ts for why that's a genuinely narrower rule.
      // The base variant is the plain candidate already pushed above.
      if (card.kind === "Spell" && cardPlacesTokens(card.defId)) {
        for (const bf of state.battlefields) {
          if (bf.controllerId !== actor.id) continue;
          actions.push({ type: "PlayCard", playerIndex, card, payment, ...variant, destinationBattlefieldId: bf.id });
        }
      }
    }
  }

  // Moving and recalling are Neutral-Open-only. [Action]/[Reaction] are card-play
  // permissions and grant nothing here — validateMoveUnit/validateRecallUnit
  // reject outside a Neutral Open state, so enumerating them would offer actions
  // the validator refuses. (It's also why a Reaction Unit can't open a second
  // Showdown inside one: rule 813 confines it to your base or a battlefield you
  // already control.)
  if (!isNeutralOpen) return actions;

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
