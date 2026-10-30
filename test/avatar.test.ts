import { describe, expect, test } from "bun:test";
import {
  avatarColors,
  avatarSrcs,
  contrastRatio,
  hashId,
  initialOf,
  lineAvatar,
  oklchLuminance,
} from "../src/avatar.ts";
import type { ChatMessage } from "../src/protocol.ts";

const line = (m: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  from: "owner",
  label: "/ Mac",
  text: "hi",
  at: 0,
  ...m,
});

describe("initialOf", () => {
  test("the name's first grapheme, upper-cased", () => {
    expect(initialOf("ada")).toBe("A");
    expect(initialOf(" émile")).toBe("É");
    expect(initialOf("山田")).toBe("山");
    expect(initialOf("👩‍💻 dev")).toBe("👩‍💻");
  });
  test("? for no name", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf(undefined)).toBe("?");
  });
  test("without Intl.Segmenter", () => {
    const Seg = Intl.Segmenter;
    try {
      (Intl as { Segmenter?: unknown }).Segmenter = undefined;
      expect(initialOf("ada")).toBe("A");
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = Seg;
    }
  });
});

describe("avatarColors", () => {
  test("oklch(0.7 0.12 <hue>), stable per seed", () => {
    const a = avatarColors("u1");
    expect(a.bg).toBe(`oklch(0.7 0.12 ${a.hue})`);
    expect(avatarColors("u1")).toEqual(a);
    expect(hashId("u1")).toBe(hashId("u1"));
  });
  test("the letter contrasts at least 4.5:1 on every hue", () => {
    for (let i = 0; i < 2000; i++) {
      const { hue, fg } = avatarColors(`seed-${i}`);
      const ink = fg === "oklch(1 0 0)" ? 1 : oklchLuminance(0.2, 0, 0);
      expect(contrastRatio(ink, oklchLuminance(0.7, 0.12, hue))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("avatarSrcs", () => {
  test("a URL, a list in fallback order, or nothing", () => {
    expect(avatarSrcs("https://example.com/a.png")).toEqual(["https://example.com/a.png"]);
    expect(avatarSrcs(["https://example.com/a.png", ""])).toEqual(["https://example.com/a.png"]);
    expect(avatarSrcs("")).toEqual([]);
    expect(avatarSrcs(null)).toEqual([]);
  });
});

describe("lineAvatar", () => {
  const user = { id: "v1", name: "Ada", avatar: "https://example.com/me.png" };
  test("the agent's line: the app's logo, as a URL or an element", () => {
    expect(lineAvatar(line({ from: "agent", label: "bot" }), { agentAvatar: "/logo.svg" })).toEqual(
      { srcs: ["/logo.svg"], name: "bot", initialFrom: "bot", seed: "agent:bot", mine: false },
    );
    const el = { nodeType: 1 } as unknown as Element;
    expect(lineAvatar(line({ from: "agent", label: "" }), { agentAvatar: el })).toMatchObject({
      srcs: [],
      node: el,
      name: "agent",
    });
    expect(lineAvatar(line({ from: "agent" }), {}).node).toBeUndefined();
  });
  test("the user's own line: 'you', their picture, their initial", () => {
    expect(lineAvatar(line({}), { user })).toEqual({
      srcs: ["https://example.com/me.png"],
      name: "you",
      initialFrom: "Ada",
      seed: "v1",
      mine: true,
    });
    expect(lineAvatar(line({ from: "friend" }), { friend: true, user }).mine).toBe(true);
  });
  test("someone else's line: the resolver first, then its sender", () => {
    const m = line({
      from: "friend",
      thread: "f1",
      sender: { name: "Émile", avatar: "https://example.com/s.png" },
    });
    expect(lineAvatar(m, { user })).toEqual({
      srcs: ["https://example.com/s.png"],
      name: "Émile",
      initialFrom: "Émile",
      seed: "f1",
      mine: false,
    });
    const r = lineAvatar(m, {
      user,
      avatarFor: () => ({ id: "k3", avatar: ["https://example.com/app.png"] }),
    });
    expect(r.srcs).toEqual(["https://example.com/app.png", "https://example.com/s.png"]);
    expect(r.seed).toBe("k3");
  });
  test("no sender: a role name, the thread as the colour seed", () => {
    expect(lineAvatar(line({ from: "friend", thread: "f1" }), {})).toMatchObject({
      name: "friend",
      seed: "f1",
    });
    expect(lineAvatar(line({ from: "owner" }), { friend: true })).toMatchObject({
      name: "owner",
      seed: "owner",
    });
  });
});
