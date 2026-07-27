import type { Domain } from "@rift-engine/engine";

/**
 * A starting color association per domain, not a claim of official game
 * colors — used to give runes/power costs a quick visual identity at a
 * glance. Easy to swap later if it doesn't match the real cards' palette.
 */
export const DOMAIN_COLORS: Record<Domain, string> = {
  Fury: "#e0524a",
  Calm: "#4a90c4",
  Mind: "#9a6fd1",
  Body: "#5cb85c",
  Chaos: "#e0a83f",
  Order: "#e8e4d0",
  Colorless: "#8a8a8a",
};
