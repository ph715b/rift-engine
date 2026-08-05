import { describe, expect, it } from "vitest";
import { loadTokenDefinitions } from "../src/cards/card-loader.js";
import {
  GOLD_TOKEN,
  GOLD_TOKEN_DEF_ID,
  createGearToken,
  placeGearToken,
  placeGoldTokens,
} from "../src/engine/token.js";
import { activatedAbilityFor, activationCostOf, hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { contextFor } from "../src/engine/effect-context.js";
import { makeState } from "./fixtures.js";

/**
 * GEAR tokens — the primitive SFD's first card wave stopped on.
 *
 * `token.ts` could mint a `UnitInstance` and nothing else, so "play a Gold gear
 * token" had nowhere to go. **Four independent agents hit this across eleven
 * cards** (Bushwhack, Draven - Vanquisher, Chemtech Cask, Plundering Poro, Wages
 * of Pain, Card Sharp, Fae Dragon, Eminent Benefactor, Honest Broker, Trove
 * Golem, Blood Money), plus two SFD battlefields — the largest single blocker
 * the set has produced, and one the survey missed because it bucketed cards by
 * keyword and by Equipment prose, and "play a Gold gear token" is neither.
 *
 * The Gold token is also the first ABILITY in this engine keyed to something
 * that is not in the CardRegistry, which is why `loadTokenDefinitions()` exists:
 * a table keyed to an id nothing can confirm is exactly how an ability ships
 * inert.
 */
describe("the Gold gear token", () => {
  it("is a real printed card, and the spec matches it", () => {
    // The anti-drift check, and the reason `loadTokenDefinitions` was written
    // rather than the spec just being hardcoded. If upstream renames the token
    // or changes its type, the ability below stays keyed to `TOKEN-GOLD` and
    // silently belongs to nothing — this is what says so.
    const tokens = loadTokenDefinitions();
    expect(tokens.length, "no Token-supertype card loaded at all — the scan is measuring nothing").toBeGreaterThan(0);

    const gold = tokens.find((t) => t.runtimeDefId === GOLD_TOKEN_DEF_ID);
    expect(gold, `no printed token maps to ${GOLD_TOKEN_DEF_ID}`).toBeDefined();
    expect(gold!.type, "the Gold token is a GEAR — a unit token would need a different primitive").toBe("Gear");
    expect(gold!.name).toBe("Gold // Buff");
    // The printed ability, which is what the ACTIVATED_ABILITIES entry claims to
    // implement. Asserted here so the two cannot come apart silently.
    expect(gold!.text).toContain("Kill this");
    expect(gold!.text).toContain("[Reaction]");
    expect(gold!.text).toContain("[Add]");
  });

  it("mints a GearInstance, not a unit", () => {
    const token = createGearToken(GOLD_TOKEN, true);
    expect(token.kind).toBe("Gear");
    expect(token.isToken).toBe(true);
    expect(token.defId).toBe(GOLD_TOKEN_DEF_ID);
    expect(token.name).toBe("Gold");
    // Present rather than undefined: a gear token that lacked the field would be
    // structurally different from every other gear on the board.
    expect(token.attachedToInstanceId).toBeNull();
  });

  it("enters exhausted when the card says so, and the caller must say", () => {
    // Every SFD card that makes one prints "exhausted". A gear token that
    // quietly entered ready would be a free rainbow Power on the turn it was
    // made, which is why this is a required argument rather than a default.
    expect(createGearToken(GOLD_TOKEN, true).exhausted).toBe(true);
    expect(createGearToken(GOLD_TOKEN, false).exhausted).toBe(false);
  });

  it("goes into activeGear, and only the caster's", () => {
    const state = makeState();
    const after = placeGearToken(state, 0, GOLD_TOKEN, true);
    expect(after.players[0]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.name).toBe("Gold");
    expect(after.players[1]!.activeGear, "the opponent got one too").toHaveLength(0);
    // Gear has no location, so nothing should have reached the battlefields.
    expect(after.battlefields).toEqual(state.battlefields);
  });

  it("makes several at once with distinct instance ids", () => {
    // "Play two Gold gear tokens exhausted" is printed on more than one card,
    // and two tokens sharing an instanceId would make the second unkillable —
    // every lookup would find the first.
    const after = placeGoldTokens(makeState(), 0, 3);
    const gear = after.players[0]!.activeGear;
    expect(gear).toHaveLength(3);
    expect(new Set(gear.map((g) => g.instanceId)).size).toBe(3);
    expect(gear.every((g) => g.exhausted)).toBe(true);
  });

  it("carries its printed ability, at the cost the card prints", () => {
    expect(hasActivatableAbility(GOLD_TOKEN_DEF_ID)).toBe(true);
    // "Kill this, [Exhaust]:" — both halves are printed, and both are costs.
    expect(activationCostOf(GOLD_TOKEN_DEF_ID)).toMatchObject({ killSelf: true, exhaust: true });
  });

  it("adds ONE rainbow Power, to the rainbow pool rather than a domain pool", () => {
    // Rainbow cannot land in `floatingPower`, which is keyed by Domain — the
    // same reason Malzahar's ritual has its own pool.
    const state = makeState();
    const before = state.players[0]!.floatingRainbowPower;
    const ability = activatedAbilityFor(GOLD_TOKEN_DEF_ID);
    expect(ability, "the Gold token has no registered ability").toBeDefined();

    const after = ability!.resolve(state, contextFor(0), {});
    expect(after.players[0]!.floatingRainbowPower).toBe(before + 1);
    expect(after.players[0]!.floatingPower, "rainbow leaked into a domain pool").toEqual(
      state.players[0]!.floatingPower,
    );
    expect(after.players[1]!.floatingRainbowPower, "the opponent gained Power").toBe(
      state.players[1]!.floatingRainbowPower,
    );
  });

  it("is flagged as banking a resource, which the AI will therefore never take", () => {
    // Recorded rather than worked around. `evaluate` scores board state, so a
    // banked resource can only tie with Pass, and this project has a standing
    // rule against speculative heuristics with no evaluative basis. The
    // consequence is real and worth knowing: a Gold token will sit unspent in
    // self-play, exactly as the six Seals do.
    expect(activatedAbilityFor(GOLD_TOKEN_DEF_ID)!.banksResource).toBe(true);
  });
});
