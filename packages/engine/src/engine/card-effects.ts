import type { CardInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import { domainCardEffects, mergeRegistries } from "./effects/index.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import type { EffectContext } from "./effect-context.js";
import {
  giveMightThisTurn,
  giveMightThisTurnToAllFriendlies,
  dealDamage,
  dealDamageToEnemyUnitsAtBattlefield,
  destroyUnit,
  drawCards,
  exhaustOwnUnitAnywhere,
  recallUnitToBase,
  returnCardFromTrash,
  returnUnitToHand,
} from "./effect-helpers.js";
import { effectiveMight } from "./effective-might.js";
import { channelRunesForcedExhausted } from "./channel-cost.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
import { placeRecruitToken, type TokenDestination } from "./token.js";

/**
 * What a card's effect needs from the player before it can resolve — kept
 * as DATA (not part of the resolver function) because target/choice
 * selection happens in validate-play-card.ts/legal-actions.ts, before a
 * PlayCardAction is ever submitted; `resolve` below only ever runs against
 * an already-fully-decided event.
 */
/**
 * Which units a "unit"-style target may be chosen from. Riftbound's card text
 * draws this distinction deliberately and it matters: "Deal 8 to a unit"
 * (Final Spark) can hit a unit standing in either player's BASE, while "Deal 2
 * to a unit at a battlefield" (Incinerate) cannot. Base is not a safe parking
 * spot against the former.
 *
 * Defaults to "battlefield" everywhere it's omitted, which is the majority of
 * this pool — a card only opts into the wider scope when its printed text
 * declines to name a battlefield.
 */
/** Where a "unit"-kind target may be drawn from. `"battlefield"` is the default
 *  because most text says "a unit at a battlefield"; `"anywhere"` is the bare
 *  noun "unit", which 355.9.b makes include Bases. `"base"` is the narrowest and
 *  the newest — Showstopper's "buff a friendly unit IN YOUR BASE, then move it to
 *  a battlefield", where reaching a unit already at a battlefield would make the
 *  move half meaningless. */
export type TargetScope = "battlefield" | "anywhere" | "base";

/** Who may fill one slot of a multi-target spell. `"any"` means either
 *  player's — Singularity's "up to two units" doesn't care whose. */
export type UnitSlotRole = "any" | "friendly" | "enemy";

export type TargetingSpec =
  | { kind: "none" }
  /** `exhaustedOnly` is Arena Bar's "buff an EXHAUSTED friendly unit" — a
   *  restriction on the target's state rather than its owner or its Might, and
   *  the first of that shape. Filtered during enumeration like every other part
   *  of this spec, so a ready unit is never offered and then refused. */
  /**
   * `attackingOnly` is Thwonk!'s "stun an ATTACKING unit" — a restriction on the
   * target's combat DESIGNATION (465 Step 1) rather than on its owner, its Might
   * or its zone, and the first of its kind here.
   *
   * A property of the SPEC rather than a check inside the resolver, for the
   * reason `sameBattlefield` records below: by the time a resolver runs the
   * choice has been made and paid for, so a resolver that refused would leave
   * the card spent and doing nothing. It also has to be the spec so that a card
   * with no legal target is UNCASTABLE rather than castable-and-inert, which is
   * what "the targeting IS the effect" means for a Spell.
   *
   * Implies the target is at a battlefield — a unit in base is never an attacker
   * — but it is NOT the same as `scope: "battlefield"`, which would also offer
   * the defender and every bystander at an uncontested battlefield.
   */
  | {
      kind: "unit";
      owner?: "friendly" | "enemy";
      maxMight?: number;
      scope?: TargetScope;
      exhaustedOnly?: true;
      attackingOnly?: true;
    }
  | { kind: "battlefield" }
  /**
   * A GEAR and nothing else — Rocket Barrage's "Kill a gear".
   *
   * Distinct from `unitOrGear`, which offers units too: that spec is Fading
   * Memories' "a unit at a battlefield OR a gear", one choice across two kinds.
   * This one names a single kind, so reusing `unitOrGear` would offer targets
   * the card cannot legally take.
   *
   * Rides `targetPermanentInstanceId` like `unitOrGear` does, because a gear is
   * still not a unit and must never reach a reader expecting one.
   */
  | {
      kind: "gear";
      /**
       * Whose gear may be chosen — Akshan - Mischievous' "move an ENEMY gear to
       * your base".
       *
       * Absent means either player's, which is Rocket Barrage's "Kill a gear" and
       * Detonate's, so both are untouched. Measured from the CASTER, the same
       * seat every other `owner` on this union is measured from.
       */
      owner?: "friendly" | "enemy";
    }
  | { kind: "ownTrashCard"; cardKind?: "Unit" | "Spell" }
  /**
   * Two ordered target slots with a MINIMUM number that must be filled —
   * the shape the Java oracle uses for every multi-target spell
   * (`TargetSpec(int min, List<Role> slotRoles, ...)`, EffectRegistry.java).
   * It subsumes what used to be a fixed `unitPair`:
   *   - Gentlemen's Duel: `min: 2, slots: ["friendly", "enemy"]`
   *   - Singularity:      `min: 0, slots: ["any", "any"]`      ("up to two")
   * `min: 0` is what makes "up to" real, and is why this isn't called
   * `unitPair` any more — a pair whose minimum is zero would be a lie.
   * The two chosen units must always be DISTINCT (no card in this pool lets
   * one unit fill both slots; the oracle's own `allowsDuplicateTargets` flag
   * exists for cards like Falling Star that do, none of which are here).
   */
  /**
   * `sameBattlefield` is Facebreaker's "stun a friendly unit and an enemy unit
   * **at the same battlefield**" — the first card here whose two targets are
   * related to each other rather than each independently legal. It has to be a
   * property of the SPEC rather than a check inside the resolver, because by the
   * time a resolver runs the choice has already been made and validated: a
   * resolver that refused would leave the card paid for and doing nothing.
   *
   * Implies both targets are at a battlefield, so it is only meaningful with the
   * default `scope`.
   */
  | {
      kind: "unitSlots";
      slots: readonly [UnitSlotRole, UnitSlotRole];
      min: number;
      scope?: TargetScope;
      /**
       * Per-slot scope, for the one card whose two targets are scoped
       * DIFFERENTLY: Zenith Blade's "Stun an enemy unit **at a battlefield**.
       * You may move **a friendly unit** to that enemy unit's battlefield." The
       * first half names a battlefield and the second does not, and rule 355.9.b
       * makes that difference load-bearing — the friendly being moved is usually
       * the one sitting at home.
       *
       * Overrides `scope` slot by slot; falls back to it where absent, so every
       * existing card is unaffected.
       */
      slotScopes?: readonly [TargetScope, TargetScope];
      sameBattlefield?: true;
      /**
       * The two slots take the same ROLE but are not interchangeable, so BOTH
       * orderings of a pair must be enumerated.
       *
       * `legal-actions` prunes (B,A) when it has already offered (A,B) and both
       * slots share a role — correct for Back to Back and Singularity, which do
       * the same thing to both units, and wrong for Convergent Mutation, whose
       * slot 0 is the beneficiary and slot 1 is only measured ("increase its
       * Might TO the Might of another friendly unit"). Without this the card was
       * half unreachable: with a 7-Might and a 2-Might friendly, the one offered
       * pairing was the one that increases by 0.
       *
       * Opt-IN rather than opt-out, so every existing card keeps the pruning that
       * halves the AI's search space, and only a card that actually distinguishes
       * its slots pays for both orderings.
       */
      asymmetricSlots?: true;
      /**
       * The SECOND slot is chosen at the FIRST target's DESTINATION — Dragon's
       * Rage's "move an enemy unit. Then do this: choose another enemy unit at
       * its destination."
       *
       * Distinct from `sameBattlefield`, which compares where the two units
       * already stand. Here the first unit is about to be moved, so the
       * relationship is to a battlefield that is part of the ACTION rather than
       * part of the board — `destinationBattlefieldId`, which `cardMovesTarget`
       * already puts on every variant of a moving card.
       */
      secondAtDestination?: true;
    }
  /**
   * "A unit at a battlefield **or a gear**" — Fading Memories. One choice over
   * two different kinds of permanent, which no other spec expresses: `unit`
   * cannot name a gear, and a second field would let a caster name both.
   *
   * The chosen thing rides on `targetPermanentInstanceId` rather than
   * `targetUnitInstanceId`, so nothing that assumes a unit can be handed a gear.
   */
  /**
   * N ordered targets, chosen when the card is ANNOUNCED — Falling Star's two,
   * Icathian Rain's six, Fox-Fire's "any number".
   *
   * A separate kind from `unitSlots` rather than a widening of it, and
   * deliberately: `unitSlots` is a fixed 2-tuple of ROLES with per-slot owners and
   * scopes, and every one of its cards reads its two targets as doing DIFFERENT
   * things ("a friendly unit and an enemy unit"). Every card here repeats one
   * instruction N times, so the slots are interchangeable and the roles are not
   * per-slot. Folding the two together would mean rewriting every existing card's
   * resolver to read a list, for no card's benefit; the survey's "an ordered list
   * subsumes asymmetricSlots and allowsDuplicateTargets" is still true and is
   * still the eventual shape, just not the cheapest way to get these cards.
   *
   * **Announce-time, which the rules force** — 355: "In order to put a spell or
   * ability on the chain, valid choices must be made for all targets", and
   * Repulse can read another chain item's target set while that item is on the
   * chain. Settled in docs/dead-card-survey-2.md; resolve-time would make a whole
   * archetype unimplementable and hollow out the response window.
   *
   * `legal-actions` emits a BOUNDED SAMPLE of combinations rather than the
   * powerset — six slots over a full board is ~10^5 variants. That is a search
   * limitation for the AI, in the same family as the existing one-ply lookahead;
   * it is not a rules divergence, because `validate-play-card` accepts any legal
   * set and the UI builds one by clicking. Recorded in docs/rules-conformance.md.
   */
  | {
      kind: "unitList";
      /** Mandatory targets. Falling Star is 2 — 355 makes both choices required,
       *  so it is uncastable with no units and castable with one (see
       *  `allowsDuplicates`). "Any number" is 0. */
      min: number;
      /** Undefined is "any number" (Fox-Fire). Volibear's split damage caps at
       *  the damage available, which is where a finite max comes from. */
      max?: number;
      owner?: "friendly" | "enemy";
      scope?: TargetScope;
      /**
       * May one unit fill several slots? The rules' Repeat example settles it for
       * this pool: "if they choose the same mode, may choose the same target or a
       * different one… they must specify which is the first target and which is
       * the second." So Falling Star with one unit on the board is castable and
       * deals 6 to it.
       */
      allowsDuplicates?: true;
      /** Fox-Fire's "units at A battlefield" — every chosen unit at ONE
       *  battlefield, which the PDF works by name. */
      sameBattlefield?: true;
      /**
       * Bellows Breath's "up to three units at the same LOCATION" — strictly
       * WIDER than `sameBattlefield` above, and the difference is a rule rather
       * than a synonym.
       *
       * **828: "Locations include the Battlefields and the Bases."** So three
       * units standing in one player's base share a location and are a legal
       * group, while `sameBattlefield` refuses them — its own comment records
       * that a unit in base "is at no battlefield, so it can never join a
       * group". Each base is its OWN location, so a unit in each base is two
       * locations and not a group.
       *
       * Kept as a separate flag rather than a widening of `sameBattlefield`,
       * because Fox-Fire really does say "at a battlefield" and must keep
       * refusing base units.
       */
      sameLocation?: true;
      /**
       * A GROUP requirement (355): the chosen set must collectively satisfy this
       * when the card is finalized. Fox-Fire's "with total Might 4 or less", read
       * as EFFECTIVE Might — the PDF's worked example turns on a Reaction raising
       * two Recruits' Might after the targets are chosen.
       */
      maxTotalMight?: number;
    }
  /**
   * A SPELL WAITING ON THE CHAIN — Wind Wall's "counter a spell", Defy's
   * cost-restricted version, Mystic Reversal's "gain control of a spell".
   *
   * The first targeting kind that names a chain item rather than a permanent, and
   * it is what makes `[Reaction]` mean anything: every card here is a Reaction,
   * cast onto a chain that is already closed, and resolves BEFORE its target
   * because the chain is LIFO (343).
   *
   * **A spell cannot target itself** — the rules say so outright, and here it is
   * true by construction rather than by a check: `legal-actions` enumerates before
   * the counter is pushed, so the counter is not on the chain to be seen. (The
   * rules' matching exception, that an ABILITY of a permanent CAN target that
   * permanent "because abilities and their sources are separate objects", has no
   * card in this pool.)
   *
   * The cost filters read the target's **printed** cost, which the PDF states as a
   * general rule and then works using Defy by name: "Effects that need to
   * determine a card's cost for any purpose always use its printed or copied
   * cost, even if that cost is increased, decreased, or ignored as the card is
   * played." So Wallop and Call to Glory, whose `ignoresCostWhenPaid` zeroes what
   * they cost to play, are still judged at what they print.
   */
  | {
      kind: "chainSpell";
      maxPrintedEnergy?: number;
      maxPrintedPower?: number;
      /** Not So Fast's "an ENEMY spell ... that chooses a friendly unit or
       *  gear". Two filters about the spell's relation to the COUNTERER rather
       *  than to its own printed cost, which is why they are separate fields
       *  and why `counterableSpells` needs a player index to apply them. */
      enemyOnly?: true;
      choosesFriendlyPermanent?: true;
    }
  /**
   * A SPELL ON THE CHAIN **AND** A UNIT, both named in one announcement —
   * Riposte's "choose a friendly unit and a spell".
   *
   * The pool's first spec that crosses a chain item with a permanent, and it
   * exists rather than being approximated because of what 355.8 does with it:
   * a card whose targeting cannot be satisfied is **uncastable**, so printed
   * Riposte cannot be played with no friendly unit on the board. Choosing the
   * unit later — at resolution, the way `parkDecision` would — makes the card
   * castable in a state the rules forbid, which is WIDER than printed. That is
   * the direction this codebase does not ship, so the kind is real instead.
   *
   * Both halves are therefore asked of `hasAnyLegalEffectChoice` together, and
   * `legal-actions` fans out their CROSS PRODUCT — one variant per (spell, unit)
   * pair, because the rules make each a separate choice the caster announces.
   *
   * `owner`/`scope` mean exactly what they do on the `unit` kind. Riposte passes
   * `scope: "anywhere"`, since "a friendly unit" carries no location word and
   * 355.9.b's bare-noun reading reaches base — the same reading Blitzcrank -
   * Impassive's decision already uses.
   *
   * The cost filters are carried for the same reason `chainSpell` carries them,
   * and read the target's PRINTED cost. Riposte sets neither: it counters any
   * spell.
   */
  | {
      kind: "chainSpellAndUnit";
      owner?: "friendly" | "enemy";
      scope?: TargetScope;
      maxPrintedEnergy?: number;
      maxPrintedPower?: number;
    }
  /**
   * `owner`, `excludesSelf` and `includesFacedown` are Pack of Wonders' — "Return
   * ANOTHER FRIENDLY gear, unit, OR FACEDOWN CARD to its owner's hand."
   *
   * Fading Memories, the kind's original card, wanted neither: "a unit at a
   * battlefield or a gear" names no owner and cannot mean itself (a Spell is not
   * on the board). All three default to off, so it is unchanged.
   *
   * A facedown card is neither a unit nor a gear — it is a card at a battlefield
   * whose identity is hidden — so it needs its own opt-in rather than falling out
   * of the existing walk.
   */
  | { kind: "unitOrGear"; owner?: "friendly"; excludesSelf?: true; includesFacedown?: true }
  /**
   * A unit AND an Equipment **with the same controller** — Angle Shot's "Choose a
   * unit and an Equipment with the same controller. Attach that Equipment to that
   * unit or detach that Equipment from that unit."
   *
   * The first SPELL to name an Equipment alongside a unit. `attachesEquipment`
   * already does this for ACTIVATED abilities (Jax, Forge of the Fluft), but it
   * is a field on the ability rather than a targeting spec, and the spell path
   * fans out from the spec alone — `variantsForTargeting` is handed a
   * `TargetingSpec` and nothing else. Expressing it as a spec is what lets the
   * modal path work unchanged, since each mode already carries its own.
   *
   * **"With the same controller" is a relationship between the two targets**, so
   * it belongs here for the reason `sameBattlefield` records: by the time a
   * resolver runs, the choice is made and paid for, and a resolver that refused
   * would leave the card spent and doing nothing.
   *
   * It is NOT "yours" — the card says "the same controller", not "you control",
   * so an enemy unit and that enemy's Equipment are a legal pair. Angle Shot is a
   * `[Reaction]`, and stripping an opponent's Equipment mid-combat is the play it
   * exists for.
   *
   * The unit rides `targetUnitInstanceId` and the Equipment
   * `targetPermanentInstanceId` — the same separation `unitOrGear` and
   * `attachesEquipment` already keep, so a gear never reaches a reader expecting
   * a unit.
   */
  | {
      kind: "unitAndEquipment";
      /**
       * How the Equipment must stand relative to the chosen unit.
       *
       * `"attachable"` — anything but already on that unit, which is the no-op.
       * Detached Equipment and Equipment worn by another unit both qualify:
       * `attachEquipment` moves one that was attached elsewhere, so "attach that
       * Equipment to that unit" reaches both.
       *
       * `"attachedToIt"` — currently worn by that very unit, which is the only
       * state "detach that Equipment FROM THAT UNIT" can mean.
       */
      relation: "attachable" | "attachedToIt";
      /**
       * Whose UNIT may be chosen. Angle Shot constrains neither side — "the same
       * controller" relates its two targets to each other rather than to the
       * caster — but Relentless Pursuit says "move a FRIENDLY unit" before it
       * mentions an Equipment at all, so the unit half needs its own owner rule.
       *
       * Absent means unconstrained, which is Angle Shot's reading and leaves it
       * untouched.
       */
      owner?: "friendly" | "enemy";
      /**
       * The EQUIPMENT half is a "you may" — Relentless Pursuit's "You may attach
       * an Equipment with the same controller to it".
       *
       * A property of the spec rather than a question asked at resolution,
       * because that is where every other attach choice in this engine is made:
       * `attachesEquipment` and `attachesFromTargetToSelf` both fan out at
       * ANNOUNCE time, and 355 makes a chosen permanent a target — announcing it
       * is what lets an opponent respond to the pairing, exactly as in paper.
       *
       * The consequence is one extra variant per unit, carrying no
       * `targetPermanentInstanceId` at all. Declining has to stay legal even
       * where a legal Equipment exists, which is the same rule the optional
       * additional costs keep.
       */
      optionalEquipment?: true;
    };

/** A slot's role as `eligibleTargets`/validation express owner constraints —
 *  `"any"` is the absence of a constraint, which is `undefined` there. */
export function slotOwner(role: UnitSlotRole): "friendly" | "enemy" | undefined {
  return role === "any" ? undefined : role;
}

/** The scope one slot draws its candidates from — its own if the spec gives it
 *  one, otherwise the spec's. One function rather than the same `??` written out
 *  in the enumerator, the validator and `hasAnyLegalEffectChoice`, which are
 *  exactly the three places that have drifted apart in this codebase before. */
export function slotScope(
  targeting: { scope?: TargetScope; slotScopes?: readonly [TargetScope, TargetScope] },
  slot: 0 | 1,
): TargetScope | undefined {
  return targeting.slotScopes?.[slot] ?? targeting.scope;
}

/** Everything about the caster's choice(s) needed to resolve an effect —
 *  all optional since most effects only need a subset (or none). */
export interface ResolveEvent {
  targetUnitInstanceId?: string;
  /** The second target of a "unitPair"-kind effect (Gentlemen's Duel) —
   *  `targetUnitInstanceId` above is always the FIRST (firstOwner) target. */
  secondTargetUnitInstanceId?: string;
  targetBattlefieldId?: string;
  trashCardInstanceId?: string;
  /** The friendly unit exhausted as Meditation's optional additional cost
   *  ("you may exhaust a friendly unit... if you do, draw 2") — absent means
   *  the caster declined it. See cardHasOptionalExhaustCost below. */
  additionalCostUnitInstanceId?: string;
  /** The units spent for a REPEATABLE additional cost (Kraken Hunter's buffs,
   *  Commander Ledros' kills). A list rather than more of the single field
   *  above, so nothing that reads "the one unit this cost named" can be handed
   *  four of them. */
  additionalCostUnitInstanceIds?: readonly string[];
  /** Where a token-creating Spell puts what it creates (Recruit the
   *  Vanguard) — absent means base. Distinct from a "battlefield"-kind
   *  TARGET: nothing is being targeted, the caster is choosing a deployment
   *  zone. See cardPlacesTokens. */
  destinationBattlefieldId?: string;
  /** The card from hand this play discards — a MANDATORY part of the effect for
   *  Get Excited! ("discard 1, deal its Energy cost as damage"), and an OPTIONAL
   *  additional cost for Brazen Buccaneer ("you may discard 1 ... reduce my cost
   *  by 2"). Singular because no card in this pool lets the caster CHOOSE more
   *  than one; the multi-discards nobody names up front (Jinx, Undercover Agent's
   *  Deathknell) go through discardCards, which asks the player instead. */
  discardCardInstanceId?: string;
  /** The unit OR gear chosen by a `unitOrGear`-kind spec. Deliberately not
   *  `targetUnitInstanceId`: every reader of that field assumes a unit. */
  targetPermanentInstanceId?: string;
  /**
   * The ordered targets of a `unitList`-kind spec — Falling Star's two, Icathian
   * Rain's six, Fox-Fire's any number.
   *
   * ORDERED and possibly REPEATING, which is why it is a list rather than a set:
   * the rules require the caster to say which choice is the first target and
   * which is the second even when both name the same unit, and a card that deals
   * damage per instruction must deal it once per entry.
   *
   * Its own field rather than a widening of `targetUnitInstanceId`, so nothing
   * that reads the single-target field can be handed a list — the same reasoning
   * `targetPermanentInstanceId` records one field up.
   */
  targetUnitInstanceIds?: readonly string[];
  /** The SPELL on the chain a `chainSpell`-kind spec named — by its card's
   *  instanceId rather than by a chain index, because the chain moves between
   *  announcing and resolving and an index would silently come to mean a
   *  different item. */
  targetChainCardInstanceId?: string;
  /** The X of an X-cost card (Bullet Time). See PlayCardAction's own field for
   *  why it is carried rather than counted off the payment. */
  xAmount?: number;
}

/**
 * One option of a MODAL card — Rocket Barrage's "Choose one — Deal 4 to a unit
 * in a base. [or] Kill a gear."
 *
 * Deliberately the same shape as `AbilityMode` in activated-abilities.ts, and
 * for the same stated reason: a plain card becomes ONE unnamed mode, so
 * enumeration, validation and resolution never branch on "is this modal". Those
 * are three places that would each have needed the same new branch, and three
 * places is how a mechanic ends up working in two of them.
 *
 * Each mode carries its OWN targeting, which is the whole difficulty: Rocket
 * Barrage's first mode names a unit in a base and its second names a gear, so
 * there is no single spec that describes the card.
 */
export interface CardMode {
  id: string;
  /** What the board's button says. */
  label: string;
  targeting: TargetingSpec;
  resolve: (state: GameState, ctx: EffectContext, event: ResolveEvent) => GameState;
}

/**
 * A registered Spell/Gear effect.
 *
 * Declare EITHER `targeting` + `resolve` (the ordinary card) OR `modes` (a modal
 * one). `cardModesOf` normalises the two into a single list, so nothing
 * downstream has to know which was written.
 */
export interface EffectDefinition {
  targeting?: TargetingSpec;
  resolve?: (state: GameState, ctx: EffectContext, event: ResolveEvent) => GameState;
  /** The options, for a modal card. Mutually exclusive with the pair above. */
  modes?: readonly CardMode[];
}

/** The synthetic id a non-modal card's single mode carries. Never appears on an
 *  action, since enumeration omits `modeId` when there is only one mode. */
export const SOLE_CARD_MODE = "";

/**
 * Every registered card effect, as a list of modes — one entry for a plain card,
 * N for a modal one, and none at all for an unregistered defId.
 *
 * The normalisation `modesOf` already performs for abilities, applied to cards.
 */
export function cardModesOf(card: CardInstance): readonly CardMode[] {
  const definition = effectForCard(card);
  if (!definition) return [];
  if (definition.modes) return definition.modes;
  if (!definition.resolve) return [];
  return [
    {
      id: SOLE_CARD_MODE,
      label: "",
      targeting: definition.targeting ?? { kind: "none" },
      resolve: definition.resolve,
    },
  ];
}

/** The mode an action named, or the sole mode when the card has one. Returns
 *  undefined when the id names no mode of this card — which the validator
 *  reports rather than silently resolving something the player did not pick. */
export function cardModeOf(card: CardInstance, modeId: string | undefined): CardMode | undefined {
  const modes = cardModesOf(card);
  if (modeId === undefined) return modes.length === 1 ? modes[0] : undefined;
  return modes.find((m) => m.id === modeId);
}

/** The units a `unitSlots` effect was actually pointed at, in slot order,
 *  skipping empty slots — 0, 1 or 2 ids. The three "up to two" cards all
 *  apply the same thing to each chosen unit, so they just iterate this. */
function chosenTargets(event: ResolveEvent): string[] {
  return [event.targetUnitInstanceId, event.secondTargetUnitInstanceId].filter((id): id is string => id !== undefined);
}

/**
 * What a card's OPTIONAL additional cost asks the caster to pick, which decides
 * the candidate list legal-actions.ts fans out:
 *   - `exhaustReadyFriendly` — Meditation, "you may exhaust a friendly unit".
 *   - `spendBuffFriendly`    — Wildclaw Shaman, "you may spend a buff".
 * Both name a friendly unit, but a READY one and a BUFFED one are different
 * sets, so the shape has to be recorded rather than assumed.
 */
/**
 * The two GEAR-valued kinds are SFD's, and they are why this type is no longer
 * only about units: Zaun Punk kills a friendly gear and Legion Quartermaster
 * returns one to hand. The chosen gear rides `additionalCostPermanentInstanceId`
 * rather than the unit field, because a gear must never reach a reader expecting
 * a unit — the same separation `unitOrGear` targeting already keeps.
 */
export type OptionalUnitCost =
  | "exhaustReadyFriendly"
  | "spendBuffFriendly"
  | "killFriendly"
  | "killFriendlyGear"
  | "returnFriendlyGearToHand";

/** Does this cost name a GEAR rather than a unit? One predicate, asked by the
 *  enumerator and both validators, so the three cannot disagree about which
 *  field the choice rides on. */
export function costNamesGear(kind: OptionalUnitCost): boolean {
  return kind === "killFriendlyGear" || kind === "returnFriendlyGearToHand";
}

/** Whether the cost may be declined. Rule 805 calls Accelerate an "Optional
 *  Additional Cost"; Cruel Patron's "As an additional cost to play me, kill a
 *  friendly unit" carries no "you may" and so is mandatory — which also makes
 *  the card unplayable with no friendly unit to kill. */
export interface UnitCostSpec {
  kind: OptionalUnitCost;
  mandatory?: true;
  /** Call to Glory's "If you do, **ignore this spell's cost**" — paying the
   *  additional cost replaces the printed one rather than adding to it.
   *
   *  IGNORED, not discounted, so it takes the same shape rule 811 gives a card
   *  played from Hidden: the payment must be EMPTY rather than merely small, and
   *  floating resources and cost modifiers all drop out with it. That also means
   *  the card is castable with no runes at all, which is the whole point — so
   *  affordability must be judged per variant, not once per card. */
  ignoresCostWhenPaid?: true;
  /**
   * Kraken Hunter's and Commander Ledros' "any NUMBER of" — the cost may be paid
   * several times over, each payment discounting the card by 1 Power.
   *
   * The count is bounded by the printed Power cost rather than by the board:
   * "reduce my cost by [1 Power] for each" cannot take a cost below zero, so
   * spending a fifth buff on a 4-Power Ledros buys nothing. That is what keeps
   * the enumeration to at most six variants per card instead of the powerset of
   * your own units — and it is a property of the card, not a cap this engine
   * invented.
   *
   * WHICH units are spent still matters (Ledros is choosing what to kill), so
   * `legal-actions` samples by a deterministic heuristic and
   * `validate-play-card` accepts any legal set — the same split `unitList`
   * targeting makes, and for the same reason: a human clicking their own choice
   * must not be limited to what the AI's sampler happened to emit.
   */
  repeatable?: true;
}

/**
 * Cards with an optional friendly-unit cost. The choice must already be decided
 * in the submitted action — legal-actions.ts fans out a "decline" variant plus
 * one variant per eligible unit — same reasoning as every other choice in this
 * file, just orthogonal to TargetingSpec because it is a COST, not a target the
 * effect acts on.
 *
 * Units belong here as well as Spells. This was a `Set` gated on
 * `card.kind === "Spell"` at both call sites, which meant a Unit trigger could
 * not express "you may" at all: Wildclaw Shaman had to smuggle the choice onto
 * its ordinary target field, and the decline then vanished in the corner case
 * where every friendly unit was already buffed — turning "you may" into "you
 * must". The decline variant is now always offered.
 */
const OPTIONAL_UNIT_COSTS: Record<string, UnitCostSpec> = {
  // SFD's two GEAR-valued costs, the first additional costs in the pool paid
  // with a permanent that is not a unit.
  //
  // Zaun Punk's is OPTIONAL ("you may kill a friendly gear as an additional
  // cost"), so it fans out a decline; Legion Quartermaster's is MANDATORY ("As
  // an additional cost to play me, return a friendly gear to its owner's hand")
  // and therefore makes him unplayable with no gear of your own — the same shape,
  // and the same consequence, as Cruel Patron's kill below.
  "SFD-160": { kind: "killFriendlyGear" },
  "SFD-044": { kind: "returnFriendlyGearToHand", mandatory: true },
  "OGN-048": { kind: "exhaustReadyFriendly" }, // Meditation
  "OGN-147": { kind: "spendBuffFriendly" }, // Wildclaw Shaman
  // Cruel Patron — "As an additional cost to play me, kill a friendly unit."
  // No "you may", so there is no decline variant and the card simply cannot be
  // played with nothing of yours to kill.
  "OGN-208": { kind: "killFriendly", mandatory: true },
  // Call to Glory — "As you play this, you may spend a buff as an additional
  // cost. If you do, ignore this spell's cost." Same buff-spending cost as
  // Wildclaw Shaman; what is new is that paying it REPLACES the printed cost.
  "OGN-207": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true },
  // Wallop — "[Action] As you play this, you may spend a buff as an additional
  // cost. If you do, ignore this spell's cost. Ready a unit." Byte-identical in
  // shape to Call to Glory above; the second card in the pool to REPLACE its
  // printed cost rather than discount it, which is why `ignoresCostWhenPaid`
  // was built as a flag rather than as one card's special case.
  "OGN-146": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true },
  // Kraken Hunter — "As you play me, you may spend ANY NUMBER of buffs as an
  // additional cost. Reduce my cost by [1 Body] for each buff you spend."
  "OGN-150": { kind: "spendBuffFriendly", repeatable: true },
  // Commander Ledros — "As you play me, you may kill ANY NUMBER of friendly
  // units as an additional cost. Reduce my cost by [1 Order] for each killed
  // this way." Same shape as Kraken Hunter with a harsher price, and it is why
  // `repeatable` is a flag rather than one card's special case.
  "OGN-231": { kind: "killFriendly", repeatable: true },
};

