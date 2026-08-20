import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { attachEquipment, detachAllFrom, equipmentAttachedTo } from "../src/engine/equipment.js";
import { hasActivatableAbility } from "../src/engine/activated-abilities.js";
import {
  banishUnitFromPlay,
  destroyUnit,
  forceMoveToBattlefield,
  recycleUnitFromPlayToDeck,
  relocateToBaseUnchanged,
  returnPermanentToHand,
  returnUnitToHand,
} from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * **Two playtest reports about attached Equipment, and both were engine bugs.**
 *
 *   6. "you should not be able to move around an equipment that is attached to a
 *      unit. once it is attached an effect can only be used to move it, not the
 *      equip cost"
 *   10. "if equipped unit gets bounced to hand the equipment detaches from the
 *      unit"
 *
 * # The rules, read against `pdftotext -raw`
 *
 * > **718.2** "While in this state, the card's printed Rules Text is Inactive."
 * > **434.1.e** "Attaching one or more cards will cause those cards' printed
 * >   Rules Text to become Inactive for as long as they remain Attached."
 * > **721.2** "Inactive Abilities do not trigger, do not apply, and cannot be
 * >   activated."
 * > **435.4.b** "If the Attached card was Detached because the Top-Most Card
 * >   changed zones from a board zone to a non-board zone, then the location that
 * >   the Attached Card will Detach to is the last location the Top-Most Card was
 * >   at before changing…"
 *
 * **821.1.c is the exception that proves the first three.** Weaponmaster has to
 * say "necessary portions of its Rules Text are no longer Inactive IF THEY ARE
 * CURRENTLY INACTIVE" before it may re-pay an attached gear's Equip cost, and
 * 821.1.c.5 anticipates the gear needing to be detached from its current
 * Top-Most card first.
 *
 * # Both were CLASSES, not cards
 *
 * The Equip one reached all 50 Equipment in the pool. The detach one reached
 * every way a unit leaves the board except the one that was written:
 * `detachAllFrom` was called from `killUnit` and nowhere else, while its own doc
 * comment claimed it was "called from every path a unit leaves play by".
 */

const GEAR = "UNL-188"; // Hextech Gauntlets — [Equip] [3][rainbow], reduced by the target's Might
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** The gear in play plus `wearers` units at bf1, with runes to equip several times. */
function board(wearers = 2): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.activeGear = [{ ...realGearInstance(GEAR), instanceId: "gear" }];
  state.battlefields[0]!.units = {
    p1: Array.from({ length: wearers }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 2 })),
  };
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`f${i}`, "Fury"));
  return state;
}

const equipsOffered = (state: GameState) =>
  legalActions(state)
    .filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "gear")
    .map((a) => (a.type === "ActivateAbility" ? a.targetUnitInstanceId : undefined));

const attachmentOf = (state: GameState) =>
  state.players.flatMap((p) => p.activeGear).find((g) => g.instanceId === "gear")?.attachedToInstanceId ?? null;

describe("an ATTACHED Equipment's own text is Inactive (718.2 / 721.2)", () => {
  it("offers its [Equip] at every legal wearer while DETACHED", () => {
    // The control. Without it, "nothing is offered once attached" could just as
    // easily mean the fixture never offered anything.
    expect(equipsOffered(board()).sort()).toEqual(["u0", "u1"]);
  });

  it("...and offers NOTHING once attached, with the runes still there", () => {
    // **Report 6.** The engine offered the Equip at both units — including a
    // re-attach to the unit it was already on, which 434.1.g/h make a no-op the
    // player would have paid Energy for.
    const attached = attachEquipment(board(), 0, "gear", "u0");
    expect(attachmentOf(attached), "the fixture did not attach").toBe("u0");
    expect(equipsOffered(attached), "an attached Equipment still offered its [Equip]").toEqual([]);
  });

  it("offers it again after it is DETACHED — Inactive is 'for as long as'", () => {
    // 434.1.e's own wording. A one-way gate would brick the gear permanently,
    // which is worse than the bug it replaced.
    const attached = attachEquipment(board(), 0, "gear", "u0");
    expect(equipsOffered(detachAllFrom(attached, "u0")).sort()).toEqual(["u0", "u1"]);
  });

  it("still REPORTS the keyword while attached — 722.1", () => {
    // "Cards with Inactive text still have keywords for the sake of Game Effects
    // that want to reference or see if a card has a keyword." So the defId lookup
    // must keep saying yes; only the OFFER is gated, which is why the fix lives in
    // `abilitiesAvailableTo` and not in the registry.
    expect(hasActivatableAbility(GEAR), "the keyword itself vanished").toBe(true);
  });
});

