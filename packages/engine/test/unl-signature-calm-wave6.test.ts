import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { implementingModules, isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 6's `Calm`-first dual-domain Unleashed cards — `effects/signature-calm.ts`.
 *
 * ONE of the four is written. Alpha Strike is the whole of this file's positive
 * content; the other three are REFUSED and pinned at the foot, each asserting the
 * card is unregistered so that implementing it fails here loudly instead of
 * leaving a stale refusal in a report nobody re-reads.
 *
 * **Nothing here calls a resolver closure.** Every assertion is driven the way a
 * game drives it — `legalActions` for the fan-out, `submit` for the action, then
 * `resolveHeldTriggers` because a spell sits on the chain until the Cleanup pops
 * it. A test that reached into `cardEffects["UNL-192"].resolve` would pass just as
 * happily with the card unregistered, which is the failure this repo keeps
 * finding.
 *
 * Every "did nothing" assertion has a positive control off the same fixture with
 * one number changed.
 */

const registry = defaultCardRegistry();

const ALPHA_STRIKE = "UNL-192"; // 3 Energy / 1 Calm-or-Body, [Action]
const VEX_GLOOMIST = "UNL-193"; // Legend — refused, see the foot of this file
const SHADOW = "UNL-194"; // Unit — refused, both clauses
const IVERN_GREEN_FATHER = "UNL-195"; // Legend — refused

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });
const runes = (domain: RuneCard["domain"], count: number) =>
  Array.from({ length: count }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const unitAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/** Plays a card through `submit` and settles the chain and the question queue. */
function playAndSettle(state: GameState, action: unknown): GameState {
  return answerDecisions(resolveHeldTriggers(accept(state, action)));
}

// ---------------------------------------------------------------------------
// UNL-192 Alpha Strike
// ---------------------------------------------------------------------------

describe("Alpha Strike (UNL-192): split a friendly unit's Might, gain 1 XP per kill", () => {
  /**
   * The caster holds Alpha Strike with the runes to pay for it, and `striker`
   * (their swinging unit) sits in BASE — the zone the printed text allows, since
   * only the VICTIMS are "at battlefields".
   */
  function strikeState(strikerMight: number): { state: GameState; cardId: string } {
    const card = spellInstance(ALPHA_STRIKE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 8;
    state.players[0]!.channeled = runes("Calm", 4);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "striker", name: "striker", might: strikerMight })];
    return { state, cardId: card.instanceId };
  }

  const strike = (state: GameState, cardId: string): GameState => {
    const action = playsOf(state, cardId).find((a) => a.targetUnitInstanceId === "striker");
    expect(action, "no play variant named the friendly unit — the card is not castable").toBeDefined();
    return playAndSettle(state, action!);
  };

  it("pays the CHEAPEST kills first, so 4 Might buys two bodies rather than one", () => {
    // The allocation order, which is the one part of this card the engine chooses
    // rather than the player. Board order (Volibear - Furious's model) would spend
    // 3 on `big`, leave 1, and kill ONE unit; cheapest-first kills two and the
    // card pays 1 XP per body. Both are legal splits, so this assertion is what
    // says which one shipped.
    const { state, cardId } = strikeState(4);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "big", might: 3 })] };
    state.battlefields[1]!.units = {
      p2: [makeUnit({ instanceId: "small-a", might: 2 }), makeUnit({ instanceId: "small-b", might: 2 })],
    };

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "small-a"), "the first cheap kill never landed").toBeUndefined();
    expect(unitAnywhere(after, "small-b"), "the split stopped after one unit").toBeUndefined();
    expect(unitAnywhere(after, "big")?.damage, "the pool was spent on the expensive unit").toBe(0);
    expect(after.players[0]!.xp, "'for each unit this kills, gain 1 XP' paid the wrong count").toBe(2);
  });

  it("gains NO XP for a unit it only damages, and the remainder lands on it", () => {
    // The negative half of the clause. 3 into a 5-Might unit is a legal split
    // (355.14.g only requires each target get at least 1), and it kills nothing.
    const { state, cardId } = strikeState(3);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "tank", might: 5 })] };

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "tank")!.damage, "the damage never landed at all").toBe(3);
    expect(after.players[0]!.xp, "XP was paid for a unit that survived").toBe(0);
  });

  it("counts KILLS and not HITS — a survivor beside a corpse pays 1, not 2", () => {
    // The mutation this exists to catch is `kills += 1` moving out of the
    // did-it-die branch, which would read as "1 XP per unit the split touched".
    const { state, cardId } = strikeState(5);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "weak", might: 1 })] };
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "tough", might: 9 })] };

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "weak"), "the cheap unit survived — the split never reached it").toBeUndefined();
    expect(unitAnywhere(after, "tough")!.damage, "the remaining 4 was not spent").toBe(4);
    expect(after.players[0]!.xp, "the survivor was counted as a kill").toBe(1);
  });

  it("cannot reach a unit in a BASE — 'at battlefields' is printed", () => {
    // Both halves off one fixture: the sheltered unit is untouched while the one
    // standing at a battlefield dies, so an undamaged base unit cannot be mistaken
    // for a spell that did nothing at all.
    //
    // **MEASURED: this rule is guarded TWICE and no single-site mutation can be
    // seen here.** Widening the walk's scope to `"anywhere"` alone leaves this
    // green, because `lethalDamageFor` locates through `findUnitOnBattlefield` and
    // answers `undefined` for a base unit — which the loop skips. Mutating BOTH
    // together kills this test, which is how the assertion was proved able to
    // fail. The redundancy is not decoration: the helper's `undefined` is really
    // about a unit that has LEFT (killed by a sibling's Deathknell mid-split), and
    // it happens to also cover a zone the walk was already told to exclude.
    const { state, cardId } = strikeState(4);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "front", might: 1 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "sheltered", might: 1 })];

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "front"), "the unit at the battlefield survived").toBeUndefined();
    expect(unitAnywhere(after, "sheltered"), "the split killed a unit sheltering in a base").toBeDefined();
    expect(unitAnywhere(after, "sheltered")!.damage, "the split reached into a base").toBe(0);
    expect(after.players[0]!.xp).toBe(1);
  });

  it("splits among ENEMY units only — a friendly standing beside them is untouched", () => {
    const { state, cardId } = strikeState(4);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "ally", might: 1 })],
      p2: [makeUnit({ instanceId: "foe", might: 1 })],
    };

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "foe"), "the enemy survived").toBeUndefined();
    expect(unitAnywhere(after, "ally"), "the split killed the caster's own unit").toBeDefined();
    expect(unitAnywhere(after, "ally")!.damage, "the split hit the caster's own unit").toBe(0);
    expect(after.players[0]!.xp).toBe(1);
  });

  it("reads EFFECTIVE Might at resolution, not the printed number", () => {
    // The PDF's own worked example for this card turns on exactly this: the
    // opponent shrinks the chosen unit with Frigid Touch after it is named, and
    // the spell resolves with the smaller pool. Here a -2 this turn is the shrink.
    const shrunk = strikeState(4);
    shrunk.state.players[0]!.baseUnits = [makeUnit({ instanceId: "striker", might: 4, mightThisTurn: -2 })];
    shrunk.state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "target", might: 3 })] };
    const afterShrink = strike(shrunk.state, shrunk.cardId);
    expect(unitAnywhere(afterShrink, "target")!.damage, "the shrink was ignored — printed Might was used").toBe(2);

    // The positive control off the same fixture with the modifier removed: 4 kills
    // the 3-Might unit, so the 2 above is about the Might read and not about the
    // spell being inert.
    const full = strikeState(4);
    full.state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "target", might: 3 })] };
    expect(unitAnywhere(strike(full.state, full.cardId), "target"), "the 2 above proves nothing").toBeUndefined();
  });

  it("offers a friendly unit in BASE as well as one at a battlefield (355.9.a.1)", () => {
    // "Choose A FRIENDLY UNIT" carries no location word, so the bare noun reaches
    // the whole Board. A `scope: "battlefield"` default would silently make this
    // card uncastable off a base board.
    const { state, cardId } = strikeState(4);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "forward", might: 2 })] };
    const offered = playsOf(state, cardId).map((a) => a.targetUnitInstanceId);
    expect(offered, "the unit in base was not offered").toContain("striker");
    expect(offered, "the unit at the battlefield was not offered").toContain("forward");
  });

  it("is UNCASTABLE with no friendly unit at all (355.8)", () => {
    // "Valid choices must be made for all targets" — nothing says "up to", so an
    // empty board is not a legal announcement.
    const { state, cardId } = strikeState(4);
    state.players[0]!.baseUnits = [];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "foe", might: 1 })] };
    expect(playsOf(state, cardId).length, "the spell was castable with nothing to swing").toBe(0);

    // The control: the same board with one friendly unit back does offer it.
    const { state: withUnit, cardId: id2 } = strikeState(4);
    withUnit.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "foe", might: 1 })] };
    expect(playsOf(withUnit, id2).length, "the zero above proves nothing").toBeGreaterThan(0);
  });

  it("does nothing and pays nothing with no enemy at any battlefield", () => {
    // A legal cast with an empty split — 355.14 caps how many targets may be
    // chosen and says nothing about a minimum, so the spell resolves for no
    // effect. Asserted so that "no enemies" cannot throw or silently pay XP.
    const { state, cardId } = strikeState(4);
    const after = strike(state, cardId);
    expect(after.players[0]!.xp, "XP was paid with nothing killed").toBe(0);
    expect(unitAnywhere(after, "striker"), "the swinging unit was consumed").toBeDefined();
  });

  it("PINNED DIVERGENCE: Bonus Damage is applied per HIT, not once to the pool (715.3)", () => {
    // "If the Deal action Splits damage, then the Bonus Damage applies to the
    // amount of Damage that will be Split" — the PDF works it with Volibear, whose
    // 5 becomes a 6 TO BE SPLIT among up to 6 units. Printed, a 2-Might swing
    // beside Annie - Fiery is a 3-damage pool: enough for the 1-Might unit and the
    // 2-Might one, two kills and 2 XP.
    //
    // So beside Annie - Fiery, a 2-Might swing at three 1-Might units should be a
    // 3-damage pool spread one apiece: three kills, 3 XP.
    //
    // What this engine does instead: the pool stays 2, and `dealDamage` adds
    // Annie's +1 to each allocation separately. Two units are assigned 1 each
    // (landing 2 each, one point of it overkill the pool never paid for), the pool
    // is spent, and the third is never reached — 2 kills and 2 XP.
    //
    // **The XP is what makes it visible**, which is why the pin is on that rather
    // than on a damage figure: the fix would change how many bodies the card
    // removes, not just how bruised a survivor is. Retire this when the damage
    // funnel takes a split-aware entry point — Volibear - Furious (OGN-041) is the
    // other card waiting on the same one.
    const { state, cardId } = strikeState(2);
    state.players[0]!.baseUnits.push(makeUnit({ instanceId: "annie", defId: "OGS-001", might: 3 }));
    state.battlefields[0]!.units = {
      p2: [
        makeUnit({ instanceId: "e1", might: 1 }),
        makeUnit({ instanceId: "e2", might: 1 }),
        makeUnit({ instanceId: "e3", might: 1 }),
      ],
    };

    const after = strike(state, cardId);
    expect(unitAnywhere(after, "e1"), "the bonus stopped landing at all — this fixture measures nothing").toBeUndefined();
    expect(unitAnywhere(after, "e2"), "only one unit died — the split is broken, not merely divergent").toBeUndefined();
    expect(unitAnywhere(after, "e3"), "the pool now stretches to a third kill — 715.3 is fixed, retire this pin").toBeDefined();
    expect(unitAnywhere(after, "e3")!.damage, "the third unit was reached after all").toBe(0);
    expect(after.players[0]!.xp, "the XP moved — 715.3 is fixed, retire this pin").toBe(2);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ALPHA_STRIKE))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What this wave REFUSED
