import { describe, expect, it } from "vitest";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

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
const GARBAGE_GRABBER = "OGN-099"; // Gear, Mind, 2 Energy
const MUSHROOM_POUCH = "OGN-101"; // Gear, Mind, 2 Energy
const FALLING_COMET = "OGN-085"; // Spell — the non-gear that must NOT be offered

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

  it("asks nothing and moves nothing when the trash holds no gear (422)", () => {
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
