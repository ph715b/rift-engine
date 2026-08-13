import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { implementingModules, isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import type { MoveUnitAction, PlayCardAction, RecallUnitAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Wave 6's Body cards — the five wave 4 refused, re-audited against the code as
 * it stands rather than against the refusal note.
 *
 * One of the five was FINISHED and nobody noticed: **Master Yi - Tempered
 * (UNL-113)**. His `[Level 6]` grant landed in `granted-keywords.CONDITIONAL_GRANTS`
 * on 2026-08-09 and `[Hunt]` is the keyword machinery's, so the refusal note was
 * stale by three days. The tests below are not a re-registration — they are the
 * missing REAL-PATH controls: `granted-keywords.test.ts` proves `hasKeyword` answers
 * yes at 6 XP, which is a different claim from "the move enumerator offers the move
 * and `submit` takes it" and from "the opponent is actually charged the rainbow".
 * Both of those have gone wrong here with the keyword table perfectly correct.
 *
 * And he STILL reports unimplemented, which is a live gap of its own — see his pin
 * below. He is the one card in the pool where a hand-copied claim list in
 * `grantedKeywordDefIds()` is visible, and `deck-generator` seats on
 * `isCardImplemented`, so a working champion cannot appear in a generated deck.
 *
 * The other four are still blocked, each on a SHARED file this wave does not own,
 * and each is PINNED here asserting the wrong answer — so closing one fails loudly
 * instead of silently changing behaviour nobody is watching. Rengar - Trophy Hunter
 * (UNL-120) already has its pin in unl-body-wave4.test.ts and is not repeated.
 *
 * Every pin carries a POSITIVE CONTROL off the same fixture, proving the gap is
 * where it is claimed and not somewhere earlier: a card that is unaffordable, a
 * battlefield that is unreachable or an action that is never enumerated all look
 * exactly like a correctly-closed door. **One of those controls was vacuous and was
 * caught by mutation** — see `quarryDamage` in the Repulse block.
 */

const registry = defaultCardRegistry();

const MASTER_YI_TEMPERED = "UNL-113"; // [Hunt 2], [Level 6] -> [Deflect] + [Ganking]
const REPULSE = "UNL-106"; // Body 1/1 [Reaction] counter
const DETERMINED_SENTRY = "UNL-111"; // Body 1/0, "I can't move to base"
const ARACHNOID_HORROR = "UNL-117"; // Body 6/1, the lone-enemy placement grant
const DEADBLOOM_PREDATOR = "OGN-161"; // Body 8/2 — the WORKING occupied-enemy grant
const NOT_SO_FAST = "SFD-045"; // Calm 2/1 — the WORKING "counter an enemy spell that chooses a friendly permanent"
const HEXTECH_RAY = "OGN-009"; // Fury 1/1 — "deal 3 to a unit at a battlefield"
const MINOTAUR_RECKONER = "SFD-014"; // the WORKING "units can't move to base"
const FIORA_VICTORIOUS = "OGN-232"; // a CONDITIONAL_GRANTS row that IS claimed by coverage

const MASTER_YI_LEVEL = 6;

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Every destination the enumerator will send this card to — `undefined` is base. */
const destinationsFor = (state: GameState, instanceId: string): (string | undefined)[] =>
  playsOf(state, instanceId).map((p) => p.destinationBattlefieldId);

const movesOf = (state: GameState, instanceId: string): MoveUnitAction[] =>
  legalActions(state).filter(
    (a): a is MoveUnitAction => a.type === "MoveUnit" && a.unitInstanceIds.includes(instanceId),
  );

const recallsOf = (state: GameState, instanceId: string): RecallUnitAction[] =>
  legalActions(state).filter(
    (a): a is RecallUnitAction => a.type === "RecallUnit" && a.unitInstanceIds.includes(instanceId),
  );

const unitAnywhere = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

describe("Master Yi - Tempered (UNL-113): the [Level 6] grant, driven through the real paths", () => {
  /** Yi standing ready at bf1 with `xp` banked, on his controller's own turn. */
  function levelled(xp: number): { state: GameState; yiId: string } {
    const yi = realUnitInstance(MASTER_YI_TEMPERED);
    const state = makeState({ phase: "Action" });
    state.players[0]!.xp = xp;
    state.battlefields[0]!.units = { p1: [yi] };
    return { state, yiId: yi.instanceId };
  }

  it("824.1.d: [Ganking] arrives at 6 XP and the MOVE really happens", () => {
    // The claim `granted-keywords.test.ts` cannot make: a keyword table that
    // answers correctly is not yet a keyword the move enumerator and
    // `validateMoveUnit` both consult. Battlefield-to-battlefield is the only
    // move [Ganking] unlocks, so bf1 -> bf2 is the whole test.
    const { state, yiId } = levelled(MASTER_YI_LEVEL);
    const offered = movesOf(state, yiId).filter((m) => m.destinationBattlefieldId === "bf2");
    expect(offered, "the enumerator never offered the Ganking move").toHaveLength(1);

    const after = accept(state, offered[0]!);
    expect(
      (after.battlefields[1]!.units["p1"] ?? []).map((u) => u.instanceId),
      "he was offered the move and did not arrive",
    ).toEqual([yiId]);
  });

  it("and is gone again at 5 XP — the ability goes Inactive, it does not latch", () => {
    // 824.1.d makes the ability Inactive "as soon as the controlling player has
    // less than [N] XP". One below the threshold is the whole difference from the
    // fixture above.
    const { state, yiId } = levelled(MASTER_YI_LEVEL - 1);
    expect(movesOf(state, yiId), "he moved battlefield-to-battlefield under the threshold").toHaveLength(0);

    // The validator is asked directly as well: the enumerator staying silent and
    // the validator refusing are two separate gates, and this codebase's recurring
    // bug is exactly the two disagreeing.
    const { result } = submit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [yiId],
      destinationBattlefieldId: "bf2",
    } as never);
    expect(result, "the validator allowed the move the enumerator withheld").not.toMatchObject({ type: "Ok" });
  });

  it("[Deflect] arrives with it — the OPPONENT is charged a rainbow to choose him", () => {
    /**
     * Priced through `legalActions`, not through `deflectSurcharge`: the surcharge
     * function has always been right, and the thing that has broken here is the
     * PLAY carrying it. A second, undefended unit stands at the same battlefield
     * off the same enumeration, so the taxed and untaxed variants are compared
     * inside one call rather than across two fixtures.
     */
    function priced(xp: number): { taxed: PlayCardAction | undefined; plain: PlayCardAction | undefined } {
      const yi = realUnitInstance(MASTER_YI_TEMPERED);
      const state = makeState({ phase: "Action", activePlayerIndex: 1 });
      state.players[0]!.xp = xp;
      state.battlefields[0]!.units = { p1: [yi, makeUnit({ instanceId: "bystander" })] };
      const ray = spellInstance(HEXTECH_RAY);
      state.players[1]!.hand = [ray];
      state.players[1]!.channeled = runes("Fury", 6);

      const plays = playsOf(state, ray.instanceId);
      return {
        taxed: plays.find((p) => p.targetUnitInstanceId === yi.instanceId),
        plain: plays.find((p) => p.targetUnitInstanceId === "bystander"),
      };
    }

    const on = priced(MASTER_YI_LEVEL);
    expect(on.taxed, "no play named Yi at all — the fixture measures nothing").toBeDefined();
    expect(on.plain, "no play named the bystander — the fixture measures nothing").toBeDefined();
    expect(on.taxed!.payment.rainbowRunes ?? [], "choosing a levelled Yi cost no surcharge").toHaveLength(1);
    expect(on.plain!.payment.rainbowRunes ?? [], "the bystander was taxed too — this is not [Deflect]").toHaveLength(0);

    // Positive control, one number changed: under the threshold he is an ordinary
    // body and costs the same as the bystander.
    const off = priced(MASTER_YI_LEVEL - 1);
    expect(off.taxed!.payment.rainbowRunes ?? [], "he was taxed below his own [Level]").toHaveLength(0);
  });

  it("is CLAIMED by granted-keywords — was a pin, flipped at integration 2026-08-10", () => {
    /**
     * **PIN, and a live gap rather than a cosmetic one.** The three tests above
     * measure both his clauses firing through the real paths; this one measures
     * coverage saying they do not.
     *
     * The cause is `granted-keywords.grantedKeywordDefIds()`, which hand-lists four
     * constants (Sivir, Raging Soul, Bilgewater Bully, Fiora - Victorious) instead
     * of `Object.keys(CONDITIONAL_GRANTS)`. The four `[Level]`/XP rows added to that
     * table on 2026-08-09 were never added to the list. Three of them are claimed by
     * a SECOND registration — UNL-047, UNL-075 and UNL-108 each also carry a
     * `mightModifiers` entry — so Master Yi, whose grant is keywords only, is the
     * one card the omission is visible on.
     *
     * It is exactly the Lucian - Purifier trap that function's own doc comment
     * names: "if a card works and the count does not move, the module has not
     * claimed it". And it is not cosmetic — `deck-generator` seats cards on
     * `isCardImplemented`, so he cannot appear in a generated deck, which makes him
     * unreachable in play and invisible to `reachability`.
     *
     * **The fix landed the same day this pin was written**: `grantedKeywordDefIds()`
     * now spreads `Object.keys(CONDITIONAL_GRANTS)` instead of hand-listing four
     * constants, so the next row added to that table cannot repeat it.
     *
     * Inverted rather than deleted. The failure mode is silent in the direction
     * that matters — a card that WORKS and reports unimplemented is invisible to
     * every instrument, including the one built to catch unreachable cards — so
     * this asserts the claim exists rather than trusting that it always will.
     */
    expect(
      isCardImplemented(registry.get(MASTER_YI_TEMPERED)),
      "he reports unimplemented again — granted-keywords stopped claiming CONDITIONAL_GRANTS",
    ).toBe(true);
    expect(implementingModules(MASTER_YI_TEMPERED), "no module claims him").toContain("granted keywords");

    // The positive control that localises the gap to the CLAIM LIST rather than to
    // the table: Fiora - Victorious's grant is a row in the very same
    // `CONDITIONAL_GRANTS`, and she is claimed — because she is one of the four
    // hand-listed constants.
    expect(
      implementingModules(FIORA_VICTORIOUS),
      "granted-keywords claims nobody at all — the diagnosis above is wrong",
    ).toContain("granted keywords");
  });
});

