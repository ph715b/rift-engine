import { describe, expect, it } from "vitest";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { eventTriggerDefIds, holdEventTrigger, HUNT_TRIGGER_KEY } from "../src/engine/triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, needsImplementation, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * `[Hunt N]` — "When I conquer or hold, gain N XP." Unleashed, 12 cards.
 *
 * Driven through `recordConquest` and `scoreHolds`, the two real moments, and
 * then SETTLED — both are Chain Pending Items, so a test that asserted on the
 * state `recordConquest` returns would be reading the board before the ability
 * has run and would pass with the trigger deleted.
 *
 * The keyword is registered ONCE, under `HUNT_TRIGGER_KEY`, rather than as
 * twelve card entries. So the thing most worth testing is not any one card but
 * that the single definition is reached BY the keyword and reads its magnitude
 * from it — which is why the cards below are chosen for their N and their other
 * text rather than for being interesting.
 */

const VORACIOUS_GROMP = "UNL-100"; // [Hunt 3], and its ENTIRE printed text
const SCORCHCLAW = "UNL-016"; // [Hunt 2], plus a [Level 3] clause
const HERALD_OF_SPRING = "UNL-034"; // [Hunt] — the bare form, meaning 1
const MASTER_YI_TEMPERED = "UNL-113"; // [Hunt 2], plus a [Level 6] clause

/** Player 0 controls bf1 with `defIds` standing on it; nobody has scored yet. */
function withUnitsAt(defIds: readonly string[], holder: 0 | 1 = 0): GameState {
  const state = makeState();
  const units = defIds.map((defId) => realUnitInstance(defId));
  state.battlefields[0]!.units = { [state.players[holder]!.id]: units };
  return state;
}

/** Conquest by player 0 of bf1, settled. */
const conquer = (state: GameState, index: 0 | 1 = 0) => resolveHeldTriggers(recordConquest(state, index, "bf1"));

describe("[Hunt N] gains XP when its own unit conquers", () => {
  it("pays the printed magnitude — 3 for Voracious Gromp", () => {
    const after = conquer(withUnitsAt([VORACIOUS_GROMP]));
    expect(after.players[0]!.xp).toBe(3);
  });

  it("reads the BARE form as 1, not as zero and not as absent", () => {
    // `[Hunt]` with no number is 6 of the 12 cards. `parseKeywords` defaults a
    // magnitude-less bracket to 1, and the reminder text on these cards says
    // "gain 1 XP" — so a listener that treated absent as 0 would silently make
    // half the keyword's cards do nothing while still triggering.
    const after = conquer(withUnitsAt([HERALD_OF_SPRING]));
    expect(after.players[0]!.xp).toBe(1);
  });

  it("pays PER UNIT — three Hunters at one battlefield is three triggers", () => {
    // 383 places one triggered ability per listener, and each is separately
    // respondable. A single "did anyone here Hunt" check would pay once.
    const after = conquer(withUnitsAt([VORACIOUS_GROMP, SCORCHCLAW, HERALD_OF_SPRING]));
    expect(after.players[0]!.xp).toBe(3 + 2 + 1);
  });

  it("pays NOTHING for a unit without the keyword", () => {
    // The negative control the three above cannot give: they would all pass if
    // conquering simply granted XP to the conqueror.
    const after = conquer(withUnitsAt(["OGN-164"]));
    expect(after.players[0]!.xp).toBe(0);
  });
});

describe("[Hunt N] is about THIS unit's battlefield, not the player's turn", () => {
  it("pays nothing when the Hunter is somewhere else", () => {
    // "When *I* conquer" is Kai'Sa - Survivor's reading: the unit has to be AT
    // the battlefield taken. A Hunter standing at bf2 watching bf1 fall gains
    // nothing, and this is the assertion that separates the keyword from a
    // Legend's "when YOU conquer".
    const state = makeState();
    state.battlefields[1]!.units = { [state.players[0]!.id]: [realUnitInstance(VORACIOUS_GROMP)] };
    expect(conquer(state).players[0]!.xp).toBe(0);
  });

  it("pays nothing when the Hunter is in base", () => {
    // The other half of "somewhere else", and the one with a different shape:
    // a base unit's listener carries no `battlefieldId` at all, so this is what
    // proves the undefined case is refused rather than matching by accident.
    const state = makeState();
    state.players[0]!.baseUnits = [realUnitInstance(VORACIOUS_GROMP)];
    expect(conquer(state).players[0]!.xp).toBe(0);
  });

  it("pays the OWNER, and pays nothing to the enemy whose battlefield it was", () => {
    // Both indices are checked, and a version that compared only battlefield ids
    // would pay an enemy Hunter standing on the field it just LOST.
    const state = withUnitsAt([VORACIOUS_GROMP], 1);
    const after = conquer(state, 0);
    expect(after.players[0]!.xp, "the conqueror gained the defender's Hunt").toBe(0);
    expect(after.players[1]!.xp, "the defender gained XP for losing the battlefield").toBe(0);
  });
});

