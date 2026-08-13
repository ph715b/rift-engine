import { describe, expect, it } from "vitest";
import { isCardImplemented } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type UnitInstance } from "../src/model/card.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import type { HideCardAction, PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Unleashed Fury — wave 8.
 *
 * **Two cards, both of them wave 7 refusals that the wave-7 primitives unblocked**
 * — Katarina - Reckless' "when you hide a card, ready me" (now `cardHidden`) and
 * Revna the Lorekeeper's "when you play a spell, if you spent [4] or more" (now
 * `SpellChainEntry.energySpent`). Nine of the eleven cards this wave was handed
 * are still refused; their blockers are re-measured and re-pinned at the bottom.
 *
 * Everything here goes through `legalActions` + `submit` and then settles the
 * chain by real PassFocus actions. Both abilities are HELD triggers (383.3), so a
 * test that called the resolver would prove nothing about whether the event
 * reaches it — which is exactly the shape wave 7 could not have tested and this
 * wave has to.
 *
 * **Each positive has a matching negative that is one number away from it**, not
 * a blank board: Revna's are the same spell played at a different real price, and
 * Katarina's is the same action taken by the other player. A negative control that
 * shares no setup with its positive proves the fixture, not the card.
 */

const registry = defaultCardRegistry();

const REVNA = "UNL-005"; // Unit, 7 Energy 1 Fury, [Ganking] — "if you spent [4] or more, ready me"
const KATARINA = "UNL-023"; // Unit, 5 Energy 1 Fury — hide -> ready me; play-from-facedown -> deal 2

/** Catalyst of Aeons — [4], NO Power pip. `energySpent` 4, `totalCost` 4. */
const CATALYST_OF_AEONS = "OGN-138";
/**
 * Right of Conquest — [3][Fury]. `totalCost` is **4** and `energySpent` is **3**,
 * so it is the exact card that separates the two readings: the wave-7 refusal
 * named `totalCost` as the wrong answer and this is the state where it is wrong.
 */
const RIGHT_OF_CONQUEST = "UNL-015";
/**
 * Production Surge — [4][Mind], "this costs [2] less if you control a Mech". One
 * printed card at two real prices, which is the only pair that can tell a
 * post-discount reading from a printed one in BOTH directions.
 */
const PRODUCTION_SURGE = "SFD-076";
/** Consult the Past — [Hidden], so it is a legal thing to hide. */
const CONSULT_THE_PAST = "OGN-083";

