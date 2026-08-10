import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { implementingModule, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { deflectSurchargeForTargets } from "../src/engine/granted-keywords.js";
import { resolveShowdown } from "../src/engine/combat.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { ActivateAbilityAction, PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { GameState, PendingDecision } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 2's Unleashed Order cards.
 *
 * Everything reachable by an ACTION goes through `legalActions` -> `submit`,
 * never a resolver closure: four of these seven are activated abilities, and an
 * activation crosses the enumerator, `canPayActivationCost`, the validator, the
 * cost payment and the dispatch before a resolver sees it. A test that called
 * `activatedAbilities["UNL-160"].resolve` would clear all five hops at once, and
 * two of these cards are ONLY reachable if `availableWhile` is asked at the right
 * one.
 *
 * The `[Deathknell]`s go through `destroyUnit` -> `resolveHeldTriggers`, which is
 * the real death funnel and the real chain pop — the idiom `sfd-calm.test.ts`
 * uses for Lonely Poro, whose inverse Loyal Poro is. One of them ALSO goes
 * through a submitted killing spell, to prove the announce-to-resolution path
 * end to end at least once.
 *
 * Every card has a NEGATIVE control, because the failure mode this repo keeps
 * paying for is a card that is registered, enumerated, paid for and inert — and
 * a happy-path assertion passes just as well when the condition is never checked.
 */

const registry = defaultCardRegistry();

const CARRION_DREDGER = "UNL-153";
const HEROIC_CHARGE = "UNL-155";
const LOYAL_PORO = "UNL-156";
const SHEPHERDS_HEIRLOOM = "UNL-158";
const ULTRASOFT_PORO = "UNL-160";
const DIVINING_SHELLS = "UNL-161";
const ENTHRALLING_PROTECTOR = "UNL-162";
/** Soul Harvest — "Kill a unit at a battlefield with 3 Might or less." An Order
 *  spell, and the cheapest real killing action in this file's own domain, so a
 *  Deathknell can be driven from a SUBMITTED play rather than from `destroyUnit`. */
const SOUL_HARVEST = "UNL-159";
/** Bandle Soldier, whose `[Level 3][>] I enter ready` this wave REFUSED — see the
 *  describe block at the foot of this file, which pins the refusal. */
const BANDLE_SOLDIER = "UNL-151";

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function accept(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  expect(action, `${what} was never enumerated`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `${what} was refused: ${JSON.stringify(result)}`).toEqual({ type: "Ok" });
  return next;
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/** Every enumerated way to activate one permanent's ability. An explicit type
 *  predicate, not the inferred one: `targetUnitInstanceId` is read off these
 *  below, and a `PlayerAction` union does not have it. */
function activationsOf(state: GameState, instanceId: string): ActivateAbilityAction[] {
  return legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );
}

/** Passes Focus until the chain and the holding pen are both empty, stopping on
 *  a pending question (`submit` refuses a PassFocus while one is outstanding). */
function passUntilSettled(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = submit(current, pass).state;
  }
  throw new Error("passUntilSettled: the chain never emptied");
}

/** Answers the pending question by option id, through `submit`. */
function answer(state: GameState, optionId: string): GameState {
  const decision: PendingDecision | undefined = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const result = submit(state, {
    type: "AnswerDecision",
    playerIndex: decision!.playerIndex,
    decisionId: decision!.id,
    optionId,
  });
  expect(result.result, `the answer "${optionId}" was refused`).toEqual({ type: "Ok" });
  return passUntilSettled(result.state);
}

/** The option ids currently on offer. */
function offeredIds(state: GameState): string[] {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.id);
}

function unitAnywhere(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const index of [0, 1] as const) {
    const player = state.players[index]!;
    const found = [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])].find(
      (u) => u.instanceId === instanceId,
    );
    if (found) return found;
  }
  return undefined;
}

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);
const birdsOf = (state: GameState, index: 0 | 1) =>
  [
    ...state.players[index]!.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[state.players[index]!.id] ?? []),
  ].filter((u) => u.name === "Bird");

