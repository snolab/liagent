import { describe, expect, it } from "bun:test";
import { RETIRED_SETTINGS, isQuiet, silenceFor } from "../src/speak-rules.ts";

describe("which lines are read aloud", () => {
  it("a quiet line is never read, visible page or not", () => {
    expect(silenceFor({ quiet: true }, { hidden: false })).toBe("quiet");
    expect(silenceFor({ quiet: true }, { hidden: true })).toBe("quiet");
  });

  it("a hidden page never speaks", () => {
    expect(silenceFor({}, { hidden: true })).toBe("hidden");
  });

  it("any other line is read, at any time of day", () => {
    expect(silenceFor({}, { hidden: false })).toBeNull();
    // An old `loud` means nothing.
    expect(silenceFor({ loud: true } as object, { hidden: false })).toBeNull();
  });

  it("counts only boolean true as quiet", () => {
    for (const v of ["true", 1, false, null, {}, [true]]) {
      expect(isQuiet({ quiet: v })).toBe(false);
      expect(silenceFor({ quiet: v }, { hidden: false })).toBeNull();
    }
  });

  it("lists the retired quiet-hours setting for the box to remove", () => {
    expect(RETIRED_SETTINGS).toContain("quiet-hours");
  });
});
