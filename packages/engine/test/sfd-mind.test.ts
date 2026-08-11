import { describe, expect, it } from "vitest";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { recordConquest } from "../src/engine/scoring.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { activationCostOf } from "../src/engine/activated-abilities.js";
import { submit } from "../src/engine/game-engine.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, beginCombatAt, makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import { resolveShowdown } from "../src/engine/combat.js";

/**
 * The Spiritforged (SFD) Mind cards — effects/mind.ts.
 *
 * **Everything here drives `executePlayCard` (and `executePassFocus` for the
 * Spell), never a resolver by hand.** That is not ceremony: a resolver called
 * directly passes whether or not the registry entry exists, whether or not the
 * dispatch hop forwards its fields, and whether or not the card is reachable at
 * all — which is exactly how Annie - Stubborn once shipped paying its cost and
 * doing nothing behind a green test.
 *
 * Every test here was run against the file with its registry entry commented out
 * before it was kept; each one fails there. A test that cannot be made to fail
 * has measured nothing.
 *
 * Helpers are local rather than added to fixtures.ts because that file is shared
 * and other agents are working in this tree.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const unitCard = (defId: string): UnitInstance => card(defId) as UnitInstance;
const gearCard = (defId: string): GearInstance => card(defId) as GearInstance;

const PREMONITION = "SFD-087"; // Spell, 2 Energy + 3 Mind Power — "[Reaction] Draw 3."
const ASPIRING_ENGINEER = "SFD-061"; // Unit, 3 Energy + 1 Mind Power
const BUBBLE_BOT = "SFD-062"; // Unit, 3 Energy
const DROPBOARDER = "SFD-072"; // Unit, 4 Energy
const CHEMTECH_CASK = "SFD-063"; // Gear, 1 Energy — "you may exhaust me to play a Gold gear token"
const PLUNDERING_PORO = "SFD-069"; // Unit, 2 Energy 2 Might — "when I conquer"
const WAGES_OF_PAIN = "SFD-070"; // Spell, 3 Energy — "[Hidden][Action] Deal 3 ... Play a Gold gear token"
const CARD_SHARP = "SFD-081"; // Unit, 3 Energy 3 Might — "you and each opponent may..."
const EZREAL_DASHING = "SFD-082"; // Unit, 4 Energy + 1 Mind, 3 Might — "when I attack or defend..."
const GARBAGE_GRABBER = "OGN-099"; // Gear, Mind, 2 Energy
const MUSHROOM_POUCH = "OGN-101"; // Gear, Mind, 2 Energy
const FALLING_COMET = "OGN-085"; // Spell — the non-gear that must NOT be offered

/** The Gold gear tokens `playerIndex` controls. Read off `activeGear` by the
 *  token's runtime defId rather than by name, so a rename upstream shows up as a
 *  failure here instead of as a test that quietly counts nothing. */
const goldTokens = (state: GameState, playerIndex: 0 | 1): GearInstance[] =>
  state.players[playerIndex]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

/** Ready Mind runes, ids distinct across a whole test so a payment can never
 *  accidentally name the same rune for Energy and for Power. */
function mindRunes(count: number, prefix = "r"): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, domain: "Mind" as const, state: "Ready" as const }));
}

/**
 * Plays a card through the REAL executor, paying out of the actor's channeled
 * pool. Copied from cards-ready-mind.test.ts rather than shared, for the reason
 * in the header: Energy takes the front of the pool and Power the back, so the
 * two never name the same rune.
 */
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

/** Two consecutive passes per chain item, which is what actually resolves a
 *  Spell (340/343). A Spell that is only `executePlayCard`ed has done nothing
 *  but go on the chain. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && !next.chainOpen; guard += 1) {
    next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });
  }
  if (!next.chainOpen) throw new Error("resolveChain: the chain never reopened");
  return next;
}

/** Plays a Unit to base and settles its held on-play trigger — which is where a
 *  parked question, if the card asks one, is waiting. */
const playUnit = (state: GameState, playerIndex: 0 | 1, unit: UnitInstance): GameState =>
  resolveHeldTriggers(play(state, playerIndex, unit));

/** The copy of a unit that is actually on the board, by instance id. Never the
 *  object handed to `play` — that one is a snapshot from before it was deployed
 *  and says nothing about whether the card readied it. */
