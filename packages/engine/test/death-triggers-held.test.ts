import { describe, expect, it } from "vitest";
import { destroyUnit, dealDamage } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * `[Deathknell]` and death-watch as Chain Pending Items (383).
 *
 * The last family, and the one with two different listener problems in it:
 *
 *  - a **[Deathknell]** is keyed by the DYING card, which is in a trash by the
 *    time anything could resolve it. `source: "deathknell"` carries the whole
 *    `DeathContext` — 809.1.b.3's "before the card is moved to the Trash, note
 *    its location, its attributes, and any other details related to the effect of
 *    its triggered ability", which is the rule this family exists to satisfy.
 *  - a **death-watch** listener is an ordinary permanent watching someone else
 *    die, so it is the event-registry shape: a `unitDied` event carrying the same
 *    context, held by `holdEventTrigger` like every other kind.
 *
 * **Two orderings change, and both are the rules arriving rather than a
 * regression.** The Deathknell used to resolve before the death-watch listeners
 * were even walked, and the walk happened AFTER it so a Deathknell that killed
 * things could remove a listener before it fired. 383 determines the whole set of
 * triggered abilities at the moment of the event, together — so a listener the
 * Deathknell later kills has still triggered, and 809.1.b.3 is explicit that its
 * ability resolves anyway.
 */

const registry = defaultCardRegistry();
const KOGMAW_CAUSTIC = "OGN-190"; // [Deathknell] deal 4 to all units at my battlefield
const SOARING_SCOUT = "OGN-216"; // [Deathknell] channel 1 rune exhausted
const WRAITH_OF_ECHOES = "OGN-118"; // the first time a friendly unit dies each turn, draw 1
const KARTHUS_ETERNAL = "OGN-236"; // your [Deathknell] effects trigger an additional time

const heldNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const penNames = (state: GameState): string[] => state.pendingTriggers.map((t) => t.listenerName);

const card = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/** A stocked player so every Deathknell in the pool has something to act on. */
function stocked(units: UnitInstance[], deckSize = 5): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        deck: Array.from({ length: deckSize }, () => makeUnit()),
        runeDeck: [
          { id: "rd1", domain: "Order", state: "Ready" },
          { id: "rd2", domain: "Order", state: "Ready" },
        ],
      }),
      makePlayer("p2", { deck: Array.from({ length: deckSize }, () => makeUnit()) }),
    ],
  });
  state.battlefields[0]!.units = { p1: units };
  return state;
}

