import type { BattlefieldState, GameState } from "../model/game-state.js";

/**
 * BATTLEFIELD TOKENS — battlefields a card puts onto the board mid-game, as
 * opposed to the two each player presents at setup.
 *
 * # Why these are authored here rather than loaded from card data
 *
 * `loadBattlefieldDefinitions` reads Battlefield-type cards out of the set JSON,
 * and **neither of these is in it** — measured across all four set files on
 * 2026-08-14, which is exactly what UNL-147 Baron Nashor's refusal said ("the Pit
 * has no card data in unl.json"). That part of the refusal was correct and is
 * still correct.
 *
 * What follows from it is the opposite of what the refusal concluded. A token's
 * rules text is printed on the card that makes it, in the reminder text, so the
 * text is not missing at all — it is quoted below from Baron Nashor and from
 * Ivern - Green Father. `token.ts` already reaches the same conclusion for UNIT
 * and GEAR tokens whose faces the registry cannot hold, and `coverage-drift`'s
 * own note says it: *"'Real' is not the same as 'in the CardRegistry'."*
 *
 * # The other half of that refusal was wrong, and it is worth saying why
 *
 * It also said adding a battlefield is SYSTEMIC — "nothing in this engine can add
 * a battlefield at all, `battlefieldPair` builds exactly two at setup with ids
 * stable for the game". `battlefieldPair` does build exactly two, and the ids
 * are stable; neither sentence implies the ENGINE is fixed at two. Measured:
 * `state.battlefields` is walked as a list at every site but four, none of which
 * assumes a length, and the web board already sizes its grid with
 * `repeat(${state.battlefields.length}, 1fr)`. So what was missing was a
 * function, not a redesign.
 *
 * # The ids
 *
 * `bf-token-<name>` rather than `bf-2`, and deliberately: the setup ids are
 * POSITIONAL (`bf-0` is the human's contribution) and a token belongs to neither
 * player, so borrowing that sequence would make the id say something false. It
 * is also what makes "if it's not there already" a lookup rather than a search
 * by name.
 */
export interface BattlefieldTokenDefinition {
  /** The runtime defId battlefield-ability tables key off — the same
   *  `TOKEN-`-prefixed shape `loadTokenDefinitions` gives a unit or gear token,
   *  so one convention covers all three kinds. */
  defId: string;
  /** The `BattlefieldState.id` this token takes when it enters. Stable for the
   *  game, like the two setup ids, and unique because a token is added only when
   *  it is "not there already". */
  id: string;
  name: string;
  /** The printed reminder text, quoted from the card that makes the token. */
  text: string;
}

export const BARON_PIT: BattlefieldTokenDefinition = {
  defId: "TOKEN-BARON PIT",
  id: "bf-token-baron-pit",
  name: "Baron Pit",
  // UNL-147 Baron Nashor's reminder text, verbatim.
  text: "Units can move here from anywhere.",
};

export const BRUSH: BattlefieldTokenDefinition = {
  defId: "TOKEN-BRUSH",
  // **No fixed id, unlike the Pit.** The Brush REPLACES a battlefield in place —
  // it does not arrive as a new location — so it takes over the id of whatever it
  // replaced, and the units, control and Contested status standing there are
  // untouched. `id` is therefore never used for it; it is here because the shape
  // is shared, and `replaceBattlefieldWithToken` ignores it.
  id: "bf-token-brush",
  name: "Brush",
  // UNL-195 Ivern - Green Father's reminder text, verbatim.
  text: "Bird, Cat, Dog, Poro, and Ivern units have +1 [Might] in Brush. It can be swapped back when scored.",
};

/** The tags Brush pumps — "Bird, Cat, Dog, Poro, and Ivern units", printed. */
export const BRUSH_TAGS: readonly string[] = ["Bird", "Cat", "Dog", "Poro", "Ivern"];
/** ...by how much. */
export const BRUSH_MIGHT = 1;

