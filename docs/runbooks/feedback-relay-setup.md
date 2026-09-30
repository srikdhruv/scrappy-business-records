# Setting up the feedback relay

When someone uses **Send feedback** in the app, the app's server sends it to a small program on
Cloudflare (the "relay", code in [`relay/`](../../relay)). The relay files it as an issue, with its
screenshot, in the private repo `srikdhruv/scrappy-records-feedback`. The relay holds the GitHub
token, so no token ever ships inside the app.

Until the relay is set up and its address is in a released version of the app, feedback is kept
on the laptop and sent later. Nothing is lost.

This is a one-time setup, about 20 minutes. You need a terminal with `git`, `gh` (logged in as
`srikdhruv`) and Node.js 24, in a clone of this repo. `npx wrangler …` downloads Cloudflare's
command-line tool (Wrangler) the first time; nothing needs installing.

## 1. Create a Cloudflare account

Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough (100,000 requests a day).
Verify your email address.

## 2. Create a Cloudflare API token (for GitHub Actions)

GitHub Actions uses this to deploy the relay.

1. In the Cloudflare dashboard: **My Profile → API Tokens → Create Token**.
2. Next to **Edit Cloudflare Workers**, click **Use template**.
3. Under **Account Resources** choose *Include → your account*. Under **Zone Resources** choose
   *All zones* (the relay doesn't use any, but the template asks).
4. **Continue to summary → Create Token**. Copy the token now; Cloudflare shows it only once.

## 3. Find your Cloudflare account ID

Either:

- Dashboard: **Workers & Pages** → the **Account ID** is in the right-hand sidebar of the
  overview page (click to copy); or
- Terminal: `npx wrangler login` (opens the browser to allow access), then `npx wrangler whoami`,
  which prints the account name and ID.

## 4. Add both to the GitHub repo's secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN -R srikdhruv/scrappy-business-records   # paste the token
gh secret set CLOUDFLARE_ACCOUNT_ID -R srikdhruv/scrappy-business-records  # paste the account ID
```

Or on the web: the repo's **Settings → Secrets and variables → Actions → New repository secret**,
once for each.

## 5. Create a GitHub token for the relay

This lets the relay open issues and save screenshots in the feedback repo, and nothing else.

1. GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
2. Name: `scrappy-feedback-relay`. Expiration: **1 year** (put a reminder in your calendar a
   week before, to rotate it: [step 11](#11-rotate-the-tokens)).
3. Resource owner: `srikdhruv`.
4. Repository access: **Only select repositories** → `scrappy-records-feedback`.
5. Permissions → Repository permissions:
   - **Issues: Read and write**
   - **Contents: Read and write** (for screenshots)
   - Metadata: Read-only is added automatically.
6. **Generate token** and copy it.

## 6. Give the token to the relay

```bash
cd relay
npx wrangler login                    # skip if you did it in step 3
npx wrangler secret put GITHUB_TOKEN  # paste the token from step 5
```

If the Worker `scrappy-feedback` doesn't exist yet, Wrangler asks whether to create it; answer
yes. It creates an empty Worker holding the secret, and the first deploy (step 8) puts the code in
it. The secret is encrypted by Cloudflare and never appears in this repo or in the logs.

(Once the Worker exists you can also do this in the dashboard: **Workers & Pages →
scrappy-feedback → Settings → Variables and Secrets → Add**, type *Secret*, name `GITHUB_TOKEN`.)

## 7. Create the storage the relay uses (KV)

The relay remembers which feedback it has already filed, and counts requests for its limits, in a
small Cloudflare key-value store:

```bash
cd relay
npx wrangler kv namespace create FEEDBACK_KV
```

It prints a block ending with `id = "…"`. Open `relay/wrangler.toml`, replace
`REPLACE_WITH_KV_NAMESPACE_ID` with that id (the id isn't a secret), and commit it via a PR:

```bash
git checkout -b chore/relay-kv-id
git commit -am "chore(relay): set the KV namespace id"
gh pr create --fill
```

## 8. First deploy

Merging that PR into `main` runs **Relay (feedback Worker)** (`.github/workflows/relay.yml`),
which tests the relay and deploys it. (Before steps 4 and 7 are done, that workflow just prints a
notice that the relay isn't set up and skips the deploy; it never fails.) You can also run it by
hand from the repo's **Actions** tab, or deploy from your laptop:

```bash
cd relay && npm ci && npx wrangler deploy
```

The deploy prints the relay's address, `https://scrappy-feedback.<your-subdomain>.workers.dev`
(the subdomain is also on the dashboard's **Workers & Pages** overview). Check it's alive:

```bash
curl https://scrappy-feedback.<your-subdomain>.workers.dev/health
# {"ok":true}
```

## 9. Put the relay's address into the app

In `backend/app/config.py` set:

```python
FEEDBACK_URL = "https://scrappy-feedback.<your-subdomain>.workers.dev/feedback"
```

Commit it via a PR, merge it, then release a new version ([release runbook](release.md)). Until
that version is installed, the app keeps feedback on the laptop; once the new version is
installed it sends everything that was waiting.

## 10. Test it end to end

**(a) With curl.** A made-up item; `uuidgen` gives a fresh id:

```bash
RELAY=https://scrappy-feedback.<your-subdomain>.workers.dev
ID=$(uuidgen)
curl -sS -X POST "$RELAY/feedback" -H 'Content-Type: application/json' -d @- <<EOF
{
  "schema": 1,
  "id": "$ID",
  "install_id": "00000000-0000-4000-8000-000000000001",
  "category": "question",
  "message": "Test from the setup runbook: how do I add Kabir Mehta?",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "local_time": "",
  "app_version": "0.0.0",
  "build_id": "dev",
  "route": "/students",
  "environment": {"os": "test"},
  "errors": [],
  "log_tail": "",
  "screenshot": null
}
EOF
```

It answers `{"status":"created","issue_url":"https://github.com/srikdhruv/scrappy-records-feedback/issues/1"}`.
Run the same `curl` again (same `$ID`): you get the **same** `issue_url` back and no second
issue. Check the issue:

```bash
gh issue list -R srikdhruv/scrappy-records-feedback
```

Close it when you're done: `gh issue close <number> -R srikdhruv/scrappy-records-feedback`.

**(b) From the app, before releasing.** Point your dev copy at the relay:

```bash
SCRAPPY_FEEDBACK_URL=https://scrappy-feedback.<your-subdomain>.workers.dev/feedback make run
```

Open <http://127.0.0.1:8765>, click the gear button → **Send feedback**, write something, and
send it. The issue appears in the feedback repo within a few seconds, with the screenshot.

## 11. Rotate the tokens

**GitHub token** (yearly, or at once if it may have leaked):

1. Create a new one exactly as in [step 5](#5-create-a-github-token-for-the-relay).
2. `cd relay && npx wrangler secret put GITHUB_TOKEN` and paste the new one. It takes effect
   straight away.
3. Delete the old token on GitHub (**Settings → Developer settings → Fine-grained tokens**).

Nothing in the app changes.

**Cloudflare API token:** create a new one as in [step 2](#2-create-a-cloudflare-api-token-for-github-actions),
run `gh secret set CLOUDFLARE_API_TOKEN -R srikdhruv/scrappy-business-records` with it, then
delete the old one under **My Profile → API Tokens**.

## 12. If spam arrives

The relay is only reachable by someone who knows its address, and it already limits how much it
accepts: per app install, 10 an hour and 30 a day; per internet address, 20 an hour. Over the
limit it answers "try later" and the app waits and retries.

In order of effort:

1. **Close or delete the junk issues** (`gh issue close <n> -R srikdhruv/scrappy-records-feedback`,
   or **Delete issue** at the bottom of an issue's page).
2. **Block one install.** Every issue's table shows its *Install ID*. Block it with:

   ```bash
   cd relay
   npx wrangler kv key put --binding FEEDBACK_KV --remote "block:<install-id>" 1
   ```

   The relay then answers `403 {"status":"blocked"}` to that install, and the app treats that as
   final (it stops sending those items). Undo it with
   `npx wrangler kv key delete --binding FEEDBACK_KV --remote "block:<install-id>"`.
   (`--remote` matters: without it Wrangler only changes a local test copy.) Don't block the real
   laptop's install ID.
3. **Lower the limits.** Edit `INSTALL_PER_HOUR`, `INSTALL_PER_DAY` and `IP_PER_HOUR` in
   `relay/src/ratelimit.ts`, and merge it via a PR (the workflow deploys it).
4. **Last resort: move the relay to a new address.** Change `name` in `relay/wrangler.toml`
   (e.g. `scrappy-feedback-2`), deploy, set the GitHub token on it again (step 6), update
   `FEEDBACK_URL` (step 9) and release. Then delete the old Worker:
   `npx wrangler delete --name scrappy-feedback`. Older app versions can't send until updated.

## Triage

```bash
gh issue list -R srikdhruv/scrappy-records-feedback                    # everything open
gh issue list -R srikdhruv/scrappy-records-feedback --label problem    # just problems (or idea, question)
gh issue list -R srikdhruv/scrappy-records-feedback --label v0.1.0     # from one app version
gh issue view <number> -R srikdhruv/scrappy-records-feedback --web     # open one in the browser
```

Each issue has the message, a table (time in UTC and on the laptop, app version, build ID, the
page it was sent from, install ID, system details), the app's recent errors, the last lines of the
server log (click **Server log** to expand), and the screenshot. Screenshots are files in the
feedback repo under `screenshots/YYYY/MM/<feedback-id>.jpg` (or `.png`). The build ID links to the
exact commit of this repo that the laptop was running, so you can read the code as it was.

## What the relay does, and what it never keeps

- It checks each item, files it as an issue (committing the screenshot first), and answers with
  the issue's address. Sending the same item twice gives the same issue.
- It has no database and no backups. The feedback lives only in the GitHub repo.
- Its storage (KV) holds only: feedback id → issue address (kept 400 days, so retries find it);
  request counters, which expire within two days and use a one-way scrambled (hashed) form of
  the internet address, never the address itself; and any `block:` entries you add.
- Its logs never contain the message, page, system details, server log, screenshot or internet
  address: only the first 8 characters of the feedback id, what happened, and a status number.

## Replies the relay gives the app

| Reply | Meaning | What the app does |
|---|---|---|
| `201` / `200` `{"status":"created","issue_url":…}` | Filed (200: already filed earlier) | Marks it sent |
| `400` `{"status":"invalid"}` | Something in it is malformed | Gives up on it |
| `403` `{"status":"blocked"}` | That install is blocked (step 12) | Gives up on it |
| `413` `{"status":"too_large"}` | Over 2 MiB | Gives up on it |
| `429` `{"status":"rate_limited"}` + `Retry-After` | Over the limits | Tries again later |
| `502` `{"status":"upstream_error"}` | GitHub couldn't be reached or refused (e.g. an expired token) | Tries again later |

If feedback stays "waiting" in the app for a day, look at the relay's live log
(`cd relay && npx wrangler tail`) while sending one; a string of `upstream_error` usually means the
GitHub token expired (step 11).
