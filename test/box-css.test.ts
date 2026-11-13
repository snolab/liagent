import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// `font: 16px/1.35 inherit` is invalid (inherit cannot be mixed into the shorthand), so browsers
// dropped the whole declaration: the textarea fell back to 13.33px and iOS zoomed in on focus.
const src = readFileSync(new URL("../src/box.ts", import.meta.url), "utf8");

describe("box CSS", () => {
  it("has no font shorthand mixed with inherit", () => {
    expect(src).not.toMatch(
      /font:\s*[^;`]*\binherit\b[^;`]*\S\s+inherit|font:\s*\d[^;`]*\binherit\b/,
    );
  });
  it("gives the text inputs a 16px font (no iOS focus zoom)", () => {
    expect((src.match(/font-size: 16px;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("exposes the bar: part=bar and --liagent-bar-radius-top/-bottom", () => {
    expect(src).toContain('<div class="bar" id="bar" part="bar">');
    expect(src).toContain(
      "border-radius: var(--liagent-bar-radius-top, var(--bar-r)) var(--liagent-bar-radius-top, var(--bar-r)) var(--liagent-bar-radius-bottom, var(--bar-r)) var(--liagent-bar-radius-bottom, var(--bar-r));",
    );
  });
  it("reflects open/minimized on the host ([open] / [min])", () => {
    expect(src).toContain('this.toggleAttribute("open", this.open);');
    expect(src).toContain('this.toggleAttribute("min", !this.open);');
  });
});
