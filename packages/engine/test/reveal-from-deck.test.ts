import { describe, expect, it } from "vitest";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { revealedFromDeck, UNDERTITAN } from "../src/engine/top-of-deck.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * REVEALING a card from a deck, as opposed to LOOKING at one.
 *
 * # Why the two are different funnels
 *
 * Nocturne - Horrifying triggers on "as you look at **or reveal** me", so one
 * funnel served him. Undertitan (SFD-175) prints "**as I'm revealed** from your
 * deck, [Add] [2] Energy" — reveal only. Six cards in this pool LOOK without
 * revealing (Reinforce, Stacked Deck, Called Shot, Baited Hook, Ornn -
 * Blacksmith, and the both-players look), and paying Undertitan out on those
 * would be wrong on six cards rather than right on one.
 *
 * So `offerTopOfDeckBanish` stays the LOOK funnel and `revealedFromDeck` is the
 * REVEAL one, which calls it. The distinction is what this file pins.
 *
 * # The survey, which found two pre-existing bugs
 *
 * Every reveal site in the engine was enumerated before any of this was written,
 * because a replaced step that misses a site is silent. There are five:
 *
 *   - Dazzling Aurora (`effects/body.ts`) — "reveal until you reveal a unit"
 *   - Apprentice Smith (`effects/calm.ts`) — "reveal the top card"
 *   - Bilgewater Dredger (`effects/mind.ts`) — "reveal the top 5"
 *   - **Blind Fury (OGN-025)** — "each opponent reveals the top card"
 *   - **Ravenbloom Conservatory** — "when you defend here, reveal the top card"
 *
 * The last two called NO funnel at all, so Nocturne has been missing both since
 * he was written. That is a pre-existing bug found by the survey rather than
 * anything Undertitan introduced, and both are now wired and covered below.
 */

const registry = defaultCardRegistry();
const NOCTURNE_HORRIFYING = "OGN-194";
const HEXTECH_RAY = "OGN-009";
const RAVENBLOOM_CONSERVATORY = "SFD-215";
const UNDERTITAN_ENERGY = 2;

/** Every question a state asks, in order, answering each with its first option.
 *  A single-option question auto-resolves and is therefore invisible to
 *  `pendingDecision` (trap 7), so a test asking "was this offered at all" has to
 *  walk the queue rather than peek at its head. */
function askedKindsOf(state: GameState): string[] {
  const kinds: string[] = [];
  let current = state;
  for (let guard = 0; guard < 40; guard += 1) {
    const decision = pendingDecision(current);
    if (!decision) return kinds;
    kinds.push(decision.kind);
    const answered = answerDecision(current, decision.id, optionsFor(current, decision)[0]!.id);
    if (!answered) throw new Error(`askedKindsOf: refused for ${decision.kind}`);
    current = answered;
  }
  throw new Error("askedKindsOf: the questions never ran out");
}

/** Resolves a spell straight out of its caster's hand, the way a popped chain
 *  entry would. */
function castSpell(state: GameState, defId: string, playerIndex: 0 | 1 = 0): GameState {
  const entry: SpellChainEntry = {
    card: spellInstance(defId),
    playerIndex,
    payment: { energyRunes: [], powerRunes: [] },
  } as SpellChainEntry;
  return resolveCardEffect(state, entry);
}

