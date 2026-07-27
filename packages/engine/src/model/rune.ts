import type { Domain } from "./domain.js";

/**
 * READY   — available; can be exhausted (Energy) or recycled (Power).
 * EXHAUSTED — paid an Energy cost; can still be recycled for Power, but
 *             cannot pay Energy again. Returns to Ready at the pool's next Awaken.
 * Mirrors model/RuneState.java.
 */
export type RuneCardState = "Ready" | "Exhausted";

/** A single rune in a player's 12-card rune deck / channeled pool. Mirrors model/RuneCard.java. */
export interface RuneCard {
  id: string;
  domain: Domain;
  state: RuneCardState;
}
