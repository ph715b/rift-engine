import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * `[Deflect N]` — "opponents must pay N rainbow Power to choose me with a spell
 * or ability."
 *
 * The first cost in this engine that depends on WHICH target a play chooses, so
 * it is the first that cannot be priced once per card. Three sites have to agree
 * about it and they are tested together here, because the failure mode when they
 * disagree is not a wrong number — it is `legal-actions` offering a play that
 * `submit` then refuses, which is the shape this codebase has been bitten by
 * twice in one day.
 *
 * Pouty Poro is `[Deflect 1]` and Volibear - Furious is `[Deflect 2]`, so the
 * value is exercised as a parameter rather than assumed to be a flat pip.
 */

const registry = defaultCardRegistry();
const POUTY_PORO = "OGN-013"; // [Deflect 1]
const VOLIBEAR_FURIOUS = "OGN-041"; // [Deflect 2]
const INCINERATE = "OGS-003"; // "Deal 2 to a unit at a battlefield" — 1 Energy, no Power

const runes = (domain: Domain, n: number, prefix = domain): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, domain, state: "Ready" as const }));

/** Player 0 holds Incinerate and enough runes; player 1 holds `defender` at bf1. */
function board(defenderDefId: string, pool: RuneCard[]): { state: GameState; spellId: string; defenderId: string } {
  const spell = spellInstance(INCINERATE);
  const defender = realUnitInstance(defenderDefId);
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { hand: [spell], channeled: pool }), makePlayer("p2")],
  });
  state.battlefields[0]!.units = { p2: [defender] };
  return { state, spellId: spell.instanceId, defenderId: defender.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

describe("[Deflect] is a real surcharge, priced per target", () => {
  it("charges 1 rainbow Power to target a [Deflect 1] unit", () => {
    const { state, spellId, defenderId } = board(POUTY_PORO, runes("Fury", 4));
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId);

    expect(play, "the play was not offered at all").toBeDefined();
    expect(play!.payment.rainbowRunes ?? []).toHaveLength(1);
  });

  it("charges 2 for [Deflect 2] — the value is a parameter, not a flat pip", () => {
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, runes("Fury", 4));
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId);

    expect(play!.payment.rainbowRunes ?? []).toHaveLength(2);
  });

  it("takes runes of ANY domain — rainbow means rainbow", () => {
    // Incinerate's own cost is Energy only, so every rune spent here is spent on
    // the surcharge, and none of them share the spell's (absent) power domain.
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, [...runes("Calm", 2), ...runes("Order", 2)]);
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId);

    expect(play!.payment.rainbowRunes ?? []).toHaveLength(2);
  });

  it("does NOT charge the unit's own controller — 'OPPONENTS must pay'", () => {
    const { state, spellId } = board(POUTY_PORO, runes("Fury", 4));
    // Same card, but now it is player 0's own unit.
    const mine = realUnitInstance(POUTY_PORO);
    state.battlefields[0]!.units = { p1: [mine] };

    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === mine.instanceId);
    expect(play, "targeting your own Deflect unit was not offered").toBeDefined();
    expect(play!.payment.rainbowRunes ?? []).toHaveLength(0);
  });

  it("prices per VARIANT — the same card costs differently per target", () => {
    // The whole point of the restructure. One battlefield, two enemy units, only
    // one of them taxed.
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, runes("Fury", 5));
    const plain = makeUnit({ name: "Plain", might: 3, instanceId: "plain" });
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, plain];

    const taxed = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId);
    const untaxed = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "plain");

    expect(taxed!.payment.rainbowRunes ?? []).toHaveLength(2);
    expect(untaxed!.payment.rainbowRunes ?? []).toHaveLength(0);
  });

  it("withholds only the TAXED variant when the pool cannot cover the surcharge", () => {
    // Incinerate costs 2 Energy, so 3 runes covers it plus ONE more — enough for
    // a [Deflect 1] tax but not Volibear's 2. The untaxed target must still be
    // offered: the card is not unplayable, this target is unaffordable.
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, runes("Fury", 3));
    const plain = makeUnit({ name: "Plain", might: 3, instanceId: "plain" });
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, plain];

    const offered = playsOf(state, spellId).map((p) => p.targetUnitInstanceId);
    expect(offered).toContain("plain");
    expect(offered).not.toContain(defenderId);
  });

  it("the enumerator and the validator agree — every offered play is accepted", () => {
    // The failure this file exists for. An offered-then-refused play is how the
    // Baited Hook bug showed up hours earlier, from the same class of mistake:
    // one side of the pair re-derived a price differently.
    const { state, spellId } = board(VOLIBEAR_FURIOUS, runes("Fury", 5));
    const plays = playsOf(state, spellId);

    expect(plays.length, "nothing was offered — this proves nothing").toBeGreaterThan(0);
    for (const play of plays) {
      expect(validatePlayCard(state, play), `${JSON.stringify(play.targetUnitInstanceId)}`).toMatchObject({ ok: true });
    }
  });

  it("REFUSES a play that names too few rainbow runes", () => {
    // A hand-built action, because `legal-actions` will never produce one — the
    // validator must not be trusting the enumerator.
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, runes("Fury", 5));
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId)!;
    const underpaid = { ...play, payment: { ...play.payment, rainbowRunes: (play.payment.rainbowRunes ?? []).slice(0, 1) } };

    expect(validatePlayCard(state, underpaid)).toMatchObject({ ok: false });
  });

  it("REFUSES a rune that is already paying the card's own cost", () => {
    // One rune cannot pay both its owner's Energy and an opponent's tax. The
    // 164.2 double duty lets a Ready rune make Energy AND Power for its OWNER's
    // cost; it does not make two Powers.
    const { state, spellId, defenderId } = board(POUTY_PORO, runes("Fury", 3));
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId)!;
    const doubled = { ...play, payment: { ...play.payment, rainbowRunes: [...play.payment.energyRunes] } };

    expect(validatePlayCard(state, doubled)).toMatchObject({ ok: false });
  });

  it("actually SPENDS the runes through submit, and banks no floating Energy for them", () => {
    // A rune recycled for the surcharge leaves the pool like any Power payment
    // (416), and unlike a rune recycled for its OWNER's Power it earns no
    // floating-Energy credit — otherwise the tax would partly pay for itself.
    const { state, spellId, defenderId } = board(VOLIBEAR_FURIOUS, runes("Fury", 5));
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === defenderId)!;

    const { state: after, result } = submit(state, play);
    expect(result).toMatchObject({ type: "Ok" });
    // 5 runes: 1 exhausted for Incinerate's Energy (stays), 2 recycled for the tax.
    expect(after.players[0]!.channeled).toHaveLength(3);
    expect(after.players[0]!.runeDeck).toHaveLength(2);
    expect(after.players[0]!.floatingEnergy).toBe(0);
  });

  it("finishes the four cards whose only gap it was", () => {
    for (const id of [POUTY_PORO, "OGN-155", "OGN-161", "OGN-232"]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
    // And NOT the two that carry unwritten text of their own.
    for (const id of [VOLIBEAR_FURIOUS, "OGN-231", "OGN-063"]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(false);
    }
  });
});
