import type { GameState, PlayerState } from "../model/game-state.js";
import { domainActivatedAbilities, mergeRegistries } from "./effects/index.js";
import type { CardInstance, GearInstance, LegendInstance, UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import type { TimingTier } from "./timing.js";
import { GOLD_TOKEN_DEF_ID, MECH_TOKEN, SAND_SOLDIER_TOKEN, placeToken } from "./token.js";
import type { EnergyDiscountRule } from "../model/card-definition.js";
import { DOMINUS_READY, VANGUARD_ARMORY_TOKENS } from "./constants.js";
import { goldAddsExtraEnergy } from "./board-restrictions.js";
/** Ornn - Fire Below the Mountain adds one rainbow Power per activation. */
/** Ezreal - Prodigal Explorer's "TWICE this turn" — the whole of his condition,
 *  named so the test and the check quote one number. */
const EZREAL_CHOICES_NEEDED = 2;

const ORNN_GEAR_POWER = 1;
/** Xerath - Freed (UNL-026) — a FLAT 3, unlike Caitlyn's "equal to my Might". */
const XERATH_DAMAGE = 3;
/** Dragonsoul Sage (UNL-093) — "[Add] [1 Energy]", unrestricted. */
const DRAGONSOUL_SAGE_ENERGY = 1;
/** Renata Glasc - Chem-Baroness's "an additional [1]" on each Gold. */
const RENATA_GOLD_BONUS_ENERGY = 1;
import { contextFor, type EffectContext } from "./effect-context.js";
import {
  addBuff,
  dealDamage,
  drawCards,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  legionActive,
  gainPoints,
  swapUnitLocations,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recallUnitToBase,
  recycleFromTrash,
  recycleUnitsFromTrash,
  returnPermanentToHand,
  spendBuff,
  stunUnits,
  readyPermanent,
} from "./effect-helpers.js";
import { placeRecruitToken } from "./token.js";
import { destroyUnit, fileIntoTrash, gainXp, spendXp } from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { canonicalDefId } from "../cards/card-loader.js";
import { eligibleTargets, findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
import { parkDecision } from "./decisions.js";
import { offerTopOfDeckBanish } from "./top-of-deck.js";
import { killGear } from "./triggers.js";
import { computeAutoPayment, energyAfterFloat } from "./rune-payment.js";
import type { RunePayment } from "../actions/player-action.js";
import { type TargetingSpec } from "./card-effects.js";
import { attachEquipment, attachableEquipment, copiedTextSourceFor, unitsBanishedWith } from "./equipment.js";
import { banishCard, discardCards, disempowerPermanent, empowerPermanent, isEmpowered } from "./effect-helpers.js";
import { playCardIgnoringCost } from "./play-free.js";
import { defaultCardRegistry } from "../cards/card-registry.js";

/**
 * Abilities you activate by exhausting the permanent that has them — the
 * ":rb_exhaust::" cost printed on a third of this card pool.
 *
 * This replaces a single hardcoded case. validate-activate-ability.ts carried
 * `ACTIVATABLE_UNIT_DEF_IDS = new Set(["OGS-014"])` and execute-activate-ability
 * carried Lux - Crownguard's effect inline, with a comment saying to widen it
 * "the day a second activated-ability card is implemented". This is that day, and
 * the widening is a registry rather than a second branch because of the shape of
 * what's left: 20 of the 30 Gear in this pool are exactly "exhaust: do one thing",
 * and none of them could be reached at all before — the action only ever looked at
 * units.
 */

/** Where an activated ability lives. Gear and Units take the same action and pay
 *  the same exhaust cost; they differ only in which zone the permanent sits in,
 *  which is why one registry can serve both. */
export type ActivatableKind = "Unit" | "Gear" | "Legend";

export interface ActivatedAbilityEvent {
  /** Chosen ahead of the action, same constraint as every other effect in this
   *  engine — it cannot pause mid-resolution to ask. */
  targetUnitInstanceId?: string;
  /** Where the target is moved to, for a mode that declares `movesTarget` —
   *  Yasuo - Unforgiven's "from its base". */
  destinationBattlefieldId?: string;
  /** The unit OR gear OR facedown card a `unitOrGear`-kind spec named (Pack of
   *  Wonders). Separate from `targetUnitInstanceId` because a gear is not a unit
   *  and a facedown card is neither. */
  targetPermanentInstanceId?: string;
  /** The X the activator chose, for an ability with an X cost — Hextech
   *  Anomaly's and Ancient Henge's "pay any amount". Carried explicitly rather
   *  than derived from the payment, for the reason Bullet Time's `xAmount`
   *  gives: the rainbow bucket also holds a `[Deflect]` surcharge, and the two
   *  must never be confused. */
  xAmount?: number;
  /**
   * The permanent the COST named — Malzahar - Fanatic's kill, Forgotten
   * Signpost's exhaust.
   *
   * **The event carried nothing about the cost until 2026-08-14**, and that was
   * the second of the two gaps UNL-045 Forgotten Signpost was refused on: "move
   * a different unit you control to the location of the unit you exhausted TO
   * PAY FOR THIS ABILITY" cannot be resolved without knowing who paid. Forwarded
   * by `execute-activate-ability` from the action field of the same name, so it
   * is the same choice the enumerator fanned out and the validator re-derived —
   * not a fourth reading of it.
   */
  costPermanentInstanceId?: string;
}

/**
 * What activating costs. Every ability in this pool so far exhausts its source,
 * but that is not universal — Vi - Destructive reads "Recycle 1 from your trash:"
 * with no exhaust symbol at all, so it is repeatable while the trash lasts.
 * Assuming the exhaust would have quietly made her once per turn.
 */
/**
 * The cards in `playerIndex`'s hand that may pay `cost`'s discard.
 *
 * ONE walk for the four callers that must agree — affordability, enumeration,
 * validation and payment. Sky Cruiser's "discard a GEAR" is the first cost in the
 * pool that narrows this; before it, every discard cost took any card and the
 * four sites each read `hand` directly, which is exactly how they drift.
 */
export function discardableForCost(
  state: GameState,
  playerIndex: 0 | 1,
  cost: { discardKind?: CardInstance["kind"] },
): CardInstance[] {
  const hand = state.players[playerIndex].hand;
  return cost.discardKind === undefined ? [...hand] : hand.filter((c) => c.kind === cost.discardKind);
}

export interface ActivationCost {
  /** Exhaust the source. Absent means the ability does NOT exhaust. */
  exhaust?: true;
  /**
   * `[Spend N XP]` as part of an activation cost — Kha'Zix - Voidreaver's third
   * ability, "Spend 2 XP, [Exhaust]: ...".
   *
   * XP was spendable as an ADDITIONAL cost on a PLAY (`OPTIONAL_XP_COSTS`) and
   * as an effect, but never as part of an ACTIVATION, which is why a wave-7
   * agent could describe Kha'Zix's third clause precisely and not write it.
   *
   * Paid from state through `spendXp`, exactly as Power is paid from state
   * through `payPowerFromChanneled`: there is nothing to choose, so it needs no
   * field on the action. `spendXp` returns undefined when the player is short,
   * which gives the same all-or-nothing contract 416.3 gives a Recycle.
   */
  xp?: number;
  /** Recycle this many cards from the controller's own trash (rule 416). */
  recycleFromTrash?: number;
  /**
   * Recycle this many UNITS from the controller's own trash — Assembly Rig's
   * "Recycle a unit from your trash".
   *
   * Its own field rather than a filter on `recycleFromTrash` above, because the
   * two differ in what they can be PAID WITH and therefore in when the ability
   * is offered at all: a trash of three Spells pays Vi's Recycle and cannot pay
   * this one. Folding them together would need every reader of the plain field
   * to remember a filter it has never had.
   *
   * WHICH units go is not offered as a choice, matching `recycleFromTrash`'s own
   * front-of-trash convention and for the same bounded-enumeration reason.
   */
  recycleUnitFromTrash?: number;
  /**
   * "Pay any amount of :rb_rune_rainbow:" (Hextech Anomaly) or "any amount of
   * Energy" (Ancient Henge) — an X the ACTIVATOR chooses.
   *
   * A flag rather than an amount, because X is by definition the player's
   * choice: `legal-actions` fans out one variant per affordable X and the
   * validator re-derives the price from the X the action names. The same shape
   * `hasXRainbowCost` already gives Bullet Time, a SPELL.
   *
   * Two fields rather than one, because they are paid from different pools and
   * each of these two cards converts one into the other: folding them together
   * would let Ancient Henge be paid in the rainbow Power it exists to PRODUCE.
   */
  xRainbowPower?: true;
  xEnergy?: true;
  /**
   * Energy, paid from channeled runes and floating Energy exactly as a card's
   * Energy cost is — both preset Legend abilities read ":rb_energy_1:,
   * :rb_exhaust::", so the exhaust is only half the price.
   *
   * Unlike the other two, this one cannot be paid from state alone: which runes
   * go is a choice, so it rides on the action as a `payment`, the same way
   * PlayCardAction's does. The Java oracle's own action shape agrees —
   * `ActivateUnit(unit, target, RunePayment payment, String viaAbility)`.
   */
  energy?: number;
  /** Spend a Buff on the source (rule 702.2.b) — Udyr's whole cost. Like Vi's
   *  Recycle, this is a cost with no exhaust, so the ability repeats as long as
   *  buffs keep arriving. */
  spendBuff?: true;
  /**
   * Kill the source to pay — Forge of the Future's "Kill this:".
   *
   * The only cost that destroys what it is paid with, so it is once and only
   * once by construction rather than by an exhaust. Routed through `killGear`
   * when it is paid, so the gear's own "when I am killed" self-trigger still
   * fires: being spent as a cost is still being killed.
   */
  killSelf?: true;
  /**
   * BANISH the source to pay — The Zero Drive's "Banish this:".
   *
   * Not `killSelf` with a different destination. Killing a gear fires its "when
   * I am killed" self-trigger and files it in a trash where a dozen cards in this
   * pool can recur it; banishing it fires nothing and puts it somewhere nothing
   * here reaches. For the Zero Drive that difference IS the card — the whole
   * point of the cost is that the Drive does not come back for a second harvest.
   *
   * Like `killSelf`, once and only once by construction rather than by an
   * exhaust: a Drive that has paid is gone.
   */
  banishSelf?: true;
  /**
   * **Disempower this permanent to pay** — the cost three Vendetta Legends print
   * ("Disempower me, [Exhaust]: ...").
   *
   * A cost rather than an `[Empowered][>]` gate, and the difference is the whole
   * design of those cards: an Empowered-gated ability can be used every turn the
   * status is held, while this SPENDS the status, so the Legend has to be
   * re-empowered before it can be used again. Jayce - Defender of Tomorrow's
   * `[Empowered][>]` ability is the other shape, one file over, and reads
   * identically on the card face.
   *
   * 416.3 makes an unpayable cost one that is not offered, so a Legend that is
   * not Empowered simply does not present the ability — `canPayActivationCost`
   * asks, and `abilitiesAvailableTo` never sees it.
   */
  disempowerSelf?: true;
  /**
   * Power of a specific domain, recycled from the channeled pool (rule 416) —
   * Treasure Trove's "[Chaos], Exhaust: Kill this".
   *
   * Distinct from `energy` above, which exhausts runes and rides a chosen
   * `payment` on the action: a Power cost RECYCLES the rune to the bottom of the
   * deck instead, and which rune goes is not a meaningful choice when they all
   * match the same domain. So it is paid from state through
   * `payPowerFromChanneled`, the same helper Flame Chompers and Mistfall use,
   * and needs nothing on the action.
   */
  /**
   * Power of a specific domain, recycled from the channeled pool (rule 416).
   *
   * `null` is RAINBOW — any domain pays — which is what `payPowerFromChanneled`
   * has always meant by `null` and what Temporal Portal's pip prints. Widened
   * rather than given a second field, because every consumer here already hands
   * this straight to that function.
   */
  power?: { domain: Domain | null; count: number };
  /**
   * Kill a friendly permanent to pay — Malzahar - Fanatic's "Kill a friendly unit
   * or gear, Exhaust:".
   *
   * The FIRST activation cost that carries a CHOICE. Every other cost here is
   * paid from state (an exhaust, a Recycle, a Power) or from a payment the action
   * already carries, so nothing had to be picked. This one names a permanent, so
   * it rides on the action as `costPermanentInstanceId` and `legal-actions` fans
   * out one candidate per eligible target — the same shape a targeted ability
   * already takes, one field over.
   *
   * Distinct from `killSelf` above, which destroys the SOURCE and so needs no
   * choice at all.
   */
  killFriendlyPermanent?: true;
  /**
   * Exhaust a friendly UNIT to pay — Forgotten Signpost's "Exhaust a unit you
   * control, [Exhaust]:", where the second symbol is the source's own exhaust.
   *
   * A separate field from `killFriendlyPermanent` above rather than a mode of
   * it, because it does something entirely different to what it names: that one
   * KILLS, and this one leaves the unit standing. They ride the SAME action field
   * (`costPermanentInstanceId`, "the permanent the cost named") because no card
   * prints both and the question is the same one.
   *
   * UNITS only, not gear — the card says "a unit you control", and a gear's
   * exhaust is a different resource. Ready only, since 416 has nothing to take
   * from an already-exhausted unit; `exhaustableFriendlyUnits` is the one walk
   * that decides this, shared by the enumerator, the affordability check, the
   * validator and the payment.
   */
  exhaustFriendlyUnit?: true;
  /**
   * Discard cards from hand to pay — Unlicensed Armory's "Discard 1, Exhaust:".
   *
   * A count rather than a boolean, matching `recycleFromTrash` above. WHICH card
   * goes is a real choice and rides on the action as `costDiscardCardInstanceId`,
   * for the same reason the kill above does.
   */
  discard?: number;
  /**
   * WHICH cards may pay that discard — Sky Cruiser's "Discard a GEAR".
   *
   * Absent means any card in hand, which is Unlicensed Armory's "Discard 1" and
   * leaves it untouched. Present narrows the walk, and the narrowing has to be
   * shared rather than checked at one site: a hand of five spells cannot pay this
   * cost at all, so it decides whether the ability is OFFERED (416.3), not only
   * whether a submitted discard is legal.
   *
   * `discardableForCost` is the one walk, asked by the affordability check, the
   * enumerator, the validator and the payment — the same four-caller discipline
   * `exhaustableFriendlyUnits` keeps, and for the same reason: those four
   * disagreeing is this codebase's most-repeated bug.
   */
  discardKind?: CardInstance["kind"];
  /**
   * An Energy price that reads the BOARD — the "This ability costs [N] less…"
   * sentence three Vendetta units print after their `[Empower]` pips.
   *
   * **827.1.c.3 makes this part of the cost, not a discount applied to it**:
   * such text "is taken into account when determining a card's Empower cost for
   * any reason". So the number here is not a modifier on a real price, it IS how
   * the price is computed, and every site that asks what the ability costs has to
   * go through the one function that applies it.
   *
   * That function is `activationCostFor`, which already existed for Hextech
   * Gauntlets' target-scaled Energy and is reached by all four consumers — the
   * enumerator, `canPayActivationCost`, the validator and `payActivationCost`.
   * Unlike the Gauntlets, this needs no per-card set: the rule travels ON the
   * cost, so a fourth card printing the sentence costs nothing here.
   *
   * Applied AFTER the flat `energy` above and floored at 0 (357.4 — a cost cannot
   * go below zero), which is what makes Frostcoat Mother's 12 free at 12 runes
   * rather than a negative that pays the player.
   */
  energyDiscount?: EnergyDiscountRule;
}

/**
 * One option of a modal ability — Udyr's "Choose one you've not chosen this
 * turn", whose four modes target differently from each other (two want a unit at
 * a battlefield, two want nothing). That is why targeting lives per MODE and not
 * on the ability: enumeration has to know what each option needs before the
 * player has picked one.
 */
export interface AbilityMode {
  id: string;
  /** What the board's button says. */
  label: string;
  targeting: TargetingSpec;
  /**
   * This mode moves its target somewhere the player must also choose, so
   * enumeration fans out per battlefield as well as per target — Yasuo -
   * Unforgiven's "move a friendly unit ... from its base".
   *
   * A flag on the MODE rather than on the ability because Yasuo's other mode
   * (going home) has an implicit destination and must not be fanned out.
   */
  movesTarget?: true;
  /**
   * This mode moves its target to wherever the COST PAYER is standing —
   * UNL-045 Forgotten Signpost, "move a different unit you control to the
   * location of the unit you exhausted to pay for this ability".
   *
   * **Not `movesTarget`, and the difference is the whole reason this card was
   * refused twice.** `movesTarget` means the destination is a THIRD choice the
   * player makes, fanned out per battlefield. Here the destination is not chosen
   * at all: it is wherever the payer already stands, which is why the card needs
   * no base-destination field on `ActivateAbilityAction` (the gap a wave-8 note
   * predicted would sink this) and why SFD-050 Azir's swap, not Yasuo's move, is
   * the working precedent.
   *
   * Two pairings follow from the printed text and are enforced by
   * `costPayerPairingAllowed`, which the enumerator and the validator both call:
   * the payer is not the target ("a DIFFERENT unit"), and the target is not
   * already standing where the payer is (a move that moves nobody, which the
   * player would have paid an exhaust for).
   */
  movesTargetToCostPayer?: true;
  /**
   * This mode ATTACHES an Equipment to the unit it targets, so enumeration fans
   * out per Equipment as well as per unit — Jax - Grandmaster At Arms.
   *
   * The value says WHICH Equipment are eligible, because Jax's two modes differ
   * on exactly that: `"detached"` is his priced mode ("attach a DETACHED
   * Equipment"), `"attached"` his free one ("attach an ATTACHED Equipment",
   * i.e. move one). A single boolean would collapse the pair into one ability
   * that costs the cheaper of the two prices for either job.
   *
   * The Equipment rides `targetPermanentInstanceId` and the unit
   * `targetUnitInstanceId` — a gear must never reach a reader expecting a unit,
   * the same separation `unitOrGear` and `{ kind: "gear" }` already keep.
   */
  attachesEquipment?: "detached" | "attached" | "any";
  /**
   * The OPTIONAL second choice on Azir - Ascendant: "if it's equipped, **you may
   * attach one of its Equipment to me**".
   *
   * A different AXIS from `attachesEquipment` above, not a fourth value of it.
   * That one chooses an Equipment to attach TO the target; this one chooses one
   * currently ON the target and attaches it to the SOURCE. The direction is
   * reversed, so sharing the field would make every existing reader wrong about
   * which permanent ends up wearing what.
   *
   * **Optional, so the enumeration includes a DECLINE variant** — a bare
   * `targetUnitInstanceId` with no Equipment named. "You may" has to stay
   * refusable even when a legal Equipment exists.
   *
   * Fanned out at ANNOUNCE time like every other choice here, which is exactly
   * what this card's old partial note said was missing: it is a second target on
   * the action, not a question asked mid-resolution.
   */
  attachesFromTargetToSelf?: true;
  /**
   * What THIS mode costs, when the modes of one ability are priced differently —
   * Jax again, whose detached-attach costs `[1]` and whose re-attach is free.
   *
   * Overrides the ability's own `cost` entirely rather than merging with it: a
   * mode that names a price names the whole price, so reading one is never a
   * question of which fields came from where.
   *
   * Threaded through `activationCostOf(defId, modeId)`, which is what every
   * pricing site goes through — `canPayActivationCost`, `payActivationCost`, the
   * enumerator's payment and the validator's re-derivation. A per-mode price that
   * reached only some of those would be the offered-then-refused split this
   * codebase keeps paying for, and it would be silent.
   */
  cost?: ActivationCost;
  resolve: (state: GameState, ctx: EffectContext, event: ActivatedAbilityEvent, sourceInstanceId: string) => GameState;
}

export interface ActivatedAbilityDefinition {
  kind: ActivatableKind;
  /**
   * The options, for a modal ability. Declare EITHER this or the
   * `targeting`/`resolve` pair below — never both.
   *
   * Everything downstream works in modes regardless: `modesOf` turns a plain
   * ability into a single unnamed one, so enumeration, validation and execution
   * have one code path rather than a modal branch each. That is the difference
   * between adding a mechanic and adding it three times.
   */
  modes?: readonly AbilityMode[];
  /** "you've not chosen this turn" — each mode usable once per turn, tracked on
   *  the SOURCE (`UnitInstance.abilityModesUsedThisTurn`) so two copies of the
   *  card do not share one allowance. */
  modesOncePerTurn?: true;
  /** Defaults to `{ exhaust: true }` when omitted — the common case. */
  cost?: ActivationCost;
  /**
   * True when the ability banks a resource for a later play rather than changing
   * the board — Lux - Crownguard's "+2 Energy, spells only" is the whole category
   * today.
   *
   * The heuristic AI needs this. It filters candidates it has no evaluative basis
   * for, and `evaluate` scores board state only, so an ability that merely stores
   * Energy would score a meaningless tie with Pass. That reasoning was originally
   * written as a blanket "skip every ActivateAbility", which was correct while the
   * only such ability banked a resource and became wrong the moment a gear ability
   * moved Might — a change `evaluate` can see perfectly well. Flagging the
   * resource-bankers keeps the original judgement and drops the overreach.
   */
  banksResource?: true;
  /** What the player must choose before submitting. Reuses card-effects.ts's
   *  TargetingSpec so legal-actions' existing fan-out and the web UI's existing
   *  target picker both apply unchanged. */
  targeting?: TargetingSpec;
  /** A NON-modal ability that moves its target to the cost payer — UNL-045
   *  Forgotten Signpost. Carried onto the synthetic sole mode by `modesOf`, the
   *  same way `attachesEquipment` is, so the axis is declared once whether or
   *  not the ability has modes. */
  movesTargetToCostPayer?: true;
  /** A NON-modal ability that attaches an Equipment — Forge of the Fluft's
   *  grant. Carried onto the synthetic sole mode by `modesOf`, so the axis is
   *  declared in one place whether or not the ability has modes. */
  attachesEquipment?: "detached" | "attached" | "any";
  /**
   * The OPTIONAL second choice on Azir - Ascendant: "if it's equipped, **you may
   * attach one of its Equipment to me**".
   *
   * A different AXIS from `attachesEquipment` above, not a fourth value of it.
   * That one chooses an Equipment to attach TO the target; this one chooses one
   * currently ON the target and attaches it to the SOURCE. The direction is
   * reversed, so sharing the field would make every existing reader wrong about
   * which permanent ends up wearing what.
   *
   * **Optional, so the enumeration includes a DECLINE variant** — a bare
   * `targetUnitInstanceId` with no Equipment named. "You may" has to stay
   * refusable even when a legal Equipment exists.
   *
   * Fanned out at ANNOUNCE time like every other choice here, which is exactly
   * what this card's old partial note said was missing: it is a second target on
   * the action, not a question asked mid-resolution.
   */
  attachesFromTargetToSelf?: true;
  /**
   * A restriction on ACTIVATING rather than on resolving — Caitlyn - Patrolling's
   * "use this ability only while I'm at a battlefield".
   *
   * Has to be here rather than as a guard inside `resolve`: a resolver that
   * refused would already have taken the exhaust, so the player would pay for
   * nothing. Asked by `canPayActivationCost`, which both the enumerator and the
   * validator go through, so the ability cannot be offered and then refused.
   */
  availableWhile?: (state: GameState, playerIndex: 0 | 1, sourceInstanceId: string) => boolean;
  /** `sourceInstanceId` is the permanent being activated — needed by any ability
   *  whose text says "me" rather than naming a target. Omitted for a modal
   *  ability, whose modes each carry their own. */
  resolve?: (state: GameState, ctx: EffectContext, event: ActivatedAbilityEvent, sourceInstanceId: string) => GameState;
}

/**
 * Lux - Crownguard: "Exhaust: Add 2 Energy. Use only to play spells."
 *
 * Moved here verbatim from execute-activate-ability.ts — the granted Energy still
 * lands in PlayerState.restrictedSpellEnergy, the separate pool that only Spell
 * costs may drain (rune-payment.ts's computeEffectiveCost). Behaviour is
 * unchanged; only where it lives moved.
 */
/** Vendetta's Legends, wave 1 — the three that need no new event of their own
 *  beyond the `empowerPermanent` hook two of them share. */
const RENEKTON_BUTCHER = "VEN-141";
const RENEKTON_POWER = 2;
const RENEKTON_ENERGY = 2;
const ZED_MASTER_OF_SHADOWS = "VEN-143";
const KENNEN_HEART_OF_THE_TEMPEST = "VEN-155";
const KENNEN_ASSAULT = 2;

const SHEN_EYE_OF_TWILIGHT = "VEN-147";
const MEL_SOULS_REFLECTION = "VEN-151";
const MEL_SHRINK = 2;
const AMBESSA_MATRIARCH = "VEN-153";

const LUX_CROWNGUARD = "OGS-014";

/** Orb of Regret: "Exhaust: Give a unit -1 Might this turn, to a minimum of 1
 *  Might." The first Gear in this engine that does anything at all. */
const ORB_OF_REGRET = "OGN-090";
/** Heart of Dark Ice's pump — its own constant beside the Orb's, so the two
 *  mirror-image numbers are read from one place each. */
const HEART_OF_DARK_ICE_MIGHT = 3;
const VIKTOR_HERALD = "OGN-265";
const LEE_SIN_BLIND_MONK = "OGN-257";
const UDYR_WILDMAN = "OGN-157";

/**
 * Baited Hook: "[1 Energy][Order], Exhaust: Kill a friendly unit. Look at the top
 * 5 cards of your Main Deck. You may banish a unit from among them that has Might
 * up to 1 more than the killed unit and play it, ignoring its cost. Then recycle
 * the rest."
 *
 * **The first ability in the pool to combine `energy` with `power`** — the case
 * `activationPayment` was rewritten for, and which this file's own comment named
 * as hypothetical until now.
 *
 * Its cost is payable off a SINGLE Ready Order rune, which looks wrong and is
 * right: a Basic Rune has two printed abilities (164.2), `[E]: Add [1]` and
 * `Recycle this: Add [C]`, so a Ready rune can be exhausted for the Energy and
 * then recycled for the Power. See the rune double-duty row in
 * docs/rules-conformance.md.
 */
const BAITED_HOOK = "OGN-242";

/** Vi - Destructive: "Recycle 1 from your trash: Give me +1 Might this turn."
 *  The first ability whose cost is NOT an exhaust. */
const VI_DESTRUCTIVE = "OGN-036";

/** The four OGN Legends whose whole printed text is an activated ability. */
const MISS_FORTUNE_BOUNTY_HUNTER = "OGN-267";

/** Forge of the Fluft — a BATTLEFIELD whose printed text is an ability its
 *  controller's Legend has. Keyed here by the battlefield's own defId, the way
 *  the Gold token's ability is keyed by the token's. */
/** Jayce - Defender of Tomorrow and his two suffixed READY ability keys — see
 *  `abilitiesAvailableTo` for why they are not keyed on his bare defId. */
const JAYCE_DEFENDER = "VEN-149";
/** Dominus (VEN-142) grants this onto a unit for the turn — "[rainbow][rainbow]:
 *  Ready me." A synthetic key, like Jayce's two below, because no card prints
 *  it. The key itself lives in the leaf `constants.ts`: the file that GRANTS it
 *  is a per-domain effects file, and importing a value from here into one of
 *  those closes an import cycle. That comment carries the failure. */
const DOMINUS_READY_POWER = 2;

const JAYCE_READY = "VEN-149-ready";
const JAYCE_READY_EMPOWERED = "VEN-149-ready-empowered";

const FORGE_OF_THE_FLUFT = "SFD-208";
/** Gardens of Becoming (UNL-213) — "Units here have '[Exhaust]: Gain 1 XP.'" */
const GARDENS_OF_BECOMING = "UNL-213";
const GARDENS_OF_BECOMING_XP = 1;
const DARIUS_HAND_OF_NOXUS = "OGN-253";
const KAISA_DAUGHTER_OF_THE_VOID = "OGN-247";
const YASUO_UNFORGIVEN = "OGN-259";

/** Sun Disc: "Exhaust: [Legion] — The next unit you play this turn enters
 *  ready." The first Gear whose ability arms a charge rather than changing the
 *  board. */
const SUN_DISC = "OGN-021";

/** Forge of the Future: "Kill this: Recycle up to 4 cards from trashes." The
 *  first ability in the pool paid for with the source's own destruction. */
const FORGE_OF_THE_FUTURE = "OGN-212";

/**
 * The six Seals — one per domain, and the same sentence six times: "Exhaust:
 * Add 1 <domain> Power."
 *
 * Generated rather than written out six times, because they are one card with a
 * parameter and six hand-copied entries is six chances to paste the wrong
 * domain. That is the opposite of the "small precise table" convention used
 * elsewhere in this file, and it earns the exception: those tables hold cards
 * that differ, this holds a card that does not.
 *
 * The Power lands in `floatingPower`, the per-domain pool a card's Power pip
 * already drains — so a Seal is a rune you keep, which is exactly what makes it
 * worth a card at 1 Power.
 */
const SEALS: ReadonlyArray<readonly [defId: string, domain: Domain]> = [
  ["OGN-040", "Fury"],
  ["OGN-081", "Calm"],
  ["OGN-120", "Mind"],
  ["OGN-163", "Body"],
  ["OGN-204", "Chaos"],
  ["OGN-245", "Order"],
];

function sealAbility(domain: Domain): ActivatedAbilityDefinition {
  return {
    kind: "Gear",
    targeting: { kind: "none" },
    // Banks a resource and changes nothing on the board, so the AI's
    // board-state evaluator cannot price it — same flag, same reason, as
    // Lux - Crownguard and Darius.
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = {
        ...actor,
        floatingPower: { ...actor.floatingPower, [domain]: (actor.floatingPower[domain] ?? 0) + 1 },
      };
      return { ...state, players };
    },
  };
}

/** Is this card one of Teemo's own units? A name-prefix match, the same idea
 *  `isEligibleChampion` uses to decide which champion belongs to which legend —
 *  one definition of "a Teemo" rather than a second tag nobody would maintain. */
function isTeemoUnit(card: { name: string; kind: string }): boolean {
  return card.kind === "Unit" && card.name.startsWith("Teemo - ");
}

/** Teemo - Swift Scout's retrieval: Champion Zone first, then the trash. */
function retrieveTeemo(state: GameState, playerIndex: 0 | 1): GameState {
  const actor = state.players[playerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];

  if (actor.championZone && isTeemoUnit(actor.championZone)) {
    players[playerIndex] = { ...actor, championZone: null, hand: [...actor.hand, actor.championZone] };
    return { ...state, players };
  }
  const fromTrash = actor.trash.find((c) => isTeemoUnit(c));
  if (!fromTrash) return state; // nothing to fetch — 055's do as much as you can
  players[playerIndex] = {
    ...actor,
    trash: actor.trash.filter((c) => c.instanceId !== fromTrash.instanceId),
    hand: [...actor.hand, fromTrash],
  };
  return { ...state, players };
}

/** Malzahar - Fanatic's yield — two rainbow Power for one friendly permanent. */
const MALZAHAR_POWER = 2;

/**
 * Every Gear whose printed `[Equip]` cost this engine can express, as a
 * generated activated ability.
 *
 * **This is what makes 25 Equipment cards need no per-card code at all.** The
 * cost parses out of the printed text, the attach is generic, and the ability
 * is the same shape for all of them — so a table entry per card would be 25
 * copies of one thing, each free to drift.
 *
 * Four are EXCLUDED and each is named rather than silently dropped:
 *
 *   The 4 rainbow-cost Equipment (Spinning Axe, Forgefire Cape, Rabadon's
 *   Deathcrown, Shurelya's Requiem). `ActivationCost.power` names ONE domain,
 *   and rainbow is not a domain — `Colorless` is a real printed identity, so
 *   reusing it would let a Colorless rune pay a rainbow cost and nothing else.
 *   The `rainbowRunes` payment bucket exists but belongs to the `[Deflect]`
 *   surcharge, and sharing it would make "what this ability costs" and "what
 *   the opponent taxed" indistinguishable. Needs its own cost kind.
 *
 * The two COMPOUND costs (Last Rites, Blade of the Ruined King) are excluded
 * one step earlier, by `parseEquipCost` refusing to match them — see its own
 * comment for why a looser pattern would make both cards cheaper than printed.
 */
function equipAbilities(): Record<string, ActivatedAbilityDefinition> {
  const out: Record<string, ActivatedAbilityDefinition> = {};
  for (const def of defaultCardRegistry().all()) {
    if (def.type !== "Gear" || def.equipCost === undefined) continue;
    const { energy, domain, count, extra } = def.equipCost;
    out[def.id] = {
      kind: "Gear",
      // NO exhaust: the printed reminder is "<rune>: Attach this to a unit you
      // control", and an exhaust nobody printed would make every Equipment a
      // once-per-turn attach. Re-equipping is legal and is the point —
      // [Weaponmaster] says so outright ("even if it's already attached").
      // **RAINBOW is `null`**, which is what `payPowerFromChanneled` has always
      // meant by it (811's pip, Sett - The Boss's). These four — Spinning Axe,
      // Forgefire Cape, Rabadon's Deathcrown, Shurelya's Requiem — were skipped
      // outright while `ActivationCost.power.domain` was `Domain`, so they could
      // not be attached AT ALL. Temporal Portal widened the type for its own
      // rainbow pip; that is the whole of what these needed.
      //
      // Not mapped to `Colorless`, which is a real printed identity: conflating
      // the two would let a Colorless rune pay a rainbow cost and nothing else.
      // `parseEquipCost`'s own comment draws the same line for the same reason.
      // The COMPOUND half — Last Rites' "Recycle 2 cards from your trash" and
      // Blade of the Ruined King's "Kill a friendly unit". Spread rather than
      // translated, because `EquipExtraCost` is deliberately shaped as the
      // `ActivationCost` fields it becomes; both already existed for ABILITIES
      // (Vi's Recycle, Malzahar's kill) and needed no new cost model.
      cost: {
        power: { domain: domain === "rainbow" ? null : domain, count },
        ...(energy > 0 ? { energy } : {}),
        ...(extra ?? {}),
      },
      targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
      // `sourceInstanceId` is the 4th argument, not a field on the event — it
      // is the gear being activated, i.e. the thing that gets attached.
      resolve: (state, ctx, event, sourceInstanceId) =>
        event.targetUnitInstanceId === undefined
          ? state
          : attachEquipment(state, ctx.casterIndex, sourceInstanceId, event.targetUnitInstanceId),
    };
  }
  return out;
}

/**
 * Every card whose printed `[Empower]` cost this engine can express, as a
 * generated activated ability — 827.
 *
 * **827.1.c.1 spells the keyword out as an ability**: "Empower is functionally
 * short for '[Cost]: Empower this. Play only if not Empowered.'" That is exactly
 * an `ActivatedAbilityDefinition` with a cost, a resolver and an `availableWhile`,
 * so the keyword needs no new machinery — the same finding `[Equip]` produced
 * above, and the reason both are generated rather than tabulated.
 *
 * **NO targeting**, per 827.1.b.1: "The source game object is not a target of the
 * Empower ability." It empowers itself, so the resolver reads `sourceInstanceId`
 * and nothing else — which also means no `[Deflect]` surcharge can attach to it,
 * correctly, since nothing is being chosen.
 *
 * **The "only if not Empowered" half is `availableWhile`, not a guard inside the
 * resolver**, and that placement is load-bearing for the reason this file's Vi
 * note already gives: a resolver that refused would have taken the cost first, so
 * the player would pay to do nothing. Both the enumerator and the validator reach
 * it through `canPayActivationCost`.
 *
 * Cards whose Empower cost is COMPOUND ("— Discard 1", "— Kill a friendly unit")
 * or carries its own modifying text ("costs [1] less for each rune you control")
 * are excluded one step earlier, by `parseEmpowerCost` refusing to read them —
 * see its comment. They report unimplemented, which is what they are.
 */
/** A resource cost as the board's button should read it — "[1]", "[Body]", or
 *  both. Only ever used for an alternative Empower's two modes, whose whole
 *  point is that the player is choosing between two PRICES, so the label has to
 *  be the price. */
function describeCost(energy: number, powerCost: number, powerDomain: Domain | null): string {
  const parts: string[] = [];
  if (energy > 0) parts.push(`[${energy}]`);
  if (powerCost > 0) parts.push(...Array.from({ length: powerCost }, () => `[${powerDomain ?? "rainbow"}]`));
  return parts.length > 0 ? parts.join(" ") : "free";
}

function empowerAbilities(): Record<string, ActivatedAbilityDefinition> {
  const out: Record<string, ActivatedAbilityDefinition> = {};
  for (const def of defaultCardRegistry().all()) {
    if (def.empowerCost === undefined) continue;
    if (def.type !== "Unit" && def.type !== "Gear" && def.type !== "Legend") continue;
    const { energy, powerCost, powerDomain, extra, energyDiscount, alternative } = def.empowerCost;
    const resourceCost = (e: number, p: number, domain: Domain | null): ActivationCost => ({
      ...(e > 0 ? { energy: e } : {}),
      ...(p > 0 ? { power: { domain, count: p } } : {}),
    });
    out[def.id] = {
      kind: def.type,
      // **An ALTERNATIVE cost becomes two MODES** — Legion Marauder's "[1] or
      // [Body]" (827.1.c.2, "Pay either cost"). `AbilityMode.cost` overrides the
      // ability's cost entirely, which is exactly the contract needed: each mode
      // names its whole price, and the player chooses which to pay when they
      // activate. Both resolve identically, because the card does one thing.
      //
      // Declared BESIDE `cost` rather than instead of it, which the interface
      // forbids for a modal ability — so `cost` below is left off entirely when
      // modes are present. `modesOf` turns the non-modal case into one unnamed
      // mode anyway, so everything downstream sees one shape.
      ...(alternative
        ? {
            modes: [
              {
                id: "printed",
                label: `Empower (${describeCost(energy, powerCost, powerDomain)})`,
                targeting: { kind: "none" } as const,
                cost: resourceCost(energy, powerCost, powerDomain),
                resolve: (state: GameState, _ctx: EffectContext, _event: ActivatedAbilityEvent, sourceInstanceId: string) =>
                  empowerPermanent(state, sourceInstanceId),
              },
              {
                id: "alternative",
                label: `Empower (${describeCost(alternative.energy, alternative.powerCost, alternative.powerDomain)})`,
                targeting: { kind: "none" } as const,
                cost: resourceCost(alternative.energy, alternative.powerCost, alternative.powerDomain),
                resolve: (state: GameState, _ctx: EffectContext, _event: ActivatedAbilityEvent, sourceInstanceId: string) =>
                  empowerPermanent(state, sourceInstanceId),
              },
            ],
          }
        : {}),
      // NO exhaust unless the card printed one: 827.1.c.1's expansion is
      // "[Cost]: Empower this", and an exhaust nobody printed would make every
      // Empower a once-per-turn ability. The cards that DO print `[Exhaust]` in
      // their Empower cost are the compound ones `parseEmpowerCost` refuses.
      ...(alternative ? {} : { cost: {
        ...(energy > 0 ? { energy } : {}),
        ...(powerCost > 0 ? { power: { domain: powerDomain, count: powerCost } } : {}),
        // The COMPOUND half (827.1.c.2). Spread rather than translated, because
        // `empowerCost.extra` is deliberately shaped as the `ActivationCost`
        // fields it becomes — every one of them already existed for other
        // abilities, so a compound Empower needed no new cost model at all.
        ...(extra ?? {}),
        // The SELF-MODIFYING half (827.1.c.3) — "This ability costs [N] less…".
        // Carried onto the cost rather than resolved here, because it reads the
        // BOARD: the price is whatever `activationCostFor` computes at the moment
        // it is asked, and baking a number in at load time would freeze it at the
        // rune count of an empty game.
        ...(energyDiscount ? { energyDiscount } : {}),
      } }),
      availableWhile: (state, _playerIndex, sourceInstanceId) => !isEmpowered(state, sourceInstanceId),
      resolve: (state, _ctx, _event, sourceInstanceId) => empowerPermanent(state, sourceInstanceId),
    };
  }
  return out;
}

const ACTIVATED_ABILITIES: Record<string, ActivatedAbilityDefinition> = {
  ...equipAbilities(),
  ...empowerAbilities(),
  /**
   * Jayce - Defender of Tomorrow's two READY abilities.
   *
   * **They live in THIS table rather than a domain file, and a gate is what said
   * so.** `effect-registry.test.ts` requires every defId registered in
   * `effects/<domain>.ts` to be a real card of that single domain — and these
   * keys are suffixed rather than card ids, while Jayce himself is dual-domain
   * (Mind/Body) and would belong in `signature.ts` regardless. A suffixed ability
   * key is an ENGINE concept, not a card entry, so it belongs beside Forge of the
   * Fluft's below.
   *
   * The suffixes are forced: he prints THREE activated abilities and this
   * registry is keyed by defId, so his own key is already taken by the generated
   * `[Empower]`. `abilitiesAvailableTo` already returns a LIST and already hands
   * a source a second entry under another key — Svellsongur's copied text and
   * Forge of the Fluft's grant are the precedents — so the offering needed no new
   * machinery. `mergeRegistries` would have caught a collision on his bare defId.
   *
   * **The Empowered one does not REPLACE the printed one.** 828 ADDS a dependent
   * ability. So an Empowered Jayce genuinely has both and both are offered; the
   * 2-gear version strictly dominates at the same cost, but offering only the
   * better one would be the engine choosing for the player.
   */
  [JAYCE_READY]: {
    // "[1], [Exhaust]: Ready a gear."
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    // `exhaustedOnly` keeps him off an ability with nothing to ready, which is
    // `legal-actions`' own "paying for nothing is never what the player meant".
    //
    // `owner: "friendly"` is a NARROWING and a recorded one: his text says "a
    // gear" with no owner, so an enemy gear is legal to name, and `readyPermanent`
    // only reaches the acting player's. Withholding an option is the safe
    // direction — readying an opponent's gear is never desirable — and it is in
    // docs/rules-conformance.md rather than silent.
    targeting: { kind: "gear", owner: "friendly", exhaustedOnly: true },
    resolve: (state, ctx, event) =>
      event.targetPermanentInstanceId === undefined
        ? state
        : readyPermanent(state, ctx.casterIndex, event.targetPermanentInstanceId),
  },
  [JAYCE_READY_EMPOWERED]: {
    // "[Empowered][>] [1], [Exhaust]: Ready 2 gear." Offered only while he holds
    // the status (828.1.c) — enforced by `abilitiesAvailableTo`, not here.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "gear", owner: "friendly", exhaustedOnly: true },
    resolve: (state, ctx, event) => {
      if (event.targetPermanentInstanceId === undefined) return state;
      const readied = readyPermanent(state, ctx.casterIndex, event.targetPermanentInstanceId);
      // **The SECOND gear is the first remaining exhausted one, and that is a
      // recorded simplification rather than the card.** "Ready 2 gear" is two
      // choices and this engine has no two-gear targeting shape — the same
      // "WHICH is a real choice with several available; the first is taken"
      // simplification Yone - Blademaster's entry records. With 0 or 1 other
      // exhausted gear, which is the common board, it is not a choice at all and
      // this is exact.
      const other = readied.players[ctx.casterIndex].activeGear.find(
        (g) => g.exhausted && g.instanceId !== event.targetPermanentInstanceId,
      );
      // 359.3.e.6 — an instruction that cannot be followed is ignored, so one
      // gear readied is a legal outcome rather than a failure.
      return other === undefined ? readied : readyPermanent(readied, ctx.casterIndex, other.instanceId);
    },
  },
  [DOMINUS_READY]: {
    // **The ability Dominus GIVES, not one any card prints.** VEN-142 reads
    // "This turn, double a unit's Might and give it '[rainbow][rainbow]: Ready
    // me.'" — so this is a definition with no printed owner, granted onto a unit
    // for the turn by `grantAbilityThisTurn` and swept by `runEnd`.
    //
    // **Here rather than in `effects/signature-fury.ts` beside the spell that
    // grants it**, and that is forced rather than chosen: `effect-registry.test`
    // requires every key in a per-domain file's `activatedAbilities` to be a REAL
    // CARD in the registry, and `VEN-142-ready` is not one. Jayce's two suffixed
    // keys directly above are here for the neighbouring reason.
    //
    // `kind: "Unit"` — the grant lands on a unit, which is the only thing
    // `grantAbilityThisTurn` can write to.
    //
    // **NO exhaust in the cost, and that is the printed card.** Omitting `cost`
    // entirely would default to `{ exhaust: true }`; this one prints two rainbow
    // pips and no exhaust symbol, so it may be used as many times as the Power
    // lasts. On a unit that is already ready that is paying for nothing — and it
    // is still OFFERED, deliberately. `legal-actions`' "paying for nothing is
    // never what the player meant" applies to a mode with no legal TARGET, which
    // 355.8 makes uncastable; this ability names no target at all, so there is no
    // rule to withhold it under and the project owner's standing ruling is to
    // never withhold a legal play.
    kind: "Unit",
    cost: { power: { domain: null, count: DOMINUS_READY_POWER } },
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => readyUnit(state, sourceInstanceId),
  },
  ...Object.fromEntries(SEALS.map(([defId, domain]) => [defId, sealAbility(domain)])),
  "SFD-189": {
    // Ornn - Fire Below the Mountain — "[Exhaust]: [Reaction] — [Add] [rainbow].
    // Use only to play gear or use gear abilities."
    //
    // A THIRD restricted pool, beside Kai'Sa's two. Rainbow like hers, so no
    // domain is matched; unlike hers it is spendable on GEAR — and since a Gear
    // is never a Spell, `restrictedPowerFor` picks between them rather than
    // `computeEffectiveCost` growing a fourth parameter.
    //
    // **DIVERGENCE, recorded in docs/rules-conformance.md: the "or use gear
    // ABILITIES" half does not reach an activation's Power cost.** An activated
    // ability's `power` cost is paid by `payPowerFromChanneled`, which RECYCLES a
    // matching rune out of the channeled pool and never reads a floating pool at
    // all — so no floating pool, restricted or otherwise, can pay one today. That
    // is structural and predates this card; the play half (23 of the 72 gear in
    // the pool carry a Power cost) works in full.
    //
    // `banksResource`, like the Seals and Malzahar: it changes nothing the board
    // evaluator can price, so the AI will not take it. Recorded rather than
    // worked around — this project has a standing rule against speculative
    // heuristics with no evaluative basis.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedGearPower: actor.restrictedGearPower + ORNN_GEAR_POWER };
      return { ...state, players };
    },
  },
  [GARDENS_OF_BECOMING]: {
    // Gardens of Becoming (UNL-213) — "Units here have '[Exhaust]: Gain 1 XP.'"
    //
    // The SECOND battlefield to grant an activated ability, and it differs from
    // Forge of the Fluft above in the one way that mattered: the Forge grants to
    // a player's LEGEND, which `abilitiesAvailableTo` can identify from a bare
    // defId, while this grants to whatever is STANDING HERE. Answering that needs
    // the source's `instanceId`, which the parameter did not carry — see the
    // widening on `abilitiesAvailableTo` and why every real caller already has it.
    //
    // **Both sides.** "Units here", no owner named, like every other unqualified
    // battlefield ability — so an enemy unit standing here can exhaust for XP
    // too, and `ctx.casterIndex` is whoever activated it rather than whoever
    // controls the battlefield.
    //
    // 414.5 decides whose exhaust pays: "the Exhaust symbol represents the cost
    // 'Exhaust this' or 'Exhaust me'", and the UNIT is who has the ability. So
    // the unit exhausts and the battlefield does not — the reading the Forge and
    // Heimerdinger both already record.
    kind: "Unit",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => gainXp(state, ctx.casterIndex, GARDENS_OF_BECOMING_XP),
  },
  [FORGE_OF_THE_FLUFT]: {
    // Forge of the Fluft (SFD-208) — "While you control this battlefield,
    // friendly legends have '[Exhaust]: Attach an Equipment you control to a
    // unit you control.'"
    //
    // **A BATTLEFIELD that grants an ACTIVATED ability**, which no table modelled
    // until Heimerdinger's borrow list turned out to be the door: the ability
    // lives here under the battlefield's own id, and `abilitiesAvailableTo`
    // offers it to the Legend of whoever controls the Forge. That is the same
    // shape Heimerdinger already has ("I have all [Exhaust] abilities of all
    // friendly legends, units, and gear"), so the enumerator, the validator and
    // the executor needed nothing new — all three resolve an activation through
    // `resolveActivation`, which was already a (source, abilityDefId) pair.
    //
    // 414.5 decides whose exhaust pays: "the Exhaust symbol represents the cost
    // 'Exhaust this' or 'Exhaust me'", and the LEGEND is who has the ability. So
    // the Legend exhausts and the battlefield does not — the same reading
    // Heimerdinger's own comment records.
    //
    // "An Equipment", with no detached/attached line, so `attachesEquipment:
    // "any"` — the union of Jax - Grandmaster At Arms's two modes rather than a
    // third kind of eligibility.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    attachesEquipment: "any",
    resolve: (state, ctx, event) =>
      event.targetPermanentInstanceId && event.targetUnitInstanceId
        ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
        : state,
  },
  "SFD-082": {
    // Ezreal - Dashing, his THIRD clause — ":rb_rune_mind:: [Action] — Move me to
    // your base."
    //
    // The other two are written elsewhere and this was the whole of his partial
    // note: the attack/defend damage trigger and "I don't deal combat damage".
    //
    // **No exhaust**, because none is printed — the same call `equipAbilities`
    // makes for an `[Equip]` cost, and it is the difference between a unit that
    // can bail out repeatedly while the Power lasts and one that can do it once.
    // A cost this engine adds is a cost the card does not have.
    //
    // "Move ME", so there is nothing to target: the source IS the subject, which
    // arrives as `resolve`'s 4th argument. `recallUnitToBase` rather than the
    // MoveUnit executor, exactly as Yasuo - Unforgiven's own move does — 414.3.a
    // puts the exhaust on the Standard Move ACTION, and this is not one.
    //
    // `[Action]` needs nothing: `validate-activate-ability` applies no timing
    // check to any activation, a standing permissiveness recorded in that file.
    kind: "Unit",
    cost: { power: { domain: "Mind", count: 1 } },
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => recallUnitToBase(state, sourceInstanceId),
  },
  "SFD-078": {
    // Temporal Portal — ":rb_rune_rainbow:, [Exhaust]: Give the next spell you
    // play this turn [Repeat] equal to its cost."
    //
    // The first card that GRANTS a keyword to a card not yet played, and the
    // grant is a count rather than a flag: 820.1.c.2 says "if a spell or ability has
    // more than one instance of Repeat, each Cost may be paid or not paid
    // individually", and 820.3 adds one execution per instance paid. So two
    // Portals arm two instances.
    //
    // The rainbow pip needed no new cost machinery — `payPowerFromChanneled` has
    // always read `null` as "any domain", which is what rainbow means (811 uses
    // the same pip for Hide). Only the cost TYPE had to widen.
    //
    // `banksResource`: the grant changes nothing `evaluate` can price — it is a
    // discount on a card not yet played — so the heuristic AI would score it a
    // tie with Pass. Flagged like the Seals and Kai'Sa rather than given a
    // speculative heuristic, which this project has a standing rule against.
    kind: "Gear",
    cost: { power: { domain: null, count: 1 }, exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextSpellRepeatGrants: actor.nextSpellRepeatGrants + 1 };
      return { ...state, players };
    },
  },
  "SFD-193": {
    // Jax - Grandmaster At Arms — "[1], [Exhaust]: Attach a detached Equipment
    // you control to a unit you control. [Exhaust]: Attach an attached Equipment
    // you control to a unit you control."
    //
    // **Two activated abilities on one card, priced differently** — the first
    // card in the pool to need that, and the reason `AbilityMode` grew a `cost`.
    // They are modes rather than two registry entries because the registry is
    // keyed by defId: a second entry would need a second key, and every lookup
    // (`abilitiesAvailableTo`, `resolveActivation`, `hasActivatableAbility`,
    // coverage) starts from the card's own id.
    //
    // Both exhaust, so only one is usable per turn regardless. What the price
    // separates is which JOB costs Energy: putting an idle Equipment onto a unit
    // costs [1]; picking one up off a unit and moving it is free. Collapsing them
    // into one mode would sell the priced job at the free price.
    //
    // `attachesEquipment` fans the enumeration out over unit x Equipment. The
    // unit is the TARGET (`targetUnitInstanceId`) because that is what makes it a
    // chosen unit for [Deflect] and for The Dreaming Tree; the Equipment rides
    // `targetPermanentInstanceId`.
    kind: "Legend",
    modes: [
      {
        id: "detached",
        label: "Attach a detached Equipment",
        cost: { energy: 1, exhaust: true },
        // "A unit you control" — no battlefield in the text, so `anywhere`,
        // which is the scope that also reaches BASE units (the default is
        // battlefields only and would have made a home Equipment unmovable).
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        attachesEquipment: "detached",
        resolve: (state, ctx, event) =>
          event.targetPermanentInstanceId && event.targetUnitInstanceId
            ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
            : state,
      },
      {
        id: "attached",
        label: "Move an attached Equipment",
        cost: { exhaust: true },
        // "A unit you control" — no battlefield in the text, so `anywhere`,
        // which is the scope that also reaches BASE units (the default is
        // battlefields only and would have made a home Equipment unmovable).
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        attachesEquipment: "attached",
        // The same helper for both: `attachEquipment` already moves an Equipment
        // that was attached elsewhere, which is the whole of this mode.
        resolve: (state, ctx, event) =>
          event.targetPermanentInstanceId && event.targetUnitInstanceId
            ? attachEquipment(state, ctx.casterIndex, event.targetPermanentInstanceId, event.targetUnitInstanceId)
            : state,
      },
    ],
  },
  "SFD-199": {
    // Ezreal - Prodigal Explorer — "[Exhaust]: [Reaction] — Draw 1. Use only if
    // you've chosen enemy units and/or gear twice this turn with spells or unit
    // abilities."
    //
    // **The condition is the card**, and it is a per-turn count of CHOICES rather
    // than of cards: one spell naming two enemy units satisfies him on its own.
    // That reading is 355's and is already this engine's — `holdUnitsChosen`
    // raises one event per chosen unit and its comment says why.
    //
    // "Use only if" is a restriction on ACTIVATING, so it is `availableWhile`
    // and not a guard inside the resolver: a resolver that refused would have
    // taken the exhaust already, and the player would have paid for nothing. Both
    // the enumerator and the validator reach it through `canPayActivationCost`.
    //
    // The counting lives at the two ANNOUNCE sites (`execute-play-card` and
    // `execute-activate-ability`) rather than here, because "with spells or unit
    // abilities" is a fact about the SOURCE and only those sites know it. See
    // `recordEnemyChoices` for the three narrowings.
    //
    // The `[Reaction]` tag needs nothing: `validate-activate-ability` applies no
    // turnState, chain or priority check to ANY activation — a standing
    // permissiveness recorded in that file's own doc comment, not something this
    // card introduces.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => state.players[playerIndex].enemyChoicesThisTurn >= EZREAL_CHOICES_NEEDED,
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "SFD-197": {
    // Azir - Emperor of the Sands, second half — "[1], [Exhaust]: Play a 2 Might
    // Sand Soldier unit token to your base. Use only if you've played an
    // Equipment this turn."
    //
    // His first half ("Your Sand Soldiers have [Weaponmaster]") is a keyword AURA
    // and lives in granted-keywords.ts, not here — a continuous grant is not a
    // triggered or activated ability, the same split Master Yi's `mightBonus`
    // makes.
    //
    // **"Use only if" is a restriction on ACTIVATING**, so it goes in
    // `availableWhile` rather than into the resolver: a resolver that refused
    // would already have taken the Energy and the exhaust, and the player would
    // have paid for nothing. Both the enumerator and the validator reach it
    // through `canPayActivationCost`, so the ability cannot be offered and then
    // refused.
    //
    // It reads `equipmentPlayedThisTurn`, NOT `gearPlayedThisTurn`: Equipment is
    // a strict subset of Gear, so a Scrapheap played this turn satisfies Ornn's
    // Forge and must not satisfy Azir.
    //
    // "TO YOUR BASE" is printed and is the whole placement rule — no destination
    // is chosen, unlike Recruit the Vanguard's.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => state.players[playerIndex].equipmentPlayedThisTurn > 0,
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", SAND_SOLDIER_TOKEN),
  },
  [GOLD_TOKEN_DEF_ID]: {
    // The Gold token (SFD, printed card `sfd-t03` "Gold // Buff") — "Kill this,
    // [Exhaust]: [Reaction] — [Add] :rb_rune_rainbow:."
    //
    // **Keyed by a token's runtime defId, which is a first for this table.** A
    // token has no `CardDefinition` — `shouldSkip` filters Token-supertype
    // entries out of the playable pool — so `loadTokenDefinitions()` exists to
    // make this id traceable back to a real printed card, exactly as
    // `loadBattlefieldDefinitions()` does for the 24 battlefield abilities.
    // Without that, `coverage-drift`'s "no module claims a card that isn't
    // real" check would be asked about an id nothing in the repo could confirm.
    //
    // BOTH halves of the cost are real and both are printed. `killSelf` is what
    // makes a Gold a one-shot: it is paid before the ability resolves, so the
    // token is already dead when anything responds. `exhaust` on top of it looks
    // redundant — a card you are killing hardly needs exhausting — but it is
    // what stops a Gold that entered READY being usable twice in one chain if a
    // future card ever readies one, and it is what the card prints.
    //
    // The Power is RAINBOW, so it lands in `floatingRainbowPower` rather than
    // `floatingPower` (which is keyed by Domain) — the same pool Malzahar's
    // ritual uses, and for the same reason.
    kind: "Gear",
    cost: { killSelf: true, exhaust: true },
    targeting: { kind: "none" },
    // Banks a resource and changes nothing the board evaluator can price, so the
    // AI will not take it — the same flag, and the same known consequence, as
    // the Seals and Malzahar. Recorded rather than worked around: this project
    // has a standing rule against speculative heuristics with no evaluative
    // basis, so a Gold token will sit unspent in self-play.
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      // Renata Glasc - Chem-Baroness's "your Gold [Add] an additional [1]" — an
      // ENERGY pip on top of the printed rainbow Power, not more Power. Read
      // HERE, as the ability resolves, rather than baked into the token when it
      // is minted: her clause is a running condition on the SCORE, so a Gold made
      // while behind still pays once its controller pulls ahead.
      const extraEnergy = goldAddsExtraEnergy(state, ctx.casterIndex) ? RENATA_GOLD_BONUS_ENERGY : 0;
      players[ctx.casterIndex] = {
        ...actor,
        floatingRainbowPower: actor.floatingRainbowPower + 1,
        floatingEnergy: actor.floatingEnergy + extraEnergy,
      };
      return { ...state, players };
    },
  },
  "OGN-113": {
    // Malzahar - Fanatic — "Kill a friendly unit or gear, Exhaust: [Action] ->
    // Add [rainbow][rainbow]."
    //
    // A ritual: a body for two Power of any colour. The Power is RAINBOW, so it
    // cannot land in `floatingPower` (keyed by Domain) and gets its own pool —
    // see PlayerState.floatingRainbowPower for why that is not Kai'Sa's.
    //
    // The kill is a COST, not an effect, and that is the whole card: it is paid
    // before the ability resolves, so a unit killed this way is already dead when
    // anything responds, and paying with the last friendly permanent is legal.
    kind: "Unit",
    cost: { killFriendlyPermanent: true, exhaust: true },
    targeting: { kind: "none" },
    // Banks a resource and changes nothing the board evaluator can price — the
    // same flag the Seals carry. (The kill DOES change the board, but it is the
    // price rather than the point.)
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingRainbowPower: actor.floatingRainbowPower + MALZAHAR_POWER };
      return { ...state, players };
    },
  },
  "OGN-023": {
    // Unlicensed Armory — "Discard 1, Exhaust: Choose a friendly unit. The next
    // time it would die this turn, you may pay [Fury] to heal it, exhaust it, and
    // recall it instead."
    //
    // Two prices at two different moments, and both are real: a card and an
    // exhaust NOW to arm the ward, 1 Fury Power LATER only if the unit actually
    // dies. Arming it costs the discard whether or not the unit ever dies, which
    // is what makes it a gamble rather than insurance.
    //
    // The ward itself lives in death-ward.ts beside Highlander's free one; only
    // the arming is here.
    kind: "Gear",
    cost: { discard: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : {
            ...state,
            // Not de-duplicated: arming the same unit twice with two Armories is
            // two wards, and the second survives the first death — "the NEXT
            // time" consumes one entry, and the rules never merge two
            // replacement effects into one.
            paidDeathWardUnitInstanceIds: [...state.paidDeathWardUnitInstanceIds, event.targetUnitInstanceId],
          },
  },
  "OGN-181": {
    // Pack of Wonders — "Exhaust: Return ANOTHER friendly gear, unit, or facedown
    // card to its owner's hand."
    //
    // Three narrowings on one spec, all printed and all separately load-bearing.
    // **ANOTHER**: it cannot bounce itself, which would otherwise be its best
    // line — exhaust, return the Pack, replay it. **FRIENDLY**: it is a rescue,
    // not removal; bouncing an enemy body would make a 2-Energy gear a repeatable
    // Gust. **OR FACEDOWN CARD**: a facedown card is neither a unit nor a gear,
    // so it needed its own opt-in rather than falling out of the existing walk.
    //
    // A facedown card's NAME is deliberately withheld from the candidate list —
    // `hiddenCards` holds the real card and nothing may leak it, the same rule
    // the board follows by rendering "Facedown".
    kind: "Gear",
    targeting: { kind: "unitOrGear", owner: "friendly", excludesSelf: true, includesFacedown: true },
    resolve: (state, _ctx, event) => (event.targetPermanentInstanceId ? returnPermanentToHand(state, event.targetPermanentInstanceId) : state),
  },
  "OGN-263": {
    // Teemo - Swift Scout (Legend) — "[1 Energy], Exhaust: Put a Teemo unit you
    // own into your hand from your Champion Zone or the trash."
    //
    // His other sentence — "you may pay [1 Energy] to hide a card instead of
    // [1 rainbow]" — is a COST alternative and lives with the hide pricing in
    // hidden.ts, the same split every card whose two clauses touch different
    // layers takes.
    //
    // "A TEEMO unit YOU OWN" is a name match, not a tag: the pool's Teemo units
    // are named "Teemo - …", the same prefix `isEligibleChampion` already uses to
    // decide which champion belongs to which legend. Reusing that idea rather than
    // adding a tag keeps one definition of what makes a card "a Teemo".
    //
    // **The Champion Zone FIRST, then the trash** — the zone holds at most one
    // card and it is the one a player is most likely to want back, and taking it
    // from there is what makes the Legend a repeatable engine rather than a
    // graveyard rummage. Recorded Unverified: the card offers a choice of zone and
    // this takes them in a fixed order.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => retrieveTeemo(state, ctx.casterIndex),
  },
  "OGN-078": {
    // Lee Sin - Ascetic — "Exhaust: Buff me. I can have any number of buffs."
    //
    // The second sentence is the card: rule 702.3.a makes a second buff on an
    // already-buffed unit a no-op, so without it this would be an exhaust for
    // nothing after the first use. `addBuff` names him in its own
    // `STACKING_BUFF_DEF_IDS` exception, and the stack lives in `extraBuffs`
    // rather than turning `buffed` into a number — which is what keeps every
    // other reader of that boolean (Sett - Kingpin's count, Lee Sin - Centered's
    // aura, Wildclaw Shaman's cost) correct and untouched.
    //
    // He readies at every Awaken, so this is +1 Might a turn, permanently. Each
    // buff is also a real Buff for every card that cares about one, and spending
    // one (702.2.b) takes an extra first and leaves him buffed.
    kind: "Unit",
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => addBuff(state, sourceInstanceId),
  },
  "UNL-026": {
    // Xerath - Freed — "[Fury], [Exhaust]: Deal 3 to a unit. Use this ability
    // only while I'm at a battlefield."
    //
    // Caitlyn - Patrolling below with two differences, both printed. The damage
    // is a FLAT 3 rather than "equal to my Might", so nothing is read at
    // resolution and no aura can change it. And the cost carries a Fury Power
    // pip on top of the exhaust — `payPowerFromChanneled` recycles a matching
    // rune, which is why the domain is named rather than left null.
    //
    // **"A unit", not "a unit at a battlefield"** — the distinction is
    // load-bearing here and the two cards differ on it. Caitlyn's text names a
    // battlefield and takes the default scope; Xerath's is a bare noun, so
    // 355.9.a.1 makes it the whole board and base units are legal targets. Written
    // out explicitly rather than defaulted, because the default is the other
    // answer.
    //
    // "Only while I'm at a battlefield" restricts ACTIVATING, so it is
    // `availableWhile` and not a check in the resolver — a resolver that refused
    // would have taken the exhaust and the rune for nothing.
    kind: "Unit",
    cost: { power: { domain: "Fury", count: 1 }, exhaust: true },
    targeting: { kind: "unit", scope: "anywhere" },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      findUnitOnBattlefield(state, sourceInstanceId)?.ownerIndex === playerIndex,
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      return dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, XERATH_DAMAGE);
    },
  },
  "UNL-093": {
    // Dragonsoul Sage — "[Reaction] → [Exhaust]: [Add] [1 Energy]."
    //
    // A rune-producer, so `banksResource` like the Seals, Malzahar and Ornn: it
    // adds a resource the board evaluator cannot price, so the AI will not take
    // it. Recorded rather than worked around, per this project's standing rule
    // against speculative heuristics with no evaluative basis.
    //
    // **The `[Reaction]` needs nothing here.** It is a TIMING permission on the
    // ability, and `card-loader` already sets `isReaction` from the printed
    // token; timing.ts enforces it. The reminder text "(Abilities that add
    // resources can't be reacted to.)" is likewise not this table's business —
    // it is a restriction on the OPPONENT responding, which this engine cannot
    // express at all because no activation opens a response window. That is the
    // standing chain divergence already recorded, not a new one for this card.
    //
    // Unrestricted `floatingEnergy`, unlike Ornn's `restrictedGearPower`: the
    // card prints no "use only to…" clause.
    kind: "Unit",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + DRAGONSOUL_SAGE_ENERGY };
      return { ...state, players };
    },
  },
  "OGN-068": {
    // Caitlyn - Patrolling — "Exhaust: Deal damage equal to my Might to a unit at
    // a battlefield. Use this ability only while I'm at a battlefield."
    //
    // Her other sentence — "I must be assigned combat damage last" — is Backline
    // printed as prose, and lives in `combat.assignmentOrder`'s third tier.
    //
    // **"Only while I'm at a battlefield"** is a restriction on ACTIVATING, so it
    // has to be asked where the ability is offered rather than inside the
    // resolver: a resolver that refused would have taken her exhaust for nothing.
    // `availableWhile` is that hook.
    //
    // "Damage equal to MY Might" is read at RESOLUTION, through `effectiveMight`
    // in her own location — so an aura or a this-turn pump makes the shot bigger,
    // the same reading Yasuo - Remorseful and Last Stand take.
    kind: "Unit",
    targeting: { kind: "unit" },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      findUnitOnBattlefield(state, sourceInstanceId)?.ownerIndex === playerIndex,
    resolve: (state, ctx, event, sourceInstanceId) => {
      if (!event.targetUnitInstanceId) return state;
      const self = findUnitOnBattlefield(state, sourceInstanceId);
      if (!self) return state;
      const might = effectiveMight(state, self.unit, ctx.casterIndex, {
        isCombat: false,
        battlefieldId: state.battlefields[self.battlefieldIndex]!.id,
      });
      return dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, might);
    },
  },
  "OGN-032": {
    // Ravenborn Tome — "Exhaust: The next spell you play this turn deals 1 Bonus
    // Damage."
    //
    // A CHARGE on the player, read by `modifiedDamageAmount` and cleared when a
    // Spell finishes resolving — which is where "the next spell" ends. Raging
    // Firebrand's discount takes the same shape one layer up, in the cost
    // pipeline; this one is on the damage side.
    //
    // "BONUS DAMAGE" is Annie - Fiery's wording, and it stacks with hers rather
    // than replacing it: two separate +1s, which is what two effects each saying
    // "1 Bonus Damage" means.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextSpellBonusDamage: actor.nextSpellBonusDamage + 1 };
      return { ...state, players };
    },
  },
  "OGN-098": {
    // Energy Conduit — "Exhaust: Add 1 Energy."
    //
    // The Seals' Energy counterpart, and unrestricted unlike Lux - Crownguard's
    // spells-only pool: it lands in `floatingEnergy`, which pays for anything.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + 1 };
      return { ...state, players };
    },
  },
  "OGN-017": {
    // Iron Ballista — "This enters exhausted. Exhaust: Deal 2 to a unit at a
    // battlefield."
    //
    // The enters-exhausted half is a play rule and lives in deploy.ts; it is the
    // card's whole cost, since without it a 3-Energy repeatable 2 damage would
    // fire the turn it lands.
    //
    // Default battlefield scope: "at a battlefield" is printed, so a unit in
    // base is out of range. Either player's is fair game — no owner is named.
    kind: "Gear",
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 2) : state,
  },
  "OGN-124": {
    // Arena Bar — "Exhaust: Buff an exhausted friendly unit."
    //
    // "EXHAUSTED" is a restriction on the target's state, which no spec could
    // express before — see TargetingSpec's `exhaustedOnly`. Filtered in
    // enumeration so a ready unit is never offered, rather than checked in this
    // resolver where the exhaust would already have been paid for nothing.
    //
    // addBuff, so 702.3.a applies: buffing an already-buffed unit spends the exhaust
    // and does nothing, which is the rule rather than a case to dodge.
    kind: "Gear",
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", exhaustedOnly: true },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state),
  },
  "OGN-184": {
    // The Syren — "1 Energy, Exhaust: Move a friendly unit at a battlefield to
    // its base."
    //
    // recallUnitToBase, which exhausts the moved unit — see its doc comment for
    // why that is an open question rather than a settled reading, filed as
    // Unverified for Flash and Maddened Marauder and inherited here rather than
    // decided differently for a third card.
    kind: "Gear",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state),
  },
  "OGN-099": {
    // Garbage Grabber — "Recycle 3 from your trash, 1 Energy, Exhaust: Draw 1."
    //
    // Three costs at once and every one of them already existed: the Recycle
    // (Vi - Destructive), the Energy (the preset Legends) and the exhaust. Rule
    // 416.3 makes the Recycle all-or-nothing, so a trash of two cards cannot pay
    // it and the ability is simply not offered.
    kind: "Gear",
    cost: { recycleFromTrash: 3, energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "SFD-050": {
    // Azir - Ascendant — "[Calm]: [Action] — Choose a unit you control. Move me
    // to its location and it to my original location. If it's equipped, you may
    // attach one of its Equipment to me. Use only once per turn."
    //
    // A SWAP, not two moves: `swapUnitLocations` places each where the other
    // was, reading BOTH originals before writing either — which is the whole
    // difference, since moving Azir first would leave the other unit heading for
    // a square he had already left. It also refuses a unit that is not the
    // caster's, which is "a unit YOU control".
    //
    // **"This isn't a move" is not printed here, and that matters**: unlike
    // Soraka's recall, Azir says "move me", so `movesThisTurn` and everything
    // keyed on it (Kayn - Unleashed) see it as one. `swapUnitLocations` is the
    // shared helper that already decides this for the pool's other swap.
    //
    // **"Use only ONCE PER TURN" with no exhaust**, which is why it is expressed
    // as a single-mode `modesOncePerTurn` rather than `{ exhaust: true }`: an
    // exhaust would also stop him being readied and used again, and would make
    // him unable to attack in the turn he swaps. The per-source record
    // (`abilityModesUsedThisTurn`) is cleared by `turn-manager`'s runEnd for
    // every unit, so nothing new needs resetting.
    //
    // **The Equipment half is written now**, and the partial note it carried is
    // deleted. That note said the clause needed "an attach axis on the
    // activation, not a resolver line", and it was right: "you may attach one of
    // its Equipment to me" is a second OPTIONAL choice, and this engine chooses
    // at announce time. `attachesFromTargetToSelf` is that axis.
    //
    // It is a NEW axis rather than a value of `attachesEquipment`, because the
    // direction is reversed: that field picks an Equipment to attach TO the
    // target, and this picks one already ON the target to move to the SOURCE.
    //
    // **Attached AFTER the swap**, deliberately. `attachEquipment` is positional
    // only through its wearer, so the order does not change where the gear ends
    // up — but it does decide what an `equipmentAttached` listener sees, and a
    // listener reading the board mid-swap would find Azir at neither location.
    kind: "Unit",
    modesOncePerTurn: true,
    modes: [
      {
        id: "swap",
        label: "Swap places with a unit you control",
        cost: { power: { domain: "Calm", count: 1 } },
        // "A unit you control", no battlefield named — so `anywhere`, the scope
        // that also reaches BASE. Swapping with a unit at home is exactly how he
        // teleports out of a losing fight.
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        attachesFromTargetToSelf: true,
        resolve: (state, ctx, event, sourceInstanceId) => {
          if (event.targetUnitInstanceId === undefined) return state;
          const swapped = swapUnitLocations(state, ctx.casterIndex, sourceInstanceId, event.targetUnitInstanceId);
          // Absent means the player declined — "you MAY" — so the swap stands
          // alone. 055's do-as-much-as-you-can, not a guard.
          if (event.targetPermanentInstanceId === undefined) return swapped;
          return attachEquipment(swapped, ctx.casterIndex, event.targetPermanentInstanceId, sourceInstanceId);
        },
      },
    ],
  },
  "SFD-088": {
    // Renata Glasc - Mastermind — "[1][Mind]: Draw 1. [4][Mind][Mind][Mind]
    // [Mind], [Exhaust]: Score 1 point. Use my abilities only while I'm at a
    // battlefield."
    //
    // **The pool's first activated ability that SCORES.** Points are otherwise
    // paid only by holding and conquering, and routing this through the same
    // `gainPoints` is what makes it obey everything they obey — Tianna
    // Crownguard's block, the win check at 474, and Draven - Showboat's Might
    // reading the score. A bespoke increment would have skipped all three.
    //
    // TWO modes with DIFFERENT costs, which is exactly what per-mode `cost` is
    // for: the draw is cheap and REPEATABLE (no exhaust, so it runs while the
    // Energy lasts), and the score costs four Energy, four Mind Power AND the
    // exhaust. Putting the exhaust on the ability instead would have made the
    // draw once a turn, which the card does not say.
    //
    // "Use my abilities only while I'm AT A BATTLEFIELD" is a restriction on
    // ACTIVATING, so it is `availableWhile` rather than a check in either
    // resolver — the same placement Ezreal - Prodigal Explorer's "use only if"
    // takes, and for the reason recorded there: a resolver that refused would
    // have taken the cost first.
    kind: "Unit",
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      state.battlefields.some((bf) =>
        (bf.units[state.players[playerIndex].id] ?? []).some((u) => u.instanceId === sourceInstanceId),
      ),
    modes: [
      {
        id: "draw",
        label: "Draw 1",
        // No exhaust: the card prints none on this half, so it repeats while the
        // Energy lasts — the same reading Vi - Destructive's Recycle takes.
        cost: { energy: 1, power: { domain: "Mind", count: 1 } },
        targeting: { kind: "none" },
        resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
      },
      {
        id: "score",
        label: "Score 1 point",
        cost: { energy: 4, power: { domain: "Mind", count: 4 }, exhaust: true },
        targeting: { kind: "none" },
        resolve: (state, ctx) => gainPoints(state, ctx.casterIndex, 1),
      },
    ],
  },
  "SFD-083": {
    // Hextech Anomaly — "[Exhaust]: [Reaction] — Pay any amount of [rainbow] to
    // [Add] that much Energy."
    //
    // The pool's first X cost on an ABILITY; `hasXRainbowCost` already gives
    // Bullet Time, a Spell, the same shape. X rides the action and the
    // enumerator fans out one variant per affordable amount.
    //
    // The Energy is UNRESTRICTED — it lands in `floatingEnergy`, which pays for
    // anything, unlike Lux's spells-only pool. The card names no restriction.
    //
    // Banks a resource and changes nothing the board evaluator can price, so the
    // AI will not take it — the same flag, and the same known consequence, as
    // the Seals, Malzahar and the Gold token. Recorded rather than worked
    // around: this project has a standing rule against speculative heuristics
    // with no evaluative basis.
    kind: "Gear",
    cost: { exhaust: true, xRainbowPower: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx, event) => {
      const x = event.xAmount ?? 0;
      if (x <= 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + x };
      return { ...state, players };
    },
  },
  "SFD-117": {
    // Ancient Henge — "[Exhaust]: [Reaction] — Pay any amount of Energy to
    // [Add] that much [rainbow]."
    //
    // Hextech Anomaly inverted, and the inversion is exactly why the two X costs
    // are separate fields: paid in Energy, produces RAINBOW Power. One field
    // would let this be paid with the very resource it makes.
    //
    // The Power is RAINBOW, so it lands in `floatingRainbowPower` rather than a
    // domain pool — the same bucket Malzahar's ritual uses, and for the same
    // reason.
    //
    // `banksResource` for the same reason as its sibling above.
    kind: "Gear",
    cost: { exhaust: true, xEnergy: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx, event) => {
      const x = event.xAmount ?? 0;
      if (x <= 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, floatingRainbowPower: actor.floatingRainbowPower + x };
      return { ...state, players };
    },
  },
  "SFD-019": {
    // Assembly Rig — "[1][Fury], Recycle a unit from your trash, [Exhaust]:
    // Play a 3 [Might] Mech unit token to your base."
    //
    // **The pool's first FILTERED recycle cost.** `recycleFromTrash` takes a
    // count and would happily be paid with three Spells; this one may only be
    // paid with units, which changes when the ability is OFFERED and not just
    // what it costs — see `recycleUnitFromTrash`.
    //
    // Four cost halves, all printed: an Energy, a Fury rune, the unit recycle,
    // and the exhaust. The exhaust is what makes it once a turn.
    //
    // `MECH_TOKEN` is shared from token.ts, so the Rig, Production Surge and
    // Rumble - Scrapper cannot disagree about what a Mech token is — and it
    // carries the Mech tag, so Rumble's aura pumps whatever this makes.
    kind: "Gear",
    cost: { energy: 1, power: { domain: "Fury", count: 1 }, recycleUnitFromTrash: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", MECH_TOKEN),
  },
  "SFD-046": {
    // Poro Snax's SECOND half — "[1][Calm], Exhaust, Kill this: Draw 1."
    //
    // Its first ("when you play this, draw 1") is a Gear self-trigger and lives
    // in effects/calm.ts. Both halves landed together; either alone would have
    // reported the card finished, since coverage is per defId.
    //
    // **THREE costs, and all three are printed.** `:rb_energy_1:` is an Energy
    // and `:rb_rune_calm:` is a Calm Power — one pip each, the same pair
    // `[Accelerate]` prices as `ACCELERATE_ENERGY` + `ACCELERATE_POWER`, not a
    // single Energy that a Calm rune happens to pay. `exhaust` on top of
    // `killSelf` looks redundant on a card being destroyed and is kept for the
    // reason the Gold token's identical pair is: it is what the card prints, and
    // it is what stops a Snax that entered ready being used twice in one chain
    // if anything ever readies one.
    //
    // So the card is two draws for a total of [1][1][Calm] spread over two
    // moments — which is the whole card, and why the second draw is worth a
    // rune.
    kind: "Gear",
    cost: { energy: 1, power: { domain: "Calm", count: 1 }, killSelf: true, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "OGN-186": {
    // Treasure Trove — "When this leaves the board, draw 1 and channel 1 rune
    // exhausted. [Chaos], Exhaust: Kill this."
    //
    // The ability's whole function is to pay its own leave-the-board trigger,
    // which is why the effect here is empty: `killSelf` in the COST does the
    // work, and killGear fires the self-trigger that draws and channels. Putting
    // the draw in this resolver instead would double it the day the Trove leaves
    // the board some other way.
    kind: "Gear",
    cost: { power: { domain: "Chaos", count: 1 }, killSelf: true, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state) => state,
  },
  [RENEKTON_BUTCHER]: {
    // Renekton - Butcher of the Sands (VEN-141) — "[Reaction][>]
    // [rainbow][rainbow], [Exhaust]: [Add] [2 Energy]. Spend this Energy only to
    // play units or activated abilities of units."
    //
    // A FOURTH restricted pool, beside Lux-Crownguard's Spells-only Energy,
    // Kai'Sa's Spells-only rainbow, and Ornn's gear-only rainbow. Each names a
    // different half of the game and no two can apply to one payment, which is
    // why they are four fields rather than one tagged pool.
    //
    // **`[Reaction][>]` needs nothing.** `validate-activate-ability` applies no
    // timing check to any activation — a standing permissiveness that file
    // records — so every ability in the pool is already reaction-speed. That is
    // wider than the rules for the OTHER abilities and exactly right for this one.
    //
    // **The "or activated abilities of units" half is NOT implemented**, and is
    // recorded in docs/rules-conformance.md: activation costs are paid by
    // `activationPayment`, which knows nothing of the restricted pools, and
    // teaching it would change how every ability in the game is paid to serve one
    // clause. The PLAY half is what the card is bought for.
    //
    // `banksResource`, like Lux-Crownguard's: the board evaluator cannot price a
    // pool that pays for something later.
    kind: "Legend",
    cost: { power: { domain: null, count: RENEKTON_POWER }, exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedUnitEnergy: actor.restrictedUnitEnergy + RENEKTON_ENERGY };
      return { ...state, players };
    },
  },
  [ZED_MASTER_OF_SHADOWS]: {
    // Zed - Master of Shadows (VEN-143) — "[Action][>] Disempower me, [Exhaust]:
    // Discard 1, then draw 1."
    //
    // His first sentence ("when you banish a card you own, empower me") is a hook
    // inside `banishCard`, the single writer of the banished zone; coverage merges
    // the two claims.
    //
    // "Discard 1, THEN draw 1" is sequential, and the order is the card: a
    // rummage that drew first could put the drawn card back, which is a different
    // and better effect. `discardCards` parks a question when there is a real
    // choice, and `decisions.draw` is queued behind it — the ordering mechanism
    // Undercover Agent's entry describes, and the one Clairvoyance's draw had to
    // be moved into.
    kind: "Legend",
    cost: { disempowerSelf: true, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const discarded = discardCards(state, ctx.casterIndex, 1);
      return parkDecision(discarded, { kind: "draw", playerIndex: ctx.casterIndex, count: 1 });
    },
  },
  [KENNEN_HEART_OF_THE_TEMPEST]: {
    // Yordle, Kennen - Heart of the Tempest (VEN-155) — "[Action][>] Disempower
    // me, [Exhaust]: Give a unit [Assault 2] this turn."
    //
    // His first sentence ("when you play a card from anywhere other than your
    // hand, empower me") is an event trigger in `legend-abilities.ts`, reading the
    // `fromElsewhere` flag `execute-play-card` now carries.
    //
    // "A unit", bare, so either side's and anywhere (355.9.a.1) — giving an enemy
    // `[Assault]` is a bad play rather than an illegal one, and the card offers
    // it. Unlike Ambessa's ready, which is narrowed because the helper cannot
    // reach the other side, nothing stops this one being exactly as printed.
    kind: "Legend",
    cost: { disempowerSelf: true, exhaust: true },
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : grantKeywordThisTurn(state, event.targetUnitInstanceId, "Assault", KENNEN_ASSAULT),
  },
  [SHEN_EYE_OF_TWILIGHT]: {
    // Shen - Eye of Twilight (VEN-147) — "[Action][>] [Exhaust]: Give a friendly
    // unit [Tank] this turn."
    //
    // The simplest of Vendetta's seven Legends and the only one with no trigger
    // at all: one ability, one exhaust, one grant. `[Tank]` is a printed keyword
    // the combat code already reads ("it must be assigned combat damage first"),
    // so this grants it and nothing else is owed.
    //
    // "A FRIENDLY unit" is printed, unlike Jayce's "a gear" — so the narrowing
    // here is the card's rather than a recorded simplification.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : grantKeywordThisTurn(state, event.targetUnitInstanceId, "Tank", 1),
  },
  [MEL_SOULS_REFLECTION]: {
    // Mel - Soul's Reflection (VEN-151) — "Disempower me, [Exhaust]: Give a unit
    // AT A BATTLEFIELD -2 [Might] this turn."
    //
    // Her first sentence ("when you empower something else, empower me") is a
    // hook inside `empowerPermanent`, the single writer of the status; coverage
    // merges the two claims.
    //
    // **"Disempower me" is a COST, not an `[Empowered][>]` gate**, and the
    // difference is the card: a gate can be used every turn the status is held,
    // while this SPENDS it — so she has to be re-empowered before she works
    // again, which is what her first sentence is for. `disempowerSelf` is that
    // cost, and 416.3 keeps her off the list entirely while she is not Empowered.
    //
    // "A unit AT A BATTLEFIELD" — the location is printed, so `scope:
    // "battlefield"` (355.9.b's narrowing), and no owner word, so either side's.
    kind: "Legend",
    cost: { disempowerSelf: true, exhaust: true },
    targeting: { kind: "unit", scope: "battlefield" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : giveMightThisTurn(state, event.targetUnitInstanceId, -MEL_SHRINK),
  },
  [AMBESSA_MATRIARCH]: {
    // Ambessa - Matriarch of War (VEN-153) — "Disempower me, [rainbow],
    // [Exhaust]: Ready a unit."
    //
    // Mel's shape with a rainbow pip on top, and the same first sentence — so the
    // two arrive together and share the `empowerPermanent` hook.
    //
    // **No `owner`, because her text names none** — "Ready a unit" is any unit,
    // and an enemy one is legal to choose.
    //
    // It was `owner: "friendly"` until 2026-08-22 and recorded as narrower than
    // printed, on the reasoning that `readyPermanent` only reached the acting
    // player's units and that withholding an option nobody would take is the safe
    // direction. The first half was a fact about the helper rather than about the
    // card, and it is fixed there — `readyUnit` always handled any owner
    // correctly, including the Mageseeker Warden's lock. The second half is the
    // argument this project does not accept: a legal play is offered even when it
    // looks pointless, and "never desirable" is not always true anyway — readying
    // an enemy unit can bait it out of a Showdown, and Maduli-style lock cards
    // make it situational.
    kind: "Legend",
    cost: { disempowerSelf: true, power: { domain: null, count: 1 }, exhaust: true },
    targeting: { kind: "unit", scope: "anywhere", exhaustedOnly: true },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId === undefined
        ? state
        : readyPermanent(state, ctx.casterIndex, event.targetUnitInstanceId),
  },
  [LUX_CROWNGUARD]: {
    kind: "Unit",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedSpellEnergy: actor.restrictedSpellEnergy + 2 };
      return { ...state, players };
    },
  },
  [VI_DESTRUCTIVE]: {
    kind: "Unit",
    // "Recycle 1 from your trash: Give me +1 Might this turn." No exhaust symbol,
    // so `cost` names only the recycle — she can do this repeatedly as long as
    // the trash holds cards, which is the card's whole texture. Defaulting to an
    // exhaust here would have capped her at once per turn.
    cost: { recycleFromTrash: 1 },
    // "Give ME" — no target to choose.
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(state, ctx.casterIndex, sourceInstanceId, 1),
  },
  [VIKTOR_HERALD]: {
    // Viktor - Herald of the Arcane — "1 Energy, exhaust: Play a 1-Might Recruit
    // unit token."
    //
    // The first LEGEND ability in this registry. Nothing about the Legend zone
    // needed inventing for it: Awaken already readies the legend
    // (turn-manager's `legend: { ...p.legend, exhausted: false }`), so the
    // ready/exhaust cycle that makes a once-per-turn ability once-per-turn was
    // there all along and simply had nothing using it.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeRecruitToken(state, ctx.casterIndex, "base"),
  },
  [LEE_SIN_BLIND_MONK]: {
    // Lee Sin - Blind Monk — "1 Energy, exhaust: Buff a friendly unit."
    //
    // Routed through addBuff, which is where 702.3.a's "not placed instead" lives —
    // so buffing an already-buffed unit spends the Energy and the exhaust for
    // nothing, which is what the rules say and not a case to special-case away.
    // It also means this and Mistfall compose with no knowledge of each other:
    // addBuff fires `unitBuffed`, so buffing with the Legend can offer the gear
    // its ready-it trigger.
    kind: "Legend",
    cost: { energy: 1, exhaust: true },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state),
  },
  [UDYR_WILDMAN]: {
    // Udyr - Wildman — "Spend my buff: Choose one you've not chosen this turn —
    // Deal 2 to a unit at a battlefield / Stun a unit at a battlefield / Ready me
    // / Give me [Ganking] this turn."
    //
    // No exhaust anywhere in that cost line, so like Vi - Destructive he can go
    // again — as often as buffs keep arriving, and up to four times a turn since
    // each mode is spent separately. Assuming the exhaust would have capped him
    // at once and quietly made the four-mode design pointless.
    kind: "Unit",
    cost: { spendBuff: true },
    modesOncePerTurn: true,
    modes: [
      {
        id: "damage",
        label: "Deal 2 to a unit at a battlefield",
        targeting: { kind: "unit" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 2) : state,
      },
      {
        id: "stun",
        label: "Stun a unit at a battlefield",
        targeting: { kind: "unit" },
        // stunUnits, not stunUnit: this is a real stun by a real player, so it
        // has to be visible to Eclipse Herald and Leona - Radiant Dawn. Reading
        // the primitive here instead would be the dispatch-hop bug this codebase
        // has already shipped three times — the ability would still stun, and
        // the watchers would silently never fire.
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
      },
      {
        id: "ready",
        label: "Ready me",
        targeting: { kind: "none" },
        resolve: (state, _ctx, _event, sourceInstanceId) => readyUnit(state, sourceInstanceId),
      },
      {
        id: "ganking",
        label: "Give me [Ganking] this turn",
        targeting: { kind: "none" },
        resolve: (state, _ctx, _event, sourceInstanceId) => grantKeywordThisTurn(state, sourceInstanceId, "Ganking"),
      },
    ],
  },
  [MISS_FORTUNE_BOUNTY_HUNTER]: {
    // Miss Fortune - Bounty Hunter — "Exhaust: Give a unit [Ganking] this turn."
    //
    // "A unit" with no owner and no battlefield named, so scope: "anywhere" and
    // either player's units are legal targets — the same reading Orb of Regret
    // below already has. Granting [Ganking] to an ENEMY unit is a bad play
    // rather than an illegal one, so `owner` stays unset.
    //
    // keywordsThisTurn, via grantKeywordThisTurn, so it expires at runEnd with
    // the rest of the turn rather than being written into the printed set —
    // exactly what Udyr's own [Ganking] mode needed.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Ganking") : state,
  },
  [DARIUS_HAND_OF_NOXUS]: {
    // Darius - Hand of Noxus — "Exhaust: [Reaction], [Legion] — Add 1 Energy."
    //
    // [Legion] is "get the effect if you've played a card this turn", and the
    // state for it already exists: `cardsPlayedThisTurn`, which execute-play-card
    // increments and runEnd resets. Nothing new is needed for the keyword here —
    // it is a condition on the effect, not a cost, so an unmet [Legion] still
    // spends the exhaust and yields nothing. That is what the keyword says.
    //
    // The Energy is UNRESTRICTED (unlike Lux - Crownguard's spells-only pool), so
    // it lands in `floatingEnergy` — the fungible pool every cost drains first.
    //
    // [Reaction] needs nothing here: activateAbilityCandidates is already offered
    // in every timing branch (legal-actions.ts), which is more permissive than
    // this keyword requires rather than less.
    //
    // banksResource, like Lux - Crownguard: the AI's evaluate() scores board
    // state, so an ability that only stores Energy would tie with Pass and be
    // chosen on a coin flip.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      if (actor.cardsPlayedThisTurn < 1) return state; // [Legion] unmet
      players[ctx.casterIndex] = { ...actor, floatingEnergy: actor.floatingEnergy + 1 };
      return { ...state, players };
    },
  },
  [KAISA_DAUGHTER_OF_THE_VOID]: {
    // Kai'Sa - Daughter of the Void — "Exhaust: [Reaction] — Add 1 rainbow Power.
    // Use only to play spells."
    //
    // POWER, not Energy, and that is the difference from Lux - Crownguard: it
    // pays a card's Power pip. "Rainbow" means any domain (rule 811 uses the
    // same pip for Hide), so it cannot live in `floatingPower`, which is keyed by
    // Domain — a rainbow entry there would need a seventh fake domain that every
    // consumer would then have to know to ignore.
    //
    // So it gets its own scalar, `restrictedSpellPower`, drained after
    // floatingPower and only for Spells — a direct mirror of the
    // restrictedSpellEnergy pool that already exists for exactly this shape of
    // ability. See rune-payment.ts's computeEffectiveCost.
    kind: "Legend",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedSpellPower: actor.restrictedSpellPower + 1 };
      return { ...state, players };
    },
  },
  [YASUO_UNFORGIVEN]: {
    // Yasuo - Unforgiven — "2 Energy, exhaust: Move a friendly unit to or from
    // its base."
    //
    // TWO modes rather than one compound target, and the reason is that "to or
    // from" is genuinely two different moves with two different target shapes:
    // going home names only a unit, while leaving home also names a destination.
    // A single spec would have needed a unit-plus-battlefield pair that no other
    // card in this pool wants.
    //
    // `modesOncePerTurn` is deliberately NOT set. Udyr needs it because his cost
    // has no exhaust and he can go four times; Yasuo's exhaust already caps him
    // at once, so tracking spent modes would be bookkeeping with nothing to stop.
    //
    // Both moves are `forceMoveToBattlefield`/`recallUnitToBase`, not the
    // MoveUnit executor — 414.3.a puts the exhaust on the Standard Move ACTION,
    // so a unit Yasuo moves does not pay it again.
    kind: "Legend",
    cost: { energy: 2, exhaust: true },
    modes: [
      {
        id: "toBase",
        label: "Move a friendly unit to its base",
        // "To its base" — so the unit must be AT a battlefield to have somewhere
        // to come back from. The default battlefield scope says exactly that.
        targeting: { kind: "unit", owner: "friendly" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
      },
      {
        id: "fromBase",
        label: "Move a friendly unit from its base",
        // The destination rides on the action's own battlefield field, fanned
        // out per battlefield by legal-actions — the same field Charm already
        // uses to say where a moved unit lands.
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        movesTarget: true,
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId && event.destinationBattlefieldId
            ? forceMoveToBattlefield(state, event.targetUnitInstanceId, event.destinationBattlefieldId)
            : state,
      },
    ],
  },
  [FORGE_OF_THE_FUTURE]: {
    // Forge of the Future — "Kill this: Recycle up to 4 cards from trashes."
    // (Its "when you play this, play a Recruit token" half is a self-trigger in
    // effects/order.ts.)
    //
    // "From TRASHES", plural — either player's, which is what makes it a
    // graveyard-hate card rather than a self-recursion one. Taken from the
    // opponent's first, since that is the only reason to cast it at an opponent
    // and the caster's own trash is theirs to keep otherwise.
    //
    // "UP TO 4", so a short trash recycles what is there (055).
    kind: "Gear",
    cost: { killSelf: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const opponentIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      let next = state;
      let remaining = 4;
      for (const index of [opponentIndex, ctx.casterIndex] as const) {
        if (remaining <= 0) break;
        const owner = next.players[index];
        const taken = owner.trash.slice(0, remaining);
        if (taken.length === 0) continue;
        remaining -= taken.length;
        const players = [...next.players] as [PlayerState, PlayerState];
        players[index] = { ...owner, trash: owner.trash.slice(taken.length), deck: [...owner.deck, ...taken] };
        next = { ...next, players };
      }
      return next;
    },
  },
  [SUN_DISC]: {
    // Sun Disc — "Exhaust: [Legion] — The next unit you play this turn enters
    // ready."
    //
    // A CHARGE on the player (`nextUnitsEnterReady`), not Confront's blanket
    // this-turn flag: this readies exactly one unit and is then spent, which is
    // why deploy.ts consumes it rather than just reading it.
    //
    // [Legion] is checked with `countingSelf: false` — activating an ability is
    // not playing a card and increments nothing, so "another card this turn" is
    // any one card, the same reading Darius - Hand of Noxus takes.
    //
    // An unmet [Legion] still spends the exhaust and arms nothing: the keyword
    // gates the EFFECT, not the cost.
    //
    // banksResource: the AI's evaluate() scores board state, and an armed charge
    // changes nothing it can see until a unit is played into it.
    kind: "Gear",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      if (!legionActive(state, ctx.casterIndex, false)) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, nextUnitsEnterReady: actor.nextUnitsEnterReady + 1 };
      return { ...state, players };
    },
  },
  "OGN-164": {
    // Sett - Brawler — "Spend my buff: Give me +4 Might this turn." (His two
    // buff-me clauses are in effects/body.ts.)
    //
    // No exhaust anywhere in the cost line, exactly like Udyr and Vi, so he can
    // do this as often as buffs keep arriving — and his own text is what keeps
    // supplying them. Assuming an exhaust would have capped the engine of the
    // card at once per turn.
    kind: "Unit",
    cost: { spendBuff: true },
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(state, ctx.casterIndex, sourceInstanceId, 4),
  },
  [BAITED_HOOK]: {
    kind: "Gear",
    // Energy AND Power, which nothing else here has. `activationPayment` applies
    // the Power step first and prices the Energy against what it leaves, so the
    // two halves cannot double-spend a rune — and, per 164.2's two rune
    // abilities, a single Ready Order rune legitimately covers both.
    cost: { energy: 1, power: { domain: "Order", count: 1 }, exhaust: true },
    // "Kill a FRIENDLY unit" — an announce-time target, so it is chosen before
    // the ability resolves and `legal-actions` fans one candidate out per unit.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event, sourceInstanceId) => {
      const victimId = event.targetUnitInstanceId;
      if (!victimId) return state;
      const victim = findUnitAnywhere(state, victimId);
      // **359.3.e.14, and the PDF works THIS card as its example:** if the chosen
      // unit is no longer a legal target, "it can't be killed and its Might is
      // treated as null. Baited Hook's controller looks at the top 5 cards of
      // their Main Deck, but can't choose any unit from among them." The look and
      // the recycle are separate instructions and still execute — only the
      // banish-and-play is linked to the kill and is therefore ignored.
      //
      // Unreachable today and written anyway: this engine opens no response
      // window between submitting an ActivateAbility and resolving it, so nothing
      // can remove the victim in between. Reported as unexercised, not working.
      // Read BEFORE the kill, off the victim's own location — `findUnitAnywhere`
      // reports a zone (`"base"` or a battlefield INDEX), not an id.
      const victimBattlefieldId =
        victim && typeof victim.zone === "object" ? state.battlefields[victim.zone.battlefieldIndex]?.id : undefined;
      const cap = victim
        ? effectiveMight(state, victim.unit, victim.ownerIndex, { isCombat: false }) + 1
        : null;
      const killed = victim ? destroyUnit(state, victimId, ctx.casterIndex) : state;
      // "Look at the top 5" is a look, so Nocturne sees it — offered before the
      // Hook's own question for the FIFO reason Reinforce's resolve records.
      const looked = offerTopOfDeckBanish(killed, ctx.casterIndex, killed.players[ctx.casterIndex].deck.slice(0, 5));
      return parkDecision(looked, {
        kind: "OGN-242-banish",
        playerIndex: ctx.casterIndex,
        cardInstanceId: sourceInstanceId,
        // The Might cap rides on the decision rather than being re-derived: the
        // victim is in a trash by the time this is answered, and `null` is the
        // 359.3.e.14 case, which must stay distinguishable from a cap of 0.
        ...(cap !== null ? { count: cap } : {}),
        // WHERE the bait stood, for the same reason and a stronger one: the free
        // play this leads to may land there even though the kill just emptied it
        // (359.3's linked instructions — see free-play.ts's destinationsFor).
        // Nothing can recompute it later. The unit is in a trash by then, and the
        // Cleanup between this submit and the answer has already lapsed control of
        // a battlefield the player no longer occupies.
        ...(victimBattlefieldId !== undefined ? { battlefieldId: victimBattlefieldId } : {}),
      });
    },
  },
  "SFD-052": {
    // Heart of Dark Ice — "[Exhaust]: Give a unit +3 Might this turn."
    //
    // Orb of Regret's mirror, one entry down, and deliberately written the same
    // way: "a unit" names no owner and no battlefield, so either player's base
    // is a legal target — the reading base-targeting.test.ts already pins.
    //
    // **No floor**, unlike the Orb's. That is the card rather than an omission:
    // a floor exists to stop a REDUCTION digging below 1, and nothing needs
    // capping on the way up.
    kind: "Gear",
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, HEART_OF_DARK_ICE_MIGHT) : state,
  },
  "SFD-090": {
    // The Zero Drive — "[3][Mind], Banish this: Play all units banished with
    // this, ignoring their costs. (Use only if unattached.)"
    //
    // # Where the units come from
    //
    // From `GearInstance.banishedInstanceIds`, filled by this card's OTHER half —
    // the art-only `[Deathknell] — Banish me` it grants its wearer, registered as
    // a death-watch in triggers.ts. Without that half this ability is a sentence
    // about an empty set, which is exactly what the card's old partial note meant
    // by "needs banish-with-source tracking".
    //
    // # Why the Drive is read out of the BANISHED zone
    //
    // "Banish this" is the COST, and a cost is paid before the effect resolves —
    // so by the time this runs the Drive is in `PlayerState.banished`, carrying
    // its list with it. That is not incidental: `banishCard` moves the INSTANCE
    // rather than re-creating it, precisely so the list survives the payment.
    //
    // # "(Use only if unattached.)"
    //
    // `availableWhile`, not a guard in here. A resolver that refused would have
    // taken the 3 Energy and the Mind Power and banished the Drive first — the
    // reason `availableWhile` exists at all. Both the enumerator and the
    // validator ask it through `canPayActivationCost`, so an attached Drive is
    // never offered rather than offered and refused.
    //
    // # "Ignoring their costs"
    //
    // `playCardIgnoringCost`, the pool's standard route for a free play, and they
    // land in BASE: the card names no location, and 419.3.a's default for a unit
    // played with no destination stated is its controller's base.
    //
    // **They are played by the DRIVE's controller.** Reachable only where the two
    // agree today — `attachEquipment` refuses to attach across controllers, so a
    // Drive only ever watches its own side's units die — and it is written from
    // the Drive's seat rather than each unit's because that is whose ability this
    // is.
    kind: "Gear",
    cost: { energy: 3, power: { domain: "Mind", count: 1 }, banishSelf: true },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      state.players[playerIndex].activeGear.some(
        (g) => g.instanceId === sourceInstanceId && g.attachedToInstanceId === null,
      ),
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) => {
      const drive = state.players[ctx.casterIndex].banished.find((c) => c.instanceId === sourceInstanceId);
      if (!drive || drive.kind !== "Gear") return state;
      return unitsBanishedWith(drive).reduce((next, unitId) => {
        // Looked up per unit and inside the fold, because each play mutates the
        // banished zone the next lookup reads. A unit that is no longer there is
        // skipped rather than throwing — the usual target-vanished convention,
        // and reachable here since a `[Deathknell]` resolving between the deaths
        // could have moved one.
        const owner = next.players[ctx.casterIndex];
        const card = owner.banished.find((c) => c.instanceId === unitId);
        if (!card || card.kind !== "Unit") return next;
        const players = [...next.players] as [PlayerState, PlayerState];
        players[ctx.casterIndex] = { ...owner, banished: owner.banished.filter((c) => c.instanceId !== unitId) };
        return playCardIgnoringCost({ ...next, players }, ctx.casterIndex, card);
      }, state);
    },
  },
  "SFD-168": {
    // Vanguard Armory — "[Exhaust]: Play three 1 [Might] Recruit unit tokens.
    // (You may play them to different locations.)"
    //
    // # The parenthetical is the whole difficulty, and it is an ENUMERATION
    // problem
    //
    // Three independent destinations is a cross product, not a fan-out: with a
    // base and three controlled battlefields that is 4³ = 64 candidate actions
    // for one activation, every one of which the AI would have to score. Every
    // other multi-token card in the pool sends them all to ONE chosen place
    // (Recruit the Vanguard, Arise!) precisely because it prints no such
    // parenthetical; this card prints one, so collapsing it would drop the
    // ability that makes the card worth 7 Energy — spreading three bodies.
    //
    // So the destinations are ASKED, once per token, through a decision that
    // re-parks itself with one fewer to place. That is `OGN-230-spend`'s shape
    // ("any number", a repeated question with a standing answer) applied to a
    // bounded count, and it keeps the action space at one ActivateAbility.
    //
    // **The cost of that is a recorded divergence, not a new one.** 355 makes
    // choices for an activated ability at the moment it is announced; a parked
    // decision asks at resolution. docs/rules-conformance.md already carries that
    // row for every held trigger, and this inherits it rather than adding one.
    //
    // A destination list of exactly one (a player with no battlefield they
    // control) is not a question at all — `advanceDecisions` executes a
    // single-option decision without showing it, so the common case costs the
    // player no clicks.
    kind: "Gear",
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // The count is in `constants.ts` rather than here, so this ability and the
      // question it parks quote one number without importing each other — see
      // that constant's note for the import cycle this avoids.
      parkDecision(state, { kind: "SFD-168-place", playerIndex: ctx.casterIndex, count: VANGUARD_ARMORY_TOKENS }),
  },
  [ORB_OF_REGRET]: {
    kind: "Gear",
    // "A unit" names no battlefield and no owner, so a unit in either player's
    // base is a legal target — the same reading base-targeting.test.ts already
    // pins for En Garde and Stupefy.
    targeting: { kind: "unit", scope: "anywhere" },
    // The floor is the card's own clause, not a safety net: giveMightThisTurn's
    // `floor` argument exists for exactly this wording, and it caps the stored
    // modifier rather than only the displayed Might, so repeated activations
    // can't dig a hole a later buff has to climb out of.
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -1, 1) : state,
  },
};

