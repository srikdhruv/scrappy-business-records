import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetCaches } from "../src/github";
import { GLOBAL_ATTEMPTS_PER_DAY, GLOBAL_FILED_PER_DAY, INSTALL_PER_DAY, INSTALL_PER_HOUR, IP_PER_HOUR } from "../src/ratelimit";
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
  statefulGitHub,
  writes,
} from "./helpers";

const ID = "3f0e8c1a-5b7d-4e2a-9c1f-0a1b2c3d4e5f";
const ISSUE_URL = `https://github.com/${FEEDBACK_REPO}/issues/12`;
const API = `https://api.github.com/repos/${FEEDBACK_REPO}`;
const FINAL = ["invalid", "too_large", "blocked"];

/** A fresh feedback id per call, so rate-limit tests aren't short-circuited by dedup. */
function freshId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

beforeEach(() => {
  resetCaches();
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

  it("404s other paths and 405s wrong methods, without a final status", async () => {
    const env = makeEnv();
    const answers = [
      await worker.fetch(new Request("https://relay.example/nope"), env),
      await worker.fetch(new Request("https://relay.example/feedback"), env),
      await worker.fetch(new Request("https://relay.example/health", { method: "DELETE" }), env),
    ];
    expect(answers.map((r) => r.status)).toEqual([404, 405, 405]);
    for (const r of answers) expect(FINAL).not.toContain(((await r.json()) as any).status);
  });
});

describe("happy path", () => {
  it("checks the repo, commits the screenshot to its branch, opens the issue, returns 201", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const res = await send(env, post(sampleFeedback()));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "created", issue_url: ISSUE_URL });
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, "")}`)).toEqual([
      "GET ",
      "GET /git/ref/heads/screenshots",
      `PUT /contents/screenshots/2026/09/${ID}.jpg`,
      "POST /issues",
    ]);

    const [, , put, issue] = calls;
    expect(put!.body.message).toBe(`Screenshot for feedback ${ID}`);
    expect(put!.body.branch).toBe("screenshots");
    expect(put!.body.content).toBe((sampleFeedback().screenshot as any).data_base64);
    expect(put!.headers.get("Authorization")).toBe("Bearer test-token");
    expect(put!.headers.get("Accept")).toBe("application/vnd.github+json");
    expect(put!.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(put!.headers.get("User-Agent")).toBeTruthy();

    expect(issue!.body.title).toBe("[Problem] The dashboard shows ₹0 for Ananya Rao");
    expect(issue!.body.labels).toEqual(["problem", "v0.1.0"]);

    const body: string = issue!.body.body;
    expect(body.startsWith("```text\nThe dashboard shows ₹0 for Ananya Rao\nsecond line\n```\n")).toBe(true);
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
    const shot = `https://github.com/${FEEDBACK_REPO}/blob/screenshots/screenshots/2026/09/${ID}.jpg`;
    expect(body).toContain(`![Screenshot](${shot}?raw=true)`);
    expect(body).toContain(`(${shot})`);
    expect(body).toContain(`<!-- feedback-id: ${ID} -->`);

    expect(env.db.query("SELECT issue_url FROM filed WHERE id = ?1", ID)).toEqual([{ issue_url: ISSUE_URL }]);
    expect(env.db.query("SELECT * FROM pending")).toEqual([]);
  });

  it("uses .png for PNG screenshots and skips the branch and commit when there is none", async () => {
    const env = makeEnv();
    let calls = mockGitHub();
    await send(env, post(sampleFeedback({ screenshot: { content_type: "image/png", data_base64: PNG_B64 } })));
    expect(writes(calls)[0]!.url).toMatch(/screenshots\/2026\/09\/3f0e8c1a-[0-9a-f-]+\.png$/);

    vi.restoreAllMocks();
    calls = mockGitHub();
    const res = await send(env, post(sampleFeedback({ id: freshId(1), screenshot: null })));
    expect(res.status).toBe(201);
    expect(calls.map((c) => c.method)).toEqual(["POST"]); // repo check cached, no branch lookup
    expect(calls[0]!.body.body).not.toContain("Screenshot");
  });

  it("does not link build IDs that aren't commit hashes", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ build_id: "dev", screenshot: null })));
    const body: string = writes(calls)[0]!.body.body;
    expect(body).toContain("| Build | dev |");
    expect(body).not.toContain("/commit/");
  });

  it("costs few D1 writes per filed item", async () => {
    const env = makeEnv();
    mockGitHub();
    await send(env, post(sampleFeedback()));
    // 4 counter upserts (1 batch), 1 lock (+ a read of filed), then filed + attempt record +
    // sweep + the filed counter (1 batch).
    expect(env.db.writeStatements()).toHaveLength(9);
  });
});

