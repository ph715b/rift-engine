import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/engine/cleanup.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * "HERE" is a REFERENT, and a referent is checked when the instruction EXECUTES.
 *
 * 359.3.f.1 names "here", "my" and "its" as information read from the ability's
 * SOURCE. 359.3.f.2: it "will be checked on execution of the instruction", and
 * 359.3.f.2.a: an illegal referent "will return 'null' and all instructions
 * related to it will be ignored". The rules' own worked example is a card in this
 * pool, verbatim:
 *
 *   "A player moves Yasuo, Remorseful to an occupied enemy battlefield and
 *   initiates combat there. In reaction to the Yasuo, Remorseful attack trigger,
 *   their opponent plays Fight or Flight from hidden targeting Yasuo, moving him
 *   back to base. When the attack trigger resolves, 'here' is no longer the
 *   battlefield where combat is ongoing and the attack trigger MISTARGETS."
 *
 * The contrast is 359.3.f.3 (Lillia - Fae Fawn), where the information comes from
 * the TRIGGER CONDITION and is fixed when the condition is met. Nothing in this
 * file is that shape, and the on-play "play a token here" family — which might be
 * — is deliberately not touched by it.
 *
 * **383 is the wrong rule for this question**, and this file exists because four
 * cards' comments cited it. 383 fixes THAT an ability triggered: an opponent
 * cannot un-trigger a fired attack trigger by moving its unit, and none of these
 * tests claim otherwise. Every one of them asserts the Pending Item WAS placed
 * before it asserts the instruction did nothing — "0 damage" reads identically
 * for "correctly mistargeted" and "never fired", and only the chain can tell them
 * apart.
 *
 * The window is real and this is how it is opened: `runCleanup` stages the
 * Showdown and HOLDS the triggers, the board is then edited the way a reaction
 * would edit it, and `resolveHeldTriggers` pops the chain. `beginCombatAt` does
 * both halves in one call and leaves nowhere to stand in for the opponent.
 */

const registry = defaultCardRegistry();

const VOLIBEAR = "OGN-041";
const CRACKSHOT_CORSAIR = "OGN-130";
const DUNE_DRAKE = "OGN-131";
const ANIVIA = "OGN-148";
const WARWICK = "OGN-159";
const LEONA_DETERMINED = "OGN-238";
const AVA_ACHIEVER = "OGN-107";
const TWISTED_FATE = "OGN-200";
const YASUO_REMORSEFUL = "OGN-076";
const FORGEFIRE_CAPE = "SFD-190";
/** Teemo - Strategist, used here only as a card that prints [Hidden] and is a
 *  UNIT — the one shape that makes Ava Achiever's "if it's a unit, play it here"
 *  observable. Nothing here exercises his own trigger. */
const HIDDEN_UNIT = "OGN-121";

/** p1's `attacker` standing at bf1 against p2's `defenders`, with bf1 already
 *  Contested by p1 — so the next Cleanup stages a COMBAT Showdown and 464.2.c
 *  Step 1 hands out the Attacker designation for real. */
function contested(attacker: UnitInstance, defenders: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.units = { p1: [attacker], p2: defenders };
  state.battlefields[0]!.controllerId = "p2";
  state.battlefields[0]!.contestedByIndex = 0;
  // A second fight to walk out into, with its own enemy body. Without one, every
  // assertion below could pass on an "off the board entirely" branch, and none of
  // them would notice a resolver that re-aimed "here" at wherever the unit went.
  state.battlefields[1]!.units = { p2: [] };
  return state;
}

/** The defIds of the triggered abilities waiting on the chain. The positive
 *  control every test in this file needs. */
const heldTriggerDefIds = (state: GameState): string[] =>
  state.spellChain.flatMap((e) => ("kind" in e && e.kind === "trigger" ? [(e as { listenerDefId: string }).listenerDefId] : []));

/** Walks `mover` off bf1 and onto bf2, where `bystanders` are already standing —
 *  what Fight or Flight does to Yasuo in the worked example, done to the held
 *  state directly because no card in this pool can be cast from a test fixture
 *  mid-chain. */