describe("PIN — Determined Sentry (UNL-111) still walks home", () => {
  /**
   * **PIN.** "I can't move to base" is a PER-UNIT move restriction, and the engine
   * has only a per-BATTLEFIELD one: `battlefield-continuous.mayMoveToBaseFrom`,
   * whose four callers (validate-recall-unit, legal-actions' retreat fan-out,
   * `effect-helpers.forceMoveToBase` and `recallUnitToBase`) all pass a battlefield
   * id and no unit. Making that door unit-aware is a shared-file change this wave
   * does not own.
   *
   * 446.1 is why this is the right door at all: a permanent changing position from
   * one space on the Board to another is a MOVE, and a Base is a space (198.1). The
   * engine's `RecallUnitAction` is that move despite its name. 456.3 — "a Recall
   * cannot be prevented by actions and Game Effects that restrict or block
   * Movement" — is why combat's step-3d recall (466.1.a.2) must stay unaffected,
   * exactly as it already is for Vilemaw's Lair and Minotaur Reckoner.
   */
  function sentryAt(defenders: string[] = []): { state: GameState; sentryId: string } {
    const sentry = realUnitInstance(DETERMINED_SENTRY);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [sentry] };
    state.players[0]!.baseUnits = defenders.map((d) => realUnitInstance(d));
    return { state, sentryId: sentry.instanceId };
  }

  it("is offered NO retreat — his one printed line, honoured", () => {
    // **INVERTED on 2026-08-13.** This asserted the WRONG answer on purpose and
    // said so twice in its own messages; the per-unit gate landed and both fired.
    //
    // What was missing was narrow: every "can this unit go home" check went
    // through `mayMoveToBaseFrom`, which asks about the BOARD — a Minotaur
    // anywhere, or a battlefield that blocks it — and answers the same for every
    // unit. `unitMayMoveToBase` is the per-unit door beside it, and the four call
    // sites now come through it.
    const { state, sentryId } = sentryAt();
    expect(recallsOf(state, sentryId), "the Sentry is being offered a way home again").toHaveLength(0);
  });

  it("but Minotaur Reckoner's global version DOES close that same door", () => {
    // The positive control the pin above needs: without it, "no retreat offered"
    // and "retreat correctly withheld" are the same observation. SFD-014 is the
    // one implemented "units can't move to base" in the pool, and it is read at
    // the exact gate UNL-111 would need.
    const { state, sentryId } = sentryAt([MINOTAUR_RECKONER]);
    expect(recallsOf(state, sentryId), "the gate did not fire — the pin above proves nothing").toHaveLength(0);
  });
});

