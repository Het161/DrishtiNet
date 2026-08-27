#!/usr/bin/env bash
#
# Build every static submission artefact from the repository.
#
#   make deliverables
#
# The point of generating these rather than hand-making them is that the documents cannot drift from
# the build. Every figure in the deck and the HLD lives in docs/, so a measurement that changes is
# corrected in one place and every artefact follows.
#
# Runs entirely offline. Nothing under data/ is read or copied: the compliance rule is absolute, and
# no government footage leaves this machine except inside a screen recording.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=deliverables
THEME=$OUT/theme/drishti.css
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
STAMP=$(date "+%Y-%m-%d")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

mkdir -p "$OUT"
failures=0

bold "DrishtiNet deliverables  ·  $STAMP  ·  $SHA"
echo

# ── 01 Presentation ──────────────────────────────────────────────────────────
# Marp needs a front-matter block to pick up the theme and paginate. docs/deck.md stays clean
# markdown so it is readable on GitHub, and the front matter is prepended here instead.
bold "01 Presentation"
{
  cat <<EOF
---
marp: true
theme: drishti
paginate: true
size: 16:9
---

EOF
  # The first slide is the cover; everything after keeps the default layout.
  awk 'NR==1{print "<!-- _class: lead -->"} {print}' docs/deck.md
} > "$OUT/.presentation.md"

if npx --no-install marp "$OUT/.presentation.md" \
     --theme "$THEME" --pdf --allow-local-files \
     -o "$OUT/01-Presentation.pdf" >/dev/null 2>&1; then
  ok "01-Presentation.pdf  ($(du -h "$OUT/01-Presentation.pdf" | cut -f1))"
else
  bad "01-Presentation.pdf failed"; failures=$((failures+1))
fi
rm -f "$OUT/.presentation.md"

# ── 02 HLD, 07 Technical annex ───────────────────────────────────────────────
bold "02 High-Level Design"
if .venv/bin/python scripts/md_to_pdf.py \
     --title "DrishtiNet — High-Level Design" \
     --subtitle "Gujarat Police Innovation Challenge 2026 · Sentinel · Team Anveshan" \
     --out "$OUT/02-HLD.pdf" docs/hld.md; then
  ok "02-HLD.pdf  ($(du -h "$OUT/02-HLD.pdf" | cut -f1))"
else
  bad "02-HLD.pdf failed"; failures=$((failures+1))
fi

bold "07 Technical annex"
if .venv/bin/python scripts/md_to_pdf.py \
     --title "DrishtiNet — Technical Annex" \
     --subtitle "Evidence behind the submission · $SHA" \
     --out "$OUT/07-Technical-Annex.pdf" \
     docs/analytics_quality.md \
     docs/changelog/2026-08-21-portal-migration.md \
     docs/registry/2026-08-21-reconciliation.md \
     docs/support/2026-08-21-hls-401.md \
     docs/scale-and-operations.md; then
  ok "07-Technical-Annex.pdf  ($(du -h "$OUT/07-Technical-Annex.pdf" | cut -f1))"
else
  bad "07-Technical-Annex.pdf failed"; failures=$((failures+1))
fi

# ── 03 Workflow / integration diagram ────────────────────────────────────────
bold "03 Workflow / integration diagram"
if .venv/bin/python scripts/build_diagram.py --out "$OUT" --sha "$SHA" --date "$STAMP"; then
  ok "03-Workflow-Integration-Diagram.pdf + .png"
else
  bad "03 diagram failed"; failures=$((failures+1))
fi

# ── 04 Screenshots ───────────────────────────────────────────────────────────
bold "04 Screenshots"
if [ -d "$OUT/04-Screenshots" ] && [ -f "$OUT/04-Screenshots/.sha" ] \
   && [ "$(cat "$OUT/04-Screenshots/.sha")" = "$SHA" ]; then
  ok "up to date at $SHA ($(ls "$OUT"/04-Screenshots/*.png 2>/dev/null | wc -l | tr -d ' ') images)"
else
  echo "  stale or absent — run: make screenshots  (needs the stack running)"
fi

# ── Manifest ─────────────────────────────────────────────────────────────────
cat > "$OUT/link-manifest.md" <<EOF
# Submission manifest

Generated $STAMP from commit \`$SHA\`.

| Upload as | File |
|---|---|
| Solution Presentation | \`01-Presentation.pdf\` |
| High-Level Design | \`02-HLD.pdf\` |
| Workflow / Integration Diagram | \`03-Workflow-Integration-Diagram.pdf\` (or \`.png\`) |
| Screenshots | \`04-Screenshots/\` |
| Any other document | \`07-Technical-Annex.pdf\` |
| Demo video (government feed) | recorded separately — see \`video/\` |
| Demo video (own feed, optional) | recorded separately |

Source: https://github.com/Het161/DrishtiNet

## Drive structure

\`\`\`
DrishtiNet-Sentinel2026/
  01-Presentation.pdf
  02-HLD.pdf
  03-Workflow-Integration-Diagram.pdf
  04-Screenshots/
  07-Technical-Annex.pdf
  video/
\`\`\`

Nothing here contains government footage. The only footage that leaves this machine is what appears
inside the screen recordings.
EOF
ok "link-manifest.md"

echo
if (( failures == 0 )); then
  bold "All artefacts built into $OUT/"
else
  bold "$failures artefact(s) failed"
fi
exit $(( failures > 0 ))
