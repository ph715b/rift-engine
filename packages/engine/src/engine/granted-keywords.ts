import { findUnitAnywhere } from "./target-lookup.js";
import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { Keyword } from "../model/keyword.js";
import { effectiveMight } from "./effective-might.js";
import { MIGHTY_THRESHOLD, isMechDef } from "./constants.js";
import { battlefieldKeywordsAt } from "./battlefield-continuous.js";
import { mergeGrantedKeyword } from "./keyword-stacking.js";
import { equipmentDefIds, equipmentKeywordDefIds, equipmentKeywordsFor } from "./equipment.js";
import { effectiveTagsOf } from "./equipment.js";

/**
 * Keywords a unit has RIGHT NOW, printed ones plus any it is currently being
 * granted by its own text.
 *
 * Several cards read "While I'm X, I have [Keyword]" or "If <condition>, I have
 * [Keyword]", and a keyword granted that way has to behave exactly like a
 * printed one — which means every place that asks "does this unit have
 * [Ganking]?" has to ask THIS rather than `unit.keywords` directly. There were
 * three such places (validate-move-unit, legal-actions' move fan-out, and
 * effectiveMight's Assault/Shield terms) and they would each have grown their
 * own copy of the condition otherwise.
 *
 * Deliberately a small keyed table, not a general continuous-ability engine —
 * the same convention `effective-might.ts`'s aura list follows, and for the same
 * reason: three confirmed cards, no speculation.
 *
 * Nothing here is ever written into state. A granted keyword is recomputed on
 * every read, so there is nothing to expire and no way for it to go stale when
 * the condition stops holding mid-turn.
 */

/** Raging Soul: "If you've discarded a card this turn, I have [Assault] and
 *  [Ganking]." A per-turn condition on the PLAYER, not on the unit. */
const RAGING_SOUL = "OGN-019";
/** Bilgewater Bully: "While I'm buffed, I have [Ganking]." A condition on the
 *  unit itself, so it comes and goes as the buff is placed and spent. */
const BILGEWATER_BULLY = "OGN-125";
/** Fiora - Victorious: "While I'm [Mighty], I have [Deflect], [Ganking], and
 *  [Shield]." Mighty is rule 708 — Might 5 or greater, evaluated on the unit's
 *  CURRENT Might. */
const FIORA_VICTORIOUS = "OGN-232";

/**
 * Captain Farron: "Other friendly units here have [Assault]." The first keyword
 * aura in the pool whose SOURCE is a different card from the unit that gets the
 * keyword — every grant above is a card's own text about itself.
 */
const CAPTAIN_FARRON = "OGN-015";
/** Taric - Protector: "[Shield][Tank] Other friendly units here have [Shield]."
 *  The printed two are the card frame's; only the aura is written here. */
const TARIC_PROTECTOR = "OGN-074";
/**
 * Spirit's Refuge: "Friendly buffed units have [Deflect] if they didn't already."
 *
 * Two firsts, and both are why the aura table below needs more than a defId and a
 * keyword list. Its source is a **GEAR**, which is never at a battlefield in this
 * pool — so it can only be an unpositioned aura, which is also what its text says
 * (no "here"). And it carries a **per-target condition**: "buffed" is a property
 * of each receiving unit, re-asked as buffs are placed and spent.
 *
 * "If they didn't already" is a THIRD thing to implement, and it used to be free:
 * while every source merged with `Math.max` the clause was indistinguishable from
 * the default. 809.2 sums granted `[Deflect]` values, so under the real rule this
 * card would take Volibear - Furious from `[Deflect 2]` to `[Deflect 3]` — the
 * opposite of what it prints. `onlyIfAbsent` below is the clause, and it is the
 * only entry in the table that carries it.
 */
const SPIRITS_REFUGE = "OGN-063";
/**
 * Gemcraft Seer: "[Vision] Other friendly units have [Vision]."
 *
 * **The rules use this exact sentence as their own worked example** of layer 2
 * (477): *"A permanent has the ability 'Other friendly units have [Vision].'
 * Other friendly units gain the Vision keyword in this layer."* So there is
 * nothing to guess about whether the aura is real.
 *
 * What it MEANS took the keyword's own definition: *"Vision is a Triggered
 * Ability keyword… functionally short for 'When this is played, predict.' **The
 * trigger is the permanent entering the Board.**"* That last sentence is the
 * whole card. Read as a "when you play me" ability the grant would be inert —
 * every unit already in play has had its play moment — but the trigger condition
 * is the ENTRY, so a unit arriving while the Seer stands predicts on arrival.
 *
 * `scope: "anywhere"`, because her text names no battlefield, unlike Farron's and
 * Taric's. That is also what makes her implementable without knowing where the
 * entering unit is going: see `unitEntersWithVision`.
 */
const GEMCRAFT_SEER = "OGN-100";

/** The cards whose printed text this module implements — for coverage.ts, which
 *  would otherwise report them inert. */
export function grantedKeywordDefIds(): string[] {
  // The Equipment whose granted keyword IS their whole art-only ability are
  // implemented in equipment.ts, and coverage must be able to see them: their
  // printed JSON text is nothing but an `[Equip]` line, so nothing else claims
  // them.
  //
  // `equipmentDefIds()` is the other half of the same problem and was WRITTEN
  // FOR IT — its own comment says "for coverage.ts" — and then never called by
  // anything. Jax - Unmatched ("your Equipment everywhere have [Quick-Draw]")
  // has worked in play since the day it was written and reported UNIMPLEMENTED
  // the whole time, because coverage asks which MODULE claims a card and no
  // module did. **This is the Lucian - Purifier trap exactly**, recorded in
  // memory after the last time: if a card works and the count does not move, the
  // module has not claimed it.
  return [
    SIVIR_MERCENARY,
    RAGING_SOUL,
    BILGEWATER_BULLY,
    FIORA_VICTORIOUS,
    ...Object.keys(DYNAMIC_KEYWORD_VALUES),
    ...Object.keys(KEYWORD_AURAS),
    ...equipmentKeywordDefIds(),
    ...equipmentDefIds(),
  ];
}

