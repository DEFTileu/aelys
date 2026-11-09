import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { TelegramMediaPreview } from '../components/TelegramMediaPreview'
import { ApiError } from '@aelys/shared'
const client=vi.hoisted(()=>({telegramMessageMedia:vi.fn()}))
vi.mock('../lib/api',()=>({getSharedApiClient:()=>client}))
let root:ReturnType<typeof createRoot>|undefined,host:HTMLDivElement
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:private-preview'),revokeObjectURL:vi.fn()}))})
afterEach(()=>{if(root)act(()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.unstubAllGlobals()})
async function mount(kind:'photo'|'voice'|'audio') {host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root!.render(<TelegramMediaPreview messageId="media" version={1} kind={kind}/>))}
it('loads a photo on explicit view and revokes its object URL when leaving',async()=>{
 client.telegramMessageMedia.mockResolvedValue(new Blob(['photo'],{type:'image/png'}));await mount('photo')
 expect(client.telegramMessageMedia).not.toHaveBeenCalled()
 await act(async()=>host.querySelector('button')!.click());expect(host.querySelector('img')?.src).toBe('blob:private-preview')
 expect(client.telegramMessageMedia).toHaveBeenCalledWith('media',expect.objectContaining({signal:expect.any(AbortSignal)}))
 act(()=>root!.unmount());root=undefined;expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-preview')
})
it.each(['voice','audio'] as const)('renders native controls for %s without autoplay',async kind=>{
 client.telegramMessageMedia.mockResolvedValue(new Blob(['audio'],{type:'audio/ogg'}));await mount(kind)
 await act(async()=>host.querySelector('button')!.click());const audio=host.querySelector('audio')!
 expect(audio.controls).toBe(true);expect(audio.autoplay).toBe(false);expect(audio.src).toBe('blob:private-preview')
})
it('shows an animated sticker as its emoji and a static sticker as an explicit image preview',async()=>{
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
 await act(async()=>root!.render(<TelegramMediaPreview messageId="sticker" version={1} kind="sticker" emoji="😂" animated/>))
 expect(host.querySelector('button')).toBeNull();expect(host.querySelector('[aria-label="Sticker"]')?.textContent).toBe('😂');expect(client.telegramMessageMedia).not.toHaveBeenCalled()
 act(()=>root!.unmount());root=undefined
 client.telegramMessageMedia.mockResolvedValue(new Blob(['webp'],{type:'image/webp'}));host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
 await act(async()=>root!.render(<TelegramMediaPreview messageId="sticker" version={1} kind="sticker" emoji="😂"/>))
 await act(async()=>host.querySelector('button')!.click());expect(host.querySelector('img')?.alt).toBe('Sticker')
})
it('shows a fixed failure and never leaks backend text or file IDs',async()=>{
 client.telegramMessageMedia.mockRejectedValue(new ApiError(413,'TELEGRAM_MEDIA_TOO_LARGE','private file token'))
 await mount('photo');await act(async()=>host.querySelector('button')!.click())
 expect(host.textContent).toContain('too large');expect(host.textContent).not.toContain('private file token');expect(host.querySelector('img')).toBeNull()
})
it('opens a loaded photo in a dialog, saves it with a typed filename, and closes on Escape',async()=>{
 client.telegramMessageMedia.mockResolvedValue(new Blob(['photo'],{type:'image/jpeg'}));await mount('photo')
 await act(async()=>host.querySelector('button')!.click())
 const saved:HTMLAnchorElement[]=[];const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){saved.push(this)})
 try {
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Open photo"]')!.click())
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.getAttribute('aria-modal')).toBe('true');expect(document.activeElement?.textContent).toBe('Close')
  await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Zoom in'||b.getAttribute('aria-label')==='Zoom in')!.click())
  expect(dialog.querySelector('button[aria-label="Zoom out"]')).not.toBeNull()
  await act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Save')!.click())
  expect(saved).toHaveLength(1);expect(saved[0].download).toBe('telegram-photo-media.jpg');expect(saved[0].href).toBe('blob:private-preview')
  act(()=>{dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})
  expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement?.getAttribute('aria-label')).toBe('Open photo')
 } finally {click.mockRestore()}
})
it('aborts an in-flight download when the message is unmounted',async()=>{
 client.telegramMessageMedia.mockReturnValue(new Promise(()=>{}));await mount('voice');await act(async()=>host.querySelector('button')!.click())
 const signal=client.telegramMessageMedia.mock.calls[0][1].signal
 act(()=>root!.unmount());root=undefined;expect(signal.aborted).toBe(true);expect(URL.createObjectURL).not.toHaveBeenCalled()
})
