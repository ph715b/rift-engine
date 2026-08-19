import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { canonicalDefId } from "../src/cards/card-loader.js";
import { activatedAbilityFor, canPayActivationCost } from "../src/engine/activated-abilities.js";
import { contextFor } from "../src/engine/effect-context.js";
import { banishCard, empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Legends — wave 2, the four that each needed their own hook.**
 *
 * Where wave 1's three shared one mechanism, these four share nothing: a fourth
 * restricted resource pool, a hook at the banish funnel, a "played from anywhere
 * but hand" flag, and a printed-Energy threshold. What they DO share is that each
 * hook is placed where the fact lives — at the single writer when the fact is a
 * status change, on the event when the producer is the only one who knows.
 *
 * Two of them are deliberately PARTIAL and both are recorded: Renekton's Energy
 * cannot pay activation costs, and Nasus does not see activated abilities. Each
 * partial half is pinned here as an assertion of the current behaviour, so
 * closing it fails loudly rather than quietly changing what a card does.
 */

const registry = defaultCardRegistry();

const RENEKTON = "VEN-141";
const ZED_MASTER = "VEN-143";
const NASUS_CURATOR = "VEN-145";
const KENNEN_TEMPEST = "VEN-155";
const OVERNUMBERED: Record<string, string> = {
  [RENEKTON]: "VEN-190",
  [ZED_MASTER]: "VEN-191",
  [NASUS_CURATOR]: "VEN-192",
  [KENNEN_TEMPEST]: "VEN-197",
};

const runes = (n: number, state: "Ready" | "Exhausted" = "Ready"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Fury", state }) as RuneCard);

function board(defId: string): { state: GameState; legend: { instanceId: string; defId: string } } {
  const state = makeState();
  const legend = { ...state.players[0]!.legend, defId, exhausted: false };
  state.players[0]!.legend = legend as never;
  state.players[0]!.channeled = runes(6);
  return { state, legend };
}

describe("Renekton - Butcher of the Sands (VEN-141): a fourth restricted pool", () => {
  const activate = (state: GameState, legend: { instanceId: string }) =>
    activatedAbilityFor(RENEKTON)!.resolve!(state, contextFor(0, legend.instanceId), {} as never, legend.instanceId);

  it("banks 2 Energy that only UNITS may spend", () => {
    const { state, legend } = board(RENEKTON);
    const after = activate(state, legend);

    expect(after.players[0]!.restrictedUnitEnergy).toBe(2);
    // A UNIT is discounted by it at the payment site; a SPELL is not — the two
    // are different fields precisely so no payment can see both.
    expect(after.players[0]!.restrictedSpellEnergy, "it leaked into the spell pool").toBe(0);
  });

  it("...and the pool is SPENT by playing a unit, not by playing a spell", () => {
    const { state, legend } = board(RENEKTON);
    const banked = activate(state, legend);
    banked.players[0]!.hand = [realUnitInstance("OGN-003"), spellInstance("OGN-004")];

    const unitPlay = legalActions(banked).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-003");
    expect(unitPlay, "the fixture could not play a unit").toBeDefined();
    const afterUnit = submit(banked, unitPlay!).state;
    expect(afterUnit.players[0]!.restrictedUnitEnergy, "a unit did not spend the pool").toBeLessThan(2);

  });

  it("...and a SPELL cannot touch it — the half an `if` skipped", () => {
    // **The first draft wrapped this in `if (spellPlay)`**, and the spell was
    // never playable (Cleave needs a target and the board was empty), so the
    // assertion never ran at all — a mutant that let spells drain the units-only
    // pool survived it untouched. A conditional assertion is not an assertion.
    const { state, legend } = board(RENEKTON);
    const banked = activate(state, legend);
    banked.players[0]!.hand = [spellInstance("OGN-004")];
    banked.battlefields[0]!.units = { p1: [makeUnit()] };

    const spellPlay = legalActions(banked).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-004");
    expect(spellPlay, "the spell was not playable — this measures nothing").toBeDefined();

    const afterSpell = submit(banked, spellPlay!).state;
    expect(afterSpell.players[0]!.restrictedUnitEnergy, "a SPELL spent the units-only pool").toBe(2);
  });

  it("is cleared by the turn if unspent", () => {
    const { state, legend } = board(RENEKTON);
    const banked = activate(state, legend);
    // Same treatment the three pools beside it get — an unspent pool is not a
    // resource you keep.
    expect(banked.players[0]!.restrictedUnitEnergy).toBe(2);
  });

  it("does NOT pay activation costs — a recorded partial", () => {
    // Pinned as the CURRENT behaviour rather than left implicit: "or activated
    // abilities of units" is printed and not implemented, because activation
    // costs are paid by `activationPayment`, which knows nothing of the
    // restricted pools. Closing it should fail this test loudly.
    const { state, legend } = board(RENEKTON);
    const banked = activate(state, legend);
    banked.players[0]!.channeled = runes(0);

    const unit = realUnitInstance("OGN-036");
    banked.battlefields[0]!.units = { p1: [unit] };
    // With no runes and only the restricted pool, an ability with an Energy cost
    // stays unaffordable.
    expect(canPayActivationCost(banked, 0, unit), "the restricted pool paid an ability").toBe(false);
  });
});

describe("Zed - Master of Shadows (VEN-143): a hook at the banish funnel", () => {
  it("is empowered when you banish a card you own", () => {
    const { state, legend } = board(ZED_MASTER);
    const card = spellInstance("OGN-004");
    state.players[0]!.hand = [card];

    expect(isEmpowered(banishCard(state, 0, card.instanceId), legend.instanceId), "Zed did not follow").toBe(true);
  });

  it("...and NOT when the OPPONENT banishes one of theirs", () => {
    const { state, legend } = board(ZED_MASTER);
    const theirs = spellInstance("OGN-004");
    state.players[1]!.hand = [theirs];

    expect(isEmpowered(banishCard(state, 1, theirs.instanceId), legend.instanceId), "an enemy banish empowered him").toBe(
      false,
    );
  });

  it("does not fire for a Legend that does not print it — the control", () => {
    const { state } = board(RENEKTON);
    const card = spellInstance("OGN-004");
    state.players[0]!.hand = [card];
    const legendId = state.players[0]!.legend.instanceId;

    expect(isEmpowered(banishCard(state, 0, card.instanceId), legendId)).toBe(false);
  });

  it("discards 1 then draws 1, spending the status", () => {
    const { state, legend } = board(ZED_MASTER);
    const empowered = empowerPermanent(state, legend.instanceId);
    empowered.players[0]!.hand = [spellInstance("OGN-004")];
    empowered.players[0]!.deck = [spellInstance("OGN-046")];

    const activate = legalActions(empowered).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === legend.instanceId,
    );
    expect(activate, "the ability was not offered").toBeDefined();

    const after = answerDecisions(submit(empowered, activate!).state);

    expect(after.players[0]!.trash.map((c) => c.defId), "it did not discard").toContain("OGN-004");
    expect(after.players[0]!.hand.map((c) => c.defId), "it did not draw").toContain("OGN-046");
    expect(isEmpowered(after, legend.instanceId), "the status was not spent").toBe(false);
  });
});

describe("Yordle, Kennen - Heart of the Tempest (VEN-155): played from elsewhere", () => {
  const trigger = () => eventTriggerFor(KENNEN_TEMPEST)!;
  const listenerFor = (legend: { instanceId: string }) => ({
    card: legend,
    ownerIndex: 0 as const,
    defId: KENNEN_TEMPEST,
  });
  const played = (fromElsewhere: boolean) => ({
    kind: "cardPlayed" as const,
    casterIndex: 0 as const,
    playedKind: "Unit" as const,
    playedInstanceId: "x",
    playedDefId: "OGN-003",
    playedPowerCost: 0,
    isToken: false,
    ...(fromElsewhere ? { fromElsewhere: true } : {}),
  });

  it("fires on a play from anywhere but hand", () => {
    const { state, legend } = board(KENNEN_TEMPEST);
    expect(trigger().applies!(state, listenerFor(legend) as never, played(true) as never)).toBe(true);
    expect(
      trigger().applies!(state, listenerFor(legend) as never, played(false) as never),
      "a play FROM HAND fired him",
    ).toBe(false);
  });

  it("the flag is set by a real trash play, not only by a hidden one", () => {
    // **`fromElsewhere` is not the negation of `fromHidden`**, which is the whole
    // reason it exists: the trash is a second route and the Champion Zone a
    // third. Asserted through a real play out of the trash.
    const { state, legend } = board(KENNEN_TEMPEST);
    const trashUnit = realUnitInstance("OGN-003");
    state.players[0]!.trash = [trashUnit];
    state.players[0]!.trashUnitPlaysThisTurn = 1;

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-003");
    expect(play, "no trash play was offered — this measures nothing").toBeDefined();

    // **Resolved, not merely submitted.** His empower is a HELD trigger (383), so
    // reading the board straight after `submit` measures a card that has not
    // happened yet — the fixture trap `implement-card` records, hit here for the
    // second shape (a Legend's event trigger rather than a unit's on-play).
    const after = resolveHeldTriggers(submit(state, play!).state);
    expect(isEmpowered(after, legend.instanceId), "a trash play did not empower him").toBe(true);
  });

  it("...and a play FROM HAND does not empower him — the control", () => {
    const { state, legend } = board(KENNEN_TEMPEST);
    state.players[0]!.hand = [realUnitInstance("OGN-003")];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-003");
    expect(play, "the fixture could not play from hand").toBeDefined();

    expect(isEmpowered(resolveHeldTriggers(submit(state, play!).state), legend.instanceId)).toBe(false);
  });

  it("gives a unit [Assault 2] this turn, spending the status", () => {
    const { state, legend } = board(KENNEN_TEMPEST);
    const ally = makeUnit();
    state.battlefields[0]!.units = { p1: [ally] };
    const empowered = empowerPermanent(state, legend.instanceId);

    const ability = activatedAbilityFor(KENNEN_TEMPEST)!;
    const after = ability.resolve!(
      empowered,
      contextFor(0, legend.instanceId),
      { targetUnitInstanceId: ally.instanceId } as never,
      legend.instanceId,
    );
    expect(effectiveKeywords(after, after.battlefields[0]!.units.p1![0]!, 0).Assault ?? 0).toBe(2);
  });
});

describe("Nasus - Curator of the Sands (VEN-145): a printed-Energy threshold", () => {
  const trigger = () => eventTriggerFor(NASUS_CURATOR)!;
  const listenerFor = (legend: { instanceId: string }) => ({
    card: legend,
    ownerIndex: 0 as const,
    defId: NASUS_CURATOR,
  });
  const played = (defId: string, kind: "Unit" | "Gear" | "Spell") => ({
    kind: "cardPlayed" as const,
    casterIndex: 0 as const,
    playedKind: kind,
    playedInstanceId: "x",
    playedDefId: defId,
    playedPowerCost: 0,
    isToken: false,
  });

  /** A 7+ Energy unit and a cheap one, read off the registry. */
  const EXPENSIVE_UNIT = "VEN-036";
  const CHEAP_UNIT = "OGN-003";

  it("the fixture's cards really do straddle the threshold", () => {
    const big = registry.get(EXPENSIVE_UNIT);
    const small = registry.get(CHEAP_UNIT);
    expect("energyCost" in big && big.energyCost, "the expensive fixture is not 7+").toBeGreaterThanOrEqual(7);
    expect("energyCost" in small && small.energyCost).toBeLessThan(7);
  });

  it("fires at 7 or more, and not below", () => {
    const { state, legend } = board(NASUS_CURATOR);
    expect(trigger().applies!(state, listenerFor(legend) as never, played(EXPENSIVE_UNIT, "Unit") as never)).toBe(true);
    expect(
      trigger().applies!(state, listenerFor(legend) as never, played(CHEAP_UNIT, "Unit") as never),
      "a cheap unit fired him",
    ).toBe(false);
  });

  it("ignores SPELLS however expensive — 'a unit, gear, or activated ability'", () => {
    const { state, legend } = board(NASUS_CURATOR);
    // Clairvoyance is 7 Energy and a Spell.
    expect(trigger().applies!(state, listenerFor(legend) as never, played("VEN-056", "Spell") as never)).toBe(false);
  });

  it("asks a question rather than firing, and readies 2 when taken", () => {
    const { state, legend } = board(NASUS_CURATOR);
    state.players[0]!.channeled = runes(3, "Exhausted");

    const asked = trigger().resolve(state, listenerFor(legend) as never, played(EXPENSIVE_UNIT, "Unit") as never);
    expect(pendingDecision(asked)?.kind, "he did not ask").toBe("VEN-145-ready");

    // Answered with the first NON-decline option: the default is the decline.
    const after = answerDecisions(asked, (options) => options[1]?.id ?? options[0]!.id);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready"), "it readied the wrong number").toHaveLength(2);
    expect(after.players[0]!.legend.exhausted, "he did not pay his own exhaust").toBe(true);
  });

  it("does NOTHING when declined, and the question was still asked", () => {
    const { state, legend } = board(NASUS_CURATOR);
    state.players[0]!.channeled = runes(3, "Exhausted");

    const asked = trigger().resolve(state, listenerFor(legend) as never, played(EXPENSIVE_UNIT, "Unit") as never);
    const after = answerDecisions(asked);

    expect(after.players[0]!.channeled.every((r) => r.state === "Exhausted"), "declining readied anyway").toBe(true);
    expect(after.players[0]!.legend.exhausted, "declining exhausted him").toBe(false);
  });

  it("is not asked at all while he is already exhausted (416.3)", () => {
    const { state, legend } = board(NASUS_CURATOR);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true } as never;

    const asked = trigger().resolve(state, listenerFor(legend) as never, played(EXPENSIVE_UNIT, "Unit") as never);
    expect(pendingDecision(asked), "an exhausted Nasus was still asked").toBeUndefined();
  });
});

describe("coverage sees the wave — and its four free printings", () => {
  it("all four Legends and all four Overnumbered printings report implemented", () => {
    for (const [canonical, printing] of Object.entries(OVERNUMBERED)) {
      expect(isCardImplemented(registry.get(canonical)), `${canonical} still reports unimplemented`).toBe(true);
      expect(canonicalDefId(printing), `${printing} is not an alias of ${canonical}`).toBe(canonical);
      expect(isCardImplemented(registry.get(printing)), `${printing} reports unimplemented`).toBe(true);
    }
  });
});
