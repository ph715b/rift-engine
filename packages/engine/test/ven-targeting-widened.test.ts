import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { SHADOW_CLONE_TOKEN_DEF_ID } from "../src/engine/constants.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { readyPermanent } from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **Two VEN targeting divergences, closed together because they are the same
 * mistake pointing opposite ways.**
 *
 *   VEN-153 Ambessa - Matriarch of War — "Ready a unit", offered FRIENDLY only
 *   VEN-112 Zed, Without a Sound        — "a Shadow Clone you control", offered
 *                                         to EVERY friendly unit
 *
 * One withheld a legal target, the other offered an illegal one. Both were
 * recorded in `docs/rules-conformance.md`, and in both cases the stated blocker
 * turned out not to bind:
 *
 *  - Ambessa's said `readyPermanent` only reaches the acting player's units.
 *    True of the helper, and a fact about the helper rather than about the card:
 *    `readyUnit` underneath it always handled any owner correctly, including the
 *    Mageseeker Warden's lock, which it asks about the UNIT'S OWNER — so my
 *    Warden stops me readying their unit, in the right direction.
 *  - Zed's said "a Shadow Clone you control" needs a token-identity axis on
 *    `TargetingSpec`. `NAMED_UNIT_NARROWINGS` is the escape hatch that already
 *    existed for a condition too card-specific to be an axis, and Decree of
 *    Focus (VEN-040) had been using it since 2026-08-17.
 *
 * **The Zed change surfaced a live gap of its own**, pinned at the bottom of this
 * file: `validate-activate-ability` filtered on `exhaustedOnly` and
 * `attackingOnly` but NOT on `narrowing`, while `legal-actions` did. That is the
 * enumerator/validator split `card-effects.ts` calls this codebase's most-
 * repeated bug — latent only because no ABILITY carried a narrowing until now.
 */

const AMBESSA = "VEN-153";
const ZED_SILENT = "VEN-112";
const registry = defaultCardRegistry();

describe("the cards are what this file thinks they are", () => {
  it("print the two clauses, with no owner on Ambessa's", () => {
    const ambessa = registry.get(AMBESSA);
    const zed = registry.get(ZED_SILENT);
    expect(ambessa.name).toBe("Ambessa - Matriarch of War");
    expect(zed.name).toBe("Zed, Without a Sound");
    const aText = "text" in ambessa ? String(ambessa.text) : "";
    const zText = "text" in zed ? String(zed.text) : "";
    // **The whole basis of widening her.** A printing that added "friendly"
    // would make the old narrowing correct and this file's premise wrong.
    expect(aText.toLowerCase(), "her text now names an owner").not.toContain("friendly unit");
    expect(aText, "the ready clause has changed").toContain("Ready a unit");
    expect(zText, "the Shadow Clone clause has changed").toContain("Shadow Clone");
  });
});

describe("VEN-153 Ambessa: 'Ready a unit' means ANY unit", () => {
  it("her targeting names no owner", () => {
    // Read off the registry rather than the board, because this is the assertion
    // that the divergence is closed at its source.
    const targeting = activatedAbilityFor(AMBESSA)?.targeting;
    // Thrown rather than returned early: an `if (!targeting) return` would make
    // every assertion below vanish silently the day her entry is restructured,
    // which is the vacuous-test shape this repo keeps rediscovering.
    if (targeting === undefined) throw new Error("Ambessa's ability has no targeting spec at all");
    expect(targeting.kind).toBe("unit");
    expect(
      "owner" in targeting ? targeting.owner : undefined,
      "her targeting is still narrowed to one side",
    ).toBeUndefined();
    // The two narrowings her text DOES carry stay: "Ready" implies exhausted, and
    // "a unit" is any location.
    expect("exhaustedOnly" in targeting ? targeting.exhaustedOnly : undefined).toBe(true);
  });

  it("readyPermanent readies an ENEMY unit — the helper half", () => {
    // The behavioural half, driven through the helper the ability calls. Before
    // this change an enemy unit fell through to the gear/Legend branch and
    // nothing happened at all.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p2: [makeUnit({ instanceId: "theirs", name: "Theirs", exhausted: true })] },
    };
    const after = readyPermanent(state, 0, "theirs");
    const them = (after.battlefields[0]!.units.p2 ?? []).find((u) => u.instanceId === "theirs");
    expect(them?.exhausted, "an enemy unit was named and stayed exhausted").toBe(false);
  });

  it("still readies a FRIENDLY unit — the control", () => {
    // Widening must not have swapped one narrowing for another.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [makeUnit({ instanceId: "mine", name: "Mine", exhausted: true })] },
    };
    const after = readyPermanent(state, 0, "mine");
    expect(
      (after.battlefields[0]!.units.p1 ?? []).find((u) => u.instanceId === "mine")?.exhausted,
      "a friendly unit stopped being readyable",
    ).toBe(false);
  });

  it("leaves a READY unit alone — 'Ready' has nothing to do", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p2: [makeUnit({ instanceId: "theirs", name: "Theirs", exhausted: false })] },
    };
    // No crash, no change — `readyUnit` returns the state untouched.
    expect(readyPermanent(state, 0, "theirs")).toBeDefined();
  });
});

