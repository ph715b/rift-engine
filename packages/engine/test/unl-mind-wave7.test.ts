import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { placeToken, placeGoldTokens, RECRUIT_TOKEN, type TokenSpec } from "../src/engine/token.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance, resolveHeldTriggers, answerDecisions } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/**
 * **Zilean - Time Mage (UNL-086) — "Once each turn, if you would play a token
 * unit while I'm at a battlefield, you may play that token and an additional copy
 * of it instead."**
 *
 * The rules use this card BY NAME as their worked example for 371.2.b, which is
 * what settles the one genuinely ambiguous thing about it: declining does not
 * spend the turn's use. "When his controller plays a token, they can choose not
 * to apply the replacement effect to that event. If they do, they can choose to
 * apply it to a later event of a token being played."
 *
 * # What these tests are actually watching
 *
 * The card is a REPLACEMENT effect (371) implemented as a `cardPlayed` listener,
 * because this engine has no replacement layer for playing a token — see the
 * entry in effects/mind.ts for the two divergences that creates. So every test
 * here drives the REAL hold-and-resolve path (`resolveHeldTriggers`, which runs
 * the Cleanup and the two PassFocus actions a Pending Item costs) rather than
 * calling the trigger's `resolve`. A trigger that is registered, enumerated and
 * never reached looks exactly like a working one from the resolver's own seat.
 *
 * The four negative controls are the point of the file: the copy must NOT happen
 * for a non-token unit, for a Gold GEAR token, for an opponent's token, or while
 * Zilean is standing in base. Each of those is one dropped condition away from
 * firing, and each would still leave the happy-path assertion green.
 */

const ZILEAN = "UNL-086";
const SPRITE_BURST = "UNL-069"; // "Play TWO ready 3 [Might] Sprite unit tokens with [Temporary]" — 5 Energy, Mind
const SENTRY = "UNL-111"; // Determined Sentry, 1 Energy — a real unit that is NOT a token
const SPRITE_MIGHT = 3;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** The Sprite spec Sprite Call and Sprite Burst both mint, re-declared here so a
 *  copy that silently loses `[Temporary]` or its readiness fails rather than
 *  agreeing with whatever the engine happens to produce. */
const SPRITE: TokenSpec = { name: "Sprite", might: SPRITE_MIGHT, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };

/**
 * Player 0 with a Zilean, at `bf1` unless `inBase`.
 *
 * Plenty of Mind runes so an enumerated play is never refused for price — this
 * file is about the trigger, and Atakhan's file is where pricing is measured.
 */
function board(options: { inBase?: boolean; hand?: UnitInstance[] } = {}): { state: GameState; zilean: UnitInstance } {
  const zilean = realUnitInstance(ZILEAN);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`m${i}`, "Mind"));
  if (options.hand) state.players[0]!.hand = options.hand;
  if (options.inBase) state.players[0]!.baseUnits = [zilean];
  else state.battlefields[0]!.units[state.players[0]!.id] = [zilean];
  return { state, zilean };
}

/**
 * Drives held triggers AND the questions they raise to a standstill.
 *
 * `resolveHeldTriggers` deliberately stops at a pending decision so the caller
 * keeps the answer, and Zilean's answer PLACES A TOKEN, which holds a fresh
 * trigger — so one round of each is not enough. The guard is what would catch a
 * Zilean who doubles his own copy forever; the once-each-turn mark is the only
 * thing stopping him.
 */
function settle(state: GameState, pick?: (options: DecisionOption[]) => string): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    const advanced = resolveHeldTriggers(current);
    if (advanced.pendingDecisions.length === 0) return advanced;
    current = answerDecisions(advanced, pick);
  }
  throw new Error("settle: the board never quiesced — Zilean is doubling without end");
}

const takeCopy = (options: DecisionOption[]): string => options.find((o) => o.id === "copy")?.id ?? options[0]!.id;
const decline = (options: DecisionOption[]): string => options.find((o) => o.id === "decline")?.id ?? options[0]!.id;

/** Every unit `playerIndex` has anywhere, base and battlefields alike. */
const unitsOf = (state: GameState, playerIndex: 0 | 1): UnitInstance[] => [
  ...state.players[playerIndex]!.baseUnits,
  ...state.battlefields.flatMap((bf) => bf.units[state.players[playerIndex]!.id] ?? []),
];

