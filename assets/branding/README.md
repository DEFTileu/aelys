# Native Aelys icons

The existing authored mark at `apps/web/public/icons/aelys-mark.svg` is the
source. No new logo or third-party icon family is introduced. The macOS tile
uses a light violet rounded square; Android has a full-bleed background,
independent foreground and a monochrome layer for themed launchers.

Regenerate the SVG sources and packaged image sizes from the repository root:

```sh
node scripts/generate-app-icons.mjs
```

The script uses the installed, lockfile-pinned Tauri CLI, stages intermediate
outputs only in ignored `output/`, and copies the required macOS PNG/ICNS and
Android mipmaps into the tracked application icon directories. No platform SDK
or signing key is required to regenerate the artwork.

`apps/mobile/scripts/prepare-android.mjs` restores the tracked launcher resources
into the ignored generated Gradle project on every build. This keeps a new
`tauri android init` from silently reverting the installed icon to a template.
The build hook preserves all unrelated resources and the strict network policy.

References: [Tauri icon generation](https://v2.tauri.app/develop/icons/),
[Android adaptive icon layers](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).
