import type { GameState, PlayerState } from "../model/game-state.js";
import type {
  ActivateAbilityAction,
  FloatRuneAction,
  HideCardAction,
  MoveUnitAction,
  PassAction,
  PassFocusAction,
  PlayCardAction,
  PlayerAction,
  RecallUnitAction,
} from "../actions/player-action.js";
import { computeAutoPayment, computeEffectiveCost } from "./rune-payment.js";
import { mayPlaceOnOpenBattlefield, targetingForAnyCard, unitTriggerHasVisionChoice } from "./unit-triggers.js";
import { eligibleTargets, findUnitOnBattlefield, shareABattlefield, unitOrGearTargets, unitWithinMaxMight } from "./target-lookup.js";
import { modifiedEnergyCost } from "./cost-modifiers.js";
import { cardMovesTarget, cardPlacesTokens, discardChoiceOf, optionalUnitCostOf, slotOwner, slotScope } from "./card-effects.js";
import {
  abilitiesAvailableTo,
  activationCostOf,
  activationPayment,
  availableModes,
  canPayActivationCost,
} from "./activated-abilities.js";
import {
  ACCELERATE_ENERGY,
  ACCELERATE_POWER,
  acceleratePowerDomain,
  actingPlayerIndex,
  hasAccelerate,
  mayPlayCardNow,
  mayPlayUnitToBattlefield,
} from "./timing.js";
import { HIDE_POWER_COST, RAINBOW, hiddenCardIsPlayable, isHiddenCard } from "./hidden.js";
import { hasKeyword } from "./granted-keywords.js";
import { optionsFor, pendingDecision } from "./decisions.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import type { CardInstance } from "../model/card.js";

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
 * Every legal ActivateAbility candidate for `actor` — one per Ready permanent
 * they control that has an activated ability, fanned out per legal target where
 * the ability targets.
 *
 * `activeGear` is in the scan now, not just units: the ":rb_exhaust::" cost is on
 * 20 of the 30 Gear in this pool, and while this only looked at base and
 * battlefield units none of them could ever be activated.
 *
 * Included in all three branches below, same permissiveness as
 * floatRuneCandidates — see validate-activate-ability.ts's own doc comment.
 */
