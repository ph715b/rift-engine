/**
 * Cards that `reachability.ts` reports as never exercised, WITH A REASON, and
 * which are therefore not a backlog item.
 *
 * # What counts as a reason
 *
 * Two things, and nothing else:
 *
 *  - **A structural AI limitation.** `evaluate` scores board state at 1 ply, so a
 *    card whose whole value is information (Sabotage, Stacked Deck) or a future
 *    turn can only ever tie with Pass. `abilityBanksResource` drops the resource
 *    abilities from the candidate pool ON PURPOSE. No weight fixes these — see
 *    the `ai-ab-harness` measurements. Such a card is verified by unit tests, and
 *    saying so here is the honest outcome rather than a fix.
 *  - **A blind spot in the observer**, of the two kinds `exercise-log.ts`
 *    documents: a continuous effect (a `mightBonus` read during a calculation
 *    produces no action, no Chain item and no event) and `beginningPhase`, which
 *    is still resolved inline and so never reaches `pendingTriggers`.
 *
 * **"We did not get to it" is not a reason** — that is the backlog this file
 * exists to keep honest, and `docs/engine-readiness-for-unleashed.md` says so in
 * the Phase 4 gate.
 *
 * # A stale entry FAILS the gate
 *
 * If a card listed here turns up exercised, `reachability` goes red and names it.
 * That is deliberate: this repo's most repeated failure is a note written about
 * the engine as it was that day which nothing ever re-reads —
 * `PARTIALLY_IMPLEMENTED`, the Divergent table's "Controller vs owner" row, and
 * the drifted copies of the verification loop are all the same shape. An
 * allowlist is exactly that shape, so it is wired to a gate from the first entry.
 *
 * Same for an entry naming a defId that is not in the registry at all.
 */
export const UNEXERCISED_ALLOWLIST: Readonly<Record<string, string>> = {
  // ---------------------------------------------------------------------------
  // Observer blind spots. All five were read against the CODE on 2026-08-07
  // rather than taken from `exercise-log.ts`'s header — which named three of them
  // and is the kind of note this repo has found stale ten times out of eleven.
  // Each names the file and the mechanism, so the next reader can re-check it in
  // one grep instead of trusting this line.
  // ---------------------------------------------------------------------------

  "OGN-251":
    "Jinx - Loose Cannon: `onBeginningPhase` in engine/legend-abilities.ts. beginningPhase is the one " +
    "held-trigger conversion deliberately left undone (holding it would resolve Beginning-Phase abilities " +
    "after scoreHolds), so it resolves INLINE and never reaches pendingTriggers where scanChain could see " +
    "it. Unmeasurable here, not untested — test/legend-activation.test.ts.",

  "OGS-019":
    "Master Yi - Wuju Bladesman: `mightBonus` in engine/legend-abilities.ts — a continuous effect read " +
    "during a Might calculation. No action, no Chain item, no event, so there is nothing for any of the " +
    "three signals to record. Covered by test/legend-abilities.test.ts.",

  "SFD-181":
    "Rumble - Mechanized Menace: a continuous keyword grant ('your Mechs have [Shield]') in " +
    "engine/granted-keywords.ts. Same shape as OGS-019 — read during a calculation, never an event. " +
    "Covered by test/legend-keyword-aura.test.ts.",

  "SFD-183":
    "Lucian - Purifier: a continuous keyword grant ('your Equipment each give [Assault]') in " +
    "engine/equipment.ts. Same shape as OGS-019. Covered by test/lucian-purifier.test.ts.",

  // **Master Yi - Wuju Master, all THREE printings, added 2026-08-14** when UNL
  // joined `COMPLETE_SETS` and this gate started holding the set. He is the fifth
  // entry of the same family and the clearest of them: BOTH his clauses are
  // continuous, so there is no moment for any of the three signals to record.
  //
  // The three printings are listed separately rather than collapsed to the
  // canonical id, because `reachability`'s alias rule excuses an alternate
  // printing only when the CANONICAL one was exercised — and his never is, by
  // construction. Collapsing them here would make this file quietly depend on
  // that rule and stop naming what it is excusing.
  "UNL-191":
    "Master Yi - Wuju Master: BOTH clauses are continuous, so nothing about him is ever an action, a " +
    "Chain item or an event. '[Level 6][>] Your units have +1 [Might]' is a `mightModifiers` entry read " +
    "during a Might calculation (engine/effects/signature-calm.ts), the same shape as OGS-019 one entry " +
    "up; '[Level 11][>] Your units enter ready' is a deploy-time replacement in engine/deploy.ts, which " +
    "produces a READY unit rather than a readying. Covered by test/level-enters-ready.test.ts and " +
    "test/unl-signature-calm-wave6.test.ts.",

  "UNL-231":
    "Master Yi - Wuju Master (Overnumbered): the same registry entry as UNL-191 via mergeRegistries, and " +
    "so the same blind spot. It cannot be excused by reachability's alias rule, because that rule needs " +
    "the canonical printing to have been exercised and this one never can be.",

  "UNL-231*":
    "Master Yi - Wuju Master (Signature): as UNL-231.",

  // ---------------------------------------------------------------------------
  // Reachable, but priced out of the format. Measured, not assumed.
  // ---------------------------------------------------------------------------

  // **OGN-158 Volibear - Imposing LEFT this list on 2026-08-11, and his entry
  // predicted it.** It read: "It clears this list on its own at GAMES=500, which
  // is why the allowlist gate is asserted only at the pinned depth." The pinned
  // depth became 500 that day, and the very next run reported his excuse stale.
  //
  // He was excused for being priced out — 12 Energy + 2 Power in a pool whose
  // median is 3, measured affordable in 2 states out of 1000 games — which was
  // true of the sample rather than of the card. Twice the games found the states.
  // Worth keeping as a note: an allowlist entry is a claim about what a
  // measurement can SEE, and changing the measurement is what expires it.

  // ---------------------------------------------------------------------------
  // Not a blind spot — a condition self-play has never satisfied.
  // ---------------------------------------------------------------------------

  // **OGS-023 Garen - Might of Demacia LEFT this list on 2026-08-14, and his
  // entry predicted the mechanism while naming the wrong agent.** It read:
  // "'when you conquer, if you have 4+ units at that battlefield, draw 2'... its
  // `conquerCondition` has not come up in 500 games per mode. This one is a
  // DECK/scenario gap, not an engine or observer one, and it would be closed by a
  // deck built to mass units rather than by any change to the card."
  //
  // It was closed by a change to neither the deck nor the card: `legal-actions`
  // learned 144.3's simultaneous multi-unit move, so the AI can now put four
  // units on one battlefield in a single action instead of four. The condition
  // was never rare in the FORMAT — it was rare in the action space the AI had.
  //
  // Two entries have now expired this way (see OGN-158 above), and both say the
  // same thing: **an allowlist entry is a claim about what the measurement can
  // SEE, and it expires when the measurement changes, not when the card does.**
  // Read every remaining excuse below as depth- and enumerator-dependent.
};
