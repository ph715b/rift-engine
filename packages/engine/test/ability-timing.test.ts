import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { abilityTimingTier, activatedAbilityDefIds } from "../src/engine/activated-abilities.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";

/**
 * **Activated abilities are timed, and until 2026-08-24 none of them were.**
 *
 * Reported from playtesting: *"you shouldn't be able to equip during a showdown
 * and not on your turn. I believe equip is the same speed as cards like falling
 * star where you can only do it on your turn and not in showdowns."* Exactly
 * right, and **818.1** makes `[Equip]` an Activated Ability, so the report is
 * about all 184 of them rather than about gear.
 *
 * # The rule, and why 381 alone gets it wrong
 *
 * **310.1.a** is the precise sentence: *"By default, cards can be played and
 * abilities activated **only when a player has priority on their turn in a
 * Neutral Open state**."*
 *
 * **381** — *"All Activated Abilities can only be activated on the Controlling
 * Player's Turn and during an Open State"* — is the one a reader finds first, and
 * on its own it is too WIDE: a Showdown with an empty chain is also an Open State
 * (**309.2**, and 323.14's "Showdown Open State"), so 381 alone would permit
 * exactly the activation the report is about. 310.1.a's *Neutral* is the word
 * that excludes it, and **316.5.b** confirms the actor — in that state *"only the
 * Turn Player has the ability to play spells or activate abilities."*
 *
 * The two widenings are keywords printed on the ABILITY: **806.1.c.2**
 * `[Action]` — "can be activated during showdowns on any player's turn" — and
 * **813.1.c.2** `[Reaction]`, which adds Closed States and by 813.1.b grants
 * everything Action grants.
 *
 * # What was there before
 *
 * `legal-actions` pushed `activateAbilityCandidates` outside its `isNeutralOpen`
 * branch and `validate-activate-ability` applied no timing check at all. Both
 * files said so, and `activated-abilities.ts` drew the conclusion out loud: *"so
 * every ability in the pool is already reaction-speed. That is wider than the
 * rules for the OTHER abilities."*
 */

const registry = defaultCardRegistry();

const DIRK = "SFD-009"; // [Equip] [Fury] — Default speed. The reported card's shape.
const EZREAL_DASHING = "SFD-082"; // "[Mind]: [Action] — Move me to your base."
const LUX_CROWNGUARD = "OGS-014"; // "[Exhaust]: [Reaction] — [Add] 2 Energy."

