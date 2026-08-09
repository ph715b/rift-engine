import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { holdUnitDied } from "../src/engine/triggers.js";
import { dealDamage, destroyUnit, recycleCardFromHand } from "../src/engine/effect-helpers.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/**
 * Wave 15 — the six cards that were blocked on questions the RULES do not
 * answer. Each is implemented on the most likely reading and recorded Unverified
 * in docs/rules-conformance.md; these tests pin the reading that was taken, so a
 * later answer changes a test rather than being discovered in play.
 */

const registry = defaultCardRegistry();
const NOXUS_SABOTEUR = "OGN-018"; // "Your opponents' [Hidden] cards can't be revealed here."
const TRYNDAMERE_BARBARIAN = "OGN-034"; // "...if you assigned 5 or more excess damage..."
const STEALTHY_PURSUER = "OGN-177"; // "When a friendly unit moves from my location, I may be moved with it."
const KAYN_UNLEASHED = "OGN-189"; // "If I have moved twice this turn, I don't take damage."
const KARMA_CHANNELER = "OGN-235"; // "When you recycle one or more cards ... buff a friendly unit."
const KARTHUS_ETERNAL = "OGN-236"; // "Your [Deathknell] effects trigger an additional time."
const WATCHFUL_SENTRY = "OGN-096"; // "[Deathknell] Draw 1" — the effect Karthus multiplies
const TEEMO_STRATEGIST = "OGN-121"; // a [Hidden] card to hide and try to play
const HEXTECH_RAY = "OGN-009";

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain, state });
const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

describe("Karthus - Eternal (OGN-236): Deathknells fire an additional time", () => {
  /** A Watchful Sentry about to die, with `karthusCount` Karthuses standing. */
  function karthusState(karthusCount: number, deckSize = 10): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = Array.from({ length: deckSize }, () => spellInstance(HEXTECH_RAY));
    state.players[0]!.baseUnits = Array.from({ length: karthusCount }, (_, i) => ({
      ...realUnitInstance(KARTHUS_ETERNAL),
      instanceId: `karthus-${i}`,
    }));
    return state;
  }

  // A [Deathknell] is a Chain Pending Item now, so this places it and settles.
  // The Karthus MULTIPLIER is captured when it is placed, which is what makes
  // "read at the moment of death" testable at all.
  const killSentry = (state: GameState) =>
    resolveHeldTriggers(holdUnitDied(state, { unit: realUnitInstance(WATCHFUL_SENTRY), ownerIndex: 0 }));

  it("fires ONCE with no Karthus — the control", () => {
    expect(killSentry(karthusState(0)).players[0]!.hand).toHaveLength(1);
  });

  it("fires TWICE with one Karthus", () => {
    expect(killSentry(karthusState(1)).players[0]!.hand).toHaveLength(2);
  });

  it("fires THREE times with two — 1 + 1 per instance, the [Repeat] model", () => {
    // The rules have no general clause for "an additional time"; [Repeat] is
    // their own model for the phrase and it is additive per instance, so two
    // Karthuses is 1 + 2 rather than 1 x 2 x 2. Settled in
    // docs/rules-calls-resolved.md §6 and pinned here.
    expect(killSentry(karthusState(2)).players[0]!.hand).toHaveLength(3);
  });

  it("does NOT multiply the OPPONENT's Deathknells", () => {
    // "YOUR Deathknell effects" is possessive of the effect, and an effect is
    // yours if you control its source — read at the moment of death.
    const state = karthusState(2);
    state.players[1]!.deck = Array.from({ length: 10 }, () => spellInstance(HEXTECH_RAY));
    const settled = resolveHeldTriggers(holdUnitDied(state, { unit: realUnitInstance(WATCHFUL_SENTRY), ownerIndex: 1 }));
    expect(settled.players[1]!.hand).toHaveLength(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KARTHUS_ETERNAL))).toBe(true);
  });
});

