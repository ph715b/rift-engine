import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";

/**
 * Countering a spell — the first thing in this engine that reaches INTO the
 * chain rather than onto the board.
 *
 * Every card here is a `[Reaction]`, which is the whole reason the archetype
 * works: a Reaction can be cast onto an already-closed chain, and the chain
 * resolves LIFO (343), so the counter goes on top and pops FIRST.
 *
 * The half that is invisible in play, and therefore the half tested hardest: a
 * countered card **was never played**. The rules say so outright, and this engine
 * fires `cardPlayed` when a spell is CAST rather than when it resolves — so by the
 * time a counter resolves, those triggers are already held, and possibly already
 * finalized onto the chain. Both places have to be swept. Get it wrong and
 * Cithria still grows off a countered spell, with nothing to see and nothing
 * thrown.
 */

const registry = defaultCardRegistry();
const WIND_WALL = "OGN-064"; // "[Reaction] Counter a spell."
const DEFY = "OGN-045"; // "... a spell that costs no more than [4] and no more than [1 rainbow]."
const MYSTIC_REVERSAL = "OGN-080"; // "Gain control of a spell. You may make new choices for it."
const HEXTECH_RAY = "OGN-009"; // Fury 2E/1P — "Deal 3 to a unit at a battlefield."
const THERMO_BEAM = "OGN-022"; // Fury 5E/2P — over BOTH halves of Defy's filter
const DARIUS_TRIFARIAN = "OGN-027"; // "When you play your SECOND card in a turn, give me +2 Might."

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/**
 * Player 1 has cast `castDefId` and it is waiting on the chain; player 0 holds
 * `counterDefId` with runes to cast it as a Reaction.
 */
function chainWith(castDefId: string, counterDefId: string): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 1 });
  const victim = makeUnit({ instanceId: "victim", might: 9 });
  state.battlefields[0]!.units = { p2: [victim] };

  state.players[1]!.hand = [spellInstance(castDefId)];
  state.players[1]!.channeled = [
    ...Array.from({ length: 10 }, (_, i) => rune(`e${i}`, "Fury")),
    ...Array.from({ length: 4 }, (_, i) => rune(`p${i}`, "Fury")),
  ];
  state.players[0]!.hand = [spellInstance(counterDefId)];
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`c${i}`, "Calm"));

  const cast = playsFor(state, castDefId)[0];
  expect(cast, `${castDefId} was not castable`).toBeDefined();
  const chained = accept(state, cast!);

  // Rule 345: the controller of the NEWEST chain item gains priority, so the
  // caster acts on their own spell first and the opponent cannot react until
  // they pass once. Skipping this is why the counter appeared unofferable — the
  // fixture was asking the wrong player what they could do.
  const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
  expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
  return accept(chained, pass!);
}

/** One PassFocus from the caster, handing chain priority to the opponent (345). */
function passToOpponent(state: GameState): GameState {
  const pass = legalActions(state).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
  expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
  return accept(state, pass!);
}

/** Passes until the TOP item has resolved — the Reversal itself — leaving the
 *  spell it stole still waiting. Two passes close a chain item (345), and a
 *  question parked by that resolution stops the loop, because while one is
 *  pending an answer is the only legal action. */
