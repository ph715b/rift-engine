import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { GOLD_TOKEN, GOLD_TOKEN_DEF_ID, placeGearToken } from "../src/engine/token.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";

/**
 * **OGN-111 Heimerdinger - Inventor borrowing a "Kill this" cost.**
 *
 * He prints *"I have all `[Exhaust]` abilities of all friendly legends, units, and
 * gear."* Two abilities in the pool cost `[Exhaust]` alongside a self-kill — the
 * Gold gear token's *"Kill this, `[Exhaust]`: `[Add]` `[rainbow]`"* and SFD-134
 * Zero Drive's — so he has them, and paying one asks him to kill "this".
 *
 * # The crash this pins
 *
 * `payActivationCost` paid `killSelf` by finding the instance in `activeGear`.
 * Heimerdinger is a Unit, so it returned undefined and `execute-activate-ability`
 * THREW: *"Heimerdinger - Inventor's activation cost cannot be paid"*. The AI
 * applies enumerated actions straight to the executor rather than through the
 * validator, so this killed a `battlefield-reach` run outright instead of failing
 * a validation.
 *
 * Latent since the two cards first coexisted, and surfaced on 2026-08-24 by the
 * ability-timing gate — which touches nothing on this path. It changed which
 * actions the AI is offered in Showdowns, the trajectories moved, and the fixed
 * seeds reached a board where Heimerdinger and a Gold token stood together.
 *
 * # The reading, which is recorded rather than settled
 *
 * "Kill THIS" names the object that has the ability. **136.2.d** settles the
 * nearest analogous case in as many words — Effect Text's "this" refers to the
 * attached object that appended the ability, *"not the Top-Most Card"* — and
 * **395** confirms abilities granted to another Game Object keep their internal
 * references. So it kills Heimerdinger.
 *
 * **The first fix refused the activation on both sides instead** (416.3, "a cost
 * that cannot be completed is not one you may choose to pay"), which closed the
 * crash by withholding a play the rules allow. This project's standing ruling is
 * that the engine is a digital version of the paper game and never withholds a
 * legal one, so the cost is paid.
 *
 * **Killing yourself to add one rune is a terrible play and a legal one.** The
 * rules PDF does not name Heimerdinger and "`[Exhaust]` ability" is not a defined
 * term, so this is a reading — `docs/rules-conformance.md` carries it, and this
 * test is what makes overruling it fail loudly rather than silently.
 */

const HEIMERDINGER = "OGN-111";

const goldTokenActivations = (state: GameState, heimId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === heimId && a.viaAbilityDefId === GOLD_TOKEN_DEF_ID,
  );

/**
 * Heimerdinger in base beside a friendly Gold token, which is what makes him have
 * its ability at all.
 *
 * The token is built through `placeGearToken` rather than `realGearInstance`,
 * because **it has no card entry to look up** — `shouldSkip` keeps Token-supertype
 * entries out of the registry, and that absence is the same one that makes its
 * ability printable only in its parents' reminder text. `entersExhausted: false`
 * because the cost includes an exhaust and this fixture has to be able to pay it.
 */
function board(): { state: GameState; heimId: string; goldId: string } {
  const heim = realUnitInstance(HEIMERDINGER);
  const base = makeState({ phase: "Action", activePlayerIndex: 0 });
  base.players[0]!.baseUnits = [{ ...heim, exhausted: false }];
  const state = placeGearToken(base, 0, GOLD_TOKEN, false);
  const gold = state.players[0]!.activeGear.at(-1)!;
  expect(gold.defId, "the token fixture is not a Gold").toBe(GOLD_TOKEN_DEF_ID);
  return { state, heimId: heim.instanceId, goldId: gold.instanceId };
}

