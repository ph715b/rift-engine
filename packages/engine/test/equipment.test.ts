import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { parseEquipCost } from "../src/cards/card-loader.js";
import {
  attachEquipment,
  detachAllFrom,
  detachEquipment,
  equipMightBonusOf,
  equipmentAttachedTo,
  equipmentMightBonusFor,
  isEquipmentGear,
  holdQuickDrawAttach,
  QUICK_DRAW_DECISION,
  holdWeaponmasterOffer,
  weaponmasterCostFor,
  WEAPONMASTER_DECISION,
} from "../src/engine/equipment.js";
import { activatedAbilityFor, activationCostOf, hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords, hasKeyword } from "../src/engine/granted-keywords.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { contextFor } from "../src/engine/effect-context.js";
import { partialImplementationNote } from "../src/engine/coverage.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realGearInstance, realUnitInstance } from "./fixtures.js";
import type { GearDefinition } from "../src/model/card-definition.js";

/**
 * Equipment attachment — SFD's headline subsystem.
 *
 * # The data gap this had to work around, and it is the finding
 *
 * **An Equipment's "+N Might" badge is in NO field of the card JSON.**
 * `attributes.might` is null on every one, and the badge appears in neither
 * `text.plain`, `text.rich` nor `accessibility_text`. It exists only on the
 * printed art: Doran's Blade shows a shield reading "+2" and its JSON says
 * nothing about it. About 20 of the 31 also have a SECOND ability rendered the
 * same art-only way, which is a larger gap still and is not covered here.
 *
 * So the badge is a hand-transcribed table, exactly like `powerDomainAlt`. The
 * values come from the frozen Java oracle, which surveyed all 31 — and two of
 * them were read off the card images independently here first, and agreed.
 */
const registry = defaultCardRegistry();

const DORANS_BLADE = "SFD-095"; // [Equip] 1 Body, +2 Might
const BFS = "SFD-161"; // B.F. Sword — [Equip] 1 Order, +3 Might
const SERRATED_DIRK = "SFD-009"; // [Equip] 1 Fury, +0 Might
const FORGEFIRE_CAPE = "SFD-190"; // rainbow cost — deliberately unwired
const LAST_RITES = "SFD-150"; // compound cost — deliberately unwired

const combat = { isCombat: false } as const;

/**
 * `registry.get` returns the `CardDefinition` UNION, and `equipCost`,
 * `equipMightBonus` and `isEquipment` are all declared on `GearDefinition`
 * alone. Narrowed once here rather than cast at each of the eight uses below.
 *
 * The `expect` is the narrowing's own premise check: a defId that stopped being
 * Gear would otherwise be silently cast into one and read `undefined` for every
 * field, which passes several of the assertions below for the wrong reason.
 */
function gearDef(defId: string): GearDefinition {
  const def = registry.get(defId);
  expect(def.type, `${defId} is not Gear`).toBe("Gear");
  return def as GearDefinition;
}

