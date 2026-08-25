import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellDefinition,
  DeathWatchDefinition,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import { isAttackingAt, isFightingAt, isStillHere } from "../combat-designation.js";
import type { DecisionDefinition } from "../decisions.js";
import type { GameState, PendingDeath, PendingDecision, PlayerState } from "../../model/game-state.js";
import type { CardInstance, UnitInstance } from "../../model/card.js";
import type { AnyUnitLocation } from "../target-lookup.js";
import {
  addBuff,
  recycleTopCard,
  dealDamageToEnemyUnitsAtBattlefield,
  recordModeUsed,
  channelRunesExhausted,
  dealDamage,
  drawCards,
  exhaustGear,
  forceMoveToBattlefield,
  gainXp,
  forceMoveToDestination,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  grantTemporary,
  ownUnitsEverywhere,
  readyRunes,
  returnPermanentToHand,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  returnUnitToHand,
  stunUnits,
  takeOneFromTopAndRecycleRest,
  disempowerPermanent,
  empowerPermanent,
  armNextCardDiscount,
  fileIntoTrash,
  isEmpowered,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { HOURGLASS_SAVE, applyHourglass, hasHourglass, pendingDeathFor, releasePendingDeath } from "../death-ward.js";
import { resumeDeathAfterHourglass } from "../effect-helpers.js";
import { counterSpell, gainControlOfSpell } from "../counter-spell.js";
import { wearerListener } from "../equipment.js";
import { playCardIgnoringCost } from "../play-free.js";
import { effectiveMight } from "../effective-might.js";
import { currentMightContext, findUnitAnywhere } from "../target-lookup.js";
import { holdCardsRecycled } from "../effect-helpers.js";
import { cardModeOf } from "../card-effects.js";
import { spellsOnChain } from "../counter-spell.js";
import { eligibleTargets, retargetCandidates, spellOnChain } from "../target-lookup.js";
import {
  offerTopOfDeckBanish,
  revealedFromDeck,
  voidHatchlingAnswer,
  voidHatchlingGate,
  voidHatchlingOptions,
} from "../top-of-deck.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { gainPoints } from "../effect-helpers.js";
import { SAND_SOLDIER_TOKEN, placeToken, type TokenSpec, BIRD_TOKEN } from "../token.js";

/**
 * Card implementations for **Calm** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Calm. A test in
 * test/effect-registry.test.ts enforces it, so a card filed in the wrong place
 * fails the suite rather than being merged and forgotten.
 *
 * Cards with TWO domains (the champion signature spells) belong in
 * effects/signature.ts, and Legends in engine/legend-abilities.ts — every Legend
 * is dual-domain by definition, so splitting those by domain is meaningless.
 *
 * To add a card:
 *   1. Register it under its defId in `cardEffects` (Spell/Gear) or
 *      `unitTriggers` (Unit's on-play ability), matching the shapes in
 *      card-effects.ts / unit-triggers.ts.
 *   2. Cite the rule or the oracle implementation the behaviour comes from —
 *      "mirrors <the Java oracle>" is not a rules citation, see
 *      docs/rules-conformance.md on why this project distinguishes them.
 *   3. Add an engine test. A silently-inert card is indistinguishable from a
 *      working one in play, which is exactly how the current gap went unnoticed.
 *
 * Composition rejects duplicates, so registering a defId that some other file
 * already handles throws at import rather than silently shadowing it.
 */
const FERAL_STRENGTH_MIGHT = 2;

/** Herald of Spring's on-play XP. Named because the card ALSO prints `[Hunt]`,
 *  whose magnitude is 1 — two different numbers on one card is exactly where a
 *  bare literal gets read as the other one. */
const HERALD_OF_SPRING_XP = 2;

/**
 * `[Level N]` — rule 824, a Dependent Keyword (727).
 *
 * 824.1.b.1 gives the whole of it: the clause "is functionally short for 'While
 * you have [N] or more XP, this card gains `[Text]`'", and 824.1.c/824.1.d make
 * the dependent ability Active exactly while the CONTROLLER has that much and
 * Inactive "as soon as the controlling player has less than [N] XP".
 *
 * Written inline per card rather than as a general dependent-ability layer, and
 * that is the recommendation `docs/xp-and-unl-keywords-scope.md` reached rather
 * than a shortcut taken here: `[Legion]` is the same family and is already nine
 * inline checks, each threshold grants a DIFFERENT effect, and one card
 * (Master Yi - Unstoppable) prints four thresholds at once — so a table keyed by
 * the keyword's magnitude cannot express what the ability is. Extracting a layer
 * from working call sites is possible later; guessing one from none is not.
 *
 * The threshold is a hand-written constant per card rather than read back off
 * `def.keywords.Level`, for the reason `card-loader`'s own note gives:
 * `parseKeywords` keeps ONE value per keyword, so a four-threshold card parses as
 * 16 and every other clause on it would silently read the wrong number.
 *
 * **A card's controller, which for all three cards here is the caster.** 824.1.c.1
 * says a change of controller re-evaluates the condition against the NEW
 * controller's XP; nothing in this pool takes control of a unit, and the two
 * spells are gone by then.
 */
function atLevel(state: GameState, playerIndex: 0 | 1, threshold: number): boolean {
  return state.players[playerIndex].xp >= threshold;
}

/** Combat Experience's two amounts. "Give it +3 ... INSTEAD", so the levelled
 *  number REPLACES the printed one rather than adding to it. */
const COMBAT_EXPERIENCE_MIGHT = 1;
const COMBAT_EXPERIENCE_LEVELLED_MIGHT = 3;
/** Its `[Level 6]` threshold, and Wuju Apprentice's — the same number on two
 *  cards, named separately so raising one card's band cannot silently move the
 *  other's. */
const COMBAT_EXPERIENCE_LEVEL = 6;
/** Skyward Strike — "[Level 6][>] [Stun] an enemy unit." */
const SKYWARD_STRIKE_LEVEL = 6;
const WUJU_APPRENTICE_LEVEL = 6;

/** Double Trouble looks at three. */
const DOUBLE_TROUBLE_LOOK = 3;

/** Scuttle Crab's Deathknell XP — 1, and named because the same card's printed
 *  "draw 1" is also a 1 and the two are unrelated numbers. */
const SCUTTLE_CRAB_XP = 1;

/** Honeyfruit's three numbers. The threshold is hand-written rather than read
 *  back off `def.keywords.Level` for the reason `atLevel`'s note gives, and the
 *  two payouts are named apart because they come from DIFFERENT printed
 *  abilities that happen to share a magnitude. */
const HONEYFRUIT_POWER = 1;
const HONEYFRUIT_LEVEL = 6;
const HONEYFRUIT_LEVEL_ENERGY = 1;

/** Ivern - Nurturer looks at three as well. Its OWN constant beside Double
 *  Trouble's, not a shared one: the two cards agree on the number today and
 *  nothing ties them together, so folding them would make a reprint of either
 *  silently move the other. */
const IVERN_LOOK = 3;

/**
 * The 1-Might `[Deflect]` Bird that Frisky Hunter and Flurry of Feathers both
 * make is `token.BIRD_TOKEN` — SHARED from there since 2026-08-09, after three
 * wave-2 agents each wrote a byte-identical private copy. Its own comment there
 * records why the `[Deflect 1]` is the part that made sharing urgent.
 */

/** Flurry of Feathers' second mode — "play FOUR 1 Might Bird unit tokens". */
const FLURRY_OF_FEATHERS_BIRDS = 4;

/**
 * Friendship's four tags — "for each of the following tags among your units —
 * Bird, Cat, Dog, and Poro".
 *
 * A list of the four PRINTED tags rather than a count of matching units: the
 * card asks how many of these tags are present, so nine Poros are worth 1 and a
 * single Bird/Cat/Dog/Poro menagerie is worth 4. Writing it as "count your units
 * that carry any of these" is the natural mis-read and would be wrong in both
 * directions.
 */
const FRIENDSHIP_TAGS = ["Bird", "Cat", "Dog", "Poro"] as const;

/**
 * Mosstomper's `[Level 3][>] I have +1 Might and [Deflect]`.
 *
 * Only the MIGHT half is written, through `mightModifiers` at the foot of this
 * file — see that entry for the `[Deflect]` half, which is a divergence rather
 * than an omission (it is currently ON at 0 XP, because `parseKeywords` reads the
 * bracket out of the band and hands him a flat printed `[Deflect 1]`).
 */
const MOSSTOMPER = "UNL-047";
const MOSSTOMPER_LEVEL = 3;
const MOSSTOMPER_MIGHT = 1;

/** Soul Sword's art-only band, `[Level 3][>] I have an additional +1 Might`
 *  (docs/unl-equipment-abilities.md). Its printed `[Equip] [Calm]` and its +1
 *  badge are both already handled — see `activatedAbilities` below. */
const SOUL_SWORD = "UNL-039";
const SOUL_SWORD_LEVEL = 3;
const SOUL_SWORD_LEVELLED_MIGHT = 1;

/** Vilemaw's second clause — "Enemy units here with less Might than me don't
 *  deal combat damage." His `[Ambush]` is the loader's and his "when I hold,
 *  draw 1" is the `eventTriggers` entry above; this is the third and last, and it
 *  lives at the foot of this file in `mightModifiers`. Declared HERE rather than
 *  beside that entry for the reason effects/order.ts's Galio note records: the
 *  table's `defId:` is evaluated at module init, so a `const` below it is in the
 *  temporal dead zone and every import of effects/index.ts throws. */
const VILEMAW = "UNL-060";
/** Big enough that no sum of printed Might, auras, buffs, Equipment badges and
 *  this-turn pumps in this pool can survive it, so `effectiveMight`'s closing
 *  `Math.max(0, m)` always lands on 0 (143.2.b). Not a Might value — a floor
 *  expressed in the one arithmetic this seam has. A second copy of the same
 *  sentinel effects/order.ts declares for Galio - Indefatigable, local because
 *  that file is not this one's to edit; consolidating the pair is the
 *  integrator's, exactly as `BIRD_TOKEN`'s was. */
const NO_COMBAT_DAMAGE_PENALTY = 1000;

/**
 * Trevor Snoozebottom's Sprite — "a ready 3 Might Sprite unit token with
 * [Temporary]".
 *
 * **A LOCAL spec that owes a move to `token.ts`, and it is the SAME drift the
 * Bird's note above records having already happened three times.** Three cards
 * across two domains print this exact token (OGN-106 Sprite Mother and OGN-094
 * Sprite Call in Mind, this one in Calm), so `effects/mind.ts` has a private
 * `SPRITE_TOKEN` of its own that this is byte-identical to. It is here rather
 * than shared only because this change owns one file; consolidating it is the
 * integrator's, exactly as `BIRD_TOKEN`'s was.
 *
 * `entersReady` is the card's word ("play a READY ... token"), overriding
 * 143.4.a's exhausted default, and `Temporary` is a real keyword —
 * `turn-manager.killTemporaryPermanents` destroys what carries it at the start of
 * its controller's Beginning Phase, which is the whole drawback.
 */
const SPRITE_TOKEN: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };

/** Vendetta's Calm, wave 2. */
const AFFECTIONATE_PORO = "VEN-024";
/** Crumbling Sands' "an opponent has played ANOTHER spell this turn" — the spell
 *  being countered is itself one of them and has already been counted, so the
 *  threshold is TWO. */
const CRUMBLING_SANDS_SPELLS = 2;
const RESONATING_STRIKE_MIGHT = 2;
const DECREE_OF_FOCUS_MIGHT = 4;
const RIVEN_SHATTERED = "VEN-041";
const RIVEN_DAMAGE_PER_EQUIPMENT = 2;
const ASTRAL_HERON = "VEN-044";
const ASTRAL_HERON_ENERGY = 2;
const ASTRAL_HERON_POWER = 2;

/** Vendetta's Calm, wave 1. */
const FIELD_MUSICIANS_MIGHT = 3;
const TWILIGHT_SHROUD_MIGHT = 1;
const TOMB_RAIDER_BARBARA = "VEN-037";
const TOMB_RAIDER_BARBARA_RUNES = 7;
const AKALI_SILENT = "VEN-038";
const AKALI_SILENT_MIGHT = 2;
const PAKAA_PROTECTOR = "VEN-033";
const PAKAA_PROTECTOR_MIGHT = 2;
const SHEN_SCOURGE = "VEN-042";
/** "EXACTLY one other unit you control here" — the formation four cards in this
 *  set turn on, and the boundary a board built with a single ally cannot see. */
const SHEN_SCOURGE_ALLIES = 1;

/**
 * Twilight Shroud's shroud — marks ONE unit unchooseable by enemies for the turn.
 *
 * Written onto the instance rather than into a state-level list, and swept by
 * `runEnd`: see `UnitInstance.unchooseableByEnemiesThisTurn` for why this is a
 * third shape rather than an entry in the defId table. No-ops on a unit that has
 * left play (359.3.e.12).
 */
