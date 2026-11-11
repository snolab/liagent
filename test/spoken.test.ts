import { describe, expect, test } from "bun:test";
import { MAX_SPEAK } from "../src/protocol.ts";
import { cleanForSpeech, spokenText } from "../src/spoken.ts";

describe("spokenText", () => {
  test("a line's own speak wins over its text", () => {
    expect(spokenText({ text: "AI助手: 12/10 → /todo/", speak: " 欸哀助手：十二月十号 " })).toBe(
      "欸哀助手：十二月十号",
    );
  });
  test("an empty or non-string speak falls back to the cleaned text", () => {
    for (const speak of [undefined, "", "  ", 3, null])
      expect(spokenText({ text: "see https://a.example/x …", speak })).toBe("see,");
  });
  test("speak is capped", () => {
    expect(spokenText({ text: "t", speak: "x".repeat(MAX_SPEAK + 5) })).toHaveLength(MAX_SPEAK);
  });
});

describe("cleanForSpeech", () => {
  test("drops links and paths, keeps the words", () => {
    expect(
      cleanForSpeech("下一笔付款 12/10，详情 https://example.com/a?b=1 或 /app/bills/today/"),
    ).toBe("下一笔付款 12/10，详情 或");
    expect(cleanForSpeech("open ./notes/today.md and ~/x/y")).toBe("open and");
  });
  test("ellipses become a pause; arrows, markdown marks and emoji go", () => {
    expect(cleanForSpeech("好了…… 下一步 → **付款** 🎉")).toBe("好了, 下一步 付款");
    expect(cleanForSpeech("## Title\nwait...")).toBe("Title\nwait,");
  });
  test("keeps plain text as it is", () => {
    expect(cleanForSpeech("It costs ¥1,200 (incl. tax).")).toBe("It costs ¥1,200 (incl. tax).");
    expect(cleanForSpeech("你好，我是AI助手。")).toBe("你好，我是AI助手。");
  });
});
