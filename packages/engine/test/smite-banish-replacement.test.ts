import { describe, expect, it } from "vitest";
import { dealDamage, destroyUnit } from "../src/engine/effect-helpers.js";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **UNL-007 Smite — "[Action] Deal 3 to a unit at a battlefield. If it would die
 * this turn, banish it instead."**
 *
 * The rider is a Replacement Effect (369.1's "would ... instead") **armed for the
 * TURN**, not applied to this instruction. That distinction is the card, and the
 * refusal that stood here named the wrong answer precisely: "banish the target
 * HERE when this damage happens to be lethal" is wrong in both directions — it
 * misses every later death the card is armed for, and it banishes PAST the
 * replacement chain that 369/370 let apply first.
 *
 * # The three things asserted, and why each needs its own test
 *
 *  - **A survivor is still armed.** Smite for 3 on a 5-Might unit, then kill it
 *    by other means — it banishes. This is the half a lethal-only implementation
 *    fails, and the half that makes it a turn-long replacement.
 *  - **The damage's OWN death banishes too.** The arming happens BEFORE
 *    `dealDamage`, because "would die this turn" covers the death this spell
 *    causes. Arming afterwards inverts the card exactly: it would banish every
 *    unit Smite did NOT kill and none that it did.
 *  - **A banish is not a death** (808.1.d.1). No `[Deathknell]`, no death-watch,
 *    no `unitsLostThisTurn`, and the card is in `banished` rather than the trash.
 *    A version that trashed the unit and then moved it would fire all of that on
 *    the way past, and would look identical if only the final zone were checked.
 *
 * # Ordering against the death ward
 *
 * **372**: "If more than one Replacement Effect applies to the same event being
 * executed, then the controller of the object being acted on determines the
 * order." The object is the dying unit, and its controller would always take the
 * ward that saves it over a banish that does not — so the ward winning is the
 * controller's choice rather than a tie this engine broke arbitrarily.
 */

const registry = defaultCardRegistry();
const SMITE = "UNL-007";
const SMITE_DAMAGE = 3;

/** A board with `victim` standing at a battlefield, which is where Smite's
 *  printed "at a battlefield" requires it to be. */
function board(might: number): { state: GameState; victim: UnitInstance } {
  const victim = makeUnit({ instanceId: "victim", name: "Victim", might });
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { [state.players[1]!.id]: [victim] };
  return { state, victim };
}

/** Resolves Smite against `victim`, the way a popped chain entry would. */
const smite = (state: GameState, victimId: string): GameState =>
  resolveHeldTriggers(
    resolveCardEffect(state, {
      card: spellInstance(SMITE),
      playerIndex: 0,
      payment: { energyRunes: [], powerRunes: [] },
      targetUnitInstanceId: victimId,
    } as SpellChainEntry),
  );

const zoneOf = (state: GameState, instanceId: string): "banished" | "trash" | "board" | "gone" => {
  for (const p of state.players) {
    if (p.banished.some((c) => c.instanceId === instanceId)) return "banished";
    if (p.trash.some((c) => c.instanceId === instanceId)) return "trash";
  }
  const onBoard = [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].some((u) => u.instanceId === instanceId);
  return onBoard ? "board" : "gone";
};

describe("the rider is armed for the TURN, not for this damage", () => {
  it("banishes a SURVIVOR that dies later by other means", () => {
    // The half a lethal-only implementation fails outright: 5 Might takes 3 and
    // lives, and the arming has to outlast the spell.
    const { state, victim } = board(5);
    const smitten = smite(state, victim.instanceId);

    expect(zoneOf(smitten, victim.instanceId), "the 3 killed a 5-Might unit").toBe("board");
    expect(smitten.banishOnDeathUnitInstanceIds, "he was never armed").toContain(victim.instanceId);

    const killedLater = resolveHeldTriggers(destroyUnit(smitten, victim.instanceId, 0));
    expect(zoneOf(killedLater, victim.instanceId), "a later death did not banish him").toBe("banished");
  });

  it("banishes on the SPELL'S OWN kill — the arming precedes the damage", () => {
    // **The ordering test.** Arming after `dealDamage` inverts the card exactly:
    // it would banish every unit Smite failed to kill and none that it killed.
    // 2 Might dies to 3.
    const { state, victim } = board(2);
    const smitten = smite(state, victim.instanceId);

    expect(zoneOf(smitten, victim.instanceId), "the spell's own kill reached the trash").toBe("banished");
  });

  it("expires with the turn", () => {
    // "This turn". Without the sweep, a unit Smitten on turn 3 is still banished
    // when it dies on turn 12.
    const { state, victim } = board(5);
    const smitten = smite(state, victim.instanceId);
    expect(smitten.banishOnDeathUnitInstanceIds).toContain(victim.instanceId);

    const ended = runEnd({ ...smitten, phase: "Action" });
    expect(ended.banishOnDeathUnitInstanceIds, "the arming outlived the turn").toEqual([]);

    const killedNextTurn = resolveHeldTriggers(destroyUnit(ended, victim.instanceId, 0));
    expect(zoneOf(killedNextTurn, victim.instanceId), "he was banished a turn too late").toBe("trash");
  });

  it("arms only the unit it named", () => {
    // A bystander at the same battlefield, so the arming is per-instance rather
    // than a flag on the board or on the turn.
    const { state, victim } = board(5);
    const bystander = makeUnit({ instanceId: "bystander", might: 5 });
    state.battlefields[0]!.units[state.players[1]!.id]!.push(bystander);

    const smitten = smite(state, victim.instanceId);
    const killed = resolveHeldTriggers(destroyUnit(smitten, bystander.instanceId, 0));
    expect(zoneOf(killed, bystander.instanceId), "an unsmitten unit was banished").toBe("trash");
  });
});

describe("a banish is NOT a death (808.1.d.1)", () => {
  it("does not count toward unitsLostThisTurn, and the unit is not in the trash", () => {
    // The observable difference, and the reason it is asserted through a COUNTER
    // rather than only through the final zone: an implementation that trashed the
    // unit and then moved it to `banished` would end in the right place having
    // fired everything a death fires on the way.
    const { state, victim } = board(2);
    const before = state.players[1]!.unitsLostThisTurn;
    const smitten = smite(state, victim.instanceId);

    expect(zoneOf(smitten, victim.instanceId)).toBe("banished");
    expect(smitten.players[1]!.unitsLostThisTurn, "the banish counted as a unit lost").toBe(before);
    expect(
      smitten.players[1]!.trash.some((c) => c.instanceId === victim.instanceId),
      "the unit passed through the trash",
    ).toBe(false);
  });

  it("POSITIVE CONTROL: an ordinary kill DOES count and DOES reach the trash", () => {
    // Without this the assertions above pass just as well if the counter and the
    // trash had simply stopped working.
    const { state, victim } = board(2);
    const killed = resolveHeldTriggers(dealDamage(state, 0, victim.instanceId, SMITE_DAMAGE));

    expect(zoneOf(killed, victim.instanceId), "an ordinary kill did not reach the trash").toBe("trash");
    expect(killed.players[1]!.unitsLostThisTurn, "an ordinary kill did not count").toBe(1);
  });
});

describe("372 — the death ward is applied first, because its controller would", () => {
  it("a warded unit is SAVED rather than banished", () => {
    // Both replacements apply to one event. 372 gives the ordering to the
    // controller of the object being acted on, and the unit's controller takes
    // the save every time. So the ward wins and he is neither trashed nor
    // banished — he is back in base.
    const { state, victim } = board(2);
    const smitten = smite(state, victim.instanceId);
    expect(zoneOf(smitten, victim.instanceId), "he died before the ward could be armed").toBe("banished");

    // Re-run with the ward armed BEFORE the spell, which is the real sequence.
    const { state: fresh, victim: v2 } = board(5);
    const warded: GameState = { ...fresh, deathWardedUnitInstanceIds: [v2.instanceId] };
    const armed = smite(warded, v2.instanceId);
    const killed = resolveHeldTriggers(destroyUnit(armed, v2.instanceId, 0));

    expect(zoneOf(killed, v2.instanceId), "the banish beat the ward").not.toBe("banished");
    expect(killed.players[1]!.baseUnits.some((u) => u.instanceId === v2.instanceId), "the ward did not save him").toBe(
      true,
    );
  });
});

describe("coverage", () => {
  it("reports Smite finished, with no partial note", () => {
    const def = registry.get(SMITE);
    expect(isCardImplemented(def), "Smite still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "he still carries a partial note").toBeUndefined();
  });
});
