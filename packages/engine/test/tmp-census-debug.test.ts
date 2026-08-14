import { describe, it } from "vitest";
import { eventTriggerDefIds } from "../src/engine/triggers.js";
import fs from "node:fs";

describe("debug", () => {
  it("dumps", () => {
    fs.writeFileSync(`${process.env.TEMP}/evkeys.txt`, eventTriggerDefIds().sort().join("\n"));
    console.log("written", eventTriggerDefIds().length);
  });
});