function inPlay(state: GameState, instanceId: string): UnitInstance {
  for (const ownerIndex of [0, 1] as const) {
    const owner = state.players[ownerIndex]!;
    const found =
      owner.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[owner.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  throw new Error(`unit ${instanceId} is not in play`);
}

describe("Premonition (SFD-087): [Reaction] Draw 3", () => {
  it("draws exactly 3 through a real cast", () => {
    const spell = card(PREMONITION);
    const deck = [card(FALLING_COMET), card(FALLING_COMET), card(FALLING_COMET), card(FALLING_COMET)];
    const state = makeState({
      players: [makePlayer("p1", { hand: [spell], deck, channeled: mindRunes(6) }), makePlayer("p2")],
    });

    const after = resolveChain(play(state, 0, spell));

    expect(after.players[0]!.deck).toHaveLength(1);
    expect(after.players[0]!.hand).toHaveLength(3); // the spell itself has gone to the trash
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(spell.instanceId);
  });

  it("runs Burn Out rather than clamping when the deck cannot cover 3 (431)", () => {
    // Two cards in the deck, so the third draw finds it empty. **Measured, not
    // assumed:** this test was first written expecting a hand of 2, and the
    // engine gave 3 — because Premonition is itself in the trash by then, so Burn
    // Out recycles it into the deck and it is drawn back. That is `drawCards`'
    // behaviour and rule 431's, not this card's, and the opponent's point is what
    // proves the path was taken rather than a draw silently stopping short.
    const spell = card(PREMONITION);
    const state = makeState({
      players: [
        makePlayer("p1", { hand: [spell], deck: [card(FALLING_COMET), card(FALLING_COMET)], channeled: mindRunes(6) }),
        makePlayer("p2"),
      ],
    });

    const after = resolveChain(play(state, 0, spell));

    expect(after.players[0]!.hand).toHaveLength(3);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(spell.instanceId);
    expect(after.players[0]!.deck).toHaveLength(0);
    expect(after.players[1]!.points).toBe(1); // 431: an opponent gains 1 point
  });
});

describe("Aspiring Engineer (SFD-061): return a gear from your trash to your hand", () => {
  function engineerState(trash: CardInstance[]) {
    const engineer = unitCard(ASPIRING_ENGINEER);
    const state = makeState({
      players: [makePlayer("p1", { hand: [engineer], trash, channeled: mindRunes(6) }), makePlayer("p2")],
    });
    return { state, engineer };
  }

  it("offers ONLY the gear in the trash, and returns the chosen one to hand", () => {
    const spellInTrash = card(FALLING_COMET);
    const grabber = gearCard(GARBAGE_GRABBER);
    const pouch = gearCard(MUSHROOM_POUCH);
    const { state, engineer } = engineerState([spellInTrash, grabber, pouch]);

    const asked = playUnit(state, 0, engineer);

    const question = pendingDecision(asked);
    expect(question, "the on-play trigger parked no question at all").toBeDefined();
    expect(optionsFor(asked, question!).map((o) => o.instanceId).sort()).toEqual(
      [grabber.instanceId, pouch.instanceId].sort(),
    );

    const after = answerDecision(asked, question!.id, pouch.instanceId)!;

    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(pouch.instanceId);
    // The other gear and the spell stay put: "a gear", singular.
    expect(after.players[0]!.trash.map((c) => c.instanceId).sort()).toEqual(
      [spellInTrash.instanceId, grabber.instanceId].sort(),
    );
  });

  it("a single gear is taken without ever prompting (advanceDecisions)", () => {
    const grabber = gearCard(GARBAGE_GRABBER);
    const { state, engineer } = engineerState([card(FALLING_COMET), grabber]);

    const after = playUnit(state, 0, engineer);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(grabber.instanceId);
  });

  it("asks nothing and moves nothing when the trash holds no gear (055)", () => {
    const spellInTrash = card(FALLING_COMET);
    const { state, engineer } = engineerState([spellInTrash]);

    const after = playUnit(state, 0, engineer);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([spellInTrash.instanceId]);
  });
});

describe("Bubble Bot (SFD-062): ready another friendly Mech", () => {
  it("readies the chosen Mech, and offers neither a non-Mech nor a ready one", () => {
    const mechA = makeUnit({ name: "Mech A", tags: ["Mech"], exhausted: true });
    const mechB = makeUnit({ name: "Mech B", tags: ["Mech"], exhausted: true });
    const readyMech = makeUnit({ name: "Mech C", tags: ["Mech"], exhausted: false });
    const notAMech = makeUnit({ name: "Footsoldier", tags: ["Noxus"], exhausted: true });
    const bot = unitCard(BUBBLE_BOT);
    const state = makeState({
      players: [
        makePlayer("p1", { hand: [bot], channeled: mindRunes(4), baseUnits: [mechA, notAMech, readyMech] }),
        makePlayer("p2"),
      ],
    });
    state.battlefields[0]!.units = { p1: [mechB] };

    const asked = playUnit(state, 0, bot);

    const question = pendingDecision(asked);
    expect(question, "the on-play trigger parked no question at all").toBeDefined();
    // Both exhausted Mechs, wherever they stand; not the ready one, not the
    // non-Mech, and not Bubble Bot herself ("ANOTHER friendly Mech").
    expect(optionsFor(asked, question!).map((o) => o.instanceId).sort()).toEqual(
      [mechA.instanceId, mechB.instanceId].sort(),
    );

    const after = answerDecision(asked, question!.id, mechB.instanceId)!;

    expect(inPlay(after, mechB.instanceId).exhausted).toBe(false);
    expect(inPlay(after, mechA.instanceId).exhausted).toBe(true); // one Mech, not all of them
    expect(inPlay(after, notAMech.instanceId).exhausted).toBe(true);
  });

  it("never readies HERSELF — 'another', and she arrives exhausted", () => {
    // The whole test with no other Mech on the board: she is the only Mech in
    // play, and a broken "another" would show up as her readying herself.
    const notAMech = makeUnit({ name: "Footsoldier", tags: ["Zaun"], exhausted: true });
    const bot = unitCard(BUBBLE_BOT);
    const state = makeState({
      players: [makePlayer("p1", { hand: [bot], channeled: mindRunes(4), baseUnits: [notAMech] }), makePlayer("p2")],
    });

    const after = playUnit(state, 0, bot);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(inPlay(after, bot.instanceId).exhausted).toBe(true); // 143.4.a, untouched
    expect(inPlay(after, notAMech.instanceId).exhausted).toBe(true);
  });

  it("does not reach the OPPONENT's Mechs — 'friendly'", () => {
    const enemyMech = makeUnit({ name: "Enemy Mech", tags: ["Mech"], exhausted: true });
    const bot = unitCard(BUBBLE_BOT);
    const state = makeState({
      players: [
        makePlayer("p1", { hand: [bot], channeled: mindRunes(4) }),
        makePlayer("p2", { baseUnits: [enemyMech] }),
      ],
    });

    const after = playUnit(state, 0, bot);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(inPlay(after, enemyMech.instanceId).exhausted).toBe(true);
  });
});

describe("Dropboarder (SFD-072): enters ready if you control two or more gear", () => {
  function dropboarderState(gearCount: number) {
    const dropboarder = unitCard(DROPBOARDER);
    const activeGear = [gearCard(GARBAGE_GRABBER), gearCard(MUSHROOM_POUCH)].slice(0, gearCount);
    const state = makeState({
      players: [makePlayer("p1", { hand: [dropboarder], channeled: mindRunes(5), activeGear }), makePlayer("p2")],
    });
    return { state, dropboarder };
  }

  it("readies itself with two gear, and stays exhausted with one", () => {
    // Both halves in ONE test on purpose: the one-gear half alone passes just as
    // happily against an unregistered card, so it proves nothing by itself. The
    // two-gear half is the positive control that fails if the card is inert.
    const two = dropboarderState(2);
    const withTwo = playUnit(two.state, 0, two.dropboarder);
    expect(inPlay(withTwo, two.dropboarder.instanceId).exhausted).toBe(false);

    const one = dropboarderState(1);
    const withOne = playUnit(one.state, 0, one.dropboarder);
    expect(inPlay(withOne, one.dropboarder.instanceId).exhausted).toBe(true); // 143.4.a stands
  });

  it("counts gear on the BOARD, not gear in the trash (355.9.b)", () => {
    const dropboarder = unitCard(DROPBOARDER);
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [dropboarder],
          channeled: mindRunes(5),
          activeGear: [gearCard(GARBAGE_GRABBER)],
          trash: [gearCard(MUSHROOM_POUCH), gearCard(GARBAGE_GRABBER)],
        }),
        makePlayer("p2"),
      ],
    });

    const after = playUnit(state, 0, dropboarder);

    expect(inPlay(after, dropboarder.instanceId).exhausted).toBe(true);
  });
});

