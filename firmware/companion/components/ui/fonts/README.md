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
| `inter_16` | Regular | 16 | text set (below) | secondary lines on the lost-mode and ICE screens |
| `inter_20` | Regular | 20 | text set | body text, LVGL default font |
| `inter_24` | Regular | 24 | text set | screen titles |
| `inter_28` | Regular | 28 | text set | titles |
| `inter_40` | Regular | 40 | ASCII 0x20-0x7E, `·` `…` `—` | big numbers |
| `inter_clock_96` | Regular | 96 | `0`-`9`, `:`, space | clock digits |
| `inter_bold_fx_24/34/54` | Bold | 24/34/54 | `!` `?` `z` | face effects at scale 1.0 |
| `inter_bold_fx_36/51/81` | Bold | 36/51/81 | `!` `?` `z` | face effects at scale 1.5 |

Text set (16/20/24/28): ASCII 0x20-0x7E, `·` `…` `—`, curly quotes `‘ ’ “ ”`, Cyrillic
U+0400-045F (Russian and the other Slavic letters) and the Kazakh letters
Ғ ғ Қ қ Ң ң Ү ү Ұ ұ Һ һ Ә ә Ө ө (U+0492/3, 049A/B, 04A2/3, 04AE-04B1, 04BA/B, 04D8/9, 04E8/9).
`inter_40` stays ASCII: it only shows numbers.

The clock font is limited to digits and `:` because 96 px glyphs are large (about
200 KB of C source for 11 glyphs). The face effect sizes are the design's 54/34/24 px
(`CompanionFace.dc.html`) times 1.0 and 1.5; `face.c` picks the set by scale.

## Regenerate

(Under zsh `$C` is not word-split: run the block in bash, or make `C` an array.)

Run in an empty scratch directory (not in the repo). `$REPO` is the repository root.

```sh
curl -L -o Inter-4.0.zip https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip
echo "ff970a5d4561a04f102a7cb781adbd6ac4e9b6c460914c7a101f15acb7f7d1a4  Inter-4.0.zip" | shasum -a 256 -c
unzip -j Inter-4.0.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Bold.ttf LICENSE.txt
ln -sfn "$REPO/firmware/companion/components/ui/fonts" out   # so -o stays a relative path

C="npx --yes lv_font_conv@1.5.2 --bpp 8 --no-compress --format lvgl --lv-include lvgl.h"
ASCII='0x20-0x7E,0xB7,0x2026,0x2014'
TXT="$ASCII,0x2018,0x2019,0x201C,0x201D,0x400-0x45F,0x492,0x493,0x49A,0x49B,0x4A2,0x4A3,0x4AE-0x4B1,0x4BA,0x4BB,0x4D8,0x4D9,0x4E8,0x4E9"
for s in 16 20 24 28; do $C --font Inter-Regular.ttf --size $s -r "$TXT" -o out/inter_$s.c; done
$C --font Inter-Regular.ttf --size 40 -r "$ASCII" -o out/inter_40.c
$C --font Inter-Regular.ttf --size 96 -r '0x30-0x3A,0x20' -o out/inter_clock_96.c
for s in 24 34 54 36 51 81; do
  $C --font Inter-Bold.ttf --size $s -r '0x21,0x3F,0x7A' -o out/inter_bold_fx_$s.c
done
```

The output is used as generated. With LVGL 9 it defines non-const `lv_font_t` structs
(lv_font_conv 1.5.2 only knows the LVGL 8 const layout), so the headers declare them as
`extern lv_font_t` (`ui_theme.h`, `ui_lv_font.h`), not with `LV_FONT_DECLARE`. The structs are
a few dozen bytes of RAM each; the glyph bitmaps stay in flash.
