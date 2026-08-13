import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { mayPlaceWithoutPresence } from "../src/engine/unit-triggers.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { optionalUnitCostOf } from "../src/engine/card-effects.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Stalking Wolf (UNL-166) — three clauses, three mechanisms.**
 *
 * "[Ambush] As an additional cost to play me, kill a Bird, Cat, Dog, or Poro you
 * control. You may play me to its battlefield (even if you don't have other
 * units there)."
 *
 *   - `[Ambush]` grants Reaction TIMING into a battlefield where you DO have
 *     units (822.1.b) — already worked before this card was written.
 *   - the additional cost names TAGS, which needed `UnitCostSpec.candidate`.
 *   - the destination clause waives the presence requirement, but only for the
 *     battlefield the sacrificed unit was standing on.
 *
 * The last two pull in opposite directions — one lets him land where he has
 * nobody, the other is about where he does — and that is why they are separate
 * mechanisms rather than one gate.
 *
 * # The waiver is per-VARIANT, which is what makes it novel
 *
 * Every other `PLACEMENT_GRANTS` entry asks a question about the battlefield:
 * is it open, is an enemy standing on it, am I attacking it. Those are the same
 * answer for every way of playing the card. This one is not — the SAME
 * battlefield qualifies under the variant that eats the Poro standing there and
 * not under the variant that eats the Dog in base. So `mayPlaceWithoutPresence`
 * takes the cost unit, and both callers hand it the choice riding on the action
 * they are judging.
 *
 * # What the wave-6 refusal predicted, and what actually enforces it
 *
 * That pin warned: "a mandatory additional cost is enforced by the card being
 * UNPLAYABLE (204.2.a), and a Unit that has already arrived cannot be un-played.
 * A resolution-time kill would leave a Wolf played with no pet costing nothing
 * at all." That is correct, and it is why the `mandatory` flag — not the
 * `resolve` — is what enforces the cost: with no eligible pet he is never
 * offered and never validated, so the resolve is only ever reached on a play
 * that already named its price. The first test here is that assertion.
 */

const registry = defaultCardRegistry();
const WOLF = "UNL-166";
/** His four acceptable meals, and one tag that is none of them. */
const PET_TAGS = ["Bird", "Cat", "Dog", "Poro"];
const NOT_A_PET_TAG = "Demacia";

function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

const castsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const pet = (instanceId: string, tag: string): UnitInstance =>
  makeUnit({ instanceId, name: `${tag} friend`, tags: [tag], might: 2 });

/** Player 0 holding a Wolf with the resources to cast him. */
function wolfInHand(): { state: GameState; wolf: UnitInstance } {
  const wolf = realUnitInstance(WOLF);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [wolf];
  state.players[0]!.channeled = runesFor(WOLF);
  state.players[0]!.floatingEnergy = 10;
  return { state, wolf };
}

/** Puts `units` on p1's side of the battlefield at `index`. */
function seat(state: GameState, index: number, units: UnitInstance[]): void {
  state.battlefields[index] = {
    ...state.battlefields[index]!,
    units: { ...state.battlefields[index]!.units, p1: units },
  };
}

describe("the cost: a Bird, Cat, Dog, or Poro you control", () => {
  it("is not offered AT ALL with no pet to eat — 204.2.a, and the wave-6 pin's warning", () => {
    // The assertion that replaced the refusal. Before the cost was registered he
    // was castable for free, which is strictly stronger than printed.
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("notapet", NOT_A_PET_TAG)];

    expect(castsOf(state, wolf.instanceId), "he was playable with nothing to sacrifice").toEqual([]);
  });

  it("accepts each of the four tags", () => {
    // One test per tag would pass with three of the four hardcoded; this fails
    // unless every one of them is in the list.
    for (const tag of PET_TAGS) {
      const { state, wolf } = wolfInHand();
      state.players[0]!.baseUnits = [pet(`pet-${tag}`, tag)];

      const chosen = castsOf(state, wolf.instanceId).map((a) => a.additionalCostUnitInstanceId);
      expect(new Set(chosen), `${tag} was not accepted as a meal`).toEqual(new Set([`pet-${tag}`]));
    }
  });

  it("offers one variant per pet and ignores the non-pets beside them", () => {
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("poro", "Poro"), pet("notapet", NOT_A_PET_TAG), pet("cat", "Cat")];

    const chosen = new Set(castsOf(state, wolf.instanceId).map((a) => a.additionalCostUnitInstanceId));
    expect(chosen, "the wrong units were offered as his price").toEqual(new Set(["poro", "cat"]));
  });

  it("does not eat the OPPONENT's pets", () => {
    // "A Bird, Cat, Dog, or Poro YOU CONTROL". The candidate runs after the
    // kind's own friendly-only filter, so this proves the two compose.
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("mine", NOT_A_PET_TAG)];
    state.players[1]!.baseUnits = [pet("theirs", "Poro")];

    expect(castsOf(state, wolf.instanceId), "he ate an enemy Poro").toEqual([]);
  });

  it("actually kills the chosen pet when he resolves", () => {
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("poro", "Poro")];

    const action = castsOf(state, wolf.instanceId)[0]!;
    const { state: played, result } = submit(state, action);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    // He is a Unit, so his on-play trigger is HELD on the Chain (383) — the kill
    // is that trigger resolving, not part of `submit`. Reading the board straight
    // after submitting measured a cost that had not been charged yet.
    const after = resolveHeldTriggers(played);
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === "poro"), "the price was never paid").toBe(false);
    expect(after.players[0]!.trash.length, "the pet did not reach the trash").toBeGreaterThan(0);
  });
});

