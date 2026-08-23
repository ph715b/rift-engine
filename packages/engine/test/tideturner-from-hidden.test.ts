import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Tideturner (OGN-199) played FROM HIDDEN must still fire its on-play trigger.**
 *
 * Reported from play 2026-08-23: "tideturner when played from hidden is not
 * triggering for some reason."
 *
 * He prints `[Hidden]` and "when you play me, you may choose a unit you control
 * at another location. Move me to its location and it to my original location."
 *
 * A hidden card is played AT the battlefield it was hidden at (813), so the
 * destination is forced — which is exactly what makes his "another location"
 * clause interesting here, and exactly where a swap could quietly become
 * impossible without anything reporting it.
 */

const TIDETURNER = "OGN-199";
const BLASTCONE_FAE = "OGN-097"; // the rulebook's example for the CONFINEMENT half
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Tideturner hidden at bf2 since an earlier turn, with a friendly unit standing
 *  somewhere else for the swap to name. */
function hiddenAt(opts: { elsewhereAt?: string } = {}): GameState {
  const state = makeState({ phase: "Action", turnNumber: 3, activePlayerIndex: 0 });
  state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) =>
    rune(`r${i}`, (["Chaos", "Mind", "Fury", "Calm", "Body", "Order"] as const)[i % 6]!),
  );
  state.battlefields[1] = {
    ...state.battlefields[1]!,
    hiddenCards: [{ ownerIndex: 0, card: realUnitInstance(TIDETURNER), hiddenOnTurn: 1 }],
  };
  if (opts.elsewhereAt !== undefined) {
    const i = state.battlefields.findIndex((bf) => bf.id === opts.elsewhereAt);
    const bf = state.battlefields[i]!;
    state.battlefields[i] = {
      ...bf,
      units: { ...bf.units, p1: [...(bf.units.p1 ?? []), makeUnit({ instanceId: "elsewhere", name: "Elsewhere" })] },
    };
  }
  return state;
}

const hiddenPlays = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.defId === TIDETURNER && a.fromHiddenBattlefieldId !== undefined,
  );

/** Battlefield-independent: did HIS on-play trigger reach the chain or the pen? */
const hisTriggers = (state: GameState) =>
  [...state.pendingTriggers, ...state.spellChain].filter(
    (e) => "listenerDefId" in e && e.listenerDefId === TIDETURNER,
  );

describe("the fixture really offers a hidden play", () => {
  it("Tideturner is playable from face down at all", () => {
    // The positive control. Without it, "no trigger fired" below could simply
    // mean the card was never played.
    expect(hiddenPlays(hiddenAt({ elsewhereAt: "bf1" })).length, "no hidden play of Tideturner was offered").toBeGreaterThan(
      0,
    );
  });

  it("plays him AT the battlefield he was hidden at — 813", () => {
    for (const play of hiddenPlays(hiddenAt({ elsewhereAt: "bf1" }))) {
      expect(play.fromHiddenBattlefieldId, "the hidden play came from the wrong battlefield").toBe("bf2");
    }
  });
});

describe("the reported bug: the on-play trigger from hidden", () => {
  it("fires his trigger when played from face down", () => {
    const state = hiddenAt({ elsewhereAt: "bf1" });
    const play = hiddenPlays(state)[0]!;
    const after = submit(state, play);
    expect(after.result.type, "the hidden play was refused").toBe("Ok");
    expect(hisTriggers(after.state), "playing him from hidden fired no on-play trigger — the reported bug").not.toHaveLength(
      0,
    );
  });

  it("offers the SWAP variant from hidden, naming the unit elsewhere", () => {
    // The half that makes the trigger worth firing. A hidden play whose only
    // variant is the decline would "trigger" and do nothing, which is
    // indistinguishable from not triggering to whoever is holding the card.
    const state = hiddenAt({ elsewhereAt: "bf1" });
    expect(
      hiddenPlays(state).filter((a) => a.targetUnitInstanceId === "elsewhere"),
      "no hidden play could name the unit at another location",
    ).not.toHaveLength(0);
  });

  it("actually SWAPS when that variant is taken", () => {
    // End to end: he ends up where the named unit was, and it ends up at bf2.
    const state = hiddenAt({ elsewhereAt: "bf1" });
    const swap = hiddenPlays(state).find((a) => a.targetUnitInstanceId === "elsewhere");
    expect(swap, "no swap variant to submit").toBeDefined();
    const after = submit(state, swap!);
    expect(after.result.type, "the swap play was refused").toBe("Ok");

    const settled = resolveHeldTriggers(after.state);
    const at = (id: string) => (settled.battlefields.find((bf) => bf.id === id)?.units.p1 ?? []).map((u) => u.defId);
    expect(at("bf1"), "he did not take the named unit's place").toContain(TIDETURNER);
    expect(
      (settled.battlefields.find((bf) => bf.id === "bf2")?.units.p1 ?? []).map((u) => u.instanceId),
      "the named unit did not come back to where he was hidden",
    ).toContain("elsewhere");
  });
});

