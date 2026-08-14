import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions, secondTargetIsAtDestination } from "../src/engine/legal-actions.js";
import { cardEffectDefIds, cardMayMoveToBase, cardMovesTarget, moveDestinationAllowed } from "../src/engine/card-effects.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { legendAbilityDefIds, legendTriggerKeysInUse } from "../src/engine/legend-abilities.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { loadBattlefieldDefinitions, loadTokenDefinitions } from "../src/cards/card-loader.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Wave 8 (Calm) REFUSED all eight of its cards. This file is the measurement
 * behind each refusal, not a description of it.
 *
 * Every assertion below records the CURRENT, WRONG answer at a seam a
 * shared file owns, so that closing the gap fails loudly here instead of
 * silently changing behaviour nobody was watching — the standing rule in
 * CLAUDE.md for a recorded divergence.
 *
 * Each block carries a POSITIVE CONTROL: a neighbouring card that already works
 * through the same code path. Without one, "the card does nothing" and "my
 * fixture does nothing" are the same observation, which is the failure mode this
 * repo keeps paying for.
 */

const registry = defaultCardRegistry();

const CHARM = "OGN-043"; // the positive control for every move-destination claim
const TRICKSY_TENTACLES = "UNL-054";
const MONCH = "UNL-035";
const SHADOW_WATCHER = "UNL-037";
const FORGOTTEN_SIGNPOST = "UNL-045";
const LILTING_LULLABY = "UNL-190";
const VEX_GLOOMIST = "UNL-193";
const SHADOW = "UNL-194";
const IVERN_GREEN_FATHER = "UNL-195";
const RENATA_CHEM_BARONESS = "SFD-201"; // the Legend UNL-193 is claimed to clone
const YASUO_UNFORGIVEN = "OGN-259"; // the pool's ONLY `movesTarget` activated ability
const SPOILS_OF_WAR = "OGN-144"; // a card whose energy cost really does move

/** Is `defId` registered as a Spell/Gear effect?
 *
 *  Through `cardEffectDefIds` rather than `effectForCard`, which takes a
 *  CardInstance: called with a bare defId string it reads `.defId` off a string,
 *  gets `undefined`, and reports EVERY card unimplemented. The first draft of
 *  this file did exactly that and three "pins" passed vacuously. */