/**
 * Cards with an optional POWER additional cost — Clockwork Keeper's "you may pay
 * [1 Calm] as an additional cost to play me. When you play me, if you paid the
 * additional cost, draw 1."
 *
 * Distinct from `OPTIONAL_UNIT_COSTS` above, which is paid with a chosen
 * PERMANENT: this is paid with runes, so there is nothing to choose and nothing
 * to ride on the action except whether it was paid. That is `[Accelerate]`'s
 * shape (805) — one boolean, two enumerated variants, priced apart — but it gets
 * its OWN action field rather than borrowing `acceleratePaid`: that flag also
 * means "this unit enters ready", is gated on the printed keyword, and is read
 * by `unitEntersReady`. Sharing it would have made a Clockwork Keeper enter ready
 * for free.
 *
 * **The DOMAIN is recorded here, not taken from `card.powerDomain`**, and that is
 * not tidiness: Clockwork Keeper prints ZERO Power, so its `powerDomain` is null
 * and pricing against it accepted a rune of any domain — the optional cost was
 * offered to a player holding nothing but Fury. The domain the pip shows is the
 * card's own, and the only place that survives a 0-Power printing is a table.
 */
const OPTIONAL_POWER_COSTS: Readonly<Record<string, { domain?: Domain; count?: number; energy?: number }>> = {
  "OGN-044": { domain: "Calm", count: 1 }, // Clockwork Keeper — "you may pay [1 Calm] as an additional cost"
  // SFD's three, and between them they are why every field above is optional.
  // The table was Power-only because Clockwork Keeper is; these print an Energy
  // pip beside the rune, or instead of it.
  "SFD-013": { energy: 1, domain: "Fury", count: 1 }, // Blast Corps Cadet — [1][Fury]
  "SFD-067": { domain: "Mind", count: 1 }, // Frostcoat Cub — [Mind], no Energy
  "SFD-098": { energy: 1 }, // Sea Monkey — [1], no rune at all
  // Akshan - Mischievous — [Body][Body]. The pool's first optional cost of TWO
  // runes; every other one is a single pip, which is why `count` had never been
  // exercised above 1.
  "SFD-109": { domain: "Body", count: 2 },
};

