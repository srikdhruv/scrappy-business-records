// Everything the relay remembers lives in one D1 (SQLite) database; see migrations/.
// Any storage failure becomes StoreUnavailable, which the relay answers with 503 (fail closed).

export class StoreUnavailable extends Error {}

/** How long the "being filed" lock lasts. Longer than the GitHub time budget (github.ts). */
export const LOCK_SECONDS = 120;

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new StoreUnavailable("storage unavailable");
  }
}

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

/** Take the lock for this id. False if another request holds an unexpired one. Atomic. */
export function acquireLock(db: D1Database, id: string, nowMs: number): Promise<boolean> {
  const now = Math.floor(nowMs / 1000);
  return guard(async () => {
    const row = await db
      .prepare(
        `INSERT INTO pending (id, expires_at) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at WHERE pending.expires_at <= ?3
         RETURNING id`,
      )
      .bind(id, now + LOCK_SECONDS, now)
      .first();
    return row !== null;
  });
}

/** Best effort: if this fails the lock simply expires. */
export async function releaseLock(db: D1Database, id: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM pending WHERE id = ?1").bind(id).run();
  } catch {
    // Expires by itself after LOCK_SECONDS.
  }
}

/** Remember the issue, drop the lock, and sweep expired locks and counters. */
export async function recordFiled(db: D1Database, id: string, issueUrl: string, nowMs: number): Promise<void> {
  const now = Math.floor(nowMs / 1000);
  await guard(() =>
    db.batch([
      db.prepare("INSERT OR IGNORE INTO filed (id, issue_url, filed_at) VALUES (?1, ?2, ?3)").bind(id, issueUrl, now),
      db.prepare("DELETE FROM pending WHERE id = ?1 OR expires_at <= ?2").bind(id, now),
      db.prepare("DELETE FROM counters WHERE expires_at <= ?1").bind(now),
    ]),
  );
}
