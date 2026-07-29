/**
 * The immutable "who's casting this" context passed to every registered
 * card-effect/trigger resolver — deliberately NOT a stateful class with
 * mutating methods (unlike the Java oracle's `EffectContext`, which can
 * pause mid-effect to ask the player a question). This engine is a pure
 * `(state, action) -> state` machine: every choice a card's effect needs
 * (which target(s), which battlefield, which trashed card, whether an
 * optional cost was paid) must already be decided in the submitted
 * action before `resolve` ever runs. `EffectContext` only ever carries
 * plain, already-known facts.
 */
export interface EffectContext {
  readonly casterIndex: 0 | 1;
  readonly opponentIndex: 0 | 1;
}

export function contextFor(casterIndex: 0 | 1): EffectContext {
  return { casterIndex, opponentIndex: casterIndex === 0 ? 1 : 0 };
}
