import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { createToken, SHADOW_CLONE_TOKEN } from "../src/engine/token.js";
import { SHADOW_CLONE_TOKEN_DEF_ID } from "../src/engine/constants.js";
import { eventTriggerDefIds } from "../src/engine/triggers.js";
import { optionsFor } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { answerDecisions, beginCombatAt, makeState, makeUnit, playUnitTrigger, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's Fury remainder** — the three cards wave 1 deferred, and the token
 * subsystem two of them needed.
 *
 * Combat is read through DEATHS throughout, never through marked damage: rule
 * 466 step 3c heals every unit at the end of combat, so `damage` after
 * `resolveShowdown` is always 0. That trap has now caught two waves of this work.
 */

const registry = defaultCardRegistry();

const DUNE_SURFER = "VEN-004";
const ZED = "VEN-023";
const ZED_OVERNUMBERED = "VEN-169";
const SHADOW_CLONE_BANISH_KIND = `${SHADOW_CLONE_TOKEN_DEF_ID}-banish`;

function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Everything HELD or already on the chain, by the defId of whatever placed it.
 *
 * The instrument that separates "the ability resolved to nothing" from "the
 * ability was never placed" — and, for a decline-only offer, the ONLY one that
 * can see the difference: `advanceDecisions` executes a question with a single
 * answer silently, so `pendingDecisions` is empty by the time a caller looks.
 * That is the vacuous-pin shape Dancing Grenade's test records.
 */
const heldDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : e.card.defId)),
];

/** Every unit `p0` has, wherever it stands — for finding a token by tag. */
const ownUnits = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.battlefields.flatMap((bf) => bf.units.p1 ?? []),
];

describe("Dune Surfer (VEN-004): you ignore [Tank] while assigning combat damage here", () => {
  /**
   * The attacker has ONE 3-Might body and the defender has a 2-Might bystander
   * behind a 10-Might `[Tank]`.
   *
   * Without the ignore, `assignmentOrder` puts the Tank first and the whole
   * 3-damage pool lands on it — nobody dies. With the ignore the pool goes in
   * board order, kills the bystander with 2 and spills 1. So "did the bystander
   * die" is the ONE observable, and it is a death rather than marked damage.
   */
  function fight(attacker: UnitInstance): GameState {
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [attacker],
      p2: [makeUnit({ instanceId: "bystander", might: 2 }), makeUnit({ instanceId: "wall", might: 10, keywords: { Tank: 1 } })],
    };
    state.battlefields[0]!.contestedByIndex = 0;
    return resolveShowdown(state, "bf1", 0);
  }

  const bystanderDied = (state: GameState) => onBoard(state, "bystander") === undefined;

  it("lets his controller hit past an enemy [Tank]", () => {
    expect(bystanderDied(fight(realUnitInstance(DUNE_SURFER))), "the Tank still soaked it").toBe(true);
  });

  it("NEGATIVE CONTROL: an ordinary 3-Might attacker cannot", () => {
    // The same board with the same pool. Without this the test above would pass
    // against an engine that never ordered Tanks first at all.
    expect(bystanderDied(fight(makeUnit({ instanceId: "plain", might: 3 }))), "[Tank] is not being honoured").toBe(false);
  });

  it("the ignore is the ASSIGNER's, not the Tank owner's", () => {
    // He is on the DEFENDING side here, so his controller is not the one
    // assigning into the Tank — and the Tank's owner does not get to ignore their
    // own. A version keyed off the units' owner rather than the assigner would
    // pass the first test and fail this one.
    const surfer = realUnitInstance(DUNE_SURFER);
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "bystander", might: 2 }), makeUnit({ instanceId: "wall", might: 10, keywords: { Tank: 1 } }), surfer],
      p2: [makeUnit({ instanceId: "raider", might: 3 })],
    };
    state.battlefields[0]!.contestedByIndex = 1;

    const after = resolveShowdown(state, "bf1", 1);

    expect(onBoard(after, "bystander"), "the enemy hit past a Tank using HIS ignore").toBeDefined();
  });

  it("does not reach ANOTHER battlefield — 'here'", () => {
    const surfer = realUnitInstance(DUNE_SURFER);
    const state = makeState();
    // The Surfer stands at bf2; the fight is at bf1.
    state.battlefields[1]!.units = { p1: [surfer] };
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "plain", might: 3 })],
      p2: [makeUnit({ instanceId: "bystander", might: 2 }), makeUnit({ instanceId: "wall", might: 10, keywords: { Tank: 1 } })],
    };
    state.battlefields[0]!.contestedByIndex = 0;

    const after = resolveShowdown(state, "bf1", 0);

    expect(onBoard(after, "bystander"), "his ignore reached a fight he is not in").toBeDefined();
  });

  it("still PRINTS [Tank] himself — enemies must assign to him first", () => {
    // The card's own symmetry, and the reason nothing in the implementation
    // excludes him: he is never among the units his own side is assigning to.
    expect(registry.get(DUNE_SURFER).type).toBe("Unit");
    const printed = registry.get(DUNE_SURFER) as Extract<ReturnType<typeof registry.get>, { type: "Unit" }>;
    expect(printed.keywords?.Tank, "his printed [Tank] was stripped").toBeDefined();
  });
});

