import { describe, expect, it } from "vitest";
import { createCardInstance, defaultCardRegistry } from "@rift-engine/engine";
import type { CardInstance, PlayerAction } from "@rift-engine/engine";
import { trashPlayableCards } from "../src/components/trash-plays.js";

/**
 * A card you may play from your TRASH has to reach the board.
 *
 * # The bug this pins, which shipped two sets before it was found
 *
 * `GameBoard`'s `human.hand.map` was the ONLY place a card ever received an
 * `onClick`, and the trash browser renders `<CardView inPile />` with no handler.
 * So no card could be played from the trash in the app at all, by any of the
 * three routes the engine offers:
 *
 *   `[Flow]` (829), 15 Vendetta spells — engine-complete the day this was found
 *   `UNL-025 Undying Legion`'s printed trash permission — shipped TWO SETS ago
 *   a granted trash charge (`trashUnitPlaysThisTurn`)
 *
 * **No instrument in this repo could see it.** The engine suite, the probes,
 * `reachability` and `walkout` all drive `submit` directly and never render a
 * component, so a Flow spell reports as exercised while a human has nothing to
 * click. Engine correct, board silently behind — the standing shape here, and
 * why this test sits at the seam rather than in the engine.
 *
 * # The division of labour, and what is NOT covered
 *
 * That the ENGINE offers a Flow play from the trash is pinned in the engine
 * package (`test/flow-keyword.test.ts`), so it is not re-tested here. This pins
 * the SELECTION — the half that did not exist — against hand-built actions, which
 * is how every logic test in this package works.
 *
 * It does NOT prove the rendered slot carries a click handler. `GameBoard` takes
 * no state injection — its props are a `MatchConfig` and a callback — so a DOM
 * test cannot stage a card into the trash without playing real turns. The wiring
 * is one `.map` over `fanCards` sharing the hand's own `onClick`. **If that map
 * is ever split so the trash half loses its handler, this test will not catch
 * it**, and saying so is better than implying coverage that is not here.
 */

const registry = defaultCardRegistry();
const TWILIGHT_SHROUD = "VEN-031"; // a real [Flow] spell
const UNDYING_LEGION = "UNL-025"; // a real printed trash permission, two sets older

const instance = (defId: string): CardInstance => createCardInstance(registry.get(defId));

/** A PlayCard action for a card, shaped the way `legalActions` emits one. Only
 *  the two fields the selection reads are filled — the rest of a real action is
 *  irrelevant to it, and inventing values would imply this depends on them. */
const playOf = (card: CardInstance): PlayerAction =>
  ({ type: "PlayCard", playerIndex: 0, card, payment: { energyRunes: [], powerRunes: [] } }) as unknown as PlayerAction;

describe("cards playable from the trash are offered to the board", () => {
  it("includes a [Flow] spell the engine has offered a play for", () => {
    const spell = instance(TWILIGHT_SHROUD);
    const offered = trashPlayableCards([spell], [playOf(spell)]);
    expect(
      offered.map((c) => c.instanceId),
      "a playable Flow spell in the trash was not offered — the board has nothing to click",
    ).toEqual([spell.instanceId]);
  });

  it("offers NOTHING for a trash card with no legal play", () => {
    // The control that says this reads the ACTIONS and not the zone. Without it,
    // a selection of "everything in the trash" would pass the test above — and
    // that is the wrong answer, since most of a trash is unplayable.
    const spell = instance(TWILIGHT_SHROUD);
    expect(trashPlayableCards([spell], [])).toEqual([]);
  });

  it("never returns a card that is in HAND rather than the trash", () => {
    // The fan already renders the hand, so a selection that also matched hand
    // cards would render every one of them twice.
    const inHand = instance(TWILIGHT_SHROUD);
    expect(trashPlayableCards([], [playOf(inHand)])).toEqual([]);
  });

  it("matches by INSTANCE, not by card id", () => {
    // Two copies of one spell can sit in the trash with only one of them
    // playable — a granted trash charge is spent per instance. Matching on
    // `defId` would offer both and let the player click the one the engine has
    // no action for.
    const playable = instance(TWILIGHT_SHROUD);
    const other = instance(TWILIGHT_SHROUD);
    const offered = trashPlayableCards([playable, other], [playOf(playable)]);
    expect(offered.map((c) => c.instanceId)).toEqual([playable.instanceId]);
  });

  it("includes Undying Legion, whose trash permission predates [Flow] by two sets", () => {
    // The card that proves this was never a Vendetta problem. Its permission is a
    // printed replaced cost rather than a parsed keyword, which is also why the
    // selection reads actions rather than any one keyword's field.
    const legion = instance(UNDYING_LEGION);
    expect(trashPlayableCards([legion], [playOf(legion)]).map((c) => c.instanceId)).toEqual([legion.instanceId]);
  });
});
