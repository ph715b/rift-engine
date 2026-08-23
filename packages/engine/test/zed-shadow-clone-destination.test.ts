import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **VEN-023 Zed, From the Shadows — the Shadow Clone's destination.**
 *
 * "You may discard 1 as an additional cost to play me. When you play me, if you
 * paid the additional cost, play a 0 [Might] Shadow Clone unit token."
 *
 * # The divergence this closes
 *
 * The card names NO destination, so 185.2.a is the whole rule: a token is played
 * "following all the applicable steps for playing a card plus any restrictions
 * from the effect that created it", and a Unit's inherent restriction is base or
 * a battlefield you control. The engine minted the Clone straight to base and
 * `docs/rules-conformance.md` recorded it as **narrower than printed** — a legal
 * play withheld, which is the one thing this engine is not supposed to do.
 *
 * **The recorded blocker was real and did not bind**, which is this repo's most
 * repeated finding about its own notes. It said the choice needs a row in
 * `TOKEN_PLACEMENT_SPELL_DEF_IDS` and that table is for SPELLS — both true, and
 * a unit's on-play trigger genuinely has no `destinationBattlefieldId` axis to
 * fan out over. But a fan-out is not the only way to ask. The trigger parks a
 * QUESTION at resolution, exactly as every battlefield ability does, and
 * Vanguard Armory (`SFD-168-place`) already asks this question with these exact
 * options. VEN-144 Death Mark mints the identical token and always got the
 * choice; the difference was the shape of the card making it.
 *
 * # What is worth pinning, beyond "a prompt appears"
 *
 * The interesting half is the OTHER direction: with no controlled battlefield
 * the option list is one long and `advanceDecisions` executes it silently, so
 * the common case must cost the player no click at all. A version that always
 * prompted would be just as wrong as one that never asked.
 */

const ZED = "VEN-023";
const registry = defaultCardRegistry();

/** Zed in hand, payable, with `controlled` battlefields under the caster. */
function board(controlled: string[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields = state.battlefields.map((bf) => ({
    ...bf,
    ...(controlled.includes(bf.id)
      ? { controllerId: "p1", units: { p1: [makeUnit({ instanceId: `g-${bf.id}`, name: "Garrison" })] } }
      : {}),
  }));
  state.players[0]!.hand = [
    createCardInstance(registry.get(ZED)),
    { ...makeUnit({ instanceId: "pitch", name: "Pitch" }), defId: "OGN-164" } as never,
  ];
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

/** The enumerated play of Zed that PAYS the optional discard — the "if you paid
 *  the additional cost" half, which is the only one that mints a Clone. */
function discardPlay(state: GameState): PlayCardAction {
  const play = legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.defId === ZED && a.discardCardInstanceId !== undefined,
  );
  expect(play, "no discard-paying play of Zed was offered — the fixture cannot mint a Clone").toBeDefined();
  return play!;
}

const clonesAt = (state: GameState, bfId: string) =>
  (state.battlefields.find((bf) => bf.id === bfId)?.units.p1 ?? []).filter((u) => u.isToken);
const clonesInBase = (state: GameState) => state.players[0]!.baseUnits.filter((u) => u.isToken);

describe("the card is what this file thinks it is", () => {
  it("prints a token with no destination clause", () => {
    const def = registry.get(ZED);
    expect(def.name, "VEN-023 is not Zed, From the Shadows").toBe("Zed, From the Shadows");
    const text = "text" in def ? String(def.text) : "";
    expect(text, "the Shadow Clone clause has changed").toContain("Shadow Clone");
    // **The whole basis of this change.** If a printing ever adds "to your base"
    // — as VEN-112 Zed, Without a Sound actually prints — then base is correct
    // and this file's premise is gone. Asserted rather than assumed, because the
    // sibling card two ids away really does print it.
    expect(text.toLowerCase(), "the card now names a destination — the choice is no longer the caster's").not.toContain(
      "to your base",
    );
  });
});

describe("the caster is ASKED when there is a real choice", () => {
  it("offers base and every battlefield they control", () => {
    const state = board(["bf1", "bf2"]);
    const after = resolveHeldTriggers(submit(state, discardPlay(state)).state);
    const pending = pendingDecision(after);
    expect(pending?.kind, "no destination question was asked").toBe("VEN-023-place");
    expect(optionsFor(after, pending!).map((o) => o.id).sort(), "the offer is not base plus both battlefields").toEqual([
      "base",
      "bf1",
      "bf2",
    ]);
  });

  it("puts the Clone on the battlefield the caster names", () => {
    const state = board(["bf1", "bf2"]);
    const after = resolveHeldTriggers(submit(state, discardPlay(state)).state);
    const settled = answerDecision(after, pendingDecision(after)!.id, "bf2")!;
    expect(clonesAt(settled, "bf2"), "the Clone did not land where it was sent").toHaveLength(1);
    expect(clonesAt(settled, "bf1"), "a Clone appeared at a battlefield nobody named").toHaveLength(0);
    expect(clonesInBase(settled), "the Clone went to base as well as the battlefield").toHaveLength(0);
  });

  it("still allows base — the choice is not forced outward", () => {
    const state = board(["bf1"]);
    const after = resolveHeldTriggers(submit(state, discardPlay(state)).state);
    const settled = answerDecision(after, pendingDecision(after)!.id, "base")!;
    expect(clonesInBase(settled), "choosing base did not put the Clone in base").toHaveLength(1);
    expect(clonesAt(settled, "bf1"), "the Clone landed at a battlefield after base was chosen").toHaveLength(0);
  });
});

describe("it does NOT ask when there is nothing to choose", () => {
  it("mints straight to base with no controlled battlefield, and no prompt", () => {
    // **The half that makes this a fix rather than a nuisance.** One option is
    // not a question; `advanceDecisions` executes it without ever showing it, so
    // the ordinary case is exactly as it was before this change.
    const state = board([]);
    const after = resolveHeldTriggers(submit(state, discardPlay(state)).state);
    expect(pendingDecision(after), "a one-option question was put in front of the player").toBeUndefined();
    expect(clonesInBase(after), "no Clone was minted at all").toHaveLength(1);
  });

  it("does not offer a battlefield the caster does not CONTROL", () => {
    // Presence is not control. The token's destinations are the ones a unit may
    // be PLAYED to, which is stricter than the direct-deploy check.
    const state = board([]);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      controllerId: "p2",
      units: { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] },
    };
    const after = resolveHeldTriggers(submit(state, discardPlay(state)).state);
    expect(pendingDecision(after), "an enemy-controlled battlefield was offered as a destination").toBeUndefined();
    expect(clonesInBase(after), "the Clone was not minted").toHaveLength(1);
  });
});

describe("the trigger's own condition is untouched", () => {
  it("mints NOTHING when the optional discard was not paid", () => {
    // "if you paid the additional cost". The destination change must not turn the
    // conditional half into an unconditional one — a version that parked the
    // question before the check would mint a Clone off every plain play.
    const state = board(["bf1"]);
    const plain = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.defId === ZED && a.discardCardInstanceId === undefined,
    );
    expect(plain, "no plain play of Zed was offered — this control proves nothing").toBeDefined();
    const after = resolveHeldTriggers(submit(state, plain!).state);
    expect(pendingDecision(after), "an unpaid play asked where to put a Clone").toBeUndefined();
    expect(clonesInBase(after).length + clonesAt(after, "bf1").length, "an unpaid play minted a Clone").toBe(0);
  });
});
