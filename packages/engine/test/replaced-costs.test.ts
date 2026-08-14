import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { replacedCostFor } from "../src/engine/replaced-costs.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * **"You may play me for [Cost]" — rule 356.1.a, the REPLACED base cost.**
 *
 * > "If an ability or instruction allows you to play a card 'for [Cost]',
 * > replace the card's Base Costs with [Cost]."
 *
 * Two cards print it with no effect attached, so the price IS the card:
 *
 *  - **UNL-089 Jhin - Meticulous Killer** — "If you've spent [4] or more to play
 *    a spell this turn, you may play me for [Mind]." From HAND, so the
 *    replacement buys a price and nothing else.
 *  - **UNL-025 Undying Legion** — "[Legion][>] You may play me from your trash
 *    for [3][Fury]." From the TRASH, so it buys a zone as well.
 *
 * # What these tests are built to catch
 *
 * **A replacement is not a discount, and Undying Legion is the proof.** Its
 * trash price is DEARER than its print (3 Energy printed; 3 Energy plus a Fury
 * pip from the trash), so any mechanism built out of subtraction cannot express
 * it — it would come out cheaper than casting from hand, which is the opposite
 * of the card. The assertions below therefore measure the ACTUAL RUNE COUNT of
 * each enumerated variant rather than asking a helper what it thinks the price
 * is: a correct helper wired in wrongly passes every unit test of the helper.
 *
 * **There are THREE cost sites, not two** — `legal-actions`, `validate-play-card`
 * and `execute-play-card`, the last of which re-prices from the raw cost to
 * decide how much FLOATING resource to burn. docs/rules-conformance.md records
 * that shape against Irelia - Graceful: a price applied at two sites of three
 * burns floating resources the play no longer owes, and it was found by an agent
 * rather than by the suite. So the float test below is not a bonus case; it is
 * the only one that reaches the third site.
 *
 * **The two trash permissions must not contaminate each other.** Last Rites
 * grants a full-cost trash play and is CONSUMED by use; Undying Legion's own
 * permission grants a price with the zone and is not. Both can be true at once,
 * and the tests pin both directions: the charge is not burnt by a replaced-cost
 * play, and the printed price is not purchasable in the trash without one.
 */

const registry = defaultCardRegistry();

/** Jhin - Meticulous Killer: 4 Energy, 0 Power printed; [Mind] replaced. */
const JHIN = "UNL-089";
const JHIN_PRINTED_ENERGY = 4;
const JHIN_SPELL_THRESHOLD = 4;

/** Undying Legion: 3 Energy, 0 Power printed; [3][Fury] from the trash. */
const LEGION = "UNL-025";
const LEGION_PRINTED_ENERGY = 3;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** What a variant actually costs, counted in the runes it names. */
const priceOf = (a: PlayCardAction): { energy: number; power: number } => ({
  energy: a.payment.energyRunes.length,
  power: a.payment.powerRunes.length,
});

const printedVariant = (plays: PlayCardAction[]): PlayCardAction | undefined =>
  plays.find((a) => a.replacedCostPaid === undefined);
const replacedVariant = (plays: PlayCardAction[]): PlayCardAction | undefined =>
  plays.find((a) => a.replacedCostPaid === true);

/**
 * A board with `card` wherever the test puts it and a deep pool of runes in
 * `domains`, paid for entirely from CHANNELLED runes — no floating Energy, so
 * the rune count of an enumerated payment IS the price.
 */
function board(domains: RuneCard["domain"][]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.channeled = domains.flatMap((d, di) =>
    Array.from({ length: 12 }, (_, i) => rune(`${d}-${di}-${i}`, d)),
  );
  return state;
}