const tokensNamed = (state: GameState, playerIndex: 0 | 1, name: string): UnitInstance[] =>
  unitsOf(state, playerIndex).filter((u) => u.isToken === true && u.name === name);

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/**
 * Pending Items Zilean has placed but not yet resolved.
 *
 * **This is what makes the negative controls bite, and it was MEASURED rather
 * than assumed.** The first version of this file asserted only the board, and
 * three mutations survived it: deleting `isToken`, `playedKind === "Unit"` or
 * `casterIndex === listener.ownerIndex` from `applies` changed nothing, because
 * `resolve` re-checks all three and returns the state untouched. The card was
 * still correct — but the tests were measuring the second gate, not the first,
 * and `applies` exists precisely so a trigger that did not trigger places NO
 * item: an item costs both players a PassFocus and closes the chain for an
 * ability that will do nothing. So every "must not fire" test asserts this too.
 *
 * **BOTH queues, and that is a second measured defect rather than caution.**
 * Counting `pendingTriggers` alone reported 0 for every `submit()`-driven play,
 * because `submit` runs the Cleanup that finalizes pending items ONTO THE CHAIN
 * as part of the action — so the "a real unit card is not doubled" control was
 * asserting nothing, and the mutation that deletes `isToken` from `applies`
 * survived it. A trigger is outstanding in one queue or the other, never
 * neither, so the sum is the only figure that answers the question at both
 * kinds of call site.
 */
const heldForZilean = (state: GameState): number =>
  [...state.pendingTriggers, ...state.spellChain].filter(
    (entry) => "listenerDefId" in entry && entry.listenerDefId === ZILEAN,
  ).length;

