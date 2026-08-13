import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isMighty } from "../src/engine/granted-keywords.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { implementingModules, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { actingPlayerIndex } from "../src/engine/timing.js";
import type { RuneCard } from "../src/model/rune.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Wave 7, Calm — the two clauses of nine cards this change actually wrote.
 *
 * The other seven are refused in the report, each on a shared file this change
 * does not own. The two pinned here are pinned because both are the shape this
 * repo keeps shipping inert: Vilemaw's clause is arithmetic nothing on the board
 * displays, and Shadow's is an activated ability that would enumerate, charge and
 * stun exactly the same whether or not its "here" restriction existed.
 *
 * **Vilemaw is read through DEATHS, never through `damage`** — 466.1.a.1 inserts
 * "3c. Heal all Units" into the Combat Cleanup, so `damage` is 0 after
 * `resolveShowdown` whatever happened. Every fixture below is sized so that
 * exactly the number under test decides who is left standing, and the defender
 * order matters: `combat.distribute` fills each target to lethal in list order,
 * so a 7-damage pool aimed at [Vilemaw(8), ally(6)] never reaches the ally at all
 * and the test would pass with the clause deleted. The ally is therefore FIRST.
 */

const registry = defaultCardRegistry();

const VILEMAW = "UNL-060";
const SHADOW = "UNL-194";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const activationsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

/** A contested bf1 with `attackers` on p1's side and `defenders` on p2's — the
 *  Attacker is the player who applied Contested (464.2.c Step 1). */
function combat(attackers: UnitInstance[], defenders: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, contestedByIndex: 0, units: { p1: attackers, p2: defenders } };
  return state;
}

/** Is this unit still standing at bf1 after the combat resolved? */
const alive = (state: GameState, instanceId: string): boolean => {
  const bf = state.battlefields[0]!;
  return [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])].some((u) => u.instanceId === instanceId);
};