describe("Carrion Dredger (UNL-153): [Deathknell] play a 1-Might Bird with [Deflect] to your base", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(CARRION_DREDGER))).toBe(true);
  });

  function dredgerAt(place: (state: GameState, dredger: UnitInstance) => void) {
    const state = makeState({ phase: "Action" });
    const dredger = realUnitInstance(CARRION_DREDGER);
    place(state, dredger);
    return { state, dredger };
  }

  it("makes exactly one Bird, in its controller's BASE, when it dies at a battlefield", () => {
    // "TO YOUR BASE" is printed, so where it died is irrelevant — the assertion
    // that separates this from a "here" reading is that bf1 is empty afterwards.
    const { state, dredger } = dredgerAt((s, d) => {
      s.battlefields[0]!.units = { p1: [d] };
    });

    // Killed by player 1, so "YOUR base" paying the DYING unit's controller is
    // separated from paying the killer.
    const after = resolveHeldTriggers(destroyUnit(state, dredger.instanceId, 1));

    expect(birdsOf(after, 0), "the Deathknell never made a Bird").toHaveLength(1);
    expect(names(after.players[0]!.baseUnits), "the Bird did not go to base").toEqual(["Bird"]);
    expect(birdsOf(after, 1), "the Bird was made for the killer").toHaveLength(0);
    expect(after.battlefields[0]!.units["p1"] ?? [], "something was left where it died").toEqual([]);
  });

  it("makes the Bird with 1 Might, [Deflect], and the Bird tag", () => {
    const { state, dredger } = dredgerAt((s, d) => {
      s.players[0]!.baseUnits = [d];
    });
    const bird = birdsOf(resolveHeldTriggers(destroyUnit(state, dredger.instanceId, 1)), 0)[0]!;

    expect(bird.might).toBe(1);
    expect(bird.keywords.Deflect, "the token has no [Deflect] — the keyword is in the spec for nothing").toBe(1);
    expect(bird.tags).toContain("Bird");
    expect(bird.isToken).toBe(true);
    // 143.4.a's default. Neither Bird-maker prints "ready".
    expect(bird.exhausted, "the Bird entered ready without the card saying so").toBe(true);
  });

  it("the Bird's [Deflect] really taxes an opponent choosing it — the keyword is LIVE", () => {
    // The negative half of a keyword that parses: `[Deflect]` shipped inert once
    // already, and a token minted with an unread keyword looks identical in play
    // to one whose surcharge simply is not charged. Measured through the same
    // function `legal-actions` prices a spell's targets with.
    const { state, dredger } = dredgerAt((s, d) => {
      s.players[0]!.baseUnits = [d];
    });
    const after = resolveHeldTriggers(destroyUnit(state, dredger.instanceId, 1));
    const bird = birdsOf(after, 0)[0]!;
    const plain = makeUnit({ instanceId: "plain" });
    const withPlain = { ...after, players: [{ ...after.players[0]!, baseUnits: [...after.players[0]!.baseUnits, plain] }, after.players[1]!] as GameState["players"] };

    expect(deflectSurchargeForTargets(withPlain, 1, [bird.instanceId]), "the opponent pays nothing for a [Deflect] token").toBe(1);
    expect(deflectSurchargeForTargets(withPlain, 1, ["plain"]), "an ordinary unit is being taxed").toBe(0);
    // Its own controller is never taxed for choosing it — the negative control on
    // the surcharge itself, so the 1 above is not just "any unit costs 1".
    expect(deflectSurchargeForTargets(withPlain, 0, [bird.instanceId])).toBe(0);
  });

  it("fires through a SUBMITTED killing spell, chain and all", () => {
    // The end-to-end control. Everything above drives the death funnel directly;
    // this drives it from an announced, paid-for, chain-resolved Soul Harvest, so
    // a Deathknell dropped on the announce->resolve hop fails HERE and only here.
    const spell = spellInstance(SOUL_HARVEST);
    const state = makeState({ phase: "Action" });
    const dredger = realUnitInstance(CARRION_DREDGER);
    state.players[1]!.hand = [spell];
    state.players[1]!.channeled = runesFor(SOUL_HARVEST);
    state.battlefields[0]!.units = { p1: [dredger] };
    state.activePlayerIndex = 1;
    state.focusHolder = 1;
    state.chainPriority = 1;

    const cast = castsOf(state, spell.instanceId).find((a) => a.targetUnitInstanceId === dredger.instanceId);
    const after = passUntilSettled(accept(state, cast, "Soul Harvest on the Dredger"));

    expect(unitAnywhere(after, dredger.instanceId), "the Dredger survived — the fixture proves nothing").toBeUndefined();
    expect(names(after.players[0]!.baseUnits), "the Deathknell was dropped somewhere on the real play path").toEqual(["Bird"]);
  });
});