function shroudUnit(state: GameState, targetInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === targetInstanceId ? { ...u, unchooseableByEnemiesThisTurn: true } : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(mark);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * How many OTHER units its controller has at the battlefield this one is
 * standing at — Shen, Scourge of Shadows' "exactly one other unit you control
 * here".
 *
 * A private copy of the one in effects/order.ts, deliberately: the shared home
 * would be effect-helpers.ts, and the one-file-one-owner rule these domain files
 * exist for keeps a card implementation out of the shared file. Both copies are
 * four lines around the same walk, which is the trade `recycleTopCard` records.
 *
 * Returns 0 for a unit in base — a base is not a battlefield, so "here" has no
 * answer and "exactly one" is false, which is the right reading rather than an
 * edge case.
 */
function otherOwnUnitsHereForShen(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): number {
  const owner = state.players[ownerIndex];
  const here = state.battlefields.find((bf) => (bf.units[owner.id] ?? []).some((u) => u.instanceId === unit.instanceId));
  if (!here) return 0;
  return (here.units[owner.id] ?? []).filter((u) => u.instanceId !== unit.instanceId).length;
}

/**
 * Pakaa Protector's "otherwise, put it in your trash" — the revealed top card,
 * moved from the deck to the trash.
 *
 * Through `fileIntoTrash` with `"mainDeck"`, which is the honest source: the card
 * is coming off the top of the Main Deck, so Endless Riches does NOT banish it
 * instead. That is the same exemption a Burn takes, and reading it the other way
 * would make the two cards disagree about the same movement.
 */
function updatePlayerForPakaa(state: GameState, ownerIndex: 0 | 1, top: CardInstance): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const owner = players[ownerIndex];
  players[ownerIndex] = {
    ...owner,
    deck: owner.deck.slice(1),
    ...fileIntoTrash(state, ownerIndex, owner, top, "mainDeck"),
  };
  return { ...state, players };
}

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-034": {
    // Resonating Strike — "[Hidden] [Reaction] Choose a battlefield you control
    // and a unit you control AT A DIFFERENT LOCATION. Move that unit to that
    // battlefield and give it +2 [Might] this turn."
    //
    // Two targets of DIFFERENT KINDS with a cross-constraint between them, which
    // `unitSlots` (two units) and `chainSpellAndUnit` (a spell and a unit) do not
    // cover — so it reuses the existing `moveTarget` shape: a unit plus a
    // destination battlefield, which `MOVE_TARGET_SPELL_DEF_IDS` already fans out
    // as one action per (unit, destination) pair.
    //
    // **"A battlefield YOU CONTROL" and "at a DIFFERENT location" are both
    // narrowings on that fan-out**, and the second is what makes the card a move
    // rather than a pump: a unit already there has nowhere to go, and offering it
    // would be an action that changes only the Might.
    //
    // `forceMoveToBattlefield` is the funnel, so a move trigger fires and the
    // arrival is a real move (456) rather than a relocation.
    // Charm's shape (`MOVE_TARGET_SPELL_DEF_IDS`), which fans out one action per
    // (unit, destination) pair: the unit is the TARGET and the battlefield rides
    // on `destinationBattlefieldId` as a place rather than a second target.
    //
    // "A unit YOU CONTROL" is `owner: "friendly"`; "a battlefield you control"
    // and "at a DIFFERENT location" are both narrowings on the DESTINATION half,
    // which `MOVE_TARGET_DESTINATION_RULES` owns — the same split Twilight Step
    // records, where the Might ceiling is the spec's and the destination axis is
    // the table's.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const moved = forceMoveToDestination(state, unitId, event);
      return giveMightThisTurn(moved, unitId, RESONATING_STRIKE_MIGHT);
    },
  },
  "VEN-039": {
    // Crumbling Sands — "[Reaction] Counter a spell IF AN OPPONENT HAS PLAYED
    // ANOTHER SPELL THIS TURN."
    //
    // A 1-Energy counter with a condition that is about the TURN rather than
    // about the spell being countered — which is what makes it a punish for a
    // second spell rather than a general answer.
    //
    // **"ANOTHER" means besides the one on the chain**, so the threshold is TWO
    // spells from that opponent this turn: the one being countered is itself one
    // of them, and it has already been counted by `spellsPlayedThisTurn` when
    // this resolves.
    //
    // Checked at RESOLUTION rather than on the offer, deliberately: it is the
    // spell's printed condition (402.1), and the count can rise in the response
    // window — a second enemy spell cast in reply is exactly what turns this on.
    targeting: { kind: "chainSpell" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetChainCardInstanceId;
      if (!targetId) return state;
      const opponentIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      if (state.players[opponentIndex].spellsPlayedThisTurn < CRUMBLING_SANDS_SPELLS) return state;
      return counterSpell(state, targetId);
    },
  },
  "VEN-040": {
    // Decree of Focus — "[Reaction] Choose a friendly unit that's IN COMBAT WITH
    // an enemy Fury ([Fury]) unit OR that's BEING CHOSEN BY an enemy Fury spell.
    // Give it +4 [Might] this turn."
    //
    // # The condition is two questions about two different places
    //
    // One disjunct is about the BOARD (who is standing at the contested
    // battlefield), the other about the CHAIN (what is pointed at this unit right
    // now). Both are why the card is a `[Reaction]`: it is bought to be held up,
    // and the second disjunct only ever has an answer while something is
    // resolving.
    //
    // Too card-specific to be a targeting AXIS, so it is a NAMED narrowing —
    // `narrowing: "VEN-040-focus"`, defined in `target-lookup`'s
    // `NAMED_UNIT_NARROWINGS` beside `UNCHOOSEABLE_BY_ENEMIES`, which makes the
    // same trade for the same reason. An axis called
    // `inCombatWithDomainOrChosenBySpellOfDomain` would be a worse lie than
    // admitting the condition belongs to one card.
    //
    // Applied in all three shared places (enumerator, validator,
    // `hasAnyLegalEffectChoice`), so a unit that does not qualify is never
    // offered rather than being refused after a click.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", narrowing: "VEN-040-focus" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, DECREE_OF_FOCUS_MIGHT)
        : state,
  },
  "VEN-031": {
    // Twilight Shroud — "Give a friendly unit +1 [Might] this turn. It can't be
    // chosen by enemy spells and abilities this turn. [Flow] [2 Energy]."
    //
    // The pump is incidental; the SHROUD is the card, and it needed a third shape
    // of prohibition. `UNCHOOSEABLE_BY_ENEMIES` is keyed by defId and answers a
    // question about a CARD (Ruin Runner, Baron Nashor, Master Yi - Unstoppable);
    // Alpha Wildclaw's is an aura over other units. Neither can say "this body,
    // until the turn ends", so `UnitInstance.unchooseableByEnemiesThisTurn` is a
    // per-instance flag swept by `runEnd`.
    //
    // Read by `unitChooseableBy` — the predicate the enumerator, the validator and
    // `hasAnyLegalEffectChoice` all go through — so a shrouded unit vanishes from
    // every enemy offer at once rather than being refused after a click.
    //
    // "A FRIENDLY unit", bare on location, so `scope: "anywhere"` (355.9.a.1).
    // [Flow] needs nothing here (829.1.c.1 is plumbed generically).
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? shroudUnit(giveMightThisTurn(state, event.targetUnitInstanceId, TWILIGHT_SHROUD_MIGHT), event.targetUnitInstanceId)
        : state,
  },
  "VEN-035": {
    // Sanction — "[Reaction] Choose one — Empower a unit. Disempower it at end of
    // turn. / Disempower a unit that's [Empowered]. Empower it at end of turn."
    //
    // Two modes that are exact mirrors, and the pair is why the engine now has
    // BOTH `disempowerAtEndOfTurn` (built for Tornado Warrior) and its twin
    // `empowerAtEndOfTurn`. Two lists rather than one signed list: both can be
    // armed in the same turn by two Sanctions, and `runEnd` applies the
    // disempowers first so a permanent named by both ends the turn Empowered —
    // the order the card's own two sentences read in.
    //
    // **The second mode's target is narrowed to an ALREADY-Empowered unit**, which
    // the first mode's is not: "disempower a unit THAT'S [Empowered]" is printed,
    // and without it the mode would be a way to Empower an enemy unit at end of
    // turn for free. Filtered on the offer rather than checked in the resolver.
    //
    // Neither mode names an owner, so both reach either side (355.9.a.1) —
    // Empowering an enemy unit for a turn to strip it later is a real line.
    modes: [
      {
        id: "empower",
        label: "Empower a unit, disempower it at end of turn",
        targeting: { kind: "unit", scope: "anywhere" },
        resolve: (state, _ctx, event) => {
          const id = event.targetUnitInstanceId;
          if (!id) return state;
          return { ...empowerPermanent(state, id), disempowerAtEndOfTurn: [...state.disempowerAtEndOfTurn, id] };
        },
      },
      {
        id: "disempower",
        label: "Disempower an Empowered unit, empower it at end of turn",
        targeting: { kind: "unit", scope: "anywhere", empoweredOnly: true },
        resolve: (state, _ctx, event) => {
          const id = event.targetUnitInstanceId;
          if (!id) return state;
          return { ...disempowerPermanent(state, id), empowerAtEndOfTurn: [...state.empowerAtEndOfTurn, id] };
        },
      },
    ],
  },
  "SFD-031": {
    // Desert's Call — "[Repeat] [2] Play a 2 Might Sand Soldier unit token."
    //
    // **Rule 820.1.d's own worked example**, quoted in full: "Desert's Call is a
    // spell with [Repeat] [2] and 'Play a 2 [Might] Sand Soldier unit token.' If
    // its controller pays its Repeat cost as they play it, the card's instruction
    // to play a Sand Soldier is executed twice, as though the card says 'Play a 2
    // [Might] Sand Soldier unit token. Play a 2 [Might] Sand Soldier unit
    // token.'" So two tokens, from one play, and this resolver needs to know
    // nothing about that — card-effect-resolution.ts calls it twice.
    //
    // Placement follows Sprite Call exactly: base by default, and the
    // destination the caster named when there is one. Both executions read the
    // SAME `destinationBattlefieldId`, which is right — 820.1.d lets the second
    // execution make different CHOICES, and this card's instruction makes none;
    // where a played unit lands is 813's question, answered once for the play.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) =>
      placeToken(
        state,
        ctx.casterIndex,
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base",
        SAND_SOLDIER_TOKEN,
      ),
  },
  "SFD-040": {
    // Thwonk! — "[Action] [Repeat] [2] Stun an attacking unit. (It doesn't deal
    // combat damage this turn.)"
    //
    // The first card in the pool to target by combat DESIGNATION rather than by
    // owner, Might or zone — see `attackingOnly` on TargetingSpec, and
    // `unitSatisfiesAttackingOnly` for why the predicate is shared across the
    // enumerator, the validator and `hasAnyLegalEffectChoice`.
    //
    // No owner clause: "an attacking unit" is whoever is attacking, and in a
    // Showdown you started that is YOUR unit. Stunning your own attacker is a
    // legal misplay rather than a shape the targeting should forbid — the same
    // reading Blood Rush and Frigid Touch take.
    //
    // UNCASTABLE with nobody attacking, which is the point of putting the
    // restriction in the spec rather than in the resolver: for a Spell the
    // targeting IS the effect, so "no legal target" really does mean "cannot
    // cast" rather than "cast it and waste it".
    //
    // **Repeating it is usually pointless and legal anyway.** Stunning is a flag,
    // not a counter (`stunUnits` sets `stunned`), so a second stun on the same
    // unit changes nothing — the same per-keyword redundancy (801.3.a.1) gives Blood Rush's
    // keyword. It earns its Repeat cost only by naming a DIFFERENT attacker the
    // second time, which 820.1.d expressly allows.
    targeting: { kind: "unit", attackingOnly: true },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "SFD-034": {
    // Feral Strength — "[Reaction] [Repeat] [2] Give a unit +2 Might this turn."
    //
    // "A unit", not "a unit at a battlefield", so 355.9.a.1 puts a unit in either
    // base on the target list — the same reading Smoke Screen and En Garde take,
    // and no owner clause, so an enemy is a legal (if odd) target.
    //
    // Repeating this STACKS: +2 Might twice is +4, because `mightThisTurn`
    // accumulates. That is the opposite of what repeating Blood Rush does, and
    // the difference is 801.3.a.1 — a KEYWORD's duplicate instances are redundant when its own rule says so,
    // a numeric Might modifier is not a keyword and simply adds.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, FERAL_STRENGTH_MIGHT) : state,
  },
  "OGN-062": {
    // Reinforce — "Look at the top 5 cards of your Main Deck. You may banish a
    // unit from among them, then play it, reducing its cost by [5 Energy].
    // Recycle the remaining cards."
    //
    // Baited Hook's shape (a decision over the top five, banish-and-play, recycle
    // the rest) with one difference that is the whole card: the unit is played at
    // a REDUCED cost rather than a free one.
    //
    // **DIVERGENCE, and it is the honest one to record**: the reduction is applied
    // as a THRESHOLD rather than as a payment. Only units whose Energy cost is
    // 5 or less are offered, and those are played for nothing; a 6-Energy unit is
    // not offered at all, where the rules would let it be played for 1.
    //
    // Paying a real cost inside a resolution is the thing this engine cannot do:
    // `DecisionOption.payment` is a declared field with zero producers and zero
    // consumers, and every decision-time payment in the pool is Power through
    // `payPowerFromChanneled`, which needs no choice. Reinforce is the first card
    // that would need Energy chosen mid-resolution. Recorded in
    // docs/rules-conformance.md; the threshold reading is strictly narrower than
    // the card, never wider, which is the safe direction.
    //
    // The POWER half of an expensive unit's cost is likewise waived rather than
    // paid — "reducing its cost by 5 Energy" says nothing about Power, so a unit
    // with a Power pip is genuinely being under-charged. Both halves of the
    // divergence point the same way and are recorded together.
    targeting: { kind: "none" },
    // Nocturne's offer FIRST, then the look question: the queue is FIFO, so "as
    // you look at me" is answered before "which of these do you banish", which
    // is the order the two texts read in.
    resolve: (state, ctx) =>
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 5)), {
        kind: "OGN-062-banish",
        playerIndex: ctx.casterIndex,
      }),
  },
  "SFD-045": {
    // Not So Fast — "[Reaction] Counter an enemy spell or ability that chooses a
    // friendly unit or gear."
    //
    // Wind Wall with TWO filters, and unlike Defy's they are about the spell's
    // relation to the CASTER of this card rather than about its printed cost —
    // so they are answered by `counterFilter`, which both the enumerator and the
    // validator build from this very spec.
    //
    // Uncastable when nothing on the chain matches, rather than castable and
    // inert: for a Spell the targeting IS the effect, so "no legal target" means
    // "cannot cast" (355.8). That is the same reading Wind Wall's entry states
    // below, and here it is what makes the card a real answer rather than a
    // reliable one — a chain full of enemy spells that choose NOTHING leaves it
    // stranded in hand.
    //
    // **"or ABILITY" is a recorded divergence.** An activated ability resolves
    // INLINE in this engine rather than waiting on the chain, so there is no
    // ability item to name; see `counterableSpells` and
    // docs/rules-conformance.md. The spell half is whole.
    //
    // Shares the pool's known player-facing gap: with two matching spells
    // waiting, the UI takes the first candidate rather than asking which. That
    // is pre-existing and shared with Wind Wall, Defy, Mystic Reversal and
    // Riposte — this is simply the card the plan predicted would want it second.
    targeting: { kind: "chainSpell", enemyOnly: true, choosesFriendlyPermanent: true },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "OGN-064": {
    // Wind Wall — "[Reaction] Counter a spell."
    //
    // The clean driver for the whole counter spine: no filter, no condition, and
    // the only reason it works at all is `[Reaction]` timing, which lets it be
    // cast onto an already-closed chain. It resolves BEFORE its target because
    // the chain is LIFO (340.1) — the counter goes on top and pops first.
    //
    // Uncastable with an empty chain rather than castable-and-inert. For a Spell
    // the targeting IS the effect, so "no legal target" really does mean "cannot
    // cast" — the rule card-effects.ts's own spec comment states, applied here.
    targeting: { kind: "chainSpell" },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "OGN-045": {
    // Defy — "[Reaction] Counter a spell that costs no more than [4] and no more
    // than [rainbow]."
    //
    // Wind Wall with a printed-cost filter, and the numeral took the CARD IMAGE
    // to settle: the rainbow pip is absent from the JSON's rich text and from its
    // accessibility text, and the rules PDF quotes the card the same way. Energy
    // prints as a NUMBERED glyph and Power as COUNTED PIPS — Defy's own cost
    // proves the convention, printing a "1" Energy circle above exactly one Calm
    // pip — so one unnumbered rainbow pip is **1 Power of any domain**. Written up
    // in docs/rules-calls-resolved.md, including the wrong first answer.
    //
    // "Of any domain" is a COUNT of pips, not a domain match, which is why the
    // filter is a number rather than a domain — a 1-Power Fury spell and a 1-Power
    // Calm spell are equally legal targets.
    targeting: { kind: "chainSpell", maxPrintedEnergy: 4, maxPrintedPower: 1 },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "OGN-080": {
    // Mystic Reversal — "[Reaction] Gain control of a spell. You may make new
    // choices for it."
    //
    // The FIRST sentence is implemented and the second is not, which is the
    // larger half rather than the easier one: taking control moves who "you" is
    // for the whole resolution, so a spell that draws now draws for the thief,
    // its on-spell-cast listeners fire for the thief's Legend, and the thief gets
    // priority for the fresh round of passes on it (345).
    //
    // "You may make new choices for it" is the second sentence, and it is a
    // question asked WHILE a resolution is suspended: the targets were fixed when
    // the spell was announced, so re-making them means offering the NEW
    // controller the original spec's candidate list mid-chain. That is what
    // `OGN-080-retarget` does, rebuilt from the stolen spell's own
    // `TargetingSpec` so a re-choice can never be something the spell could not
    // have chosen in the first place.
    //
    // **Scoped, and the scope is stated rather than implied:** only a spec of
    // kind `unit` is re-offered. The other kinds either name no choice at all
    // (`none`), or carry choices with their own group constraints (`unitList`'s
    // `maxTotalMight`, `unitSlots`' second-at-destination, `chainSpell`'s cost
    // filter) that are enforced at announce time by machinery this question
    // cannot reach. Offering those without the constraints would let a stolen
    // Fox-Fire kill a set it was never allowed to choose, which is worse than not
    // offering them. Recorded Unverified in docs/rules-conformance.md.
    targeting: { kind: "chainSpell" },
    resolve: (state, ctx, event) => {
      if (!event.targetChainCardInstanceId) return state;
      const stolen = gainControlOfSpell(state, event.targetChainCardInstanceId, ctx.casterIndex);
      // Asked only when there is a choice to re-make: a spell with no `unit`
      // target, or one whose only legal target is the one it already names, is
      // not a question.
      return retargetCandidates(stolen, ctx.casterIndex, event.targetChainCardInstanceId).length > 0
        ? parkDecision(stolen, {
            kind: "OGN-080-retarget",
            playerIndex: ctx.casterIndex,
            cardInstanceId: event.targetChainCardInstanceId,
          })
        : stolen;
    },
  },
  "OGN-043": {
    // Charm — "Move an enemy unit."
    //
    // Names no battlefield, so the unit can be taken from the enemy's base as
    // well as from a battlefield (355.9.a.1 — the bare noun "unit" means objects on
    // the Board, and Bases are Public). Where it goes rides on
    // `destinationBattlefieldId`, the field a token-placing spell already uses.
    //
    // The move itself is `forceMoveToBattlefield`, not the MoveUnit executor, and
    // that is a rules distinction rather than plumbing — see its doc comment:
    // 414.3.a makes the exhaust a cost of the Standard MOVE ACTION, so a charmed
    // unit arrives ready, and 450 contests the destination for the moved unit's
    // controller rather than the caster's.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? forceMoveToDestination(state, event.targetUnitInstanceId, event, ctx.casterIndex) : state,
  },
  "OGN-053": {
    // Stand United — "[Hidden][Action] Buff a friendly unit. Buffs give an
    // additional +1 Might to friendly units this turn."
    //
    // The rules use THIS card as their worked example for rule 811's targeting
    // restriction: played from Hidden, the buff must choose a unit at that
    // battlefield, while the second half "affects all friendly units with buffs,
    // no matter where they are". So the restriction rides on the TARGET (handled
    // by legal-actions) and the board-wide half is written here with no location
    // check at all — which is what makes those two sentences behave differently.
    //
    // The second half is a modifier on what a Buff is WORTH, not a buff and not
    // a flat Might bonus: it scales with how many of your units are buffed, it
    // reaches units buffed later this turn, and it does nothing for an unbuffed
    // one. effectiveMight reads it; runEnd clears it.
    // **`scope: "anywhere"`, added 2026-08-23 by the sweep that followed
    // Rampage.** "Buff a friendly unit" names no location, and omitting the
    // scope is not neutral: `eligibleTargets` defaults to `"battlefield"`, so a
    // silent spec is NARROWER than a silent card. 355.9.a.1 widens a bare noun
    // to the Board and 198.1 puts the Bases on it, so a friendly unit standing
    // at home is a legal choice — and a natural one, since a buff on a unit in
    // base is exactly how it survives to attack later.
    //
    // This does NOT disturb the from-Hidden restriction the comment above
    // describes: 811.1.d.2 confines the choice to the hidden battlefield, and
    // that rides on `atHiddenBattlefield` in `legal-actions`, which is a
    // different filter applied on top of the scope.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const buffed = event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state;
      const players = [...buffed.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, extraMightPerBuffThisTurn: actor.extraMightPerBuffThisTurn + 1 };
      return { ...buffed, players };
    },
  },
  "OGN-058": {
    // Discipline — "[Reaction] Give a unit +2 Might this turn. Draw 1."
    //
    // scope: "anywhere", deliberately. The card says "a unit", NOT "a unit at a
    // battlefield", and rule 355.9.a.1 settles what the bare noun means: unit
    // refers to objects on the Board unless the text says otherwise, and the
    // targeting section's own list of Public zones names Bases right alongside
    // Battlefield Zones. So a unit standing at home is a legal target — and so
    // is the OPPONENT's, since the text carries no owner restriction either
    // (pumping an enemy unit is a bad play, not an illegal one, and `owner` is
    // left unset rather than guessing "friendly"). Same reading Final Spark and
    // Stupefy already got; base is not a safe parking spot from this card.
    //
    // giveMightThisTurn, NOT addBuff. The two are not interchangeable: this
    // expires in the Expiration Step ("all 'this turn' effects expire
    // simultaneously", rule 317), which turn-manager.ts's runEnd gets for free
    // by zeroing every unit's mightThisTurn, whereas a Buff (rule 705) is a
    // persistent game object that would survive the turn and only come off when
    // the unit leaves play (rule 705).
    //
    // [Reaction] is rule 813 and is NOT implemented here — engine/timing.ts owns
    // when this may be played, including onto an already-closed chain. The
    // resolver is identical whenever it runs, so there is nothing timing-shaped
    // for this entry to do.
    //
    // Printed order: Might first, then the draw. Drawing on an empty deck takes
    // nothing rather than throwing — drawCards' documented Burn Out gap, not a
    // decision made here.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      drawCards(giveMightThisTurn(state, event.targetUnitInstanceId!, 2), ctx.casterIndex, 1),
  },
  "OGN-071": {
    // Party Favors — "Each other player chooses Cards or Runes. For each player
    // that chooses Cards, you and that player each draw 1. For each player that
    // chooses Runes, you and that player each channel 1 rune exhausted."
    //
    // Written for multiplayer and collapsed honestly to two players: "each other
    // player" is exactly one opponent, so this is one question with one answer,
    // and both halves pay out to the caster AND the chooser. The card is a
    // Group Hug — the opponent picks which resource you BOTH get, so the choice
    // is real and genuinely theirs.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      parkDecision(state, {
        kind: "OGN-071-choose",
        // Answered by the OPPONENT, which is the whole point — this is the
        // second card in the pool (after Cull the Weak) to ask the non-caster
        // something on the caster's turn.
        playerIndex: ctx.casterIndex === 0 ? 1 : 0,
      }),
  },
  "OGN-057": {
    // Block — "[Hidden][Action] Give a unit [Shield 3] and [Tank] this turn."
    //
    // Two grants, one numbered and one not, which is exactly the pair
    // grantKeywordThisTurn's `value` argument exists for: [Shield 3] is +3 while
    // DEFENDING (effective-might reads it only for the defending side), and
    // [Tank] is "must be assigned combat damage first" (combat.ts owns that).
    // Both are handled by the keyword machinery, so this entry is only the
    // granting.
    //
    // Hidden and played in a Showdown, this is the card's whole point: a
    // defender that suddenly absorbs the damage AND takes it first.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const id = event.targetUnitInstanceId;
      if (!id) return state;
      return grantKeywordThisTurn(grantKeywordThisTurn(state, id, "Shield", 3), id, "Tank");
    },
  },
  "OGN-047": {
    // Find Your Center — "If an opponent's score is within 3 points of the
    // Victory Score, this costs 2 Energy less. Draw 1 and channel 1 rune
    // exhausted."
    //
    // Only the second sentence is here. The conditional discount is a COST and
    // therefore has to be known before the card is paid for, so it lives in
    // cost-modifiers.ts with the other cross-cutting reductions — the same split
    // Brazen Buccaneer's discount already takes.
    //
    // Exhausted, not Ready: the rune can pay Power this turn but no Energy until
    // the next Awaken, which is what makes "channel 1 exhausted" weaker than a
    // free rune.
    targeting: { kind: "none" },
    resolve: (state, ctx) => channelRunesExhausted(drawCards(state, ctx.casterIndex, 1), ctx.casterIndex, 1),
  },
  "OGN-050": {
    // Rune Prison — "[Action] Stun a unit."
    //
    // scope: "anywhere". "A unit", not "a unit at a battlefield" — rule 355.9.a.1
    // settles the bare noun as objects on the Board, and the targeting section
    // lists Bases among the Public zones. Same reading Discipline, Final Spark
    // and Stupefy already have. No owner restriction either: stunning your own
    // unit is a bad play, not an illegal one, so `owner` stays unset.
    //
    // [Action] is timing (engine/timing.ts), not something this entry does.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "OGN-069": {
    // Last Stand — "[Action] Double a friendly unit's Might this turn. Give it
    // [Temporary]."
    //
    // **EFFECTIVE Might, not printed**, and the card's own second sentence is
    // why: it hands you a unit that will die at your next Beginning Phase
    // (816), so the payoff has to be the unit's Might as it actually stands
    // when this resolves — buffs, this-turn pumps and continuous auras all
    // included. Reading `unit.might` would make Last Stand on a buffed,
    // aura-boosted attacker worth less than the board says it is worth. Same
    // reading, through the same `effectiveMight` choke point, that Gentlemen's
    // Duel takes for "damage equal to their Mights" and Stupefy takes for its
    // minimum-1 floor.
    //
    // **`[Assault]`/`[Shield]` DO count while the target holds a combat
    // designation — 432.1, and this card is its worked example.**
    //
    // The justification here used to read: those are "while I'm
    // attacking/defending" bonuses **(817)**, i.e. properties of a fight rather
    // than of the unit. Both halves are wrong. **817 is Vision.** Assault is
    // **807.1.c** and Shield is **814.1.c**, and each reads "It is functionally
    // short for 'While I am an attacker/defender, I have **+X [M]**'" — they ARE
    // Might while the designation holds. Fortified Position's own reminder text
    // says the same from the card side: "(+2 [M] while it's a defender)".
    //
    // **432.1's worked example works THIS CARD by name and gives the opposite
    // answer**: "A unit with 3 base Might and Shield 2 is in combat as a
    // Defender. Since Shield applies, its current Might is 5. A player chooses it
    // as the target for Last Stand… it gets +5 Might this turn, for a current
    // Might of 10. After combat, Shield no longer applies, but the +5 Might from
    // Last Stand does, so the unit's Might is 8."
    //
    // **FIXED 2026-08-23 — and the blocker was real but did not REACH this.**
    // The note here read: "left as-is for now rather than half-fixed;
    // `coverage.ts` records that the unbounded `effectiveMight` cycle is genuine
    // at `isCombat: true`". That cycle IS genuine — and it is about a
    // `mightModifiers` entry that itself calls `effectiveMight` and so re-enters
    // through its own registry. A plain resolver-side read terminates at depth 2,
    // because `isMighty` already passes `mightyCheck: true`, withholding exactly
    // the grants that could re-enter. Measured on Fiora - Victorious mid-combat:
    // it returns rather than recursing.
    //
    // Now reads `currentMightContext`, shared with the three other sites that had
    // copied the same wrong justification. Pinned by 432.1's own example, run on
    // UNL-099 Towering Combatant — its unit exactly, printed 3 Might with printed
    // [Shield 2].
    //
    // Stormbringer stays conformant BY CONSTRUCTION either way: its target is "a
    // friendly unit in your base", which can never hold a combat designation.
    //
    // Doubling is a SNAPSHOT: `+M this turn` on a unit currently at M. A later
    // buff therefore lands on top rather than being doubled too, which is what
    // "double ... this turn" means at resolution (317's this-turn effects are
    // fixed amounts, not live multipliers). Recomputing on read would need a
    // multiplier layer in effective-might that no other card wants.
    //
    // "A friendly unit" with no battlefield named, so scope "anywhere"
    // (355.9.a.1) — sacrificing a unit at home for one big turn is the play.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const id = event.targetUnitInstanceId;
      if (!id) return state;
      const location = findUnitAnywhere(state, id);
      if (!location) return state; // target left play between casting and resolution
      const doubled = giveMightThisTurn(state, id, effectiveMight(state, location.unit, location.ownerIndex, currentMightContext(state, location)));
      // Printed order: the Might first, then [Temporary]. Observable rather than
      // cosmetic — a 0-Might unit doubles to nothing and still becomes Temporary.
      return grantTemporary(doubled, id);
    },
  },
  "SFD-043": {
    // Emperor's Divide — "[Hidden][Action] Move any number of friendly units at
    // a battlefield to their base."
    //
    // "ANY NUMBER" is `min: 0`, which the unitList spec's own note settles: a
    // minimum of zero is what makes "up to" real, and it also makes the card
    // castable with nothing chosen — the same shape Fox-Fire has, and the same
    // reason (355 requires valid choices for all targets at announce, and zero
    // choices is a valid answer to "any number").
    //
    // "AT A BATTLEFIELD" is doing two jobs at once and both are load-bearing.
    // It is the default `scope`, so a unit sitting in base is not a legal choice
    // — this spell cannot move a unit that is already home. And it is `A`
    // battlefield, singular, so `sameBattlefield` groups the whole set at one
    // place; a divide that emptied two battlefields at once would be a different
    // (much better) card.
    //
    // `recallUnitToBase`, NOT `relocateToBaseUnchanged`, and the two are not
    // interchangeable: the card says MOVE, so the unit arrives exhausted and
    // Vilemaw's Lair's "units can't move from here to base" stops it. That is
    // rule 456's distinction — a Recall is not a Move — and Fight or Flight's
    // identical "move a unit from a battlefield to its base" already makes the
    // same call. Picking the other helper would silently make this better than
    // printed.
    //
    // [Hidden] and [Action] are timing (engine/timing.ts). Played from Hidden,
    // rule 811 restricts the choices to that battlefield's units, which
    // legal-actions enforces rather than this resolver.
    targeting: { kind: "unitList", min: 0, owner: "friendly", sameBattlefield: true },
    resolve: (state, _ctx, event) =>
      // Per chosen id, in the order chosen. A unit that has left play in the
      // meantime is skipped by the helper rather than throwing (055).
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => recallUnitToBase(next, id), state),
  },
  "UNL-038": {
    // Skyward Strike — "Move an enemy unit. [Level 6][>] [Stun] an enemy unit."
    //
    // # Two slots, and they are NOT interchangeable
    //
    // Slot 0 is the unit that MOVES; slot 1 is the one that gets STUNNED. Both
    // are "an enemy unit" with no location clause, so 355.9.a.1's bare noun puts
    // a unit in either base on both lists — and `scope: "anywhere"` says so.
    //
    // `asymmetricSlots` because (move A, stun B) and (move B, stun A) are
    // genuinely different plays. Without it the enumerator prunes one ordering as
    // a duplicate, which for two same-role slots is usually right and is wrong
    // here.
    //
    // **Nothing prints "another", and its two slots come from two SEPARATE
    // INSTRUCTIONS** — "Move an enemy unit" and "[Level 6] Stun an enemy unit" —
    // each choosing independently. So the same unit may fill both, and moving a
    // unit out of a fight and then stunning that same unit is a line the card
    // allows. `slotsMayCoincide` says so; fixed 2026-08-23.
    //
    // **It is the ONLY card in the pool that opts in**, and that was measured
    // rather than assumed: of the 11 same-role slot cards, 8 print a distinctness
    // word ("another", "other", "each other") and the other two — Switcheroo's
    // "swap the Might of two units" and Bonds of Strength's "give two friendly
    // units each +1" — are ONE instruction naming a group, where two members of a
    // group are two objects (355.11). Two instructions is the dividing line, not
    // the presence of the word.
    //
    // # `min: 1`, and the `[Level 6]` slot
    //
    // The stun exists only at `[Level 6]`, so the second slot is OPTIONAL —
    // `min: 1` — and `secondSlotLevel` gates whether it is OFFERED at all.
    //
    // **That gate was called impossible until 2026-08-23**, on the reasoning that
    // "a `TargetingSpec` is static — it cannot ask the board", so the resolver
    // gated it and a caster below 6 XP could name a stun target and watch it do
    // nothing. The spec OBJECT is static; the walk that reads it is not, and the
    // very loop that emits these pairs already asks the board twice
    // (`sameBattlefield`, `secondMightBelowFirst`). 355.8 declares targets at
    // finalization and 824.1.d makes the clause Inactive below the threshold, so
    // an Inactive clause offering a target was the divergence.
    //
    // **The resolver STILL checks, and that is not redundant.** This is a SPELL:
    // its clause resolves from the chain as part of its own text, so 727.1.c.1
    // (which put UNL-040 Wuju Apprentice's gate at trigger time and forbade
    // re-asking) does not reach it. 824.1.d applies whenever the clause is read,
    // so XP spent between finalization and resolution legitimately turns the stun
    // off. Two checks, two rules — and the two cards are the reason to write that
    // down rather than "unify them".
    targeting: {
      kind: "unitSlots",
      slots: ["enemy", "enemy"],
      min: 1,
      scope: "anywhere",
      asymmetricSlots: true,
      slotsMayCoincide: true,
      secondSlotLevel: SKYWARD_STRIKE_LEVEL,
    },
    resolve: (state, ctx, event) => {
      const moved = event.targetUnitInstanceId;
      const moveDone = moved ? forceMoveToDestination(state, moved, event, ctx.casterIndex) : state;
      // 824.1.b.1 — "[Level 6][>]" is "while you have 6 or more XP", read HERE
      // rather than when the spell was announced, which is where a resolving
      // instruction reads its conditions.
      const stunTarget = event.secondTargetUnitInstanceId;
      if (!stunTarget || !atLevel(moveDone, ctx.casterIndex, SKYWARD_STRIKE_LEVEL)) return moveDone;
      // Stunned AFTER the move, so a unit dragged somewhere and then stunned is
      // stunned wherever it now stands — `stunUnits` is positional only through
      // the id, so this is ordering rather than location, and the printed order
      // is move-then-stun.
      return stunUnits(moveDone, ctx.casterIndex, [stunTarget]);
    },
  },
  "UNL-031": {
    // Combat Experience — "[Reaction] Give a unit +1 Might this turn.
    // [Level 6][>] Give it +3 Might this turn instead."
    //
    // Discipline's spec exactly: "a unit", not "a unit at a battlefield", so
    // 355.9.a.1's bare noun puts a unit in either base on the target list, and no
    // owner clause means an enemy is a legal (if odd) choice.
    //
    // **"INSTEAD" is the whole of the second sentence's arithmetic.** The
    // levelled amount REPLACES the printed one, so a caster at 6 XP gives +3 and
    // not +4. Writing it as a second `giveMightThisTurn` would be the natural
    // shape and would be wrong by 1 — the same off-by-a-keyword the Herald of
    // Spring's own test pins from the other direction.
    //
    // The threshold is asked at RESOLUTION rather than when the card was
    // announced, which is what "while you have 6+ XP" means for an instruction:
    // 824.1.b.1 makes the clause a continuous condition on the card's text, so
    // the amount is whatever the condition says when the instruction executes.
    // Nothing here comes apart between the two moments anyway — XP is spent only
    // as a cost, which 820.1.c.1's timing pays at announce.
    //
    // giveMightThisTurn, NOT addBuff: this expires in the Expiration Step (317),
    // which is what "this turn" means, where a Buff (705) would survive the turn.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(
            state,
            event.targetUnitInstanceId,
            atLevel(state, ctx.casterIndex, COMBAT_EXPERIENCE_LEVEL)
              ? COMBAT_EXPERIENCE_LEVELLED_MIGHT
              : COMBAT_EXPERIENCE_MIGHT,
          )
        : state,
  },
  "UNL-032": {
    // Double Trouble — "[Repeat] [2] Look at the top 3 cards of your Main Deck.
    // You may reveal a unit from among them and draw it. Recycle the rest."
    //
    // Ornn - Blacksmith's ability with two words changed (three cards instead of
    // four, a UNIT instead of a gear), so it is written the same way and the
    // divergences it inherits are his — see `ornnLook` and `SFD-058-gear`.
    //
    // **The `[Repeat]` half is NOT reachable today, and that is not this entry's
    // doing.** `[Repeat]`'s cost table is `card-effects.REPEAT_COSTS`, and
    // UNL-032 is one of the six UNL cards named as unpriced by
    // test/repeat-keyword.test.ts — with no row there the enumerator never offers
    // the repeat variant, so `entry.repeatPaid` is never set and the second
    // execution never happens. This resolver is nonetheless repeat-SAFE by
    // construction: `card-effect-resolution` simply calls it twice, and the
    // second call re-slices the top 3 the first one left behind, which is what
    // 820.1.d's "execute the instructions one additional time" means for a look.
    // Two questions then queue FIFO and each rebuilds its own options from live
    // state, so the second look cannot offer a card the first one drew.
    //
    // **A REVEAL that this engine treats as a LOOK — a divergence inherited from
    // Ornn, stated rather than repeated silently.** `top-of-deck.revealedFromDeck`
    // is the funnel Undertitan's "as I'm revealed from your deck, [Add] [2]"
    // hangs off, and Undertitan is a UNIT, so unlike Ornn's gear-only version
    // this card really can reveal one. It is not called: `offerTopOfDeckBanish`
    // has already asked Nocturne's "as you look at me" for all three, and
    // `revealedFromDeck` asks it AGAIN for whatever is chosen — so wiring the
    // reveal here would double-offer Nocturne's banish on the one card that is
    // both looked at and revealed. That is the per-item double-pay shape this
    // codebase keeps recording, and closing it properly means the reveal funnel
    // learning that a card already looked at is not looked at twice.
    targeting: { kind: "none" },
    resolve: (state, ctx) => doubleTroubleLook(state, ctx.casterIndex),
  },
  "UNL-042": {
    // Back Off — "[Hidden][Action] Stun a unit. If you played this from your
    // hand, draw 1."
    //
    // **ONLY the first sentence is implemented.** The second is refused rather
    // than guessed, and the reason is structural: nothing a resolver can see
    // records where the card was played FROM. `PlayCardAction` carries
    // `fromHiddenBattlefieldId`, `execute-play-card` reads it to build the
    // `cardPlayed` event's `fromHidden` flag — and neither `SpellChainEntry` nor
    // `ResolveEvent` carries it, so by the time this runs the card is in the
    // trash and the hidden zone it may have come from has already been emptied.
    // The primitive is one field on each of those two types plus one line in
    // `choicesOf`; all three are shared files. Pinned by a test that asserts the
    // draw does NOT happen, so closing the gap fails loudly.
    //
    // Rune Prison's spec: "a unit", not "a unit at a battlefield" (355.9.a.1), and
    // no owner clause — stunning your own is a bad play, not an illegal one.
    //
    // [Hidden] and [Action] are timing (engine/timing.ts). The irony of the
    // missing half is the card's own: played from Hidden it is the cheap answer
    // and draws nothing, played from hand at full price it replaces itself.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "UNL-044": {
    // Flurry of Feathers — "[Reaction] Choose one — Counter a spell. [or] Play
    // four 1 Might Bird unit tokens with [Deflect]."
    //
    // MODAL, because "choose one" between two instructions that target
    // differently is exactly what `modes` is for (card-effects.ts's `CardMode`) —
    // one wants a spell on the chain, the other wants nothing at all. A single
    // spec cannot describe both, and folding them would make the card uncastable
    // with an empty chain.
    //
    // **The empty chain is the reason the split matters in play.** The enumerator
    // flat-maps modes and keeps only the variants each produces, so with nothing
    // to counter the first mode simply vanishes and the Birds are still on offer.
    // That is what makes this a 4-Energy card you are never stuck holding, which
    // Wind Wall (uncastable on an empty chain, and correctly so) is not.
    modes: [
      {
        id: "counter",
        label: "Counter a spell",
        // Wind Wall's spec exactly: no filter, no owner clause, and the
        // `[Reaction]` timing that lets it be cast onto an already-closed chain
        // is engine/timing.ts's rather than anything here. LIFO (340.1) is what
        // makes it resolve before its target.
        targeting: { kind: "chainSpell" },
        resolve: (state, _ctx, event) =>
          event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
      },
      {
        id: "birds",
        label: "Play four 1 Might Bird unit tokens with [Deflect]",
        targeting: { kind: "none" },
        // Four SEPARATE `placeToken` calls rather than one call with a count,
        // because each token is a unit becoming present in its own right: 190.3.a
        // applies Contested per arrival, and `placeToken` is where that happens.
        //
        // **They all land in the SAME place**, which is Recruit the Vanguard's
        // reading of an unsplit "play four ... tokens" (see
        // `TOKEN_PLACEMENT_SPELL_DEF_IDS`' note on Arise!) — the card prints no
        // per-token parenthetical, so there is one destination for the play.
        //
        // **DIVERGENCE, and it is narrow rather than wide**: that destination is
        // always the caster's BASE today. 813.3.a gives the choice the card should
        // have — "[a unit] can only be played to the controlling player's base or
        // a battlefield they control", which is exactly the fan-out Recruit the
        // Vanguard and Sprite Call get from `cardPlacesTokens`. This defId is not
        // in that table (`card-effects.TOKEN_PLACEMENT_SPELL_DEF_IDS`, a shared
        // file this change does not own), so the enumerator never offers a
        // battlefield and `destinationBattlefieldId` is always undefined.
        //
        // It is read here anyway, exactly as Desert's Call reads it — SFD-031 has
        // the SAME unlisted gap — so the day the row lands this resolver needs no
        // change. Four blockers in base is strictly weaker than four at a
        // contested battlefield, which is the safe direction.
        resolve: (state, ctx, event) => {
          const destination = event.destinationBattlefieldId !== undefined
            ? { battlefieldId: event.destinationBattlefieldId }
            : ("base" as const);
          let next = state;
          for (let i = 0; i < FLURRY_OF_FEATHERS_BIRDS; i += 1) {
            next = placeToken(next, ctx.casterIndex, destination, BIRD_TOKEN);
          }
          return next;
        },
      },
    ],
  },
  "UNL-046": {
    // Friendship — "[Reaction] Choose a unit. Give it +1 Might this turn for each
    // of the following tags among your units — Bird, Cat, Dog, and Poro."
    //
    // Discipline's spec: "a unit", not "a unit at a battlefield", so 355.9.a.1's
    // bare noun ("'Unit,' 'gear,' and 'rune' refer to objects on the Board unless
    // specified otherwise") puts a unit in either base on the target list, and no
    // owner clause means an enemy is a legal (if odd) choice.
    //
    // **The amount is a count of TAGS, not of units** — see `FRIENDSHIP_TAGS`. So
    // it is 0..4 and never more, however wide the board.
    //
    // "AMONG YOUR UNITS" is the CASTER's units wherever they stand
    // (`ownUnitsEverywhere`): the card names no location, and the chosen unit is
    // not required to be one of them — pumping an enemy by your own Poro count is
    // legal and pointless, which is the shape a missing owner clause always has.
    //
    // **The chosen unit counts itself when it is yours.** Nothing here excludes
    // it: "each of the following tags among your units" is a board-wide count and
    // "choose a unit" is a separate sentence, so a lone Poro Friendshipped is +1.
    //
    // giveMightThisTurn, NOT addBuff: this expires in the Expiration Step (317),
    // where a Buff (702) is a counter that survives the turn.
    //
    // Zero is a legal amount and the card is still castable at it — the targeting
    // is satisfied by a unit existing, and 359.3.e.11's do-as-much-as-you-can
    // gives +0 rather than refusing.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, friendshipTagCount(state, ctx.casterIndex))
        : state,
  },
  "UNL-054": {
    // Tricksy Tentacles — "Move any number of enemy units with the same
    // controller and a total Might of 8 or less to a single location."
    //
    // The pool's FIRST card that both targets a LIST and names a destination, and
    // the only new thing about it is that pairing: the group half is Fox-Fire's
    // spec and the move half is Charm's helper.
    //
    // # "With the same controller" is `owner: "enemy"`, and that is a two-player
    //   fact rather than a reading of the card
    //
    // The clause exists because a multiplayer game has more than one opponent; in
    // the two-player game this engine models (`state.players` is a fixed pair)
    // every enemy unit shares one controller, so the restriction is satisfied by
    // construction and needs no group predicate. Stated rather than left implicit
    // because it is the kind of silent assumption that becomes wrong the day a
    // format changes — if a third seat ever exists this needs a `sameController`
    // group requirement beside `maxTotalMight`.
    //
    // # `scope: "anywhere"` and `min: 0`
    //
    // "Enemy units", a bare plural with no "at a battlefield", so 355.9.a.1's
    // widening applies and a unit sitting in the opponent's base is a legal
    // choice. "Any number" is `min: 0` — Emperor's Divide's note, and the same
    // consequence: the spell is castable with nothing chosen.
    //
    // `maxTotalMight` is a GROUP requirement checked when the card is finalized
    // and read as EFFECTIVE Might, which is what the spec's own note requires and
    // what the PDF's Fox-Fire example turns on.
    //
    // # The destination is ONE choice for the whole group, and that is printed
    //
    // 355.4 asks for "a valid Location as the Move Destination for each Move that
    // will be performed". This card prints "a SINGLE location", so one destination
    // field IS the whole answer rather than a simplification of it — the exact
    // point on which it differs from a card that moves two units independently.
    //
    // `forceMoveToDestination` per chosen id, in the order chosen, so the base and
    // battlefield halves cannot drift apart here the way seven hand-rolled
    // branches did before that dispatcher existed. **The BASE half is written even
    // though nothing offers it yet** (`withDestinations`' `toBase` is gated on an
    // index derived from the singular `targetUnitInstanceId`, which a `unitList`
    // play never sets — a `legal-actions` change this file does not own). Writing
    // it costs nothing and is CORRECT when it arrives: `forceMoveToBase` sends a
    // unit to its own controller's base (107.1.c), and every target here shares a
    // controller, so "their base" is a single location exactly as printed. The
    // project-owner ruling of 2026-08-13 says that location is a legal choice.
    //
    // A unit already standing at the destination is skipped by both helpers, so a
    // group with mixed origins moves only the ones that have somewhere to go —
    // and that is the RULED behaviour rather than a shortcut. The question ("is a
    // set containing a unit already at the destination an illegal choice, or a
    // partial no-op?") is the row docs/rules-conformance.md already carries against
    // this card: **partial no-op**, project-owner ruling, on the reading that
    // 355.4.a is a per-unit check on whether a given unit may make a given move
    // rather than a rule about whether the Location is a usable choice. The
    // enumerator agrees by construction — it has no single target to ask "where are
    // you" about — so offering a destination the whole group already occupies is
    // deliberate, not a gap. That row's "not yet implemented" note is now stale.
    //
    // A unit that left play between announce and resolution is skipped by the
    // helper rather than throwing (359.3.e.12).
    targeting: { kind: "unitList", min: 0, owner: "enemy", scope: "anywhere", maxTotalMight: 8 },
    resolve: (state, ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce(
        (next, id) => forceMoveToDestination(next, id, event, ctx.casterIndex),
        state,
      ),
  },
};

