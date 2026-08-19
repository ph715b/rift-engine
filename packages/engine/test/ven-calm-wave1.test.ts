import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dealDamage, empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { unitChooseableBy } from "../src/engine/target-lookup.js";
import { mayPlayCardNow } from "../src/engine/timing.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { runChannel, runEnd } from "../src/engine/turn-manager.js";
import { legalActions } from "../src/engine/legal-actions.js";
import {
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Calm cards — the first wave, ten of the domain's seventeen.**
 *
 * The wave's motif is PROHIBITION, and it arrives in four different shapes that
 * this engine had to keep apart:
 *
 *   - Twilight Shroud shrouds ONE BODY for ONE TURN — a per-instance flag;
 *   - Akali shrouds HERSELF while she is not in combat — a per-card predicate
 *     that reads her position, which is why that table's predicate grew a `unit`;
 *   - Esteemed Hierophant prevents DAMAGE from enemy spells and abilities;
 *   - Ol' Poro forbids its own PLAY for three turns.
 *
 * Two more cards bind BOTH players from a bare noun (Sandstone Chimera's
 * "players", after Otterpus's "a player"), which is the reading that keeps
 * catching this set out.
 *
 * Every prohibition here is asserted in both directions — the thing it stops, and
 * the neighbouring thing it must not — because a prohibition that is too wide
 * looks exactly like one that works.
 */

const registry = defaultCardRegistry();

const ESTEEMED_HIEROPHANT = "VEN-025";
const FIELD_MUSICIANS = "VEN-026";
const OL_PORO = "VEN-029";
const TWILIGHT_SHROUD = "VEN-031";
const PAKAA_PROTECTOR = "VEN-033";
const SANCTION = "VEN-035";
const SANDSTONE_CHIMERA = "VEN-036";
const TOMB_RAIDER_BARBARA = "VEN-037";
const AKALI_SILENT = "VEN-038";
const SHEN_SCOURGE = "VEN-042";

const A_UNIT_CARD = "OGN-003";
const A_SPELL_CARD = "OGN-004";
const A_GEAR = "OGN-017";

const runes = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Calm", state: "Ready" }) as RuneCard);

const resolveSpell = (state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}) =>
  cardModeOf(spellInstance(defId), (event as { modeId?: string }).modeId)!.resolve(
    state,
    contextFor(casterIndex, "src"),
    event as never,
  );

describe("Esteemed Hierophant (VEN-025): prevention with a rune count", () => {
  function board(runeCount: number): { state: GameState; hierophant: UnitInstance } {
    const state = makeState();
    const hierophant = realUnitInstance(ESTEEMED_HIEROPHANT);
    state.battlefields[0]!.units = { p1: [hierophant] };
    state.players[0]!.channeled = runes(runeCount);
    return { state, hierophant };
  }

  // **3, not 5.** He is a 5-Might body, so a lethal amount removes him from the
  // board and every assertion below reads `undefined` instead of a number — the
  // failure looks like a broken predicate and is a broken fixture.
  const SURVIVABLE = 3;

  it("prevents enemy spell damage at SEVEN runes", () => {
    const { state, hierophant } = board(7);
    const after = dealDamage(state, 1, hierophant.instanceId, SURVIVABLE);
    expect(after.battlefields[0]!.units.p1![0]!.damage, "the damage landed anyway").toBe(0);
  });

  it("...and does NOT at six — the boundary", () => {
    const { state, hierophant } = board(6);
    expect(dealDamage(state, 1, hierophant.instanceId, SURVIVABLE).battlefields[0]!.units.p1![0]!.damage).toBe(
      SURVIVABLE,
    );
  });

  it("prevents only ENEMY damage — his own controller can still burn him", () => {
    // "Enemy spells and abilities" is printed, and the caster is what makes it
    // answerable. A prevention that read only the board would be wider than the
    // card.
    const { state, hierophant } = board(7);
    expect(dealDamage(state, 0, hierophant.instanceId, SURVIVABLE).battlefields[0]!.units.p1![0]!.damage).toBe(
      SURVIVABLE,
    );
  });

  it("protects only HIM, not the ally beside him", () => {
    const { state } = board(7);
    const ally = makeUnit({ might: 9 });
    state.battlefields[0]!.units = { p1: [...state.battlefields[0]!.units.p1!, ally] };

    const after = dealDamage(state, 1, ally.instanceId, 3);
    expect(after.battlefields[0]!.units.p1![1]!.damage, "the ally was protected too").toBe(3);
  });
});

describe("Ol' Poro (VEN-029): a card that forbids its own play", () => {
  const inHand = (turnNumber: number): GameState => {
    const state = makeState({ turnNumber });
    state.players[0]!.hand = [realUnitInstance(OL_PORO)];
    state.players[0]!.channeled = runes(6);
    return state;
  };

  it("cannot be played on turns 1, 2 or 3", () => {
    for (const turn of [1, 2, 3]) {
      const state = inHand(turn);
      expect(mayPlayCardNow(state, 0, state.players[0]!.hand[0]!), `turn ${turn} allowed it`).toBe(false);
      expect(
        legalActions(state).some((a) => a.type === "PlayCard" && a.card.defId === OL_PORO),
        `turn ${turn} OFFERED it`,
      ).toBe(false);
    }
  });

  it("...and CAN be played on turn 4 — the boundary the other side", () => {
    const state = inHand(4);
    expect(mayPlayCardNow(state, 0, state.players[0]!.hand[0]!)).toBe(true);
    expect(legalActions(state).some((a) => a.type === "PlayCard" && a.card.defId === OL_PORO)).toBe(true);
  });

  it("forbids only ITSELF — the card beside it is unaffected", () => {
    const state = inHand(1);
    state.players[0]!.hand = [...state.players[0]!.hand, realUnitInstance(A_UNIT_CARD)];
    expect(mayPlayCardNow(state, 0, state.players[0]!.hand[1]!), "it barred an unrelated card").toBe(true);
  });
});

describe("Twilight Shroud (VEN-031): one body, one turn", () => {
  function board(): { state: GameState; mine: UnitInstance } {
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };
    return { state, mine };
  }

  it("pumps by 1 and makes it unchooseable BY ENEMIES", () => {
    const { state, mine } = board();
    const after = resolveSpell(state, TWILIGHT_SHROUD, 0, { targetUnitInstanceId: mine.instanceId });
    const shrouded = after.battlefields[0]!.units.p1![0]!;

    expect(shrouded.mightThisTurn).toBe(1);
    expect(unitChooseableBy(after, shrouded, 0, 1), "an enemy could still choose it").toBe(false);
    // ...and its OWN controller still can: "enemy spells and abilities" is printed.
    expect(unitChooseableBy(after, shrouded, 0, 0), "it shrouded itself from its owner").toBe(true);
  });

  it("shrouds only the TARGET", () => {
    const { state, mine } = board();
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [mine, ally] };

    const after = resolveSpell(state, TWILIGHT_SHROUD, 0, { targetUnitInstanceId: mine.instanceId });
    expect(unitChooseableBy(after, after.battlefields[0]!.units.p1![1]!, 0, 1), "the ally was shrouded too").toBe(true);
  });

  it("EXPIRES with the turn", () => {
    const { state, mine } = board();
    const after = resolveSpell(state, TWILIGHT_SHROUD, 0, { targetUnitInstanceId: mine.instanceId });
    const next = runEnd({ ...after, phase: "Action" });
    const later = next.battlefields[0]!.units.p1![0]!;

    expect(later.unchooseableByEnemiesThisTurn, "the shroud outlived the turn").toBeUndefined();
    expect(unitChooseableBy(next, later, 0, 1)).toBe(true);
  });
});

