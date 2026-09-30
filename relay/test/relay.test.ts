import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { INSTALL_PER_DAY, INSTALL_PER_HOUR, IP_PER_HOUR } from "../src/ratelimit";
import {
  CODE_REPO,
  FEEDBACK_REPO,
  defaultGitHub,
  jsonResponse,
  makeEnv,
  mockGitHub,
  PNG_B64,
  post,
  sampleFeedback,
  send,
} from "./helpers";

const ID = "3f0e8c1a-5b7d-4e2a-9c1f-0a1b2c3d4e5f";
const ISSUE_URL = `https://github.com/${FEEDBACK_REPO}/issues/12`;

/** A fresh feedback id per call, so rate-limit tests aren't short-circuited by dedup. */
function freshId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T10:20:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routing", () => {
  it("answers /health", async () => {
    const res = await worker.fetch(new Request("https://relay.example/health"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s other paths and 405s wrong methods", async () => {
    const env = makeEnv();
    expect((await worker.fetch(new Request("https://relay.example/nope"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://relay.example/feedback"), env)).status).toBe(405);
    const del = new Request("https://relay.example/health", { method: "DELETE" });
    expect((await worker.fetch(del, env)).status).toBe(405);
  });
});

describe("happy path", () => {
  it("commits the screenshot, opens the issue and returns 201 with its URL", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const res = await send(env, post(sampleFeedback()));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "created", issue_url: ISSUE_URL });
    expect(calls).toHaveLength(2);

    const [put, issue] = calls;
    expect(put!.method).toBe("PUT");
    expect(put!.url).toBe(`https://api.github.com/repos/${FEEDBACK_REPO}/contents/screenshots/2026/09/${ID}.jpg`);
    expect(put!.body.message).toBe(`Screenshot for feedback ${ID}`);
    expect(put!.body.content).toBe((sampleFeedback().screenshot as any).data_base64);
    expect(put!.headers.get("Authorization")).toBe("Bearer test-token");
    expect(put!.headers.get("Accept")).toBe("application/vnd.github+json");
    expect(put!.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(put!.headers.get("User-Agent")).toBeTruthy();

    expect(issue!.method).toBe("POST");
    expect(issue!.url).toBe(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`);
    expect(issue!.body.title).toBe("[Problem] The dashboard shows ₹0 for Ananya Rao");
    expect(issue!.body.labels).toEqual(["problem", "v0.1.0"]);

    const body: string = issue!.body.body;
    expect(body).toContain("The dashboard shows ₹0 for Ananya Rao\nsecond line");
    expect(body).toContain("| Created (UTC) | 2026-09-30T10:15:00Z |");
    expect(body).toContain("| Local time | 2026-09-30T15:45:00+05:30 |");
    expect(body).toContain("| App version | 0.1.0 |");
    expect(body).toContain(
      `[\`9386553c0ffe\`](https://github.com/${CODE_REPO}/commit/9386553c0ffee0123456789abcdef0123456789a)`,
    );
    expect(body).toContain("| Route | /students?q=ana |");
    expect(body).toContain("| Install ID | `9d7b2c10-1111-4222-8333-444455556666` |");
    expect(body).toContain("| os | Windows-10-10.0.19045-SP0 |");
    expect(body).toContain("- 2026-09-30T10:14:58Z · api · GET /api/students -\\> 500");
    expect(body).toContain("<details><summary>Server log (last lines)</summary>");
    expect(body).toContain("INFO started\nERROR something broke");
    const shot = `https://github.com/${FEEDBACK_REPO}/blob/main/screenshots/2026/09/${ID}.jpg`;
    expect(body).toContain(`![Screenshot](${shot}?raw=true)`);
    expect(body).toContain(`(${shot})`);
    expect(body).toContain(`<!-- feedback-id: ${ID} -->`);

    expect(env.kv.store.get(`fb:${ID}`)).toBe(ISSUE_URL);
  });

  it("uses .png for PNG screenshots and skips the commit when there is none", async () => {
    const env = makeEnv();
    let calls = mockGitHub();
    await send(env, post(sampleFeedback({ screenshot: { content_type: "image/png", data_base64: PNG_B64 } })));
    expect(calls[0]!.url).toMatch(/screenshots\/2026\/09\/3f0e8c1a-[0-9a-f-]+\.png$/);

    vi.restoreAllMocks();
    calls = mockGitHub();
    const res = await send(env, post(sampleFeedback({ id: freshId(1), screenshot: null })));
    expect(res.status).toBe(201);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0]!.body.body).not.toContain("Screenshot");
  });

  it("does not link build IDs that aren't commit hashes", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ build_id: "dev", screenshot: null })));
    const body: string = calls[0]!.body.body;
    expect(body).toContain("| Build | dev |");
    expect(body).not.toContain("/commit/");
  });
});

