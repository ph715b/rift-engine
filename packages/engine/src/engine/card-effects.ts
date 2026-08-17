import type { CardInstance, UnitInstance } from "../model/card.js";
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
// The ONE function that answers "is this unit Mighty" (708). It has taken two
// fixes an inline `>= 5` would re-introduce — positional auras, and Might read
// during a Combat Showdown — so `UnitCostSpec.candidate` asks it rather than
// comparing a number. The import closes a cycle that already existed in both
// directions through `effects/index`, and is only ever CALLED from inside the
// arrow below, never at module init.
import { isMighty } from "./granted-keywords.js";
// Tags as they are RIGHT NOW, not as printed — an Experimental Hexplate grants
// [Mech], and a cost naming tags that read `unit.tags` would disagree with every
// other tag question in the engine. Same lazily-called-arrow rule as above.
import { effectiveTagsOf } from "./equipment.js";
import { COMPANION_TAGS } from "./constants.js";
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
/**
 * Where a "unit"-kind target may be drawn from.
 *
 * `"battlefield"` is the default because most text says "a unit at a
 * battlefield". `"anywhere"` is the bare noun "unit". `"base"` is the narrowest
 * and the newest — Showstopper's "buff a friendly unit IN YOUR BASE, then move it
 * to a battlefield", where reaching a unit already at a battlefield would make
 * the move half meaningless.
 *
 * # The two rules `"anywhere"` rests on, and the one it does NOT
 *
 * **355.9.a.1** is the widening: *"'Unit,' 'gear,' and 'rune' refer to objects on
 * the Board unless specified otherwise."* That is what makes a bare noun mean the
 * whole board.
 *
 * **355.10.a.1** is what puts a BASE in reach specifically: *"Public zones are
 * Battlefield Zones, Bases, Trashes, Legend Zones, Champion Zones, and Facedown
 * Zones."* Several comments in the effect files say "the targeting section lists
 * Bases among the Public zones" — this is that sentence.
 *
 * **355.9.b is the NARROWING**, *"It meets all targeting restrictions"* — the rule
 * that makes a printed "at a battlefield" load-bearing. It is the right citation
 * for `"battlefield"` and the wrong one for `"anywhere"`.
 *
 * **72 comments in `src/` had those two swapped**, cited on 2026-08-09 and found
 * by a card agent. Both sub-rules are real, which is exactly why it survived:
 * every one of those citations RESOLVED to a genuine sentence, just not the one
 * being relied on. 64 were corrected; the 8 that stand are the ones genuinely
 * making the narrowing claim, plus two that were never a targeting question at all
 * (what "here" means, which is 107.1.b — "Each Base is a Location").
 */
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
   * target's combat DESIGNATION (464.2.c Step 1) rather than on its owner, its Might
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
      /**
       * The printed text says "you MAY choose" — declining is a legal option, so
       * the enumerator must offer a no-target variant even when legal targets
       * exist. Tideturner (OGN-199), and swept as the only card in the pool this
       * reaches.
       *
       * Needed because the enumerator's fallback pushes the empty variant only
       * when `effectVariants.length === 0`, which is deliberate — a Unit is
       * playable with no legal target while a Spell is not — and has the side
       * effect that a "you may" appears exactly when there is nothing to decline.
       *
       * A property of the SPEC rather than of the resolver, the same reason
       * `attackingOnly` above gives: by the time a resolver runs, the choice has
       * been made and paid for. **355's Make Relevant Choices step is where a
       * "you may" is decided** — 402.1 says it in as many words for a triggered
       * ability ("if the first part of a Triggered Ability's effect is 'you may',
       * its controller decides whether or not to perform it NOW") — so the
       * decline has to exist as an enumerable choice, not as a resolver branch.
       *
       * Only consulted for a UNIT's on-play trigger. A Spell's targeting IS its
       * effect, so an optional target there would mean paying for nothing.
       */
      optionalChoice?: true;
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
      /**
       * Only gear that is currently EXHAUSTED — Jayce - Defender of Tomorrow's
       * "Ready a gear", where a ready one is nothing to ready.
       *
       * A narrowing on the OFFER rather than on the card's words: `legal-actions`
       * does not offer a mode with no legal target, "since paying for nothing is
       * never what the player meant", and an ability that readies an already-ready
       * gear is exactly that.
       */
      exhaustedOnly?: true;
    }
  /**
   * A card in the caster's OWN trash, chosen as the spell is announced.
   *
   * 355.9.a.4 is what makes this a target rather than a question: a trash is a
   * Public zone, so a card in it can be named at announce and sits in the
   * response window like any other target.
   *
   * `maxEnergy`/`maxPower` bound the candidate's PRINTED cost — "a unit with
   * cost no more than [2] and no more than [rainbow]". Undying Loyalty could not
   * use this spec before they existed: it carried only `cardKind`, so it would
   * have offered every unit in the trash regardless of cost, and a 10-Energy
   * Atakhan played free is very much stronger than printed. A `rainbow` pip
   * bounds the SIZE of the Power cost and not its colour, which is why
   * `maxPower` is a number and not a domain.
   *
   * Both bounds are applied by `ownTrashCandidates`, which the enumerator and
   * the validator share — a ceiling enforced on one side only is this repo's
   * offered-then-refused split.
   */
  | { kind: "ownTrashCard"; cardKind?: "Unit" | "Spell"; maxEnergy?: number; maxPower?: number }
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
       * first half names a battlefield and the second does not, and rule 355.9.a.1
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
       * **198.1: "Locations include the Battlefields and the Bases."** So three
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
   * because the chain is LIFO (340.1).
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
   * 355.9.a.1's bare-noun reading reaches base — the same reading Blitzcrank -
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
      /** Only an OPPONENT's spell may be countered — Repulse's "counter an ENEMY
       *  spell or ability". Riposte sets neither this nor the field below and is
       *  unchanged. Read through `counterFilter`, the same function the
       *  `chainSpell` kind's identically-named field goes through. */
      enemyOnly?: true;
      /**
       * The countered spell must choose the unit this play named **and no other
       * friendly unit** — UNL-106 Repulse, in full.
       *
       * **The one restriction in the pool that is BETWEEN two announced targets**,
       * which is why it could not be a filter on either alone: `counterFilter`
       * answers per-spell and `eligibleTargets` per-unit, and this is a property
       * of the PAIR. It is applied where the pair first exists — the cross product
       * in `legal-actions`, and the same predicate re-derived in
       * `validate-play-card`.
       *
       * Deliberately NOT approximated as Not So Fast's `choosesFriendlyPermanent`,
       * which a wave-7 note measured as wider than printed in three directions: a
       * spell choosing two friendly units, a chosen GEAR, and a friendly unit in
       * base all satisfy that and none satisfies this.
       */
      choosesOnlyThisUnit?: true;
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

