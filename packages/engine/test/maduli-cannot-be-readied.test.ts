import { describe, expect, it } from "vitest";
import { runAwaken } from "../src/engine/turn-manager.js";
import { readyUnit, readyPermanent } from "../src/engine/effect-helpers.js";
import { unitMayBeReadied } from "../src/engine/board-restrictions.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-144 Maduli the Gatekeeper — "I can't be readied."**
 *
 * The one card in the Unleashed backlog that was STRONGER than printed rather
 * than weaker, which is why it was worth fixing ahead of cards that merely do
 * nothing: his ability was live in generated decks and simply ignored.
 *
 * # Rule 415, and why one predicate has to bind two sites
 *
 * 415.1 defines Readying once. 415.3 then lists exactly two ways it happens:
 *
 *  - **415.3.a** — "A player Readies all non-spell Game Objects they Control
 *    during the Awakening Phase on their turn." That is `runAwaken`.
 *  - **415.3.b** — "Players may also Ready Game Objects on the board when effects
 *    or spells instruct them to do so." That is `readyUnit`.
 *
 * A restriction on being Readied is a restriction on 415.1, so it binds both.
 * The engine had a lock on only the second (`mayReadyPermanent`, the Mageseeker
 * Warden's), and that one is per-PLAYER — it asks whether an enemy Warden is
 * standing at a battlefield, so it answers the same for every permanent that
 * player controls and cannot express a sentence about one card.
 *
 * `mayReadyPermanent`'s own comment calls the Awaken exemption "structural",
 * which is correct for the Warden (a spells-and-abilities lock) and is precisely
 * the reasoning that must NOT be inherited here. Each site is therefore asserted
 * SEPARATELY below — a test that only awakened him would leave `readyUnit`
 * untested, and vice versa.
 *
 * # The third site
 *
 * `runAwaken` captures an `awakened` list BEFORE it rebuilds the board, and that
 * list is what raises one `unitReadied` event per unit. A Maduli who stays
 * exhausted but still announces a readying would feed Pirate's Haven a pump for
 * something that never happened, so the event is asserted as well as the flag.
 */

const MADULI = "UNL-144";
/** Pirate's Haven — "when you ready a friendly unit, give it +1 [Might] this
 *  turn". The listener this divergence would have fed a phantom pump. */
const PIRATES_HAVEN = "OGN-143";
const registry = defaultCardRegistry();

/** Maduli exhausted at a battlefield, with an ordinary exhausted unit beside him
 *  as the positive control — every "he stayed down" assertion here is worthless
 *  unless something else in the same fixture stood up. */
function board(zone: "base" | "battlefield"): { state: GameState; maduli: UnitInstance; bystander: UnitInstance } {
  const maduli = { ...realUnitInstance(MADULI), exhausted: true };
  const bystander = makeUnit({ instanceId: "bystander", exhausted: true });
  const state = makeState({ phase: "Awaken", activePlayerIndex: 0 });
  if (zone === "base") {
    state.players[0]!.baseUnits = [maduli, bystander];
  } else {
    state.battlefields[0]!.units = { [state.players[0]!.id]: [maduli, bystander] };
  }
  return { state, maduli, bystander };
}

const findUnit = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

describe("415.3.a — the Awaken Phase does not ready him", () => {
  it("leaves him exhausted in BASE while everything else stands up", () => {
    const { state, maduli, bystander } = board("base");
    const after = runAwaken(state);

    expect(findUnit(after, bystander.instanceId)!.exhausted, "the control never readied — fixture is broken").toBe(
      false,
    );
    expect(findUnit(after, maduli.instanceId)!.exhausted, "Maduli readied at Awaken").toBe(true);
  });

  it("leaves him exhausted AT A BATTLEFIELD too", () => {
    // `runAwaken` rebuilds base units and battlefield units through two SEPARATE
    // maps, so one of them can be fixed and the other missed. Both are asserted.
    const { state, maduli, bystander } = board("battlefield");
    const after = runAwaken(state);

    expect(findUnit(after, bystander.instanceId)!.exhausted, "the control never readied — fixture is broken").toBe(
      false,
    );
    expect(findUnit(after, maduli.instanceId)!.exhausted, "Maduli readied at a battlefield").toBe(true);
  });

  it("raises NO unitReadied trigger for him, and one for the unit that did ready", () => {
    // **The third site: the `awakened` capture**, which is what raises one
    // `unitReadied` event per unit. A unit that stayed down must not announce a
    // readying it never got.
    //
    // Measured through a REAL listener rather than by reading the event off
    // `pendingTriggers`, because that array holds a listener's held ability and
    // not the raw event — with nothing on the board listening, the first version
    // of this test found an empty array and its own guard clause caught it.
    // OGN-143 Pirate's Haven is the listener: "when you ready a friendly unit,
    // give it +1 Might this turn", which is exactly the card the divergence
    // would have fed a phantom pump.
    const { state, maduli, bystander } = board("base");
    state.players[0]!.activeGear = [realGearInstance(PIRATES_HAVEN)];
    const after = runAwaken(state);

    const triggers = after.pendingTriggers.filter((t) => t.listenerDefId === PIRATES_HAVEN);
    expect(triggers.length, "the Haven never triggered at all — this asserts nothing").toBe(1);

    // And the pump lands on the unit that really readied, not on Maduli.
    const settled = resolveHeldTriggers(after);
    expect(findUnit(settled, bystander.instanceId)!.mightThisTurn, "the control was not pumped").toBe(1);
    expect(findUnit(settled, maduli.instanceId)!.mightThisTurn, "Maduli was pumped for a ready he never got").toBe(0);
  });

  it("still readies him if the restriction is asked of the wrong card", () => {
    // A positive control on the PREDICATE itself, so "he stayed exhausted" cannot
    // be passing because `runAwaken` quietly stopped readying anyone.
    expect(unitMayBeReadied({ defId: MADULI }), "the predicate does not name Maduli").toBe(false);
    expect(unitMayBeReadied({ defId: "OGN-030" }), "the predicate bars an unrelated card").toBe(true);
  });
});

describe("415.3.b — a spell or ability does not ready him either", () => {
  it("readyUnit refuses him and accepts the control", () => {
    const { state, maduli, bystander } = board("base");
    // Not the Awaken — an ordinary effect, which is the OTHER of 415.3's two
    // readying sources and a completely separate code path.
    const action = { ...state, phase: "Action" as const };

    expect(findUnit(readyUnit(action, bystander.instanceId), bystander.instanceId)!.exhausted, "readyUnit is inert")
      .toBe(false);
    expect(findUnit(readyUnit(action, maduli.instanceId), maduli.instanceId)!.exhausted, "a spell readied Maduli").toBe(
      true,
    );
  });

  it("readyPermanent refuses him too — it delegates units to readyUnit", () => {
    // Miss Fortune - Captain's "something else that's exhausted" comes through
    // here rather than through `readyUnit`, so the wider door is asserted as
    // well: a lock on one function is not a lock on the rule.
    const { state, maduli } = board("base");
    const action = { ...state, phase: "Action" as const };

    expect(
      findUnit(readyPermanent(action, 0, maduli.instanceId), maduli.instanceId)!.exhausted,
      "readyPermanent readied Maduli",
    ).toBe(true);
  });
});

describe("coverage", () => {
  it("reports him finished, with the board-restriction claim merged in", () => {
    const def = registry.get(MADULI);
    expect(isCardImplemented(def), "Maduli still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "he still carries a partial note").toBeUndefined();
    // His [Chaos] move ability is registered elsewhere, so coverage MERGES two
    // claims — the same split Concentrate and Master Yi have.
    expect(implementingModules(MADULI), "the ready-lock is not claimed").toContain("board restrictions");
    expect(implementingModules(MADULI).length, "the move ability's claim was lost").toBeGreaterThan(1);
  });
});
