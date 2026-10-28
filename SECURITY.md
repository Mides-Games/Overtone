# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's security
advisories: open the repository's **Security** tab and choose **Report a
vulnerability**. That opens a private thread with the maintainers; nothing in it
is public until a fix is released and the advisory is published.

Do not open a public issue, pull request or discussion for a vulnerability.

A useful report says:

- what is affected (the website, the command line, the measurement server, a
  bench script) and which version or commit;
- how to reproduce it, with the smallest input that does (an `.osu` file, an
  audio file, a command line);
- what an attacker gains.

You can expect an acknowledgement within a week. Fixes land on `master` and
ship in the next release; the advisory names the fixed version.

## Scope

Overtone is a timing engine and the website built on it (`site/`, signed in
with a Mides account). The engine and its command line make no network calls.
The surfaces that matter most are the ones that read input a user did not write
themselves:

- the website and its API (`site/`): sign-in, sessions and anything it accepts;
- the `.osu` reader and writer (a crafted map must not crash the engine, write
  outside the map's folder, or overwrite an existing `.bak`);
- the audio decoders (Python's libsndfile / FFmpeg path, Rust's Symphonia);
- the `.osz` export, and the library index over a Songs folder;
- the measurement server (`python/overtone_server.py`) and its token.

The desktop app and its installer were parked on 2026-10-26
(`parked/desktop-app`) and receive no fixes.

## Supported versions

Only the latest release and `master` receive security fixes.
