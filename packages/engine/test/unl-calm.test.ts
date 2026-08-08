import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The Unleashed (UNL) cards filed in engine/effects/calm.ts.
 *
 * Same rule as test/sfd-calm.test.ts, and for the same reason: every test drives
 * a REAL path — `legalActions` + `submit` for a play, the death funnel plus a
 * chain settle for a [Deathknell] — and asserts the effect landed on state. A
 * resolver called directly passes whether or not the dispatch hop that reaches
 * it in a game carries the fields it needs.
 *
 * Both cards here also carry a NEGATIVE control, because the two effects
 * involved (a draw, an XP gain) are things other parts of a turn also do, and a
 * one-sided fixture cannot tell "my card fired" from "something fired".
 */

const registry = defaultCardRegistry();

const LONELY_PORO_UNL = "UNL-221"; // Lonely Poro (Overnumbered) — the SFD-036 reprint
const HERALD_OF_SPRING = "UNL-034";
/** `[Hunt 3]` and NOTHING else — the negative control for the Herald's on-play
 *  XP, since it isolates the keyword from the printed sentence. */
const VORACIOUS_GROMP = "UNL-100";

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n: number) => Array.from({ length: n }, (_, i) => rune(`r${i}`));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Plays `defId` from player 0's hand through the enumerator and `submit`, then
 *  settles the Pending Item its on-play trigger became. */
function playUnit(state: GameState, defId: string, destinationBattlefieldId?: string): GameState {
  const action = legalActions(state).find(
    (a) =>
      a.type === "PlayCard" &&
      a.card.defId === defId &&
      (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === destinationBattlefieldId,
  );
  expect(action, `${defId} was never enumerated as playable to ${destinationBattlefieldId ?? "base"}`).toBeDefined();
  return resolveHeldTriggers(accept(state, action!));
}

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

describe("Herald of Spring (UNL-034): [Hunt], and 'when you play me, gain 2 XP'", () => {
  /** Him in hand with enough Calm runes to pay 4 Energy + 1 Calm Power. */
  function heraldState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(HERALD_OF_SPRING)];
    state.players[0]!.channeled = runes(8);
    return state;
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(HERALD_OF_SPRING))).toBe(true);
  });

  it("gains 2 XP through the real play", () => {
    const before = heraldState();
    expect(before.players[0]!.xp, "the fixture already had XP, so the assertion below proves nothing").toBe(0);

    const after = playUnit(before, HERALD_OF_SPRING);
    expect(after.players[0]!.xp, "the on-play trigger never paid").toBe(2);
  });

  it("pays exactly 2, not 3 — [Hunt] is NOT a second on-play payout", () => {
    // The double-pay this card is most likely to produce: he prints `[Hunt]`
    // (worth 1) as well, and Hunt is registered once for the whole pool under
    // HUNT_TRIGGER_KEY. A per-card re-implementation of Hunt here would read as
    // "the card works" on the test above and be wrong by exactly 1.
    //
    // Hunt's own moment is a conquer or a hold, neither of which a play is —
    // and test/hunt-keyword.test.ts pins that it pays 1 there.
    expect(playUnit(heraldState(), HERALD_OF_SPRING).players[0]!.xp).toBe(2);
  });

  it("pays the player who played him, and nothing to the opponent", () => {
    const after = playUnit(heraldState(), HERALD_OF_SPRING);
    expect(after.players[1]!.xp, "the opponent was paid too").toBe(0);
  });

  it("pays nothing for a HUNTER with no on-play clause — the negative control", () => {
    // Voracious Gromp's entire printed text is `[Hunt 3]`. Playing him must gain
    // NOTHING: Hunt's moment is a conquer or a hold, and this is the assertion
    // that separates the Herald's second sentence from the keyword he shares
    // with the Gromp. Without it, an engine that paid XP on any play — or that
    // fired Hunt at the wrong moment — would pass everything above.
    //
    // Energy is domain-free and the Gromp has no Power cost, so Calm runes pay
    // for a Body card here; nothing about the domain is being tested.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(VORACIOUS_GROMP)];
    state.players[0]!.channeled = runes(8);

    expect(playUnit(state, VORACIOUS_GROMP).players[0]!.xp, "XP arrived from a card whose only text is [Hunt]").toBe(0);
  });

  it("pays whether he lands in base or at a battlefield", () => {
    // "When you play me" names no location, unlike Blitzcrank - Impassive's
    // "when you play me TO A BATTLEFIELD" in the same table, which reads
    // `event.destination` and does nothing at base. An ally at bf1 is what makes
    // the reinforce destination legal (813 presence), not part of the assertion.
    const state = heraldState();
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "ally", name: "Ally" })] };

    expect(playUnit(state, HERALD_OF_SPRING, "bf1").players[0]!.xp).toBe(2);
  });
});

