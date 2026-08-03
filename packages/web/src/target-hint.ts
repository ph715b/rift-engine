import { targetingForAnyCard, type CardInstance } from "@rift-engine/engine";

/**
 * What the header tells a player who has armed a card that wants a LIST of
 * targets (Falling Star, Icathian Rain, Fox-Fire, Bullet Time).
 *
 * **There was no such line at all**, and that is the whole bug a playtest
 * reported as "not sure how targeting works with this card — it doesn't seem to
 * cast". Every other targeting step has a hint; `unitList` fell through the
 * switch to `default: return null`. So the player clicked a unit, nothing said a
 * second was needed, and clicking the same unit again changed nothing they could
 * see — the count lives in the Done button's label, which is not where you look
 * when you think you have already finished.
 *
 * GameBoard's own comment two cases above says exactly why this matters: "an
 * ability that silently waits for a click is indistinguishable from one that did
 * nothing."
 *
 * Extracted as a pure function rather than left inline so it can be tested
 * without mounting the board — the untested inline switch is what let a missing
 * case go unnoticed.
 */
export function listTargetHint(card: CardInstance, chosenCount: number): string {
  const targeting = targetingForAnyCard(card);
  if (targeting.kind !== "unitList") return ` — choose targets for ${card.name}`;

  // "The same unit may be chosen more than once" is the half the player asked
  // about outright. It is a real rule (the Repeat/Rocket Barrage example: the
  // same target may fill both choices provided you say which is which), and it
  // is invisible from the board, because a unit already picked looks picked.
  const duplicates = targeting.allowsDuplicates ? ", the same unit more than once if you like" : "";

  // A fixed-size list (Falling Star's two, Icathian Rain's six) counts DOWN to a
  // known total; an "any number" list (Fox-Fire) can only report how many so far
  // and point at Done.
  if (targeting.max !== undefined && targeting.max === targeting.min) {
    return ` — choose ${targeting.max} units for ${card.name}${duplicates}  [${chosenCount}/${targeting.max}]`;
  }
  const cap = targeting.max === undefined ? "any number of" : `up to ${targeting.max}`;
  return ` — choose ${cap} units for ${card.name}${duplicates}, then press Done  [${chosenCount} chosen]`;
}