/**
 * A keyword granted to OTHER permanents by a source card — rule 477's layer 2,
 * "Ability-Altering Effects", which the rules identify by the words "have"/"has"
 * and whose own worked example is one of these very cards ("A permanent has the
 * ability 'Other friendly units have [Vision].' Other friendly units gain the
 * Vision keyword in this layer").
 *
 * Structurally different from `CONDITIONAL_GRANTS` above, which is keyed by the
 * RECEIVING unit's own defId because every entry there is a card talking about
 * itself. An aura is keyed by its SOURCE and has to be looked up from the other
 * end, which is why it could not be expressed as another `Grant`.
 *
 * Deliberately a small keyed table rather than a general continuous-ability
 * engine, the same convention `effective-might.ts`'s aura list follows and for the
 * same reason: three confirmed cards, no speculation.
 */
interface KeywordAura {
  /** Where the source lives. Gear is never at a battlefield here, so a gear
   *  source can only ever be `scope: "anywhere"`.
   *
   *  `"legend"` is SFD's addition: a Legend sits in its own zone rather than on
   *  the board, so neither the unit walk nor the gear list can find one. It is
   *  always in play and never at a battlefield, which makes it the only source
   *  for which `scope: "here"` is meaningless — the same constraint gear has,
   *  and for the same reason.
   *
   *  `"gearWearer"` is SFD's second addition, and the one this table genuinely
   *  could not express before. Shurelya's Requiem reads "your units HERE have
   *  [Ganking]", where HERE is wherever its WEARER is standing. A `"gear"` source
   *  is never at a battlefield, so it can only ever be `scope: "anywhere"`; this
   *  source is a gear that BORROWS its wearer's location, which is what makes a
   *  positional gear aura possible at all. An UNATTACHED Requiem reaches nobody,
   *  because it has no wearer to borrow a location from — which is exactly what
   *  "here" means for a card that has to be worn. */
  source: "unit" | "gear" | "legend" | "gearWearer";
  /** `"here"` is the source's own battlefield and nothing else — so a source
   *  sitting in BASE reaches nobody, the same positional reading Lee Sin -
   *  Centered's and Leona - Zealot's Might auras take. */
  scope: "here" | "anywhere";
  /** "OTHER friendly units" — printed on both unit sources, and load-bearing:
   *  without it Taric grants himself a [Shield] he already has and Farron gives
   *  himself an [Assault] he does not print. */
  excludesSelf: boolean;
  /** A condition on the RECEIVING unit — Spirit's Refuge's "buffed". Asked fresh
   *  on every read, so it comes and goes with the buff. */
  appliesTo?: (unit: UnitInstance) => boolean;
  /**
   * A condition answerable from the receiving card's DEFINITION alone — SFD's
   * "your MECHS have ...", where the tag is printed and cannot change in play.
   *
   * Separate from `appliesTo` because of where each can be asked.
   * `keywordOnEntry` runs BEFORE the unit exists as an instance, so it cannot
   * consult `appliesTo` at all — and `[Vision]` is entry-triggered, so an aura
   * with only an instance-level predicate would offer the Vision recycle to a
   * non-Mech entering under Forecaster. That trap was spotted by the agent that
   * refused to write the card, and this field is the answer to it: a tag is
   * printed on the definition, so it CAN be asked at entry.
   */
  appliesToDef?: (def: { id: string; tags?: readonly string[] }) => boolean;
  /**
   * Spirit's Refuge's "**if they didn't already**" — the grant is skipped
   * entirely when the recipient already has the keyword from any other source,
   * rather than folded in.
   *
   * One card in the pool prints this, and it is a printed exception to 809.2's
   * summing rather than a general property of auras: without it a Refuge on the
   * board would RAISE a printed `[Deflect 2]` to 3, which is the direction the
   * sentence exists to forbid.
   */
  onlyIfAbsent?: true;
  keywords: Keyword[];
}

/** "Your Mechs" — a printed tag, so it is answerable from the definition and
 *  can therefore be asked at ENTRY as well as on the board.
 *
 *  Moved to `constants.ts` when Rumble - Scrapper's tribal MIGHT aura needed the
 *  same question from `effective-might`, which this module imports and so cannot
 *  import back. Re-exported under the local name the table below already uses,
 *  so one definition of "is a Mech" serves both. */
const isMech = isMechDef;

/** "Your Sand Soldiers" — Azir. A printed tag like Mech's, so it is answerable
 *  from the definition and therefore askable at ENTRY as well as on the board.
 *  The tokens Desert's Call and Azir himself make carry the tag too. */
const isSandSoldier = (def: { tags?: readonly string[] }): boolean => def.tags?.includes("Sand Soldier") === true;

const FORECASTER = "SFD-065";
const BREAKNECK_MECH = "SFD-071";
const RUMBLE_HOTHEADED = "SFD-026";
/** Azir - Emperor of the Sands — "Your Sand Soldiers have [Weaponmaster]." */
const AZIR_EMPEROR = "SFD-197";
const PETRICITE_MONUMENT = "SFD-104";
/** Shurelya's Requiem — "your units HERE have [Ganking]", where HERE is its
 *  WEARER's battlefield. The pool's first positional GEAR aura. */
const SHURELYAS_REQUIEM = "SFD-192";
/** Rumble - Mechanized Menace — "Your Mechs have [Shield]." The pool's first
 *  LEGEND-sourced keyword aura, and the third Rumble to grant Mechs something. */
const RUMBLE_MECHANIZED_MENACE = "SFD-181";

/** Lillia - Protector of Dreams — "Your token units have [Tank]."
 *
 *  The pool's first aura whose recipient condition is the recipient's own TOKEN
 *  NATURE rather than a printed tag or a board state. `appliesTo` rather than
 *  `appliesToDef`, and the two are not interchangeable here: a token has no
 *  CardDefinition to ask — `createToken` builds the instance from a `TokenSpec` —
 *  so the definition-level predicate could never see one. `[Tank]` is read on the
 *  board by `combat.assignmentOrder` rather than at entry, which is what makes
 *  the instance-level predicate sufficient; `[Vision]`'s entry trap, recorded on
 *  `appliesToDef` above, does not reach this card. */
const LILLIA_PROTECTOR = "UNL-058";

