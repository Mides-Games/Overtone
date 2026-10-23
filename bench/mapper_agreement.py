"""Repeatable mapper-agreement measurement for one-red-line osu! maps.

Reads osu!.db and Songs read-only, groups ranked/approved/loved maps by
byte-identical audio, and compares each pair's red-line grid both ways. The
optional audit sheet is written under bench/.cache by default; it contains
local paths and is never a committed corpus artifact.

    .venv/Scripts/python.exe bench/mapper_agreement.py
    .venv/Scripts/python.exe bench/mapper_agreement.py --sample 40 --seed 26
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import random
import sqlite3
import struct
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "bench"))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import corpus_b as cb  # noqa: E402

SONGS = Path(r"C:\osu!\Songs")
OSU_DB = Path(r"C:\osu!\osu!.db")
LIBRARY_DB = lib.default_path()
SUPPORTED_DB_VERSION = 20260924
RANKED_STATUSES = {4: "ranked", 5: "approved", 7: "loved"}
AUDIO_SUFFIXES = {".mp3", ".ogg", ".wav", ".m4a", ".flac", ".opus", ".mp4"}


class OsuDbFormatError(ValueError):
    """The local osu!.db is truncated or uses a format this reader cannot audit."""


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def take(self, fmt: str):
        size = struct.calcsize(fmt)
        if self.offset + size > len(self.data):
            raise OsuDbFormatError(f"truncated field at byte {self.offset}")
        value = struct.unpack_from(fmt, self.data, self.offset)
        self.offset += size
        return value[0] if len(value) == 1 else value

    def osu_string(self) -> str | None:
        marker = self.take("<B")
        if marker == 0:
            return None
        if marker != 11:
            raise OsuDbFormatError(f"bad string marker {marker} at byte {self.offset - 1}")
        length = shift = 0
        for _ in range(5):
            byte = self.take("<B")
            length |= (byte & 0x7F) << shift
            if byte < 0x80:
                break
            shift += 7
        else:
            raise OsuDbFormatError(f"invalid string length at byte {self.offset}")
        if length > 1_000_000 or self.offset + length > len(self.data):
            raise OsuDbFormatError(f"invalid string size {length} at byte {self.offset}")
        value = self.data[self.offset:self.offset + length].decode("utf-8", "replace")
        self.offset += length
        return value

    def star_ratings(self) -> None:
        count = self.take("<i")
        if not 0 <= count <= 100_000:
            raise OsuDbFormatError(f"invalid star-rating count {count} at byte {self.offset}")
        for _ in range(count):
            marker = self.take("<B")
            self.take("<i")  # mods
            value_marker = self.take("<B")
            self.take("<f")  # rating
            if marker != 8 or value_marker != 12:
                raise OsuDbFormatError(f"bad star-rating markers at byte {self.offset}")


@dataclass(frozen=True)
class DbMap:
    filename: str
    folder: str
    status: str
    beatmap_id: int
    set_id: int
    mode: int


def parse_osu_db(data: bytes) -> tuple[dict, list[DbMap]]:
    """Read status and identity from the known local Stable database format.

    Does not deserialize or modify osu!.db. The two-byte per-entry extension
    and four-byte trailer are opaque; their expected lengths guard against an
    unaudited layout.
    """
    reader = _Reader(data)
    version = reader.take("<i")
    if version != SUPPORTED_DB_VERSION:
        raise OsuDbFormatError(
            f"osu!.db version {version} is not audited; expected {SUPPORTED_DB_VERSION}")
    folder_count = reader.take("<i")
    unlocked = reader.take("<B")
    unlock_date = reader.take("<q")
    player = reader.osu_string()
    count = reader.take("<i")
    if not 0 <= folder_count <= 1_000_000 or not 0 <= count <= 2_000_000:
        raise OsuDbFormatError("implausible folder or beatmap count")
    header = {"version": version, "folders": folder_count, "unlocked": bool(unlocked),
              "unlock_date": unlock_date, "player": player, "beatmaps": count}
    maps: list[DbMap] = []
    for index in range(count):
        strings = [reader.osu_string() for _ in range(9)]
        status_code = reader.take("<B")
        reader.take("<hhhq")  # object counts and modified timestamp
        reader.take("<ffffd")  # difficulty settings and slider velocity
        for _ in range(4):
            reader.star_ratings()
        reader.take("<iii")  # drain, total, preview time
        timing_count = reader.take("<i")
        if not 0 <= timing_count <= 100_000:
            raise OsuDbFormatError(f"invalid timing-point count in entry {index}")
        for _ in range(timing_count):
            reader.take("<ddB")
        beatmap_id, set_id, _thread_id = reader.take("<iii")
        grades_mode = reader.take("<BBBBh f B")
        mode = grades_mode[-1]
        source = reader.osu_string()
        tags = reader.osu_string()
        reader.take("<h")
        reader.osu_string()  # title font
        reader.take("<BqB")
        folder = reader.osu_string()
        reader.take("<qBBBBB h B")
        if status_code in RANKED_STATUSES:
            filename = strings[8]
            if filename and folder and set_id > 0 and beatmap_id > 0:
                maps.append(DbMap(filename, folder, RANKED_STATUSES[status_code],
                                  beatmap_id, set_id, mode))
        # Stable v20260924 has a two-byte opaque per-entry extension.
        if reader.offset + 2 > len(data):
            raise OsuDbFormatError(f"truncated entry extension at byte {reader.offset}")
        reader.offset += 2
    if len(data) - reader.offset != 4:
        raise OsuDbFormatError(
            f"unexpected osu!.db trailer size {len(data) - reader.offset}; expected 4")
    header["trailer"] = data[reader.offset:].hex()
    return header, maps


def _norm(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _audio_file(folder: Path, filename: str) -> Path | None:
    try:
        entries = {entry.name.casefold(): entry for entry in folder.iterdir() if entry.is_file()}
    except OSError:
        return None
    audio = entries.get(filename.casefold())
    return audio if audio and audio.suffix.casefold() in AUDIO_SUFFIXES else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_pairs(songs_dir: Path, db_maps: list[DbMap], index_path: Path
                ) -> tuple[list[dict], Counter, list[str]]:
    """Use the read-only library index to narrow disk validation to one-line maps."""
    counts: Counter = Counter()
    skipped: list[str] = []
    candidate_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    hash_cache: dict[tuple[str, int, int], str] = {}
    root = songs_dir.resolve()
    db_by_key = {(_norm(row.folder), _norm(row.filename)): row for row in db_maps}
    if not index_path.is_file():
        raise ValueError(f"library index not found: {index_path}; scan Songs first")
    with sqlite3.connect(index_path.as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute(
            "select b.path, b.size, b.mtime_ns, b.artist, b.artist_unicode, "
            "b.title, b.title_unicode, b.audio_file, s.folder "
            ", b.objects "
            "from beatmaps b join sets s on s.id=b.set_id "
            "where b.red_lines=1 and b.mode=0 order by b.path").fetchall()
    counts["indexed_one_line_standard_maps"] = len(rows)
    for (path_text, size, mtime_ns, artist, artist_u, title, title_u, audio_name,
         folder_name, objects) in rows:
        path = Path(path_text)
        entry = db_by_key.get((_norm(Path(folder_name).name), _norm(path.name)))
        if entry is None:
            counts["not_ranked_in_osu_db"] += 1
            continue
        try:
            path.resolve().relative_to(root)
            stat = path.stat()
        except (OSError, ValueError):
            counts["missing_or_unsafe_maps"] += 1
            continue
        if stat.st_size != size or stat.st_mtime_ns != mtime_ns:
            counts["stale_index_maps"] += 1
            skipped.append(f"{folder_name}/{path.name}: library index is stale; rescan it")
            continue
        audio = _audio_file(path.parent, audio_name)
        if audio is None:
            counts["missing_audio"] += 1
            continue
        artist = str(artist_u or artist or "")
        title = str(title_u or title or "")
        if not artist.strip() or not title.strip():
            counts["missing_identity"] += 1
            continue
        counts["ranked_one_line_index_rows"] += 1
        candidate_groups[(_norm(artist), _norm(title))].append({
            "path": str(path), "folder": folder_name, "filename": path.name,
            "status": entry.status, "set_id": entry.set_id, "beatmap_id": entry.beatmap_id,
            "artist": artist, "title": title, "audio": audio, "objects": objects,
        })

    by_digest: dict[str, list[dict]] = defaultdict(list)
    for candidates in candidate_groups.values():
        if len({row["set_id"] for row in candidates}) < 2:
            continue
        # Same artist/title narrows I/O. Size partitions avoid hashing obvious mismatches.
        by_size: dict[int, list[dict]] = defaultdict(list)
        for row in candidates:
            try:
                by_size[row["audio"].stat().st_size].append(row)
            except OSError:
                counts["audio_stat_errors"] += 1
        for sized in by_size.values():
            if len({row["set_id"] for row in sized}) < 2:
                continue
            for row in sized:
                try:
                    stat = row["audio"].stat()
                    cache_key = (str(row["audio"]).casefold(), stat.st_size, stat.st_mtime_ns)
                    digest = hash_cache.get(cache_key)
                    if digest is None:
                        digest = _sha256(row["audio"])
                        hash_cache[cache_key] = digest
                except OSError as exc:
                    counts["audio_hash_errors"] += 1
                    skipped.append(f"{row['audio']}: {exc}")
                    continue
                by_digest[digest].append(row)

    pairs = []
    for digest, group in sorted(by_digest.items()):
        by_set: dict[int, list[dict]] = defaultdict(list)
        for row in group:
            by_set[row["set_id"]].append(row)
        representatives = [max(rows, key=lambda item: (item["objects"], item["path"]))
                           for rows in by_set.values()]
        maps = []
        for row in representatives:
            try:
                beatmap = ta.read_osu_beatmap(row["path"])
                metadata = beatmap.get("metadata", {})
                if (int(metadata.get("BeatmapID", 0) or 0) != row["beatmap_id"]
                        or int(metadata.get("BeatmapSetID", 0) or 0) != row["set_id"]
                        or int(beatmap.get("general", {}).get("Mode", 0) or 0) != 0):
                    counts["stale_or_mismatched_maps"] += 1
                    continue
                red_lines = ta.read_osu_red_lines(row["path"])
                if len(red_lines) != 1:
                    counts["stale_or_mismatched_maps"] += 1
                    continue
            except (OSError, ValueError, TypeError) as exc:
                counts["unreadable_maps"] += 1
                skipped.append(f"{row['folder']}/{row['filename']}: {exc}")
                continue
            row["bpm"] = red_lines[0][1]
            row["offset_ms"] = red_lines[0][0]
            maps.append(row)
        counts["valid_one_line_maps"] += len(maps)
        if len(maps) < 2:
            continue
        for left, right in itertools.combinations(maps, 2):
            forward = cb.score_track([(left["offset_ms"], left["bpm"])],
                                     [(right["offset_ms"], right["bpm"])])[0]
            reverse = cb.score_track([(right["offset_ms"], right["bpm"])],
                                     [(left["offset_ms"], left["bpm"])])[0]
            copied = (left["offset_ms"] == right["offset_ms"]
                      and left["bpm"] == right["bpm"])
            bpm_mean = (left["bpm"] + right["bpm"]) / 2.0
            tempo_band = "slow" if bpm_mean < 100 else "mid" if bpm_mean < 180 else "fast"
            suffix = left["audio"].suffix.casefold().lstrip(".") or "unknown"
            is_tv = "tv size" in " ".join((left["folder"], left["title"])).casefold()
            pairs.append({"audio_sha256": digest, "left": left, "right": right,
                          "forward": forward, "reverse": reverse, "copied": copied,
                          "stratum": f"{tempo_band} BPM / {suffix} / "
                                     f"{'TV Size' if is_tv else 'full'}"})
    counts["audio_groups"] = len({pair["audio_sha256"] for pair in pairs})
    counts["pairs"] = len(pairs)
    counts["identical_timing_pairs"] = sum(pair["copied"] for pair in pairs)
    return pairs, counts, skipped


def agreement_summary(pairs: list[dict]) -> dict:
    directions = [row for pair in pairs for row in (pair["forward"], pair["reverse"])]
    independent_pairs = [pair for pair in pairs if not pair["copied"]]
    independent = [row for pair in independent_pairs
                   for row in (pair["forward"], pair["reverse"])]
    total = len(directions)
    def offset_counts(rows: list[dict]) -> dict[str, int]:
        return {str(tol): sum(row["error_ms"] is not None and
                              abs(row["error_ms"]) <= tol for row in rows)
                for tol in (2, 5, 10, 50)}

    offset = offset_counts(directions)
    independent_offset = offset_counts(independent)
    bpm = sum(row["bpm_error"] is not None and row["bpm_error"] <= 0.05
              for row in directions)
    octave = sum(row["octave"] == 1.0 for row in directions)
    joint = sum(row["error_ms"] is not None and abs(row["error_ms"]) <= 5
                and row["bpm_error"] is not None and row["bpm_error"] <= 0.05
                and row["octave"] == 1.0 for row in directions)
    errors = [row["error_ms"] for row in directions if row["error_ms"] is not None]
    independent_errors = [row["error_ms"] for row in independent
                         if row["error_ms"] is not None]
    independent_joint = sum(row["error_ms"] is not None and abs(row["error_ms"]) <= 5
                            and row["bpm_error"] is not None and row["bpm_error"] <= 0.05
                            and row["octave"] == 1.0 for row in independent)
    return {"pairs": len(pairs), "directions": total, "offset_within_ms": offset,
            "bpm_within_0_05": bpm, "exact_octave": octave, "joint_5ms_bpm_octave": joint,
            "nonidentical_pairs": len(independent_pairs),
            "nonidentical_directions": len(independent),
            "nonidentical_offset_within_ms": independent_offset,
            "nonidentical_joint_5ms_bpm_octave": independent_joint,
            "nonidentical_signed_offset_ms": cb.quartiles(independent_errors),
            "pair_strata": dict(sorted(Counter(pair["stratum"] for pair in pairs).items())),
            "signed_offset_ms": cb.quartiles(errors),
            "copied_pairs": sum(pair["copied"] for pair in pairs)}


def write_audit_sheet(path: Path, pairs: list[dict], sample: int, seed: int) -> None:
    independent = [pair for pair in pairs if not pair["copied"]]
    strata: dict[str, list[dict]] = defaultdict(list)
    rng = random.Random(seed)
    for pair in independent:
        strata[pair["stratum"]].append(pair)
    for members in strata.values():
        rng.shuffle(members)
    selected = []
    while len(selected) < min(sample, len(independent)):
        advanced = False
        for name in sorted(strata):
            if strata[name] and len(selected) < sample:
                selected.append(strata[name].pop())
                advanced = True
        if not advanced:
            break
    lines = ["# Mapper agreement: reference audit", "",
             f"Seed {seed}; {len(selected)} of {len(independent)} non-identical pairs, "
             "sampled round-robin by tempo, audio format and TV Size.",
             "Compare each map in osu!'s editor against the same audio. Record whether the",
             "tempo and phase represent the same audible pulse, or whether either reference",
             "looks invalid. Identical timing may be copied; do not count it as independent",
             "mapper evidence without checking.", "",
             "Verdict options: same pulse / phase differs / BPM or octave differs / invalid map / skip.", ""]
    for index, pair in enumerate(selected, 1):
        left, right = pair["left"], pair["right"]
        lines += [f"## {index}. {left['artist']} — {left['title']}", "",
                  f"- Stratum: {pair['stratum']}",
                  f"- Left: `{left['folder']}\\{left['filename']}` — {left['status']}, "
                  f"{left['offset_ms']:.1f} ms, {left['bpm']:.6f} BPM",
                  f"- Right: `{right['folder']}\\{right['filename']}` — {right['status']}, "
                  f"{right['offset_ms']:.1f} ms, {right['bpm']:.6f} BPM",
                  f"- Pair deltas: left→right {pair['forward']['error_ms']:+.2f} ms, "
                  f"{pair['forward']['bpm_error']:.5f} BPM; right→left "
                  f"{pair['reverse']['error_ms']:+.2f} ms, "
                  f"{pair['reverse']['bpm_error']:.5f} BPM",
                  "- Verdict: ", "- Notes: ", ""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--songs", type=Path, default=SONGS)
    parser.add_argument("--db", type=Path, default=OSU_DB)
    parser.add_argument("--index", type=Path, default=LIBRARY_DB,
                        help="read-only Overtone Songs index (scan first if stale)")
    parser.add_argument("--sample", type=int, default=25,
                        help="non-identical pairs in the hand-check sheet (seeded)")
    parser.add_argument("--seed", type=int, default=26)
    parser.add_argument("--json", type=Path,
                        default=ROOT / "bench" / ".cache" / "mapper_agreement.json")
    parser.add_argument("--sheet", type=Path,
                        default=ROOT / "bench" / ".cache" / "mapper_agreement.md")
    args = parser.parse_args(argv)
    if not args.songs.is_dir() or not args.db.is_file():
        parser.error("Songs folder or osu!.db not found; pass --songs and --db")
    try:
        header, db_maps = parse_osu_db(args.db.read_bytes())
    except (OSError, OsuDbFormatError) as exc:
        parser.error(str(exc))
    try:
        pairs, counts, skipped = build_pairs(args.songs, db_maps, args.index)
    except (OSError, sqlite3.DatabaseError, ValueError) as exc:
        parser.error(str(exc))
    summary = agreement_summary(pairs)
    summary.update({"database": header, "counts": dict(counts), "skipped": skipped,
                    "sample_seed": args.seed})
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
    write_audit_sheet(args.sheet, pairs, max(0, args.sample), args.seed)
    s = summary["signed_offset_ms"]
    offset = "-" if s is None else f"{s['median']:+.2f} [{s['q1']:+.2f}..{s['q3']:+.2f}] ms"
    print(f"osu!.db v{header['version']}: {header['beatmaps']} maps, "
          f"{len(db_maps)} ranked/approved/loved records")
    print(f"validated: {counts['valid_one_line_maps']} one-red-line standard maps; "
          f"{counts['audio_groups']} byte-identical audio groups, {summary['pairs']} pairs "
          f"({summary['copied_pairs']} identical timing pairs)")
    print(f"offset <=2/5/10/50 ms: " + "/".join(
        f"{100 * summary['offset_within_ms'][str(t)] / summary['directions']:.1f}%"
        if summary["directions"] else "0.0%" for t in (2, 5, 10, 50)))
    independent_total = summary["nonidentical_directions"]
    print(f"non-identical pairs only: {summary['nonidentical_pairs']} pairs; "
          f"offset <=5 ms {100 * summary['nonidentical_offset_within_ms']['5'] / independent_total:.1f}%; "
          f"signed {summary['nonidentical_signed_offset_ms']['median']:+.2f} ms"
          if independent_total else "non-identical pairs only: none")
    print(f"BPM <=0.05: {summary['bpm_within_0_05']}/{summary['directions']}; "
          f"exact octave: {summary['exact_octave']}/{summary['directions']}; "
          f"joint: {summary['joint_5ms_bpm_octave']}/{summary['directions']}; "
          f"signed offset {offset}")
    print(f"audit sheet: {args.sheet}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
