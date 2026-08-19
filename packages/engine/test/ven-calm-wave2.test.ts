import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardModeOf, moveDestinationAllowed } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { modifiedEnergyCost, scaledPowerDiscount } from "../src/engine/cost-modifiers.js";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { hasAnyLegalEffectChoice, unitSatisfiesNarrowing } from "../src/engine/target-lookup.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's Calm cards — wave 2, the six that needed mechanism.**
 *
 * Two of them needed a fact the engine was actively DESTROYING before anyone
 * could read it, which is the theme worth keeping:
 *
 *   - Affectionate Poro asks "have I been dealt damage this turn", and rule 466
 *     step 3c heals every unit on the board at the end of every combat — so the
 *     `damage` field says 0 no matter what happened. The obvious implementation
 *     reports EVERY Poro as untouched, and looks like a working card.
 *   - It also asks "was I in that combat", and step 3d recalls surviving
 *     attackers home before any held trigger resolves — so the board cannot
 *     answer that either. The event carries its participants for the same reason
 *     `DeathContext` carries its unit.
 *
 * Both are asserted through a REAL combat rather than by poking the flags,
 * because a fixture that sets `damagedThisTurn` by hand proves only that the
 * reader reads it.
 */

const registry = defaultCardRegistry();

const AFFECTIONATE_PORO = "VEN-024";
const RESONATING_STRIKE = "VEN-034";
const CRUMBLING_SANDS = "VEN-039";
const DECREE_OF_FOCUS = "VEN-040";
const RIVEN_SHATTERED = "VEN-041";
const ASTRAL_HERON = "VEN-044";

/** A Fury unit and a non-Fury one, for Decree of Focus's narrowing. */
const FURY_UNIT = "OGN-003";
const CALM_UNIT = "OGN-130";
/** A real Equipment, for Riven. */
const AN_EQUIPMENT = "OGN-101";

const resolveSpell = (state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}) =>
  cardModeOf(spellInstance(defId), undefined)!.resolve(state, contextFor(casterIndex, "src"), event as never);

