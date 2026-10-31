#!/usr/bin/env python3
"""Builds the phone's bitmap fonts (client/res/fonts/) from Roboto.

Phone system fonts are few (3 sizes) and often too big and wide for the
page's layout, so page text is drawn with these instead. Per size and
style: <style><size>.png, an atlas of antialiased glyphs (black, alpha),
and <style><size>.bin, big-endian:
  u8 version (2), u8 cell height, u8 baseline (from the cell top),
  u8 ascent, u8 descent (the font's normal line, without stacked accents),
  u16 count,
  count x (u16 char, u16 x, u16 y, u8 width, s8 left offset, u16 advance)
sorted by char, advance in 1/8 px. Each glyph is a cell of the line
height; it is drawn at pen x + left offset, and the pen moves by advance.

Run from the repo root after changing sizes or characters (needs Pillow):
  python client/tools/mkfont.py
The output is committed, so builds don't need Python.
"""
import os
import struct

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'res', 'fonts')
STYLES = {'r': 'Roboto-Regular.ttf', 'b': 'Roboto-Bold.ttf'}
# Em sizes in px. TextFrame picks by these numbers, keep them in sync.
SIZES = [9, 10, 11, 12, 13, 14, 16, 18]
ATLAS_W = 512


def charset():
    cs = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100))
    # Vietnamese letters outside Latin-1.
    cs |= {0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169, 0x1A0, 0x1A1, 0x1AF, 0x1B0}
    cs |= set(range(0x1EA0, 0x1EFA))
    # Dashes, quotes, bullet, ellipsis, per mille, primes, currency, (tm).
    cs |= set(range(0x2010, 0x2028)) | {0x2030, 0x2032, 0x2033, 0x20AB, 0x20AC, 0x2122}
    return sorted(cs)


def build(style, size):
    font = ImageFont.truetype(os.path.join(HERE, 'fonts', STYLES[style]), size)
    chars = []
    for c in charset():
        ch = chr(c)
        if c != 0x20 and font.getmask(ch).getbbox() is None and c not in (0xA0,):
            continue  # not in the font
        chars.append(c)
    # Vertical extent over all glyphs (stacked Vietnamese accents go above
    # the ascender), origin at the baseline.
    asc, desc = font.getmetrics()
    top, bottom = -asc, desc
    boxes = {}
    for c in chars:
        l, t, r, b = font.getbbox(chr(c), anchor='ls')
        boxes[c] = (l, r)
        if r > l:
            top = min(top, t)
            bottom = max(bottom, b)
    h = bottom - top
    base = -top
    # Pack cells in rows.
    x = y = 0
    places = []
    for c in chars:
        l, r = boxes[c]
        w = max(0, r - l)
        if x + w > ATLAS_W:
            x = 0
            y += h
        places.append((c, x, y, w, l, round(font.getlength(chr(c)) * 8)))
        x += w
    mask = Image.new('L', (ATLAS_W, y + h), 0)
    d = ImageDraw.Draw(mask)
    for c, gx, gy, w, l, adv in places:
        if w:
            d.text((gx - l, gy + base), chr(c), font=font, fill=255, anchor='ls')
    # 16 alpha levels in a palette PNG (black, tRNS): a fraction of the
    # size of 8-bit RGBA, and phones only need the alpha.
    img = mask.point(lambda v: (v * 15 + 127) // 255)
    img.putpalette([0, 0, 0] * 16)
    img.info['transparency'] = bytes((a * 255 + 7) // 15 for a in range(16))
    # Trim unused width of a single-row atlas.
    used = mask.getbbox()
    if used and y == 0:
        img = img.crop((0, 0, max(1, used[2]), h))
    name = '%s%d' % (style, size)
    img.save(os.path.join(OUT, name + '.png'), optimize=True, bits=4,
             transparency=img.info['transparency'])
    with open(os.path.join(OUT, name + '.bin'), 'wb') as f:
        f.write(struct.pack('>BBBBBH', 2, h, base, asc, desc, len(places)))
        for c, gx, gy, w, l, adv in places:
            f.write(struct.pack('>HHHBbH', c, gx, gy, w, l, adv))
    return name, h, base, len(places)


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        os.remove(os.path.join(OUT, f))
    for style in STYLES:
        for size in SIZES:
            print('%s: line %d, baseline %d, %d glyphs' % build(style, size))


if __name__ == '__main__':
    main()
