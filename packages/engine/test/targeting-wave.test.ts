import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { contextFor } from "../src/engine/effect-context.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

const registry = defaultCardRegistry();
const VOLIBEAR_FURIOUS = "OGN-041"; // "When I attack, deal 5 damage split among any number of enemy units here."
const DRAGONS_RAGE = "OGN-258"; // "Move an enemy unit. Then... choose another enemy unit at its destination."
const BULLET_TIME = "OGN-268"; // "Pay any amount of rainbow Power to deal that much damage to all enemy units at a battlefield."

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass!);
  }
  return current;
}

const at = (state: GameState, bf: string, owner: string) => state.battlefields.find((b) => b.id === bf)!.units[owner] ?? [];

describe("Volibear - Furious (OGN-041): 5 damage split among enemies here", () => {
  /** Volibear attacking into `mights` worth of enemy bodies at bf1. */
  function splitState(mights: number[]): GameState {
    const state = makeState({ phase: "Action" });
    const voli = realUnitInstance(VOLIBEAR_FURIOUS);
    state.battlefields[0]!.units = {
      p1: [voli],
      p2: mights.map((might, i) => makeUnit({ instanceId: `e${i}`, might })),
    };
    return state;
  }

  // Volibear attacks when the Combat Showdown opens (383.4.f), so the way to make
  // him attack is to contest the battlefield for his controller and let the
  // Cleanup stage it — there is no on-attack dispatcher to call any more.
  const attack = (state: GameState) => beginCombatAt(state, "bf1", 0);

  it("kills as many as the 5 covers, lethal-first in board order", () => {
    // The auto-split is lethal-first, the same model combat's own damage
    // assignment uses (465.2.c) — it maximises bodies removed rather than
    // spreading uselessly. Recorded Unverified: a player might prefer otherwise.
    const settled = attack(splitState([2, 2, 2]));
    const survivors = at(settled, "bf1", "p2");

    expect(survivors.map((u) => u.instanceId), "the first two should be dead").toEqual(["e2"]);
    expect(survivors[0]!.damage, "the leftover 1 did not land").toBe(1);
  });

  it("caps at 5 however many enemies stand there", () => {
    const settled = attack(splitState([9, 9]));
    const survivors = at(settled, "bf1", "p2");
    expect(survivors.reduce((sum, u) => sum + u.damage, 0), "it dealt more or less than 5").toBe(5);
  });

  it("does nothing with no enemies here", () => {
    const state = splitState([]);
    expect(attack(state).battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VOLIBEAR_FURIOUS))).toBe(true);
  });
});

describe("Dragon's Rage (OGN-258): a duel at the destination", () => {
  /** One enemy at bf1, another at bf2, and the spell in hand. */
  function rageState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(DRAGONS_RAGE)];
    state.players[0]!.channeled = [
      ...Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Calm")),
      ...Array.from({ length: 2 }, (_, i) => rune(`b${i}`, "Body")),
    ];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "traveller", might: 3 })] };
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "resident", might: 4 })] };
    return state;
  }

  it("only ever offers a second target at the FIRST one's destination", () => {
    // The relationship the card turns on. Every offered variant must name a
    // second unit standing where the first is being sent — never where it is now.
    const state = rageState();
    const offered = playsFor(state, DRAGONS_RAGE);
    expect(offered.length, "nothing was offered").toBeGreaterThan(0);

    for (const play of offered) {
      const second = play.secondTargetUnitInstanceId!;
      const where = state.battlefields.find((bf) => (bf.units["p2"] ?? []).some((u) => u.instanceId === second))!.id;
      expect(where, `${second} is not at ${play.destinationBattlefieldId}`).toBe(play.destinationBattlefieldId);
    }
  });

  it("REFUSES a hand-built pair whose second target is elsewhere", () => {
    const state = rageState();
    const play = playsFor(state, DRAGONS_RAGE)[0]!;
    const wrong = { ...play, destinationBattlefieldId: "bf1", secondTargetUnitInstanceId: "resident" };
    expect(validatePlayCard(state, wrong)).toMatchObject({ ok: false });
  });

  it("moves the first unit and makes the two fight", () => {
    const state = rageState();
    const play = playsFor(state, DRAGONS_RAGE).find(
      (p) => p.targetUnitInstanceId === "traveller" && p.destinationBattlefieldId === "bf2",
    )!;
    const settled = resolveChain(accept(state, play));

    // 3 Might into a 4, and 4 back into the 3 — so the traveller dies and the
    // resident survives with 3 marked.
    expect(at(settled, "bf2", "p2").map((u) => u.instanceId)).toEqual(["resident"]);
    expect(at(settled, "bf2", "p2")[0]!.damage).toBe(3);
  });

  it("is UNCASTABLE with only one enemy unit — both choices are mandatory", () => {
    const state = rageState();
    state.battlefields[1]!.units = {};
    expect(playsFor(state, DRAGONS_RAGE)).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(DRAGONS_RAGE))).toBe(true);
  });
});

describe("Bullet Time (OGN-268): pay any amount of rainbow Power", () => {
  function bulletState(runeCount: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(BULLET_TIME)];
    state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`r${i}`, i % 2 === 0 ? "Body" : "Chaos"));
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", might: 9 })],
      p2: [makeUnit({ instanceId: "a", might: 9 }), makeUnit({ instanceId: "b", might: 9 })],
    };
    return state;
  }

  it("offers one variant per affordable X, including zero", () => {
    // "Any amount" includes none — the card still costs its printed Energy, and
    // casting it for nothing is occasionally what a player wants.
    const xs = playsFor(bulletState(4), BULLET_TIME)
      .filter((p) => p.targetBattlefieldId === "bf1")
      .map((p) => p.xAmount)
      .sort((m, n) => (m ?? 0) - (n ?? 0));

    expect(xs[0]).toBe(0);
    expect(xs.length, "the fan-out did not scale with the pool").toBeGreaterThan(1);
  });

  it("deals X to every ENEMY unit there and none to your own", () => {
    const state = bulletState(5);
    const play = playsFor(state, BULLET_TIME).find((p) => p.targetBattlefieldId === "bf1" && p.xAmount === 3)!;
    const settled = resolveChain(accept(state, play));

    expect(at(settled, "bf1", "p2").map((u) => u.damage)).toEqual([3, 3]);
    expect(at(settled, "bf1", "p1")[0]!.damage, "it hit the caster's own unit").toBe(0);
  });

  it("REFUSES an X that does not match the rainbow runes supplied", () => {
    // A hand-built action could otherwise claim a large X and pay nothing.
    const state = bulletState(5);
    const play = playsFor(state, BULLET_TIME).find((p) => p.xAmount === 2)!;
    expect(validatePlayCard(state, { ...play, xAmount: 5 })).toMatchObject({ ok: false });
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BULLET_TIME))).toBe(true);
  });
});