describe("Loyal Poro (UNL-156): [Deathknell] if I DIDN'T die alone, draw 1", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(LOYAL_PORO))).toBe(true);
  });

  /** The Poro somewhere killable, with exactly one card in the deck so a draw is
   *  unambiguous: `hand` is `["Drawn"]` or it is empty. */
  function poroState(place: (state: GameState, poro: UnitInstance) => void): { state: GameState; poro: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const poro = realUnitInstance(LOYAL_PORO);
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    place(state, poro);
    return { state, poro };
  }

  /** Player 1 kills it, so paying the DYING unit's controller is separated from
   *  paying the killer. */
  const kill = (state: GameState, instanceId: string) => resolveHeldTriggers(destroyUnit(state, instanceId, 1));

  it("draws for its own controller when an ally was standing there", () => {
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p, makeUnit({ instanceId: "ally", name: "Ally" })] };
    });

    const after = kill(state, poro.instanceId);
    expect(names(after.players[0]!.hand), "the Deathknell never drew").toEqual(["Drawn"]);
    expect(after.players[1]!.hand, "the killer was paid instead of the owner").toHaveLength(0);
  });

  it("draws NOTHING when it dies alone — the negative control the card turns on", () => {
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p] };
    });

    expect(kill(state, poro.instanceId).players[0]!.hand, "it drew having died alone").toHaveLength(0);
  });

  it("an ENEMY unit here is not company — 'other FRIENDLY units'", () => {
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p], p2: [makeUnit({ instanceId: "enemy", name: "Enemy" })] };
    });

    expect(kill(state, poro.instanceId).players[0]!.hand, "an enemy was counted as company").toHaveLength(0);
  });

  it("a friendly unit ELSEWHERE is not company — 'HERE'", () => {
    // Both other places at once: another battlefield and its own base.
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p] };
      s.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "far", name: "Far" })] };
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    });

    expect(kill(state, poro.instanceId).players[0]!.hand, "'here' reached the whole board").toHaveLength(0);
  });

  it("counts the BASE as a location when it dies at home", () => {
    // "A unit is alone when there are no other friendly units at the same
    // LOCATION" — a Base is one (355.9.b's Public zones list names Bases), so a
    // Poro that dies at home among friends did not die alone and draws.
    const together = poroState((s, p) => {
      s.players[0]!.baseUnits = [p, makeUnit({ instanceId: "ally", name: "Ally" })];
    });
    expect(names(kill(together.state, together.poro.instanceId).players[0]!.hand), "base was treated as no location").toEqual([
      "Drawn",
    ]);

    const alone = poroState((s, p) => {
      s.players[0]!.baseUnits = [p];
    });
    expect(kill(alone.state, alone.poro.instanceId).players[0]!.hand, "it drew dying alone at home").toHaveLength(0);
  });

  it("the note is taken as it DIES, not as the Deathknell resolves", () => {
    // The half `DeathknellDefinition.capture` exists for, pointed the OTHER way
    // from Lonely Poro's: kill the Poro FIRST while the ally still stands, then
    // kill the ally, then resolve. It was not alone when it died, so it must
    // draw — and a `resolve` that re-derived would find both in the trash, read
    // "alone", and silently skip a draw the card is owed.
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p, makeUnit({ instanceId: "ally", name: "Ally" })] };
    });

    const poroFirst = resolveHeldTriggers(destroyUnit(destroyUnit(state, poro.instanceId, 1), "ally", 1));
    expect(names(poroFirst.players[0]!.hand), "the capture was ignored — the board was re-read at resolution").toEqual([
      "Drawn",
    ]);
  });

  it("two separate KILL INSTRUCTIONS leave the second one genuinely alone", () => {
    // 808's Kill Instruction rule notes the dying unit's location "before
    // completing THIS kill instruction" — so the ally is already in the trash by
    // the time the Poro's note is taken, and it really did die alone. The mirror
    // of the case above, and what stops `capture` from being a blanket "always
    // count the ally".
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p, makeUnit({ instanceId: "ally", name: "Ally" })] };
    });

    const sequential = resolveHeldTriggers(destroyUnit(destroyUnit(state, "ally", 1), poro.instanceId, 1));
    expect(sequential.players[0]!.hand, "the ally's corpse was counted as company").toHaveLength(0);
  });

  it("DIVERGENCE: a COMBAT mutual wipe reads as 'alone' and does NOT draw", () => {
    // The same open gap Lonely Poro pins from the other side, recorded here so
    // closing it fails loudly. Cleanup steps 3a and 3b are separate and ordered —
    // every dying unit's note is taken while every other is still standing — but
    // `combat.processDefeated` interleaves them, killing one unit at a time. So
    // the ally is already trashed when the Poro's note is taken, the Poro reads
    // as alone, and the draw the rules give it never happens.
    //
    // Asserted as the WRONG answer deliberately: this is the direction that is
    // invisible in play, because a Deathknell that quietly does nothing looks
    // exactly like one whose condition was not met.
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = {
        p1: [{ ...p, might: 1 }, makeUnit({ instanceId: "ally", name: "Ally", might: 1 })],
        p2: [makeUnit({ instanceId: "big", name: "Big", might: 6 })],
      };
    });

    const wiped = resolveHeldTriggers(resolveShowdown(state, "bf1", 1));
    expect(wiped.battlefields[0]!.units["p1"] ?? [], "the fixture did not actually wipe the side").toHaveLength(0);
    expect(wiped.players[0]!.hand, "the recorded divergence is gone — update the note").toHaveLength(0);
  });
});