describe("Affectionate Poro (VEN-024): two facts the engine was destroying", () => {
  /** A real combat: the Poro attacks into a defender, both sides survive. */
  function combat(defenderMight: number): { state: GameState; poro: UnitInstance } {
    const state = makeState({ turnState: "Showdown", showdownKind: "Combat", showdownBattlefieldId: "bf1" });
    const poro = realUnitInstance(AFFECTIONATE_PORO);
    state.battlefields[0]!.units = { p1: [poro], p2: [makeUnit({ might: defenderMight })] };
    state.battlefields[0]!.contestedByIndex = 0;
    state.players[0]!.deck = [spellInstance("OGN-004")];
    return { state, poro };
  }

  it("draws when the combat ends and it took nothing", () => {
    // A 0-Might defender deals no damage, so the Poro comes through clean.
    const { state } = combat(0);
    const after = resolveHeldTriggers(resolveShowdown(state, "bf1", 0));

    expect(after.players[0]!.hand, "it did not draw").toHaveLength(1);
  });

  it("does NOT draw when it was dealt damage in that combat", () => {
    // **The assertion that the `damage` field cannot make.** Step 3c heals the
    // board before this resolves, so a reader looking at `damage` sees 0 here and
    // draws — which is the bug this card is shaped to expose.
    // **2, not 3.** The Poro is a 3-Might body: a lethal defender kills it, the
    // listener walk never finds it, and the test passes because nothing fired
    // rather than because the flag was read. Measured — the first draft did
    // exactly that.
    const { state } = combat(2);
    const after = resolveHeldTriggers(resolveShowdown(state, "bf1", 0));

    expect(after.players[0]!.hand, "damage did not stop the draw").toEqual([]);
  });

  it("...and the healing really did happen — the control on that claim", () => {
    const { state, poro } = combat(2);
    const after = resolveShowdown(state, "bf1", 0);
    const survivor = after.battlefields[0]!.units.p1?.find((u) => u.instanceId === poro.instanceId);

    expect(survivor, "the Poro died — this measures nothing").toBeDefined();
    expect(survivor!.damage, "step 3c did not heal, so the test proves nothing").toBe(0);
    expect(survivor!.damagedThisTurn, "the flag was not written").toBe(true);
  });

  it("does NOT draw when damaged earlier in the turn by a SPELL", () => {
    // "This turn", not "this combat" — so the other damage path has to write the
    // flag too, and it is swept by `runEnd` rather than by the combat cleanup.
    const { state, poro } = combat(0);
    const softened = dealDamage(state, 1, poro.instanceId, 1);
    const after = resolveHeldTriggers(resolveShowdown(softened, "bf1", 0));

    expect(after.players[0]!.hand, "spell damage earlier in the turn did not count").toEqual([]);
  });

  it("...and the flag is swept by the TURN", () => {
    const { state, poro } = combat(0);
    const damaged = dealDamage(state, 1, poro.instanceId, 1);
    const next = runEnd({ ...damaged, phase: "Action", turnState: "Neutral" });
    const later = next.battlefields[0]!.units.p1![0]!;

    expect(later.damagedThisTurn, "the flag outlived the turn").toBeUndefined();
  });

  it("is not even PLACED when it was damaged — read the offer, not the outcome", () => {
    // **Two guards cover the same outcome, so only one is observable at a time.**
    // `applies` refuses to place the Pending Item and `resolve` re-checks the live
    // unit; with the board static, deleting either leaves the hand empty and both
    // mutants survive. Measured.
    //
    // This one reads the PLACEMENT — the lesson Chaos wave 2's survivors left —
    // so the `applies` half is observable on its own.
    const { state, poro } = combat(2);
    const resolved = resolveShowdown(state, "bf1", 0);

    expect(
      resolved.pendingTriggers.map((e) => e.listenerDefId),
      "a damaged Poro was still placed on the chain",
    ).not.toContain(AFFECTIONATE_PORO);

    // POSITIVE CONTROL on the same instrument: undamaged, it IS placed.
    const clean = resolveShowdown(combat(0).state, "bf1", 0);
    expect(clean.pendingTriggers.map((e) => e.listenerDefId)).toContain(AFFECTIONATE_PORO);
    expect(poro.instanceId).toBeDefined();
  });

  it("...and is refused at RESOLUTION when it is damaged in the window", () => {
    // The other half, and the only state where the resolver's re-check is the
    // one that matters: the trigger is HELD undamaged, then a spell damages the
    // Poro before the chain pops. `applies` has already said yes.
    const { state, poro } = combat(0);
    const held = resolveShowdown(state, "bf1", 0);
    expect(held.pendingTriggers, "nothing was held — this measures nothing").not.toHaveLength(0);

    const damagedInWindow = dealDamage(held, 1, poro.instanceId, 1);
    const after = resolveHeldTriggers(damagedInWindow);

    expect(after.players[0]!.hand, "damage in the response window did not stop the draw").toEqual([]);
  });

  it("ignores a combat it was not IN", () => {
    const { state, poro } = combat(0);
    const trigger = eventTriggerFor(AFFECTIONATE_PORO)!;
    const listener = { card: poro, ownerIndex: 0 as const, battlefieldId: "bf1", defId: AFFECTIONATE_PORO };
    const elsewhere = { kind: "combatEnded" as const, battlefieldId: "bf2", participantInstanceIds: ["someone-else"] };

    expect(trigger.applies!(state, listener as never, elsewhere as never)).toBe(false);
  });
});

