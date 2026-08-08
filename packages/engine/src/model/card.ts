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
   * (rule 710), which persists across turns until it is spent or the unit
   * leaves play (rule 709).
   *
   * A boolean rather than a count because rule 707 is explicit: "There can only
   * be one Buff on a Unit at a time", and 708 says a second one "is not placed
   * instead". Eight cards in the pool read the buffed state back ("While I'm
   * buffed…", "spend a buff…", "Other buffed friendly units…"), which is why it
   * has to be real state rather than folded into mightThisTurn.
   */
  buffed: boolean;
  /**
   * Buffs BEYOND the first — Lee Sin - Ascetic's "I can have any number of buffs".
   *
   * A separate count rather than turning `buffed` into a number, and that is what
   * keeps the change contained: rule 708 makes a second buff on an ordinary unit a
   * no-op, so every other card in the pool is a boolean question ("is it buffed")
   * and every reader of `buffed` — Sett - Kingpin's count, Lee Sin - Centered's
   * aura, Wildclaw Shaman's cost, `spendBuff` — keeps working untouched. Only
   * `effectiveMight` adds this, and only the one card ever raises it.
   *
   * Spending a buff (705) takes the extras first and clears `buffed` only when the
   * last one goes, which is what "any number of buffs" means when one is spent.
   */
  extraBuffs?: number;
  /**
   * Stunned — rule 422's Stun section.
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
   * Keywords this gear carries. Present so a keyword can be GRANTED to it at
   * runtime — Fading Memories gives "a unit at a battlefield **or a gear**"
   * [Temporary], and without this the gear half of that card had nowhere to
   * write the result. Gear in this pool prints no keywords of its own, so this
   * starts empty for every one of them.
   */
  keywords: Partial<Record<Keyword, number>>;
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
        keywords: {},
      };
  }
}