const BATTLEFIELD_TOKENS: readonly BattlefieldTokenDefinition[] = [BARON_PIT, BRUSH];

/**
 * Replaces the battlefield at `battlefieldId` with a token, remembering what it
 * was.
 *
 * **In place, keeping the id.** A battlefield's id is what every action, every
 * chain entry and every unit's location references, and the units standing there
 * do not move because the ground under them changed — so this swaps the two
 * fields that say WHICH battlefield this is (`name`, `defId`) and nothing else.
 * Control, Contested status, hidden cards and both sides' units are untouched,
 * which is what "replace THAT battlefield" means rather than "remove it and add
 * another".
 *
 * `swappedFrom` is what makes "it can be swapped back when scored" possible at
 * all. It is captured here rather than re-derived, because after the swap nothing
 * on the board remembers the original — the name and the defId are the whole of a
 * battlefield's identity in this engine.
 *
 * Already-a-Brush is a no-op with the memory left alone: swapping a Brush for a
 * Brush would otherwise overwrite `swappedFrom` with "Brush" and strand the
 * original for good.
 */
export function replaceBattlefieldWithToken(
  state: GameState,
  battlefieldId: string,
  token: BattlefieldTokenDefinition,
): GameState {
  const index = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (index === -1) return state;
  const bf = state.battlefields[index]!;
  if (bf.defId === token.defId) return state;
  const battlefields = [...state.battlefields];
  battlefields[index] = {
    ...bf,
    name: token.name,
    defId: token.defId,
    swappedFrom: { name: bf.name, ...(bf.defId !== undefined ? { defId: bf.defId } : {}) },
  };
  return { ...state, battlefields };
}

/**
 * Puts a swapped battlefield back — the Brush's "it can be swapped back when
 * scored".
 *
 * A no-op for a battlefield that was never swapped, so the caller can ask it of
 * every scoring without a branch.
 *
 * The original may have had NO `defId` (a deck naming a battlefield no card
 * matches), so the field is deleted rather than set to undefined — `defId` is
 * optional and "absent means no printed ability", which an explicit `undefined`
 * would satisfy structurally but not under `exactOptionalPropertyTypes`.
 */
export function revertSwappedBattlefield(state: GameState, battlefieldId: string): GameState {
  const index = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (index === -1) return state;
  const bf = state.battlefields[index]!;
  if (bf.swappedFrom === undefined) return state;
  const { swappedFrom: _dropped, defId: _alsoDropped, ...rest } = bf;
  const battlefields = [...state.battlefields];
  battlefields[index] = {
    ...rest,
    name: bf.swappedFrom.name,
    ...(bf.swappedFrom.defId !== undefined ? { defId: bf.swappedFrom.defId } : {}),
  };
  return { ...state, battlefields };
}

/** Is this battlefield currently a Brush? */
export function isBrush(state: GameState, battlefieldId: string | undefined): boolean {
  if (battlefieldId === undefined) return false;
  return state.battlefields.find((b) => b.id === battlefieldId)?.defId === BRUSH.defId;
}

/** For `coverage-drift`'s reality check, which asks three sources whether a
 *  defId names a real card. This is the third. */
export function battlefieldTokenDefIds(): string[] {
  return BATTLEFIELD_TOKENS.map((t) => t.defId);
}

/** The token a defId names, or undefined. */
export function battlefieldTokenFor(defId: string): BattlefieldTokenDefinition | undefined {
  return BATTLEFIELD_TOKENS.find((t) => t.defId === defId);
}

/** Is this token already on the board? — "add the Baron Pit battlefield token to
 *  the board **if it's not there already**". */
export function battlefieldTokenOnBoard(state: GameState, token: BattlefieldTokenDefinition): boolean {
  return state.battlefields.some((bf) => bf.id === token.id);
}