describe("Kayn - Unleashed (OGN-189): no damage after his second move", () => {
  function kaynState(moves: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [{ ...realUnitInstance(KAYN_UNLEASHED), instanceId: "kayn", movesThisTurn: moves }],
    };
    return state;
  }

  const kayn = (state: GameState) => state.battlefields[0]!.units["p1"]![0]!;

  it("takes spell damage after ONE move — the control", () => {
    const settled = dealDamage(kaynState(1), 1, "kayn", 3);
    expect(kayn(settled).damage).toBe(3);
  });

  it("takes NO spell damage after two", () => {
    const settled = dealDamage(kaynState(2), 1, "kayn", 3);
    expect(kayn(settled).damage).toBe(0);
  });

  it("takes no COMBAT damage either, and still absorbs the assignment", () => {
    // The reading recorded Unverified: 465.2's lethal-first assignment is
    // untouched, so Kayn is still assigned a full lethal allocation and the unit
    // behind him is shielded by damage that then lands on nobody.
    const state = kaynState(2);
    state.battlefields[0]!.units = {
      p1: [
        { ...realUnitInstance(KAYN_UNLEASHED), instanceId: "kayn", movesThisTurn: 2 },
        makeUnit({ instanceId: "friend", might: 3 }),
      ],
      p2: [makeUnit({ instanceId: "foe", might: 6 })],
    };

    const settled = resolveShowdown(state, "bf1", 1);
    const survivors = settled.battlefields[0]!.units["p1"] ?? [];
    expect(survivors.map((u) => u.instanceId), "Kayn died to damage he does not take").toContain("kayn");
    expect(survivors.map((u) => u.instanceId), "the unit behind him was not shielded").toContain("friend");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KAYN_UNLEASHED))).toBe(true);
  });
});

describe("Noxus Saboteur (OGN-018): no playing from Hidden here", () => {
  /** An opponent's playable facedown card at bf1, with a Saboteur optionally
   *  standing there. */
  function saboteurState(withSaboteur: boolean): GameState {
    const state = makeState({ phase: "Action", turnNumber: 3 });
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`m${i}`, "Mind"));
    state.battlefields[0]!.hiddenCards = [
      { ownerIndex: 0, card: spellInstance(TEEMO_STRATEGIST), hiddenOnTurn: 1 },
    ];
    if (withSaboteur) {
      state.battlefields[0]!.units = { p2: [{ ...realUnitInstance(NOXUS_SABOTEUR), instanceId: "saboteur" }] };
    }
    return state;
  }

  const hiddenPlays = (state: GameState) =>
    legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);

  it("the facedown card IS playable with no Saboteur — the control", () => {
    expect(hiddenPlays(saboteurState(false)).length).toBeGreaterThan(0);
  });

  it("is not offered while an enemy Saboteur stands there", () => {
    expect(hiddenPlays(saboteurState(true))).toHaveLength(0);
  });

  it("REFUSES a hand-built play from that battlefield", () => {
    // Enumerator and validator ask the same function, so the block cannot be
    // routed around by an action built by hand.
    const play = hiddenPlays(saboteurState(false))[0]!;
    expect(validatePlayCard(saboteurState(true), play)).toMatchObject({ ok: false });
  });

  it("blocks only where he STANDS — a Saboteur at base blocks nothing", () => {
    const state = saboteurState(false);
    state.players[1]!.baseUnits = [{ ...realUnitInstance(NOXUS_SABOTEUR), instanceId: "saboteur" }];
    expect(hiddenPlays(state).length, "'here' reached off his battlefield").toBeGreaterThan(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(NOXUS_SABOTEUR))).toBe(true);
  });
});

describe("Tryndamere - Barbarian (OGN-034): a point for 5 excess damage", () => {
  /** Tryndamere attacking into one defender of `defenderMight`. */
  function tryndamereState(defenderMight: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [{ ...realUnitInstance(TRYNDAMERE_BARBARIAN), instanceId: "trynd" }],
      p2: [makeUnit({ instanceId: "foe", might: defenderMight })],
    };
    state.battlefields[0]!.controllerId = "p2";
    return state;
  }

  /** Fights, then settles the held conquer trigger the fight raised. */
  const fight = (state: GameState) => resolveHeldTriggers(resolveShowdown(state, "bf1", 0));

  it("scores the point when the overkill reaches 5", () => {
    // Tryndamere is an 8-Might body; a 3-Might defender needs 3, so 5 is spent
    // beyond what the kill took.
    const settled = fight(tryndamereState(3));
    expect(settled.players[0]!.points, "conquest 1 + Tryndamere 1").toBe(2);
  });

  it("does NOT score it at 4 excess — the threshold is real", () => {
    const settled = fight(tryndamereState(4));
    expect(settled.players[0]!.points).toBe(1);
  });

  it("does not score for a conquest that was not an attack", () => {
    // Walking into an empty battlefield conquers without a fight, so nothing
    // ever assigned any damage — "after an attack" is what stops it paying out.
    const state = tryndamereState(3);
    state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(TRYNDAMERE_BARBARIAN), instanceId: "trynd" }] };
    const settled = fight(state);
    expect(settled.players[0]!.points).toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(TRYNDAMERE_BARBARIAN))).toBe(true);
  });
});

