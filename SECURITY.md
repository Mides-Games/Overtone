# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's security
advisories: open the repository's **Security** tab and choose **Report a
vulnerability**. That opens a private thread with the maintainers; nothing in it
is public until a fix is released and the advisory is published.

Do not open a public issue, pull request or discussion for a vulnerability.

A useful report says:

- what is affected (the command line, the analysis worker, the measurement
  server, a bench script) and which version or commit;
- how to reproduce it, with the smallest input that does (an `.osu` file, an
  audio file, a command line);
- what an attacker gains.

You can expect an acknowledgement within a week. Fixes land on `master` and
ship in the next release; the advisory names the fixed version.

## Scope

This repository is Overtone's timing engine, its command line and the worker
that runs it for the website. The engine and its command line make no network
calls. The website and its API (signed in with a Mides account) and the Discord
bot are their own repositories since 2026-11-07: report a problem in them
through [Mides-Games/overtone-site](https://github.com/Mides-Games/overtone-site/security)
or [Mides-Games/overtone-bot](https://github.com/Mides-Games/overtone-bot/security).
The surfaces here that matter most are the ones that read input a user did not
write themselves:

- the analysis worker (`worker/`): the audio and jobs it takes from the
  website's API, and its token;
- the `.osu` reader and writer (a crafted map must not crash the engine, write
  outside the map's folder, or overwrite an existing `.bak`);
- the audio decoders (Python's libsndfile / FFmpeg path, Rust's Symphonia);
- the `.osz` export, and the library index over a Songs folder;
- the measurement server (`python/overtone_server.py`) and its token;
- the server's deploy key and its one forced command (`deploy/setup-deploy-user.sh`).

The desktop app and its installer were parked on 2026-10-26
(`parked/desktop-app`) and receive no fixes.

## Supported versions

Only the latest release and `master` receive security fixes.