describe("Akali, Silent (VEN-038): unchooseable UNLESS in combat", () => {
  function board(inCombat: boolean): { state: GameState; akali: UnitInstance } {
    const state = makeState();
    const akali = realUnitInstance(AKALI_SILENT);
    state.battlefields[0]!.units = { p1: [akali] };
    if (inCombat) {
      state.showdownKind = "Combat";
      state.showdownBattlefieldId = "bf1";
      state.turnState = "Showdown";
    }
    return { state, akali };
  }

  it("cannot be chosen by enemies while she is NOT in combat", () => {
    const { state, akali } = board(false);
    expect(unitChooseableBy(state, akali, 0, 1)).toBe(false);
  });

  it("...and CAN be once she is — the whole condition", () => {
    const { state, akali } = board(true);
    expect(unitChooseableBy(state, akali, 0, 1), "combat did not open her up").toBe(true);
  });

  it("is not shielded from a combat somewhere ELSE", () => {
    // The condition is about HER position, not about a combat existing.
    const { state, akali } = board(true);
    state.showdownBattlefieldId = "bf2";
    expect(unitChooseableBy(state, akali, 0, 1), "a fight elsewhere exposed her").toBe(false);
  });

  it("gives herself +2 Might when she moves TO A BATTLEFIELD", () => {
    const { state, akali } = board(false);
    const trigger = eventTriggerFor(AKALI_SILENT)!;
    const listener = { card: akali, ownerIndex: 0 as const, battlefieldId: "bf1", defId: AKALI_SILENT };
    const moved = (to: string) => ({ kind: "unitMoved" as const, unitInstanceId: akali.instanceId, to });

    expect(trigger.applies!(state, listener as never, moved("bf1") as never)).toBe(true);
    // ...and NOT when she is recalled home. Pakaa Protector below prints the same
    // sentence WITHOUT "to a battlefield", which is the difference this pair is
    // in one wave to make visible.
    expect(trigger.applies!(state, listener as never, moved("base") as never), "a recall pumped her").toBe(false);

    const after = trigger.resolve(state, listener as never, moved("bf1") as never);
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn).toBe(2);
  });
});

