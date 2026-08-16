import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { allPrintedTags, namedTagOf } from "../src/engine/named-tag.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { findUnitAnywhere } from "../src/engine/target-lookup.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, resolveHeldTriggers, realUnitInstance } from "./fixtures.js";

/**
 * **UNL-138 The List — "As you play this, name a tag. (For example, Miss
 * Fortune, Demacia, and Poro are tags.) [Exhaust]: Give a unit with the named
 * tag -2 Might this turn."**
 *
 * Refused in waves 7 and 8. Wave 8's refusal measured three things and every one
 * of them was true; what changed is that two turned out to be buildable and the
 * third turned out to be a divergence rather than a wall.
 *
 *   1. "A GearInstance has no field to write it to" — `GearInstance.namedTag`.
 *   2. "A Gear has no on-play resolution step at all... playing The List through
 *      `submit` leaves `spellChain` empty" — true, and the naming therefore
 *      hangs off `execute-play-card`'s gear-placement site, beside
 *      `[Quick-Draw]`, which is the one place a Gear enters `activeGear`.
 *   3. "A mode per tag is not a route... 111 distinct tags" — true, and it rules
 *      out fanning the name out on the ACTION for the same arithmetic. It is a
 *      parked DECISION, which costs one action to answer and builds its options
 *      only when asked. That reasoning is not speculative: the AI's per-action
 *      cost had just been measured on the move fan-out, which took `reachability`
 *      from ~120s to over ten minutes.
 *
 * The divergence, recorded: 355's Make Relevant Choices puts "as you play this"
 * at ANNOUNCE and this asks immediately after. A Gear does not use the chain, so
 * there is no window in between for anything to respond differently.
 */

const registry = defaultCardRegistry();
const THE_LIST = "UNL-138";
/** A real UNL unit tagged "Demacia" — Mageseeker Investigator. */
const DEMACIAN = "UNL-163";

const chaos = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, domain: "Chaos" as const, state: "Ready" as const }));

/** The List in hand, runes to pay for it, and whatever units `units` describes. */
function board(units: { id: string; tags: string[]; owner?: 0 | 1; might?: number }[] = []): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.hand = [realGearInstance(THE_LIST)];
  state.players[0]!.channeled = chaos(6);
  for (const u of units) {
    const unit = makeUnit({ instanceId: u.id, tags: u.tags, might: u.might ?? 4 });
    const owner = u.owner ?? 0;
    state.players[owner]!.baseUnits = [...state.players[owner]!.baseUnits, unit];
  }
  return state;
}

const accept = (state: GameState, action: unknown): GameState => {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
};

/** Plays The List and settles to the naming question. */
function playList(state: GameState): GameState {
  const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === THE_LIST);
  expect(play, "The List was not playable — the fixture measures nothing").toBeDefined();
  return resolveHeldTriggers(accept(state, play));
}

