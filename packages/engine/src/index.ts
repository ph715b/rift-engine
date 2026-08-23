export * from "./model/domain.js";
export * from "./model/keyword.js";
export * from "./model/rune.js";
export * from "./model/card-definition.js";
export * from "./model/card.js";
export * from "./model/phase.js";
export * from "./model/game-state.js";

export * from "./cards/card-loader.js";
export * from "./cards/card-registry.js";

export * from "./actions/validation-result.js";
export * from "./actions/player-action.js";
export * from "./actions/mulligan-action.js";
export * from "./actions/validate-mulligan.js";
export * from "./actions/execute-mulligan.js";
export * from "./actions/validate-play-card.js";
export * from "./actions/execute-play-card.js";
export * from "./actions/validate-pass.js";
export * from "./actions/validate-move-unit.js";
export * from "./actions/execute-move-unit.js";
export * from "./actions/validate-recall-unit.js";
export * from "./actions/execute-recall-unit.js";
export * from "./actions/validate-pass-focus.js";
export * from "./actions/execute-pass-focus.js";
export * from "./actions/validate-float-rune.js";
export * from "./actions/execute-float-rune.js";

export * from "./decks/deck-list.js";
export * from "./decks/deck-validation.js";
export * from "./decks/deck-generator.js";
// Named rather than a star re-export: activated-abilities.ts exports a large
// surface, and probes need exactly this one to ask whether a deck holds an
// ability the AI would ever take.
export { activatedAbilityFor } from "./engine/activated-abilities.js";
export * from "./decks/deck-file-parser.js";
export * from "./decks/decklist-text-parser.js";
export * from "./decks/player-setup.js";
export * from "./decks/battlefield-setup.js";
export * from "./decks/deck-presets.js";

export * from "./engine/constants.js";
export * from "./engine/turn-manager.js";
export * from "./engine/win-condition.js";
export * from "./engine/submit-result.js";
export * from "./engine/game-engine.js";
export * from "./engine/combat.js";
export * from "./engine/cleanup.js";
export * from "./engine/timing.js";
// The board renders and answers pending decisions, so the query side of that
// registry is public — see engine/decisions.ts.
export { optionsFor, pendingDecision, promptFor, type DecisionOption } from "./engine/decisions.js";
export * from "./engine/coverage.js";
export * from "./engine/scoring.js";
export * from "./engine/legal-actions.js";
export * from "./engine/rune-payment.js";
export * from "./engine/card-effects.js";
export * from "./engine/effect-context.js";
export * from "./engine/effect-helpers.js";
export * from "./engine/target-lookup.js";
// Exported for the WEB's blocked-reason text, which has to say WHICH half of a
// counter's targeting is missing — "there is no spell you may counter" and "you
// have no unit it could protect" are different problems with different fixes,
// and the board used to assert one card's wording for both.
export * from "./engine/counter-spell.js";
export * from "./engine/card-effect-resolution.js";
export * from "./engine/chain-description.js";
export * from "./engine/unit-triggers.js";
export * from "./engine/legend-abilities.js";
export * from "./engine/token.js";
export * from "./engine/channel-cost.js";
// SFD's headline subsystem, and it was NOT public until 2026-08-07 — which is
// why the board could not show what was attached to what even in principle.
export * from "./engine/equipment.js";
export * from "./engine/effective-might.js";
export * from "./engine/damage-modifiers.js";
export * from "./engine/cost-modifiers.js";

/** Which battlefields carry a TRIGGERED ability, for `probes/battlefield-reach.ts`.
 *  A named export rather than `export *`: the module also holds the tables and
 *  the resolvers, and a probe has no business reaching those. */
export { battlefieldAbilityDefIds } from "./engine/battlefield-abilities.js";

export * from "./ai/heuristic-ai.js";

export * from "./util/rng.js";
