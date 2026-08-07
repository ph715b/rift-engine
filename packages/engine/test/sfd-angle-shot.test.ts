import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { equipmentPairedWith } from "../src/engine/equipment.js";
import { cardModesOf } from "../src/engine/card-effects.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { createCardInstance, type SpellInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * Angle Shot (SFD-011) — "[Reaction] Choose a unit and an Equipment with the
 * same controller. Attach that Equipment to that unit or detach that Equipment
 * from that unit. Draw 1."
 *
 * # Why this needed a new targeting spec
 *
 * `attachesEquipment` already fans an ACTIVATED ability out over unit x
 * Equipment (Jax - Unmatched, Forge of the Fluft), but it is a field on the
 * ability and the SPELL path fans out from the targeting spec alone —
 * `variantsForTargeting` is handed a `TargetingSpec` and nothing else. So this is
 * a spec kind, `unitAndEquipment`, which also makes the modal path work
 * unchanged: each mode already carries its own targeting.
 *
 * # The two things most likely to be got wrong, both asserted below
 *
 *  - **"With the same controller" is about the two TARGETS, not about you.** An
 *    enemy unit paired with that enemy's Equipment is a legal choice, and Angle
 *    Shot being a `[Reaction]` is what makes stripping one mid-combat the play.
 *  - **The two modes need different candidate sets.** Attaching wants an
 *    Equipment that is NOT on the unit; detaching wants the one that IS. One
 *    spec for both would offer every pair to both jobs and half would resolve to
 *    nothing.
 */

const registry = defaultCardRegistry();
const ANGLE_SHOT = "SFD-011";
const DORANS_BLADE = "SFD-095"; // [Equip] 1 Body, +2 Might — an ordinary Equipment
const ENERGY_CONDUIT = "OGN-098"; // a NON-Equipment gear

const runes = (n: number, domain: RuneCard["domain"] = "Fury"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

/**
 * p1 has a unit at bf1 and p2 has one at bf2, each with a Doran's Blade in their
 * own `activeGear`. `attachTo` links a gear to its owner's unit.
 */
function board(opts: { p1Attached?: boolean; p2Attached?: boolean } = {}): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields.find((b) => b.id === "bf1")!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
  state.battlefields.find((b) => b.id === "bf2")!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
  state.players[0]!.activeGear = [
    { ...realGearInstance(DORANS_BLADE), instanceId: "myGear", attachedToInstanceId: opts.p1Attached ? "mine" : null },
  ];
  state.players[1]!.activeGear = [
    {
      ...realGearInstance(DORANS_BLADE),
      instanceId: "theirGear",
      attachedToInstanceId: opts.p2Attached ? "theirs" : null,
    },
  ];
  state.players[0]!.channeled = runes(4);
  return state;
}

const angleShot = (): SpellInstance => createCardInstance(registry.get(ANGLE_SHOT)) as SpellInstance;

/** Every Angle Shot play the enumerator offers, as (mode, unit, gear) triples. */
function offers(state: GameState): { mode: string; unit: string | undefined; gear: string | undefined }[] {
  return legalActions(state)
    .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === ANGLE_SHOT)
    .map((a) => ({ mode: a.modeId ?? "", unit: a.targetUnitInstanceId, gear: a.targetPermanentInstanceId }));
}

function withAngleShotInHand(state: GameState): GameState {
  const next = { ...state };
  next.players = [...state.players] as GameState["players"];
  next.players[0] = { ...state.players[0]!, hand: [angleShot()] };
  return next;
}

describe("Angle Shot's targeting: a unit and an Equipment with the SAME controller", () => {
  it("pairs a unit only with its own controller's Equipment", () => {
    const state = board();

    expect(
      equipmentPairedWith(state, "mine", "attachable").map((g) => g.instanceId),
      "my unit was not offered my Equipment",
    ).toEqual(["myGear"]);
    // The load-bearing negative — the enemy's gear must never pair with my unit.
    expect(
      equipmentPairedWith(state, "mine", "attachable").map((g) => g.instanceId),
      "an Equipment with a different controller was paired",
    ).not.toContain("theirGear");
  });

  /** "The same controller" is a relationship between the targets, so an ENEMY
   *  pair is legal — this is the half most likely to have been written as
   *  "friendly" by reflex. */
  it("pairs an ENEMY unit with that enemy's Equipment", () => {
    const state = board();
    expect(
      equipmentPairedWith(state, "theirs", "attachable").map((g) => g.instanceId),
      "an enemy pair was refused",
    ).toEqual(["theirGear"]);
  });

  it("offers only a DETACHED-or-elsewhere Equipment to the attach mode", () => {
    // Already on that very unit is the no-op, and must not be offered.
    const attached = board({ p1Attached: true });
    expect(
      equipmentPairedWith(attached, "mine", "attachable"),
      "the Equipment already on the unit was offered for attaching",
    ).toHaveLength(0);
  });

  it("offers only the Equipment ON that unit to the detach mode", () => {
    expect(
      equipmentPairedWith(board({ p1Attached: true }), "mine", "attachedToIt").map((g) => g.instanceId),
    ).toEqual(["myGear"]);
    expect(
      equipmentPairedWith(board({ p1Attached: false }), "mine", "attachedToIt"),
      "a detached Equipment was offered for detaching",
    ).toHaveLength(0);
  });

  /** `[Equip]` is what makes a gear an Equipment; an ordinary gear is not one. */
  it("never pairs a NON-Equipment gear", () => {
    const state = board();
    state.players[0]!.activeGear = [{ ...realGearInstance(ENERGY_CONDUIT), instanceId: "plain", attachedToInstanceId: null }];
    expect(equipmentPairedWith(state, "mine", "attachable"), "a plain gear was offered as Equipment").toHaveLength(0);
  });
});

