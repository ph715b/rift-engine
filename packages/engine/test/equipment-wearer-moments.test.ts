import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { wearerListener, wearerOf } from "../src/engine/equipment.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, realGearInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The wearer's moments — eight Equipment whose ability fires on the moment of
 * the UNIT WEARING THEM, not their own.
 *
 * # Why these eight were the highest-value thing left
 *
 * Their abilities exist ONLY on the card art. For every one, `text.plain` holds
 * the `[Equip]` line and nothing else, so `needsImplementation` saw a keyword
 * line, the generated equip ability was registered, and **all eight reported
 * `isCardImplemented = true` while doing none of what they print.** Not invisible
 * to the instrument — actively misreported by it. That is the direction
 * `PARTIALLY_IMPLEMENTED`'s own doc comment calls the worse one to err in.
 *
 * # The mechanism, which is one function
 *
 * `listeningPermanents` ALREADY walks every piece of active Gear as a listener.
 * What a gear listener lacks is a location — `activeGear` is a flat list with no
 * battlefield — so a "when I conquer" written against `listener.battlefieldId`
 * could never match, and `isFightingAt` rejects it outright for not being a Unit.
 *
 * `wearerListener` hands the card the listener its WEARER would have had. Every
 * existing predicate then works unchanged. Nothing about the walk changed, so
 * Mask of Foresight — a gear listener that is deliberately NOT a combatant —
 * is untouched.
 *
 * The load-bearing negative is `unattached does nothing`: a Recurve Bow sitting
 * in base watches no combats, and that is what separates "the mechanism works"
 * from "gear fires on everything its owner does".
 */
const registry = defaultCardRegistry();

const RECURVE_BOW = "SFD-016"; // when I attack or defend, deal 2 to an enemy unit here
const WORLD_ATLAS = "SFD-086"; // when I hold, play two Gold gear tokens exhausted
const WARMOGS = "SFD-108"; // when I conquer, buff me
const TRINITY_FORCE = "SFD-115"; // when I hold, score 1 point
const BONESHIVER = "SFD-118"; // when I conquer, channel 1 rune exhausted
const DORANS_RING = "SFD-124"; // when I conquer, discard 1, then draw 1
const CULL = "SFD-134"; // when I conquer, play a Gold gear token exhausted
const EYE_OF_THE_HERALD = "SFD-153"; // when I move, play a 1 Might Recruit token here

const WEARERS_MOMENTS = [RECURVE_BOW, WORLD_ATLAS, WARMOGS, TRINITY_FORCE, BONESHIVER, DORANS_RING, CULL, EYE_OF_THE_HERALD];
/**
 * The art-only Equipment still unwritten.
 *
 * **Guardian Angel (SFD-051) left first**, taking this from six to five: its art
 * half is a free, MANDATORY death replacement sourced from a GEAR, written beside
 * Zhonya's Hourglass in death-ward.ts.
 *
 * **Last Rites (SFD-150) and Brutalizer (SFD-042) left on 2026-08-07**, under the
 * decision to finish SFD rather than stop at 193/198. Brutalizer is the one worth
 * a note here, because the reason it sat on the do-not-do list for two sessions
 * was a MIS-PRICING rather than a subsystem: the standing note called for "a
 * per-attachment turn stamp", and `equipment.ts` is the declared single writer of
 * `attachedToInstanceId`, so the stamp is one flag at one site. Re-reading the
 * code beat believing the note, which is now six for six in this repo.
 *
 * This list shrinks as each lands; it is not a fixed set.
 */
const STILL_ART_ONLY = ["SFD-030", "SFD-059", "SFD-073", "SFD-090"];
/** Sacred Shears — art-only like the six above, and written now, but NOT by the
 *  wearer's-moments mechanism. See its own describe block at the bottom. */
const SACRED_SHEARS = "SFD-172";

/** p1's unit at `bfId`, wearing `defId`. Attached by writing the link directly
 *  rather than through `attachEquipment`, so no test here depends on being able
 *  to PAY an `[Equip]` cost — that is a different subsystem with its own file. */
function worn(defId: string, opts: { bfId?: string; attached?: boolean } = {}): GameState {
  const { bfId = "bf1", attached = true } = opts;
  const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
  const wearer = makeUnit({ instanceId: "wearer", name: "Wearer" });
  state.battlefields.find((b) => b.id === bfId)!.units = { p1: [wearer] };
  const gear = realGearInstance(defId);
  state.players[0]!.activeGear = [{ ...gear, attachedToInstanceId: attached ? "wearer" : null }];
  return state;
}

