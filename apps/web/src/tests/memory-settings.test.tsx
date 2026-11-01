import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySettings } from '../views/MemorySettings'

const client = vi.hoisted(() => ({ ownerMemory: vi.fn(), rememberFact: vi.fn(), updateMemoryFact: vi.fn(), forgetMemoryFact: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const fact = {id:'fact',owner_id:'owner',version:3,text:'Prefer short answers',kind:'preference',source:'telegram',source_message_id:'message',expires_at:null,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',deleted_at:null}
let root: ReturnType<typeof createRoot>
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML=''; vi.resetAllMocks() })
async function mount() { const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<MemorySettings/>));return host }
async function set(field: HTMLInputElement|HTMLTextAreaElement, value:string) { await act(async()=>{Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))}) }

describe('explicit owner memory settings',()=>{
  it('edits with the current version and forgets without stale data',async()=>{
    client.ownerMemory.mockResolvedValue([fact]);client.updateMemoryFact.mockResolvedValue({...fact,version:4,text:'Short answers please'});client.forgetMemoryFact.mockResolvedValue({deleted:true})
    const host=await mount();expect(host.textContent).toContain('Prefer short answers')
    await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Edit')!.click())
    await set(host.querySelector('textarea')!,'Short answers please');client.ownerMemory.mockResolvedValue([{...fact,version:4,text:'Short answers please'}])
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(client.updateMemoryFact).toHaveBeenCalledWith('fact',expect.objectContaining({version:3,text:'Short answers please',kind:'preference'}))
    client.ownerMemory.mockResolvedValue([])
    await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Forget')!.click())
    expect(client.forgetMemoryFact).toHaveBeenCalledWith('fact',4);expect(host.textContent).not.toContain('Short answers please');expect(host.textContent).toContain('No saved facts yet')
  })
  it('creates only after an explicit submit and keeps failed edits visible',async()=>{
    client.ownerMemory.mockResolvedValue([]);client.rememberFact.mockRejectedValue(new Error('private server diagnostic'))
    const host=await mount();await set(host.querySelector('textarea')!,'Remember this fact')
    expect(client.rememberFact).not.toHaveBeenCalled()
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(client.rememberFact).toHaveBeenCalledWith(expect.objectContaining({text:'Remember this fact',kind:'fact'}))
    expect(host.querySelector('textarea')!.value).toBe('Remember this fact');expect(host.textContent).not.toContain('private server diagnostic');expect(host.textContent).toContain('Could not save')
  })
})
