import { describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { GameExitControls } from "../src/components/GameExitControls.js";
import { MulliganScreen } from "../src/components/MulliganScreen.js";
import { BattlefieldSelect } from "../src/components/BattlefieldSelect.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * **The two ways out of a match, and the confirm that stands in front of them.**
 *
 * Reported by the project owner: *"I want to be able to restart the game or
 * leave to main menu."* Both actions existed and neither was reachable until the
 * match was already over — `onMainMenu` was wired only into `RematchPanel` (game
 * over) and `SeriesPanel` (between games of a Best of 3). A player who started a
 * match was trapped in it, and so was one sitting on either pregame screen.
 *
 * The component is tiny and the reason it has its own file is that the CONFIRM is
 * the part that matters: it is all that stands between a misclick on a header
 * button and a discarded match, and it is shared by three screens, so a
 * regression in it is a regression everywhere at once.
 */

const setup = () => {
  const onRestart = vi.fn();
  const onMainMenu = vi.fn();
  const view = render(<GameExitControls onRestart={onRestart} onMainMenu={onMainMenu} />);
  return { onRestart, onMainMenu, view };
};

describe("both exits are offered", () => {
  it("shows Restart and Main Menu", () => {
    setup();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeDefined();
    cleanup();
  });
});

describe("neither fires without a confirmation", () => {
  it("Restart asks first and does NOTHING yet", () => {
    const { onRestart, onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(onRestart, "the match restarted on the first click").not.toHaveBeenCalled();
    expect(onMainMenu).not.toHaveBeenCalled();
    // The prompt has to SAY what is lost — a bare "Confirm?" is what makes a
    // player click through without reading.
    expect(screen.getByText(/Restart the match\?.*This game will be lost\./)).toBeDefined();
    cleanup();
  });

  it("Main Menu asks first and does NOTHING yet", () => {
    const { onRestart, onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));

    expect(onMainMenu, "the match was abandoned on the first click").not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(screen.getByText(/Leave to the main menu\?.*This game will be lost\./)).toBeDefined();
    cleanup();
  });
});

describe("confirming fires the RIGHT one", () => {
  it("Restart → Restart calls onRestart only", () => {
    const { onRestart, onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    // The confirm button carries the same word, so this finds the one that is
    // now inside the prompt — there is only one at a time.
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onMainMenu, "confirming a restart also left to the menu").not.toHaveBeenCalled();
    cleanup();
  });

  it("Main Menu → Main Menu calls onMainMenu only", () => {
    const { onRestart, onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));

    expect(onMainMenu).toHaveBeenCalledTimes(1);
    expect(onRestart, "leaving to the menu also restarted the match").not.toHaveBeenCalled();
    cleanup();
  });
});

describe("cancelling backs out completely", () => {
  it("fires nothing and returns to the two buttons", () => {
    const { onRestart, onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRestart).not.toHaveBeenCalled();
    expect(onMainMenu).not.toHaveBeenCalled();
    // Back to the resting state, not stuck mid-prompt.
    expect(screen.getByRole("button", { name: "Restart" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeDefined();
    expect(screen.queryByText(/This game will be lost/), "the prompt survived Cancel").toBeNull();
    cleanup();
  });

  it("and the NEXT confirm still works — cancelling does not disarm it", () => {
    const { onMainMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));

    expect(onMainMenu).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("the prompt does not survive the action", () => {
  it("clears itself when the restart is confirmed", () => {
    // `onRestart` keeps this component MOUNTED — the board rebuilds around it —
    // so a confirm state left set would greet the fresh match already asking to
    // abandon it.
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    expect(screen.queryByText(/This game will be lost/), "the new match opened mid-prompt").toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeDefined();
    cleanup();
  });
});

describe("the two prompts are distinguishable", () => {
  it("names which action is being confirmed", () => {
    // A shared "Are you sure?" would let a player confirm the wrong one. The two
    // sentences differ, and this is what says so.
    const { view } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const restartPrompt = view.container.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));

    expect(view.container.textContent, "both actions show the same prompt").not.toBe(restartPrompt);
    cleanup();
  });
});

/**
 * **The controls must actually be RENDERED on the pregame screens**, not merely
 * accepted as a prop.
 *
 * This repo's most repeated web failure is a mechanism that is correct, tested
 * and unreachable — nothing that drives `submit` can see whether a human has
 * anything to click. A slot the screen accepts and drops would pass every test
 * above and leave a player just as trapped as before.
 *
 * `GameBoard` itself is deliberately not driven here: it builds its own game
 * from a `MatchConfig` and cannot be handed a prepared state, so a render test
 * against it measures nothing. Its header takes the same `exitControls` value
 * these two do, from the same variable.
 */
describe("the pregame screens render the slot", () => {
  const sentinel = <button>SENTINEL EXIT</button>;

  it("MulliganScreen shows it", () => {
    render(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <MulliganScreen hand={[]} humanGoesFirst onConfirm={() => {}} exitControls={sentinel} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );
    expect(screen.getByRole("button", { name: "SENTINEL EXIT" }), "the mulligan screen dropped the exits").toBeDefined();
    cleanup();
  });

  it("BattlefieldSelect shows it", () => {
    render(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <BattlefieldSelect names={["A", "B", "C"]} used={[]} seriesNote="" onSelect={() => {}} exitControls={sentinel} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );
    expect(screen.getByRole("button", { name: "SENTINEL EXIT" }), "the battlefield chooser dropped the exits").toBeDefined();
    cleanup();
  });
});
