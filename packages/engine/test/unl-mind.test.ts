import { describe, expect, it } from "vitest";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { recordConquest } from "../src/engine/scoring.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { beginCombatAt, makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * The Unleashed (UNL) Mind cards — effects/mind.ts.
 *
 * **Everything here drives a real executor** — `executePlayCard` plus
 * `executePassFocus` for the Spell, `recordConquest` for the conquest, the real
 * Cleanup via `beginCombatAt` for the attack trigger, and `destroyUnit` for the
 * two death families. Never a resolver by hand: a resolver called directly passes
 * whether or not the registry entry exists, whether or not the dispatch hop
 * forwards its fields, and whether or not the card is reachable at all, which is
 * how a card ships paying its cost and doing nothing behind a green test.
 *
 * Every assertion here was run against the file with the card's registry entry
 * commented out before it was kept, and each one fails there. A test that cannot
 * be made to fail has measured nothing.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and being
 * edited by other agents in this tree — the same call sfd-mind.test.ts records.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const unitCard = (defId: string): UnitInstance => card(defId) as UnitInstance;
const gearCard = (defId: string): GearInstance => card(defId) as GearInstance;

const ICEVALE_ARCHER = "UNL-065"; // Unit, 2 Energy 2 Might — "when I attack, you may pay [1]..."
const RUINED_REX = "UNL-067"; // Unit, 6 Energy + 1 Mind, 6 Might — "[Deathknell] Deal 4 to an enemy unit."
const SPECTRAL_CENTAUR = "UNL-068"; // Unit, 6 Energy 5 Might — "when another friendly unit dies..."
const TURN_TO_DUST = "UNL-070"; // Spell, 2 Energy — "Give a gear [Temporary]."
const PLUNDERING_PORO_UNL = "UNL-222"; // Unit, 2 Energy 2 Might — the Overnumbered reprint
const MUSHROOM_POUCH = "OGN-101"; // Gear, Mind, 2 Energy — a real gear to point Turn to Dust at
const GARBAGE_GRABBER = "OGN-099"; // Gear, Mind, 2 Energy — a second one, so "a gear" is a real choice

/** Ready Mind runes, ids distinct across a whole test so a payment can never
 *  accidentally name the same rune for Energy and for Power. */
function mindRunes(count: number, prefix = "r"): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, domain: "Mind" as const, state: "Ready" as const }));
}

/** Plays a card through the REAL executor, paying out of the actor's channeled
 *  pool — Energy from the front, Power from the back, so the two never name the
 *  same rune. */
function play(
  state: GameState,
  playerIndex: 0 | 1,
  played: CardInstance,
  extra: Partial<Parameters<typeof executePlayCard>[1]> = {},
): GameState {
  const actor = state.players[playerIndex]!;
  const { energyCost, powerCost } = computeEffectiveCost(
    actor.floatingEnergy,
    actor.floatingPower,
    "energyCost" in played ? played.energyCost : 0,
    "powerCost" in played ? played.powerCost : 0,
    "powerDomain" in played ? played.powerDomain : null,
  );
  const pool = actor.channeled.filter((r) => r.state === "Ready");
  return executePlayCard(state, {
    type: "PlayCard",
    playerIndex,
    card: played,
    payment: {
      energyRunes: pool.slice(0, energyCost).map((r) => r.id),
      powerRunes: pool.slice(pool.length - powerCost).map((r) => r.id),
    },
    ...extra,
  });
}

/** Two consecutive passes per chain item, which is what actually resolves a Spell
 *  (340/343). A Spell that is only `executePlayCard`ed has done nothing but go on
 *  the chain. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && !next.chainOpen; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  if (!next.chainOpen) throw new Error("resolveChain: the chain never reopened");
  return next;
}

/** The gear as the board holds it, whichever player has it. Never the object
 *  handed to `makePlayer` — that one is a snapshot from before the spell ran and
 *  would read "no keywords" forever. */