/** Answers the pending decision by option id. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was asked").toBeDefined();
  return resolveHeldTriggers(
    accept(state, { type: "AnswerDecision", playerIndex: decision!.playerIndex, decisionId: decision!.id, optionId }),
  );
}

const gearId = (state: GameState) => state.players[0]!.activeGear[0]!.instanceId;
const mightOf = (state: GameState, id: string) => {
  const found = findUnitAnywhere(state, id)!;
  return effectiveMight(state, found.unit, found.ownerIndex, { isCombat: false });
};

describe("naming the tag, as the gear is played", () => {
  it("asks the moment it enters play — a Gear reaches no chain, so this is the only moment", () => {
    const parked = playList(board());

    expect(parked.spellChain, "a Gear went on the chain — the refusal's premise changed").toHaveLength(0);
    expect(pendingDecision(parked)?.kind, "no tag was asked for").toBe("UNL-138-name");
  });

  it("offers the FULL pool of tags, not only the ones on the board", () => {
    // **The project owner's call, and the paper game's behaviour.** Naming is a
    // read on what the opponent will play; restricting the list to what is
    // already visible would make the card strictly weaker than printed. The board
    // here holds ONE Demacian and the option list is still all 124.
    //
    // 111 until Vendetta landed (2026-08-16) and 124 after it, which is the point
    // of asserting the figure as well as the identity below it: the card's option
    // list is the WHOLE printed pool, so it grows with every set, and a number
    // that stopped moving would mean the new set's tags were not reaching it.
    const parked = playList(board([{ id: "d", tags: ["Demacia"] }]));
    const options = optionsFor(parked, pendingDecision(parked)!).map((o) => o.id);

    expect(options.length, "the tag list was filtered to the board").toBe(allPrintedTags().length);
    expect(options.length, "the pool stopped having 124 tags — re-read this test").toBe(124);
    expect(options, "a tag nobody on the board carries was dropped").toContain("Poro");
    expect(options, "the tag the board DOES carry is missing").toContain("Demacia");
  });

  it("writes the answer onto THAT gear", () => {
    const named = answer(playList(board()), "Demacia");
    expect(namedTagOf(named, 0, gearId(named)), "the name was not recorded").toBe("Demacia");
  });

  it("two Lists name two tags", () => {
    // The reason the tag is on the INSTANCE and not on the player: a second copy
    // is a second name, and a field one level up would overwrite the first.
    const first = answer(playList(board()), "Demacia");
    const second = { ...first, players: [{ ...first.players[0]!, hand: [realGearInstance(THE_LIST)] }, first.players[1]!] } as GameState;
    const both = answer(playList(second), "Poro");

    const tags = both.players[0]!.activeGear.map((g) => g.namedTag).sort();
    expect(tags, "the second List overwrote the first's name").toEqual(["Demacia", "Poro"]);
  });
});

describe("the ability: give a unit with the named tag -2 Might this turn", () => {
  /** Plays The List, names `tag`, and returns the settled board. */
  const listNaming = (tag: string, units: Parameters<typeof board>[0]) => answer(playList(board(units)), tag);

  const abilitiesOf = (state: GameState) =>
    legalActions(state).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === gearId(state),
    );

  it("is not offered before a tag is named", () => {
    // 416.3's shape — an ability that could only exhaust to do nothing is not
    // offered. Reached by leaving the naming question unanswered.
    const parked = playList(board([{ id: "d", tags: ["Demacia"] }]));
    expect(abilitiesOf(parked), "the ability was offered with no tag named").toHaveLength(0);
  });

  it("is not offered when no unit carries the named tag", () => {
    const named = listNaming("Poro", [{ id: "d", tags: ["Demacia"] }]);
    expect(abilitiesOf(named), "the ability was offered with nothing to weaken").toHaveLength(0);
  });

  /**
   * Activates the gear and settles.
   *
   * **A ONE-option question answers itself** — `advanceDecisions` drops a
   * decision with a single answer rather than asking it — so a fixture with one
   * tagged unit runs the whole ability through this call and never parks
   * anything. Fixtures below therefore put TWO tagged units on the board
   * wherever the CHOICE is what is under test, and rely on the auto-answer only
   * where the outcome is.
   */
  const activate = (state: GameState) => resolveHeldTriggers(accept(state, abilitiesOf(state)[0]!));

  it("takes 2 Might off a unit with the tag, this turn", () => {
    // One tagged unit, so the question auto-answers and the effect is visible
    // straight off the activation — which is also the common case in play.
    const named = listNaming("Demacia", [{ id: "d", tags: ["Demacia"], might: 4 }]);
    expect(mightOf(named, "d"), "the fixture is not 4 Might").toBe(4);

    const after = activate(named);

    expect(mightOf(after, "d"), "the penalty did not land").toBe(2);
    expect(after.players[0]!.activeGear[0]!.exhausted, "the exhaust was not taken").toBe(true);
  });

  it("reaches an ENEMY unit — the card says 'a unit', naming no side", () => {
    // 355.9.a.1 widens a bare "a unit" to the whole Board. An implementation that
    // filtered to friendly units would pass every other test in this file. TWO
    // tagged units, one per side, so the offer is a real list and the enemy's
    // presence in it is the measurement.
    const named = listNaming("Demacia", [
      { id: "mine", tags: ["Demacia"], might: 4 },
      { id: "theirs", tags: ["Demacia"], owner: 1, might: 5 },
    ]);
    const activated = activate(named);

    expect(
      optionsFor(activated, pendingDecision(activated)!).map((o) => o.instanceId).sort(),
      "the offer was filtered to one side",
    ).toEqual(["mine", "theirs"]);
    expect(mightOf(answer(activated, "theirs"), "theirs"), "the enemy unit was not weakened").toBe(3);
  });

  it("does not touch a unit WITHOUT the tag", () => {
    // Two Demacians so the question parks, plus a Noxian that must not appear.
    const named = listNaming("Demacia", [
      { id: "d", tags: ["Demacia"] },
      { id: "d2", tags: ["Demacia"] },
      { id: "other", tags: ["Noxus"] },
    ]);
    const activated = activate(named);

    expect(
      optionsFor(activated, pendingDecision(activated)!).map((o) => o.instanceId).sort(),
      "a unit without the named tag was offered",
    ).toEqual(["d", "d2"]);
  });

  it("floors at 0 rather than killing — 143.2.b", () => {
    // -2 on a 1-Might unit reads as 0, not as -1, and it does NOT die: this is a
    // Might change, not damage. An implementation that killed here would be
    // strictly stronger than printed.
    const named = listNaming("Demacia", [{ id: "small", tags: ["Demacia"], might: 1 }]);
    const after = activate(named);

    expect(mightOf(after, "small"), "Might went negative").toBe(0);
    expect(findUnitAnywhere(after, "small"), "the unit died — this is Might, not damage").toBeDefined();
  });

  it("matches a REAL card's printed tag, not just a fixture's", () => {
    // The whole card rests on `UnitInstance.tags` being populated from the
    // definition. A fixture-only test would pass against a tags array that the
    // loader never fills.
    const def = registry.get(DEMACIAN);
    expect(def.type === "Unit" ? def.tags : [], "the sample card stopped printing Demacia").toContain("Demacia");

    const state = board();
    state.players[1]!.baseUnits = [realUnitInstance(DEMACIAN)];
    const named = answer(playList(state), "Demacia");

    expect(abilitiesOf(named).length, "a real Demacian did not satisfy the named tag").toBeGreaterThan(0);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(THE_LIST);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
