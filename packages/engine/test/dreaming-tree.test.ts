import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { holdUnitsChosenBySpell } from "../src/engine/battlefield-abilities.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **The Dreaming Tree (OGN-292) — "When a player chooses a friendly unit here
 * with a spell for the first time each turn, they draw 1."**
 *
 * # Why this file exists, and why it is dated long after the card
 *
 * The Tree was implemented, registered and hard-gated for the life of this
 * engine with **no behavioural test at all** — its only appearance in `test/`
 * was a passing remark inside a comment in `unit-chosen.test.ts`.
 * `battlefield-coverage` could not see the hole: that gate asks whether a
 * battlefield has an entry somewhere, and the Tree has one.
 *
 * It was found on 2026-08-22 by `probes/battlefield-reach.ts`, which puts all 64
 * battlefields on real boards and reported the Tree as one of only two triggered
 * battlefields that never once placed a Pending Item across 132 games. The other,
 * VEN-162 Protective Sands, was already pinned by six tests including a positive
 * control — so "silent in play" separated cleanly into "conditional and pinned"
 * and "conditional and pinned by nothing", and only the second is a gap.
 *
 * **It is NOT a defect.** The moment is wired — `execute-play-card` calls
 * `holdUnitsChosenBySpell` at announce — and the condition is simply narrow: the
 * spell must choose the CHOOSER'S OWN unit, standing at the Tree rather than in
 * base. The AI's spells overwhelmingly name enemy units, so the trigger is rare
 * rather than broken. That is exactly the state that needs a test, because
 * nothing in the repo would have noticed it breaking.
 */

const THE_DREAMING_TREE = "OGN-292";
const FILLER = "OGN-164";

/** bf1 is the Tree, seeded with whichever units the case needs. */
function tree(opts: { atTree?: string[]; inBase?: string[]; enemyAtTree?: string[] } = {}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId: THE_DREAMING_TREE,
    units: {
      p1: (opts.atTree ?? []).map((id) => makeUnit({ instanceId: id, name: id })),
      p2: (opts.enemyAtTree ?? []).map((id) => makeUnit({ instanceId: id, name: id })),
    },
  };
  state.players[0]!.baseUnits = (opts.inBase ?? []).map((id) => makeUnit({ instanceId: id, name: id }));
  // Two cards deep, so "drew 1" is distinguishable from "drew the deck out".
  state.players[0]!.deck = ["Top", "Second"].map((n, i) => ({
    ...makeUnit({ instanceId: `d${i}`, name: n }),
    defId: FILLER,
  })) as never;
  state.players[0]!.hand = [];
  return state;
}

/** The chooser's hand once the moment is raised and every held trigger settles. */
const handAfter = (state: GameState, chooser: 0 | 1, chosen: string[]) =>
  resolveHeldTriggers(holdUnitsChosenBySpell(state, chooser, chosen)).players[chooser]!.hand;

/** The battlefield Pending Items a raise placed, which is what separates "did not
 *  trigger" from "triggered and resolved to nothing". */
const heldItems = (state: GameState) => state.pendingTriggers.filter((e) => e.source === "battlefield");

describe("the card is what this file thinks it is", () => {
  it("prints the clause", () => {
    const def = loadBattlefieldDefinitions().find((d) => d.id === THE_DREAMING_TREE);
    expect(def?.name, "OGN-292 is not The Dreaming Tree").toBe("The Dreaming Tree");
    expect(def?.text, "the printed text has changed under the implementation").toContain("draw 1");
  });
});

describe("it draws for a friendly unit chosen HERE", () => {
  it("draws exactly 1", () => {
    expect(handAfter(tree({ atTree: ["u1"] }), 0, ["u1"]).map((c) => c.name), "no card was drawn").toEqual(["Top"]);
  });

  it("draws for the SECOND player when they are the chooser", () => {
    // "a player chooses… THEY draw" — the Tree is not owned, and the draw follows
    // the chooser rather than the battlefield's controller.
    const state = tree();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "e1", name: "e1" })] };
    state.players[1]!.deck = [{ ...makeUnit({ instanceId: "x", name: "Theirs" }), defId: FILLER }] as never;
    state.players[1]!.hand = [];
    expect(handAfter(state, 1, ["e1"]).map((c) => c.name), "the second player did not draw").toEqual(["Theirs"]);
  });
});

describe("the two conditions the FIRING SITE settles", () => {
  it("does NOT fire for a unit in BASE — 'a friendly unit HERE'", () => {
    // 198.1 makes a base a Location too, so "here" is load-bearing rather than
    // decorative: without it the Tree would draw for any friendly unit chosen
    // anywhere on the board.
    expect(handAfter(tree({ inBase: ["b1"] }), 0, ["b1"]), "it drew for a unit standing in base").toHaveLength(0);
  });

  it("does NOT fire when the chooser names the OPPONENT's unit here — 'a FRIENDLY unit'", () => {
    // Friendly to the CHOOSER. This is the half nearly every real spell does, and
    // it is why the Tree is near-silent in played games.
    expect(handAfter(tree({ enemyAtTree: ["e1"] }), 0, ["e1"]), "choosing an enemy unit drew a card").toHaveLength(0);
  });

  it("places no Pending Item in either case", () => {
    // Asserted on the CHAIN, not only on the hand. A held trigger that resolves
    // to nothing still costs both players a PassFocus, so "drew nothing" and
    // "never triggered" are different outcomes and only the second is this card.
    expect(heldItems(holdUnitsChosenBySpell(tree({ inBase: ["b1"] }), 0, ["b1"])), "a unit in base was held").toHaveLength(
      0,
    );
    expect(
      heldItems(holdUnitsChosenBySpell(tree({ enemyAtTree: ["e1"] }), 0, ["e1"])),
      "an enemy unit was held",
    ).toHaveLength(0);
  });

  it("...and DOES place one for a friendly unit here — the control", () => {
    expect(
      heldItems(holdUnitsChosenBySpell(tree({ atTree: ["u1"] }), 0, ["u1"])),
      "nothing was held, so the two assertions above prove nothing",
    ).toHaveLength(1);
  });
});