describe("dedup", () => {
  it("returns the same issue URL for a repeat id without calling GitHub again", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const first = await send(env, post(sampleFeedback()));
    const second = await send(env, post(sampleFeedback()));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "created", issue_url: ISSUE_URL });
    expect(calls).toHaveLength(2); // just the first request's two calls
  });

  it("stores the id with a long expiry", async () => {
    const env = makeEnv();
    mockGitHub();
    await send(env, post(sampleFeedback()));
    const stored = env.kv.puts.find((p) => p.key === `fb:${ID}`);
    expect(stored?.options?.expirationTtl).toBeGreaterThanOrEqual(365 * 86_400);
  });

  it("a retry of a filed id is never rate limited or counted", async () => {
    const env = makeEnv();
    mockGitHub();
    await send(env, post(sampleFeedback()));
    // Use up the per-install hourly allowance with other ids.
    for (let n = 1; n < INSTALL_PER_HOUR; n++) {
      expect((await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })))).status).toBe(201);
    }
    expect((await send(env, post(sampleFeedback({ id: freshId(99) })))).status).toBe(429);
    const putsBefore = env.kv.puts.length;
    const retry = await send(env, post(sampleFeedback()));
    expect(retry.status).toBe(200);
    expect(retry.body.issue_url).toBe(ISSUE_URL);
    expect(env.kv.puts.length).toBe(putsBefore);
  });
});

