import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { effectiveMight, effectiveMightDefIds } from "../src/engine/effective-might.js";
import { implementingModule, isCardImplemented } from "../src/engine/coverage.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { deflectSurcharge } from "../src/engine/granted-keywords.js";
import { equipmentAttachedTo } from "../src/engine/equipment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed's THIRD Calm wave — engine/effects/calm.ts.
 *
 * Every test that can drive a real path does: `legalActions` to build the action,
 * `submit` to take it, focus passes to resolve the chain. A resolver called
 * directly passes whether or not the dispatch hop that reaches it in a game
 * carries the fields it needs — which is how a card ships costing runes and doing
 * nothing.
 *
 * The two continuous Might bands (Mosstomper, Soul Sword) are read through
 * `effectiveMight` instead, because that IS their real path: nothing dispatches
 * them, combat and every "my Might" instruction ask that function. Both are
 * asserted at BOTH edges of the threshold and after the XP is spent again —
 * 824.1.d, the half a one-shot pump gets wrong.
 *
 * **Every card has a NEGATIVE control.** A buff, a token, a Might pump and a
 * counter are all things other parts of a turn also do, and a one-sided fixture
 * cannot tell "my card fired" from "something fired".
 *
 * Two cards from this wave are NOT here as implementations and each has a test
 * saying so rather than being left silent — a refusal nothing asserts is
 * indistinguishable from a card nobody looked at.
 */

const registry = defaultCardRegistry();

const SOUL_SWORD = "UNL-039"; // [Equip] [Calm]; art-only [Level 3] +1 Might band
const ALLAY = "UNL-041"; // REFUSED — see its describe block
const PROMOTER = "UNL-043"; // [Backline]; when I hold, [Buff] all units here
const FLURRY = "UNL-044"; // [Reaction] choose one — counter / four Bird tokens
const SIGNPOST = "UNL-045"; // REFUSED — see its describe block
const FRIENDSHIP = "UNL-046"; // +1 Might per Bird/Cat/Dog/Poro tag among your units
const MOSSTOMPER = "UNL-047"; // [Hunt 2]; [Level 3] +1 Might and [Deflect]
const TREVOR = "UNL-048"; // [Shield]; when I hold, a ready 3 Might Sprite here

const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield."

const rune = (id: string, domain: RuneCard["domain"] = "Calm"): RuneCard => ({ id, domain, state: "Ready" });
const runes = (n: number, domain: RuneCard["domain"] = "Calm") =>
  Array.from({ length: n }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12; guard += 1) {
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  return current;
}

const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** A caster holding one copy of `defId` with plenty of Calm runes — Calm pays the
 *  Energy of everything here and the Power of the one card that prints any. */
function caster(defId: string, xp = 0): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spellInstance(defId)];
  state.players[0]!.channeled = runes(12);
  state.players[0]!.xp = xp;
  return state;
}

/** Player 0 in their Beginning Phase, alone at bf1 with `units` — what
 *  `scoring.isHeldBy` reads as a hold: presence, control, and no opponent. */
function holdingBf1(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { p1: units };
  state.battlefields[0]!.controllerId = "p1";
  return state;
}

const unitsAtBf = (state: GameState, battlefieldId: string, playerId = "p1"): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

