import { computeAutoPayment, type Domain, type RunePayment, type RuneCard } from "@rift-engine/engine";

/**
 * What "Auto Pay" should add to a part-built payment.
 *
 * **The bug this exists for: rule 164.2's DOUBLE DUTY.** A Ready rune pays one
 * Energy *and* one Power — "N runes cover any cost with E <= N and P <= N" — and
 * the engine's own `computeAutoPayment` relies on it, returning the SAME rune ids
 * in both buckets. Falling Star at 2 Energy + 2 Fury Power is paid by two Fury
 * runes, listed twice.
 *
 * GameBoard's Auto Pay built its remaining pool as
 * `channeled.filter(r => !alreadyProposed.has(r.id))`, treating the two buckets as
 * one pot — so the moment a player left-clicked two runes for the Energy half (the
 * natural first gesture, since the header asks for Energy first), those runes left
 * the pool and the Power half could never be filled. With a two- or three-rune
 * Fury pool the fill came back `null` and the button **did nothing at all**: no
 * message, no state change, no way to tell a refusal from a dead button.
 *
 * That is the reported symptom exactly — "I have the resources to cast it, but
 * after choosing targets nothing happens, even using Auto Pay". The card was
 * always castable; the board simply could not express the payment.
 *
 * Extracted as a pure function rather than left inline for the reason
 * `target-hint.ts` was: the untested inline version is what let this sit there.
 * It is also why this does NOT re-derive the selection order — it asks
 * `computeAutoPayment` for the whole payment and merges, so the board and the
 * engine can never come to different answers about which runes a cost takes.
 */

/** A rune id list per bucket — what to ADD to what the player already proposed. */
export interface AutoPayFill {
  energyRunes: string[];
  powerRunes: string[];
  /**
   * Runes recycled for a `[Deflect N]` RAINBOW surcharge.
   *
   * **The board had no such bucket at all** — `rainbowRunes` appeared nowhere in
   * this package — so every card the engine taxed was uncastable from the board:
   * the submit gate counted only Energy and Power, decided the payment was
   * complete, sent it, and `validate-play-card` refused it with "must pay 1
   * rainbow Power for [Deflect] on its target, but named 0". Nothing rendered the
   * refusal, so the card simply un-armed.
   */
  rainbowRunes: string[];
}

/**
 * The runes to add so `proposed` reaches `required`, or `null` when the pool
 * genuinely cannot cover it.
 *
 * `required` is the enumerated action's own payment — the engine's answer for
 * this exact card and cost variant — so this never has to know what a card costs.
 *
 * **Per BUCKET, never per pot.** A rune already proposed for Energy is still
 * available for Power and vice versa; only a rune already in the SAME bucket is
 * excluded, because that bucket is a list of what pays that half.
 */
