import type { MightModifier } from "../effective-might.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { EffectDefinition } from "../card-effects.js";
import type { DecisionDefinition } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { DecisionOption } from "../decisions.js";
import { applyContested } from "../cleanup.js";
import { parkDecision } from "../decisions.js";
import { playUnitToBattlefield } from "../deploy.js";
import {
  dealDamage,
  destroyUnit,
  discardCards,
  drawCards,
  forceMoveToBattlefield,
  forceMoveToDestination,
  giveMightThisTurn,
  grantTriggerThisTurn,
  legionActive,
  ownUnitsEverywhere,
  readyUnit,
  recallUnitToBase,
  removeUnitAnywhere,
  returnPermanentToHand,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { grantReplacedCostPlay } from "../replaced-costs.js";
import { attachEquipment, isMechUnit, wearerListener } from "../equipment.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { placeGoldTokens } from "../token.js";
import {
  CURTAIN_CALL_BASE_DAMAGE,
  CURTAIN_CALL_BATTLEFIELD_DAMAGE,
  CURTAIN_CALL_SHRINK,
  DANGER_ZONE_MIGHT,
  PYKE_ENERGY_COST,
  RELENTLESS_PURSUIT_GRANT,
  RENGAR_MIGHT,
  THRILL_OF_THE_HUNT_PLACEMENT,
  VI_EXCESS_REQUIRED,
  anyUnitChooseableBy,
  awaitingThrillUnit,
  excessAssignedBy,
  voidRushLabel,
  voidRushPayment,
  voidRushRevealed,
} from "./signature-shared.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Fury**.
 *
 * So a `Fury+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Fury lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

/** Hextech Gauntlets' art-only band — "if you assigned 3 or more excess damage,
 *  draw 1". Its own pair rather than Vi's `VI_EXCESS_REQUIRED` above, because
 *  Sivir - Ambitious prints the same clause at 5: the threshold is a per-card
 *  number and not a rule. */
/** Death from Below's "if it had 3 [Might] or less" — the recursion's gate. */
const DEATH_FROM_BELOW_MIGHT_CAP = 3;

const HEXTECH_GAUNTLETS_EXCESS_REQUIRED = 3;
const HEXTECH_GAUNTLETS_DRAW = 1;

export const cardEffects: Record<string, EffectDefinition> = {
  "SFD-182": {
    // Danger Zone (Fury + Mind) — "[Reaction] [Repeat] [1][rainbow] Give your
    // Mechs +1 Might this turn."
    //
    // Tribal, and the tag is PRINTED, so the filter is a definition-level
    // question — the same `tags.includes("Mech")` that granted-keywords.ts's
    // `isMech` asks for the three tribal keyword auras. Spelled out here rather
    // than imported because that predicate takes a DEFINITION and this walks
    // live `UnitInstance`s, which carry their own `tags`.
    //
    // **This is the card that the tribal-aura bug of 2026-08-06 was about**: three
    // auras granted their keyword to EVERY friendly unit because they consulted
    // `appliesTo` and never `appliesToDef`, and every test for them passed
    // because each only asserted that the Mech got the keyword. So the assertion
    // that matters for this card is the NEGATIVE — a non-Mech friendly gets
    // nothing — and the test carries it.
    //
    // "YOUR Mechs", so no enemy Mech is pumped and there is no "here": a Mech in
    // base is pumped too, which is `ownUnitsEverywhere`'s whole reason for
    // reaching both zones.
    //
    // `kind: "none"`: the card names no target, it names a GROUP. Nothing is
    // chosen, so 820.1.d's "may make different choices" has nothing to vary —
    // repeating this is simply +1 twice to whatever Mechs are standing when each
    // execution runs, and the second execution reads the board the first left.
    //
    // A caster with no Mechs at all still casts it for nothing; the group is the
    // instruction, not a condition on it.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => isMechUnit(state, u))
        .reduce((next, u) => giveMightThisTurn(next, u.instanceId, DANGER_ZONE_MIGHT), state),
  },
  "OGN-254": {
    // Noxian Guillotine (Fury + Order) — "Choose a unit. Kill it the next time it
    // takes damage this turn. [Legion] -> Kill it now instead."
    //
    // **This card's second half was recorded as `[Repeat]` — a paid additional
    // cost this engine models nowhere — and it is `[Legion]`, which has been
    // implemented since Darius.** The card's own text says so ("Get the effect
    // if you've played another card this turn"); the note that blocked it was a
    // misreading, and the fix was two lines rather than a subsystem. Worth
    // stating plainly: a PARTIALLY_IMPLEMENTED entry is a claim about a card,
    // and this one was wrong for as long as nobody re-read the card.
    //
    // `countingSelf: true` — the Guillotine itself is already counted by the
    // time it resolves, since `execute-play-card` increments
    // `cardsPlayedThisTurn` when the card goes on the chain. "ANOTHER card"
    // therefore needs 2, which is exactly what the flag means.
    //
    // A DEATH SENTENCE, not damage: the unit is marked, and the next damage of
    // any size kills it however much Might it has left. Marked by instance id on
    // GameState — the same shape `deathWardedUnitInstanceIds` uses for the exact
    // opposite effect, and for the same reasons: per-unit, expires with the turn,
    // and keeping it off the unit means no helper that rebuilds a unit has to
    // remember to carry it.
    //
    // "A unit", no owner and no battlefield named, so scope "anywhere".
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      // "Kill it NOW **instead**" — the two halves are alternatives, so a Legion
      // kill never also marks. A unit that dies here is killed BY THE CASTER, so
      // "when you kill a unit" (Solari Shrine) and "with a spell" (Immortal
      // Phoenix) both see it, which the delayed half cannot promise.
      if (legionActive(state, ctx.casterIndex, true)) {
        return destroyUnit(state, event.targetUnitInstanceId, ctx.casterIndex);
      }
      return state.markedForDeathOnDamageInstanceIds.includes(event.targetUnitInstanceId)
        ? state
        : { ...state, markedForDeathOnDamageInstanceIds: [...state.markedForDeathOnDamageInstanceIds, event.targetUnitInstanceId] };
    },
  },
  "OGN-248": {
    // Icathian Rain (Fury + Mind) — "Deal 2 to a unit." x6.
    //
    // SIX separate instructions, each naming its own target, so this is six
    // ordered choices rather than "deal 12 split six ways". The rules settle both
    // halves of what that means, using their own Rocket Barrage example: valid
    // choices must be made for ALL targets before the spell goes on the chain
    // (355), and the same unit may be chosen more than once provided the caster
    // says which choice is which. So the card is uncastable with an empty board
    // and deals all 12 to a lone survivor.
    //
    // `min: 6, max: 6` — not "up to six". Nothing in the text offers fewer.
    // `scope: "anywhere"`: "a unit" is 355.9.a.1's bare noun, so a unit in either
    // base is a legal target, the same reading Final Spark already takes.
    targeting: { kind: "unitList", min: 6, max: 6, scope: "anywhere", allowsDuplicates: true },
    resolve: (state, ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => dealDamage(next, ctx.casterIndex, id, 2), state),
  },
  "OGN-250": {
    // Stormbringer (Fury + Body) — "Choose a friendly unit in your base. Deal
    // damage equal to its Might to all enemy units at a battlefield, then move
    // your unit there."
    //
    // Showstopper's exact shape: a `unit` target scoped to BASE plus a
    // battlefield riding on `destinationBattlefieldId`, which is only enumerated
    // for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS. Registering
    // this without that entry would be worse than leaving the card dead — it
    // would be castable, the destination would always arrive undefined, and
    // coverage would report a card that does nothing as done.
    //
    // `scope: "base"` is printed ("in your base") and load-bearing for the same
    // reason as Showstopper's: "then move your unit there" is a deploy, and a
    // unit already at a battlefield would make it a sideways shuffle.
    //
    // **Damage FIRST, then move, and the order is the card.** The unit is in
    // BASE while it fires, so it is not at the battlefield it is bombarding —
    // which means it takes nothing back, and it is not counted among "all enemy
    // units at a battlefield" by anything reading that battlefield's occupants.
    // Moving first would walk it into a fight it then damages from inside.
    //
    // Might is read ONCE, before the damage, and read EFFECTIVE (auras and
    // this-turn pumps count, `isCombat: false` because this is not a Showdown —
    // the same reading Gentlemen's Duel and Last Breath already take). Reading it
    // per target would let the first kill's Deathknell change what the rest take.
    targeting: { kind: "unit", owner: "friendly", scope: "base" },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: unitId, destinationBattlefieldId: destination } = event;
      if (!unitId || !destination) return state;
      const location = findUnitAnywhere(state, unitId);
      if (!location) return state;

      const might = effectiveMight(state, location.unit, ctx.casterIndex, { isCombat: false });
      const bf = state.battlefields.find((b) => b.id === destination);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const enemyIds = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const bombarded = enemyIds.reduce((next, id) => dealDamage(next, ctx.casterIndex, id, might), state);
      // "THEN move your unit there" — unconditional, so the unit deploys even if
      // the damage killed nothing and even if it killed everything. Through
      // forceMoveToBattlefield, which is what applies Contested and stages the
      // Showdown; a raw list splice would deploy it into a fight that never opens.
      return forceMoveToBattlefield(bombarded, unitId, destination);
    },
  },
  "SFD-188": {
    // Void Rush (Fury + Order) — "Reveal the top 2 cards of your Main Deck. You may
    // banish one, then play it, reducing its cost by [2 Energy]. Draw any you
    // didn't banish."
    //
    // Baited Hook's structure — look at the top of the deck, optionally banish one
    // and play it, then dispose of the rest — with one difference that is the whole
    // card: the play is DISCOUNTED, not free. Nothing in the pool had done that
    // before, which is why `voidRushPayment` below is written out rather than
    // borrowed; The Harrowing and Soulgorger waive the Energy half outright and
    // Immortal Phoenix pays a fixed printed price.
    //
    // "REVEAL" is informational only. This engine has no per-player hidden view of
    // a deck, so revealing is not a state change; what the decision offers IS the
    // reveal, and the option list is the two cards.
    //
    // Parked rather than resolved inline, because "you may banish ONE" is a genuine
    // choice between two cards and a spell's resolution has no action to carry it.
    // With nothing affordable the list is a lone "decline" and `advanceDecisions`
    // retires it without a prompt — so a board that cannot pay simply draws both.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-188-banish", playerIndex: ctx.casterIndex }),
  },
  "SFD-184": {
    // Relentless Pursuit (Fury + Body) — "[Action] Move a friendly unit. You may
    // attach an Equipment with the same controller to it. This turn, that unit
    // has 'When I conquer, you may move me to my base.'"
    //
    // # Three instructions, three mechanisms, all chosen at ANNOUNCE time
    //
    // The MOVE rides `destinationBattlefieldId` through
    // `MOVE_TARGET_SPELL_DEF_IDS`, the same field Charm and Ride The Wind use.
    //
    // The ATTACH is `unitAndEquipment` with `optionalEquipment`, which is new
    // here: Angle Shot's version requires both halves and constrains neither
    // owner. Fanned out rather than asked at resolution, which is the standing
    // rule for an attach in this engine — `attachesEquipment` and
    // `attachesFromTargetToSelf` both do it, and 355 makes the Equipment a target
    // whose announcement an opponent can respond to.
    //
    // The GRANT is `grantTriggerThisTurn`, and it is the pool's first ability
    // given to a unit rather than a keyword or a number. The handoff that scoped
    // this card said "nothing grants a triggered ability" and named
    // `keywordsThisTurn` as the nearest shape; what it needed was one sibling
    // field holding a REGISTRY KEY, so the granted ability is written in the same
    // table a printed one is and resolves through the same path.
    //
    // # The order
    //
    // Move, then attach, then grant — the order the card prints them in. Only the
    // first two could interact and they do not: attaching reads no location.
    //
    // A vanished target is a no-op throughout: the unit can be killed in response
    // to the announcement, and each helper already answers safely for a unit it
    // cannot find.
    targeting: { kind: "unitAndEquipment", relation: "attachable", owner: "friendly", optionalEquipment: true },
    resolve: (state, ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const moved = forceMoveToDestination(state, unitId, event, ctx.casterIndex);
      // Attached by the PAIR's controller, not the caster's — "with the same
      // controller" relates the Equipment to the unit, and `attachEquipment`
      // writes into that player's `activeGear`. Angle Shot's note records the
      // same reasoning; passing the caster there looked for an enemy's gear in
      // our own list.
      const owner = findUnitAnywhere(moved, unitId);
      const attached =
        event.targetPermanentInstanceId !== undefined && owner !== undefined
          ? attachEquipment(moved, owner.ownerIndex, event.targetPermanentInstanceId, unitId)
          : moved;
      return grantTriggerThisTurn(attached, unitId, RELENTLESS_PURSUIT_GRANT);
    },
  },
  "UNL-186": {
    // Death from Below (Fury + Chaos) — "Kill a unit at a battlefield. Then, if it
    // had 3 [Might] or less, you may play this from your trash for [rainbow]."
    //
    // **WHOLE as of 2026-08-13.** The kill was written first and the recursion
    // refused, because "play THIS from your trash" is a per-INSTANCE play
    // permission with a REPLACED cost. Both halves of that now exist: rule
    // 356.1.a's cost replacement lives in `engine/replaced-costs.ts`, and the
    // GRANTED half is `PlayerState.replacedCostPlays` — see that field for why it
    // is not `trashUnitPlaysThisTurn` widened.
    //
    // `scope` left at its default, so "a unit AT A BATTLEFIELD" is enforced by the
    // targeting and a unit sheltering in either base is out of reach (355.9.b's
    // narrowing — the printed location word is a targeting restriction).
    //
    // Killed BY THE CASTER (`ctx.casterIndex`), which is not decoration: it is what
    // makes "when you kill a unit" (Solari Shrine) and "killed with a spell"
    // (Immortal Phoenix) see this death, the same reading Noxian Guillotine's
    // [Legion] half takes above.
    //
    // # "If it HAD 3 [Might] or less" is measured BEFORE the kill
    //
    // Past tense, and about a unit that no longer exists by the time the clause
    // is read — so the figure is captured while it is still standing rather than
    // recovered afterwards. `effectiveMight` (143.2's "current Might"), not the
    // printed number: a 2-Might unit pumped to 4 is a 4-Might unit when it dies,
    // and a 5-Might unit debuffed to 3 is worth the recursion.
    //
    // The `[Deflect]`-shaped alternative — reading `might` off the instance — was
    // rejected for the reason `chaos.ts` records against exactly that mistake:
    // the printed field is not what "Might" means anywhere in these rules.
    //
    // # The permission is granted even though the card is not in the trash yet
    //
    // A Spell trashes itself as part of being played, and that happens in
    // `execute-play-card` AFTER this resolver runs. So the grant names an
    // instance that is still mid-flight — which is safe because `replacedCostFor`
    // re-checks trash membership at every ask, and simply answers null until the
    // card lands. Granting here rather than trying to sequence around the trash
    // move keeps this resolver ignorant of zone plumbing it does not own.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const location = findUnitAnywhere(state, targetId);
      if (!location) return state; // it left play between announce and resolution
      const might = effectiveMight(
        state,
        location.unit,
        location.ownerIndex,
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id },
      );
      const killed = destroyUnit(state, targetId, ctx.casterIndex);
      if (might > DEATH_FROM_BELOW_MIGHT_CAP || ctx.sourceCardInstanceId === undefined) return killed;
      return grantReplacedCostPlay(killed, ctx.casterIndex, {
        instanceId: ctx.sourceCardInstanceId,
        // "for [rainbow]" — no Energy and one Power pip of any domain. `null` is
        // the rainbow domain everywhere in this engine.
        energyCost: 0,
        powerCost: 1,
        powerDomain: null,
      });
    },
  },
  "UNL-184": {
    // Thrill of the Hunt (Fury + Body) — "[Reaction] Banish a friendly unit, then
    // its owner plays it to any battlefield, ignoring its cost."
    //
    // # Arcane Shift's blink with one printed word changed, and the word is the card
    //
    // SFD-200 above says only "plays it" — the ordinary permission — so it goes
    // through `playUnitFree`, which offers BASE and, among battlefields, only the
    // ones rule 813 already lets a paid play reach. This prints "to ANY
    // BATTLEFIELD", and neither half of that list is right for it:
    //  - Base is not an option. 198.1 — "Locations include the Battlefields and
    //    the Bases" — makes a base a Location that is not a Battlefield, so the
    //    sentence excludes it rather than this file choosing to.
    //  - EVERY battlefield is an option, presence or not. 813's restriction is
    //    precisely the default "any" is overriding; reading it as a plain "a
    //    battlefield" would delete the line the card exists for, which is dropping
    //    a body into a fight it was not already in.
    //
    // So the destination question is asked here rather than borrowed. What IS
    // borrowed is the holding pen: `unitsAwaitingFreePlacement`, because the unit
    // must be off the board while the question is outstanding — arriving is what
    // fires its on-play trigger and what contests a battlefield, and deploying it
    // at base first would fire both for the wrong place. free-play.ts's own
    // comment records that reasoning; only the option list differs here, which is
    // why the decision kind is this card's rather than `FREE_PLAY_PLACEMENT`.
    //
    // # The rest
    //
    // The banish is TRANSIENT — banished and replayed in one instruction, nothing
    // can observe the middle zone — so the unit goes straight back to play rather
    // than through `PlayerState.banished`. Arcane Shift makes the same call, and
    // for the same reason.
    //
    // A fresh copy: 705 strips the Buff on leaving play, and damage, this-turn
    // Might, stun and the move counter are properties of the body that left.
    //
    // "ITS OWNER plays it", not the caster — `found.ownerIndex`. Friendly-only
    // targeting makes the two the same player today; naming it is what keeps that
    // an observation rather than an assumption.
    //
    // "A friendly unit" carries an owner word and no location word, so
    // `scope: "anywhere"` under 355.9.a.1 — and the unit standing at home is
    // exactly the one this is usually cast on.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const found = findUnitAnywhere(state, unitId);
      if (!found) return state; // killed in the response window — 359.3
      const returning: UnitInstance = {
        ...found.unit,
        damage: 0,
        mightThisTurn: 0,
        buffed: false,
        stunned: false,
        movesThisTurn: 0,
      };
      const removed = removeUnitAnywhere(state, unitId);
      const parked: GameState = {
        ...removed,
        unitsAwaitingFreePlacement: [
          ...removed.unitsAwaitingFreePlacement,
          { unit: returning, playerIndex: found.ownerIndex },
        ],
      };
      return parkDecision(parked, {
        kind: THRILL_OF_THE_HUNT_PLACEMENT,
        playerIndex: found.ownerIndex,
        cardInstanceId: returning.instanceId,
      });
    },
  },
  "UNL-182": {
    // Curtain Call (Fury + Mind) — "[Repeat] — [1] / [rainbow] / [1][rainbow].
    // Choose one you haven't already chosen — Draw 1. / Deal 2 to a unit at a
    // battlefield. / Deal 3 to a unit at a base. / Give a unit at a battlefield
    // -4 [Might] this turn."
    //
    // # The four modes are written; the THREE `[Repeat]`s are not
    //
    // **This is the card 820.1.c.2 and c.3 were waiting for**, and card-effects.ts's
    // `REPEAT_COSTS` table says so in advance: "each of these prints exactly ONE
    // instance of Repeat, checked across the set ... this models one instance and
    // repeat-cost-table.test.ts asserts the premise — the day a set prints two,
    // that test fails and this shape is what changes." Curtain Call prints THREE,
    // each with its own cost, each payable or not payable individually. A
    // `RepeatCostSpec` is one cost, so no row in that table can express this; and
    // "one you haven't ALREADY chosen" additionally needs the mode to be re-chosen
    // per EXECUTION, where `modeId` is chosen once per action. Both live in
    // card-effects.ts, which this file does not own — see the report.
    //
    // So one execution, one mode. That is exactly the card with no Repeat paid,
    // which is how it will usually be cast; "you haven't already chosen" has
    // nothing to exclude when there is only one choice.
    //
    // # MEASURED 2026-08-14, so the next pass does not re-derive it
    //
    // This repo's standing rule is that a note about its own mechanisms is wrong
    // ten times out of eleven, so this is a measurement rather than a plan: 53
    // references to `repeatPaid` / `repeatChoices` / `repeatCostOf` across 12
    // files (`player-action`, `legal-actions`, `validate-play-card`,
    // `execute-play-card`, `card-effect-resolution`, `card-effects`, `coverage`,
    // `granted-keywords`, `game-state`, and three domain files). That is larger
    // than Syndra's fourth payment bucket, which was 17 sites across 10.
    //
    // What has to change, in dependency order:
    //   1. `REPEAT_COSTS` maps one defId to ONE `RepeatCostSpec`. Curtain Call
    //      needs a LIST — three instances, `[1]`, `[rainbow]`, `[1][rainbow]`.
    //   2. `PlayCardAction.repeatPaid` is a boolean. It has to become WHICH
    //      printed instances were paid, and `repeatChoices` has to become one
    //      entry PER paid instance — 820.2 gives each execution its own Make
    //      Relevant Choices step, which is what "one you haven't already chosen"
    //      reads.
    //   3. `card-effect-resolution` runs the effect once per paid instance with
    //      that instance's own choices, and the modes chosen must be DISTINCT
    //      across executions.
    //   4. The enumerator fan-out is the risk: 8 subsets of three instances,
    //      times up to 4! orderings of distinct modes, times targets per mode.
    //      **It needs a stated bound**, the same way `MAX_GROUPED_MOVERS` bounds
    //      the 144.3 move fan-out — the AI evaluates every action it is offered,
    //      and that lesson cost this repo a 5x slowdown on `reachability` the day
    //      this was written.
    //
    // **It should also close UNL-146 Syndra's recorded under-offer**, which is
    // the same missing thing from the other side: two GRANTED instances at once
    // (Syndra beside an armed Temporal Portal) have nowhere to be recorded while
    // `grantedRepeatPaid` is one boolean. Whoever builds the list for printed
    // instances should check whether the granted ones can share it, and delete
    // that divergence rather than leaving it to be rediscovered.
    //
    // # The action shape, settled by reading the code rather than guessed
    //
    // Step 1 landed: `REPEAT_COSTS` holds a list and `repeatCostsOf` is the
    // accessor. The next step is the ACTION, and the shape to use is ONE field
    // carrying the whole truth:
    //
    //     repeatExecutions?: readonly { instance: number; choices?: RepeatChoices }[]
    //
    // — one entry per PAID instance, `instance` indexing `repeatCostsOf(defId)`.
    // `RepeatChoices` already carries everything an execution needs INCLUDING
    // `modeId` (820.1.d's Rocket Barrage example put it there), so the
    // per-execution mode re-choice needs no new type; "one you haven't already
    // chosen" is a DISTINCTNESS check across the entries plus the base mode.
    //
    // **Do NOT add a second parallel list.** `repeatPaid` (26 readers in src, 11
    // test files) should stay as the derived "any printed instance was paid"
    // view, set alongside — two fields that each hold part of the truth is the
    // drift this repo keeps paying for, and one field plus a derived boolean is
    // not that.
    //
    // The bound belongs on the ENUMERATOR, not on the model: every subset of the
    // instances times every distinct mode ordering is 8 x up to 4! before
    // targets, and the AI evaluates everything it is offered.
    //
    // # The modes
    //
    // The two damage modes differ ONLY in where they may point, and the printed
    // asymmetry is the point of the card — 2 into a fight, or 3 into somebody's
    // base, where almost nothing in this pool can reach. `scope: "base"` is the
    // one scope that EXCLUDES battlefields rather than adding to them, and with no
    // owner word it is either player's base.
    //
    // None of the three targeted modes names an owner, so each may be pointed at
    // your own units. Dealing yourself 3 is a bad play rather than an illegal one,
    // and the debuff on your own unit is occasionally right (nothing here reads it
    // as a benefit); 355.9.b is what makes the printed location words binding while
    // leaving ownership open.
    //
    // NO floor on the debuff. Smoke Screen and Siphon Power print "to a minimum of
    // 1 [M]" and this does not, so `giveMightThisTurn` is called without one — a
    // 4-Might unit taken to 0 dies to the next point of damage, which is the card.
    distinctModesPerExecution: true,
    modes: [
      {
        id: "draw",
        label: "Draw 1",
        targeting: { kind: "none" },
        resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
      },
      {
        id: "burn-battlefield",
        label: "Deal 2 to a unit at a battlefield",
        targeting: { kind: "unit" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, CURTAIN_CALL_BATTLEFIELD_DAMAGE) : state,
      },
      {
        id: "burn-base",
        label: "Deal 3 to a unit at a base",
        targeting: { kind: "unit", scope: "base" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, CURTAIN_CALL_BASE_DAMAGE) : state,
      },
      {
        id: "shrink",
        label: "Give a unit at a battlefield -4 Might this turn",
        targeting: { kind: "unit" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -CURTAIN_CALL_SHRINK) : state,
      },
    ],
  },
};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-252": {
    // Super Mega Death Rocket! (Fury + Chaos) — "Deal 5 to a unit. When you
    // conquer, you may discard 1 to return this from your trash to your hand."
    //
    // The second sentence fires FROM THE TRASH, which is why `Listener` had to
    // reach beyond the board at all — no walk of permanents can see a spell in a
    // graveyard. `zone === "trash"` is asserted rather than assumed: the same
    // card sitting in HAND must not fire, and nothing else distinguishes them.
    //
    // "When YOU conquer" is the LEGEND's reading, not a unit's — a spell in the
    // trash is at no battlefield, so there is no "here" for it to be at. That is
    // the difference between this and Kai'Sa - Survivor's "when I conquer", and
    // it is why the two cannot share a condition.
    //
    // "You may DISCARD 1" is a cost, so nothing is asked with an empty hand
    // (416.3) — and that check is what stops the question appearing on every
    // conquest for the rest of the game.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.zone === "trash" &&
      state.players[listener.ownerIndex].hand.length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (state.players[listener.ownerIndex].hand.length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-252-return",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  /**
   * The ability Relentless Pursuit GRANTS — "When I conquer, you may move me to
   * my base."
   *
   * **Keyed by a grant key rather than by a defId**, which is the whole shape of
   * the mechanism: nothing on the board has the defId `SFD-184` (the spell is in
   * a trash by the time this can fire, and no trash listener walks it), so the
   * key names an ability rather than a card. `grantTriggersThisTurn` writes it
   * onto the unit and `triggers.triggerKeysOn` is what makes the listener walk
   * match it. Registering it under the bare `SFD-184` would have worked by
   * accident and read as a printed conquer trigger the spell does not have.
   *
   * **"When I conquer" is positional**, the reading every other "when I" in this
   * pool takes: the battlefield conquered must be the one the granted unit is
   * standing at, and the conqueror must be its controller.
   *
   * **"You MAY move me"** — a decision, not a freebie, and this one genuinely can
   * be wrong to take: leaving is giving up the battlefield you just took, which
   * is why a card that pushes a unit forward pairs it with a way home. Declining
   * leads, as everywhere else a "you may" is asked.
   *
   * "To my base" is `recallUnitToBase`, the helper Flash and Maddened Marauder
   * use — so it exhausts, and it is refused by Vilemaw's Lair's "units can't move
   * from here to base". Both are that helper's behaviour rather than choices
   * made here; the exhaustion question is already filed as Unverified in
   * docs/rules-conformance.md against those two cards, and this card inherits it
   * rather than adding a second reading.
   */
  "UNL-183": {
    // Rengar - Pridestalker (Fury + Body) — "When you play a unit, give a unit
    // +1 [Might] this turn."
    //
    // # A LEGEND registered in a domain file, which is new and is the point
    //
    // Every other Legend in this engine lives in `LEGEND_ABILITIES`, a shared
    // table a fanned-out agent cannot touch. Nothing forced that: `Listener.zone`
    // already has a `"legend"` case and `listeningPermanents` already ends with
    // `owner.legend`, so an entry in THIS registry keyed by a Legend's defId is
    // found by the ordinary listener walk and held as an ordinary Chain Pending
    // Item (383). The `zone === "legend"` check below is what makes that explicit
    // rather than incidental — the same way Super Mega Death Rocket asserts
    // `zone === "trash"` above instead of assuming no other copy can exist.
    //
    // # "When YOU play a unit"
    //
    // `casterIndex === listener.ownerIndex` — an opponent's unit is not his
    // moment. `playedKind === "Unit"` because `cardPlayed` fires for every card,
    // and a Spell must not pump anything.
    //
    // The unit just played is itself a legal choice: `deploy.playUnitToBase` and
    // `playUnitToBattlefield` both fire `cardPlayed` AFTER the unit has landed, so
    // it is already on the board when this resolves. That is the ordinary line —
    // the new body arrives a point bigger.
    //
    // # There is deliberately NO "is there anything to choose" gate
    //
    // The obvious one — refuse to trigger on an empty board, 355.8/383.4 — was
    // written first and then removed as **unreachable and therefore untestable**:
    // the unit that fired this is already on the board, so "you played a unit"
    // guarantees at least one legal choice. A mutation that deleted the gate
    // survived every test in the wave-5 file, which is what settled it; a branch
    // no measurement can distinguish is a branch that will be wrong quietly.
    //
    // The one case the gate would have covered is the played unit dying inside the
    // response window before this resolves. Then the decision's option list is
    // empty and decisions.ts drops the question, which is the same outcome by a
    // different route.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      listener.zone === "legend" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit",
    resolve: (state, listener) => parkDecision(state, { kind: "UNL-183-pump", playerIndex: listener.ownerIndex }),
  },
  "UNL-187": {
    // Vi - Piltover Enforcer (Fury + Order) — "When you conquer, if you assigned
    // 3 or more excess damage, you may exhaust me to ready a unit."
    //
    // Sivir - Ambitious (SFD-120, effects/body.ts) prints the same condition at 5
    // and Tryndamere - Barbarian at 5 as well, so the reading is settled rather
    // than invented here: "excess damage" is a term the rules never define —
    // `excess` appears in the PDF only under Burn Out — and `combat.excessAssigned`
    // records why all three candidate readings coincide. The number is written
    // once, by the damage step, into `state.lastShowdownExcessDamage`.
    //
    // **Two clauses of Sivir's that this card does NOT print**, and dropping them
    // is what makes it a different card rather than a copy:
    //  - no "after an attack". The record carries a battlefield and an attacking
    //    side anyway, so a conquest by walking into an empty battlefield reads 0
    //    and this stays silent — which is the same outcome, reached from the data
    //    rather than from a clause.
    //  - no "when I conquer". This is a LEGEND, who stands at no battlefield, so
    //    there is no "here" for it to be at and the trigger is the player's
    //    conquest — the same distinction Super Mega Death Rocket's "when you
    //    conquer" draws against Kai'Sa - Survivor's "when I conquer".
    //
    // The excess threshold is the trigger's printed CONDITION ("IF you assigned"),
    // so it is asked in `applies`, at the moment of the event — 383.4: "if those
    // requirements are not fulfilled when the unit gains the designation, it will
    // not trigger". Re-asking it in the body would let an opponent cancel a fired
    // trigger inside the response window.
    //
    // The EXHAUST is a cost, not a condition, so it is NOT asked here: it is
    // re-derived when the question is answered (414.4, "the action must be able to
    // be completed for the cost to be paid"), which is the same split Rek'sai -
    // Void Burrower makes on the same event.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      listener.zone === "legend" &&
      event.conquerorIndex === listener.ownerIndex &&
      excessAssignedBy(state, listener.ownerIndex, event.battlefieldId) >= VI_EXCESS_REQUIRED,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // Re-checked because neither fact can change inside the response window
      // (only a combat's damage step writes the record, and a combat cannot open
      // mid-chain) — so a mismatch here means the trigger was resolved for the
      // wrong event, not that the board moved.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      if (excessAssignedBy(state, listener.ownerIndex, event.battlefieldId) < VI_EXCESS_REQUIRED) return state;
      // An exhausted Vi cannot pay, so she is not asked at all — Rek'sai - Void
      // Burrower's conquer clause makes the same check in the same place, and for
      // the same reason: the exhaust is a cost, so it is read at RESOLUTION rather
      // than when the trigger fired (414.4), and the response window in between is
      // exactly where a Legend can be exhausted out from under it.
      if (state.players[listener.ownerIndex].legend.exhausted) return state;
      return parkDecision(state, { kind: "UNL-187-ready", playerIndex: listener.ownerIndex });
    },
  },
  "UNL-188": {
    // Hextech Gauntlets (Fury + Order) — "[Equip] [3][rainbow]" plus the ART-ONLY
    // band: "When I conquer, if you assigned 3 or more excess damage, draw 1."
    //
    // **The band is not in the card data.** `unl.json` stores the `[Equip]` line
    // and its cost rider and nothing else; the band was transcribed from the card
    // image, and it is why this gear reported nothing while the generated equip
    // ability registered the defId. See docs/unl-equipment-abilities.md, which
    // carries the same transcription for the other four UNL Equipment.
    //
    // # "I" is the WEARER
    //
    // A gear conquers nothing — it is not at a battlefield and does not fight — so
    // "when I conquer" can only be the unit wearing it. `wearerListener` rewrites
    // this gear's listener as that unit (same owner, the unit's card, the unit's
    // battlefield), which is what lets the ordinary positional test
    // `listener.battlefieldId === event.battlefieldId` be asked of a gear at all.
    // Blighted Battleaxe (UNL-019, effects/fury.ts) and the eight SFD bands are the
    // precedent. An UNATTACHED pair of gauntlets has no "I" and does nothing.
    //
    // # The condition is Vi's, one card over, and it is asked at FIRE time
    //
    // UNL-187 above prints "if you assigned 3 or more excess damage" verbatim, so
    // `excessAssignedBy` reads the one record the damage step writes rather than
    // this file inventing a second reading. **383.2.a.1** puts the question in
    // `applies` rather than in the body: "any additional conditional statement
    // immediately after the Condition must be true in order for the Condition to be
    // fulfilled. Such a conditional statement is part of the Trigger Condition and
    // not the Effect."
    //
    // Its own constant rather than Vi's `VI_EXCESS_REQUIRED`: Sivir - Ambitious
    // prints the same clause at 5, so the threshold is a per-card number and
    // sharing one would silently couple two cards that merely agree today.
    //
    // # The draw does NOT re-derive the wearer, and that is a DELIBERATE break
    // # from its eight siblings
    //
    // Warmog's Armor, Trinity Force and Boneshiver all call `wearerListener` a
    // second time inside `resolve`, because their payouts are ABOUT the wearer
    // (buff me, my controller's point, my controller's rune). This one's payout is
    // "draw 1" and names nobody, so the only thing it needs is the ability's
    // controller — which is the gear's, is stable, and is `listener.ownerIndex`.
    //
    // Re-deriving anyway would make the draw cancellable, and 383.2.a.1's own Sona
    // example says it must not be: "if she is removed in reaction to the triggered
    // ability, it will still resolve." That is reachable rather than theoretical —
    // Angle Shot (SFD-011) is a `[Reaction]` that detaches an Equipment, and
    // `battlefieldConquered` is a held event, so the window between the conquest and
    // this resolution is exactly where it would be cast.
    on: "battlefieldConquered",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldConquered" &&
        wearer !== undefined &&
        event.conquerorIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId && // "when *I* conquer"
        excessAssignedBy(state, wearer.ownerIndex, event.battlefieldId) >= HEXTECH_GAUNTLETS_EXCESS_REQUIRED
      );
    },
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // Re-checked because neither fact moves inside the response window — only a
      // combat's damage step writes the excess record, and a combat cannot open
      // mid-chain — so a mismatch here means this resolved against the wrong event
      // rather than that the board changed. The WEARER is the one fact that CAN
      // move, and is deliberately not re-asked; see above.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      if (excessAssignedBy(state, listener.ownerIndex, event.battlefieldId) < HEXTECH_GAUNTLETS_EXCESS_REQUIRED) return state;
      return drawCards(state, listener.ownerIndex, HEXTECH_GAUNTLETS_DRAW);
    },
  },
  [RELENTLESS_PURSUIT_GRANT]: {
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: "SFD-184-home",
        playerIndex: listener.ownerIndex,
        targetInstanceId: listener.card.instanceId,
      }),
  },
};

export const decisions: Record<string, DecisionDefinition> = {
  /**
   * The "you may" inside the ability Relentless Pursuit grants — "you may move me
   * to my base", asked when the granted unit conquers.
   *
   * Offered only while the unit is actually AT a battlefield, so a unit already
   * home (or dead, or moved away in the response window) asks nothing rather than
   * offering a move that would resolve to nothing. `recallUnitToBase` is itself a
   * no-op off a battlefield, so this is about not asking a pointless question
   * rather than about correctness.
   *
   * `targetInstanceId` is the unit, captured when the trigger fired — "me" means
   * the unit that conquered, and by the time the answer arrives "the unit that
   * conquered" is not something the board can be asked for.
   *
   * # The affirmative answer must carry its LABEL, not an `instanceId`
   *
   * Reported from play as *"unit didn't move to base after relentless pursuit"*.
   * The engine fires, asks and moves correctly — measured through `submit` and in
   * self-play — but the board never showed the player a way to say yes.
   *
   * `DecisionPrompt` splits a question's options in two: any option carrying an
   * `instanceId` the board can find is rendered as that CARD's art and its
   * `label` is DISCARDED; everything else becomes a labelled button. That is
   * right for a choice BETWEEN cards ("discard 1", "kill one of your units"),
   * where the prose says nothing the art doesn't. It is exactly wrong for a
   * yes/no, where the prose IS the answer: with the id attached, the only
   * labelled control on screen said **"Stay"**, and "Move to base" appeared
   * nowhere at all.
   *
   * So the unit is named in the PROMPT — which is rendered, as the overlay's
   * title — and the option carries only its label. Nothing is lost: the engine
   * never read that `instanceId` (`resolve` uses `d.targetInstanceId`), so it was
   * only ever a hint to the board, and the hint was wrong.
   *
   * **Not fixed by suppressing the option when the move is impossible**, which
   * was the first candidate: Vilemaw's Lair and Minotaur Reckoner both make
   * `recallUnitToBase` a no-op, and offering "Move to base" there does nothing.
   * 358.3.a settles it the other way — "if a Game Effect prevents the performance
   * of a game action, that effect doesn't prevent cards and abilities that
   * instruct a player to perform that game action from being played or finalized.
   * On resolution, that game action will be skipped as it is an impossible
   * instruction" — and 359.3.e.6 works Vilemaw's Lair BY NAME. Withholding the
   * option would have been the divergence.
   */
  "SFD-184-home": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId === undefined ? undefined : findUnitAnywhere(state, d.targetInstanceId);
      return `Relentless Pursuit: move ${unit?.unit.name ?? "that unit"} to your base?`;
    },
    options: (state, d) =>
      d.targetInstanceId !== undefined && findUnitOnBattlefield(state, d.targetInstanceId) !== undefined
        ? [
            { id: "decline", label: "Stay" },
            { id: "home", label: "Move to base" },
          ]
        : [],
    resolve: (state, d, optionId) =>
      optionId === "home" && d.targetInstanceId !== undefined ? recallUnitToBase(state, d.targetInstanceId) : state,
  },
  // Super Mega Death Rocket's "you may discard 1 to return this from your trash
  // to your hand", raised by its conquer trigger.
  //
  // Declining leads. The discard goes through `discardCards`, so anything
  // watching a discard (Jinx - Rebel's "when you discard one or more cards")
  // still fires — being spent as a cost is still a discard, the same reasoning
  // Cruel Patron's kill records.
  "OGN-252-return": {
    prompt: () => "Super Mega Death Rocket!: discard 1 to return it from your trash to your hand?",
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "discard", label: "Discard 1 and return it" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "discard" || !d.cardInstanceId) return state;
      const discarded = discardCards(state, d.playerIndex, 1);
      const actor = discarded.players[d.playerIndex];
      const rocket = actor.trash.find((c) => c.instanceId === d.cardInstanceId);
      // Gone from the trash between the trigger and the answer — a second copy
      // of this same question, or anything that churned the trash. The discard
      // has already been paid, which is the rules' own order for a cost.
      if (!rocket) return discarded;
      const players = [...discarded.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        trash: actor.trash.filter((c) => c.instanceId !== d.cardInstanceId),
        hand: [...actor.hand, rocket],
      };
      return { ...discarded, players };
    },
  },
  /**
   * Void Rush's "you may banish one, then play it, reducing its cost by
   * [2 Energy]. Draw any you didn't banish."
   *
   * Declining leads, as everywhere else a "you may" is asked, and it is a real
   * answer rather than a formality: declining draws BOTH revealed cards, which is
   * often better than paying for the one on top.
   *
   * "Draw any you didn't banish" runs on EVERY answer including the decline —
   * two instructions, not one, the same structure Baited Hook's "then recycle the
   * rest" has.
   */
  "SFD-188-banish": {
    prompt: () => "Void Rush: banish one of the top 2 and play it for 2 less Energy?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline (draw both)" }];
      for (const card of voidRushRevealed(state, d.playerIndex)) {
        // Priced when the OPTIONS are built, so a card whose reduced cost cannot be
        // paid is never offered — 416.3's "the action must be able to be completed
        // for the cost to be paid", the same shape Ava Achiever's offer uses.
        if (voidRushPayment(state, d.playerIndex, card) === undefined) continue;
        options.push({ id: card.instanceId, label: voidRushLabel(state, d.playerIndex, card), instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      const revealed = voidRushRevealed(state, d.playerIndex);
      const named = optionId === "decline" ? undefined : revealed.find((c) => c.instanceId === optionId);
      // Re-paid here rather than trusted from the option list, which was built
      // against an earlier state. If the pool has drained in between, nothing is
      // banished and both cards are drawn — an unpayable cost withholds the payoff
      // instead of handing it over free, exactly as The Harrowing's replay does.
      const paid = named ? voidRushPayment(state, d.playerIndex, named) : state;
      const chosen = paid ? named : undefined;
      const base = paid ?? state;

      // BOTH revealed cards come off the deck first, whichever way this went.
      // Necessary rather than tidy: a Spell played below can draw, and leaving the
      // un-banished card on top would let it be drawn twice.
      const drawn = revealed.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...base.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: players[d.playerIndex].deck.slice(revealed.length),
        // "PLAY it" — this one IS a card you played, so [Legion] and Viktor -
        // Innovator both see it. Baited Hook and Ava Achiever make the same call;
        // the free plays a card performs on ITSELF (Portal Rescue's blink) do not.
        ...(chosen ? { cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1 } : {}),
      };
      const offDeck: GameState = { ...base, players };

      // Printed order: play, THEN draw the other. The banish is transient — banished
      // and played in one instruction — so the card goes straight to play rather
      // than through `PlayerState.banished`.
      //
      // **Divergence, inherited from `playCardIgnoringCost` and named here because
      // this card can hit anything:** a revealed SPELL resolves IMMEDIATELY rather
      // than going on the chain, and with NO targets, because nothing announced it.
      // A targeted spell played this way therefore does as much as it can and no
      // more — which for Incinerate is nothing at all. Recorded in
      // docs/rules-conformance.md against play-free.ts.
      const played = chosen ? playCardIgnoringCost(offDeck, d.playerIndex, chosen) : offDeck;
      if (drawn.length === 0) return played;
      const after = [...played.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = { ...after[d.playerIndex], hand: [...after[d.playerIndex].hand, ...drawn] };
      return { ...played, players: after };
    },
  },
  /**
   * Rengar - Pridestalker's "give a unit +1 [Might] this turn", asked once per
   * unit its controller plays.
   *
   * **No decline, because the card prints none.** "Give a unit +1" is mandatory,
   * so with one unit on the board `advanceDecisions` auto-resolves it without a
   * prompt — which is right: a question with one legal answer is not a question.
   * The Rengar test asserts the pump lands in exactly that case, so an accidental
   * "Decline" option would be caught rather than silently making the card
   * optional.
   *
   * Either player's units, in either zone: the card names no owner and no
   * location (355.9.a.1). Buffing an enemy is a bad play rather than an illegal
   * one, and the case that matters is a board where the only unit is theirs —
   * "give A unit" then has exactly one answer, and it is not the one you want.
   */
  "UNL-183-pump": {
    prompt: () => "Rengar - Pridestalker: give a unit +1 Might this turn",
    options: (state, d) =>
      anyUnitChooseableBy(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => giveMightThisTurn(state, optionId, RENGAR_MIGHT),
  },
  /**
   * Vi - Piltover Enforcer's "you may exhaust me to ready a unit", raised by her
   * conquer trigger once the excess threshold is met.
   *
   * ONE question rather than two, unlike Rek'sai's pair: her cost buys nothing a
   * player could want to see first, so committing the exhaust and naming the unit
   * are the same decision. Rek'sai's are split because her cost buys a REVEAL,
   * and collapsing hers would make a player commit to results they have already
   * been shown.
   *
   * The exhaust is re-derived here rather than trusted from the trigger (414.4) —
   * a response window sits between them, and anything that exhausts a Legend in it
   * takes the offer away.
   *
   * **Only EXHAUSTED units are offered**, which is a narrowing and is 415.1.b's:
   * "a Unit that is already Ready cannot be Readied again", so offering one would
   * spend Vi on a no-op. Contrast Leona - Radiant Dawn, who deliberately DOES
   * offer already-buffed units — 702.3.a makes a second buff a no-op rather than
   * illegal, and there the whole answer can honestly be "nothing happens". Here
   * the player is paying an exhaust for it.
   *
   * "Ready A UNIT", no owner word, so either player's (355.9.a.1) — readying an
   * enemy is a bad play, not an illegal one, and `readyUnit`'s own
   * `mayReadyPermanent` gate is what refuses it under Mageseeker Warden.
   */
  "UNL-187-ready": {
    prompt: () => "Vi - Piltover Enforcer: exhaust her to ready a unit?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (state.players[d.playerIndex].legend.exhausted) return options;
      for (const unit of anyUnitChooseableBy(state, d.playerIndex)) {
        if (!unit.exhausted) continue;
        options.push({ id: unit.instanceId, label: `Exhaust Vi and ready ${unit.name}`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const owner = state.players[d.playerIndex];
      if (owner.legend.exhausted) return state; // cost no longer payable
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...owner, legend: { ...owner.legend, exhausted: true } };
      return readyUnit({ ...state, players }, optionId);
    },
  },
  /**
   * Thrill of the Hunt's "to any battlefield" — see the card above for why the
   * option list is every battlefield and not `playUnitFree`'s.
   *
   * No decline: the play is not a "you may". A board with one battlefield
   * auto-resolves, which is the correct reading of a mandatory choice with one
   * legal answer.
   *
   * An empty list when the pen no longer holds the unit is how decisions.ts drops
   * a question that no longer applies — the same shape Sett - The Boss's save
   * uses. Nothing in this pool can empty the pen between the park and the answer
   * (the queue is answered before any other action), so this is the "moot" branch
   * rather than a reachable one.
   */
  [THRILL_OF_THE_HUNT_PLACEMENT]: {
    prompt: (state, d) => `Thrill of the Hunt: where does ${awaitingThrillUnit(state, d.cardInstanceId)?.name ?? "it"} enter play?`,
    options: (state, d) =>
      awaitingThrillUnit(state, d.cardInstanceId) === undefined
        ? []
        : state.battlefields.map((bf) => ({ id: bf.id, label: bf.name })),
    resolve: (state, d, optionId) => {
      const held = state.unitsAwaitingFreePlacement.find((p) => p.unit.instanceId === d.cardInstanceId);
      if (!held) return state;
      const released: GameState = {
        ...state,
        unitsAwaitingFreePlacement: state.unitsAwaitingFreePlacement.filter((p) => p.unit.instanceId !== held.unit.instanceId),
      };
      const deployed = playUnitToBattlefield(released, held.playerIndex, held.unit, optionId);
      // Contested is applied by the CALLER, which deploy.ts's own note explains:
      // arriving at a battlefield can make it Contested and can be an attack, and
      // only the card that played the unit knows which. A unit appearing from a
      // card's text is a unit becoming present (190.3.a), so it contests exactly
      // as a walk-in does — which for this card is the whole point.
      return applyContested(deployed, optionId, held.playerIndex);
    },
  },
};

export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-185": {
    // Pyke - Bloodharbor Ripper (Fury + Chaos) — "[1], [Exhaust]: Return a
    // friendly unit at a battlefield to its owner's hand. Play a Gold gear token
    // exhausted."
    //
    // Miss Fortune - Bounty Hunter's shape (`kind: "Legend"`, a targeted exhaust
    // ability) with a price on it, and `ActivationCost` already carries both
    // halves — `{ energy, exhaust }` is what the two preset Legend abilities
    // print. Nothing new was needed at the cost end.
    //
    // # The bounce is a COST-LIKE mandatory, so it gates the whole ability
    //
    // "Return a friendly unit AT A BATTLEFIELD" is the first instruction and it
    // names a target, so 355.8 makes the ability unusable with nothing at a
    // battlefield to return — which means Pyke cannot mint a Gold off an empty
    // board. That is the card rather than a limitation: the Gold is payment for
    // pulling one of your own bodies out of a fight, and enumeration refusing to
    // offer the ability with no legal target is what enforces it.
    //
    // `scope` left at its default so the printed "at a battlefield" binds
    // (355.9.b, the NARROWING half), and `owner: "friendly"` from the printed
    // word. "Its OWNER's hand" and the caster's are the same player under
    // friendly-only targeting; `returnPermanentToHand` files it by owner anyway,
    // which is what keeps that an observation.
    //
    // # The Gold is unconditional
    //
    // Two sentences, not one instruction with a rider, so the token lands even if
    // the returned unit died in the window between activation and resolution.
    // `placeGoldTokens` mints it EXHAUSTED already — 149.1 has gear entering
    // ready, so the sixteen cards printing "exhausted" are the ones overriding a
    // default (184.1), and the token's own "[Reaction][>] Kill this, [Exhaust]:
    // [Add] [rainbow]" is registered against `GOLD_TOKEN_DEF_ID` rather than here.
    kind: "Legend",
    cost: { energy: PYKE_ENERGY_COST, exhaust: true },
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const returned = event.targetUnitInstanceId ? returnPermanentToHand(state, event.targetUnitInstanceId) : state;
      return placeGoldTokens(returned, ctx.casterIndex, 1);
    },
  },
};

/** Empty, and deliberately declared: `effects/index.ts` reads every registry
 *  off every module, so a missing export is `undefined` at merge time rather
 *  than an empty table. Declaring them keeps adding a card here to one line.
 */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};
export const mightModifiers: Record<string, MightModifier> = {};