describe("UNL-089 Jhin - Meticulous Killer — an alternative cost from hand", () => {
  function jhinInHand(spellEnergySpent: number, domains: RuneCard["domain"][] = ["Mind"]): {
    state: GameState;
    jhin: UnitInstance;
  } {
    const jhin = realUnitInstance(JHIN);
    const state = board(domains);
    state.players[0]!.hand = [jhin];
    state.players[0]!.maxSpellEnergySpentThisTurn = spellEnergySpent;
    return { state, jhin };
  }

  it("offers ONLY his printed price before a big enough spell has been cast", () => {
    const { state, jhin } = jhinInHand(0);
    const plays = playsOf(state, jhin.instanceId);

    expect(replacedVariant(plays), "the alternative cost was offered with the condition unmet").toBeUndefined();
    expect(priceOf(printedVariant(plays)!), "his printed price moved").toEqual({
      energy: JHIN_PRINTED_ENERGY,
      power: 0,
    });
  });

  it("offers BOTH prices once a 4-Energy spell has been played", () => {
    // "You MAY play me for [Mind]" — the printed price has to survive, and not
    // because it is ever better. It is a different RESOURCE: a player holding
    // Energy but no Mind rune can afford the print and not the replacement.
    const { state, jhin } = jhinInHand(JHIN_SPELL_THRESHOLD);
    const plays = playsOf(state, jhin.instanceId);

    expect(printedVariant(plays), "the printed price stopped being offered").toBeDefined();
    expect(priceOf(printedVariant(plays)!)).toEqual({ energy: JHIN_PRINTED_ENERGY, power: 0 });
    expect(replacedVariant(plays), "the alternative cost was never offered").toBeDefined();
    expect(priceOf(replacedVariant(plays)!), "the replacement is not [Mind] — 0 Energy, 1 Power").toEqual({
      energy: 0,
      power: 1,
    });
  });

  it("is a MAXIMUM over single spells, so 3 Energy spent does not reach it", () => {
    // The threshold is the card's, and `maxSpellEnergySpentThisTurn` is a
    // maximum rather than a running total precisely so two 2-Energy spells do
    // not add up to it. A `> 3` written as `>= 3` passes the enabled test above
    // and fails only here.
    const { state, jhin } = jhinInHand(JHIN_SPELL_THRESHOLD - 1);
    expect(replacedVariant(playsOf(state, jhin.instanceId)), "the threshold is off by one").toBeUndefined();
  });

  it("demands a MIND rune specifically — the replacement names its own domain", () => {
    // With only Fury channeled the replacement is unpayable, while the printed
    // price (pure Energy, which any domain pays) still is. This is what catches
    // a replacement that carried `card.powerDomain` (null, since Jhin prints no
    // Power) through and so accepted any rune at all.
    const { state, jhin } = jhinInHand(JHIN_SPELL_THRESHOLD, ["Fury"]);
    const plays = playsOf(state, jhin.instanceId);

    expect(printedVariant(plays), "his pure-Energy printed price became unpayable").toBeDefined();
    expect(replacedVariant(plays), "a Fury rune paid a [Mind] pip").toBeUndefined();
  });

  it("actually plays him for one Mind rune, spending no Energy", () => {
    const { state, jhin } = jhinInHand(JHIN_SPELL_THRESHOLD);
    const play = replacedVariant(playsOf(state, jhin.instanceId))!;
    const { state: after, result } = submit(state, play);

    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const onBoard = after.players[0]!.baseUnits.some((u) => u.instanceId === jhin.instanceId);
    expect(onBoard, "he never arrived").toBe(true);
    // Exactly one rune left the ready pool: the Mind pip. Read through the pool
    // rather than through the action, since the action is what we are testing.
    const readyAfter = after.players[0]!.channeled.filter((r) => r.state === "Ready").length;
    const readyBefore = state.players[0]!.channeled.filter((r) => r.state === "Ready").length;
    expect(readyBefore - readyAfter, "the replaced play spent something other than the single pip").toBe(1);
  });

  it("spends FLOATING Mind Power on the replacement, not floating Energy", () => {
    // **The third cost site.** `execute-play-card` re-prices from the raw cost to
    // decide how much floating resource to burn, and a replacement applied only
    // in the enumerator and the validator would deduct floating Energy against
    // his PRINTED 4 — the exact shape recorded against Irelia - Graceful.
    //
    // Banked here: 4 floating Energy (enough to cover his whole printed cost) and
    // 1 floating Mind Power. The replacement owes the pip and nothing else, so
    // the Energy must be untouched.
    const { state, jhin } = jhinInHand(JHIN_SPELL_THRESHOLD);
    state.players[0]!.floatingEnergy = JHIN_PRINTED_ENERGY;
    state.players[0]!.floatingPower = { Mind: 1 };

    const play = replacedVariant(playsOf(state, jhin.instanceId))!;
    expect(priceOf(play), "floating Mind Power did not absorb the replaced pip").toEqual({ energy: 0, power: 0 });

    const { state: after, result } = submit(state, play);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.floatingEnergy, "floating Energy was burnt against the PRINTED cost").toBe(
      JHIN_PRINTED_ENERGY,
    );
    expect(after.players[0]!.floatingPower.Mind ?? 0, "the floating Mind pip was not spent").toBe(0);
  });

  it("refuses a forged claim of the replaced cost when the condition is unmet", () => {
    // The enumerate/validate split, in the direction only a forged action
    // reaches: the flag must not re-price a play the board never offered.
    const { state, jhin } = jhinInHand(0);
    const printed = printedVariant(playsOf(state, jhin.instanceId))!;
    const forged: PlayCardAction = { ...printed, replacedCostPaid: true };

    expect(validatePlayCard(state, forged).ok, "a forged replaced cost was accepted").toBe(false);
  });
});