describe("Zed, From the Shadows (VEN-023): a Shadow Clone if you paid", () => {
  function board(): GameState {
    const state = makeState();
    state.players[0]!.hand = [spellInstance("VEN-003")];
    return state;
  }

  const clones = (state: GameState) => ownUnits(state).filter((u) => u.defId === SHADOW_CLONE_TOKEN_DEF_ID);

  it("plays a Shadow Clone when the discard was paid", () => {
    const state = board();
    const discard = state.players[0]!.hand[0]!;

    const after = playUnitTrigger(state, realUnitInstance(ZED), 0, "base", {
      discardCardInstanceId: discard.instanceId,
    });

    expect(clones(after).length, "no Shadow Clone was created").toBe(1);
    expect(clones(after)[0]!.might, "the token is not 0 Might").toBe(0);
    expect(clones(after)[0]!.tags, "the token is not tagged Shadow Clone").toContain("Shadow Clone");
  });

  it("...and the discard really happens", () => {
    const state = board();
    const discard = state.players[0]!.hand[0]!;

    const after = playUnitTrigger(state, realUnitInstance(ZED), 0, "base", {
      discardCardInstanceId: discard.instanceId,
    });

    expect(after.players[0]!.hand, "the cost was never taken").toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(discard.instanceId);
  });

  it("makes NOTHING when the cost was declined", () => {
    const after = playUnitTrigger(board(), realUnitInstance(ZED), 0, "base", {});

    expect(clones(after), "a Clone arrived without paying").toEqual([]);
    expect(after.players[0]!.hand.length, "it discarded anyway").toBe(1);
  });

  it("his (Overnumbered) print does the same thing, through the alias", () => {
    // VEN-169 has no registration of its own — `printingAliases` redirects the
    // lookup. That is what makes this worth asserting: the print would otherwise
    // be a 4-Might body with no ability, which is the "12 of 31 printings were
    // INERT" bug this pool has already had once.
    const state = board();
    const discard = state.players[0]!.hand[0]!;

    const after = playUnitTrigger(state, realUnitInstance(ZED_OVERNUMBERED), 0, "base", {
      discardCardInstanceId: discard.instanceId,
    });

    expect(clones(after).length, "the Overnumbered print is inert").toBe(1);
  });
});