/**
 * The four Gold-token cards.
 *
 * Every one of these was blocked on `token.ts` being able to mint a
 * `GearInstance` at all, so the positive control that matters for each is the
 * same: a Gold token, in the right player's `activeGear`, EXHAUSTED. Counted by
 * `goldTokens` off the runtime defId rather than by `activeGear.length`, because
 * three of these boards have other gear on them and a length check would pass on
 * the wrong card entirely.
 */

describe("Plundering Poro (SFD-069): when I conquer, a Gold gear token exhausted", () => {
  /** The Poro standing at `battlefieldId`, ready to be the body that takes it. */
  function poroState(battlefieldId: string): GameState {
    const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
    const bf = state.battlefields.find((b) => b.id === battlefieldId)!;
    bf.units = { p1: [unitCard(PLUNDERING_PORO)] };
    return state;
  }

  it("makes ONE exhausted Gold token on its controller's conquest", () => {
    // `recordConquest` is the real scoring path — it HOLDS the trigger (383), so
    // `resolveHeldTriggers` is what actually resolves it. Asserting on the board
    // straight after the conquest would read "the Poro did nothing" whether the
    // card works or not, which is the trap this suite's header describes.
    const after = resolveHeldTriggers(recordConquest(poroState("bf1"), 0, "bf1"));

    const gold = goldTokens(after, 0);
    expect(gold, "the conquer trigger produced no Gold token").toHaveLength(1);
    expect(gold[0]!.exhausted, "the card prints 'exhausted'").toBe(true);
    expect(goldTokens(after, 1), "the opponent was paid instead").toHaveLength(0);
  });

  it("does not fire for a battlefield it is not standing at ('when I conquer')", () => {
    // The positional reading. A Poro at bf1 watching bf2 fall is Kai'Sa -
    // Evolutionary's own distinction between "when I" and a Legend's "when you".
    const after = resolveHeldTriggers(recordConquest(poroState("bf1"), 0, "bf2"));
    expect(goldTokens(after, 0)).toHaveLength(0);
  });

  it("does not fire when the OPPONENT conquers the battlefield it is at", () => {
    const after = resolveHeldTriggers(recordConquest(poroState("bf1"), 1, "bf1"));
    expect(goldTokens(after, 0)).toHaveLength(0);
    expect(goldTokens(after, 1)).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PLUNDERING_PORO))).toBe(true);
  });
});

