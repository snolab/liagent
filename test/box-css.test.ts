import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { wheelScrolls } from "../src/box.ts";

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
  it("links in a line take clicks (the log is pointer-events: none)", () => {
    expect(src).toContain(".text a { pointer-events: auto;");
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
  it("lets the host size the log (--liagent-log-max, --liagent-log-max-wide)", () => {
    expect(src).toMatch(/\.column \{\s*max-height: var\(--liagent-log-max, 4\.4rem\)/);
    expect(src).toContain(".column.wide { max-height: var(--liagent-log-max-wide, 30vh); }");
  });
  it("history takes the wheel while in use; at its end the page scrolls", () => {
    expect(src).toContain(
      ".box:focus-within .column, .box.on .column, .box.typing .column { pointer-events: auto; }",
    );
    expect(src).toContain(".log li { pointer-events: auto; }");
  });
  it("the input keeps the wheel only while it can still scroll", () => {
    const el = (top: number) => ({ scrollTop: top, scrollHeight: 200, clientHeight: 100 });
    expect(wheelScrolls(el(0), -10)).toBe(false);
    expect(wheelScrolls(el(0), 10)).toBe(true);
    expect(wheelScrolls(el(100), 10)).toBe(false);
    expect(wheelScrolls(el(50), -10)).toBe(true);
    expect(wheelScrolls({ scrollTop: 0, scrollHeight: 40, clientHeight: 40 }, 10)).toBe(false);
  });
});