describe("Heroic Charge (UNL-155): +1 Might to a friendly and [Stun] an enemy at its location", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(HEROIC_CHARGE))).toBe(true);
  });

  function chargeState(place: (state: GameState) => void) {
    const spell = spellInstance(HEROIC_CHARGE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(HEROIC_CHARGE);
    place(state);
    return { state, spellId: spell.instanceId };
  }

  it("pumps the friendly and stuns the enemy, in one submitted play", () => {
    const { state, spellId } = chargeState((s) => {
      s.battlefields[0]!.units = {
        p1: [makeUnit({ instanceId: "mine", name: "Mine", might: 3 })],
        p2: [makeUnit({ instanceId: "theirs", name: "Theirs", might: 3 })],
      };
    });

    const cast = castsOf(state, spellId).find(
      (a) => a.targetUnitInstanceId === "mine" && a.secondTargetUnitInstanceId === "theirs",
    );
    const after = passUntilSettled(accept(state, cast, "Heroic Charge on the pair"));

    expect(unitAnywhere(after, "mine")!.mightThisTurn, "the +1 never landed").toBe(1);
    expect(unitAnywhere(after, "theirs")!.stunned, "the enemy was never stunned").toBe(true);
    // The negative half of the same play: neither effect crossed over.
    expect(unitAnywhere(after, "mine")!.stunned, "it stunned the friendly unit").toBe(false);
    expect(unitAnywhere(after, "theirs")!.mightThisTurn, "it pumped the enemy").toBe(0);
  });

  it("is NOT castable when the only enemy is at a DIFFERENT battlefield", () => {
    // "At its location" is the whole restriction, and it lives on the spec so the
    // enumerator refuses the card rather than a resolver refusing after payment.
    const { state, spellId } = chargeState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
      s.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });

    expect(castsOf(state, spellId), "it was offered across two battlefields").toHaveLength(0);
  });

  it("is NOT castable with a friendly at home and an enemy forward", () => {
    // The base case of the same rule. An enemy is never in your base, so a
    // friendly sitting at home has no legal partner — which is why the default
    // `scope` is right and `scope: "anywhere"` would be wrong.
    const { state, spellId } = chargeState((s) => {
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];
      s.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });

    expect(castsOf(state, spellId), "a base-to-battlefield pairing was offered").toHaveLength(0);
  });

  it("never offers the pairing backwards — the slots are friendly then enemy", () => {
    const { state, spellId } = chargeState((s) => {
      s.battlefields[0]!.units = {
        p1: [makeUnit({ instanceId: "mine", name: "Mine" })],
        p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })],
      };
    });

    const casts = castsOf(state, spellId);
    expect(casts).toHaveLength(1);
    expect(casts[0]!.targetUnitInstanceId).toBe("mine");
    expect(casts[0]!.secondTargetUnitInstanceId).toBe("theirs");
  });
});

