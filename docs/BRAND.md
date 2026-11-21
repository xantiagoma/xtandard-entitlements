# Brand

The xtandard-entitlements mark is the family's lime **X** — a `>` chevron and two arms between grey
angle brackets — whose upper-right arm continues as the needle of a **usage gauge**: a dial whose
lime arc is the used share of a limit and whose grey tail is what remains. Plans and limits on one
side, metering on the other. It comes as an app icon, a bare mark and wordmark lockups. Everything
lives in [`docs/assets/`](assets/); the SVGs are the masters and every PNG and ICO is built from them.

It belongs with its siblings: the near-black rounded tile, the orbit lines, the grey brackets and the
lime X are shared with `@xtandard/flags` (a flag on the arm) and `@xtandard/webhooks` (a hook on the
arm); the layout of the lockups and the social card follows `xtandard-image`'s kit. The gauge is
what makes it this project.

## Files

**Everything users see on a page uses the SVGs**: the README header, the docs site (navbar, hero,
favicon), the admin UI, the customer portal and the React embeds. Rasters exist only where a format
cannot take SVG, and nobody sees them as an icon on a page.

| File                                                   | What it is                                                               | Use it for                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `logo.svg`                                             | App icon: the mark on a near-black rounded square with faint orbit lines | The docs-site hero; anywhere a square app icon is wanted                                                                 |
| `symbol.svg`                                           | The mark with brackets, transparent                                      | Inline UI (the admin and portal header — inlined in the bundle), places that draw their own surface                      |
| `lockup-horizontal-dark.svg`                           | Mark + wordmark, `xtandard-` in near-white                               | Headers on dark backgrounds (README in GitHub dark mode, the docs site in dark mode)                                     |
| `lockup-horizontal-light.svg`                          | Mark + wordmark, `xtandard-` in ink, deeper lime                         | Headers on light backgrounds (README in light mode and on npm, the docs site in light mode)                              |
| `lockup-stacked-{dark,light}.svg`                      | Mark left, `xtandard-` over `entitlements`                               | Square-ish slots: slides, sidebars                                                                                       |
| `monochrome-white.svg`, `monochrome-black.svg`         | One-colour horizontal lockup                                             | Photos and busy backgrounds (white); print (black)                                                                       |
| `favicon.svg`                                          | The icon without orbit lines and shadow, which do not survive 16 px      | Browser tabs (the admin UI / portal and the docs site)                                                                   |
| `social.svg` → `social.png` (1280×640)                 | Social card: icon, wordmark, tagline, `bun add` line                     | `og:image` of the docs site and the GitHub social preview (Settings → Social preview, uploaded by hand) — must be raster |
| `apple-touch-icon.png` (180), `favicon.ico` (16/32/48) | Raster copies of `favicon.svg`                                           | `<head>` fallbacks only (iOS home screen, legacy browsers)                                                               |

There are deliberately no PNG logos or lockups: use the SVGs (by absolute
`raw.githubusercontent.com` URL outside the repository — it serves them as `image/svg+xml`).

Rebuild after editing:

```sh
URBANIST=/path/to/Urbanist[wght].ttf bun scripts/brand-svg.ts   # SVG masters (needs hb-view)
sh scripts/brand-assets.sh                                      # social.png, apple-touch-icon.png, favicon.ico
```

`scripts/brand-svg.ts` holds the geometry (one 1024-unit grid) and shapes the wordmark with HarfBuzz;
`scripts/brand-assets.sh` builds the three required rasters. The UI and the docs site copy
`favicon.svg` (plus the two `<head>` fallbacks) from here; the UI inlines `symbol.svg`.

### Where each file goes

- **README header**: a `<picture>` choosing `lockup-horizontal-dark.svg` / `lockup-horizontal-light.svg`
  with `prefers-color-scheme`, by absolute `raw.githubusercontent.com` URL (the README ships to npm,
  which does not ship `docs/`).
- **Docs site**: the horizontal lockups as the Starlight logo (light/dark), `logo.svg` in the hero,
  `favicon.svg` first then `favicon.ico` + `apple-touch-icon.png` in `<head>`, and `social.png` as
  `og:image`.