/** Friendship's multiplier — how many of Bird/Cat/Dog/Poro appear among
 *  `playerIndex`'s units, anywhere on the Board. One function so the count and
 *  the card cannot disagree about what "tags among your units" means. */
function friendshipTagCount(state: GameState, playerIndex: 0 | 1): number {
  const mine = ownUnitsEverywhere(state, playerIndex);
  return FRIENDSHIP_TAGS.filter((tag) => mine.some((u) => (u.tags ?? []).includes(tag))).length;
}

/**
 * Double Trouble's look, written beside `ornnLook` because it IS `ornnLook` with
 * a different count and a different card kind.
 *
 * Nocturne's offer is parked FIRST for the FIFO reason that function records:
 * "as you look at me from the top of your deck" is answered before "which of
 * these do you take", which is the order the two texts read in.
 *
 * An empty deck asks nothing at all rather than parking a question whose only
 * answer is "decline" (422).
 */
function doubleTroubleLook(state: GameState, playerIndex: 0 | 1): GameState {
  const looked = state.players[playerIndex].deck.slice(0, DOUBLE_TROUBLE_LOOK);
  if (looked.length === 0) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, looked), { kind: "UNL-032-unit", playerIndex });
}

/**
 * Ivern - Nurturer's look, shared by his on-play and his on-hold trigger — the
 * third card in this file to be `ornnLook` with the numbers changed, so it is
 * written the same way and inherits the same two readings.
 *
 * The REVEAL is treated as a LOOK, exactly as Double Trouble's is: `offerTopOfDeckBanish`
 * has already asked Nocturne's "as you look at me" for all three cards, and calling
 * `top-of-deck.revealedFromDeck` for the one that is then revealed would offer that
 * banish a second time on the same card. That is the per-item double-pay shape this
 * codebase keeps recording, and Ivern is the second card to hit it — see UNL-032's
 * entry, where the divergence is stated in full.
 *
 * An empty deck asks nothing at all (422): with nothing to look at there is nothing
 * to reveal, and therefore — "THEN if you revealed" — nothing to buff either.
 */
function ivernLook(state: GameState, playerIndex: 0 | 1): GameState {
  const looked = state.players[playerIndex].deck.slice(0, IVERN_LOOK);
  if (looked.length === 0) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, looked), { kind: "UNL-051-reveal", playerIndex });
}

/** The `MightContext` for a unit `findUnitAnywhere` just located — the
 *  base-vs-battlefield branch three callers in this repo already write out by
 *  hand (Stupefy, En Garde, Gentlemen's Duel). Positional auras
 *  (Garen - Commander) resolve "base" from the omitted field. */
// `mightContext` lived here and hardcoded `isCombat: false`. It is now
// `target-lookup.currentMightContext`, shared with effects/mind.ts's identical
// twin and combat-aware per 432.1 — see its doc for the rule and for why the
// recursion this was refused on does not reach a resolver-side read.

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "VEN-026": {
    // Field Musicians — "When you play me, give a unit +3 [Might] this turn."
    //
    // "A unit", bare, so either side's and anywhere (355.9.a.1). Pumping an enemy
    // is a bad play rather than an illegal one, and the card offers it.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, FIELD_MUSICIANS_MIGHT)
        : state,
  },
  [TOMB_RAIDER_BARBARA]: {
    // Tomb-Raider Barbara — "When you play me, if you control 7 or more runes,
    // choose an enemy gear. If it's [Empowered], disempower it. Otherwise, kill
    // it."
    //
    // # The branch is the card, and it is the WRONG way round from instinct
    //
    // Empowered gear is HARDER to remove, not easier: the Empowered one survives
    // and is merely stripped, while the ordinary one dies. That reading follows
    // the printed order and is what makes Empowering your own gear a defence.
    //
    // "7 OR MORE RUNES" is `channeled.length` — the Rune Pool, the same count
    // Renekton, Eclipse Dragon and the Hierophant read. Checked at RESOLUTION
    // rather than on the offer: it is the ability's printed condition (402.1),
    // and the target is chosen whether or not it is met — the trade Masa's and
    // Blast Corps Cadet's entries already record.
    //
    // Her own printed `[Empowered]` keyword is unrelated to the branch and needs
    // nothing here.
    targeting: { kind: "gear", owner: "enemy" },
    resolve: (state, ctx, _unitId, event) => {
      const id = event.targetPermanentInstanceId;
      if (!id) return state;
      if (state.players[ctx.casterIndex].channeled.length < TOMB_RAIDER_BARBARA_RUNES) return state;
      if (isEmpowered(state, id)) return disempowerPermanent(state, id);
      const enemyIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      const gear = state.players[enemyIndex].activeGear.find((g) => g.instanceId === id);
      return gear ? killGear(state, gear, enemyIndex) : state;
    },
  },
  "SFD-044": {
    // Legion Quartermaster — "As an additional cost to play me, return a
    // friendly gear to its owner's hand."
    //
    // **MANDATORY, and that is the whole shape of the card.** There is no "you
    // may", so the enumerator offers no decline variant and a Quartermaster with
    // no gear of your own is simply unplayable — the same consequence Cruel
    // Patron's kill has, and the reason `mandatory` is a flag on the cost rather
    // than a per-card branch.
    //
    // He has no other text: the return IS the whole entry, and it is a COST
    // rather than an effect, which is why `targeting` is "none" and the gear
    // rides `additionalCostPermanentInstanceId` (355.10.c — a cost is not a
    // target).
    //
    // "To its OWNER's hand" — and the cost is a FRIENDLY gear, so the owner is
    // the caster. `returnPermanentToHand` locates it either way rather than
    // assuming, which keeps this right if control of a gear ever moves.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostPermanentInstanceId
        ? returnPermanentToHand(state, event.additionalCostPermanentInstanceId)
        : state,
  },
  "OGN-044": {
    // Clockwork Keeper — "You may pay [1 Calm] as an additional cost to play me.
    // When you play me, if you paid the additional cost, draw 1."
    //
    // The pool's first OPTIONAL POWER additional cost, and it is the whole card:
    // a 2-Energy body, or a 2-Energy body and a card. The cost itself lives in
    // the cost pipeline (`OPTIONAL_POWER_COSTS`, enumerated as a second variant
    // and re-derived by the validator); all that is here is the payoff.
    //
    // Gated on the cost having been PAID, not on the card merely having the
    // option — the same reading Tasty Faefolk's `acceleratePaid` takes, and read
    // from the action for the same reason: by the time this runs, nothing about
    // the board records how the Keeper was paid for.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => (event.optionalPowerPaid ? drawCards(state, ctx.casterIndex, 1) : state),
  },
  "OGN-075": {
    // Tasty Faefolk — "[Accelerate] — Channel 2 runes exhausted and draw 1."
    //
    // Gated on the ACCELERATE COST HAVING BEEN PAID, not on the card merely
    // having the keyword: 805 makes Accelerate a "you may pay" additional cost,
    // so a Faefolk played the cheap way enters exhausted and does nothing. The
    // flag rides on the action (`acceleratePaid`) because the choice is made
    // when the card is paid for, long before this resolver runs.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      event.acceleratePaid ? drawCards(channelRunesExhausted(state, ctx.casterIndex, 2), ctx.casterIndex, 1) : state,
  },
  "OGN-082": {
    // Whiteflame Protector — "When you play me, give a unit +8 Might this turn."
    //
    // Eight is enormous and the card names no owner and no battlefield, so scope
    // "anywhere" and either side is targetable. giveMightThisTurn, not a Buff:
    // it expires in the Expiration Step (317).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 8) : state,
  },
  "OGN-061": {
    // Poro Herder — "When you play me, if you control a Poro, buff me and
    // draw 1."
    //
    // "A PORO" is a tag, not a name: four cards carry it (Pouty Poro, Stalwart
    // Poro, Mystic Poro, Daring Poro), and the Herder himself is Freljord rather
    // than Poro — so he does not satisfy his own condition, which is the point
    // of the card.
    //
    // Checked across base and battlefields, since "control" is not positional.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => {
      const hasPoro = ownUnitsEverywhere(state, ctx.casterIndex).some((u) => (u.tags ?? []).includes("Poro"));
      return hasPoro ? drawCards(addBuff(state, unitId), ctx.casterIndex, 1) : state;
    },
  },
  "OGN-067": {
    // Blitzcrank - Impassive — "[Tank] When you play me to a battlefield, you may
    // move an enemy unit to here. When I hold, return me to my owner's hand."
    //
    // This clause is the middle one; `[Tank]` is the keyword engine's and the
    // hold is a `battlefieldHeld` listener below.
    //
    // **"To a battlefield"** — played to base, nothing happens at all. That is
    // why this reads `event.destination` rather than looking Blitzcrank up: it is
    // the one fact about the play that the board does not record.
    //
    // **"You MAY"**, so it parks a question rather than taking a target. A target
    // on the action would have made the grab compulsory whenever any enemy unit
    // existed, and the card is frequently better declined — dragging a body onto
    // your own battlefield is how you lose the hold this card's third clause is
    // built around.
    //
    // Nothing is asked when there is no enemy unit anywhere: 422's do-as-much-as-
    // you-can, and the same shape Adaptatron's gear check uses.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) => {
      if (event.destination === "base") return state;
      const enemyIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      if (ownUnitsEverywhere(state, enemyIndex).length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-067-grab",
        playerIndex: ctx.casterIndex,
        // Blitzcrank's own battlefield, carried as the destination "here" means.
        // Taken from the play rather than re-derived at answer time, which is the
        // same reason the decision carries it at all — a question answered later
        // must not be able to drag a unit somewhere Blitzcrank never was.
        battlefieldId: event.destination.battlefieldId,
        cardInstanceId: unitId,
      });
    },
  },
  "OGN-051": {
    // Solari Shieldbearer — "When you play me, stun a unit."
    //
    // Same "a unit" reading as Rune Prison above, and for the same reason: the
    // text names no battlefield, so a unit in either base is a legal target.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "SFD-032": {
    // Disarming Rake — "When you play me, you may kill a gear."
    //
    // Adaptatron's question without its "if you do" payoff, and it takes the
    // same two readings for the same reasons. "A GEAR" names no owner, so your
    // own is on offer too — this pool's gear includes Treasure Trove and
    // Scrapheap, which pay out when they die, so killing your own is a real play
    // rather than a mis-click waiting to happen. And it is routed through
    // `killGear` so those self-triggers actually fire.
    //
    // "You MAY", so it parks a question rather than taking a target: a target on
    // the action would make the kill compulsory whenever any gear existed.
    //
    // Nothing is asked with no gear anywhere — 055's do-as-much-as-you-can, and
    // a question with no answers must not be parked.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      state.players[0].activeGear.length + state.players[1].activeGear.length === 0
        ? state
        : parkDecision(state, { kind: "SFD-032-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-039": {
    // Royal Entourage — "When you play me, ready or exhaust a legend."
    //
    // The first card in the pool that touches a LEGEND's ready state from
    // outside the legend's own ability, and both halves are worth something:
    // readying your own buys a second use of its once-per-turn ability this
    // turn, and exhausting the opponent's denies theirs.
    //
    // "A LEGEND" carries no owner, so either seat's is a legal choice, and the
    // rules settle it with this card's own wording: 355.9.a's bare-noun list says
    // "'Legend' refers to a legend in the Legend Zone", and 355.10.b's worked
    // example is literally *"Ready a legend" targets a legend, because the Legend
    // Zone is Public* — with Legend Zones (plural) named among the Public zones.
    // No owner restriction anywhere, so exhausting theirs is as legal as readying
    // yours.
    //
    // **A DECISION rather than an announce-time target, and that is a divergence
    // worth naming.** Because it targets, 355 would have the legend chosen when
    // the Entourage is announced. There is no `legend` kind in TargetingSpec and
    // adding one is a card-effects.ts change; the same shape Adaptatron's "kill a
    // gear" and Blitzcrank's "move an enemy unit" already take, for the reason
    // decisions.ts records. Observable only through a Reaction cast in the window
    // between the play and the trigger resolving.
    //
    // MANDATORY: there is no "you may". Every board offers exactly two answers
    // (each legend is either ready or exhausted, so each contributes the one
    // change that would do something), which is also what stops
    // `advanceDecisions` answering it on the player's behalf.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-039-legend", playerIndex: ctx.casterIndex }),
  },
  "SFD-053": {
    // Janna - Savior — "[Reaction] When you play me, heal your units here, then
    // move up to one enemy unit from here to its base."
    //
    // "HERE" is where she landed, so this reads `event.destination` rather than
    // looking her up — the same field, and the same reason, as Blitzcrank -
    // Impassive's "to here". Her [Reaction] timing (813, and the printed
    // permission to play her to a battlefield you control) is engine/timing.ts's;
    // nothing about it changes what this resolver does.
    //
    // Played to BASE she still heals — "your units here" is a real instruction
    // wherever she is, and **107.1.b** makes a Base a place like any other
    // ("Each Base is a Location") — but the second half asks nothing, because no
    // enemy unit can be standing in your base for her to move out of it.
    //
    // Cited 107.1.b, not the 355.9.b this once said. That claim is about what
    // "here" resolves to, which is a LOCATION question and not a targeting one —
    // so neither half of 355.9 was ever the right rule for it.
    //
    // "HEAL", not "heal all units": only the caster's, and only at her location.
    // `healAllUnits` is the wrong helper twice over (it clears both players,
    // everywhere), so the clearing is written out here.
    //
    // "UP TO ONE", so declining is a real answer and leads the list. Moving an
    // enemy home un-contests the battlefield she just arrived at, which is
    // usually the point of casting her mid-showdown — but not always, since it
    // also hands that unit back ready to defend elsewhere.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      const battlefieldId = event.destination === "base" ? undefined : event.destination.battlefieldId;
      const healed = healOwnUnitsAt(state, ctx.casterIndex, battlefieldId);
      if (battlefieldId === undefined) return healed;
      const enemyIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      const bf = healed.battlefields.find((b) => b.id === battlefieldId);
      // 422 again: with no enemy unit here there is nothing to move, so nothing
      // is asked.
      if ((bf?.units[healed.players[enemyIndex].id] ?? []).length === 0) return healed;
      return parkDecision(healed, { kind: "SFD-053-move", playerIndex: ctx.casterIndex, battlefieldId });
    },
  },
  "UNL-034": {
    // Herald of Spring — "[Hunt] (When I conquer or hold, gain 1 XP.) When you
    // play me, gain 2 XP."
    //
    // ONLY the second sentence is here. `[Hunt]` is a keyword, and triggers.ts
    // registers it ONCE for the whole pool under `HUNT_TRIGGER_KEY` rather than
    // per card — so re-implementing it here would pay the Herald's conquer/hold
    // XP twice, which is precisely the double-pay shape this codebase warns
    // about for per-item events. The parenthetical is reminder text.
    //
    // "Gain 2 XP", not "[Hunt 2]": the two numbers are unrelated. Hunt pays on a
    // conquer or a hold, this pays on the PLAY, and a Herald that is countered
    // or that never reaches a battlefield still collects these 2.
    //
    // Through `gainXp` rather than `xp + 2` inline — the one choke point that
    // helper's own note exists to defend, and the reason 35 XP-gaining cards do
    // not each have to learn about a future "opponents can't gain XP".
    //
    // `ctx.casterIndex`, so an opponent who somehow plays him gains the XP: "you"
    // in a triggered ability is the ability's controller, and every other on-play
    // trigger in this file measures from the same seat.
    targeting: { kind: "none" },
    resolve: (state, ctx) => gainXp(state, ctx.casterIndex, HERALD_OF_SPRING_XP),
  },
  "UNL-033": {
    // Frisky Hunter — "[Deflect] When you play me, play a 1 Might Bird unit token
    // with [Deflect] here."
    //
    // Only the sentence is here; his own `[Deflect]` is the keyword machinery's
    // (`granted-keywords.deflectSurcharge`), and re-granting it would be the
    // double-pay shape 809.2's summing makes observable — a printed `[Deflect 1]`
    // re-granted is `[Deflect 2]`, i.e. twice the tax the card prints.
    //
    // **"HERE" is where he landed**, so this reads `event.destination` rather
    // than looking him up — the same field, and the same reason, as Blitzcrank -
    // Impassive's "to here" and Janna - Savior's "your units here". Played to
    // BASE the token lands in base: a Base is a Location like any other
    // (**107.1.b**, "Each Base is a Location" — this once also cited 355.9.b,
    // which is a targeting rule and says nothing about what "here" means), so
    // "here" is a real answer there too rather than
    // a case the card declines to work in. That is deliberately NOT Blitzcrank's
    // "when you play me TO A BATTLEFIELD", which prints the restriction this card
    // does not.
    //
    // `placeToken`, not a hand-rolled push, because a token becoming present at a
    // battlefield its controller does not control applies Contested (190.3.a) and
    // can promote a Non-Combat Showdown to a Combat one — walking a 4-Energy body
    // into a contested battlefield and adding a second blocker is the play, and
    // it has to open the fight the rules say it opens.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeToken(state, ctx.casterIndex, event.destination, BIRD_TOKEN),
  },
  "UNL-040": {
    // Wuju Apprentice — "[Hunt] (When I conquer or hold, gain 1 XP.)
    // [Level 6][>] When you play me, draw 1."
    //
    // ONLY the second clause. `[Hunt]` is registered ONCE for the whole pool
    // under `triggers.HUNT_TRIGGER_KEY`, keyed off the keyword rather than the
    // card, so re-implementing it here would pay his conquer/hold XP twice —
    // the same reasoning Herald of Spring's entry above sets out at length.
    //
    // **The `[Level 6]` gate is asked at TRIGGER time, as of 2026-08-23.**
    // 727.1.c.1: "Triggered Abilities of Dependent Keywords must be Active for
    // their trigger to be EVALUATED" — so the question belongs at the moment the
    // play triggers, before the ability becomes a Chain Pending Item, and once it
    // is on the Chain it is independent of what made it (383.3 with 377.3.a.1)
    // and is not re-asked.
    //
    // It was checked in `resolve` until now, and that was wrong in BOTH
    // directions across the response window his own play opens: XP crossing 6
    // during it wrongly switched the draw ON, and XP spent during it wrongly
    // switched an already-triggered draw OFF. It also held a Pending Item that
    // resolved to nothing, which costs both players a PassFocus for an ability
    // that never triggered.
    //
    // The divergence note that recorded this named exactly one missing field — an
    // `applies` hook on `UnitTriggerDefinition`, which its three siblings already
    // had — and was right. This is the only card in the pool that needs it: of
    // the ten `atLevel` sites, four are continuous Might modifiers read live, two
    // are spells resolving from the chain, one is an activated ability that
    // resolves inline, and this is the only one in `unitTriggers`.
    //
    // `ctx.casterIndex` for the draw and `casterIndex` for the threshold —
    // 824.1.c makes the condition the CONTROLLER's XP, and "draw 1" is his too.
    targeting: { kind: "none" },
    applies: (state, casterIndex) => atLevel(state, casterIndex, WUJU_APPRENTICE_LEVEL),
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "SFD-058": {
    // Ornn - Blacksmith's FIRST moment — "When you play me or when I hold, look
    // at the top 4 cards of your Main Deck. You may reveal a gear from among them
    // and draw it. Then recycle the rest."
    //
    // One ability with two triggers, so the body lives in `ornnLook` below and
    // the on-hold half registers separately in `eventTriggers`. Splitting the
    // text between the two entries instead would have let them drift.
    targeting: { kind: "none" },
    resolve: (state, ctx) => ornnLook(state, ctx.casterIndex),
  },
  "UNL-051": {
    // Ivern - Nurturer's FIRST moment — "When you play me or when I hold, look at
    // the top 3 cards of your Main Deck. You may reveal a unit from among them and
    // draw it. Recycle the rest. Then if you revealed a Bird, Cat, Dog, or Poro,
    // do this: [Buff] a friendly unit."
    //
    // Ornn - Blacksmith's two-moment shape exactly: the body lives in `ivernLook`
    // and the on-hold half registers separately in `eventTriggers`, so the two
    // entries cannot drift apart. What Ornn does not have is the SECOND sentence,
    // and it is a "then" rather than a second instruction — the buff happens only
    // on the branch where a tagged unit was actually revealed, which is why it is
    // parked from inside the reveal answer rather than queued beside it.
    targeting: { kind: "none" },
    resolve: (state, ctx) => ivernLook(state, ctx.casterIndex),
  },
  "UNL-052": {
    // Nami - Headstrong's SECOND sentence — "When you play me, if you paid the
    // additional cost, [Stun] an enemy unit."
    //
    // # The additional cost itself is NOT implemented, and this clause is inert
    //
    // "You may pay [Calm] as an additional cost to play me" is one row in
    // `card-effects.OPTIONAL_POWER_COSTS` — `"UNL-052": { domain: "Calm", count: 1 }`
    // — and that is a shared file this pass does not own. Without the row the
    // enumerator never offers the paid variant, `optionalPowerPaid` is never true,
    // and this stun never fires in a real game. Written anyway rather than left
    // out, because the flag it reads is a real threaded mechanism (validator,
    // executor and `UnitTriggerEvent` all carry it, for Clockwork Keeper and the
    // three SFD cards) and a card whose cost lands with no effect behind it is the
    // worse failure. Pinned by a test that asserts the stun does NOT happen off an
    // ordinary play, so adding the row fails loudly rather than silently.
    //
    // **The domain has to come from the table and not from the card**, which is
    // this card repeating Clockwork Keeper's exact trap: Nami prints ZERO Power,
    // so her `powerDomain` is null and pricing against it would accept a rune of
    // any domain.
    //
    // "The target is chosen whether or not the cost was paid" — Blast Corps
    // Cadet's and Frostcoat Cub's note, and the same consequence: a Nami played
    // cheap names an enemy and does nothing to it. `[Stun]` is 423's action, so it
    // goes through `stunUnits`, which drops an already-stunned unit before the
    // event exists.
    //
    // "An ENEMY unit", a bare noun with no "at a battlefield", so 355.9.a.1's
    // widening applies and a unit in the opponent's base is a legal choice.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.optionalPowerPaid && event.targetUnitInstanceId
        ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId])
        : state,
  },
  "UNL-053": {
    // Scuttle Crab — "When you play me, draw 1." Its `[Deathknell]` is the other
    // half and lives in `deathTriggers` below.
    //
    // The parenthetical "(Units with 0 Might can conquer and hold)" is reminder
    // text for a rule this engine already follows — `scoring.isHeldBy` reads
    // presence, never Might — so there is nothing to write for it.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  // # Two Calm units REFUSED, both on "I enter ready", and both deliberately
  //
  // Named here rather than left silent, because a refusal nothing records is
  // indistinguishable from a card nobody looked at — and because writing either
  // one as an on-play trigger would register the defId, report DONE and be wrong
  // in three observable ways that `deploy.unitEntersReady`'s own comment lists:
  // the unit would sit EXHAUSTED through the whole response window, it would fire
  // `unitReadied` for a readying the rules say never happened, and Mageseeker
  // Warden could block it. "I enter ready" is a REPLACEMENT, not a readying.
  //
  // **UNL-035 Monch** — "If an opponent controls a stunned unit, I cost [2] less
  // and enter ready." Two clauses, two shared files, neither of them this one:
  // the discount is a `engine/cost-modifiers.ts` entry and the readiness is a
  // case in `deploy.conditionalEntersReady`. Both are per-card tables, which is
  // exactly the shape the fan-out rule keeps one agent out of.
  //
  // **UNL-037 Shadow Watcher** — "If a friendly unit died during your Beginning
  // Phase this turn, I enter ready." The same `deploy` case, plus a fact NOTHING
  // in this engine records. `PlayerState.unitsLostThisTurn` counts deaths for the
  // whole turn and `DeathContext` notes `diedInCombat` and the location, but no
  // field anywhere distinguishes a death in the Beginning Phase from one in the
  // Action Phase — and `[Temporary]`'s sweep and the hold-scoring step both kill
  // in the Beginning Phase, so the difference is real rather than theoretical.
  // Writing it against `unitsLostThisTurn` would make the card fire off any death
  // at any time, which is a strictly better card than the one printed.
  //
  // Adding it is one field on `PlayerState` (`model/game-state.ts`), one
  // increment in the death funnel and one reset in `runEnd`. All shared.
  //
  // **Wave 8 measured that claim rather than re-reading it**, and it holds:
  // `unl-calm-wave8-refusals.test.ts` runs the death funnel once in `Beginning`
  // and once in `Action` and compares the WHOLE serialized `PlayerState`. The two
  // are byte-identical, and the same comparison separates one death from two — so
  // "no field records the phase" is a measurement, not a search that came up empty.
  //
  // # UNL-054 Tricksy Tentacles is WRITTEN — see `cardEffects` above
  //
  // Wave 8's refusal stood here and its finding held exactly: the battlefield axis
  // needed ONE `MOVE_TARGET_SPELL_DEF_IDS` row and no enumerator change at all.
  // The row landed, the resolver is written, and
  // `unl-054-tricksy-tentacles.test.ts` measures the group and the destination
  // arriving on ONE action through `legalActions` -> `submit` -> chain resolution.
  //
  // **What is still open is the BASE half, and it is NOT this file's.** The ruling
  // (project owner, 2026-08-13) is that "a single location" includes the enemy
  // base, and the resolver already handles a base destination correctly if one
  // ever arrives. Nothing offers one: `withDestinations`' `toBase` branch is gated
  // on an index derived from the singular `targetUnitInstanceId`, which a
  // `unitList` play never sets, so a `MOVE_TO_BASE_DEF_IDS` row alone would
  // enumerate nothing. Both halves are shared-file edits, and the test pins the
  // current refusal in both directions so landing either alone fails loudly.
};

/** Janna - Savior's "heal your units HERE" — `playerIndex`'s units at
 *  `battlefieldId`, or in their base when she was played there.
 *
 *  Written out rather than reaching for `healAllUnits`, which is global on both
 *  axes this card is narrow on: it clears BOTH players and EVERY zone, and would
 *  quietly heal the enemy units Janna was cast to finish off. */
function healOwnUnitsAt(state: GameState, playerIndex: 0 | 1, battlefieldId: string | undefined): GameState {
  const heal = (u: UnitInstance): UnitInstance => (u.damage === 0 ? u : { ...u, damage: 0 });
  const ownerId = state.players[playerIndex].id;
  if (battlefieldId === undefined) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = { ...players[playerIndex], baseUnits: players[playerIndex].baseUnits.map(heal) };
    return { ...state, players };
  }
  return {
    ...state,
    battlefields: state.battlefields.map((bf) =>
      bf.id === battlefieldId ? { ...bf, units: { ...bf.units, [ownerId]: (bf.units[ownerId] ?? []).map(heal) } } : bf,
    ),
  };
}

