import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardMayMoveToBase, cardMovesTarget } from "../src/engine/card-effects.js";
import { delayedDeathMark } from "../src/engine/effect-helpers.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's dual-domain spell block, wave 2 — the two whose first domain in
 * canonical order is Calm.**
 *
 * Neither card needed a new mechanism, and in both cases finding that out was the
 * work:
 *
 *   - **Siphoning Strike's "when it dies this turn" is Deadly Flourish's
 *     mechanism exactly** — a mark on the victim that rides `DeathContext.unit`
 *     into the trigger, read by a listener sitting in the caster's TRASH. The
 *     scope note in `docs/` said a delayed death clause needed machinery; the
 *     code said it had been built two sets ago. The key builder is now shared
 *     rather than copied, on the same two-makers threshold this repo applies to
 *     token specs.
 *   - **Shadow Dash reuses `moveDestinationAllowed`** — but NOT Temptation's
 *     entry in it. That one asks about the MOVED unit's controller; this asks
 *     about the CASTER's, and on a split board the two name disjoint
 *     destinations. Reusing it would have let the card send the enemy home.
 *
 * **Everything that can drive `legalActions` -> `submit` does.** Siphoning
 * Strike's clause fires through five hops — `TRASH_LISTENER_DEF_IDS` ->
 * `allListeningPermanents` -> `holdEventTrigger` -> the Cleanup's finalize ->
 * `resolvePendingTrigger` — every one of which can silently drop the whole thing,
 * and calling the death-watch's `resolve` directly would clear all five at once.
 */

const registry = defaultCardRegistry();

const SIPHONING_STRIKE = "VEN-146"; // Calm+Mind Spell, 4 Energy
const SHADOW_DASH = "VEN-148"; // Calm+Order Spell, 2 Energy 1 Power
const BIG_SHOT = "OGN-085"; // Mind Spell, 5 Energy — "[Action] Deal 6 to a unit at a battlefield", the later killer
const VANILLA = "OGN-219"; // Order Unit, 4 Energy, 4 Might, no text at all — a victim with no opinions

/** Ready runes enough to pay anything here several times over, in every domain
 *  the two cards' Power pips can name. `count` is what "you control N runes"
 *  reads, so the tests that turn on 7 pass it explicitly. */
