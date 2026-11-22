// Just enough of the DOM for the box's renderLog to run under bun test: no
// layout, no events, no selectors beyond tag[data-x] and .class.
type Child = FakeEl | FakeText;

export class FakeText {
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
  cloneNode() {
    return new FakeText(this.data);
  }
}

export class FakeEl {
  children: Child[] = [];
  parent?: FakeEl;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  props: Record<string, string> = {};
  style = {
    setProperty: (k: string, v: string) => void (this.props[k] = v),
    getPropertyValue: (k: string) => this.props[k] ?? "",
  } as Record<string, unknown>;
  private cls = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.cls.delete(x)),
    contains: (c: string) => this.cls.has(c),
    toggle: (c: string, on = !this.cls.has(c)) => (on ? this.cls.add(c) : this.cls.delete(c), on),
  };
  [k: string]: unknown;
  constructor(public tagName: string) {}
  get className() {
    return [...this.cls].join(" ");
  }
  set className(v: string) {
    this.cls = new Set(v.split(/\s+/).filter(Boolean));
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = v ? [new FakeText(v)] : [];
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  toggleAttribute(k: string, on = !this.attrs.has(k)) {
    if (on) this.attrs.set(k, "");
    else this.attrs.delete(k);
    return on;
  }
  addEventListener() {}
  removeEventListener() {}
  append(...c: (Child | string)[]) {
    for (const x of c) {
      const n = typeof x === "string" ? new FakeText(x) : x;
      if (n instanceof FakeEl) n.parent = this;
      this.children.push(n);
    }
  }
  prepend(...c: Child[]) {
    this.children.unshift(...c);
  }
  replaceChildren(...c: Child[]) {
    this.children = [];
    this.append(...c);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
  cloneNode(): FakeEl {
    const e = new FakeEl(this.tagName);
    e.className = this.className;
    e.children = this.children.map((c) => c.cloneNode());
    return e;
  }
  /** Element descendants, depth first. */
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  querySelectorAll(sel: string): FakeEl[] {
    const m = /^(\w+)?(?:\[data-(\w+)\])?(?:\.([\w-]+))?$/.exec(sel);
    if (!m) throw new Error(`fake-dom: unsupported selector ${sel}`);
    const [, tag, data, cls] = m;
    return this.all().filter(
      (e) =>
        (!tag || e.tagName === tag) &&
        (!data || data in e.dataset) &&
        (!cls || e.classList.contains(cls)),
    );
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

export const fakeDocument = {
  createElement: (tag: string) => new FakeEl(tag),
  createTextNode: (data: string) => new FakeText(data),
  documentElement: { lang: "en" },
  defaultView: { location: { origin: "https://page.example.test" } },
};

/** Puts the fake document on globalThis (when there is no real one) for the test file. */
export function installFakeDocument() {
  const g = globalThis as { document?: unknown };
  if (g.document === undefined) g.document = fakeDocument;
}
