import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { COMPLETE_SETS, isCardImplemented, partialImplementationNote, setCodeOf } from "../src/engine/coverage.js";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { wearerListener, wearerOf } from "../src/engine/equipment.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import {
  answerDecisions,
  makePlayer,
  makeState,
  makeUnit,
  pickCard,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

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
/** Not a wearer's-moment card — borrowed below as the other question raised by the
 *  same `combatBegan`, whose answer can move the Bow's wearer. */
const OVERZEALOUS_FAN = "SFD-128";

const WEARERS_MOMENTS = [RECURVE_BOW, WORLD_ATLAS, WARMOGS, TRINITY_FORCE, BONESHIVER, DORANS_RING, CULL, EYE_OF_THE_HERALD];
/**
 * The art-only Equipment still unwritten.
 *
 * **Guardian Angel (SFD-051) left first**, taking this from six to five: its art
 * half is a free, MANDATORY death replacement sourced from a GEAR, written beside
 * Zhonya's Hourglass in death-ward.ts.
 *
 * **Last Rites (SFD-150), Brutalizer (SFD-042) and Experimental Hexplate
 * (SFD-073) left on 2026-08-07**, under the
 * decision to finish SFD rather than stop at 193/198. Brutalizer is the one worth
 * a note here, because the reason it sat on the do-not-do list for two sessions
 * was a MIS-PRICING rather than a subsystem: the standing note called for "a
 * per-attachment turn stamp", and `equipment.ts` is the declared single writer of
 * `attachedToInstanceId`, so the stamp is one flag at one site. Re-reading the
 * code beat believing the note, which is now six for six in this repo.
 *
 * This list shrinks as each lands; it is not a fixed set.
 */
