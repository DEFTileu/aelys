import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileCustomizeView } from '../views/MobileCustomizeView'
import { HOME_LAYOUT_KEY, MOBILE_HOME_LAYOUT_KEY, WIDGET_SIZES } from '../views/desktop/homeLayout'
vi.mock('../views/desktop/SettingsScreen',()=>({SettingsScreen:()=> <p>Appearance controls</p>}))
let root:ReturnType<typeof createRoot>|undefined
let host:HTMLDivElement
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.innerHTML='';localStorage.clear();vi.restoreAllMocks()})
async function mount() { host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<MobileCustomizeView theme="light" onToggleTheme={()=>{}}/>)) }
async function click(label:string){const button=Array.from(host.querySelectorAll('button')).find(x=>x.getAttribute('aria-label')===label||x.textContent===label)!;expect(button).toBeTruthy();await act(async()=>button.click())}
it('persists mobile order, sizes and removal without changing desktop layout',async()=>{
 localStorage.setItem(HOME_LAYOUT_KEY,JSON.stringify([['cal',1,264]]));await mount()
 await click('Move Today down')
 let saved=JSON.parse(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)!)
 expect(saved[0][0]).toBe('focus')
 const today=Array.from(host.querySelectorAll('li')).find(x=>x.textContent?.includes('Today'))!
 await act(async()=>Array.from(today.querySelectorAll('button')).find(x=>x.textContent==='2 × 3')!.click())
 saved=JSON.parse(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)!);expect(saved.find((x:string[])=>x[0]==='today')).toEqual(['today',2,560])
 await click('Remove Today');await click('Add Today')
 expect(JSON.parse(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)!).at(-1)[0]).toBe('today')
 expect(JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY)!)).toEqual([['cal',1,264]])
 await act(async()=>root!.unmount());root=undefined;await mount()
 expect(host.querySelector('ol li:last-child')?.textContent).toContain('Today')
})
it('reports persistence failures and keeps the confirmed layout',async()=>{
 await mount();vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked')})
 await click('Remove Today');expect(host.querySelector('ol')!.textContent).toContain('Today');expect(host.textContent).toContain('Could not save')
})
it('offers the same six formats for every mobile widget and restores the selected format',async()=>{
 await mount()
 const formats=WIDGET_SIZES.filter(size=>size.span<=2)
 for(const group of host.querySelectorAll('[role="radiogroup"]')) {
  expect([...group.querySelectorAll('button')].map(button=>button.textContent)).toEqual(formats.map(size=>size.label))
 }
 const today=host.querySelector('[role="radiogroup"][aria-label="Size of Today"]')!
 for(const size of formats) {
  await act(async()=>[...today.querySelectorAll('button')].find(button=>button.textContent===size.label)!.click())
  expect(JSON.parse(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)!).find((entry:string[])=>entry[0]==='today')).toEqual(['today',size.span,size.height])
 }
 await act(async()=>root!.unmount());root=undefined;await mount()
 expect(host.querySelector('[aria-label="Size of Today"] [aria-checked="true"]')?.textContent).toBe('2 × 3')
})