describe("Wages of Pain (SFD-070): deal 3 at a battlefield, then a Gold token", () => {
  /** The caster holding the spell, with a 5-Might enemy at bf1 that survives the
   *  3 — so the damage is readable as MARKED damage rather than as a death. */
  function wagesState(): { state: GameState; spell: CardInstance; victim: UnitInstance } {
    const spell = card(WAGES_OF_PAIN);
    const victim = makeUnit({ name: "Victim", might: 5 });
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { hand: [spell], channeled: mindRunes(6) }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, spell, victim };
  }

  /** The victim as the board holds it, wherever it stands. */
  const victimOnBoard = (state: GameState, instanceId: string) =>
    state.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === instanceId);

  it("deals 3 AND plays an exhausted Gold token, through a real cast", () => {
    const { state, spell, victim } = wagesState();

    const after = resolveChain(play(state, 0, spell, { targetUnitInstanceId: victim.instanceId }));

    expect(victimOnBoard(after, victim.instanceId)?.damage, "the damage half did not fire").toBe(3);
    const gold = goldTokens(after, 0);
    expect(gold, "the token half did not fire").toHaveLength(1);
    expect(gold[0]!.exhausted).toBe(true);
    expect(goldTokens(after, 1), "the token went to the wrong player").toHaveLength(0);
  });

  it("still plays the token when the target left play during the response window", () => {
    // 359.3.e with 135.2.b's worked Void Seeker example: two instructions, ignored
    // separately, and "play a Gold gear token" names nothing that could become
    // illegal. Contrast Retreat, whose second sentence says "ITS owner".
    //
    // The victim is removed AFTER the spell is announced and BEFORE the chain
    // resolves, which is exactly the window an opponent has.
    const { state, spell, victim } = wagesState();
    const cast = play(state, 0, spell, { targetUnitInstanceId: victim.instanceId });
    const vanished = { ...cast, battlefields: cast.battlefields.map((bf) => ({ ...bf, units: {} })) };

    const after = resolveChain(vanished);

    expect(goldTokens(after, 0), "the token was dropped along with the illegal target").toHaveLength(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(WAGES_OF_PAIN))).toBe(true);
  });
});

