"""Overtone application logo, generated — never hand-drawn.

The mark: an overtone series (fundamental plus two fading harmonics, mint)
cut by one red timing line, on the app's own panel colour. Everything is
drawn in code with the standard library only, so anyone can regenerate it
with the repo's own interpreter:

    .venv/Scripts/python.exe assets/logo.py

Outputs (all idempotent, byte for byte):
  assets/logo.png   256x256 RGBA, the GUI window icon
  assets/logo.ico   16/32/48/256 PNG-compressed entries, for installers
"""

import math
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Design tokens borrowed from docs/04-ui-ux.md and the Tk theme.
BG = (0x15, 0x1C, 0x29, 0xFF)      # panel
MINT = (0x4F, 0xC0, 0x8A)          # accent
RED = (0xE0, 0x60, 0x6C, 0xFF)     # timing points
SIZE = 256
SUPER = 2                          # supersample factor (antialiasing)
RADIUS = 40                        # rounded-corner radius at 256 px


def rounded_rect(w, h, radius):
    """Per-pixel coverage mask (0.0..1.0) of a rounded rectangle."""
    mask = [0.0] * (w * h)
    r = radius
    for y in range(h):
        for x in range(w):
            cx = min(max(x, r - 1), w - r)
            cy = min(max(y, r - 1), h - r)
            dx, dy = x - cx, y - cy
            dist = math.hypot(dx, dy)
            if dist <= r - 1.0:
                cover = 1.0
            elif dist >= r:
                cover = 0.0
            else:
                cover = r - dist  # 1 px feathered edge
            mask[y * w + x] = cover
    return mask


def stamp(canvas, w, cx, cy, radius, color):
    """Filled disc, alpha-composited over RGBA canvas."""
    r, g, b, a = color
    x0, x1 = max(0, int(cx - radius - 1)), min(w - 1, int(cx + radius + 1))
    h = len(canvas) // w // 4
    y0, y1 = max(0, int(cy - radius - 1)), min(h - 1, int(cy + radius + 1))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dist = math.hypot(x - cx, y - cy)
            if dist > radius:
                continue
            cover = min(1.0, radius - dist + 0.5)
            i = (y * w + x) * 4
            dst_a = canvas[i + 3] / 255.0
            src_a = (a / 255.0) * cover
            out_a = src_a + dst_a * (1.0 - src_a)
            if out_a <= 0.0:
                canvas[i:i + 4] = bytes((0, 0, 0, 0))
                continue
            for c, s in zip((i, i + 1, i + 2), (r, g, b)):
                canvas[c] = int(round(
                    (s * src_a + canvas[c] * dst_a * (1.0 - src_a)) / out_a
                ))
            canvas[i + 3] = int(round(out_a * 255.0))


def downsample(pixels, w, h, factor):
    """Box-filter shrink by an integer factor."""
    nw, nh = w // factor, h // factor
    out = bytearray(nw * nh * 4)
    for y in range(nh):
        for x in range(nw):
            acc = [0, 0, 0, 0]
            for dy in range(factor):
                for dx in range(factor):
                    i = ((y * factor + dy) * w + (x * factor + dx)) * 4
                    for c in range(4):
                        acc[c] += pixels[i + c]
            n = factor * factor
            o = (y * nw + x) * 4
            for c in range(4):
                out[o + c] = int(round(acc[c] / n))
    return bytes(out), nw, nh


def render(size):
    """Full mark at `size` px square. Returns RGBA bytes."""
    w = h = size * SUPER
    canvas = bytearray(b"\x00\x00\x00\x00" * (w * h))
    mask = rounded_rect(w, h, RADIUS * SUPER)
    # Panel background through the mask.
    for i, cover in enumerate(mask):
        o = i * 4
        canvas[o:o + 4] = bytes((BG[0], BG[1], BG[2], int(round(BG[3] * cover))))
    # Overtone series: fundamental plus two fading harmonics, mint.
    mid = h / 2.0
    for harmonic, (amp_frac, alpha, width) in enumerate(
        [(0.30, 1.00, 7.0), (0.20, 0.55, 5.5), (0.13, 0.32, 4.5)], start=1
    ):
        amp = amp_frac * h
        steps = w // 2
        for s in range(steps + 1):
            x = s * (w - 1) / steps
            y = mid + amp * math.sin(2.0 * math.pi * harmonic * s / steps)
            stamp(canvas, w, x, y, width, (*MINT, int(round(255 * alpha))))
    # One red timing line, over the waves, left of centre.
    line_x = w * 0.36
    line_w = max(2.0, 7.0 * SUPER / 2.0)
    for y in range(h):
        for x in range(int(line_x - line_w), int(line_x + line_w) + 1):
            if 0 <= x < w:
                i = (y * w + x) * 4
                canvas[i:i + 4] = bytes(RED)
    # Clip everything (waves, line, panel) to the rounded rect: outside
    # the mask the icon is transparent, never panel-coloured.
    for i, cover in enumerate(mask):
        o = i * 4 + 3
        canvas[o] = int(round(canvas[o] * cover))
    if SUPER > 1 or size != SIZE:
        pixels, _, _ = downsample(bytes(canvas), w, h, max(1, w // size))
        return pixels
    return bytes(canvas)


def png_bytes(rgba, size):
    """Minimal RGBA PNG: signature, IHDR, IDAT, IEND."""
    raw = b"".join(
        b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size)
    )

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(sizes):
    """Vista-style ICO: PNG-compressed entries, no BMP legacy."""
    images = []
    for size in sizes:
        images.append(png_bytes(render(size), size))
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    out = [header]
    for size, data in zip(sizes, images):
        dim = size if size < 256 else 0
        out.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    out.extend(images)
    return b"".join(out)


def main():
    HERE.mkdir(parents=True, exist_ok=True)
    png = HERE / "logo.png"
    ico = HERE / "logo.ico"
    png.write_bytes(png_bytes(render(SIZE), SIZE))
    ico.write_bytes(ico_bytes([16, 32, 48, 256]))
    print(f"wrote {png} ({png.stat().st_size} bytes)")
    print(f"wrote {ico} ({ico.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
