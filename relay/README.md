# Feedback relay

A small Cloudflare Worker. The Scrappy Records app sends each piece of in-app feedback here, and
the Worker files it as an issue in the private feedback repo, with its screenshot committed to
that repo's `screenshots` branch.

- Setup, testing, limits, token rotation, spam handling and purging screenshots:
  [docs/runbooks/feedback-relay-setup.md](../docs/runbooks/feedback-relay-setup.md)
- Code: `src/index.ts` (the request flow), `src/validate.ts` (the request contract),
  `src/db.ts` (dedup, lock, blocks in D1), `src/ratelimit.ts` (limits), `src/markdown.ts`
  (issue text), `src/github.ts` (GitHub calls). Tables: `migrations/`.
- Checks: `npm ci && npm run typecheck && npm test` (tests run the real SQL on Node's built-in
  SQLite).
- Deploys: `.github/workflows/relay.yml` applies migrations and deploys on every push to `main`
  that touches `relay/`.