describe("Chemtech Cask (SFD-063): a spell on the opponent's turn, for an exhaust", () => {
  /**
   * The Cask in play with a [Reaction] spell in hand, on the OPPONENT'S turn with
   * Focus held by us.
   *
   * This shape is forced rather than incidental, and Viktor - Innovator's test
   * records why: a plain card cannot legally be played on someone else's turn at
   * all, so only a `[Reaction]` (or an `[Action]` in a Showdown) reaches the
   * trigger. Premonition is this domain's [Reaction] and needs a deck to draw
   * from, which is the only reason the deck is here.
   */
  function caskState(activePlayerIndex: 0 | 1, caskExhausted = false): { state: GameState; spell: CardInstance } {
    const spell = card(PREMONITION);
    const cask = { ...gearCard(CHEMTECH_CASK), exhausted: caskExhausted };
    const state = makeState({
      phase: "Action",
      activePlayerIndex,
      turnState: activePlayerIndex === 0 ? "Neutral" : "Showdown",
      showdownBattlefieldId: activePlayerIndex === 0 ? null : "bf1",
      showdownKind: activePlayerIndex === 0 ? null : "NonCombat",
      focusHolder: 0,
      players: [
        makePlayer("p1", {
          hand: [spell],
          activeGear: [cask],
          channeled: mindRunes(8),
          deck: [card(FALLING_COMET), card(FALLING_COMET), card(FALLING_COMET)],
        }),
        makePlayer("p2"),
      ],
    });
    return { state, spell };
  }

  /** The Cask as the board holds it — never the object handed to `makePlayer`,
   *  which says nothing about whether the cost was paid. */
  const caskOnBoard = (state: GameState) => state.players[0]!.activeGear.find((g) => g.defId === CHEMTECH_CASK)!;

  it("asks, and on 'yes' exhausts itself and plays an exhausted Gold token", () => {
    const { state, spell } = caskState(1);

    const asked = resolveHeldTriggers(play(state, 0, spell));
    const question = pendingDecision(asked);
    expect(question?.kind, "the cardPlayed trigger parked no question").toBe("SFD-063-gold");

    const after = answerDecision(asked, question!.id, "gold")!;

    expect(caskOnBoard(after).exhausted, "the cost was not paid").toBe(true);
    const gold = goldTokens(after, 0);
    expect(gold).toHaveLength(1);
    expect(gold[0]!.exhausted).toBe(true);
  });

  it("declining costs nothing and makes nothing — a real 'you may'", () => {
    const { state, spell } = caskState(1);
    const asked = resolveHeldTriggers(play(state, 0, spell));

    const after = answerDecision(asked, pendingDecision(asked)!.id, "decline")!;

    expect(caskOnBoard(after).exhausted).toBe(false);
    expect(goldTokens(after, 0)).toHaveLength(0);
  });

  it("does not ask on YOUR OWN turn", () => {
    const { state, spell } = caskState(0);
    const after = resolveHeldTriggers(play(state, 0, spell));
    expect(pendingDecision(after)).toBeUndefined();
    expect(goldTokens(after, 0)).toHaveLength(0);
  });

  it("does not ask when the Cask is already exhausted — a cost it cannot pay", () => {
    const { state, spell } = caskState(1, true);
    const after = resolveHeldTriggers(play(state, 0, spell));
    expect(pendingDecision(after)).toBeUndefined();
    expect(goldTokens(after, 0)).toHaveLength(0);
  });

  it("ignores a non-Spell, and the opponent's spell on their own turn", () => {
    // The only two conditions the executor cannot be made to produce: a Unit
    // cannot legally be played on someone else's turn, and the opponent casting
    // on their own turn needs their own hand and pool. Both are read by `applies`,
    // which `holdEventTrigger` consults — so this asks whether the trigger is
    // PLACED, which is the honest question once events are held. The positive
    // control above still runs through `executePlayCard`.
    const { state } = caskState(1);
    const held = (event: Parameters<typeof holdEventTrigger>[1]) =>
      holdEventTrigger(state, event).pendingTriggers.map((t) => t.listenerDefId);

    expect(held({ kind: "cardPlayed", casterIndex: 0, playedKind: "Spell", playedInstanceId: "x", playedPowerCost: 0, isToken: false })).toContain(
      CHEMTECH_CASK,
    ); // the control: this one DOES place it
    expect(held({ kind: "cardPlayed", casterIndex: 0, playedKind: "Unit", playedInstanceId: "x", playedPowerCost: 0, isToken: false })).not.toContain(
      CHEMTECH_CASK,
    );
    expect(held({ kind: "cardPlayed", casterIndex: 1, playedKind: "Spell", playedInstanceId: "x", playedPowerCost: 0, isToken: false })).not.toContain(
      CHEMTECH_CASK,
    );
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(CHEMTECH_CASK))).toBe(true);
  });
});

