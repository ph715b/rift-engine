import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { implementingModule, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { gainXp } from "../src/engine/effect-helpers.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance, keepTriggerOrder, } from "./fixtures.js";

/**
 * Wave 3's Body cards — four written, four refused.
 *
 * Every card here is driven through `submit`/`legalActions` or through the real
 * event that fires it, never by calling a resolver: a registered effect whose
 * choice is dropped on the dispatch hop reports IMPLEMENTED and does nothing in a
 * real game, which is the failure this repo keeps finding. So each card gets the
 * same shape — make the effect fire, assert it fired, and assert it does NOT fire
 * with its condition removed.
 *
 * **Every "nothing happened" assertion has a positive control beside it**, in the
 * same test where the fixture is shared. A wave-2 mutation survived here because
 * two separate fixtures made a filter return 0 of 0, which reads exactly like a
 * pass.
 *
 * The four refusals (UNL-091's cost half, UNL-095's delayed XP, UNL-108 entire,
 * UNL-113's `[Level 6]` clause) are PINNED at the foot of this file, asserting the
 * wrong answer so that closing any of them fails loudly.
 */

const registry = defaultCardRegistry();
const STARE_DOWN = "UNL-107";
const WILY_NEWTFISH = "UNL-108";
const BLOOD_ROSE = "UNL-109";
const MASTER_YI_TEMPERED = "UNL-113";
const NIDALEE_CAT_FORM = "UNL-114";
const NILAH_JOYFUL_ASCETIC = "UNL-115";
/** A vanilla Body unit with no text at all — the thing Blood Rose's "when you
 *  play a unit" needs to see played, chosen so nothing else can fire. */
const SEA_MONKEY = "SFD-098";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties or a question stops it — a Spell takes
 *  effect on resolution, and `submit` refuses a pass while a decision is
 *  outstanding (320.1). */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    // 383.3.d's ordering question is settled with the order already placed, so
    // this loop keeps driving whatever it was actually written to test. See
    // `fixtures.keepTriggerOrder`.
    current = keepTriggerOrder(current);
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  return current;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const unitsAt = (state: GameState, battlefieldId: string, playerId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const unitAnywhere = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

const filler = (count: number, defId = STARE_DOWN) =>
  Array.from({ length: count }, () => createCardInstance(registry.get(defId)));

describe("Stare Down (UNL-107): send the weaker enemies at a battlefield home", () => {
  /**
   * A 5-Might friendly in base, and three enemies at bf1 whose Mights bracket it:
   * 3 (weaker), 5 (equal, so it stays — "LESS Might" is strictly less) and 7. One
   * more enemy of 1 Might sits at bf2, where the spell is not looking.
   */
  function armed(): { state: GameState; spellId: string } {
    const spell = spellInstance(STARE_DOWN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 4);
    state.players[0]!.baseUnits = [makeUnit({ name: "Glarer", instanceId: "glarer", might: 5 })];
    state.battlefields[0]!.units = {
      p2: [
        makeUnit({ name: "Weak", instanceId: "weak", might: 3 }),
        makeUnit({ name: "Equal", instanceId: "equal", might: 5 }),
        makeUnit({ name: "Strong", instanceId: "strong", might: 7 }),
      ],
    };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "Elsewhere", instanceId: "elsewhere", might: 1 })] };
    return { state, spellId: spell.instanceId };
  }

  const cast = (state: GameState, spellId: string, battlefieldId: string) =>
    answerDecisions(
      resolveChain(accept(state, playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "glarer")!)),
      (options) => options.find((o) => o.id === battlefieldId)!.id,
    );

  it("moves only the STRICTLY weaker enemies at the chosen battlefield to their base", () => {
    const { state, spellId } = armed();
    const after = cast(state, spellId, "bf1");

    // The positive half first: something actually moved.
    expect(after.players[1]!.baseUnits.map((u) => u.name), "nothing was sent home at all").toEqual(["Weak"]);
    // ...and the two negative halves, which only mean anything beside it.
    expect(unitsAt(after, "bf1", "p2").map((u) => u.name), "an equal- or greater-Might unit was moved").toEqual([
      "Equal",
      "Strong",
    ]);
    expect(unitsAt(after, "bf2", "p2").map((u) => u.name), "a unit at ANOTHER battlefield was moved").toEqual([
      "Elsewhere",
    ]);
  });

  it("gains 1 XP", () => {
    const { state, spellId } = armed();
    expect(cast(state, spellId, "bf1").players[0]!.xp).toBe(1);
  });

  it("gains the XP even when the chosen battlefield holds nothing to move", () => {
    // Two sentences, so the XP is unconditional — and every battlefield is offered
    // precisely so the question can never be DROPPED with the XP inside it.
    const { state, spellId } = armed();
    state.battlefields[1]!.units = {};

    const after = cast(state, spellId, "bf2");

    expect(after.players[0]!.xp, "the XP rode on something happening").toBe(1);
    expect(unitsAt(after, "bf1", "p2"), "the unchosen battlefield was swept anyway").toHaveLength(3);
    expect(after.players[1]!.baseUnits).toHaveLength(0);
  });

  it("never moves a FRIENDLY unit standing there, however weak", () => {
    // "All ENEMY units" — measured from the caster. The positive control is in the
    // same run: the enemy at the same battlefield still goes home.
    const { state, spellId } = armed();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Ally", instanceId: "ally", might: 1 })],
      p2: [makeUnit({ name: "Weak", instanceId: "weak", might: 3 })],
    };

    const after = cast(state, spellId, "bf1");

    expect(after.players[1]!.baseUnits.map((u) => u.name), "the enemy did not move — this run proves nothing").toEqual([
      "Weak",
    ]);
    expect(unitsAt(after, "bf1", "p1").map((u) => u.name), "a friendly unit was sent home").toEqual(["Ally"]);
  });

  it("is never offered an ENEMY unit as the one being chosen", () => {
    // "A FRIENDLY unit" lives in the spec, not the resolver. A spec that dropped
    // `owner` would enumerate the opponent's board and the card would still read
    // as working in every test above.
    const { state, spellId } = armed();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Ally", instanceId: "ally", might: 4 })],
      p2: [makeUnit({ name: "Weak", instanceId: "weak", might: 3 })],
    };

    const named = playsOf(state, spellId).map((p) => p.targetUnitInstanceId);

    expect(named, "no friendly variant was offered — the exclusion below proves nothing").toContain("ally");
    expect(named).toContain("glarer");
    expect(named, "an enemy unit was offered as the chooser").not.toContain("weak");
  });

  it("is UNCASTABLE with no friendly unit on the board — 355.8", () => {
    // The reason the UNIT half is the announced one and the battlefield is the
    // parked question: announcing the battlefield instead would leave this
    // castable, which is wider than printed.
    const { state, spellId } = armed();
    state.players[0]!.baseUnits = [];

    expect(playsOf(state, spellId), "it was castable with nothing to choose").toHaveLength(0);
  });
});