/**
 * The Gold token's entry is the one key in this table that is COMPUTED from an
 * imported binding, and that made it uniquely able to register itself under the
 * wrong name in silence.
 *
 * It happened: an import added to `effects/calm.ts` closed a cycle through this
 * module, `GOLD_TOKEN_DEF_ID` read as `undefined` while this object literal was
 * being built, and the ability registered under the string `"undefined"`. The
 * token kept minting, kept entering play, and simply had no ability — which is
 * exactly the failure mode `GOLD_TOKEN_DEF_ID`'s own comment in token.ts warns
 * about ("a table keyed to an id nothing creates is silent, and reads exactly
 * like an implemented ability").
 *
 * A throw at module load rather than a test, because the failure is an
 * INITIALISATION-ORDER one: whether it bites depends on which module the
 * importer reached first, so a suite that happens to import in a safe order
 * proves nothing about the app that does not. This fires on the import that
 * breaks it, which is the day it should be noticed — the same reasoning
 * `legendEventTriggers`' throw on a second hook records.
 */
// Checks for the SYMPTOM — a key that is the string "undefined" — rather than
// for the Gold token's id. Asking `GOLD_TOKEN_DEF_ID in ACTIVATED_ABILITIES`
// looks like the natural test and is worthless: under the cycle that binding is
// itself `undefined` in this same evaluation pass, so it asks about the very key
// the bug just created and passes. That version was written first and proved
// inert by re-introducing the cycle.
//
// Keyed on the symptom, it also generalises: any future computed key built from
// a binding that is not ready yet lands here, not just this one.
if ("undefined" in ACTIVATED_ABILITIES) {
  throw new Error(
    "activated-abilities: an ability registered under the key \"undefined\". A computed key was built from an " +
      "import binding that had not initialised — an import cycle reached this module before token.js finished. " +
      "See this guard's comment.",
  );
}

