// Scrappy Records feedback relay.
//
// The app's local server POSTs one feedback item to /feedback; this Worker files it as an issue
// in the private feedback repo (screenshot committed to its `screenshots` branch) and answers
// with the issue URL. Setup and operations: docs/runbooks/feedback-relay-setup.md.
//
// Only three statuses are final for the app: "invalid" (400), "too_large" (413) and "blocked"
// (403). Every other answer is retried later, so nothing is lost when something is down.
//
// Privacy: nothing about the feedback itself is ever logged (message, route, environment, log,
// screenshot, IP). Logs carry only the first 8 characters of the id, the outcome and a status.

import { acquireLock, lookup, recordFiled, releaseLock, StoreUnavailable } from "./db";
import { GitHub, screenshotPath, UpstreamError } from "./github";
import { feedbackMarker, issueBody, issueTitle } from "./markdown";
import { countFiled, reserve } from "./ratelimit";
import { validate } from "./validate";

export interface Env {
  /** Fine-grained GitHub token (Issues + Contents, feedback repo only). A Worker secret. */
  GITHUB_TOKEN: string;
  /** owner/name of the private repo issues go to. */
  FEEDBACK_REPO: string;
  /** owner/name of the app's code repo, for build-ID commit links. */
  CODE_REPO: string;
  /** Dedup, locks, rate-limit counters and blocks (migrations/). */
  DB: D1Database;
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Retry-After when storage is down, and when the repo check fails. */
const UNAVAILABLE_RETRY_SECONDS = 300;
const MISCONFIGURED_RETRY_SECONDS = 3600;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function log(id: string, outcome: string, status: number): void {
  console.log(JSON.stringify({ id: id.slice(0, 8), outcome, status }));
}

/** Read the body, stopping as soon as it goes over `limit` bytes (returns null then). */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) {
    log("-", "too_large", 413);
    return json(413, { status: "too_large", error: "request body must be at most 2 MiB" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    log("-", "invalid", 400);
    return json(400, { status: "invalid", error: "body must be valid JSON" });
  }

  const result = validate(parsed);
  if (!result.ok) {
    log("-", "invalid", 400);
    return json(400, { status: "invalid", error: result.error });
  }
  const fb = result.feedback;
  const db = env.DB;

  // Dedup first: a retry of something already filed is never refused or counted.
  const known = await lookup(db, fb.id, fb.installId);
  if (known.issueUrl) {
    log(fb.id, "duplicate", 200);
    return json(200, { status: "created", issue_url: known.issueUrl });
  }
  if (known.blocked) {
    log(fb.id, "blocked", 403);
    return json(403, { status: "blocked", error: "this install is blocked from sending feedback" });
  }

  const retryAfter = await reserve(db, fb.installId, request.headers.get("CF-Connecting-IP"), Date.now());
  if (retryAfter !== null) {
    log(fb.id, "rate_limited", 429);
    return json(
      429,
      { status: "rate_limited", error: "too much feedback for now; try again later" },
      { "Retry-After": String(retryAfter) },
    );
  }

  const github = new GitHub(env);
  if (!(await github.repoIsPrivate())) {
    log(fb.id, "misconfigured", 503);
    return json(
      503,
      { status: "misconfigured", error: "feedback repo is not private" },
      { "Retry-After": String(MISCONFIGURED_RETRY_SECONDS) },
    );
  }

  // One request at a time per id, so two concurrent sends can't make two issues. The same
  // transaction re-checks `filed`, in case another request filed it since our first lookup.
  const lock = await acquireLock(db, fb.id, Date.now());
  if (lock.kind === "busy") {
    log(fb.id, "in_progress", 409);
    return json(409, { status: "in_progress", error: "this feedback is being filed" }, { "Retry-After": "60" });
  }
  if (lock.kind === "filed") {
    log(fb.id, "duplicate", 200);
    return json(200, { status: "created", issue_url: lock.issueUrl });
  }

  // Did GitHub create the issue? Unknown once we've sent the request and not heard back.
  let issueRequested = false;
  let issueUrl: string;
  let found = false;
  try {
    // A retry: an earlier attempt may have created the issue and then timed out. Look first.
    const earlier = lock.attempts > 1 ? await github.findIssueByMarker(feedbackMarker(fb.id), lock.firstAttemptMs) : null;
    if (earlier) {
      issueUrl = earlier;
      found = true;
    } else {
      let screenshotUrl: string | null = null;
      if (fb.screenshot) {
        const path = screenshotPath(fb.id, fb.createdAt, fb.screenshot.contentType);
        screenshotUrl = await github.commitScreenshot(fb.id, path, fb.screenshot.base64);
      }
      issueRequested = true;
      issueUrl = await github.createIssue(
        issueTitle(fb),
        issueBody(fb, { codeRepo: env.CODE_REPO, screenshotUrl }),
        [fb.category, `v${fb.appVersion}`],
      );
    }
  } catch (e) {
    // If the issue may exist, keep the lock until it expires: GitHub may still be creating it,
    // and the next attempt will look for it. Otherwise let the retry in straight away.
    if (!issueRequested) await releaseLock(db, fb.id);
    if (e instanceof UpstreamError) {
      log(fb.id, "upstream_error", 502);
      return json(502, { status: "upstream_error", error: e.message });
    }
    throw e;
  }

  try {
    await recordFiled(db, fb.id, issueUrl, Date.now(), [countFiled(db, Date.now())]);
  } catch {
    // The issue exists; answer 2xx anyway so the app stops sending it.
    log(fb.id, "record_failed", found ? 200 : 201);
  }
  if (found) {
    log(fb.id, "found_earlier", 200);
    return json(200, { status: "created", issue_url: issueUrl });
  }
  log(fb.id, "created", 201);
  return json(201, { status: "created", issue_url: issueUrl });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(405, { status: "method_not_allowed", error: "use GET" }, { Allow: "GET" });
      }
      return json(200, { ok: true });
    }
    if (pathname === "/feedback") {
      if (request.method !== "POST") {
        return json(405, { status: "method_not_allowed", error: "use POST" }, { Allow: "POST" });
      }
      try {
        return await handleFeedback(request, env);
      } catch (e) {
        if (e instanceof StoreUnavailable) {
          // Fail closed: without storage there's no dedup or limit, so nothing goes through.
          log("-", "unavailable", 503);
          return json(
            503,
            { status: "unavailable", error: "storage unavailable; try again later" },
            { "Retry-After": String(UNAVAILABLE_RETRY_SECONDS) },
          );
        }
        log("-", "error", 500);
        return json(500, { status: "error", error: "internal error" });
      }
    }
    return json(404, { status: "not_found", error: "not found" });
  },
} satisfies ExportedHandler<Env>;