const KEYWORD_AURAS: Record<string, KeywordAura> = {
  [CAPTAIN_FARRON]: { source: "unit", scope: "here", excludesSelf: true, keywords: ["Assault"] },
  [LILLIA_PROTECTOR]: {
    source: "unit",
    // "YOUR token units", with no location clause — 355.9.a.1 widens a bare
    // noun to the whole Board, so a token standing in base is covered too.
    scope: "anywhere",
    // She is not a token, so `appliesTo` already excludes her; stated as false
    // rather than true because the card prints no "other" and a reader should
    // not infer one.
    excludesSelf: false,
    appliesTo: (unit) => unit.isToken,
    keywords: ["Tank"],
  },
  [TARIC_PROTECTOR]: { source: "unit", scope: "here", excludesSelf: true, keywords: ["Shield"] },
  [GEMCRAFT_SEER]: { source: "unit", scope: "anywhere", excludesSelf: true, keywords: ["Vision"] },
  [SPIRITS_REFUGE]: {
    source: "gear",
    scope: "anywhere",
    excludesSelf: false,
    appliesTo: (unit) => unit.buffed,
    // "...have [Deflect] IF THEY DIDN'T ALREADY."
    onlyIfAbsent: true,
    keywords: ["Deflect"],
  },

  // SFD's four. Three are tribal ("your MECHS have ..."), which is what
  // `appliesToDef` exists for; Petricite Monument reaches every friendly unit
  // and needs no predicate at all.
  [FORECASTER]: {
    source: "unit",
    scope: "anywhere",
    excludesSelf: false,
    appliesToDef: isMech,
    keywords: ["Vision"],
  },
  [BREAKNECK_MECH]: {
    source: "unit",
    scope: "anywhere",
    excludesSelf: false,
    appliesToDef: isMech,
    keywords: ["Deflect", "Ganking"],
  },
  [AZIR_EMPEROR]: {
    // Azir - Emperor of the Sands — "Your Sand Soldiers have [Weaponmaster]."
    //
    // Same shape as Rumble - Mechanized Menace below: a LEGEND source, so it is
    // in play from turn one and never leaves, and `excludesSelf` has no meaning
    // because a Legend is not a unit and cannot be a Sand Soldier.
    //
    // `appliesToDef` rather than `appliesTo`, for the reason that field's own doc
    // records: the tag is printed, so it survives being asked BEFORE the unit
    // exists as an instance — which is what `keywordOnEntry` needs.
    source: "legend",
    scope: "anywhere",
    excludesSelf: false,
    appliesToDef: isSandSoldier,
    keywords: ["Weaponmaster"],
  },
  [RUMBLE_MECHANIZED_MENACE]: {
    // A LEGEND source, so it is in play from turn one and never leaves — no
    // `excludesSelf` question either, since a Legend is not a unit and cannot be
    // a Mech.
    source: "legend",
    scope: "anywhere",
    excludesSelf: false,
    appliesToDef: isMech,
    keywords: ["Shield"],
  },
  [RUMBLE_HOTHEADED]: {
    source: "unit",
    scope: "anywhere",
    excludesSelf: false,
    appliesToDef: isMech,
    keywords: ["Assault"],
  },
  [SHURELYAS_REQUIEM]: {
    // Shurelya's Requiem — "Your units HERE have [Ganking]."
    //
    // **ART-ONLY ABILITY**, transcribed from the card image; see
    // docs/sfd-equipment-abilities.md. Its "when you play this, ready your
    // units" half was already written; this is the aura.
    //
    // The first `"gearWearer"` source, and the reason that kind exists: a plain
    // gear source has no location, so `scope: "here"` could not be expressed for
    // one until a gear could borrow its wearer's square.
    source: "gearWearer",
    scope: "here",
    // A gear is not a unit and can never be its own recipient — meaningless
    // here, exactly as it is for the two legend sources above.
    excludesSelf: false,
    keywords: ["Ganking"],
  },
  [PETRICITE_MONUMENT]: {
    // A GEAR source, so `scope` can only be "anywhere" — and "friendly units"
    // carries no tribe, so no predicate. Its own `[Temporary]` is the loader's.
    source: "gear",
    scope: "anywhere",
    excludesSelf: false,
    keywords: ["Deflect"],
  },
};

/** Where a unit in play stands, as the aura scopes express it. `undefined` for a
 *  unit that is not on the board at all — a card still in hand reaches here
 *  through `effectiveKeywords`, and it is nobody's neighbour. */
function locationOf(state: GameState, unit: UnitInstance): string | "base" | undefined {
  const found = findUnitAnywhere(state, unit.instanceId);
  if (!found) return undefined;
  return found.zone === "base" ? "base" : state.battlefields[found.zone.battlefieldIndex]?.id;
}

/**
 * Does `ownerIndex` have a copy of `defId` standing at `location`, OTHER than
 * `exceptInstanceId`?
 *
 * Asked this way round rather than through `effective-might.ownUnitLocation`,
 * which returns where the FIRST copy is. That is fine for the champion-tier cards
 * it serves, and wrong here: Captain Farron and Taric - Protector are ordinary
 * units, three copies to a deck, and two of them at two battlefields is an
 * ordinary board. Asking "is one HERE" cannot miss the second.
 *
 * **"Other" is a different OBJECT, not a different card.** Two Captain Farrons at
 * one battlefield each satisfy the other's "other friendly units", so each has
 * [Assault] and neither grants it to itself — which a defId comparison gets
 * exactly backwards, excluding both. That is why the exclusion is by instanceId
 * and lives here rather than as a check on the card's name.
 */
function ownUnitAtLocation(
  state: GameState,
  ownerIndex: 0 | 1,
  defId: string,
  location: string | "base",
  exceptInstanceId?: string,
): boolean {
  const owner = state.players[ownerIndex];
  const here = location === "base" ? owner.baseUnits : (state.battlefields.find((bf) => bf.id === location)?.units[owner.id] ?? []);
  return here.some((u) => u.defId === defId && u.instanceId !== exceptInstanceId);
}

/** Is a copy of `defId` in play for `ownerIndex` anywhere — base or any
 *  battlefield — other than `exceptInstanceId`? The unpositioned counterpart to
 *  `ownUnitAtLocation`, and instance-excluded for the same "other means a
 *  different object" reason. */
function ownUnitAnywhereExcept(state: GameState, ownerIndex: 0 | 1, defId: string, exceptInstanceId?: string): boolean {
  const owner = state.players[ownerIndex];
  const matches = (u: UnitInstance) => u.defId === defId && u.instanceId !== exceptInstanceId;
  if (owner.baseUnits.some(matches)) return true;
  return state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some(matches));
}

