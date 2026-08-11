import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * `[Ambush]` — **822.1.b**: "I may be played to a battlefield where you control
 * Units" and "I have [Reaction] AS LONG AS I'm being played to a battlefield
 * where you control Units."
 *
 * # The half that was missing, and the half that never was
 *
 * The PLACEMENT permission needed nothing. The ordinary reinforce rule already
 * lets a Unit into a battlefield where its controller has units — measured before
 * anything was written: `legal-actions`' reinforce loop gates on `hasPresence`,
 * which is that sentence verbatim.
 *
 * The TIMING was the whole gap, and it is **conditional on the destination**. The
 * tier is Reaction at one battlefield and Default at another, on the same board
 * in the same instant, so it cannot be a property of the card — which is all
 * `timingTierOf` can answer. Same shape as a modal card whose targeting depends
 * on the chosen mode.
 *
 * The enumerator gated the whole card on timing BEFORE any destination was known,
 * so all twelve Ambush units were dropped outright in a Showdown — the only state
 * the keyword exists for.
 *
 * # Why the enumerate/validate pairing is asserted here
 *
 * A destination-dependent permission is exactly the shape that has produced four
 * offered-then-refused crashes in this engine, every one found by a probe rather
 * than by a test. So each case below checks the validator against the
 * enumerator's own action, and one case forges an illegal action to prove the
 * validator enforces the rule independently rather than merely agreeing.
 */

const registry = defaultCardRegistry();
const CHAKRAM_DANCER = "UNL-071"; // 3 Energy, 0 Power, [Ambush]
const PLAIN_UNIT = "OGN-002"; // no [Ambush] — the control

const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/**
 * A Showdown running at bf1. `garrisonAt` is where the caster already has a unit
 * — the battlefield Ambush should unlock, and nowhere else.
 */
function showdown(cardDefId: string, garrisonAt: "bf1" | "bf2" | null): { state: GameState; card: UnitInstance } {
  const card = unit(cardDefId);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [card];
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Fury: 9, Calm: 9, Mind: 9, Body: 9, Chaos: 9, Order: 9 };
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    contestedByIndex: 0,
    units: { p2: [makeUnit({ name: "Defender" })] },
  };
  state.turnState = "Showdown";
  state.showdownKind = "Combat";
  state.showdownBattlefieldId = "bf1";
  state.focusHolder = 0;
  if (garrisonAt !== null) {
    const index = garrisonAt === "bf1" ? 0 : 1;
    const bf = state.battlefields[index]!;
    state.battlefields[index] = { ...bf, units: { ...bf.units, p1: [makeUnit({ name: "Garrison" })] } };
  }
  return { state, card };
}

const playsOf = (state: GameState, card: UnitInstance): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId);

const destinationsOf = (state: GameState, card: UnitInstance): string[] =>
  playsOf(state, card).map((a) => a.destinationBattlefieldId ?? "base");

describe("[Ambush] gives Reaction timing INTO a battlefield you have units at", () => {
  it("can be played during a Showdown, to the battlefield the caster garrisons", () => {
    const { state, card } = showdown(CHAKRAM_DANCER, "bf2");
    expect(destinationsOf(state, card), "the Ambush unit was dropped entirely in a Showdown").toContain("bf2");
  });

  it("but NOT to a battlefield where the caster has nobody", () => {
    // The permission is per destination. Offering bf1 here would let the card
    // walk into a fight it has no business joining.
    const { state, card } = showdown(CHAKRAM_DANCER, "bf2");
    expect(destinationsOf(state, card), "Ambush unlocked a battlefield with no friendly units").not.toContain("bf1");
  });

  it("and NOT to base — 822.1.b says 'to a battlefield'", () => {
    // The load-bearing negative: a card that survived the card-level gate only
    // because SOME battlefield qualifies must not get a base play out of it.
    const { state, card } = showdown(CHAKRAM_DANCER, "bf2");
    expect(destinationsOf(state, card), "Ambush granted a base play at Reaction speed").not.toContain("base");
  });

  it("offers NOTHING when the caster garrisons no battlefield at all", () => {
    // Control on the fixture: with no garrison anywhere the keyword grants
    // nothing and the card is a plain Default-tier unit in a Showdown.
    const { state, card } = showdown(CHAKRAM_DANCER, null);
    expect(playsOf(state, card), "Ambush fired with no units anywhere").toHaveLength(0);
  });

  it("a unit WITHOUT [Ambush] is still barred from the Showdown — the control", () => {
    // Without this, "the Ambush card is offered" would pass on a build that had
    // simply stopped checking timing at all.
    const { state, card } = showdown(PLAIN_UNIT, "bf2");
    expect(playsOf(state, card), "a plain unit was offered during a Showdown").toHaveLength(0);
  });

  it("every enumerated Ambush play is ACCEPTED by the validator", () => {
    const { state, card } = showdown(CHAKRAM_DANCER, "bf2");
    const plays = playsOf(state, card);

    expect(plays.length, "nothing was enumerated — this asserts nothing").toBeGreaterThan(0);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);
    }
  });

  it("and the validator REFUSES a forged play into an ungarrisoned battlefield", () => {
    // The other direction: the validator must enforce the rule itself, not merely
    // agree with whatever the enumerator produced.
    const { state, card } = showdown(CHAKRAM_DANCER, "bf2");
    const legal = playsOf(state, card)[0]!;
    const forged: PlayCardAction = { ...legal, destinationBattlefieldId: "bf1" };

    const verdict = validatePlayCard(state, forged);
    expect(verdict.ok, "the validator allowed an Ambush into a battlefield with no friendly units").toBe(false);
  });

  it("outside a Showdown the card plays normally", () => {
    // Ambush ADDS a permission and must not remove the ordinary one.
    const card = unit(CHAKRAM_DANCER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 20;

    expect(destinationsOf(state, card), "the ordinary base play disappeared").toContain("base");
  });
});

describe("the keyword no longer greys any card", () => {
  it("twelve cards print it, and none is still blamed on it", () => {
    const printed = registry.all().filter((d) => (d.text ?? "").includes("[Ambush]"));
    expect(printed.length, "the sweep found the wrong number — the pattern drifted").toBe(12);

    // Not all twelve report finished: several carry a SECOND gap of their own.
    // The claim is only that [Ambush] itself is no longer the reason.
    //
    // **Asked of the DERIVED keyword list, not of the prose.** This used to
    // substring-search `partialImplementationNote` for "[Ambush]", and it went red
    // on 2026-08-10 the moment a hand-written note for UNL-060 mentioned the
    // keyword in passing — "the hold-draw works and [Ambush] is the loader's" — to
    // say the opposite of what the test read it as saying. `unimplementedKeywordsOn`
    // is the actual question ("is this card greyed BECAUSE of the keyword") and it
    // cannot be moved by how a neighbouring sentence is worded.
    const blamed = printed.filter((d) => unimplementedKeywordsOn(d).includes("Ambush"));
    expect(blamed.map((d) => d.id), "a card is still greyed by [Ambush]").toEqual([]);
  });
});
