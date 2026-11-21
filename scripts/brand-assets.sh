#!/bin/sh
# Rebuild every brand raster in docs/assets/ from the SVG masters (see docs/BRAND.md).
# Needs rsvg-convert (librsvg) and magick (ImageMagick 7); oxipng is used when installed.
# The SVG masters themselves come from scripts/brand-svg.ts (needs hb-view + Urbanist).
set -eu
cd "$(dirname "$0")/../docs/assets"

rsvg-convert -w 1024 -h 1024 logo.svg -o logo.png
rsvg-convert -w 256 -h 256 logo.svg -o logo-256.png
rsvg-convert -w 128 -h 128 logo.svg -o logo-128.png
rsvg-convert -h 256 symbol.svg -o symbol.png
for f in lockup-horizontal-dark lockup-horizontal-light lockup-stacked-dark lockup-stacked-light; do
  rsvg-convert -z 2 "$f.svg" -o "$f.png"
done
rsvg-convert -w 180 -h 180 favicon.svg -o apple-touch-icon.png
rsvg-convert -w 32 -h 32 favicon.svg -o favicon-32.png
tmp=$(mktemp -d)
for s in 16 32 48; do rsvg-convert -w $s -h $s favicon.svg -o "$tmp/f$s.png"; done
magick "$tmp/f16.png" "$tmp/f32.png" "$tmp/f48.png" favicon.ico
rm -rf "$tmp"
rsvg-convert -w 1280 -h 640 social.svg -o social.png

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o max ./*.png; fi
echo "brand rasters rebuilt"
