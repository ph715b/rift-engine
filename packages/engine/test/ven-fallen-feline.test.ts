import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { loadCardDefinitions } from "../src/cards/card-loader.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { timingRejection, mayPlayCardNow } from "../src/engine/timing.js";
import { mayPlaySpellNamed } from "../src/engine/board-restrictions.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { playCardIgnoringCost } from "../src/engine/play-free.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  spellInstance,
} from "./fixtures.js";

/**
 * **Fallen Feline (VEN-132) — "When you play me, name a spell. While I'm at a
 * battlefield, opponents can't play spells with that name."**
 *
 * Her own file because she is her own commit, and because the two sentences are
 * two mechanisms with almost nothing in common: a DECISION that offers every
 * spell in the pool, and a CONTINUOUS ban read at the play gate.
 *
 * # What these tests are actually guarding
 *
 * The naming half is the widest decision in the engine — 233 options, where the
 * next widest is a dozen — so its assertions are about the SHAPE of the offer
 * (every spell, no units, no tokens, distinct, stable) rather than about any
 * particular member of it. A test naming one spell would pass on a list of one.
 *
 * The ban half is a gate, and gates in this codebase fail in one characteristic
 * way: the enumerator and the validator disagree, and the game offers an action
 * it then refuses. Every ban assertion here is therefore made TWICE, once
 * through `legalActions` and once through `submit`. That is the class this
 * session has now produced six instances of.
 *
 * The positional half ("while I'm AT A BATTLEFIELD") is the third axis, and it
 * is the one a fixture can silently get wrong: a Feline in base must ban
 * nothing, and killing her must lift the ban with nothing swept.
 */

const FALLEN_FELINE = "VEN-132";
/** [Action], 1 Energy, no Power — the ordinary spell the ban is tested against. */
const CLEAVE = "OGN-004";
const CLEAVE_NAME = "Cleave";
/** [Reaction], 1 Energy — the same test one tier up, because a ban that a
 *  [Reaction] walks past is the failure mode the gate's placement exists to
 *  prevent. */
const EN_GARDE = "OGN-046";
const EN_GARDE_NAME = "En Garde";

const registry = defaultCardRegistry();

/** Enough Ready runes of every domain that no play in this file is ever refused
 *  for a reason other than the one under test. */
const richRunes = (): RuneCard[] =>
  ["Fury", "Calm", "Mind", "Body", "Order", "Chaos"].flatMap((domain, d) =>
    Array.from({ length: 3 }, (_, i) => ({ id: `r${d}-${i}`, domain, state: "Ready" }) as RuneCard),
  );

/**
 * p2 holds Cleave and En Garde and can afford both; p1 gets a Feline seat.
 *
 * p2 is the ACTING player, deliberately — the ban belongs to p1's Feline, so the
 * player being stopped has to be the one whose turn it is. A fixture that left
 * p1 acting would find every p2 play refused for priority and prove nothing.
 */
function board(): { state: GameState; feline: UnitInstance } {
  const state = makeState({ activePlayerIndex: 1, focusHolder: 1 });
  const feline = realUnitInstance(FALLEN_FELINE);
  state.players[1]!.hand = [spellInstance(CLEAVE), spellInstance(EN_GARDE)];
  state.players[1]!.channeled = richRunes();
  // p2 gets a unit at the OTHER battlefield, and it is load-bearing rather than
  // scenery: both spells here target ("give a unit [Assault 3]", "give a FRIENDLY
  // unit +1"), and `legal-actions` does not offer a spell with no legal target.
  // Without it every ban assertion would pass against a board where the spell was
  // unplayable for a reason that has nothing to do with the Feline — which is the
  // fixture failure this file's own first run produced.
  state.battlefields[1]!.units = { p2: [makeUnit({ name: "Target Dummy" })] };
  return { state, feline };
}

/** The same board with every naming stripped — the control state, used to build
 *  the action the enumerator WOULD offer if no Feline had named. */
function withoutNaming(state: GameState): GameState {
  const strip = (u: UnitInstance): UnitInstance => {
    const { namedSpell: _dropped, ...rest } = u;
    return rest as UnitInstance;
  };
  return {
    ...state,
    players: state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(strip) })) as GameState["players"],
    battlefields: state.battlefields.map((bf) => ({
      ...bf,
      units: Object.fromEntries(Object.entries(bf.units).map(([id, units]) => [id, units.map(strip)])),
    })),
  };
}