describe("Flurry of Feathers (UNL-044): choose one — counter, or four [Deflect] Birds", () => {
  /** Player 1 has cast Hextech Ray and it is waiting; player 0 holds a Flurry and
   *  has chain priority. Lifted from counter-spell.test.ts's `chainWith`,
   *  including its 345 note: the caster acts on their own spell first, so the
   *  fixture has to pass once before the opponent can react. */
  function chained(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    state.players[1]!.hand = [spellInstance(HEXTECH_RAY)];
    state.players[1]!.channeled = runes(8, "Fury");
    state.players[0]!.hand = [spellInstance(FLURRY)];
    state.players[0]!.channeled = runes(12);

    const cast = playsOf(state, HEXTECH_RAY)[0];
    expect(cast, "Hextech Ray was not castable — the fixture has no chain").toBeDefined();
    const onChain = accept(state, cast!);
    const pass = legalActions(onChain).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the caster was not offered a pass on their own spell (345)").toBeDefined();
    return accept(onChain, pass!);
  }

  const victimDamage = (state: GameState) =>
    state.battlefields.flatMap((bf) => bf.units["p2"] ?? []).find((u) => u.instanceId === "victim")!.damage;

  const birdsInBase = (state: GameState) => state.players[0]!.baseUnits.filter((u) => u.name === "Bird");

  it("counters the spell on the chain, and its effect never happens", () => {
    const start = chained();
    const counter = playsOf(start, FLURRY).find((a) => a.modeId === "counter");
    expect(counter, "the counter mode was never offered against a spell on the chain").toBeDefined();
    // The positive control for the fixture itself: without this, "0 damage" below
    // would also be true of a Ray that never resolved for some other reason.
    expect(victimDamage(settle(start)), "the un-countered Ray dealt no damage — the fixture is inert").toBe(3);

    const settled = settle(accept(start, counter!));
    expect(settled.spellChain).toHaveLength(0);
    expect(victimDamage(settled), "the countered spell still dealt its damage").toBe(0);
  });

  it("makes NO Birds on the counter mode — the modes are exclusive", () => {
    const start = chained();
    const settled = settle(accept(start, playsOf(start, FLURRY).find((a) => a.modeId === "counter")!));
    expect(birdsInBase(settled), "the counter mode also minted the token half").toHaveLength(0);
  });

  it("plays FOUR Bird tokens on the other mode", () => {
    const start = caster(FLURRY);
    const birds = playsOf(start, FLURRY).find((a) => a.modeId === "birds");
    expect(birds, "the token mode was never offered").toBeDefined();

    const settled = settle(accept(start, birds!));
    const made = birdsInBase(settled);
    // FOUR, not one and not five: the count is the card's, and a loop written
    // `<=` or a single `placeToken` both read as "the mode works".
    expect(made, "the token count is not four").toHaveLength(4);
    for (const bird of made) {
      expect(bird.might).toBe(1);
      expect(bird.isToken).toBe(true);
      expect(bird.tags).toEqual(["Bird"]);
    }
    // And they are four SEPARATE units, not one object pushed four times.
    expect(new Set(made.map((b) => b.instanceId)).size).toBe(4);
  });

  it("the Birds really carry [Deflect] — an opponent pays to choose one", () => {
    // Asserted through `deflectSurcharge` rather than by reading `keywords` off
    // the instance, because that is the function that actually taxes a chooser. A
    // token minted with the field set and nothing reading it is the
    // shipped-inert shape one level down.
    const start = caster(FLURRY);
    const settled = settle(accept(start, playsOf(start, FLURRY).find((a) => a.modeId === "birds")!));
    const bird = birdsInBase(settled)[0]!;
    expect(deflectSurcharge(settled, bird, 0, 1), "the opponent chooses it for free").toBe(1);
    // The control: a plain unit beside it owes nothing, so a surcharge function
    // that answered 1 for everything would fail here.
    expect(deflectSurcharge(settled, makeUnit({ name: "Plain" }), 0, 1)).toBe(0);
  });

  it("is castable with an EMPTY chain — only the counter mode drops", () => {
    // The whole reason this card is modal rather than two cards. Wind Wall is
    // uncastable on an empty chain and correctly so; this one still has Birds.
    const empty = caster(FLURRY);
    const offered = playsOf(empty, FLURRY);
    expect(offered.length, "nothing was offered — the card is stuck in hand").toBeGreaterThan(0);
    expect(offered.map((a) => a.modeId)).toEqual(["birds"]);
  });

  it("is reported implemented", () => {
    expect(implementingModule(FLURRY)).toBe("card-effects");
    expect(isCardImplemented(registry.get(FLURRY))).toBe(true);
  });
});

