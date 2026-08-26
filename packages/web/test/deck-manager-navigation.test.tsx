import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/App.js";

/**
 * **"Manage Decks" is a screen, and getting back out of it must not strand you.**
 *
 * Asked for in playtesting: *"can you also add a manage decks button, the new
 * deck button can probably [be] moved into there"*.
 *
 * The lobby's "Your deck" zone had been answering two unrelated questions at
 * once — which deck am I playing this match, and what is in my library — with
 * six controls of which one was about the match. The library moved to its own
 * screen.
 *
 * # What is actually worth testing here
 *
 * Not that buttons render. **The RETURN PATHS**, because the manager is reachable
 * from two places and the builder is reachable from three, and a wrong `returnTo`
 * does not throw, does not fail a type check, and does not look wrong in a
 * screenshot — it silently drops the player one screen from where they started.
 *
 * The hard case is the round trip: menu → manager → builder → manager → back.
 * The manager has to be handed its OWN return target through the builder, or the
 * manager it returns to thinks it came from the menu when it came from the lobby.
 */

const clickButton = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));
const hasButton = (name: RegExp | string) => screen.queryByRole("button", { name }) !== null;

beforeEach(() => {
  // A clean library each time — the manager reads `localStorage` on mount, and a
  // deck left behind by a previous test would change which rows render.
  localStorage.clear();
});
afterEach(cleanup);

describe("reaching the deck manager", () => {
  it("the main menu offers Manage Decks instead of Build a Deck", () => {
    render(<App />);
    expect(hasButton(/manage decks/i), "no way into the library from the menu").toBe(true);
    expect(hasButton(/build a deck/i), "the old direct-to-builder button is still there").toBe(false);
  });

  it("opens the library, with New deck inside it", () => {
    render(<App />);
    clickButton(/manage decks/i);

    expect(screen.getByRole("heading", { name: /manage decks/i })).toBeTruthy();
    expect(hasButton(/new deck/i), "the New deck button did not move into the manager").toBe(true);
  });

  it("is also reachable from the lobby, which no longer builds or imports inline", () => {
    render(<App />);
    clickButton(/new game/i);

    expect(hasButton(/manage decks/i), "the lobby has no door to the library").toBe(true);
    expect(hasButton(/build a deck/i), "the lobby still builds inline").toBe(false);
  });
});

describe("the return paths", () => {
  it("menu → manager → back lands on the MENU", () => {
    render(<App />);
    clickButton(/manage decks/i);
    clickButton(/^back$/i);

    expect(hasButton(/new game/i), "Back from the manager did not reach the menu").toBe(true);
  });

  it("lobby → manager → back lands on the LOBBY, not the menu", () => {
    // The whole reason the manager carries a `returnTo`. Dropping a player at
    // the title screen because they checked their decks mid-setup would lose the
    // match they were configuring.
    render(<App />);
    clickButton(/new game/i);
    clickButton(/manage decks/i);
    clickButton(/^back$/i);

    expect(screen.queryByRole("heading", { name: /manage decks/i }), "still in the manager").toBeNull();
    expect(hasButton(/manage decks/i), "Back did not return to the lobby").toBe(true);
    expect(hasButton(/new game/i), "Back went all the way to the menu").toBe(false);
  });

  it("menu → manager → New deck → Back returns to the MANAGER", () => {
    // Not to the menu. The builder was opened from the library, so leaving it
    // belongs back in the library. (The builder labels its exit "Back", not
    // "Cancel" — same button, and the manager's own Back is the NEXT step.)
    render(<App />);
    clickButton(/manage decks/i);
    clickButton(/new deck/i);
    clickButton(/^back$/i);

    expect(screen.getByRole("heading", { name: /manage decks/i }), "leaving the builder skipped the manager").toBeTruthy();
  });

  it("lobby → manager → New deck → Back → Back lands on the LOBBY", () => {
    // **The round trip, and the one a naive `returnTo` gets wrong.** The manager
    // has to be handed its own return target through the builder; without that
    // it comes back believing it was opened from the menu, and this last Back
    // strands the player at the title screen.
    render(<App />);
    clickButton(/new game/i);
    clickButton(/manage decks/i);
    clickButton(/new deck/i);
    clickButton(/^back$/i);
    expect(screen.getByRole("heading", { name: /manage decks/i }), "leaving the builder skipped the manager").toBeTruthy();

    clickButton(/^back$/i);
    expect(hasButton(/manage decks/i), "did not return to the lobby").toBe(true);
    expect(hasButton(/new game/i), "the return path lost a step and reached the menu").toBe(false);
  });
});
