import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Wave 8 — **UNL-201 Kha'Zix - Voidreaver's third clause**, "Spend 2 XP,
 * [Exhaust]: Move an exhausted friendly unit from a battlefield to its base."
 *
 * This is the clause wave 6 refused and wave 7 named the fix for. It became
 * writable when `ActivationCost.xp` landed, so the two printed abilities are now
 * MODES of one registry entry, priced separately.
 *
 * # What this file has to prove, and why the obvious tests do not
 *
 * Everything is driven through `legalActions` + `submit`. A test that called the
 * mode's `resolve` closure would pass against a registry entry no enumerator ever
 * reaches — and this card is the shape where that matters most, because the whole
 * change is about the ENUMERATOR and the VALIDATOR agreeing on a per-mode price.
 * A resolver test cannot see either.
 *
 * Two things are therefore counted rather than assumed:
 *
 *  - the `home` mode is genuinely OFFERED (a `modeId` on a real enumerated
 *    action), and submitting it really moves the body — not just "the state
 *    changed";
 *  - the `buff` mode still costs exactly 1 and not 2. The XP moved from
 *    `resolve` into `payActivationCost` in the same change, so the live failure
 *    mode is a DOUBLE spend, which no "did the buff land" assertion can see.
 *
 * Every refusal below has a positive control off the same fixture with one field
 * changed, so a `0` can never be mistaken for an enumerator that never ran.
 */

const registry = defaultCardRegistry();

const KHAZIX_VOIDREAVER = "UNL-201";
/** Minotaur Reckoner — "Units can't move to base." The only card in the pool that
 *  can make this clause legal-but-inert. */
const MINOTAUR_RECKONER = "SFD-014";

const BUFF_MODE = "buff";
const HOME_MODE = "home";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const activationsOf = (state: GameState, instanceId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

const unitAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

const inBase = (state: GameState, instanceId: string, playerIndex: 0 | 1 = 0): boolean =>
  state.players[playerIndex]!.baseUnits.some((u) => u.instanceId === instanceId);

function withLegend(state: GameState, playerIndex: 0 | 1, defId: string): GameState {
  const owner = state.players[playerIndex]!;
  state.players[playerIndex] = {
    ...owner,
    legend: { ...owner.legend, defId, name: registry.get(defId).name },
  };
  return state;
}

const legendId = (state: GameState, playerIndex: 0 | 1 = 0) => state.players[playerIndex]!.legend.instanceId;

/**
 * Kha'Zix on side 0 at `xp`, with an EXHAUSTED friendly at bf1 (`tired`), a READY
 * friendly at bf1 (`fresh`), an EXHAUSTED friendly at HOME (`resting`), and an
 * exhausted ENEMY at bf1 (`theirs`).
 *
 * One board carries all four negative controls, so each "not offered" assertion
 * is measured against a fixture that is simultaneously proving the positive.
 */
function khazixBoard(xp: number): GameState {
  const state = withLegend(makeState({ phase: "Action", activePlayerIndex: 0 }), 0, KHAZIX_VOIDREAVER);
  state.players[0]!.xp = xp;
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "resting", name: "resting", might: 3, exhausted: true })];
  state.battlefields[0]!.units = {
    p1: [
      makeUnit({ instanceId: "tired", name: "tired", might: 3, exhausted: true }),
      makeUnit({ instanceId: "fresh", name: "fresh", might: 3 }),
    ],
    p2: [makeUnit({ instanceId: "theirs", name: "theirs", might: 3, exhausted: true })],
  };
  return state;
}

const homeOffers = (state: GameState): ActivateAbilityAction[] =>
  activationsOf(state, legendId(state)).filter((a) => a.modeId === HOME_MODE);
const buffOffers = (state: GameState): ActivateAbilityAction[] =>
  activationsOf(state, legendId(state)).filter((a) => a.modeId === BUFF_MODE);

const settle = (state: GameState) => answerDecisions(resolveHeldTriggers(state));

// ---------------------------------------------------------------------------
// The clause itself
// ---------------------------------------------------------------------------