describe("Friendship (UNL-046): +1 Might this turn per Bird/Cat/Dog/Poro tag among YOUR units", () => {
  /** The caster with `tags` spread one-per-unit in their base, plus an enemy unit
   *  at bf1 to aim at — deliberately an ENEMY, since the card names no owner. */
  function board(tags: string[][], enemyTags: string[] = []): GameState {
    const state = caster(FRIENDSHIP);
    state.players[0]!.baseUnits = tags.map((t, i) => makeUnit({ instanceId: `mine${i}`, name: `Mine${i}`, tags: t }));
    state.battlefields[0]!.units = {
      p2: [makeUnit({ instanceId: "victim", name: "Victim", might: 3, tags: enemyTags })],
    };
    return state;
  }

  function pumpOf(state: GameState): number {
    const play = playsOf(state, FRIENDSHIP).find((a) => a.targetUnitInstanceId === "victim");
    expect(play, "Friendship was never enumerated against the enemy unit").toBeDefined();
    return unitsAtBf(settle(accept(state, play!)), "bf1", "p2").find((u) => u.instanceId === "victim")!.mightThisTurn;
  }

  it("gives +1 for one tag", () => {
    expect(pumpOf(board([["Poro"]])), "the spell resolved and gave nothing").toBe(1);
  });

  it("gives +4 for all four", () => {
    expect(pumpOf(board([["Bird"], ["Cat"], ["Dog"], ["Poro"]]))).toBe(4);
  });

  it("counts TAGS, not units — three Poros are still +1", () => {
    // The mis-read this card invites, and it is invisible in the +1 and +4 cases
    // above: "for each of the following TAGS among your units" is a count of the
    // four listed tags that appear, not a count of matching bodies.
    expect(pumpOf(board([["Poro"], ["Poro"], ["Poro"]])), "it counted units instead of tags").toBe(1);
  });

  it("gives +0 with none of the four — the negative control", () => {
    // Deliberately a unit with an UNLISTED tag rather than an empty board: a
    // resolver that counted "any tagged unit" would pass an empty-board test and
    // fail this. Still castable, and 0 is a legal amount.
    expect(pumpOf(board([["Yordle"], ["Mech"]])), "a tag the card does not list was counted").toBe(0);
  });

  it("counts YOUR units only — the opponent's Poros are not yours", () => {
    expect(pumpOf(board([], ["Bird", "Cat", "Dog", "Poro"])), "the enemy's tags paid the caster").toBe(0);
  });

  it("counts units in BASE and at battlefields alike", () => {
    // "Among your units" names no location, so a Cat standing at a battlefield
    // counts exactly as one at home.
    const state = board([["Bird"]]);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Cat", tags: ["Cat"] })] };
    expect(pumpOf(state), "a tagged unit at a battlefield was not counted").toBe(2);
  });

  it("is reported implemented", () => {
    expect(implementingModule(FRIENDSHIP)).toBe("card-effects");
    expect(isCardImplemented(registry.get(FRIENDSHIP))).toBe(true);
  });
});

