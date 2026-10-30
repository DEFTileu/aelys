import { act,useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach,expect,it } from 'vitest'
import { StyledSelect } from '../components/controls/StyledSelect'
let root:ReturnType<typeof createRoot>|undefined
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML=''})
it('selects through the portalled menu and preserves native form values',async()=>{
 function Example(){const[value,setValue]=useState('a');return <form><StyledSelect name="choice" aria-label="Choice" value={value} onChange={e=>setValue(e.target.value)}><option value="a">Alpha</option><option value="b">Beta</option></StyledSelect><output>{value}</output></form>}
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<Example/>))
 await act(async()=>host.querySelector<HTMLButtonElement>('[role=combobox]')!.click())
 const list=document.querySelector('[role=listbox]')!;expect(list.parentElement).toBe(document.body)
 await act(async()=>Array.from(list.querySelectorAll<HTMLElement>('[role=option]')).find(x=>x.textContent==='Beta')!.click())
 expect(host.querySelector('output')!.textContent).toBe('b');expect(new FormData(host.querySelector('form')!).get('choice')).toBe('b')
 expect(document.querySelector('[role=listbox]')).toBeNull()
})