const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const rune = (id: string, domain: "Fury" | "Mind"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (count: number, domain: "Fury" | "Mind" = "Fury"): RuneCard[] =>
  Array.from({ length: count }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the action was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** One PassFocus, whoever holds it. */
function passOnce(state: GameState): GameState {
  return accept(state, legalActions(state).find((a) => a.type === "PassFocus"));
}

/** Passes Focus until the chain and the holding pen are both empty (340). */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  throw new Error("settle: the chain never emptied");
}

/** The unit as the BOARD holds it, wherever it stands. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const castsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

// ---------------------------------------------------------------------------
// UNL-005 Revna the Lorekeeper
// ---------------------------------------------------------------------------

describe("Revna the Lorekeeper (UNL-005): ready me when you SPEND [4] on a spell", () => {
  /**
   * Revna EXHAUSTED in her controller's base, one spell in hand, and runes to pay
   * for it.
   *
   * Base rather than a battlefield deliberately: her trigger is not positional
   * ("when YOU play a spell"), and standing her in base keeps a Cleanup that drops
   * control of an unoccupied battlefield out of the measurement.
   *
   * She starts EXHAUSTED because 415.1.c makes readying a ready unit a no-op — a
   * ready Revna would read the same whether the trigger fired or never existed,
   * which is the shape that makes a passing test meaningless.
   */
  function board(spellDefId: string, opts: { mech?: boolean; power?: "Fury" | "Mind" } = {}): {
    state: GameState;
    revnaId: string;
    spellId: string;
  } {
    const revna = { ...realUnitInstance(REVNA), exhausted: true };
    const spell = card(spellDefId);
    const state = makeState({
      players: [
        makePlayer("p1", {
          baseUnits: opts.mech ? [revna, makeUnit({ instanceId: "mech", tags: ["Mech"] })] : [revna],
          hand: [spell],
          // Both domains channeled, so one fixture can pay a Fury pip or a Mind
          // one and the two Revna cases differ only in the SPELL.
          channeled: [...runes(8, "Fury"), ...runes(4, "Mind")],
          deck: [card(CATALYST_OF_AEONS), card(CATALYST_OF_AEONS), card(CATALYST_OF_AEONS)],
          runeDeck: runes(6, "Fury").map((r) => ({ ...r, id: `deck-${r.id}` })),
        }),
        makePlayer("p2"),
      ],
    });
    return { state, revnaId: revna.instanceId, spellId: spell.instanceId };
  }

  it("PLUMBING: the chain entry records the ENERGY actually spent, not the printed cost", () => {
    // Asserted before anything reads it, because every claim below rests on this
    // one field arriving with the right number. Right of Conquest prints [3][Fury]
    // — `energyCost + powerCost` is 4 and the Energy spent is 3.
    const { state } = board(RIGHT_OF_CONQUEST);
    const played = accept(state, castsOf(state, RIGHT_OF_CONQUEST)[0]);

    const entry = played.spellChain[played.spellChain.length - 1];
    expect(entry, "the spell never reached the chain").toBeDefined();
    // Narrowed through the engine's own guard — `ChainEntry` is a UNION and only
    // the Spell half carries `energySpent`.
    expect(isSpellChainEntry(entry!) ? entry!.energySpent : undefined).toBe(3);
  });

  it("POSITIVE: spending [4] readies her", () => {
    const { state, revnaId } = board(CATALYST_OF_AEONS);
    expect(unitOnBoard(state, revnaId)?.exhausted, "fixture: she must start exhausted").toBe(true);

    const played = accept(state, castsOf(state, CATALYST_OF_AEONS)[0]);
    const settled = settle(played);

    expect(unitOnBoard(settled, revnaId)?.exhausted, "Revna never readied — the trigger did not fire").toBe(false);
  });

  it("POSITIVE CONTROL on the hold: the trigger goes on the CHAIN, not inline", () => {
    // 383.3 puts a Triggered Ability on the chain, and `spellCast` is a
    // `HeldEventKind`. Without this, the test above would pass just as well if the
    // ready had been applied inline at the dispatch site — a difference nobody can
    // see from the final board but which decides whether the opponent gets a
    // response window.
    const { state, revnaId } = board(CATALYST_OF_AEONS);
    const played = accept(state, castsOf(state, CATALYST_OF_AEONS)[0]);
    // Two passes in sequence resolve and pop the SPELL, which is the moment
    // `spellCast` fires (see the event's own note: the moment is the chain pop).
    const afterSpell = passOnce(passOnce(played));

    expect(unitOnBoard(afterSpell, revnaId)?.exhausted, "she readied INLINE, without a response window").toBe(true);
    const held = [...afterSpell.pendingTriggers, ...afterSpell.spellChain];
    expect(held.length, "nothing was held — the trigger never reached the chain").toBeGreaterThan(0);
  });

  it("NEGATIVE: spending [3] on a spell whose PRINTED cost totals 4 does NOT ready her", () => {
    // The wave-7 refusal in one assertion. `spellCast.totalCost` for Right of
    // Conquest is 3 Energy + 1 Power = 4, so the reading wave 7 refused to write
    // would ready her here; the printed threshold is an ENERGY pip and she spent 3.
    const { state, revnaId } = board(RIGHT_OF_CONQUEST);
    const settled = settle(accept(state, castsOf(state, RIGHT_OF_CONQUEST)[0]));

    expect(unitOnBoard(settled, revnaId)?.exhausted, "she readied off the PRINTED cost").toBe(true);
  });

  /**
   * The discount pair. Same card, same printed [4][Mind], two real prices — so
   * neither half can be explained by anything except what was actually spent.
   */
  it("POSITIVE: an undiscounted [4] spell readies her", () => {
    const { state, revnaId } = board(PRODUCTION_SURGE);
    const settled = settle(accept(state, castsOf(state, PRODUCTION_SURGE)[0]));

    expect(unitOnBoard(settled, revnaId)?.exhausted).toBe(false);
  });

  it("NEGATIVE: the SAME [4] spell discounted to [2] by a Mech does NOT ready her", () => {
    const { state, revnaId } = board(PRODUCTION_SURGE, { mech: true });
    const cast = castsOf(state, PRODUCTION_SURGE)[0];
    expect(cast, "the discounted play was never offered").toBeDefined();
    // Pinned so a fixture whose Mech stopped counting cannot pass this as a
    // discount that never happened.
    expect(cast!.payment.energyRunes.length, "the Mech discount did not apply").toBe(2);

    const settled = settle(accept(state, cast));
    expect(unitOnBoard(settled, revnaId)?.exhausted, "she readied off the PRINTED cost").toBe(true);
  });

  it("NEGATIVE: the OPPONENT spending [4] does not ready her — 'when YOU play a spell'", () => {
    const revna = { ...realUnitInstance(REVNA), exhausted: true };
    const spell = card(CATALYST_OF_AEONS);
    const state = makeState({
      activePlayerIndex: 1,
      focusHolder: 1,
      chainPriority: 1,
      players: [
        makePlayer("p1", { baseUnits: [revna] }),
        makePlayer("p2", {
          hand: [spell],
          channeled: runes(8, "Fury"),
          deck: [card(CATALYST_OF_AEONS)],
          runeDeck: runes(6, "Fury").map((r) => ({ ...r, id: `deck-${r.id}` })),
        }),
      ],
    });

    const settled = settle(accept(state, castsOf(state, CATALYST_OF_AEONS)[0]));
    expect(unitOnBoard(settled, revna.instanceId)?.exhausted, "she readied off the opponent's spell").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-023 Katarina - Reckless
// ---------------------------------------------------------------------------

describe("Katarina - Reckless (UNL-023), first clause: ready me when you HIDE a card", () => {
  /**
   * A hideable board — p1 controls bf1 and GARRISONS it (Cleanup step 4 drops
   * control of an unoccupied battlefield, and step 5 then trashes the facedown
   * card, so an ungarrisoned hide is a different test) — with Katarina exhausted
   * in `katarinaOwner`'s base and a `[Hidden]` card in p1's hand.
   */
  function board(katarinaOwner: 0 | 1 = 0): { state: GameState; katarinaId: string; hiddenCard: CardInstance } {
    const katarina = { ...realUnitInstance(KATARINA), exhausted: true };
    const consult = card(CONSULT_THE_PAST);
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [consult],
          channeled: runes(8, "Fury"),
          deck: [card(CATALYST_OF_AEONS), card(CATALYST_OF_AEONS), card(CATALYST_OF_AEONS)],
          runeDeck: runes(4, "Fury").map((r) => ({ ...r, id: `deck-${r.id}` })),
          baseUnits: katarinaOwner === 0 ? [katarina] : [],
        }),
        makePlayer("p2", { baseUnits: katarinaOwner === 1 ? [katarina] : [] }),
      ],
    });
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "garrison" })] };
    return { state, katarinaId: katarina.instanceId, hiddenCard: consult };
  }

  const hideOf = (state: GameState, c: CardInstance): HideCardAction | undefined =>
    legalActions(state).find(
      (a): a is HideCardAction => a.type === "HideCard" && a.card.instanceId === c.instanceId,
    );

  it("POSITIVE: hiding a card readies her", () => {
    const { state, katarinaId, hiddenCard } = board();
    expect(unitOnBoard(state, katarinaId)?.exhausted, "fixture: she must start exhausted").toBe(true);

    const hidden = accept(state, hideOf(state, hiddenCard));
    const settled = settle(hidden);

    expect(unitOnBoard(settled, katarinaId)?.exhausted, "Katarina never readied — the trigger did not fire").toBe(false);
  });

  it("POSITIVE CONTROL on the hold: the hide itself opens no chain, but the trigger does", () => {
    // 811.1.c.2 — hiding does not open a chain. What the hide SETS OFF is an
    // ordinary Chain Pending Item, and the two are different sentences. Asserted
    // together so a future "make it inline because the hide has no chain" reading
    // fails here rather than in a game.
    const { state, hiddenCard } = board();
    const hidden = accept(state, hideOf(state, hiddenCard));

    const held = [...hidden.pendingTriggers, ...hidden.spellChain];
    expect(held.length, "nothing was held — the ready happened inline or not at all").toBeGreaterThan(0);
  });

  it("NEGATIVE: the OPPONENT's Katarina is not readied — 'when YOU hide a card'", () => {
    const { state, katarinaId, hiddenCard } = board(1);
    const settled = settle(accept(state, hideOf(state, hiddenCard)));

    expect(unitOnBoard(settled, katarinaId)?.exhausted, "she readied off the opponent's hide").toBe(true);
  });

  /**
   * The negative that separates the new event from the one that was already there.
   *
   * `executeHideCard` raises BOTH `runesRecycled` (Sivir's moment — a Power payment
   * recycles the rune that paid it) and `cardHidden`. A Katarina wired to the wrong
   * one would pass every test above and then fire on any Power spent at all, so
   * this pays Power WITHOUT hiding.
   */
  it("NEGATIVE: paying Power without hiding does NOT ready her", () => {
    const { state, katarinaId } = board();
    // Right of Conquest costs [3][Fury] — a Power pip, so a rune is recycled and
    // `runesRecycled` fires, and nothing is hidden.
    const withSpell: GameState = {
      ...state,
      players: [{ ...state.players[0]!, hand: [card(RIGHT_OF_CONQUEST)] }, state.players[1]!],
    };
    const cast = castsOf(withSpell, RIGHT_OF_CONQUEST)[0];
    expect(cast!.payment.powerRunes.length, "fixture: no Power was paid, so no rune is recycled").toBe(1);

    const settled = settle(accept(withSpell, cast));
    expect(unitOnBoard(settled, katarinaId)?.exhausted, "she readied off a rune recycle").toBe(true);
  });

  it("REGRESSION: her SECOND clause still fires when a card is played from facedown", () => {
    // Widening `on` from a single kind to a list is exactly the change that can
    // silently drop the original branch, so the clause wave 5 wrote is re-asserted
    // through the same funnel. An enemy unit has to exist or the trigger declines
    // to hold at all (nothing to shoot).
    const { state, katarinaId, hiddenCard } = board();
    const withEnemy: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, baseUnits: [makeUnit({ instanceId: "victim", might: 9 })] }],
    };
    const hidden = settle(accept(withEnemy, hideOf(withEnemy, hiddenCard)));
    expect(unitOnBoard(hidden, katarinaId)?.exhausted, "the hide clause fired, as it should have").toBe(false);

    // 811.1.b — playable "beginning on the next turn".
    const nextTurn: GameState = { ...hidden, turnNumber: hidden.turnNumber + 1 };
    const fromFacedown = legalActions(nextTurn).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === hiddenCard.instanceId,
    );
    expect(fromFacedown, "the facedown card was never offered").toBeDefined();

    const played = settle(accept(nextTurn, fromFacedown));
    // Asserted on the DAMAGE rather than on a parked `UNL-023-shot` decision, and
    // that is a measured correction rather than a preference: with exactly one
    // enemy unit on the board `advanceDecisions` auto-resolves the question, so
    // `pendingDecisions` is empty at every step and a decision-shaped assertion
    // reads as "the clause stopped firing" when it in fact fired and resolved.
    // The damage is the effect, and it is what a game would show.
    expect(unitOnBoard(played, "victim")?.damage, "the play-from-facedown clause stopped firing").toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("coverage: what this wave finished and what it did not", () => {
  it("Revna reports IMPLEMENTED", () => {
    // She had no registration at all before this wave — the flip is the whole
    // measurement that her entry is reachable by the registry merge.
    expect(isCardImplemented(registry.get(REVNA))).toBe(true);
  });

  it("NEGATIVE CONTROL on the instrument: an untouched refusal still reports unfinished", () => {
    // Without this the row above passes just as well if `isCardImplemented`
    // returned true for everything.
    expect(isCardImplemented(registry.get("UNL-007")), "Smite reports finished — the gate is broken").toBe(false);
  });
});

