import { describe, expect, it } from "bun:test";
import {
  CTX_ICON,
  cleanCtxView,
  ctxChipEls,
  ctxViewFor,
  defaultCtxView,
  legacyCtxView,
  parseLegacyCtx,
} from "../src/ctx-chip.ts";

/** Just enough DOM: text, attributes, children, click listeners; innerHTML is a trap. */
class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  className = "";
  title = "";
  type = "";
  id = "";
  textContent = "";
  innerHTMLSet = false;
  constructor(public tag: string) {}
  set innerHTML(_v: string) {
    this.innerHTMLSet = true;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  append(...c: El[]) {
    this.children.push(...c);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  click() {
    for (const f of this.listeners.click ?? []) f({ stopPropagation() {} });
  }
}
const doc = { createElement: (t: string) => new El(t) as unknown as HTMLElement };
const all = (e: El): El[] => [e, ...e.children.flatMap(all)];

describe("defaultCtxView", () => {
  it("derives the title from common keys and a key: value detail", () => {
    const v = defaultCtxView({ table: "orders", row: 42, page: "/admin", extra: { a: 1 } });
    expect(v.icon).toBe(CTX_ICON);
    expect(v.title).toBe("orders · #42 · /admin");
    expect(v.detail).toBe('table: orders\nrow: 42\npage: /admin\nextra: {"a":1}');
  });
  it("an explicit title wins", () => {
    expect(defaultCtxView({ title: "Invoice 7", table: "t" }).title).toBe("Invoice 7");
  });
  it("falls back to the key names", () => {
    expect(defaultCtxView({ foo: 1, bar: 2 }).title).toBe("foo, bar");
  });
  it("flattens and clips long values", () => {
    const v = defaultCtxView({ selection: `a\n\nb ${"x".repeat(300)}` });
    expect(v.title.startsWith("a b x")).toBe(true);
    expect([...v.title].length).toBe(80);
    expect(v.title.endsWith("…")).toBe(true);
  });
});

describe("ctxViewFor (custom renderer)", () => {
  const line = { id: "1" };
  it("uses the host's view, passing ctx and the line", () => {
    let seen: unknown;
    const v = ctxViewFor(
      (c, l) => {
        seen = [c, l];
        return { icon: "🧾", title: `Row ${c.row}`, detail: "d" };
      },
      { row: 3 },
      line,
    );
    expect(v).toEqual({ icon: "🧾", title: "Row 3", detail: "d" });
    expect(seen).toEqual([{ row: 3 }, line]);
  });
  it("null, a throw, or a malformed view fall back to the default", () => {
    const def = defaultCtxView({ table: "t" });
    expect(ctxViewFor(() => null, { table: "t" }, line)).toEqual(def);
    expect(
      ctxViewFor(
        () => {
          throw new Error("x");
        },
        { table: "t" },
        line,
      ),
    ).toEqual(def);
    expect(ctxViewFor(() => ({ title: 5 }) as never, { table: "t" }, line)).toEqual(def);
    expect(ctxViewFor(null, { table: "t" }, line)).toEqual(def);
  });
  it("keeps the icon short and the default icon when none", () => {
    expect(cleanCtxView({ icon: "<img src=x onerror=alert(1)>", title: "t" })?.icon).toBe("<im…");
    expect(ctxViewFor(() => ({ title: "t" }), {}, line).icon).toBe(CTX_ICON);
  });
});

describe("parseLegacyCtx (JSON report lines)", () => {
  const LINE =
    '[ctx] {"v":1,"page":"/reports/leads/","record":{"row":"R515","company":"Example Co."}}';
  const CTX = {
    v: 1,
    page: "/reports/leads/",
    record: { row: "R515", company: "Example Co." },
  };
  it("takes a [ctx] line after the text out, as a ctx object", () => {
    const r = parseLegacyCtx(`この会社、電話番号が違う\n${LINE}`);
    expect(r).toEqual({ ctxs: [{ ctx: CTX }], text: "この会社、電話番号が違う" });
    expect(defaultCtxView(CTX).title).toBe("Example Co.");
  });
  it("also before or between text, and quoted", () => {
    expect(parseLegacyCtx(`${LINE}\nhi`)?.text).toBe("hi");
    expect(parseLegacyCtx(`a\n> ${LINE}\nb`)).toEqual({ ctxs: [{ ctx: CTX }], text: "a\nb" });
  });
  it("title falls back record.company → record.row → page", () => {
    expect(defaultCtxView({ page: "/p", record: { row: "R515" } }).title).toBe("R515");
    expect(defaultCtxView({ page: "/p", record: {} }).title).toBe("/p");
  });
  it("a line that is not a JSON object keeps its raw text as the title", () => {
    const r = parseLegacyCtx("x\n[ctx] {broken json\ny");
    expect(r).toEqual({ ctxs: [{ raw: "{broken json" }], text: "x\ny" });
    expect(legacyCtxView("{broken json").title).toBe("{broken json");
    expect(parseLegacyCtx("[ctx] [1,2]")?.ctxs).toEqual([{ raw: "[1,2]" }]);
    expect(parseLegacyCtx(`[ctx] {"a":"${"x".repeat(5000)}"}`)?.ctxs[0]).toHaveProperty("raw");
  });
  it("several [ctx] lines give several chips, in order", () => {
    const r = parseLegacyCtx(`${LINE}\nmsg\n[ctx] {"page":"/b"}`);
    expect(r?.ctxs).toEqual([{ ctx: CTX }, { ctx: { page: "/b" } }]);
    expect(r?.text).toBe("msg");
  });
  it("leaves other lines alone", () => {
    expect(parseLegacyCtx("hello [ctx] x")).toBeNull();
    expect(parseLegacyCtx("[ctxx] x")).toBeNull();
    expect(parseLegacyCtx("[ctx]")).toBeNull();
  });
  it("XSS in JSON values stays text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const r = parseLegacyCtx(
      `hi\n[ctx] {"page":"${evil}","record":{"company":"<script>alert(2)</script>"}}`,
    );
    const c = r!.ctxs[0] as { ctx: Record<string, unknown> };
    const view = defaultCtxView(c.ctx);
    expect(view.title).toBe("<script>alert(2)</script>");
    const els = ctxChipEls(doc, view, true, "m#0", () => {}) as unknown as El[];
    const nodes = els.flatMap(all);
    expect(nodes.some((e) => e.innerHTMLSet)).toBe(false);
    expect(nodes.some((e) => e.textContent.includes(evil))).toBe(true);
  });
});