/**
 * The built-in table PLUS whatever the per-domain files registered.
 *
 * **`ACTIVATED_ABILITIES` used to be module-private, and that was a wall.** No
 * domain file could register an activated ability at all, so a card printing
 * "[cost]: do something" either had to be written into this shared file — which
 * is precisely what the fan-out rule keeps parallel agents out of — or refused.
 * Wave 1 refused UNL-026 and UNL-093 on it.
 *
 * Composed lazily and memoised, matching `triggers.ts`'s four composed
 * registries. Eager composition would import `effects/index.js` at module scope,
 * and this module is imported by much of the engine — the initialisation-order
 * trap the `"undefined" in ACTIVATED_ABILITIES` guard below already records.
 *
 * `mergeRegistries` throws on a duplicate defId, so a card registered both here
 * and in a domain file is a named error at first use rather than an arbitrary
 * winner and a loser that looks like it was never written.
 */
let composedAbilities: Record<string, ActivatedAbilityDefinition> | undefined;
function allActivatedAbilities(): Record<string, ActivatedAbilityDefinition> {
  composedAbilities ??= mergeRegistries<ActivatedAbilityDefinition>("activated ability", [
    { name: "engine/activated-abilities.ts", entries: ACTIVATED_ABILITIES },
    ...domainActivatedAbilities(),
  ]);
  return composedAbilities;
}