describe("the Equipment data, which is mostly not in the data", () => {
  it("reads the +N badge from the table, since the JSON has none", () => {
    // The three values are independent, so a table that returned a constant
    // would fail here rather than looking plausible.
    expect(gearDef(DORANS_BLADE).equipMightBonus).toBe(2);
    expect(gearDef(BFS).equipMightBonus).toBe(3);
    expect(gearDef(SERRATED_DIRK).equipMightBonus).toBe(0);
    // And the gap itself, asserted so nobody "fixes" the table by parsing.
    const raw = gearDef(DORANS_BLADE);
    expect(raw.text).not.toContain("+2");
    // `GearDefinition` declares no `might` at all, so this is an index read
    // rather than a property access — the assertion is "the badge is not in the
    // data", and it has to be able to look for a field the type denies exists.
    expect((raw as { might?: number }).might, "a Might field appeared on Gear").toBeUndefined();
  });

  it("parses the [Equip] cost, which IS in the text", () => {
    expect(parseEquipCost("[Equip] :rb_rune_body: (reminder)")).toEqual({ energy: 0, domain: "Body", count: 1 });
    expect(parseEquipCost("[Equip] :rb_energy_1::rb_rune_fury:")).toEqual({ energy: 1, domain: "Fury", count: 1 });
    expect(parseEquipCost("[Equip] :rb_rune_rainbow:")).toEqual({ energy: 0, domain: "rainbow", count: 1 });
    expect(parseEquipCost("no equip here")).toBeUndefined();
  });

  it("refuses the two COMPOUND costs rather than half-reading them", () => {
    // A looser pattern would take the rune out of "[Equip] — :rb_rune_chaos:,
    // Recycle 2 cards from your trash" and hand the card an ability costing only
    // the rune — strictly CHEAPER than printed, which is the one direction this
    // codebase never ships.
    expect(gearDef(LAST_RITES).equipCost).toBeUndefined();
    expect(gearDef("SFD-178").equipCost).toBeUndefined();
    expect(gearDef(LAST_RITES).text).toContain("Recycle 2");
  });

  it("marks Equipment from the printed tag, not from having [Equip]", () => {
    expect(gearDef(DORANS_BLADE).isEquipment).toBe(true);
    // A non-Equipment Gear must not be swept in — Equipment is a printed tag and
    // `[Weaponmaster]`/Angle Shot mean exactly it.
    const plainGear = registry
      .all()
      .find((c): c is GearDefinition => c.type === "Gear" && (c as GearDefinition).isEquipment !== true)!;
    expect(plainGear.isEquipment).toBeUndefined();
    expect(isEquipmentGear({ defId: plainGear.id })).toBe(false);
    expect(isEquipmentGear({ defId: DORANS_BLADE })).toBe(true);
  });
});

describe("attaching and detaching", () => {
  /** A unit at base with an unattached Doran's Blade in the same player's gear. */
  function board(gearDefId = DORANS_BLADE): { state: GameState; unitId: string; gearId: string } {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(gearDefId);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];
    return { state, unitId: unit.instanceId, gearId: gear.instanceId };
  }

  it("attaches, and the gear STAYS in activeGear", () => {
    // Attaching is not a zone change — `attachedToInstanceId` is state layered on
    // top, which is what lets an attached gear still be killed, readied and
    // counted like any other.
    const { state, unitId, gearId } = board();
    const after = attachEquipment(state, 0, gearId, unitId);
    expect(after.players[0]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBe(unitId);
    expect(equipmentAttachedTo(after, unitId).map((g) => g.instanceId)).toEqual([gearId]);
  });

  it("MOVES an already-attached Equipment rather than refusing", () => {
    // [Weaponmaster]'s own reminder is explicit — "even if it's already
    // attached" — so re-equipping relocates and needs no detach first.
    const { state, unitId, gearId } = board();
    const second = makeUnit({ name: "Second" });
    state.players[0]!.baseUnits.push(second);

    const moved = attachEquipment(attachEquipment(state, 0, gearId, unitId), 0, gearId, second.instanceId);

    expect(equipmentAttachedTo(moved, unitId)).toHaveLength(0);
    expect(equipmentAttachedTo(moved, second.instanceId)).toHaveLength(1);
  });

  it("does nothing when the gear is not that player's", () => {
    const { state, unitId, gearId } = board();
    expect(attachEquipment(state, 1, gearId, unitId)).toEqual(state);
  });

  it("detaches on request, leaving the gear in play", () => {
    const { state, unitId, gearId } = board();
    const after = detachEquipment(attachEquipment(state, 0, gearId, unitId), 0, gearId);
    expect(after.players[0]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBeNull();
  });
});

describe("the +N Might badge, applied continuously", () => {
  it("raises the wearer's effective Might, and only while attached", () => {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];

    expect(effectiveMight(state, unit, 0, combat)).toBe(3);
    const armed = attachEquipment(state, 0, gear.instanceId, unit.instanceId);
    expect(effectiveMight(armed, unit, 0, combat)).toBe(5);
    // Continuous, not a stored buff: detaching removes it in the same instant.
    const bare = detachEquipment(armed, 0, gear.instanceId);
    expect(effectiveMight(bare, unit, 0, combat)).toBe(3);
    expect(bare.players[0]!.baseUnits[0]!.buffed, "a stored buff would survive the detach").toBe(false);
  });

  it("stacks across several Equipment", () => {
    const unit = makeUnit({ name: "Wearer", might: 1 });
    const blade = realGearInstance(DORANS_BLADE); // +2
    const sword = realGearInstance(BFS); // +3
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [blade, sword];

    let armed = attachEquipment(state, 0, blade.instanceId, unit.instanceId);
    armed = attachEquipment(armed, 0, sword.instanceId, unit.instanceId);
    expect(equipmentMightBonusFor(armed, unit.instanceId)).toBe(5);
    expect(effectiveMight(armed, unit, 0, combat)).toBe(6);
  });

  it("gives nothing for a 0-badge Equipment, which is a real printed value", () => {
    expect(equipMightBonusOf({ defId: SERRATED_DIRK })).toBe(0);
  });
});