/**
 * Does this spec make the player CLICK A UNIT, filling `targetUnitInstanceId`?
 *
 * **Exhaustive by return type, and that is the whole point of it existing.**
 * `GameBoard.pendingStep` used to ask this as a hand-written union —
 * `kind === "unit" || kind === "unitSlots" || kind === "chainSpellAndUnit"` —
 * which is a copy of part of this union living in another workspace. Adding
 * `unitAndEquipment` for Relentless Pursuit therefore did nothing there: the UI
 * never asked for the unit, decided targeting was complete with the field empty,
 * and then matched no candidate at all, because every candidate the enumerator
 * emits for that card names a unit. The card armed, took a destination, and
 * silently did nothing — reported from playtesting.
 *
 * This is the same failure `cardMovesTarget` was extracted to fix after Charm
 * ("I can select a unit I want to move but cannot choose where to move it"), and
 * the same one this repo records for every hand-copied list: **a list the engine
 * merges must never be hand-copied.**
 *
 * With the switch exhaustive over `TargetingSpec["kind"]` and no `default`, the
 * next kind added breaks COMPILATION here instead of silently answering "no unit
 * needed" — the discipline `hasAnyLegalEffectChoice` already uses one file over.
 */
export function targetingChoosesUnit(targeting: TargetingSpec): boolean {
  switch (targeting.kind) {
    case "unit":
    case "unitSlots":
    case "unitList":
    // Riposte fills the same field as a plain `unit` spec; its other half, the
    // spell on the chain, is already carried by every candidate.
    case "chainSpellAndUnit":
    // Relentless Pursuit. The EQUIPMENT half is a separate field — see
    // `targetingChoosesPermanent` below — but the unit half is an ordinary click.
    case "unitAndEquipment":
      return true;
    case "none":
    case "battlefield":
    case "gear":
    case "unitOrGear":
    case "ownTrashCard":
    case "chainSpell":
      return false;
  }
}

/**
 * Does this spec make the player choose a GEAR, filling
 * `targetPermanentInstanceId`?
 *
 * Its own predicate rather than a second return from the one above, because the
 * two are independent: `unitAndEquipment` answers TRUE to both and needs two
 * clicks in two different fields, and a gear must never reach a reader expecting
 * a unit — the separation `unitOrGear` and `{ kind: "gear" }` already keep.
 *
 * Exhaustive for the same reason, and it is the half the UI has never had at all:
 * no code in `packages/web` sets `targetPermanentInstanceId`, so Fading Memories
 * and Rocket Barrage reach it only because their candidates happen to be
 * distinguishable without it.
 */
export function targetingChoosesPermanent(targeting: TargetingSpec): boolean {
  switch (targeting.kind) {
    case "gear":
    case "unitOrGear":
    case "unitAndEquipment":
      return true;
    case "none":
    case "unit":
    case "unitSlots":
    case "unitList":
    case "battlefield":
    case "ownTrashCard":
    case "chainSpell":
    case "chainSpellAndUnit":
      return false;
  }
}

/** Is the GEAR half of this spec declinable? Relentless Pursuit's "you MAY
 *  attach an Equipment" is the only one today, and the UI needs it to know
 *  whether to offer a skip rather than stalling on a step the player has no way
 *  to satisfy. */
export function permanentChoiceIsOptional(targeting: TargetingSpec): boolean {
  return targeting.kind === "unitAndEquipment" && targeting.optionalEquipment === true;
}

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
  /** A move-target Spell is sending its unit to BASE instead of a battlefield —
   *  355.4.a makes every Location a valid Move Destination and 359.3.e works the
   *  case by name. See `PlayCardAction.destinationIsBase`. */
  destinationIsBase?: true;
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
  /**
   * "Choose one YOU HAVEN'T ALREADY CHOSEN" — UNL-182 Curtain Call, the pool's
   * only card that says it.
   *
   * A property of the card rather than of a mode, because it constrains the modes
   * against EACH OTHER across the executions of one play: 820.2 gives each
   * execution its own Make Relevant Choices step, and this word makes those steps
   * dependent where every other modal card's are independent. The ordinary modal
   * default is 820.2.a's Rocket Barrage example — "they may choose the same mode
   * or a different one" — so this is the exception and has to be written down
   * rather than assumed from the card printing several `[Repeat]`s.
   *
   * Read by the validator (which refuses a repeated mode, and refuses an
   * execution that names no mode at all — "the same choices again" IS choosing
   * one already chosen) and by the enumerator (which offers only distinct
   * assignments). Two readers, one field, so the offer and the refusal cannot
   * drift.
   */
  distinctModesPerExecution?: true;
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

