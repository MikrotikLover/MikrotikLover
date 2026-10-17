#!/usr/bin/env python3
"""A very small PDF writer (no extra packages): A4 pages, Helvetica text, lines, filled boxes,
simple tables and bar charts. Enough for the monthly security report.

    doc = PDF(title="Report")
    doc.h1("Security report"); doc.p("Some text ..."); doc.table(["A", "B"], [["1", "2"]])
    doc.bars([("01", {"virus": 3}), ...], {"virus": (0.8, 0.2, 0.2)})
    open("r.pdf", "wb").write(doc.output())
Text is Latin (WinAnsi): other characters become "?" (emoji are dropped).
"""
import zlib
from datetime import datetime

W, H = 595.28, 841.89            # A4 in points
M = 42                           # page margin

# Helvetica character widths (1/1000 em) for ASCII 32..126, from the standard AFM
_HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
       556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
       667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
       556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_WIN = {"—": 0x97, "–": 0x96, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85, "€": 0x80, "·": 0xB7, "×": 0xD7}


def _enc(s):
    out = bytearray()
    for ch in str(s):
        o = ord(ch)
        if ch in _WIN:
            out.append(_WIN[ch])
        elif 32 <= o < 127 or 160 <= o < 256:
            out.append(o)
        elif o >= 0x1F000 or 0x2600 <= o < 0x2800 or o == 0xFE0F:
            continue                                   # emoji / symbols: dropped
        else:
            out.append(ord("?"))
    return bytes(out).replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def width(s, size, bold=False):
    w = 0
    for ch in str(s):
        o = ord(ch)
        w += _HW[o - 32] if 32 <= o < 127 else 556
    return w * size / 1000 * (1.05 if bold else 1.0)


def wrap(s, size, maxw, bold=False):
    lines, cur = [], ""
    for word in str(s).split():
        t = (cur + " " + word).strip()
        if width(t, size, bold) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


