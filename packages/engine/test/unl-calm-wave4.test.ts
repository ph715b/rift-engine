import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { answerDecision, pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { destroyUnit, stunUnits, removeUnitAnywhere } from "../src/engine/effect-helpers.js";
import { deathTriggerDefIds, eventTriggerDefIds, eventTriggerFor } from "../src/engine/triggers.js";
import { unitTriggerDefIds } from "../src/engine/unit-triggers.js";
import { gearEntersExhausted } from "../src/engine/deploy.js";
import { implementingModules, isCardImplemented } from "../src/engine/coverage.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Unleashed's FOURTH Calm wave — engine/effects/calm.ts.
 *
 * Same discipline as wave 3's file: drive the real path wherever one exists
 * (`legalActions` to build the action, `submit` to take it, focus passes to
 * resolve the chain, `answerDecisions` to answer what it asks), because a
 * resolver called directly passes whether or not the dispatch hop that reaches it
 * in a game carries what it needs.
 *
 * **Every card has a negative control, and every negative asserts its own
 * positive first.** "Nothing happened" is exactly what an inert card looks like,
 * so a negative that does not first prove the fixture can fire proves nothing.
 *
 * Three of these cards are HALF written on purpose, each blocked on one line in a
 * file this pass does not own. Each has a test asserting the WRONG answer, so
 * closing the gap fails here rather than changing behaviour silently:
 *
 *   - Honeyfruit's "This enters exhausted" (`deploy.GEAR_ENTERING_EXHAUSTED`)
 *   - Nami's additional cost (`card-effects.OPTIONAL_POWER_COSTS`)
 *   - Nami's delayed trigger surviving her death (391) — see her block
 */

const registry = defaultCardRegistry();

const HONEYFRUIT = "UNL-049"; // enters exhausted; [Exhaust]: [Add] rainbow; [Level 6] adds an Energy
const IVERN = "UNL-051"; // on play or hold: look 3, reveal a unit, buff if it was a Bird/Cat/Dog/Poro
const NAMI = "UNL-052"; // optional [Calm] cost -> stun; when I hold, ready+buff the next unit you play
const SCUTTLE_CRAB = "UNL-053"; // play: draw 1. [Deathknell]: gain 1 XP
const VEX_MOCKING = "UNL-055"; // when you stun an enemy unit at a battlefield, you may move me there

const BACK_OFF = "UNL-042"; // Calm 3E — "Stun a unit", scope anywhere. The real stun path for Vex.

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n: number, domain: RuneCard["domain"] = "Calm") =>
  Array.from({ length: n }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties or a question blocks it. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  return current;
}

const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/**
 * Plays `defId` from player 0's hand and settles the chain.
 *
 * No destination argument, deliberately: `board-restrictions` only lets a unit be
 * played to a battlefield under `[Ganking]` or an open one, so every unit in this
 * file lands in BASE and a test naming a battlefield would silently fall back to
 * base and then assert against an empty battlefield. Measured — the first draft of
 * this file did exactly that.
 */
function play(state: GameState, defId: string): GameState {
  const candidates = playsOf(state, defId);
  expect(candidates.length, `${defId} was not playable — the fixture cannot pay for it`).toBeGreaterThan(0);
  return settle(accept(state, candidates[0]!));
}

/** Player 0 in their Beginning Phase, alone at bf1 with `units` — what
 *  `scoring.isHeldBy` reads as a hold: presence, control, and no opponent. */
function holdingBf1(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { p1: units };
  state.battlefields[0]!.controllerId = "p1";
  return state;
}

const unitsAtBf = (state: GameState, battlefieldId: string, playerId = "p1"): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const everyUnit = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
];

const findUnit = (state: GameState, instanceId: string): UnitInstance | undefined =>
  everyUnit(state).find((u) => u.instanceId === instanceId);

/** Player 0's unit with this printed name, wherever it is standing. */
const ownUnitNamed = (state: GameState, name: string): UnitInstance | undefined =>
  [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => bf.units["p1"] ?? [])].find((u) => u.name === name);

