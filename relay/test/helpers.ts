// Test doubles: a D1 database backed by real SQLite (node:sqlite, with the real migration),
// and a scripted fake of GitHub's API.

import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import schema from "../migrations/0001_init.sql?raw";
import worker, { type Env } from "../src/index";

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  /** Run synchronously (used by batch inside a transaction). */
  rows(): Record<string, unknown>[] {
    this.db.check(this.sql);
    return this.db.sqlite
      .prepare(this.sql)
      .all(...this.params)
      .map((r) => ({ ...r }));
  }

  async first(): Promise<Record<string, unknown> | null> {
    return this.rows()[0] ?? null;
  }

  async all(): Promise<{ results: Record<string, unknown>[]; success: true; meta: object }> {
    return { results: this.rows(), success: true, meta: {} };
  }

  async run(): Promise<{ results: Record<string, unknown>[]; success: true; meta: object }> {
    return this.all();
  }
}

export class FakeD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  /** SQL matching this throws, to simulate D1 being down or over its daily limit. */
  failOn: RegExp | null = null;
  /** Every statement run, in order. */
  statements: string[] = [];

  constructor() {
    this.sqlite.exec(schema);
  }

  check(sql: string): void {
    this.statements.push(sql);
    if (this.failOn?.test(sql)) throw new Error("D1_ERROR: simulated failure");
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ results: Record<string, unknown>[] }[]> {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => ({ results: s.rows(), success: true, meta: {} }));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  /** Run a query directly, for assertions. */
  query(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.sqlite
      .prepare(sql)
      .all(...params)
      .map((r) => ({ ...r }));
  }

  /** Statements that change data (the ones D1 bills as "rows written"). */
  writeStatements(): string[] {
    return this.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
  }
}

export const FEEDBACK_REPO = "srikdhruv/scrappy-records-feedback";
export const CODE_REPO = "srikdhruv/scrappy-business-records";

export function makeEnv(db = new FakeD1()): Env & { db: FakeD1 } {
  return {
    GITHUB_TOKEN: "test-token",
    FEEDBACK_REPO,
    CODE_REPO,
    DB: db as unknown as D1Database,
    db,
  };
}

export interface GitHubCall {
  method: string;
  url: string;
  headers: Headers;
  body: any;
}

type Handler = (call: GitHubCall) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const API = `https://api.github.com/repos/${FEEDBACK_REPO}`;

/** Default GitHub: private repo, screenshots branch exists, PUT contents -> 201, issue #12. */
export const defaultGitHub: Handler = (call) => {
  if (call.method === "GET" && call.url === API) return jsonResponse(200, { full_name: FEEDBACK_REPO, private: true });
  if (call.method === "GET" && call.url === `${API}/git/ref/heads/screenshots`) {
    return jsonResponse(200, { ref: "refs/heads/screenshots", object: { sha: "abc" } });
  }
  if (call.method === "PUT" && call.url.includes("/contents/")) {
    const path = call.url.split("/contents/")[1];
    return jsonResponse(201, { content: { html_url: `https://github.com/${FEEDBACK_REPO}/blob/screenshots/${path}` } });
  }
  if (call.method === "POST" && call.url === `${API}/issues`) {
    return jsonResponse(201, { number: 12, html_url: `https://github.com/${FEEDBACK_REPO}/issues/12` });
  }
  return jsonResponse(404, { message: "Not Found" });
};

/** Replace globalThis.fetch with `handler`; returns the list of calls made. */
export function mockGitHub(handler: Handler = defaultGitHub): GitHubCall[] {
  const calls: GitHubCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const call: GitHubCall = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

/** Only the calls that file things (skips the repo privacy check and branch lookup). */
export function writes(calls: GitHubCall[]): GitHubCall[] {
  return calls.filter((c) => c.method !== "GET");
}

// A tiny valid-looking JPEG and PNG (the magic bytes are what the relay checks).
export const JPEG_B64 = btoa("\xff\xd8\xff\xe0" + "x".repeat(60));
export const PNG_B64 = btoa("\x89PNG\r\n\x1a\n" + "y".repeat(60));

export function sampleFeedback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: "3F0E8C1A-5B7D-4E2A-9C1F-0A1B2C3D4E5F",
    install_id: "9d7b2c10-1111-4222-8333-444455556666",
    category: "problem",
    message: "The dashboard shows ₹0 for Ananya Rao\nsecond line",
    created_at: "2026-09-30T10:15:00Z",
    local_time: "2026-09-30T15:45:00+05:30",
    app_version: "0.1.0",
    build_id: "9386553c0ffee0123456789abcdef0123456789a",
    route: "/students?q=ana",
    environment: { os: "Windows-10-10.0.19045-SP0", python: "3.12.14", screen: "1440x900" },
    errors: [{ at: "2026-09-30T10:14:58Z", kind: "api", message: "GET /api/students -> 500" }],
    log_tail: "INFO started\nERROR something broke\n",
    screenshot: { content_type: "image/jpeg", data_base64: JPEG_B64 },
    ...overrides,
  };
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://relay.example/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function send(env: Env, request: Request): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await worker.fetch(request, env);
  return { status: res.status, body: await res.json(), headers: res.headers };
}
