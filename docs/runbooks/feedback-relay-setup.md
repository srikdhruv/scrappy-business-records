# Setting up the feedback relay

When someone uses **Send feedback** in the app, the app's server sends it to a small program on
Cloudflare (the "relay", code in [`relay/`](../../relay)). The relay files it as an issue in the
private repo `srikdhruv/scrappy-records-feedback`, with its screenshot saved in that repo. The
relay holds the GitHub token, so no token ever ships inside the app.

Until the relay is set up and its address is in a released version of the app, feedback is kept
on the laptop and sent later. Nothing is lost.

This is a one-time setup, about 20 minutes. You need a terminal with `git`, `gh` (logged in as
`srikdhruv`) and Node.js 24, in a clone of this repo. `npx wrangler …` downloads Cloudflare's
command-line tool (Wrangler) the first time; nothing needs installing.

## 1. Create a Cloudflare account

Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough (see
[Free-plan limits](#free-plan-limits-and-what-one-item-costs)). Verify your email address.

## 2. Create a Cloudflare API token (for GitHub Actions)

GitHub Actions uses this to set up the relay's database tables and deploy the relay.

1. In the Cloudflare dashboard: **My Profile → API Tokens → Create Token**.
2. Next to **Edit Cloudflare Workers**, click **Use template**.
3. The template doesn't cover the database, so under **Permissions** click **+ Add more** and add
   **Account → D1 → Edit**.
4. Under **Account Resources** choose *Include → your account*. Under **Zone Resources** choose
   *All zones* (the relay doesn't use any, but the template asks).
5. **Continue to summary → Create Token**. Copy the token now; Cloudflare shows it only once.

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

## 5. Check the feedback repo is private

Feedback can contain people's names and fees, so it must only ever go to a private repo:

```bash
gh repo view srikdhruv/scrappy-records-feedback --json isPrivate
# {"isPrivate":true}
```

It must say `true`. If it says `false`, make it private (the repo's **Settings → General →
Danger Zone → Change visibility**). The relay checks this too, before filing anything, and
refuses while the repo is public (the app keeps the feedback and tries again later). An empty
repo is fine: the relay adds a short README the first time.

## 6. Create a GitHub token for the relay

This lets the relay open issues and save screenshots in the feedback repo, and nothing else.

1. GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
2. Name: `scrappy-feedback-relay`. Expiration: **1 year** (put a reminder in your calendar a
   week before, to rotate it: [step 12](#12-rotate-the-tokens)).
3. Resource owner: `srikdhruv`.
4. Repository access: **Only select repositories** → `scrappy-records-feedback`.
5. Permissions → Repository permissions:
   - **Issues: Read and write**
   - **Contents: Read and write** (for screenshots)
   - Metadata: Read-only is added automatically (the relay uses it to check the repo is private).
6. **Generate token** and copy it.

## 7. Give the token to the relay, and create its database

From the repo's top folder:

```bash
cd relay
npx wrangler login                    # skip if you did it in step 3
npx wrangler secret put GITHUB_TOKEN  # paste the token from step 6
```

If the Worker `scrappy-feedback` doesn't exist yet, Wrangler asks whether to create it; answer
yes. It creates an empty Worker holding the secret, and the first deploy (step 9) puts the code in
it. The secret is encrypted by Cloudflare and never appears in this repo or in the logs.

(Once the Worker exists you can also do this in the dashboard: **Workers & Pages →
scrappy-feedback → Settings → Variables and Secrets → Add**, type *Secret*, name `GITHUB_TOKEN`.)

Still in `relay/`, create the small database the relay uses to remember what it has filed and
to count requests:

```bash
npx wrangler d1 create scrappy-feedback
```

It prints a block with `database_id = "…"`. Open `relay/wrangler.toml` and replace
`REPLACE_WITH_D1_DATABASE_ID` with that id (it isn't a secret). Then create its tables:

```bash
npx wrangler d1 migrations apply scrappy-feedback --remote   # answer yes
```

(The deploy workflow also runs this every time, so new tables added later are created
automatically.) Commit the id via a PR:

```bash
git checkout -b chore/relay-d1-id
git commit -am "chore(relay): set the D1 database id"
gh pr create --fill
```

## 8. Why D1 (and not the alternatives)

The relay has to count requests (per install, per internet address, and for everyone per day),
remember what it has filed, and make sure two copies of the same item sent at once give one
issue. Choices on the free plan:

- **Cloudflare's rate-limiting feature:** free, but it only counts over 10 or 60 seconds, and
  counts separately in each Cloudflare location, approximately. It can't do "30 a day" or "50 a
  day for everyone".
- **KV** (key-value storage): only 1,000 writes a day, and it can take up to a minute for a write
  to be seen elsewhere, with no "add one" that is safe when two requests arrive together. Counts
  and the "being filed" lock could be wrong.
- **Durable Objects:** would work (free plan, same quotas as D1), but need more code for no gain
  at this size.
- **D1** (a small SQL database): 100,000 row writes a day, and each update is all-or-nothing, so
  the counts and the lock are exact. One database holds everything.

If the database can't be reached (or its daily quota is used up), the relay refuses everything
with "try later" (503) rather than letting anything through unchecked. The app keeps the
feedback and retries.

## 9. First deploy

Merging that PR into `main` runs **Relay (feedback Worker)** (`.github/workflows/relay.yml`),
which tests the relay, applies the database tables, and deploys it. (Until steps 4 and 7 are
done, that workflow just prints a notice that the relay isn't set up and skips the deploy; it
never fails.) You can also run it by hand from the repo's **Actions** tab, or deploy from your
laptop:

```bash
cd relay && npm ci && npx wrangler deploy
```

The deploy prints the relay's address, `https://scrappy-feedback.<your-subdomain>.workers.dev`
(the subdomain is also on the dashboard's **Workers & Pages** overview). Check it's alive:

```bash
curl https://scrappy-feedback.<your-subdomain>.workers.dev/health
# {"ok":true}
```

## 10. Put the relay's address into the app

In `backend/app/config.py` set:

```python
FEEDBACK_URL = "https://scrappy-feedback.<your-subdomain>.workers.dev/feedback"
```

Commit it via a PR, merge it, then release a new version ([release runbook](release.md)). Until
that version is installed, the app keeps feedback on the laptop; once the new version is
installed it sends everything that was waiting.

## 11. Test it end to end

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
send it. The issue appears in the feedback repo within a few seconds, with the screenshot. The
first screenshot also creates the `screenshots` branch in the feedback repo.

## 12. Rotate the tokens

**GitHub token** (yearly, or at once if it may have leaked):

1. Create a new one exactly as in [step 6](#6-create-a-github-token-for-the-relay).
2. `cd relay && npx wrangler secret put GITHUB_TOKEN` and paste the new one. It takes effect
   straight away.
3. Delete the old token on GitHub (**Settings → Developer settings → Fine-grained tokens**).

Nothing in the app changes.

**Cloudflare API token:** create a new one as in [step 2](#2-create-a-cloudflare-api-token-for-github-actions),
run `gh secret set CLOUDFLARE_API_TOKEN -R srikdhruv/scrappy-business-records` with it, then
delete the old one under **My Profile → API Tokens**.

## 13. If spam arrives

The relay's address is **public**: it is written in `backend/app/config.py` in this public repo,
so anyone can find it and send it junk. Spam is possible. What bounds it:

- each app install: 10 an hour and 30 a day;
- each internet address: 20 an hour;
- everyone together: **50 filed items a day** (UTC). After that the relay answers "try later"
  until midnight UTC, and the app keeps its feedback and retries then.

So the worst a spammer can do is **50 junk issues (and up to 50 screenshots) a day**. Real
feedback sent that day waits until the next day; none is lost. A flood of more than 100,000
requests in a day would also use up the Worker's free daily allowance, which again only delays
real feedback until midnight UTC. Requests over a limit cost the database nothing but reads.

In order of effort:

1. **Close or delete the junk issues** (`gh issue close <n> -R srikdhruv/scrappy-records-feedback`,
   or **Delete issue** at the bottom of an issue's page).
2. **Block one install.** Every issue's table shows its *Install ID*. Block it with:

   ```bash
   cd relay
   npx wrangler d1 execute scrappy-feedback --remote \
     --command "INSERT INTO blocked (install_id) VALUES ('<install-id>')"
   ```

   The relay then answers `403 {"status":"blocked"}` to that install, and the app treats that as
   final (it stops sending those items). Undo it with
   `npx wrangler d1 execute scrappy-feedback --remote --command "DELETE FROM blocked WHERE install_id = '<install-id>'"`.
   (`--remote` matters: without it Wrangler only changes a local test copy.) Don't block the real
   laptop's install ID.
3. **Lower the limits.** Edit `INSTALL_PER_HOUR`, `INSTALL_PER_DAY`, `IP_PER_HOUR` and
   `GLOBAL_PER_DAY` in `relay/src/ratelimit.ts`, and merge it via a PR (the workflow deploys it).
4. **Last resort: move the relay to a new address.** Change `name` in `relay/wrangler.toml`
   (e.g. `scrappy-feedback-2`), deploy, set the GitHub token on it again (step 7), update
   `FEEDBACK_URL` (step 10) and release. Then delete the old Worker:
   `npx wrangler delete --name scrappy-feedback`. Older app versions can't send until updated.

## Free-plan limits, and what one item costs

Cloudflare's free plan, reset every day at 00:00 UTC:

| What | Free allowance | One filed item uses |
|---|---|---|
| Worker requests | 100,000 a day | 1 (plus 1 for each retry) |
| Worker CPU time | 10 ms per request | a few ms; most of it reading a large screenshot |
| D1 rows written | 100,000 a day | about 11: 4 counters, 2 for the "being filed" lock, 1 to remember the issue, and up to 4 later when old counters are cleared |
| D1 rows read | 5 million a day | a few dozen at most (clearing old counters looks through them all) |
| D1 storage | 5 GB | about 200 bytes an item |

At the 50-a-day cap that's under 600 row writes a day, far below the allowance. KV isn't used.
GitHub allows the token 5,000 calls an hour; one item makes 2–4 calls (up to 9 the first time,
when it creates the `screenshots` branch).

## Where screenshots are kept, and purging them

GitHub's API can't attach images to issues the way the web page does, so the relay commits each
screenshot as a file to a separate branch, `screenshots`, in the feedback repo (never to the
main branch), at `screenshots/YYYY/MM/<feedback-id>.jpg` (or `.png`). The issue shows the image
from there. The feedback repo is private, so only you (and anyone you add) can see them.

- Screenshots live in that branch's git history. **Deleting a file doesn't remove it**: it stays
  in the history.
- **To purge all of them**, delete the branch:

  ```bash
  gh api -X DELETE repos/srikdhruv/scrappy-records-feedback/git/refs/heads/screenshots
  ```

  The relay creates a fresh, empty `screenshots` branch with the next screenshot. The images in
  older issues then stop loading (the issue text stays). GitHub may keep the deleted files on its
  side for a while before cleaning them up.
- A sensible schedule: **every 6 months**, once you've dealt with the issues they belong to.
- **To remove one item completely**, delete its issue (**Delete issue** at the bottom of the
  issue's page). Its screenshot goes at the next branch purge.

## Triage

```bash
gh issue list -R srikdhruv/scrappy-records-feedback                    # everything open
gh issue list -R srikdhruv/scrappy-records-feedback --label problem    # just problems (or idea, question)
gh issue list -R srikdhruv/scrappy-records-feedback --label v0.1.0     # from one app version
gh issue view <number> -R srikdhruv/scrappy-records-feedback --web     # open one in the browser
```

Each issue has the message, a table (time in UTC and on the laptop, app version, build ID, the
page it was sent from, install ID, system details), the app's recent errors, the last lines of the
server log (click **Server log** to expand), and the screenshot. The build ID links to the exact
commit of this repo that the laptop was running, so you can read the code as it was.

## What the relay does, and what it never keeps

- It checks each item, checks the feedback repo is still private, files the item as an issue
  (committing the screenshot first), and answers with the issue's address. Sending the same item
  twice gives the same issue.
- It keeps no copy of the feedback and has no backups. The feedback lives only in the GitHub repo.
- Its database holds only: feedback id → issue address; short-lived "being filed" locks
  (2 minutes); request counters, cleared within a day of expiring, which use a one-way scrambled
  (hashed) form of the internet address, never the address itself; and any installs you block.
- Its logs never contain the message, page, system details, server log, screenshot or internet
  address: only the first 8 characters of the feedback id, what happened, and a status number.

## Replies the relay gives the app

Only three replies are final for the app (it stops sending that item): `invalid`, `too_large`
and `blocked`. Everything else is retried later, so nothing is lost while something is down.

| Reply | Meaning | What the app does |
|---|---|---|
| `201` / `200` `{"status":"created","issue_url":…}` | Filed (200: already filed earlier) | Marks it sent |
| `400` `{"status":"invalid"}` | Something in it is malformed | Gives up on it |
| `403` `{"status":"blocked"}` | That install is blocked (step 13) | Gives up on it |
| `413` `{"status":"too_large"}` | Over 2 MiB | Gives up on it |
| `409` `{"status":"in_progress"}` + `Retry-After` | The same item is being filed right now | Tries again later |
| `429` `{"status":"rate_limited"}` + `Retry-After` | Over a limit (step 13) | Tries again later |
| `502` `{"status":"upstream_error"}` | GitHub couldn't be reached or refused (e.g. an expired token) | Tries again later |
| `503` `{"status":"unavailable"}` + `Retry-After` | The relay's database is down or out of quota | Tries again later |
| `503` `{"status":"misconfigured"}` + `Retry-After` | The feedback repo isn't private, or that couldn't be checked | Tries again later |

One item takes at most about 40 seconds on the relay's side: each GitHub call is given up to
10 seconds, and all calls for one item share 40 seconds in total.

If feedback stays "waiting" in the app for a day, watch the relay's live log
(`cd relay && npx wrangler tail`) while sending one:

- `upstream_error` over and over usually means the GitHub token expired (step 12).
- `misconfigured` means the feedback repo is public, or the token can't see it (steps 5 and 6).
- `unavailable` means the database is down or its daily quota is used up; it clears by itself.
- `exceededCpu` (or error 1102) means an item with a large screenshot took more than the free
  plan's 10 ms of processing. If it keeps happening, the Workers Paid plan ($5 a month) raises
  that limit.
