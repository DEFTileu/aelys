/** Rebuild local icon assets. Run with Node >=22.18 (native TypeScript loading). */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { glyphs, washes } from '../src/icons/glyphs.ts'
const directory = fileURLToPath(new URL('../public/icons/aelys/', import.meta.url))
await mkdir(directory, { recursive: true })
const filename = (name) => name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
const paths = (name) => `${washes[name] ? `<path d="${washes[name]}" fill="currentColor" fill-opacity=".12" stroke="none"/>` : ''}<path d="${glyphs[name]}"/>`
const svg = (name, size = 24) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths(name)}</svg>`
const names = Object.keys(glyphs)
for (const name of names) await writeFile(`${directory}/${filename(name)}.svg`, svg(name) + '\n')
const symbols = names.map((name) => `<symbol id="${filename(name)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths(name)}</symbol>`).join('\n')
await writeFile(`${directory}/sprite.svg`, `<svg xmlns="http://www.w3.org/2000/svg"><defs>${symbols}</defs></svg>\n`)
const cards = names.map((name) => `<article><div class="samples">${[16,20,24,32].map((size) => svg(name,size)).join('')}</div><div class="dark">${svg(name)}</div><p>${name}</p></article>`).join('\n')
await writeFile(`${directory}/gallery.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aelys icon family</title><style>body{margin:0;padding:40px;background:#F5F0EB;color:#272335;font:14px system-ui}header{display:flex;align-items:center;gap:18px;margin-bottom:28px}h1{margin:0;font-size:28px}header p{color:#635D72}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}article{padding:16px;background:#fff;border-radius:14px}.samples{height:44px;display:flex;align-items:center;justify-content:space-between;color:#6143D9}.dark{margin-top:12px;background:#272335;color:#E5DDFF;padding:12px;border-radius:8px}article p{margin:12px 0 0;font-size:12px}svg{flex-shrink:0}</style><header><img src="../aelys-mark.svg" alt="Aelys" width="64" height="64"><div><h1>Aelys icon family</h1><p>${names.length} original vectors · 16 / 20 / 24 / 32 px · light and dark</p></div></header><main>${cards}</main></html>\n`)
console.log(`Exported ${names.length} SVG icons, sprite and size gallery.`)
