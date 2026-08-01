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
   * Has this unit already moved this turn? Miss Fortune - Captain reads "the
   * FIRST time I move each turn", which needs a per-unit memory: a per-player
   * flag would let one unit's move spend another's allowance.
   *
   * On the unit for the same reason `abilityModesUsedThisTurn` is, and cleared
   * by runEnd alongside it.
   */
  movedThisTurn: boolean;
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
   * Keywords this gear carries. Present so a keyword can be GRANTED to it at
   * runtime — Fading Memories gives "a unit at a battlefield **or a gear**"
   * [Temporary], and without this the gear half of that card had nowhere to
   * write the result. Gear in this pool prints no keywords of its own, so this
   * starts empty for every one of them.
   */
  keywords: Partial<Record<Keyword, number>>;
}

export type CardInstance = LegendInstance | UnitInstance | SpellInstance | GearInstance;

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
        movedThisTurn: false,
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
