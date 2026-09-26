"""Overtone's own hitsound samples, generated: never recorded, never borrowed.

osu!'s default samples belong to ppy and are not Overtone's to ship, so a map
that names no custom samples plays these instead: the three sample sets osu!
has, each with its four sounds, in its own character, and the two a slider
holds from head to tail (the slide, and the whistle slide), which loop.

    normal  bright and wooden: a tick, a two-tone ping, a crash, a clap
    soft    the same roles, rounder and lower, with less attack
    drum    a kit: kick, tom, cymbal, snare
    slides  one second of airy hiss, and a held whistle, per set

Standard library only, a seeded noise source and fixed float arithmetic, so
anyone regenerates the same bytes with the repo's own interpreter:

    .venv/Scripts/python.exe assets/samples.py

Outputs: assets/samples/<set>-hit<sound>.wav and <set>-slider<slide|whistle>.wav,
44.1 kHz 16-bit mono, the file names osu! itself uses. They are placeholders with the right roles, not
imitations of any skin: a mapper who wants osu!'s own sounds points Overtone
at their skin or keeps custom samples in the beatmap folder, which win.
"""

import math
import struct
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "samples"
RATE = 44100
SETS = ("normal", "soft", "drum")
SOUNDS = ("normal", "whistle", "finish", "clap")
#: Every sample peaks here: headroom for several at once over the song.
PEAK = 0.7


class Noise:
    """Deterministic white noise in [-1, 1): the same bytes on every machine."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def __call__(self) -> float:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 2147483648.0 - 1.0


def seconds(n: float) -> int:
    return int(round(n * RATE))


def env(t: float, attack: float, decay: float) -> float:
    """A short linear rise, then an exponential fall with time constant ``decay``."""
    if t < attack:
        return t / attack if attack > 0 else 1.0
    return math.exp(-(t - attack) / decay)


def tone(length: float, partials, attack: float, decay: float, sweep=None) -> list[float]:
    """Sines at (frequency, weight); ``sweep`` (start, end, time) bends the
    pitch exponentially from start to end, a drum's settling skin."""
    out, phase = [], [0.0] * len(partials)
    for i in range(seconds(length)):
        t = i / RATE
        bend = 1.0
        if sweep is not None:
            start, end, tau = sweep
            bend = (end + (start - end) * math.exp(-t / tau)) / start
        s = 0.0
        for k, (freq, weight) in enumerate(partials):
            phase[k] += 2 * math.pi * freq * bend / RATE
            s += weight * math.sin(phase[k])
        out.append(s * env(t, attack, decay))
    return out


def noise(length: float, seed: int, attack: float, decay: float) -> list[float]:
    rnd = Noise(seed)
    return [rnd() * env(i / RATE, attack, decay) for i in range(seconds(length))]


def bandpass(x: list[float], centre: float, q: float) -> list[float]:
    """RBJ biquad band-pass (constant peak gain)."""
    w = 2 * math.pi * centre / RATE
    alpha = math.sin(w) / (2 * q)
    b0, b2 = alpha, -alpha
    a0, a1, a2 = 1 + alpha, -2 * math.cos(w), 1 - alpha
    y, x1, x2, y1, y2 = [], 0.0, 0.0, 0.0, 0.0
    for v in x:
        out = (b0 * v + b2 * x2 - a1 * y1 - a2 * y2) / a0
        x2, x1, y2, y1 = x1, v, y1, out
        y.append(out)
    return y


def highpass(x: list[float], cutoff: float) -> list[float]:
    """One-pole high-pass: keeps a cymbal's hiss, drops its rumble."""
    rc = 1 / (2 * math.pi * cutoff)
    a = rc / (rc + 1 / RATE)
    y, prev_x, prev_y = [], 0.0, 0.0
    for v in x:
        prev_y = a * (prev_y + v - prev_x)
        prev_x = v
        y.append(prev_y)
    return y


def lowpass(x: list[float], cutoff: float) -> list[float]:
    dt = 1 / RATE
    a = dt / (1 / (2 * math.pi * cutoff) + dt)
    y, prev = [], 0.0
    for v in x:
        prev += a * (v - prev)
        y.append(prev)
    return y


def mix(*parts) -> list[float]:
    """Sum of (signal, gain, delay-seconds) parts, as long as the longest."""
    length = max(seconds(d) + len(s) for s, _g, d in parts)
    out = [0.0] * length
    for s, g, d in parts:
        start = seconds(d)
        for i, v in enumerate(s):
            out[start + i] += g * v
    return out


def clap(seed: int, centre: float, q: float, tail: float) -> list[float]:
    """Three quick hands, then the room: a clap is several transients, a
    snare one."""
    burst = lambda k: bandpass(noise(0.012, seed + k, 0.0005, 0.004), centre, q)
    body = bandpass(noise(tail * 4, seed + 9, 0.001, tail), centre, q)
    return mix((burst(0), 1.0, 0.0), (burst(1), 0.9, 0.009), (burst(2), 0.8, 0.019), (body, 0.9, 0.024))


