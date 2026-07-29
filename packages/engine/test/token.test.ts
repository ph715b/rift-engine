import { describe, expect, it } from "vitest";
import { createRecruitToken } from "../src/engine/token.js";

describe("createRecruitToken", () => {
  it("builds a well-formed 1-Might token, never touching the card registry", () => {
    const token = createRecruitToken();
    expect(token.isToken).toBe(true);
    expect(token.kind).toBe("Unit");
    expect(token.might).toBe(1);
    expect(token.energyCost).toBe(0);
    expect(token.powerCost).toBe(0);
    expect(token.name).toBe("Recruit");
    expect(token.exhausted).toBe(true); // no card in scope grants "tokens enter ready"
  });

  it("gives every token a distinct instanceId", () => {
    const a = createRecruitToken();
    const b = createRecruitToken();
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});
