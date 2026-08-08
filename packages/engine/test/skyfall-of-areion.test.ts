import { describe, expect, it } from "vitest";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import { makePlayer, makeState, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Skyfall of Areion (SFD-030) — "My hold effects are also conquer effects, and
 * vice versa."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * # What the standing note said, and what it turned out to be
 *
 * "Needs a moment-rewriting layer, which has no precedent here." The layer is one
 * function, and the reason it is small is a property of the eleven cards it has
 * to reach: EVERY hold and conquer trigger in this pool decides for itself, in
 * its own `applies`, against `event.kind`. So the mirror hands that predicate the
 * OTHER moment and every existing condition works unchanged — no card is edited,
 * and the mirroring is a fact about who is wearing what rather than a second
 * registration.
 *
 * # The three things worth pinning
 *
 * The mirror works in BOTH directions (the card says "and vice versa"); it
 * reaches a GEAR's trigger through its wearer, which is the case the card is
 * actually for (a Warmog's and a Skyfall on one body); and it does NOT double-fire
 * a card that already lists both moments.
 */

const registry = defaultCardRegistry();
const SKYFALL = "SFD-030";
/** "When I hold, score 1 point." A UNIT's own hold trigger. */
const AHRI_ALLURING = "OGN-066";
/** "When I conquer, buff me." An Equipment's — so it reaches its listener only
 *  through `wearerListener`, and the mirror has to reach it the same way. */
const WARMOGS = "SFD-108";
/** "When I conquer or hold, you may play a unit from your trash." Already both,
 *  so the mirror must add nothing. */
const LAST_RITES = "SFD-150";

/** p1 has a unit at bf1 wearing `gearDefIds`. */
function worn(gearDefIds: string[], unitDefId?: string): GameState {
  const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
  const wearer = unitDefId !== undefined ? realUnitInstance(unitDefId) : realUnitInstance(AHRI_ALLURING);
  const withId = { ...wearer, instanceId: "wearer" };
  state.battlefields[0]!.units = { p1: [withId] };
  state.players[0]!.activeGear = gearDefIds.map((defId, i) => ({
    ...realGearInstance(defId),
    instanceId: `gear-${i}`,
    attachedToInstanceId: "wearer",
  })) as GearInstance[];
  state.battlefields[0]!.controllerId = state.players[0]!.id;
  return state;
}

const wearerUnit = (state: GameState) =>
  state.battlefields.flatMap((b) => b.units["p1"] ?? []).find((u) => u.instanceId === "wearer");

/** Fires a CONQUEST at bf1 and settles the chain. */
const conquer = (state: GameState) => resolveHeldTriggers(recordConquest(state, 0, "bf1"));
/** Fires a HOLD at bf1 and settles the chain. */
const hold = (state: GameState) =>
  resolveHeldTriggers(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }));

describe("Skyfall of Areion: a hold fires the wearer's CONQUER effects", () => {
  it("buffs under Warmog's Armor on a mere hold", () => {
    // Warmog's is "when I CONQUER, buff me" and this is a hold. The Skyfall is
    // the only reason it pays out.
    const after = hold(worn([WARMOGS, SKYFALL]));
    expect(wearerUnit(after)?.buffed, "the conquer effect did not fire on a hold").toBe(true);
  });

  it("does NOT without the Skyfall — the control", () => {
    const after = hold(worn([WARMOGS]));
    expect(wearerUnit(after)?.buffed).toBe(false);
  });

  it("reaches an EQUIPMENT's trigger through its wearer", () => {
    // The case the card is actually for, and the one a mirror that looked only at
    // UNIT listeners would silently skip: Warmog's listener is the gear, and "when
    // I conquer" means the unit wearing it.
    const after = hold(worn([WARMOGS, SKYFALL]));
    expect(wearerUnit(after)?.buffed).toBe(true);
  });

  it("does not fire for a unit standing somewhere else", () => {
    // The mirror rewrites WHICH moment, never WHOSE — every "when I" here is
    // positional and stays so.
    const state = worn([WARMOGS, SKYFALL]);
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf2" }),
    );
    expect(wearerUnit(after)?.buffed).toBe(false);
  });

  it("does not fire when the OPPONENT holds", () => {
    const state = worn([WARMOGS, SKYFALL]);
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 1, battlefieldId: "bf1" }),
    );
    expect(wearerUnit(after)?.buffed).toBe(false);
  });
});

