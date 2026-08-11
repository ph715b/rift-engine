import { describe, expect, it } from "vitest";
import { attachEquipment } from "../src/engine/equipment.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { answerDecision, pendingDecision } from "../src/engine/decisions.js";
import { holdEventTrigger, holdSelfTrigger, holdUnitsChosen } from "../src/engine/triggers.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The nine SFD cards that needed no new engine — each rides a mechanism that
 * already existed, and the per-card part is a registry entry.
 *
 * Two of them did widen an existing EVENT rather than add one, and both
 * widenings are asserted here because they are the parts that can silently rot:
 *  - `unitChosen` gained `bySpell`, for Jae Medarda's "with a SPELL". Irelia -
 *    Fervent and Spirit Wheel read the bare "when you choose" and must still
 *    take both paths, so the negative is tested from both ends.
 *  - `cardPlayed` gained `playedPowerCost`, for Yordle Explorer's threshold.
 *
 * The `isCardImplemented` assertions at the end are not ceremony. Coverage asks
 * which MODULE claims a card, and this repo has twice shipped a card that worked
 * in play while reporting unimplemented because no module claimed it (Lucian -
 * Purifier, then Jax - Unmatched). A working card and a moving count are two
 * different facts and both are checked.
 */

const registry = defaultCardRegistry();

const JAE_MEDARDA = "SFD-142";
const SPIRIT_WHEEL = "SFD-144";
const FIORA_WORTHY = "SFD-180";
const YORDLE_EXPLORER = "SFD-100";
const PORO_SNAX = "SFD-046";
const PICKPOCKET = "SFD-074";
const RUMBLE_SCRAPPER = "SFD-089";
const GEARHEAD = "SFD-068";
const ANCIENT_WARMONGER = "SFD-131";

/** Long Sword — a +1 Might badge, the plainest Equipment in the set. */
const LONG_SWORD = "SFD-022";
/** Cloth Armor — a 1-cost gear, inside Pickpocket's ceiling. */
const CLOTH_ARMOR = "SFD-064";
/** Doran's Blade — a second badge, so a stacked pair can be told from a double. */
const DORANS_BLADE = "SFD-095";

/** `CardDefinition` is a union that includes Legends, which carry neither a
 *  Might nor a cost. These narrow it at the one place each is read, so a test
 *  that names the wrong card fails loudly rather than reading `undefined`. */
function unitDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit`);
  return def;
}
function gearDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Gear") throw new Error(`${defId} is not a Gear`);
  return def;
}

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (n: number, domain: RuneCard["domain"] = "Body"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));
const hand = (state: GameState, index: 0 | 1 = 0) => state.players[index]!.hand.length;

/** A deck deep enough that a draw never hits Burn Out and changes the subject. */
const stockDeck = () => Array.from({ length: 6 }, () => gear(LONG_SWORD));

describe("Jae Medarda (SFD-142): draws when a SPELL chooses him", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(JAE_MEDARDA), instanceId: "jae" }];
    state.players[0]!.deck = stockDeck();
    return state;
  }

  it("draws when his own side chooses him with a spell", () => {
    const state = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["jae"], true));

    expect(hand(after), "the choose half did not fire").toBe(hand(state) + 1);
  });

  /**
   * **The whole reason `bySpell` exists.** An ABILITY choosing him is not "with
   * a spell", and before the field the event could not tell the two apart —
   * so this card could only have been written as the wider sentence.
   */
  it("does NOT draw when an ABILITY chooses him", () => {
    const state = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["jae"], false));

    expect(hand(after), "he drew off an ability's choice").toBe(hand(state));
  });

  it("reads \"YOU choose\" — an enemy spell choosing him pays nothing", () => {
    const state = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 1, ["jae"], true));

    expect(hand(after), "he drew off an ENEMY choosing him").toBe(hand(state));
  });

  /** One event per choice, so a spell naming him twice draws twice. */
  it("is not capped — two choices are two draws", () => {
    const state = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["jae", "jae"], true));

    expect(hand(after)).toBe(hand(state) + 2);
  });
});

describe("Spirit Wheel (SFD-144): pay [1] and exhaust to draw when you choose a friendly unit", () => {
  function board(energy = 3): { state: GameState; wheel: GearInstance } {
    const wheel = gear(SPIRIT_WHEEL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "ally" })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "enemy" })];
    state.players[0]!.activeGear = [wheel];
    state.players[0]!.channeled = runes(energy);
    state.players[0]!.deck = stockDeck();
    return { state, wheel };
  }

  it("offers the draw when you choose a friendly unit", () => {
    const { state } = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["ally"], true));

    expect(pendingDecision(after)?.kind, "no offer was made").toBe("SFD-144-draw");
  });

  /** A bare "when you choose", so an ABILITY's choice counts too — the opposite
   *  of Jae Medarda above, and the reason `bySpell` is a field rather than a
   *  narrowing of the event. */
  it("also fires for an ABILITY's choice", () => {
    const { state } = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["ally"], false));

    expect(pendingDecision(after)?.kind, "it ignored an ability's choice").toBe("SFD-144-draw");
  });

  it("draws, charges [1] and exhausts itself when accepted", () => {
    const { state, wheel } = board();
    const offered = resolveHeldTriggers(holdUnitsChosen(state, 0, ["ally"], true));
    const before = hand(offered);
    const after = answerDecision(offered, pendingDecision(offered)!.id, "pay")!;

    expect(hand(after), "no card was drawn").toBe(before + 1);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted"), "the [1] was not paid").toHaveLength(1);
    expect(
      after.players[0]!.activeGear.find((g) => g.instanceId === wheel.instanceId)?.exhausted,
      "the Wheel was not exhausted",
    ).toBe(true);
  });

  it("costs nothing and stays ready when declined", () => {
    const { state, wheel } = board();
    const offered = resolveHeldTriggers(holdUnitsChosen(state, 0, ["ally"], true));
    const before = hand(offered);
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(hand(after)).toBe(before);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(0);
    expect(after.players[0]!.activeGear.find((g) => g.instanceId === wheel.instanceId)?.exhausted).toBe(false);
  });

  /** "A FRIENDLY unit" — choosing the opponent's unit is not its moment, which
   *  is what stops it being a cantrip stapled to every removal spell. */
  it("does NOT fire when you choose an ENEMY unit", () => {
    const { state } = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 0, ["enemy"], true));

    expect(pendingDecision(after), "it fired for an enemy unit").toBeUndefined();
  });

  it("does NOT fire when the OPPONENT does the choosing", () => {
    const { state } = board();
    const after = resolveHeldTriggers(holdUnitsChosen(state, 1, ["ally"], true));

    expect(pendingDecision(after), "it fired on the opponent's choice").toBeUndefined();
  });

  /**
   * Asserted on the CHAIN ENTRY, not on `pendingDecision`. A decision whose only
   * option is "decline" auto-resolves, so a prompt-shaped assertion cannot tell
   * "the trigger fired uselessly" from "the trigger did not fire" — the trap
   * already recorded on Jax - Unrelenting's identical test.
   */
  it("is not offered with no Energy at all", () => {
    const { state } = board(0);
    const held = runCleanup(holdUnitsChosen(state, 0, ["ally"], true)).spellChain.filter(
      (e) => "listenerDefId" in e && e.listenerDefId === SPIRIT_WHEEL,
    );

    expect(held, "an unpayable trigger was placed on the chain").toHaveLength(0);
  });

  /** "Exhaust this" is half the cost, so a Wheel already spent cannot pay it —
   *  which is what makes the card once a turn without a counter. */
  it("is not offered while already exhausted", () => {
    const { state, wheel } = board();
    state.players[0]!.activeGear = [{ ...wheel, exhausted: true }];
    const held = runCleanup(holdUnitsChosen(state, 0, ["ally"], true)).spellChain.filter(
      (e) => "listenerDefId" in e && e.listenerDefId === SPIRIT_WHEEL,
    );

    expect(held, "an exhausted Wheel was still offered").toHaveLength(0);
  });
});

describe("Fiora - Worthy (SFD-180): pay [Order] to ready a unit that became Mighty", () => {
  function board(orderRunes = 2): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(FIORA_WORTHY), instanceId: "fiora" },
      makeUnit({ instanceId: "ally", might: 6, exhausted: true }),
    ];
    state.players[0]!.channeled = runes(orderRunes, "Order");
    state.players[0]!.deck = stockDeck();
    return state;
  }

  const becameMighty = (state: GameState, unitInstanceId: string, ownerIndex: 0 | 1 = 0) =>
    resolveHeldTriggers(holdEventTrigger(state, { kind: "unitBecameMighty", ownerIndex, unitInstanceId }));

  it("offers the ready when a unit you control becomes Mighty", () => {
    const after = becameMighty(board(), "ally");

    expect(pendingDecision(after)?.kind, "no offer was made").toBe("SFD-180-ready");
  });

  it("readies the unit and recycles the rune when accepted", () => {
    const offered = becameMighty(board(), "ally");
    const after = answerDecision(offered, pendingDecision(offered)!.id, "pay")!;

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "ally")?.exhausted, "it was not readied").toBe(
      false,
    );
    // A POWER payment recycles rather than exhausts (416), so the pool shrinks.
    expect(after.players[0]!.channeled, "the rune was not recycled").toHaveLength(1);
  });

  it("readies nothing when declined", () => {
    const offered = becameMighty(board(), "ally");
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "ally")?.exhausted).toBe(true);
    expect(after.players[0]!.channeled).toHaveLength(2);
  });

  it("does NOT fire for an ENEMY unit becoming Mighty", () => {
    const state = board();
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "enemy", might: 6, exhausted: true })];
    const after = becameMighty(state, "enemy", 1);

    expect(pendingDecision(after), "she fired for the opponent's unit").toBeUndefined();
  });

  /** She prints no "other", so she is her own valid subject — asserted with her
   *  EXHAUSTED, since a ready unit has nothing to buy (see the next test). */
  it("fires for HERSELF becoming Mighty", () => {
    const state = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.map((u) =>
      u.instanceId === "fiora" ? { ...u, exhausted: true } : u,
    );
    const after = becameMighty(state, "fiora");

    expect(pendingDecision(after)?.kind, "she excluded herself").toBe("SFD-180-ready");
  });

  /**
   * "Pay [Order] to READY it" buys nothing on a unit that is already ready, so
   * the payment is not offered — an offer nobody can take is not made.
   *
   * Asserted on the CHAIN ENTRY rather than on `pendingDecision`: a decision
   * whose only remaining option is "decline" auto-resolves, so the prompt is
   * absent either way and a prompt-shaped assertion here proves nothing. The
   * trigger genuinely does fire (the unit became Mighty); what this pins is that
   * answering it can never spend the rune.
   */
  it("offers no payment for a unit that is already READY", () => {
    const state = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.map((u) =>
      u.instanceId === "ally" ? { ...u, exhausted: false } : u,
    );
    const offered = becameMighty(state, "ally");
    const runesBefore = offered.players[0]!.channeled.length;

    const decision = pendingDecision(offered);
    const after = decision ? answerDecision(offered, decision.id, "pay")! : offered;

    expect(after.players[0]!.channeled.length, "a rune was spent to ready a ready unit").toBe(runesBefore);
  });

  it("is not offered with no Order rune to pay", () => {
    const state = board(0);
    const held = runCleanup(
      holdEventTrigger(state, { kind: "unitBecameMighty", ownerIndex: 0, unitInstanceId: "ally" }),
    ).spellChain.filter((e) => "listenerDefId" in e && e.listenerDefId === FIORA_WORTHY);

    expect(held, "an unpayable trigger was placed on the chain").toHaveLength(0);
  });
});

describe("Yordle Explorer (SFD-100): draws off a card costing [rainbow][rainbow] or more", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(YORDLE_EXPLORER), instanceId: "explorer" }];
    state.players[0]!.deck = stockDeck();
    return state;
  }

  const played = (state: GameState, playedPowerCost: number, casterIndex: 0 | 1 = 0) =>
    resolveHeldTriggers(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex,
        playedKind: "Spell",
        playedInstanceId: "played",
        playedPowerCost,
        isToken: false,
      }),
    );

  it("draws off a 2-Power card", () => {
    const state = board();
    expect(hand(played(state, 2)), "the threshold did not fire").toBe(hand(state) + 1);
  });

  /** "OR MORE", so it is `>=` — and it fires ONCE per card, not once per pip. */
  it("draws exactly 1 off a 3-Power card", () => {
    const state = board();
    expect(hand(played(state, 3)), "a 3-Power card did not draw, or drew twice").toBe(hand(state) + 1);
  });

  it("does NOT draw off a 1-Power card", () => {
    const state = board();
    expect(hand(played(state, 1)), "it fired below the threshold").toBe(hand(state));
  });

  it("does NOT draw off a card with no Power cost", () => {
    const state = board();
    expect(hand(played(state, 0))).toBe(hand(state));
  });

  it("reads \"YOU play\" — an opponent's expensive card pays nothing", () => {
    const state = board();
    expect(hand(played(state, 3, 1)), "it fired on the opponent's play").toBe(hand(state));
  });
});

describe("Rumble - Scrapper (SFD-089): your Mechs have +1 Might, including him", () => {
  /** Rumble plus a Mech and a non-Mech, all in base. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(RUMBLE_SCRAPPER), instanceId: "rumble" },
      makeUnit({ instanceId: "mech", might: 3, tags: ["Mech"] }),
      makeUnit({ instanceId: "plain", might: 3, tags: [] }),
    ];
    return state;
  }

  const mightOf = (state: GameState, instanceId: string) => {
    const unit = state.players[0]!.baseUnits.find((u) => u.instanceId === instanceId)!;
    return effectiveMight(state, unit, 0, { isCombat: false });
  };

  it("pumps a friendly Mech", () => {
    expect(mightOf(board(), "mech"), "the tribal aura did not apply").toBe(4);
  });

  /** "(INCLUDING me)" — the opposite of every other unit aura in the file, and
   *  his own printed Mech tag is what makes it work with no special case. */
  it("pumps HIMSELF", () => {
    const printed = unitDef(RUMBLE_SCRAPPER).might;
    expect(mightOf(board(), "rumble"), "he excluded himself").toBe(printed + 1);
  });

  it("leaves a non-Mech alone", () => {
    expect(mightOf(board(), "plain"), "the aura reached outside the tribe").toBe(3);
  });

  it("does NOT pump the OPPONENT's Mechs", () => {
    const state = board();
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "enemy-mech", might: 3, tags: ["Mech"] })];
    const enemy = state.players[1]!.baseUnits[0]!;

    expect(effectiveMight(state, enemy, 1, { isCombat: false }), "\"your\" reached the enemy").toBe(3);
  });

  it("stops when he leaves the board", () => {
    const state = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.filter((u) => u.instanceId !== "rumble");

    expect(mightOf(state, "mech"), "the aura outlived its source").toBe(3);
  });

  /** "When I hold" is positional — the battlefield held must be his own. */
  it("plays a Mech token to BASE when he holds his battlefield", () => {
    const state = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.filter((u) => u.instanceId !== "rumble");
    state.battlefields[0]!.units["p1"] = [{ ...realUnitInstance(RUMBLE_SCRAPPER), instanceId: "rumble" }];
    const before = state.players[0]!.baseUnits.length;

    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }),
    );

    expect(after.players[0]!.baseUnits.length, "no Mech token arrived in base").toBe(before + 1);
    const token = after.players[0]!.baseUnits[before]!;
    expect(token.tags, "the token is not a Mech").toContain("Mech");
    // His own aura reads the token the instant it lands: a 3-Might Mech is a 4.
    expect(effectiveMight(after, token, 0, { isCombat: false }), "his aura did not reach his own token").toBe(4);
  });

  it("does NOT fire when he holds a DIFFERENT battlefield", () => {
    const state = board();
    state.players[0]!.baseUnits = state.players[0]!.baseUnits.filter((u) => u.instanceId !== "rumble");
    state.battlefields[0]!.units["p1"] = [{ ...realUnitInstance(RUMBLE_SCRAPPER), instanceId: "rumble" }];
    const before = state.players[0]!.baseUnits.length;

    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf2" }),
    );

    expect(after.players[0]!.baseUnits.length, "he fired for someone else's battlefield").toBe(before);
  });
});

describe("Gearhead (SFD-068): each Equipment gives DOUBLE its base Might bonus", () => {
  function board(): { state: GameState; sword: GearInstance; blade: GearInstance } {
    const sword = gear(LONG_SWORD);
    const blade = gear(DORANS_BLADE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(GEARHEAD), instanceId: "gearhead" },
      makeUnit({ instanceId: "plain", might: 3 }),
    ];
    state.players[0]!.activeGear = [sword, blade];
    return { state, sword, blade };
  }

  const mightOf = (state: GameState, instanceId: string) => {
    const unit = state.players[0]!.baseUnits.find((u) => u.instanceId === instanceId)!;
    return effectiveMight(state, unit, 0, { isCombat: false });
  };

  it("doubles one Equipment's badge on him", () => {
    const { state, sword } = board();
    const plainBase = mightOf(state, "plain");
    const worn = attachEquipment(state, 0, sword.instanceId, "plain");
    const badge = mightOf(worn, "plain") - plainBase;
    // The control: the same sword on an ordinary unit is worth its printed badge.
    expect(badge, "the fixture's Equipment grants no Might at all").toBeGreaterThan(0);

    const gearheadBase = mightOf(state, "gearhead");
    const onGearhead = attachEquipment(state, 0, sword.instanceId, "gearhead");

    expect(mightOf(onGearhead, "gearhead") - gearheadBase, "the badge was not doubled").toBe(badge * 2);
  });

  it("doubles EACH of two attached Equipment", () => {
    const { state, sword, blade } = board();
    const base = mightOf(state, "gearhead");
    const both = attachEquipment(attachEquipment(state, 0, sword.instanceId, "gearhead"), 0, blade.instanceId, "gearhead");

    // Asserted against the printed badges rather than against the one-Equipment
    // case: a relative comparison ("two is more than one") stays true even with
    // the doubling removed entirely, and passed under exactly that mutation.
    const badges = gearDef(LONG_SWORD).equipMightBonus! + gearDef(DORANS_BLADE).equipMightBonus!;

    expect(mightOf(both, "gearhead") - base, "the pair was not doubled per Equipment").toBe(badges * 2);
  });

  /** A property of the WEARER: the same sword is worth half as much one unit over. */
  it("does not double the same Equipment on another unit", () => {
    const { state, sword } = board();
    const base = mightOf(state, "plain");
    const worn = attachEquipment(state, 0, sword.instanceId, "plain");

    const onGearheadBase = mightOf(state, "gearhead");
    const moved = attachEquipment(worn, 0, sword.instanceId, "gearhead");

    expect(mightOf(moved, "gearhead") - onGearheadBase).toBe((mightOf(worn, "plain") - base) * 2);
  });

  /**
   * "Its BASE Might bonus" — the printed badge and nothing else. A this-turn
   * buff on the wearer is added after this returns and must not be doubled.
   */
  it("doubles only the badge, not a this-turn buff on him", () => {
    const { state, sword } = board();
    const worn = attachEquipment(state, 0, sword.instanceId, "gearhead");
    const before = mightOf(worn, "gearhead");

    worn.players[0]!.baseUnits = worn.players[0]!.baseUnits.map((u) =>
      u.instanceId === "gearhead" ? { ...u, mightThisTurn: 2 } : u,
    );

    expect(mightOf(worn, "gearhead"), "a non-badge bonus was doubled").toBe(before + 2);
  });
});

describe("Ancient Warmonger (SFD-131): [Assault] equal to the number of enemy units here", () => {
  /** The Warmonger at bf1, with `enemies` opposing bodies standing on it. */
  function board(enemies: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [{ ...realUnitInstance(ANCIENT_WARMONGER), instanceId: "warmonger" }];
    state.battlefields[0]!.units["p2"] = Array.from({ length: enemies }, (_, i) =>
      makeUnit({ instanceId: `enemy-${i}` }),
    );
    return state;
  }

  const assaultAt = (state: GameState, zone: "bf1" | "base") => {
    const unit =
      zone === "base"
        ? state.players[0]!.baseUnits.find((u) => u.instanceId === "warmonger")!
        : state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "warmonger")!;
    return effectiveKeywords(state, unit, 0)["Assault"] ?? 0;
  };

  it("is 0 with no enemy units here", () => {
    expect(assaultAt(board(0), "bf1")).toBe(0);
  });

  it("scales with the enemy units standing here", () => {
    expect(assaultAt(board(1), "bf1"), "one enemy did not grant [Assault 1]").toBe(1);
    expect(assaultAt(board(3), "bf1"), "three enemies did not grant [Assault 3]").toBe(3);
  });

  /** The value feeds `effectiveMight`'s combat term like a printed one — which
   *  is the whole point of expressing it as a keyword VALUE rather than a Might
   *  bonus of its own. */
  it("adds to his attacking Might through the ordinary [Assault] term", () => {
    const state = board(2);
    const unit = state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "warmonger")!;
    const printed = unitDef(ANCIENT_WARMONGER).might;

    const attacking = effectiveMight(state, unit, 0, {
      isCombat: true,
      isAttackingSide: true,
      combatRole: "outgoing",
      battlefieldId: "bf1",
    });

    expect(attacking, "the computed [Assault] did not reach his combat Might").toBe(printed + 2);
  });

  /** "HERE" is a battlefield — the same positional reading every other "here"
   *  in the engine takes, so a Warmonger at home has [Assault 0]. */
  it("is 0 while he stands in base, however many enemies are elsewhere", () => {
    const state = board(3);
    state.battlefields[0]!.units["p1"] = [];
    state.players[0]!.baseUnits = [{ ...realUnitInstance(ANCIENT_WARMONGER), instanceId: "warmonger" }];

    expect(assaultAt(state, "base"), "a Warmonger in base counted a distant fight").toBe(0);
  });

  it("counts only the ENEMY's units, not his own neighbours", () => {
    const state = board(1);
    state.battlefields[0]!.units["p1"] = [
      ...state.battlefields[0]!.units["p1"]!,
      makeUnit({ instanceId: "friend-a" }),
      makeUnit({ instanceId: "friend-b" }),
    ];

    expect(assaultAt(state, "bf1"), "he counted his own side").toBe(1);
  });
});

describe("Poro Snax (SFD-046) and Pickpocket (SFD-074)", () => {
  it("Poro Snax draws when it is played", () => {
    const snax = gear(PORO_SNAX);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [snax];
    state.players[0]!.deck = stockDeck();

    // Held through the real helper `executePlayCard` uses, rather than by
    // hand-building a chain entry — a hand-built one asserts the shape of the
    // fixture instead of the shape the engine produces.
    const after = resolveHeldTriggers(holdSelfTrigger(state, "played", snax, 0));

    expect(hand(after), "the on-play draw did not fire").toBe(hand(state) + 1);
  });

  /** "Kill this" is a COST, so it must not pay the on-play draw a second time —
   *  the reason the self-trigger lists only `"played"`. */
  it("Poro Snax does NOT draw again when it is killed", () => {
    const snax = gear(PORO_SNAX);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [snax];
    state.players[0]!.deck = stockDeck();

    const after = resolveHeldTriggers(holdSelfTrigger(state, "killed", snax, 0));

    expect(hand(after), "being killed paid the on-play draw").toBe(hand(state));
  });

  it("Pickpocket offers a gear costing [1] or less, and pays a Gold for the kill", () => {
    // Only offered if the printed Energy cost really is within reach — asserted
    // rather than assumed, because the first draft of this test picked a 2-cost
    // gear and would have passed on a "decline" that meant nothing.
    expect(gearDef(CLOTH_ARMOR).energyCost, "the fixture gear is too expensive to be offered").toBeLessThanOrEqual(
      1,
    );

    const cheap = gear(CLOTH_ARMOR);
    const state = makeState({ phase: "Action" });
    state.players[1]!.activeGear = [cheap];

    const offered = resolveHeldTriggers(
      runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-074-kill", playerIndex: 0 }] }),
    );
    const decision = pendingDecision(offered)!;
    expect(decision.kind, "no kill was offered").toBe("SFD-074-kill");

    const after = answerDecision(offered, decision.id, `1:${cheap.instanceId}`)!;

    expect(after.players[1]!.activeGear, "the enemy gear was not killed").toHaveLength(0);
    // "If you do" — the Gold goes to Pickpocket's controller, not the victim.
    expect(after.players[0]!.activeGear.length, "no Gold token was played").toBeGreaterThan(0);
  });

  /** "If you do" ties the Gold strictly to the kill. */
  it("Pickpocket pays no Gold when declined", () => {
    const cheap = gear(CLOTH_ARMOR);
    const state = makeState({ phase: "Action" });
    state.players[1]!.activeGear = [cheap];

    const offered = resolveHeldTriggers(
      runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-074-kill", playerIndex: 0 }] }),
    );
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[1]!.activeGear, "declining still killed the gear").toHaveLength(1);
    expect(after.players[0]!.activeGear, "declining still paid a Gold").toHaveLength(0);
  });

  /** "No more than [1]" is a ceiling — a 2-cost gear is not on the list at all. */
  it("Pickpocket does not offer a gear costing more than [1]", () => {
    expect(gearDef(LONG_SWORD).energyCost, "the control gear is not actually expensive").toBeGreaterThan(1);

    const pricey = gear(LONG_SWORD);
    const state = makeState({ phase: "Action" });
    state.players[1]!.activeGear = [pricey];

    const offered = runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-074-kill", playerIndex: 0 }] });
    const after = answerDecision(offered, "d1", `1:${pricey.instanceId}`) ?? offered;

    expect(after.players[1]!.activeGear, "a gear over the ceiling was killed").toHaveLength(1);
  });
});

/**
 * The count moving is a separate fact from the cards working — see this file's
 * header for the two times this repo shipped a working card that reported
 * unimplemented.
 */
describe("coverage claims", () => {
  const ALL = [
    JAE_MEDARDA,
    SPIRIT_WHEEL,
    FIORA_WORTHY,
    YORDLE_EXPLORER,
    PORO_SNAX,
    PICKPOCKET,
    RUMBLE_SCRAPPER,
    GEARHEAD,
    ANCIENT_WARMONGER,
  ];

  it.each(ALL)("%s is claimed by a module", (defId) => {
    expect(isCardImplemented(registry.get(defId))).toBe(true);
  });

  /** Both of the two-clause cards landed WHOLE. Coverage is per defId, so either
   *  half alone would have reported them finished — this is what says otherwise. */
  it.each([RUMBLE_SCRAPPER, PORO_SNAX])("%s carries no partial note", (defId) => {
    expect(partialImplementationNote(registry.get(defId))).toBeUndefined();
  });
});
