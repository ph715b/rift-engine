import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **SFD-025 Rengar - Pouncing — "I can be played to a battlefield you're
 * attacking."**
 *
 * Reported from playtesting: *"unable to play rengar, pouncing to a battlefield
 * where i am attacking."* Exactly right, and the clause was the whole card: he is
 * otherwise a vanilla `[Assault 2]` body with `[Reaction]` timing.
 *
 * # Why it was unreachable, and why the grant being registered was not enough
 *
 * The placement grant WAS registered (`PLACEMENT_GRANTS["SFD-025"]`) and the
 * enumerator DID consult it. Then a second gate ran: **813**'s narrowing, which
 * outside a Neutral state limits a Unit to "the controlling player's base or a
 * battlefield they control" (813.3.a). **A battlefield you are ATTACKING is never
 * one you control**, so the grant was consulted and then cancelled, every time.
 *
 * **355.2.b** is what settles it: "Some Game Effects may grant players permission
 * to play Units to locations that are not normally Valid. **Such locations become
 * Valid for the purposes of Playing the Unit.**" So the card's own sentence makes
 * that battlefield valid, and 813 describes the ordinary set rather than
 * overriding a printed permission. `[Ambush]` already had this exemption via
 * **822.1.c** ("adds options to locations that are valid for a Unit to be played
 * to") — the same mechanism, carried by a keyword instead of printed on a card.
 *
 * The note beside that Ambush exemption records the identical failure in as many
 * words: *"without this the keyword was unreachable: the card gained Reaction
 * timing and then had nowhere legal to go."*
 */

const RENGAR = "SFD-025";
const registry = defaultCardRegistry();

const runes = () =>
  Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Fury", "Chaos", "Calm", "Body", "Mind", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));

/**
 * The reported board, reached the real way: my unit walks into their battlefield,
 * the Cleanup stages a Combat Showdown, and I hold Focus with Rengar in hand.
 *
 * Driven through the move rather than hand-stamped, because `contestedByIndex` is
 * what "a battlefield you're attacking" reads and a hand-built Showdown could set
 * it without the designation ever really being handed out.
 */
function attacking(): { state: GameState; rengarId: string } {
  const rengar = createCardInstance(registry.get(RENGAR));
  const start = makeState({ phase: "Action", activePlayerIndex: 0 });
  start.players[0]!.hand = [rengar];
  start.players[0]!.channeled = runes();
  start.players[0]!.baseUnits = [makeUnit({ instanceId: "walker", name: "Walker" })];
  start.battlefields[0] = {
    ...start.battlefields[0]!,
    controllerId: "p2",
    units: { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] },
  };

  const move = legalActions(start).find(
    (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes("walker"),
  );
  expect(move, "the move into their battlefield was never offered").toBeDefined();
  return { state: resolveHeldTriggers(submit(start, move!).state), rengarId: rengar.instanceId };
}

const rengarPlays = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === RENGAR);

describe("the fixture really is a battlefield I am attacking", () => {
  it("opens a Combat Showdown with me as the Attacker", () => {
    // Every assertion below is about a state this must actually be. Without it,
    // "Rengar is offered at bf1" could be true of an ordinary Neutral turn, where
    // 813 never bites and the card needs no permission at all.
    const { state } = attacking();
    expect(state.turnState, "no Showdown opened").toBe("Showdown");
    expect(state.showdownKind).toBe("Combat");
    expect(state.battlefields[0]!.contestedByIndex, "I am not the attacker here").toBe(0);
    expect(state.battlefields[0]!.controllerId, "I control it, so 813 would not narrow it away").not.toBe("p1");
  });
});

describe("he can be played to the battlefield he is attacking", () => {
  it("is OFFERED there", () => {
    const { state } = attacking();
    const destinations = rengarPlays(state).map((a) => a.destinationBattlefieldId ?? "base");

    expect(destinations, "the reported bug: only base was offered").toContain("bf1");
  });

  it("...and the VALIDATOR agrees — the offered-then-refused half", () => {
    // This is the pair that actually broke: the grant was registered and read by
    // the enumerator's presence rule, and 813 refused it in both places. A fix to
    // one side alone reproduces this repo's most repeated bug from the other
    // direction.
    const { state } = attacking();
    const play = rengarPlays(state).find((a) => a.destinationBattlefieldId === "bf1");
    expect(play, "nothing to validate — the enumerator did not offer it").toBeDefined();
    expect(validatePlayCard(state, play!)).toMatchObject({ ok: true });
  });

  it("and the play really lands him there", () => {
    const { state, rengarId } = attacking();
    const play = rengarPlays(state).find((a) => a.destinationBattlefieldId === "bf1")!;
    const { state: after, result } = submit(state, play);

    expect(result, `the play was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const there = (after.battlefields[0]!.units["p1"] ?? []).map((u) => u.instanceId);
    expect(there, "he was accepted and did not arrive").toContain(rengarId);
  });
});

describe("the narrowing still holds for everyone else", () => {
  it("an ordinary Reaction unit is NOT offered the battlefield I am attacking", () => {
    // The scope control. The fix widens 813 only for a card whose own text names
    // the destination; a change that dropped the narrowing wholesale would show
    // here. Shen - Kinkou (OGN-241) is a plain [Reaction] unit with no placement
    // grant of any kind.
    const shen = createCardInstance(registry.get("OGN-241"));
    const { state } = attacking();
    const withShen: GameState = {
      ...state,
      players: state.players.map((p, i) => (i === 0 ? { ...p, hand: [shen], channeled: runes() } : p)) as GameState["players"],
    };

    const offered = legalActions(withShen)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === shen.instanceId)
      .map((a) => a.destinationBattlefieldId ?? "base");

    expect(offered.length, "Shen was not offered at all, so this proves nothing").toBeGreaterThan(0);
    expect(offered, "813's narrowing was dropped for every card, not just Rengar").not.toContain("bf1");
  });
});
