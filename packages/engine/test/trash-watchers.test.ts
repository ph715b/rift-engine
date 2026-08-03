import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { dealDamage, payEnergyFromPool } from "../src/engine/effect-helpers.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/** Answers a named option when it is on offer and takes the first otherwise.
 *  Needed because a decision can raise ANOTHER — Super Mega Death Rocket's
 *  discard cost parks a which-card question of its own — and a picker that
 *  insisted on its own option would throw on the follow-up. */
const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

/**
 * Cards that trigger from a zone no walk of permanents reaches — the TRASH — plus
 * the two decision-time Energy payments they needed.
 *
 * The shared risk is the one `Listener.zone` exists for: the same card sitting in
 * a HAND must not fire. Nothing else distinguishes the two, and a trigger that
 * fired from hand would look exactly like the card working.
 */

const registry = defaultCardRegistry();
const IMMORTAL_PHOENIX = "OGN-037"; // "When you kill a unit with a spell, you may pay to play me from your trash."
const SUPER_MEGA_DEATH_ROCKET = "OGN-252"; // "When you conquer, you may discard 1 to return this from your trash."
const VAYNE_HUNTER = "OGN-035"; // enter-ready condition + "when I conquer, you may pay 1 Energy to return me"
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — the spell that does the killing

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain, state });

describe("Immortal Phoenix (OGN-037): return from the trash on a spell kill", () => {
  /** The Phoenix in the trash, a victim on the board, and enough runes to pay. */
  function phoenixState(runeCount = 4): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.trash = [realUnitInstance(IMMORTAL_PHOENIX)];
    state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`f${i}`, "Fury"));
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 2 })] };
    return state;
  }

  /** Kills the victim as though a Spell were resolving — which is the only thing
   *  that makes it a spell kill. */
  const killWithSpell = (state: GameState) => dealDamage({ ...state, spellResolvingForIndex: 0 }, 0, "victim", 5);

  it("offers the return when a SPELL kills a unit", () => {
    const settled = resolveHeldTriggers({ ...killWithSpell(phoenixState()), spellResolvingForIndex: null });
    expect(settled.pendingDecisions[0]?.kind, "the spell kill did not reach the trash").toBe("OGN-037-return");
  });

  it("does NOT fire for a kill that was not a spell", () => {
    // The whole distinction the card draws. Same board, same death, no spell —
    // combat damage and activated abilities leave `spellResolvingForIndex` null.
    const settled = resolveHeldTriggers(dealDamage(phoenixState(), 0, "victim", 5));
    expect(settled.pendingDecisions).toHaveLength(0);
  });

  it("PLAYS him from the trash when the cost is paid", () => {
    const offered = resolveHeldTriggers({ ...killWithSpell(phoenixState()), spellResolvingForIndex: null });
    const settled = answerDecisions(offered, choose("pay"));

    expect(settled.players[0]!.baseUnits.some((u) => u.defId === IMMORTAL_PHOENIX), "he did not come back").toBe(true);
    expect(settled.players[0]!.trash.some((c) => c.defId === IMMORTAL_PHOENIX), "he is in two zones").toBe(false);
  });

  it("is not asked at all when the cost cannot be paid (416.3)", () => {
    // Unpayable by DOMAIN, not by count — and "give her fewer runes" cannot get
    // there. Rule 164.2's double duty means recycling a Ready Fury rune for the
    // Power ALSO banks the Energy it could have paid, so ONE Fury rune covers
    // both halves. A Calm pool pays the Energy and never the Fury Power.
    const state = phoenixState(0);
    state.players[0]!.channeled = [rune("c0", "Calm"), rune("c1", "Calm")];

    const settled = resolveHeldTriggers({ ...killWithSpell(state), spellResolvingForIndex: null });
    expect(settled.pendingDecisions).toHaveLength(0);
  });

  it("IS asked off a single Fury rune — 164.2 double duty covers both halves", () => {
    // The control for the negative above, and the fact that makes it a domain
    // test rather than a count one.
    const settled = resolveHeldTriggers({ ...killWithSpell(phoenixState(1)), spellResolvingForIndex: null });
    expect(settled.pendingDecisions[0]?.kind).toBe("OGN-037-return");
  });

  it("does NOT fire from HAND — `zone` is what separates the two", () => {
    const state = phoenixState();
    state.players[0]!.hand = state.players[0]!.trash;
    state.players[0]!.trash = [];

    const settled = resolveHeldTriggers({ ...killWithSpell(state), spellResolvingForIndex: null });
    expect(settled.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(IMMORTAL_PHOENIX))).toBe(true);
  });
});