describe("PIN — Arachnoid Horror (UNL-117) cannot reach a lone enemy", () => {
  /**
   * **PIN.** Both of its sentences are play PERMISSIONS, which live at gates rather
   * than in a resolver: `unit-triggers.PLACEMENT_GRANTS` for "I can be played
   * to…" and `board-restrictions.ts` for the board-wide "friendly units can be
   * played to…" (Miss Fortune - Buccaneer's shape). Neither file is this wave's.
   *
   * **740.2.a settles what "alone" means, and it is not the naive reading**: "a
   * unit is alone when there are no OTHER FRIENDLY units at the same location". So
   * "an enemy unit is alone there" asks whether the OPPONENT has exactly one unit
   * at that battlefield, and says nothing about whether you have units there. That
   * makes the grant strictly NARROWER than Deadbloom Predator's `isOccupiedByEnemy`
   * (`>= 1`), not a synonym for it — which is why it needs its own grant kind
   * rather than the existing `"occupiedEnemyBattlefield"` row.
   */
  function horrorFixture(enemiesAtBf1: number): { state: GameState; horrorId: string; predatorId: string } {
    const horror = realUnitInstance(ARACHNOID_HORROR);
    const predator = realUnitInstance(DEADBLOOM_PREDATOR);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [horror, predator];
    state.players[0]!.floatingEnergy = 20;
    state.players[0]!.channeled = runes("Body", 8);
    state.battlefields[0]!.units = {
      p2: Array.from({ length: enemiesAtBf1 }, (_, i) => makeUnit({ instanceId: `enemy${i}` })),
    };
    return { state, horrorId: horror.instanceId, predatorId: predator.instanceId };
  }

  it("is refused a battlefield where one enemy stands alone — while Deadbloom Predator is not", () => {
    const { state, horrorId, predatorId } = horrorFixture(1);

    // The positive control comes first: he IS castable here, just only to base, so
    // an empty destination list would mean the fixture cannot afford him.
    const horrorDestinations = destinationsFor(state, horrorId);
    expect(horrorDestinations, "he is not playable at all — this pin measures nothing").toContain(undefined);
    expect(horrorDestinations, "the lone-enemy grant landed — delete this pin").not.toContain("bf1");

    // The second control: the SAME battlefield, the SAME hand, the SAME resources.
    // Deadbloom Predator's `"occupiedEnemyBattlefield"` row reaches it, so bf1 is a
    // destination the enumerator can produce and the refusal above is the grant's
    // absence rather than the board's.
    expect(
      destinationsFor(state, predatorId),
      "even the implemented occupied-enemy grant could not reach bf1 — the fixture is wrong",
    ).toContain("bf1");
  });

  it("and its second sentence grants nothing to other friendly units either", () => {
    // "Friendly units can be played to an occupied battlefield if an enemy unit is
    // alone there" — asserted with a Horror already ON THE BOARD, since the clause
    // is a continuous permission from a unit in play and not part of his entry.
    const { state } = horrorFixture(1);
    const sentry = realUnitInstance(DETERMINED_SENTRY);
    state.players[0]!.hand = [sentry];
    state.players[0]!.baseUnits = [realUnitInstance(ARACHNOID_HORROR)];

    expect(
      destinationsFor(state, sentry.instanceId),
      "a friendly unit reached the lone enemy — delete this pin",
    ).not.toContain("bf1");

    // Positive control: bf1 is reachable by an ordinary reinforce, so the refusal
    // above is about the permission and not about cost, timing or the battlefield.
    const reinforced = structuredClone(state);
    reinforced.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "beachhead" })];
    expect(
      destinationsFor(reinforced, sentry.instanceId),
      "bf1 is unreachable even with a friendly unit standing there — the fixture is wrong",
    ).toContain("bf1");
  });
});

