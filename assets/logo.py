"""Overtone application logo, generated — never hand-drawn.

The mark: an overtone series (fundamental plus two fading harmonics, mint)
cut by one red timing line, on the app's own panel colour. Everything is
drawn in code with the standard library only, so anyone can regenerate it
with the repo's own interpreter:

    .venv/Scripts/python.exe assets/logo.py

Outputs (all idempotent, byte for byte):
  assets/logo.png   256x256 RGBA, the GUI window icon
  assets/logo.ico   16/20/24/32/40/48/64 as 32-bit BMP entries plus 256 as
                    PNG: every size Windows asks for at 100-200 % scaling

Every size is drawn at its own size, not shrunk from 256: the geometry was
fixed in 256-px units, so at 16 px the corner radius was larger than the icon
and the title bar showed a red corner fragment. Small sizes draw a simpler
mark (the fundamental alone, thicker, and a pixel-aligned line), because the
faint harmonics turn to mush below 32 px. Entries under 256 are BMP, not PNG:
.NET Framework's System.Drawing.Icon, which the window's title bar goes
through, does not reliably read PNG frames below 256.
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
#: Every size in the .ico: 16/20/24/32 are the small icon at 100/125/150/200 %,
#: 32/40/48/64 the large one, 256 the jumbo view.
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 256)
#: Below this the mark is simplified: one wave, no faint harmonics.
SIMPLE_BELOW = 32


def supersample(size):
    """Antialiasing factor: fine for small icons, affordable for big ones."""
    return max(2, min(8, 512 // size))


def rounded_rect(w, h, radius):
    """Per-pixel coverage mask (0.0..1.0) of a rounded rectangle."""
    mask = [0.0] * (w * h)
    r = max(1.0, radius)
    for y in range(h):
        for x in range(w):
            # Distance to the nearest point of the inner rectangle, measured
            # from the pixel's centre.
            px, py = x + 0.5, y + 0.5
            cx = min(max(px, r), w - r)
            cy = min(max(py, r), h - r)
            dist = math.hypot(px - cx, py - cy)
            mask[y * w + x] = min(1.0, max(0.0, r - dist + 0.5))
    return mask


def stamp(canvas, w, cx, cy, radius, color):
    """Filled disc, alpha-composited over RGBA canvas."""
    r, g, b, a = color
    x0, x1 = max(0, int(cx - radius - 1)), min(w - 1, int(cx + radius + 1))
    h = len(canvas) // w // 4
    y0, y1 = max(0, int(cy - radius - 1)), min(h - 1, int(cy + radius + 1))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dist = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if dist > radius + 0.5:
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
    """Box-filter shrink by an integer factor, in premultiplied alpha so a
    transparent neighbour does not darken an edge."""
    nw, nh = w // factor, h // factor
    out = bytearray(nw * nh * 4)
    n = factor * factor
    for y in range(nh):
        for x in range(nw):
            acc = [0.0, 0.0, 0.0, 0.0]
            for dy in range(factor):
                for dx in range(factor):
                    i = ((y * factor + dy) * w + (x * factor + dx)) * 4
                    a = pixels[i + 3]
                    acc[0] += pixels[i] * a
                    acc[1] += pixels[i + 1] * a
                    acc[2] += pixels[i + 2] * a
                    acc[3] += a
            o = (y * nw + x) * 4
            alpha = acc[3] / n
            if acc[3] > 0:
                for c in range(3):
                    out[o + c] = int(round(acc[c] / acc[3]))
            out[o + 3] = int(round(alpha))
    return bytes(out), nw, nh


def render(size):
    """The mark drawn for `size` px square. Returns RGBA bytes.

    Geometry is in output pixels (from the 256-px design, scaled), with floors
    so strokes stay visible: a wave at least 2 px thick, the line at least 2.
    """
    ss = supersample(size)
    w = h = size * ss
    scale = size / 256.0
    simple = size < SIMPLE_BELOW
    canvas = bytearray(b"\x00\x00\x00\x00" * (w * h))
    mask = rounded_rect(w, h, 40.0 * scale * ss)
    for i, cover in enumerate(mask):
        o = i * 4
        canvas[o:o + 4] = bytes((BG[0], BG[1], BG[2], int(round(BG[3] * cover))))
    # Overtone series: the fundamental, then two fading harmonics (big sizes).
    # (amplitude as a fraction of the height, alpha, stroke width in px at 256)
    waves = [(0.30, 1.00, 14.0), (0.20, 0.55, 11.0), (0.13, 0.32, 9.0)]
    if simple:
        waves = [(0.28, 1.00, 14.0)]
    mid = h / 2.0
    for harmonic, (amp_frac, alpha, width) in enumerate(waves, start=1):
        amp = amp_frac * h
        stroke = max(2.0 if simple else 1.5, width * scale) * ss
        steps = w * 2
        for s in range(steps + 1):
            x = s * w / steps
            y = mid + amp * math.sin(2.0 * math.pi * harmonic * s / steps)
            stamp(canvas, w, x, y, stroke / 2.0, (*MINT, int(round(255 * alpha))))
    # One red timing line, over the waves, left of centre; whole output pixels
    # wide and on the pixel grid, so it stays crisp at 16 px.
    line_px = max(2, int(round(7.0 * scale)))
    left = int(round(size * 0.36 - line_px / 2.0))
    for y in range(h):
        for x in range(left * ss, (left + line_px) * ss):
            if 0 <= x < w:
                i = (y * w + x) * 4
                canvas[i:i + 4] = bytes(RED)
    # Clip everything (waves, line, panel) to the rounded rect: outside
    # the mask the icon is transparent, never panel-coloured.
    for i, cover in enumerate(mask):
        o = i * 4 + 3
        canvas[o] = int(round(canvas[o] * cover))
    pixels, _, _ = downsample(bytes(canvas), w, h, ss)
    return pixels


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


def bmp_entry(rgba, size):
    """A classic ICO image: BITMAPINFOHEADER, 32-bit BGRA rows bottom-up,
    then the 1-bit AND mask (set where the pixel is fully transparent)."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    rows = []
    for y in range(size - 1, -1, -1):
        row = bytearray()
        for x in range(size):
            r, g, b, a = rgba[(y * size + x) * 4:(y * size + x) * 4 + 4]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    stride = ((size + 31) // 32) * 4
    mask = []
    for y in range(size - 1, -1, -1):
        bits = bytearray(stride)
        for x in range(size):
            if rgba[(y * size + x) * 4 + 3] == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask.append(bytes(bits))
    return header + b"".join(rows) + b"".join(mask)


def ico_bytes(sizes):
    """ICO with a BMP entry per small size and a PNG one at 256."""
    images = []
    for size in sizes:
        rgba = render(size)
        images.append(png_bytes(rgba, size) if size >= 256 else bmp_entry(rgba, size))
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
    ico.write_bytes(ico_bytes(ICO_SIZES))
    print(f"wrote {png} ({png.stat().st_size} bytes)")
    print(f"wrote {ico} ({ico.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