describe("the fixture really gives him the borrowed ability", () => {
  it("offers the Gold token's ability with Heimerdinger as the source", () => {
    // Every assertion below is about this action existing. Without it they would
    // all pass on a board where he had never borrowed anything.
    const { state, heimId } = board();
    expect(goldTokenActivations(state, heimId).length, "he never borrowed the token's ability").toBeGreaterThan(0);
  });

  it("...and it is a DIFFERENT action from the token activating its own", () => {
    // The token can still pay for itself the ordinary way. If the borrow had
    // somehow replaced that, the test above would be measuring the wrong action.
    const { state, goldId } = board();
    const own = legalActions(state).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === goldId,
    );
    expect(own.length, "the token lost its own ability").toBeGreaterThan(0);
  });
});

describe("paying it kills HEIMERDINGER, not the token", () => {
  it("does not throw — the crash this pins", () => {
    // `submit` rather than the validator, because the throw was in the EXECUTOR
    // and the validator never saw it. This is the assertion that would have caught
    // the original defect.
    const { state, heimId } = board();
    const { result } = submit(state, goldTokenActivations(state, heimId)[0]!);
    expect(result, `refused or threw: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  });

  it("Heimerdinger dies", () => {
    const { state, heimId } = board();
    const after = resolveHeldTriggers(submit(state, goldTokenActivations(state, heimId)[0]!).state);
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === heimId), "he survived his own cost").toBe(false);
  });

  it("...and the Gold token does NOT — 'this' is the object with the ability", () => {
    // The half that decides the reading. An implementation that killed the token
    // instead would satisfy "something died" and be a different ruling.
    const { state, heimId, goldId } = board();
    const after = resolveHeldTriggers(submit(state, goldTokenActivations(state, heimId)[0]!).state);
    expect(after.players[0]!.activeGear.some((g) => g.instanceId === goldId), "it killed the token instead").toBe(true);
  });

  it("and the rune is actually added — the ability resolves after its source is gone", () => {
    // 383.3 and 377.3.a.1: a chain item is independent of the card that made it.
    // Without this the cost could be paid for nothing and everything above would
    // still be green.
    const { state, heimId } = board();
    const before = state.players[0]!.floatingRainbowPower;
    const after = resolveHeldTriggers(submit(state, goldTokenActivations(state, heimId)[0]!).state);
    expect(after.players[0]!.floatingRainbowPower, "he died and got nothing").toBeGreaterThan(before);
  });
});

describe("the enumerator and the validator agree about it", () => {
  it("the validator accepts what the enumerator offered", () => {
    // The pair that broke. A fix to one side alone reproduces this repo's most
    // repeated bug from the other direction — and the FIRST fix here made them
    // agree on refusing, which is the opposite error.
    const { state, heimId } = board();
    expect(validateActivateAbility(state, goldTokenActivations(state, heimId)[0]!)).toMatchObject({ ok: true });
  });

  it("a killSelf ability whose source is in NEITHER zone is still refused", () => {
    // The negative control for the widening, and the reason it is a widening
    // rather than a removal: a source that cannot die still cannot pay (416.3).
    // Heimerdinger is not on the board here, so nothing can be killed for it.
    const { state, heimId } = board();
    const action = goldTokenActivations(state, heimId)[0]!;
    const gone: GameState = {
      ...state,
      players: state.players.map((p, i) => (i === 0 ? { ...p, baseUnits: [] } : p)) as GameState["players"],
    };
    expect(validateActivateAbility(gone, action), "an absent source paid a kill cost").toMatchObject({ ok: false });
  });
});

describe("an ordinary Gold token is untouched", () => {
  it("still kills ITSELF when it pays its own cost", () => {
    // The scope control. The widening must not change what the ability does for
    // every card that is not Heimerdinger — which is all of them.
    const base = makeState({ phase: "Action", activePlayerIndex: 0 });
    base.players[0]!.baseUnits = [makeUnit({ instanceId: "bystander" })];
    const state = placeGearToken(base, 0, GOLD_TOKEN, false);
    const gold = state.players[0]!.activeGear.at(-1)!;

    const own = legalActions(state).find(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === gold.instanceId,
    );
    const after = resolveHeldTriggers(submit(state, own!).state);

    expect(after.players[0]!.activeGear.some((g) => g.instanceId === gold.instanceId), "it survived its own cost").toBe(
      false,
    );
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === "bystander"), "it killed a bystander").toBe(true);
  });
});