describe("Vilemaw (UNL-060): 'enemy units here with less Might than me don't deal combat damage'", () => {
  it("printed stats are what these fixtures are sized around", () => {
    const def = registry.get(VILEMAW);
    expect(def.type === "Unit" ? def.might : 0, "his Might moved — every number below is chosen against 8").toBe(8);
  });

  it("SILENCES a weaker attacker: the 6-Might ally beside him survives where the control dies", () => {
    // p1 attacks with a 7-Might unit into an ally(6) standing in front of Vilemaw.
    // 7 is lethal on the 6 and on nothing else, so the ally living or dying IS the
    // clause. The control swaps Vilemaw for a plain 8-Might defender: same pool,
    // same order, same targets, no aura.
    const attacker = () => makeUnit({ instanceId: "attacker", name: "Attacker", might: 7 });
    const ally = () => makeUnit({ instanceId: "ally", name: "Ally", might: 6 });

    const withSpider = resolveShowdown(combat([attacker()], [ally(), realUnitInstance(VILEMAW)]), "bf1", 0);
    expect(alive(withSpider, "ally"), "the silenced attacker still dealt its 7").toBe(true);

    const control = resolveShowdown(
      combat([attacker()], [ally(), makeUnit({ instanceId: "stand-in", name: "Stand-in", might: 8 })]),
      "bf1",
      0,
    );
    expect(alive(control, "ally"), "the CONTROL failed: a plain 8-Might defender saved the ally too").toBe(false);
  });

  it("does NOT silence an attacker of EQUAL Might — 'LESS Might than me' excludes the tie", () => {
    // The negative control a `<=` typo fails and a happy-path assertion cannot
    // see. 8 is exactly Vilemaw's Might, so the attacker keeps its damage.
    const state = combat(
      [makeUnit({ instanceId: "equal", name: "Equal", might: 8 })],
      [makeUnit({ instanceId: "ally", name: "Ally", might: 6 }), realUnitInstance(VILEMAW)],
    );
    expect(alive(resolveShowdown(state, "bf1", 0), "ally"), "an 8-Might attacker was silenced by an 8-Might Vilemaw").toBe(false);
  });

  it("counts a BUFF on the attacker, so 'Might' is not the printed number", () => {
    // The same 7-Might attacker, buffed to 8 (703). It must stop being silenced —
    // which is what reading both sides through `effectiveMight` buys, and what a
    // `unit.might` comparison would get wrong in the card's favour.
    const state = combat(
      [makeUnit({ instanceId: "buffed", name: "Buffed", might: 7, buffed: true })],
      [makeUnit({ instanceId: "ally", name: "Ally", might: 6 }), realUnitInstance(VILEMAW)],
    );
    expect(alive(resolveShowdown(state, "bf1", 0), "ally"), "the buff did not lift the attacker to Vilemaw's 8").toBe(false);
  });

  it("does NOT silence a FRIENDLY weaker unit — 'ENEMY units here'", () => {
    // Vilemaw attacks alongside a 2-Might friend into a 9-Might defender. 8 alone
    // is not lethal on a 9 and 8 + 2 is, so the defender dying is exactly the
    // friend's 2 landing. Without the enemy test the aura would silence its own
    // side and the defender would live.
    const state = combat(
      [realUnitInstance(VILEMAW), makeUnit({ instanceId: "friend", name: "Friend", might: 2 })],
      [makeUnit({ instanceId: "victim", name: "Victim", might: 9 })],
    );
    expect(alive(resolveShowdown(state, "bf1", 0), "victim"), "the friendly 2-Might unit was silenced too").toBe(false);
  });

  it("does NOT reach a battlefield he is not standing at — 'HERE'", () => {
    // Same weak attacker, same ally, Vilemaw parked at bf2. "Here" is a referent
    // read from the source (359.3.f.1), so the ally must die exactly as in the
    // control above.
    const state = combat(
      [makeUnit({ instanceId: "attacker", name: "Attacker", might: 7 })],
      [makeUnit({ instanceId: "ally", name: "Ally", might: 6 })],
    );
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p2: [realUnitInstance(VILEMAW)] } };
    expect(alive(resolveShowdown(state, "bf1", 0), "ally"), "a Vilemaw at bf2 silenced an attacker at bf1").toBe(false);
  });

  it("silences OUTGOING damage only — the attacker is no easier to KILL for it", () => {
    // The load-bearing half, and the one that fails the moment the
    // `combatRole === "outgoing"` guard is dropped: with the penalty on the
    // "remaining" role too, a silenced unit reads 0 remaining Might and comes off
    // the board in any combat at all, undamaged. Asserted on the two roles
    // directly, because a combat whose other side deals 14 would kill the
    // attacker either way and prove nothing.
    const state = combat(
      [makeUnit({ instanceId: "attacker", name: "Attacker", might: 7 })],
      [makeUnit({ instanceId: "ally", name: "Ally", might: 6 }), realUnitInstance(VILEMAW)],
    );
    const attacker = state.battlefields[0]!.units["p1"]![0]!;
    expect(
      effectiveMight(state, attacker, 0, { isCombat: true, isAttackingSide: true, combatRole: "remaining", battlefieldId: "bf1" }),
      "the penalty leaked into the 'remaining' role",
    ).toBe(7);
    expect(
      effectiveMight(state, attacker, 0, { isCombat: true, isAttackingSide: true, combatRole: "outgoing", battlefieldId: "bf1" }),
      "the penalty never reached the 'outgoing' role",
    ).toBe(0);
  });

  it("does not make a silenced unit stop being [Mighty]", () => {
    // `isMighty` takes the HIGHER of the two combat roles, which is what keeps a
    // -1000 in one of them from changing Mighty status (708/709). Pinned because
    // it is the one non-obvious consequence of expressing "deals no combat damage"
    // as arithmetic, and no damage assertion can see it.
    const state = combat(
      [makeUnit({ instanceId: "big", name: "Big", might: 6 })],
      [makeUnit({ instanceId: "ally", name: "Ally", might: 6 }), realUnitInstance(VILEMAW)],
    );
    expect(isMighty(state, state.battlefields[0]!.units["p1"]![0]!, 0), "the outgoing penalty took its Mighty status").toBe(true);
  });

  it("is VISIBLE to coverage as a Might modifier, not only as his hold trigger", () => {
    // Registration is per defId and he already had an `eventTriggers` entry, so
    // "implemented" said nothing about this clause either way. `implementingModules`
    // is the one query that can tell the two apart, and the aura has to appear as a
    // continuous-Might source or the next audit reads the card as finished for the
    // wrong reason.
    expect(implementingModules(VILEMAW)).toContain("effective-might");
  });

  it("is not asked at all outside combat — the non-combat read is untouched", () => {
    // The guard that keeps this out of every other Might question in the engine,
    // and the negative control for `ctx.battlefieldId === undefined`.
    const state = combat([makeUnit({ instanceId: "attacker", name: "Attacker", might: 7 })], [realUnitInstance(VILEMAW)]);
    const attacker = state.battlefields[0]!.units["p1"]![0]!;
    expect(effectiveMight(state, attacker, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(7);
    expect(effectiveMight(state, attacker, 0, { isCombat: false })).toBe(7);
  });
});

