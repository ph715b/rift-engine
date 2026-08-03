import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * The Harrowing (OGN-198) — "Play a unit from your trash, ignoring its Energy
 * cost. (You must still pay its Power cost.)"
 *
 * Everything here goes through `submit`, and the play itself is taken from
 * `legalActions` rather than hand-built: a Spell that is only `executePlayCard`ed
 * has done nothing but go onto the chain, and a card the enumerator never offers
 * is unplayable no matter how correct its resolver is. Both failure modes have
 * shipped in this repo before.
 *
 * The card is Soulgorger's decision without the "you may", so the cases that
 * matter here are the ones that DIVERGE from it: no decline option, and — the
 * one that could genuinely hang a game — a mandatory instruction whose option
 * list is empty.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const spell = (defId: string) => card(defId) as SpellInstance;
const unit = (defId: string) => card(defId) as UnitInstance;

const HARROWING = "OGN-198"; // Chaos spell, 6 Energy + 2 Chaos Power
const KOGMAW_CAUSTIC = "OGN-190"; // Chaos unit, 3 Energy + 1 CHAOS Power
const LECTURING_YORDLE = "OGN-087"; // "When you play me, draw 1." — 0 Power
const MAGMA_WURM = "OGN-011"; // Fury unit, 8 Energy + 1 FURY Power — the domain mismatch
const INCINERATE = "OGS-003"; // a Spell, for the "a UNIT from your trash" filter

/**
 * The Harrowing in hand, funded for exactly its own cost in Ready Chaos runes,
 * with `trash` already in the caster's trash.
 *
 * The funding is exact on purpose. After the cast, the 6 Energy runes are
 * Exhausted and the 2 Power runes have been recycled — so the pool holds NO
 * Ready rune, and every Energy cost in the game is unpayable from it. That is
 * what makes "the replayed unit's Energy was ignored" observable rather than
 * asserted; `spare` adds Ready runes back only where a test needs them.
 */