describe("Enthusiastic Promoter (UNL-043): when I hold, [Buff] all units here", () => {
  it("buffs every unit at his battlefield", () => {
    const ally = makeUnit({ instanceId: "ally", name: "Ally" });
    const state = holdingBf1([realUnitInstance(PROMOTER), ally]);
    // The positive control for the premise: nothing arrives pre-buffed, so the
    // assertion below cannot pass on a fixture that was already true.
    expect(unitsAtBf(state, "bf1").every((u) => !u.buffed)).toBe(true);

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(unitsAtBf(settled, "bf1").map((u) => u.buffed), "the hold trigger buffed nobody").toEqual([true, true]);
  });

  it("does NOT reach a battlefield he is not standing at — 'here'", () => {
    // Two battlefields held, the Promoter at only one. Without this a resolver
    // that buffed the whole board would pass the test above.
    const state = holdingBf1([realUnitInstance(PROMOTER)]);
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "outpost", name: "Outpost" })] };
    state.battlefields[1]!.controllerId = "p1";

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(unitsAtBf(settled, "bf1")[0]!.buffed, "his own battlefield went unbuffed").toBe(true);
    expect(unitsAtBf(settled, "bf2")[0]!.buffed, "a unit at another battlefield was buffed").toBe(false);
  });

  it("does NOT fire when the opponent is present — that is not a hold", () => {
    // `isHeldBy` requires no opponent units, so nothing scores and nothing
    // triggers. This is also the only board on which "all units" could ever reach
    // an enemy, and it is unreachable — see the card's note.
    const state = holdingBf1([realUnitInstance(PROMOTER)]);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [makeUnit({ name: "Intruder" })] };

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points, "a contested battlefield scored").toBe(0);
    expect(unitsAtBf(settled, "bf1")[0]!.buffed, "the trigger fired without a hold").toBe(false);
  });

  it("does not fire for a unit with no such clause — the negative control", () => {
    // Trevor holds the same battlefield in the test below and buffs nobody; here
    // it is a plain body, so an engine that buffed on every hold would fail.
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([makeUnit({ instanceId: "plain", name: "Plain" })])));
    expect(settled.players[0]!.points, "the hold did not score — the fixture is inert").toBe(1);
    expect(unitsAtBf(settled, "bf1")[0]!.buffed, "a plain unit's hold buffed the board").toBe(false);
  });

  it("is a no-op on an already-buffed unit (426.1.b.1), and still buffs the rest", () => {
    const buffed = makeUnit({ instanceId: "already", name: "Already", buffed: true });
    const fresh = makeUnit({ instanceId: "fresh", name: "Fresh" });
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([realUnitInstance(PROMOTER), buffed, fresh])));

    expect(unitsAtBf(settled, "bf1").find((u) => u.instanceId === "already")!.buffed).toBe(true);
    expect(unitsAtBf(settled, "bf1").find((u) => u.instanceId === "fresh")!.buffed, "one unit's no-op stopped the rest").toBe(true);
  });

  it("its own text is registered, and [Backline] no longer holds it back", () => {
    // **This pin fired on 2026-08-10 and is flipped rather than deleted.** It was
    // written asking the MODULE rather than `isCardImplemented`, because
    // `[Backline]` sat in UNIMPLEMENTED_KEYWORDS and greyed the card no matter
    // what was written for its own half. The keyword turned out to need one
    // `hasKeyword` call in `combat.assignmentOrder` — the three-tier sort had been
    // there since Caitlyn - Patrolling — so the card came whole.
    //
    // Both questions are kept: the module answer is what this file can prove, and
    // the coverage answer is the one that was wrong for a week.
    expect(implementingModule(PROMOTER)).toBe("event triggers");
    expect(isCardImplemented(registry.get(PROMOTER)), "the Promoter is greyed again").toBe(true);
  });
});

