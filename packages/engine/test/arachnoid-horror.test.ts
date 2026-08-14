import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { mayPlaceWithoutPresence } from "../src/engine/unit-triggers.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **UNL-117 Arachnoid Horror — two sentences, one condition.**
 *
 * > "I can be played to an occupied battlefield if an enemy unit is alone there.
 * > Friendly units can be played to an occupied battlefield if an enemy unit is
 * > alone there."
 *
 * # "Alone" is defined by the rules, and not the way it reads
 *
 * **740.2.a**: "A unit is alone when there are no other **friendly** units at
 * the same location", with **740.1.a** making two objects friendly if they share
 * a controller.
 *
 * So "an enemy unit is alone there" asks whether the OPPONENT has exactly one
 * unit at that battlefield. It says nothing about how many the caster has. The
 * obvious reading — "the only unit there at all" — is STRICTER than printed and
 * would refuse legal plays wherever the caster already had a body present, which
 * is precisely the board this card is for. That case is asserted below.
 *
 * # Why two mechanisms for one condition
 *
 * The first sentence is a property of the CARD BEING PLAYED, so it is a
 * `PLACEMENT_GRANTS` row. The second is a property of the BOARD while he stands
 * on it, so it is `board-restrictions.grantsEnemyAlonePlacement` — the shape
 * Miss Fortune - Buccaneer already has, and for the same stated reason: keying a
 * board-wide grant on the arriving card would mean a row per card in the pool.
 *
 * Both halves are asserted separately. A test that only played the Horror
 * himself would leave the second sentence entirely untested, and it is the
 * larger of the two.
 */

const registry = defaultCardRegistry();

const ARACHNOID_HORROR = "UNL-117";
/** A vanilla body with no placement grant of its own — the second sentence's
 *  whole point is that an ORDINARY unit gets the destination. */
const PLAIN_UNIT = "OGN-052"; // Stalwart Poro

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const destinationsOf = (state: GameState, instanceId: string): (string | undefined)[] =>
  playsOf(state, instanceId).map((a) => a.destinationBattlefieldId);

/**
 * A board where the OPPONENT has `enemyCount` units at battlefield 0 and the
 * caster has `friendlyCount` there — the two axes that tell 740.2.a's reading
 * apart from the naive one.
 */
function board(opts: { enemyCount: number; friendlyCount?: number; horrorInPlay?: boolean }): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  const me = state.players[0]!.id;
  const them = state.players[1]!.id;
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`b${i}`, "Body"));
  state.battlefields[0]!.units = {
    [them]: Array.from({ length: opts.enemyCount }, (_, i) => makeUnit({ instanceId: `enemy-${i}` })),
    [me]: Array.from({ length: opts.friendlyCount ?? 0 }, (_, i) => makeUnit({ instanceId: `mine-${i}` })),
  };
  if (opts.horrorInPlay) {
    state.players[0]!.baseUnits = [realUnitInstance(ARACHNOID_HORROR)];
  }
  return state;
}

describe("his OWN clause — the per-card placement grant", () => {
  it("may be played to a battlefield where the enemy has exactly ONE unit", () => {
    const state = board({ enemyCount: 1 });
    const horror = realUnitInstance(ARACHNOID_HORROR);
    state.players[0]!.hand = [horror];

    expect(destinationsOf(state, horror.instanceId), "he was not offered the lone enemy's battlefield").toContain(
      state.battlefields[0]!.id,
    );
  });

  it("may NOT be played there when the enemy has two — the unit is not alone", () => {
    const state = board({ enemyCount: 2 });
    const horror = realUnitInstance(ARACHNOID_HORROR);
    state.players[0]!.hand = [horror];

    // The negative control on the same fixture, one unit apart.
    expect(destinationsOf(state, horror.instanceId), "a two-unit battlefield counted as 'alone'").not.toContain(
      state.battlefields[0]!.id,
    );
    // And he is still castable to base, so the negative is about the destination.
    expect(destinationsOf(state, horror.instanceId), "he became uncastable entirely").toContain(undefined);
  });

  it("**740.2.a**: the caster's OWN units there do not stop the enemy being alone", () => {
    // The reading that matters, and the one a naive "only unit present" check
    // gets wrong. One enemy, two friendlies — the enemy is still alone, because
    // "alone" counts only units FRIENDLY TO IT.
    //
    // Note this board would let him in anyway under 813's ordinary presence rule
    // (the caster has units there), so the grant is asserted DIRECTLY as well,
    // below, where presence cannot mask it.
    const state = board({ enemyCount: 1, friendlyCount: 2 });
    expect(
      mayPlaceWithoutPresence(state, 0, ARACHNOID_HORROR, state.battlefields[0]!),
      "the caster's own units were counted against the enemy being alone",
    ).toBe(true);
  });

  it("the predicate answers on the ENEMY's count alone, in both directions", () => {
    // Asked through `mayPlaceWithoutPresence` rather than the enumerator, because
    // presence at the battlefield would otherwise permit the play for an
    // unrelated reason and mask a broken grant.
    expect(mayPlaceWithoutPresence(board({ enemyCount: 1 }), 0, ARACHNOID_HORROR, board({ enemyCount: 1 }).battlefields[0]!)).toBe(
      true,
    );
    const two = board({ enemyCount: 2 });
    expect(mayPlaceWithoutPresence(two, 0, ARACHNOID_HORROR, two.battlefields[0]!), "two enemies read as alone").toBe(
      false,
    );
    const none = board({ enemyCount: 0 });
    expect(mayPlaceWithoutPresence(none, 0, ARACHNOID_HORROR, none.battlefields[0]!), "an EMPTY battlefield read as alone").toBe(
      false,
    );
  });
});