// ---------------------------------------------------------------------------

describe("Honeyfruit (UNL-049): [Exhaust]: [Add] rainbow, and an Energy at [Level 6]", () => {
  function withHoneyfruit(xp: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [realGearInstance(HONEYFRUIT)];
    state.players[0]!.xp = xp;
    return state;
  }

  const activation = (state: GameState) =>
    legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.activeGear[0]!.instanceId);

  it("adds one RAINBOW Power through the real activation path", () => {
    const state = withHoneyfruit(0);
    const action = activation(state);
    expect(action, "the ability was never offered — the seam is not reaching legal-actions").toBeDefined();

    const used = accept(state, action!);
    expect(used.players[0]!.floatingRainbowPower, "no rainbow Power arrived").toBe(1);
    // Rainbow, not domain-keyed: `floatingPower` is the wrong pool and putting it
    // there would silently make the Fruit a Calm-only source.
    expect(used.players[0]!.floatingPower).toEqual({});
    expect(used.players[0]!.activeGear[0]!.exhausted, "the exhaust cost was not paid").toBe(true);
  });

  it("adds NO Energy below 6 XP, and one at exactly 6 (824.1.b.1)", () => {
    // Each activation is built from ITS OWN state — an action naming a gear
    // instance from another state would be refused, and a refusal here would read
    // as the band being off.
    const below = withHoneyfruit(5);
    const under = accept(below, activation(below)!);
    expect(under.players[0]!.floatingEnergy, "the [Level 6] half fired at 5 XP").toBe(0);
    expect(under.players[0]!.floatingRainbowPower, "the base ability did not fire either — this negative proves nothing").toBe(1);

    // The positive control for that zero: one more XP and the same activation pays.
    const on = withHoneyfruit(6);
    const at = accept(on, activation(on)!);
    expect(at.players[0]!.floatingEnergy, "the [Level 6] half never fires").toBe(1);
    expect(at.players[0]!.floatingRainbowPower, "the levelled ability dropped the printed rainbow").toBe(1);
  });

  it("turns the band OFF again when XP is spent back below it (824.1.d)", () => {
    // Read fresh per activation, never latched. Two Fruits so the second is still
    // ready after the first has paid.
    const state = withHoneyfruit(6);
    state.players[0]!.activeGear = [realGearInstance(HONEYFRUIT), realGearInstance(HONEYFRUIT)];
    const first = accept(state, legalActions(state).find((a) => a.type === "ActivateAbility")!);
    expect(first.players[0]!.floatingEnergy, "the levelled band did not fire at 6 XP").toBe(1);

    const spent = { ...first, players: [{ ...first.players[0]!, xp: 2 }, first.players[1]!] as GameState["players"] };
    const second = accept(spent, legalActions(spent).find((a) => a.type === "ActivateAbility")!);
    expect(second.players[0]!.floatingEnergy, "the band stayed on after the XP was spent").toBe(1);
    expect(second.players[0]!.floatingRainbowPower, "the base ability stopped working too").toBe(2);
  });

  it("PINS THE GAP: 'This enters exhausted' is NOT implemented", () => {
    // `deploy.GEAR_ENTERING_EXHAUSTED` is the mechanism and it is a shared file.
    // Until the id is added there a Honeyfruit lands READY and can be tapped the
    // turn it is played, which is the whole of its printed drawback.
    expect(gearEntersExhausted(HONEYFRUIT), "the gap closed — delete this test and the PARTIAL coverage entry").toBe(false);
    // The positive control for the check itself: Iron Ballista is in that set, so
    // a `false` here would not merely mean "the function always says no".
    expect(gearEntersExhausted("OGN-017"), "the enters-exhausted check itself is broken").toBe(true);
  });

  it("is registered as a Gear ability through the domain-file seam", () => {
    expect(activatedAbilityFor(HONEYFRUIT)?.kind).toBe("Gear");
  });
});

// ---------------------------------------------------------------------------

