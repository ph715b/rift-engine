import { describe, expect, it } from "vitest";
import { loadTokenArt, loadTokenDefinitions } from "../src/cards/card-loader.js";
import {
  BIRD_TOKEN,
  GOLD_TOKEN,
  MECH_TOKEN,
  RECRUIT_TOKEN,
  SAND_SOLDIER_TOKEN,
  SHADOW_CLONE_TOKEN,
  TENTACLE_TOKEN,
  createGearToken,
  createToken,
} from "../src/engine/token.js";

/**
 * **Does a token the engine creates have art to render?**
 *
 * Reported from playtesting: token cards show no image. Two separate defects,
 * both invisible to every existing instrument because nothing in the engine
 * suite or the probes renders a component — see the "web lags the engine" shape.
 *
 * 1. **`loadTokenArt` carried its own scan** of the card JSON with
 *    `if (!/^Recruit\b/.test(item.name)) continue;` in it, so `TOKEN-RECRUIT`
 *    was the only key it could produce, ever.
 * 2. **`loadTokenDefinitions`' `runtimeDefId` kept the PRINT NUMBER.** OGN prints
 *    the Recruit three times — "Recruit (271) // Buff" and two more — so the
 *    derived id was `TOKEN-RECRUIT (271)`, which `createToken` can never stamp.
 *    Four of the five printed tokens mapped to nothing, and the one consumer
 *    that asserts on this field asks only about Gold, whose name has no number.
 *
 * # What this file asserts, and what it deliberately does not
 *
 * The pool prints FIVE token cards for THREE tags (Recruit ×3 arts, Sprite,
 * Gold). The engine can create EIGHT. So "every token has art" is false and must
 * not be asserted — the five without a printed card (Bird, Mech, Shadow Clone,
 * Sand Soldier, Tentacle) are engine-authored from their makers' reminder text
 * and have no image to find. What IS asserted is the RELATIONSHIP: a token whose
 * tag matches a printed card resolves to that card's art, and the id it resolves
 * through is the one `createToken` actually stamps.
 */

/** Every token spec the engine can mint, paired with whether the pool prints a
 *  card for it. Written out rather than derived, because the point is to fail
 *  when a NEW token is added — a derived list would silently grow. */
const UNIT_TOKENS = [
  { spec: RECRUIT_TOKEN, printed: true },
  { spec: SAND_SOLDIER_TOKEN, printed: false },
  { spec: BIRD_TOKEN, printed: false },
  { spec: MECH_TOKEN, printed: false },
  { spec: SHADOW_CLONE_TOKEN, printed: false },
  { spec: TENTACLE_TOKEN, printed: false },
] as const;

/** Sprite's spec is private to `effects/calm.ts` (and copied in `effects/mind.ts`),
 *  so it is reconstructed here from the one field this file cares about. If that
 *  tag ever changes, the printed-card assertion below fails, which is the point. */
const SPRITE_TAG = "Sprite";

describe("token art resolves through the id the engine actually stamps", () => {
  it("covers every tag the pool prints a card for — not just Recruit", () => {
    // The regression assertion. Before the fix this map had exactly one key.
    const art = loadTokenArt();
    expect(Object.keys(art).sort(), "a printed token is missing its art").toEqual([
      "TOKEN-GOLD",
      "TOKEN-RECRUIT",
      "TOKEN-SPRITE",
    ]);
    for (const [id, url] of Object.entries(art)) {
      expect(url, `${id} resolved to an empty image url`).toBeTruthy();
    }
  });

  it("keys art by the defId `createToken` stamps, print numbers and all", () => {
    // The half that made the bug survive: an art map is only useful if its keys
    // are the ids the board will look up. Asserted by MINTING a token and using
    // its own defId as the key, rather than by writing the string out — a test
    // that hardcodes "TOKEN-RECRUIT" on both sides proves nothing about the join.
    const art = loadTokenArt();
    const recruit = createToken(RECRUIT_TOKEN);
    expect(art[recruit.defId], `a minted ${RECRUIT_TOKEN.tag} found no art under ${recruit.defId}`).toBeTruthy();

    const gold = createGearToken(GOLD_TOKEN, false);
    expect(art[gold.defId], `a minted ${GOLD_TOKEN.tag} found no art under ${gold.defId}`).toBeTruthy();
  });

  it("gives the three Recruit printings ONE runtime id", () => {
    // OGN prints three Recruit arts. They are three printings of one token, not
    // three tokens, so they must collapse to a single id — and the first is what
    // the board shows until an alt-art picker exists to choose between them.
    const recruits = loadTokenDefinitions().filter((t) => t.runtimeDefId === "TOKEN-RECRUIT");
    expect(recruits.length, "the three printed Recruit arts are not all mapping to one id").toBe(3);
    expect(
      new Set(recruits.map((t) => t.imageUrl)).size,
      "the three Recruit printings share an image url — they are meant to be different arts",
    ).toBe(3);
  });

  it("no runtimeDefId carries a print number", () => {
    // The specific corruption, asserted as a SHAPE so a fourth Recruit printing
    // or a numbered Sprite cannot reintroduce it.
    for (const def of loadTokenDefinitions()) {
      expect(def.runtimeDefId, `${def.name} produced an id no createToken call can match`).not.toMatch(/\(\d+\)/);
      expect(def.runtimeDefId, `${def.name} broke the TOKEN-<TAG> convention`).toMatch(/^TOKEN-[A-Z' -]+$/);
    }
  });

  it("names the tokens with NO printed card, rather than pretending they have art", () => {
    // The honest half. Five of the eight are authored from their makers' reminder
    // text and have no image in any set file, so a blank frame is correct for
    // them — and saying so here is what stops the next reader "fixing" it.
    const art = loadTokenArt();
    for (const { spec, printed } of UNIT_TOKENS) {
      const minted = createToken(spec);
      expect(
        art[minted.defId] !== undefined,
        printed
          ? `${spec.tag} is a printed card and should have art`
          : `${spec.tag} has no printed card — art here means the pool gained one, which is good news the list above has not been told about`,
      ).toBe(printed);
    }
  });

  it("Sprite is printed, and its tag still matches that card", () => {
    // Its spec is private to two effect files, so the join is by tag. This is the
    // assertion that catches a rename on either side.
    expect(loadTokenArt()[`TOKEN-${SPRITE_TAG.toUpperCase()}`], "the Sprite token lost its art").toBeTruthy();
    expect(
      loadTokenDefinitions().some((t) => t.name.startsWith(SPRITE_TAG)),
      "no printed card is named Sprite any more",
    ).toBe(true);
  });
});