export function autoPayFill(
  channeled: readonly RuneCard[],
  proposed: RunePayment,
  required: RunePayment,
  powerDomain: Domain | null,
  powerDomainAlt?: Domain,
): AutoPayFill | null {
  const energyOwed = required.energyRunes.length - proposed.energyRunes.length;
  const powerOwed = required.powerRunes.length - proposed.powerRunes.length;
  const rainbowRequired = required.rainbowRunes ?? [];
  const rainbowOwed = rainbowRequired.length - (proposed.rainbowRunes ?? []).length;
  if (energyOwed <= 0 && powerOwed <= 0 && rainbowOwed <= 0) return null;

  // The engine's own answer for the WHOLE cost, from the WHOLE pool — including
  // whatever double duty it wants to use, and the surcharge, which deliberately
  // gets NO double duty. Asked fresh rather than reusing `required`, because
  // `required` is one enumerated variant and the player may have already claimed
  // runes it did not pick.
  const whole = computeAutoPayment(
    channeled,
    required.energyRunes.length,
    required.powerRunes.length,
    powerDomain,
    powerDomainAlt,
    rainbowRequired.length,
  );
  if (!whole) return null;

  // Take from the engine's answer whatever is still owed in each bucket, skipping
  // ids the player has already put in THAT bucket. A rune the player claimed for
  // Energy is deliberately still eligible here for Power.
  const take = (from: readonly string[], already: readonly string[], owed: number): string[] => {
    if (owed <= 0) return [];
    const have = new Set(already);
    return from.filter((id) => !have.has(id)).slice(0, owed);
  };

  const energyRunes = take(whole.energyRunes, proposed.energyRunes, energyOwed);
  const powerRunes = take(whole.powerRunes, proposed.powerRunes, powerOwed);

  // The engine's answer may not contain enough ids the player has not already
  // claimed in that bucket — a manual pick outside its selection. Top up from the
  // pool itself, on each bucket's own eligibility rule: Energy needs a READY rune
  // (415), Power needs one matching the card's domain in any state, since a Power
  // cost is paid by recycling (416).
  if (energyRunes.length < energyOwed) {
    const claimed = new Set([...proposed.energyRunes, ...energyRunes]);
    for (const rune of channeled) {
      if (energyRunes.length >= energyOwed) break;
      if (rune.state !== "Ready" || claimed.has(rune.id)) continue;
      energyRunes.push(rune.id);
      claimed.add(rune.id);
    }
  }
  if (powerRunes.length < powerOwed) {
    const claimed = new Set([...proposed.powerRunes, ...powerRunes]);
    for (const rune of channeled) {
      if (powerRunes.length >= powerOwed) break;
      if (claimed.has(rune.id)) continue;
      if (!matchesDomain(rune, powerDomain, powerDomainAlt)) continue;
      powerRunes.push(rune.id);
      claimed.add(rune.id);
    }
  }

  // The `[Deflect]` surcharge, and it is the ONE bucket that gets no double duty:
  // 164.2's "one rune, one Energy and one Power" is about paying YOUR cost, and a
  // tax handed to an opponent refunds nothing — `validate-play-card` refuses a
  // rune that appears in both. So this excludes everything spent on the card's own
  // cost, proposed or filled, which is exactly what `computeAutoPayment` does.
  const rainbowRunes: string[] = [];
  if (rainbowOwed > 0) {
    const spent = new Set([
      ...proposed.energyRunes,
      ...proposed.powerRunes,
      ...(proposed.rainbowRunes ?? []),
      ...energyRunes,
      ...powerRunes,
    ]);
    for (const id of whole.rainbowRunes ?? []) {
      if (rainbowRunes.length >= rainbowOwed) break;
      if (spent.has(id)) continue;
      rainbowRunes.push(id);
      spent.add(id);
    }
    // Top up from the pool on the surcharge's own rule: ANY domain, any state,
    // because a Power cost is paid by recycling (416) and rainbow means rainbow.
    for (const rune of channeled) {
      if (rainbowRunes.length >= rainbowOwed) break;
      if (spent.has(rune.id)) continue;
      rainbowRunes.push(rune.id);
      spent.add(rune.id);
    }
  }

  // Still short means the pool really cannot pay it, which is a legitimate answer
  // — but it must never be the answer merely because a bucket was double-counted.
  if (energyRunes.length < energyOwed || powerRunes.length < powerOwed) return null;
  if (rainbowRunes.length < rainbowOwed) return null;
  return { energyRunes, powerRunes, rainbowRunes };
}

/** A local copy of the domain test, deliberately narrow: the engine's own
 *  `matchesPowerDomain` treats a null domain as matching everything, which is
 *  what a rainbow cost wants and is exactly the top-up rule here. */
function matchesDomain(rune: RuneCard, powerDomain: Domain | null, powerDomainAlt?: Domain): boolean {
  if (powerDomain === null) return true;
  return rune.domain === powerDomain || (powerDomainAlt !== undefined && rune.domain === powerDomainAlt);
}