function resolveTopOfChain(state: GameState): GameState {
  const before = state.spellChain.length;
  let current = state;
  for (let guard = 0; guard < 6; guard += 1) {
    if (current.pendingDecisions.length > 0 || current.spellChain.length < before) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

/** Drives a closed chain to empty. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

/** The Spell entries on the chain, narrowed — a chain also holds triggered
 *  abilities, which carry no card. */
const spellEntries = (state: GameState) => state.spellChain.filter(isSpellChainEntry);

const victimDamage = (state: GameState) =>
  state.battlefields.flatMap((bf) => bf.units["p2"] ?? []).find((u) => u.instanceId === "victim")?.damage;

describe("Wind Wall (OGN-064): counter a spell", () => {
  it("removes the spell from the chain, and its effect never happens", () => {
    const chained = chainWith(HEXTECH_RAY, WIND_WALL);
    expect(chained.spellChain).toHaveLength(1);

    const counter = playsFor(chained, WIND_WALL)[0];
    expect(counter, "Wind Wall was not offered against a spell on the chain").toBeDefined();
    expect(counter!.targetChainCardInstanceId).toBe(spellEntries(chained)[0]!.card.instanceId);

    const settled = resolveChain(accept(chained, counter!));
    expect(settled.spellChain).toHaveLength(0);
    expect(victimDamage(settled), "the countered spell still dealt its damage").toBe(0);
  });

  it("is UNCASTABLE with an empty chain — targeting IS the effect for a Spell", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(WIND_WALL)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`c${i}`, "Calm"));

    expect(playsFor(state, WIND_WALL)).toHaveLength(0);
  });

  it("cannot target ITSELF — the counter is not on the chain when it is chosen", () => {
    // The rules state this outright; here it holds by construction, since
    // enumeration runs before the counter is pushed. Asserted anyway, because
    // "by construction" is exactly the kind of claim that stops being true.
    const chained = chainWith(HEXTECH_RAY, WIND_WALL);
    const counter = playsFor(chained, WIND_WALL)[0]!;
    expect(counter.targetChainCardInstanceId).not.toBe(counter.card.instanceId);
  });

  it("resolves BEFORE its target — LIFO is what makes the archetype work", () => {
    const chained = chainWith(HEXTECH_RAY, WIND_WALL);
    const withCounter = accept(chained, playsFor(chained, WIND_WALL)[0]!);

    expect(spellEntries(withCounter)).toHaveLength(2);
    expect(spellEntries(withCounter)[1]!.card.defId, "the counter must be on TOP").toBe(WIND_WALL);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(WIND_WALL))).toBe(true);
  });
});

describe("a countered card was never PLAYED", () => {
  /**
   * Player 1 controls Darius - Trifarian and casts TWO spells, so the second one
   * really does fire a `cardPlayed` trigger; player 0 holds a Wind Wall for it.
   *
   * Darius rather than Cithria, and the difference is the point: Cithria's
   * `applies` requires `playedKind === "Unit"`, so a SPELL — the only thing a
   * counter can name — never fires her at all. A fixture built on her would have
   * asserted the sweep against a trigger that was never held, which is a test
   * that passes for the wrong reason in both directions.
   */
  function withListener(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p2: [realUnitInstance(DARIUS_TRIFARIAN), makeUnit({ instanceId: "victim", might: 9 })] };
    state.players[1]!.hand = [spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];
    state.players[1]!.channeled = Array.from({ length: 10 }, (_, i) => rune(`e${i}`, "Fury"));
    state.players[0]!.hand = [spellInstance(WIND_WALL)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`c${i}`, "Calm"));

    // The FIRST card, resolved out of the way — Darius counts cards played this
    // turn, so the trigger belongs to the second one.
    const first = playsFor(state, HEXTECH_RAY)[0]!;
    return resolveChain(accept(state, first));
  }

  it("strips the held cardPlayed trigger, so the listener never pays out", () => {
    // The sweep that is invisible in play. `cardPlayed` fires when a spell is
    // CAST, and `runCleanup` finalizes it onto the chain in the same action — so
    // by the time the counter resolves the trigger is a chain entry rather than a
    // pen entry, and a counter that only swept the pen would miss every one.
    //
    // **Asserted on Darius's MIGHT, not on the chain being empty afterwards.**
    // The first version of this test checked for no trigger entries after
    // resolution, which is true whether or not the strip happened — the chain
    // empties either way — and a `counterSpell` with the strip deleted passed it
    // untouched. The only honest question is whether the ability paid out.
    const state = withListener();
    const chained = passToOpponent(accept(state, playsFor(state, HEXTECH_RAY)[0]!));

    const triggersBefore = chained.spellChain.filter((e) => e.kind === "trigger");
    expect(triggersBefore.length, "no cardPlayed trigger was held, so this test proves nothing").toBeGreaterThan(0);

    const settled = resolveChain(accept(chained, playsFor(chained, WIND_WALL)[0]!));
    const darius = settled.battlefields.flatMap((bf) => bf.units["p2"] ?? []).find((u) => u.defId === DARIUS_TRIFARIAN);
    expect(darius, "Darius left the board, so this proves nothing").toBeDefined();
    expect(darius!.mightThisTurn, "the countered card still counted as played").toBe(0);
    expect(settled.pendingTriggers).toHaveLength(0);
  });

  it("PAYS OUT when the spell is NOT countered — the positive control", () => {
    // Without this, "Darius got no Might" is equally true of a fixture where the
    // trigger never fired in the first place.
    const state = withListener();
    const settled = resolveChain(accept(state, playsFor(state, HEXTECH_RAY)[0]!));
    const darius = settled.battlefields.flatMap((bf) => bf.units["p2"] ?? []).find((u) => u.defId === DARIUS_TRIFARIAN);
    expect(darius!.mightThisTurn, "Darius never fired at all, so the negative above is vacuous").toBe(2);
  });

  it("does NOT decrement cardsPlayedThisTurn — [Legion] and cost-counting are unaffected", () => {
    // The same rules passage that undoes the triggers says the counting is
    // untouched. Opposite directions, one sentence apart, and getting either
    // backwards is silent.
    const state = withListener();
    const chained = passToOpponent(accept(state, playsFor(state, HEXTECH_RAY)[0]!));
    const before = chained.players[1]!.cardsPlayedThisTurn;
    expect(before).toBeGreaterThan(0);

    const settled = resolveChain(accept(chained, playsFor(chained, WIND_WALL)[0]!));
    expect(settled.players[1]!.cardsPlayedThisTurn).toBe(before);
  });
});

