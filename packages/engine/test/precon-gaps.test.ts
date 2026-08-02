import { describe, expect, it } from "vitest";
import { resolveShowdown } from "../src/engine/combat.js";
import { submit } from "../src/engine/game-engine.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { grantKeywordThisTurn } from "../src/engine/effect-helpers.js";
import { createCardInstance } from "../src/model/card.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Cards in the four Proving Grounds precons whose printed text did nothing.
 *
 * All four were found by MEASURING rather than reading — a coverage audit said
 * these ids appeared nowhere in the effect registries, and simulating the play
 * confirmed the deck size / rune pool never moved. A card that silently does
 * nothing is indistinguishable from a working one during a game, which is the
 * same honesty problem docs/rules-conformance.md exists for, one level down.
 */
const registry = defaultCardRegistry();
const card = (defId: string) => createCardInstance(registry.get(defId));

const LECTURING_YORDLE = "OGN-087"; // [Tank], "When you play me, draw 1."
const STORMCLAW_URSINE = "OGN-137"; // [Tank], "When you play me, channel 1 rune exhausted."

function playToBase(state: GameState, unit: ReturnType<typeof card>): GameState {
  return executePlayCard(state, {
    type: "PlayCard",
    playerIndex: 0,
    card: unit,
    // Both are free to cast in this fixture: the payment is validated against
    // legal-actions' own effective cost, and these states give ample runes.
    payment: {
      energyRunes: state.players[0]!.channeled.slice(0, unit.kind === "Legend" ? 0 : unit.energyCost).map((r) => r.id),
      powerRunes: [],
    },
  });
}

/** A caster with enough Ready runes to pay anything in this pool, plus a deck
 *  and rune deck to draw/channel from. */
function casterState(overrides: Partial<GameState> = {}): GameState {
  return makeState({
    players: [
      makePlayer("p1", {
        channeled: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, domain: "Order" as const, state: "Ready" as const })),
        deck: [card("OGN-002"), card("OGN-002"), card("OGN-002")],
        runeDeck: [
          { id: "rd1", domain: "Order", state: "Ready" },
          { id: "rd2", domain: "Order", state: "Ready" },
        ],
      }),
      makePlayer("p2"),
    ],
    ...overrides,
  });
}

describe("precon on-play triggers that were silently doing nothing", () => {
  it("Lecturing Yordle draws 1 when played", () => {
    const state = casterState();
    const yordle = card(LECTURING_YORDLE);
    state.players[0]!.hand = [yordle];

    const before = state.players[0]!.deck.length;
    const after = playToBase(state, yordle);

    expect(after.players[0]!.deck).toHaveLength(before - 1);
    expect(after.players[0]!.hand).toHaveLength(1); // the drawn card; the Yordle left hand
  });

  it("Stormclaw Ursine channels 1 rune EXHAUSTED when played", () => {
    const state = casterState();
    const ursine = card(STORMCLAW_URSINE);
    state.players[0]!.hand = [ursine];

    const beforePool = state.players[0]!.channeled.length;
    const beforeDeck = state.players[0]!.runeDeck.length;
    const after = playToBase(state, ursine);

    expect(after.players[0]!.runeDeck).toHaveLength(beforeDeck - 1);
    const pool = after.players[0]!.channeled;
    expect(pool).toHaveLength(beforePool + 1);
    // Exhausted, not Ready — that's what makes it weaker than a free rune: it
    // can still be recycled for Power this turn but can't pay Energy until Awaken.
    expect(pool[pool.length - 1]!.state).toBe("Exhausted");
  });

  it("channels nothing rather than throwing on an empty rune deck", () => {
    const state = casterState();
    const ursine = card(STORMCLAW_URSINE);
    state.players[0]!.hand = [ursine];
    state.players[0]!.runeDeck = [];
    expect(() => playToBase(state, ursine)).not.toThrow();
  });
});

/**
 * Cannon Barrage — "[Reaction] Deal 2 to all enemy units in combat."
 *
 * A sixth precon gap, and the one an earlier coverage audit MISSED: the audit
 * searched the effect registries for the defId, and `OGN-127` appeared in
 * card-effects.ts — inside a comment explaining why the card was deliberately
 * left unimplemented. Matching prose as if it were code is why the audit reported
 * this card as handled.
 *
 * The stated blocker was real: validate-play-card rejected every cast while a
 * Showdown was open, so the card could only ever be played when there was nothing
 * "in combat" to hit. [Action]/[Reaction] timing removed it.
 */
describe("Cannon Barrage, unblocked by reaction-speed timing", () => {
  it("deals 2 to enemy units in combat and leaves the caster's own alone", () => {
    const registryLocal = defaultCardRegistry();
    const barrage = createCardInstance(registryLocal.get("OGN-127")); // 2 Energy + 1 Body
    const runes = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, domain: "Body" as const, state: "Ready" as const }));
    const attacker = makeUnit({ name: "Attacker", might: 3 });
    const mine = makeUnit({ name: "Mine", might: 5 });

    // Player 1 holds Barrage and is being attacked, so a Combat Showdown opens.
    let state: GameState = makeState({
      players: [makePlayer("p1", { baseUnits: [attacker] }), makePlayer("p2", { hand: [barrage], channeled: runes })],
      phase: "Action",
    });
    state.battlefields[0]!.controllerId = "p2";
    state.battlefields[0]!.units = { p2: [mine] };

    state = submit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [attacker.instanceId],
      destinationBattlefieldId: "bf1",
    }).state;
    expect(state.showdownKind).toBe("Combat");

    // Focus starts with the attacker; pass so the Barrage holder may respond.
    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;
    expect(state.focusHolder).toBe(1);

    const cast = submit(state, {
      type: "PlayCard",
      playerIndex: 1,
      card: barrage,
      payment: { energyRunes: [runes[0]!.id, runes[1]!.id], powerRunes: [runes[2]!.id] },
    });
    expect(cast.result.type).toBe("Ok");
    state = cast.state;
    expect(state.spellChain).toHaveLength(1);
    expect(state.turnState).toBe("Showdown"); // the window stays open under the chain

    state = submit(state, { type: "PassFocus", playerIndex: 1 }).state;
    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;

    // "Enemy" is relative to the CASTER: the attacker took 2, the caster's own
    // unit took nothing.
    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(2);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("does nothing when cast with no Showdown open", () => {
    // "in combat" has no referent outside a Showdown, so the effect is a no-op
    // rather than hitting the whole board.
    const barrage = createCardInstance(defaultCardRegistry().get("OGN-127"));
    const theirs = makeUnit({ name: "Theirs", might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [theirs] };
    const effect = effectForCard(barrage)!;
    const after = effect.resolve(state, { casterIndex: 0 } as never, {});
    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });
});

