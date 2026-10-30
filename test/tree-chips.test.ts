import { describe, expect, it } from "bun:test";
import { parseTreeDoc } from "../src/state-tree.ts";
import { branchLines, navIndexOf, openTopOf } from "../src/tree-chips.ts";
import { initialNav, treeNav } from "../src/tree-nav.ts";

const md = `
## Alpha
- [~] one
  - [ ] one-a
    - [ ] one-a-i
- [ ] two
## Beta
- [x] three
## Gamma
`;

describe("tree chips", () => {
  const root = parseTreeDoc(md);
  const { ix, byId } = navIndexOf(root);

  it("ids are index paths, so a reload keeps the focus", () => {
    expect(ix.roots).toEqual(["0", "1", "2"]);
    expect(ix.children.get("0")).toEqual(["0.0", "0.1"]);
    expect(byId.get("0.0")?.title).toBe("one");
    expect(byId.get("0.0.0.0")?.title).toBe("one-a-i");
    expect(navIndexOf(parseTreeDoc(md)).ix.children).toEqual(ix.children);
  });

  it("no tree: no chips", () => {
    expect(navIndexOf(null).ix.roots).toEqual([]);
  });

  it("nothing open: chips only, no branch", () => {
    const s = initialNav(ix);
    expect(openTopOf(s)).toBeNull();
    expect(branchLines(ix, s)).toEqual([]);
  });

  it("a tapped chip opens its branch one level; a drag opens it deeper", () => {
    let s = treeNav(ix, initialNav(ix), { type: "tapChip", id: "0" });
    expect(openTopOf(s)).toBe("0");
    expect(branchLines(ix, s)).toEqual([
      { id: "0.0", level: 0 },
      { id: "0.1", level: 0 },
    ]);
    s = treeNav(ix, s, { type: "dragStart" });
    s = treeNav(ix, s, { type: "dragMove", cells: 2 });
    s = treeNav(ix, s, { type: "dragEnd" });
    expect(branchLines(ix, s)).toEqual([
      { id: "0.0", level: 0 },
      { id: "0.0.0", level: 1 },
      { id: "0.0.0.0", level: 2 },
      { id: "0.1", level: 0 },
    ]);
  });

  it("one branch at a time: tapping another chip closes the first", () => {
    let s = treeNav(ix, initialNav(ix), { type: "tapChip", id: "0" });
    s = treeNav(ix, s, { type: "tapChip", id: "1" });
    expect(openTopOf(s)).toBe("1");
    expect(branchLines(ix, s)).toEqual([{ id: "1.0", level: 0 }]);
  });
});