describe("a unit leaving play", () => {
  it("DETACHES its Equipment rather than destroying it", () => {
    // The Zero Drive's "Use only if unattached" and Spinning Axe's "if this is
    // unattached, kill it" both presuppose a gear outliving its wearer.
    const unit = makeUnit({ name: "Doomed", might: 2 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];
    const armed = attachEquipment(state, 0, gear.instanceId, unit.instanceId);

    // `destroyUnit`, NOT `killUnit`: killUnit expects the unit to have been
    // REMOVED from wherever it stood already, and calling it directly leaves the
    // board holding two of it. That trap is recorded in this repo and this test
    // walked straight into it on the first run.
    const after = destroyUnit(armed, unit.instanceId);

    expect(after.players[0]!.baseUnits, "the unit survived — the fixture is wrong").toHaveLength(0);
    expect(after.players[0]!.activeGear, "the gear was destroyed with its wearer").toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "a dangling attachment").toBeNull();
  });

  it("detaches from BOTH sides, since control and ownership can differ", () => {
    // Nothing says an Equipment and its wearer share a controller, and
    // `takeControlOfUnit` already moves units between lists. Scanning one side
    // would leave a gear pointing at a unit that is gone — which reads in play as
    // a Might bonus from an Equipment attached to nothing.
    const unit = makeUnit({ name: "Shared" });
    const theirs = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[1]!.activeGear = [{ ...theirs, attachedToInstanceId: unit.instanceId }];

    const after = detachAllFrom(state, unit.instanceId);
    expect(after.players[1]!.activeGear[0]!.attachedToInstanceId).toBeNull();
  });
});

describe("the generated [Equip] ability", () => {
  it("gives 25 of the 31 Equipment a working ability, with no per-card code", () => {
    // The scope-reducer: the cost parses, the attach is generic, so a table
    // entry per card would be 25 copies of one thing, each free to drift.
    const equipment = registry.all().filter((c) => c.type === "Gear" && c.isEquipment === true);
    expect(equipment).toHaveLength(31);
    const wired = equipment.filter((c) => hasActivatableAbility(c.id));
    expect(wired).toHaveLength(25);
  });

  it("costs what the card prints, and does NOT exhaust", () => {
    // An exhaust nobody printed would make every Equipment a once-per-turn
    // attach, and re-equipping is the point.
    expect(activationCostOf(DORANS_BLADE)).toEqual({ power: { domain: "Body", count: 1 } });
    expect(activationCostOf("SFD-030")).toMatchObject({ energy: 1, power: { domain: "Fury", count: 1 } });
    expect(activationCostOf(DORANS_BLADE).exhaust).toBeUndefined();
  });

  it("attaches when it resolves, to the unit the activation named", () => {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];

    const ability = activatedAbilityFor(DORANS_BLADE);
    expect(ability, "Doran's Blade has no generated ability").toBeDefined();
    const after = ability!.resolve!(
      state,
      contextFor(0),
      { targetUnitInstanceId: unit.instanceId },
      gear.instanceId,
    );
    expect(equipmentAttachedTo(after, unit.instanceId)).toHaveLength(1);
    expect(effectiveMight(after, unit, 0, combat)).toBe(5);
  });

  it("leaves the 6 it cannot price UNWIRED, and each says why", () => {
    // Four rainbow costs (ActivationCost names one domain, and rainbow is not a
    // domain) and two compound costs. Named individually rather than under a
    // keyword flag, which would have greyed the 25 that work along with them.
    for (const defId of [FORGEFIRE_CAPE, "SFD-191", "SFD-192", "SFD-186"]) {
      expect(hasActivatableAbility(defId), `${defId} should be unwired`).toBe(false);
      expect(partialImplementationNote(registry.get(defId))).toContain("RAINBOW");
    }
    for (const defId of [LAST_RITES, "SFD-178"]) {
      expect(hasActivatableAbility(defId)).toBe(false);
      expect(partialImplementationNote(registry.get(defId))).toContain("compound cost");
    }
  });
});