describe("Ivern - Nurturer (UNL-051): look 3, reveal a unit, buff on a Bird/Cat/Dog/Poro", () => {
  const poro = () => makeUnit({ name: "Poro Friend", tags: ["Poro"] });
  const plain = (name: string) => makeUnit({ name, tags: ["Demacia"] });

  /** Player 0 holding Ivern, able to pay, with `deck` on top of their Main Deck. */
  function casterWith(deck: UnitInstance[]): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(IVERN)];
    state.players[0]!.channeled = runes(12);
    state.players[0]!.deck = [...deck];
    return state;
  }

  const handNames = (state: GameState) => state.players[0]!.hand.map((c) => c.name);

  it("draws the revealed unit and buffs, through a real PlayCard", () => {
    const state = casterWith([poro(), plain("Filler A"), plain("Filler B")]);
    const played = play(state, IVERN);

    const decision = pendingDecision(played);
    expect(decision?.kind, "Ivern's look never asked anything").toBe("UNL-051-reveal");

    // Explicit picks throughout: `answerDecisions`' default takes the FIRST
    // option, which here is "Decline" — a firing trigger would look identical to
    // a silent one.
    const answered = answerDecisions(played, (options, d) => {
      if (d.kind === "UNL-051-reveal") return options.find((o) => o.label === "Poro Friend")!.id;
      return options[0]!.id; // the buff question — Ivern is the only friendly unit
    });

    expect(handNames(answered), "the revealed unit was not drawn").toContain("Poro Friend");
    expect(answered.players[0]!.deck.map((c) => c.name), "the other two were not recycled to the bottom").toEqual([
      "Filler A",
      "Filler B",
    ]);
    expect(ownUnitNamed(answered, "Ivern - Nurturer")!.buffed, "the Poro branch did not buff").toBe(true);
  });

  it("draws but does NOT buff when the revealed unit carries none of the four tags", () => {
    const state = casterWith([plain("Untagged Recruit"), plain("Filler A"), plain("Filler B")]);
    const answered = answerDecisions(play(state, IVERN), (options, d) =>
      d.kind === "UNL-051-reveal" ? options.find((o) => o.label === "Untagged Recruit")!.id : options[0]!.id,
    );

    // The positive half first: the draw proves the ability ran at all, so the
    // absent buff below is a decision the card made rather than an inert card.
    expect(handNames(answered), "the reveal branch did not draw — this negative proves nothing").toContain("Untagged Recruit");
    expect(ownUnitNamed(answered, "Ivern - Nurturer")!.buffed, "an untagged reveal still buffed").toBe(false);
  });

  it("recycles all three and buffs nothing when the reveal is declined", () => {
    const state = casterWith([poro(), plain("Filler A"), plain("Filler B")]);
    const answered = answerDecisions(play(state, IVERN), (options) => options.find((o) => o.id === "decline")!.id);

    expect(handNames(answered), "a declined reveal still drew").not.toContain("Poro Friend");
    expect(answered.players[0]!.deck.map((c) => c.name), "'recycle the rest' skipped the decline branch").toEqual([
      "Poro Friend",
      "Filler A",
      "Filler B",
    ]);
    expect(ownUnitNamed(answered, "Ivern - Nurturer")!.buffed).toBe(false);
  });

  it("fires again on a HOLD, at the battlefield he is standing at", () => {
    const ivern = realUnitInstance(IVERN);
    const state = holdingBf1([ivern]);
    state.players[0]!.deck = [poro(), plain("Filler A"), plain("Filler B")];

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(pendingDecision(settled)?.kind, "the hold trigger never fired").toBe("UNL-051-reveal");

    const answered = answerDecisions(settled, (options, d) =>
      d.kind === "UNL-051-reveal" ? options.find((o) => o.label === "Poro Friend")!.id : options[0]!.id,
    );
    expect(answered.players[0]!.hand.map((c) => c.name)).toContain("Poro Friend");
    expect(unitsAtBf(answered, "bf1")[0]!.buffed).toBe(true);
  });

  it("does NOT fire for a battlefield he is not standing at — 'when I hold'", () => {
    // bf1 is held by an outpost while Ivern sits in BASE, which no `battlefieldId`
    // can match. The positive control is the test above, same fixture shape — and
    // the point of the outpost is that a hold really does happen here.
    //
    // Deliberately NOT "Ivern alone at an uncontrolled bf2": measured, that fires,
    // because the Beginning Phase gives him control of it and then scores it as a
    // hold. It is a legitimate second hold rather than a leak.
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.players[0]!.baseUnits = [realUnitInstance(IVERN)];
    state.players[0]!.deck = [poro(), plain("Filler A"), plain("Filler B")];

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points, "no hold happened at all — this negative proves nothing").toBeGreaterThan(0);
    expect(pendingDecision(settled), "his look fired for someone else's battlefield").toBeUndefined();
    expect(settled.players[0]!.hand, "he drew off a hold that was not his").toHaveLength(0);
  });

  it("does NOT fire while standing at a DIFFERENT battlefield from the one held", () => {
    // The base case above cannot see a "is he at a battlefield at all" mis-read —
    // measured: mutating his position check to `battlefieldId !== undefined`
    // survived it, because a unit in base has no battlefield either way. This is
    // the fixture that separates the two: Ivern IS at a battlefield, and it is not
    // the one being held.
    //
    // bf2 is not a hold because the OPPONENT is standing there too (469.2 /
    // `isHeldBy`), which is also why Ivern being alone at an uncontrolled
    // battlefield is the wrong fixture — that one becomes a second real hold.
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.battlefields[1]!.units = { p1: [realUnitInstance(IVERN)], p2: [makeUnit({ name: "Squatter" })] };
    state.players[0]!.deck = [poro(), plain("Filler A"), plain("Filler B")];

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points, "no hold happened at all — this negative proves nothing").toBe(1);
    expect(pendingDecision(settled), "he looked off a hold at another battlefield").toBeUndefined();
    expect(settled.players[0]!.hand, "he drew off a hold that was not his").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("Nami - Headstrong (UNL-052): when I hold, ready and buff the next unit you play", () => {
  /** Nami holding bf1, her trigger already resolved, back in the Action phase with
   *  a cheap unit in hand. */
  function armed(): { state: GameState; nami: UnitInstance } {
    const nami = realUnitInstance(NAMI);
    const held = resolveHeldTriggers(runBeginning(holdingBf1([nami])));
    const state: GameState = { ...held, phase: "Action" };
    state.players[0]!.hand = [spellInstance("OGN-052")]; // Stalwart Poro, 2 Energy, no triggers
    state.players[0]!.channeled = runes(8);
    return { state, nami };
  }

  /** How many of Nami's triggers are sitting on the chain — the difference
   *  between "did not trigger" and "triggered and resolved to nothing". */
  const namiTriggersHeld = (state: GameState) =>
    state.spellChain.filter((e) => e.kind === "trigger" && e.listenerDefId === NAMI).length;

  const poroInPlay = (state: GameState) =>
    [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => bf.units["p1"] ?? [])].find((u) => u.name === "Stalwart Poro");

  it("arms on the hold and READIES AND BUFFS the next unit played", () => {
    const { state, nami } = armed();
    expect(findUnit(state, nami.instanceId)!.abilityModesUsedThisTurn, "the hold did not arm her").toContain("UNL-052-armed");

    const played = play(state, "OGN-052");
    const poro = poroInPlay(played);
    expect(poro, "the unit was never played").toBeDefined();
    expect(poro!.exhausted, "the played unit was not readied").toBe(false);
    expect(poro!.buffed, "the played unit was not buffed").toBe(true);

    // The positive control for the "did not even trigger" assertion in the next
    // test: an ARMED Nami really does place a Pending Item, so a zero there means
    // something.
    expect(namiTriggersHeld(runCleanup(accept(state, playsOf(state, "OGN-052")[0]!))), "the trigger never reached the chain").toBe(1);
  });

  it("does NOTHING without the hold, and does not even TRIGGER", () => {
    // Same board, same play, no Beginning Phase. The positive control is the test
    // above; the only difference here is that the arm never happened.
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [realUnitInstance(NAMI)] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.hand = [spellInstance("OGN-052")];
    state.players[0]!.channeled = runes(8);

    const played = play(state, "OGN-052");
    const poro = poroInPlay(played);
    expect(poro, "the unit was never played — this negative proves nothing").toBeDefined();
    expect(poro!.exhausted, "an unarmed Nami still readied a unit").toBe(true);
    expect(poro!.buffed, "an unarmed Nami still buffed a unit").toBe(false);

    // **And no Pending Item was ever placed.** Measured by mutation: moving the
    // arm check out of `applies` and leaving it only in `resolve` produced exactly
    // the same board and this file did not notice. That is the distinction 383
    // makes observable — a trigger that fires and resolves to nothing still closes
    // the chain and costs both players a PassFocus — so it is asserted rather than
    // left to the outcome.
    expect(namiTriggersHeld(runCleanup(accept(state, playsOf(state, "OGN-052")[0]!))), "an unarmed Nami still went on the chain").toBe(
      0,
    );
  });

  it("spends on the FIRST unit only — 'the next time'", () => {
    const { state } = armed();
    state.players[0]!.hand = [spellInstance("OGN-052"), spellInstance("OGN-013")]; // Poro, then Pouty Poro
    const first = play(state, "OGN-052");
    expect(poroInPlay(first)!.exhausted, "the first unit was not readied — the fixture is inert").toBe(false);

    const second = play(first, "OGN-013");
    const pouty = ownUnitNamed(second, "Pouty Poro");
    expect(pouty, "the second unit was never played").toBeDefined();
    expect(pouty!.exhausted, "the delayed trigger fired twice").toBe(true);
    expect(pouty!.buffed, "the delayed trigger buffed twice").toBe(false);
  });

  it("PINS THE DIVERGENCE: the armed trigger dies with Nami (391 says it should not)", () => {
    // 390.2/391 make this a plain Delayed Trigger with the window "this turn" — it
    // references neither its source nor an object it affected, so it is NOT one of
    // 390.5's Delayed Linked Abilities and should survive her death. The arm is
    // stored on her instance, so here it does not.
    const { state, nami } = armed();
    const widowed = removeUnitAnywhere(state, nami.instanceId);

    const poro = poroInPlay(play(widowed, "OGN-052"));
    expect(poro, "the unit was never played").toBeDefined();
    expect(poro!.exhausted, "the divergence closed — update the card comment and this test").toBe(true);
    expect(poro!.buffed).toBe(false);
  });

  it("PINS THE GAP: her optional [Calm] cost is not offered, so the stun cannot fire", () => {
    // One row in `card-effects.OPTIONAL_POWER_COSTS` — a shared file — is the whole
    // of what is missing: `"UNL-052": { domain: "Calm", count: 1 }`.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(NAMI)];
    state.players[0]!.channeled = runes(8);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim" })] };

    expect(
      playsOf(state, NAMI).some((a) => a.optionalPowerPaid === true),
      "the paid variant is offered now — delete this pin and the PARTIAL coverage entry",
    ).toBe(false);

    const played = play(state, NAMI);
    expect(findUnit(played, "victim")!.stunned, "an unpaid Nami stunned anyway").toBe(false);
  });

  it("and the stun resolver itself works when the flag arrives", () => {
    // The positive control for the pin above: the clause is written and correct,
    // and only the enumeration of the cost is missing. Driven through
    // `dispatchOnPlayUnit`, which is the funnel `execute-play-card` calls — this
    // is the one assertion in this file that no real action can reach today.
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim" })] };
    const nami = realUnitInstance(NAMI);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [nami] };

    const fired = playUnitTrigger(state, nami, 0, { battlefieldId: "bf1" }, { optionalPowerPaid: true, targetUnitInstanceId: "victim" });
    expect(findUnit(fired, "victim")!.stunned, "the stun clause is dead even with the flag set").toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Scuttle Crab (UNL-053): draw on play, 1 XP on death", () => {
  function crabInHand(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(SCUTTLE_CRAB)];
    state.players[0]!.channeled = runes(6);
    state.players[0]!.deck = [makeUnit({ name: "Top Card" }), makeUnit({ name: "Next Card" })];
    return state;
  }

  it("draws 1 when played, through a real PlayCard", () => {
    const played = play(crabInHand(), SCUTTLE_CRAB);
    expect(played.players[0]!.hand.map((c) => c.name), "the on-play draw never happened").toEqual(["Top Card"]);
  });

  it("gains 1 XP on death, and only on ITS death", () => {
    const crab = realUnitInstance(SCUTTLE_CRAB);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [crab, makeUnit({ instanceId: "bystander" })] };

    const bystanderDied = resolveHeldTriggers(destroyUnit(state, "bystander"));
    expect(bystanderDied.players[0]!.xp, "some other unit's death paid the Crab's XP").toBe(0);

    const crabDied = resolveHeldTriggers(destroyUnit(bystanderDied, crab.instanceId));
    expect(crabDied.players[0]!.xp, "[Deathknell] never fired").toBe(1);
    // The XP is the DYING unit's controller's, not the killer's.
    expect(crabDied.players[1]!.xp).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("Vex - Mocking (UNL-055): when you stun an enemy unit at a battlefield, you may move me there", () => {
  /** Vex in player 0's base, an enemy unit at bf1, and Back Off in hand to stun
   *  with — the real path, since `stunUnits` is what fires `unitsStunned`. */
  function vexAndVictim(victimAt: "bf1" | "base" = "bf1"): { state: GameState; vex: UnitInstance } {
    const vex = realUnitInstance(VEX_MOCKING);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [vex];
    state.players[0]!.hand = [spellInstance(BACK_OFF)];
    state.players[0]!.channeled = runes(8);
    const victim = makeUnit({ instanceId: "victim" });
    if (victimAt === "bf1") state.battlefields[0]!.units = { p2: [victim] };
    else state.players[1]!.baseUnits = [victim];
    return { state, vex };
  }

  /** Back Off aimed at `targetUnitInstanceId`, settled. */
  function backOff(state: GameState, targetUnitInstanceId: string): GameState {
    const cast = playsOf(state, BACK_OFF).find((a) => a.targetUnitInstanceId === targetUnitInstanceId);
    expect(cast, `Back Off was never offered against ${targetUnitInstanceId}`).toBeDefined();
    return settle(accept(state, cast!));
  }

  it("offers the move, and takes it — Vex walks to the stunned unit's battlefield", () => {
    const { state, vex } = vexAndVictim();
    const stunned = backOff(state, "victim");
    expect(findUnit(stunned, "victim")!.stunned, "the stun itself did not happen").toBe(true);

    const decision = pendingDecision(stunned);
    expect(decision?.kind, "Vex was never offered the move").toBe("UNL-055-move");
    expect(optionsFor(stunned, decision!).map((o) => o.id)).toEqual(["decline", "move"]);

    const moved = answerDecisions(stunned, (options) => options.find((o) => o.id === "move")!.id);
    expect(moved.players[0]!.baseUnits, "Vex did not leave her base").toHaveLength(0);
    expect(unitsAtBf(moved, "bf1").map((u) => u.defId), "Vex did not arrive at the battlefield").toContain(VEX_MOCKING);
    // A Move, not a Standard Move: 414.3.a puts the exhaust on the ACTION.
    expect(unitsAtBf(moved, "bf1").find((u) => u.defId === VEX_MOCKING)!.exhausted).toBe(false);
  });

  it("leaves her where she is when the offer is declined", () => {
    const { state } = vexAndVictim();
    const declined = answerDecisions(backOff(state, "victim"), (options) => options.find((o) => o.id === "decline")!.id);
    expect(declined.players[0]!.baseUnits, "'you may' moved her anyway").toHaveLength(1);
    expect(unitsAtBf(declined, "bf1")).toHaveLength(0);
  });

  it("does NOT fire for an enemy stunned in their BASE — 'at a battlefield' is printed", () => {
    // The positive control is the first test: the same spell, the same Vex, and
    // the only difference is where the victim stands.
    const { state } = vexAndVictim("base");
    const stunned = backOff(state, "victim");
    expect(state.players[1]!.baseUnits, "the fixture put the victim somewhere else").toHaveLength(1);
    expect(findUnit(stunned, "victim")!.stunned, "the stun itself did not happen — this negative proves nothing").toBe(true);
    expect(pendingDecision(stunned), "a base stun still offered the move").toBeUndefined();
  });

  it("does NOT fire when you stun your OWN unit at a battlefield", () => {
    const { state } = vexAndVictim();
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [makeUnit({ instanceId: "friendly" })] };

    const stunned = backOff(state, "friendly");
    expect(findUnit(stunned, "friendly")!.stunned, "the stun itself did not happen").toBe(true);
    expect(pendingDecision(stunned), "stunning your own unit walked Vex across the board").toBeUndefined();
  });

  it("does NOT fire when the OPPONENT does the stunning", () => {
    // "When YOU stun" — `stunnerIndex` must be Vex's controller. Driven through
    // `stunUnits` directly because it is player 1 acting, and it is the single
    // emitter of the event either way.
    const { state } = vexAndVictim();
    const own = makeUnit({ instanceId: "mine" });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [own] };

    const byOpponent = resolveHeldTriggers(stunUnits(state, 1, ["mine"]));
    expect(findUnit(byOpponent, "mine")!.stunned, "the stun itself did not happen").toBe(true);
    expect(pendingDecision(byOpponent), "the opponent's stun moved Vex").toBeUndefined();

    // The positive control on the identical board: player 0 stunning the enemy.
    const byMe = resolveHeldTriggers(stunUnits(byOpponent, 0, ["victim"]));
    expect(pendingDecision(byMe)?.kind, "the fixture cannot fire at all").toBe("UNL-055-move");
  });

  it("does not fire a second time for a unit that was already stunned (423)", () => {
    const { state } = vexAndVictim();
    const once = answerDecisions(resolveHeldTriggers(stunUnits(state, 0, ["victim"])), (o) => o.find((x) => x.id === "decline")!.id);
    expect(findUnit(once, "victim")!.stunned).toBe(true);

    const twice = resolveHeldTriggers(stunUnits(once, 0, ["victim"]));
    expect(pendingDecision(twice), "re-stunning an already-stunned unit offered the move again").toBeUndefined();
  });

  it("offers one move per stunned enemy, each naming its OWN battlefield", () => {
    // "AN enemy unit", singular, against a BATCH event — `captureEach` is what
    // makes two victims two triggered abilities rather than one, and what gives
    // each Pending Item its own "that battlefield".
    const { state } = vexAndVictim();
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "victim2" })] };

    let current = resolveHeldTriggers(stunUnits(state, 0, ["victim", "victim2"]));
    const offered: string[] = [];
    for (let guard = 0; guard < 6; guard += 1) {
      const decision = pendingDecision(current);
      if (!decision) break;
      expect(decision.kind).toBe("UNL-055-move");
      offered.push(decision.battlefieldId!);
      // Resolve onward after each answer: the second Pending Item is still on the
      // chain and only parks its question once it pops.
      current = resolveHeldTriggers(answerDecision(current, decision.id, "decline")!);
    }

    expect([...offered].sort(), "the two victims did not produce one offer each, per battlefield").toEqual(["bf1", "bf2"]);
    expect(current.players[0]!.baseUnits, "declining both still moved her").toHaveLength(1);
  });
});