const pool = (domain: Domain, count = 6) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}${i}`, domain, state: "Ready" as const }));

const activationsOf = (state: GameState, instanceId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

// ───────────────────────────────────────────────────────────────────────────
describe("the printed tier and the table agree — in BOTH directions", () => {
  /**
   * **The pool prints the keyword in TWO layouts, and reading only the documented
   * one loses 19 of the 39.**
   *
   * 806.1.d says Action "is formatted as `[Action]` on spells, or `[Action][>]` on
   * abilities", and UNL/VEN print exactly that. OGN, OGS and SFD put it after the
   * cost instead — Seal of Rage is "[Exhaust]: [Reaction] — [Add] [Fury]".
   *
   * **And the em-dash is MOJIBAKED in the older data**: `ogn.json` carries
   * U+00E2 U+0080 U+0094 (an em-dash's UTF-8 bytes read as Latin-1) on 102 lines
   * and `ogs.json` on 3, while sfd/unl/ven carry a clean U+2014. Matching only the
   * real dash drops all ten OGN/OGS entries and keeps the SFD ones — which reads
   * like a per-set finding rather than an encoding bug, and is how this nearly
   * shipped with every rune Seal silently demoted to Default.
   */
  const PRINTED = /\[(Action|Reaction)\](?:\[>\]|(?:,\s*\[[A-Za-z]+\])?\s*(?:—|â))/;

  /** Parentheticals are REMINDER text and can describe someone else's ability.
   *  UNL-185 Pyke - Bloodharbor Ripper prints "(It has "[Reaction][>] Kill this,
   *  [Exhaust]: [Add] [rainbow]".)" about the Gold token he makes; his own ability
   *  is a plain default-speed exhaust. */
  const printedTier = (text: string): "Action" | "Reaction" | "Default" => {
    const found = PRINTED.exec(text.replace(/\([^()]*\)/g, " "));
    return found ? (found[1] as "Action" | "Reaction") : "Default";
  };

  const withCards = activatedAbilityDefIds()
    .map((id) => ({ id, def: registry.all().find((d) => d.id === id) }))
    .filter((row): row is { id: string; def: NonNullable<(typeof row)["def"]> } => row.def !== undefined);

  /**
   * **A card can print a speed keyword on an ability that is not the one this
   * defId reaches.**
   *
   * `empowerAbilities()` synthesises an `[Empower]` ability keyed by the card's
   * OWN defId. On a card that also prints an `[Action][>]`/`[Reaction][>]`
   * ability, the Empower one is what `activatedAbilityFor` returns — Platewyrm
   * Egg resolves to `{ energy: 1, exhaust: true }`, its printed `[Empower] — [1],
   * [Exhaust]` cost, which carries no speed keyword and is Default.
   *
   * So the whole-card text scan is RIGHT about the card and WRONG about the
   * ability, and taking it at face value would have let Akali be Empowered inside
   * a Showdown on the strength of a keyword printed on a different line.
   *
   * `mergeRegistries` throws on a duplicate key, so nothing is hiding behind
   * these: the printed speed-tagged half of all three is genuinely unregistered.
   * That is a COVERAGE gap, recorded in docs/rules-conformance.md, and it is why
   * this list is asserted by name below rather than filtered away quietly.
   */
  const EMPOWER_OWNS_THE_DEFID = ["VEN-075", "VEN-139", "VEN-189"];

  it("covers a real slice of the pool — the control for every assertion below", () => {
    // Without this, an empty or tiny `withCards` would make the two bijection
    // tests vacuously green.
    expect(withCards.length, "no registered ability resolved to a card").toBeGreaterThan(150);
    expect(
      withCards.filter((r) => printedTier(String(r.def.text ?? "")) !== "Default").length,
      "no card in the pool reads as speed-tagged — the PRINTED regex has stopped matching",
    ).toBe(38);
  });

  it("the [Empower] collision is exactly these three cards — a FOURTH must be ruled on", () => {
    // The exclusion below is only safe while this holds. A new card with an
    // `[Empower]` cost AND a printed speed keyword needs the same judgement made
    // for it, and would otherwise be silently excused by the filter.
    const collided = withCards
      .filter((r) => r.def.empowerCost !== undefined)
      .filter((r) => printedTier(String(r.def.text ?? "")) !== "Default")
      .map((r) => r.id);

    expect(collided.sort(), "a card gained an [Empower] cost beside a printed speed keyword").toEqual(
      [...EMPOWER_OWNS_THE_DEFID].sort(),
    );
    // ...and each really does resolve to its Empower cost rather than to the
    // ability whose keyword the text scan sees.
    for (const id of EMPOWER_OWNS_THE_DEFID) {
      expect(abilityTimingTier(id), `${id} was tagged from a keyword on an ability this defId does not reach`).toBe(
        "Default",
      );
    }
  });

  it("every ability that PRINTS a speed keyword is tagged with it", () => {
    const wrong = withCards
      .filter((r) => !EMPOWER_OWNS_THE_DEFID.includes(r.id))
      .map((r) => ({ id: r.id, name: r.def.name, printed: printedTier(String(r.def.text ?? "")) }))
      .filter((r) => r.printed !== "Default" && abilityTimingTier(r.id) !== r.printed)
      .map((r) => `${r.id} ${r.name} prints [${r.printed}] and is tagged ${abilityTimingTier(r.id)}`);

    expect(wrong, "a card prints a speed keyword the table does not carry").toEqual([]);
  });

  it("...and every tagged ability PRINTS it — the other direction", () => {
    // The half that catches an over-eager entry. A table that is only checked one
    // way can be widened forever without ever going red, and widening it is
    // exactly what re-creates the permissiveness this file exists to end.
    const wrong = withCards
      .filter((r) => abilityTimingTier(r.id) !== "Default")
      .filter((r) => printedTier(String(r.def.text ?? "")) !== abilityTimingTier(r.id))
      .map((r) => `${r.id} ${r.def.name} is tagged ${abilityTimingTier(r.id)} and prints no such keyword`);

    expect(wrong, "the table claims a speed keyword the card does not print").toEqual([]);
  });

  it("the Gold token is Reaction, and it is the only tagged ability with no card", () => {
    // It has no card entry — its ability is printed only in its parents' reminder
    // text, which the parenthetical strip above deliberately discards. So it can
    // only be asserted directly.
    expect(abilityTimingTier(GOLD_TOKEN_DEF_ID)).toBe("Reaction");

    const orphansTagged = activatedAbilityDefIds()
      .filter((id) => abilityTimingTier(id) !== "Default")
      .filter((id) => !registry.all().some((d) => d.id === id))
      .filter((id) => id !== GOLD_TOKEN_DEF_ID);
    expect(orphansTagged, "a card-less ability was tagged without a note saying why").toEqual([]);
  });

  it("the great majority are Default — the tables are the exception, not the rule", () => {
    const tiers = activatedAbilityDefIds().map(abilityTimingTier);
    expect(tiers.filter((t) => t === "Default").length).toBe(148);
    expect(tiers.filter((t) => t === "Action").length).toBe(13);
    // 22 cards plus the Gold token, which has no card entry of its own.
    expect(tiers.filter((t) => t === "Reaction").length).toBe(23);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("[Equip] is Default speed — the reported bug", () => {
  /** The Dirk in play with Fury to pay its `[Equip]`, and a friendly unit at a
   *  battlefield for it to attach to. */
  function equipState(overrides: Partial<GameState> = {}): { state: GameState; dirkId: string } {
    const dirk = realGearInstance(DIRK);
    const state = makeState({ phase: "Action", activePlayerIndex: 0, ...overrides });
    state.players[0]!.activeGear = [dirk];
    state.players[0]!.channeled = pool("Fury");
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] },
    };
    return { state, dirkId: dirk.instanceId };
  }

  it("IS offered in a Neutral Open state on my turn — the control", () => {
    // Every refusal below is only meaningful against this. Without it they would
    // all pass on a fixture that could never equip at all.
    const { state, dirkId } = equipState();
    expect(activationsOf(state, dirkId).length, "the fixture cannot equip even when it should").toBeGreaterThan(0);
  });

  it("is NOT offered during a Showdown", () => {
    const { state, dirkId } = equipState({
      turnState: "Showdown",
      showdownKind: "Combat",
      showdownBattlefieldId: "bf1",
      focusHolder: 0,
    });
    expect(
      activationsOf(state, dirkId),
      "the reported bug: [Equip] was offered inside a Showdown (310.1.a times it to a Neutral Open state)",
    ).toHaveLength(0);
  });

  it("is NOT offered onto a closed chain", () => {
    // 309.1.a: "Only cards and abilities with the Reaction keyword can be played
    // or activated in a Closed State."
    const { state, dirkId } = equipState({ chainOpen: false, chainPriority: 0 });
    expect(activationsOf(state, dirkId), "a Default ability was offered onto a chain").toHaveLength(0);
  });

  it("...and the VALIDATOR refuses it too — the offered-then-refused pair", () => {
    // The half that actually matters. The enumerator withholding an action the
    // validator would accept is this repo's most repeated bug shape, and it runs
    // both ways: the AI calls the executor directly off `legalActions`, and the
    // web UI can submit a stale action after the state has moved on.
    const { state, dirkId } = equipState();
    const equip = activationsOf(state, dirkId)[0]!;

    const inShowdown: GameState = {
      ...state,
      turnState: "Showdown",
      showdownKind: "Combat",
      showdownBattlefieldId: "bf1",
      focusHolder: 0,
    };
    expect(
      validateActivateAbility(inShowdown, equip),
      "the validator accepted what the enumerator withheld",
    ).toMatchObject({ ok: false });
    // And it still accepts it in the state the enumerator offered it in, so the
    // refusal above is the timing rather than the action being malformed.
    expect(validateActivateAbility(state, equip)).toMatchObject({ ok: true });
  });

  it("is NOT activatable on the opponent's turn", () => {
    // 316.5.b — "only the Turn Player has the ability to play spells or activate
    // abilities". Asserted through the validator because `legalActions` enumerates
    // for the ACTING player, so on seat 1's turn seat 0's abilities are not
    // reached at all and the enumerator's silence would prove nothing.
    const { state, dirkId } = equipState();
    const equip = activationsOf(state, dirkId)[0]!;
    const theirTurn: GameState = { ...state, activePlayerIndex: 1 };

    expect(validateActivateAbility(theirTurn, equip), "seat 0 equipped on seat 1's turn").toMatchObject({ ok: false });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the two widenings still widen — the scope controls", () => {
  /**
   * Without these, every assertion above would also pass on an engine that had
   * simply stopped offering activated abilities outside a Neutral Open state —
   * which is a different bug in the opposite direction, and one that would take
   * every rune Seal, both banking Legends and Ornn out of showdowns with it.
   */
  function unitState(defId: string, domain: Domain, overrides: Partial<GameState> = {}) {
    const unit = realUnitInstance(defId);
    const state = makeState({ phase: "Action", activePlayerIndex: 0, ...overrides });
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.channeled = pool(domain);
    return { state, unitId: unit.instanceId };
  }

  const showdown = {
    turnState: "Showdown" as const,
    showdownKind: "Combat" as const,
    showdownBattlefieldId: "bf1",
    focusHolder: 0 as const,
  };

  it("an [Action] ability IS offered during a Showdown (806.1.c.2)", () => {
    expect(abilityTimingTier(EZREAL_DASHING), "the subject is not the tier this test is about").toBe("Action");
    const { state, unitId } = unitState(EZREAL_DASHING, "Mind", showdown);
    expect(activationsOf(state, unitId).length, "[Action] lost its showdown permission").toBeGreaterThan(0);
  });

  it("...but NOT onto a closed chain — Action is not Reaction", () => {
    // 806 grants showdowns; 813.1.c.2 is what grants Closed States. Conflating them
    // is the easiest way to write this gate wrongly and still see it pass.
    const { state, unitId } = unitState(EZREAL_DASHING, "Mind", { chainOpen: false, chainPriority: 0 });
    expect(activationsOf(state, unitId), "[Action] was allowed onto a chain").toHaveLength(0);
  });

  it("a [Reaction] ability IS offered onto a closed chain (813.1.c.2)", () => {
    expect(abilityTimingTier(LUX_CROWNGUARD), "the subject is not the tier this test is about").toBe("Reaction");
    const { state, unitId } = unitState(LUX_CROWNGUARD, "Order", { chainOpen: false, chainPriority: 0 });
    expect(activationsOf(state, unitId).length, "[Reaction] lost its closed-chain permission").toBeGreaterThan(0);
  });

  it("and during a Showdown, which Reaction inherits from Action (813.1.b)", () => {
    const { state, unitId } = unitState(LUX_CROWNGUARD, "Order", showdown);
    expect(activationsOf(state, unitId).length, "[Reaction] did not inherit Action's window").toBeGreaterThan(0);
  });
});