/**
 * Rule (Tank keyword): "I must be assigned lethal damage before any other unit
 * with the same controller as me that does not have [Tank] during the Combat
 * Damage step." Three precon units carry it; the keyword parsed into the model
 * and then changed nothing, so combat assigned damage in plain list order.
 */
describe("[Tank] is assigned combat damage first", () => {
  /** Attacker with `attackerMight`, defending a 2-Might Tank and a 2-Might
   *  plain unit — with the Tank listed SECOND, so only real reordering can put
   *  it in front. */
  function tankFixture(attackerMight: number, tankFirstInList: boolean): GameState {
    const attacker = makeUnit({ name: "Attacker", might: attackerMight });
    const tank = makeUnit({ name: "Tanky", might: 2, keywords: { Tank: 1 } });
    const plain = makeUnit({ name: "Squishy", might: 2 });
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [attacker],
      p2: tankFirstInList ? [tank, plain] : [plain, tank],
    };
    return state;
  }

  it("soaks the whole lethal allocation before a non-Tank takes any", () => {
    // 2 damage, exactly lethal for one 2-Might unit. It must all land on the
    // Tank even though the plain unit is listed first.
    const next = resolveShowdown(tankFixture(2, false), "bf1", 0);
    const survivors = (next.battlefields[0]!.units["p2"] ?? []).map((u) => u.name);
    expect(survivors).toEqual(["Squishy"]); // the Tank died, the plain unit lived
  });

  it("orders the same way regardless of the underlying unit-list order", () => {
    const listedFirst = resolveShowdown(tankFixture(2, true), "bf1", 0);
    const listedSecond = resolveShowdown(tankFixture(2, false), "bf1", 0);
    const names = (s: GameState) => (s.battlefields[0]!.units["p2"] ?? []).map((u) => u.name);
    expect(names(listedFirst)).toEqual(names(listedSecond));
  });

  it("spills onto the non-Tank only once the Tank has lethal in full", () => {
    // 4 damage: 2 finishes the Tank, the remaining 2 finishes the plain unit.
    const next = resolveShowdown(tankFixture(4, false), "bf1", 0);
    expect(next.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });

  it("does not overkill the Tank while another unit could still be assigned (465.2.c)", () => {
    // 3 damage among a 2-Might Tank and a 2-Might plain unit: the Tank takes
    // exactly its lethal 2, and the leftover 1 goes to the plain unit as marked
    // damage rather than being dumped on the Tank.
    const next = resolveShowdown(tankFixture(3, false), "bf1", 0);
    const remaining = next.battlefields[0]!.units["p2"] ?? [];
    expect(remaining.map((u) => u.name)).toEqual(["Squishy"]);
    // Combat Cleanup heals survivors (rule 466 step 3c), so the marked damage is
    // gone by the time we can look — what matters is that Squishy SURVIVED,
    // which it only does if the Tank was capped at lethal.
    expect(remaining[0]!.damage).toBe(0);
  });

  it("reads a GRANTED [Tank], not only a printed one", () => {
    // Block (OGN-057) and anything else routing through grantKeywordThisTurn
    // writes to `keywordsThisTurn`, which is invisible to `unit.keywords`.
    // combat.ts read the printed set, so a granted [Tank] reordered nothing
    // while the card reported as implemented.
    const state = tankFixture(2, false);
    const squishy = state.battlefields[0]!.units["p2"]![0]!;
    const granted = grantKeywordThisTurn(state, state.battlefields[0]!.units["p2"]![1]!.instanceId, "Tank");
    // Same fixture, but the Tank-ness arrives as a grant rather than printed.
    const printedOff = {
      ...granted,
      battlefields: granted.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { ...bf.units, p2: bf.units["p2"]!.map((u) => ({ ...u, keywords: {} })) } } : bf,
      ),
    };

    const next = resolveShowdown(printedOff, "bf1", 0);
    expect((next.battlefields[0]!.units["p2"] ?? []).map((u) => u.name)).toEqual([squishy.name]);
  });

  it("leaves assignment unchanged when every unit is a Tank", () => {
    const a = makeUnit({ name: "T1", might: 2, keywords: { Tank: 1 } });
    const b = makeUnit({ name: "T2", might: 2, keywords: { Tank: 1 } });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Attacker", might: 2 })], p2: [a, b] };
    const next = resolveShowdown(state, "bf1", 0);
    expect((next.battlefields[0]!.units["p2"] ?? []).map((u) => u.name)).toEqual(["T2"]);
  });
});