const goldTokens = (state: GameState, index: 0 | 1) =>
  state.players[index]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);
const wearerUnit = (state: GameState) =>
  state.battlefields.flatMap((b) => b.units["p1"] ?? []).find((u) => u.instanceId === "wearer");

describe("the mechanism: an attached Equipment listens as its wearer", () => {
  it("finds the wearer and its battlefield", () => {
    const state = worn(CULL);
    const found = wearerOf(state, state.players[0]!.activeGear[0]!);
    expect(found?.unit.instanceId).toBe("wearer");
    expect(found?.ownerIndex).toBe(0);
    expect(found?.battlefieldId, "the wearer's location did not come through").toBe("bf1");
  });

  it("rewrites the listener as a UNIT at the wearer's battlefield", () => {
    // The two facts every one of the eight depends on: the card is a Unit (which
    // is what `isFightingAt` demands and a raw gear listener can never satisfy),
    // and the battlefieldId is the wearer's.
    const state = worn(CULL);
    const listener = { card: state.players[0]!.activeGear[0]!, ownerIndex: 0 as const, zone: "board" as const };
    const rewritten = wearerListener(state, listener);
    expect(rewritten?.card.kind).toBe("Unit");
    expect(rewritten?.battlefieldId).toBe("bf1");
  });

  it("is undefined for UNATTACHED gear — the load-bearing negative", () => {
    const state = worn(CULL, { attached: false });
    const listener = { card: state.players[0]!.activeGear[0]!, ownerIndex: 0 as const, zone: "board" as const };
    expect(wearerListener(state, listener)).toBeUndefined();
    // And through the real path: an unattached Cull pays nothing on a conquest.
    expect(goldTokens(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toHaveLength(0);
  });
});

describe("the four conquer Equipment", () => {
  it("Cull plays one exhausted Gold token", () => {
    const after = resolveHeldTriggers(recordConquest(worn(CULL), 0, "bf1"));
    const gold = goldTokens(after, 0);
    expect(gold, "Cull's conquer trigger produced no Gold token").toHaveLength(1);
    expect(gold[0]!.exhausted, "the card prints 'exhausted'").toBe(true);
  });

  it("Cull is POSITIONAL — its wearer must be at the battlefield taken", () => {
    // "When I conquer" is about where the wearer stands, which is exactly the
    // fact a gear listener could not express before.
    const after = resolveHeldTriggers(recordConquest(worn(CULL, { bfId: "bf2" }), 0, "bf1"));
    expect(goldTokens(after, 0), "it fired for a battlefield its wearer was not at").toHaveLength(0);
  });

  it("Cull does not fire when the OPPONENT conquers", () => {
    const after = resolveHeldTriggers(recordConquest(worn(CULL), 1, "bf1"));
    expect(goldTokens(after, 0)).toHaveLength(0);
    expect(goldTokens(after, 1)).toHaveLength(0);
  });

  it("Warmog's Armor buffs the WEARER, not the gear", () => {
    const after = resolveHeldTriggers(recordConquest(worn(WARMOGS), 0, "bf1"));
    expect(wearerUnit(after)?.buffed, "the wearer was not buffed").toBe(true);
    // The control: no conquest, no buff.
    expect(wearerUnit(worn(WARMOGS))?.buffed).toBe(false);
  });

  it("Boneshiver channels one rune EXHAUSTED", () => {
    const before = worn(BONESHIVER);
    // `makePlayer` builds an EMPTY rune deck, and `channelRunesExhausted` draws
    // from it — without this the test measures 0 whether the card works or not.
    before.players[0]!.runeDeck = [{ id: "r1", domain: "Body", state: "Ready" }];
    const after = resolveHeldTriggers(recordConquest(before, 0, "bf1"));
    const gained = after.players[0]!.channeled.length - before.players[0]!.channeled.length;
    expect(gained, "no rune was channeled").toBe(1);
    // The printed word. A Ready rune would be Power available this turn, which is
    // the whole difference and the reason `channelRunesExhausted` exists.
    expect(after.players[0]!.channeled.at(-1)!.state, "the rune came in Ready").toBe("Exhausted");
  });

  it("Doran's Ring discards THEN draws, in that order", () => {
    const state = worn(DORANS_RING);
    state.players[0]!.hand = [spellInstance("OGN-009"), spellInstance("OGN-022")];
    state.players[0]!.deck = [spellInstance("OGN-045")];
    const after = resolveHeldTriggers(recordConquest(state, 0, "bf1"));

    // Two in hand, so the discard is a real choice and stops to ask. That IS the
    // ordering proof: if the draw had run first the drawn card would be among the
    // options, and the hand would already be three.
    const question = pendingDecision(after);
    expect(question, "the discard did not stop to ask").toBeDefined();
    expect(optionsFor(after, question!), "the drawn card joined the hand being chosen from").toHaveLength(2);
  });
});

describe("the two hold Equipment", () => {
  it("World Atlas plays TWO exhausted Gold tokens", () => {
    const after = resolveHeldTriggers(scoreHolds(worn(WORLD_ATLAS), 0));
    const gold = goldTokens(after, 0);
    expect(gold, "two tokens are two game objects").toHaveLength(2);
    expect(gold.every((g) => g.exhausted)).toBe(true);
  });

  it("Trinity Force scores a point ON TOP of the hold's own", () => {
    // Measured as a DELTA against a control board, because holding a battlefield
    // already scores 1 — asserting an absolute would pass on the hold alone.
    const withGear = resolveHeldTriggers(scoreHolds(worn(TRINITY_FORCE), 0));
    const control = resolveHeldTriggers(scoreHolds(worn(CULL), 0));
    expect(control.players[0]!.points, "the control board did not score its hold").toBe(1);
    expect(withGear.players[0]!.points, "Trinity Force added no point").toBe(2);
  });
});

describe("the two per-unit-moment Equipment", () => {
  it("Eye of the Herald plays a Recruit where its wearer ARRIVED", () => {
    // "Here" is the destination, taken off the event rather than off the
    // listener — by resolution the wearer is already at `to`, so a re-derived
    // location would be right only by luck.
    const state = worn(EYE_OF_THE_HERALD, { bfId: "bf2" });
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "wearer", moverIndex: 0, from: "base", to: "bf2", movesThisTurn: 1 }),
    );
    const recruits = (after.battlefields.find((b) => b.id === "bf2")!.units["p1"] ?? []).filter((u) => u.isToken);
    expect(recruits, "no Recruit token arrived").toHaveLength(1);
    expect(recruits[0]!.might).toBe(1);
  });

  it("Eye of the Herald ignores ANOTHER unit's move", () => {
    const state = worn(EYE_OF_THE_HERALD);
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "somebody-else", moverIndex: 0, from: "base", to: "bf1", movesThisTurn: 1 }),
    );
    expect((after.battlefields.find((b) => b.id === "bf1")!.units["p1"] ?? []).filter((u) => u.isToken)).toHaveLength(0);
  });

  it("Recurve Bow asks which enemy unit to shoot when its wearer fights", () => {
    const state = worn(RECURVE_BOW);
    const bf = state.battlefields.find((b) => b.id === "bf1")!;
    bf.units = { ...bf.units, p2: [makeUnit({ instanceId: "enemy-a" }), makeUnit({ instanceId: "enemy-b" })] };
    bf.contestedByIndex = 0; // the wearer's side attacks

    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: ["wearer"] }),
    );
    const question = pendingDecision(after);
    expect(question, "the bow did not fire on its wearer's attack").toBeDefined();
    expect(optionsFor(after, question!).map((o) => o.instanceId)).toEqual(["enemy-a", "enemy-b"]);
  });

  it("Recurve Bow does nothing when its wearer is not in the fight", () => {
    // Not designated, so `isFightingAt` says no — the same predicate a unit uses.
    const state = worn(RECURVE_BOW);
    const bf = state.battlefields.find((b) => b.id === "bf1")!;
    bf.units = { ...bf.units, p2: [makeUnit({ instanceId: "enemy-a" })] };
    bf.contestedByIndex = 0;
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: ["somebody-else"] }),
    );
    expect(pendingDecision(after), "it fired for a combat its wearer was not designated in").toBeUndefined();
  });
});