export function activatedAbilityFor(defId: string): ActivatedAbilityDefinition | undefined {
  return allActivatedAbilities()[defId];
}

export function hasActivatableAbility(defId: string): boolean {
  return defId in allActivatedAbilities();
}

/**
 * What activating `defId` costs, with the common `{ exhaust: true }` default made
 * explicit so no caller has to remember it.
 *
 * `modeId` is what makes a MODAL ability able to price its options differently
 * (Jax - Grandmaster At Arms). Omitting it deliberately still answers — the
 * ability's own cost — because every existing caller of a non-modal ability
 * passes nothing, and because a mode with no `cost` of its own falls through to
 * exactly that answer anyway.
 */
export function activationCostOf(defId: string, modeId?: string): ActivationCost {
  const ability = allActivatedAbilities()[defId];
  if (modeId !== undefined) {
    const mode = modesOf(defId).find((m) => m.id === modeId);
    if (mode?.cost) return mode.cost;
  }
  return ability?.cost ?? { exhaust: true };
}

/**
 * UNL-188 Hextech Gauntlets — "[Equip] [3][rainbow]. **This ability's Energy
 * cost is reduced by the Might of the unit you choose.**"
 *
 * The pool's first activation cost that depends on WHICH target was chosen, and
 * the reason `activationCostOf` above could not answer on its own: it is handed a
 * defId and a mode, and the target is picked afterwards.
 */
