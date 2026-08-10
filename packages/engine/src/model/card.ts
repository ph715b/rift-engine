import type { Domain } from "./domain.js";
import type { Keyword } from "./keyword.js";
import type { CardDefinition } from "./card-definition.js";

/**
 * A live copy of a card in a game — as opposed to `CardDefinition`, the
 * static printed-card data it was created from. Mirrors model/Card.java's
 * sealed class hierarchy, reshaped as a discriminated union on `kind`.
 *
 * `instanceId` is unique per physical copy in the game (two "Daring Poro"
 * copies in the same deck are different CardInstances sharing one
 * `defId`); Java gives every `Card` its own `UUID id` for the same reason.
 *
 * Only the runtime fields actually exercised so far are included — Java's
 * Card.Unit additionally mutates `preventValue`/`movesThisTurn`/
 * `udyrOptionsChosenThisTurn`/`temporaryKeywordBonus`/`buffCount`
 * (model/Card.java:73-91), each added for a specific later mechanic
 * (Prevent, movement, buffs). Add them here when that mechanic lands.
 */
export interface CardInstanceBase {
  instanceId: string;
  defId: string;
  name: string;
  domains: Domain[];
  exhausted: boolean;
  isToken: boolean;
}

export interface LegendInstance extends CardInstanceBase {
  kind: "Legend";
  championTag: string;
}