describe("PIN — Repulse (UNL-106) counters nothing", () => {
  /**
   * **PIN.** "Choose a friendly unit at a battlefield. Counter an enemy spell or
   * ability that chooses it AND NO OTHER FRIENDLY UNIT" is a constraint BETWEEN its
   * two targets, and `TargetingSpec`'s `chainSpellAndUnit` (Riposte's) carries no
   * such field — nor even `enemyOnly`, which Riposte does not need. The pair filter
   * has to be applied by the enumerator and the validator together, which is
   * card-effects.ts + legal-actions.ts + validate-play-card.ts.
   *
   * Approximating it as Not So Fast's `{ kind: "chainSpell", enemyOnly,
   * choosesFriendlyPermanent }` was rejected: that is WIDER than printed in three
   * directions at once (it counters a spell choosing two friendly units, it counts
   * GEAR as the chosen permanent, and it counts a friendly unit in BASE), and a
   * card that is wider than printed is the direction this codebase does not ship.
   */
  function chained(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "quarry", might: 9 })] };

    state.players[1]!.hand = [spellInstance(HEXTECH_RAY)];
    state.players[1]!.channeled = runes("Fury", 8);

    state.players[0]!.hand = [spellInstance(REPULSE), spellInstance(NOT_SO_FAST)];
    state.players[0]!.channeled = [...runes("Body", 4), ...runes("Calm", 4)];

    const ray = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.defId === HEXTECH_RAY && a.targetUnitInstanceId === "quarry",
    );
    expect(ray, "the enemy spell was not castable at the friendly unit — the fixture is wrong").toBeDefined();
    const onChain = accept(state, ray!);
    const pass = legalActions(onChain).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the caster was never offered a pass on their own spell (345)").toBeDefined();
    return accept(onChain, pass!);
  }

  const enemySpellWaiting = (state: GameState) =>
    state.spellChain.filter(isSpellChainEntry).filter((e) => e.card.defId === HEXTECH_RAY);

  /** Passes until the chain has emptied — both players declining everything. */
  function drain(state: GameState): GameState {
    let current = state;
    for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
      const pass = legalActions(current).find((a) => a.type === "PassFocus");
      if (!pass) break;
      current = accept(current, pass!);
    }
    return current;
  }

  /**
   * How much damage the enemy spell actually dealt.
   *
   * **The counter is measured HERE and not by the chain being empty**, and that
   * distinction was found by mutation: with `counterSpell` stubbed to a no-op the
   * chain-length version of this test still passed, because draining the chain
   * resolves the spell and pops it either way. An empty chain is what BOTH a
   * counter and an ordinary resolution look like.
   */
  const quarryDamage = (state: GameState) =>
    (state.battlefields[0]!.units["p1"] ?? []).find((u) => u.instanceId === "quarry")?.damage;

  it("leaves the enemy spell on the chain, where Not So Fast removes it", () => {
    const state = chained();
    expect(enemySpellWaiting(state), "the fixture never got the enemy spell onto the chain").toHaveLength(1);

    // The fixture's own control: left alone, the enemy spell lands for 3. Without
    // this the "0 damage" below would also be what a spell that never resolved,
    // never targeted or never worked looks like.
    expect(quarryDamage(drain(state)), "the enemy spell does nothing on its own — the fixture is wrong").toBe(3);

    // The pin. Repulse names two targets; the enumerator has no spec that can pair
    // them under its restriction, so there is no play that counters anything.
    const repulseId = state.players[0]!.hand.find((c) => c.defId === REPULSE)!.instanceId;
    const repulsePlays = playsOf(state, repulseId);
    const counters = repulsePlays.filter((p) => p.targetChainCardInstanceId !== undefined);
    expect(counters, "Repulse can name a chain spell — delete this pin, UNL-106 is implemented").toHaveLength(0);

    // The positive control: the same chain, the same friendly unit at the same
    // battlefield, and the pool's nearest implemented neighbour DOES counter it.
    // Without this, "no counter play offered" and "nothing to counter" are the
    // same observation.
    const nsfId = state.players[0]!.hand.find((c) => c.defId === NOT_SO_FAST)!.instanceId;
    const nsf = playsOf(state, nsfId).find((p) => p.targetChainCardInstanceId !== undefined);
    expect(nsf, "Not So Fast could not counter it either — the fixture is wrong").toBeDefined();

    const resolved = drain(accept(state, nsf!));
    expect(quarryDamage(resolved), "the control counter did not fire — the spell still landed").toBe(0);
    expect(enemySpellWaiting(resolved), "the countered spell is still waiting").toHaveLength(0);
  });

  it("is reported unimplemented", () => {
    expect(
      isCardImplemented(registry.get(REPULSE)),
      "UNL-106 reports implemented — delete this whole pin block",
    ).toBe(false);
  });
});