describe("[Hunt N] fires on HOLDING too — the second of its two moments", () => {
  it("pays when the battlefield is held rather than taken", () => {
    // `scoreHolds` is a different call, a different event kind and a different
    // phase from `recordConquest`. A definition registered for only one moment
    // passes every conquer test above and silently halves the keyword.
    const state = withUnitsAt([SCORCHCLAW]);
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    const after = resolveHeldTriggers(scoreHolds(state, 0));
    expect(after.players[0]!.xp).toBe(2);
  });

  it("pays only the HOLDER — an enemy unit standing there gains nothing", () => {
    // The hold-side twin of the conquer ownership test, and it is asserted here
    // rather than through `scoreHolds` because that path cannot reach it:
    // `isHeldBy` requires the holder to be the battlefield's SOLE occupant, so a
    // hold with an enemy unit present never fires from scoring at all.
    //
    // It is still reachable, which is why the check is not deleted as dead code
    // the way the base-unit guard was — `mirroredMoment` (Skyfall of Areion)
    // turns a CONQUEST into a `battlefieldHeld` for the wearer's triggers, and a
    // conquest can leave enemy units standing. Driven through `holdEventTrigger`
    // directly, which is the shape both producers hand it.
    //
    // Found by a mutation: dropping this branch's owner check failed nothing.
    const state = makeState();
    state.battlefields[0]!.units = {
      [state.players[0]!.id]: [realUnitInstance(HERALD_OF_SPRING)],
      [state.players[1]!.id]: [realUnitInstance(VORACIOUS_GROMP)],
    };
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }),
    );
    expect(after.players[0]!.xp, "the holder's own Hunt did not pay — this test proves nothing").toBe(1);
    expect(after.players[1]!.xp, "an enemy unit gained XP from someone else's hold").toBe(0);
  });

  it("pays TWICE across a conquer and a later hold", () => {
    // The two moments are genuinely separate and both pay — a unit that takes a
    // battlefield and is still standing there next turn Hunts twice. This is
    // also the check that the two are not accidentally the same event: if
    // conquering also fired a hold, the first number here would already be 4.
    const state = withUnitsAt([SCORCHCLAW]);
    const conquered = conquer(state);
    expect(conquered.players[0]!.xp).toBe(2);

    const held = { ...conquered, battlefields: conquered.battlefields.map((bf) => ({ ...bf })) };
    held.battlefields[0]!.controllerId = held.players[0]!.id;
    held.players[0] = { ...held.players[0]!, scoredBattlefieldsThisTurn: [] };
    expect(resolveHeldTriggers(scoreHolds(held, 0)).players[0]!.xp).toBe(4);
  });
});

describe("the keyword is registered ONCE, not twelve times", () => {
  const registry = defaultCardRegistry();
  const huntCards = registry.all().filter((def) => (def.text ?? "").includes("[Hunt"));

  it("all 13 TEXT-printing cards are served by the one key", () => {
    // Twelve from UNL, which brought the keyword, plus **one from VEN**
    // (2026-08-16) — the keyword is registered per KEYWORD in `triggers.ts`
    // (`HUNT_TRIGGER_KEY`), so a new set's card is served with no new code.
    //
    // A further card carries it on its ART — UNL-096 Hunter's Machete, an
    // Equipment — and is deliberately not counted here, because this sweep is
    // over `def.text` and the art is exactly what that cannot see. Its own test
    // is below.
    expect(huntCards).toHaveLength(13);
    expect(eventTriggerDefIds()).toContain(HUNT_TRIGGER_KEY);
    // And NONE of them has an entry of its own — the thing that would silently
    // reintroduce twelve copies of one rule.
    for (const def of huntCards) {
      expect(eventTriggerDefIds(), `${def.id} (${def.name}) has its own Hunt entry`).not.toContain(def.id + "-hunt");
    }
  });

  it("works for a unit built from the KEYWORD alone, with no real defId", () => {
    // The proof that the dispatch is by keyword and not by a card name that
    // happens to be registered. A synthetic unit carrying `{Hunt: 2}` and a
    // defId nothing knows about must still pay.
    const state = makeState();
    state.battlefields[0]!.units = {
      [state.players[0]!.id]: [makeUnit({ defId: "ZZZ-001", name: "Synthetic Hunter", keywords: { Hunt: 2 } })],
    };
    expect(conquer(state).players[0]!.xp).toBe(2);
  });

  it("reads the magnitude off the keyword, so an unprinted value changes the payout", () => {
    // Same synthetic subject at a different N. If the resolver had a constant
    // baked in, every test above would still pass — they each use a card whose
    // printed N matches what the test expects.
    const state = makeState();
    state.battlefields[0]!.units = {
      [state.players[0]!.id]: [makeUnit({ defId: "ZZZ-002", name: "Synthetic Hunter 7", keywords: { Hunt: 7 } })],
    };
    expect(conquer(state).players[0]!.xp).toBe(7);
  });
});

