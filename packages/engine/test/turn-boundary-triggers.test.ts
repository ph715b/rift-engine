import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * A trigger held at the TURN BOUNDARY — the ordering nobody had exercised.
 *
 * `runEnd` pushes to `pendingTriggers`, but `finalizePendingTriggers` runs in
 * `runCleanup`, and `submit`'s Pass is `runStartOfTurn(runEnd(state))` with a
 * single Cleanup at the end. So between a turn-boundary trigger firing and
 * resolving, the engine rotates `activePlayerIndex`, Awakens the next player,
 * scores their holds, channels and draws for them. Nothing in the pool depended
 * on that until Sona - Harmonious, and it is the kind of ordering that fails
 * silently: a listener reading `state.activePlayerIndex` instead of the event
 * would fire on exactly the turns it should not, and the card would still
 * "work" in a fixture that never rotated.
 *
 * These tests exist to pin the behaviour BEFORE more cards ride on it. Every
 * assertion goes through the real `submit`, because the whole risk lives in the
 * composition of runEnd/runStartOfTurn/runCleanup that only `submit` performs.
 */

const registry = defaultCardRegistry();
const SONA_HARMONIOUS = "OGN-073";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const exhausted = (id: string): RuneCard => ({ id, domain: "Calm", state: "Exhausted" });

/** Player 0 about to end their turn, with Sona somewhere and both players'
 *  pools fully exhausted. Both pools, so an assertion that the RIGHT player's
 *  runes readied has something to be wrong about. */
function endingTurnWithSona(sonaAt: "bf1" | "base", sonaOwner: 0 | 1 = 0): GameState {
  const sona = realUnitInstance(SONA_HARMONIOUS);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  for (const index of [0, 1] as const) {
    state.players[index]!.channeled = [exhausted(`r${index}a`), exhausted(`r${index}b`)];
  }
  if (sonaAt === "bf1") state.battlefields[0]!.units = { [state.players[sonaOwner]!.id]: [sona] };
  else state.players[sonaOwner]!.baseUnits = [sona];
  return state;
}

const readyCount = (state: GameState, playerIndex: 0 | 1) =>
  state.players[playerIndex]!.channeled.filter((r) => r.state === "Ready").length;

/** Drives a closed chain to resolution through the real actions, the way two
 *  players at the board would. */
function passUntilChainEmpty(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody was offered a PassFocus while the chain was closed — the trigger is stranded").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

describe("Sona - Harmonious (OGN-073): an end-of-turn trigger across the rotation", () => {
  it("reaches the CHAIN, and has not resolved by the time the next turn starts", () => {
    const before = endingTurnWithSona("bf1");
    const after = accept(before, { type: "Pass", playerIndex: 0 });

    // Asserted on `spellChain`, never on `pendingTriggers` — `submit` runs
    // `runCleanup`, whose last step drains the pen onto the chain, so the pen is
    // always empty by the time a post-`submit` assertion can look at it.
    const onChain = after.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId);
    expect(onChain, "the end-of-turn trigger never reached the chain").toContain(SONA_HARMONIOUS);
    expect(after.chainOpen, "a Pending Item finalized onto the chain must CLOSE it").toBe(false);

    // The rotation really did happen underneath the held trigger.
    expect(after.activePlayerIndex).toBe(1);
    expect(after.phase).toBe("Action");

    // Player 1's Awaken readied THEIR pool; player 0's is still exhausted,
    // because Sona has not resolved yet. That is the positive control for every
    // assertion below — without it "0 ready" and "not yet resolved" look alike.
    expect(readyCount(after, 1), "the next player's Awaken should have readied their own pool").toBe(2);
    expect(readyCount(after, 0), "Sona resolved too early").toBe(0);
  });

  it("readies HER controller's runes, not the new active player's", () => {
    // The assertion the whole file is for. At resolution `activePlayerIndex` is
    // 1, so a resolver reading the board rather than `event.playerIndex` would
    // ready player 1's pool — which is already full from their Awaken, and so
    // would show up as Sona doing nothing at all rather than as an error.
    const resolved = passUntilChainEmpty(accept(endingTurnWithSona("bf1"), { type: "Pass", playerIndex: 0 }));

    expect(resolved.activePlayerIndex, "still the opponent's turn when it resolved").toBe(1);
    expect(readyCount(resolved, 0), "Sona's controller's runes were not readied").toBe(2);
  });

  it("leaves the game playable — the new active player can act once the chain empties", () => {
    // A stranded Pending Item is the failure this whole conversion has to avoid,
    // and it does not announce itself: the state looks fine, nothing throws, and
    // only "whose move is it" is wrong forever.
    const resolved = passUntilChainEmpty(accept(endingTurnWithSona("bf1"), { type: "Pass", playerIndex: 0 }));

    expect(resolved.chainOpen).toBe(true);
    expect(resolved.spellChain).toHaveLength(0);
    expect(resolved.pendingTriggers).toHaveLength(0);
    expect(legalActions(resolved).some((a) => a.playerIndex === 1)).toBe(true);
  });

  it("does NOT fire when she is in base — 'if I'm at a battlefield'", () => {
    const after = accept(endingTurnWithSona("base"), { type: "Pass", playerIndex: 0 });

    expect(after.spellChain.filter((e) => e.kind === "trigger")).toHaveLength(0);
    expect(readyCount(after, 0)).toBe(0);
  });

  it("does NOT fire on the OPPONENT's end of turn — 'at the end of YOUR turn'", () => {
    // Sona belongs to player 1; player 0 is the one ending a turn. Read off the
    // board at resolution time this would be backwards TWICE over, since by then
    // player 1 IS the active player.
    const after = accept(endingTurnWithSona("bf1", 1), { type: "Pass", playerIndex: 0 });

    expect(after.spellChain.filter((e) => e.kind === "trigger")).toHaveLength(0);
    // Player 1's own Awaken readied their pool; that is the Awaken, not Sona.
    expect(readyCount(after, 1)).toBe(2);
  });

  it("fires on her own controller's turn, one turn later", () => {
    // The same board as the negative above, played on round further: once it IS
    // player 1's turn ending, Sona triggers. Without this, "does not fire" could
    // equally mean "never fires".
    const first = passUntilChainEmpty(accept(endingTurnWithSona("bf1", 1), { type: "Pass", playerIndex: 0 }));
    // Player 1's pool is Ready from their Awaken, so exhaust it again — otherwise
    // `readyRunes` has nothing to do and the test would pass on a no-op.
    const spent: GameState = {
      ...first,
      players: [first.players[0]!, { ...first.players[1]!, channeled: [exhausted("r1a"), exhausted("r1b")] }],
    };

    const after = passUntilChainEmpty(accept(spent, { type: "Pass", playerIndex: 1 }));
    expect(readyCount(after, 1)).toBe(2);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SONA_HARMONIOUS))).toBe(true);
  });
});