describe("the destination: 'its battlefield, even if you don't have other units there'", () => {
  /**
   * **The waiver is INERT in play today, and that was measured, not assumed.**
   *
   * Removing `PLACEMENT_GRANTS["UNL-166"]` entirely leaves every test in this
   * file green. The reason is the cost-timing divergence recorded in
   * docs/rules-conformance.md against all seven unit-valued additional costs:
   * 204 pays an additional cost as the card is PLAYED, and this engine pays it
   * inside the card's own `resolve`. So at the moment the Wolf is placed his meal
   * is still standing there — and a unit he controls at that battlefield IS
   * presence, which is the ordinary rule and needs no waiver.
   *
   * Under the rules-correct ordering the meal is already dead, he has nobody
   * there, and the clause is the only thing making the play legal. That is
   * exactly what its reminder text says, and it is why the clause is printed at
   * all.
   *
   * **The observable behaviour is the same either way** — he can follow his meal
   * — so the card is not half-written; the two paths just arrive at the same
   * answer. The grant is kept because it becomes load-bearing the moment the
   * timing is fixed, and because deleting it would mean re-deriving this whole
   * analysis then.
   *
   * The NEGATIVE cases below are reachable and do real work: a location-blind
   * waiver turns them red. The POSITIVE case is asserted on the predicate
   * directly, since no legal play can reach it.
   */
  it("he can follow his meal onto a battlefield holding nothing else of his", () => {
    // True today via the meal's own presence, true tomorrow via the waiver. The
    // assertion is on the behaviour, which does not change between them.
    const { state, wolf } = wolfInHand();
    const poro = pet("poro", "Poro");
    seat(state, 0, [poro]); // bf1: the Poro alone — no OTHER unit of his

    const toBf1 = castsOf(state, wolf.instanceId).filter((a) => a.destinationBattlefieldId === state.battlefields[0]!.id);
    expect(toBf1.length, "he could not follow his meal").toBeGreaterThan(0);
    for (const action of toBf1) {
      expect(action.additionalCostUnitInstanceId, "he reached that battlefield while eating something else").toBe(
        poro.instanceId,
      );
    }
  });

  it("the waiver itself says yes only for the meal's own battlefield — asked directly", () => {
    // `mayPlaceWithoutPresence` is only ever CALLED when presence is absent, and
    // no legal play can produce that state for this card while the meal is alive.
    // So the predicate is exercised as a function, which is honest about what is
    // being checked and is the only thing that can catch the grant rotting.
    const { state } = wolfInHand();
    const poro = pet("poro", "Poro");
    seat(state, 0, [poro]);

    expect(
      mayPlaceWithoutPresence(state, 0, WOLF, state.battlefields[0]!, poro.instanceId),
      "the waiver refused the meal's own battlefield",
    ).toBe(true);
    expect(
      mayPlaceWithoutPresence(state, 0, WOLF, state.battlefields[1]!, poro.instanceId),
      "the waiver widened to a battlefield the meal never stood on",
    ).toBe(false);
    expect(
      mayPlaceWithoutPresence(state, 0, WOLF, state.battlefields[0]!, undefined),
      "the waiver applied with no meal named at all",
    ).toBe(false);
    // The OPPONENT's unit standing at bf1 must not open it either, even though
    // it is a unit at the right battlefield.
    const theirs = pet("theirs", "Poro");
    state.battlefields[0] = { ...state.battlefields[0]!, units: { ...state.battlefields[0]!.units, p2: [theirs] } };
    expect(
      mayPlaceWithoutPresence(state, 0, WOLF, state.battlefields[0]!, theirs.instanceId),
      "an enemy unit's battlefield opened the waiver",
    ).toBe(false);
  });

  it("...but NOT onto a different battlefield where he has nobody", () => {
    // The waiver is keyed to the meal's location, not a blanket "ignore
    // presence". bf2 is empty of his units and holds no pet.
    const { state, wolf } = wolfInHand();
    seat(state, 0, [pet("poro", "Poro")]);

    const bf2 = state.battlefields[1]!.id;
    const toBf2 = castsOf(state, wolf.instanceId).filter((a) => a.destinationBattlefieldId === bf2);
    expect(toBf2, "he landed on a battlefield unrelated to his meal").toEqual([]);
  });

  it("a pet in BASE widens nothing — a base is not a battlefield", () => {
    // The case a naive "find the pet's location" would get wrong by returning
    // the base and matching it against every battlefield, or by throwing.
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("poro", "Poro")];

    const toBattlefields = castsOf(state, wolf.instanceId).filter((a) => a.destinationBattlefieldId !== undefined);
    expect(toBattlefields, "eating a pet in base let him land at a battlefield he has no presence at").toEqual([]);

    // ...and he is still perfectly playable to base, so the card is not broken by
    // the restriction — only the destination is.
    expect(castsOf(state, wolf.instanceId).length, "he became uncastable entirely").toBeGreaterThan(0);
  });

  it("still reinforces a battlefield where he DOES have units, whatever he eats", () => {
    // The ordinary presence rule must survive the waiver: this destination is
    // legal because he has a unit there, not because his meal is there.
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("poro", "Poro")];
    seat(state, 1, [pet("garrison", NOT_A_PET_TAG)]);

    const bf2 = state.battlefields[1]!.id;
    const toBf2 = castsOf(state, wolf.instanceId).filter((a) => a.destinationBattlefieldId === bf2);
    expect(toBf2.length, "the waiver replaced the ordinary presence rule instead of widening it").toBeGreaterThan(0);
  });
});

