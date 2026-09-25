---
name: overtone-ui-check
description: Check Overtone's web shell (app/index.html, app.js, styles.css) in the built-in browser, silently, with the real Python bridge behind it. Use this whenever a change touches the app's interface — a new view, card, lane, style, string or bridge reply the page reads — and before saying a UI change works; also when asked to screenshot, inspect or verify the app, or to test EN/ES. The pywebview window cannot be driven, and this harness can: same page, same Api, no sound, no user data touched.
---

# Checking Overtone's UI

The app is a pywebview window over `app/`, talking to `overtone_web.Api`. That
window cannot be driven from here, so the page is served by a small harness
that answers the same calls through `fetch`, and the built-in browser drives it.
What you see is the real page with the real bridge, which is the point: a unit
test of the bridge cannot see a layout break, a missing string or a reply the
page misreads.

Three things matter more than anything else here, because each one went wrong
before:

- **Silence.** The user heard the app play during a check once. The harness now
  routes every connection to the speakers through a gain-0 node before app.js
  runs, so playback code runs but nothing is heard. Do not remove that shim, and
  do not click Play expecting to hear it.
- **No user data.** The harness patches `load_config`/`save_config` and points
  LOCALAPPDATA at a fresh temp folder, so the user's config, recents, cache and
  library index are never read or written. The osu! Songs folder may be read
  (it is read only); never write into it.
- **Leave nothing behind.** The browser pane needs a `launch.json` outside the
  repo, in the session's root folder. Remove it when done.

## Steps

1. **Write the launch config.** The root is the folder this Claude session was
   opened in (the pane reads `<root>/.claude/launch.json`); on this machine that
   has been `C:\Users\<user>\IdeaProjects\Personal Projects`, the repo's parent.

   ```
   .venv/Scripts/python.exe .claude/skills/overtone-ui-check/scripts/launch.py up --root "<root>" [--audio "<song>"] [--pick "<folder>"]
   ```

   `--audio` becomes the current song (then `analyze()` in the page runs the
   real engine: 20-40 s on a real song). `--pick` is what every folder or file
   dialog answers, e.g. `C:\osu!\Songs` for the Songs browser.

2. **Start it** with `preview_start` (name `overtone-harness`), then give the tab
   a width: `resize_window` to 1280x800. With the pane hidden the layout has no
   width and every measurement is zero.

3. **Drive the page through its own functions** with `javascript_tool`:
   `setView("structure")`, `analyze()`, `songsLoad()`, and read state from `S`,
   `STX`, `SONGS`, `P`, `VIEW`. Wait for async work in the same call with a
   polling loop (`for (let i = 0; i < 60 && !S.result; i++) await new
   Promise(r => setTimeout(r, 500))`), which is sturdier than fixed waits.

4. **Verify by reading, not by looking.** Screenshots often time out when the
   pane is not frontmost. Prefer `get_page_text`, `read_page`, `find`, and
   measuring with `getBoundingClientRect()` (overflow, zero widths, elements off
   screen). Take a screenshot only when appearance itself is the question, at
   `scale` 0.6-0.7.

5. **Check both languages.** Click `#langSwitch [data-lang=es]`, read the same
   strings, switch back to `en`. A key missing from one table shows up as the
   raw key.

6. **Console.** `read_console_messages` with `onlyErrors` and pattern `app.js`.
   Errors from the harness's own `/events` polling are the harness, not the app.

7. **Python changes need a restart.** The harness imports `overtone.py` once;
   after editing Python, `preview_stop` and `preview_start` again. Page changes
   (HTML, CSS, JS) only need a reload (`navigate` to the URL again).

8. **Clean up.** `resize_window` preset `desktop`, `preview_stop`, then:

   ```
   .venv/Scripts/python.exe .claude/skills/overtone-ui-check/scripts/launch.py down --root "<root>"
   ```

## Reporting

Say what was checked and how (which view, which song, which language, which
numbers were read), and what was not. Timings measured through the harness are
the harness's: its polling and HTTP hop slow long jobs, so never quote them as
the app's.
