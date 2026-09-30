-- Feedback relay storage (Cloudflare D1). Applied by `wrangler d1 migrations apply`.
-- WITHOUT ROWID + primary key only, so each insert/update costs one "row written".
-- Nothing here is personal: ids are random UUIDs, IPs appear only as truncated hashes.

-- Feedback already filed: id -> issue URL, so a retry gets the same issue.
CREATE TABLE filed (
  id TEXT PRIMARY KEY,
  issue_url TEXT NOT NULL,
  filed_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Items being filed: a short lock (locked_until) so two concurrent sends make one issue, and
-- the number of attempts, so a retry knows to look for an issue an earlier attempt may have
-- created before it timed out. Removed once filed (or after 30 days).
CREATE TABLE pending (
  id TEXT PRIMARY KEY,
  locked_until INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  first_attempt_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Rate-limit counters: key = rl:<kind>:<who>:<window number>.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Install IDs the owner has blocked (see docs/runbooks/feedback-relay-setup.md).
CREATE TABLE blocked (
  install_id TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
) WITHOUT ROWID;
