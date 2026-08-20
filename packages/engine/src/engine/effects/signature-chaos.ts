import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import { parkDecision } from "../decisions.js";
import { drawOneFromTopAndTrashRest } from "../effect-helpers.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Chaos**.
 *
 * So a `Chaos+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Chaos lives in that domain's file instead. The rule is mechanical
 * on purpose: `mergeRegistries` throws when two files claim one defId, and
 * avoiding that needs every card to have exactly one derivable home rather than a
 * judgment call. Shared helpers are in `signature-shared.ts`.
 *
 * **The FIFTH of these files, and the first one a card actually needed.** When
 * `effects/index.ts` split the dual-domain block four ways it said outright that
 * "nothing lands in Chaos or Order today because every such card carries an
 * earlier domain; those files are not created until a card needs one". VEN-156
 * Lightning Rush is Chaos+Order — the pool's first card whose two domains are
 * BOTH later than Body — so this is that file, created for exactly the reason
 * that note gave and not before.
 *
 * `effects/signature-order.ts` still does not exist, and by the same rule it
 * cannot: Order is last in canonical order, so a card can only be filed there if
 * it is Order+Order.
 */

/** Lightning Rush's "look at the top 3". */
const LIGHTNING_RUSH_LOOK = 3;
/** Its question, written once because the resolver that raises it and the entry
 *  that answers it must agree — a kind nobody registers throws, but a DEFINITION
 *  keyed to a kind nobody parks simply never runs and reads exactly like a card
 *  that was never cast. */
const LIGHTNING_RUSH_KEEP = "VEN-156-keep";
const LIGHTNING_RUSH_DECLINE = "decline";

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-156": {
    // Lightning Rush (Chaos + Order) — "Look at the top 3 cards of your Main
    // Deck. You may choose a card from among them and draw it. Put the rest into
    // your trash. [Flow] [2][rainbow]"
    //
    // # A decision, and it is FORCED to be one
    //
    // `legal-actions` enumerates from PUBLIC state and the top of a deck is not
    // public, so fanning the choice onto the action would hand the AI its own
    // deck order. Stacked Deck and Called Shot both record the same reasoning for
    // the same shape.
    //
    // # Three things this is not, and each is a different card
    //
    // **The rest go to the TRASH, not the bottom of the deck.** Stacked Deck
    // recycles; this fills a graveyard, which in a set with `[Flow]`, Last Rites
    // and a dozen trash-readers is closer to a benefit than a cost.
    //
    // **It is not a Burn.** 440's Burn carries burn-out-and-continue (440.4) and
    // Forgotten Relic's "when you burn a unit this way"; this card says none of
    // it, so the move goes through the plain trash funnel.
    //
    // **"DRAW it" is a real draw**, not "put it into your hand" — so `cardDrawn`
    // fires and `cardsDrawnThisTurn` moves. `drawOneFromTopAndTrashRest` reaches
    // that by floating the chosen card to the top and calling `drawCards`, rather
    // than moving it by hand.
    //
    // # "You MAY choose"
    //
    // Declining is a real option and it is not a no-op: the three still go to the
    // trash. Which is occasionally the point — this is the pool's cheapest way to
    // put three specific cards where `[Flow]` can reach them. Declining leads, the
    // convention every decision in this engine keeps.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: LIGHTNING_RUSH_KEEP, playerIndex: ctx.casterIndex }),
  },
};

export const decisions: Record<string, DecisionDefinition> = {
  [LIGHTNING_RUSH_KEEP]: {
    prompt: () => "Lightning Rush: draw one of the top 3? The rest go to your trash",
    // Read LIVE rather than from a snapshot taken at resolution — the whole
    // reason `DecisionDefinition.options` is a function of state, and what makes
    // a second copy of this card correct if one ever repeats.
    options: (state, d) => [
      { id: LIGHTNING_RUSH_DECLINE, label: "Draw none — trash all 3" },
      ...state.players[d.playerIndex].deck
        .slice(0, LIGHTNING_RUSH_LOOK)
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) =>
      drawOneFromTopAndTrashRest(
        state,
        d.playerIndex,
        LIGHTNING_RUSH_LOOK,
        optionId === LIGHTNING_RUSH_DECLINE ? undefined : optionId,
      ),
  },
};

/** Empty, and deliberately declared: `effects/index.ts` reads every registry off
 *  every module, so a missing export is `undefined` at merge time rather than an
 *  empty table. Declaring them keeps adding a card here to one line. */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};
export const eventTriggers: Record<string, EventTriggerDefinition> = {};
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {};
export const mightModifiers: Record<string, MightModifier> = {};