function walkOutTo(state: GameState, mover: UnitInstance, bystanders: UnitInstance[]): GameState {
  return {
    ...state,
    battlefields: state.battlefields.map((bf) =>
      bf.id === "bf1"
        ? { ...bf, units: { ...bf.units, p1: (bf.units["p1"] ?? []).filter((u) => u.instanceId !== mover.instanceId) } }
        : bf.id === "bf2"
          ? { ...bf, units: { p1: [mover], p2: bystanders } }
          : bf,
    ),
  };
}

const unitsAt = (state: GameState, battlefieldId: string, playerId: string): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const attackerAfter = (state: GameState, instanceId: string): UnitInstance | undefined =>
  state.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === instanceId);

/**
 * The six attack triggers in `unit-triggers.ts`'s `ATTACK_TRIGGERS`, whose
 * printed text is ONE instruction and that instruction says "here". They share
 * one adapter, so the drop is written once — but each is driven separately here,
 * because a shared adapter is exactly the thing that can be right for the entry
 * that was checked and wrong for the card that never gets a test.
 *
 * `landed` is per card because the six do six different things, and each is
 * asked of BOTH battlefields: not landing at bf1 is the ruling, and not landing
 * at bf2 is the other half of it (moot, never re-aimed).
 */
interface HereCase {
  defId: string;
  label: string;
  /** Damage the enemy bodies start with — Warwick's "kill all DAMAGED enemy
   *  units here" is the only trigger here that needs a board with history. */
  victimDamage?: number;
  /** Is this card's instruction visible at `battlefieldId`? */
  landed: (state: GameState, battlefieldId: string, attackerId: string) => boolean;
}

const enemyHurtAt: HereCase["landed"] = (state, battlefieldId) =>
  unitsAt(state, battlefieldId, "p2").some((u) => u.damage > 0);

const HERE_CASES: readonly HereCase[] = [
  {
    defId: VOLIBEAR,
    label: "Volibear - Furious: deal 5 split among any number of enemy units here",
    landed: enemyHurtAt,
  },
  {
    defId: CRACKSHOT_CORSAIR,
    label: "Crackshot Corsair: deal 1 to an enemy unit here",
    landed: enemyHurtAt,
  },
  {
    defId: ANIVIA,
    label: "Anivia - Primal: deal 3 to all enemy units here",
    landed: enemyHurtAt,
  },
  {
    defId: LEONA_DETERMINED,
    label: "Leona - Determined: stun an enemy unit here",
    landed: (state, battlefieldId) => unitsAt(state, battlefieldId, "p2").some((u) => u.stunned),
  },
  {
    defId: WARWICK,
    label: "Warwick - Hunter: kill all damaged enemy units here",
    victimDamage: 1,
    // The bodies start damaged, so "landed" is that they are GONE.
    landed: (state, battlefieldId) => unitsAt(state, battlefieldId, "p2").length === 0,
  },
  {
    defId: DUNE_DRAKE,
    // The one whose effect is on ITSELF rather than on the enemies — so "did not
    // re-aim" is not about bf2's board but about whether a ready enemy standing
    // beside him at bf2 could still satisfy his "here". It must not.
    //
    // **His DIED case is the one variant below that cannot discriminate, and that
    // is measured, not assumed**: with `isStillHere` mutated to `true`, 15 of the
    // 16 negative assertions in this file went red and his did not — a dead Drake
    // has nothing to carry a `mightThisTurn` either way. It is kept for symmetry
    // and because it still asserts nothing throws; it proves nothing on its own.
    label: "Dune Drake: +2 Might this turn if there is a ready enemy unit here",
    landed: (state, _battlefieldId, attackerId) => (attackerAfter(state, attackerId)?.mightThisTurn ?? 0) > 0,
  },
];