describe("Pakaa Protector (VEN-033): reveal, then one of two arms", () => {
  function board(top: string | undefined): { state: GameState; pakaa: UnitInstance } {
    const state = makeState();
    const pakaa = realUnitInstance(PAKAA_PROTECTOR);
    state.battlefields[0]!.units = { p1: [pakaa] };
    state.players[0]!.deck = top === undefined ? [] : [registry.get(top).type === "Unit" ? realUnitInstance(top) : spellInstance(top)];
    return { state, pakaa };
  }

  const fire = (state: GameState, pakaa: UnitInstance, to = "bf1") => {
    const trigger = eventTriggerFor(PAKAA_PROTECTOR)!;
    const listener = { card: pakaa, ownerIndex: 0 as const, battlefieldId: "bf1", defId: PAKAA_PROTECTOR };
    const event = { kind: "unitMoved" as const, unitInstanceId: pakaa.instanceId, to };
    return { applies: trigger.applies!(state, listener as never, event as never), after: trigger.resolve(state, listener as never, event as never) };
  };

  it("DRAWS the top card when it is a unit, and gives no Might", () => {
    const { state, pakaa } = board(A_UNIT_CARD);
    const { after } = fire(state, pakaa);

    expect(after.players[0]!.hand.map((c) => c.defId)).toEqual([A_UNIT_CARD]);
    expect(after.players[0]!.deck).toEqual([]);
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn, "the unit arm also pumped").toBe(0);
  });

  it("TRASHES it and pumps by 2 when it is not", () => {
    const { state, pakaa } = board(A_SPELL_CARD);
    const { after } = fire(state, pakaa);

    expect(after.players[0]!.hand, "a non-unit was drawn").toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([A_SPELL_CARD]);
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn).toBe(2);
  });

  it("does nothing at all on an empty deck (422)", () => {
    const { state, pakaa } = board(undefined);
    const { after } = fire(state, pakaa);

    expect(after.players[0]!.trash).toEqual([]);
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn, "an empty deck still pumped").toBe(0);
  });

  it("fires on a move to BASE too — it prints no destination", () => {
    // The pair with Akali above, and the reason both are in this wave.
    const { state, pakaa } = board(A_SPELL_CARD);
    expect(fire(state, pakaa, "base").applies, "a recall did not fire the Protector").toBe(true);
  });
});

