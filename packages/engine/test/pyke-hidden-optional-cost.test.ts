import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **UNL-028 Pyke - Dockside Butcher, played FROM HIDDEN, may still pay his
 * optional additional cost.**
 *
 * He prints `[Hidden]`, `[Ganking]`, "You may pay [Fury] as an additional cost to
 * play me", and "When you play me, if you paid the additional cost, ready me and
 * give me +2 [Might] this turn."
 *
 * Reported from playtesting: *"playing red pyke from hidden triggers but doesn't
 * prompt me with the option to pay a chaos to give him +2 might."* (The rune is
 * Fury, not Chaos — red either way, and the card is unmistakable.) The trigger
 * fired and always took the unpaid branch, because the paid variant was never
 * enumerated.
 *
 * # The guard, and the argument that had stopped being true
 *
 * `legal-actions` gated the optional-cost variant on `!fromHidden`, and three
 * neighbouring branches (XP, `[Repeat]`, `[Accelerate]`) carry the same guard with
 * a note saying: *"811 ignores a hidden card's BASE cost and an additional cost is
 * not that, so this is a real if currently unreachable simplification."*
 *
 * **The rules half is right.** 811.1.b waives "its base cost"; **204.1** puts the
 * Base Cost "in the upper left corner of the card" and **204.2** defines an
 * Additional Cost as one "in addition to the base cost". So a from-hidden play
 * still may pay it.
 *
 * **The unreachability half is what expired.** Measured across the pool: exactly
 * ONE card prints `[Hidden]` and an additional cost, and it is this one. The other
 * three branches keep their guard and their notes are now verified rather than
 * asserted — no `[Hidden]` card carries `[Accelerate]`, `[Repeat]` or an optional
 * XP cost.
 *
 * # The second half of the fix
 *
 * The paid variant is built as a BASE play, and a base play is the one
 * destination 811.1.d.1 forbids a from-hidden unit. So it also carries
 * `destinationBattlefieldId`, or the enumerator would offer what the validator
 * refuses — hence the agreement test below.
 */

const PYKE = "UNL-028";
const registry = defaultCardRegistry();

/** Pyke hidden at bf1 since last turn, with Fury available to pay the extra. */
function hidden(): { state: GameState; pykeId: string } {
  const pyke = createCardInstance(registry.get(PYKE));
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnNumber: 3 });
  state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    domain: "Fury" as const,
    state: "Ready" as const,
  }));
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    controllerId: "p1",
    units: { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] },
    hiddenCards: [{ ownerIndex: 0, card: pyke, hiddenOnTurn: 1 }],
  };
  return { state, pykeId: pyke.instanceId };
}

const hiddenPlays = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.defId === PYKE && a.fromHiddenBattlefieldId !== undefined,
  );

/** Found by DEFID rather than instance id: the played card is a fresh instance,
 *  so the id it carried in the hidden zone is not the one on the board. */
const onBoard = (state: GameState) =>
  state.battlefields.flatMap((bf) => bf.units["p1"] ?? []).find((u) => u.defId === PYKE);

describe("the optional cost is OFFERED from hidden", () => {
  it("offers both a paid and an unpaid variant", () => {
    const { state } = hidden();
    const plays = hiddenPlays(state);

    expect(plays.some((p) => p.optionalPowerPaid === true), "the reported bug: no paid variant").toBe(true);
    // Both, not one — the cost is OPTIONAL, so declining must stay available.
    expect(plays.some((p) => p.optionalPowerPaid !== true), "the unpaid variant vanished").toBe(true);
  });

  it("the paid variant really spends a rune", () => {
    // Otherwise "paid" would be a flag with no price, and the payoff would be free.
    const { state } = hidden();
    const paid = hiddenPlays(state).find((p) => p.optionalPowerPaid === true)!;
    expect(paid.payment.powerRunes.length, "the paid variant costs nothing").toBe(1);
  });

  it("and it lands at the battlefield it was hidden at, not in base (811.1.d.1)", () => {
    const { state } = hidden();
    const paid = hiddenPlays(state).find((p) => p.optionalPowerPaid === true)!;
    expect(paid.destinationBattlefieldId, "the paid variant was aimed at base, which 811 forbids").toBe("bf1");
  });

  /**
   * **The offered-then-refused half — and `validatePlayCard` alone does NOT
   * measure it.**
   *
   * The first version of this fix passed a `validatePlayCard` check and was still
   * broken: `submit` refused its own enumerated action with "Pyke - Dockside
   * Butcher costs 0 energy after floating Energy, payment supplied 3". There are
   * THREE pricing sites — enumerator, validator, executor — and only driving the
   * real action path exercises all of them. So this asserts through `submit`, and
   * keeps the direct validator call beside it as the cheaper diagnostic.
   */
  it("...and SUBMIT accepts it, not just the validator", () => {
    const { state } = hidden();
    const paid = hiddenPlays(state).find((p) => p.optionalPowerPaid === true)!;

    expect(validatePlayCard(state, paid), "the validator refused it").toMatchObject({ ok: true });
    const { result } = submit(state, paid);
    expect(result, `submit refused its own enumerated action: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  });
});

describe("paying it gets the payoff", () => {
  it("readies him and gives +2 Might this turn", () => {
    const { state } = hidden();
    const paid = hiddenPlays(state).find((p) => p.optionalPowerPaid === true)!;
    const after = resolveHeldTriggers(submit(state, paid).state);

    const pyke = onBoard(after);
    expect(pyke, "he never arrived").toBeDefined();
    expect(pyke!.mightThisTurn, "the +2 did not land").toBe(2);
    // "Ready me" — a unit normally enters exhausted (143.4), so this is
    // observable and is the other half of the printed payoff.
    expect(pyke!.exhausted, "he entered exhausted despite the paid cost").toBe(false);
  });

  it("and DECLINING gets neither — the control", () => {
    // Without this, the assertions above would also pass on an engine that gave
    // the payoff to every from-hidden play regardless of payment.
    const { state } = hidden();
    const unpaid = hiddenPlays(state).find((p) => p.optionalPowerPaid !== true)!;
    const after = resolveHeldTriggers(submit(state, unpaid).state);

    const pyke = onBoard(after);
    expect(pyke, "he never arrived").toBeDefined();
    expect(pyke!.mightThisTurn, "the +2 landed without paying").toBe(0);
    expect(pyke!.exhausted, "he entered ready without paying").toBe(true);
  });
});

describe("the other three branches keep their guard", () => {
  it("no [Hidden] card in the pool carries [Accelerate], [Repeat] or an optional XP cost", () => {
    // The measurement the neighbouring notes assert. If a future card breaks it,
    // that branch needs the same fix and this is what says so — the notes claim
    // unreachability, and unreachability is a fact about the POOL that expires.
    const offenders = registry
      .all()
      .filter((def) => {
        const text = "text" in def ? String(def.text) : "";
        if (!text.includes("[Hidden]")) return false;
        return /\[Accelerate\]|\[Repeat\]/.test(text) || /pay \d+ XP as an additional/i.test(text);
      })
      .map((def) => `${def.id} ${def.name}`);

    expect(offenders, "a [Hidden] card now carries one of the other additional costs").toEqual([]);
  });
});
