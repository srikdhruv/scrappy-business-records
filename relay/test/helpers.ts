// Test doubles: an in-memory KV namespace and a scripted fake of GitHub's API.

import { vi } from "vitest";
import worker, { type Env } from "../src/index";

export class FakeKV {
  store = new Map<string, string>();
  puts: { key: string; value: string; options?: KVNamespacePutOptions }[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.puts.push({ key, value, options });
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export const FEEDBACK_REPO = "srikdhruv/scrappy-records-feedback";
export const CODE_REPO = "srikdhruv/scrappy-business-records";

export function makeEnv(kv = new FakeKV()): Env & { kv: FakeKV } {
  return {
    GITHUB_TOKEN: "test-token",
    FEEDBACK_REPO,
    CODE_REPO,
    FEEDBACK_KV: kv as unknown as KVNamespace,
    kv,
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

/** Default GitHub behaviour: PUT contents -> 201, POST issues -> 201 #12. */
export const defaultGitHub: Handler = (call) => {
  if (call.method === "PUT" && call.url.includes("/contents/")) {
    const path = call.url.split("/contents/")[1];
    return jsonResponse(201, { content: { html_url: `https://github.com/${FEEDBACK_REPO}/blob/main/${path}` } });
  }
  if (call.method === "POST" && call.url.endsWith("/issues")) {
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
