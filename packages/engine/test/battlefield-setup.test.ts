import { describe, expect, it } from "vitest";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { chooseMatchBattlefields } from "../src/decks/battlefield-setup.js";
import { mulberry32 } from "../src/util/rng.js";

describe("chooseMatchBattlefields", () => {
  it("picks exactly 2 battlefields total, one from each deck's own 3-battlefield pool", () => {
    const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const masterYi = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Master Yi"))!);

    const [bf1, bf2] = chooseMatchBattlefields(garen, masterYi, mulberry32(1));

    expect(garen.battlefieldNames).toContain(bf1.name);
    expect(masterYi.battlefieldNames).toContain(bf2.name);
    expect(bf1.id).not.toBe(bf2.id);
    expect(bf1.controllerId).toBeNull();
    expect(bf2.controllerId).toBeNull();
  });

  it("is deterministic for a given seed", () => {
    const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const masterYi = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Master Yi"))!);

    const first = chooseMatchBattlefields(garen, masterYi, mulberry32(42));
    const second = chooseMatchBattlefields(garen, masterYi, mulberry32(42));

    expect(first.map((b) => b.name)).toEqual(second.map((b) => b.name));
  });
});