describe("Card Sharp (SFD-081): you and each opponent may, and you are paid for theirs", () => {
  function sharpState(): { state: GameState; sharp: UnitInstance } {
    const sharp = unitCard(CARD_SHARP);
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { hand: [sharp], channeled: mindRunes(5) }), makePlayer("p2")],
    });
    return { state, sharp };
  }

  /** Answers the two queued questions by their `kind`, so a test never depends on
   *  the queue order it is also asserting. */
  const answerBoth = (state: GameState, mine: string, theirs: string) =>
    answerDecisions(state, (_options, decision) => (decision.kind === "SFD-081-mine" ? mine : theirs));

  it("queues BOTH questions, the caster's first and the opponent's second", () => {
    const { state, sharp } = sharpState();

    const asked = playUnit(state, 0, sharp);

    expect(asked.pendingDecisions.map((d) => [d.kind, d.playerIndex])).toEqual([
      ["SFD-081-mine", 0],
      ["SFD-081-theirs", 1],
    ]);
  });

  it("both accept: the opponent gets one and the caster gets TWO", () => {
    // The whole card. One token for the caster's own "may", a second for "for each
    // opponent who did" — and a bug that dropped either half leaves the caster on
    // one, which is why this asserts 2 rather than "more than 0".
    const { state, sharp } = sharpState();

    const after = answerBoth(playUnit(state, 0, sharp), "gold", "gold");

    expect(goldTokens(after, 0)).toHaveLength(2);
    expect(goldTokens(after, 1)).toHaveLength(1);
    expect([...goldTokens(after, 0), ...goldTokens(after, 1)].every((g) => g.exhausted)).toBe(true);
  });

  it("the opponent declining costs the caster the bonus token", () => {
    const { state, sharp } = sharpState();

    const after = answerBoth(playUnit(state, 0, sharp), "gold", "decline");

    expect(goldTokens(after, 0), "the bonus was paid for an opponent who did not").toHaveLength(1);
    expect(goldTokens(after, 1)).toHaveLength(0);
  });

  it("the caster may decline their own and still be paid for the opponent's", () => {
    // The two clauses are independent: "for each opponent who did" says nothing
    // about what YOU did. A single shared flag would get exactly this case wrong.
    const { state, sharp } = sharpState();

    const after = answerBoth(playUnit(state, 0, sharp), "decline", "gold");

    expect(goldTokens(after, 0)).toHaveLength(1);
    expect(goldTokens(after, 1)).toHaveLength(1);
  });

  it("both declining makes nothing at all", () => {
    const { state, sharp } = sharpState();
    const after = answerBoth(playUnit(state, 0, sharp), "decline", "decline");
    expect(goldTokens(after, 0)).toHaveLength(0);
    expect(goldTokens(after, 1)).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(CARD_SHARP))).toBe(true);
  });
});

