# Aelys icon family

Source of truth: `apps/web/src/icons/glyphs.ts`.
React surface: `apps/web/src/icons/index.tsx`.
Legacy names: `apps/web/src/components/Icon.tsx`.
App mark: `apps/web/public/icons/aelys-mark.svg`.

The family uses a 24×24 viewBox, 1.75-unit rounded strokes, currentColor, and a
subtle optional monochrome wash. Core modules have individually drawn contours.
Familiar action metaphors intentionally remain recognizable. This is original
code-native artwork; no claim of legal/global uniqueness is made.

```tsx
import { Calendar } from './icons'
// Decorative next to visible text:
<Calendar size={20} />
// Meaningful standalone image (button still needs its own accessible name):
<Calendar size={24} aria-label="Calendar" />
```

Icons forward SVG attributes and refs, allow strokeWidth/size and inherit color.
Decorative icons default to aria-hidden and are not focus targets. A title or
aria-label/aria-labelledby exposes role=img. Keep critical actions labelled by
text or a named button; an SVG is not an interactive control by itself.

Rebuild distribution assets with Node >=22.18:

```sh
node apps/web/scripts/export-icons.mjs
```

The generator writes 76 individual SVGs, `sprite.svg` and `gallery.html` into
`apps/web/public/icons/aelys`. Never edit generated assets independently. Open
`http://127.0.0.1:5173/icons/aelys/gallery.html` for 16/20/24/32 px and light/dark
review. No font, icon CDN or network fetch is required for rendering the family.

When adding a glyph, update the typed map and named export, run the exporter,
inspect the small-size silhouette/contrast/clipping, and run web typecheck/tests/build.
Changing only a vector path does not require backend or schema changes.

Scope/verification of the initial integration: `docs/UX_GOALS.md`.