describe("the two cards this wave REFUSED", () => {
  // A refusal nothing asserts is indistinguishable from a card nobody looked at.
  // Both are blocked on `deploy.conditionalEntersReady`, a shared file — see the
  // note at the foot of `unitTriggers` in effects/calm.ts for the full reasoning
  // and for the second, independent gap on Shadow Watcher.
  const MONCH = "UNL-035"; // "If an opponent controls a stunned unit, I cost [2] less and enter ready."
  const SHADOW_WATCHER = "UNL-037"; // "If a friendly unit died during your Beginning Phase this turn, I enter ready."

  it("are registered nowhere, and report unimplemented", () => {
    for (const id of [MONCH, SHADOW_WATCHER]) {
      expect(implementingModules(id), `${id} was implemented — delete this test`).toHaveLength(0);
      expect(isCardImplemented(registry.get(id)), `${id} reports implemented while doing nothing`).toBe(false);
    }
  });

  it("and neither enters ready today", () => {
    // The behavioural half of the refusal, so "unimplemented" is not the only
    // evidence: a Monch played while the opponent has a stunned unit arrives
    // exhausted like any other unit.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(MONCH)];
    state.players[0]!.channeled = runes(12);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "asleep", stunned: true })] };

    const played = play(state, MONCH);
    const monch = ownUnitNamed(played, registry.get(MONCH).name);
    expect(monch, "Monch was never played — this proves nothing").toBeDefined();
    expect(monch!.exhausted, "Monch entered ready — the gap closed, delete this test").toBe(true);
  });
});