const runes = (count = 20): RuneCard[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r${i}`, domain: "Calm", state: "Ready" }) as RuneCard);

/** Runes still in the deck, so `channelRunesExhausted` has something to take. */
const runeDeck = (count = RUNE_DECK_SIZE): RuneCard[] =>
  Array.from({ length: count }, (_, i) => ({ id: `deck-${i}`, domain: "Order", state: "Ready" }) as RuneCard);

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are empty. The channelled
 *  rune arrives on a chain pop, not inline, so a test that skipped this would
 *  measure the board one step too early. */
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

const unitOnBoard = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/**
 * How many runes this player has CHANNELLED out of their rune deck.
 *
 * Measured off `runeDeck` rather than off "how many channeled runes are
 * exhausted", which was the first version and measured the wrong thing entirely:
 * paying a spell's Energy exhausts channeled runes, so casting the 4-Energy
 * Strike moved that number by 4 before anything had died. The rune deck is only
 * ever touched by a channel.
 */
const channelledCount = (state: GameState, playerIndex: 0 | 1) =>
  RUNE_DECK_SIZE - state.players[playerIndex]!.runeDeck.length;

const RUNE_DECK_SIZE = 5;

describe("both report implemented — the premise", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [SIPHONING_STRIKE, SHADOW_DASH]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });
});

describe("Siphoning Strike (VEN-146): 4 or 7, and a delayed rune", () => {
  /**
   * p0 holds the Strike plus whatever else the test needs; p1 has ONE unit at
   * bf1, a real vanilla 4-Might body so that the printed 4 is exactly lethal
   * unless the test says otherwise.
   */
  function board(opts: { runeCount?: number; victimMight?: number; extras?: string[] } = {}) {
    const strike = spellInstance(SIPHONING_STRIKE);
    const extras = (opts.extras ?? []).map((defId) => spellInstance(defId));
    const victim = { ...realUnitInstance(VANILLA), instanceId: "victim" } as UnitInstance;
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [strike, ...extras];
    state.players[0]!.channeled = runes(opts.runeCount ?? 6);
    state.players[0]!.runeDeck = runeDeck();
    state.players[1]!.channeled = runes();
    // BOTH rune decks, so `channelledCount` reads the same baseline for either
    // seat — the "it went to the wrong player" assertion is otherwise measuring
    // an empty deck rather than a channel that did not happen.
    state.players[1]!.runeDeck = runeDeck();
    state.battlefields[0]!.units = {
      p2: [opts.victimMight === undefined ? victim : { ...victim, might: opts.victimMight }],
    };
    return { state, strikeId: strike.instanceId, extraIds: extras.map((c) => c.instanceId) };
  }

  it("deals 4 below the rune threshold", () => {
    // Six runes: one short. The victim is a 10-Might body so the number is
    // readable off its damage rather than off whether it died.
    const { state, strikeId } = board({ runeCount: 6, victimMight: 10 });
    const after = castAt(state, strikeId, "victim");
    expect(unitOnBoard(after, "victim")?.damage, "the base damage is wrong").toBe(4);
  });

  it("deals 7 at EXACTLY seven runes — the boundary the card prints", () => {
    // "7 or more", so seven is the first paying number. Asserted at the boundary
    // rather than at ten, because an off-by-one in either direction is the
    // realistic mistake and only this value catches it.
    const { state, strikeId } = board({ runeCount: 7, victimMight: 10 });
    const after = castAt(state, strikeId, "victim");
    expect(unitOnBoard(after, "victim")?.damage, "seven runes did not reach the bigger number").toBe(7);
  });

  it("...as ONE damage instance, not a 4 and then a 3", () => {
    // "Instead" replaces the AMOUNT, so the card deals 4 or 7 and never both. The
    // difference is invisible in the damage total, which is why it is asserted
    // through a once-per-INSTANCE prevention: Counter Strike's shield "stops one
    // instance of any size and is spent", so a single 7 is absorbed whole while a
    // 4 followed by a 3 would lose the 4 and land the 3.
    //
    // The first version of this test read `damageInstancesByCardThisTurn`, which
    // measures nothing here — that tally is opt-in per card and only Dancing
    // Grenade writes to it.
    const { state, strikeId } = board({ runeCount: 7, victimMight: 10 });
    state.damagePreventedOnceInstanceIds = ["victim"];

    const after = castAt(state, strikeId, "victim");
    expect(unitOnBoard(after, "victim")?.damage, "the card dealt damage twice").toBe(0);
  });

  it("channels a rune EXHAUSTED for the caster when its own damage kills", () => {
    const { state, strikeId } = board({ victimMight: 4 });

    const after = castAt(state, strikeId, "victim");

    expect(unitOnBoard(after, "victim"), "the victim survived, so nothing was being tested").toBeUndefined();
    expect(channelledCount(after, 0), "the delayed clause never fired").toBe(1);
    expect(channelledCount(after, 1), "the rune went to the wrong player").toBe(0);
    // "Channel 1 rune EXHAUSTED" — it arrives spent, so it pays for nothing this
    // turn. A ready one would be a materially better card.
    expect(
      after.players[0]!.channeled.filter((r) => r.id.startsWith("deck-")).map((r) => r.state),
      "the channelled rune arrived READY",
    ).toEqual(["Exhausted"]);
  });

  it("...and pays when the victim dies LATER the same turn, to something else", () => {
    // The half that makes it a delayed ability rather than a rider on the damage:
    // the card says "when it dies", not "when this kills it".
    const { state, strikeId, extraIds } = board({ victimMight: 10, extras: [BIG_SHOT] });

    const damaged = castAt(state, strikeId, "victim");
    // The control that makes the second half mean something: the 4 was not
    // lethal, the victim is standing, and nothing has been channelled yet.
    expect(unitOnBoard(damaged, "victim")?.damage).toBe(4);
    expect(channelledCount(damaged, 0), "a rune arrived before anything died").toBe(0);

    // Re-armed rather than started with twenty runes, because the rune COUNT is
    // this card's own threshold — a fixture rich enough to pay for both spells
    // would silently be testing the 7 instead of the 4.
    damaged.players[0]!.channeled = runes(6);
    const killed = castAt(damaged, extraIds[0]!, "victim");
    expect(unitOnBoard(killed, "victim"), "the second spell did not kill it").toBeUndefined();
    expect(channelledCount(killed, 0), "the delayed clause did not survive to the real death").toBe(1);
  });

  it("pays NOTHING while the victim is still alive", () => {
    const { state, strikeId } = board({ victimMight: 10 });
    const after = castAt(state, strikeId, "victim");

    expect(unitOnBoard(after, "victim"), "the victim died — this measures nothing").toBeDefined();
    expect(channelledCount(after, 0), "a rune was channelled with nothing dead").toBe(0);
  });

  it("expires with the turn for a victim that STAYED on the board", () => {
    // **Two different mechanisms end "this turn", and this is the first of them:**
    // `runEnd`'s `expireMightThisTurn` clears `abilityModesUsedThisTurn` on every
    // unit at a base or a battlefield, so a victim that simply survived loses the
    // mark to the sweep and never reaches the key at all.
    //
    // Named that way because a mutant proved it: removing the TURN STAMP from the
    // key left this test green, since the sweep had already done the work. The
    // stamp's own case is the test directly below.
    //
    // A 6-Might victim, so the later Big Shot's 6 is lethal ON ITS OWN — `runEnd`
    // heals, and a victim sized to need both spells' damage added together would
    // simply survive into the next turn and prove nothing.
    const { state, strikeId, extraIds } = board({ victimMight: 6, extras: [BIG_SHOT] });
    const damaged = castAt(state, strikeId, "victim");
    // TWICE, deliberately: one `runEnd` passes the turn to p1 and leaves
    // `turnNumber` alone, so only half the key has moved. Two brings play back to
    // p0 with the number bumped, which is a genuinely later turn of the same
    // player — the case a one-half key would let through.
    // `runEnd` insists on the Action phase and leaves the next turn in Awaken, so
    // the phase is restored between the two — the fixture standing in for the
    // phases a real turn would walk through.
    const midTurn = { ...runEnd(damaged), phase: "Action" as const };
    const nextTurn = { ...runEnd(midTurn), phase: "Action" as const };
    expect(nextTurn.activePlayerIndex, "the fixture did not return the turn to the caster").toBe(0);
    expect(nextTurn.turnNumber, "the turn number did not advance").toBeGreaterThan(damaged.turnNumber);

    // Re-arm so the killer is castable on the new turn.
    nextTurn.players[0]!.channeled = runes(6);
    const before = channelledCount(nextTurn, 0);
    const killed = castAt(nextTurn, extraIds[0]!, "victim");

    expect(unitOnBoard(killed, "victim"), "the victim did not die — this measures nothing").toBeUndefined();
    expect(channelledCount(killed, 0) - before, "a mark from last turn still paid").toBe(0);
  });

  it("...and expires for one that LEFT the board and came back — the turn stamp", () => {
    // **The second mechanism, and the only one the stamp is for.** The sweep above
    // reaches units at a base or a battlefield and nothing else, so a victim that
    // spent the turn boundary in a hand, a trash or a banished pile carries its
    // mark back onto the board unswept. Rule 124 makes it a new object; the key's
    // `t`/`p` halves are what make the old mark fail to match.
    //
    // Built as the STATE that arises rather than by replaying a bounce, because
    // the bounce is not what is under test — a mark stamped on an earlier turn,
    // on a board that has moved on, is. `delayedDeathMark` itself builds both
    // sides, so this asserts the contract rather than mirroring the format.
    const { state, strikeId, extraIds } = board({ victimMight: 6, extras: [BIG_SHOT] });
    const stale = delayedDeathMark(state, SIPHONING_STRIKE, strikeId);

    // A later turn of the same player, with the Strike where a played spell rests
    // and the victim carrying the OLD turn's mark.
    const later: GameState = {
      ...state,
      turnNumber: state.turnNumber + 1,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0
          ? {
              ...bf,
              units: {
                p2: [{ ...(unitOnBoard(state, "victim") as UnitInstance), abilityModesUsedThisTurn: [stale] }],
              },
            }
          : bf,
      ),
    };
    later.players[0]!.trash = [spellInstance(SIPHONING_STRIKE)];
    later.players[0]!.trash[0]!.instanceId = strikeId;

    // The control: the mark really is on the victim, so a green result below is
    // the stamp refusing it rather than the mark having gone missing.
    expect(unitOnBoard(later, "victim")?.abilityModesUsedThisTurn, "the fixture lost the mark").toEqual([stale]);

    const before = channelledCount(later, 0);
    const killed = castAt(later, extraIds[0]!, "victim");

    expect(unitOnBoard(killed, "victim"), "the victim did not die — this measures nothing").toBeUndefined();
    expect(channelledCount(killed, 0) - before, "a mark stamped on an earlier turn still paid").toBe(0);
  });

  it("may be aimed at a FRIENDLY unit — no owner word is printed", () => {
    // "Deal 4 to A UNIT at a battlefield." 355.9.a.1 widens the bare noun and
    // nothing narrows the owner, so your own body is a legal target. Rarely what
    // you want, and never the engine's to withhold.
    const { state, strikeId } = board({ victimMight: 10 });
    const mine = { ...(makeUnit({ might: 9 }) as UnitInstance), instanceId: "mine" };
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [mine] };

    expect(
      castsOf(state, strikeId).some((a) => a.targetUnitInstanceId === "mine"),
      "a friendly unit was not offered",
    ).toBe(true);
  });

  it("...but never one in a BASE — the printed 'at a battlefield' binds", () => {
    // 355.9.b, the NARROWING half. Without it the printed location clause is free
    // text and the card reaches a board it never should.
    const { state, strikeId } = board({ victimMight: 10 });
    state.players[1]!.baseUnits = [{ ...(makeUnit({ might: 9 }) as UnitInstance), instanceId: "at-home" }];

    expect(
      castsOf(state, strikeId).some((a) => a.targetUnitInstanceId === "at-home"),
      "a unit in a base was offered",
    ).toBe(false);
  });
});

describe("Shadow Dash (VEN-148): a destination measured from the CASTER", () => {
  /**
   * bf1 holds one of p0's units; bf2 holds none. The enemy starts at bf2, so the
   * only legal destination is bf1 and the illegal one is where it already stands.
   */
  function board(friendliesAtBf1 = 2) {
    const dash = spellInstance(SHADOW_DASH);
    const enemy = { ...(makeUnit({ might: 4 }) as UnitInstance), instanceId: "enemy" };
    const mine = Array.from({ length: friendliesAtBf1 }, (_, i) => ({
      ...(makeUnit({ might: 3 }) as UnitInstance),
      instanceId: `mine-${i}`,
    }));
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [dash];
    state.players[0]!.channeled = runes();
    state.players[1]!.channeled = runes();
    state.battlefields[0]!.units = { p1: mine };
    state.battlefields[1]!.units = { p2: [enemy] };
    return { state, dashId: dash.instanceId };
  }

  const destinations = (state: GameState, dashId: string) =>
    castsOf(state, dashId)
      .filter((a) => a.targetUnitInstanceId === "enemy")
      .map((a) => (a.destinationIsBase === true ? "base" : a.destinationBattlefieldId));

  it("declares the destination axis and refuses a BASE", () => {
    expect(cardMovesTarget(SHADOW_DASH), "the destination axis is not declared").toBe(true);
    // "To a BATTLEFIELD where you have units" — there is no reading of that which
    // reaches a base, so it is deliberately absent from MOVE_TO_BASE_DEF_IDS.
    expect(cardMayMoveToBase(SHADOW_DASH), "a base was offered as a destination").toBe(false);
  });

  it("offers ONLY the battlefield where the caster has units", () => {
    const { state, dashId } = board(2);
    const offered = destinations(state, dashId);

    expect(offered, "the caster's own battlefield was not offered").toContain("bf1");
    expect(offered, "a battlefield with no friendly unit was offered").not.toContain("bf2");
    expect(offered, "a base was offered").not.toContain("base");
  });

  it("is UNCASTABLE with friendlies nowhere — a move with nowhere to go", () => {
    // The negative that gives the positive its meaning: the restriction is real,
    // not an artefact of bf2 being where the enemy already stands.
    const { state, dashId } = board(0);
    expect(castsOf(state, dashId), "castable with no battlefield to send them to").toEqual([]);
  });

  it("moves the enemy, and pumps the caster's EXACTLY TWO there", () => {
    const { state, dashId } = board(2);
    const after = castAt(state, dashId, "enemy");

    expect(
      after.battlefields[0]!.units.p2?.map((u) => u.instanceId),
      "the enemy did not arrive",
    ).toEqual(["enemy"]);
    for (const id of ["mine-0", "mine-1"]) {
      expect(unitOnBoard(after, id)?.mightThisTurn, `${id} was not pumped`).toBe(1);
    }
    // "THEY each get +1" is the caster's two, not the newcomer — the enemy is not
    // one of "your units there", and counting it would make every landing pay.
    expect(unitOnBoard(after, "enemy")?.mightThisTurn, "the moved enemy was pumped").toBe(0);
  });

  it("pumps NOTHING with one friendly there", () => {
    const { state, dashId } = board(1);
    const after = castAt(state, dashId, "enemy");

    expect(after.battlefields[0]!.units.p2?.map((u) => u.instanceId), "the move itself failed").toEqual(["enemy"]);
    expect(unitOnBoard(after, "mine-0")?.mightThisTurn, "one friendly paid the bonus").toBe(0);
  });

  it("...and nothing with THREE — 'exactly two' is a shape, not a floor", () => {
    const { state, dashId } = board(3);
    const after = castAt(state, dashId, "enemy");

    expect(after.battlefields[0]!.units.p2?.map((u) => u.instanceId), "the move itself failed").toEqual(["enemy"]);
    for (const id of ["mine-0", "mine-1", "mine-2"]) {
      expect(unitOnBoard(after, id)?.mightThisTurn, `${id} was pumped by a third friendly`).toBe(0);
    }
  });
});
