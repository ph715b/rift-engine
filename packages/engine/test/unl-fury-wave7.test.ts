import { describe, expect, it } from "vitest";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { recordConquest } from "../src/engine/scoring.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance, UnitInstance } from "../src/model/card.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed Fury — wave 7.
 *
 * **Two of the wave's eleven cards were written, and nine were refused.** The
 * refusals are the larger half of this file's job: a card written against a
 * mechanism that does not exist reports DONE and does nothing, so each refusal is
 * asserted here as a WRONG answer on purpose, and landing the mechanism fails
 * loudly rather than changing behaviour nobody was watching.
 *
 *  - **UNL-005 Revna** and **UNL-181 Jhin - Virtuoso** both read "when you play a
 *    spell, if you spent [4] or more". The `spellCast` event carries `totalCost`,
 *    which is the PRINTED Energy plus Power — so a 2-Energy/2-Power spell reads 4
 *    while spending 2, and `maxSpellEnergySpentThisTurn` is a turn MAXIMUM rather
 *    than this spell's price. Both readings fire on turns the card does not
 *    describe, which is the stronger-than-printed direction. Jhin is additionally
 *    a Legend (legend-abilities.ts) and needs a "banished with me" zone.
 *  - **UNL-007 Smite**'s turn-long "banish it instead" and **UNL-017 Square Up**'s
 *    `[Repeat] — Discard 1` were refused in waves 3 and 4 and are pinned there.
 *  - **UNL-013 Lotus Trap** is named IN THE RULES (465.2.c.5's worked example), and
 *    what the rules say about it is why it is bigger than one file: the doubling
 *    applies during combat damage ASSIGNMENT, ordered against prevention effects by
 *    the defender's controller.
 *  - **UNL-023 Katarina - Reckless**' "when you hide a card, ready me" has no event
 *    to listen to — `executeHideCard` fires `runesRecycled` and nothing else.
 *  - **UNL-025 Undying Legion** and **UNL-186 Death from Below** both want a
 *    per-instance play-from-trash permission at a REPLACED price;
 *    `timing.mayPlayFromTrash` is per-player, Units-only, and charges printed.
 *  - **UNL-182 Curtain Call** prints THREE `[Repeat]`s and `RepeatCostSpec` models
 *    exactly one.
 *
 * Everything below goes through a real funnel — `legalActions`/`submit` for the
 * spell, `recordConquest` plus the held-trigger settle for the gear — never a
 * resolver imported by hand, because a card that is registered but unreachable has
 * to fail here rather than pass while being dead in a game.
 */

const registry = defaultCardRegistry();

const DANCING_GRENADE = "UNL-020"; // Spell, 2 Energy 1 Fury — deal 2, plus an unwritten replay
const HEXTECH_GAUNTLETS = "UNL-188"; // Gear, 3 Energy — [Equip] [3][rainbow], +3 badge, art-only conquer draw

/** The nine refusals, asserted at the bottom. */
const REVNA = "UNL-005";
const SMITE = "UNL-007";
const LOTUS_TRAP = "UNL-013";
const SQUARE_UP = "UNL-017";
const KATARINA_RECKLESS = "UNL-023";
const UNDYING_LEGION = "UNL-025";
const JHIN_VIRTUOSO = "UNL-181";
const CURTAIN_CALL = "UNL-182";
const DEATH_FROM_BELOW = "UNL-186";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });
const runes = (count: number): RuneCard[] => Array.from({ length: count }, (_, i) => fury(`f${i}`));

function accept(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the action was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are both empty (340). */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  throw new Error("settle: the chain never emptied");
}

