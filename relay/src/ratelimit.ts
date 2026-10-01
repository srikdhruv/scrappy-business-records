// Fixed-window rate limits, counted in D1 (atomic upserts). Fails closed: if the counters
// can't be read or written, StoreUnavailable propagates and the request is refused (503).

import { StoreUnavailable } from "./db";

/** Lower these if spam arrives (see docs/runbooks/feedback-relay-setup.md). */
export const INSTALL_PER_HOUR = 10;
export const INSTALL_PER_DAY = 30;
export const IP_PER_HOUR = 20;
/** Across everyone: at most this many issues filed per UTC day (counted when filed). */
export const GLOBAL_FILED_PER_DAY = 50;
/** Across everyone: at most this many attempts per UTC day (a brake on abuse; counted up front). */
export const GLOBAL_ATTEMPTS_PER_DAY = 300;

const HOUR = 3600;
const DAY = 86_400;

interface Window {
  key: string;
  limit: number;
  /** Seconds until this window ends (days end at 00:00 UTC). */
  resetIn: number;
  expiresAt: number;
}

function window(kind: string, who: string, seconds: number, limit: number, now: number): Window {
  const bucket = Math.floor(now / seconds);
  const end = (bucket + 1) * seconds;
  return { key: `rl:${kind}:${who}:${bucket}`, limit, resetIn: Math.max(1, end - now), expiresAt: end };
}

/** SHA-256 of the IP, first 16 hex characters. Raw IPs are never stored. */
export async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`scrappy-feedback:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

const UPSERT = `INSERT INTO counters (key, count, expires_at) VALUES (?1, 1, ?2)
  ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`;

function filedWindow(now: number): Window {
  return window("gf", "all", DAY, GLOBAL_FILED_PER_DAY, now);
}

/** The statement that counts one filed issue; run with recordFiled, in the same transaction. */
export function countFiled(db: D1Database, nowMs: number): D1PreparedStatement {
  const w = filedWindow(Math.floor(nowMs / 1000));
  return db.prepare(UPSERT).bind(w.key, w.expiresAt);
}

/**
 * Count this request against every limit. Returns null if allowed, or the Retry-After seconds.
 * Reads first, so requests already over a limit cost no writes.
 */
export async function reserve(db: D1Database, installId: string, ip: string | null, nowMs: number): Promise<number | null> {
  const now = Math.floor(nowMs / 1000);
  const windows = [
    window("i", installId, HOUR, INSTALL_PER_HOUR, now),
    window("id", installId, DAY, INSTALL_PER_DAY, now),
    window("g", "all", DAY, GLOBAL_ATTEMPTS_PER_DAY, now),
  ];
  if (ip) windows.push(window("ip", await hashIp(ip), HOUR, IP_PER_HOUR, now));
  // Checked here, but only counted when an issue is actually filed (countFiled).
  const filed = filedWindow(now);
  const retryAfter = (over: Window[]) => (over.length ? Math.max(...over.map((w) => w.resetIn)) : null);

  try {
    const checked = [...windows, filed];
    const placeholders = checked.map((_, i) => `?${i + 1}`).join(", ");
    const { results } = await db
      .prepare(`SELECT key, count FROM counters WHERE key IN (${placeholders})`)
      .bind(...checked.map((w) => w.key))
      .all<{ key: string; count: number }>();
    const counts = new Map(results.map((r) => [r.key, r.count]));
    const alreadyOver = retryAfter(checked.filter((w) => (counts.get(w.key) ?? 0) >= w.limit));
    if (alreadyOver !== null) return alreadyOver;

    const upsert = db.prepare(UPSERT);
    const counted = await db.batch<{ count: number }>(windows.map((w) => upsert.bind(w.key, w.expiresAt)));
    // Two requests racing past the read are caught here, from the counts after this one's increment.
    return retryAfter(windows.filter((w, i) => (counted[i]?.results[0]?.count ?? Infinity) > w.limit));
  } catch {
    throw new StoreUnavailable("rate-limit storage unavailable");
  }
}
