-- Feedback relay storage (Cloudflare D1). Applied by `wrangler d1 migrations apply`.
-- WITHOUT ROWID + primary key only, so each insert/update costs one "row written".
-- Nothing here is personal: ids are random UUIDs, IPs appear only as truncated hashes.

-- Feedback already filed: id -> issue URL, so a retry gets the same issue.
CREATE TABLE filed (
  id TEXT PRIMARY KEY,
  issue_url TEXT NOT NULL,
  filed_at INTEGER NOT NULL
) WITHOUT ROWID;

-- A short lock while one item is being filed, so two concurrent sends make one issue.
CREATE TABLE pending (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
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