/**
 * `[Quick-Draw]` — "This has [Reaction]. When you play it, attach it to a unit
 * you control."
 *
 * Keyword-driven, so one implementation covers the four Gear that print it AND
 * Jax - Unmatched, who grants it to every Equipment his controller has. Hooked
 * at the one place a Gear enters `activeGear`.
 */
describe("[Quick-Draw]", () => {
  const LONG_SWORD = "SFD-022"; // prints [Quick-Draw], +2 Might
  const JAX_UNMATCHED = "SFD-054"; // "Your Equipment everywhere have [Quick-Draw]"

  it("the [Reaction] half needed nothing — the loader already had it", () => {
    // The keyword's own reminder text contains the substring "[Reaction]", and
    // `isReaction` is set from exactly that. Measured across all four rather
    // than assumed from one.
    for (const defId of [LONG_SWORD, "SFD-056", "SFD-064", "SFD-186"]) {
      const def = registry.get(defId);
      expect(def.type).toBe("Gear");
      expect(def.type === "Gear" ? def.isReaction : false, `${defId} ${def.name}`).toBe(true);
      expect(def.type === "Gear" ? def.keywords["Quick-Draw"] : undefined, `${defId}`).toBe(1);
    }
  });

  it("attaches with NO prompt when there is only one unit", () => {
    // A decision with exactly one option is auto-resolved and never prompts —
    // a documented trap here, and the first version of this test asserted a
    // pending decision and failed on it. One unit means no choice to make, so
    // the attach simply happens.
    const wearer = makeUnit({ name: "Wearer", might: 2 });
    const gear = realGearInstance(LONG_SWORD);
    const state = makeState();
    state.players[0]!.baseUnits = [wearer];
    state.players[0]!.activeGear = [gear];

    const after = holdQuickDrawAttach(state, 0, gear);

    expect(pendingDecision(after), "a one-option question was asked").toBeUndefined();
    expect(equipmentAttachedTo(after, wearer.instanceId)).toHaveLength(1);
    expect(effectiveMight(after, wearer, 0, combat)).toBe(4); // 2 + Long Sword's +2
  });

  it("ASKS when there are two units, and attaches to the answer", () => {
    const first = makeUnit({ name: "First", might: 2 });
    const second = makeUnit({ name: "Second", might: 5 });
    const gear = realGearInstance(LONG_SWORD);
    const state = makeState();
    state.players[0]!.baseUnits = [first, second];
    state.players[0]!.activeGear = [gear];

    const parked = holdQuickDrawAttach(state, 0, gear);
    expect(pendingDecision(parked)?.kind, "no attach was offered").toBe(QUICK_DRAW_DECISION);

    const answered = answerDecisions(parked, (options) => options[1]!.id);
    expect(equipmentAttachedTo(answered, second.instanceId), "attached to the wrong unit").toHaveLength(1);
    expect(equipmentAttachedTo(answered, first.instanceId)).toHaveLength(0);
  });

  it("asks NOTHING when there is no unit to attach to", () => {
    // A lone "Decline" would be theatre, and `[Quick-Draw]` prints no "you may"
    // — so with a unit available the attach is mandatory and only the target is
    // a choice.
    const state = makeState();
    state.players[0]!.baseUnits = [];
    expect(holdQuickDrawAttach(state, 0, realGearInstance(LONG_SWORD))).toEqual(state);
  });

  it("does not fire for a Gear without the keyword", () => {
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit()];
    // Doran's Blade is an Equipment and prints [Equip], but NOT [Quick-Draw].
    expect(holdQuickDrawAttach(state, 0, realGearInstance(DORANS_BLADE))).toEqual(state);
  });

  it("Jax - Unmatched GRANTS it, so an ordinary Equipment gains the attach", () => {
    // The half a printed-keyword-only reading would miss entirely.
    const jax = realUnitInstance(JAX_UNMATCHED);
    const blade = realGearInstance(DORANS_BLADE);
    const state = makeState();
    // TWO units so the question is really asked rather than auto-resolved,
    // which is what makes "Jax granted it" observable as a prompt.
    state.players[0]!.baseUnits = [jax, makeUnit({ name: "Other" })];
    state.players[0]!.activeGear = [blade];

    const granted = holdQuickDrawAttach(state, 0, blade);
    expect(pendingDecision(granted)?.kind, "Jax granted nothing").toBe(QUICK_DRAW_DECISION);

    // And only to HIS controller's Equipment — "YOUR Equipment everywhere".
    const theirs = makeState();
    theirs.players[1]!.baseUnits = [jax];
    theirs.players[0]!.baseUnits = [makeUnit()];
    expect(holdQuickDrawAttach(theirs, 0, realGearInstance(DORANS_BLADE))).toEqual(theirs);
  });
});