describe("the Shadow Clone token's printed ability", () => {
  /** A Clone at a battlefield with an enemy, so a real Showdown hands out the
   *  designations its `applies` reads. */
  function board(trash: UnitInstance[]): { state: GameState; clone: UnitInstance } {
    const clone = createToken(SHADOW_CLONE_TOKEN);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [clone], p2: [makeUnit({ instanceId: "blocker", might: 9 })] };
    state.players[0]!.trash = trash;
    return { state, clone };
  }

  /**
   * Was the ability PLACED when this board attacked?
   *
   * Read off the holding pen rather than off `pendingDecisions`, and that is the
   * whole reason it exists: with nothing to banish the offer collapses to a lone
   * Decline, and `advanceDecisions` executes a single-answer question SILENTLY —
   * so the queue is empty either way and an assertion on it is vacuous. Measured:
   * a mutant that dropped the trash check from `applies` survived exactly that
   * assertion.
   */
  const placedOnAttack = (state: GameState): boolean =>
    // **Read after the CLEANUP, not after the settle.** `beginCombatAt` runs the
    // Cleanup and then passes Focus until the chain empties — by which point a
    // trigger that parks a question has already left the pen. `runCleanup` alone
    // is the moment the Showdown is staged and the triggers are held, which is
    // exactly the moment `applies` decided.
    heldDefIds(runCleanup({ ...state, battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, contestedByIndex: 0 } : bf)) })).includes(
      SHADOW_CLONE_TOKEN_DEF_ID,
    );

  it("is registered against the TOKEN's runtime defId", () => {
    // A table keyed to an id nothing creates is silent and reads exactly like an
    // implemented ability — the failure `GOLD_TOKEN_DEF_ID`'s note records, which
    // registered the Gold token's ability under the key `undefined`.
    expect(SHADOW_CLONE_TOKEN_DEF_ID, "the derived id is not what createToken stamps").toBe(
      createToken(SHADOW_CLONE_TOKEN).defId,
    );
    expect(eventTriggerDefIds(), "the token's ability is not in the merged registry").toContain(SHADOW_CLONE_TOKEN_DEF_ID);
  });

  it("offers to banish a unit from the trash when it attacks, and pays [Assault 4]", () => {
    const victim = makeUnit({ instanceId: "corpse" });
    const { state, clone } = board([victim]);

    const held = beginCombatAt(state, "bf1", 0);
    expect(held.pendingDecisions.map((d) => d.kind), "nothing was offered on attack").toContain(SHADOW_CLONE_BANISH_KIND);

    const after = answerDecisions(held, (options) => options.find((o) => o.instanceId === victim.instanceId)!.id);

    expect(effectiveKeywords(after, onBoard(after, clone.instanceId)!, 0).Assault, "the grant was 1, the default").toBe(4);
    expect(after.players[0]!.banished.map((c) => c.instanceId), "the unit was not banished").toContain(victim.instanceId);
    expect(after.players[0]!.trash, "it stayed in the trash as well").toEqual([]);
  });

  it("declining costs nothing and grants nothing", () => {
    const victim = makeUnit({ instanceId: "corpse" });
    const { state, clone } = board([victim]);

    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => options[0]!.id);

    expect(effectiveKeywords(after, onBoard(after, clone.instanceId)!, 0).Assault ?? 0).toBe(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId), "declining banished it anyway").toContain(victim.instanceId);
  });

  it("offers only UNITS from the trash, never a spell beside them", () => {
    // **`applies` and the OPTION LIST are two different filters**, and the test
    // below only reaches the first. With a unit present the question IS parked,
    // so a loosened option list would quietly let a player banish a Spell — a
    // cost the card does not print. Measured: a mutant that dropped the `kind`
    // filter from the options survived every other assertion in this block.
    const corpse = makeUnit({ instanceId: "corpse" });
    const spell = spellInstance("VEN-003");
    const { state } = board([corpse, spell as unknown as UnitInstance]);

    const held = beginCombatAt(state, "bf1", 0);
    const decision = held.pendingDecisions.find((d) => d.kind === SHADOW_CLONE_BANISH_KIND);
    expect(decision, "nothing was parked — this test measures nothing").toBeDefined();

    const offered = optionsFor(held, decision!).map((o) => o.instanceId);
    expect(offered, "the unit was not offered").toContain(corpse.instanceId);
    expect(offered, "a SPELL was offered as banish fodder").not.toContain(spell.instanceId);
  });

  it("is not asked at all with no UNIT in the trash", () => {
    // A trash of spells pays nothing — the card says "a unit". Asserted through
    // the absence of a Pending Item rather than of a grant, because a held
    // trigger that resolves to nothing still costs both players a PassFocus.
    const { state } = board([spellInstance("VEN-003") as unknown as UnitInstance]);

    expect(placedOnAttack(state), "it was placed for a trash of spells").toBe(false);
  });

  it("...nor with an EMPTY trash", () => {
    const { state } = board([]);
    expect(placedOnAttack(state), "it was placed with nothing to banish").toBe(false);
  });

  it("...and the positive control on that instrument", () => {
    // Without this pair the two assertions above would pass against an ability
    // that is never placed at all.
    const { state } = board([makeUnit({ instanceId: "corpse" })]);
    expect(placedOnAttack(state)).toBe(true);
  });

  it("NEGATIVE CONTROL: nothing is offered when the Clone DEFENDS", () => {
    // "When I ATTACK". POSITIVE CONTROL on the same fixture first, so a silent
    // board cannot pass this.
    const attacking = board([makeUnit({ instanceId: "corpse" })]);
    expect(beginCombatAt(attacking.state, "bf1", 0).pendingDecisions.map((d) => d.kind)).toContain(SHADOW_CLONE_BANISH_KIND);

    const defending = board([makeUnit({ instanceId: "corpse" })]);
    expect(
      beginCombatAt(defending.state, "bf1", 1).pendingDecisions.map((d) => d.kind),
      "it was offered as a DEFENDER",
    ).not.toContain(SHADOW_CLONE_BANISH_KIND);
  });
});