/** One keyword an aura is granting, paired with whether its source card prints
 *  Spirit's Refuge's "if they didn't already". A bare `Keyword[]` could not carry
 *  that, and the clause only becomes observable once granted values SUM. */
type AuraGrant = { keyword: Keyword; onlyIfAbsent: boolean };

/** Every keyword an aura is currently granting `unit`. Empty for the overwhelming
 *  majority of reads, and it costs a board lookup only when a source is actually
 *  in play — `effectiveKeywords` runs per unit per damage step in combat. */
function auraGrantedKeywords(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): AuraGrant[] {
  const owner = state.players[ownerIndex];
  const granted: AuraGrant[] = [];
  const grantsOf = (aura: KeywordAura): AuraGrant[] =>
    aura.keywords.map((keyword) => ({ keyword, onlyIfAbsent: aura.onlyIfAbsent === true }));
  let location: string | "base" | undefined;
  let located = false;

  for (const [sourceDefId, aura] of Object.entries(KEYWORD_AURAS)) {
    if (aura.appliesTo && !aura.appliesTo(unit)) continue;
    // **`appliesToDef` has to be asked HERE too, and was not until 2026-08-06.**
    // It was added for `keywordOnEntry`, which reads a printed definition, and
    // the BOARD-side read was never taught about it — so every tribal aura in
    // this table granted its keyword to EVERY friendly unit rather than to the
    // tribe. Forecaster gave [Vision] to non-Mechs, Breakneck Mech gave them
    // [Deflect] and [Ganking], Rumble - Hotheaded gave them [Assault]. Silent in
    // play and in every existing test, because each of those tests asserted only
    // that the MECH got the keyword.
    //
    // A `UnitInstance` carries `tags`, so the predicate works on one directly;
    // it is handed `{ id, tags }` because the definition's key is `id` and an
    // instance's is `defId`.
    // Tags come from `effectiveTagsOf`, not straight off the instance, so a tag
    // GRANTED by an attached Equipment (Experimental Hexplate's "I am a Mech")
    // satisfies a tribal aura exactly as a printed one does. Four of the auras
    // in this table are Mech-keyed, so reading `unit.tags` here would have made
    // the Hexplate work for the discount and the Might aura but silently not for
    // the keywords.
    if (aura.appliesToDef && !aura.appliesToDef({ id: unit.defId, tags: effectiveTagsOf(state, unit) })) continue;
    // "OTHER friendly units" excludes this unit as an OBJECT, never as a card —
    // see ownUnitAtLocation. The exclusion is therefore applied to the SOURCE
    // search below rather than by comparing defIds here.
    const except = aura.excludesSelf ? unit.instanceId : undefined;

    if (aura.source === "gearWearer") {
      // The gear must be in play AND WORN: an unattached Requiem has no square
      // to be "here" at, so it reaches nobody. Its wearer's battlefield is the
      // aura's location, and a wearer in BASE reaches nobody either — "here" is
      // a battlefield throughout this file.
      const worn = owner.activeGear.find((g) => g.defId === sourceDefId && g.attachedToInstanceId != null);
      const wearer = worn?.attachedToInstanceId != null ? findUnitAnywhere(state, worn.attachedToInstanceId) : undefined;
      if (wearer === undefined || wearer.zone === "base") continue;
      if (!located) {
        location = locationOf(state, unit);
        located = true;
      }
      if (location === undefined || location === "base") continue;
      if (location !== state.battlefields[wearer.zone.battlefieldIndex]?.id) continue;
      granted.push(...grantsOf(aura));
      continue;
    }
    if (aura.source === "legend") {
      // A Legend is ALWAYS in play — there is no "did it leave" question, which
      // is exactly what makes this the shortest branch rather than a special
      // case dressed up as one.
      if (owner.legend.defId !== sourceDefId) continue;
    } else if (aura.source === "gear") {
      if (!owner.activeGear.some((g) => g.defId === sourceDefId)) continue;
    } else if (aura.scope === "here") {
      if (!located) {
        location = locationOf(state, unit);
        located = true;
      }
      // A unit that is not on the board, or that is in BASE, is out of reach of
      // a "here" aura: a base is not a battlefield, so no source can share one
      // with it. Same reading, for the same reason, as Lee Sin - Centered's
      // positional Might aura.
      if (location === undefined || location === "base") continue;
      if (!ownUnitAtLocation(state, ownerIndex, sourceDefId, location, except)) continue;
    } else if (!ownUnitAnywhereExcept(state, ownerIndex, sourceDefId, except)) {
      continue; // an unpositioned aura still needs its source in play
    }
    granted.push(...grantsOf(aura));
  }
  return granted;
}

/** A grant condition, evaluated fresh on every read.
 *
 *  `dependsOnMight` marks a grant whose condition IS the unit's Mightiness, and it
 *  is read by exactly one caller: `effectiveMight` withholds these while answering
 *  "is this unit Mighty" (`MightContext.mightyCheck`), because 476 applies each
 *  layer effect only once and the Ability-Altering layer is re-checked only after
 *  the Arithmetic layer has already settled the Might. Without the flag a
 *  combat-aware `isMighty` would ask Fiora - Victorious's `[Shield]` to help
 *  decide whether she has `[Shield]`. */
type Grant = {
  when: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1) => boolean;
  keywords: Keyword[];
  dependsOnMight?: true;
};

/** Sivir - Mercenary: "If you've spent at least [rainbow][rainbow] this turn, I
 *  have +2 Might and [Ganking]." A per-turn condition on the PLAYER, like
 *  Raging Soul's discard — and read from `powerSpentThisTurn`, which
 *  `payPowerFromChanneled` bumps at the one funnel every Power payment takes. */
const SIVIR_MERCENARY = "SFD-143";
const SIVIR_POWER_THRESHOLD = 2;

/** Has this player spent enough Power this turn for Sivir? One predicate, asked
 *  by her keyword grant here and by her Might bonus in effective-might.ts, so
 *  the two halves of one sentence cannot come apart. */
export function sivirConditionMet(state: GameState, ownerIndex: 0 | 1): boolean {
  return state.players[ownerIndex].powerSpentThisTurn >= SIVIR_POWER_THRESHOLD;
}

