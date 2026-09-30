// Everything the relay remembers lives in one D1 (SQLite) database; see migrations/.
// Any storage failure becomes StoreUnavailable, which the relay answers with 503 (fail closed).

export class StoreUnavailable extends Error {}

/** How long the "being filed" lock lasts. Longer than the GitHub time budget (github.ts), so an
 * issue GitHub was still creating when we gave up has time to appear before anyone retries. */
export const LOCK_SECONDS = 120;
/** Attempt records are kept this long, so a much later retry still knows to look for the issue. */
const ATTEMPT_KEEP_SECONDS = 30 * 86_400;

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new StoreUnavailable("storage unavailable");
  }
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The issue URL if this id was already filed, and whether the install is blocked. One round trip. */
export function lookup(db: D1Database, id: string, installId: string): Promise<{ issueUrl: string | null; blocked: boolean }> {
  return guard(async () => {
    const [filed, blocked] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT issue_url FROM filed WHERE id = ?1").bind(id),
      db.prepare("SELECT 1 AS b FROM blocked WHERE install_id = ?1").bind(installId),
    ]);
    const url = filed?.results[0]?.issue_url;
    return { issueUrl: typeof url === "string" ? url : null, blocked: (blocked?.results.length ?? 0) > 0 };
  });
}

export type Lock =
  | { kind: "busy" }
  | { kind: "filed"; issueUrl: string }
  /** attempts: 1 on the first try. firstAttemptMs: when the first try started (relay clock). */
  | { kind: "acquired"; attempts: number; firstAttemptMs: number };

/**
 * Take the lock for this id (atomic), and in the same transaction re-check `filed`, in case
 * another request filed it after our first lookup.
 */
export function acquireLock(db: D1Database, id: string, nowMs: number): Promise<Lock> {
  const now = seconds(nowMs);
  return guard(async () => {
    const [lock, filed] = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `INSERT INTO pending (id, locked_until, attempts, first_attempt_at) VALUES (?1, ?2, 1, ?3)
           ON CONFLICT(id) DO UPDATE SET locked_until = excluded.locked_until, attempts = pending.attempts + 1
           WHERE pending.locked_until <= ?3
           RETURNING attempts, first_attempt_at`,
        )
        .bind(id, now + LOCK_SECONDS, now),
      db.prepare("SELECT issue_url FROM filed WHERE id = ?1").bind(id),
    ]);
    const row = lock?.results[0];
    if (!row) return { kind: "busy" };
    const url = filed?.results[0]?.issue_url;
    if (typeof url === "string") {
      await db.prepare("DELETE FROM pending WHERE id = ?1").bind(id).run();
      return { kind: "filed", issueUrl: url };
    }
    return { kind: "acquired", attempts: Number(row.attempts), firstAttemptMs: Number(row.first_attempt_at) * 1000 };
  });
}

/** Let the next retry in straight away (the attempt count is kept). Only for failures that
 * certainly didn't create an issue. Best effort: otherwise the lock simply expires. */
export async function releaseLock(db: D1Database, id: string): Promise<void> {
  try {
    await db.prepare("UPDATE pending SET locked_until = 0 WHERE id = ?1").bind(id).run();
  } catch {
    // Expires by itself after LOCK_SECONDS.
  }
}

/** Remember the issue, drop the attempt record, sweep old rows, and run `extra` (the filed
 * counter) in the same transaction. */
export async function recordFiled(
  db: D1Database,
  id: string,
  issueUrl: string,
  nowMs: number,
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  const now = seconds(nowMs);
  await guard(() =>
    db.batch([
      db.prepare("INSERT OR IGNORE INTO filed (id, issue_url, filed_at) VALUES (?1, ?2, ?3)").bind(id, issueUrl, now),
      db.prepare("DELETE FROM pending WHERE id = ?1 OR first_attempt_at <= ?2").bind(id, now - ATTEMPT_KEEP_SECONDS),
      db.prepare("DELETE FROM counters WHERE expires_at <= ?1").bind(now),
      ...extra,
    ]),
  );
}
