import { describe, expect, it } from "bun:test";
import { UI_EN, UI_ZH } from "../src/ui-strings.ts";

describe("UiStrings: every box string is overridable and translated", () => {
  it("Chinese has the same {placeholders} as English", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(UI_EN) as (keyof typeof UI_EN)[])
      expect([k, ph(UI_ZH[k])]).toEqual([k, ph(UI_EN[k])]);
  });
});
