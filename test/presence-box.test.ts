import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ChatBox } from "../src/box.ts";
import { emptyPresence } from "../src/presence.ts";
import type { PresenceMember } from "../src/protocol.ts";

/** Just enough DOM for the presence strip: text, attributes, children, events. */
class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  props: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  hidden = false;
  title = "";
  tabIndex = -1;
  type = "";
  src = "";
  alt = "";
  referrerPolicy = "";
  decoding = "";
  className = "";
  private text = "";
  innerHTMLSet = false;
  style = { setProperty: (k: string, v: string) => void (this.props[k] = v) };
  classList = {
    toggle: (c: string, on: boolean) => {
      const s = new Set(this.className.split(" ").filter(Boolean));
      if (on) s.add(c);
      else s.delete(c);
      this.className = [...s].join(" ");
    },
  };
  constructor(public tag: string) {}
  set innerHTML(_v: string) {
    this.innerHTMLSet = true;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  append(...c: El[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: El[]) {
    this.text = "";
    this.children = [...c];
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  fire(t: string, e: unknown = {}) {
    for (const f of this.listeners[t] ?? []) f(e);
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
  querySelector(sel: string): El | null {
    const [tag, cls] = sel.split(".");
    for (const c of this.children) {
      if (c.tag === tag && c.className.split(" ").includes(cls!)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  all(cls: string): El[] {
    return this.children.flatMap((c) => [
      ...(c.className.split(" ").includes(cls) ? [c] : []),
      ...c.all(cls),
    ]);
  }
}

let saved: unknown;
beforeAll(() => {
  saved = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { createElement: (t: string) => new El(t) };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

const proto = ChatBox.prototype as unknown as Record<
  "presenceAvatar" | "presenceRow" | "renderPresence",
  (...a: unknown[]) => unknown
>;
const u = (id: string, label = id): PresenceMember => ({ id, kind: "user", label });

function fakeBox(members: PresenceMember[], self = "me") {
  const box = {
    els: { presence: new El("div"), plist: new El("div") },
    _presence: { ...emptyPresence("/"), members },
    _self: self,
    _presenceHover: false,
    panel: "none",
    ui: { presenceHere: "Also here" },
    presenceAvatar: proto.presenceAvatar,
    presenceRow: proto.presenceRow,
    renderPresence: proto.renderPresence,
    setPanel(p: string) {
      box.panel = p;
      box.renderPresence();
    },
  };
  box.renderPresence();
  return box;
}

describe("box presence strip", () => {
  it("hidden when only the user is here", () => {
    const b = fakeBox([u("me")]);
    expect(b.els.presence.hidden).toBe(true);
  });
  it("3 stacked, no number; 5 others: 3 + '+2'; aria-label lists everyone", () => {
    const three = fakeBox([u("me"), u("a"), u("b"), u("c")]);
    const btn3 = three.els.presence.querySelector("button.pstack")!;
    expect(btn3.all("pav").length).toBe(3);
    expect(btn3.all("pmore").length).toBe(0);
    const five = fakeBox([u("me"), u("a"), u("b"), u("c"), u("d"), u("e")]);
    const btn = five.els.presence.querySelector("button.pstack")!;
    expect(btn.all("pav").length).toBe(3);
    expect(btn.all("pmore")[0]!.textContent).toBe("+2");
    expect(btn.attrs["aria-label"]).toBe("Also here: a, b, c, d, e");
  });
  it("hover or focus expands a preview of up to 8; leaving collapses it", () => {
    const b = fakeBox([u("me"), ...Array.from({ length: 12 }, (_, i) => u(`m${i}`))]);
    const peek = b.els.presence.querySelector("ul.ppeek")!;
    expect(peek.hidden).toBe(true);
    b.els.presence.fire("pointerenter");
    expect(b._presenceHover).toBe(true);
    expect(peek.hidden).toBe(false);
    expect(peek.children.length).toBe(8);
    b.els.presence.fire("pointerleave");
    expect(peek.hidden).toBe(true);
    b.els.presence.fire("focusin");
    expect(peek.hidden).toBe(false);
  });
  it("a click opens the whole list as a menu, the preview closes", () => {
    const b = fakeBox([u("me"), ...Array.from({ length: 12 }, (_, i) => u(`m${i}`))]);
    b.els.presence.querySelector("button.pstack")!.fire("click");
    expect(b.panel).toBe("presence");
    expect(b.els.plist.hidden).toBe(false);
    expect(b.els.plist.all("prow").length).toBe(12);
    expect(b.els.presence.querySelector("button.pstack")!.attrs["aria-expanded"]).toBe("true");
  });
  it("names stay text; agents show [lane@host] and a lane badge; bad avatars fall back", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const b = fakeBox([
      u("me"),
      { id: "x", kind: "user", label: evil, avatar: "javascript:alert(1)" },
      { id: "y", kind: "agent", label: "writer@devbox", lane: "writer", host: "devbox" },
    ]);
    b.els.presence.fire("pointerenter");
    const rows = b.els.presence.querySelector("ul.ppeek")!.children;
    expect(rows[0]!.textContent).toBe(`${evil[0]!.toUpperCase()}${evil}`);
    expect(rows[1]!.textContent).toBe("WR[writer@devbox]");
    const anyHtml = (e: El): boolean => e.innerHTMLSet || e.children.some(anyHtml);
    expect(anyHtml(b.els.presence)).toBe(false);
    expect(b.els.presence.all("pav").some((a) => a.children.some((c) => c.tag === "img"))).toBe(
      false,
    );
  });
});
