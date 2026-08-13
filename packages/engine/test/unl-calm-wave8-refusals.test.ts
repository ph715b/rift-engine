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
describe("UNL-054 Tricksy Tentacles: what the destination axis actually needs", () => {
  function tentacleState(): { state: GameState; spellId: string } {
    const spell = spellInstance(TRICKSY_TENTACLES);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Calm", 8);
    // Two enemy units at bf1, total Might 6 — a legal group for the printed
    // "total Might of 8 or less".
    s.battlefields[0]!.units = {
      p2: [makeUnit({ name: "Tentacled A", instanceId: "enemy-a", might: 3 }), makeUnit({ name: "Tentacled B", instanceId: "enemy-b", might: 3 })],
    };
    return { state: s, spellId: spell.instanceId };
  }

  it("is unregistered, so nothing in the pool moves anything for it (the pin)", () => {
    // The control that keeps `hasEffect` honest: Charm is registered, so a
    // `false` below is a fact about UNL-054 and not about the lookup.
    expect(hasEffect(CHARM)).toBe(true);
    expect(hasEffect(TRICKSY_TENTACLES), "UNL-054 gained a resolver — retire this pin").toBe(false);
    expect(cardMovesTarget(TRICKSY_TENTACLES), "UNL-054 gained its MOVE_TARGET_SPELL_DEF_IDS row").toBe(false);
    expect(cardMayMoveToBase(TRICKSY_TENTACLES)).toBe(false);
  });

  it("POSITIVE CONTROL: Charm, one row over in the same Set, IS offered a destination", () => {
    // Proves the fixture and the enumerator are alive: the same board that
    // offers Tentacles nothing offers Charm a battlefield and a base.
    const spell = spellInstance(CHARM);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Calm", 8);
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Charmed", instanceId: "enemy-a", might: 3 })] };

    const plays = playsOf(s, spell.instanceId);
    expect(plays.length, "Charm was not enumerated at all — the fixture is broken, not the card").toBeGreaterThan(0);
    expect(plays.every((p) => p.destinationBattlefieldId !== undefined || p.destinationIsBase === true)).toBe(true);
    expect(plays.some((p) => p.destinationIsBase === true), "Charm's base destination (355.4.a/198.1) was not offered").toBe(true);

    // ...and it is ACCEPTED through the real submit path. This is the
    // differential that makes the refusal below mean something: the same
    // validator, on the same board, with a destination — only the defId differs,
    // and only because of the `MOVE_TARGET_SPELL_DEF_IDS` row.
    const { result } = submit(s, plays.find((p) => p.destinationBattlefieldId === "bf2")!);
    expect(result).toMatchObject({ type: "Ok" });
  });

  it("the validator REFUSES a hand-built Tentacles play carrying a destination (the pin)", () => {
    const { state, spellId } = tentacleState();
    const card = state.players[0]!.hand.find((c) => c.instanceId === spellId)!;
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card,
      payment: { energyRunes: ["Calm-0", "Calm-1", "Calm-2", "Calm-3"], powerRunes: ["Calm-4"], rainbowRunes: [] },
      targetUnitInstanceIds: ["enemy-a", "enemy-b"],
      destinationBattlefieldId: "bf1",
    };
    const { result } = submit(state, action);
    // The exact message is asserted so that a change in WHY it is refused shows
    // up as a test failure rather than as a still-green refusal.
    expect(result).toMatchObject({ type: "Invalid" });
    expect(JSON.stringify(result)).toContain("cannot be played directly to a battlefield");
  });

  it("MEASURED: both `withDestinations` filters already pass an undefined single target", () => {
    // These two are the ONLY filters `withDestinations` applies after fanning
    // out the battlefields (legal-actions.ts). A `unitList` play carries
    // `targetUnitInstanceIds` and no `targetUnitInstanceId`, so this is the
    // exact call it would make — and both say yes.
    //
    // This is the finding that shrinks wave 7's three shared edits to one for
    // the battlefield axis: no `withDestinations` change is needed at all.
    const { state } = tentacleState();
    expect(
      secondTargetIsAtDestination(state, { kind: "unitList" }, { destinationBattlefieldId: "bf1" }),
      "secondTargetIsAtDestination stopped tolerating a list-targeted move",
    ).toBe(true);
    expect(
      moveDestinationAllowed(state, TRICKSY_TENTACLES, undefined, "bf1"),
      "moveDestinationAllowed stopped tolerating a list-targeted move",
    ).toBe(true);
    // ...and that `true` is not this function's constant answer. Temptation
    // (SFD-129) is the one card with a restricted destination, and it says NO to
    // the same undefined target — so the yes above is about UNL-054 rather than
    // about an unreached predicate.
    expect(moveDestinationAllowed(state, "SFD-129", undefined, "bf1")).toBe(false);
  });

  it("the BASE axis is a separate, still-open question", () => {
    // What is MEASURED here is only Set membership: base is offered exclusively
    // for a card in MOVE_TO_BASE_DEF_IDS, and UNL-054 is not one.
    //
    // The reason a row there would NOT be enough is READ from legal-actions.ts
    // rather than measured, and is reported as read: `toBase` in
    // `withDestinations` is gated on `currentBattlefieldIndex !== undefined`,
    // derived from the SINGLE `targetUnitInstanceId`, which a `unitList` play
    // never carries. Nothing in the pool exercises that path today (Skyward
    // Strike is `min: 1`, so its first slot is always filled), so there is no
    // card to measure it with.
    expect(cardMayMoveToBase(CHARM), "Charm is the control for the base axis").toBe(true);
    expect(cardMayMoveToBase(TRICKSY_TENTACLES)).toBe(false);
  });
});

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
    expect(landed!.exhausted, "Shadow now enters ready — close the divergence row and retire this pin").toBe(true);
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
describe("UNL-035 Monch: neither clause is reachable", () => {
  function monchState(): GameState {
    const s = makeState({ phase: "Action" });
    // The condition the card names, satisfied as hard as it can be.
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Stunned enemy", instanceId: "stunned", stunned: true })] };
    return s;
  }

  it("THE PIN: the discount never applies", () => {
    const s = monchState();
    // `CardDefinition` is a union and the cost lives on the Unit arm — the narrow
    // is load-bearing, and vitest does not typecheck, so this only surfaced at the
    // integrator's `npm run typecheck` exactly as this agent predicted.
    const monchDef = registry.get(MONCH);
    if (monchDef.type !== "Unit") throw new Error("Monch is not a Unit definition");
    const printed = monchDef.energyCost;
    expect(printed).toBe(6);
    expect(modifiedEnergyCost(s, 0, "Unit", printed, MONCH), "Monch gained a cost-modifiers row").toBe(6);
  });

  it("POSITIVE CONTROL: a card that IS in the table moves under the same call", () => {
    // Spoils of War — "costs [2] less if an enemy unit has died this turn".
    // Same function, same state, a different defId: proves `modifiedEnergyCost`
    // is live here and the 6 above is a missing row, not a dead call.
    const s = monchState();
    const spoilsDef = registry.get(SPOILS_OF_WAR);
    if (spoilsDef.type !== "Spell") throw new Error("Spoils of War is not a Spell definition");
    const printed = spoilsDef.energyCost;
    const before = modifiedEnergyCost(s, 0, "Spell", printed, SPOILS_OF_WAR);
    s.players[1]!.unitsLostThisTurn = 1;
    const after = modifiedEnergyCost(s, 0, "Spell", printed, SPOILS_OF_WAR);
    expect(after, "the control card's cost did not move — this whole comparison is vacuous").toBeLessThan(before);
  });

  /** Plays Monch to base and returns him as he landed. */
  function playMonch(s: GameState) {
    const monch = realUnitInstance(MONCH);
    s.players[0]!.hand = [monch];
    s.players[0]!.channeled = runes("Calm", 10);
    const play = playsOf(s, monch.instanceId).find((p) => p.destinationBattlefieldId === undefined);
    expect(play, "no base play of Monch was enumerated").toBeDefined();
    const { state: next, result } = submit(s, play!);
    expect(result).toMatchObject({ type: "Ok" });
    return next.players[0]!.baseUnits.find((u) => u.defId === MONCH)!;
  }

  it("THE PIN: he also enters exhausted beside a stunned enemy", () => {
    expect(playMonch(monchState()).exhausted, "Monch now enters ready — retire this pin").toBe(true);
  });

  it("POSITIVE CONTROL: the same play produces a READY Monch when the board says so", () => {
    // Without this the pin above is vacuous: 143.4.a's default IS exhausted, so
    // `true` proves nothing until the same fixture is shown producing `false`.
    const s = monchState();
    s.players[0]!.unitsEnterReadyThisTurn = true;
    expect(playMonch(s).exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNL-037 Shadow Watcher — "If a friendly unit died during your Beginning Phase
// this turn, I enter ready."
// ---------------------------------------------------------------------------
describe("UNL-037 Shadow Watcher: nothing in the engine distinguishes WHEN a unit died", () => {
  /** The whole player record after `deaths` friendly deaths in `phase`. */
  function afterDeathIn(phase: GameState["phase"], deaths = 1): string {
    const s = makeState({ phase });
    s.players[0]!.baseUnits = Array.from({ length: deaths }, (_, i) => makeUnit({ name: `Doomed ${i}`, instanceId: `doomed-${i}` }));
    let next = s;
    for (let i = 0; i < deaths; i += 1) next = destroyUnit(next, `doomed-${i}`, 1);
    return JSON.stringify(next.players[0]);
  }

  it("MEASURED: a Beginning-Phase death and an Action-Phase death leave IDENTICAL player state", () => {
    const beginning = afterDeathIn("Beginning");
    const action = afterDeathIn("Action");
    // If any field anywhere on PlayerState recorded the phase, these two strings
    // would differ. They do not — which is the entire reason the card cannot be
    // written against existing state, and is a stronger statement than "I looked
    // and did not find a field".
    expect(beginning).toEqual(action);
    // ...and the comparison is SENSITIVE. Two identical strings would also come
    // out of a stringify that dropped everything interesting, so a change the
    // record DOES carry has to separate them.
    expect(afterDeathIn("Action", 2)).not.toEqual(action);
  });

  it("POSITIVE CONTROL: the death funnel really did run in both", () => {
    // Guards `tried > 0`: two identical strings would also be produced by a
    // `destroyUnit` that did nothing at all.
    const s = makeState({ phase: "Beginning" });
    s.players[0]!.baseUnits = [makeUnit({ name: "Doomed", instanceId: "doomed" })];
    const next = destroyUnit(s, "doomed", 1);
    expect(next.players[0]!.unitsLostThisTurn).toBe(1);
    expect(next.players[0]!.baseUnits).toHaveLength(0);
  });

  it("THE PIN: he is unregistered", () => {
    expect(hasEffect(SHADOW_WATCHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNL-045 Forgotten Signpost — "[Action][>] Exhaust a unit you control,
// [Exhaust]: Move a different unit you control to the location of the unit you
// exhausted to pay for this ability."
// ---------------------------------------------------------------------------
describe("UNL-045 Forgotten Signpost: the cost seam, measured", () => {
  it("THE PIN: no activated ability is registered for it", () => {
    // Shadow's stun IS registered, through the same lookup — so the undefined
    // below is the Signpost's, not a broken accessor.
    expect(activatedAbilityFor(SHADOW)).toBeDefined();
    expect(activatedAbilityFor(FORGOTTEN_SIGNPOST)).toBeUndefined();
  });

  it("MEASURED: an ability's move fan-out offers battlefields and NEVER a base", () => {
    // Yasuo - Unforgiven's `fromBase` mode is the pool's only `movesTarget`
    // ability, so it is the whole of what an activated move can express today.
    //
    // This is the gap wave 7 did not name: the Signpost's "the location of the
    // unit you exhausted" includes a BASE (198.1), and `ActivateAbilityAction`
    // has no `destinationIsBase` field at all — so the card would be silently
    // narrower than printed even with a cost seam.
    const s = makeState({ phase: "Action" });
    s.players[0]!.legend = { ...s.players[0]!.legend, defId: YASUO_UNFORGIVEN, name: "Yasuo - Unforgiven" };
    s.players[0]!.channeled = runes("Fury", 6);
    s.players[0]!.baseUnits = [makeUnit({ name: "Wanderer", instanceId: "wanderer" })];

    const moves = legalActions(s).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.modeId === "fromBase",
    );
    expect(moves.length, "Yasuo's move mode was not offered — the control is dead, not the claim").toBeGreaterThan(0);
    expect(moves.every((m) => m.destinationBattlefieldId !== undefined)).toBe(true);
    // The action type has no base field, so this can only ever be undefined —
    // asserted anyway, because a widening of the action is exactly the change
    // that should make this file fail.
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
    expect(pendingDecision(heldWith(VEX_GLOOMIST)), "UNL-193 gained an ability — retire this pin").toBeUndefined();
    expect(legendAbilityDefIds()).toContain(RENATA_CHEM_BARONESS);
    expect(legendAbilityDefIds()).not.toContain(VEX_GLOOMIST);
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