class PDF:
    def __init__(self, title="", footer=""):
        self.title, self.footer = title, footer
        self.pages, self.ops, self.y = [], [], H - M
        self.new_page()

    # -------------------------------------------------------------- low level
    def new_page(self):
        if self.ops:
            self.pages.append(self.ops)
        self.ops, self.y = [], H - M

    def need(self, h):
        if self.y - h < M + 18:
            self.new_page()

    def text(self, x, y, s, size=10, bold=False, color=(0.1, 0.12, 0.16)):
        self.ops.append(b"BT /F%d %.1f Tf %.3f %.3f %.3f rg %.2f %.2f Td (" % (2 if bold else 1, size, *color, x, y) + _enc(s) + b") Tj ET")

    def rect(self, x, y, w, h, fill=(0.9, 0.9, 0.9), stroke=None):
        op = b"%.3f %.3f %.3f rg %.2f %.2f %.2f %.2f re f" % (*fill, x, y, w, h)
        if stroke:
            op = b"%.3f %.3f %.3f RG %.3f %.3f %.3f rg %.2f %.2f %.2f %.2f re B" % (*stroke, *fill, x, y, w, h)
        self.ops.append(op)

    def line(self, x1, y1, x2, y2, color=(0.85, 0.87, 0.9), lw=0.6):
        self.ops.append(b"%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S" % (*color, lw, x1, y1, x2, y2))

    # -------------------------------------------------------------- blocks
    def h1(self, s, sub=""):
        self.need(50)
        self.text(M, self.y - 20, s, 20, True)
        self.y -= 28
        if sub:
            self.text(M, self.y - 10, sub, 10, color=(0.4, 0.45, 0.5))
            self.y -= 18
        self.line(M, self.y - 4, W - M, self.y - 4, (0.15, 0.39, 0.92), 1.5)
        self.y -= 14

    def h2(self, s):
        self.need(80)            # heading + at least a table header and a row on the same page
        self.y -= 8
        self.text(M, self.y - 13, s, 13, True)
        self.y -= 22

    def p(self, s, size=10, color=(0.1, 0.12, 0.16), bullet=False, bold=False):
        x = M + (12 if bullet else 0)
        for i, ln in enumerate(wrap(s, size, W - 2 * M - (12 if bullet else 0), bold)):
            self.need(size + 5)
            if bullet and i == 0:
                self.text(M + 2, self.y - size, "•", size, color=color)
            self.text(x, self.y - size, ln, size, bold, color)
            self.y -= size + 4
        self.y -= 3

    def tiles(self, items):
        """items: [(label, value, hint, color)] in one row."""
        self.need(64)
        n = max(len(items), 1)
        gap = 8
        w = (W - 2 * M - gap * (n - 1)) / n
        for i, (label, value, hint, color) in enumerate(items):
            x = M + i * (w + gap)
            self.rect(x, self.y - 56, w, 56, (0.97, 0.98, 0.99), (0.86, 0.88, 0.91))
            self.rect(x, self.y - 56, 3, 56, color)
            self.text(x + 10, self.y - 15, label, 8.5, color=(0.4, 0.45, 0.5))
            self.text(x + 10, self.y - 35, value, 17, True)
            if hint:
                self.text(x + 10, self.y - 49, hint[:40], 7.5, color=(0.4, 0.45, 0.5))
        self.y -= 66

    def table(self, head, rows, widths=None, size=8.5, empty="Nothing."):
        tw = W - 2 * M
        widths = widths or [1] * len(head)
        tot = sum(widths)
        cols = [w / tot * tw for w in widths]
        rh = size + 7

        def header():
            self.need(rh * 2)
            self.rect(M, self.y - rh, tw, rh, (0.94, 0.95, 0.97))
            x = M
            for c, w in zip(head, cols):
                self.text(x + 4, self.y - rh + 5, str(c).upper(), size - 1, True, (0.35, 0.4, 0.46))
                x += w
            self.y -= rh
        header()
        if not rows:
            self.text(M + 4, self.y - rh + 5, empty, size, color=(0.4, 0.45, 0.5))
            self.y -= rh + 6
            return
        for r in rows:
            cells = [wrap(v, size, w - 8)[:3] for v, w in zip(r, cols)]
            hh = rh + (max(len(c) for c in cells) - 1) * (size + 2)
            if self.y - hh < M + 18:
                self.new_page()
                header()
            x = M
            for c, w in zip(cells, cols):
                for j, ln in enumerate(c):
                    self.text(x + 4, self.y - rh + 5 - j * (size + 2), ln, size)
                x += w
            self.y -= hh
            self.line(M, self.y, M + tw, self.y)
        self.y -= 8

    def bars(self, points, colors, height=120, labels_every=None):
        """points: [(label, {series: value})] stacked bars; colors: {series: (r,g,b)} (legend order)."""
        self.need(height + 40)
        top = max([sum(v.values()) for _, v in points] + [1])
        x0, y0, cw = M + 28, self.y - height, W - 2 * M - 28
        for i in range(5):
            yy = y0 + height * i / 4
            self.line(x0, yy, x0 + cw, yy)
            self.text(M, yy - 3, f"{top * i / 4:.0f}", 7, color=(0.45, 0.5, 0.55))
        bw = cw / max(len(points), 1)
        every = labels_every or max(1, len(points) // 15)
        for i, (lab, vals) in enumerate(points):
            x, base = x0 + i * bw + bw * 0.15, y0
            for s, col in colors.items():
                v = vals.get(s, 0)
                if v:
                    hgt = height * v / top
                    self.rect(x, base, bw * 0.7, hgt, col)
                    base += hgt
            if i % every == 0:
                self.text(x, y0 - 10, lab, 6.5, color=(0.45, 0.5, 0.55))
        lx = x0
        for s, col in colors.items():
            self.rect(lx, y0 - 24, 8, 8, col)
            self.text(lx + 11, y0 - 23, s, 8)
            lx += width(s, 8) + 28
        self.y = y0 - 34

    # -------------------------------------------------------------- file
    def output(self):
        self.pages.append(self.ops)
        self.ops = []
        n = len(self.pages)
        objs = [None,
                b"<< /Type /Catalog /Pages 2 0 R >>",
                None,
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]
        kids = []
        for i, ops in enumerate(self.pages, 1):
            if self.footer or n > 1:
                ops = ops + [b"BT /F1 7.5 Tf 0.45 0.5 0.55 rg %.2f %.2f Td (" % (M, 22) + _enc(f"{self.footer}   page {i} / {n}".strip()) + b") Tj ET"]
            data = zlib.compress(b"\n".join(ops))
            objs.append(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream")
            content = len(objs) - 1
            objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>" % (W, H, content))
            kids.append(len(objs) - 1)
        objs[2] = b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % n
        objs.append(b"<< /Title (" + _enc(self.title) + b") /Producer (MikrotikLover) /CreationDate (D:" + datetime.now().strftime("%Y%m%d%H%M%S").encode() + b") >>")
        info = len(objs) - 1
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offs = []
        for i in range(1, len(objs)):
            offs.append(len(out))
            out += b"%d 0 obj\n" % i + objs[i] + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % len(objs)
        for o in offs:
            out += b"%010d 00000 n \n" % o
        out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs), info, xref)
        return bytes(out)