export interface UnitInstance extends CardInstanceBase {
  kind: "Unit";
  energyCost: number;
  powerCost: number;
  /** Which domain a nonzero powerCost must be paid in — null whenever
   *  powerCost is 0. Needed at runtime (not just on CardDefinition) so
   *  auto-payment logic (legalActions/computeAutoPayment) can pick correctly
   *  domain-matching runes without a registry lookup. */
  powerDomain: Domain | null;
  /** A hardcoded second domain that can ALSO pay this card's Power cost —
   *  see CardDefinitionBase.powerDomainAlt. Absent for every card except a
   *  confirmed handful of genuinely hybrid-pip ones (e.g. Tibbers). */
  powerDomainAlt?: Domain;
  might: number;
  isChampion: boolean;
  keywords: Partial<Record<Keyword, number>>;
  isReaction: boolean;
  tags: string[];
  damage: number;
  /**
   * Might granted or removed for the current turn only — turn-manager.ts's
   * runEnd resets it to 0 unconditionally, for every unit, both players.
   * "Give a unit +2 Might this turn" and "give a unit -4 Might this turn" both
   * land here.
   *
   * Was called `bonus`, which made it indistinguishable from a Buff. They are
   * different game objects: this expires at end of turn and stacks freely, a
   * Buff does neither. Renaming it is what let `buffed` exist below without
   * one silently overwriting the other.
   */
  mightThisTurn: number;
  /**
   * Whether this unit carries a Buff — a counter placed on it, worth +1 Might
   * (rule 705), which persists across turns until it is spent or the unit
   * leaves play (rule 705).
   *
   * A boolean rather than a count because rule 702.3 is explicit: "There can only
   * be one Buff on a Unit at a time", and 702.3.a says a second one "is not placed
   * instead". Eight cards in the pool read the buffed state back ("While I'm
   * buffed…", "spend a buff…", "Other buffed friendly units…"), which is why it
   * has to be real state rather than folded into mightThisTurn.
   */
  buffed: boolean;
  /**
   * Buffs BEYOND the first — Lee Sin - Ascetic's "I can have any number of buffs".
   *
   * A separate count rather than turning `buffed` into a number, and that is what
   * keeps the change contained: rule 702.3.a makes a second buff on an ordinary unit a
   * no-op, so every other card in the pool is a boolean question ("is it buffed")
   * and every reader of `buffed` — Sett - Kingpin's count, Lee Sin - Centered's
   * aura, Wildclaw Shaman's cost, `spendBuff` — keeps working untouched. Only
   * `effectiveMight` adds this, and only the one card ever raises it.
   *
   * Spending a buff (702.2.b) takes the extras first and clears `buffed` only when the
   * last one goes, which is what "any number of buffs" means when one is spent.
   */
  extraBuffs?: number;
  /**
   * Stunned — rule 423's Stun section.
   *
   * A binary state, deliberately, because the rules say so outright: "Stunned is
   * a binary state. A Unit is Stunned or it isn't", and "a Stunned Unit can not
   * be Stunned again". A counter would let a card that checks "is it stunned"
   * (Solari Shrine, Solari Chief) disagree with one that stuns it.
   *
   * What it does is narrower than it sounds, and the two halves are separate:
   * a stunned unit "does not contribute its might to damage in the combat damage
   * step", but "must still have damage applied to it equal to, or greater than,
   * its full might value to be killed" — so it hits for nothing and is no easier
   * to kill. Lost during end-of-turn cleanup step 3d.
   */
  stunned: boolean;
  /**
   * Keywords granted to this unit for the current turn only — Udyr's "Give me
   * [Ganking] this turn". Cleared by runEnd alongside `mightThisTurn`, which is
   * the same idea one level up: a this-turn ADDITION rather than a change to
   * what the card prints.
   *
   * Separate from `keywords` because those are printed and permanent, and from
   * granted-keywords.ts's conditional grants because those are re-derived from
   * board state every time they are asked — this one is a fact that happened,
   * and stays true for the turn even if the condition that caused it is gone.
   *
   * The Java oracle carries a field of the same shape on Card.Unit
   * (`temporaryKeywordBonus`), which model/card.ts's own note said to add when
   * the mechanic that needs it lands.
   */
  keywordsThisTurn: Partial<Record<Keyword, number>>;
  /**
   * TRIGGERED ABILITIES granted to this unit for the current turn — Relentless
   * Pursuit's "This turn, that unit has 'When I conquer, you may move me to my
   * base.'"
   *
   * The pool's first grant of an ABILITY rather than of a keyword or a number,
   * and it is a sibling of `keywordsThisTurn` rather than an extension of it:
   * that field holds keywords, and a keyword is a name the rules already define,
   * where this holds a key into the event-trigger registry. Sharing one field
   * would mean `effectiveKeywords` had to know which of its entries were not
   * keywords at all.
   *
   * Each entry is a registry key, so the granted ability is written exactly where
   * a printed one is and resolves through the same path — `holdEventTrigger`
   * matches these alongside `card.defId`, and stamps the granted key onto the
   * chain entry so `resolvePendingTrigger` finds the same definition.
   *
   * Optional so every existing unit construction site is unaffected, and swept by
   * `runEnd` alongside `keywordsThisTurn` for the reason that one is: "this turn"
   * state has to expire with the turn.
   */
  grantedTriggersThisTurn?: readonly string[];
  /**
   * Who this unit goes back to at end of turn — Hostile Takeover's "Lose control
   * of that unit and recall it at end of turn."
   *
   * **Control in this engine IS which player's list a unit sits in**, the model
   * `takeControlOfUnit` records and docs/rules-conformance.md carries a row for.
   * That makes a stolen unit indistinguishable from an owned one, which is
   * exactly right for Possession — it steals permanently — and is precisely what
   * a card that gives the unit BACK cannot live with. This field is the memory
   * that model lacks, and it is deliberately the only thing added: control stays
   * list membership, and this says where the unit came from.
   *
   * On the UNIT rather than on either player, so it travels with the thing it is
   * about: a stolen unit that dies takes the obligation with it into the trash,
   * where a per-player list would keep an entry pointing at nothing.
   *
   * Cleared by `runEnd` as the unit is handed back. Optional, so every unit that
   * was never stolen is unaffected — absent means "this is mine".
   */
  returnControlAtEndOfTurnToIndex?: 0 | 1;
  /**
   * Which modes of this unit's own activated ability it has already used this
   * turn — Udyr's "Choose one you've not chosen this turn".
   *
   * On the UNIT, not the player: two Udyrs each get their own four choices,
   * which a per-player list would silently merge. Java tracks it the same way
   * and under nearly the same name (`udyrOptionsChosenThisTurn`).
   */
  abilityModesUsedThisTurn: string[];
  /**
   * How many times this unit has moved this turn.
   *
   * A COUNT, not a boolean. Miss Fortune - Captain reads "the FIRST time I move
   * each turn", which a boolean answered; Yasuo - Windrider reads "the THIRD
   * time I move in a turn" and Kayn - Unleashed reads "if I have moved twice",
   * which it cannot. This file's own comment already named the counter as the
   * field to add when a card needed it.
   *
   * Per-unit for the same reason `abilityModesUsedThisTurn` is — a per-player
   * flag would let one unit's move spend another's allowance — and cleared by
   * runEnd alongside it.
   */
  movesThisTurn: number;
}