describe("Shepherd's Heirloom (UNL-158): gain 1 XP on play, then Spend 1 XP to attach", () => {
  function heirloomState() {
    const gear = realGearInstance(SHEPHERDS_HEIRLOOM);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [gear];
    state.players[0]!.channeled = runesFor(SHEPHERDS_HEIRLOOM);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer", name: "Wearer" })];
    return { state, gearId: gear.instanceId };
  }

  it("gains 1 XP when it is played — through the real play path", () => {
    // A Gear pushes NO chain entry (`execute-play-card`'s Spell branch is the
    // only one that does), so a `cardEffects` entry for this card would have been
    // registered, enumerated, paid for and never run. This is a self-trigger, so
    // it is HELD and needs the chain drained before the XP is there.
    const { state, gearId } = heirloomState();
    expect(state.players[0]!.xp).toBe(0);

    const after = passUntilSettled(accept(state, castsOf(state, gearId)[0], "Shepherd's Heirloom"));

    expect(after.players[0]!.xp, "the on-play XP never landed").toBe(1);
    expect(after.players[1]!.xp, "the opponent gained it").toBe(0);
  });

  it("offers its [Equip] once the XP is there, and spends it to attach", () => {
    const { state, gearId } = heirloomState();
    const played = passUntilSettled(accept(state, castsOf(state, gearId)[0], "Shepherd's Heirloom"));

    const equip = activationsOf(played, gearId).find((a) => a.targetUnitInstanceId === "wearer");
    const attached = passUntilSettled(accept(played, equip, "the [Equip]"));

    expect(attached.players[0]!.activeGear[0]!.attachedToInstanceId, "it never attached").toBe("wearer");
    expect(attached.players[0]!.xp, "the 1 XP cost was never taken").toBe(0);
  });

  it("is NOT offered at 0 XP — the cost is asked where the ability is OFFERED", () => {
    // The negative control for the whole `availableWhile` mechanism. Put the gear
    // straight into play so the on-play XP is never gained, and the [Equip] must
    // not appear at all: a resolver that refused would already have taken the
    // cost, and a resolver that did not refuse would attach for free.
    const gear = realGearInstance(SHEPHERDS_HEIRLOOM);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer", name: "Wearer" })];

    expect(state.players[0]!.xp).toBe(0);
    expect(activationsOf(state, gear.instanceId), "the [Equip] was offered with no XP to pay it").toHaveLength(0);

    const funded = { ...state, players: [{ ...state.players[0]!, xp: 1 }, state.players[1]!] as GameState["players"] };
    expect(activationsOf(funded, gear.instanceId), "1 XP was not enough — the gate reads the wrong number").toHaveLength(1);
  });

  it("re-equipping costs another XP each time, and stops when the XP runs out", () => {
    // No exhaust is printed, so the ability repeats — what BOUNDS it is the XP.
    const gear = realGearInstance(SHEPHERDS_HEIRLOOM);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "a", name: "A" }), makeUnit({ instanceId: "b", name: "B" })];
    const funded = { ...state, players: [{ ...state.players[0]!, xp: 2 }, state.players[1]!] as GameState["players"] };

    const once = passUntilSettled(
      accept(funded, activationsOf(funded, gear.instanceId).find((a) => a.targetUnitInstanceId === "a"), "equip A"),
    );
    expect(once.players[0]!.xp).toBe(1);
    const twice = passUntilSettled(
      accept(once, activationsOf(once, gear.instanceId).find((a) => a.targetUnitInstanceId === "b"), "re-equip to B"),
    );

    expect(twice.players[0]!.activeGear[0]!.attachedToInstanceId, "the move did not happen").toBe("b");
    expect(twice.players[0]!.xp).toBe(0);
    expect(activationsOf(twice, gear.instanceId), "a third attach was offered with no XP left").toHaveLength(0);
  });
});