describe("the ENUMERATOR and the VALIDATOR agree about the exemption", () => {
  it("every offered hidden play is accepted", () => {
    // **The assertion the fix's own comment promises.** `legal-actions` filters
    // through `atHiddenBattlefield` and `validate-play-card` through
    // `isAtBattlefield` — two functions that merely happened to agree, and whose
    // comment claimed they were one. Exempting only the enumerator turned this
    // card from "silently does nothing" into an offered-then-refused, which is
    // the crash-mid-game shape this codebase has produced six times.
    //
    // This is the only thing that fails if either side stops asking
    // `targetMustBeElsewhere`.
    const state = hiddenAt({ elsewhereAt: "bf1" });
    const plays = hiddenPlays(state);
    expect(plays.length, "nothing was offered, so this proves nothing").toBeGreaterThan(0);
    for (const play of plays) {
      const result = validatePlayCard(state, play);
      expect(result.ok, `an offered hidden play was refused: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  /**
   * Blastcone Fae is the rulebook's own example for the OTHER half of
   * 811.1.d.2 — the confinement itself: *"Because this is a play effect, its
   * target must be chosen from among units at the same battlefield if Blastcone
   * Fae was played from Hidden."* Her target carries no impossibility, so she is
   * exactly the card the exemption must NOT reach.
   */
  function faeHiddenAt(): GameState {
    const state = makeState({ phase: "Action", turnNumber: 3, activePlayerIndex: 0 });
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) =>
      rune(`r${i}`, (["Chaos", "Mind", "Fury", "Calm", "Body", "Order"] as const)[i % 6]!),
    );
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      hiddenCards: [{ ownerIndex: 0, card: realUnitInstance(BLASTCONE_FAE), hiddenOnTurn: 1 }],
      units: { p2: [makeUnit({ instanceId: "here", name: "Here" })] },
    };
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p2: [makeUnit({ instanceId: "faraway", name: "Faraway" })] },
    };
    return state;
  }

  const faePlays = (state: GameState) =>
    legalActions(state).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.defId === BLASTCONE_FAE && a.fromHiddenBattlefieldId !== undefined,
    );

  it("the ENUMERATOR still confines an ordinary hidden card's target", () => {
    // **The half that keeps the exemption honest**, and the one a mutant found
    // missing: widening `atHiddenBattlefield` to exempt every hidden card passed
    // every other test here, because they all concern Tideturner.
    const state = faeHiddenAt();
    const plays = faePlays(state);
    expect(plays.length, "the Fae was not playable from hidden at all — this control proves nothing").toBeGreaterThan(0);
    expect(
      plays.filter((a) => a.targetUnitInstanceId === "faraway"),
      "an ordinary hidden card was offered a target off its battlefield",
    ).toHaveLength(0);
    // The positive half: the unit standing WITH her is still offered, so the
    // assertion above is not passing because nothing is targetable at all.
    expect(
      plays.filter((a) => a.targetUnitInstanceId === "here"),
      "no target at her own battlefield was offered either",
    ).not.toHaveLength(0);
  });

  it("...and the VALIDATOR refuses a hand-built one", () => {
    const state = faeHiddenAt();
    const base = faePlays(state)[0]!;
    const forged = validatePlayCard(state, { ...base, targetUnitInstanceId: "faraway" });
    expect(forged.ok, "an ordinary hidden card was allowed to target off its battlefield").toBe(false);
    expect(forged.ok === false && forged.error, "refused for the wrong reason").toContain("must be at that battlefield");
  });
});

describe("the same card from HAND — the comparison that localises it", () => {
  it("fires its trigger from hand too", () => {
    // If this failed as well, the bug would not be about hidden at all. Kept so a
    // future failure says WHICH path broke.
    const state = makeState({ phase: "Action", turnNumber: 3, activePlayerIndex: 0 });
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) =>
      rune(`r${i}`, (["Chaos", "Mind", "Fury", "Calm", "Body", "Order"] as const)[i % 6]!),
    );
    state.players[0]!.hand = [realUnitInstance(TIDETURNER)];
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [makeUnit({ instanceId: "elsewhere", name: "Elsewhere" })] },
    };
    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === TIDETURNER,
    );
    expect(play, "Tideturner was not playable from hand").toBeDefined();
    const after = submit(state, play!);
    expect(after.result.type, "the play from hand was refused").toBe("Ok");
    expect(hisTriggers(after.state), "his trigger does not fire from HAND either").not.toHaveLength(0);
  });
});