describe("the wholly-'here' attack triggers drop when their source has left the fight (359.3.f.2)", () => {
  for (const kase of HERE_CASES) {
    describe(kase.label, () => {
      const victims = () => [
        makeUnit({ instanceId: "victim", might: 20, damage: kase.victimDamage ?? 0 }),
        makeUnit({ instanceId: "victim2", might: 20, damage: kase.victimDamage ?? 0 }),
      ];
      const bystanders = () => [
        makeUnit({ instanceId: "bystander", might: 20, damage: kase.victimDamage ?? 0 }),
      ];

      it("POSITIVE CONTROL: lands at the combat when the source stays put", () => {
        // Same code path as the test below, differing only by the move — which is
        // what makes that one an A/B rather than an assertion that nothing
        // happened on a board where nothing could have.
        const attacker = realUnitInstance(kase.defId);
        const staged = runCleanup(contested(attacker, victims()));
        expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(kase.defId);

        const settled = resolveHeldTriggers(staged);

        expect(kase.landed(settled, "bf1", attacker.instanceId), "the trigger fired but did nothing").toBe(true);
      });

      it("mistargets when the source walks out during the response window", () => {
        const attacker = realUnitInstance(kase.defId);
        const staged = runCleanup(contested(attacker, victims()));
        expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(kase.defId);

        const settled = resolveHeldTriggers(walkOutTo(staged, attacker, bystanders()));

        expect(kase.landed(settled, "bf1", attacker.instanceId), "it reached into a fight it had left").toBe(false);
        expect(kase.landed(settled, "bf2", attacker.instanceId), "'here' was re-aimed at wherever it ended up").toBe(false);
      });

      it("mistargets when the source DIED during the response window", () => {
        // A unit off the board has no location for "here" to read, so this is the
        // same null referent — and it is a different code path: `resolveHeldTriggers`
        // falls back to the CAPTURED listener card, whose recorded battlefield is
        // still the combat's. A check written against that field would pass here.
        const attacker = realUnitInstance(kase.defId);
        const staged = runCleanup(contested(attacker, victims()));
        expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(kase.defId);

        const killed = {
          ...staged,
          battlefields: staged.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [] } } : bf)),
        };
        const settled = resolveHeldTriggers(killed);

        expect(kase.landed(settled, "bf1", attacker.instanceId), "a dead source still resolved its 'here'").toBe(false);
      });
    });
  }
});

describe("Yasuo - Remorseful (OGN-076) — the card the worked example is ABOUT", () => {
  /** Yasuo attacking bf1 with one enemy body big enough to survive his Might. */
  const staged = () => {
    const yasuo = realUnitInstance(YASUO_REMORSEFUL);
    return { yasuo, state: runCleanup(contested(yasuo, [makeUnit({ instanceId: "victim", might: 20 })])) };
  };

  const damageOf = (state: GameState, battlefieldId: string, instanceId: string) =>
    unitsAt(state, battlefieldId, "p2").find((u) => u.instanceId === instanceId)?.damage ?? 0;

  it("POSITIVE CONTROL: deals his Might to the enemy here when he stays", () => {
    const { yasuo, state } = staged();
    expect(heldTriggerDefIds(state), "his trigger was never placed").toContain(YASUO_REMORSEFUL);

    const settled = resolveHeldTriggers(state);

    expect(damageOf(settled, "bf1", "victim"), "his attack trigger never landed").toBe(
      (registry.get(YASUO_REMORSEFUL) as { might?: number }).might ?? 0,
    );
    expect(yasuo.instanceId).toBeDefined();
  });

  it("MISTARGETS when Fight or Flight sends him back to base mid-chain", () => {
    // The example verbatim, with the move made directly: `recallUnitToBase` is
    // what Fight or Flight calls, and what it leaves behind is a Yasuo in base —
    // no battlefield, so no "here".
    const { yasuo, state } = staged();
    expect(heldTriggerDefIds(state), "his trigger was never placed").toContain(YASUO_REMORSEFUL);

    const sentHome: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, baseUnits: [...state.players[0]!.baseUnits, { ...yasuo, exhausted: true }] },
        state.players[1]!,
      ],
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [] } } : bf)),
    };

    const settled = resolveHeldTriggers(sentHome);

    expect(damageOf(settled, "bf1", "victim"), "he shot into the combat from his own base").toBe(0);
  });

  it("MISTARGETS rather than re-aiming when he is moved to another fight", () => {
    const { yasuo, state } = staged();
    const settled = resolveHeldTriggers(walkOutTo(state, yasuo, [makeUnit({ instanceId: "bystander", might: 20 })]));

    expect(damageOf(settled, "bf1", "victim"), "he reached into the fight he had left").toBe(0);
    expect(damageOf(settled, "bf2", "bystander"), "'here' followed him to his new battlefield").toBe(0);
  });
});