describe("the two sides agree — enumerate and validate", () => {
  it("every enumerated Wolf play validates", () => {
    // The offered-then-refused crash, which is how all five of this repo's
    // enumerate/execute mismatches surfaced. The board is built so that all
    // three destination cases are enumerated at once.
    const { state, wolf } = wolfInHand();
    state.players[0]!.baseUnits = [pet("basepet", "Dog")];
    seat(state, 0, [pet("poro", "Poro")]);
    seat(state, 1, [pet("garrison", NOT_A_PET_TAG)]);

    const casts = castsOf(state, wolf.instanceId);
    expect(casts.length, "nothing was enumerated — this test would be vacuous").toBeGreaterThan(2);
    for (const action of casts) {
      expect(validatePlayCard(state, action).ok, `an offered play was refused: ${JSON.stringify(action)}`).toBe(true);
    }
  });

  it("validate REFUSES the destination waiver for a pet standing elsewhere", () => {
    // The forged action only a hand-built submission can reach: eat the pet at
    // bf1, but land at bf2 where he has nobody. Enumeration never offers it, and
    // without the cost unit passed to the validator it would be accepted.
    const { state, wolf } = wolfInHand();
    seat(state, 0, [pet("poro", "Poro")]);

    const legal = castsOf(state, wolf.instanceId).find((a) => a.destinationBattlefieldId === state.battlefields[0]!.id)!;
    const forged: PlayCardAction = { ...legal, destinationBattlefieldId: state.battlefields[1]!.id };

    expect(validatePlayCard(state, forged).ok, "he landed at a battlefield his meal never stood on").toBe(false);
  });
});

describe("coverage", () => {
  it("is whole, with the cost registered and no half-written note", () => {
    expect(isCardImplemented(registry.get(WOLF)), "the Wolf is greyed").toBe(true);
    expect(partialImplementationNote(registry.get(WOLF)), "he still names a missing half").toBeUndefined();
    expect(optionalUnitCostOf(WOLF), "his additional cost is not registered").toMatchObject({
      kind: "killFriendly",
      mandatory: true,
    });
  });

  it("his printed text still says what this file assumes", () => {
    const text = registry.get(WOLF).text ?? "";
    for (const tag of PET_TAGS) {
      expect(text, `he stopped naming ${tag} — the candidate list needs re-reading`).toContain(tag);
    }
    expect(text, "the destination clause changed").toContain("even if you don't have other units there");
  });
});
