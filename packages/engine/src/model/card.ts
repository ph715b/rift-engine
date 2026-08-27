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

export interface LegendInstance extends CardInstanceBase, EmpowerableInstance {
  kind: "Legend";
  championTag: string;
  /**
   * Cards banished WITH THIS LEGEND — UNL-181 Jhin - Virtuoso's "if there are
   * four spells banished with me".
   *
   * The same field, meaning the same thing, that `GearInstance` already carries
   * for The Zero Drive, and it exists here for the same reason it exists there:
   * `PlayerState.banished` is ONE flat list, and every other writer of it
   * (Arcane Shift, Void Rush, Time Warp) would poison a count taken from it.
   * "With me" is an attachment, and this is where the attachment lives.
   *
   * Ids, not copies — the cards really are in `PlayerState.banished`, and
   * duplicating them would make anything counting the banish zone see them twice.
   *
   * Optional so every existing legend construction site is unaffected; absent
   * reads as "nothing banished with me", which is true of every other Legend.
   */
  banishedInstanceIds?: readonly string[];
}

export interface UnitInstance extends CardInstanceBase, EmpowerableInstance {
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
   * This unit's base Might, REPLACED for the current turn — Dragon Form
   * (VEN-116): "Choose a unit. Its base Might becomes 5 this turn."
   *
   * **A different LAYER from `mightThisTurn` above, not a different amount.**
   * 477.1.a.1 puts "assignment of Might" in layer 1 (Trait-Altering) and quotes
   * this exact sentence as its worked example — "A spell reads 'A unit's Might
   * becomes 4 this turn.' The unit's Might is set to 4 in this layer" — while
   * 477.3 puts arithmetic in layer 3. So this replaces the printed `might` and
   * every other source still adds ON TOP of the new figure: a 5 set here, plus a
   * buff, plus an aura, plus `[Assault]`, is 5 + all of them.
   *
   * That ordering is the whole card. Setting it as a delta instead would make
   * Dragon Form a pump on a big unit and a shrink on nothing, where the printed
   * card is a leveller that turns a 1-Might token into a 5 and a 7-Might
   * champion into a 5.
   *
   * Optional, and absent means "use the printed Might" — the ordinary case for
   * every unit in the pool. `undefined` rather than a sentinel number because
   * **0 is a legal assignment**: a card setting a unit's base Might to 0 must be
   * distinguishable from one that set nothing.
   *
   * Swept by runEnd with `mightThisTurn`, and DELETED rather than zeroed, for the
   * reason `grantedTriggersThisTurn` records: `exactOptionalPropertyTypes` makes
   * an absent key a different type from a present one, and absent is what every
   * untouched unit carries.
   */
  baseMightThisTurn?: number;
  /**
   * The spell name THIS unit has named — Fallen Feline (VEN-132): "When you play
   * me, name a spell. While I'm at a battlefield, opponents can't play spells
   * with that name."
   *
   * **On the INSTANCE rather than in a `GameState` record keyed by instanceId**,
   * which is the shape the neighbouring "this turn" fields take. Two reasons, and
   * both are about the second copy:
   *
   *   - Two Fallen Felines name INDEPENDENTLY, and each ban is that unit's. A
   *     per-player field would have to be a list anyway, and a list keyed by
   *     instanceId is this field with extra steps and a cleanup problem.
   *   - The name has to DIE WITH THE UNIT. "While I'm at a battlefield" is a
   *     CONTINUOUS ability, not a fact about the turn the way Brynhir's and
   *     Lilting Lullaby's bans are — those are armed on resolution and survive
   *     her death deliberately. This one must lift the instant she is killed, and
   *     a field on the instance is deleted by the very act of her leaving play,
   *     with nothing to remember to sweep.
   *
   * Survives across turns and travels with her between battlefields: nothing in
   * the printed text expires, and the ban is asked of WHERE she is standing when
   * a spell is played, not of where she was standing when she named.
   *
   * Optional, and absent means "she has not named yet" — a real state rather than
   * just the ordinary case for other units, since her question can sit parked
   * behind another, and a Feline who has not named bans nothing. Absent rather
   * than `""` for the reason `baseMightThisTurn` gives: `exactOptionalPropertyTypes`
   * makes an absent key a different type from a present one.
   */
  namedSpell?: string;
  /**
   * "It can't be chosen by enemy spells and abilities THIS TURN" — Twilight
   * Shroud (VEN-031).
   *
   * **A per-INSTANCE, per-TURN flag, which is a third shape for a prohibition
   * this engine already had two of.** `UNCHOOSEABLE_BY_ENEMIES` is keyed by defId
   * (Ruin Runner, Baron Nashor, Master Yi - Unstoppable) and answers a question
   * about a CARD; Alpha Wildclaw's is an aura over other units. Neither can say
   * "this one, until the turn ends", because the subject is a body rather than a
   * printing and the reason expires.
   *
   * Read by `unitChooseableBy`, the one predicate the enumerator, the validator
   * and `hasAnyLegalEffectChoice` all go through, so a shrouded unit disappears
   * from every offer at once rather than being refused after a click.
   *
   * Swept by `runEnd` with the other this-turn state, and DELETED rather than set
   * false, for the reason `baseMightThisTurn` records: `exactOptionalPropertyTypes`
   * makes an absent key a different type from a present one, and absent is what
   * every untouched unit carries.
   */
  unchooseableByEnemiesThisTurn?: true;
  /**
   * Has this unit been dealt damage THIS TURN — Affectionate Poro's (VEN-024)
   * "if I haven't been dealt damage this turn".
   *
   * **`damage` cannot answer this, and rule 466 step 3c is why.** Combat ends by
   * healing EVERY unit on the board, so a unit that soaked ten damage in the
   * exchange has `damage: 0` by the time any combat-ended trigger resolves. The
   * fact the card asks about does not survive in the field that looks like it
   * holds it — which is exactly the shape `test/fixtures` warns about for reading
   * combat outcomes through damage rather than through deaths.
   *
   * Written by BOTH damage paths: `dealDamage` for spells and abilities, and
   * `combat.ts`'s own arithmetic for the damage step. A flag rather than a count,
   * because every reader so far asks "any at all".
   *
   * Swept by `runEnd`, and DELETED rather than set false, like its neighbours.
   */
  damagedThisTurn?: true;
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
   * ACTIVATED ABILITIES granted to this unit for the current turn — Dominus'
   * "give it '[rainbow][rainbow]: Ready me.'"
   *
   * A THIRD sibling beside `keywordsThisTurn` and `grantedTriggersThisTurn`, not
   * a widening of either, and the split is the same one that separated the first
   * two: a keyword is a name the rules define, a trigger key is something the
   * engine fires FOR you, and an activated ability is something a player must
   * choose to USE and PAY for. Only the last of the three reaches the action
   * enumerator, so folding it into `grantedTriggersThisTurn` would mean
   * `holdEventTrigger` had to skip entries that are not triggers at all — the
   * exact confusion that field's own note gives for not sharing with keywords.
   *
   * Each entry is a key into the ACTIVATED-ability registry, so the granted
   * ability is written exactly where a printed one is and is offered, priced,
   * validated and executed through the one funnel — `abilitiesAvailableTo`,
   * which its own comment calls "the single answer to what can this source
   * activate".
   *
   * Optional so every existing unit construction site is unaffected, and swept by
   * `runEnd` alongside its two siblings, for the reason they are: "this turn"
   * state has to expire with the turn.
   */
  grantedAbilitiesThisTurn?: readonly string[];
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
  /**
   * Was this unit PRESENT at a battlefield its controller conquered this turn?
   *
   * **383.4.c.2.a is the sentence**: a Unit's Conquer Ability triggers when "the
   * Unit(s) these effects correspond to are present at a Battlefield when a player
   * gains control of it and gains 1 Victory Point from Conquering". That makes
   * conquering a fact about a MOMENT the unit was present for, not about where it
   * happens to stand afterwards.
   *
   * The engine answered it positionally until 2026-08-26 — "am I standing where my
   * controller conquered" — because conquests were recorded only per player. Both
   * halves of that were wrong in play: a unit that conquered and then walked home
   * read as never having conquered (reported from playtesting, Blighted Battleaxe
   * killing its wearer), and one that walked in AFTER the conquest read as having.
   *
   * Cleared with the rest of the per-turn tallies in `turn-manager`.
   */
  conqueredThisTurn?: boolean;
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
  /**
   * `[Flow]`'s alternate cost (829), copied from the definition.
   *
   * Carried on the INSTANCE for the reason the `isAction` note above records
   * having learned the hard way: `replacedCostFor` is handed a `CardInstance`,
   * so a cost that lives only on the definition cannot be checked at the moment
   * the permission is asked for.
   */
  flowCost?: { energy: number; powerCost: number; powerDomain: Domain | null };
}