describe("Zilean - Time Mage doubles a token you play, once each turn", () => {
  it("is registered at all", () => {
    // The cheapest possible check, and the one that would have caught this card
    // being written into a file nothing composes.
    expect(isCardImplemented(defaultCardRegistry().get(ZILEAN)), "UNL-086 is not registered anywhere").toBe(true);
  });

  it("a Sprite Burst cast through submit() puts THREE Sprites on the board, not two", () => {
    // The end-to-end control: a real card, enumerated by `legalActions`, paid for
    // and submitted. Sprite Burst plays two tokens, so this also proves the
    // once-each-turn cap inside a single resolution — 2 printed + 1 copy = 3.
    const burst = { ...realUnitInstance(SPRITE_BURST) };
    const { state } = board({ hand: [burst as unknown as UnitInstance] });

    const play = playsOf(state, burst.instanceId)[0];
    expect(play, "Sprite Burst was never offered").toBeDefined();
    const { state: cast, result } = submit(state, play!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    const settled = settle(cast, takeCopy);
    expect(tokensNamed(settled, 0, "Sprite").length, "the copy never arrived (or arrived twice)").toBe(3);
  });

  it("the copy is the SAME token — Might, tag, readiness and [Temporary] all carried", () => {
    // "An additional COPY of it". A copy that lost `[Temporary]` would be a
    // strictly better card than the one printed, and nothing about the count
    // above can see it.
    const { state } = board();
    const played = placeToken(state, 0, "base", SPRITE);
    // The positive control for `heldForZilean` itself. Without it a helper
    // reading the wrong field would answer 0 everywhere and hand all four
    // negative controls a free pass — 0/0 reads exactly like a pass.
    expect(heldForZilean(played), "Zilean placed no Pending Item for a token he should double").toBe(1);

    const settled = settle(played, takeCopy);
    const sprites = tokensNamed(settled, 0, "Sprite");

    expect(sprites.length).toBe(2);
    for (const sprite of sprites) {
      expect(sprite.might, "the copy is not a 3 Might Sprite").toBe(SPRITE_MIGHT);
      expect(sprite.tags, "the copy lost its tag, so aura tables would miss it").toContain("Sprite");
      expect(sprite.keywords.Temporary, "the copy lost [Temporary] — a free permanent body").toBe(1);
      expect(sprite.exhausted, "the copy of a READY token arrived exhausted").toBe(false);
    }
  });

  it("a token played to a BATTLEFIELD is copied to that battlefield, not to base", () => {
    // The other half of `destinationOf`. A copy that fell home would never
    // contest anything, which is most of what a token at a battlefield is for.
    const { state } = board();
    const settled = settle(placeToken(state, 0, { battlefieldId: "bf2" }, SPRITE), takeCopy);

    const atBf2 = (settled.battlefields.find((bf) => bf.id === "bf2")!.units[settled.players[0]!.id] ?? []).filter(
      (u) => u.name === "Sprite",
    );
    expect(atBf2.length, "the copy did not land where the original was played").toBe(2);
    expect(settled.players[0]!.baseUnits.some((u) => u.name === "Sprite"), "the copy fell home").toBe(false);
  });

  it("a SECOND token play in the same turn is not doubled — 371.1", () => {
    // "Once each turn." The mark lives on Zilean (`abilityModesUsedThisTurn`), so
    // this is also the test that the mark is written where a second trigger can
    // see it.
    const { state } = board();
    const first = settle(placeToken(state, 0, "base", RECRUIT_TOKEN), takeCopy);
    expect(tokensNamed(first, 0, "Recruit").length, "the first token was not doubled").toBe(2);

    const playedAgain = placeToken(first, 0, "base", RECRUIT_TOKEN);
    // The `applies` half of the cap: a spent Zilean must place no Pending Item at
    // all. Without this the board count below passes on a build that holds an
    // item, costs both players a PassFocus and then resolves to nothing.
    expect(heldForZilean(playedAgain), "a spent Zilean still placed a Pending Item").toBe(0);

    const second = settle(playedAgain, takeCopy);
    expect(second.pendingDecisions.length, "a spent Zilean asked again").toBe(0);
    expect(tokensNamed(second, 0, "Recruit").length, "the second token was doubled too — the cap did not hold").toBe(3);
  });

  it("DECLINING does not spend the turn's use — 371.2.b, and Zilean is its worked example", () => {
    // 371.2.b: "If they do not, it has not been applied this turn", with this very
    // card in the example. The easy implementation — a mandatory doubling, or a
    // mark written when the question is asked — gets this backwards, and every
    // other test in this file passes under both.
    const { state } = board();
    const declined = settle(placeToken(state, 0, "base", RECRUIT_TOKEN), decline);
    expect(tokensNamed(declined, 0, "Recruit").length, "declining copied anyway").toBe(1);

    const later = settle(placeToken(declined, 0, "base", RECRUIT_TOKEN), takeCopy);
    expect(tokensNamed(later, 0, "Recruit").length, "a declined application was charged as if used").toBe(3);
  });
});

describe("the four ways Zilean must NOT fire", () => {
  it("NEGATIVE: he does nothing while standing in BASE", () => {
    // "While I'm at a battlefield." This is the condition with no other guard in
    // front of it: drop `listener.battlefieldId !== undefined` and every positive
    // test above still passes.
    const { state } = board({ inBase: true });
    const played = placeToken(state, 0, "base", RECRUIT_TOKEN);
    expect(heldForZilean(played), "a Zilean in base placed a Pending Item").toBe(0);

    const settled = settle(played, takeCopy);
    expect(settled.pendingDecisions.length, "a Zilean in base asked the question").toBe(0);
    expect(tokensNamed(settled, 0, "Recruit").length, "a Zilean in base doubled a token").toBe(1);
  });

  it("NEGATIVE: an OPPONENT's token is not doubled", () => {
    // "If YOU would play a token unit." Without `casterIndex === ownerIndex` this
    // would hand the opponent a free body, and the count assertion above would
    // never notice.
    const { state } = board();
    const played = placeToken(state, 1, "base", RECRUIT_TOKEN);
    expect(heldForZilean(played), "Zilean placed a Pending Item for an enemy token").toBe(0);

    const settled = settle(played, takeCopy);
    expect(settled.pendingDecisions.length, "Zilean asked about an enemy token").toBe(0);
    expect(tokensNamed(settled, 1, "Recruit").length, "Zilean doubled an enemy's token").toBe(1);
  });

  it("NEGATIVE: a GOLD GEAR token is not doubled", () => {
    // "A token UNIT." A Gold token is played (185.2.a) and is a token, so
    // `isToken` alone is not enough — `playedKind === "Unit"` is what refuses it.
    const { state } = board();
    const before = state.players[0]!.activeGear.length;
    const played = placeGoldTokens(state, 0, 1);
    expect(heldForZilean(played), "Zilean placed a Pending Item for a gear token").toBe(0);

    const settled = settle(played, takeCopy);
    expect(settled.pendingDecisions.length, "Zilean asked about a gear token").toBe(0);
    expect(settled.players[0]!.activeGear.length - before, "Zilean doubled a Gold gear token").toBe(1);
  });

  it("NEGATIVE: a real UNIT card played from hand is not doubled", () => {
    // "A TOKEN unit." 185 keeps a token from being a card, and this is the other
    // side of that: an ordinary unit fires the same `cardPlayed` event with
    // `isToken: false`, so dropping that one field would double every unit played.
    const sentry = realUnitInstance(SENTRY);
    const { state } = board({ hand: [sentry] });
    const play = playsOf(state, sentry.instanceId)[0];
    expect(play, "Determined Sentry was never offered").toBeDefined();

    const { state: cast, result } = submit(state, play!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(heldForZilean(cast), "Zilean placed a Pending Item for a real unit card").toBe(0);

    const settled = settle(cast, takeCopy);
    expect(settled.pendingDecisions.length, "Zilean asked about a non-token unit").toBe(0);
    expect(unitsOf(settled, 0).filter((u) => u.defId === SENTRY).length, "a real unit card was doubled").toBe(1);
  });
});