describe("validation", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["bad category", { category: "complaint" }, /category/],
    ["empty message", { message: "   \n " }, /message must be 1-5000/],
    ["too-long message", { message: "a".repeat(5001) }, /message must be 1-5000/],
    ["bad uuid", { id: "not-a-uuid" }, /id must be a UUID/],
    ["bad install id", { install_id: "1234" }, /install_id must be a UUID/],
    ["schema != 1", { schema: 2 }, /schema must be 1/],
    ["bad created_at", { created_at: "yesterday" }, /created_at/],
    ["impossible date", { created_at: "2026-02-30T10:00:00Z" }, /created_at/],
    ["non-UTC created_at", { created_at: "2026-09-30T15:45:00+05:30" }, /created_at/],
    ["bad app_version", { app_version: "1.0 beta" }, /app_version/],
    ["bad build_id", { build_id: "a/b" }, /build_id/],
    ["long route", { route: "/".repeat(501) }, /route/],
    ["too many env keys", { environment: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"])) }, /environment/],
    ["non-string env value", { environment: { screen: 1440 } }, /environment values/],
    ["too many errors", { errors: Array.from({ length: 21 }, () => ({ at: "", kind: "api", message: "x" })) }, /errors/],
    ["bad error entry", { errors: [{ at: "x", kind: "k".repeat(21), message: "m" }] }, /error kind/],
    ["long log tail", { log_tail: "x".repeat(65_537) }, /log_tail/],
    ["bad content type", { screenshot: { content_type: "image/gif", data_base64: "R0lGOD==" } }, /content_type/],
    ["bad base64", { screenshot: { content_type: "image/jpeg", data_base64: "not base64!!" } }, /not valid base64/],
    ["not really a JPEG", { screenshot: { content_type: "image/jpeg", data_base64: btoa("hello world!") } }, /not a valid JPEG/],
    [
      "too-large screenshot",
      { screenshot: { content_type: "image/jpeg", data_base64: btoa("\xff\xd8\xff" + "x".repeat(1_500_000)) } },
      /at most 1500000 bytes/,
    ],
  ];

  for (const [name, overrides, error] of cases) {
    it(`rejects ${name} with 400`, async () => {
      const calls = mockGitHub();
      const res = await send(makeEnv(), post(sampleFeedback(overrides)));
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("invalid");
      expect(res.body.error).toMatch(error);
      expect(calls).toHaveLength(0);
    });
  }

  it("rejects bad JSON and non-objects with 400", async () => {
    mockGitHub();
    expect((await send(makeEnv(), post("{not json"))).status).toBe(400);
    expect((await send(makeEnv(), post("[1, 2]"))).status).toBe(400);
  });

  it("ignores unknown extra keys", async () => {
    mockGitHub();
    const res = await send(makeEnv(), post(sampleFeedback({ future_field: { anything: true } })));
    expect(res.status).toBe(201);
  });

  it("rejects bodies over 2 MiB with 413", async () => {
    const calls = mockGitHub();
    const big = JSON.stringify(sampleFeedback({ log_tail: "x".repeat(2 * 1024 * 1024) }));
    const res = await send(makeEnv(), post(big));
    expect(res.status).toBe(413);
    expect(res.body.status).toBe("too_large");
    expect(calls).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("limits each install per hour with Retry-After", async () => {
    const env = makeEnv();
    mockGitHub();
    for (let n = 0; n < INSTALL_PER_HOUR; n++) {
      expect((await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })))).status).toBe(201);
    }
    const res = await send(env, post(sampleFeedback({ id: freshId(100), screenshot: null })));
    expect(res.status).toBe(429);
    expect(res.body.status).toBe("rate_limited");
    // 10:20 now, so the hour window ends in 40 minutes.
    expect(res.headers.get("Retry-After")).toBe(String(40 * 60));
  });

  it("limits each install per day", async () => {
    const env = makeEnv();
    mockGitHub();
    let n = 0;
    for (let hour = 0; n < INSTALL_PER_DAY; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, hour, 5)));
      for (let k = 0; k < 5 && n < INSTALL_PER_DAY; k++, n++) {
        expect((await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })))).status).toBe(201);
      }
    }
    vi.setSystemTime(new Date("2026-09-30T20:00:00Z"));
    const res = await send(env, post(sampleFeedback({ id: freshId(500), screenshot: null })));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(4 * 3600));
  });

  it("limits each IP per hour across installs, storing only a hash of the IP", async () => {
    const env = makeEnv();
    mockGitHub();
    for (let n = 0; n < IP_PER_HOUR; n++) {
      const install = `9d7b2c10-1111-4222-8333-${String(n).padStart(12, "0")}`;
      const res = await send(env, post(sampleFeedback({ id: freshId(n), install_id: install, screenshot: null })));
      expect(res.status).toBe(201);
    }
    const res = await send(env, post(sampleFeedback({ id: freshId(999), install_id: freshId(999), screenshot: null })));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);

    // A different IP is still let through.
    const other = await send(
      env,
      post(sampleFeedback({ id: freshId(1000), install_id: freshId(1000), screenshot: null }), {
        "CF-Connecting-IP": "198.51.100.9",
      }),
    );
    expect(other.status).toBe(201);

    const keys = [...env.kv.store.keys()];
    expect(keys.some((k) => k.startsWith("rl:ip:"))).toBe(true);
    expect(keys.join(" ")).not.toContain("203.0.113.7");
    expect(env.kv.puts.every((p) => !p.value.includes("203.0.113.7"))).toBe(true);
    for (const p of env.kv.puts.filter((p) => p.key.startsWith("rl:"))) {
      expect(p.options?.expirationTtl).toBeGreaterThan(0);
    }
  });
});