/** The unit as the BOARD holds it, wherever it stands. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const castsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

// ---------------------------------------------------------------------------

describe("Dancing Grenade (UNL-020): deal 2 to a unit", () => {
  /**
   * An enemy and a friendly at bf1, one unit in each BASE, and the Grenade in
   * hand with runes to pay for it.
   *
   * Every unit is printed big enough to survive 2 — a dead target and an untouched
   * one both read as "no damage on the board", which is the shape that makes a
   * damage assertion pass while nothing happened.
   */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "bystander", might: 9 })],
      p2: [makeUnit({ instanceId: "enemy", might: 9 })],
    };
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "myHomebody", might: 9 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirHomebody", might: 9 })];
    state.players[0]!.hand = [spellInstance(DANCING_GRENADE)];
    state.players[0]!.channeled = runes(8);
    return state;
  }

  function castAt(state: GameState, targetInstanceId: string): GameState {
    const play = castsOf(state, DANCING_GRENADE).find((a) => a.targetUnitInstanceId === targetInstanceId);
    expect(play, `Dancing Grenade was not castable at ${targetInstanceId}`).toBeDefined();
    return settle(accept(state, play));
  }

  it("marks 2 on its target, through a REAL cast", () => {
    const state = board();
    expect(unitOnBoard(state, "enemy")!.damage, "the fixture was already damaged").toBe(0);

    const after = castAt(state, "enemy");
    expect(unitOnBoard(after, "enemy")!.damage, "the spell resolved but the damage never landed").toBe(2);
  });

  it("NEGATIVE CONTROL: the unit standing beside the target takes nothing", () => {
    const after = castAt(board(), "enemy");
    expect(unitOnBoard(after, "bystander")!.damage).toBe(0);
    expect(unitOnBoard(after, "theirHomebody")!.damage).toBe(0);
  });

  it("'A UNIT' is bare, so BOTH bases are reachable — 355.9.a.1's widening", () => {
    // No owner word and no location word, so the noun means objects on the Board
    // ("'Unit,' 'gear,' and 'rune' refer to objects on the Board unless specified
    // otherwise"). Contrast Smite one card over, which prints "at a battlefield"
    // and takes 355.9.b's narrowing instead.
    const targets = castsOf(board(), DANCING_GRENADE).map((a) => a.targetUnitInstanceId);

    expect(targets, "the spell is not castable at all — this test measures nothing").toContain("enemy");
    expect(targets).toContain("bystander");
    expect(targets).toContain("myHomebody");
    expect(targets).toContain("theirHomebody");
  });

  it("a friendly target really is damaged, not silently skipped", () => {
    // Arming the enumerator with a friendly target proves nothing if the resolver
    // then declines to hit it — the card names no owner, so a misplay is legal.
    const after = castAt(board(), "bystander");
    expect(unitOnBoard(after, "bystander")!.damage).toBe(2);
    expect(unitOnBoard(after, "enemy")!.damage).toBe(0);
  });

  it("PIN (HALF-WRITTEN): the replay is UNWRITTEN — nothing is offered to anybody", () => {
    // Asserting the WRONG answer on purpose. "Its controller may play this spell
    // again for [rainbow]. If they do, this deals 1 additional Bonus Damage for
    // each time this spell has dealt damage this turn" needs three things this
    // wave could not build: the card leaving the CASTER's trash to be played by
    // its target's controller, a per-instance permission with a REPLACED price
    // (`timing.mayPlayFromTrash` is per-player, Units-only, printed price), and a
    // turn-scoped tally of one card's damage instances.
    //
    // Measured as "no question was parked for either player, and the spell is in
    // the trash rather than back in a hand" — the two observable shapes any
    // implementation of the clause would have to produce.
    const after = castAt(board(), "enemy");

    expect(after.pendingDecisions, "a question was parked — has the replay landed? delete this pin").toEqual([]);
    expect(
      after.players[0]!.trash.some((c) => c.defId === DANCING_GRENADE),
      "the Grenade did not reach the trash — this pin is measuring the wrong zone",
    ).toBe(true);
    // The damage is a flat 2 with no escalation, because nothing counted a first
    // instance. Re-stated as the number rather than as an absence, so a bonus
    // arriving from anywhere fails here.
    expect(unitOnBoard(after, "enemy")!.damage).toBe(2);
  });

  it("coverage must name the half that is missing", () => {
    // **THIS TEST IS RED UNTIL A ROW LANDS IN coverage.PARTIALLY_IMPLEMENTED, AND
    // THAT IS THE POINT.** Registration is per defId, so the damage half above
    // claims the whole card, and this wave could not edit coverage.ts (five agents
    // were writing at once).
    //
    // The assertion is written as the TRUTH rather than as the current answer:
    // Dancing Grenade is not a finished card, so it must not report as one. The
    // owed row is
    //
    //   ["UNL-020", "half written: the 2 damage works; 'its controller may play
    //    this spell again for [rainbow]' is unwritten — the replay leaves the
    //    CASTER's trash to be played by its target's controller at a REPLACED
    //    price, and nothing tallies one spell's damage instances this turn"]
    //
    // `unl-fury-wave3.test.ts` carries the same assertion for this defId and goes
    // red with it, from the same cause and fixed by the same one line — so the two
    // files agree rather than contradicting each other, which is what a
    // "flip me at integration" pin would have produced here.
    expect(
      partialImplementationNote(registry.get(DANCING_GRENADE)),
      "the PARTIALLY_IMPLEMENTED row for UNL-020 is still owed — see this test's comment for its text",
    ).toBeDefined();
    expect(isCardImplemented(registry.get(DANCING_GRENADE))).toBe(false);
  });
});