describe("PIN — which of wave 4's five refusals are still open", () => {
  it("THREE still report unimplemented; two were written all along", () => {
    // One place that says where the set stands, so closing any of them flips
    // exactly one line here rather than being noticed by nobody. The reasons
    // differ and the distinction is the point: four are genuinely unwritten, and
    // Master Yi is written and unclaimed (see his own pin above).
    // **UNL-120 Rengar - Trophy Hunter left this list on 2026-08-11.** This
    // re-audit measured his fix as one `PLACEMENT_GRANTS` row, "byte-identical to
    // Deadbloom Predator's", and that is exactly what it was.
    // **DETERMINED_SENTRY left this list on 2026-08-13** — his refusal named the
    // per-unit gate precisely and that is what was built.
    for (const defId of [REPULSE, ARACHNOID_HORROR]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} now reports implemented`).toBe(false);
      expect(implementingModules(defId), `${defId} is claimed by a module now`).toEqual([]);
    }
    // **Master Yi LEFT this list at integration.** He was never one of the four —
    // he was written all along and merely unclaimed, which is why this test named
    // three reasons for five cards. Now four are unwritten and he is whole.
    expect(isCardImplemented(registry.get(MASTER_YI_TEMPERED)), "Master Yi went back to unclaimed").toBe(true);
  });
});
