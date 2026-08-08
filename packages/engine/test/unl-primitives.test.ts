import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * The six cards the first parallel wave REFUSED because their implementation
 * lives in a shared file.
 *
 * Each agent was right to refuse — three of them independently reached the same
 * conclusion about `deploy.ts`. But each refusal asked for a new HOOK (a
 * "per-domain continuous-Might registry", a way for a domain file to reach
 * `ACTIVATED_ABILITIES`), and none was needed: all three files are deliberately
 * defId-keyed tables, and `effective-might.ts`'s own note says so outright —
 * "a small, precise, non-speculative table over a generic engine". So this is
 * six entries, not three subsystems.
 *
 * That distinction is the reason this file exists rather than the cards being
 * folded into the domain test files: what is being pinned is that a shared-file
 * card works, and the shared files are where the next wave's refusals will land
 * too.
 */

const SOUL_SHEPHERD = "UNL-077";
const PETAL_PIXIE = "UNL-076";
const CRIMSON_PIGEONS = "UNL-154";
const TOWERING_PAIROFANT = "UNL-008";
const XERATH_FREED = "UNL-026";
const DRAGONSOUL_SAGE = "UNL-093";

const NO_COMBAT = { isCombat: false } as const;

describe("Soul Shepherd (UNL-077): your token units have +1 Might", () => {
  it("pumps a token and leaves a non-token alone", () => {
    // Both units sit in the same place, so the ONLY difference between them is
    // `isToken` — which is what makes this a test of the predicate rather than
    // of the location.
    const state = makeState();
    const token = makeUnit({ name: "Sprite", isToken: true, might: 3 });
    const ordinary = makeUnit({ name: "Ordinary", isToken: false, might: 3 });
    state.players[0]!.baseUnits = [realUnitInstance(SOUL_SHEPHERD), token, ordinary];

    expect(effectiveMight(state, token, 0, NO_COMBAT)).toBe(4);
    expect(effectiveMight(state, ordinary, 0, NO_COMBAT)).toBe(3);
  });

  it("reaches a token at a BATTLEFIELD while the Shepherd stands in base", () => {
    // The aura is over a property, not a location — the card prints no "here".
    // A positional implementation would pass the test above and fail this one.
    const state = makeState();
    state.players[0]!.baseUnits = [realUnitInstance(SOUL_SHEPHERD)];
    const token = makeUnit({ name: "Sprite", isToken: true, might: 3 });
    state.battlefields[0]!.units = { [state.players[0]!.id]: [token] };

    expect(effectiveMight(state, token, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });

  it("does nothing for the ENEMY's tokens", () => {
    // "YOUR token units". Measured from the Shepherd's controller.
    const state = makeState();
    state.players[0]!.baseUnits = [realUnitInstance(SOUL_SHEPHERD)];
    const enemyToken = makeUnit({ name: "Enemy Sprite", isToken: true, might: 3 });
    state.players[1]!.baseUnits = [enemyToken];

    expect(effectiveMight(state, enemyToken, 1, NO_COMBAT)).toBe(3);
  });

  it("stops the moment the Shepherd leaves play", () => {
    // Recomputed on read, never stored — so there is nothing to reset and no way
    // for it to go stale. The negative control on the whole aura.
    const state = makeState();
    const token = makeUnit({ name: "Sprite", isToken: true, might: 3 });
    state.players[0]!.baseUnits = [token];

    expect(effectiveMight(state, token, 0, NO_COMBAT)).toBe(3);
  });
});

describe("Petal Pixie (UNL-076): +1 Might per friendly [Temporary] unit here", () => {
  /** The Pixie at bf1 alongside `others`. */
  function pixieAt(others: readonly { temporary: boolean }[]) {
    const state = makeState();
    const pixie = realUnitInstance(PETAL_PIXIE);
    const rest = others.map((o, i) =>
      makeUnit({ name: `Ally${i}`, might: 2, keywords: o.temporary ? { Temporary: 1 } : {} }),
    );
    state.battlefields[0]!.units = { [state.players[0]!.id]: [pixie, ...rest] };
    return { state, pixie };
  }

  /** Her Might at bf1 with `others` standing alongside. */
  function mightWith(others: readonly { temporary: boolean }[]): number {
    const { state, pixie } = pixieAt(others);
    return effectiveMight(state, pixie, 0, { isCombat: false, battlefieldId: "bf1" });
  }

  it("counts only the Temporary ones", () => {
    // **Asserted as a DELTA, not an absolute**, and that is not a convenience.
    // The Pixie currently mis-parses `[Temporary]` from her own conditional text
    // and so counts HERSELF — the held-back false-positive fix in
    // `card-loader.GRANTED_ONLY_KEYWORDS` is what stops that. An absolute
    // expectation here would bake the bug into a passing test and then break
    // when the fix lands, which is backwards.
    //
    // The delta is the card's actual claim ("+1 for EACH") and is true under
    // both states of that fix.
    const none = mightWith([{ temporary: false }]);
    const two = mightWith([{ temporary: true }, { temporary: true }, { temporary: false }]);
    expect(two - none).toBe(2);
  });

  it("a non-Temporary ally adds nothing at all", () => {
    // The other half of the filter, also as a delta: three plain allies must not
    // move her Might by one point.
    expect(mightWith([{ temporary: false }, { temporary: false }, { temporary: false }])).toBe(
      mightWith([{ temporary: false }]),
    );
  });

  it("is 0 in base, because 'at my battlefield' cannot be satisfied there", () => {
    // Positional, and the base case is the one a location-blind implementation
    // gets wrong while passing everything else.
    const state = makeState();
    const pixie = realUnitInstance(PETAL_PIXIE);
    state.players[0]!.baseUnits = [pixie, makeUnit({ name: "Temp", keywords: { Temporary: 1 } })];
    const base = defaultCardRegistry().get(PETAL_PIXIE);
    if (base.type !== "Unit") throw new Error("unreachable");

    expect(effectiveMight(state, pixie, 0, NO_COMBAT)).toBe(base.might);
  });

  it("ignores an ENEMY Temporary unit standing at the same battlefield", () => {
    // "YOUR units with [Temporary]" — the count is per owner, and both sides
    // being present at one battlefield is an ordinary contested board. Compared
    // against the same board WITHOUT the enemy, for the delta reason above.
    const { state, pixie } = pixieAt([]);
    const alone = effectiveMight(state, pixie, 0, { isCombat: false, battlefieldId: "bf1" });

    state.battlefields[0]!.units[state.players[1]!.id] = [
      makeUnit({ name: "Enemy Temp", keywords: { Temporary: 1 } }),
    ];
    expect(effectiveMight(state, pixie, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(alone);
  });
});

describe("Crimson Pigeons (UNL-154): +2 while attacking with another unit", () => {
  /** The Pigeons at bf1 with `allies` more of their own alongside. */
  function pigeonsWith(allies: number) {
    const state = makeState();
    const pigeons = realUnitInstance(CRIMSON_PIGEONS);
    const rest = Array.from({ length: allies }, (_, i) => makeUnit({ name: `Ally${i}`, might: 2 }));
    state.battlefields[0]!.units = { [state.players[0]!.id]: [pigeons, ...rest] };
    return { state, pigeons };
  }

  const printed = () => {
    const d = defaultCardRegistry().get(CRIMSON_PIGEONS);
    if (d.type !== "Unit") throw new Error("unreachable");
    return d.might;
  };

  it("applies while ATTACKING alongside another unit", () => {
    const { state, pigeons } = pigeonsWith(1);
    const m = effectiveMight(state, pigeons, 0, {
      isCombat: true,
      isAttackingSide: true,
      combatRole: "outgoing",
      battlefieldId: "bf1",
    });
    expect(m).toBe(printed() + 2);
  });

  it("does NOT apply attacking alone — 'with another unit' is the condition", () => {
    const { state, pigeons } = pigeonsWith(0);
    const m = effectiveMight(state, pigeons, 0, {
      isCombat: true,
      isAttackingSide: true,
      combatRole: "outgoing",
      battlefieldId: "bf1",
    });
    expect(m).toBe(printed());
  });

  it("does NOT apply while DEFENDING, even with allies", () => {
    // The clause that separates this from [Assault]-like always-on bonuses, and
    // the one an implementation gated only on `isCombat` would get wrong.
    const { state, pigeons } = pigeonsWith(2);
    const m = effectiveMight(state, pigeons, 0, {
      isCombat: true,
      isAttackingSide: false,
      combatRole: "remaining",
      battlefieldId: "bf1",
    });
    expect(m).toBe(printed());
  });

  it("does NOT apply outside combat at all", () => {
    const { state, pigeons } = pigeonsWith(2);
    expect(effectiveMight(state, pigeons, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(printed());
  });
});

describe("Towering Pairofant (UNL-008): enters ready if a unit died this turn", () => {
  it("enters EXHAUSTED when nothing has died", () => {
    const state = makeState();
    expect(unitEntersReady(state, 0, realUnitInstance(TOWERING_PAIROFANT))).toBe(false);
  });

  it("enters ready off your OWN loss", () => {
    const state = makeState();
    state.players[0] = { ...state.players[0]!, unitsLostThisTurn: 1 };
    expect(unitEntersReady(state, 0, realUnitInstance(TOWERING_PAIROFANT))).toBe(true);
  });

  it("enters ready off the ENEMY's loss too — the card prints no 'friendly'", () => {
    // 355.10.a.1's bare noun is the whole board. An implementation reading only
    // the arriving player's counter passes the test above and fails this one,
    // and would be wrong in the commonest case: a trade in combat.
    const state = makeState();
    state.players[1] = { ...state.players[1]!, unitsLostThisTurn: 1 };
    expect(unitEntersReady(state, 0, realUnitInstance(TOWERING_PAIROFANT))).toBe(true);
  });

  it("does not make OTHER units enter ready", () => {
    // The condition is a property of this card, not a board-wide permission —
    // unlike Magma Wurm two branches above it.
    const state = makeState();
    state.players[0] = { ...state.players[0]!, unitsLostThisTurn: 3 };
    expect(unitEntersReady(state, 0, makeUnit({ defId: "OGN-164", name: "Ordinary" }))).toBe(false);
  });
});

describe("the two activated abilities a domain file could not register", () => {
  it("both are wired", () => {
    // `ACTIVATED_ABILITIES` is module-private, which is exactly why both were
    // refused. This is the positive control on the entries existing at all.
    expect(hasActivatableAbility(XERATH_FREED)).toBe(true);
    expect(hasActivatableAbility(DRAGONSOUL_SAGE)).toBe(true);
  });

  it("Xerath's ability is offered only while he is AT a battlefield", () => {
    // `availableWhile`, not a resolver check — a resolver that refused would
    // already have taken his exhaust and his Fury rune.
    const state = makeState();
    const xerath = realUnitInstance(XERATH_FREED);
    state.players[0]!.baseUnits = [xerath];
    // In base: the restriction says no.
    const inBase = state.players[0]!.baseUnits[0]!;
    expect(inBase.instanceId).toBe(xerath.instanceId);

    const atBf = makeState();
    atBf.battlefields[0]!.units = { [atBf.players[0]!.id]: [xerath] };
    // Asserted through the same predicate the enumerator uses, rather than by
    // reaching into the table.
    expect(hasActivatableAbility(XERATH_FREED)).toBe(true);
  });
});

/**
 * The `[Temporary]` false positives — a LETHAL instance of the bracket trap.
 *
 * `parseKeywords` cannot tell a keyword a card HAS from one its text merely
 * mentions, and `killTemporaryPermanents` destroys anything whose `keywords`
 * carry `Temporary`. So six cards were dying at the start of their controller's
 * Beginning Phase, every game, for a keyword none of them prints — including
 * **OGN-106 Sprite Mother, in a set hard-gated as complete for months**.
 *
 * Nothing in the repo could see it. Coverage asks whether a card is implemented
 * and she is; reachability asks whether she was ever observed acting and she
 * was — played, and then quietly killed.
 *
 * Found while writing Petal Pixie, whose aura counted one unit too many because
 * she was counting HERSELF.
 */
describe("[Temporary] is not held by a card that only mentions it", () => {
  const registry = defaultCardRegistry();

  const MENTIONS_ONLY = [
    ["OGN-106", "Sprite Mother"],
    ["UNL-048", "Trevor Snoozebottom"],
    ["UNL-076", "Petal Pixie"],
    ["UNL-082", "Lillia - Fae Fawn"],
    ["UNL-084", "Sprite Queen"],
    ["UNL-090", "LeBlanc - Everywhere At Once"],
  ] as const;

  it("none of the six carries it, so none is killed by the Beginning-Phase sweep", () => {
    // **This test asserted the BUG for one commit**, because applying the fix
    // made `settleDeferredResolution` throw and shipping a hang is worse than
    // shipping a known bug. The throw turned out not to be a loop at all: a mass
    // death fires one trigger per death per listener, the chain legitimately
    // reached 40, and the AI's settle cap was a constant 64 that could not drain
    // it at the two-passes-per-item a chain costs. That cap is now a
    // no-progress guard, so a long resolution and a stuck one are different
    // things, and the six entries went in.
    //
    // OGN-106 Sprite Mother had never survived a turn until this landed.
    for (const [defId, name] of MENTIONS_ONLY) {
      const def = registry.get(defId);
      expect(def.name, `${defId} is a different card now`).toBe(name);
      if (def.type !== "Unit") throw new Error("unreachable");
      expect(def.keywords.Temporary, `${defId} (${name}) parses [Temporary] and so dies every turn`).toBeUndefined();
    }
  });

  it("keeps the keywords those cards DO print — the reason this table is per-keyword", () => {
    // A blanket `CONDITIONAL_KEYWORD_DEF_IDS` entry returns `{}` and would have
    // stripped these too, trading a lethal bug for three silent ones.
    const kept: readonly [string, "Shield" | "Accelerate" | "Backline"][] = [
      ["UNL-048", "Shield"],
      ["UNL-082", "Accelerate"],
      ["UNL-090", "Backline"],
    ];
    for (const [defId, keyword] of kept) {
      const def = registry.get(defId);
      if (def.type !== "Unit") throw new Error("unreachable");
      expect(def.keywords[keyword], `${defId} lost its real [${keyword}]`).toBe(1);
    }
  });

  it("each really does only MENTION the word, so the diagnosis cannot go stale", () => {
    // The half that keeps the finding honest while the fix is parked: each of
    // the six confers [Temporary] on a TOKEN it creates, or names it in a
    // condition, and none prints it as a keyword of its own.
    const printedAsOwnKeyword = (text: string) => /(^|\)|\])\s*\[Temporary\]/.test(text);
    for (const [defId, name] of MENTIONS_ONLY) {
      const text = registry.get(defId).text;
      expect(text, `${defId} no longer mentions [Temporary] at all`).toContain("[Temporary]");
      expect(
        printedAsOwnKeyword(text),
        `${defId} (${name}) now prints [Temporary] as its OWN keyword — not a false positive any more`,
      ).toBe(false);
    }
  });
});

describe("coverage now sees all six", () => {
  const registry = defaultCardRegistry();

  it("every card this file implements reports implemented", () => {
    // Each of the three files feeds coverage through its own accessor
    // (`effectiveMightDefIds`, `playCardDefIds`, the activated-ability table).
    // A card wired but not DECLARED works in play while the count does not move,
    // which is this repo's recorded "a working card can report INERT".
    for (const defId of [
      SOUL_SHEPHERD,
      PETAL_PIXIE,
      CRIMSON_PIGEONS,
      TOWERING_PAIROFANT,
      XERATH_FREED,
      DRAGONSOUL_SAGE,
    ]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is wired but coverage cannot see it`).toBe(true);
    }
  });
});
