import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleCalendarSettings } from '../views/GoogleCalendarSettings'
const client=vi.hoisted(()=>({googleCalendarStatus:vi.fn(),syncGoogleCalendar:vi.fn(),disconnectGoogleCalendar:vi.fn(),connectGoogleCalendar:vi.fn()}))
vi.mock('../lib/api',()=>({getSharedApiClient:()=>client}))
let root:ReturnType<typeof createRoot>
afterEach(()=>{if(root)act(()=>root.unmount());document.body.innerHTML='';vi.resetAllMocks()})
async function mount(){const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<GoogleCalendarSettings/>));return host}
const connection={id:'calendar',version:1,calendar_id:'primary',status:'connected',last_synced_at:null,last_error_code:null}
describe('Google Calendar read-only connection',()=>{
 it('honestly disables connection when server OAuth is unavailable',async()=>{
  client.googleCalendarStatus.mockResolvedValue({configured:false,connection:null});const host=await mount()
  expect(host.textContent).toContain('not configured');expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Connect Google Calendar')!.disabled).toBe(true)
  expect(client.connectGoogleCalendar).not.toHaveBeenCalled();expect(host.textContent).toContain('read-only')
 })
 it('imports manually and disconnects imported events',async()=>{
  client.googleCalendarStatus.mockResolvedValue({configured:true,connection});client.syncGoogleCalendar.mockResolvedValue({imported:2,deleted:1,full_sync:false});client.disconnectGoogleCalendar.mockResolvedValue({disconnected:true})
  const host=await mount();await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Import now')!.click());expect(client.syncGoogleCalendar).toHaveBeenCalledOnce();expect(host.textContent).toContain('2 imported')
  client.googleCalendarStatus.mockResolvedValue({configured:true,connection:null});await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Disconnect')!.click());expect(client.disconnectGoogleCalendar).toHaveBeenCalledOnce();expect(host.textContent).toContain('Disconnected')
 })
})

// Imported event details never expose an editor or a deletion action.