describe("Stealthy Pursuer (OGN-177): following a friendly unit out", () => {
  /** The Pursuer at bf1 with a companion who has just left for bf2. */
  function pursuerState(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(STEALTHY_PURSUER), instanceId: "pursuer" }] };
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "mover", might: 3 })] };
    return state;
  }

  /** The `unitMoved` event a walk from bf1 to bf2 raises, held as a Pending Item. */
  const moved = (state: GameState, moverIndex: 0 | 1 = 0, from = "bf1", to = "bf2") =>
    resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", moverIndex, unitInstanceId: "mover", from, to, movesThisTurn: 1 }),
    );

  const at = (state: GameState, bf: string) => (state.battlefields.find((b) => b.id === bf)!.units["p1"] ?? []).map((u) => u.instanceId);

  it("asks when a friendly unit leaves his battlefield", () => {
    expect(pendingDecision(moved(pursuerState()))?.kind).toBe("OGN-177-follow");
  });

  it("moves him to the destination when he follows", () => {
    const settled = answerDecisions(moved(pursuerState()), choose("follow"));
    expect(at(settled, "bf1"), "he did not leave").toEqual([]);
    expect(at(settled, "bf2")).toContain("pursuer");
  });

  it("leaves him where he is when he stays", () => {
    const settled = answerDecisions(moved(pursuerState()), choose("stay"));
    expect(at(settled, "bf1")).toEqual(["pursuer"]);
  });

  it("does NOT ask for an ENEMY unit's move", () => {
    expect(moved(pursuerState(), 1).pendingDecisions).toHaveLength(0);
  });

  it("does NOT ask for a move that started somewhere else", () => {
    // "From MY location" — a friendly unit walking bf2 -> bf3 is not his cue.
    expect(moved(pursuerState(), 0, "bf2", "bf3").pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(STEALTHY_PURSUER))).toBe(true);
  });
});

describe("Karma - Channeler (OGN-235): a buff for every recycle", () => {
  function karmaState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [
      { ...realUnitInstance(KARMA_CHANNELER), instanceId: "karma" },
      makeUnit({ instanceId: "friend", might: 3 }),
    ];
    state.players[0]!.hand = [spellInstance(HEXTECH_RAY)];
    return state;
  }

  it("buffs a friendly unit when a card is recycled to her controller's deck", () => {
    const state = karmaState();
    const recycled = resolveHeldTriggers(recycleCardFromHand(state, 0, state.players[0]!.hand[0]!.instanceId));
    const settled = answerDecisions(recycled, choose("friend"));

    expect(settled.players[0]!.baseUnits.find((u) => u.instanceId === "friend")!.buffed).toBe(true);
  });

  it("does NOT fire for a recycle into the OPPONENT's deck", () => {
    // "to YOUR Main Deck" — the deck that received the cards, which is the
    // reading this engine takes for an ambiguity the rules leave open.
    const state = karmaState();
    state.players[1]!.hand = [spellInstance(HEXTECH_RAY)];
    const recycled = resolveHeldTriggers(recycleCardFromHand(state, 1, state.players[1]!.hand[0]!.instanceId));
    expect(recycled.pendingDecisions).toHaveLength(0);
  });

  it("asks nothing when she has no friendly unit to buff (055)", () => {
    const state = karmaState();
    // Karma herself is a friendly unit, so she has to go too for this to be the
    // no-targets case — killed rather than removed, through the real funnel.
    const empty = destroyUnit(destroyUnit(state, "friend"), "karma");
    const recycled = resolveHeldTriggers(recycleCardFromHand(empty, 0, empty.players[0]!.hand[0]!.instanceId));
    expect(recycled.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KARMA_CHANNELER))).toBe(true);
  });
});
