import type { PlayCardAction } from "@rift-engine/engine";

/**
 * **The fields a from-hidden play's pending state must start with — every field
 * the candidates UNANIMOUSLY agree on.**
 *
 * # The bug this exists to end
 *
 * Reported from playtesting: *"tideturner doesn't seem to be working. Tideturner
 * was hidden at a bf, i click it and the target at the other battlefield then hit
 * pass focus, but the tideturner does not switch places."*
 *
 * The engine was correct — measured before anything was changed: played from
 * hidden with a partner at another battlefield, the swap happens exactly as
 * printed. The board never submitted the play.
 *
 * `playHiddenCard` seeded its pending state with `{ card, payment,
 * fromHiddenBattlefieldId }` and nothing else. But **811.1.d.1 forces a hidden
 * PERMANENT to be played to the battlefield it was hidden at**, so every
 * enumerated candidate carries `destinationBattlefieldId`. `matchesPending`
 * compares that field with `?? BASE_ZONE_ID` on both sides, so it was asking
 * `"bf1" === "base"` — no candidate ever matched, `pendingLegalAction()` stayed
 * undefined, and the auto-submit never fired. The card sat armed, and Pass Focus
 * then did exactly what it says.
 *
 * **The two halves of the board disagreed about an unset destination, and each
 * was locally right.** `unitNeedsPlacement` asks whether the candidates offer
 * MORE THAN ONE destination and answers no — 811.1.d.1 forces exactly one, so
 * there is genuinely nothing to ask, and `pendingStep()` correctly never returns
 * `"placement"`. `matchesPending` then compares the field anyway, because for
 * every other card an unset destination really does mean base. So the step
 * machine said "nothing to choose" and the matcher said "you have not chosen",
 * and nothing in between set it.
 *
 * **It only bites a hidden UNIT with a real choice.** A hidden Spell has no
 * destination, so both sides are undefined and match; a hidden card with exactly
 * one candidate takes `playHiddenCard`'s play-it-outright path and never builds a
 * pending state at all. Hidden + permanent + something to choose is the corner,
 * and Tideturner is the card in the pool that lands in it.
 *
 * # Why UNANIMITY rather than adding one field
 *
 * `GameBoard`'s own comment records this as the SIXTH time a dispatch hop dropped
 * a field, and lists the previous ones by name. Adding `destinationBattlefieldId`
 * to the seed would fix Tideturner and leave the seventh to be found in play.
 *
 * A field every candidate agrees on is, by definition, not a choice — the player
 * has nothing to decide about it, so the seed can and must carry it. A field they
 * DISAGREE on is exactly what the pending-play flow exists to ask about, and must
 * be left out. That rule is derived from the candidate list rather than written
 * as a list of field names, so a field added to `PlayCardAction` later is carried
 * automatically.
 *
 * `card` and `payment` are excluded because the caller sets them from the first
 * candidate directly, and `type`/`playerIndex` because they are not choices.
 */

/** Fields that are never a player choice, so unanimity over them means nothing. */
const NOT_A_CHOICE = new Set(["type", "playerIndex", "card", "payment"]);

/**
 * Every field on which all `candidates` agree, as a partial action to spread into
 * the pending play. An empty list yields `{}`.
 *
 * Compared by JSON rather than by `===` so an array-valued field
 * (`targetUnitInstanceIds`) is judged by its contents; those are enumerated in a
 * stable order by `legal-actions`, so two candidates that agree really do
 * stringify alike.
 */
export function unanimousPlayFields(candidates: readonly PlayCardAction[]): Partial<PlayCardAction> {
  const [first, ...rest] = candidates;
  if (!first) return {};

  const agreed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    if (NOT_A_CHOICE.has(key) || value === undefined) continue;
    const encoded = JSON.stringify(value);
    // `key in c` matters as much as the value: a field PRESENT on one candidate
    // and ABSENT on another is a choice ("aim it, or don't"), and treating
    // undefined as agreement would seed a decision the player never made.
    if (rest.every((c) => JSON.stringify((c as unknown as Record<string, unknown>)[key]) === encoded)) {
      agreed[key] = value;
    }
  }
  return agreed as Partial<PlayCardAction>;
}