const CONDITIONAL_GRANTS: Record<string, Grant> = {
  // **Unleashed's `[Level N]` grants, 2026-08-09.** The keyword is stripped at
  // load (`card-loader.GRANTED_ONLY_KEYWORDS`) and handed back here under the real
  // condition — Sivir - Mercenary's exact pairing, one file apart.
  //
  // Read fresh on every evaluation, which is the whole point: 824.1.d makes the
  // ability Inactive again "as soon as the controlling player has less than [N]
  // XP", so a player who spends down loses the keyword. A latched grant would be
  // wrong in the same direction the flat printed keyword was.
  //
  // **Wily Newtfish (UNL-108) joined them on 2026-08-09**, once `xpGainedThisTurn`
  // existed. It was stripped-but-not-re-granted for a day — inert rather than
  // always-on, because weaker than printed beats letting a player make an illegal
  // move all game. Its condition is a PER-TURN FLAG rather than a threshold, which
  // is Raging Soul's shape below and not the [Level] shape beside it.
  "UNL-108": { when: (state, _unit, ownerIndex) => state.players[ownerIndex].xpGainedThisTurn, keywords: ["Ganking"] },
  "UNL-047": { when: (state, _unit, ownerIndex) => state.players[ownerIndex].xp >= 3, keywords: ["Deflect"] },
  "UNL-075": { when: (state, _unit, ownerIndex) => state.players[ownerIndex].xp >= 3, keywords: ["Ganking"] },
  "UNL-113": { when: (state, _unit, ownerIndex) => state.players[ownerIndex].xp >= 6, keywords: ["Deflect", "Ganking"] },
  [SIVIR_MERCENARY]: {
    when: (state, _unit, ownerIndex) => sivirConditionMet(state, ownerIndex),
    keywords: ["Ganking"],
  },
  [RAGING_SOUL]: {
    when: (state, _unit, ownerIndex) => state.players[ownerIndex].discardedThisTurn,
    keywords: ["Assault", "Ganking"],
  },
  [BILGEWATER_BULLY]: {
    when: (_state, unit) => unit.buffed,
    keywords: ["Ganking"],
  },
  [FIORA_VICTORIOUS]: {
    when: (state, unit, ownerIndex) => isMighty(state, unit, ownerIndex),
    // [Deflect] is granted faithfully and does nothing yet — the keyword itself
    // is an open divergence (docs/rules-conformance.md). Granting it anyway
    // keeps this table a statement of what the CARD says rather than of what the
    // engine happens to support.
    keywords: ["Deflect", "Ganking", "Shield"],
    // The only entry here whose condition is Might, and the only one that has to
    // be withheld from the Might computation itself — see the field's doc.
    dependsOnMight: true,
  },
};

/**
 * A keyword whose VALUE is computed from the board — Ancient Warmonger's
 * "I have [Assault] equal to the number of enemy units here".
 *
 * Distinct from `CONDITIONAL_GRANTS` above, which answers a yes/no and grants at
 * value 1. The valued keywords ([Assault], [Shield], [Deflect]) already carry an
 * N that `effectiveKeywords` returns and `effectiveMight` reads, so nothing
 * downstream needed changing — only the ability to say what N is at read time.
 *
 * Keyed by the unit's OWN defId, like `CONDITIONAL_GRANTS` and unlike
 * `KEYWORD_AURAS`: every entry is a card talking about itself.
 *
 * Re-asked on every read, so it tracks the board as units arrive and die
 * mid-combat — which is the point of the card and the reason it is not a stored
 * value. A 0 is folded in as a 0 rather than skipped, which keeps the key present
 * (`hasKeyword` asks `in`) without adding anything.
 *
 * **No recursion risk, and that is a real constraint rather than an
 * observation.** This is consulted from `effectiveKeywords`, which
 * `effectiveMight` calls for its combat terms — so a value that read Might
 * would close a loop. Counting bodies does not.
 */
type DynamicKeywordValue = {
  keyword: Keyword;
  value: (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1) => number;
};

/** Ancient Warmonger: "I have [Assault] equal to the number of enemy units
 *  here." */
const ANCIENT_WARMONGER = "SFD-131";

const DYNAMIC_KEYWORD_VALUES: Record<string, DynamicKeywordValue> = {
  [ANCIENT_WARMONGER]: {
    keyword: "Assault",
    // "HERE" is a battlefield, so a Warmonger in base has [Assault 0] — the same
    // positional reading every other "here" in this file and in
    // effective-might.ts takes. Counted off the OPPONENT's list at that
    // battlefield, which is what "enemy" means and is measured from HIS
    // controller's side rather than from whoever is asking.
    value: (state, unit, ownerIndex) => {
      const location = locationOf(state, unit);
      if (location === undefined || location === "base") return 0;
      const enemyId = state.players[ownerIndex === 0 ? 1 : 0].id;
      return state.battlefields.find((bf) => bf.id === location)?.units[enemyId]?.length ?? 0;
    },
  },
};

/**
 * Rule 708: "A Unit 'is Mighty' as long as its Might is 5 or greater", evaluated
 * on its CURRENT Might. **The one function that answers this question** — every
 * "while I'm [Mighty]", "each of your [Mighty] units" and "becomes [Mighty]" in
 * the engine goes through here, including `effect-helpers.withMightTransitions`,
 * which used to spell the comparison out itself and could therefore disagree.
 *
 * **In combat, the HIGHER of the two roles counts — project-owner ruling,
 * 2026-08-08.** The PDF's worked example (the Fiora - Victorious pair under 476,
 * immediately before 477 lists the layer order) ends: "While a buffed Fiora,
 * Victorious is in combat as a defender, an additional +1 Might will be applied
 * in the Arithmetic layer, giving her 6 Might and the 3 keywords." So `[Shield]`'s
 * bonus is part of a defender's current Might and `[Assault]`'s is part of an
 * attacker's, and a unit can therefore BECOME Mighty by entering combat.
 *
 * This engine has no single combat Might — `MightContext.combatRole` splits it
 * into what a unit deals and what it can absorb, and those are genuinely different
 * numbers (`[Shield]` lifts only the second, and only while defending). The ruling
 * is what settles which one 708 is asking about: either.
 *
 * `mightyCheck` is what makes that safe to ask, and it is 476's "each effect
 * applied only a single time" rather than a recursion guard — see its doc on
 * `MightContext`. Fiora - Victorious cannot bootstrap herself Mighty off the
 * `[Shield]` she only has while Mighty, but a `[Shield]` from Taric - Protector or
 * from the card frame does count.
 *
 * The out-of-combat read comes first and short-circuits, which is both cheaper and
 * exact: every combat term ([Assault], [Shield], Wielder of Water, Crimson
 * Pigeons, Master Yi - Wuju Bladesman) is additive, so a combat role can never be
 * LOWER than the still reading.
 *
 * **`battlefieldId` was missing until 2026-08-08, and a note in this repo
 * asserted the behaviour it prevented.** `legend-abilities.ts` recorded that
 * Volibear's check works "so that a 4-Might unit under a Garen aura counts as
 * Mighty" — but Garen - Commander's aura is POSITIONAL ("other friendly units
 * have +1 Might **here**"), and a context with no battlefield measures every unit
 * on the board as if it stood in base, so it did not.
 */
