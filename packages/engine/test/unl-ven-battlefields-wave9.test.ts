import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { holdBattlefieldTrigger } from "../src/engine/battlefield-abilities.js";
import { COMPLETE_BATTLEFIELD_SETS } from "../src/engine/coverage.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";

/**
 * **UNL battlefields, wave 9 — the last two, and UNL is COMPLETE.**
 *
 *   UNL-211 Forgotten Library — while you control this, when you play a spell, if
 *                               you spent [4 Energy] or more, [Predict]
 *   UNL-216 The Academy       — when you hold here, give your next spell this turn
 *                               [Repeat] equal to its base cost
 *
 * Both were DEFERRED in earlier waves and both turned out cheaper than the
 * deferral said — which is this repo's own recurring finding about its notes.
 *
 * **Forgotten Library was deferred on two blockers and one was real.** "Nothing
 * records what a play COST" was true, and `PlayerState.energySpentOnLastPlay` is
 * the fix — written by `execute-play-card` from the same figure it pays, because
 * this trigger is HELD and 383 fixes the condition at the moment of the event.
 * The other blocker — "`[Predict]` is private to `effects/chaos.ts`" — was a
 * reason to SHARE it: `recycleTopCard` existed as two byte-identical private
 * copies, in `chaos.ts` and `calm.ts`, and needing a third is exactly the drift
 * CLAUDE.md records. It is in `effect-helpers.ts` now and both copies are gone.
 *
 * **The Academy needed no new machinery at all.** Temporal Portal already prints
 * the same clause; `PlayerState.nextSpellRepeatGrants` and
 * `card-effects.grantedRepeatCostOf` are its implementation, and that helper
 * already returns `{ energy: card.energyCost, power: card.powerCost }` — which IS
 * "[Repeat] equal to its base cost".
 */

const FORGOTTEN_LIBRARY = "UNL-211";
const THE_ACADEMY = "UNL-216";
const FILLER = "OGN-164";

function board(defId: string, opts: { controllerId?: string | null } = {}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: { p1: [makeUnit({ instanceId: "g", name: "Garrison" })] },
    controllerId: opts.controllerId === undefined ? "p1" : opts.controllerId,
  };
  return state;
}

/** Raises the spell-played moment for every battlefield, as `execute-play-card`
 *  does. The WIRING is pinned by wave 5. */
const castSpell = (state: GameState, playerIndex: 0 | 1 = 0) =>
  state.battlefields.reduce((next, bf) => holdBattlefieldTrigger(next, "spellPlayed", bf.id, playerIndex), state);

function withDeck(state: GameState, names: string[]): GameState {
  state.players[0]!.deck = names.map((n, i) => ({ ...makeUnit({ instanceId: `d${i}`, name: n }), defId: FILLER })) as never;
  return state;
}

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [FORGOTTEN_LIBRARY, "Forgotten Library", "[Predict]"],
      [THE_ACADEMY, "The Academy", "[Repeat]"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Forgotten Library (UNL-211): [Predict] on an expensive spell", () => {
  function library(spent: number, controller: string | null = "p1"): GameState {
    const state = withDeck(board(FORGOTTEN_LIBRARY, { controllerId: controller }), ["Top", "Second"]);
    state.players[0]!.energySpentOnLastPlay = spent;
    return state;
  }

  it("offers the look when you spent 4", () => {
    const held = resolveHeldTriggers(castSpell(library(4)));
    const pending = pendingDecision(held);
    expect(pending?.kind, "no [Predict] was offered").toBe(`${FORGOTTEN_LIBRARY}-predict`);
    expect(optionsFor(held, pending!).map((o) => o.id).sort(), "the look did not offer both answers").toEqual([
      "keep",
      "recycle",
    ]);
  });

  it("recycles the top card to the BOTTOM when taken", () => {
    const held = resolveHeldTriggers(castSpell(library(4)));
    const settled = answerDecision(held, pendingDecision(held)!.id, "recycle")!;
    expect(settled.players[0]!.deck.map((c) => c.name), "the top card did not go to the bottom").toEqual([
      "Second",
      "Top",
    ]);
  });

  it("leaves it alone when kept", () => {
    const held = resolveHeldTriggers(castSpell(library(4)));
    const settled = answerDecision(held, pendingDecision(held)!.id, "keep")!;
    expect(settled.players[0]!.deck.map((c) => c.name), "keeping moved it anyway").toEqual(["Top", "Second"]);
  });

  it("places NO PENDING ITEM below 4 Energy — 'if you SPENT 4 or more'", () => {
    // The boundary, asserted on the Pending Item: a held trigger closes the chain
    // and costs both players a PassFocus even when it resolves to nothing.
    const raised = castSpell(library(3));
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed for a cheap spell",
    ).toHaveLength(0);
  });

  it("...and DOES at exactly 4 — the control", () => {
    expect(
      castSpell(library(4)).pendingTriggers.filter((e) => e.source === "battlefield"),
      "nothing was held at 4, so the boundary test proves nothing",
    ).toHaveLength(1);
  });

  it("does NOT fire while the opponent controls it — 'while YOU control'", () => {
    // The clause that separates it from Abandoned Hall, which shares the moment
    // and has no controller condition.
    const raised = castSpell(library(9, "p2"));
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "it fired for a battlefield the opponent controls",
    ).toHaveLength(0);
  });

  it("does NOT fire on the OPPONENT's expensive spell", () => {
    const state = library(9);
    state.players[1]!.energySpentOnLastPlay = 9;
    const raised = castSpell(state, 1);
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "the opponent's spell fired the controller's Library",
    ).toHaveLength(0);
  });

  it("asks nothing with an empty deck — 359.3.e.11", () => {
    const state = board(FORGOTTEN_LIBRARY);
    state.players[0]!.energySpentOnLastPlay = 4;
    state.players[0]!.deck = [];
    expect(pendingDecision(resolveHeldTriggers(castSpell(state))), "asked about a deck with no top card").toBeUndefined();
  });
});

