import type { CardInstance } from "../model/card.js";
import type { RepeatChoices } from "../model/game-state.js";

export type { RepeatChoices };

/**
 * A rune payment: which specific channeled runes (by id) cover a cost's
 * Energy and Power portions. Mirrors engine/RunePayment.java.
 */
export interface RunePayment {
  energyRunes: string[];
  powerRunes: string[];
  /**
   * Runes recycled for a RAINBOW Power surcharge — `[Deflect N]`'s "opponents
   * must pay N rainbow Power to choose me with a spell or ability".
   *
   * A third bucket rather than more entries in `powerRunes`, because the two are
   * validated differently: `validate-play-card` requires every id in
   * `powerRunes` to match the CARD's own `powerDomain`, and a rainbow surcharge
   * is by definition any-domain. Folding them together would trip that check on
   * every off-domain rune, which is exactly why this could not simply reuse the
   * existing bucket.
   *
   * Optional so that every existing producer and every stored action stays valid
   * — a card whose targets carry no `[Deflect]` never mentions it.
   */
  rainbowRunes?: string[];
}

export interface PlayCardAction {
  type: "PlayCard";
  playerIndex: 0 | 1;
  card: CardInstance;
  payment: RunePayment;
  /** The unit instance this card's effect targets, if it has one (e.g. a
   *  damage/destroy Spell), OR — for a Unit card — the target its own
   *  on-play trigger needs (e.g. First Mate's "ready another unit"). Only
   *  meaningful when the card's registered effect/trigger has a "unit"-kind
   *  TargetingSpec — see engine/card-effects.ts / engine/unit-triggers.ts. */
  targetUnitInstanceId?: string;
  /** The second target of a "unitPair"-kind effect (Gentlemen's Duel only)
   *  — targetUnitInstanceId above is the pair's first target. */
  secondTargetUnitInstanceId?: string;
  /** The ordered targets of a `unitList`-kind spec — Falling Star's two,
   *  Icathian Rain's six, Fox-Fire's any number. Ordered and possibly repeating;
   *  see TargetingSpec's `unitList` and ResolveEvent's matching field. */
  targetUnitInstanceIds?: readonly string[];
  /** The SPELL on the chain a `chainSpell`-kind spec named (Wind Wall, Defy,
   *  Mystic Reversal) — by the card's instanceId, since the chain moves between
   *  announcing and resolving and an index would come to mean something else. */
  targetChainCardInstanceId?: string;
  /** The battlefield a "battlefield"-kind targeted effect applies to (e.g.
   *  Firestorm's "all enemy units at a battlefield"). */
  targetBattlefieldId?: string;
  /** The caster's own trash card an "ownTrashCard"-kind effect returns
   *  (Morbid Return, Annie-Stubborn's on-play trigger). */
  trashCardInstanceId?: string;
  /** The friendly unit (base or battlefield) exhausted as an optional
   *  additional cost (Meditation only) — absent means the caster declined
   *  it. See card-effects.ts's cardHasOptionalExhaustCost. */
  additionalCostUnitInstanceId?: string;
  /** The units spent for a REPEATABLE additional cost (Kraken Hunter's buffs,
   *  Commander Ledros' kills). A list rather than more of the single field
   *  above, so nothing that reads "the one unit this cost named" can be handed
   *  four of them. */
  additionalCostUnitInstanceIds?: readonly string[];
  /**
   * The friendly GEAR spent for an additional cost — Zaun Punk's kill, Legion
   * Quartermaster's return-to-hand.
   *
   * Its own field rather than the unit one above, because a gear is not a unit
   * and must never reach a reader expecting one — the same separation
   * `targetPermanentInstanceId` already keeps for targets. `costNamesGear` says
   * which field a given cost rides on, and the enumerator and both validators
   * ask it rather than each deciding.
   */
  additionalCostPermanentInstanceId?: string;
  /** For a Unit card only: deploy directly to this battlefield instead of
   *  base. Legal only when the acting player already has a unit of their
   *  own there — mirrors ActionValidator.validateUnitDirectToBattlefield's
   *  universal (exception-free) rule, `Battlefield.hasUnitsFor(actor)`. */
  destinationBattlefieldId?: string;
  /** Only meaningful for a Unit with the Vision on-play trigger (Mystic
   *  Poro, Sai Scout): whether the caster chose to recycle the revealed
   *  top card (send it to the bottom of the deck) rather than keep it on
   *  top. Fanned into two distinct legal actions by legal-actions.ts, since
   *  this engine can't pause mid-resolution to ask — the choice must
   *  already be decided in the submitted action. */
  visionRecycle?: boolean;
  /**
   * Set when this card is being played FROM a facedown state at that
   * battlefield (rule 811). Three things follow, none of which are true of an
   * ordinary play: the base cost is ignored entirely, the card counts as
   * `[Reaction]` however it is printed, and every target must be chosen from
   * among options at THAT battlefield.
   */
  fromHiddenBattlefieldId?: string;
  /**
   * `[Accelerate]` (rule 805): the caster chose to pay the optional additional
   * cost, so this unit enters READY. A boolean choice decided in the action
   * rather than asked mid-resolution, exactly like `visionRecycle` — and like
   * that one, enumerated as two distinct candidates.
   *
   * When set, `payment` covers the card's own cost PLUS 1 Energy and 1 Power.
   */
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the unchosen multi-discards (Jinx, Undercover Agent's Deathknell)
   *  go through discardCards' front-of-hand convention instead. */
  discardCardInstanceId?: string;
  /** The unit OR gear named by a `unitOrGear`-kind targeting spec (Fading
   *  Memories). Separate from `targetUnitInstanceId` because a gear is not a
   *  unit and must never reach a reader expecting one. */
  targetPermanentInstanceId?: string;
  acceleratePaid?: true;
  /** Clockwork Keeper's "you may pay [1 Calm] as an additional cost to play me" —
   *  whether the caster took the option. Its OWN field rather than
   *  `acceleratePaid`, which additionally means "enters ready". */
  optionalPowerPaid?: true;
  /**
   * Which axis a TARGET-KEYED discount was taken on — Irelia - Graceful's "your
   * spells that choose me cost [1] **or** [rainbow] less".
   *
   * On the action rather than inferred, because the "or" is a real choice and
   * neither default is safe: a caster short of Energy wants the Energy pip, one
   * short of runes wants the Power pip, and picking for them would silently
   * refuse plays that are legal. The enumerator fans out both.
   *
   * Its OWN field rather than a second meaning for `optionalPowerPaid`, which
   * prices a cost the caster ADDS; this one removes one.
   */
  targetDiscountAxis?: "energy" | "power";
  /** Bullet Time's "pay ANY AMOUNT of rainbow Power to deal that much damage" —
   *  the X the caster chose. Carried explicitly rather than derived from
   *  `payment.rainbowRunes.length`, because that bucket also holds a [Deflect]
   *  surcharge and the two must never be confused for one another. */
  xAmount?: number;
  /**
   * `[Repeat]` (820.1): the caster paid the optional additional cost as they
   * played this, so its instructions run one additional time at resolution.
   *
   * Its OWN flag rather than `optionalPowerPaid`, which prices a single named
   * Power pip and means nothing at resolution — this one is the opposite, a cost
   * of mixed Energy/Power/rainbow whose entire point is what happens when the
   * spell resolves. When set, `payment` covers the card's own cost PLUS
   * `repeatCostOf(defId)`.
   */
  repeatPaid?: true;
  /**
   * The GRANTED `[Repeat]` instance was paid — Temporal Portal's "give the next
   * spell you play this turn [Repeat] equal to its cost".
   *
   * Its own field rather than a second `repeatPaid`, because 3509 makes the two
   * instances independently payable: a Rocket Barrage under a Portal can pay its
   * printed Repeat, the granted one, both, or neither, and those are four
   * different prices and three different execution counts.
   */
  grantedRepeatPaid?: true;
  /**
   * The targets for `[Repeat]`'s SECOND execution — 820.1.d's "choices made for
   * the additional execution do not have to be the same as the choices made for
   * the initial execution", made "at the usual time" and so carried on the
   * announcement like every other target here.
   *
   * Only meaningful with `repeatPaid`. Omitting it with `repeatPaid` set means
   * "make the same choices again" — legal, and what the enumerator samples; see
   * legal-actions.ts for why the sampler stops there while the validator below
   * accepts any legal second set.
   */
  repeatChoices?: RepeatChoices;
  /**
   * Which option of a MODAL card this play chooses — Rocket Barrage's "Choose
   * one — Deal 4 to a unit in a base. [or] Kill a gear."
   *
   * Named `modeId` to match `ActivateAbilityAction`'s field of the same name and
   * meaning; the two are the same question asked of a card and of an ability,
   * and `cardModesOf`/`modesOf` normalise both the same way.
   *
   * Absent for every ordinary card — a single unnamed mode needs no naming, and
   * enumeration omits it — so no existing action changes shape.
   */
  modeId?: string;
}

/**
 * Hide a card facedown at a battlefield you control — rule 811's Discretionary
 * Action, NOT a play. It opens no chain and does not pay the card's own cost;
 * the price is a flat 1 rainbow Power (`payment`, whose energyRunes are always
 * empty) plus the fact that losing the battlefield loses the card.
 */
export interface HideCardAction {
  type: "HideCard";
  playerIndex: 0 | 1;
  card: CardInstance;
  battlefieldId: string;
  payment: RunePayment;
}

export interface PassAction {
  type: "Pass";
  playerIndex: 0 | 1;
}

/**
 * Moves one or more units (base -> battlefield, or battlefield ->
 * battlefield if [Ganking]) to `destinationBattlefieldId` in one action.
 * Mirrors PlayerAction.MoveUnit (engine/PlayerAction.java) — Java's variant
 * also carries a `payment` for the Mageseeker Investigator rainbow-Power
 * surcharge, a single named card's cost not modeled here.
 */
export interface MoveUnitAction {
  type: "MoveUnit";
  playerIndex: 0 | 1;
  unitInstanceIds: string[];
  destinationBattlefieldId: string;
}

/**
 * Moves one or more units from a battlefield back to base. Mirrors
 * PlayerAction.RecallUnit (engine/PlayerAction.java) — Java's variant is
 * just the unit list, no destination (there's only one base to return to).
 */
export interface RecallUnitAction {
  type: "RecallUnit";
  playerIndex: 0 | 1;
  unitInstanceIds: string[];
}

/**
 * Passes Focus/chain priority while a Showdown is open (engine/GameEngine.java's
 * PassFocus, handlePassFocus). Distinct from Pass: Pass ends the whole turn
 * and is illegal during an open Showdown; PassFocus only passes the
 * initiative within it. Two consecutive PassFocus actions resolve combat —
 * see execute-pass-focus.ts.
 */
export interface PassFocusAction {
  type: "PassFocus";
  playerIndex: 0 | 1;
}

/**
 * Taps a channeled rune directly into the player's floating pool,
 * independent of casting or activating anything — the real rule
 * (confirmed against both the official Core Rules and
 * engine/PlayerAction.java:164-173's `FloatRune(RuneCard rune, boolean
 * forPower)`): exhaust a Ready rune for 1 floating Energy (`forPower:
 * false`), or recycle a rune (Ready or Exhausted) for 1 floating Power of
 * its domain (`forPower: true`). Unlike Java's implicit owner-scan, this
 * carries an explicit `playerIndex` and an id (not an object reference),
 * matching every other action in this file.
 */
export interface FloatRuneAction {
  type: "FloatRune";
  playerIndex: 0 | 1;
  runeId: string;
  forPower: boolean;
}

/**
 * Activates a unit's own printed activated ability — narrowly scoped to
 * Lux-Crownguard's "Exhaust: Add 2 restricted Energy" for now (the only
 * activated ability in this card pool), mirroring engine/PlayerAction.java's
 * `ActivateUnit(Card.Unit unit, Card.Unit target, RunePayment payment,
 * String viaAbility)` shape, minus the target/payment fields no in-scope
 * ability needs yet (add them the day a card that does is implemented,
 * rather than speculatively).
 */
export interface ActivateAbilityAction {
  type: "ActivateAbility";
  playerIndex: 0 | 1;
  /** The permanent being activated. Named `permanentInstanceId`, not
   *  `unitInstanceId`, because Gear activates the same way and through the same
   *  action — 20 of the 30 Gear in this pool are "exhaust: do one thing", and
   *  while the field said "unit" they were unreachable. */
  permanentInstanceId: string;
  /** Chosen before submitting, like every other target in this engine — see
   *  card-effects.ts's TargetingSpec doc comment. Absent for abilities whose
   *  targeting is "none". */
  targetUnitInstanceId?: string;
  /**
   * Where the targeted unit is being moved TO — Yasuo - Unforgiven's "move a
   * friendly unit ... from its base", which names a unit and a destination.
   *
   * The same field, chosen the same way, that a Charm-style Spell already
   * carries on PlayCardAction: fanned out per battlefield during enumeration,
   * because this engine cannot pause mid-resolution to ask. Absent for every
   * ability whose mode does not move anything.
   */
  destinationBattlefieldId?: string;
  /**
   * Which runes cover an Energy portion of the activation cost. Absent for the
   * abilities that cost only an exhaust — which was every one of them until the
   * preset Legends arrived reading ":rb_energy_1:, :rb_exhaust::".
   *
   * The Java shape quoted above already had it, for the same reason: an exhaust
   * and a Recycle can be paid from state alone, but WHICH runes go is a choice
   * and has to ride on the action.
   */
  payment?: RunePayment;
  /**
   * The defId of the ability being used, when it is not the source's own —
   * Heimerdinger - Inventor "has all exhaust abilities of all friendly legends,
   * units, and gear", so `permanentInstanceId` names HIM and this names whose
   * ability he is using. Java calls the same field `viaAbility`.
   *
   * Absent for every ordinary activation, where the source and the ability are
   * the same card.
   */
  viaAbilityDefId?: string;
  /**
   * Which option of a MODAL ability this activates — Udyr - Wildman's "Choose one
   * you've not chosen this turn". Absent for every other ability, which has one
   * unnamed mode, so an ordinary activation's action is unchanged.
   */
  modeId?: string;
  /**
   * The X an X-cost ABILITY was activated for — Hextech Anomaly's and Ancient
   * Henge's "pay any amount".
   *
   * The same field, meaning the same thing, that `PlayCardAction` already
   * carries for Bullet Time; carried explicitly rather than counted off the
   * payment for the reason that one records, since the rainbow bucket also
   * holds a `[Deflect]` surcharge.
   */
  xAmount?: number;
  /** The unit OR gear an ability's `unitOrGear`-kind spec named (Pack of
   *  Wonders). Separate from `targetUnitInstanceId` for the same reason a Spell's
   *  is: a gear is not a unit and must never reach a reader expecting one. */
  targetPermanentInstanceId?: string;
  /**
   * The friendly permanent killed to PAY for the ability — Malzahar - Fanatic's
   * "Kill a friendly unit or gear, Exhaust:".
   *
   * Deliberately not `targetPermanentInstanceId` above, which names what the
   * ability DOES something to. These are two different questions that a modal
   * card could one day ask at once, and a cost paid by killing what you were
   * also targeting is a different line from either.
   */
  costPermanentInstanceId?: string;
  /** The card discarded to PAY for the ability — Unlicensed Armory's
   *  "Discard 1, Exhaust:". Separate from `discardCardInstanceId`-style effect
   *  fields for the reason above: cost and effect are different questions. */
  costDiscardCardInstanceId?: string;
}

/**
 * Answers the question the engine has stopped to ask — see engine/decisions.ts.
 *
 * ONE action type for every question, which is the difference between this and
 * the Java oracle's four (ResolvePendingChoice, ChooseDiscard,
 * ResolveVayneBounce, ResolveRepeatChoice, all listed below in the very comment
 * describing what to port). Each of those needed its own validator branch, its
 * own AI branch and its own "who acts now" case; one type needs one of each,
 * forever.
 *
 * `decisionId` rather than "the current one": an answer aimed at a question that
 * has already been resolved must not silently apply to whatever took its place.
 */
export interface AnswerDecisionAction {
  type: "AnswerDecision";
  playerIndex: 0 | 1;
  decisionId: string;
  /** Names one of `decisions.optionsFor(state, decision)`, which are rebuilt
   *  from live state rather than stored — so this is checked, not trusted. */
  optionId: string;
}

/**
 * The player-submittable actions implemented so far. Mirrors a subset of
 * engine/PlayerAction.java's 17-variant sealed interface (PlayCard, MoveUnit,
 * RecallUnit, ActivateGear, ActivateUnit, FloatRune, PassFocus, Pass,
 * AssignDamage, ChooseTrashSpell, ChooseDiscard, ResolveVayneBounce,
 * ResolvePendingChoice, ActivateLegend, HideCard, RevealHiddenCard,
 * EquipGear, ResolveRepeatChoice) — the rest get added here as each one's
 * validate/execute pair is actually implemented (M1's turn/priority
 * skeleton), not stubbed out ahead of that logic.
 */
export type PlayerAction =
  | PlayCardAction
  | HideCardAction
  | PassAction
  | MoveUnitAction
  | RecallUnitAction
  | PassFocusAction
  | FloatRuneAction
  | ActivateAbilityAction
  | AnswerDecisionAction;
