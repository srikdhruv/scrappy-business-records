// The GitHub REST calls the relay makes: check the feedback repo is private, keep a
// `screenshots` branch, commit a screenshot to it, open an issue.
//
// Time: every call gets at most CALL_TIMEOUT_MS, and all calls for one item share
// BUDGET_MS in total, so one item never takes much longer than BUDGET_MS.

const API = "https://api.github.com";
export const CALL_TIMEOUT_MS = 10_000;
export const BUDGET_MS = 40_000;
/** The repo's privacy is re-checked at most this often per Worker instance. */
const REPO_CHECK_TTL_MS = 10 * 60_000;
export const SCREENSHOT_BRANCH = "screenshots";

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

// Per-instance memory (not KV/D1, so it costs no writes). Reset between tests.
let repoCheck: { repo: string; isPrivate: boolean; at: number } | null = null;
export function resetCaches(): void {
  repoCheck = null;
}

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const BRANCH_README = `# Screenshots

Screenshots attached to feedback issues, filed by the feedback relay.
Deleting this branch purges them all; the relay creates it again when the next screenshot arrives.
`;

const REPO_README = `# Scrappy Records feedback

Feedback sent from the app, filed as issues by the feedback relay.
Screenshots are on the \`${SCREENSHOT_BRANCH}\` branch.
`;

export class GitHub {
  private readonly endsAt: number;

  constructor(
    private readonly env: GitHubEnv,
    nowMs: number = Date.now(),
  ) {
    this.endsAt = nowMs + BUDGET_MS;
  }

  private repoPath(rest = ""): string {
    return `/repos/${this.env.FEEDBACK_REPO}${rest}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<GitHubResponse> {
    const left = this.endsAt - Date.now();
    if (left < 1000) throw new UpstreamError("GitHub took too long");
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "scrappy-feedback-relay",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
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

  /** True only if GitHub confirms the feedback repo is private. A failed check is false (not cached). */
  async repoIsPrivate(): Promise<boolean> {
    const repo = this.env.FEEDBACK_REPO;
    if (repoCheck && repoCheck.repo === repo && Date.now() - repoCheck.at < REPO_CHECK_TTL_MS) {
      return repoCheck.isPrivate;
    }
    let res: GitHubResponse;
    try {
      res = await this.call("GET", this.repoPath());
    } catch {
      return false;
    }
    if (res.status !== 200 || !res.json) return false;
    const isPrivate = res.json.private === true;
    repoCheck = { repo, isPrivate, at: Date.now() };
    return isPrivate;
  }

  /** Make sure the `screenshots` branch exists: an orphan branch, separate from the default one. */
  async ensureScreenshotBranch(): Promise<void> {
    const ref = await this.call("GET", this.repoPath(`/git/ref/heads/${SCREENSHOT_BRANCH}`));
    if (ref.status === 200) return;
    // 404: no such branch. 409: the repo is completely empty.
    if (ref.status !== 404 && ref.status !== 409) throw new UpstreamError(`GitHub said ${ref.status} for the branch`);

    const treeBody = { tree: [{ path: "README.md", mode: "100644", type: "blob", content: BRANCH_README }] };
    let tree = await this.call("POST", this.repoPath("/git/trees"), treeBody);
    if (tree.status === 409) {
      // The git data API refuses empty repos: give the default branch a README first.
      const init = await this.call("PUT", this.repoPath("/contents/README.md"), {
        message: "Start the feedback repo",
        content: b64(REPO_README),
      });
      if (init.status !== 201 && init.status !== 200 && init.status !== 422) {
        throw new UpstreamError(`GitHub said ${init.status} for the repo README`);
      }
      tree = await this.call("POST", this.repoPath("/git/trees"), treeBody);
    }
    const treeSha = tree.json?.sha;
    if (tree.status !== 201 || typeof treeSha !== "string") throw new UpstreamError(`GitHub said ${tree.status} for the tree`);

    const commit = await this.call("POST", this.repoPath("/git/commits"), {
      message: "Start the screenshots branch",
      tree: treeSha,
      parents: [],
    });
    const commitSha = commit.json?.sha;
    if (commit.status !== 201 || typeof commitSha !== "string") {
      throw new UpstreamError(`GitHub said ${commit.status} for the commit`);
    }

    const created = await this.call("POST", this.repoPath("/git/refs"), {
      ref: `refs/heads/${SCREENSHOT_BRANCH}`,
      sha: commitSha,
    });
    // 422 "Reference already exists": another request created it first. Fine.
    if (created.status !== 201 && created.status !== 422) {
      throw new UpstreamError(`GitHub said ${created.status} for the branch`);
    }
  }

  /** Commit the screenshot to the screenshots branch; returns its GitHub page URL.
   * A file already there (a retry after a crash) counts as done. */
  async commitScreenshot(id: string, path: string, base64: string): Promise<string> {
    await this.ensureScreenshotBranch();
    const url = this.repoPath(`/contents/${path}`);
    const put = await this.call("PUT", url, {
      message: `Screenshot for feedback ${id}`,
      content: base64,
      branch: SCREENSHOT_BRANCH,
    });
    if (put.status === 200 || put.status === 201) {
      const link = httpsUrl(put.json?.content?.html_url);
      if (link) return link;
      throw new UpstreamError("GitHub did not return the screenshot's URL");
    }
    if (put.status === 422 || put.status === 409) {
      const get = await this.call("GET", `${url}?ref=${SCREENSHOT_BRANCH}`);
      const link = get.status === 200 ? httpsUrl(get.json?.html_url) : null;
      if (link) return link;
    }
    throw new UpstreamError(`GitHub said ${put.status} for the screenshot`);
  }

  /** Open the issue; returns its URL. On 422 (e.g. a label GitHub won't take) retry once without labels. */
  async createIssue(title: string, body: string, labels: string[]): Promise<string> {
    const url = this.repoPath("/issues");
    let res = await this.call("POST", url, { title, body, labels });
    if (res.status === 422) res = await this.call("POST", url, { title, body });
    if (res.status === 201) {
      const link = httpsUrl(res.json?.html_url);
      if (link) return link;
      throw new UpstreamError("GitHub did not return the issue's URL");
    }
    throw new UpstreamError(`GitHub said ${res.status} for the issue`);
  }
}

function httpsUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

/** Where a screenshot is committed: screenshots/YYYY/MM/<id>.jpg (UTC month of created_at). */
export function screenshotPath(id: string, createdAt: Date, contentType: string): string {
  const yyyy = String(createdAt.getUTCFullYear()).padStart(4, "0");
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  return `screenshots/${yyyy}/${mm}/${id}.${contentType === "image/png" ? "png" : "jpg"}`;
}