/**
 * Does this card's text forbid choosing a mode it has already chosen — Curtain
 * Call's "Choose one you haven't already chosen"?
 *
 * False for every other card, including the other modal ones: 820.2.a's default
 * is explicitly that a repeat "may choose the same mode or a different one".
 */
export function cardRequiresDistinctModes(card: CardInstance): boolean {
  return effectForCard(card)?.distinctModesPerExecution === true;
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
  /**
   * Which of your units may be spent, when the card names a SUBSET rather than
   * "a friendly unit".
   *
   *   - Sacrifice (UNL-173) — "kill a friendly **[Mighty]** unit"
   *   - Stalking Wolf (UNL-166) — "kill a **Bird, Cat, Dog, or Poro** you
   *     control"
   *
   * Until this existed the `kind` was the whole eligibility rule, and the three
   * kinds encode a STATE (ready, buffed, any) rather than an identity — so a
   * card naming a subset had nowhere to say so and was refused across two waves.
   * Adding a fourth `kind` per subset would multiply the enumerator's branch by
   * every future adjective; a predicate keeps the kinds about how the unit is
   * paid and this about which unit qualifies.
   *
   * Applied on TOP of the kind's own filter, in both `legal-actions` (which
   * variants exist) and `validate-play-card` (which submitted ones are legal) —
   * a filter applied in only one of those is this repo's recurring
   * enumerate/execute mismatch, which has produced five crashes.
   *
   * **`mandatory` plus a candidate is how a card becomes conditionally
   * unplayable**: Sacrifice with no Mighty unit of yours is not offered at all,
   * exactly as Cruel Patron is not offered with an empty board.
   */
  candidate?: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1) => boolean;
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
/**
 * Every card in `playerIndex`'s trash this `ownTrashCard` spec may name.
 *
 * ONE function, called by `legal-actions` to fan the variants out and by
 * `validate-play-card` to judge a submitted one. The two used to apply the
 * `cardKind` filter separately, which was survivable while that was the only
 * filter; adding cost ceilings to a duplicated check is exactly how the five
 * enumerate/execute crashes here happened.
 */
export function ownTrashCandidates(
  state: GameState,
  playerIndex: 0 | 1,
  spec: { cardKind?: "Unit" | "Spell"; maxEnergy?: number; maxPower?: number },
): CardInstance[] {
  return state.players[playerIndex].trash.filter((card) => {
    if (spec.cardKind !== undefined && card.kind !== spec.cardKind) return false;
    // A Legend has no cost fields at all; a bounded spec cannot name one.
    if (spec.maxEnergy === undefined && spec.maxPower === undefined) return true;
    if (card.kind !== "Unit" && card.kind !== "Spell" && card.kind !== "Gear") return false;
    if (spec.maxEnergy !== undefined && card.energyCost > spec.maxEnergy) return false;
    if (spec.maxPower !== undefined && card.powerCost > spec.maxPower) return false;
    return true;
  });
}

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
  // Heedless Resurrection — "As an additional cost to play this, kill a friendly
  // unit. Play a unit from your trash that costs no more Energy and no more Power
  // than the killed unit."
  //
  // MANDATORY (204.2.a: "Additional Costs must be paid to finalize"), so there is
  // no decline variant: with no friendly unit to kill the card is simply
  // unplayable, which is what makes the killed unit's cost a reliable ceiling.
  //
  // The EFFECT was written in effects/chaos.ts by a wave-6 agent and was
  // unreachable without this row — `legal-actions` enumerates no
  // additional-cost variant for a card the table does not name, so the card
  // could be played only by hand-building the action. This is the whole of what
  // was missing, which the agent measured and said so.
  "UNL-142": { kind: "killFriendly", mandatory: true },
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
  // Sacrifice — "[Reaction] As an additional cost to play this, kill a friendly
  // [Mighty] unit. Draw 2 and channel 1 rune exhausted."
  //
  // The first cost in the pool that names a SUBSET of your units, and the reason
  // `candidate` exists. MANDATORY — no "you may" — so with nothing of yours at
  // 5+ Might the card is not offered at all, and the draw is never free.
  //
  // Note this is measured through `isMighty` at ENUMERATION time, so a unit that
  // is Mighty only because of a positional aura qualifies where it stands, and
  // stops qualifying if it moves. That falls out of asking the live function
  // instead of reading printed Might, and it is the behaviour 708 describes.
  "UNL-173": { kind: "killFriendly", mandatory: true, candidate: isMighty },
  // Stalking Wolf — "As an additional cost to play me, kill a Bird, Cat, Dog, or
  // Poro you control. You may play me to its battlefield (even if you don't have
  // other units there)."
  //
  // The second `candidate`, and the one that shows why it is a predicate rather
  // than a fourth `kind`: this names TAGS where Sacrifice names a Might
  // threshold, and the two have nothing in common except being restrictions.
  //
  // MANDATORY, so a Wolf with none of those four in play is simply not offered —
  // which is the whole tension of the card, since the destination clause is only
  // worth anything when the sacrifice is standing somewhere useful.
  //
  // 43 units in the pool carry one of these tags, so this is a real restriction
  // rather than a formality. He is himself a Dog, which costs nothing here: he is
  // not in play when the cost is chosen.
  //
  // The DESTINATION half is not here — it is a placement grant keyed to the same
  // chosen unit; see `PLACEMENT_GRANTS` in unit-triggers.ts.
  // Atakhan — "You MAY kill a friendly unit as an additional cost to play me. If
  // you do, I cost [1] less for each Energy it costs and [Order] less for each
  // Power it costs."
  //
  // Optional, so the decline variant is offered and he stays castable at his
  // printed 10 and 3 with nothing to sacrifice. What is new is the DISCOUNT, not
  // the cost: `repeatable` buys a flat 1 Power per unit, and this scales with the
  // killed unit's printed cost on both axes — see `sacrificeCostDiscount` in
  // cost-modifiers.ts, which both pricing sites call with the choice riding on
  // the action.
  "UNL-170": { kind: "killFriendly" },
  "UNL-166": {
    kind: "killFriendly",
    mandatory: true,
    candidate: (state, unit) => {
      const tags = effectiveTagsOf(state, unit);
      return COMPANION_TAGS.some((tag) => tags.includes(tag));
    },
  },
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
/**
 * An optional additional cost paid in resources, and — since UNL-122 Crescent
 * Guardian — the CONDITION under which the card offers it at all.
 *
 * **The condition is not decoration.** Her text is "IF YOU'VE PLAYED A SPELL
 * THIS TURN, you may pay [Chaos] as an additional cost to play me", so the
 * offer itself is conditional. A bare row would make the cost payable on a turn
 * the card forbids it — STRONGER than printed, which is the direction this
 * engine works hardest to avoid. Enforcing it in the payout instead is worse
 * still: the rune would be spent for nothing, which is the offered-then-refused
 * shape wearing a different hat.
 *
 * Asked by `optionalPowerCostOf`, which returns `undefined` when it fails — so
 * the enumerator, the validator and every future caller get the gate for free
 * rather than each having to remember it.
 */