describe("UNL-025 Undying Legion — a trash play at a DEARER replaced price", () => {
  function legionInTrash(
    cardsPlayedThisTurn: number,
    opts: { trashCharges?: number; domains?: RuneCard["domain"][] } = {},
  ): { state: GameState; legion: UnitInstance } {
    const legion = realUnitInstance(LEGION);
    const state = board(opts.domains ?? ["Fury"]);
    state.players[0]!.trash = [legion];
    state.players[0]!.cardsPlayedThisTurn = cardsPlayedThisTurn;
    state.players[0]!.trashUnitPlaysThisTurn = opts.trashCharges ?? 0;
    return { state, legion };
  }

  it("is not playable from the trash at all until [Legion] is met", () => {
    // 812.1.b.1 — "If you have played another card this turn". Asked at COST
    // time, so "another card" is one card and `cardsPlayedThisTurn` is 0 here.
    const { state, legion } = legionInTrash(0);
    expect(playsOf(state, legion.instanceId), "he was reachable in the trash with [Legion] unmet").toEqual([]);
  });

  it("costs 3 Energy AND a Fury pip from the trash — DEARER than his print", () => {
    // The whole reason this is a replacement rather than a discount. He prints
    // 3 Energy and 0 Power; the trash price ADDS the pip.
    const { state, legion } = legionInTrash(1);
    const plays = playsOf(state, legion.instanceId);

    expect(plays.length, "he was not offered with [Legion] met").toBeGreaterThan(0);
    expect(replacedVariant(plays), "the trash permission was never offered").toBeDefined();
    expect(priceOf(replacedVariant(plays)!), "the trash price lost its Fury pip").toEqual({
      energy: LEGION_PRINTED_ENERGY,
      power: 1,
    });
  });

  it("offers NO printed-price variant from the trash", () => {
    // Without this the permission would sell him for his printed 3 Energy —
    // strictly cheaper in the trash than from hand, which is the opposite of the
    // card. The enumerator half of the split.
    const { state, legion } = legionInTrash(1);
    const plays = playsOf(state, legion.instanceId);

    expect(printedVariant(plays), "a printed-price trash play was offered").toBeUndefined();
  });

  it("REFUSES a forged printed-price trash play", () => {
    // The validator half of the same split. A forged action is the only way to
    // reach it, which is exactly why it needs its own assertion: an enumerator
    // that merely declines to offer something is not a rule.
    //
    // **The forged payment is the PRINTED price exactly** — 3 Energy runes and
    // no pip — and that precision is the whole test. Mutation testing found the
    // first version of it passing for the wrong reason: it reused the replaced
    // variant's payment, which carries the Fury pip, so the validator refused it
    // on a payment-count mismatch and the zone rule was never reached. Deleting
    // the rule left the test green.
    const { state, legion } = legionInTrash(1);
    const replaced = replacedVariant(playsOf(state, legion.instanceId))!;
    const runeIds = state.players[0]!.channeled.slice(0, LEGION_PRINTED_ENERGY).map((r) => r.id);
    const { replacedCostPaid: _dropped, ...rest } = replaced;
    const forged = { ...rest, payment: { energyRunes: runeIds, powerRunes: [] } } as PlayCardAction;

    const verdict = validatePlayCard(state, forged);
    expect(verdict.ok, "the printed price bought a trash play").toBe(false);
  });

  it("REFUSES a forged replaced-cost play paid with the wrong DOMAIN", () => {
    // The validator's per-rune domain loop, which nothing else here reaches.
    //
    // Both cards print `powerCost: 0`, so their printed `powerDomain` is null —
    // and `matchesPowerDomain` reads null as "any domain". A validator still
    // checking the PRINTED domain therefore accepts ANY rune for a replaced pip,
    // and the enumerator-level test above cannot see it: the enumerator simply
    // never offers the variant, while a forged action sails through. Mutation
    // testing found exactly that.
    const { state, legion } = legionInTrash(1, { domains: ["Fury", "Mind"] });
    const valid = replacedVariant(playsOf(state, legion.instanceId))!;
    const mindRune = state.players[0]!.channeled.find((r) => r.domain === "Mind")!;

    // Positive control: the enumerated Fury payment really is accepted, so a
    // refusal below is about the DOMAIN and not about the shape of the forgery.
    expect(validatePlayCard(state, valid).ok, "the honest Fury payment was refused").toBe(true);

    const forged: PlayCardAction = { ...valid, payment: { ...valid.payment, powerRunes: [mindRune.id] } };
    expect(validatePlayCard(state, forged).ok, "a Mind rune paid Undying Legion's [Fury] pip").toBe(false);
  });

  it("still costs his plain printed price from HAND", () => {
    // The permission names the trash, so it must not leak into the ordinary
    // play. 829.1.b.2's ruling on what a replaced cost leaves alone.
    const legion = realUnitInstance(LEGION);
    const state = board(["Fury"]);
    state.players[0]!.hand = [legion];
    state.players[0]!.cardsPlayedThisTurn = 1;
    const plays = playsOf(state, legion.instanceId);

    expect(replacedVariant(plays), "the trash price was offered on a card in hand").toBeUndefined();
    expect(priceOf(printedVariant(plays)!), "his from-hand price changed").toEqual({
      energy: LEGION_PRINTED_ENERGY,
      power: 0,
    });
  });

  it("does NOT burn a banked Last Rites charge", () => {
    // Both trash permissions are true at once here. The player took Undying
    // Legion's own, so the charge — which buys a FULL-COST play of some other
    // unit — must survive. Nothing else in the suite distinguishes the two, and
    // the executor decrements on a predicate that used to be just "came from the
    // trash".
    const { state, legion } = legionInTrash(1, { trashCharges: 1 });
    const play = replacedVariant(playsOf(state, legion.instanceId))!;
    const { state: after, result } = submit(state, play);

    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.trashUnitPlaysThisTurn, "the replaced-cost play spent a Last Rites charge").toBe(1);
    expect(
      after.players[0]!.baseUnits.some((u) => u.instanceId === legion.instanceId),
      "he never left the trash",
    ).toBe(true);
    expect(after.players[0]!.trash.some((c) => c.instanceId === legion.instanceId), "he is still in the trash").toBe(
      false,
    );
  });

  it("lets a Last Rites charge buy the printed price alongside the replacement", () => {
    // With a charge banked BOTH trash prices are legal, and the enumerator must
    // offer both — the charge is what `printedPriceAvailable` turns back on.
    const { state, legion } = legionInTrash(1, { trashCharges: 1 });
    const plays = playsOf(state, legion.instanceId);

    expect(priceOf(printedVariant(plays)!), "the charge did not buy the printed price").toEqual({
      energy: LEGION_PRINTED_ENERGY,
      power: 0,
    });
    expect(priceOf(replacedVariant(plays)!)).toEqual({ energy: LEGION_PRINTED_ENERGY, power: 1 });

    // And taking the CHARGE variant does spend it — the other half of the pair,
    // without which "the charge survives" above would pass on a counter nothing
    // ever decrements.
    const { state: after, result } = submit(state, printedVariant(plays)!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.trashUnitPlaysThisTurn, "the charge play did not spend the charge").toBe(0);
  });
});

