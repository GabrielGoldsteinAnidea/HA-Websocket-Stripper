#!/usr/bin/env python3
"""Generate the add-on's icon and the README banner.

Run from the repo root:  python3 tools/make_icon.py

Produces:
  websocket-stripper/icon.png   128x128, dark, shown in the Apps list
  assets/banner.png             1200x320, white, shown at the top of the README

The mark is a funnel: five entities go in, one comes out — the whole add-on in one shape. It
deliberately echoes `mdi:filter-variant`, the panel_icon on the Ingress sidebar entry, so the
sidebar, the stats panel and the Apps list all read as the same thing.

There is deliberately **no logo.png**. Home Assistant renders that small enough on the add-on
page that a wordmark and tagline are illegible, so the add-on ships the mark alone and the
wordmark lives on the README, where there is room for it.

The banner is on a solid white ground rather than transparent: GitHub renders READMEs on both
light and dark, and a transparent PNG would need text that works on both, which no single
colour does. White is legible either way.

Everything is drawn at 4x and downsampled — PIL has no antialiased polygon fill, and the
funnel is all diagonals.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SS = 4  # supersample factor

# Dark palette (icon) — the stats panel's own dark ground and accent.
NAVY = (18, 38, 58)
BLUE = (79, 195, 247)
WHITE = (255, 255, 255)

# Light palette (banner) — same hue family, darkened so it holds against white.
INK = (15, 23, 42)
SKY = (14, 165, 233)
SLATE = (100, 116, 139)

TAGLINE = "not the whole house"

ROOT = Path(__file__).resolve().parent.parent
FONTS = (
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

# The mark in design units on a 1024 grid, so both renderers share one geometry.
DOTS_IN = (250, 381, 512, 643, 774)
DOT_Y, DOT_R = 215, 34
MOUTH_Y, MOUTH_HALF = 345, 322
NECK_Y, NECK_HALF = 585, 46
STEM_Y = 725
OUT_Y = 815


def _face(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    return None


def draw_mark(d, cx, u, oy, funnel_colour, dot_colour):
    """Draw the funnel centred on cx, scaled by u, offset vertically by oy."""
    y = lambda v: int(v * u + oy)
    r = int(DOT_R * u)
    for x in DOTS_IN:
        px = cx + int((x - 512) * u)
        d.ellipse([px - r, y(DOT_Y) - r, px + r, y(DOT_Y) + r], fill=dot_colour)
    d.polygon(
        [
            (cx - int(MOUTH_HALF * u), y(MOUTH_Y)), (cx + int(MOUTH_HALF * u), y(MOUTH_Y)),
            (cx + int(NECK_HALF * u), y(NECK_Y)), (cx + int(NECK_HALF * u), y(STEM_Y)),
            (cx - int(NECK_HALF * u), y(STEM_Y)), (cx - int(NECK_HALF * u), y(NECK_Y)),
        ],
        fill=funnel_colour,
    )
    d.ellipse([cx - r, y(OUT_Y) - r, cx + r, y(OUT_Y) + r], fill=dot_colour)


def make_icon(px=128):
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.18), fill=NAVY)
    draw_mark(d, S // 2, S / 1024, 0, BLUE, WHITE)
    return img.resize((px, px), Image.LANCZOS)


def make_banner(w=1200, h=320):
    W, H = w * SS, h * SS
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    margin = int(W * 0.045)
    u = (H * 0.62) / (OUT_Y + DOT_R - (DOT_Y - DOT_R))   # mark height as a share of the banner
    cx = margin + int(MOUTH_HALF * u)
    oy = (H - (OUT_Y + DOT_R - (DOT_Y - DOT_R)) * u) / 2 - (DOT_Y - DOT_R) * u
    draw_mark(d, cx, u, oy, SKY, INK)

    tx = cx + int(MOUTH_HALF * u) + int(W * 0.05)
    f_big = _face(int(H * 0.26))
    if not f_big:
        return img.resize((w, h), Image.LANCZOS)

    # Wordmark on one line, so the banner reads as a title rather than a stack.
    name_a, name_b = "WebSocket ", "Stripper"
    d.text((tx, int(H * 0.28)), name_a, font=f_big, fill=INK)
    d.text((tx + f_big.getlength(name_a), int(H * 0.28)), name_b, font=f_big, fill=SKY)

    # Fit the tagline to what is left, so editing TAGLINE can never push it off the canvas.
    avail = W - tx - margin
    size = int(H * 0.13)
    while size > 10 and _face(size).getlength(TAGLINE) > avail:
        size -= 2
    d.text((tx + 3, int(H * 0.60)), TAGLINE, font=_face(size), fill=SLATE)
    return img.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    (ROOT / "websocket-stripper").mkdir(exist_ok=True)
    (ROOT / "assets").mkdir(exist_ok=True)
    make_icon().save(ROOT / "websocket-stripper" / "icon.png")
    make_banner().save(ROOT / "assets" / "banner.png")
    print("wrote websocket-stripper/icon.png and assets/banner.png")
