/**
 * Progress write scopes. The hub's secret itself is the root grant. A
 * scoped token is
 *
 *   base64url(JSON {node, agent, exp, via?}) + "." + base64url(HMAC-SHA256(secret, that payload))
 *
 * and lets `agent` write `node` and its descendants until `exp`. Only the
 * hub holds the root, so only the hub mints (a scoped token delegates by
 * asking it: POST <progress path>/grant). Web Crypto only, so a Worker and
 * Bun share it. Stateless: nothing is stored per token.
 */

export type ProgressGrant = {
  node: string;
  agent: string;
  /** Expiry, ms since the epoch. */
  exp: number;
  /** The node of the token that asked for this one ("root" for the root token). */
  via?: string;
};
export type ProgressAuth = { root: true } | ({ root: false } & ProgressGrant);

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const key = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

/** A scoped token for `grant`, signed with the root secret. */
export async function mintProgressToken(secret: string, grant: ProgressGrant): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(grant)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)),
  );
  return `${payload}.${b64url(sig)}`;
}

/** Compare by digest, so the time taken says nothing about the secret. */
async function sameSecret(a: string, b: string) {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Who a bearer token is: the root, a live scoped grant, or null (wrong
 * signature, malformed, or expired).
 */
export async function verifyProgressToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<ProgressAuth | null> {
  if (!secret || !token) return null;
  if (await sameSecret(token, secret)) return { root: true };
  const [payload, sig, extra] = token.split(".");
  if (extra !== undefined || !payload || !sig) return null;
  const sigBytes = unb64url(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret), sigBytes, enc.encode(payload));
  if (!ok) return null;
  let g: Partial<ProgressGrant>;
  try {
    g = JSON.parse(new TextDecoder().decode(unb64url(payload) ?? new Uint8Array()));
  } catch {
    return null;
  }
  if (typeof g.node !== "string" || typeof g.agent !== "string" || typeof g.exp !== "number")
    return null;
  if (g.exp <= now) return null;
  return {
    root: false,
    node: g.node,
    agent: g.agent,
    exp: g.exp,
    ...(typeof g.via === "string" ? { via: g.via } : {}),
  };
}