describe("[Deathknell] is a Pending Item, resolved from the trash", () => {
  it("does not resolve inside the kill — it waits on the chain", () => {
    const scout = card(SOARING_SCOUT);
    const state = stocked([scout]);

    const killed = destroyUnit(state, scout.instanceId);

    expect(killed.players[0]!.trash.map((c) => c.defId), "the death itself must still happen").toContain(SOARING_SCOUT);
    expect(killed.players[0]!.channeled, "the Deathknell resolved inline").toHaveLength(0);
    expect(penNames(killed)).toContain(registry.get(SOARING_SCOUT).name);
  });

  it("channels when the chain pops it, with the unit already in the trash", () => {
    const scout = card(SOARING_SCOUT);
    const state = stocked([scout]);

    const settled = resolveHeldTriggers(destroyUnit(state, scout.instanceId));

    expect(settled.players[0]!.channeled).toHaveLength(1);
    expect(settled.players[0]!.channeled[0]!.state).toBe("Exhausted");
    expect(heldNames(settled)).toEqual([]);
  });

  it("keeps the battlefield it died at — Kog'Maw hits 'MY battlefield' from the trash", () => {
    // The clause 809.1.b.3 names location for. By resolution Kog'Maw is in a
    // trash and stands nowhere; the entry carries where he was.
    const kogmaw = card(KOGMAW_CAUSTIC);
    const bystander = makeUnit({ name: "Bystander", might: 9 });
    const state = stocked([kogmaw, bystander]);
    const elsewhere = makeUnit({ name: "Elsewhere", might: 9 });
    state.battlefields[1]!.units = { p1: [elsewhere] };

    const settled = resolveHeldTriggers(destroyUnit(state, kogmaw.instanceId));

    expect((settled.battlefields[0]!.units["p1"] ?? []).find((u) => u.name === "Bystander")?.damage).toBe(4);
    expect((settled.battlefields[1]!.units["p1"] ?? []).find((u) => u.name === "Elsewhere")?.damage).toBe(0);
  });

  it("counts Karthus at the moment of DEATH, not at resolution", () => {
    // "Your [Deathknell] effects trigger an additional time" is 1 + one per
    // Karthus, and the count belongs to the death: a Karthus killed inside the
    // response window did not un-double a trigger that already fired.
    const scout = card(SOARING_SCOUT);
    const karthus = card(KARTHUS_ETERNAL);
    const state = stocked([scout, karthus]);

    const killed = destroyUnit(state, scout.instanceId);
    const karthusGone = destroyUnit(killed, karthus.instanceId);
    const settled = resolveHeldTriggers(karthusGone);

    // 1 + 1 Karthus = two channels for the Scout, even though Karthus died first.
    expect(settled.players[0]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(2);
  });
});

describe("death-watch is a Pending Item too, and is decided at the same moment", () => {
  function wraithState(): { state: GameState; wraith: UnitInstance; victim: UnitInstance } {
    const wraith = card(WRAITH_OF_ECHOES);
    const victim = makeUnit({ name: "Victim", might: 3 });
    const state = stocked([wraith, victim]);
    return { state, wraith, victim };
  }

  it("does not draw inside the kill — it waits on the chain", () => {
    const { state, victim } = wraithState();

    const killed = destroyUnit(state, victim.instanceId);

    expect(killed.players[0]!.hand, "the Wraith resolved inline").toHaveLength(0);
    expect(penNames(killed)).toContain(registry.get(WRAITH_OF_ECHOES).name);
  });

  it("draws when the chain pops it", () => {
    const { state, victim } = wraithState();

    const settled = resolveHeldTriggers(destroyUnit(state, victim.instanceId));

    expect(settled.players[0]!.hand).toHaveLength(1);
  });

  it("is not PLACED for an ENEMY unit's death — 'a FRIENDLY unit dies'", () => {
    // Asserted on the pen: the Wraith's body still re-checks, so a wrongly placed
    // trigger would resolve to nothing and leave an identical board.
    const { state } = wraithState();
    const theirs = makeUnit({ name: "Theirs", might: 3 });
    state.battlefields[0]!.units["p2"] = [theirs];

    const killed = destroyUnit(state, theirs.instanceId, 0);

    expect(penNames(killed)).not.toContain(registry.get(WRAITH_OF_ECHOES).name);
  });

  it("TRIGGERS *and RESOLVES* for a listener the Deathknell then kills (383 / 359.3)", () => {
    // The ordering that changed, and the limit of what it buys.
    //
    // A Kog'Maw dying deals 4 to everything at his battlefield, which kills the
    // Wraith standing beside him. Under the old inline funnel the death-watch
    // listeners were re-walked AFTER the Deathknell had resolved, so the Wraith
    // was already gone and never TRIGGERED at all. 383 fixes the set of triggered
    // abilities at the moment of the event, so it triggers now — the pen proves
    // it, and that is the observable change.
    //
    // And it DRAWS. That was a live question when this test was written — the
    // engine bailed on a listener that had left play, on the reading that a
    // bystander must be there to act — and the rules settle it the other way.
    // 359.3: a check on "a card or permanent whose location, zone, or status has
    // changed such that that information is no longer available" returns null and
    // "all calculations based on it are ignored". The ITEM still resolves; only
    // the parts referring to something gone drop out. The three rules that remove
    // a triggered ability from the chain are a replaced death (809.1.b), the
    // controller declining to perform it, and declining to pay its cost — a dead
    // listener is none of them.
    const kogmaw = card(KOGMAW_CAUSTIC);
    // The Wraith is 5 Might, so Kog'Maw's 4 is only lethal on a damaged one —
    // without this the Deathknell never reaches it and the test asserts nothing.
    // The first version of it did exactly that, and passed.
    const wraith: UnitInstance = { ...card(WRAITH_OF_ECHOES), damage: 1 };
    const state = stocked([kogmaw, wraith]);

    const killed = destroyUnit(state, kogmaw.instanceId);
    expect(penNames(killed), "the Wraith did not trigger at the moment of the death").toContain(
      registry.get(WRAITH_OF_ECHOES).name,
    );

    const settled = resolveHeldTriggers(killed);

    expect(
      (settled.battlefields[0]!.units["p1"] ?? []).map((u) => u.defId),
      "the Deathknell did not actually kill the Wraith",
    ).not.toContain(WRAITH_OF_ECHOES);
    expect(settled.players[0]!.hand, "the ability was discarded with its dead source").toHaveLength(1);
  });
});
