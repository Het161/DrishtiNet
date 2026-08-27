#!/usr/bin/env python3
"""
Markdown to a product-styled PDF.

Used for the High-Level Design and the technical annex, where the deck's slide format would be the
wrong shape — these are read, not presented, so they get a document layout with a title page, page
numbers and generous measure.

Light rather than dark, unlike the slides. A twenty-page document read on screen or printed is
easier dark-on-light, and printing a dark PDF wastes toner and comes out muddy. The accent colours
still come from the product's tokens, so it reads as the same system.

Fonts are vendored under assets/fonts and referenced by absolute path. Without that the renderer
falls back to whatever the machine happens to have — Helvetica Neue and Andale Mono here — so the
document would look different on every build host and would not match the product it describes.
The CSS below is a plain string with a placeholder, not an f-string: CSS is mostly braces, and
escaping every one of them is a reliable way to introduce a bug nobody notices until the output is
already wrong.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

import markdown
from weasyprint import HTML, CSS

FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"

CSS_TEMPLATE = """
@font-face { font-family: Inter; font-weight: 400; src: url("__FONTS__/Inter-Regular.ttf"); }
@font-face { font-family: Inter; font-weight: 600; src: url("__FONTS__/Inter-SemiBold.ttf"); }
@font-face { font-family: Inter; font-weight: 700; src: url("__FONTS__/Inter-Bold.ttf"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400;
             src: url("__FONTS__/JetBrainsMono-Regular.ttf"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 700;
             src: url("__FONTS__/JetBrainsMono-Bold.ttf"); }

@page {
  size: A4;
  margin: 22mm 20mm 20mm;
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: "JetBrains Mono", monospace;
    font-size: 8pt;
    color: #8a93a6;
  }
}
@page :first { margin: 0; }

body { font-family: Inter, sans-serif; font-size: 10.2pt; line-height: 1.55; color: #14181f; }

/* Title page. Full-bleed and dark, so the document opens looking like the product. */
.cover { background: #0b0e14; color: #e6eaf2; padding: 60mm 20mm 20mm; height: 297mm;
         page-break-after: always; }
.cover .eyebrow { font-family: "JetBrains Mono", monospace; font-size: 9pt; letter-spacing: .18em;
                  text-transform: uppercase; color: #ff8a3d; margin: 0 0 8mm; }
.cover h1 { font-size: 30pt; line-height: 1.1; margin: 0 0 6mm; letter-spacing: -.02em; }
.cover .sub { font-size: 12pt; color: #8a93a6; margin: 0; }
.cover .meta { position: absolute; bottom: 20mm; font-family: "JetBrains Mono", monospace;
               font-size: 8.5pt; color: #6b7488; }

h1 { font-size: 18pt; letter-spacing: -.015em; margin: 10mm 0 3mm; page-break-after: avoid; }
h2 { font-size: 13.5pt; letter-spacing: -.01em; margin: 8mm 0 3mm; padding-bottom: 2mm;
     border-bottom: .4pt solid #d8dee9; page-break-after: avoid; }
h3 { font-size: 11pt; margin: 6mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 3.5mm; }

/* A table split across a page break loses its header and becomes unreadable. */
table { border-collapse: collapse; width: 100%; margin: 4mm 0; font-size: 9pt;
        page-break-inside: avoid; }
th { background: #eef1f6; text-align: left; padding: 2mm 3mm; border-bottom: .5pt solid #c8d0dd;
     font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; color: #5a6478; }
td { padding: 2mm 3mm; border-bottom: .3pt solid #e4e9f0; font-variant-numeric: tabular-nums; }

blockquote { margin: 4mm 0; padding: 3mm 5mm; background: #f6f8fb; border-left: 2pt solid #d2650f;
             page-break-inside: avoid; }
blockquote p:last-child { margin-bottom: 0; }

code { font-family: "JetBrains Mono", monospace; font-size: 8.6pt; background: #eef1f6;
       padding: .4mm 1.2mm; border-radius: 1mm; }
pre { background: #f6f8fb; border: .4pt solid #dde3ec; border-radius: 2mm; padding: 3mm 4mm;
      font-size: 8pt; line-height: 1.45; overflow-wrap: anywhere; page-break-inside: avoid; }
pre code { background: none; padding: 0; }

ul, ol { margin: 0 0 3.5mm; padding-left: 6mm; }
li { margin: 1.2mm 0; }
strong { color: #0b0e14; }
hr { border: 0; border-top: .4pt solid #d8dee9; margin: 7mm 0; }
a { color: #17607f; text-decoration: none; }

/* Section dividers when several documents are concatenated into the annex. */
.docbreak { page-break-before: always; }
"""


def stylesheet() -> str:
    return CSS_TEMPLATE.replace("__FONTS__", FONT_DIR.as_uri())


def render(sources: list[Path], title: str, subtitle: str, out: Path) -> None:
    parts: list[str] = []
    for index, src in enumerate(sources):
        text = src.read_text(encoding="utf8")
        # Strip a leading H1: the cover already carries the title, and a second one reads as a
        # duplicate heading rather than the start of a section.
        text = re.sub(r"\A#\s+.*\n", "", text)
        body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
        cls = "docbreak" if index else ""
        parts.append(f'<section class="{cls}">{body}</section>')

    today = date.today().strftime("%d %B %Y")
    html = (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{title}</title></head><body>"
        '<div class="cover">'
        '<p class="eyebrow">Gujarat Police Innovation Challenge 2026 · Sentinel</p>'
        f"<h1>{title}</h1>"
        f'<p class="sub">{subtitle}</p>'
        f'<p class="meta">Team Anveshan · Student category · {today}<br>'
        "github.com/Het161/DrishtiNet</p>"
        "</div>" + "".join(parts) + "</body></html>"
    )

    HTML(string=html).write_pdf(out, stylesheets=[CSS(string=stylesheet())])


def main() -> int:
    parser = argparse.ArgumentParser(description="Render markdown to a styled PDF.")
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    missing = [s for s in args.sources if not s.exists()]
    if missing:
        print("missing source(s): " + ", ".join(str(m) for m in missing), file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    render(args.sources, args.title, args.subtitle, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