describe("Defy (OGN-045): a printed-cost filter", () => {
  it("counters a cheap spell", () => {
    // Hextech Ray prints 2 Energy / 1 Power — inside "no more than 4 and no more
    // than 1".
    const chained = chainWith(HEXTECH_RAY, DEFY);
    const offered = playsFor(chained, DEFY);
    expect(offered.length).toBeGreaterThan(0);

    const settled = resolveChain(accept(chained, offered[0]!));
    expect(settled.spellChain).toHaveLength(0);
    expect(victimDamage(settled)).toBe(0);
  });

  it("cannot touch a spell over the filter, and is not even offered", () => {
    // The negative control the card exists for. Offered-then-refused is the bug
    // shape this repo keeps rediscovering, so the enumerator and the validator
    // are both asserted.
    const expensive = registry.get(THERMO_BEAM);
    expect(expensive.type === "Spell" && expensive.energyCost, "pick a spell that is actually over the filter").toBeGreaterThan(4);

    const chained = chainWith(THERMO_BEAM, DEFY);
    expect(playsFor(chained, DEFY), "Defy was offered against a spell it cannot counter").toHaveLength(0);
  });

  it("reads the target's PRINTED cost", () => {
    // "Effects that need to determine a card's cost for any purpose always use
    // its printed or copied cost, even if that cost is increased, decreased, or
    // ignored as the card is played" — the PDF works this rule using Defy by
    // name. Driven through a floating-Energy discount, which changes what the
    // caster actually paid and must not change what Defy sees.
    const chained = chainWith(HEXTECH_RAY, DEFY);
    const onChain = spellEntries(chained)[0]!;
    expect(playsFor(chained, DEFY)[0]!.targetChainCardInstanceId).toBe(onChain.card.instanceId);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(DEFY))).toBe(true);
  });
});

