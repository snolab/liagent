import { describe, expect, it } from "bun:test";
import {
  type VoiceLike,
  chooseVoice,
  createVoicePicker,
  preferredVoice,
  readingLang,
} from "../src/voice-pick.ts";
import { pickNaturalVoice } from "../src/voice.ts";
import { pickVoice } from "../src/protocol.ts";

const v = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({
  name,
  lang,
  voiceURI: name,
  ...extra,
});

const VOICES = [
  v("Kyoko", "ja-JP", { default: true }),
  v("Microsoft Nanami Online (Natural) - Japanese (Japan)", "ja-JP"),
  v("Google 日本語", "ja-JP"),
  v("Samantha", "en-US", { default: true }),
  v("Google US English", "en-US"),
  v("Microsoft Nanami Clone", "en-US"),
];

describe("preferredVoice", () => {
  it("takes an exact name first, in the order given", () => {
    expect(preferredVoice(VOICES, "ja-JP", ["Google 日本語", "Kyoko"])?.name).toBe("Google 日本語");
    expect(preferredVoice(VOICES, "ja-JP", ["Missing", "Kyoko", "Google 日本語"])?.name).toBe(
      "Kyoko",
    );
  });

  it("prefers any exact name over an earlier entry's substring", () => {
    // "Microsoft Nanami" is only a substring; "Kyoko" is exact, so it wins.
    expect(preferredVoice(VOICES, "ja-JP", ["Microsoft Nanami", "Kyoko"])?.name).toBe("Kyoko");
  });

  it("falls to a case-insensitive substring, in order", () => {
    expect(preferredVoice(VOICES, "ja-JP", ["microsoft nanami", "Google"])?.name).toBe(
      "Microsoft Nanami Online (Natural) - Japanese (Japan)",
    );
  });

  it("only looks at the reply's language (any region of it)", () => {
    expect(preferredVoice(VOICES, "en-US", ["Kyoko"])).toBeUndefined();
    expect(preferredVoice(VOICES, "en-GB", ["Nanami"])?.name).toBe("Microsoft Nanami Clone");
    expect(preferredVoice(VOICES, "ja", ["Kyoko"])?.name).toBe("Kyoko");
    expect(preferredVoice([v("X", "ja_JP")], "ja-JP", ["X"])?.name).toBe("X");
  });

  it("is nothing with no names (or blank ones)", () => {
    expect(preferredVoice(VOICES, "ja-JP", undefined)).toBeUndefined();
    expect(preferredVoice(VOICES, "ja-JP", ["", "  "])).toBeUndefined();
  });
});

describe("chooseVoice", () => {
  it("falls back to the automatic pick when no preferred voice is installed", () => {
    const pref = { prefer: ["Google 日本語"] };
    expect(chooseVoice(VOICES, "en-US", pref)?.name).toBe("Samantha");
    expect(chooseVoice(VOICES, "en-US", pref)).toBe(pickVoice(VOICES, "en-US"));
    expect(chooseVoice(VOICES, "ja-JP", null)).toBe(pickVoice(VOICES, "ja-JP"));
    expect(chooseVoice([], "ja-JP", pref)).toBeUndefined();
  });

  it("uses the fallback it is given (the voice session's: the most natural voice)", () => {
    const voices = [
      v("Eddy", "en-US", { voiceURI: "com.apple.eloquence.en-US.Eddy" }),
      v("Ava", "en-US"),
    ];
    expect(chooseVoice(voices, "en-US", { prefer: ["Zoe"] }, pickNaturalVoice)?.name).toBe("Ava");
    expect(chooseVoice(voices, "en-US", { prefer: ["Eddy"] }, pickNaturalVoice)?.name).toBe("Eddy");
  });
});

describe("readingLang", () => {
  it("forces the preference's language, else guesses", () => {
    expect(readingLang({ lang: "ja-JP" }, () => "en-US")).toBe("ja-JP");
    expect(readingLang({ lang: "  " }, () => "en-US")).toBe("en-US");
    expect(readingLang(null, () => "zh-CN")).toBe("zh-CN");
  });
});

describe("createVoicePicker", () => {
  /** A device whose voice list grows, with a voiceschanged to fire. */
  function device(start: VoiceLike[]) {
    let list = start;
    const subs = new Set<() => void>();
    let lists = 0;
    return {
      voices: () => (lists++, list),
      watch: (f: () => void) => {
        subs.add(f);
        return () => void subs.delete(f);
      },
      load(next: VoiceLike[]) {
        list = next;
        for (const f of subs) f();
      },
      subs,
      lists: () => lists,
    };
  }
  const pref = { prefer: ["Google 日本語"] };

  it("chooses again after voiceschanged (Chrome lists its voices late)", () => {
    const d = device([v("Kyoko", "ja-JP")]);
    const p = createVoicePicker(d);
    expect(p.pick("ja-JP", pref)?.name).toBe("Kyoko");
    expect(d.subs.size).toBe(1); // watching from the first pick
    d.load(VOICES);
    expect(p.pick("ja-JP", pref)?.name).toBe("Google 日本語");
  });

  it("keeps a choice until the voices change", () => {
    const d = device(VOICES);
    const p = createVoicePicker(d);
    p.pick("ja-JP", pref);
    p.pick("ja-JP", pref);
    expect(d.lists()).toBe(1);
    // Another preference or language is another choice.
    expect(p.pick("ja-JP", { prefer: ["Kyoko"] })?.name).toBe("Kyoko");
    expect(p.pick("en-US", pref)?.name).toBe("Samantha");
    expect(d.lists()).toBe(3);
  });

  it("asks again while no voice is listed yet", () => {
    const d = device([]);
    const p = createVoicePicker(d);
    expect(p.pick("ja-JP", pref)).toBeUndefined();
    expect(p.pick("ja-JP", pref)).toBeUndefined();
    expect(d.lists()).toBe(2);
  });

  it("forgets on reset(), and stops watching on stop()", () => {
    const d = device(VOICES);
    const p = createVoicePicker(d);
    p.pick("ja-JP", pref);
    p.reset();
    p.pick("ja-JP", pref);
    expect(d.lists()).toBe(2);
    p.stop();
    expect(d.subs.size).toBe(0);
  });
});

describe("createVoice: a forced language", () => {
  it("reads every reply in `lang` when set, else in its script's", async () => {
    const { createVoice } = await import("../src/voice.ts");
    const langs: string[] = [];
    let forced: string | undefined = "ja-JP";
    const s = createVoice({
      synth: () => ({ speak: () => {}, cancel: () => {} }),
      utter: (text, lang) => {
        langs.push(lang);
        return { text, onend: null, onerror: null, onboundary: null };
      },
      enabled: () => true,
      lang: () => forced,
    });
    s.reply("Hello there.");
    s.stop();
    forced = undefined;
    s.reply("Hello again.");
    expect(langs).toEqual(["ja-JP", "en-US"]);
  });
});