describe("what this wave claims", () => {
  it("every card is registered in a module that coverage can see", () => {
    // Asserted through `implementingModules` rather than `isCardImplemented`, and
    // deliberately: registration is per defId, so two of these are half written on
    // purpose (pinned above) and the integrator owes them
    // `coverage.PARTIALLY_IMPLEMENTED` entries — which would flip
    // `isCardImplemented` to false and break a test asserting the other way. What
    // cannot flip is that the registration exists and is reachable.
    for (const id of [HONEYFRUIT, IVERN, NAMI, SCUTTLE_CRAB, VEX_MOCKING]) {
      expect(implementingModules(id), `${registry.get(id).name} is registered nowhere coverage looks`).not.toHaveLength(0);
    }
  });

  it("adds exactly four trigger cards to the census, all HELD", () => {
    // `test/trigger-census.test.ts` pins a pool-wide figure that six domain files
    // move at once, and no agent is permitted to bump it — so each measures its
    // OWN share and the integrator adds them up. This is that measurement, written
    // as an assertion rather than a number in a report so it cannot be mistyped.
    //
    // Four cards, not five: Honeyfruit's is an ACTIVATED ability and no trigger
    // registry holds it. Enthusiastic Promoter (UNL-043) was already counted by an
    // earlier wave.
    const registries = new Set([...eventTriggerDefIds(), ...unitTriggerDefIds(), ...deathTriggerDefIds()]);
    const mine = [IVERN, NAMI, SCUTTLE_CRAB, VEX_MOCKING];
    for (const id of mine) expect(registries.has(id), `${id} registers no trigger`).toBe(true);
    expect(registries.has(HONEYFRUIT), "Honeyfruit is in a trigger registry — the census share is 5, not 4").toBe(false);

    // HELD, which for an event trigger reduces to "does not register
    // `beginningPhase`" — the one inline kind. Asked of the definitions rather
    // than asserted in prose.
    for (const id of [IVERN, NAMI, VEX_MOCKING]) {
      const on = eventTriggerFor(id)?.on;
      const kinds = on === undefined ? [] : Array.isArray(on) ? on : [on];
      expect(kinds, `${id} has no event trigger`).not.toHaveLength(0);
      expect(kinds, `${id} resolves INLINE — it would move the census's inline figure too`).not.toContain("beginningPhase");
    }
  });

  it("the two fully-written cards report implemented", () => {
    // Scuttle Crab and Ivern have no unwritten clause and no unimplemented
    // keyword, so these two are the positive control for the claim above: it is
    // possible for a card in this wave to read as done.
    expect(isCardImplemented(registry.get(SCUTTLE_CRAB))).toBe(true);
    expect(isCardImplemented(registry.get(IVERN))).toBe(true);
  });
});
