/**
 * jsdom implements no layout, so it ships no `ResizeObserver` — and both
 * `use-row-fit` and `use-board-card-size` construct one unconditionally. Without
 * this stub every component that renders a card row throws on mount, which would
 * look like a component fault rather than a missing environment.
 *
 * Deliberately inert (it never fires) rather than a fake that reports sizes: the
 * tests here are about what reaches the DOM, not about how it is laid out, and a
 * stub that invented geometry would let a test claim to have measured something
 * jsdom cannot measure.
 */
class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= InertResizeObserver;
