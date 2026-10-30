import { describe, expect, it } from "bun:test";
import {
  ECHO_MIN_CHARS,
  ECHO_SIMILARITY,
  dice,
  echoScore,
  grams,
  normalizeEcho,
} from "../src/echo.ts";

describe("echo guard: normalizing", () => {
  it("drops case, width, punctuation, symbols and spaces", () => {
    expect(normalizeEcho("Hello, World! It's 3:00 — ok?")).toBe("helloworldits300ok");
    expect(normalizeEcho("今日は、晴れです。")).toBe("今日は晴れです");
    expect(normalizeEcho("ＡＢＣ　１２３")).toBe("abc123");
    expect(normalizeEcho(" …！ ")).toBe("");
  });

  it("n-grams count repeats; a string shorter than n is one gram", () => {
    expect([...grams("abab", 2)]).toEqual([
      ["ab", 2],
      ["ba", 1],
    ]);
    expect([...grams("はい", 3)]).toEqual([["はい", 1]]);
    expect(grams("", 2).size).toBe(0);
    expect(dice(grams("abc", 2), grams("abc", 2))).toBe(1);
    expect(dice(grams("abc", 2), grams("xyz", 2))).toBe(0);
    expect(dice(new Map(), new Map())).toBe(0);
  });
});

describe("echo guard: echoScore", () => {
  const spoken = [
    "I deployed the fix to production.",
    "The tests pass on main now.",
    "今日はいい天気ですね。",
  ];

  it("drops the agent's own sentence, even mis-heard by STT", () => {
    expect(echoScore("I deployed the fix to production", spoken)).toMatchObject({
      score: 1,
      drop: true,
      against: spoken[0],
    });
    const misheard = echoScore("I deploy the fix to the production", spoken);
    expect(misheard.score).toBeGreaterThanOrEqual(ECHO_SIMILARITY);
    expect(misheard.drop).toBe(true);
  });

  it("drops a substring of a sentence (STT caught part of it)", () => {
    expect(echoScore("tests pass on main", spoken)).toMatchObject({ score: 1, drop: true });
    expect(echoScore("いい天気", spoken)).toMatchObject({ score: 1, drop: true });
  });

  it("uses CJK bigrams: a near-miss Japanese transcript is dropped", () => {
    const r = echoScore("今日はいい天気ですよね", spoken);
    expect(r.drop).toBe(true);
    expect(r.against).toBe(spoken[2] ?? null);
  });

  it("catches a transcript spanning two sentences", () => {
    const r = echoScore("to production. The tests pass", spoken);
    expect(r.drop).toBe(true);
    expect(r.against).toBe(`${spoken[0]} ${spoken[1]}`);
  });

  it("keeps the user's own words", () => {
    const r = echoScore("Can you also update the docs please", spoken);
    expect(r.drop).toBe(false);
    expect(r.score).toBeLessThan(ECHO_SIMILARITY);
    expect(echoScore("明日は雨が降るかな", spoken).drop).toBe(false);
  });

  it("short replies are dropped only when they equal a whole sentence", () => {
    expect("ok".length).toBeLessThan(ECHO_MIN_CHARS);
    // "OK" inside an agent sentence: the user's "OK" stays.
    expect(echoScore("OK.", ["OK, I will do that."])).toMatchObject({ drop: false, score: 0 });
    expect(echoScore("はい", ["はい、そうします。"]).drop).toBe(false);
    // The agent said just "OK.": that one is echo.
    expect(echoScore("ok", ["OK."])).toMatchObject({ drop: true, score: 1 });
  });

  it("nothing to compare: no drop", () => {
    expect(echoScore("anything at all", [])).toEqual({ score: 0, against: null, drop: false });
    expect(echoScore("  ...  ", spoken)).toEqual({ score: 0, against: null, drop: false });
    expect(echoScore("anything at all", ["!!!"])).toEqual({ score: 0, against: null, drop: false });
  });
});