describe("Ultrasoft Poro (UNL-160): [Exhaust] play two Birds, only while at a battlefield", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(ULTRASOFT_PORO))).toBe(true);
  });

  function poroAt(where: "battlefield" | "base") {
    const state = makeState({ phase: "Action" });
    const poro = realUnitInstance(ULTRASOFT_PORO);
    if (where === "base") state.players[0]!.baseUnits = [poro];
    else state.battlefields[0]!.units = { p1: [poro] };
    return { state, poroId: poro.instanceId };
  }

  it("places two Birds, asking where each one goes", () => {
    const { state, poroId } = poroAt("battlefield");
    // bf2 is CONTROLLED, so it is a legal destination and bf1 (merely occupied)
    // is not — 355.2.a's "a Battlefield the controller controls".
    state.battlefields[1]!.controllerId = "p1";

    const activated = accept(state, activationsOf(state, poroId)[0], "the Poro's ability");
    expect(offeredIds(activated).sort(), "the destinations offered are not base + controlled battlefields").toEqual(
      ["base", "bf2"].sort(),
    );

    const first = answer(activated, "base");
    // Still asking: two Birds, two questions.
    expect(pendingDecision(first), "the second Bird was never asked about").toBeDefined();
    const both = answer(first, "bf2");

    expect(birdsOf(both, 0), "two Birds were not placed").toHaveLength(2);
    expect(names(both.players[0]!.baseUnits)).toEqual(["Bird"]);
    expect(names(both.battlefields[1]!.units["p1"] ?? [])).toEqual(["Bird"]);
    expect(unitAnywhere(both, poroId)!.exhausted, "the exhaust cost was never taken").toBe(true);
  });

  it("is NOT offered while the Poro is in base — 'use only while I'm at a battlefield'", () => {
    // The restriction lives in `availableWhile`, so it is asked by the enumerator
    // AND the validator. A guard inside the resolver would have taken the exhaust
    // first and the player would have paid for nothing.
    const { state, poroId } = poroAt("base");
    expect(activationsOf(state, poroId), "a Poro at home was offered the ability").toHaveLength(0);
  });

  it("is NOT offered while it is exhausted", () => {
    const { state, poroId } = poroAt("battlefield");
    const exhausted = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { p1: [{ ...bf.units["p1"]![0]!, exhausted: true }] } } : bf,
      ),
    };
    expect(activationsOf(exhausted, poroId), "an exhausted source paid its exhaust twice").toHaveLength(0);
  });

  it("offers base only when nothing is controlled, and both Birds still arrive", () => {
    // One option means `advanceDecisions` executes it without ever showing it, so
    // the ordinary case costs the player nothing — assert the Birds land anyway.
    const { state, poroId } = poroAt("battlefield");
    const settled = passUntilSettled(accept(state, activationsOf(state, poroId)[0], "the Poro's ability"));

    expect(pendingDecision(settled), "a one-option question was left standing").toBeUndefined();
    expect(names(settled.players[0]!.baseUnits)).toEqual(["Bird", "Bird"]);
  });
});

