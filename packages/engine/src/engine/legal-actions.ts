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
  RunePayment,
} from "../actions/player-action.js";
import { computeAutoPayment, computeEffectiveCost, restrictedPowerFor } from "./rune-payment.js";
import { counterableSpells } from "./counter-spell.js";
import { mayPlaceWithoutPresence, targetingForAnyCard, unitTriggerHasVisionChoice } from "./unit-triggers.js";
import {
  eligibleTargets,
  findUnitOnBattlefield,
  shareABattlefield,
  unitListCandidates,
  gearTargets,
  unitOrGearTargets,
  unitSatisfiesAttackingOnly,
  unitWithinMaxMight,
} from "./target-lookup.js";
import { modifiedEnergyCost, modifiedRepeatEnergy } from "./cost-modifiers.js";
import {
  cardModesOf,
  cardMovesTarget,
  cardPlacesTokens,
  moveDestinationAllowed,
  type TargetingSpec,
  discardChoiceOf,
  hasXRainbowCost,
  optionalPowerCostOf,
  optionalUnitCostOf,
  repeatCostOf,
  slotOwner,
  slotScope,
} from "./card-effects.js";
import {
  abilitiesAvailableTo,
  activationCostOf,
  activationPayment,
  availableModes,
  canPayActivationCost,
  killableFriendlyPermanents,
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
import { RAINBOW, hiddenCardIsPlayable, hideCostFor, isHiddenCard, mayHideWithEnergy } from "./hidden.js";
import {
  chosenUnitsOfActivation,
  chosenUnitsOfPlay,
  chosenUnitsOfRepeat,
  deflectSurchargeForTargets,
  hasKeyword,
} from "./granted-keywords.js";
import { hiddenCardLimitAt, mayMoveToBaseFrom, mayPlayUnitAt } from "./battlefield-continuous.js";
import { effectiveMight } from "./effective-might.js";
import { attachableEquipment } from "./equipment.js";
import { optionsFor, pendingDecision } from "./decisions.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import type { CardInstance } from "../model/card.js";

/**
 * Does a `secondAtDestination` spec's second target actually stand at the
 * destination the first is being moved to? True for every other spec.
 *
 * Shared by the enumerator and `validate-play-card` so a Dragon's Rage variant
 * can never be offered and then refused — the drift this codebase has shipped
 * three times.
 */
export function secondTargetIsAtDestination(
  state: GameState,
  targeting: { kind: string; secondAtDestination?: true },
  action: { secondTargetUnitInstanceId?: string; destinationBattlefieldId?: string },
): boolean {
  if (targeting.kind !== "unitSlots" || targeting.secondAtDestination !== true) return true;
  if (action.secondTargetUnitInstanceId === undefined) return true; // nothing chosen yet
  if (action.destinationBattlefieldId === undefined) return false;
  const at = findUnitOnBattlefield(state, action.secondTargetUnitInstanceId);
  return at !== undefined && state.battlefields[at.battlefieldIndex]!.id === action.destinationBattlefieldId;
}

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
      // Each variant carries the cost choices of the MODE that produced it —
      // Jax - Grandmaster At Arms prices his two modes differently, so a single
      // list per ability would charge one mode's price for the other's job.
      //
      // Carried at PUSH time rather than looked up afterwards. A first version
      // registered them in a Map keyed by the variant after each mode's block,
      // and the `continue`s above it (a `unitOrGear` mode, a target-less one)
      // jumped straight past the registration — Malzahar - Fanatic lost his
      // kill-choice axis entirely, which his own test caught.
      const variants: { action: ActivateAbilityAction; costChoices: Partial<ActivateAbilityAction>[] }[] = [];

      // One candidate per MODE still available — Udyr's four are four separate
      // choices, and one he has already taken this turn is not offered again.
      for (const mode of availableModes(abilityDefId, permanent)) {
        // **Priced inside the mode loop, not outside it.** Jax - Grandmaster At
        // Arms's two modes cost [1]+exhaust and exhaust; one price computed per
        // ABILITY would sell whichever job the cheaper mode named. Every other
        // ability's modes share one price, so this is the same answer for them
        // however many times it is asked.
        //
        // Asks the same payability question the validator does — an exhaust, a
        // Recycle, a spent Buff and an Energy cost fail for different reasons, and
        // only the registry knows which this ability has.
        if (!canPayActivationCost(state, playerIndex, permanent, abilityDefId, mode.id)) continue;

        const cost = activationCostOf(abilityDefId, mode.id);
        const payment = cost.energy !== undefined ? activationPayment(state, playerIndex, cost) : undefined;
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

        // A cost that carries a CHOICE fans out its own axis, crossed with the
        // mode/target axes below — Malzahar - Fanatic names WHICH friendly
        // permanent he kills to pay, Unlicensed Armory WHICH card it discards. A
        // single `[{}]` for every other ability, so their actions are unchanged.
        const costChoices = activationCostChoices(state, playerIndex, permanent.instanceId, cost);
        const push = (action: ActivateAbilityAction) => variants.push({ action, costChoices });
        // `modeId` is omitted for a plain ability's single unnamed mode, so an
        // ordinary activation's action is exactly what it always was.
        const withMode = mode.id === "" ? base : { ...base, modeId: mode.id };
        // Pack of Wonders is the first ABILITY to target a unit-or-gear, and this
        // branch is why it could not simply reuse the spec: ability enumeration
        // fanned out only `"unit"` and pushed everything else target-less, so a
        // `unitOrGear` ability would have been offered with nothing chosen and
        // then done nothing. Rides `targetPermanentInstanceId`, the same field a
        // Spell's unitOrGear uses, so nothing expecting a unit is handed a gear.
        if (mode.targeting.kind === "unitOrGear") {
          for (const t of unitOrGearTargets(state, {
            playerIndex,
            ...(mode.targeting.owner !== undefined ? { owner: mode.targeting.owner } : {}),
            ...(mode.targeting.excludesSelf ? { excludeInstanceId: permanent.instanceId } : {}),
            ...(mode.targeting.includesFacedown !== undefined ? { includesFacedown: mode.targeting.includesFacedown } : {}),
          })) {
            push({ ...withMode, targetPermanentInstanceId: t.instanceId });
          }
          continue;
        }
        if (mode.targeting.kind !== "unit") {
          push(withMode);
          continue;
        }
        // Fan out one action per legal target, exactly as the PlayCard path does
        // for a targeted Spell — the choice has to be in the submitted action. A
        // mode with no legal target is simply not offered, since paying for
        // nothing is never what the player meant.
        for (const target of eligibleTargets(state, playerIndex, mode.targeting.owner, mode.targeting.scope)) {
          if (!unitWithinMaxMight(state, target, mode.targeting.maxMight)) continue;
          if (mode.targeting.exhaustedOnly && !target.exhausted) continue;
          // Wired on the ability path too, though no ability prints it today.
          // `exhaustedOnly` was wired ONLY here and not on the spell path, which
          // is the mirror-image gap; one filter reaching only half its call
          // sites is how a spec field comes to be silently ignored.
          if (!unitSatisfiesAttackingOnly(state, target, mode.targeting.attackingOnly)) continue;
          // A mode that ATTACHES an Equipment needs to name WHICH, so the
          // fan-out is unit x Equipment — the same second-axis shape
          // `movesTarget` uses, off the same shared walk the validator checks
          // against. A unit with nothing attachable to it is simply not offered.
          if (mode.attachesEquipment) {
            for (const gear of attachableEquipment(state, playerIndex, mode.attachesEquipment, target.instanceId)) {
              push({ ...withMode, targetUnitInstanceId: target.instanceId, targetPermanentInstanceId: gear.instanceId });
            }
            continue;
          }
          if (!mode.movesTarget) {
            push({ ...withMode, targetUnitInstanceId: target.instanceId });
            continue;
          }
          // A mode that MOVES its target needs a destination too, so the fan-out
          // is target x battlefield — the same second axis a Charm-style Spell
          // already gets from cardMovesTarget. Where the unit already is is not
          // a destination: offering it would be a no-op the player paid for.
          const from = findUnitOnBattlefield(state, target.instanceId);
          for (const bf of state.battlefields) {
            if (from !== undefined && state.battlefields[from.battlefieldIndex]!.id === bf.id) continue;
            push({ ...withMode, targetUnitInstanceId: target.instanceId, destinationBattlefieldId: bf.id });
          }
        }
      }

      for (const { action: variant, costChoices } of variants) {
        // **[Deflect] on what this variant CHOSE.** Priced per variant for the
        // same reason a Spell's is: the price depends on the target, so one
        // variant can be affordable while another is not, and a single payment
        // computed once per ability cannot say so.
        //
        // The surcharge can CREATE a payment where there was none. Most taxed
        // abilities in this pool cost only an exhaust (Iron Ballista, Orb of
        // Regret), so their actions carried no `payment` at all — a version that
        // only extended an existing one would have left exactly those untaxed.
        const owed = deflectSurchargeForTargets(state, playerIndex, chosenUnitsOfActivation(variant));
        const taxed = owed > 0 ? withActivationSurcharge(state, playerIndex, variant, owed) : variant;
        // An unpayable surcharge is not an offer. Same rule as the Spell path,
        // and the same reason: never enumerate what the validator will refuse.
        if (taxed === undefined) continue;
        for (const choice of costChoices) out.push({ ...taxed, ...choice });
      }
    }
  }
  return out;
}