/**
 * The Empowered status — rule **441**, read against `-raw`.
 *
 * > 441.1.a "Empowered is a binary state. A Game Object is Empowered or it isn't."
 * > 441.1.b "An Empowered Game Object can not be Empowered."
 * > 442.1.a "Disempowering affects only cards that are currently Empowered."
 *
 * **Optional-and-`true` rather than a plain boolean**, matching `isToken` and
 * `powerDomainAlt`'s spelling in this file: an absent field is "not Empowered",
 * so every permanent that predates Vendetta reads correctly with no migration
 * and no per-site default.
 *
 * It is a PER-OBJECT status, which is what separates it from `[Level]`'s
 * superficially identical `[Empowered][>]` clause shape — Level reads one
 * integer on `PlayerState`, so every card a player controls answers it the same
 * way, while two copies of one Empowered unit can disagree.
 */
export type EmpowerableInstance = { empowered?: true };

export interface GearInstance extends CardInstanceBase, EmpowerableInstance {
  kind: "Gear";
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  powerDomainAlt?: Domain;
  /**
   * **`[Quick-Draw]`'s "This has [Reaction]."**
   *
   * The DEFINITION has carried this since Quick-Draw was written — the loader
   * sets it from the keyword's own reminder text — and the INSTANCE dropped it.
   * So a Quick-Draw Gear could not actually be played at Reaction speed:
   * `timing.timingTierOf` shape-tests the instance (`"isReaction" in card`),
   * found no field, tiered it Default, and the board reported *"Long Sword needs
   * [Reaction] to be played while a spell is on the chain."*
   *
   * **The identical loss the `Spell` branch of `createCardInstance` already
   * documents for `isAction`**, one card kind over: "the definition carried it,
   * a PlayCardAction carries the INSTANCE, and the instance didn't have it."
   * `timingTierOf`'s own comment even anticipated the fix — "adding it to Gear
   * later then needs no change here" — and it needed none. Found in playtest,
   * 2026-08-08.
   *
   * Required rather than optional, so a construction site that forgets it is a
   * type error rather than a silently non-Reaction Gear.
   */
  isReaction: boolean;
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
   * The tag this gear was told to remember — UNL-138 The List's "as you play
   * this, NAME A TAG".
   *
   * **A GearInstance had nowhere to write this, and that was the real blocker on
   * that card across two waves.** Its key set is otherwise `CardInstanceBase`'s
   * six plus the cost fields plus `keywords`/`isReaction`/`attachedToInstanceId`,
   * with no generic bag — and every optional field beside this one is likewise a
   * named card's, which is the pattern rather than an exception. A tag is a
   * string chosen from the 111 in the pool, so it is data rather than a flag, and
   * it belongs on the instance that was told it: two Lists name two tags.
   *
   * Optional, so every existing gear construction site is unaffected; absent
   * reads as "no tag named", which is true of the other 90 Gear and which makes
   * The List's ability find NOTHING rather than everything.
   */
  namedTag?: string;
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
        // `[Flow]`, copied for exactly the reason the line above exists.
        ...(def.flowCost !== undefined ? { flowCost: def.flowCost } : {}),
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
