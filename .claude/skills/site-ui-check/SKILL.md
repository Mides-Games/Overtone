---
name: site-ui-check
description: Check the Overtone website (site/web) in a real browser: start the API and Vite on ports of your own, walk every page, take screenshots at 1366 and 375 px in dark and light (EN and ES), and list console errors and sideways scroll. Use whenever a change touches what the site shows (a page, component, style, string or an API reply a page reads), before saying a UI change works, and when asked to screenshot or look at the site.
---

# Checking the site's UI

The site is `site/web` (React, Vite) in front of `site/api` (Express, in memory without
`DATABASE_URL`). A unit test cannot see a layout break, a missing string or a reply the
page misreads; a browser can. Three rules first, because each went wrong before:

- **Your own ports.** Never 3001 or 5173: another session may be using them. Pick two
  free ones (below: `<web>` and `<api>`).
- **127.0.0.1, not localhost.** Cookies on `localhost` are shared across ports, so another
  dev server's sign-in would sign yours out (and the other way round).
- **No analysis worker.** It loads a 1.8 GB model on a shared machine. Start the API with
  `OVERTONE_WORKER=0`; for a finished result, use the e2e harness's fake worker (step 1b).

## Steps

1. **Start the site.** Two background processes, from the repository root, after
   `pnpm install`:

   a. Plain, no results:

   ```
   PORT=<api> SITE_URL=http://127.0.0.1:<web> OVERTONE_WORKER=0 node site/api/src/dev.js
   API_PORT=<api> node site/web/node_modules/vite/bin/vite.js site/web --port <web> --strictPort --host 127.0.0.1
   ```

   b. With a fake worker that times every upload in a second (fixture result, no
   Python), instead of the first line:

   ```
   E2E_API_PORT=<api> E2E_WEB_PORT=<web> node site/e2e/serve-api.mjs
   ```

   `pnpm dev` from the root does the same as (a) with a real worker, on 3001/5173: only
   for the owner's own machine, not for an agent session.

2. **Take the screenshots** of every page, 1366 and 375 px, dark and light, EN and ES,
   with each page's console errors and sideways scroll:

   ```
   node site/e2e/screens.mjs --base http://127.0.0.1:<web> --out <scratch folder>/screens
   ```

   `--pages /,/queue` narrows it; `--lang en` too. It exits 1 and prints `problem:` lines
   for console errors, pages without a `<h1>` in `<main>`, and horizontal overflow. Put the
   output in your scratch folder, never in the repository. Look at the screenshots of the
   pages your change touched; open them with the image reader.

3. **Drive what screenshots cannot show** (a form, a dialog, the result page, the dev
   sign-in) in the built-in browser pane or with Playwright:
   - Upload: `/analyze`, pick a short WAV (`site/e2e/fixture.mjs` `clickWav()` makes one),
     Analyze. With the fake worker the result page fills in within a second.
   - Sign in: `/login`, "Continue with Google" (dev login): that user is staff; the
     Discord one is not.
   - Read text with the page's accessibility tree or text, measure with
     `getBoundingClientRect()`; a screenshot only when the look itself is the question.

4. **Run the automated checks** that cover the same ground:

   ```
   pnpm --dir site/e2e test     # paths, axe in both themes, 375 px, keyboard
   ```

5. **Clean up.** Stop both processes. Leave no screenshot, `launch.json` or log in the
   repository.

## Reporting

Say which pages, widths, themes and languages were looked at, what was driven by hand,
the console errors (or none), and what was not checked: Safari and Firefox (Chromium
only), a real phone's touch, a screen reader, a real worker's result, a real Mides
sign-in.
