import type { Domain } from "./domain.js";
import type { CardInstance, GearInstance, LegendInstance, SpellInstance, UnitInstance } from "./card.js";
import type { RuneCard } from "./rune.js";
import type { Phase, TurnState } from "./phase.js";

/** One pending Spell resolution on the chain. Mirrors GameState.java's
 *  `record ChainEntry(PlayerAction.PlayCard action, Player caster)`, trimmed
 *  to just what's needed since our PlayCardAction already carries the card.
 *
 *  `kind` is OPTIONAL here and required on TriggerChainEntry below, which is
 *  deliberate and is NOT the same judgement as `cardPlayed`'s required
 *  `playedKind`. There, omitting a field would silently produce WRONG behaviour,
 *  so the compiler had to name every producer. Here, an entry with no
 *  discriminant is unambiguously a Spell — `card: SpellInstance` is required on
 *  this shape and absent from the other — and omission reproduces exactly the
 *  behaviour that exists today. Making it required would churn a dozen test
 *  literals to assert something the type system already knows. */
/**
 * The targets chosen for `[Repeat]`'s SECOND execution (rule 820.1.d).
 *
 * **A separate choice set, not a flag.** The engine's own note on this keyword
 * said all a repeat needed was "a flag on the chain entry, and a second
 * `effect.resolve` call" — which would have silently re-run the first
 * execution's targets. 820.1.d is explicit that it does not work that way:
 *
 *   "When a spell or ability's effect is performed an additional time with
 *   Repeat, choices must be made at the usual time during the Make Relevant
 *   Choices step of Playing a Card. **Choices made for the additional execution
 *   do not have to be the same as the choices made for the initial
 *   execution.**"
 *
 * Rocket Barrage prints the point in its own reminder text — "(You may pay the
 * additional cost to repeat this spell's effect, **and may make different
 * choices**.)" — and the rulebook's worked example for it turns on choosing two
 * DIFFERENT gear and naming which dies first.
 *
 * "At the usual time" is what makes this a field on the announcement rather than
 * a question asked mid-resolution: both choice sets are fixed when the spell is
 * played, exactly like every other target in this engine.
 *
 * Structurally a subset of engine/card-effects.ts's `ResolveEvent` — the fields
 * a repeat execution can actually vary across the fourteen cards. Declared here
 * rather than imported from there to keep `model/` free of an import from
 * `engine/`, the same split `TriggerChainEntry.event` makes.
 */
export interface RepeatChoices {
  targetUnitInstanceId?: string;
  secondTargetUnitInstanceId?: string;
  targetUnitInstanceIds?: readonly string[];
  targetBattlefieldId?: string;
  targetChainCardInstanceId?: string;
  /** Temptation's "move an enemy unit to a location where..." — the second move
   *  may pick a different destination as well as a different unit. */
  destinationBattlefieldId?: string;
  /** …and that destination may be a BASE, independently of the first
   *  execution's. 355.4.a / 359.3.e; see `PlayCardAction.destinationIsBase`. */
  destinationIsBase?: true;
  /** The unit-or-gear a `unitOrGear` or `gear` spec names. Needed the moment a
   *  MODAL repeat could switch into a mode that targets one — Rocket Barrage
   *  going from "deal 4 to a unit in a base" to "kill a gear" has no unit to
   *  carry over and a gear to name instead. */
  targetPermanentInstanceId?: string;
  /**
   * Which MODE the additional execution chooses — Rocket Barrage's "Choose one".
   *
   * 820.1.d's worked example for that very card is explicit: *"they may choose
   * the same mode or a different one, and if they choose the same mode, may
   * choose the same target or a different one."* So the mode is part of the
   * second choice set, not a property of the play.
   */
  modeId?: string;
}

/**
 * One PAID instance of `[Repeat]`, and the choices ITS execution makes.
 *
 * # Why the instance is named rather than counted
 *
 * 820.1.c.2 — "if a spell or ability has more than one instance of Repeat, each
 * Cost may be paid or not paid individually" — and 820.1.c.3 — "each Repeat Cost
 * can be paid only a single time". UNL-182 Curtain Call prints three, at three
 * DIFFERENT prices (`[1]` / `[rainbow]` / `[1][rainbow]`), so "how many were
 * paid" does not price the play: paying the cheap one and paying the dear one buy
 * the same extra execution for different runes. `instance` indexes
 * `repeatCostsOf(defId)`, and the distinctness of those indices across a play is
 * 820.1.c.3 enforced by the validator rather than left as a convention.
 *
 * # And why the choices live HERE rather than in a parallel list
 *
 * 820.2 gives every additional execution its own Make Relevant Choices step, so
 * each has its own targets AND (820.2.a's Rocket Barrage example) its own mode.
 * A second list keyed by the same index is the shape this repo keeps paying for:
 * two fields each holding part of one truth drift apart the first time one of
 * them is filtered. One entry per execution carries the whole of it.
 *
 * `choices` absent means "the same choices again", exactly what an absent
 * `repeatChoices` has always meant — see `RepeatChoices`.
 */
export interface RepeatExecution {
  /** Which printed instance was paid — an index into `repeatCostsOf(defId)`. */
  instance: number;
  /** This execution's own choices (820.2). Absent means "the same again". */
  choices?: RepeatChoices;
}

/**
 * The `[Repeat]` executions a play bought, from whichever spelling it used.
 *
 * **`repeatExecutions` is the canonical field and this is its only reader.** The
 * pair below it — `repeatPaid` plus `repeatChoices` — is the ONE-INSTANCE
 * spelling every card in the pool but Curtain Call needs, and is exactly
 * equivalent to a single entry naming instance 0. Keeping it is not a second
 * source of truth: it is a strictly narrower way of writing the same list, it is
 * what the 26 `repeatPaid` readers and eleven test files already say, and the
 * validator refuses the two spellings together so a play can never be described
 * twice.
 *
 * Structural rather than typed on `PlayCardAction`, because a chain entry asks
 * this same question with the same three fields and `model/` must not import
 * `actions/`.
 */
export function repeatExecutionsOf(play: {
  repeatExecutions?: readonly RepeatExecution[];
  repeatPaid?: true;
  repeatChoices?: RepeatChoices;
}): readonly RepeatExecution[] {
  if (play.repeatExecutions !== undefined) return play.repeatExecutions;
  if (!play.repeatPaid) return [];
  return [{ instance: 0, ...(play.repeatChoices !== undefined ? { choices: play.repeatChoices } : {}) }];
}