describe("VEN-112 Zed: only a Shadow Clone is OFFERED", () => {
  /** Zed on the board with a Clone and an ordinary friendly unit beside him. */
  function zedBoard(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: {
        p1: [
          { ...makeUnit({ instanceId: "zed", name: "Zed, Without a Sound" }), defId: ZED_SILENT },
          { ...makeUnit({ instanceId: "clone", name: "Shadow Clone" }), defId: SHADOW_CLONE_TOKEN_DEF_ID, isToken: true },
          makeUnit({ instanceId: "ordinary", name: "Ordinary" }),
        ],
      },
    };
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      domain: (["Chaos", "Fury", "Calm", "Mind"] as const)[i % 4]!,
      state: "Ready" as const,
    }));
    return state;
  }

  const swaps = (state: GameState) =>
    legalActions(state).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === "zed",
    );

  it("offers the swap naming the Clone", () => {
    const offered = swaps(zedBoard());
    expect(offered.length, "the ability was not offered at all — this test measures nothing").toBeGreaterThan(0);
    expect(
      offered.some((a) => a.targetUnitInstanceId === "clone"),
      "the Clone was not offered as a target",
    ).toBe(true);
  });

  it("does NOT offer an ordinary friendly unit", () => {
    // The divergence: the ability used to enumerate every friendly unit and the
    // resolver quietly did nothing. 355.9.b and 355.8 put the refusal at the
    // OFFER — an ineligible unit must never be presented.
    expect(
      swaps(zedBoard()).filter((a) => a.targetUnitInstanceId === "ordinary"),
      "an ordinary unit was offered as a Shadow Clone",
    ).toHaveLength(0);
  });

  it("does not offer ZED HIMSELF", () => {
    expect(
      swaps(zedBoard()).filter((a) => a.targetUnitInstanceId === "zed"),
      "Zed was offered as his own swap target",
    ).toHaveLength(0);
  });

  it("does not offer the OPPONENT's Shadow Clone — 'you control'", () => {
    // Ownership is `owner: "friendly"` on the spec, deliberately left out of the
    // narrowing so each does one job. This proves the pair still composes.
    const state = zedBoard();
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      units: {
        p2: [{ ...makeUnit({ instanceId: "theirs", name: "Shadow Clone" }), defId: SHADOW_CLONE_TOKEN_DEF_ID, isToken: true }],
      },
    };
    expect(
      swaps(state).filter((a) => a.targetUnitInstanceId === "theirs"),
      "an enemy Shadow Clone was offered",
    ).toHaveLength(0);
  });
});

describe("the ENUMERATOR and the VALIDATOR agree about a narrowing", () => {
  it("every offered swap is accepted", () => {
    const state = (() => {
      const s = makeState({ phase: "Action", activePlayerIndex: 0 });
      s.battlefields[0] = {
        ...s.battlefields[0]!,
        units: {
          p1: [
            { ...makeUnit({ instanceId: "zed", name: "Zed, Without a Sound" }), defId: ZED_SILENT },
            { ...makeUnit({ instanceId: "clone", name: "Shadow Clone" }), defId: SHADOW_CLONE_TOKEN_DEF_ID, isToken: true },
            makeUnit({ instanceId: "ordinary", name: "Ordinary" }),
          ],
        },
      };
      s.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
        id: `r${i}`,
        domain: (["Chaos", "Fury", "Calm", "Mind"] as const)[i % 4]!,
        state: "Ready" as const,
      }));
      return s;
    })();

    const offered = legalActions(state).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === "zed",
    );
    expect(offered.length, "nothing was offered, so this proves nothing").toBeGreaterThan(0);
    for (const action of offered) {
      expect(validateActivateAbility(state, action).ok, `an offered swap was refused: ${action.targetUnitInstanceId}`).toBe(
        true,
      );
    }

    // **The half that was broken.** `validate-activate-ability` applied
    // `exhaustedOnly` and `attackingOnly` but not `narrowing`, so a hand-built
    // action naming a unit the enumerator never offered was ACCEPTED. Latent
    // until this card, because Decree of Focus is a spell.
    const forged: ActivateAbilityAction = { ...offered[0]!, targetUnitInstanceId: "ordinary" };
    const refused = validateActivateAbility(state, forged);
    expect(refused.ok, "a hand-built swap naming an ordinary unit was accepted").toBe(false);
    expect(refused.ok === false && refused.error, "refused for the wrong reason").toContain("not a legal target");
  });
});