describe("Sanction (VEN-035): two modes that are exact mirrors", () => {
  function board(empoweredStart: boolean): { state: GameState; target: UnitInstance } {
    const state = makeState();
    const target = makeUnit();
    state.battlefields[0]!.units = { p1: [target] };
    return { state: empoweredStart ? empowerPermanent(state, target.instanceId) : state, target };
  }

  it("empowers now and DISEMPOWERS at end of turn", () => {
    const { state, target } = board(false);
    const after = resolveSpell(state, SANCTION, 0, { modeId: "empower", targetUnitInstanceId: target.instanceId });

    expect(isEmpowered(after, target.instanceId), "it did not empower").toBe(true);
    expect(after.disempowerAtEndOfTurn, "the end-of-turn half was not armed").toContain(target.instanceId);

    const next = runEnd({ ...after, phase: "Action" });
    expect(isEmpowered(next, target.instanceId), "it stayed Empowered past the turn").toBe(false);
  });

  it("disempowers now and EMPOWERS at end of turn", () => {
    const { state, target } = board(true);
    const after = resolveSpell(state, SANCTION, 0, { modeId: "disempower", targetUnitInstanceId: target.instanceId });

    expect(isEmpowered(after, target.instanceId), "it did not disempower").toBe(false);
    expect(after.empowerAtEndOfTurn).toContain(target.instanceId);

    const next = runEnd({ ...after, phase: "Action" });
    expect(isEmpowered(next, target.instanceId), "it did not come back Empowered").toBe(true);
  });

  it("offers the disempower mode ONLY on an already-Empowered unit", () => {
    // Printed, and load-bearing: without it the mode is a free way to Empower an
    // enemy unit at end of turn, which is the opposite of what it does.
    const spec = cardModeOf(spellInstance(SANCTION), "disempower")!.targeting;
    expect(spec).toMatchObject({ empoweredOnly: true });
    expect(cardModeOf(spellInstance(SANCTION), "empower")!.targeting, "the empower mode was narrowed too").not.toMatchObject({
      empoweredOnly: true,
    });
  });

  it("...and the enumerator honours that, in both directions", () => {
    const plain = makeState();
    const bare = makeUnit();
    const empowered = makeUnit();
    plain.battlefields[0]!.units = { p1: [bare, empowered] };
    plain.players[0]!.hand = [spellInstance(SANCTION)];
    plain.players[0]!.channeled = runes(6);
    const state = empowerPermanent(plain, empowered.instanceId);

    const offered = legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.defId === SANCTION && (a as { modeId?: string }).modeId === "disempower")
      .map((a) => (a as { targetUnitInstanceId?: string }).targetUnitInstanceId);

    expect(offered, "an un-Empowered unit was offered to the disempower mode").not.toContain(bare.instanceId);
    expect(offered, "the Empowered unit was not offered at all").toContain(empowered.instanceId);
  });
});

describe("Sandstone Chimera (VEN-036): players only channel 1", () => {
  const channelPhase = (state: GameState): GameState => ({ ...state, phase: "Channel" });

  function board(seated: "battlefield" | "base" | "none", side: 0 | 1 = 0): GameState {
    const state = makeState({ turnNumber: 2 });
    state.players[0]!.runeDeck = runes(5);
    state.players[1]!.runeDeck = runes(5);
    const chimera = realUnitInstance(SANDSTONE_CHIMERA);
    if (seated === "battlefield") state.battlefields[0]!.units = { [side === 0 ? "p1" : "p2"]: [chimera] };
    if (seated === "base") state.players[side]!.baseUnits = [chimera];
    return state;
  }

  it("caps channelling at 1", () => {
    const after = runChannel(channelPhase(board("battlefield")));
    expect(after.players[0]!.channeled, "it channelled the usual 2").toHaveLength(1);
  });

  it("...where the CONTROL channels 2", () => {
    expect(runChannel(channelPhase(board("none"))).players[0]!.channeled).toHaveLength(2);
  });

  it("binds BOTH players — an ENEMY Chimera caps you too", () => {
    // "Players", bare. The second card in the set to bind its own side after
    // Otterpus, and the same reading.
    const after = runChannel(channelPhase(board("battlefield", 1)));
    expect(after.players[0]!.channeled, "an enemy Chimera did not cap us").toHaveLength(1);
  });

  it("does nothing from BASE — 'while I'm at a battlefield'", () => {
    expect(runChannel(channelPhase(board("base"))).players[0]!.channeled).toHaveLength(2);
  });

  it("caps the going-second player's first-turn THREE as well", () => {
    // "Only channel 1" is a cap, not a replacement: 3 becomes 1, not 3.
    const state = board("battlefield");
    const firstTurn = { ...channelPhase(state), turnNumber: 1, activePlayerIndex: 1 as const, firstPlayerIndex: 0 as const };
    expect(runChannel(firstTurn).players[1]!.channeled, "the first-turn 3 escaped the cap").toHaveLength(1);
  });
});

