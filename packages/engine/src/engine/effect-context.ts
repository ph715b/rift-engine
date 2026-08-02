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
  /**
   * The card whose text is resolving, when there is one — Time Warp's "Banish
   * THIS", the first card in the pool that has to name itself.
   *
   * Optional, and unlike `cardPlayed`'s required `playedKind` that is the honest
   * shape rather than a shortcut: several resolvers genuinely have no source
   * card. A Legend hook's source is not a card in any zone, and a death-watch
   * resolves for a listener that is handed to it separately. Making it required
   * would mean inventing an id at those sites, which is worse than admitting the
   * field is sometimes absent.
   */
  readonly sourceCardInstanceId?: string;
}

export function contextFor(casterIndex: 0 | 1, sourceCardInstanceId?: string): EffectContext {
  return {
    casterIndex,
    opponentIndex: casterIndex === 0 ? 1 : 0,
    ...(sourceCardInstanceId !== undefined ? { sourceCardInstanceId } : {}),
  };
}