describe("Skyfall of Areion: a conquest fires the wearer's HOLD effects — 'and vice versa'", () => {
  it("scores Ahri - Alluring's hold point on a conquest", () => {
    // Ahri is "when I HOLD, score 1 point" and this is a conquest. Her point is
    // separate from the conquest's own, so the total moves by more than one.
    const withSkyfall = conquer(worn([SKYFALL], AHRI_ALLURING));
    const without = conquer(worn([], AHRI_ALLURING));
    expect(withSkyfall.players[0]!.points).toBeGreaterThan(without.players[0]!.points);
  });

  it("adds exactly ONE extra point, not a cascade", () => {
    const withSkyfall = conquer(worn([SKYFALL], AHRI_ALLURING));
    const without = conquer(worn([], AHRI_ALLURING));
    expect(withSkyfall.players[0]!.points - without.players[0]!.points).toBe(1);
  });
});

describe("Skyfall of Areion: what it must NOT do", () => {
  it("does not double-fire a card that already names BOTH moments", () => {
    // Last Rites is "when I conquer OR hold". The mirror has nothing to add, and
    // firing it twice for one moment would be the mirror paying out where the card
    // already does. Counted through the pending-trigger pen, which is where a
    // second placement would show up.
    const state = worn([LAST_RITES, SKYFALL]);
    state.players[0]!.trash = [realUnitInstance("OGN-002")];
    const held = holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" });
    const rites = held.pendingTriggers.filter((t) => t.listenerDefId === LAST_RITES);
    expect(rites, "Last Rites was placed on the chain twice for one hold").toHaveLength(1);
  });

  it("leaves every other kind of moment alone", () => {
    // The mirror is two event kinds wide. A combat, a death, a play — none of
    // them acquire a partner.
    const state = worn([WARMOGS, SKYFALL]);
    const held = holdEventTrigger(state, { kind: "unitReadied", ownerIndex: 0, unitInstanceId: "wearer" });
    expect(held.pendingTriggers).toHaveLength(0);
  });

  it("does nothing while the Skyfall is UNATTACHED", () => {
    // The load-bearing negative every Equipment here has: a Skyfall sitting loose
    // mirrors nobody's moments.
    const state = worn([WARMOGS, SKYFALL]);
    state.players[0]!.activeGear = state.players[0]!.activeGear.map((g) =>
      g.defId === SKYFALL ? { ...g, attachedToInstanceId: null } : g,
    );
    expect(wearerUnit(hold(state))?.buffed).toBe(false);
  });

  it("does not mirror for a unit wearing it on the OTHER side", () => {
    // Whose moments they are is the wearer's, and the wearer's controller is who
    // "I hold" is measured against. An enemy Skyfall changes nothing here.
    const state = worn([WARMOGS], AHRI_ALLURING);
    const theirs = { ...realUnitInstance(AHRI_ALLURING), instanceId: "theirs" };
    state.battlefields[1]!.units = { p2: [theirs] };
    state.players[1]!.activeGear = [
      { ...realGearInstance(SKYFALL), instanceId: "theirGear", attachedToInstanceId: "theirs" },
    ];
    expect(wearerUnit(hold(state))?.buffed).toBe(false);
  });
});

describe("Skyfall of Areion: coverage", () => {
  it("no longer carries a partial note", () => {
    expect(partialImplementationNote(registry.get(SKYFALL))).toBeUndefined();
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(SKYFALL))).toBe(true);
  });
});