const EQUIP_ENERGY_REDUCED_BY_TARGET_MIGHT = new Set(["UNL-188"]);

/**
 * This ability's cost for a play that chose `targetUnitInstanceId`.
 *
 * Identical to `activationCostOf` for every ability but one, so an ordinary
 * activation is priced exactly as it always was.
 *
 * **With no target named it returns the BEST case — the largest reduction any
 * legal target could give.** That is deliberate and it is a fidelity rule rather
 * than an optimisation: `canPayActivationCost` is asked once per ability, before
 * any target exists, and a gate that priced the un-reduced cost there would
 * refuse to offer the Gauntlets at all whenever the player could afford them
 * only with the discount. Withholding a legal play is the one thing this engine
 * must not do; the per-target checks below then price each candidate exactly.
 *
 * Uses `effectiveMight` (143.2), not the printed number — a pumped unit really
 * does pay for more of the attach.
 */
export function activationCostFor(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string,
  modeId?: string,
  targetUnitInstanceId?: string,
  /** WHICH permanent is activating — needed by the two battlefields that
   *  discount an ability by what the SOURCE is or where it stands (Risen Altar,
   *  Piltovan Forge). Optional for the same reason `targetUnitInstanceId` is: a
   *  caller pricing an ability in the abstract has no source, and gets the
   *  undiscounted price. All five real callers hold one. */
  sourceInstanceId?: string,
): ActivationCost {
  const cost = battlefieldAbilityDiscount(
    state,
    playerIndex,
    defId,
    applyEnergyDiscount(state, playerIndex, activationCostOf(defId, modeId)),
    sourceInstanceId,
  );
  if (!EQUIP_ENERGY_REDUCED_BY_TARGET_MIGHT.has(canonicalDefId(defId)) || cost.energy === undefined) return cost;
  const reduction =
    targetUnitInstanceId !== undefined
      ? mightOfTarget(state, targetUnitInstanceId)
      : Math.max(
          0,
          ...eligibleTargets(state, playerIndex, "friendly", "anywhere").map((u) =>
            mightOfTarget(state, u.instanceId),
          ),
        );
  return { ...cost, energy: Math.max(0, cost.energy - reduction) };
}

