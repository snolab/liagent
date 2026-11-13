// Display helpers a chat UI shares (the box, or one a host draws itself):
// a page's short hint, and a message's time. Pure, no DOM.

/** A page's label is "<path> <user agent>": the path and a short device hint. */
export function pageHint(label: string): string {
  const [path = "", ...rest] = label.split(" ");
  const ua = rest.join(" ");
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|X11/.test(ua)
              ? "Linux"
              : (ua.split(" ").find((w) => w !== "pwa") ?? "");
  const pwa = /(^| )pwa( |$)/.test(ua) ? " app" : "";
  return device ? `${path} · ${device}${pwa}` : path;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
export function when(at: number, now = new Date()) {
  const d = new Date(at);
  const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day(d) === day(now) ? `${hm}:${pad(d.getSeconds())}` : `${day(d)} ${hm}`;
}