/**
 * Cards with an X RAINBOW POWER cost — Bullet Time's "pay any amount of
 * [rainbow] to deal that much damage to all enemy units at a battlefield".
 *
 * A set rather than a per-card amount, because X is by definition the caster's
 * choice: `legal-actions` fans out one variant per affordable X and
 * `validate-play-card` re-derives the price from the X the action names.
 *
 * RAINBOW, so it rides the `rainbowRunes` bucket `[Deflect]` already built — the
 * one bucket whose runes are not domain-checked against the card.
 */
const X_RAINBOW_COST_DEF_IDS = new Set(["OGN-268"]); // Bullet Time

/**
 * Cards whose optional additional cost is EXHAUSTING YOUR LEGEND — Bard -
 * Mercurial's "You may exhaust your legend as an additional cost to play me."
 *
 * A set rather than a `UnitCostSpec` kind, and the reason is that there is
 * nothing to choose: a player has one Legend, so the cost is a boolean and not a
 * pick. `OPTIONAL_UNIT_COSTS` exists to fan a variant out per eligible permanent
 * and to carry the chosen id on the action; both would be dead weight here, and
 * the id would ride a field named for units on a card that is not one.
 *
 * So this is `OPTIONAL_POWER_COSTS`' shape — two enumerated variants and one flag
 * the trigger reads — differing only in what is spent. The flag is
 * `exhaustLegendPaid`; see its note on `PlayCardAction` for why it is not shared.
 */
