import { describe, expect, it } from "vitest";
import { BASELINE_WEIGHTS, chooseAction, HUMAN_OPPONENT_WEIGHTS, rolloutBeamTruncated } from "../src/ai/heuristic-ai.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * The own-turn rollout, and the one way it fails silently.
 *
 * `ownTurnRollout` scores every candidate on the state at the END of the acting
 * player's turn instead of on the state its own resolution settles into. It
 * measured 71% on the presets and 59% on the VEN covering decks — but the FIRST
 * version of it measured **0.25%**, one win in four hundred, and the reason is
 * the thing these tests exist to pin.
 *
 * `Pass` is one of the candidates. If the rollout runs on it like any other, it
 * scores Pass as "play my whole turn out, then end it" — which is exactly what
 * the best real action scores, because the rollout would then play that action
 * anyway. Every candidate ties with Pass, `legalActions` pushes Pass first and
 * `bestActionFor` compares with a strict `>`, so the AI ends its turn having
 * done nothing while its lookahead believes it played it.
 *
 * **That failure is invisible to every other instrument.** No exception, no
 * invalid action, no stall; `ai-health` stays 40/40 because passing terminates
 * games perfectly well. The only signals were the win rate and the action mix
 * (`MoveUnit` 107 against 1280). So it is pinned here, at the level of "does the
 * AI still do things", rather than left to a self-play figure nobody diffs.
 */

const ROLLOUT = { ...BASELINE_WEIGHTS, ownTurnRollout: true };

/**
 * A board where acting is unambiguously better than not acting: the AI has a
 * unit in base and an empty battlefield to walk onto, which opens the Non-Combat
 * Showdown that scores it.
 *
 * Deliberately NOT a board where the right play is subtle. The property under
 * test is "the rollout has not collapsed every candidate into a tie with Pass",
 * and a subtle board cannot distinguish that from ordinary disagreement.
 */
function anObviousMoveIsAvailable() {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral" });
  state.players[0]!.baseUnits = [makeUnit({ name: "Walker", might: 4 })];
  return state;
}

describe("the own-turn rollout still acts", () => {
  it("does not collapse into Pass when a move is clearly better", () => {
    const action = chooseAction(anObviousMoveIsAvailable(), ROLLOUT);
    // The specific action is not the assertion — "not Pass" is. Pinning the
    // exact move would make this fail for any future change of preference
    // between two good actions, which is not what went wrong.
    expect(action.type).not.toBe("Pass");
  });

  it("agrees with the shipping AI that acting beats passing", () => {
    // The positive control on the test above. If the baseline ALSO passed here,
    // "not Pass" would be asserting something about this fixture rather than
    // about the rollout, and the 0.25% regression would slip through a green
    // test on a board where nobody wants to act.
    expect(chooseAction(anObviousMoveIsAvailable(), BASELINE_WEIGHTS).type).not.toBe("Pass");
  });

  it("terminates on a board with several things worth doing", () => {
    // The rollout re-enters `bestActionFor` with the flag cleared, which is the
    // depth guard. Without it this does not fail an assertion — it never
    // returns, which is why this is a timeout rather than an equality, exactly
    // like the two-ply search's own guard test.
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral" });
    state.players[0]!.baseUnits = [
      makeUnit({ name: "A", might: 3 }),
      makeUnit({ name: "B", might: 4 }),
      makeUnit({ name: "C", might: 2 }),
    ];
    state.players[1]!.baseUnits = [makeUnit({ name: "D", might: 3 })];
    expect(chooseAction(state, ROLLOUT)).toBeDefined();
  }, 10000);
});

describe("the two policies", () => {
  it("BASELINE_WEIGHTS — what the instruments measure — leaves the rollout off", () => {
    // ~11.8x runtime, so the probes keep the cheap policy. Every pinned figure
    // in CLAUDE.md was measured through this, `walkout`'s deterministic
    // 190/113/29 included; flipping it must be deliberate and show in a diff.
    expect(BASELINE_WEIGHTS.ownTurnRollout).toBe(false);
  });

  it("HUMAN_OPPONENT_WEIGHTS — what a person plays — turns it on", () => {
    expect(HUMAN_OPPONENT_WEIGHTS.ownTurnRollout).toBe(true);
  });

  it("differs from the baseline by that flag and NOTHING else", () => {
    // The invariant that keeps one divergence from becoming two. Every weight is
    // tuned against `BASELINE_WEIGHTS`, so a second hand-edited tuning here would
    // mean the numbers in those doc comments describe a policy nobody plays —
    // and no probe could see it, because no probe runs this constant.
    expect(HUMAN_OPPONENT_WEIGHTS).toEqual({ ...BASELINE_WEIGHTS, ownTurnRollout: true });
  });
});

describe("the action-space un-filters", () => {
  it("banks resources, and that one is kept on REACHABILITY not win rate", () => {
    // Exactly 50.0% in both configurations (200/200 without the rollout,
    // 100/100 with it, SFD covering decks). What earns it is coverage: it takes
    // `reachability` from 798 to 800, and both new cards are UNL-234 Diana -
    // Scorn of the Moon, a LEGEND whose only ability is "[Exhaust]: [Add] 1
    // Energy". She can never be drawn or played, so this flag is the ONLY
    // mechanism in the engine that can exercise her. Turning it off makes her
    // unreachable by construction, which no probe would report as a regression
    // in anything but the union total.
    expect(BASELINE_WEIGHTS.bankAbilities).toBe(true);
  });

  it("does not float runes — measured at 0%, not assumed", () => {
    // The AI floats 415 times per 20 games and plays 70 cards against the
    // baseline's 161. Floating is always the first step of a better plan, and
    // `chooseAction` returns only first steps, so it prepares forever. Fixing it
    // needs the AI to COMMIT to a rollout's plan, which is a different policy
    // rather than a flag — so this stays off until that exists.
    expect(BASELINE_WEIGHTS.floatRunes).toBe(false);
  });

  it("does not hide cards — could not be measured, rather than lost", () => {
    // 48% ±6.9 on 46 Hides across 200 games; 1 Hide per 20 games on the presets.
    // `hideCardCandidates` needs a [Hidden] card in hand AND a battlefield you
    // already control with room, at once, so the blocker is that the action is
    // barely enumerable. Another A/B run will not resolve it.
    expect(BASELINE_WEIGHTS.hideCards).toBe(false);
  });
});

describe("the beam boundary", () => {
  it("is asserted from both sides", () => {
    // `ROLLOUT_BEAM` is what keeps the worst decision at 153 ms instead of 954,
    // and it runs synchronously on the browser's UI thread. Pinned from both
    // sides for the reason `groupedMoveTruncated` is: a truncation nobody can
    // see reads as full lookahead.
    expect(rolloutBeamTruncated(8)).toBe(false);
    expect(rolloutBeamTruncated(9)).toBe(true);
  });

  it("does not truncate a fan-out the AI can afford in full", () => {
    // The median decision offers ~8 candidates, so the common case must go
    // through un-beamed — otherwise this "optimisation" would be changing the
    // policy on almost every turn rather than on the 0.3% that were expensive.
    expect(rolloutBeamTruncated(1)).toBe(false);
  });
});