function gearOnBoard(state: GameState, instanceId: string): GearInstance | undefined {
  for (const player of state.players) {
    const found = player.activeGear.find((g) => g.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

/** The unit as the board holds it, wherever it stands — same reasoning. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const goldTokens = (state: GameState, playerIndex: 0 | 1): GearInstance[] =>
  state.players[playerIndex]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

const readyRunes = (state: GameState, playerIndex: 0 | 1): number =>
  state.players[playerIndex]!.channeled.filter((r) => r.state === "Ready").length;

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

describe("Turn to Dust (UNL-070): give a gear [Temporary]", () => {
  /** The caster holding the spell, with one gear on each side of the table — so
   *  "a gear", unqualified, has to reach the opponent's. */
  function dustState(): { state: GameState; spell: CardInstance; mine: GearInstance; theirs: GearInstance } {
    const spell = card(TURN_TO_DUST);
    const mine = gearCard(GARBAGE_GRABBER);
    const theirs = gearCard(MUSHROOM_POUCH);
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", { hand: [spell], channeled: mindRunes(4), activeGear: [mine] }),
        makePlayer("p2", { activeGear: [theirs] }),
      ],
    });
    return { state, spell, mine, theirs };
  }

  it("is OFFERED against BOTH players' gear — the enumerator fans one variant per gear", () => {
    // The assertion that separates "implemented" from "registered and inert": a
    // `kind: "gear"` spec with no `owner` has to enumerate both sides, and a
    // resolver test alone could not tell that apart from a card that is never
    // castable at all.
    const { state, spell, mine, theirs } = dustState();

    const plays = playsOf(state, spell.instanceId);

    expect(plays.length, "no play of Turn to Dust was enumerated at all").toBeGreaterThan(0);
    expect(new Set(plays.map((p) => p.targetPermanentInstanceId))).toEqual(
      new Set([mine.instanceId, theirs.instanceId]),
    );
  });

  it("marks the chosen gear Temporary through a real cast, and leaves the other alone", () => {
    const { state, spell, mine, theirs } = dustState();

    const after = resolveChain(play(state, 0, spell, { targetPermanentInstanceId: theirs.instanceId }));

    expect(gearOnBoard(after, theirs.instanceId)?.keywords.Temporary, "the gear was not made Temporary").toBe(1);
    expect(gearOnBoard(after, mine.instanceId)?.keywords.Temporary, "'a gear' is singular").toBeUndefined();
  });

  it("the mark is the one 816 kills — the gear dies in ITS controller's Beginning Phase, not the caster's", () => {
    // The end-to-end half, and the half a keyword write alone cannot prove: the
    // grant is only worth anything if `killTemporaryPermanents` reads that exact
    // field. It is also the card's whole tempo — 816 says "at the start of THIS
    // PERMANENT'S CONTROLLER'S Beginning Phase", so an opponent's gear survives
    // until their turn comes round.
    const { state, spell, theirs } = dustState();
    const cast = resolveChain(play(state, 0, spell, { targetPermanentInstanceId: theirs.instanceId }));

    const casterTurn = runBeginning({ ...cast, phase: "Beginning", activePlayerIndex: 0 });
    expect(gearOnBoard(casterTurn, theirs.instanceId), "it died on the wrong player's turn").toBeDefined();

    const victimTurn = runBeginning({ ...cast, phase: "Beginning", activePlayerIndex: 1 });
    expect(gearOnBoard(victimTurn, theirs.instanceId), "816 never killed it").toBeUndefined();
    expect(victimTurn.players[1]!.trash.map((c) => c.instanceId)).toContain(theirs.instanceId);
  });
});

describe("Ruined Rex (UNL-067): [Deathknell] deal 4 to an enemy unit", () => {
  /** The Rex at a battlefield, with two enemy units — one at a battlefield and
   *  one in BASE, since "an enemy unit" prints no location (355.9.b). */
  function rexState(): { state: GameState; rex: UnitInstance; atField: UnitInstance; atBase: UnitInstance } {
    const rex = unitCard(RUINED_REX);
    const atField = makeUnit({ name: "Front Line", might: 9 });
    const atBase = makeUnit({ name: "Home Guard", might: 9 });
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1"), makePlayer("p2", { baseUnits: [atBase] })],
    });
    state.battlefields[0]!.units = { p1: [rex], p2: [atField] };
    return { state, rex, atField, atBase };
  }

  it("offers every enemy unit, base included, and deals 4 to the chosen one", () => {
    const { state, rex, atField, atBase } = rexState();

    const asked = resolveHeldTriggers(destroyUnit(state, rex.instanceId));

    const question = pendingDecision(asked);
    expect(question, "the Deathknell parked no question at all").toBeDefined();
    expect(optionsFor(asked, question!).map((o) => o.instanceId).sort()).toEqual(
      [atField.instanceId, atBase.instanceId].sort(),
    );

    const after = answerDecision(asked, question!.id, atBase.instanceId)!;

    expect(unitOnBoard(after, atBase.instanceId)?.damage, "the Deathknell dealt nothing").toBe(4);
    expect(unitOnBoard(after, atField.instanceId)?.damage, "it hit both").toBe(0);
  });

  it("never offers a FRIENDLY unit — 'an ENEMY unit', measured from the dead Rex's side", () => {
    const { state, rex } = rexState();
    const ally = makeUnit({ name: "Ally", might: 9 });
    state.players[0]!.baseUnits = [ally];

    const asked = resolveHeldTriggers(destroyUnit(state, rex.instanceId));

    expect(optionsFor(asked, pendingDecision(asked)!).map((o) => o.instanceId)).not.toContain(ally.instanceId);
  });

  it("asks nothing at all when the opponent has no units (055)", () => {
    const { state, rex } = rexState();
    state.players[1]!.baseUnits = [];
    state.battlefields[0]!.units = { p1: [rex] };

    const after = resolveHeldTriggers(destroyUnit(state, rex.instanceId));

    expect(after.pendingDecisions).toHaveLength(0);
  });

  it("a lone enemy is taken without ever prompting (advanceDecisions)", () => {
    const { state, rex, atField } = rexState();
    state.players[1]!.baseUnits = [];

    const after = resolveHeldTriggers(destroyUnit(state, rex.instanceId));

    expect(after.pendingDecisions).toHaveLength(0);
    expect(unitOnBoard(after, atField.instanceId)?.damage).toBe(4);
  });
});

