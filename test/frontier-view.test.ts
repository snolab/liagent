import { describe, expect, it } from "bun:test";
import { MAX_ID_LEN, countBadge, shortId, shownAgentId } from "../src/frontier-view.ts";
import { createLongPress } from "../src/tap-gesture.ts";

describe("frontier agent ids", () => {
  const agent = (id?: string) => ({ type: "agent" as const, name: "lane", id });

  it("shows an agent's opaque slug, its last 6 characters at the line's end", () => {
    expect(shownAgentId(agent("lane-main-7f3a9c"))).toBe("lane-main-7f3a9c");
    expect(shortId("lane-main-7f3a9c")).toBe("7f3a9c");
    expect(shortId("abc")).toBe("abc");
  });

  it("never shows one for a human, or a missing one", () => {
    expect(shownAgentId({ type: "human", name: "Ada", id: "human-1" })).toBeNull();
    expect(shownAgentId(agent())).toBeNull();
    expect(shownAgentId(agent("  "))).toBeNull();
    expect(shownAgentId(undefined)).toBeNull();
  });

  it("hides anything that looks like a host, a path, a pid:port or a token", () => {
    expect(shownAgentId(agent("my-mac.local"))).toBeNull();
    expect(shownAgentId(agent("1234:5678"))).toBeNull();
    expect(shownAgentId(agent("home/user/x"))).toBeNull();
    expect(shownAgentId(agent("a\\b"))).toBeNull();
    expect(shownAgentId(agent("x".repeat(MAX_ID_LEN + 1)))).toBeNull();
    expect(shownAgentId(agent("x".repeat(MAX_ID_LEN)))).toBe("x".repeat(MAX_ID_LEN));
  });
});

describe("frontier display", () => {
  it("counts a group as 〔N〕, nothing for one item", () => {
    expect(countBadge(7)).toBe("〔7〕");
    expect(countBadge(1)).toBe("");
    expect(countBadge(undefined)).toBe("");
  });
});

describe("createLongPress", () => {
  function clock() {
    let now = 0;
    let timers: { at: number; f: () => void; live: boolean }[] = [];
    return {
      setTimer: (f: () => void, ms: number) => {
        const t = { at: now + ms, f, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t: unknown) => {
        (t as { live: boolean }).live = false;
      },
      advance(ms: number) {
        now += ms;
        for (const t of timers.filter((x) => x.live && x.at <= now)) {
          t.live = false;
          t.f();
        }
        timers = timers.filter((x) => x.live);
      },
    };
  }

  it("fires after 500 ms held, not before, and says so on release", () => {
    const c = clock();
    let n = 0;
    const p = createLongPress({ onLong: () => n++, ...c });
    p.down();
    c.advance(499);
    expect(n).toBe(0);
    c.advance(1);
    expect(n).toBe(1);
    expect(p.up()).toBe(true);
  });

  it("a short tap or a press that leaves is not a long press", () => {
    const c = clock();
    let n = 0;
    const p = createLongPress({ onLong: () => n++, ...c });
    p.down();
    c.advance(200);
    expect(p.up()).toBe(false);
    p.down();
    c.advance(200);
    p.cancel();
    c.advance(1000);
    expect(n).toBe(0);
  });

  it("runs on the real timers too", async () => {
    let n = 0;
    const p = createLongPress({ onLong: () => n++, ms: 5 });
    p.down();
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(1);
  });
});