/**
 * `[Weaponmaster]` — "When you play me, you may [Equip] one of your Equipment to
 * me for :rb_rune_rainbow: less, even if it's already attached."
 *
 * The discount is on the EQUIPMENT's cost, not a cost of its own, so this needed
 * none of the rainbow-payment machinery the four rainbow-cost Equipment are
 * still blocked on.
 */
describe("[Weaponmaster]", () => {
  const SENTINEL_ADEPT = "SFD-008"; // Weaponmaster and nothing else

  const fury = (id: string) => ({ id, domain: "Fury" as const, state: "Ready" as const });

  it("discounts the [Equip] cost by one rune, which usually makes it free", () => {
    // 25 of the 31 print a cost of exactly one rune, so the discount takes it to
    // nothing — that is the card's whole point.
    expect(weaponmasterCostFor(DORANS_BLADE)).toEqual({ energy: 0, domain: "Body", count: 0 });
    // Skyfall of Areion is 1 Energy + 1 Fury: the rune goes, the Energy stays.
    expect(weaponmasterCostFor("SFD-030")).toEqual({ energy: 1, domain: "Fury", count: 0 });
    // A rainbow cost cannot be priced, so it is not offered at all.
    expect(weaponmasterCostFor(FORGEFIRE_CAPE)).toBeUndefined();
  });

  it("offers the attach on play, and attaches free when the cost is one rune", () => {
    const adept = realUnitInstance(SENTINEL_ADEPT);
    const blade = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [adept];
    state.players[0]!.activeGear = [blade];
    state.players[0]!.channeled = [fury("r1")];

    const offered = holdWeaponmasterOffer(state, 0, adept);
    expect(pendingDecision(offered)?.kind, "no Weaponmaster offer was made").toBe(WEAPONMASTER_DECISION);

    const taken = answerDecisions(offered, (options) => options[0]!.id);
    expect(equipmentAttachedTo(taken, adept.instanceId), "the Equipment did not attach").toHaveLength(1);
    // Free: Doran's Blade costs one Body rune and the discount removes it, so the
    // Fury rune in the pool is untouched.
    expect(taken.players[0]!.channeled.filter((r) => r.state === "Ready"), "something was paid").toHaveLength(1);
  });

  it("can be DECLINED — the card prints 'you may'", () => {
    const adept = realUnitInstance(SENTINEL_ADEPT);
    const state = makeState();
    state.players[0]!.baseUnits = [adept];
    state.players[0]!.activeGear = [realGearInstance(DORANS_BLADE)];

    const offered = holdWeaponmasterOffer(state, 0, adept);
    const declined = answerDecisions(offered, (options) => options.find((o) => o.id === "decline")!.id);
    expect(equipmentAttachedTo(declined, adept.instanceId)).toHaveLength(0);
  });

  it("offers an ALREADY-ATTACHED Equipment too", () => {
    // "even if it's already attached" — re-equipping is a relocation and is
    // explicitly legal, so the offer lists every Equipment rather than only the
    // unattached ones.
    const adept = realUnitInstance(SENTINEL_ADEPT);
    const other = makeUnit({ name: "Other" });
    const blade = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [adept, other];
    state.players[0]!.activeGear = [blade];
    const armed = attachEquipment(state, 0, blade.instanceId, other.instanceId);

    const taken = answerDecisions(holdWeaponmasterOffer(armed, 0, adept), (options) => options[0]!.id);
    expect(equipmentAttachedTo(taken, adept.instanceId), "the attached blade was not offered").toHaveLength(1);
    expect(equipmentAttachedTo(taken, other.instanceId)).toHaveLength(0);
  });

  it("asks NOTHING with no Equipment to offer, and not for a unit without the keyword", () => {
    const adept = realUnitInstance(SENTINEL_ADEPT);
    const bare = makeState();
    bare.players[0]!.baseUnits = [adept];
    expect(holdWeaponmasterOffer(bare, 0, adept), "offered with no Equipment").toEqual(bare);

    const plain = makeState();
    plain.players[0]!.activeGear = [realGearInstance(DORANS_BLADE)];
    const noKeyword = makeUnit({ name: "Ordinary" });
    plain.players[0]!.baseUnits = [noKeyword];
    expect(holdWeaponmasterOffer(plain, 0, noKeyword)).toEqual(plain);
  });
});

