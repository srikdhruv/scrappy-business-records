// Scrappy Records feedback relay.
//
// The app's local server POSTs one feedback item to /feedback; this Worker files it as an issue
// in the private feedback repo (screenshot committed alongside) and answers with the issue URL.
// Setup and operations: docs/runbooks/feedback-relay-setup.md.
//
// Privacy: nothing about the feedback itself is ever logged (message, route, environment, log,
// screenshot, IP). Logs carry only the first 8 characters of the id, the outcome and a status.

import { commitScreenshot, createIssue, screenshotPath, UpstreamError } from "./github";
import { issueBody, issueTitle } from "./markdown";
import { checkRateLimit } from "./ratelimit";
import { validate } from "./validate";

export interface Env {
  /** Fine-grained GitHub token (Issues + Contents, feedback repo only). A Worker secret. */
  GITHUB_TOKEN: string;
  /** owner/name of the private repo issues go to. */
  FEEDBACK_REPO: string;
  /** owner/name of the app's code repo, for build-ID commit links. */
  CODE_REPO: string;
  FEEDBACK_KV: KVNamespace;
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** How long `fb:<id>` -> issue URL is remembered, so a retry gets the same issue. */
const DEDUP_TTL_SECONDS = 400 * 86_400;

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
  const kv = env.FEEDBACK_KV;

  // Dedup first: a retry of something already filed is never refused or counted.
  const existing = await kv.get(`fb:${fb.id}`);
  if (existing) {
    log(fb.id, "duplicate", 200);
    return json(200, { status: "created", issue_url: existing });
  }

  if ((await kv.get(`block:${fb.installId}`)) !== null) {
    log(fb.id, "blocked", 403);
    return json(403, { status: "blocked", error: "this install is blocked from sending feedback" });
  }

  const retryAfter = await checkRateLimit(kv, fb.installId, request.headers.get("CF-Connecting-IP"));
  if (retryAfter !== null) {
    log(fb.id, "rate_limited", 429);
    return json(
      429,
      { status: "rate_limited", error: "too much feedback at once; try again later" },
      { "Retry-After": String(retryAfter) },
    );
  }

  try {
    let screenshotUrl: string | null = null;
    if (fb.screenshot) {
      const path = screenshotPath(fb.id, fb.createdAt, fb.screenshot.contentType);
      screenshotUrl = await commitScreenshot(env, fb.id, path, fb.screenshot.base64);
    }
    const issueUrl = await createIssue(
      env,
      issueTitle(fb),
      issueBody(fb, { codeRepo: env.CODE_REPO, screenshotUrl }),
      [fb.category, `v${fb.appVersion}`],
    );
    try {
      await kv.put(`fb:${fb.id}`, issueUrl, { expirationTtl: DEDUP_TTL_SECONDS });
    } catch {
      // The issue exists; answer 201 anyway so the app stops sending it.
      log(fb.id, "dedup_store_failed", 201);
    }
    log(fb.id, "created", 201);
    return json(201, { status: "created", issue_url: issueUrl });
  } catch (e) {
    if (e instanceof UpstreamError) {
      log(fb.id, "upstream_error", 502);
      return json(502, { status: "upstream_error", error: e.message });
    }
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(405, { error: "method not allowed" }, { Allow: "GET" });
      }
      return json(200, { ok: true });
    }
    if (pathname === "/feedback") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
      try {
        return await handleFeedback(request, env);
      } catch {
        // Unexpected (e.g. KV down). Say only that it failed; the app retries 5xx later.
        log("-", "error", 500);
        return json(500, { status: "error", error: "internal error" });
      }
    }
    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
