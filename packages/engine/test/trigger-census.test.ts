import { describe, expect, it } from "vitest";
import {
  deathTriggerDefIds,
  eventTriggerDefIds,
  eventTriggerFor,
  selfTriggerDefIds,
} from "../src/engine/triggers.js";
import { unitTriggerDefIds } from "../src/engine/unit-triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import {
  legendInlineTriggerDefIds,
  legendTriggerDefIds,
  legendTriggerKeysInUse,
} from "../src/engine/legend-abilities.js";

/**
 * **How many cards have a triggered ability, and how many of those still resolve
 * at their source instead of on the Chain?**
 *
 * `docs/rules-conformance.md` has carried "110 held / 3 inline" since 2026-08-04
 * with nothing recomputing it. `CLAUDE.md` names this exact figure as having been
 * **wrong four times, always by hand-copying one of the registries** — and the
 * 2026-08-07 audit of that table found the number undated and unverifiable, which
 * is how it earned a test.
 *
 * # It asks the SOURCE, and that is the whole design
 *
 * Every population here comes from the registry's own accessor
 * (`eventTriggerDefIds`, `unitTriggerDefIds`, …) and every classification comes
 * from the definition itself (`eventTriggerFor(id).on`). Nothing below restates a
 * list of cards, because a restated list is what was wrong all four times.
 *
 * The two censuses that follow are the guard on that: they assert the SHAPES in
 * use — the event kinds, the Legend hook keys — so a new one fails here and
 * forces a decision about which side of the held/inline line it falls on, rather
 * than being silently absorbed into a count.
 *
 * # Held vs inline reduces to one question
 *
 * `InlineEvent` is `Exclude<GameEvent, { kind: HeldEventKind }>`, and it is
 * `beginningPhase` alone — the compiler enforces that, not this file. So an event
 * trigger is inline exactly when it registers `beginningPhase`, and every other
 * trigger family (on-play, attack, on-move, self, Deathknell, death-watch) is
 * held outright. The Legend side is asked of `legend-abilities.ts`, whose
 * `onBeginningPhase` never reaches the held adapter at all.
 *
 * **`beginningPhase` stays inline deliberately**: holding it would resolve
 * Beginning-Phase abilities after `scoreHolds`, breaking an ordering
 * `runBeginning`'s own comment calls load-bearing.
 */

/** Event triggers that register the one inline kind. */
function inlineEventTriggerDefIds(): string[] {
  return eventTriggerDefIds().filter((defId) => {
    const on = eventTriggerFor(defId)?.on;
    const kinds = on === undefined ? [] : Array.isArray(on) ? on : [on];
    return kinds.includes("beginningPhase");
  });
}

/** Every key in any trigger registry — cards AND the synthetic granted-trigger
 *  keys below. Deduped: 27 cards are in two registries, so summing the five is
 *  one of the ways a hand count went wrong (239 raw against 212 distinct). */
function allTriggerKeys(): Set<string> {
  return new Set([
    ...eventTriggerDefIds(),
    ...unitTriggerDefIds(),
    ...deathTriggerDefIds(),
    ...selfTriggerDefIds(),
    ...legendTriggerDefIds(),
  ]);
}

/**
 * Keys that are not cards.
 *
 * `holdEventTrigger` matches `UnitInstance.grantedTriggersThisTurn` alongside
 * `card.defId`, so a GRANTED ability is registered under a synthetic key in the
 * same table — `SFD-184-conquer-home` is Relentless Pursuit's granted "move me to
 * my base". It is a real trigger and it is not a card, so counting it as one
 * inflates the census by exactly the number of granted abilities.
 *
 * **This was found by the census disagreeing with the card registry, not by
 * reading the code** — which is the argument for asking two sources and
 * comparing rather than trusting one.
 */
function syntheticKeys(known: ReadonlySet<string>): string[] {
  return [...allTriggerKeys()].filter((key) => !known.has(key)).sort();
}

/** Every CARD carrying a trigger of any family. */
function allTriggerCards(known: ReadonlySet<string>): Set<string> {
  return new Set([...allTriggerKeys()].filter((key) => known.has(key)));
}

const knownCardIds = new Set(defaultCardRegistry().all().map((def) => def.id));