const STILL_ART_ONLY: string[] = [];
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

  /**
   * "HERE" is a referent (359.3.f.1) and a referent is checked on EXECUTION of the
   * instruction (359.3.f.2). The rules' worked example is this case: Fight or
   * Flight sends Yasuo - Remorseful home in reaction to his attack trigger, and
   * "'here' is no longer the battlefield where combat is ongoing and the attack
   * trigger mistargets". So a Bow whose wearer has left the fight is moot — the
   * convention Sinister Poro (UNL-137) already follows.
   *
   * Both halves of the window are covered, because the Bow has two of them: the
   * held trigger resolving, and its question being answered.
   */
  const damageOf = (state: GameState, instanceId: string) =>
    state.battlefields.flatMap((b) => Object.values(b.units).flat()).find((u) => u.instanceId === instanceId)?.damage;

  /** The triggered abilities still WAITING on the chain — the only way to tell
   *  "it resolved and did nothing" from "it never resolved at all". */
  const chainTriggerDefIds = (state: GameState): string[] =>
    state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerDefId: string }).listenerDefId);

  it("Recurve Bow does not shoot into a fight its wearer walked out of", () => {
    const state = worn(RECURVE_BOW);
    const wearer = state.battlefields.find((b) => b.id === "bf1")!.units["p1"]![0]!;
    const bf1 = state.battlefields.find((b) => b.id === "bf1")!;
    bf1.units = { ...bf1.units, p2: [makeUnit({ instanceId: "enemy-a" })] };
    bf1.contestedByIndex = 0;
    state.battlefields.find((b) => b.id === "bf2")!.units = { p2: [makeUnit({ instanceId: "enemy-b" })] };

    const held = holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: ["wearer"] });
    // The positive control: it DID trigger. "Nothing happened" is true of every
    // board immediately after a hold, so without this the assertions below pass
    // against a Bow that never fires at all.
    expect(held.pendingTriggers.map((t) => t.listenerDefId), "the bow never fired").toContain(RECURVE_BOW);

    // The response window: the wearer redeploys to bf2, where an enemy stands.
    const walked: GameState = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: [] } }
          : bf.id === "bf2"
            ? { ...bf, units: { ...bf.units, p1: [wearer] } }
            : bf,
      ),
    };

    const settled = resolveHeldTriggers(walked);
    expect(pendingDecision(settled), "it still asked, from a battlefield it had left").toBeUndefined();
    expect(damageOf(settled, "enemy-b"), "it re-aimed at where the wearer ended up").toBe(0);
    expect(damageOf(settled, "enemy-a"), "it shot into the fight from elsewhere").toBe(0);
  });

  it("Recurve Bow asks nothing when an earlier answer has sent its wearer home", () => {
    // The same rule reached the other way, through two real cards and no board
    // surgery: Overzealous Fan's "when I defend, you may kill me to move an
    // attacking unit to its base" is another question raised by the same
    // `combatBegan`, and its answer takes the Bow's wearer out of the fight.
    //
    // **This one does NOT discriminate the change** — a wearer in base was already
    // moot at the Bow's `resolve` — and it is kept for what it MEASURES instead:
    // that a pending question BLOCKS the chain, so the Bow's trigger is still
    // waiting when the Fan's answer lands. That is why the "here" re-check bites
    // at park time and why there is no second, later window to check in; the two
    // assertions on the chain below are the evidence for that claim, which was
    // asserted wrongly in this file's first draft.
    const state = worn(RECURVE_BOW);
    const fan = realUnitInstance(OVERZEALOUS_FAN);
    const bf1 = state.battlefields.find((b) => b.id === "bf1")!;
    // TWO plain enemies besides the Fan, so the Bow's question is a real choice
    // and waits rather than auto-resolving the instant it is parked.
    bf1.units = { ...bf1.units, p2: [fan, makeUnit({ instanceId: "enemy-a" }), makeUnit({ instanceId: "enemy-b" })] };
    bf1.contestedByIndex = 0;

    const settled = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: ["wearer", fan.instanceId] }),
    );
    const question = pendingDecision(settled);
    expect(question?.kind, "the Fan's question is the one that should be at the front").toBe("SFD-128-sacrifice");
    expect(chainTriggerDefIds(settled), "the bow's trigger had already resolved past the question").toContain(RECURVE_BOW);

    // Kill the Fan, send the wearer home, then let the chain finish — answering a
    // question does not resume it. `pickCard` falls through to the first option
    // for any other question, so a Bow that still asked would shoot.
    const answered = resolveHeldTriggers(answerDecisions(settled, pickCard("wearer")));

    expect(answered.players[0]!.baseUnits.map((u) => u.instanceId), "the Fan's answer did not send the wearer home").toContain("wearer");
    expect(chainTriggerDefIds(answered), "the bow's trigger never resolved, so this measured nothing").not.toContain(RECURVE_BOW);
    expect(pendingDecision(answered), "the bow still had a question to ask").toBeUndefined();
    expect(damageOf(answered, "enemy-a"), "the bow fired from base").toBe(0);
    expect(damageOf(answered, "enemy-b")).toBe(0);
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
    //
    // **The list is EMPTY as of 2026-08-07** — all 31 art-only Equipment are
    // written — so the loop below is vacuous and the assertion that matters has
    // moved to the sweep in the next test. The loop is kept rather than deleted
    // for the reason `PARTIALLY_IMPLEMENTED` itself is kept empty: the next
    // art-only card added to that list has to be held to this, and a deleted
    // check holds nothing.
    for (const id of STILL_ART_ONLY) {
      expect(isCardImplemented(registry.get(id)), `${id} still reports implemented`).toBe(false);
      expect(partialImplementationNote(registry.get(id)), `${id} has no note saying what is missing`).toMatch(/art-only/);
    }
  });

  it("has no art-only Equipment note in a FINISHED set — the sweep that replaced the list", () => {
    // The premise the loop above lost. Asserted over every Equipment in the pool
    // rather than over a hand-kept list, so it cannot go stale the way the list
    // did: a note added for any Equipment in a hard-gated set fails this by name.
    //
    // **36 since Unleashed landed (2026-08-08), up from 31.** The count is here
    // as a positive control on the sweep itself — an empty or truncated filter
    // would make the assertion below vacuously pass.
    //
    // **Scoped to COMPLETE_SETS, and the day it landed proved why.** This
    // asserted a flat empty list while SFD was the newest set and every one of
    // its art-only Equipment had been written. Unleashed then brought five more
    // Equipment, four of them carrying an ability that exists only on the card
    // art, and three of those are unwritten — so a flat "no Equipment anywhere
    // carries a note" now demands three card implementations as the price of
    // loading a set's JSON. In a finished set a note IS a regression; in a set
    // under construction it is the mechanism telling the truth.
    const equipment = registry.all().filter((d) => d.type === "Gear" && d.isEquipment === true);
    expect(equipment.length, "the Equipment sweep found nothing to sweep").toBe(36);
    const noted = equipment
      .filter((d) => partialImplementationNote(d) !== undefined)
      .filter((d) => COMPLETE_SETS.includes(setCodeOf(d.id)))
      .map((d) => `${d.id} (${d.name})`);
    expect(noted).toEqual([]);
    expect(STILL_ART_ONLY, "an id left the note list without leaving this constant").toEqual([]);
  });

  it("NAMES the art-only Equipment a set under construction still owes", () => {
    // The other half, and the reason the scoping above is not a weakening: what
    // used to be asserted as "none" is now asserted as "these three, by name".
    // An art-only ability is invisible to every text-reading gate in the repo —
    // that is the whole failure mode — so the list has to be stated somewhere
    // that fails when it changes.
    //
    // Transcriptions are in docs/unl-equipment-abilities.md.
    //
    // **This list SHRINKS as the art bands are written, and it just did.** UNL-019
    // Blighted Battleaxe and UNL-039 Soul Sword left on 2026-08-09 — their bands
    // are implemented, so their "art-only" notes went with them and this premise
    // moved from three to one. That is the mechanism working: the note is deleted
    // by the same change that writes the card, and this test is what makes the
    // deletion deliberate rather than forgotten.
    //
    // Deliberately absent for other reasons: Hunter's Machete's art-only `[Hunt]`
    // grant IS implemented, and Shepherd's Heirloom was finished in wave 2 — the
    // note claiming its `[Equip] — Spend 1 XP` is unpriceable is gone too.
    // **The list reached ZERO on 2026-08-12, and that is why this is no longer
    // asserted as a list of names.** Wave 7 wrote UNL-188's band, so its note lost
    // the "art-only" substring — and an empty `toEqual([])` here would have made
    // the loop below vacuous, which is the shape this repo keeps finding: a test
    // that reports green because it checked nothing.
    //
    // Restated as the INVARIANT the list was standing in for: whatever carries an
    // art-only note must genuinely report unfinished. That holds at zero and at
    // any other size, and it cannot go quietly vacuous because the filter itself
    // is proved on a synthetic subject below.
    const owed = registry
      .all()
      .filter((d) => d.type === "Gear" && d.isEquipment === true)
      .filter((d) => (partialImplementationNote(d) ?? "").includes("art-only"))
      .map((d) => d.id)
      .sort();
    for (const id of owed) expect(isCardImplemented(registry.get(id)), `${id} still reports implemented`).toBe(false);

    // The half that rots silently. `owed` is empty today, so the loop above
    // asserts nothing — this proves the FILTER still works, on a subject no card
    // implementation can take away.
    const matches = (note: string | undefined) => (note ?? "").includes("art-only");
    expect(matches("art-only: its conquer draw is unwritten"), "the art-only filter stopped matching").toBe(true);
    expect(matches("half written: the conquer draw works"), "the filter matches a note it should not").toBe(false);
    expect(matches(undefined), "an absent note matched the filter").toBe(false);

    // UNL-188 is the card that just left the list, and it is still UNFINISHED for
    // a different, newly-recorded reason — its printed "[Equip] cost is reduced by
    // the Might of the unit you choose", which no static ActivationCost can hold.
    // Asserted here so "left the art-only list" is never mistaken for "done".
    expect(owed, "UNL-188 went back to being art-only").not.toContain("UNL-188");
    expect(isCardImplemented(registry.get("UNL-188")), "UNL-188 now claims to be finished").toBe(false);
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
 * moment of death, the same 808.1.d.3 reasoning that captures the unit itself.
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
