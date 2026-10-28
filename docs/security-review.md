# Periodic security review (W10.7)

The site was reviewed three times on 2026-10-27 (docs/timeline.md: "Security hardening
of the site and its servers", "The queue under concurrency", "The measurement server,
hardened"). Between them they found 22 problems, and they fell into five areas. This is
the procedure for looking at the same five areas again, so a later review starts from
what the earlier ones learned instead of from nothing.

The `security-review` project skill (`.claude/skills/security-review/SKILL.md`) is the
same checklist in the form an agent session follows.

## When

- **Before every release** (a version tag on `master`, the only long-lived branch since
  2026-10-27). The review covers the diff since the last release
  (`git diff <last tag>...origin/master`), with the five areas below as the checklist,
  and the whole of an area when the diff touches it.
- **After any feature that touches the API, uploads or the worker:** a new route, a
  change to a middleware, the upload path, the spool, `worker/`, `deploy/web/serve.mjs`,
  `deploy/` or `schema.sql`. Then the review covers that feature's diff, before its
  branch is merged into `master`.
- **Whenever a dependency is added** to `site/api`, `site/web` (runtime) or the worker:
  area 5 at least.

Nothing here runs in CI (CLAUDE.md, owner's decision): the review is done by a person or
an agent session, and its findings are written down as below.

## The five areas

Each area lists what to look for (the earlier findings, as questions) and the files to
read. "Read" means the code, not its comments.

### 1. Uploads, the spool and the worker

- Is every size capped before the body is read (`Content-Length`, `MAX_UPLOAD_MB`), and
  cut off while it streams? Does an upload reserve its size against `SPOOL_MAX_MB` and
  free it in a `finally`?
- Can a file claim more than it is (sample rate, channels, frames) and make the worker
  decode gigabytes? Is the header checked before decoding (`too_heavy`)?
- Does each analysis run in its own child with a wall-clock and a memory limit, and does
  a killed child fail only its own job?
- Does the API validate every field of a worker's result (finite, in range, capped
  arrays and strings), so a stolen `WORKER_TOKEN` cannot store a NaN or a formula?
- Is the audio deleted on every path (result, failure, cancel, moderation, timeout,
  cache hit) (ADR-W4)?
- Are the limits re-checked inside the insert, so K parallel uploads cannot all pass a
  cap that the store sees once each has landed?

Files: `site/api/src/routes/analyses.routes.js`, `site/api/src/routes/internal.routes.js`,
`site/api/src/services/spool.service.js`, `site/api/src/services/analysis.service.js`,
`site/api/src/utils/upload.js`, `worker/main.py`, `worker/isolate.py`,
`worker/timing_result.py`.

### 2. The edge: serve.mjs and what reaches the API

- Is `X-Forwarded-For` read only from a peer inside `TRUSTED_PROXY_ADDRS`, and does
  `TRUST_PROXY` on the API match the hops (`TRUSTED_PROXY_HOPS + 1`)?
- Is `/api/internal/*` never forwarded, a client's `X-Overtone-Proxy` dropped, and does
  the API answer 404 without `PROXY_SECRET`?
- Is a forwarded request cut when the API goes idle (`API_TIMEOUT_S`)? Are the files
  served kept inside `WEB_ROOT`?
- Is the CSP still `default-src 'self'` with only the named image origins, and is every
  value written into a served page (the `/t/<id>` card) escaped?

Files: `deploy/web/serve.mjs`, `site/api/src/app.js`,
`site/api/src/middlewares/shared-secret.js`, `site/api/src/middlewares/security-headers.js`,
`site/api/src/utils/client-ip.js`, `docs/deploy.md`.

### 3. Identity, sessions and abuse limits

- Does every mutating route have the same-origin guard (`requireSameOrigin`), a rate
  limit (`guard(...)`), validation with size caps, and the same 404 for "not yours" as
  for "does not exist"?
- Are staff checks `isStaff` from `account.service.js`, on the server, on every staff
  route?
- Are the cookies `__Host-` over https, HttpOnly, with a name sent twice counted as
  absent? Does the sign-in return path stay on this origin?
- Do the rate limits and quotas count IPv6 by its /64, and share one count across API
  processes (`rate_limits`)? Can the anonymous paths (reviews, reports, lookup) be used
  to flood a table without a quota?

Files: `site/api/src/middlewares/session.js`, `site/api/src/middlewares/rate-limit.js`,
`site/api/src/services/session.service.js`, `site/api/src/services/account.service.js`,
`site/api/src/routes/auth.routes.js`, `site/api/src/routes/*.routes.js` (each mutating
route), `site/web/src/lib/sso-guard.js`.

### 4. Data and privacy

- Does any public view expose the audio's SHA-1, `anon_hash`, `ip_hash`, an email, a
  private analysis or its uploader? Are public views built field by field
  (`utils/timings.js`, `utils/queue.js`), never by spreading a row?
- Is user text cleaned of control, bidi and zero-width characters (`utils/text.js`,
  `cleanTag`) and rendered as text? Do CSV cells starting with `= + - @` get their
  apostrophe?
- Is personal data kept out of URLs and logs?
- Is each database role limited to its own database (`pg_hba.overtone.conf`), and are
  the backups written with `umask 077` and verified?
- Does the privacy page still say what is stored (docs/site.md, "Where the privacy text
  comes from")?

Files: `site/api/src/db/schema.sql`, `site/api/src/utils/timings.js`,
`site/api/src/utils/queue.js`, `site/api/src/utils/text.js`, `site/api/src/utils/upload.js`,
`site/web/src/locales/en.json` (`legal.privacy`), `deploy/eggs/`.

### 5. Deploy, secrets and dependencies

- Can the deploy key do anything but start `overtone-update.service`? Does the updater
  fail closed (wait) when it cannot tell whether a run is going?
- Does root ever run a file from a tree `overtone` can write?
- Are secrets only in the panel's environment, `GIT_TOKEN` unset after the checkout, and
  no subuser able to read files?
- Is every new dependency pinned and justified, with its licence in the credits
  (`site/web/scripts/credits.mjs`), the Python ones pinned in `python/requirements.lock`?
- The measurement server (`python/overtone_server.py`): token limiter, connection cap,
  audio names kept inside their song folder.

Files: `deploy/setup-deploy-user.sh`, `deploy/overtone-update.sh`, `deploy/eggs/`,
`.github/workflows/deploy.yml`, `package.json` and each `site/*/package.json`,
`pnpm-lock.yaml`, `python/requirements.lock`, `python/overtone_server.py`, `docs/server.md`.

## Doing it

1. Name the scope: the diff (`git diff <base>...<head> --stat`) and which of the five
   areas it touches. An area the diff does not touch is skipped, and the write-up says so.
2. Read the files of each area in scope against its questions. Try what can be tried
   locally: the API in memory (`site/api`, `OVERTONE_WORKER=0`), `serve.mjs` in front
   (`site/api/test/serve.test.js` shows how), requests with `fetch` or `curl`.
3. For each finding: what an attacker does, what it costs them and what it gets them,
   and a severity (high, medium, low).
4. Fix what can be fixed on a `fix/` branch, one commit per finding, each with a test
   that fails before the fix where one can be written. The site's checks
   (CLAUDE.md, Verification) pass before the merge.

## How findings are tracked

- **Fixed:** one `docs/timeline.md` entry for the review, titled "Security review of
  ...", with each finding under Fixed or Hardening (what was wrong, who could use it,
  what changed) and what was run under Measured, as the 2026-10-27 entries do.
- **Not fixed now:** under "Not fixed here" in the same entry, with why, and a row in
  `docs/16-web-platform.md` if it is work for later. A finding is never left only in a
  chat or a PR comment.
- **Needs the owner** (the panel, Cloudflare, Mides, a secret): said in the entry and
  in the PR description, as a step for the owner to take.
- **Nothing found:** the entry still exists, says which areas were read and that nothing
  was found. A review that leaves no trace cannot be told from one that did not happen.
- A vulnerability that is live in production and not yet fixed is not written into the
  public repository until the fix is deployed; `SECURITY.md` says how one is reported.