describe("Kha'Zix - Voidreaver (UNL-201): Spend 2 XP, [Exhaust]: move an exhausted friendly home", () => {
  it("sends the exhausted friendly to base, spends exactly 2 XP and exhausts him", () => {
    const state = khazixBoard(5);
    const action = homeOffers(state).find((a) => a.targetUnitInstanceId === "tired");
    expect(action, "the move-home mode was never offered — the clause is inert in a real game").toBeDefined();

    const after = settle(accept(state, action!));
    expect(inBase(after, "tired"), "the unit never went home").toBe(true);
    expect(after.players[0]!.xp, "the XP price was not exactly 2").toBe(3);
    expect(after.players[0]!.legend.exhausted, "the printed exhaust was not paid").toBe(true);
  });

  it("counts as a MOVE — 446.1, so movesThisTurn rises", () => {
    // The difference between `forceMoveToBase` and combat's `relocateToBaseUnchanged`,
    // and the only field that can see it from outside. A Recall-shaped
    // implementation would land the unit in base with this untouched.
    const state = khazixBoard(5);
    const action = homeOffers(state).find((a) => a.targetUnitInstanceId === "tired")!;
    const moved = unitAnywhere(settle(accept(state, action)), "tired");
    expect(moved!.movesThisTurn, "the trip home was not counted as a Move").toBe(1);
  });

  it("is NOT offered at 1 XP, and the BUFF mode beside it proves the enumerator ran", () => {
    const broke = khazixBoard(1);
    expect(homeOffers(broke).length, "a 2-XP clause was offered to a player holding 1").toBe(0);
    expect(buffOffers(broke).length, "the 1-XP clause vanished too — this measures nothing").toBeGreaterThan(0);

    const funded = khazixBoard(2);
    expect(homeOffers(funded).length, "the zero above proves nothing").toBeGreaterThan(0);
  });

  it("is not offered at 0 XP at all — neither mode", () => {
    expect(activationsOf(khazixBoard(0), legendId(khazixBoard(0))).length, "a broke Kha'Zix could still act").toBe(0);
  });

  it("offers ONLY the exhausted friendly at a battlefield", () => {
    const offered = homeOffers(khazixBoard(9)).map((a) => a.targetUnitInstanceId);
    expect(offered, "the printed 'exhausted' target was not reachable").toContain("tired");
    expect(offered, "a READY friendly was offered — 'exhausted' is not being read").not.toContain("fresh");
    expect(offered, "an ENEMY unit was offered — 'friendly' is not being read").not.toContain("theirs");
    expect(offered, "a unit already in BASE was offered — 'from a battlefield' is not being read").not.toContain(
      "resting",
    );
  });

  it("the VALIDATOR refuses what the enumerator withheld — a hand-built ready target", () => {
    // The half a fan-out test cannot see. A narrowing wired into `legal-actions`
    // only would let a crafted action through `submit` and spend the XP on a unit
    // the card cannot name.
    const state = khazixBoard(9);
    const legal = homeOffers(state).find((a) => a.targetUnitInstanceId === "tired")!;
    for (const forbidden of ["fresh", "theirs", "resting"]) {
      const { result } = submit(state, { ...legal, targetUnitInstanceId: forbidden } as never);
      expect(result, `${forbidden} was accepted as a target for the move-home clause`).toMatchObject({
        type: "Invalid",
      });
    }
    // ...and the legal one still goes through off the same fixture, so the three
    // refusals above are not just "submit rejects everything".
    expect(inBase(settle(accept(state, legal)), "tired")).toBe(true);
  });

  it("only ONE mode per turn — the shared exhaust is the brake", () => {
    const state = khazixBoard(9);
    const after = settle(accept(state, homeOffers(state).find((a) => a.targetUnitInstanceId === "tired")!));
    expect(activationsOf(after, legendId(after)).length, "an exhausted Legend was offered a second clause").toBe(0);
  });

  it("Minotaur Reckoner makes it legal but inert, and the XP is still spent", () => {
    // "Units can't move to base" is a continuous effect PREVENTING the move, not a
    // targeting restriction — an exhausted friendly at a battlefield still meets
    // every restriction the card prints (355.9.b), so the ability is activatable
    // and 359.3.e.11 leaves nothing to follow. `forceMoveToBase`'s own
    // `mayMoveToBaseFrom` guard is what enforces it, so this clause is stopped by
    // exactly the same door as every other way home.
    const state = khazixBoard(9);
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "minotaur", defId: MINOTAUR_RECKONER, might: 4 })];
    const action = homeOffers(state).find((a) => a.targetUnitInstanceId === "tired");
    expect(action, "the ability became unavailable — the Reckoner is being read as a targeting restriction").toBeDefined();

    const after = settle(accept(state, action!));
    expect(inBase(after, "tired"), "the Reckoner did not stop the move").toBe(false);
    expect(after.players[0]!.xp, "the cost was refunded — activation costs are not conditional on the effect").toBe(7);

    // The positive control: the identical board without the Reckoner DOES move it,
    // so the assertion above is about the Reckoner and not about a dead clause.
    const clean = khazixBoard(9);
    const free = homeOffers(clean).find((a) => a.targetUnitInstanceId === "tired")!;
    expect(inBase(settle(accept(clean, free)), "tired"), "the clause never worked at all").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The clause that was already there, re-measured — the mode split moved its cost
// ---------------------------------------------------------------------------

describe("Kha'Zix - Voidreaver (UNL-201): the [Buff] clause survived the mode split", () => {
  it("still costs exactly 1 XP — the price moved from resolve() into payActivationCost", () => {
    // The regression this change could plausibly introduce and nothing else would
    // catch: `resolve` used to call `spendXp` itself. Left in beside a `cost.xp`
    // it would charge 2 for a printed 1, and the buff would still land.
    const state = khazixBoard(4);
    const action = buffOffers(state).find((a) => a.targetUnitInstanceId === "fresh");
    expect(action, "the buff clause is no longer offered — the mode split broke it").toBeDefined();

    const after = settle(accept(state, action!));
    expect(unitAnywhere(after, "fresh")!.buffed, "the buff never landed").toBe(true);
    expect(after.players[0]!.xp, "the buff was double-billed").toBe(3);
    expect(after.players[0]!.legend.exhausted).toBe(true);
  });

  it("still reaches base and enemy units alike — 'a unit' is a bare noun (355.9.a.1)", () => {
    const offered = buffOffers(khazixBoard(9)).map((a) => a.targetUnitInstanceId);
    for (const id of ["resting", "theirs", "fresh", "tired"]) {
      expect(offered, `${id} became unreachable when the buff moved into a mode`).toContain(id);
    }
  });

  it("both clauses reach the composed registries under one defId", () => {
    expect(implementingModules(KHAZIX_VOIDREAVER), "nothing is registered").not.toEqual([]);
    const both = activationsOf(khazixBoard(9), legendId(khazixBoard(9))).map((a) => a.modeId);
    expect(new Set(both), "the card is not offering two distinct priced clauses").toEqual(
      new Set([BUFF_MODE, HOME_MODE]),
    );
  });
});