describe("Blood Rose (UNL-109): the XP gear", () => {
  function armed(xp = 0, energy = 2): { state: GameState; gearId: string } {
    const rose = realGearInstance(BLOOD_ROSE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [rose];
    state.players[0]!.channeled = runes("Body", energy);
    state.players[0]!.deck = filler(3);
    return { state: gainXp(state, 0, xp), gearId: rose.instanceId };
  }

  /** Puts a plain unit in hand with the Power to pay for it, so playing it is a
   *  real `PlayCard` through the enumerator rather than a synthesised event. */
  function withUnitInHand(state: GameState): { state: GameState; unitId: string } {
    const monkey = realUnitInstance(SEA_MONKEY);
    const next = { ...state };
    next.players[0]!.hand = [monkey];
    next.players[0]!.channeled = runes("Body", 6);
    return { state: next, unitId: monkey.instanceId };
  }

  describe("first clause — when you play a unit, you may pay [1] to gain 1 XP", () => {
    it("offers the payment, and taking it gains the XP and spends the Energy", () => {
      const { state: base } = armed();
      const { state, unitId } = withUnitInHand(base);
      const play = playsOf(state, unitId)[0];
      expect(play, "the unit was never offered").toBeDefined();

      const stopped = resolveChain(accept(state, play!));
      const question = stopped.pendingDecisions[0];
      expect(question, "Blood Rose never asked").toBeDefined();
      expect(question!.kind).toBe("UNL-109-pay");

      const ready = (s: GameState) => s.players[0]!.channeled.filter((r) => r.state === "Ready").length;
      const before = ready(stopped);
      const after = answerDecisions(stopped, (options) => options.find((o) => o.id === "pay")!.id);

      expect(after.players[0]!.xp, "the XP never landed").toBe(1);
      expect(ready(after), "the [1] was not paid").toBe(before - 1);
    });

    it("declining gains nothing — 'you MAY pay'", () => {
      const { state: base } = armed();
      const { state, unitId } = withUnitInHand(base);
      const stopped = resolveChain(accept(state, playsOf(state, unitId)[0]!));

      // Positive control: the question really was raised, so the zero below is a
      // decline rather than a trigger that never fired.
      expect(stopped.pendingDecisions[0]?.kind).toBe("UNL-109-pay");
      const after = answerDecisions(stopped, () => "decline");

      expect(after.players[0]!.xp).toBe(0);
    });

    it("does NOT fire for a SPELL", () => {
      // "When you play a UNIT". The positive control is the run above; here the
      // same gear, the same pool and a Spell instead.
      const { state: base } = armed();
      const spell = spellInstance(STARE_DOWN);
      const state = { ...base };
      state.players[0]!.hand = [spell];
      state.players[0]!.baseUnits = [makeUnit({ name: "Glarer", instanceId: "glarer", might: 5 })];
      state.players[0]!.channeled = runes("Body", 6);

      const stopped = resolveChain(accept(state, playsOf(state, spell.instanceId).find((p) => p.targetUnitInstanceId === "glarer")!));

      expect(
        stopped.pendingDecisions.filter((d) => d.kind === "UNL-109-pay"),
        "Blood Rose asked about a Spell",
      ).toHaveLength(0);
    });

    it("does NOT fire for the OPPONENT's unit play", () => {
      // "When YOU play a unit" — `casterIndex`, not "any unit enters".
      const { state: base } = armed();
      const monkey = realUnitInstance(SEA_MONKEY);
      const state = { ...base, activePlayerIndex: 1 as const, focusHolder: 1 as const, chainPriority: 1 as const };
      state.players[1]!.hand = [monkey];
      state.players[1]!.channeled = runes("Body", 6);

      const stopped = resolveChain(accept(state, playsOf(state, monkey.instanceId)[0]!));

      expect(
        stopped.pendingDecisions.filter((d) => d.kind === "UNL-109-pay"),
        "Blood Rose asked about the opponent's unit",
      ).toHaveLength(0);
      expect(stopped.players[0]!.xp).toBe(0);
    });

    it("is not offered at all when the [1] cannot be paid", () => {
      // The offer is gated where it is MADE, so an unpayable "you may pay" does not
      // cost both players a response window. Positive control in the same test: the
      // identical fixture with one more rune does ask.
      const { state: base } = armed(0, 0);
      const monkey = realUnitInstance(SEA_MONKEY);
      const broke = { ...base };
      broke.players[0]!.hand = [monkey];
      // Exactly the unit's cost and not one Energy more.
      broke.players[0]!.channeled = runes("Body", monkey.energyCost);

      const stopped = resolveChain(accept(broke, playsOf(broke, monkey.instanceId)[0]!));
      expect(stopped.pendingDecisions.filter((d) => d.kind === "UNL-109-pay")).toHaveLength(0);

      const { state: rich } = armed();
      const { state: withSpare, unitId } = withUnitInHand(rich);
      const asked = resolveChain(accept(withSpare, playsOf(withSpare, unitId)[0]!));
      expect(
        asked.pendingDecisions.filter((d) => d.kind === "UNL-109-pay"),
        "it never asks even with spare Energy — the zero above proves nothing",
      ).toHaveLength(1);
    });
  });

  describe("second clause — Spend 3 XP, [Exhaust]: Ready a unit", () => {
    const activationsOf = (state: GameState, instanceId: string) =>
      legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

    function withExhaustedUnit(xp: number) {
      const { state, gearId } = armed(xp);
      state.battlefields[0]!.units = { p1: [makeUnit({ name: "Tired", instanceId: "tired", exhausted: true })] };
      return { state, gearId };
    }

    it("is registered through the domain-file seam", () => {
      expect(activatedAbilityFor(BLOOD_ROSE), "the ability is invisible to the merged table").toBeDefined();
    });

    it("spends 3 XP, exhausts the gear and readies the chosen unit", () => {
      const { state, gearId } = withExhaustedUnit(3);
      const activation = activationsOf(state, gearId).find(
        (a) => (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === "tired",
      );
      expect(activation, "no variant naming the exhausted unit was offered").toBeDefined();

      const after = accept(state, activation!);

      expect(after.players[0]!.xp, "the XP was not spent").toBe(0);
      expect(unitAnywhere(after, "tired")!.exhausted, "the unit was not readied").toBe(false);
      expect(after.players[0]!.activeGear[0]!.exhausted, "the printed exhaust was not taken").toBe(true);
    });

    it("is NOT offered below 3 XP", () => {
      // `availableWhile` is where the price is asked, because a resolver that
      // refused would already have taken the exhaust. The affordable run sits in
      // the same test so a count of zero cannot pass for a check that never ran.
      for (const xp of [0, 1, 2] as const) {
        const { state, gearId } = withExhaustedUnit(xp);
        expect(activationsOf(state, gearId), `offered at ${xp} XP, which cannot pay 3`).toHaveLength(0);
      }
      const affordable = withExhaustedUnit(3);
      expect(
        activationsOf(affordable.state, affordable.gearId).length,
        "nothing was enumerated even at 3 XP — the zeroes above prove nothing",
      ).toBeGreaterThan(0);
    });

    it("cannot be activated twice in a turn, because the exhaust is printed", () => {
      // The mirror of Crowd Favorite, whose `cost: {}` is load-bearing the other
      // way. 6 XP could pay twice; the exhaust is what stops it.
      const { state, gearId } = withExhaustedUnit(6);
      const once = accept(
        state,
        activationsOf(state, gearId).find((a) => (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === "tired")!,
      );
      expect(once.players[0]!.xp).toBe(3);
      expect(activationsOf(once, gearId), "an exhausted gear was offered again").toHaveLength(0);
    });
  });
});

describe("Nidalee - Cat Form (UNL-114): when I win a combat, draw 1", () => {
  /** Nidalee at bf1 against a 1-Might defender she is certain to kill outright,
   *  plus an unrelated fight the opponent is winning at bf2. */
  function armed(): { state: GameState; nidaleeId: string } {
    const nidalee = realUnitInstance(NIDALEE_CAT_FORM);
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = filler(3);
    state.battlefields[0]!.units = {
      p1: [nidalee],
      p2: [makeUnit({ name: "Prey", instanceId: "prey", might: 1 })],
    };
    return { state, nidaleeId: nidalee.instanceId };
  }

  const fight = (state: GameState, battlefieldId: string, attackerIndex: 0 | 1) =>
    answerDecisions(resolveHeldTriggers(resolveShowdown(state, battlefieldId, attackerIndex)));

  it("draws 1 when her controller is the only side left standing (466.3.a)", () => {
    const { state } = armed();
    const after = fight(state, "bf1", 0);

    expect(unitsAt(after, "bf1", "p2"), "the fixture did not actually win the combat").toHaveLength(0);
    expect(after.players[0]!.hand, "the draw never fired").toHaveLength(1);
    expect(after.players[0]!.deck).toHaveLength(2);
  });

  it("draws NOTHING for a combat HER OWN SIDE won at another battlefield", () => {
    // "When **I** win" is positional (466.3.c hands the result down to the units
    // AT this battlefield), and **her CONTROLLER has to be the winner for that
    // check to be exercised at all**. The first version of this test had the
    // OPPONENT winning at bf2, so `winnerIndex === listener.ownerIndex` already
    // short-circuited and the positional half was never asked — measured by
    // mutation: deleting `listener.battlefieldId === event.battlefieldId` left
    // all 24 tests green. This fixture wins bf2 with a DIFFERENT friendly unit,
    // which is the only shape that can tell the two conditions apart.
    const { state } = armed();
    state.battlefields[1]!.units = {
      p1: [makeUnit({ name: "Bruiser", instanceId: "bruiser", might: 9 })],
      p2: [makeUnit({ name: "Chaff", instanceId: "chaff", might: 1 })],
    };

    const after = fight(state, "bf2", 0);

    expect(unitsAt(after, "bf2", "p2"), "her own side did not win at bf2 — this run proves nothing").toHaveLength(0);
    expect(unitAnywhere(after, "bruiser"), "the winner died, so nobody won bf2").toBeDefined();
    expect(after.players[0]!.hand, "she drew off a fight she was not standing in").toHaveLength(0);
  });

  it("draws NOTHING when nobody wins — 466.3.d's No Result", () => {
    // Both sides survive, so 466.3.d makes it No Result and `combatWon` never
    // fires. This is where her printed reminder ("I win if I remain after
    // combat") and the RULE come apart, and the rule is what is implemented.
    const { state } = armed();
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p2: [makeUnit({ name: "Tank", instanceId: "tank", might: 40 })],
    };

    const after = fight(state, "bf1", 0);

    expect(unitAnywhere(after, "tank"), "the enemy did not survive — this is not a No Result").toBeDefined();
    expect(after.players[0]!.hand, "she drew on a No Result").toHaveLength(0);
  });
});

describe("Nilah - Joyful Ascetic (UNL-115): when I move, gain 1 XP", () => {
  function armed(): { state: GameState; nilahId: string } {
    const nilah = realUnitInstance(NILAH_JOYFUL_ASCETIC);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [nilah, makeUnit({ name: "Bystander", instanceId: "bystander" })];
    // **Both battlefields are already this player's**, and that is fixture
    // plumbing rather than part of the card: walking into a battlefield you do
    // not control applies Contested and stages a Non-Combat Showdown, and the
    // turn sits in `turnState: "Showdown"` with no MoveUnit offered at all — so
    // the second-move test measured nothing until this landed. Measured, not
    // guessed: `legalActions` returned zero moves of any kind.
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.controllerId = "p1";
    return { state, nilahId: nilah.instanceId };
  }

  const moveOf = (state: GameState, unitInstanceId: string, to: string) =>
    legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds.length === 1 && a.unitInstanceIds[0] === unitInstanceId && a.destinationBattlefieldId === to,
    );

  it("gains 1 XP on a real MoveUnit action", () => {
    const { state, nilahId } = armed();
    const move = moveOf(state, nilahId, "bf1");
    expect(move, "Nilah was never offered a move").toBeDefined();

    const after = resolveHeldTriggers(accept(state, move!));

    expect(after.players[0]!.xp, "the XP never landed").toBe(1);
  });

  it("gains again on a SECOND move, which is what [Ganking] is for", () => {
    const { state, nilahId } = armed();
    const first = resolveHeldTriggers(accept(state, moveOf(state, nilahId, "bf1")!));
    expect(first.players[0]!.xp).toBe(1);

    // She is exhausted by the first move (144.2), so ready her the way an
    // Awakening would before asking for the second.
    const readied = {
      ...first,
      battlefields: first.battlefields.map((bf) => ({
        ...bf,
        units: Object.fromEntries(
          Object.entries(bf.units).map(([id, us]) => [id, us.map((u) => ({ ...u, exhausted: false }))]),
        ),
      })),
    };
    const second = moveOf(readied, nilahId, "bf2");
    expect(second, "[Ganking] did not let her move battlefield to battlefield").toBeDefined();

    expect(resolveHeldTriggers(accept(readied, second!)).players[0]!.xp).toBe(2);
  });

  it("gains NOTHING when a different unit moves", () => {
    // "When **I** move" — identity by instanceId. Positive control in the same
    // test: moving Nilah from the same fixture does pay.
    const { state, nilahId } = armed();

    const other = resolveHeldTriggers(accept(state, moveOf(state, "bystander", "bf1")!));
    expect(other.players[0]!.xp, "someone else's move paid her").toBe(0);

    const hers = resolveHeldTriggers(accept(state, moveOf(state, nilahId, "bf1")!));
    expect(hers.players[0]!.xp, "her own move paid nothing — the zero above proves nothing").toBe(1);
  });
});

describe("the four Body clauses this wave REFUSED", () => {
  it("Wily Newtfish gains its +1 Might once XP was gained THIS TURN", () => {
    // **This was a pin, and it named the missing mechanism precisely enough to
    // build.** It recorded that "if you've gained XP this turn" was unanswerable:
    // `gainXp` wrote only the running total, and 5 unchanged all turn is a
    // different fact from 5 after gaining 2 and spending 2. It asked for
    // `discardedThisTurn`'s shape, and that is exactly what was built —
    // `PlayerState.xpGainedThisTurn`, set in `gainXp` (the single writer) and
    // cleared in `runEnd`.
    //
    // Now asserts both edges, because a flag that is never cleared would pass the
    // positive half forever.
    const newt = realUnitInstance(WILY_NEWTFISH);
    const base = makeState({ phase: "Action" });
    base.battlefields[0]!.units = { p1: [newt] };
    const printed = newt.might;

    // Holding XP is NOT gaining it this turn — the distinction the flag exists for.
    const holding = { ...base, players: [{ ...base.players[0]!, xp: 9 }, base.players[1]!] } as typeof base;
    expect(
      effectiveMight(holding, newt, 0, { isCombat: false, battlefieldId: "bf1" }),
      "a standing XP total paid the bonus — the flag is reading `xp`, not the gain",
    ).toBe(printed);

    const gained = gainXp(base, 0, 3);
    expect(
      effectiveMight(gained, newt, 0, { isCombat: false, battlefieldId: "bf1" }),
      "gaining XP this turn did not pay the +1",
    ).toBe(printed + 1);
    expect(implementingModule(WILY_NEWTFISH), "nothing claims the card").toBeDefined();
  });

  it("the four conditional keywords are OFF below their condition — the defect this wave found", () => {
    // **Found by this wave rather than by reading the cards, and it is the
    // opposite failure from an unimplemented clause: these keywords are ALWAYS
    // ON.** `card-loader`'s `KW_PATTERN` sees only brackets, so a keyword printed
    // inside a condition parses as a flat printed keyword —
    // `CONDITIONAL_KEYWORD_DEF_IDS` is the named set that strips exactly this, and
    // it holds four OGN cards and NO UNL card.
    //
    //   UNL-108 Wily Newtfish   — "If you've gained XP this turn, I have ... [Ganking]"
    //   UNL-113 Master Yi - Tempered — "[Level 6][>] I have [Deflect] and [Ganking]"
    //   UNL-047 Mosstomper      — "[Level 3][>] I have +1 Might and [Deflect]"
    //   UNL-075 Gustwalker      — "[Level 3][>] I have +1 Might and [Ganking]"
    //
    // Measured across the whole loaded UNL pool, not sampled: those four are all
    // of them. The fix is four defIds in `CONDITIONAL_KEYWORD_DEF_IDS`
    // (cards/card-loader.ts) plus a `CONDITIONAL_GRANTS` entry each in
    // granted-keywords.ts — both SHARED files, so this wave could not write it.
    //
    // Asserted AT ZERO XP, which is where the bug is visible: every one of these
    // is below its own threshold and should have nothing.
    const state = makeState({ phase: "Action" });
    expect(state.players[0]!.xp, "the fixture is not below the thresholds").toBe(0);

    const at0 = (defId: string) => {
      const unit = realUnitInstance(defId);
      const board = { ...state, battlefields: state.battlefields.map((bf) => ({ ...bf })) };
      board.battlefields[0]!.units = { p1: [unit] };
      return effectiveKeywords(board, unit, 0);
    };

    // Master Yi first, because his `[Hunt 2]` is the positive control: it proves
    // the keyword read is working at all, so the wrong answers below are the
    // card's and not a broken lookup.
    // Master Yi first, because his `[Hunt 2]` is the positive control: it proves
    // the keyword read works at all, so the answers below are the cards' and not
    // a broken lookup. It is ALSO the thing the naive fix would have destroyed —
    // `CONDITIONAL_KEYWORD_DEF_IDS` returns `{}` and would have taken it.
    const yi = at0(MASTER_YI_TEMPERED);
    expect(yi["Hunt"], "his [Hunt 2] stopped parsing — every assertion here would be meaningless").toBe(2);
    expect(yi["Deflect"], "[Deflect] is live below [Level 6] again").toBeUndefined();
    expect(yi["Ganking"], "[Ganking] is live below [Level 6] again").toBeUndefined();

    // The other two are not Body's cards, but the fix was one shared pair of
    // tables, so they stay asserted here — three agents pinned this defect
    // independently and one place to check it is worth more than three.
    expect(at0("UNL-047")["Deflect"], "Mosstomper's [Deflect] is live below [Level 3] again").toBeUndefined();
    expect(at0("UNL-075")["Ganking"], "Gustwalker's [Ganking] is live below [Level 3] again").toBeUndefined();
    expect(at0("UNL-047")["Hunt"], "Mosstomper lost his printed [Hunt 2] to the strip").toBe(2);

    // **Wily Newtfish is still a pin, and the only one left.** Its condition is
    // "if you've gained XP this turn" and nothing records that, so it was
    // stripped WITHOUT a runtime re-grant — inert rather than always-on. Weaker
    // than printed is the safer error, and the card already reports unimplemented
    // for the same missing counter, so this agrees with coverage rather than
    // hiding a second gap. Adding `xpGainedThisTurn` flips it.
    expect(at0(WILY_NEWTFISH)["Ganking"], "a re-grant landed — give it a CONDITIONAL_GRANTS entry and flip this").toBeUndefined();
  });

  it("reports each card's coverage as it actually stands", () => {
    // The measurement that matters more than the pins: a card that reports DONE
    // while doing nothing is the failure this repo keeps finding. So this asserts
    // what is TRUE today, and every line that is wrong is named as wrong.
    // **Wily Newtfish now reports FINISHED, and that is correct.** Both halves
    // landed once `PlayerState.xpGainedThisTurn` was built: the +1 Might through
    // the `mightModifiers` seam and the [Ganking] through `CONDITIONAL_GRANTS` —
    // one printed sentence across two files, reading the same flag.
    expect(isCardImplemented(registry.get(WILY_NEWTFISH)), "a half went missing — check both files read xpGainedThisTurn").toBe(true);
    // **Master Yi reports FINISHED as of 2026-08-10, and this assertion was
    // WRONG rather than stale.** It said "no module registers him", and that was
    // true of the CLAIM LIST but not of the code: his `[Level 6]` grant had been a
    // `CONDITIONAL_GRANTS` row since 2026-08-09 and worked in every game.
    // `grantedKeywordDefIds()` hand-listed four constants instead of reading that
    // table, so he was written, working, and invisible — and because
    // `deck-generator` seats on `isCardImplemented`, unreachable in play and
    // unseeable by `reachability`, the instrument built for exactly this.
    //
    // Found by a wave-6 re-audit agent that was told to distrust the refusal note
    // rather than inherit it. The fix is one spread.
    expect(isCardImplemented(registry.get(MASTER_YI_TEMPERED)), "Master Yi went back to unclaimed").toBe(true);
    expect(
      partialImplementationNote(registry.get(MASTER_YI_TEMPERED)),
      "he now reports PARTIAL — something registered him; check the entry says the right thing",
    ).toBeUndefined();
    // Nidalee's `[Ambush]` is an unimplemented KEYWORD, so she is flagged for
    // free — her draw clause is written and hers is a genuine partial.
    // Nidalee was greyed by `[Ambush]` alone; the keyword landed 2026-08-09 and
    // she is whole, with no partial note left to match.
    expect(isCardImplemented(registry.get(NIDALEE_CAT_FORM))).toBe(true);
    expect(partialImplementationNote(registry.get(NIDALEE_CAT_FORM))).toBeUndefined();
    // Nilah's two keywords are both implemented and her one sentence is written,
    // so she is whole. Stare Down and Blood Rose likewise.
    expect(isCardImplemented(registry.get(NILAH_JOYFUL_ASCETIC)), "Nilah is not being counted").toBe(true);
    expect(partialImplementationNote(registry.get(NILAH_JOYFUL_ASCETIC))).toBeUndefined();
    expect(isCardImplemented(registry.get(STARE_DOWN))).toBe(true);
    expect(isCardImplemented(registry.get(BLOOD_ROSE))).toBe(true);
  });
});