/**
 * Applies an `energyDiscount` rule to a cost — the whole of "This ability costs
 * [N] less…" (827.1.c.3).
 *
 * Both printed shapes count **runes you control**, which is `channeled.length`:
 * the Rune Pool, the same count every other card reading that phrase uses. Read
 * LIVE at the moment the price is asked, which is the point of putting this in
 * `activationCostFor` rather than in the loader — a rune recycled between the
 * offer and the payment really does change what Frostcoat Mother costs, and all
 * four consumers of that function get the same answer at the same instant.
 *
 * **Floored at 0**, so a 12-rune board makes her free rather than paying the
 * player 0 Energy and some change. `energy: 0` is then dropped entirely, because
 * an `ActivationCost` with a zero Energy field and one with no field at all must
 * price identically — `canPayActivationCost` and `activationPayment` both branch
 * on the field's PRESENCE, and a lingering 0 would ask for a rune payment nobody
 * needs to make.
 *
 * A no-op for every ability that prints no such sentence, which is all but three
 * cards — so this sits on the shared path without changing any of them.
 */
function applyEnergyDiscount(state: GameState, playerIndex: 0 | 1, cost: ActivationCost): ActivationCost {
  const rule = cost.energyDiscount;
  if (rule === undefined || cost.energy === undefined) return cost;
  const runes = state.players[playerIndex].channeled.length;
  const reduction =
    rule.kind === "perRuneControlled" ? rule.amount * runes : runes <= rule.max ? rule.amount : 0;
  const energy = Math.max(0, cost.energy - reduction);
  if (energy > 0) return { ...cost, energy };
  const { energy: _dropped, ...withoutEnergy } = cost;
  return withoutEnergy;
}

/** A unit's CURRENT Might (143.2), or 0 if it is no longer anywhere. */
function mightOfTarget(state: GameState, instanceId: string): number {
  const found = findUnitAnywhere(state, instanceId);
  if (!found) return 0;
  return effectiveMight(
    state,
    found.unit,
    found.ownerIndex,
    found.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[found.zone.battlefieldIndex]!.id },
  );
}

/**
 * Can `playerIndex` pay this ability's cost right now?
 *
 * Both halves are real refusals, not do-as-much-as-you-can: an exhausted source
 * can't pay an exhaust, and rule 416.3 says a Recycle cost "must be able to be
 * completed for the cost to be paid". Shared by the validator and the
 * enumerator so an ability is never offered and then refused.
 */
/**
 * The friendly permanents an ability could kill to pay — units anywhere plus
 * active gear, EXCLUDING the source itself.
 *
 * Excluding the source is not printed on Malzahar and is the right reading
 * anyway: `killSelf` is the cost that destroys the source, and an ability that
 * both exhausted and killed its own unit could never be used twice. The rules'
 * own separation of the two cost kinds is what says these are different things.
 */
export function killableFriendlyPermanents(
  state: GameState,
  playerIndex: 0 | 1,
  sourceInstanceId: string,
): { instanceId: string; name: string; isGear: boolean }[] {
  const owner = state.players[playerIndex];
  return [
    ...owner.baseUnits.map((u) => ({ instanceId: u.instanceId, name: u.name, isGear: false })),
    ...state.battlefields.flatMap((bf) => (bf.units[owner.id] ?? []).map((u) => ({ instanceId: u.instanceId, name: u.name, isGear: false }))),
    ...owner.activeGear.map((g) => ({ instanceId: g.instanceId, name: g.name, isGear: true })),
  ].filter((p) => p.instanceId !== sourceInstanceId);
}

/**
 * The friendly units an ability could EXHAUST to pay — UNL-045 Forgotten
 * Signpost's "Exhaust a unit you control".
 *
 * Units only, and READY ones only. Both narrowings are the printed text rather
 * than caution: a gear is not "a unit you control", and 416 has nothing to take
 * from a unit that is already exhausted — offering one would be the cost that
 * cannot be completed, which 416.3 says is not a cost you may choose to pay.
 *
 * Base AND battlefields, because the card names neither and 355.9.a.1 widens a
 * bare "unit" to every unit on the Board. That is load-bearing here rather than
 * incidental: the payer's location is the destination, so a payer standing in
 * base is the only way this card pulls a unit home.
 *
 * ONE walk, called by `activationCostChoices`, `canPayActivationCost`, the
 * validator's re-derivation and `payActivationCost` — the four sites that have
 * disagreed about a cost five times in this engine's history.
 */
export function exhaustableFriendlyUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const owner = state.players[playerIndex];
  return [
    ...owner.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? []),
  ].filter((u) => !u.exhausted);
}

/**
 * Is this action's COST PAYER a legal partner for what it TARGETS?
 *
 * Vacuously true for every ability but the one that declares
 * `movesTargetToCostPayer`, where the printed text constrains the pair rather
 * than either choice alone: "move a DIFFERENT unit you control to the LOCATION
 * of the unit you exhausted".
 *
 * **It has to be a pair check, and that is why it is a function rather than two
 * filters.** `activationCostChoices` fans the payer out once per MODE, before
 * any target is known, and the enumerator then crosses the two axes — so the
 * cross is the first place both halves exist at once. Called there and re-derived
 * in `validate-activate-ability`, so a hand-built action cannot exhaust the very
 * unit it is moving, or pay an exhaust to move a unit to where it already stands.
 */
export function costPayerPairingAllowed(
  state: GameState,
  mode: Pick<AbilityMode, "movesTargetToCostPayer">,
  action: { targetUnitInstanceId?: string; costPermanentInstanceId?: string },
): boolean {
  if (!mode.movesTargetToCostPayer) return true;
  const { targetUnitInstanceId: target, costPermanentInstanceId: payer } = action;
  if (target === undefined || payer === undefined) return false;
  const from = findUnitAnywhere(state, target);
  const to = findUnitAnywhere(state, payer);
  if (!from || !to) return false;
  // **The location comparison is BOTH constraints**, which is not obvious and is
  // why it is written down: a unit is trivially in the same location as itself,
  // so "a DIFFERENT unit you control" falls out of "not already standing where
  // the payer is". A first version stated the two separately; mutating the
  // `target === payer` line away changed nothing in the whole suite, because this
  // line had already refused every pair it would have.
  return placeKeyOf(state, from.zone) !== placeKeyOf(state, to.zone);
}

/** A zone as a comparable place — "base" or a battlefield id. Both units here
 *  are the same player's, so one base key cannot conflate two players' bases. */
function placeKeyOf(state: GameState, zone: { battlefieldIndex: number } | "base"): string {
  return zone === "base" ? "base" : state.battlefields[zone.battlefieldIndex]!.id;
}

export function canPayActivationCost(
  state: GameState,
  playerIndex: 0 | 1,
  card: { instanceId: string; defId: string; exhausted: boolean; buffed?: boolean },
  /** The ability being used, when it is not the source's own — Heimerdinger
   *  pays somebody else's cost with his own exhaust. Defaults to the source. */
  abilityDefId: string = card.defId,
  /** The mode being used, for an ability whose modes are priced differently —
   *  Jax. Omitted everywhere else, where there is one price to ask about. */
  modeId?: string,
): boolean {
  const ability = allActivatedAbilities()[abilityDefId];
  // A printed restriction on USING the ability, asked before any cost — see
  // `availableWhile`. Checked here so the enumerator and the validator, which
  // both come through this function, cannot disagree about whether it is legal.
  if (ability?.availableWhile && !ability.availableWhile(state, playerIndex, card.instanceId)) return false;
  // **No `targetUnitInstanceId`, deliberately.** UNL-188 Hextech Gauntlets is the
  // one cost that depends on the chosen unit, and it depends on it only through
  // `energy` — which nothing below reads. A first version threaded the target in
  // here for symmetry with the other two cost sites; mutating it away changed
  // nothing, in the whole suite, because the Energy half is decided by
  // `activationPayment` in the enumerator and by the re-derivation in
  // `validate-activate-ability`. Priced with no target, which for every check
  // this function actually makes is the only price there is.
  const cost = activationCostFor(state, playerIndex, abilityDefId, modeId, undefined, card.instanceId);
  if (cost.exhaust && card.exhausted) return false;
  // Asked through `spendXp` rather than by comparing numbers, so "can I pay"
  // and "pay it" can never disagree about what counts as enough.
  if (cost.xp !== undefined && spendXp(state, playerIndex, cost.xp) === undefined) return false;
  if (cost.recycleFromTrash !== undefined && state.players[playerIndex].trash.length < cost.recycleFromTrash) return false;
  // The UNIT-filtered recycle counts only units, which is the whole reason it
  // is a separate cost: a trash full of Spells cannot pay it.
  if (
    cost.recycleUnitFromTrash !== undefined &&
    state.players[playerIndex].trash.filter((c) => c.kind === "Unit").length < cost.recycleUnitFromTrash
  ) {
    return false;
  }
  // Power is paid from state, so affordability is asked through the very helper
  // that will pay it — the two cannot disagree about what is payable.
  if (cost.power && payPowerFromChanneled(state, playerIndex, cost.power.domain, cost.power.count) === undefined) return false;
  // An X cost needs at least ONE payable unit, or the ability can do nothing at
  // any amount. Asked through the very helpers that will pay it, the same rule
  // the Power line above follows.
  if (cost.xRainbowPower && payPowerFromChanneled(state, playerIndex, null, 1) === undefined) return false;
  if (cost.xEnergy && payEnergyFromPool(state, playerIndex, 1) === undefined) return false;
  // rule 702.2.b.1: only a buffed unit can spend one, so an unbuffed Udyr is simply
  // not offered rather than offered and refused.
  if (cost.spendBuff && !("buffed" in card && card.buffed === true)) return false;
  // The three costs that carry a CHOICE. Affordability is "is there anything to
  // choose", asked here so an ability with nothing to pay with is never offered
  // — 416.3's "a cost that cannot be completed is not one you may choose to pay".
  if (cost.killFriendlyPermanent && killableFriendlyPermanents(state, playerIndex, card.instanceId).length === 0) return false;
  // A board of nothing but EXHAUSTED units cannot pay this, which is the whole
  // reason `exhaustableFriendlyUnits` filters rather than the caller.
  if (cost.exhaustFriendlyUnit && exhaustableFriendlyUnits(state, playerIndex).length === 0) return false;
  // Through the shared walk, so a hand that cannot pay a NARROWED discard makes
  // the ability unofferable rather than offerable-then-refused (416.3).
  if (cost.discard !== undefined && discardableForCost(state, playerIndex, cost).length < cost.discard) return false;
  // 416.3 — a permanent that is not Empowered cannot pay a disempower, so the
  // ability is not offered at all rather than offered and refused.
  if (cost.disempowerSelf === true && !isEmpowered(state, card.instanceId)) return false;
  /**
   * **`killSelf` needs the source to be a GEAR, because that is what paying it
   * looks for** — `payActivationCost` finds the instance in `activeGear` and
   * returns undefined otherwise. Both abilities carrying this cost are `kind:
   * "Gear"` (the Gold token and SFD-134 Zero Drive), so for every ordinary
   * activation the two agree and this line is never the one that refuses.
   *
   * **OGN-111 Heimerdinger - Inventor is where they came apart.** He "has all
   * [Exhaust] abilities of all friendly legends, units, and gear", and
   * `abilitiesAvailableTo` hands him every friendly permanent's registered
   * ability with HIMSELF as the source. Borrow the Gold token's "Kill this,
   * [Exhaust]" and the cost is asked of a Unit: the enumerator offered it, the
   * payer could not find him in `activeGear`, and `execute-activate-ability`
   * THREW — "Heimerdinger - Inventor's activation cost cannot be paid". The AI
   * applies enumerated actions straight to the executor, so it crashed the run
   * rather than failing a validation.
   *
   * The note this replaced said the check was unnecessary because "the source was
   * found in play by resolveActivation before this was called". That is true and
   * it is not the question — being in play is not being in `activeGear`.
   *
   * **Latent since Heimerdinger and the Gold token first coexisted, and surfaced
   * on 2026-08-24 by the ability-timing gate**, which changed nothing about this
   * path: 310.1.a narrowed which actions the AI is offered in Showdowns, the
   * trajectories moved, and `battlefield-reach`'s fixed seeds reached a board
   * where Heimerdinger and a Gold token stood together for the first time.
   *
   * **This closes the crash, not the card question.** Whether "all [Exhaust]
   * abilities" should reach a "Kill this, [Exhaust]" cost at all, and whether a
   * borrowed "kill this" should kill the BORROWER, are both open and recorded in
   * docs/rules-conformance.md. Refusing the unpayable activation is the answer
   * that needs no ruling: 416.3 — "a cost that cannot be completed is not one you
   * may choose to pay".
   */
  if (cost.killSelf && !state.players[playerIndex].activeGear.some((g) => g.instanceId === card.instanceId)) return false;
  // The Energy half is a payment, so affordability is "could a payment be
  // computed", which is exactly what the enumerator will do — asked through the
  // same function so the two cannot disagree about what is affordable.
  if (cost.energy !== undefined && activationPayment(state, playerIndex, cost) === undefined) return false;
  return true;
}