/**
 * The hop that the first version of `[Weaponmaster]` got wrong.
 *
 * It was hooked at the foot of `execute-play-card`, where a Unit can never
 * arrive — a Unit returns from one of two earlier branches, so the check
 * narrowed to "Spell" | "Gear" and was dead code. **`tsc` caught it and the unit
 * tests did not**, because vitest strips types and those tests called the helper
 * directly. This one goes through the real dispatcher instead.
 */
describe("[Weaponmaster] is reachable through the real on-play dispatch", () => {
  it("fires from dispatchOnPlayUnit, not from a direct call", () => {
    const adept = realUnitInstance("SFD-008");
    const blade = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [adept];
    state.players[0]!.activeGear = [blade];

    // The same funnel `[Vision]` fires from, and the one every route into play
    // goes through — base play, battlefield play, and free play alike.
    const played = dispatchOnPlayUnit(state, adept, 0, "base");

    expect(pendingDecision(played)?.kind, "the offer never reached the dispatcher").toBe(WEAPONMASTER_DECISION);
    const taken = answerDecisions(played, (options) => options[0]!.id);
    expect(equipmentAttachedTo(taken, adept.instanceId)).toHaveLength(1);
  });

  it("does not fire for an ordinary unit going through the same funnel", () => {
    const state = makeState();
    state.players[0]!.activeGear = [realGearInstance(DORANS_BLADE)];
    const ordinary = makeUnit({ name: "Ordinary" });
    state.players[0]!.baseUnits = [ordinary];

    expect(pendingDecision(dispatchOnPlayUnit(state, ordinary, 0, "base"))).toBeUndefined();
  });
});

