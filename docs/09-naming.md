# Naming

"osu! Timing Analyzer" described v1–v3 accurately. It will not describe v4: timing becomes
one of four things the app does, alongside hitsound analysis, map validation and
audio/map comparison. A name built around "timing" would undersell the tool and would have
to be lived with for years.

## What the name has to do

1. Cover **rhythm analysis, hitsounding and validation** without naming any one of them.
2. Read as a professional audio tool. The reference points — Ableton, Reaper, Serum,
   Vital, Linear — are **evocative, not descriptive**. "Audio Timing Analyzer Pro" is what
   a name looks like when nobody chose one.
3. Be searchable. A common English word is a bad name: "Onset" and "Pulse" are perfect
   descriptions and unfindable.
4. Survive not mentioning osu!. Trademark caution aside, `osu-` prefixes age badly, and
   the engine is genuinely general — it is a tempo analyser that happens to export `.osu`.
5. Be pronounceable, typable, and short enough for a CLI binary.

## Shortlist

| Name | Where it comes from | For | Against |
|---|---|---|---|
| **Tactus** | The musicological term for the *fundamental pulse* — literally what the engine's coherence sweep searches for and what it calls the "atomic pulse" | Precise without being descriptive; distinctive; elegant; scales past timing; almost no software collisions; `tactus` is a clean binary name | Obscure term; needs one line of explanation (TAK-tus) |
| **Beatwright** | "-wright" as in shipwright, playwright: one who makes | Covers analysis *and* hitsound authoring; craft connotation fits a mapper tool; memorable; low collision | Slightly folksy next to a DAW-grade UI |
| **Metrum** | Latin *measure / metre* | Short, elegant, distinctive, meaningful | Reads as a measurement utility; several unrelated small projects use it |
| **Redline** | osu! mappers call uninherited timing points "red lines" | Instantly recognisable to the exact audience; short and punchy | Reads automotive out of context; centres timing, which is the thing the rename is trying to de-centre |
| **Downbeat** | The first beat of a bar; also detected by the engine | Accessible, musical, evocative | Collides with *DownBeat*, a long-established jazz magazine |
| **Kiai** | osu! term for a map's hype section | Very native to the audience, short, memorable | Means a specific beatmap feature, so it misdescribes the tool; Japanese loanword with an unrelated martial-arts meaning |
| **Coherence** | `R(f) = |Σ w·e^{2πi f t}| / Σ w`, the statistic the engine is built on | Technically exact and rather beautiful | Long, abstract, hard to brand |
| **Onset** | Onset detection, the first stage of everything | Perfectly apt, short | Unsearchable; every audio paper uses the word |

## Recommendation

> **Tactus**

It names the thing the whole engine exists to find. It is short, distinctive, trivially
searchable, works as `tactus` on the command line, and says nothing that will be wrong in
two years when the tool does six things instead of four. The one cost — that some users
will not know the word — is paid back the first time they read the tagline:

```
Tactus — find the pulse.
Precision tempo analysis, timing and hitsound assistance for osu! mappers.
```

**Second choice: Beatwright**, if a warmer and more self-explanatory name is preferred.
It is the better name if the hitsound authoring side ends up being what people use it for.

Avoid: anything with `osu` in the project name (keep it in the description and the
keywords instead), and anything containing "Analyzer", "Tool", "Studio" or "Pro".

## Rename mechanics

Renaming the GitHub repository keeps working links — GitHub redirects the old
`githaltwastaken/Timing-Analyzer` URLs to the new name indefinitely, and existing clones
keep functioning. Still worth doing properly:

1. Rename on GitHub (Settings → Repository name).
2. Update the local remote:
   ```
   git remote set-url origin https://github.com/githaltwastaken/Tactus.git
   ```
3. Update the description and topics (`osu`, `beatmap`, `bpm`, `tempo`, `dsp`, `rust`,
   `hitsounds`) — the topics are where "osu! timing analyzer" should live for search.
4. Keep the old name in the README's history section so existing users recognise it.
5. Rename the crates (`ota-*` → `tactus-*`) **before** Phase 1 starts, not during. A crate
   rename mid-port is pure churn.

## Held back deliberately

A logo, an icon and a wordmark are Phase 3 work, once the UI's visual language exists. A
name chosen now and a mark designed later is the right order; the reverse produces a name
that fits a logo rather than a product.