describe("coverage sees the wave", () => {
  it("Dune Surfer and both Zed printings report implemented", () => {
    for (const id of [DUNE_SURFER, ZED, ZED_OVERNUMBERED]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });

  it("Endless Riches (VEN-022) was the wave's refusal, and it was ANSWERED", () => {
    // Four continuous clauses on one gear, and only the first is card work:
    // "banish your hand and trash, then [Burn 7]" is an on-play effect the pieces
    // already exist for. The other three are each an engine seam:
    //
    //   "Skip your Draw Phase"           — `turn-manager.runDraw`
    //   "You may play cards from trash"  — a THIRD trash permission: continuous,
    //                                      board-derived, every card kind, at the
    //                                      PRINTED price. Neither Last Rites'
    //                                      spent charge (Units only) nor a
    //                                      card's own replaced cost is it.
    //   "If a card would go to your trash from anywhere other than your Main
    //    Deck, banish it instead" — a replacement on TRASHING, which nothing in
    //    this engine currently replaces; the trash is written from ~15 sites.
    //
    // Left as its own change rather than smuggled into a card wave, and written
    // as its own commit on 2026-08-18 — see `test/ven-endless-riches.test.ts`.
    //
    // **The analysis above was right about the shape and wrong about one number**:
    // it said the trash is written from "~15 sites". Measured, it is NINE, and
    // seven of those had to change — the rest of the `trash:` writes in `src/` are
    // REMOVALS. That is worth leaving in place rather than correcting silently,
    // because the estimate is what made this look like a refactor when it was a
    // funnel: `effect-helpers.fileIntoTrash` now owns the resting step and every
    // caller names the zone the card came from.
    //
    // Inverted rather than deleted: the premise moved, so the premise is what
    // changes.
    expect(
      isCardImplemented(registry.get("VEN-022")),
      "Endless Riches reports unimplemented again — it is a whole commit, so this is a regression",
    ).toBe(true);
    expect(registry.get("VEN-022").text ?? "").toContain("Skip your Draw Phase");
  });
});