const OPTIONAL_LEGEND_EXHAUST_DEF_IDS = new Set(["SFD-079"]); // Bard - Mercurial

/** Does this card offer to be paid for by exhausting its caster's Legend? */
export function costExhaustsLegend(defId: string): boolean {
  return OPTIONAL_LEGEND_EXHAUST_DEF_IDS.has(defId);
}

/** Does this card ask the caster for an X of rainbow Power? */
export function hasXRainbowCost(defId: string): boolean {
  return X_RAINBOW_COST_DEF_IDS.has(defId);
}

/** What extra Power this card MAY be played for, or undefined. */
export function optionalPowerCostOf(defId: string): { domain?: Domain; count?: number; energy?: number } | undefined {
  return OPTIONAL_POWER_COSTS[defId];
}

/**
 * `[Repeat]`'s additional cost — rule 820.1.
 *
 * "Repeat is an Optional Additional Cost keyword ... The Cost is an Additional
 * Cost to be paid during the steps of playing the spell or ability", and
 * 820.1.d spells the keyword out in full: *"You may pay [Cost] as an additional
 * cost as you play this. If you do, execute the instructions of this chain item
 * one additional time during resolution."*
 *
 * The `domain` is recorded here rather than read off `card.powerDomain`, for the
 * reason `OPTIONAL_POWER_COSTS` records one table up — a printed cost and an
 * additional cost are two different pips and nothing makes them agree. For all
 * fourteen cards in this pool they DO agree, and `repeat-cost-table.test.ts`
 * asserts it card by card rather than leaving it as a comment: the day a set
 * prints a Repeat cost in a domain the card itself does not, that test fails
 * instead of the pricing quietly accepting the wrong rune.
 *
 * `rainbowPower` is its own field for the same reason `RunePayment` gives the
 * rainbow bucket its own: Danger Zone's Repeat is `[1][rainbow]`, and a rainbow
 * pip is by definition not domain-checked. Folding it into `power` above would
 * have priced it against Danger Zone's Mind and refused a Fury rune the rules
 * accept.
 */