/**
 * `action` with `owed` rainbow runes added to its payment, or undefined when the
 * pool cannot cover the surcharge.
 *
 * Runes already named for the ability's own Energy are excluded, which is the
 * same rule `computeAutoPayment` applies to a Spell's: 164.2's double duty is
 * about paying YOUR cost, and a tax handed to an opponent refunds nothing.
 *
 * ANY domain and ANY state — a Power cost is paid by recycling (416), so an
 * already-exhausted rune recycles for the tax just as well as a Ready one.
 */
function withActivationSurcharge(
  state: GameState,
  playerIndex: 0 | 1,
  action: ActivateAbilityAction,
  owed: number,
): ActivateAbilityAction | undefined {
  const spent = new Set(action.payment?.energyRunes ?? []);
  const rainbow = state.players[playerIndex].channeled.filter((r) => !spent.has(r.id)).slice(0, owed);
  if (rainbow.length < owed) return undefined;
  return {
    ...action,
    payment: {
      energyRunes: action.payment?.energyRunes ?? [],
      powerRunes: action.payment?.powerRunes ?? [],
      rainbowRunes: rainbow.map((r) => r.id),
    },
  };
}

/**
 * The ways an activation cost that carries a CHOICE could be paid, as action
 * fields — one entry per way, or a single empty entry for the costs that need
 * no choice at all.
 *
 * Fanned out here rather than asked at resolution for the reason every other
 * choice in this engine is: the submitted action carries the whole decision, so
 * a replay of the action log is deterministic without a decision transcript.
 */