export function isMighty(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): boolean {
  const location = locationOf(state, unit);
  const where = location === undefined || location === "base" ? {} : { battlefieldId: location };
  if (effectiveMight(state, unit, ownerIndex, { isCombat: false, ...where }) >= MIGHTY_THRESHOLD) return true;

  // "In combat" is this unit's own fight, not any fight: a Combat Showdown open
  // at bf1 says nothing about a [Shield] unit standing at bf2. A NonCombat
  // Showdown is deliberately excluded — 316.8.b.1 says it "does not create a Combat",
  // so there is no attacker, no defender and no keyword bonus to apply.
  if (state.showdownKind !== "Combat") return false;
  if (location === undefined || location === "base" || location !== state.showdownBattlefieldId) return false;
  // The attacker is `activePlayerIndex`, frozen for the Showdown's lifetime — the
  // same derivation `execute-pass-focus` hands `resolveShowdown`, rather than a
  // second reading of who is attacking.
  const isAttackingSide = ownerIndex === state.activePlayerIndex;
  return (["outgoing", "remaining"] as const).some(
    (combatRole) =>
      effectiveMight(state, unit, ownerIndex, {
        isCombat: true,
        isAttackingSide,
        combatRole,
        battlefieldId: location,
        mightyCheck: true,
      }) >= MIGHTY_THRESHOLD,
  );
}

/**
 * `unit.keywords` plus whatever its own text is currently granting it.
 *
 * A granted keyword with no printed value takes 1 — the rules' default when a
 * keyword's X is omitted, and what "[Assault]" with no number means on Raging
 * Soul. A printed value is never lowered by a grant.
 *
 * `excludeMightDependentGrants` is passed by exactly one caller — `effectiveMight`
 * while answering `isMighty` — and withholds the `dependsOnMight` grants for
 * 476's "each effect applied only a single time". See `MightContext.mightyCheck`.
 * It is a parameter rather than a separate function because everything else about
 * the merge is identical and a fork would drift.
 */
export function effectiveKeywords(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  excludeMightDependentGrants = false,
): Partial<Record<Keyword, number>> {
  const declared = CONDITIONAL_GRANTS[unit.defId];
  const grant = excludeMightDependentGrants && declared?.dependsOnMight === true ? undefined : declared;
  const hasThisTurn = Object.keys(unit.keywordsThisTurn).length > 0;
  const fromAuras = auraGrantedKeywords(state, unit, ownerIndex);
  // Windswept Hillock's `[Ganking]` — the BATTLEFIELD a unit stands at can grant
  // a keyword, and it grants to BOTH sides, so it is looked up from the location
  // rather than from a source card someone controls.
  const fromBattlefield = battlefieldKeywordsAt(state, locationOf(state, unit));
  // Keywords from ATTACHED EQUIPMENT (SFD). Read fresh rather than stored, so
  // detaching Doran's Shield takes `[Tank]` with it in the same instant — the
  // same reasoning the Might badge is read at the gate in effective-might.
  const fromEquipment = equipmentKeywordsFor(state, unit.instanceId);
  // Ancient Warmonger's computed [Assault]. Looked up before the fast path
  // below, because a card with one MUST NOT take that path — returning
  // `unit.keywords` unchanged is what "nothing is granting anything" means, and
  // a dynamic value is something being granted.
  const dynamic = DYNAMIC_KEYWORD_VALUES[unit.defId];
  if (
    !hasThisTurn &&
    dynamic === undefined &&
    fromAuras.length === 0 &&
    fromBattlefield.length === 0 &&
    Object.keys(fromEquipment).length === 0 &&
    (!grant || !grant.when(state, unit, ownerIndex))
  ) {
    return unit.keywords;
  }

  // **Every fold below goes through `mergeGrantedKeyword`, and each one of them
  // is an "additional source" in 807.2/809.2/814.2/823.2's sense** — so
  // [Assault], [Deflect], [Shield] and [Hunt] SUM here and everything else stays
  // redundant. That module's doc carries the rules and the false 817.1.a citation
  // this used to rest on; nothing about which-keyword-does-what is decided here,
  // because it was decided in 28 places before and drifted.
  const out: Partial<Record<Keyword, number>> = { ...unit.keywords };
  for (const [keyword, value] of Object.entries(fromEquipment)) {
    mergeGrantedKeyword(out, keyword as Keyword, value);
  }
  // A this-turn grant (Udyr's "[Ganking] this turn") is a fact that happened and
  // holds for the turn; a conditional grant is re-asked every time. Both end up
  // in the same answer, because every reader wants "does it have this NOW".
  //
  // This is the fold that reproduces 807.2's worked example: Petty Officer prints
  // `[Assault 1]`, Cleave writes `[Assault 3]` here, and the unit reads 4.
  for (const [kw, n] of Object.entries(unit.keywordsThisTurn)) {
    mergeGrantedKeyword(out, kw as Keyword, n ?? 1);
  }
  if (grant && grant.when(state, unit, ownerIndex)) {
    for (const kw of grant.keywords) mergeGrantedKeyword(out, kw, 1);
  }
  // Another permanent's aura, folded in on the same terms as the card's own
  // grants — every reader wants "does it have this NOW", and nothing downstream
  // should be able to tell where a keyword came from.
  //
  // **Multiple instances of an UNVALUED keyword still collapse to one**, because
  // this map holds a VALUE per keyword and not a COUNT. That is right for the
  // seven keywords whose own rules make them redundant, and it remains a real
  // divergence for [Vision], whose 817.2 says "multiple instances of Vision
  // trigger separately"; see docs/rules-conformance.md.
  for (const { keyword, onlyIfAbsent } of fromAuras) {
    // Spirit's Refuge alone — "friendly buffed units have [Deflect] IF THEY
    // DIDN'T ALREADY". Order-dependent by nature, and this is the last-but-two
    // fold, so "already" means printed, equipped, this-turn or self-granted.
    if (onlyIfAbsent && (out[keyword] ?? 0) > 0) continue;
    mergeGrantedKeyword(out, keyword, 1);
  }
  // Folded in on the same terms — a keyword a battlefield grants must behave
  // exactly like a printed one, and nothing downstream should be able to tell
  // where it came from.
  for (const kw of fromBattlefield) mergeGrantedKeyword(out, kw, 1);
  // Ancient Warmonger's computed [Assault], and it is an additional source like
  // any other: standing next to a Captain Farron, "[Assault] equal to the number
  // of enemy units here" and Farron's grant sum. Its own printed `[Assault]` is
  // suppressed by card-loader's GRANTED_ONLY_KEYWORDS — the bracket in "I have
  // [Assault] equal to..." is the card describing this very grant, not a second
  // instance of it — so nothing double-counts here.
  if (dynamic) {
    mergeGrantedKeyword(out, dynamic.keyword, dynamic.value(state, unit, ownerIndex));
  }
  return out;
}