describe("Twisted Fate - Gambler (OGN-200) — only the [Fury] branch says 'here'", () => {
  /** TF attacking bf1, with `domain` on top of his rune deck. A second rune sits
   *  under it so the recycle is observable as a rotation rather than as a loss. */
  function staged(domain: "Fury" | "Mind" | "Order") {
    const tf = realUnitInstance(TWISTED_FATE);
    const state = contested(tf, [makeUnit({ instanceId: "victim", might: 20 })]);
    state.players[0]!.runeDeck = [
      { id: "top", domain, state: "Ready" } as never,
      { id: "under", domain: "Calm", state: "Ready" } as never,
    ];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "homebody", might: 3 })];
    return { tf, state: runCleanup(state) };
  }

  it("[Fury] POSITIVE CONTROL: 2 to the enemy here when he stays", () => {
    const { state } = staged("Fury");
    const settled = resolveHeldTriggers(state);
    expect(unitsAt(settled, "bf1", "p2").find((u) => u.instanceId === "victim")!.damage).toBe(2);
  });

  it("[Fury] drops the damage when he has left — but the rune is still revealed and recycled", () => {
    // The reason he is not gated wholesale by the adapter. "Reveal the top rune of
    // your rune deck, then recycle it" names no referent, so 359.3.f.2.a's "all
    // instructions RELATED TO IT" does not reach it (135.2.b splits them).
    const { tf, state } = staged("Fury");
    expect(heldTriggerDefIds(state), "his trigger was never placed").toContain(TWISTED_FATE);

    const settled = resolveHeldTriggers(walkOutTo(state, tf, [makeUnit({ instanceId: "bystander", might: 20 })]));

    expect(unitsAt(settled, "bf1", "p2").find((u) => u.instanceId === "victim")!.damage, "he shot the fight he had left").toBe(0);
    expect(unitsAt(settled, "bf2", "p2").find((u) => u.instanceId === "bystander")!.damage, "'here' was re-aimed").toBe(0);
    expect(settled.players[0]!.runeDeck.map((r) => r.id), "the rune rotation was dropped with the damage").toEqual([
      "under",
      "top",
    ]);
  });

  it("[Mind] still draws when he has left — that branch names no 'here'", () => {
    const { tf, state } = staged("Mind");
    const settled = resolveHeldTriggers(walkOutTo(state, tf, []));

    expect(settled.players[0]!.hand.map((c) => c.name), "the draw was dropped with the 'here' instruction").toEqual(["Drawn"]);
  });

  it("[Order] still stuns an enemy anywhere when he has left — that branch names no 'here' either", () => {
    const { tf, state } = staged("Order");
    const settled = resolveHeldTriggers(walkOutTo(state, tf, []));

    // "Stun an ENEMY UNIT", bare noun (355.9.b), so it reaches the base — and
    // base is first in board order, which is why the homebody is the one stunned.
    expect(settled.players[1]!.baseUnits.find((u) => u.instanceId === "homebody")!.stunned, "the stun was dropped").toBe(true);
  });
});