describe("Trevor Snoozebottom (UNL-048): when I hold, play a ready 3 Might [Temporary] Sprite here", () => {
  const spritesAt = (state: GameState, battlefieldId: string) =>
    unitsAtBf(state, battlefieldId).filter((u) => u.name === "Sprite");

  it("plays one Sprite at the battlefield he held", () => {
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([realUnitInstance(TREVOR)])));
    const sprites = spritesAt(settled, "bf1");

    expect(sprites, "the hold trigger made no Sprite").toHaveLength(1);
    expect(sprites[0]!.might).toBe(3);
    expect(sprites[0]!.isToken).toBe(true);
    expect(sprites[0]!.tags).toEqual(["Sprite"]);
    // "A READY ... token" — 143.4.a would enter it exhausted, and the card says
    // otherwise. A Sprite that entered exhausted could not defend the battlefield
    // it was made to hold, which is the whole point of the body.
    expect(sprites[0]!.exhausted, "the Sprite entered exhausted").toBe(false);
    // "[Temporary]" is what pays for a free 3-Might body: turn-manager kills it at
    // the start of its controller's next Beginning Phase.
    expect(sprites[0]!.keywords.Temporary).toBe(1);
  });

  it("puts it at HIS battlefield, not at every one held", () => {
    const state = holdingBf1([realUnitInstance(TREVOR)]);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Outpost" })] };
    state.battlefields[1]!.controllerId = "p1";

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(spritesAt(settled, "bf1")).toHaveLength(1);
    expect(spritesAt(settled, "bf2"), "a Sprite appeared at a battlefield he is not at").toHaveLength(0);
  });

  it("makes nothing without a hold — the negative control", () => {
    const state = holdingBf1([realUnitInstance(TREVOR)]);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [makeUnit({ name: "Intruder" })] };

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points).toBe(0);
    expect(spritesAt(settled, "bf1"), "a Sprite arrived without a hold").toHaveLength(0);
  });

  it("is not himself [Temporary] — the keyword is the TOKEN's", () => {
    // `card-loader.GRANTED_ONLY_KEYWORDS` strips it from him for exactly this
    // reason: `killTemporaryPermanents` tests `"Temporary" in keywords`, so a
    // Trevor who parsed it would die every Beginning Phase. Pinned here as well as
    // in the loader's own tests, because this is the file that makes the token.
    const trevor = realUnitInstance(TREVOR);
    expect(trevor.keywords.Temporary, "Trevor parses the token's keyword as his own").toBeUndefined();
    expect(trevor.keywords.Shield, "his real printed keyword went missing with it").toBe(1);
    // And he survives the hold he triggered on.
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([trevor])));
    expect(unitsAtBf(settled, "bf1").some((u) => u.defId === TREVOR), "Trevor died to his own token's keyword").toBe(true);
  });

  it("is reported implemented", () => {
    expect(implementingModule(TREVOR)).toBe("event triggers");
    expect(isCardImplemented(registry.get(TREVOR))).toBe(true);
  });
});