const hasEffect = (defId: string) => cardEffectDefIds().includes(defId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

// ---------------------------------------------------------------------------
// UNL-054 Tricksy Tentacles — "Move any number of enemy units with the same
// controller and a total Might of 8 or less to a single location."
//
// Wave 7 refused it needing THREE shared changes: a `MOVE_TARGET_SPELL_DEF_IDS`
// row, a `MOVE_TO_BASE_DEF_IDS` row, and a `withDestinations` that derives the
// current location from a target LIST rather than a single id.
//
// Measured here, only the FIRST is true for the battlefield axis. Every filter
// `withDestinations` applies already tolerates an absent `targetUnitInstanceId`,
// which is exactly what a `unitList` play carries.
// ---------------------------------------------------------------------------
// **The UNL-054 Tricksy Tentacles block that stood here was DELETED on
// 2026-08-13 — superseded, not weakened.**
//
// It pinned the card as unregistered and its destination as unreachable, and it
// was right on both counts when written. Its own measurements are what made the
// card cheap to finish: it found the destination needed ONE shared row rather
// than the three a wave-7 note predicted, because `withDestinations` derives its
// "already there" index from a single-target field a `unitList` play never sets.
//
// The card is written and its base axis landed with it, after the project-owner
// ruling of 2026-08-13 that "a single location" includes the enemy base. Full
// coverage — the group move, the Might ceiling, both destination axes and an
// inert-resolver mutation — lives in `unl-054-tricksy-tentacles.test.ts`.

// ---------------------------------------------------------------------------
// UNL-194 Shadow — "If you play me to a battlefield, I enter ready."
// The half wave 7 left; his activated stun is written.
// ---------------------------------------------------------------------------
describe("UNL-194 Shadow: played to a battlefield, he still arrives EXHAUSTED", () => {
  function shadowState(): { state: GameState; cardId: string } {
    const shadow = realUnitInstance(SHADOW);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [shadow];
    s.players[0]!.channeled = runes("Calm", 8);
    // Rule 813 wants presence at the destination for a direct play.
    s.battlefields[0]!.units = { p1: [makeUnit({ name: "Anchor", instanceId: "anchor" })] };
    return { state: s, cardId: shadow.instanceId };
  }

  const shadowAt = (state: GameState) =>
    (state.battlefields[0]!.units["p1"] ?? []).find((u) => u.defId === SHADOW);

  it("THE PIN: he enters exhausted, which is not what he prints", () => {
    const { state, cardId } = shadowState();
    const play = playsOf(state, cardId).find((p) => p.destinationBattlefieldId === "bf1");
    expect(play, "no play of Shadow to a battlefield was enumerated").toBeDefined();

    const { state: next, result } = submit(state, play!);
    expect(result).toMatchObject({ type: "Ok" });
    const landed = shadowAt(next);
    expect(landed, "Shadow never reached bf1").toBeDefined();
    // WRONG ANSWER, deliberately asserted. `deploy.unitEntersReady` is handed
    // `action.acceleratePaid` and nothing about WHERE the unit landed, so
    // `conditionalEntersReady` cannot ask "to a battlefield?" at all.
    // **INVERTED 2026-08-13.** The pin was right and its diagnosis was exact:
    // `unitEntersReady` was handed nothing about WHERE the unit landed. It is
    // handed a destination now, from `execute-play-card` as well as from deploy's
    // own two functions — the executor was the site that mattered and the one a
    // narrower fix would have missed.
    expect(landed!.exhausted, "Shadow stopped entering ready at a battlefield").toBe(false);
  });

  it("POSITIVE CONTROL: the same play DOES produce a ready Shadow when the board says so", () => {
    // Confront's this-turn permission, read by the same predicate. Proves the
    // fixture can observe readiness at all, so the assertion above is about the
    // card and not about the harness.
    const { state, cardId } = shadowState();
    state.players[0]!.unitsEnterReadyThisTurn = true;
    const play = playsOf(state, cardId).find((p) => p.destinationBattlefieldId === "bf1");
    const { state: next, result } = submit(state, play!);
    expect(result).toMatchObject({ type: "Ok" });
    expect(shadowAt(next)!.exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNL-035 Monch — "If an opponent controls a stunned unit, I cost [2] less and
// enter ready."
// ---------------------------------------------------------------------------
// **The UNL-035 Monch block that stood here was DELETED on 2026-08-13 —
// superseded, not weakened.**
//
// It pinned BOTH halves as unreachable and measured each: `modifiedEnergyCost`
// returned 6 beside a stunned enemy, and he landed exhausted through a real
// `submit`. Both were true, and its measurements are what made the card cheap —
// it named the two files and the shape of each edit.
//
// Both halves landed together, reading one shared predicate so a discounted
// Monch can never arrive exhausted. Coverage lives in `monch-leblanc.test.ts`.

// ---------------------------------------------------------------------------
// UNL-037 Shadow Watcher — "If a friendly unit died during your Beginning Phase
// this turn, I enter ready."
// ---------------------------------------------------------------------------
// **The UNL-037 Shadow Watcher block that stood here was DELETED on 2026-08-13
// — superseded, not weakened.**
//
// It proved the gap by WHOLE-STATE DIFF: one death in the Beginning Phase and
// one in the Action Phase left byte-identical serialized `PlayerState`. That is
// a stronger measurement than "I looked for a field", and it is what made the
// edit obvious — `unitsLostInBeginningPhaseThisTurn` beside the wider counter,
// written only when the phase AND the seat both match.
//
// Coverage lives in `shadow-watcher-lullaby.test.ts`, where the seat half is
// pinned by a test that mutation caught being vacuous first.

// ---------------------------------------------------------------------------
// UNL-045 Forgotten Signpost — "[Action][>] Exhaust a unit you control,
// [Exhaust]: Move a different unit you control to the location of the unit you
// exhausted to pay for this ability."
// ---------------------------------------------------------------------------
describe("UNL-045 Forgotten Signpost: the cost seam, measured", () => {
  it("THE PIN THAT CLOSED: the ability IS registered now", () => {
    // **Asserted the opposite until 2026-08-14.** Shadow's stun is kept beside it
    // as the control it always was: both come through the same lookup, so this
    // pair says the accessor works and the Signpost's entry is real.
    expect(activatedAbilityFor(SHADOW)).toBeDefined();
    expect(activatedAbilityFor(FORGOTTEN_SIGNPOST), "the Signpost lost its registration").toBeDefined();
  });

  it("MEASURED, AND STILL TRUE: an ability's move fan-out offers battlefields and NEVER a base", () => {
    // Yasuo - Unforgiven's `fromBase` mode is the pool's only `movesTarget`
    // ability, so it is the whole of what an activated move-to-a-CHOSEN-place can
    // express — and it still cannot say "base".
    //
    // **This measurement was right and its conclusion was wrong**, which is worth
    // keeping both halves of. It was written as the third, blocking gap on the
    // Signpost: "the location of the unit you exhausted" includes a BASE (198.1),
    // `ActivateAbilityAction` has no `destinationIsBase`, so the card would be
    // silently narrower than printed even given a cost seam.
    //
    // The card landed without widening the action at all, because its destination
    // is not CHOSEN — it is wherever the cost payer stands, so the resolver reads
    // a location instead of the action carrying one, exactly as SFD-050 Azir's
    // swap already did. `forgotten-signpost.test.ts` pins the base case working.
    //
    // So this stays as a measurement of `movesTarget`, which is a real limit for
    // the next card that needs a chosen base — just not the one it was filed as.
    const s = makeState({ phase: "Action" });
    s.players[0]!.legend = { ...s.players[0]!.legend, defId: YASUO_UNFORGIVEN, name: "Yasuo - Unforgiven" };
    s.players[0]!.channeled = runes("Fury", 6);
    s.players[0]!.baseUnits = [makeUnit({ name: "Wanderer", instanceId: "wanderer" })];

    const moves = legalActions(s).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.modeId === "fromBase",
    );
    expect(moves.length, "Yasuo's move mode was not offered — the control is dead, not the claim").toBeGreaterThan(0);
    expect(moves.every((m) => m.destinationBattlefieldId !== undefined)).toBe(true);
    expect(moves.some((m) => (m as { destinationIsBase?: true }).destinationIsBase === true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNL-190 Lilting Lullaby — the counter is written; "its controller can't play
// spells this turn" is not.
// ---------------------------------------------------------------------------
describe("UNL-190 Lilting Lullaby: the only lockout that exists is wider than printed", () => {
  function lockableState(): GameState {
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [realUnitInstance(MONCH), spellInstance(CHARM)];
    s.players[0]!.channeled = runes("Calm", 10);
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Charmable", instanceId: "enemy-a" })] };
    return s;
  }

  it("MEASURED: `cannotPlayCardsThisTurn` stops UNITS as well as spells", () => {
    const open = lockableState();
    const openPlays = legalActions(open).filter((a) => a.type === "PlayCard");
    const units = openPlays.filter((a) => (a as PlayCardAction).card.kind === "Unit");
    const spells = openPlays.filter((a) => (a as PlayCardAction).card.kind === "Spell");
    // The control: both kinds really are playable before the flag is set, so a
    // zero afterwards means the flag did it.
    expect(units.length, "no unit play was available to be suppressed").toBeGreaterThan(0);
    expect(spells.length, "no spell play was available to be suppressed").toBeGreaterThan(0);

    const locked = lockableState();
    locked.players[0]!.cannotPlayCardsThisTurn = true;
    const lockedPlays = legalActions(locked).filter((a) => a.type === "PlayCard");
    // Reusing this field for the Lullaby would take the unit plays with it —
    // which is why the card is refused rather than approximated.
    expect(lockedPlays).toHaveLength(0);
  });

  it("THE PIN: the counter half is registered, so coverage reports a HALF card as done", () => {
    // This is why UNL-190 needs its `coverage.PARTIALLY_IMPLEMENTED` row to
    // survive: registration is per defId and the counter alone satisfies it.
    expect(hasEffect(LILTING_LULLABY), "the Lullaby lost its resolver").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-193 Vex - Gloomist / UNL-195 Ivern - Green Father — both Legends.
// ---------------------------------------------------------------------------
describe("UNL-193 Vex - Gloomist: the clone claim, checked through the real hold path", () => {
  /** A board where `legendDefId` is the player's Legend, then a real
   *  `battlefieldHeld` event driven to the point where a decision would be
   *  parked — the same shape `renata-chem-baroness.test.ts` uses. */
  function heldWith(legendDefId: string): GameState {
    const s = makeState({ phase: "Action" });
    s.players[0]!.legend = { ...s.players[0]!.legend, defId: legendDefId };
    let current = runCleanup(holdEventTrigger(s, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }));
    for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
      if (pendingDecision(current)) break;
      const pass = legalActions(current).find((a) => a.type === "PassFocus");
      if (!pass) break;
      current = submit(current, pass).state;
    }
    return current;
  }

  it("POSITIVE CONTROL: Renata Chem-Baroness's hold clause fires and parks a question", () => {
    // "When you or an ally hold, you may exhaust me to ..." — the same first
    // sentence Vex prints. Only the payload differs (a Gold token vs draw 1),
    // which is the whole of the clone claim.
    expect(pendingDecision(heldWith(RENATA_CHEM_BARONESS))?.kind).toBe("SFD-201-gold");
  });

  it("THE PIN: the same hold with Vex as Legend parks nothing", () => {
    // **INVERTED 2026-08-13.** This pin proved the clone claim BEHAVIOURALLY —
    // Renata's hold parked a question and Vex's parked nothing — which is what
    // made her two rows rather than an investigation.
    expect(pendingDecision(heldWith(VEX_GLOOMIST))?.kind, "Vex stopped asking on a hold").toBe("UNL-193-draw");
    expect(legendAbilityDefIds()).toContain(RENATA_CHEM_BARONESS);
    expect(legendAbilityDefIds()).toContain(VEX_GLOOMIST);
    // The hook Vex needs already exists and is already dispatched; nothing new
    // is required of triggers.ts or scoring.ts.
    expect(legendTriggerKeysInUse()).toContain("onBattlefieldHeld");
  });
});

describe("UNL-195 Ivern - Green Father: the systemic refusal, checked", () => {
  it("MEASURED: the only Brush in the pool is Ivern's own three printings", () => {
    const all = registry.all();
    // Guards `tried > 0` — an empty registry would also produce an empty match.
    expect(all.length).toBeGreaterThan(600);
    const brush = all.filter((c) => /brush/i.test(c.name) || /brush/i.test(c.text));
    // **Wave 7 said "NO Brush card exists in the pool at all", and that is not
    // literally what the data says** — the word appears three times, all of them
    // Ivern telling you to make one. The substance survives the correction and
    // is sharper for it: nothing PRINTS a Brush, so the token has no source.
    expect(brush.map((c) => c.id).sort()).toEqual(["UNL-195", "UNL-233", "UNL-233*"]);
    // The control for the same filter: "Poro" is one of the tags his Brush
    // would buff, and the pool really does print it.
    expect(all.filter((c) => /poro/i.test(c.name)).length).toBeGreaterThan(0);
  });

  it("MEASURED: no BATTLEFIELD and no printed TOKEN named Brush exists to be swapped in", () => {
    const battlefields = loadBattlefieldDefinitions();
    expect(battlefields.length, "no battlefields loaded — the control is dead").toBeGreaterThan(0);
    expect(battlefields.filter((b) => /brush/i.test(b.name)).map((b) => b.id)).toEqual([]);

    // The other place it could have been hiding: printed Token-supertype cards,
    // which `loadTokenDefinitions` reads out of the same JSON and which is where
    // Gold // Buff lives.
    const tokens = loadTokenDefinitions();
    expect(tokens.length, "no tokens loaded — the control is dead").toBeGreaterThan(0);
    expect(tokens.filter((t) => /brush/i.test(t.name)).map((t) => t.id)).toEqual([]);

    expect(legendAbilityDefIds()).not.toContain(IVERN_GREEN_FATHER);
  });
});