export interface RepeatCostSpec {
  energy: number;
  power?: number;
  /** Only meaningful when `power` is set. */
  domain?: Domain;
  /** Rainbow Power — any domain (Danger Zone). */
  rainbowPower?: number;
}

/**
 * Every card printing `[Repeat]`, with the cost it asks for.
 *
 * A table rather than a parse of the reminder text, and deliberately: the pip
 * run after `[Repeat]` is the ONLY place the cost appears, the text carries it
 * as emoji shortcodes (`:rb_energy_2::rb_rune_fury:`), and a mis-parse would
 * silently under-price a card rather than fail. Fourteen entries is cheaper to
 * read than the grammar that would replace them.
 *
 * **Each of these prints exactly ONE instance of Repeat**, checked across the
 * set. 820.1.c.2/c.3 ("if a spell or ability has more than one instance of
 * Repeat, each Cost may be paid or not paid individually... each Repeat Cost can
 * be paid only a single time") therefore has no card to exercise it here, so
 * this models one instance and `repeat-cost-table.test.ts` asserts the premise —
 * the day a set prints two, that test fails and this shape is what changes.
 *
 * Temporal Portal (SFD-078) is absent on purpose: it GRANTS Repeat "equal to its
 * cost" to another spell rather than printing one of its own, so its cost is not
 * a constant and cannot live in a table. See `grantedRepeatCostFor`.
 */