describe("coverage now tells the truth about art-only Equipment", () => {
  it("reports all eight as implemented, with no partial note", () => {
    for (const id of WEARERS_MOMENTS) {
      expect(isCardImplemented(registry.get(id)), `${id} is not reported implemented`).toBe(true);
      expect(partialImplementationNote(registry.get(id)), `${id} still carries a partial note`).toBeUndefined();
    }
  });

  it("reports the still-unwritten ones as NOT implemented", () => {
    // The instrument fix, and the half that would silently rot: each of these
    // reported `true` before 2026-08-06 purely because its `[Equip]` cost is
    // registered, while its whole printed ability does nothing.
    for (const id of STILL_ART_ONLY) {
      expect(isCardImplemented(registry.get(id)), `${id} still reports implemented`).toBe(false);
      expect(partialImplementationNote(registry.get(id)), `${id} has no note saying what is missing`).toMatch(/art-only/);
    }
  });

  it("and Sacred Shears has left that list", () => {
    expect(isCardImplemented(registry.get(SACRED_SHEARS))).toBe(true);
    expect(partialImplementationNote(registry.get(SACRED_SHEARS)), "a note outlived its clause").toBeUndefined();
  });
});

/**
 * Sacred Shears (SFD-172) — `[Deathknell]` — Draw 1. Art-only, transcribed in
 * docs/sfd-equipment-abilities.md.
 *
 * **Not a `[Deathknell]` in this engine, and that is the card rather than a
 * shortcut.** 808's Deathknell is "when I die", keyed by the DYING card's defId
 * — and the gear does not die. Its wearer does, and the gear SURVIVES, which
 * `killUnit`'s detach makes explicit and which two other SFD cards presuppose by
 * name. So it is a death-watch, and its condition is "that death was mine".
 *
 * The blocker was never the trigger: it was that `killUnit` DETACHES FIRST,
 * before any ward or replacement, so by the time the death fires nothing can say
 * what the unit was wearing. `PendingDeath.wornEquipment` captures it at the
 * moment of death, the same 809.1.b.3 reasoning that captures the unit itself.
 */