describe("Angle Shot's enumeration and validation agree", () => {
  it("offers both modes, each with its own candidate pairs", () => {
    // p1's gear is detached (attachable to "mine"), p2's is attached to "theirs"
    // (detachable from it). So each mode has exactly one legal pair.
    const state = withAngleShotInHand(board({ p2Attached: true }));
    const all = offers(state);

    expect(all.some((o) => o.mode === "attach" && o.unit === "mine" && o.gear === "myGear"), "attach pair missing").toBe(true);
    expect(
      all.some((o) => o.mode === "detach" && o.unit === "theirs" && o.gear === "theirGear"),
      "the enemy detach pair was never offered",
    ).toBe(true);
    // And the cross pairs, which share no controller, are absent from both.
    expect(all.some((o) => o.gear === "theirGear" && o.unit === "mine"), "a cross-controller pair was offered").toBe(false);
    expect(all.some((o) => o.gear === "myGear" && o.unit === "theirs"), "a cross-controller pair was offered").toBe(false);
  });

  it("validates every pair it offers", () => {
    const state = withAngleShotInHand(board({ p2Attached: true }));
    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === ANGLE_SHOT,
    );
    expect(plays.length, "nothing was offered to check").toBeGreaterThan(0);

    for (const play of plays) {
      const result = validatePlayCard(state, play);
      expect(result.ok, `an offered play was refused: ${"error" in result ? result.error : ""}`).toBe(true);
    }
  });

  it("refuses a cross-controller pair the enumerator never offered", () => {
    const state = withAngleShotInHand(board());
    const offered = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === ANGLE_SHOT,
    )!;
    // My unit, their Equipment — different controllers.
    const illegal: PlayCardAction = { ...offered, targetUnitInstanceId: "mine", targetPermanentInstanceId: "theirGear" };

    expect(validatePlayCard(state, illegal).ok, "a cross-controller pair validated").toBe(false);
  });

  it("refuses a play naming only one of the two targets", () => {
    const state = withAngleShotInHand(board());
    const offered = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === ANGLE_SHOT,
    )!;
    const { targetPermanentInstanceId: _dropped, ...halfNamed } = offered;

    expect(validatePlayCard(state, halfNamed as PlayCardAction).ok, "half a choice validated").toBe(false);
  });
});

describe("Angle Shot resolves", () => {
  const resolveMode = (state: GameState, modeId: string, unit: string, gear: string): GameState => {
    const mode = cardModesOf(angleShot()).find((m) => m.id === modeId)!;
    return mode.resolve(state, { casterIndex: 0, opponentIndex: 1 }, {
      targetUnitInstanceId: unit,
      targetPermanentInstanceId: gear,
    } as never);
  };

  it("attaches, and draws 1", () => {
    const state = board();
    state.players[0]!.deck = [makeUnit({ instanceId: "top" }) as never];

    const after = resolveMode(state, "attach", "mine", "myGear");

    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "it did not attach").toBe("mine");
    expect(after.players[0]!.hand, "the draw did not happen").toHaveLength(1);
  });

  it("detaches, and draws 1", () => {
    const state = board({ p1Attached: true });
    state.players[0]!.deck = [makeUnit({ instanceId: "top" }) as never];

    const after = resolveMode(state, "detach", "mine", "myGear");

    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "it did not detach").toBeNull();
    expect(after.players[0]!.hand, "the draw did not happen").toHaveLength(1);
  });

  /** The Equipment is written into its CONTROLLER's `activeGear`, so an enemy
   *  pair must move the enemy's gear rather than looking for it in ours. */
  it("detaches an ENEMY's Equipment from the enemy's unit", () => {
    const state = board({ p2Attached: true });
    state.players[0]!.deck = [makeUnit({ instanceId: "top" }) as never];

    const after = resolveMode(state, "detach", "theirs", "theirGear");

    expect(after.players[1]!.activeGear[0]!.attachedToInstanceId, "the enemy Equipment stayed attached").toBeNull();
    expect(after.players[0]!.hand, "the caster did not draw").toHaveLength(1);
  });

  /** The draw is a third sentence, not a rider — it happens on both modes. */
  it("draws on both modes", () => {
    for (const [modeId, attached] of [["attach", false], ["detach", true]] as const) {
      const state = board({ p1Attached: attached });
      state.players[0]!.deck = [makeUnit({ instanceId: "top" }) as never];
      expect(resolveMode(state, modeId, "mine", "myGear").players[0]!.hand, `${modeId} did not draw`).toHaveLength(1);
    }
  });
});

describe("Angle Shot's coverage", () => {
  it("is claimed by a module and carries no partial note", () => {
    expect(isCardImplemented(registry.get(ANGLE_SHOT)), "SFD-011 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(ANGLE_SHOT))).toBeUndefined();
  });
});