describe("the enumerator and the validator agree", () => {
  // The invariant five crashes in this engine have had the shape of: every
  // action the enumerator offers must validate. Asserted over both cards in the
  // states where both prices exist, since that is where a variant can be priced
  // one way and checked another.
  it("every enumerated play of either card is accepted by the validator", () => {
    const jhin = realUnitInstance(JHIN);
    const legion = realUnitInstance(LEGION);
    const state = board(["Mind", "Fury"]);
    state.players[0]!.hand = [jhin];
    state.players[0]!.trash = [legion];
    state.players[0]!.maxSpellEnergySpentThisTurn = JHIN_SPELL_THRESHOLD;
    state.players[0]!.cardsPlayedThisTurn = 1;
    state.players[0]!.trashUnitPlaysThisTurn = 1;

    const plays = [...playsOf(state, jhin.instanceId), ...playsOf(state, legion.instanceId)];
    expect(plays.length, "nothing was enumerated, so this asserts nothing").toBeGreaterThan(2);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, `enumerated but refused (${play.card.name}): ${JSON.stringify(verdict)}`).toBe(true);
    }
  });
});

describe("coverage", () => {
  it("claims both cards, from the module that holds their whole printed text", () => {
    for (const defId of [JHIN, LEGION]) {
      const def = registry.get(defId);
      expect(isCardImplemented(def), `${defId} does not report implemented`).toBe(true);
      expect(implementingModules(defId), `${defId} is claimed by the wrong module`).toContain("replaced costs");
      expect(partialImplementationNote(def), `${defId} still carries a partial note`).toBeUndefined();
    }
  });

  it("prices nothing it was not asked to", () => {
    // `replacedCostFor` is consulted for EVERY card at every one of the three
    // cost sites, so a table that answered for an unrelated card would silently
    // re-price the pool. Spot-checked on a card with a genuinely similar shape:
    // Last Rites' trash units are full-cost plays and must stay that way.
    const state = board(["Fury"]);
    const ordinary = realUnitInstance("OGN-030");
    state.players[0]!.hand = [ordinary];
    expect(replacedCostFor(state, 0, ordinary), "an unrelated card was given a replaced cost").toBeNull();
  });
});