/** Seats the Feline at bf1 for p1 and names `spellName` — the state every ban
 *  test starts from. Written through the real decision, never by poking the
 *  field, so a naming that stopped writing would fail here first. */
function named(state: GameState, feline: UnitInstance, spellName: string, battlefieldId = "bf1"): GameState {
  const seated = { ...state };
  const bf = seated.battlefields.find((b) => b.id === battlefieldId)!;
  bf.units = { ...bf.units, p1: [...(bf.units.p1 ?? []), feline] };
  const asked = playUnitTrigger(seated, feline, 0, { battlefieldId }, {});
  return answerDecisions(asked, (options) => options.find((o) => o.id === spellName)!.id);
}

const felineOnBoard = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.battlefields.flatMap((b) => Object.values(b.units).flat()),
    ...state.players.flatMap((p) => p.baseUnits),
  ].find((u) => u.instanceId === instanceId);

const canPlay = (state: GameState, defId: string): boolean =>
  legalActions(state).some((a) => a.type === "PlayCard" && a.card.defId === defId);

/**
 * Submits the exact action the enumerator offers on the SAME board with no
 * naming on it — the VALIDATOR direction, which a `legalActions` assertion
 * cannot reach on its own.
 *
 * Built from the control state rather than by hand, so the payment, the targets
 * and the action's shape are whatever the engine itself would have produced;
 * only the ban differs between the two states. Hand-building the action is how a
 * test ends up refusing a play for a malformed payment and calling it a ban.
 *
 * Throws when the control state cannot play it either, because that fixture
 * measures nothing at all.
 */
function forcePlay(state: GameState, defId: string) {
  const offered = legalActions(withoutNaming(state)).find((a) => a.type === "PlayCard" && a.card.defId === defId);
  if (!offered) throw new Error(`forcePlay: ${defId} is unplayable even unbanned — this fixture measures nothing`);
  return submit(state, offered);
}

describe("Fallen Feline (VEN-132) — naming", () => {
  it("counts as implemented", () => {
    expect(isCardImplemented(registry.get(FALLEN_FELINE))).toBe(true);
  });

  it("asks on play, and the question is HERS", () => {
    const { state, feline } = board();
    const asked = playUnitTrigger(state, feline, 0, { battlefieldId: "bf1" }, {});
    const question = pendingDecision(asked);

    expect(question?.kind, "she did not ask").toBe("VEN-132-name");
    // Against her instanceId, which is what the answer is written onto — a
    // question parked against nothing resolves to a silent no-op.
    expect(question?.cardInstanceId).toBe(feline.instanceId);
    expect(question?.playerIndex).toBe(0);
  });

  it("offers EVERY spell in the pool and nothing else", () => {
    // The shape of the offer, not a member of it. 762 bounds a naming to a card
    // legal in the format; nothing narrows it to a zone, a deck or a domain, so
    // the assertion is an EQUALITY against the registry rather than a floor.
    const { state, feline } = board();
    const asked = playUnitTrigger(state, feline, 0, { battlefieldId: "bf1" }, {});
    const offered = optionsFor(asked, pendingDecision(asked)!).map((o) => o.id);

    const everySpellName = [...new Set(loadCardDefinitions().filter((d) => d.type === "Spell").map((d) => d.name))];
    expect(new Set(offered), "the offer is not exactly the pool's spells").toEqual(new Set(everySpellName));

    // ...and no UNIT, gear, rune or battlefield leaked in. Stated separately
    // because the equality above would still hold if `type === "Spell"` were
    // dropped from BOTH sides at once.
    const nonSpellNames = new Set(loadCardDefinitions().filter((d) => d.type !== "Spell").map((d) => d.name));
    expect(offered.filter((name) => nonSpellNames.has(name)), "a non-spell was offered").toEqual([]);
  });

  it("offers DISTINCT names, sorted, and labels them", () => {
    // 132.1 — a name identifies a card uniquely, so two printings that share one
    // are one option. Sorted so a human can find anything in 233 rows.
    const { state, feline } = board();
    const asked = playUnitTrigger(state, feline, 0, { battlefieldId: "bf1" }, {});
    const options = optionsFor(asked, pendingDecision(asked)!);
    const offered = options.map((o) => o.id);

    expect(offered.length, "a name was offered twice").toBe(new Set(offered).size);
    expect(offered, "the offer is not sorted").toEqual([...offered].sort());
    expect(options.every((o) => o.label === o.id), "an option's button does not say its name").toBe(true);
  });

  it("writes the answer onto HER", () => {
    const { state, feline } = board();
    const after = named(state, feline, CLEAVE_NAME);

    expect(felineOnBoard(after, feline.instanceId)?.namedSpell).toBe(CLEAVE_NAME);
  });

  it("records nothing when she died before the answer landed", () => {
    // 359.3.e.12 — her on-play trigger can be responded to, and the naming then
    // has nobody to write against. The engine must not invent a ban with no
    // Feline behind it.
    const { state, feline } = board();
    const bf = state.battlefields[0]!;
    bf.units = { p1: [feline] };
    const asked = playUnitTrigger(state, feline, 0, { battlefieldId: "bf1" }, {});
    const killed = destroyUnit(asked, feline.instanceId, 1);
    const answered = answerDecisions(killed, (options) => options.find((o) => o.id === CLEAVE_NAME)!.id);

    expect(felineOnBoard(answered, feline.instanceId), "she is still on the board").toBeUndefined();
    expect(mayPlaySpellNamed(answered, 1, CLEAVE_NAME), "a dead Feline banned a spell").toBe(true);
  });
});