describe("Resonating Strike (VEN-034): a battlefield you control, a unit elsewhere", () => {
  function board(): { state: GameState; mine: UnitInstance } {
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.controllerId = "p1";
    return { state, mine };
  }

  it("moves the unit and pumps it by 2", () => {
    const { state, mine } = board();
    const after = resolveSpell(state, RESONATING_STRIKE, 0, {
      targetUnitInstanceId: mine.instanceId,
      destinationBattlefieldId: "bf2",
    });

    expect(after.battlefields[1]!.units.p1!.map((u) => u.instanceId), "it did not arrive").toContain(mine.instanceId);
    expect(after.battlefields[0]!.units.p1 ?? [], "it did not leave").toEqual([]);
    expect(after.battlefields[1]!.units.p1![0]!.mightThisTurn).toBe(2);
  });

  it("refuses a battlefield you do NOT control", () => {
    const { state, mine } = board();
    state.battlefields[1]!.controllerId = "p2";
    expect(moveDestinationAllowed(state, RESONATING_STRIKE, mine.instanceId, "bf2")).toBe(false);
  });

  it("refuses the location the unit is ALREADY at — 'a different location'", () => {
    // Without this the card is a pump with extra steps, and the printed words are
    // free text.
    const { state, mine } = board();
    expect(moveDestinationAllowed(state, RESONATING_STRIKE, mine.instanceId, "bf1")).toBe(false);
    expect(moveDestinationAllowed(state, RESONATING_STRIKE, mine.instanceId, "bf2"), "it refused a legal move").toBe(
      true,
    );
  });

  it("refuses BASE — the card names a battlefield", () => {
    const { state, mine } = board();
    expect(moveDestinationAllowed(state, RESONATING_STRIKE, mine.instanceId, "base")).toBe(false);
  });

  it("leaves CHARM's destinations alone — the rule is per card", () => {
    const { state, mine } = board();
    expect(moveDestinationAllowed(state, "OGN-043", mine.instanceId, "bf1"), "Charm inherited the narrowing").toBe(true);
  });
});

describe("Crumbling Sands (VEN-039): counter, if they have played another", () => {
  function board(enemySpells: number): GameState {
    const state = makeState();
    state.players[1]!.spellsPlayedThisTurn = enemySpells;
    const victim = spellInstance("OGN-004");
    state.spellChain = [{ playerIndex: 1, card: victim }] as never;
    return state;
  }

  const cast = (state: GameState) => {
    const entry = state.spellChain[0]!;
    // `ChainEntry` is a union — a TRIGGER on the chain has no `card` (377.3.a.1)
    // — so the narrowing is explicit rather than a cast. The build excludes tests
    // and would not have caught it; `npm run typecheck` does.
    if (!("card" in entry)) throw new Error("the fixture put a trigger on the chain");
    return resolveSpell(state, CRUMBLING_SANDS, 0, { targetChainCardInstanceId: entry.card.instanceId });
  };

  it("counters when the opponent has played TWO this turn", () => {
    // "Another" — the spell being countered is itself one of them and has already
    // been counted, so the threshold is two.
    const after = cast(board(2));
    expect(after.spellChain, "it did not counter").toHaveLength(0);
  });

  it("does NOTHING at one — the boundary", () => {
    const after = cast(board(1));
    expect(after.spellChain, "it countered on the opponent's first spell").toHaveLength(1);
  });

  it("counts the OPPONENT's spells, not yours", () => {
    const state = board(1);
    state.players[0]!.spellsPlayedThisTurn = 5;
    expect(cast(state).spellChain, "it counted the caster's own spells").toHaveLength(1);
  });
});

