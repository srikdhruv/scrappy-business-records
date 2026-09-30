# ADR 0005 — Feedback is the app's only outbound call

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [ADR 0002](0002-local-only-runtime.md) ("no outbound calls at runtime")

## Context

Until now the app made no network calls at runtime ([ADR 0002](0002-local-only-runtime.md)).
The owner asked for a feedback button: "a customer feedback option under a button at the bottom
left … with timestamp, current screen debug snapshot and live code with version". Feedback has
to reach the developer, so something has to leave the laptop. The constraints were recorded in
[future-features §10](../product/future-features.md#10-in-app-feedback--done): the owner has no
GitHub account, no token can ship inside a public app, the repo's issues are public while
feedback may show students and amounts, and the laptop may be offline.

## Decision

1. **One explicit, owner-initiated exception.** The app may send **feedback the owner chooses
   to send** (Settings → Send feedback → Send), and nothing else. There is still no telemetry,
   no update check, no crash reporting in the background.
2. **Only feedback goes out.** The sender reads only the `feedback` table: the owner's message,
   the picture of the screen if she left it ticked, and diagnostics about the app (version,
   build ID, a random install ID, the page's path, recent errors, the last warnings and errors
   of the server log with the user's name, home folder and values hidden, OS, browser and
   screen size). Never the
   database file, backups or exports. `backend/tests/test_feedback.py` checks that stored
   names, phones, notes and amounts don't appear in what is sent.
3. **Sent by the server, not the browser**, to one address: `FEEDBACK_URL` in
   `backend/app/config.py` (overridable with `SCRAPPY_FEEDBACK_URL`; empty means off, the
   default until the relay is deployed, and what tests and dev mode use). HTTPS only (plain HTTP
   only to `127.0.0.1`, for tests), with a 20 s timeout.
4. **Saved first, sent in the background.** Feedback is stored on the laptop (a new `feedback`
   table, [ADR 0004](0004-data-is-never-lost.md): the migration only adds), and a background
   thread sends it at startup, when new feedback is saved, and once a minute while any is
   waiting, backing off exponentially on failure. The UI never waits on the network.
5. **A relay holds the secret.** A small Cloudflare Worker (`relay/`) receives feedback, checks
   and rate-limits it, dedupes by the feedback's id, and files it as an issue (with the picture
   committed) in a **private** repo, using a fine-grained token limited to that repo, stored as
   a Worker secret. The app and the public repo hold no secret. The Worker logs no personal
   information.

## Alternatives considered

- **Post from the browser straight to the relay.** Simpler, but it can't retry after the tab is
  closed or the laptop restarts, and it spreads network code into the UI. The server already
  runs all the time.
- **Open WhatsApp or email with the details prefilled.** Nothing is logged automatically, the
  picture and logs don't fit, and the developer's number would have to live somewhere.
- **A GitHub token in the app.** Anyone could extract it from the public download and abuse it.
- **A local file collected at update time.** Feedback would arrive weeks late, if at all.

## Consequences

- The app now has one online dependency, the relay, which the developer owns and maintains
  ([setup runbook](../runbooks/feedback-relay-setup.md)). If it is down or not set up, feedback
  simply waits on the laptop; nothing else is affected.
- Any other outbound call needs a new ADR.
- The picture may show student names and amounts. The dialog says so, the box can be unticked,
  and it only goes to the private inbox. It is deleted from the laptop once sent.
