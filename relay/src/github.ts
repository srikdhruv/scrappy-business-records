// The few GitHub REST calls the relay makes: commit a screenshot, open an issue.

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

/** GitHub could not be reached or refused us; the app should retry later (502). */
export class UpstreamError extends Error {}

export interface GitHubEnv {
  GITHUB_TOKEN: string;
  FEEDBACK_REPO: string;
}

interface GitHubResponse {
  status: number;
  // GitHub's JSON; only a few fields are read, each checked before use.
  json: Record<string, any> | null;
}

async function call(env: GitHubEnv, method: string, path: string, body?: unknown): Promise<GitHubResponse> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "scrappy-feedback-relay",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError("could not reach GitHub");
  }
  let json: Record<string, any> | null = null;
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    // An empty or non-JSON body; callers decide from the status alone.
  }
  return { status: res.status, json };
}

function htmlUrl(json: Record<string, any> | null, pick: (j: Record<string, any>) => unknown): string | null {
  const url = json ? pick(json) : null;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/** Where a screenshot is committed: screenshots/YYYY/MM/<id>.jpg (UTC month of created_at). */
export function screenshotPath(id: string, createdAt: Date, contentType: string): string {
  const yyyy = String(createdAt.getUTCFullYear()).padStart(4, "0");
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  return `screenshots/${yyyy}/${mm}/${id}.${contentType === "image/png" ? "png" : "jpg"}`;
}

/** Commit the screenshot; returns its GitHub page URL. A file already there
 * (a retry after a crash) counts as done. */
export async function commitScreenshot(env: GitHubEnv, id: string, path: string, base64: string): Promise<string> {
  const url = `/repos/${env.FEEDBACK_REPO}/contents/${path}`;
  const put = await call(env, "PUT", url, { message: `Screenshot for feedback ${id}`, content: base64 });
  if (put.status === 200 || put.status === 201) {
    const link = htmlUrl(put.json, (j) => j.content?.html_url);
    if (link) return link;
    throw new UpstreamError("GitHub did not return the screenshot's URL");
  }
  if (put.status === 422 || put.status === 409) {
    const get = await call(env, "GET", url);
    const link = get.status === 200 ? htmlUrl(get.json, (j) => j.html_url) : null;
    if (link) return link;
    throw new UpstreamError(`GitHub said ${put.status} for the screenshot`);
  }
  throw new UpstreamError(`GitHub said ${put.status} for the screenshot`);
}

/** Open the issue; returns its URL. On 422 (e.g. a label GitHub won't take) retry once without labels. */
export async function createIssue(env: GitHubEnv, title: string, body: string, labels: string[]): Promise<string> {
  const url = `/repos/${env.FEEDBACK_REPO}/issues`;
  let res = await call(env, "POST", url, { title, body, labels });
  if (res.status === 422) res = await call(env, "POST", url, { title, body });
  if (res.status === 201) {
    const link = htmlUrl(res.json, (j) => j.html_url);
    if (link) return link;
    throw new UpstreamError("GitHub did not return the issue's URL");
  }
  throw new UpstreamError(`GitHub said ${res.status} for the issue`);
}
