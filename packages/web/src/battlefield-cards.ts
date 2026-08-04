import { loadBattlefieldDefinitions, type BattlefieldDefinition } from "@rift-engine/engine";

/**
 * The real Battlefield CARD behind a `BattlefieldState`.
 *
 * `BattlefieldState` carries a `name` and nothing else — no `defId`, no art, no
 * rules text — because `card-loader`'s `shouldSkip` deliberately excludes
 * Battlefield-type cards from `loadCardDefinitions` (there is no per-name ability
 * for a playable definition to hang off yet). `loadBattlefieldDefinitions` is the
 * presentation-only side lookup that survived that exclusion, and it has art and
 * text for all 24.
 *
 * Until now it was used ONLY by the deck builder, which is why a player could pick
 * a battlefield knowing its ability and then never see that ability again once the
 * game started. Reported as "not sure if battlefield abilities are working" — and
 * they are not, they do not exist yet, but nobody could tell either way without
 * being able to read one.
 *
 * Keyed by NAME because that is the only handle the state offers. Safe today:
 * `loadBattlefieldDefinitions` already de-duplicates by name, and
 * `validateDeckList` picks from this same list. The day `BattlefieldState` gains a
 * `defId` this should key off that instead — see docs/battlefields-and-ui-prompt.md,
 * where giving it one is step 2.
 */
const byName = new Map<string, BattlefieldDefinition>(loadBattlefieldDefinitions().map((def) => [def.name, def]));

/** The card for a battlefield in play, or undefined for a name no card matches —
 *  which is not an error worth throwing over: a deck file can name anything, and a
 *  battlefield with no art must still render. */
export function battlefieldCard(name: string): BattlefieldDefinition | undefined {
  return byName.get(name);
}
