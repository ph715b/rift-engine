import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { canBeCountered } from "../src/engine/counter-spell.js";
import { empowerPermanent, giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **VEN-069 Mel, Newly Awakened — the last card in the set.**
 *
 * Her `[Empowered][>]` clause is two sentences. The first ("your spells and
 * abilities can't be countered") has worked since the Vendetta wave that landed
 * counter prevention. The second is this file:
 *
 *   "If a spell or ability you control would give -[Might] to a unit it chooses,
 *    it gives an additional -1 [Might]."
 *
 * # Her partial note was stale, not wrong
 *
 * It said the sentence "is a REPLACEMENT effect on the giving of Might, which
 * this engine has no seam for". `giveMightThisTurn` IS that seam and had been one
 * since Gangplank, Naval's replacement landed on the very same `amount < 0`
 * branch. What was actually missing was the INFORMATION, and it is two facts the
 * engine had never needed together:
 *
 *   **"a spell or ability YOU CONTROL"** — the chooser, not the target's owner
 *   and not the active player.
 *   **"to a unit it CHOOSES"** — which excludes a board sweep. Every mass debuff
 *   routes through the same `giveMightThisTurn`, so a hook that knew only the
 *   caster would widen all of them.
 *
 * Both live on `GameState.chosenByResolvingEffect`, set by the two executors that
 * already compute them to fire `unitChosen`.
 */

const registry = defaultCardRegistry();

const MEL = "VEN-069"; // Mind Unit, 4 Energy 1 Power, 4 Might
const STUPEFY = "OGN-095"; // Mind Spell — "[Reaction] Give a unit -1 Might this turn, to a minimum of 1"
const SMOKE_SCREEN = "OGN-093"; // its bigger sibling at -4, used for the floor test
const FRIGID_TOUCH = "SFD-066"; // "[Reaction] [Repeat] [2] Give a unit -2 Might" — the REPEAT case
const PRIMAL_STRENGTH = "OGN-154"; // "Give a unit +7 Might this turn" — the pump control
const ORB_OF_REGRET = "OGN-090"; // Gear — "[Exhaust]: Give a unit -1 Might this turn, to a minimum of 1"
const WATCHER = "OGN-116"; // Mind Unit — "give ENEMY UNITS -3 Might this turn, to a minimum of 1"
const VANILLA = "OGN-219"; // Order Unit, 4 Might, no text

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n = 16): RuneCard[] => Array.from({ length: n }, (_, i) => rune(`r${i}`, "Mind"));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** Drives a closed chain to empty. A Spell resolves on the chain POP. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

const unitOnBoard = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/**
 * `melFor` 0 or 1 owns an Empowered (or not) Mel; the victim is p1's 9-Might
 * body at bf1, sized so no debuff here can kill it and the number is readable
 * off `mightThisTurn` rather than off whether it died.
 */
function board(opts: { melFor?: 0 | 1; empowered?: boolean; caster?: 0 | 1 } = {}): GameState {
  const caster = opts.caster ?? 0;
  const state = makeState({ phase: "Action", activePlayerIndex: caster, turnState: "Neutral", chainOpen: true });
  state.battlefields[0]!.units = { p2: [{ ...realUnitInstance(VANILLA), instanceId: "victim", might: 9 }] };
  state.players[0]!.channeled = runes();
  state.players[1]!.channeled = runes();

  if (opts.melFor !== undefined) {
    const mel = { ...realUnitInstance(MEL), instanceId: "mel" };
    state.players[opts.melFor]!.baseUnits = [mel];
  }
  return opts.empowered === true ? empowerPermanent(state, "mel") : state;
}

const castAt = (state: GameState, defId: string, targetId: string, caster: 0 | 1 = 0): GameState => {
  const play = playsFor(state, defId).find((a) => a.targetUnitInstanceId === targetId && a.playerIndex === caster);
  expect(play, `${defId} was never offered against ${targetId}`).toBeDefined();
  return settle(accept(state, play!));
};

const withSpell = (state: GameState, defId: string, holder: 0 | 1 = 0): GameState => {
  state.players[holder]!.hand = [spellInstance(defId)];
  return state;
};

describe("the whole pool is implemented — the premise this card completes", () => {
  it("leaves no unimplemented card and no partial note anywhere", () => {
    // **Mel was the last one.** Asserted across the WHOLE registry rather than on
    // her alone, because the interesting claim is the milestone and because a
    // per-card assertion cannot notice a regression somewhere else.
    const unimplemented = registry
      .all()
      .filter((d) => !isCardImplemented(d))
      .map((d) => `${d.id} ${d.name}`);
    expect(unimplemented, "a card in the pool reports unimplemented").toEqual([]);

    expect(partialImplementationNote(registry.get(MEL)), "Mel still carries a partial note").toBeUndefined();
  });
});

describe("Mel's second sentence: the additional -1", () => {
  it("deepens a chosen -Might from her controller's spell", () => {
    // Stupefy prints -1 and a floor of 1; the victim is 9 Might, so the floor
    // never binds and the number is the clause's alone.
    const state = withSpell(board({ melFor: 0, empowered: true }), STUPEFY);
    const after = castAt(state, STUPEFY, "victim");

    expect(unitOnBoard(after, "victim")?.mightThisTurn, "the additional -1 was not applied").toBe(-2);
  });

  it("does NOTHING while she is not Empowered", () => {
    // 828.1.c gates the whole clause on the status. This is the control that says
    // the -2 above came from the clause and not from a mis-read constant.
    const state = withSpell(board({ melFor: 0, empowered: false }), STUPEFY);
    const after = castAt(state, STUPEFY, "victim");

    expect(unitOnBoard(after, "victim")?.mightThisTurn, "an un-Empowered Mel deepened a debuff").toBe(-1);
  });

  it("...and nothing with no Mel on the board at all", () => {
    const state = withSpell(board(), STUPEFY);
    const after = castAt(state, STUPEFY, "victim");

    expect(unitOnBoard(after, "victim")?.mightThisTurn, "the printed amount changed with no Mel present").toBe(-1);
  });

  it("is the CHOOSER's Mel, not the target owner's", () => {
    // "A spell or ability YOU control." p1 owns an Empowered Mel; p0 casts. Her
    // clause must not deepen her opponent's debuff — and the victim here is p1's
    // OWN unit, which is the reading a target-owner check would get backwards.
    const state = withSpell(board({ melFor: 1, empowered: true }), STUPEFY);
    const after = castAt(state, STUPEFY, "victim");

    expect(unitOnBoard(after, "victim")?.mightThisTurn, "the enemy's Mel deepened MY spell").toBe(-1);
  });

  it("applies to an ABILITY too, not only a spell", () => {
    // The printed word is "a spell or ability", and `spellResolvingForIndex` —
    // the closest thing the engine already had — covers spells only. Icevale
    // Archer's "[Exhaust]: give a unit -1 Might this turn" is the ability half.
    // Orb of Regret is a GEAR — "[Exhaust]: Give a unit -1 Might this turn, to a
    // minimum of 1 Might" — so its debuff arrives through the ability executor
    // rather than the spell one, which is the whole point of the pair.
    const state = board({ melFor: 0, empowered: true });
    state.players[0]!.activeGear = [{ ...realGearInstance(ORB_OF_REGRET), instanceId: "orb" }];

    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === "orb" && a.targetUnitInstanceId === "victim",
    );
    expect(activate, "the Orb's ability was not offered against the victim").toBeDefined();

    const after = settle(accept(state, activate!));
    expect(unitOnBoard(after, "victim")?.mightThisTurn, "an ABILITY's debuff was not deepened").toBe(-2);
  });

  it("does NOT deepen a board SWEEP — 'a unit it chooses'", () => {
    // **The half that a caster-only hook would get wrong.** Thousand-Tailed
    // Watcher gives enemy UNITS -3 and chooses nothing; it routes through the very
    // same `giveMightThisTurn`. 355.10.b draws the same line between a target and
    // a restriction.
    const state = board({ melFor: 0, empowered: true });
    state.players[0]!.hand = [realUnitInstance(WATCHER)];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === WATCHER);
    expect(play, "the Watcher was not playable").toBeDefined();
    const after = settle(accept(state, play!));

    expect(unitOnBoard(after, "victim")?.mightThisTurn, "a sweep that chooses nothing was deepened").toBe(-3);
  });

  it("...and not a unit the SAME resolution did not choose", () => {
    // **The membership half, asserted at its own level and deliberately so.**
    // The sweep test above passes for a WEAKER reason than it looks: the Watcher
    // is a unit, and a unit's on-play trigger never goes through the spell
    // resolution that records choices — so `chosenByResolvingEffect` is absent
    // there and the list is never consulted. A mutant deleting the membership
    // check survives it.
    //
    // No card in the pool today gives -Might to a unit its own spell did not
    // choose, which is why this is built rather than cast: the record is set as a
    // resolution would set it, naming one unit, and the Might is given to
    // another. That is exactly the shape a future group-debuff SPELL would have,
    // and the check is what will keep Mel off it.
    const state = board({ melFor: 0, empowered: true });
    const bystander = makeUnit({ instanceId: "bystander", might: 9 });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [bystander] };
    const resolving: GameState = {
      ...state,
      chosenByResolvingEffect: { chooserIndex: 0, unitInstanceIds: ["victim"] },
    };

    // The CHOSEN unit is deepened...
    expect(
      giveMightThisTurn(resolving, "victim", -1).battlefields[0]!.units.p2![0]!.mightThisTurn,
      "the chosen unit was not deepened — the fixture proves nothing",
    ).toBe(-2);
    // ...and a unit the same resolution never named is not.
    expect(
      giveMightThisTurn(resolving, "bystander", -1).battlefields[0]!.units.p1![0]!.mightThisTurn,
      "a unit this effect never chose was deepened",
    ).toBe(-1);
  });

  it("stops applying once the resolution is over", () => {
    // The record is a fact about the CURRENT CALL, like `spellResolvingForIndex`
    // beside it — so both resolution sites clear it on the way out. Left set, it
    // would deepen the next -Might from anywhere at all, including one no spell
    // caused. Asserted on the field because there is no card in the pool that
    // gives a -Might outside a resolution to observe it through.
    const state = withSpell(board({ melFor: 0, empowered: true }), STUPEFY);
    const after = castAt(state, STUPEFY, "victim");

    expect(after.chosenByResolvingEffect ?? null, "the record outlived its resolution").toBeNull();
  });

  it("does NOT touch a PUMP", () => {
    // "Would give -[Might]". Without the sign guard Mel would be shrinking her own
    // side's buffs, which is the opposite of the card.
    const state = board({ melFor: 0, empowered: true });
    const mine = makeUnit({ instanceId: "mine", might: 3 });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [mine] };
    state.players[0]!.hand = [spellInstance(PRIMAL_STRENGTH)];
    // Primal Strength is a BODY card and this board's pool is Mind, so the fixture
    // adds the runes its Power pip needs — the debuff tests all use Mind spells
    // and would otherwise not need them.
    state.players[0]!.channeled = [...state.players[0]!.channeled, ...Array.from({ length: 6 }, (_, i) => rune(`b${i}`, "Body"))];

    const after = castAt(state, PRIMAL_STRENGTH, "mine");
    expect(unitOnBoard(after, "mine")!.mightThisTurn, "a pump was reduced by Mel").toBe(7);
  });

  it("still respects a printed FLOOR", () => {
    // 369 replaces the AMOUNT given; a card printing "to a minimum of 1 [Might]"
    // prints its own limit and keeps it. Smoke Screen at -4 with Mel's -1 is -5
    // against a 4-Might body, which the floor stops at 1.
    const state = board({ melFor: 0, empowered: true });
    state.battlefields[0]!.units = {
      p2: [{ ...realUnitInstance(VANILLA), instanceId: "victim", might: 4 }],
    };
    state.players[0]!.hand = [spellInstance(SMOKE_SCREEN)];

    const after = castAt(state, SMOKE_SCREEN, "victim");
    const victim = unitOnBoard(after, "victim")!;
    expect(victim.might + victim.mightThisTurn, "the deepening pushed the unit under its printed floor").toBe(1);
  });

  it("stacks with a SECOND Empowered Mel — 369 applies each replacement", () => {
    // No board in the pool puts two on the table today, which is exactly why this
    // is a test rather than a comment: the count is what the code does, so it
    // should be what the code is asserted to do.
    const state = withSpell(board({ melFor: 0, empowered: true }), STUPEFY);
    const second = { ...realUnitInstance(MEL), instanceId: "mel-2" };
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, second];
    const both = empowerPermanent(state, "mel-2");

    const after = castAt(both, STUPEFY, "victim");
    expect(unitOnBoard(after, "victim")?.mightThisTurn, "the second Mel did not apply").toBe(-3);
  });
});

describe("her FIRST sentence is untouched", () => {
  it("still stops her controller's spells being countered", () => {
    // The half that shipped earlier. Asserted here because this change edits the
    // card's coverage claim, and a card whose note is retired must have BOTH
    // sentences working rather than one.
    const state = withSpell(board({ melFor: 0, empowered: true }), STUPEFY);
    const cast = accept(state, playsFor(state, STUPEFY).find((a) => a.targetUnitInstanceId === "victim")!);
    const entry = cast.spellChain.filter(isSpellChainEntry)[0];
    expect(entry, "the spell never reached the chain").toBeDefined();

    expect(canBeCountered(cast, entry!), "an Empowered Mel stopped protecting her own spells").toBe(false);
  });
});