function harrowingTable(trash: CardInstance[], spare: { count: number; domain: "Chaos" | "Fury" } = { count: 0, domain: "Chaos" }): {
  state: GameState;
  harrowing: SpellInstance;
} {
  const harrowing = spell(HARROWING);
  const state = makeState({ phase: "Action", players: [makePlayer("p1", { hand: [harrowing] }), makePlayer("p2")] });
  state.players[0]!.channeled = [
    ...Array.from({ length: harrowing.energyCost + harrowing.powerCost }, (_, i) => ({
      id: `chaos-${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    })),
    ...Array.from({ length: spare.count }, (_, i) => ({ id: `spare-${i}`, domain: spare.domain, state: "Ready" as const })),
  ];
  state.players[0]!.trash = trash;
  // Stocked so nothing here can draw from an empty deck: Burn Out (431) recycles
  // the trash back into the Main Deck, which would empty the very zone these
  // tests inspect. Learned from the Acceptable Losses fixture next door.
  state.players[0]!.deck = [makeUnit({ name: "Drawn" }), makeUnit({ name: "Spare" })];
  return { state, harrowing };
}

/** The Harrowing as `legalActions` offers it — the reachability check, not a
 *  convenience. Fails loudly rather than returning undefined. */
function offeredPlay(state: GameState, played: CardInstance): PlayCardAction {
  const offered = legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === played.instanceId,
  );
  expect(offered.length, `legal-actions offers ${played.name}`).toBeGreaterThan(0);
  return offered[0]!;
}

/** Plays it for real and walks the chain to resolution, stopping at the first
 *  question. */
function cast(state: GameState, harrowing: SpellInstance): GameState {
  const played = submit(state, offeredPlay(state, harrowing));
  expect(played.result, "playing The Harrowing").toEqual({ type: "Ok" });
  let current = played.state;
  for (let guard = 0; guard < 8; guard += 1) {
    if (current.chainOpen || current.pendingDecisions.length > 0) return current;
    const pass = submit(current, { type: "PassFocus", playerIndex: current.chainPriority });
    expect(pass.result).toEqual({ type: "Ok" });
    current = pass.state;
  }
  throw new Error("cast: the chain never resolved");
}

/** Answers through `submit`, the same door a human and the AI use — not
 *  `answerDecision`, which skips the validator and the pending-decision gate. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "a question was asked").toBeDefined();
  const answered = submit(state, {
    type: "AnswerDecision",
    playerIndex: decision!.playerIndex,
    decisionId: decision!.id,
    optionId,
  });
  expect(answered.result, `answering ${decision!.kind}`).toEqual({ type: "Ok" });
  return answered.state;
}

describe("The Harrowing (OGN-198): play a unit from your trash for its Power only", () => {
  it("asks which unit, offering NO decline — the card has no 'you may'", () => {
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const yordle = unit(LECTURING_YORDLE);
    const { state, harrowing } = harrowingTable([kogmaw, yordle]);

    const asked = cast(state, harrowing);

    expect(pendingDecision(asked)!.kind).toBe("OGN-198-play");
    const options = optionsFor(asked, pendingDecision(asked)!);
    // The whole divergence from Soulgorger, asserted both ways round so that a
    // decline creeping back in cannot pass as "the first option".
    expect(options.map((o) => o.id)).not.toContain("decline");
    expect(options.map((o) => o.instanceId)).toEqual([kogmaw.instanceId, yordle.instanceId]);
  });

  it("plays the chosen unit out of the trash, paying its Power and NOT its Energy", () => {
    const kogmaw = unit(KOGMAW_CAUSTIC); // 3 Energy + 1 Chaos Power
    const yordle = unit(LECTURING_YORDLE); // the second option, so this is a real choice
    const { state, harrowing } = harrowingTable([kogmaw, yordle]);

    const asked = cast(state, harrowing);
    // The premise the Energy assertion rests on, measured rather than assumed:
    // the cast leaves fewer READY runes than Kog'Maw's printed Energy, and no
    // floating Energy, so 3 Energy is unpayable from this pool. Him arriving can
    // then only mean it was never asked for. (The exact survivor count depends on
    // how computeAutoPayment overlaps the Energy and Power runes, which is why
    // this reads the pool instead of hard-coding it.)
    const readyBefore = asked.players[0]!.channeled.filter((r) => r.state === "Ready").length;
    expect(kogmaw.energyCost).toBeGreaterThan(readyBefore);
    expect(asked.players[0]!.floatingEnergy).toBe(0);
    const channeledBefore = asked.players[0]!.channeled.length;
    const runeDeckBefore = asked.players[0]!.runeDeck.length;

    const after = answer(asked, kogmaw.instanceId);

    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([KOGMAW_CAUSTIC]);
    // The Yordle stays put — one unit, not "every unit you can pay for" — and the
    // spent Harrowing is in there with it.
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([yordle.instanceId, harrowing.instanceId]);
    // Exactly one rune left the pool for the bottom of the rune deck — 416, which
    // is what paying Power does. The count is the proof the Power was really paid
    // rather than waived alongside the Energy.
    expect(after.players[0]!.channeled).toHaveLength(channeledBefore - 1);
    expect(after.players[0]!.runeDeck).toHaveLength(runeDeckBefore + 1);
    // Not one rune was EXHAUSTED on his behalf, which is what paying 3 Energy
    // would have taken: the single rune that moved went to the rune deck, the
    // Power route.
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(readyBefore);
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true); // 143.4.a
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(2); // the Harrowing and Kog'Maw
  });

  it("is a real PLAY — the replayed unit's own on-play trigger fires", () => {
    // The dispatch hop is the entire point of routing through playUnitToBase, and
    // a unit that merely appeared in base would look identical without this.
    // Lecturing Yordle's "when you play me, draw 1" is the observable half.
    const yordle = unit(LECTURING_YORDLE);
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const { state, harrowing } = harrowingTable([yordle, kogmaw]);

    // Settled again after the answer: the unit The Harrowing plays has an
    // on-play trigger of its OWN, and that is now a second Chain Pending Item.
    const after = resolveHeldTriggers(answer(cast(state, harrowing), yordle.instanceId));

    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([LECTURING_YORDLE]);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("plays a LONE payable unit without asking — one option is not a choice", () => {
    // Mandatory and unambiguous: there is nothing to decide, so nobody is
    // interrupted. This is the branch that would have needed a decline if the
    // card had one, and it is where Soulgorger and The Harrowing visibly differ.
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const { state, harrowing } = harrowingTable([kogmaw]);

    const after = cast(state, harrowing);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([KOGMAW_CAUSTIC]);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([HARROWING]);
  });

  it("fizzles rather than stranding a decision when the trash holds nothing playable", () => {
    // THE case worth writing this file for. A mandatory instruction with zero
    // options must not park an unanswerable question — `advanceDecisions` drops
    // it (422, do as much as you can). Three trash states reach it: empty, a
    // Spell only, and a unit whose Power this pool cannot pay.
    //
    // The fourth case is a POSITIVE CONTROL and it is not decoration: measured
    // against a build with the registry entry renamed away, the first three all
    // still passed. "Nothing happened" is exactly what an unregistered card does,
    // so without a case where something DOES happen this test reads as green on a
    // dead card.
    const cases: { name: string; trash: CardInstance[]; plays: boolean }[] = [
      { name: "empty trash", trash: [], plays: false },
      { name: "a Spell only — 'a UNIT from your trash'", trash: [spell(INCINERATE)], plays: false },
      { name: "a unit whose Power pip is the wrong domain (416.3)", trash: [unit(MAGMA_WURM)], plays: false },
      { name: "control: one payable unit, which DOES arrive", trash: [unit(KOGMAW_CAUSTIC)], plays: true },
    ];

    for (const { name, trash, plays } of cases) {
      const { state, harrowing } = harrowingTable(trash);

      const after = cast(state, harrowing);

      expect(after.pendingDecisions, name).toHaveLength(0);
      expect(after.players[0]!.baseUnits.length > 0, name).toBe(plays);
      expect(after.players[0]!.trash.map((c) => c.defId), name).toEqual(
        plays ? [HARROWING] : [...trash.map((c) => c.defId), HARROWING],
      );
      // Not stranded: the game is still playable, and an action is still
      // ACCEPTED. A dropped question and a deadlocked one look identical from
      // `pendingDecisions` alone if the caller never tries to act again — and
      // `submit` refuses every action while a decision is outstanding (323.2.a),
      // so this is what tells the two apart.
      const offered = legalActions(after);
      expect(offered.length, `${name}: the game is still playable`).toBeGreaterThan(0);
      expect(submit(after, offered[0]!).result, `${name}: an action is still accepted`).toEqual({ type: "Ok" });
    }
  });

  it("...and DOES play the wrong-domain unit once one rune of its domain is in the pool", () => {
    // The positive control for the Magma Wurm case above: an option list that was
    // empty for some unrelated reason would read exactly the same as one withheld
    // on affordability.
    const wurm = unit(MAGMA_WURM); // 8 Energy + 1 FURY Power
    const { state, harrowing } = harrowingTable([wurm], { count: 1, domain: "Fury" });

    const after = cast(state, harrowing);

    // One option, so it resolves without asking — and the 8 Energy was never a
    // consideration, which is the card's whole text.
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([MAGMA_WURM]);
    expect(after.players[0]!.channeled.some((r) => r.domain === "Fury")).toBe(false);
  });

  it("still offers Soulgorger its decline — the shared helpers did not flatten the two cards", () => {
    // The Harrowing reuses OGN-196's option builder and its play-from-trash step.
    // Nothing else asserts that the "you may" survived that sharing, and losing it
    // would turn a Soulgorger into a compulsory reanimation.
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const soulgorger = unit("OGN-196");
    const state = makeState({ phase: "Action", players: [makePlayer("p1", { hand: [soulgorger] }), makePlayer("p2")] });
    state.players[0]!.channeled = Array.from({ length: soulgorger.energyCost + soulgorger.powerCost + 1 }, (_, i) => ({
      id: `r${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    }));
    state.players[0]!.trash = [kogmaw];

    const played = submit(state, offeredPlay(state, soulgorger));
    expect(played.result).toEqual({ type: "Ok" });
    // His on-play ability waits on the chain, so the question it parks is one
    // pop away rather than immediate.
    const asked = resolveHeldTriggers(played.state);

    const options = optionsFor(asked, pendingDecision(asked)!);
    expect(pendingDecision(asked)!.kind).toBe("OGN-196-play");
    expect(options[0]!.id).toBe("decline");
    expect(options.map((o) => o.instanceId)).toContain(kogmaw.instanceId);
  });

  it("coverage reports the card as implemented", () => {
    expect(isCardImplemented(registry.get(HARROWING)), registry.get(HARROWING).name).toBe(true);
  });
});
