import { describe, expect, it } from "bun:test";
import { TREE_JA, TREE_ZH, UI_EN, UI_JA, UI_ZH, uiStrings } from "../src/ui-strings.ts";

describe("UiStrings: every box string is overridable and translated", () => {
  it("Chinese has the same {placeholders} as English", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(UI_EN) as (keyof typeof UI_EN)[])
      expect([k, ph(UI_ZH[k])]).toEqual([k, ph(UI_EN[k])]);
  });
  it("Japanese has the same {placeholders} as English, and a ja page gets it", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(UI_EN) as (keyof typeof UI_EN)[])
      expect([k, ph(UI_JA[k])]).toEqual([k, ph(UI_EN[k])]);
    expect(Object.keys(TREE_JA).sort()).toEqual(Object.keys(TREE_ZH).sort());
    expect(uiStrings("ja-JP")).toBe(UI_JA);
    expect(uiStrings("ja").markHint).toContain("タップ");
  });
});
