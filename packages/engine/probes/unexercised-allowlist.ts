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
export const UNEXERCISED_ALLOWLIST: Readonly<Record<string, string>> = {};