export interface SpellInstance extends CardInstanceBase {
  kind: "Spell";
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  powerDomainAlt?: Domain;
  isReaction: boolean;
  /** The printed `[Action]` keyword. Read it through `timing.timingTierOf`, not
   *  directly: `[Reaction]` grants all of Action's permissions (rule 813) but
   *  the loader only sets this from the literal printed text, so a
   *  Reaction-only card such as Gust has `isReaction: true, isAction: false`.
   *  Testing this flag alone would bar all 8 Reaction spells from Showdowns. */
  isAction: boolean;
}

export interface GearInstance extends CardInstanceBase {
  kind: "Gear";
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  powerDomainAlt?: Domain;
  attachedToInstanceId: string | null;
  /**
   * Was this gear attached to its current wearer THIS TURN? Brutalizer's
   * art-only "if this was attached to me this turn, I have an additional +2
   * Might" — the only card that asks.
   *
   * A flag rather than a turn number, and that is load-bearing: `turnNumber`
   * counts ROUNDS (`turn-manager.runEnd` bumps it only when play wraps to the
   * first player), so both players' turns share one and a gear attached on your
   * turn would still read as fresh on the opponent's.
   *
   * Written by `attachEquipment` and cleared by `detachEquipment` — the two
   * single writers of `attachedToInstanceId`, so no attach source can set one
   * without the other — and swept for BOTH players at `runEnd`, like every other
   * "this turn" state in this engine.
   *
   * Optional so every existing gear construction site is unaffected; absent
   * reads as "not fresh", which is the conservative answer.
   */
  attachedThisTurn?: true;
  /**
   * Units banished **with this gear** — The Zero Drive's "play all units
   * banished with this".
   *
   * The pool's first banish that remembers its SOURCE, and the source lives on
   * the gear rather than beside the banished card for two reasons. The list IS a
   * property of this gear ("with THIS", compared by instance, so two Zero Drives
   * keep two lists), and it needs no cleanup: a gear that leaves takes its list
   * with it, where a per-player map keyed by gear id would outlive its gear.
   *
   * It survives the gear's own banishment intact, which is what makes the card
   * work at all — "Banish this" is the ability's COST, so by the time the effect
   * resolves the gear is in `PlayerState.banished` and this list is the only
   * record of what to bring back.
   *
   * Optional so every existing gear construction site is unaffected; absent
   * reads as "nothing banished with it", which is true of all thirty other Gear.
   */
  banishedInstanceIds?: readonly string[];
  /**
   * This gear is BORROWED — Akshan - Mischievous' "move an enemy gear to your
   * base. You control it until I leave the board."
   *
   * Control of a gear is `activeGear` membership, the same model units use, so
   * taking it IS moving it between the two lists. What that model cannot express
   * on its own is an expiry, and this is it: whose it was, and which permanent's
   * presence the loan depends on.
   *
   * A `whileInPlayInstanceId` rather than a duration, because the card names a
   * permanent and not a turn — Akshan can be killed the instant he arrives, or
   * hold the gear for the rest of the game. `equipment.returnLapsedGearControl`
   * checks it every Cleanup, which is the one hook that runs after every resolved
   * action in both `submit` and the AI's lookahead.
   *
   * Distinct from `UnitInstance.returnControlAtEndOfTurnToIndex`, which is Hostile
   * Takeover's, and deliberately not merged with it: one expires on a clock and
   * the other on a body, and a shared field would have to carry both and be read
   * by two sweeps that agree about neither.
   *
   * Optional, so every gear that was never borrowed is unaffected.
   */
  borrowedControl?: { fromIndex: 0 | 1; whileInPlayInstanceId: string };
  /**
   * Keywords this gear carries — PRINTED as well as granted.
   *
   * **This said "Gear in this pool prints no keywords of its own, so this starts
   * empty for every one of them", and it was false when written.** Long Sword
   * (SFD-022) prints `[Quick-Draw]`, and Unleashed adds Gear printing
   * `[Temporary]` and `[Deathknell]`. `createCardInstance` hardcoded `{}` on the
   * strength of that sentence, so every printed Gear keyword was dropped between
   * the definition and the instance — reported from playtesting as "unable to
   * play longsword during a combat even though it has [Quick-Draw]".
   *
   * Populated from the definition now. Safe to pass straight through because
   * `card-loader` already strips what the bracket parser gets wrong
   * (`GRANTED_ONLY_KEYWORDS`, `CONDITIONAL_KEYWORD_DEF_IDS`, the `[Temporary]`
   * false positives) — so a definition's keywords are the cleaned set, not the
   * raw parse.
   */
  keywords: Partial<Record<Keyword, number>>;
  /**
   * Printed `[Reaction]`, which for Gear comes from `[Quick-Draw]`'s reminder
   * text ("This has [Reaction]").
   *
   * `timingTierOf` tests `"isReaction" in card`, and its own comment anticipated
   * this exactly — "adding it to Gear later then needs no change here". It was
   * right; the field simply never arrived, so every Quick-Draw Gear read as
   * Default tier and could not be played in a Showdown.
   */
  isReaction?: boolean;
}