describe("trigger census: held vs inline, recomputed from the registries", () => {
  it("finds the registries at all", () => {
    // Without this the censuses below would all pass on empty input — the `tried
    // > 0` rule, which exists because a check that never ran reports as a pass.
    expect(allTriggerCards(knownCardIds).size).toBeGreaterThan(100);
    expect(eventTriggerDefIds().length).toBeGreaterThan(10);
    expect(legendTriggerDefIds().length).toBeGreaterThan(0);
  });

  it("the registry keys that are NOT cards, by name", () => {
    // Granted abilities, registered under a synthetic key beside the real
    // defIds. Named rather than counted so a second one is a decision: it either
    // belongs in this list or something is registering a malformed id.
    //
    // **There are two KINDS of synthetic key now, and the difference matters to
    // anyone reading a census that counts cards:**
    //
    //   `SFD-184-conquer-home` is a GRANTED ability — one card's clause, handed
    //   to another unit for a turn. It inflates a card count by one if counted.
    //
    //   `KEYWORD-HUNT` is a KEYWORD's ability, and it deflates one instead: it
    //   is a single registry entry standing in for the 12 UNL cards that print
    //   `[Hunt N]`. Counting registry keys as cards would report those twelve as
    //   one, which is the opposite error and the reason this census asks the
    //   card registry rather than the trigger tables.
    expect(syntheticKeys(knownCardIds)).toEqual(["KEYWORD-HUNT", "SFD-184-conquer-home"]);
  });

  it("the only event kind still resolved inline is beginningPhase", () => {
    // Asserted by NAME rather than by count. This is the structural claim the
    // whole census rests on, and the one the doc row states as "every kind but
    // one" — if a second inline kind ever appears, every number below changes
    // meaning and this says so first.
    const inlineCards = inlineEventTriggerDefIds();
    for (const defId of inlineCards) {
      const on = eventTriggerFor(defId)!.on;
      const kinds = Array.isArray(on) ? on : [on];
      expect(kinds).toEqual(["beginningPhase"]);
    }
  });

  it("the cards still resolving INLINE, by name", () => {
    // Named, not counted, because this is the actionable half: each of these is a
    // card whose ability an opponent cannot respond to. Two `beginningPhase`
    // event triggers (Dr. Mundo, Mushroom Pouch) plus Jinx's Legend hook.
    const inline = [...inlineEventTriggerDefIds(), ...legendInlineTriggerDefIds()].sort();
    expect(inline).toEqual(["OGN-101", "OGN-109", "OGN-251"]);
  });

  it("245 held / 3 inline of 248 trigger cards", () => {
    const all = allTriggerCards(knownCardIds);
    const inline = new Set([...inlineEventTriggerDefIds(), ...legendInlineTriggerDefIds()]);
    const held = [...all].filter((defId) => !inline.has(defId));

    // **The figure this replaces was "110 held / 3 inline, 113 cards", and it
    // was measured before SFD finished.** SFD alone carries 96 trigger cards and
    // none of them were in it; OGN+OGS together are 116, which is where a number
    // near 113 came from. Nothing re-measured it when the set landed, which is
    // why it is a test now and not a sentence.
    //
    // A change here is a real change in how much of the pool is respondable, so
    // it should be a decision rather than a silent edit. If this fails because a
    // card was ADDED, update these numbers and the doc row in the same change —
    // that is the thing this test exists to make impossible to forget.
    // **208/3/211 → 231/3/234 on 2026-08-08**, when the first wave of Unleashed
    // card work landed: 23 more cards carrying a trigger, every one of them held.
    //
    // **231/3/234 → 245/3/248 on 2026-08-09**, wave 2: fourteen more trigger
    // cards, again every one held. RECOMPUTED, not incremented — six agents wrote
    // to six domain files at once and none could see the others, so each measured
    // only its own share (+2 Fury, +2 Calm, +2 Mind, +4 Chaos, +4 Order; Body
    // added none). Five separate self-measurements summing to exactly the +14 the
    // registries report is the cross-check that this is arithmetic rather than a
    // number typed to make a test pass — which is the failure this file exists to
    // prevent, and the reason none of the six was permitted to bump it.
    //
    // `inline` did not move and must not — it is `beginningPhase` alone, three
    // OGN cards, and a new set adding to it would be the ordering regression the
    // note above describes rather than a number to update.
    expect({ held: held.length, inline: inline.size, cards: all.size }).toEqual({
      held: 245,
      inline: 3,
      cards: 248,
    });
  });

  it("the Legend hook keys in use, so a new one forces a decision", () => {
    // `legendTriggerDefIds` treats any unrecognised key as a TRIGGER, so a new
    // hook is counted the day it is written. The risk runs the other way: a new
    // CONTINUOUS entry would be miscounted as a trigger until it is named in
    // `NON_TRIGGER_KEYS`. This census is what catches that.
    expect(legendTriggerKeysInUse()).toEqual([
      "conquerCondition",
      "mightBonus",
      "onBattlefieldHeld",
      "onBeginningPhase",
      "onCombatWon",
      "onConquer",
      "onEndOfTurn",
      "onEnemyUnitAttacks",
      "onEnemyUnitDied",
      "onRunesRecycled",
      "onSpellCast",
      "onUnitBecameMighty",
      "onUnitChosen",
      "onUnitPlayed",
      "onUnitsStunned",
    ]);
  });

  it("a Legend with only a continuous mightBonus is not a trigger card", () => {
    // OGS-019 Master Yi. Counting `LEGEND_ABILITIES`' keys reports him as a
    // Legend trigger and gives the wrong answer to "how many cards are held" —
    // the mistake docs/rules-conformance.md records against its own earlier
    // figures ("9 is the size of LEGEND_ABILITIES, which includes Master Yi").
    expect(legendTriggerDefIds()).not.toContain("OGS-019");
    expect(allTriggerCards(knownCardIds).has("OGS-019")).toBe(false);
  });
});