describe("'for the FIRST time each turn'", () => {
  it("a spell naming TWO friendly units here draws only once", () => {
    expect(handAfter(tree({ atTree: ["u1", "u2"] }), 0, ["u1", "u2"]).map((c) => c.name), "the second choice drew too").toEqual(
      ["Top"],
    );
  });

  it("both choices really DID trigger — the allowance is a RESOURCE, not a condition", () => {
    // The distinction the registry entry's comment turns on, asserted rather than
    // assumed: two Pending Items are placed and only the first resolves to a draw.
    // An implementation that suppressed the second at trigger time would pass the
    // test above and be a different card on the chain.
    expect(
      heldItems(holdUnitsChosenBySpell(tree({ atTree: ["u1", "u2"] }), 0, ["u1", "u2"])),
      "the second choice was suppressed at trigger time instead of at resolution",
    ).toHaveLength(2);
  });

  it("a second spell later the same turn draws nothing", () => {
    const first = resolveHeldTriggers(holdUnitsChosenBySpell(tree({ atTree: ["u1"] }), 0, ["u1"]));
    expect(first.players[0]!.hand, "the first spell did not draw").toHaveLength(1);
    expect(
      resolveHeldTriggers(holdUnitsChosenBySpell(first, 0, ["u1"])).players[0]!.hand,
      "a second spell drew again in the same turn",
    ).toHaveLength(1);
  });

  it("is per BATTLEFIELD, not per player", () => {
    // The allowance is keyed by battlefield id, so a second Tree draws again in
    // the same turn.
    const state = tree({ atTree: ["u1"] });
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      defId: THE_DREAMING_TREE,
      units: { p1: [makeUnit({ instanceId: "u2", name: "u2" })] },
    };
    expect(handAfter(state, 0, ["u1", "u2"]), "a second Dreaming Tree did not draw").toHaveLength(2);
  });

  it("resets on the next turn", () => {
    const first = resolveHeldTriggers(holdUnitsChosenBySpell(tree({ atTree: ["u1"] }), 0, ["u1"]));
    // `turn-manager` clears this list at the turn boundary; cleared directly here
    // so the test pins the ALLOWANCE rather than the whole turn pipeline.
    first.players[0]!.spellChoiceDrawnBattlefieldIds = [];
    expect(
      resolveHeldTriggers(holdUnitsChosenBySpell(first, 0, ["u1"])).players[0]!.hand,
      "the allowance did not reset",
    ).toHaveLength(2);
  });
});

describe("the WIRING — a real spell, through submit", () => {
  it("a played spell that names a friendly unit here fires the Tree", () => {
    // **The half the fixtures above cannot prove.** Every other test in this file
    // calls `holdUnitsChosenBySpell` directly, so a mutant that deleted the call
    // in `execute-play-card` would leave them all green while the Tree never
    // fired in a real game — which is precisely the state the probe found it in.
    //
    // The spell is taken from what the ENUMERATOR offers against the friendly
    // unit, not filtered out of the registry by text: a spell picked on its
    // printing alone may need a domain, a cost or a board this fixture lacks.
    const registry = defaultCardRegistry();
    const state = tree({ atTree: ["u1"] });
    state.players[0]!.hand = registry
      .all()
      .filter((d) => d.type === "Spell")
      .slice(0, 60)
      .map((d) => createCardInstance(registry.get(d.id)));
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
      state: "Ready" as const,
    }));

    const play = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.kind === "Spell" && a.targetUnitInstanceId === "u1",
    );
    expect(play, "no spell could be played naming the friendly unit — the test measures nothing").toBeDefined();

    const after = submit(state, play!);
    expect(after.result.type, "the play was refused").toBe("Ok");
    // **Both arrays, because a real play leaves it in neither one alone.** The
    // fixtures above raise the moment and stop, so the item is still a Pending
    // Item; submit() runs the whole announcement, which promotes it onto the
    // CHAIN beside the spell that caused it — 383.3, "a Triggered Ability
    // behaves like an Activated Ability and is placed on the Chain".
    //
    // Asserting only on pendingTriggers failed here against wiring that is
    // correct, and that is worth recording rather than quietly widening: this is
    // where the item lives at each stage, not a looser check. The probe that
    // found this card reads both for the same reason.
    const raised = [...after.state.pendingTriggers, ...after.state.spellChain].filter(
      (e) =>
        "source" in e && e.source === "battlefield" && "listenerDefId" in e && e.listenerDefId === THE_DREAMING_TREE,
    );
    expect(raised, "playing a spell at a friendly unit here did not fire the Tree").toHaveLength(1);
  });
});