export interface SpellChainEntry {
  kind?: "spell";
  playerIndex: 0 | 1;
  card: SpellInstance;
  /**
   * Whether this play paid its OPTIONAL POWER additional cost — Rampage's "as you
   * play this, you may pay [Body]".
   *
   * **The flag reached UNIT triggers and not SPELL resolvers until 2026-08-17**,
   * and `OPTIONAL_POWER_COSTS` is the reason nobody noticed: every card in that
   * table was a Unit, so `optionalPowerPaid` was threaded onto the unit-trigger
   * event and never onto the chain. A Spell reading it would have compiled
   * against `ResolveEvent`, been enumerated at two prices, and then resolved
   * identically at both — a card paying a cost for nothing.
   *
   * That is the same shipped-correct-and-INERT shape `OPTIONAL_POWER_COSTS`'
   * own notes record TWICE for Pyke and Nami, from the other direction: there
   * the trigger was written and the row was missing, here the row exists and the
   * carrier did not. Both make an enumerable choice that changes nothing.
   */
  optionalPowerPaid?: true;
  /**
   * The ENERGY actually spent to play this spell, after every discount — not
   * its printed cost.
   *
   * Added for Revna the Lorekeeper (UNL-005), "when you play a spell, if you
   * spent [N] or more...". The `spellCast` event carried `totalCost`, which is
   * the PRINTED Energy plus Power, and no reading of it can answer a question
   * about what was spent.
   *
   * **`maxSpellEnergySpentThisTurn` is not a substitute** and a wave-7 agent
   * measured why: it is a turn MAXIMUM, so a cheap spell cast after an expensive
   * one would satisfy a per-spell threshold it never met. That field answers
   * Prepared Neophyte's "have you spent [4] on a spell this turn"; this one
   * answers "did you spend [4] on THIS spell".
   *
   * Optional because a spell can reach the chain by paths that never priced it
   * (`playCardIgnoringCost`), and a card asking "did you spend N" should read
   * nothing rather than a fabricated zero.
   */
  energySpent?: number;
  /** Only meaningful when the resolved card's registered effect has a
   *  "unit"-kind TargetingSpec (see engine/card-effects.ts). */
  targetUnitInstanceId?: string;
  /** Only meaningful for a "unitPair"-kind TargetingSpec (Gentlemen's
   *  Duel) — targetUnitInstanceId above is the pair's first target. */
  secondTargetUnitInstanceId?: string;
  /** Only meaningful for a `unitList`-kind TargetingSpec (Falling Star,
   *  Icathian Rain, Fox-Fire). Ordered, possibly repeating, and chosen when
   *  the spell was ANNOUNCED — which is what lets a card read another chain
   *  item's target set while it waits here. */
  targetUnitInstanceIds?: readonly string[];
  /** Only meaningful for a `chainSpell`-kind TargetingSpec — the spell BELOW
   *  this one that it counters or takes control of. */
  targetChainCardInstanceId?: string;
  /** The X of an X-cost card, chosen when it was announced (Bullet Time). */
  xAmount?: number;
  /** Only meaningful for a "battlefield"-kind TargetingSpec. */
  targetBattlefieldId?: string;
  /** Only meaningful for an "ownTrashCard"-kind TargetingSpec. */
  trashCardInstanceId?: string;
  /** Only meaningful for a card with an optional exhaust-cost (Meditation)
   *  — see card-effects.ts's cardHasOptionalExhaustCost. */
  additionalCostUnitInstanceId?: string;
  /** The units spent for a REPEATABLE additional cost (Kraken Hunter's buffs,
   *  Commander Ledros' kills). A list rather than more of the single field
   *  above, so nothing that reads "the one unit this cost named" can be handed
   *  four of them. */
  additionalCostUnitInstanceIds?: readonly string[];
  /** Where a token-creating Spell deploys what it creates (Recruit the
   *  Vanguard); absent means base — see card-effects.ts's cardPlacesTokens. */
  destinationBattlefieldId?: string;
  /**
   * A move-target Spell is sending its unit to BASE — Charm reaching the one
   * Location `destinationBattlefieldId` cannot name (355.4.a, worked at 359.3.e).
   *
   * On the chain entry because the choice is made when the spell is PLAYED and
   * resolution must see the choice that was announced, exactly like every target
   * field beside it. For a token-placing Spell absent still means base; this is
   * the MOVE destination, which is mandatory and so needs to say so explicitly.
   */
  destinationIsBase?: true;
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the unchosen multi-discards (Jinx, Undercover Agent's Deathknell)
   *  go through discardCards' front-of-hand convention instead. */
  /** The unit OR gear named by a `unitOrGear`-kind targeting spec (Fading
   *  Memories). Separate from `targetUnitInstanceId` because a gear is not a
   *  unit and must never reach a reader expecting one. */
  targetPermanentInstanceId?: string;
  discardCardInstanceId?: string;
  /** `[Repeat]`'s additional cost was paid as this spell was announced (820.1.c.1),
   *  so its instructions run one additional time when it resolves (820.1.d). */
  repeatPaid?: true;
  /** The GRANTED `[Repeat]` instance was paid too — Temporal Portal's. A second
   *  named instance rather than a list; see `nextSpellRepeatGrants`. */
  grantedRepeatPaid?: true;
  /** The second execution's own targets — see RepeatChoices. Absent with
   *  `repeatPaid` set means "the same choices again", which is a legal thing to
   *  choose and is what the enumerator samples. */
  repeatChoices?: RepeatChoices;
  /** Every PAID printed `[Repeat]` instance and its own choices — the canonical
   *  carrier since 2026-08-14, read through `repeatExecutionsOf`. Absent on a
   *  play that used the one-instance spelling above, which is every card in the
   *  pool but Curtain Call. */
  repeatExecutions?: readonly RepeatExecution[];
  /** Which option a MODAL card chose (Rocket Barrage's "Choose one"). Absent for
   *  every ordinary card, whose single mode needs no naming. */
  modeId?: string;
}

/**
 * A triggered ability waiting on the chain — rule 808.1.d.3 / 323 step 3a's
 * **Pending Item**.
 *
 * The rules put a trigger on the Chain so the opponent may respond before it
 * resolves. This engine currently resolves every trigger IMMEDIATELY at its
 * source (14 `dispatch*` entry points across triggers.ts, unit-triggers.ts and
 * legend-abilities.ts), which is the largest recorded divergence in
 * docs/rules-conformance.md — an entire interaction layer is absent, because
 * nothing can ever be responded to.
 *
 * This type is the seam that work builds on, and it lands ahead of any dispatch
 * site being converted ON PURPOSE: the conversion is 14 sites that each change
 * observable ordering, and doing it in one step would make a termination
 * regression impossible to bisect. Nothing pushes one of these yet, so the
 * engine's behaviour is unchanged by its existence.
 *
 * `listenerInstanceId` rather than the listener object: by the time the entry
 * resolves the board may have moved on, and rule 808.1.d.3 is explicit that the
 * dying permanent's ATTRIBUTES are captured up front while its identity is
 * re-looked-up — the same split `triggers.DeathContext` already makes.
 */
export interface TriggerChainEntry {
  kind: "trigger";
  /** Whose trigger it is — the player who would get priority to respond, and
   *  the index the resolution runs under. */
  playerIndex: 0 | 1;
  /** The permanent whose ability this is, re-looked-up at resolution. */
  listenerInstanceId: string;
  /** Which card's registered trigger to run — kept alongside the instance id so
   *  resolution needs no board scan to know WHICH ability is pending. */
  listenerDefId: string;
  /** The listener's printed name, captured when the trigger fired.
   *
   *  Carried rather than looked up because the chain viewer has to name the item
   *  while it waits, and by then the source may be in a trash — a [Deathknell] is
   *  the common case, and it is precisely the one where a board lookup returns
   *  nothing. Same reasoning as `event` above: 808.1.d.3's "note its attributes
   *  before the card is moved to the Trash", applied to the one attribute the UI
   *  needs. */
  listenerName: string;
  /**
   * How many times this ability executes when it resolves — "your conquer
   * effects for conquering here trigger an additional time".
   *
   * Absent means once, which is every trigger in the pool but three. Kept on the
   * chain entry rather than re-derived at resolution because the doubling is a
   * fact about the board AT THE MOMENT OF THE EVENT (383): the Red Brambleback
   * that doubled it can be killed inside the response window, and the ability it
   * doubled still executes twice.
   *
   * **The same shape `HeldDeathknell.times` already had for Karthus - Eternal**,
   * who prints the identical sentence. Deliberately consistent with him rather
   * than more correct than him — see the divergence recorded in
   * docs/rules-conformance.md, which covers all three cards: 383.3 places ONE
   * chain item per trigger, so "triggers an additional time" should arguably be
   * two items with a response window between, and this is one item executed
   * twice. Two readings of one printed sentence would be worse than one wrong
   * reading applied consistently.
   */
  times?: number;
  /** Where the listener stood when the trigger fired. Positional triggers ("when
   *  I conquer", "here") read this rather than asking the board again, since the
   *  unit may have moved or died in between. */
  battlefieldId?: string;
  /**
   * The listening card as it was when the trigger fired.
   *
   * A Finalized Chain Item RESOLVES even if its source has left the board: 359.3
   * says a check on something no longer available returns "null" and calculations
   * based on it are ignored — the item is not removed. The only rules that remove
   * one are a replaced death (808.1.d.1), declining to perform it, and declining to
   * pay for it. So resolution needs a listener even when the board no longer has
   * one, and this is it: 808.1.d.3's "note its attributes" applied to the listener
   * rather than only to the event.
   *
   * The LIVE board copy is preferred at resolution when it is still there, so an
   * ability that reads its own current state sees the truth; this is the fallback.
   * Typed loosely for the same reason `event` is.
   */
  listenerCard?: unknown;
  /** The event as it was when it fired, captured rather than recomputed — 808.1.d.3's
   *  "noted before it moves to the Trash" applied generally. Typed loosely here
   *  to keep model/ free of an import from engine/; triggers.ts narrows it. */
  event: unknown;
  /**
   * Whatever the ability had to note about the BOARD when it triggered, as
   * opposed to about the event — the trigger's own half of 808.1.d.3's "note its
   * attributes before the card is moved".
   *
   * The event says what happened; it cannot say which of several units the
   * ability picked out. Mask of Foresight is the case that needs it: "when a
   * friendly unit attacks or defends ALONE" is a fire-time condition, so the unit
   * that was alone is decided then, and re-deriving "my only unit here" after the
   * response window would buff a reinforcement that arrived during it — or, worse,
   * whoever happens to stand first once the unit that triggered it has died.
   *
   * Produced by `EventTriggerDefinition.capture` and handed back to `resolve`.
   * Absent for every trigger that needs nothing beyond the event and its own
   * listener, which is all of them but one — the point is that an ability which
   * DOES need it can no longer be written by pretending the board has not moved.
   * Typed loosely for the same reason `event` is: model/ imports nothing from
   * engine/.
   */
  captured?: unknown;
  /**
   * WHICH registry resolves this entry — and therefore how to read `event`.
   *
   * Absent (or `"event"`) is the original shape: an EventTrigger-registry
   * ability, `event` a `GameEvent`. `"unitOnPlay"` is a unit's own "when you
   * play me" ability, where the listener IS the played unit and `event` is a
   * `UnitTriggerEvent` carrying the destination and the choices that rode in on
   * the PlayCard action. `"unitOnMove"` is the same shape for "when I move",
   * where `event` is a `UnitMoveTriggerEvent` carrying the destination and
   * whether this was the unit's first move of the turn. `"selfTrigger"` is a
   * card's ability about ITSELF (Scrapheap's "when this is played, discarded or
   * killed"), where `event` is a `SelfEvent` carrying the whole CARD — because at
   * two of those three moments it sits in a hand or a trash and no walk over
   * permanents in play would reach it. `"deathknell"` is the dying card's own
   * "when I die" (808), where `event` carries the `DeathContext` and the number of
   * times to execute it — Karthus - Eternal's multiplier, counted at the moment of
   * death rather than re-derived from a board it may itself have left.
   *
   * A discriminant rather than a second event field, so an entry can never carry
   * both and no existing literal has to change — the absent case is exactly what
   * every producer wrote before on-play triggers were held.
   *
   * **Every non-`event` source shares a rule the event one does not**: the ability
   * resolves even though its source has left play (809.1.b), because the card IS
   * the ability's source rather than a bystander watching. An event-registry
   * listener is the bystander, and bails. See `resolveHeldOnPlayTrigger`.
   *
   * `"battlefield"` is the BATTLEFIELD's own printed ability ("when you hold
   * here, draw 1"), where `event` is a `BattlefieldTriggerEvent` and
   * `listenerDefId` is the printed Battlefield card (`BattlefieldState.defId`).
   * It shares the non-`event` sources' rule for the same reason a Legend does,
   * only more strongly: a battlefield is in play from setup to the end of the
   * game and cannot leave, so there is no "it has gone" case at all.
   *
   * `"delayed"` is a DELAYED triggered ability, created by an effect that has
   * already resolved and owned by nothing on the board — UNL-169 Ashe - Focused's
   * "when they hold, return it to their hand (**even if I'm no longer on the
   * board**)". It is the only source with no listener at all: `listenerDefId`
   * names the card whose text created it, purely so the chain viewer can say what
   * the item is, and resolution reads `PlayerState.banishedUntilHold` rather than
   * looking anything up. It takes the non-`event` sources' rule to its limit — a
   * source that has left play is not merely tolerated here, it is the printed
   * case.
   */
  source?: "event" | "unitOnPlay" | "unitOnMove" | "selfTrigger" | "deathknell" | "battlefield" | "delayed";
}

/** One item waiting on the chain: a played Spell, or a triggered ability. */
export type ChainEntry = SpellChainEntry | TriggerChainEntry;

/** Narrows a chain entry to the Spell case. An entry with no `kind` is a Spell —
 *  see SpellChainEntry's own note on why the discriminant is optional there. */
export function isSpellChainEntry(entry: ChainEntry): entry is SpellChainEntry {
  return entry.kind !== "trigger";
}

/**
 * All state owned by a single player. Mirrors model/Player.java's zones:
 * deck/hand/activeGear/trash/banished/runeDeck/channeled. Units at
 * battlefields live on `GameState.battlefields`, not here — same reasoning
 * as the Java original ("their location is a board property, not a hand
 * property," model/Player.java:22-24).
 *
 * Java's Player additionally carries ~10 narrow "this turn"/restricted-pool
 * fields for individual cards' effects (restrictedSpellEnergy,
 * dianaScornOfTheMoonEnergy, wraithOfEchoesUsedThisTurn, xp, etc.,
 * model/Player.java:57-166) accreted one at a time as each specific card's
 * effect was implemented. None of those are needed yet — add each when the
 * card that needs it is implemented, not preemptively.
 */
/**
 * One granted "you may play THIS card for [Cost]" permission — see
 * `PlayerState.replacedCostPlays` for why it is a list of these rather than a
 * counter, and `engine/replaced-costs.ts` for the rule (356.1.a) it implements.
 *
 * The price is stored rather than looked up from the granting card, because the
 * card that grants it and the card it is granted FOR are the same object here
 * but need not be — and because `replacedCostFor` must be able to answer from
 * the permission alone, at all three cost sites, without a registry lookup.
 */
export interface GrantedReplacedCostPlay {
  /** The one card instance this permits. Not a defId: a second copy of the same
   *  card in the same trash is a different object and was not granted anything. */
  instanceId: string;
  energyCost: number;
  powerCost: number;
  /** `null` is the RAINBOW pip — the same reading `computeAutoPayment` and
   *  `matchesPowerDomain` already give a null domain. */
  powerDomain: Domain | null;
  /**
   * **There is deliberately no `fromPlayerIndex` here, and it was REMOVED rather
   * than never written.**
   *
   * UNL-020 Dancing Grenade needs one — "its controller may play this spell
   * again" hands the replay to the DAMAGED unit's controller while the spell sits
   * in the caster's trash — so the field was added speculatively with that card
   * named. Mutation testing against the whole engine suite then showed it
   * UNREACHABLE-as-distinct: replacing every read of it with the holder's own
   * index left all 4748 tests green, because no card can set it to anything else.
   *
   * The reason is structural and is recorded against Dancing Grenade itself:
   * `mayPlayCardNow` opens with `playerIndex !== actingPlayerIndex(state)` and
   * the card is Default-timed, so the opponent has no window to use a permission
   * during the caster's turn — and a grant cleared at `runEnd` never survives to
   * theirs. A cross-seat grant is not merely unwritten, it is unusable until the
   * engine can play a card mid-resolution (419.3.b).
   *
   * So the trash searched is always the HOLDER's own. Add the field back with the
   * card that can reach it.
   */
}

export interface PlayerState {
  id: string;
  name: string;
  legend: LegendInstance;
  /**
   * The one champion copy set aside at deck-build time — starts face-up
   * here, outside the draw deck, per Player.java:25 ("the champion starts
   * face-up in the base zone") and CardRegistry.buildPlayerWithChampion
   * (registry/CardRegistry.java:220-249), which pulls exactly one copy of
   * the chosen champion out of the 40-card deck before shuffling the rest.
   * Modeled as a field on PlayerState rather than a separate
   * GameState-level `Map<Player, Card.Unit>` (as Java's
   * `championZone`/`chosenChampion` are) since our GameState is already
   * player-indexed.
   */
  championZone: UnitInstance | null;
  /**
   * The defId of this player's **Chosen Champion** — the card `championZone`
   * started the game holding.
   *
   * `championZone` alone cannot answer "which card is your Chosen Champion",
   * because it is `null` the moment the champion is played, and that is exactly
   * when Hallowed Tomb ("return your Chosen Champion from your trash to your
   * Champion Zone if it is empty") needs the answer. Nor can the trash be
   * searched for "a champion": OGN prints 56 champions against 16 legends, so a
   * legal deck can hold champion cards that are not the designated one, and
   * `isChampion` would offer them.
   *
   * REQUIRED, not optional, so every hand-built state has to say what it is. An
   * optional field would default the Tomb to finding nothing — which is the
   * silent-inert shape this codebase keeps rediscovering, and it would be
   * silent in exactly the states used to test the card.
   */
  chosenChampionDefId: string;
  /**
   * Runes this player will ready AT THE END OF THIS TURN — Targon's Peak's
   * "when you conquer here, ready up to 2 runes at the end of this turn".
   *
   * A COUNT rather than a flag, because the trigger is on CONQUERING and not on
   * scoring: 471.1.b withholds the second point for a battlefield taken twice in
   * a turn, not the second trigger, so a battlefield lost and retaken arms four.
   *
   * "This turn" state, cleared by `runEnd` with the rest — which is exactly why
   * the delayed ability CAPTURES it at fire time rather than reading it at
   * resolution. See `BattlefieldTriggerDefinition.capture`.
   */
  readyRunesAtEndOfTurn: number;
  /**
   * The battlefields at which this player has already taken The Dreaming Tree's
   * draw this turn — "when a player chooses a friendly unit here with a spell for
   * the FIRST TIME each turn, they draw 1".
   *
   * A list of battlefield ids rather than a boolean, because both players pick a
   * battlefield from their own pool and two Dreaming Trees really can be in play
   * at once — a single flag would let one Tree spend the other's allowance.
   *
   * "This turn" state, cleared by `runEnd` for BOTH players with the rest.
   */
  spellChoiceDrawnBattlefieldIds: string[];
  deck: CardInstance[];
  hand: CardInstance[];
  trash: CardInstance[];
  banished: CardInstance[];
  activeGear: GearInstance[];
  runeDeck: RuneCard[];
  /** Rune pool for the current turn. */
  channeled: RuneCard[];
  baseUnits: UnitInstance[];
  points: number;
  /**
   * **XP** — Unleashed's per-player resource, and nothing more than an integer.
   *
   * The rules section between 727 (Dependent Keywords) and 735 (Additional
   * Turns) gives it in full: XP is accrued, spent or otherwise modified by
   * players; its amount is Public Information; it can be **Gained** and
   * **Spent**; it is **not a Game Object** ("cannot be targeted, readied, or
   * exhausted"); it is not shared between allies; and it has **no cap**. So
   * there is no zone, no object, no timing window, nothing to respond to, and
   * nothing that can be targeted — which is why this is a field beside `points`
   * rather than a subsystem.
   *
   * **Beside `points` deliberately, and NOT in `runEnd`'s sweep.** Every other
   * counter added to this interface lately has been "this turn" state that the
   * turn clears; XP is the opposite and persists for the game, exactly like the
   * score. Putting it in that sweep would zero the resource every turn and make
   * `[Level 11]` and `[Level 16]` unreachable — thresholds two UNL cards and
   * seven others print, so nine cards would silently never switch on.
   *
   * REQUIRED rather than optional, matching `chosenChampionDefId`'s reasoning
   * two fields up: an optional counter read as `xp ?? 0` puts the default in
   * every reader instead of in the state, and a hand-built test state would then
   * be free not to say what it is.
   *
   * Written only through `gainXp`/`spendXp` in effect-helpers.ts.
   */
  xp: number;
  floatingEnergy: number;
  floatingPower: Partial<Record<Domain, number>>;
  cardsPlayedThisTurn: number;
  /**
   * Battlefield ids this player has conquered so far this turn — needed for
   * the final-point rule (core rules §466.2): if a Conquest would be a
   * player's winning point, it's only awarded once they've conquered every
   * battlefield in that same turn; otherwise it's withheld (not rolled
   * back — the point simply never increments) and they draw a compensation
   * card instead. Mirrors GameState.conqueredThisTurn (a confirmed real
   * rules-vs-engine gap the Core-Rules-Audit found and fixed) and is reset
   * every Awaken (ScoringSystem.onTurnStart, engine/ScoringSystem.java:26-32).
   */
  /** Battlefields this player has SCORED this turn, by either method — Hold
   *  (Beginning Phase) or Conquer. The rules cap it at one score per
   *  battlefield per turn (rule 470), and the final-point rule asks
   *  whether every battlefield has been SCORED, not merely conquered
   *  (rule 474) — so holds must land in this list too. Cleared by runAwaken.
   *  Was `conqueredBattlefieldsThisTurn`, which tracked only half of it. */
  scoredBattlefieldsThisTurn: string[];
  /** Confront's "Units you play this turn enter ready" — reset every
   *  runEnd alongside the rest of this turn's transient state. */
  unitsEnterReadyThisTurn: boolean;
  /** Lux-Crownguard's activated ability ("Add 2 Energy. Use only to play
   *  spells.") — a separate, more restricted pool from floatingEnergy
   *  (that one can pay for anything; this one only Spells), drained first
   *  when paying a Spell's Energy cost (cost-modifiers.ts). Persists until
   *  spent, same as floatingEnergy, but still cleared at runEnd if unused
   *  — mirrors Player.java:74/TurnManager.java:335. */
  restrictedSpellEnergy: number;
  /**
   * Kai'Sa - Daughter of the Void's activated ability ("Add 1 rainbow Power. Use
   * only to play spells.") — the Power counterpart of `restrictedSpellEnergy`
   * above, drained after `floatingPower` and only by a Spell's Power cost.
   *
   * A bare number rather than an entry in `floatingPower`, because that record
   * is keyed by Domain and this Power is RAINBOW: it pays a pip of any domain. A
   * seventh pseudo-domain would have to be understood, and ignored, by every
   * consumer of floatingPower. Cleared at runEnd if unused, same as the Energy
   * pool.
   */
  restrictedSpellPower: number;
  /**
   * How many GEAR this player has played this turn — Ornn's Forge's "the FIRST
   * friendly non-token gear played each turn costs [1] less", and Azir's "use
   * only if you've played an Equipment this turn".
   *
   * A count rather than a boolean because "the first" needs to know whether any
   * have gone yet, and a later card wanting "the second" would need the number
   * anyway.
   *
   * **Non-token by construction.** Gear TOKENS (the Golds) arrive through
   * `placeGearToken`, never through a `PlayCard`, so nothing that reaches the one
   * site this is bumped at is a token. Stated rather than filtered, because a
   * filter on `isToken` here would read as though tokens could arrive this way.
   */
  gearPlayedThisTurn: number;
  /**
   * How many times this player has CHOSEN an enemy unit or an enemy gear this
   * turn, with a spell or a UNIT's ability — Ezreal - Prodigal Explorer's "use
   * only if you've chosen enemy units and/or gear twice this turn with spells or
   * unit abilities".
   *
   * A counter rather than a flag because the threshold is TWO, and one per
   * CHOICE rather than per card: a spell naming two enemy units gets there on its
   * own, which is what `holdUnitsChosen`'s own comment already anticipated ("a
   * card counting choices must count both").
   *
   * Three narrowings live in `recordEnemyChoices`, and each is a way to be
   * wrong: enemy only, gear as well as units, and NOT a Legend's or a gear's own
   * ability — "unit abilities" is printed and Jax's Legend ability chooses units
   * every time he is used.
   */
  enemyChoicesThisTurn: number;
  /**
   * How many GRANTED instances of `[Repeat]` the next spell this player plays
   * will have — Temporal Portal's "give the next spell you play this turn
   * [Repeat] equal to its cost".
   *
   * A count rather than a flag because 820.1.c.2 and 820.3 are explicit: "if a spell
   * or ability has more than one instance of Repeat, each Cost may be paid or
   * not paid individually", and each paid instance adds one execution. Two
   * Portals armed before one spell therefore grant two instances.
   *
   * Cleared by the NEXT SPELL PLAYED whether or not any granted cost was paid —
   * "the next spell you play" is spent by playing a spell, not by paying.
   *
   * **PARTIAL, recorded in docs/rules-conformance.md: at most ONE granted
   * instance is payable per play.** The action carries a single
   * `grantedRepeatPaid`, so a spell that is both printed-[Repeat] and granted
   * can execute three times, which is the deepest the card pool can go — but a
   * second Portal's instance cannot be paid. What that needs is per-instance
   * CHOICES (820.2), which is a list where every layer here has a field.
   */
  nextSpellRepeatGrants: number;
  /**
   * How many EQUIPMENT this player has played this turn — Azir's "use only if
   * you've played an Equipment this turn".
   *
   * **A second counter rather than a reuse of `gearPlayedThisTurn` above**, and
   * the distinction is printed: Equipment is a strict SUBSET of Gear, so a
   * Scrapheap played this turn satisfies Ornn's Forge and must NOT satisfy Azir.
   * One counter serving both would have turned every gear into an Equipment for
   * his purposes.
   */
  equipmentPlayedThisTurn: number;
  /**
   * Ornn - Fire Below the Mountain's rainbow Power — "[Add] [rainbow]. Use only
   * to play gear or use gear abilities."
   *
   * A THIRD restricted pool beside `restrictedSpellEnergy` and
   * `restrictedSpellPower` (Kai'Sa's, Spells only). Rainbow like hers, so no
   * domain match is asked; unlike hers it is spendable on GEAR.
   *
   * The two can never both apply to one card — a Gear is not a Spell — which is
   * why `restrictedPowerFor` picks between them rather than
   * `computeEffectiveCost` growing a fourth pool parameter.
   */
  restrictedGearPower: number;
  /**
   * Malzahar - Fanatic's "Kill a friendly unit or gear, Exhaust: → rainbow
   * rainbow" — Power that pays a pip of ANY domain, with no Spells-only
   * restriction.
   *
   * Its own field for the same reason `restrictedSpellPower` above is: keyed by
   * nothing, because rainbow matches every domain, and `floatingPower` is keyed
   * by Domain. It is NOT the same pool as that one — this pays for a Unit or a
   * Gear too, so folding the two together would silently let Kai'Sa's Spells-only
   * Power buy a body.
   *
   * Drained after `floatingPower` and before `restrictedSpellPower`: fungible
   * before restricted, the ordering both other pairs already follow. Cleared at
   * runEnd if unused, same as the rest.
   */
  floatingRainbowPower: number;
  /**
   * Sun Disc's "the NEXT unit you play this turn enters ready" — a charge, not a
   * flag, and the difference is the whole card.
   *
   * Confront's `unitsEnterReadyThisTurn` above is a boolean because it readies
   * EVERY unit you play for the rest of the turn; this readies exactly one and
   * is then spent. Modelled as a count so two activations (Sun Disc plus a
   * borrowed copy via Heimerdinger) arm two units rather than collapsing into
   * one boolean. Cleared at runEnd with the rest of the turn.
   */
  nextUnitsEnterReady: number;
  /**
   * Jayce - Man of Progress's "you may play a gear from hand this turn, ignoring
   * its Energy cost" — a PERMISSION that outlives the trigger that granted it.
   *
   * A charge like `nextUnitsEnterReady` above, and modelled as a count for the
   * same reason: two Jayces landing in one turn each grant one, and collapsing
   * them into a boolean would lose the second.
   *
   * **A permission, not a resolution-time play.** Every other "play a card
   * ignoring its cost" in this pool happens as the granting card resolves, so it
   * needs no state at all; Jayce's is a window that stays open for the rest of
   * the turn, so it has to be somewhere the PLAY path can read it. Cleared at
   * runEnd with the rest of the turn.
   */
  freeGearPlaysThisTurn: number;
  /**
   * How many units this player may play FROM THEIR TRASH, still paying every
   * cost — Last Rites' art-only "when I conquer or hold, you may play a unit
   * from your trash (still paying costs)".
   *
   * A count for the same reason `freeGearPlaysThisTurn` above is one: two Last
   * Rites conquering in a turn each grant a play, and a boolean would lose the
   * second.
   *
   * **The engine's first FULL-COST play from a non-hand zone, and that is the
   * point of it.** Three cards were already written against exactly this
   * condition and could only ever pay out through the Champion Zone:
   * `PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS` (Void Drone, Drag Under) discounts
   * "[2] less to play from anywhere other than your hand", and Rek'Sai -
   * Breacher grants `[Accelerate]` on the same condition. This zone reaches the
   * normal pricing path with `playedFromHand: false`, so all three now pay.
   *
   * **DIVERGENCE, recorded in docs/rules-conformance.md.** The rules make this a
   * Limited Play Effect that happens INSIDE the trigger's resolution (419.3.b —
   * "Game effects may result in cards being played as part of their
   * resolution", with all steps of Play normal). This engine cannot do that: a
   * play needs a RunePayment, `AnswerDecisionAction` carries only an `optionId`,
   * and there is no other way to collect one mid-resolution. So the trigger
   * grants a permission the normal play path spends, which holds the window open
   * until end of turn rather than closing it when the trigger finishes. Jayce -
   * Man of Progress's permission has the identical shape and the identical
   * reason; the difference is that his card PRINTS "this turn" and this one does
   * not. Cleared at runEnd with the rest of the turn.
   */
  trashUnitPlaysThisTurn: number;
  /**
   * Per-INSTANCE permissions to play one specific card at a REPLACED price —
   * UNL-186 Death from Below's "you may play this from your trash for
   * [rainbow]", granted to the caster when the unit it killed had 3 Might or
   * less.
   *
   * **Deliberately NOT `trashUnitPlaysThisTurn` widened**, and the difference is
   * the whole reason this is a second field. That counter is a per-PLAYER
   * allowance to play ANY unit from the trash at its PRINTED cost; this names a
   * particular instance and carries the price with it. Merging them would make
   * one card's recursion pay for another card's play.
   *
   * **Also not `replaced-costs.ts`'s printed table**, which answers from the card
   * alone: UNL-025 Undying Legion's permission is a standing passive that is
   * true whenever he is in a trash and `[Legion]` holds, so it needs no memory.
   * This one is GRANTED by something that happened — a specific kill, by a
   * specific spell — and nothing about the card in the trash can re-derive it.
   *
   * The card is always taken from the HOLDER's own trash — see
   * `GrantedReplacedCostPlay` for why the cross-seat case (UNL-020 Dancing
   * Grenade) is not merely unwritten but unusable.
   *
   * **DIVERGENCE, recorded in docs/rules-conformance.md, and the same one
   * `trashUnitPlaysThisTurn` above already carries.** 419.3.b makes this a
   * Limited Play Effect that happens INSIDE the resolution; this engine cannot
   * play a card mid-resolution (a play needs a RunePayment, and
   * `AnswerDecisionAction` carries only an `optionId`), so the resolution grants
   * a permission the normal play path spends. That holds the window open until
   * end of turn rather than closing it when the spell finishes. Cleared at
   * `runEnd` with the rest of the turn, and CONSUMED when used — 419.3.b's
   * window is one play, so a permission that survived its own use would let one
   * [rainbow] buy the card again every turn.
   */
  replacedCostPlays: readonly GrantedReplacedCostPlay[];
  /**
   * Instance ids in THIS player's `banished` that come back to THIS player's hand
   * the next time they hold — UNL-169 Ashe - Focused's "choose a card revealed
   * this way and banish it. When they hold, return it to their hand (even if I'm
   * no longer on the board)."
   *
   * **A DELAYED TRIGGERED ABILITY, held on state rather than on a card, and that
   * is the rules-correct model rather than a workaround.** The parenthetical is
   * the whole point of the field: the ability is created when Ashe's on-play
   * effect RESOLVES and from then on it exists independently of her, so a design
   * that kept her as the listener would have to find her in a trash, in a banish
   * pile, back in a hand or shuffled into a deck. Three waves refused this card
   * partly on that hunt.
   *
   * Owned by the CARD's owner, not by Ashe's controller, because both halves of
   * the sentence are about them: "when THEY hold, return it to THEIR hand". So
   * the firing site in `scoring.ts` reads the holder's own list and needs to know
   * nothing about who banished what.
   *
   * IDs, not card copies — the card itself is really in `banished` and must stay
   * there, or anything counting banished cards would see it twice. Same choice
   * `GearInstance.banishedInstanceIds` (The Zero Drive) already makes.
   *
   * NOT cleared at `runEnd`: "when they hold" names no turn, and an opponent who
   * never holds never gets the card back. That is the one field here whose
   * lifetime is the GAME rather than the turn, which is why it sits beside the
   * turn-scoped ones with this said out loud.
   */
  banishedUntilHold: readonly string[];
  /**
   * Points scored FROM HOLDING this turn — Needlessly Large Yordle's "I cost
   * [2][Calm] less for each point you scored from holding this turn".
   *
   * Deliberately NOT every point: the card names the METHOD, and a point from
   * conquering is a different sentence. `scoreHolds` is the one site that
   * produces one, which is why the counter lives beside the award rather than
   * being derived from `points` (that moves for conquests too).
   */
  pointsFromHoldingThisTurn: number;
  /**
   * Power SPENT this turn — Sivir - Mercenary's "if you've spent at least
   * [rainbow][rainbow] this turn".
   *
   * PIPS of Power, counted however they were paid: her text says "[rainbow]
   * [rainbow]", which is two Power of any domains rather than two rainbow ones.
   * Bumped in `payPowerFromChanneled`, the single funnel every Power payment in
   * this engine goes through — a per-site tally would miss the ones nobody
   * remembered.
   */
  powerSpentThisTurn: number;
  /**
   * The MOST Energy spent on any ONE spell this turn — "if you've spent
   * [4] or more to play a spell this turn".
   *
   * A MAXIMUM, not a total, and that is the card's wording rather than a
   * simplification: "spent 4 to play A spell" asks whether some single spell
   * cost that much, so two 2-Energy spells do not add up to it. Summing would
   * make both cards fire on a turn neither describes.
   *
   * Counted at the moment of payment in `execute-play-card`, from the MODIFIED
   * cost — what was actually spent, after discounts — since that is what "you've
   * spent" means. A card played for free from Hidden spends nothing.
   *
   * Two cards print this sentence verbatim: UNL-004 Prepared Neophyte (+4 Might
   * while true) and UNL-089 Jhin - Meticulous Killer (an alternative cost). One
   * field answers both, which is why it is here rather than derived per card.
   */
  maxSpellEnergySpentThisTurn: number;
  /**
   * SPELLS this player has played this turn — UNL-122 Crescent Guardian's "if
   * you've played a spell this turn".
   *
   * **A census found eight spell-named fields on this interface and not one of
   * them answers it**, which is why a ninth is here rather than a derivation:
   *
   *  - `cardsPlayedThisTurn` counts CARDS, so a Unit or a Gear satisfies it.
   *    That is `[Legion]`'s question (812) and a different one.
   *  - `maxSpellEnergySpentThisTurn` beside it is the near miss and is explicitly
   *    NOT a substitute: it is a MAXIMUM over single spells, so a spell that cost
   *    nothing leaves it at 0. Measured against SFD-122 Called Shot, the pool's
   *    only 0-Energy Spell — but not the only route there, since 811 makes a
   *    `[Hidden]` play cost nothing and a discount can reach 0 from above.
   *  - `SpellChainEntry.energySpent` and `spellCast.energySpent` are per-ITEM and
   *    live only while the chain item does; they answer "what did THIS spell
   *    cost", not "did one happen".
   *  - `cannotPlaySpellsThisTurn` is a BAN — what a player may do, not a record
   *    of what they have done.
   *
   * Incremented beside `cardsPlayedThisTurn` in `execute-play-card`'s shared
   * updates rather than in its Spell branch, so it counts every route a Spell is
   * played by and cannot be missed by one that skips that branch. Cleared at
   * `runEnd` with the rest of the turn.
   */
  spellsPlayedThisTurn: number;
  /**
   * Cards this player has DRAWN this turn — UNL-074 Frigid Jewel's "when you draw
   * your SECOND card each turn".
   *
   * An ordinal, not a flag, and that is the card: the trigger fires on the second
   * draw and on no other. A boolean could say "has drawn" but not "which one this
   * is", and a listener that fired on every draw would pump a unit per card.
   *
   * Counted inside `drawCards`' per-card loop rather than once per call, because
   * a single "draw 3" must cross the boundary exactly once — the second card of
   * that batch is the second card of the turn.
   *
   * `drawCards` is the ONE funnel every draw goes through, including the Draw
   * Phase's (turn-manager calls it too), so this cannot miss a route. Cleared at
   * `runEnd` with the rest of the turn.
   */
  cardsDrawnThisTurn: number;
  /**
   * Rally the Troops' "when a friendly unit is played THIS TURN, buff it" — a
   * DELAYED trigger, so the flag is set when the spell resolves and read at the
   * PLAY site for the rest of the turn.
   *
   * A COUNT rather than a boolean: two Rallies in a turn buff a unit twice, and
   * 702.3.a makes the second buff a no-op only because the unit is already buffed —
   * which is a fact about the unit, not about how many Rallies were cast.
   */
  buffUnitsPlayedThisTurn: number;
  /**
   * Battlefields this player CONQUERED this turn — Perched Grimwyrm's "play me
   * only to a battlefield you conquered this turn".
   *
   * **Deliberately NOT `scoredBattlefieldsThisTurn`**, which is the neighbouring
   * field and a different fact. That one records the once-per-turn SCORING
   * lockout (470) and is written even when the point is withheld — and it is
   * also written by HOLDING, which is not conquering. Grimwyrm asks about the
   * act of taking a battlefield, so it is recorded where conquests happen.
   *
   * Cleared at runEnd with the rest of the turn.
   */
  conqueredBattlefieldsThisTurn: string[];
  /**
   * Has a unit THIS player controls died this turn? Spoils of War costs 2 less
   * "if an enemy unit has died this turn", which each player has to answer about
   * the other, so it is stored per victim rather than as a global flag.
   *
   * Set in the death funnel and cleared by runEnd — "this turn" means every
   * turn, not just your own, so a unit of yours dying on the opponent's turn
   * discounts their Spoils of War during it.
   */
  unitsLostThisTurn: number;
  /** Raging Firebrand's "the NEXT spell you play this turn costs [5] less" — a
   *  charge, not a standing discount, so it is a number that is spent rather
   *  than a flag that is read. Cleared by `runEnd` with the rest of the
   *  this-turn state, and consumed by the first Spell played. */
  nextSpellEnergyDiscount: number;
  /** Ravenborn Tome's "the NEXT spell you play this turn deals 1 Bonus Damage" —
   *  a charge like `nextSpellEnergyDiscount` above, but spent one layer later:
   *  the discount is consumed when the spell is PAID for, this one when the spell
   *  finishes RESOLVING, because that is where its damage happens. */
  nextSpellBonusDamage: number;
  /** Brynhir Thundersong's "opponents can't play cards this turn", set on the
   *  player who is locked out. A fact about the TURN rather than a continuous
   *  ability, so it survives her death — killing her in response must not undo
   *  it — and `runEnd` clears it with the rest. */
  cannotPlayCardsThisTurn: boolean;
  /**
   * Lilting Lullaby's "its controller can't play SPELLS this turn" — the
   * spells-only twin of the field above.
   *
   * A separate field rather than a mode on that one, because the two are
   * genuinely different bans and a card may owe both: Brynhir Thundersong stops
   * everything, and this stops one kind. Folding them together would make the
   * wider ban unreadable once the narrower one was set.
   */
  cannotPlaySpellsThisTurn: boolean;
  /**
   * How many of this player's units died during THEIR OWN Beginning Phase this
   * turn — Shadow Watcher's "if a friendly unit died during your Beginning Phase
   * this turn, I enter ready".
   *
   * `unitsLostThisTurn` beside it is strictly wider and cannot stand in: the
   * difference is reachable rather than theoretical, because `[Temporary]`'s
   * sweep and hold-scoring both kill in the Beginning Phase, and a unit lost in
   * combat later the same turn must not satisfy this.
   */
  unitsLostInBeginningPhaseThisTurn: number;
  /** Guerilla Warfare's "you can hide cards ignoring costs this turn" — the
   *  flat 1 rainbow Power a Hide normally costs (811) is waived. A this-turn
   *  flag rather than a charge: it says "cards", plural, so it is not spent by
   *  the first one. */
  hideIgnoresCostThisTurn: boolean;
  /** Unyielding Spirit's "prevent all spell and ability damage this turn" —
   *  whose damage is prevented, not who cast it. Global in effect, stored on
   *  the player because the card says "this turn" and turns belong to players. */
  preventsSpellDamageThisTurn: boolean;
  /**
   * Has this player's "first time a friendly unit dies each turn" already
   * fired? Wraith of Echoes is the only card that asks, and the Java oracle
   * carries a field of the same shape and nearly the same name
   * (`wraithOfEchoesUsedThisTurn`) — this file's own note about those ~10 narrow
   * per-card fields says to add each one when the card that needs it is
   * implemented, which is now.
   *
   * "Each turn", not "each of your turns": reset by runEnd, which fires at the
   * end of EVERY turn, so a unit of yours dying on the opponent's turn arms it
   * for them and disarms it again afterwards.
   */
  firstFriendlyDeathUsedThisTurn: boolean;
  /**
   * Extra Might each Buff is worth to THIS player's units for the rest of the
   * turn — Stand United's "Buffs give an additional +1 Might to friendly units
   * this turn".
   *
   * A modifier on the buff's VALUE, not a buff itself and not a flat Might
   * bonus: it scales with how many of your units are buffed, applies to units
   * buffed later in the same turn, and is worth nothing on an unbuffed unit.
   * Cleared by runEnd alongside the other this-turn state.
   */
  extraMightPerBuffThisTurn: number;
  /**
   * Has this player discarded a card this turn? Raging Soul's "if you've
   * discarded a card this turn, I have [Assault] and [Ganking]" is the only
   * card that asks, and it asks about the PLAYER, not about any particular
   * discard — so a flag rather than a count. Set by `discardCards`, cleared by
   * runEnd.
   */
  discardedThisTurn: boolean;

