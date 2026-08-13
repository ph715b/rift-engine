import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { trashChoiceDiscount } from "../src/engine/cost-modifiers.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { COMPANION_TAGS } from "../src/engine/constants.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Undying Loyalty (UNL-168) — "This costs [2] less if you CHOOSE a Bird, Cat,
 * Dog, or Poro. Play a unit with cost no more than [2] and no more than
 * [rainbow] from your trash, ignoring its cost."**
 *
 * Refused across three waves, and the blocker was never a missing table. A cost
 * has to be known when the card is paid for; this card named its trash unit at
 * RESOLUTION, through a parked question. So the discount could not be priced at
 * all — not because nothing could express it, but because the thing it depends
 * on had not been chosen yet.
 *
 * # The fix was a TIMING move, and it is the rules-correct one
 *
 * 355.4 makes a spell's choices happen when it is finalized, and 355.9.a.4 makes
 * a card in a Public trash a legal target — a trash is public. So the parked
 * question was the divergence and the announce-time target is conformance; the
 * discount falling out of it is a consequence rather than the reason.
 *
 * # The Harrowing deliberately did NOT move with it
 *
 * OGN-198 looks like the same card and is not. It plays the trash unit "paying
 * only its Power cost", and that payment happens at resolution out of the pool
 * as it then stands — it cannot ride the `PlayCardAction` that already paid the
 * spell's own cost. Undying Loyalty plays "IGNORING ITS COST", both halves, so
 * its payment is empty and there was nothing to defer. Spectral Matron (OGN-226)
 * is in the same position as The Harrowing.
 *
 * That difference is the whole reason one card could move and the others could
 * not, and it is asserted below so a later sweep does not "tidy" them together.
 */

const registry = defaultCardRegistry();
const LOYALTY = "UNL-168";
const PRINTED_ENERGY = 2;
const PRINTED_POWER = 1;
const DISCOUNT = 2;
/** The card's printed ceiling on what it may return. */
const MAX_ENERGY = 2;
const MAX_POWER = 1;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** A trash unit at a given cost, with `tags`. */
const trashUnit = (instanceId: string, tags: string[], energyCost = 1, powerCost = 0): UnitInstance =>
  makeUnit({ instanceId, name: `${tags[0] ?? "Plain"}-${instanceId}`, tags, energyCost, powerCost, might: 2 });

function board(trash: UnitInstance[]): { state: GameState; loyalty: { instanceId: string } } {
  const loyalty = spellInstance(LOYALTY);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [loyalty];
  state.players[0]!.trash = trash;
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`o${i}`, "Order"));
  return { state, loyalty };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const priceOf = (a: PlayCardAction) => ({
  energy: a.payment.energyRunes.length,
  power: a.payment.powerRunes.length,
});

const forChoice = (plays: PlayCardAction[], id: string): PlayCardAction =>
  plays.find((a) => a.trashCardInstanceId === id)!;

describe("the trash unit is now named at ANNOUNCE, as a target", () => {
  it("fans out one variant per eligible trash unit", () => {
    const poro = trashUnit("poro", ["Poro"]);
    const plain = trashUnit("plain", ["Demacia"]);
    const { state, loyalty } = board([poro, plain]);

    const chosen = playsOf(state, loyalty.instanceId).map((a) => a.trashCardInstanceId);
    expect(new Set(chosen), "the trash unit is not being chosen at announce").toEqual(new Set(["poro", "plain"]));
  });

  it("respects the printed ceiling — 'no more than [2] and no more than [rainbow]'", () => {
    // The reason this card could not use `ownTrashCard` before: the spec carried
    // only `cardKind`, so it would have offered a 10-Energy unit to be played
    // free. Both bounds are checked, and each has a card just over it.
    const ok = trashUnit("ok", ["Poro"], MAX_ENERGY, MAX_POWER);
    const tooExpensive = trashUnit("costly", ["Poro"], MAX_ENERGY + 1, 0);
    const tooPowerful = trashUnit("powerful", ["Poro"], 0, MAX_POWER + 1);
    const { state, loyalty } = board([ok, tooExpensive, tooPowerful]);

    const chosen = playsOf(state, loyalty.instanceId).map((a) => a.trashCardInstanceId);
    expect(new Set(chosen), "a unit above the printed ceiling was offered").toEqual(new Set(["ok"]));
  });

  it("is not castable with an empty trash — it prints 'Play a unit', not 'you may'", () => {
    const { state, loyalty } = board([]);
    expect(playsOf(state, loyalty.instanceId), "he was offered with nothing to return").toEqual([]);
  });
});