const REPEAT_COSTS: Readonly<Record<string, RepeatCostSpec>> = {
  "SFD-003": { energy: 1 }, // Blood Rush — [Repeat] [1]
  "SFD-023": { energy: 2, power: 1, domain: "Fury" }, // Piercing Light — [Repeat] [2][Fury]
  "SFD-031": { energy: 2 }, // Desert's Call — [Repeat] [2]; 820.1.d's own worked example
  "SFD-034": { energy: 2 }, // Feral Strength — [Repeat] [2]
  "SFD-040": { energy: 2 }, // Thwonk! — [Repeat] [2]
  "SFD-066": { energy: 2 }, // Frigid Touch — [Repeat] [2]
  "SFD-077": { energy: 4, power: 1, domain: "Mind" }, // Rocket Barrage — [Repeat] [4][Mind]
  "SFD-080": { energy: 1, power: 1, domain: "Mind" }, // Bellows Breath — [Repeat] [1][Mind]
  "SFD-114": { energy: 3 }, // Marching Orders — [Repeat] [3]
  "SFD-122": { energy: 0, power: 1, domain: "Chaos" }, // Called Shot — [Repeat] [Chaos], no Energy at all
  "SFD-129": { energy: 2 }, // Temptation — [Repeat] [2]
  "SFD-136": { energy: 2 }, // Hard Bargain — [Repeat] [2]
  "SFD-151": { energy: 2 }, // Bonds of Strength — [Repeat] [2]
  "SFD-182": { energy: 1, rainbowPower: 1 }, // Danger Zone — [Repeat] [1][rainbow]
};

/** What this card's `[Repeat]` costs, or undefined if it has none. */
/**
 * The GRANTED `[Repeat]` cost a spell has while Temporal Portal's grant is armed
 * — "[Repeat] equal to its cost", so the card's whole printed cost, Energy pip
 * and Power pip both.
 *
 * PRINTED, not effective: 874's Defy example is the rules being explicit that a
 * card's cost for reference purposes is what it prints, and every discount in
 * this engine reduces what a play COSTS rather than what the card is. A version
 * reading the discounted figure would make a Marai Spire cheapen the grant too,
 * which is a different card's text.
 *
 * `undefined` when nothing is armed, so the caller's shape matches
 * `repeatCostOf`'s exactly — the two are asked side by side everywhere.
 */
export function grantedRepeatCostOf(
  card: { energyCost: number; powerCost: number; kind: string },
  grantsArmed: number,
): RepeatCostSpec | undefined {
  // GEAR and UNITS are not spells, and the card says "the next SPELL you play".
  if (grantsArmed <= 0 || card.kind !== "Spell") return undefined;
  return { energy: card.energyCost, power: card.powerCost };
}

export function repeatCostOf(defId: string): RepeatCostSpec | undefined {
  return REPEAT_COSTS[defId];
}

/** Every defId printing `[Repeat]` — for the table test, and for the coverage
 *  gate that has to know which cards the keyword still greys. */
export function repeatCostDefIds(): string[] {
  return Object.keys(REPEAT_COSTS);
}

/**
 * Cards that make the caster pick a card from hand to discard.
 *
 * Two different roles, one field, because both are "which card from hand":
 *  - `optional: false` — the discard is part of the EFFECT. Get Excited! deals
 *    damage equal to the discarded card's Energy cost, so which card is chosen
 *    changes the outcome and there is no declining it.
 *  - `optional: true` with an `energyDiscount` — the discard is an additional
 *    COST. Brazen Buccaneer's "you may discard 1 ... reduce my cost by 2", so
 *    declining is a real option and paying changes the price.
 */
export interface DiscardChoiceSpec {
  optional: boolean;
  /** Energy taken off the card's own cost when the discard is paid. */
  energyDiscount?: number;
}

const DISCARD_CHOICE_CARDS: Record<string, DiscardChoiceSpec> = {
  "OGN-008": { optional: false }, // Get Excited! — discard 1, damage = its Energy cost
  "OGN-002": { optional: true, energyDiscount: 2 }, // Brazen Buccaneer — optional cost, -2 Energy
};

/** How this card uses a discard choice, or undefined if it doesn't. */
export function discardChoiceOf(defId: string): DiscardChoiceSpec | undefined {
  return DISCARD_CHOICE_CARDS[defId];
}

/** Which additional cost this card asks for, or undefined if it has none. */
export function optionalUnitCostOf(defId: string): UnitCostSpec | undefined {
  return OPTIONAL_UNIT_COSTS[defId];
}

export function cardHasOptionalExhaustCost(defId: string): boolean {
  return OPTIONAL_UNIT_COSTS[defId] !== undefined;
}

/** Spells that create units and let the caster pick where they land — "your
 *  base or battlefields you control" (Recruit the Vanguard). Orthogonal to
 *  TargetingSpec for the same reason the exhaust cost above is: it's a
 *  DEPLOYMENT zone, not a target the effect acts on, and it rides on the
 *  action's existing `destinationBattlefieldId` rather than a new field.
 *
 *  Note "control", not merely "have units at" — a strictly narrower rule than
 *  the Unit direct-deploy check in validate-play-card.ts, and deliberately so:
 *  the oracle flags the same distinction as a real difference rather than a
 *  copy-paste (ActionValidator.java:1487-1504). */
const TOKEN_PLACEMENT_SPELL_DEF_IDS = new Set([
  "OGS-015", // Recruit the Vanguard
  "OGN-094", // Sprite Call
  // Arise! — "Play a 2 Might Sand Soldier unit token for each Equipment you
  // control." No parenthetical, so all of them land at ONE chosen destination
  // exactly as Recruit the Vanguard's four do; the card that DOES print a
  // per-token split (Vanguard Armory) is an activated ability and reaches its
  // destinations another way.
  "SFD-198",
]);

export function cardPlacesTokens(defId: string): boolean {
  return TOKEN_PLACEMENT_SPELL_DEF_IDS.has(defId);
}

/** Spells that MOVE their target and so need a destination as well as a target —
 *  Charm's "Move an enemy unit." Rides on the same `destinationBattlefieldId`
 *  the token-placing spells use, for the same reason: it is a place, not a
 *  second target. Unlike those, it is mandatory — a move with nowhere to go is
 *  not a move, so a card here is not offered without one. */
const MOVE_TARGET_SPELL_DEF_IDS = new Set([
  "OGN-043", // Charm — "Move an enemy unit."
  // Showstopper — "Buff a friendly unit in your base, THEN MOVE IT to a
  // battlefield." The move is the second half of one instruction rather than a
  // separate effect, so it needs the same destination field; what differs from
  // Charm is only whose unit it is, which the targeting spec says.
  "OGN-270",
  // Ride The Wind — "[Action] Move a friendly unit and ready it."
  "OGN-173",
  // Stormbringer — "Choose a friendly unit in your base. Deal damage equal to
  // its Might to all enemy units at a battlefield, then move your unit there."
  // The destination is doing double duty here: it names both what is damaged and
  // where the unit ends up. One field, because the card names one battlefield.
  "OGN-250",
  // Dragon's Rage — "Move an enemy unit. Then do this: choose ANOTHER enemy unit
  // at its destination." The only card here whose destination also constrains a
  // SECOND target — see `secondAtDestination` on the targeting spec.
  "OGN-258",
  // Temptation — "Move an enemy unit to a location where there's a unit with the
  // same controller." The first card whose DESTINATION is restricted rather than
  // free — see `moveDestinationAllowed`.
  "SFD-129",
  // Relentless Pursuit — "[Action] Move a friendly unit. You may attach an
  // Equipment with the same controller to it. This turn, that unit has 'When I
  // conquer, you may move me to my base.'" The first card here whose move
  // composes with a SECOND choice on the same target (the Equipment); the
  // destination axis and the `unitAndEquipment` axis are independent, and
  // `withDestinations` already fans one over the other.
  "SFD-184",
]);

/**
 * Cards whose move destination must already hold a unit with the SAME CONTROLLER
 * as the unit being moved — Temptation's "to a location where there's a unit
 * with the same controller".
 *
 * Every other move-target spell in the pool is deliberately unrestricted (see
 * `validate-play-card`'s note on Charm: the unit being moved is not yours, so
 * "a battlefield you control" would be the wrong test entirely). This is the
 * first that names a condition, and it is a condition on the DESTINATION rather
 * than on the target — which is why it needs its own predicate instead of a
 * targeting-spec field.
 */