describe("Spectral Centaur (UNL-068): when another friendly unit dies, +2 Might this turn", () => {
  /** The Centaur in base with two friendly bodies to lose and one enemy. */
  function centaurState(): {
    state: GameState;
    centaur: UnitInstance;
    allyA: UnitInstance;
    allyB: UnitInstance;
    enemy: UnitInstance;
  } {
    const centaur = unitCard(SPECTRAL_CENTAUR);
    const allyA = makeUnit({ name: "Ally A" });
    const allyB = makeUnit({ name: "Ally B" });
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { baseUnits: [centaur, allyA, allyB] }), makePlayer("p2", { baseUnits: [enemy] })],
    });
    return { state, centaur, allyA, allyB, enemy };
  }

  it("grows by 2 when a friendly unit dies", () => {
    const { state, centaur, allyA } = centaurState();

    const after = resolveHeldTriggers(destroyUnit(state, allyA.instanceId));

    expect(unitOnBoard(after, centaur.instanceId)?.mightThisTurn, "the death-watch never fired").toBe(2);
  });

  it("is UNCAPPED — nothing here says 'the first time each turn'", () => {
    // The one thing that separates him from Wraith of Echoes, whose identical
    // shape carries a per-turn flag. Two deaths, +4.
    const { state, centaur, allyA, allyB } = centaurState();

    const once = resolveHeldTriggers(destroyUnit(state, allyA.instanceId));
    const twice = resolveHeldTriggers(destroyUnit(once, allyB.instanceId));

    expect(unitOnBoard(twice, centaur.instanceId)?.mightThisTurn).toBe(4);
  });

  it("does not fire for an ENEMY unit's death — 'FRIENDLY' is relative to the listener", () => {
    const { state, centaur, enemy } = centaurState();

    const after = resolveHeldTriggers(destroyUnit(state, enemy.instanceId));

    expect(unitOnBoard(after, centaur.instanceId)?.mightThisTurn).toBe(0);
  });

  it("does not pay an OPPONENT's Centaur for a death on our side", () => {
    const { state, allyA } = centaurState();
    const theirCentaur = unitCard(SPECTRAL_CENTAUR);
    state.players[1]!.baseUnits = [theirCentaur];

    const after = resolveHeldTriggers(destroyUnit(state, allyA.instanceId));

    expect(unitOnBoard(after, theirCentaur.instanceId)?.mightThisTurn).toBe(0);
  });
});

