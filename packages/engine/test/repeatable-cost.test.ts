import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * A REPEATABLE additional cost — "you may spend ANY NUMBER of X as an additional
 * cost, reduce my cost by 1 Power for each".
 *
 * The count is bounded by the card, not by a cap this engine invented: reducing
 * a cost cannot take it below zero, so a fifth buff spent on a 4-Power Ledros
 * buys nothing. That is what keeps the fan-out to a handful of variants instead
 * of the powerset of the caster's own board.
 *
 * WHICH units are spent still matters — Ledros is choosing what to kill — so the
 * enumerator samples weakest-first and the validator accepts ANY legal set. The
 * same split `unitList` targeting makes, and the same reason: a human clicking
 * their own choice must not be limited to the AI's sample.
 */

const registry = defaultCardRegistry();
const KRAKEN_HUNTER = "OGN-150"; // 3 Energy / 2 Body — spend any number of buffs
const LEDROS = "OGN-231"; // 6 Energy / 4 Order — kill any number of friendly units

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** `defId` in hand, `runeCount` runes of its domain, and `units` in base. */
function withCard(defId: string, runeCount: number, units: UnitInstance[]): GameState {
  const def = registry.get(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [createCardInstance(def)];
  state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) =>
    rune(`r${i}`, (def.type === "Unit" ? def.powerDomain : null) ?? "Body"),
  );
  state.players[0]!.baseUnits = units;
  return state;
}

const spend = (play: PlayCardAction) => play.additionalCostUnitInstanceIds?.length ?? 0;

/** The plain (non-accelerated) plays. Kraken Hunter carries [Accelerate], so
 *  every discount count has an accelerated twin — and the two are priced
 *  differently, which is the whole reason the accelerated payment had to become
 *  variant-aware. */
const plainPlays = (state: GameState, defId: string) => playsFor(state, defId).filter((p) => p.acceleratePaid !== true);

describe("Kraken Hunter (OGN-150): spend any number of buffs", () => {
  const buffed = (n: number) => Array.from({ length: n }, (_, i) => makeUnit({ instanceId: `b${i}`, might: 2 + i, buffed: true }));

  it("offers a variant per count, capped by the printed Power cost", () => {
    // Three buffed units, but the card prints 2 Power — so 0, 1 and 2 are the
    // only counts worth offering. A third buff would reduce a cost that is
    // already zero.
    const state = withCard(KRAKEN_HUNTER, 10, buffed(3));
    const counts = new Set(plainPlays(state, KRAKEN_HUNTER).map(spend));

    expect([...counts].sort()).toEqual([0, 1, 2]);
  });

  it("actually discounts — two buffs spent means two fewer Power runes", () => {
    const state = withCard(KRAKEN_HUNTER, 10, buffed(2));
    const plays = plainPlays(state, KRAKEN_HUNTER);
    const plain = plays.find((p) => spend(p) === 0)!;
    const discounted = plays.find((p) => spend(p) === 2)!;

    expect(plain.payment.powerRunes).toHaveLength(2);
    expect(discounted.payment.powerRunes, "the discount did not reach the payment").toHaveLength(0);
  });

  it("SPENDS the buffs it named", () => {
    const state = withCard(KRAKEN_HUNTER, 10, buffed(2));
    const played = accept(state, plainPlays(state, KRAKEN_HUNTER).find((p) => spend(p) === 2)!);

    expect(played.players[0]!.baseUnits.filter((u) => u.buffed), "the buffs were not spent").toHaveLength(0);
  });

  it("offers only the decline variant with no buffed units", () => {
    const state = withCard(KRAKEN_HUNTER, 10, [makeUnit({ instanceId: "plain", might: 3 })]);
    expect(new Set(playsFor(state, KRAKEN_HUNTER).map(spend))).toEqual(new Set([0]));
  });

  it("REFUSES an unbuffed unit named as the cost", () => {
    // The per-unit eligibility the repeatable branch has to apply per member —
    // one shared helper with the single-unit path, so the two cannot diverge.
    const state = withCard(KRAKEN_HUNTER, 10, [...buffed(1), makeUnit({ instanceId: "plain", might: 3 })]);
    const play = plainPlays(state, KRAKEN_HUNTER).find((p) => spend(p) === 1)!;

    expect(validatePlayCard(state, { ...play, additionalCostUnitInstanceIds: ["plain"] })).toMatchObject({ ok: false });
  });

  it("REFUSES the same unit twice", () => {
    const state = withCard(KRAKEN_HUNTER, 10, buffed(1));
    const play = plainPlays(state, KRAKEN_HUNTER).find((p) => spend(p) === 1)!;

    expect(validatePlayCard(state, { ...play, additionalCostUnitInstanceIds: ["b0", "b0"] })).toMatchObject({ ok: false });
  });

  it("the enumerator and the validator agree — including the ACCELERATED variants", () => {
    // The bug this caught: [Accelerate] was priced once per card, so an
    // accelerated Kraken Hunter ignored the buff discount entirely and was
    // offered at 3 Power while the validator, re-deriving from the discounted
    // cost, wanted 1. Offered-then-refused, and invisible to any test that only
    // enumerated or only validated.
    const state = withCard(KRAKEN_HUNTER, 10, buffed(2));
    const plays = playsFor(state, KRAKEN_HUNTER);
    expect(plays.some((p) => p.acceleratePaid === true), "no accelerated variant, so this proves nothing").toBe(true);
    for (const play of plays) {
      expect(validatePlayCard(state, play), `spend ${spend(play)} accel ${play.acceleratePaid === true}`).toMatchObject({ ok: true });
    }
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KRAKEN_HUNTER))).toBe(true);
  });
});

