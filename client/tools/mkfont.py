#!/usr/bin/env python3
"""Builds the phone's bitmap fonts (client/res/fonts/) from Roboto: smooth
(antialiased, light hinting) and sharp (antialiased with FreeType's full
autohinting: stems snapped to whole pixels, so they are crisp like phone
fonts while curves and diagonals keep smooth edges). 256 alpha levels.

Phone system fonts are few (3 sizes) and often too big and wide for the
page's layout, so page text is drawn with these instead. Per size and
style one file, <style><size>.bin (sharp set: <style>s<size>), big-endian:
  u8 version (4), u8 cell height, u8 baseline (from the cell top),
  u8 ascent, u8 descent (the font's normal line, without stacked accents),
  u16 count,
  count x (u16 char, u16 x, u16 y, u8 width, s8 left offset, u16 advance,
           u8 hinted advance)
  u16 atlas width, u16 atlas height, then width x height coverage bytes
sorted by char, advance in 1/8 px, hinted advance in px. Glyph x, y are in
the atlas; each glyph is a cell of the line height, drawn at pen x + left
offset, and the pen moves by advance.

Page text uses the unhinted advances, as Chromium lays text out: the
server lays pages out with the same font (server/fonts/, made here too),
so lines are as wide on the phone as there. The app's own text (menu,
toasts) uses the hinted ones: even spacing.

Run from the repo root after changing sizes or characters:
  pip install pillow freetype-py fonttools
  python client/tools/mkfont.py
The output is committed, so builds don't need Python.
"""
import os
import struct

import freetype
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'res', 'fonts')
SERVER_OUT = os.path.join(HERE, '..', '..', 'server', 'fonts')
STYLES = {'r': 'Roboto-Regular.ttf', 'b': 'Roboto-Bold.ttf'}
# Em sizes in px. TextFrame picks by these numbers, keep them in sync.
SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24]
ATLAS_W = 512

SMOOTH_FLAGS = freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_LIGHT
SHARP_FLAGS = freetype.FT_LOAD_RENDER | freetype.FT_LOAD_FORCE_AUTOHINT | freetype.FT_LOAD_TARGET_NORMAL


def charset():
    cs = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100))
    # Vietnamese letters outside Latin-1.
    cs |= {0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169, 0x1A0, 0x1A1, 0x1AF, 0x1B0}
    cs |= set(range(0x1EA0, 0x1EFA))
    # Dashes, quotes, bullet, ellipsis, per mille, primes, currency, (tm).
    cs |= set(range(0x2010, 0x2028)) | {0x2030, 0x2032, 0x2033, 0x20AB, 0x20AC, 0x2122}
    return sorted(cs)


def glyph_image(bm):
    """FreeType bitmap -> 'L' image (0..255 coverage)."""
    w, h = bm.width, bm.rows
    buf = bytes(bm.buffer)
    if bm.pixel_mode != freetype.FT_PIXEL_MODE_MONO:
        return Image.frombytes('L', (w, h), buf, 'raw', 'L', bm.pitch)
    img = Image.new('L', (w, h), 0)
    px = img.load()
    for y in range(h):
        row = y * bm.pitch
        for x in range(w):
            if buf[row + (x >> 3)] & (0x80 >> (x & 7)):
                px[x, y] = 255
    return img


def build(style, size, sharp):
    face = freetype.Face(os.path.join(HERE, 'fonts', STYLES[style]))
    face.set_pixel_sizes(0, size)
    asc = (face.size.ascender + 32) >> 6
    desc = (-face.size.descender + 32) >> 6
    glyphs = []
    for c in charset():
        if c not in (0x20, 0xA0) and face.get_char_index(c) == 0:
            continue  # not in the font
        face.load_char(chr(c), SHARP_FLAGS if sharp else SMOOTH_FLAGS)
        g = face.glyph
        img = glyph_image(g.bitmap) if g.bitmap.width and g.bitmap.rows else None
        if img is not None and img.getbbox() is None:
            img = None
        adv8 = round(g.linearHoriAdvance * 8 / 65536)
        glyphs.append((c, img, g.bitmap_left, g.bitmap_top, (adv8, (g.advance.x + 32) >> 6)))
    # Vertical extent over all glyphs (stacked Vietnamese accents go above
    # the ascender), origin at the baseline.
    top, bottom = -asc, desc
    for c, img, left, btop, adv8 in glyphs:
        if img:
            top = min(top, -btop)
            bottom = max(bottom, img.height - btop)
    h = bottom - top
    base = -top
    # Pack cells in rows.
    x = y = 0
    places = []
    for c, img, left, btop, adv8 in glyphs:
        w = img.width if img else 0
        if x + w > ATLAS_W:
            x = 0
            y += h
        places.append((c, x, y, w, left, adv8, img, btop))
        x += w
    mask = Image.new('L', (ATLAS_W, y + h), 0)
    for c, gx, gy, w, left, adv8, img, btop in places:
        if img:
            mask.paste(img, (gx, gy + base - btop))
    # Trim unused width of a single-row atlas.
    used = mask.getbbox()
    if used and y == 0:
        mask = mask.crop((0, 0, max(1, used[2]), h))
    # The coverage goes into the .bin as raw bytes (the jar compresses it):
    # phones decode PNG transparency differently, Nokia S60 as on/off only,
    # which turned antialiased edges solid.
    name = '%s%s%d' % (style, 's' if sharp else '', size)
    with open(os.path.join(OUT, name + '.bin'), 'wb') as f:
        f.write(struct.pack('>BBBBBH', 4, h, base, asc, desc, len(places)))
        for c, gx, gy, w, left, adv, img, btop in places:
            f.write(struct.pack('>HHHBbHB', c, gx, gy, w, left, adv[0], adv[1]))
        f.write(struct.pack('>HH', mask.width, mask.height))
        f.write(mask.tobytes())
    return name, h, base, len(places)


def server_fonts():
    """The same font, cut to the same characters, for the server: Chromium
    lays the page out with it (server/fonts/<s|r>-<r|b>.ttf; both sets are
    Roboto, s: sharp, r: smooth)."""
    from fontTools import subset
    os.makedirs(SERVER_OUT, exist_ok=True)
    for f in os.listdir(SERVER_OUT):
        os.remove(os.path.join(SERVER_OUT, f))
    opts = subset.Options()
    opts.hinting = True
    opts.layout_features = ['kern', 'liga', 'ccmp', 'mark', 'mkmk']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    for set_name in ('s', 'r'):
        for style, ttf in STYLES.items():
            font = subset.load_font(os.path.join(HERE, 'fonts', ttf), opts)
            sub = subset.Subsetter(opts)
            sub.populate(unicodes=charset())
            sub.subset(font)
            out = os.path.join(SERVER_OUT, '%s-%s.ttf' % (set_name, style))
            subset.save_font(font, out, opts)
            print('%s: %d bytes' % (os.path.normpath(out), os.path.getsize(out)))


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        os.remove(os.path.join(OUT, f))
    for sharp in (False, True):
        for style in STYLES:
            for size in SIZES:
                print('%s: line %d, baseline %d, %d glyphs' % build(style, size, sharp))
    server_fonts()


if __name__ == '__main__':
    main()