describe("Mosstomper (UNL-047): [Level 3][>] I have +1 Might", () => {
  /** Mosstomper at bf1 with `xp` on his controller — a battlefield rather than
   *  base so the read is the one combat makes. */
  function board(xp: number) {
    const state = makeState({ phase: "Action" });
    const moss = realUnitInstance(MOSSTOMPER);
    state.battlefields[0]!.units = { p1: [moss] };
    state.players[0]!.xp = xp;
    return { state, moss };
  }

  const mightAt = (xp: number) => {
    const { state, moss } = board(xp);
    return effectiveMight(state, moss, 0, { isCombat: false, battlefieldId: "bf1" });
  };

  it("is 3 below the band and 4 at it — 824.1.b.1's 'N or MORE'", () => {
    expect(mightAt(2), "the bonus applied below 3 XP").toBe(3);
    expect(mightAt(3), "the bonus did not apply at exactly 3 XP").toBe(4);
  });

  it("goes BACK to 3 when the XP is spent — 824.1.d", () => {
    // The assertion that makes this a continuous modifier rather than an on-play
    // pump. A latched bonus passes the test above and fails this one.
    const { state, moss } = board(5);
    expect(effectiveMight(state, moss, 0, { isCombat: false })).toBe(4);
    const spent = { ...state, players: [{ ...state.players[0]!, xp: 1 }, state.players[1]!] } as GameState;
    expect(effectiveMight(spent, moss, 0, { isCombat: false }), "the bonus survived the XP being spent").toBe(3);
  });

  it("reads the OWNER's XP, not the asking player's", () => {
    const { state, moss } = board(0);
    state.players[1]!.xp = 20;
    expect(effectiveMight(state, moss, 0, { isCombat: false }), "the opponent's XP paid the bonus").toBe(3);
  });

  it("does not leak onto the unit beside him", () => {
    // The seam asks EVERY registered modifier about every unit, so a modifier that
    // forgot its `unit.defId` test would pump the whole board.
    const { state } = board(10);
    const bystander = makeUnit({ name: "Bystander", might: 2 });
    state.battlefields[0]!.units["p1"] = [...unitsAtBf(state, "bf1"), bystander];
    expect(effectiveMight(state, bystander, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(2);
  });

  it("keeps its [Hunt 2] from the shared keyword trigger, not from a copy here", () => {
    // A per-card re-implementation would pay his conquer/hold XP twice. Driven
    // through a real hold: 2 XP, not 4.
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([realUnitInstance(MOSSTOMPER)])));
    expect(settled.players[0]!.xp, "[Hunt 2] paid twice, or not at all").toBe(2);
  });

  it("reports its card to coverage", () => {
    expect(effectiveMightDefIds()).toContain(MOSSTOMPER);
    expect(isCardImplemented(registry.get(MOSSTOMPER))).toBe(true);
  });

  it("PINNED DIVERGENCE: his [Deflect] is ON below the band", () => {
    // "[Level 3][>] I have +1 Might AND [Deflect]" — the keyword half should be
    // Inactive under 3 XP (824.1.d) and is not: `card-loader.parseKeywords` reads
    // the bracket straight out of the band and hands him a flat printed
    // `[Deflect 1]`, so an opponent pays the rainbow surcharge to choose him at 0
    // XP. Closing it needs a `GRANTED_ONLY_KEYWORDS` strip AND a
    // `CONDITIONAL_GRANTS` re-grant, both in shared files this wave does not own —
    // and doing only the first would make him strictly worse than printed.
    //
    // Asserting the WRONG answer deliberately, so the day it is fixed this fails
    // and says what to change instead of the behaviour shifting silently.
    const { state, moss } = board(0);
    // **Was pinned at 1 — the surcharge an opponent should NOT have owed.** Fixed
    // at integration by stripping the bracket at load and re-granting it at
    // [Level 3], so below the band there is no [Deflect] and nothing to pay.
    expect(deflectSurcharge(state, moss, 0, 1), "[Deflect] is live below [Level 3] again — opponents are being taxed for nothing").toBe(0);
    // And the half that IS gated, from the same board, so the pin cannot be read
    // as "nothing about the band works".
    expect(effectiveMight(state, moss, 0, { isCombat: false })).toBe(3);
  });
});