describe("Lonely Poro (UNL-221): the Overnumbered reprint of SFD-036's [Deathknell]", () => {
  /** The Poro somewhere killable, with exactly one card in the deck so a draw is
   *  unambiguous: `hand` is `["Drawn"]` or it is empty. */
  function poroState(place: (state: GameState, poro: UnitInstance) => void): { state: GameState; poro: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const poro = realUnitInstance(LONELY_PORO_UNL);
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    place(state, poro);
    return { state, poro };
  }

  /** Player 1 kills it, so "draw" paying the DYING unit's controller is separated
   *  from paying the killer — a symmetric fixture cannot tell those apart. */
  const kill = (state: GameState, instanceId: string) => resolveHeldTriggers(destroyUnit(state, instanceId, 1));

  it("is reported implemented, and is a DIFFERENT defId from the SFD printing", () => {
    // The whole reason this card needed an entry at all: the effect registries
    // are keyed by defId, so a reprint at a new number is a new card to them.
    expect(registry.get(LONELY_PORO_UNL).name).toContain("Lonely Poro");
    expect(isCardImplemented(registry.get(LONELY_PORO_UNL))).toBe(true);
  });

  it("draws for its own controller when it dies alone at a battlefield", () => {
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p] };
    });

    const after = kill(state, poro.instanceId);
    expect(names(after.players[0]!.hand), "the Deathknell never drew").toEqual(["Drawn"]);
    expect(after.players[1]!.hand, "the killer was paid instead of the owner").toHaveLength(0);
  });

  it("draws NOTHING when a friendly unit is standing there", () => {
    // The negative control the whole card turns on — and the one thing that
    // separates a shared definition from a stub that always draws.
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p, makeUnit({ instanceId: "ally", name: "Ally" })] };
    });

    expect(kill(state, poro.instanceId).players[0]!.hand, "it drew despite an ally here").toHaveLength(0);
  });

  it("takes the note as it DIES, not as the Deathknell resolves", () => {
    // The `capture` half. Kill the Poro FIRST while the ally still stands, then
    // the ally, then settle: the Poro was not alone when it died, so it must not
    // draw. Asserted on the REPRINT specifically, because the risk of a second
    // registration is that it copies the resolve and loses the capture — which
    // would fail here and nowhere else.
    const { state, poro } = poroState((s, p) => {
      s.battlefields[0]!.units = { p1: [p, makeUnit({ instanceId: "ally", name: "Ally" })] };
    });

    const poroFirst = resolveHeldTriggers(destroyUnit(destroyUnit(state, poro.instanceId, 1), "ally", 1));
    expect(poroFirst.players[0]!.hand, "it drew despite dying beside an ally").toHaveLength(0);
  });

  it("counts the BASE as a location when it dies at home", () => {
    const { state, poro } = poroState((s, p) => {
      s.players[0]!.baseUnits = [p, makeUnit({ instanceId: "ally", name: "Ally" })];
    });
    expect(kill(state, poro.instanceId).players[0]!.hand, "base was treated as no location at all").toHaveLength(0);

    const alone = poroState((s, p) => {
      s.players[0]!.baseUnits = [p];
    });
    expect(names(kill(alone.state, alone.poro.instanceId).players[0]!.hand)).toEqual(["Drawn"]);
  });
});