/**
 * Puts a battlefield token onto the board, or returns the state unchanged when it
 * is already there.
 *
 * **Appended rather than inserted**, so the two setup battlefields keep their
 * positions and every id already in flight still means what it meant. The board
 * renders them in array order, so the Pit shows up beside the two presented ones
 * rather than between them.
 *
 * It enters CONTROLLED BY NOBODY and uncontested, which is the state a
 * battlefield starts a game in — nothing about arriving mid-game makes it
 * anyone's, and the unit that brought it establishes control the ordinary way
 * (a Non-Combat Showdown staged by the following Cleanup, 316.8.b.1).
 */
export function addBattlefieldToken(state: GameState, token: BattlefieldTokenDefinition): GameState {
  if (battlefieldTokenOnBoard(state, token)) return state;
  const added: BattlefieldState = {
    id: token.id,
    name: token.name,
    defId: token.defId,
    controllerId: null,
    units: {},
    contestedByIndex: null,
    hiddenCards: [],
  };
  return { ...state, battlefields: [...state.battlefields, added] };
}

/**
 * Does this battlefield let a unit move here from ANYWHERE — the Baron Pit's
 * whole printed text?
 *
 * Rule 813 restricts a battlefield-to-battlefield move to units with
 * `[Ganking]`; the Pit overrides that for its own destination and nothing else.
 * Asked by BOTH `legal-actions.movableTo` and `validate-move-unit`, because an
 * enumerator and a validator disagreeing about a move is the offered-then-refused
 * shape this repo has shipped three times.
 *
 * Keyed off the destination's `defId` rather than its id, so the rule belongs to
 * the token rather than to the slot it happens to occupy.
 */
export function battlefieldTakesMovesFromAnywhere(state: GameState, destinationId: string): boolean {
  const bf = state.battlefields.find((b) => b.id === destinationId);
  return bf?.defId === BARON_PIT.defId;
}

/**
 * UNL-147 Baron Nashor's play-time clause, as an answer to the one question
 * `execute-play-card` needs: does playing THIS card add the Pit, and if so where
 * does the card land?
 *
 * > "As you play me, add the Baron Pit battlefield token to the board if it's not
 * > there already. **If you do, I enter there.**"
 *
 * **"If you DO" is load-bearing**, and reading it as "he always enters the Pit"
 * would be a different card. With the Pit already on the board — a second Baron,
 * or an Ultimate beside a plain one — nothing is added, the conditional is false,
 * and he enters wherever the play named. So this returns `enterThere` only in the
 * case that actually added it.
 *
 * **A replacement on the PLAY, not an on-play trigger**, and that is why it lives
 * here rather than in `unit-triggers.ts`. `dispatchOnPlayUnit` runs once the unit
 * is already standing somewhere; a Baron who arrived at base and was then moved
 * would fire arrival triggers for the wrong location and contest a battlefield he
 * was never played to.
 *
 * **Both printings**, because `mergeRegistries` aliases UNL-238 "(Ultimate)" to
 * UNL-147's entry and an alias cannot reach a site comparing a defId to a
 * literal — the same trap his Might aura's own comment records in `effects/chaos.ts`.
 */
export function baronPitEntryFor(
  state: GameState,
  card: { defId: string; kind: string },
): { token: BattlefieldTokenDefinition; enterThere: string } | undefined {
  if (!BARON_NASHOR_DEF_IDS.includes(card.defId)) return undefined;
  if (battlefieldTokenOnBoard(state, BARON_PIT)) return undefined;
  return { token: BARON_PIT, enterThere: BARON_PIT.id };
}

/** Baron Nashor and his "(Ultimate)" alternate printing. */
const BARON_NASHOR_DEF_IDS: readonly string[] = ["UNL-147", "UNL-238"];

/** For coverage: the card this module implements a clause of. */
export function battlefieldTokenSourceDefIds(): string[] {
  return [...BARON_NASHOR_DEF_IDS];
}
