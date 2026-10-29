import { describe, expect, it } from "bun:test";
import {
  agentIdOf,
  completeNode,
  lineNode,
  mayAddress,
  nodeHue,
  nodePath,
  parseAddress,
  parseControllerMessage,
  parsePageMessage,
  routeTo,
} from "../src/protocol.ts";
import { lineAvatar } from "../src/avatar.ts";
import { listenLine, placeOf } from "../src/place.ts";

describe("node paths: validation", () => {
  it("normalises, and refuses bad characters, dot segments and long paths", () => {
    expect(nodePath(" /words › prefetch ")).toBe("/words/prefetch");
    expect(nodePath("words/prefetch/")).toBe("/words/prefetch");
    for (const bad of ["/a b", "/a/../b", "/<x>", "", 1]) expect(nodePath(bad)).toBeUndefined();
    expect(nodePath(`/${"a".repeat(80)}`)).toBeUndefined();
    expect(agentIdOf(" pf ")).toBe("pf");
    expect(agentIdOf("a/b")).toBeUndefined();
  });
  it("say/chat/grant messages validate their node fields", () => {
    expect(
      parseControllerMessage(
        JSON.stringify({ type: "say", text: "x", to: "/a", taskPath: "/b", agentId: "q" }),
      ),
    ).toEqual({
      ok: true,
      value: { type: "say", text: "x", node: "/a", taskPath: "/b", agentId: "q" },
    });
    expect(
      parseControllerMessage(JSON.stringify({ type: "say", text: "x", taskPath: "/a b" })).ok,
    ).toBe(false);
    expect(parseControllerMessage(JSON.stringify({ type: "grant", from: "/a", to: "/b" }))).toEqual(
      {
        ok: true,
        value: { type: "grant", from: "/a", to: "/b" },
      },
    );
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "x", to: "/a b" })),
    ).toEqual({ type: "chat", id: "1", text: "x" });
  });
});

describe("node paths: routing", () => {
  it("exact, ancestor observes, sibling and descendant excluded, legacy is the root", () => {
    expect(routeTo("/a/b", "/a/b")).toBe("direct");
    expect(routeTo("/a", "/a/b")).toBe("observed");
    expect(routeTo(undefined, "/a/b")).toBe("observed");
    expect(routeTo("/a/c", "/a/b")).toBeNull();
    expect(routeTo("/a/b/c", "/a/b")).toBeNull();
  });
  it("mayAddress: subtree, upward, granted, rejected", () => {
    expect(mayAddress("/a", "/a/b").ok).toBe(true);
    expect(mayAddress("/a/b", "/").ok).toBe(true);
    expect(mayAddress("/a/b", "/a/c", [{ from: "/a/b", to: "/a/c", until: 2 }], 1).ok).toBe(true);
    expect(mayAddress("/a/b", "/a/c")).toEqual({
      ok: false,
      error: "out of scope: needs a grant from /a",
    });
  });
});

describe("node paths: the box", () => {
  it("parses @addresses and completes from listening nodes", () => {
    expect(parseAddress("@/words › prefetch hi")).toEqual({
      to: "/words/prefetch",
      text: "hi",
      complete: true,
    });
    expect(parseAddress("@/wo")?.complete).toBe(false);
    expect(completeNode("@/w", ["/words", "/home"])).toEqual(["/words"]);
  });
  it("renders subtitles and the node's border; unchanged without a node", () => {
    expect(lineNode({ from: "agent", taskPath: "/words/prefetch" })).toEqual({
      node: "/words/prefetch",
      subtitle: "/words › prefetch",
      border: `oklch(0.7 0.09 ${nodeHue("/words/prefetch")})`,
    });
    expect(lineNode({ from: "agent", taskPath: "/a", to: "/b" })?.subtitle).toBe("/a → /b");
    expect(lineNode({ from: "owner", to: "/b" })?.subtitle).toBe("→ /b");
    expect(lineNode({ from: "agent" })).toBeNull();
  });
  it("names an agent line by its agentId", () => {
    const m = { id: "1", from: "agent" as const, label: "lane", text: "x", at: 0 };
    expect(lineAvatar({ ...m, agentId: "pf" }, {}).name).toBe("pf");
    expect(lineAvatar(m, {}).name).toBe("lane");
  });
});

describe("node paths: the CLI", () => {
  it("--task-path/--agent win over $LIAGENT_TASK_PATH/$LIAGENT_AGENT", () => {
    expect(placeOf({}, { LIAGENT_TASK_PATH: "/a", LIAGENT_AGENT: "x" })).toEqual({
      node: "/a",
      agent: "x",
    });
    expect(placeOf({ taskPath: "/b" }, { LIAGENT_TASK_PATH: "/a" })).toEqual({ node: "/b" });
    expect(placeOf({ taskPath: "/a b" }, {})).toHaveProperty("error");
  });
  it("listen prints node lines, skips its own and agents' main-thread replies", () => {
    const own = { from: "agent", to: "/x", taskPath: "/a", agentId: "me" };
    expect(listenLine(own, { node: "/a", agent: "me" })).toBeNull();
    expect(listenLine({ from: "agent" }, {})).toBeNull();
    expect(listenLine({ from: "owner", to: "/a/b" }, { node: "/a" })).toMatchObject({
      observed: true,
    });
  });
});