interface OptionalPowerCostSpec {
  domain?: Domain;
  count?: number;
  energy?: number;
  /** Absent means "always offered", which is every card but Crescent Guardian. */
  condition?: (state: GameState, playerIndex: 0 | 1) => boolean;
}

const OPTIONAL_POWER_COSTS: Readonly<Record<string, OptionalPowerCostSpec>> = {
  "OGN-044": { domain: "Calm", count: 1 }, // Clockwork Keeper — "you may pay [1 Calm] as an additional cost"
  // UNL-122 Crescent Guardian — "If you've played a spell this turn, you may pay
  // [Chaos] as an additional cost to play me. If you do, I enter ready."
  //
  // The pool's first CONDITIONAL optional cost, and the condition needed a new
  // `PlayerState` field: see `spellsPlayedThisTurn` for why none of the eight
  // existing spell-named fields answers "have you played a spell", including the
  // near-miss `maxSpellEnergySpentThisTurn`, which a 0-Energy spell leaves at 0.
  //
  // The payout — "I enter ready" — is `deploy.unitEntersReady` reading the same
  // flag it already reads `acceleratePaid` from, rather than an on-play trigger.
  // That matters: a trigger would make her ENTER exhausted and then ready, which
  // is observable (she would sit exhausted through the response window and fire
  // `unitReadied`). 369.3 makes "I enter ready" a replacement describing how she
  // enters, and `unitEntersReady` is where this engine models that.
  "UNL-122": {
    domain: "Chaos",
    count: 1,
    condition: (state, playerIndex) => state.players[playerIndex].spellsPlayedThisTurn > 0,
  },
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
  // Pyke - Dockside Butcher — "You may pay [Fury] as an additional cost to play
  // me", whose on-play trigger reads `optionalPowerPaid` to ready him and give
  // +2 Might. **Added by the integrator, not by the agent that wrote the card**:
  // this table is shared and five agents were writing at once, so the trigger
  // shipped correct and INERT — `optionalPowerPaid` could never be true, and the
  // only proof it worked was a direct `dispatchOnPlayUnit` call that no real
  // action could reach. One row is the whole difference between a written card
  // and a played one, which is the shape worth remembering about this table.
  "UNL-028": { domain: "Fury", count: 1 },
  // Nami - Headstrong — "You may pay [Calm] as an additional cost to play me",
  // gating a `[Stun]`. The IDENTICAL shape to Pyke above, found by reading the
  // half-written list back after his row landed rather than by anything
  // reporting it: both cards had shipped with the trigger written and the cost
  // unenumerable, and neither could ever fire. Worth the note because it is now
  // twice, so the next card printing this sentence should be checked against
  // this table before it is called blocked.
  "UNL-052": { domain: "Calm", count: 1 },
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

/**
 * For coverage: the cards whose printed optional additional cost this table
 * implements.
 *
 * Added with UNL-122 Crescent Guardian, who is the first card in the table whose
 * WHOLE printed text is the cost and its payout — the other four all have a
 * trigger or an effect claiming them elsewhere, which is why the table has gone
 * this long without a coverage source of its own.
 */
export function optionalPowerCostDefIds(): string[] {
  return Object.keys(OPTIONAL_POWER_COSTS);
}

/** Does this card ask the caster for an X of rainbow Power? */
export function hasXRainbowCost(defId: string): boolean {
  return X_RAINBOW_COST_DEF_IDS.has(defId);
}

/**
 * What extra Power this card MAY be played for right now, or undefined.
 *
 * **Takes state since 2026-08-13**, so a conditional offer (Crescent Guardian's
 * "if you've played a spell this turn") simply is not there on a turn the card
 * forbids it. Both existing call sites — the enumerator and the validator — get
 * the gate without changing, which is why the condition lives here rather than
 * in a predicate each of them has to remember to ask.
 */
export function optionalPowerCostOf(
  state: GameState,
  playerIndex: 0 | 1,
  defId: string,
): { domain?: Domain; count?: number; energy?: number } | undefined {
  const spec = OPTIONAL_POWER_COSTS[defId];
  if (spec === undefined) return undefined;
  if (spec.condition !== undefined && !spec.condition(state, playerIndex)) return undefined;
  // Rebuilt by conditional spread rather than destructured, because
  // `exactOptionalPropertyTypes` is on: `spec.domain` is `Domain | undefined`
  // and the return type says `domain?: Domain`, which are not the same thing.
  return {
    ...(spec.domain !== undefined ? { domain: spec.domain } : {}),
    ...(spec.count !== undefined ? { count: spec.count } : {}),
    ...(spec.energy !== undefined ? { energy: spec.energy } : {}),
  };
}

/**
 * "You may spend N XP as an additional cost to play me" — **204.2**, whose own
 * wording is the phrase these cards print ("as an additional cost"), with
 * **204.2.a**: "Additional Costs must be paid to finalize the spell or ability,
 * in addition to the base cost."
 *
 * A SEPARATE table from `OPTIONAL_POWER_COSTS` rather than an `xp` field on it,
 * for the reason every flag on `PlayCardAction` has its own: the two are paid
 * from different places and priced by different code. A Power cost changes the
 * rune payment and rides the whole `computeAutoPayment` / `[Deflect]` /
 * discount-axis machinery; XP is **not a Game Object** (731) and cannot be
 * targeted, discounted or taxed, so its variant is the plain payment with a flag
 * — nothing about the runes changes at all. Folding them together would have
 * meant an optional-cost record where half the fields are meaningless for half
 * the cards.
 *
 * `spendXp`/`canSpendXp` (730.2) already exist; this is only the table saying
 * which cards ask, and how much.
 */
/**
 * What an optional XP cost costs, and what paying it buys.
 *
 * A record rather than a bare number since 2026-08-13, when a second card joined
 * and bought something the first did not. The two shapes are genuinely
 * different and the difference is where the payout is READ:
 *
 *  - **Safety Inspector (UNL-164)** buys an exemption from his own kill, read at
 *    RESOLUTION. A flag on the action expresses that exactly, and the enumerator
 *    can reuse the plain payment unchanged — the price does not move.
 *  - **Poppy - Defender of the Meek (UNL-178)** buys "I cost [3] less", read at
 *    PRICING time. The price does move, so the paid variant is a different
 *    payment and has to be enumerated, validated and executed as one.
 *
 * `energyDiscount` is therefore not decoration on the first card's mechanism; it
 * is what makes the second reach the three cost sites at all.
 */
interface OptionalXpCostSpec {
  xp: number;
  /**
   * Energy taken off the BASE cost when the XP is paid — 356.1's "base cost
   * modifications", the same step a `[Legion]` discount lands in.
   *
   * Absent when the XP buys something that is not a price.
   */
  energyDiscount?: number;
}

const OPTIONAL_XP_COSTS: Readonly<Record<string, OptionalXpCostSpec>> = {
  // Safety Inspector — "You may spend 3 XP as an additional cost to play me",
  // which buys an EXEMPTION from his own symmetrical kill.
  "UNL-164": { xp: 3 },
  // Poppy - Defender of the Meek — "You may spend 3 XP as an additional cost to
  // play me. If you do, I cost [3] less."
  //
  // 6 Energy printed, 3 with the XP paid, and the Power pip is untouched — she
  // says "[3]", which is Energy. **The discount is what makes her paid variant
  // affordable when the plain one is not**, so `legal-actions` has to price it
  // BEFORE the affordability bail; that file already records making the opposite
  // mistake three times (Brazen Buccaneer's discard, Call to Glory's ignore, and
  // the replaced costs).
  "UNL-178": { xp: 3, energyDiscount: 3 },
  // UNL-140 Conscription — "You may spend 5 XP as an additional cost to play
  // this." What it buys is a WIDER TARGET, which is `XP_WIDENED_TARGETING` above
  // rather than anything in this record: no discount, and nothing read at
  // resolution. The row is what makes `validate-play-card` stop refusing the
  // claim outright ("has no optional XP cost to pay").
  "UNL-140": { xp: 5 },
  // **UNL-140 joined this table on 2026-08-13, and the note that kept it out for
  // three waves was right about everything except that it was unfixable.** It
  // said: listing it alone "would sell 5 XP for nothing: the caster pays and the
  // cap still stands", because the enumerator fans optional costs out INSIDE the
  // target loop. True — a row here is necessary and not sufficient.
  //
  // It also named the fix exactly: "the targeting filter has to be asked per
  // variant, not once per card", the same choice-depends-on-a-variant shape
  // `[Ambush]` needed. That is `XP_WIDENED_TARGETING` below: the wide-only
  // targets are fanned as variants that carry `optionalXpPaid` from birth, so the
  // flag and the target that needs it can never come apart.
};

/**
 * Cards whose optional XP cost buys a WIDER CHOICE rather than a different
 * resolution — the spec that replaces the printed one when the XP is paid.
 *
 * UNL-140 Conscription is the first and only: "choose an enemy unit at a
 * battlefield with 3 [Might] or less. If you paid the additional cost, choose ANY
 * enemy unit at a battlefield instead."
 *
 * **This is the seam its refusal named, and it is a real one.** Every other
 * optional cost in this pool buys something read at RESOLUTION (Safety
 * Inspector's exemption) or at PRICING (Poppy's discount), and both of those are
 * a flag on an action whose targets were already chosen. This one changes WHICH
 * TARGETS EXIST, and the target fan-out happens above the cost fan-out — so a
 * paid variant built the ordinary way would carry a target already filtered to 3
 * Might and sell the XP for nothing.
 *
 * Both readers therefore ask for the spec with the flag: `legal-actions` fans the
 * WIDE-ONLY targets as variants that carry `optionalXpPaid` from birth, and
 * `validate-play-card.targetingRejection` re-derives the same spec from the same
 * table. Keeping the two on one function is what stops a wide target being
 * offered and then refused.
 */
const XP_WIDENED_TARGETING: Readonly<Record<string, TargetingSpec>> = {
  // The printed spec minus the `maxMight: 3` cap. "At a battlefield" survives —
  // the XP lifts the Might restriction and nothing else, so `scope` is left at
  // its default exactly as the narrow spec leaves it.
  "UNL-140": { kind: "unit", owner: "enemy" },
};

/** The targeting this card gets when its optional XP cost is PAID, or undefined
 *  when its XP buys something that is not a choice. */
export function xpWidenedTargetingFor(defId: string): TargetingSpec | undefined {
  return XP_WIDENED_TARGETING[defId];
}

/** How much XP this card offers to take as an additional cost, if it does.
 *
 *  Signature deliberately unchanged when the table grew a record: every existing
 *  caller asks only "how much", and widening the return type would have touched
 *  the enumerator, the validator and the executor for a field none of them
 *  wanted. */
export function optionalXpCostOf(defId: string): number | undefined {
  return OPTIONAL_XP_COSTS[defId]?.xp;
}

/**
 * What paying this card's optional XP cost takes OFF its Energy — Poppy's "if
 * you do, I cost [3] less", and 0 for a card whose XP buys something else.
 *
 * Its own accessor rather than a second return value, so the three cost sites
 * ask exactly the question they need and Safety Inspector's pricing is
 * byte-for-byte what it was.
 */
export function optionalXpEnergyDiscountOf(defId: string): number {
  return OPTIONAL_XP_COSTS[defId]?.energyDiscount ?? 0;
}

/** For coverage: the cards whose printed additional cost this table implements. */
export function optionalXpCostDefIds(): string[] {
  return Object.keys(OPTIONAL_XP_COSTS);
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
  /**
   * A `[Repeat]` cost paid with CARDS rather than resources — Square Up's
   * "[Repeat] — Discard 1".
   *
   * Every other Repeat in the pool is priced in Energy and Power, which is why
   * this interface held nothing else and why the card was refused across three
   * waves. 820.1.c.1 makes the Repeat cost "an Additional Cost to be paid during
   * the steps of playing", and says nothing about what kind of cost it is.
   *
   * WHICH card is discarded rides the action (`repeatDiscardCardInstanceId`),
   * because it is a real choice: unlike Energy, one card in hand is not
   * interchangeable with another.
   */
  discard?: number;
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
 * **All but one of these prints exactly ONE instance of Repeat.** UNL-182
 * Curtain Call prints THREE, which is what 820.1.c.2/c.3 ("if a spell or ability
 * has more than one instance of Repeat, each Cost may be paid or not paid
 * individually... each Repeat Cost can be paid only a single time") were waiting
 * for, and is why the value type is `RepeatCostSpec | RepeatCostSpec[]`.
 * `repeatCostsOf` is the accessor; nothing should read this map directly.
 *
 * The premise test in `repeat-keyword.test.ts` predicted this exactly — "the day
 * a set prints two, that test fails and this shape is what changes" — and it
 * did. It now asserts that the TABLE and the printed text agree on the count,
 * per card, which is a check that cannot flip again.
 *
 * Temporal Portal (SFD-078) is absent on purpose: it GRANTS Repeat "equal to its
 * cost" to another spell rather than printing one of its own, so its cost is not
 * a constant and cannot live in a table. See `grantedRepeatCostFor`.
 */
const REPEAT_COSTS: Readonly<Record<string, RepeatCostSpec | readonly RepeatCostSpec[]>> = {
  // Square Up — "[Repeat] — Discard 1". The pool's only non-resource Repeat
  // cost, and `energy: 0` is load-bearing rather than filler: the card asks for
  // no Energy at all, so a variant that paid one would be charging a price the
  // card does not print.
  "UNL-017": { energy: 0, discard: 1 },
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
  // **Unleashed, priced 2026-08-09.** All four print a plain `[Repeat] [2]`, the
  // same shape as the six SFD rows above. Their effects were written by four
  // separate wave-2 agents, and each independently reported the SAME consequence
  // of the missing row: the card reports fully implemented and its `[Repeat]` is
  // inert, because the keyword no longer greys a card in coverage. Six cards were
  // in that state — a coverage LIE, which is worse than a refusal, since a
  // refusal is visible and this looks finished.
  //
  // Adding a row makes the enumerator offer a repeat-paid variant, which is
  // behaviour none of those agents could test — so each is verified in
  // `test/repeat-keyword.test.ts` to offer the variant AND to charge printed + 2.
  "UNL-009": { energy: 2 }, // Upstage Comedy — [Repeat] [2]
  "UNL-032": { energy: 2 }, // Double Trouble — [Repeat] [2]
  "UNL-061": { energy: 2 }, // Downstage Dramatics — [Repeat] [2]
  "UNL-134": { energy: 2 }, // Existential Dread — [Repeat] [2]
  // **Curtain Call — the pool's only multi-instance [Repeat].** Printed
  // "[Repeat] — :rb_energy_1: / :rb_rune_rainbow: / :rb_energy_1::rb_rune_rainbow:",
  // three costs separated by slashes, and 820.1.c.2 makes each payable or not
  // payable on its own. Paying all three executes the spell FOUR times (820.3:
  // "an additional time on resolution for each instance of Repeat that is paid
  // for"), which with "choose one you haven't already chosen" is exactly its four
  // printed modes.
  //
  // The middle instance has NO Energy at all, the same shape Called Shot's
  // `[Repeat] [Chaos]` has — `energy: 0` is the price, not a placeholder. And
  // both pips are RAINBOW rather than the card's own Fury/Mind: the printed
  // glyph is `:rb_rune_rainbow:`, which is why they ride `rainbowPower` instead
  // of `power` + `domain` (see Danger Zone, which is where that field came from).
  "UNL-182": [{ energy: 1 }, { energy: 0, rainbowPower: 1 }, { energy: 1, rainbowPower: 1 }],
};

/** What this card's `[Repeat]` costs, or undefined if it has none. */
/**
 * The GRANTED `[Repeat]` cost a spell has while Temporal Portal's grant is armed
 * — "[Repeat] equal to its cost", so the card's whole printed cost, Energy pip
 * and Power pip both.
 *
 * PRINTED, not effective: 206's Defy example is the rules being explicit that a
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

/**
 * Every `[Repeat]` instance this card prints, in printed order — empty when it
 * prints none.
 *
 * **The canonical accessor since 2026-08-14.** The table's value became
 * `RepeatCostSpec | RepeatCostSpec[]` for UNL-182 Curtain Call, which prints
 * THREE (`[1]` / `[rainbow]` / `[1][rainbow]`) and is the card 820.1.c.2 was
 * waiting for. Every other row is one instance and normalises to a one-element
 * list here, so nothing about them changes.
 *
 * `repeatCostOf` below is the single-instance view and is kept for the callers
 * that genuinely mean "the one cost" — it returns the FIRST instance, which is
 * the same answer it always gave for every card in the table today.
 */
export function repeatCostsOf(defId: string): readonly RepeatCostSpec[] {
  const entry = REPEAT_COSTS[defId];
  if (entry === undefined) return [];
  return Array.isArray(entry) ? entry : [entry as RepeatCostSpec];
}

/**
 * This card's FIRST `[Repeat]` cost, or undefined if it prints none.
 *
 * Unchanged for every card in the table, all of which print exactly one. A card
 * printing several is under-read here by construction, which is why the
 * multi-instance work migrates its callers to `repeatCostsOf` rather than
 * widening this.
 */
export function repeatCostOf(defId: string): RepeatCostSpec | undefined {
  return repeatCostsOf(defId)[0];
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
  // **Desert's Call and Flurry of Feathers, added 2026-08-09.**
  //
  // The evidence was an inconsistency this table already contained: Sprite Call
  // (OGN-094) and Desert's Call (SFD-031) print the IDENTICAL shape — "Play a
  // [N] Might [X] unit token", no destination clause — and only one of them was
  // listed. Only Recruit the Vanguard actually prints the parenthetical, so the
  // list was not tracking what the cards say.
  //
  // 185.2.a settles which was wrong: tokens are played "following all the
  // applicable steps for playing a card plus any restrictions or modifications
  // from the effect that created the token", and the inherent restriction on
  // playing a Unit is "base or a battlefield they control". Neither card
  // restricts anything, so both get the ordinary choice. Sprite Call was right.
  //
  // **SFD-031 is in a hard-gated set**, so this changes behaviour in a
  // declared-complete one — deliberately, on the project owner's call, with the
  // probes re-run rather than assumed.
  "SFD-031", // Desert's Call — one Sand Soldier, or two under its [Repeat]
  "UNL-044", // Flurry of Feathers — all four Birds at ONE chosen destination
]);

/**
 * Cards whose unit target must be at a DIFFERENT location from where the card
 * itself is being played.
 *
 * Tideturner (OGN-199): "you may choose a unit you control **at another
 * location**. Move me to its location and it to my original location." A target
 * standing where Tideturner is about to land makes the swap a no-op — the card
 * resolves, both units stay put, and nothing visible happens.
 *
 * **That is a TARGETING restriction, not a resolver check.** 355.9.b — "It meets
 * all targeting restrictions" — is the narrowing half, and 355.8 declares targets
 * at finalization, so an ineligible unit must never be offered. Reported from
 * playtesting as "tideturner is not working".
 *
 * Its own table because the constraint relates the TARGET to the DESTINATION, and
 * `TargetingSpec` describes the target alone: `scope` cannot see where the card is
 * going. The pairing happens in `legal-actions`, which is where this is read.
 */
const TARGET_MUST_BE_ELSEWHERE = new Set(["OGN-199"]);

export function targetMustBeElsewhere(defId: string): boolean {
  return TARGET_MUST_BE_ELSEWHERE.has(defId);
}
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
  // Tricksy Tentacles — "Move any number of enemy units with the same controller
  // and a total Might of 8 or less to a single location."
  //
  // The first `unitList` card to carry a destination, and it needs nothing else on
  // the enumerator side for the BATTLEFIELD axis: `withDestinations` derives its
  // "where is it now" index from `targetUnitInstanceId`, which a list variant never
  // sets, so the index is undefined and every battlefield is offered.
  //
  // 355.4's per-Move destination rule does not bite the way it does for Void
  // Assault — this card prints "a SINGLE location", so one choice IS the printed
  // behaviour rather than a simplification of it.
  //
  // **The BASE axis is settled but NOT yet wired**: owner ruling 2026-08-13 says
  // "a single location" includes the enemy base, and `withDestinations`' `toBase`
  // branch is gated on that same undefined index, so a `MOVE_TO_BASE_DEF_IDS` row
  // alone would silently never offer it. That gate is a legal-actions change, and
  // it is deliberately not made here — the row without it would enumerate nothing.
  "UNL-054",
  // Skyward Strike — "Move an enemy unit. [Level 6][>] [Stun] an enemy unit."
  // Its FIRST slot is the moved unit, so `withDestinations` finds it under
  // `targetUnitInstanceId` exactly as it does for a single-target card; the
  // second slot is the stun and never takes a destination. Dragon's Rage below
  // is the precedent for a `unitSlots` card carrying a chosen destination at all.
  "UNL-038",
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
  /** The battlefield being considered, or `"base"` for the moved unit's own
   *  base — 107.1.c means there is only ever one base it could go to. */
  destination: string | "base",
): boolean {
  if (!MOVE_DESTINATION_NEEDS_SAME_CONTROLLER.has(defId)) return true;
  if (movedUnitInstanceId === undefined) return false;
  const moved = findUnitAnywhere(state, movedUnitInstanceId);
  if (!moved) return false;
  const controllerId = state.players[moved.ownerIndex].id;
  // Temptation at a BASE. "A location where there's a unit with the same
  // controller" is asked of the moved unit's OWN base, and the answer is the
  // same shape: some OTHER unit of that controller already standing there. The
  // moved unit is excluded for the reason the battlefield branch excludes it —
  // it is not there yet, and counting it would make every base legal always.
  if (destination === "base") {
    return state.players[moved.ownerIndex].baseUnits.some((u) => u.instanceId !== movedUnitInstanceId);
  }
  const battlefield = state.battlefields.find((bf) => bf.id === destination);
  if (!battlefield) return false;
  return (battlefield.units[controllerId] ?? []).some((u) => u.instanceId !== movedUnitInstanceId);
}

export function cardMovesTarget(defId: string): boolean {
  return MOVE_TARGET_SPELL_DEF_IDS.has(defId);
}

/**
 * Move-target spells whose destination may be a BASE.
 *
 * 355.4.a makes every Location a unit is allowed to be present at a valid Move
 * Destination, and 198.1/107.1.b make each Base a Location — so this is the
 * DEFAULT for a card that just says "move a unit", and the set below is the
 * exception list read off the printed text.
 *
 * **Two of the seven print a destination and so are correctly excluded**, which
 * is why this is a per-card set and not `cardMovesTarget` itself:
 *
 *  - **Showstopper (OGN-270)** — "Buff a friendly unit in your base, then move it
 *    **to a battlefield**." It names one, and the unit starts in base anyway, so
 *    355.4.a's "other than the Unit's current Location" excludes base twice over.
 *  - **Stormbringer (OGN-250)** — "…to all enemy units **at a battlefield**, then
 *    move your unit **there**." The destination is doing double duty as the thing
 *    damaged; a base cannot be it.
 *
 * docs/rules-conformance.md listed six affected cards including both of those and
 * omitting Relentless Pursuit. The real answer is these five.
 */
const MOVE_TO_BASE_DEF_IDS = new Set([
  "OGN-043", // Charm — "Move an enemy unit."
  // Tricksy Tentacles — "…to a single location."
  //
  // **Project-owner ruling, 2026-08-13: "a single location" DOES include the
  // enemy base.** 198.1 makes a Base a Location and 355.4.a makes any Location
  // the unit may occupy a valid Move Destination; this engine models a base per
  // controller (107.1.c), and every target of this card shares a controller, so
  // "their base" is well defined.
  //
  // This row is only half of it — `withDestinations`' `toBase` branch also had to
  // stop requiring a single-target index, since a `unitList` play never sets one.
  // See legal-actions.ts.
  "UNL-054",
  // Skyward Strike — "Move an enemy unit", naming no battlefield, so 355.4.a and
  // 198.1 make a base a legal destination like any other Location.
  "UNL-038",
  // Ride The Wind — "Move a friendly unit and ready it." The card the rules'
  // own worked example (359.3.e) names: "Base is a legal move destination for
  // Ride the Wind".
  "OGN-173",
  // Dragon's Rage — "Move an enemy unit. Then do this: choose another enemy unit
  // at its destination." A base is a destination like any other, and the second
  // target is then "another enemy unit" standing in that base.
  "OGN-258",
  // Temptation — "Move an enemy unit to a LOCATION where there's a unit with the
  // same controller." It prints the rules' own word for the wider set, and
  // `moveDestinationAllowed` asks the same-controller question of a base exactly
  // as it does of a battlefield.
  "SFD-129",
  // Relentless Pursuit — "Move a friendly unit." Unrestricted, like Charm.
  "SFD-184",
]);

/** May this card send its target to base? Asked by the enumerator AND the
 *  validator, like `moveDestinationAllowed` beside it — one function, so a
 *  destination cannot be offered by one and refused by the other. */
export function cardMayMoveToBase(defId: string): boolean {
  return MOVE_TO_BASE_DEF_IDS.has(defId);
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
