# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's security
advisories: open the repository's **Security** tab and choose **Report a
vulnerability**. That opens a private thread with the maintainers; nothing in it
is public until a fix is released and the advisory is published.

Do not open a public issue, pull request or discussion for a vulnerability.

A useful report says:

- what is affected (the desktop app, the command line, the installer, a bench
  script) and which version or commit;
- how to reproduce it, with the smallest input that does (an `.osu` file, an
  audio file, a command line);
- what an attacker gains.

You can expect an acknowledgement within a week. Fixes land on `master` and
ship in the next release; the advisory names the fixed version.

## Scope

Overtone is an offline desktop tool: it makes no network calls and has no
accounts. The surfaces that matter most are the ones that read files a user did
not write themselves:

- the `.osu` reader and writer (a crafted map must not crash the app, write
  outside the map's folder, or overwrite an existing `.bak`);
- the audio decoders (Python's libsndfile / FFmpeg path, Rust's Symphonia);
- the `.osz` export, and the library index over a Songs folder;
- the installer (MSI / portable ZIP) and what it puts on disk.

## Supported versions

Only the latest release and `master` receive security fixes.
