# Feedback relay

A small Cloudflare Worker. The Scrappy Records app sends each piece of in-app feedback here, and
the Worker files it as an issue (with its screenshot) in the private feedback repo.

- Setup, testing, token rotation and spam handling:
  [docs/runbooks/feedback-relay-setup.md](../docs/runbooks/feedback-relay-setup.md)
- Code: `src/index.ts` (routes, dedup, blocking), `src/validate.ts` (the request contract),
  `src/ratelimit.ts` (limits), `src/markdown.ts` (issue text), `src/github.ts` (GitHub calls).
- Checks: `npm ci && npm run typecheck && npm test`.
- Deploys: `.github/workflows/relay.yml` deploys on every push to `main` that touches `relay/`.
