import { describe, expect, it } from "vitest";
import { describeChain } from "../src/engine/chain-description.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/** Real spell defIds, so a description can't accidentally depend on a
 *  synthetic card shape the real pool doesn't have. */
const FIRESTORM = "OGS-002"; // battlefield-kind target
const INCINERATE = "OGS-003"; // unit-kind target
const DUEL = "OGS-008"; // unitPair
const RECRUIT = "OGS-015"; // places tokens (destination)
const MEDITATION = "OGN-048"; // optional exhaust cost
const MORBID_RETURN = "OGN-170"; // ownTrashCard

describe("describeChain", () => {
  it("is empty for an empty chain", () => {
    expect(describeChain(makeState())).toEqual([]);
  });

  it("gives a triggered ability a real row, named by its source", () => {
    // Triggers used to be SKIPPED here, which was survivable only while nothing
    // could push one. Now that the Cleanup finalizes them onto the chain, skipping
    // would render a CLOSED chain as an EMPTY viewer while the board demands a
    // Pass Focus — the player asked to pass at something they cannot see.
    const state = makeState({
      chainOpen: false,
      spellChain: [
        {
          kind: "trigger",
          playerIndex: 1,
          listenerInstanceId: "gear-1",
          listenerDefId: "OGN-152",
          listenerName: "Mistfall",
          event: { kind: "unitBuffed", ownerIndex: 1, unitInstanceId: "u-1" },
        },
      ],
    });

    const items = describeChain(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("trigger");
    expect(items[0]!.cardName).toBe("Mistfall"); // the carried name, not a board lookup
    expect(items[0]!.playerIndex).toBe(1);
    expect(items[0]!.depthFromTop).toBe(0);
    // Pushed already-finalized, so nothing was ever targeted — see the Pending vs.
    // Finalized row in docs/rules-conformance.md.
    expect(items[0]!.targets).toEqual([]);
  });

  it("keys Spell and trigger rows distinctly, so a mixed chain cannot collide", () => {
    // The UI keys its list on `key`. A trigger has no card instance to borrow one
    // from, and two of one permanent's triggers can wait at once — a duplicate key
    // is a React remount and, with Framer Motion, a duplicate-layoutId warning.
    const trigger = {
      kind: "trigger" as const,
      playerIndex: 0 as const,
      listenerInstanceId: "gear-1",
      listenerDefId: "OGN-152",
      listenerName: "Mistfall",
      event: { kind: "unitBuffed", ownerIndex: 0, unitInstanceId: "u-1" },
    };
    const state = makeState({
      chainOpen: false,
      spellChain: [{ playerIndex: 0, card: spellInstance(FIRESTORM) }, trigger, { ...trigger }],
    });

    const keys = describeChain(state).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders NEWEST FIRST — depthFromTop 0 is the last-pushed entry (rule 340.1)", () => {
    // White-box: a chain deeper than one entry is unreachable through any
    // public action until reaction-speed casting lands (nothing can be cast
    // onto an already-closed chain), so this hand-builds one — same reasoning
    // as spell-gear.test.ts's own 2-entry resolveChainPass test.
    const first = spellInstance(INCINERATE);
    const second = spellInstance(FIRESTORM);
    const state = makeState({
      chainOpen: false,
      spellChain: [
        { playerIndex: 0, card: first },
        { playerIndex: 1, card: second },
      ],
    });

    const items = describeChain(state);
    expect(items).toHaveLength(2);
    // Firestorm was pushed LAST, so it resolves FIRST and heads the list.
    expect(items[0]!.cardName).toBe("Firestorm");
    expect(items[0]!.depthFromTop).toBe(0);
    expect(items[0]!.playerIndex).toBe(1);
    expect(items[1]!.cardName).toBe("Incinerate");
    expect(items[1]!.depthFromTop).toBe(1);
    expect(items[1]!.playerIndex).toBe(0);
  });

  it("describes a unit target at a battlefield with its name, battlefield and owner", () => {
    const victim = makeUnit({ name: "Bandle Bandit" });
    const base = makeState();
    const battlefields = [...base.battlefields];
    battlefields[1] = { ...battlefields[1]!, units: { p2: [victim] } };
    const state: GameState = {
      ...base,
      battlefields,
      chainOpen: false,
      spellChain: [{ playerIndex: 0, card: spellInstance(INCINERATE), targetUnitInstanceId: victim.instanceId }],
    };

    expect(describeChain(state)[0]!.targets).toEqual([
      { kind: "unit", name: "Bandle Bandit", battlefieldName: "Battlefield 2", ownerIndex: 1 },
    ]);
  });

  it("describes a unit target sitting in base with a null battlefieldName", () => {
    // Base-scope targeting is real (Stupefy's "a unit" reaches the enemy base),
    // so "at no battlefield" has to be expressible rather than absent.
    const homebody = makeUnit({ name: "Sleepy Poro" });
    const base = makeState();
    const players = [...base.players] as GameState["players"];
    players[1] = { ...players[1], baseUnits: [homebody] };
    const state: GameState = {
      ...base,
      players,
      chainOpen: false,
      spellChain: [{ playerIndex: 0, card: spellInstance(INCINERATE), targetUnitInstanceId: homebody.instanceId }],
    };

    expect(describeChain(state)[0]!.targets).toEqual([
      { kind: "unit", name: "Sleepy Poro", battlefieldName: null, ownerIndex: 1 },
    ]);
  });

  it("describes a unitPair's two targets in slot order", () => {
    const mine = makeUnit({ name: "My Duelist" });
    const theirs = makeUnit({ name: "Their Duelist" });
    const base = makeState();
    const battlefields = [...base.battlefields];
    battlefields[0] = { ...battlefields[0]!, units: { p1: [mine], p2: [theirs] } };
    const state: GameState = {
      ...base,
      battlefields,
      chainOpen: false,
      spellChain: [
        {
          playerIndex: 0,
          card: spellInstance(DUEL),
          targetUnitInstanceId: mine.instanceId,
          secondTargetUnitInstanceId: theirs.instanceId,
        },
      ],
    };

    expect(describeChain(state)[0]!.targets.map((t) => t.name)).toEqual(["My Duelist", "Their Duelist"]);
  });

  it("describes a battlefield target by name", () => {
    const state = makeState({
      chainOpen: false,
      spellChain: [{ playerIndex: 0, card: spellInstance(FIRESTORM), targetBattlefieldId: "bf2" }],
    });

    expect(describeChain(state)[0]!.targets).toEqual([{ kind: "battlefield", name: "Battlefield 2" }]);
  });

  it("describes a chosen trash card out of the caster's own trash", () => {
    const inTrash = makeUnit({ name: "Fallen Hero" });
    const base = makeState();
    const players = [...base.players] as GameState["players"];
    players[1] = { ...players[1], trash: [inTrash] };
    const state: GameState = {
      ...base,
      players,
      chainOpen: false,
      spellChain: [{ playerIndex: 1, card: spellInstance(MORBID_RETURN), trashCardInstanceId: inTrash.instanceId }],
    };

    expect(describeChain(state)[0]!.targets).toEqual([{ kind: "trashCard", name: "Fallen Hero" }]);
  });

  it("describes an additional exhaust cost separately from a target", () => {
    const exhausted = makeUnit({ name: "Focused Monk" });
    const base = makeState();
    const players = [...base.players] as GameState["players"];
    players[0] = { ...players[0], baseUnits: [exhausted] };
    const state: GameState = {
      ...base,
      players,
      chainOpen: false,
      spellChain: [
        { playerIndex: 0, card: spellInstance(MEDITATION), additionalCostUnitInstanceId: exhausted.instanceId },
      ],
    };

    expect(describeChain(state)[0]!.targets).toEqual([
      { kind: "additionalCost", name: "Focused Monk", battlefieldName: null, ownerIndex: 0 },
    ]);
  });

  it("describes a token-placing Spell's destination", () => {
    const state = makeState({
      chainOpen: false,
      spellChain: [{ playerIndex: 0, card: spellInstance(RECRUIT), destinationBattlefieldId: "bf1" }],
    });

    expect(describeChain(state)[0]!.targets).toEqual([{ kind: "destination", name: "Battlefield 1" }]);
  });

  it("flags a target it can't find rather than throwing or going blank", () => {
    const state = makeState({
      chainOpen: false,
      spellChain: [
        {
          playerIndex: 0,
          card: spellInstance(INCINERATE),
          targetUnitInstanceId: "ghost-unit",
          targetBattlefieldId: "bf-nope",
        },
      ],
    });

    expect(describeChain(state)[0]!.targets).toEqual([
      { kind: "unit", name: "ghost-unit", missing: true },
      { kind: "battlefield", name: "bf-nope", missing: true },
    ]);
  });
});
