import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { addBuff } from "../src/engine/effect-helpers.js";
import { acceleratePowerDomain, hasAccelerate } from "../src/engine/timing.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Additional costs paid AS YOU PLAY a card — rule 805's `[Accelerate]` and the
 * per-card ones.
 *
 * The distinction that shapes all of it is optional vs mandatory. 805 calls
 * Accelerate "an Optional Additional Cost", so declining has to stay available;
 * Cruel Patron's "As an additional cost to play me, kill a friendly unit" has no
 * "you may", so there is no decline and the card is simply unplayable with
 * nothing of yours to kill.
 */

const registry = defaultCardRegistry();
const JINX_DEMOLITIONIST = "OGN-030"; // [Accelerate] 1 Energy + 1 Fury; [Assault 2]; discard 2 on play
const LEE_SIN_CENTERED = "OGN-151"; // [Accelerate] 1 Energy + 1 Body; buffed-neighbour aura
const CRUEL_PATRON = "OGN-208"; // mandatory: kill a friendly unit
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

function caster(card: UnitInstance, domain: Domain, runes: number, extra: Partial<GameState> = {}): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [card],
        deck: [makeUnit(), makeUnit(), makeUnit()],
        channeled: Array.from({ length: runes }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
    ...extra,
  });
}

const playsOf = (state: GameState, card: UnitInstance) =>
  legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);

describe("[Accelerate] is an OPTIONAL additional cost (rule 805)", () => {
  it("offers both a plain and an accelerated candidate", () => {
    const jinx = unit(JINX_DEMOLITIONIST);
    const plays = playsOf(caster(jinx, "Fury", 10), jinx);

    const accelerated = plays.filter((a) => a.type === "PlayCard" && a.acceleratePaid);
    const plain = plays.filter((a) => a.type === "PlayCard" && !a.acceleratePaid);
    expect(plain.length).toBeGreaterThan(0); // declining stays available...
    expect(accelerated.length).toBeGreaterThan(0); // ...alongside paying
  });

  it("the accelerated candidate costs exactly 1 Energy and 1 Power more", () => {
    const jinx = unit(JINX_DEMOLITIONIST); // 3 Energy + 1 Power
    const plays = playsOf(caster(jinx, "Fury", 10), jinx);
    const plain = plays.find((a) => a.type === "PlayCard" && !a.acceleratePaid)!;
    const fast = plays.find((a) => a.type === "PlayCard" && a.acceleratePaid)!;

    expect(plain.type === "PlayCard" && plain.payment.energyRunes.length).toBe(3);
    expect(fast.type === "PlayCard" && fast.payment.energyRunes.length).toBe(4);
    expect(fast.type === "PlayCard" && fast.payment.powerRunes.length).toBe(2);
  });

  it("paying it makes the unit enter READY; declining leaves it exhausted", () => {
    const jinx = unit(JINX_DEMOLITIONIST);
    const state = caster(jinx, "Fury", 10);
    const plays = playsOf(state, jinx);

    const declined = executePlayCard(state, plays.find((a) => a.type === "PlayCard" && !a.acceleratePaid)! as never);
    const paid = executePlayCard(state, plays.find((a) => a.type === "PlayCard" && a.acceleratePaid)! as never);

    const jinxIn = (s: GameState) => s.players[0]!.baseUnits.find((u) => u.defId === JINX_DEMOLITIONIST)!;
    expect(jinxIn(declined).exhausted).toBe(true); // 143.4.a's default
    expect(jinxIn(paid).exhausted).toBe(false); // "if you do, I enter ready"
  });

  it("is not offered when the bigger payment is unaffordable, but the plain one still is", () => {
    // 3 Ready runes exactly cover 3 Energy + 1 Power, because a Ready rune spent
    // on Power still counts toward Energy in the same payment ("double duty").
    // That is also why 4 runes would NOT have proved anything here — they cover
    // the accelerated 4 Energy + 2 Power the same way.
    const jinx = unit(JINX_DEMOLITIONIST);
    const plays = playsOf(caster(jinx, "Fury", 3), jinx);
    expect(plays.some((a) => a.type === "PlayCard" && !a.acceleratePaid)).toBe(true);
    expect(plays.some((a) => a.type === "PlayCard" && a.acceleratePaid)).toBe(false);
  });

  it("takes its Power in the UNIT's domain, not its printed pip's", () => {
    // Lee Sin - Centered has NO printed Power cost, so `powerDomain` is null.
    // Reading that would have made his Accelerate rainbow; rule 805 says it must
    // match one of the unit's own domains.
    const leeSin = unit(LEE_SIN_CENTERED);
    expect(leeSin.powerCost).toBe(0);
    expect(leeSin.powerDomain).toBeNull();
    expect(acceleratePowerDomain(leeSin)).toBe("Body");

    const wrongDomain = playsOf(caster(leeSin, "Fury", 12), leeSin);
    expect(wrongDomain.some((a) => a.type === "PlayCard" && a.acceleratePaid)).toBe(false); // Fury can't pay it
    const rightDomain = playsOf(caster(leeSin, "Body", 12), leeSin);
    expect(rightDomain.some((a) => a.type === "PlayCard" && a.acceleratePaid)).toBe(true);
  });

  it("rejects a claim to accelerate on a card without the keyword", () => {
    const plain = unit("OGN-002"); // Brazen Buccaneer, no [Accelerate]
    expect(hasAccelerate(plain)).toBe(false);
    const state = caster(plain, "Chaos", 10);
    const play = playsOf(state, plain)[0]!;
    const forged = { ...play, acceleratePaid: true as const };
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });
});