describe("Decree of Focus (VEN-040): a narrowing too card-specific to be an axis", () => {
  const NARROWING = "VEN-040-focus";

  function inCombatWith(domain: "Fury" | "Calm"): { state: GameState; mine: UnitInstance } {
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = {
      p1: [mine],
      p2: [realUnitInstance(domain === "Fury" ? FURY_UNIT : CALM_UNIT)],
    };
    state.battlefields[0]!.contestedByIndex = 1;
    return { state, mine };
  }

  it("qualifies a unit in combat with an enemy FURY unit", () => {
    const { state, mine } = inCombatWith("Fury");
    expect(unitSatisfiesNarrowing(state, mine, 0, NARROWING)).toBe(true);
  });

  it("...and NOT one fighting a unit of another domain", () => {
    const { state, mine } = inCombatWith("Calm");
    expect(unitSatisfiesNarrowing(state, mine, 0, NARROWING), "any domain qualified it").toBe(false);
  });

  it("...and NOT one at an UNCONTESTED battlefield", () => {
    // "In combat with" is not "standing near": the battlefield has to be
    // contested for anyone to be in combat at all.
    const { state, mine } = inCombatWith("Fury");
    state.battlefields[0]!.contestedByIndex = null;
    expect(unitSatisfiesNarrowing(state, mine, 0, NARROWING), "a quiet battlefield qualified it").toBe(false);
  });

  it("qualifies a unit BEING CHOSEN by an enemy Fury spell — the chain half", () => {
    // The second disjunct, and the reason the card is a [Reaction]: it only ever
    // has an answer while something is resolving.
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };
    const furySpell = spellInstance("OGN-004");
    state.spellChain = [{ playerIndex: 1, card: furySpell, targetUnitInstanceId: mine.instanceId }] as never;

    expect(furySpell.domains, "the fixture's spell is not Fury — this measures nothing").toContain("Fury");
    expect(unitSatisfiesNarrowing(state, mine, 0, NARROWING)).toBe(true);
  });

  it("...and NOT one chosen by its OWN controller's spell", () => {
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };
    state.spellChain = [{ playerIndex: 0, card: spellInstance("OGN-004"), targetUnitInstanceId: mine.instanceId }] as never;

    expect(unitSatisfiesNarrowing(state, mine, 0, NARROWING), "a friendly spell qualified it").toBe(false);
  });

  it("makes the card UNCASTABLE when nothing qualifies", () => {
    // For a Spell the targeting IS the effect, so a board with no legal target
    // must make it uncastable rather than castable-and-inert — the reading
    // Twilight Step's `maxMight` note sets out.
    const { state, mine } = inCombatWith("Calm");
    const spec = cardModeOf(spellInstance(DECREE_OF_FOCUS), undefined)!.targeting;

    expect(spec).toMatchObject({ narrowing: NARROWING });
    expect(hasAnyLegalEffectChoice(state, 0, spec), "it was castable with nothing to point at").toBe(false);

    const qualifying = inCombatWith("Fury");
    expect(hasAnyLegalEffectChoice(qualifying.state, 0, spec), "it was uncastable with a legal target").toBe(true);
    expect(mine.instanceId).toBeDefined();
  });

  it("gives +4 Might this turn", () => {
    const { state, mine } = inCombatWith("Fury");
    const after = resolveSpell(state, DECREE_OF_FOCUS, 0, { targetUnitInstanceId: mine.instanceId });
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn).toBe(4);
  });
});

describe("Riven, Shattered (VEN-041): damage that scales with her Equipment", () => {
  function board(equipmentCount: number): { state: GameState; riven: UnitInstance; victim: UnitInstance } {
    const state = makeState();
    const riven = realUnitInstance(RIVEN_SHATTERED);
    const victim = makeUnit({ might: 20 });
    state.battlefields[0]!.units = { p1: [riven], p2: [victim] };
    let next = state;
    for (let i = 0; i < equipmentCount; i += 1) {
      const gear = realGearInstance(AN_EQUIPMENT);
      next.players[0]!.activeGear = [...next.players[0]!.activeGear, gear];
      next = attachEquipment(next, 0, gear.instanceId, riven.instanceId);
    }
    return { state: next, riven, victim };
  }

  /** Her attack trigger reaches the engine as a `combatBegan` listener — the
   *  route `attackEventTriggers` registers every attack trigger through, so the
   *  test drives it the way a combat does rather than reaching for the table. */
  const attack = (state: GameState, riven: UnitInstance) => {
    const trigger = eventTriggerFor(RIVEN_SHATTERED)!;
    const listener = { card: riven, ownerIndex: 0 as const, battlefieldId: "bf1", defId: RIVEN_SHATTERED };
    const event = { kind: "combatBegan" as const, battlefieldId: "bf1", attackerIndex: 0 as const };
    return trigger.resolve(state, listener as never, event as never);
  };

  it("deals 2 per attached Equipment", () => {
    const { state, riven, victim } = board(2);
    const after = attack(state, riven);
    expect(after.battlefields[0]!.units.p2![0]!.damage, "it did not scale").toBe(4);
  });

  it("...and 2 for one — the scale, not a flat number", () => {
    const { state, riven } = board(1);
    expect(attack(state, riven).battlefields[0]!.units.p2![0]!.damage).toBe(2);
  });

  it("does NOTHING with no Equipment", () => {
    const { state, riven } = board(0);
    expect(attack(state, riven).battlefields[0]!.units.p2![0]!.damage).toBe(0);
  });

  it("[Weaponmaster] is PRINTED and needs no code of its own", () => {
    // Fired generically from `execute-play-card`'s Unit branch, so her first
    // sentence worked the moment the card existed.
    const def = registry.get(RIVEN_SHATTERED);
    expect("keywords" in def && def.keywords.Weaponmaster).toBeGreaterThan(0);
  });
});

