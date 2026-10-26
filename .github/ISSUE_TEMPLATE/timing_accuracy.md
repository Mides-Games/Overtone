---
name: Timing accuracy report
about: Overtone's red lines disagree with the music or with a hand-timed map
title: "accuracy: "
labels: accuracy
---

<!-- Accuracy on real songs is still research (see the README's accuracy
section). Reports with a hand-timed reference are the most useful kind. -->

**The song**
- Artist - Title:
- Beatmap set link (a ranked or loved map timed by hand, if there is one):
- Audio length and format:

**Engine and version**
- Engine: <!-- Python v3 / Rust v4 / overtone-cli -->
- Overtone version or commit:
- Settings changed from the defaults: <!-- preset, Prefer map BPM, offset lead, ... -->

**What Overtone gave**
<!-- Paste the red lines (Timing → copy, or `overtone.py song.mp3 --stats`). -->

**What the reference has**
<!-- The map's [TimingPoints] red lines, or what you hear and where. -->

**Kind of disagreement**
- [ ] wrong octave (half or double the BPM)
- [ ] offset off by a few ms (how many, and early or late?)
- [ ] grid drifts over the song
- [ ] missing or extra tempo change
- [ ] wrong time signature or bar line
- [ ] refused a song that has a clear beat
- [ ] other:

**Where**
<!-- Timestamps (mm:ss:ms) where it is wrong. -->