const MOVE_DESTINATION_NEEDS_SAME_CONTROLLER = new Set(["SFD-129"]);

/**
 * May this card move that unit to that battlefield?
 *
 * True for every card with no destination restriction, so the enumerator and the
 * validator can both call it unconditionally. The ONE function both ask, for the
 * reason this file keeps repeating: a destination offered by one and refused by
 * the other is the offered-then-refused split.
 *
 * "A unit with the same controller" excludes the MOVED unit itself — it is not
 * there yet, and a card that counted it would let any enemy unit move anywhere
 * its own body could reach, which is no restriction at all.
 */
export function moveDestinationAllowed(
  state: GameState,
  defId: string,
  movedUnitInstanceId: string | undefined,
  destinationBattlefieldId: string,
): boolean {
  if (!MOVE_DESTINATION_NEEDS_SAME_CONTROLLER.has(defId)) return true;
  if (movedUnitInstanceId === undefined) return false;
  const moved = findUnitAnywhere(state, movedUnitInstanceId);
  const destination = state.battlefields.find((bf) => bf.id === destinationBattlefieldId);
  if (!moved || !destination) return false;
  const controllerId = state.players[moved.ownerIndex].id;
  return (destination.units[controllerId] ?? []).some((u) => u.instanceId !== movedUnitInstanceId);
}

export function cardMovesTarget(defId: string): boolean {
  return MOVE_TARGET_SPELL_DEF_IDS.has(defId);
}

/**
 * The first slice of card-effect resolution, growing one phase at a time
 * per the project's phased card-effects plan — every other Spell/Gear/Unit
 * ability remains an honest no-op at resolution until it's added here,
 * mirroring the Java oracle's own EffectRegistry (registry/EffectRegistry.java),
 * a name-keyed registry of resolver closures, just keyed by defId instead
 * of printed name.
 *
 * Cannon Barrage (OGN-127) used to be listed here as deliberately unregistered,
 * because it could only be cast when there was nothing "in combat" to hit. That
 * blocker was reaction-speed timing, which now exists — the card is implemented
 * in effects/body.ts.
 */
const CARD_EFFECTS: Record<string, EffectDefinition> = {
  "OGS-003": {
    // Incinerate — Deal 2 to a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 2),
  },
  "OGN-085": {
    // Falling Comet — Deal 6 to a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 6),
  },
  "OGS-022": {
    // Final Spark — "Deal 8 to a unit." No battlefield named, so this reaches
    // a unit in either player's base too.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 8),
  },
  "OGS-012": {
    // Blast of Power — Kill a unit at a battlefield.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => destroyUnit(state, event.targetUnitInstanceId!, ctx.casterIndex),
  },
  "OGS-024": {
    // Decisive Strike — Give friendly units +2 Might this turn.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllFriendlies(state, ctx.casterIndex, 2),
  },
  "OGN-005": {
    // Disintegrate — Deal 3 to a unit at a battlefield. If this kills it, draw 1.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId!;
      const location = findUnitOnBattlefield(state, targetId);
      if (!location) return state;
      const damaged = dealDamage(state, ctx.casterIndex, targetId, 3);
      // "If this kills it" is answered by the BOARD, not by re-deriving the
      // arithmetic. Doing the math here got it wrong in both directions:
      // it ignored bonus damage (Annie - Fiery makes this deal 4, and she
      // sits in the same precon as this card, so a 4-Might unit died with no
      // draw), and it ignored continuous auras (a 3-Might unit standing with
      // Garen - Commander survives at 4, and drew a card anyway). Checking
      // the owner's trash also gets Highlander's ward right for free — a
      // warded unit is recalled to base instead of dying, so it never lands
      // in trash and correctly yields no draw.
      const died = damaged.players[location.ownerIndex].trash.some((c) => c.instanceId === targetId);
      return died ? drawCards(damaged, ctx.casterIndex, 1) : damaged;
    },
  },
  "OGS-002": {
    // Firestorm — Deal 3 to all enemy units at a battlefield.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, event.targetBattlefieldId!, 3),
  },
  "OGN-129": {
    // Confront — Units you play this turn enter ready. Draw 1.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = { ...players[ctx.casterIndex], unitsEnterReadyThisTurn: true };
      return drawCards({ ...state, players }, ctx.casterIndex, 1);
    },
  },
  "OGN-206": {
    // Back to Back — "Give two friendly units each +2 Might this turn." No
    // battlefield named, so units at home count.
    //
    // **`min: 2`, changed 2026-08-06 on a project-owner ruling that REVERSES an
    // earlier one.** This comment used to read "`min: 0`, not 2, even though the
    // text says two ... (project owner's call)". The later ruling is general: a
    // card printing a bare fixed count with NO "up to" is strict, per 355.8
    // ("valid choices must be made for all targets"), and Back to Back was the
    // only card in the pool still taking the looser reading.
    //
    // The consequence is real and is the point of writing it down: with one
    // friendly unit the card is now UNCASTABLE rather than buffing that one. It
    // is strictly worse for its controller, and it is in preset decks.
    //
    // Cards that genuinely print "up to" (Kinkou Monk) or "any number"
    // (Emperor's Divide, Bullet Time) keep `min: 0` — that is what those words
    // mean, and the ruling does not touch them.
    //
    // The oracle auto-picks here (`Math.min(2, friendlies.size())`,
    // OriginEffects.java:343-346) — an oracle gap rather than a rules statement:
    // WHICH two units get +2 is a real decision, so it is the player's.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = giveMightThisTurn(next, id, 2);
      return next;
    },
  },
  "OGN-095": {
    // Stupefy — "Give a unit -1 Might this turn, to a minimum of 1 Might.
    // Draw 1." No battlefield named — reaches base units, either player's.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      // The floor is on the unit's REAL Might, so it routes through
      // effectiveMight like every other Might question — a unit printed at 1
      // but standing at 2 under an aura can still be debuffed by this.
      const currentMight = location
        ? effectiveMight(
            state,
            location.unit,
            location.ownerIndex,
            location.zone === "base"
              ? { isCombat: false }
              : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id },
          )
        : 0;
      const debuffed = currentMight > 1 ? giveMightThisTurn(state, event.targetUnitInstanceId!, -1) : state;
      return drawCards(debuffed, ctx.casterIndex, 1);
    },
  },
  "OGN-046": {
    // En Garde — "Give a friendly unit +1 Might this turn, then an additional
    // +1 if it is the only unit you control there." Names no battlefield, so
    // a unit in your own base is a legal target, and "there" then means the
    // base: a lone unit at home gets the full +2, exactly as a lone unit at a
    // battlefield does. (Project owner's rules call — base is a location.)
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      const boosted = giveMightThisTurn(state, event.targetUnitInstanceId!, 1);
      if (!location) return boosted;
      const caster = state.players[ctx.casterIndex];
      const unitsThere =
        location.zone === "base"
          ? caster.baseUnits.length
          : (state.battlefields[location.zone.battlefieldIndex]!.units[caster.id]?.length ?? 0);
      return unitsThere === 1 ? giveMightThisTurn(boosted, event.targetUnitInstanceId!, 1) : boosted;
    },
  },
  "OGN-105": {
    // Singularity — "Deal 6 to each of up to two units." Either owner's, and
    // no battlefield named so base counts.
    //
    // This used to auto-pick the first two units in play, which was not a
    // simplification but a self-inflicted wound: that list started with the
    // CASTER's own base units, so casting it with two units at home dealt 6
    // to each of them. Now it only ever hits what the caster actually chose.
    targeting: { kind: "unitSlots", slots: ["any", "any"], min: 0, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = dealDamage(next, ctx.casterIndex, id, 6);
      return next;
    },
  },
  "OGS-011": {
    // Flash — "Move up to 2 friendly units to base." Battlefield-scoped on
    // purpose despite naming no battlefield: moving a unit that's already in
    // base TO base is a no-op, so offering it as a target would be offering
    // a choice that does nothing.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 0 },
    resolve: (state, _ctx, event) => {
      let next = state;
      for (const id of chosenTargets(event)) next = recallUnitToBase(next, id);
      return next;
    },
  },
  "OGN-169": {
    // Gust — Return a unit at a battlefield with 3 Might or less to its owner's hand.
    targeting: { kind: "unit", maxMight: 3 },
    resolve: (state, _ctx, event) => returnUnitToHand(state, event.targetUnitInstanceId!),
  },
  "OGN-134": {
    // Mobilize — Channel 1 rune exhausted. If you can't, draw 1.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const actor = state.players[ctx.casterIndex];
      return actor.runeDeck.length > 0
        ? channelRunesForcedExhausted(state, ctx.casterIndex, 1)
        : drawCards(state, ctx.casterIndex, 1);
    },
  },
  "OGN-170": {
    // Morbid Return — Return a unit from your trash to your hand.
    targeting: { kind: "ownTrashCard", cardKind: "Unit" },
    resolve: (state, ctx, event) => returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId!),
  },
  "OGS-020": {
    // Highlander — "Choose a friendly unit. The next time it would die this
    // turn, heal it, exhaust it, and recall it instead." This used to be
    // battlefield-only on the reasoning that nothing could kill a base unit
    // anyway — no longer true now that dealDamage/destroyUnit reach base
    // (Final Spark, Singularity), so warding a unit at home is a real play.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => ({
      ...state,
      deathWardedUnitInstanceIds: [...state.deathWardedUnitInstanceIds, event.targetUnitInstanceId!],
    }),
  },
  "OGN-048": {
    // Meditation — As an additional cost, you may exhaust a friendly unit.
    // If you do, draw 2. Otherwise draw 1. The unit can be in base OR at a
    // battlefield (the card's text has no battlefield restriction, unlike
    // most "unit" targeting in this file) — see cardHasOptionalExhaustCost.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      if (event.additionalCostUnitInstanceId !== undefined) {
        const exhausted = exhaustOwnUnitAnywhere(state, ctx.casterIndex, event.additionalCostUnitInstanceId);
        return drawCards(exhausted, ctx.casterIndex, 2);
      }
      return drawCards(state, ctx.casterIndex, 1);
    },
  },
  "OGS-008": {
    // Gentlemen's Duel — Give a friendly unit +3 Might this turn. Then
    // choose an enemy unit. They deal damage equal to their Mights to each
    // other. Both Mights are snapshotted (effectiveMight, post-buff) BEFORE
    // either damage instance is dealt, so neither unit's own damage from
    // this exchange can affect the other's dealt amount — mirrors the Java
    // oracle's own resolution order (OriginEffects.java: buff, snapshot
    // both currentMight, then deal both damages).
    // Neither target names a battlefield, so either duellist may be standing
    // in its owner's base. `min: 2` — unlike the "up to two" cards, a duel
    // needs both participants, so this stays uncastable without them.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId!;
      const enemyId = event.secondTargetUnitInstanceId!;
      const boosted = giveMightThisTurn(state, friendlyId, 3);

      const friendlyLocation = findUnitAnywhere(boosted, friendlyId);
      const enemyLocation = findUnitAnywhere(boosted, enemyId);
      if (!friendlyLocation || !enemyLocation) return boosted;

      const mightCtx = (location: typeof friendlyLocation) =>
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: boosted.battlefields[location.zone.battlefieldIndex]!.id };
      const friendlyMight = effectiveMight(boosted, friendlyLocation.unit, friendlyLocation.ownerIndex, mightCtx(friendlyLocation));
      const enemyMight = effectiveMight(boosted, enemyLocation.unit, enemyLocation.ownerIndex, mightCtx(enemyLocation));

      const afterEnemyDamage = dealDamage(boosted, ctx.casterIndex, enemyId, friendlyMight);
      return dealDamage(afterEnemyDamage, ctx.casterIndex, friendlyId, enemyMight);
    },
  },
  "OGS-015": {
    // Recruit the Vanguard — "Play four 1-Might Recruit unit tokens. (They
    // can be played to your base or to battlefields you control.)"
    //
    // All four go to ONE chosen destination, matching the oracle's own
    // resolution (`for (int i = 0; i < 4; i++) ctx.createRecruitToken(
    // ctx.chosenBattlefield())`, OriginEffects.java:672-674) — the card's
    // parenthetical describes where tokens MAY go, not a promise of a
    // per-token split. That destination rides on the action's own
    // `destinationBattlefieldId` (absent = base), the same field a Unit
    // already uses, rather than a new one; see cardPlacesTokens for how the
    // "battlefields you CONTROL" restriction is enforced, which is
    // deliberately stricter than the Unit deploy rule's mere presence check.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const destination: TokenDestination =
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base";
      let next = state;
      for (let i = 0; i < 4; i++) next = placeRecruitToken(next, ctx.casterIndex, destination);
      return next;
    },
  },
};