/**
 * Ornn - Blacksmith's ability, shared by his on-play and his on-hold trigger.
 *
 * Nocturne's offer is parked FIRST, and the queue being FIFO is what makes that
 * the right order: "as you LOOK AT me from the top of your deck" is answered
 * before "which gear do you take", which is the order the two texts read in.
 * Reinforce makes the same call for the same reason.
 *
 * An empty deck asks nothing at all rather than parking a question whose only
 * answer is "decline" — 422.
 */
function ornnLook(state: GameState, playerIndex: 0 | 1): GameState {
  const looked = state.players[playerIndex].deck.slice(0, 4);
  if (looked.length === 0) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, looked), { kind: "SFD-058-gear", playerIndex });
}

/** "Recycle the top card" — the bottom of the Main Deck (416/416.1), never the
 *  trash. Held through `holdCardsRecycled` so Karma - Channeler sees it, which
 *  is the whole reason this is not written as a bare deck rotation. */
/** Shared out of `effect-helpers.ts` — see its note on why the two private
 *  copies were promoted. */

/** The cards Guardian of the Passage could take back — "a unit OR GEAR from
 *  your trash", so a Spell in there is not on offer. */
function trashUnitsAndGear(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter((c) => c.kind === "Unit" || c.kind === "Gear");
}

/**
 * "Are there no other friendly units HERE?" — the Poro's own reminder text, and
 * the rules' Special Terms definition it restates: "A unit is alone when there
 * are no other friendly units at the same location."
 *
 * LOCATION, not battlefield, so a death in base asks about the base. That is the
 * same bare-noun reading (355.9.a.1) that Discipline and Rune Prison take of "a
 * unit", applied to "here": a Base is a place on the Board like any other, and a
 * Poro that dies at home surrounded by its friends did not die alone.
 *
 * "OTHER friendly" needs no self-exclusion written out: `completeDeath` puts the
 * corpse in the trash BEFORE the [Deathknell] is held, so the dying unit is
 * already gone from whatever this counts.
 */
function noOtherFriendlyUnitsAt(state: GameState, ownerIndex: 0 | 1, battlefieldId: string | undefined): boolean {
  if (battlefieldId === undefined) return state.players[ownerIndex].baseUnits.length === 0;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return (bf?.units[state.players[ownerIndex].id] ?? []).length === 0;
}

/**
 * Lonely Poro's [Deathknell], written once and registered under BOTH of the
 * defIds the pool prints it at (SFD-036 and the Unleashed Overnumbered reprint
 * UNL-221). See the note on the table entries below for why it is shared.
 */
