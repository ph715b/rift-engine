import { repeatExecutionsOf, type GameState, type PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import { applyContested } from "../engine/cleanup.js";
import { dispatchOnPlayUnit } from "../engine/unit-triggers.js";
import { holdEventTrigger, holdSelfTrigger } from "../engine/triggers.js";
import { holdUnitsChosenBySpell } from "../engine/battlefield-abilities.js";
import { consumeNextUnitEntersReady, gearEntersExhausted, unitEntersReady } from "../engine/deploy.js";
import {
  freeGearPlayApplies,
  modifiedEnergyCost,
  targetChoiceDiscount,
  variantCostDiscount,
  scaledPowerDiscount,
  combatSpellPowerDiscount,
} from "../engine/cost-modifiers.js";
import { holdRunesRecycled } from "../engine/effect-helpers.js";
import { optionalAdditionalCostsFor } from "../engine/optional-additional-costs.js";
import { optionalUnitCostOf, optionalXpCostOf, optionalXpEnergyDiscountOf } from "../engine/card-effects.js";
import { restrictedPowerFor } from "../engine/rune-payment.js";
import type { PlayCardAction } from "./player-action.js";
import { validatePlayCard } from "./validate-play-card.js";
import { holdQuickDrawAttach, isEquipmentGear } from "../engine/equipment.js";
import { holdNamedTagChoice } from "../engine/named-tag.js";
import { holdUnitsChosen } from "../engine/triggers.js";
import { recordEnemyChoices } from "../engine/effect-helpers.js";
import { powerCostOf } from "../model/card.js";
import { chosenUnitsOfPlay } from "../engine/granted-keywords.js";
import { mayPlayFromTrash, mayPlayFromTrashOnCharge } from "../engine/timing.js";
import { fileIntoTrash } from "../engine/effect-helpers.js";
import { controlsEndlessRiches } from "../engine/board-restrictions.js";
import { holdsGrantedReplacedCost, replacedCostFor } from "../engine/replaced-costs.js";
import { addBattlefieldToken, baronPitEntryFor } from "../engine/battlefield-tokens.js";

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
 *     already control applies Contested (rule 450) via the identical mechanism
 *     MoveUnit's does, and the following Cleanup stages the Showdown — a
 *     confirmed real mechanic, not inferred (GameEngine.java:201-263's own
 *     "playtesting fix" comment: a unit played directly to a battlefield
 *     never opened a real Showdown even when landing on enemy-occupied
 *     territory). Landing with no opposing units is a Non-Combat Showdown
 *     rather than an instant claim (316.8.b.1); control is established when that
 *     window closes (348.2.a).
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
/**
 * Was this card played from somewhere other than its owner's HAND?
 *
 * Asked of the pre-play board, because that is the only moment the card is still
 * in the zone it is leaving. Written as "not in hand" rather than as a list of
 * the other zones, so a route added later (a fifth from-elsewhere permission)
 * answers correctly without being taught about.
 */
function playedFromElsewhere(state: GameState, action: PlayCardAction): boolean {
  if (action.fromHiddenBattlefieldId !== undefined) return true;
  return !state.players[action.playerIndex].hand.some((c) => c.instanceId === action.card.instanceId);
}

export function executePlayCard(state: GameState, action: PlayCardAction): GameState {
  const played = executePlayCardInner(state, action);
  // Two triggers, and they are not redundant. `cardPlayed` is for OTHER
  // permanents watching (Viktor - Innovator); the self-trigger is for the card
  // itself (Scrapheap's "when this is played"), which a listener walk would also
  // reach but only by accident of it happening to be in play — a Spell wouldn't be.
  //
  // BOTH are HELD as Chain Pending Items (383 / 808.1.d.3). The self-trigger used
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
    playedPowerCost: powerCostOf(action.card),
    playedDefId: action.card.defId,
    // A real card, never a token — see `isToken`'s note in triggers.ts for why
    // the two must be told apart (185 vs 350.2).
    isToken: false,
    // Ember Monk watches specifically for a play FROM facedown. Carried on the
    // existing event rather than a new one, so every other listener still sees
    // a hidden play as the play it is.
    ...(action.fromHiddenBattlefieldId !== undefined ? { fromHidden: true } : {}),
    // Kennen's "from anywhere other than your hand". Computed from the ZONE the
    // card actually came out of rather than from `fromHidden`: a facedown play is
    // one route and the trash is another, and a listener asking his question
    // wants both. `state` is the board BEFORE the play, which is the only moment
    // the card is still in the zone it left.
    ...(playedFromElsewhere(state, action) ? { fromElsewhere: true } : {}),
  });
  // Placed LAST so that under the chain's LIFO resolution (340.1) it resolves
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
  // The foreign pip's runes are recycled exactly as the other two are — a Power
  // cost recycles the rune (416) whatever domain it is owed in. They ride a
  // separate bucket on the ACTION because the validator holds them to a THIRD
  // domain rule (a named domain that is not the card's), not because they are
  // spent differently. UNL-146 Syndra - Transcendent.
  const paidPowerIds = new Set([
    ...action.payment.powerRunes,
    ...(action.payment.rainbowRunes ?? []),
    ...(action.payment.foreignPowerRunes ?? []),
  ]);
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
  const fromHidden = action.fromHiddenBattlefieldId !== undefined;
  /**
   * Call to Glory's and Wallop's "if you do, ignore this spell's cost" — the
   * same zeroing rule 811 gives a from-hidden play, and gated on the additional
   * cost having ACTUALLY been named, since declining leaves the printed cost
   * standing.
   *
   * **This was missing here entirely, and it is the FOURTH instance of the shape
   * the file's own comments already record three times — always this executor.**
   * `validate-play-card` zeroed the whole effective cost when it applied, so the
   * enumerated payment correctly owed no runes; this half then priced from the
   * raw printed cost anyway and took the Energy out of the float. Measured on
   * both cards that carry the flag: Call to Glory (3 Energy) and Wallop (2) each
   * spent their full printed cost out of a 10-Energy bank on the PAID variant,
   * identically to declining — so a caster paying from float spent the buff AND
   * the Energy, and the card's entire benefit was silently negated.
   *
   * Kept as its own binding rather than folded into `fromHidden` because the two
   * are not the same question: `fromHidden` also suppresses the target/variant
   * discounts and the replaced cost below, which a cost-ignoring play must still
   * compute — it is only the PRICE that vanishes.
   */
  const optionalUnitCost = optionalUnitCostOf(card.defId);
  const costIgnored =
    optionalUnitCost?.ignoresCostWhenPaid === true && action.additionalCostUnitInstanceId !== undefined;
  const ignoresBaseCost = fromHidden;
  const playedFromHand = actor.hand.some((c) => c.instanceId === card.instanceId);
  // Irelia - Graceful, through the SAME helper the validator priced with. This
  // half re-derives from the RAW cost by design, so a target-keyed discount
  // applied only in the validator would burn floating resources the play no
  // longer owes — the exact shape of the from-hidden bug recorded just above.
  const targetDiscount = ignoresBaseCost
    ? { energy: 0, power: 0 }
    : targetChoiceDiscount(state, action.playerIndex, chosenUnitsOfPlay(action), action.targetDiscountAxis);
  // **The CHOICE-keyed discounts, at the third site.** `variantCostDiscount`
  // (Atakhan's sacrifice, Undying Loyalty's tagged trash choice) was wired into
  // `legal-actions` and `validate-play-card` and NOT here — so a discounted play
  // was offered at the right price, validated at the right price, and then burned
  // banked Energy it no longer owed.
  //
  // That is the shape docs/rules-conformance.md already records against
  // Irelia - Graceful: "a discount applied only in the validator burns floating
  // resources the play no longer owes". Two sites of three is enough to reproduce
  // it, which is why this file re-prices from the RAW cost rather than trusting
  // the action's payment — the payment covers RUNES, and floating resources are
  // spent from this arithmetic instead.
  const variantDiscount = ignoresBaseCost
    ? { energy: 0, power: 0 }
    : variantCostDiscount(state, action.playerIndex, card.defId, {
        ...(action.additionalCostUnitInstanceId !== undefined
          ? { additionalCostUnitInstanceId: action.additionalCostUnitInstanceId }
          : {}),
        ...(action.trashCardInstanceId !== undefined ? { trashCardInstanceId: action.trashCardInstanceId } : {}),
      });
  // **"Play me for [Cost]" at the THIRD site** (356.1.a). Re-derived here rather
  // than trusted from `action.replacedCostPaid` alone, for the reason this whole
  // block exists: an action arrives from outside the engine, so the flag says
  // which price the player CHOSE and this says what that price actually is.
  //
  // A swapped BASE rather than a subtracted discount, which is what lets
  // UNL-025 Undying Legion's replacement be DEARER than its print. Everything
  // below prices from these four bindings instead of from `card.*`, so the base
  // cost modifications (356.1's "in any order") still apply on top — a replaced
  // cost reaches `modifiedEnergyCost` exactly where the printed one did.
  const replacedCost = ignoresBaseCost ? null : replacedCostFor(state, action.playerIndex, card);
  const usingReplacedCost = action.replacedCostPaid === true && replacedCost !== null;
  const baseEnergyCost = usingReplacedCost ? replacedCost.energyCost : card.energyCost;
  const basePowerCost = usingReplacedCost ? replacedCost.powerCost : card.powerCost;
  const basePowerDomain = usingReplacedCost ? replacedCost.powerDomain : card.powerDomain;
  // The card's hybrid second pip does not survive a replacement: the replaced
  // cost names its own domain (or rainbow), and carrying `powerDomainAlt` over
  // would let a Death from Below-shaped `[rainbow]` price be paid in a domain
  // the replacement never offered.
  const basePowerDomainAlt = usingReplacedCost ? undefined : card.powerDomainAlt;
  // **The OPTIONAL ADDITIONAL COSTS this play opted into** — `[Accelerate]`,
  // every paid `[Repeat]` instance, a granted `[Repeat]`, and an optional Power
  // cost. 204.2 and 820.1.c.1 make these part of what the play costs, so they
  // are ADDED to both totals below, after the base-cost modifications and never
  // floored away by them.
  //
  // **This term was missing entirely and that was a live bug for four sets.**
  // The validator priced base + additional against the float; this half priced
  // the BASE ALONE, so whenever banked Energy covered the difference the
  // additional cost was free — every `[Repeat]`, every `[Accelerate]`, every
  // optional-Power card. It is computed by the SAME function the validator
  // calls, which is the only reason the two can no longer disagree: the
  // convention this block follows — re-derive from the raw cost so the halves
  // cannot drift — is exactly what made a forgotten term invisible, three times,
  // always here.
  //
  // **The gate on all three prices below is `fromHidden || costIgnored`**, which
  // is `validate-play-card`'s own condition spelled the same way. Anything that
  // zeroes what the validator charges has to zero what this half spends, or the
  // runes come out right and the FLOAT comes out wrong — which is the entire
  // failure mode of this block, now recorded four times.
  const priceZeroed = ignoresBaseCost || costIgnored;
  const additional = priceZeroed ? { energy: 0, power: 0, rainbow: 0 } : optionalAdditionalCostsFor(state, action, card);
  const modifiedEnergy = priceZeroed
    ? 0
    : Math.max(
        0,
        // `inHand` is re-derived here rather than trusted from the validator,
        // the convention this whole block follows — it re-prices from the RAW
        // cost so the two halves cannot drift.
        modifiedEnergyCost(state, action.playerIndex, card.kind, baseEnergyCost, card.defId, playedFromHand) -
          targetDiscount.energy -
          variantDiscount.energy -
          // Poppy's "if you do, I cost [3] less" at the THIRD site. Without it
          // this half deducts floating Energy against her UNDISCOUNTED 6 and
          // burns three the play no longer owes — precisely the shape recorded
          // against Irelia - Graceful, and the reason this file re-prices from
          // the raw cost rather than trusting the validator.
          (action.optionalXpPaid === true ? optionalXpEnergyDiscountOf(card.defId) : 0),
        // ADDED OUTSIDE the `Math.max`, exactly as `validate-play-card` adds it:
        // a discount can floor the printed cost at zero, but it cannot eat into
        // an additional cost the player chose to pay on top.
      ) + additional.energy;
  const powerToPay = priceZeroed
    ? 0
    : Math.max(
        0,
        basePowerCost -
          targetDiscount.power -
          variantDiscount.power -
          scaledPowerDiscount(state, action.playerIndex, card.defId) -
          // Vex - Cheerless's friendly half. Her enemy half is a rainbow
          // surcharge and is already in `action.payment.rainbowRunes`, which this
          // function spends without re-deriving — the same treatment `[Deflect]`
          // gets, for the same reason: the validator has already priced it.
          combatSpellPowerDiscount(state, action.playerIndex, card.kind),
      ) + additional.power;
  const floatingEnergySpent = Math.min(actor.floatingEnergy, modifiedEnergy);
  // restrictedSpellEnergy (Lux-Crownguard's activated ability, Spells only)
  // drains AFTER floating Energy, for whatever floating didn't cover —
  // mirrors rune-payment.ts's computeEffectiveCost's own ordering exactly
  // (see that function's doc comment for why the order matters here even
  // though the combined *total* doesn't).
  const remainingAfterFloat = modifiedEnergy - floatingEnergySpent;
  const restrictedSpent = card.kind === "Spell" ? Math.min(actor.restrictedSpellEnergy, remainingAfterFloat) : 0;
  // Renekton's Energy, UNITS only. Drains after floating for the same reason the
  // Spell pool above does, and the two can never both apply — a Unit is not a
  // Spell, which is what keeps them separate fields rather than one tagged pool.
  const restrictedUnitSpent =
    card.kind === "Unit" ? Math.min(actor.restrictedUnitEnergy, remainingAfterFloat) : 0;
  const primaryAvailable = basePowerDomain !== null ? (actor.floatingPower[basePowerDomain] ?? 0) : 0;
  const altAvailable = basePowerDomainAlt !== undefined ? (actor.floatingPower[basePowerDomainAlt] ?? 0) : 0;
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
  // Kai'Sa's pool for a Spell, Ornn's for a Gear — asked through the SAME
  // accessor the three enumeration sites and the validator use, so what is
  // priced and what is spent cannot disagree.
  const restrictedPowerSpent = Math.min(
    restrictedPowerFor(actor, card.kind),
    powerToPay - floatingPowerSpent - rainbowPowerSpent,
  );

  // A from-hidden card was never in hand; it comes off the battlefield instead,
  // which happens on `battlefields` further down.
  // **The `[Repeat]` discard is paid HERE, with the card leaving hand.**
  // 820.1.c.1 puts a Repeat cost "during the steps of playing the spell", so it
  // is spent as the card is played rather than at resolution — the same moment
  // the Energy for a Repeat is taken.
  //
  // Removed in the same filter as the played card rather than in a later pass:
  // two sequential filters over `hand` would each rebuild it, and a card that is
  // both the play and the discard (already refused by the validator) would
  // silently survive one of them.
  const repeatDiscardId = action.repeatPaid ? action.repeatDiscardCardInstanceId : undefined;
  const repeatDiscarded = repeatDiscardId !== undefined ? actor.hand.filter((c) => c.instanceId === repeatDiscardId) : [];
  const handAfterRemoval = actor.hand.filter(
    (c) => c.instanceId !== card.instanceId && c.instanceId !== repeatDiscardId,
  );
  // Jayce - Man of Progress's permission is SPENT here, and only when it was
  // actually the thing that made this Gear free. Asked through the same
  // predicate the validator and the enumerator price with, so "was it free" and
  // "was it used up" cannot come apart — the split `nextUnitsEnterReady` keeps
  // between reading a charge and consuming one, for the same reason.
  //
  // `ignoresBaseCost` wins: a Gear played from Hidden owes nothing anyway, so
  // the window must not be burnt paying a cost that was already zero.
  const usedFreeGearPlay = !ignoresBaseCost && freeGearPlayApplies(state, action.playerIndex, card.kind, card.energyCost);
  // Last Rites' permission, asked through the same predicate the validator and
  // the enumerator gate on so "was this legal" and "was it spent" cannot come
  // apart — the split `usedFreeGearPlay` above keeps, for the same reason.
  //
  // A trash play is the one case where the card leaves a zone this file was not
  // otherwise touching. The Spell branch further down also owns `trash` (a Spell
  // trashes itself on play), and since UNL-186 Death from Below the two really do
  // meet: a Spell replayed out of its own trash is REMOVED here and APPENDED
  // there, which is the correct round trip and not a collision. The old note here
  // said `mayPlayFromTrash` offers Units only, which stopped being true when the
  // granted permission landed.
  const playedFromTrash = mayPlayFromTrash(state, action.playerIndex, card);
  // **Which permission paid for the zone**, and the reason the two are asked
  // separately at all. A player holding a banked Last Rites charge who plays
  // Undying Legion on its OWN "play me from your trash for [3][Fury]" must not
  // have the charge burnt: both predicates are true at once, and the action's
  // `replacedCostPaid` is the only thing that says which one the player took.
  //
  // Read here rather than trusted from the validator, the convention this whole
  // block follows.
  const usedTrashCharge =
    playedFromTrash &&
    !action.replacedCostPaid &&
    // Endless Riches permits the same play for free and forever, so a player who
    // has it would never choose to spend a banked charge — 372 leaves the choice
    // to the controller, and this is that choice made the only way it would ever
    // be made. Exactly the reasoning the `replacedCostPaid` clause above records,
    // one permission along.
    !controlsEndlessRiches(state, action.playerIndex) &&
    mayPlayFromTrashOnCharge(state, action.playerIndex, card);
  // The GRANTED permission's twin of the line above: read to decide the spend,
  // never spent by being read. 419.3.b's window is ONE play, so a permission that
  // outlived its own use would let one [rainbow] buy Death from Below back out of
  // the trash every turn for the rest of the game.
  const usedGrantedReplacedCost =
    action.replacedCostPaid === true && holdsGrantedReplacedCost(state, action.playerIndex, card.instanceId);
  const sharedUpdates = {
    hand: handAfterRemoval,
    channeled: remainingChanneled,
    freeGearPlaysThisTurn: actor.freeGearPlaysThisTurn - (usedFreeGearPlay ? 1 : 0),
    // The `[Repeat]` discard lands in the trash with everything else discarded
    // (390.2). Folded into `sharedUpdates` so both exit paths below carry it —
    // the Spell path overrides `trash` to append the played card, and appending
    // to THIS value is what keeps the discard from being dropped there.
    trash: [
      ...(playedFromTrash ? actor.trash.filter((c) => c.instanceId !== card.instanceId) : actor.trash),
      ...repeatDiscarded,
    ],
    trashUnitPlaysThisTurn: actor.trashUnitPlaysThisTurn - (usedTrashCharge ? 1 : 0),
    // Spent by instance, so a second copy of the same card in the same trash —
    // which was never granted anything — keeps whatever it holds.
    replacedCostPlays: usedGrantedReplacedCost
      ? actor.replacedCostPlays.filter((g) => g.instanceId !== card.instanceId)
      : actor.replacedCostPlays,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy - floatingEnergySpent + floatingEnergyGained,
    restrictedSpellEnergy: actor.restrictedSpellEnergy - restrictedSpent,
    restrictedUnitEnergy: actor.restrictedUnitEnergy - restrictedUnitSpent,
    // Deducted from whichever pool paid — they are mutually exclusive by card
    // kind, so at most one of these two ever moves.
    restrictedSpellPower: actor.restrictedSpellPower - (card.kind === "Spell" ? restrictedPowerSpent : 0),
    restrictedGearPower: actor.restrictedGearPower - (card.kind === "Gear" ? restrictedPowerSpent : 0),
    floatingRainbowPower: actor.floatingRainbowPower - rainbowPowerSpent,
    floatingPower:
      floatingPowerSpent > 0
        ? {
            ...actor.floatingPower,
            ...(primarySpent > 0 && basePowerDomain !== null ? { [basePowerDomain]: primaryAvailable - primarySpent } : {}),
            ...(altSpent > 0 && basePowerDomainAlt !== undefined ? { [basePowerDomainAlt]: altAvailable - altSpent } : {}),
          }
        : actor.floatingPower,
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
    // "If you've spent [4] or more to play a SPELL this turn" — UNL-004 Prepared
    // Neophyte and UNL-089 Jhin - Meticulous Killer, who print it verbatim.
    //
    // A MAXIMUM over single spells, not a running total: the sentence asks
    // whether some ONE spell cost that much, so two 2-Energy spells do not add up
    // to it. `modifiedEnergy` is what was actually spent after discounts, and a
    // card played for free from Hidden spends nothing.
    maxSpellEnergySpentThisTurn:
      card.kind === "Spell"
        ? Math.max(actor.maxSpellEnergySpentThisTurn, modifiedEnergy)
        : actor.maxSpellEnergySpentThisTurn,
    // "If you've played a SPELL this turn" — UNL-122 Crescent Guardian. Counted
    // here beside the maximum above rather than in the Spell branch further down,
    // so it sees every route a Spell reaches play by; the field's own note says
    // why none of the eight existing spell-named fields could answer it.
    //
    // A COUNT rather than a boolean, matching `cardsPlayedThisTurn` beside it: no
    // card asks "how many" yet, but a counter cannot be wrong for a card that
    // later does, and it costs nothing.
    spellsPlayedThisTurn: actor.spellsPlayedThisTurn + (card.kind === "Spell" ? 1 : 0),
    // "You may spend N XP as an additional cost" (204.2). Spent HERE, with the
    // rest of the cost, on the same reasoning the Legend exhaust below it gives:
    // a cost is paid for the PLAY, not for the payout, so it leaves even when the
    // exemption it buys turns out to be worth nothing. 730.2 is the spend itself
    // ("reduce the value of XP marked on the Player").
    //
    // Not routed through `spendXp`, which returns `undefined` when short: the
    // validator has already refused an unaffordable claim, and an optional
    // undefined here would silently drop every other field in this object.
    xp: actor.xp - (action.optionalXpPaid ? (optionalXpCostOf(card.defId) ?? 0) : 0),
    // Bard - Mercurial's "exhaust your legend as an additional cost". Paid here,
    // with the rest of the cost, so it is spent whether or not the trigger that
    // reads it ends up doing anything — a cost is paid for the play, not for the
    // payout. The validator has already refused an exhausted Legend, so this
    // cannot exhaust one twice.
    legend: action.exhaustLegendPaid ? { ...actor.legend, exhausted: true } : actor.legend,
    // Ornn's Forge's "the FIRST friendly non-token gear played each turn", and
    // Azir's "if you've played an Equipment this turn". Bumped HERE, in the
    // executor, for exactly the reason the Firebrand note below gives: a cost
    // modifier is asked several times per play (enumeration, validation, this
    // file's own float math) and must give the same answer each time, so the
    // thing it reads cannot move until the play is priced and paid.
    gearPlayedThisTurn: card.kind === "Gear" ? actor.gearPlayedThisTurn + 1 : actor.gearPlayedThisTurn,
    // Swain, Visionary's "you've played a non-token unit ... this turn". Bumped
    // here beside the gear counter and for the same reason, and `isToken` is
    // read off the instance because a token unit never reaches this file anyway —
    // stated rather than assumed, since that is a fact about the OTHER path.
    nonTokenUnitsPlayedThisTurn:
      card.kind === "Unit" && card.isToken !== true
        ? actor.nonTokenUnitsPlayedThisTurn + 1
        : actor.nonTokenUnitsPlayedThisTurn,
    // Azir's subset of the same moment. `isEquipmentGear` reads the DEFINITION's
    // `isEquipment`, so it is the same question `[Equip]` and `[Weaponmaster]`
    // already ask rather than a second spelling of "is this Equipment".
    equipmentPlayedThisTurn:
      card.kind === "Gear" && isEquipmentGear(card)
        ? actor.equipmentPlayedThisTurn + 1
        : actor.equipmentPlayedThisTurn,
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
    // Astral Heron's charge is spent by the NEXT CARD of any kind, so unlike the
    // spell-only one above it clears unconditionally — this file is only reached
    // by a card being played.
    nextCardEnergyDiscount: 0,
    nextCardPowerDiscount: 0,
  };

  if (card.kind === "Unit") {
    // Ready-or-exhausted lives in engine/deploy.ts now, shared with the effects
    // that play a unit without a PlayCardAction to carry the question.
    // The DESTINATION is passed because a clause can be conditioned on it —
    // Shadow's (UNL-194) "if you play me to a battlefield, I enter ready". This is
    // the real play path, and threading it only through `deploy`'s own two
    // functions left it unread here: the card arrived exhausted at a battlefield
    // and the test that caught it looked exactly like the clause not working.
    const deployedUnit = {
      ...card,
      exhausted: !unitEntersReady(
        state,
        action.playerIndex,
        card,
        action.acceleratePaid,
        action.destinationBattlefieldId !== undefined ? "battlefield" : "base",
        action.optionalPowerPaid,
      ),
    };
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

    // **UNL-147 Baron Nashor's "as you play me", and it happens BEFORE he lands.**
    //
    // "Add the Baron Pit battlefield token to the board if it's not there
    // already. If you do, I enter there." Both halves are replacements on the
    // PLAY rather than an on-play trigger: `dispatchOnPlayUnit` runs after the
    // unit is already standing somewhere, and a Baron who arrived at base and was
    // then moved would fire arrival triggers for the wrong location and contest a
    // battlefield he was never played to.
    //
    // "If you DO" is load-bearing: with the Pit already on the board nothing is
    // added, so the clause is false and he enters wherever this play named — base,
    // or a battlefield he is reinforcing. That is why this returns the destination
    // rather than forcing one.
    const baronPit = baronPitEntryFor(state, card);
    const withPit = baronPit === undefined ? state : addBattlefieldToken(state, baronPit.token);
    const destinationBattlefieldId = baronPit?.enterThere ?? action.destinationBattlefieldId;

    if (destinationBattlefieldId === undefined) {
      const players = [...withPit.players] as [PlayerState, PlayerState];
      players[action.playerIndex] = { ...updatedActor, baseUnits: [...actor.baseUnits, deployedUnit] };
      const next: GameState = { ...withPit, players };
      return dispatchOnPlayUnit(next, deployedUnit, action.playerIndex, "base", {
        // 811's facedown play, forwarded onto the unit's OWN trigger event —
        // Tornado Warrior's "when you play me from face down". The fact was
        // already known here and rode only the `cardPlayed` event.
        ...(action.fromHiddenBattlefieldId !== undefined ? { fromHidden: true } : {}),
        ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
        // Akshan - Mischievous' enemy gear. Forwarded for the reason
        // `trashCardInstanceId` beside it carries a paragraph about: a field
        // enumerated, validated, and then dropped on THIS hop leaves the card
        // paying its cost and doing nothing.
        ...(action.targetPermanentInstanceId !== undefined
          ? { targetPermanentInstanceId: action.targetPermanentInstanceId }
          : {}),
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
      ...(action.additionalCostPermanentInstanceId !== undefined
        ? { additionalCostPermanentInstanceId: action.additionalCostPermanentInstanceId }
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
        // The paid XP option (204.2). Forwarded on BOTH unit hops for the reason
        // this file records twice: a flag enumerated, validated and dropped here
        // leaves the card paying its cost and doing nothing.
        ...(action.optionalXpPaid !== undefined ? { optionalXpPaid: action.optionalXpPaid } : {}),
        // Bard - Mercurial's paid Legend exhaust. Forwarded on BOTH unit hops for
        // the reason this file records twice: a flag that is enumerated,
        // validated, and dropped here leaves the card paying its cost and doing
        // nothing.
        ...(action.exhaustLegendPaid !== undefined ? { exhaustLegendPaid: action.exhaustLegendPaid } : {}),
      // Kinkou Monk is the first UNIT trigger with a two-slot spec; Spells have
      // carried this field since Gentlemen's Duel.
      ...(action.secondTargetUnitInstanceId !== undefined
        ? { secondTargetUnitInstanceId: action.secondTargetUnitInstanceId }
        : {}),
      });
    }

    const players = [...withPit.players] as [PlayerState, PlayerState];
    players[action.playerIndex] = updatedActor;

    // Read off `withPit` and `destinationBattlefieldId`, not off `state` and the
    // action: the Baron Pit may have just been added, and it is where he lands.
    const bfIndex = withPit.battlefields.findIndex((bf) => bf.id === destinationBattlefieldId);
    const bf = withPit.battlefields[bfIndex]!;
    const battlefields = [...withPit.battlefields];
    battlefields[bfIndex] = {
      ...bf,
      units: { ...bf.units, [actor.id]: [...(bf.units[actor.id] ?? []), deployedUnit] },
    };

    let next: GameState = { ...withPit, players, battlefields };
    next = dispatchOnPlayUnit(next, deployedUnit, action.playerIndex, { battlefieldId: destinationBattlefieldId }, {
        // 811's facedown play, forwarded onto the unit's OWN trigger event —
        // Tornado Warrior's "when you play me from face down". The fact was
        // already known here and rode only the `cardPlayed` event.
        ...(action.fromHiddenBattlefieldId !== undefined ? { fromHidden: true } : {}),
      ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
        // Akshan - Mischievous' enemy gear. Forwarded for the reason
        // `trashCardInstanceId` beside it carries a paragraph about: a field
        // enumerated, validated, and then dropped on THIS hop leaves the card
        // paying its cost and doing nothing.
        ...(action.targetPermanentInstanceId !== undefined
          ? { targetPermanentInstanceId: action.targetPermanentInstanceId }
          : {}),
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
      ...(action.additionalCostPermanentInstanceId !== undefined
        ? { additionalCostPermanentInstanceId: action.additionalCostPermanentInstanceId }
        : {}),
      ...(action.discardCardInstanceId !== undefined ? { discardCardInstanceId: action.discardCardInstanceId } : {}),
      // Same Accelerate forwarding as the base branch — a reinforce play pays
      // the same optional cost and fires the same trigger.
      ...(action.acceleratePaid !== undefined ? { acceleratePaid: action.acceleratePaid } : {}),
      ...(action.optionalPowerPaid !== undefined ? { optionalPowerPaid: action.optionalPowerPaid } : {}),
        // The paid XP option (204.2). Forwarded on BOTH unit hops for the reason
        // this file records twice: a flag enumerated, validated and dropped here
        // leaves the card paying its cost and doing nothing.
        ...(action.optionalXpPaid !== undefined ? { optionalXpPaid: action.optionalXpPaid } : {}),
        // Bard - Mercurial's paid Legend exhaust. Forwarded on BOTH unit hops for
        // the reason this file records twice: a flag that is enumerated,
        // validated, and dropped here leaves the card paying its cost and doing
        // nothing.
        ...(action.exhaustLegendPaid !== undefined ? { exhaustLegendPaid: action.exhaustLegendPaid } : {}),
      // Kinkou Monk is the first UNIT trigger with a two-slot spec; Spells have
      // carried this field since Gentlemen's Duel.
      ...(action.secondTargetUnitInstanceId !== undefined
        ? { secondTargetUnitInstanceId: action.secondTargetUnitInstanceId }
        : {}),
    });

    // **No attack dispatch here**, same as MoveUnit's contested case and for the
    // same reason: a Unit played onto an opponent-held battlefield gains the
    // Attacker designation when the Combat Showdown opens (383.4.e / 465), not
    // when it lands. cleanup.beginCombatAt fires it a Cleanup later, and finds
    // this unit by walking the battlefield rather than being handed it.
    //
    // Contested now, Showdown staged by the following Cleanup — identical
    // treatment to a Move (rule 190.3.a's "Moves or otherwise becomes present"),
    // which is the point of routing both through applyContested.
    return applyContested(next, destinationBattlefieldId, action.playerIndex);
  }

  let updatedActor: PlayerState;
  let nextState = state;

  // Ezreal - Prodigal Explorer's tally, filled in by the Spell branch below and
  // applied after the acting player is written back — see the note there.
  let enemyChosen: string[] = [];
  if (card.kind === "Spell") {
    // The Dreaming Tree — "when a player CHOOSES a friendly unit here with a
    // spell". 355 makes each chosen unit a target as the Spell is ANNOUNCED, so
    // the moment is here rather than at resolution: a unit moved or killed while
    // the Spell waits on the chain was still chosen. Placed after the Spell, so
    // under LIFO (340.1) the Tree's draw resolves BEFORE the Spell it watched.
    // `[Repeat]`'s second execution chooses its units HERE too, not at
    // resolution: 820.1.d puts those choices "at the usual time during the Make
    // Relevant Choices step of Playing a Card", which is this moment. So a unit
    // named only by the repeat has still been chosen with a spell, and the Tree
    // has still seen it.
    //
    // The `[Deflect]` surcharge asks the same question for PRICE rather than for
    // triggers, and as of the 2026-08-06 ruling it reaches the repeat's choices
    // too — see `chosenUnitsOfRepeat`. The two are still separate calls: this one
    // is a multiset of ids for TRIGGERS, deduped implicitly by the listeners
    // themselves, while the surcharge is summed per choice precisely because the
    // same unit chosen twice owes twice.
    //
    // Every PAID instance's execution, not just one — `repeatExecutionsOf`
    // normalises the one-instance spelling into the same list, so a Curtain Call
    // that pays all three announces the units all four executions choose.
    const chosen = [
      action.targetUnitInstanceId,
      action.secondTargetUnitInstanceId,
      ...(action.targetUnitInstanceIds ?? []),
      ...repeatExecutionsOf(action).flatMap((execution) => [
        execution.choices?.targetUnitInstanceId,
        execution.choices?.secondTargetUnitInstanceId,
        ...(execution.choices?.targetUnitInstanceIds ?? []),
      ]),
    ].filter((id): id is string => id !== undefined);
    // **`[Flow]`'s "Then banish it" (829.1.b)** — the spell goes to `banished`
    // instead of the trash it would otherwise return to.
    //
    // Gated on the FLOW cost having actually been the one paid, not merely on the
    // card having the keyword: a Flow spell cast from HAND for its printed cost
    // trashes normally, and only the trash play banishes. `usedFlowCost` is
    // re-derived from the board rather than trusted from the action, the
    // convention this whole file follows.
    //
    // **Banished at cast rather than on leaving the chain, which 829.1.b.1
    // specifies, and that is a KNOWN divergence recorded in
    // `docs/rules-conformance.md`.** It is the existing one rather than a new
    // one: this engine already trashes a spell at cast rather than after
    // resolution (see this file's header, mirroring the oracle's
    // `payAndQueueSpell`), so Flow follows the zone timing every other spell here
    // already has. The observable gap is the same one: between cast and
    // resolution the card counts as banished rather than as trash.
    const usedFlowCost = action.replacedCostPaid === true && card.kind === "Spell" && card.flowCost !== undefined;
    updatedActor = usedFlowCost
      ? {
          ...actor,
          ...sharedUpdates,
          banished: [...actor.banished, card],
        }
      : {
          ...actor,
          ...sharedUpdates,
          // ...and onto the discard the shared updates already appended, which is
          // why the funnel is handed `sharedUpdates.trash` rather than
          // `actor.trash`. From the CHAIN, so Endless Riches banishes it instead
          // — and a spell played out of the trash under it therefore does not
          // return to that trash to be played again.
          ...fileIntoTrash(
            state,
            action.playerIndex,
            { trash: sharedUpdates.trash, banished: actor.banished },
            card,
            "elsewhere",
          ),
        };
    nextState = {
      ...nextState,
      chainOpen: false,
      chainPriority: action.playerIndex,
      chainPasses: 0,
      // A played Spell opened this chain, so 346.1's exception does not apply and
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
          // What this play actually cost in Energy, after every discount — the
          // same figure `maxSpellEnergySpentThisTurn` is maximised from three
          // lines below, so the two can never disagree about one spell.
          energySpent: modifiedEnergy,
          ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
        // Akshan - Mischievous' enemy gear. Forwarded for the reason
        // `trashCardInstanceId` beside it carries a paragraph about: a field
        // enumerated, validated, and then dropped on THIS hop leaves the card
        // paying its cost and doing nothing.
        ...(action.targetPermanentInstanceId !== undefined
          ? { targetPermanentInstanceId: action.targetPermanentInstanceId }
          : {}),
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
      ...(action.additionalCostPermanentInstanceId !== undefined
        ? { additionalCostPermanentInstanceId: action.additionalCostPermanentInstanceId }
        : {}),
      // Forwarded onto the CHAIN, not only onto a unit trigger. Rampage is the
      // pool's first SPELL with an optional Power cost, and without this hop the
      // card is enumerated at two prices and resolves identically at both — see
      // `SpellChainEntry.optionalPowerPaid`.
      ...(action.optionalPowerPaid !== undefined ? { optionalPowerPaid: action.optionalPowerPaid } : {}),
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
          // The move-to-base half of the same choice. Dropping it here is the
          // dispatch-hop field loss this repo has shipped five times, and it
          // would be silent: the spell would resolve with NO destination and
          // move nothing.
          ...(action.destinationIsBase === true ? { destinationIsBase: true as const } : {}),
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
          // Temporal Portal's granted instance. Same dropped-field hazard as
          // every field around it: enumerated, validated, then lost on the hop
          // to the chain would leave the player having paid for an execution
          // that never happens.
          ...(action.grantedRepeatPaid !== undefined ? { grantedRepeatPaid: action.grantedRepeatPaid } : {}),
          ...(action.repeatChoices !== undefined ? { repeatChoices: action.repeatChoices } : {}),
          // The multi-instance spelling of the two fields above. Forwarded here
          // rather than normalised on the way in, so the chain entry says what the
          // player announced — and so `repeatExecutionsOf` is the only place that
          // knows there are two spellings at all.
          ...(action.repeatExecutions !== undefined ? { repeatExecutions: action.repeatExecutions } : {}),
          // Which option a modal card chose. Same dropped-field hazard as every
          // field above: enumerated, validated, and then silently lost here
          // would leave Rocket Barrage resolving whichever mode came first.
          ...(action.modeId !== undefined ? { modeId: action.modeId } : {}),
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
    nextState = holdUnitsChosen(nextState, action.playerIndex, chosen, true);
    // Ezreal - Prodigal Explorer counts CHOICES, and his clause reaches gear as
    // well as units — so this is the unit choices above PLUS the permanent-target
    // fields, which is where a chosen gear rides.
    //
    // COLLECTED here, at 355's announcement, and applied at the bottom of this
    // function. It cannot be applied here: `updatedActor` is built from the
    // ORIGINAL `actor` and written back below, so anything this branch writes to
    // the acting player is silently overwritten. Recording it inline read as a
    // flat zero with nothing thrown, which is how this was found.
    enemyChosen = [
      ...chosen,
      ...[
        action.targetPermanentInstanceId,
        ...repeatExecutionsOf(action).map((execution) => execution.choices?.targetPermanentInstanceId),
      ].filter((id): id is string => id !== undefined),
    ];
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

  // UNL-138 The List — "as you play this, NAME A TAG". Here for the same reason
  // `[Quick-Draw]` is: this is the ONE place a Gear enters `activeGear`, so a
  // Gear arriving by another route cannot silently skip being asked.
  //
  // A no-op for the other 90 Gear. See `named-tag.ts` for why the name is a
  // parked decision here rather than a field fanned out on the action, and for
  // the divergence from 355's Make Relevant Choices that buys.
  if (card.kind === "Gear") placed = holdNamedTagChoice(placed, action.playerIndex, card);

  // Ezreal - Prodigal Explorer — the enemy units and gear this play CHOSE.
  placed = recordEnemyChoices(placed, action.playerIndex, enemyChosen);

  // Temporal Portal — "the NEXT SPELL you play this turn". Spent by playing a
  // spell, whether or not the granted cost was paid, and spent in FULL: two
  // Portals both name the same next spell, so both instances attach to it and
  // both are gone once it is played.
  //
  // Down here with the rest, and for the reason the note above records —
  // `updatedActor` is written back from the ORIGINAL actor, so a clear applied
  // in the Spell branch would be silently undone.
  if (card.kind === "Spell" && placed.players[action.playerIndex].nextSpellRepeatGrants > 0) {
    const cleared = [...placed.players] as [PlayerState, PlayerState];
    cleared[action.playerIndex] = { ...cleared[action.playerIndex], nextSpellRepeatGrants: 0 };
    placed = { ...placed, players: cleared };
  }

  // Sivir - Battle Mistress — the runes this play's Power cost recycled (416).
  // ONE event for the instruction with a count, not one per rune: the same
  // reading `cardsRecycled` already takes for its batch.
  return holdRunesRecycled(placed, action.playerIndex, recycled.length);
}
