"""Do MFCC-timbre families split what mean chroma merges?

Full mixes collapse every section into one chroma family, and the level
split never fires there — that is why three quarters of kiai-bearing songs
propose no chorus at all (bench/labels.py). This regroups the CLI's sections
by chroma cosine AND MFCC-mean cosine at a threshold, then runs the shipped
crowning rules unchanged, and scores the same kiai halves:

    .venv/Scripts/python.exe proto/timbre_group.py tune 1.0 0.95 0.9
    .venv/Scripts/python.exe proto/timbre_group.py heldout 0.95

A measurement, not a gate, and deliberately librosa up front: if timbre
grouping cannot beat the bar here, there is nothing to port. As run
2026-10-07: tune lift +19.8 at 0.95 (clears +15), held-out +13.8 on 13 songs
(misses) — the best lead T6 has, and still a miss. Next attempts inherit the
split halves and the bar from bench/labels.py.
"""
import json
import subprocess
import sys
sys.path.insert(0, 'python')
from pathlib import Path
import numpy as np
import overtone as ta

CLI = Path('target/release/overtone-cli.exe')
songs = Path('C:/osu!/Songs')
d = json.load(open('bench/labels.json', encoding='utf-8'))


def sections_of(audio):
    proc = subprocess.run([str(CLI), 'structure', str(audio)],
                          capture_output=True, text=True, timeout=600)
    payload = json.loads(proc.stdout[:proc.stdout.rfind('}') + 1])
    return payload['sections'], float(payload.get('duration', 0.0)) * 1000.0


def signatures(audio, secs):
    import librosa
    y, sr = librosa.load(str(audio), sr=44100, mono=True)
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_fft=2048, hop_length=512)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, n_fft=2048, hop_length=512)
    hop_s = 512.0 / sr
    out = []
    for s in secs:
        a = max(0, int(s['start_s'] / hop_s))
        b = min(chroma.shape[1], int(np.ceil(s['end_s'] / hop_s)))
        if b <= a:
            out.append((np.zeros(12), np.zeros(13), s['level_db']))
            continue
        out.append((chroma[:, a:b].mean(axis=1),
                    mfcc[:, a:b].mean(axis=1), s['level_db']))
    return out


def cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(a @ b / (na * nb))


def label(sigs, tau):
    n = len(sigs)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if cos(sigs[i][0], sigs[j][0]) >= 0.90 and cos(sigs[i][1], sigs[j][1]) >= tau:
                union(i, j)
    groups, gid_of = {}, {}
    for i in range(n):
        r = find(i)
        gid_of[i] = groups.setdefault(r, len(groups))
    # level split at 2.0, >=4 members, widest 2v2 step (the shipped rule)
    final = {}
    fresh = max(groups.values()) + 1 if groups else 0
    from collections import Counter
    for g in set(gid_of.values()):
        members = sorted([i for i in range(n) if gid_of[i] == g],
                         key=lambda i: sigs[i][2])
        split_at = None
        if len(members) >= 4:
            best, best_r = None, 0.0
            for k in range(2, len(members) - 1):
                lo = 10 ** (sigs[members[k - 1]][2] / 10)
                hi = 10 ** (sigs[members[k]][2] / 10)
                r = hi / max(lo, 1e-12)
                if r > best_r:
                    best, best_r = k, r
            if best is not None and best_r >= 2.0:
                split_at = best
        for i in members[:split_at or len(members)]:
            final[i] = g
        if split_at:
            for i in members[split_at:]:
                final[i] = fresh
            fresh += 1
    counts = Counter(final.values())
    repeated = [g for g, c in counts.items() if c >= 2]
    chorus = None
    if len(repeated) >= 2:
        energy = {g: sum(10 ** (sigs[i][2] / 10)
                         for i in range(n) if final[i] == g) for g in repeated}
        chorus = max(energy, key=lambda g: energy[g])
    kinds = []
    for i in range(n):
        g = final[i]
        if counts[g] >= 2 and g == chorus:
            kinds.append('chorus')
        elif counts[g] == 1 and i == 0:
            kinds.append('intro')
        elif counts[g] == 1 and i == n - 1:
            kinds.append('outro')
        elif counts[g] == 1:
            kinds.append('bridge')
        else:
            kinds.append('verse')
    return kinds


def kiai(path):
    bm = ta.read_osu_beatmap(path)
    sec = next((s for s in bm.get('sections', []) if s.get('name') == 'TimingPoints'), None)
    ev = []
    for raw in (sec or {}).get('lines', []):
        f = ta._timing_point_fields(str(raw).strip())
        if f is None:
            continue
        try:
            e = int(str(raw).strip().split(',')[7])
        except (IndexError, ValueError):
            e = 0
        ev.append((float(f['time']), bool(e & 1)))
    spans, opened = [], None
    for at, on in sorted(ev):
        if on and opened is None:
            opened = at
        elif not on and opened is not None:
            if at > opened:
                spans.append((opened, at))
            opened = None
    return spans


def score(half, tau):
    precisions, chances, lit = [], [], 0
    for r in d['halves'][half]['rows']:
        if not r.get('usable'):
            continue
        folder = songs / r['folder']
        pick = folder / r['file']
        if not pick.is_file():
            continue
        try:
            bm = ta.read_osu_beatmap(pick)
        except Exception:
            continue
        audio = folder / str(bm.get('general', {}).get('AudioFilename') or '')
        if not audio.is_file():
            continue
        try:
            secs, dur = sections_of(audio)
            sigs = signatures(audio, secs)
            kinds = label(sigs, tau)
            spans = kiai(pick)
        except Exception as e:
            print('ERR', r['folder'][:40], str(e)[:100])
            continue
        fin = [(s, e if e != float('inf') else dur) for s, e in spans]
        chorus = [(x['start_s'] * 1000, x['end_s'] * 1000)
                  for x, k in zip(secs, kinds) if k == 'chorus']
        under = sum(max(0.0, min(a1, b1) - max(a0, b0))
                    for a0, a1 in fin for b0, b1 in chorus)
        ch_s = sum(b1 - b0 for b0, b1 in chorus)
        ki_s = sum(a1 - a0 for a0, a1 in fin)
        if ch_s > 0:
            lit += 1
            precisions.append(under / ch_s)
            chances.append(ki_s / dur)
    import statistics
    p = sum(precisions) / len(precisions) if precisions else 0
    c = sum(chances) / len(chances) if chances else 0
    print(f'tau {tau}: lit={lit} prec={p*100:.1f}% chance={c*100:.1f}% lift={(p-c)*100:+.1f}',
          flush=True)


if __name__ == '__main__':
    import sys
    half = sys.argv[1] if len(sys.argv) > 1 else 'tune'
    taus = [float(x) for x in sys.argv[2:]] or [1.00, 0.95, 0.90, 0.85, 0.80]
    for tau in taus:
        score(half, tau)