const LONELY_PORO_DEATHKNELL: DeathknellDefinition = {
  // `death.ownerIndex` rather than a caster index: for a Deathknell "friendly"
  // means the DYING unit's controller, which is the same seat
  // `resolveHeldDeathknell` builds its context from.
  capture: (state, death) => noOtherFriendlyUnitsAt(state, death.ownerIndex, death.battlefieldId),
  // Read from the capture, never re-derived. Re-deriving here is exactly the
  // divergence: by now the corpse and any ally killed alongside it are both in
  // a trash, and the board would answer "alone" either way.
  resolve: (state, ctx, _death, captured) => (captured === true ? drawCards(state, ctx.casterIndex, 1) : state),
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {
  // Lonely Poro — "[Deathknell] — If I died alone, draw 1. (When I die, get the
  // effect. I'm alone if there are no other friendly units here.)" (rule 808)
  //
  // `ctx.casterIndex` is the DYING unit's controller — what "friendly" and "draw"
  // both mean for a Deathknell — and not whoever killed it. `death.battlefieldId`
  // is "here", captured when the Poro died and therefore still right even though
  // the corpse has since moved to the trash.
  //
  // **DIVERGENCE, and it is a real one rather than a theoretical one.** "I DIED
  // alone" is past tense: the rules note a dying unit's "location, attributes,
  // and other relevant information" as the [Deathknell] is added to the chain as
  // a Pending Item (Cleanup step 3a, and again under Kill Instruction), and
  // information a trigger condition references "is checked when the trigger
  // condition is fulfilled". This asks the question at RESOLUTION instead, which
  // is a chain-pop later.
  //
  // The two answers differ whenever a friendly unit leaves that location in
  // between, and the reachable case is a MUTUAL WIPE: combat.ts's
  // `processDefeated` kills the losing side's units one at a time, so a Poro that
  // died beside an ally reads as alone by the time its Deathknell pops and draws
  // a card the rules would not give it. Measured, not assumed — see the mutual-
  // death case in test/sfd-calm.test.ts.
  //
  // **CLOSED 2026-08-07.** `DeathknellDefinition.capture` is the primitive this
  // note said did not exist, and adding it brought a third family into line with
  // `EventTriggerDefinition` and `DeathWatchDefinition` rather than inventing
  // anything. The question is now asked as the Deathknell goes ON THE CHAIN —
  // Cleanup step 3a, while the ally that died first is still standing — and the
  // answer rides the entry to resolution.
  //
  // The workaround this note refused is still refused, and for the reason it
  // gave: reading the other deaths sitting on the chain is placement-order
  // dependent, so a Poro killed FIRST would see none of them and be right by
  // accident about half the time.
  "SFD-036": LONELY_PORO_DEATHKNELL,
  // Lonely Poro AGAIN — Unleashed reprints it as an Overnumbered card
  // (UNL-221, "[Deathknell] [>] If I died alone, draw 1."), which is the same
  // ability on a card with a different defId, so it needs its own key.
  //
  // The DEFINITION is shared rather than copied, and that is the whole reason
  // `LONELY_PORO_DEATHKNELL` exists as a const. A second literal here would be
  // two places for the capture-vs-resolve split to drift, and the drift would be
  // invisible: both copies would still draw a card most of the time, and only
  // the died-beside-an-ally case would come apart. That case is exactly the one
  // this card's capture hook was added for.
  //
  // No text difference to model. The UNL printing drops the parenthetical
  // reminder ("I'm alone if there are no other friendly units here") and prints
  // nothing else; reminder text is not rules text.
  "UNL-221": LONELY_PORO_DEATHKNELL,
  "UNL-053": {
    // Scuttle Crab — "[Deathknell] [>] Choose an opponent. They reveal their hand.
    // You can look at their facedown cards this turn. Gain 1 XP." (808)
    //
    // # Three sentences, and only the last one is a game action in this engine
    //
    // "Choose an opponent" has exactly one answer at two players and so is not a
    // choice — `advanceDecisions` would execute a one-option question unprompted
    // anyway, so parking one would be theatre.
    //
    // "They reveal their hand" is INFORMATION, and this engine's `GameState`
    // models none: every zone is plainly readable from the state object, and there
    // is no per-seat visibility anywhere in `model/`. Sabotage (OGN-156) prints the
    // same sentence and writes nothing for it either — its decision simply lists
    // the opponent's hand — so this is the pool's existing reading rather than a
    // new one.
    //
    // "You can look at their facedown cards this turn" is the same kind of
    // sentence about a different zone, and it is the one worth flagging: the WEB
    // client does hide an opponent's `hiddenCards`, so this clause is a real
    // permission there even though it is a no-op here. No engine field expresses
    // it; adding one is `model/game-state.ts` plus the web board, neither of which
    // this file owns. Recorded as a divergence rather than faked.
    //
    // "Gain 1 XP" is the whole of what this can do, and `gainXp` is the single
    // writer for it (728–733) — which is also the only instrument that can see an
    // XP keyword fire at all (`probes/hunt-xp.ts`).
    //
    // `ctx.casterIndex` is the DYING unit's controller, which is who "you" means
    // in every printed Deathknell.
    resolve: (state, ctx) => gainXp(state, ctx.casterIndex, SCUTTLE_CRAB_XP),
  },
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

/**
 * The friendly unit that is "attacking or defending ALONE" at this combat, or
 * `undefined` if the listener's controller has anything other than exactly one
 * unit there — Mask of Foresight's whole trigger condition, and the unit its
 * "give IT +1 Might" refers to.
 *
 * One function serving as both the `applies` predicate and the `capture`, so the
 * ability cannot trigger for one unit and then buff another. Splitting them into
 * a count check and a separate lookup is exactly the drift this shape prevents.
 */
function aloneAt(state: GameState, listener: Listener, event: GameEvent): string | undefined {
  if (event.kind !== "combatBegan") return undefined;
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  const mine = bf?.units[state.players[listener.ownerIndex].id] ?? [];
  if (mine.length !== 1) return undefined;
  // And the one unit must be gaining its designation NOW. A reinforcement
  // arriving mid-combat designates only itself (464.2.c Step 1), and by then its
  // controller has two units there — so this is already false. The check matters
  // for the mirror case: an ARRIVAL that makes its controller's presence exactly
  // one, which happens when everything else there has died.
  return event.designated.includes(mine[0]!.instanceId) ? mine[0]!.instanceId : undefined;
}

/**
 * How many ENEMY units `ownerIndex` themselves just stunned — Eclipse Herald's
 * whole condition, and the number his "+1 Might" is multiplied by.
 *
 * One function for the predicate and the payout, so the ability cannot trigger
 * for a count it then fails to use. Reads only the event and the listener's
 * owner, which is what makes it safe to ask at fire time: neither can be changed
 * by the response window the hold opens.
 */
function enemiesStunnedFor(ownerIndex: 0 | 1, event: GameEvent): number {
  if (event.kind !== "unitsStunned" || event.stunnerIndex !== ownerIndex) return 0;
  return event.stunned.filter((s) => s.ownerIndex !== ownerIndex).length;
}

/**
 * Aphelios - Exalted's three modes, and which of them he has left this turn.
 *
 * One function for the fire-time "is there anything to choose" test and for the
 * option list, so the two cannot disagree about what "hasn't been chosen this
 * turn" means — the same one-walk rule Ribbon Dancer's candidates follow.
 *
 * Read off the INSTANCE's `abilityModesUsedThisTurn`, the field the activated
 * modal cards already use; see the trigger below for why it is shared rather
 * than duplicated.
 */
/** Forgefire Cape's art-only burn — "deal 2 to all enemy units here". */
const FORGEFIRE_DAMAGE = 2;

const APHELIOS_MODES = [
  { id: "ready", label: "Ready 2 runes" },
  { id: "channel", label: "Channel 1 rune exhausted" },
  { id: "buff", label: "Buff a friendly unit" },
] as const;

function apheliosModesLeft(
  state: GameState,
  ownerIndex: 0 | 1,
  instanceId: string,
): readonly { id: string; label: string }[] {
  const owner = state.players[ownerIndex];
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  const aphelios = units.find((u) => u.instanceId === instanceId);
  // Gone from the board — no modes, which drops the question whole rather than
  // offering one against a unit that is not there.
  if (aphelios === undefined) return [];
  const used = new Set(aphelios.abilityModesUsedThisTurn ?? []);
  return APHELIOS_MODES.filter((m) => !used.has(m.id));
}

/**
 * Apprentice Smith's reveal — "reveal the top card of your Main Deck. If it's a
 * gear, draw it. Otherwise, recycle it."
 *
 * Extracted from his trigger so Void Hatchling can run its look-and-recycle
 * first: this function is both the inline path and the body of the
 * `SFD-041-reveal` continuation, which is what makes the two identical by
 * construction rather than by two copies agreeing.
 */
function apprenticeSmithReveal(state: GameState, ownerIndex: 0 | 1): GameState {
  const top = state.players[ownerIndex].deck[0];
  if (!top) return state;
  // "If it's a GEAR, DRAW it" — the card revealed is the top one, so the
  // ordinary draw takes exactly it.
  const after = top.kind === "Gear" ? drawCards(state, ownerIndex, 1) : recycleTopCard(state, ownerIndex);
  // "As you look at or REVEAL me" (Nocturne), raised AFTER rather than before
  // because this reveal consumes the card immediately and nothing here stops to
  // ask — the same ordering Dazzling Aurora uses, and his decision banishes the
  // card from wherever it has since ended up.
  return revealedFromDeck(after, ownerIndex, [top]);
}

/** Lillia - Protector of Dreams gives HERSELF +1 per token unit you play. */
const LILLIA_TOKEN_MIGHT = 1;

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  [AFFECTIONATE_PORO]: {
    // Affectionate Poro — "When a combat that I was in ends, if I haven't been
    // dealt damage this turn, draw 1."
    //
    // # Both halves needed something the engine did not have
    //
    // **"A combat that I was in ENDS"** is a new moment. `combatWon` fires only
    // when there IS a winner (466.3.a) and is about the RESULT; this fires for
    // every combat, No Result included. And it carries its PARTICIPANTS, because
    // rule 466's Step 3 cleanup recalls surviving attackers home before any held
    // trigger resolves — so by then the board cannot answer "was I in it".
    //
    // **"I haven't been dealt damage this turn"** cannot be read off `damage`:
    // step 3c HEALS every unit on the board at the end of every combat, so the
    // field is 0 by the time this resolves no matter what happened. That is why
    // `damagedThisTurn` exists and why it is written by both damage paths.
    //
    // The two together are the card: it rewards a Poro that fought and came
    // through untouched, and the obvious implementation — read `damage` after the
    // combat — reports EVERY Poro as untouched, which looks like a working card.
    on: "combatEnded",
    applies: (state, listener, event) =>
      event.kind === "combatEnded" &&
      event.participantInstanceIds.includes(listener.card.instanceId) &&
      listener.card.kind === "Unit" &&
      listener.card.damagedThisTurn !== true,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatEnded") return state;
      // Re-read from the LIVE unit rather than from the listener snapshot: the
      // trigger is held, and a spell resolving in the window can damage it before
      // this pays out. The listener's copy was taken when the combat ended.
      const live = findUnitAnywhere(state, listener.card.instanceId);
      if (!live || live.unit.damagedThisTurn === true) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  [ASTRAL_HERON]: {
    // Astral Heron — "When you play your FIRST card each turn, if I'm at a
    // battlefield, your NEXT card costs [2 Energy][rainbow][rainbow] less."
    //
    // Three conditions and a two-part discount:
    //
    //   - **"your FIRST card each turn"**: `cardsPlayedThisTurn` is bumped inside
    //     `executePlayCardInner`, which runs BEFORE this event is held, so the
    //     first card of the turn arrives with the counter already at 1. Asked as
    //     `=== 1` for that reason — the same off-by-one Jayce's gear clause has.
    //   - **"if I'M AT A BATTLEFIELD"**: positional, so a Heron in base grants
    //     nothing.
    //   - **"YOUR next card"**: the controller's, not the opponent's.
    //
    // The discount is a CHARGE on the player, spent by the next card played, and
    // it is the pool's first that reduces ENERGY AND POWER together — hence two
    // fields rather than reusing `nextSpellEnergyDiscount`, which is Spells only
    // and has no Power half.
    on: "cardPlayed",
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      listener.battlefieldId !== undefined &&
      state.players[listener.ownerIndex].cardsPlayedThisTurn === 1,
    resolve: (state, listener) =>
      armNextCardDiscount(state, listener.ownerIndex, ASTRAL_HERON_ENERGY, ASTRAL_HERON_POWER),
  },
  [SHEN_SCOURGE]: {
    // Shen, Scourge of Shadows — "When I HOLD, if there is exactly one other unit
    // you control here, draw 1."
    //
    // The set's formation motif, and the FOURTH card to print it: "exactly one
    // other unit you control here" is as dead with two allies as with none, which
    // is the boundary a board built with a single ally can never see. Order wave
    // 1's Shen scores a point off the same sentence; this one draws.
    //
    // Asked in `applies` AND re-asked at resolution: the count is a fact about the
    // BOARD rather than about the event, and a chain item resolving in between can
    // move a unit in or out. That is the split `applies`' own note describes.
    on: "battlefieldHeld",
    applies: (state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      listener.card.kind === "Unit" &&
      otherOwnUnitsHereForShen(state, listener.card, listener.ownerIndex) === SHEN_SCOURGE_ALLIES,
    resolve: (state, listener) => {
      if (listener.card.kind !== "Unit") return state;
      if (otherOwnUnitsHereForShen(state, listener.card, listener.ownerIndex) !== SHEN_SCOURGE_ALLIES) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  [AKALI_SILENT]: {
    // Akali, Silent's second sentence — "when I move to a BATTLEFIELD, give me +2
    // [Might] this turn." Her first ("I can't be chosen by enemy spells and
    // abilities unless I'm in combat") is a `target-lookup` table entry, so
    // coverage merges the two claims.
    //
    // `event.to !== "base"` is what "to a battlefield" means here — the same test
    // Ribbon Dancer's move trigger makes, and a recall home must not pump her.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.to !== "base",
    resolve: (state, listener) =>
      giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, AKALI_SILENT_MIGHT),
  },
  [PAKAA_PROTECTOR]: {
    // Pakaa Protector — "When I move, reveal the top card of your Main Deck. If
    // it's a unit, draw it. Otherwise, put it in your trash and give me +2
    // [Might] this turn."
    //
    // **"When I MOVE", with no destination** — unlike Akali above, so a move home
    // to base fires it too. The two cards are in the same wave precisely so the
    // difference is visible: one prints "to a battlefield" and one does not.
    //
    // Revealing moves nothing (425: "cards remain in the zone they are being
    // Revealed from"), so the card is still on top while the branch is decided,
    // and each arm then moves it — to hand, or to the trash through the funnel so
    // Endless Riches can banish it instead.
    //
    // An empty deck reveals nothing and does nothing (422's do as much as you
    // can): no draw, no trash, and NO Might, because the Might is the second half
    // of the "otherwise" arm rather than a separate sentence.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener) => {
      const top = state.players[listener.ownerIndex].deck[0];
      if (!top) return state;
      if (top.kind === "Unit") return drawCards(state, listener.ownerIndex, 1);
      const trashed = updatePlayerForPakaa(state, listener.ownerIndex, top);
      return giveMightThisTurnToOwnUnit(trashed, listener.ownerIndex, listener.card.instanceId, PAKAA_PROTECTOR_MIGHT);
    },
  },
  "VEN-046": {
    // Nasus, Ascended — "[Empowered][>] When I conquer, you score 1 point."
    //
    // **The first DEPENDENT trigger in this file, and the gate is the whole
    // difference from an ordinary one.** 828.1.b.1 makes the clause short for
    // "While I have the Empowered status, this card gains `[Text]`", and 828.1.c
    // makes it active "as long as" the status holds — so the trigger exists only
    // while Nasus is Empowered, and an un-Empowered Nasus conquering scores
    // nothing beyond the ordinary point. Asked through `isEmpowered` on the
    // LISTENER's own instance, which is what makes it per-object (441.1.a) rather
    // than a question about the player.
    //
    // "When **I** conquer" is the positional reading Ahri - Alluring, Adaptatron
    // and Sett - Brawler all take of the same phrase: the battlefield conquered
    // has to be the one Nasus is standing at, not merely one his controller took
    // somewhere. The event carries a battlefield for exactly that reason.
    //
    // He therefore DOUBLES a conquest — the ordinary point is already awarded by
    // the time this fires, and this is a second one. That is the card: 8 Energy
    // to Empower a `[Deflect 2]` body whose battlefield is then worth two.
    //
    // **A plain `gainPoints`, deliberately NOT routed through `recordConquest`**,
    // for the reason Ahri's entry sets out at length: 471.1.b's Final Point
    // restriction applies only to a point gained "through a Conquer", and sending
    // this down that path would silently withhold a winning point unless every
    // battlefield had been scored that turn.
    on: "battlefieldConquered",
    // Every condition is fixed at FIRE time, including the Empowered one. This
    // trigger is held, and the window it opens is precisely when an opponent
    // could Disempower him (442) — re-asking at resolution would let them cancel
    // a point that has already been earned, which is the same argument Ahri's
    // entry makes about moving or killing her.
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      isEmpowered(state, listener.card.instanceId),
    resolve: (state, listener) => gainPoints(state, listener.ownerIndex, 1),
  },
  "UNL-058": {
    // Lillia - Protector of Dreams — "When you play a TOKEN UNIT, give me +1
    // [Might] this turn." Her second sentence ("your token units have [Tank]") is
    // a `KEYWORD_AURAS` row in granted-keywords.ts, not this file.
    //
    // **This card was REFUSED twice and neither refusal was wrong at the time.**
    // Both halves needed something that did not exist: `placeToken` held no event
    // whatsoever, so "when you play a token unit" could not be observed, and the
    // aura table had no way to ask about the RECIPIENT's token nature. Both
    // landed on 2026-08-10 and the card is written without a single new
    // primitive.
    //
    // Three conditions, all facts about the EVENT, so all asked in `applies` —
    // 383.2.a.1 fixes the Trigger Condition at the moment it is fulfilled, and
    // Sona - Harmonious's worked example under it makes a listener removed in
    // reaction still resolve:
    //
    //   `isToken` is the whole card. 185.2.a makes a token PLAYED and 185 keeps
    //   it from being a card, and this sentence wants exactly the first without
    //   the second — the only listener in the pool that is positive on it, where
    //   the three card-readers are negative.
    //
    //   `playedKind === "Unit"` because a Gold GEAR token is also a played token
    //   and she says "token UNIT".
    //
    //   `casterIndex === ownerIndex` for "when YOU play". Without it an
    //   opponent's Recruit would pump her.
    //
    // No cap: she prints no "first time each turn", so three tokens in a turn is
    // +3 and each is its own held item.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.isToken &&
      event.playedKind === "Unit" &&
      event.casterIndex === listener.ownerIndex,
    // The owned-unit form, so she no-ops if she has left the board between the
    // hold and the pop rather than reaching for a Lillia an opponent has taken.
    resolve: (state, listener) =>
      giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, LILLIA_TOKEN_MIGHT),
  },
  "SFD-190": {
    // Forgefire Cape — "When I attack or defend, deal 2 to ALL enemy units here."
    //
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER, so it rides `wearerListener` like the eight art-only
    // Equipment already do — the gear's listener is rewritten as the unit
    // wearing it and every existing predicate applies unchanged.
    //
    // "ATTACK OR DEFEND" is both designations, which is why the check is bare
    // membership in `event.designated` rather than a side comparison: 464.2.c Step 1
    // hands the designation to every unit at the contested battlefield, attacker
    // and defender alike, and the card asks for either.
    //
    // "ALL enemy units HERE" is measured from the WEARER's controller and at the
    // battlefield the combat is at.
    //
    // **And "here" is RE-CHECKED against where the wearer is standing at
    // resolution** — Recurve Bow's rule, applied to its direct sibling. "Here" is
    // a referent read from the ability's source (359.3.f.1), checked on EXECUTION
    // of the instruction (359.3.f.2), and the rules' worked example is an
    // opponent answering Yasuo - Remorseful's attack trigger with Fight or
    // Flight: "'here' is no longer the battlefield where combat is ongoing and
    // the attack trigger mistargets". A wearer sent home — or killed, dropping
    // the Cape — burns nobody, and the burn is never re-aimed at whatever
    // battlefield he reached.
    //
    // `isStillHere` reads the BOARD rather than comparing `wearer.battlefieldId`,
    // and the difference is the dead case: `wearerListener` is `undefined` once
    // the wearer is gone, so that branch is already covered, but a check written
    // against a captured location would be answering with the combat's own id.
    on: "combatBegan",
    applies: (state, listener, event) => {
      if (event.kind !== "combatBegan") return false;
      const wearer = wearerListener(state, listener);
      return wearer !== undefined && event.designated.includes(wearer.card.instanceId);
    },
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const wearer = wearerListener(state, listener);
      if (wearer === undefined) return state;
      if (!isStillHere(state, wearer.card.instanceId, event.battlefieldId)) return state;
      return dealDamageToEnemyUnitsAtBattlefield(state, wearer.ownerIndex, event.battlefieldId, FORGEFIRE_DAMAGE);
    },
  },
  "SFD-049": {
    // Aphelios - Exalted — "When you attach an Equipment to me, choose one that
    // hasn't been chosen this turn: Ready 2 runes / Channel 1 rune exhausted /
    // Buff a friendly unit."
    //
    // Rides `equipmentAttached`, and "TO ME" is read exactly as Jax -
    // Unrelenting's clause reads it: the event names the WEARER, so this compares
    // the two instances and an Equipment landing on the unit beside him is not
    // his moment. A MOVE counts, for the reason that event's own comment gives.
    //
    // **The pool's first once-per-turn modal reached from a TRIGGER rather than
    // an activated ability.** It reuses `abilityModesUsedThisTurn` on the unit
    // and `recordModeUsed` rather than inventing a parallel record: the field
    // already means "modes this SOURCE has spent this turn", `turn-manager`'s
    // runEnd already clears it for every unit on both sides, and a second field
    // would be a second thing to forget to reset. What differs is only how the
    // question is reached.
    //
    // Not offered once all three are spent — "choose one that hasn't been chosen
    // this turn" with nothing left is not a choice, and an offer nobody can take
    // is not made. That is what makes a second and third Equipment in one turn
    // progressively worth less, which is the card.
    on: "equipmentAttached",
    applies: (state, listener, event) =>
      event.kind === "equipmentAttached" &&
      event.unitInstanceId === listener.card.instanceId &&
      apheliosModesLeft(state, listener.ownerIndex, listener.card.instanceId).length > 0,
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: "SFD-049-mode",
        playerIndex: listener.ownerIndex,
        // WHICH Aphelios — carried rather than re-found, because the per-turn
        // record lives on the instance and paying it against the wrong copy
        // would hand a second Aphelios a fresh set of modes.
        cardInstanceId: listener.card.instanceId,
      }),
  },
  "OGN-066": {
    // Ahri - Alluring — "When I hold, you score 1 point."
    //
    // "When **I** hold" is the positional reading Adaptatron and Sett - Brawler
    // take of their own "when I conquer": the battlefield being held has to be the
    // one Ahri is standing at, not merely one her controller held somewhere. The
    // event carries a battlefield for exactly that reason.
    //
    // She therefore DOUBLES a hold: `scoreHolds` has already awarded the ordinary
    // point for the battlefield by the time this fires, and this is a second one.
    // That is the card — a 5-Energy 4-Might Champion-adjacent body whose whole
    // text is "the battlefield I am standing on is worth two".
    //
    // **A plain `points + 1`, deliberately NOT routed through `recordConquest`**,
    // for the reason Yasuo - Windrider's entry sets out: rule 471.1.b's Final Point
    // restriction applies only to a point gained "through a Conquer", and sending
    // this down that path would silently withhold a winning point unless every
    // battlefield had been scored that turn.
    on: "battlefieldHeld",
    // Both conditions are fixed at fire time. The location one especially: this
    // trigger is held, and the window it opens is precisely when an opponent
    // could move or kill Ahri — re-asking at resolution would let them cancel a
    // point that has already been earned.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      // Through `gainPoints`, the single choke point every point-gain goes through
      // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints({ ...state, players }, listener.ownerIndex, 1);
      return { ...state, players };
    },
  },
  "OGN-067": {
    // Blitzcrank - Impassive's third clause — "When I hold, return me to my
    // owner's hand."
    //
    // A drawback, and a printed one: he is a 5-Might [Tank] who cannot keep a
    // battlefield he has taken. The point still SCORES — `scoreHolds` has already
    // awarded it by the time this fires — so the card is a body that trades
    // itself for a point and comes back to be replayed.
    //
    // "When **I** hold" is the same positional reading Ahri - Alluring takes
    // above: the battlefield held has to be the one he is standing at.
    //
    // `returnUnitToHand` rather than a recall: "to my owner's HAND" is leaving
    // play (705 strips the buff, damage and this-turn Might reset), which is what
    // makes replaying him a fresh on-play trigger rather than a repositioning.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? returnUnitToHand(state, listener.card.instanceId) : state),
  },
  "OGN-073": {
    // Sona - Harmonious — "At the end of your turn, if I'm at a battlefield,
    // ready up to 4 friendly runes."
    //
    // The first permanent in the pool to watch the End Phase; Annie - Dark
    // Child's "ready up to 2 runes" is the same moment on a Legend, and both now
    // ready through the one `readyRunes` in effect-helpers.ts rather than two
    // copies of "up to".
    //
    // **"Your turn" is read from the EVENT, never from `state.activePlayerIndex`.**
    // `endOfTurn` is held as a Chain Pending Item (383) and `submit`'s Pass runs
    // End and the next Start-of-Turn as one action, so by the time this resolves
    // the turn has rotated and the active player is the opponent. Asking the
    // board would make Sona fire on exactly the turns she should not.
    //
    // "Up to 4" is not offered as a choice, for the reason `readyRunes` gives:
    // readying is strictly beneficial, so maxing it is the faithful reading
    // rather than a shortcut. "FRIENDLY runes" is her controller's pool, which is
    // the only pool the helper can reach.
    on: "endOfTurn",
    // Both conditions are settled at fire time and deliberately NOT re-asked in
    // `resolve`. "If I'm at a battlefield" is a fire-time condition in the same
    // family as Adaptatron's location check: the window this hold opens is
    // precisely when an opponent could move or kill Sona, and re-asking would let
    // them cancel an ability that has already triggered. 383 fixes triggering at
    // the moment of the event.
    applies: (_state, listener, event) =>
      event.kind === "endOfTurn" && event.playerIndex === listener.ownerIndex && listener.battlefieldId !== undefined,
    resolve: (state, listener, event) => (event.kind === "endOfTurn" ? readyRunes(state, listener.ownerIndex, 4) : state),
  },
  "OGN-060": {
    // Mask of Foresight — "When a friendly unit attacks or defends alone, give it
    // +1 Might this turn." See `aloneAt` above for the unit it means.
    //
    // An EVENT, not a continuous modifier, and the difference is the whole card:
    // "+1 this turn" is granted once and keeps its value for the rest of the turn
    // even after the unit stops being alone — a reinforcement arriving later does
    // not take it back. Wielder of Water's superficially similar "while I'm
    // attacking or defending alone" IS continuous and lives in effective-might.ts;
    // the two must not be confused.
    //
    // "Attacks OR defends" — either side, so this asks only whether the
    // controller's own presence at that battlefield is exactly one unit. Which
    // side started it does not matter and is deliberately not consulted.
    //
    // The one card in the pool that needs `capture`, and it needs it for a reason
    // that only appears once the trigger is held. "ALONE" is a fire-time
    // condition (383), so it belongs in `applies` — but the ability is then about
    // THAT unit, and by the time it resolves the response window may have brought
    // a second unit in or killed the one it fired for. Re-deriving "my only unit
    // here" at resolution buffs a reinforcement the card never triggered for; the
    // instance id is noted instead, which is 808.1.d.3's "note its attributes"
    // applied to the one attribute this ability is about.
    //
    // A Gear listener, so it has no `battlefieldId` of its own — hence reading
    // the event's, not the listener's.
    on: "combatBegan",
    applies: (state, listener, event) => aloneAt(state, listener, event) !== undefined,
    capture: aloneAt,
    resolve: (state, listener, event, captured) => {
      if (event.kind !== "combatBegan" || typeof captured !== "string") return state;
      // No presence re-check: it left play, or it did not, and `giveMightThisTurn`
      // already answers for a unit it cannot find (055's do as much as you can).
      return giveMightThisTurn(state, captured, 1);
    },
  },
  "OGN-059": {
    // Eclipse Herald — "When you stun an enemy unit, ready me and give me
    // +1 Might this turn."
    //
    // The rules use this card as their own worked example for why stunning an
    // already-stunned unit is not a stunning (423), so the guard it needs is not
    // written here at all: `stunUnits` drops those before the event exists.
    //
    // "AN enemy unit", singular — so this pays out once per qualifying unit in
    // the batch rather than once per instruction (which is Leona - Radiant
    // Dawn's "one or more" wording, deliberately different). Readying twice is
    // idempotent; the Might is not, and +2 for two enemies is the literal read.
    //
    // Both halves of "you ... enemy" are measured against the HERALD's
    // controller: `stunnerIndex` must be the listener, and the victim must not
    // be. A Herald does not celebrate its own controller's units being stunned,
    // nor the opponent stunning something.
    on: "unitsStunned",
    // Both halves of "you ... enemy" are fire-time conditions, so they decide
    // whether a Pending Item exists rather than being re-asked at resolution —
    // and they can be, because each reads only the EVENT and the listener's
    // owner, neither of which the response window can change.
    applies: (_state, listener, event) => enemiesStunnedFor(listener.ownerIndex, event) > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitsStunned") return state;
      const enemiesStunned = enemiesStunnedFor(listener.ownerIndex, event);
      if (enemiesStunned === 0) return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, enemiesStunned);
    },
  },
  "OGN-056": {
    // Adaptatron — "When I conquer, you may kill a gear. If you do, buff me."
    //
    // "When *I* conquer" is Kai'Sa - Survivor's and Sett - Brawler's reading:
    // the Adaptatron has to be AT the battlefield taken, which is what separates
    // a unit's conquer trigger from a Legend's "when you conquer". Checked
    // against the listener's own location rather than the event alone, since the
    // listener walk reaches it wherever it stands.
    //
    // "A gear", with no owner printed — so YOUR gear is a legal choice too, and
    // that is the card rather than an oversight: this pool's gear includes
    // Treasure Trove and Scrapheap, which pay out when they die. Routed through
    // `killGear` so those self-triggers fire, exactly as Thermo Beam does.
    on: "battlefieldConquered",
    // `battlefieldConquered` is held as a Chain Pending Item (383), so the two
    // conditions that decide whether this TRIGGERED are asked here, before it
    // reaches the chain.
    //
    // The gear check below is deliberately NOT one of them. "When I conquer" is
    // the trigger; whether there is a gear to kill is a question about the board
    // at RESOLUTION, and 383 fixes triggering at the moment of the event. A
    // trigger that fires and then resolves to nothing is the rules working — it
    // is not the same as never having triggered, which is the distinction holding
    // makes observable for the first time.
    //
    // The location check is here and not repeated in `resolve` for the reason
    // Sett - Brawler's entry sets out: the window this hold opens is exactly when
    // the Adaptatron could be moved off the battlefield it took.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      // "You MAY" — but a question with no answers must not be parked (055's do
      // as much as you can). With no gear anywhere the buff is unreachable, so
      // nothing is asked and nothing happens.
      if (state.players[0].activeGear.length + state.players[1].activeGear.length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-056-kill",
        playerIndex: listener.ownerIndex,
        // "Buff ME" — carried rather than re-derived, because by the time the
        // answer comes in the Adaptatron may have left the battlefield it
        // conquered, or play entirely.
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "OGN-076": {
    // Yasuo - Remorseful — "When I attack, deal damage equal to my Might to an
    // enemy unit here."
    //
    // **An Attack Trigger fires when the unit GAINS THE ATTACKER DESIGNATION**,
    // which rule 383.4's Attack Triggers section states outright ("trigger when a
    // Unit or Player gains the Attacker designation for the first time during a
    // combat"), and rule 464.2.c's Combat Step 1 is where that happens: "The Attacker
    // is the player whose unit(s) applied the Contested status... Units at the
    // Contested Battlefield controlled by the Attacker or Defender gain the
    // Attacker or Defender designation now." So the moment is the COMBAT
    // SHOWDOWN OPENING, not the move that contested the battlefield.
    //
    // He was the first card written this way, and the rest of the "when I attack"
    // family has now joined him: unit-triggers.ts's ATTACK_TRIGGERS register
    // against this same event through one shared adapter, so all eight of them
    // and Yasuo answer "am I attacking?" with the same `isAttackingAt`. They used
    // to be dispatched inside the move/play executor, one per unit that just
    // landed — earlier than the rules' moment, and blind to a unit that was
    // already standing there when a friend walked in and started the fight. 465
    // gives that unit the Attacker designation too, so Yasuo holding a
    // battlefield that his own reinforcement contests really does attack.
    on: "combatBegan",
    // The DESIGNATION is fixed when the combat opens (383), so it is asked here
    // and never re-asked — moving him away during the response window must not
    // cancel an ability that has already triggered. "HERE" is a different
    // question and is re-asked in `resolve`; see below.
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.card.kind !== "Unit") return state;
      // **THIS CARD IS THE RULES' OWN WORKED EXAMPLE FOR 359.3.f.2**, verbatim:
      // "A player moves Yasuo, Remorseful to an occupied enemy battlefield and
      // initiates combat there. In reaction to the Yasuo, Remorseful attack
      // trigger, their opponent plays Fight or Flight from hidden targeting
      // Yasuo, moving him back to base. When the attack trigger resolves, 'here'
      // is no longer the battlefield where combat is ongoing and the attack
      // trigger MISTARGETS." So the referent is checked HERE, at execution:
      // "here" is read from the ability's source (359.3.f.1), and an illegal one
      // returns null with "all instructions related to it ignored" (359.3.f.2.a).
      //
      // Until 2026-08-08 this comment claimed 383 settled it and shot into the
      // combat from wherever he had ended up — the exact behaviour the example
      // names as wrong. The whole "when I attack ... here" family now shares
      // `isStillHere`; his one printed instruction is the "here" one, so a Yasuo
      // sent home, moved on, or killed deals nothing at all rather than
      // re-aiming.
      if (!isStillHere(state, listener.card.instanceId, event.battlefieldId)) return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      if (!bf) return state;
      // "An enemy unit HERE" — the first one at this battlefield, in board order.
      // Auto-selected rather than asked, the same simplification (and the same
      // structural reason: no action to hang the choice on) that Crackshot
      // Corsair and Leona - Determined already make for their on-attack targets.
      const ownerId = state.players[listener.ownerIndex].id;
      const enemyId = Object.entries(bf.units)
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units.map((u) => u.instanceId))[0];
      if (enemyId === undefined) return state;
      // **"MY Might" is CURRENT Might, and it includes his `[Assault]` while he
      // holds the Attacker designation.** Corrected 2026-08-23.
      //
      // This read used to hardcode `isCombat: false`, defended as: "counting
      // Assault here would pay it twice in the same fight". **It would not.** His
      // trigger's damage and combat damage are two separate instances, and
      // **807.1.c** is a continuous Might modification — "While I am an attacker,
      // I have +X [M]" — rather than a one-shot resource that the first reader
      // spends. Anything asking a designated unit's Might gets the higher number,
      // every time. **432.1** works the same reading on a defender by name.
      //
      // That one sentence had been copied to four call sites across three cards;
      // `currentMightContext` is now the single answer. See its doc for the rule
      // and for why the recursion this was refused on does not reach here.
      const self = findUnitAnywhere(state, listener.card.instanceId);
      if (!self) return state;
      const might = effectiveMight(state, self.unit, self.ownerIndex, currentMightContext(state, self));
      return dealDamage(state, listener.ownerIndex, enemyId, might);
    },
  },
  "SFD-035": {
    // Guardian of the Passage — "When I hold, you may return a unit or gear from
    // your trash to your hand."
    //
    // "When **I** hold" is the positional reading Ahri - Alluring and Blitzcrank
    // - Impassive already take: the battlefield held has to be the one the
    // Guardian is standing at, not merely one his controller held somewhere.
    //
    // Both conditions are settled at fire time and deliberately not re-asked in
    // `resolve` — the window this hold opens is exactly when an opponent could
    // move or kill him, and 383 fixes triggering at the moment of the event.
    //
    // Whether the trash has anything to take back is NOT one of them: that is a
    // question about the board at RESOLUTION, so it belongs below. A trigger that
    // fires and then finds nothing is the rules working.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      // "You MAY" — but a question with no answers must not be parked (055).
      if (trashUnitsAndGear(state, listener.ownerIndex).length === 0) return state;
      return parkDecision(state, { kind: "SFD-035-return", playerIndex: listener.ownerIndex });
    },
  },
  "SFD-038": {
    // Ribbon Dancer — "When I move to a battlefield, give another friendly unit
    // +1 Might this turn."
    //
    // A `unitMoved` listener watching for ITSELF, which is Yasuo - Windrider's
    // shape and not the per-card `ON_MOVE_TRIGGERS` table's. Both are placed by
    // the same line of `executeMoveUnit`, so the two mechanisms fire at exactly
    // the same moment; this one is reachable from a per-domain file, which the
    // table is not.
    //
    // "TO A BATTLEFIELD" is written out even though a Standard Move in this
    // engine always has a battlefield as its destination (`MoveUnitAction`
    // carries `destinationBattlefieldId`, and moving home is a Recall rather
    // than a Move — 454). It is the card's own condition, and a check that is
    // currently always true is cheaper to keep than to rediscover.
    //
    // "ANOTHER friendly unit" carries no location word, so 355.9.a.1's bare-noun
    // reading applies and a unit at home is a legal choice — pumping a defender
    // in base is exactly what this is for when the Dancer walks in alone.
    //
    // giveMightThisTurn, not a Buff: it expires in the Expiration Step (317).
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.to !== "base",
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      // MANDATORY — no "you may" — so there is no decline option. With no other
      // friendly unit anywhere there is nobody to give it to and nothing is
      // asked (422); "ANOTHER" is what makes that case reachable at all.
      if (ribbonDancerCandidates(state, listener.ownerIndex, listener.card.instanceId).length === 0) return state;
      return parkDecision(state, {
        kind: "SFD-038-might",
        playerIndex: listener.ownerIndex,
        // "ANOTHER" — the Dancer herself, carried so the answer-time candidate
        // list can exclude her even if she has moved again since.
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-041": {
    // Apprentice Smith — "When I move, reveal the top card of your Main Deck. If
    // it's a gear, draw it. Otherwise, recycle it."
    //
    // Same self-watching `unitMoved` shape as Ribbon Dancer above, minus her
    // destination condition: "when I move" full stop.
    //
    // Nothing is revealed from an empty deck, so nothing happens — deliberately
    // NOT a Burn Out. `drawCards` runs 431 because a card was drawn and could
    // not be; this card only draws once it has already seen a gear on top, so
    // an empty deck never reaches the draw at all.
    //
    // "RECYCLE it" is the bottom of the Main Deck (416.1), which is what makes
    // the Smith a repeatable filter rather than self-mill: the same card comes
    // back around eventually.
    //
    // The reveal itself is `apprenticeSmithReveal`, extracted so that Void
    // Hatchling's "look at the top card first, you may recycle it" can run
    // BEFORE it — see `voidHatchlingGate`. Without the extraction the question
    // would be parked and the reveal would proceed anyway, which makes the
    // Hatchling a silent no-op.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      return voidHatchlingGate(
        state,
        listener.ownerIndex,
        listener.ownerIndex,
        { kind: "SFD-041-reveal", playerIndex: listener.ownerIndex },
        (s) => apprenticeSmithReveal(s, listener.ownerIndex),
      );
    },
  },
  "SFD-047": {
    // Simian Ancestor — "When you buff me, ready me."
    //
    // A 5-Energy 5-Might body that can attack and then be untapped by any of the
    // pool's buffs, which is why it reads on the BUFF rather than on the pump: a
    // Buff is a persistent game object (705) and this fires as one is PLACED.
    //
    // Fires only for a buff that was really placed. 702.3.a makes a second Buff on an
    // already-buffed unit a no-op, and `addBuff` already drops the event in that
    // case — so a second Stand United does not ready him again. That is the rule
    // rather than an optimisation here, and it is the reason this card is not a
    // free untap engine.
    //
    // **"When YOU buff me" is read as "when I am buffed", and that is the
    // event's shape rather than a choice made here**: `unitBuffed` carries whose
    // UNIT it is and deliberately no causer (see its own note). The two come
    // apart only if an opponent could buff your unit, which no card in this pool
    // does — the day one does, the event needs the field, not this entry.
    //
    // `readyUnit` no-ops on an already-ready Ancestor, which is 415 and is what
    // keeps the `unitReadied` event honest.
    on: "unitBuffed",
    applies: (_state, listener, event) =>
      event.kind === "unitBuffed" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.ownerIndex === listener.ownerIndex,
    resolve: (state, listener) => readyUnit(state, listener.card.instanceId),
  },
  "SFD-048": {
    // Stellacorn Herder — "When I move, draw 1."
    //
    // The plainest member of the self-watching `unitMoved` family; see Ribbon
    // Dancer above for why these are event listeners rather than entries in
    // unit-triggers.ts's per-card move table.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "SFD-057": {
    // Irelia - Fervent — "[Deflect] When you choose or ready me, give me
    // +1 Might this turn."
    //
    // **WHOLE as of 2026-08-06.** The comment here used to say the choose half
    // "cannot be [written] from this file", and named exactly what it needed: a
    // `unitChosen` GameEvent fired from BOTH choosing paths. That is now in
    // triggers.ts, raised by `holdUnitsChosen` from `execute-play-card` (Spells)
    // and `execute-activate-ability` (abilities).
    //
    // It is a second event rather than a widening of
    // `battlefield-abilities.unitChosenBySpell`, for the three reasons that
    // comment listed: the old one is keyed to a BATTLEFIELD so it cannot reach a
    // unit listener, it never saw an ability choosing her, and it drops a unit
    // standing in base. The Dreaming Tree wants all three restrictions; she
    // wants none of them.
    //
    // "When YOU choose me" is her CONTROLLER choosing, not an opponent — which
    // is the sentence `[Deflect]` exists alongside rather than in tension with:
    // an opponent may still pay the rainbow to choose her, and she simply does
    // not grow from it.
    //
    // The ready half is not a consolation prize — `unitReadied` includes the
    // Awakening Phase's mass ready (415, and the event's own note), so a
    // returning Irelia is a 5-Might attacker on the turn after she is spent.
    //
    // Fires only for a ready that actually happened: `readyUnit` refuses an
    // already-ready unit (415), so the event never exists for a no-op.
    on: ["unitReadied", "unitChosen"],
    applies: (_state, listener, event) =>
      event.kind === "unitReadied"
        ? event.unitInstanceId === listener.card.instanceId && event.ownerIndex === listener.ownerIndex
        : event.kind === "unitChosen" &&
          event.unitInstanceId === listener.card.instanceId &&
          // "YOU choose", so her own side only.
          event.chooserIndex === listener.ownerIndex,
    // Both moments pay the same +1, so one resolver serves both — and it is
    // deliberately NOT capped: choosing her twice with one spell is two choices
    // (two `unitChosen` events), and the card says nothing about once per turn.
    resolve: (state, listener) => giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 1),
  },
  "SFD-058": {
    // Ornn - Blacksmith's SECOND moment — "when I hold". See his on-play entry
    // in `unitTriggers` for the ability itself; both call `ornnLook`.
    //
    // "When **I** hold" is positional, like Ahri - Alluring's and the Guardian's
    // above: the battlefield held has to be the one Ornn is standing at. Settled
    // at fire time so the window this opens cannot be used to move him off it.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? ornnLook(state, listener.ownerIndex) : state),
  },
  "UNL-043": {
    // Enthusiastic Promoter — "[Backline] When I hold, [Buff] all units here."
    //
    // Only the sentence is here. `[Backline]` ("I must be assigned combat damage
    // last") is a keyword and is UNIMPLEMENTED engine-wide — it is named in
    // `coverage.UNIMPLEMENTED_KEYWORDS`, so this card correctly reports
    // unimplemented whatever is written for its second half. Nothing to do here
    // either way: `combat.ASSIGNED_LAST_DEF_IDS` is the mechanism, in a shared
    // file, and it does not yet ask the keyword.
    //
    // "When **I** hold" is the positional reading Ahri - Alluring, the Guardian
    // and Ornn all take: the battlefield held has to be the one the Promoter is
    // standing at, not merely one his controller held somewhere.
    //
    // # "ALL UNITS", with no owner — and the two readings coincide today
    //
    // 426.3 formats the Buff action as "Buff [one or more units]" and gives
    // "Buff a unit." and "Buff a FRIENDLY unit." as separate examples, so the
    // owner clause is written when it is meant and this card does not write one.
    // Taken literally, then: every unit at that location, either side's.
    //
    // It is unobservable in this engine and probably in the rules. A hold is
    // 469.2's "maintains Control", which `scoring.isHeldBy` reads as presence with
    // NO opponent units there — so an enemy unit at a battlefield you are holding
    // is not a board this trigger can fire on. Written literally anyway, because
    // the narrower version would be a silent guess that only shows up the day
    // something puts an enemy body there mid-window.
    //
    // # "HERE" is the battlefield HELD, fixed when the trigger fired
    //
    // 359.3.f.3 — "some information used by triggered abilities is referenced
    // from the TRIGGER CONDITION of the ability. This information is checked when
    // the trigger condition is fulfilled" — and 383.4.d puts the unit's presence
    // at the battlefield INSIDE a Hold Effect's condition ("Triggered Abilities
    // whose Condition includes a Unit being present at a Battlefield during the
    // Beginning phase when a player scores Victory Points from Holding"). The
    // rules' own hold example agrees: Iascylla's "this battlefield" "refers to the
    // battlefield she held, and so will be referenced from the trigger condition"
    // (359.3.f.3.b).
    //
    // So this is deliberately NOT `isStillHere`. Yasuo - Remorseful's "here" is
    // re-checked at execution because his condition is a DESIGNATION rather than a
    // presence — 359.3.f.2's worked example — and the two families must not be
    // confused. A Promoter killed in the response window still buffs the units he
    // was standing with.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      // Per unit, in board order. `addBuff` is 426.1.b.1's no-op on an
      // already-buffed unit — which is what the card's own reminder text ("give
      // each a +1 Might buff IF IT DOESN'T HAVE ONE") is describing — and it
      // raises one `unitBuffed` event per buff actually placed, which is right
      // rather than a batch double-pay: Simian Ancestor's "when you buff ME" is a
      // question about one unit, so N units buffed is N distinct moments.
      return unitsAt(state, event.battlefieldId).reduce((next, id) => addBuff(next, id), state);
    },
  },
  "UNL-048": {
    // Trevor Snoozebottom — "[Shield] When I hold, play a ready 3 Might Sprite
    // unit token with [Temporary] here."
    //
    // Only the sentence. `[Shield]` is printed and real (effective-might reads it
    // for the defending side), and re-granting it here would be the double-pay
    // the per-keyword summing (807.2/809.2/814.2/823.2) makes observable.
    //
    // **His `[Temporary]` is the TOKEN's, not his**, and that distinction is
    // already load-bearing in the loader: `card-loader.GRANTED_ONLY_KEYWORDS` has
    // a `"UNL-048": ["Temporary"]` entry precisely so that
    // `turn-manager.killTemporaryPermanents` does not destroy Trevor himself every
    // Beginning Phase. The keyword goes on the token, via `SPRITE_TOKEN`.
    //
    // "When **I** hold" and "HERE" are read exactly as the Promoter's above:
    // positional trigger, and a battlefield referent taken from the TRIGGER
    // CONDITION (359.3.f.3, 383.4.d, and the Iascylla hold example in
    // 359.3.f.3.b) rather than re-checked at execution.
    //
    // `placeToken`, not a hand-rolled push, so the arrival applies Contested
    // (190.3.a) if it ever lands somewhere its controller does not control. It
    // cannot today — you only hold what you control — but the helper is the one
    // place that decision belongs.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "battlefieldHeld"
        ? placeToken(state, listener.ownerIndex, { battlefieldId: event.battlefieldId }, SPRITE_TOKEN)
        : state,
  },
  "UNL-051": {
    // Ivern - Nurturer's SECOND moment — "or when I hold". His on-play half is in
    // `unitTriggers`; both call `ivernLook`, so there is one copy of the ability.
    //
    // "When **I** hold" is positional, the reading Ahri - Alluring, Ornn and the
    // Enthusiastic Promoter all take: the battlefield held must be the one Ivern is
    // standing at, not merely one his controller held somewhere. Settled at fire
    // time, so the response window this opens cannot be used to walk him off it.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? ivernLook(state, listener.ownerIndex) : state),
  },
  "UNL-052": {
    // Nami - Headstrong's THIRD sentence — "When I hold, the next time you play a
    // unit this turn, ready it and [Buff] it."
    //
    // # A Delayed Trigger (390.2), armed by a hold and spent by the next unit
    //
    // Two moments in one definition, which is what `on` being a list is for: the
    // hold ARMS, the play SPENDS. The alternative — a `PlayerState` flag — is a
    // field in `model/game-state.ts`, and none of the existing per-turn counters
    // means this: `nextUnitsEnterReady` is Sun Disc's, and it is a REPLACEMENT
    // ("enters ready") rather than a readying, so it fires no `unitReadied` and
    // could not carry the buff either.
    //
    // The arm is recorded on NAMI'S OWN INSTANCE through `recordModeUsed`, the
    // field the modal activated abilities already use. It is per-instance (two
    // Namis arm separately, which is right — each holds for herself), and
    // `turn-manager`'s runEnd clears it for every unit on both sides, which is
    // exactly the "this turn" window the card prints. Nami has no activated
    // ability, so nothing else reads her mode record.
    //
    // **DIVERGENCE, and it is the price of that carrier.** 391 makes a Delayed
    // Trigger resolve "just like the ability they augment, but only during the
    // specified time", and this one references neither its source nor an object it
    // affected — so it is a plain Delayed Trigger and NOT one of 390.5's Delayed
    // Linked Abilities, whose window is tied to the source's zone. By the rules it
    // should still fire if Nami dies after holding; here the arm dies with her,
    // because it is stored on her. Pinned by a test that asserts the wrong answer.
    //
    // "The NEXT time", so it is spent once: `"UNL-052-spent"` is recorded as it
    // fires and `applies` refuses afterwards. Spending at RESOLUTION rather than at
    // fire time is safe for the reason the chain gives — a `cardPlayed` trigger is
    // held (383), and while a Chain Pending Item is up the turn is in a Closed
    // State (310), where a Unit cannot be played at all. So no second unit can slip
    // between the fire and the spend.
    //
    // "You play A UNIT" — any unit of yours, including another Nami. Nothing
    // excludes the source, and there is nothing to exclude: she is already in play.
    on: ["battlefieldHeld", "cardPlayed"],
    applies: (state, listener, event) => {
      if (event.kind === "battlefieldHeld") {
        // Positional, like every other "when I hold" in this file.
        return event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId;
      }
      if (event.kind !== "cardPlayed" || event.casterIndex !== listener.ownerIndex || event.playedKind !== "Unit") {
        return false;
      }
      return namiArmed(state, listener);
    },
    resolve: (state, listener, event) => {
      if (event.kind === "battlefieldHeld") return recordModeUsed(state, listener.ownerIndex, listener.card.instanceId, NAMI_ARMED);
      if (event.kind !== "cardPlayed" || !namiArmed(state, listener)) return state;
      // Re-checked here as well as in `applies`: the response window between the
      // two can have brought a second copy of this trigger to resolution first, and
      // "the next time" is one unit however many Pending Items exist.
      const spent = recordModeUsed(state, listener.ownerIndex, listener.card.instanceId, NAMI_SPENT);
      // Ready THEN buff, the order the card prints. `readyUnit` refuses a unit that
      // is already ready (415), so a unit that entered ready under Confront simply
      // gets the buff — no `unitReadied` event for a readying that did not happen.
      return addBuff(readyUnit(spent, event.playedInstanceId), event.playedInstanceId);
    },
  },
  "UNL-055": {
    // Vex - Mocking — "When you [Stun] an enemy unit at a battlefield, you may move
    // me to that battlefield."
    //
    // `[Shield]` and `[Tank]` are keywords and need nothing here.
    //
    // # Per stunned unit, not per instruction — and that is why `captureEach`
    //
    // "AN enemy unit", singular, so this is Eclipse Herald's reading rather than
    // Leona - Radiant Dawn's "one or more": one triggered ability per qualifying
    // unit. `unitsStunned` is a BATCH event (one per instruction, so that Leona
    // does not pay twice), which means the per-unit fan-out has to happen here —
    // `captureEach` places one Pending Item per value, exactly as Ahri -
    // Nine-Tailed Fox does for a multi-unit attack designation.
    //
    // Each item carries its OWN battlefield id, which is the whole reason capture
    // is needed at all: "THAT battlefield" is the one the stunned unit was standing
    // at when the trigger fired (359.3.f.3 — information a trigger condition
    // references is checked when the condition is fulfilled), and the event does
    // not carry a location. Re-deriving it at resolution would follow a victim that
    // has since been moved, or lose the offer entirely if it died.
    //
    // "AT A BATTLEFIELD" is printed, so it is a real restriction (355.9.b): a unit
    // stunned in its owner's base fires nothing, since there would be no
    // battlefield for "that battlefield" to name.
    //
    // Both halves of "YOU ... ENEMY" are measured from Vex's controller, as the
    // Herald's are: her controller must be the stunner, and the victim must not be
    // theirs. Stunning your own unit does not walk Vex across the board.
    on: "unitsStunned",
    applies: (state, listener, event) => vexDestinations(state, listener, event).length > 0,
    captureEach: (state, listener, event) => vexDestinations(state, listener, event),
    resolve: (state, listener, _event, captured) => {
      if (typeof captured !== "string") return state;
      // "You MAY move me", so it is a question (402.1 puts the decision at
      // resolution for a triggered ability's leading "you may"). Asked only when
      // there is a move to make: 355.4.a excludes a unit's current Location, so a
      // Vex already standing there is offered nothing rather than offered a no-op.
      const here = findUnitAnywhere(state, listener.card.instanceId);
      if (!here) return state;
      if (here.zone !== "base" && state.battlefields[here.zone.battlefieldIndex]!.id === captured) return state;
      return parkDecision(state, {
        kind: "UNL-055-move",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: captured,
      });
    },
  },
  "UNL-056": {
    // Yuumi - Magical Cat — "When I attack or defend, give one of your other
    // units here +3 Might and [Tank] this turn."
    //
    // Her own printed `[Tank]` is the card frame's and needs nothing here.
    //
    // `isFightingAt` is the shared "attack OR defend" predicate (383.4.e and
    // 383.4.f are two rules, and this card asks for either). It carries the two
    // checks this entry would otherwise repeat: she must be a UNIT standing at
    // the battlefield the combat opened at, and she must be GAINING her
    // designation NOW — 383.4.e.2.a/f.2.a check the condition "only once per
    // combat", so a reinforcement arriving later fires the event again for
    // itself and not for her.
    //
    // **The candidate check is in `resolve`, NOT in `applies`, and that is the
    // rules reading rather than a convenience.** The trigger condition is "when
    // I attack or defend" and nothing else, so the ability triggers even with
    // nobody to give the buff to; the instruction is then simply ignored
    // (359.3.e.6, "Instructions that can't be followed ... are ignored"). Putting
    // the emptiness test in `applies` would be 383.4.e.2.b's "other requirements
    // besides attacking", which this card does not print. Ribbon Dancer's
    // "ANOTHER friendly unit" takes the same split one registry down.
    on: "combatBegan",
    applies: (state, listener, event) => isFightingAt(state, listener, event),
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      // "HERE" is a referent read from the ability's source (359.3.f.1) and
      // checked on EXECUTION of the instruction (359.3.f.2) — the rules' own
      // worked example being an opponent answering Yasuo - Remorseful's attack
      // trigger by moving him, after which "'here' is no longer the battlefield
      // where combat is ongoing and the attack trigger mistargets". A Yuumi
      // killed or bounced in the response window this hold opens therefore buffs
      // nobody, and the buff is never re-aimed at wherever she ended up. That
      // check lives inside `yuumiCandidates` so the fire-time question and the
      // answer-time option list cannot disagree about it.
      if (yuumiCandidates(state, listener.ownerIndex, listener.card.instanceId, event.battlefieldId).length === 0) {
        return state;
      }
      return parkDecision(state, {
        kind: "UNL-056-buff",
        playerIndex: listener.ownerIndex,
        // WHICH Yuumi — "OTHER" is an exclusion by object, so a second copy of
        // her at the same battlefield is a legal recipient for the first.
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "UNL-060": {
    // Vilemaw's third clause — "When I hold, draw 1."
    //
    // 383.4.d: a Hold Effect triggers off "a Unit being present at a Battlefield
    // during the Beginning phase when a player scores Victory Points from
    // Holding", and 383.4.d.1 gives "When I hold..." as its printed form.
    // 383.4.d.2.a makes the ability the UNIT's, so "I" is positional — the
    // battlefield held has to be the one Vilemaw is standing at, not merely one
    // his controller held somewhere. Ahri - Alluring and Blitzcrank - Impassive
    // read their own "when I hold" the same way, one registry up.
    //
    // His other two clauses are NOT here, and both are now written. `[Ambush]` is
    // a keyword the loader carries, and "enemy units here with less Might than me
    // don't deal combat damage" is the `UNL-060` entry in `mightModifiers` at the
    // foot of this file — the seam that did not exist when the partial note on
    // this card was written, and which reaches `outgoingMight`'s arithmetic
    // without touching combat.ts. See that entry for the one divergence it keeps.
    on: "battlefieldHeld",
    // Both halves settled at fire time, as Ahri's are: the hold has happened and
    // the response window this opens is exactly when an opponent could move or
    // kill him, which must not cancel a draw already earned.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? drawCards(state, listener.ownerIndex, 1) : state),
  },
  "UNL-050": {
    // Iascylla — "When I hold, at the start of your next Main Phase, you may move
    // an enemy unit to this battlefield."
    //
    // # A DELAYED trigger written as an ordinary hold listener, and the rules say
    // the two land at the same moment here
    //
    // The printed ability is delayed, and this engine has no delayed-trigger queue
    // and no start-of-Main-Phase moment at all (`Phase` is Awaken/Beginning/
    // Channel/Draw/Action; 316's Main Phase IS the Action phase here). Blue
    // Sentinel (UNL-087, effects/mind.ts) already reached this conclusion for the
    // identical clause shape and its note carries the argument; the short version
    // is that a `battlefieldHeld` trigger is HELD (383), and `submit`'s Pass runs
    // Awaken/Beginning/Channel/Draw as ONE action with a single Cleanup that
    // finalizes pending triggers at the END of it — by which time `phase` is
    // already "Action". So this resolves as the first thing in the controller's
    // Main Phase, before they can take a Discretionary Action, which is 316.4's
    // "at the start of Main Phase game effects take place".
    //
    // The "NEXT" costs nothing extra: a hold scores in the controller's own
    // Beginning Phase (383.4.d), so their next Main Phase is this same turn's.
    //
    // **The one place the approximation is observable** is 316.3 — the Main Phase
    // begins by emptying every Rune Pool, and this engine empties pools only in
    // `runEnd`. Nothing this card does touches a pool, so the gap is unreachable
    // from here; it is named because it is the same gap Blue Sentinel records.
    //
    // # "This battlefield" is the one she HELD — and the rules work this card by name
    //
    // **359.3.f.3.b**, verbatim: *"Iascylla reads 'When I hold, at the start of
    // your next Main Phase, you may move an enemy unit to this battlefield.' The
    // 'this battlefield' in her delayed triggered ability refers to the battlefield
    // she held, and so will be referenced from the trigger condition, when the
    // triggered ability is generated."*
    //
    // So the destination is captured from the EVENT and is NOT re-derived from
    // where Iascylla is standing when the question is answered. That is the
    // opposite of Yuumi - Magical Cat's "other friendly units HERE" three entries
    // up, which `yuumiCandidates` guards with `isStillHere` under 359.3.f.2: hers
    // is a referent checked on execution, this one is fixed at generation. An
    // Iascylla killed or bounced in the response window this hold opens still drags
    // a body onto the battlefield she held.
    //
    // "When **I** hold" is positional all the same — 383.4.d.2.a makes the ability
    // the UNIT's, so the battlefield held has to be the one she is standing at when
    // it scores. Same reading as Ahri - Alluring's, Blitzcrank's and Vilemaw's.
    on: "battlefieldHeld",
    // `holderIndex === listener.ownerIndex` is REDUNDANT here and is kept for the
    // reason effects/mind.ts's Sumpworks Map keeps its equivalent: measured, then
    // labelled, rather than left implying it is load-bearing. `scoring.isHeldBy`
    // requires that NO opponent unit is at the battlefield, so a listener standing
    // at the one that just scored is necessarily the holder's — a mutation
    // deleting only this clause survived all 11 tests in
    // test/unl-calm-wave6.test.ts. It stays because it states the card's sentence
    // ("when **I** hold") and because the redundancy is a property of `isHeldBy`,
    // not of this file.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      // 055's do-as-much-as-you-can: with no enemy unit that could legally arrive,
      // there is no question worth parking. Asked through the same helper the
      // option list uses, so the fire-time check and the answers cannot disagree.
      //
      // **Also measured redundant, and also kept rather than quietly dropped.**
      // `parkDecision` calls `advanceDecisions`, which EXECUTES a one-option
      // question on the spot — so without this guard the "you may" would park,
      // auto-decline and vanish, which is observationally identical. Deleting this
      // line survived the whole suite. It is here so the trigger says what it does
      // rather than relying on a downstream collapse that is somebody else's
      // invariant.
      if (iascyllaCandidates(state, listener.ownerIndex, event.battlefieldId).length === 0) return state;
      return parkDecision(state, {
        kind: "UNL-050-drag",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.battlefieldId,
      });
    },
  },
};

/**
 * The enemy units Iascylla's delayed trigger may drag to the battlefield she
 * held — the opponent's units ANYWHERE, minus any already standing there.
 *
 * "AN ENEMY UNIT" carries no location word, so 355.9.a.1's bare-noun reading puts
 * a unit sitting in the opponent's base in reach, exactly as Blitzcrank -
 * Impassive's grab does.
 *
 * The exclusion is **355.4.a** — "A valid Location for a Move Effect is one other
 * than the Unit's current Location" — so a unit already at that battlefield has no
 * move to make and must not be offered one. `forceMoveToBattlefield` already
 * returns the state unchanged for that case, so this changes no outcome; what it
 * changes is that the player is never shown a button that does nothing, which is
 * the same reason `legal-actions`' destination fan-out skips the battlefield a
 * target is already at.
 *
 * One function for the fire-time "is there anybody to drag" check and for the
 * option list, the rule `yuumiCandidates` and `vexDestinations` follow above.
 */
function iascyllaCandidates(state: GameState, ownerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const enemyIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
  const alreadyHere = new Set(
    (state.battlefields.find((bf) => bf.id === battlefieldId)?.units[state.players[enemyIndex].id] ?? []).map((u) => u.instanceId),
  );
  return ownUnitsEverywhere(state, enemyIndex).filter((u) => !alreadyHere.has(u.instanceId));
}

/** Yuumi - Magical Cat's "+3 Might and [Tank] this turn" — printed values, named
 *  because each appears in her trigger's prose and in the decision that lands
 *  them. */
const YUUMI_MIGHT = 3;

/**
 * The units Yuumi - Magical Cat may give her buff to — her controller's OTHER
 * units at the battlefield the combat opened at.
 *
 * One function for the fire-time "is there anybody to give it to" check, for the
 * option list and for the answer-time guard, the same one-walk rule
 * `ribbonDancerCandidates` and `vexDestinations` follow: an ability must not be
 * able to trigger on one set and then buff something outside it.
 *
 * **Returns nothing once Yuumi herself has left**, which is 359.3.f.2's referent
 * check rather than a tidiness rule — see her trigger.
 *
 * "OTHER" is an exclusion by OBJECT, not by card: a second Yuumi at the same
 * battlefield is a legal recipient for the first, exactly as `ownUnitAtLocation`
 * reads "other friendly units" for the keyword auras.
 */
function yuumiCandidates(state: GameState, ownerIndex: 0 | 1, selfInstanceId: string, battlefieldId: string): UnitInstance[] {
  if (!isStillHere(state, selfInstanceId, battlefieldId)) return [];
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return (bf?.units[state.players[ownerIndex].id] ?? []).filter((u) => u.instanceId !== selfInstanceId);
}

/** Nami - Headstrong's two marks on her own instance — "armed" by a hold,
 *  "spent" by the unit that consumed it. Named because both strings appear in
 *  three places each and a typo in one would arm a trigger nothing can spend. */
const NAMI_ARMED = "UNL-052-armed";
const NAMI_SPENT = "UNL-052-spent";

/** Is this Nami's delayed trigger live — armed by a hold this turn and not yet
 *  spent? Read from LIVE state rather than from `listener.card`, which is the
 *  snapshot the walk found her in and can predate the arming by a chain-pop. */
function namiArmed(state: GameState, listener: Listener): boolean {
  const found = findUnitAnywhere(state, listener.card.instanceId);
  const modes = found?.unit.abilityModesUsedThisTurn ?? [];
  return modes.includes(NAMI_ARMED) && !modes.includes(NAMI_SPENT);
}

/**
 * The battlefields Vex - Mocking may move to off one stunning — one entry per
 * ENEMY unit her controller just stunned AT a battlefield.
 *
 * One function for the `applies` predicate and for `captureEach`, the same rule
 * `aloneAt` and `enemiesStunnedFor` follow above: an ability must not be able to
 * trigger on one count and then capture a different one.
 *
 * Duplicates are kept rather than deduped. Two enemies stunned at one battlefield
 * is two triggered abilities by 359's per-unit reading, and each is a separate
 * response window; the second simply finds Vex already there and offers nothing,
 * which is where that collapse belongs.
 */
function vexDestinations(state: GameState, listener: Listener, event: GameEvent): string[] {
  if (event.kind !== "unitsStunned" || event.stunnerIndex !== listener.ownerIndex) return [];
  return event.stunned
    .filter((s) => s.ownerIndex !== listener.ownerIndex)
    .flatMap((s) => {
      const at = findUnitAnywhere(state, s.unitInstanceId);
      if (!at || at.zone === "base") return [];
      return [state.battlefields[at.zone.battlefieldIndex]!.id];
    });
}

/** Every unit standing at `battlefieldId`, BOTH players', by instance id — what
 *  Enthusiastic Promoter's unqualified "all units here" names. Ids rather than
 *  instances because the caller mutates the board between them, so an instance
 *  captured up front would be stale by the second buff. */
function unitsAt(state: GameState, battlefieldId: string): string[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  return Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId));
}