describe("Super Mega Death Rocket! (OGN-252): return from the trash on a conquer", () => {
  function rocketState(handCount: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.trash = [spellInstance(SUPER_MEGA_DEATH_ROCKET)];
    state.players[0]!.hand = Array.from({ length: handCount }, () => spellInstance(HEXTECH_RAY));
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "holder", might: 3 })] };
    return state;
  }

  it("offers the return on a conquer, and takes the discard for it", () => {
    const conquered = resolveHeldTriggers(recordConquest(rocketState(2), 0, "bf1"));
    expect(conquered.pendingDecisions[0]?.kind).toBe("OGN-252-return");

    const settled = answerDecisions(conquered, choose("discard"));
    expect(settled.players[0]!.hand.some((c) => c.defId === SUPER_MEGA_DEATH_ROCKET), "it did not return to hand").toBe(true);
    expect(settled.players[0]!.hand.filter((c) => c.defId === HEXTECH_RAY), "the discard was not taken").toHaveLength(1);
  });

  it("is not asked with an EMPTY hand — the discard is a cost", () => {
    const conquered = resolveHeldTriggers(recordConquest(rocketState(0), 0, "bf1"));
    expect(conquered.pendingDecisions).toHaveLength(0);
  });

  it("does not fire for the OPPONENT's conquest", () => {
    const state = rocketState(2);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", might: 3 })] };
    const conquered = resolveHeldTriggers(recordConquest(state, 1, "bf1"));
    expect(conquered.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SUPER_MEGA_DEATH_ROCKET))).toBe(true);
  });
});

describe("Vayne - Hunter (OGN-035): two clauses about who is winning", () => {
  it("enters READY only while an opponent CONTROLS a battlefield", () => {
    // "Controls", not "is present at" — an opponent standing on an uncontrolled
    // battlefield does not count, which is what `controllerId` tests.
    const vayne = realUnitInstance(VAYNE_HUNTER);
    const state = makeState({ phase: "Action" });
    expect(unitEntersReady(state, 0, vayne), "she entered ready with nobody controlling anything").toBe(false);

    state.battlefields[0]!.units = { p2: [makeUnit({ might: 3 })] };
    expect(unitEntersReady(state, 0, vayne), "mere presence should not be enough").toBe(false);

    state.battlefields[0]!.controllerId = "p2";
    expect(unitEntersReady(state, 0, vayne)).toBe(true);
  });

  it("offers the bounce when she conquers, and pays for it", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [realUnitInstance(VAYNE_HUNTER)] };
    state.players[0]!.channeled = [rune("f0", "Fury")];

    const conquered = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(conquered.pendingDecisions[0]?.kind).toBe("OGN-035-return");

    const settled = answerDecisions(conquered, choose("pay"));
    expect(settled.players[0]!.hand.some((c) => c.defId === VAYNE_HUNTER), "she did not return to hand").toBe(true);
    expect(settled.players[0]!.channeled[0]!.state, "the Energy was not paid").toBe("Exhausted");
  });

  it("is not asked when the Energy cannot be paid", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [realUnitInstance(VAYNE_HUNTER)] };
    state.players[0]!.channeled = [rune("f0", "Fury", "Exhausted")];

    expect(resolveHeldTriggers(recordConquest(state, 0, "bf1")).pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VAYNE_HUNTER))).toBe(true);
  });
});

describe("payEnergyFromPool: floating first, then Ready runes", () => {
  it("spends floating Energy before exhausting anything", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.floatingEnergy = 2;
    state.players[0]!.channeled = [rune("a", "Fury")];

    const paid = payEnergyFromPool(state, 0, 1)!;
    expect(paid.players[0]!.floatingEnergy).toBe(1);
    expect(paid.players[0]!.channeled[0]!.state, "it exhausted a rune it did not need").toBe("Ready");
  });

  it("falls through to Ready runes, and refuses when there are not enough", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = [rune("a", "Fury"), rune("b", "Calm", "Exhausted")];

    expect(payEnergyFromPool(state, 0, 1)!.players[0]!.channeled[0]!.state).toBe("Exhausted");
    expect(payEnergyFromPool(state, 0, 2), "an exhausted rune paid Energy").toBeUndefined();
  });
});