/**
 * The runes that would pay an activation's Energy cost, or undefined if it
 * cannot be paid.
 *
 * Floating Energy first, exactly as a card's cost is priced — `energyAfterFloat`
 * is the same function `computeEffectiveCost` uses, so an activation and a play
 * agree on what a player can afford.
 *
 * Takes the whole COST, not just the Energy number, because `payActivationCost`
 * pays Power FIRST and paying Power RECYCLES the rune: the pool this prices
 * against has to be the one the Power step leaves behind, or a single rune can
 * be named for Energy and then be gone by the time the Energy is paid. Power is
 * applied here to a throwaway state for exactly that reason — the same helper,
 * in the same order, so the price and the payment cannot disagree.
 *
 * Note this is NOT a live fix: pricing it against the pre-Power pool happens to
 * come out the same, because recycling a READY rune banks 1 floating Energy,
 * which covers precisely the 1 Energy that rune could have paid — the two
 * errors cancel exactly, for every pool and every cost. It is written this way
 * so the agreement is by construction rather than by that coincidence. Nothing
 * in the pool combines `energy` with `power` yet; OGN-242 Baited Hook would be
 * the first, and it is the card that would inherit the coincidence.
 */
export function activationPayment(state: GameState, playerIndex: 0 | 1, cost: ActivationCost): RunePayment | undefined {
  if (cost.energy === undefined) return undefined;
  let next = state;
  if (cost.power) {
    const paid = payPowerFromChanneled(next, playerIndex, cost.power.domain, cost.power.count);
    if (paid === undefined) return undefined;
    next = paid;
  }
  const actor = next.players[playerIndex];
  return computeAutoPayment(actor.channeled, energyAfterFloat(actor.floatingEnergy, cost.energy), 0, null) ?? undefined;
}

/** Pays an activation cost, or returns undefined if it cannot be paid. */
export function payActivationCost(
  state: GameState,
  playerIndex: 0 | 1,
  instanceId: string,
  defId: string,
  payment?: RunePayment,
  /** What the action named for a cost that carries a CHOICE — Malzahar's kill,
   *  Unlicensed Armory's discard. Absent for every cost paid from state. */
  chosen?: { costPermanentInstanceId?: string; costDiscardCardInstanceId?: string; xAmount?: number },
  /** The mode being paid for — see `activationCostOf`. */
  modeId?: string,
  /** The unit this activation chose, for a cost that depends on it (UNL-188).
   *  Re-derived here rather than trusted, the convention every cost site keeps. */
  targetUnitInstanceId?: string,
): GameState | undefined {
  // `instanceId` IS the source — Risen Altar and Piltovan Forge discount by what
  // it is and where it stands, and this function has had it all along.
  const cost = activationCostFor(state, playerIndex, defId, modeId, targetUnitInstanceId, instanceId);
  let next = state;
  if (cost.xp !== undefined) {
    const spent = spendXp(next, playerIndex, cost.xp);
    if (spent === undefined) return undefined;
    next = spent;
  }
  if (cost.recycleFromTrash !== undefined) {
    const recycled = recycleFromTrash(next, playerIndex, cost.recycleFromTrash);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  if (cost.recycleUnitFromTrash !== undefined) {
    const recycled = recycleUnitsFromTrash(next, playerIndex, cost.recycleUnitFromTrash);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  // The X costs. Paid from state rather than from a named rune list: Hextech
  // Anomaly's rainbow accepts ANY domain, so which runes go is not a meaningful
  // choice, and `payPowerFromChanneled(null, x)` already means exactly that.
  //
  // An X larger than the pools can cover returns `undefined` and the whole
  // activation fails — the same all-or-nothing contract 416.3 gives a Recycle,
  // and the reason neither of these can be paid "as much as it can".
  if (cost.xRainbowPower) {
    const x = chosen?.xAmount ?? 0;
    if (x <= 0) return undefined;
    const spent = payPowerFromChanneled(next, playerIndex, null, x);
    if (spent === undefined) return undefined;
    next = spent;
  }
  if (cost.xEnergy) {
    const x = chosen?.xAmount ?? 0;
    if (x <= 0) return undefined;
    const spent = payEnergyFromPool(next, playerIndex, x);
    if (spent === undefined) return undefined;
    next = spent;
  }
  if (cost.spendBuff) {
    const spent = spendBuff(next, playerIndex, instanceId);
    if (spent === undefined) return undefined;
    next = spent;
  }
  if (cost.power) {
    const paid = payPowerFromChanneled(next, playerIndex, cost.power.domain, cost.power.count);
    if (paid === undefined) return undefined;
    next = paid;
  }
  if (cost.killSelf) {
    const gear = next.players[playerIndex].activeGear.find((g) => g.instanceId === instanceId);
    if (!gear) return undefined;
    // killGear, not a quiet removal: paying a cost with a permanent is still
    // killing it, so its own "when I am killed" self-trigger must fire — the
    // same reasoning Cruel Patron's kill-as-a-cost already follows.
    next = killGear(next, gear, playerIndex);
  }
  if (cost.disempowerSelf === true) {
    // Re-checked at PAYMENT as well as at the offer, the convention every cost
    // here follows: the ability was offered a chain-pop ago and the status can
    // have been stripped in between. `disempowerPermanent` is the single writer
    // and no-ops on something already disempowered (442.1.a.1), so the guard is
    // this line rather than that helper's.
    if (!isEmpowered(next, instanceId)) return undefined;
    next = disempowerPermanent(next, instanceId);
  }
  if (cost.banishSelf) {
    const gear = next.players[playerIndex].activeGear.find((g) => g.instanceId === instanceId);
    if (!gear) return undefined;
    // NOT `killGear`. Banishing is not killing, so no self-trigger fires and the
    // gear does not pass through a trash — see `banishSelf`'s own note for why
    // that distinction is the Zero Drive's whole cost. `banishCard` carries the
    // INSTANCE across, which is what preserves its `banishedInstanceIds` for the
    // effect that is about to read them.
    next = banishCard(next, playerIndex, instanceId);
  }
  // The three costs that carry a CHOICE, paid from what the action named.
  if (cost.exhaustFriendlyUnit) {
    if (!chosen?.costPermanentInstanceId) return undefined;
    // Re-checked against the SAME walk the enumerator fanned out from rather than
    // exhausting whatever was named: an already-exhausted unit is not a payment,
    // and neither is an opponent's.
    const payer = exhaustableFriendlyUnits(next, playerIndex).find((u) => u.instanceId === chosen.costPermanentInstanceId);
    if (!payer) return undefined;
    // `exhaustActivated`, which is the exhaust funnel this file already owns and
    // already walks every zone a unit can stand in — base and battlefields both.
    // Its name says "the activated permanent" because until now that was its only
    // caller; what it actually does is exhaust one of `playerIndex`'s permanents
    // by id, which is exactly this. A second hand-rolled exhaust would be a second
    // place to forget the battlefield walk, which is the bug it was written after.
    next = exhaustActivated(next, playerIndex, payer.instanceId);
  }
  if (cost.killFriendlyPermanent) {
    if (!chosen?.costPermanentInstanceId) return undefined;
    const gear = next.players[playerIndex].activeGear.find((g) => g.instanceId === chosen.costPermanentInstanceId);
    // Routed through the real funnels for the reason Cruel Patron's kill records:
    // paying a cost with a permanent is still killing it, so a unit's [Deathknell]
    // and a gear's "when I am killed" both fire. No `killerIndex` — paying a cost
    // with your own permanent is not "you killing it" in Solari Shrine's sense.
    next = gear ? killGear(next, gear, playerIndex) : destroyUnit(next, chosen.costPermanentInstanceId);
  }
  if (cost.discard !== undefined) {
    if (!chosen?.costDiscardCardInstanceId) return undefined;
    const actor = next.players[playerIndex];
    // Found in the NARROWED walk, not in the hand, so a payment naming a card the
    // cost does not accept fails here rather than paying with the wrong kind.
    const card = discardableForCost(next, playerIndex, cost).find(
      (c) => c.instanceId === chosen.costDiscardCardInstanceId,
    );
    if (!card) return undefined;
    const players = [...next.players] as [PlayerState, PlayerState];
    players[playerIndex] = {
      ...actor,
      hand: actor.hand.filter((c) => c.instanceId !== card.instanceId),
      // From the HAND, so Endless Riches banishes it instead. The discard still
      // HAPPENED — `discardedThisTurn` on the next line is set either way — and
      // only the resting place changes.
      ...fileIntoTrash(next, playerIndex, actor, card, "elsewhere"),
      discardedThisTurn: true,
    };
    next = { ...next, players };
  }
  if (cost.energy !== undefined) {
    const paid = payActivationEnergy(next, playerIndex, cost.energy, payment);
    if (paid === undefined) return undefined;
    next = paid;
  }
  // The `[Deflect]` surcharge on whatever this ability chose. Paid LAST, after
  // the ability's own cost, for the reason `computeAutoPayment` takes it last:
  // the ability's Power is domain-restricted and the tax is not, so spending a
  // matching rune on the tax first could make a payable ability unpayable.
  //
  // Not gated on `cost`: the surcharge is the OPPONENT's keyword, not part of
  // what the ability costs, so an ability whose only cost is an exhaust still
  // owes it. `validate-activate-ability` is what decides it is owed at all.
  const rainbow = payment?.rainbowRunes ?? [];
  if (rainbow.length > 0) {
    const recycled = recycleRunesForSurcharge(next, playerIndex, rainbow);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  if (cost.exhaust) next = exhaustActivated(next, playerIndex, instanceId);
  return next;
}

/**
 * Recycles the named runes to the bottom of the rune deck for a `[Deflect]`
 * surcharge — 416, a Power cost is paid by recycling.
 *
 * **No floating-Energy credit**, unlike a rune recycled for its owner's own
 * Power. 164.2's double duty is about paying YOUR cost; a tax handed to an
 * opponent refunds nothing, which is the same line `execute-play-card` draws
 * for a Spell's surcharge.
 */
function recycleRunesForSurcharge(state: GameState, playerIndex: 0 | 1, runeIds: readonly string[]): GameState | undefined {
  const actor = state.players[playerIndex];
  const spent = actor.channeled.filter((r) => runeIds.includes(r.id));
  if (spent.length < runeIds.length) return undefined;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    channeled: actor.channeled.filter((r) => !runeIds.includes(r.id)),
    runeDeck: [...actor.runeDeck, ...spent.map((r) => ({ ...r, state: "Ready" as const }))],
  };
  return { ...state, players };
}

/** Spends floating Energy first, then exhausts the named runes — the same order
 *  and the same arithmetic execute-play-card uses for a card's Energy cost. */
function payActivationEnergy(
  state: GameState,
  playerIndex: 0 | 1,
  energy: number,
  payment: RunePayment | undefined,
): GameState | undefined {
  const actor = state.players[playerIndex];
  const fromFloat = Math.min(actor.floatingEnergy, energy);
  const owed = energy - fromFloat;
  const runeIds = new Set(payment?.energyRunes ?? []);
  const usable = actor.channeled.filter((r) => runeIds.has(r.id) && r.state === "Ready");
  if (usable.length < owed) return undefined;

  const spend = new Set(usable.slice(0, owed).map((r) => r.id));
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    floatingEnergy: actor.floatingEnergy - fromFloat,
    channeled: actor.channeled.map((r) => (spend.has(r.id) ? { ...r, state: "Exhausted" as const } : r)),
  };
  return { ...state, players };
}

/**
 * The tier an activated ability is timed at — DEFAULT unless the ability itself
 * prints `[Action]` or `[Reaction]`.
 *
 * **THIRTY-NINE of the 184 registered abilities, spread over all five sets.** The
 * other 145 are Default, which is why these are two sets rather than a field on
 * every definition.
 *
 * # There are TWO printed forms, and reading only the documented one loses 19
 *
 * 806.1.d says Action "is formatted as `[Action]` on spells, or `[Action][>]` on
 * abilities", and UNL/VEN print exactly that. **OGN, OGS and SFD do not.** They
 * put the keyword after the cost instead — Seal of Rage is "`[Exhaust]:
 * [Reaction] — [Add] [Fury]`", Azir - Ascendant is "`[Calm]: [Action] — Choose a
 * unit you control`". A scan for `[Action][>]`/`[Reaction][>]` finds 20 of the 39
 * and silently drops every rune Seal, both banking Legends and Ornn.
 *
 * **And the em-dash that separates them is MOJIBAKED in the older data** —
 * `ogn.json` carries U+00E2 U+0080 U+0094 (an em-dash's UTF-8 bytes read as
 * Latin-1) on 102 lines and `ogs.json` on 3, while sfd/unl/ven carry a clean
 * U+2014. A predicate that matches only the real dash drops all ten OGN/OGS
 * entries and keeps the SFD ones, which looks like a set-shaped finding rather
 * than an encoding bug. `ability-timing.test.ts` matches both.
 *
 * # Why a table rather than a field on `ActivatedAbilityDefinition`
 *
 * The tier is a fact about the PRINTED TEXT, and `ability-timing.test.ts` asserts
 * exactly that — a bijection between these two sets and what the pool prints, in
 * both directions, tolerating both forms and both encodings. A field spread over
 * ten domain files would make the same assertion against 39 places instead of 2.
 * A new card printing a speed keyword and missing from here fails that test by
 * name.
 *
 * The tier is per ABILITY, not per card: the loader's card-level `isReaction`
 * answers when the CARD may be PLAYED. UNL-185 Pyke - Bloodharbor Ripper prints
 * the string "[Reaction][>]" and his own ability is Default — it is his token's.
 *
 * Asked by `legal-actions` and `validate-activate-ability` alike, so a gated
 * ability cannot be offered and then refused.
 */
/**
 * **THREE cards print a speed-tagged ability and are deliberately NOT here** —
 * VEN-075 Platewyrm Egg, VEN-139 and VEN-189 Akali - Rogue Assassin. Each also
 * has an `[Empower]` cost, and `empowerAbilities()` registers that under the
 * card's own defId, so the ability reachable at `VEN-075` is the Empower one:
 * `{ energy: 1, exhaust: true }`, which prints no speed keyword and is Default.
 *
 * Tagging them by scanning the whole card text would have timed the EMPOWER at
 * the other ability's speed — letting Akali be Empowered inside a Showdown, and
 * on the strength of a keyword printed on a different line. `mergeRegistries`
 * throws on a duplicate key, so there is no second entry hiding behind these:
 * the printed `[Action][>]`/`[Reaction][>]` half of all three is genuinely
 * unregistered, which is a coverage gap rather than a timing one and is recorded
 * in docs/rules-conformance.md. `ability-timing.test.ts` names all three and
 * fails if a FOURTH appears.
 */
const ACTION_SPEED_ABILITIES: ReadonlySet<string> = new Set([
  "OGN-113", // Malzahar - Fanatic
  "SFD-050", // Azir - Ascendant
  "SFD-082", // Ezreal - Dashing
  "UNL-045", // Forgotten Signpost
  "UNL-161", // Divining Shells
  "UNL-194", // Shadow
  "VEN-112", // Zed, Without a Sound
  "VEN-143", // Zed - Master of Shadows
  "VEN-147", // Shen - Eye of Twilight
  "VEN-155", // Yordle, Kennen - Heart of the Tempest
  "VEN-191", // Zed - Master of Shadows (Overnumbered)
  "VEN-193", // Shen - Eye of Twilight (Overnumbered)
  "VEN-197", // Yordle, Kennen - Heart of the Tempest (Overnumbered)
]);

/**
 * **`[Reaction][>]` — 813.1.c.2**: "This can be activated during Closed States on
 * any player's turn", plus everything Action grants (813.1.b).
 *
 * Twenty-three of them, and **fourteen are the resource-bankers** — the six rune
 * Seals, Energy Conduit, Ancient Henge, Hextech Anomaly and the five Legends who
 * add a restricted pool. That family is what `validate-activate-ability` used to
 * describe when it justified applying NO timing check at all: "a [Reaction]-tagged
 * ability meant to be usable essentially any time during the Action phase to bank
 * a resource for a later Spell". The family is real and large; the conclusion was
 * that all 184 abilities should share its window.
 */
const REACTION_SPEED_ABILITIES: ReadonlySet<string> = new Set([
  "OGN-040", // Seal of Rage
  "OGN-081", // Seal of Focus
  "OGN-098", // Energy Conduit
  "OGN-120", // Seal of Insight
  "OGN-163", // Seal of Strength
  "OGN-204", // Seal of Discord
  "OGN-245", // Seal of Unity
  "OGN-247", // Kai'Sa - Daughter of the Void
  "OGN-253", // Darius - Hand of Noxus
  "OGS-014", // Lux - Crownguard
  "SFD-083", // Hextech Anomaly
  "SFD-117", // Ancient Henge
  "SFD-189", // Ornn - Fire Below the Mountain
  "SFD-199", // Ezreal - Prodigal Explorer
  "UNL-049", // Honeyfruit
  "UNL-093", // Dragonsoul Sage
  "UNL-197", // Diana - Scorn of the Moon
  "UNL-234", // Diana - Scorn of the Moon (Overnumbered)
  "UNL-234*", // Diana - Scorn of the Moon (Signature)
  "VEN-141", // Renekton - Butcher of the Sands
  "VEN-190", // Renekton - Butcher of the Sands (Overnumbered)
  "VEN-sp6", // Lux, Crownguard
  // **The Gold gear token, which has no card entry of its own.** Its ability is
  // printed only in its PARENTS' reminder text — UNL-018 Yeti Brawler, UNL-073
  // Deadly Flourish and UNL-185 Pyke - Bloodharbor Ripper each say it has
  // "[Reaction][>] Kill this, [Exhaust]: [Add] [rainbow]". That reminder is also
  // why the printed-text check in `ability-timing.test.ts` strips parentheticals:
  // without that, Pyke reads as Reaction-speed himself, and his own ability is a
  // plain default-speed exhaust.
  GOLD_TOKEN_DEF_ID,
]);

export function abilityTimingTier(abilityDefId: string): TimingTier {
  if (REACTION_SPEED_ABILITIES.has(abilityDefId)) return "Reaction";
  if (ACTION_SPEED_ABILITIES.has(abilityDefId)) return "Action";
  return "Default";
}

/** Does this ability only bank a resource? See `banksResource` — the AI skips
 *  these because a board-state evaluator cannot price them. */
export function abilityBanksResource(defId: string): boolean {
  return allActivatedAbilities()[defId]?.banksResource === true;
}

/** Targeting for an activated ability, defaulting to "none" — same shape and
 *  default as targetingForCard, so callers can treat the two alike. */
export function activatedAbilityTargeting(defId: string): TargetingSpec {
  return allActivatedAbilities()[defId]?.targeting ?? { kind: "none" };
}

/** Every defId with an activated ability, for coverage.ts. */
export function activatedAbilityDefIds(): string[] {
  return Object.keys(allActivatedAbilities());
}

/** A permanent `playerIndex` controls that could be activated right now, found by
 *  instanceId across all three zones an activatable thing can sit in. Shared by
 *  the validator and the executor so "can I?" and "do it" can't disagree about
 *  where things are. */
export function findActivatable(
  state: GameState,
  playerIndex: 0 | 1,
  instanceId: string,
): { card: UnitInstance | GearInstance | LegendInstance; definition: ActivatedAbilityDefinition } | undefined {
  const actor = state.players[playerIndex];
  // The LEGEND is a fourth place an activatable thing sits, and it is not on the
  // board at all — it has its own zone. Two of the three OGN preset legends have
  // an exhaust ability, and while this list held only the board zones they were
  // unreachable rather than merely unimplemented: no action could name them.
  const candidates: (UnitInstance | GearInstance | LegendInstance)[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    actor.legend,
  ];
  const card = candidates.find((c) => c.instanceId === instanceId);
  if (!card) return undefined;
  const definition = allActivatedAbilities()[card.defId];
  return definition ? { card, definition } : undefined;
}

/** Exhausts the activated permanent, wherever it lives. The exhaust IS the cost
 *  (rule: an exhaust symbol in a cost line), so this runs whether or not the
 *  effect ends up doing anything — a fizzled target does not refund it. */
export function exhaustActivated(state: GameState, playerIndex: 0 | 1, instanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  const exhaust = <T extends { instanceId: string; exhausted: boolean }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, exhausted: true } : c;

  players[playerIndex] = {
    ...actor,
    baseUnits: actor.baseUnits.map(exhaust),
    activeGear: actor.activeGear.map(exhaust),
    // The legend zone. Missing it made a Legend ability free and repeatable
    // within a turn — the cost was silently not paid, which is the worst shape
    // of bug here because the effect still happened.
    legend: exhaust(actor.legend),
  };

  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    if (!mine) return bf;
    return { ...bf, units: { ...bf.units, [actor.id]: mine.map(exhaust) } };
  });

  return { ...state, players, battlefields };
}

