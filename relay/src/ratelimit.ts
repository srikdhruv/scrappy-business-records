// Simple fixed-window rate limits kept as counters in KV.
// KV is not atomic, so two requests at the same instant may both slip through; that's fine here.

/** Lower these if spam arrives (see docs/runbooks/feedback-relay-setup.md). */
export const INSTALL_PER_HOUR = 10;
export const INSTALL_PER_DAY = 30;
export const IP_PER_HOUR = 20;

const HOUR = 3600;
const DAY = 86_400;

interface Window {
  key: string;
  limit: number;
  /** Seconds until this window ends. */
  resetIn: number;
  ttl: number;
}

function window(prefix: string, who: string, seconds: number, limit: number, now: number): Window {
  const bucket = Math.floor(now / seconds);
  return {
    key: `rl:${prefix}:${who}:${bucket}`,
    limit,
    resetIn: Math.max(1, (bucket + 1) * seconds - Math.floor(now)),
    ttl: seconds * 2,
  };
}

/** SHA-256 of the IP, first 16 hex characters. Raw IPs are never stored. */
export async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`scrappy-feedback:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns null if allowed (and counts the request), or the Retry-After seconds if not. */
export async function checkRateLimit(
  kv: KVNamespace,
  installId: string,
  ip: string | null,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const now = nowMs / 1000;
  const windows = [
    window("i", installId, HOUR, INSTALL_PER_HOUR, now),
    window("id", installId, DAY, INSTALL_PER_DAY, now),
  ];
  if (ip) windows.push(window("ip", await hashIp(ip), HOUR, IP_PER_HOUR, now));

  const counts = await Promise.all(windows.map(async (w) => Number((await kv.get(w.key)) ?? 0) || 0));
  const over = windows.filter((w, i) => (counts[i] ?? 0) >= w.limit);
  if (over.length > 0) return Math.max(...over.map((w) => w.resetIn));

  await Promise.all(
    windows.map(async (w, i) => {
      try {
        await kv.put(w.key, String((counts[i] ?? 0) + 1), { expirationTtl: w.ttl });
      } catch {
        // KV allows one write per key per second; a missed count is harmless.
      }
    }),
  );
  return null;
}