/**
 * Will a unit `playerIndex` is about to play have `keyword` at the moment it
 * ENTERS the board?
 *
 * The question `[Vision]` needs and that `effectiveKeywords` cannot answer: the
 * card is still in hand, so it is on nobody's battlefield and is not yet anyone's
 * "other friendly unit". Vision's trigger condition is the permanent entering the
 * Board, so what matters is whether an aura will be granting it one instant later.
 *
 * Asked by BOTH `legal-actions` (which fans out the recycle choice) and
 * `validate-play-card` (which requires it), so the enumerator and the validator
 * cannot disagree about whether a play needs the choice — the drift that has
 * produced three offered-then-refused bugs in this codebase.
 *
 * **Only unpositioned auras are consulted.** A `scope: "here"` aura would depend
 * on the destination, which is part of the action being built and not settled
 * when this is asked; no Vision aura in this pool is positional, and the
 * assertion below makes a future one a loud failure rather than a silent
 * half-answer.
 */
export function keywordOnEntry(state: GameState, playerIndex: 0 | 1, def: { id: string; keywords?: Partial<Record<Keyword, number>> }, keyword: Keyword): boolean {
  if (def.keywords && keyword in def.keywords) return true;
  for (const [sourceDefId, aura] of Object.entries(KEYWORD_AURAS)) {
    if (!aura.keywords.includes(keyword)) continue;
    if (aura.source === "unit" && aura.scope === "here") {
      throw new Error(
        `keywordOnEntry: ${keyword} is granted by a positional aura (${sourceDefId}), whose reach depends on ` +
          `a destination this question does not carry. See this function's scope note.`,
      );
    }
    // `appliesTo` is deliberately not consulted: it reads the entering unit's
    // INSTANCE (Spirit's Refuge asks whether it is buffed), which does not exist
    // yet.
    //
    // `appliesToDef` IS consulted, and has to be: it reads the printed
    // definition, which does exist here. Without it Forecaster's "your Mechs
    // have [Vision]" would offer the Vision recycle to every unit its
    // controller played, Mech or not — `[Vision]` is entry-triggered, so this is
    // the one place that question gets asked.
    if (aura.appliesToDef !== undefined && !aura.appliesToDef(def)) continue;
    if (aura.source === "gearWearer") {
      // Deliberately NEVER true at entry. This question is asked before the
      // unit exists on the board, so it has no location — and a `"here"` aura
      // is exactly a question about location. `[Ganking]` is not
      // entry-triggered, so nothing is lost; a future entry-triggered keyword
      // from a wearer-positional source would need the destination this
      // function's own scope note already records it does not carry.
      continue;
    }
    if (aura.source === "legend") {
      if (state.players[playerIndex].legend.defId === sourceDefId) return true;
    } else if (aura.source === "gear") {
      if (state.players[playerIndex].activeGear.some((g) => g.defId === sourceDefId)) return true;
    } else if (ownUnitAnywhereExcept(state, playerIndex, sourceDefId)) {
      // No instance exclusion: the card being played is not on the board yet, so
      // it cannot be the source it is asking about. A SECOND Gemcraft Seer played
      // while the first stands is genuinely "another friendly unit" to that first
      // one, and predicts on arrival — which a defId comparison would have refused.
      return true;
    }
  }
  return false;
}

/** Does this unit have `keyword` right now, printed or granted? The question
 *  every caller actually wants to ask. */
export function hasKeyword(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, keyword: Keyword): boolean {
  return keyword in effectiveKeywords(state, unit, ownerIndex);
}

/**
 * `[Deflect N]`: "Opponents must pay N rainbow Power to choose me with a spell or
 * ability." Returns the extra rainbow Power `chooserIndex` must pay to target
 * this unit, or 0.
 *
 * **OPPONENTS.** Measured against the unit's owner, so choosing your own
 * Deflect unit costs nothing — the keyword taxes the enemy, and a caster-blind
 * version would tax you for buffing your own Fiora.
 *
 * **N is a parameter, not a flat pip.** Volibear - Furious prints `[Deflect 2]`
 * and it parses as `{"Deflect": 2}`. An omitted value means 1, which is what
 * `effectiveKeywords` already returns for a granted keyword.
 *
 * Read through `effectiveKeywords`, so a GRANTED Deflect taxes exactly like a
 * printed one — Fiora - Victorious has it only while she is [Mighty], and
 * Spirit's Refuge grants it to buffed units, so the answer genuinely changes as
 * Might and Buffs move. That is also why this is computed on read rather than
 * stored: there is nothing to expire and no way for it to go stale.
 *
 * Pure and target-scoped on purpose. It is the whole reason the cost pipeline
 * has to price PER TARGET rather than once per card, and keeping the arithmetic
 * separate from the payment plumbing means the two can be tested — and got
 * wrong — independently.
 */