describe("Sacred Shears draws when its WEARER dies", () => {
  /** Resolves whatever the death put on the chain. */
  const settle = (state: GameState) => resolveHeldTriggers(state);

  function wearing(attached = true): GameState {
    const state = worn(SACRED_SHEARS, { attached });
    state.players[0]!.deck = [realGearInstance(RECURVE_BOW), realGearInstance(RECURVE_BOW)];
    return state;
  }

  const hand = (state: GameState) => state.players[0]!.hand.length;

  it("draws 1 when the unit it is attached to dies", () => {
    const state = wearing();
    const before = hand(state);
    const after = settle(destroyUnit(state, "wearer"));

    expect(hand(after), "the Shears did not draw").toBe(before + 1);
  });

  /** The gear SURVIVES its wearer — the detach is the printed behaviour. */
  it("survives the death, detached", () => {
    const after = settle(destroyUnit(wearing(), "wearer"));

    expect(after.players[0]!.activeGear, "the Shears died with its wearer").toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBeNull();
  });

  /** An UNATTACHED Shears is worn by nobody, so no death is its own. */
  it("does NOT draw while unattached", () => {
    const state = wearing(false);
    const loose = makeUnit({ instanceId: "loose", name: "Loose" });
    state.battlefields.find((b) => b.id === "bf1")!.units = { p1: [loose] };
    const before = hand(state);

    expect(hand(settle(destroyUnit(state, "loose"))), "an unattached Shears drew").toBe(before);
  });

  /**
   * **The distinction the whole card rests on**: it fires for ITS wearer, not
   * for any death. A second unit dying beside the wearer is not its moment.
   */
  it("does NOT draw when a DIFFERENT unit dies", () => {
    const state = wearing();
    const bystander = makeUnit({ instanceId: "bystander", name: "Bystander" });
    const bf = state.battlefields.find((b) => b.id === "bf1")!;
    bf.units = { ...bf.units, p1: [...(bf.units.p1 ?? []), bystander] };
    const before = hand(state);

    expect(hand(settle(destroyUnit(state, "bystander"))), "it drew for somebody else's death").toBe(before);
  });

  /**
   * TWO Shears on TWO units draw once each, for their own wearer — which is why
   * `wornEquipment` is compared by INSTANCE. A defId comparison would make both
   * fire on either death.
   */
  it("two Shears on two wearers each answer only for their own", () => {
    const state = wearing();
    const second = makeUnit({ instanceId: "second", name: "Second" });
    const bf = state.battlefields.find((b) => b.id === "bf1")!;
    bf.units = { ...bf.units, p1: [...(bf.units.p1 ?? []), second] };
    const otherShears = realGearInstance(SACRED_SHEARS);
    state.players[0]!.activeGear = [
      ...state.players[0]!.activeGear,
      { ...otherShears, attachedToInstanceId: "second" },
    ];
    state.players[0]!.deck = Array.from({ length: 4 }, () => realGearInstance(RECURVE_BOW));
    const before = hand(state);

    // One death, one draw — not two.
    expect(hand(settle(destroyUnit(state, "wearer"))), "both Shears fired on one death").toBe(before + 1);
  });
});