describe("Shadow (UNL-194): '[1][rainbow], [Exhaust]: [Stun] an enemy unit attacking here'", () => {
  /**
   * p2 controls Shadow at bf1 and `attackerIndex` contests it, staged through the
   * REAL Cleanup so the Attacker designation is handed out by the engine rather
   * than by the fixture. Focus is then passed until it sits with p2, which is the
   * only window Shadow's controller can act in — and is what makes
   * `legalActions` enumerate for the right seat at all.
   */
  function board(
    attackers: UnitInstance[],
    opts: { attackerIndex?: 0 | 1; shadowInBase?: true; elsewhere?: UnitInstance[]; bystanders?: UnitInstance[] } = {},
  ): { state: GameState; shadowId: string } {
    const attackerIndex = opts.attackerIndex ?? 0;
    const shadow = realUnitInstance(SHADOW);
    const seed = makeState({ phase: "Action", activePlayerIndex: 0 });
    seed.battlefields[0] = {
      ...seed.battlefields[0]!,
      units: { p1: attackers, p2: opts.shadowInBase ? [] : [shadow] },
    };
    if (opts.shadowInBase) seed.players[1]!.baseUnits = [shadow];
    if (opts.elsewhere) {
      seed.battlefields[1] = { ...seed.battlefields[1]!, contestedByIndex: 0, units: { p1: opts.elsewhere } };
    }
    // Enemy units at bf2 with nobody contesting it — present on the Board and so
    // inside the default `scope: "battlefield"`, but not attacking anything.
    if (opts.bystanders) {
      seed.battlefields[1] = { ...seed.battlefields[1]!, units: { p1: opts.bystanders } };
    }
    seed.players[1]!.channeled = [rune("c1", "Calm"), rune("c2", "Calm"), rune("c3", "Calm")];

    const staged = beginCombatAt(seed, "bf1", attackerIndex);
    const state = staged.focusHolder === 1 ? staged : accept(staged, { type: "PassFocus", playerIndex: staged.focusHolder });
    // Every negative case below asserts "nothing offered"; without this they would
    // pass just as well if the enumeration were running for the WRONG player.
    expect(actingPlayerIndex(state), "the fixture never handed the window to Shadow's controller").toBe(1);
    return { state, shadowId: shadow.instanceId };
  }

  it("is enumerated and STUNS the attacker through the real submit path", () => {
    // Through `legalActions` + `submit` rather than the resolver, because a
    // dispatch hop can drop the whole thing and a resolver-level test passes just
    // the same.
    const { state, shadowId } = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })]);
    const offered = activationsOf(state, shadowId);
    expect(offered, "the ability was never offered").toHaveLength(1);
    expect(offered[0]).toMatchObject({ targetUnitInstanceId: "raider" });

    const readyRunesBefore = state.players[1]!.channeled.filter((r) => r.state === "Ready").length;
    const after = accept(state, offered[0]);
    expect(after.battlefields[0]!.units["p1"]![0]!.stunned, "the attacker was not stunned").toBe(true);
    expect(after.battlefields[0]!.units["p2"]![0]!.exhausted, "the exhaust half of the cost was not taken").toBe(true);
    // 164.2's Basic Rune pays either half, so both pips come off the same pool —
    // one exhausted for the Energy and one recycled for the Power.
    expect(
      after.players[1]!.channeled.filter((r) => r.state === "Ready").length,
      "the [1][rainbow] was not charged",
    ).toBeLessThan(readyRunesBefore);
  });

  it("is NOT offered against a DEFENDING enemy unit — 'attacking'", () => {
    // The negative control on the designation. p2 contests bf1 instead, so
    // Shadow's own side is the Attacker and the enemy standing there is a
    // defender: nothing on the board may be stunned.
    const { state, shadowId } = board([makeUnit({ instanceId: "holder", name: "Holder", might: 4 })], { attackerIndex: 1 });
    expect(activationsOf(state, shadowId), "a defending enemy was offered as a target").toHaveLength(0);
  });

  it("does NOT offer an enemy BYSTANDER at an uncontested battlefield — 'ATTACKING'", () => {
    // The negative control that makes `attackingOnly` load-bearing rather than
    // decorative: the bystander is an enemy unit at a battlefield, so the default
    // `scope` reaches it and only the designation keeps it off the list. Nothing
    // is contesting bf2, so the "attacking elsewhere" narrowing is not what is
    // being measured here.
    const { state, shadowId } = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })], {
      bystanders: [makeUnit({ instanceId: "loiterer", name: "Loiterer", might: 4 })],
    });
    const offered = activationsOf(state, shadowId);
    expect(offered.map((a) => (a.type === "ActivateAbility" ? a.targetUnitInstanceId : undefined))).toEqual(["raider"]);
  });

  it("is NOT offered while Shadow stands in base — 'HERE' needs a source location", () => {
    const { state, shadowId } = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })], { shadowInBase: true });
    expect(activationsOf(state, shadowId), "a Shadow in base reached a battlefield").toHaveLength(0);
  });

  it("DIVERGENCE: withheld entirely while the enemy is also attacking elsewhere", () => {
    // `TargetingSpec` cannot relate a target to the ability's source location, and
    // more than one Battlefield can be Contested at once (`cleanup.stage` takes
    // them one at a time). So the choice is between offering the attacker at bf2 —
    // STRONGER than printed — and offering nothing. This pins the weaker call, so
    // closing the gap with a real "here" scope fails loudly here rather than
    // changing behaviour nobody is watching.
    const { state, shadowId } = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })], {
      elsewhere: [makeUnit({ instanceId: "far", name: "Far Raider", might: 4 })],
    });
    expect(activationsOf(state, shadowId), "an attacker at another battlefield was reachable").toHaveLength(0);

    // ...and the same board WITHOUT the second front offers it, so this cannot
    // pass by the ability simply being dead.
    const single = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })]);
    expect(activationsOf(single.state, single.shadowId), "the control failed: the ability is never offered at all").toHaveLength(1);
  });

  it("is not affordable on Energy alone — the rainbow Power pip is really charged", () => {
    // The `[rainbow]` is paid by RECYCLING a channeled rune (416.1.b), and 416.3
    // says a Recycle listed as a Cost "must be able to be completed for the cost
    // to be paid" — so with no channeled runes the ability is not offered at all.
    // Sharper than emptying every pool: floating Energy still pays the `[1]` and
    // can never pay a Power pip, so this fails the moment `power` is dropped from
    // the cost, which a fixture handed a pile of runes could never see.
    const { state, shadowId } = board([makeUnit({ instanceId: "raider", name: "Raider", might: 4 })]);
    const energyOnly: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, channeled: [], floatingEnergy: 1 }],
    };
    expect(activationsOf(energyOnly, shadowId), "the [rainbow] half was never charged").toHaveLength(0);
  });

  it("is registered but reports HALF written, which is the honest answer", () => {
    // As first written this asserted `isCardImplemented === true` and noted that
    // "the integrator owes it a `coverage.PARTIALLY_IMPLEMENTED` row". That row
    // landed the same day, and a row is exactly what makes this card report
    // false — so the request and the assertion contradicted each other.
    //
    // Registration is per defId, so writing the ability alone WOULD have flipped
    // the card to DONE while "if you play me to a battlefield, I enter ready" is
    // still missing. The row is what stops that, and this now asserts the state
    // the row creates rather than the over-report it was added to prevent.
    // **Both halves are written as of 2026-08-13.** This asserted the row that
    // stopped the card over-reporting while its enter-ready clause was missing;
    // the clause landed once `unitEntersReady` was handed a destination, so the
    // row went with it.
    expect(isCardImplemented(registry.get(SHADOW)), "Shadow went back to being half-written").toBe(true);
    expect(partialImplementationNote(registry.get(SHADOW)), "a partial note came back").toBeUndefined();
    // The half that IS live must still be visible, or the row would be hiding a
    // working ability rather than naming a missing one.
    expect(implementingModules(SHADOW), "the ability is not visible to coverage").toContain("activated abilities");
    expect(registry.get(SHADOW).text).toContain("I enter ready");
  });
});