describe("Ava Achiever (OGN-107) is deliberately NOT re-checked — the ruling does not cover her shape", () => {
  it("still offers the Hidden play from the battlefield she attacked, after walking out", () => {
    // **A PIN ON AN UNRULED CARD, not an endorsement.** Her text is two
    // instructions (135.2.b): "you may pay [Mind] to play a card with [Hidden]
    // from your hand, ignoring its cost" names no referent and must survive an Ava
    // who has left, while "if it's a unit, play it HERE" does. What a null "here"
    // does to a card that has already been played — base, or no play at all — is
    // not settled, and that is Teemo - Strategist's question (OGN-121), which is
    // likewise unruled.
    //
    // So this asserts the PRE-359.3.f behaviour verbatim. When the owner rules,
    // this test is the thing that fails and says so.
    const ava = realUnitInstance(AVA_ACHIEVER);
    const state = contested(ava, [makeUnit({ instanceId: "victim", might: 20 })]);
    // A payable [Mind] and a real [Hidden] UNIT in hand, so the question has a
    // second option and the "play it HERE" half is actually reached — with an
    // empty hand she offers only "decline" and this pins nothing.
    state.players[0]!.channeled = [{ id: "m1", domain: "Mind", state: "Ready" }];
    const teemo = createCardInstance(registry.get(HIDDEN_UNIT));
    state.players[0]!.hand = [teemo];
    const staged = runCleanup(state);
    expect(heldTriggerDefIds(staged), "her trigger was never placed").toContain(AVA_ACHIEVER);

    const settled = resolveHeldTriggers(walkOutTo(staged, ava, []));

    const asked = pendingDecision(settled);
    expect(asked?.kind, "her question was dropped — that is a RULING, and it has not been made").toBe("OGN-107-play");
    expect((asked as { battlefieldId?: string } | undefined)?.battlefieldId).toBe("bf1");

    const played = answerDecisions(settled, (options) => options.find((o) => o.instanceId === teemo.instanceId)!.id);
    expect(
      unitsAt(played, "bf1", "p1").map((u) => u.defId),
      "the [Hidden] unit landed somewhere other than the captured battlefield",
    ).toEqual([HIDDEN_UNIT]);
  });
});

describe("Forgefire Cape (SFD-190) — the wearer is the source, and the wearer's 'here' is re-checked", () => {
  const cape = (): GearInstance => createCardInstance(registry.get(FORGEFIRE_CAPE)) as GearInstance;

  /** A wearer at bf1 with the Cape on, two enemy bodies opposite, bf1 contested
   *  by the wearer's controller. */
  function staged() {
    const wearer = makeUnit({ instanceId: "wearer", might: 4 });
    const worn = cape();
    const state = contested(wearer, [
      makeUnit({ instanceId: "enemy-a", might: 9 }),
      makeUnit({ instanceId: "enemy-b", might: 9 }),
    ]);
    state.players[0]!.activeGear = [worn];
    return { wearer, state: runCleanup(attachEquipment(state, 0, worn.instanceId, "wearer")) };
  }

  const damageAt = (state: GameState, battlefieldId: string, instanceId: string) =>
    unitsAt(state, battlefieldId, "p2").find((u) => u.instanceId === instanceId)?.damage ?? 0;

  it("POSITIVE CONTROL: burns every enemy at the combat when the wearer stays", () => {
    const { state } = staged();
    expect(heldTriggerDefIds(state), "the Cape's trigger was never placed").toContain(FORGEFIRE_CAPE);

    const settled = resolveHeldTriggers(state);

    expect(damageAt(settled, "bf1", "enemy-a")).toBe(2);
    expect(damageAt(settled, "bf1", "enemy-b")).toBe(2);
  });

  it("burns nobody when its wearer walks out — Recurve Bow's rule, on its sibling", () => {
    const { wearer, state } = staged();
    expect(heldTriggerDefIds(state), "the Cape's trigger was never placed").toContain(FORGEFIRE_CAPE);

    const settled = resolveHeldTriggers(walkOutTo(state, wearer, [makeUnit({ instanceId: "bystander", might: 9 })]));

    expect(damageAt(settled, "bf1", "enemy-a"), "the Cape burned a fight its wearer had left").toBe(0);
    expect(damageAt(settled, "bf1", "enemy-b"), "the Cape burned a fight its wearer had left").toBe(0);
    expect(damageAt(settled, "bf2", "bystander"), "'here' followed the wearer to his new battlefield").toBe(0);
  });
});