// ---------------------------------------------------------------------------

describe("the three cards this wave refused", () => {
  it("Vex - Gloomist (UNL-193) is still unimplemented, and deliberately", () => {
    // "When you or an ally hold, you may exhaust me to draw 1" is Renata Glasc -
    // Chem-Baroness's shape exactly — an `onBattlefieldHeld` hook parking a
    // decision. Both halves live in `engine/legend-abilities.ts`
    // (`LEGEND_ABILITIES`), which is where every Legend trigger is registered
    // because `allListeningPermanents` reaches the legend zone only through that
    // table's adapter. A domain file cannot register a Legend at all.
    // Delete this test when the hook is written.
    expect(implementingModules(VEX_GLOOMIST), "Vex now works — retire this refusal").toEqual([]);
  });

  it("Shadow (UNL-194) is still unimplemented — BOTH clauses, for different reasons", () => {
    // "If you play me to A BATTLEFIELD, I enter ready" is a deploy-time
    // replacement (369.3) whose only predicate is `deploy.unitEntersReady`, and
    // its condition is the DESTINATION — which that predicate is not handed. So
    // this is not the one-line case in `conditionalEntersReady` the other seven
    // conditional enter-readys are.
    //
    // "[Stun] an enemy unit ATTACKING HERE" needs a target restriction relative to
    // the ability's SOURCE, and `TargetingSpec` has none: `attackingOnly` reaches
    // every attacker on the board, which is wider than printed.
    expect(implementingModules(SHADOW), "Shadow now works — retire this refusal").toEqual([]);
  });

  it("Ivern - Green Father (UNL-195) is still unimplemented, and deliberately", () => {
    // A Legend hook (see Vex above) AND a mechanism that does not exist: replacing
    // a battlefield in play with a "Brush battlefield token" that grants +1 Might
    // to five unit types and can be swapped back when scored.
    expect(implementingModules(IVERN_GREEN_FATHER), "Ivern now works — retire this refusal").toEqual([]);
  });

  it("...and the card this wave DID write is registered", () => {
    // The partition, so three empty lists above cannot be mistaken for
    // `implementingModules` answering empty for everything.
    expect(implementingModules(ALPHA_STRIKE), "Alpha Strike is not registered").not.toEqual([]);
  });
});
