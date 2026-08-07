import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { attachEquipment, detachEquipment, effectiveTagsOf, isMechUnit } from "../src/engine/equipment.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance } from "./fixtures.js";

/**
 * Experimental Hexplate (SFD-073) — "**I am a Mech**."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * # Two things the standing note got wrong
 *
 * It said a granted TAG was blocked because "`tags` is printed-only today". It is
 * not: `card.ts` copies a definition's tags onto every `UnitInstance`, and the
 * Mech TOKEN already depends on that — it has no registry entry at all, so its
 * instance tags are its only record. Nothing needed new storage.
 *
 * What it needed was for the READERS to ask one function. There were seven, split
 * between `unit.tags` and `def.tags`; six concern units in play and now route
 * through `isMechUnit`/`effectiveTagsOf`. The seventh — Rumble Scrapper's "a Mech
 * from your TRASH" — is deliberately untouched, since a card in a trash wears
 * nothing.
 *
 * # "I" is the WEARER
 *
 * The reading the eight wearer's-moments Equipment already establish for the
 * pronoun on an Equipment, and here also the only one that does anything: every
 * Mech check in this engine asks about a UNIT, so a gear that was itself a Mech
 * would satisfy none of them and the card would be blank.
 */

const registry = defaultCardRegistry();
const HEXPLATE = "SFD-073";
/** Rumble - Scrapper — "+1 Might to your Mechs", the aura keyed on the tag.
 *  Taken from `effective-might`'s own constant rather than transcribed, since a
 *  wrong id here would make the reader test pass for the wrong reason. */
const RUMBLE_SCRAPPER = "SFD-089";
/** Breakneck Mech — "your Mechs have [Deflect] and [Ganking]", a KEYWORD aura,
 *  which reads tags by a different path than the Might aura above. */
const BREAKNECK_MECH = "SFD-071";
const MECH_TAG = "Mech";

const combat = { isCombat: false } as const;

/** A plain (non-Mech) wearer in p1's base, with an unattached Hexplate. */
function board(): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer", name: "Wearer", might: 3, tags: [] })];
  state.players[0]!.activeGear = [{ ...realGearInstance(HEXPLATE), instanceId: "plate", attachedToInstanceId: null }];
  return state;
}

const wearerOf = (state: GameState) => state.players[0]!.baseUnits.find((u) => u.instanceId === "wearer")!;

describe("Experimental Hexplate grants the Mech tag to its wearer", () => {
  it("adds Mech while attached, and only while attached", () => {
    const before = board();
    expect(isMechUnit(before, wearerOf(before)), "a bare unit was already a Mech").toBe(false);

    const attached = attachEquipment(before, 0, "plate", "wearer");
    expect(isMechUnit(attached, wearerOf(attached)), "the tag was not granted").toBe(true);

    const detached = detachEquipment(attached, 0, "plate");
    expect(isMechUnit(detached, wearerOf(detached)), "the tag outlived the attachment").toBe(false);
  });

  it("adds the tag to the effective list without disturbing printed ones", () => {
    const state = board();
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer", might: 3, tags: ["Noxus"] })];
    const attached = attachEquipment(state, 0, "plate", "wearer");

    expect([...effectiveTagsOf(attached, wearerOf(attached))].sort()).toEqual(["Mech", "Noxus"]);
  });

  /** A unit that ALREADY prints Mech must not gain a duplicate. */
  it("does not duplicate a printed Mech tag", () => {
    const state = board();
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer", might: 3, tags: [MECH_TAG] })];
    const attached = attachEquipment(state, 0, "plate", "wearer");

    expect(effectiveTagsOf(attached, wearerOf(attached)).filter((t) => t === MECH_TAG)).toHaveLength(1);
  });

  it("gives no tag to a unit NOT wearing it", () => {
    const state = board();
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "wearer", might: 3, tags: [] }),
      makeUnit({ instanceId: "bystander", might: 3, tags: [] }),
    ];
    const attached = attachEquipment(state, 0, "plate", "wearer");
    const bystander = attached.players[0]!.baseUnits.find((u) => u.instanceId === "bystander")!;

    expect(isMechUnit(attached, bystander), "the tag leaked to another unit").toBe(false);
  });
});

/**
 * The grant reaching a real consumer is the whole point — a helper nobody calls
 * would pass every test above and change no game.
 */
describe("the granted tag reaches the readers", () => {
  it("satisfies Rumble Scrapper's Might aura, which is keyed on the tag", () => {
    const state = board();
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "wearer", might: 3, tags: [] }),
      { ...realUnitInstance(RUMBLE_SCRAPPER), instanceId: "rumble" },
    ];

    const before = effectiveMight(state, wearerOf(state), 0, combat);
    const attached = attachEquipment(state, 0, "plate", "wearer");
    const after = effectiveMight(attached, wearerOf(attached), 0, combat);

    // The Hexplate's own printed badge moves Might too, so the assertion is that
    // the aura ALSO applied — i.e. the gain exceeds the badge alone.
    const badge = registry.get(HEXPLATE);
    const badgeBonus = badge.type === "Gear" ? (badge.equipMightBonus ?? 0) : 0;
    expect(after - before, "the tribal aura did not see the granted tag").toBeGreaterThan(badgeBonus);
  });

  /**
   * `KEYWORD_AURAS` reads tags through a DIFFERENT path (`appliesToDef`) than the
   * Might aura above, so this is a second reader rather than a restatement.
   *
   * The source has to be an actual keyword-aura card: the first version of this
   * test used Rumble - Scrapper, who is a MIGHT aura and grants no keywords, so
   * both sides of the comparison were empty and it passed with the tag grant
   * disabled. Breakneck Mech is Mech-keyed and grants two keywords, and the
   * assertion below names them rather than comparing two possibly-empty sets.
   */
  it("satisfies a Mech-keyed KEYWORD aura", () => {
    const state = board();
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "wearer", might: 3, tags: [] }),
      { ...realUnitInstance(BREAKNECK_MECH), instanceId: "breakneck" },
    ];

    const before = Object.keys(effectiveKeywords(state, wearerOf(state), 0));
    expect(before, "a bare unit already had the aura's keywords").not.toContain("Ganking");

    const attached = attachEquipment(state, 0, "plate", "wearer");
    const after = Object.keys(effectiveKeywords(attached, wearerOf(attached), 0));

    expect(after, "the keyword aura did not see the granted tag").toContain("Ganking");
    expect(after, "the keyword aura did not see the granted tag").toContain("Deflect");
  });
});

describe("Experimental Hexplate's coverage", () => {
  it("is claimed by a module and its art-only note is gone", () => {
    expect(isCardImplemented(registry.get(HEXPLATE)), "SFD-073 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(HEXPLATE)), "the note outlived its clause").toBeUndefined();
  });
});
