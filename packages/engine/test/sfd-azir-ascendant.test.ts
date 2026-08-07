import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { resolveMode } from "../src/engine/activated-abilities.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance } from "./fixtures.js";

/**
 * Azir - Ascendant's SECOND clause — "if it's equipped, **you may attach one of
 * its Equipment to me**".
 *
 * His swap has worked for a while; this half was the partial note, and the note
 * was right about the mechanism: "you may attach one of its Equipment" is a
 * second OPTIONAL choice, and this engine chooses targets at announce time, so it
 * needed an axis on the ACTIVATION rather than a line in the resolver.
 *
 * # Why it is a NEW axis rather than a value of `attachesEquipment`
 *
 * The direction is reversed. `attachesEquipment` picks an Equipment to attach TO
 * the chosen unit; this picks one already ON the chosen unit and moves it to the
 * SOURCE. Sharing the field would have made every existing reader wrong about
 * which permanent ends up wearing what.
 *
 * # The two halves most likely to be got wrong
 *
 *  - **The decline has to be enumerated.** "You may" stays refusable even when a
 *    legal Equipment exists — and a target wearing nothing must still be a legal
 *    swap, or the card would become uncastable against a bare unit.
 *  - **The gear must be worn by the CHOSEN unit**, not merely be some friendly
 *    Equipment. A hand-built action naming an unrelated one is refused.
 */

const registry = defaultCardRegistry();
const AZIR_ASCENDANT = "SFD-050";
const DORANS_BLADE = "SFD-095";

const runes = (n: number, domain: RuneCard["domain"] = "Calm"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

/**
 * Azir at bf1, a friendly partner at bf2, and a Doran's Blade either worn by the
 * partner or lying detached.
 */
function board(opts: { wornByPartner?: boolean } = {}): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields.find((b) => b.id === "bf1")!.units = {
    p1: [{ ...realUnitInstance(AZIR_ASCENDANT), instanceId: "azir" }],
  };
  state.battlefields.find((b) => b.id === "bf2")!.units = { p1: [makeUnit({ instanceId: "partner", name: "Partner" })] };
  state.players[0]!.activeGear = [
    {
      ...realGearInstance(DORANS_BLADE),
      instanceId: "blade",
      attachedToInstanceId: opts.wornByPartner === false ? null : "partner",
    },
  ];
  state.players[0]!.channeled = runes(3);
  return state;
}

/** Every Azir activation the enumerator offers. */
const azirOffers = (state: GameState): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === "azir",
  );

describe("Azir - Ascendant's attach axis", () => {
  it("offers BOTH the plain swap and the swap-plus-attach", () => {
    const offers = azirOffers(board());

    expect(
      offers.some((a) => a.targetUnitInstanceId === "partner" && a.targetPermanentInstanceId === undefined),
      "the decline variant was not offered — 'you may' became mandatory",
    ).toBe(true);
    expect(
      offers.some((a) => a.targetUnitInstanceId === "partner" && a.targetPermanentInstanceId === "blade"),
      "the attach variant was not offered",
    ).toBe(true);
  });

  /** A partner wearing nothing must still be a legal swap. */
  it("still offers the swap against an unequipped unit", () => {
    const offers = azirOffers(board({ wornByPartner: false }));

    expect(offers.length, "the swap became unavailable against a bare unit").toBeGreaterThan(0);
    expect(
      offers.every((a) => a.targetPermanentInstanceId === undefined),
      "a detached Equipment was offered as if worn",
    ).toBe(true);
  });

  it("validates every variant it offers", () => {
    const state = board();
    const offers = azirOffers(state);
    expect(offers.length, "nothing offered to check").toBeGreaterThan(0);

    for (const offer of offers) {
      const result = validateActivateAbility(state, offer);
      expect(result.ok, `an offered activation was refused: ${"error" in result ? result.error : ""}`).toBe(true);
    }
  });

  it("refuses an Equipment the chosen unit is not wearing", () => {
    const state = board({ wornByPartner: false });
    const offer = azirOffers(state)[0]!;
    const illegal: ActivateAbilityAction = { ...offer, targetUnitInstanceId: "partner", targetPermanentInstanceId: "blade" };

    expect(validateActivateAbility(state, illegal).ok, "a detached Equipment validated as worn").toBe(false);
  });
});

describe("Azir - Ascendant resolves both halves", () => {
  const resolve = (state: GameState, permanentId?: string): GameState => {
    const mode = resolveMode(AZIR_ASCENDANT, { defId: AZIR_ASCENDANT } as never, "swap")!;
    return mode.resolve!(
      state,
      { casterIndex: 0, opponentIndex: 1 } as never,
      { targetUnitInstanceId: "partner", ...(permanentId ? { targetPermanentInstanceId: permanentId } : {}) } as never,
      "azir",
    );
  };

  const locationOf = (state: GameState, instanceId: string): string | undefined =>
    state.battlefields.find((b) => (b.units["p1"] ?? []).some((u) => u.instanceId === instanceId))?.id;

  it("swaps places and moves the Equipment onto Azir", () => {
    const after = resolve(board(), "blade");

    expect(locationOf(after, "azir"), "Azir did not take the partner's place").toBe("bf2");
    expect(locationOf(after, "partner"), "the partner did not take Azir's place").toBe("bf1");
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "the Equipment did not move to Azir").toBe("azir");
  });

  /** Declining is a real option: the swap happens and the gear stays put. */
  it("swaps and leaves the Equipment alone when declined", () => {
    const after = resolve(board());

    expect(locationOf(after, "azir"), "the swap did not happen without the attach").toBe("bf2");
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "the Equipment moved without being named").toBe("partner");
  });
});

describe("Azir - Ascendant's coverage", () => {
  it("is claimed by a module and its partial note is gone", () => {
    expect(isCardImplemented(registry.get(AZIR_ASCENDANT)), "SFD-050 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(AZIR_ASCENDANT)), "the note outlived its clause").toBeUndefined();
  });
});