describe("the discount is priced off the CHOICE", () => {
  it("costs 2 less when the chosen unit is one of the four tags", () => {
    for (const tag of COMPANION_TAGS) {
      const pet = trashUnit(`pet-${tag}`, [tag]);
      const { state, loyalty } = board([pet]);
      const play = forChoice(playsOf(state, loyalty.instanceId), `pet-${tag}`);

      expect(priceOf(play), `${tag} did not buy the discount`).toEqual({
        energy: PRINTED_ENERGY - DISCOUNT,
        power: PRINTED_POWER,
      });
    }
  });

  it("costs the printed price when the chosen unit is none of them", () => {
    // The control that makes the discount a measurement. Both variants exist on
    // ONE board, so this is about the choice and not about the fixture.
    const poro = trashUnit("poro", ["Poro"]);
    const plain = trashUnit("plain", ["Demacia"]);
    const { state, loyalty } = board([poro, plain]);
    const plays = playsOf(state, loyalty.instanceId);

    expect(priceOf(forChoice(plays, "poro")), "the tagged choice was not discounted").toEqual({
      energy: PRINTED_ENERGY - DISCOUNT,
      power: PRINTED_POWER,
    });
    expect(priceOf(forChoice(plays, "plain")), "an untagged choice was discounted anyway").toEqual({
      energy: PRINTED_ENERGY,
      power: PRINTED_POWER,
    });
  });

  it("takes the discount off ENERGY only — the rainbow pip still has to be paid", () => {
    // "[2] less" names Energy. A discount applied to the whole cost would make
    // the card free, and the Power assertion above is what catches it — restated
    // here on its own so the failure message says which half moved.
    const poro = trashUnit("poro", ["Poro"]);
    const { state, loyalty } = board([poro]);

    expect(priceOf(forChoice(playsOf(state, loyalty.instanceId), "poro")).power, "the Power pip was discounted").toBe(
      PRINTED_POWER,
    );
  });

  it("a unit carrying one of the tags among several still qualifies", () => {
    const mixed = trashUnit("mixed", ["Freljord", "Dog"]);
    const { state, loyalty } = board([mixed]);

    expect(priceOf(forChoice(playsOf(state, loyalty.instanceId), "mixed")).energy, "a second tag hid the first").toBe(
      PRINTED_ENERGY - DISCOUNT,
    );
  });
});

describe("the two pricing sites agree", () => {
  it("every enumerated variant validates at the price it was offered", () => {
    const { state, loyalty } = board([trashUnit("poro", ["Poro"]), trashUnit("plain", ["Demacia"])]);
    const plays = playsOf(state, loyalty.instanceId);

    expect(plays.length, "nothing was enumerated — this test would be vacuous").toBe(2);
    for (const play of plays) {
      expect(validatePlayCard(state, play).ok, `an offered variant was refused: ${JSON.stringify(play)}`).toBe(true);
    }
  });

  it("the validator REFUSES a discounted price paid for an untagged choice", () => {
    // Only reachable by hand: take the cheap variant and repoint it at the plain
    // unit. Without the validator computing the discount itself, this succeeds.
    const { state, loyalty } = board([trashUnit("poro", ["Poro"]), trashUnit("plain", ["Demacia"])]);
    const plays = playsOf(state, loyalty.instanceId);
    const forged: PlayCardAction = { ...forChoice(plays, "poro"), trashCardInstanceId: "plain" };

    expect(validatePlayCard(state, forged).ok, "an untagged choice bought the discount").toBe(false);
  });

  it("the validator REFUSES a choice above the printed ceiling", () => {
    // The other half of the widened spec. A ceiling enforced only by the
    // enumerator would let a hand-built action play anything in the trash free.
    const { state, loyalty } = board([trashUnit("ok", ["Poro"]), trashUnit("huge", ["Poro"], 9, 0)]);
    const plays = playsOf(state, loyalty.instanceId);
    const forged: PlayCardAction = { ...forChoice(plays, "ok"), trashCardInstanceId: "huge" };

    expect(validatePlayCard(state, forged).ok, "a unit above the ceiling was accepted").toBe(false);
  });
});

