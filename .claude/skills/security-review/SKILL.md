---
name: security-review
description: Review the Overtone site (site/api, site/web, worker/, deploy/) for security problems along the five areas of the 2026-10-27 reviews. Use before a release from experimental to master, after any change to the API, uploads, the worker or the deploy, when a dependency is added, or whenever asked to "review security" or "audit" this repository. Gives the checklist, the files to read for each area, and how findings are written down.
---

# Security review of the Overtone site

The procedure is `docs/security-review.md`; read it first. This is the same thing as a
checklist to work through. The earlier reviews are in `docs/timeline.md` (search
"Security hardening of the site", "The queue under concurrency", "The measurement
server, hardened"): their findings are the best guide to what goes wrong here.

## 1. Name the scope

- Release: `git diff origin/master...origin/experimental --stat`.
- Feature: the branch's diff against `origin/experimental`.
- Write down which of the five areas the diff touches. An untouched area is skipped and
  the write-up says so.

## 2. Work through each area in scope

Read the code, not its comments. For each question, answer yes, no (a finding) or not
applicable.

**Area 1. Uploads, the spool and the worker.** Size capped before and during the body;
spool reservation released in a `finally`; header checked before decoding
(`too_heavy`); child process with time and memory limits; every result field validated
(`validResult` in `internal.routes.js`); the audio deleted on every path (ADR-W4);
limits re-checked inside the insert.
Read: `site/api/src/routes/analyses.routes.js`, `site/api/src/routes/internal.routes.js`,
`site/api/src/services/spool.service.js`, `site/api/src/services/analysis.service.js`,
`site/api/src/utils/upload.js`, `worker/main.py`, `worker/isolate.py`,
`worker/timing_result.py`.

**Area 2. The edge.** `X-Forwarded-For` only from `TRUSTED_PROXY_ADDRS`; `/api/internal`
never forwarded; `PROXY_SECRET` enforced; idle API cut (`API_TIMEOUT_S`); files kept in
`WEB_ROOT`; CSP unchanged or tightened; values written into served HTML escaped.
Read: `deploy/web/serve.mjs`, `site/api/src/app.js`, `site/api/src/middlewares/`,
`site/api/src/utils/client-ip.js`, `docs/deploy.md`.

**Area 3. Identity, sessions, limits.** Every mutating route: `requireSameOrigin`, a
`guard(...)` rate limit, validation with caps, the same 404 for "not yours" and "does not
exist". Staff checked with `isStaff` on the server. `__Host-` cookies over https; return
path on this origin; IPv6 counted by /64; no anonymous path that writes rows without a
quota.
Read: `site/api/src/middlewares/session.js`, `site/api/src/middlewares/rate-limit.js`,
`site/api/src/services/session.service.js`, `site/api/src/services/account.service.js`,
every file in `site/api/src/routes/`.

A quick way to list the mutating routes and see their guards:

```
rg -n "router\.(post|put|patch|delete)\(" site/api/src/routes
```

**Area 4. Data and privacy.** No public view with the SHA-1, `anon_hash`, `ip_hash`, an
email or a private analysis; views built field by field; user text cleaned
(`utils/text.js`) and rendered as text; CSV formula cells escaped; nothing personal in
URLs or logs; database roles and backups as `docs/deploy.md` says; the privacy page still
true.
Read: `site/api/src/db/schema.sql`, `site/api/src/utils/timings.js`,
`site/api/src/utils/queue.js`, `site/api/src/utils/text.js`, `site/api/src/utils/upload.js`,
`deploy/eggs/`, the `legal.privacy` strings in `site/web/src/locales/en.json`.

**Area 5. Deploy, secrets, dependencies.** Deploy key limited to starting the updater;
updater fails closed; root never runs a file `overtone` can write; secrets only in the
panel's environment; every new dependency pinned, justified and credited.
Read: `deploy/setup-deploy-user.sh`, `deploy/overtone-update.sh`, `deploy/eggs/`,
`.github/workflows/deploy.yml`, the `package.json` files, `pnpm-lock.yaml`,
`python/requirements.lock`, `python/overtone_server.py`.

## 3. Try what can be tried

Locally, on your own ports (never 3001/5173, another session may use them):

```
PORT=<api> OVERTONE_WORKER=0 node site/api/src/dev.js
```

Then `fetch`/`curl` against it: a request without `X-Requested-With`, another person's
id, an oversized body, a forged `X-Forwarded-For`. `site/api/test/serve.test.js` shows how
to run `serve.mjs` in front of a stand-in API. Run only the site's checks (CLAUDE.md,
Verification): `pnpm --dir site/api test`, `pnpm --dir site/web test`,
`pnpm --dir site/web budget`, `pnpm --dir site/e2e test`. Engine suites and gates run on
the owner's server, not here.

## 4. Write it down

Every review leaves a `docs/timeline.md` entry, even when it finds nothing:

- each finding: what an attacker does, what it costs and gets them, severity, and under
  Fixed / Hardening what changed (one `fix/` commit per finding, with a test that fails
  before the fix where one can be written);
- under "Not fixed here": what is left and why, plus a row in `docs/16-web-platform.md`
  if it is later work;
- what needs the owner (panel, Cloudflare, Mides, secrets) said plainly, in the entry and
  the PR description.

A live, unfixed vulnerability in production is not written into the public repository
before its fix is deployed (`SECURITY.md`).
