#!/usr/bin/env bash
# Rebuilds the binary synthetic samples for the M0-07 OpenAI spike from their SVG sources.
# Needs rsvg-convert (brew install librsvg) and pdftotext (brew install poppler).
# The *.pdf.txt files are the PDFs' text layers, used by the verbatim check in the spike
# (M2-03 extracts the text layer in-product with unpdf).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/fixtures/samples/evidence"
for name in delivery-logo delivery-translation; do
  rsvg-convert -f pdf -o "$name.pdf" "src/$name.svg"
  pdftotext -layout "$name.pdf" "$name.pdf.txt"
done
for name in screenshot-logo screenshot-website; do
  rsvg-convert -f png -o "$name.png" "src/$name.svg"
done
ls -l *.pdf *.png *.pdf.txt