describe("it still does the thing it always did", () => {
  it("plays the chosen unit out of the trash", () => {
    const poro = trashUnit("poro", ["Poro"]);
    const { state, loyalty } = board([poro]);

    const { state: played, result } = submit(state, forChoice(playsOf(state, loyalty.instanceId), "poro"));
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const after = resolveHeldTriggers(played);

    expect(after.players[0]!.trash.some((c) => c.instanceId === "poro"), "it stayed in the trash").toBe(false);
    const inPlay = [
      ...after.players[0]!.baseUnits,
      ...after.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
    ];
    expect(inPlay.some((u) => u.instanceId === "poro"), "the unit never reached the board").toBe(true);
  });
});

describe("the discount function, and the cards that did NOT move", () => {
  it("is Undying Loyalty's alone and needs a choice", () => {
    const { state } = board([trashUnit("poro", ["Poro"])]);

    expect(trashChoiceDiscount(state, 0, LOYALTY, "poro")).toEqual({ energy: DISCOUNT, power: 0 });
    expect(trashChoiceDiscount(state, 0, LOYALTY, undefined), "it discounted with nothing chosen").toEqual({
      energy: 0,
      power: 0,
    });
    expect(trashChoiceDiscount(state, 0, "OGN-198", "poro"), "The Harrowing got this discount").toEqual({
      energy: 0,
      power: 0,
    });
  });

  it("the two neighbours still choose at RESOLUTION, for two DIFFERENT reasons", () => {
    // **This test was wrong when first written** — it asserted both stayed put
    // because they pay the returned unit's Power cost, and that is true of only
    // one of them. Getting it right matters, because "why can this card not move"
    // is the question a later tidy-up sweep will ask.
    //
    // The Harrowing (OGN-198) is a SPELL, so 355.4 would put its choice at
    // announce like Undying Loyalty's. What stops it is the payment: it plays the
    // unit "ignoring its Energy cost. (You must still pay its Power cost.)", and
    // that Power is paid at resolution out of the pool as it then stands. It
    // cannot ride the action that already paid the spell's own cost.
    const harrowing = registry.get("OGN-198");
    expect(harrowing.type, "The Harrowing stopped being a Spell").toBe("Spell");
    expect(harrowing.text ?? "", "it stopped paying the returned unit's Power cost").toMatch(/must still pay its Power/);

    // Spectral Matron (OGN-226) plays "ignoring its cost" exactly as Undying
    // Loyalty does, so the payment argument does NOT apply to her. She stays a
    // decision because she is a UNIT: her choice belongs to a triggered ability
    // on the chain, not to a spell being finalized, which is the separate
    // held-trigger divergence and not this one.
    const matron = registry.get("OGN-226");
    expect(matron.type, "Spectral Matron stopped being a Unit — her reason would change").toBe("Unit");
    expect(matron.text ?? "", "she stopped ignoring the whole cost").toContain("ignoring its cost");

    expect(registry.get(LOYALTY).text ?? "", "Undying Loyalty stopped ignoring the whole cost").toContain(
      "ignoring its cost",
    );
  });
});

describe("coverage", () => {
  it("is whole, claimed by both modules, and no longer half-written", () => {
    expect(isCardImplemented(registry.get(LOYALTY)), "Undying Loyalty is greyed").toBe(true);
    expect(partialImplementationNote(registry.get(LOYALTY)), "it still names a missing half").toBeUndefined();

    const modules = implementingModules(LOYALTY);
    expect(modules, "the free play stopped being claimed").toContain("card-effects");
    expect(modules, "the discount stopped being claimed").toContain("cost-modifiers");
  });

  it("its printed numbers still match the constants here", () => {
    const def = registry.get(LOYALTY) as { energyCost: number; powerCost: number; text?: string };
    expect(def.energyCost).toBe(PRINTED_ENERGY);
    expect(def.powerCost).toBe(PRINTED_POWER);
    for (const tag of COMPANION_TAGS) {
      expect(def.text ?? "", `it stopped naming ${tag}`).toContain(tag);
    }
  });
});