/** The units Ribbon Dancer's "give ANOTHER friendly unit" may name — hers,
 *  anywhere (355.9.a.1), minus herself. One function for the fire-time "is there
 *  anybody to give it to" check and for the option list, so the two cannot
 *  disagree about what "another" means. */
function ribbonDancerCandidates(state: GameState, ownerIndex: 0 | 1, selfInstanceId: string): UnitInstance[] {
  return ownUnitsEverywhere(state, ownerIndex).filter((u) => u.instanceId !== selfInstanceId);
}

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "SFD-046": {
    // Poro Snax's FIRST half — "When you play this, draw 1."
    //
    // A SELF-trigger for the reason Spirit's Refuge's below is: a Gear entering
    // play is not a moment the listener walk reaches on its own behalf.
    //
    // `"played"` only. Scrapheap takes all three moments because its text names
    // all three; this one names the play, and its OTHER draw is an activated
    // ability with its own printed cost (see activated-abilities.ts). Listing
    // `"killed"` here would pay that ability's draw twice — once from the
    // `killSelf` cost and once from this — for a card that prints one.
    on: ["played"],
    resolve: (state, event) => drawCards(state, event.ownerIndex, 1),
  },
  "OGN-063": {
    // Spirit's Refuge — "When you play this, buff a friendly unit."
    //
    // A SELF-trigger, like Forge of the Future (OGN-212): a Gear entering play is
    // not something the listener walk reaches for its own arrival. Gear has no
    // targeting of its own on the PlayCard action (no Gear is registered in
    // cardEffects, and the executor's Gear branch only moves it to activeGear),
    // so WHICH unit is buffed is asked as a decision — the same shape, and for
    // the same reason, as Vanguard Helm's "buff another friendly unit".
    //
    // The card's SECOND sentence — "Friendly buffed units have [Deflect] if they
    // didn't already" — is deliberately NOT written here. `[Deflect]` has no
    // implementation anywhere in the engine, so granting it would be a no-op
    // dressed up as an implementation; coverage.ts keeps the card honestly
    // reported as partial until the keyword lands.
    on: ["played"],
    resolve: (state, event) =>
      // "Do as much as you can" (055): with no friendly unit anywhere there is
      // nothing to buff, and a question with no answers must not be parked.
      ownUnitsEverywhere(state, event.ownerIndex).length === 0
        ? state
        : parkDecision(state, { kind: "OGN-063-buff", playerIndex: event.ownerIndex }),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** Aphelios - Exalted's "ready 2 runes" — the count is printed. */
const APHELIOS_READY_RUNES = 2;
/** His "channel 1 rune exhausted". */
const APHELIOS_CHANNEL_RUNES = 1;

/** The units among the top five that Reinforce could play — those whose printed
 *  Energy cost the card's 5-Energy reduction covers entirely. See the card's own
 *  note for why this is a threshold rather than a discount. */
function reinforceCandidates(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].deck
    .slice(0, 5)
    .filter((c) => c.kind === "Unit" && c.energyCost <= 5);
}