describe("Soul Sword (UNL-039): the art-only [Level 3][>] additional +1 Might", () => {
  /** A wearer in base with the Sword attached through the REAL path — the
   *  generated `[Equip]` ability, enumerated and submitted. */
  function attached(xp: number) {
    const sword = realGearInstance(SOUL_SWORD);
    const wearer = makeUnit({ instanceId: "wearer", name: "Wearer", might: 2 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [wearer];
    state.players[0]!.activeGear = [sword];
    state.players[0]!.channeled = runes(4);
    state.players[0]!.xp = xp;

    const equip = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === sword.instanceId,
    );
    expect(equip, "the generated [Equip] ability was never offered").toBeDefined();
    const after = accept(state, equip!);
    expect(equipmentAttachedTo(after, "wearer"), "the Sword did not attach").toHaveLength(1);
    return after;
  }

  const wearerMight = (state: GameState) =>
    effectiveMight(state, state.players[0]!.baseUnits.find((u) => u.instanceId === "wearer")!, 0, { isCombat: false });

  it("is the badge alone below the band, and badge + band at it", () => {
    // 2 printed + 1 badge = 3 under the threshold; +1 more at 3 XP. The badge is
    // the control for the band: a modifier that fired unconditionally would read
    // 4 in both, and one that never fired would read 3 in both.
    expect(wearerMight(attached(2)), "the band applied below 3 XP").toBe(3);
    expect(wearerMight(attached(3)), "the band did not apply at 3 XP").toBe(4);
  });

  it("goes back down when the XP is spent — 824.1.d", () => {
    const state = attached(3);
    expect(wearerMight(state)).toBe(4);
    const spent = { ...state, players: [{ ...state.players[0]!, xp: 0 }, state.players[1]!] } as GameState;
    expect(wearerMight(spent), "the band survived the XP being spent").toBe(3);
  });

  it("gives nothing to a unit not wearing it", () => {
    // An aura keyed by the SOURCE has to ask the board which unit wears it; one
    // that forgot would hand +1 to everybody at 3 XP.
    const state = attached(5);
    const bystander = makeUnit({ name: "Bystander", might: 2 });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, bystander];
    expect(effectiveMight(state, bystander, 0, { isCombat: false }), "an unequipped unit got the band").toBe(2);
  });

  it("gives nothing while the Sword is unattached", () => {
    // The negative control for the whole card: a Sword sitting in `activeGear`
    // with `attachedToInstanceId` null reaches nobody, however much XP there is.
    const state = makeState({ phase: "Action" });
    const loose = makeUnit({ instanceId: "loose", name: "Loose", might: 2 });
    state.players[0]!.baseUnits = [loose];
    state.players[0]!.activeGear = [realGearInstance(SOUL_SWORD)];
    state.players[0]!.xp = 9;
    expect(effectiveMight(state, loose, 0, { isCombat: false }), "an unattached Sword paid out").toBe(2);
  });

  it("reads the XP of the player who CONTROLS the Sword", () => {
    const state = attached(0);
    state.players[1]!.xp = 20;
    expect(wearerMight(state), "the opponent's XP paid the band").toBe(3);
  });

  it("reports to coverage, and its generated [Equip] is untouched", () => {
    expect(effectiveMightDefIds()).toContain(SOUL_SWORD);
    // The registration that must NOT be duplicated: `mergeRegistries` throws on a
    // duplicate defId, so a hand-written `activatedAbilities` entry for this card
    // would break the engine at import.
    expect(activatedAbilityFor(SOUL_SWORD)?.cost?.power).toEqual({ domain: "Calm", count: 1 });
  });
});

describe("the two UNL Calm cards this wave REFUSED, asserted rather than left silent", () => {
  it("Allay (UNL-041) still has nowhere to register a keyword AURA", () => {
    // "While I'm at a battlefield, your other units here have [Deflect]" is
    // EXACTLY the shape `granted-keywords.KEYWORD_AURAS` already expresses for
    // Captain Farron and Taric - Protector (`source: "unit", scope: "here",
    // excludesSelf: true`) — so the mechanism exists and the registration point
    // does not. That table and `CONDITIONAL_GRANTS` beside it are both
    // module-private consts in the shared `engine/granted-keywords.ts`, and
    // `effects/index.ts` offers no aura source to match its card-effect, trigger,
    // decision, activated-ability and (since 2026-08-09) Might-modifier seams.
    //
    // Re-measured this wave rather than inherited from wave 2's note.
    expect(implementingModule(ALLAY)).toBeUndefined();
    expect(isCardImplemented(registry.get(ALLAY))).toBe(false);
  });

  it("Forgotten Signpost (UNL-045) has no 'exhaust a unit you control' activation cost", () => {
    // "[Action][>] Exhaust a unit you control, [Exhaust]: Move a different unit
    // you control to the location of the unit you exhausted to pay for this
    // ability."
    //
    // TWO independent gaps, both in `engine/activated-abilities.ts`: `ActivationCost`
    // has no `exhaustFriendlyUnit` (its nearest neighbour, `killFriendlyPermanent`,
    // KILLS), and `ActivatedAbilityEvent` carries nothing about the cost, so even
    // given the cost the resolver could not learn WHICH unit paid — which is the
    // whole of "the location of the unit you exhausted".
    expect(activatedAbilityFor(SIGNPOST), "an ability appeared — write the card").toBeUndefined();
    expect(implementingModule(SIGNPOST)).toBeUndefined();
    expect(isCardImplemented(registry.get(SIGNPOST))).toBe(false);
  });
});
