import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { COMPLETE_BATTLEFIELD_SETS } from "../src/engine/coverage.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { UnitDefinition } from "../src/model/card-definition.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **Dragon Roost (VEN-157) — the last of the 25, and the one I deferred twice.**
 *
 * "Any player may pay [2 rainbow] as an additional cost to play a Dragon. If they
 * do, they play it to this battlefield."
 *
 * # Why it was deferred, and what was actually true
 *
 * The first deferral said the destination fan-out was the blocker. It was not —
 * a Unit's destinations are already enumerated one battlefield at a time, so the
 * paid variant is one more emission inside that loop, and it exists ONLY at the
 * Roost. "They play it to this battlefield" is therefore enforced by construction
 * on the enumerator side: there is no paid variant pointing anywhere else.
 *
 * The real cost was the PAYMENT. The variant's price is re-derived from whichever
 * base it is actually paying — a replaced cost (`[Flow]`), an XP-discounted one,
 * or the printed one — and that base is computed 700 lines above the destination
 * loop. Guessing it there would have reintroduced this file's own sixth
 * offered-then-refused bug, which its comment records by name. The base is
 * captured where it is computed and carried down.
 *
 * # What this file is really testing
 *
 * The two pips are the easy half. **The dangerous half is that the enumerator and
 * the validator agree**, because the AI takes an enumerated action straight to the
 * executor: an offered action the validator refuses is a crash mid-game, and this
 * codebase has produced that six times. So every enumerated Roost action is fed
 * back through `validatePlayCard` here, which is the only assertion that can see
 * it.
 */

const DRAGON_ROOST = "VEN-157";
const registry = defaultCardRegistry();

/**
 * A real Dragon that can actually be paid for on a fixture board, and a real
 * non-Dragon unit for the control.
 *
 * **Typed as UnitDefinition, not CardDefinition.** The union includes Legend,
 * which has no `energyCost` — the same definition-shape trap this session hit
 * five times, and `tsc` caught it here too while vitest ran green.
 */
const units = registry.all().filter((d): d is UnitDefinition => d.type === "Unit");
const DRAGON = units.find((d) => (d.tags ?? []).includes("Dragon") && d.energyCost <= 3)!;
const NOT_DRAGON = units.find((d) => !(d.tags ?? []).includes("Dragon") && d.energyCost <= 3)!;

/** bf1 IS the Roost; the player holds `defIds` and has plenty of every domain. */
function roostBoard(defIds: string[], roost = true): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    ...(roost ? { defId: DRAGON_ROOST } : {}),
    units: { p1: [makeUnit({ instanceId: "g", name: "Garrison" })] },
  };
  // A garrison at bf2 as well: a reinforce needs PRESENCE at its destination, so
  // without this the Dragon is playable only to the Roost and the "sent
  // elsewhere" control below has no action to build on.
  state.battlefields[1] = {
    ...state.battlefields[1]!,
    units: { p1: [makeUnit({ instanceId: "g2", name: "Garrison 2" })] },
  };
  state.players[0]!.hand = defIds.map((id) => createCardInstance(registry.get(id)));
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

const roostPlays = (state: GameState) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.dragonRoostPaid === true);

describe("the card is what this file thinks it is", () => {
  it("prints the Dragon clause, and the fixtures are real", () => {
    const def = loadBattlefieldDefinitions().find((d) => d.id === DRAGON_ROOST);
    expect(def?.name, "VEN-157 is not Dragon Roost").toBe("Dragon Roost");
    expect(def?.text, "the printed text has changed under the implementation").toContain("Dragon");

    // Positive controls on the fixtures: without these, "no paid play was
    // offered" below could mean the pool has no affordable Dragon at all.
    expect(DRAGON, "no affordable Dragon in the pool").toBeDefined();
    expect(NOT_DRAGON, "no affordable non-Dragon unit in the pool").toBeDefined();
    expect(DRAGON.tags ?? [], "the Dragon fixture is not tagged Dragon").toContain("Dragon");
  });
});

