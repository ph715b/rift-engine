import type { GameState, PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import { applyContested } from "../engine/cleanup.js";
import { dispatchOnPlayUnit } from "../engine/unit-triggers.js";
import { holdEventTrigger, holdSelfTrigger } from "../engine/triggers.js";
import { holdUnitsChosenBySpell } from "../engine/battlefield-abilities.js";
import { consumeNextUnitEntersReady, gearEntersExhausted, unitEntersReady } from "../engine/deploy.js";
import { modifiedEnergyCost } from "../engine/cost-modifiers.js";
import type { PlayCardAction } from "./player-action.js";
import { validatePlayCard } from "./validate-play-card.js";
import { holdQuickDrawAttach } from "../engine/equipment.js";
import { holdUnitsChosen } from "../engine/triggers.js";

/**
 * Resolves a validated PlayCard action, returning a new GameState rather than
 * mutating the input — the engine is meant to stay `(state, action) ->
 * nextState` throughout (PRD Goal 4), which is a deliberate departure from
 * the Java oracle's in-place-mutation style (see PRD open-question #2's
 * resolution): Java's ActionExecutor.executePlayCard
 * (engine/ActionExecutor.java:228-354) mutates `active.hand`/`baseUnits`/etc.
 * directly; this does the equivalent updates immutably.
 *
 * Cost payment (shared across every card kind) — payCost -> applyPayment
 * (engine/ActionExecutor.java:1869-1905):
 *   - before rune selection, floating Energy/Power (banked from earlier
 *     recycled runes this same turn) reduces the printed cost — validated
 *     against by validate-play-card.ts's computeEffectiveCost, and spent
 *     here independently via `deductFloat`'s own re-derivation from the RAW
 *     cost (never trusting a value validation already computed).
 *   - a rune paid for Power is fully recycled — removed from the pool,
 *     reset to Ready, sent to the bottom of the rune deck (`flushToDeck`,
 *     :1907-1911) — NOT just exhausted, unlike Energy.
 *   - a rune paid for Energy only (not also Power) becomes Exhausted and
 *     stays in the pool, returning to Ready at next Awaken.
 *   - a single Ready rune CAN cover both an Energy slot and a Power slot at
 *     once ("double duty" — computeAutoPayment's own doc comment); in that
 *     case it's recycled (Power wins) and its Energy-paying potential is
 *     used directly by that same payment, so nothing further is credited.
 *   - a Ready rune recycled for Power WITHOUT also being used for Energy in
 *     the same payment has its Energy-paying potential go to waste by being
 *     recycled — so THAT case (not double duty) is what credits 1 floating
 *     Energy instead, per ActionExecutor.applyPayment's real rule (:1876-1886):
 *     `if (rune.isReady() && !payment.energyRunes().contains(rune))
 *     player.floatingEnergy += 1;` — i.e. credited whenever a Ready
 *     power-rune is NOT also an energy-rune in this payment, not the reverse.
 *   - cardsPlayedThisTurn++ — :267
 *
 * Per-kind zone transition, post-payment:
 *   - Unit, no destination: hand.remove(card) or championZone.set(null) if
 *     played from there (:327-333); baseUnits.add(unit), entering play
 *     EXHAUSTED unless it has [Quick] OR the caster's unitsEnterReadyThisTurn
 *     flag is set (Confront) (:376-384's full condition also excludes
 *     Accelerate/per-card exceptions, none modeled yet). Once placed,
 *     dispatchOnPlayUnit (engine/unit-triggers.ts) fires the unit's
 *     registered on-play trigger, if any — this is the ONE place a Unit's
 *     printed ability ever runs; a Spell's runs later, off the chain.
 *   - Unit, with destinationBattlefieldId ("reinforce" — see
 *     validate-play-card.ts's presence rule): added to that battlefield's
 *     units instead of base, exhaustion rule unchanged (destination-agnostic
 *     per ActionExecutor.java:376-384). Landing anywhere the player doesn't
 *     already control applies Contested (rule 458) via the identical mechanism
 *     MoveUnit's does, and the following Cleanup stages the Showdown — a
 *     confirmed real mechanic, not inferred (GameEngine.java:201-263's own
 *     "playtesting fix" comment: a unit played directly to a battlefield
 *     never opened a real Showdown even when landing on enemy-occupied
 *     territory). Landing with no opposing units is a Non-Combat Showdown
 *     rather than an instant claim (317.1); control is established when that
 *     window closes (352.1).
 *   - Spell: hand.remove(card); trash.add(card) IMMEDIATELY — before it ever
 *     resolves, mirroring ActionExecutor.payAndQueueSpell's trash-add at
 *     cast time (:566-567), not after resolution; pushes a ChainEntry onto
 *     `spellChain` and closes the chain (GameEngine.handleSpellOnChain,
 *     :280-311). Resolving the chain (execute-pass-focus.ts) does nothing
 *     further to the card's zone — it's already in trash.
 *   - Gear: hand.remove(card); activeGear.add(card) — a real "in play,
 *     unequipped" zone (ActionExecutor.executePlayCard's Card.Gear branch,
 *     :418-424). No chain interaction, no target chosen at play time —
 *     attaching to a unit is a separate EquipGear action, not implemented
 *     yet (Gear just sits here, which is itself a valid, honest game state).
 *
 * Throws if validation fails — callers are expected to call
 * `validatePlayCard` first (e.g. when enumerating legal moves) and only
 * ever execute actions already known to be legal, matching the
 * Validator/Executor split in the Java oracle.
 */
/**
 * Plays a card, then fires the `cardPlayed` event exactly once.
 *
 * A wrapper rather than a dispatch at each `return`, because the body below has
 * THREE exit paths (unit to base, unit to a battlefield, spell/gear) and this
 * codebase has already shipped a bug of exactly that shape — `trashCardInstanceId`
 * was forwarded on two hops and dropped on a third, so a card paid its cost and
 * did nothing. One choke point cannot be half-wired.
 *
 * Fired AFTER the play has fully resolved, so a listener sees the finished board:
 * Viktor - Innovator's "when you play a card on an opponent's turn" wants the
 * state where the card is already in play.
 */
export function executePlayCard(state: GameState, action: PlayCardAction): GameState {
  const played = executePlayCardInner(state, action);
  // Two triggers, and they are not redundant. `cardPlayed` is for OTHER
  // permanents watching (Viktor - Innovator); the self-trigger is for the card
  // itself (Scrapheap's "when this is played"), which a listener walk would also
  // reach but only by accident of it happening to be in play — a Spell wouldn't be.
  //
  // BOTH are HELD as Chain Pending Items (383 / 809.1.b.3). The self-trigger used
  // to resolve inline, on the grounds that `allListeningPermanents` cannot find a
  // card that has left play — true, and answered by `source: "selfTrigger"`, which
  // carries the card on the entry and never looks it up.
  //
  // Every condition that decides whether a listener TRIGGERED now lives in its
  // `applies` predicate rather than only in `resolve`. Darius - Trifarian is the
  // one that makes this load-bearing: "your SECOND card in a turn" reads
  // `cardsPlayedThisTurn`, a counter that the response window this hold opens can
  // itself change — a [Reaction] cast in answer makes it 3, and a `resolve` that
  // re-checked would refuse a trigger that had already fired.
  const withEvent = holdEventTrigger(played, {
    kind: "cardPlayed",
    casterIndex: action.playerIndex,
    playedKind: action.card.kind,
    playedInstanceId: action.card.instanceId,
    // Ember Monk watches specifically for a play FROM facedown. Carried on the
    // existing event rather than a new one, so every other listener still sees
    // a hidden play as the play it is.
    ...(action.fromHiddenBattlefieldId !== undefined ? { fromHidden: true } : {}),
  });
  // Placed LAST so that under the chain's LIFO resolution (343) it resolves
  // FIRST — which is exactly where it sat while it was dispatched inline. Any
  // other position would silently reorder every card that watches its own play
  // against the permanents watching the same moment.
  return holdSelfTrigger(withEvent, "played", action.card, action.playerIndex);
}

/** Takes a from-hidden card off its battlefield. A no-op for an ordinary play. */
function removeFromHiddenZone(state: GameState, action: PlayCardAction): GameState {
  if (action.fromHiddenBattlefieldId === undefined) return state;
  return {
    ...state,
    battlefields: state.battlefields.map((bf) =>
      bf.id === action.fromHiddenBattlefieldId
        ? { ...bf, hiddenCards: bf.hiddenCards.filter((h) => h.card.instanceId !== action.card.instanceId) }
        : bf,
    ),
  };
}

function executePlayCardInner(rawState: GameState, action: PlayCardAction): GameState {
  // Validate BEFORE the card leaves the hidden zone. Taking it out first made
  // `hiddenPlayRejection` unable to find it, so every from-hidden play threw
  // "is not hidden at that battlefield" — the validator's own precondition,
  // destroyed by the line meant to satisfy it.
  const validation = validatePlayCard(rawState, action);
  if (!validation.ok) throw new Error(validation.error);
  const state = removeFromHiddenZone(rawState, action);

  const actor = state.players[action.playerIndex];
  const card = action.card;
  if (card.kind === "Legend") throw new Error("executePlayCard: Legend cards are not implemented");

  // Rule 811: played from Hidden means "ignoring its base cost", and the
  // validator has already required an empty payment — so these sets are empty
  // and the loop below leaves the rune pool untouched, with no branch needed.
  const paidEnergyIds = new Set(action.payment.energyRunes);
  // The card's own Power and any [Deflect] surcharge are spent the same way — a
  // Power cost RECYCLES the rune (416) whatever it is owed to — so they share one
  // set here. They are separate buckets on the ACTION because the validator holds
  // them to different domain rules, not because they are paid differently.
  const paidPowerIds = new Set([...action.payment.powerRunes, ...(action.payment.rainbowRunes ?? [])]);
  // Runes recycled for the surcharge get NO floating-Energy credit. The credit
  // exists because a Ready rune recycled for its OWNER's Power had Energy-paying
  // potential that the owner never got to use; a rune handed over as an opponent's
  // Deflect tax is not paying its owner's cost at all, so there is nothing to
  // refund. Without this a Deflect tax would partly pay for itself.
  const surchargeIds = new Set(action.payment.rainbowRunes ?? []);

  let floatingEnergyGained = 0;
  const recycled: RuneCard[] = [];
  const remainingChanneled: RuneCard[] = [];
  for (const rune of actor.channeled) {
    if (paidPowerIds.has(rune.id)) {
      // A Ready rune recycled for Power that is NOT also used for Energy in
      // this same payment has its Energy-paying potential wasted by being
      // recycled — bank it as floating Energy instead. True double duty
      // (also in energyRunes) already spends that potential directly, so no
      // credit is due there.
      if (rune.state === "Ready" && !paidEnergyIds.has(rune.id) && !surchargeIds.has(rune.id)) floatingEnergyGained += 1;
      recycled.push({ ...rune, state: "Ready" });
    } else if (paidEnergyIds.has(rune.id)) {
      remainingChanneled.push({ ...rune, state: "Exhausted" });
    } else {
      remainingChanneled.push(rune);
    }
  }

  // Floating Energy/Power is deducted independently here, re-derived fresh
  // from the RAW printed cost (after per-card Energy modifiers like Eager
  // Apprentice's discount, still re-derived rather than trusted from
  // validatePlayCard) rather than trusting validatePlayCard's full
  // effective-cost math — mirrors ActionExecutor's deductFloat, which never
  // trusts an earlier-computed value at mutation time. Energy floats freely;
  // Power floats only within its matching domain(s) (card.powerDomain is
  // only ever null when powerCost is 0, so the lookup is never needed then).
  // For a confirmed handful of genuinely hybrid-pip cards (card.powerDomainAlt,
  // e.g. Tibbers), floating Power in EITHER domain can cover the cost —
  // drain whichever alone already covers the spend first (preferring the
  // primary powerDomain, the canonical domain used everywhere else), only
  // reaching into the alt domain's pool for the shortfall. For every other
  // card, altAvailable is always 0, making this identical to the old
  // single-domain formula.
  //
  // "Ignoring its base cost" (811) has to be honoured HERE as well, not only in
  // the validator. The validator already prices a from-hidden play at
  // `{ energyCost: 0, powerCost: 0 }` and requires an empty payment; this half
  // went on deducting floating resources against the PRINTED cost, so playing
  // Consult the Past (4 Energy) from Hidden with 3 floating Energy banked
  // silently burned all three for a card that was supposed to be free. Ignored
  // is ignored — no runes, no float, no cost modifiers.
  const ignoresBaseCost = action.fromHiddenBattlefieldId !== undefined;
  const modifiedEnergy = ignoresBaseCost
    ? 0
    : modifiedEnergyCost(state, action.playerIndex, card.kind, card.energyCost, card.defId);
  const powerToPay = ignoresBaseCost ? 0 : card.powerCost;
  const floatingEnergySpent = Math.min(actor.floatingEnergy, modifiedEnergy);
  // restrictedSpellEnergy (Lux-Crownguard's activated ability, Spells only)
  // drains AFTER floating Energy, for whatever floating didn't cover —
  // mirrors rune-payment.ts's computeEffectiveCost's own ordering exactly
  // (see that function's doc comment for why the order matters here even
  // though the combined *total* doesn't).
  const remainingAfterFloat = modifiedEnergy - floatingEnergySpent;
  const restrictedSpent = card.kind === "Spell" ? Math.min(actor.restrictedSpellEnergy, remainingAfterFloat) : 0;
  const primaryAvailable = card.powerDomain !== null ? (actor.floatingPower[card.powerDomain] ?? 0) : 0;
  const altAvailable = card.powerDomainAlt !== undefined ? (actor.floatingPower[card.powerDomainAlt] ?? 0) : 0;
  const floatingPowerSpent = Math.min(primaryAvailable + altAvailable, powerToPay);
  const primarySpent = Math.min(primaryAvailable, floatingPowerSpent);
  const altSpent = floatingPowerSpent - primarySpent;
  // restrictedSpellPower (Kai'Sa's rainbow, Spells only) drains AFTER floating
  // Power, exactly as the Energy pair above does and in the same order
  // computeEffectiveCost applies them — fungible first, restricted second.
  // Malzahar's rainbow drains between the two — after domain-matched floating
  // Power, before Kai'Sa's Spells-only pool — because it is fungible across
  // domains but usable for any card, so spending it before the more restricted
  // pool would strand the restricted one. Same order computeEffectiveCost prices.
  const rainbowPowerSpent = Math.min(actor.floatingRainbowPower, powerToPay - floatingPowerSpent);
  const restrictedPowerSpent =
    card.kind === "Spell" ? Math.min(actor.restrictedSpellPower, powerToPay - floatingPowerSpent - rainbowPowerSpent) : 0;

  // A from-hidden card was never in hand; it comes off the battlefield instead,
  // which happens on `battlefields` further down.
  const handAfterRemoval = actor.hand.filter((c) => c.instanceId !== card.instanceId);
  const sharedUpdates = {
    hand: handAfterRemoval,
    channeled: remainingChanneled,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy - floatingEnergySpent + floatingEnergyGained,
    restrictedSpellEnergy: actor.restrictedSpellEnergy - restrictedSpent,
    restrictedSpellPower: actor.restrictedSpellPower - restrictedPowerSpent,
    floatingRainbowPower: actor.floatingRainbowPower - rainbowPowerSpent,
    floatingPower:
      floatingPowerSpent > 0
        ? {
            ...actor.floatingPower,
            ...(primarySpent > 0 && card.powerDomain !== null ? { [card.powerDomain]: primaryAvailable - primarySpent } : {}),
            ...(altSpent > 0 && card.powerDomainAlt !== undefined ? { [card.powerDomainAlt]: altAvailable - altSpent } : {}),
          }
        : actor.floatingPower,
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
    // Raging Firebrand's charge is SPENT here, on the Spell that used it, and
    // only on a Spell — the card says "the next SPELL you play this turn". Spent
    // in the executor rather than in `modifiedEnergyCost` for the reason that
    // function's own note gives: a cost modifier is asked several times per play
    // (enumeration, validation, the float math) and has to give the same answer
    // each time, so it cannot also be the thing that consumes the charge. Sun
    // Disc's `consumeNextUnitEntersReady` makes the same split.
    //
    // Zeroed rather than decremented: the charge is "the next spell", so a single
    // Spell consumes the whole standing discount however many Firebrands built
    // it, and the second Spell this turn gets nothing.
    nextSpellEnergyDiscount: card.kind === "Spell" ? 0 : actor.nextSpellEnergyDiscount,
  };

  if (card.kind === "Unit") {
    // Ready-or-exhausted lives in engine/deploy.ts now, shared with the effects
    // that play a unit without a PlayCardAction to carry the question.
    const deployedUnit = { ...card, exhausted: !unitEntersReady(state, action.playerIndex, card, action.acceleratePaid) };
    // Sun Disc's charge is spent on the unit that used it, and only then — see
    // consumeNextUnitEntersReady. Applied to `updatedActor` below rather than to
    // `state`, since this branch has already begun building the new player.
    const chargeSpent = consumeNextUnitEntersReady(state, action.playerIndex, card, action.acceleratePaid);
    const nextUnitsEnterReady = chargeSpent.players[action.playerIndex].nextUnitsEnterReady;
    const playedFromChampionZone = actor.championZone?.instanceId === card.instanceId;
    const updatedActor: PlayerState = {
      ...actor,
      ...sharedUpdates,
      championZone: playedFromChampionZone ? null : actor.championZone,
      nextUnitsEnterReady,
    };

    if (action.destinationBattlefieldId === undefined) {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[action.playerIndex] = { ...updatedActor, baseUnits: [...actor.baseUnits, deployedUnit] };
      const next: GameState = { ...state, players };
      return dispatchOnPlayUnit(next, deployedUnit, action.playerIndex, "base", {
        ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
        ...(action.visionRecycle !== undefined ? { visionRecycle: action.visionRecycle } : {}),
        // Annie-Stubborn's "return a spell from your trash" is the only
        // on-play trigger reading this today. It was silently dropped here
        // (both call sites) while UnitTriggerEvent, dispatchOnPlayUnit's
        // `extra`, legal-actions.ts's fan-out and validate-play-card.ts all
        // carried it — so the trigger validated, cost runes, deployed the
        // unit, and then no-op'd inside returnCardFromTrash on an undefined
        // id. Only caught by playing the card in the real UI: the existing
        // test calls dispatchOnPlayUnit directly, which bypasses exactly
        // this hop (see card-effects-phase3.test.ts:76).
        ...(action.trashCardInstanceId !== undefined ? { trashCardInstanceId: action.trashCardInstanceId } : {}),
      ...(action.additionalCostUnitInstanceId !== undefined
        ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
        : {}),
      ...(action.additionalCostUnitInstanceIds !== undefined
        ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
        : {}),
      ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
        // Forwarded for the same reason trashCardInstanceId is: a field that
        // exists on the action, is validated, is enumerated — and is then
        // dropped on this hop — leaves the card paying its cost and doing
        // nothing. That exact bug has happened here once already.
        ...(action.additionalCostUnitInstanceId !== undefined
          ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
          : {}),
        ...(action.additionalCostUnitInstanceIds !== undefined
          ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
          : {}),
        ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
        // Tasty Faefolk's whole ability is gated on Accelerate having been PAID
        // (805). Only the action knows — the deployed unit carries no record of
        // how it was paid for. Same dropped-field hazard as the fields above.
        ...(action.acceleratePaid !== undefined ? { acceleratePaid: action.acceleratePaid } : {}),
        ...(action.optionalPowerPaid !== undefined ? { optionalPowerPaid: action.optionalPowerPaid } : {}),
      // Kinkou Monk is the first UNIT trigger with a two-slot spec; Spells have
      // carried this field since Gentlemen's Duel.
      ...(action.secondTargetUnitInstanceId !== undefined
        ? { secondTargetUnitInstanceId: action.secondTargetUnitInstanceId }
        : {}),
      });
    }

    const players = [...state.players] as [PlayerState, PlayerState];
    players[action.playerIndex] = updatedActor;

    const bfIndex = state.battlefields.findIndex((bf) => bf.id === action.destinationBattlefieldId);
    const bf = state.battlefields[bfIndex]!;
    const battlefields = [...state.battlefields];
    battlefields[bfIndex] = {
      ...bf,
      units: { ...bf.units, [actor.id]: [...(bf.units[actor.id] ?? []), deployedUnit] },
    };

    let next: GameState = { ...state, players, battlefields };
    next = dispatchOnPlayUnit(next, deployedUnit, action.playerIndex, { battlefieldId: action.destinationBattlefieldId }, {
      ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
      ...(action.visionRecycle !== undefined ? { visionRecycle: action.visionRecycle } : {}),
      // Same dropped-field fix as the base branch above — a reinforce play
      // fires the same trigger.
      ...(action.trashCardInstanceId !== undefined ? { trashCardInstanceId: action.trashCardInstanceId } : {}),
      ...(action.additionalCostUnitInstanceId !== undefined
        ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
        : {}),
      ...(action.additionalCostUnitInstanceIds !== undefined
        ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
        : {}),
      ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
      // Same Accelerate forwarding as the base branch — a reinforce play pays
      // the same optional cost and fires the same trigger.
      ...(action.acceleratePaid !== undefined ? { acceleratePaid: action.acceleratePaid } : {}),
      ...(action.optionalPowerPaid !== undefined ? { optionalPowerPaid: action.optionalPowerPaid } : {}),
      // Kinkou Monk is the first UNIT trigger with a two-slot spec; Spells have
      // carried this field since Gentlemen's Duel.
      ...(action.secondTargetUnitInstanceId !== undefined
        ? { secondTargetUnitInstanceId: action.secondTargetUnitInstanceId }
        : {}),
    });

    // **No attack dispatch here**, same as MoveUnit's contested case and for the
    // same reason: a Unit played onto an opponent-held battlefield gains the
    // Attacker designation when the Combat Showdown opens (383.4.f / 465), not
    // when it lands. cleanup.beginCombatAt fires it a Cleanup later, and finds
    // this unit by walking the battlefield rather than being handed it.
    //
    // Contested now, Showdown staged by the following Cleanup — identical
    // treatment to a Move (rule 190.4's "Moves or otherwise becomes present"),
    // which is the point of routing both through applyContested.
    return applyContested(next, action.destinationBattlefieldId, action.playerIndex);
  }

  let updatedActor: PlayerState;
  let nextState = state;

  if (card.kind === "Spell") {
    // The Dreaming Tree — "when a player CHOOSES a friendly unit here with a
    // spell". 355 makes each chosen unit a target as the Spell is ANNOUNCED, so
    // the moment is here rather than at resolution: a unit moved or killed while
    // the Spell waits on the chain was still chosen. Placed after the Spell, so
    // under LIFO (343) the Tree's draw resolves BEFORE the Spell it watched.
    // `[Repeat]`'s second execution chooses its units HERE too, not at
    // resolution: 820.1.d puts those choices "at the usual time during the Make
    // Relevant Choices step of Playing a Card", which is this moment. So a unit
    // named only by the repeat has still been chosen with a spell, and the Tree
    // has still seen it.
    //
    // Deliberately NOT extended to the `[Deflect]` surcharge, which reads the
    // same question for PRICE rather than for triggers — see
    // docs/rules-conformance.md. The enumerator prices from the variant and the
    // validator from the whole action, so taxing the repeat's choices in one and
    // not the other would produce the offered-then-refused split this codebase
    // has shipped three times. Unreachable in practice (the enumerator's repeat
    // choices mirror the first set, so any Deflect unit is already taxed once).
    const chosen = [
      action.targetUnitInstanceId,
      action.secondTargetUnitInstanceId,
      ...(action.targetUnitInstanceIds ?? []),
      action.repeatChoices?.targetUnitInstanceId,
      action.repeatChoices?.secondTargetUnitInstanceId,
      ...(action.repeatChoices?.targetUnitInstanceIds ?? []),
    ].filter((id): id is string => id !== undefined);
    updatedActor = {
      ...actor,
      ...sharedUpdates,
      trash: [...actor.trash, card],
    };
    nextState = {
      ...nextState,
      chainOpen: false,
      chainPriority: action.playerIndex,
      chainPasses: 0,
      // A played Spell opened this chain, so 347's exception does not apply and
      // Focus passes normally when it empties (346). Stated rather than inherited:
      // this is the OTHER producer of a closed chain besides the trigger flush, and
      // letting it carry a stale `true` through a spread would silently withhold a
      // Focus pass that rule 346 requires.
      chainOpenedByTrigger: false,
      // Rule 349 ends a Showdown only when "all Players have passed once in
      // sequence" — casting breaks that sequence. Without this reset, a cast
      // after the opponent had already passed once would let the very next pass
      // close the window, cutting the caster's own response short.
      consecutiveFocusPasses: 0,
      spellChain: [
        ...state.spellChain,
        {
          playerIndex: action.playerIndex,
          card,
          ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
          ...(action.secondTargetUnitInstanceId !== undefined ? { secondTargetUnitInstanceId: action.secondTargetUnitInstanceId } : {}),
          ...(action.targetUnitInstanceIds !== undefined ? { targetUnitInstanceIds: action.targetUnitInstanceIds } : {}),
          ...(action.targetChainCardInstanceId !== undefined ? { targetChainCardInstanceId: action.targetChainCardInstanceId } : {}),
          ...(action.xAmount !== undefined ? { xAmount: action.xAmount } : {}),
          ...(action.targetBattlefieldId !== undefined ? { targetBattlefieldId: action.targetBattlefieldId } : {}),
          ...(action.trashCardInstanceId !== undefined ? { trashCardInstanceId: action.trashCardInstanceId } : {}),
      ...(action.additionalCostUnitInstanceId !== undefined
        ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
        : {}),
      ...(action.additionalCostUnitInstanceIds !== undefined
        ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
        : {}),
      ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
        // Forwarded for the same reason trashCardInstanceId is: a field that
        // exists on the action, is validated, is enumerated — and is then
        // dropped on this hop — leaves the card paying its cost and doing
        // nothing. That exact bug has happened here once already.
        ...(action.additionalCostUnitInstanceId !== undefined
          ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
          : {}),
        ...(action.additionalCostUnitInstanceIds !== undefined
          ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
          : {}),
        ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
          ...(action.additionalCostUnitInstanceId !== undefined
            ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
            : {}),
          ...(action.additionalCostUnitInstanceIds !== undefined
            ? { additionalCostUnitInstanceIds: action.additionalCostUnitInstanceIds }
            : {}),
          // A Spell's destination is only ever a token-deployment zone
          // (Recruit the Vanguard); it rides the chain so the choice made at
          // cast time is what resolution sees.
          ...(action.destinationBattlefieldId !== undefined
            ? { destinationBattlefieldId: action.destinationBattlefieldId }
            : {}),
          ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
          ...(action.targetPermanentInstanceId !== undefined
            ? { targetPermanentInstanceId: action.targetPermanentInstanceId }
            : {}),
          // `[Repeat]` (820.1.c.1) — the additional cost is paid as the spell is
          // PLAYED, so whether it was paid, and the second execution's own
          // targets, are settled here at announce and ride the chain to
          // resolution. Same reasoning as every target field above: the chain
          // moves between announcing and resolving, and a choice re-derived at
          // resolution would be a different choice.
          ...(action.repeatPaid !== undefined ? { repeatPaid: action.repeatPaid } : {}),
          ...(action.repeatChoices !== undefined ? { repeatChoices: action.repeatChoices } : {}),
        },
      ],
    };
    // Fired against the board BEFORE the Spell resolves, which is where the
    // chosen units still are.
    nextState = holdUnitsChosenBySpell(nextState, action.playerIndex, chosen);
    // The board-wide counterpart, for the cards that watch a unit being chosen
    // rather than a battlefield it was standing at. Raised from the same list and
    // at the same moment (355's announcement) — the two differ only in what they
    // reach, which is why they are two calls rather than one event with a filter.
    nextState = holdUnitsChosen(nextState, action.playerIndex, chosen);
  } else {
    updatedActor = {
      ...actor,
      ...sharedUpdates,
      // Gear normally arrives ready; Iron Ballista prints "This enters
      // exhausted", which is the gear counterpart of a Unit's 143.4.a default
      // and the reason it can't shoot the turn it lands. Asked through
      // gearEntersExhausted rather than branched on here, so the rule stays with
      // the other deploy rules.
      activeGear: [...actor.activeGear, gearEntersExhausted(card.defId) ? { ...card, exhausted: true } : card],
    };
  }

  const players = [...nextState.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;
  let placed: GameState = { ...nextState, players };

  // `[Quick-Draw]` (SFD) — "When you play it, attach it to a unit you control."
  // Here rather than anywhere else because this is the ONE place a Gear enters
  // `activeGear`, so a Gear arriving by another route cannot silently skip it.
  // A no-op for every Gear without the keyword, and for a board with no unit
  // to attach to.
  if (card.kind === "Gear") placed = holdQuickDrawAttach(placed, action.playerIndex, card);

  return placed;
}
