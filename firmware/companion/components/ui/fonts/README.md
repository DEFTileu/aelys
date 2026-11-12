# Fonts

Inter, rendered by `lv_font_conv` into LVGL bitmap fonts with 8 bits per pixel
(A8 alpha, uncompressed). Only the `.c` files are committed; the TTFs are not.

- Source: Inter 4.0, <https://github.com/rsms/inter/releases/tag/v4.0>
  (asset `Inter-4.0.zip`, sha256
  `ff970a5d4561a04f102a7cb781adbd6ac4e9b6c460914c7a101f15acb7f7d1a4`),
  files `extras/ttf/Inter-Regular.ttf` and `extras/ttf/Inter-Bold.ttf`.
- License: SIL Open Font License 1.1, see `Inter-LICENSE.txt` (copied from the zip).
  Embedding the font in firmware is allowed; the license text must ship with it.
- Tool: `lv_font_conv@1.5.2` (npm, run through `npx`).

| Font | Face | Size | Glyphs | Used for |
|---|---|---|---|---|
| `inter_20` | Regular | 20 | ASCII 0x20-0x7E, `·` `…` `—` | body text, LVGL default font |
| `inter_28` | Regular | 28 | same | titles |
| `inter_40` | Regular | 40 | same | big numbers |
| `inter_clock_96` | Regular | 96 | `0`-`9`, `:`, space | clock digits |
| `inter_bold_fx_24/34/54` | Bold | 24/34/54 | `!` `?` `z` | face effects at scale 1.0 |
| `inter_bold_fx_36/51/81` | Bold | 36/51/81 | `!` `?` `z` | face effects at scale 1.5 |

The clock font is limited to digits and `:` because 96 px glyphs are large (about
200 KB of C source for 11 glyphs). The face effect sizes are the design's 54/34/24 px
(`CompanionFace.dc.html`) times 1.0 and 1.5; `face.c` picks the set by scale.

## Regenerate

Run in an empty scratch directory (not in the repo). `$REPO` is the repository root.

```sh
curl -L -o Inter-4.0.zip https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip
echo "ff970a5d4561a04f102a7cb781adbd6ac4e9b6c460914c7a101f15acb7f7d1a4  Inter-4.0.zip" | shasum -a 256 -c
unzip -j Inter-4.0.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Bold.ttf LICENSE.txt
ln -sfn "$REPO/firmware/companion/components/ui/fonts" out   # so -o stays a relative path

C="npx --yes lv_font_conv@1.5.2 --bpp 8 --no-compress --format lvgl --lv-include lvgl.h"
TXT='0x20-0x7E,0xB7,0x2026,0x2014'
$C --font Inter-Regular.ttf --size 20 -r "$TXT" -o out/inter_20.c
$C --font Inter-Regular.ttf --size 28 -r "$TXT" -o out/inter_28.c
$C --font Inter-Regular.ttf --size 40 -r "$TXT" -o out/inter_40.c
$C --font Inter-Regular.ttf --size 96 -r '0x30-0x3A,0x20' -o out/inter_clock_96.c
for s in 24 34 54 36 51 81; do
  $C --font Inter-Bold.ttf --size $s -r '0x21,0x3F,0x7A' -o out/inter_bold_fx_$s.c
done
```

The output is used as generated. With LVGL 9 it defines non-const `lv_font_t` structs
(lv_font_conv 1.5.2 only knows the LVGL 8 const layout), so the headers declare them as
`extern lv_font_t` (`ui_theme.h`, `ui_lv_font.h`), not with `LV_FONT_DECLARE`. The structs are
a few dozen bytes of RAM each; the glyph bitmaps stay in flash.