/** Heimerdinger - Inventor: "I have all :rb_exhaust: abilities of all friendly
 *  legends, units, and gear." He has no ability of his own; he has everyone
 *  else's. */
const HEIMERDINGER_INVENTOR = "OGN-111";

/**
 * Every ability `source` can be used to activate right now, as (abilityDefId,
 * definition) pairs.
 *
 * Almost always exactly one — the source's own. Heimerdinger is the exception,
 * and the reason this is a list rather than a lookup: he offers every activated
 * ability any friendly permanent has, with himself as the source.
 *
 * Rule 414.5 decides whose exhaust pays: "In abilities, the Exhaust symbol
 * represents the cost 'Exhaust this' or **'Exhaust me'**." He HAS the ability, so
 * the exhaust is his — which also means the card he borrowed it from can be
 * exhausted already and it makes no difference.
 */
/**
 * The battlefields whose whole printed text is an ability-cost DISCOUNT, for
 * `battlefield-coverage.test.ts`.
 *
 * A SIXTH source, and it needed its own export for the reason Altar of Blood
 * needed the fifth: that gate is the only thing in the repo that can see a
 * battlefield at all, and one implemented in a way the gate does not know about
 * goes on being reported as doing nothing. These two are not keyed by their own
 * defId in `ACTIVATED_ABILITIES` the way Forge of the Fluft and Gardens of
 * Becoming are — they modify OTHER abilities' costs, so there is no entry to find.
 */
export function abilityDiscountBattlefieldDefIds(): string[] {
  return [RISEN_ALTAR, PILTOVAN_FORGE];
}

/** Risen Altar (VEN-163) — "[Empower] costs of your units here cost [1 Energy] or
 *  [1 rainbow] less." */
const RISEN_ALTAR = "VEN-163";
/** Piltovan Forge (VEN-161) — "While you control this battlefield, the first
 *  friendly gear activated ability played each turn costs [1 Energy] less." */
const PILTOVAN_FORGE = "VEN-161";
const BATTLEFIELD_ABILITY_DISCOUNT = 1;

/**
 * The two battlefields that discount an ACTIVATED ability by what its source is
 * or where it stands.
 *
 * Applied inside `activationCostFor`, which is the ONE function the enumerator,
 * the validator, `canPayActivationCost` and the executor all price through — a
 * discount visible to only some of them is this codebase's offered-then-refused
 * bug, and the reason neither card gets its own path.
 */
function battlefieldAbilityDiscount(
  state: GameState,
  playerIndex: 0 | 1,
  abilityDefId: string,
  cost: ActivationCost,
  sourceInstanceId: string | undefined,
): ActivationCost {
  if (sourceInstanceId === undefined) return cost;
  const owner = state.players[playerIndex];

  // **Risen Altar** — "[Empower] costs of YOUR units HERE cost [1 Energy] or
  // [1 rainbow] less."
  //
  // "An [Empower] cost" is identified by the ability being the GENERATED one:
  // `empowerAbilities` keys those by the card's own defId, so a card with an
  // `empowerCost` whose ability is being activated under that same id is one.
  // Nothing else in the pool can produce that pairing.
  const empowering = defaultCardRegistry().tryGet(canonicalDefId(abilityDefId))?.empowerCost !== undefined;
  if (empowering) {
    const atAltar = state.battlefields.some(
      (bf) => bf.defId === RISEN_ALTAR && (bf.units[owner.id] ?? []).some((u) => u.instanceId === sourceInstanceId),
    );
    if (atAltar) return reduceByOne(cost);
  }

  // **Piltovan Forge** — "while you CONTROL this battlefield, the FIRST friendly
  // GEAR activated ability played each turn costs [1 Energy] less."
  //
  // Controller-scoped and game-wide, like Ornn's Forge which it is the ability
  // twin of — the gear activates from a base, not from this battlefield, so this
  // is not positional. "The first ... each turn" is why
  // `PlayerState.gearAbilitiesActivatedThisTurn` exists: the discount is a fact
  // about how many have already gone, not about the gear.
  const isFriendlyGear = owner.activeGear.some((g) => g.instanceId === sourceInstanceId);
  const controlsForge = state.battlefields.some((bf) => bf.defId === PILTOVAN_FORGE && bf.controllerId === owner.id);
  if (isFriendlyGear && controlsForge && owner.gearAbilitiesActivatedThisTurn === 0) {
    return cost.energy === undefined
      ? cost
      : { ...cost, energy: Math.max(0, cost.energy - BATTLEFIELD_ABILITY_DISCOUNT) };
  }
  return cost;
}

/**
 * Risen Altar's "[1 Energy] OR [1 rainbow] less", taken as ENERGY FIRST.
 *
 * **A simplification, and named as one.** The card offers a choice between two
 * reductions, and this engine takes the Energy whenever there is Energy to take.
 * That is right whenever only one of the two is present — which is every printed
 * `[Empower]` cost in the pool bar none — and it takes the choice away only for a
 * cost carrying BOTH, of which there are currently none. Recorded in
 * docs/rules-conformance.md; fixable by generating two modes the way an
 * ALTERNATIVE Empower cost already does (827.1.c.2).
 */
function reduceByOne(cost: ActivationCost): ActivationCost {
  if (cost.energy !== undefined && cost.energy > 0) {
    return { ...cost, energy: cost.energy - BATTLEFIELD_ABILITY_DISCOUNT };
  }
  if (cost.power !== undefined && cost.power.count > 0) {
    const count = cost.power.count - BATTLEFIELD_ABILITY_DISCOUNT;
    if (count > 0) return { ...cost, power: { ...cost.power, count } };
    // DELETED rather than set to undefined — `exactOptionalPropertyTypes` is on,
    // and an absent `power` is what "this cost has no Power term" means to every
    // reader of it.
    const { power: _spent, ...rest } = cost;
    return rest;
  }
  return cost;
}

/** Is this unit standing at a Gardens of Becoming? Either side — the card names
 *  no owner. */
function standsAtGardensOfBecoming(state: GameState, unitInstanceId: string): boolean {
  return state.battlefields.some(
    (bf) =>
      bf.defId === GARDENS_OF_BECOMING &&
      Object.values(bf.units).some((units) => units.some((u) => u.instanceId === unitInstanceId)),
  );
}

export function abilitiesAvailableTo(
  state: GameState,
  playerIndex: 0 | 1,
  /** `attachedToInstanceId` is read only for Svellsongur's copied text; every
   *  caller that has the real instance passes it, and a bare `{ defId }` simply
   *  copies nothing. `grantedAbilitiesThisTurn` is Dominus' grant, read off the
   *  live instance for the same reason — a caller holding only a defId has no
   *  grant to report, and a unit is the only thing that can carry one. */
  source: {
    defId: string;
    attachedToInstanceId?: string | null;
    grantedAbilitiesThisTurn?: readonly string[];
    /** WHICH instance — needed only by Gardens of Becoming, whose grant is
     *  positional ("units HERE"). Optional for the same reason
     *  `attachedToInstanceId` is: a caller holding only a defId has no location
     *  and gets no positional grant. All four real callers pass a live permanent. */
    instanceId?: string;
  },
): { abilityDefId: string; definition: ActivatedAbilityDefinition }[] {
  if (source.defId === HEIMERDINGER_INVENTOR) {
    const actor = state.players[playerIndex];
    const friendly = [
      actor.legend,
      ...actor.baseUnits,
      ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
      ...actor.activeGear,
    ];
    // Deduplicated: two copies of the same gear grant one ability, not two
    // identical entries the board would render twice.
    const defIds = [...new Set(friendly.map((c) => c.defId).filter((defId) => defId in allActivatedAbilities()))];
    return defIds.map((abilityDefId) => ({ abilityDefId, definition: allActivatedAbilities()[abilityDefId]! }));
  }
  // Svellsongur's copied text — "copy that unit's text to this Equipment's effect
  // text". An activated ability IS text, so the gear offers its wearer's.
  //
  // Offered rather than replaced: the gear keeps whatever it prints (nothing, for
  // this one), and the copy is a second entry — the same shape Forge of the
  // Fluft's grant takes below. That is also what makes it a DOUBLING at the only
  // level an activation can be doubled: the ability exhausts the GEAR rather than
  // the unit, so a wearer and its Svellsongur can each pay once.
  const copiedFrom = copiedTextSourceFor(state, source);
  const copied: { abilityDefId: string; definition: ActivatedAbilityDefinition }[] = [];
  if (copiedFrom !== undefined) {
    const wearerAbility = allActivatedAbilities()[copiedFrom.unit.defId];
    if (wearerAbility) copied.push({ abilityDefId: copiedFrom.unit.defId, definition: wearerAbility });
  }
  // **434.1.e — an ATTACHED card's printed Rules Text is Inactive** "for as long
  // as they remain Attached", so an Equipment already on a unit does not offer
  // its own printed ability, and the generated `[Equip]` is exactly that ability
  // (818.1.c.2, "[Cost]: Attach this gear to a unit you control").
  //
  // **Reported from playtesting**: "you should not be able to move around an
  // equipment that is attached to a unit. once it is attached an effect can only
  // be used to move it, not the equip cost." That is the rule, and 821.1.c is the
  // exception that proves it — Vanguard Armory has to say "necessary portions of
  // its Rules Text are NO LONGER INACTIVE if they are currently Inactive" before
  // it can re-pay an attached gear's Equip cost.
  //
  // The engine also offered a re-attach to the unit the gear was ALREADY on,
  // which 434.1.g/h make a no-op — a play that costs Energy and does nothing.
  //
  // **`own` only**, deliberately. 434.1.e names "those cards' printed Rules
  // Text"; the COPIED text above is Svellsongur's, which 434.1.c appends to the
  // Top-Most card and which only exists WHILE attached, and the grants below
  // belong to other cards entirely.
  //
  // **The gate is on being ATTACHED, not on having `[Equip]`**, which is what
  // 718.2 says — any attached card's printed Rules Text is Inactive. So a gear
  // attached by something else (821.1.c.1 lets Weaponmaster choose an Equipment
  // "whether it has an Equip ability or not") loses its own exhaust ability too,
  // and that is correct rather than incidental.
  //
  // Measured before narrowing: of the 50 cards in the pool whose TEXT prints
  // `[Equip]`, none prints a second activated ability, so for those this changes
  // the one ability and nothing else. That measurement does NOT bound the gate —
  // see the paragraph above — and saying it did was the first version of this
  // comment.
  const attached = source.attachedToInstanceId !== undefined && source.attachedToInstanceId !== null;
  const own = attached ? undefined : allActivatedAbilities()[source.defId];
  const granted: { abilityDefId: string; definition: ActivatedAbilityDefinition }[] = [...copied];
  // Forge of the Fluft — "while you control this battlefield, friendly LEGENDS
  // have ...". Offered here rather than by a new registry for the reason
  // Heimerdinger is: this function is the single answer to "what can this source
  // activate", and the enumerator, the validator and the executor all come
  // through it. A parallel path would be a fourth place to keep in step.
  if (source.defId === state.players[playerIndex].legend.defId && controlsForgeOfTheFluft(state, playerIndex)) {
    granted.push({ abilityDefId: FORGE_OF_THE_FLUFT, definition: allActivatedAbilities()[FORGE_OF_THE_FLUFT]! });
  }
  // Gardens of Becoming — "units HERE have '[Exhaust]: Gain 1 XP'". Positional
  // rather than controller-scoped, and offered to BOTH sides: the card names no
  // owner, like every other unqualified battlefield ability.
  if (source.instanceId !== undefined && standsAtGardensOfBecoming(state, source.instanceId)) {
    granted.push({ abilityDefId: GARDENS_OF_BECOMING, definition: allActivatedAbilities()[GARDENS_OF_BECOMING]! });
  }
  // Jayce - Defender of Tomorrow's two READY abilities. His own defId is taken by
  // the generated `[Empower]`, so they carry suffixed keys and are offered here —
  // the same shape Forge of the Fluft's grant takes directly above, and for the
  // reason its note gives: this function is the single answer to "what can this
  // source activate", so a parallel path would be a fourth place to keep in step.
  //
  // The Empowered one is gated on the LEGEND's own status (828.1.c). Read off the
  // legend rather than passed in, because `source` carries only a defId — and for
  // a Legend that is exact, since a player has exactly one.
  if (source.defId === JAYCE_DEFENDER && source.defId === state.players[playerIndex].legend.defId) {
    granted.push({ abilityDefId: JAYCE_READY, definition: allActivatedAbilities()[JAYCE_READY]! });
    if (state.players[playerIndex].legend.empowered === true) {
      granted.push({ abilityDefId: JAYCE_READY_EMPOWERED, definition: allActivatedAbilities()[JAYCE_READY_EMPOWERED]! });
    }
  }
  // Dominus' "give it '[rainbow][rainbow]: Ready me'" — an ability GRANTED to
  // this unit for the turn, offered here for the reason Forge of the Fluft's
  // note above gives: this function is the single answer to "what can this
  // source activate", so a second path would be a fifth place to keep in step.
  //
  // Read off the instance rather than looked up by id, so a stale copy cannot
  // disagree with the board — every caller passes the live object.
  //
  // Appended to whatever the unit already prints rather than replacing it: a
  // Dominus on a unit with its own ability leaves the printed one usable, which
  // is what "give it" means. `resolveActivation` picks between them by
  // `viaAbilityDefId`, so the two are separately addressable actions.
  for (const abilityDefId of source.grantedAbilitiesThisTurn ?? []) {
    const definition = allActivatedAbilities()[abilityDefId];
    if (definition) granted.push({ abilityDefId, definition });
  }
  return own ? [{ abilityDefId: source.defId, definition: own }, ...granted] : granted;
}

/** Does this player CONTROL a Forge of the Fluft right now? Controller-scoped
 *  rather than positional — the ability is about the Legend, who is in no
 *  location at all, so `at()` has nothing to be asked about. */
function controlsForgeOfTheFluft(state: GameState, playerIndex: 0 | 1): boolean {
  const playerId = state.players[playerIndex]?.id;
  return playerId !== undefined && state.battlefields.some((bf) => bf.controllerId === playerId && bf.defId === FORGE_OF_THE_FLUFT);
}

/** Does this card offer anything to activate — its own ability or borrowed ones? */
export function hasAnyActivatableAbility(state: GameState, playerIndex: 0 | 1, source: { defId: string }): boolean {
  return abilitiesAvailableTo(state, playerIndex, source).length > 0;
}

/**
 * The source and ability one ActivateAbility action names, or undefined if the
 * pairing is not real.
 *
 * The single answer to "what is this action actually doing", shared by the
 * validator, the executor and the enumerator — the three places that have drifted
 * apart before in exactly this codebase.
 */
export function resolveActivation(
  state: GameState,
  playerIndex: 0 | 1,
  permanentInstanceId: string,
  viaAbilityDefId?: string,
): { card: UnitInstance | GearInstance | LegendInstance; abilityDefId: string; definition: ActivatedAbilityDefinition } | undefined {
  const actor = state.players[playerIndex];
  const source = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    actor.legend,
  ].find((c) => c.instanceId === permanentInstanceId);
  if (!source) return undefined;

  const available = abilitiesAvailableTo(state, playerIndex, source);
  const chosen = viaAbilityDefId === undefined ? available[0] : available.find((a) => a.abilityDefId === viaAbilityDefId);
  // A borrowed ability must still be one this source really offers — naming an
  // arbitrary defId must not let anyone activate a card they do not control.
  if (!chosen) return undefined;
  return { card: source, ...chosen };
}

/** For coverage.ts — Heimerdinger's whole printed text is implemented by the
 *  borrowing above, and he appears in no ability registry of his own. */
export function borrowedAbilityDefIds(): string[] {
  return [HEIMERDINGER_INVENTOR];
}

/** The synthetic id a non-modal ability's single mode carries. Never appears on
 *  an action, since enumeration omits `modeId` when there is only one. */
const SOLE_MODE = "";

/**
 * Every ability, as a list of modes.
 *
 * A plain ability becomes one unnamed mode built from its own targeting and
 * resolve, so enumeration, validation and execution never branch on "is this
 * modal" — they were three places that would each have needed the same new
 * branch, and three places is how a mechanic ends up working in two of them.
 */
export function modesOf(abilityDefId: string): readonly AbilityMode[] {
  const definition = allActivatedAbilities()[abilityDefId];
  if (!definition) return [];
  if (definition.modes) return definition.modes;
  if (!definition.resolve) return [];
  return [
    {
      id: SOLE_MODE,
      label: "",
      targeting: definition.targeting ?? { kind: "none" },
      ...(definition.attachesEquipment ? { attachesEquipment: definition.attachesEquipment } : {}),
      ...(definition.attachesFromTargetToSelf ? { attachesFromTargetToSelf: definition.attachesFromTargetToSelf } : {}),
      ...(definition.movesTargetToCostPayer ? { movesTargetToCostPayer: definition.movesTargetToCostPayer } : {}),
      resolve: definition.resolve,
    },
  ];
}

/** The modes still available to `source` right now — all of them, unless the
 *  ability is "one you've not chosen this turn". */
export function availableModes(
  abilityDefId: string,
  /** Only a Unit carries the per-turn record — a Legend or Gear simply has none
   *  to spend, which reads as "nothing used yet" and is correct: no modal
   *  ability in this pool sits on either. */
  source: { abilityModesUsedThisTurn?: string[] } | object,
): readonly AbilityMode[] {
  const modes = modesOf(abilityDefId);
  if (!allActivatedAbilities()[abilityDefId]?.modesOncePerTurn) return modes;
  const used = new Set("abilityModesUsedThisTurn" in source ? (source.abilityModesUsedThisTurn ?? []) : []);
  return modes.filter((m) => !used.has(m.id));
}

/** The mode an action names, checked against what is actually still available. */
export function resolveMode(
  abilityDefId: string,
  source: { abilityModesUsedThisTurn?: string[] } | object,
  modeId: string | undefined,
): AbilityMode | undefined {
  const available = availableModes(abilityDefId, source);
  return modeId === undefined ? available.find((m) => m.id === SOLE_MODE) : available.find((m) => m.id === modeId);
}

/** Does this ability track its modes per turn? */
export function tracksModeUse(abilityDefId: string): boolean {
  return allActivatedAbilities()[abilityDefId]?.modesOncePerTurn === true;
}

/** Records that `modeId` has been used, so "you've not chosen this turn" holds.
 *
 *  Re-exported from `effect-helpers.ts`, which is where it moved when Aphelios -
 *  Exalted needed it from a TRIGGER: `effects/calm.ts` importing THIS module
 *  closed a cycle that left `[GOLD_TOKEN_DEF_ID]` evaluating to `undefined` and
 *  registered the Gold token's ability under the key "undefined". Kept exported
 *  here so `execute-activate-ability`'s import is unchanged. */
export { recordModeUsed } from "./effect-helpers.js";