describe("the nine cards this wave REFUSED, re-measured against the current engine", () => {
  /**
   * Each row was checked against the source this session rather than inherited
   * from wave 7's list — two wave-7 refusals turned out to be wrong when re-read,
   * which is why re-measuring is the rule.
   *
   * `isCardImplemented` is FALSE for all nine, which for four of them is because a
   * `PARTIALLY_IMPLEMENTED` row is holding them down rather than because nothing is
   * written. That is the same instrument either way: the day the blocker lands and
   * the row is retired, this test goes red and names the card.
   */
  const refusals: ReadonlyArray<readonly [string, string]> = [
    // `spellCast` carries `casterIndex`/`totalCost`/`energySpent` and NO card
    // identity, so "you may banish IT" cannot name the spell it is about; and
    // `PlayerState.banished` is a flat array with no association to a Legend, so
    // "four spells banished WITH ME" has nothing to count. Both are shared-file
    // edits (triggers.ts + execute-pass-focus.ts, game-state.ts), and he is a
    // Legend besides.
    ["UNL-181", "spellCast carries no card identity, and there is no 'banished with me' zone"],
    // `death-ward.ts` models "would die -> revive", not "would die -> banish", and
    // its two lists are both revival lists. A turn-long banish-instead needs a new
    // GameState list, a killUnit branch and a runEnd sweep.
    ["UNL-007", "a turn-long death REPLACEMENT that banishes rather than revives"],
    // 465.2.c.5's worked example names this card: the doubling is a replacement on
    // damage ASSIGNMENT, ordered against prevention by the defender's controller.
    // `modifiedDamageAmount` is additive and does not take the target UNIT, and the
    // combat half lives in combat.ts.
    ["UNL-013", "a per-unit damage doubler at combat ASSIGNMENT (465.2.c.5) as well as at dealDamage"],
    // `RepeatCostSpec` is `{ energy, power?, domain?, rainbowPower? }` — resources
    // only, and Square Up's Repeat cost is "Discard 1".
    ["UNL-017", "RepeatCostSpec carries resources only; this Repeat cost is Discard 1"],
    // 820.3 makes each printed instance separately payable; Curtain Call prints
    // three, and `REPEAT_COSTS` maps one defId to exactly one spec. Its "choose one
    // you haven't already chosen" is additionally a per-EXECUTION constraint that a
    // single `modeId` cannot express.
    ["UNL-182", "three Repeat instances (820.3) and a per-execution mode re-choice"],
    // The replay leaves the CASTER's trash to be played by the TARGET's controller
    // at a replaced price, and nothing tallies one spell's damage instances.
    ["UNL-020", "a cross-player play-from-trash permission at a replaced price"],
    // `timing.mayPlayFromTrash` is `card.kind === "Unit"` AND a per-PLAYER counter
    // (`trashUnitPlaysThisTurn`), and it charges the printed price. Both cards need
    // a per-INSTANCE permission with a cost OVERRIDE, and UNL-186 is a Spell.
    ["UNL-025", "mayPlayFromTrash is per-player and charges printed"],
    ["UNL-186", "mayPlayFromTrash is Units-only, per-player, and charges printed"],
    // `equipAbilities()` builds one static `ActivationCost` per gear; no activation
    // cost in this engine can depend on the target chosen for it.
    ["UNL-188", "an [Equip] cost that is a function of the chosen unit's Might"],
  ];

  for (const [defId, blocker] of refusals) {
    it(`${defId} is still unimplemented — ${blocker}`, () => {
      expect(isCardImplemented(registry.get(defId)), `${defId} was implemented — delete this row`).toBe(false);
    });
  }
});
