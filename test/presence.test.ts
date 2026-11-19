import { describe, expect, it } from "bun:test";
import {
  MAX_PRESENCE,
  cleanAvatarUrl,
  laneHostOf,
  parsePageMessage,
  parsePresence,
} from "../src/protocol.ts";
import {
  applyPresence,
  badgeText,
  emptyPresence,
  memberLabel,
  presenceAria,
  presenceView,
} from "../src/presence.ts";

const u = (id: string, label = id) => ({ id, kind: "user" as const, label });

describe("presence protocol", () => {
  it("validates a snapshot: ids, kinds, caps, one-line labels", () => {
    const f = parsePresence({
      type: "presence",
      node: "words/",
      members: [
        { id: "a", kind: "user", label: "Ann‮\n", avatar: "https://x.test/a.png" },
        { id: "a", kind: "user", label: "dup" },
        { id: "", label: "no id" },
        { id: "b", kind: "robot", label: "x".repeat(500) },
        { id: "c", kind: "agent", lane: "writer", host: "devbox" },
        "junk",
      ],
      at: 5,
    });
    expect(f).toEqual({
      type: "presence",
      node: "/words",
      members: [
        { id: "a", kind: "user", label: "Ann", avatar: "https://x.test/a.png" },
        { id: "b", kind: "user", label: "x".repeat(80) },
        { id: "c", kind: "agent", label: "writer", lane: "writer", host: "devbox" },
      ],
      at: 5,
    });
    const many = parsePresence({
      type: "presence",
      node: "/",
      members: Array.from({ length: 500 }, (_, i) => u(`m${i}`)),
      at: 1,
    });
    expect(many && "members" in many && many.members.length).toBe(MAX_PRESENCE);
    expect(parsePresence({ type: "presence", node: "/../x", members: [] })).toBeNull();
    expect(parsePresence({ type: "chat" })).toBeNull();
    expect(
      parsePresence(
        JSON.stringify({
          type: "presence-delta",
          node: "/",
          join: [u("z")],
          leave: ["y", 3],
          at: 2,
        }),
      ),
    ).toEqual({
      type: "presence-delta",
      node: "/",
      join: [u("z")],
      leave: ["y"],
      at: 2,
    });
  });
  it("avatars: https: or a raster data:image only", () => {
    expect(cleanAvatarUrl("https://x.test/a.png")).toBe("https://x.test/a.png");
    expect(cleanAvatarUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const bad of [
      "http://x.test/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,AAAA",
      "data:text/html,<b>",
      "//x.test/a",
      3,
    ])
      expect(cleanAvatarUrl(bad)).toBeUndefined();
  });
  it("the page names its node with {type:'page', node}", () => {
    expect(parsePageMessage(JSON.stringify({ type: "page", node: "words" }))).toEqual({
      type: "page",
      node: "/words",
    });
    expect(parsePageMessage(JSON.stringify({ type: "page", label: "/x", node: "/" }))).toEqual({
      type: "page",
      label: "/x",
      node: "/",
    });
    expect(parsePageMessage(JSON.stringify({ type: "page", node: "/../x" }))).toBeNull();
    expect(parsePageMessage(JSON.stringify({ type: "page" }))).toBeNull();
  });
  it("lane@host from an agent label", () => {
    expect(laneHostOf("writer@devbox watching /x")).toEqual({ lane: "writer", host: "devbox" });
    expect(laneHostOf("[reviewer]@devbox")).toEqual({ lane: "reviewer", host: "devbox" });
    expect(laneHostOf("main lane")).toEqual({});
  });
});

describe("presence state and view", () => {
  it("snapshot replaces, delta merges, other nodes are ignored", () => {
    let s = emptyPresence("/w");
    s = applyPresence(s, { type: "presence", node: "/w", members: [u("a"), u("b")], at: 1 });
    s = applyPresence(s, {
      type: "presence-delta",
      node: "/w",
      join: [u("c"), u("a", "Ann")],
      leave: ["b"],
      at: 2,
    });
    expect(s.members).toEqual([u("a", "Ann"), u("c")]);
    expect(applyPresence(s, { type: "presence", node: "/other", members: [], at: 3 })).toBe(s);
    s = applyPresence(s, { type: "presence", node: "/w", members: [u("z")], at: 4 });
    expect(s.members).toEqual([u("z")]);
  });
  it("leaves out self; hidden when alone; no number at 3 or fewer, +N past 3", () => {
    expect(presenceView([u("me")], "me").hidden).toBe(true);
    const three = presenceView([u("me"), u("a"), u("b"), u("c")], "me");
    expect([three.hidden, three.stack.length, three.more]).toEqual([false, 3, 0]);
    const ten = presenceView(
      Array.from({ length: 11 }, (_, i) => u(i ? `m${i}` : "me")),
      "me",
    );
    expect([ten.stack.length, ten.more, ten.preview.length, ten.all.length]).toEqual([3, 7, 8, 10]);
  });
  it("labels, badges and the aria-label", () => {
    const ag = {
      id: "x",
      kind: "agent" as const,
      label: "writer@devbox",
      lane: "writer",
      host: "devbox",
    };
    expect(memberLabel(ag)).toBe("[writer@devbox]");
    expect(memberLabel({ ...ag, label: "Router" })).toBe("Router [writer@devbox]");
    expect(badgeText(ag)).toBe("WR");
    expect(badgeText(u("a", "ada"))).toBe("A");
    expect(presenceAria([u("a", "<img src=x onerror=alert(1)>"), ag], "Also here")).toBe(
      "Also here: <img src=x onerror=alert(1)>, [writer@devbox]",
    );
  });
});