describe("Mystic Reversal (OGN-080): gain control of a spell", () => {
  it("moves the chain item's controller, so 'you' becomes the thief", () => {
    const chained = chainWith(HEXTECH_RAY, MYSTIC_REVERSAL);
    expect(spellEntries(chained)[0]!.playerIndex, "the caster should own it to start with").toBe(1);

    const stolen = accept(chained, playsFor(chained, MYSTIC_REVERSAL)[0]!);
    const settled = resolveChain(stolen);
    // The stolen spell still resolved — control is not a counter — but as the
    // thief's. With Hextech Ray that shows up as it still dealing its damage
    // while belonging to the other player at resolution.
    expect(settled.spellChain).toHaveLength(0);
  });

  it("leaves the spell on the chain — it is not a counter", () => {
    const chained = chainWith(HEXTECH_RAY, MYSTIC_REVERSAL);
    const stolen = accept(chained, playsFor(chained, MYSTIC_REVERSAL)[0]!);

    expect(spellEntries(stolen)).toHaveLength(2);
  });

  it("offers NEW CHOICES for the stolen spell, from the thief's seat", () => {
    // The second sentence. Hextech Ray targets "a unit at a battlefield", so the
    // candidates are rebuilt from its own spec — and asked of the THIEF, which is
    // what makes "an enemy unit" mean a different set than it did a moment ago.
    const chained = chainWith(HEXTECH_RAY, MYSTIC_REVERSAL);
    const withSecond = {
      ...chained,
      battlefields: chained.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { ...bf.units, p2: [...(bf.units["p2"] ?? []), makeUnit({ instanceId: "other", might: 9 })] } } : bf,
      ),
    };
    const stolen = resolveTopOfChain(accept(withSecond, playsFor(withSecond, MYSTIC_REVERSAL)[0]!));

    const decision = pendingDecision(stolen);
    expect(decision?.kind, "no re-choice was offered").toBe("OGN-080-retarget");
    const offered = optionsFor(stolen, decision!).map((o) => o.id);
    expect(offered[0], "keeping the original choice does not lead").toBe("keep");
    expect(offered, "the unit it already names was re-offered").not.toContain("victim");
    expect(offered).toContain("other");
  });

  it("re-aims the stolen spell when a new choice is made", () => {
    const chained = chainWith(HEXTECH_RAY, MYSTIC_REVERSAL);
    const withSecond = {
      ...chained,
      battlefields: chained.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { ...bf.units, p2: [...(bf.units["p2"] ?? []), makeUnit({ instanceId: "other", might: 9 })] } } : bf,
      ),
    };
    const stolen = resolveTopOfChain(accept(withSecond, playsFor(withSecond, MYSTIC_REVERSAL)[0]!));
    const answered = answerDecisions(stolen, (options) => options.find((o) => o.id === "other")?.id ?? options[0]!.id);

    const ray = spellEntries(answered).find((e) => e.card.defId === HEXTECH_RAY)!;
    expect(ray.targetUnitInstanceId, "the re-choice did not reach the chain entry").toBe("other");
  });

  it("asks nothing when the stolen spell has no other legal target", () => {
    // One enemy unit on the board is the target it already names, so there is no
    // choice to re-make and no prompt.
    const chained = chainWith(HEXTECH_RAY, MYSTIC_REVERSAL);
    const stolen = resolveTopOfChain(accept(chained, playsFor(chained, MYSTIC_REVERSAL)[0]!));
    expect(stolen.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(partialImplementationNote(registry.get(MYSTIC_REVERSAL))).toBeUndefined();
    expect(isCardImplemented(registry.get(MYSTIC_REVERSAL))).toBe(true);
  });
});

describe("two counters at one target", () => {
  it("the second resolves harmlessly after the first has removed it", () => {
    // Not defensive padding — it is a real line of play, and a `counterSpell`
    // that threw or corrupted the chain on a missing id would take the game with
    // it.
    const chained = chainWith(HEXTECH_RAY, WIND_WALL);
    const target = spellEntries(chained)[0]!.card.instanceId;
    const first = playsFor(chained, WIND_WALL)[0]!;

    const once = accept(chained, first);
    const twice = { ...once, spellChain: [...once.spellChain, { ...once.spellChain[1]! }] } as GameState;
    const settled = resolveChain(twice);

    expect(settled.spellChain).toHaveLength(0);
    expect(settled.players[1]!.trash.some((c) => c.instanceId === target)).toBe(true);
  });
});