describe("ctxChipEls", () => {
  it("is a button with part, aria-expanded and a label; closed has no panel", () => {
    let n = 0;
    const [chip, ...rest] = ctxChipEls(doc, { title: "T", detail: "D" }, false, "m1", () => n++);
    const c = chip as unknown as El;
    expect(c.tag).toBe("button");
    expect(c.type).toBe("button"); // Enter/Space activate it natively
    expect(c.attrs.part).toBe("ctx");
    expect(c.attrs["aria-expanded"]).toBe("false");
    expect(c.attrs["aria-label"]).toBe("ctx: T");
    expect(rest).toHaveLength(0);
    c.click();
    expect(n).toBe(1);
  });
  it("open: a panel with part=ctx-detail, linked by aria-controls", () => {
    const [chip, panel] = ctxChipEls(doc, { title: "T", detail: "D" }, true, "a b", () => {});
    const c = chip as unknown as El;
    const p = panel as unknown as El;
    expect(c.attrs["aria-expanded"]).toBe("true");
    expect(p.attrs.part).toBe("ctx-detail");
    expect(c.attrs["aria-controls"]).toBe(p.id);
    expect(p.children.map((x) => x.textContent)).toEqual(["T", "D"]);
  });
  it("renders hostile ctx and hook output as text only", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const view = ctxViewFor(() => ({ icon: evil, title: evil, detail: evil }), { x: evil }, {});
    const els = ctxChipEls(doc, view, true, evil, () => {}) as unknown as El[];
    const nodes = els.flatMap(all);
    expect(nodes.some((e) => e.innerHTMLSet)).toBe(false);
    expect(nodes.map((e) => e.tag).sort()).toEqual(["button", "div", "div", "div", "span"]);
    expect(nodes.some((e) => e.textContent === evil)).toBe(true); // shown literally
    expect(els[1]!.id).toMatch(/^ctx-[\w-]+$/);
    const def = ctxChipEls(
      doc,
      defaultCtxView({ title: evil }),
      true,
      "k",
      () => {},
    ) as unknown as El[];
    expect(def.flatMap(all).some((e) => e.innerHTMLSet)).toBe(false);
  });
});