describe("an Equipment DETACHES when its wearer leaves the board (435.4.b)", () => {
  /** Every non-board zone a unit can reach, and the helper that sends it. */
  const nonBoardZones: [string, (state: GameState) => GameState][] = [
    ["hand (a bounce)", (s) => returnUnitToHand(s, "u0")],
    ["Main Deck (a Recycle)", (s) => recycleUnitFromPlayToDeck(s, 0, "u0")],
    ["banished", (s) => banishUnitFromPlay(s, "u0")],
    ["trash (a death)", (s) => destroyUnit(s, "u0")],
  ];

  for (const [label, send] of nonBoardZones) {
    it(`detaches when the wearer goes to ${label}`, () => {
      const attached = attachEquipment(board(), 0, "gear", "u0");
      expect(attachmentOf(attached), "the fixture did not attach").toBe("u0");

      const after = send(attached);
      expect(attachmentOf(after), "the gear kept a dangling attachment").toBeNull();
      // **The gear SURVIVES on the board** — 435.4.b detaches it to the wearer's
      // last location, it does not follow the unit out of play.
      expect(
        after.players[0]!.activeGear.map((g) => g.instanceId),
        "the gear left play with its wearer",
      ).toEqual(["gear"]);
    });
  }

  it("...and the freed gear can be equipped again", () => {
    // The consequence that makes the dangling pointer more than cosmetic, and it
    // is sharper now than before the Inactive fix: a gear left "attached" to a
    // card sitting in a hand would never offer its [Equip] again. Bricked, with
    // nothing on the board to explain why.
    const attached = attachEquipment(board(), 0, "gear", "u0");
    const bounced = returnUnitToHand(attached, "u0");
    expect(equipsOffered(bounced), "the gear was bricked by its wearer leaving").toEqual(["u1"]);
  });

  it("does NOT detach when the wearer merely MOVES", () => {
    // **The negative that bounds the fix.** 434.4 makes attaching a location
    // change and 718.5.c says an attached card "cannot be moved separately from
    // the Top-Most Card" — so a wearer walking to another battlefield takes its
    // gear with it. `removeUnitAnywhere` is shared by moves and by zone changes,
    // which is exactly why the detach could not go there.
    const attached = attachEquipment(board(), 0, "gear", "u0");
    expect(attachmentOf(forceMoveToBattlefield(attached, "u0", "bf2")), "a move detached the gear").toBe("u0");
    expect(attachmentOf(relocateToBaseUnchanged(attached, "u0")), "going home detached the gear").toBe("u0");
  });

  it("clears the attachment when the GEAR itself is returned to hand", () => {
    // The mirror, from the other end: a gear in a hand carrying a live
    // `attachedToInstanceId` would re-enter play already "worn".
    const attached = attachEquipment(board(), 0, "gear", "u0");
    const inHand = returnPermanentToHand(attached, "gear");

    expect(inHand.players[0]!.activeGear, "the gear stayed on the board").toEqual([]);
    expect(
      inHand.players[0]!.hand.map((c) => (c as { attachedToInstanceId?: string | null }).attachedToInstanceId ?? null),
      "a gear in hand kept its attachment",
    ).toEqual([null]);
    expect(equipmentAttachedTo(inHand, "u0"), "the wearer still reports equipment").toEqual([]);
  });
});
