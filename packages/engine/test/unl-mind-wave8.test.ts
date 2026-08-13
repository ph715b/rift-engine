import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Deadly Flourish's SECOND sentence — "When it dies this turn, play a Gold gear
 * token exhausted." The first sentence (3 damage) is covered by
 * unl-mind-wave4.test.ts and is not re-tested here.
 *
 * **Everything drives `legalActions` -> `submit`.** The clause fires from a card
 * sitting in a TRASH, through `TRASH_LISTENER_DEF_IDS` -> `allListeningPermanents`
 * -> `holdEventTrigger` -> the Cleanup's finalize -> `resolvePendingTrigger`. That
 * is five hops, every one of which can silently drop the whole thing, and calling
 * the death-watch's `resolve` directly would clear all five at once.
 *
 * Each positive has a negative beside it that shares its setup, so "no Gold
 * arrived" is only ever asserted where a Gold demonstrably could have.
 */

const registry = defaultCardRegistry();

const DEADLY_FLOURISH = "UNL-073"; // Mind Spell, 4 Energy — "Deal 3 to an enemy unit. When it dies this turn, ..."
const BIG_SHOT = "OGN-085"; // Mind Spell, 5 Energy — "[Action] Deal 6 to a unit at a battlefield", the killer of record
const BOUNCE = "OGN-172"; // Chaos Spell, 2 Energy 2 Chaos — "[Action] Return a unit at a battlefield to its owner's hand"
const VANILLA = "OGN-219"; // Order Unit, 4 Energy, 4 Might, no text at all — a victim with no opinions

/** Ready runes enough to pay any cost in this file several times over. Half
 *  Chaos because Rebuke is the one card here with a domained Power pip; the rest
 *  cost pure Energy, which any rune pays. */
const runes = (count = 20): RuneCard[] => [
  ...Array.from({ length: count }, (_, i) => ({ id: `Mind-${i}`, domain: "Mind" as const, state: "Ready" as const })),
  ...Array.from({ length: count }, (_, i) => ({ id: `Chaos-${i}`, domain: "Chaos" as const, state: "Ready" as const })),
];

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are empty. The Gold token
 *  arrives on a chain pop, not inline, so a test that skipped this would measure
 *  the board one step too early. */
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

const castsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Plays `instanceId` at `targetId`, insisting the pair was actually OFFERED —
 *  an enumeration that never produced the action is the failure this catches. */
function castAt(state: GameState, instanceId: string, targetId: string): GameState {
  const cast = castsOf(state, instanceId).find((a) => a.targetUnitInstanceId === targetId);
  expect(cast, `${instanceId} was never offered against ${targetId}`).toBeDefined();
  return passUntilSettled(accept(state, cast!));
}

const goldTokens = (state: GameState, playerIndex: 0 | 1) =>
  state.players[playerIndex]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

const unitOnBoard = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/**
 * p0 holds the Flourish plus whatever else the test needs; p1 has ONE unit at
 * bf1, a real vanilla 4-Might body so that the printed 3 is deliberately not
 * lethal unless the test says so.
 */
function board(extraSpellsForP0: string[] = [], victimMight?: number) {
  const flourish = spellInstance(DEADLY_FLOURISH);
  const extras = extraSpellsForP0.map((defId) => spellInstance(defId));
  const victim = { ...realUnitInstance(VANILLA), instanceId: "victim" } as UnitInstance;
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [flourish, ...extras];
  state.players[0]!.channeled = runes();
  state.players[1]!.channeled = runes();
  state.battlefields[0]!.units = { p2: [victimMight === undefined ? victim : { ...victim, might: victimMight }] };
  return { state, flourishId: flourish.instanceId, extraIds: extras.map((c) => c.instanceId) };
}