describe("Undertitan (SFD-175): as I'm revealed from your deck, [Add] 2 Energy", () => {
  it("pays the deck's owner when he is among the revealed cards", () => {
    const state = makeState({ phase: "Action" });
    const before = state.players[0]!.floatingEnergy;

    const after = revealedFromDeck(state, 0, [realUnitInstance(UNDERTITAN)]);

    expect(after.players[0]!.floatingEnergy - before, "the [Add] never happened").toBe(UNDERTITAN_ENERGY);
  });

  /** "As **I'm** revealed" is per copy, not per reveal. */
  it("pays twice for two copies turned over together", () => {
    const state = makeState({ phase: "Action" });
    const after = revealedFromDeck(state, 0, [
      { ...realUnitInstance(UNDERTITAN), instanceId: "t1" },
      { ...realUnitInstance(UNDERTITAN), instanceId: "t2" },
    ]);
    expect(after.players[0]!.floatingEnergy, "the second copy was ignored").toBe(2 * UNDERTITAN_ENERGY);
  });

  it("pays nobody when he is not among them", () => {
    const state = makeState({ phase: "Action" });
    const after = revealedFromDeck(state, 0, [spellInstance(HEXTECH_RAY)]);
    expect(after.players[0]!.floatingEnergy, "energy appeared from nowhere").toBe(0);
  });

  /** **The load-bearing negative.** "From YOUR deck" is written from the card's
   *  own point of view, so the Energy is owed to whoever's deck it came off —
   *  which is not always who caused the reveal (Blind Fury turns over the
   *  OPPONENT's deck). */
  it("pays the DECK'S OWNER, not the player who caused the reveal", () => {
    const state = makeState({ phase: "Action" });
    const after = revealedFromDeck(state, 1, [realUnitInstance(UNDERTITAN)]);

    expect(after.players[1]!.floatingEnergy, "the deck's owner was not paid").toBe(UNDERTITAN_ENERGY);
    expect(after.players[0]!.floatingEnergy, "the wrong player was paid").toBe(0);
  });

  /** A LOOK is not a reveal. This is the whole reason there are two funnels, and
   *  it is asserted at the six looking cards' shared funnel rather than argued. */
  it("is NOT paid by a mere look", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = [realUnitInstance(UNDERTITAN), spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];

    // Stacked Deck LOOKS at the top 3 — it reveals nothing.
    const after = castSpell(state, "OGN-183");
    expect(after.players[0]!.floatingEnergy, "a look paid a reveal-only clause").toBe(0);
  });

  it("is claimed by a module and carries no partial note", () => {
    expect(isCardImplemented(registry.get(UNDERTITAN)), "SFD-175 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(UNDERTITAN)), "the note outlived its clause").toBeUndefined();
  });
});

describe("the two reveal sites that called no funnel at all", () => {
  /**
   * **Blind Fury cannot be probed with Nocturne, and the reason is trap 7.**
   *
   * The card banishes and PLAYS the very card it reveals, so a revealed Nocturne
   * is already in play by the time his own offer is raised. His options collapse
   * to a lone "decline", `advanceDecisions` answers a one-option question without
   * asking, and `pendingDecision` comes back `undefined` — which reads exactly
   * like "the funnel was never called". Dazzling Aurora's own comment records the
   * same interaction for the same reason.
   *
   * So Undertitan is the probe here: his payout happens whatever became of the
   * card, and it is asserted on the DECK'S OWNER, which is the half of this that
   * could plausibly have been wired to the wrong player.
   */
  it("Blind Fury (OGN-025) now reaches the funnel — it never did before", () => {
    const state = makeState({ phase: "Action" });
    state.players[1]!.deck = [realUnitInstance(UNDERTITAN), spellInstance(HEXTECH_RAY)];

    const after = castSpell(state, "OGN-025", 0);

    expect(after.players[1]!.floatingEnergy, "the reveal still calls no funnel").toBe(UNDERTITAN_ENERGY);
    expect(after.players[0]!.floatingEnergy, "the caster was paid instead of the deck's owner").toBe(0);
  });

  /** Ravenbloom Conservatory keeps the card (to hand, or recycled), so nothing
   *  consumes it and Nocturne's offer IS observable here — which makes this the
   *  site that pins the funnel call itself rather than only its payout. */
  it("Ravenbloom Conservatory (SFD-215) now reaches the funnel — it never did before", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: RAVENBLOOM_CONSERVATORY,
      controllerId: "p1",
      units: { p1: [makeUnit({ name: "Defender" })], p2: [makeUnit({ name: "Attacker" })] },
    };
    // A non-spell on top, so the battlefield recycles it rather than drawing it
    // — and the card stays in the deck for Nocturne's offer to name.
    state.players[0]!.deck = [realUnitInstance(NOCTURNE_HORRIFYING), spellInstance(HEXTECH_RAY)];
    state.players[0]!.channeled = [{ id: "r0", domain: "Chaos", state: "Ready" }];

    const opened = beginCombatAt(state, "bf1", 1);

    expect(
      askedKindsOf(opened),
      "the reveal still calls no funnel — Nocturne was never offered",
    ).toContain("OGN-194-banish");
  });

  it("Ravenbloom pays an Undertitan it reveals", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: RAVENBLOOM_CONSERVATORY,
      controllerId: "p1",
      units: { p1: [makeUnit({ name: "Defender" })], p2: [makeUnit({ name: "Attacker" })] },
    };
    state.players[0]!.deck = [realUnitInstance(UNDERTITAN), spellInstance(HEXTECH_RAY)];

    const opened = beginCombatAt(state, "bf1", 1);

    expect(opened.players[0]!.floatingEnergy, "the defender was not paid").toBe(UNDERTITAN_ENERGY);
  });
});