describe("Commander Ledros (OGN-231): kill any number of friendly units", () => {
  const bodies = (n: number) => Array.from({ length: n }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 1 + i }));

  it("is castable with FOUR fewer Power by killing four units", () => {
    // The card's whole point, and the reason the affordability guard had to learn
    // about repeatable costs: with no Power runes at all, the printed price is
    // unpayable and only the discounted variants exist.
    const state = withCard(LEDROS, 6, bodies(4));
    const plays = playsFor(state, LEDROS);

    expect(plays.length, "Ledros was not offered at all").toBeGreaterThan(0);
    expect(Math.max(...plays.map(spend)), "the full discount was never offered").toBe(4);
    expect(plays.find((p) => spend(p) === 4)!.payment.powerRunes).toHaveLength(0);
  });

  it("KILLS the units it named, and they reach the trash", () => {
    const state = withCard(LEDROS, 6, bodies(4));
    const played = accept(state, playsFor(state, LEDROS).find((p) => spend(p) === 4)!);

    expect(played.players[0]!.baseUnits.filter((u) => u.instanceId.startsWith("u"))).toHaveLength(0);
    expect(played.players[0]!.trash.filter((c) => c.kind === "Unit")).toHaveLength(4);
  });

  it("samples WEAKEST-FIRST, and the validator still accepts a bigger body", () => {
    // The enumerator picks what a player almost always would; the validator must
    // not make that the only legal play.
    const state = withCard(LEDROS, 6, bodies(4));
    const one = playsFor(state, LEDROS).find((p) => spend(p) === 1)!;
    expect(one.additionalCostUnitInstanceIds, "the sample was not weakest-first").toEqual(["u0"]);

    expect(validatePlayCard(state, { ...one, additionalCostUnitInstanceIds: ["u3"] })).toMatchObject({ ok: true });
  });

  it("REFUSES spending past the printed Power cost", () => {
    const state = withCard(LEDROS, 12, bodies(5));
    const play = playsFor(state, LEDROS).find((p) => spend(p) === 4)!;

    expect(validatePlayCard(state, { ...play, additionalCostUnitInstanceIds: ["u0", "u1", "u2", "u3", "u4"] })).toMatchObject({
      ok: false,
    });
  });

  it("the enumerator and the validator agree — every offered play is accepted", () => {
    const state = withCard(LEDROS, 8, bodies(4));
    const plays = playsFor(state, LEDROS);
    expect(plays.length, "nothing was offered — this proves nothing").toBeGreaterThan(0);
    for (const play of plays) {
      expect(validatePlayCard(state, play), `spend ${spend(play)}`).toMatchObject({ ok: true });
    }
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(LEDROS))).toBe(true);
  });
});
