import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-038 Skyward Strike — the `[Level 6]` slot is not OFFERED below the level.**
 *
 * "Move an enemy unit. [Level 6][>] [Stun] an enemy unit."
 *
 * **355.8** declares targets at finalization, so a clause that is Inactive
 * (824.1.d, below N XP) must not be offering one. The engine enumerated the
 * second slot at any XP and let the resolver drop it, so below 6 XP a caster
 * could name a stun target and watch it do nothing — an over-OFFER.
 *
 * That is the same shape as the Tideturner report ("not triggering"): the card
 * appears to accept a choice and then ignores it, which from the seat is
 * indistinguishable from a bug. It is worth fixing for exactly that reason even
 * though the EFFECT was never wider than printed.
 *
 * # Why the resolver still checks, and UNL-040 does not
 *
 * These two cards look like one divergence and are two different rules.
 *
 *  - **UNL-040 Wuju Apprentice** is a TRIGGERED ability. 727.1.c.1 puts the
 *    question at the moment the trigger is evaluated, and 383.3 makes the chain
 *    item independent afterwards — so it is asked ONCE, at trigger time, and
 *    never again. Its gate moved out of `resolve` entirely.
 *  - **Skyward Strike is a SPELL.** Its clause is part of its own text resolving
 *    from the chain, not a triggered ability, so 727.1.c.1 does not reach it.
 *    824.1.d makes the clause Inactive below the threshold whenever it is read —
 *    so the offer is gated at finalization AND the effect is still gated at
 *    resolution. Both checks are correct, for different reasons.
 *
 * The stated blocker was "a `TargetingSpec` is STATIC — it cannot ask the board".
 * The object is; the enumeration around it is not, and the very loop that emits
 * these pairs already asks the board twice (`sameBattlefield`,
 * `secondMightBelowFirst`).
 */

const SKYWARD_STRIKE = "UNL-038";
const LEVEL = 6;
const registry = defaultCardRegistry();

/** Skyward Strike in hand and payable, two enemy units to choose between. */
function board(xp: number): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.xp = xp;
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: {
      p1: [makeUnit({ instanceId: "mine", name: "Mine" })],
      p2: [makeUnit({ instanceId: "e1", name: "E1" }), makeUnit({ instanceId: "e2", name: "E2" })],
    },
  };
  state.players[0]!.hand = [createCardInstance(registry.get(SKYWARD_STRIKE))];
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

const plays = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === SKYWARD_STRIKE);

const withStun = (state: GameState) => plays(state).filter((a) => a.secondTargetUnitInstanceId !== undefined);
const moveOnly = (state: GameState) => plays(state).filter((a) => a.secondTargetUnitInstanceId === undefined);

describe("the card is what this file thinks it is", () => {
  it("prints the Level clause on the stun only", () => {
    const def = registry.get(SKYWARD_STRIKE);
    expect(def.name).toBe("Skyward Strike");
    const text = "text" in def ? String(def.text) : "";
    expect(text, "the Level clause has changed").toContain(`[Level ${LEVEL}]`);
    expect(text, "the move clause has changed").toContain("Move an enemy unit");
  });
});

describe("below the level, only the MOVE is offered", () => {
  it("offers no stun target at all", () => {
    expect(
      withStun(board(LEVEL - 1)),
      "a [Level 6] stun target was offered below the level — the caster can name it and it does nothing",
    ).toHaveLength(0);
  });

  it("still offers the move — the card is not unplayable", () => {
    // The half that keeps this from being "gate the whole card". The move has no
    // Level clause and is always available.
    expect(moveOnly(board(LEVEL - 1)).length, "Skyward Strike became unplayable below the level").toBeGreaterThan(0);
  });
});