/** The one option left when the Hourglass has gone between the question being
 *  raised and answered — not a unit's instanceId, so it can never collide with a
 *  candidate. */
const NO_HOURGLASS = "no-hourglass";

/** The deaths an Hourglass question is choosing between, in the order the batch
 *  collected them, skipping any that have since been settled. */
function heldHourglassDeaths(state: GameState, d: PendingDecision): PendingDeath[] {
  return (d.cardInstanceIds ?? [])
    .map((id) => pendingDeathFor(state, id))
    .filter((death): death is PendingDeath => death !== undefined);
}

export const decisions: Record<string, DecisionDefinition> = {
  [HOURGLASS_SAVE]: {
    // **Zhonya's Hourglass (OGN-077) — "If a friendly unit would die, kill this
    // instead. Heal that unit, exhaust it, and recall it."**
    //
    // The question is WHICH death to spend it on, not whether — **373**, whose
    // worked example is this card by name: "Two units controlled by the same
    // player die in the same cleanup. That player also controls Zhonya's
    // Hourglass. They must decide which event to apply Zhonya's Hourglass to
    // first."
    //
    // Reported from playtesting: "i think i should be able to choose which unit
    // gets saved if multiple units die at the same time with the hourglass gear."
    // The engine spent it on whichever death the kill loop reached first.
    // **There is no "decline" option, and that is the card**: its text prints no
    // "you may", so 373 hands the controller the ORDER, not a veto. With one
    // Hourglass — spent by the first application — "which order do I apply them
    // in" and "which one gets it" are the same question, so it is asked once per
    // batch with one option per dying unit.
    prompt: () => "Zhonya's Hourglass: which unit does it save?",
    options: (state, d) => {
      const held = heldHourglassDeaths(state, d);
      if (held.length === 0) return [];
      // **The batch can have killed the Hourglass itself**, and that is
      // reachable rather than defensive: Bottled Constellation's cost eats
      // friendly UNITS and GEAR in one sweep, so the gear can be fodder for the
      // very deaths it was collected to replace. There is then nothing to spend
      // and nothing to ask — one option, which `advanceDecisions` retires without
      // prompting, and which exists at all so the held deaths are RELEASED rather
      // than stranded in the pen by a question that returned no options.
      if (!hasHourglass(state, d.playerIndex)) {
        return [{ id: NO_HOURGLASS, label: "The Hourglass is already gone — they die" }];
      }
      return held.map((death) => ({
        id: death.unit.instanceId,
        label: `Kill the Hourglass: heal, exhaust and recall ${death.unit.name}`,
      }));
    },
    resolve: (state, d, optionId) => {
      const held = heldHourglassDeaths(state, d);
      const chosen = held.find((death) => death.unit.instanceId === optionId);

      // The save FIRST, so every other death in the batch then finds the gear
      // already spent — 370.2, "a Replacement Effect can only be applied once to
      // an event".
      let next = state;
      if (chosen) {
        const saved = applyHourglass(releasePendingDeath(next, chosen.unit.instanceId), chosen.unit, chosen.ownerIndex);
        // `undefined` only if the gear vanished between `options` and here, which
        // nothing can do today — a decision blocks every other action (320.1).
        // Letting it die is the same fallback the Armory's "the Fury has gone
        // since the offer" branch takes.
        next = saved ?? resumeDeathAfterHourglass(releasePendingDeath(next, chosen.unit.instanceId), chosen);
      }
      for (const death of held) {
        if (death === chosen) continue;
        next = resumeDeathAfterHourglass(releasePendingDeath(next, death.unit.instanceId), death);
      }
      return next;
    },
  },
  /**
   * Void Hatchling's look, before Apprentice Smith's reveal — "look at the top
   * card first. You may recycle it. Then reveal those cards."
   *
   * Registered under the SITE's defId rather than the Hatchling's, which is what
   * the `<defId>-<what it asks>` convention means here: the question is his, and
   * the CONTINUATION is the Smith's. The Hatchling's own coverage claim lives in
   * `top-of-deck.topOfDeckDefIds`, beside Nocturne's and for the same reason.
   */
  "SFD-041-reveal": {
    prompt: () => "Void Hatchling: recycle the top card before Apprentice Smith reveals it?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) =>
      apprenticeSmithReveal(voidHatchlingAnswer(state, d.playerIndex, optionId), d.playerIndex),
  },

  "SFD-049-mode": {
    // Aphelios - Exalted's "choose one that hasn't been chosen this turn".
    //
    // No decline: the card prints "choose one", not "you may". `advanceDecisions`
    // auto-resolves a one-option question, so with two modes already spent the
    // third simply happens — which is right, and is why the trigger checks that
    // at least one is LEFT rather than leaving a zero-option question to be
    // dropped silently.
    prompt: () => "Aphelios - Exalted: choose a mode not yet chosen this turn",
    options: (state, d) =>
      d.cardInstanceId === undefined
        ? []
        : apheliosModesLeft(state, d.playerIndex, d.cardInstanceId).map((m) => ({ id: m.id, label: m.label })),
    resolve: (state, d, optionId) => {
      if (d.cardInstanceId === undefined) return state;
      // Re-derived at ANSWER time: the question waits on the chain, and in that
      // window another Equipment can land and spend the very mode being named.
      if (!apheliosModesLeft(state, d.playerIndex, d.cardInstanceId).some((m) => m.id === optionId)) return state;
      // Recorded BEFORE the effect, so a mode is spent even when its effect does
      // nothing — an empty rune deck channels nothing (315.3.b.1) and the choice
      // was still made. The same reading `execute-activate-ability` takes, whose
      // own comment names "a mode whose effect ends up doing nothing".
      const spent = recordModeUsed(state, d.playerIndex, d.cardInstanceId, optionId);
      if (optionId === "ready") return readyRunes(spent, d.playerIndex, APHELIOS_READY_RUNES);
      if (optionId === "channel") return channelRunesExhausted(spent, d.playerIndex, APHELIOS_CHANNEL_RUNES);
      // "Buff a FRIENDLY unit" — WHICH one is a second question, asked the same
      // way Spirit's Refuge's is. Dropped whole with no friendly unit on the
      // board, rather than offered as a lone decline.
      return ownUnitsEverywhere(spent, d.playerIndex).length === 0
        ? spent
        : parkDecision(spent, { kind: "SFD-049-buff", playerIndex: d.playerIndex });
    },
  },
  "SFD-049-buff": {
    // The target half of Aphelios's third mode.
    prompt: () => "Aphelios - Exalted: buff which friendly unit?",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({
        id: u.instanceId,
        label: `Buff ${u.name}`,
        instanceId: u.instanceId,
      })),
    // Already-buffed units stay on offer: 702.3.a makes a second buff a no-op rather
    // than an illegal choice, and filtering them would quietly rewrite "a
    // friendly unit" as "an UNBUFFED friendly unit".
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
  /**
   * Mystic Reversal's "you may make new choices for it" — see her effect above
   * for what is and is not re-offered.
   *
   * The candidates are rebuilt from the STOLEN spell's own spec against LIVE
   * state, not from whatever was legal when it was announced: the board has
   * moved on (that is why the Reversal was cast), and a re-choice has to be one
   * the spell could make now.
   */
  "OGN-080-retarget": {
    prompt: (state, d) => {
      const stolen = d.cardInstanceId ? spellOnChain(state, d.cardInstanceId) : undefined;
      return `Mystic Reversal: make new choices for ${stolen?.entry.card.name ?? "the stolen spell"}?`;
    },
    options: (state, d) => {
      if (!d.cardInstanceId) return [];
      const candidates = retargetCandidates(state, d.playerIndex, d.cardInstanceId);
      if (candidates.length === 0) return [];
      // "You MAY" — keeping the original choice leads, as everywhere else.
      return [
        { id: "keep", label: "Keep its original choices" },
        ...candidates.map((u) => ({ id: u.instanceId, label: `Re-aim at ${u.name}`, instanceId: u.instanceId })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "keep" || !d.cardInstanceId) return state;
      const stolen = spellOnChain(state, d.cardInstanceId);
      if (!stolen) return state;
      const spellChain = [...state.spellChain];
      spellChain[stolen.index] = { ...stolen.entry, targetUnitInstanceId: optionId };
      return { ...state, spellChain };
    },
  },
  // Reinforce's "you may banish a unit from among them, then play it".
  //
  // Declining leads, as everywhere else. The recycle happens either way — "recycle
  // the remaining cards" is a separate instruction from the banish-and-play, the
  // same structure Baited Hook has.
  "OGN-062-banish": {
    prompt: () => "Reinforce: banish a unit from the top 5 and play it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...reinforceCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      const top5 = state.players[d.playerIndex].deck.slice(0, 5);
      const chosen = optionId === "decline" ? undefined : reinforceCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);

      // Recycle FIRST, so the deck arithmetic is done against the five that were
      // actually looked at — whatever was banished-and-played is simply not among
      // them. Baited Hook's decision makes the same call.
      const rest = top5.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(top5.length), ...rest],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one — `rest` is what actually moved.
      const recycled = holdCardsRecycled({ ...state, players }, d.playerIndex, rest.length);
      return chosen ? playCardIgnoringCost(recycled, d.playerIndex, chosen) : recycled;
    },
  },
  // Blitzcrank - Impassive's "you may move an enemy unit to here", raised by his
  // on-play trigger, which has already established that he was played TO a
  // battlefield and that some enemy unit exists.
  //
  // "AN ENEMY UNIT" carries no location word, so 355.9.a.1's bare-noun reading
  // applies and a unit sitting in the opponent's base is a legal grab — which is
  // the interesting half of the card, since dragging a defender out of a
  // battlefield they were holding is something Charm already does.
  //
  // Declining is always available and listed FIRST, so a mis-click and the AI's
  // tie-break both land on doing nothing. That default is the right way round
  // here: the grab contests Blitzcrank's own battlefield and can cost the hold
  // his third clause is built around.
  "OGN-067-grab": {
    prompt: () => "Blitzcrank - Impassive: move an enemy unit to his battlefield?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).map((u) => ({
        id: u.instanceId,
        label: `Move ${u.name} here`,
        instanceId: u.instanceId,
      })),
    ],
    resolve: (state, d, optionId) =>
      optionId === "decline" || !d.battlefieldId ? state : forceMoveToBattlefield(state, optionId, d.battlefieldId),
  },
  // Iascylla's "you may move an enemy unit to this battlefield", raised by her
  // hold trigger, which has already fixed WHICH battlefield (359.3.f.3.b names
  // this card) and established that some enemy unit could legally arrive.
  //
  // Rebuilt from live state like every decision here, so an enemy unit killed in
  // the response window is not on offer and one that walked in during it is —
  // `iascyllaCandidates` is the same walk the trigger used to decide whether to
  // ask at all.
  //
  // Declining is listed FIRST, matching Blitzcrank's grab above: dragging a body
  // onto a battlefield you are holding contests it, and `answerDecisions` in the
  // test fixtures defaults to the first option, so the harmless answer is the
  // default rather than the aggressive one.
  //
  // `causedByIndex` is Iascylla's controller and NOT the moved unit's — the unit
  // moving is the opponent's, so `unitMoved.moverIndex` will read as the enemy
  // seat. "When YOU move an enemy unit" (UNL-133's refused clause) can only ever
  // be answered off this field, and a mover that omits it silently claims the move
  // was the opponent's own. Blitzcrank's grab omits it; that is a gap in his entry
  // rather than a convention to copy.
  "UNL-050-drag": {
    prompt: () => "Iascylla: move an enemy unit to the battlefield she held?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(d.battlefieldId === undefined ? [] : iascyllaCandidates(state, d.playerIndex, d.battlefieldId)).map((u) => ({
        id: u.instanceId,
        label: `Move ${u.name} here`,
        instanceId: u.instanceId,
      })),
    ],
    resolve: (state, d, optionId) =>
      optionId === "decline" || !d.battlefieldId ? state : forceMoveToBattlefield(state, optionId, d.battlefieldId, d.playerIndex),
  },
  // Spirit's Refuge's "buff a friendly unit", raised by its on-play self-trigger.
  //
  // "A friendly unit" carries no location word, so base and battlefield are both
  // eligible — 355.9.a.1's bare-noun reading, the same one Vanguard Helm's
  // equivalent question takes. Already-buffed units stay on offer: 702.3.a makes a
  // second buff a no-op rather than an illegal choice, and filtering them would
  // quietly rewrite the card as "an UNBUFFED friendly unit".
  "OGN-063-buff": {
    prompt: () => "Spirit's Refuge: buff a friendly unit",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
  // Party Favors' "Cards or Runes", answered by the OPPONENT.
  //
  // Both options always offered, even when a pool is empty: choosing Runes with
  // an empty rune deck is a legal way to give the caster nothing, and filtering
  // it out would quietly turn a Group Hug into a card the opponent cannot use
  // defensively. drawCards and channelRunesExhausted both take what they can.
  //
  // `d.playerIndex` is the CHOOSER (the opponent); the caster is the other seat,
  // and both are paid.
  "OGN-071-choose": {
    prompt: () => "Party Favors: choose Cards or Runes — you and the caster each get it",
    options: () => [
      { id: "cards", label: "Cards (you both draw 1)" },
      { id: "runes", label: "Runes (you both channel 1 exhausted)" },
    ],
    resolve: (state, d, optionId) => {
      const chooser = d.playerIndex;
      const caster: 0 | 1 = chooser === 0 ? 1 : 0;
      const both = [caster, chooser] as const;
      return optionId === "cards"
        ? both.reduce((next, i) => drawCards(next, i, 1), state)
        : both.reduce((next, i) => channelRunesExhausted(next, i, 1), state);
    },
  },

  // Solari Shrine's "you may exhaust this to draw 1" — raised by its death-watch
  // in engine/triggers.ts, which has already checked that the kill was yours,
  // the victim was a stunned enemy, and the Shrine is still ready.
  //
  // Two options always, so `advanceDecisions` can never auto-resolve it: a "you
  // may" that the engine answers for you is not a "you may". Declining is a real
  // play — the Shrine's exhaust is worth keeping when a second stunned enemy is
  // about to die this turn.
  "OGN-072-draw": {
    prompt: () => "Solari Shrine: exhaust it to draw 1?",
    // No `instanceId` on either option, deliberately. The board renders an
    // option that carries one as the CARD itself, which is right for "pick one
    // of your units" and wrong here: this is a yes/no, and half a card next to
    // half a button reads as two different kinds of choice. The prompt already
    // names the Shrine.
    options: () => [
      { id: "draw", label: "Exhaust and draw 1" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "draw" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then draw: the exhaust is the cost, and exhaustGear
      // no-ops on a Shrine that is somehow already spent — so a state where the
      // cost cannot be paid must not hand over the draw.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : drawCards(paid, d.playerIndex, 1);
    },
  },

  // Adaptatron's "you may kill a gear. If you do, buff me." — raised by its
  // on-conquer trigger, which has already checked that the conquest was its
  // controller's and that it was standing at the battlefield taken.
  //
  // BOTH players' gear is offered, because the card names no owner. Killing your
  // own is a real play in this pool (Treasure Trove and Scrapheap pay out when
  // they die), so filtering to the opponent's would quietly rewrite the card.
  "OGN-056-kill": {
    prompt: () => "Adaptatron: kill a gear to buff me?",
    options: (state) => {
      // Decline first, so a mis-click and the AI's tie-break both land on doing
      // nothing — the same ordering Flame Chompers' "you may" uses. Two options
      // minimum whenever there is any gear, which is what stops `advanceDecisions`
      // answering a "you may" on the player's behalf.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const index of [0, 1] as const) {
        for (const gear of state.players[index].activeGear) {
          options.push({ id: gear.instanceId, label: gear.name, instanceId: gear.instanceId });
        }
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const ownerIndex = ([0, 1] as const).find((i) => state.players[i].activeGear.some((g) => g.instanceId === optionId));
      if (ownerIndex === undefined) return state;
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === optionId)!;
      const killed = killGear(state, gear, ownerIndex);
      // "IF YOU DO" — the buff is conditional on the kill actually happening, so
      // it hangs off killGear having moved the board rather than off the answer.
      if (killed === state) return state;
      // `addBuff` no-ops if the Adaptatron has left play in the meantime, which
      // is the usual "target vanished" convention rather than a special case.
      return d.cardInstanceId ? addBuff(killed, d.cardInstanceId) : killed;
    },
  },

  // Disarming Rake's "you may kill a gear", raised by its on-play trigger, which
  // has already established that some gear exists.
  //
  // BOTH players' gear, because the card names no owner — the same reading, and
  // the same `killGear` funnel (so a dying gear's own trigger fires), that
  // Adaptatron's question above takes. Decline leads, so a mis-click and the
  // AI's tie-break both land on doing nothing.
  "SFD-032-kill": {
    prompt: () => "Disarming Rake: kill a gear?",
    options: (state) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const index of [0, 1] as const) {
        for (const gear of state.players[index].activeGear) {
          options.push({ id: gear.instanceId, label: gear.name, instanceId: gear.instanceId });
        }
      }
      return options;
    },
    resolve: (state, _d, optionId) => {
      if (optionId === "decline") return state;
      const ownerIndex = ([0, 1] as const).find((i) => state.players[i].activeGear.some((g) => g.instanceId === optionId));
      if (ownerIndex === undefined) return state; // it died while the question waited
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === optionId)!;
      return killGear(state, gear, ownerIndex);
    },
  },

  // Royal Entourage's "ready or exhaust a legend".
  //
  // ONE option per legend rather than four, because a legend is either ready or
  // exhausted and only one of the two verbs would do anything to it. That is
  // also what guarantees two options on every board, which is what stops
  // `advanceDecisions` answering a real choice on the player's behalf.
  //
  // The direction is encoded in the option id rather than re-derived when the
  // answer arrives: a legend readied by something else while this question waited
  // must not turn "ready theirs" into "exhaust theirs".
  //
  // No `instanceId` on the options, deliberately — the board renders an option
  // carrying one as the CARD itself, and a Legend sits in its own zone rather
  // than among the permanents the board lays out. Same call the Solari Shrine's
  // yes/no makes; the labels name the legends.
  "SFD-039-legend": {
    prompt: () => "Royal Entourage: ready or exhaust a legend",
    options: (state) =>
      ([0, 1] as const).map((i) =>
        state.players[i].legend.exhausted
          ? { id: `${i}-ready`, label: `Ready ${state.players[i].legend.name}` }
          : { id: `${i}-exhaust`, label: `Exhaust ${state.players[i].legend.name}` },
      ),
    resolve: (state, _d, optionId) => {
      const index = Number(optionId.slice(0, 1));
      if (index !== 0 && index !== 1) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[index] = {
        ...players[index],
        legend: { ...players[index].legend, exhausted: optionId.endsWith("exhaust") },
      };
      return { ...state, players };
    },
  },

  // Guardian of the Passage's "you may return a unit or gear from your trash to
  // your hand", raised by his on-hold trigger.
  //
  // A SPELL in the trash is not on offer — the card lists two kinds and stops
  // there, which is the whole restriction (recurring a counterspell every turn
  // would be a different card).
  //
  // Decline leads. Rebuilt from live state rather than stored on the decision,
  // so a card that left the trash while this waited is simply not listed.
  "SFD-035-return": {
    prompt: () => "Guardian of the Passage: return a unit or gear from your trash to your hand?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...trashUnitsAndGear(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : returnCardFromTrash(state, d.playerIndex, optionId)),
  },

  // Ribbon Dancer's "give ANOTHER friendly unit +1 Might this turn", raised by
  // her own move trigger, which has already established that another friendly
  // unit exists.
  //
  // NO decline option: the card carries no "you may", so once it has triggered
  // the Might has to land somewhere. With exactly one candidate that makes this a
  // single option and `advanceDecisions` executes it without a prompt, which is
  // right — there is no choice to make.
  "SFD-038-might": {
    prompt: () => "Ribbon Dancer: give another friendly unit +1 Might this turn",
    options: (state, d) =>
      ribbonDancerCandidates(state, d.playerIndex, d.cardInstanceId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => giveMightThisTurnToOwnUnit(state, d.playerIndex, optionId, 1),
  },

  // Janna - Savior's "move up to one enemy unit from here to its base", raised by
  // her on-play trigger, which has already established that she landed at a
  // battlefield and that an enemy unit is standing there.
  //
  // "FROM HERE" is `d.battlefieldId`, captured when the question was raised: it
  // means where she landed, not wherever she is by the time the answer arrives.
  // Candidates are re-read from that battlefield against live state, so a unit
  // that has since left is not on offer.
  //
  // `recallUnitToBase`, the same helper Emperor's Divide uses above: "move ... to
  // its base" is a Move (454), so the unit arrives exhausted and Vilemaw's Lair
  // can refuse it.
  "SFD-053-move": {
    prompt: () => "Janna - Savior: move an enemy unit here to its base?",
    options: (state, d) => {
      const enemyId = state.players[d.playerIndex === 0 ? 1 : 0].id;
      const bf = state.battlefields.find((b) => b.id === d.battlefieldId);
      return [
        { id: "decline", label: "Decline" },
        ...(bf?.units[enemyId] ?? []).map((u) => ({ id: u.instanceId, label: `Move ${u.name} home`, instanceId: u.instanceId })),
      ];
    },
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : recallUnitToBase(state, optionId)),
  },

  // Ornn - Blacksmith's "you may reveal a gear from among them and draw it. Then
  // recycle the rest."
  //
  // Only GEAR among the top 4 is offered — the card names the kind, so a unit on
  // top is never a choice however much you want it.
  //
  // "THEN RECYCLE THE REST" happens either way, which is why the decline branch
  // is not a no-op: it is a separate instruction from the reveal-and-draw, the
  // same structure Reinforce and Baited Hook have. With no gear among the four
  // this is a single option and `advanceDecisions` executes it unprompted, which
  // is correct — the recycle is mandatory and there was nothing to decide.
  //
  // Re-slices the top 4 at ANSWER time rather than trusting a stored list, so a
  // deck that has moved on cannot smuggle a card from deeper in it into hand:
  // `takeOneFromTopAndRecycleRest` refuses an id that is no longer up there.
  "SFD-058-gear": {
    prompt: () => "Ornn - Blacksmith: reveal a gear from the top 4 and draw it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].deck
        .slice(0, 4)
        .filter((c) => c.kind === "Gear")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "decline") return takeOneFromTopAndRecycleRest(state, d.playerIndex, 4, optionId);
      const looked = state.players[d.playerIndex].deck.slice(0, 4);
      if (looked.length === 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(looked.length), ...looked],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length);
    },
  },

  // Double Trouble's "you may reveal a unit from among them and draw it. Recycle
  // the rest."
  //
  // Ornn - Blacksmith's question above with the kind filter changed, and the
  // three readings it makes are his: only UNITS among the top 3 are offered (the
  // card names the kind, so a gear on top is never a choice); "recycle the rest"
  // happens either way, which is why the decline branch is not a no-op; and the
  // top 3 are re-sliced at ANSWER time rather than trusted from a stored list, so
  // a deck that has moved on — under `[Repeat]`'s second execution, or under any
  // question queued ahead of this one — cannot smuggle a card from deeper in.
  //
  // With no unit among the three this is a single option and `advanceDecisions`
  // executes it unprompted, which is right: the recycle is mandatory and there
  // was nothing to decide.
  "UNL-032-unit": {
    prompt: () => "Double Trouble: reveal a unit from the top 3 and draw it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].deck
        .slice(0, DOUBLE_TROUBLE_LOOK)
        .filter((c) => c.kind === "Unit")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "decline") return takeOneFromTopAndRecycleRest(state, d.playerIndex, DOUBLE_TROUBLE_LOOK, optionId);
      const looked = state.players[d.playerIndex].deck.slice(0, DOUBLE_TROUBLE_LOOK);
      if (looked.length === 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(looked.length), ...looked],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length);
    },
  },

  // Ivern - Nurturer's "you may reveal a unit from among them and draw it.
  // Recycle the rest. Then if you revealed a Bird, Cat, Dog, or Poro, do this:
  // [Buff] a friendly unit."
  //
  // Double Trouble's question with a tail, and the three readings it inherits are
  // Ornn's: only UNITS are offered, "recycle the rest" happens on both branches,
  // and the top 3 are re-sliced at ANSWER time so a deck that has moved on cannot
  // smuggle a card up from deeper in.
  //
  // # The tail is gated on what was REVEALED, not on what is in hand
  //
  // "THEN IF you revealed" — so declining reveals nothing and buffs nothing, and
  // the tags are read off the card that was chosen while it is still identifiable.
  // Read BEFORE the draw, because `takeOneFromTopAndRecycleRest` moves it into a
  // hand where a second copy of the same card would be indistinguishable.
  //
  // The four tags are `FRIENDSHIP_TAGS`, shared with Friendship (UNL-026's
  // neighbour in this file) — the same four printed nouns, so one list. Ivern asks
  // a different QUESTION of them ("did the revealed card carry any") than
  // Friendship does ("how many distinct ones are on your board"), which is why
  // only the list is shared and not `friendshipTagCount`.
  "UNL-051-reveal": {
    prompt: () => "Ivern - Nurturer: reveal a unit from the top 3 and draw it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].deck
        .slice(0, IVERN_LOOK)
        .filter((c) => c.kind === "Unit")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      const looked = state.players[d.playerIndex].deck.slice(0, IVERN_LOOK);
      if (optionId === "decline") {
        if (looked.length === 0) return state;
        const players = [...state.players] as [PlayerState, PlayerState];
        players[d.playerIndex] = {
          ...players[d.playerIndex],
          deck: [...players[d.playerIndex].deck.slice(looked.length), ...looked],
        };
        // Karma - Channeler watches every recycle in this engine, including the
        // ones written inline like this one.
        return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length);
      }
      // Narrowed to a Unit before its tags are read — only Units are on offer, and
      // `CardInstance` is a union in which a Legend has no `tags` at all.
      const revealed = looked.find((c) => c.instanceId === optionId);
      const tagged =
        revealed?.kind === "Unit" && FRIENDSHIP_TAGS.some((tag) => (revealed.tags ?? []).includes(tag));
      const drawn = takeOneFromTopAndRecycleRest(state, d.playerIndex, IVERN_LOOK, optionId);
      // Parked rather than resolved inline: "[Buff] a friendly unit" is a choice
      // and the engine cannot pause mid-resolution to ask. Onto the BACK of the
      // queue, which is where a follow-up belongs — anything already waiting was
      // raised earlier.
      return tagged ? parkDecision(drawn, { kind: "UNL-051-buff", playerIndex: d.playerIndex }) : drawn;
    },
  },

  // Ivern's tail — "[Buff] a friendly unit", raised only when a Bird, Cat, Dog or
  // Poro was actually revealed.
  //
  // MANDATORY, so there is no Decline: the card says "do this", and 402.1's "you
  // may" is not printed here. With exactly one friendly unit this is a single
  // option and `advanceDecisions` executes it unprompted; with none — Ivern
  // himself having died in the response window before this resolves — it has no
  // options and is dropped, which is 055's "do as much as you can".
  //
  // "A friendly unit" carries no location word, so 355.9.a.1's bare noun puts base
  // and battlefields both on offer, and already-buffed units stay on offer for the
  // reason Spirit's Refuge and Aphelios both record: 702.3.a makes a second buff a
  // no-op rather than an illegal choice.
  "UNL-051-buff": {
    prompt: () => "Ivern - Nurturer: buff a friendly unit",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },

  // Vex - Mocking's "you may move me to that battlefield".
  //
  // `d.battlefieldId` is "THAT battlefield", captured when the trigger fired — see
  // her entry in `eventTriggers` for why it cannot be re-derived. `d.cardInstanceId`
  // is Vex herself; her trigger already established she is not standing there.
  //
  // Two options always, so this is never auto-answered: a "you may" that
  // `advanceDecisions` executed on the player's behalf would not be one.
  //
  // `forceMoveToBattlefield` rather than a zone rewrite, and it carries her own
  // controller as `causedByIndex`: 446.1/449 make an effect-driven relocation a
  // Move, so the `unitMoved` listeners and the Contested application (190.3.a) are
  // the point rather than a side effect. She arrives READY — 414.3.a puts the
  // exhaust on the Standard Move action, which this is not.
  "UNL-055-move": {
    prompt: (state, d) =>
      `Vex - Mocking: move her to ${state.battlefields.find((b) => b.id === d.battlefieldId)?.name ?? "that battlefield"}?`,
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "move", label: "Move Vex there" },
    ],
    resolve: (state, d, optionId) =>
      optionId === "move" && d.cardInstanceId && d.battlefieldId
        ? forceMoveToBattlefield(state, d.cardInstanceId, d.battlefieldId, d.playerIndex)
        : state,
  },

  // Yuumi - Magical Cat's "give one of your OTHER units HERE +3 Might and [Tank]
  // this turn", raised by her attack-or-defend trigger, which has already
  // established that such a unit exists.
  //
  // NO decline option: the card carries no "you may", so once it has triggered
  // the buff has to land somewhere. With exactly one candidate that makes this a
  // single option and `advanceDecisions` executes it without a prompt — there is
  // no choice to make. With NONE (Yuumi died or was moved in the response window)
  // it returns an empty list and the question is moot, which is 359.3.f.2's
  // referent check and not a special case.
  "UNL-056-buff": {
    prompt: () => "Yuumi - Magical Cat: give another of your units here +3 Might and [Tank] this turn",
    options: (state, d) =>
      yuumiCandidates(state, d.playerIndex, d.cardInstanceId ?? "", d.battlefieldId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => {
      // Re-asked against the SAME walk the options came from. `answerDecision`
      // already refuses an option that is not on offer, so this cannot be reached
      // through the action path today and is not claimed as tested — it is here
      // because BOTH halves of one printed sentence land below it, and a future
      // caller that resolves without that check must not be able to put the Might
      // somewhere the keyword does not go.
      if (!yuumiCandidates(state, d.playerIndex, d.cardInstanceId ?? "", d.battlefieldId ?? "").some((u) => u.instanceId === optionId)) {
        return state;
      }
      // `giveMightThisTurn`, not a Buff: "this turn" expires in the Expiration
      // Step (317.2.c), where a Buff would persist. `[Tank]` rides
      // `keywordsThisTurn` and expires with it; 815.2 makes a second instance
      // redundant, so naming a unit that already has [Tank] is a legal, quiet
      // no-op rather than a stacking bonus.
      return grantKeywordThisTurn(giveMightThisTurn(state, optionId, YUUMI_MIGHT), optionId, "Tank");
    },
  },
};