#: A slide's loop, in seconds: whole cycles of every tone and of the vibrato,
#: so the end meets the start.
LOOP = 1.0
#: Loops sound for as long as a slider lasts: kept well under the hits.
LOOP_PEAK = 0.3


def sustain(partials, vibrato: float, depth: float) -> list[float]:
    """Held sines at whole-number frequencies with a whole-number vibrato:
    every phase comes back where it started at LOOP, so it loops without a
    click."""
    out = []
    for i in range(seconds(LOOP)):
        t = i / RATE
        wobble = depth / vibrato * math.sin(2 * math.pi * vibrato * t)
        out.append(sum(w * math.sin(2 * math.pi * f * t + wobble * f / partials[0][0])
                       for f, w in partials))
    return out


def looped(x: list[float], fade: float = 0.1) -> list[float]:
    """LOOP seconds of ``x`` (longer by ``fade``) whose end runs into its
    start: the first ``fade`` blends, at equal power, into what follows the
    end, so the last sample and the first are neighbours of one signal."""
    n, f = seconds(LOOP), seconds(fade)
    out = x[:n]
    for i in range(f):
        k = i / f
        out[i] = x[i] * math.sqrt(k) + x[n + i] * math.sqrt(1 - k)
    return out


def design() -> dict[str, list[float]]:
    s = {}
    # normal: bright, wooden
    s["normal-hitnormal"] = mix((tone(0.09, [(1180, 1.0), (2360, 0.35), (3540, 0.12)], 0.0005, 0.016), 1.0, 0),
                                (noise(0.01, 11, 0.0002, 0.0015), 0.35, 0))
    s["normal-hitwhistle"] = tone(0.35, [(1760, 1.0), (2637, 0.45)], 0.004, 0.09)
    s["normal-hitfinish"] = mix((highpass(noise(1.2, 21, 0.001, 0.32), 3000), 1.0, 0),
                                (tone(0.9, [(620, 0.2), (1310, 0.15)], 0.002, 0.25), 1.0, 0))
    s["normal-hitclap"] = clap(31, 1500, 1.2, 0.05)
    # soft: rounder, lower, gentler attack
    s["soft-hitnormal"] = lowpass(tone(0.12, [(720, 1.0), (1440, 0.18)], 0.002, 0.03), 2500)
    s["soft-hitwhistle"] = tone(0.4, [(1318.5, 1.0), (1975.5, 0.25)], 0.012, 0.11)
    s["soft-hitfinish"] = lowpass(highpass(noise(1.0, 41, 0.004, 0.26), 1500), 7000)
    s["soft-hitclap"] = lowpass(clap(51, 1050, 0.9, 0.06), 4000)
    # drum: a kit
    s["drum-hitnormal"] = mix((tone(0.3, [(150, 1.0)], 0.001, 0.09, sweep=(150, 52, 0.035)), 1.0, 0),
                              (bandpass(noise(0.01, 61, 0.0002, 0.002), 3500, 0.8), 0.4, 0))
    s["drum-hitwhistle"] = tone(0.35, [(240, 1.0), (360, 0.3)], 0.001, 0.11, sweep=(240, 150, 0.06))
    s["drum-hitfinish"] = mix((highpass(noise(1.4, 71, 0.001, 0.42), 2200), 1.0, 0),
                              (tone(1.2, [(540, 0.25), (833, 0.2), (1187, 0.15)], 0.001, 0.35), 1.0, 0))
    s["drum-hitclap"] = mix((bandpass(noise(0.25, 81, 0.0005, 0.06), 2200, 0.7), 1.0, 0),
                            (tone(0.12, [(190, 1.0)], 0.001, 0.03), 0.6, 0))
    # slides: what a slider's body holds from head to tail, looped
    held = lambda seed: noise(LOOP + 0.1, seed, 0.0, 1e9)
    s["normal-sliderslide"] = looped(bandpass(held(91), 4200, 0.7))
    s["normal-sliderwhistle"] = sustain([(880, 1.0), (1760, 0.3)], 5, 6)
    s["soft-sliderslide"] = looped(lowpass(bandpass(held(93), 1800, 0.6), 5000))
    s["soft-sliderwhistle"] = sustain([(660, 1.0), (1320, 0.2)], 5, 5)
    s["drum-sliderslide"] = looped(bandpass(held(95), 260, 0.8))
    s["drum-sliderwhistle"] = sustain([(440, 1.0), (660, 0.3)], 4, 4)
    return s


def to_wav(signal: list[float], path: Path, level: float = PEAK) -> None:
    peak = max(abs(v) for v in signal) or 1.0
    frames = b"".join(struct.pack("<h", int(round(max(-1.0, min(1.0, v / peak * level)) * 32767)))
                      for v in signal)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(frames)


def main(out: Path = OUT) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, signal in design().items():
        path = out / f"{name}.wav"
        to_wav(signal, path, LOOP_PEAK if "-slider" in name else PEAK)
        written.append(path)
    return written


if __name__ == "__main__":
    for path in main():
        print(f"wrote {path} ({path.stat().st_size} bytes)")