describe("Icevale Archer (UNL-065): when I attack, pay [1] for -1 Might here", () => {
  /** The Archer and an enemy at bf1, with Energy in the pool. Both sides present,
   *  which is what makes the Showdown a COMBAT and hands out designations. */
  function archerState(runes = 2): { state: GameState; archer: UnitInstance; enemy: UnitInstance } {
    const archer = unitCard(ICEVALE_ARCHER);
    const enemy = makeUnit({ name: "Enemy", might: 4 });
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { channeled: mindRunes(runes) }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p1: [archer], p2: [enemy] };
    return { state, archer, enemy };
  }

  it("asks when she ATTACKS, and paying gives the chosen unit -1 Might this turn", () => {
    // Through the real Cleanup: `beginCombatAt` contests the battlefield and lets
    // the Showdown hand out the designations, so a card registered for the wrong
    // side or never dispatched at all fails here rather than passing on a
    // hand-built event.
    const { state, enemy } = archerState();

    const asked = beginCombatAt(state, "bf1", 0);

    const question = pendingDecision(asked);
    expect(question, "the attack trigger parked no question at all").toBeDefined();

    const after = answerDecision(asked, question!.id, enemy.instanceId)!;

    expect(unitOnBoard(after, enemy.instanceId)?.mightThisTurn, "the debuff never landed").toBe(-1);
    expect(readyRunes(after, 0), "the [1] was not paid").toBe(readyRunes(asked, 0) - 1);
  });

  it("offers HER OWN side too — 'a unit here' carries no owner word", () => {
    const { state, archer, enemy } = archerState();

    const asked = beginCombatAt(state, "bf1", 0);

    const options = optionsFor(asked, pendingDecision(asked)!);
    // "Decline" is the only option carrying no instance id — a "you may" the
    // engine could answer for you is not a "you may", so it is always present.
    expect(options.map((o) => o.id)).toContain("decline");
    expect(options.filter((o) => o.instanceId).map((o) => o.instanceId).sort()).toEqual(
      [archer.instanceId, enemy.instanceId].sort(),
    );
  });

  it("declining costs nothing", () => {
    const { state, enemy } = archerState();
    const asked = beginCombatAt(state, "bf1", 0);

    const after = answerDecision(asked, pendingDecision(asked)!.id, "decline")!;

    expect(unitOnBoard(after, enemy.instanceId)?.mightThisTurn).toBe(0);
    expect(readyRunes(after, 0), "declining still spent the Energy").toBe(readyRunes(asked, 0));
  });

  it("drops the question when she has left the fight — 'here' is where she stands", () => {
    // "Here" is a referent read from the ability's source (359.3.f.1) and checked
    // on EXECUTION of the instruction (359.3.f.2). The rules' worked example is an
    // opponent answering Yasuo - Remorseful's attack trigger with Fight or Flight:
    // "'here' is no longer the battlefield where combat is ongoing and the attack
    // trigger mistargets". So an Archer moved out asks nothing at all, rather than
    // reaching back into the fight she left.
    //
    // The response window has to be OPEN, which `beginCombatAt` closes in the same
    // call — hence the raw Cleanup here, and the chain assertion, without which "no
    // question" reads the same whether she mistargeted or never triggered.
    const { state, archer, enemy } = archerState();
    const held = runCleanup({
      ...state,
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, contestedByIndex: 0 as const } : bf)),
    });
    expect(
      held.spellChain.flatMap((e) => (e.kind === "trigger" ? [e.listenerDefId] : [])),
      "the trigger was never placed",
    ).toContain(ICEVALE_ARCHER);

    const walked = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: [] } }
          : bf.id === "bf2"
            ? { ...bf, units: { p1: [archer], p2: [makeUnit({ name: "Bystander", might: 4 })] } }
            : bf,
      ),
    };

    const after = resolveHeldTriggers(walked);

    expect(pendingDecision(after), "she still asked, from a battlefield she had left").toBeUndefined();
    expect(unitOnBoard(after, enemy.instanceId)?.mightThisTurn, "the fight she left was still chilled").toBe(0);
  });

  it("does NOT fire when she DEFENDS — 'when I attack', not 'attack or defend'", () => {
    // p2 applies Contested, so the Archer is the Defender. The clause that
    // separates her from Ahri - Inquisitive and Ezreal - Dashing.
    const { state, enemy } = archerState();

    const after = beginCombatAt(state, "bf1", 1);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(unitOnBoard(after, enemy.instanceId)?.mightThisTurn).toBe(0);
  });

  it("asks nothing when the Energy cannot be paid — never offer what cannot be bought", () => {
    const { state, enemy } = archerState(0);

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(unitOnBoard(after, enemy.instanceId)?.mightThisTurn).toBe(0);
  });
});

describe("Plundering Poro, Overnumbered (UNL-222): when I conquer, a Gold gear token", () => {
  /** The Poro standing at `battlefieldId`, ready to be the body that takes it. */
  function poroState(battlefieldId: string): GameState {
    const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
    state.battlefields.find((b) => b.id === battlefieldId)!.units = { p1: [unitCard(PLUNDERING_PORO_UNL)] };
    return state;
  }

  it("makes ONE exhausted Gold token on its controller's conquest", () => {
    // `recordConquest` is the real scoring path — it HOLDS the trigger (383), so
    // `resolveHeldTriggers` is what actually resolves it.
    const after = resolveHeldTriggers(recordConquest(poroState("bf1"), 0, "bf1"));

    const gold = goldTokens(after, 0);
    expect(gold, "the reprint's conquer trigger produced no Gold token").toHaveLength(1);
    expect(gold[0]!.exhausted, "the card prints 'exhausted'").toBe(true);
    expect(goldTokens(after, 1), "the opponent was paid instead").toHaveLength(0);
  });

  it("does not fire for a battlefield it is not standing at ('when I conquer')", () => {
    const after = resolveHeldTriggers(recordConquest(poroState("bf1"), 0, "bf2"));
    expect(goldTokens(after, 0)).toHaveLength(0);
  });
});

describe("coverage sees all five", () => {
  it("reports each registered card as implemented", () => {
    for (const defId of [ICEVALE_ARCHER, RUINED_REX, SPECTRAL_CENTAUR, TURN_TO_DUST, PLUNDERING_PORO_UNL]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is not seen as implemented`).toBe(true);
    }
  });
});