export type CardInstance = LegendInstance | UnitInstance | SpellInstance | GearInstance;

/**
 * The PRINTED Power cost of any card instance — 0 for a Legend, which is the
 * one member of the union that has no such field.
 *
 * A Legend is never played and so never reaches the `cardPlayed` event this was
 * written for; 0 is nonetheless the honest answer rather than a throw, because
 * "does this card cost [rainbow][rainbow] or more" has a correct answer for a
 * Legend and it is "no".
 *
 * An accessor rather than a `powerCost` on `CardInstanceBase`: putting it on the
 * base would give `LegendInstance` a cost field that means nothing, and the
 * three cost-paying paths would then all have to remember not to read it.
 */
export function powerCostOf(card: CardInstance): number {
  return card.kind === "Legend" ? 0 : card.powerCost;
}

let instanceCounter = 0;
/** Deterministic id generator (no crypto/UUID dependency) — fine for now since
 *  nothing depends on instance ids being unguessable, only unique per game. */
function nextInstanceId(): string {
  instanceCounter += 1;
  return `card-${instanceCounter}`;
}

/** Instantiates a fresh, zone-less live copy from a definition. Mirrors CardRegistry.fromDef/create. */
export function createCardInstance(def: CardDefinition): CardInstance {
  const base = {
    instanceId: nextInstanceId(),
    defId: def.id,
    name: def.name,
    domains: def.domains,
    exhausted: false,
    isToken: false,
  };

  switch (def.type) {
    case "Legend":
      return { ...base, kind: "Legend", championTag: def.championTag };
    case "Unit":
      return {
        ...base,
        kind: "Unit",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        ...(def.powerDomainAlt !== undefined ? { powerDomainAlt: def.powerDomainAlt } : {}),
        might: def.might,
        isChampion: def.isChampion,
        keywords: def.keywords,
        isReaction: def.isReaction,
        tags: def.tags,
        damage: 0,
        mightThisTurn: 0,
        buffed: false,
        stunned: false,
        keywordsThisTurn: {},
        abilityModesUsedThisTurn: [],
        movesThisTurn: 0,
      };
    case "Spell":
      return {
        ...base,
        kind: "Spell",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        ...(def.powerDomainAlt !== undefined ? { powerDomainAlt: def.powerDomainAlt } : {}),
        isReaction: def.isReaction,
        // Was silently dropped here, which is why printed [Action] could never
        // be checked at runtime: the definition carried it, a PlayCardAction
        // carries the INSTANCE, and the instance didn't have it.
        isAction: def.isAction,
      };
    case "Gear":
      return {
        ...base,
        kind: "Gear",
        energyCost: def.energyCost,
        powerCost: def.powerCost,
        powerDomain: def.powerDomain,
        ...(def.powerDomainAlt !== undefined ? { powerDomainAlt: def.powerDomainAlt } : {}),
        attachedToInstanceId: null,
        // From the DEFINITION, not `{}`. See the field docs — the hardcoded empty
        // object dropped every printed Gear keyword, and `[Quick-Draw]`'s
        // `[Reaction]` with it.
        keywords: def.keywords,
        isReaction: def.isReaction,
      };
  }
}