function activateAbilityCandidates(state: GameState, actor: PlayerState, playerIndex: 0 | 1): ActivateAbilityAction[] {
  const owned: { instanceId: string; defId: string; exhausted: boolean; buffed?: boolean }[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    // The legend zone, which is not on the board — two preset legends have an
    // exhaust ability and were unreachable while this list held board zones only.
    actor.legend,
  ];

  const out: ActivateAbilityAction[] = [];
  for (const permanent of owned) {
    // A list, not a lookup: Heimerdinger offers every friendly permanent's
    // ability with himself as the source, so one card can be several candidates.
    for (const { abilityDefId } of abilitiesAvailableTo(state, playerIndex, permanent)) {
      // Asks the same payability question the validator does — an exhaust, a
      // Recycle, a spent Buff and an Energy cost fail for different reasons, and
      // only the registry knows which this ability has.
      if (!canPayActivationCost(state, playerIndex, permanent, abilityDefId)) continue;

      const cost = activationCostOf(abilityDefId);
      const payment =
        cost.energy !== undefined ? activationPayment(state, playerIndex, cost.energy) : undefined;
      if (cost.energy !== undefined && payment === undefined) continue;

      const base: ActivateAbilityAction = {
        type: "ActivateAbility",
        playerIndex,
        permanentInstanceId: permanent.instanceId,
        // Named only when it is somebody else's ability, so an ordinary
        // activation's action is byte-for-byte what it always was.
        ...(abilityDefId !== permanent.defId ? { viaAbilityDefId: abilityDefId } : {}),
        ...(payment !== undefined ? { payment } : {}),
      };

      // One candidate per MODE still available — Udyr's four are four separate
      // choices, and one he has already taken this turn is not offered again.
      for (const mode of availableModes(abilityDefId, permanent)) {
        // `modeId` is omitted for a plain ability's single unnamed mode, so an
        // ordinary activation's action is exactly what it always was.
        const withMode = mode.id === "" ? base : { ...base, modeId: mode.id };
        if (mode.targeting.kind !== "unit") {
          out.push(withMode);
          continue;
        }
        // Fan out one action per legal target, exactly as the PlayCard path does
        // for a targeted Spell — the choice has to be in the submitted action. A
        // mode with no legal target is simply not offered, since paying for
        // nothing is never what the player meant.
        for (const target of eligibleTargets(state, playerIndex, mode.targeting.owner, mode.targeting.scope)) {
          if (!unitWithinMaxMight(state, target, mode.targeting.maxMight)) continue;
          if (mode.targeting.exhaustedOnly && !target.exhausted) continue;
          if (!mode.movesTarget) {
            out.push({ ...withMode, targetUnitInstanceId: target.instanceId });
            continue;
          }
          // A mode that MOVES its target needs a destination too, so the fan-out
          // is target x battlefield — the same second axis a Charm-style Spell
          // already gets from cardMovesTarget. Where the unit already is is not
          // a destination: offering it would be a no-op the player paid for.
          const from = findUnitOnBattlefield(state, target.instanceId);
          for (const bf of state.battlefields) {
            if (from !== undefined && state.battlefields[from.battlefieldIndex]!.id === bf.id) continue;
            out.push({ ...withMode, targetUnitInstanceId: target.instanceId, destinationBattlefieldId: bf.id });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Rule 811's targeting restriction, as a predicate: when a card is played FROM a
 * facedown state, every target must be chosen "from among options at that
 * Battlefield". Always true for an ordinary play.
 *
 * Applied during ENUMERATION rather than only in validation, because 811 says a
 * card "cannot be played from Hidden if it is a spell with no valid targets
 * under these restrictions" — a card with no legal target there must not be
 * offered at all, which a validation-only check could not express.
 *
 * The restriction is per target, so this filters each candidate list rather than
 * the finished combination.
 */
function atHiddenBattlefield(state: GameState, unitInstanceId: string, fromHiddenBattlefieldId: string | undefined): boolean {
  if (fromHiddenBattlefieldId === undefined) return true;
  const bf = state.battlefields.find((b) => b.id === fromHiddenBattlefieldId);
  return Object.values(bf?.units ?? {}).some((list) => list.some((u) => u.instanceId === unitInstanceId));
}

/**
 * Every legal Hide — rule 811's Discretionary Action.
 *
 * One per (hidden card in hand or Champion Zone) x (battlefield you control with
 * no facedown card there). Only in a Neutral Open state on your own turn, since
 * hiding needs Priority and is not a play; the card's own `[Action]`/`[Reaction]`
 * keyword is irrelevant to hiding and is deliberately not consulted.
 */
function hideCardCandidates(state: GameState, actor: PlayerState, playerIndex: 0 | 1): HideCardAction[] {
  if (state.activePlayerIndex !== playerIndex || !state.chainOpen || state.turnState !== "Neutral") return [];

  const registry = defaultCardRegistry();
  const hideable = [...actor.hand, ...(actor.championZone ? [actor.championZone as CardInstance] : [])].filter((c) =>
    isHiddenCard(registry.tryGet(c.defId)),
  );
  if (hideable.length === 0) return [];

  // A flat 1 Power in ANY domain — RAINBOW is null, which computeAutoPayment
  // already understands as "any rune matches".
  const payment = computeAutoPayment(actor.channeled, 0, HIDE_POWER_COST, RAINBOW);
  if (!payment) return [];

  const destinations = state.battlefields.filter((bf) => bf.controllerId === actor.id && bf.hiddenCards.length === 0);
  return hideable.flatMap((card) =>
    destinations.map((bf): HideCardAction => ({ type: "HideCard", playerIndex, card, battlefieldId: bf.id, payment })),
  );
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
  // A pending question is the only thing on offer, for exactly one player.
  //
  // Checked BEFORE the phase guard, and that ordering is load-bearing: a
  // [Deathknell] discard can be parked during the Beginning Phase (a Temporary
  // unit dies, Undercover Agent's trigger fires, the discard stops to ask). With
  // the phase check first this would return nothing at all and the game would
  // hang with a question nobody could answer.
  const pending = pendingDecision(state);
  if (pending) {
    return optionsFor(state, pending).map((option) => ({
      type: "AnswerDecision",
      playerIndex: pending.playerIndex,
      decisionId: pending.id,
      optionId: option.id,
    }));
  }

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

  actions.push(...hideCardCandidates(state, actor, playerIndex));

  /**
   * Everything playable, and where from. A facedown card is a real source: rule
   * 811 lets it be played for 0 at Reaction speed from the turn after it was
   * hidden, with its targets restricted to that battlefield.
   */
  const playableSources: { card: CardInstance; fromHiddenBattlefieldId?: string }[] = [
    ...actor.hand.map((card) => ({ card })),
    ...(actor.championZone ? [{ card: actor.championZone as CardInstance }] : []),
    ...state.battlefields.flatMap((bf) =>
      bf.hiddenCards
        .filter((h) => h.ownerIndex === playerIndex && hiddenCardIsPlayable(state, h))
        .map((h) => ({ card: h.card, fromHiddenBattlefieldId: bf.id })),
    ),
  ];

  for (const { card, fromHiddenBattlefieldId } of playableSources) {
    if (card.kind === "Legend") continue;
    const fromHidden = fromHiddenBattlefieldId !== undefined;
    // The per-card timing gate, and the whole reason this loop now runs in every
    // state: a Default-tier card is only offered in a Neutral Open state, an
    // [Action] card additionally during Showdowns, a [Reaction] card also onto a
    // closed chain. Same predicate validate-play-card uses, so enumeration and
    // validation can't disagree about what's castable.
    if (!mayPlayCardNow(state, playerIndex, card, fromHidden)) continue;

    // A discard choice is fanned out per card in hand, exactly like Vision's
    // two-way choice: the engine cannot pause mid-resolution to ask, so which
    // card is discarded has to be decided in the submitted action. The card
    // being played is excluded — by the time it resolves it has already left
    // hand. Bounded by hand size, so the fan-out stays small.
    const discardChoice = discardChoiceOf(card.defId);
    const discardable = discardChoice ? actor.hand.filter((c) => c.instanceId !== card.instanceId) : [];
    if (discardChoice && !discardChoice.optional && discardable.length === 0) continue; // mandatory and unpayable

    // 811: "ignoring its base cost" — not reduced, ignored.
    // A discard that BUYS a discount changes what the payment must cover, so the
    // discounted cost is computed separately — but through computeEffectiveCost,
    // exactly like the plain one. Subtracting the discount from the raw cost and
    // stopping there skipped the floating-Energy reduction the plain path
    // applies, so enumeration offered a 4-rune payment for a card validation
    // priced at 3. Caught by a self-play probe, not by the suite, because no
    // test had floating Energy banked at the time.
    const effectiveCost = fromHidden
      ? { energyCost: 0, powerCost: 0 }
      : computeEffectiveCost(
        actor.floatingEnergy,
        actor.floatingPower,
        modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId),
        card.powerCost,
        card.powerDomain,
        card.powerDomainAlt,
        card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
        card.kind === "Spell" ? actor.restrictedSpellPower : 0,
      );
    const payment = computeAutoPayment(
      actor.channeled,
      effectiveCost.energyCost,
      effectiveCost.powerCost,
      card.powerDomain,
      card.powerDomainAlt,
    );
    // The DISCOUNTED payment is computed alongside the plain one, not inside the
    // variant loop below, because a card can be affordable only WITH the
    // discount — Brazen Buccaneer at 6 Energy with 4 runes is exactly that. An
    // earlier version bailed out here on the plain payment alone and so never
    // offered the discounted play at all, which is the whole point of the card.
    const discountedEffective =
      discardChoice?.energyDiscount !== undefined && !fromHidden
        ? computeEffectiveCost(
            actor.floatingEnergy,
            actor.floatingPower,
            Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - discardChoice.energyDiscount),
            card.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
            card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
            card.kind === "Spell" ? actor.restrictedSpellPower : 0,
          )
        : undefined;
    const discountedPayment = discountedEffective
      ? computeAutoPayment(
          actor.channeled,
          discountedEffective.energyCost,
          discountedEffective.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
        )
      : payment;
    if (!payment && !discountedPayment) continue; // can't afford it either way

    // [Accelerate] (805) is an OPTIONAL additional cost, so it is a second
    // candidate rather than a replacement — declining must stay available even
    // when you could afford it. Only offered when the bigger payment is actually
    // payable; a card you can afford plainly but not accelerated simply has no
    // accelerated variant.
    const accelerated =
      hasAccelerate(card) && !fromHidden
        ? computeAutoPayment(
            actor.channeled,
            effectiveCost.energyCost + ACCELERATE_ENERGY,
            effectiveCost.powerCost + ACCELERATE_POWER,
            acceleratePowerDomain(card),
            card.powerDomainAlt,
          )
        : null;

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
        if (!atHiddenBattlefield(state, target.instanceId, fromHiddenBattlefieldId)) continue;
        effectVariants.push({ targetUnitInstanceId: target.instanceId });
      }
    } else if (targeting.kind === "battlefield") {
      for (const bf of state.battlefields) {
        if (fromHidden && bf.id !== fromHiddenBattlefieldId) continue;
        effectVariants.push({ targetBattlefieldId: bf.id });
      }
    } else if (targeting.kind === "unitOrGear") {
      // One candidate per unit at a battlefield AND per gear in play, either
      // player's — a single choice across two kinds of permanent.
      for (const t of unitOrGearTargets(state)) {
        if (!atHiddenBattlefield(state, t.instanceId, fromHiddenBattlefieldId)) continue;
        effectVariants.push({ targetPermanentInstanceId: t.instanceId });
      }
    } else if (targeting.kind === "ownTrashCard") {
      for (const trashCard of actor.trash) {
        if (targeting.cardKind !== undefined && trashCard.kind !== targeting.cardKind) continue;
        effectVariants.push({ trashCardInstanceId: trashCard.instanceId });
      }
    } else if (targeting.kind === "unitSlots") {
      // Rule 811's restriction is PER TARGET, so it filters the candidate pool
      // both slots draw from rather than the pair as a whole.
      // Every legal FILLING of the two slots, down to `min`:
      //   - min 0 -> the empty choice is legal ("up to two")
      //   - one target -> fills slot 0, so it must satisfy slot 0's role
      //   - two -> slot-0 x slot-1, distinct units
      // The two targets need not share a location unless the spec says so —
      // `sameBattlefield` is Facebreaker's, and it is enforced HERE as well as
      // in the validator so the AI (which trusts this enumeration and calls the
      // executor directly) is never handed a pair the validator would refuse.
      //
      // Scope is asked PER SLOT: Zenith Blade's enemy target is "at a
      // battlefield" and its friendly one is not.
      const forSlot = (slot: 0 | 1) =>
        eligibleTargets(state, playerIndex, slotOwner(targeting.slots[slot]), slotScope(targeting, slot)).filter((u) =>
          atHiddenBattlefield(state, u.instanceId, fromHiddenBattlefieldId),
        );
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
          if (targeting.sameBattlefield && !shareABattlefield(state, first.instanceId, second.instanceId)) continue;
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
    // NOT gated on `card.kind === "Spell"` any more: a Unit's on-play trigger can
    // carry an optional cost too (Wildclaw Shaman), and while this only looked at
    // Spells that card had to smuggle the choice onto its target field — which
    // silently lost the decline whenever every friendly unit was already buffed.
    const optionalCost = optionalUnitCostOf(card.defId);
    const variants: Partial<PlayCardAction>[] = optionalCost
      ? afterVision.flatMap((v) => {
          const own = [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
          // A READY unit and a BUFFED unit are different sets; the registry says
          // which this card wants rather than this loop guessing.
          const eligible =
            optionalCost.kind === "exhaustReadyFriendly"
              ? own.filter((u) => !u.exhausted)
              : optionalCost.kind === "spendBuffFriendly"
                ? own.filter((u) => u.buffed)
                : own; // killFriendly — any unit you control can be the price
          const paid = eligible.map((u) => ({ ...v, additionalCostUnitInstanceId: u.instanceId }));
          // The decline variant leads, and is what makes "you may" mean may —
          // but ONLY for an optional cost. A mandatory one has no decline, so a
          // card whose cost cannot be paid is not offered at all.
          return optionalCost.mandatory ? paid : [v, ...paid];
        })
      : afterVision;

    // Charm needs a destination as well as a target, and unlike a token-placing
    // spell's it is mandatory: "Move an enemy unit" with nowhere to go is not a
    // move, so the card is simply not offered rather than offered and refused.
    // A destination the unit is ALREADY at is skipped for the same reason.
    const withDestinations: Partial<PlayCardAction>[] = cardMovesTarget(card.defId)
      ? variants.flatMap((v) =>
          state.battlefields
            .filter((bf) => !(bf.units[state.players[1 - playerIndex]!.id] ?? []).some((u) => u.instanceId === v.targetUnitInstanceId))
            .map((bf) => ({ ...v, destinationBattlefieldId: bf.id })),
        )
      : variants;

    for (const variant of withDestinations) {
      // fromHiddenBattlefieldId rides on EVERY variant this card produces — it is
      // what tells the validator to ignore the base cost, use Reaction timing and
      // look for the card at a battlefield rather than in hand.
      const hiddenFields = fromHiddenBattlefieldId !== undefined ? { fromHiddenBattlefieldId } : {};
      // One candidate per discardable card, priced against the DISCOUNTED cost.
      if (discardChoice && discountedPayment) {
        for (const c of discardable) {
          actions.push({
            type: "PlayCard",
            playerIndex,
            card,
            payment: discountedPayment,
            ...variant,
            ...hiddenFields,
            discardCardInstanceId: c.instanceId,
          });
        }
      }
      // A MANDATORY discard has no undiscarded candidate — Get Excited! without a
      // card to discard was skipped above, and its plain variant must not appear
      // here either.
      if (discardChoice && !discardChoice.optional) continue;
      if (!payment) continue; // affordable only WITH the discount, already emitted

      const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment, ...variant, ...hiddenFields };
      if (accelerated) {
        actions.push({ type: "PlayCard", playerIndex, card, payment: accelerated, ...variant, ...hiddenFields, acceleratePaid: true });
      }
      // The default candidate puts a token-placing Spell's tokens in BASE. Rule
      // 811 forbids that for a from-hidden play: "if a hidden spell ... causes
      // you to play a unit, you must choose to play that unit at that
      // battlefield." So the base variant is skipped and only the
      // that-battlefield one below is offered — without this the player was
      // handed a choice the rules don't give them, and the UI stalled waiting
      // for a placement decision that should never have been asked.
      const baseVariantForbidden = fromHidden && card.kind === "Spell" && cardPlacesTokens(card.defId);
      if (!baseVariantForbidden) actions.push(play);

      // A Unit may ALSO be played directly to a battlefield where the actor
      // already has a unit of their own — "reinforce" — alongside the
      // unconditional base-play candidate just pushed above, never replacing
      // it. Mirrors validate-play-card.ts's presence rule exactly, including
      // the small open-battlefield-placement exception (Sneaky Deckhand, Sai
      // Scout) — those additionally get every OTHER battlefield too, not
      // just ones they already occupy.
      if (card.kind === "Unit") {
        for (const bf of state.battlefields) {
          const hasPresence = (bf.units[actor.id]?.length ?? 0) > 0;
          // "An OPEN battlefield" is unoccupied AND uncontrolled (170.11.c), so
          // this is asked per battlefield rather than once per card. Same shared
          // predicate the validator uses.
          if (!hasPresence && !mayPlaceOnOpenBattlefield(card.defId, bf)) continue;
          // Rule 813 narrows a Unit's destinations outside a Neutral Open state to
          // your base or a battlefield you control. Checked here as well as in the
          // validator, via the same shared predicate: without it, enumeration
          // offered a [Reaction] Unit a reinforce destination the validator then
          // refused, and the AI (which trusts legalActions and calls the executor
          // directly) threw on it mid-game.
          if (!mayPlayUnitToBattlefield(state, playerIndex, bf.id)) continue;
          const reinforce: PlayCardAction = {
            type: "PlayCard",
            playerIndex,
            card,
            payment,
            ...variant,
            ...hiddenFields,
            destinationBattlefieldId: bf.id,
          };
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
          // Rule 811 again: "if a hidden spell ... causes you to play a unit, you
          // must CHOOSE to play that unit at that battlefield" — so a from-hidden
          // Sprite Call has exactly one destination, not a choice of them.
          if (fromHidden && bf.id !== fromHiddenBattlefieldId) continue;
          actions.push({
            type: "PlayCard",
            playerIndex,
            card,
            payment,
            ...variant,
            destinationBattlefieldId: bf.id,
            ...(fromHiddenBattlefieldId !== undefined ? { fromHiddenBattlefieldId } : {}),
          });
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

      // Same grant layer the validator uses, so a conditionally-Ganking unit is
      // never offered a move the validator would then refuse (or vice versa).
      if (!hasKeyword(state, unit, playerIndex, "Ganking")) continue;
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
