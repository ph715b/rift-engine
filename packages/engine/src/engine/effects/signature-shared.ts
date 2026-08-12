import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellDefinition, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import {
  addBuff,
  banishCard,
  borrowUnitInPlace,
  dealDamage,
  destroyUnit,
  legionActive,
  dealDamageToEnemyUnitsAtBattlefield,
  discardCards,
  drawCards,
  forceMoveToBattlefield,
  forceMoveToDestination,
  giveMightThisTurn,
  grantTriggerThisTurn,
  giveMightThisTurnToOwnUnit,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recallUnitToBase,
  removeUnitAnywhere,
  returnPermanentToHand,
  stunUnits,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { eligibleTargets, findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { isHiddenCard } from "../hidden.js";
import { parkDecision } from "../decisions.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import type { CardInstance, GearInstance, UnitInstance } from "../../model/card.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { attachEquipment, isEquipmentGear, isMechUnit } from "../equipment.js";
import { SAND_SOLDIER_TOKEN, placeGoldTokens, placeToken, type TokenDestination, type TokenSpec } from "../token.js";
import { playUnitToBattlefield } from "../deploy.js";
import { applyContested } from "../cleanup.js";

/**
 * Helpers and constants shared by the four `signature-*.ts` files.
 *
 * **Why there are four of them.** Dual-domain (champion signature) cards have no
 * single owning domain, so they all lived in one `signature.ts` — which meant the
 * largest remaining block of unwritten cards could only ever be worked by one
 * agent at a time, while the six domain files fanned out freely. Split
 * 2026-08-10 so that block parallelises like the rest.
 *
 * **A card's home is its FIRST domain in canonical order** — Fury, Calm, Mind,
 * Body, Chaos, Order — so `Body+Fury` lives in `signature-fury.ts` and
 * `Body+Order` in `signature-body.ts`. A rule rather than a judgment call,
 * because the failure this file's `mergeRegistries` guards against is two owners
 * registering the same defId, and that needs every card to have exactly one
 * derivable home. (Nothing lands in Chaos or Order today: every such card
 * carries an earlier domain.)
 *
 * Everything here was in `signature.ts` and is unchanged apart from the `export`.
 * Helpers used by ONE file may live in that file; these are the ones with more
 * than one caller, plus the constants their comments explain.
 */

/**
 * Card implementations for the **dual-domain** cards — one file, one owner.
 *
 * These are the champion signature cards: 15 Spells plus Tibbers (the pool's only
 * dual-domain Unit), each printed in two domains — Icathian Rain (Fury+Mind),
 * Super Mega Death Rocket! (Fury+Chaos), Zenith Blade (Calm+Order), and so on.
 *
 * They get their own file because per-domain ownership is genuinely ambiguous for
 * them: a Fury+Chaos card belongs equally to fury.ts and chaos.ts, so filing it
 * by "first domain" would be arbitrary and two owners could each reasonably
 * believe it was theirs. One explicit owner removes the question.
 *
 * The ownership rule is enforced by test/effect-registry.test.ts: a defId may
 * only appear here if its CardDefinition has exactly two domains. Single-domain
 * cards belong in the matching effects/<domain>.ts; Legends belong in
 * engine/legend-abilities.ts (all 16 are dual-domain, so splitting them by domain
 * would put every one of them here).
 *
 * See effects/fury.ts's header for what adding a card owes: registration, a rule
 * or oracle citation, and an engine test.
 */
export const DANGER_ZONE_MIGHT = 1;

/**
 * The event-trigger registry key Relentless Pursuit grants — "When I conquer,
 * you may move me to my base."
 *
 * A named constant because it is written in two places that must agree: the
 * resolver that grants it and the registry entry that answers to it. A typo in
 * either would be SILENT — the grant would name an ability nothing implements,
 * and the unit would simply never trigger, which reads exactly like a card that
 * was never played.
 */
export const RELENTLESS_PURSUIT_GRANT = "SFD-184-conquer-home";


/** Curtain Call's two damage modes and its debuff, each named once so the mode
 *  and the test quote the same number. */
export const CURTAIN_CALL_BATTLEFIELD_DAMAGE = 2;
export const CURTAIN_CALL_BASE_DAMAGE = 3;
export const CURTAIN_CALL_SHRINK = 4;

/** Thrill of the Hunt's "to any battlefield" question — written once because the
 *  resolver that raises it and the decision that answers it must agree, and a
 *  typo in either would be SILENT (a parked question nothing implements simply
 *  never appears, which reads exactly like a unit that was never banished). */
export const THRILL_OF_THE_HUNT_PLACEMENT = "UNL-184-place";

/** Arise!'s "ready up to two of them". */
export const ARISE_READY_COUNT = 2;

/**
 * Every Equipment `playerIndex` controls — `activeGear` filtered by the printed
 * Equipment tag.
 *
 * Its own function rather than the filter written inline, because "an Equipment
 * you control" is a phrase two cards in this set count and one of them is priced
 * off it. Attached or not: the phrase says control, and `activeGear` membership
 * is what control means for a permanent here.
 */
export function equipmentControlledBy(state: GameState, playerIndex: 0 | 1): GearInstance[] {
  return state.players[playerIndex].activeGear.filter((g) => isEquipmentGear(g));
}

/**
 * Every unit `playerIndex` could be asked to point a bare "a unit" at — either
 * player's, in either base or at any battlefield.
 *
 * `eligibleTargets` rather than a hand-rolled walk of the four zones, and that is
 * the whole reason it is a function: that helper is where `unitChooseableBy`
 * filters the units an opponent may not choose (Ruin Runner), and a decision that
 * walked the board itself would offer one and be the only place in the engine
 * that does. Two cards here ask the same question — Rengar's pump and Vi's ready
 * — so they ask it in one place.
 *
 * `scope: "anywhere"` and no owner: 355.9.a.1's bare "unit" is objects on the
 * Board, and neither card prints an owner word.
 */
export function anyUnitChooseableBy(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return eligibleTargets(state, playerIndex, undefined, "anywhere");
}

/**
 * How much excess damage `playerIndex` assigned in the fight at `battlefieldId`,
 * or 0 when the record is from another battlefield, from the other side of a
 * fight, or absent.
 *
 * A SECOND copy of effects/body.ts's `excessFor`, and deliberately so rather than
 * shared: that one is private to the file that owns Sivir - Ambitious, and moving
 * it would mean editing a file this one does not own. The two read the same single
 * field and are asserted against the same three conditions; if a third card ever
 * prints the clause, the shared home is effect-helpers.ts.
 */
export function excessAssignedBy(state: GameState, playerIndex: 0 | 1, battlefieldId: string | undefined): number {
  const excess = state.lastShowdownExcessDamage;
  if (!excess || excess.battlefieldId !== battlefieldId || excess.attackerIndex !== playerIndex) return 0;
  return excess.amount;
}

/** Vi - Piltover Enforcer's "3 or more excess damage" — Sivir - Ambitious prints
 *  the same clause at 5, so the threshold is a per-card number and not a rule. */
export const VI_EXCESS_REQUIRED = 3;

/** Rengar - Pridestalker's "+1 [Might] this turn". */
export const RENGAR_MIGHT = 1;

/** Void Rush's "reducing its cost by [2 Energy]". */
export const VOID_RUSH_DISCOUNT = 2;

/** The two cards Void Rush reveals — read live rather than captured on the
 *  decision, because `PendingDecision` has no field for a card list and the deck
 *  cannot move between parking this question and answering it (a spell's
 *  resolution is one submit). A question queued BEHIND one that draws would see a
 *  different pair; nothing in this pool can produce that shape. */
export function voidRushRevealed(state: GameState, playerIndex: 0 | 1): CardInstance[] {
  return state.players[playerIndex].deck.slice(0, 2);
}

/**
 * Pays a revealed card's cost with Void Rush's [2 Energy] taken off, or
 * `undefined` when the pool cannot cover it — the same contract
 * `payPowerFromChanneled` and `spendBuff` use, so an unpayable card is never
 * offered rather than offered and then played free.
 *
 * **POWER FIRST, then Energy**, and the order is not arbitrary:
 * `payPowerFromChanneled` recycles the rune and banks 1 floating Energy for one
 * that was still Ready, which is the same "a Ready rune spent on Power still
 * counts toward the Energy cost" arithmetic `computeAutoPayment` does. Paying
 * Energy first would exhaust that rune and lose the credit, refusing plays the
 * ordinary cost pipeline allows.
 *
 * The discount is applied AFTER the cross-cutting modifiers (`modifiedEnergyCost`)
 * rather than to the printed number, matching how `modifiedEnergyCost` already
 * orders its own conditional discounts against the printed cost, and floored at 0.
 *
 * **Three named limitations, all inherited from `payPowerFromChanneled` and all
 * UNDER-offering** — the card is withheld, never handed over unpaid:
 *  - Floating Power is not counted, only the channeled pool.
 *  - A split Power pip (`powerDomainAlt`) is tried as all-primary, then as
 *    all-alt; a MIXED payment (one Fury and one Order for a 2-Power hybrid) is not
 *    attempted, because the helper takes a single domain and widening it is a
 *    change to effect-helpers.ts. That matters more here than it did for The
 *    Harrowing, since SFD prints hybrid pips freely.
 *  - A Legend can never be in a Main Deck, so it is refused rather than priced.
 */
export function voidRushPayment(state: GameState, playerIndex: 0 | 1, card: CardInstance): GameState | undefined {
  if (card.kind === "Legend") return undefined;

  let paid: GameState | undefined = state;
  if (card.powerCost > 0) {
    paid =
      payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost) ??
      (card.powerDomainAlt !== undefined
        ? payPowerFromChanneled(state, playerIndex, card.powerDomainAlt, card.powerCost)
        : undefined);
  }
  if (!paid) return undefined;

  const energy = Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - VOID_RUSH_DISCOUNT);
  return payEnergyFromPool(paid, playerIndex, energy);
}