describe("Fallen Feline (VEN-132) — the ban", () => {
  it("stops the named spell, in BOTH directions", () => {
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);

    expect(canPlay(banned, CLEAVE), "the enumerator offered a banned spell").toBe(false);
    const { result } = forcePlay(banned, CLEAVE);
    expect(result, "the validator accepted a banned spell").not.toMatchObject({ type: "Ok" });
  });

  it("leaves every OTHER spell alone", () => {
    // The control that separates "she banned this name" from "she banned spells".
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);

    expect(canPlay(banned, EN_GARDE), "an unnamed spell was banned").toBe(true);
    expect(forcePlay(banned, EN_GARDE).result).toMatchObject({ type: "Ok" });
  });

  it("stops a [Reaction] too", () => {
    // The gate sits BEFORE the tier switch. A ban a [Reaction] walks past would
    // be the whole card's failure mode, and it is the one a test placed only on
    // an [Action] spell cannot see.
    const { state, feline } = board();
    const banned = named(state, feline, EN_GARDE_NAME);

    expect(canPlay(banned, EN_GARDE), "a [Reaction] walked past the ban").toBe(false);
    expect(forcePlay(banned, EN_GARDE).result).not.toMatchObject({ type: "Ok" });
  });

  it("says WHY, rather than complaining about timing", () => {
    // The rejection message is what a human sees. Falling through to the tier
    // text would name [Action]/[Reaction] at a card that has them.
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);
    const card = banned.players[1]!.hand.find((c) => c.defId === CLEAVE)!;

    expect(timingRejection(banned, 1, card)).toContain("Fallen Feline");
  });

  it("binds OPPONENTS only — her own controller still plays it", () => {
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);

    expect(mayPlaySpellNamed(banned, 0, CLEAVE_NAME), "she banned her own controller").toBe(true);
    expect(mayPlaySpellNamed(banned, 1, CLEAVE_NAME), "she did not ban her opponent").toBe(false);
  });

  it("bans EVERY copy, by name", () => {
    // 132.1. The ban is keyed to the name, so a second Cleave in hand is as
    // stopped as the first — the reading that makes naming worth doing.
    const { state, feline } = board();
    const withSecond = { ...state };
    withSecond.players[1]!.hand = [...withSecond.players[1]!.hand, spellInstance(CLEAVE)];
    const banned = named(withSecond, feline, CLEAVE_NAME);

    const offered = legalActions(banned).filter((a) => a.type === "PlayCard" && a.card.defId === CLEAVE);
    expect(offered, "one copy of a banned spell was still offered").toEqual([]);
  });
});