/**
 * Activated abilities contributed by this domain file.
 *
 * **Empty on purpose, and it is the seam that matters, not the contents.**
 * `ACTIVATED_ABILITIES` was module-private in `activated-abilities.ts`, so a
 * domain file could not register an activated ability AT ALL — the wave-1 agents
 * refused UNL-026 and UNL-093 on exactly that, and every future card with a
 * printed "[cost]: do something" would have hit the same wall or been written
 * into the shared file that the fan-out rule keeps agents out of.
 *
 * Merged lazily by `activated-abilities.ts`, through the same `mergeRegistries`
 * that throws on a duplicate defId — so a card registered both here and in the
 * built-in table is a named error at import, not a silent last-write-wins.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-049": {
    // Honeyfruit — "This enters exhausted. [Reaction][>] [Exhaust]: [Add] [rainbow].
    // [Level 6][>] [>>] [Reaction][>] [Exhaust]: [Add] [1 Energy][rainbow]."
    //
    // # ONE entry for a card that prints TWO abilities, and it is not a shortcut
    //
    // The `[Level 6]` half is a SECOND activated ability (the `>>` divider on this
    // card alone is what separates them — see `model/keyword.ts`), and 824.1.b.1
    // makes it short for "while you have 6+ XP, this card gains [that ability]".
    // Both cost the same exhaust of the same gear, so at most one of them can ever
    // be used, and the levelled one strictly dominates: same price, same rainbow,
    // plus an Energy. A player at 6+ XP would take it every time.
    //
    // So "the base ability, plus an Energy while you are at Level 6" is
    // observationally identical to the choice between them, and it is what is
    // written here. The alternatives were both worse: `AbilityMode` has no
    // per-mode `availableWhile`, so a modal pair could not turn the levelled mode
    // off below 6 XP, and two registry entries are impossible — this table is keyed
    // by defId and `mergeRegistries` throws on a duplicate.
    //
    // Read FRESH on every activation rather than latched: 824.1.d turns the
    // dependent ability Inactive "as soon as the controlling player has less than
    // [N] XP", and XP in this pool is spendable.
    //
    // # What is NOT here: "This enters exhausted"
    //
    // That clause is `deploy.GEAR_ENTERING_EXHAUSTED`, a set in a shared file this
    // pass does not own — so a Honeyfruit currently lands READY and can be tapped
    // the turn it is played, which is the whole of its printed drawback. Pinned by
    // a test that asserts the wrong answer, so adding the id fails loudly.
    //
    // `[Reaction]` is carried by `REACTION_SPEED_ABILITIES` in
    // `activated-abilities.ts`, which this card is in — it stopped being a no-op
    // when 310.1.a's timing gate landed. The reminder "(Abilities that add
    // resources can't be reacted to.)" needs nothing either — Dragonsoul Sage's
    // entry in `activated-abilities.ts` records why both are somebody else's
    // business, and the second is the standing chain divergence rather than a new
    // one.
    //
    // The Power is RAINBOW, so it lands in `floatingRainbowPower` (the pool keyed
    // by nothing) rather than `floatingPower` (keyed by Domain), and the Energy is
    // UNRESTRICTED — the card prints no "use only to…" clause, unlike Ornn's gear
    // Power or Lux's spell Energy.
    //
    // `banksResource`, like every other rune-producer here: it adds a resource the
    // board evaluator cannot price, so the heuristic AI will not take it. Recorded
    // rather than worked around, per this project's standing rule against
    // speculative heuristics with no evaluative basis.
    kind: "Gear",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = {
        ...actor,
        floatingRainbowPower: actor.floatingRainbowPower + HONEYFRUIT_POWER,
        floatingEnergy: actor.floatingEnergy + (atLevel(state, ctx.casterIndex, HONEYFRUIT_LEVEL) ? HONEYFRUIT_LEVEL_ENERGY : 0),
      };
      return { ...state, players };
    },
  },
  "UNL-045": {
    // Forgotten Signpost — "[Action][>] Exhaust a unit you control, [Exhaust]:
    // Move a different unit you control to the location of the unit you exhausted
    // to pay for this ability."
    //
    // **Refused in waves 3, 6 and 8, and the third refusal's design was the one
    // that was over-built.** All three agreed on the first gap and it was real:
    // `ActivationCost` had no "exhaust a unit you control", and its nearest
    // neighbour `killFriendlyPermanent` KILLS. That is now `exhaustFriendlyUnit`,
    // riding the same `costPermanentInstanceId` the kill already rides.
    //
    // The three then split on the second gap, "the resolver cannot learn WHICH
    // unit paid". Wave 8 dissolved it by reading the card DESTINATION-first —
    // "choose a Location, exhaust a friendly unit standing there, move a different
    // unit to it" — which needs no new event field but does need `movesTarget`,
    // a base destination on `ActivateAbilityAction` (which does not exist; wave 8
    // named that as a third gap), and a payer-at-destination pair check.
    //
    // **Re-measured on 2026-08-14 and the PAYER-first reading is strictly
    // smaller**, so that is what is written. SFD-050 Azir - Ascendant is the
    // precedent, not Yasuo: he moves between arbitrary locations INCLUDING a base
    // with no destination field on his action at all, because his destination is
    // another unit's location. Here it is the payer's. That costs one field on
    // `ActivatedAbilityEvent` and one forwarding line, and it makes the third gap
    // moot rather than blocking — the base case works because
    // `forceMoveToDestination` already dispatches on it.
    //
    // Two pair constraints come off the printed text and are enforced by
    // `costPayerPairingAllowed` at BOTH the enumerator's cross and the validator:
    // "a DIFFERENT unit" (payer is not the target) and no move to where the target
    // already stands. Neither can be a filter on one axis alone, because the payer
    // is fanned out per MODE before any target exists.
    //
    // `[Action][>]` needs nothing: UNL-161 and UNL-194 print it on abilities that
    // already work, so it is the ordinary activation timing rather than a mode.
    kind: "Gear",
    cost: { exhaust: true, exhaustFriendlyUnit: true },
    // "A unit you control" names no battlefield, so `anywhere` — 355.9.a.1. The
    // base is load-bearing on BOTH axes here: a unit at home is a legal thing to
    // move, and a payer at home is the only way this card pulls somebody back.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    movesTargetToCostPayer: true,
    resolve: (state, ctx, event) => {
      if (event.targetUnitInstanceId === undefined || event.costPermanentInstanceId === undefined) return state;
      // The payer was exhausted to pay, not removed, so it is still standing where
      // the card points at. Read at RESOLUTION rather than at announce: the
      // activation went on the Chain, and 383.3 makes what happens in between
      // somebody else's business — if a reaction moved the payer, the card's own
      // words send the target to where it is NOW.
      const anchor = findUnitAnywhere(state, event.costPermanentInstanceId);
      if (anchor === undefined) return state;
      return forceMoveToDestination(
        state,
        event.targetUnitInstanceId,
        anchor.zone === "base"
          ? { destinationIsBase: true }
          : { destinationBattlefieldId: state.battlefields[anchor.zone.battlefieldIndex]!.id },
        ctx.casterIndex,
      );
    },
  },
  // **The one Calm card that prints an activated ability and must NOT be
  // registered here.**
  //
  // UNL-039 Soul Sword prints `[Equip] [Calm]` and nothing else, and
  // `activated-abilities.equipAbilities()` GENERATES an entry for every Gear
  // whose printed `[Equip]` cost `card-loader.parseEquipCost` can read. Soul
  // Sword's is a bare one-rune cost, so it parses and the ability exists. Adding
  // a hand-written entry here would not shadow it — `mergeRegistries` throws on a
  // duplicate defId — so this is the one case where using the new seam breaks the
  // engine at import rather than doing nothing.
  //
  // Its ART-ONLY band, `[Level 3][>] I have an additional +1 Might`
  // (docs/unl-equipment-abilities.md), is a continuous Might modifier on the
  // WEARER rather than an activated ability — so it is not this registry's, and
  // as of 2026-08-09 it is not missing either: it is the `UNL-039` entry in
  // `mightModifiers` at the foot of this file, which is the seam that did not
  // exist when this note was written.
  //
  // # UNL-045 Forgotten Signpost was refused HERE three times, and is now written
  // # above — the reasoning is in its own entry
  //
  // Kept as a pointer rather than deleted outright, because the shape of the three
  // refusals is worth more than the refusals were. Every one of them named the
  // same first gap correctly (`ActivationCost` could not say "exhaust a unit you
  // control") and then priced the SECOND gap against a design that was never the
  // only one available. Wave 8's destination-first reading needed a base
  // destination on `ActivateAbilityAction` and called that a third, blocking gap;
  // the payer-first reading it did not consider needed neither, and SFD-050 Azir
  // had been the working precedent for it since SFD landed.
  //
  // The lesson is this repo's standing one, in a new place: a refusal's BLOCKER is
  // a measurement and ages well, and a refusal's PLAN is a guess and does not.
};


/**
 * Continuous Might modifiers contributed by this domain file.
 *
 * The seam `effective-might.ts` had no equivalent of until 2026-08-09: every
 * conditional or scaling Might card had to be hand-added to that shared file,
 * which the fan-out rule keeps parallel agents out of — so three cards were
 * refused across two waves rather than written.
 *
 * Keyed by defId. A SELF bonus tests `unit.defId`; an AURA tests the board for
 * its source and ignores it. `bonus` is called for every unit on every
 * evaluation, so it must be pure and cheap.
 *
 * A `[Level N]` bonus belongs HERE and not in an on-play trigger: 824.1.d turns
 * the ability off again the moment XP drops below N, so a one-shot pump is wrong
 * in both directions.
 */
export const mightModifiers: Record<string, MightModifier> = {
  [MOSSTOMPER]: {
    // Mosstomper — "[Hunt 2] [Level 3][>] I have +1 Might and [Deflect]."
    //
    // The MIGHT half. `[Hunt 2]` needs nothing from this file: `triggers.ts`
    // registers it ONCE for the whole pool under `HUNT_TRIGGER_KEY`, keyed off the
    // KEYWORD rather than the card and reading its magnitude through
    // `effectiveKeywords`, so a per-card copy here would pay his conquer/hold XP
    // twice.
    //
    // A SELF bonus, so it tests `unit.defId` — every registered modifier is asked
    // about every unit, and a modifier that forgot this would pump the board.
    //
    // Read from the OWNER's XP (`ownerIndex`), not the asking player's: 824.1.c
    // makes the condition the CONTROLLER's counter and `effectiveMight` is called
    // by both sides.
    //
    // **The `[Deflect]` half is a DIVERGENCE, not an omission, and it points the
    // WRONG way.** `card-loader.parseKeywords` reads the bracket straight out of
    // the band and hands him a flat printed `[Deflect 1]`, so an opponent pays the
    // rainbow surcharge to choose him at 0 XP — a band that should be Inactive
    // below 3 (824.1.d). Closing it needs BOTH halves of a shared-file change that
    // this file cannot make: a `card-loader.GRANTED_ONLY_KEYWORDS` entry to strip
    // the parsed keyword (his `[Hunt]` is real, so the blanket
    // `CONDITIONAL_KEYWORD_DEF_IDS` would take that with it), and a
    // `granted-keywords.CONDITIONAL_GRANTS` entry to give it back under
    // `atLevel(..., 3)`. Doing only the first would make him strictly worse than
    // printed, which is the direction this repo never ships. Pinned by a test that
    // asserts the WRONG answer, so closing it fails loudly.
    defId: MOSSTOMPER,
    bonus: (state, unit, ownerIndex) =>
      unit.defId === MOSSTOMPER && atLevel(state, ownerIndex, MOSSTOMPER_LEVEL) ? MOSSTOMPER_MIGHT : 0,
  },
  [SOUL_SWORD]: {
    // Soul Sword's ART-ONLY band — `[Level 3][>] I have an additional +1 Might.
    // (While you have 3+ XP, get the effect.)`
    //
    // **None of this is in the card data**: `text.plain` holds the `[Equip]` line
    // and nothing else, which is why the card reported implemented while doing it.
    // Transcribed from the card image; see docs/unl-equipment-abilities.md, and
    // `coverage.PARTIALLY_IMPLEMENTED` for the note that has been keeping it
    // honest — **that note is now stale and should be dropped**, together with
    // UNL-039's row in `equipment-wearer-moments.test.ts`'s art-only list.
    //
    // # An AURA in this seam's terms, not a self bonus
    //
    // "I" is the SWORD and the Might lands on its WEARER, so this ignores
    // `unit.defId` entirely and asks the board whether this unit is wearing one —
    // the shape `MightModifier`'s own doc calls an aura, with the gear as source.
    //
    // # Deliberately OUTSIDE `equipmentMightBonusFor`
    //
    // That function sums the printed BADGE (`EQUIP_MIGHT_BONUS`), and Gearhead
    // doubles exactly what it returns — "each Equipment attached to me gives
    // double its BASE Might bonus". This band is not the base badge, so it must
    // not be doubled; adding it here keeps the badge (+1) doubling and the band
    // (+1) not, which is what "base" makes the reading rather than a convenience.
    // Brutalizer's art-only "+2 if attached this turn" sits inside that function
    // and IS doubled — a difference worth stating, since the two cards look alike.
    //
    // # Whose XP
    //
    // The GEAR's controller, which is the player whose `activeGear` holds it —
    // 824.1.c makes the condition the ability's controller and the ability is the
    // Sword's. That is the wearer's controller in every reachable case ("attach
    // this to a unit YOU control"), and deliberately not assumed to be: control of
    // a gear can move (Akshan - Mischievous borrows one), and reading the wearer's
    // seat would then answer with the wrong player's counter.
    defId: SOUL_SWORD,
    bonus: (state, unit) => {
      const holder = ([0, 1] as const).find((i) =>
        state.players[i].activeGear.some((g) => g.defId === SOUL_SWORD && g.attachedToInstanceId === unit.instanceId),
      );
      return holder !== undefined && atLevel(state, holder, SOUL_SWORD_LEVEL) ? SOUL_SWORD_LEVELLED_MIGHT : 0;
    },
  },
  [VILEMAW]: {
    // Vilemaw's SECOND clause — "Enemy units here with less Might than me don't
    // deal combat damage."
    //
    // # Why this is a Might modifier and not `combat.DEALS_NO_COMBAT_DAMAGE_DEF_IDS`
    //
    // `coverage.PARTIALLY_IMPLEMENTED` says of this card that "the Set is keyed by
    // the silenced unit's own defId and cannot express a conditional aura over
    // enemies", and that is true of the Set — it is not true of the arithmetic.
    // effects/order.ts reached the same place for Galio - Indefatigable's "I don't
    // deal combat damage" and its entry carries the sweep: `outgoingMight` is the
    // only site where a `combatRole: "outgoing"` Might decides anything, and
    // `granted-keywords.isMighty` takes the HIGHER of the two roles, so a penalty
    // in one of them can never make a unit less Mighty. **143.2.b** is what makes
    // it exact rather than an approximation — a Might below 0 is "treated as 0 …
    // when summing Might to be assigned as damage in the Combat Damage Step" — and
    // `effectiveMight` ends in `Math.max(0, m)`.
    //
    // `remainingMight` is deliberately untouched, which is the same split the Stun
    // rule takes (423) and Ezreal - Dashing's entry records: a silenced unit hits
    // for nothing and is no easier to KILL for it.
    //
    // # "HERE" is Vilemaw's location, read from the SOURCE
    //
    // 359.3.f.1 names "here" as a referent taken from the ability's source. So the
    // question is not "is this unit at a battlefield" but "is an ENEMY Vilemaw
    // standing at THIS one", and a Vilemaw who has been moved to base reaches
    // nothing at all — the same positional reasoning `zealotPenaltyApplies` states
    // for Leona - Zealot's "here". Each player's Base is its own Location (198.1)
    // and holds only its owner's units, so "enemy units here" is empty there by
    // construction rather than by a check.
    //
    // # "Less Might than ME" is measured OUT of combat, and that is a DIVERGENCE
    //
    // Both sides of the comparison are read at `{ isCombat: false }`, so buffs,
    // auras, Equipment badges and this-turn pumps all count and `[Assault]` /
    // `[Shield]` do not. 807.1.c and 814.1.c make those two genuine Might ("While I
    // am an attacker, I have +X [M]"), so an attacking 4-Might `[Assault 2]` unit
    // has 6 Might at the moment Vilemaw is asked and this reads it as 4 — the
    // engine silences a unit it should not when the keyword would carry it over
    // Vilemaw's 8. **The direction is toward the printed card being stronger, so
    // it is a real gap and not a safe one; it is recorded for the integrator to
    // put in docs/rules-conformance.md.**
    //
    // It is not laziness, it is the only termination this seam has: a comparison at
    // `isCombat: true` re-enters `effectiveKeywords`, and for a unit carrying a
    // `dependsOnMight` conditional grant (Fiora - Victorious) that reaches
    // `isMighty`, which calls back in at `combatRole: "outgoing"` and lands on this
    // very modifier — an unbounded cycle, not a deep one. `isCombat: false` cannot
    // recurse: `effectiveMight` skips the keyword read entirely on that branch, and
    // this modifier's own first line returns 0 for it. `target-lookup`'s
    // `unitWithinMaxMight` already measures a Might restriction the same way and
    // says so ("auras count, [Shield]/[Assault] don't"), so this is the house
    // reading rather than a new one.
    //
    // # Strictly "less", and asked per Vilemaw
    //
    // A tie is NOT silenced — "less Might than me" excludes equal, so an 8-Might
    // enemy trades with him normally. Two Vilemaws at one battlefield are two
    // abilities, so a unit under the smaller one's threshold is silenced even if
    // the larger has been shrunk; `some` is that, not a convenience.
    defId: VILEMAW,
    bonus: (state, unit, ownerIndex, ctx) => {
      if (ctx.combatRole !== "outgoing") return 0;
      const battlefieldId = ctx.battlefieldId;
      if (battlefieldId === undefined) return 0;
      const enemyIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
      const here = state.battlefields.find((b) => b.id === battlefieldId);
      const spiders = (here?.units[state.players[enemyIndex].id] ?? []).filter((u) => u.defId === VILEMAW);
      // A COST guard, not a rule — `some` over an empty list already answers
      // false. It is here because `bonus` runs for every unit on every Might
      // evaluation, and without it every combat in every game that never sees a
      // Vilemaw pays for a second `effectiveMight` call. Labelled so nobody reads
      // it as load-bearing; it survives mutation and should.
      if (spiders.length === 0) return 0;
      const mine = effectiveMight(state, unit, ownerIndex, { isCombat: false, battlefieldId });
      const silenced = spiders.some(
        (spider) => effectiveMight(state, spider, enemyIndex, { isCombat: false, battlefieldId }) > mine,
      );
      return silenced ? -NO_COMBAT_DAMAGE_PENALTY : 0;
    },
  },
};