describe("Divining Shells (UNL-161): [Vision], then Kill this + [Exhaust] for +2 Might", () => {
  it("is reported implemented and whole", () => {
    expect(isCardImplemented(registry.get(DIVINING_SHELLS))).toBe(true);
    expect(partialImplementationNote(registry.get(DIVINING_SHELLS)), "it is listed as partial").toBeUndefined();
  });

  function shellsInHand() {
    const gear = realGearInstance(DIVINING_SHELLS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [gear];
    state.players[0]!.channeled = runesFor(DIVINING_SHELLS);
    state.players[0]!.deck = [makeUnit({ name: "Top" }), makeUnit({ name: "Second" })];
    return { state, gearId: gear.instanceId };
  }

  it("asks the [Vision] question on play, and recycling puts the top card on the BOTTOM", () => {
    // `[Vision]` does not fire for a Gear anywhere in the engine — `applyVision`
    // is called only from `dispatchOnPlayUnit`, and both the enumerator and the
    // validator gate `visionRecycle` on `card.kind === "Unit"`. So without this
    // card's own self-trigger the keyword is printed and inert.
    const { state, gearId } = shellsInHand();
    const played = accept(state, castsOf(state, gearId)[0], "Divining Shells");
    const settled = passUntilSettled(played);

    expect(pendingDecision(settled), "the [Vision] question was never raised").toBeDefined();
    expect(offeredIds(settled).sort()).toEqual(["keep", "recycle"]);

    const recycled = answer(settled, "recycle");
    expect(names(recycled.players[0]!.deck), "the top card did not go to the bottom").toEqual(["Second", "Top"]);
  });

  it("declining leaves the deck untouched — the negative control on 'you MAY'", () => {
    const { state, gearId } = shellsInHand();
    const settled = passUntilSettled(accept(state, castsOf(state, gearId)[0], "Divining Shells"));
    const kept = answer(settled, "keep");

    expect(names(kept.players[0]!.deck), "declining still reordered the deck").toEqual(["Top", "Second"]);
  });

  it("asks NOTHING on an empty deck", () => {
    const { state, gearId } = shellsInHand();
    state.players[0]!.deck = [];
    const settled = passUntilSettled(accept(state, castsOf(state, gearId)[0], "Divining Shells"));

    expect(pendingDecision(settled), "an unanswerable look was offered").toBeUndefined();
  });

  it("kills itself to give a unit +2 Might this turn", () => {
    const gear = realGearInstance(DIVINING_SHELLS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };

    const use = activationsOf(state, gear.instanceId).find((a) => a.targetUnitInstanceId === "mine");
    const after = passUntilSettled(accept(state, use, "the Shells' ability"));

    expect(unitAnywhere(after, "mine")!.mightThisTurn, "the +2 never landed").toBe(2);
    expect(after.players[0]!.activeGear, "the gear survived paying its own cost").toHaveLength(0);
    expect(names(after.players[0]!.trash), "'Kill this' did not put it in the trash").toContain("Divining Shells");
  });

  it("reaches a unit in EITHER base and on either side — 'a unit', not 'a unit at a battlefield'", () => {
    const gear = realGearInstance(DIVINING_SHELLS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", name: "Theirs" })];

    const offered = activationsOf(state, gear.instanceId).map((a) => a.targetUnitInstanceId).sort();
    expect(offered, "355.9.b's bare noun did not reach both bases").toEqual(["mine", "theirs"]);
  });

  it("is NOT offered while exhausted — the exhaust half of the cost is real", () => {
    // `Kill this, [Exhaust]:` prints BOTH, and the exhaust is not redundant: it
    // is what stops a Shells that something else exhausted from being cashed in.
    const gear = { ...realGearInstance(DIVINING_SHELLS), exhausted: true };
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];

    expect(activationsOf(state, gear.instanceId), "an exhausted Shells was offered").toHaveLength(0);
  });
});

describe("Enthralling Protector (UNL-162): Spend 2 XP: [Buff] me", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(ENTHRALLING_PROTECTOR))).toBe(true);
  });

  function protectorWith(xp: number) {
    const state = makeState({ phase: "Action" });
    const unit = realUnitInstance(ENTHRALLING_PROTECTOR);
    state.battlefields[0]!.units = { p1: [unit] };
    state.players[0]!.xp = xp;
    return { state, unitId: unit.instanceId };
  }

  it("spends 2 XP and buffs itself", () => {
    const { state, unitId } = protectorWith(2);
    const after = passUntilSettled(accept(state, activationsOf(state, unitId)[0], "the Protector's ability"));

    expect(unitAnywhere(after, unitId)!.buffed, "the buff never landed").toBe(true);
    expect(after.players[0]!.xp, "the 2 XP was never spent").toBe(0);
  });

  it("is NOT offered at 1 XP — the price is 2, not 'some'", () => {
    // The negative control that distinguishes a real gate from `xp > 0`.
    const { state, unitId } = protectorWith(1);
    expect(activationsOf(state, unitId), "it was offered at half price").toHaveLength(0);

    const none = protectorWith(0);
    expect(activationsOf(none.state, none.unitId), "it was offered for free").toHaveLength(0);
  });

  it("does not exhaust, so it repeats — and the XP is what stops it", () => {
    // No exhaust is printed. What bounds the ability is the resource: 4 XP buys
    // two activations and no more. The second buff is a 702.3.a no-op on an
    // already-buffed unit and the XP is still spent, which is correct — 416 pays
    // a cost when the ability is USED.
    const { state, unitId } = protectorWith(4);
    const once = passUntilSettled(accept(state, activationsOf(state, unitId)[0], "first activation"));
    expect(once.players[0]!.xp).toBe(2);
    expect(unitAnywhere(once, unitId)!.exhausted, "an exhaust nobody printed was taken").toBe(false);

    const twice = passUntilSettled(accept(once, activationsOf(once, unitId)[0], "second activation"));
    expect(twice.players[0]!.xp).toBe(0);
    expect(activationsOf(twice, unitId), "a third activation was offered with no XP left").toHaveLength(0);
  });
});

