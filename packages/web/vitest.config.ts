import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The web package had no test infrastructure at all — no vitest, no test
 * directory, no test script — while two pieces of HIDDEN INFORMATION were
 * protected by exactly two local rendering decisions and nothing watched
 * either. The state reaching the components is NOT masked: `maskHiddenCards`
 * exists in the engine but is not exported from its index, so the board is
 * handed real identities for both players and the secrecy lives entirely in
 * `BattlefieldView`'s `mine ? name : "Facedown"` and in `GameBoard` rendering
 * the opponent's hand from `ai.hand.length` alone.
 *
 * jsdom rather than happy-dom because the components under test measure
 * elements (`use-row-fit`, `use-board-card-size`) and jsdom's stubbed layout
 * geometry is the better-documented of the two to reason about — see
 * test/setup.ts, which supplies the ResizeObserver those hooks require.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