describe("Astral Heron (VEN-044): your next card, both resources", () => {
  function board(seated: "battlefield" | "base"): { state: GameState; heron: UnitInstance } {
    const state = makeState();
    const heron = realUnitInstance(ASTRAL_HERON);
    if (seated === "battlefield") state.battlefields[0]!.units = { p1: [heron] };
    else state.players[0]!.baseUnits = [heron];
    return { state, heron };
  }

  const played = (state: GameState, heron: UnitInstance, count: number, battlefieldId?: string) => {
    const trigger = eventTriggerFor(ASTRAL_HERON)!;
    const listener = { card: heron, ownerIndex: 0 as const, defId: ASTRAL_HERON, ...(battlefieldId ? { battlefieldId } : {}) };
    const event = {
      kind: "cardPlayed" as const,
      casterIndex: 0 as const,
      playedKind: "Unit" as const,
      playedInstanceId: "x",
      playedPowerCost: 0,
      isToken: false,
    };
    const withCount = { ...state } as GameState;
    withCount.players[0]!.cardsPlayedThisTurn = count;
    return {
      applies: trigger.applies!(withCount, listener as never, event as never),
      after: trigger.resolve(withCount, listener as never, event as never),
    };
  };

  it("arms a discount on the FIRST card, and not the second", () => {
    // `cardsPlayedThisTurn` is bumped before this event is held, so the first card
    // arrives with the counter at 1 — the same off-by-one Jayce's gear clause has.
    const { state, heron } = board("battlefield");
    expect(played(state, heron, 1, "bf1").applies, "the first card did not arm it").toBe(true);
    expect(played(state, heron, 2, "bf1").applies, "the second card armed it too").toBe(false);
  });

  it("does nothing from BASE", () => {
    const { state, heron } = board("base");
    expect(played(state, heron, 1).applies, "a Heron in base armed it").toBe(false);
  });

  it("takes 2 Energy AND 2 Power off the next card of ANY kind", () => {
    const { state, heron } = board("battlefield");
    const { after } = played(state, heron, 1, "bf1");

    expect(after.players[0]!.nextCardEnergyDiscount).toBe(2);
    expect(after.players[0]!.nextCardPowerDiscount).toBe(2);
    // A UNIT, which the spell-only discount beside it would never reach.
    expect(modifiedEnergyCost(after, 0, "Unit", 6, "OGN-003"), "the Energy half did not apply").toBe(4);
    expect(scaledPowerDiscount(after, 0, "OGN-003"), "the Power half did not apply").toBe(2);
  });

  it("is SPENT by the next card PLAYED, end to end", () => {
    // **Through a real `submit`, not through `runEnd`.** The first draft asserted
    // only the turn-end sweep, so a mutant that never spent the charge in the
    // executor survived — the sweep cleared it either way, one turn too late.
    const { state, heron } = board("battlefield");
    const { after } = played(state, heron, 1, "bf1");
    after.players[0]!.hand = [realUnitInstance("OGN-003")];
    after.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`,
      domain: "Fury",
      state: "Ready",
    })) as never;

    const play = legalActions(after).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-003");
    expect(play, "the fixture could not play a card at all").toBeDefined();

    const { state: played2 } = submit(after, play!);
    expect(played2.players[0]!.nextCardEnergyDiscount, "the charge outlived the card that spent it").toBe(0);
    expect(played2.players[0]!.nextCardPowerDiscount).toBe(0);
  });

  it("...and does not survive the turn either", () => {
    const { state, heron } = board("battlefield");
    const { after } = played(state, heron, 1, "bf1");
    const next = runEnd({ ...after, phase: "Action" });
    expect(next.players[0]!.nextCardEnergyDiscount).toBe(0);
    expect(next.players[0]!.nextCardPowerDiscount).toBe(0);
  });
});

describe("coverage sees the wave", () => {
  it("all six report implemented", () => {
    for (const id of [AFFECTIONATE_PORO, RESONATING_STRIKE, CRUMBLING_SANDS, DECREE_OF_FOCUS, RIVEN_SHATTERED, ASTRAL_HERON]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });
});