describe("Tomb-Raider Barbara (VEN-037): the branch runs the wrong way round", () => {
  function board(runeCount: number, gearEmpowered: boolean): { state: GameState; gear: ReturnType<typeof realGearInstance> } {
    const state = makeState();
    const gear = realGearInstance(A_GEAR);
    state.players[1]!.activeGear = [gear];
    state.players[0]!.channeled = runes(runeCount);
    return { state: gearEmpowered ? empowerPermanent(state, gear.instanceId) : state, gear };
  }

  const play = (state: GameState, gearId: string) =>
    playUnitTrigger(state, realUnitInstance(TOMB_RAIDER_BARBARA), 0, "base", { targetPermanentInstanceId: gearId });

  it("KILLS an ordinary enemy gear at 7 runes", () => {
    const { state, gear } = board(7, false);
    const after = play(state, gear.instanceId);

    expect(after.players[1]!.activeGear, "the gear survived").toEqual([]);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain(gear.instanceId);
  });

  it("only DISEMPOWERS an Empowered one — Empowered gear is HARDER to remove", () => {
    const { state, gear } = board(7, true);
    const after = play(state, gear.instanceId);

    expect(after.players[1]!.activeGear.map((g) => g.instanceId), "the Empowered gear died").toContain(gear.instanceId);
    expect(isEmpowered(after, gear.instanceId), "it was not disempowered").toBe(false);
  });

  it("does NOTHING below seven runes — the boundary", () => {
    const { state, gear } = board(6, false);
    const after = play(state, gear.instanceId);
    expect(after.players[1]!.activeGear.map((g) => g.instanceId), "it fired at six runes").toContain(gear.instanceId);
  });
});

describe("Field Musicians (VEN-026) and Shen, Scourge of Shadows (VEN-042)", () => {
  it("the Musicians pump a unit by 3 on play", () => {
    const state = makeState();
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };

    const after = playUnitTrigger(state, realUnitInstance(FIELD_MUSICIANS), 0, "base", {
      targetUnitInstanceId: ally.instanceId,
    });
    expect(after.battlefields[0]!.units.p1![0]!.mightThisTurn).toBe(3);
  });

  it("Shen draws on a hold with EXACTLY one other unit here", () => {
    const state = makeState();
    const shen = realUnitInstance(SHEN_SCOURGE);
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [shen, ally] };
    state.players[0]!.deck = [spellInstance(A_SPELL_CARD)];

    const trigger = eventTriggerFor(SHEN_SCOURGE)!;
    const listener = { card: shen, ownerIndex: 0 as const, battlefieldId: "bf1", defId: SHEN_SCOURGE };
    const held = { kind: "battlefieldHeld" as const, holderIndex: 0 as const, battlefieldId: "bf1" };

    expect(trigger.applies!(state, listener as never, held as never)).toBe(true);
    expect(trigger.resolve(state, listener as never, held as never).players[0]!.hand).toHaveLength(1);
  });

  it("...and NOT with none or with two — EXACTLY is the whole card", () => {
    // The boundary in both directions, which a board built with a single ally can
    // never see. Four cards in this set turn on this formation.
    const trigger = eventTriggerFor(SHEN_SCOURGE)!;
    const held = { kind: "battlefieldHeld" as const, holderIndex: 0 as const, battlefieldId: "bf1" };

    for (const allies of [0, 2]) {
      const state = makeState();
      const shen = realUnitInstance(SHEN_SCOURGE);
      state.battlefields[0]!.units = { p1: [shen, ...Array.from({ length: allies }, () => makeUnit())] };
      const listener = { card: shen, ownerIndex: 0 as const, battlefieldId: "bf1", defId: SHEN_SCOURGE };

      expect(trigger.applies!(state, listener as never, held as never), `${allies} allies fired him`).toBe(false);
    }
  });
});

describe("coverage sees the wave", () => {
  it("all ten report implemented", () => {
    for (const id of [
      ESTEEMED_HIEROPHANT,
      FIELD_MUSICIANS,
      OL_PORO,
      TWILIGHT_SHROUD,
      PAKAA_PROTECTOR,
      SANCTION,
      SANDSTONE_CHIMERA,
      TOMB_RAIDER_BARBARA,
      AKALI_SILENT,
      SHEN_SCOURGE,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });
});