describe("Cruel Patron (OGN-208): a MANDATORY additional cost", () => {
  it("is not playable at all with no friendly unit to kill", () => {
    const patron = unit(CRUEL_PATRON);
    expect(playsOf(caster(patron, "Order", 10), patron)).toHaveLength(0);
  });

  it("offers no decline variant when it IS payable", () => {
    // The difference from an optional cost: every candidate names a victim.
    const patron = unit(CRUEL_PATRON);
    const state = caster(patron, "Order", 10);
    const victim = makeUnit({ name: "Victim" });
    state.players[0]!.baseUnits = [victim];

    const plays = playsOf(state, patron);

    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId !== undefined)).toBe(true);
  });

  it("kills the named unit when played", () => {
    const patron = unit(CRUEL_PATRON);
    const state = caster(patron, "Order", 10);
    const victim = makeUnit({ name: "Victim" });
    state.players[0]!.baseUnits = [victim];

    const after = resolveHeldTriggers(executePlayCard(state, playsOf(state, patron)[0]! as never));

    expect(after.players[0]!.baseUnits.some((u) => u.name === "Victim")).toBe(false);
    expect(after.players[0]!.trash.map((c) => c.name)).toContain("Victim");
    expect(after.players[0]!.baseUnits.some((u) => u.defId === CRUEL_PATRON)).toBe(true); // and it arrived
  });

  it("is refused when submitted with no victim named", () => {
    const patron = unit(CRUEL_PATRON);
    const state = caster(patron, "Order", 10);
    state.players[0]!.baseUnits = [makeUnit()];
    const play = playsOf(state, patron)[0]!;
    const forged = { ...play, additionalCostUnitInstanceId: undefined };
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });
});

describe("the two Accelerate cards' other printed text", () => {
  it("Jinx - Demolitionist discards 2 when played", () => {
    const jinx = unit(JINX_DEMOLITIONIST);
    const state = caster(jinx, "Fury", 10);
    state.players[0]!.hand = [jinx, makeUnit(), makeUnit(), makeUnit()];

    // Three cards left and "discard 2" — a real choice, so the play stops to ask
    // twice. Which two go is now up to the player; that it is two is not.
    const after = answerDecisions(resolveHeldTriggers(executePlayCard(state, playsOf(state, jinx)[0]! as never)));

    expect(after.players[0]!.hand).toHaveLength(1); // 4 - jinx - 2 discarded
    expect(after.players[0]!.trash).toHaveLength(2);
  });

  it("Lee Sin - Centered gives OTHER buffed friendly units at his battlefield +2", () => {
    const leeSin = unit(LEE_SIN_CENTERED);
    const buffedAlly = makeUnit({ name: "Buffed", might: 3 });
    const plainAlly = makeUnit({ name: "Plain", might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [leeSin, buffedAlly, plainAlly] };
    state = addBuff(state, buffedAlly.instanceId);

    const at = (name: string) => state.battlefields[0]!.units["p1"]!.find((u) => u.name === name)!;
    const ctx = { isCombat: false, battlefieldId: "bf1" } as const;

    expect(effectiveMight(state, at("Buffed"), 0, ctx)).toBe(3 + 1 + 2); // printed + buff + aura
    expect(effectiveMight(state, at("Plain"), 0, ctx)).toBe(3); // unbuffed: nothing
  });

  it("...and not to HIMSELF, nor across battlefields, nor from base", () => {
    const leeSin = unit(LEE_SIN_CENTERED);
    const elsewhere = makeUnit({ name: "Elsewhere", might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [leeSin] };
    state.battlefields[1]!.units = { p1: [elsewhere] };
    state = addBuff(state, leeSin.instanceId);
    state = addBuff(state, elsewhere.instanceId);

    const lee = state.battlefields[0]!.units["p1"]![0]!;
    const far = state.battlefields[1]!.units["p1"]![0]!;
    expect(effectiveMight(state, lee, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(leeSin.might + 1); // "OTHER"
    expect(effectiveMight(state, far, 0, { isCombat: false, battlefieldId: "bf2" })).toBe(4); // "at MY battlefield"

    // In base he reaches nothing — the aura is positional.
    const inBase = makeState();
    inBase.players[0]!.baseUnits = [leeSin];
    const ally = makeUnit({ name: "Ally", might: 3 });
    inBase.battlefields[0]!.units = { p1: [ally] };
    const buffedInBase = addBuff(inBase, ally.instanceId);
    expect(effectiveMight(buffedInBase, buffedInBase.battlefields[0]!.units["p1"]![0]!, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });
});

describe("coverage counts the additional-cost cards", () => {
  it("reports all three as implemented", () => {
    for (const id of [JINX_DEMOLITIONIST, LEE_SIN_CENTERED, CRUEL_PATRON]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