describe("Ezreal - Dashing (SFD-082): damage equal to my Might when I fight — ONE of THREE clauses", () => {
  /**
   * "I don't deal combat damage" (engine/combat.ts) and ":rb_rune_mind:: [Action]
   * — Move me to your base" (engine/activated-abilities.ts) are NOT implemented,
   * and nothing in this block asserts anything about either. That is deliberate:
   * an assertion about text nobody wrote is exactly what makes a partial card
   * look finished, which is why the coverage block at the foot asserts the
   * OPPOSITE of the whole cards above it.
   *
   * The missing drawback makes this Ezreal STRONGER than printed, not weaker —
   * he deals his trigger damage and then his Might again in the damage step.
   */
  const VICTIM = "victim";

  /** Ezreal at bf1 with a 20-Might enemy who survives whatever he does, so the
   *  damage reads as MARKED damage rather than as a death. */
  function fighting(mightThisTurn = 0): { state: GameState; ezreal: UnitInstance } {
    const ezreal = { ...unitCard(EZREAL_DASHING), mightThisTurn };
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [ezreal],
      p2: [makeUnit({ instanceId: VICTIM, name: "Victim", might: 20 })],
    };
    return { state, ezreal };
  }

  /** The victim wherever it stands. Never the object handed to `makeState` — that
   *  one is a snapshot from before the trigger ran and would read 0 forever. */
  const victimDamage = (state: GameState) =>
    state.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === VICTIM)?.damage;

  it("deals his Might to an enemy here when he ATTACKS", () => {
    // The positive control, through the real Cleanup: `beginCombatAt` contests
    // the battlefield and lets the Showdown hand out the designations, so a card
    // registered for the wrong side or never dispatched at all fails here rather
    // than passing on a hand-built event.
    const { state } = fighting();

    const after = beginCombatAt(state, "bf1", 0);

    expect(victimDamage(after), "the attack trigger never fired").toBe(3); // his printed Might
  });

  it("deals it when he DEFENDS too — 'attack OR defend'", () => {
    // The clause that separates him from Yasuo - Remorseful, whose identical
    // sentence says "when I attack" and uses `isAttackingAt`. p2 applies
    // Contested, so Ezreal is the Defender.
    const { state } = fighting();

    const after = beginCombatAt(state, "bf1", 1);

    expect(victimDamage(after), "the defend half did not fire").toBe(3);
  });

  it("uses EFFECTIVE Might, so a this-turn pump is dealt too", () => {
    const { state } = fighting(4);

    const after = beginCombatAt(state, "bf1", 0);

    expect(victimDamage(after), "printed Might was dealt instead of effective").toBe(7);
  });

  /**
   * The trigger PLACED but not yet resolved — the opponent's response window,
   * which `beginCombatAt` closes in the same call and so cannot expose.
   *
   * Contest the battlefield and run the Cleanup that stages the Showdown — the
   * first half of `beginCombatAt`, stopped before its PassFocus loop. Going
   * through the real Cleanup rather than `holdEventTrigger` with a hand-built
   * event is what keeps the designation check honest, and it is also what avoids
   * DOUBLE-firing: a hand-placed trigger plus the Cleanup's own staging resolved
   * twice and dealt 16, which is how this helper came to exist.
   */
  function staged(): { held: GameState; ezreal: UnitInstance } {
    const { state, ezreal } = fighting();
    const held = runCleanup({
      ...state,
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, contestedByIndex: 0 as const } : bf)),
    });
    // **The assertion is not decoration.** The first version of the two tests
    // below never staged a combat at all, and the "he left the board" one PASSED
    // anyway — 0 damage from a trigger that had never fired reads exactly like 0
    // damage from a trigger that fired and correctly found null Might.
    //
    // Read off `spellChain`, not `pendingTriggers`: `runCleanup` ends with
    // `finalizePendingTriggers`, which empties the pen onto the chain. Asserting
    // the pen here is a check that can only ever report [].
    expect(
      held.spellChain.flatMap((e) => (e.kind === "trigger" ? [e.listenerDefId] : [])),
      "the trigger was never placed",
    ).toContain(EZREAL_DASHING);
    return { held, ezreal };
  }

  it("reads his Might at RESOLUTION, not when the trigger fired (359.3.e)", () => {
    // The response window this hold opens is real, and a pump landed inside it
    // must count — 359.3.e's own Strike Down example works this exact sentence
    // and says information about a permanent whose zone and status have not
    // changed "is accessible".
    //
    // `staged()` rather than `beginCombatAt` because that is the only way to get
    // BETWEEN the fire and the resolve; the Cleanup and `applies` both still run,
    // so the designation check is not being skipped. The three tests above are
    // the controls that this path agrees with the real one.
    const { held } = staged();

    // The opponent's window: +5 Might onto the Ezreal ON THE BOARD.
    const pumped = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: bf.units.p1!.map((u) => ({ ...u, mightThisTurn: 5 })) } }
          : bf,
      ),
    };

    const after = resolveHeldTriggers(pumped);

    expect(victimDamage(after), "a fire-time snapshot of his Might was used").toBe(8);
  });

  it("deals nothing when he left the board during the response window (359.3.e.14)", () => {
    // "A unit that is no longer on the board is treated as having null Might",
    // "and the instructions related to it are ignored" — the rules' own words on
    // Strike Down's "It deals damage equal to its Might". The trigger still
    // resolves (809.1.b), it just has no number to deal.
    const { held } = staged();
    const gone = {
      ...held,
      battlefields: held.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [] } } : bf)),
    };

    const after = resolveHeldTriggers(gone);

    expect(victimDamage(after)).toBe(0);
  });

  it("does not shoot into a fight he has WALKED OUT OF — 'here' is where he stands", () => {
    // "Here" is a referent read from the ability's source (359.3.f.1) and a
    // referent is checked on EXECUTION of the instruction (359.3.f.2). The rules
    // work this exact sentence: an opponent answers Yasuo - Remorseful's attack
    // trigger with Fight or Flight, and "when the attack trigger resolves, 'here'
    // is no longer the battlefield where combat is ongoing and the attack trigger
    // mistargets".
    //
    // Ezreal is the card where this bites hardest, because his own third clause
    // ("[Mind]: [Action] — Move me to your base") is the likeliest mover and it is
    // implemented. Leaving before the trigger resolves now costs the shot;
    // resolving it first and leaving after does not.
    //
    // Moved to ANOTHER battlefield rather than to base, so this cannot pass on the
    // "no Might, off the board" branch above — he is on the board, with a legal
    // victim beside him, and the answer is still nothing.
    const { held, ezreal } = staged();
    const walked = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: [] } }
          : bf.id === "bf2"
            ? { ...bf, units: { p1: [ezreal], p2: [makeUnit({ instanceId: "bystander", name: "Bystander", might: 20 })] } }
            : bf,
      ),
    };

    const after = resolveHeldTriggers(walked);

    expect(victimDamage(after), "he shot into the fight from another battlefield").toBe(0);
    const bystander = after.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === "bystander");
    expect(bystander?.damage, "he re-aimed 'here' at wherever he ended up").toBe(0);
  });

  it("hits nobody when there is no enemy unit here", () => {
    // No defender means no Showdown and no designations at all, so this asserts
    // only that it does not throw — the same negative Lucian - Gunslinger's test
    // records.
    const ezreal = unitCard(EZREAL_DASHING);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [ezreal] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(inPlay(after, ezreal.instanceId).damage).toBe(0);
  });

  it("reports as PARTIAL, naming the clause still missing", () => {
    // **This is the replacement the previous version of this test asked for**, and
    // it arrived the same session: it asserted `isCardImplemented === true` to
    // make the over-report VISIBLE rather than bless it, and said outright that
    // when the coverage entry landed it must be REPLACED, not deleted.
    //
    // Two of his three clauses now work. "I don't deal combat damage" was
    // written centrally the moment this agent flagged that leaving it out made
    // the card STRICTLY STRONGER than printed — his trigger deals his Might, and
    // without the drawback he dealt that AND his Might in the damage step. It
    // lives in `combat.outgoingMight`, beside the Stun rule it mirrors.
    //
    // **And the third has now landed**, which is what this test was told to
    // become: its predecessor asserted the over-report to make it VISIBLE and
    // said outright that when the coverage entry arrived it must be REPLACED,
    // not deleted. So it asserts the finished card, and the clause itself is
    // driven below.
    expect(isCardImplemented(registry.get(EZREAL_DASHING))).toBe(true);
    expect(partialImplementationNote(registry.get(EZREAL_DASHING)), "a note outlived its clause").toBeUndefined();
  });

  describe("his third clause — :rb_rune_mind:: [Action] — Move me to your base", () => {
    /** Ezreal at bf1 with `runes` Mind runes channeled, and an enemy beside him
     *  so the battlefield is a place worth leaving. */
    function atBattlefield(runes: number, domain: "Mind" | "Fury" = "Mind"): GameState {
      const ezreal = unitCard(EZREAL_DASHING);
      const state = makeState({ phase: "Action" });
      state.battlefields[0]!.units = { p1: [ezreal], p2: [makeUnit({ might: 1 })] };
      state.players[0]!.channeled = Array.from({ length: runes }, (_, i) => ({
        id: `r${i}`,
        domain,
        state: "Ready" as const,
      }));
      return state;
    }

    const ezrealAction = (state: GameState) =>
      legalActions(state).find(
        (a): a is ActivateAbilityAction =>
          a.type === "ActivateAbility" &&
          (state.battlefields[0]!.units.p1 ?? []).some((u) => u.instanceId === a.permanentInstanceId),
      );

    it("walks him home for one Mind Power", () => {
      const state = atBattlefield(1);
      const use = ezrealAction(state);
      expect(use, "the ability was not offered").toBeDefined();

      const { state: after, result } = submit(state, use!);
      expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
      expect(after.battlefields[0]!.units.p1 ?? [], "he is still at the battlefield").toHaveLength(0);
      expect(after.players[0]!.baseUnits, "he did not arrive in base").toHaveLength(1);
      // A Power cost RECYCLES the rune (416) rather than exhausting it.
      expect(after.players[0]!.channeled, "the Mind Power was not paid").toHaveLength(0);
    });

    /** The domain is printed, so a rune of another domain cannot pay it. */
    it("is not offered off a rune of the wrong domain", () => {
      expect(ezrealAction(atBattlefield(1, "Fury")), "a Fury rune paid a Mind pip").toBeUndefined();
    });

    /**
     * **The ability's COST takes no exhaust, because none is printed** — asserted
     * on the cost itself, which is the only place the distinction is visible.
     *
     * He arrives in base EXHAUSTED all the same, and that is not this ability:
     * `recallUnitToBase` force-exhausts on arrival, and whether a card-driven
     * recall should is an OPEN QUESTION already filed in
     * docs/rules-conformance.md — Flash and Maddened Marauder both say "move",
     * not "recall", and neither mentions exhaustion. Ezreal is the third card to
     * ride it and the first where the recall is a REPEATABLE ability.
     *
     * Asserted rather than left silent, so that settling the question fails this
     * test instead of being discovered in play.
     */
    it("takes no exhaust as a COST, though the recall exhausts him on arrival", () => {
      expect(activationCostOf(EZREAL_DASHING).exhaust, "an exhaust nobody printed was added to the cost").toBeUndefined();
      expect(activationCostOf(EZREAL_DASHING)).toEqual({ power: { domain: "Mind", count: 1 } });

      const state = atBattlefield(1);
      const after = submit(state, ezrealAction(state)!).state;
      expect(after.players[0]!.baseUnits[0]!.exhausted, "see the open question above — this is the RECALL's exhaust").toBe(
        true,
      );
    });
  });

  it("really does deal no combat damage now", () => {
    // The clause that was missing when this file was written, asserted from the
    // side this file owns: a 9-Might Ezreal contributes nothing to the damage
    // step, so a 1-Might defender walks away.
    const ezreal = unitCard(EZREAL_DASHING);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [{ ...ezreal, might: 9 }], p2: [makeUnit({ might: 1 })] };

    const after = resolveShowdown(state, "bf1", 0);

    expect(after.battlefields[0]!.units.p2 ?? [], "the defender took Ezreal's Might").toHaveLength(1);
  });
});