describe("Bandle Soldier (UNL-151): REFUSED this wave, and pinned as refused", () => {
  /**
   * "[Level 3][>] I enter ready."
   *
   * Not written, and the refusal is recorded as a test so that implementing it
   * fails here rather than silently leaving this note stale.
   *
   * **"I enter ready" is a REPLACEMENT, not a readying**, and `engine/deploy.ts`
   * says so in as many words beside the seven cards that already do it: an
   * on-play `readyUnit` trigger would leave the unit EXHAUSTED through the whole
   * response window the held trigger opens, would fire `unitReadied` (paying out
   * Pirate's Haven for a readying the rules say never happened), and would be
   * blockable by Mageseeker Warden. Three separate agents reached that conclusion
   * independently before this one.
   *
   * **The rules agree that this belongs at ENTRY and not on the chain.** 727.1.b
   * makes a Dependent Keyword's ability "Inactive on the card … until the
   * Condition is met, when it becomes Active", and 727.1.c.2 says "Passive
   * Abilities begin applying at the same time the Dependent Keyword becomes
   * true" — so "I enter ready" is simply true, or not, at the moment the unit
   * arrives. `[Level 3]`'s condition is 728-733's XP counter, read then.
   *
   * So the fix is one `case` in `deploy.conditionalEntersReady` reading
   * `state.players[playerIndex].xp >= 3`, plus the defId in `playCardDefIds()` —
   * exactly the shape UNL-197 Towering Pairofant already has. `deploy.ts` is
   * shared, so this wave does not own it.
   */
  it("still reports unimplemented, and NOT because of a missing effect entry", () => {
    const def = registry.get(BANDLE_SOLDIER);
    expect(isCardImplemented(def), "someone implemented it — delete this block and the note in deploy.ts").toBe(false);
    // **This used to assert the `[Level]` keyword note, and that note is gone.**
    // `[Level]` left `UNIMPLEMENTED_KEYWORDS` on 2026-08-09: it is implemented per
    // card via `atLevel`, so a keyword-level flag was greying cards that gate
    // correctly — and, worse, keeping all 16 out of generated decks, since
    // `deck-generator` filters on `isCardImplemented`.
    //
    // The replacement asserts the REAL reason this card is unimplemented, which is
    // stronger than the keyword note ever was: nothing is registered for it at
    // all. The old assertion would have kept passing on the strength of the
    // keyword even after someone wrote the card, which is the failure this block
    // exists to prevent.
    expect(implementingModule(BANDLE_SOLDIER), "an effect is registered now — delete this block and the deploy.ts note").toBeUndefined();
    expect(partialImplementationNote(def), "it is now merely PARTIAL, not unwritten — this pin needs rewriting").toBeUndefined();
  });

  it("does not enter ready today, at any XP", () => {
    // The behavioural half — so "unimplemented" is a fact about the board and not
    // just about a coverage table.
    const soldier = realUnitInstance(BANDLE_SOLDIER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [soldier];
    state.players[0]!.channeled = runesFor(BANDLE_SOLDIER);
    state.players[0]!.xp = 3;

    const played = passUntilSettled(accept(state, castsOf(state, soldier.instanceId)[0], "Bandle Soldier"));
    expect(unitAnywhere(played, soldier.instanceId)!.exhausted, "it entered ready — the refusal is stale").toBe(true);
  });
});