describe("dedup", () => {
  it("returns the same issue URL for a repeat id without calling GitHub again", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const first = await send(env, post(sampleFeedback()));
    const before = calls.length;
    const second = await send(env, post(sampleFeedback()));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "created", issue_url: ISSUE_URL });
    expect(calls.length).toBe(before);
  });

  it("a retry of a filed id is never rate limited or counted", async () => {
    const env = makeEnv();
    mockGitHub();
    await send(env, post(sampleFeedback()));
    for (let n = 1; n < INSTALL_PER_HOUR; n++) {
      expect((await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })))).status).toBe(201);
    }
    expect((await send(env, post(sampleFeedback({ id: freshId(99) })))).status).toBe(429);
    const writesBefore = env.db.writeStatements().length;
    const retry = await send(env, post(sampleFeedback()));
    expect(retry.status).toBe(200);
    expect(retry.body.issue_url).toBe(ISSUE_URL);
    expect(env.db.writeStatements().length).toBe(writesBefore);
  });
});

describe("concurrent sends and retries", () => {
  const lockRow = (until: number, attempts = 1) =>
    `INSERT INTO pending (id, locked_until, attempts, first_attempt_at) VALUES ('${ID}', ${until}, ${attempts}, ${until - 120})`;

  it("answers 409 in_progress while another request holds the lock", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    env.db.sqlite.exec(lockRow(Math.floor(Date.now() / 1000) + 100));
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("in_progress");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(writes(calls)).toHaveLength(0);
  });

  it("two requests for the same id at once make exactly one issue", async () => {
    const env = makeEnv();
    const { issues } = statefulGitHub(() => new Promise((r) => setTimeout(r, 20)));
    const [a, b] = await Promise.all([send(env, post(sampleFeedback())), send(env, post(sampleFeedback()))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(issues).toHaveLength(1);
    const retry = await send(env, post(sampleFeedback()));
    expect(retry.status).toBe(200);
    expect(retry.body.issue_url).toBe(issues[0]!.html_url);
    expect(issues).toHaveLength(1);
  });

  it("returns the filed URL if another request filed it just before we took the lock", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const other = `https://github.com/${FEEDBACK_REPO}/issues/7`;
    env.db.onSql = (sql) => {
      if (sql.includes("INSERT INTO pending")) {
        env.db.onSql = null;
        env.db.sqlite.exec(`INSERT INTO filed (id, issue_url, filed_at) VALUES ('${ID}', '${other}', 0)`);
      }
    };
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(200);
    expect(res.body.issue_url).toBe(other);
    expect(writes(calls)).toHaveLength(0);
    expect(env.db.query("SELECT * FROM pending")).toEqual([]);
  });

  it("a timeout after GitHub created the issue, then a retry: no second issue, same URL", async () => {
    const env = makeEnv();
    let first = true;
    const { issues, calls } = statefulGitHub(() => {
      if (first) {
        first = false;
        throw new TypeError("connection reset"); // GitHub made it; we never heard back
      }
    });
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(issues).toHaveLength(1);

    // The lock is kept (the issue may exist), so an immediate retry waits.
    expect((await send(env, post(sampleFeedback()))).status).toBe(409);

    vi.setSystemTime(new Date("2026-09-30T10:22:01Z")); // lock expired
    const retry = await send(env, post(sampleFeedback()));
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ status: "created", issue_url: issues[0]!.html_url });
    expect(issues).toHaveLength(1);
    const list = calls.find((c) => c.method === "GET" && c.url.startsWith(`${API}/issues?`));
    expect(list!.url).toContain("state=all");
    expect(list!.url).toContain("since=2026-09-30T10:10:00.000Z"); // first attempt minus 10 min
    expect(env.db.query("SELECT issue_url FROM filed")).toEqual([{ issue_url: issues[0]!.html_url }]);
    expect((await send(env, post(sampleFeedback()))).status).toBe(200);
  });

  it("the first attempt doesn't list issues; a retry that finds none files normally", async () => {
    const env = makeEnv();
    let calls = mockGitHub((call) => (call.method === "PUT" ? jsonResponse(500, {}) : defaultGitHub(call)));
    expect((await send(env, post(sampleFeedback()))).status).toBe(502);
    expect(calls.some((c) => c.url.startsWith(`${API}/issues?`))).toBe(false);
    // Failed before the issue was requested, so the lock is released at once.
    vi.restoreAllMocks();
    calls = mockGitHub();
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.url.startsWith(`${API}/issues?`))).toBe(true);
    expect(calls.filter((c) => c.method === "POST" && c.url === `${API}/issues`)).toHaveLength(1);
  });

  it("ignores issues whose marker is for another id, or only quoted in the text", async () => {
    const env = makeEnv();
    env.db.sqlite.exec(lockRow(Math.floor(Date.now() / 1000) - 1, 1));
    const calls = mockGitHub((call) => {
      if (call.method === "GET" && call.url.startsWith(`${API}/issues?`)) {
        return jsonResponse(200, [
          { html_url: "https://github.com/x/y/issues/3", body: `quoting <!-- feedback-id: ${ID} --> here\n\n<!-- feedback-id: other -->\n` },
        ]);
      }
      return defaultGitHub(call);
    });
    const res = await send(env, post(sampleFeedback({ screenshot: null })));
    expect(res.status).toBe(201);
    expect(res.body.issue_url).toBe(ISSUE_URL);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("takes over an expired lock", async () => {
    const env = makeEnv();
    mockGitHub();
    env.db.sqlite.exec(lockRow(Math.floor(Date.now() / 1000) - 1));
    expect((await send(env, post(sampleFeedback()))).status).toBe(201);
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
    expect((await send(makeEnv(), post("{not json"))).body.status).toBe("invalid");
    expect((await send(makeEnv(), post("[1, 2]"))).body.status).toBe("invalid");
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
    expect(res.headers.get("Retry-After")).toBe(String(40 * 60)); // 10:20 now; the hour ends at 11:00
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
      const res = await send(env, post(sampleFeedback({ id: freshId(n), install_id: freshId(n), screenshot: null })));
      expect(res.status).toBe(201);
    }
    const res = await send(env, post(sampleFeedback({ id: freshId(999), install_id: freshId(999), screenshot: null })));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);

    const other = await send(
      env,
      post(sampleFeedback({ id: freshId(1000), install_id: freshId(1000), screenshot: null }), {
        "CF-Connecting-IP": "198.51.100.9",
      }),
    );
    expect(other.status).toBe(201);

    const keys = env.db.query("SELECT key FROM counters").map((r) => String(r.key));
    expect(keys.some((k) => k.startsWith("rl:ip:"))).toBe(true);
    expect(keys.join(" ")).not.toContain("203.0.113.7");
  });

  it("caps filed issues for everyone at GLOBAL_FILED_PER_DAY a UTC day, until midnight", async () => {
    const env = makeEnv();
    mockGitHub();
    for (let n = 0; n < GLOBAL_FILED_PER_DAY; n++) {
      const ip = `198.51.100.${n}`;
      const res = await send(env, post(sampleFeedback({ id: freshId(n), install_id: freshId(n), screenshot: null }), { "CF-Connecting-IP": ip }));
      expect(res.status).toBe(201);
    }
    const res = await send(
      env,
      post(sampleFeedback({ id: freshId(777), install_id: freshId(777), screenshot: null }), { "CF-Connecting-IP": "192.0.2.1" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(13 * 3600 + 40 * 60)); // 10:20 -> 00:00 UTC

    vi.setSystemTime(new Date("2026-10-01T00:00:05Z"));
    const nextDay = await send(
      env,
      post(sampleFeedback({ id: freshId(778), install_id: freshId(778), screenshot: null }), { "CF-Connecting-IP": "192.0.2.1" }),
    );
    expect(nextDay.status).toBe(201);
  });

  it("failed attempts don't count towards the filed cap, only the attempt cap", async () => {
    const env = makeEnv();
    mockGitHub((call) => (call.method === "POST" ? jsonResponse(500, {}) : defaultGitHub(call)));
    for (let n = 0; n < 3; n++) {
      expect((await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })))).status).toBe(502);
    }
    const counts = Object.fromEntries(env.db.query("SELECT key, count FROM counters").map((r) => [String(r.key).split(":")[1], r.count]));
    expect(counts.g).toBe(3);
    expect(counts.gf).toBeUndefined();
  });

  it("caps attempts for everyone at GLOBAL_ATTEMPTS_PER_DAY", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    const day = Math.floor(Date.now() / 86_400_000);
    env.db.sqlite.exec(`INSERT INTO counters (key, count, expires_at) VALUES ('rl:g:all:${day}', ${GLOBAL_ATTEMPTS_PER_DAY}, ${(day + 1) * 86_400})`);
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(13 * 3600 + 40 * 60));
    expect(calls).toHaveLength(0);
  });

  it("over-limit requests cost no D1 writes", async () => {
    const env = makeEnv();
    mockGitHub();
    for (let n = 0; n < INSTALL_PER_HOUR; n++) await send(env, post(sampleFeedback({ id: freshId(n), screenshot: null })));
    const before = env.db.writeStatements().length;
    for (let n = 0; n < 5; n++) {
      expect((await send(env, post(sampleFeedback({ id: freshId(200 + n), screenshot: null })))).status).toBe(429);
    }
    expect(env.db.writeStatements().length).toBe(before);
  });
});