/** What one revealed card's option says it costs, so the two prices a player is
 *  choosing between are visible rather than implied. */
export function voidRushLabel(state: GameState, playerIndex: 0 | 1, card: CardInstance): string {
  if (card.kind === "Legend") return card.name;
  const energy = Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - VOID_RUSH_DISCOUNT);
  const power = card.powerCost > 0 ? `, ${card.powerCost} ${card.powerDomain ?? "any"} Power` : "";
  return `Banish and play ${card.name} (pay ${energy} Energy${power})`;
}


/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */


/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */

/** The unit Thrill of the Hunt's placement question is about, while it is still
 *  in the pen. */
export function awaitingThrillUnit(state: GameState, cardInstanceId: string | undefined): UnitInstance | undefined {
  if (cardInstanceId === undefined) return undefined;
  return state.unitsAwaitingFreePlacement.find((p) => p.unit.instanceId === cardInstanceId)?.unit;
}

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
/** Pyke - Bloodharbor Ripper's ":rb_energy_1:, :rb_exhaust::". */
export const PYKE_ENERGY_COST = 1;

/**
 * Lillia - Bashful Bloom's printed ":rb_energy_4:", BEFORE her "[1] less for each
 * friendly unit with [Temporary]" — which is not applied. See her entry.
 */
export const LILLIA_ENERGY_COST = 4;

/** Lillia's "ready 3 [Might] Sprite unit token with [Temporary]" — the fourth
 *  copy of this spec in the engine; see her entry for why it is local. */
export const SPRITE_TOKEN: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };



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
export const MASTER_YI_WUJU_MASTER = "UNL-191";
/** His first clause's `[Level 6]` and the +1 it grants — 824.1.b.1's "[N] or
 *  more XP", so 6 is on and 5 is off. */
export const MASTER_YI_LEVEL = 6;
export const MASTER_YI_MIGHT = 1;