/**
 * Every Spell/Gear effect: the ones written inline above, plus everything the
 * per-domain files under `effects/` contribute. Merged with duplicate detection,
 * so a defId registered in two places throws at import rather than one
 * implementation silently shadowing the other — see effects/index.ts.
 *
 * NEW cards belong in `effects/<domain>.ts`, not in the record above. One file
 * per owning domain is what lets the rest of the card pool be worked on in
 * parallel without two editors ever touching the same file. The inline entries
 * stay where they are because they're already done and tested — file ownership
 * only matters for work in flight, and moving them would be churn.
 */
/**
 * Composed LAZILY, on first lookup, rather than at module load — and that is
 * load-bearing.
 *
 * This module sits in an import cycle that predates the domain files:
 * card-effects -> effect-helpers -> target-lookup -> card-effects (target-lookup
 * needs `slotOwner` at runtime). The cycle was harmless because nothing here ran
 * at import time; the CARD_EFFECTS literal only *stores* closures. Merging at
 * module scope broke that — it reads an imported binding from a module that is
 * still in flight, which surfaced as `Object.entries(undefined)` and took the
 * whole engine down at import.
 *
 * Deferring to first use means every module is fully initialised by the time this
 * runs, so import order stops mattering. Duplicate detection still throws
 * loudly, just on first lookup instead of at load.
 */
let composedCardEffects: Record<string, EffectDefinition> | null = null;

function allCardEffects(): Record<string, EffectDefinition> {
  composedCardEffects ??= mergeRegistries("card effect", [
    { name: "engine/card-effects.ts", entries: CARD_EFFECTS },
    { name: "engine/effects/*", entries: domainCardEffects },
  ]);
  return composedCardEffects;
}

/**
 * Keyed by defId (e.g. "OGS-003"), the stable id every CardInstance/
 * CardDefinition shares (card-loader.ts's deriveId). Hardcoded rather than
 * derived from card text — precise and safe for a handful of cards; not
 * worth a text-parsing scheme until there are enough registered effects to
 * justify one.
 */
export function effectForCard(card: CardInstance): EffectDefinition | undefined {
  return allCardEffects()[card.defId];
}

/** Every defId with a registered Spell/Gear effect. Exported for the coverage
 *  query (engine/coverage.ts) that tells the UI which cards actually do
 *  something — a silently-inert card is otherwise indistinguishable from a
 *  working one. */
export function cardEffectDefIds(): string[] {
  return Object.keys(allCardEffects());
}

export function targetingForCard(card: CardInstance, modeId?: string): TargetingSpec {
  // A modal card has no single targeting — each mode carries its own — so an
  // unresolved mode answers "none" rather than guessing at one of them. The
  // enumerator asks per mode; the validator asks with the mode the action named.
  return cardModeOf(card, modeId)?.targeting ?? { kind: "none" };
}