describe("at the level, both slots are offered", () => {
  it("offers stun targets at exactly the threshold", () => {
    expect(
      withStun(board(LEVEL)).length,
      "no stun was offered at the level, so the assertion above proves nothing",
    ).toBeGreaterThan(0);
  });

  it("still offers the move-only play too — the stun is 'up to'", () => {
    expect(moveOnly(board(LEVEL)).length, "the move-only play disappeared at the level").toBeGreaterThan(0);
  });

  it("never names the same unit twice", () => {
    for (const play of withStun(board(LEVEL))) {
      expect(play.targetUnitInstanceId, "a play named one unit for both slots").not.toBe(
        play.secondTargetUnitInstanceId,
      );
    }
  });
});

describe("the ENUMERATOR and the VALIDATOR agree", () => {
  it("every offered play is accepted at the level", () => {
    const state = board(LEVEL);
    const offered = plays(state);
    expect(offered.length, "nothing was offered").toBeGreaterThan(0);
    for (const play of offered) {
      expect(validatePlayCard(state, play).ok, `an offered play was refused: ${JSON.stringify(play)}`).toBe(true);
    }
  });

  it("...and below it", () => {
    const state = board(LEVEL - 1);
    const offered = plays(state);
    expect(offered.length, "nothing was offered below the level").toBeGreaterThan(0);
    for (const play of offered) {
      expect(validatePlayCard(state, play).ok, `an offered play was refused: ${JSON.stringify(play)}`).toBe(true);
    }
  });

  it("REFUSES a hand-built stun below the level", () => {
    // The other direction: gating only the enumerator would leave the validator
    // accepting a stun the board would never offer — the offered-then-refused's
    // mirror image, and just as much a drift.
    const state = board(LEVEL - 1);
    const base = moveOnly(state)[0]!;
    const forged = validatePlayCard(state, { ...base, secondTargetUnitInstanceId: "e2" });
    expect(forged.ok, "a hand-built [Level 6] stun was accepted below the level").toBe(false);
  });
});

describe("the RESOLVER still checks, and that is not redundant", () => {
  it("drops the stun when XP is spent between finalization and resolution", () => {
    // **The assertion that stops the resolver's `atLevel` reading as dead code.**
    //
    // A mutation run reports it redundant against every other test here, because
    // they all keep XP still. It is not: this is a SPELL, so 727.1.c.1 — which
    // put UNL-040 Wuju Apprentice's gate at trigger time and forbade re-asking —
    // does not reach it. 824.1.d makes the clause Inactive whenever it is read,
    // and a spell's text is read at RESOLUTION, so XP spent in the response
    // window its own cast opens legitimately turns the stun off.
    //
    // That is the opposite answer from UNL-040's, on the same keyword, and the
    // difference is triggered-ability versus spell. Pinning it here is what stops
    // a later "unify the two Level gates" from being an easy-looking mistake.
    const state = board(LEVEL);
    const withStunPlay = withStun(state)[0];
    expect(withStunPlay, "no stun play to submit").toBeDefined();

    const after = submit(state, withStunPlay!);
    expect(after.result.type, "the play was refused").toBe("Ok");

    // Spent while the spell sits on the chain.
    const drained: GameState = {
      ...after.state,
      players: [{ ...after.state.players[0]!, xp: 0 }, after.state.players[1]!],
    };
    const settled = resolveHeldTriggers(drained);
    const stunned = [...(settled.battlefields[0]?.units.p2 ?? [])].find(
      (u) => u.instanceId === withStunPlay!.secondTargetUnitInstanceId,
    );
    expect(stunned?.stunned, "the stun fired for a clause that was Inactive when it resolved").not.toBe(true);
  });

  it("...and keeps it when the XP stays — the control", () => {
    const state = board(LEVEL);
    const withStunPlay = withStun(state)[0]!;
    const settled = resolveHeldTriggers(submit(state, withStunPlay).state);
    const stunned = [...(settled.battlefields[0]?.units.p2 ?? [])].find(
      (u) => u.instanceId === withStunPlay.secondTargetUnitInstanceId,
    );
    expect(stunned?.stunned, "the stun never fires at all, so the assertion above proves nothing").toBe(true);
  });
});