describe("Hextech Gauntlets (UNL-188): when I conquer with 3+ excess damage, draw 1", () => {
  /**
   * The Gauntlets worn by a unit at `where`, with `excess` recorded against a
   * fight.
   *
   * `attachedToInstanceId` is set directly rather than through `attachEquipment`,
   * which fires a held `equipmentAttached` event these fixtures would then have to
   * settle first — the same shortcut `unl-fury-wave3.test.ts` takes for the
   * Battleaxe, and for the same reason.
   *
   * The deck is stocked because "draw 1" off an empty deck is indistinguishable
   * from not drawing at all.
   */
  function board(
    excess: { battlefieldId: string; attackerIndex: 0 | 1; amount: number } | null,
    where: "bf1" | "bf2" = "bf1",
  ): { state: GameState; gauntlets: GearInstance; wearer: UnitInstance } {
    const wearer = makeUnit({ instanceId: "wearer", might: 6 });
    const gauntlets = { ...realGearInstance(HEXTECH_GAUNTLETS), attachedToInstanceId: wearer.instanceId };
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[where === "bf1" ? 0 : 1]!.units = { p1: [wearer] };
    state.players[0]!.activeGear = [gauntlets];
    state.players[0]!.deck = [spellInstance(DANCING_GRENADE), spellInstance(DANCING_GRENADE)];
    state.players[1]!.deck = [spellInstance(DANCING_GRENADE), spellInstance(DANCING_GRENADE)];
    state.lastShowdownExcessDamage = excess;
    return { state, gauntlets, wearer };
  }

  const handSize = (state: GameState, playerIndex: 0 | 1): number => state.players[playerIndex]!.hand.length;

  it("draws 1 for the wearer's controller, through the real conquest funnel", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 3 });
    expect(handSize(state, 0), "the fixture already held cards — this would read as a draw").toBe(0);

    const after = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(handSize(after, 0), "the trigger never reached the resolver").toBe(1);
    expect(handSize(after, 1), "the opponent drew").toBe(0);
  });

  it("the threshold is >=, not > — exactly 3 draws and 2 does not", () => {
    const three = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 3 });
    expect(handSize(resolveHeldTriggers(recordConquest(three.state, 0, "bf1")), 0)).toBe(1);

    // NEGATIVE CONTROL: the same board one point of excess short.
    const two = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 2 });
    expect(handSize(resolveHeldTriggers(recordConquest(two.state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: a conquest that was not an attack draws nothing", () => {
    // Walking into an empty battlefield never writes the record, so there is no
    // number to borrow — "you assigned excess damage" implies a fight.
    const { state } = board(null);
    expect(handSize(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: another fight's excess cannot be borrowed", () => {
    const { state } = board({ battlefieldId: "bf2", attackerIndex: 0, amount: 9 });
    expect(handSize(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: the excess the OPPONENT assigned is not 'you assigned'", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 1, amount: 9 });
    expect(handSize(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: 'when *I* conquer' is positional — a conquest at bf1 while the wearer stands at bf2 draws nothing", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 9 }, "bf2");
    expect(handSize(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: UNATTACHED gauntlets have no 'I' and never trigger", () => {
    // The whole difference between an Equipment's band and a Gear's own ability:
    // a gear conquers nothing, so the trigger exists only while somebody is
    // wearing it. Asserted at the HOLD as well as at the payout, so "it triggered
    // and drew nothing" cannot pass as "it never triggered".
    const { state, gauntlets } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 9 });
    state.players[0]!.activeGear = [{ ...gauntlets, attachedToInstanceId: null }];

    const held = recordConquest(state, 0, "bf1");
    expect(held.pendingTriggers.map((e) => e.listenerDefId), "it triggered with nobody wearing it").not.toContain(
      HEXTECH_GAUNTLETS,
    );
    expect(handSize(resolveHeldTriggers(held), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: the OPPONENT's conquest pays neither player", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 1, amount: 9 });
    const after = resolveHeldTriggers(recordConquest(state, 1, "bf1"));
    expect(handSize(after, 0)).toBe(0);
    expect(handSize(after, 1)).toBe(0);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the conquest", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 5 });
    const held = recordConquest(state, 0, "bf1");

    expect(held.pendingTriggers.map((e) => e.listenerDefId)).toContain(HEXTECH_GAUNTLETS);
    expect(handSize(held, 0), "it resolved inline instead of waiting on the chain").toBe(0);
  });

  it("detaching in the response window does NOT cancel the draw — 383.2.a.1's Sona example", () => {
    // "If she is removed in reaction to the triggered ability, it will still
    // resolve." The condition is asked when the trigger FIRES; the chain item is
    // then independent of the gear that made it, and this card's payout ("draw 1")
    // names nobody, so nothing has to be re-derived at resolution.
    //
    // Reachable rather than theoretical: Angle Shot (SFD-011) is a `[Reaction]`
    // that detaches an Equipment, and `battlefieldConquered` is a HELD event — the
    // window between the conquest and this resolution is exactly where it lands.
    //
    // This is a DELIBERATE break from the eight SFD/UNL bands beside it, which do
    // re-derive their wearer; theirs have to, because their payouts are about the
    // wearer. Written as a test rather than only as a comment because it is the one
    // place this card differs from its neighbours.
    const { state, gauntlets } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 4 });
    const held = recordConquest(state, 0, "bf1");
    expect(held.pendingTriggers.map((e) => e.listenerDefId), "it never fired — this test measures nothing").toContain(
      HEXTECH_GAUNTLETS,
    );

    const detached: GameState = {
      ...held,
      players: [
        { ...held.players[0]!, activeGear: [{ ...gauntlets, attachedToInstanceId: null }] },
        held.players[1]!,
      ] as GameState["players"],
    };

    expect(handSize(resolveHeldTriggers(detached), 0), "detaching cancelled a trigger that had already fired").toBe(1);
  });

  it("PIN (DIVERGENCE): the [Equip] cost is charged FLAT, not reduced by the chosen unit's Might", () => {
    // Asserting the WRONG answer on purpose, and this one was NOT previously
    // recorded anywhere — the card's PRINTED text (not the art band) reads "[Equip]
    // [3][rainbow]. This ability's Energy cost is reduced by the Might of the unit
    // you choose", and `activated-abilities.equipAbilities` builds one static
    // `ActivationCost` per gear from `def.equipCost`. A cost that depends on WHICH
    // unit the activation targets has no expression there — the same shape
    // `sacrificeCostDiscount` had to be invented for.
    //
    // The direction is the SAFE one (the gear is always more expensive than
    // printed, never cheaper), which is precisely why nothing else would notice.
    // `CardDefinition` is a union and only the Gear arm carries `equipCost`, so
    // the narrow is load-bearing rather than defensive — without it this file
    // does not typecheck, which is how it was caught.
    const def = registry.get(HEXTECH_GAUNTLETS);
    expect(def.type, "Hextech Gauntlets stopped being Gear").toBe("Gear");
    expect(
      def.type === "Gear" ? def.equipCost : undefined,
      "the equip cost stopped parsing — re-read this pin",
    ).toMatchObject({ energy: 3 });

    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const beefy = makeUnit({ instanceId: "beefy", might: 8 });
    state.battlefields[0]!.units = { p1: [beefy] };
    state.players[0]!.activeGear = [realGearInstance(HEXTECH_GAUNTLETS)];
    // Two Energy is one short of the flat 3 and far short of nothing at all: a
    // Might-8 unit would reduce the Energy half to 0, so an implementation of the
    // rider would make this activation legal.
    state.players[0]!.channeled = runes(2);

    const equips = legalActions(state).filter(
      (a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === "beefy",
    );
    expect(equips, "the Might reduction LANDED — delete this pin and record it").toHaveLength(0);

    // POSITIVE CONTROL on the instrument: with the flat price in the pool the same
    // activation IS offered, so the empty list above is a measurement rather than
    // an enumerator that never offers an equip.
    state.players[0]!.channeled = runes(6);
    expect(
      legalActions(state).filter((a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === "beefy").length,
      "the equip is not enumerable at any price — this pin measures nothing",
    ).toBeGreaterThan(0);
  });

  it("still reports UNFINISHED, and the reason has CHANGED", () => {
    // The card keeps its `coverage.PARTIALLY_IMPLEMENTED` row but the row's TEXT is
    // now wrong, which is why this asserts the stable half rather than the wording.
    //
    // The row says "art-only: its conquer-with-3-excess-damage draw is unwritten
    // (only the [Equip] cost and +3 badge work)". That band is written above. What
    // is unwritten is the rider in the card's own PRINTED text — "this ability's
    // Energy cost is reduced by the Might of the unit you choose" — which no
    // earlier wave recorded anywhere, and which the pin above measures.
    //
    // **The rewrite has a second site**: `equipment-wearer-moments.test.ts` builds
    // its owed-list by filtering notes containing "art-only" and asserts it equals
    // `["UNL-188"]`. A rewritten note drops that substring, so that expectation
    // becomes `[]` in the same change — the same way it moved from three entries to
    // one when the Battleaxe and Soul Sword bands were written.
    expect(partialImplementationNote(registry.get(HEXTECH_GAUNTLETS)), "the row was dropped entirely").toBeDefined();
    expect(isCardImplemented(registry.get(HEXTECH_GAUNTLETS))).toBe(false);
  });
});

describe("the nine cards this wave REFUSED", () => {
  // Each is asserted as still-unimplemented, with the blocker named. These flip to
  // red the day the mechanism lands, which is the point: a refusal that quietly
  // becomes true is a card nobody goes back to write.
  const refusals: ReadonlyArray<readonly [string, string]> = [
    // **REVNA and KATARINA_RECKLESS left this list on 2026-08-13**, and both
    // refusals named their own price exactly. Revna needed the ENERGY actually
    // spent on a spell rather than its printed total; Katarina needed a
    // `cardHidden` event that nothing raised. Both landed as wave-8 primitives and
    // both cards were written the same day. Their coverage lives in
    // `unl-fury-wave8.test.ts`.
    // **UNDYING_LEGION left this list on 2026-08-13**, and his refusal named the
    // mechanism precisely: "a per-instance play-from-trash permission at a
    // REPLACED price". That is what landed — `engine/replaced-costs.ts`, rule
    // 356.1.a's "replace the card's Base Costs with [Cost]" — wired through all
    // THREE cost sites. His coverage lives in `test/replaced-costs.test.ts`.
    // **LOTUS_TRAP left this list on 2026-08-13**, and its blocker was the most
    // precisely stated of the nine: "a per-unit damage doubler read at combat
    // ASSIGNMENT (465.2.c.4.a/c.5) and at dealDamage" is exactly what was built.
    [JHIN_VIRTUOSO, "a Legend (legend-abilities.ts), the energy-spent figure, and a 'banished with me' zone"],
  ];

  for (const [defId, blocker] of refusals) {
    it(`${defId} is still unimplemented — ${blocker}`, () => {
      expect(isCardImplemented(registry.get(defId)), `${defId} was implemented — delete this row`).toBe(false);
    });
  }

  it("the four HALF-WRITTEN cards still carry their PARTIALLY_IMPLEMENTED note", () => {
    // Smite, Square Up, Curtain Call and Death from Below were each written by an
    // earlier wave down to a named blocker, and each blocker is still standing.
    // Asserted through `partialImplementationNote` rather than
    // `isCardImplemented` so that a note being DELETED (which would silently make
    // a half-written card report finished) fails here too.
    // **SQUARE_UP left this list on 2026-08-13** — its `[Repeat] — Discard 1` is
    // priced now, so it is whole and carries no note.
    // **DEATH_FROM_BELOW left it the same day**: its note named "a per-instance
    // permission with a REPLACED cost" and both halves landed
    // (`engine/replaced-costs.ts` + `PlayerState.replacedCostPlays`). Its coverage
    // is `test/replaced-costs.test.ts`.
    // **SMITE left this list on 2026-08-13.** Its note was a to-do list — "a
    // GameState list, a killUnit branch and a runEnd sweep" — and all three
    // landed exactly there. Curtain Call is the last one standing.
    for (const defId of [CURTAIN_CALL]) {
      expect(partialImplementationNote(registry.get(defId)), `${defId} lost its note`).toBeDefined();
      expect(isCardImplemented(registry.get(defId))).toBe(false);
    }
  });

  it("POSITIVE CONTROL on the instrument: a finished Fury card reports finished", () => {
    // Without this the block above passes just as well if `isCardImplemented`
    // returned false for everything.
    expect(isCardImplemented(registry.get("UNL-018")), "Yeti Brawler reports unfinished — the gate is broken").toBe(true);
  });
});