function activationCostChoices(
  state: GameState,
  playerIndex: 0 | 1,
  sourceInstanceId: string,
  cost: ReturnType<typeof activationCostOf>,
): Partial<ActivateAbilityAction>[] {
  let choices: Partial<ActivateAbilityAction>[] = [{}];
  if (cost.killFriendlyPermanent) {
    choices = choices.flatMap((c) =>
      killableFriendlyPermanents(state, playerIndex, sourceInstanceId).map((p) => ({ ...c, costPermanentInstanceId: p.instanceId })),
    );
  }
  if (cost.discard !== undefined) {
    // One per DISTINCT card in hand rather than per copy: two copies of the same
    // card are the same discard, and offering both doubles the AI's branching
    // for a choice that cannot differ. The same de-duplication the hand-play
    // enumerator already does.
    const seen = new Set<string>();
    const hand = state.players[playerIndex].hand.filter((c) => !seen.has(c.defId) && seen.add(c.defId));
    choices = choices.flatMap((c) => hand.map((card) => ({ ...c, costDiscardCardInstanceId: card.instanceId })));
  }
  return choices;
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
  // Priced through the shared helper so Guerilla Warfare's free-hide turn is
  // seen here as well as by the validator.
  const payment = computeAutoPayment(actor.channeled, 0, hideCostFor(state, playerIndex), RAINBOW);
  // Teemo - Swift Scout's alternative: the same-sized price in Energy instead of
  // rainbow Power. A second candidate rather than a replacement — the rainbow
  // route stays available, and which one a player wants depends on what else the
  // turn has to pay for.
  const energyPayment = mayHideWithEnergy(state, playerIndex)
    ? computeAutoPayment(actor.channeled, hideCostFor(state, playerIndex), 0, null)
    : undefined;
  // Either route will do — a Teemo player who cannot afford the rainbow can still
  // hide off Energy, which is most of what the alternative is for.
  const payments = [payment, energyPayment].filter((p): p is RunePayment => p !== undefined);
  if (payments.length === 0) return [];

  // 811's one-facedown-per-battlefield limit, raised by Bandle Tree's "you may
  // hide an ADDITIONAL card here". The same function `validate-hide-card` asks.
  const destinations = state.battlefields.filter(
    (bf) => bf.controllerId === actor.id && bf.hiddenCards.length < hiddenCardLimitAt(state, bf.id),
  );
  return hideable.flatMap((card) =>
    destinations.flatMap((bf) =>
      payments.map((p): HideCardAction => ({ type: "HideCard", playerIndex, card, battlefieldId: bf.id, payment: p })),
    ),
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

  // A closed chain outranks the phase, for the same reason a pending decision does:
  // something is mid-resolution and the game is waiting on a specific player.
  //
  // The phase guard below is about DISCRETIONARY actions — "a Game Action that may
  // be performed at any time during a player's turn during a Neutral Open State"
  // (307, States of the Turn). Passing on a chain item is not discretionary; it is
  // the only way the resolution advances, which is why it belongs above the guard.
  //
  // Reachable because 383 puts triggered abilities on the Chain "during Closed
  // States or Open States on any player's turn": once triggers are held as Pending
  // Items and finalized onto the chain, the chain can be closed during the Beginning
  // Phase. With the phase check first, that state returns NO legal actions for
  // either player and the game hangs outright — the same shape as the
  // pending-decision hang the comment above describes.
  //
  // Only OUTSIDE the Action phase. Inside it the normal enumeration below already
  // handles a closed chain correctly and offers [Reaction] casting alongside the
  // pass — short-circuiting here would silently delete the response window this
  // whole mechanism exists to create.
  if (state.phase !== "Action" && !state.chainOpen) {
    return [{ type: "PassFocus", playerIndex: actingPlayerIndex(state) } satisfies PassFocusAction];
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
        // The battlefield is passed so Noxus Saboteur's "can't be revealed HERE"
        // is asked at enumeration too — the validator asks the same question of
        // the same function, so a blocked card is never offered and then refused.
        .filter((h) => h.ownerIndex === playerIndex && hiddenCardIsPlayable(state, h, bf.id))
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
        restrictedPowerFor(actor, card.kind),
        // Malzahar's rainbow, unlike Kai'Sa's, has no Spells-only clause — so no
        // kind check, and a Unit may be bought with it.
        actor.floatingRainbowPower,
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
            restrictedPowerFor(actor, card.kind),
            actor.floatingRainbowPower,
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
    // Call to Glory — "you may spend a buff ... if you do, ignore this spell's
    // cost." Its printed cost is IGNORED rather than reduced when the additional
    // cost is paid, so affordability is a per-VARIANT question: the card is
    // castable with no runes at all if a buffed friendly unit is there to spend.
    // Bailing here on the printed cost would have made that variant unreachable
    // exactly when it matters most — the same mistake the discount path already
    // records having made with Brazen Buccaneer.
    const canIgnoreCost = optionalUnitCostOf(card.defId)?.ignoresCostWhenPaid === true;
    // A REPEATABLE cost can make an otherwise-unaffordable card castable —
    // Commander Ledros prints 4 Power and can be played for none of it by killing
    // four units. Bailing on the printed price here would have made exactly the
    // variants the card exists for unreachable, which is the mistake this line
    // already records making twice (Brazen Buccaneer's discount, Call to Glory's
    // ignore).
    const canDiscountByRepeating = optionalUnitCostOf(card.defId)?.repeatable === true;
    if (!payment && !discountedPayment && !canIgnoreCost && !canDiscountByRepeating) continue; // can't afford it any way

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

    // A MODAL card has no single targeting — each mode carries its own, and
    // Rocket Barrage's two name a UNIT and a GEAR respectively. So the fan-out
    // runs once per mode and tags each variant with the mode it came from.
    //
    // A plain card has exactly ONE (unnamed) mode, so `modeId` never appears on
    // its actions and its enumeration is byte-for-byte what it always was —
    // which is the whole reason `cardModesOf` normalises rather than branching.
    const cardModes = card.kind === "Unit" ? [] : cardModesOf(card);
    const isModal = cardModes.length > 1;
    // The spec used by everything AFTER the fan-out (the destination filter, the
    // Vision copy). Naming no mode is deliberate: `cardModeOf` returns the sole
    // mode of a plain card and NOTHING for a modal one, so a modal card reads
    // `"none"` here. Safe today because no modal card moves its target or carries
    // [Vision]; a future one would have to read the per-variant `modeId`.
    const targeting = targetingForAnyCard(card);

    // Base "effect choice" fan-out: one partial-action-fields variant per
    // legal target (or a single empty variant for "none"/unregistered).
    const variantsForTargeting = (targeting: TargetingSpec): Partial<PlayCardAction>[] => {
    const effectVariants: Partial<PlayCardAction>[] = [];
    if (targeting.kind === "unit") {
      // eligibleTargets applies the owner constraint AND the spec's scope —
      // "a unit" (Final Spark) includes both bases, "a unit at a battlefield"
      // (Incinerate) does not. Enumerating it here by hand is what let the
      // two gates drift apart in the first place.
      for (const target of eligibleTargets(state, playerIndex, targeting.owner, targeting.scope)) {
        if (!unitWithinMaxMight(state, target, targeting.maxMight)) continue;
        if (!unitSatisfiesAttackingOnly(state, target, targeting.attackingOnly)) continue;
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
    } else if (targeting.kind === "gear") {
      for (const g of gearTargets(state)) effectVariants.push({ targetPermanentInstanceId: g.instanceId });
    } else if (targeting.kind === "ownTrashCard") {
      for (const trashCard of actor.trash) {
        if (targeting.cardKind !== undefined && trashCard.kind !== targeting.cardKind) continue;
        effectVariants.push({ trashCardInstanceId: trashCard.instanceId });
      }
    } else if (targeting.kind === "chainSpell") {
      // One candidate per counterable spell waiting on the chain. The counter
      // itself is not among them: enumeration happens before it is pushed, so
      // "a spell cannot target itself" holds by construction rather than by a
      // check — see the spec's own note.
      for (const { entry } of counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower)) {
        effectVariants.push({ targetChainCardInstanceId: entry.card.instanceId });
      }
    } else if (targeting.kind === "chainSpellAndUnit") {
      // The CROSS PRODUCT of the two choices (Riposte). Both are announced, so
      // every legal pairing is a distinct play — and with either side empty this
      // emits nothing, which is how 355.8 makes the card uncastable rather than
      // castable-and-half-inert.
      //
      // Through the same two helpers the `chainSpell` and `unit` branches use, so
      // the enumerator cannot offer a pair the validator then refuses — the drift
      // this file's own notes keep warning about.
      for (const { entry } of counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower)) {
        for (const target of eligibleTargets(state, playerIndex, targeting.owner, targeting.scope)) {
          if (!atHiddenBattlefield(state, target.instanceId, fromHiddenBattlefieldId)) continue;
          effectVariants.push({
            targetChainCardInstanceId: entry.card.instanceId,
            targetUnitInstanceId: target.instanceId,
          });
        }
      }
    } else if (targeting.kind === "unitList") {
      // A BOUNDED sample, not the powerset — see `unitListCandidates`, which is
      // also what `validate-play-card` measures a submitted set against, so the
      // AI can never be handed a set the validator refuses.
      //
      // Rule 811's per-target restriction filters the sets rather than the pool,
      // so a from-hidden play cannot smuggle in a target elsewhere on the board.
      for (const ids of unitListCandidates(state, playerIndex, targeting)) {
        if (!ids.every((id) => atHiddenBattlefield(state, id, fromHiddenBattlefieldId))) continue;
        effectVariants.push({ targetUnitInstanceIds: ids });
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
      // When both slots take the same role the pair is USUALLY symmetric, so
      // (A,B) and (B,A) are the same choice — enumerating both would double the
      // AI's search space and offer the player a distinction that doesn't exist.
      //
      // Same ROLE is not the same as same TREATMENT, though, and reading it that
      // way was a real bug. Back to Back and Singularity do the same thing to
      // both units, so the pruning is right for them; Convergent Mutation's slots
      // are both "friendly" but slot 0 is the BENEFICIARY and slot 1 is only
      // measured ("increase its Might to the Might of another friendly unit"), so
      // dropping one ordering hid half the card — measured with a 7-Might and a
      // 2-Might unit, the single offered pairing was the one that increases by 0.
      // `asymmetricSlots` is how a spec says the roles coincide but the meanings
      // do not.
      const symmetric = targeting.slots[0] === targeting.slots[1] && targeting.asymmetricSlots !== true;

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
      return effectVariants;
    };

    const effectVariants: Partial<PlayCardAction>[] = isModal
      ? cardModes.flatMap((mode) =>
          variantsForTargeting(targetingForAnyCard(card, mode.id)).map((v) => ({ ...v, modeId: mode.id })),
        )
      : variantsForTargeting(targeting);

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
    // Asked of the BOARD, not just the card: Gemcraft Seer grants [Vision] to
    // other friendly units, so whether this play needs a recycle choice depends
    // on what is already in play. `validate-play-card` asks the same function.
    const hasVision = card.kind === "Unit" && unitTriggerHasVisionChoice(state, playerIndex, card.defId);
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
          // A REPEATABLE cost (Kraken Hunter, Commander Ledros) is fanned out by
          // COUNT rather than by unit, and the count is capped by the printed
          // Power cost — "reduce my cost by [1 Power] for each" buys nothing once
          // the cost is zero. That is what keeps this to a handful of variants
          // instead of the powerset of the caster's own board.
          //
          // WHICH units are spent is chosen by a deterministic heuristic —
          // weakest first, since Ledros is choosing what to kill and Kraken
          // Hunter what to strip a buff from, and in both the cheapest bodies are
          // the ones a player almost always picks. `validate-play-card` accepts
          // ANY legal set, so a human clicking their own choice is not limited to
          // this sample; the same split `unitList` targeting makes.
          if (optionalCost.repeatable) {
            const byCheapest = [...eligible].sort(
              (a, b) => effectiveMight(state, a, playerIndex, { isCombat: false }) - effectiveMight(state, b, playerIndex, { isCombat: false }),
            );
            const maxSpend = Math.min(byCheapest.length, card.powerCost);
            const counts: Partial<PlayCardAction>[] = [];
            for (let n = 1; n <= maxSpend; n += 1) {
              counts.push({ ...v, additionalCostUnitInstanceIds: byCheapest.slice(0, n).map((u) => u.instanceId) });
            }
            return [v, ...counts];
          }
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
    //
    // That skip is asked OWNER-AGNOSTICALLY, through `findUnitOnBattlefield`.
    // It used to look the target up under `players[1 - playerIndex]` — the
    // opponent — which was written for Charm's "an enemy unit" and silently did
    // nothing for a FRIENDLY target. It never bit, because the only other card
    // in this set was Showstopper, whose target is base-scoped and so is never at
    // a battlefield to begin with. Ride The Wind's "a friendly unit" is the first
    // that reaches a battlefield, and under the old check its current battlefield
    // was offered back to it: a no-op move the player paid 2 Energy and a Power
    // for. The unit's OWNER is irrelevant to the question being asked, which is
    // "is it already standing here".
    const withDestinations: Partial<PlayCardAction>[] = cardMovesTarget(card.defId)
      ? variants.flatMap((v) => {
          const currentBattlefieldIndex =
            v.targetUnitInstanceId !== undefined ? findUnitOnBattlefield(state, v.targetUnitInstanceId)?.battlefieldIndex : undefined;
          return state.battlefields
            .filter((_bf, index) => index !== currentBattlefieldIndex)
            .map((bf) => ({ ...v, destinationBattlefieldId: bf.id }))
            .filter((withDest) => secondTargetIsAtDestination(state, targeting, withDest))
            // Temptation's "to a location where there's a unit with the same
            // controller" — the same predicate the validator re-derives, so a
            // destination can never be offered and then refused.
            .filter((withDest) =>
              moveDestinationAllowed(state, card.defId, withDest.targetUnitInstanceId, withDest.destinationBattlefieldId!),
            );
        })
      : variants;

    for (const variant of withDestinations) {
      // fromHiddenBattlefieldId rides on EVERY variant this card produces — it is
      // what tells the validator to ignore the base cost, use Reaction timing and
      // look for the card at a battlefield rather than in hand.
      const hiddenFields = fromHiddenBattlefieldId !== undefined ? { fromHiddenBattlefieldId } : {};
      // A variant that PAID the cost-ignoring additional cost pays nothing else.
      // Empty rather than small — the validator re-derives exactly this, and the
      // two must agree or the UI offers a click validation then refuses.
      // A REPEATABLE cost DISCOUNTS rather than replaces: each unit spent takes
      // 1 Power off, floored at 0. Re-priced per variant for the same reason
      // [Deflect] is — the price now depends on the choice, so one variant can be
      // affordable while another is not, and a single payment computed once per
      // card cannot say so.
      const repeatableSpend = variant.additionalCostUnitInstanceIds?.length ?? 0;
      const repeatablePayment =
        repeatableSpend > 0
          ? computeAutoPayment(
              actor.channeled,
              effectiveCost.energyCost,
              Math.max(0, effectiveCost.powerCost - repeatableSpend),
              card.powerDomain,
              card.powerDomainAlt,
            )
          : undefined;
      const variantPayment =
        canIgnoreCost && variant.additionalCostUnitInstanceId !== undefined
          ? { energyRunes: [], powerRunes: [] }
          : repeatableSpend > 0
            ? repeatablePayment
            : payment;
      // **[Deflect]: what THIS variant's target choice costs on top.** Computed
      // here rather than beside its use below, because the discard branch
      // immediately after emits its own candidates and owes the same tax — see
      // that branch for why it cannot simply fall through to the re-pricing.
      const deflected = deflectSurchargeForTargets(state, playerIndex, chosenUnitsOfPlay(variant));

      // One candidate per discardable card, priced against the DISCOUNTED cost —
      // and taxed for [Deflect] like every other variant.
      //
      // This branch emits BEFORE the per-variant re-pricing below, so for a while
      // it was the one path that skipped the surcharge. A MANDATORY discard makes
      // that unreachable-looking gap the only path the card has: Get Excited!
      // `continue`s three lines down, so every candidate it ever produces comes
      // out of here. Self-play on a generated deck threw "Get Excited! must pay 1
      // rainbow Power for [Deflect] on its target, but named 0" the first time it
      // met a Pouty Poro — the third instance of this file's offered-then-refused
      // bug, after Maddened Marauder's reinforce variant and Brazen Buccaneer's
      // floating-Energy mispricing.
      if (discardChoice && discountedPayment) {
        // The discounted cost when a discount applies, the printed one otherwise —
        // whichever `discountedPayment` itself was derived from.
        const discardBase = discountedEffective ?? effectiveCost;
        const discardPaymentForTargets =
          deflected > 0
            ? computeAutoPayment(
                actor.channeled,
                discardBase.energyCost,
                discardBase.powerCost,
                card.powerDomain,
                card.powerDomainAlt,
                deflected,
              )
            : discountedPayment;
        // Unaffordable ONCE THE TAX IS ADDED skips this variant, not the card —
        // the same rule the untaxed path below applies, and the reason a
        // [Deflect] unit simply drops off the target list rather than making the
        // card unplayable.
        if (discardPaymentForTargets) {
          for (const c of discardable) {
            actions.push({
              type: "PlayCard",
              playerIndex,
              card,
              payment: discardPaymentForTargets,
              ...variant,
              ...hiddenFields,
              discardCardInstanceId: c.instanceId,
            });
          }
        }
      }
      // A MANDATORY discard has no undiscarded candidate — Get Excited! without a
      // card to discard was skipped above, and its plain variant must not appear
      // here either.
      if (discardChoice && !discardChoice.optional) continue;
      if (!variantPayment) continue; // affordable only WITH the discount, already emitted

      // **[Deflect]: re-price THIS variant.** Every payment above is computed once
      // per card, which was correct while nothing made the price depend on the
      // choice. `[Deflect N]` does: the surcharge is owed for choosing a
      // particular unit, so two variants of the same card can cost differently
      // and one can be unaffordable while another is fine. This is the per-variant
      // restructure the conformance row called for, and Call to Glory's
      // `ignoresCostWhenPaid` was its first, smaller instance.
      //
      // `deflected` is computed above, before the discard branch that also needs
      // it. Zero when nothing targeted has [Deflect], so the ordinary card keeps
      // the single shared payment object it always had.
      let variantPaymentForTargets: RunePayment = variantPayment;
      if (deflected > 0) {
        const taxed = computeAutoPayment(
          actor.channeled,
          effectiveCost.energyCost,
          effectiveCost.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
          deflected,
        );
        // Unaffordable ONCE THE TAX IS ADDED — the card may still be playable at
        // another target, so this skips the variant rather than the card.
        if (!taxed) continue;
        variantPaymentForTargets = taxed;
      }

      const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment: variantPaymentForTargets, ...variant, ...hiddenFields };
      // [Accelerate] is priced once per card, which is wrong the moment anything
      // else about the variant changes the price. Kraken Hunter is both
      // accelerable and repeatable-discounted, and the shared `accelerated`
      // payment ignored the discount entirely — so the enumerator offered a
      // 3-Power accelerated play that the validator, which re-derives from the
      // discounted cost, then refused at 1. Found by the first test to enumerate
      // and validate the same action, which is the only way this class of bug
      // ever shows up.
      // Bullet Time's X. One variant per affordable amount, priced through the
      // SAME `rainbowRunes` bucket [Deflect] built — the one bucket whose runes
      // are not domain-checked against the card, which is what "any amount of
      // rainbow Power" needs.
      //
      // X = 0 is deliberately included: the card is castable for nothing and
      // deals nothing, which is what "any amount" means and is occasionally what
      // a player wants (it still costs its printed Energy). Capped by the pool
      // rather than by a number, so the fan-out is at most one per rune.
      if (hasXRainbowCost(card.defId) && !fromHidden) {
        for (let x = 0; x <= actor.channeled.length; x += 1) {
          const priced = computeAutoPayment(
            actor.channeled,
            effectiveCost.energyCost,
            effectiveCost.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
            x,
          );
          if (!priced) break; // pools only get tighter as X grows
          actions.push({ type: "PlayCard", playerIndex, card, payment: priced, ...variant, ...hiddenFields, xAmount: x });
        }
        continue; // the X variants ARE this card's plays; no plain one beside them
      }
      // Clockwork Keeper's optional Power cost — a second candidate priced one
      // Power higher, exactly as [Accelerate] is, and on its own flag so the two
      // cannot be confused (that one also means "enters ready").
      const optionalPower = optionalPowerCostOf(card.defId);
      if (optionalPower && !fromHidden) {
        // Priced against the cost's OWN domain, not the card's `powerDomain` —
        // Clockwork Keeper prints no Power at all, so that field is null and
        // pricing through it accepted any rune.
        const paid = computeAutoPayment(
          actor.channeled,
          effectiveCost.energyCost,
          effectiveCost.powerCost + optionalPower.count,
          optionalPower.domain,
        );
        // Offered only when the bigger payment is really payable — a card you can
        // afford plainly but not with the extra simply has no paid variant.
        if (paid) {
          actions.push({ type: "PlayCard", playerIndex, card, payment: paid, ...variant, ...hiddenFields, optionalPowerPaid: true });
        }
      }
      // `[Repeat]` (820.1) — a second candidate priced with the additional cost
      // on top, exactly as Clockwork Keeper's optional Power is just above.
      //
      // **The repeat's own choices are sampled, not fanned out.** 820.1.d lets
      // the second execution name DIFFERENT targets, so the complete
      // enumeration is the cross product of the two choice sets — quadratic in
      // the board, and for Bellows Breath's up-to-three it is worse than that.
      // So this emits the one variant that repeats the SAME choices, and
      // `validate-play-card` accepts any legal second set. That asymmetry is
      // this engine's standing answer to an unbounded choice space (see
      // `unitList` targeting and the repeatable additional costs, which are
      // sampled the same way and for the same reason): the AI gets a bounded
      // list, and a human clicking a combination the sampler never emitted is
      // still able to cast the card.
      //
      // `!fromHidden` matches the optional-Power and Accelerate branches. Rule
      // 811 ignores a hidden card's BASE cost and an additional cost is not
      // that, so this is a real (if unreachable) simplification — no card in
      // the pool prints both [Hidden] and [Repeat], asserted in the table test.
      const repeatCost = repeatCostOf(card.defId);
      if (repeatCost && !fromHidden) {
        // **Re-priced through `computeEffectiveCost` from the PRINTED cost, not
        // by adding the Repeat to the already-float-reduced `effectiveCost`.**
        // Floating Energy reduces the TOTAL a play costs, additional costs
        // included, so adding afterwards double-counts the float away: with 1
        // printed Energy, a [Repeat] [1] and 2 floating Energy, adding-after
        // quotes 0 + 1 = one rune while the validator prices the whole 2 against
        // the float and demands zero. That is the offered-then-refused split,
        // and it is the SAME mistake the discounted branch above records having
        // made — see this function's own note at the `effectiveCost` binding.
        // Also found by a self-play probe rather than by the suite, and for the
        // same reason: no unit test had floating Energy banked.
        const repeatEffective = computeEffectiveCost(
          actor.floatingEnergy,
          actor.floatingPower,
          modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) +
            modifiedRepeatEnergy(state, playerIndex, repeatCost.energy),
          card.powerCost + (repeatCost.power ?? 0),
          card.powerDomain,
          card.powerDomainAlt,
          card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
          restrictedPowerFor(actor, card.kind),
          actor.floatingRainbowPower,
        );
        // **The `[Deflect]` tax is owed by BOTH executions** (project-owner
        // ruling, 2026-08-06 — the same unit chosen twice owes twice). This
        // variant repeats the SAME choices, so its taxable set is the first
        // set twice over. Asked through the very helpers the validator uses,
        // against the candidate action itself, rather than doubling `deflected`
        // by hand: this figure is where the offered-then-refused split lives.
        const repeatVariant = { ...variant, repeatPaid: true as const };
        const repeatDeflected = deflectSurchargeForTargets(state, playerIndex, [
          ...chosenUnitsOfPlay(repeatVariant),
          ...chosenUnitsOfRepeat(repeatVariant),
        ]);
        const paidRepeat = computeAutoPayment(
          actor.channeled,
          repeatEffective.energyCost,
          repeatEffective.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
          repeatDeflected + (repeatCost.rainbowPower ?? 0),
        );
        // Offered only when the bigger payment is really payable — a spell you
        // can afford plainly but not with the repeat simply has no paid variant,
        // the same rule the optional-Power branch above applies.
        if (paidRepeat) {
          actions.push({ type: "PlayCard", playerIndex, card, payment: paidRepeat, ...variant, ...hiddenFields, repeatPaid: true });
        }
      }
      const acceleratedForVariant =
        repeatableSpend > 0 && hasAccelerate(card) && !fromHidden
          ? computeAutoPayment(
              actor.channeled,
              effectiveCost.energyCost + ACCELERATE_ENERGY,
              Math.max(0, effectiveCost.powerCost - repeatableSpend) + ACCELERATE_POWER,
              acceleratePowerDomain(card),
            )
          : accelerated;
      if (acceleratedForVariant) {
        actions.push({
          type: "PlayCard",
          playerIndex,
          card,
          payment: acceleratedForVariant,
          ...variant,
          ...hiddenFields,
          acceleratePaid: true,
        });
      }
      // The default candidate puts a token-placing Spell's tokens in BASE. Rule
      // 811 forbids that for a from-hidden play: "if a hidden spell ... causes
      // you to play a unit, you must choose to play that unit at that
      // battlefield." So the base variant is skipped and only the
      // that-battlefield one below is offered — without this the player was
      // handed a choice the rules don't give them, and the UI stalled waiting
      // for a placement decision that should never have been asked.
      // Rule 811's placement clause, and it covers a hidden PERMANENT as well as
      // a hidden spell that makes one: "you must choose to play that unit at
      // that battlefield". A hidden UNIT therefore has no base play either —
      // which is what the doc had recorded as unreachable on the strength of the
      // PRESET decks, while the pool holds six hidden units and a hidden gear.
      // Every one of them was playable straight into base for free.
      const baseVariantForbidden =
        fromHidden && ((card.kind === "Spell" && cardPlacesTokens(card.defId)) || card.kind === "Unit");
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
          // A from-hidden unit goes to ITS battlefield and nowhere else (811),
          // and that clause overrides both of the checks below: the presence
          // requirement (the card being there IS the reason it may be played
          // there) and 813's Showdown narrowing (a hidden card is played at
          // Reaction speed, so 813 would otherwise forbid the one destination
          // 811 requires — the more specific rule wins, recorded Unverified).
          if (fromHidden) {
            if (bf.id !== fromHiddenBattlefieldId) continue;
          } else {
            const hasPresence = (bf.units[actor.id]?.length ?? 0) > 0;
            // "An OPEN battlefield" is unoccupied AND uncontrolled (170.11.c), so
            // this is asked per battlefield rather than once per card. Same shared
            // predicate the validator uses.
            if (!hasPresence && !mayPlaceWithoutPresence(state, playerIndex, card.defId, bf)) continue;
            // Rule 813 narrows a Unit's destinations outside a Neutral Open state to
            // your base or a battlefield you control. Checked here as well as in the
            // validator, via the same shared predicate: without it, enumeration
            // offered a [Reaction] Unit a reinforce destination the validator then
            // refused, and the AI (which trusts legalActions and calls the executor
            // directly) threw on it mid-game.
            if (!mayPlayUnitToBattlefield(state, playerIndex, bf.id)) continue;
          }
          const reinforce: PlayCardAction = {
            type: "PlayCard",
            playerIndex,
            card,
            // The TAXED payment, not the plain one. A Unit's on-play trigger can
            // target — Maddened Marauder's does — and its target is chosen on
            // this same action, so a reinforce variant owes the surcharge exactly
            // as the base-play variant does. Using `variantPayment` here was a
            // real offered-then-refused bug: the AI takes an enumerated action
            // straight to the executor, and self-play threw "must pay 1 rainbow
            // Power for [Deflect] on its target, but named 0" as soon as a
            // Marauder targeted a Deflect unit.
            payment: variantPaymentForTargets,
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
          // Rockfall Path: "units can't be PLAYED here", and a unit token played
          // to a battlefield is a unit being played — Recruit the Vanguard's own
          // text is "play a 1 Might Recruit unit token". Gated here as well as on
          // the Unit path, because the two reach a destination by different
          // routes and only this one covers a Spell that makes a body.
          if (!mayPlayUnitAt(state, bf.id)) continue;
          // Rule 811 again: "if a hidden spell ... causes you to play a unit, you
          // must CHOOSE to play that unit at that battlefield" — so a from-hidden
          // Sprite Call has exactly one destination, not a choice of them.
          if (fromHidden && bf.id !== fromHiddenBattlefieldId) continue;
          actions.push({
            type: "PlayCard",
            playerIndex,
            card,
            payment: variantPayment,
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

      // Vilemaw's Lair — the same gate `validate-recall-unit` reads, so the two
      // cannot disagree about whether a retreat from here is legal.
      if (mayMoveToBaseFrom(state, bf.id)) {
        const recall: RecallUnitAction = { type: "RecallUnit", playerIndex, unitInstanceIds: [unit.instanceId] };
        actions.push(recall);
      }

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