describe("his SECOND clause — the board-wide grant to friendly units", () => {
  it("lets an ORDINARY unit take the lone enemy's battlefield while he is in play", () => {
    // The half a test of the Horror himself cannot reach. Stalwart Poro has no
    // placement grant of his own and no presence there, so 813 would refuse this
    // destination outright.
    const state = board({ enemyCount: 1, horrorInPlay: true });
    const poro = realUnitInstance(PLAIN_UNIT);
    state.players[0]!.hand = [poro];

    expect(destinationsOf(state, poro.instanceId), "the board-wide grant did not reach an ordinary unit").toContain(
      state.battlefields[0]!.id,
    );
  });

  it("does NOT let one in while the Horror is absent", () => {
    // The paired control, one card apart — without it the test above passes just
    // as well if 813's presence rule had simply stopped working.
    const state = board({ enemyCount: 1, horrorInPlay: false });
    const poro = realUnitInstance(PLAIN_UNIT);
    state.players[0]!.hand = [poro];

    expect(destinationsOf(state, poro.instanceId), "an ordinary unit reached it with no Horror in play").not.toContain(
      state.battlefields[0]!.id,
    );
    expect(destinationsOf(state, poro.instanceId), "he became uncastable entirely").toContain(undefined);
  });

  it("grants from BASE — his text names no battlefield for himself", () => {
    // `inPlayFor`, not `atOwnBattlefield`. The same reading Miss Fortune -
    // Buccaneer takes, and `board()` puts him in base precisely so this is what
    // every board-wide test above is measuring.
    const state = board({ enemyCount: 1, horrorInPlay: true });
    expect(state.players[0]!.baseUnits.map((u) => u.defId), "fixture: he must be in BASE").toEqual([ARACHNOID_HORROR]);

    const poro = realUnitInstance(PLAIN_UNIT);
    state.players[0]!.hand = [poro];
    expect(destinationsOf(state, poro.instanceId), "he granted nothing from base").toContain(
      state.battlefields[0]!.id,
    );
  });

  it("still needs the enemy to be ALONE — two enemies and the grant does nothing", () => {
    const state = board({ enemyCount: 2, horrorInPlay: true });
    const poro = realUnitInstance(PLAIN_UNIT);
    state.players[0]!.hand = [poro];

    expect(destinationsOf(state, poro.instanceId), "the grant ignored its own condition").not.toContain(
      state.battlefields[0]!.id,
    );
  });

  it("does not widen an unrelated grant — Deadbloom Predator keeps his own kind of place", () => {
    // The narrowing the switch's `default` branch exists to preserve: a card that
    // names its own kind of destination keeps getting that one. Deadbloom
    // Predator (OGN-161) wants an OCCUPIED ENEMY battlefield, which a two-enemy
    // board still is — so he is offered it and the Horror's condition, which that
    // board fails, must not take it away.
    const state = board({ enemyCount: 2, horrorInPlay: true });
    const predator = realUnitInstance("OGN-161");
    state.players[0]!.hand = [predator];

    expect(destinationsOf(state, predator.instanceId), "his own grant was overridden").toContain(
      state.battlefields[0]!.id,
    );
  });
});

describe("the enumerator and the validator agree", () => {
  it("every enumerated play on a lone-enemy board validates, for both cards", () => {
    const state = board({ enemyCount: 1, horrorInPlay: true });
    const horror = realUnitInstance(ARACHNOID_HORROR);
    const poro = realUnitInstance(PLAIN_UNIT);
    state.players[0]!.hand = [horror, poro];

    const plays = [...playsOf(state, horror.instanceId), ...playsOf(state, poro.instanceId)];
    expect(plays.length, "nothing was enumerated, so this asserts nothing").toBeGreaterThan(2);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, `enumerated but refused (${play.card.name}): ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it("REFUSES a forged play to a two-enemy battlefield", () => {
    // The validator half. The enumerator declining to offer a destination is not
    // a rule; this is what makes it one.
    const lone = board({ enemyCount: 1 });
    const horror = realUnitInstance(ARACHNOID_HORROR);
    lone.players[0]!.hand = [horror];
    const good = playsOf(lone, horror.instanceId).find((a) => a.destinationBattlefieldId !== undefined)!;

    const crowded = board({ enemyCount: 2 });
    crowded.players[0]!.hand = [horror];
    expect(
      validatePlayCard(crowded, { ...good, destinationBattlefieldId: crowded.battlefields[0]!.id }).ok,
      "a forged play reached a battlefield where no enemy is alone",
    ).toBe(false);
  });
});

describe("coverage", () => {
  it("reports him finished", () => {
    const def = registry.get(ARACHNOID_HORROR);
    expect(isCardImplemented(def), "he still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "he carries a partial note").toBeUndefined();
    expect(implementingModules(ARACHNOID_HORROR), "his placement grant is not claimed").toContain("unit-triggers");
  });
});