describe("Deadly Flourish (UNL-073): the delayed Gold token", () => {
  it("pays a Gold gear token, exhausted, when the 3 is itself lethal", () => {
    const { state, flourishId } = board([], 3);

    const after = castAt(state, flourishId, "victim");

    expect(unitOnBoard(after, "victim"), "the victim survived, so nothing was being tested").toBeUndefined();
    const gold = goldTokens(after, 0);
    expect(gold, "the delayed clause never fired").toHaveLength(1);
    expect(gold[0]!.exhausted, "'play a Gold gear token EXHAUSTED'").toBe(true);
    expect(goldTokens(after, 1), "the Gold went to the wrong player").toHaveLength(0);
  });

  it("pays when the victim dies LATER in the same turn, to something else entirely", () => {
    const { state, flourishId, extraIds } = board([BIG_SHOT]);

    const damaged = castAt(state, flourishId, "victim");
    // The control that makes the second half mean something: the 3 was not
    // lethal, the victim is still standing, and no Gold has been paid yet.
    expect(unitOnBoard(damaged, "victim")?.damage).toBe(3);
    expect(goldTokens(damaged, 0), "a Gold arrived before anything died").toHaveLength(0);

    const killed = castAt(damaged, extraIds[0]!, "victim");

    expect(unitOnBoard(killed, "victim")).toBeUndefined();
    expect(goldTokens(killed, 0), "the mark did not survive the spell that wrote it").toHaveLength(1);
  });

  it("pays NOTHING for a different unit's death — the mark is per victim", () => {
    // Two enemies; the Flourish hits one and the kill lands on the other.
    const { state, flourishId, extraIds } = board([BIG_SHOT]);
    const bystander = { ...realUnitInstance(VANILLA), instanceId: "bystander" } as UnitInstance;
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, bystander];

    const damaged = castAt(state, flourishId, "victim");
    const killed = castAt(damaged, extraIds[0]!, "bystander");

    // Positive control on the negative: the death really happened, and the
    // Flourish really is in the trash watching for one.
    expect(unitOnBoard(killed, "bystander"), "nothing died, so 'no Gold' proves nothing").toBeUndefined();
    expect(killed.players[0]!.trash.map((c) => c.defId)).toContain(DEADLY_FLOURISH);
    expect(goldTokens(killed, 0), "the death-watch fired for a unit it never marked").toHaveLength(0);
  });

  it("pays nothing when no Flourish was cast at all", () => {
    // The inertness control for the whole mechanism: the same lethal spell, the
    // same board, no mark. Without this, a `placeGoldTokens` wired to the wrong
    // event would still pass every test above.
    const { state, extraIds } = board([BIG_SHOT]);

    const killed = castAt(state, extraIds[0]!, "victim");

    expect(unitOnBoard(killed, "victim")).toBeUndefined();
    expect(goldTokens(killed, 0)).toHaveLength(0);
  });

  it("two Flourishes on DIFFERENT victims pay only for the one that died", () => {
    // The mutation this exists for: keying the mark on the DEFID instead of the
    // spell instance survives every other test in this file, because two marks
    // are appended separately and a victim who carries both pays twice either
    // way. It fails only here, where the two marks are on two different bodies
    // and a defId key would let the second Flourish's listener answer for the
    // first Flourish's victim.
    const { state, flourishId, extraIds } = board([DEADLY_FLOURISH], 3);
    const other = { ...realUnitInstance(VANILLA), instanceId: "other" } as UnitInstance;
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, other];

    const first = castAt(state, flourishId, "other"); // 4 Might, survives the 3
    const second = castAt(first, extraIds[0]!, "victim"); // 3 Might, dies to it

    expect(unitOnBoard(second, "other"), "the marked survivor died after all").toBeDefined();
    expect(unitOnBoard(second, "victim")).toBeUndefined();
    expect(goldTokens(second, 0), "a Flourish paid out for a unit it never marked").toHaveLength(1);
  });

  it("two Flourishes on one victim pay two Gold tokens", () => {
    // 390.2 makes each a delayed trigger of its own, so the mark is keyed by the
    // SPELL INSTANCE rather than by defId. A defId key would collapse these to
    // one, and 3 + 3 on a 4-Might body is the cheapest way to reach the case.
    const { state, flourishId, extraIds } = board([DEADLY_FLOURISH]);

    const once = castAt(state, flourishId, "victim");
    expect(unitOnBoard(once, "victim"), "one Flourish was already lethal").toBeDefined();
    const twice = castAt(once, extraIds[0]!, "victim");

    expect(unitOnBoard(twice, "victim")).toBeUndefined();
    expect(goldTokens(twice, 0), "the two marks collapsed into one").toHaveLength(2);
  });

  /**
   * The turn stamp in the mark, pinned against the one route that evades the
   * end-of-turn sweep.
   *
   * `turn-manager`'s `expireMightThisTurn` clears `abilityModesUsedThisTurn` for
   * base units and battlefield units and NOTHING else, so a marked victim bounced
   * to its owner's hand keeps the mark across the turn boundary. Rule 124 makes
   * the card that comes back "a new object for the purposes of tracking that
   * object", and the printed "this turn" has expired regardless — so the second
   * death must pay nothing.
   *
   * The middle assertion is the one that makes this a real test rather than a
   * tautology: it measures that the stale mark IS still on the card in hand. Take
   * the turn out of the key and this test goes red while every other test in the
   * file stays green.
   */
  it("pays nothing on a LATER turn, even though the stale mark survives in hand", () => {
    const { state, flourishId, extraIds } = board([BOUNCE]);
    // A second p1 body at bf1, purely so the bounced victim can be REINFORCED
    // back there next turn: a unit may only be played to a battlefield its
    // controller already occupies, and Big Shot's "at a battlefield" cannot reach
    // base. It is never targeted by anything here.
    const garrison = { ...realUnitInstance(VANILLA), instanceId: "garrison" } as UnitInstance;
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, garrison];

    const damaged = castAt(state, flourishId, "victim");
    const bounced = castAt(damaged, extraIds[0]!, "victim");

    const inHand = bounced.players[1]!.hand.find((c) => c.instanceId === "victim");
    expect(inHand, "the bounce did not happen, so nothing crossed a turn boundary").toBeDefined();
    const marksInHand = "abilityModesUsedThisTurn" in inHand! ? (inHand as UnitInstance).abilityModesUsedThisTurn : [];
    expect(marksInHand, "the mark never rode into the hand — this test is pinning nothing").toHaveLength(1);

    // p1's turn. The victim is replayed by its owner and then killed by p1's own
    // Big Shot, which is the only way to make it die on a turn that is not the
    // Flourish caster's.
    const p1Turn = { ...runEnd(bounced), phase: "Action" as const };
    expect(p1Turn.activePlayerIndex).toBe(1);
    expect(
      (p1Turn.players[1]!.hand.find((c) => c.instanceId === "victim") as UnitInstance).abilityModesUsedThisTurn,
      "the sweep reached the hand after all, so the turn stamp is not what is being relied on",
    ).toHaveLength(1);

    // Replayed to bf1 specifically, because the killer below is Big Shot and its
    // printed "a unit AT A BATTLEFIELD" would not reach a unit sitting in base.
    const replay = castsOf(p1Turn, "victim").find((a) => a.destinationBattlefieldId === "bf1");
    expect(replay, "the bounced unit could not be replayed to a battlefield").toBeDefined();
    const replayed = passUntilSettled(accept(p1Turn, replay!));
    expect(unitOnBoard(replayed, "victim"), "the replay did not reach the board").toBeDefined();

    const shot = spellInstance(BIG_SHOT);
    const armed = {
      ...replayed,
      players: [replayed.players[0]!, { ...replayed.players[1]!, hand: [...replayed.players[1]!.hand, shot] }],
    } as GameState;
    const killed = castAt(armed, shot.instanceId, "victim");

    expect(unitOnBoard(killed, "victim"), "the victim never died, so 'no Gold' proves nothing").toBeUndefined();
    expect(killed.players[0]!.trash.map((c) => c.defId), "the Flourish left the trash").toContain(DEADLY_FLOURISH);
    expect(goldTokens(killed, 0), "a mark from a previous turn paid out").toHaveLength(0);
    expect(goldTokens(killed, 1)).toHaveLength(0);
  });

  /**
   * Rule 124 again, on the shorter route: the victim dies, the Gold is paid, and
   * the card is played back out of the trash on the SAME turn. The new object
   * must not pay a second time, which is what `forgetDeadlyFlourishMark` is for —
   * the turn stamp cannot help here, since nothing about the turn has changed.
   *
   * Driven at the state level rather than through Last Rites' permission, because
   * what is under test is whether the mark is still on the card once the trigger
   * has resolved; how it got replayed is not the question.
   */
  it("strips the mark once it has paid, so a same-turn replay cannot pay twice", () => {
    const { state, flourishId } = board([], 3);

    const after = castAt(state, flourishId, "victim");

    expect(goldTokens(after, 0), "no Gold was paid, so there is no strip to observe").toHaveLength(1);
    const corpse = after.players[1]!.trash.find((c) => c.instanceId === "victim");
    expect(corpse, "the victim is not in the trash").toBeDefined();
    expect(
      (corpse as UnitInstance).abilityModesUsedThisTurn,
      "the spent mark is still on the corpse — a replay would pay a second Gold",
    ).toHaveLength(0);
  });
});
