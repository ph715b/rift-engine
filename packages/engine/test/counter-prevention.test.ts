import { describe, expect, it } from "vitest";
import { canBeCountered, counterSpell, counterableSpells } from "../src/engine/counter-spell.js";
import { empowerPermanent } from "../src/engine/effect-helpers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * A spell that cannot be countered.
 *
 * # Two protections, and they are different KINDS
 *
 * `VEN-015 Decree of Rage` prints "This can't be countered" — a property of the
 * CARD, true wherever it is. `VEN-069 Mel, Newly Awakened` gives "your spells and
 * abilities can't be countered" while Empowered — a property of the BOARD at the
 * moment a counter is attempted, and one an opponent can remove by Disempowering
 * her (442). That is why `canBeCountered` reads state rather than being a flag
 * captured on the chain entry when the spell was cast.
 *
 * # Why the predicate is enforced at TWO sites
 *
 * `counterableSpells` is what the enumerator and the validator both walk, so
 * filtering there is what stops a counter being OFFERED against a protected
 * spell — this repo's most-repeated bug is the enumerator offering a play the
 * validator then refuses.
 *
 * `counterSpell` guards again, and that is not belt-and-braces: several counters
 * never consult the candidate walk at all. Hard Bargain counters when its RANSOM
 * IS ANSWERED, long after targeting, and a decision answered later can reach a
 * board where Mel became Empowered in between. A protection enforced only where
 * targets are offered would be bypassed by exactly those cards, so both sites are
 * asserted below.
 */

const registry = defaultCardRegistry();
const DECREE_OF_RAGE = "VEN-015"; // "This can't be countered."
const MEL = "VEN-069"; // "[Empowered][>] Your spells and abilities can't be countered."
const PLAIN_SPELL = "OGN-146"; // Wallop — an ordinary counterable spell

const spell = (defId: string): SpellInstance => createCardInstance(registry.get(defId)) as SpellInstance;
const unit = (defId: string, instanceId: string): UnitInstance => ({
  ...(createCardInstance(registry.get(defId)) as UnitInstance),
  instanceId,
});

/** `caster` has put `card` on the chain. */
function withSpellOnChain(card: SpellInstance, casterIndex: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action" });
  state.spellChain = [{ kind: "spell", playerIndex: casterIndex, card, energySpent: 0 } as never];
  state.chainOpen = true;
  return state;
}

const onChain = (state: GameState, instanceId: string): boolean =>
  state.spellChain.some((e) => (e as { card?: { instanceId: string } }).card?.instanceId === instanceId);

describe("a spell whose own text says it can't be countered", () => {
  it("is not counterable, is not offered, and survives the funnel", () => {
    const rage = spell(DECREE_OF_RAGE);
    const state = withSpellOnChain(rage);

    expect(canBeCountered(state, state.spellChain[0] as never), "Decree of Rage reported counterable").toBe(false);
    expect(counterableSpells(state), "an uncounterable spell was offered as a target").toEqual([]);
    // The funnel, reached directly the way Hard Bargain's answered ransom does.
    expect(onChain(counterSpell(state, rage.instanceId), rage.instanceId), "it was countered anyway").toBe(true);
  });

  it("an ORDINARY spell is still counterable — the control", () => {
    // Without this, every assertion above would pass against a `canBeCountered`
    // that had started returning false for everything, which would make the whole
    // counter mechanism silently inert.
    const plain = spell(PLAIN_SPELL);
    const state = withSpellOnChain(plain);
    expect(canBeCountered(state, state.spellChain[0] as never)).toBe(true);
    expect(counterableSpells(state)).toHaveLength(1);
    expect(onChain(counterSpell(state, plain.instanceId), plain.instanceId), "an ordinary spell was not countered").toBe(false);
  });
});

describe("Mel, Newly Awakened protects her controller's spells while Empowered", () => {
  const withMel = (casterIndex: 0 | 1, melIndex: 0 | 1, empowered: boolean): GameState => {
    const state = withSpellOnChain(spell(PLAIN_SPELL), casterIndex);
    state.players[melIndex]!.baseUnits = [unit(MEL, "mel")];
    return empowered ? empowerPermanent(state, "mel") : state;
  };

  it("does nothing un-Empowered (828.1.c)", () => {
    const state = withMel(0, 0, false);
    expect(canBeCountered(state, state.spellChain[0] as never), "an un-Empowered Mel protected a spell").toBe(true);
  });

  it("protects her own controller's spell once Empowered", () => {
    const state = withMel(0, 0, true);
    expect(canBeCountered(state, state.spellChain[0] as never), "an Empowered Mel did not protect her spell").toBe(false);
    expect(counterableSpells(state), "the protected spell was still offered as a target").toEqual([]);
  });

  it("does NOT protect the opponent's spell — 'YOUR spells', in BOTH directions", () => {
    // **Both arrangements, and MUTATION TESTING is why.** The first version tested
    // only Mel-on-side-1 against a side-0 spell; hardcoding the ownership read to
    // `players[0]` then finds no Mel at all and the test passes while the card is
    // wrong. Asserting the mirror is what actually pins "YOUR" — with Mel on side
    // 0 and the spell cast by side 1, a board-wide read shields the opponent.
    const melOnOne = withMel(0, 1, true);
    expect(canBeCountered(melOnOne, melOnOne.spellChain[0] as never), "Mel on side 1 shielded a side-0 spell").toBe(true);

    const melOnZero = withMel(1, 0, true);
    expect(canBeCountered(melOnZero, melOnZero.spellChain[0] as never), "Mel on side 0 shielded a side-1 spell").toBe(true);
  });

  it("is read at COUNTER time, not captured when the spell was cast", () => {
    // The board can change between the cast and the counter, which is the whole
    // reason this is a state read. A spell cast with Mel dormant becomes
    // protected the moment she is Empowered.
    const before = withMel(0, 0, false);
    expect(canBeCountered(before, before.spellChain[0] as never)).toBe(true);
    const after = empowerPermanent(before, "mel");
    expect(canBeCountered(after, after.spellChain[0] as never), "the protection was captured at cast time").toBe(false);
  });
});

describe("coverage tells the truth about both cards", () => {
  it("claims Decree of Rage, whose whole printed protection is this module", () => {
    expect(isCardImplemented(registry.get(DECREE_OF_RAGE))).toBe(true);
  });

  it("keeps Mel PARTIAL — only the first of her two sentences is written", () => {
    // "If a spell or ability you control would give -[Might] to a unit it
    // chooses, it gives an additional -1" is a REPLACEMENT effect this engine has
    // no seam for. Registration is per defId, so without the partial row her
    // counter-prevention half would report the whole card finished.
    expect(partialImplementationNote(registry.get(MEL)), "Mel has no partial note").toBeDefined();
    expect(isCardImplemented(registry.get(MEL)), "a half-written Mel reported implemented").toBe(false);
  });
});
