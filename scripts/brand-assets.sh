#!/bin/sh
# Rebuild the few brand rasters a format requires, from the SVG masters (see docs/BRAND.md).
# Everything users see on a page (README, docs site, admin UI, portal, embeds) uses the SVGs
# directly; rasters exist only where SVG is not accepted:
#   social.png            og:image / GitHub social preview (must be raster)
#   apple-touch-icon.png  iOS home-screen icon (<head> fallback)
#   favicon.ico           legacy browsers (<head> fallback after favicon.svg)
# Needs rsvg-convert (librsvg) and magick (ImageMagick 7); oxipng is used when installed.
# The SVG masters themselves come from scripts/brand-svg.ts (needs hb-view + Urbanist).
set -eu
cd "$(dirname "$0")/../docs/assets"

rsvg-convert -w 1280 -h 640 social.svg -o social.png
rsvg-convert -w 180 -h 180 favicon.svg -o apple-touch-icon.png
tmp=$(mktemp -d)
for s in 16 32 48; do rsvg-convert -w $s -h $s favicon.svg -o "$tmp/f$s.png"; done
magick "$tmp/f16.png" "$tmp/f32.png" "$tmp/f48.png" favicon.ico
rm -rf "$tmp"

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o max social.png apple-touch-icon.png; fi
echo "brand rasters rebuilt (social.png, apple-touch-icon.png, favicon.ico)"