  /**
   * Has this player GAINED XP this turn?
   *
   * `xp` is a running total, so it cannot answer this: "gained some this turn"
   * and "has some" are indistinguishable from it, and a player who has been
   * sitting on 6 XP since turn two has gained none. Wily Newtfish (UNL-108) —
   * "If you've gained XP this turn, I have +1 Might and [Ganking]" — is the first
   * card to ask, and until this existed its keyword had to be stripped and left
   * inert rather than granted wrongly.
   *
   * A flag rather than a count, and about the PLAYER rather than any particular
   * gain — exactly `discardedThisTurn` above, which Raging Soul reads the same
   * way. Set by `gainXp`, the single writer, and cleared by runEnd.
   */
  xpGainedThisTurn: boolean;
}

/**
 * A battlefield location on the board. Mirrors model/Battlefield.java.
 * `hiddenCards` (the [Hidden] keyword's facedown-card tracking,
 * model/Battlefield.java:43-55) isn't modeled yet — add it when Hidden is
 * implemented, since nothing reads it before then.
 */
export interface BattlefieldState {
  /**
   * Units that have already gained an Attacker or Defender designation during the
   * combat currently running here (464.2.c Step 1), so a later arrival can be told
   * apart from one that was designated at the opening.
   *
   * 383.4.e fires an Attack Trigger when its unit gains the designation "for the
   * FIRST time during a combat", and 465 designates a unit that becomes present
   * later "during the Cleanup phase following the action that caused it to become
   * present" — so the engine has to remember who has already been designated, or
   * every unit already there would fire again each time a reinforcement walked in.
   *
   * Cleared by `clearContested`, which runs when the Showdown closes (190.3.b):
   * the record belongs to one combat, not to the battlefield.
   */
  designatedInstanceIds?: readonly string[];
  id: string;
  name: string;
  /**
   * The Battlefield CARD this is, when the name matches one.
   *
   * Battlefields were names and nothing else until now, which is why they have no
   * abilities: `card-loader`'s `shouldSkip` excludes Battlefield-type cards from
   * `loadCardDefinitions`, so there was nothing for an ability registry to key
   * off. This is that key — the 24 printed battlefields all carry real rules text
   * (`loadBattlefieldDefinitions`), and an ability table can now find it.
   *
   * OPTIONAL because a deck file may name a battlefield no card matches, and
   * because the many hand-built `BattlefieldState`s in tests and probes must keep
   * compiling. Absent means "no printed ability", never "look it up by name".
   */
  defId?: string;
  controllerId: string | null;
  units: Record<string, UnitInstance[]>;
  /**
   * Who applied Contested status here, or null if the battlefield isn't
   * Contested. Rule 450: "The Destination becomes Contested if it is an
   * Uncontested Battlefield not controlled by the controller of the Unit or
   * Units that moved" — so entering a battlefield you already control applies
   * nothing, and an already-Contested one isn't re-applied.
   *
   * This exists as real state because the rules separate the two halves in
   * time: a Move applies Contested, and the Showdown is only *staged* in the
   * following Cleanup (323.8 / 341), by which point the applier must still be
   * known — they gain Focus as the Showdown begins (345). Cleared once Control
   * is established or re-established (190.3.b), which is what ends the
   * Contested status rather than the Showdown merely closing.
   */
  contestedByIndex: 0 | 1 | null;
  /**
   * Cards hidden facedown here by the `[Hidden]` keyword (rule 811).
   *
   * A list rather than a single slot even though rule 811 allows at most one
   * ("a battlefield you control that doesn't already have a facedown card
   * hidden there") — because control can change, and the rules resolve that in
   * the Cleanup (323 step 5) rather than preventing it. Between a control
   * change and the next Cleanup two players' cards can briefly coexist here,
   * and a single slot would have to silently drop one.
   */
  hiddenCards: HiddenCard[];
  /**
   * What this battlefield WAS, before a token replaced it — UNL-195 Ivern - Green
   * Father's "replace that battlefield with a Brush battlefield token", whose own
   * reminder text adds "it can be swapped back when scored".
   *
   * A battlefield's identity in this engine is its `name` and its `defId`, and a
   * replacement overwrites both — so after the swap nothing else on the board
   * remembers the original and the swap-back would have nothing to restore.
   *
   * Absent for every battlefield that has never been replaced, which is all of
   * them in a game without an Ivern.
   */
  swappedFrom?: { name: string; defId?: string };
}

/**
 * One facedown card at a battlefield.
 *
 * `hiddenOnTurn` is what makes "beginning on the next turn, this gains
 * [Reaction] and you may play this, ignoring its base cost" (811) checkable —
 * it is NOT the same as "not during this Action phase", since a turn can end
 * and return. Compared against `GameState.turnNumber`.
 *
 * `ownerIndex` rather than a controller: rule 323 step 5 sends a lost facedown
 * card to its OWNER's trash, and 811 ties the card's life to whether that same
 * player still controls the battlefield.
 */
export interface HiddenCard {
  ownerIndex: 0 | 1;
  card: CardInstance;
  hiddenOnTurn: number;
}

/**
 * One question the engine has stopped to ask a player, mid-resolution.
 *
 * Everything else in this engine decides its choices BEFORE an action is
 * submitted, fanned out as candidates by legal-actions.ts. That only works when
 * there is an action to hang the choice on, which a trigger does not have —
 * hence this. While one of these is pending the game is genuinely paused: no
 * Cleanup runs (321, "while Chain Items are Resolving, a Cleanup cannot
 * occur") and no other action is legal.
 *
 * `kind` is a registry key, and that is the whole trick: the CONTINUATION IS
 * DATA. The Java oracle resumes through closures — `beginDiscard(player, count,
 * () -> ...)` — which is unusable here, because states are immutable snapshots
 * the AI clones and rescores and a lambda cannot survive that.
 *
 * The available options are deliberately NOT stored. engine/decisions.ts
 * recomputes them from live state when the decision reaches the front of the
 * queue, so a decision parked behind another can never offer a unit the earlier
 * answer has since killed.
 */
export interface PendingDecision {
  /** Unique per decision. The answering action names it, so an answer aimed at
   *  a decision that has already been resolved cannot apply to its successor. */
  id: string;
  /** Which DecisionDefinition resolves this — see engine/decisions.ts. */
  kind: string;
  /** Who must answer. Not necessarily the turn player: Cull the Weak asks both. */
  playerIndex: 0 | 1;
  /** The card that asked, when the handler needs it back (Flame Chompers in the
   *  trash, Mistfall in play). */
  cardInstanceId?: string;
  /** How many more times this repeats — "discard 2" answers once and re-parks
   *  with one fewer, rather than needing a multi-select. */
  count?: number;
  /** What the question is ABOUT, when that is a different thing from the card
   *  asking it — Mistfall asks about its gear (`cardInstanceId`) and the unit
   *  that was just buffed (this). Captured when the question is raised, because
   *  "it" means the unit that was buffed, not whatever is buffed by the time the
   *  answer comes in. */
  targetInstanceId?: string;
  /** WHERE the question is about, for the questions whose answer is a
   *  destination rather than a thing — Blitzcrank - Impassive's "you may move an
   *  enemy unit to **here**", where "here" is the battlefield he was played to.
   *
   *  Captured when the question is raised for the same reason `targetInstanceId`
   *  is: "here" means where he landed, not wherever he happens to be standing by
   *  the time the answer arrives. Nothing can move him in between today, and that
   *  is exactly the kind of fact that stops being true without anyone noticing. */
  battlefieldId?: string;
}

/**
 * The full state of one Riftbound game. Mirrors model/GameState.java's
 * core shape (FR3): players, battlefields, turn/phase/priority, scoring
 * (on each PlayerState.points, matching Java — GameState itself has no
 * points field either).
 *
 * Java's GameState additionally carries a long tail (~700 lines) of
 * per-card "this turn" bookkeeping (Burn Out queue, damage-assignment
 * state, etc., model/GameState.java:291-748) — deliberately not
 * generalized into a clean TS shape up front (it's the least generalizable
 * part of the Java model). Add fields for that here card-by-card, as each
 * one's effect is actually implemented, the same way Player/Card already
 * defer their own long tails.
 */
/**
 * A unit that has been taken off the board because it is dying, but whose death
 * is not settled yet — Sett - The Boss's "if a buffed unit you control **would
 * die**, you may pay ... to heal it, exhaust it, and recall it **instead**".
 *
 * A holding pen is needed because a replacement is offered at the moment of
 * death, unlike Highlander's ward which is armed in advance
 * (`deathWardedUnitInstanceIds`). By the time the question can be asked the unit
 * has already been removed from wherever it was, and it must NOT be in the trash
 * — rule 808.1.d.1 makes a replaced death not a death at all, so its Deathknell
 * must never fire. It therefore exists nowhere the board can see, and a decision
 * carrying only its instanceId would have nothing to look it up in.
 *
 * Carries the same fields DeathContext does, because if the offer is declined
 * this is exactly what the ordinary death path is handed.
 */
export interface PendingDeath {
  unit: UnitInstance;
  ownerIndex: 0 | 1;
  battlefieldId?: string;
  killerIndex?: 0 | 1;
  /** True only for a death in the COMBAT DAMAGE STEP. See DeathContext for
   *  why `battlefieldId` is not this question. */
  diedInCombat?: true;
  /**
   * The Equipment this unit was WEARING when it died — Sacred Shears's
   * `[Deathknell]`, which belongs to the gear and fires on the wearer's death.
   *
   * **Carried on the death because it cannot be looked up afterwards.**
   * `killUnit` detaches FIRST, deliberately and before any ward or replacement,
   * so that no path out of it can leave a gear pointing at a unit that is no
   * longer there. By the time `unitDied` fires, every attachment is already
   * gone, and a listener asking "was I worn by the unit that died?" would always
   * get no.
   *
   * Instances, not defIds, so a listener can identify ITSELF rather than a card
   * with the same name — two Sacred Shears on two units are two different
   * answers to "did my wearer die".
   */
  wornEquipment?: readonly GearInstance[];
}

export interface GameState {
  players: [PlayerState, PlayerState];
  battlefields: BattlefieldState[];
  activePlayerIndex: 0 | 1;
  /**
   * Who took the very first turn of this game — fixed for its whole lifetime.
   * Rule 115 determines turn order by "any fair random method", so this is
   * genuinely either player and is NOT derivable from `activePlayerIndex`
   * (which rotates) or from the seat a player occupies.
   *
   * Two steps depend on it, and both were previously written against the
   * literal indices on the assumption that player 0 always started:
   *   - the going-second Channel bonus (rules 485.7 / 486.7) must land on
   *     `active !== firstPlayerIndex`, or the compensation for going first
   *     goes to the player who went first;
   *   - `turnNumber` advances when play wraps back to the First Player
   *     (rule 115.1.c's looping queue "starting with the First Player"), not when
   *     it reaches index 0.
   *
   * Equivalent to TurnManager.java's `startingPlayerIndex` instance field,
   * lifted onto GameState because this engine's turn steps are pure functions
   * with no instance to hang it off.
   */
  firstPlayerIndex: 0 | 1;
  turnNumber: number;
  phase: Phase;
  turnState: TurnState;
  /** Who currently acts during an open Showdown; meaningless while
   *  turnState is "Neutral". Mirrors GameState.java's focusHolder. */
  focusHolder: 0 | 1;
  /** Where the open Showdown is; null whenever turnState is "Neutral".
   *  Mirrors GameState.java's showdownBf (id only, not the object, since our
   *  BattlefieldState lives in the `battlefields` array).
   *
   *  One at a time, deliberately. The rules allow several Showdowns to be
   *  Staged at once (323's cleanup step 6 marks one per Contested battlefield);
   *  our Cleanup opens one and leaves any other battlefield Contested for the
   *  next Cleanup. Only reachable via an effect that contests two battlefields
   *  in a single action, of which this card pool has none — a divergence
   *  recorded in docs/rules-conformance.md rather than built. */
  showdownBattlefieldId: string | null;
  /**
   * Which kind of Showdown is open, or null when none is. Non-null exactly when
   * `turnState === "Showdown"` and `showdownBattlefieldId !== null`.
   *
   * A Showdown is NOT combat — rule 341 makes it a window in which players may
   * play cards in an alternating fashion, and only *some* Showdowns are part of
   * a Combat:
   *   - `"Combat"` — opened with units of different players present, so it
   *     "will be opened as the first step of Combat" (341). Closing it runs the
   *     remaining steps of Combat (348.1 / 463).
   *   - `"NonCombat"` — opened by moving onto a battlefield you don't control
   *     that has no opposing units. A stand-alone phase that "does not create a
   *     Combat" (316.8.b.1). Closing it just establishes Control (348.2.a).
   *
   * Stored rather than derived from the board, because it is a status that
   * *transitions*: a NonCombat Showdown becomes a Combat Showdown in the
   * following Cleanup if another player's units arrive (316.8.b.1.a). Board shape
   * can't stand in for it either — Combat step 3d recalls the attackers, so
   * "units of different players present" is false by the time a Combat
   * Showdown finishes.
   */
  showdownKind: "Combat" | "NonCombat" | null;
  /** Consecutive PassFocus count while a Showdown is open; 2 resolves
   *  combat and closes it. Mirrors GameState.java's consecutiveFocusPasses.
   *  No separate showdownAttackerIndex field is needed the way Java's
   *  showdownAttacker is: that field only exists for Charm-style effects
   *  that let a caster move an *enemy's* unit (nothing like that is
   *  implemented here), so activePlayerIndex — frozen for the Showdown's
   *  whole lifetime, since Pass (the only thing that changes it) is illegal
   *  while turnState is "Showdown" — is always the attacker. */
  consecutiveFocusPasses: number;
  /** true = no spell pending resolution (an "Open State"); false = a Spell
   *  is on the chain and only PassFocus is legal until it resolves. Mirrors
   *  GameState.java's chainOpen — shared between Neutral and Showdown
   *  contexts, orthogonal to turnState (a Spell can't currently be cast
   *  during a Showdown, since validatePlayCard rejects all PlayCard outside
   *  turnState "Neutral", so in practice this only ever closes on a Neutral
   *  turn for now). */
  chainOpen: boolean;
  /** Who currently has priority to act while the chain is closed; meaningless
   *  while chainOpen (same "stale but harmless" convention as focusHolder).
   *  Mirrors GameState.java's chainPriority — kept non-nullable like
   *  focusHolder rather than `0 | 1 | null`, to match the existing
   *  convention and avoid a null-handling ripple through every fixture. */
  chainPriority: 0 | 1;
  /** Consecutive PassFocus count while the chain is closed; 2 resolves the
   *  top of the chain. Mirrors GameState.java's chainPasses — a sibling
   *  counter to consecutiveFocusPasses, not the same one, since a chain can
   *  close independently of any Showdown. */
  chainPasses: number;
  /** The actual LIFO stack of pending Spell resolutions. Mirrors
   *  GameState.java's `Deque<ChainEntry> spellChain`. A real array (not a
   *  single nullable slot) even though nothing can currently push a 2nd
   *  entry before the 1st resolves (no reaction-speed casting is
   *  implemented yet) — this is the correct general shape, not speculative:
   *  it needs no restructuring the moment reaction casting is added. */
  spellChain: ChainEntry[];
  /**
   * Whether the currently-open chain was opened by a triggered ability rather
   * than by a played card — rule 346.1's exception to 346's Focus pass.
   *
   * 347: "Focus will not pass in this way if the chain opened as a result of a
   * triggered ability being added to the chain, nor if it opened as a result of an
   * Add ability." Its printed example is the Combat Chain, which opens exactly that
   * way.
   *
   * STATE rather than a property of the popped entry, and that distinction is the
   * whole point: the rule asks how the chain OPENED, not what just resolved. A
   * [Reaction] Spell cast in response to a trigger pops last, so a per-entry test
   * would see a Spell and pass Focus — losing the Focus rule 345 had just awarded
   * to the player who contested the battlefield, before they had taken one action
   * in their own Showdown.
   *
   * Meaningless while `chainOpen` (same "stale but harmless" convention as
   * `chainPriority` and `focusHolder`); set when a flush closes an open chain and
   * cleared when the chain empties.
   */
  chainOpenedByTrigger: boolean;
  /**
   * Triggers that have fired but are not yet respondable — the Chain's **Pending
   * Item** portion of the chain (337-345), held here rather than in `spellChain`.
   *
   * The rules put a trigger on the Chain the instant it fires, in any state: 383
   * says "Triggered Abilities can be put on the Chain during Closed States or Open
   * States on any player's turn", and 320.1 allows it even mid-Cleanup ("New
   * Pending Items can be added, but Finalized Items cannot be executed and Priority
   * and Focus are not passed or awarded"). What a Pending Item is NOT is
   * respondable: 345 grants priority to "the controller of the newest item on the
   * chain" only once there are **no** Pending Items left.
   *
   * So this is not a queue invented to work around the dispatch sites firing where
   * nobody holds priority — it is that rules concept, given the one shape it can
   * have here. Most of the 14 `dispatch*` entry points fire during the Beginning
   * Phase, a Cleanup, scoring, or mid-resolution, and pushing straight onto
   * `spellChain` there would offer a response window at a moment the rules say
   * priority is not awarded.
   *
   * Drained by `runCleanup`'s flush, which is the engine's Finalize step: the one
   * hook that runs after every action in both `submit` and the AI's lookahead.
   * Empty in every settled state.
   */
  pendingTriggers: TriggerChainEntry[];
  /**
   * A player who has WON by something other than points — The Grand Plaza's
   * "when you hold here, if you have 7+ units here, you win the game".
   *
   * `win-condition.winner` reads this before it compares scores, so an alternate
   * win condition does not have to be expressible as a number of points. It is
   * deliberately a declaration rather than a shortcut that awards enough points:
   * a player put on the Victory Score would also satisfy every "while an opponent
   * is within 3 points" clause on the board, and would be beatable by a tie.
   *
   * Set once and never cleared — a win does not lapse. `null` in every ordinary
   * game, which is why it costs nothing to read on the hot path.
   */
  declaredWinnerIndex: 0 | 1 | null;
  /**
   * How many EXTRA turns the player at `extraTurnsForIndex` still has coming —
   * Time Warp's "take a turn after this one".
   *
   * A count rather than a boolean because the card can be cast twice in one
   * turn, and the rules give you both turns rather than collapsing them. Paired
   * with an index rather than being per-player, because only one player can be
   * owed extra turns at a time: a Time Warp cast on YOUR turn queues yours, and
   * `runEnd` hands the turn back to the same seat until the queue empties.
   *
   * Read once, in `runEnd`'s rotation. Everything else about a turn is unchanged
   * — an extra turn is a normal turn, with its own Awaken, scoring and draw.
   */
  /**
   * Imperial Decree's "when ANY unit takes damage this turn, kill it".
   *
   * On the STATE rather than on a player, and that is the card: it says *any*
   * unit, so it reaches both boards including the caster's own, and a per-player
   * field could not say that without being set on both.
   */
  killDamagedUnitsThisTurn: boolean;
  /**
   * Units their controller may not MOVE for the rest of this turn.
   *
   * Vex - Apathetic (UNL-150): "[Stun] an enemy unit. They can't move it this
   * turn." The Stun was implementable and this half was not — nothing anywhere
   * could forbid ONE unit from moving. `validate-move-unit` gated only on the
   * phase, the origin/destination and `[Ganking]`, and `UnitInstance.movesThisTurn`
   * is a COUNT rather than a lock.
   *
   * On the STATE rather than on the unit, matching every other this-turn effect
   * here (`killDamagedUnitsThisTurn`, `markedForDeathOnDamageInstanceIds`): a
   * field on `UnitInstance` would travel with the unit through zones it should
   * not survive, and `runEnd` already sweeps this shape.
   *
   * Instance ids, not defIds — the lock is on the body Vex pointed at, not on
   * every copy of that card.
   */
  movementLockedUnitInstanceIds: string[];
  /**
   * Whose SPELL is resolving right now, or null.
   *
   * Immortal Phoenix reads "when you kill a unit **with a spell**", and nothing
   * else in the engine could answer that: `killerIndex` says WHO, never with
   * what. Set by `resolveCardEffect` around a Spell's own resolution and cleared
   * immediately after, so it is a fact about the current call rather than
   * anything that persists — which is why `runEnd` does not clear it.
   *
   * Combat damage and activated abilities leave it null, which is exactly the
   * distinction the card draws.
   */
  spellResolvingForIndex: 0 | 1 | null;
  /**
   * Noxian Guillotine's "kill it the next time it takes damage this turn" —
   * units under a delayed, single-use death sentence.
   *
   * A list of instance ids, the same shape `deathWardedUnitInstanceIds` uses for
   * the opposite effect, and for the same reasons: it is per-unit, it expires
   * with the turn, and putting it on the unit would mean every helper that
   * rebuilds a unit had to remember to carry it.
   */
  markedForDeathOnDamageInstanceIds: string[];
  /**
   * Counter Strike's "the NEXT time that unit would be dealt damage this turn,
   * prevent it" — units holding a single-use damage shield.
   *
   * The same list-of-ids shape as `markedForDeathOnDamageInstanceIds` above and
   * `deathWardedUnitInstanceIds`, and for the same three reasons: it is
   * per-unit, it expires with the turn, and putting it on the unit would mean
   * every helper that rebuilds a unit had to remember to carry it.
   *
   * **Distinct from `preventsSpellDamageThisTurn`, which is per-PLAYER and
   * unlimited.** Unyielding Spirit stops everything all turn; this stops one
   * instance on one unit and is then spent — so the id is REMOVED when it
   * fires, which is what "the next time" means.
   *
   * An id may appear more than once: two Counter Strikes on one unit prevent two
   * instances, because each is its own "next time".
   */
  damagePreventedOnceInstanceIds: string[];
  /**
   * Ki Barrier's "prevent the next 7 damage that would be dealt to it this turn"
   * — a per-unit damage POOL that depletes rather than a single-use shield.
   *
   * **Different from `damagePreventedOnceInstanceIds` above in the one way that
   * matters: this one absorbs an AMOUNT and survives.** Counter Strike stops one
   * instance of any size and is spent; this stops 7 points spread over as many
   * instances as it takes, and a 9-damage hit against a full barrier still puts 2
   * through. A list of ids cannot express either half of that.
   *
   * Keyed by instanceId, and the amount REMAINING — so `dealDamage` subtracts
   * what it can and passes the rest on, and the key is dropped when the pool
   * empties. The card's own reminder text is what says the remainder gets
   * through: "opponents can assign it extra combat damage to kill it."
   *
   * Beside its neighbours on the state rather than on the unit, for the three
   * reasons `markedForDeathOnDamageInstanceIds` records: per-unit, expires with
   * the turn, and every helper that rebuilds a unit would otherwise have to
   * remember to carry it.
   *
   * **Two barriers on one unit SUM rather than queue.** 817's summing is about
   * keywords and does not reach this, but nothing in the text makes them separate
   * shields either, and a queue would be observably different only in which one
   * empties first — which nothing can see. Recorded Unverified.
   */
  damagePreventionPoolByInstanceId: Record<string, number>;
  /**
   * How many times each CARD INSTANCE has dealt damage this turn — UNL-020
   * Dancing Grenade's "1 additional Bonus Damage for each time this spell has
   * dealt damage this turn", which is the pool's first text to count a single
   * card's damage INSTANCES rather than their total.
   *
   * **Keyed by instanceId, not defId.** Two copies of Dancing Grenade in one turn
   * are two spells, and each escalates on its own history; a defId key would make
   * the second copy open at the first's tally.
   *
   * **On `GameState` rather than on the card**, the same three reasons the two
   * id lists above give: it expires with the turn, the card moves between zones
   * while it is being counted (hand -> trash -> played again from that trash),
   * and every helper that rebuilds a `CardInstance` would otherwise have to
   * remember to carry it.
   *
   * A count rather than a list of ids, unlike its neighbours, because nothing
   * ever removes one entry — the question asked of it is "how many", and a list
   * would answer it by filtering.
   *
   * Written by `recordCardDamageInstance` and read by `cardDamageInstancesThisTurn`
   * (effect-helpers.ts). `dealDamage` does NOT write it: that function takes no
   * source card, and every other damage in the pool is anonymous, so plumbing a
   * source through 60-odd call sites to serve one card would be the wrong trade.
   * The one resolver that needs the tally keeps it.
   */
  damageInstancesByCardThisTurn: Record<string, number>;
  extraTurns: number;
  /** Whose extra turns those are. Meaningless while `extraTurns` is 0. */
  extraTurnsForIndex: 0 | 1;
  /** Highlander's "the next time it would die this turn, heal it, exhaust
   *  it, and recall it instead" — a flat list of warded unit instanceIds
   *  (not per-player: instanceIds are globally unique), consumed at every
   *  point a unit would actually die (dealDamage's lethal branch in
   *  effect-helpers.ts, combat.ts's Showdown resolution) instead of
   *  trashing it, then cleared for that unit. Reset every runEnd, same
   *  "this turn" lifetime as GameState.java's own set
   *  (TurnManager.java:287-290). */
  /**
   * What the last Combat Showdown's attacking pool spent BEYOND what it took to
   * kill what it was assigned to — Tryndamere - Barbarian's "if you assigned 5
   * or more excess damage to enemy units".
   *
   * On the state because the card that reads it is a HELD conquer trigger: it
   * resolves in the Cleanup after combat has returned, and the number exists
   * nowhere else by then. Carries the battlefield and the attacking side so a
   * conquest at a DIFFERENT battlefield, or one that was not an attack at all,
   * cannot read it — "when I conquer AFTER AN ATTACK" is the clause that check
   * implements.
   */
  lastShowdownExcessDamage: { battlefieldId: string; attackerIndex: 0 | 1; amount: number } | null;
  deathWardedUnitInstanceIds: string[];
  /**
   * Units that will be BANISHED instead of dying, for the rest of this turn —
   * UNL-007 Smite's "if it would die this turn, banish it instead".
   *
   * **Armed in advance and per INSTANCE, which is `deathWardedUnitInstanceIds`'
   * shape above rather than `PendingDeath`'s.** The distinction that list's own
   * neighbours already draw: a replacement OFFERED at the moment of death needs
   * a holding pen, and one armed ahead of time needs only a set of ids. Smite's
   * is mandatory and armed, so it is the cheaper kind.
   *
   * **NOT consumed by use, unlike the ward.** Highlander's is "the NEXT time it
   * would die this turn"; Smite prints no such limit, so the entry stands for the
   * turn. In practice a banished unit cannot die twice, which is why the
   * difference is invisible in play and stated here rather than tested.
   *
   * Cleared at `runEnd` beside the ward — "this turn" is the whole of what
   * bounds it.
   */
  banishOnDeathUnitInstanceIds: string[];
  /**
   * Units taking DOUBLE damage for the rest of this turn — UNL-013 Lotus Trap's
   * "choose a unit. Double all damage that would be dealt to it this turn."
   *
   * Per-instance and turn-scoped, the shape the two lists above already have.
   *
   * **465.2.c.5 makes this behave differently in combat than out of it**, and the
   * rules work this exact card in their own example: "replacement effects that
   * would apply to the resulting damage are considered to apply to the ASSIGNMENT
   * instead ... When that damage is dealt, it doesn't get doubled again — the
   * doubling is considered to have already happened during damage assignment."
   *
   * So combat assigns HALF what it would need (rounded up) and the doubling turns
   * it back into lethal, while a spell simply deals twice. Both halves are read
   * from this one list; see `combat.assignmentNeeded` and `dealDamage`.
   */
  damageDoubledUnitInstanceIds: string[];
  /**
   * Units carrying Unlicensed Armory's ward — the same "next time it would die
   * this turn" window as the list above, but the replacement is OPTIONAL and
   * costs 1 Fury Power, so it stops to ask rather than simply happening.
   *
   * Kept apart from the free list for exactly that reason; see
   * engine/death-ward.ts. Cleared every runEnd alongside it.
   */
  paidDeathWardUnitInstanceIds: string[];
  /**
   * Deaths waiting on a replacement offer — see PendingDeath above. Empty
   * except for the instant between Sett - The Boss's question being raised and
   * answered, which the pending-decision queue guarantees is before any other
   * action can be taken.
   *
   * NOT reset by runEnd, unlike the ward: a death sitting here is mid-resolution
   * rather than a this-turn status, and silently discarding one would make the
   * unit vanish into neither play nor a trash.
   */
  unitsAwaitingDeathReplacement: PendingDeath[];
  /**
   * Units played FOR FREE that are waiting on a placement answer — see
   * engine/free-play.ts.
   *
   * A holding pen for the same reason `unitsAwaitingDeathReplacement` is one:
   * the card has left wherever it came from, and it must not be on the board
   * yet, because ARRIVING is what fires its on-play trigger and what contests a
   * battlefield. Deploying it at base first and moving it afterwards would fire
   * both for the wrong place.
   */
  unitsAwaitingFreePlacement: {
    unit: UnitInstance;
    playerIndex: 0 | 1;
    /** A battlefield this free play may reach even with no presence, because the
     *  effect performing it emptied that battlefield itself (Baited Hook killing a
     *  lone unit). See engine/free-play.ts's destinationsFor. */
    alsoAllowBattlefieldId?: string;
  }[];
  /**
   * Questions the engine has stopped to ask, oldest first.
   *
   * Empty in every settled state — a non-empty queue means a resolution is
   * halfway through, which is why `submit` suppresses the Cleanup while it is
   * (321) and `legalActions` offers nothing but answers to its head.
   *
   * A queue rather than a single slot because one effect can ask more than one
   * question: Cull the Weak asks both players, and "discard 2" asks twice.
   * Resolved strictly front-to-back, so the order questions are asked in is the
   * order they were raised in — which for Cull the Weak is APNAP.
   */
  pendingDecisions: PendingDecision[];
}