describe("the paid variant is offered, and only where it should be", () => {
  it("offers a paid play for a Dragon while a Roost is in play", () => {
    const plays = roostPlays(roostBoard([DRAGON.id]));
    expect(plays.length, "no paid Dragon Roost play was offered").toBeGreaterThan(0);
  });

  it("offers it ONLY to the Roost — 'they play it to this battlefield'", () => {
    // The clause, enforced by construction: the paid variant is emitted inside
    // the destination loop and only at the Roost, so there is nothing pointing
    // elsewhere for the validator to have to refuse.
    const state = roostBoard([DRAGON.id]);
    for (const play of roostPlays(state)) {
      expect(play.destinationBattlefieldId, "a paid variant pointed away from the Roost").toBe("bf1");
    }
  });

  it("does NOT offer it for a non-Dragon", () => {
    expect(roostPlays(roostBoard([NOT_DRAGON.id])), "a non-Dragon was offered the additional cost").toHaveLength(0);
  });

  it("does NOT offer it with no Roost in play — the control", () => {
    expect(roostPlays(roostBoard([DRAGON.id], false)), "the cost was offered with no Roost").toHaveLength(0);
  });

  it("still offers the UNPAID play beside it — the cost is optional", () => {
    // "MAY pay". A version that replaced the plain reinforce rather than adding
    // to it would force every Dragon onto the Roost and be a different card.
    // **Scoped to the ROOST**, not to the Dragon anywhere. Counting every
    // destination let a mutant that REPLACED the Roost's plain reinforce survive,
    // because the play to bf2 was still there to be counted.
    const state = roostBoard([DRAGON.id]);
    const atRoost = legalActions(state).filter(
      (a) =>
        a.type === "PlayCard" &&
        a.card.defId === DRAGON.id &&
        a.destinationBattlefieldId === "bf1" &&
        a.dragonRoostPaid !== true,
    );
    expect(atRoost.length, "the unpaid play to the Roost disappeared — the optional cost became mandatory").toBeGreaterThan(
      0,
    );
  });

  it("does not offer it when the two extra pips are unaffordable — 416.3", () => {
    const state = roostBoard([DRAGON.id]);
    // Exactly the Dragon's own price and not a pip more.
    state.players[0]!.channeled = Array.from({ length: DRAGON.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    expect(roostPlays(state), "an unaffordable additional cost was offered").toHaveLength(0);
  });
});

describe("the ENUMERATOR and the VALIDATOR agree — the bug this card could reintroduce", () => {
  it("every offered paid play is accepted by the validator", () => {
    // **The assertion that matters.** The AI takes an enumerated action straight
    // to the executor, so an offered play the validator refuses is a crash
    // mid-game — six times over in this file's history. Nothing else here can
    // see that.
    const state = roostBoard([DRAGON.id]);
    const plays = roostPlays(state);
    expect(plays.length, "nothing was offered, so this proves nothing").toBeGreaterThan(0);
    for (const play of plays) {
      const result = validatePlayCard(state, play);
      expect(result.ok, `an offered Dragon Roost play was refused: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("...and it really executes, landing the Dragon on the Roost", () => {
    const state = roostBoard([DRAGON.id]);
    const play = roostPlays(state)[0]!;
    const before = state.players[0]!.channeled.filter((r) => r.state === "Ready").length;

    const after = submit(state, play);
    expect(after.result.type, "the paid play was refused by the engine").toBe("Ok");
    expect(
      (after.state.battlefields[0]!.units.p1 ?? []).some((u) => u.defId === DRAGON.id),
      "the Dragon did not land on the Roost",
    ).toBe(true);
    // The two extra pips really left the pool: the play spent MORE than its own
    // printed Energy would have.
    const spent = before - after.state.players[0]!.channeled.filter((r) => r.state === "Ready").length;
    expect(spent, "the additional cost was not actually paid").toBeGreaterThan(DRAGON.energyCost);
  });
});

describe("a hand-built action cannot cheat", () => {
  it("refuses the flag on a non-Dragon", () => {
    const state = roostBoard([NOT_DRAGON.id]);
    const base = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === NOT_DRAGON.id && a.destinationBattlefieldId === "bf1",
    );
    expect(base, "the control card was not playable to bf1 at all").toBeDefined();
    // **Asserted on the REASON, not just on the refusal.** A play can be refused
    // for a payment mismatch too, so `ok === false` alone let a mutant that
    // removed this guard entirely survive — the action was still refused, just
    // for something else.
    const refused = validatePlayCard(state, { ...base!, dragonRoostPaid: true });
    expect(refused.ok, "a non-Dragon was allowed to claim the additional cost").toBe(false);
    expect(refused.ok === false && refused.error, "refused for the wrong reason").toContain("is not a Dragon");
  });

  it("refuses the flag when the Dragon is sent elsewhere", () => {
    // "IF THEY DO, they play it to this battlefield" — the destination is the
    // thing bought, so claiming the cost and landing somewhere else must fail.
    const state = roostBoard([DRAGON.id]);
    const elsewhere = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.defId === DRAGON.id && a.destinationBattlefieldId === "bf2",
    );
    expect(elsewhere, "the Dragon was not playable to another battlefield at all").toBeDefined();
    const refused = validatePlayCard(state, { ...elsewhere!, dragonRoostPaid: true });
    expect(refused.ok, "a paid Dragon was allowed to land away from the Roost").toBe(false);
    expect(refused.ok === false && refused.error, "refused for the wrong reason").toContain(
      "plays the Dragon to that battlefield",
    );
  });

  it("refuses the flag with no Roost in play", () => {
    const state = roostBoard([DRAGON.id], false);
    const base = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === DRAGON.id && a.destinationBattlefieldId === "bf1",
    );
    expect(base, "the Dragon was not playable at all").toBeDefined();
    const refused = validatePlayCard(state, { ...base!, dragonRoostPaid: true });
    expect(refused.ok, "the cost was claimable with no Roost on the board").toBe(false);
    expect(refused.ok === false && refused.error, "refused for the wrong reason").toContain("no Dragon Roost in play");
  });
});

describe("every battlefield in the game is now hard-gated", () => {
  it("all four sets are in COMPLETE_BATTLEFIELD_SETS", () => {
    // The end of the nine-wave pass: 64 printed battlefields, all implemented,
    // all under the gate rather than reported as progress.
    expect([...COMPLETE_BATTLEFIELD_SETS].sort(), "a set is still unprotected").toEqual(["OGN", "SFD", "UNL", "VEN"]);
  });
});
