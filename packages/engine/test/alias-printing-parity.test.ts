import { describe, expect, it } from "vitest";
import { canonicalDefId, loadCardDefinitions } from "../src/cards/card-loader.js";
import {
  canPlayToOpenBattlefield,
  placementGrantFor,
  targetingForUnitTrigger,
  unitTriggerForCard,
} from "../src/engine/unit-triggers.js";
import { gearEntersExhausted } from "../src/engine/deploy.js";
import {
  cardHasOptionalExhaustCost,
  cardMayMoveToBase,
  cardMovesTarget,
  cardPlacesTokens,
  costExhaustsLegend,
  discardChoiceOf,
  hasXRainbowCost,
  optionalUnitCostOf,
  optionalXpCostOf,
  optionalXpEnergyDiscountOf,
  repeatCostOf,
  targetMustBeElsewhere,
  xpWidenedTargetingFor,
} from "../src/engine/card-effects.js";
import { hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { ignoresDeflectWhilePaying } from "../src/engine/cost-modifiers.js";
import { isCardImplemented } from "../src/engine/coverage.js";

/**
 * **An alternate printing IS the card (132.1), so every lookup must answer the
 * same for both.**
 *
 * This engine keys a lot of behaviour off defId, in two different shapes:
 *
 *   - the trigger/effect REGISTRIES, where `mergeRegistries` expands an alias
 *     after merging, so a printing is registered along with its canonical and
 *     nothing more is owed;
 *   - hand-written TABLES (`PLACEMENT_GRANTS`, `GEAR_ENTERING_EXHAUSTED`,
 *     `MOVE_TARGET_SPELL_DEF_IDS`, …), which are written by defId and expand
 *     nothing.
 *
 * The second shape is where printings fall through, and it fails SILENTLY: the
 * card is implemented, its registry entry resolves, and one clause of it simply
 * does not apply. **Reported from playtesting** — "can't play rengar trophy
 * hunter to an open battlefield the opponent is attacking when I don't have
 * units there" — which is VEN-179, an alias of UNL-120, whose placement grant
 * was keyed by the raw defId.
 *
 * That is the tenth instance of the silently-inert-printing class this set has
 * produced, and the first found by a player rather than by an instrument. So it
 * is an instrument now: every aliased printing is asked every defId-keyed
 * question the engine exports, and must answer exactly what its canonical does.
 */

const defs = loadCardDefinitions();
const aliased = defs.filter((d) => canonicalDefId(d.id) !== d.id);

/** Every pure `defId -> value` lookup the engine exports. A new one added
 *  without a row here is not covered — which is the honest limit of this gate,
 *  and why the list names them rather than reflecting over a module. */
const LOOKUPS: readonly [string, (defId: string) => unknown][] = [
  ["canPlayToOpenBattlefield", canPlayToOpenBattlefield],
  // **The one the playtest report was about.** `canPlayToOpenBattlefield` above
  // only sees ONE of the four grants, so the gate could not have caught Rengar
  // without this row — his is `occupiedEnemyBattlefield`.
  ["placementGrantFor", (id) => placementGrantFor(id) ?? "none"],
  ["gearEntersExhausted", gearEntersExhausted],
  ["hasActivatableAbility", hasActivatableAbility],
  ["costExhaustsLegend", costExhaustsLegend],
  ["hasXRainbowCost", hasXRainbowCost],
  ["cardPlacesTokens", cardPlacesTokens],
  ["cardMovesTarget", cardMovesTarget],
  ["cardMayMoveToBase", cardMayMoveToBase],
  ["targetMustBeElsewhere", targetMustBeElsewhere],
  ["cardHasOptionalExhaustCost", cardHasOptionalExhaustCost],
  ["ignoresDeflectWhilePaying", ignoresDeflectWhilePaying],
  ["optionalXpCostOf", optionalXpCostOf],
  ["optionalXpEnergyDiscountOf", optionalXpEnergyDiscountOf],
  // Shape-only for the ones returning objects: identity would fail on two equal
  // literals, and what matters is that a printing gets an answer at all.
  ["discardChoiceOf (defined?)", (id) => discardChoiceOf(id) !== undefined],
  ["optionalUnitCostOf (defined?)", (id) => optionalUnitCostOf(id) !== undefined],
  ["repeatCostOf (defined?)", (id) => repeatCostOf(id) !== undefined],
  ["xpWidenedTargetingFor (defined?)", (id) => xpWidenedTargetingFor(id) !== undefined],
  ["unitTriggerForCard (defined?)", (id) => unitTriggerForCard(id) !== undefined],
  ["targetingForUnitTrigger.kind", (id) => targetingForUnitTrigger(id).kind],
];

describe("an alternate printing answers every defId lookup the same as its canonical", () => {
  it("has printings to check at all — the premise", () => {
    // Without this the equality below is vacuous, and it has been close: the ten
    // Vendetta reprints were invisible to the loader entirely until the suffix
    // filter came off.
    expect(aliased.length, "no aliased printings — this file measures nothing").toBeGreaterThan(40);
  });

  it("agrees on every lookup, for every printing", () => {
    const disagreements: string[] = [];

    for (const printing of aliased) {
      const canonical = canonicalDefId(printing.id);
      for (const [name, lookup] of LOOKUPS) {
        const a = lookup(printing.id);
        const b = lookup(canonical);
        if (a !== b) disagreements.push(`${printing.id} -> ${canonical}: ${name} printing=${String(a)} canonical=${String(b)}`);
      }
    }

    // **Exactly empty.** A disagreement is a printing that behaves differently
    // from the card it IS, which is never right — the fix is always to
    // canonicalise the lookup, never to add the printing to the table.
    expect(disagreements, "an alternate printing behaves differently from its canonical").toEqual([]);
  });

  it("...and coverage agrees too", () => {
    // Separate because it takes a definition rather than an id, and because it is
    // the one that has failed before: an unimplemented-looking printing is how
    // the ten inert Vendetta reprints presented.
    for (const printing of aliased) {
      const canonical = defs.find((d) => d.id === canonicalDefId(printing.id))!;
      expect(
        isCardImplemented(printing),
        `${printing.id} reports differently from ${canonical.id}`,
      ).toBe(isCardImplemented(canonical));
    }
  });
});