describe("[Hunt] granted by an Equipment, which no text measurement can see", () => {
  const HUNTERS_MACHETE = "UNL-096";

  it("the wearer Hunts, at the Machete's granted value", () => {
    // **The thirteenth Hunt card, and it is on the ART.** UNL-096 Hunter's
    // Machete prints `[HUNT] (When I conquer or hold, gain 1 XP.)` in the band
    // where an Equipment's granted keywords are drawn; its `text.plain` says
    // nothing about it, which is why the card is invisible to every sweep in the
    // repo and why the first draft of this keyword excluded it by construction.
    //
    // The unit carries no Hunt of its own, so a payout here can only have come
    // through the attachment.
    const state = makeState();
    const wearer = makeUnit({ defId: "ZZZ-100", name: "Bare Wearer" });
    state.battlefields[0]!.units = { [state.players[0]!.id]: [wearer] };
    state.players[0]!.activeGear = [
      { ...realGearInstance(HUNTERS_MACHETE), attachedToInstanceId: wearer.instanceId },
    ];
    expect(conquer(state).players[0]!.xp).toBe(1);
  });

  it("and stops Hunting the moment it is unattached", () => {
    // The half that proves it is read fresh rather than stamped onto the unit —
    // the same property `equipmentKeywordsFor` is written for, and the reason
    // the key is derived with STATE instead of from the card instance.
    const state = makeState();
    const wearer = makeUnit({ defId: "ZZZ-101", name: "Bare Wearer" });
    state.battlefields[0]!.units = { [state.players[0]!.id]: [wearer] };
    state.players[0]!.activeGear = [{ ...realGearInstance(HUNTERS_MACHETE), attachedToInstanceId: null }];
    expect(conquer(state).players[0]!.xp).toBe(0);
  });
});

describe("coverage now tells the truth about [Hunt]", () => {
  const registry = defaultCardRegistry();

  it("no card is flagged as missing [Hunt] any more", () => {
    const flagged = registry.all().filter((def) => unimplementedKeywordsOn(def).includes("Hunt"));
    expect(flagged.map((d) => d.id)).toEqual([]);
  });

  it("finishes the one card whose whole text was the keyword", () => {
    // Voracious Gromp prints `[Hunt 3]` and its reminder and nothing else, so
    // deleting the UNIMPLEMENTED_KEYWORDS entry finished him outright. He is the
    // positive control on that deletion: if the keyword were still flagged, the
    // bracket would survive `implementableText` and he would report unwritten.
    const gromp = registry.get(VORACIOUS_GROMP);
    expect(needsImplementation(gromp)).toBe(false);
    expect(isCardImplemented(gromp)).toBe(true);
  });

  it("does NOT claim the eleven that print more than the keyword", () => {
    // The over-report direction, and the one coverage.ts calls the worse one.
    //
    // **The premise here was WRONG, not merely stale, and it was inverted on
    // 2026-08-10.** It said Master Yi - Tempered's `[Level 6]` clause was
    // unwritten. It had been written since 2026-08-09 as a `CONDITIONAL_GRANTS`
    // row — what was missing was `grantedKeywordDefIds()` CLAIMING that table, so
    // he worked in every game and reported unimplemented. `deck-generator` seats
    // on `isCardImplemented`, so he could never reach a generated deck and
    // `reachability` could never see him.
    //
    // He still has text beyond `[Hunt]` — that is the half this test is really
    // about, and it is unchanged. What moved is that a module now claims it.
    const yi = registry.get(MASTER_YI_TEMPERED);
    expect(needsImplementation(yi), "his text became keyword-only — the premise moved again").toBe(true);
    expect(isCardImplemented(yi), "he reports unimplemented again — granted-keywords stopped claiming its table").toBe(true);
  });
});