/**
 * Keywords an attached Equipment grants its wearer.
 *
 * **Transcribed from the card ART**, because — like the Might badge — it is in
 * no field of the JSON: `text.plain` for every one of these is nothing but its
 * `[Equip]` line, and the granted keyword sits in the box the printed card
 * devotes to what the WEARER gains.
 *
 * Read off contact sheets built from the `media.image_url` already in the data,
 * which also re-verified all 31 Might badges against the art independently of
 * the oracle table they were ported from. Every one matched.
 */
describe("an attached Equipment grants its wearer keywords", () => {
  const SERRATED_DIRK = "SFD-009"; // [Assault 2]
  const DORANS_SHIELD = "SFD-033"; // [Tank]
  const CLOTH_ARMOR = "SFD-064"; // [Shield 2]
  const BOOTS = "SFD-133"; // [Ganking]

  /** A bare unit with `gearDefIds` attached to it. */
  function wearing(...gearDefIds: string[]): { state: GameState; unitId: string } {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = gearDefIds.map((id) => realGearInstance(id));
    let next = state;
    for (const gear of state.players[0]!.activeGear) {
      next = attachEquipment(next, 0, gear.instanceId, unit.instanceId);
    }
    return { state: next, unitId: unit.instanceId };
  }

  const keywordsOf = (state: GameState, unitId: string) => {
    const unit = state.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!;
    return effectiveKeywords(state, unit, 0);
  };

  it("grants the printed keyword, at its printed value", () => {
    // Four distinct keywords at three distinct values, so a table returning a
    // constant would fail rather than look plausible.
    const dirk = wearing(SERRATED_DIRK);
    expect(keywordsOf(dirk.state, dirk.unitId).Assault).toBe(2);
    const shield = wearing(DORANS_SHIELD);
    expect(keywordsOf(shield.state, shield.unitId).Tank).toBe(1);
    const cloth = wearing(CLOTH_ARMOR);
    expect(keywordsOf(cloth.state, cloth.unitId).Shield).toBe(2);
    const boots = wearing(BOOTS);
    expect(keywordsOf(boots.state, boots.unitId).Ganking).toBe(1);
  });

  it("takes it away the instant the Equipment detaches", () => {
    // Continuous, not stored — the same reasoning as the Might badge.
    const { state, unitId } = wearing(DORANS_SHIELD);
    expect(keywordsOf(state, unitId).Tank).toBe(1);
    const gearId = state.players[0]!.activeGear[0]!.instanceId;
    const bare = detachEquipment(state, 0, gearId);
    expect(keywordsOf(bare, unitId).Tank, "the keyword survived the detach").toBeUndefined();
  });

  it("grants nothing from an UNATTACHED Equipment sitting in play", () => {
    // The negative control that matters: owning the gear is not wearing it.
    const unit = makeUnit({ name: "Bare" });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [realGearInstance(DORANS_SHIELD)];
    expect(effectiveKeywords(state, unit, 0).Tank).toBeUndefined();
  });

  it("stacks two different Equipment, and does not ADD two of the same keyword", () => {
    const both = wearing(SERRATED_DIRK, BOOTS);
    const kw = keywordsOf(both.state, both.unitId);
    expect(kw.Assault).toBe(2);
    expect(kw.Ganking).toBe(1);

    // Two Cloth Armors are [Shield 2], not [Shield 4] — higher wins, which is how
    // every other source in effectiveKeywords already merges.
    const twoCloth = wearing(CLOTH_ARMOR, CLOTH_ARMOR);
    expect(keywordsOf(twoCloth.state, twoCloth.unitId).Shield, "two Shields were added together").toBe(2);
  });

  it("reaches COMBAT — Doran's Shield really makes its wearer a Tank", () => {
    // The keyword is only worth granting if the rules engine sees it, and combat
    // is where [Tank] means anything.
    const { state, unitId } = wearing(DORANS_SHIELD);
    const unit = state.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!;
    expect(hasKeyword(state, unit, 0, "Tank")).toBe(true);
  });
});