export function deflectSurcharge(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, chooserIndex: 0 | 1): number {
  if (chooserIndex === ownerIndex) return 0; // "OPPONENTS must pay"
  return effectiveKeywords(state, unit, ownerIndex)["Deflect"] ?? 0;
}

/**
 * The total `[Deflect]` surcharge a play owes for CHOOSING these units — the one
 * function `legal-actions`, `validate-play-card` and `execute-play-card` all ask,
 * so the enumerator and the validator cannot disagree about the price.
 *
 * Summed per target, because 355 makes each chosen unit a target in its own right
 * and two Deflect units chosen by one spell are two taxes. Ids that name nothing
 * on the board contribute 0 rather than throwing: a target can die between
 * enumeration and validation, and the pricing must not be the thing that explodes.
 *
 * Floating Power deliberately does NOT reduce this. That is the design recorded
 * in docs/rules-conformance.md and it is the conservative reading — it can only
 * make a play cost more, never let one through that should not be — but it is
 * genuinely UNVERIFIED against the rules, which say nothing about whether a
 * rainbow surcharge draws on a floating pool.
 */
/**
 * Every unit a PLAY chooses, across all four fields that can name one — the
 * argument `deflectSurchargeForTargets` wants, built once.
 *
 * **It exists because listing the fields by hand got it wrong.** Both call
 * sites passed `targetUnitInstanceId` and `secondTargetUnitInstanceId` and
 * stopped there, so a spell that chooses through a LIST (Falling Star,
 * Icathian Rain, Fox-Fire) or through a unit-or-gear slot (Fading Memories,
 * Salvage) paid no `[Deflect]` tax at all — measured across the pool: 43 cards
 * taxed, 5 free. A keyword that a card can simply route around is worse than
 * one that is unimplemented, because the unimplemented one is visible.
 *
 * Repeats are KEPT. 355 makes each choice a target in its own right, so a
 * spell naming the same `[Deflect 1]` unit twice owes 2 — which is what
 * `deflectSurchargeForTargets` already does with the list it is handed.
 *
 * A gear named by `targetPermanentInstanceId` contributes 0 without a special
 * case: the lookup finds no unit and skips it.
 */
export function chosenUnitsOfPlay(choice: {
  targetUnitInstanceId?: string;
  secondTargetUnitInstanceId?: string;
  targetUnitInstanceIds?: readonly string[];
  targetPermanentInstanceId?: string;
}): (string | undefined)[] {
  return [
    choice.targetUnitInstanceId,
    choice.secondTargetUnitInstanceId,
    ...(choice.targetUnitInstanceIds ?? []),
    choice.targetPermanentInstanceId,
  ];
}

/**
 * Every unit a `[Repeat]`'s SECOND execution chooses — empty when the additional
 * cost was not paid.
 *
 * **Taxed SEPARATELY from the first execution, and NOT deduplicated against it**
 * — project-owner ruling, 2026-08-06: choosing the same unit in both executions
 * owes the surcharge twice. That is the same reading `chosenUnitsOfPlay` above
 * already applies within one execution ("a spell naming the same `[Deflect 1]`
 * unit twice owes 2"), and it follows from 355 making each choice a target in
 * its own right: 820.1.d puts the additional execution's choices at the same
 * Make Relevant Choices step, so they are choices, so they are taxed.
 *
 * The fallback when `repeatChoices` is absent is the FIRST execution's own
 * choices, because that is what absent MEANS (see RepeatChoices) — so the
 * default repeat doubles the tax rather than escaping it.
 *
 * Mirrors `card-effect-resolution.ts`'s `repeatChoicesOf` exactly — including
 * that `targetPermanentInstanceId` is one of the fields `repeatChoices`
 * REPLACES, so a repeat that switches to a gear-targeting mode is taxed on the
 * gear it actually names rather than on whatever the first execution held. Two
 * spellings of that rule is how the price and the effect would come to disagree
 * about what was chosen.
 */
export function chosenUnitsOfRepeat(action: {
  repeatPaid?: true;
  repeatChoices?: {
    targetUnitInstanceId?: string;
    secondTargetUnitInstanceId?: string;
    targetUnitInstanceIds?: readonly string[];
    targetPermanentInstanceId?: string;
  };
  targetUnitInstanceId?: string;
  secondTargetUnitInstanceId?: string;
  targetUnitInstanceIds?: readonly string[];
  targetPermanentInstanceId?: string;
}): (string | undefined)[] {
  if (!action.repeatPaid) return [];
  const second = action.repeatChoices;
  if (second === undefined) return chosenUnitsOfPlay(action);
  return [
    second.targetUnitInstanceId,
    second.secondTargetUnitInstanceId,
    ...(second.targetUnitInstanceIds ?? []),
    second.targetPermanentInstanceId,
  ];
}

/**
 * The units an ACTIVATED ABILITY chooses.
 *
 * `[Deflect N]` reads "opponents must pay N rainbow Power to choose me with a
 * spell **or ability**", and the ability half was never wired: this module had
 * exactly two callers, both on the PlayCard path, so six activations across
 * four sources chose a Deflect unit for nothing.
 *
 * Its own function rather than a reuse of `chosenUnitsOfPlay`, because an
 * activation names its target through a SMALLER set of fields — there is no
 * second slot and no list — and a shared signature would invite a future
 * PlayCard field to be silently assumed present here too.
 */
export function chosenUnitsOfActivation(choice: {
  targetUnitInstanceId?: string;
  targetPermanentInstanceId?: string;
}): (string | undefined)[] {
  return [choice.targetUnitInstanceId, choice.targetPermanentInstanceId];
}

export function deflectSurchargeForTargets(
  state: GameState,
  chooserIndex: 0 | 1,
  targetInstanceIds: readonly (string | undefined)[],
): number {
  let total = 0;
  for (const id of targetInstanceIds) {
    if (id === undefined) continue;
    const found = findUnitAnywhere(state, id);
    if (!found) continue;
    total += deflectSurcharge(state, found.unit, found.ownerIndex, chooserIndex);
  }
  return total;
}