describe("fail closed", () => {
  for (const [name, failOn] of [
    ["counters can't be read or written", /counters/],
    ["counters can't be written", /INSERT INTO counters/],
    ["the dedup lookup fails", /FROM filed/],
    ["the lock can't be taken", /INSERT INTO pending/],
  ] as const) {
    it(`answers 503 unavailable when ${name}, and files nothing`, async () => {
      const env = makeEnv();
      env.db.failOn = failOn;
      const calls = mockGitHub();
      const res = await send(env, post(sampleFeedback()));
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unavailable");
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(writes(calls)).toHaveLength(0);
    });
  }

  it("still answers 201 if only recording the filed issue fails", async () => {
    const env = makeEnv();
    env.db.failOn = /INSERT OR IGNORE INTO filed/;
    mockGitHub();
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(201);
    expect(res.body.issue_url).toBe(ISSUE_URL);
  });
});

describe("blocked installs", () => {
  it("answers 403 blocked for a blocked install ID", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    env.db.sqlite.exec("INSERT INTO blocked (install_id) VALUES ('9d7b2c10-1111-4222-8333-444455556666')");
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

describe("feedback repo must be private", () => {
  it("refuses with 503 misconfigured when the repo is public, and files nothing", async () => {
    const env = makeEnv();
    const calls = mockGitHub((call) =>
      call.method === "GET" && call.url === API ? jsonResponse(200, { private: false }) : defaultGitHub(call),
    );
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "misconfigured", error: "feedback repo is not private" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses when the check itself fails, and doesn't cache the failure", async () => {
    const env = makeEnv();
    let calls = mockGitHub((call) => (call.url === API ? jsonResponse(500, {}) : defaultGitHub(call)));
    expect((await send(env, post(sampleFeedback()))).body.status).toBe("misconfigured");
    expect(writes(calls)).toHaveLength(0);
    vi.restoreAllMocks();
    calls = mockGitHub();
    expect((await send(env, post(sampleFeedback()))).status).toBe(201);
    expect(calls.filter((c) => c.url === API)).toHaveLength(1);
  });

  it("checks at most once per 10 minutes", async () => {
    const env = makeEnv();
    const calls = mockGitHub();
    await send(env, post(sampleFeedback({ id: freshId(1), screenshot: null })));
    await send(env, post(sampleFeedback({ id: freshId(2), screenshot: null })));
    vi.setSystemTime(new Date("2026-09-30T10:29:00Z"));
    await send(env, post(sampleFeedback({ id: freshId(3), screenshot: null })));
    expect(calls.filter((c) => c.url === API)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-09-30T10:31:00Z"));
    await send(env, post(sampleFeedback({ id: freshId(4), screenshot: null })));
    expect(calls.filter((c) => c.url === API)).toHaveLength(2);
  });
});

describe("screenshots branch", () => {
  function noBranch(refStatus: number, refPost: number, treeFirst = 201) {
    let trees = 0;
    return mockGitHub((call) => {
      const path = call.url.replace(API, "");
      if (path === "/git/ref/heads/screenshots") return jsonResponse(refStatus, { message: "Not Found" });
      if (path === "/git/trees") return ++trees === 1 && treeFirst !== 201 ? jsonResponse(treeFirst, {}) : jsonResponse(201, { sha: "tree1" });
      if (path === "/git/commits") return jsonResponse(201, { sha: "commit1" });
      if (path === "/git/refs") return jsonResponse(refPost, {});
      if (path === "/contents/README.md") return jsonResponse(201, { content: {} });
      return defaultGitHub(call);
    });
  }

  it("creates it as an orphan branch when missing, then commits to it", async () => {
    const calls = noBranch(404, 201);
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(201);
    const paths = writes(calls).map((c) => `${c.method} ${c.url.replace(API, "")}`);
    expect(paths).toEqual(["POST /git/trees", "POST /git/commits", "POST /git/refs", `PUT /contents/screenshots/2026/09/${ID}.jpg`, "POST /issues"]);
    const [tree, commit, ref, put] = writes(calls);
    expect(tree!.body.base_tree).toBeUndefined();
    expect(commit!.body.parents).toEqual([]);
    expect(commit!.body.tree).toBe("tree1");
    expect(ref!.body).toEqual({ ref: "refs/heads/screenshots", sha: "commit1" });
    expect(put!.body.branch).toBe("screenshots");
  });

  it("is fine when another request created it first (422 on the ref)", async () => {
    noBranch(404, 422);
    expect((await send(makeEnv(), post(sampleFeedback()))).status).toBe(201);
  });

  it("starts an empty repo with a README on the default branch first", async () => {
    const calls = noBranch(409, 201, 409);
    expect((await send(makeEnv(), post(sampleFeedback()))).status).toBe(201);
    const paths = writes(calls).map((c) => `${c.method} ${c.url.replace(API, "")}`);
    expect(paths.slice(0, 4)).toEqual(["POST /git/trees", "PUT /contents/README.md", "POST /git/trees", "POST /git/commits"]);
    expect(writes(calls)[1]!.body.branch).toBeUndefined();
  });

  it("502s if the branch can't be created", async () => {
    noBranch(404, 500);
    expect((await send(makeEnv(), post(sampleFeedback()))).status).toBe(502);
  });
});

describe("GitHub trouble", () => {
  it("treats a screenshot that already exists (422) as done", async () => {
    const shotUrl = `https://github.com/${FEEDBACK_REPO}/blob/screenshots/screenshots/2026/09/${ID}.jpg`;
    const calls = mockGitHub((call) => {
      if (call.method === "PUT") return jsonResponse(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (call.method === "GET" && call.url.includes("/contents/")) return jsonResponse(200, { html_url: shotUrl });
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(201);
    const get = calls.find((c) => c.method === "GET" && c.url.includes("/contents/"));
    expect(get!.url).toBe(`${API}/contents/screenshots/2026/09/${ID}.jpg?ref=screenshots`);
    expect(writes(calls).at(-1)!.body.body).toContain(`![Screenshot](${shotUrl}?raw=true)`);
  });

  it("retries the issue once without labels on 422", async () => {
    const calls = mockGitHub((call) => {
      if (call.method === "POST" && call.body.labels) return jsonResponse(422, { message: "Validation Failed" });
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback({ screenshot: null })));
    expect(res.status).toBe(201);
    const posts = writes(calls);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.labels).toEqual(["problem", "v0.1.0"]);
    expect(posts[1]!.body.labels).toBeUndefined();
  });

  it.each([500, 503, 401, 403])("answers 502 when GitHub says %i for the issue, and records nothing", async (status) => {
    const env = makeEnv();
    mockGitHub((call) => (call.method === "POST" ? jsonResponse(status, { message: "nope" }) : defaultGitHub(call)));
    const res = await send(env, post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("upstream_error");
    expect(env.db.query("SELECT * FROM filed")).toEqual([]);
  });

  it("answers 502 when GitHub can't be reached mid-way", async () => {
    mockGitHub((call) => {
      if (call.method === "PUT") throw new TypeError("network down");
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("could not reach GitHub");
  });

  it("gives up with 502 once the total time budget is spent", async () => {
    const calls = mockGitHub((call) => {
      vi.setSystemTime(Date.now() + 15_000); // every call takes 15 s
      return defaultGitHub(call);
    });
    const res = await send(makeEnv(), post(sampleFeedback()));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("GitHub took too long");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]); // 45 s used; the issue isn't tried
  });
});

describe("issue body safety", () => {
  async function bodyFor(message: string): Promise<string> {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ message, screenshot: null })));
    return writes(calls)[0]!.body.body;
  }

  it("puts the whole message in a code block, exactly as typed", async () => {
    const message = "see https://example.com and www.example.com, #12, owner/repo#3, GH-4\n![x](a.png) [y](b) <!-- hi";
    const body = await bodyFor(message);
    expect(body.startsWith("```text\n" + message + "\n```\n")).toBe(true);
  });

  it("uses a longer fence than any backticks in the message, so ``` can't break out", async () => {
    const body = await bodyFor("before\n```\nunclosed and ```` longer");
    expect(body.startsWith("`````text\nbefore\n```\nunclosed and ```` longer\n`````\n")).toBe(true);
  });

  it("neutralises @-mentions even inside the code block", async () => {
    const body = await bodyFor("Please tell @kabir-mehta and @org/team");
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(body).toContain("@\u200bkabir-mehta");
  });

  it("neutralises references and mentions in the title and the details table", async () => {
    const calls = mockGitHub();
    await send(
      makeEnv(),
      post(sampleFeedback({ message: "Fix #12 and GH-3 for @ananya", route: "/students#4", screenshot: null })),
    );
    const { title, body } = writes(calls)[0]!.body;
    expect(title).toBe("[Problem] Fix #\u200b12 and GH\u200b-3 for @\u200bananya");
    expect(body).toContain("| Route | /students\\#\u200b4 |");
  });

  it("fences the log tail with more backticks than it contains", async () => {
    const calls = mockGitHub();
    const log = "line one\n````\n</details>\n``` still inside\n";
    await send(makeEnv(), post(sampleFeedback({ log_tail: log, screenshot: null })));
    const body: string = writes(calls)[0]!.body.body;
    expect(body).toContain("`````text\nline one\n````\n</details>\n``` still inside\n`````\n\n</details>");
  });

  it("trims long first lines in the title", async () => {
    const calls = mockGitHub();
    await send(makeEnv(), post(sampleFeedback({ category: "idea", message: "word ".repeat(40), screenshot: null })));
    const title: string = writes(calls)[0]!.body.title;
    expect(title.startsWith("[Idea] word word")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title.replace("[Idea] ", "")).length).toBeLessThanOrEqual(80);
  });
});

describe("privacy", () => {
  it("never logs the message, route, environment, log tail or IP", async () => {
    const seen: string[] = [];
    const record = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    const spyConsole = () => {
      for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(record);
    };
    spyConsole();

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
    spyConsole();
    mockGitHub(() => jsonResponse(500, { message: "Kabir Mehta" }));
    await send(makeEnv(), post(secretish)); // repo check fails
    const broken = makeEnv();
    broken.db.failOn = /counters/;
    await send(broken, post(secretish)); // storage down
    await send(makeEnv(), post(sampleFeedback({ message: "" }))); // invalid

    expect(seen.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    for (const forbidden of ["Kabir", "/students", "SecretOS", "LOGLINE", "203.0.113.7", "3f0e8c1a-5b7d"]) {
      expect(all).not.toContain(forbidden);
    }
    expect(all).toContain("3f0e8c1a");
  });
});