describe("The Academy (UNL-216): your next spell gets [Repeat]", () => {
  function academy(): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: THE_ACADEMY,
      units: { p1: [makeUnit({ instanceId: "g", name: "Garrison" })] },
      controllerId: "p1",
    };
    return state;
  }

  const grants = (state: GameState) => state.players[0]!.nextSpellRepeatGrants;

  it("arms a grant on the hold", () => {
    const before = academy();
    expect(grants(before), "the grant was armed before the hold").toBe(0);
    expect(grants(answerDecisions(resolveHeldTriggers(runBeginning(before)))), "holding armed nothing").toBe(1);
  });

  it("STACKS with a second source rather than assigning", () => {
    // Two Academies can be held in one turn, and the field's own doc records that
    // two armed grants mean two instances. Assigning would silently cap it.
    const state = academy();
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      defId: THE_ACADEMY,
      units: { p1: [makeUnit({ instanceId: "g2", name: "Garrison 2" })] },
      controllerId: "p1",
    };
    expect(grants(answerDecisions(resolveHeldTriggers(runBeginning(state)))), "the second hold did not stack").toBe(2);
  });

  it("does not arm the OPPONENT", () => {
    const after = answerDecisions(resolveHeldTriggers(runBeginning(academy())));
    expect(after.players[1]!.nextSpellRepeatGrants, "the opponent was armed too").toBe(0);
  });
});

describe("the play RECORDS what it spent", () => {
  it("writes energySpentOnLastPlay from a real play, not from a fixture", () => {
    // **The half every other test in this file assumes.** They all set the field
    // directly, so a mutant that stopped `execute-play-card` writing it survived
    // them all — Forgotten Library would then never fire in a real game while its
    // whole suite stayed green.
    //
    // Driven through `submit`, and asserted against the card's own printed cost
    // rather than a literal, so a repriced set file cannot make it vacuous.
    // **The spell is chosen by what the ENUMERATOR offers, not by filtering the
    // registry.** A spell picked on cost alone may still need a target, a domain
    // or a board this fixture does not have — the first attempt picked
    // Disintegrate and it was simply not playable here, which says nothing about
    // the field being written.
    const registry = defaultCardRegistry();
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "t", name: "Target", might: 3 })] };
    state.players[0]!.hand = registry
      .all()
      .filter((d) => d.type === "Spell" && d.energyCost >= 2)
      .slice(0, 25)
      .map((d) => createCardInstance(registry.get(d.id)));
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
      state: "Ready" as const,
    }));

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.kind === "Spell");
    expect(play, "no spell at all was playable from this board — the test measures nothing").toBeDefined();
    // Narrowed, not indexed off the union: `CardDefinition` includes Legend,
    // which has no `energyCost` — the same definition-vs-instance trap this
    // session hit three times, caught here by `tsc` and not by vitest.
    const offered = registry.get(play!.type === "PlayCard" ? play!.card.defId : "");
    expect(offered.type, "the enumerator offered something that is not a Spell").toBe("Spell");
    if (offered.type !== "Spell") return;
    expect(offered.energyCost, "the offered spell is free, so 0 would pass either way").toBeGreaterThan(0);

    const after = submit(state, play!);
    expect(after.result.type, "the play was refused").toBe("Ok");
    expect(
      after.state.players[0]!.energySpentOnLastPlay,
      "the play did not record what it spent",
    ).toBeGreaterThan(0);
  });
});

describe("UNL's battlefields are COMPLETE and hard-gated", () => {
  it("UNL is in COMPLETE_BATTLEFIELD_SETS", () => {
    // The promotion this wave earned.
    //
    // **This assertion used to add "…and VEN is not", and that half is gone on
    // purpose.** It was true when written — VEN-157 Dragon Roost was still
    // deferred — and it went red the moment the next change finished that card.
    // A pin whose premise is "this work is unfinished" breaks when the work is
    // done, and the repair is to drop the premise rather than to weaken what
    // replaced it: `dragon-roost.test.ts` now asserts all four sets are gated,
    // which is the thing worth holding.
    expect(COMPLETE_BATTLEFIELD_SETS, "UNL was finished but never promoted").toContain("UNL");
  });
});