- **Admin UI, portal and embeds**: `symbol.svg` inlined in the header next to the title (or the
  host's `logoUrl`), `favicon.svg` (+ the two fallbacks) in `index.html`.

## Palette

Lime on charcoal, as in the family. Lime is an artwork colour on dark surfaces; on white use the
deeper lime for text.

| Token          | Hex                                 | Role                                                      | Contrast on white / on ink |
| -------------- | ----------------------------------- | --------------------------------------------------------- | -------------------------- |
| `xe-lime-hi`   | `#D9F99D`                           | Top-left of the mark gradient, the social-card tagline    | 1.18 / 15.9                |
| `xe-lime`      | `#A3E635`                           | The mark, accents and links on dark surfaces              | 1.55 / 12.1                |
| `xe-lime-deep` | `#65A30D`                           | Bottom-right of the mark gradient                         | 2.9 / 6.5                  |
| `xe-lime-text` | `#4D7C0F`                           | Accent text and the wordmark's end on light surfaces (AA) | 5.0 / 3.8                  |
| `xe-ink`       | `#0F1215`                           | Icon surface, dark page background, `xtandard-` on light  | 18.8 / —                   |
| `xe-orbit`     | `#4E5459`                           | Orbit lines and dots                                      | 7.7 / 2.5                  |
| `xe-bracket`   | `#5B6167`                           | The angle brackets                                        | 6.3 / 3.0                  |
| `xe-track`     | `#3A4046` (dark), `#C4C9CE` (light) | The gauge's remaining (grey) arc                          | —                          |
| `xe-slate`     | `#8B939C`                           | Secondary text on ink (the social-card command)           | 3.1 / 6.0                  |
| `xe-paper`     | `#FAFAFA`                           | `xtandard-` on dark                                       | 1.04 / 18.0                |

### Gradients

Lit from the top left, as in every xtandard mark.

| Shape                            | Stops                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Mark (X + gauge), dark surfaces  | `#D9F99D` → `#A3E635` 42% → `#65A30D`, top left to bottom right                   |
| Mark, light surfaces             | `#A3E635` → `#84CC16` 42% → `#4D7C0F`                                             |
| `entitlements` (wordmark), dark  | `#D9F99D` → `#A3E635`, top to bottom                                              |
| `entitlements` (wordmark), light | `#84CC16` → `#4D7C0F`                                                             |
| Icon surface                     | `#1A1C1F` → `#08090B`, top to bottom, with a 4-unit white rim at 14% → 3% opacity |

## Wordmark

`xtandard-entitlements` in **Urbanist** Black (900), shaped by HarfBuzz and converted to paths (the
SVGs need no font) — the same face as `xtandard-image`. `xtandard-` is paper on dark and ink on light;
`entitlements` is always the lime gradient. The social card adds Urbanist SemiBold (600) for the
tagline and JetBrains Mono for the command. Both fonts are SIL OFL 1.1; the SVGs contain glyph
outlines, not font software.

## Geometry

One 1024-unit grid. The chevron is `M250 300 L395 300 L560 512 L395 724 L250 724 L415 512 Z`; the
arms run along the same diagonals (slope 165/212) with a 46-unit gap; the upper arm stops at the
gauge's pivot and the needle continues along its diagonal (≈52°). The dial is a 150-unit-radius
upper arc: lime from 172° to the needle, grey from the needle to 8°. In the app icon the mark is
scaled by 0.86 and centred; the tile's corner radius is 224 (21.9%).

**Clear space**: the dial's radius on every side of the mark or a lockup. **Minimum sizes**: app
icon 16 px (use the favicon set below 48 px), horizontal lockup 24 px high, stacked lockup 48 px high.

## Do and don't

Do:

- Use the dark lockup on dark backgrounds and the light one on light; on GitHub switch with
  `<picture>` and `prefers-color-scheme`.
- Use `logo.svg` wherever a square icon is expected; the monochrome lockups on photos or in print.
- Use the SVGs on pages; add a raster only where a format requires it (og:image, `<head>` fallbacks).

Don't:

- Recolour the mark (it is lime like flags and webhooks; blue belongs to xtandard-image).
- Detach the gauge from the arm, move it to another arm, or fill the whole dial (the grey tail is the
  point: usage against a limit).
- Put the dark lockup on a light background or vice versa; stretch, rotate or add effects.
- Set the wordmark in another font or as live text.
