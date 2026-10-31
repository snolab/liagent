import { describe, expect, it } from "bun:test";
import {
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_KEY,
  type QuietHours,
  inQuietWindow,
  isLoud,
  isQuiet,
  parseHm,
  quietHours,
  quietNow,
  readQuietHours,
  setQuietHours,
  silenceFor,
} from "../src/quiet-hours.ts";

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};
const hm = (s: string) => parseHm(s)!;
/** A local time today (the device's own time zone, as quiet hours use). */
const at = (h: number, m = 0) => new Date(2026, 9, 31, h, m);

describe("the quiet window", () => {
  it("wraps past midnight when it ends before it starts", () => {
    const [from, to] = [hm("23:00"), hm("08:00")];
    expect(inQuietWindow(hm("23:00"), from, to)).toBe(true);
    expect(inQuietWindow(hm("23:30"), from, to)).toBe(true);
    expect(inQuietWindow(hm("00:00"), from, to)).toBe(true);
    expect(inQuietWindow(hm("07:59"), from, to)).toBe(true);
    expect(inQuietWindow(hm("08:00"), from, to)).toBe(false);
    expect(inQuietWindow(hm("12:00"), from, to)).toBe(false);
    expect(inQuietWindow(hm("22:59"), from, to)).toBe(false);
  });

  it("stays within the day when it ends after it starts", () => {
    const [from, to] = [hm("13:00"), hm("14:30")];
    expect(inQuietWindow(hm("12:59"), from, to)).toBe(false);
    expect(inQuietWindow(hm("13:00"), from, to)).toBe(true);
    expect(inQuietWindow(hm("14:29"), from, to)).toBe(true);
    expect(inQuietWindow(hm("14:30"), from, to)).toBe(false);
    expect(inQuietWindow(hm("23:30"), from, to)).toBe(false);
  });

  it("is empty when it starts where it ends", () => {
    for (const t of ["00:00", "08:00", "12:00", "23:59"])
      expect(inQuietWindow(hm(t), hm("08:00"), hm("08:00"))).toBe(false);
  });

  it("reads local HH:MM times, and nothing else", () => {
    expect(parseHm("23:00")).toBe(23 * 60);
    expect(parseHm("8:05")).toBe(8 * 60 + 5);
    expect(parseHm(" 07:59 ")).toBe(7 * 60 + 59);
    for (const bad of ["24:00", "12:60", "noon", "", 800, null, undefined])
      expect(parseHm(bad)).toBeNull();
  });

  it("holds by the device's clock, and only while on", () => {
    const q: QuietHours = { on: true, from: "23:00", to: "08:00" };
    expect(quietNow(q, at(23, 30))).toBe(true);
    expect(quietNow(q, at(7, 59))).toBe(true);
    expect(quietNow(q, at(8, 0))).toBe(false);
    expect(quietNow({ ...q, on: false }, at(2))).toBe(false);
    expect(quietNow({ ...q, from: "bad" }, at(2))).toBe(false);
  });
});

describe("the quiet hours setting", () => {
  it("is on, 23:00–08:00, by default", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ on: true, from: "23:00", to: "08:00" });
    expect(quietHours(mem())).toEqual(DEFAULT_QUIET_HOURS);
    expect(quietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
  });

  it("is saved under liagent:quiet-hours, merged and normalised", () => {
    const s = mem();
    expect(QUIET_HOURS_KEY).toBe("liagent:quiet-hours");
    expect(setQuietHours({ from: "22:30", to: "7:00" }, s)).toEqual({
      on: true,
      from: "22:30",
      to: "07:00",
    });
    expect(setQuietHours({ on: false }, s)).toEqual({ on: false, from: "22:30", to: "07:00" });
    expect(JSON.parse(s.m.get(QUIET_HOURS_KEY)!)).toEqual({
      on: false,
      from: "22:30",
      to: "07:00",
    });
    expect(quietHours(s)).toEqual({ on: false, from: "22:30", to: "07:00" });
  });

  it("falls back field by field on anything broken", () => {
    expect(readQuietHours("{")).toEqual(DEFAULT_QUIET_HOURS);
    expect(readQuietHours("null")).toEqual(DEFAULT_QUIET_HOURS);
    expect(readQuietHours('{"on":"yes","from":"25:00","to":"06:00"}')).toEqual({
      on: true,
      from: "23:00",
      to: "06:00",
    });
  });

  it("survives a store that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(quietHours(broken)).toEqual(DEFAULT_QUIET_HOURS);
    expect(setQuietHours({ on: false }, broken)).toEqual({ ...DEFAULT_QUIET_HOURS, on: false });
  });
});

describe("which lines are read aloud, in order", () => {
  const hours = DEFAULT_QUIET_HOURS;
  const day = { now: at(12), hidden: false, hours };
  const night = { now: at(2), hidden: false, hours };

  it("1. a hidden page never speaks, not even a loud line", () => {
    for (const m of [{}, { loud: true }, { quiet: true }])
      for (const now of [at(12), at(2)])
        expect(silenceFor(m, { now, hidden: true, hours })).toBe("hidden");
  });

  it("2. a loud line is read, quiet hours or not", () => {
    expect(silenceFor({ loud: true }, day)).toBeNull();
    expect(silenceFor({ loud: true }, night)).toBeNull();
    // Loud wins over quiet.
    expect(silenceFor({ loud: true, quiet: true }, night)).toBeNull();
  });

  it("3. a quiet line is never read", () => {
    expect(silenceFor({ quiet: true }, day)).toBe("quiet");
    expect(silenceFor({ quiet: true }, night)).toBe("quiet");
  });

  it("4. inside quiet hours nothing else is read", () => {
    expect(silenceFor({}, day)).toBeNull();
    expect(silenceFor({}, night)).toBe("quiet-hours");
    expect(silenceFor({}, { ...night, hours: { ...hours, on: false } })).toBeNull();
  });

  it("counts only boolean true as loud or quiet", () => {
    for (const v of ["true", 1, {}, false, null]) {
      expect(isLoud({ loud: v })).toBe(false);
      expect(isQuiet({ quiet: v })).toBe(false);
      expect(silenceFor({ loud: v }, night)).toBe("quiet-hours");
      expect(silenceFor({ quiet: v }, day)).toBeNull();
    }
  });
});
