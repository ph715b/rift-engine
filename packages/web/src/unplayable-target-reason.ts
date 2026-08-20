import {
  counterFilter,
  counterableSpells,
  eligibleTargets,
  type CardInstance,
  type GameState,
  type TargetScope,
  type TargetingSpec,
} from "@rift-engine/engine";

/**
 * Why a card the player can afford still has nothing to point at.
 *
 * **Extracted from `GameBoard`'s `unplayableReason` so it can be tested against
 * a real board**, which is the shape `target-hint.ts` already uses and the
 * lesson a previous playtest round left: the DOM-presence tests written for
 * these messages asserted that *some* text rendered, never that it said
 * anything true.
 *
 * Every branch reads the SPEC. Two of them used to assert one card's wording
 * instead, and both were wrong for most of the cards they spoke for — see
 * `whereClause` and the `chainSpellAndUnit` case.
 */
export function targetingBlockedReason(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  targeting: TargetingSpec,
): string {
  switch (targeting.kind) {
    case "unit": {
      const who = ownerWord(targeting.owner);
      const might = targeting.maxMight !== undefined ? `with ${targeting.maxMight} Might or less ` : "";
      return `${card.name} needs a ${who}unit ${might}${whereClause(targeting.scope)} to target — there isn't one.`;
    }
    case "unitSlots": {
      // Only reachable for a mandatory-target card: a `min: 0` spec is always
      // satisfiable (the empty choice is legal), so it never lands here — see
      // `hasAnyLegalEffectChoice`.
      const roles = targeting.slots.join(" + ");
      return `${card.name} needs ${targeting.min} units to target (${roles}) — the board doesn't have them.`;
    }
    case "battlefield":
      return `${card.name} needs a battlefield to target.`;
    case "ownTrashCard":
      return `${card.name} needs a ${targeting.cardKind ?? "card"} in your trash — you have none there.`;
    case "chainSpellAndUnit":
      return chainSpellAndUnitReason(state, playerIndex, card, targeting);
    default:
      return `${card.name} can't be played right now.`;
  }
}

/**
 * How a targeting spec's SCOPE reads in a sentence.
 *
 * **The board used to write "at a battlefield" into every one of these
 * messages**, and `scope: "anywhere"` is the commoner spelling — so a card that
 * can perfectly well reach a unit in a base was telling the player it could not,
 * sending them to look for a problem that was not there.
 *
 * 355.9.a.1 is the rule the wide scope implements ("'Unit,' 'gear,' and 'rune'
 * refer to objects on the Board unless specified otherwise") and **198.1** is
 * what puts the Bases on the Board.
 */
export function whereClause(scope: TargetScope | undefined): string {
  if (scope === "anywhere") return "on the board";
  if (scope === "base") return "in a base";
  return "at a battlefield";
}

function ownerWord(owner: "friendly" | "enemy" | undefined): string {
  return owner === "friendly" ? "friendly " : owner === "enemy" ? "enemy " : "";
}

/**
 * Repulse's and Riposte's kind — a spell on the chain AND a unit, both announced.
 *
 * **Which half is missing is asked of the ENGINE.** This message used to name
 * both halves unconditionally and describe the unit one as "a unit to BUFF",
 * which is Riposte's text asserted for every card of the kind. Repulse COUNTERS
 * on behalf of its unit and buffs nothing, so a player holding a Repulse — with
 * a spell on the chain and a friendly unit on the board — was told it needed the
 * two things they could see they had.
 *
 * **Reported from playtesting**: "cant cast repulse in response to opponent
 * targeting my unit with starcrossed". The engine was right and stayed right
 * through the repro: Star-Crossed's targets are `scope: "anywhere"`, so it
 * reaches a unit in your BASE (355.9.a.1), while Repulse prints "a friendly unit
 * AT A BATTLEFIELD" (355.9.b, the narrowing half). A base unit is genuinely not
 * protectable. The message is what made a correct refusal unreadable.
 */
function chainSpellAndUnitReason(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  targeting: Extract<TargetingSpec, { kind: "chainSpellAndUnit" }>,
): string {
  const who = ownerWord(targeting.owner);
  const where = whereClause(targeting.scope);
  const spells = counterableSpells(
    state,
    targeting.maxPrintedEnergy,
    targeting.maxPrintedPower,
    counterFilter(targeting, playerIndex),
  );
  const units = eligibleTargets(state, playerIndex, targeting.owner, targeting.scope);

  if (spells.length === 0 && units.length === 0) {
    return `${card.name} needs a spell it can counter and a ${who}unit ${where} — you have neither.`;
  }
  if (spells.length === 0) return `${card.name} needs a spell on the chain that it can counter — there isn't one.`;
  if (units.length === 0) return `${card.name} needs a ${who}unit ${where} — you have none there.`;
  // Both halves exist separately and no PAIR of them is legal. For Repulse that
  // is its printed restriction: the spell must choose that unit and no other
  // friendly one — which is the case a player is most likely to mistake for a
  // bug, because everything on screen looks eligible.
  return (
    `${card.name} has a spell and a unit to choose, but no legal pairing — ` +
    `it only counters a spell that chooses one of your units ${where} and no other.`
  );
}
