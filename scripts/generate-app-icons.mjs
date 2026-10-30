import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = await readFile(join(root, 'apps/web/public/icons/aelys-mark.svg'), 'utf8')
const body = source.replace(/<metadata>[\s\S]*?<\/metadata>/g, '').replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const head = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
const tile = '<rect x="96" y="96" width="832" height="832" rx="184" fill="#F4EFFF"/>'
const background = '<rect width="1024" height="1024" fill="#F4EFFF"/>'
const mark = `<g transform="translate(192 249.6) scale(6.4)">${body}</g>`
const foreground = `<g transform="translate(128 197.12) scale(7.68)">${body}</g>`
const branding = join(root, 'assets/branding')
await mkdir(branding, { recursive: true })
for (const [name, content] of Object.entries({
  'app-icon.svg': tile + mark,
  'android-icon.svg': background + mark,
  'android-background.svg': background,
  'android-foreground.svg': foreground,
  'android-monochrome.svg': foreground.replace(/<path\b(?=[^>]*fill="#DCCDFD")[^>]*\/>/g, '').replace(/fill="[^"]*"/g, 'fill="#FFFFFF"'),
})) await writeFile(join(branding, name), `${head}${content}</svg>\n`)
const manifest = { default: 'app-icon.svg', bg_color: '#F4EFFF', android_bg: 'android-background.svg', android_fg: 'android-foreground.svg', android_fg_scale: 80, android_monochrome: 'android-monochrome.svg' }
await writeFile(join(branding, 'icons.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(branding, 'android-icons.json'), JSON.stringify({ ...manifest, default: 'android-icon.svg' }, null, 2) + '\n')
const generated = join(root, 'output/native-icons')
execFileSync('pnpm', ['--filter', '@aelys/desktop', 'exec', 'tauri', 'icon', join(branding, 'icons.json'), '--output', generated], { cwd: root, stdio: 'inherit' })
const desktop = join(root, 'apps/desktop/src-tauri/icons')
for (const name of ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns']) await copyFile(join(generated, name), join(desktop, name))
const androidGenerated = join(root, 'output/native-icons-android')
execFileSync('pnpm', ['--filter', '@aelys/mobile', 'exec', 'tauri', 'icon', join(branding, 'android-icons.json'), '--output', androidGenerated], { cwd: root, stdio: 'inherit' })
const mobile = join(root, 'apps/mobile/src-tauri/icons')
await copyFile(join(androidGenerated, 'icon.png'), join(mobile, 'icon.png'))
await cp(join(androidGenerated, 'android'), join(mobile, 'android'), { recursive: true })
for (const version of [26, 33]) {
  const directory = join(mobile, 'android', `mipmap-anydpi-v${version}`)
  await mkdir(directory, { recursive: true })
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@mipmap/ic_launcher_background" />\n  <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n${version >= 33 ? '  <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />\n' : ''}</adaptive-icon>\n`
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) await writeFile(join(directory, name), xml)
}
console.log('Native icons generated from the shared Aelys mark.')