describe("blocked installs", () => {
  it("answers 403 blocked for an install ID with a block: key", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    env.kv.store.set("block:9d7b2c10-1111-4222-8333-444455556666", "1");
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

describe("GitHub trouble", () => {
  it("treats a screenshot that already exists (422) as done", async () => {
    const shotUrl = `https://github.com/${FEEDBACK_REPO}/blob/main/screenshots/2026/09/${ID}.jpg`;
    const calls = mockGitHub((call) => {
      if (call.method === "PUT") return jsonResponse(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (call.method === "GET") return jsonResponse(200, { html_url: shotUrl });
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(201);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "POST"]);
    expect(calls[1]!.url).toContain(`/contents/screenshots/2026/09/${ID}.jpg`);
    expect(calls[2]!.body.body).toContain(`![Screenshot](${shotUrl}?raw=true)`);
  });

  it("retries the issue once without labels on 422", async () => {
    const calls = mockGitHub((call) => {
      if (call.method === "POST" && call.body.labels) return jsonResponse(422, { message: "Validation Failed" });
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback({ screenshot: null })));
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.labels).toEqual(["problem", "v0.1.0"]);
    expect(calls[1]!.body.labels).toBeUndefined();
  });

  it.each([500, 503, 401, 403])("answers 502 when GitHub says %i, and files nothing", async (status) => {
    const env = makeEnv();
    mockGitHub(() => jsonResponse(status, { message: "nope" }));
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("upstream_error");
    expect(env.kv.store.has(`fb:${ID}`)).toBe(false);
  });

  it("answers 502 when GitHub can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("could not reach GitHub");
  });
});

describe("issue body safety", () => {
  it("neutralises @-mentions in the message", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ message: "Please tell @kabir-mehta and @org/team", screenshot: null })));
    const body: string = calls[0]!.body.body;
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(body).toContain("@​kabir-mehta");
  });

  it("fences the log tail with more backticks than it contains", async () => {
    const calls = mockGitHub();
    const log = "line one\n````\n</details>\n``` still inside\n";
    await send(makeEnv(), post(sampleFeedback({ log_tail: log, screenshot: null })));
    const body: string = calls[0]!.body.body;
    expect(body).toContain("`````text\nline one\n````\n</details>\n``` still inside\n`````\n\n</details>");
  });

  it("keeps an HTML comment in the message from hiding the rest of the issue", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ message: "oops <!-- unclosed", screenshot: null })));
    const body: string = calls[0]!.body.body;
    expect(body).toContain("oops &lt;!-- unclosed");
    expect(body.match(/<!--/g)).toHaveLength(1); // only the feedback-id marker
  });

  it("trims long first lines in the title", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ category: "idea", message: "word ".repeat(40), screenshot: null })));
    const title: string = calls[0]!.body.title;
    expect(title.startsWith("[Idea] word word")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title.replace("[Idea] ", "")).length).toBeLessThanOrEqual(80);
  });
});

describe("privacy", () => {
  it("never logs the message, route, environment, log tail or IP", async () => {
    const seen: string[] = [];
    const record = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "info").mockImplementation(record);

    const secretish = sampleFeedback({
      message: "Kabir Mehta paid late",
      route: "/students/kabir",
      environment: { os: "SecretOS-42" },
      log_tail: "LOGLINE-XYZ",
    });
    const env = makeEnv();
    mockGitHub();
    await send(env, post(secretish));
    await send(env, post(secretish)); // dedup path
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    mockGitHub(() => jsonResponse(500, { message: "Kabir Mehta" }));
    await send(makeEnv(), post(secretish)); // upstream error path
    await send(makeEnv(), post(sampleFeedback({ message: "" }))); // invalid path

    expect(seen.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    for (const forbidden of ["Kabir", "/students", "SecretOS", "LOGLINE", "203.0.113.7", "3f0e8c1a-5b7d"]) {
      expect(all).not.toContain(forbidden);
    }
    expect(all).toContain("3f0e8c1a");
  });
});