describe("Fallen Feline (VEN-132) — while I'm AT A BATTLEFIELD", () => {
  it("bans nothing from BASE", () => {
    const { state, feline } = board();
    const inBase = { ...state };
    inBase.players[0]!.baseUnits = [feline];
    const asked = playUnitTrigger(inBase, feline, 0, "base", {});
    const answered = answerDecisions(asked, (options) => options.find((o) => o.id === CLEAVE_NAME)!.id);

    // She DID name — the question is hers wherever she lands.
    expect(felineOnBoard(answered, feline.instanceId)?.namedSpell).toBe(CLEAVE_NAME);
    // ...and the ban is positional, so it is not in force.
    expect(canPlay(answered, CLEAVE), "a Feline in base banned a spell").toBe(true);
  });

  it("bans nothing once she is killed", () => {
    // Continuous, not a fact about the turn: unlike Brynhir's and Lilting
    // Lullaby's bans, killing her must lift this IMMEDIATELY, and nothing has to
    // be swept for that to happen.
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);
    expect(canPlay(banned, CLEAVE), "the ban was never in force — this measures nothing").toBe(false);

    const lifted = destroyUnit(banned, feline.instanceId, 1);
    expect(canPlay(lifted, CLEAVE), "a dead Feline was still banning").toBe(true);
  });

  it("survives the end of the turn", () => {
    // The other half of the same claim: nothing about the naming expires, so a
    // sweep that cleared it would be as wrong as one that never lifted it.
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);
    const nextTurn = runEnd({ ...banned, activePlayerIndex: 0, focusHolder: 0 });

    expect(felineOnBoard(nextTurn, feline.instanceId)?.namedSpell, "the name was swept").toBe(CLEAVE_NAME);
  });

  it("two Felines name INDEPENDENTLY, and both bans hold", () => {
    // The reason the name lives on the instance rather than on the player.
    const { state, feline } = board();
    const first = named(state, feline, CLEAVE_NAME);
    const second = realUnitInstance(FALLEN_FELINE);
    const both = named(first, second, EN_GARDE_NAME, "bf2");

    expect(felineOnBoard(both, feline.instanceId)?.namedSpell, "the second naming overwrote the first").toBe(
      CLEAVE_NAME,
    );
    expect(felineOnBoard(both, second.instanceId)?.namedSpell).toBe(EN_GARDE_NAME);
    expect(canPlay(both, CLEAVE)).toBe(false);
    expect(canPlay(both, EN_GARDE)).toBe(false);
  });

  it("bans a FREE play too", () => {
    // A card played by an effect is still PLAYED, so the seven "play it ignoring
    // its cost" sites are not a way around the one ban in the pool that names a
    // specific card. Asked in `playCardIgnoringCost` itself rather than at each
    // caller, for the reason that module exists.
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);
    const cleave = spellInstance(CLEAVE);

    const attempted = playCardIgnoringCost(banned, 1, cleave);
    expect(attempted.players[1]!.trash.map((c) => c.defId), "a banned spell resolved and was trashed").not.toContain(
      CLEAVE,
    );

    // The CONTROL on the same call: unbanned, it goes through. Without this the
    // assertion above would pass on a `playCardIgnoringCost` that never worked.
    const freely = playCardIgnoringCost(withoutNaming(banned), 1, cleave);
    expect(freely.players[1]!.trash.map((c) => c.defId), "the control free play did nothing either").toContain(CLEAVE);
  });

  it("leaves HER controller's free play alone", () => {
    // "Opponents", again — the free-play gate reads the same predicate, so it
    // inherits the same side.
    const { state, feline } = board();
    const banned = named(state, feline, CLEAVE_NAME);

    const mine = playCardIgnoringCost(banned, 0, spellInstance(CLEAVE));
    expect(mine.players[0]!.trash.map((c) => c.defId)).toContain(CLEAVE);
  });

  it("bans nothing before she has answered", () => {
    // `namedSpell` absent is a real state, not just other units' default: her
    // question can sit parked behind another, and a Feline who has not named
    // must not ban a spell she has not chosen.
    const { state, feline } = board();
    const bf = state.battlefields[0]!;
    bf.units = { p1: [feline] };

    expect(felineOnBoard(state, feline.instanceId)?.namedSpell).toBeUndefined();
    expect(mayPlaySpellNamed(state, 1, CLEAVE_NAME), "an unnamed Feline banned a spell").toBe(true);
    expect(mayPlayCardNow(state, 1, state.players[1]!.hand[0]!), "an unnamed Feline stopped a play").toBe(true);
  });
});
